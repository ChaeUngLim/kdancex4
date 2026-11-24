// S3-1.2(가짜 본인확인·가입 API) — 회원이 가짜 본인확인 토큰으로 가입을 끝낸다(계약 01 §3 · FR-002 · FR-003 · FR-019a).
//   verify ① 필수 4항목 중 하나라도 빠지면 가입 안 됨(S3-1 수용 ①) — 필수 동의 넷 각각을 false 로 보내면 422 CONSENT_REQUIRED,
//            본인확인 결과에 이름·성별·생년·연락처 중 하나라도 비면 422. 어느 쪽이든 회원·동의·감사 행 0
//   verify ② 같은 CI 두 번째 가입 409 IDENTITY_ALREADY_USED(수용 ②) — 다른 로그인 계정이 같은 personKey 로 오면 409, 행 그대로
//   verify ③ 닉네임 없음·1자·13자 422 VALIDATION_FAILED(fields: nickname) · 금칙어 422 NICKNAME_NOT_ALLOWED · 중복 닉네임은 허용
//   그리고: 이름·성별·생년·연락처는 본인확인 값으로만 채운다(본문에 name 을 실으면 422), 같은 세션 다시 보내면 200 같은 Member
// 경로 처리기는 앱과 같은 createMemberSignupRoutes 를 테스트 DB·가짜 본인확인·실제 Redis·진짜 Better Auth 세션으로 만든다.
//
// 이름: verify 의 tests/db/s3-1-2.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { MEMBER_REQUIRED_CONSENT_ITEMS } from "@/lib/domain/constants";
import { systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import type { IdentityVerificationPort } from "@/lib/server/ports/identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createMemberSignupRoutes, memberSchema } from "@/lib/server/services/member-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 서명 비밀값은 실행마다 새로 만든다 — 소스에 비밀값처럼 보이는 글자를 남기지 않는다
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

const ALL_CONSENTS = {
  memberTerms: true,
  memberPrivacyCollection: true,
  academySharing: true,
  age19Plus: true,
  marketing: true,
  location: false,
} as const;
const REQUIRED_FIELDS = ["memberTerms", "memberPrivacyCollection", "academySharing", "age19Plus"] as const;

describe.skipIf(!dbAvailable())("회원 가입 API(계약 01 §3, S3-1.2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: `fake-identity-secret-member-${randomUUID()}`,
    ciPepper: `fake-identity-pepper-member-${randomUUID()}`,
    clock: systemClock,
  });
  /** 가짜 본인확인 토큰. personKey 가 같으면 같은 사람(같은 CI 해시)이다 */
  const tokenFor = (personKey: string) =>
    identity.issue({
      name: "김회원",
      gender: "male",
      birthDate: Temporal.PlainDate.from("1995-03-02"),
      phone: "01012345678",
      personKey,
    }).verificationToken;

  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:member-signup:${randomUUID()}` });
  // 기본 하루 5회라 한 파일에서 넘친다 — 시험용으로 넉넉히
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };
  const getSession = (headers: Headers) => auth.api.getSession({ headers });
  const routesWith = (port: IdentityVerificationPort) =>
    createMemberSignupRoutes({ db: handle.db, getSession, identityVerification: port, clock: systemClock, limiter, identityRule: roomyRule });

  /** 가입 전 로그인 계정(시드 계정 로그인과 같은 상태) — Bearer 토큰을 돌려준다 */
  async function loggedInUser(key: string): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true },
      { method: "admin" },
    );
    return (await ctx.internalAdapter.createSession(user.id)).token;
  }

  async function post(bearer: string | null, body: unknown, port: IdentityVerificationPort = identity) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer !== null) headers["authorization"] = `Bearer ${bearer}`;
    const res = await routesWith(port).signup(new Request(`${BASE}/api/members`, { method: "POST", headers, body: JSON.stringify(body) }), {});
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  const body = (token: string, extra: Record<string, unknown> = {}) => ({
    verificationToken: token,
    noticeAcknowledged: true,
    nickname: "서연",
    consents: ALL_CONSENTS,
    ...extra,
  });

  type Counts = { members: number; consents: number; audits: number };
  async function counts(): Promise<Counts> {
    const { rows } = await q(`SELECT (SELECT count(*) FROM members)::int AS members,
                                     (SELECT count(*) FROM member_consents)::int AS consents,
                                     (SELECT count(*) FROM audit_logs WHERE action = 'member.signup_completed')::int AS audits`);
    return rows[0] as Counts;
  }
  const ZERO: Counts = { members: 0, consents: 0, audits: 0 };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    await q('TRUNCATE auth."user", auth.account, auth.session, auth."twoFactor", auth.verification CASCADE');
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("성공: 201 Member — 이름·성별·생년·연락처는 본인확인 값, 닉네임은 받은 값, 동의는 필수 넷 + 고른 선택", async () => {
    const bearer = await loggedInUser("ok");
    const res = await post(bearer, body(tokenFor("person-ok"), { nickname: "  서연  댄서 " }));
    expect(res.status).toBe(201);
    const member = memberSchema.parse(res.body);
    expect(member).toMatchObject({
      name: "김회원",
      nickname: "서연 댄서", // 앞뒤 공백 자르고 가운데 연속 공백은 한 칸
      gender: "male",
      birthDate: "1995-03-02",
      phoneMasked: "010-****-5678",
      profile: { interestGenres: [], regions: [], availableFrom: null, availableTo: null, experienceLevel: null },
      baseGenre: null,
      onboarding: { profileDone: false, baseGenreDone: false },
    });
    // 응답에 전체 번호·CI 가 없다
    expect(JSON.stringify(res.body)).not.toContain("01012345678");

    const { rows: m } = await q("SELECT name, gender, birth_date::text AS b, phone, nickname, nickname_changed_at, identity_ci_hash FROM members");
    expect(m).toEqual([
      expect.objectContaining({ name: "김회원", gender: "male", b: "1995-03-02", phone: "01012345678", nickname: "서연 댄서", nickname_changed_at: null }),
    ]);
    expect(m[0].identity_ci_hash).toMatch(/^[0-9a-f]{64}$/);

    const { rows: c } = await q("SELECT item, source, withdrawn_at, terms_version_id FROM member_consents ORDER BY item");
    expect(c.map((r) => r.item).sort()).toEqual([...MEMBER_REQUIRED_CONSENT_ITEMS, "marketing_consent"].sort());
    expect(c.every((r) => r.source === "signup" && r.withdrawn_at === null)).toBe(true);
    expect((await counts()).audits).toBe(1);
  });

  test("수용 ①: 필수 동의 넷 중 하나라도 false 면 422 CONSENT_REQUIRED, 아무 행도 안 생긴다", async () => {
    const bearer = await loggedInUser("consent");
    for (const field of REQUIRED_FIELDS) {
      const res = await post(bearer, body(tokenFor(`person-consent-${field}`), { consents: { ...ALL_CONSENTS, [field]: false } }));
      expect(res.status, field).toBe(422);
      expect(res.code, field).toBe("CONSENT_REQUIRED");
      expect(res.body["fields"], field).toEqual([{ path: `consents.${field}`, message: "필수 동의예요" }]);
    }
    // 동의 칸이 아예 빠져도 가입 안 됨(형식 오류)
    const { consents: _omit, ...noConsents } = body(tokenFor("person-consent-none"));
    expect((await post(bearer, noConsents)).status).toBe(422);
    expect(await counts()).toEqual(ZERO);
    // 선택 둘은 꺼도 가입된다
    const ok = await post(bearer, body(tokenFor("person-consent-ok"), { consents: { ...ALL_CONSENTS, marketing: false, location: false } }));
    expect(ok.status).toBe(201);
    expect((await counts()).consents).toBe(4);
  });

  test("수용 ①: 본인확인 결과에 이름·성별·생년·연락처 중 하나라도 비면 422, 행 0 — 빈 값을 채워 넣지 않는다", async () => {
    const bearer = await loggedInUser("identity-hole");
    const base = { ok: true as const, ciHash: "a".repeat(64), name: "김회원", gender: "male" as const, birthDate: Temporal.PlainDate.from("1995-03-02"), phone: "01012345678" };
    const holes: Record<string, unknown>[] = [{ name: "  " }, { gender: "" }, { phone: "" }];
    for (const hole of holes) {
      const port: IdentityVerificationPort = { verify: async () => ({ ...base, ...hole }) as never };
      const res = await post(bearer, body("stub-token"), port);
      expect(res.status, JSON.stringify(hole)).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
    }
    // 생년이 없는 토큰·전화가 형식에 안 맞는 토큰은 가짜 본인확인이 아예 발급하지 않는다(포트 계약이 PlainDate 필수)
    expect(() =>
      identity.issue({ name: "김회원", gender: "male", birthDate: Temporal.PlainDate.from("1995-03-02"), phone: "", personKey: "x" }),
    ).toThrow(RangeError);
    expect(await counts()).toEqual(ZERO);
  });

  test("이름·성별·생년·연락처는 본문으로 못 보낸다 — 실으면 422, 본인확인 값으로만 채운다", async () => {
    const bearer = await loggedInUser("override");
    for (const extra of [{ name: "가짜이름" }, { gender: "female" }, { birthDate: "2010-01-01" }, { phone: "01099998888" }]) {
      const res = await post(bearer, body(tokenFor("person-override"), extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
    }
    expect(await counts()).toEqual(ZERO);
  });

  test("수용 ②: 같은 CI 로 다른 계정이 두 번째 가입하면 409 IDENTITY_ALREADY_USED, 첫 계정은 그대로", async () => {
    const first = await post(await loggedInUser("ci-a"), body(tokenFor("person-same")));
    expect(first.status).toBe(201);
    const before = await counts();
    const second = await post(await loggedInUser("ci-b"), body(tokenFor("person-same"), { nickname: "다른사람" }));
    expect(second.status).toBe(409);
    expect(second.code).toBe("IDENTITY_ALREADY_USED");
    expect(JSON.stringify(second.body)).not.toContain("김회원");
    expect(await counts()).toEqual(before);
    // 다른 사람(다른 personKey)은 된다
    expect((await post(await loggedInUser("ci-c"), body(tokenFor("person-other")))).status).toBe(201);
  });

  test("수용 ②: 같은 CI 동시 가입 둘 — 하나만 201, 다른 하나는 409", async () => {
    const [a, b] = await Promise.all([
      post(await loggedInUser("race-a"), body(tokenFor("person-race"))),
      post(await loggedInUser("race-b"), body(tokenFor("person-race"))),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await counts()).members).toBe(1);
  });

  test("같은 세션이 다시 보내면 200 같은 Member, 행이 늘지 않는다", async () => {
    const bearer = await loggedInUser("again");
    const first = await post(bearer, body(tokenFor("person-again")));
    expect(first.status).toBe(201);
    const again = await post(bearer, body(tokenFor("person-again")));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await counts()).toEqual({ members: 1, consents: 5, audits: 1 });
  });

  test("닉네임: 없음·빈 글자·1자·13자·허용 안 된 문자 422 VALIDATION_FAILED(fields: nickname), 2자·12자는 된다", async () => {
    const bearer = await loggedInUser("nick");
    const { nickname: _omit, ...withoutNickname } = body(tokenFor("person-nick-0"));
    const bad: unknown[] = [withoutNickname, body(tokenFor("n1"), { nickname: "   " }), body(tokenFor("n2"), { nickname: "서" }), body(tokenFor("n3"), { nickname: "가나다라마바사아자차카타" + "파" }), body(tokenFor("n4"), { nickname: "서연!" }), body(tokenFor("n5"), { nickname: null })];
    for (const b of bad) {
      const res = await post(bearer, b);
      expect(res.status, JSON.stringify(b)).toBe(422);
      expect(res.code).toBe("VALIDATION_FAILED");
      expect((res.body["fields"] as { path: string }[]).map((f) => f.path)).toContain("nickname");
    }
    expect(await counts()).toEqual(ZERO);
    // 경계: 2자, 12자(서로 다른 계정·사람)
    expect((await post(bearer, body(tokenFor("n-two"), { nickname: "서연" }))).status).toBe(201);
    const twelve = await post(await loggedInUser("nick-12"), body(tokenFor("n-twelve"), { nickname: "가나다라마바사아자차카타" }));
    expect(twelve.status).toBe(201);
    expect(memberSchema.parse(twelve.body).nickname).toBe("가나다라마바사아자차카타");
  });

  test("닉네임 금칙어는 422 NICKNAME_NOT_ALLOWED(대소문자·띄어 쓰기 우회 포함), 행 0", async () => {
    const bearer = await loggedInUser("blocked");
    for (const nickname of ["운영자", "kdance팬", "KDance", "관 리 자", "Admin_01"]) {
      const res = await post(bearer, body(tokenFor(`blocked-${nickname}`), { nickname }));
      expect(res.status, nickname).toBe(422);
      expect(res.code, nickname).toBe("NICKNAME_NOT_ALLOWED");
    }
    expect(await counts()).toEqual(ZERO);
  });

  test("닉네임 중복은 허용한다 — 다른 사람이 같은 닉네임으로 가입해도 201", async () => {
    expect((await post(await loggedInUser("dup-a"), body(tokenFor("dup-a")))).status).toBe(201);
    expect((await post(await loggedInUser("dup-b"), body(tokenFor("dup-b")))).status).toBe(201);
    const { rows } = await q("SELECT count(*)::int AS n FROM members WHERE nickname = '서연'");
    expect(rows[0].n).toBe(2);
  });

  test("고지 확인 false·토큰 무효·세션 없음은 거부, 행 0", async () => {
    const bearer = await loggedInUser("misc");
    expect((await post(bearer, body(tokenFor("m1"), { noticeAcknowledged: false }))).code).toBe("VALIDATION_FAILED");
    const forged = await post(bearer, body(`${tokenFor("m2")}x`));
    expect([forged.status, forged.code]).toEqual([422, "VALIDATION_FAILED"]);
    const noSession = await post(null, body(tokenFor("m3")));
    expect([noSession.status, noSession.code]).toEqual([401, "UNAUTHENTICATED"]);
    expect(await counts()).toEqual(ZERO);
  });

  test("DB 도 닉네임 길이를 지킨다(ck_members_nickname) — 1자·13자·앞뒤 공백 행은 직접 넣어도 거부", async () => {
    for (const nickname of ["서", "가나다라마바사아자차카타파", " 서연"]) {
      await expect(
        q(
          `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
           VALUES (uuidv7(), $1, '직접', 'male', '1990-01-01', '01000000000', $1, $2, now(), now())`,
          [`raw-${randomUUID()}`, nickname],
        ),
      ).rejects.toThrow(/ck_members_nickname/);
    }
  });
});
