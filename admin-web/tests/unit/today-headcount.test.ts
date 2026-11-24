// S3-5.5(오늘 인원 계산) — computePresent(확정 − 결석 예정 + 현장)와 evaluateGenderImbalance(역할 불균형 판정) 확인.
//   계약 18-after-payment-views.md §7 · Phase 6(테스트) 목록 7·8번 시나리오.
import { describe, expect, test } from "vitest";

import { computePresent, evaluateGenderImbalance, GENDER_GAP_THRESHOLD } from "@/lib/domain/headcount";

describe("computePresent — 오늘 인원 = 확정 − 결석 예정 + 현장", () => {
  test("확정 남 6 · 결석 예정 1 · 현장 2 이면 7명(수용 ⑤)", () => {
    expect(computePresent(6, 1, 2)).toBe(7);
  });

  test.each([
    // [확정, 결석 예정, 현장, 기대] — 세 값 조합
    [0, 0, 0, 0], // 빈 회차
    [10, 0, 0, 10], // 확정만
    [0, 0, 3, 3], // 현장만
    [7, 0, 1, 8], // 계약 예시 여 7 · 현장 1 → 8
    [6, 1, 0, 5], // 계약 예시 남 6 · 결석 1 → 5
    [5, 5, 0, 0], // 확정 전원 결석
    [5, 5, 2, 2], // 전원 결석 + 현장
  ])("확정 %i · 결석 예정 %i · 현장 %i → %i", (confirmed, absence, onsite, expected) => {
    expect(computePresent(confirmed, absence, onsite)).toBe(expected);
  });

  test("결석 예정이 확정보다 많은 이상한 데이터여도 0 아래로 내려가지 않는다", () => {
    expect(computePresent(1, 3, 0)).toBe(0);
    expect(computePresent(1, 3, 1)).toBe(0);
  });

  test.each([
    [-1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
    [1.5, 0, 0],
    [Number.NaN, 0, 0],
  ])("음수·소수·NaN(%s, %s, %s)은 RangeError", (confirmed, absence, onsite) => {
    expect(() => computePresent(confirmed, absence, onsite)).toThrow(RangeError);
  });
});

describe("evaluateGenderImbalance — 남녀 결제 인원 차이 판정(FR-107)", () => {
  test("기준 상수는 Q38 임시 확정값 3", () => {
    expect(GENDER_GAP_THRESHOLD).toBe(3);
  });

  test("남 8 · 여 5 → 불균형, 모자란 쪽 여, 차이 3(경계 3)", () => {
    expect(evaluateGenderImbalance({ male: 8, female: 5 })).toEqual({ imbalanced: true, shortKind: "female", gap: 3 });
  });

  test("남 8 · 여 6 → 차이 2 는 불균형 아님(경계 2)", () => {
    expect(evaluateGenderImbalance({ male: 8, female: 6 })).toEqual({ imbalanced: false, shortKind: null, gap: 2 });
  });

  test("여가 많으면 모자란 쪽은 남", () => {
    expect(evaluateGenderImbalance({ male: 2, female: 9 })).toEqual({ imbalanced: true, shortKind: "male", gap: 7 });
  });

  test("같으면 차이 0, 불균형 아님", () => {
    expect(evaluateGenderImbalance({ male: 4, female: 4 })).toEqual({ imbalanced: false, shortKind: null, gap: 0 });
    expect(evaluateGenderImbalance({ male: 0, female: 0 })).toEqual({ imbalanced: false, shortKind: null, gap: 0 });
  });

  test("기준을 바꿔 넘기면 그 기준으로 판정한다", () => {
    expect(evaluateGenderImbalance({ male: 8, female: 6 }, 2).imbalanced).toBe(true);
    expect(evaluateGenderImbalance({ male: 8, female: 5 }, 4).imbalanced).toBe(false);
  });

  test("잘못된 인원·기준은 RangeError", () => {
    expect(() => evaluateGenderImbalance({ male: -1, female: 0 })).toThrow(RangeError);
    expect(() => evaluateGenderImbalance({ male: 1, female: 0.5 })).toThrow(RangeError);
    expect(() => evaluateGenderImbalance({ male: 1, female: 1 }, 0)).toThrow(RangeError);
  });
});
