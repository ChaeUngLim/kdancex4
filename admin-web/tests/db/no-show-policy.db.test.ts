// S1-3.8(노쇼 기준 조회 API) — `GET /api/no-show-policy` 가 기준 한 벌을 계약 모양 그대로 주는지
// 진짜 Better Auth 세션(Bearer 토큰) + 진짜 PostgreSQL 표로 확인한다. 계약: _workspace/03_contracts/09-owner-notices.md §2.
//   로드맵 verify 의 파일 이름은 tests/db/s1-3-8.db.test.ts 였는데, 기능 이름(no-show-policy)으로 바꿨다.
//   핵심(verify): 통합 테스트로 응답 모양을 본다 — 응답 본문을 strict 스키마로 parse 해 키 이름·타입을 1대1로 확인.
//   나머지: 대표·강사 둘 다 같은 값 · 세션 없음 401 · 직원 계정 없음 403 · 2단계 인증 전 401 · 정지 403.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { NO_SHOW_POLICY } from "@/lib/domain/no-show-policy";
import { createNoShowPolicyRoute, noShowPolicyResponseSchema } from "@/lib/server/services/no-show-policy";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "no-show-policy-test-secret-0123456789-012345";
const BASE = "http://localhost:3000";

// 계약 09 §2 의 예시 본문 그대로. 상수가 계약과 어긋나면 여기서 잡힌다
const CONTRACT_BODY = {
  version: "2026-11-10",
  rule: "빠진 회차는 수업을 들은 것으로 보고 정산하며 환불·보강하지 않는다",
  memberNoticeText: "연락 없이 빠진 회차는 수업을 들은 것으로 처리돼요. 그 회차는 환불하거나 보강하지 않아요.",
  points: ["결석 알림은 불이익에 쓰지 않는다", "노쇼 기록·대기 순번 불이익 없음", "휴강은 옮기기·환불 규칙", "분쟁은 결제·환불 기록이 근거"],
};

describe.skipIf(!dbAvailable())("GET /api/no-show-policy(계약 09 §2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let GET: ReturnType<typeof createNoShowPolicyRoute>;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};

  /** auth.user 하나와 세션 하나. twoFactor=true 면 인증 앱을 켠 계정(2단계를 마친 세션). */
  async function makeUser(key: string, twoFactor: boolean): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key.toLowerCase(), displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function makeStaff(key: string, opts: { twoFactor?: boolean; role?: string; status?: string } = {}) {
    const authUserId = await makeUser(key, opts.twoFactor ?? true);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, $4, now())", [
      id,
      authUserId,
      key,
      opts.status ?? "active",
    ]);
    if (opts.role !== undefined) {
      await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, opts.role]);
    }
  }

  /** 실제 라우트처럼 GET 을 부른다. 200 이면 본문을 계약 스키마로 parse 한다(모르는 키가 있으면 실패). */
  async function call(who?: string) {
    const headers: Record<string, string> = who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` };
    const res = await GET(new Request(`${BASE}/api/no-show-policy`, { headers }), undefined);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) return { status: 200, body: noShowPolicyResponseSchema.parse(body) };
    return { status: res.status, code: body["code"] };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    GET = createNoShowPolicyRoute({ db: handle.db, getSession: (headers) => auth.api.getSession({ headers }) });

    await makeStaff("owner", { role: "owner" });
    await makeStaff("instructor", { role: "instructor" });
    await makeStaff("no2fa", { role: "instructor", twoFactor: false });
    await makeStaff("suspended", { role: "instructor", status: "suspended" });
    await makeUser("member", true); // 직원 계정이 없는 사람(회원 쪽 로그인)
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify — 대표는 기준 한 벌을 계약 모양(키 4개, 모르는 키 없음) 그대로 받는다", async () => {
    expect(await call("owner")).toEqual({ status: 200, body: CONTRACT_BODY });
  });

  test("강사도 같은 기준을 받는다 — 학원·역할마다 다르지 않다", async () => {
    expect(await call("instructor")).toEqual({ status: 200, body: CONTRACT_BODY });
  });

  test("응답은 상수의 복사본이다 — 상수가 그대로 남아 있다", async () => {
    await call("owner");
    expect(NO_SHOW_POLICY.points).toHaveLength(4);
    expect(NO_SHOW_POLICY.version).toBe("2026-11-10");
  });

  test("막힘: 세션 없음 401 · 직원 계정 없음 403 · 2단계 인증 전 401 · 정지 403", async () => {
    expect(await call()).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    expect(await call("member")).toEqual({ status: 403, code: "STAFF_ACCOUNT_REQUIRED" });
    expect(await call("no2fa")).toEqual({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await call("suspended")).toEqual({ status: 403, code: "ACCOUNT_SUSPENDED" });
  });
});
