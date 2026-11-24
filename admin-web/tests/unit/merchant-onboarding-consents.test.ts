// S1-1.9(입점 필수 동의 판정과 약관 조회) — 필수 동의 판정(순수 함수) 단위 테스트.
//   로드맵 verify 의 파일 이름은 tests/unit/s1-1-9.test.ts 였는데, 기능 이름(merchant-onboarding-consents)으로 바꿨다.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2(약관 판본 · 제출 5단계) · 열린 점 ②(필수 5개 확정)
//   요구: FR-251(입점 조건 동의) — 필수 5개 중 하나라도 빠지면 거부, 1+1 할인권은 안내 확인 체크만 필수
import { describe, expect, test } from "vitest";

import {
  MERCHANT_ONBOARDING_ITEMS,
  buildMerchantOnboardingTerms,
  judgeMerchantConsents,
  type CurrentTermsVersion,
  type MerchantOnboardingTermsItem,
} from "@/lib/domain/merchant-consents";

// 판본 id 는 항목마다 하나씩. 실제 값은 uuid 지만 판정에는 「같은 값인가」만 쓰인다
const CURRENT: CurrentTermsVersion[] = [
  { id: "v-terms-2", kind: "merchant_terms", version: "2.0" },
  { id: "v-fee-1", kind: "platform_fee_notice", version: "1.0" },
  { id: "v-card-1", kind: "card_fee_notice", version: "1.0" },
  { id: "v-content-1", kind: "content_license", version: "1.0" },
  { id: "v-1p1-1", kind: "one_plus_one_notice", version: "1.0" },
  // 입점 동의가 아닌 판본(대표 가입 때 받는 개인정보 수집 동의)은 섞여 있어도 목록에 나오지 않는다
  { id: "v-privacy-1", kind: "merchant_privacy_collection", version: "1.0" },
];

const REQUIRED_KINDS = [
  "merchant_terms",
  "platform_fee_notice",
  "card_fee_notice",
  "content_license",
  "one_plus_one_notice",
] as const;

function items(): MerchantOnboardingTermsItem[] {
  return buildMerchantOnboardingTerms(CURRENT);
}

/** 다섯 항목 전부 agreed=true 인 제출 본문 */
function allAgreed() {
  return items().map((i) => ({ termsVersionId: i.termsVersionId, agreed: true }));
}

describe("buildMerchantOnboardingTerms — GET /api/terms/merchant-onboarding 의 items", () => {
  test("입점 항목 5개를 계약 순서대로, 항목별 현재 판본 id·번호와 함께 준다", () => {
    expect(items()).toEqual([
      { item: "merchant_terms", termsVersionId: "v-terms-2", version: "2.0", required: true, label: "입점 약관" },
      { item: "platform_fee_notice", termsVersionId: "v-fee-1", version: "1.0", required: true, label: "플랫폼 수수료" },
      {
        item: "card_fee_notice",
        termsVersionId: "v-card-1",
        version: "1.0",
        required: true,
        label: "결제·카드 수수료 대표 부담",
        gates: "card_payment",
      },
      { item: "content_license", termsVersionId: "v-content-1", version: "1.0", required: true, label: "콘텐츠 이용 허락" },
      { item: "one_plus_one_notice", termsVersionId: "v-1p1-1", version: "1.0", required: true, label: "1+1 할인권 안내 확인" },
    ]);
  });

  test("필수 항목은 정확히 5개(열린 점 ② 확정) — 개인정보 수집 동의는 입점 항목이 아니다", () => {
    const required = MERCHANT_ONBOARDING_ITEMS.filter((i) => i.required).map((i) => i.item);
    expect(required).toEqual([...REQUIRED_KINDS]);
    expect(items().some((i) => i.item === "merchant_privacy_collection")).toBe(false);
  });

  test("발행된 판본이 없는 입점 항목이 있으면 목록을 만들지 않고 멈춘다(빈 판본 id 로 동의를 받지 않는다)", () => {
    const withoutContent = CURRENT.filter((v) => v.kind !== "content_license");
    expect(() => buildMerchantOnboardingTerms(withoutContent)).toThrow(/content_license/);
  });

  test("같은 항목에 현재 판본이 둘이면 멈춘다(어느 판본에 동의받을지 모른다)", () => {
    const dup = [...CURRENT, { id: "v-fee-2", kind: "platform_fee_notice" as const, version: "2.0" }];
    expect(() => buildMerchantOnboardingTerms(dup)).toThrow(/platform_fee_notice/);
  });
});

describe("judgeMerchantConsents — 필수 동의 판정(제출 5단계)", () => {
  test("다섯 항목 모두 현재 판본에 agreed=true 면 통과하고, 기록할 항목·판본을 돌려준다", () => {
    expect(judgeMerchantConsents(items(), allAgreed())).toEqual({
      ok: true,
      agreed: [
        { item: "merchant_terms", termsVersionId: "v-terms-2" },
        { item: "platform_fee_notice", termsVersionId: "v-fee-1" },
        { item: "card_fee_notice", termsVersionId: "v-card-1" },
        { item: "content_license", termsVersionId: "v-content-1" },
        { item: "one_plus_one_notice", termsVersionId: "v-1p1-1" },
      ],
    });
  });

  // verify — 항목 하나씩 빠뜨린 5가지가 모두 거부
  describe.each(REQUIRED_KINDS)("필수 항목 %s 하나만 빠뜨리면", (kind) => {
    const target = () => items().find((i) => i.item === kind)!;

    test("제출 목록에서 아예 빠지면 REQUIRED_CONSENT_MISSING", () => {
      const consents = allAgreed().filter((c) => c.termsVersionId !== target().termsVersionId);
      expect(judgeMerchantConsents(items(), consents)).toEqual({
        ok: false,
        code: "REQUIRED_CONSENT_MISSING",
        missing: [kind],
      });
    });

    test("agreed=false 로 오면 REQUIRED_CONSENT_MISSING", () => {
      const consents = allAgreed().map((c) =>
        c.termsVersionId === target().termsVersionId ? { ...c, agreed: false } : c,
      );
      expect(judgeMerchantConsents(items(), consents)).toEqual({
        ok: false,
        code: "REQUIRED_CONSENT_MISSING",
        missing: [kind],
      });
    });
  });

  test("수용 ① — 콘텐츠 이용 허락만 agreed=false 면 거부(missing 은 그 하나)", () => {
    const content = items().find((i) => i.item === "content_license")!;
    const consents = allAgreed().map((c) => (c.termsVersionId === content.termsVersionId ? { ...c, agreed: false } : c));
    const result = judgeMerchantConsents(items(), consents);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "REQUIRED_CONSENT_MISSING", missing: ["content_license"] });
  });

  test("여러 개가 빠지면 빠진 항목을 계약 순서대로 전부 알려 준다", () => {
    expect(judgeMerchantConsents(items(), [])).toEqual({
      ok: false,
      code: "REQUIRED_CONSENT_MISSING",
      missing: [...REQUIRED_KINDS],
    });
  });

  test("같은 판본이 true·false 로 함께 오면 동의로 치지 않는다", () => {
    const fee = items().find((i) => i.item === "platform_fee_notice")!;
    const consents = [...allAgreed(), { termsVersionId: fee.termsVersionId, agreed: false }];
    expect(judgeMerchantConsents(items(), consents)).toMatchObject({ ok: false, missing: ["platform_fee_notice"] });
  });

  test("1+1 할인권은 안내 확인 체크만 필수 — 참여 여부 값 없이 체크 하나로 통과한다", () => {
    const onePlusOne = MERCHANT_ONBOARDING_ITEMS.find((i) => i.item === "one_plus_one_notice")!;
    // 동의가 아니라 「안내를 읽었다는 확인」이다(FR-251 2026-11-13 개정). 참여는 입점 뒤 대표가 따로 고른다
    expect(onePlusOne).toMatchObject({ required: true, consentType: "acknowledge", label: "1+1 할인권 안내 확인" });
    // 체크(agreed=true) 하나 말고는 아무 값도 받지 않는다 — 참여 칸을 보내지 않아도 통과
    const result = judgeMerchantConsents(items(), allAgreed());
    expect(result.ok).toBe(true);
    // 체크를 빼면 거부
    const unchecked = allAgreed().filter((c) => c.termsVersionId !== "v-1p1-1");
    expect(judgeMerchantConsents(items(), unchecked)).toMatchObject({ ok: false, missing: ["one_plus_one_notice"] });
  });

  test("현재 판본이 아닌 id(옛 판본·모르는 id)가 섞이면 TERMS_VERSION_OUTDATED — 필수 누락보다 먼저 본다", () => {
    const consents = [...allAgreed().slice(1), { termsVersionId: "v-terms-1", agreed: true }];
    expect(judgeMerchantConsents(items(), consents)).toEqual({
      ok: false,
      code: "TERMS_VERSION_OUTDATED",
      outdated: ["v-terms-1"],
    });
  });

  test("입점 항목이 아닌 판본(개인정보 수집 동의) id 도 현재 입점 판본이 아니므로 TERMS_VERSION_OUTDATED", () => {
    const consents = [...allAgreed(), { termsVersionId: "v-privacy-1", agreed: true }];
    expect(judgeMerchantConsents(items(), consents)).toMatchObject({ ok: false, code: "TERMS_VERSION_OUTDATED" });
  });
});
