// S1-1.33(운영자 심사 최소 화면) — 운영자 입점 심사 화면이 쓰는 순수 함수(화면 없이 단위 테스트로 확인한다).
//   계약: _workspace/03_contracts/07-owner-onboarding.md §3(심사 — 권한 admin) · 열린 점 ⑨(목록·상세) · ⑩(심사 시작·승인) · ⑪(반려)
//   요구: FR-250(입점 심사·게시 제한 — 반려 사유 4종)
//
// 왜 화면과 나눴나:
//   「이 상태에서 무엇을 누를 수 있나」, 「반려 사유를 다 적었나」 같은 규칙은 버튼 모양과 상관이 없다.
//   서버 규칙(열린 점 ⑩ ⓐ·⑪ ⓑ)과 같은 표를 여기 한 곳에 두고 테스트로 확인한다 — 화면은 이 결과만 그린다.
import type { MerchantApplicationStatus, MerchantRejectReason } from "./domain/constants";
import { MERCHANT_REJECT_REASONS } from "./domain/constants";

/** 반려 설명 글 최대 길이 — 서버(admin-merchant-review.ts 의 REJECT_REASON_TEXT_MAX)와 같은 500자 */
export const REJECT_TEXT_MAX = 500;

/** 상태 이름(운영자 화면). 초안(draft)은 운영자에게 보이지 않지만 표를 빠짐없이 채운다 */
export const STATUS_LABELS: Record<MerchantApplicationStatus, string> = {
  draft: "작성 중",
  submitted: "심사 대기",
  in_review: "심사 중",
  approved: "승인됨",
  rejected: "반려됨",
  withdrawn: "철회됨",
};

/** 반려 사유 4종(data-model §7-9 · FR-250) — 신청자에게도 이 이름으로 보인다 */
export const REJECT_REASON_LABELS: Record<MerchantRejectReason, string> = {
  info_mismatch: "정보·서류 불일치·미확인",
  registration_missing: "등록·신고 미비",
  prior_termination: "위반 해지 이력",
  trust_violation: "신뢰를 해치는 수업·광고",
};

/** 목록 위 거르기 칸의 순서. null = 전체(쿼리 없음) */
export const STATUS_FILTERS: readonly (Exclude<MerchantApplicationStatus, "draft"> | null)[] = [
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "withdrawn",
  null,
];

/** 주소 쿼리(?status=)에서 거르기 값을 읽는다. 모르는 값이면 전체로 본다 — 422 를 화면에 띄우지 않으려고 */
export function parseStatusFilter(raw: string | string[] | undefined): Exclude<MerchantApplicationStatus, "draft"> | null {
  const value = Array.isArray(raw) ? raw.at(-1) : raw;
  const found = STATUS_FILTERS.find((s) => s !== null && s === value);
  return found ?? null;
}

/**
 * 상태마다 누를 수 있는 버튼(서버 규칙과 같은 표).
 *   - 심사 대기(submitted) → 「심사 시작」만. 승인·반려는 심사 중에만 된다(열린 점 ⑩ ⓐ·⑪ ⓑ)
 *   - 심사 중(in_review)   → 「승인」·「반려」
 *   - 그 밖(승인·반려·철회) → 아무것도 없다(이미 끝난 신청)
 */
export type ReviewAction = "startReview" | "approve" | "reject";
export function availableActions(status: MerchantApplicationStatus): ReviewAction[] {
  if (status === "submitted") return ["startReview"];
  if (status === "in_review") return ["approve", "reject"];
  return [];
}

/** 반려 입력 칸 */
export type RejectForm = { reasonCode: MerchantRejectReason | ""; reasonText: string };

/** 반려를 보내기 전에 화면에서 바로 보이는 문제. 빈 배열이면 보내도 된다(서버도 같은 규칙으로 422 를 낸다) */
export function rejectFormProblems(form: RejectForm): string[] {
  const problems: string[] = [];
  if (!(MERCHANT_REJECT_REASONS as readonly string[]).includes(form.reasonCode)) problems.push("반려 사유를 골라 주세요");
  const text = form.reasonText.trim();
  if (text === "") problems.push("신청자에게 보낼 설명을 적어 주세요");
  if (text.length > REJECT_TEXT_MAX) problems.push(`설명은 ${REJECT_TEXT_MAX}자까지 적을 수 있어요`);
  return problems;
}

/** 서버로 보낼 반려 본문 — 앞뒤 공백을 지운다(서버도 지우지만 글자 수 안내와 맞추려고) */
export function buildRejectBody(form: RejectForm): { reasonCode: MerchantRejectReason; reasonText: string } {
  if (form.reasonCode === "") throw new Error("반려 사유 없이 본문을 만들 수 없다 — rejectFormProblems 를 먼저 본다");
  return { reasonCode: form.reasonCode, reasonText: form.reasonText.trim() };
}

/** 사업자등록번호 10자리 → 「123-45-67890」. 모양이 다르면 그대로 */
export function formatBusinessNumber(raw: string | null): string | null {
  if (raw === null) return null;
  return /^\d{10}$/.test(raw) ? `${raw.slice(0, 3)}-${raw.slice(3, 5)}-${raw.slice(5)}` : raw;
}
