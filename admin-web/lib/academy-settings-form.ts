// S1-1.32(학원 설정 화면 W2b·W22) — 학원 설정 화면이 쓰는 순수 함수(화면 없이 단위 테스트로 확인한다).
//   계약: _workspace/03_contracts/07-owner-onboarding.md §4(profile · app-page · payout-account)
//
// 왜 화면과 나눴나:
//   「무엇이 바뀌었나 → 무엇을 보내나」, 「사진을 몇 장까지 더 올릴 수 있나」 같은 규칙은 버튼 모양과 상관이 없다.
//   여기에 모아 두면 화면 컴포넌트는 상태와 핸들러만 남고, 규칙은 테스트로 바로 확인된다.
import type { AcademyRegistrationType, TermsKind } from "./domain/constants";
import type { AcademySettingsResponse } from "./server/services/academy-settings";

/** 한 학원의 사진 상한 — 서버(academy-app-page.ts 의 MAX_ACADEMY_PHOTOS)와 같은 10장 */
export const MAX_PHOTOS = 10;

/** 등록 형태 이름(보드 W2a·W2b 글자 그대로) */
export const REGISTRATION_LABELS: Record<AcademyRegistrationType, string> = {
  academy: "교육청 등록 학원",
  tutoring_center: "교육청 등록 교습소",
  sports_facility: "체육시설법 신고 체육시설",
  unregistered: "미등록 (자유업)",
};

/** 「입점 조건 · 동의 기록」 카드의 항목 이름(보드 W2b). 여기 없는 항목(개인정보 등)은 이름 그대로 두지 않고 숨긴다 */
export const CONSENT_LABELS: Partial<Record<TermsKind, string>> = {
  platform_fee_notice: "플랫폼 수수료",
  card_fee_notice: "결제·카드 수수료",
  content_license: "콘텐츠 이용 허락",
  merchant_terms: "입점 약관",
  one_plus_one_notice: "1+1 할인권",
};

// ---- 학원 정보(PATCH …/profile) ------------------------------------------------------------------

/** 「수정」을 눌렀을 때 칸에 채울 값. 모두 글자로 둔다(빈 칸 = 안 적음) */
export type ProfileForm = {
  address: string;
  phone: string;
  openingHours: string;
  facilities: string;
  parking: string;
  accessibility: string;
  businessName: string;
  representativeName: string;
  businessAddress: string;
  sellerPhone: string;
  mailOrderReportNumber: string;
};

type Branch = AcademySettingsResponse["branches"][number];

/** 지금 저장된 값 → 수정 칸. 첫 지점만 고친다(보드 W2b 는 지점 1곳 화면) */
export function profileFormFrom(settings: AcademySettingsResponse): ProfileForm {
  const branch: Branch | undefined = settings.branches[0];
  return {
    address: branch?.address ?? "",
    phone: branch?.phone ?? "",
    openingHours: branch?.openingHours ?? "",
    facilities: branch?.facilities ?? "",
    parking: branch?.parking ?? "",
    accessibility: branch?.accessibility ?? "",
    businessName: settings.seller.businessName,
    representativeName: settings.seller.representativeName,
    businessAddress: settings.seller.businessAddress,
    sellerPhone: settings.seller.phone,
    mailOrderReportNumber: settings.seller.mailOrderReportNumber ?? "",
  };
}

export type ProfilePatch = {
  seller?: Partial<Record<"businessName" | "representativeName" | "businessAddress" | "phone" | "mailOrderReportNumber", string>>;
  branches?: ({ branchId: string } & Partial<Record<"address" | "phone" | "openingHours" | "facilities" | "parking" | "accessibility", string>>)[];
};

/**
 * 처음 값과 고친 값을 견줘 **바뀐 칸만** 담은 PATCH 본문을 만든다. 바뀐 것이 없으면 null.
 * 왜 바뀐 칸만 보내나: 서버는 판매자 칸이 실제로 바뀔 때만 감사 행을 남긴다(S1-1.19). 다 보내도 결과는 같지만,
 * 바뀐 칸만 보내면 요청만 봐도 무엇을 고쳤는지 보인다.
 */
export function buildProfilePatch(before: ProfileForm, after: ProfileForm, branchId: string | null): ProfilePatch | null {
  const changed = (key: keyof ProfileForm) => before[key].trim() !== after[key].trim();
  const seller: NonNullable<ProfilePatch["seller"]> = {};
  if (changed("businessName")) seller.businessName = after.businessName;
  if (changed("representativeName")) seller.representativeName = after.representativeName;
  if (changed("businessAddress")) seller.businessAddress = after.businessAddress;
  if (changed("sellerPhone")) seller.phone = after.sellerPhone;
  if (changed("mailOrderReportNumber")) seller.mailOrderReportNumber = after.mailOrderReportNumber;

  const branchKeys = ["address", "phone", "openingHours", "facilities", "parking", "accessibility"] as const;
  const branchChanges = Object.fromEntries(branchKeys.filter((key) => changed(key)).map((key) => [key, after[key]]));

  const patch: ProfilePatch = {};
  if (Object.keys(seller).length > 0) patch.seller = seller;
  if (branchId !== null && Object.keys(branchChanges).length > 0) patch.branches = [{ branchId, ...branchChanges }];
  return patch.seller === undefined && patch.branches === undefined ? null : patch;
}

// ---- 정산 계좌 변경(PUT …/payout-account) ----------------------------------------------------------

export type PayoutForm = { bankCode: string; accountNumber: string; holderName: string };

/**
 * 1단계(새 계좌 칸) 검사 — 통과하면 빈 배열. 서버와 같은 규칙(은행 코드 3자리 · 숫자 10~16자리 · 예금주)을
 * 화면에서 먼저 봐서, 인증 앱 코드를 넣기 전에 틀린 칸을 알려 준다.
 */
export function payoutFormProblems(form: PayoutForm): string[] {
  const problems: string[] = [];
  if (!/^[0-9]{3}$/.test(form.bankCode)) problems.push("은행을 골라 주세요");
  if (!/^[0-9]{10,16}$/.test(form.accountNumber.replace(/[-\s]/g, ""))) problems.push("계좌번호는 숫자 10~16자리예요");
  if (form.holderName.trim() === "") problems.push("예금주를 적어 주세요");
  return problems;
}

/** 인증 앱 6자리인가(앞뒤 공백 제외) */
export function isTotpCode(code: string): boolean {
  return /^[0-9]{6}$/.test(code.trim());
}

// ---- 학원 앱 페이지 사진(PUT …/app-page) -------------------------------------------------------------

/**
 * 사진을 더 고를 때 — 지금 장수 + 새로 고른 장수가 10장을 넘으면 안내 글, 아니면 null.
 * 넘으면 한 장도 올리지 않는다(일부만 올리면 어느 사진이 빠졌는지 대표가 알기 어렵다).
 */
export function photoLimitProblem(current: number, adding: number): string | null {
  if (current + adding <= MAX_PHOTOS) return null;
  const room = Math.max(0, MAX_PHOTOS - current);
  return room === 0
    ? `사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요 · 지금 ${current}장이라 더 올리려면 먼저 한 장을 빼 주세요`
    : `사진은 ${MAX_PHOTOS}장까지 올릴 수 있어요 · 지금 ${current}장이라 ${room}장만 더 고를 수 있어요`;
}

/** 목록에서 한 장을 뺀 새 목록(원래 배열은 그대로 둔다) */
export function withoutPhoto(ids: readonly string[], fileId: string): string[] {
  return ids.filter((id) => id !== fileId);
}

// ---- 표시 ------------------------------------------------------------------------------------

/** ISO 시각 → KST 「2026-10-02」 */
export function kstDate(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(iso));
}

/** ISO 시각 → KST 「2026-10-01 14:22」 */
export function kstDateTime(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
