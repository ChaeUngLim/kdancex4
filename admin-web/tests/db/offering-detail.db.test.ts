// S3-2.3(수업 상세 API) — `GET /api/offerings/{offeringId}`(계약 02 §2).
//   verify: 결제 대기 1건이 있어도 신청 인원에 안 들어간다(플랜 S3-2 수용 ②) — 신청 인원 = confirmed_count 만
//   그리고: 자리 묶음별 정원·신청 인원·잔여(성별 정원과 단일 정원 둘 다), 기본 자리(AC-7 — 같은 성별, 마감이어도 안 바꿈,
//           단일 정원은 any 하나), 예정 회차만 순서대로, 승인 전·게시 제한·노출 중지 학원 수업은 404, 회원만(401 · 403)
//
// 수업은 시드로 넣지 않는다 — 홈 목록 테스트(S3-2.1)와 같이 진짜 등록 경로(S2-2.3 POST /api/classes → submit/approve)로 만든다.
// 결제 대기·확정 예약은 주문 생성 경로(S3-3.4)가 아직 없어, 그 경로가 한 트랜잭션에서 남길 행(주문 · 예약 · 자리 카운터 +1)을
// 데이터 모델 §4-4 그대로 SQL 로 적는다.
//
// 이름: verify 의 tests/db/s3-2-3.db.test.ts 는 Task 번호 이름이라 기능 이름(offering-detail)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createHomeOfferingsRoute, homeOfferingsResponseSchema } from "@/lib/server/services/home-offerings";
import { createOfferingDetailRoute, offeringDetailSchema } from "@/lib/server/services/offering-detail";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("수업 상세 API(계약 02 §2, S3-2.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const staffDeps = () => ({ db: handle.db, getSession, clock: fixedClock(NOW) });
  const staffHeaders = (who: string) => ({ authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" });

  // ---- 바닥(앞 Task 들이 만든 것과 같은 행) -------------------------------------------------------------

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.toLowerCase().replace(/[^a-z0-9]/g, "_")}`, displayUsername: key },
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

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyIds[key], JSON.stringify(regularContent), staffIds["owner"]],
    );
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[key], staffIds["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  // ---- S2-2 경로로 수업 만들기(정규 · 화·목 12/01~12/24 = 8회차) -------------------------------------------

  const reg = () => createClassRegistrationRoutes(staffDeps());

  /** draft = 임시 저장만 · pending = 강사가 승인 요청 · approved = 강사 요청 → 대표 승인 · owner = 대표가 올려 바로 공개 */
  async function makeClass(
    key: string,
    o: { academy: string; start: string; end: string; capacity: Capacity; stage: "draft" | "pending" | "approved" | "owner" },
  ) {
    const writer = o.stage === "owner" ? "owner" : "junho";
    const body = {
      academyId: academyIds[o.academy],
      classKind: "regular",
      title: `수업 ${key}`,
      subGenre: "latin",
      discipline: "samba",
      targetLevel: "entry",
      targetAges: ["all"],
      roomId: roomIds[o.academy],
      priceAmount: 120000,
      schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: o.start, endTime: o.end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
      capacity: o.capacity,
      refundDeadlineOn: null,
      introText: null,
      instructorAccountId: o.stage === "owner" ? staffIds["junho"] : null,
    };
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...staffHeaders(writer), "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    if (o.stage !== "draft") {
      const submitted = await reg().submit(
        new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: staffHeaders(writer), body: "{}" }),
        { params: Promise.resolve({ classId }) },
      );
      expect(submitted.status).toBe(200);
    }
    if (o.stage === "approved") {
      const academyId = academyIds[o.academy] ?? "";
      const approved = await createClassApprovalRoutes(staffDeps()).approve(
        new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: staffHeaders("owner"), body: "{}" }),
        { params: Promise.resolve({ academyId, classId }) },
      );
      expect(approved.status).toBe(200);
    }
    // 임시 저장은 판매 단위가 없다 — 없는 수업 id 대신 수업 id 자체를 넣어 「아무 id」로 404 를 본다
    const { rows } = await q("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    offerings[key] = (rows[0] as { id: string } | undefined)?.id ?? classId;
  }

  // ---- 회원 · 결제 대기 / 확정 예약 ---------------------------------------------------------------------

  async function member(key: string, gender: "male" | "female"): Promise<string> {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, '1995-03-02', '01012345678', $4, '서연', now(), 'dance_sport', now())`,
      [memberId, userId, gender, `ci-${randomUUID()}`],
    );
    memberIds[key] = memberId;
    return token;
  }

  /**
   * 주문 생성(S3-3.4)과 웹훅 확정(S3-3.9)이 남길 행을 그대로 적는다(data-model §4-4).
   *   pending  = 주문 pending + 예약 held + held_count +1(결제 대기)
   *   paid     = 주문 paid + 예약 confirmed + confirmed_count +1(확정)
   * 자리 카운터는 §4-4 의 조건부 UPDATE 와 같은 문장이라 정원을 넘기면 0행 = 실패한다.
   */
  async function reserve(offeringKey: string, memberKey: string, seatKind: "male" | "female" | "any", state: "pending" | "paid") {
    const offeringId = offerings[offeringKey];
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      const pool = await client.query(
        state === "pending"
          ? "UPDATE seat_pools SET held_count = held_count + 1 WHERE offering_id = $1 AND seat_kind = $2 AND held_count + confirmed_count < capacity RETURNING id"
          : "UPDATE seat_pools SET confirmed_count = confirmed_count + 1 WHERE offering_id = $1 AND seat_kind = $2 AND held_count + confirmed_count < capacity RETURNING id",
        [offeringId, seatKind],
      );
      expect(pool.rowCount).toBe(1);
      const notice = await client.query(
        "SELECT c.refund_notice_version_id AS id FROM class_offerings o JOIN classes c ON c.id = o.class_id WHERE o.id = $1",
        [offeringId],
      );
      const orderId = randomUUID();
      const breakdown = [
        { kind: "list_price", label: "정가", amount: 120000 },
        { kind: "benefit_discount", label: "혜택 할인", amount: 0 },
        { kind: "coupon_discount", label: "쿠폰 할인", amount: 0 },
        { kind: "final", label: "최종 결제액", amount: 120000 },
      ];
      await client.query(
        `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                             intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                             cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
         VALUES ($1, $2, $3, $4, 120000, 120000, $5, $6, '2026-11-06', 'm-1', 'mt-1', 0, 5000, $7, $8, now(), ${orderSnapshotValuesSql("$3")})`,
        [orderId, memberIds[memberKey], offeringId, state, JSON.stringify(breakdown), (notice.rows[0] as { id: string }).id, randomUUID(), state === "paid" ? NOW.toString() : null],
      );
      await client.query(
        `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
         VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, now())`,
        [orderId, offeringId, (pool.rows[0] as { id: string }).id, seatKind, memberIds[memberKey], state === "pending" ? "held" : "confirmed"],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function detail(token: string | null, offeringId: string) {
    const headers: Record<string, string> = {};
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const res = await createOfferingDetailRoute({ db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }) })(
      new Request(`${BASE}/api/offerings/${offeringId}`, { headers }),
      { params: Promise.resolve({ offeringId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  async function detailOk(token: string, key: string) {
    const res = await detail(token, offerings[key] ?? "");
    expect(res.status).toBe(200);
    return offeringDetailSchema.parse(res.body);
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy("A");
    await makeAcademy("R"); // 공개 뒤 게시 제한(restricted)
    await makeAcademy("S"); // 공개 뒤 노출 중지(listing_suspended)

    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다
    await makeClass("split", { academy: "A", start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 2, female: 3 }, stage: "owner" });
    await makeClass("single", { academy: "A", start: "18:00", end: "19:00", capacity: { mode: "single", any: 4 }, stage: "approved" });
    await makeClass("pending", { academy: "A", start: "10:00", end: "11:00", capacity: { mode: "gender_split", male: 2, female: 2 }, stage: "pending" });
    await makeClass("draft", { academy: "A", start: "12:00", end: "13:00", capacity: { mode: "gender_split", male: 2, female: 2 }, stage: "draft" });
    await makeClass("restricted", { academy: "R", start: "14:00", end: "15:00", capacity: { mode: "single", any: 4 }, stage: "owner" });
    await makeClass("suspended", { academy: "S", start: "16:00", end: "17:00", capacity: { mode: "single", any: 4 }, stage: "owner" });
    await q("UPDATE academies SET status = 'restricted' WHERE id = $1", [academyIds["R"]]);
    await q(
      "INSERT INTO academy_restrictions (id, academy_id, kind, reason, started_at) VALUES (uuidv7(), $1, 'listing_suspended', '폐업 확인 뒤 노출 중지', now())",
      [academyIds["S"]],
    );
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify: 결제 대기 1건이 있어도 신청 인원에 안 들어간다 — 신청 인원은 확정만, 잔여는 결제 대기까지 뺀다(수용 ②)", async () => {
    const token = await member("viewer", "female");
    await member("buyer-held", "male");
    await member("buyer-paid", "female");
    expect((await detailOk(token, "split")).capacity).toEqual({
      total: 5,
      enrolled: 0,
      pools: [
        { seatKind: "male", capacity: 2, enrolled: 0, remaining: 2 },
        { seatKind: "female", capacity: 3, enrolled: 0, remaining: 3 },
      ],
    });

    // 결제 대기 1건(남성 자리) — 신청 인원은 그대로 0, 남성 잔여만 2 → 1
    await reserve("split", "buyer-held", "male", "pending");
    const afterHeld = await detailOk(token, "split");
    expect(afterHeld.capacity.enrolled).toBe(0);
    expect(afterHeld.capacity.pools).toEqual([
      { seatKind: "male", capacity: 2, enrolled: 0, remaining: 1 },
      { seatKind: "female", capacity: 3, enrolled: 0, remaining: 3 },
    ]);

    // 확정 1건(여성 자리) — 이건 신청 인원 1 이 된다
    await reserve("split", "buyer-paid", "female", "paid");
    const afterPaid = await detailOk(token, "split");
    expect(afterPaid.capacity).toEqual({
      total: 5,
      enrolled: 1,
      pools: [
        { seatKind: "male", capacity: 2, enrolled: 0, remaining: 1 },
        { seatKind: "female", capacity: 3, enrolled: 1, remaining: 2 },
      ],
    });

    // 홈 목록(S3-2.1)도 같은 숫자를 낸다 — 두 화면이 같은 함수로 센다
    const home = await createHomeOfferingsRoute({ db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }) })(
      new Request(`${BASE}/api/home/offerings`, { headers: { authorization: `Bearer ${token}` } }),
      {},
    );
    const card = homeOfferingsResponseSchema.parse(await home.json()).items.find((i) => i.offeringId === offerings["split"]);
    expect(card?.capacity).toEqual(afterPaid.capacity);
  });

  test("응답 모양(계약 02 §2) — 수업·학원·강사·회차 8개(예정만, 순서대로)·가격·자리 방식", async () => {
    const token = await member("shape", "male");
    const body = await detailOk(token, "split");
    expect(body).toMatchObject({
      offeringId: offerings["split"],
      title: "수업 split",
      academy: { id: academyIds["A"], name: "학원 A", regionSido: "서울", regionGu: "강남구" },
      instructorName: "직원 junho",
      priceAmount: 120000,
      seatMode: "gender_split",
    });
    expect(body.sessions).toHaveLength(8);
    expect(body.sessions.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.sessions[0]).toEqual({ seq: 1, startsAt: "2026-12-01T11:00:00.000000Z", endsAt: "2026-12-01T12:00:00.000000Z" });

    // 휴강한 회차는 목록에서 빠진다(신청할 대상이 아니다)
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now() WHERE offering_id = $1 AND seq = 3", [offerings["split"]]);
    expect((await detailOk(token, "split")).sessions.map((s) => s.seq)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    await q("UPDATE class_sessions SET status = 'scheduled', cancelled_at = NULL WHERE offering_id = $1 AND seq = 3", [offerings["split"]]);
  });

  test("성별 정원 기본 자리(AC-7) — 회원과 같은 성별, 그 자리가 마감이어도 기본은 바꾸지 않고 SOLD_OUT 으로 표시", async () => {
    const man = await member("man", "male");
    const woman = await member("woman", "female");
    expect((await detailOk(woman, "split")).seatSelection).toEqual({
      defaultSeatKind: "female",
      options: [
        { seatKind: "male", available: true },
        { seatKind: "female", available: true },
      ],
    });

    // 남성 자리 2개를 마저 채운다(결제 대기 1 + 확정 1) — 남은 자리 0
    await member("buyer-male2", "male");
    await reserve("split", "buyer-male2", "male", "paid");
    expect((await detailOk(man, "split")).seatSelection).toEqual({
      defaultSeatKind: "male",
      options: [
        { seatKind: "male", available: false, reason: "SOLD_OUT" },
        { seatKind: "female", available: true },
      ],
    });
  });

  test("단일 정원(FR-092c) — 자리 묶음 any 하나, 성별과 상관없이 기본 자리 any, 결제 대기는 신청 인원에 안 든다", async () => {
    const man = await member("single-man", "male");
    const woman = await member("single-woman", "female");
    await member("single-held", "male");
    await reserve("single", "single-held", "any", "pending");
    for (const token of [man, woman]) {
      const body = await detailOk(token, "single");
      expect(body.seatMode).toBe("single");
      expect(body.capacity).toEqual({ total: 4, enrolled: 0, pools: [{ seatKind: "any", capacity: 4, enrolled: 0, remaining: 3 }] });
      expect(body.seatSelection).toEqual({ defaultSeatKind: "any", options: [{ seatKind: "any", available: true }] });
    }
  });

  test("보여도 되는 수업만 — 승인 대기·임시 저장·게시 제한·노출 중지 학원의 수업, 없는 id, 모양이 틀린 id 는 404 NOT_FOUND", async () => {
    const token = await member("hidden", "female");
    for (const key of ["pending", "draft", "restricted", "suspended"]) {
      const res = await detail(token, offerings[key] ?? "");
      expect([key, res.status, res.code]).toEqual([key, 404, "NOT_FOUND"]);
    }
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const res = await detail(token, id);
      expect([res.status, res.code]).toEqual([404, "NOT_FOUND"]);
    }
  });

  test("회원만 — 세션 없음 401, 로그인했지만 가입 전 403 SIGNUP_INCOMPLETE", async () => {
    expect((await detail(null, offerings["split"] ?? "")).status).toBe(401);
    const { token } = await loggedInUser("not-member");
    const res = await detail(token, offerings["split"] ?? "");
    expect([res.status, res.code]).toEqual([403, "SIGNUP_INCOMPLETE"]);
  });
});
