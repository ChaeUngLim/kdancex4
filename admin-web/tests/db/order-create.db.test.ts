// S3-3.4(주문 생성 API) — `POST /api/orders`(계약 03 §1 · §8 M-04).
//   verify: 같은 키 두 번 → 같은 주문 · 같은 수업을 다시 누르면 기존 결제 대기(S3-3 수용 ③) · 공지 판본이 없으면 409 NOTICE_MISSING
//   그리고: 금액은 서버가 판매 단위 가격으로 계산(본문 금액 무시) · 자리 held 1 · 주문 칸 고정(공지·중개자·약관·수수료율·스냅샷) ·
//           카드 15분 / 가상계좌 계좌 발급 · 매진 409 · 확정 예약 409 ALREADY_RESERVED · 미성년 403 · 마감 409 · 같은 키 동시 2건
//
// 수업은 시드로 넣지 않는다 — 수업 상세 테스트(S3-2.3)와 같이 진짜 등록 경로(S2-2.3 POST /api/classes → 대표가 올려 바로 공개)로 만든다.
// 이름: verify 의 tests/db/s3-3-4.db.test.ts 는 Task 번호 이름이라 기능 이름(order-create)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
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

describe.skipIf(!dbAvailable())("주문 생성 API(계약 03 §1, S3-3.4)", () => {
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

  const pgStore = createFakePaymentGatewayStore();
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: new FakePaymentGateway({ store: pgStore, clock: fixedClock(now) }),
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
    await makeClass("main", { start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 6, female: 6 } });
    await makeClass("tiny", { start: "18:00", end: "19:00", capacity: { mode: "gender_split", male: 1, female: 1 } });
    await makeClass("single", { start: "16:00", end: "17:00", capacity: { mode: "single", any: 4 } });
    await makeClass("nonotice", { start: "14:00", end: "15:00", capacity: { mode: "gender_split", male: 2, female: 2 } });
    // 공지 판본이 안 붙은 수업(판본이 생기기 전의 옛 행 등) — 수업에 고정된 판본이 없으면 결제를 시작할 수 없다
    await q("UPDATE classes SET refund_notice_version_id = NULL WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [offerings["nonotice"]]);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 새 주문 201 — 금액은 서버가 계산(본문의 amount 무시), 자리 held 1, 주문 칸 고정, 카드 결제창 15분", async () => {
    await member("buyer");
    const res = await order("buyer", bodyFor("main", { amount: 1, totalAmount: 1 }));
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(body.status).toBe("pending");
    expect(body.seatKind).toBe("male");
    expect(body.priceBreakdown).toEqual([
      { kind: "list_price", label: "정가", amount: 120000 },
      { kind: "benefit_discount", label: "혜택 할인", amount: 0 },
      { kind: "coupon_discount", label: "쿠폰 할인", amount: 0 },
      { kind: "final", label: "최종 결제액", amount: 120000 },
    ]);
    expect(body.payment).toMatchObject({ method: "card", status: "ready", amount: 120000, dueAt: "2026-11-21T03:15:00Z", virtualAccount: null });
    expect(body.payment.cardCheckout?.checkoutKey).toMatch(/^checkout_/);
    expect(body.refundNoticeVersionId).toBe(noticeId);
    expect(body.intermediaryNoticeVersion).toBe("2026-11-06");

    expect(await heldOf("main")).toBe(1);
    const row = await one<Record<string, unknown>>(
      `SELECT status, list_price_amount, total_amount, booking_fee_amount, refund_notice_version_id::text AS notice,
              intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
              cancel_fee_platform_share_bp, class_kind::text AS class_kind, session_count
         FROM orders WHERE id = $1`,
      [body.orderId],
    );
    expect(row).toEqual({
      status: "pending",
      list_price_amount: 120000,
      total_amount: 120000,
      booking_fee_amount: 0,
      notice: noticeId,
      intermediary_notice_version: "2026-11-06",
      member_terms_version: "unversioned-beta",
      merchant_terms_version: "unversioned-beta",
      // 면제 종료일이 없는 학원의 일반 수업 = 시드 요율 500bp(S3-3.2a)
      platform_fee_rate_bp: 500,
      cancel_fee_platform_share_bp: 5000,
      class_kind: "regular",
      session_count: 8,
    });
    expect(await one("SELECT status, seat_kind FROM reservations WHERE order_id = $1", [body.orderId])).toEqual({ status: "held", seat_kind: "male" });
    expect(await one("SELECT from_status, to_status, reason FROM order_events WHERE order_id = $1", [body.orderId])).toEqual({
      from_status: null,
      to_status: "pending",
      reason: "checkout_started",
    });
    expect(await countOf("payments", "buyer")).toBe(1);
  });

  test("verify ① 같은 키 두 번 → 같은 주문(200, 본문이 달라도 처음 것), 행·자리 그대로", async () => {
    await member("twice");
    const key = randomUUID();
    const first = await order("twice", bodyFor("main"), { key });
    expect(first.status).toBe(201);
    const heldBefore = await heldOf("main");
    const again = await order("twice", bodyFor("main", { method: "virtual_account" }), { key });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await heldOf("main")).toBe(heldBefore);
    expect([await countOf("orders", "twice"), await countOf("reservations", "twice"), await countOf("payments", "twice")]).toEqual([1, 1, 1]);
  });

  test("verify ② 같은 수업을 다시 누르면(새 키) 새 주문이 아니라 기존 결제 대기(수용 ③ · M-04)", async () => {
    await member("reopen");
    const first = await order("reopen", bodyFor("main"));
    expect(first.status).toBe(201);
    const heldBefore = await heldOf("main");
    const again = await order("reopen", bodyFor("main"));
    expect(again.status).toBe(200);
    expect(orderResponseSchema.parse(again.body).orderId).toBe(orderResponseSchema.parse(first.body).orderId);
    expect(again.body).toEqual(first.body);
    expect(await heldOf("main")).toBe(heldBefore);
    expect(await countOf("orders", "reopen")).toBe(1);
  });

  test("verify ③ 수업에 공지 판본이 없으면 409 NOTICE_MISSING — 주문·예약·자리 모두 그대로", async () => {
    await member("nonotice");
    const res = await order("nonotice", bodyFor("nonotice"));
    expect([res.status, res.code]).toEqual([409, "NOTICE_MISSING"]);
    expect(await heldOf("nonotice")).toBe(0);
    expect([await countOf("orders", "nonotice"), await countOf("reservations", "nonotice")]).toEqual([0, 0]);
  });

  test("가상계좌 — 계좌가 발급되고 기한은 min(발급 + 24시간, 첫 회차 − 60분), 다시 눌러도 같은 계좌", async () => {
    await member("va", { gender: "female" });
    const res = await order("va", bodyFor("main", { seatKind: "female", method: "virtual_account" }));
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(body.payment).toMatchObject({ method: "virtual_account", dueAt: "2026-11-22T03:00:00Z", cardCheckout: null });
    expect(body.payment.virtualAccount?.accountNumber).toMatch(/^\d{14}$/);
    const db = await one<{ n: string }>("SELECT virtual_account_number AS n FROM payments WHERE order_id = $1", [body.orderId]);
    expect(db.n).toBe(body.payment.virtualAccount?.accountNumber);
    const again = await order("va", bodyFor("main", { seatKind: "female", method: "virtual_account" }));
    expect([again.status, again.body]).toEqual([200, res.body]);
  });

  test("간편 계좌이체 — 결제창 키 + 카드와 같은 15분 기한(FR-285)", async () => {
    await member("transfer");
    const body = orderResponseSchema.parse((await order("transfer", bodyFor("single", { seatKind: "any", method: "easy_transfer" }))).body);
    expect(body.payment).toMatchObject({ method: "easy_transfer", dueAt: "2026-11-21T03:15:00Z", virtualAccount: null });
    expect(body.payment.cardCheckout?.checkoutKey).toMatch(/^checkout_transfer_/);
  });

  test("본문 검사 — 공지 확인 안 함 422 · 정원 방식과 다른 자리 422 · 키 없음 400 · 없는 판매 단위 404", async () => {
    await member("bad");
    expect((await order("bad", bodyFor("main", { noticesAcknowledged: false }))).status).toBe(422);
    expect((await order("bad", bodyFor("main", { seatKind: "any" }))).status).toBe(422);
    expect((await order("bad", bodyFor("single", { seatKind: "male" }))).status).toBe(422);
    expect((await order("bad", bodyFor("main"), { key: null })).status).toBe(400);
    expect((await order("bad", { ...bodyFor("main"), offeringId: randomUUID() })).status).toBe(404);
    expect(await countOf("orders", "bad")).toBe(0);
  });

  test("마지막 자리 — 두 번째 회원은 409 SEAT_SOLD_OUT, 그 사람 행은 하나도 안 생긴다", async () => {
    await member("first");
    await member("second");
    expect((await order("first", bodyFor("tiny"))).status).toBe(201);
    const res = await order("second", bodyFor("tiny"));
    expect([res.status, res.code]).toEqual([409, "SEAT_SOLD_OUT"]);
    expect(await heldOf("tiny")).toBe(1);
    expect(await countOf("orders", "second")).toBe(0);
  });

  test("확정 예약이 있으면 새 결제는 409 ALREADY_RESERVED", async () => {
    await member("paid");
    const body = orderResponseSchema.parse((await order("paid", bodyFor("single", { seatKind: "any" }))).body);
    await q("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [body.orderId]);
    await q("UPDATE reservations SET status = 'confirmed' WHERE order_id = $1", [body.orderId]);
    const res = await order("paid", bodyFor("single", { seatKind: "any" }));
    expect([res.status, res.code]).toEqual([409, "ALREADY_RESERVED"]);
  });

  test("만 19세 미만은 403 MEMBER_UNDER_19(0단계) — 행 없음", async () => {
    await member("minor", { birthDate: "2010-05-05" });
    const res = await order("minor", bodyFor("main"));
    expect([res.status, res.code]).toEqual([403, "MEMBER_UNDER_19"]);
    expect(await countOf("orders", "minor")).toBe(0);
  });

  test("첫 회차가 시작된 뒤 · 닫힌 판매 단위는 409 CHECKOUT_CLOSED", async () => {
    await member("late");
    const afterStart = Temporal.Instant.from("2026-12-01T12:00:00Z");
    expect((await order("late", bodyFor("main"), { now: afterStart })).code).toBe("CHECKOUT_CLOSED");
    await q("UPDATE class_offerings SET status = 'closed' WHERE id = $1", [offerings["nonotice"]]);
    expect((await order("late", bodyFor("nonotice"))).code).toBe("CHECKOUT_CLOSED");
    expect(await countOf("orders", "late")).toBe(0);
  });

  test("같은 키 동시 2건 — 주문 1개, held +1, 둘 다 같은 주문을 받는다(유니크가 권위)", async () => {
    await member("race", { gender: "female" });
    const key = randomUUID();
    const heldBefore = await heldOf("main", "female");
    const [a, b] = await Promise.all([
      order("race", bodyFor("main", { seatKind: "female" }), { key }),
      order("race", bodyFor("main", { seatKind: "female" }), { key }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body).toEqual(b.body);
    expect(await heldOf("main", "female")).toBe(heldBefore + 1);
    expect(await countOf("orders", "race")).toBe(1);
  });
});
