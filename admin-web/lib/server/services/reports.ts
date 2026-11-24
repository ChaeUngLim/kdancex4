// S7-2.5(신고 접수·처리) — 신고가 운영자에게 가고, 접수·확인 중·처리 결과가 신고자에게 가는 처리기.
//   계약: _workspace/03_contracts/15-ops.md §2-7(신고 — 보드 C11A) · §2-9 수용 ④ · 열린 점 ⑩(신고 가능한 조합)
//   데이터: reports(S7-2.1, data-model §12 「reports」) · notifications(report_* 4종, 모두 transactional) · audit_logs(report.resolved)
//   spec: FR-188(신고 처리) · FR-255(서비스 밖 거래 신고 — 같은 경로, 사유 off_platform_payment)
//
// 흐름 한눈에:
//   접수 POST /api/reports (한 트랜잭션)
//     1 같은 사람·같은 Idempotency-Key 신고가 있으면 그대로 200(재생)
//     2 신고자 역할(회원·강사·대표)을 정하고, 그 역할이 고를 수 있는 대상인지 본다(403 — 열린 점 ⑩)
//     3 대상이 있는지(404). 회원이 자기 자신을 신고하면 422
//     4 같은 사람·같은 대상·같은 사유로 아직 안 끝난 신고가 있으면 새로 만들지 않고 200 으로 그 신고(uq_reports_open_*)
//     5 신고 1행 → 신고자에게 report_received · 운영자(active admin 전원)에게 report_filed
//   운영자 처리 (각각 한 트랜잭션, 신고 행을 FOR UPDATE 로 잠근다 — 두 운영자가 동시에 눌러도 차례로)
//     start-review: received → in_review · 신고자에게 report_in_review. 이미 in_review 면 200(알림 없음)
//     resolve:      결과 기록 → 신고자에게 report_resolved · 감사 report.resolved. 이미 같은 결과로 끝났으면 200, 다른 결과면 409
//
// 신고받은 상대에게는 아무 알림도 쓰지 않는다 — 누가 신고했는지 알리지 않는 것이 C11A 의 약속이다(수용 ④ 「상대에게는 0건」).
// 알림 글에는 신고 상세 글·운영자 메모를 넣지 않는다(휴대폰 잠금 화면에 뜬다 — FR-187).
//
// 이번 Task 가 일부러 하지 않은 것(증거 EVIDENCE.md 「추천안·사후 확인」):
//   - (S7-2.6 에서 이어 붙임) 인정(upheld)하면서 openRestriction 을 보내면 같은 트랜잭션에서 이용 제한 절차를 연다(services/restrictions.ts)
//   - (S7-2.7(문의·신고 첨부 파일)이 채움) 첨부 — attachment_links 로 신고에 잇고, 운영자 목록에 fileId·이름을 싣는다
//   - 운영자 화면 — S7-2.10b(관리자 웹 신고 처리 화면)
import type { ReportOutcome, ReportReasonCode, ReportReporterKind, ReportStatus, ReportTargetKind } from "../../domain/constants";
import {
  isReportTargetAllowed,
  REPORT_REASON_LABELS,
  REPORT_REPORTER_KIND_LABELS,
  REPORT_STEPS,
  REPORT_TARGET_KIND_LABELS,
  reportOutcomeLabel,
} from "../../domain/report";
import { RESTRICTION_EXPLANATION_DAYS_DEFAULT, restrictionSubjectForReportTarget } from "../../domain/restriction";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import { createGuards, type GuardDeps, type StaffContext } from "../guards";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import {
  adminReportListSchema,
  adminReportQuerySchema,
  createReportSchema,
  myReportListSchema,
  reportCreatedSchema,
  reportResolvedSchema,
  reportReviewStartedSchema,
  resolveReportSchema,
  type AdminReportList,
  type CreateReport,
  type MyReportList,
  type ReportCreated,
  type ReportResolved,
  type ReportReviewStarted,
  type ResolveReport,
} from "../schemas/reports";
import { linkAttachments, readAttachmentsByOwner } from "./attachments";
import type { Runner } from "./cancellation-queries";
import { openRestrictionCaseInTx } from "./restrictions";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

export type ReportDeps = GuardDeps & { readonly clock: Clock };

/** 이 파일이 쓰는 409 코드(계약 §2-7) */
export const REPORT_CODES = { alreadyResolved: "REPORT_ALREADY_RESOLVED" } as const;

/** 알림 kind — notifications.kind 값(계약 15 §2-7) */
export const REPORT_NOTIFICATION_KINDS = {
  received: "report_received",
  filed: "report_filed",
  inReview: "report_in_review",
  resolved: "report_resolved",
} as const;

const DETAIL = {
  staffForbidden: "강사·대표 계정만 신고를 보낼 수 있어요",
  targetNotAllowed: "이 계정으로는 신고할 수 없는 대상이에요. 강사·대표는 회원만 신고할 수 있어요",
  targetNotFound: "신고할 대상을 찾을 수 없어요",
  selfReport: "본인은 신고할 수 없어요",
  reportNotFound: "신고를 찾을 수 없어요",
  alreadyResolved: "이미 다른 결과로 처리한 신고예요",
  restrictionNeedsUpheld: "신고를 인정(upheld)할 때만 이용 제한 절차를 함께 열 수 있어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 응답에 쓰는 시각(밀리초) · 커서에 쓰는 시각(마이크로초 — DB 값과 정확히 같아야 쪽이 겹치지 않는다)
const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const DEFAULT_PAGE_SIZE = 20;

const validation = (path: string, message: string) => new HttpError("VALIDATION_FAILED", message, { fields: [{ path, message }] });

// ---- 신고자 ----------------------------------------------------------------------------------

/** 세션의 주인. 회원과 직원은 다른 계정이다(FR-011a) */
type Reporter = { type: "member"; memberId: string } | { type: "staff"; staffAccountId: string; actor: StaffContext["actor"] };

/** 신고 표의 「신고자」 칸 두 개 — 한쪽은 늘 빈 글자(SQL 에서 NULLIF 로 NULL 이 된다) */
const reporterColumns = (reporter: Reporter) =>
  reporter.type === "member" ? { memberId: reporter.memberId, staffId: "" } : { memberId: "", staffId: reporter.staffAccountId };

/**
 * 신고자 역할(reporter_kind)을 정한다.
 *   회원 → member · 학원 하나라도 대표 → owner · 강사 역할 → instructor · 그 밖의 직원(운영자 전용 계정 등) → 403
 */
function reporterKindFor(reporter: Reporter): ReportReporterKind {
  if (reporter.type === "member") return "member";
  if (reporter.actor.ownedAcademyIds.length > 0) return "owner";
  if (reporter.actor.roles.includes("instructor")) return "instructor";
  throw new HttpError("FORBIDDEN", DETAIL.staffForbidden);
}

// ---- 대상 ------------------------------------------------------------------------------------

/**
 * 대상 이름 한 칸을 SQL 로 만드는 조각 — 신고 목록과 접수 확인이 같이 쓴다.
 *   학원 = academies.name · 강사 = 강사 역할이 있는 직원의 표시 이름 · 수업 = classes.title · 회원 = 닉네임(없으면 「회원」)
 * 없는 대상이면 NULL 이 나온다(접수는 그것을 404 로 본다).
 */
async function readTargetLabel(runner: Runner, kind: ReportTargetKind, targetId: string): Promise<string | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT CASE ${kind}::text
                            WHEN 'academy' THEN (SELECT a.name FROM academies a WHERE a.id = ${targetId}::uuid)
                            WHEN 'instructor' THEN (SELECT s.display_name FROM staff_accounts s
                                                    WHERE s.id = ${targetId}::uuid
                                                      AND EXISTS (SELECT 1 FROM role_grants g WHERE g.staff_account_id = s.id
                                                                  AND g.role = 'instructor' AND g.status = 'active'))
                            WHEN 'class' THEN (SELECT c.title FROM classes c WHERE c.id = ${targetId}::uuid)
                            WHEN 'member' THEN (SELECT COALESCE(m.nickname, '회원') FROM members m WHERE m.id = ${targetId}::uuid)
                          END AS label`
      .returnsRow({ label: "pg/text@1" })
      .build(),
  );
  return row?.label ?? null;
}

// ---- 알림 ------------------------------------------------------------------------------------

interface ReportFacts {
  id: string;
  reporterKind: ReportReporterKind;
  reporterMemberId: string;
  reporterStaffId: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reasonCode: ReportReasonCode;
  status: ReportStatus;
  outcome: ReportOutcome | null;
  receivedAt: string;
}

/** 알림 본문 한 줄 — 「수업 신고 · 앱 밖 결제·거래 유도」. 상세 글·대상 이름은 넣지 않는다 */
const reportSummary = (report: Pick<ReportFacts, "targetKind" | "reasonCode">) =>
  `${REPORT_TARGET_KIND_LABELS[report.targetKind]} 신고 · ${REPORT_REASON_LABELS[report.reasonCode]}`;

/**
 * 신고자에게 알림 1행. 회원이면 회원 알림(칩 없음), 강사·대표면 직원 알림함의 「운영」 칩.
 * 열쇠 `report:<id>:<단계>` — 단계마다 한 번만 들어간다(같은 처리를 다시 불러도 늘지 않는다).
 */
async function notifyReporter(
  runner: Runner,
  report: ReportFacts,
  kind: (typeof REPORT_NOTIFICATION_KINDS)[keyof typeof REPORT_NOTIFICATION_KINDS],
  step: string,
  text: { title: string; body: string },
): Promise<void> {
  const isMember = report.reporterMemberId !== "";
  const payload = { reportId: report.id, status: step, title: text.title, body: text.body };
  await runner.execute(
    runner.raw.sql`INSERT INTO notifications (id, recipient_member_id, recipient_staff_account_id, category, kind, dedupe_key, payload)
                   VALUES (uuidv7(), NULLIF(${report.reporterMemberId}, '')::uuid, NULLIF(${report.reporterStaffId}, '')::uuid,
                           NULLIF(${isMember ? "" : "operations"}, ''), ${kind},
                           'report:' || ${report.id} || ':' || ${step}, ${JSON.stringify(payload)}::jsonb)
                   ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 운영자 전원(active admin)에게 「새 신고」(report_filed, 운영 칩). 받는 사람 id 를 열쇠에 붙여 사람마다 한 줄 */
async function notifyOperators(runner: Runner, report: ReportFacts): Promise<number> {
  const payload = {
    reportId: report.id,
    title: "새 신고가 들어왔어요",
    body: `${REPORT_REPORTER_KIND_LABELS[report.reporterKind]} → ${reportSummary(report)}`,
  };
  const inserted = await runner.execute(
    runner.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, category, kind, dedupe_key, payload)
                   SELECT uuidv7(), g.staff_account_id, 'operations', 'report_filed',
                          'report:' || ${report.id} || ':filed:' || g.staff_account_id::text, ${JSON.stringify(payload)}::jsonb
                   FROM role_grants g
                   JOIN staff_accounts s ON s.id = g.staff_account_id AND s.status = 'active'
                   WHERE g.role = 'admin' AND g.status = 'active'
                   ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
  return inserted.affectedRows;
}

// ---- 신고 읽기 --------------------------------------------------------------------------------

/** 신고 한 줄의 사실. lock 이면 FOR UPDATE — 운영자 처리 두 개가 겹치지 않게 */
async function readReport(runner: Runner, reportId: string, lock: boolean): Promise<ReportFacts | null> {
  const query = lock
    ? runner.raw.sql`SELECT id, reporter_kind, COALESCE(reporter_member_id::text, '') AS member_id,
                            COALESCE(reporter_staff_account_id::text, '') AS staff_id, target_kind, target_id, reason_code,
                            status, COALESCE(outcome, '') AS outcome, to_char(received_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS received_at
                     FROM reports WHERE id = ${reportId}::uuid FOR UPDATE`
    : runner.raw.sql`SELECT id, reporter_kind, COALESCE(reporter_member_id::text, '') AS member_id,
                            COALESCE(reporter_staff_account_id::text, '') AS staff_id, target_kind, target_id, reason_code,
                            status, COALESCE(outcome, '') AS outcome, to_char(received_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS received_at
                     FROM reports WHERE id = ${reportId}::uuid`;
  const [row] = await runner.query(
    query
      .returnsRow({
        id: "pg/uuid@1",
        reporter_kind: "pg/text@1",
        member_id: "pg/text@1",
        staff_id: "pg/text@1",
        target_kind: "pg/text@1",
        target_id: "pg/uuid@1",
        reason_code: "pg/text@1",
        status: "pg/text@1",
        outcome: "pg/text@1",
        received_at: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    reporterKind: row.reporter_kind as ReportReporterKind,
    reporterMemberId: row.member_id,
    reporterStaffId: row.staff_id,
    targetKind: row.target_kind as ReportTargetKind,
    targetId: row.target_id,
    reasonCode: row.reason_code as ReportReasonCode,
    status: row.status as ReportStatus,
    outcome: row.outcome === "" ? null : (row.outcome as ReportOutcome),
    receivedAt: row.received_at,
  };
}

const toCreated = (report: ReportFacts): ReportCreated => ({
  reportId: report.id,
  status: report.status,
  steps: [...REPORT_STEPS],
  receivedAt: report.receivedAt,
});

/** 재생 판정 — 같은 사람이 같은 열쇠로 이미 만든 신고 id */
async function findReportIdByKey(runner: Runner, reporter: Reporter, key: string): Promise<string | null> {
  const cols = reporterColumns(reporter);
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM reports
                   WHERE idempotency_key = ${key}
                     AND (reporter_member_id = NULLIF(${cols.memberId}, '')::uuid OR reporter_staff_account_id = NULLIF(${cols.staffId}, '')::uuid)`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/** 같은 사람·같은 대상·같은 사유로 아직 안 끝난 신고(uq_reports_open_* 와 같은 조건) */
async function findOpenReportId(runner: Runner, reporter: Reporter, body: CreateReport): Promise<string | null> {
  const cols = reporterColumns(reporter);
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM reports
                   WHERE status <> 'resolved' AND target_kind = ${body.targetKind} AND target_id = ${body.targetId}::uuid
                     AND reason_code = ${body.reasonCode}
                     AND (reporter_member_id = NULLIF(${cols.memberId}, '')::uuid OR reporter_staff_account_id = NULLIF(${cols.staffId}, '')::uuid)`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

// ---- 접수 ------------------------------------------------------------------------------------

export interface CreateReportResult {
  created: boolean;
  outcome: ReportCreated;
}

export async function createReport(
  deps: ReportDeps,
  input: { reporter: Reporter; idempotencyKey: string; body: CreateReport },
): Promise<CreateReportResult> {
  const now = deps.clock().toString();
  const { reporter, body } = input;

  return deps.db.transaction(async (tx) => {
    const replay = async (id: string): Promise<CreateReportResult> => {
      const report = await readReport(tx, id, false);
      if (report === null) throw new Error(`있어야 할 신고를 다시 읽지 못했다: ${id}`);
      return { created: false, outcome: toCreated(report) };
    };

    // 1 재생 — 검사보다 먼저. 처음 보낸 뒤 역할이 바뀌었어도 같은 열쇠는 처음 결과를 돌려준다
    const replayId = await findReportIdByKey(tx, reporter, input.idempotencyKey);
    if (replayId !== null) return replay(replayId);

    // 2 역할 → 고를 수 있는 대상(열린 점 ⑩: 회원은 넷 다, 강사·대표는 회원만)
    const reporterKind = reporterKindFor(reporter);
    if (!isReportTargetAllowed(reporterKind, body.targetKind)) throw new HttpError("FORBIDDEN", DETAIL.targetNotAllowed);

    // 3 대상이 있나 · 자기 자신은 아닌가
    if ((await readTargetLabel(tx, body.targetKind, body.targetId)) === null) throw new HttpError("NOT_FOUND", DETAIL.targetNotFound);
    if (reporter.type === "member" && body.targetKind === "member" && body.targetId === reporter.memberId) {
      throw validation("targetId", DETAIL.selfReport);
    }

    // 4 같은 신고가 아직 진행 중이면 그 신고를 돌려준다(새 행·새 알림 없음)
    const openId = await findOpenReportId(tx, reporter, body);
    if (openId !== null) return replay(openId);

    // 5 신고 1행. ON CONFLICT — 같은 열쇠나 같은 신고가 동시에 두 번 오면 먼저 들어간 쪽을 돌려준다(부분 UNIQUE 가 마지막 방어선)
    const cols = reporterColumns(reporter);
    const [row] = await tx.query(
      tx.raw.sql`INSERT INTO reports (id, reporter_kind, reporter_member_id, reporter_staff_account_id, target_kind, target_id,
                                      reason_code, detail, status, idempotency_key, received_at)
                 VALUES (uuidv7(), ${reporterKind}, NULLIF(${cols.memberId}, '')::uuid, NULLIF(${cols.staffId}, '')::uuid,
                         ${body.targetKind}, ${body.targetId}::uuid, ${body.reasonCode}, NULLIF(${body.detail ?? ""}, ''),
                         'received', ${input.idempotencyKey}, ${now}::timestamptz)
                 ON CONFLICT DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) {
      const winner = (await findReportIdByKey(tx, reporter, input.idempotencyKey)) ?? (await findOpenReportId(tx, reporter, body));
      if (winner === null) throw new Error("신고 넣기가 아무 행도 만들지 않았는데 겹치는 신고도 없다");
      return replay(winner);
    }

    // 첨부(S7-2.7) — 신고자와 운영자만 연다(신고받은 상대는 못 연다). 틀리면 신고도 같이 없어진다(같은 트랜잭션).
    // 같은 신고가 진행 중이라 4 에서 돌려준 경우에는 새 첨부를 잇지 않는다 — 올린 파일은 주인 없는 파일 정리가 지운다
    await linkAttachments(tx, {
      ownerKind: "report",
      ownerId: row.id,
      purpose: "report_attachment",
      uploader: reporter.type === "member" ? { type: "member", memberId: reporter.memberId } : { type: "staff", staffAccountId: reporter.staffAccountId },
      fileIds: body.attachmentFileIds,
      now,
    });

    const report = await readReport(tx, row.id, false);
    if (report === null) throw new Error(`방금 만든 신고를 다시 읽지 못했다: ${row.id}`);
    // 신고자에게 「접수」, 운영자에게 「새 신고」 — 같은 트랜잭션이라 신고가 없으면 알림도 없다
    await notifyReporter(tx, report, REPORT_NOTIFICATION_KINDS.received, "received", {
      title: "신고가 접수됐어요",
      body: reportSummary(report),
    });
    await notifyOperators(tx, report);
    return { created: true, outcome: toCreated(report) };
  });
}

// ---- 내 신고 ---------------------------------------------------------------------------------

/** 내 신고 목록 — 내가 보낸 것만, 최신순. 처리 결과는 짧은 글(outcomeLabel)만, 운영자 메모·조치 내용은 주지 않는다 */
async function listMyReports(deps: ReportDeps, reporter: Reporter): Promise<MyReportList> {
  const cols = reporterColumns(reporter);
  const rows = await deps.db.query(
    deps.db.raw.sql`SELECT r.id, r.target_kind, r.target_id, r.reason_code, r.status, COALESCE(r.outcome, '') AS outcome,
                           to_char(r.received_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS received_at,
                           COALESCE(to_char(r.resolved_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS resolved_at
                    FROM reports r
                    WHERE (r.reporter_member_id = NULLIF(${cols.memberId}, '')::uuid OR r.reporter_staff_account_id = NULLIF(${cols.staffId}, '')::uuid)
                    ORDER BY r.received_at DESC, r.id DESC
                    LIMIT 100`
      .returnsRow({
        id: "pg/uuid@1",
        target_kind: "pg/text@1",
        target_id: "pg/uuid@1",
        reason_code: "pg/text@1",
        status: "pg/text@1",
        outcome: "pg/text@1",
        received_at: "pg/text@1",
        resolved_at: "pg/text@1",
      })
      .build(),
  );
  const items = [];
  for (const row of rows) {
    const status = row.status as ReportStatus;
    const targetKind = row.target_kind as ReportTargetKind;
    items.push({
      reportId: row.id,
      targetKind,
      targetLabel: (await readTargetLabel(deps.db, targetKind, row.target_id)) ?? REPORT_TARGET_KIND_LABELS[targetKind],
      reasonCode: row.reason_code as ReportReasonCode,
      status,
      outcomeLabel: reportOutcomeLabel(status, row.outcome === "" ? null : (row.outcome as ReportOutcome)),
      receivedAt: row.received_at,
      resolvedAt: row.resolved_at === "" ? null : row.resolved_at,
    });
  }
  return { items };
}

// ---- 운영자 신고함 ------------------------------------------------------------------------------

/** 운영자 신고함 한 쪽 — 들어온 순서(오래된 것부터 처리). 신고자는 역할 + 닉네임만 */
async function listAdminReports(
  deps: ReportDeps,
  query: { status?: ReportStatus; cursor?: string; limit?: number },
): Promise<AdminReportList> {
  const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
  const cursor = query.cursor === undefined || query.cursor === "" ? null : decodeNotificationCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== "" && cursor === null) throw validation("cursor", DETAIL.badCursor);
  const afterTime = cursor?.createdAt ?? "-infinity";
  const afterId = cursor?.id ?? "00000000-0000-0000-0000-000000000000";

  const picked = await deps.db.query(
    deps.db.raw.sql`SELECT r.id, r.status, r.reporter_kind, COALESCE(m.nickname, s.display_name, '') AS reporter_name,
                           r.target_kind, r.target_id, r.reason_code, COALESCE(r.detail, '') AS detail, COALESCE(r.outcome, '') AS outcome,
                           to_char(r.received_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}) AS received_at,
                           to_char(r.received_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS cursor_at,
                           COALESCE(to_char(r.reviewed_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS reviewed_at,
                           COALESCE(to_char(r.resolved_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS resolved_at
                    FROM reports r
                    LEFT JOIN members m ON m.id = r.reporter_member_id
                    LEFT JOIN staff_accounts s ON s.id = r.reporter_staff_account_id
                    WHERE (${query.status ?? ""} = '' OR r.status = ${query.status ?? ""})
                      AND (r.received_at, r.id) > (${afterTime}::timestamptz, ${afterId}::uuid)
                    ORDER BY r.received_at, r.id
                    LIMIT ${pageSize + 1}::int`
      .returnsRow({
        id: "pg/uuid@1",
        status: "pg/text@1",
        reporter_kind: "pg/text@1",
        reporter_name: "pg/text@1",
        target_kind: "pg/text@1",
        target_id: "pg/uuid@1",
        reason_code: "pg/text@1",
        detail: "pg/text@1",
        outcome: "pg/text@1",
        received_at: "pg/text@1",
        cursor_at: "pg/text@1",
        reviewed_at: "pg/text@1",
        resolved_at: "pg/text@1",
      })
      .build(),
  );
  const page = picked.slice(0, pageSize);
  const last = page.at(-1);
  // 신고 첨부(S7-2.7) — 운영자가 내려받을 fileId · 이름. 한 번에 읽어 신고 id 로 나눈다
  const attachments = await readAttachmentsByOwner(
    deps.db,
    "report",
    page.map((row) => row.id),
  );
  const items = [];
  for (const row of page) {
    const reporterKind = row.reporter_kind as ReportReporterKind;
    const targetKind = row.target_kind as ReportTargetKind;
    const reasonCode = row.reason_code as ReportReasonCode;
    items.push({
      reportId: row.id,
      status: row.status as ReportStatus,
      reporterKind,
      reporterLabel: `${REPORT_REPORTER_KIND_LABELS[reporterKind]} · ${row.reporter_name === "" ? REPORT_REPORTER_KIND_LABELS[reporterKind] : row.reporter_name}`,
      target: {
        kind: targetKind,
        id: row.target_id,
        label: (await readTargetLabel(deps.db, targetKind, row.target_id)) ?? REPORT_TARGET_KIND_LABELS[targetKind],
      },
      reasonCode,
      reasonLabel: REPORT_REASON_LABELS[reasonCode],
      detail: row.detail === "" ? null : row.detail,
      outcome: row.outcome === "" ? null : (row.outcome as ReportOutcome),
      receivedAt: row.received_at,
      reviewedAt: row.reviewed_at === "" ? null : row.reviewed_at,
      resolvedAt: row.resolved_at === "" ? null : row.resolved_at,
      attachments: attachments.get(row.id) ?? [],
    });
  }
  return {
    items,
    nextCursor: picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.cursor_at, id: last.id }) : null,
  };
}

// ---- 운영자 처리 ------------------------------------------------------------------------------

/**
 * 접수 → 확인 중. 이미 확인 중이면 그대로 200(알림 다시 안 씀). 이미 처리 끝이면 409 — 끝난 신고를 되돌리지 않는다.
 */
export async function startReportReview(deps: ReportDeps, reportId: string): Promise<ReportReviewStarted> {
  const now = deps.clock().toString();
  return deps.db.transaction(async (tx) => {
    const report = await readReport(tx, reportId, true);
    if (report === null) throw new HttpError("NOT_FOUND", DETAIL.reportNotFound);
    if (report.status === "resolved") throw HttpError.conflict(REPORT_CODES.alreadyResolved, DETAIL.alreadyResolved);
    if (report.status === "in_review") return { reportId: report.id, status: report.status };

    await tx.execute(
      tx.raw.sql`UPDATE reports SET status = 'in_review', reviewed_at = ${now}::timestamptz WHERE id = ${report.id}::uuid`
        .affectedCount()
        .build(),
    );
    await notifyReporter(tx, report, REPORT_NOTIFICATION_KINDS.inReview, "in_review", {
      title: "신고 내용을 확인하고 있어요",
      body: reportSummary(report),
    });
    return { reportId: report.id, status: "in_review" };
  });
}

/**
 * 처리 결과 기록 — 결과(인정·기각)와 메모를 남기고 신고자에게 결과 알림, 감사 report.resolved 1행.
 *   접수(received)에서 바로 처리해도 된다 — 그때 확인 시각(reviewed_at)도 같이 채운다
 *   이미 같은 결과로 처리했으면 200 같은 본문(다시 눌러도 알림·감사가 늘지 않는다), 다른 결과면 409
 */
export async function resolveReport(
  deps: ReportDeps,
  input: { reportId: string; staffAccountId: string; body: ResolveReport },
): Promise<ReportResolved> {
  const now = deps.clock().toString();
  const { body } = input;
  // 기각하면서 제한을 열 수는 없다 — 제한은 신고가 사실로 확인됐을 때만(계약 §2-7 「upheld 이고 openRestriction 이 있으면」)
  if (body.openRestriction !== null && body.outcome !== "upheld") throw validation("openRestriction", DETAIL.restrictionNeedsUpheld);

  return deps.db.transaction(async (tx) => {
    const report = await readReport(tx, input.reportId, true);
    if (report === null) throw new HttpError("NOT_FOUND", DETAIL.reportNotFound);
    if (report.status === "resolved") {
      // 재생 — 처음 처리 때 연 절차 id 를 그대로 돌려준다
      if (report.outcome === body.outcome) {
        return { reportId: report.id, status: "resolved", restrictionCaseId: await readReportCaseId(tx, report.id) };
      }
      throw HttpError.conflict(REPORT_CODES.alreadyResolved, DETAIL.alreadyResolved);
    }

    // S7-2.6 — 인정하면서 조치를 고르면 이용 제한 절차를 연다(source='report'). 같은 대상에 신고로 열린 절차가
    // 이미 있으면 새로 열지 않고 그 절차에 이 신고를 잇는다 — 같은 학원에 신고가 여럿 와도 절차는 하나다(추천안·사후 확인 2026-11-24)
    let restrictionCaseId: string | null = null;
    if (body.openRestriction !== null) {
      const subject = await reportRestrictionSubject(tx, report);
      const opened = await openRestrictionCaseInTx(tx, {
        subjectKind: subject.kind,
        subjectId: subject.id,
        source: "report",
        sourceReportId: report.id,
        reasonCode: report.reasonCode,
        reasonText: body.openRestriction.reasonText,
        plannedMeasure: body.openRestriction.measure,
        urgent: false,
        explanationDays: RESTRICTION_EXPLANATION_DAYS_DEFAULT,
        openedByStaffAccountId: input.staffAccountId,
        idempotencyKey: null,
        now,
        onAlreadyOpen: "reuse",
      });
      restrictionCaseId = opened.outcome.caseId;
    }
    const done: ReportResolved = { reportId: report.id, status: "resolved", restrictionCaseId };

    await tx.execute(
      tx.raw.sql`UPDATE reports SET status = 'resolved', outcome = ${body.outcome}, outcome_note = NULLIF(${body.note ?? ""}, ''),
                                    resolved_by_account_id = ${input.staffAccountId}::uuid, resolved_at = ${now}::timestamptz,
                                    reviewed_at = COALESCE(reviewed_at, ${now}::timestamptz),
                                    restriction_case_id = NULLIF(${restrictionCaseId ?? ""}, '')::uuid
                 WHERE id = ${report.id}::uuid`
        .affectedCount()
        .build(),
    );
    // 결과 알림 — 「처리했어요」 같은 짧은 글만. 상대에게 한 조치·운영자 메모는 싣지 않는다
    await notifyReporter(tx, report, REPORT_NOTIFICATION_KINDS.resolved, "resolved", {
      title: "신고 처리 결과를 알려 드려요",
      body: reportOutcomeLabel("resolved", body.outcome) ?? "",
    });
    // 감사 — 처리 결과는 감사 대상이다(data-model §12 「reports — 감사 ○」)
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, action, target_table, target_id, before, after)
                 VALUES (uuidv7(), 'staff', ${input.staffAccountId}::uuid, 'admin', 'report.resolved', 'reports', ${report.id}::uuid,
                         ${JSON.stringify({ status: report.status })}::json,
                         ${JSON.stringify({ status: "resolved", outcome: body.outcome, note: body.note, restrictionCaseId })}::json)`
        .affectedCount()
        .build(),
    );
    return done;
  });
}

/** 처리 끝난 신고가 연(또는 이어 붙은) 이용 제한 절차 id */
async function readReportCaseId(runner: Runner, reportId: string): Promise<string | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT COALESCE(restriction_case_id::text, '') AS case_id FROM reports WHERE id = ${reportId}::uuid`
      .returnsRow({ case_id: "pg/text@1" })
      .build(),
  );
  return row === undefined || row.case_id === "" ? null : row.case_id;
}

/** 신고 대상 → 제한 대상. 수업 신고는 그 수업을 연 학원이 대상이다(lib/domain/restriction.ts) */
async function reportRestrictionSubject(runner: Runner, report: ReportFacts): Promise<{ kind: "member" | "instructor" | "academy"; id: string }> {
  const kind = restrictionSubjectForReportTarget(report.targetKind);
  if (report.targetKind !== "class") return { kind, id: report.targetId };
  const [row] = await runner.query(
    runner.raw.sql`SELECT academy_id FROM classes WHERE id = ${report.targetId}::uuid`.returnsRow({ academy_id: "pg/uuid@1" }).build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.targetNotFound);
  return { kind, id: row.academy_id };
}

// ---- 라우트 ----------------------------------------------------------------------------------

type ReportIdParams = { params: Promise<{ reportId: string }> };

/** 신고 경로 다섯 개의 처리기 */
export function createReportRoutes(deps: ReportDeps) {
  const guards = createGuards(deps);
  const consoleRoute = createConsoleRoute(deps);

  /**
   * 세션의 주인 — 회원 행이 있으면 회원, 없으면 active 직원 계정(문의 경로와 같은 방식).
   * 강사·대표 앱(Bearer)에서 부르므로 2단계 인증은 묻지 않는다.
   */
  async function resolveReporter(request: Request): Promise<Reporter> {
    try {
      const { memberId } = await guards.requireMember(request);
      return { type: "member", memberId };
    } catch (memberError) {
      if (!(memberError instanceof HttpError) || memberError.code !== "SIGNUP_INCOMPLETE") throw memberError;
      try {
        const staff = await guards.requireStaffAccount(request);
        return { type: "staff", staffAccountId: staff.staffAccountId, actor: staff.actor };
      } catch (staffError) {
        if (staffError instanceof HttpError && staffError.code === "ACCOUNT_SUSPENDED") throw staffError;
        throw memberError;
      }
    }
  }

  const reportIdOf = async (context: ReportIdParams): Promise<string> => {
    const { reportId } = await context.params;
    if (!UUID_PATTERN.test(reportId)) throw new HttpError("NOT_FOUND", DETAIL.reportNotFound);
    return reportId;
  };

  /** `POST /api/reports` — 처음 201, 재생·진행 중인 같은 신고 200. 순서: 인증 → 열쇠(400) → 본문(422) */
  const create = withRoute<unknown>(async (request) => {
    const reporter = await resolveReporter(request);
    const idempotencyKey = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, createReportSchema);
    const result = await createReport(deps, { reporter, idempotencyKey, body });
    return Response.json(reportCreatedSchema.parse(result.outcome), { status: result.created ? 201 : 200, headers: NO_STORE });
  });

  /** `GET /api/reports` — 내 신고와 진행 단계 */
  const listMine = withRoute<unknown>(async (request) => {
    const reporter = await resolveReporter(request);
    return Response.json(myReportListSchema.parse(await listMyReports(deps, reporter)), { headers: NO_STORE });
  });

  /** `GET /api/admin/reports` — 운영자 신고함(관리자 웹 · 2단계 필수) */
  const adminList = consoleRoute<unknown>({ permission: "admin" }, async (request) => {
    const query = parseWith(adminReportQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    return Response.json(adminReportListSchema.parse(await listAdminReports(deps, query)), { headers: NO_STORE });
  });

  /** `POST /api/admin/reports/{reportId}/start-review` — 접수 → 확인 중 */
  const startReview = consoleRoute<ReportIdParams>({ permission: "admin" }, async (_request, context) => {
    const reportId = await reportIdOf(context);
    return Response.json(reportReviewStartedSchema.parse(await startReportReview(deps, reportId)), { headers: NO_STORE });
  });

  /** `POST /api/admin/reports/{reportId}/resolve` — 처리 결과 기록·신고자 알림 */
  const resolve = consoleRoute<ReportIdParams>({ permission: "admin" }, async (request, context, staff) => {
    const reportId = await reportIdOf(context);
    const body = await parseJsonBody(request, resolveReportSchema);
    const result = await resolveReport(deps, { reportId, staffAccountId: staff.actor.accountId, body });
    return Response.json(reportResolvedSchema.parse(result), { headers: NO_STORE });
  });

  return { create, listMine, adminList, startReview, resolve };
}
