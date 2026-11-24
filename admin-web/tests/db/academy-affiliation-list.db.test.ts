// S1-2.8(소속 목록 조회 API) — 계약 08 §3 의 `GET /api/academies/{academyId}/affiliations?status=` 를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-8.db.test.ts 였는데, 기능 이름(academy-affiliation-list)으로 바꿨다.
//   핵심(verify): 대표에게 대기·소속을 준다 · 시나리오 5(학원 B 대표가 학원 A 목록을 부르면 403).
//   나머지: status 거르기(pending·active·비움) · 거절·철회·해제 행과 다른 학원 행은 빠진다 · 연락처는 가린 값만
//           · 위임 권한 배열 · 잘못된 status·모르는 쿼리 422 · 위임 강사 403 · 2단계 전 401 · 로그인 없음 401.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { affiliationListSchema, createListAcademyAffiliationsRoute } from "@/lib/server/services/academy-affiliation-list";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-list-test-".repeat(3);
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("소속 목록 조회(계약 08 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  // 학원 A 에 넣은 행 — 이름 → 소속 id
  const aff: Record<string, string> = {};

  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }) });

  /** 직원 계정 + 세션. phoneMasked 는 가입 때 만들어 두는 가린 연락처(원문은 넣지 않는다) */
  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean; phoneMasked?: string | null } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q(
      "INSERT INTO staff_accounts (id, auth_user_id, display_name, phone_masked, status, updated_at) VALUES ($1, $2, $3, $4, 'active', now())",
      [id, user.id, key, opts.phoneMasked ?? null],
    );
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    return id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 소속 행 하나를 직접 넣는다(신청·승인 경로는 S1-2.5~S1-2.7 에서 확인했다) */
  async function insertAffiliation(input: {
    academy: string;
    instructor: string;
    status: string;
    requestedAt: string;
    message?: string | null;
    employee?: boolean;
    inviteId?: string;
  }): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, invite_id, applicant_message, is_academy_employee,
          requested_at, reject_reason_code, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, now()) RETURNING id`,
      [
        academyIds[input.academy],
        staffIds[input.instructor],
        input.status,
        input.inviteId === undefined ? "application" : "invite",
        input.inviteId ?? null,
        input.message ?? null,
        input.employee ?? false,
        input.requestedAt,
        input.status === "rejected" ? "genre_mismatch" : null,
      ],
    );
    return (rows[0] as { id: string }).id;
  }

  // mode "web" 은 관리자 웹처럼 서명 쿠키로 보낸다 — Bearer(대표 앱)는 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
  async function list(who: string | undefined, academy: string, search = "", mode: "app" | "web" = "app") {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = {};
    if (who !== undefined && mode === "web") headers["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await createListAcademyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations${search}`, { method: "GET", headers }),
      { params: Promise.resolve({ academyId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");

    for (const key of ["iu", "pending2", "active1", "employee", "rejected", "withdrawn", "released", "otherAcademy"]) {
      await makeStaff(key, ["instructor"], { phoneMasked: key === "iu" ? "010-****-5678" : null });
    }

    // 학원 A — 초대 링크로 들어온 대기(한마디 있음, 가장 최근)
    const { rows } = await q(
      `INSERT INTO instructor_invites (id, academy_id, created_by_account_id, token_hash, expires_at, used_at, used_by_account_id, created_at)
       VALUES (uuidv7(), $1, $2, $3, '2026-11-28T00:00:00Z', '2026-11-21T01:00:00Z', $4, '2026-11-20T00:00:00Z') RETURNING id`,
      [academyIds["A"], staffIds["ownerA"], "a".repeat(64), staffIds["iu"]],
    );
    aff["iu"] = await insertAffiliation({
      academy: "A",
      instructor: "iu",
      status: "pending",
      requestedAt: "2026-11-21T01:00:00Z",
      message: "주말 저녁 수업을 맡고 싶어요",
      inviteId: (rows[0] as { id: string }).id,
    });
    // 학원 A — 직접 신청 대기(한마디 없음)
    aff["pending2"] = await insertAffiliation({ academy: "A", instructor: "pending2", status: "pending", requestedAt: "2026-11-19T00:00:00Z" });
    // 학원 A — 소속 중(위임 둘) · 소속 중 직원(위임 없음)
    aff["active1"] = await insertAffiliation({ academy: "A", instructor: "active1", status: "active", requestedAt: "2026-11-10T00:00:00Z" });
    for (const permission of ["roster_manage", "class_manage"]) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        aff["active1"],
        permission,
        staffIds["ownerA"],
      ]);
    }
    aff["employee"] = await insertAffiliation({
      academy: "A",
      instructor: "employee",
      status: "active",
      requestedAt: "2026-11-05T00:00:00Z",
      employee: true,
    });
    // 학원 A — 목록에서 빠져야 할 끝난 행 셋
    for (const status of ["rejected", "withdrawn", "released"]) {
      aff[status] = await insertAffiliation({ academy: "A", instructor: status, status, requestedAt: "2026-11-20T00:00:00Z" });
    }
    // 학원 B — 다른 학원의 대기
    aff["otherAcademy"] = await insertAffiliation({
      academy: "B",
      instructor: "otherAcademy",
      status: "pending",
      requestedAt: "2026-11-21T02:00:00Z",
    });
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("status 를 비우면 대표에게 학원 A 의 대기·소속을 최근 신청순으로 준다 — 끝난 행과 다른 학원 행은 없다", async () => {
    const res = await list("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = affiliationListSchema.parse(res.json);
    expect(body.items.map((item) => item.affiliationId)).toEqual([aff["iu"], aff["pending2"], aff["active1"], aff["employee"]]);

    // 초대 링크로 들어온 대기 한 줄 — 계약 08 §3 의 예시 모양 그대로(활동 장르는 S2-1 전이라 null)
    expect(body.items[0]).toEqual({
      affiliationId: aff["iu"],
      status: "pending",
      source: "invite",
      requestedAt: "2026-11-21T01:00:00Z",
      instructor: { accountId: staffIds["iu"], displayName: "iu", phoneMasked: "010-****-5678", activityGenre: null },
      message: "주말 저녁 수업을 맡고 싶어요",
      isAcademyEmployee: false,
      permissions: [],
    });
    // 연락처·한마디가 없는 강사는 null
    expect(body.items[1]).toMatchObject({ source: "application", message: null, instructor: { phoneMasked: null } });
  });

  test("status=pending 은 대기만, status=active 는 소속 중만 — 위임 권한 배열과 직원 표시가 함께 온다", async () => {
    const pending = affiliationListSchema.parse((await list("ownerA", "A", "?status=pending")).json);
    expect(pending.items.map((item) => [item.affiliationId, item.status])).toEqual([
      [aff["iu"], "pending"],
      [aff["pending2"], "pending"],
    ]);

    const active = affiliationListSchema.parse((await list("ownerA", "A", "?status=active")).json);
    expect(active.items.map((item) => ({ id: item.affiliationId, employee: item.isAcademyEmployee, permissions: item.permissions }))).toEqual([
      { id: aff["active1"], employee: false, permissions: ["class_manage", "roster_manage"] },
      { id: aff["employee"], employee: true, permissions: [] },
    ]);
  });

  test("연락처 원문은 응답에 없다 — 가린 값만(FR-187)", async () => {
    const res = await list("ownerA", "A");
    const text = JSON.stringify(res.json);
    expect(text).not.toContain("phone_enc");
    expect(text).not.toMatch(/010-?\d{4}-?5678/);
  });

  test("열리지 않은 status(rejected 등)·모르는 쿼리 이름은 422 VALIDATION_FAILED", async () => {
    for (const search of ["?status=rejected", "?status=withdrawn", "?status=released", "?status=", "?state=pending"]) {
      expect(await list("ownerA", "A", search)).toMatchObject({ status: 422, json: { code: "VALIDATION_FAILED" } });
    }
  });

  test("시나리오 5 — 학원 B 대표가 학원 A 목록을 부르면 403 FORBIDDEN, 자기 학원은 자기 행만", async () => {
    expect(await list("ownerB", "A")).toMatchObject({ status: 403, json: { code: "FORBIDDEN" } });
    expect(await list("ownerB", "A", "?status=pending")).toMatchObject({ status: 403, json: { code: "FORBIDDEN" } });

    const own = affiliationListSchema.parse((await list("ownerB", "B")).json);
    expect(own.items.map((item) => item.affiliationId)).toEqual([aff["otherAcademy"]]);
  });

  test("권한 — 위임 강사·강사 403 · 2단계 전 대표 401 SECOND_FACTOR_REQUIRED · 로그인 없음 401", async () => {
    // 명단 관리를 위임받은 강사도 소속 목록은 못 본다(대표 고유 권한)
    expect((await list("active1", "A")).status).toBe(403);
    expect((await list("iu", "A")).status).toBe(403);
    expect(await list("ownerNo2fa", "C", "", "web")).toMatchObject({ status: 401, json: { code: "SECOND_FACTOR_REQUIRED" } });
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로
    expect((await list("ownerNo2fa", "C")).status).toBe(200);
    expect((await list(undefined, "A")).status).toBe(401);
  });
});
