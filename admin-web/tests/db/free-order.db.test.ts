// S3-3.12(0원 주문) — `POST /api/orders` 에서 최종 결제액이 0원이면 PG 를 부르지 않고 바로 확정한다(계약 03 §1 9단계 보충 · M-05(0원 신청)).
//   verify: 가짜 PG 호출 0회 · 예약 confirmed(플랜 S3-3 수용 ⑥)
//   그리고: 주문·결제 paid(결제 금액 0, PG 가 모르는 번호) · 자리 held 0 / confirmed 1 · 캘린더 8회차 · 확정 알림 2건 ·
//           정산 보류 0행(data-model 정산 ⑧ 「무료 수업 0원 줄은 원장에 안 쓴다」) · 같은 키 재요청도 PG 0회 ·
//           첫 회차가 코앞이라 가상계좌 기한이 안 나와도 0원은 확정 · 유료 수업은 그대로 PG 를 부른다(대조군)
//
// 이름: verify 의 tests/db/s3-3-12.db.test.ts 는 Task 번호 이름이라 기능 이름(free-order)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 수업은 주문 생성 테스트(order-create.db.test.ts)와 같은 진짜 등록 경로(대표가 올려 바로 공개)로 만든다.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import type { PaymentGatewayPort } from "@/lib/server/ports/payment-gateway";
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

describe.skipIf(!dbAvailable())("0원 주문 바로 확정(계약 03 §1 9단계 · M-05, S3-3.12)", () => {
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
  // 가짜 PG 를 감싸 메서드 이름마다 몇 번 불렸는지 센다 — 「PG 호출 0회」를 숫자로 확인하려는 것
  const pgCalls: string[] = [];
  function countingGateway(now: Temporal.Instant): PaymentGatewayPort {
    const inner = new FakePaymentGateway({ store: pgStore, clock: fixedClock(now) });
    return {
      createPayment: (req) => (pgCalls.push("createPayment"), inner.createPayment(req)),
      getPayment: (id) => (pgCalls.push("getPayment"), inner.getPayment(id)),
      cancelPayment: (id, reason) => (pgCalls.push("cancelPayment"), inner.cancelPayment(id, reason)),
      refund: (req) => (pgCalls.push("refund"), inner.refund(req)),
    };
  }
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: countingGateway(now),
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

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24 = 8회차, 가격은 o.price) */
  async function makeClass(key: string, o: { start: string; end: string; capacity: Capacity; price: number }) {
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
          priceAmount: o.price,
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
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
    await makeClass("free", { start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 6, female: 6 }, price: 0 });
    await makeClass("paid", { start: "18:00", end: "19:00", capacity: { mode: "gender_split", male: 6, female: 6 }, price: 120000 });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  const poolOf = async (offeringKey: string, seatKind = "male") =>
    one<{ held: number; confirmed: number }>(
      "SELECT held_count AS held, confirmed_count AS confirmed FROM seat_pools WHERE offering_id = $1 AND seat_kind = $2",
      [offerings[offeringKey], seatKind],
    );

  test("verify ① 0원 수업 결제 시작 → 201 paid, 가짜 PG 호출 0회, 예약 confirmed 와 확정 일괄 처리(정산 보류 없음)", async () => {
    await member("freebie");
    pgCalls.length = 0;
    const res = await order("freebie", bodyFor("free"));
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(pgCalls).toEqual([]);

    expect(body.status).toBe("paid");
    expect(body.priceBreakdown.find((line) => line.kind === "final")?.amount).toBe(0);
    expect(body.payment).toMatchObject({ method: "card", status: "paid", amount: 0, virtualAccount: null, cardCheckout: null });
    expect(body.refundNoticeVersionId).toBe(noticeId);

    // 주문·결제·예약
    expect(await one("SELECT status, total_amount, (paid_at IS NOT NULL) AS paid FROM orders WHERE id = $1", [body.orderId])).toEqual({
      status: "paid",
      total_amount: 0,
      paid: true,
    });
    const pay = await one<{ status: string; amount: number; gateway_payment_id: string; key: string | null; reported: number | null; paid: boolean }>(
      `SELECT status, amount, gateway_payment_id, gateway_payment_key AS key, pg_reported_amount AS reported, (paid_at IS NOT NULL) AS paid
         FROM payments WHERE order_id = $1`,
      [body.orderId],
    );
    expect(pay).toMatchObject({ status: "paid", amount: 0, key: null, reported: null, paid: true });
    // PG 에 만든 적 없는 번호 — 가짜 PG 원장에 없다
    expect(pay.gateway_payment_id).toMatch(/^free_/);
    expect(pgStore.payments.has(pay.gateway_payment_id)).toBe(false);
    expect(await one("SELECT status FROM reservations WHERE order_id = $1", [body.orderId])).toEqual({ status: "confirmed" });
    expect(await poolOf("free")).toEqual({ held: 0, confirmed: 1 });

    // 확정 일괄 처리 — 캘린더 8회차 · 알림 회원 1 + 대표(직원 계정) 1 · 정산 보류 0행 · 주문 기록 두 줄
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM calendar_entries WHERE member_id = $1", [memberIds["freebie"]])).n).toBe(8);
    const notis = (await q("SELECT kind, delivery_status FROM notifications WHERE order_id = $1 ORDER BY kind", [body.orderId])).rows;
    expect(notis).toEqual([
      { kind: "payment_confirmed_member", delivery_status: "pending" },
      { kind: "payment_confirmed_owner", delivery_status: "pending" },
    ]);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM settlement_entries WHERE order_id = $1", [body.orderId])).n).toBe(0);
    const events = (await q("SELECT from_status, to_status, reason FROM order_events WHERE order_id = $1 ORDER BY created_at, id", [body.orderId])).rows;
    expect(events).toEqual([
      { from_status: null, to_status: "pending", reason: "checkout_started" },
      { from_status: "pending", to_status: "paid", reason: "0원 바로 확정" },
    ]);
  });

  test("같은 키 재요청 → 200 같은 본문, PG 호출 0회 · 다른 키로 다시 누르면 409 ALREADY_RESERVED", async () => {
    await member("again");
    const key = randomUUID();
    const first = await order("again", bodyFor("free"), { key });
    expect(first.status).toBe(201);
    pgCalls.length = 0;
    const replay = await order("again", bodyFor("free"), { key });
    expect([replay.status, replay.body]).toEqual([200, first.body]);
    const other = await order("again", bodyFor("free"));
    expect([other.status, other.code]).toEqual([409, "ALREADY_RESERVED"]);
    expect(pgCalls).toEqual([]);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE member_id = $1", [memberIds["again"]])).n).toBe(1);
  });

  test("첫 회차 30분 전 가상계좌 — 유료라면 기한(첫 회차 − 60분)이 이미 지나 409 지만, 0원은 기다릴 입금이 없어 바로 확정", async () => {
    // 첫 회차 12/01 20:00 KST(11:00Z)의 30분 전. 유료 가상계좌의 409 CHECKOUT_CLOSED 는 order-create 테스트가 본다
    const soon = Temporal.Instant.from("2026-12-01T10:30:00Z");
    await member("late", { gender: "female" });
    pgCalls.length = 0;
    const res = await order("late", bodyFor("free", { seatKind: "female", method: "virtual_account" }), { now: soon });
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(body.payment).toMatchObject({ method: "virtual_account", status: "paid", amount: 0, virtualAccount: null, cardCheckout: null });
    expect(pgCalls).toEqual([]);
    expect(await one("SELECT status FROM reservations WHERE order_id = $1", [body.orderId])).toEqual({ status: "confirmed" });
  });

  test("대조군 — 유료(120,000원) 수업은 그대로 PG 에 결제를 만들고 pending·held 로 남는다", async () => {
    await member("payer");
    pgCalls.length = 0;
    const res = await order("payer", bodyFor("paid"));
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(body.status).toBe("pending");
    expect(body.payment).toMatchObject({ status: "ready", amount: 120000 });
    expect(pgCalls.filter((name) => name === "createPayment").length).toBeGreaterThan(0);
    expect(await one("SELECT status FROM reservations WHERE order_id = $1", [body.orderId])).toEqual({ status: "held" });
  });
});
