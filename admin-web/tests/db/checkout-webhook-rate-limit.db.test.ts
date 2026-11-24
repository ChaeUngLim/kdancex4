// S3-3.13(결제 시작·웹훅 요청 제한) — 플랜 S3-3 수용 ⑦ `[운영 보강 ②]` · R28(요청 제한이 정상 사용자를 막음) · 계약 03 §1·§6 · README §6-4
//   verify: 한 회원의 11번째 결제 시작은 429 RATE_LIMITED · 서명이 맞는 웹훅 재전송은 막히지 않는다
//   그리고: ① 같은 IP 의 다른 회원은 막히지 않는다(IP 가 아니라 회원으로 센다)
//           ② 한도는 환경 변수(RATE_LIMIT_CHECKOUT_MAX)로 바꾼다
//           ③ 웹훅은 서명 실패만 센다 — 20회 실패 뒤 21번째 틀린 서명은 429(기록 없음), 그 뒤에도 맞는 서명은 확정·duplicate
//           ④ Redis 가 꺼지면 결제 시작은 막는 쪽(429), 서명 맞는 웹훅은 Redis 와 상관없이 확정된다
//
// 주문은 진짜 주문 생성 경로(createOrderRoute)로, 웹훅은 라우트 처리기(createPaymentWebhookRoute)로 직접 보낸다.
// 횟수는 실제 Redis(kdance-redis, 테스트용 15번 DB)에 센다. 키 접두어를 실행마다 바꿔 다른 테스트와 섞이지 않게 한다.
// 이름: verify 의 tests/db/s3-3-13.db.test.ts 는 Task 번호 이름이라 기능 이름(checkout-webhook-rate-limit)으로 바꿨다(증거 EVIDENCE.md).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { createRateLimiter, loadRateLimitRules, RATE_LIMIT_RULES, type RateLimiter, type RateLimitRule } from "@/lib/server/rate-limit";
import { redisCommands } from "@/lib/server/redis";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute, type CheckoutRateLimit } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const REDIS_URL = process.env["TEST_REDIS_URL"] ?? "redis://localhost:6380/15";
const PREFIX = `rl-checkout-test-${randomUUID()}`;
/** 아무도 듣지 않는 주소 — 「Redis 가 꺼졌다」를 흉내 낸다 */
const DEAD_REDIS_URL = "redis://127.0.0.1:1";

async function redisReachable(): Promise<boolean> {
  try {
    const [pong] = await redisCommands(REDIS_URL, [["PING"]]);
    return pong === "PONG";
  } catch {
    return false;
  }
}
const reachable = await redisReachable();

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01(화)부터 — 지금은 그보다 열흘 앞
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
/** 학원 공유기 하나 — 여러 회원이 같은 IP 로 들어온다(R28) */
const SHARED_IP = "203.0.113.50";

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable() || !reachable)("결제 시작·웹훅 요청 제한(S3-3.13)", () => {
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
  type LimitedCall = Call & { retryAfter: string | null };
  /** 결제 시작 한 번. 요청 제한을 건 처리기로 보낸다(앱 경로와 같은 순서) — 모든 요청이 같은 IP 에서 온다 */
  async function order(who: string, body: Record<string, unknown>, limit: CheckoutRateLimit): Promise<LimitedCall> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${memberTokens[who]}`,
      "content-type": "application/json",
      "Idempotency-Key": randomUUID(),
      "x-forwarded-for": SHARED_IP,
    };
    const res = await createOrderRoute(deps(), { checkoutRateLimit: limit })(
      new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }),
      undefined,
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json, retryAfter: res.headers.get("Retry-After") };
  }
  const bodyFor = (offeringKey: string, extra: Record<string, unknown> = {}) => ({
    offeringId: offerings[offeringKey],
    seatKind: "male",
    method: "card",
    noticesAcknowledged: true,
    ...extra,
  });

  // ---- 요청 제한 재료 ------------------------------------------------------------------------
  const liveLimiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: PREFIX });
  /** 앱 경로와 같은 기본 규칙(환경 변수 없음 = 1분 10회 · 10분 20회) */
  const rules = loadRateLimitRules({});
  const checkoutLimit: CheckoutRateLimit = { limiter: liveLimiter, rule: rules.checkoutStart };
  /** 준비용 주문은 한도와 상관없게 — 규칙 이름을 따로 두고 한도를 크게 */
  const unlimited: CheckoutRateLimit = { limiter: liveLimiter, rule: { name: "test-unlimited", limit: 1_000_000, windowSeconds: 60 } };
  const ordersOf = async (who: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE member_id = $1", [memberIds[who]])).n;

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
      ["limitA", "08:00", "08:50"], ["limitB", "09:00", "09:50"], ["limitC", "10:00", "10:50"],
      ["webhook", "11:00", "11:50"], ["downOrder", "12:00", "12:50"], ["downHook", "13:00", "13:50"],
    ];
    for (const [key, start, end] of slots) {
      await makeClass(key, { start, end, capacity: { mode: "gender_split", male: 1, female: 1 } });
    }
  });

  afterAll(async () => {
    // 이 실행이 만든 Redis 키만 지운다(접두어에 무작위 값이 들어 있다)
    const [keys] = await redisCommands(REDIS_URL, [["KEYS", `${PREFIX}:*`]]);
    if (Array.isArray(keys) && keys.length > 0) await redisCommands(REDIS_URL, [["DEL", ...(keys as string[])]]);
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------
  /** 기본 원장(globalThis)을 쓰는 가짜 PG — 주문 생성 경로가 발급한 결제를 같은 원장에서 본다 */
  const pg = () => new FakePaymentGateway({ clock: fixedClock(NOW) });
  const WEBHOOK_AT = NOW.add({ minutes: 3 });
  /** 서명 실패 제한을 건 웹훅 처리기(앱 경로와 같다) */
  const webhookRoute = (limit: { limiter: RateLimiter; rule: RateLimitRule }) =>
    createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(WEBHOOK_AT),
      paymentGateway: pg(),
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
      signatureFailureLimit: limit,
    });

  type Hook = { status: number; body: Record<string, unknown> };
  /** 서명한 웹훅 한 건을 라우트에 보낸다. secret·sentAt 을 바꾸면 틀린 서명·오래된 요청을 만든다 */
  async function sendWebhook(
    rawBody: string,
    o: { limit: { limiter: RateLimiter; rule: RateLimitRule }; webhookId?: string; secret?: string },
  ): Promise<Hook & { retryAfter: string | null }> {
    const headers = signWebhook({
      secret: o.secret ?? WEBHOOK_SECRET,
      webhookId: o.webhookId ?? `wh_${randomUUID()}`,
      timestampSeconds: Math.floor(WEBHOOK_AT.epochMilliseconds / 1000),
      rawBody,
    });
    const res = await webhookRoute(o.limit)(
      new Request(`${BASE}/api/payments/webhook`, {
        method: "POST",
        // PG 와 공격자가 같은 IP 라 해도 서명이 맞는 쪽은 막히지 않아야 한다 — IP 를 일부러 같게 둔다
        headers: { ...headers, "content-type": "application/json", "x-forwarded-for": SHARED_IP },
        body: rawBody,
      }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, retryAfter: res.headers.get("Retry-After") };
  }
  const paidBody = (gatewayPaymentId: string) => JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId));

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey), unlimited);
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }


  test("verify ① 한 회원의 결제 시작 10회는 통과하고 11번째는 429 RATE_LIMITED + 남은 시간 — 주문은 늘지 않는다", async () => {
    await member("a1");
    const results: LimitedCall[] = [];
    for (let i = 1; i <= 10; i++) results.push(await order("a1", bodyFor("limitA"), checkoutLimit));
    // 첫 번째만 새 주문(201), 나머지 9번은 같은 판매 단위의 결제 대기를 돌려준다(M-04 진행 중 주문 복구, 200)
    expect(results.map((r) => r.status)).toEqual([201, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(RATE_LIMIT_RULES.checkoutStart).toEqual({ name: "checkout-start", limit: 10, windowSeconds: 60 });

    const eleventh = await order("a1", bodyFor("limitA"), checkoutLimit);
    expect(eleventh.status).toBe(429);
    // 응답 모양은 계약 README §6-4 그대로
    expect(eleventh.body).toMatchObject({ code: "RATE_LIMITED", detail: "잠시 뒤 다시 시도해 주세요" });
    const seconds = eleventh.body["retryAfterSeconds"] as number;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    expect(eleventh.retryAfter).toBe(String(seconds));
    // 12번째도 막힌다 — 주문은 처음 1건 그대로
    expect((await order("a1", bodyFor("limitA"), checkoutLimit)).status).toBe(429);
    expect(await ordersOf("a1")).toBe(1);
  });

  test("① 같은 IP(학원 공유기)의 다른 회원은 막히지 않는다 — IP 가 아니라 회원으로 센다(R28)", async () => {
    // a1 은 위에서 막혔다. 같은 SHARED_IP 에서 온 b1 은 첫 결제 시작이 그대로 201
    await member("b1");
    const res = await order("b1", bodyFor("limitB"), checkoutLimit);
    expect(res.status).toBe(201);
    orderResponseSchema.parse(res.body);
    expect((await order("a1", bodyFor("limitA"), checkoutLimit)).status).toBe(429);
  });

  test("② 한도는 환경 변수로 바꾼다 — RATE_LIMIT_CHECKOUT_MAX=3 이면 4번째가 429 · 잘못된 값은 시작 거부", async () => {
    const custom = loadRateLimitRules({ RATE_LIMIT_CHECKOUT_MAX: "3", RATE_LIMIT_CHECKOUT_WINDOW_SECONDS: "30" });
    expect(custom.checkoutStart).toEqual({ name: "checkout-start", limit: 3, windowSeconds: 30 });
    await member("c1");
    const limit: CheckoutRateLimit = { limiter: liveLimiter, rule: custom.checkoutStart };
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) statuses.push((await order("c1", bodyFor("limitC"), limit)).status);
    expect(statuses).toEqual([201, 200, 200, 429]);
    expect(() => loadRateLimitRules({ RATE_LIMIT_CHECKOUT_MAX: "0" })).toThrow();
    expect(() => loadRateLimitRules({ RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_MAX: "abc" })).toThrow();
  });

  test("verify ② 웹훅은 서명 실패만 센다 — 20회 실패 뒤 21번째 틀린 서명은 429(기록 없음), 맞는 서명 웹훅·재전송은 막히지 않는다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("w1", "webhook");
    pg().deposit(gatewayPaymentId, 120000);
    const body = paidBody(gatewayPaymentId);
    const limit = { limiter: liveLimiter, rule: rules.webhookSignatureFailure };
    expect(rules.webhookSignatureFailure).toEqual({ name: "webhook-signature-failure", limit: 20, windowSeconds: 600 });
    const rejectedRows = async () =>
      (await one<{ n: number }>("SELECT count(*)::int AS n FROM payment_webhook_events WHERE result = 'rejected_signature'")).n;
    const before = await rejectedRows();

    // 틀린 서명 20회 — 모두 401 이고 하나씩 기록된다
    for (let i = 1; i <= 20; i++) {
      const bad = await sendWebhook(body, { limit, secret: "whsec-wrong-secret" });
      expect(bad.status).toBe(401);
      expect(bad.body["code"]).toBe("INVALID_SIGNATURE");
    }
    expect(await rejectedRows()).toBe(before + 20);

    // 21번째 틀린 서명 — 429 + 남은 시간, 기록은 늘지 않는다
    const blocked = await sendWebhook(body, { limit, secret: "whsec-wrong-secret" });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "RATE_LIMITED" });
    expect(Number(blocked.retryAfter)).toBeGreaterThan(0);
    expect(Number(blocked.retryAfter)).toBeLessThanOrEqual(600);
    expect(await rejectedRows()).toBe(before + 20);

    // 막힌 동안에도(같은 IP 에서 와도) 서명이 맞는 웹훅은 확정된다
    const webhookId = `wh_${randomUUID()}`;
    const genuine = await sendWebhook(body, { limit, webhookId });
    expect(genuine).toMatchObject({ status: 200, body: { result: "confirmed", orderId, orderStatus: "paid" } });
    // PG 의 정상 재전송(같은 webhook-id)도 막히지 않고 duplicate 로 받는다 — 반영은 한 번
    const resend = await sendWebhook(body, { limit, webhookId });
    expect(resend).toMatchObject({ status: 200, body: { result: "duplicate" } });
    const again = await sendWebhook(body, { limit, webhookId });
    expect(again.status).toBe(200);
    // 다른 id 의 재통지도 200(이미 paid → ignored)
    expect((await sendWebhook(body, { limit })).body["result"]).toBe("ignored");
    const state = await one<{ order: string; confirmed: number }>(
      `SELECT o.status AS order, sp.confirmed_count AS confirmed FROM orders o
         JOIN reservations r ON r.order_id = o.id JOIN seat_pools sp ON sp.id = r.seat_pool_id WHERE o.id = $1`,
      [orderId],
    );
    expect(state).toEqual({ order: "paid", confirmed: 1 });
    // 그 뒤의 틀린 서명은 여전히 429
    expect((await sendWebhook(body, { limit, secret: "whsec-wrong-secret" })).status).toBe(429);
  });

  test("④ Redis 가 꺼지면 결제 시작은 막는 쪽(429)으로 실패하고, 서명 맞는 웹훅은 Redis 와 상관없이 확정된다", async () => {
    const dead = createRateLimiter({ redisUrl: DEAD_REDIS_URL, keyPrefix: PREFIX, timeoutMs: 500 });
    await member("d1");
    const res = await order("d1", bodyFor("downOrder"), { limiter: dead, rule: rules.checkoutStart });
    expect(res.status).toBe(429);
    expect(res.code).toBe("RATE_LIMITED");
    expect(await ordersOf("d1")).toBe(0);

    const { orderId, gatewayPaymentId } = await startCardOrder("d2", "downHook");
    pg().deposit(gatewayPaymentId, 120000);
    const limit = { limiter: dead, rule: rules.webhookSignatureFailure };
    const genuine = await sendWebhook(paidBody(gatewayPaymentId), { limit });
    expect(genuine).toMatchObject({ status: 200, body: { result: "confirmed", orderId } });
    // 틀린 서명은 셀 수 없으니 막는 쪽(429) — 확정에는 영향이 없다
    expect((await sendWebhook(paidBody(gatewayPaymentId), { limit, secret: "whsec-wrong-secret" })).status).toBe(429);
  });
});
