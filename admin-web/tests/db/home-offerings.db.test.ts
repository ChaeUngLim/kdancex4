// S3-2.1(홈 목록 API) — `GET /api/home/offerings`(계약 02 §1).
//   verify ① 기준 장르가 없으면 409 BASE_GENRE_REQUIRED(플랜 S3-2 수용 ①)
//   verify ③ 승인 전(임시 저장·승인 대기) 수업과 게시 제한·해지·노출 중지 학원의 수업은 0건(플랜 S3-2 수용 ③)
//   그리고: 기준 장르·관심 지역·가능 시간대로 거른다(지역·시간대가 비면 조건 없음), 신청 인원은 확정만 센다(수용 ②),
//           날짜 범위, 이미 시작한 판매 단위 제외, 첫 회차 순 정렬과 커서 페이지, 세션 없음 401 · 가입 전 403, 모르는 쿼리 422
//
// 수업은 시드로 넣지 않는다(method 「시드가 아니라 S2-2 가 게시한 수업을 읽는다」). 진짜 수업 등록 경로(S2-2.3 POST /api/classes)
// → 승인 요청(S2-2 submit, 대표가 올리면 바로 공개) 또는 대표 승인(S2-2 approve)을 거친 판매 단위·회차·자리 묶음을 그대로 읽는다.
// 손으로 넣는 것은 그 앞 단계의 바닥(대표·강사 계정, 학원·홀·환불 공지 판본, 소속)과 회원 행뿐이다.
//
// 이름: verify 의 tests/db/s3-2-1.db.test.ts 는 Task 번호 이름이라 기능 이름(home-offerings)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createHomeOfferingsRoute, homeOfferingsResponseSchema } from "@/lib/server/services/home-offerings";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업 경로·홈 목록의 시계. 12월 수업(12/01~12/24)이 모두 이 시각 뒤다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

describe.skipIf(!dbAvailable())("홈 목록 API(계약 02 §1, S3-2.1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  /** 수업 이름표 → { 수업 id, 판매 단위 id } */
  const classes: Record<string, { classId: string; offeringId: string }> = {};

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

  async function makeStaff(key: string, role: "owner" | "instructor", genre?: string) {
    const { token, userId } = await loggedInUser(key);
    tokens[key] = token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, `직원 ${key}`]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())", [id, genre]);
    }
    staffIds[key] = id;
  }

  /** 승인된 학원(학원 행이 있다 = 입점 승인됨) + 지점 + 홀 + 정규 환불 공지 판본 */
  async function makeAcademy(key: string, sido: string, gu: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, $3, $4, 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`, sido, gu],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', $3, $4, now())",
      [branch, academyIds[key], sido, gu],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지 v1', $2, $3)",
      [academyIds[key], JSON.stringify(regularContent), staffIds["owner"]],
    );
  }

  /** active 소속 + 앱 수업 등록 위임(class_submit) */
  async function affiliate(academy: string, instructor: string) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  // ---- S2-2 경로로 수업 만들기 --------------------------------------------------------------------------

  const reg = () => createClassRegistrationRoutes(staffDeps());

  /** 정규 과정 — 화·목 12/01~12/24 = 8회차. 대표가 올리면 instructorAccountId 로 담당 강사를 고른다 */
  const regularBody = (academy: string, instructor: string, title: string, startTime: string, endTime: string, asOwner: boolean) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title,
    subGenre: instructor === "salsa" ? "salsa" : "latin",
    discipline: instructor === "salsa" ? null : "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 120000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
    instructorAccountId: asOwner ? staffIds[instructor] : null,
  });

  /**
   * 수업 하나를 원하는 단계까지 만든다.
   *   draft = 임시 저장만 · pending = 강사가 승인 요청 · approved = 강사 요청 → 대표 승인 · owner = 대표가 올려 바로 공개
   */
  async function makeClass(
    key: string,
    o: { academy: string; instructor: string; start: string; end: string; stage: "draft" | "pending" | "approved" | "owner" },
  ) {
    const writer = o.stage === "owner" ? "owner" : o.instructor;
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...staffHeaders(writer), "Idempotency-Key": randomUUID() },
        body: JSON.stringify(regularBody(o.academy, o.instructor, `수업 ${key}`, o.start, o.end, o.stage === "owner")),
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
    const { rows } = await q("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    classes[key] = { classId, offeringId: (rows[0] as { id: string } | undefined)?.id ?? "" };
  }

  // ---- 회원 ---------------------------------------------------------------------------------------------

  /** 가입을 마친 회원(S3-1.2 결과와 같은 행). 취향은 S3-1.5 의 칸에 바로 적는다 */
  async function member(
    key: string,
    o: { baseGenre: string | null; baseSubGenre?: string; regions?: [string, string][]; window?: [string, string] },
  ): Promise<string> {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                            base_genre, base_sub_genre, available_from, available_to, updated_at)
       VALUES ($1, $2, '김회원', 'female', '1995-03-02', '01012345678', $3, '서연', now(), $4, $7, $5::time, $6::time, now())`,
      [memberId, userId, `ci-${randomUUID()}`, o.baseGenre, o.window?.[0] ?? null, o.window?.[1] ?? null, o.baseSubGenre ?? null],
    );
    for (const [sido, gu] of o.regions ?? []) {
      await q("INSERT INTO member_regions (member_id, region_sido, region_gu) VALUES ($1, $2, $3)", [memberId, sido, gu]);
    }
    return token;
  }

  async function home(token: string | null, query = "", at: Temporal.Instant = NOW) {
    const headers: Record<string, string> = {};
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const res = await createHomeOfferingsRoute({ db: handle.db, getSession, clock: fixedClock(at), paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }) })(
      new Request(`${BASE}/api/home/offerings${query}`, { headers }),
      {},
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  /** 200 응답을 계약 스키마로 parse 하고, 나온 수업 이름표를 순서대로 돌려준다 */
  async function homeKeys(token: string, query = "", at: Temporal.Instant = NOW) {
    const res = await home(token, query, at);
    expect(res.status).toBe(200);
    const parsed = homeOfferingsResponseSchema.parse(res.body);
    const byOffering = Object.fromEntries(Object.entries(classes).map(([k, v]) => [v.offeringId, k]));
    return { keys: parsed.items.map((i) => byOffering[i.offeringId] ?? "?"), parsed };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor", "dance_sport");
    await makeStaff("mina", "instructor", "dance_sport");
    await makeStaff("salsa", "instructor", "salsa_bachata");
    await makeAcademy("A", "서울", "강남구");
    await makeAcademy("B", "서울", "마포구");
    await makeAcademy("R", "서울", "강남구"); // 공개 뒤 게시 제한(restricted)으로 바꾼다
    await makeAcademy("T", "서울", "강남구"); // 공개 뒤 입점 해지(terminated)로 바꾼다
    await makeAcademy("S", "서울", "강남구"); // 공개 뒤 노출 중지(listing_suspended)를 연다
    for (const a of ["A", "B", "R", "T", "S"]) {
      await affiliate(a, "junho");
      await affiliate(a, "mina");
    }
    await affiliate("A", "salsa");

    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다
    await makeClass("A_evening", { academy: "A", instructor: "junho", start: "20:30", end: "21:30", stage: "owner" });
    await makeClass("B_early", { academy: "B", instructor: "junho", start: "18:00", end: "19:00", stage: "approved" });
    await makeClass("A_salsa", { academy: "A", instructor: "salsa", start: "19:00", end: "20:00", stage: "owner" });
    await makeClass("A_pending", { academy: "A", instructor: "mina", start: "10:00", end: "11:00", stage: "pending" });
    await makeClass("A_draft", { academy: "A", instructor: "mina", start: "12:00", end: "13:00", stage: "draft" });
    await makeClass("R_pub", { academy: "R", instructor: "mina", start: "14:00", end: "15:00", stage: "owner" });
    await makeClass("T_pub", { academy: "T", instructor: "mina", start: "16:00", end: "17:00", stage: "owner" });
    await makeClass("S_pub", { academy: "S", instructor: "mina", start: "08:00", end: "09:00", stage: "owner" });

    // 공개된 뒤 학원 쪽에 생긴 일 — 운영자 조치·사업자 점검이 만드는 상태를 그대로 적는다
    await q("UPDATE academies SET status = 'restricted' WHERE id = $1", [academyIds["R"]]);
    await q("UPDATE academies SET status = 'terminated' WHERE id = $1", [academyIds["T"]]);
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

  test("바닥 확인: S2-2 경로가 만든 상태 — 공개 6 · 승인 대기 1 · 임시 저장 1, 공개 수업만 판매 단위가 열려 있다", async () => {
    const { rows } = await q(
      `SELECT c.status, count(*)::int AS n, count(*) FILTER (WHERE o.status = 'open')::int AS open
       FROM classes c LEFT JOIN class_offerings o ON o.class_id = c.id GROUP BY c.status ORDER BY c.status`,
    );
    expect(rows).toEqual([
      { status: "draft", n: 1, open: 0 },
      { status: "pending_approval", n: 1, open: 0 },
      { status: "published", n: 6, open: 6 },
    ]);
  });

  test("verify ①: 기준 장르가 없으면 409 BASE_GENRE_REQUIRED — 관심 지역·시간대가 있어도 목록을 주지 않는다", async () => {
    const token = await member("nobase", { baseGenre: null, regions: [["서울", "강남구"]], window: ["18:00", "22:00"] });
    const res = await home(token);
    expect(res.status).toBe(409);
    expect(res.code).toBe("BASE_GENRE_REQUIRED");
    expect(res.body["items"]).toBeUndefined();
  });

  test("verify ③: 승인 전(임시 저장·승인 대기) 수업과 게시 제한·해지·노출 중지 학원의 수업은 0건", async () => {
    const token = await member("all", { baseGenre: "dance_sport" });
    const { keys } = await homeKeys(token);
    for (const hidden of ["A_pending", "A_draft", "R_pub", "T_pub", "S_pub"]) expect(keys).not.toContain(hidden);
    // 조건이 장르뿐이면 활성 학원의 댄스스포츠 공개 수업 둘만 남는다(첫 회차 시작 순: 18:00 → 20:30)
    expect(keys).toEqual(["B_early", "A_evening"]);

    // 노출 중지가 끝나면(ended_at) 다시 보인다 — 끝나지 않은 제한만 막는다
    await q("UPDATE academy_restrictions SET ended_at = now() WHERE academy_id = $1", [academyIds["S"]]);
    expect((await homeKeys(token)).keys).toEqual(["S_pub", "B_early", "A_evening"]);
    await q("UPDATE academy_restrictions SET ended_at = NULL WHERE academy_id = $1", [academyIds["S"]]);
  });

  test("기준 장르로 거른다 — 살사·바차타 회원에게는 살사 수업만", async () => {
    const token = await member("salsa-fan", { baseGenre: "salsa_bachata" });
    expect((await homeKeys(token)).keys).toEqual(["A_salsa"]);
  });

  // FR-022a(첫 화면 장르 선택·유지) — 세부 장르가 정해져 있으면 classes.sub_genre 가 같은 수업만(AC-3). 「전체」(null)는 장르 전체
  test("세부 장르로 거른다 — 라틴만 고른 회원에게는 라틴 수업만, 스탠다드만 고르면 스탠다드만, 전체면 둘 다", async () => {
    // 바닥의 댄스스포츠 수업은 모두 라틴이라, 이 테스트 동안만 B_early 를 스탠다드(왈츠)로 바꿔 둔다
    const bEarly = classes["B_early"]?.classId ?? "";
    await q("UPDATE classes SET sub_genre = 'standard', discipline = 'waltz' WHERE id = $1", [bEarly]);
    try {
      const latin = await member("latin-fan", { baseGenre: "dance_sport", baseSubGenre: "latin" });
      expect((await homeKeys(latin)).keys).toEqual(["A_evening"]);
      const standard = await member("standard-fan", { baseGenre: "dance_sport", baseSubGenre: "standard" });
      expect((await homeKeys(standard)).keys).toEqual(["B_early"]);
      const all = await member("ds-all", { baseGenre: "dance_sport" });
      expect((await homeKeys(all)).keys).toEqual(["B_early", "A_evening"]);
    } finally {
      await q("UPDATE classes SET sub_genre = 'latin', discipline = 'samba' WHERE id = $1", [bEarly]);
    }
  });

  test("관심 지역으로 거른다 — 마포구만 고른 회원에게는 마포구 학원 수업만, 시·구가 둘 다 맞아야 한다", async () => {
    const mapo = await member("mapo", { baseGenre: "dance_sport", regions: [["서울", "마포구"]] });
    expect((await homeKeys(mapo)).keys).toEqual(["B_early"]);
    const both = await member("both", { baseGenre: "dance_sport", regions: [["서울", "마포구"], ["서울", "강남구"]] });
    expect((await homeKeys(both)).keys).toEqual(["B_early", "A_evening"]);
    const elsewhere = await member("busan", { baseGenre: "dance_sport", regions: [["부산", "강남구"]] });
    expect((await homeKeys(elsewhere)).keys).toEqual([]);
  });

  test("가능 시간대로 거른다 — 모든 회차가 [from, to] 안(양 끝 포함)일 때만", async () => {
    const early = await member("early", { baseGenre: "dance_sport", window: ["17:00", "20:00"] });
    expect((await homeKeys(early)).keys).toEqual(["B_early"]);
    const exact = await member("exact", { baseGenre: "dance_sport", window: ["20:30", "21:30"] });
    expect((await homeKeys(exact)).keys).toEqual(["A_evening"]);
    const late = await member("late", { baseGenre: "dance_sport", window: ["21:00", "23:00"] });
    expect((await homeKeys(late)).keys).toEqual([]);
  });

  test("한 회차라도 시간대 밖이면 빠진다 — 회차 하나를 22:00 으로 옮기면 그 판매 단위가 사라진다", async () => {
    const token = await member("one-off", { baseGenre: "dance_sport", window: ["20:00", "22:00"] });
    expect((await homeKeys(token)).keys).toEqual(["A_evening"]);
    const offeringId = classes["A_evening"]?.offeringId;
    await q(
      "UPDATE class_sessions SET starts_at = starts_at + interval '90 minutes', ends_at = ends_at + interval '90 minutes' WHERE offering_id = $1 AND seq = 8",
      [offeringId],
    );
    expect((await homeKeys(token)).keys).toEqual([]);
    await q(
      "UPDATE class_sessions SET starts_at = starts_at - interval '90 minutes', ends_at = ends_at - interval '90 minutes' WHERE offering_id = $1 AND seq = 8",
      [offeringId],
    );
  });

  test("응답 모양(계약 02 §1) — 신청 인원은 확정만 세고, 남은 자리는 결제 대기까지 뺀다", async () => {
    const offeringId = classes["A_evening"]?.offeringId;
    await q("UPDATE seat_pools SET held_count = 2, confirmed_count = 1 WHERE offering_id = $1 AND seat_kind = 'male'", [offeringId]);
    const token = await member("shape", { baseGenre: "dance_sport", regions: [["서울", "강남구"]] });
    const { parsed } = await homeKeys(token);
    expect(parsed.items).toHaveLength(1);
    const item = parsed.items[0];
    expect(item).toMatchObject({
      offeringId,
      classId: classes["A_evening"]?.classId,
      title: "수업 A_evening",
      genre: "dance_sport",
      classKind: "regular",
      academy: { id: academyIds["A"], name: "학원 A", regionSido: "서울", regionGu: "강남구" },
      enrollmentUnit: "term",
      sessionCount: 8,
      firstSessionStartsAt: "2026-12-01T11:30:00.000000Z", // 12/01(화) 20:30 KST
      lastSessionEndsAt: "2026-12-24T12:30:00.000000Z", // 12/24(목) 21:30 KST
      priceAmount: 120000,
      capacity: {
        total: 12,
        enrolled: 1,
        pools: [
          { seatKind: "male", capacity: 6, enrolled: 1, remaining: 3 },
          { seatKind: "female", capacity: 6, enrolled: 0, remaining: 6 },
        ],
      },
    });
    expect(parsed.nextCursor).toBeNull();
    await q("UPDATE seat_pools SET held_count = 0, confirmed_count = 0 WHERE offering_id = $1", [offeringId]);
  });

  test("정원이 다 찬 수업도 목록에 남는다(마감 표시는 앱이 remaining 으로)", async () => {
    const offeringId = classes["B_early"]?.offeringId;
    await q("UPDATE seat_pools SET confirmed_count = capacity WHERE offering_id = $1", [offeringId]);
    const token = await member("full", { baseGenre: "dance_sport", regions: [["서울", "마포구"]] });
    const { parsed } = await homeKeys(token);
    expect(parsed.items.map((i) => i.capacity.pools.map((p) => p.remaining))).toEqual([[0, 0]]);
    await q("UPDATE seat_pools SET confirmed_count = 0 WHERE offering_id = $1", [offeringId]);
  });

  test("날짜 범위와 「지금 이후」 — 첫 회차가 범위 안이고 아직 시작하지 않은 판매 단위만", async () => {
    const token = await member("dates", { baseGenre: "dance_sport" });
    expect((await homeKeys(token, "?from=2026-12-01&to=2026-12-01")).keys).toEqual(["B_early", "A_evening"]);
    expect((await homeKeys(token, "?from=2026-12-02")).keys).toEqual([]);
    expect((await homeKeys(token, "?to=2026-11-30")).keys).toEqual([]);
    // 12/01 19:30 KST — 18:00 에 시작한 B_early 는 이미 시작했고, 20:30 의 A_evening 은 아직이다
    expect((await homeKeys(token, "", Temporal.Instant.from("2026-12-01T10:30:00Z"))).keys).toEqual(["A_evening"]);
  });

  test("커서 페이지 — limit=1 로 두 쪽에 나눠 받으면 겹치거나 빠지는 행이 없다", async () => {
    const token = await member("pages", { baseGenre: "dance_sport" });
    const first = await homeKeys(token, "?limit=1");
    expect(first.keys).toEqual(["B_early"]);
    expect(first.parsed.nextCursor).not.toBeNull();
    const second = await homeKeys(token, `?limit=1&cursor=${first.parsed.nextCursor}`);
    expect(second.keys).toEqual(["A_evening"]);
    expect(second.parsed.nextCursor).toBeNull();
  });

  test("잘못된 쿼리는 422 VALIDATION_FAILED — limit 범위 밖 · 고친 커서 · 모르는 키(장르를 쿼리로 바꿔 끼우기) · 뒤집힌 날짜", async () => {
    const token = await member("bad", { baseGenre: "dance_sport" });
    for (const query of ["?limit=0", "?limit=51", "?cursor=abc", "?genre=salsa_bachata", "?from=2026-12-05&to=2026-12-01", "?from=2026-13-01"]) {
      const res = await home(token, query);
      expect([query, res.status, res.code]).toEqual([query, 422, "VALIDATION_FAILED"]);
    }
  });

  test("회원만 — 세션 없음 401, 로그인했지만 가입 전 403 SIGNUP_INCOMPLETE", async () => {
    expect((await home(null)).status).toBe(401);
    const { token } = await loggedInUser("not-member");
    const res = await home(token);
    expect([res.status, res.code]).toEqual([403, "SIGNUP_INCOMPLETE"]);
  });
});
