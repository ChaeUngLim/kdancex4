// S1-1.31(입점 신청 화면 W2a) — 입점 신청 화면의 입력값을 다루는 순수 함수 모음.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2(초안 저장 · 제출) · 열린 점 ⑥ ⓓ · ⑦
//   요구: FR-250(입점 심사) · FR-251(입점 조건 동의 5개) · FR-085(등록 형태·증빙)
//
// 왜 화면과 나눴나:
//   「1단계에서 무엇이 빠졌나」, 「제출 버튼 아래 '필수 항목 N개가 남았어요'의 N」, 「서버로 보낼 초안 본문」은
//   화면 없이도 틀림없이 계산돼야 하는 값이다. 순수 함수로 두면 단위 테스트로 바로 확인하고,
//   화면은 렌더링 중에 이 함수를 불러 값을 그리기만 한다(효과 훅이 필요 없다).
import type { AcademyRegistrationType, MerchantDocumentKind } from "./domain/constants";
import { REGISTRATION_EVIDENCE } from "./domain/merchant-evidence";

/** 1단계(학원 정보) 입력칸. 모두 글자 그대로 들고 있다가 저장할 때 본문으로 바꾼다 */
export type BusinessInfoForm = {
  academyName: string;
  branchName: string;
  businessName: string;
  representativeName: string;
  businessRegistrationNumber: string;
  mailOrderReportNumber: string;
  businessAddress: string;
  regionSido: string;
  regionGu: string;
  phone: string;
  bankCode: string;
  accountNumber: string;
  holderName: string;
};

export type BusinessInfoField = keyof BusinessInfoForm;

/** 1단계 칸 이름(화면 라벨과 같은 글자). 오류 안내에도 이 이름을 쓴다 */
export const BUSINESS_INFO_LABELS: Record<BusinessInfoField, string> = {
  academyName: "학원 이름",
  branchName: "지점 이름",
  businessName: "상호",
  representativeName: "대표자 이름",
  businessRegistrationNumber: "사업자등록번호",
  mailOrderReportNumber: "통신판매업 신고번호",
  businessAddress: "사업장 주소",
  regionSido: "시·도",
  regionGu: "구·군",
  phone: "대표 전화",
  bankCode: "은행",
  accountNumber: "정산 계좌번호",
  holderName: "예금주",
};

/**
 * 제출 때 서버가 「꼭 있어야 한다」고 보는 칸(계약 열린 점 ⑦ ⓑ) — 통신판매업 신고번호만 비어도 된다.
 * 1단계에서 「다음」을 누를 때 미리 봐서, 3단계 제출에서야 422 를 받는 일을 줄인다.
 */
export const REQUIRED_BUSINESS_FIELDS: readonly BusinessInfoField[] = [
  "academyName",
  "branchName",
  "businessName",
  "representativeName",
  "businessRegistrationNumber",
  "businessAddress",
  "regionSido",
  "regionGu",
  "phone",
  "bankCode",
  "accountNumber",
  "holderName",
];

/** 숫자만 남긴다(「123-45-67890」 → 「1234567890」). 서버도 같은 방식으로 하이픈·공백을 걷는다 */
const digitsOnly = (value: string): string => value.replace(/[\s-]/g, "");

/** 칸마다 어긋난 점 하나. 비어 있으면 「넣어 주세요」, 모양이 틀리면 그 이유 */
export type FieldProblem = { field: BusinessInfoField; message: string };

/**
 * 1단계 검사 — 빈 필수 칸과 모양이 틀린 칸을 모은다. 빈 배열이면 다음 단계로 간다.
 * 모양 규칙은 초안 API(draftRequestSchema)와 같은 기준이다: 사업자등록번호 10자리 · 전화 8~12자리 · 계좌 10~16자리.
 */
export function checkBusinessInfo(form: BusinessInfoForm): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const field of REQUIRED_BUSINESS_FIELDS) {
    if (form[field].trim() === "") problems.push({ field, message: `${BUSINESS_INFO_LABELS[field]}을(를) 넣어 주세요` });
  }
  const filled = (field: BusinessInfoField) => form[field].trim() !== "";
  if (filled("businessRegistrationNumber") && !/^[0-9]{10}$/.test(digitsOnly(form.businessRegistrationNumber))) {
    problems.push({ field: "businessRegistrationNumber", message: "사업자등록번호는 숫자 10자리예요" });
  }
  if (filled("phone") && !/^[0-9]{8,12}$/.test(digitsOnly(form.phone))) {
    problems.push({ field: "phone", message: "전화번호는 숫자 8~12자리예요" });
  }
  if (filled("accountNumber") && !/^[0-9]{10,16}$/.test(digitsOnly(form.accountNumber))) {
    problems.push({ field: "accountNumber", message: "계좌번호는 숫자 10~16자리예요" });
  }
  return problems;
}

/** 2단계 입력 — 등록 형태 · 업종코드 · 종류별로 올린 증빙 파일 */
export type UploadedEvidence = { fileId: string; displayName: string; sizeBytes: number };
export type EvidenceForm = {
  registrationType: AcademyRegistrationType | null;
  industryCode: string;
  files: Partial<Record<MerchantDocumentKind, UploadedEvidence>>;
};

/**
 * 지금 등록 형태에서 내야 하는 서류 — 사업자등록증 + 형태별 1종(미등록은 사업자등록증만).
 * 제출 API 의 판정(judgeMerchantEvidence)과 같은 표(REGISTRATION_EVIDENCE)를 쓴다 — 두 곳의 기준이 갈리지 않게.
 */
export function requiredDocuments(registrationType: AcademyRegistrationType | null): MerchantDocumentKind[] {
  if (registrationType === null) return ["business_registration"];
  const typeEvidence = REGISTRATION_EVIDENCE[registrationType];
  return typeEvidence === null ? ["business_registration"] : [typeEvidence, "business_registration"];
}

/**
 * 초안 저장 본문(계약 §2 「전체 교체」). 1·2단계 값을 늘 함께 보낸다 —
 * 본문에서 빠진 칸은 서버가 비우고, 계좌번호 원문은 응답에 없으므로 화면이 들고 있는 값을 매번 다시 보낸다(열린 점 ⑥ ⓓ).
 * 지금 형태에 필요 없는 서류(형태를 바꾸기 전에 올린 것)는 보내지 않는다.
 */
export function buildDraftBody(info: BusinessInfoForm, evidence: EvidenceForm) {
  const text = (value: string) => (value.trim() === "" ? null : value.trim());
  const needed = new Set(requiredDocuments(evidence.registrationType));
  const documents = Object.entries(evidence.files)
    .filter(([kind, file]) => file !== undefined && needed.has(kind as MerchantDocumentKind))
    .map(([kind, file]) => ({ docKind: kind as MerchantDocumentKind, fileId: (file as UploadedEvidence).fileId }));
  return {
    academyName: text(info.academyName),
    branchName: text(info.branchName),
    businessName: text(info.businessName),
    representativeName: text(info.representativeName),
    businessRegistrationNumber: text(info.businessRegistrationNumber),
    mailOrderReportNumber: text(info.mailOrderReportNumber),
    businessAddress: text(info.businessAddress),
    region: { sido: text(info.regionSido), gu: text(info.regionGu) },
    phone: text(info.phone),
    registrationType: evidence.registrationType,
    industryCode: text(evidence.industryCode),
    documents,
    payoutAccount: { bankCode: text(info.bankCode), accountNumber: text(info.accountNumber), holderName: text(info.holderName) },
  };
}

/**
 * 제출 버튼 아래 「필수 항목 N개가 남았어요」의 N(보드 W2a).
 * 등록 형태를 안 골랐으면 1, 빠진 필수 서류마다 1, 체크하지 않은 필수 동의마다 1.
 * 0 이 되어야 「입점 신청하기」 버튼이 켜진다.
 */
export function remainingRequired(
  evidence: EvidenceForm,
  consents: readonly { termsVersionId: string; required: boolean }[],
  checked: ReadonlySet<string>,
): number {
  const typeMissing = evidence.registrationType === null ? 1 : 0;
  const docsMissing = requiredDocuments(evidence.registrationType).filter((kind) => evidence.files[kind] === undefined).length;
  const consentsMissing = consents.filter((c) => c.required && !checked.has(c.termsVersionId)).length;
  return typeMissing + docsMissing + consentsMissing;
}

/** 파일 크기 글자(보드 「1.2MB · 올림 완료」) */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
