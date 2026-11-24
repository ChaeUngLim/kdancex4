// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — 실제 PostgreSQL 에서 P11 사업자 점검 건의 「기한 지남」과 운영자 버튼 두 개를 확인한다.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검 — accept-explanation · suspend-listing)
//   spec: FR-250(입점 심사·게시 제한) · FR-254(이용 제한 절차 — 「7일 안에 소명이 없으면 게시를 중단」, 자동이 아니라 운영자가 누른다)
//   이름: 로드맵 verify 의 tests/db/s1-1-29.db.test.ts 는 Task 번호 이름이라 기능 이름(business-check-listing-suspension)으로 바꿨다(증거 EVIDENCE.md).
// 확인하는 것:
//   ① 점검이 폐업을 보면 제한 2개 + 절차 1건(notice_sent, 기한 감지+7일, 제한 행에 source_case_id) — 6일째는 「D-1」
//   ② 8일째 소명이 없으면 제한 2개 그대로(자동 중단 없음) + 건이 「기한 지남」
//   ③ 소명 없이 accept-explanation → 409 NO_EXPLANATION(아무것도 안 바뀜)
//   ④ 운영자 suspend-listing → 200 measure_applied · 제한 3개 · 감사 · 대표 알림 listing_suspended · 다시 눌러도 그대로
//   ⑤ 소명을 받아들이면 new_sales_blocked·payout_hold 가 닫힌다(계약 13 §10-3) · 감사 restriction.lifted · 알림 · 재호출 200
//   ⑥ 게시 중단 뒤 소명을 받아들이면 listing_suspended 까지 셋 다 닫힌다(추천안 — 절차가 연 제한은 모두 푼다)
//   ⑦ 막히는 경우 — 없는 건 404 · 다른 출처 절차 404 · 메모 너무 김 422 · 2단계 전 401 · 대표 403 · 끝난 건 409 CASE_STATE_CONFLICT
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakeBusinessStatusProvider } from "@/lib/server/fakes/fake-business-status";
import { explanationAcceptedSchema, listingSuspendedSchema } from "@/lib/server/schemas/admin-business-checks";
import { createAdminBusinessCheckRoutes, listBusinessCheckCases } from "@/lib/server/services/admin-business-checks";
import { runBusinessStatusCheck } from "@/lib/server/services/business-status-check";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 감지 시각 — 2026-11-21 03:10 KST(= 11-20 18:10Z), 매일 점검이 도는 시각. 소명 기한은 11-27 18:10Z
const DETECTED = Temporal.Instant.from("2026-11-20T18:10:00Z");
const day = (n: number) => DETECTED.add({ hours: 24 * n });

describe.skipIf(!dbAvailable())("P11 사업자 점검 — 기한 지남 · 게시 중단 · 소명 받아들이기(계약 13 §10-3, S1-1.29)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = DETECTED;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const routes = () =>
    createAdminBusinessCheckRoutes({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: () => now });

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function staff(key: string, roles: string[], twoFactor: boolean): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    ids[key] = id;
    return id;
  }

  /** 학원 한 곳 + active 대표. 사업자등록번호를 학원마다 달리 줘서 가짜 국세청 응답을 학원별로 고른다 */
  async function academy(name: string, businessNo: string): Promise<{ academyId: string; ownerId: string }> {
    const academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, business_status, business_status_checked_at, updated_at,
                              ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2::text, '서울', '마포구', 'active', '2026-11-19T18:10:00Z', now(),
               'academy', $2::text, '정수아', $3, '서울 마포구 테스트로 1', '02-000-0000', now())`,
      [academyId, name, businessNo],
    );
    const ownerId = await staff(`owner${businessNo}`, ["owner"], false);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, ownerId]);
    return { academyId, ownerId };
  }

  /** 진짜 점검 작업 경로로 폐업을 감지시킨다 */
  async function detectClosed(academyId: string, businessNo: string): Promise<string> {
    const provider = new FakeBusinessStatusProvider().respond(businessNo, { status: "closed", closedOn: "2026-11-10" });
    await runBusinessStatusCheck({ db: handle.db, businessStatus: provider, clock: fixedClock(DETECTED) }, { trigger: "daily", academyIds: [academyId] });
    const { rows } = await q("SELECT id FROM restriction_cases WHERE subject_academy_id = $1 AND source = 'business_status'", [academyId]);
    expect(rows).toHaveLength(1);
    return rows[0].id as string;
  }

  const headers = (who: string) => ({ "content-type": "application/json", authorization: `Bearer ${tokens[who]}` });
  async function call(res: Promise<Response>) {
    const response = await res;
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json, code: json["code"] };
  }
  const ctx = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
  const suspend = (who: string, caseId: string, body: unknown = { note: "소명 기한 지남" }) =>
    call(
      routes().suspend(
        new Request(`${BASE}/api/admin/console/business-checks/${caseId}/suspend-listing`, { method: "POST", headers: headers(who), body: JSON.stringify(body) }),
        ctx(caseId),
      ),
    );
  const accept = (who: string, caseId: string, body: unknown = { note: "신규 사업자등록증 확인" }) =>
    call(
      routes().accept(
        new Request(`${BASE}/api/admin/console/business-checks/${caseId}/accept-explanation`, { method: "POST", headers: headers(who), body: JSON.stringify(body) }),
        ctx(caseId),
      ),
    );

  /** 열린 제한 종류(가나다순) */
  const openKinds = async (academyId: string) =>
    (await q("SELECT kind FROM academy_restrictions WHERE academy_id = $1 AND ended_at IS NULL ORDER BY kind", [academyId])).rows.map(
      (r) => r.kind as string,
    );
  const caseRow = async (caseId: string) =>
    (
      await q(
        `SELECT state, measure, to_char(explanation_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due,
                closed_by_account_id::text AS closed_by
         FROM restriction_cases WHERE id = $1`,
        [caseId],
      )
    ).rows[0];
  const audits = async (targetId: string) =>
    (await q("SELECT action, actor_staff_account_id::text AS actor, reason FROM audit_logs WHERE target_id = $1 ORDER BY occurred_at, id", [targetId]))
      .rows as { action: string; actor: string | null; reason: string | null }[];
  const ownerNotices = async (academyId: string, kind: string) =>
    (await q("SELECT recipient_staff_account_id::text AS staff, category, payload FROM notifications WHERE academy_id = $1 AND kind = $2", [academyId, kind]))
      .rows as { staff: string; category: string; payload: Record<string, unknown> }[];
  const addExplanation = async (caseId: string, ownerId: string) =>
    q("INSERT INTO restriction_explanations (id, case_id, submitted_by_staff_account_id, body) VALUES (uuidv7(), $1, $2, $3)", [
      caseId,
      ownerId,
      "폐업 신고는 장소를 옮기는 중이라 한 것이고, 신규 사업자 등록증을 첨부해요.",
    ]);
  const listItem = async (caseId: string) => (await listBusinessCheckCases(handle.db, now)).find((i) => i.caseId === caseId);

  let A = { academyId: "", ownerId: "", caseId: "" };

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    await staff("operator", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
    await staff("owner2fa", ["owner"], true); // 2단계를 마친 대표 — 운영자 권한이 없어 403
    const a = await academy("모던스텝 합정", "1234567890");
    A = { ...a, caseId: await detectClosed(a.academyId, "1234567890") };
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 폐업 감지 → 제한 2개 + 절차 1건(기한 감지+7일) · 6일째는 D-1", async () => {
    expect(await caseRow(A.caseId)).toEqual({ state: "notice_sent", measure: null, due: "2026-11-27T18:10:00Z", closed_by: null });
    expect(await openKinds(A.academyId)).toEqual(["new_sales_blocked", "payout_hold"]);
    const linked = await q("SELECT count(*)::int AS n FROM academy_restrictions WHERE source_case_id = $1", [A.caseId]);
    expect(linked.rows[0].n).toBe(2);
    // 절차를 연 감사는 system(자동 점검)
    expect(await audits(A.caseId)).toEqual([{ action: "restriction.opened", actor: null, reason: null }]);
    // 대표 알림(S1-1.28)에 caseId 가 붙는다
    const [notice] = await ownerNotices(A.academyId, "restriction_notice");
    expect(notice?.payload["caseId"]).toBe(A.caseId);

    now = day(6);
    expect(await listItem(A.caseId)).toMatchObject({ state: "notice_sent", overdue: false, dueInDays: 1, dueLabel: "D-1", explanationCount: 0 });
  });

  test("② 8일째 소명 없음 → 제한 2개 그대로(자동 중단 없음) + 건이 「기한 지남」", async () => {
    now = day(8);
    const item = await listItem(A.caseId);
    expect(item).toMatchObject({
      academyName: "모던스텝 합정",
      state: "notice_sent",
      actions: ["new_sales_blocked", "payout_hold"],
      explanationDueAt: "2026-11-27T18:10:00.000Z",
      overdue: true,
      dueInDays: -1,
      dueLabel: "기한 지남",
    });
    expect(await openKinds(A.academyId)).toEqual(["new_sales_blocked", "payout_hold"]);
    expect((await caseRow(A.caseId)).state).toBe("notice_sent");
  });

  test("③ 소명 없이 accept-explanation → 409 NO_EXPLANATION, 아무것도 안 바뀜", async () => {
    const res = await accept("operator", A.caseId);
    expect(res).toMatchObject({ status: 409, code: "NO_EXPLANATION" });
    expect((await caseRow(A.caseId)).state).toBe("notice_sent");
    expect(await openKinds(A.academyId)).toEqual(["new_sales_blocked", "payout_hold"]);
    expect((await audits(A.caseId)).map((a) => a.action)).toEqual(["restriction.opened"]);
  });

  test("④ 운영자 suspend-listing → 제한 3개 · 감사 · 대표 알림 · 다시 눌러도 그대로", async () => {
    const res = await suspend("operator", A.caseId);
    expect(res.status).toBe(200);
    expect(listingSuspendedSchema.parse(res.json)).toEqual({ state: "measure_applied" });
    expect(await openKinds(A.academyId)).toEqual(["listing_suspended", "new_sales_blocked", "payout_hold"]);
    expect(await caseRow(A.caseId)).toMatchObject({ state: "measure_applied", measure: "listing_limit" });
    expect(await audits(A.caseId)).toEqual([
      { action: "restriction.opened", actor: null, reason: null },
      { action: "restriction.applied", actor: ids["operator"], reason: "소명 기한 지남" },
    ]);
    const listing = await q("SELECT id, source_case_id::text AS case_id FROM academy_restrictions WHERE academy_id = $1 AND kind = 'listing_suspended'", [A.academyId]);
    expect(listing.rows[0].case_id).toBe(A.caseId);
    expect((await audits(listing.rows[0].id as string)).map((a) => a.action)).toEqual(["academy_restriction.opened"]);
    const notices = await ownerNotices(A.academyId, "listing_suspended");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ staff: A.ownerId, category: "operations", payload: { caseId: A.caseId } });

    // 다시 눌러도 200 같은 본문, 행·감사·알림 그대로
    const again = await suspend("operator", A.caseId);
    expect(again).toMatchObject({ status: 200, json: { state: "measure_applied" } });
    expect(await openKinds(A.academyId)).toHaveLength(3);
    expect(await audits(A.caseId)).toHaveLength(2);
    expect(await ownerNotices(A.academyId, "listing_suspended")).toHaveLength(1);
    // 목록에서는 조치된 건이라 「기한 지남」 대신 조치 칩 셋
    expect(await listItem(A.caseId)).toMatchObject({ state: "measure_applied", overdue: false, dueLabel: null, actions: ["listing_suspended", "new_sales_blocked", "payout_hold"] });
  });

  test("⑤ 기한 안에 소명 → 받아들이면 new_sales_blocked·payout_hold 닫힘 · 감사 · 알림 · 다시 눌러도 200", async () => {
    now = day(0);
    const b = await academy("살사온 홍대", "2345678901");
    const caseId = await detectClosed(b.academyId, "2345678901");
    now = day(3);
    await addExplanation(caseId, b.ownerId);
    expect(await listItem(caseId)).toMatchObject({ explanationCount: 1, dueLabel: "D-4", overdue: false });

    const res = await accept("operator", caseId);
    expect(res.status).toBe(200);
    expect(explanationAcceptedSchema.parse(res.json)).toEqual({ state: "lifted" });
    expect(await openKinds(b.academyId)).toEqual([]);
    const closed = await q("SELECT kind, ended_by_account_id::text AS by FROM academy_restrictions WHERE academy_id = $1 ORDER BY kind", [b.academyId]);
    expect(closed.rows).toEqual([
      { kind: "new_sales_blocked", by: ids["operator"] },
      { kind: "payout_hold", by: ids["operator"] },
    ]);
    expect(await caseRow(caseId)).toMatchObject({ state: "lifted", closed_by: ids["operator"] });
    expect((await audits(caseId)).map((a) => a.action)).toEqual(["restriction.opened", "restriction.lifted"]);
    expect(await ownerNotices(b.academyId, "business_restriction_lifted")).toHaveLength(1);

    const again = await accept("operator", caseId);
    expect(again).toMatchObject({ status: 200, json: { state: "lifted" } });
    expect((await audits(caseId)).map((a) => a.action)).toEqual(["restriction.opened", "restriction.lifted"]);
    // 끝난 건에 게시 중단은 409
    expect(await suspend("operator", caseId)).toMatchObject({ status: 409, code: "CASE_STATE_CONFLICT" });
  });

  test("⑥ 게시 중단 뒤 소명을 받아들이면 listing_suspended 까지 셋 다 닫힌다", async () => {
    now = day(9);
    await addExplanation(A.caseId, A.ownerId);
    const res = await accept("operator", A.caseId);
    expect(res).toMatchObject({ status: 200, json: { state: "lifted" } });
    expect(await openKinds(A.academyId)).toEqual([]);
    expect((await caseRow(A.caseId)).state).toBe("lifted");
  });

  test("⑦ 막히는 경우 — 404 · 422 · 401 · 403 · 기각된 건 409", async () => {
    expect(await suspend("operator", randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await accept("operator", "not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await suspend("operator", A.caseId, { note: "가".repeat(1001) })).toMatchObject({ status: 422 });
    expect(await suspend("operator", A.caseId, { reason: "모르는 키" })).toMatchObject({ status: 422 });
    expect(await suspend("operatorNo2fa", A.caseId)).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await accept("owner2fa", A.caseId)).toMatchObject({ status: 403 });

    // 운영자가 직접 연 절차(다른 출처)는 이 화면의 건이 아니다 — 404
    const manual = await q(
      `INSERT INTO restriction_cases (id, subject_kind, subject_academy_id, source, reason_code, reason_text, planned_measure, state,
                                      notice_sent_at, updated_at)
       VALUES (uuidv7(), 'academy', $1, 'operator_manual', 'terms_violation', '약관 위반', 'warning', 'notice_sent', now(), now()) RETURNING id`,
      [A.academyId],
    );
    expect(await suspend("operator", manual.rows[0].id as string)).toMatchObject({ status: 404 });

    // 기각된 사업자 점검 건 — 두 버튼 모두 409 CASE_STATE_CONFLICT
    now = day(0);
    const c = await academy("탱고하우스 연남", "3456789012");
    const caseId = await detectClosed(c.academyId, "3456789012");
    await q("UPDATE restriction_cases SET state = 'dismissed' WHERE id = $1", [caseId]);
    await addExplanation(caseId, c.ownerId);
    expect(await accept("operator", caseId)).toMatchObject({ status: 409, code: "CASE_STATE_CONFLICT" });
    expect(await suspend("operator", caseId)).toMatchObject({ status: 409, code: "CASE_STATE_CONFLICT" });
  });
});
