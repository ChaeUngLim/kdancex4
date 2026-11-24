// S1-1.11(입점 신청 제출 API) — 등록 형태별 필수 증빙 판정(순수 함수).
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 제출 4단계 · 수용 시나리오 2
//   데이터: data-model §7-3 merchant_application_documents 「제출 규칙(앱)」
//   요구: FR-085(학원 등록 형태·증빙) · FR-087(증빙 없으면 엄격 기준) · FR-250(사업자등록증은 모든 등록 형태 필수)
//
// 규칙 두 줄:
//   ① 사업자등록증(business_registration)은 등록 형태와 상관없이 늘 필요하다
//   ② 등록 형태마다 그 형태를 증명하는 서류가 1종 더 필요하다. 미등록(자유업)은 증명할 등록이 없으니 사업자등록증만 낸다
// 그리고 FR-087: 등록 형태 증빙이 없는 학원(= 미등록)은 환불 기준을 가장 엄격한 학원법 기준으로 둔다.
//   이 판정이 그 표시(strictRefundStandard)를 함께 돌려준다 — 제출 API 가 감사 기록에 남기고,
//   환불 공지 템플릿(계약 09, registrationVerified=false → 학원법 템플릿)이 같은 뜻으로 읽는다.
import type { AcademyRegistrationType, MerchantDocumentKind } from "./constants";

/** 등록 형태 → 그 형태를 증명하는 서류. null = 증명할 등록이 없다(미등록) */
export const REGISTRATION_EVIDENCE: Readonly<Record<AcademyRegistrationType, MerchantDocumentKind | null>> = {
  academy: "academy_registration", // 교육청 학원 등록증
  tutoring_center: "tutoring_center_report", // 교습소 신고증
  sports_facility: "sports_facility_report", // 체육시설 신고증
  unregistered: null, // 자유업 — 사업자등록증만
};

export type EvidenceJudgement =
  /** 통과. strictRefundStandard=true 면 FR-087 엄격 기준(등록 형태 증빙이 없는 학원) */
  | { ok: true; strictRefundStandard: boolean }
  /** 빠진 서류가 있다 → 422 EVIDENCE_MISSING */
  | { ok: false; missing: MerchantDocumentKind[] };

/**
 * 붙인 증빙 종류 목록을 보고 제출할 수 있는지 판정한다.
 * 형태별 서류 말고 다른 서류가 더 붙어 있어도 막지 않는다(운영자가 심사 때 본다).
 */
export function judgeMerchantEvidence(
  registrationType: AcademyRegistrationType,
  attachedKinds: readonly MerchantDocumentKind[],
): EvidenceJudgement {
  const attached = new Set(attachedKinds);
  const typeEvidence = REGISTRATION_EVIDENCE[registrationType];

  // 사업자등록증 → 형태별 서류 순서로 빠진 것을 모은다(화면이 이 순서로 안내한다)
  const required: MerchantDocumentKind[] = ["business_registration", ...(typeEvidence === null ? [] : [typeEvidence])];
  const missing = required.filter((kind) => !attached.has(kind));
  if (missing.length > 0) return { ok: false, missing };

  // 증명할 등록이 없는 학원 = 「증빙 없는 학원」 → 엄격 기준(FR-087)
  return { ok: true, strictRefundStandard: typeEvidence === null };
}
