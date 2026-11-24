// S7-2.6(이용 제한 절차) — 이용 제한의 순수 규칙: 어떤 값을 받나, 첫 단계는 무엇인가, 조치가 학원 제한 행으로 무엇이 되나.
//   계약: _workspace/03_contracts/15-ops.md §2-8(이용 제한 절차 — 사유 통지 → 소명 → 조치)
//   데이터: data-model §12 「restriction_cases」 · 12-5 전이표 · 12-9 값 집합
//   spec: FR-254(이용 제한 절차) — 제한하기 전에 사유를 알리고 소명할 기회를 준다. 긴급이면 조치를 먼저 하고 바로 알린다
//
// DB·시각을 읽지 않는다. 서비스(lib/server/services/restrictions.ts)와 테스트가 같이 쓴다.
import {
  REPORT_REASON_CODES,
  RESTRICTION_MEASURES,
  RESTRICTION_SOURCES,
  RESTRICTION_STATES,
  RESTRICTION_SUBJECT_KINDS,
  type ReportTargetKind,
  type RestrictionMeasure,
  type RestrictionState,
  type RestrictionSubjectKind,
} from "./constants";

// 값 집합의 원본은 constants.ts(계약 enum 과 짝 검사를 받는다) — 여기서는 다시 내보내기만 한다
export { RESTRICTION_MEASURES, RESTRICTION_SOURCES, RESTRICTION_STATES, RESTRICTION_SUBJECT_KINDS };
export type { RestrictionMeasure, RestrictionState, RestrictionSubjectKind };
export type { RestrictionSource } from "./constants";

/**
 * 사유 코드 — 신고 사유 다섯 개(같은 말을 쓰면 신고에서 넘어온 절차와 직접 연 절차를 한 목록에서 묶어 볼 수 있다)에
 * 신고 없이도 생기는 사유 셋을 더했다(추천안·사후 확인 2026-11-24, S7-2.6 — 계약에는 예시 off_platform_payment 하나뿐이다).
 */
export const RESTRICTION_REASON_CODES = [...REPORT_REASON_CODES, "business_closed", "business_suspended", "terms_violation"] as const;
export type RestrictionReasonCode = (typeof RESTRICTION_REASON_CODES)[number];

/** 사유 글 최대 길이 — 신고 처리 메모와 같은 1,000자 */
export const RESTRICTION_REASON_TEXT_MAX = 1000;
/** 소명 기한 기본 7일 — 계약 §2-8 임시 확정(FR-250 사업자 점검의 7일과 같은 값) */
export const RESTRICTION_EXPLANATION_DAYS_DEFAULT = 7;
/** 소명 기한 최대 30일(추천안·사후 확인 2026-11-24 — 너무 긴 기한은 절차가 끝나지 않는 것과 같다) */
export const RESTRICTION_EXPLANATION_DAYS_MAX = 30;

/** 사유 통지 · 소명 · 조치 중이면 「열린」 절차 — 같은 대상·같은 출처로 하나만 열 수 있다(uq_restriction_open_*) */
export const OPEN_RESTRICTION_STATES: readonly RestrictionState[] = ["notice_sent", "explained", "measure_applied"];

/**
 * 첫 단계 — 보통은 사유를 먼저 알린다(notice_sent).
 * 긴급(urgent)이면 소명보다 조치를 먼저 한다: 곧바로 measure_applied 로 시작하고 알림은 같은 트랜잭션에서 간다.
 */
export function initialRestrictionState(urgent: boolean): RestrictionState {
  return urgent ? "measure_applied" : "notice_sent";
}

/**
 * 조치가 학원 제한 행(academy_restrictions.kind)으로 무엇이 되나 — 학원 대상에서만 행이 생긴다(계약 §2-8 apply).
 *   수업 게시 제한 → listing_suspended · 정산 보류 → payout_hold · 그 밖은 행 없음(null)
 * 결제·게시·지급 코드는 restriction_cases 가 아니라 이 행만 읽는다 — 그래서 효과는 이 행으로만 낸다.
 */
export function academyRestrictionKindFor(
  subjectKind: RestrictionSubjectKind,
  measure: RestrictionMeasure,
): "listing_suspended" | "payout_hold" | null {
  if (subjectKind !== "academy") return null;
  if (measure === "listing_limit") return "listing_suspended";
  if (measure === "payout_hold") return "payout_hold";
  return null;
}

/**
 * 신고 대상 → 제한 대상. 수업 신고는 그 수업을 연 학원이 대상이다(수업만 따로 제한하는 절차는 없다 —
 * 추천안·사후 확인 2026-11-24, S7-2.6). 학원 id 는 서비스가 수업 행에서 읽는다.
 */
export function restrictionSubjectForReportTarget(target: ReportTargetKind): RestrictionSubjectKind {
  if (target === "member") return "member";
  if (target === "instructor") return "instructor";
  return "academy";
}

/** 조치 글자 — 대상에게 가는 알림 본문에 쓴다 */
export const RESTRICTION_MEASURE_LABELS: Readonly<Record<RestrictionMeasure, string>> = {
  warning: "경고",
  feature_limit: "일부 기능 제한",
  listing_limit: "수업 게시 제한",
  payout_hold: "정산 보류",
  suspension: "이용 정지",
  termination: "이용 계약 해지",
};

/**
 * 대상에게 가는 알림 글. 사유 글은 대상 본인이 무엇을 소명할지 알아야 해서 그대로 싣는다(FR-254 「사유 통지」).
 * 긴급이면 「이미 적용했다」, 보통이면 「예정이고 기한까지 소명할 수 있다」.
 */
export function restrictionNoticeText(input: {
  urgent: boolean;
  measure: RestrictionMeasure;
  reasonText: string;
}): { title: string; body: string } {
  const label = RESTRICTION_MEASURE_LABELS[input.measure];
  return input.urgent
    ? { title: `이용 제한(${label})이 적용됐어요`, body: `사유: ${input.reasonText} · 앱에서 소명을 낼 수 있어요` }
    : { title: `이용 제한(${label}) 예정 안내`, body: `사유: ${input.reasonText} · 기한 안에 앱에서 소명을 낼 수 있어요` };
}
