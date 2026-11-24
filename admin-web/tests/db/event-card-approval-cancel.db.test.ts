// S3-3.10(이벤트형 카드 승인 통지 전액 취소) — 웹훅 확정 경로(계약 03 §6) 안의 상품 종류 판정.
//   요구: FR-280(결제수단 결정) · FR-111a(카드 허용 범위) 강제 방법 ③ 「이 상품의 주문에 카드 승인 통지가 오면 확정하지 않고 전액 취소한다」
//         · 계약 17 §3-3(이벤트형에 카드 승인 → cancelPayment 전액)
//   verify: 이벤트형 + 카드 승인 통지 → PG 취소 호출 1회, 확정 안 됨(플랜 S3-3 수용 ① 뒤 절반)
//   그리고: 간편결제 승인도 같다 · 같은 통지를 다시 보내도 취소는 1회 · 결제 행이 카드인 이벤트형 주문도 같다 ·
//           이벤트형 + 계좌이체 승인과 정규 + 카드 승인은 그대로 확정된다(취소 0회) · PG 취소가 장애면 500 으로 전부 롤백되고 재전송이 다시 처리한다
//
// 판정 재료: 주문 스냅샷의 상품 종류(orders.class_kind, S3-3.2)와 PG 가 말한 승인 수단(가짜 PG 의 deposit(…, { method })).
// 주문은 진짜 경로(S3-3.4 POST /api/orders)로 만든다 — 이벤트형은 계좌이체로만 만들어지므로(S3-3.6), 회원이 결제창에서 카드로 바꿔
// 승인한 경우를 가짜 PG 의 승인 수단으로 흉내 낸다.
// 이름: verify 의 tests/db/s3-3-10.db.test.ts 는 Task 번호 이름이라 기능 이름(event-card-approval-cancel)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { PaymentMethod } from "@/lib/domain/constants";
import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import type { PaymentGatewayPort } from "@/lib/server/ports/payment-gateway";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute, DISALLOWED_APPROVAL_NOTICE } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 행사는 12/06 — 지금은 그보다 보름 앞
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
const WEBHOOK_AT = NOW.add({ minutes: 3 });

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};
const eventContent = { feeTiers: [{ window: "d7", percent: 10 }], nonRefundableCases: "당일 취소", processingBusinessDays: 3, ownerContact: "02-000-0000" };

describe.skipIf(!dbAvailable())("이벤트형 카드 승인 통지 전액 취소(계약 03 §6 · FR-111a 강제 방법 ③, S3-3.10)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberTokens: Record<string, string> = {};
  let academyId = "";
  let roomId = "";

  // 이 파일 전용 가짜 PG 원장 — 주문 생성·웹훅·검사가 같은 원장을 본다
  const pgStore = createFakePaymentGatewayStore();
  const pg = () => new FakePaymentGateway({ store: pgStore, clock: fixedClock(NOW) });
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });

  /** PG 취소 호출을 센다. 나머지는 가짜 PG 그대로 */
  function countingGateway(o: { failCancel?: boolean } = {}) {
    const calls: { id: string; reason: string }[] = [];
    const inner = pg();
    const gateway: PaymentGatewayPort = {
      createPayment: (r) => inner.createPayment(r),
      getPayment: (id) => inner.getPayment(id),
      refund: (r) => inner.refund(r),
      cancelPayment: async (id, reason) => {
        calls.push({ id, reason });
        if (o.failCancel) throw new Error("PG 취소 시간 초과");
        await inner.cancelPayment(id, reason);
      },
    };
    return { gateway, calls };
  }

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

  /** 학원 하나 + 정규·이벤트형 공지 판본 1개씩(수업 등록이 종류에 맞는 판본을 수업에 붙인다, S2-2.5) */
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
    for (const [kind, content] of [["regular", regularContent], ["event", eventContent]] as const) {
      await q(
        "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, $2, 1, $3, $4, $5)",
        [academyId, kind, `${kind} 공지 v1`, JSON.stringify(content), staffIds["owner"]],
      );
    }
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

  /** 대표가 올려 바로 공개되는 수업. 남자 자리 1개 — 한 장면의 자리 상태가 다른 장면에 새지 않게 장면마다 하나씩 */
  async function makeClass(key: string, body: Record<string, unknown>) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          subGenre: "latin",
          discipline: "samba",
          targetAges: ["all"],
          roomId,
          capacity: { mode: "gender_split", male: 1, female: 1 },
          introText: null,
          instructorAccountId: staffIds["junho"],
          ...body,
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

  /** 원데이(이벤트형) 하나 — 12/06 하루, 시각은 장면마다 나눈다(같은 강사·홀 겹침 거부, S2-2.4) */
  const makeOneDay = (key: string, startTime: string, endTime: string) =>
    makeClass(key, {
      classKind: "one_day",
      title: `쌈바 원데이 ${key}`,
      priceAmount: 30000,
      schedule: { kind: "single", date: "2026-12-06", startTime, endTime },
      refundDeadlineOn: "2026-12-05",
    });

  async function member(key: string) {
    const { token, userId } = await loggedInUser(key);
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', 'male', '1995-03-02', '01012345678', $3, '서연', now(), 'dance_sport', now())`,
      [randomUUID(), userId, `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
  }

  /** 진짜 주문 생성 경로로 주문을 만들고, 가짜 PG 결제 번호와 결제할 금액(주문 total)을 돌려준다 */
  async function startOrder(who: string, offeringKey: string, method: PaymentMethod) {
    await member(who);
    const headers = { authorization: `Bearer ${memberTokens[who]}`, "content-type": "application/json", "Idempotency-Key": randomUUID() };
    const body = { offeringId: offerings[offeringKey], seatKind: "male", method, noticesAcknowledged: true };
    const deps = { db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: pg(), deadlineConfig: DEFAULT_DEADLINE_CONFIG };
    const res = await createOrderRoute(deps)(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(await res.json());
    const row = await one<{ gid: string; total: number }>(
      "SELECT p.gateway_payment_id AS gid, o.total_amount AS total FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.id = $1",
      [orderId],
    );
    return { orderId, gatewayPaymentId: row.gid, total: row.total };
  }

  type Hook = { status: number; body: Record<string, unknown> };
  /** 서명한 입금·승인 웹훅 한 건을 라우트 처리기에 직접 보낸다(HTTP 왕복 없음 — 계약 03 §7) */
  async function sendPaid(
    gatewayPaymentId: string,
    gateway: PaymentGatewayPort,
    webhookId = `wh_${randomUUID()}`,
    // 재전송 장면은 처음 받은 본문을 그대로 다시 보낸다(취소 뒤에는 가짜 PG 가 입금 본문을 새로 만들지 않는다)
    rawBody = JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId)),
  ): Promise<Hook> {
    const headers = signWebhook({ secret: WEBHOOK_SECRET, webhookId, timestampSeconds: Math.floor(WEBHOOK_AT.epochMilliseconds / 1000), rawBody });
    const route = createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(WEBHOOK_AT),
      paymentGateway: gateway,
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });
    const res = await route(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: rawBody }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  type State = {
    order: string; payment: string; reported: number | null; reservation: string; cancel_reason: string | null;
    held: number; confirmed: number; calendar: number; notifications: number; settlement: number; cancel_events: number; paid_events: number;
  };
  /** 확정됐는지·닫혔는지를 한 줄로 읽는다 */
  const stateOf = (orderId: string) =>
    one<State>(
      `SELECT o.status AS order,
              (SELECT string_agg(p.status, ',') FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT max(p.pg_reported_amount) FROM payments p WHERE p.order_id = o.id) AS reported,
              (SELECT string_agg(r.status::text, ',') FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT max(r.cancel_reason::text) FROM reservations r WHERE r.order_id = o.id) AS cancel_reason,
              (SELECT sp.held_count FROM seat_pools sp JOIN reservations r ON r.seat_pool_id = sp.id WHERE r.order_id = o.id) AS held,
              (SELECT sp.confirmed_count FROM seat_pools sp JOIN reservations r ON r.seat_pool_id = sp.id WHERE r.order_id = o.id) AS confirmed,
              (SELECT count(*)::int FROM calendar_entries c JOIN reservations r ON r.id = c.reservation_id WHERE r.order_id = o.id) AS calendar,
              (SELECT count(*)::int FROM notifications n WHERE n.order_id = o.id) AS notifications,
              (SELECT count(*)::int FROM settlement_entries s WHERE s.order_id = o.id) AS settlement,
              (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id AND e.reason = '이벤트형 카드 승인 전액 취소') AS cancel_events,
              (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'paid') AS paid_events
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
  const webhookResults = async (gatewayPaymentId: string) =>
    (await q("SELECT result FROM payment_webhook_events WHERE gateway_payment_id = $1 ORDER BY received_at, result", [gatewayPaymentId])).rows.map(
      (r) => (r as { result: string }).result,
    );

  /** 확정되지 않고 닫힌 모습 — 자리는 풀리고 캘린더·알림·정산은 하나도 안 생긴다 */
  async function expectCancelledNotConfirmed(orderId: string, total: number) {
    expect(await stateOf(orderId)).toEqual({
      order: "cancelled", payment: "cancelled", reported: total, reservation: "cancelled", cancel_reason: "payment_failed",
      held: 0, confirmed: 0, calendar: 0, notifications: 0, settlement: 0, cancel_events: 1, paid_events: 0,
    });
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(order-create 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
    const slots: [string, string, string][] = [
      ["card", "08:00", "08:50"], ["easyPay", "09:00", "09:50"], ["dup", "10:00", "10:50"], ["cardRow", "11:00", "11:50"],
      ["transfer", "12:00", "12:50"], ["outage", "13:00", "13:50"],
    ];
    for (const [key, start, end] of slots) await makeOneDay(key, start, end);
    await makeClass("regular", {
      classKind: "regular",
      title: "쌈바 정규",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:00", endTime: "21:00", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      refundDeadlineOn: null,
    });
    // 준비가 맞는지: 원데이 주문 스냅샷의 상품 종류가 이벤트형으로 찍힌다(판정이 이 칸을 읽는다)
    const kind = await one<{ class_kind: string }>(
      "SELECT c.class_kind::text AS class_kind FROM class_offerings o JOIN classes c ON c.id = o.class_id WHERE o.id = $1",
      [offerings["card"]],
    );
    expect(kind.class_kind).toBe("one_day");
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test.each([
    ["card", "card"],
    ["easy_pay", "easyPay"],
  ] as const)("① 이벤트형 + %s 승인 통지 → PG 취소 1회, 확정 안 됨, 자리 풀림", async (approvedMethod, offeringKey) => {
    const { orderId, gatewayPaymentId, total } = await startOrder(`m-${offeringKey}`, offeringKey, "easy_transfer");
    // 준비: 주문 스냅샷이 이벤트형이다
    expect((await one<{ k: string }>("SELECT class_kind::text AS k FROM orders WHERE id = $1", [orderId])).k).toBe("one_day");
    // 회원이 결제창에서 카드(간편결제)로 바꿔 승인했다
    pg().deposit(gatewayPaymentId, total, { method: approvedMethod });
    const { gateway, calls } = countingGateway();

    const res = await sendPaid(gatewayPaymentId, gateway);

    expect(res).toEqual({
      status: 200,
      body: {
        result: "payment_failed",
        orderId,
        orderStatus: "cancelled",
        cancelledApproval: true,
        approvedMethod,
        notice: DISALLOWED_APPROVAL_NOTICE,
      },
    });
    expect(calls).toEqual([{ id: gatewayPaymentId, reason: "이벤트형 상품은 계좌이체만 받습니다" }]);
    // PG 쪽에서도 승인이 취소됐다
    expect((await pg().getPayment(gatewayPaymentId)).status).toBe("cancelled");
    await expectCancelledNotConfirmed(orderId, total);
    expect(await webhookResults(gatewayPaymentId)).toEqual(["payment_failed"]);
  });

  test("② 같은 통지를 다시 보내도(같은 id · 다른 id) PG 취소는 처음 한 번뿐이다", async () => {
    const { orderId, gatewayPaymentId, total } = await startOrder("m-dup", "dup", "easy_transfer");
    pg().deposit(gatewayPaymentId, total, { method: "card" });
    const { gateway, calls } = countingGateway();
    const webhookId = `wh_${randomUUID()}`;
    const body = JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId));

    const first = await sendPaid(gatewayPaymentId, gateway, webhookId, body);
    const sameId = await sendPaid(gatewayPaymentId, gateway, webhookId, body);
    const otherId = await sendPaid(gatewayPaymentId, gateway, `wh_${randomUUID()}`, body);

    expect(first.body["result"]).toBe("payment_failed");
    expect(sameId.body).toEqual({ result: "duplicate" });
    // 다른 id 의 재통지는 PG 재조회에서 이미 cancelled 라 손대지 않는다
    expect(otherId.body["result"]).toBe("ignored");
    expect(calls).toHaveLength(1);
    await expectCancelledNotConfirmed(orderId, total);
  });

  test("③ 결제 행 자체가 카드인 이벤트형 주문(화면을 거치지 않고 생긴 행)도 PG 가 수단을 말하지 않으면 결제 행 수단으로 판정해 취소한다", async () => {
    const { orderId, gatewayPaymentId, total } = await startOrder("m-cardrow", "cardRow", "easy_transfer");
    // 주문 생성은 이벤트형 카드를 막으므로(S3-3.6) 결제 행 수단을 DB 에서 바꿔 그런 행을 만든다
    await q("UPDATE payments SET method = 'card' WHERE order_id = $1", [orderId]);
    pgStore.payments.set(gatewayPaymentId, {
      ...pgStore.payments.get(gatewayPaymentId)!,
      request: { ...pgStore.payments.get(gatewayPaymentId)!.request, method: "card" },
    });
    pg().deposit(gatewayPaymentId, total); // 승인 수단을 따로 말하지 않는다
    expect((await pg().getPayment(gatewayPaymentId)).method).toBeUndefined();
    const { gateway, calls } = countingGateway();

    const res = await sendPaid(gatewayPaymentId, gateway);

    expect(res.body).toMatchObject({ result: "payment_failed", cancelledApproval: true, approvedMethod: "card" });
    expect(calls).toHaveLength(1);
    await expectCancelledNotConfirmed(orderId, total);
  });

  test("④ 이벤트형 + 간편 계좌이체 승인은 그대로 확정된다(PG 취소 0회)", async () => {
    const { orderId, gatewayPaymentId, total } = await startOrder("m-transfer", "transfer", "easy_transfer");
    pg().deposit(gatewayPaymentId, total, { method: "easy_transfer" });
    const { gateway, calls } = countingGateway();

    const res = await sendPaid(gatewayPaymentId, gateway);

    expect(res.body["result"]).toBe("confirmed");
    expect(calls).toHaveLength(0);
    expect(await stateOf(orderId)).toMatchObject({ order: "paid", payment: "paid", reservation: "confirmed", held: 0, confirmed: 1, calendar: 1, cancel_events: 0, paid_events: 1 });
  });

  test("⑤ 정규 수업의 카드 승인은 그대로 확정된다(판정이 이벤트형에만 걸린다)", async () => {
    const { orderId, gatewayPaymentId, total } = await startOrder("m-regular", "regular", "card");
    pg().deposit(gatewayPaymentId, total, { method: "card" });
    const { gateway, calls } = countingGateway();

    const res = await sendPaid(gatewayPaymentId, gateway);

    expect(res.body["result"]).toBe("confirmed");
    expect(calls).toHaveLength(0);
    expect(await stateOf(orderId)).toMatchObject({ order: "paid", payment: "paid", reservation: "confirmed", confirmed: 1, calendar: 8, cancel_events: 0 });
  });

  test("⑥ PG 취소가 장애면 500 — 닫기까지 롤백되고(자리·주문 그대로, 웹훅 기록 0), 재전송이 다시 취소한다", async () => {
    const { orderId, gatewayPaymentId, total } = await startOrder("m-outage", "outage", "easy_transfer");
    pg().deposit(gatewayPaymentId, total, { method: "card" });
    const webhookId = `wh_${randomUUID()}`;
    const broken = countingGateway({ failCancel: true });

    const failed = await sendPaid(gatewayPaymentId, broken.gateway, webhookId);

    expect(failed.status).toBe(500);
    expect(failed.body["code"]).toBe("INTERNAL");
    expect(broken.calls).toHaveLength(1);
    expect(await webhookResults(gatewayPaymentId)).toEqual([]);
    expect(await stateOf(orderId)).toMatchObject({ order: "pending", payment: "ready", reservation: "held", held: 1, confirmed: 0, cancel_events: 0 });
    expect((await pg().getPayment(gatewayPaymentId)).status).toBe("paid");

    // PG 가 같은 웹훅을 다시 보낸다 — 이번에는 취소가 된다
    const healthy = countingGateway();
    const retried = await sendPaid(gatewayPaymentId, healthy.gateway, webhookId);
    expect(retried.body["result"]).toBe("payment_failed");
    expect(healthy.calls).toHaveLength(1);
    await expectCancelledNotConfirmed(orderId, total);
  });
});
