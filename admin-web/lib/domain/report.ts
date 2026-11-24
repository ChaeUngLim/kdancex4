// S7-2.5(신고 접수·처리) — 신고의 순수 규칙: 누가 무엇을 신고할 수 있나, 화면·알림에 쓰는 짧은 글자.
//   계약: _workspace/03_contracts/15-ops.md §2-7(신고 — 보드 C11A) · 열린 점 ⑩(신고 가능한 조합)
//   spec: FR-188(신고 처리) · FR-255(서비스 밖 거래 신고는 같은 경로)
//
// DB·시각을 읽지 않는다. 서비스(lib/server/services/reports.ts)와 테스트가 같이 쓴다.
import type { ReportOutcome, ReportReasonCode, ReportReporterKind, ReportStatus, ReportTargetKind } from "./constants";

/** 신고 상세 글 최대 길이 — 계약 §2-7 「detail 1,000자 초과」 422(임시 확정 2026-11-20) */
export const REPORT_DETAIL_MAX = 1000;
/** 운영자 처리 메모 최대 길이 — 상세 글과 같은 값(추천안·사후 확인 2026-11-24, S7-2.5) */
export const REPORT_NOTE_MAX = 1000;

/** 신고 진행 단계 — 앱 C11A 의 「접수 → 확인 중 → 결과 알림」 세 칸(계약 §2-7 응답의 steps) */
export const REPORT_STEPS = ["received", "in_review", "result_notified"] as const;

/**
 * 신고자 역할마다 고를 수 있는 대상(계약 열린 점 ⑩ 임시 확정).
 *   회원: 학원·강사·수업·회원 모두
 *   강사·대표: 회원만 — 강사가 학원을 신고하는 것은 문의·소속 해제 경로가 따로 있다
 */
const ALLOWED_TARGETS: Readonly<Record<ReportReporterKind, readonly ReportTargetKind[]>> = {
  member: ["academy", "instructor", "class", "member"],
  instructor: ["member"],
  owner: ["member"],
};

export function isReportTargetAllowed(reporter: ReportReporterKind, target: ReportTargetKind): boolean {
  return ALLOWED_TARGETS[reporter].includes(target);
}

/** 사유 글자 — 운영자 알림·신고함에 쓴다(C11A 의 선택지와 같은 말) */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReasonCode, string>> = {
  off_platform_payment: "앱 밖 결제·거래 유도",
  info_mismatch: "수업 정보가 실제와 달라요",
  harassment: "욕설·괴롭힘",
  illegal_dangerous: "불법·위험한 내용",
  other: "기타",
};

/** 대상 종류 글자 */
export const REPORT_TARGET_KIND_LABELS: Readonly<Record<ReportTargetKind, string>> = {
  academy: "학원",
  instructor: "강사",
  class: "수업",
  member: "회원",
};

/** 신고자 역할 글자 — 운영자 신고함의 reporterLabel 앞부분(「회원 · 서아」) */
export const REPORT_REPORTER_KIND_LABELS: Readonly<Record<ReportReporterKind, string>> = {
  member: "회원",
  instructor: "강사",
  owner: "대표",
};

/**
 * 신고자에게 보이는 처리 결과 한 줄(계약 §2-7 `outcomeLabel`). 사유 상세나 상대에게 한 조치 내용은 넣지 않는다.
 * 처리 전이면 null.
 */
export function reportOutcomeLabel(status: ReportStatus, outcome: ReportOutcome | null): string | null {
  if (status !== "resolved" || outcome === null) return null;
  return outcome === "upheld" ? "처리했어요" : "신고 내용을 확인했지만 조치할 일이 없어요";
}
