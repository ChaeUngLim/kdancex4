// S0-3.3(직원 로그인 설정) — 아이디·비밀번호 + 인증 앱(TOTP)만 켜졌는지 본다.
//   1 공개 가입은 거절된다(disableSignUp)
//   2 2단계 인증이 켜진 계정이 아이디로 로그인하면 twoFactorRedirect: true 가 오고 세션은 아직 없다
//   3 인증 앱 코드를 내야 세션이 나온다(문자·이메일 방식은 목록에 없다)
//   4 패스키·문자 인증 경로는 404 다
// 직원 계정은 가입 경로가 닫혀 있으므로, 테스트에서는 Better Auth 내부 어댑터로 직접 만든다.
import { createOTP } from "@better-auth/utils/otp";
import { hashPassword } from "better-auth/crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createStaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const SECRET = "staff-auth-test-secret-0123456789-0123456789";
const BASE = "http://localhost:3000";
const USERNAME = "staff_kim";
const PASSWORD = "staff-password-1234";

describe.skipIf(!dbAvailable())("직원 로그인 설정(아이디·비밀번호 + 인증 앱만)", () => {
  let handle: TestDb;
  let handler: ReturnType<typeof toNextJsHandler>;
  const cookies = new Map<string, string>();

  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const post = async (path: string, body: unknown, useCookies = true) => {
    const res = await handler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: useCookies ? cookieHeader() : "" },
        body: JSON.stringify(body),
      }),
    );
    absorb(res);
    return res;
  };
  const getSession = async () => {
    const res = await handler.GET(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: cookieHeader() } }));
    return (await res.json()) as { user?: { username?: string } } | null;
  };
  // 인증 앱이 하는 일: 저장된 비밀값으로 지금 시각의 6자리 코드를 만든다.
  const currentCode = async () => {
    const { rows } = await handle.pool.query<{ secret: string }>('SELECT secret FROM auth."twoFactor" LIMIT 1');
    return createOTP(await symmetricDecrypt({ key: SECRET, data: rows[0]!.secret })).totp();
  };

  beforeAll(async () => {
    handle = openTestDb();
    await handle.pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
    const auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    handler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();

    // 직원 계정 하나를 직접 심는다(가입 경로가 닫혀 있으므로 내부 어댑터를 쓴다).
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({
      email: "staff-kim@example.com",
      name: "김직원",
      emailVerified: true,
      username: USERNAME,
      displayUsername: USERNAME,
    }, { method: "admin" }); // 직원 계정은 운영자가 만든다 — 만든 경로를 「admin」으로 적는다
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(PASSWORD),
    });

    // 인증 앱 등록을 끝낸다: 아이디로 로그인(2단계 전이라 세션이 바로 나온다) → enable → verify-totp.
    await post("/sign-in/username", { username: USERNAME, password: PASSWORD });
    await post("/two-factor/enable", { password: PASSWORD });
    const verified = await post("/two-factor/verify-totp", { code: await currentCode() });
    expect(verified.status).toBe(200);
    cookies.clear(); // 새 브라우저처럼 쿠키를 비운다
  });

  afterAll(async () => {
    await handle.pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("공개 가입은 거절된다", async () => {
    const res = await post("/sign-up/email", { email: "new@example.com", password: "another-pass-1234", name: "누구" }, false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await handle.pool.query("SELECT 1 FROM auth.\"user\" WHERE email = 'new@example.com'");
    expect(rows).toHaveLength(0);
  });

  test("아이디·비밀번호로 로그인하면 twoFactorRedirect: true 가 오고 세션은 아직 없다", async () => {
    const res = await post("/sign-in/username", { username: USERNAME, password: PASSWORD }, false);
    const body = (await res.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    expect(res.status).toBe(200);
    expect(body.twoFactorRedirect).toBe(true);
    expect(body.twoFactorMethods).toEqual(["totp"]); // 문자·이메일(otp)은 목록에 없다
    expect(await getSession()).toBeNull();
  });

  test("틀린 비밀번호는 2단계로 넘어가지 않는다", async () => {
    const res = await post("/sign-in/username", { username: USERNAME, password: "wrong-password-0" }, false);
    const body = (await res.json()) as { twoFactorRedirect?: boolean };
    expect(res.status).toBe(401);
    expect(body.twoFactorRedirect).toBeUndefined();
  });

  test("인증 앱 코드를 내야 세션이 나온다", async () => {
    await post("/sign-in/username", { username: USERNAME, password: PASSWORD }, false);
    const wrong = await post("/two-factor/verify-totp", { code: "000000" });
    const ok = await post("/two-factor/verify-totp", { code: await currentCode() });
    expect(wrong.status).toBe(401);
    expect(ok.status).toBe(200);
    expect((await getSession())?.user?.username).toBe(USERNAME);
  });

  test("패스키·문자 인증 경로는 404 다", async () => {
    const paths = [
      "/passkey/generate-register-options",
      "/sign-in/passkey",
      "/sign-in/phone-number",
      "/phone-number/send-otp",
      "/phone-number/verify",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
    ];
    const statuses: Record<string, number> = {};
    for (const p of paths) statuses[p] = (await post(p, {}, false)).status;
    expect(statuses).toEqual(Object.fromEntries(paths.map((p) => [p, 404])));
  });
});
