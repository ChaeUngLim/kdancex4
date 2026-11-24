// S3-3.4a(사업자 상태 제한 학원은 새 결제 시작 거부) — `POST /api/orders` 3-a단계(계약 03 §1).
//   요구: FR-250(입점 심사·게시 제한)의 사업자 상태 재확인 · FR-254(이용 제한 절차) — 휴·폐업이면 새 결제를 막고 기존 결제분은 그대로
//   verify: 「새 결제 막음」(academy_restrictions.kind = 'new_sales_blocked', ended_at 이 빈 행)이 열린 학원의 주문 생성은
//           409 ACADEMY_RESTRICTED 로 거부되고 주문·예약·결제·자리가 하나도 안 생긴다 · 제한 전에 만든 주문(결제 대기·확정)은 그대로다
//   그리고: 지급 보류(payout_hold)만 열렸거나 끝난 제한은 막지 않는다 · 제한이 끝나면 다시 받는다 · 주문 생성 코드는 국세청 포트를 부르지 않는다
//
// 준비(직원·학원·수업 등록·회원)는 주문 생성 테스트(order-create.db.test.ts, S3-3.4)와 같은 방식이다 — 수업은 진짜 등록 경로로 만든다.
// 이름: verify 의 tests/db/s3-3-4a.db.test.ts 는 Task 번호 이름이라 기능 이름(order-create-sales-block)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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

describe.skipIf(!dbAvailable())("사업자 상태 제한 학원의 새 결제 거부(계약 03 §1 3-a단계, S3-3.4a)", () => {
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
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(order-create 테스트와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
    await makeClass("main", { start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 6, female: 6 } });
    await makeClass("single", { start: "16:00", end: "17:00", capacity: { mode: "single", any: 4 } });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  /** 사업자 점검이 여는 것과 같은 제한 행을 연다(S1-1.28 이 쓰는 칸 그대로). 만든 행 id 를 돌려준다 */
  async function openRestriction(kind: "new_sales_blocked" | "payout_hold" | "listing_suspended"): Promise<string> {
    const row = await one<{ id: string }>(
      "INSERT INTO academy_restrictions (id, academy_id, kind, reason, started_at) VALUES (uuidv7(), $1, $2, 'business_closed', now()) RETURNING id::text AS id",
      [academyId, kind],
    );
    return row.id;
  }
  const endRestriction = (id: string) => q("UPDATE academy_restrictions SET ended_at = now() WHERE id = $1", [id]);

  /** 주문·예약·결제·자리 묶음을 통째로 읽는다 — 제한 전후로 같아야 「기존 결제분은 그대로」다 */
  const snapshot = async () => ({
    orders: (await q("SELECT id::text, status, total_amount, updated_at::text FROM orders ORDER BY id")).rows,
    reservations: (await q("SELECT id::text, order_id::text, status, updated_at::text FROM reservations ORDER BY id")).rows,
    payments: (await q("SELECT id::text, order_id::text, status, amount, due_at::text FROM payments ORDER BY id")).rows,
    orderEvents: (await q("SELECT count(*)::int AS n FROM order_events")).rows,
    seatPools: (await q("SELECT id::text, held_count, confirmed_count FROM seat_pools ORDER BY id")).rows,
  });

  // 제한 전에 결제를 시작한(결제 대기) 회원과 결제를 마친(확정) 회원 — 아래 테스트들이 같은 주문을 본다
  const pendingKey = randomUUID();
  let pendingOrderId = "";
  let paidOrderId = "";

  test("준비 — 제한 없는 학원은 주문을 받는다(결제 대기 1건 · 확정 1건을 만들어 둔다)", async () => {
    await member("pending");
    await member("paid");
    const pending = await order("pending", bodyFor("main"), { key: pendingKey });
    expect(pending.status).toBe(201);
    pendingOrderId = orderResponseSchema.parse(pending.body).orderId;

    const paid = await order("paid", bodyFor("single", { seatKind: "any" }));
    expect(paid.status).toBe(201);
    paidOrderId = orderResponseSchema.parse(paid.body).orderId;
    // 결제 완료 상태로 바꾼다(웹훅 확정 S3-4 가 하는 일을 SQL 로 흉내) — 확정 예약 · 자리 held → confirmed
    await q("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [paidOrderId]);
    await q("UPDATE reservations SET status = 'confirmed' WHERE order_id = $1", [paidOrderId]);
    await q("UPDATE payments SET status = 'paid' WHERE order_id = $1", [paidOrderId]);
    await q("UPDATE seat_pools SET held_count = held_count - 1, confirmed_count = confirmed_count + 1 WHERE offering_id = $1", [offerings["single"]]);
  });

  test("지급 보류(payout_hold)만 열렸거나 끝난 「새 결제 막음」은 새 주문을 막지 않는다", async () => {
    const hold = await openRestriction("payout_hold");
    const ended = await openRestriction("new_sales_blocked");
    await endRestriction(ended);
    await member("allowed");
    const res = await order("allowed", bodyFor("main"));
    expect(res.status).toBe(201);
    await endRestriction(hold);
  });

  test("verify ① 「새 결제 막음」이 열린 학원 — 409 ACADEMY_RESTRICTED(reason new_sales_blocked), 주문·예약·결제·자리 행이 안 생긴다", async () => {
    const before = await snapshot();
    await openRestriction("new_sales_blocked");
    await member("blocked");
    for (const extra of [{}, { method: "virtual_account" }]) {
      const res = await order("blocked", bodyFor("main", extra));
      expect([res.status, res.code, res.body["reason"]]).toEqual([409, "ACADEMY_RESTRICTED", "new_sales_blocked"]);
      expect(res.body["detail"]).toBe("지금은 이 학원의 새 신청을 받을 수 없어요");
    }
    // 자리 묶음 방식이 다른 수업(single)도 같은 학원이면 똑같이 막힌다
    const single = await order("blocked", bodyFor("single", { seatKind: "any" }));
    expect([single.status, single.code]).toEqual([409, "ACADEMY_RESTRICTED"]);
    expect([await countOf("orders", "blocked"), await countOf("reservations", "blocked"), await countOf("payments", "blocked")]).toEqual([0, 0, 0]);
    expect(await snapshot()).toEqual(before);
  });

  test("verify ② 제한 중에도 기존 주문은 그대로 — 같은 키 재요청·다시 누르기(M-04)는 그 결제 대기를 돌려주고, 확정은 409 ALREADY_RESERVED", async () => {
    const before = await snapshot();
    const again = await order("pending", bodyFor("main"), { key: pendingKey });
    expect(again.status).toBe(200);
    expect(orderResponseSchema.parse(again.body)).toMatchObject({ orderId: pendingOrderId, status: "pending" });
    const reopen = await order("pending", bodyFor("main"));
    expect(reopen.status).toBe(200);
    expect(orderResponseSchema.parse(reopen.body).orderId).toBe(pendingOrderId);
    const paidAgain = await order("paid", bodyFor("single", { seatKind: "any" }));
    expect([paidAgain.status, paidAgain.code]).toEqual([409, "ALREADY_RESERVED"]);

    expect(await snapshot()).toEqual(before);
    expect(await one("SELECT status FROM orders WHERE id = $1", [paidOrderId])).toEqual({ status: "paid" });
    expect(await one("SELECT status FROM reservations WHERE order_id = $1", [paidOrderId])).toEqual({ status: "confirmed" });
    expect(await one("SELECT status FROM payments WHERE order_id = $1", [pendingOrderId])).toEqual({ status: "ready" });
  });

  test("제한이 끝나면(ended_at 기록) 다시 새 주문을 받는다", async () => {
    await q("UPDATE academy_restrictions SET ended_at = now() WHERE academy_id = $1 AND kind = 'new_sales_blocked' AND ended_at IS NULL", [academyId]);
    const res = await order("blocked", bodyFor("main"));
    expect(res.status).toBe(201);
    expect(await countOf("orders", "blocked")).toBe(1);
  });

  test("주문 생성 경로는 국세청 사업자 상태 포트를 부르지 않는다 — DB 의 열린 제한 행만 읽는다", () => {
    const source = readFileSync(new URL("../../lib/server/services/order-create.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/business-status|BusinessStatus/);
    expect(source).toMatch(/academy_restrictions[\s\S]*new_sales_blocked|SALES_BLOCKED_REASON/);
  });
});
