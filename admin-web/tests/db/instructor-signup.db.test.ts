// S2-1.2(강사 가입 API) — 강사가 휴대폰 본인확인(I31C) 뒤 아이디·비밀번호(I31)로 가입한다(FR-011 · FR-011b · 계약 11 §1).
//   verify ① 활동 장르 2개 저장 거부(수용 ①) — 배열·두 값을 보내면 422 VALIDATION_FAILED, 아무 행도 안 생긴다. 하나면 201 + 그 값 하나
//   verify ② 본인확인 없이 만든 강사 계정 0(수용 ④) — 무효·만료·없는 토큰이면 422, 계정·역할·프로필 0행.
//            DB 전체에서 「instructor 역할인데 CI 가 없는 계정」도 0
//   만 19세는 본인확인 생년월일로 판정(경계: 19번째 생일 오늘 = 허용, 내일 = 거부)
// 경로 처리기는 앱과 같은 createInstructorSignupRoutes 를 테스트 DB·가짜 본인확인·실제 Redis 로 만든다.
// 로그인은 손으로 세션을 만들지 않고 진짜 Better Auth 경로(sign-in/username)를 탄다.
//
// 이름: verify 의 tests/db/s2-1-2.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { kstToday, systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import {
  createInstructorSignupRoutes,
  identityCheckResponseSchema,
  instructorAlreadyRegisteredSchema,
  instructorSignupResponseSchema,
} from "@/lib/server/services/instructor-signup";
import { createOwnerSignupRoutes } from "@/lib/server/services/owner-signup";
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

describe.skipIf(!dbAvailable())("강사 가입 API(FR-011 · FR-011b · 계약 11 §1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  let routes: ReturnType<typeof createInstructorSignupRoutes>;
  let staffMe: (request: Request, ctx: unknown) => Promise<Response>;
  let termsVersionId: string;
  let privacyVersionId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-instructor-signup-0123456789",
    ciPepper: "fake-identity-pepper-for-instructor-signup-0123456789",
    clock: systemClock,
  });
  const today = kstToday(systemClock);

  /** 가짜 본인확인 토큰. personKey 가 같으면 같은 사람(같은 CI 해시)이다 */
  function tokenFor(personKey: string, birthDate: Temporal.PlainDate = Temporal.PlainDate.from("1990-07-15")): string {
    return identity.issue({ name: "이준호", gender: "male", birthDate, phone: "01098765821", personKey }).verificationToken;
  }

  const prefix = `kdance:test:instructor-signup:${randomUUID()}`;
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: prefix });
  // 본인확인 규칙은 기본 하루 5회라 한 테스트 파일에서 넘친다 — 시험용으로 넉넉히 둔다
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  let ip = 0;
  function jsonPost(path: string, body: unknown): Request {
    ip += 1;
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
    displayName: "이준호",
    activityGenre: "dance_sport",
    businessRegistrationNumber: null,
    consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
    ...extra,
  });
  const signup = async (body: unknown) => read(await routes.signup(jsonPost("/api/instructor/signup", body), {}));
  async function read(res: Response): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }
  type Counts = { users: number; staff: number; grants: number; profiles: number; consents: number };
  async function counts(): Promise<Counts> {
    const { rows } = await q(`SELECT (SELECT count(*) FROM auth."user")::int AS users,
                                     (SELECT count(*) FROM staff_accounts)::int AS staff,
                                     (SELECT count(*) FROM role_grants)::int AS grants,
                                     (SELECT count(*) FROM instructor_profiles)::int AS profiles,
                                     (SELECT count(*) FROM staff_consents)::int AS consents`);
    return rows[0] as Counts;
  }
  const ZERO: Counts = { users: 0, staff: 0, grants: 0, profiles: 0, consents: 0 };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    routes = createInstructorSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
    staffMe = createStaffMeRoute({ db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) });
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
    // 필수 동의 둘의 판본 — 각각 시행 중 1개 + 아직 시행 전 1개(시행 전 것을 고르면 안 된다)
    termsVersionId = randomUUID();
    privacyVersionId = randomUUID();
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         ($1, 'merchant_terms', '1.0', '입점 이용약관 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_terms', '2.0', '입점 이용약관 2.0', now(), now() + interval '30 days'),
         ($2, 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '2.0', '개인정보 수집·이용 2.0', now(), now() + interval '30 days')`,
      [termsVersionId, privacyVersionId],
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("identity-check(I31C): 새 사람은 200 eligible, 이름·전화는 가린 값만, 아무것도 쓰지 않는다", async () => {
    const res = await read(await routes.identityCheck(jsonPost("/api/instructor/signup/identity-check", { verificationToken: tokenFor("p-check") }), {}));
    expect(res.status).toBe(200);
    expect(identityCheckResponseSchema.parse(res.body)).toEqual({
      eligible: true,
      nameMasked: "이*호",
      phoneMasked: "010-****-5821",
      ageVerified: true,
    });
    expect(await counts()).toEqual(ZERO);
  });

  test("verify ① 활동 장르 2개 저장 거부 — 배열·두 값·모르는 값·빠짐은 422 VALIDATION_FAILED, 0행", async () => {
    for (const activityGenre of [["dance_sport", "swing"], "dance_sport,swing", "waltz", undefined]) {
      const res = await signup(signupBody(tokenFor("p-genre"), "genrejunho", { activityGenre }));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("activityGenre");
    }
    // 칸 이름을 바꿔 둘을 몰래 넣는 것도 막힌다(모르는 칸 거부)
    const sneaky = await signup(signupBody(tokenFor("p-genre"), "genrejunho", { activityGenres: ["swing", "salsa_bachata"] }));
    expect(sneaky).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await counts()).toEqual(ZERO);
  });

  test("verify ① 장르 하나면 201 — 계정·instructor 역할·프로필(장르 그 값 하나)·필수 동의 둘·감사 1행이 한 번에 생긴다", async () => {
    const res = await signup(signupBody(tokenFor("p-ok"), "junholatin", { activityGenre: "salsa_bachata" }));
    expect(res.status).toBe(201);
    const body = instructorSignupResponseSchema.parse(res.body);
    expect(body).toMatchObject({
      username: "junholatin", displayName: "이준호", activityGenre: "salsa_bachata",
      roles: ["instructor"], membership: null, next: "sign_in",
    });
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 1, profiles: 1, consents: 2 });

    const { rows: staff } = await q("SELECT id, identity_ci_hash, birth_date::text AS birth, phone_masked FROM staff_accounts");
    expect(staff[0]).toMatchObject({ id: body.accountId, birth: "1990-07-15", phone_masked: "010-****-5821" });
    expect((staff[0] as { identity_ci_hash: string }).identity_ci_hash).toMatch(/^[0-9a-f]{64}$/);

    const { rows: grants } = await q("SELECT role, status, granted_by_account_id FROM role_grants WHERE staff_account_id = $1", [body.accountId]);
    expect(grants).toEqual([{ role: "instructor", status: "active", granted_by_account_id: null }]); // NULL = 시스템 부여

    const { rows: profiles } = await q(
      "SELECT activity_genre, business_registration_number, marketing_opt_in_at, signup_completed_at FROM instructor_profiles WHERE staff_account_id = $1",
      [body.accountId],
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ activity_genre: "salsa_bachata", business_registration_number: null, marketing_opt_in_at: null });
    expect((profiles[0] as { signup_completed_at: unknown }).signup_completed_at).not.toBeNull();

    // 동의는 시행 중인 판본(1.0)에만, 항목마다 1행
    const { rows: consents } = await q("SELECT item, terms_version_id, source FROM staff_consents ORDER BY item");
    expect(consents).toEqual([
      { item: "merchant_privacy_collection", terms_version_id: privacyVersionId, source: "instructor_signup" },
      { item: "merchant_terms", terms_version_id: termsVersionId, source: "instructor_signup" },
    ]);

    // 감사 1행 — 이름·연락처·CI·비밀번호는 없다
    const { rows: audits } = await q("SELECT action, actor_staff_account_id, actor_role, after FROM audit_logs");
    expect(audits).toHaveLength(1);
    const audit = audits[0] as { action: string; actor_staff_account_id: string; actor_role: string; after: Record<string, unknown> };
    expect(audit).toMatchObject({ action: "instructor.signup_completed", actor_staff_account_id: body.accountId, actor_role: "instructor" });
    expect(audit.after).toMatchObject({ activityGenre: "salsa_bachata", roles: ["instructor"], businessRegistrationProvided: false });
    const auditText = JSON.stringify(audit.after);
    for (const secret of ["01098765821", (staff[0] as { identity_ci_hash: string }).identity_ci_hash, PASSWORD]) {
      expect(auditText).not.toContain(secret);
    }

    // 진짜 로그인 경로로 들어가고, 직원 정보에 instructor 역할이 보인다(M1B 탭 판정의 재료)
    const login = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username: "junholatin", password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    const me = await read(await staffMe(new Request(`${BASE}/api/staff/me`, { headers: { cookie } }), {}));
    expect(me.status).toBe(200);
    expect(me.body["roles"]).toEqual(["instructor"]);
  });

  test("verify ② 본인확인 없이 만든 강사 계정 0 — 무효·만료·없는 토큰이면 422, 계정·역할·프로필·동의·감사 0행", async () => {
    const valid = tokenFor("p-forged");
    const forged = `${valid.split(".")[0]}.${"A".repeat(43)}`; // 서명을 바꾼 토큰
    const expiredIssuer = new FakeIdentityVerification({
      secret: "fake-identity-secret-for-instructor-signup-0123456789",
      ciPepper: "fake-identity-pepper-for-instructor-signup-0123456789",
      clock: () => Temporal.Now.instant().subtract({ minutes: 11 }), // 11분 전에 받은 토큰 = 유효 10분 지남
    });
    const expired = expiredIssuer.issue({
      name: "이준호", gender: "male", birthDate: Temporal.PlainDate.from("1990-07-15"), phone: "01098765821", personKey: "p-expired",
    }).verificationToken;

    for (const token of [forged, expired, "not-a-token"]) {
      const res = await signup(signupBody(token, "noidentity"));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[])[0]?.path).toBe("verificationToken");
    }
    const { verificationToken: _omit, ...noToken } = signupBody(valid, "noidentity");
    expect(await signup(noToken)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });

    expect(await counts()).toEqual(ZERO);
    const { rows } = await q("SELECT count(*)::int AS n FROM audit_logs");
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  test("verify ② DB 전체 — 가입이 여러 번 성공·실패한 뒤에도 instructor 역할인데 본인확인(CI)이 없는 계정은 0", async () => {
    expect((await signup(signupBody(tokenFor("p-a"), "instructora"))).status).toBe(201);
    expect((await signup(signupBody(tokenFor("p-b"), "instructorb", { activityGenre: "argentine_tango" }))).status).toBe(201);
    expect((await signup(signupBody("broken", "instructorc"))).status).toBe(422);
    const { rows } = await q(
      `SELECT count(*) FILTER (WHERE s.identity_ci_hash IS NULL)::int AS without_ci, count(*)::int AS total
       FROM role_grants g JOIN staff_accounts s ON s.id = g.staff_account_id
       WHERE g.role = 'instructor' AND g.status = 'active'`,
    );
    expect(rows[0]).toEqual({ without_ci: 0, total: 2 });
  });

  test("같은 CI 의 강사가 이미 있으면 409 INSTRUCTOR_ALREADY_REGISTERED + 가린 아이디(1단계·가입 둘 다), 강사 계정은 1개", async () => {
    expect((await signup(signupBody(tokenFor("p-dup"), "firstjunho"))).status).toBe(201);
    const again = await signup(signupBody(tokenFor("p-dup"), "secondjunho"));
    expect(instructorAlreadyRegisteredSchema.parse(again.body)).toMatchObject({ maskedUsername: "fir***nho", hasInstructorRole: true });
    expect(again.status).toBe(409);
    const check = await read(await routes.identityCheck(jsonPost("/api/instructor/signup/identity-check", { verificationToken: tokenFor("p-dup") }), {}));
    expect(check.status).toBe(409);
    expect(instructorAlreadyRegisteredSchema.parse(check.body).hasInstructorRole).toBe(true);
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 1, profiles: 1, consents: 2 });
  });

  test("대표 계정만 있는 사람은 409 hasInstructorRole:false — 새 강사 계정을 만들지 않는다(uq_staff_accounts_ci)", async () => {
    const owner = createOwnerSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
    const ownerRes = await owner.signup(
      jsonPost("/api/owner/signup", {
        verificationToken: tokenFor("p-owner"), username: "ownerfirst", password: PASSWORD, displayName: "이준호",
        consents: { merchantPrivacyCollection: true },
      }),
      {},
    );
    expect(ownerRes.status).toBe(201);
    const res = await signup(signupBody(tokenFor("p-owner"), "ownerasinstr"));
    expect(res.status).toBe(409);
    expect(instructorAlreadyRegisteredSchema.parse(res.body)).toMatchObject({ maskedUsername: "own***rst", hasInstructorRole: false });
    expect(await counts()).toMatchObject({ users: 1, staff: 1, grants: 0, profiles: 0 });
  });

  test("동시에 같은 CI 로 두 번 가입해도 하나만 생긴다 — 진 쪽의 로그인 계정·프로필도 되돌려진다", async () => {
    const results = await Promise.all([
      routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor("p-race"), "racejunho1")), {}),
      routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor("p-race"), "racejunho2")), {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await read(results.find((r) => r.status === 409)!)).code).toBe("INSTRUCTOR_ALREADY_REGISTERED");
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 1, profiles: 1, consents: 2 });
  });

  test("만 19세는 본인확인 생년월일로 판정 — 19번째 생일이 내일이면 422 INSTRUCTOR_UNDER_19(1단계·가입), 오늘이면 201", async () => {
    const tomorrowBirthday = today.subtract({ years: 19 }).add({ days: 1 });
    expect(await signup(signupBody(tokenFor("p-minor", tomorrowBirthday), "minorjunho"))).toMatchObject({ status: 422, code: "INSTRUCTOR_UNDER_19" });
    const check = await read(
      await routes.identityCheck(jsonPost("/api/instructor/signup/identity-check", { verificationToken: tokenFor("p-minor", tomorrowBirthday) }), {}),
    );
    expect(check).toMatchObject({ status: 422, code: "INSTRUCTOR_UNDER_19" });
    // 본문에 나이 확인 칸을 끼워 넣어도 모르는 칸이라 거부된다(체크박스로 판정하지 않는다)
    expect(await signup(signupBody(tokenFor("p-adult", today.subtract({ years: 19 })), "adultjunho", { ageConfirmed: true }))).toMatchObject({
      status: 422, code: "VALIDATION_FAILED",
    });
    expect(await counts()).toEqual(ZERO);
    expect((await signup(signupBody(tokenFor("p-adult", today.subtract({ years: 19 })), "adultjunho"))).status).toBe(201);
  });

  test("입력 검증 — 필수 동의 하나라도 false 422 CONSENT_REQUIRED · 비밀번호 규칙 · 아이디 중복 409 · 사업자번호 체크섬", async () => {
    for (const consents of [
      { merchantTerms: false, merchantPrivacyCollection: true, marketing: true },
      { merchantTerms: true, merchantPrivacyCollection: false, marketing: true },
    ]) {
      expect(await signup(signupBody(tokenFor("p-v"), "checkjunho", { consents }))).toMatchObject({ status: 422, code: "CONSENT_REQUIRED" });
    }
    for (const password of ["Ab1!", "onlyletters!", "Letters1234", "checkjunho"]) {
      const res = await signup(signupBody(tokenFor("p-v"), "checkjunho", { password }));
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("password");
    }
    expect(await signup(signupBody(tokenFor("p-v"), "checkjunho", { businessRegistrationNumber: "120-81-47522" }))).toMatchObject({
      status: 422, code: "BUSINESS_NUMBER_INVALID",
    });
    expect(await counts()).toEqual(ZERO);

    // 사업자번호(하이픈 허용)·광고성 알림 동의를 넣은 가입 — 번호는 10자리로, 광고 동의는 시각으로 남는다
    const ok = await signup(signupBody(tokenFor("p-v"), "checkjunho", {
      businessRegistrationNumber: "120-81-47521",
      consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: true },
    }));
    expect(ok.status).toBe(201);
    const { rows } = await q("SELECT business_registration_number, marketing_opt_in_at FROM instructor_profiles");
    expect((rows[0] as { business_registration_number: string }).business_registration_number).toBe("1208147521");
    expect((rows[0] as { marketing_opt_in_at: unknown }).marketing_opt_in_at).not.toBeNull();

    // 다른 사람이 같은 아이디로
    expect(await signup(signupBody(tokenFor("p-v2"), "checkjunho"))).toMatchObject({ status: 409, code: "USERNAME_TAKEN" });
    expect(await counts()).toEqual({ users: 1, staff: 1, grants: 1, profiles: 1, consents: 2 });
  });

  test("아이디 중복 확인 — available · taken · format", async () => {
    expect((await signup(signupBody(tokenFor("p-u"), "takenjunho"))).status).toBe(201);
    const check = async (username: string) =>
      read(await routes.usernameAvailable(new Request(`${BASE}/api/instructor/signup/username-available?username=${encodeURIComponent(username)}`), {}));
    expect(await check("freejunho")).toMatchObject({ status: 200, body: { available: true } });
    expect(await check("takenjunho")).toMatchObject({ status: 200, body: { available: false, reason: "taken" } });
    expect(await check("Bad_Name")).toMatchObject({ status: 200, body: { available: false, reason: "format" } });
  });

  test("시행 중인 입점 이용약관 판본이 없으면 500 — 계정도 남지 않는다", async () => {
    await q("DELETE FROM terms_versions WHERE kind = 'merchant_terms'");
    const res = await routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor("p-noterms"), "notermsjunho")), {});
    expect(res.status).toBe(500);
    expect(await counts()).toEqual(ZERO);
  });

  test("요청 제한 — 같은 IP 에서 한도를 넘으면 429 RATE_LIMITED", async () => {
    const tight = createInstructorSignupRoutes({
      db: handle.db, identityVerification: identity, clock: systemClock,
      limiter: createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `${prefix}:tight` }),
      identityRule: { name: "identity-verification", limit: 1, windowSeconds: 60 },
    });
    const sameIp = () =>
      new Request(`${BASE}/api/instructor/signup/identity-check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9" },
        body: JSON.stringify({ verificationToken: tokenFor("p-limit") }),
      });
    expect((await tight.identityCheck(sameIp(), {})).status).toBe(200);
    const second = await tight.identityCheck(sameIp(), {});
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });
});
