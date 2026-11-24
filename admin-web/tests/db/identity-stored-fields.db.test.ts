// S8-2.4(저장 항목 검사) — 본인확인 결과는 이름·성별·생년만 저장되고 주민등록번호는 어디에도 없다(플랜 S8-2 수용 ②).
//   ① 스키마: DB 의 모든 칸 이름과 계약(prisma/contract.json)의 모든 키에 주민등록번호 모양 이름(rrn·ssn·jumin·resident)이 없다.
//      CI 를 담는 칸은 원본이 아니라 해시(`*_ci_hash`)뿐이다.
//   ② 저장 칸: members 에서 사람을 가리키는 칸은 이름·성별·생년 + 가입 연락처(FR-002) + CI 해시 + 닉네임(본인이 고른 값)뿐이다.
//      연락처는 FR-002(가입 정보 수집·고지)의 가입 칸이라 본인확인 저장 항목과 별개로 본다(계약 17 열린 점 ⑩ — 이 Task 의 판단).
//   ③ 실제 가입: 본인확인 결과에 주민등록번호·CI 원본·원문 응답이 덤으로 실려 와도(실 기관 응답을 흉내 낸 포트),
//      가입 뒤 DB 의 모든 행(public·auth 스키마)과 서버 로그(console 출력)·응답 어디에도 그 값이 없다.
//   검사기 자체 확인: 일부러 주민등록번호를 넣으면 같은 검사가 그것을 찾아낸다(못 찾는 검사기는 검사기가 아니다).
//
// 이름: verify 의 tests/db/s8-2-4.db.test.ts 는 Task 번호 이름이라 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { FakeIdentityVerification } from "@/lib/server/fakes/fake-identity";
import type { IdentityVerificationPort, IdentityVerificationResult } from "@/lib/server/ports/identity";
import { createRateLimiter, RATE_LIMIT_RULES } from "@/lib/server/rate-limit";
import { createMemberSignupRoutes } from "@/lib/server/services/member-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6380";

/** 주민등록번호를 가리키는 칸 이름 — 단어 경계(_)로만 본다. business_registration_number 같은 사업자 칸은 걸리지 않는다 */
const RRN_NAME = /(^|_)(rrn|ssn|jumin|jumin_no|resident|resident_registration)(_|$)|resident_?registration|주민/i;
/** CI 를 가리키는 칸 이름. 이 이름이면 반드시 해시 칸(`_ci_hash`)이어야 한다 */
const CI_NAME = /(^|_)ci(_|$)/i;
/**
 * 주민등록번호 글자 모양(앞 6자리-뒤 7자리, 뒤 첫 자리 1~4). 붙임표가 있는 모양만 본다 —
 * 붙임표 없는 13자리는 CI 해시(16진수) 안에서도 우연히 나올 수 있어 거짓 경보가 난다. 붙임표 없는 값은 아래에서 정확한 값으로 찾는다.
 */
const RRN_TEXT = /(^|[^0-9])\d{6}-[1-4]\d{6}([^0-9]|$)/;

/** 시험용 가짜 주민등록번호와 CI 원본 — 이 값이 DB·로그·응답 어디에도 남으면 실패다 */
const FAKE_RRN = "950302-1234567";
const FAKE_RRN_DIGITS = "9503021234567";
const RAW_CI = `RAW-CI-${randomUUID()}`;

const ALL_CONSENTS = {
  memberTerms: true,
  memberPrivacyCollection: true,
  academySharing: true,
  age19Plus: true,
  marketing: false,
  location: false,
} as const;

/**
 * 실 기관 응답을 흉내 낸 「새는」 포트. 계약 모양(IdentityVerificationResult) 위에 주민등록번호·CI 원본·원문 응답을 덤으로 싣는다.
 * 가입 서비스가 결과 객체를 통째로 저장하거나 로그에 찍으면 이 값이 어딘가에 남는다 — 그걸 잡으려는 것이다.
 */
function leakyPort(inner: IdentityVerificationPort): IdentityVerificationPort {
  return {
    async verify(token, now) {
      const result = await inner.verify(token, now);
      if (!result.ok) return result;
      const extra = {
        residentRegistrationNumber: FAKE_RRN,
        rrn: FAKE_RRN_DIGITS,
        ci: RAW_CI,
        rawResponse: { ci: RAW_CI, residentRegistrationNumber: FAKE_RRN, birthDate: "1995-03-02" },
      };
      return { ...result, ...extra } as IdentityVerificationResult;
    },
  };
}

/** JSON 안의 모든 키를 모은다 — 계약 파일의 칸·모델 이름을 다 훑기 위해서다 */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

describe.skipIf(!dbAvailable())("본인확인 저장 항목 검사(S8-2.4 · FR-002 · FR-003)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const identity = new FakeIdentityVerification({
    secret: `fake-identity-secret-stored-${randomUUID()}`,
    ciPepper: `fake-identity-pepper-stored-${randomUUID()}`,
    clock: systemClock,
  });
  const limiter = createRateLimiter({ redisUrl: REDIS_URL, keyPrefix: `kdance:test:identity-stored:${randomUUID()}` });
  const roomyRule = { ...RATE_LIMIT_RULES.identityVerification, limit: 1000 };

  /** 스키마 목록 안 모든 칸(표·칸 이름). 시스템 스키마는 뺀다 */
  async function columnsIn(schemas: string[]): Promise<{ table_schema: string; table_name: string; column_name: string }[]> {
    const { rows } = await q(
      `SELECT table_schema, table_name, column_name FROM information_schema.columns
        WHERE table_schema = ANY($1::text[]) ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );
    return rows as { table_schema: string; table_name: string; column_name: string }[];
  }

  /** 사용자 스키마 이름 전부(pg_*·information_schema 제외) — 나중에 스키마가 늘어도 같이 훑는다 */
  async function userSchemas(): Promise<string[]> {
    const { rows } = await q(
      `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname`,
    );
    return (rows as { nspname: string }[]).map((r) => r.nspname);
  }

  /**
   * DB 의 모든 행을 글자로 펼쳐 금지 값을 찾는다. 행 전체를 text 로 바꾸므로 json·bytea(16진) 칸도 같이 본다.
   * 찾은 곳을 「스키마.표」 목록으로 돌려준다(값 자체는 돌려주지 않는다).
   */
  async function tablesContaining(schemas: string[], needles: string[], pattern: RegExp): Promise<string[]> {
    const { rows } = await q(
      `SELECT quote_ident(table_schema) || '.' || quote_ident(table_name) AS name FROM information_schema.tables
        WHERE table_schema = ANY($1::text[]) AND table_type = 'BASE TABLE' ORDER BY 1`,
      [schemas],
    );
    const hits: string[] = [];
    for (const { name } of rows as { name: string }[]) {
      const { rows: lines } = await q(`SELECT t::text AS line FROM ${name} t`);
      const found = (lines as { line: string }[]).some(
        ({ line }) => pattern.test(line) || needles.some((needle) => line.includes(needle)),
      );
      if (found) hits.push(name);
    }
    return hits;
  }

  /** 가입 전 로그인 계정(시드 계정 로그인과 같은 상태) — Bearer 토큰 */
  async function loggedInUser(key: string): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true },
      { method: "admin" },
    );
    return (await ctx.internalAdapter.createSession(user.id)).token;
  }

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
    await q("DROP SCHEMA IF EXISTS s8_2_4_probe CASCADE");
    await closeTestDb(handle);
  });

  test("① 스키마: DB 의 어떤 칸 이름에도 주민등록번호가 없고, CI 칸은 해시 칸뿐이다", async () => {
    const schemas = await userSchemas();
    expect(schemas).toEqual(expect.arrayContaining(["public", "auth"]));
    const columns = await columnsIn(schemas);
    expect(columns.length).toBeGreaterThan(100); // 실제로 훑었는지(빈 목록이면 검사가 아니다)

    const rrnColumns = columns.filter((c) => RRN_NAME.test(c.column_name) || RRN_NAME.test(c.table_name));
    expect(rrnColumns).toEqual([]);

    const ciColumns = columns.filter((c) => CI_NAME.test(c.column_name));
    expect(ciColumns.map((c) => c.column_name).every((name) => name.endsWith("_ci_hash"))).toBe(true);
    // 회원·직원 계정 둘 다 해시 칸만 있다
    expect(ciColumns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual(
      expect.arrayContaining(["members.identity_ci_hash", "staff_accounts.identity_ci_hash"]),
    );
  });

  test("① 계약(prisma/contract.json): 모델·칸 키 어디에도 주민등록번호 이름이 없다", () => {
    const path = fileURLToPath(new URL("../../prisma/contract.json", import.meta.url));
    const keys = collectKeys(JSON.parse(readFileSync(path, "utf8")));
    expect(keys.length).toBeGreaterThan(1000);
    expect(keys).toContain("identity_ci_hash"); // 칸 이름이 키로 들어 있는 파일이 맞는지
    expect(keys.filter((key) => RRN_NAME.test(key))).toEqual([]);
  });

  test("② 저장 칸: members 의 사람 정보 칸은 이름·성별·생년 + 가입 연락처 + CI 해시 + 닉네임뿐이다", async () => {
    // 사람을 가리킬 수 있는 칸 이름(이름·성별·생년·전화·CI·주민번호 계열)만 골라 정확히 이 목록인지 본다.
    // 새 개인정보 칸을 members 에 더하면 이 테스트가 깨진다 — 그때 저장 근거(spec FR)를 확인하고 목록을 고친다.
    const PERSONAL = /(name|gender|sex|birth|phone|mobile|tel|ci|identity|rrn|ssn|resident|jumin)/i;
    const members = (await columnsIn(["public"])).filter((c) => c.table_name === "members").map((c) => c.column_name);
    expect(members.filter((name) => PERSONAL.test(name)).sort()).toEqual([
      "birth_date", // 본인확인 생년
      "gender", // 본인확인 성별
      "identity_ci_hash", // CI 원본이 아니라 HMAC 해시(한 사람 한 계정, FR-003)
      "name", // 본인확인 이름
      "nickname", // 회원이 고른 표시 이름(FR-019a) — 본인확인 값 아님
      "nickname_changed_at",
      "phone", // 가입 연락처(FR-002) — 계약 17 열린 점 ⑩: 본인확인 저장 항목과 별개
    ]);

    // 직원 계정도 같은 기준: 표시 이름·생년·암호화한 연락처·가린 연락처·CI 해시뿐
    const staff = (await columnsIn(["public"])).filter((c) => c.table_name === "staff_accounts").map((c) => c.column_name);
    expect(staff.filter((name) => PERSONAL.test(name)).sort()).toEqual([
      "birth_date",
      "display_name",
      "identity_ci_hash",
      "phone_enc",
      "phone_masked",
    ]);
  });

  test("③ 실제 가입: 본인확인 결과에 주민등록번호·CI 원본이 덤으로 와도 DB·로그·응답 어디에도 남지 않는다", async () => {
    // 서버가 찍는 로그를 모두 받아 둔다(console 의 다섯 갈래)
    const logged: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    try {
      const bearer = await loggedInUser("rrn-check");
      const token = identity.issue({
        name: "김회원",
        gender: "male",
        birthDate: Temporal.PlainDate.from("1995-03-02"),
        phone: "01012345678",
        personKey: "person-rrn-check",
      }).verificationToken;
      const routes = createMemberSignupRoutes({
        db: handle.db,
        getSession: (headers: Headers) => auth.api.getSession({ headers }),
        identityVerification: leakyPort(identity),
        clock: systemClock,
        limiter,
        identityRule: roomyRule,
      });
      const res = await routes.signup(
        new Request(`${BASE}/api/members`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ verificationToken: token, noticeAcknowledged: true, nickname: "서연", consents: ALL_CONSENTS }),
        }),
        {},
      );
      const text = await res.text();
      expect(res.status).toBe(201);

      // 응답에도 없다
      for (const banned of [FAKE_RRN, FAKE_RRN_DIGITS, RAW_CI]) expect(text).not.toContain(banned);

      // 저장된 것은 이름·성별·생년(+연락처·CI 해시)뿐이고, CI 해시는 원본이 아니다
      const { rows } = await q("SELECT name, gender, birth_date::text AS birth, phone, identity_ci_hash FROM members");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: "김회원", gender: "male", birth: "1995-03-02", phone: "01012345678" });
      const ciHash = (rows[0] as { identity_ci_hash: string }).identity_ci_hash;
      expect(ciHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ciHash).not.toContain(RAW_CI);

      // DB 의 모든 행 — 회원·동의·감사 기록(audit_logs)·로그인 계정(auth) 전부 — 에 없다
      const schemas = await userSchemas();
      expect(await tablesContaining(schemas, [FAKE_RRN, FAKE_RRN_DIGITS, RAW_CI], RRN_TEXT)).toEqual([]);
      // 감사 기록이 실제로 생겼는지(빈 표를 훑고 통과한 게 아니다)
      const { rows: audits } = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'member.signup_completed'");
      expect(audits[0]).toEqual({ n: 1 });

      // 서버 로그에도 없다
      const allLogs = logged.join("\n");
      for (const banned of [FAKE_RRN, FAKE_RRN_DIGITS, RAW_CI]) expect(allLogs).not.toContain(banned);
      expect(RRN_TEXT.test(allLogs)).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("검사기 자체 확인: 주민등록번호를 일부러 넣으면 칸 이름 검사와 행 검사가 그것을 찾아낸다", async () => {
    // 칸 이름 — 따로 만든 시험 스키마에 주민등록번호 칸을 만들고 같은 검사를 돌린다
    await q("DROP SCHEMA IF EXISTS s8_2_4_probe CASCADE");
    await q("CREATE SCHEMA s8_2_4_probe");
    try {
      await q("CREATE TABLE s8_2_4_probe.people (id int, resident_registration_number text, jumin_no text, business_registration_number text)");
      const probeColumns = (await columnsIn(["s8_2_4_probe"])).filter((c) => RRN_NAME.test(c.column_name)).map((c) => c.column_name);
      // 사업자등록번호 칸은 걸리지 않는다(거짓 경보 없음)
      expect(probeColumns.sort()).toEqual(["jumin_no", "resident_registration_number"]);

      // 행 — 붙임표 있는 모양은 정규식이, 붙임표 없는 값은 정확한 값 비교가 잡는다
      await q("INSERT INTO s8_2_4_probe.people (id, business_registration_number) VALUES (1, $1)", [FAKE_RRN]);
      expect(await tablesContaining(["s8_2_4_probe"], [], RRN_TEXT)).toEqual(["s8_2_4_probe.people"]);
      await q("UPDATE s8_2_4_probe.people SET business_registration_number = $1", [FAKE_RRN_DIGITS]);
      expect(await tablesContaining(["s8_2_4_probe"], [FAKE_RRN_DIGITS], RRN_TEXT)).toEqual(["s8_2_4_probe.people"]);
      // 사업자등록번호(10자리, 붙임표 3-2-5)는 주민등록번호 모양이 아니다
      await q("UPDATE s8_2_4_probe.people SET business_registration_number = '123-45-67890'");
      expect(await tablesContaining(["s8_2_4_probe"], [FAKE_RRN_DIGITS], RRN_TEXT)).toEqual([]);
    } finally {
      await q("DROP SCHEMA IF EXISTS s8_2_4_probe CASCADE");
    }

    // 감사 기록(json)에 실려도 잡는다 — audit_logs 는 추가만 되는 표라 INSERT 로 넣는다(beforeEach 가 비운다)
    await q(
      `INSERT INTO audit_logs (id, actor_kind, action, target_table, target_id, after)
       VALUES (uuidv7(), 'system', 'probe.rrn', 'members', uuidv7(), $1::json)`,
      [JSON.stringify({ leaked: FAKE_RRN })],
    );
    expect(await tablesContaining(["public"], [], RRN_TEXT)).toEqual(["public.audit_logs"]);
  });
});
