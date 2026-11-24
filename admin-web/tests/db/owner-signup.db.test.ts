// S1-1.8(대표 가입 API) — 대표가 휴대폰 본인확인 뒤 가입하고, 인증 앱을 등록해야 2단계를 마친 세션이 된다(FR-011).
//   verify ① 같은 CI 로 두 번째 대표 계정 거부(409 STAFF_ACCOUNT_EXISTS, 동시 요청도 1개만)
//   verify ② 가입 직후 owner 역할 없음(role_grants 0행, GET /api/staff/me 의 roles 비어 있음)
//   verify ③ 본인확인 없이 가입 0(무효·만료 토큰이면 auth.user·staff_accounts 둘 다 0행)
// 경로 처리기는 앱과 같은 createOwnerSignupRoutes 를 테스트 DB·가짜 본인확인·실제 Redis 로 만든다.
// 로그인·인증 앱 등록은 손으로 세션을 만들지 않고 진짜 Better Auth 경로(S0-3.8 과 같은 흐름)를 탄다.
import { randomUUID } from "node:crypto";

import { createOTP } from "@better-auth/utils/otp";
import { symmetricDecrypt } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { kstToday, systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import {
  createOwnerSignupRoutes,
  identityCheckResponseSchema,
  ownerSignupResponseSchema,
  usernameAvailableResponseSchema,
} from "@/lib/server/services/owner-signup";
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

/** 브라우저 하나(= 기기 하나)의 쿠키 상자(second-factor-gate 테스트와 같은 방식) */
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
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

describe.skipIf(!dbAvailable())("대표 가입 API(FR-011 · 계약 07 §0)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  let routes: ReturnType<typeof createOwnerSignupRoutes>;
  let staffMe: (request: Request, ctx: unknown) => Promise<Response>;
  let privacyVersionId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-owner-signup-0123456789",
    ciPepper: "fake-identity-pepper-for-owner-signup-0123456789",
    clock: systemClock,
  });
  const today = kstToday(systemClock);

  /** 가짜 본인확인 토큰. personKey 가 같으면 같은 사람(같은 CI 해시)이다 */
  function tokenFor(personKey: string, birthDate: Temporal.PlainDate = Temporal.PlainDate.from("1985-03-04")): string {
    return identity.issue({ name: "김대표", gender: "female", birthDate, phone: "01012345821", personKey }).verificationToken;
  }

  // 실행마다 다른 접두어 — 다른 테스트·앞 실행의 횟수와 섞이지 않게
  const prefix = `kdance:test:owner-signup:${randomUUID()}`;
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: prefix });
  // 본인확인 규칙은 기본 하루 5회라 한 테스트 파일에서 넘친다 — 시험용으로 넉넉히 둔다(제한 자체는 따로 본다)
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  let ip = 0;
  function jsonPost(path: string, body: unknown): Request {
    ip += 1; // 요청마다 다른 IP — 아래 제한 시험만 같은 IP 를 쓴다
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${ip % 250}` },
      body: JSON.stringify(body),
    });
  }
  const signupBody = (token: string, username: string, extra: Record<string, unknown> = {}) => ({
    verificationToken: token,
    username,
    password: PASSWORD,
    displayName: "김대표",
    consents: { merchantPrivacyCollection: true },
    ...extra,
  });
  async function read(res: Response): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }
  async function counts(): Promise<{ users: number; staff: number; grants: number }> {
    const { rows } = await q(`SELECT (SELECT count(*) FROM auth."user")::int AS users,
                                     (SELECT count(*) FROM staff_accounts)::int AS staff,
                                     (SELECT count(*) FROM role_grants)::int AS grants`);
    return rows[0] as { users: number; staff: number; grants: number };
  }

  // ---- Better Auth 로그인 도우미(진짜 경로) ----
  async function authPost(device: Device, path: string, body: unknown): Promise<Response> {
    const res = await authHandler.POST(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: device.header() },
        body: JSON.stringify(body),
      }),
    );
    device.absorb(res);
    return res;
  }
  async function currentCode(username: string): Promise<string> {
    const { rows } = await q('SELECT t.secret FROM auth."twoFactor" t JOIN auth."user" u ON u.id = t."userId" WHERE u.username = $1', [username]);
    return createOTP(await symmetricDecrypt({ key: SECRET, data: (rows[0] as { secret: string }).secret })).totp();
  }
  const meOf = async (device: Device) => read(await staffMe(new Request(`${BASE}/api/staff/me`, { headers: { cookie: device.header() } }), {}));

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    routes = createOwnerSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
    staffMe = createStaffMeRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
    // 개인정보 수집·이용 동의 판본 — 하나는 시행 중, 하나는 아직 시행 전(고르면 안 된다)
    privacyVersionId = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         ($1, 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '2.0', '개인정보 수집·이용 2.0', now(), now() + interval '30 days')`,
      [privacyVersionId],
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("identity-check: 본인확인을 마친 새 사람은 200 eligible, 이름·전화는 가린 값만", async () => {
    const res = await read(await routes.identityCheck(jsonPost("/api/owner/signup/identity-check", { verificationToken: tokenFor("p-check") }), {}));
    expect(res.status).toBe(200);
    expect(identityCheckResponseSchema.parse(res.body)).toEqual({
      eligible: true,
      nameMasked: "김*표",
      phoneMasked: "010-****-5821",
      ageVerified: true,
    });
    expect(await counts()).toEqual({ users: 0, staff: 0, grants: 0 }); // 읽기만 한다
  });

  test("verify ③ 본인확인 없이 가입 0 — 무효·만료·없는 토큰이면 422, auth.user·staff_accounts 둘 다 0행", async () => {
    const valid = tokenFor("p-forged");
    const forged = `${valid.split(".")[0]}.${"A".repeat(43)}`; // 서명을 바꾼 토큰
    const expiredIssuer = new FakeIdentityVerification({
      secret: "fake-identity-secret-for-owner-signup-0123456789",
      ciPepper: "fake-identity-pepper-for-owner-signup-0123456789",
      clock: () => Temporal.Now.instant().subtract({ minutes: 11 }), // 11분 전에 받은 토큰 = 유효 10분 지남
    });
    const expired = expiredIssuer.issue({
      name: "김대표", gender: "female", birthDate: Temporal.PlainDate.from("1985-03-04"), phone: "01012345821", personKey: "p-expired",
    }).verificationToken;

    for (const token of [forged, expired, "not-a-token"]) {
      const res = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(token, "nocheck01")), {}));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[])[0]?.path).toBe("verificationToken");
    }
    // 토큰 칸 자체가 없으면 본문 검증에서 막힌다
    const { verificationToken: _omit, ...noToken } = signupBody(valid, "nocheck01");
    expect(await read(await routes.signup(jsonPost("/api/owner/signup", noToken), {}))).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await counts()).toEqual({ users: 0, staff: 0, grants: 0 });
    const { rows } = await q("SELECT count(*)::int AS n FROM audit_logs");
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  test("verify ② 가입 직후 owner 역할 없음 — 201, 역할 0행, 감사에 동의 판본 기록, 로그인 뒤 roles []", async () => {
    const res = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-owner"), "latinhouse01")), {}));
    expect(res.status).toBe(201);
    const body = ownerSignupResponseSchema.parse(res.body);
    expect(body).toMatchObject({ username: "latinhouse01", displayName: "김대표", roles: [], next: "sign_in" });

    // 직원 계정: CI 해시·생년월일·가린 번호가 들어가고, 전체 번호·역할은 없다
    const { rows: staff } = await q(
      "SELECT id, identity_ci_hash, birth_date::text AS birth, phone_masked, phone_enc, status FROM staff_accounts",
    );
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ id: body.accountId, birth: "1985-03-04", phone_masked: "010-****-5821", phone_enc: null, status: "active" });
    expect((staff[0] as { identity_ci_hash: string }).identity_ci_hash).toMatch(/^[0-9a-f]{64}$/);
    const { rows: grants } = await q("SELECT count(*)::int AS n FROM role_grants WHERE staff_account_id = $1", [body.accountId]);
    expect((grants[0] as { n: number }).n).toBe(0);

    // 감사 1행 — 시행 중인 판본(1.0)에 동의, 시행 전 판본(2.0)은 고르지 않았다. 이름·연락처·CI 는 없다
    const { rows: audits } = await q("SELECT action, actor_kind, actor_staff_account_id, target_id, after FROM audit_logs");
    expect(audits).toHaveLength(1);
    const audit = audits[0] as { action: string; actor_kind: string; actor_staff_account_id: string; target_id: string; after: Record<string, unknown> };
    expect(audit).toMatchObject({ action: "owner.signup_completed", actor_kind: "staff", actor_staff_account_id: body.accountId, target_id: body.accountId });
    expect(audit.after["consents"]).toEqual([
      { item: "merchant_privacy_collection", termsVersionId: privacyVersionId, agreedAt: expect.any(String) },
    ]);
    const auditText = JSON.stringify(audit.after);
    expect(auditText).not.toContain("01012345821");
    expect(auditText).not.toContain((staff[0] as { identity_ci_hash: string }).identity_ci_hash);
    expect(auditText).not.toContain(PASSWORD);

    // 진짜 로그인 경로로 들어간다 — 비밀번호 해시가 Better Auth 와 맞는다
    const device = new Device();
    const signed = await authPost(device, "/sign-in/username", { username: "latinhouse01", password: PASSWORD });
    expect(signed.status).toBe(200);
    const me = await meOf(device);
    expect(me.status).toBe(200);
    expect(me.body["roles"]).toEqual([]);
    expect(me.body["secondFactorVerified"]).toBe(false); // 인증 앱 등록 전 = 입점 신청 경로는 401 SECOND_FACTOR_REQUIRED(S1-1.10)
  });

  test("인증 앱 선등록 — 가입한 대표가 S0-3.8 흐름(enable → verify-totp)으로 등록하면 그 세션은 2단계를 마친 세션", async () => {
    expect((await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-totp"), "totpowner")), {})).status).toBe(201);
    const device = new Device();
    await authPost(device, "/sign-in/username", { username: "totpowner", password: PASSWORD });
    expect((await authPost(device, "/two-factor/enable", { password: PASSWORD })).status).toBe(200);
    expect((await authPost(device, "/two-factor/verify-totp", { code: await currentCode("totpowner") })).status).toBe(200);
    const me = await meOf(device);
    expect(me.body["secondFactorVerified"]).toBe(true);
    expect(me.body["roles"]).toEqual([]); // 인증 앱을 등록해도 역할은 그대로 없다
  });

  test("verify ① 같은 CI 로 두 번째 대표 계정 거부 — 409 STAFF_ACCOUNT_EXISTS + 가린 아이디, 계정은 1개 그대로", async () => {
    expect((await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-dup"), "firstowner")), {})).status).toBe(201);

    // 다른 아이디로 다시 가입 — 같은 사람(personKey 같음, 새 토큰)
    const second = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-dup"), "secondowner")), {}));
    expect(second).toMatchObject({ status: 409, code: "STAFF_ACCOUNT_EXISTS", body: { maskedUsername: "fir***ner" } });
    // 가입 1단계(identity-check)에서도 먼저 알려 준다
    const check = await read(await routes.identityCheck(jsonPost("/api/owner/signup/identity-check", { verificationToken: tokenFor("p-dup") }), {}));
    expect(check).toMatchObject({ status: 409, code: "STAFF_ACCOUNT_EXISTS", body: { maskedUsername: "fir***ner" } });

    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 0 });
    // 다른 사람은 같은 날 가입할 수 있다
    expect((await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-other"), "otherowner")), {})).status).toBe(201);
  });

  test("verify ① 동시에 같은 CI 로 두 번 가입해도 하나만 생긴다(uq_staff_accounts_ci 가 최종 방어선)", async () => {
    const results = await Promise.all([
      routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-race"), "raceowner1")), {}),
      routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-race"), "raceowner2")), {}),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = await read(results.find((r) => r.status === 409)!);
    expect(loser.code).toBe("STAFF_ACCOUNT_EXISTS");
    // 진 쪽의 로그인 계정(auth.user)도 같은 트랜잭션에서 되돌려져 반쪽 계정이 남지 않는다
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 0 });
  });

  test("아이디 — 중복은 409 USERNAME_TAKEN, 중복 확인 경로는 available·taken·format", async () => {
    expect((await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-u1"), "takenname")), {})).status).toBe(201);
    const dup = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-u2"), "takenname")), {}));
    expect(dup).toMatchObject({ status: 409, code: "USERNAME_TAKEN" });
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 0 });

    const check = async (username: string) => {
      const res = await read(
        await routes.usernameAvailable(new Request(`${BASE}/api/owner/signup/username-available?username=${encodeURIComponent(username)}`), {}),
      );
      expect(res.status).toBe(200);
      return usernameAvailableResponseSchema.parse(res.body);
    };
    expect(await check("freename")).toEqual({ available: true });
    expect(await check("takenname")).toEqual({ available: false, reason: "taken" });
    for (const bad of ["abc", "Upper123", "under_score", "a".repeat(21), ""]) {
      expect(await check(bad)).toEqual({ available: false, reason: "format" });
    }
  });

  test("입력 검증 — 동의 안 함 422 CONSENT_REQUIRED · 비밀번호 규칙 · 만 19세 미만 422 OWNER_UNDER_19, 모두 0행", async () => {
    const noConsent = await read(
      await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-v1"), "consentno", { consents: { merchantPrivacyCollection: false } })), {}),
    );
    expect(noConsent).toMatchObject({ status: 422, code: "CONSENT_REQUIRED" });

    for (const password of ["Ab1!", "onlyletters!", "Letters1234", "consentno"]) {
      const res = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-v2"), "consentno", { password })), {}));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("password");
    }
    // 만 19세 경계: 19번째 생일이 내일이면 거부, 오늘이면 허용
    const tomorrowBirthday = today.subtract({ years: 19 }).add({ days: 1 });
    const minor = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-minor", tomorrowBirthday), "minorowner")), {}));
    expect(minor).toMatchObject({ status: 422, code: "OWNER_UNDER_19" });
    const minorCheck = await read(
      await routes.identityCheck(jsonPost("/api/owner/signup/identity-check", { verificationToken: tokenFor("p-minor", tomorrowBirthday) }), {}),
    );
    expect(minorCheck).toMatchObject({ status: 422, code: "OWNER_UNDER_19" });
    expect(await counts()).toEqual({ users: 0, staff: 0, grants: 0 });

    const adult = await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-adult", today.subtract({ years: 19 })), "adultowner")), {});
    expect(adult.status).toBe(201);
  });

  test("요청 제한 — 같은 IP 에서 한도를 넘으면 429 RATE_LIMITED + Retry-After", async () => {
    const tight = createOwnerSignupRoutes({
      db: handle.db,
      identityVerification: identity,
      clock: systemClock,
      limiter: createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `${prefix}:tight` }),
      identityRule: { name: "identity-verification", limit: 2, windowSeconds: 60 },
    });
    const sameIp = () =>
      new Request(`${BASE}/api/owner/signup/identity-check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ verificationToken: tokenFor("p-limit") }),
      });
    expect((await tight.identityCheck(sameIp(), {})).status).toBe(200);
    expect((await tight.identityCheck(sameIp(), {})).status).toBe(200);
    const third = await tight.identityCheck(sameIp(), {});
    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).not.toBeNull();
    expect(((await third.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  test("시행 중인 개인정보 판본이 없으면 500 — 계정도 남지 않는다(운영자가 먼저 발행)", async () => {
    await q("DELETE FROM terms_versions");
    const res = await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-noterms"), "notermsowner")), {});
    expect(res.status).toBe(500);
    expect(await counts()).toEqual({ users: 0, staff: 0, grants: 0 });
  });
});
