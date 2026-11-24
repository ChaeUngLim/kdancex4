// S7-2.6(이용 제한 절차) — 운영자가 이용을 제한하면 사유와 함께 기록되는지 실제 DB 에서 확인한다(FR-254(이용 제한 절차)).
//   계약: _workspace/03_contracts/15-ops.md §2-8(이용 제한 절차) · §2-7 resolve 의 openRestriction
//   이름: 로드맵 verify 의 tests/db/s7-2-6.db.test.ts 는 Task 번호 이름이라 기능 이름(restriction-procedure)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 운영자가 학원에 「수업 게시 제한 예정」 절차를 연다 — 201 notice_sent · 소명 기한 7일 · 절차 행에 사유 코드·사유 글
//      · 감사 restriction.opened 정확히 1행(사유 글이 reason 칸과 after 둘 다에) · 대표에게 restriction_notice 1건(사유 글 포함)
//      · 아직 조치 전이라 academy_restrictions 행 0 · 같은 열쇠 200 같은 절차(감사 그대로 1) · 다른 열쇠 같은 대상 409 CASE_ALREADY_OPEN
//   ② 긴급(urgent) — 학원 정산 보류를 먼저 적용: measure_applied · academy_restrictions payout_hold 1행(source_case_id) · 감사 1행
//   ③ 회원·강사 대상 — 회원 알림(칩 없음) · 강사 직원 알림(운영 칩) · 감사 각 1행
//   ④ 막히는 경우 — 사유 글 없음 422 · 모르는 조치 422 · 열쇠 없음 400 · 없는 대상 404 · 2단계 전 운영자 401 · 운영자 아닌 직원 403
//      (모두 절차·감사 0행)
//   ⑤ 신고 처리에서 열기 — 인정 + openRestriction 이면 같은 트랜잭션에서 source='report' 절차, reports.restriction_case_id 연결
//      · 같은 수업에 두 번째 인정 신고는 새 절차 없이 같은 절차에 잇는다 · 다시 눌러도 같은 id
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { reportCreatedSchema, reportResolvedSchema } from "@/lib/server/schemas/reports";
import { restrictionOpenedSchema } from "@/lib/server/schemas/restrictions";
import { createReportRoutes } from "@/lib/server/services/reports";
import { createRestrictionRoutes } from "@/lib/server/services/restrictions";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-24T03:00:00Z");
const REASON = "앱 밖 결제를 유도한 신고가 확인됐어요";

describe.skipIf(!dbAvailable())("이용 제한 절차(계약 15 §2-8, S7-2.6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: () => NOW });
  const restrictionRoutes = () => createRestrictionRoutes(deps());
  const reportRoutes = () => createReportRoutes(deps());

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let academyA = "";
  let academyB = "";
  let classA = "";

  async function loggedIn(key: string, twoFactor = false): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    return user.id;
  }

  async function staff(key: string, roles: string[], twoFactor = false): Promise<string> {
    const userId = await loggedIn(key, twoFactor);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    ids[key] = id;
    return id;
  }

  const headers = (who: string | null, key: string | null = null) => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) h["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) h["idempotency-key"] = key;
    return h;
  };
  async function call(res: Promise<Response>) {
    const response = await res;
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json, code: json["code"] };
  }
  const open = (who: string | null, body: unknown, key: string | null = `idem-${randomUUID()}`) =>
    call(
      restrictionRoutes().open(
        new Request(`${BASE}/api/admin/restrictions`, { method: "POST", headers: headers(who, key), body: JSON.stringify(body) }),
        undefined,
      ),
    );
  const auditFor = async (caseId: string) =>
    (
      await q("SELECT action, actor_staff_account_id::text AS actor, academy_id::text AS academy, reason, after FROM audit_logs WHERE target_id = $1", [
        caseId,
      ])
    ).rows as { action: string; actor: string; academy: string | null; reason: string; after: Record<string, unknown> }[];
  const noticesFor = async (caseId: string) =>
    (
      await q(
        `SELECT COALESCE(recipient_member_id::text, '') AS member, COALESCE(recipient_staff_account_id::text, '') AS staff,
                COALESCE(category, '') AS category, payload
         FROM notifications WHERE kind = 'restriction_notice' AND payload->>'caseId' = $1`,
        [caseId],
      )
    ).rows as { member: string; staff: string; category: string; payload: Record<string, unknown> }[];
  const countRows = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    // 회원 서아가 학원 A 수업을 예약 — 수업 신고와 회원 대상 제한에 쓴다
    const seoaUser = await loggedIn("seoa");
    const { reservationId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q(
      `SELECT r.member_id::text AS member_id, c.academy_id::text AS academy_id, c.id::text AS class_id FROM reservations r
       JOIN class_offerings off ON off.id = r.offering_id JOIN classes c ON c.id = off.class_id WHERE r.id = $1`,
      [reservationId],
    );
    const row = rows[0] as { member_id: string; academy_id: string; class_id: string };
    await q("UPDATE members SET auth_user_id = $1, nickname = '서아' WHERE id = $2", [seoaUser, row.member_id]);
    ids["seoa"] = row.member_id;
    academyA = row.academy_id;
    classA = row.class_id;
    academyB = (await insertOffering(handle.pool)).academyId;

    await staff("ownerA", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyA, ids["ownerA"]]);
    await staff("ownerB", ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyB, ids["ownerB"]]);
    await staff("instructor", ["instructor"]);
    await staff("operator", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
    await staff("owner2fa", ["owner"], true);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  const academyNotice = () => ({
    subjectKind: "academy",
    subjectId: academyA,
    reasonCode: "off_platform_payment",
    reasonText: REASON,
    plannedMeasure: "listing_limit",
  });

  test("① 학원에 사유 통지 — notice_sent · 절차 행에 사유 · 제한 뒤 감사 행 1건 · 대표 알림 · 재생 200 · 같은 대상 409", async () => {
    const key = `idem-${randomUUID()}`;
    const first = await open("operator", academyNotice(), key);
    expect(first.status).toBe(201);
    const opened = restrictionOpenedSchema.parse(first.json);
    expect(opened).toEqual({ caseId: opened.caseId, state: "notice_sent", explanationDueAt: "2026-12-01T03:00:00.000Z" });

    // 절차 행 — 누구를 · 왜 · 어떤 조치 예정인지 · 누가 열었는지
    const { rows } = await q(
      `SELECT subject_kind, subject_academy_id::text AS academy, source, reason_code, reason_text, planned_measure, measure, state, urgent,
              opened_by_account_id::text AS opened_by
       FROM restriction_cases WHERE id = $1`,
      [opened.caseId],
    );
    expect(rows[0]).toEqual({
      subject_kind: "academy",
      academy: academyA,
      source: "operator_manual",
      reason_code: "off_platform_payment",
      reason_text: REASON,
      planned_measure: "listing_limit",
      measure: null,
      state: "notice_sent",
      urgent: false,
      opened_by: ids["operator"],
    });

    // 감사 — 제한 뒤 감사 행 1건, 사유와 함께
    const audit = await auditFor(opened.caseId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "restriction.opened", actor: ids["operator"], academy: academyA, reason: REASON });
    expect(audit[0]!.after).toMatchObject({ state: "notice_sent", reasonCode: "off_platform_payment", reasonText: REASON, plannedMeasure: "listing_limit" });

    // 대표에게 사유 통지 1건(운영 칩, 사유 글 포함) · 조치 전이라 학원 제한 행 없음
    const notices = await noticesFor(opened.caseId);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ staff: ids["ownerA"], category: "operations" });
    expect(String(notices[0]!.payload["body"])).toContain(REASON);
    expect((await q("SELECT count(*)::int AS n FROM academy_restrictions WHERE academy_id = $1", [academyA])).rows[0].n).toBe(0);

    // 같은 열쇠 → 200 같은 절차, 감사·알림 그대로
    const replay = await open("operator", academyNotice(), key);
    expect(replay.status).toBe(200);
    expect(restrictionOpenedSchema.parse(replay.json).caseId).toBe(opened.caseId);
    expect(await auditFor(opened.caseId)).toHaveLength(1);
    expect(await noticesFor(opened.caseId)).toHaveLength(1);

    // 다른 열쇠 · 같은 대상 · 같은 출처 → 409
    const again = await open("operator", academyNotice());
    expect(again.status).toBe(409);
    expect(again.code).toBe("CASE_ALREADY_OPEN");
    expect((await q("SELECT count(*)::int AS n FROM restriction_cases WHERE subject_academy_id = $1", [academyA])).rows[0].n).toBe(1);
  });

  test("② 긴급 — 정산 보류를 먼저 적용: measure_applied · 학원 제한 payout_hold 1행(source_case_id) · 감사 1행", async () => {
    const res = await open("operator", {
      subjectKind: "academy",
      subjectId: academyB,
      reasonCode: "illegal_dangerous",
      reasonText: "불법 촬영 신고가 들어와 확인하는 동안 정산을 멈춰요",
      plannedMeasure: "payout_hold",
      urgent: true,
    });
    expect(res.status).toBe(201);
    const opened = restrictionOpenedSchema.parse(res.json);
    expect(opened.state).toBe("measure_applied");

    const { rows } = await q("SELECT measure, measure_applied_at IS NOT NULL AS applied, urgent FROM restriction_cases WHERE id = $1", [opened.caseId]);
    expect(rows[0]).toEqual({ measure: "payout_hold", applied: true, urgent: true });
    const held = await q("SELECT kind, source_case_id::text AS case_id, ended_at FROM academy_restrictions WHERE academy_id = $1", [academyB]);
    expect(held.rows).toEqual([{ kind: "payout_hold", case_id: opened.caseId, ended_at: null }]);
    const audit = await auditFor(opened.caseId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ state: "measure_applied", urgent: true, academyRestrictionKind: "payout_hold" });
    expect(await noticesFor(opened.caseId)).toHaveLength(1);
  });

  test("③ 회원·강사 대상 — 회원 알림(칩 없음) · 강사 직원 알림(운영 칩) · 감사 각 1행", async () => {
    const member = await open("operator", {
      subjectKind: "member",
      subjectId: ids["seoa"],
      reasonCode: "harassment",
      reasonText: "강사에게 반복해서 욕설 메시지를 보냈어요",
      plannedMeasure: "warning",
    });
    expect(member.status).toBe(201);
    const memberCase = restrictionOpenedSchema.parse(member.json).caseId;
    expect(await noticesFor(memberCase)).toEqual([expect.objectContaining({ member: ids["seoa"], staff: "", category: "" })]);
    expect(await auditFor(memberCase)).toHaveLength(1);

    const instructor = await open("operator", {
      subjectKind: "instructor",
      subjectId: ids["instructor"],
      reasonCode: "terms_violation",
      reasonText: "수업 중 회원에게 개인 계좌 송금을 요구했어요",
      plannedMeasure: "feature_limit",
    });
    expect(instructor.status).toBe(201);
    const instructorCase = restrictionOpenedSchema.parse(instructor.json).caseId;
    expect(await noticesFor(instructorCase)).toEqual([expect.objectContaining({ member: "", staff: ids["instructor"], category: "operations" })]);
    expect(await auditFor(instructorCase)).toHaveLength(1);
  });

  test("④ 막히는 경우 — 사유 없음 422 · 모르는 조치 422 · 열쇠 없음 400 · 없는 대상 404 · 2단계 전 401 · 운영자 아님 403 (행 0)", async () => {
    const casesBefore = await countRows("restriction_cases");
    const auditBefore = await countRows("audit_logs");
    const body = { subjectKind: "member", subjectId: ids["seoa"], reasonCode: "other", reasonText: "사유", plannedMeasure: "suspension" };

    expect((await open("operator", { ...body, reasonText: "   " })).status).toBe(422);
    expect((await open("operator", { ...body, reasonText: undefined })).status).toBe(422);
    expect((await open("operator", { ...body, plannedMeasure: "ban_forever" })).status).toBe(422);
    expect((await open("operator", body, null)).status).toBe(400);
    const missing = await open("operator", { ...body, subjectId: randomUUID() });
    expect(missing.status).toBe(404);
    expect((await open("operator", { ...body, subjectKind: "instructor", subjectId: ids["ownerA"] })).status).toBe(404);
    expect((await open("operatorNo2fa", body)).status).toBe(401);
    expect((await open("owner2fa", body)).status).toBe(403);
    expect((await open(null, body)).status).toBe(401);

    expect(await countRows("restriction_cases")).toBe(casesBefore);
    expect(await countRows("audit_logs")).toBe(auditBefore);
  });

  test("⑤ 신고 처리에서 열기 — 인정 + openRestriction 은 source=report 절차 · 두 번째 인정 신고는 같은 절차에 잇는다", async () => {
    const fileReport = async (reasonCode: string) => {
      const res = await call(
        reportRoutes().create(
          new Request(`${BASE}/api/reports`, {
            method: "POST",
            headers: headers("seoa", `idem-${randomUUID()}`),
            body: JSON.stringify({ targetKind: "class", targetId: classA, reasonCode, detail: "다음 달부터 계좌로 직접 보내라고 했어요" }),
          }),
          {},
        ),
      );
      return reportCreatedSchema.parse(res.json).reportId;
    };
    const resolve = (reportId: string, body: unknown) =>
      call(
        reportRoutes().resolve(
          new Request(`${BASE}/api/admin/reports/${reportId}/resolve`, { method: "POST", headers: headers("operator"), body: JSON.stringify(body) }),
          { params: Promise.resolve({ reportId }) },
        ),
      );
    const upheld = { outcome: "upheld", note: "대표에게 사유 통지", openRestriction: { measure: "listing_limit", reasonText: REASON } };

    const first = await fileReport("off_platform_payment");
    const done = await resolve(first, upheld);
    expect(done.status).toBe(200);
    const caseId = reportResolvedSchema.parse(done.json).restrictionCaseId;
    expect(caseId).not.toBeNull();

    const { rows } = await q(
      "SELECT subject_kind, subject_academy_id::text AS academy, source, source_report_id::text AS report, reason_code, reason_text, state FROM restriction_cases WHERE id = $1",
      [caseId],
    );
    // 수업 신고 → 그 수업을 연 학원이 대상. 운영자 직접 연 ① 절차와 출처가 달라 따로 열린다
    expect(rows[0]).toEqual({
      subject_kind: "academy",
      academy: academyA,
      source: "report",
      report: first,
      reason_code: "off_platform_payment",
      reason_text: REASON,
      state: "notice_sent",
    });
    expect((await q("SELECT restriction_case_id::text AS c FROM reports WHERE id = $1", [first])).rows[0].c).toBe(caseId);
    expect((await auditFor(caseId!)).map((a) => a.action)).toEqual(["restriction.opened"]);

    // 다시 눌러도 같은 id · 절차 그대로 하나
    expect(reportResolvedSchema.parse((await resolve(first, upheld)).json).restrictionCaseId).toBe(caseId);
    // 같은 수업에 두 번째 인정 신고 → 새 절차 없이 같은 절차
    const second = await fileReport("info_mismatch");
    expect(reportResolvedSchema.parse((await resolve(second, upheld)).json).restrictionCaseId).toBe(caseId);
    expect((await q("SELECT count(*)::int AS n FROM restriction_cases WHERE source = 'report'")).rows[0].n).toBe(1);
    expect(await auditFor(caseId!)).toHaveLength(1);
  });
});
