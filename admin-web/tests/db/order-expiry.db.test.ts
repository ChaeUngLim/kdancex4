// S3-3.7(만료 정리·셀프 취소·내부 경로) — 계약 03-checkout-payment.md §2(셀프 취소) · §5(만료 정리) · §1 2단계
//   verify: 기한 지난 주문 expired + held −1 · 셀프 취소 뒤 자리 복구 · 두 번 불러도 결과 같음
//   그리고: 기한 전엔 그대로 · 그사이 입금된 주문은 건너뜀(조건부 UPDATE) · 주문 생성·상세·홈 목록 직전 정리 ·
//           내부 경로 POST /api/internal/orders/expire 는 토큰이 없으면 401, 맞으면 200 { expired }
//
// 주문은 진짜 주문 생성 경로(S3-3.4 POST /api/orders)로 만든다 — 카드 결제는 기한이 주문 시각 + 15분이다.
// 이름: verify 의 tests/db/s3-3-7.db.test.ts 는 Task 번호 이름이라 기능 이름(order-expiry)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { cancelOrderResponseSchema } from "@/lib/server/schemas/cancellation";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createHomeOfferingsRoute, homeOfferingsResponseSchema } from "@/lib/server/services/home-offerings";
import { createOfferingDetailRoute, offeringDetailSchema } from "@/lib/server/services/offering-detail";
import { createCancelOrderRoute } from "@/lib/server/services/order-cancel";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { expireDuePayments } from "@/lib/server/services/order-expiry";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01(화)부터 — 지금은 그보다 열흘 앞
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
// 카드 결제 기한(15분)이 지난 때와 아직 안 지난 때
const AFTER_DUE = NOW.add({ minutes: 16 });
const BEFORE_DUE = NOW.add({ minutes: 10 });

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("만료 정리·셀프 취소·내부 경로(계약 03 §2·§5, S3-3.7)", () => {
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
  const countOf = async (table: "orders" | "reservations" | "payments", memberKey: string) => {
    const sql =
      table === "payments"
        ? "SELECT count(*)::int AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.member_id = $1"
        : `SELECT count(*)::int AS n FROM ${table} WHERE member_id = $1`;
    return (await one<{ n: number }>(sql, [memberIds[memberKey]])).n;
  };

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
      ["expire", "20:00", "21:00"], ["race", "18:00", "19:00"], ["cancel", "16:00", "17:00"],
      ["create", "14:00", "15:00"], ["detail", "12:00", "13:00"], ["home", "10:00", "11:00"], ["route", "08:00", "09:00"],
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
    // 내부 경로가 쓰는 앱 공용 db 의 풀도 닫는다(대타 요청 만료 테스트와 같은 방식)
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });


  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------
  const orderState = async (orderId: string) =>
    one<{ order: string; payment: string; reservation: string; events: number }>(
      `SELECT o.status AS order,
              (SELECT string_agg(p.status, ',') FROM payments p WHERE p.order_id = o.id) AS payment,
              (SELECT string_agg(r.status::text, ',') FROM reservations r WHERE r.order_id = o.id) AS reservation,
              (SELECT count(*)::int FROM order_events e WHERE e.order_id = o.id) AS events
         FROM orders o WHERE o.id = $1`,
      [orderId],
    );
  const expireAt = (at: Temporal.Instant, offeringKey?: string) =>
    expireDuePayments(
      { db: handle.db, clock: fixedClock(at), paymentGateway: new FakePaymentGateway({ clock: fixedClock(at) }) },
      offeringKey === undefined ? {} : { offeringId: offerings[offeringKey] },
    );
  async function startOrder(who: string, offeringKey: string): Promise<string> {
    const res = await order(who, bodyFor(offeringKey));
    expect(res.status).toBe(201);
    return orderResponseSchema.parse(res.body).orderId;
  }
  async function cancel(who: string, orderId: string, at: Temporal.Instant = NOW) {
    const res = await createCancelOrderRoute(deps(at))(
      new Request(`${BASE}/api/orders/${orderId}/cancel`, { method: "POST", headers: { authorization: `Bearer ${memberTokens[who]}` } }),
      { params: Promise.resolve({ orderId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const remainingMale = (capacity: { pools: { seatKind: string; remaining: number }[] }) =>
    capacity.pools.find((p) => p.seatKind === "male")?.remaining;

  test("① 기한 지난 주문 → 주문·결제·예약 expired, held −1, order_events 1행 더, PG 계좌(결제창) 폐기", async () => {
    await member("m1");
    const orderId = await startOrder("m1", "expire");
    expect(await heldOf("expire")).toBe(1);

    // 기한 전에는 아무것도 바뀌지 않는다
    expect(await expireAt(BEFORE_DUE, "expire")).toEqual({ expired: 0 });
    expect(await orderState(orderId)).toMatchObject({ order: "pending", payment: "ready", reservation: "held", events: 1 });

    expect(await expireAt(AFTER_DUE, "expire")).toEqual({ expired: 1 });
    expect(await orderState(orderId)).toEqual({ order: "expired", payment: "expired", reservation: "expired", events: 2 });
    expect(await heldOf("expire")).toBe(0);
    const event = await one<{ from: string; to: string; reason: string }>(
      "SELECT from_status AS from, to_status AS to, reason FROM order_events WHERE order_id = $1 AND to_status = 'expired'",
      [orderId],
    );
    expect(event).toEqual({ from: "pending", to: "expired", reason: "payment_deadline_passed" });
    const closed = await one<{ closed: boolean }>("SELECT closed_at IS NOT NULL AS closed FROM orders WHERE id = $1", [orderId]);
    expect(closed.closed).toBe(true);
    // 가짜 PG 원장에서도 결제가 닫혔다(계좌 폐기 호출)
    const payment = await one<{ id: string }>("SELECT gateway_payment_id AS id FROM payments WHERE order_id = $1", [orderId]);
    const gateway = await new FakePaymentGateway({ clock: fixedClock(AFTER_DUE) }).getPayment(payment.id);
    expect(gateway.status).toBe("cancelled");

    // 두 번 불러도 결과가 같다 — 두 번째는 0건, held 는 0 그대로(−1 이 두 번 일어나지 않는다), 이벤트도 더 안 생긴다
    expect(await expireAt(AFTER_DUE, "expire")).toEqual({ expired: 0 });
    expect(await expireAt(AFTER_DUE)).toEqual({ expired: 0 });
    expect(await heldOf("expire")).toBe(0);
    expect(await orderState(orderId)).toEqual({ order: "expired", payment: "expired", reservation: "expired", events: 2 });
  });

  test("② 그사이 입금 확정된 주문은 건너뛴다 — pending 조건부 UPDATE 가 0행", async () => {
    await member("m2");
    const orderId = await startOrder("m2", "race");
    // 웹훅이 먼저 주문을 paid 로 바꾼 상황(결제 행은 아직 ready 로 남은 순간)을 흉내 낸다
    await q("UPDATE orders SET status = 'paid', paid_at = $2::timestamptz WHERE id = $1", [orderId, BEFORE_DUE.toString()]);
    expect(await expireAt(AFTER_DUE, "race")).toEqual({ expired: 0 });
    expect(await orderState(orderId)).toMatchObject({ order: "paid", payment: "ready", reservation: "held" });
    expect(await heldOf("race")).toBe(1);
  });

  test("③ 셀프 취소 → 자리 복구, 다른 회원이 그 자리를 산다 · 두 번 취소해도 200 같은 본문 · 만료된 주문은 409", async () => {
    await member("c1");
    await member("c2");
    const orderId = await startOrder("c1", "cancel");
    expect(await heldOf("cancel")).toBe(1);
    // 남자 자리 1개가 결제 대기로 잡혀 다른 회원은 못 산다
    expect((await order("c2", bodyFor("cancel"))).code).toBe("SEAT_SOLD_OUT");

    const first = await cancel("c1", orderId);
    expect(first.status).toBe(200);
    expect(cancelOrderResponseSchema.parse(first.body)).toEqual({ orderId, status: "cancelled" });
    expect(await heldOf("cancel")).toBe(0);
    expect(await orderState(orderId)).toEqual({ order: "cancelled", payment: "cancelled", reservation: "cancelled", events: 2 });
    const reason = await one<{ reason: string }>("SELECT cancel_reason AS reason FROM reservations WHERE order_id = $1", [orderId]);
    expect(reason.reason).toBe("self_cancel_unpaid");
    // 환불 행을 만들지 않는다 — 돈이 오가지 않았다(계약 §2)
    const refunds = await one<{ n: number }>("SELECT count(*)::int AS n FROM refunds WHERE reservation_id IN (SELECT id FROM reservations WHERE order_id = $1)", [orderId]);
    expect(refunds.n).toBe(0);

    // 두 번 불러도 같은 답, 자리는 한 번만 돌아온다
    const second = await cancel("c1", orderId);
    expect(second).toEqual(first);
    expect(await heldOf("cancel")).toBe(0);

    // 풀린 자리를 다른 회원이 산다
    const other = await order("c2", bodyFor("cancel"));
    expect(other.status).toBe(201);
    expect(await heldOf("cancel")).toBe(1);

    // 기한이 지나 만료된 주문은 셀프 취소 대상이 아니다
    await expireAt(AFTER_DUE, "cancel");
    const expiredOrderId = orderResponseSchema.parse(other.body).orderId;
    expect(await cancel("c2", expiredOrderId, AFTER_DUE)).toMatchObject({ status: 409, body: { code: "ORDER_NOT_CANCELLABLE" } });
  });

  test("④ 주문 생성 직전 정리 — 기한 지난 결제 대기가 잡던 마지막 자리를 새 회원이 산다(계약 §1 2단계)", async () => {
    await member("o1");
    await member("o2");
    const stale = await startOrder("o1", "create");
    const res = await order("o2", bodyFor("create"), { now: AFTER_DUE });
    expect(res.status).toBe(201);
    expect((await orderState(stale)).order).toBe("expired");
    expect(await heldOf("create")).toBe(1); // 옛 주문 −1, 새 주문 +1

    // 기한이 지난 내 결제 대기를 「진행 중 주문」으로 이어 주지 않고 새 주문을 만든다(M-04 끝 문장)
    const again = await order("o1", bodyFor("create", { seatKind: "female" }), { now: AFTER_DUE });
    expect(again.status).toBe(201);
    expect(orderResponseSchema.parse(again.body).orderId).not.toBe(stale);
  });

  test("⑤ 수업 상세 읽기 전 정리 — 기한이 지나면 잔여석에 풀린 자리가 보인다", async () => {
    await member("d1");
    const stale = await startOrder("d1", "detail");
    const read = async (at: Temporal.Instant) => {
      const offeringId = offerings["detail"]!;
      const res = await createOfferingDetailRoute({ db: handle.db, getSession, clock: fixedClock(at), paymentGateway: new FakePaymentGateway({ clock: fixedClock(at) }) })(
        new Request(`${BASE}/api/offerings/${offeringId}`, { headers: { authorization: `Bearer ${memberTokens["d1"]}` } }),
        { params: Promise.resolve({ offeringId }) },
      );
      expect(res.status).toBe(200);
      return offeringDetailSchema.parse(await res.json());
    };
    expect(remainingMale((await read(BEFORE_DUE)).capacity)).toBe(0);
    expect((await orderState(stale)).order).toBe("pending");
    expect(remainingMale((await read(AFTER_DUE)).capacity)).toBe(1);
    expect((await orderState(stale)).order).toBe("expired");
  });

  test("⑥ 홈 목록 읽기 전 정리 — 전부 정리한 뒤 잔여석을 읽는다", async () => {
    await member("h1");
    const stale = await startOrder("h1", "home");
    const res = await createHomeOfferingsRoute({ db: handle.db, getSession, clock: fixedClock(AFTER_DUE), paymentGateway: new FakePaymentGateway({ clock: fixedClock(AFTER_DUE) }) })(
      new Request(`${BASE}/api/home/offerings?limit=50`, { headers: { authorization: `Bearer ${memberTokens["h1"]}` } }),
      {},
    );
    expect(res.status).toBe(200);
    const body = homeOfferingsResponseSchema.parse(await res.json());
    const item = body.items.find((i) => i.offeringId === offerings["home"]);
    expect(item).toBeDefined();
    expect(remainingMale(item!.capacity)).toBe(1);
    expect((await orderState(stale)).order).toBe("expired");
  });

  describe("⑦ 내부 경로 POST /api/internal/orders/expire", () => {
    const TOKEN = `test-internal-${randomUUID()}`;
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/orders/expire/route");
      return POST(new Request("http://localhost/api/internal/orders/expire", { method: "POST", headers, body }), undefined);
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
    });

    test("토큰이 없거나 틀리면 401 이고 주문이 그대로다", async () => {
      await member("r1");
      const orderId = await startOrder("r1", "route");
      expect((await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AFTER_DUE.toString() }))).status).toBe(401);
      expect((await call({ "X-Internal-Token": "wrong", "Content-Type": "application/json" }, JSON.stringify({ asOf: AFTER_DUE.toString() }))).status).toBe(401);
      expect((await orderState(orderId)).order).toBe("pending");
      expect(await heldOf("route")).toBe(1);
    });

    test("토큰이 맞으면 200 { expired } — 다시 부르면 0 · 모르는 칸은 422", async () => {
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };
      const first = await call(headers, JSON.stringify({ asOf: AFTER_DUE.toString() }));
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ expired: 1 });
      expect(await heldOf("route")).toBe(0);
      const second = await call(headers, JSON.stringify({ asOf: AFTER_DUE.toString() }));
      expect(await second.json()).toEqual({ expired: 0 });
      expect((await call(headers, JSON.stringify({ asOf: AFTER_DUE.toString(), extra: 1 }))).status).toBe(422);
    });
  });
});
