// S3-3.11(금액 불일치·늦은 입금·중복 결제) — 계약 03-checkout-payment.md §6 5행·7행 · data-model §4-1 「expired + 늦은 입금」 행 · §4.1 payment_exceptions
//   요구: FR-290(다른 금액 입금) · FR-291(중복 결제 환불) · FR-292(만료 뒤 늦은 입금) · FR-298(주문 상태 6종 — 끝 상태는 되돌리지 않는다)
//   verify: amount_mismatch 행 · expired 주문 불변 · 중복 결제 1건만 확정
//
// 예외 종류마다 장면 하나씩(① 다른 금액 ② 만료 뒤 입금 ③ 취소된 주문 입금 ④ 중복 결제). 주문은 진짜 주문 생성 경로(S3-3.4)로 만들고,
// 가짜 PG 로 입금을 흉내 낸 뒤 서명한 웹훅을 라우트 처리기에 직접 보낸다 — payment-webhook.db.test.ts(S3-3.9)와 같은 준비 코드다.
// 이름: verify 의 tests/db/s3-3-11.db.test.ts 는 Task 번호 이름이라 기능 이름(payment-exceptions)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import type { PaymentGatewayPort } from "@/lib/server/ports/payment-gateway";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { expireDuePayments } from "@/lib/server/services/order-expiry";
import { cancelUnpaidOrder } from "@/lib/server/services/order-cancel";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01(화)부터 — 지금은 그보다 열흘 앞
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("금액 불일치·늦은 입금·중복 결제(계약 03 §6 5·7행, S3-3.11)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberTokens: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let noticeId = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: new FakePaymentGateway({ clock: fixedClock(now) }),
    deadlineConfig: DEFAULT_DEADLINE_CONFIG,
  });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeStaff(key: string, role: "owner" | "instructor") {
    const { token, userId } = await loggedInUser(key);
    tokens[key] = token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, `직원 ${key}`]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (role === "instructor") {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', now(), now())", [id]);
    }
    staffIds[key] = id;
  }

  async function makeAcademy() {
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, academyId],
    );
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    noticeId = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [noticeId, academyId, JSON.stringify(regularContent), staffIds["owner"]],
    );
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyId, staffIds["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24 = 8회차, 120,000원) */
  async function makeClass(key: string, o: { start: string; end: string; capacity: Capacity }) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          classKind: "regular",
          title: `수업 ${key}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: o.start, endTime: o.end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: o.capacity,
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: staffIds["junho"],
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers, body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const row = await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    offerings[key] = row.id;
  }

  async function member(key: string, o: { gender?: "male" | "female"; birthDate?: string } = {}) {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, $4, '01012345678', $5, '서연', now(), 'dance_sport', now())`,
      [id, userId, o.gender ?? "male", o.birthDate ?? "1995-03-02", `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
    memberIds[key] = id;
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(who: string, body: Record<string, unknown>, o: { key?: string | null; now?: Temporal.Instant } = {}): Promise<Call> {
    const headers: Record<string, string> = { authorization: `Bearer ${memberTokens[who]}`, "content-type": "application/json" };
    const key = o.key === undefined ? randomUUID() : o.key;
    if (key !== null) headers["Idempotency-Key"] = key;
    const res = await createOrderRoute(deps(o.now))(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  const bodyFor = (offeringKey: string, extra: Record<string, unknown> = {}) => ({
    offeringId: offerings[offeringKey],
    seatKind: "male",
    method: "card",
    noticesAcknowledged: true,
    ...extra,
  });

  const heldOf = async (offeringKey: string, seatKind = "male") =>
    (await one<{ held: number }>("SELECT held_count AS held FROM seat_pools WHERE offering_id = $1 AND seat_kind = $2", [offerings[offeringKey], seatKind])).held;
  beforeAll(async () => {
    handle = openTestDb({ poolMax: 12 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(platform-fee-rate-reader 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다
    // 남자 자리 1개짜리 수업을 장면마다 하나씩 — 한 장면의 자리 상태가 다른 장면에 새지 않게
    const slots: [string, string, string][] = [
      ["mismatch", "08:00", "08:50"], ["late", "09:00", "09:50"], ["cancelled", "10:00", "10:50"], ["dupSeq", "11:00", "11:50"],
      ["dupRace", "12:00", "12:50"], ["mismatchLate", "13:00", "13:50"],
    ];
    for (const [key, start, end] of slots) {
      await makeClass(key, { start, end, capacity: { mode: "gender_split", male: 1, female: 1 } });
    }
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------
  /** 기본 원장(globalThis)을 쓰는 가짜 PG — 주문 생성 경로가 발급한 결제를 같은 원장에서 본다 */
  const pg = () => new FakePaymentGateway({ clock: fixedClock(NOW) });
  const WEBHOOK_AT = NOW.add({ minutes: 3 });
  const webhookRoute = (o: { gateway?: PaymentGatewayPort; at?: Temporal.Instant } = {}) =>
    createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(o.at ?? WEBHOOK_AT),
      paymentGateway: o.gateway ?? pg(),
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });

  type Hook = { status: number; body: Record<string, unknown> };
  /** 서명한 웹훅 한 건을 라우트에 보낸다. secret·sentAt 을 바꾸면 틀린 서명·오래된 요청을 만든다 */
  async function sendWebhook(
    rawBody: string,
    o: { webhookId?: string; secret?: string; sentAt?: Temporal.Instant; gateway?: PaymentGatewayPort; at?: Temporal.Instant } = {},
  ): Promise<Hook> {
    const headers = signWebhook({
      secret: o.secret ?? WEBHOOK_SECRET,
      webhookId: o.webhookId ?? `wh_${randomUUID()}`,
      timestampSeconds: Math.floor((o.sentAt ?? o.at ?? WEBHOOK_AT).epochMilliseconds / 1000),
      rawBody,
    });
    const res = await webhookRoute(o)(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: rawBody }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const paidBody = (gatewayPaymentId: string) => JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId));
  const failedBody = (gatewayPaymentId: string) =>
    JSON.stringify({ type: "Transaction.Failed", timestamp: NOW.toString(), data: { paymentId: gatewayPaymentId } });

  async function startCardOrder(who: string, offeringKey: string, method = "card"): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey, { method }));
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }

  type Snapshot = {
    order: string; payment: string; reported: number | null; reservation: string; held: number; confirmed: number;
    calendar: number; member_noti: number; owner_noti: number; pending_noti: number; settlement: number; settlement_amount: number | null;
    confirm_events: number;
  };
  /** 확정 한 번에 바뀌어야 하는 것 전부를 한 줄로 읽는다 */
  const snapshot = (orderId: string) =>
    one<Snapshot>(
      `SELECT o.status AS order,
              (SELECT string_agg(p.status, ',') FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT max(p.pg_reported_amount) FROM payments p WHERE p.order_id = o.id) AS reported,
              (SELECT string_agg(r.status::text, ',') FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT sp.held_count FROM seat_pools sp JOIN reservations r ON r.seat_pool_id = sp.id WHERE r.order_id = o.id) AS held,
              (SELECT sp.confirmed_count FROM seat_pools sp JOIN reservations r ON r.seat_pool_id = sp.id WHERE r.order_id = o.id) AS confirmed,
              (SELECT count(*)::int FROM calendar_entries c JOIN reservations r ON r.id = c.reservation_id WHERE r.order_id = o.id) AS calendar,
              (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id AND n.kind = 'payment_confirmed_member' AND n.recipient_member_id = o.member_id) AS member_noti,
              (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id AND n.kind = 'payment_confirmed_owner') AS owner_noti,
              (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id AND n.delivery_status = 'pending') AS pending_noti,
              (SELECT count(*)::int FROM settlement_entries s WHERE s.order_id = o.id AND s.kind = 'payment_hold' AND s.status = 'hold') AS settlement,
              (SELECT max(s.amount) FROM settlement_entries s WHERE s.order_id = o.id) AS settlement_amount,
              (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id AND e.reason = '입금 확인') AS confirm_events
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
  const webhookResults = async (gatewayPaymentId: string) =>
    (await q("SELECT result FROM payment_webhook_events WHERE gateway_payment_id = $1 ORDER BY received_at, result", [gatewayPaymentId])).rows.map(
      (r) => (r as { result: string }).result,
    );
  const sessionCount = async (offeringKey: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM class_sessions WHERE offering_id = $1 AND status = 'scheduled'", [offerings[offeringKey]])).n;

  /** 확정 뒤 모습 — 한 번만 반영됐을 때의 값 */
  async function expectConfirmedOnce(orderId: string, offeringKey: string) {
    const s = await snapshot(orderId);
    expect(s).toMatchObject({
      order: "paid", payment: "paid", reported: 120000, reservation: "confirmed", held: 0, confirmed: 1,
      member_noti: 1, owner_noti: 1, pending_noti: 2, settlement: 1, settlement_amount: 120000, confirm_events: 1,
    });
    expect(s.calendar).toBe(await sessionCount(offeringKey));
    expect(s.calendar).toBe(8);
  }

  // ---- 이 파일 전용 — 돌려줄 대상 기록과 환불 알림 ---------------------------------------------
  type ExceptionRow = { kind: string; status: string; received_amount: number; pg_transaction_id: string | null };
  /** 그 주문의 payment_exceptions 전부(돌려줄 돈의 유일한 기록) */
  const exceptionsOf = async (orderId: string) =>
    (await q("SELECT kind, status, received_amount, pg_transaction_id FROM payment_exceptions WHERE order_id = $1 ORDER BY created_at", [orderId]))
      .rows as ExceptionRow[];
  /** 환불 대상 알림 — 회원 몫·대표 몫(대표는 직원 계정 알림함) */
  const refundDueNotices = async (orderId: string) =>
    (
      await q(
        `SELECT recipient_member_id::text AS member, recipient_staff_account_id::text AS staff, category, delivery_status, payload
           FROM notifications WHERE order_id = $1 AND kind = 'payment_refund_due' ORDER BY recipient_staff_account_id NULLS FIRST`,
        [orderId],
      )
    ).rows as { member: string | null; staff: string | null; category: string | null; delivery_status: string; payload: Record<string, unknown> }[];
  /** 그 주문이 refunds(확정 예약 환불 원장)에 남긴 행 — 돌려줄 대상은 여기 들어가면 안 된다 */
  const refundRowsOf = async (orderId: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM refunds r JOIN reservations v ON v.id = r.reservation_id WHERE v.order_id = $1", [orderId])).n;
  const transactionIdOf = (gatewayPaymentId: string) => pg().buildPaidWebhookBody(gatewayPaymentId).data.transactionId ?? null;

  /** 회원·대표 알림 2건이 발송 전(pending)으로 하나씩 — 회원 연락처·계좌번호는 싣지 않는다 */
  async function expectRefundDueNotified(orderId: string, who: string, o: { kind: string; receivedAmount: number }) {
    const notices = await refundDueNotices(orderId);
    expect(notices).toHaveLength(2);
    const [mine, owner] = notices;
    expect(mine).toMatchObject({ member: memberIds[who], staff: null, delivery_status: "pending" });
    expect(owner).toMatchObject({ member: null, staff: staffIds["owner"], category: "settlement", delivery_status: "pending" });
    for (const n of notices) {
      expect(n.payload).toMatchObject({ reason: o.kind, receivedAmount: o.receivedAmount, orderAmount: 120000 });
      expect(JSON.stringify(n.payload)).not.toContain("01012345678");
    }
  }

  test("① 다른 금액 입금 — amount_mismatch 행(refund_due·입금액 전액) + 알림 2건, 확정하지 않고 자리는 held 그대로(FR-290)", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("m1", "mismatch", "virtual_account");
    pg().deposit(gatewayPaymentId, 100000);
    const res = await sendWebhook(paidBody(gatewayPaymentId));
    expect(res).toEqual({ status: 200, body: { result: "amount_mismatch", orderId, orderStatus: "pending" } });

    expect(await exceptionsOf(orderId)).toEqual([
      { kind: "amount_mismatch", status: "refund_due", received_amount: 100000, pg_transaction_id: transactionIdOf(gatewayPaymentId) },
    ]);
    await expectRefundDueNotified(orderId, "m1", { kind: "amount_mismatch", receivedAmount: 100000 });
    expect(await snapshot(orderId)).toMatchObject({
      order: "pending", payment: "ready", reported: 100000, reservation: "held", held: 1, confirmed: 0,
      calendar: 0, member_noti: 0, owner_noti: 0, settlement: 0, confirm_events: 0,
    });
    expect(await refundRowsOf(orderId)).toBe(0);

    // 같은 입금이 다른 webhook-id 로 다시 통지돼도 기록·알림은 한 번(uq_payment_exceptions_payment_kind)
    const again = await sendWebhook(paidBody(gatewayPaymentId));
    expect(again.body["result"]).toBe("amount_mismatch");
    expect(await exceptionsOf(orderId)).toHaveLength(1);
    expect(await refundDueNotices(orderId)).toHaveLength(2);
    expect(await webhookResults(gatewayPaymentId)).toEqual(["amount_mismatch", "amount_mismatch"]);
  });

  test("② 만료 뒤 입금 — expired 주문은 끝 상태 그대로, deposit_on_closed_order 행 + 알림 2건(FR-292)", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("l1", "late");
    const after = NOW.add({ minutes: 16 });
    expect((await expireDuePayments({ db: handle.db, clock: fixedClock(after), paymentGateway: pg() }, { offeringId: offerings["late"] })).expired).toBe(1);
    const expired = await snapshot(orderId);
    expect(expired).toMatchObject({ order: "expired", payment: "expired", reservation: "expired", held: 0, confirmed: 0 });
    const eventsBefore = (await one<{ n: number }>("SELECT count(*)::int AS n FROM order_events WHERE order_id = $1", [orderId])).n;

    pg().deposit(gatewayPaymentId, 120000);
    const res = await sendWebhook(paidBody(gatewayPaymentId), { at: after.add({ minutes: 1 }) });
    expect(res).toEqual({ status: 200, body: { result: "deposit_on_closed_order", orderId, orderStatus: "expired" } });

    // 끝 상태 불변 — 주문·결제·예약·자리·캘린더·정산 모두 만료 때 그대로. 달라지는 것은 pg_reported_amount 와 환불 대상 알림 2건(pending)뿐
    expect(await snapshot(orderId)).toEqual({ ...expired, reported: 120000, pending_noti: 2 });
    expect(await exceptionsOf(orderId)).toEqual([
      { kind: "deposit_on_closed_order", status: "refund_due", received_amount: 120000, pg_transaction_id: transactionIdOf(gatewayPaymentId) },
    ]);
    await expectRefundDueNotified(orderId, "l1", { kind: "deposit_on_closed_order", receivedAmount: 120000 });
    expect(await refundRowsOf(orderId)).toBe(0);
    // order_events 는 사유 1행만(expired → expired, 상태 전이 아님)
    const events = (await q("SELECT from_status, to_status, reason FROM order_events WHERE order_id = $1 ORDER BY id OFFSET $2", [orderId, eventsBefore])).rows;
    expect(events).toEqual([{ from_status: "expired", to_status: "expired", reason: "닫힌 주문 입금" }]);

    // 재통지(다른 webhook-id) — 여전히 expired, 기록·알림 한 번
    const again = await sendWebhook(paidBody(gatewayPaymentId), { at: after.add({ minutes: 2 }) });
    expect(again.body["result"]).toBe("deposit_on_closed_order");
    expect(await snapshot(orderId)).toEqual({ ...expired, reported: 120000, pending_noti: 2 });
    expect(await exceptionsOf(orderId)).toHaveLength(1);
    expect(await refundDueNotices(orderId)).toHaveLength(2);
  });

  test("③ 셀프 취소한 주문에 입금 — cancelled 그대로, deposit_on_closed_order 로 돌려줄 대상 기록", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("k1", "cancelled");
    await cancelUnpaidOrder({ db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: pg() }, { orderId, memberId: memberIds["k1"]! });
    const cancelled = await snapshot(orderId);
    expect(cancelled).toMatchObject({ order: "cancelled", payment: "cancelled", reservation: "cancelled", held: 0 });

    pg().deposit(gatewayPaymentId, 120000);
    const res = await sendWebhook(paidBody(gatewayPaymentId));
    expect(res).toEqual({ status: 200, body: { result: "deposit_on_closed_order", orderId, orderStatus: "cancelled" } });
    expect(await snapshot(orderId)).toEqual({ ...cancelled, reported: 120000, pending_noti: 2 });
    expect((await exceptionsOf(orderId)).map((e) => [e.kind, e.received_amount])).toEqual([["deposit_on_closed_order", 120000]]);
    await expectRefundDueNotified(orderId, "k1", { kind: "deposit_on_closed_order", receivedAmount: 120000 });
  });

  test("④ 중복 결제 — 같은 주문의 결제 통지가 두 번(순서대로·동시에) 와도 확정은 1건, 예외·환불 기록 없음(FR-291)", async () => {
    // 순서대로: 먼저 온 통지가 확정, 뒤에 온 통지(다른 webhook-id)는 ignored
    const seq = await startCardOrder("p1", "dupSeq");
    pg().deposit(seq.gatewayPaymentId, 120000);
    const first = await sendWebhook(paidBody(seq.gatewayPaymentId));
    const second = await sendWebhook(paidBody(seq.gatewayPaymentId));
    expect(first.body["result"]).toBe("confirmed");
    expect(second.body).toEqual({ result: "ignored", orderId: seq.orderId, orderStatus: "paid" });
    await expectConfirmedOnce(seq.orderId, "dupSeq");
    expect(await exceptionsOf(seq.orderId)).toEqual([]);
    expect(await refundDueNotices(seq.orderId)).toEqual([]);

    // 동시에 3건: 주문 조건부 UPDATE 를 한쪽만 이긴다
    const race = await startCardOrder("p2", "dupRace");
    pg().deposit(race.gatewayPaymentId, 120000);
    const body = paidBody(race.gatewayPaymentId);
    const results = await Promise.all([sendWebhook(body), sendWebhook(body), sendWebhook(body)]);
    expect(results.map((r) => r.body["result"]).sort()).toEqual(["confirmed", "ignored", "ignored"]);
    await expectConfirmedOnce(race.orderId, "dupRace");
    expect(await exceptionsOf(race.orderId)).toEqual([]);
    // 확정된 결제는 주문에 한 건뿐(uq_payments_order_live)
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM payments WHERE order_id = $1 AND status = 'paid'", [race.orderId])).n).toBe(1);
  });

  test("⑤ 다른 금액으로 이미 기록된 입금이 주문 만료 뒤 다시 통지돼도 돌려줄 대상은 1건(같은 돈을 두 번 돌려주지 않는다)", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("n1", "mismatchLate", "virtual_account");
    pg().deposit(gatewayPaymentId, 90000);
    expect((await sendWebhook(paidBody(gatewayPaymentId))).body["result"]).toBe("amount_mismatch");
    // 계좌 결제의 기한은 카드보다 길다 — DB 에 적힌 기한 1분 뒤로 간다
    const due = await one<{ due: string }>("SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS due FROM payments WHERE order_id = $1", [orderId]);
    const after = Temporal.Instant.from(due.due).add({ minutes: 1 });
    await expireDuePayments({ db: handle.db, clock: fixedClock(after), paymentGateway: pg() }, { offeringId: offerings["mismatchLate"] });
    expect((await snapshot(orderId)).order).toBe("expired");

    const late = await sendWebhook(paidBody(gatewayPaymentId), { at: after.add({ minutes: 1 }) });
    expect(late.body).toEqual({ result: "deposit_on_closed_order", orderId, orderStatus: "expired" });
    expect((await exceptionsOf(orderId)).map((e) => [e.kind, e.received_amount])).toEqual([["amount_mismatch", 90000]]);
    expect(await refundDueNotices(orderId)).toHaveLength(2);
  });
});
