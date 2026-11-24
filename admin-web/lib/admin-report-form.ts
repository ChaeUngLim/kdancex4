// S7-2.10b(관리자 웹 신고 처리 화면) — 운영자 신고함 화면이 쓰는 순수 규칙: 거르기 칸, 상태 글자, 누를 수 있는 버튼,
// 처리 입력의 확인과 요청 본문 만들기.
//   계약: _workspace/03_contracts/15-ops.md §2-7(GET /api/admin/reports · start-review · resolve)
//   spec: FR-188(신고 처리) · FR-254(이용 제한 절차 — 인정한 신고에서 절차를 연다) · FR-255(서비스 밖 거래 신고)
//
// 왜 화면과 나눴나: 서버 규칙(lib/server/services/reports.ts)과 같은 판정을 화면에서 한 번 더 하므로,
// 브라우저 없이 단위 테스트로 확인할 수 있게 DB·React 를 모르는 함수로만 둔다.
import { REPORT_STATUSES, type ReportOutcome, type ReportStatus, type ReportTargetKind } from "./domain/constants";
import { REPORT_NOTE_MAX } from "./domain/report";
import { RESTRICTION_MEASURES, restrictionSubjectForReportTarget, type RestrictionMeasure } from "./domain/restriction";

/** 거르기 칸 순서 — null 은 「전체」. 운영자가 먼저 볼 「접수」를 맨 앞(전체 다음)에 둔다 */
export const REPORT_STATUS_FILTERS: readonly (ReportStatus | null)[] = [null, ...REPORT_STATUSES];

/** 상태 글자 — 앱 C11A 의 「접수 → 확인 중 → 결과 알림」과 같은 말을 쓴다 */
export const REPORT_STATUS_LABELS: Readonly<Record<ReportStatus, string>> = {
  received: "접수",
  in_review: "확인 중",
  resolved: "처리 끝",
};

/** 처리 결과 글자(운영자용). 신고자에게 가는 글(「처리했어요」 등)은 서버의 reportOutcomeLabel 이 따로 만든다 */
export const REPORT_OUTCOME_LABELS: Readonly<Record<ReportOutcome, string>> = {
  upheld: "인정",
  dismissed: "기각",
};

/** 주소 쿼리 ?status= → 거르기 값. 모르는 값은 「전체」로 본다(틀린 주소로 오류 화면을 띄우지 않는다) */
export function parseReportStatusFilter(raw: string | string[] | undefined): ReportStatus | null {
  if (typeof raw !== "string") return null;
  return (REPORT_STATUSES as readonly string[]).includes(raw) ? (raw as ReportStatus) : null;
}

export type ReportAction = "startReview" | "resolve";

/**
 * 지금 상태에서 누를 수 있는 버튼 — 서버 규칙과 같은 표다.
 *   접수: 확인 시작 · 바로 처리(명백한 기각을 두 번 누르지 않게 — S7-2.5 추천안 5)
 *   확인 중: 처리만
 *   처리 끝: 없음(끝난 신고는 되돌리지 않는다 — 서버도 409)
 */
export function availableReportActions(status: ReportStatus): ReportAction[] {
  if (status === "received") return ["startReview", "resolve"];
  if (status === "in_review") return ["resolve"];
  return [];
}

/**
 * 이 신고 대상에 고를 수 있는 제한 조치. 수업·학원 신고는 학원이 제한 대상이라 여섯 가지 모두,
 * 회원·강사 신고는 학원에만 뜻이 있는 「수업 게시 제한」·「정산 보류」를 뺀다(추천안·사후 확인 2026-11-24, S7-2.10b).
 */
export function measuresForTarget(target: ReportTargetKind): RestrictionMeasure[] {
  if (restrictionSubjectForReportTarget(target) === "academy") return [...RESTRICTION_MEASURES];
  return RESTRICTION_MEASURES.filter((m) => m !== "listing_limit" && m !== "payout_hold");
}

/** 처리 입력 칸 — 결과를 아직 안 골랐으면 "" */
export type ResolveForm = {
  outcome: ReportOutcome | "";
  note: string;
  /** 인정일 때만 — 이용 제한 절차를 같이 열지 */
  openRestriction: boolean;
  measure: RestrictionMeasure | "";
  reasonText: string;
};

export const EMPTY_RESOLVE_FORM: ResolveForm = { outcome: "", note: "", openRestriction: false, measure: "", reasonText: "" };

/** 보내기 전에 화면에서 바로 알려 줄 문제들. 빈 배열이면 보낼 수 있다(서버도 같은 규칙으로 422) */
export function resolveFormProblems(form: ResolveForm): string[] {
  const problems: string[] = [];
  if (form.outcome === "") problems.push("처리 결과(인정·기각)를 골라 주세요");
  if (form.note.trim().length > REPORT_NOTE_MAX) problems.push(`메모는 ${REPORT_NOTE_MAX}자 이하로 적어 주세요`);
  // 제한 절차는 인정한 신고에서만 연다 — 기각을 고르면 이 칸들은 보지 않는다
  if (form.outcome === "upheld" && form.openRestriction) {
    if (form.measure === "") problems.push("예정 조치를 골라 주세요");
    const reason = form.reasonText.trim();
    if (reason === "") problems.push("대상에게 알릴 사유를 적어 주세요");
    if (reason.length > REPORT_NOTE_MAX) problems.push(`사유는 ${REPORT_NOTE_MAX}자 이하로 적어 주세요`);
  }
  return problems;
}

export type ResolveBody = {
  outcome: ReportOutcome;
  note: string | null;
  openRestriction: { measure: RestrictionMeasure; reasonText: string } | null;
};

/** 문제 없는 입력 → `POST …/resolve` 본문. 빈 메모는 null, 기각이면 openRestriction 은 늘 null */
export function buildResolveBody(form: ResolveForm): ResolveBody {
  if (form.outcome === "") throw new Error("처리 결과를 고르지 않은 입력은 보낼 수 없다");
  const note = form.note.trim();
  const restriction =
    form.outcome === "upheld" && form.openRestriction && form.measure !== ""
      ? { measure: form.measure, reasonText: form.reasonText.trim() }
      : null;
  return { outcome: form.outcome, note: note === "" ? null : note, openRestriction: restriction };
}
