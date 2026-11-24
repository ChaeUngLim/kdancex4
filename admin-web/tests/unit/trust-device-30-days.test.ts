// S0-3.9(같은 기기 30일 기억 설정) — 인증 앱 6자리를 넣을 때 trustDevice 를 켜면,
//   처음 인증한 날부터 30일 동안 같은 기기에서는 6자리를 다시 묻지 않는다. 31일째에는 다시 묻는다.
//   30일은 「처음 인증한 날부터 고정」이다 — 중간에 로그인해도 늘어나지 않는다(spec FR-303, 2026-11-19).
//   백업 코드는 쓰지 않는다 → 백업 코드 경로는 404.
//
// DB 없이 돌리려고 Better Auth 의 메모리 저장소(memoryAdapter)를 쓴다. 설정은 앱과 같은 조각
// (staffTwoFactorPlugin · trustDeviceFixedWindowHooks · staffAuthBeforeHook)을 그대로 끼운다.
// 날짜는 가짜 시계(vi.setSystemTime)로 앞으로 돌린다. TOTP 코드도 같은 가짜 시계로 만들어 맞는다.
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { symmetricDecrypt } from "better-auth/crypto";
import { toNextJsHandler } from "better-auth/next-js";
import { username } from "better-auth/plugins/username";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  createStaffAuth,
  STAFF_DISABLED_AUTH_PATHS,
  staffAuthBeforeHook,
  staffTwoFactorPlugin,
  TRUST_DEVICE_DAYS,
  TRUST_DEVICE_MAX_AGE_SECONDS,
  trustDeviceFixedWindowHooks,
} from "@/lib/server/staff-auth";

const SECRET = "unit-only-secret-unit-only-secret-0123456789";
const BASE = "http://localhost:3000";
const USERNAME = "trust_teacher";
const EMAIL = "trust-teacher@example.com";
const PASSWORD = "trust-password-1234";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY0 = new Date("2026-12-01T01:00:00.000Z");
const at = (day: number) => new Date(DAY0.getTime() + day * DAY_MS);

// 브라우저 쿠키 통: 응답의 set-cookie 를 모아 다음 요청에 되돌려 보낸다.
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
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
  /** 다른 통이 받은 기억 쿠키(새로 바뀐 값)를 이 통에 옮겨 담는다. */
  absorbFrom(other: Jar) {
    for (const [k, v] of other.cookies) if (k.includes("trust_device")) this.cookies.set(k, v);
  }
  /** 같은 기기에서 다시 로그인하는 장면: 세션 쿠키는 버리고 기억 쿠키만 남긴다. */
  onlyTrustCookie(): Jar {
    const j = new Jar();
    for (const [k, v] of this.cookies) if (k.includes("trust_device")) j.cookies.set(k, v);
    return j;
  }
}

type MemoryDb = Record<string, Record<string, unknown>[]>;

describe("S0-3.9 같은 기기 30일 기억", () => {
  const store: MemoryDb = { user: [], session: [], account: [], verification: [], twoFactor: [] };
  const auth = betterAuth({
    secret: SECRET,
    baseURL: BASE,
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true }, // 시험 계정을 만들려고 가입만 연다(앱은 disableSignUp)
    databaseHooks: { verification: trustDeviceFixedWindowHooks },
    hooks: { before: staffAuthBeforeHook },
    plugins: [username(), staffTwoFactorPlugin()],
  });
  const handler = toNextJsHandler(auth);

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
  async function signIn(jar: Jar) {
    const res = await post("/sign-in/username", { username: USERNAME, password: PASSWORD }, jar);
    const body = (await res.json()) as { twoFactorRedirect?: boolean; token?: string };
    return { status: res.status, askedCode: body.twoFactorRedirect === true, gotSession: jar.has("session_token") };
  }
  // 인증 앱이 하는 일: 저장된 비밀값으로 「지금」(가짜 시계) 6자리를 만든다.
  async function currentCode(): Promise<string> {
    const secret = await symmetricDecrypt({ key: SECRET, data: String(store.twoFactor![0]!.secret) });
    return createOTP(secret).totp();
  }
  const trustRows = () =>
    store.verification!.filter((r) => String(r.identifier).startsWith("trust-device-")) as { expiresAt: Date }[];

  const device = new Jar(); // 처음 인증한 기기

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY0);
    // 계정 만들기 → 인증 앱 등록(enable → verify-totp). 여기까지는 등록 단계라 기억 쿠키를 만들지 않는다.
    const setup = new Jar();
    await post("/sign-up/email", { email: EMAIL, password: PASSWORD, name: "강사", username: USERNAME }, setup);
    await post("/two-factor/enable", { password: PASSWORD }, setup);
    const enabled = await post("/two-factor/verify-totp", { code: await currentCode() }, setup);
    expect(enabled.status).toBe(200);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  test("30일 값은 한 곳의 상수이고 앱 설정(createStaffAuth)도 그 값을 쓴다", () => {
    expect(TRUST_DEVICE_DAYS).toBe(30);
    expect(TRUST_DEVICE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
    // 접속하지 않는 풀: betterAuth 는 만들 때 DB 에 붙지 않으므로 설정만 꺼내 본다.
    const pool = new Pool({ connectionString: "postgres://unused@127.0.0.1:1/unused" });
    const app = createStaffAuth({ pool, secret: SECRET, baseURL: BASE });
    const tf = app.options.plugins?.find((p) => p.id === "two-factor") as { options?: { trustDeviceMaxAge?: number } };
    expect(tf.options?.trustDeviceMaxAge).toBe(TRUST_DEVICE_MAX_AGE_SECONDS);
    expect(app.options.databaseHooks?.verification).toBe(trustDeviceFixedWindowHooks);
    void pool.end();
  });

  test("0일째: trustDevice 로 6자리를 넣으면 30일짜리 기억 쿠키가 생긴다", async () => {
    vi.setSystemTime(DAY0);
    const first = await signIn(device);
    expect(first.askedCode).toBe(true); // 처음 기기는 6자리를 묻는다
    const res = await post("/two-factor/verify-totp", { code: await currentCode(), trustDevice: true }, device);
    expect(res.status).toBe(200);
    expect(device.has("trust_device")).toBe(true);
    expect(trustRows().map((r) => new Date(r.expiresAt).getTime())).toEqual([at(TRUST_DEVICE_DAYS).getTime()]);
  });

  test("29일째: 같은 기기는 6자리를 묻지 않고 바로 세션이 나온다 — 만료는 늘어나지 않는다", async () => {
    vi.setSystemTime(at(29));
    const sameDevice = device.onlyTrustCookie();
    const r = await signIn(sameDevice);
    expect(r.status).toBe(200);
    expect(r.askedCode).toBe(false);
    expect(r.gotSession).toBe(true);
    // 플러그인은 쿠키를 새로 바꿔 주지만, 만료는 처음 인증한 날 + 30일 그대로다(밀어내기 없음)
    expect(trustRows().map((r) => new Date(r.expiresAt).getTime())).toEqual([at(TRUST_DEVICE_DAYS).getTime()]);
    // 바뀐 쿠키를 기기에 담아 둔다(31일째에 이 쿠키로 다시 시도한다)
    device.absorbFrom(sameDevice);
  });

  test("31일째: 29일째에 받은 최신 쿠키가 있어도 6자리를 다시 묻는다", async () => {
    vi.setSystemTime(at(31));
    const r = await signIn(device.onlyTrustCookie());
    expect(r.status).toBe(200);
    expect(r.askedCode).toBe(true);
    expect(r.gotSession).toBe(false);
  });

  test("다른 기기(기억 쿠키 없음)는 29일째에도 6자리를 묻는다", async () => {
    vi.setSystemTime(at(29));
    const r = await signIn(new Jar());
    expect(r.askedCode).toBe(true);
  });

  test("백업 코드는 쓰지 않는다: 백업 코드 경로는 404", async () => {
    expect(STAFF_DISABLED_AUTH_PATHS.has("/two-factor/verify-backup-code")).toBe(true);
    const verify = await post("/two-factor/verify-backup-code", { code: "abcde-12345" }, new Jar());
    const generate = await post("/two-factor/generate-backup-codes", { password: PASSWORD }, new Jar());
    expect(verify.status).toBe(404);
    expect(generate.status).toBe(404);
  });
});
