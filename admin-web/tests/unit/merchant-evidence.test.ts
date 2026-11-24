// S1-1.11(입점 신청 제출 API) — 등록 형태별 필수 증빙 판정(순수 함수) 단위 테스트.
//   계약: _workspace/03_contracts/07-owner-onboarding.md §2 제출 4단계 · 수용 시나리오 2 · Phase 6 목록 「등록 형태별 필수 증빙 판정」
//   요구: FR-250(사업자등록증 모든 형태 필수) · FR-085(형태별 증빙) · FR-087(증빙 없는 학원은 엄격 기준)
import { describe, expect, test } from "vitest";

import { judgeMerchantEvidence } from "@/lib/domain/merchant-evidence";

describe("등록 형태별 필수 증빙 판정", () => {
  test.each([
    ["academy", "academy_registration"],
    ["tutoring_center", "tutoring_center_report"],
    ["sports_facility", "sports_facility_report"],
  ] as const)("%s: 사업자등록증 + %s 가 있으면 통과, 엄격 기준 아님", (type, kind) => {
    expect(judgeMerchantEvidence(type, ["business_registration", kind])).toEqual({ ok: true, strictRefundStandard: false });
    // 형태별 서류만 있고 사업자등록증이 없으면 거부
    expect(judgeMerchantEvidence(type, [kind])).toEqual({ ok: false, missing: ["business_registration"] });
    // 사업자등록증만 있으면 형태별 서류가 빠졌다
    expect(judgeMerchantEvidence(type, ["business_registration"])).toEqual({ ok: false, missing: [kind] });
  });

  test("형태별 서류가 다른 형태의 것이면 통과하지 않는다", () => {
    expect(judgeMerchantEvidence("academy", ["business_registration", "sports_facility_report"])).toEqual({
      ok: false,
      missing: ["academy_registration"],
    });
  });

  test("아무것도 없으면 사업자등록증 → 형태별 서류 순서로 빠진 것을 알려 준다", () => {
    expect(judgeMerchantEvidence("tutoring_center", [])).toEqual({
      ok: false,
      missing: ["business_registration", "tutoring_center_report"],
    });
  });

  test("미등록(자유업): 사업자등록증만으로 통과하고 FR-087 엄격 기준 표시가 붙는다", () => {
    expect(judgeMerchantEvidence("unregistered", ["business_registration"])).toEqual({ ok: true, strictRefundStandard: true });
    expect(judgeMerchantEvidence("unregistered", [])).toEqual({ ok: false, missing: ["business_registration"] });
  });
});
