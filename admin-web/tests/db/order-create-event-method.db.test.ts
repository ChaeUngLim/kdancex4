// S3-3.6(이벤트형 카드 요청 거부) — `POST /api/orders` 3단계의 결제수단 검사(계약 03 §1).
//   요구: FR-280(결제수단 결정) · FR-111a(카드 허용 범위) 강제 방법 ② 「서버가 상품 종류를 보고 카드·간편결제 주문 생성을 거부한다
//         (화면을 거치지 않은 요청도 막는다)」
//   verify: 이벤트형(원데이) 수업에 카드·간편결제로 주문을 보내면 422 METHOD_NOT_ALLOWED 로 거부되고
//           주문·예약·결제·자리가 하나도 안 생긴다(S3-3 수용 ① 앞 절반)
//   그리고: 같은 이벤트형에 간편 계좌이체·가상계좌는 받는다 · 정규 수업의 카드는 그대로 받는다(거부가 이벤트형에만 걸린다)
//
// 판정은 S3-3.1 의 isPaymentMethodAllowed(결제 화면·통지 처리와 같은 표)를 주문 생성이 부르는 것이다.
// 준비(직원·학원·수업 등록·회원)는 주문 생성 테스트(order-create.db.test.ts, S3-3.4)와 같은 방식 — 수업은 진짜 등록 경로로 만든다.
// 이름: verify 의 tests/db/s3-3-6.db.test.ts 는 Task 번호 이름이라 기능 이름(order-create-event-method)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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

describe.skipIf(!dbAvailable())("이벤트형 카드·간편결제 주문 거부(계약 03 §1 3단계, S3-3.6)", () => {
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

  const pgStore = createFakePaymentGatewayStore();
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = () => ({
    db: handle.db,
    getSession,
    clock: fixedClock(NOW),
    paymentGateway: new FakePaymentGateway({ store: pgStore, clock: fixedClock(NOW) }),
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
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', 'male', '1995-03-02', '01012345678', $3, '서연', now(), 'dance_sport', now())`,
      [id, userId, `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
    memberIds[key] = id;
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(who: string, offeringKey: string, method: string): Promise<Call> {
    const headers = { authorization: `Bearer ${memberTokens[who]}`, "content-type": "application/json", "Idempotency-Key": randomUUID() };
    const body = { offeringId: offerings[offeringKey], seatKind: "male", method, noticesAcknowledged: true };
    const res = await createOrderRoute(deps())(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  const heldOf = async (offeringKey: string) =>
    (await one<{ held: number }>("SELECT held_count AS held FROM seat_pools WHERE offering_id = $1 AND seat_kind = 'male'", [offerings[offeringKey]])).held;
  /** 이 회원 앞으로 생긴 주문·예약·결제 행 수 */
  const rowsOf = async (memberKey: string) =>
    one<{ orders: number; reservations: number; payments: number }>(
      `SELECT (SELECT count(*)::int FROM orders WHERE member_id = $1) AS orders,
              (SELECT count(*)::int FROM reservations WHERE member_id = $1) AS reservations,
              (SELECT count(*)::int FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.member_id = $1) AS payments`,
      [memberIds[memberKey]],
    );

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
    await makeClass("oneday", {
      classKind: "one_day",
      title: "쌈바 원데이",
      priceAmount: 30000,
      schedule: { kind: "single", date: "2026-12-06", startTime: "14:00", endTime: "16:00" },
      refundDeadlineOn: "2026-12-05",
    });
    await makeClass("regular", {
      classKind: "regular",
      title: "쌈바 정규",
      targetLevel: "entry",
      priceAmount: 120000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: "20:00", endTime: "21:00", periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      refundDeadlineOn: null,
    });
    // 준비가 맞는지: 원데이는 이벤트형 공지가 붙은 이벤트형 수업이다
    const kind = await one<{ class_kind: string; notice_kind: string }>(
      `SELECT c.class_kind::text AS class_kind, n.notice_kind::text AS notice_kind
         FROM class_offerings o JOIN classes c ON c.id = o.class_id JOIN refund_notice_versions n ON n.id = c.refund_notice_version_id
        WHERE o.id = $1`,
      [offerings["oneday"]],
    );
    expect(kind).toEqual({ class_kind: "one_day", notice_kind: "event" });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test.each(["card", "easy_pay"])("① 이벤트형 + %s → 422 METHOD_NOT_ALLOWED, 주문·예약·결제·자리가 하나도 안 생긴다", async (method) => {
    const who = `reject-${method}`;
    await member(who);
    const heldBefore = await heldOf("oneday");
    const pgBefore = pgStore.payments.size;

    const res = await order(who, "oneday", method);

    expect(res.status).toBe(422);
    expect(res.code).toBe("METHOD_NOT_ALLOWED");
    // 어느 칸이 걸렸는지 알려 준다 — 앱이 결제수단 선택으로 돌아가게
    expect(res.body["fields"]).toEqual([{ path: "method", message: "이 수업은 계좌이체(간편 계좌이체·가상계좌)로만 결제할 수 있어요" }]);
    expect(await rowsOf(who)).toEqual({ orders: 0, reservations: 0, payments: 0 });
    expect(await heldOf("oneday")).toBe(heldBefore);
    // PG 에 결제를 만들러 가지도 않는다
    expect(pgStore.payments.size).toBe(pgBefore);
  });

  test.each(["easy_transfer", "virtual_account"])("② 같은 이벤트형에 %s 는 받는다(201)", async (method) => {
    const who = `accept-${method}`;
    await member(who);
    const res = await order(who, "oneday", method);
    expect(res.status).toBe(201);
    const body = orderResponseSchema.parse(res.body);
    expect(body.payment.method).toBe(method);
    expect(await rowsOf(who)).toEqual({ orders: 1, reservations: 1, payments: 1 });
  });

  test("③ 정규 수업의 카드는 그대로 받는다 — 거부는 이벤트형에만 걸린다", async () => {
    await member("regular-card");
    const res = await order("regular-card", "regular", "card");
    expect(res.status).toBe(201);
    expect(orderResponseSchema.parse(res.body).payment.method).toBe("card");
  });
});
