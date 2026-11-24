// S0-3.8(관리자 웹 2단계 인증 게이트) — 2단계를 마친 세션만 콘솔 경로를 쓰고, 대표는 운영자 역할을 줄 수 없다.
//   verify ① 1단계(비밀번호)만 마친 세션은 콘솔 경로에서 401 SECOND_FACTOR_REQUIRED
//   verify ② 대표가 운영자(admin) 역할을 주려 하면 403 FORBIDDEN, role_grants·audit_logs 에 아무것도 남지 않는다
// 세션은 손으로 만들지 않고 진짜 로그인 경로(/api/auth/sign-in/username → two-factor/enable → verify-totp)로 만든다.
// 「인증 앱 등록 전에 만든 세션」이 등록 뒤에도 콘솔을 열지 못하는지(S0-3.6 에서 남긴 빈틈)도 같이 본다.
import { randomUUID } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";
import { hashPassword, symmetricDecrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { STAFF_ROLE_NAMES } from "@/lib/domain/constants";
import { createConsoleRoute, type ConsoleRoute } from "@/lib/server/console-route";
import { parseJsonBody } from "@/lib/server/http";
import { createRoleGrantService } from "@/lib/server/services/role-grants";
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

const SECRET = "second-factor-gate-test-secret-0123456789-01";
const BASE = "http://localhost:3000";
const PASSWORD = "staff-password-1234";

/** 브라우저 하나(= 기기 하나)의 쿠키 상자. */
class Device {
  readonly cookies = new Map<string, string>();
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // 지우는 쿠키(Max-Age=0)는 상자에서 뺀다
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

const grantBodySchema = z.strictObject({ staffAccountId: z.uuid(), role: z.enum(STAFF_ROLE_NAMES) });

describe.skipIf(!dbAvailable())("관리자 웹 2단계 인증 게이트(FR-303)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let handler: ReturnType<typeof toNextJsHandler>;
  let consoleRoute: ConsoleRoute;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const academyA = randomUUID();
  // 학원당 활성 대표는 1명이라(uq_academy_owners_active) 대표마다 학원을 따로 둔다
  const academyFresh = randomUUID();
  const academyPlain = randomUUID();
  const staffIds: Record<string, string> = {};
  const authIds: Record<string, string> = {};

  // ---- 로그인 도우미(진짜 Better Auth 경로) -------------------------------------------------
  async function post(device: Device, path: string, body: unknown): Promise<Response> {
    const res = await handler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: device.header() },
        body: JSON.stringify(body),
      }),
    );
    device.absorb(res);
    return res;
  }
  const signIn = (device: Device, username: string) => post(device, "/sign-in/username", { username, password: PASSWORD });
  // 인증 앱이 하는 일: 저장된 비밀값으로 지금 시각의 6자리 코드를 만든다
  async function currentCode(username: string): Promise<string> {
    const { rows } = await q('SELECT t.secret FROM auth."twoFactor" t WHERE t."userId" = $1', [authIds[username]]);
    return createOTP(await symmetricDecrypt({ key: SECRET, data: (rows[0] as { secret: string }).secret })).totp();
  }
  /** 이미 1단계 세션이 있는 기기에서 인증 앱을 등록한다(enable → verify-totp). */
  async function enroll(device: Device, username: string): Promise<void> {
    expect((await post(device, "/two-factor/enable", { password: PASSWORD })).status).toBe(200);
    expect((await post(device, "/two-factor/verify-totp", { code: await currentCode(username) })).status).toBe(200);
  }
  /** 등록을 마친 계정이 새 기기에서 비밀번호 → 6자리로 들어온다. */
  async function fullSignIn(username: string): Promise<Device> {
    const device = new Device();
    const first = (await (await signIn(device, username)).json()) as { twoFactorRedirect?: boolean };
    expect(first.twoFactorRedirect).toBe(true);
    expect((await post(device, "/two-factor/verify-totp", { code: await currentCode(username) })).status).toBe(200);
    return device;
  }

  /** 직원 하나: auth.user(아이디·비밀번호) + staff_accounts + 역할. */
  async function makeStaff(username: string, roles: string[]): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${username}@example.com`, name: username, emailVerified: true, username, displayUsername: username },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(PASSWORD),
    });
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, $3, now())", [
      id,
      user.id,
      username,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[username] = id;
    authIds[username] = user.id;
  }

  // ---- 시험용 콘솔 경로 ---------------------------------------------------------------------
  type Params = { academyId: string };
  // 학원 A 의 명단 메뉴(위임·대표) — 2단계 게이트만 본다
  let rosterRoute: (request: Request, ctx: Params) => Promise<Response>;
  // 역할 부여 — 대표 자격 경로와 운영자 자격 경로 둘. 둘 다 같은 grantRole 을 부른다
  let ownerGrantRoute: (request: Request, ctx: Params) => Promise<Response>;
  let adminGrantRoute: (request: Request, ctx: Record<string, never>) => Promise<Response>;
  let staffMe: (request: Request, ctx: unknown) => Promise<Response>;

  const consoleGet = (device: Device) => new Request(`${BASE}/api/console/test`, { headers: { cookie: device.header() } });
  const consolePost = (device: Device, body: unknown) =>
    new Request(`${BASE}/api/console/role-grants`, {
      method: "POST",
      headers: { cookie: device.header(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  async function read(res: Response): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    handler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();

    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    consoleRoute = createConsoleRoute(deps);
    const grants = createRoleGrantService({ db: handle.db });
    rosterRoute = consoleRoute<Params>({ permission: "roster_manage", academyId: (ctx) => ctx.academyId }, async (_r, _c, staff) =>
      Response.json({ staffAccountId: staff.staffAccountId }),
    );
    const grantHandler = async (request: Request, _ctx: unknown, staff: Parameters<typeof grants.grantRole>[0]) =>
      Response.json(await grants.grantRole(staff, await parseJsonBody(request, grantBodySchema)), { status: 201 });
    ownerGrantRoute = consoleRoute<Params>({ permission: "owner", academyId: (ctx) => ctx.academyId }, grantHandler);
    adminGrantRoute = consoleRoute<Record<string, never>>({ permission: "admin" }, grantHandler);
    staffMe = createStaffMeRoute(deps);

    for (const id of [academyA, academyFresh, academyPlain]) {
      await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '게이트 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`, [id]);
    }
    await makeStaff("owner_a", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, staffIds["owner_a"]]);
    await makeStaff("admin_p", ["admin"]);
    await makeStaff("instructor_t", ["instructor"]); // 역할을 받을 대상
    await makeStaff("fresh_owner", ["owner"]); // 아직 인증 앱을 등록하지 않은 대표
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyFresh, staffIds["fresh_owner"]]);
    await makeStaff("plain_owner", ["owner"]); // 인증 앱을 끝내 등록하지 않는 대표
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyPlain, staffIds["plain_owner"]]);

    // owner_a · admin_p 는 인증 앱 등록을 마쳐 둔다(1단계 로그인 → 등록)
    for (const name of ["owner_a", "admin_p"]) {
      const d = new Device();
      await signIn(d, name);
      await enroll(d, name);
    }
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ① 인증 앱이 없는 계정의 1단계(비밀번호) 세션은 콘솔 경로 401 SECOND_FACTOR_REQUIRED", async () => {
    const device = new Device();
    const signed = await signIn(device, "plain_owner");
    expect(signed.status).toBe(200);
    expect(((await signed.clone().json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBeUndefined(); // 세션이 바로 나온다

    const res = await read(await rosterRoute(consoleGet(device), { academyId: academyPlain }));
    expect(res).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    // 같은 세션으로 역할 부여 경로도 2단계에서 먼저 막힌다(권한 판정까지 가지 않는다)
    const grant = await read(await ownerGrantRoute(consolePost(device, { staffAccountId: staffIds["instructor_t"], role: "owner" }), { academyId: academyPlain }));
    expect(grant).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    // 화면용 정보 조회는 막지 않고 값으로 알려 준다(§6-1)
    const me = await read(await staffMe(consoleGet(device), {}));
    expect(me.status).toBe(200);
    expect(me.body["secondFactorVerified"]).toBe(false);
  });

  test("verify ① 인증 앱 등록 전에 만든 다른 기기의 세션은 등록 뒤에도 401, 등록한 기기는 200", async () => {
    const oldDevice = new Device();
    await signIn(oldDevice, "fresh_owner"); // 등록 전 1단계 세션(다른 기기)
    const newDevice = new Device();
    await signIn(newDevice, "fresh_owner");
    await enroll(newDevice, "fresh_owner"); // 이 기기에서 인증 앱 등록 → 플러그인이 새 세션을 준다

    expect(await read(await rosterRoute(consoleGet(newDevice), { academyId: academyFresh }))).toMatchObject({ status: 200 });
    expect(await read(await rosterRoute(consoleGet(oldDevice), { academyId: academyFresh }))).toMatchObject({
      status: 401,
      code: "SECOND_FACTOR_REQUIRED",
    });
    // 옛 세션은 Better Auth 기준으로는 아직 살아 있다 — 그래서 세션 단위 표시가 필요했다
    const { rows } = await q('SELECT "secondFactorVerified" AS v FROM auth.session WHERE "userId" = $1 ORDER BY "createdAt"', [
      authIds["fresh_owner"],
    ]);
    expect(rows.map((r) => (r as { v: boolean }).v)).toEqual([false, true]);
  });

  test("등록을 마친 계정은 비밀번호만으로 세션이 없고, 6자리를 내야 콘솔 200", async () => {
    const half = new Device();
    const first = (await (await signIn(half, "owner_a")).json()) as { twoFactorRedirect?: boolean };
    expect(first.twoFactorRedirect).toBe(true);
    expect(await read(await rosterRoute(consoleGet(half), { academyId: academyA }))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });

    const full = await fullSignIn("owner_a");
    expect(await read(await rosterRoute(consoleGet(full), { academyId: academyA }))).toMatchObject({ status: 200 });
    const me = await read(await staffMe(consoleGet(full), {}));
    expect(me.body["secondFactorVerified"]).toBe(true);
  });

  test("세션의 2단계 표시는 요청 본문으로 바꿀 수 없다(input: false)", async () => {
    const device = new Device();
    await post(device, "/sign-in/username", { username: "plain_owner", password: PASSWORD, secondFactorVerified: true });
    expect(await read(await rosterRoute(consoleGet(device), { academyId: academyPlain }))).toMatchObject({
      status: 401,
      code: "SECOND_FACTOR_REQUIRED",
    });
  });

  test("verify ② 대표가 운영자 역할을 주려 하면 403, role_grants·audit_logs 변화 없음", async () => {
    const owner = await fullSignIn("owner_a");
    const before = await q("SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin'");
    const auditBefore = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'role_grant.changed'");

    for (const target of [staffIds["instructor_t"], staffIds["owner_a"]]) {
      const res = await read(await ownerGrantRoute(consolePost(owner, { staffAccountId: target, role: "admin" }), { academyId: academyA }));
      expect(res).toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
    // 대표는 다른 사람을 대표로 만들 수도 없다 — 대표 역할은 운영자의 입점 승인으로만 생긴다
    const ownerGrant = await read(
      await ownerGrantRoute(consolePost(owner, { staffAccountId: staffIds["instructor_t"], role: "owner" }), { academyId: academyA }),
    );
    expect(ownerGrant).toMatchObject({ status: 403, code: "FORBIDDEN" });

    expect((await q("SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin'")).rows).toEqual(before.rows);
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'role_grant.changed'")).rows).toEqual(auditBefore.rows);
  });

  test("운영자도 API 로는 운영자를 만들지 못한다(플랫폼 스크립트만), 대표 역할은 줄 수 있고 감사 1행", async () => {
    const admin = await fullSignIn("admin_p");
    const adminGrant = await read(await adminGrantRoute(consolePost(admin, { staffAccountId: staffIds["instructor_t"], role: "admin" }), {}));
    expect(adminGrant).toMatchObject({ status: 403, code: "FORBIDDEN" });

    const first = await read(await adminGrantRoute(consolePost(admin, { staffAccountId: staffIds["instructor_t"], role: "owner" }), {}));
    expect(first.status).toBe(201);
    expect(first.body["created"]).toBe(true);
    // 같은 요청을 다시 보내도 켜진 역할은 하나다(이미 있으면 그대로)
    const again = await read(await adminGrantRoute(consolePost(admin, { staffAccountId: staffIds["instructor_t"], role: "owner" }), {}));
    expect(again.body).toEqual({ roleGrantId: first.body["roleGrantId"], created: false });

    const { rows } = await q(
      "SELECT actor_staff_account_id, target_id FROM audit_logs WHERE action = 'role_grant.changed' AND target_id = $1",
      [first.body["roleGrantId"]],
    );
    expect(rows).toEqual([{ actor_staff_account_id: staffIds["admin_p"], target_id: first.body["roleGrantId"] }]);
    expect((await q("SELECT count(*)::int AS n FROM role_grants WHERE role = 'admin' AND staff_account_id = $1", [staffIds["instructor_t"]])).rows).toEqual([
      { n: 0 },
    ]);
  });

  test("운영자 경로도 1단계 세션이면 401(권한 판정 ④보다 먼저)", async () => {
    // admin_p 는 등록을 마쳤으므로, 1단계 세션을 얻으려고 새 운영자를 등록 없이 만든다
    await makeStaff("admin_nofa", ["admin"]);
    const device = new Device();
    await signIn(device, "admin_nofa");
    const res = await read(await adminGrantRoute(consolePost(device, { staffAccountId: staffIds["instructor_t"], role: "owner" }), {}));
    expect(res).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
  });
});
