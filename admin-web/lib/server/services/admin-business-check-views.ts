// S7-4.8c(사업자 점검 소명 처리 API(P11)) — 운영자가 P11 에서 「무엇이 감지됐고, 대표가 무엇을 소명했나」를 읽는 곳.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검 — 목록·상세) · 15-ops.md §4-1(콘솔 공통 규칙 — 조회 기록·개인정보 없음)
//   데이터: business_status_checks · restriction_cases(source='business_status') · restriction_explanations · attachment_links · academy_restrictions
//   spec: FR-250(입점 심사·게시 제한) · FR-254(이용 제한 절차) · FR-302(콘솔 조회 기록 · 개인정보 없음)
//
// 큰 그림:
//   매일 점검(business-status-check.ts)이 휴·폐업을 보면 절차 1건과 제한 2개를 연다. 대표는 소명을 내고,
//   운영자는 이 파일의 목록·상세로 그 내용을 본 뒤 admin-business-checks.ts 의 두 버튼(받아들이기·게시 중단)을 누른다.
//   이 파일은 읽기만 한다 — 바꾸는 것은 감사 표의 「조회 기록」(console.viewed) 한 줄뿐이다(FR-302).
//
// 무엇을 내리지 않나: 국세청 응답 원문(raw_response) · 사업자등록번호 원문 · 수강생 정보. 대표 이름은 직원 계정 이름이라 보인다(15-ops §4-1).
import type { Clock } from "../../domain/time";
import { explanationDue, maskBusinessNo, type ExplanationDue } from "../../domain/business-check-case";
import { HttpError } from "../http";
import type { BusinessCheckDetailResponse, BusinessCheckListResponse } from "../schemas/admin-business-checks";
import { readAttachmentsByOwner } from "./attachments";
import { consoleScreenId } from "./admin-holidays";
import type { Runner } from "./cancellation-queries";

const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
/** 끝난 건(풀림·기각)을 목록에 남겨 두는 기간 — 운영자가 「방금 푼 건」을 다시 확인할 수 있게(추천안·사후 확인 2026-11-24) */
const CLOSED_CASE_VISIBLE_DAYS = 30;
/** 같은 사람이 같은 화면(같은 필터)을 이 시간 안에 다시 열면 조회 기록을 한 줄로 합친다(15-ops §4-1, 공휴일 화면과 같은 값) */
const VIEW_MERGE_SECONDS = 60;
/** 조회 실패 줄에 붙는 안내(계약 13 §10-3 예시 그대로) */
const ERROR_NOTE = "다음 점검에서 다시 확인 · 조치 없음";

/** 콘솔 화면 고정 id — 목록과 상세를 다른 화면으로 센다(상세는 어느 건을 봤는지 filters.caseId 로 남긴다) */
export const BUSINESS_CHECKS_SCREEN_ID = consoleScreenId("business_checks");
export const BUSINESS_CHECK_DETAIL_SCREEN_ID = consoleScreenId("business_check_detail");

type CheckStatus = "active" | "suspended" | "closed" | "not_found" | "error";
type RestrictionKind = "new_sales_blocked" | "payout_hold" | "listing_suspended";
type CaseState = "notice_sent" | "explained" | "measure_applied" | "lifted" | "dismissed";

/** 끝나지 않은 건만 기한을 따진다 — 이미 조치했거나 끝난 건에 「기한 지남」을 붙이면 운영자가 또 누를 일로 오해한다 */
const NO_DUE: ExplanationDue = { dueInDays: null, overdue: false, dueLabel: null };
function dueOf(state: string, dueAt: string, now: Temporal.Instant): ExplanationDue {
  const open = state === "notice_sent" || state === "explained";
  return open ? explanationDue(dueAt === "" ? null : Temporal.Instant.from(dueAt), now) : NO_DUE;
}

const splitKinds = (joined: string): RestrictionKind[] => (joined === "" ? [] : (joined.split(",") as RestrictionKind[]));

/**
 * 조회 기록 1줄(FR-302). 감사 표는 고칠 수 없어서 「1분 안에 같은 화면·같은 필터를 다시 열면 새 줄을 쓰지 않음」으로 합친다.
 * 필터까지 같아야 합친다 — 상세에서 다른 건을 연 것은 따로 남아야 「누가 어느 건을 봤나」가 보인다.
 */
async function recordConsoleView(
  runner: Runner,
  input: { staffAccountId: string; screenId: string; screen: string; filters: Record<string, string>; now: Temporal.Instant },
): Promise<void> {
  const after = JSON.stringify({ screen: input.screen, filters: input.filters });
  const filters = JSON.stringify(input.filters);
  await runner.execute(
    runner.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, after, occurred_at)
                   SELECT uuidv7(), 'staff', ${input.staffAccountId}::uuid, 'admin', 'console.viewed', 'console_screen',
                          ${input.screenId}::uuid, ${after}::json, ${input.now.toString()}::timestamptz
                   WHERE NOT EXISTS (
                     SELECT 1 FROM audit_logs
                     WHERE actor_staff_account_id = ${input.staffAccountId}::uuid AND action = 'console.viewed'
                       AND target_table = 'console_screen' AND target_id = ${input.screenId}::uuid
                       AND (after::jsonb -> 'filters') = ${filters}::jsonb
                       AND occurred_at > ${input.now.toString()}::timestamptz - make_interval(secs => ${VIEW_MERGE_SECONDS}))`
      .affectedCount()
      .build(),
  );
}

/** 마지막 점검 한 번(상단 「마지막 점검」 띠)과, 학원별 최신 결과를 센 요약 카드 */
async function readSummary(runner: Runner): Promise<Pick<BusinessCheckListResponse, "lastRunAt" | "trigger" | "summary">> {
  const [last] = await runner.query(
    runner.raw.sql`SELECT to_char(checked_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS at, trigger FROM business_status_checks
                   ORDER BY checked_at DESC, id DESC LIMIT 1`
      .returnsRow({ at: "pg/text@1", trigger: "pg/text@1" })
      .build(),
  );
  // 학원마다 가장 최근 점검 한 줄만 센다(같은 학원이 여러 번 점검돼도 한 번)
  const counts = await runner.query(
    runner.raw.sql`SELECT status, count(*)::int AS n FROM (
                     SELECT DISTINCT ON (academy_id) status FROM business_status_checks ORDER BY academy_id, checked_at DESC, id DESC
                   ) latest GROUP BY status`
      .returnsRow({ status: "pg/text@1", n: "pg/int4@1" })
      .build(),
  );
  const by = new Map(counts.map((c) => [c.status, c.n]));
  const n = (s: CheckStatus) => by.get(s) ?? 0;
  return {
    lastRunAt: last?.at ?? null,
    trigger: (last?.trigger ?? null) as BusinessCheckListResponse["trigger"],
    summary: {
      total: counts.reduce((sum, c) => sum + c.n, 0),
      active: n("active"),
      suspended: n("suspended"),
      closed: n("closed"),
      notFound: n("not_found"),
      error: n("error"),
    },
  };
}

/**
 * P11 목록 — 사업자 점검이 연 건(열린 것 + 최근 30일 안에 끝난 것) + 「조회 실패」 줄. 열린 건 → 조회 실패 → 끝난 건 순서.
 * 조회 실패 줄은 그 학원의 최신 점검이 error 이고 열린 건이 없을 때만 나온다(열린 건이 있으면 그 건 줄이 이미 보인다).
 */
export async function readBusinessCheckList(runner: Runner, now: Temporal.Instant): Promise<BusinessCheckListResponse> {
  const cases = await runner.query(
    runner.raw.sql`SELECT c.id, c.subject_academy_id AS academy_id, a.name AS academy_name,
                          COALESCE(s.display_name, '') AS owner_name, a.business_registration_number AS business_no,
                          COALESCE(k.status, '') AS check_status, c.state,
                          to_char(COALESCE(k.checked_at, c.notice_sent_at) AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS detected_at,
                          COALESCE(to_char(c.explanation_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS due,
                          COALESCE((SELECT string_agg(r.kind, ',' ORDER BY r.kind) FROM academy_restrictions r
                                    WHERE r.academy_id = c.subject_academy_id AND r.ended_at IS NULL), '') AS actions,
                          (SELECT count(*)::int FROM restriction_explanations e WHERE e.case_id = c.id) AS explanations
                   FROM restriction_cases c
                   JOIN academies a ON a.id = c.subject_academy_id
                   LEFT JOIN business_status_checks k ON k.id = c.source_check_id
                   LEFT JOIN academy_owners o ON o.academy_id = a.id AND o.status = 'active'
                   LEFT JOIN staff_accounts s ON s.id = o.staff_account_id
                   WHERE c.source = 'business_status'
                     AND (c.state IN ('notice_sent', 'explained', 'measure_applied')
                          OR c.updated_at > ${now.toString()}::timestamptz - make_interval(days => ${CLOSED_CASE_VISIBLE_DAYS}))
                   ORDER BY (c.state IN ('lifted', 'dismissed')), c.explanation_due_at NULLS LAST, c.id`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        owner_name: "pg/text@1",
        business_no: "pg/text@1",
        check_status: "pg/text@1",
        state: "pg/text@1",
        detected_at: "pg/text@1",
        due: "pg/text@1",
        actions: "pg/text@1",
        explanations: "pg/int4@1",
      })
      .build(),
  );

  const errors = await runner.query(
    runner.raw.sql`SELECT latest.academy_id, a.name AS academy_name, COALESCE(s.display_name, '') AS owner_name,
                          a.business_registration_number AS business_no,
                          to_char(latest.checked_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS detected_at,
                          COALESCE((SELECT string_agg(r.kind, ',' ORDER BY r.kind) FROM academy_restrictions r
                                    WHERE r.academy_id = latest.academy_id AND r.ended_at IS NULL), '') AS actions
                   FROM (SELECT DISTINCT ON (academy_id) academy_id, status, checked_at FROM business_status_checks
                         ORDER BY academy_id, checked_at DESC, id DESC) latest
                   JOIN academies a ON a.id = latest.academy_id
                   LEFT JOIN academy_owners o ON o.academy_id = a.id AND o.status = 'active'
                   LEFT JOIN staff_accounts s ON s.id = o.staff_account_id
                   WHERE latest.status = 'error'
                     AND NOT EXISTS (SELECT 1 FROM restriction_cases c WHERE c.subject_academy_id = latest.academy_id
                                       AND c.source = 'business_status' AND c.state IN ('notice_sent', 'explained', 'measure_applied'))
                   ORDER BY latest.checked_at DESC, a.name`
      .returnsRow({
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        owner_name: "pg/text@1",
        business_no: "pg/text@1",
        detected_at: "pg/text@1",
        actions: "pg/text@1",
      })
      .build(),
  );

  const caseItems: BusinessCheckListResponse["items"] = cases.map((r) => ({
    caseId: r.id,
    academyId: r.academy_id,
    academyName: r.academy_name,
    ownerName: r.owner_name === "" ? null : r.owner_name,
    businessNoMasked: maskBusinessNo(r.business_no),
    // 절차를 연 점검이 없을 수는 없지만(자동 점검이 연다), 끊겼으면 사유 코드 대신 폐업으로 보이지 않게 error 로 둔다
    status: (r.check_status === "" ? "error" : r.check_status) as CheckStatus,
    detectedAt: r.detected_at,
    actions: splitKinds(r.actions),
    state: r.state as CaseState,
    explanationCount: r.explanations,
    explanationDueAt: r.due === "" ? null : r.due,
    ...dueOf(r.state, r.due, now),
  }));
  const errorItems: BusinessCheckListResponse["items"] = errors.map((r) => ({
    caseId: null,
    academyId: r.academy_id,
    academyName: r.academy_name,
    ownerName: r.owner_name === "" ? null : r.owner_name,
    businessNoMasked: maskBusinessNo(r.business_no),
    status: "error",
    detectedAt: r.detected_at,
    actions: splitKinds(r.actions),
    state: null,
    explanationCount: 0,
    note: ERROR_NOTE,
    explanationDueAt: null,
    ...NO_DUE,
  }));
  // 순서: 손볼 건(열린 것) → 조회 실패 줄 → 끝난 건. 운영자가 눌러야 할 것부터 보이게 한다
  const isClosed = (i: (typeof caseItems)[number]) => i.state === "lifted" || i.state === "dismissed";
  const items = [...caseItems.filter((i) => !isClosed(i)), ...errorItems, ...caseItems.filter(isClosed)];
  return { ...(await readSummary(runner)), items };
}

/** P11 상세 — 건 하나의 최신 점검 결과, 대표가 낸 소명(첨부 포함), 지금 열린 제한. 다른 출처의 절차는 이 화면 몫이 아니라 404 */
export async function readBusinessCheckDetail(runner: Runner, caseId: string, now: Temporal.Instant): Promise<BusinessCheckDetailResponse> {
  const [c] = await runner.query(
    runner.raw.sql`SELECT c.id, c.subject_academy_id AS academy_id, a.name AS academy_name, COALESCE(s.display_name, '') AS owner_name,
                          a.business_registration_number AS business_no, c.state,
                          COALESCE(to_char(c.explanation_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS due,
                          COALESCE((SELECT string_agg(r.kind, ',' ORDER BY r.kind) FROM academy_restrictions r
                                    WHERE r.academy_id = c.subject_academy_id AND r.ended_at IS NULL), '') AS actions
                   FROM restriction_cases c
                   JOIN academies a ON a.id = c.subject_academy_id
                   LEFT JOIN academy_owners o ON o.academy_id = a.id AND o.status = 'active'
                   LEFT JOIN staff_accounts s ON s.id = o.staff_account_id
                   WHERE c.id = ${caseId}::uuid AND c.source = 'business_status'`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        owner_name: "pg/text@1",
        business_no: "pg/text@1",
        state: "pg/text@1",
        due: "pg/text@1",
        actions: "pg/text@1",
      })
      .build(),
  );
  if (c === undefined) throw new HttpError("NOT_FOUND", "사업자 점검 건을 찾을 수 없어요");

  // 최신 점검 두 줄 — 맨 위가 「지금 상태」, 그 앞의 조회 실패가 아닌 줄이 「이전 상태」(조회 실패는 상태가 아니라서 건너뛴다)
  const checks = await runner.query(
    runner.raw.sql`SELECT to_char(checked_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS checked_at, status, COALESCE(closed_on::text, '') AS closed_on
                   FROM business_status_checks WHERE academy_id = ${c.academy_id}::uuid
                   ORDER BY checked_at DESC, id DESC LIMIT 20`
      .returnsRow({ checked_at: "pg/text@1", status: "pg/text@1", closed_on: "pg/text@1" })
      .build(),
  );
  const [latest, ...older] = checks;
  const previous = older.find((k) => k.status !== "error");

  const explanations = await runner.query(
    runner.raw.sql`SELECT id, to_char(created_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS submitted_at, body
                   FROM restriction_explanations WHERE case_id = ${c.id}::uuid ORDER BY created_at, id`
      .returnsRow({ id: "pg/uuid@1", submitted_at: "pg/text@1", body: "pg/text@1" })
      .build(),
  );
  const files = await readAttachmentsByOwner(
    runner,
    "restriction_explanation",
    explanations.map((e) => e.id),
  );

  return {
    caseId: c.id,
    academyId: c.academy_id,
    academyName: c.academy_name,
    ownerName: c.owner_name === "" ? null : c.owner_name,
    businessNoMasked: maskBusinessNo(c.business_no),
    latestCheck:
      latest === undefined
        ? null
        : {
            checkedAt: latest.checked_at,
            status: latest.status as CheckStatus,
            closedOn: latest.closed_on === "" ? null : latest.closed_on,
            previousStatus: (previous?.status ?? null) as CheckStatus | null,
          },
    explanations: explanations.map((e) => ({
      explanationId: e.id,
      submittedAt: e.submitted_at,
      body: e.body,
      attachments: [...(files.get(e.id) ?? [])],
    })),
    actions: splitKinds(c.actions),
    state: c.state as CaseState,
    explanationDueAt: c.due === "" ? null : c.due,
    ...dueOf(c.state, c.due, now),
  };
}

/** 목록을 읽고 조회 기록을 남긴다(라우트가 부른다) */
export async function viewBusinessCheckList(
  deps: { readonly db: Runner; readonly clock: Clock },
  staffAccountId: string,
): Promise<BusinessCheckListResponse> {
  const now = deps.clock();
  const body = await readBusinessCheckList(deps.db, now);
  await recordConsoleView(deps.db, { staffAccountId, screenId: BUSINESS_CHECKS_SCREEN_ID, screen: "business_checks", filters: {}, now });
  return body;
}

/** 상세를 읽고 조회 기록을 남긴다 — 없는 건이면 기록 없이 404 */
export async function viewBusinessCheckDetail(
  deps: { readonly db: Runner; readonly clock: Clock },
  staffAccountId: string,
  caseId: string,
): Promise<BusinessCheckDetailResponse> {
  const now = deps.clock();
  const body = await readBusinessCheckDetail(deps.db, caseId, now);
  await recordConsoleView(deps.db, {
    staffAccountId,
    screenId: BUSINESS_CHECK_DETAIL_SCREEN_ID,
    screen: "business_check_detail",
    filters: { caseId },
    now,
  });
  return body;
}
