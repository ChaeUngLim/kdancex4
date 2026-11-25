// S0-3.7(직원 정보 조회 API) — `GET /api/staff/me` 가 역할·학원별 메뉴·consoleAccess 를 서버 계산값으로 주는지
// 진짜 Better Auth 세션(Bearer 토큰) + 진짜 PostgreSQL 표로 확인한다. 계약: _workspace/03_contracts/README.md §6-1.
//   로드맵 verify 의 파일 이름은 tests/db/s0-3-7.db.test.ts 였는데, 기능 이름(staff-me)으로 바꿨다.
//   핵심 두 가지(verify):
//     ① 위임이 하나도 없는 강사는 consoleAccess:false — 학원 목록이 비어 있다
//     ② 대표는 그 학원의 메뉴 전체(ACADEMY_MENUS)를 받는다
//   나머지: 위임 강사는 켜진 위임의 메뉴만 · 운영자는 platform_settlement · 2단계 전에도 응답(secondFactorVerified:false)
//   · 세션 없음 401 · 회원 계정 403 · 위임을 끄면 다음 요청부터 메뉴가 빠진다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ACADEMY_MENUS } from "@/lib/domain/staff-menus";
import { createStaffMeRoute, staffMeResponseSchema } from "@/lib/server/services/staff-me";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

const SECRET = "staff-me-test-secret-0123456789-0123456789";
const BASE = "http://localhost:3000";

describe.skipIf(!dbAvailable())("GET /api/staff/me(README §6-1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let GET: ReturnType<typeof createStaffMeRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const academyA = randomUUID();
  const academyB = randomUUID();
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  /** auth.user 하나와 세션 하나. twoFactor=true 면 인증 앱을 켠 계정(2단계를 마친 세션). */
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

  async function makeStaff(key: string, displayName: string, opts: { twoFactor?: boolean; roles?: string[] } = {}) {
    const authUserId = await makeUser(key, opts.twoFactor ?? true);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      authUserId,
      displayName,
    ]);
    for (const role of opts.roles ?? []) {
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    }
    staffIds[key] = id;
  }

  /** active 소속 한 줄 + 위임. permissions 가 비면 소속만 있고 위임은 없다. */
  async function affiliate(staffKey: string, academyId: string, permissions: string[]): Promise<void> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyId, staffIds[staffKey]],
    );
    const affiliationId = (rows[0] as { id: string }).id;
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        p,
        staffIds["owner"],
      ]);
    }
  }

  /** 실제 라우트처럼 GET 을 부르고, 200 이면 본문을 계약 스키마로 검사한다(필드 1대1 — 모르는 키가 있으면 실패). */
  async function me(who?: string) {
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await GET(new Request(`${BASE}/api/staff/me`, { headers }), undefined);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: staffMeResponseSchema.parse(body) };
    return { status: res.status, code: body["code"] };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    GET = createStaffMeRoute({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }) });

    for (const [id, name] of [
      [academyA, "라틴하우스 강남"],
      [academyB, "살사클럽 홍대"],
    ] as const) {
      await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`, [
        id,
        name,
      ]);
    }

    await makeStaff("owner", "김대표", { roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, staffIds["owner"]]);
    // 위임 강사: 학원 A 에 roster_manage, 학원 B 에 class_manage
    await makeStaff("delegate", "이준호", { roles: ["instructor"] });
    await affiliate("delegate", academyA, ["roster_manage"]);
    await affiliate("delegate", academyB, ["class_manage"]);
    // 위임 없는 강사: active 소속은 있지만 위임 행이 없다. 인증 앱도 아직 안 켰다(첫 로그인 직후)
    await makeStaff("plain", "박강사", { roles: ["instructor"], twoFactor: false });
    await affiliate("plain", academyA, []);
    // 운영자
    await makeStaff("admin", "운영자", { roles: ["admin"] });
    // 직원 계정이 없는 사람(회원 쪽 계정)
    await makeUser("member", false);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ① 위임 없는 강사는 consoleAccess:false — 2단계 인증 전에도 판정을 받는다", async () => {
    expect(await me("plain")).toEqual({
      status: 200,
      body: {
        accountId: staffIds["plain"],
        displayName: "박강사",
        roles: ["instructor"],
        secondFactorVerified: false,
        consoleAccess: false,
        academies: [],
        platformMenus: [],
      },
    });
  });

  test("verify ② 대표는 자기 학원의 메뉴 전체를 받는다", async () => {
    expect(await me("owner")).toEqual({
      status: 200,
      body: {
        accountId: staffIds["owner"],
        displayName: "김대표",
        roles: ["owner"],
        secondFactorVerified: true,
        consoleAccess: true,
        academies: [{ academyId: academyA, name: "라틴하우스 강남", as: "owner", permissions: ["owner"], menus: [...ACADEMY_MENUS] }],
        platformMenus: [],
      },
    });
  });

  test("위임 강사는 학원마다 켜진 위임의 메뉴만 받는다", async () => {
    const res = await me("delegate");
    expect(res.status).toBe(200);
    expect(res.body?.consoleAccess).toBe(true);
    expect(res.body?.academies).toHaveLength(2);
    expect(res.body?.academies).toEqual(
      expect.arrayContaining([
        { academyId: academyA, name: "라틴하우스 강남", as: "delegate", permissions: ["roster_manage"], menus: ["roster"] },
        { academyId: academyB, name: "살사클럽 홍대", as: "delegate", permissions: ["class_manage"], menus: ["classes"] },
      ]),
    );
  });

  test("위임을 끄면 다음 요청부터 그 학원 메뉴가 빠진다(매 요청 DB 에서 계산)", async () => {
    await q(
      `DELETE FROM instructor_delegations d USING instructor_affiliations a
       WHERE d.affiliation_id = a.id AND a.instructor_account_id = $1 AND a.academy_id = $2`,
      [staffIds["delegate"], academyB],
    );
    const res = await me("delegate");
    expect(res.body?.academies.map((a) => a.academyId)).toEqual([academyA]);
  });

  test("운영자는 학원 없이 platform_settlement · reports 메뉴를 받는다", async () => {
    expect((await me("admin")).body).toMatchObject({
      roles: ["admin"],
      consoleAccess: true,
      academies: [],
      platformMenus: ["platform_settlement", "reports"],
    });
  });

  test("세션 없음 401 UNAUTHENTICATED · 직원 계정 없음 403 STAFF_ACCOUNT_REQUIRED", async () => {
    expect(await me()).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    expect(await me("member")).toEqual({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
  });
});
