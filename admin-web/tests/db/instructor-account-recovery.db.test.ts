// S2-1.8(강사 계정 찾기·비밀번호 재설정 API(I31B)) — 휴대폰 본인확인으로 그 사람의 강사 계정 하나를 찾고,
// 비밀번호를 새로 정하면 다른 기기 로그인이 모두 끝난다(FR-011 · FR-191 · 계약 11 §1-4).
//   verify ① 같은 CI 의 강사 계정 1개만 나온다 — 아이디만 그대로, 이름·전화는 가린 값
//   verify ② 다른 사람 토큰으로는 그 계정을 못 찾는다(그 사람 자신의 계정만, 없으면 404)
//   verify ③ 재설정 뒤 그 계정의 옛 세션 0개(같은 기기 30일 기억 기록도 0)
// 계정은 진짜 가입 경로(createInstructorSignupRoutes)로 만들고, 세션은 진짜 Better Auth 로그인(sign-in/username)으로 만든다.
//
// 이름: verify 의 tests/db/s2-1-8.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { toNextJsHandler } from "better-auth/next-js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { kstToday, systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import {
  accountRecoveryLookupResponseSchema,
  accountRecoveryResetResponseSchema,
  createInstructorAccountRecoveryRoutes,
} from "@/lib/server/services/instructor-account-recovery";
import { createInstructorSignupRoutes } from "@/lib/server/services/instructor-signup";
import { createOwnerSignupRoutes } from "@/lib/server/services/owner-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다(repo-secret-scan)
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const OLD_PASSWORD = "Latin!2026x";
const NEW_PASSWORD = "Tango#2027y";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

describe.skipIf(!dbAvailable())("강사 계정 찾기·비밀번호 재설정 API(FR-011 · FR-191 · 계약 11 §1-4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let authHandler: ReturnType<typeof toNextJsHandler>;
  let routes: ReturnType<typeof createInstructorAccountRecoveryRoutes>;
  let signupRoutes: ReturnType<typeof createInstructorSignupRoutes>;
  let ownerRoutes: ReturnType<typeof createOwnerSignupRoutes>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-account-recovery-0123456789",
    ciPepper: "fake-identity-pepper-for-account-recovery-0123456789",
    clock: systemClock,
  });

  /** 가짜 본인확인 토큰. personKey 가 같으면 같은 사람(같은 CI 해시)이다. 휴대폰 번호는 바꿔 낼 수 있다 */
  function tokenFor(personKey: string, phone = "01098765821", name = "이준호"): string {
    return identity.issue({ name, gender: "male", birthDate: Temporal.PlainDate.from("1990-07-15"), phone, personKey })
      .verificationToken;
  }

  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:account-recovery:${randomUUID()}` });
  // 본인확인 규칙은 기본 하루 5회라 한 테스트 파일에서 넘친다 — 시험용으로 넉넉히 둔다
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  let ip = 0;
  function jsonPost(path: string, body: unknown): Request {
    ip += 1;
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip % 250}` },
      body: JSON.stringify(body),
    });
  }
  async function read(res: Response): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }
  const lookup = async (token: string) =>
    read(await routes.lookup(jsonPost("/api/instructor/account-recovery/lookup", { verificationToken: token }), {}));
  const reset = async (token: string, newPassword = NEW_PASSWORD) =>
    read(await routes.resetPassword(jsonPost("/api/instructor/account-recovery/reset-password", { verificationToken: token, newPassword }), {}));

  /** 진짜 강사 가입 경로로 계정을 만든다 → 직원 계정 id */
  async function signupInstructor(personKey: string, username: string, name = "이준호"): Promise<string> {
    const res = await read(
      await signupRoutes.signup(
        jsonPost("/api/instructor/signup", {
          verificationToken: tokenFor(personKey, "01098765821", name),
          username,
          password: OLD_PASSWORD,
          displayName: name,
          activityGenre: "salsa_bachata",
          businessRegistrationNumber: null,
          consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
        }),
        {},
      ),
    );
    expect(res.status).toBe(201);
    return res.body["accountId"] as string;
  }

  /** 진짜 로그인 경로 → 200 이면 세션 쿠키, 아니면 null */
  async function signIn(username: string, password: string): Promise<string | null> {
    const res = await authHandler.POST(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ username, password }),
      }),
    );
    if (res.status !== 200) return null;
    return res.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
  }

  async function sessionCount(staffAccountId: string): Promise<number> {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM auth.session s JOIN staff_accounts a ON a.auth_user_id = s."userId" WHERE a.id = $1`,
      [staffAccountId],
    );
    return (rows[0] as { n: number }).n;
  }
  async function trustDeviceCount(staffAccountId: string): Promise<number> {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM auth.verification v JOIN staff_accounts a ON a.auth_user_id = v.value
       WHERE a.id = $1 AND v.identifier LIKE 'trust-device-%'`,
      [staffAccountId],
    );
    return (rows[0] as { n: number }).n;
  }
  /** 같은 기기 30일 기억 기록을 하나 심는다(플러그인이 만드는 모양 그대로: identifier trust-device-…, value = 로그인 id) */
  async function plantTrustDevice(staffAccountId: string): Promise<void> {
    await q(
      `INSERT INTO auth.verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
       SELECT $2, $3, auth_user_id, now() + interval '30 days', now(), now() FROM staff_accounts WHERE id = $1`,
      [staffAccountId, randomUUID(), `trust-device-${randomUUID().replaceAll("-", "")}`],
    );
  }

  async function addAcademy(name: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
             VALUES ($1, $2, '서울', '강남구', now(), ${ACADEMY_SELLER_VALUES})`, [id, name]);
    return id;
  }
  async function affiliate(academyId: string, instructorId: string, status: "active" | "pending", decidedAt: string | null) {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, created_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now() - interval '60 days', $4::timestamptz, now(), now())`,
      [academyId, instructorId, status, decidedAt],
    );
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    authHandler = toNextJsHandler(auth);
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule };
    routes = createInstructorAccountRecoveryRoutes(deps);
    signupRoutes = createInstructorSignupRoutes(deps);
    ownerRoutes = createOwnerSignupRoutes(deps);
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         (uuidv7(), 'merchant_terms', '1.0', '입점 이용약관 1.0', now() - interval '40 days', now() - interval '10 days'),
         (uuidv7(), 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days')`,
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify ① 같은 CI 의 강사 계정 1개만 나온다 — 아이디는 그대로, 이름·전화는 가린 값, 소속 학원은 이름 1개 + 수", async () => {
    const junho = await signupInstructor("p-junho", "junholatin");
    await signupInstructor("p-other", "minsuswing", "김민수"); // 다른 사람 — 섞여 나오면 안 된다
    const gangnam = await addAcademy("라틴하우스 강남");
    const hongdae = await addAcademy("살사클럽 홍대");
    const waiting = await addAcademy("스윙팩토리 홍대");
    await affiliate(gangnam, junho, "active", "2026-06-01T03:00:00Z");
    await affiliate(hongdae, junho, "active", "2026-08-01T03:00:00Z");
    await affiliate(waiting, junho, "pending", null); // 승인 대기는 소속 수에 안 들어간다

    const res = await lookup(tokenFor("p-junho"));
    expect(res.status).toBe(200);
    // 계약 키 그대로(남는 칸이 있으면 strictObject 가 깨진다)
    expect(accountRecoveryLookupResponseSchema.parse(res.body)).toEqual({
      nameMasked: "이*호",
      phoneMasked: "010-****-5821",
      username: "junholatin",
      joinedOn: kstToday(systemClock).toString(),
      academyNames: ["라틴하우스 강남"],
      academyCount: 2,
    });
    // 가린 값 말고 원래 이름·번호·CI 해시는 응답 어디에도 없다
    const { rows } = await q("SELECT identity_ci_hash FROM staff_accounts WHERE id = $1", [junho]);
    const text = JSON.stringify(res.body);
    for (const secret of ["이준호", "01098765821", (rows[0] as { identity_ci_hash: string }).identity_ci_hash]) {
      expect(text).not.toContain(secret);
    }

    // 휴대폰 번호가 바뀌어도 같은 사람(CI)이면 같은 계정 하나를 찾는다
    const moved = await lookup(tokenFor("p-junho", "01055550000"));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ username: "junholatin", phoneMasked: "010-****-0000" });

    // 찾기는 아무것도 쓰지 않는다 — 세션·토큰 기록 0
    const { rows: written } = await q(`SELECT (SELECT count(*) FROM auth.session)::int AS s, (SELECT count(*) FROM auth.verification)::int AS v`);
    expect(written[0]).toEqual({ s: 0, v: 0 });
  });

  test("verify ② 다른 사람 토큰으로는 못 찾는다 — 그 사람 자신의 계정만, 강사 계정이 없으면 404 · 무효 토큰 422", async () => {
    await signupInstructor("p-junho", "junholatin");
    const other = await lookup(tokenFor("p-stranger", "01098765821", "이준호")); // 이름·번호가 같아도 CI 가 다르면 남이다
    expect(other).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(JSON.stringify(other.body)).not.toContain("junholatin");

    await signupInstructor("p-minsu", "minsuswing", "김민수");
    const minsu = await lookup(tokenFor("p-minsu", "01011112222", "김민수"));
    expect(minsu).toMatchObject({ status: 200, body: { username: "minsuswing" } });

    // 대표 계정만 있는 사람(강사 역할 없음)은 강사 계정 찾기에서 「없음」이다
    const owner = await read(
      await ownerRoutes.signup(
        jsonPost("/api/owner/signup", {
          verificationToken: tokenFor("p-owner", "01033334444", "박대표"),
          username: "parkowner",
          password: OLD_PASSWORD,
          displayName: "박대표",
          consents: { merchantPrivacyCollection: true },
        }),
        {},
      ),
    );
    expect(owner.status).toBe(201);
    expect(await lookup(tokenFor("p-owner", "01033334444", "박대표"))).toMatchObject({ status: 404, code: "NOT_FOUND" });

    // 토큰 무효(위조)·빠짐은 422 VALIDATION_FAILED
    const forged = `${tokenFor("p-junho").slice(0, -4)}AAAA`;
    expect(await lookup(forged)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    const missing = await read(await routes.lookup(jsonPost("/api/instructor/account-recovery/lookup", {}), {}));
    expect(missing).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });

    // 다른 사람 토큰으로 재설정해도 준호 계정의 비밀번호는 그대로다(남의 토큰은 남의 계정만 건드린다)
    expect(await reset(tokenFor("p-stranger"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await signIn("junholatin", OLD_PASSWORD)).not.toBeNull();
  });

  test("verify ③ 재설정 뒤 옛 세션 0개 — 다른 기기 세션·같은 기기 기억 모두 끝나고, 새 비밀번호로만 들어간다", async () => {
    const junho = await signupInstructor("p-junho", "junholatin");
    const minsu = await signupInstructor("p-minsu", "minsuswing", "김민수");
    // 준호: 기기 두 대에서 로그인 + 같은 기기 30일 기억 하나. 민수: 기기 한 대(건드리면 안 된다)
    const phone = await signIn("junholatin", OLD_PASSWORD);
    const tablet = await signIn("junholatin", OLD_PASSWORD);
    expect(phone).not.toBeNull();
    expect(tablet).not.toBeNull();
    await plantTrustDevice(junho);
    expect(await signIn("minsuswing", OLD_PASSWORD)).not.toBeNull();
    expect(await sessionCount(junho)).toBe(2);
    expect(await trustDeviceCount(junho)).toBe(1);

    const res = await reset(tokenFor("p-junho"));
    expect(res.status).toBe(200);
    expect(accountRecoveryResetResponseSchema.parse(res.body)).toEqual({ ok: true, sessionsRevoked: 2 });

    // 옛 세션 0 · 기기 기억 0. 옛 쿠키로는 더는 세션이 안 잡힌다
    expect(await sessionCount(junho)).toBe(0);
    expect(await trustDeviceCount(junho)).toBe(0);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: phone! }) })).toBeNull();
    // 다른 사람의 세션은 그대로
    expect(await sessionCount(minsu)).toBe(1);

    // 옛 비밀번호는 거절, 새 비밀번호로 들어간다
    expect(await signIn("junholatin", OLD_PASSWORD)).toBeNull();
    expect(await signIn("junholatin", NEW_PASSWORD)).not.toBeNull();

    // 감사 1행 — 비밀번호·토큰 값은 없다
    const { rows: audits } = await q(`SELECT actor_staff_account_id, actor_role, target_id, after FROM audit_logs WHERE action = 'staff.password_reset'`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_staff_account_id: junho, actor_role: "instructor", target_id: junho, after: { sessionsRevoked: 2 } });
    const auditText = JSON.stringify(audits[0]);
    for (const secret of [OLD_PASSWORD, NEW_PASSWORD]) expect(auditText).not.toContain(secret);
  });

  test("같은 본인확인 토큰은 한 번만 — 두 번째 재설정은 422, 동시에 두 번 보내도 하나만 바뀐다", async () => {
    await signupInstructor("p-junho", "junholatin");
    const token = tokenFor("p-junho");
    expect((await reset(token)).status).toBe(200);
    const again = await reset(token, "Salsa$2028z");
    expect(again).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await signIn("junholatin", NEW_PASSWORD)).not.toBeNull(); // 두 번째 값으로 안 바뀌었다
    expect(await signIn("junholatin", "Salsa$2028z")).toBeNull();

    // 원문 토큰은 저장하지 않는다(해시 기록만)
    const { rows } = await q(`SELECT identifier FROM auth.verification WHERE identifier LIKE 'identity-token-used-%'`);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { identifier: string }).identifier).toMatch(/^identity-token-used-[0-9a-f]{64}$/);

    // 동시: 새 토큰 하나로 두 요청 → 200 하나 + 422 하나
    const fresh = tokenFor("p-junho");
    const results = await Promise.all([reset(fresh, "Bachata%2029a"), reset(fresh, "Swing^2030b")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await q(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'staff.password_reset'`)).rows[0]).toEqual({ n: 2 });
  });

  test("비밀번호 규칙은 가입과 같다 — 짧음·섞임 부족·아이디와 같음은 422, 아무것도 안 바뀌고 토큰도 안 쓴 것으로 남는다", async () => {
    const junho = await signupInstructor("p-junho", "junholatin");
    expect(await signIn("junholatin", OLD_PASSWORD)).not.toBeNull();
    const token = tokenFor("p-junho");
    for (const bad of ["Ab1!", "onlyletters", "junholatin"]) {
      const res = await reset(token, bad);
      expect(res).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
      expect((res.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("newPassword");
    }
    expect(await sessionCount(junho)).toBe(1);
    expect(await signIn("junholatin", OLD_PASSWORD)).not.toBeNull();
    // 같은 토큰으로 맞는 비밀번호를 보내면 그때 바뀐다(형식 오류는 토큰을 쓰지 않았다)
    expect(await reset(token)).toMatchObject({ status: 200, body: { ok: true, sessionsRevoked: 2 } });
  });
});
