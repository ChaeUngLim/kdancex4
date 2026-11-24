// S3-3.14(가짜 PG dev 경로) — 계약 03-checkout-payment.md §7 「시험 전용 — 가짜 PG 조작」
//   verify: dev 경로 호출 → 주문 paid · 운영 설정(KDANCE_DEV_ROUTES=false)에서 404
//   그리고: 입금 경로가 만든 웹훅은 진짜 웹훅과 같은 §6 처리기를 거친다(서명 검증·중복·금액 대조를 건너뛰지 않는다) ·
//           재전송은 같은 webhook-id 라 duplicate · PG 가 가짜가 아니면 열려 있어도 404 · 잘못된 요청은 계약 오류 모양
//
// 주문은 진짜 주문 생성 경로(S3-3.4 POST /api/orders, 카드)로 만들고, dev 처리기를 withDevRoute 로 감싸 env 를 주입해 부른다
// (route.ts 와 같은 조합). 가짜 PG 원장은 이 파일 전용(store)이라 다른 테스트와 섞이지 않는다.
// 이름: verify 의 tests/db/s3-3-14.db.test.ts 는 Task 번호 이름이라 기능 이름(dev-fake-pg)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { DEV_ROUTES_ENV, withDevRoute } from "@/lib/server/dev-routes";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createDevFakePgHandlers, createDevWebhookLedger, type DevFakePgDeps } from "@/lib/server/services/dev-fake-pg";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { processPaymentWebhook } from "@/lib/server/services/payment-webhook";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

/** 이 파일 전용 가짜 PG 원장 — 주문 생성·dev 입금·웹훅 재조회가 모두 이 원장을 본다 */
const store = createFakePaymentGatewayStore();

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

describe.skipIf(!dbAvailable())("가짜 PG dev 경로(계약 03 §7, S3-3.14)", () => {
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
    paymentGateway: new FakePaymentGateway({ store, clock: fixedClock(now) }),
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
      ["devConfirm", "08:00", "08:50"], ["devProd", "09:00", "09:50"], ["devMismatch", "10:00", "10:50"], ["devErrors", "11:00", "11:50"], ["devInvalid", "12:00", "12:50"],
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
  const WEBHOOK_AT = NOW.add({ minutes: 3 });
  const pg = () => new FakePaymentGateway({ store, clock: fixedClock(WEBHOOK_AT) });
  const OPEN = { [DEV_ROUTES_ENV]: "true" };
  const ledger = createDevWebhookLedger();

  /** dev 처리기 재료. 웹훅 처리 재료는 진짜 웹훅 경로와 같은 모양(검증기는 WEBHOOK_SECRET) */
  const devDeps = (o: { signSecret?: string; gateway?: DevFakePgDeps["gateway"] } = {}): DevFakePgDeps => ({
    gateway: o.gateway ?? (() => pg()),
    sign: (input) => signWebhook({ ...input, secret: o.signSecret ?? WEBHOOK_SECRET }),
    clock: fixedClock(WEBHOOK_AT),
    processWebhook: (input) =>
      processPaymentWebhook(
        { db: handle.db, clock: fixedClock(WEBHOOK_AT), paymentGateway: pg(), webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }) },
        input,
      ),
    ledger,
  });

  type Hook = { status: number; body: Record<string, unknown> };
  async function callDeposit(
    gatewayPaymentId: string,
    body: unknown,
    o: { env?: Record<string, string | undefined>; signSecret?: string; gateway?: DevFakePgDeps["gateway"] } = {},
  ): Promise<Hook> {
    const route = withDevRoute(createDevFakePgHandlers(devDeps(o)).deposit, o.env ?? OPEN);
    const res = await route(
      new Request(`${BASE}/api/dev/fake-pg/payments/${encodeURIComponent(gatewayPaymentId)}/deposit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ gatewayPaymentId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  async function callReplay(body: unknown, o: { env?: Record<string, string | undefined> } = {}): Promise<Hook> {
    const route = withDevRoute(createDevFakePgHandlers(devDeps()).replay, o.env ?? OPEN);
    const res = await route(
      new Request(`${BASE}/api/dev/fake-pg/webhooks/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      undefined,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey));
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }
  const orderState = (orderId: string) =>
    one<{ order: string; payment: string; reservation: string; confirm_events: number }>(
      `SELECT o.status AS order,
              (SELECT string_agg(p.status, ',') FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT string_agg(r.status::text, ',') FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id AND e.reason = '입금 확인') AS confirm_events
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
  const webhookRows = async (gatewayPaymentId: string) =>
    (
      await q("SELECT webhook_id, result FROM payment_webhook_events WHERE gateway_payment_id = $1 ORDER BY received_at, result", [gatewayPaymentId])
    ).rows as { webhook_id: string; result: string }[];

  test("① dev 입금 경로를 부르면 서명된 웹훅이 §6 처리기를 거쳐 주문이 paid 가 된다 — 재전송은 같은 id 라 duplicate, 반영은 한 번", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("m1", "devConfirm");
    expect(await orderState(orderId)).toMatchObject({ order: "pending", payment: "ready", reservation: "held" });

    const res = await callDeposit(gatewayPaymentId, { amount: 120000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "confirmed", orderId, orderStatus: "paid" });
    const webhookId = res.body["webhookId"] as string;
    expect(webhookId).toMatch(/^wh_dev_/);
    expect(await orderState(orderId)).toEqual({ order: "paid", payment: "paid", reservation: "confirmed", confirm_events: 1 });
    // 웹훅 원장에 진짜 웹훅처럼 남는다(서명 통과 → confirmed), 그 id 는 응답의 webhookId
    expect(await webhookRows(gatewayPaymentId)).toEqual([{ webhook_id: webhookId, result: "confirmed" }]);
    // 가짜 PG 원장에도 입금이 적혔다(웹훅 처리기는 이것을 다시 조회해 금액을 맞췄다)
    expect(await pg().getPayment(gatewayPaymentId)).toMatchObject({ status: "paid", amount: 120000 });

    // 재전송: 같은 webhook-id·같은 원문 → §6 2번이 duplicate 로 받는다. 반영은 그대로 한 번
    const again = await callReplay({ webhookId });
    expect(again).toEqual({ status: 200, body: { result: "duplicate", webhookId } });
    expect(await orderState(orderId)).toEqual({ order: "paid", payment: "paid", reservation: "confirmed", confirm_events: 1 });
    expect(await webhookRows(gatewayPaymentId)).toEqual([{ webhook_id: webhookId, result: "confirmed" }]);
  });

  test("② 운영 설정(KDANCE_DEV_ROUTES=false·값 없음·비슷한 값)에서는 두 경로 모두 404 — 입금도 웹훅도 생기지 않는다", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("m2", "devProd");
    for (const env of [{ [DEV_ROUTES_ENV]: "false" }, {}, { [DEV_ROUTES_ENV]: "TRUE" }, { [DEV_ROUTES_ENV]: "1" }]) {
      const dep = await callDeposit(gatewayPaymentId, { amount: 120000 }, { env });
      expect(dep).toEqual({ status: 404, body: { detail: "찾을 수 없어요", code: "NOT_FOUND" } });
      const rep = await callReplay({ webhookId: "wh_dev_any" }, { env });
      expect(rep).toEqual({ status: 404, body: { detail: "찾을 수 없어요", code: "NOT_FOUND" } });
    }
    expect(await orderState(orderId)).toMatchObject({ order: "pending", payment: "ready", reservation: "held" });
    expect(await pg().getPayment(gatewayPaymentId)).toMatchObject({ status: "ready" });
    expect(await webhookRows(gatewayPaymentId)).toEqual([]);

    // 열려 있어도 PG 구현이 가짜가 아니면(실 PG 가 붙은 뒤) 404
    const real = await callDeposit(gatewayPaymentId, { amount: 120000 }, { gateway: () => null });
    expect(real).toEqual({ status: 404, body: { detail: "찾을 수 없어요", code: "NOT_FOUND" } });
    expect(await pg().getPayment(gatewayPaymentId)).toMatchObject({ status: "ready" });
  });

  test("③ dev 경로는 §6 규칙을 건너뛰지 않는다 — 금액이 다르면 amount_mismatch(확정 안 함), 비밀값이 다르면 401", async () => {
    const { orderId, gatewayPaymentId } = await startCardOrder("m3", "devMismatch");
    const res = await callDeposit(gatewayPaymentId, { amount: 100000 });
    expect(res.status).toBe(200);
    expect(res.body["result"]).toBe("amount_mismatch");
    expect(await orderState(orderId)).toMatchObject({ order: "pending", reservation: "held", confirm_events: 0 });

    // 서명 비밀값이 검증기와 다르면 처리기가 서명 실패로 거절한다 — dev 경로라고 서명 검사를 면제받지 않는다
    const other = await startCardOrder("m3b", "devErrors");
    const forged = await callDeposit(other.gatewayPaymentId, { amount: 120000 }, { signSecret: "whsec-wrong-secret" });
    expect(forged).toMatchObject({ status: 401, body: { code: "INVALID_SIGNATURE" } });
    expect(await orderState(other.orderId)).toMatchObject({ order: "pending", confirm_events: 0 });
    // 서명 실패 기록은 결제 번호를 모른 채(rejected:<id>) 남으므로 이 결제의 웹훅 행은 없다
    expect(await webhookRows(other.gatewayPaymentId)).toEqual([]);
  });

  test("④ 잘못된 요청 — 없는 결제 404 · 두 번째 입금 409 ALREADY_DEPOSITED · 금액·칸이 틀리면 422 · JSON 아님 400 · 모르는 webhookId 404", async () => {
    expect(await callDeposit("pay_does_not_exist", { amount: 1000 })).toEqual({ status: 404, body: { detail: "찾을 수 없어요", code: "NOT_FOUND" } });

    const { orderId, gatewayPaymentId } = await startCardOrder("m4", "devInvalid");
    for (const bad of [{ amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: "120000" }, {}, { amount: 1000, extra: true }]) {
      const res = await callDeposit(gatewayPaymentId, bad);
      expect(res.status).toBe(422);
      expect(res.body["code"]).toBe("VALIDATION_FAILED");
    }
    expect((await callDeposit(gatewayPaymentId, "not json")).status).toBe(400);
    // 위의 잘못된 요청들은 원장을 건드리지 않았다
    expect(await pg().getPayment(gatewayPaymentId)).toMatchObject({ status: "ready" });

    // 입금은 결제 하나에 한 번만 받는다 — 두 번째는 409(같은 웹훅을 다시 보내려면 재전송 경로)
    const first = await callDeposit(gatewayPaymentId, { amount: 120000 });
    expect(first.body).toMatchObject({ result: "confirmed", orderId });
    const second = await callDeposit(gatewayPaymentId, { amount: 120000 });
    expect(second).toMatchObject({ status: 409, body: { code: "ALREADY_DEPOSITED" } });

    expect(await callReplay({ webhookId: "wh_dev_unknown" })).toEqual({ status: 404, body: { detail: "찾을 수 없어요", code: "NOT_FOUND" } });
    expect((await callReplay({})).status).toBe(422);
  });
});
