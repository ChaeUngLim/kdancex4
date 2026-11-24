// S3-3.9(웹훅 확정 일괄 처리) — 계약 03-checkout-payment.md §6 · data-model §4-1 「pending → paid」 · 계약 04 §3(확정 알림 2건)
//   verify: 서명 틀림 401 · 같은 웹훅 두 번 → 한 번 반영(플랜 S3-3 수용 ⑤) · 동시 2건 → 1회
//   그리고: 확정 한 번에 주문·결제·예약·자리·캘린더(회차 수)·알림 2건(행만, pending)·정산 hold 1건·order_events 가 함께 바뀐다 ·
//           세 금액이 다르면 확정하지 않음 · PG 가 입금됐다고 하지 않으면 본문을 믿지 않음 · 닫힌 주문은 끝 상태 유지 ·
//           Transaction.Failed 는 S3-3.8 전이 · PG 장애면 500 이고 기록까지 롤백돼 재전송이 다시 처리된다
//
// 주문은 진짜 주문 생성 경로(S3-3.4 POST /api/orders, 카드)로 만들고, 가짜 PG 의 deposit 으로 입금을 흉내 낸 뒤
// 서명한 웹훅을 라우트 처리기(createPaymentWebhookRoute)에 직접 보낸다(HTTP 왕복 없음 — 계약 §7 「어댑터 함수를 바로 부른다」).
// 이름: verify 의 tests/db/s3-3-9.db.test.ts 는 Task 번호 이름이라 기능 이름(payment-webhook)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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
import { PAYMENT_FAILED_NOTICE } from "@/lib/server/services/payment-failure";
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

describe.skipIf(!dbAvailable())("웹훅 확정 일괄 처리(계약 03 §6, S3-3.9)", () => {
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
      ["confirm", "08:00", "08:50"], ["dup", "09:00", "09:50"], ["raceSame", "10:00", "10:50"], ["raceDiff", "11:00", "11:50"],
      ["mismatch", "12:00", "12:50"], ["guard", "13:00", "13:50"], ["closed", "14:00", "14:50"], ["failed", "15:00", "15:50"],
      ["outage", "16:00", "16:50"], ["badsig", "17:00", "17:50"],
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

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey));
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

  test("① 서명이 틀리면 401 INVALID_SIGNATURE · rejected_signature 기록 · 아무것도 안 바뀜 — 같은 id 의 진짜 웹훅은 그 뒤에도 확정된다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("b1", "badsig");
    pg().deposit(gatewayPaymentId, 120000);
    const body = paidBody(gatewayPaymentId);
    const webhookId = `wh_${randomUUID()}`;

    const wrong = await sendWebhook(body, { webhookId, secret: "whsec-wrong-secret" });
    expect(wrong).toEqual({ status: 401, body: { detail: "웹훅 서명이 맞지 않아요", code: "INVALID_SIGNATURE" } });
    expect((await snapshot(orderId))).toMatchObject({ order: "pending", held: 1, confirmed: 0 });
    // 같은 webhook-id 로 진짜(맞는 비밀값) 웹훅이 오면 확정된다
    const genuine = await sendWebhook(body, { webhookId });
    expect(genuine.status).toBe(200);
    expect(genuine.body["result"]).toBe("confirmed");
    await expectConfirmedOnce(orderId, "badsig");

    const rejected = await one<{ n: number; claimed: string }>(
      "SELECT count(*)::int AS n, max(payload->>'claimedWebhookId') AS claimed FROM payment_webhook_events WHERE result = 'rejected_signature' AND payload->>'claimedWebhookId' = $1",
      [webhookId],
    );
    // 위조 요청은 주장한 id 를 원장에 선점하지 못했다(그래서 진짜가 confirmed 로 들어왔다)
    expect(rejected).toEqual({ n: 1, claimed: webhookId });
    expect(await webhookResults(gatewayPaymentId)).toEqual(["confirmed"]);

    // 오래된 시각(허용 오차 5분 밖) · 서명 헤더 없음도 401
    const stale = await sendWebhook(body, { sentAt: WEBHOOK_AT.subtract({ minutes: 6 }) });
    expect(stale.status).toBe(401);
    const res = await webhookRoute()(new Request(`${BASE}/api/payments/webhook`, { method: "POST", body }), undefined);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_SIGNATURE");
    // 본문 한 글자를 바꿔 원래 서명을 붙인 요청도 401
    const signed = signWebhook({ secret: WEBHOOK_SECRET, webhookId: `wh_${randomUUID()}`, timestampSeconds: Math.floor(WEBHOOK_AT.epochMilliseconds / 1000), rawBody: body });
    const forged = await webhookRoute()(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: signed, body: body.replace("Transaction.Paid", "Transaction.Paid ") }),
      undefined,
    );
    expect(forged.status).toBe(401);
    await expectConfirmedOnce(orderId, "badsig");
  });

  test("② 입금 웹훅 한 번에 주문·결제·예약·자리·캘린더·알림 2건·정산 보류·order_events 가 함께 바뀐다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("c1", "confirm");
    const before = await snapshot(orderId);
    expect(before).toMatchObject({ order: "pending", payment: "ready", reservation: "held", held: 1, confirmed: 0, calendar: 0, settlement: 0 });

    pg().deposit(gatewayPaymentId, 120000);
    const res = await sendWebhook(paidBody(gatewayPaymentId));
    expect(res).toEqual({ status: 200, body: { result: "confirmed", orderId, orderStatus: "paid" } });
    await expectConfirmedOnce(orderId, "confirm");
    expect(await webhookResults(gatewayPaymentId)).toEqual(["confirmed"]);

    // 알림은 행만 — 발송 전(pending). 대표 알림은 대표 직원 계정 알림함에, 회원 연락처 없이
    const owner = await one<{ staff: string; payload: Record<string, unknown> }>(
      "SELECT recipient_staff_account_id::text AS staff, payload FROM notifications WHERE order_id = $1 AND kind = 'payment_confirmed_owner'",
      [orderId],
    );
    expect(owner.staff).toBe(staffIds["owner"]);
    expect(owner.payload).toEqual({ title: "수업 confirm", amount: 120000, seatKind: "male" });
    const mine = await one<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM notifications WHERE order_id = $1 AND kind = 'payment_confirmed_member'",
      [orderId],
    );
    expect(mine.payload).toMatchObject({ title: "수업 confirm", amount: 120000 });
    // 첫 회차 12/01(화) 08:00 KST = 11/30 23:00 UTC(순간 값으로 싣는다)
    expect(mine.payload["firstSessionStartsAt"]).toBe("2026-11-30T23:00:00Z");
  });

  test("③ 같은 웹훅이 두 번 오면 두 번째는 duplicate — 반영은 한 번(수용 ⑤)", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("d1", "dup");
    pg().deposit(gatewayPaymentId, 120000);
    const body = paidBody(gatewayPaymentId);
    const webhookId = `wh_${randomUUID()}`;

    const first = await sendWebhook(body, { webhookId });
    const second = await sendWebhook(body, { webhookId });
    expect(first.body["result"]).toBe("confirmed");
    expect(second).toEqual({ status: 200, body: { result: "duplicate" } });
    await expectConfirmedOnce(orderId, "dup");
    // 다른 webhook-id 로 같은 결제가 다시 통지돼도(PG 재통지) ignored — 이미 paid
    const third = await sendWebhook(body);
    expect(third.body).toEqual({ result: "ignored", orderId, orderStatus: "paid" });
    await expectConfirmedOnce(orderId, "dup");
    expect(await webhookResults(gatewayPaymentId)).toEqual(["confirmed", "ignored"]);
  });

  test("④ 동시 2건 → 1회: 같은 webhook-id 동시 · 서로 다른 webhook-id 동시 둘 다 한 번만 반영", async () => {
    // 같은 id 가 동시에 — 두 번째 INSERT 는 첫 트랜잭션을 기다렸다가 충돌로 빠진다
    const same = await startCardOrder("r1", "raceSame");
    pg().deposit(same.gatewayPaymentId, 120000);
    const sameBody = paidBody(same.gatewayPaymentId);
    const webhookId = `wh_${randomUUID()}`;
    const sameResults = await Promise.all([sendWebhook(sameBody, { webhookId }), sendWebhook(sameBody, { webhookId })]);
    expect(sameResults.map((r) => r.status)).toEqual([200, 200]);
    expect(sameResults.map((r) => r.body["result"]).sort()).toEqual(["confirmed", "duplicate"]);
    await expectConfirmedOnce(same.orderId, "raceSame");

    // 다른 id 가 동시에 — 주문 조건부 UPDATE 를 한쪽만 이긴다
    const diff = await startCardOrder("r2", "raceDiff");
    pg().deposit(diff.gatewayPaymentId, 120000);
    const diffBody = paidBody(diff.gatewayPaymentId);
    const diffResults = await Promise.all([sendWebhook(diffBody), sendWebhook(diffBody), sendWebhook(diffBody)]);
    expect(diffResults.map((r) => r.body["result"]).sort()).toEqual(["confirmed", "ignored", "ignored"]);
    await expectConfirmedOnce(diff.orderId, "raceDiff");
  });

  test("⑤ 세 금액 대조 — PG 입금액이 다르면 확정하지 않는다(amount_mismatch, 자리는 held 그대로)", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("x1", "mismatch");
    pg().deposit(gatewayPaymentId, 100000);
    // 본문에는 금액이 없다 — 대조는 PG 재조회 금액으로 한다
    const res = await sendWebhook(paidBody(gatewayPaymentId));
    expect(res).toEqual({ status: 200, body: { result: "amount_mismatch", orderId, orderStatus: "pending" } });
    const s = await snapshot(orderId);
    expect(s).toMatchObject({ order: "pending", payment: "ready", reported: 100000, reservation: "held", held: 1, confirmed: 0, calendar: 0, member_noti: 0, settlement: 0 });
    expect(await webhookResults(gatewayPaymentId)).toEqual(["amount_mismatch"]);
  });

  test("⑥ 본문이 「입금됨」이라 해도 PG 재조회가 입금 아님이면 ignored · 모르는 결제 번호 ignored · 다른 type ignored", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("g1", "guard");
    // deposit 을 하지 않았다 — PG 원장은 ready. 위조 본문을 서명해 보낸다(서명 비밀이 샜다고 가정해도 확정은 안 된다)
    const fake = JSON.stringify({ type: "Transaction.Paid", timestamp: NOW.toString(), data: { paymentId: gatewayPaymentId, transactionId: "tx-forged" } });
    expect((await sendWebhook(fake)).body).toEqual({ result: "ignored", orderId, orderStatus: "pending" });
    expect((await snapshot(orderId))).toMatchObject({ order: "pending", held: 1, confirmed: 0 });

    const unknown = JSON.stringify({ type: "Transaction.Paid", timestamp: NOW.toString(), data: { paymentId: `gp-${randomUUID()}` } });
    expect((await sendWebhook(unknown)).body).toEqual({ result: "ignored", orderId: null, orderStatus: null });
    const other = JSON.stringify({ type: "Transaction.Ready", timestamp: NOW.toString(), data: { paymentId: gatewayPaymentId } });
    expect((await sendWebhook(other)).body).toEqual({ result: "ignored" });
    // 서명은 맞는데 본문이 JSON 이 아니면 기록만 하고 ignored
    expect((await sendWebhook("not-json")).body).toEqual({ result: "ignored" });
  });

  test("⑦ 이미 만료된 주문에 입금 — 확정하지 않고 expired 유지(deposit_on_closed_order), 자리·캘린더 그대로", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("e1", "closed");
    const after = NOW.add({ minutes: 16 });
    expect((await expireDuePayments({ db: handle.db, clock: fixedClock(after), paymentGateway: pg() }, { offeringId: offerings["closed"] })).expired).toBe(1);
    pg().deposit(gatewayPaymentId, 120000);
    const res = await sendWebhook(paidBody(gatewayPaymentId), { at: after.add({ minutes: 1 }) });
    expect(res).toEqual({ status: 200, body: { result: "deposit_on_closed_order", orderId, orderStatus: "expired" } });
    expect(await snapshot(orderId)).toMatchObject({ order: "expired", payment: "expired", reported: 120000, reservation: "expired", held: 0, confirmed: 0, calendar: 0, settlement: 0 });
  });

  test("⑧ Transaction.Failed 웹훅은 결제 실패 전이(S3-3.8)를 같은 트랜잭션에서 한다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("f1", "failed");
    pg().failApproval(gatewayPaymentId);
    const res = await sendWebhook(failedBody(gatewayPaymentId));
    expect(res).toEqual({ status: 200, body: { result: "payment_failed", orderId, orderStatus: "cancelled", charged: false, notice: PAYMENT_FAILED_NOTICE } });
    expect(await snapshot(orderId)).toMatchObject({ order: "cancelled", reservation: "cancelled", held: 0, confirmed: 0 });
    expect(await webhookResults(gatewayPaymentId)).toEqual(["payment_failed"]);
  });

  test("⑨ PG 재조회가 장애면 500 — 웹훅 기록까지 롤백돼 같은 webhook-id 재전송이 duplicate 로 빠지지 않고 확정된다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("o1", "outage");
    pg().deposit(gatewayPaymentId, 120000);
    const body = paidBody(gatewayPaymentId);
    const webhookId = `wh_${randomUUID()}`;
    const broken: PaymentGatewayPort = {
      ...pg(),
      createPayment: (r) => pg().createPayment(r),
      cancelPayment: (id, reason) => pg().cancelPayment(id, reason),
      refund: (r) => pg().refund(r),
      getPayment: async () => {
        throw new Error("PG 연결 시간 초과");
      },
    };
    const failed = await sendWebhook(body, { webhookId, gateway: broken });
    expect(failed.status).toBe(500);
    expect(failed.body["code"]).toBe("INTERNAL");
    expect(await webhookResults(gatewayPaymentId)).toEqual([]);
    expect((await snapshot(orderId)).order).toBe("pending");

    const retried = await sendWebhook(body, { webhookId });
    expect(retried.body["result"]).toBe("confirmed");
    await expectConfirmedOnce(orderId, "outage");
  });
});
