// S1-1.33(운영자 심사 최소 화면) — 심사 화면 순수 함수(상태별 버튼 · 반려 입력 검사 · 거르기 쿼리)를 화면 없이 확인한다.
import { describe, expect, it } from "vitest";

import {
  REJECT_REASON_LABELS,
  REJECT_TEXT_MAX,
  STATUS_LABELS,
  availableActions,
  buildRejectBody,
  formatBusinessNumber,
  parseStatusFilter,
  rejectFormProblems,
} from "../../lib/admin-merchant-review-form";
import { MERCHANT_APPLICATION_STATUSES, MERCHANT_REJECT_REASONS } from "../../lib/domain/constants";

describe("availableActions — 서버 규칙(계약 07 열린 점 ⑩ ⓐ·⑪ ⓑ)과 같은 표", () => {
  it("심사 대기는 심사 시작만, 심사 중은 승인·반려, 끝난 신청은 없음", () => {
    expect(availableActions("submitted")).toEqual(["startReview"]);
    expect(availableActions("in_review")).toEqual(["approve", "reject"]);
    for (const s of ["approved", "rejected", "withdrawn", "draft"] as const) expect(availableActions(s)).toEqual([]);
  });
});

describe("rejectFormProblems — 반려 본문 검사", () => {
  it("사유와 설명이 있으면 문제 없음", () => {
    expect(rejectFormProblems({ reasonCode: "info_mismatch", reasonText: "  주소가 달라요 " })).toEqual([]);
  });
  it("사유를 안 고르거나 설명이 공백뿐이면 둘 다 알려 준다", () => {
    expect(rejectFormProblems({ reasonCode: "", reasonText: "   " })).toEqual([
      "반려 사유를 골라 주세요",
      "신청자에게 보낼 설명을 적어 주세요",
    ]);
  });
  it("설명이 500자를 넘으면 막는다(앞뒤 공백은 세지 않는다)", () => {
    expect(rejectFormProblems({ reasonCode: "trust_violation", reasonText: ` ${"가".repeat(REJECT_TEXT_MAX)} ` })).toEqual([]);
    expect(rejectFormProblems({ reasonCode: "trust_violation", reasonText: "가".repeat(REJECT_TEXT_MAX + 1) })).toEqual([
      "설명은 500자까지 적을 수 있어요",
    ]);
  });
  it("buildRejectBody 는 앞뒤 공백을 지우고, 사유 없이는 던진다", () => {
    expect(buildRejectBody({ reasonCode: "registration_missing", reasonText: "  신고증이 없어요 " })).toEqual({
      reasonCode: "registration_missing",
      reasonText: "신고증이 없어요",
    });
    expect(() => buildRejectBody({ reasonCode: "", reasonText: "x" })).toThrow();
  });
});

describe("표 · 쿼리 · 표시", () => {
  it("상태 이름·반려 사유 이름이 코드 목록을 빠짐없이 덮는다", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...MERCHANT_APPLICATION_STATUSES].sort());
    expect(Object.keys(REJECT_REASON_LABELS).sort()).toEqual([...MERCHANT_REJECT_REASONS].sort());
  });
  it("parseStatusFilter — 아는 상태만, 초안·모르는 값·없음은 전체(null), 여러 개면 마지막", () => {
    expect(parseStatusFilter("in_review")).toBe("in_review");
    expect(parseStatusFilter(["submitted", "rejected"])).toBe("rejected");
    expect(parseStatusFilter("draft")).toBeNull();
    expect(parseStatusFilter("bogus")).toBeNull();
    expect(parseStatusFilter(undefined)).toBeNull();
  });
  it("formatBusinessNumber — 10자리만 하이픈", () => {
    expect(formatBusinessNumber("1234567890")).toBe("123-45-67890");
    expect(formatBusinessNumber("12345")).toBe("12345");
    expect(formatBusinessNumber(null)).toBeNull();
  });
});
