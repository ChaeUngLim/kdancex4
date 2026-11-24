// S3-3.8(결제 실패 시 자리 해제) — 계약 03-checkout-payment.md §8 M-03(카드 승인 실패) · data-model §6-3
//   verify: 실패 통지 뒤 held −1, 예약 사유 payment_failed(플랜 S3-3 수용 ④)
//   그리고: 주문 cancelled·order_events 「결제 실패」·결제 cancelled·환불 행 0 · 응답 charged:false(「청구되지 않았다」) ·
//           두 번째 통지는 ignored(held 그대로) · PG 가 실패라고 하지 않으면 손대지 않음 · 이미 paid·expired 면 ignored ·
//           모르는 결제 번호 ignored · 풀린 자리를 다른 회원이 바로 잡는다 · 다시 결제하면 새 주문
//
// 주문은 진짜 주문 생성 경로(S3-3.4 POST /api/orders, 카드)로 만들고, 가짜 PG 의 failApproval 로 승인 실패를 흉내 낸다.
// 이름: verify 의 tests/db/s3-3-8.db.test.ts 는 Task 번호 이름이라 기능 이름(payment-failure)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { expireDuePayments } from "@/lib/server/services/order-expiry";
import { PAYMENT_FAILED_NOTICE, releaseSeatOnPaymentFailure } from "@/lib/server/services/payment-failure";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

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

describe.skipIf(!dbAvailable())("결제 실패 시 자리 해제(계약 03 §8 M-03, S3-3.8)", () => {
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
    handle = openTestDb();
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
      ["fail", "20:00", "21:00"], ["guard", "18:00", "19:00"], ["paid", "16:00", "17:00"], ["expired", "14:00", "15:00"],
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
  const failNotice = (gatewayPaymentId: string, at: Temporal.Instant = NOW.add({ minutes: 2 })) =>
    releaseSeatOnPaymentFailure({ db: handle.db, clock: fixedClock(at), paymentGateway: pg() }, { gatewayPaymentId });

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    const res = await order(who, bodyFor(offeringKey));
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }
  const orderState = async (orderId: string) =>
    one<{ order: string; payment: string; reservation: string; cancel_reason: string | null; reasons: string; refunds: number }>(
      `SELECT o.status AS order,
              (SELECT string_agg(p.status, ',') FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT string_agg(r.status::text, ',') FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT string_agg(r.cancel_reason::text, ',') FROM reservations r WHERE r.order_id = o.id) AS cancel_reason,
              (SELECT string_agg(e.reason, ',' ORDER BY e.created_at) FROM order_events e WHERE e.order_id = o.id) AS reasons,
              (SELECT count(*)::int FROM refunds f JOIN reservations r ON r.id = f.reservation_id WHERE r.order_id = o.id) AS refunds
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );

  test("① 카드 승인 실패 통지 뒤 held −1 · 주문 cancelled · 예약 사유 payment_failed · 응답 charged:false · 두 번째는 ignored", async () => {
    await member("m1");
    const { orderId, gatewayPaymentId } = await startCardOrder("m1", "fail");
    expect(await heldOf("fail")).toBe(1);

    pg().failApproval(gatewayPaymentId);
    const result = await failNotice(gatewayPaymentId);

    // 화면에 보일 「청구되지 않았다」 값이 응답에 있다
    expect(result).toEqual({ result: "payment_failed", orderId, orderStatus: "cancelled", charged: false, notice: PAYMENT_FAILED_NOTICE });
    expect(PAYMENT_FAILED_NOTICE).toContain("청구되지 않았");
    // 자리가 즉시 풀렸다(기한 15분을 기다리지 않음 — 통지는 주문 2분 뒤)
    expect(await heldOf("fail")).toBe(0);
    const state = await orderState(orderId);
    expect(state.order).toBe("cancelled");
    expect(state.payment).toBe("cancelled");
    expect(state.reservation).toBe("cancelled");
    expect(state.cancel_reason).toBe("payment_failed");
    expect(state.reasons.split(",")).toContain("결제 실패");
    // 돈이 오가지 않았으니 환불 행은 없다
    expect(state.refunds).toBe(0);

    // 같은 통지가 다시 와도 아무것도 바뀌지 않는다
    const again = await failNotice(gatewayPaymentId);
    expect(again).toEqual({ result: "ignored", orderId, orderStatus: "cancelled" });
    expect(await heldOf("fail")).toBe(0);
    expect((await orderState(orderId)).reasons.split(",").filter((r) => r === "결제 실패")).toHaveLength(1);

    // 풀린 자리는 다른 회원이 바로 잡고, 같은 회원이 다시 결제하면 새 주문이 생긴다
    await member("m2");
    const other = await order("m2", bodyFor("fail"));
    expect(other.status).toBe(201);
    expect(await heldOf("fail")).toBe(1);
  });

  test("② PG 가 실패라고 하지 않으면(ready) 통지를 믿지 않고 그대로 둔다 · 모르는 결제 번호는 ignored", async () => {
    await member("g1");
    const { orderId, gatewayPaymentId } = await startCardOrder("g1", "guard");
    // failApproval 을 하지 않았다 — PG 원장은 아직 ready
    const result = await failNotice(gatewayPaymentId);
    expect(result).toEqual({ result: "ignored", orderId, orderStatus: "pending" });
    expect(await heldOf("guard")).toBe(1);
    expect((await orderState(orderId)).order).toBe("pending");

    expect(await failNotice(`unknown-${randomUUID()}`)).toEqual({ result: "ignored", orderId: null, orderStatus: null });
  });

  test("③ 이미 끝난 주문(paid · expired)은 ignored — 끝 상태와 자리 수를 지킨다", async () => {
    // paid: 확정 웹훅(S3-3.9)이 하는 전이를 SQL 로 흉내 낸다 — 그 뒤 실패 통지가 늦게 와도 확정을 되돌리지 않는다
    await member("p1");
    const paid = await startCardOrder("p1", "paid");
    await q("UPDATE orders SET status = 'paid', closed_at = now() WHERE id = $1", [paid.orderId]);
    pg().failApproval(paid.gatewayPaymentId);
    expect(await failNotice(paid.gatewayPaymentId)).toEqual({ result: "ignored", orderId: paid.orderId, orderStatus: "paid" });
    expect(await heldOf("paid")).toBe(1);
    expect((await orderState(paid.orderId)).reservation).toBe("held");

    // expired: 기한이 지나 정리가 먼저 닫았다 — 자리는 정리 때 한 번만 풀린다(−1 이 두 번 일어나지 않음)
    await member("e1");
    const expired = await startCardOrder("e1", "expired");
    const after = NOW.add({ minutes: 16 });
    expect((await expireDuePayments({ db: handle.db, clock: fixedClock(after), paymentGateway: pg() }, { offeringId: offerings["expired"] })).expired).toBe(1);
    expect(await heldOf("expired")).toBe(0);
    // 만료 정리가 PG 결제를 cancelled 로 닫아 failApproval 은 효과가 없다. 그래도 통지가 오면 ignored
    pg().failApproval(expired.gatewayPaymentId);
    const res = await failNotice(expired.gatewayPaymentId, after);
    expect(res.result).toBe("ignored");
    expect(await heldOf("expired")).toBe(0);
    expect((await orderState(expired.orderId)).order).toBe("expired");
  });

  test("④ DB 가 payment_failed 값을 받는다(예약 사유 · 웹훅 결과 CHECK)", async () => {
    await q(
      "INSERT INTO payment_webhook_events (id, webhook_id, event_type, result, payload) VALUES (uuidv7(), $1, 'Transaction.Failed', 'payment_failed', '{}')",
      [`wh-${randomUUID()}`],
    );
    const { rows } = await q("SELECT count(*)::int AS n FROM payment_webhook_events WHERE result = 'payment_failed'");
    expect((rows[0] as { n: number }).n).toBe(1);
    await expect(
      q("INSERT INTO payment_webhook_events (id, webhook_id, event_type, result, payload) VALUES (uuidv7(), $1, 'x', 'no_such_result', '{}')", [`wh-${randomUUID()}`]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
