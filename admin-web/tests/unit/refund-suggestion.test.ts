// S4-1.3(중도 환불 금액 미리 채움 계산) 단위 테스트 — FR-294(중도 환불 계산 보조)
// 계약 12 §1-4 `suggestRegularRefund` · 열린 점 ⑮(회차 수 기준 시점 판정) · S4-1 수용 ①(미리 채움)
import { describe, expect, test } from "vitest";

import { HAKWON_ACT_TEMPLATE, type RegularRefundTier } from "../../lib/domain/refund-templates";
import { regularRefundPointFor, suggestRegularRefund } from "../../lib/domain/refund-suggestion";

/** 시점 4개를 순서대로 % 로 채운 공지 판본 */
const noticeOf = (a: number, b: number, c: number, d: number): { tiers: RegularRefundTier[] } => ({
  tiers: [
    { point: "before_start", percent: a },
    { point: "before_one_third", percent: b },
    { point: "before_half", percent: c },
    { point: "after_half", percent: d },
  ],
});

describe("suggestRegularRefund — verify 예시", () => {
  test("8회차 120,000원에서 3회 진행 → 남은 5회·회차당 15,000원, 공지 50% 구간이면 미리 채움 = 계산값 60,000원", () => {
    // Arrange
    const input = { paidAmount: 120_000, sessionsTotal: 8, sessionsElapsed: 3, notice: noticeOf(100, 67, 50, 0) };

    // Act
    const s = suggestRegularRefund(input);

    // Assert
    expect(s.remainingSessions).toBe(5);
    expect(s.perSessionAmount).toBe(15_000);
    expect(s.point).toBe("before_half");
    expect(s.percent).toBe(50);
    expect(s.suggestedAmount).toBe(60_000);
    expect(s.suggestedAmount).toBe((120_000 * 50) / 100);
  });
});

describe("suggestRegularRefund — 계약 예시", () => {
  test("160,000원 4회 · 1회 진행 → 1/3 지나기 전 67% → 107,200원 · 회차당 40,000원 · 남은 3회(O48)", () => {
    const s = suggestRegularRefund({ paidAmount: 160_000, sessionsTotal: 4, sessionsElapsed: 1, notice: noticeOf(100, 67, 50, 0) });
    expect(s).toEqual({ point: "before_one_third", percent: 67, suggestedAmount: 107_200, perSessionAmount: 40_000, remainingSessions: 3 });
  });

  test("180,000원 4회 · 1회 진행 → 120,600원 · 회차당 45,000원(S4-1 수용 ①)", () => {
    const s = suggestRegularRefund({ paidAmount: 180_000, sessionsTotal: 4, sessionsElapsed: 1, notice: noticeOf(100, 67, 67, 0) });
    expect(s.suggestedAmount).toBe(120_600);
    expect(s.perSessionAmount).toBe(45_000);
  });

  test("학원법 템플릿 그대로 저장한 공지도 같은 식으로 쓴다", () => {
    const s = suggestRegularRefund({ paidAmount: 90_000, sessionsTotal: 6, sessionsElapsed: 0, notice: { tiers: [...HAKWON_ACT_TEMPLATE.minimums] } });
    expect(s.point).toBe("before_start");
    expect(s.suggestedAmount).toBe(90_000);
  });
});

describe("regularRefundPointFor — 회차 수 기준 경계(열린 점 ⑮)", () => {
  test.each([
    [0, 8, "before_start"],
    [1, 3, "before_one_third"], // 정확히 1/3 은 아직 지나지 않음
    [2, 6, "before_one_third"],
    [3, 8, "before_half"],
    [2, 4, "before_half"], // 정확히 1/2 은 아직 지나지 않음
    [3, 5, "after_half"],
    [8, 8, "after_half"],
  ] as const)("진행 %i / 총 %i → %s", (elapsed, total, point) => {
    expect(regularRefundPointFor(elapsed, total)).toBe(point);
  });
});

describe("suggestRegularRefund — 올림과 상한", () => {
  test("원 미만은 올린다(10,000원 3회 → 회차당 3,334원 · 99,999원 × 67% → 67,000원)", () => {
    const s = suggestRegularRefund({ paidAmount: 10_000, sessionsTotal: 3, sessionsElapsed: 1, notice: noticeOf(100, 67, 50, 0) });
    expect(s.perSessionAmount).toBe(3_334);
    expect(s.suggestedAmount).toBe(6_700);
    const odd = suggestRegularRefund({ paidAmount: 99_999, sessionsTotal: 4, sessionsElapsed: 1, notice: noticeOf(100, 67, 50, 0) });
    expect(odd.suggestedAmount).toBe(67_000); // 66,999.33 → 67,000
  });

  test("미리 채움값은 결제액을 넘지 않는다(100% 면 결제액 그대로)", () => {
    const s = suggestRegularRefund({ paidAmount: 77_777, sessionsTotal: 7, sessionsElapsed: 0, notice: noticeOf(100, 67, 50, 0) });
    expect(s.suggestedAmount).toBe(77_777);
  });

  test("1/2 지난 뒤 0% 공지면 0원을 채운다", () => {
    const s = suggestRegularRefund({ paidAmount: 120_000, sessionsTotal: 8, sessionsElapsed: 6, notice: noticeOf(100, 67, 50, 0) });
    expect(s.point).toBe("after_half");
    expect(s.suggestedAmount).toBe(0);
    expect(s.remainingSessions).toBe(2);
  });

  test("결과는 얼려 있다", () => {
    const s = suggestRegularRefund({ paidAmount: 120_000, sessionsTotal: 8, sessionsElapsed: 3, notice: noticeOf(100, 67, 50, 0) });
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe("suggestRegularRefund — 잘못된 입력은 RangeError", () => {
  const notice = noticeOf(100, 67, 50, 0);
  test.each([
    ["음수 결제액", { paidAmount: -1, sessionsTotal: 8, sessionsElapsed: 0, notice }],
    ["소수 결제액", { paidAmount: 1.5, sessionsTotal: 8, sessionsElapsed: 0, notice }],
    ["총 회차 0", { paidAmount: 1000, sessionsTotal: 0, sessionsElapsed: 0, notice }],
    ["진행이 총 회차보다 큼", { paidAmount: 1000, sessionsTotal: 4, sessionsElapsed: 5, notice }],
    ["진행 음수", { paidAmount: 1000, sessionsTotal: 4, sessionsElapsed: -1, notice }],
    ["% 범위 밖", { paidAmount: 1000, sessionsTotal: 4, sessionsElapsed: 1, notice: noticeOf(100, 101, 50, 0) }],
    ["공지에 시점 없음", { paidAmount: 1000, sessionsTotal: 4, sessionsElapsed: 1, notice: { tiers: [{ point: "before_start" as const, percent: 100 }] } }],
  ])("%s", (_name, input) => {
    expect(() => suggestRegularRefund(input)).toThrow(RangeError);
  });
});
