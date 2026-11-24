// S2-1.9(학원 검색·학원 색 API) — 계약 11 §3-1(GET /api/instructor/academies) · §3-2(PUT …/affiliations/{id}/color)를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s2-1-9.db.test.ts 였는데, 기능 이름(instructor-academies)으로 바꿨다.
//   핵심(verify): 검색 결과에 소속 상태 표시 · 남의 소속 색 바꾸기 403 · 색 번호 범위 밖 422.
//   나머지: active 학원만 · 시·구로도 찾음 · LIKE 특수 글자는 글자 그대로 · 공개 수업 장르 · 면(앱/웹)별 수업 등록 권한
//           · 색 200 + DB 값 · 없는 소속 404 · active 아닌 소속 409 · 강사 아님 403 · 로그인 없음 401
//           · 승인 때 안 쓴 가장 작은 색 번호가 자동으로 붙는다(계약 §3-2 추천안).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createApproveAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import {
  academySearchResultSchema,
  affiliationColorResponseSchema,
  createSearchAcademiesRoute,
  createSetAffiliationColorRoute,
  type AcademySearchItem,
} from "@/lib/server/services/instructor-academies";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "instructor-academies-test-".repeat(2);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T08:00:00Z");

describe.skipIf(!dbAvailable())("강사 학원 검색 · 학원 색(계약 11 §3-1 · §3-2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};

  /**
   * 세션 읽기. 앱(Bearer)은 그대로 읽고, 「웹」 요청은 쿠키 대신 x-test-session 헤더로 같은 세션을 넘긴다 —
   * 서명된 쿠키를 만들지 않고도 Authorization 헤더가 없는 요청(= 관리자 웹 면)을 흉내 내려는 것이다.
   */
  const getSession = (h: Headers) => {
    const webToken = h.get("x-test-session");
    const headers = webToken === null ? h : new Headers({ authorization: `Bearer ${webToken}` });
    return auth.api.getSession({ headers });
  };
  const deps = () => ({ db: handle.db, getSession });

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor === true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, name: string, gu: string, status = "active") {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', $3, $4, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name, gu, status],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["Owner"]]);
  }

  /** 소속 행 하나. requested_at 을 나눠 「가장 최근 행」이 무엇인지 분명하게 한다 */
  async function insertAffiliation(academy: string, instructor: string, status: string, requestedAt: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, reject_reason_code, released_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz,
               CASE WHEN $3 IN ('active','rejected','released') THEN $4::timestamptz END,
               CASE WHEN $3 = 'rejected' THEN 'genre_mismatch' END,
               CASE WHEN $3 = 'released' THEN $4::timestamptz END, now())
       RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, requestedAt],
    );
    return (rows[0] as { id: string }).id;
  }

  /** 공개 수업(open 판매 단위가 있는 수업) 하나 — 학원의 genres 원천 */
  async function insertClass(academy: string, genre: string, offeringStatus: "open" | "closed") {
    const classId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, '시험 수업', '강사', $3, 'one_day', 'single', now())`,
      [classId, academyIds[academy], genre],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
       VALUES (uuidv7(), $1, '회차', 'session', 30000, now() + interval '7 days', now() + interval '8 days', $2, now())`,
      [classId, offeringStatus],
    );
  }

  /** 검색 호출. surface 「web」은 Authorization 없이 보낸다(관리자 웹 면) */
  async function search(who: string | undefined, query: string, surface: "app" | "web" = "app") {
    const headers: Record<string, string> = {};
    if (who !== undefined) {
      if (surface === "app") headers["authorization"] = `Bearer ${tokens[who]}`;
      else headers["x-test-session"] = tokens[who];
    }
    const res = await createSearchAcademiesRoute(deps())(new Request(`${BASE}/api/instructor/academies${query}`, { headers }), undefined);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function setColor(who: string | undefined, affiliationId: string, body: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await createSetAffiliationColorRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations/${affiliationId}/color`, {
        method: "PUT",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const colorOf = async (affiliationId: string) =>
    ((await q("SELECT calendar_color_index AS c FROM instructor_affiliations WHERE id = $1", [affiliationId])).rows[0] as {
      c: number | null;
    }).c;

  const byName = (items: AcademySearchItem[], name: string) => {
    const item = items.find((i) => i.name === name);
    if (item === undefined) throw new Error(`${name} 이 결과에 없다`);
    return item;
  };

  // 학원·소속 id 를 테스트 사이에 나눠 쓴다
  const aff: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("Owner", ["owner"], { twoFactor: true });
    await makeStaff("Mina", ["instructor"]);
    await makeStaff("Jun", ["instructor"]);
    await makeStaff("Ghost", []); // 역할 없는 직원 계정

    // 미나 기준으로 상태가 다 다른 학원 여섯 + 받지 않는 학원 하나
    await makeAcademy("Active", "라틴하우스 강남", "강남구");
    await makeAcademy("Pending", "라틴 아카데미 홍대", "마포구");
    await makeAcademy("Rejected", "라틴스텝 서초", "서초구");
    await makeAcademy("Released", "라틴 클럽 종로", "종로구");
    await makeAcademy("Withdrawn", "라틴 무브 송파", "송파구");
    await makeAcademy("None", "라틴 플로어 용산", "용산구");
    await makeAcademy("Restricted", "라틴 제한 학원", "강남구", "restricted");
    await makeAcademy("Swing", "스윙 50%_세일 학원", "성동구");

    aff["Active"] = await insertAffiliation("Active", "Mina", "active", "2026-11-01T00:00:00Z");
    aff["Pending"] = await insertAffiliation("Pending", "Mina", "pending", "2026-11-02T00:00:00Z");
    // 거절 뒤 다시 거절 — 가장 최근 행(나중 것)이 보여야 한다
    await insertAffiliation("Rejected", "Mina", "rejected", "2026-10-01T00:00:00Z");
    aff["Rejected"] = await insertAffiliation("Rejected", "Mina", "rejected", "2026-11-03T00:00:00Z");
    aff["Released"] = await insertAffiliation("Released", "Mina", "released", "2026-11-04T00:00:00Z");
    aff["Withdrawn"] = await insertAffiliation("Withdrawn", "Mina", "withdrawn", "2026-11-05T00:00:00Z");
    aff["JunActive"] = await insertAffiliation("Active", "Jun", "active", "2026-11-06T00:00:00Z");

    // 미나의 강남 소속에는 앱 수업 등록 권한(class_submit)만 켠다 — 웹 class_manage 는 꺼져 있다
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      aff["Active"],
      staffIds["Owner"],
    ]);

    // 강남: 공개 수업 둘(장르 둘) + 닫힌 수업 하나(장르에 안 들어감)
    await insertClass("Active", "salsa_bachata", "open");
    await insertClass("Active", "dance_sport", "open");
    await insertClass("Active", "swing", "closed");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 검색 결과에 학원마다 나와의 소속 상태가 붙는다(active·pending·rejected·released, 철회·없음은 null)", async () => {
    const res = await search("Mina", `?q=${encodeURIComponent("라틴")}`);
    expect(res.status).toBe(200);
    const { items } = academySearchResultSchema.parse(res.json);

    // active 학원만 — 제한 학원은 이름이 맞아도 나오지 않는다. 이름 순
    expect(items.map((i) => i.name)).toEqual([
      "라틴 무브 송파",
      "라틴 아카데미 홍대",
      "라틴 클럽 종로",
      "라틴 플로어 용산",
      "라틴스텝 서초",
      "라틴하우스 강남",
    ]);

    expect(byName(items, "라틴하우스 강남")).toEqual({
      academyId: academyIds["Active"],
      name: "라틴하우스 강남",
      region: { sido: "서울", gu: "강남구" },
      genres: ["dance_sport", "salsa_bachata"], // 닫힌 swing 수업은 빠진다
      affiliation: { affiliationId: aff["Active"], status: "active" },
      canSubmitClass: true, // 앱 요청 → class_submit 이 켜져 있다
      canOpenPrivateLesson: true,
    });
    expect(byName(items, "라틴 아카데미 홍대").affiliation).toEqual({ affiliationId: aff["Pending"], status: "pending" });
    expect(byName(items, "라틴스텝 서초").affiliation).toEqual({ affiliationId: aff["Rejected"], status: "rejected" });
    expect(byName(items, "라틴 클럽 종로").affiliation).toEqual({ affiliationId: aff["Released"], status: "released" });
    expect(byName(items, "라틴 무브 송파").affiliation).toBeNull(); // 철회 = 다시 신청할 수 있다
    expect(byName(items, "라틴 플로어 용산").affiliation).toBeNull();

    // active 가 아닌 소속은 수업 등록·개인 레슨 모두 불가, 공개 수업이 없으면 장르는 빈 배열
    for (const name of ["라틴 아카데미 홍대", "라틴스텝 서초", "라틴 클럽 종로", "라틴 무브 송파", "라틴 플로어 용산"]) {
      expect(byName(items, name)).toMatchObject({ canSubmitClass: false, canOpenPrivateLesson: false, genres: [] });
    }

    // 다른 강사(준)는 같은 학원을 자기 소속 행으로 본다 — 미나의 상태가 새지 않는다
    const jun = academySearchResultSchema.parse((await search("Jun", `?q=${encodeURIComponent("라틴")}`)).json).items;
    expect(byName(jun, "라틴하우스 강남")).toMatchObject({
      affiliation: { affiliationId: aff["JunActive"], status: "active" },
      canSubmitClass: false, // 준에게는 위임이 없다
      canOpenPrivateLesson: true,
    });
    expect(byName(jun, "라틴 아카데미 홍대").affiliation).toBeNull();
  });

  test("② 면마다 수업 등록 권한이 다르다 — 웹(쿠키) 요청은 class_manage 를 본다", async () => {
    const web = academySearchResultSchema.parse((await search("Mina", `?q=${encodeURIComponent("강남")}`, "web")).json).items;
    expect(web.map((i) => i.name)).toEqual(["라틴하우스 강남"]); // 구 이름으로도 찾는다(제한 학원은 빠짐)
    expect(web[0]?.canSubmitClass).toBe(false);

    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_manage', $2)", [
      aff["Active"],
      staffIds["Owner"],
    ]);
    const webAfter = academySearchResultSchema.parse((await search("Mina", `?q=${encodeURIComponent("강남")}`, "web")).json).items;
    expect(webAfter[0]?.canSubmitClass).toBe(true);
    await q("DELETE FROM instructor_delegations WHERE affiliation_id = $1 AND permission = 'class_manage'", [aff["Active"]]);
  });

  test("③ 검색어 규칙 — LIKE 특수 글자는 글자 그대로, 빈 검색어는 받는 학원 전체, limit 범위 밖 422", async () => {
    const percent = academySearchResultSchema.parse((await search("Mina", `?q=${encodeURIComponent("50%_")}`)).json).items;
    expect(percent.map((i) => i.name)).toEqual(["스윙 50%_세일 학원"]);
    const underscore = academySearchResultSchema.parse((await search("Mina", `?q=${encodeURIComponent("_")}`)).json).items;
    expect(underscore.map((i) => i.name)).toEqual(["스윙 50%_세일 학원"]); // _ 가 「아무 글자 하나」로 쓰였다면 전부 나왔다

    const all = academySearchResultSchema.parse((await search("Mina", "")).json).items;
    expect(all).toHaveLength(7); // active 7곳(제한 학원 제외)
    const two = academySearchResultSchema.parse((await search("Mina", "?limit=2")).json).items;
    expect(two).toHaveLength(2);

    for (const bad of ["?limit=0", "?limit=51", "?limit=abc", `?q=${"가".repeat(51)}`]) {
      const res = await search("Mina", bad);
      expect(res.status, bad).toBe(422);
      expect(res.json.code).toBe("VALIDATION_FAILED");
    }
  });

  test("④ 검색 권한 — 로그인 없음 401 · 강사 역할 없음 403", async () => {
    expect((await search(undefined, "?q=라틴")).status).toBe(401);
    const ghost = await search("Ghost", "?q=라틴");
    expect(ghost.status).toBe(403);
    expect(ghost.json.code).toBe("FORBIDDEN");
  });

  test("⑤ 내 소속 학원 색 바꾸기 200 → DB 에 번호만 저장, 같은 번호 다시 200", async () => {
    const res = await setColor("Mina", aff["Active"]!, { colorIndex: 3 });
    expect(res.status).toBe(200);
    expect(affiliationColorResponseSchema.parse(res.json)).toEqual({ affiliationId: aff["Active"], colorIndex: 3 });
    expect(await colorOf(aff["Active"]!)).toBe(3);

    expect((await setColor("Mina", aff["Active"]!, { colorIndex: 3 })).status).toBe(200);
    expect((await setColor("Mina", aff["Active"]!, { colorIndex: 11 })).status).toBe(200);
    expect(await colorOf(aff["Active"]!)).toBe(11);
    expect((await setColor("Mina", aff["Active"]!, { colorIndex: 0 })).status).toBe(200);
    expect(await colorOf(aff["Active"]!)).toBe(0);
  });

  test("⑥ 남의 소속 색 바꾸기 403 — 준의 소속 색은 그대로", async () => {
    const before = await colorOf(aff["JunActive"]!);
    const res = await setColor("Mina", aff["JunActive"]!, { colorIndex: 5 });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("FORBIDDEN");
    expect(await colorOf(aff["JunActive"]!)).toBe(before);
  });

  test("⑦ 색 번호 범위 밖 422 — 12 · -1 · 소수 · 글자 · 칸 없음 · 모르는 칸, 저장값은 그대로", async () => {
    await setColor("Mina", aff["Active"]!, { colorIndex: 4 });
    for (const body of [{ colorIndex: 12 }, { colorIndex: -1 }, { colorIndex: 1.5 }, { colorIndex: "3" }, {}, { colorIndex: 2, hex: "#fff" }]) {
      const res = await setColor("Mina", aff["Active"]!, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json.code).toBe("VALIDATION_FAILED");
    }
    expect(await colorOf(aff["Active"]!)).toBe(4);
    // DB 제약도 같은 범위를 막는다(앱을 거치지 않은 쓰기)
    await expect(q("UPDATE instructor_affiliations SET calendar_color_index = 12 WHERE id = $1", [aff["Active"]])).rejects.toThrow(
      /ck_aff_color/,
    );
  });

  test("⑧ 색 — 없는 소속 404 · active 아닌 내 소속 409 · 강사 아님 403 · 로그인 없음 401 · JSON 아님 400", async () => {
    expect((await setColor("Mina", randomUUID(), { colorIndex: 1 })).status).toBe(404);
    expect((await setColor("Mina", "not-a-uuid", { colorIndex: 1 })).status).toBe(404);
    for (const key of ["Pending", "Rejected", "Released", "Withdrawn"]) {
      const res = await setColor("Mina", aff[key]!, { colorIndex: 1 });
      expect(res.status, key).toBe(409);
      expect(res.json.code).toBe("AFFILIATION_STATE_CONFLICT");
      expect(await colorOf(aff[key]!)).toBeNull();
    }
    expect((await setColor("Ghost", aff["Active"]!, { colorIndex: 1 })).status).toBe(403);
    expect((await setColor(undefined, aff["Active"]!, { colorIndex: 1 })).status).toBe(401);
    expect((await setColor("Mina", aff["Active"]!, "not json")).status).toBe(400);
  });

  test("⑨ 승인 때 그 강사가 안 쓴 가장 작은 색 번호가 자동으로 붙는다(추천안) — 12색을 다 쓰면 비워 둔다", async () => {
    await makeStaff("Sora", ["instructor"]);
    const approve = (affiliationId: string, academy: string) =>
      createApproveAffiliationRoute({ ...deps(), clock: fixedClock(NOW) })(
        new Request(`${BASE}/api/academies/${academyIds[academy]}/affiliations/${affiliationId}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${tokens["Owner"]}` },
          body: JSON.stringify({ isAcademyEmployee: false, shareRateBp: 6000 }),
        }),
        { params: Promise.resolve({ academyId: academyIds[academy]!, id: affiliationId }) },
      );

    // 소라는 이미 0·1 번을 쓰는 소속이 있다(직접 넣은 active 행). 다음 승인은 2번
    const first = await insertAffiliation("Released", "Sora", "active", "2026-11-01T00:00:00Z");
    const second = await insertAffiliation("None", "Sora", "active", "2026-11-01T00:00:00Z");
    await q("UPDATE instructor_affiliations SET calendar_color_index = 0 WHERE id = $1", [first]);
    await q("UPDATE instructor_affiliations SET calendar_color_index = 1 WHERE id = $1", [second]);
    const pending = await insertAffiliation("Active", "Sora", "pending", "2026-11-10T00:00:00Z");
    const res = await approve(pending, "Active");
    expect(res.status).toBe(200);
    expect(await colorOf(pending)).toBe(2);

    // 끝난(released 등) 소속의 색은 「쓰는 중」으로 치지 않는다 — 하나의 첫 승인은 0번
    await makeStaff("Hana", ["instructor"]);
    const oldReleased = await insertAffiliation("Pending", "Hana", "released", "2026-10-01T00:00:00Z");
    await q("UPDATE instructor_affiliations SET calendar_color_index = 0 WHERE id = $1", [oldReleased]);
    const hanaPending = await insertAffiliation("Rejected", "Hana", "pending", "2026-11-10T00:00:00Z");
    expect((await approve(hanaPending, "Rejected")).status).toBe(200);
    expect(await colorOf(hanaPending)).toBe(0);

    // 12색을 다 쓰고 있으면 NULL — 강사가 직접 고른다
    await makeStaff("Yuna", ["instructor"]);
    for (let i = 0; i < 12; i += 1) {
      const key = `Full${i}`;
      await makeAcademy(key, `가득 학원 ${i}`, "중구");
      const id = await insertAffiliation(key, "Yuna", "active", "2026-11-01T00:00:00Z");
      await q("UPDATE instructor_affiliations SET calendar_color_index = $2 WHERE id = $1", [id, i]);
    }
    const yunaPending = await insertAffiliation("Swing", "Yuna", "pending", "2026-11-10T00:00:00Z");
    expect((await approve(yunaPending, "Swing")).status).toBe(200);
    expect(await colorOf(yunaPending)).toBeNull();
  });
});
