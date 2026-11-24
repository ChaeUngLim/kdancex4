// S3-3.15b(결제 화면용 서버 조각) — 앱 결제 화면(S3-3.16)이 서버 값만으로 그려지게 하는 세 조각을 DB 로 확인한다.
//   ① `GET /api/orders/{orderId}`(계약 03 §2) — 결제 시작 응답과 같은 모양 + status 최신값, **본인 주문만**(남의 주문 403)
//   ② 수업 상세(계약 02 §2)의 classKind · priceBreakdownPreview — 주문 생성과 같은 계산(유료 이벤트형은 예매 수수료 2,000원 줄)
//   ③ 가짜 PG 결제 실패 조작(dev 경로 `…/fail`, 계약 03 §7·§8 M-03) — 실패 웹훅이 진짜 처리기를 거쳐 주문을 닫고, 조회가 cancelled 를 읽는다
//
// 준비(직원·학원·수업 등록·회원)는 이벤트형 결제수단 테스트(order-create-event-method.db.test.ts, S3-3.6)와 같은 방식이다.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { orderResponseSchema, type OrderResponse } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { DEV_ROUTES_ENV, withDevRoute } from "@/lib/server/dev-routes";
import { createDevFakePgHandlers } from "@/lib/server/services/dev-fake-pg";
import { createOfferingDetailRoute, offeringDetailSchema } from "@/lib/server/services/offering-detail";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createOrderDetailRoute } from "@/lib/server/services/order-detail";
import { PAYMENT_FAILED_NOTICE } from "@/lib/server/services/payment-failure";
import { processPaymentWebhook } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const WEBHOOK_SECRET = `whsec-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01 부터 — 지금은 그보다 열흘 앞
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};
const eventContent = { feeTiers: [{ window: "d7", percent: 10 }], nonRefundableCases: "당일 취소", processingBusinessDays: 3, ownerContact: "02-000-0000" };

describe.skipIf(!dbAvailable())("결제 화면용 서버 조각(S3-3.15b — 주문 조회 · 수업 상세 가격 내역 · 가짜 PG 실패)", () => {
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

  // 한 원장을 모든 경로가 같이 본다 — 주문 생성이 발급한 결제를 조회·실패 조작이 찾을 수 있어야 한다
  const pgStore = createFakePaymentGatewayStore();
  const pg = (now: Temporal.Instant = NOW) => new FakePaymentGateway({ store: pgStore, clock: fixedClock(now) });
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: pg(now),
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

  /** 대표가 올려 바로 공개되는 수업. body 는 종류별 칸만 넘긴다 */
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
          capacity: { mode: "gender_split", male: 6, female: 6 },
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

  async function member(key: string) {
    const { token, userId } = await loggedInUser(key);
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', 'male', '1995-03-02', '01012345678', $3, '서연', now(), 'dance_sport', now())`,
      [randomUUID(), userId, `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
  }

  const auth_ = (who: string) => ({ authorization: `Bearer ${memberTokens[who]}` });

  /** 결제 시작(POST /api/orders) — 응답 본문을 계약 스키마로 읽는다 */
  async function startOrder(who: string, offeringKey: string, method: string): Promise<OrderResponse> {
    const headers = { ...auth_(who), "content-type": "application/json", "Idempotency-Key": randomUUID() };
    const body = { offeringId: offerings[offeringKey], seatKind: "male", method, noticesAcknowledged: true };
    const res = await createOrderRoute(deps())(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    expect(res.status).toBe(201);
    return orderResponseSchema.parse(await res.json());
  }

  type Call = { status: number; body: Record<string, unknown>; headers: Headers };
  /** 주문 조회(GET /api/orders/{id}). who 가 null 이면 세션 없이 */
  async function readOrder(who: string | null, orderId: string, now: Temporal.Instant = NOW): Promise<Call> {
    const res = await createOrderDetailRoute(deps(now))(
      new Request(`${BASE}/api/orders/${orderId}`, { method: "GET", headers: who === null ? {} : auth_(who) }),
      { params: Promise.resolve({ orderId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  }

  async function readOffering(who: string, offeringKey: string) {
    const offeringId = offerings[offeringKey]!;
    const res = await createOfferingDetailRoute(deps())(
      new Request(`${BASE}/api/offerings/${offeringId}`, { method: "GET", headers: auth_(who) }),
      { params: Promise.resolve({ offeringId }) },
    );
    expect(res.status).toBe(200);
    return offeringDetailSchema.parse(await res.json());
  }

  const gatewayIdOf = async (orderId: string) =>
    (await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId])).gid;
  const heldOf = async (offeringKey: string) =>
    (await one<{ held: number }>("SELECT held_count AS held FROM seat_pools WHERE offering_id = $1 AND seat_kind = 'male'", [offerings[offeringKey]])).held;

  /** dev `…/fail` 처리기 — 앱 경로(route.ts)와 같이 withDevRoute 로 감싸고(열린 값), 진짜 웹훅 처리기(서명 검증 포함)에 넘긴다 */
  const devFail = (at: Temporal.Instant) =>
    withDevRoute(createDevFakePgHandlers({
      gateway: () => pg(at),
      sign: (input) => signWebhook({ secret: WEBHOOK_SECRET, ...input }),
      clock: fixedClock(at),
      processWebhook: (input) =>
        processPaymentWebhook(
          { db: handle.db, clock: fixedClock(at), paymentGateway: pg(at), webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }) },
          input,
        ),
    }).fail, { [DEV_ROUTES_ENV]: "true" });
  async function callFail(gatewayPaymentId: string, at: Temporal.Instant): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await devFail(at)(
      new Request(`${BASE}/api/dev/fake-pg/payments/${gatewayPaymentId}/fail`, { method: "POST" }),
      { params: Promise.resolve({ gatewayPaymentId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다
    await makeClass("regular", {
      classKind: "regular",
      title: "쌈바 정규",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:00", endTime: "21:00", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      refundDeadlineOn: null,
    });
    await makeClass("oneday", {
      classKind: "one_day",
      title: "쌈바 원데이",
      priceAmount: 30000,
      schedule: { kind: "single", date: "2026-12-06", startTime: "14:00", endTime: "16:00" },
      refundDeadlineOn: "2026-12-05",
    });
    await member("me");
    await member("other");
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- ① 주문 조회 ---------------------------------------------------------------------------

  test("① 본인 주문 조회는 200 — 결제 시작 응답과 같은 모양·같은 값(결제창 키까지), 캐시 금지", async () => {
    const started = await startOrder("me", "regular", "card");
    const read = await readOrder("me", started.orderId);
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    const body = orderResponseSchema.parse(read.body);
    expect(body).toEqual(started);
    expect(body.status).toBe("pending");
    expect(body.payment.cardCheckout?.checkoutKey).toMatch(/^checkout_/);
  });

  test("② 남의 주문은 403 FORBIDDEN, 없는 주문·모양이 틀린 id 는 404, 세션 없으면 401 — 본문에 주문 값이 새지 않는다", async () => {
    const started = await startOrder("me", "oneday", "virtual_account");
    const others = await readOrder("other", started.orderId);
    expect(others.status).toBe(403);
    expect(others.body).toEqual({ detail: "본인의 주문만 볼 수 있어요", code: "FORBIDDEN" });

    expect((await readOrder("me", randomUUID())).status).toBe(404);
    expect((await readOrder("me", "not-a-uuid")).body["code"]).toBe("NOT_FOUND");
    expect((await readOrder(null, started.orderId)).status).toBe(401);

    // 본인은 계좌까지 본다(남에게는 안 보여야 하는 값이라 403 이 필요하다)
    const mine = orderResponseSchema.parse((await readOrder("me", started.orderId)).body);
    expect(mine.payment.virtualAccount?.accountNumber).toMatch(/^\d{14}$/);
    expect(mine.payment.cardCheckout).toBeNull();
  });

  test("③ 기한이 지난 결제 대기는 조회하면 expired 로 보인다(읽기 전 정리) — 자리도 풀린다", async () => {
    // ②에서 이 회원이 원데이에 가상계좌 주문을 하나 잡아 두었다. 기한(발급 + 24시간)을 넘긴 시각에 다시 읽는다
    const { order_id: orderId } = await one<{ order_id: string }>(
      "SELECT o.id::text AS order_id FROM orders o WHERE o.offering_id = $1 AND o.status = 'pending'",
      [offerings["oneday"]],
    );
    expect(await heldOf("oneday")).toBe(1);
    const later = NOW.add({ hours: 25 });
    const read = orderResponseSchema.parse((await readOrder("me", orderId, later)).body);
    expect(read.status).toBe("expired");
    expect(read.payment.status).toBe("expired");
    expect(await heldOf("oneday")).toBe(0);
  });

  // ---- ② 수업 상세의 classKind · priceBreakdownPreview ---------------------------------------

  test("④ 정규 수업 상세 — classKind regular, 가격 내역에 예매 수수료 줄 없음, 결제 시작 priceBreakdown 과 같다", async () => {
    const detail = await readOffering("other", "regular");
    expect(detail.classKind).toBe("regular");
    expect(detail.priceBreakdownPreview).toEqual([
      { kind: "list_price", label: "정가", amount: 120000 },
      { kind: "benefit_discount", label: "혜택 할인", amount: 0 },
      { kind: "coupon_discount", label: "쿠폰 할인", amount: 0 },
      { kind: "final", label: "최종 결제액", amount: 120000 },
    ]);
    const started = await startOrder("other", "regular", "virtual_account");
    expect(started.priceBreakdown).toEqual(detail.priceBreakdownPreview);
  });

  test("⑤ 유료 원데이(이벤트형) 상세 — classKind one_day, 예매 수수료 2,000원 줄 포함, 최종 32,000원 = 실제 주문 금액", async () => {
    const detail = await readOffering("other", "oneday");
    expect(detail.classKind).toBe("one_day");
    expect(detail.priceBreakdownPreview).toEqual([
      { kind: "list_price", label: "정가", amount: 30000 },
      { kind: "benefit_discount", label: "혜택 할인", amount: 0 },
      { kind: "coupon_discount", label: "쿠폰 할인", amount: 0 },
      { kind: "booking_fee", label: "예매 수수료", amount: 2000 },
      { kind: "final", label: "최종 결제액", amount: 32000 },
    ]);
    const started = await startOrder("other", "oneday", "easy_transfer");
    expect(started.priceBreakdown).toEqual(detail.priceBreakdownPreview);
    expect(started.payment.amount).toBe(32000);
  });

  // ---- ③ 가짜 PG 결제 실패 조작 → 조회 ------------------------------------------------------

  test("⑥ dev fail 조작 → 실패 웹훅이 처리기를 거쳐 주문 cancelled · 자리 해제, 조회는 cancelled 를 읽고 결제창 키는 null", async () => {
    // ①에서 만든 정규 카드 주문(이 회원의 pending)을 실패시킨다
    const { order_id: orderId } = await one<{ order_id: string }>(
      `SELECT o.id::text AS order_id FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.offering_id = $1 AND o.status = 'pending' AND p.method = 'card'`,
      [offerings["regular"]],
    );
    const gid = await gatewayIdOf(orderId);
    const heldBefore = await heldOf("regular");
    const at = NOW.add({ minutes: 2 });

    const failed = await callFail(gid, at);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ result: "payment_failed", orderId, orderStatus: "cancelled", charged: false, notice: PAYMENT_FAILED_NOTICE });
    expect(String(failed.body["webhookId"])).toMatch(/^wh_dev_/);
    expect(await heldOf("regular")).toBe(heldBefore - 1);
    const hook = await one<{ results: string }>(
      "SELECT string_agg(result, ',') AS results FROM payment_webhook_events WHERE payload->'data'->>'paymentId' = $1",
      [gid],
    );
    expect(hook.results).toBe("payment_failed");

    const read = await readOrder("me", orderId, at);
    const body = orderResponseSchema.parse(read.body);
    expect(read.status).toBe(200);
    expect(body.status).toBe("cancelled");
    expect(body.payment.status).toBe("cancelled");
    expect(body.payment.cardCheckout).toBeNull();
  });

  test("⑦ dev fail 조작은 끝난 결제(실패·만료)에는 409 PAYMENT_NOT_FAILABLE, 모르는 결제 번호는 404 — 주문은 그대로", async () => {
    const failedOrder = await one<{ gid: string }>(
      "SELECT p.gateway_payment_id AS gid FROM payments p WHERE p.status = 'cancelled' AND p.method = 'card' LIMIT 1",
    );
    const again = await callFail(failedOrder.gid, NOW.add({ minutes: 3 }));
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("PAYMENT_NOT_FAILABLE");

    const expired = await one<{ gid: string; order_id: string }>(
      "SELECT p.gateway_payment_id AS gid, p.order_id::text AS order_id FROM payments p WHERE p.status = 'expired' LIMIT 1",
    );
    expect((await callFail(expired.gid, NOW.add({ hours: 26 }))).status).toBe(409);
    expect((await one<{ status: string }>("SELECT status FROM orders WHERE id = $1", [expired.order_id])).status).toBe("expired");

    expect((await callFail("pay_unknown_0000", NOW)).status).toBe(404);
  });
});
