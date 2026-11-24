// S3-1.5(취향·기준 장르 API) — `PUT /api/me/profile` · `PUT /api/me/base-genre` · `GET /api/me`(계약 01 §4·§5·§6, FR-022 · FR-022a).
//   verify ① 저장 뒤 조회 값이 같다 — PUT 응답 = GET /api/me = DB 행(관심 장르 복수·지역·가능 시간대·경험 수준·기준 장르)
//   verify ② 관심 장르 0개는 거부 — 빈 배열·칸 없음 모두 422 VALIDATION_FAILED(fields: interestGenres), DB 는 그대로
//   그리고: 시간대는 둘 다/둘 다 비움 + 시작 < 끝(zod), 중복 장르·지역은 하나로, 모르는 칸 422, 전체 교체,
//           기준 장르는 정확히 1개, 세션 없음 401 · 가입 전 403 SIGNUP_INCOMPLETE, 다른 회원 값은 그대로, 동시 저장도 한 벌만
// 경로 처리기는 앱과 같은 createMemberProfileRoutes 를 테스트 DB·진짜 Better Auth 세션으로 만든다.
//
// 이름: verify 의 tests/db/s3-1-5.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";
import { memberSchema } from "@/lib/server/services/member-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";

const FULL_PROFILE = {
  interestGenres: ["salsa_bachata", "swing"],
  regions: [
    { sido: "서울", gu: "강남구" },
    { sido: "서울", gu: "마포구" },
  ],
  availableFrom: "18:00",
  availableTo: "22:00",
  experienceLevel: "beginner",
} as const;

describe.skipIf(!dbAvailable())("회원 취향·기준 장르 API(계약 01 §4~§6, S3-1.5)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const routes = () => createMemberProfileRoutes({ db: handle.db, getSession, clock: systemClock });

  /** 로그인 계정 하나 — Bearer 토큰과 auth user id */
  async function loggedInUser(key: string): Promise<{ bearer: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true },
      { method: "admin" },
    );
    return { bearer: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  /** 가입을 마친 회원(S3-1.2 결과와 같은 행). 취향·기준 장르는 아직 없다 */
  async function signedUpMember(key: string): Promise<{ bearer: string; memberId: string }> {
    const { bearer, userId } = await loggedInUser(key);
    const memberId = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '김회원', 'female', '1995-03-02', '01012345678', $3, '서연', now(), now())`,
      [memberId, userId, `ci-${randomUUID()}`],
    );
    return { bearer, memberId };
  }

  type Handler = "getMe" | "putProfile" | "putBaseGenre";
  const PATH: Record<Handler, string> = { getMe: "/api/me", putProfile: "/api/me/profile", putBaseGenre: "/api/me/base-genre" };
  async function call(handler: Handler, bearer: string | null, body?: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
    const init: RequestInit =
      handler === "getMe" ? { method: "GET", headers } : { method: "PUT", headers, body: JSON.stringify(body) };
    const res = await routes()[handler](new Request(`${BASE}${PATH[handler]}`, init), {});
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  const fieldPaths = (body: Record<string, unknown>) =>
    ((body["fields"] ?? []) as { path: string }[]).map((f) => f.path);

  /** DB 에 실제로 들어간 취향(응답이 아니라 행) */
  async function stored(memberId: string) {
    const { rows: m } = await q(
      `SELECT base_genre, experience_level, to_char(available_from, 'HH24:MI') AS af, to_char(available_to, 'HH24:MI') AS at
       FROM members WHERE id = $1`,
      [memberId],
    );
    const { rows: g } = await q("SELECT genre FROM member_interest_genres WHERE member_id = $1 ORDER BY genre", [memberId]);
    const { rows: r } = await q(
      "SELECT region_sido AS sido, region_gu AS gu FROM member_regions WHERE member_id = $1 ORDER BY region_sido, region_gu",
      [memberId],
    );
    return { ...m[0], genres: g.map((x) => x.genre as string), regions: r };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ①: 취향과 기준 장르를 저장한 뒤 GET /api/me · DB 행이 저장한 값과 같다", async () => {
    const { bearer, memberId } = await signedUpMember("save");

    // 가입 직후는 비어 있다
    const before = await call("getMe", bearer);
    expect(before.status).toBe(200);
    expect(memberSchema.parse(before.body).onboarding).toEqual({ profileDone: false, baseGenreDone: false });

    const put = await call("putProfile", bearer, FULL_PROFILE);
    expect(put.status).toBe(200);
    const afterProfile = memberSchema.parse(put.body);
    expect(afterProfile.profile).toEqual({
      interestGenres: ["salsa_bachata", "swing"].sort(), // 응답은 장르 이름순
      regions: FULL_PROFILE.regions,
      availableFrom: "18:00",
      availableTo: "22:00",
      experienceLevel: "beginner",
    });
    expect(afterProfile.onboarding).toEqual({ profileDone: true, baseGenreDone: false });

    const base = await call("putBaseGenre", bearer, { baseGenre: "salsa_bachata" });
    expect(base.status).toBe(200);
    const afterBase = memberSchema.parse(base.body);
    expect(afterBase.baseGenre).toBe("salsa_bachata");
    expect(afterBase.onboarding).toEqual({ profileDone: true, baseGenreDone: true });
    expect(afterBase.profile).toEqual(afterProfile.profile); // 기준 장르 저장이 취향을 건드리지 않는다

    // 조회 = 마지막 저장 응답
    const me = await call("getMe", bearer);
    expect(me.status).toBe(200);
    expect(memberSchema.parse(me.body)).toEqual(afterBase);
    // 응답에 전체 연락처가 없다(가린 번호만)
    expect(JSON.stringify(me.body)).not.toContain("01012345678");

    // DB 행도 같다
    expect(await stored(memberId)).toEqual({
      base_genre: "salsa_bachata",
      experience_level: "beginner",
      af: "18:00",
      at: "22:00",
      genres: ["salsa_bachata", "swing"],
      regions: [
        { sido: "서울", gu: "강남구" },
        { sido: "서울", gu: "마포구" },
      ],
    });
  });

  test("verify ②: 관심 장르 0개(빈 배열·칸 없음·null)는 422 이고 이미 있던 취향은 그대로다", async () => {
    const { bearer, memberId } = await signedUpMember("zero");
    expect((await call("putProfile", bearer, FULL_PROFILE)).status).toBe(200);
    const kept = await stored(memberId);

    for (const body of [
      { ...FULL_PROFILE, interestGenres: [] },
      { regions: [], availableFrom: null, availableTo: null },
      { ...FULL_PROFILE, interestGenres: null },
    ]) {
      const res = await call("putProfile", bearer, body);
      expect(res.status).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
      expect(fieldPaths(res.body)).toContain("interestGenres");
    }
    expect(await stored(memberId)).toEqual(kept);
  });

  test("관심 장르는 복수로 받고, 같은 장르·같은 지역을 두 번 보내면 하나로 줄인다. 모르는 장르는 422", async () => {
    const { bearer, memberId } = await signedUpMember("dedupe");
    const res = await call("putProfile", bearer, {
      interestGenres: ["swing", "dance_sport", "swing", "argentine_tango", "salsa_bachata"],
      regions: [
        { sido: " 서울 ", gu: "강남구" },
        { sido: "서울", gu: "강남구" },
      ],
    });
    expect(res.status).toBe(200);
    const s = await stored(memberId);
    expect(s.genres).toEqual(["argentine_tango", "dance_sport", "salsa_bachata", "swing"]);
    expect(s.regions).toEqual([{ sido: "서울", gu: "강남구" }]); // 앞뒤 공백도 지운 뒤 같은 지역

    const bad = await call("putProfile", bearer, { interestGenres: ["kpop"] });
    expect(bad.status).toBe(422);
    expect(fieldPaths(bad.body)).toContain("interestGenres.0");
  });

  test("가능 시간대: 한쪽만·시작 ≥ 끝·형식 틀림은 422, 둘 다 비우기는 받는다", async () => {
    const { bearer, memberId } = await signedUpMember("window");
    const cases: [Record<string, unknown>, string][] = [
      [{ availableFrom: "18:00" }, "availableTo"],
      [{ availableTo: "22:00" }, "availableFrom"],
      [{ availableFrom: "22:00", availableTo: "18:00" }, "availableTo"],
      [{ availableFrom: "18:00", availableTo: "18:00" }, "availableTo"],
      [{ availableFrom: "24:00", availableTo: "23:00" }, "availableFrom"],
      [{ availableFrom: "9:00", availableTo: "12:00" }, "availableFrom"],
    ];
    for (const [window, path] of cases) {
      const res = await call("putProfile", bearer, { interestGenres: ["swing"], ...window });
      expect(res.status, JSON.stringify(window)).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
      expect(fieldPaths(res.body)).toContain(path);
    }
    expect((await stored(memberId)).genres).toEqual([]); // 하나도 저장되지 않았다

    const ok = await call("putProfile", bearer, { interestGenres: ["swing"], availableFrom: "00:00", availableTo: "23:59" });
    expect(ok.status).toBe(200);
    const nulls = await call("putProfile", bearer, { interestGenres: ["swing"], availableFrom: null, availableTo: null });
    expect(nulls.status).toBe(200);
    expect(memberSchema.parse(nulls.body).profile).toMatchObject({ availableFrom: null, availableTo: null });
  });

  test("전체 교체: 다시 저장하면 목록은 새 값으로 바뀌고 빠진 선택 칸은 비워진다", async () => {
    const { bearer, memberId } = await signedUpMember("replace");
    expect((await call("putProfile", bearer, FULL_PROFILE)).status).toBe(200);
    const res = await call("putProfile", bearer, { interestGenres: ["dance_sport"] });
    expect(res.status).toBe(200);
    expect(await stored(memberId)).toEqual({
      base_genre: null,
      experience_level: null,
      af: null,
      at: null,
      genres: ["dance_sport"],
      regions: [],
    });
  });

  test("모르는 칸(연령대·세부 장르·기준 장르)과 지역 21개는 422 — 1회차 범위 밖은 받지 않는다", async () => {
    const { bearer, memberId } = await signedUpMember("strict");
    for (const extra of [{ preferredAgeGroups: ["20s"] }, { subGenres: ["salsa"] }, { baseGenre: "swing" }]) {
      const res = await call("putProfile", bearer, { ...FULL_PROFILE, ...extra });
      expect(res.status).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
    }
    const many = Array.from({ length: 21 }, (_, i) => ({ sido: "서울", gu: `구${i}` }));
    expect((await call("putProfile", bearer, { interestGenres: ["swing"], regions: many })).status).toBe(422);
    const bad = await call("putProfile", bearer, { ...FULL_PROFILE, experienceLevel: "pro" });
    expect(bad.status).toBe(422);
    expect(fieldPaths(bad.body)).toContain("experienceLevel");
    expect((await stored(memberId)).genres).toEqual([]);
  });

  test("기준 장르: 정확히 1개 — 바꾸기도 같은 경로, 배열·빈 값·모르는 장르·다른 칸은 422", async () => {
    const { bearer, memberId } = await signedUpMember("base");
    expect((await call("putBaseGenre", bearer, { baseGenre: "swing" })).status).toBe(200);
    const changed = await call("putBaseGenre", bearer, { baseGenre: "argentine_tango" });
    expect(changed.status).toBe(200);
    expect(memberSchema.parse(changed.body).baseGenre).toBe("argentine_tango");

    for (const body of [
      { baseGenre: ["swing", "dance_sport"] },
      { baseGenre: ["swing"] },
      { baseGenre: "" },
      { baseGenre: null },
      {},
      { baseGenre: "kpop" },
      { baseGenre: "swing", interestGenres: ["swing"] },
    ]) {
      const res = await call("putBaseGenre", bearer, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
    }
    expect((await stored(memberId)).base_genre).toBe("argentine_tango");
  });

  test("문지기: 세션 없음 401, 가입 전 로그인 403 SIGNUP_INCOMPLETE, JSON 아님 400", async () => {
    const { bearer: notMember } = await loggedInUser("not-member");
    for (const handler of ["getMe", "putProfile", "putBaseGenre"] as const) {
      const body = handler === "putBaseGenre" ? { baseGenre: "swing" } : FULL_PROFILE;
      expect((await call(handler, null, body)).status).toBe(401);
      const res = await call(handler, notMember, body);
      expect(res.status).toBe(403);
      expect(res.code).toBe("SIGNUP_INCOMPLETE");
    }
    const { rows } = await q("SELECT count(*)::int AS n FROM member_interest_genres");
    expect(rows[0].n).toBe(0);

    const { bearer } = await signedUpMember("bad-json");
    const res = await routes().putProfile(
      new Request(`${BASE}/api/me/profile`, {
        method: "PUT",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: "{not json",
      }),
      {},
    );
    expect(res.status).toBe(400);
  });

  test("내 값만 바뀐다 — 다른 회원의 취향·기준 장르는 그대로", async () => {
    const a = await signedUpMember("a");
    const b = await signedUpMember("b");
    expect((await call("putProfile", b.bearer, { interestGenres: ["dance_sport"], regions: [{ sido: "부산", gu: "해운대구" }] })).status).toBe(200);
    expect((await call("putBaseGenre", b.bearer, { baseGenre: "dance_sport" })).status).toBe(200);
    const bBefore = await stored(b.memberId);

    expect((await call("putProfile", a.bearer, FULL_PROFILE)).status).toBe(200);
    expect((await call("putBaseGenre", a.bearer, { baseGenre: "swing" })).status).toBe(200);
    expect(await stored(b.memberId)).toEqual(bBefore);
  });

  test("같은 회원이 동시에 5번 저장해도 모두 200 이고 장르는 한 벌만 남는다(행 잠금)", async () => {
    const { bearer, memberId } = await signedUpMember("race");
    const bodies = [["swing"], ["dance_sport"], ["salsa_bachata", "swing"], ["argentine_tango"], ["swing", "dance_sport"]];
    const results = await Promise.all(bodies.map((genres) => call("putProfile", bearer, { interestGenres: genres })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const s = await stored(memberId);
    // 남은 한 벌은 보낸 것 중 하나와 정확히 같다(섞이지 않았다)
    expect(bodies.map((g) => [...g].sort())).toContainEqual(s.genres);
  });
});
