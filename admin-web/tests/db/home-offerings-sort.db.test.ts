// S3-2.2(시간대 필터·정렬) — `GET /api/home/offerings?sort=`(계약 02 §1 「정렬」 줄).
//   verify: 정렬 기준마다(recommended · deadline · seats) 순서가 기대와 같다
//   그리고: 정렬 값이 없으면 추천순, 같은 값이면 첫 회차 시작 → id, 가능 시간대 거르기는 정렬과 상관없이 그대로,
//           커서는 정렬 값마다 따로(다른 정렬의 커서는 422), 모르는 정렬(거리 distance · 아직 없는 popular)은 422
//
// 정렬 규칙 자체는 순수 함수(lib/domain/home-offering-sort.ts)이고 단위 테스트(tests/unit/home-offering-sort.test.ts)가 따로 본다.
// 여기서는 S2-2 경로(수업 등록 → 공개)로 만든 실제 판매 단위가 API 에서 그 순서로 나오는지 본다.
// 잔여석은 결제 경로(S3-3) 전이라 seat_pools 의 잡힘·확정 숫자를 직접 적는다 — S3-2.1 테스트와 같은 방식.
//
// 이름: verify 의 tests/db/s3-2-2.db.test.ts 는 Task 번호 이름이라 기능 이름(home-offerings-sort)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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
// 홈 목록의 시계. 12월 수업이 모두 이 시각 뒤다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

describe.skipIf(!dbAvailable())("홈 목록 정렬(계약 02 §1, S3-2.2)", () => {
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
  const regularBody = (academy: string, instructor: string, title: string, startTime: string, endTime: string, asOwner: boolean, periodFrom: string) => ({
    academyId: academyIds[academy],
    classKind: "regular",
    title,
    subGenre: instructor === "salsa" ? "salsa" : "latin",
    discipline: instructor === "salsa" ? null : "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 120000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom, periodTo: "2026-12-24" },
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
    o: { academy: string; instructor: string; start: string; end: string; stage: "draft" | "pending" | "approved" | "owner"; from?: string },
  ) {
    const writer = o.stage === "owner" ? "owner" : o.instructor;
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...staffHeaders(writer), "Idempotency-Key": randomUUID() },
        body: JSON.stringify(regularBody(o.academy, o.instructor, `수업 ${key}`, o.start, o.end, o.stage === "owner", o.from ?? "2026-12-01")),
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
    o: { baseGenre: string | null; regions?: [string, string][]; window?: [string, string] },
  ): Promise<string> {
    const { token, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at,
                            base_genre, available_from, available_to, updated_at)
       VALUES ($1, $2, '김회원', 'female', '1995-03-02', '01012345678', $3, '서연', now(), $4, $5::time, $6::time, now())`,
      [memberId, userId, `ci-${randomUUID()}`, o.baseGenre, o.window?.[0] ?? null, o.window?.[1] ?? null],
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

  /** 판매 단위의 자리 숫자를 적는다 — 남은 자리 = 정원 − 잡힘 − 확정(성별 자리 남 6 · 여 6) */
  async function setSeats(key: string, male: [number, number], female: [number, number]) {
    const offeringId = classes[key]?.offeringId;
    await q("UPDATE seat_pools SET held_count = $2, confirmed_count = $3 WHERE offering_id = $1 AND seat_kind = 'male'", [offeringId, ...male]);
    await q("UPDATE seat_pools SET held_count = $2, confirmed_count = $3 WHERE offering_id = $1 AND seat_kind = 'female'", [offeringId, ...female]);
  }

  /** 첫 회차 시각이 같은 두 판매 단위(X·V)는 id 순으로 선다 — 기대 순서를 id 로 정한다 */
  const byId = (a: string, b: string) => ((classes[a]?.offeringId ?? "") < (classes[b]?.offeringId ?? "") ? [a, b] : [b, a]);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor", "dance_sport");
    await makeStaff("mina", "instructor", "dance_sport");
    await makeAcademy("A", "서울", "강남구");
    await makeAcademy("B", "서울", "마포구");
    for (const a of ["A", "B"]) {
      await affiliate(a, "junho");
      await affiliate(a, "mina");
    }

    // 다섯 판매 단위(모두 댄스스포츠, 화·목). 첫 회차와 남은 자리를 정렬마다 순서가 갈리게 고른다.
    //   이름 | 학원 | 시각        | 첫 회차(KST)   | 남은 자리
    //   X    | A    | 18:00~19:00 | 12/01(화) 18:00 | 12
    //   V    | B    | 18:00~19:00 | 12/01(화) 18:00 | 12   ← X 와 첫 회차·잔여석이 같다(id 로 갈린다)
    //   Y    | A    | 20:30~21:30 | 12/01(화) 20:30 | 2
    //   W    | B    | 10:00~11:00 | 12/03(목) 10:00 | 0    ← 정원이 다 찼어도 목록에 남는다
    //   Z    | A    | 19:00~20:00 | 12/08(화) 19:00 | 2    ← Y 와 잔여석이 같다(첫 회차로 갈린다)
    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 강사·홀·시각을 나눈다
    await makeClass("X", { academy: "A", instructor: "junho", start: "18:00", end: "19:00", stage: "owner" });
    await makeClass("V", { academy: "B", instructor: "mina", start: "18:00", end: "19:00", stage: "approved" });
    await makeClass("Y", { academy: "A", instructor: "mina", start: "20:30", end: "21:30", stage: "owner" });
    await makeClass("W", { academy: "B", instructor: "junho", start: "10:00", end: "11:00", stage: "owner", from: "2026-12-03" });
    await makeClass("Z", { academy: "A", instructor: "junho", start: "19:00", end: "20:00", stage: "owner", from: "2026-12-08" });

    await setSeats("Y", [2, 4], [0, 4]); // 남 0 + 여 2 = 2 (결제 대기 2 도 자리를 막는다)
    await setSeats("W", [0, 6], [1, 5]); // 0
    await setSeats("Z", [0, 5], [0, 5]); // 1 + 1 = 2
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("바닥 확인: 다섯 판매 단위가 공개됐고 첫 회차·남은 자리가 표와 같다", async () => {
    const token = await member("check", { baseGenre: "dance_sport" });
    const { parsed } = await homeKeys(token, "?sort=deadline");
    const byOffering = Object.fromEntries(Object.entries(classes).map(([k, v]) => [v.offeringId, k]));
    const seen = Object.fromEntries(
      parsed.items.map((i) => [
        byOffering[i.offeringId] ?? "?",
        [i.firstSessionStartsAt, i.capacity.pools.reduce((s, p) => s + p.remaining, 0)],
      ]),
    );
    expect(seen).toEqual({
      X: ["2026-12-01T09:00:00.000000Z", 12],
      V: ["2026-12-01T09:00:00.000000Z", 12],
      Y: ["2026-12-01T11:30:00.000000Z", 2],
      W: ["2026-12-03T01:00:00.000000Z", 0],
      Z: ["2026-12-08T10:00:00.000000Z", 2],
    });
  });

  test("verify — deadline(마감 임박): 첫 회차 시작이 가까운 순, 같은 시각은 id", async () => {
    const token = await member("deadline", { baseGenre: "dance_sport" });
    expect((await homeKeys(token, "?sort=deadline")).keys).toEqual([...byId("X", "V"), "Y", "W", "Z"]);
  });

  test("verify — seats(잔여석 임박): 남은 자리가 적은 순, 같으면 첫 회차 → id", async () => {
    const token = await member("seats", { baseGenre: "dance_sport" });
    // W 0 → Y 2(12/01) → Z 2(12/08) → X·V 12(같은 첫 회차라 id)
    expect((await homeKeys(token, "?sort=seats")).keys).toEqual(["W", "Y", "Z", ...byId("X", "V")]);
  });

  test("verify — recommended(추천순, 기본): 장르·지역·시간대 일치 점수가 같으면 첫 회차 → id, sort 를 빼면 추천순", async () => {
    // 지역·시간대를 고른 회원 — 걸러진 후보는 고른 조건에 모두 맞아 점수가 같다(인기 0, 2026-11-23 사용자 결정)
    const picky = await member("rec-picky", { baseGenre: "dance_sport", regions: [["서울", "강남구"], ["서울", "마포구"]], window: ["09:00", "22:00"] });
    const expected = [...byId("X", "V"), "Y", "W", "Z"];
    expect((await homeKeys(picky, "?sort=recommended")).keys).toEqual(expected);
    expect((await homeKeys(picky)).keys).toEqual(expected);
    // 아무것도 안 고른 회원도 같은 순서
    const plain = await member("rec-plain", { baseGenre: "dance_sport" });
    expect((await homeKeys(plain, "?sort=recommended")).keys).toEqual(expected);
  });

  test("가능 시간대 거르기는 정렬과 상관없이 그대로 — 17:00~20:00 회원에게 W(10시)·Y(20:30)는 어느 정렬에서도 안 나온다", async () => {
    const token = await member("window", { baseGenre: "dance_sport", window: ["17:00", "20:00"] });
    expect((await homeKeys(token, "?sort=deadline")).keys).toEqual([...byId("X", "V"), "Z"]);
    expect((await homeKeys(token, "?sort=seats")).keys).toEqual(["Z", ...byId("X", "V")]);
    expect((await homeKeys(token, "?sort=recommended")).keys).toEqual([...byId("X", "V"), "Z"]);
  });

  test("관심 지역 거르기도 그대로 — 마포구만 고른 회원은 B 학원(V·W)만, 잔여석 순이면 W → V", async () => {
    const token = await member("mapo", { baseGenre: "dance_sport", regions: [["서울", "마포구"]] });
    expect((await homeKeys(token, "?sort=seats")).keys).toEqual(["W", "V"]);
    expect((await homeKeys(token, "?sort=deadline")).keys).toEqual(["V", "W"]);
  });

  test("커서는 정렬 값마다 따로 — limit=2 로 끝까지 넘기면 정렬마다 전체 순서와 같고 겹치거나 빠지지 않는다", async () => {
    const token = await member("pages", { baseGenre: "dance_sport" });
    for (const sort of ["recommended", "deadline", "seats"]) {
      const whole = (await homeKeys(token, `?sort=${sort}`)).keys;
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i += 1) {
        const query: string = `?sort=${sort}&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
        const page = await homeKeys(token, query);
        paged.push(...page.keys);
        cursor = page.parsed.nextCursor;
        if (cursor === null) break;
      }
      expect([sort, paged]).toEqual([sort, whole]);
      expect(whole).toHaveLength(5);
    }
  });

  test("다른 정렬의 커서는 422 VALIDATION_FAILED — 기준이 달라 이어 붙이면 행이 겹치거나 빠진다", async () => {
    const token = await member("mismatch", { baseGenre: "dance_sport" });
    const first = await homeKeys(token, "?sort=seats&limit=2");
    expect(first.parsed.nextCursor).not.toBeNull();
    const res = await home(token, `?sort=deadline&limit=2&cursor=${first.parsed.nextCursor}`);
    expect([res.status, res.code]).toEqual([422, "VALIDATION_FAILED"]);
    // sort 를 빼면 추천순이라 seats 커서와 맞지 않는다
    const res2 = await home(token, `?limit=2&cursor=${first.parsed.nextCursor}`);
    expect([res2.status, res2.code]).toEqual([422, "VALIDATION_FAILED"]);
  });

  test("모르는 정렬은 422 VALIDATION_FAILED — 거리(distance)는 만들지 않았고, 검색순·인기순은 S6-2", async () => {
    const token = await member("unknown", { baseGenre: "dance_sport" });
    for (const sort of ["distance", "popular", "search", "", "SEATS"]) {
      const res = await home(token, `?sort=${sort}`);
      expect([sort, res.status, res.code]).toEqual([sort, 422, "VALIDATION_FAILED"]);
    }
  });
});
