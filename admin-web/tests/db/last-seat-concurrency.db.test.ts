// S3-3.5(마지막 자리 동시성 테스트) — 마지막 자리에 결제 시작(POST /api/orders) 20건이 동시에 와도 held 는 1건이다.
//   수용 ②(S3-3 슬라이스) · SC-005(정원 초과 0건).
//   자리를 잡는 일은 S3-3.4(주문 생성 API)의 조건부 UPDATE
//   (`held_count + confirmed_count < capacity` 일 때만 +1)가 맡는다. 이 파일은 그 한 줄이 정말 동시에 버티는지 본다.
//   서로 다른 회원 20명이 각자 다른 Idempotency-Key 로 같은 판매 단위의 마지막 자리를 동시에 누른다.
//   한 명만 201 을 받고 나머지 19명은 409 SEAT_SOLD_OUT, 진 사람의 주문·예약·결제 행은 하나도 생기지 않아야 한다.
//
// 이름: verify 의 tests/db/s3-3-5.db.test.ts 는 Task 번호 이름이라 기능 이름(last-seat-concurrency)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 수업은 시드로 넣지 않고 주문 생성 테스트(order-create.db.test.ts)와 같이 진짜 등록 경로(대표가 올려 바로 공개)로 만든다.
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
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
// 동시에 누르는 사람 수(verify: 20건)
const RACERS = 20;

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("마지막 자리 동시성(S3-3.5, SC-005 정원 초과 0건)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
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
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [randomUUID(), academyId, JSON.stringify(regularContent), staffIds["owner"]],
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

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24, 120,000원) */
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

  /** 결제를 시작할 수 있는 성인 회원 한 명을 만들고 (토큰, 회원 id) 를 돌려준다 */
  async function member(key: string, gender: "male" | "female"): Promise<{ token: string; id: string }> {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, '1995-03-02', '01012345678', $4, '서연', now(), 'dance_sport', now())`,
      [id, userId, gender, `ci-${randomUUID()}`],
    );
    return { token, id };
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(token: string, offeringKey: string, seatKind: string): Promise<Call> {
    // 회원마다 다른 Idempotency-Key — 같은 키 재시도가 아니라 서로 다른 사람의 진짜 경쟁이다
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() };
    const body = { offeringId: offerings[offeringKey], seatKind, method: "card", noticesAcknowledged: true };
    const res = await createOrderRoute(deps())(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  const seatOf = async (offeringKey: string, seatKind: string) =>
    one<{ held: number; confirmed: number; capacity: number }>(
      "SELECT held_count AS held, confirmed_count AS confirmed, capacity FROM seat_pools WHERE offering_id = $1 AND seat_kind = $2",
      [offerings[offeringKey], seatKind],
    );
  const rowsFor = async (offeringKey: string) =>
    one<{ orders: number; reservations: number; held: number; payments: number }>(
      `SELECT (SELECT count(*)::int FROM orders WHERE offering_id = $1) AS orders,
              (SELECT count(*)::int FROM reservations WHERE offering_id = $1) AS reservations,
              (SELECT count(*)::int FROM reservations WHERE offering_id = $1 AND status = 'held') AS held,
              (SELECT count(*)::int FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.offering_id = $1) AS payments`,
      [offerings[offeringKey]],
    );

  /**
   * 회원 RACERS 명을 먼저 다 만들어 두고, 그다음 한꺼번에 결제를 시작한다.
   * 준비(회원 만들기)를 경쟁 안에 섞지 않아야 요청들이 정말 같은 순간에 자리 UPDATE 로 몰린다.
   */
  async function race(offeringKey: string, seatKind: string, gender: "male" | "female") {
    const racers = await Promise.all(Array.from({ length: RACERS }, (_, i) => member(`${offeringKey}-racer-${i}`, gender)));
    const results = await Promise.all(racers.map((r) => order(r.token, offeringKey, seatKind)));
    return { racers, results };
  }

  beforeAll(async () => {
    // 20건이 동시에 트랜잭션을 열 수 있게 연결을 넉넉히 연다(pg 기본 10이면 풀에서 줄을 서 경쟁이 약해진다)
    handle = openTestDb({ poolMax: RACERS + 5 });
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
    // last-one: 남성 자리 정원 1 = 처음부터 마지막 자리
    await makeClass("last-one", { start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 1, female: 1 } });
    // last-of-three: 통합 정원 3 중 2자리가 이미 나간 상태에서 남은 1자리
    await makeClass("last-of-three", { start: "18:00", end: "19:00", capacity: { mode: "single", any: 3 } });
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test(`정원 1인 남성 자리에 ${RACERS}명이 동시에 결제 시작 → 201 한 건, 나머지 409 SEAT_SOLD_OUT, held 1`, async () => {
    const { racers, results } = await race("last-one", "male", "male");

    // 이긴 사람은 정확히 한 명이다
    const winners = results.filter((r) => r.status === 201);
    const losers = results.filter((r) => r.status !== 201);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(RACERS - 1);
    // 진 사람은 모두 매진 응답 — 500 같은 다른 실패로 빠진 요청이 없어야 한다
    expect(losers.map((r) => [r.status, r.code])).toEqual(Array.from({ length: RACERS - 1 }, () => [409, "SEAT_SOLD_OUT"]));

    // 자리 카운터: held 1, 정원을 넘지 않는다(SC-005)
    const seat = await seatOf("last-one", "male");
    expect(seat).toEqual({ held: 1, confirmed: 0, capacity: 1 });
    // 같은 수업의 여성 자리는 건드리지 않는다
    expect((await seatOf("last-one", "female")).held).toBe(0);

    // 행도 이긴 한 명 몫만 생긴다 — 주문 1 · held 예약 1 · 결제 1
    expect(await rowsFor("last-one")).toEqual({ orders: 1, reservations: 1, held: 1, payments: 1 });
    const winnerOrder = orderResponseSchema.parse(winners[0]!.body);
    const owner = await one<{ member_id: string }>("SELECT member_id::text AS member_id FROM orders WHERE id = $1", [winnerOrder.orderId]);
    const winnerIndex = racers.findIndex((r) => r.id === owner.member_id);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    // 이긴 사람이 받은 응답 = DB 에 남은 그 사람의 주문
    expect(results[winnerIndex]!.status).toBe(201);
  });

  test(`정원 3 중 2자리가 나간 통합 자리 — 마지막 1자리에 ${RACERS}명 동시 → held 는 1건만 늘어 정원 3을 넘지 않는다`, async () => {
    // 먼저 두 명이 차례로 자리를 잡아 남은 자리를 1로 만든다
    for (const i of [0, 1]) {
      const early = await member(`early-${i}`, "female");
      expect((await order(early.token, "last-of-three", "any")).status).toBe(201);
    }
    expect(await seatOf("last-of-three", "any")).toEqual({ held: 2, confirmed: 0, capacity: 3 });

    const { results } = await race("last-of-three", "any", "male");
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.code === "SEAT_SOLD_OUT")).toHaveLength(RACERS - 1);

    const seat = await seatOf("last-of-three", "any");
    expect(seat).toEqual({ held: 3, confirmed: 0, capacity: 3 });
    expect(seat.held + seat.confirmed).toBeLessThanOrEqual(seat.capacity);
    // 앞선 두 명 + 이긴 한 명 = 3
    expect(await rowsFor("last-of-three")).toEqual({ orders: 3, reservations: 3, held: 3, payments: 3 });
  });
});
