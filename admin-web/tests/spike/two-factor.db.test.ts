// SP-8(인증 앱 TOTP 플러그인 실측) — Better Auth 의 two-factor 플러그인이
//   `auth` 스키마 + 같은 BYO 풀에서 도는지 본다.
//   흐름: 등록(enable) → 확인(verify-totp) → 로그인 2단계(세션 발급) → 같은 기기 30일 쿠키(trust_device).
//   문자·이메일 OTP(otpOptions.sendOTP)와 패스키 플러그인은 켜지 않는다 — TOTP 하나만 시험한다.
//   측정값은 평소에 찍지 않고 `SPIKE_REPORT=1` 로 돌릴 때만 맨 끝에 덤프한다.
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

const TEST_SECRET = "spike-only-secret-spike-only-secret-0123456789";
const BASE = "http://localhost:3000";
const EMAIL = "spike-2fa@example.com";
const PASSWORD = "spike-password-1234";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

const SPIKE_REPORT = process.env.SPIKE_REPORT === "1";
const results: Record<string, unknown> = {};

// 브라우저 쿠키 통에 해당한다: 응답의 set-cookie 를 모아 다음 요청에 되돌려 보낸다.
class Jar {
  private cookies = new Map<string, string>();
  raw: string[] = [];
  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      this.raw.push(line);
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // Max-Age=0 이거나 값이 비면 지운 것으로 본다.
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  has(namePart: string): boolean {
    return [...this.cookies.keys()].some((k) => k.includes(namePart));
  }
  /** 이름 조각이 들어간 쿠키를 설정한 마지막 set-cookie 줄(속성 확인용). */
  lastSetLine(namePart: string): string | undefined {
    return [...this.raw].reverse().find((l) => l.split("=")[0]?.includes(namePart));
  }
  clone(only?: (name: string) => boolean): Jar {
    const j = new Jar();
    for (const [k, v] of this.cookies) if (!only || only(k)) j.cookies.set(k, v);
    return j;
  }
}

describe.skipIf(!dbAvailable())("SP-8 two-factor(TOTP) 스파이크", () => {
  let handle: TestDb;
  let auth: ReturnType<typeof buildAuth>;
  let handler: ReturnType<typeof toNextJsHandler>;

  function buildAuth(h: TestDb) {
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: h.pool }) });
    return betterAuth({
      secret: TEST_SECRET,
      baseURL: BASE,
      appName: "K-DanceX4",
      database: { db, type: "postgres", schemaName: "auth" },
      emailAndPassword: { enabled: true },
      // TOTP 만 쓴다: otpOptions.sendOTP 를 주지 않으면 문자·이메일 OTP 경로는 꺼진다.
      plugins: [twoFactor({ issuer: "K-DanceX4" })],
    });
  }

  async function post(path: string, body: unknown, jar: Jar) {
    const res = await handler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: jar.header() },
        body: JSON.stringify(body),
      }),
    );
    jar.absorb(res);
    return res;
  }
  async function getSession(jar: Jar) {
    const res = await handler.GET(
      new Request(`${BASE}/api/auth/get-session`, { headers: { cookie: jar.header() } }),
    );
    return (await res.json()) as { user?: { email?: string; twoFactorEnabled?: boolean } } | null;
  }

  // 인증 앱이 하는 일: 저장된 비밀값으로 지금 시각의 6자리 코드를 만든다.
  async function currentCode(): Promise<string> {
    const { rows } = await handle.pool.query<{ secret: string }>('SELECT secret FROM auth."twoFactor" LIMIT 1');
    const secret = await symmetricDecrypt({ key: TEST_SECRET, data: rows[0]!.secret });
    return createOTP(secret).totp();
  }

  async function cleanup(h: TestDb) {
    await h.pool.query("DROP SCHEMA IF EXISTS auth CASCADE");
  }

  const phone = new Jar(); // 사용자의 브라우저(같은 기기)
  let backupCodes: string[] = [];

  beforeAll(async () => {
    handle = openTestDb();
    await cleanup(handle);
    auth = buildAuth(handle);
    handler = toNextJsHandler(auth);
    const { runMigrations, toBeCreated } = await getMigrations(auth.options);
    await runMigrations();
    results.createdTables = toBeCreated.map((t) => t.table);
    // 가입 + 로그인(아직 2단계 인증 전이므로 바로 세션이 나온다)
    await post("/sign-up/email", { email: EMAIL, password: PASSWORD, name: "스파이크" }, phone);
    await post("/sign-in/email", { email: EMAIL, password: PASSWORD }, phone);
  });

  afterAll(async () => {
    await cleanup(handle);
    await closeTestDb(handle);
    if (SPIKE_REPORT) process.stdout.write("\n[SP-8 측정값]\n" + JSON.stringify(results, null, 2) + "\n");
  });

  test("1 등록: enable 이 비밀값·otpauth URI·백업 코드를 주고, 확인 전에는 2단계가 켜지지 않는다", async () => {
    const res = await post("/two-factor/enable", { password: PASSWORD }, phone);
    const body = (await res.json()) as { method: string; totpURI: string; backupCodes: string[] };
    backupCodes = body.backupCodes;

    // 표 위치: twoFactor 테이블이 auth 스키마 안에 생겼는가(같은 풀)
    const { rows: tbl } = await handle.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='auth' ORDER BY 1",
    );
    const { rows: pub } = await handle.pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE 'twofactor'",
    );
    const { rows: tf } = await handle.pool.query<{ verified: boolean; secret: string }>(
      'SELECT verified, secret FROM auth."twoFactor"',
    );
    const { rows: usr } = await handle.pool.query<{ twoFactorEnabled: boolean }>(
      'SELECT "twoFactorEnabled" FROM auth."user"',
    );
    results.enable = {
      status: res.status,
      method: body.method,
      uriPrefix: body.totpURI.slice(0, 40),
      backupCodeCount: backupCodes.length,
      authTables: tbl.map((t) => t.table_name),
      twoFactorInPublic: pub.length,
      verifiedAfterEnable: tf[0]?.verified,
      secretStoredEncrypted: tf[0]?.secret !== undefined && !/^[A-Z2-7]{16,}$/.test(tf[0]!.secret),
      userTwoFactorEnabledAfterEnable: usr[0]?.twoFactorEnabled,
    };

    expect(res.status).toBe(200);
    expect(body.method).toBe("totp");
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.totpURI).toContain("issuer=K-DanceX4");
    expect(backupCodes.length).toBeGreaterThan(0);
    expect(tbl.map((t) => t.table_name)).toContain("twoFactor");
    expect(pub).toHaveLength(0); // public 을 침범하지 않는다
    expect(tf[0]?.verified).toBe(false); // 확인 전
    expect(usr[0]?.twoFactorEnabled).toBe(false);
  });

  test("2 확인: 앱이 만든 코드로 verify-totp 하면 2단계가 켜지고, 틀린 코드는 거부된다", async () => {
    // 틀린 코드는 401(세션이 있는 등록 단계에서도 코드는 검사한다)
    const bad = await post("/two-factor/verify-totp", { code: "000000" }, phone);
    const good = await post("/two-factor/verify-totp", { code: await currentCode() }, phone);
    const { rows: tf } = await handle.pool.query<{ verified: boolean }>('SELECT verified FROM auth."twoFactor"');
    const { rows: usr } = await handle.pool.query<{ twoFactorEnabled: boolean }>(
      'SELECT "twoFactorEnabled" FROM auth."user"',
    );
    results.verify = { wrongStatus: bad.status, goodStatus: good.status, verified: tf[0]?.verified, userEnabled: usr[0]?.twoFactorEnabled };

    expect(bad.status).toBe(401);
    expect(good.status).toBe(200);
    expect(tf[0]?.verified).toBe(true);
    expect(usr[0]?.twoFactorEnabled).toBe(true);
    expect((await getSession(phone))?.user?.twoFactorEnabled).toBe(true); // 세션도 새로 발급돼 이어진다
  });

  test("3 세션 발급: 2단계가 켜진 계정은 비밀번호만으로 세션이 안 나오고, 코드를 내야 세션이 나온다", async () => {
    // 새 브라우저(쿠키 없음)에서 로그인
    const fresh = new Jar();
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD }, fresh);
    const signInBody = (await signIn.json()) as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    const sessionBefore = await getSession(fresh);

    const wrong = await post("/two-factor/verify-totp", { code: "000000" }, fresh);
    const ok = await post("/two-factor/verify-totp", { code: await currentCode() }, fresh);
    const sessionAfter = await getSession(fresh);

    results.signIn2fa = {
      redirect: signInBody.twoFactorRedirect,
      methods: signInBody.twoFactorMethods,
      hasTwoFactorCookie: fresh.has("two_factor") || fresh.raw.some((l) => l.includes("two_factor")),
      sessionBeforeCode: sessionBefore,
      wrongStatus: wrong.status,
      okStatus: ok.status,
      sessionAfterEmail: sessionAfter?.user?.email,
    };

    expect(signIn.status).toBe(200);
    expect(signInBody.twoFactorRedirect).toBe(true);
    expect(signInBody.twoFactorMethods).toEqual(["totp"]); // otp(문자·이메일)는 꺼져 있다
    expect(sessionBefore).toBeNull(); // 코드 전에는 세션이 없다
    expect(wrong.status).toBe(401);
    expect(ok.status).toBe(200);
    expect(sessionAfter?.user?.email).toBe(EMAIL);
  });

  test("4 trust_device: trustDevice 로 확인하면 30일 쿠키가 생기고, 다음 로그인은 코드 없이 세션이 나온다", async () => {
    const device = new Jar();
    await post("/sign-in/email", { email: EMAIL, password: PASSWORD }, device);
    const verify = await post("/two-factor/verify-totp", { code: await currentCode(), trustDevice: true }, device);
    const trustLine = device.lastSetLine("trust_device");
    const maxAge = Number(/max-age=(\d+)/i.exec(trustLine ?? "")?.[1] ?? 0);

    // 세션 쿠키는 버리고 trust_device 쿠키만 가진 같은 기기에서 다시 로그인
    const sameDevice = device.clone((n) => n.includes("trust_device"));
    const again = await post("/sign-in/email", { email: EMAIL, password: PASSWORD }, sameDevice);
    const againBody = (await again.json()) as { twoFactorRedirect?: boolean };
    const sessionNoCode = await getSession(sameDevice);

    // 다른 기기(쿠키 없음)는 여전히 코드를 요구한다
    const other = new Jar();
    const otherRes = await post("/sign-in/email", { email: EMAIL, password: PASSWORD }, other);
    const otherBody = (await otherRes.json()) as { twoFactorRedirect?: boolean };

    results.trustDevice = {
      verifyStatus: verify.status,
      cookieMaxAge: maxAge,
      sameDeviceRedirect: againBody.twoFactorRedirect ?? false,
      sameDeviceSessionEmail: sessionNoCode?.user?.email,
      otherDeviceRedirect: otherBody.twoFactorRedirect,
    };

    expect(verify.status).toBe(200);
    expect(trustLine).toBeTruthy();
    expect(maxAge).toBe(THIRTY_DAYS);
    expect(againBody.twoFactorRedirect).toBeUndefined(); // 코드 요구 없음
    expect(sessionNoCode?.user?.email).toBe(EMAIL);
    expect(otherBody.twoFactorRedirect).toBe(true);
  });
});
