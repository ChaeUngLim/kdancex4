// S1-1.9(입점 필수 동의 판정과 약관 조회) — 입점 동의 항목 표와 필수 동의 판정(순수 함수).
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2(`GET /api/terms/merchant-onboarding` · 제출 5단계) · 열린 점 ②
//   요구: FR-251(입점 조건 동의) · FR-125b(카드 수수료 입점 동의) · FR-249(약관 동의 기록)
//
// 이 파일이 하는 일 두 가지:
//   ① 현재 판본 목록을 받아 입점 3단계에 보일 항목 5개(items)를 만든다 — 조회 API 가 그대로 내려준다
//   ② 제출 본문의 consents 를 받아 「필수 5개가 전부 현재 판본에 동의됐나」를 판정한다 — 제출 API(S1-1.11)가 쓴다
// DB·HTTP 를 모르는 순수 함수라서, 「하나씩 빠뜨린 5가지가 모두 거부」 같은 표를 단위 테스트로 바로 확인할 수 있다.
//
// 왜 카드 수수료도 필수인가:
//   계약 §2 의 응답 예시는 card_fee_notice 를 `required:false`(카드 결제 조건)로 적었지만, 같은 계약의 열린 점 ② 와
//   spec FR-251 이 2026-11-19 사용자 확정으로 「입점 필수 동의는 W2a 5개(카드 수수료 대표 부담 포함)」라고 정했다.
//   확정 결정을 따르고, 「동의가 카드 결제를 연다」는 뜻은 gates:"card_payment" 로 남긴다(승인 때 card_payment_enabled).
import type { TermsKind } from "./constants";

/** 동의 방식 — 조건에 동의(agree)하는 항목과, 안내를 읽었다고 확인(acknowledge)만 하는 항목 */
export type ConsentType = "agree" | "acknowledge";

export type MerchantOnboardingItemDef = {
  readonly item: TermsKind;
  readonly required: boolean;
  /** 화면(W2a) 체크 줄의 이름 */
  readonly label: string;
  readonly consentType: ConsentType;
  /** 이 동의가 여는 기능. 지금은 카드 수수료 → 카드 결제 하나뿐이다 */
  readonly gates?: "card_payment";
};

/**
 * 입점 3단계(W2a)의 동의 항목 — 계약 §2 응답 예시의 순서 그대로다. 필수는 열린 점 ② 확정대로 5개 전부.
 * 개인정보 수집·이용 동의(merchant_privacy_collection)는 입점 때가 아니라 대표 가입 때 받으므로 여기에 없다.
 */
export const MERCHANT_ONBOARDING_ITEMS: readonly MerchantOnboardingItemDef[] = [
  { item: "merchant_terms", required: true, label: "입점 약관", consentType: "agree" },
  { item: "platform_fee_notice", required: true, label: "플랫폼 수수료", consentType: "agree" },
  {
    item: "card_fee_notice",
    required: true,
    label: "결제·카드 수수료 대표 부담",
    consentType: "agree",
    gates: "card_payment",
  },
  { item: "content_license", required: true, label: "콘텐츠 이용 허락", consentType: "agree" },
  // 1+1 은 참여 동의가 아니라 안내 확인이다(FR-251 2026-11-13 개정). 체크만 필수이고, 참여 여부는 입점 뒤 대표가 고른다
  { item: "one_plus_one_notice", required: true, label: "1+1 할인권 안내 확인", consentType: "acknowledge" },
];

/** DB 에서 읽은 「지금 시행 중인」 판본 한 줄(같은 kind 에서 effective_at 이 지금 이전인 것 중 가장 늦은 것) */
export type CurrentTermsVersion = { readonly id: string; readonly kind: TermsKind; readonly version: string };

/** 조회 API 응답 items 의 한 줄(계약 §2) */
export type MerchantOnboardingTermsItem = {
  item: TermsKind;
  termsVersionId: string;
  version: string;
  required: boolean;
  label: string;
  gates?: "card_payment";
};

/**
 * ① 현재 판본 목록 → 입점 항목 5줄.
 * 입점 항목인데 현재 판본이 없거나 둘 이상이면 던진다 — 빈 id 로 동의를 받으면 「무엇에 동의했나」 기록이 깨지기 때문이다.
 * (판본 발행은 운영자 일이다. 던진 오류는 라우트에서 500 으로 나가고 로그에 남는다)
 */
export function buildMerchantOnboardingTerms(current: readonly CurrentTermsVersion[]): MerchantOnboardingTermsItem[] {
  return MERCHANT_ONBOARDING_ITEMS.map((def) => {
    const matches = current.filter((v) => v.kind === def.item);
    if (matches.length !== 1) {
      throw new Error(`입점 동의 항목 ${def.item} 의 현재 판본이 ${matches.length}개다 — 정확히 1개여야 한다`);
    }
    const [version] = matches as [CurrentTermsVersion];
    return {
      item: def.item,
      termsVersionId: version.id,
      version: version.version,
      required: def.required,
      label: def.label,
      // gates 는 있는 항목에만 붙인다(계약 예시도 card_fee_notice 에만 있다)
      ...(def.gates === undefined ? {} : { gates: def.gates }),
    };
  });
}

/** 제출 본문 consents 의 한 줄(계약 §2) */
export type SubmittedConsent = { readonly termsVersionId: string; readonly agreed: boolean };

export type ConsentJudgement =
  /** 통과 — 동의 기록(merchant_consents)에 항목마다 1행씩 쓸 목록 */
  | { ok: true; agreed: { item: TermsKind; termsVersionId: string }[] }
  /** 현재 판본이 아닌 id 가 섞였다 → 409 TERMS_VERSION_OUTDATED(화면이 판본을 다시 받아야 한다) */
  | { ok: false; code: "TERMS_VERSION_OUTDATED"; outdated: string[] }
  /** 필수 항목에 동의가 없다 → 422 REQUIRED_CONSENT_MISSING */
  | { ok: false; code: "REQUIRED_CONSENT_MISSING"; missing: TermsKind[] };

/**
 * ② 필수 동의 판정 — 계약 제출 5단계의 순서대로 본다.
 *   (a) 보낸 id 가 전부 「지금 보여 준 판본」인가. 아니면 OUTDATED — 옛 화면으로 낸 동의를 새 판본 동의로 치지 않는다
 *   (b) 필수 항목마다 그 판본에 agreed=true 가 있고 agreed=false 가 없는가. 하나라도 아니면 MISSING
 * (a) 를 먼저 보는 이유: 판본이 바뀌었으면 누락 여부를 따지기 전에 화면부터 새로 받아야 하기 때문이다.
 */
export function judgeMerchantConsents(
  items: readonly MerchantOnboardingTermsItem[],
  consents: readonly SubmittedConsent[],
): ConsentJudgement {
  const currentIds = new Set(items.map((i) => i.termsVersionId));
  const outdated = [...new Set(consents.map((c) => c.termsVersionId).filter((id) => !currentIds.has(id)))];
  if (outdated.length > 0) return { ok: false, code: "TERMS_VERSION_OUTDATED", outdated };

  /** 이 판본에 대한 답이 「동의」로만 왔나 — 같은 id 가 true·false 로 함께 오면 동의로 치지 않는다 */
  const isAgreed = (termsVersionId: string): boolean => {
    const answers = consents.filter((c) => c.termsVersionId === termsVersionId);
    return answers.length > 0 && answers.every((c) => c.agreed);
  };

  const missing = items.filter((i) => i.required && !isAgreed(i.termsVersionId)).map((i) => i.item);
  if (missing.length > 0) return { ok: false, code: "REQUIRED_CONSENT_MISSING", missing };

  // 필수가 아닌 항목이 생기면 동의한 것만 기록한다(지금은 5개 모두 필수)
  return {
    ok: true,
    agreed: items.filter((i) => isAgreed(i.termsVersionId)).map((i) => ({ item: i.item, termsVersionId: i.termsVersionId })),
  };
}
