// S7-4.8c(사업자 점검 소명 처리 API(P11)) — 실제 PostgreSQL 에서 운영자가 P11 목록·상세로 소명을 읽고, 받아들이거나(제한 풀기)
// 게시 중단으로 거절하는 흐름 전체를 확인한다.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 — GET 목록·상세 · accept-explanation · suspend-listing) · 15-ops.md §4-1(조회 기록·개인정보 없음)
//   spec: FR-254(이용 제한 절차) · FR-250(입점 심사·게시 제한) · FR-302(콘솔 조회 기록)
//   이름: 로드맵 verify 의 tests/db/s7-4-8c.db.test.ts 는 Task 번호 이름이라 기능 이름(business-check-console-views)으로 바꿨다(증거 EVIDENCE.md).
// 확인하는 것:
//   ① 목록 — 요약 카드(학원별 최신 점검) · 건 줄(가린 등록번호·대표 이름·열린 제한·D-n) · 조회 실패 줄(caseId null, 조치 없음)
//   ② 상세 — 최신 점검(폐업일·이전 상태) · 소명 글과 첨부 · 국세청 원문·등록번호 원문·연락처 키 없음
//   ③ 조회 기록 console.viewed — 1분 안에 같은 화면은 한 줄, 상세는 건마다 따로
//   ④ 받아들이면 열린 제한이 모두 닫힌다 — 게시 중단까지 눌린 건도 셋 다(상세·목록에 actions [])
//   ⑤ 거절(게시 중단) — 소명이 있어도 운영자가 게시 중단을 누르면 제한 3개, 기한 표시는 사라진다
//   ⑥ 막히는 경우 — 없는 건 404(조회 기록 없음) · 다른 출처 404 · 2단계 전 401 · 대표 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakeBusinessStatusProvider, type FakeBusinessStatusChoice } from "@/lib/server/fakes/fake-business-status";
import { businessCheckDetailResponseSchema, businessCheckListResponseSchema } from "@/lib/server/schemas/admin-business-checks";
import { BUSINESS_CHECK_DETAIL_SCREEN_ID, BUSINESS_CHECKS_SCREEN_ID } from "@/lib/server/services/admin-business-check-views";
import { createAdminBusinessCheckRoutes } from "@/lib/server/services/admin-business-checks";
import { runBusinessStatusCheck } from "@/lib/server/services/business-status-check";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 감지 시각 — 2026-11-21 03:10 KST(= 11-20 18:10Z). 소명 기한은 11-27 18:10Z
const DETECTED = Temporal.Instant.from("2026-11-20T18:10:00Z");
const day = (n: number) => DETECTED.add({ hours: 24 * n });
const EXPLANATION = "폐업 신고는 장소를 옮기는 중이라 한 것이고, 신규 사업자 등록증을 첨부해요.";

describe.skipIf(!dbAvailable())("P11 사업자 점검 — 목록·상세 · 소명 받아들이기/거절(계약 13 §10-3, S7-4.8c)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = day(2);
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const routes = () =>
    createAdminBusinessCheckRoutes({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: () => now });

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function staff(key: string, roles: string[], twoFactor: boolean, name = key): Promise<string> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name, emailVerified: true, username: key, displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, name]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    ids[key] = id;
    return id;
  }

  async function academy(name: string, owner: string, businessNo: string): Promise<{ academyId: string; ownerId: string }> {
    const academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, business_status, business_status_checked_at, updated_at,
                              ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2::text, '서울', '마포구', 'active', '2026-11-19T18:10:00Z', now(),
               'academy', $2::text, $4::text, $3, '서울 마포구 테스트로 1', '02-000-0000', now())`,
      [academyId, name, businessNo, owner],
    );
    const ownerId = await staff(`owner${businessNo}`, ["owner"], false, owner);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, ownerId]);
    return { academyId, ownerId };
  }

  /** 진짜 점검 작업 경로로 한 번 점검한다 */
  async function check(academyId: string, businessNo: string, choice: FakeBusinessStatusChoice, at: Temporal.Instant) {
    const provider = new FakeBusinessStatusProvider().respond(businessNo, choice);
    await runBusinessStatusCheck({ db: handle.db, businessStatus: provider, clock: fixedClock(at) }, { trigger: "daily", academyIds: [academyId] });
  }
  const caseOf = async (academyId: string) =>
    (await q("SELECT id FROM restriction_cases WHERE subject_academy_id = $1 AND source = 'business_status'", [academyId])).rows[0]?.id as string;

  const headers = (who: string) => ({ "content-type": "application/json", authorization: `Bearer ${tokens[who]}` });
  async function call(res: Promise<Response>) {
    const response = await res;
    const text = await response.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: response.status, json, text, code: json["code"] };
  }
  const ctx = (caseId: string) => ({ params: Promise.resolve({ caseId }) });
  const list = (who = "operator") =>
    call(routes().list(new Request(`${BASE}/api/admin/console/business-checks`, { headers: headers(who) }), undefined));
  const detail = (caseId: string, who = "operator") =>
    call(routes().detail(new Request(`${BASE}/api/admin/console/business-checks/${caseId}`, { headers: headers(who) }), ctx(caseId)));
  const post = (action: "accept" | "suspend", caseId: string, note: string) =>
    call(
      routes()[action](
        new Request(`${BASE}/api/admin/console/business-checks/${caseId}/${action === "accept" ? "accept-explanation" : "suspend-listing"}`, {
          method: "POST",
          headers: headers("operator"),
          body: JSON.stringify({ note }),
        }),
        ctx(caseId),
      ),
    );
  const views = async (screenId: string) =>
    (await q("SELECT actor_staff_account_id::text AS actor, after FROM audit_logs WHERE action = 'console.viewed' AND target_id = $1 ORDER BY occurred_at, id", [screenId]))
      .rows as { actor: string; after: { screen: string; filters: Record<string, string> } }[];
  const openKinds = async (academyId: string) =>
    (await q("SELECT kind FROM academy_restrictions WHERE academy_id = $1 AND ended_at IS NULL ORDER BY kind", [academyId])).rows.map((r) => r.kind as string);

  const M = { academyId: "", ownerId: "", caseId: "" }; // 모던스텝 합정 — 폐업, 소명 1건(첨부 1)
  const S = { academyId: "", ownerId: "", caseId: "" }; // 스윙라인 성수 — 휴업, 소명 없음
  let beatId = ""; // 비트스튜디오 건대 — 조회 실패
  let fileId = "";

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    await staff("operator", ["admin"], true);
    await staff("operator2", ["admin"], true);
    await staff("operatorNo2fa", ["admin"], false);
    await staff("owner2fa", ["owner"], true);

    // 모던스텝: 먼저 「계속」 한 번(이전 상태), 다음 날 폐업 감지
    Object.assign(M, await academy("모던스텝 합정", "정수아", "1234598765"));
    await check(M.academyId, "1234598765", { status: "active" }, DETECTED.subtract({ hours: 24 }));
    await check(M.academyId, "1234598765", { status: "closed", closedOn: "2026-11-10" }, DETECTED);
    M.caseId = await caseOf(M.academyId);
    // 대표 소명 1건 + 첨부 1개 — 소명 제출 경로(15-ops §2-8)는 다른 Task 몫이라 행을 직접 넣는다
    const [exp] = (
      await q("INSERT INTO restriction_explanations (id, case_id, submitted_by_staff_account_id, body, created_at) VALUES (uuidv7(), $1, $2, $3, $4) RETURNING id", [
        M.caseId,
        M.ownerId,
        EXPLANATION,
        day(1).toString(),
      ])
    ).rows;
    fileId = randomUUID();
    await q(
      `INSERT INTO uploaded_files (id, uploader_account_id, purpose, visibility, storage_key, mime_type, size_bytes, sha256, display_name, attached_at)
       VALUES ($1, $2, 'restriction_explanation', 'private', $3, 'application/pdf', 1024, $4, '사업자등록증_신규.pdf', now())`,
      [fileId, M.ownerId, `test/${fileId}`, "0".repeat(64)],
    );
    await q("INSERT INTO attachment_links (id, owner_kind, owner_id, file_id, position) VALUES (uuidv7(), 'restriction_explanation', $1, $2, 0)", [exp.id, fileId]);
    await q("UPDATE restriction_cases SET state = 'explained' WHERE id = $1", [M.caseId]);

    Object.assign(S, await academy("스윙라인 성수", "이하준", "2148754321"));
    await check(S.academyId, "2148754321", { status: "suspended" }, DETECTED);
    S.caseId = await caseOf(S.academyId);

    beatId = (await academy("비트스튜디오 건대", "강민서", "3081245678")).academyId;
    await check(beatId, "3081245678", { status: "error" }, day(1));
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 목록 — 요약 카드 · 건 줄(D-5) · 조회 실패 줄(조치 없음)", async () => {
    now = day(2);
    const res = await list();
    expect(res.status).toBe(200);
    const body = businessCheckListResponseSchema.parse(res.json);
    expect(body.lastRunAt).toBe("2026-11-21T18:10:00.000Z");
    expect(body.trigger).toBe("daily");
    // 학원별 최신 점검: 모던스텝 폐업 · 스윙라인 휴업 · 비트 조회 실패(모던스텝의 앞선 「계속」은 세지 않는다)
    expect(body.summary).toEqual({ total: 3, active: 0, suspended: 1, closed: 1, notFound: 0, error: 1 });

    const modern = body.items.find((i) => i.caseId === M.caseId);
    expect(modern).toEqual({
      caseId: M.caseId,
      academyId: M.academyId,
      academyName: "모던스텝 합정",
      ownerName: "정수아",
      businessNoMasked: "123-45-*****",
      status: "closed",
      detectedAt: "2026-11-20T18:10:00.000Z",
      actions: ["new_sales_blocked", "payout_hold"],
      state: "explained",
      explanationCount: 1,
      explanationDueAt: "2026-11-27T18:10:00.000Z",
      dueInDays: 5,
      dueLabel: "D-5",
      overdue: false,
    });
    expect(body.items.find((i) => i.caseId === S.caseId)).toMatchObject({ status: "suspended", state: "notice_sent", explanationCount: 0, dueLabel: "D-5" });
    const beat = body.items.find((i) => i.academyId === beatId);
    expect(beat).toMatchObject({ caseId: null, status: "error", actions: [], state: null, explanationDueAt: null, dueLabel: null, note: "다음 점검에서 다시 확인 · 조치 없음" });
    expect(body.items).toHaveLength(3);
    // 등록번호 원문·연락처·국세청 원문이 응답 어디에도 없다(15-ops §4-1)
    expect(res.text).not.toContain("1234598765");
    expect(res.text).not.toMatch(/"(phone|birth|rawResponse|raw_response)"/);
  });

  test("② 상세 — 최신 점검(폐업일·이전 상태) · 소명과 첨부 · 원문 없음", async () => {
    const res = await detail(M.caseId);
    expect(res.status).toBe(200);
    const body = businessCheckDetailResponseSchema.parse(res.json);
    expect(body).toMatchObject({
      caseId: M.caseId,
      academyName: "모던스텝 합정",
      ownerName: "정수아",
      businessNoMasked: "123-45-*****",
      latestCheck: { checkedAt: "2026-11-20T18:10:00.000Z", status: "closed", closedOn: "2026-11-10", previousStatus: "active" },
      actions: ["new_sales_blocked", "payout_hold"],
      state: "explained",
      explanationDueAt: "2026-11-27T18:10:00.000Z",
      dueLabel: "D-5",
    });
    expect(body.explanations).toEqual([
      { explanationId: expect.any(String), submittedAt: "2026-11-21T18:10:00.000Z", body: EXPLANATION, attachments: [{ fileId, displayName: "사업자등록증_신규.pdf" }] },
    ]);
    expect(res.text).not.toContain("1234598765");
    expect(res.text).not.toMatch(/"(phone|birth|rawResponse|raw_response)"/);
  });

  test("③ 조회 기록 — 1분 안 같은 화면은 한 줄 · 상세는 건마다 · 다른 운영자는 따로", async () => {
    // ①·② 에서 목록 1번, 모던스텝 상세 1번을 열었다
    await list();
    await detail(M.caseId);
    await detail(S.caseId);
    await list("operator2");
    const listViews = await views(BUSINESS_CHECKS_SCREEN_ID);
    expect(listViews.map((v) => v.actor)).toEqual([ids["operator"], ids["operator2"]]);
    expect(listViews[0]?.after).toEqual({ screen: "business_checks", filters: {} });
    const detailViews = await views(BUSINESS_CHECK_DETAIL_SCREEN_ID);
    expect(detailViews.map((v) => v.after.filters["caseId"])).toEqual([M.caseId, S.caseId]);

    // 1분이 지나면 새 줄
    now = now.add({ seconds: 61 });
    await list();
    expect(await views(BUSINESS_CHECKS_SCREEN_ID)).toHaveLength(3);
  });

  test("④ 받아들이면 열린 제한이 모두 닫힌다 — 게시 중단까지 눌린 건도 셋 다", async () => {
    now = day(3);
    // 운영자가 먼저 게시 중단을 눌렀다가(긴급) 소명을 확인하고 받아들인 경우
    expect(await post("suspend", M.caseId, "긴급 — 확인 전 게시 중단")).toMatchObject({ status: 200, json: { state: "measure_applied" } });
    expect(await openKinds(M.academyId)).toEqual(["listing_suspended", "new_sales_blocked", "payout_hold"]);
    expect((await detail(M.caseId)).json).toMatchObject({ state: "measure_applied", actions: ["listing_suspended", "new_sales_blocked", "payout_hold"], dueLabel: null });

    expect(await post("accept", M.caseId, "신규 사업자등록증 확인")).toMatchObject({ status: 200, json: { state: "lifted" } });
    expect(await openKinds(M.academyId)).toEqual([]);
    const after = businessCheckDetailResponseSchema.parse((await detail(M.caseId)).json);
    expect(after).toMatchObject({ state: "lifted", actions: [], dueLabel: null, overdue: false });
    // 감사 — 받아들이기 1행 + 닫은 제한 3행(누가 · 왜)
    const audits = await q(
      `SELECT action, actor_staff_account_id::text AS actor, reason FROM audit_logs
       WHERE action IN ('restriction.lifted', 'academy_restriction.released') AND academy_id = $1 ORDER BY action`,
      [M.academyId],
    );
    expect(audits.rows).toHaveLength(4);
    expect(audits.rows.every((r) => r.actor === ids["operator"] && r.reason === "신규 사업자등록증 확인")).toBe(true);
    // 목록에서도 끝난 건으로 아래쪽에 남는다(최근 30일)
    const body = businessCheckListResponseSchema.parse((await list()).json);
    expect(body.items.at(-1)).toMatchObject({ caseId: M.caseId, state: "lifted", actions: [] });
  });

  test("⑤ 거절(게시 중단) — 8일째 소명 없는 건은 「기한 지남」 → 게시 중단 → 제한 3개", async () => {
    now = day(8);
    const before = businessCheckListResponseSchema.parse((await list()).json).items.find((i) => i.caseId === S.caseId);
    expect(before).toMatchObject({ overdue: true, dueLabel: "기한 지남", dueInDays: -1, actions: ["new_sales_blocked", "payout_hold"] });
    expect(await post("accept", S.caseId, "")).toMatchObject({ status: 409, code: "NO_EXPLANATION" });
    expect(await post("suspend", S.caseId, "소명 기한 지남")).toMatchObject({ status: 200, json: { state: "measure_applied" } });
    const body = businessCheckDetailResponseSchema.parse((await detail(S.caseId)).json);
    expect(body).toMatchObject({ state: "measure_applied", actions: ["listing_suspended", "new_sales_blocked", "payout_hold"], overdue: false, dueLabel: null, explanations: [] });
  });

  test("⑥ 막히는 경우 — 404(조회 기록 없음) · 다른 출처 404 · 401 · 403", async () => {
    const before = (await views(BUSINESS_CHECK_DETAIL_SCREEN_ID)).length;
    expect(await detail(randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await detail("not-a-uuid")).toMatchObject({ status: 404, code: "NOT_FOUND" });
    const manual = await q(
      `INSERT INTO restriction_cases (id, subject_kind, subject_academy_id, source, reason_code, reason_text, planned_measure, state, notice_sent_at, updated_at)
       VALUES (uuidv7(), 'academy', $1, 'operator_manual', 'terms_violation', '약관 위반', 'warning', 'notice_sent', now(), now()) RETURNING id`,
      [beatId],
    );
    expect(await detail(manual.rows[0].id as string)).toMatchObject({ status: 404 });
    expect((await views(BUSINESS_CHECK_DETAIL_SCREEN_ID)).length).toBe(before);
    // 다른 출처 절차는 목록에도 안 나온다
    expect(businessCheckListResponseSchema.parse((await list()).json).items.some((i) => i.caseId === manual.rows[0].id)).toBe(false);

    expect(await list("operatorNo2fa")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect(await detail(S.caseId, "operatorNo2fa")).toMatchObject({ status: 401, code: "SECOND_FACTOR_REQUIRED" });
    expect((await list("owner2fa")).status).toBe(403);
    expect((await detail(S.caseId, "owner2fa")).status).toBe(403);
  });
});
