// S1-2.7(소속 승인·거절 API — 몫 비율 입력) — 계약 08 §3 의 승인·거절 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-7.db.test.ts 였는데, 기능 이름(academy-affiliation-decisions)으로 바꿨다.
//   핵심(verify): 시나리오 1(초대 링크 → pending → 비율 없이 승인 422 SHARE_RATE_REQUIRED → 비율 넣고 승인 active)
//               · 시나리오 5(다른 학원 대표 403) · 동시 승인 2건 → 알림 1건.
//   나머지: 학원 직원 승인(비율 행 없음, 비율 보내면 422) · 이미 active 면 200 같은 본문 · 다른 상태 409 · 없는 id 404
//           · 거절(사유 기록·알림·감사, 「기타」는 글 필수) · 위임 강사 403 · 2단계 전 401.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  AFFILIATION_APPROVED_AUDIT_ACTION,
  AFFILIATION_REJECTED_AUDIT_ACTION,
  approvedAffiliationSchema,
  createApproveAffiliationRoute,
  createRejectAffiliationRoute,
  rejectedAffiliationSchema,
} from "@/lib/server/services/academy-affiliation-decisions";
import { createCreateInviteRoute, createdInviteSchema } from "@/lib/server/services/academy-invites";
import { acceptedAffiliationSchema, createAcceptInviteRoute } from "@/lib/server/services/instructor-invite-accept";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-decision-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("소속 승인·거절 — 몫 비율 입력(계약 08 §3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  let instructorSeq = 0;

  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });

  /** 직원 계정 + 세션. roles 는 role_grants 에 넣을 역할 */
  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    return id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 새 강사 + 학원에 직접 신청한 pending 행 하나(신청 경로는 S1-2.6 에서 확인했다) */
  async function pendingAffiliation(academy: string): Promise<{ affiliationId: string; instructorId: string }> {
    instructorSeq += 1;
    const instructorId = await makeStaff(`instr${instructorSeq}`, ["instructor"]);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'pending', 'application', now()) RETURNING id`,
      [academyIds[academy], instructorId],
    );
    return { affiliationId: (rows[0] as { id: string }).id, instructorId };
  }

  // mode "web" 은 관리자 웹처럼 서명 쿠키로 보낸다 — Bearer(대표 앱)는 2단계를 묻지 않아 웹 규칙을 확인할 수 없다
  const headers = (who: string | undefined, mode: "app" | "web" = "app"): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined && mode === "web") h["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else if (who !== undefined) h["authorization"] = `Bearer ${tokens[who]}`;
    return h;
  };

  async function call(kind: "approve" | "reject", who: string | undefined, academy: string, id: string, body: unknown, mode: "app" | "web" = "app") {
    const academyId = academyIds[academy] ?? academy;
    const route = kind === "approve" ? createApproveAffiliationRoute(deps()) : createRejectAffiliationRoute(deps());
    const res = await route(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${id}/${kind}`, {
        method: "POST",
        headers: headers(who, mode),
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, id }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const approve = (who: string | undefined, academy: string, id: string, body: unknown, mode: "app" | "web" = "app") =>
    call("approve", who, academy, id, body, mode);
  const reject = (who: string | undefined, academy: string, id: string, body: unknown, mode: "app" | "web" = "app") =>
    call("reject", who, academy, id, body, mode);

  const affiliationRow = async (id: string) =>
    (
      await q(
        `SELECT status, is_academy_employee, decided_at, decided_by_account_id, reject_reason_code, reject_reason_text
         FROM instructor_affiliations WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const shareRates = async (id: string) =>
    (await q("SELECT rate_bp, effective_from, created_by_account_id FROM instructor_share_rates WHERE affiliation_id = $1", [id])).rows;
  const notifications = async (kind: string, id: string) =>
    (
      await q(
        "SELECT recipient_staff_account_id, category, dedupe_key, payload FROM notifications WHERE kind = $1 AND dedupe_key = $2",
        [kind, `affiliation:${id}:${kind.replace("affiliation_", "")}`],
      )
    ).rows;
  const auditCount = async (action: string, id: string) =>
    (await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2", [action, id])).rows[0].n as number;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    await makeStaff("iu", ["instructor"]);
    // 학원 A 에서 명단 관리를 위임받은 강사 — 승인·거절은 대표 고유 권한이라 403 이어야 한다
    const delegateId = await makeStaff("delegate", ["instructor"]);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyIds["A"], delegateId],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["ownerA"],
    ]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("시나리오 1 — 초대 링크로 pending, 비율 없이 승인하면 422 SHARE_RATE_REQUIRED, 비율을 넣으면 active + 첫 비율 행 + 강사 알림 + 감사", async () => {
    // 대표가 링크를 만들고(S1-2.4) 강사가 받는다(S1-2.5) → pending
    const academyId = academyIds["A"]!;
    const created = await createCreateInviteRoute({ ...deps(), inviteBaseUrl: "https://k-dancex4.test" })(
      new Request(`${BASE}/api/academies/${academyId}/invites`, { method: "POST", headers: headers("ownerA"), body: "{}" }),
      { params: Promise.resolve({ academyId }) },
    );
    const token = createdInviteSchema.parse(await created.json()).inviteUrl.split("/invite/")[1] ?? "";
    const acceptedRes = await createAcceptInviteRoute(deps())(
      new Request(`${BASE}/api/instructor/invites/${token}/accept`, { method: "POST", headers: headers("iu") }),
      { params: Promise.resolve({ token }) },
    );
    expect(acceptedRes.status).toBe(201);
    const { affiliationId } = acceptedAffiliationSchema.parse(await acceptedRes.json());
    expect((await affiliationRow(affiliationId)).status).toBe("pending");

    // 비율 없이 승인 — 422 SHARE_RATE_REQUIRED, 아무것도 바뀌지 않는다
    for (const body of [{ isAcademyEmployee: false }, { isAcademyEmployee: false, shareRateBp: null }]) {
      const res = await approve("ownerA", "A", affiliationId, body);
      expect(res).toMatchObject({ status: 422, json: { code: "SHARE_RATE_REQUIRED" } });
    }
    expect((await affiliationRow(affiliationId)).status).toBe("pending");
    expect(await shareRates(affiliationId)).toHaveLength(0);

    // 비율 60% 로 승인 — active
    const res = await approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 });
    expect(res.status).toBe(200);
    const body = approvedAffiliationSchema.parse(res.json);
    expect(body).toEqual({
      affiliationId,
      status: "active",
      isAcademyEmployee: false,
      shareRateBp: 6000,
      decidedAt: NOW.toString(),
    });

    const row = await affiliationRow(affiliationId);
    expect(row.status).toBe("active");
    expect(row.is_academy_employee).toBe(false);
    expect(row.decided_by_account_id).toBe(staffIds["ownerA"]);

    // 첫 비율 판본 — effective_from = 승인 시각, 만든 사람 = 대표
    const rates = await shareRates(affiliationId);
    expect(rates).toHaveLength(1);
    expect(rates[0].rate_bp).toBe(6000);
    expect(new Date(rates[0].effective_from).toISOString()).toBe(new Date(NOW.epochMilliseconds).toISOString());
    expect(rates[0].created_by_account_id).toBe(staffIds["ownerA"]);

    // 강사 알림 1건(operations, 비율 포함) · 감사 1행
    const notes = await notifications("affiliation_approved", affiliationId);
    expect(notes).toHaveLength(1);
    expect(notes[0].recipient_staff_account_id).toBe(staffIds["iu"]);
    expect(notes[0].category).toBe("operations");
    expect(notes[0].payload).toMatchObject({ affiliationId, shareRateBp: 6000, isAcademyEmployee: false, academyName: "A댄스학원" });
    expect(notes[0].payload.body).toContain("60%");
    expect(await auditCount(AFFILIATION_APPROVED_AUDIT_ACTION, affiliationId)).toBe(1);
  });

  test("이미 active 면 200 같은 본문 — 비율 행·알림·감사를 더 만들지 않는다(두 번째 본문 값으로 바꾸지 않는다)", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    const first = await approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 5500 });
    const second = await approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 7000 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(await shareRates(affiliationId)).toHaveLength(1);
    expect(await notifications("affiliation_approved", affiliationId)).toHaveLength(1);
    expect(await auditCount(AFFILIATION_APPROVED_AUDIT_ACTION, affiliationId)).toBe(1);
  });

  test("동시 승인 2건(웹·앱) → 둘 다 200, 소속 active 1번, 비율 행 1개, 알림 1건 (10회)", async () => {
    for (let i = 0; i < 10; i += 1) {
      const { affiliationId } = await pendingAffiliation("A");
      const results = await Promise.all([
        approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 }),
        approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results[0]!.json).toEqual(results[1]!.json);
      expect(await shareRates(affiliationId)).toHaveLength(1);
      expect(await notifications("affiliation_approved", affiliationId)).toHaveLength(1);
      expect(await auditCount(AFFILIATION_APPROVED_AUDIT_ACTION, affiliationId)).toBe(1);
    }
  });

  test("학원 직원 강사 — 비율 없이 승인, 비율 행 없음. 직원인데 비율을 보내면 422", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    const withRate = await approve("ownerA", "A", affiliationId, { isAcademyEmployee: true, shareRateBp: 6000 });
    expect(withRate).toMatchObject({ status: 422, json: { code: "VALIDATION_FAILED" } });
    expect((await affiliationRow(affiliationId)).status).toBe("pending");

    const res = await approve("ownerA", "A", affiliationId, { isAcademyEmployee: true });
    expect(res.status).toBe(200);
    expect(approvedAffiliationSchema.parse(res.json)).toMatchObject({ status: "active", isAcademyEmployee: true, shareRateBp: null });
    expect((await affiliationRow(affiliationId)).is_academy_employee).toBe(true);
    expect(await shareRates(affiliationId)).toHaveLength(0);
    const notes = await notifications("affiliation_approved", affiliationId);
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toMatchObject({ isAcademyEmployee: true, shareRateBp: null });
  });

  test("본문 검사 — 직원 여부 빠짐·범위 밖 비율(10001·-1·소수)·모르는 칸은 422 VALIDATION_FAILED", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    for (const body of [
      {},
      { shareRateBp: 6000 },
      { isAcademyEmployee: false, shareRateBp: 10001 },
      { isAcademyEmployee: false, shareRateBp: -1 },
      { isAcademyEmployee: false, shareRateBp: 60.5 },
      { isAcademyEmployee: false, shareRateBp: 6000, status: "active" },
    ]) {
      expect(await approve("ownerA", "A", affiliationId, body)).toMatchObject({ status: 422, json: { code: "VALIDATION_FAILED" } });
    }
    expect(await approve("ownerA", "A", affiliationId, "{")).toMatchObject({ status: 400, json: { code: "BAD_REQUEST" } });
    // 경계값 0·10000 은 받는다
    expect((await approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 10000 })).status).toBe(200);
    const other = await pendingAffiliation("A");
    expect((await approve("ownerA", "A", other.affiliationId, { isAcademyEmployee: false, shareRateBp: 0 })).status).toBe(200);
  });

  test("다른 상태(거절·철회)면 409 AFFILIATION_STATE_CONFLICT · 없는 id·모양 틀린 id 404", async () => {
    const rejected = await pendingAffiliation("A");
    expect((await reject("ownerA", "A", rejected.affiliationId, { reasonCode: "genre_mismatch" })).status).toBe(200);
    expect(await approve("ownerA", "A", rejected.affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 })).toMatchObject({
      status: 409,
      json: { code: "AFFILIATION_STATE_CONFLICT" },
    });
    const withdrawn = await pendingAffiliation("A");
    await q("UPDATE instructor_affiliations SET status = 'withdrawn' WHERE id = $1", [withdrawn.affiliationId]);
    expect(await approve("ownerA", "A", withdrawn.affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 })).toMatchObject({
      status: 409,
      json: { code: "AFFILIATION_STATE_CONFLICT" },
    });
    expect(await reject("ownerA", "A", withdrawn.affiliationId, { reasonCode: "not_recruiting" })).toMatchObject({
      status: 409,
      json: { code: "AFFILIATION_STATE_CONFLICT" },
    });
    expect(await approve("ownerA", "A", randomUUID(), { isAcademyEmployee: true })).toMatchObject({ status: 404, json: { code: "NOT_FOUND" } });
    expect(await approve("ownerA", "A", "not-a-uuid", { isAcademyEmployee: true })).toMatchObject({ status: 404 });
    expect(await reject("ownerA", "A", randomUUID(), { reasonCode: "other", reasonText: "x" })).toMatchObject({ status: 404 });
  });

  test("시나리오 5 — 학원 B 대표가 학원 A 의 소속을 승인·거절하면 403 FORBIDDEN, 행은 그대로. 자기 학원 경로로 남의 id 를 넣으면 404", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    expect(await approve("ownerB", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 })).toMatchObject({
      status: 403,
      json: { code: "FORBIDDEN" },
    });
    expect(await reject("ownerB", "A", affiliationId, { reasonCode: "genre_mismatch" })).toMatchObject({
      status: 403,
      json: { code: "FORBIDDEN" },
    });
    // 학원 B 경로에 학원 A 의 소속 id — 남의 학원에 그 신청이 「있는지」 알리지 않는다
    expect(await approve("ownerB", "B", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 })).toMatchObject({
      status: 404,
      json: { code: "NOT_FOUND" },
    });
    expect((await affiliationRow(affiliationId)).status).toBe("pending");
    expect(await shareRates(affiliationId)).toHaveLength(0);
    expect(await notifications("affiliation_approved", affiliationId)).toHaveLength(0);
  });

  test("권한 — 위임 강사·강사 403 · 2단계 전 대표 401 SECOND_FACTOR_REQUIRED · 로그인 없음 401", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    for (const who of ["delegate", "iu"]) {
      expect((await approve(who, "A", affiliationId, { isAcademyEmployee: true })).status).toBe(403);
      expect((await reject(who, "A", affiliationId, { reasonCode: "genre_mismatch" })).status).toBe(403);
    }
    const c = await pendingAffiliation("C");
    expect(await approve("ownerNo2fa", "C", c.affiliationId, { isAcademyEmployee: true }, "web")).toMatchObject({
      status: 401,
      json: { code: "SECOND_FACTOR_REQUIRED" },
    });
    // 대표 앱(Bearer)은 2단계를 묻지 않는다 — appToo 경로. 틀린 사유로 보내 가드만 넘는지 보고 아무것도 바꾸지 않는다
    expect((await reject("ownerNo2fa", "C", c.affiliationId, { reasonCode: "no-such-reason" })).status).toBe(422);
    expect((await approve(undefined, "A", affiliationId, { isAcademyEmployee: true })).status).toBe(401);
    expect((await reject(undefined, "A", affiliationId, { reasonCode: "genre_mismatch" })).status).toBe(401);
    expect((await affiliationRow(affiliationId)).status).toBe("pending");
  });

  test("거절 — rejected + 사유 기록 + 강사 알림(사유 포함) + 감사, 다시 거절하면 409", async () => {
    const { affiliationId, instructorId } = await pendingAffiliation("A");
    const res = await reject("ownerA", "A", affiliationId, { reasonCode: "genre_mismatch", reasonText: null });
    expect(res.status).toBe(200);
    expect(rejectedAffiliationSchema.parse(res.json)).toEqual({
      affiliationId,
      status: "rejected",
      reasonCode: "genre_mismatch",
      reasonText: null,
      decidedAt: NOW.toString(),
    });
    const row = await affiliationRow(affiliationId);
    expect(row).toMatchObject({ status: "rejected", reject_reason_code: "genre_mismatch", reject_reason_text: null });
    expect(row.decided_by_account_id).toBe(staffIds["ownerA"]);

    const notes = await notifications("affiliation_rejected", affiliationId);
    expect(notes).toHaveLength(1);
    expect(notes[0].recipient_staff_account_id).toBe(instructorId);
    expect(notes[0].category).toBe("operations");
    expect(notes[0].payload).toMatchObject({ reasonCode: "genre_mismatch", reasonText: null });
    expect(notes[0].payload.body).toContain("학원 장르와 맞지 않아요");
    expect(await auditCount(AFFILIATION_REJECTED_AUDIT_ACTION, affiliationId)).toBe(1);

    expect(await reject("ownerA", "A", affiliationId, { reasonCode: "genre_mismatch" })).toMatchObject({
      status: 409,
      json: { code: "AFFILIATION_STATE_CONFLICT" },
    });
    expect(await notifications("affiliation_rejected", affiliationId)).toHaveLength(1);
  });

  test("거절 본문 — 「기타」는 글 필수(공백만도 안 됨), 모르는 사유 코드·사유 빠짐 422, 「기타」+글은 글을 저장·알림", async () => {
    const { affiliationId } = await pendingAffiliation("A");
    for (const body of [
      {},
      { reasonCode: "just_because" },
      { reasonCode: "other" },
      { reasonCode: "other", reasonText: "   " },
      { reasonCode: "other", reasonText: "가".repeat(501) },
    ]) {
      expect(await reject("ownerA", "A", affiliationId, body)).toMatchObject({ status: 422, json: { code: "VALIDATION_FAILED" } });
    }
    expect((await affiliationRow(affiliationId)).status).toBe("pending");

    const res = await reject("ownerA", "A", affiliationId, { reasonCode: "other", reasonText: "  평일 낮 수업만 있어요  " });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ reasonCode: "other", reasonText: "평일 낮 수업만 있어요" });
    expect((await affiliationRow(affiliationId)).reject_reason_text).toBe("평일 낮 수업만 있어요");
    const notes = await notifications("affiliation_rejected", affiliationId);
    expect(notes[0].payload.body).toContain("평일 낮 수업만 있어요");
  });

  test("승인 ↔ 거절이 동시에 와도 하나만 이긴다 — 결과 행과 알림이 서로 맞는다 (5회)", async () => {
    for (let i = 0; i < 5; i += 1) {
      const { affiliationId } = await pendingAffiliation("A");
      const [a, r] = await Promise.all([
        approve("ownerA", "A", affiliationId, { isAcademyEmployee: false, shareRateBp: 6000 }),
        reject("ownerA", "A", affiliationId, { reasonCode: "not_recruiting" }),
      ]);
      const row = await affiliationRow(affiliationId);
      if (row.status === "active") {
        expect([a.status, r.status]).toEqual([200, 409]);
        expect(await shareRates(affiliationId)).toHaveLength(1);
        expect(await notifications("affiliation_rejected", affiliationId)).toHaveLength(0);
      } else {
        expect(row.status).toBe("rejected");
        expect([a.status, r.status]).toEqual([409, 200]);
        expect(await shareRates(affiliationId)).toHaveLength(0);
        expect(await notifications("affiliation_approved", affiliationId)).toHaveLength(0);
      }
    }
  });
});
