// S2-1.2a(같은 본인확인(CI) 두 번째 강사 계정 거부) — 한 사람(같은 CI)은 강사 계정을 하나만 가진다(Q23 · Q41 · 계약 11 §1-1·§1-3).
//   verify ① 같은 CI 두 번째 가입은 409 INSTRUCTOR_ALREADY_REGISTERED, 안내하는 아이디는 「먼저 만든 계정」의 아이디다
//            (두 번째 요청에 적은 아이디가 아니다). 두 번째 요청의 아이디는 소비되지 않는다
//   verify ② 아이디 찾기는 계정 하나만 보인다 — 같은 CI 로 여러 번 시도한 뒤에도 그 CI 의 직원 계정은 1개,
//            CI 로 찾는 함수(findStaffByCi)는 처음 계정 하나를 돌려준다. 찾기 경로 자체(I31B)는 S2-1.8 이 만든다
//
// 왜 「동시 가입」을 따로 보나:
//   두 요청이 거의 같이 오면 둘 다 「같은 CI 없음」 확인을 통과하고, 진 쪽은 트랜잭션 안의 유니크 색인
//   (uq_staff_accounts_ci)에 막힌다. 이 길에서 409 가 「내가 적은 아이디」를 가려 보내면 기존 아이디 안내가 틀린다.
//   그래서 먼저 들어간 가입을 트랜잭션 안에 붙잡아 둔 채 두 번째 가입을 보내 그 길을 일부러 탄다.
//
// 이름: verify 의 tests/db/s2-1-2a.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { maskUsername } from "@/lib/domain/staff-signup";
import { systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import {
  createInstructorSignupRoutes,
  instructorAlreadyRegisteredSchema,
  instructorSignupResponseSchema,
} from "@/lib/server/services/instructor-signup";
import { findStaffByCi, insertStaffAccount, resolveIdentity } from "@/lib/server/services/staff-signup";
import { createStaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const UNDER_AGE = { code: "INSTRUCTOR_UNDER_19", detail: "만 19세 미만" };

describe.skipIf(!dbAvailable())("같은 본인확인(CI) 두 번째 강사 계정 거부(Q23 · Q41 · 계약 11 §1)", () => {
  let handle: TestDb;
  let routes: ReturnType<typeof createInstructorSignupRoutes>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-duplicate-identity-0123456789",
    ciPepper: "fake-identity-pepper-for-duplicate-identity-0123456789",
    clock: systemClock,
  });
  /** personKey 가 같으면 같은 사람(같은 CI 해시)이다 */
  const tokenFor = (personKey: string) =>
    identity.issue({ name: "이준호", gender: "male", birthDate: Temporal.PlainDate.from("1990-07-15"), phone: "01098765821", personKey })
      .verificationToken;
  const personOf = (personKey: string) => resolveIdentity(identity, tokenFor(personKey), systemClock(), UNDER_AGE);

  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:dup-identity:${randomUUID()}` });
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
  const signupBody = (token: string, username: string) => ({
    verificationToken: token,
    username,
    password: PASSWORD,
    displayName: "이준호",
    activityGenre: "salsa_bachata",
    businessRegistrationNumber: null,
    consents: { merchantTerms: true, merchantPrivacyCollection: true, marketing: false },
  });
  async function read(res: Response) {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }
  const signup = async (personKey: string, username: string) =>
    read(await routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor(personKey), username)), {}));
  const identityCheck = async (personKey: string) =>
    read(await routes.identityCheck(jsonPost("/api/instructor/signup/identity-check", { verificationToken: tokenFor(personKey) }), {}));
  async function usernameAvailable(username: string) {
    const url = `${BASE}/api/instructor/signup/username-available?username=${username}`;
    return read(await routes.usernameAvailable(new Request(url, { headers: { "x-forwarded-for": "198.51.100.251" } }), {}));
  }
  /** 이 사람(CI)의 직원 계정 수 — 아이디 찾기가 보여 줄 수 있는 계정 수와 같다 */
  async function accountsOf(ciHash: string): Promise<number> {
    const { rows } = await q("SELECT count(*)::int AS n FROM staff_accounts WHERE identity_ci_hash = $1", [ciHash]);
    return (rows[0] as { n: number }).n;
  }

  /**
   * 먼저 들어간 가입을 트랜잭션 안에 붙잡아 둔다(아직 커밋 전). 그동안 보낸 두 번째 가입은
   * 「같은 CI 없음」 확인을 통과하고 유니크 색인 앞에서 기다린다 — 그 뒤 release() 로 먼저 것을 커밋시킨다.
   */
  async function holdFirstSignup(personKey: string, username: string, role: "instructor" | null) {
    const person = await personOf(personKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    const committed = handle.db.transaction(async (tx) => {
      const account = await insertStaffAccount(
        tx,
        { person, username, password: PASSWORD, displayName: "이준호" },
        { ciTaken: () => new Error("먼저 것은 막히면 안 된다") as never, usernameTaken: () => new Error("아이디 겹침") as never },
      );
      if (role !== null) {
        await tx.execute(
          tx.raw.sql`INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), ${account.staffAccountId}::uuid, ${role})`
            .affectedCount()
            .build(),
        );
      }
      inserted();
      await gate;
    });
    await insertedSignal;
    return { release, committed, ciHash: person.ciHash };
  }
  /** 두 번째 가입이 유니크 색인 잠금을 기다리기 시작할 때까지 본다(최대 5초) */
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await q(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if ((rows[0] as { n: number }).n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("두 번째 가입이 잠금을 기다리지 않았다 — 경쟁 길을 못 탔다");
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    const auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    routes = createInstructorSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
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

  test("verify ① 같은 CI 두 번째 가입 409 — 안내 아이디는 먼저 만든 계정의 것, 두 번째 아이디는 소비되지 않는다", async () => {
    const first = await signup("p-seq", "junholatin");
    expect(first.status).toBe(201);
    expect(instructorSignupResponseSchema.parse(first.body).username).toBe("junholatin");

    const second = await signup("p-seq", "junhosecond");
    expect(second.status).toBe(409);
    const conflict = instructorAlreadyRegisteredSchema.parse(second.body);
    expect(conflict).toMatchObject({ code: "INSTRUCTOR_ALREADY_REGISTERED", maskedUsername: maskUsername("junholatin"), hasInstructorRole: true });
    expect(conflict.maskedUsername).not.toBe(maskUsername("junhosecond"));

    // 1단계(I31C)에서도 같은 안내 — 앱은 여기서 바로 「이미 가입한 강사예요」 + 로그인·비밀번호 새로 정하기로 보낸다
    const check = await identityCheck("p-seq");
    expect(check.status).toBe(409);
    expect(instructorAlreadyRegisteredSchema.parse(check.body).maskedUsername).toBe(maskUsername("junholatin"));

    // 막힌 가입은 아무것도 남기지 않는다 — 두 번째 아이디는 여전히 쓸 수 있다
    expect((await usernameAvailable("junhosecond")).body).toEqual({ available: true });
    const { rows } = await q(
      `SELECT (SELECT count(*) FROM auth."user")::int AS users, (SELECT count(*) FROM role_grants)::int AS grants,
              (SELECT count(*) FROM instructor_profiles)::int AS profiles`,
    );
    expect(rows[0]).toEqual({ users: 1, grants: 1, profiles: 1 });
  });

  test("verify ① 동시 가입에서 진 쪽도 먼저 만든 계정의 아이디로 안내한다(유니크 색인에 막힌 길)", async () => {
    const held = await holdFirstSignup("p-race", "winnerlatin", "instructor");
    const loserPending = routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor("p-race"), "loserbachata")), {});
    await waitForLockWaiter();
    held.release();
    await held.committed;

    const loser = await read(await loserPending);
    expect(loser.status).toBe(409);
    expect(instructorAlreadyRegisteredSchema.parse(loser.body)).toMatchObject({
      maskedUsername: maskUsername("winnerlatin"),
      hasInstructorRole: true,
    });
    // 진 쪽의 로그인 계정(아이디)은 트랜잭션과 함께 되돌려졌다
    expect((await usernameAvailable("loserbachata")).body).toEqual({ available: true });
    expect(await accountsOf(held.ciHash)).toBe(1);
  });

  test("동시 가입에서 먼저 것이 대표 계정(강사 역할 없음)이면 hasInstructorRole:false 로 안내한다", async () => {
    const held = await holdFirstSignup("p-race-owner", "ownerlatin", null);
    const loserPending = routes.signup(jsonPost("/api/instructor/signup", signupBody(tokenFor("p-race-owner"), "ownerasteach")), {});
    await waitForLockWaiter();
    held.release();
    await held.committed;

    const loser = await read(await loserPending);
    expect(loser.status).toBe(409);
    expect(instructorAlreadyRegisteredSchema.parse(loser.body)).toMatchObject({
      maskedUsername: maskUsername("ownerlatin"),
      hasInstructorRole: false,
    });
    const { rows } = await q("SELECT count(*)::int AS n FROM role_grants WHERE role = 'instructor'");
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  test("verify ② 아이디 찾기는 계정 하나만 보인다 — 같은 CI 로 여러 번 시도해도 계정 1개, 찾으면 처음 아이디", async () => {
    expect((await signup("p-find", "findjunho")).status).toBe(201);
    for (const username of ["findjunho2", "findjunho3", "findjunho4"]) {
      expect((await signup("p-find", username)).code).toBe("INSTRUCTOR_ALREADY_REGISTERED");
    }
    // 동시에 두 번 더 — 그래도 하나
    const raced = await Promise.all([signup("p-find", "findjunho5"), signup("p-find", "findjunho6")]);
    expect(raced.map((r) => r.status)).toEqual([409, 409]);

    const me = await personOf("p-find");
    expect(await accountsOf(me.ciHash)).toBe(1);
    const found = await findStaffByCi(handle.db, me.ciHash);
    expect(found).toMatchObject({ username: "findjunho", roles: ["instructor"] });

    // 다른 사람(다른 CI)으로는 이 계정이 보이지 않는다
    const stranger = await personOf("p-stranger");
    expect(await findStaffByCi(handle.db, stranger.ciHash)).toBeNull();
  });
});
