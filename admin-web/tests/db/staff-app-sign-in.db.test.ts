// 강사·대표 앱 로그인(2026-11-25 사용자 결정 「앱은 2단계 없이 통과」) — POST /api/auth/sign-in/staff-app
//   관리자 웹에서 인증 앱(TOTP)을 켠 계정도 앱에서는 아이디·비밀번호만으로 토큰을 받는다.
//   그 토큰은 2단계를 마친 세션이 아니므로 관리자 웹 전용 콘솔 경로에서는 그대로 401 SECOND_FACTOR_REQUIRED 다.
//   ① 인증 앱 켠 계정 → 200 + 토큰(쿠키는 안 준다)   ② 그 토큰으로 앱도 부르는 경로(appToo, Bearer) 200
//   ③ 같은 토큰으로 웹 전용 콘솔 경로 401 SECOND_FACTOR_REQUIRED   ④ 틀린 비밀번호·없는 아이디 401(기존 sign-in 과 같은 본문)
//   ⑤ 회원 계정(직원 계정 없음) 거절   ⑥ 정지·탈퇴 직원 거절   ⑦ 같은 아이디 5회 실패 → 429(맞는 비밀번호도 막힌다)
import { randomUUID } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";
import { hashPassword, symmetricDecrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { serializeSignedCookie } from "better-call";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createConsoleRoute } from "@/lib/server/console-route";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import { createStaffAuth, STAFF_APP_SIGN_IN_PATH, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "staff-app-sign-in-test-secret-0123456789-012";
const BASE = "http://localhost:3000";
const PASSWORD = "staff-password-1234";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

type Json = Record<string, unknown>;

describe.skipIf(!dbAvailable())("강사·대표 앱 로그인 — 2단계 없이 토큰, 웹 콘솔은 그대로 2단계(FR-303)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let handler: ReturnType<typeof toNextJsHandler>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const academyId = randomUUID();
  // 학원당 활성 대표는 1명이라 대표마다 학원을 따로 둔다
  const academyIdC1 = randomUUID();
  const academyIdFresh = randomUUID();
  const authIds: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  // 앱이 하듯 쿠키 없이 부른다. 같은 IP 칸을 다른 테스트와 나누지 않도록 테스트마다 IP 를 바꿔 준다.
  async function appSignIn(username: string, password: string, ip = "10.0.0.1"): Promise<{ status: number; body: Json; res: Response }> {
    const res = await handler.POST(
      new Request(`${BASE}/api/auth${STAFF_APP_SIGN_IN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ username, password }),
      }),
    );
    return { status: res.status, body: (await res.clone().json()) as Json, res };
  }
  async function webSignIn(username: string, password: string, cookie = ""): Promise<Response> {
    return handler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ username, password }),
      }),
    );
  }

  /** auth.user + 비밀번호. staff 가 있으면 staff_accounts(상태 지정) + 역할도 만든다. */
  async function makeUser(username: string, staff?: { status: string; roles: string[] }): Promise<void> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${username}@example.com`, name: username, emailVerified: true, username, displayUsername: username },
      { method: "admin" },
    );
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await hashPassword(PASSWORD) });
    authIds[username] = user.id;
    if (!staff) return;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, $4, now())", [
      id,
      user.id,
      username,
      staff.status,
    ]);
    for (const role of staff.roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[username] = id;
  }

  /** 관리자 웹에서 하는 인증 앱 등록(1단계 로그인 → enable → verify-totp)을 진짜 경로로 끝낸다. */
  async function enrollTotp(username: string): Promise<void> {
    const signed = await webSignIn(username, PASSWORD);
    const cookie = signed.headers
      .getSetCookie()
      .map((l) => l.split(";")[0])
      .join("; ");
    const post = (path: string, body: unknown) =>
      handler.POST(new Request(`${BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify(body) }));
    expect((await post("/two-factor/enable", { password: PASSWORD })).status).toBe(200);
    const { rows } = await q('SELECT secret FROM auth."twoFactor" WHERE "userId" = $1', [authIds[username]]);
    const code = await createOTP(await symmetricDecrypt({ key: SECRET, data: (rows[0] as { secret: string }).secret })).totp();
    expect((await post("/two-factor/verify-totp", { code })).status).toBe(200);
  }

  let appTooRoute: (request: Request, ctx: { academyId: string }) => Promise<Response>;
  let webOnlyRoute: (request: Request, ctx: { academyId: string }) => Promise<Response>;
  let staffMe: (request: Request, ctx: unknown) => Promise<Response>;
  /** Better Auth 경로를 Bearer 토큰으로 부른다(앱이 하는 방식). */
  const authPost = (path: string, body: unknown, token: string) =>
    handler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  /** 브라우저가 보내는 것과 같은 「서명된」 세션 쿠키 한 줄. bearer 플러그인이 토큰을 쿠키로 바꿀 때와 같은 서명이다. */
  async function signedSessionCookie(token: string): Promise<string> {
    const name = (await auth.$context).authCookies.sessionToken.name;
    return `${name}=${(await serializeSignedCookie("", token, SECRET)).replace("=", "")}`;
  }
  const bearer = (token: string) => new Request(`${BASE}/api/console/test`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({
      pool: handle.pool,
      secret: SECRET,
      baseURL: BASE,
      // 테스트마다 다른 키 앞말 — 다른 실행의 실패 횟수와 섞이지 않게
      appSignInLimit: {
        limiter: createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:app-sign-in:${randomUUID()}` }),
        rule: RATE_LIMIT_RULES.authFailure,
      },
    });
    handler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();

    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };
    const consoleRoute = createConsoleRoute(deps);
    appTooRoute = consoleRoute<{ academyId: string }>(
      { permission: "owner", academyId: (ctx) => ctx.academyId, appToo: true },
      async (_r, _c, staff) => Response.json({ staffAccountId: staff.staffAccountId }),
    );
    webOnlyRoute = consoleRoute<{ academyId: string }>({ permission: "owner", academyId: (ctx) => ctx.academyId }, async () =>
      Response.json({ ok: true }),
    );
    staffMe = createStaffMeRoute(deps);

    for (const id of [academyId, academyIdC1, academyIdFresh]) {
      await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '앱 로그인 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`, [id]);
    }
    await makeUser("owner_totp", { status: "active", roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner_totp"]]);
    await makeUser("owner_c1", { status: "active", roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIdC1, staffIds["owner_c1"]]);
    await makeUser("owner_fresh", { status: "active", roles: ["owner"] });
    // 2차 재리뷰(R2-C1) 공격용 — 공격이 통하면 인증 앱·비밀번호가 바뀌므로 다른 테스트와 계정을 나눈다
    await makeUser("owner_q", { status: "active", roles: ["owner"] });
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIdFresh, staffIds["owner_fresh"]]);
    await makeUser("member_only"); // 직원 계정이 없는 사용자(회원 쪽 계정과 같은 모양)
    await makeUser("staff_suspended", { status: "suspended", roles: ["instructor"] });
    await makeUser("staff_withdrawn", { status: "withdrawn", roles: ["instructor"] });
    await makeUser("staff_locked", { status: "active", roles: ["instructor"] });
    await enrollTotp("owner_totp");
    await enrollTotp("owner_c1");
    await enrollTotp("owner_q");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("전제: 같은 계정이 관리자 웹 로그인에서는 2단계로 넘어간다", async () => {
    const body = (await (await webSignIn("owner_totp", PASSWORD)).json()) as Json;
    expect(body["twoFactorRedirect"]).toBe(true);
  });

  test("① 인증 앱을 켠 계정도 앱 경로로 200 + 토큰, 쿠키는 주지 않는다", async () => {
    const { status, body, res } = await appSignIn("owner_totp", PASSWORD);
    expect(status).toBe(200);
    expect(typeof body["token"]).toBe("string");
    expect(body["twoFactorRedirect"]).toBeUndefined();
    expect((body["user"] as Json)["username"]).toBe("owner_totp");
    expect(res.headers.getSetCookie()).toEqual([]);
    // 세션 표에는 「2단계를 마치지 않은 세션」으로 남는다
    const { rows } = await q('SELECT "secondFactorVerified" AS v FROM auth.session WHERE token = $1', [body["token"]]);
    expect(rows).toEqual([{ v: false }]);
  });

  test("② 그 토큰으로 앱도 부르는 경로(appToo, Bearer)와 /api/staff/me 는 200", async () => {
    const token = (await appSignIn("owner_totp", PASSWORD)).body["token"] as string;
    const res = await appTooRoute(bearer(token), { academyId });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json)["staffAccountId"]).toBe(staffIds["owner_totp"]);
    const me = await staffMe(bearer(token), {});
    expect(me.status).toBe(200);
    expect(((await me.json()) as Json)["roles"]).toEqual(["owner"]);
  });

  test("③ 같은 토큰으로 웹 전용 콘솔 경로는 401 SECOND_FACTOR_REQUIRED, 쿠키로 넣어도 같다", async () => {
    const token = (await appSignIn("owner_totp", PASSWORD)).body["token"] as string;
    const viaBearer = await webOnlyRoute(bearer(token), { academyId });
    expect(viaBearer.status).toBe(401);
    expect(((await viaBearer.json()) as Json)["code"]).toBe("SECOND_FACTOR_REQUIRED");
    // appToo 경로라도 쿠키 요청은 web 이다 — 토큰을 「서명된 진짜 세션 쿠키」로 넣어 관리자 웹처럼 불러도 2단계에서 막힌다.
    // (서명 없는 값이면 세션을 못 읽어 UNAUTHENTICATED 로 다른 이유에서 통과해 버린다 — 그래서 code 까지 본다)
    const viaCookie = await appTooRoute(new Request(`${BASE}/api/console/test`, { headers: { cookie: await signedSessionCookie(token) } }), { academyId });
    expect(viaCookie.status).toBe(401);
    expect(((await viaCookie.json()) as Json)["code"]).toBe("SECOND_FACTOR_REQUIRED");
  });

  // ---- 보안 리뷰 C1·H1(2026-11-25) — 앱 세션은 2단계 관리·계정 관리 경로를 못 쓴다 ---------------------

  test("C1 앱 토큰으로 인증 앱 끄기 → 다시 등록 → 6자리 확인을 해도 관리자 웹 콘솔이 열리지 않고, 진짜 인증 앱은 그대로다", async () => {
    const before = await q('SELECT u."twoFactorEnabled" AS on, t.secret FROM auth."user" u JOIN auth."twoFactor" t ON t."userId" = u.id WHERE u.id = $1', [
      authIds["owner_c1"],
    ]);
    let token = (await appSignIn("owner_c1", PASSWORD, "10.0.9.1")).body["token"] as string;
    const next = (res: Response) => res.headers.get("set-auth-token") ?? token;

    // 공격자가 비밀번호를 안다고 보고 리뷰의 공격 순서를 그대로 밟는다
    const disabled = await authPost("/two-factor/disable", { password: PASSWORD }, token);
    token = next(disabled);
    const enabled = await authPost("/two-factor/enable", { password: PASSWORD }, token);
    token = next(enabled);
    let lastCookie = "";
    if (enabled.status === 200) {
      const { rows } = await q('SELECT secret FROM auth."twoFactor" WHERE "userId" = $1', [authIds["owner_c1"]]);
      const code = await createOTP(await symmetricDecrypt({ key: SECRET, data: (rows[0] as { secret: string }).secret })).totp();
      const verified = await authPost("/two-factor/verify-totp", { code }, token);
      token = next(verified);
      lastCookie = verified.headers.getSetCookie().map((l) => l.split(";")[0]).join("; ");
    }

    // 끝에 손에 쥔 토큰·쿠키 어느 쪽으로도 웹 전용 콘솔은 열리지 않는다
    expect((await webOnlyRoute(bearer(token), { academyId: academyIdC1 })).status).toBe(401);
    if (lastCookie !== "") {
      expect((await webOnlyRoute(new Request(`${BASE}/api/console/test`, { headers: { cookie: lastCookie } }), { academyId: academyIdC1 })).status).toBe(401);
    }
    // 첫 단계에서 막힌다 — 진짜 대표의 인증 앱(비밀값)은 바뀌지 않는다
    expect(disabled.status).toBe(403);
    expect(((await disabled.clone().json()) as Json)["code"]).toBe("APP_SESSION_FORBIDDEN");
    const after = await q('SELECT u."twoFactorEnabled" AS on, t.secret FROM auth."user" u JOIN auth."twoFactor" t ON t."userId" = u.id WHERE u.id = $1', [
      authIds["owner_c1"],
    ]);
    expect(after.rows).toEqual(before.rows);
  });

  test("H1 앱 토큰으로 2단계·계정 관리 경로는 모두 403 APP_SESSION_FORBIDDEN, 세션 읽기·로그아웃만 된다", async () => {
    const token = (await appSignIn("owner_totp", PASSWORD, "10.0.9.2")).body["token"] as string;
    const blockedPosts = [
      "/two-factor/enable",
      "/two-factor/disable",
      "/two-factor/verify-totp",
      "/change-password",
      "/change-email",
      "/delete-user",
      "/update-user",
      "/update-session",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
      "/unlink-account",
      "/link-social",
      "/verify-password",
      "/get-access-token",
      "/refresh-token",
      "/send-verification-email",
      "/request-password-reset",
      "/sign-in/username",
      "/sign-in/email",
    ];
    const blockedGets = ["/list-sessions", "/list-accounts", "/account-info"];
    const statuses: Record<string, string> = {};
    const body = { password: PASSWORD, newPassword: "taken-over-pass-99", currentPassword: PASSWORD, revokeOtherSessions: true, name: "x", newEmail: "x@example.com", token: "t", code: "000000", providerId: "credential" };
    for (const p of blockedPosts) {
      const res = await authPost(p, body, token);
      statuses[p] = `${res.status} ${((await res.json().catch(() => ({}))) as Json)["code"] ?? ""}`;
    }
    for (const p of blockedGets) {
      const res = await handler.GET(new Request(`${BASE}/api/auth${p}`, { headers: { authorization: `Bearer ${token}` } }));
      statuses[p] = `${res.status} ${((await res.json().catch(() => ({}))) as Json)["code"] ?? ""}`;
    }
    const all = [...blockedPosts, ...blockedGets];
    expect(statuses).toEqual(Object.fromEntries(all.map((p) => [p, "403 APP_SESSION_FORBIDDEN"])));
    // 인증 앱 비밀값 읽기 경로는 누가 불러도 없는 경로(404)다 — 보안 리뷰 r3 LOW-1
    expect((await authPost("/two-factor/get-totp-uri", body, token)).status).toBe(404);
    // 비밀번호는 그대로다(바꾸기가 실제로 안 됐다)
    expect((await appSignIn("owner_totp", PASSWORD, "10.0.9.3")).status).toBe(200);

    // 허용: 세션 읽기 → 200, 로그아웃 → 200 이고 그 뒤 토큰은 죽는다
    const session = await handler.GET(new Request(`${BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } }));
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user?: Json })?.user?.["username"]).toBe("owner_totp");
    expect((await authPost("/sign-out", {}, token)).status).toBe(200);
    expect((await webOnlyRoute(bearer(token), { academyId })).status).toBe(401);
    expect((await appTooRoute(bearer(token), { academyId })).status).toBe(401);
  });

  test("H1 서명된 쿠키로 앱 세션을 넣어도 2단계 관리 경로는 403", async () => {
    const token = (await appSignIn("owner_totp", PASSWORD, "10.0.9.4")).body["token"] as string;
    const res = await handler.POST(
      new Request(`${BASE}/api/auth/two-factor/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: await signedSessionCookie(token) },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Json)["code"]).toBe("APP_SESSION_FORBIDDEN");
  });

  // ---- 2차 재리뷰 R2-C1 — 쿠키를 Better Auth 와 다르게 읽으면 허용 목록 훅을 건너뛴다 ---------------------

  /** 서명된 쿠키 값(인코딩 전 「TOKEN.서명」). */
  async function signedValue(token: string): Promise<string> {
    return decodeURIComponent((await serializeSignedCookie("", token, SECRET)).replace("=", ""));
  }
  const cookieName = async () => (await auth.$context).authCookies.sessionToken.name;
  const rawPost = (path: string, body: unknown, headers: Record<string, string>) =>
    handler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );
  /** 계정의 2단계 상태와 비밀값·비밀번호 해시 — 공격 뒤 하나도 바뀌지 않았는지 본다. */
  const accountState = async (username: string) =>
    (
      await q(
        `SELECT u."twoFactorEnabled" AS on, t.secret, a.password FROM auth."user" u
           JOIN auth."twoFactor" t ON t."userId" = u.id JOIN auth.account a ON a."userId" = u.id AND a."providerId" = 'credential'
          WHERE u.id = $1`,
        [authIds[username]],
      )
    ).rows;

  test("R2-C1 따옴표로 감싼 서명 쿠키로도 2단계 끄기·비밀번호 바꾸기는 403, 계정 값은 그대로", async () => {
    const before = await accountState("owner_q");
    const token = (await appSignIn("owner_q", PASSWORD, "10.0.8.1")).body["token"] as string;
    const cookie = `${await cookieName()}="${await signedValue(token)}"`;
    const disable = await rawPost("/two-factor/disable", { password: PASSWORD }, { cookie });
    const change = await rawPost("/change-password", { currentPassword: PASSWORD, newPassword: "taken-over-pass-99", revokeOtherSessions: true }, { cookie });
    const revoke = await rawPost("/revoke-sessions", {}, { cookie });
    expect([disable.status, change.status, revoke.status]).toEqual([403, 403, 403]);
    expect(((await disable.json()) as Json)["code"]).toBe("APP_SESSION_FORBIDDEN");
    expect(await accountState("owner_q")).toEqual(before);
  });

  test("R2-C1 퍼센트 인코딩 쿠키 · 쿠키+Bearer 동시(앞뒤 바꿔도) 모두 403", async () => {
    const before = await accountState("owner_q");
    const token = (await appSignIn("owner_q", PASSWORD, "10.0.8.2")).body["token"] as string;
    const name = await cookieName();
    const encoded = `${name}=${encodeURIComponent(await signedValue(token))}`;
    // 웹 1단계 세션 하나(인증 앱 없는 다른 계정이 아니라 쓸모없는 값) — Bearer 는 엉터리, 쿠키는 앱 세션
    const cases: Record<string, string>[] = [
      { cookie: encoded },
      { cookie: `${name}="${await signedValue(token)}"`, authorization: "Bearer not-a-real-token" },
      { cookie: `${name}=garbage.value`, authorization: `Bearer ${token}` },
      { cookie: `${name}="${await signedValue(token)}"`, authorization: `Bearer ${await signedValue(token)}` },
    ];
    const statuses = [];
    for (const headers of cases) statuses.push((await rawPost("/two-factor/disable", { password: PASSWORD }, headers)).status);
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(await accountState("owner_q")).toEqual(before);
  });

  test("R2-C1 /get-session 갱신 응답으로 받은 서명 쿠키를 따옴표로 감싸 써도 403", async () => {
    const before = await accountState("owner_q");
    const token = (await appSignIn("owner_q", PASSWORD, "10.0.8.3")).body["token"] as string;
    // 하루 넘게 지난 세션처럼 만든다(만료까지 6일 남음 → get-session 이 갱신하며 서명 쿠키를 내준다)
    await q(`UPDATE auth.session SET "expiresAt" = now() + interval '6 days' WHERE token = $1`, [token]);
    const refreshed = await handler.GET(new Request(`${BASE}/api/auth/get-session`, { headers: { authorization: `Bearer ${token}` } }));
    expect(refreshed.status).toBe(200);
    const name = await cookieName();
    const issued = refreshed.headers
      .getSetCookie()
      .map((l) => l.split(";")[0] ?? "")
      .find((pair) => pair.startsWith(`${name}=`));
    expect(issued).toBeDefined(); // 서명된 값을 실제로 얻을 수 있다는 리뷰 전제를 확인
    const value = decodeURIComponent(issued!.slice(name.length + 1));
    const disable = await rawPost("/two-factor/disable", { password: PASSWORD }, { cookie: `${name}="${value}"` });
    expect(disable.status).toBe(403);
    expect(await accountState("owner_q")).toEqual(before);
  });

  test("회귀: 웹 세션의 정상 인증 앱 등록(웹 로그인 → enable → verify-totp)은 그대로 되고 콘솔이 열린다", async () => {
    await enrollTotp("owner_fresh"); // 안에서 enable·verify-totp 가 200 인지 본다
    const { rows } = await q('SELECT "secondFactorVerified" AS v, "appSession" AS app FROM auth.session WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [
      authIds["owner_fresh"],
    ]);
    expect(rows).toEqual([{ v: true, app: false }]);
    const token = (await q('SELECT token FROM auth.session WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [authIds["owner_fresh"]])).rows[0] as { token: string };
    const res = await webOnlyRoute(new Request(`${BASE}/api/console/test`, { headers: { cookie: await signedSessionCookie(token.token) } }), { academyId: academyIdFresh });
    expect(res.status).toBe(200);
  });

  test("④ 틀린 비밀번호·없는 아이디는 401, 기존 아이디 로그인과 같은 본문(계정이 있는지 흘리지 않는다)", async () => {
    const wrong = await appSignIn("owner_totp", "wrong-password-0", "10.0.0.4");
    const missing = await appSignIn("nobody_here", PASSWORD, "10.0.0.4");
    const legacy = (await (await webSignIn("owner_totp", "wrong-password-0")).json()) as Json;
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body).toEqual(legacy);
    expect(missing.body).toEqual(legacy);
  });

  test("⑤ 직원 계정이 없는 사용자(회원)는 비밀번호가 맞아도 403 STAFF_ACCOUNT_REQUIRED, 세션도 남지 않는다", async () => {
    const res = await appSignIn("member_only", PASSWORD, "10.0.0.5");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "STAFF_ACCOUNT_REQUIRED", detail: "직원 계정으로 로그인해 주세요" });
    expect(res.body["token"]).toBeUndefined();
    const { rows } = await q('SELECT count(*)::int AS n FROM auth.session WHERE "userId" = $1', [authIds["member_only"]]);
    expect(rows).toEqual([{ n: 0 }]);
  });

  test("⑥ 정지 직원은 403 ACCOUNT_SUSPENDED, 탈퇴 직원은 403 STAFF_ACCOUNT_REQUIRED", async () => {
    const suspended = await appSignIn("staff_suspended", PASSWORD, "10.0.0.6");
    const withdrawn = await appSignIn("staff_withdrawn", PASSWORD, "10.0.0.6");
    expect(suspended).toMatchObject({ status: 403, body: { code: "ACCOUNT_SUSPENDED" } });
    expect(withdrawn).toMatchObject({ status: 403, body: { code: "STAFF_ACCOUNT_REQUIRED" } });
    const { rows } = await q('SELECT count(*)::int AS n FROM auth.session WHERE "userId" = ANY($1)', [
      [authIds["staff_suspended"], authIds["staff_withdrawn"]],
    ]);
    expect(rows).toEqual([{ n: 0 }]);
  });

  test("⑦ 같은 아이디로 5회 틀리면 IP 를 바꿔도 429 RATE_LIMITED, 맞는 비밀번호도 막힌다", async () => {
    for (let i = 0; i < RATE_LIMIT_RULES.authFailure.limit; i++) {
      expect((await appSignIn("staff_locked", "wrong-password-0", `10.0.1.${i}`)).status).toBe(401);
    }
    const blocked = await appSignIn("staff_locked", PASSWORD, "10.0.2.1");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "RATE_LIMITED", detail: expect.any(String) });
    expect(Number(blocked.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("⑦ 같은 IP 에서 아이디를 바꿔 가며 5회 틀려도 429", async () => {
    for (let i = 0; i < RATE_LIMIT_RULES.authFailure.limit; i++) {
      expect((await appSignIn(`guess_${i}`, "wrong-password-0", "10.0.3.3")).status).toBe(401);
    }
    expect((await appSignIn("owner_totp", PASSWORD, "10.0.3.3")).status).toBe(429);
  });
});
