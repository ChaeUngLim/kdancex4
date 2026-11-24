// 대표 가입 동시 경쟁(S1-1.8 후속 — S2-1.2a 크리틱 지적) — 같은 사람(같은 CI)이 거의 동시에 대표 가입을 두 번 보내면
//   진 쪽은 트랜잭션 안의 유니크 색인(uq_staff_accounts_ci)에 막힌다. 이때 409 STAFF_ACCOUNT_EXISTS 의 maskedUsername 은
//   「먼저 만든 계정」의 아이디여야 한다(계약 07 §0 409 행). 고치기 전에는 진 쪽이 자기가 적은 아이디를 가려 돌려줬다.
//
// 재현 방법은 instructor-duplicate-identity.db.test.ts 와 같다 — 먼저 들어간 가입을 트랜잭션 안에 붙잡아 두고
// 두 번째 가입을 보내 유니크 색인 앞에서 기다리게 한 뒤 먼저 것을 커밋시킨다.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { maskUsername } from "@/lib/domain/staff-signup";
import { systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createOwnerSignupRoutes } from "@/lib/server/services/owner-signup";
import { insertStaffAccount, resolveIdentity } from "@/lib/server/services/staff-signup";
import { createStaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const PASSWORD = "Latin!2026x";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";
const UNDER_AGE = { code: "OWNER_UNDER_19", detail: "만 19세 미만" };

describe.skipIf(!dbAvailable())("대표 가입 동시 경쟁 — 진 쪽도 먼저 만든 계정의 아이디로 안내(계약 07 §0)", () => {
  let handle: TestDb;
  let routes: ReturnType<typeof createOwnerSignupRoutes>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: "fake-identity-secret-for-owner-duplicate-0123456789",
    ciPepper: "fake-identity-pepper-for-owner-duplicate-0123456789",
    clock: systemClock,
  });
  /** personKey 가 같으면 같은 사람(같은 CI 해시)이다 */
  const tokenFor = (personKey: string) =>
    identity.issue({ name: "김대표", gender: "female", birthDate: Temporal.PlainDate.from("1985-03-04"), phone: "01012345821", personKey })
      .verificationToken;
  const personOf = (personKey: string) => resolveIdentity(identity, tokenFor(personKey), systemClock(), UNDER_AGE);

  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:owner-dup:${randomUUID()}` });
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  let ip = 0;
  function jsonPost(path: string, body: unknown): Request {
    ip += 1;
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${ip % 250}` },
      body: JSON.stringify(body),
    });
  }
  const signupBody = (token: string, username: string) => ({
    verificationToken: token,
    username,
    password: PASSWORD,
    displayName: "김대표",
    consents: { merchantPrivacyCollection: true },
  });
  async function read(res: Response) {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: body["code"] as string | undefined, body };
  }
  async function accountsOf(ciHash: string): Promise<number> {
    const { rows } = await q("SELECT count(*)::int AS n FROM staff_accounts WHERE identity_ci_hash = $1", [ciHash]);
    return (rows[0] as { n: number }).n;
  }
  async function userCount(): Promise<number> {
    const { rows } = await q('SELECT count(*)::int AS n FROM auth."user"');
    return (rows[0] as { n: number }).n;
  }

  /** 먼저 들어간 가입을 커밋 전 트랜잭션 안에 붙잡아 둔다. release() 로 커밋시킨다 */
  async function holdFirstSignup(personKey: string, username: string) {
    const person = await personOf(personKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    const committed = handle.db.transaction(async (tx) => {
      await insertStaffAccount(
        tx,
        { person, username, password: PASSWORD, displayName: "김대표" },
        { ciTaken: () => new Error("먼저 것은 막히면 안 된다") as never, usernameTaken: () => new Error("아이디 겹침") as never },
      );
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
    routes = createOwnerSignupRoutes({ db: handle.db, identityVerification: identity, clock: systemClock, limiter, identityRule: roomyRule });
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
    await q(
      `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at) VALUES
         (uuidv7(), 'merchant_privacy_collection', '1.0', '개인정보 수집·이용 1.0', now() - interval '40 days', now() - interval '10 days')`,
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("동시 가입에서 진 쪽의 409 는 먼저 만든 계정의 아이디를 가려 안내하고, 진 쪽 계정은 남지 않는다", async () => {
    const held = await holdFirstSignup("p-race", "winnerowner");
    const loserPending = routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-race"), "loserowner")), {});
    await waitForLockWaiter();
    held.release();
    await held.committed;

    const loser = await read(await loserPending);
    expect(loser.status).toBe(409);
    expect(loser.code).toBe("STAFF_ACCOUNT_EXISTS");
    expect(loser.body["maskedUsername"]).toBe(maskUsername("winnerowner"));
    expect(loser.body["maskedUsername"]).not.toBe(maskUsername("loserowner"));
    // 진 쪽의 로그인 계정은 트랜잭션과 함께 되돌려졌다
    expect(await accountsOf(held.ciHash)).toBe(1);
    expect(await userCount()).toBe(1);
  });

  test("차례로 온 두 번째 가입도 같은 409(먼저 계정 아이디) — 기존 동작 유지", async () => {
    expect((await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-seq"), "firstowner")), {})).status).toBe(201);
    const second = await read(await routes.signup(jsonPost("/api/owner/signup", signupBody(tokenFor("p-seq"), "secondowner")), {}));
    expect(second.status).toBe(409);
    expect(second.body["maskedUsername"]).toBe(maskUsername("firstowner"));
  });
});
