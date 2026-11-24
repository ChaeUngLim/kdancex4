// S3-5.3(연락처 전체 열람) — `POST /api/academies/{academyId}/members/{memberId}/contact-reveal`(계약 18 §5)을
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   이름: 로드맵 verify 의 tests/db/s3-5-3.db.test.ts 는 Task 번호 이름이라 기능 이름(member-contact-reveal)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//   verify: 사유가 없으면 거부(422 CONTACT_REASON_REQUIRED, 감사 행 0) · 열람 1건에 감사 행 1건(수용 ②, SC-025(연락처 열람 기록 100%))
//   그리고: 감사 행에는 가린 번호만(전체 번호 없음) · 감사 쓰기가 실패하면 번호를 내리지 않는다(500) · 다시 열면 새 행 ·
//           권한(위임 강사·다른 학원 대표 403, 이 학원 회원이 아니면 403, 없는 회원 404) · 맥락 회차가 남의 학원이면 404
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  checkContactReason,
  contactRevealResponseSchema,
  createMemberContactRevealRoute,
  MEMBER_CONTACT_REVEALED_AUDIT_ACTION,
} from "@/lib/server/services/member-contact-reveal";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertCancellationChain, insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "contact-reveal-test-".repeat(3);
const BASE = "http://localhost:3000";
// 시험 회원의 전체 번호(fixtures/cancellation.ts 의 insertMember 값)와 그 가린 값
const FULL_PHONE = "010-1111-2222";
const MASKED_PHONE = "010-****-2222";

// ---- 순수 계산(단위) ------------------------------------------------------------------------------

describe("사유 검사(계약 §5 — 앞뒤 공백을 자르고 1~200자)", () => {
  test("빈 값·공백만·없음은 null", () => {
    expect(checkContactReason(undefined)).toBeNull();
    expect(checkContactReason("")).toBeNull();
    expect(checkContactReason("   \n\t ")).toBeNull();
  });
  test("앞뒤 공백을 자른 글자를 돌려준다", () => {
    expect(checkContactReason("  수업 변경 안내 전화 ")).toBe("수업 변경 안내 전화");
  });
  test("200자는 통과, 201자는 null(한글도 글자 하나로 센다)", () => {
    expect(checkContactReason("가".repeat(200))).toBe("가".repeat(200));
    expect(checkContactReason("가".repeat(201))).toBeNull();
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("연락처 전체 열람(계약 18 §5, S3-5.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let REVEAL: ReturnType<typeof createMemberContactRevealRoute>;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  let academyId = "";
  let sessionId = "";
  let memberId = "";
  let otherAcademyId = "";
  let otherSessionId = "";
  let outsiderId = "";

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `rev_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    return id;
  }

  async function reveal(who: string, academy: string, member: string, body: unknown, mode: "app" | "web" = "web") {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (mode === "web") headers["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await REVEAL(
      new Request(`${BASE}/api/academies/${academy}/members/${member}/contact-reveal`, { method: "POST", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ academyId: academy, memberId: member }) },
    );
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, text, json, code: json["code"] as string | undefined, cache: res.headers.get("cache-control") };
  }

  const auditRows = () =>
    q<{ actor_staff_account_id: string; actor_role: string; academy_id: string; target_table: string; target_id: string; reason: string; after: unknown }>(
      "SELECT actor_staff_account_id, actor_role, academy_id, target_table, target_id::text, reason, after FROM audit_logs WHERE action = $1 ORDER BY occurred_at, id",
      [MEMBER_CONTACT_REVEALED_AUDIT_ACTION],
    );

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    REVEAL = createMemberContactRevealRoute({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }) });

    await makeStaff("owner", ["owner"]);
    await makeStaff("ownerB", ["owner"]);

    // 학원 A — 결제 완료한 회원 한 명(전체 번호 010-1111-2222)
    const chainA = await insertCancellationChain(handle.pool, { stage: "paid", method: "card" });
    academyId = chainA.academyId;
    sessionId = chainA.sessionId;
    memberId = chainA.memberId;
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);

    // 학원 A 의 위임 강사(roster_manage) — 명단은 보지만 전체 연락처는 못 본다(계약 §5 규칙 5)
    const delegateId = await makeStaff("delegate", ["instructor"]);
    const [aff] = await q<{ id: string }>(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now()) RETURNING id`,
      [academyId, delegateId],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      aff!.id,
      staffIds["owner"],
    ]);

    // 학원 B — 다른 대표의 학원과 회차
    const chainB = await insertCancellationChain(handle.pool, { stage: "paid", method: "card" });
    otherAcademyId = chainB.academyId;
    otherSessionId = chainB.sessionId;
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [otherAcademyId, staffIds["ownerB"]]);

    // 어느 학원에서도 결제한 적 없는 회원
    outsiderId = (await insertMember(handle.pool)).memberId;
  });

  afterAll(async () => {
    await q("DROP TRIGGER IF EXISTS trg_fail_contact_audit ON audit_logs");
    await q("DROP FUNCTION IF EXISTS fail_contact_audit()");
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 사유가 없으면 거부 — 422 CONTACT_REASON_REQUIRED, 번호 없음, 감사 행 0건(수용 ②)", async () => {
    for (const body of [{}, { reason: "" }, { reason: "    " }, { reason: "가".repeat(201) }]) {
      const res = await reveal("owner", academyId, memberId, body);
      expect(res.status, res.text).toBe(422);
      expect(res.code).toBe("CONTACT_REASON_REQUIRED");
      expect(res.text).not.toContain(FULL_PHONE);
    }
    expect(await auditRows()).toHaveLength(0);
  });

  test("② 사유를 적으면 전체 번호 + 감사 행 정확히 1건(사유·열람자·학원·가린 값·맥락) — SC-025", async () => {
    const res = await reveal("owner", academyId, memberId, { reason: "  수업 변경 안내 전화 ", sessionId });
    expect(res.status, res.text).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = contactRevealResponseSchema.parse(res.json);
    expect(body).toMatchObject({ memberId, phone: FULL_PHONE });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_staff_account_id: staffIds["owner"],
      actor_role: "owner",
      academy_id: academyId,
      target_table: "members",
      target_id: memberId,
      reason: "수업 변경 안내 전화",
      after: { context: { sessionId }, masked: MASKED_PHONE },
    });
    // 감사 행에는 전체 번호가 없다(가린 값만)
    expect(JSON.stringify(rows[0])).not.toContain(FULL_PHONE);
    // 응답 시각 = 감사 행 시각(기록이 먼저 남은 그 시각)
    const [at] = await q<{ t: string }>(
      `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t FROM audit_logs WHERE action = $1`,
      [MEMBER_CONTACT_REVEALED_AUDIT_ACTION],
    );
    expect(body.revealedAt).toBe(at!.t);
  });

  test("③ 다시 열면 새 사유로 새 행 — 열람 n번 = 감사 n건(대표 앱 Bearer 도 같다)", async () => {
    const before = (await auditRows()).length;
    const again = await reveal("owner", academyId, memberId, { reason: "결제 확인 문자" }, "app");
    expect(again.status, again.text).toBe(200);
    const third = await reveal("owner", academyId, memberId, { reason: "환불 안내" });
    expect(third.status, third.text).toBe(200);
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 2);
    expect(rows.slice(-2).map((r) => r.reason)).toEqual(["결제 확인 문자", "환불 안내"]);
    expect(rows.at(-1)!.after).toEqual({ context: { sessionId: null }, masked: MASKED_PHONE });
  });

  test("④ 감사 쓰기가 실패하면 번호를 내리지 않는다 — 500 INTERNAL, 행도 남지 않음", async () => {
    await q(`CREATE OR REPLACE FUNCTION fail_contact_audit() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.reason = '실패 시험' THEN RAISE EXCEPTION 'audit write failed (test)'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER trg_fail_contact_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_contact_audit()");
    try {
      const before = (await auditRows()).length;
      const res = await reveal("owner", academyId, memberId, { reason: "실패 시험" });
      expect(res.status).toBe(500);
      expect(res.code).toBe("INTERNAL");
      expect(res.text).not.toContain(FULL_PHONE);
      expect(res.text).not.toContain("1111");
      expect(await auditRows()).toHaveLength(before);
    } finally {
      await q("DROP TRIGGER IF EXISTS trg_fail_contact_audit ON audit_logs");
      await q("DROP FUNCTION IF EXISTS fail_contact_audit()");
    }
  });

  test("⑤ 권한 — 위임 강사 403 · 다른 학원 대표 403 · 이 학원 회원이 아니면 403 · 없는 회원 404 · 남의 회차 맥락 404, 모두 행 0", async () => {
    const before = (await auditRows()).length;
    const delegate = await reveal("delegate", academyId, memberId, { reason: "전화" }, "app");
    expect(delegate.status, delegate.text).toBe(403);
    const otherOwner = await reveal("ownerB", academyId, memberId, { reason: "전화" });
    expect(otherOwner.status, otherOwner.text).toBe(403);
    const outsider = await reveal("owner", academyId, outsiderId, { reason: "전화" });
    expect(outsider.status, outsider.text).toBe(403);
    expect(outsider.code).toBe("FORBIDDEN");
    const missing = await reveal("owner", academyId, randomUUID(), { reason: "전화" });
    expect(missing.status, missing.text).toBe(404);
    const badSession = await reveal("owner", academyId, memberId, { reason: "전화", sessionId: otherSessionId });
    expect(badSession.status, badSession.text).toBe(404);
    for (const res of [delegate, otherOwner, outsider, missing, badSession]) expect(res.text).not.toContain(FULL_PHONE);
    expect(await auditRows()).toHaveLength(before);
  });
});
