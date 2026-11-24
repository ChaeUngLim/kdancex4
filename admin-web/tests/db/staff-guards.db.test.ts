// S0-3.6(requireMember·requireStaff 가드) — 계약 README §6-2 의 판정 순서대로 401·403·404 가 나오는지
// 진짜 Better Auth 세션(Bearer 토큰) + 진짜 PostgreSQL 표로 확인한다.
//   핵심 두 가지(verify):
//     ① 위임을 끄기 전후로 「같은 요청」이 200 → 403 이 된다(권한을 세션이 아니라 매 요청 DB 에서 읽기 때문)
//     ② 학원 B 의 id 로 부르면 403(있는 남의 학원), 없는 학원 id 는 404
//   나머지는 표의 각 단계(① 세션 ② 직원 계정 ③ 2단계 인증 ④ 운영자 ⑥ 대표 ⑦ 위임)와 requireMember.
// 시험용 경로는 실제 Route Handler 와 똑같이 withRoute 로 감싸 응답 모양(`{detail, code}`)까지 본다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createGuards, type Guards, type StaffPermission, type Surface } from "@/lib/server/guards";
import { withRoute } from "@/lib/server/http";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

const SECRET = "staff-guard-test-secret-0123456789-0123456789";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("requireMember·requireStaff 가드(README §6-2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let guards: Guards;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const academyA = randomUUID();
  const academyB = randomUUID();
  // 사람별 Bearer 토큰(= Better Auth 세션 토큰)
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  /** auth.user 하나와 세션 하나를 만든다. twoFactor=true 면 인증 앱을 켠 계정(2단계를 마친 세션). */
  async function makeUser(key: string, twoFactor: boolean): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    const session = await ctx.internalAdapter.createSession(user.id);
    tokens[key] = session.token;
    return user.id;
  }

  async function makeStaff(key: string, opts: { twoFactor?: boolean; status?: string; roles?: string[] } = {}) {
    const authUserId = await makeUser(key, opts.twoFactor ?? true);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, $4, now())", [
      id,
      authUserId,
      key,
      opts.status ?? "active",
    ]);
    for (const role of opts.roles ?? []) {
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    }
    staffIds[key] = id;
    return id;
  }

  /** 소속 한 줄 + 위임. 돌려주는 값은 소속 id. */
  async function affiliate(staffKey: string, academyId: string, status: string, permissions: string[]): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now()) RETURNING id`,
      [academyId, staffIds[staffKey], status],
    );
    const affiliationId = (rows[0] as { id: string }).id;
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        p,
        staffIds["owner"],
      ]);
    }
    return affiliationId;
  }

  // 시험용 경로 — 실제 라우트처럼 withRoute 로 감싸고, 가드를 통과하면 200 을 준다.
  function staffRoute(permission: StaffPermission, surface: Surface) {
    return withRoute<{ academyId?: string }>(async (request, { academyId }) => {
      const staff = await (guards.requireStaff as (p: StaffPermission, o: object) => ReturnType<Guards["requireStaff"]>)(
        permission,
        { surface, headers: request.headers, ...(academyId === undefined ? {} : { academyId }) },
      );
      return Response.json({ staffAccountId: staff.staffAccountId });
    });
  }
  const memberRoute = withRoute(async (request) => Response.json(await guards.requireMember(request)));

  const req = (who?: string) =>
    new Request(`${BASE}/api/test`, { headers: who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` } });

  /** 응답 상태와 code 를 함께 꺼낸다(성공이면 code 없음). */
  async function call(permission: StaffPermission, who: string | undefined, academyId?: string, surface: Surface = "web") {
    const res = await staffRoute(permission, surface)(req(who), { academyId });
    const body = (await res.json()) as { code?: string };
    return { status: res.status, code: body.code };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    guards = createGuards({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }) });

    for (const [id, name] of [
      [academyA, "가드 시험 학원 A"],
      [academyB, "가드 시험 학원 B"],
    ] as const) {
      await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`, [
        id,
        name,
      ]);
    }

    // 대표: 학원 A 의 active 대표
    await makeStaff("owner", { roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, staffIds["owner"]]);
    // 학원 B 의 대표(다른 학원 대표)
    await makeStaff("owner_b", { roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, staffIds["owner_b"]]);
    // 위임 강사: 학원 A active 소속 + roster_manage
    await makeStaff("delegate", { roles: ["instructor"] });
    await affiliate("delegate", academyA, "active", ["roster_manage"]);
    // 인증 앱을 아직 켜지 않은 위임 강사(앱에서는 통과, 웹에서는 2단계 필요)
    await makeStaff("no2fa", { roles: ["instructor"], twoFactor: false });
    await affiliate("no2fa", academyA, "active", ["roster_manage"]);
    // 소속이 끝난(released) 강사 — 위임 행이 남아 있어도 쓰이면 안 된다
    await makeStaff("released", { roles: ["instructor"] });
    await affiliate("released", academyA, "released", ["roster_manage"]);
    // 운영자 · 정지 계정 · 탈퇴 계정
    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("suspended", { status: "suspended", roles: ["owner"] });
    await makeStaff("withdrawn", { status: "withdrawn" });
    // 직원 계정이 없는 회원 · 가입을 마치지 않은 사람
    const memberAuthId = await makeUser("member", false);
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES (uuidv7(), $1, '가드 회원', 'female', '1995-05-05', '010-2222-3333', $2, '시험 닉네임', now(), now())`,
      [memberAuthId, `ci-guard-${memberAuthId}`],
    );
    await makeUser("pending_signup", false);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ① 위임을 끄기 전후로 같은 요청이 200 → 403 이 된다", async () => {
    expect(await call("roster_manage", "delegate", academyA)).toEqual({ status: 200, code: undefined });

    // 대표가 위임을 끈다(행 삭제). 세션은 그대로 둔다.
    await q(
      `DELETE FROM instructor_delegations d USING instructor_affiliations a
       WHERE d.affiliation_id = a.id AND a.instructor_account_id = $1 AND d.permission = 'roster_manage'`,
      [staffIds["delegate"]],
    );
    expect(await call("roster_manage", "delegate", academyA)).toEqual({ status: 403, code: "FORBIDDEN" });

    // 다시 켜면 다음 요청부터 다시 열린다 — 세션에 권한이 들어 있지 않다는 뜻
    const { rows } = await q("SELECT id FROM instructor_affiliations WHERE instructor_account_id = $1 AND status = 'active'", [
      staffIds["delegate"],
    ]);
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
    expect(await call("roster_manage", "delegate", academyA)).toEqual({ status: 200, code: undefined });
  });

  test("verify ② 학원 B 의 id 로 부르면 403, 없는 학원 id 는 404", async () => {
    // 대표 A 가 학원 B 의 대표 권한·위임 권한을 쓰려 함 → 있는 남의 학원이라 403(404 로 숨기지 않는다)
    expect(await call("owner", "owner", academyB)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await call("roster_manage", "owner", academyB)).toEqual({ status: 403, code: "FORBIDDEN" });
    // 학원 A 의 위임 강사가 학원 B 로 → 다른 학원의 위임은 쓰이지 않는다
    expect(await call("roster_manage", "delegate", academyB)).toEqual({ status: 403, code: "FORBIDDEN" });
    // 없는 학원 · id 모양이 틀린 학원 → 404
    expect(await call("owner", "owner", randomUUID())).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(await call("owner", "owner", "not-a-uuid")).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("① 세션이 없으면 401 UNAUTHENTICATED", async () => {
    expect(await call("owner", undefined, academyA)).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    const res = await staffRoute("owner", "web")(
      new Request(`${BASE}/api/test`, { headers: { authorization: "Bearer not-a-real-session-token" } }),
      { academyId: academyA },
    );
    expect(res.status).toBe(401);
  });

  test("② 직원 계정이 없거나 탈퇴면 403 STAFF_ACCOUNT_REQUIRED, 정지면 403 ACCOUNT_SUSPENDED", async () => {
    expect(await call("owner", "member", academyA)).toEqual({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
    expect(await call("owner", "withdrawn", academyA)).toEqual({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
    expect(await call("owner", "suspended", academyA)).toEqual({ status: 403, code: "ACCOUNT_SUSPENDED" });
  });

  test("③ 관리자 웹은 2단계 인증 전 세션을 401 SECOND_FACTOR_REQUIRED 로 막고, 앱은 묻지 않는다", async () => {
    expect(await call("roster_manage", "no2fa", academyA, "web")).toEqual({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await call("roster_manage", "no2fa", academyA, "app")).toEqual({ status: 200, code: undefined });
    // 순서: 2단계 전에는 학원이 있는지(404)도 알려 주지 않는다
    expect(await call("roster_manage", "no2fa", randomUUID(), "web")).toEqual({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });

  test("④ admin 권한은 role_grants(admin, active) 만 통과", async () => {
    expect(await call("admin", "admin")).toEqual({ status: 200, code: undefined });
    expect(await call("admin", "owner")).toEqual({ status: 403, code: "FORBIDDEN" });
    await q("UPDATE role_grants SET status = 'revoked', revoked_at = now() WHERE staff_account_id = $1", [staffIds["admin"]]);
    expect(await call("admin", "admin")).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("⑥ owner 권한은 그 학원의 active 대표만 — 대표가 끝나면(ended) 다음 요청부터 403", async () => {
    expect(await call("owner", "owner", academyA)).toEqual({ status: 200, code: undefined });
    expect(await call("owner", "delegate", academyA)).toEqual({ status: 403, code: "FORBIDDEN" });
    await q("UPDATE academy_owners SET status = 'ended', ended_at = now() WHERE academy_id = $1", [academyB]);
    expect(await call("owner", "owner_b", academyB)).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("⑦ 위임 권한: 대표는 자동 통과, 켜지 않은 위임·끝난 소속의 위임은 403", async () => {
    expect(await call("class_manage", "owner", academyA)).toEqual({ status: 200, code: undefined });
    expect(await call("class_manage", "delegate", academyA)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await call("roster_manage", "released", academyA)).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("통과하면 decide() 에 넘길 Actor 를 돌려준다", async () => {
    const staff = await guards.requireStaff("roster_manage", {
      academyId: academyA,
      surface: "web",
      headers: req("delegate").headers,
    });
    expect(staff.staffAccountId).toBe(staffIds["delegate"]);
    expect(staff.actor).toEqual({
      type: "staff",
      accountId: staffIds["delegate"],
      roles: ["instructor"],
      ownedAcademyIds: [],
      delegations: { [academyA]: ["roster_manage"] },
    });
  });

  test("requireMember: 세션 없음 401 · 회원 행 없음 403 SIGNUP_INCOMPLETE · 회원이면 200", async () => {
    const none = await memberRoute(req(), undefined);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { code: string }).code).toBe("UNAUTHENTICATED");

    const pending = await memberRoute(req("pending_signup"), undefined);
    expect(pending.status).toBe(403);
    expect(((await pending.json()) as { code: string }).code).toBe("SIGNUP_INCOMPLETE");

    const ok = await memberRoute(req("member"), undefined);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { memberId?: string }).memberId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
