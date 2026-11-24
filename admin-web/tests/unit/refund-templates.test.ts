// S1-3.2(분수 → % 올림 변환과 템플릿 하한 판정) 단위 테스트 — FR-086(등록 형태별 정규 과정 환불 템플릿)
// 계약 09 「Phase 6(테스트) 목록」: 분수 → % 올림(2/3 → 67, 1/2 → 50) · 수용 시나리오 1(1/2 지나기 전 40% 거부)
import { describe, expect, test } from "vitest";

import {
  HAKWON_ACT_TEMPLATE,
  REGULAR_REFUND_POINTS,
  findTiersBelowTemplate,
  fractionToPercentCeil,
  type RegularRefundTier,
} from "../../lib/domain/refund-templates";

/** 시점 4개를 순서대로 % 로 채운 tiers 를 만든다 */
const tiersOf = (a: number, b: number, c: number, d: number): RegularRefundTier[] => [
  { point: "before_start", percent: a },
  { point: "before_one_third", percent: b },
  { point: "before_half", percent: c },
  { point: "after_half", percent: d },
];

describe("fractionToPercentCeil — 분수 몫을 정수 % 로 올림", () => {
  test("2/3 은 66 이 아니라 67 로 올린다", () => {
    expect(fractionToPercentCeil(2, 3)).toBe(67);
  });

  test("나누어떨어지면 그대로 — 1/2 → 50, 1/1 → 100, 0/1 → 0", () => {
    expect(fractionToPercentCeil(1, 2)).toBe(50);
    expect(fractionToPercentCeil(1, 1)).toBe(100);
    expect(fractionToPercentCeil(0, 1)).toBe(0);
  });

  test("다른 나머지도 늘 올린다 — 1/3 → 34, 1/6 → 17, 5/6 → 84, 1/7 → 15", () => {
    expect(fractionToPercentCeil(1, 3)).toBe(34);
    expect(fractionToPercentCeil(1, 6)).toBe(17);
    expect(fractionToPercentCeil(5, 6)).toBe(84);
    expect(fractionToPercentCeil(1, 7)).toBe(15);
  });

  test("결과는 늘 실제 몫 이상 — 1~12 분모 전부에서 내려 잡는 일이 없다", () => {
    for (let den = 1; den <= 12; den += 1) {
      for (let num = 0; num <= den; num += 1) {
        const percent = fractionToPercentCeil(num, den);
        // percent / 100 ≥ num / den  ⇔  percent * den ≥ 100 * num (정수 비교)
        expect(percent * den).toBeGreaterThanOrEqual(100 * num);
        // 올려도 1% 를 넘게 더하지는 않는다
        expect((percent - 1) * den).toBeLessThan(100 * num);
      }
    }
  });

  test("0~1 밖의 몫·0 분모·정수 아닌 값은 RangeError", () => {
    expect(() => fractionToPercentCeil(4, 3)).toThrow(RangeError);
    expect(() => fractionToPercentCeil(-1, 3)).toThrow(RangeError);
    expect(() => fractionToPercentCeil(1, 0)).toThrow(RangeError);
    expect(() => fractionToPercentCeil(1, -2)).toThrow(RangeError);
    expect(() => fractionToPercentCeil(0.5, 1)).toThrow(RangeError);
  });
});

describe("HAKWON_ACT_TEMPLATE — 학원법 반환 기준(초안)", () => {
  test("최소값은 100 · 67 · 50 · 0 이고 시점 순서가 REGULAR_REFUND_POINTS 와 같다", () => {
    expect(HAKWON_ACT_TEMPLATE.minimums).toEqual(tiersOf(100, 67, 50, 0));
    expect(HAKWON_ACT_TEMPLATE.minimums.map((m) => m.point)).toEqual([...REGULAR_REFUND_POINTS]);
  });

  test("계약 09 의 code·templateVersion 과 같고, 미검증 초안으로 표시돼 있다", () => {
    expect(HAKWON_ACT_TEMPLATE.code).toBe("hakwon_act");
    expect(HAKWON_ACT_TEMPLATE.templateVersion).toBe("2026-11-13");
    expect(HAKWON_ACT_TEMPLATE.draft).toBe(true);
  });

  test("상수는 얼어 있어 실행 중에 바꿀 수 없다", () => {
    expect(Object.isFrozen(HAKWON_ACT_TEMPLATE)).toBe(true);
    expect(Object.isFrozen(HAKWON_ACT_TEMPLATE.minimums)).toBe(true);
    expect(Object.isFrozen(HAKWON_ACT_TEMPLATE.minimums[1])).toBe(true);
  });
});

describe("findTiersBelowTemplate — 템플릿보다 덜 돌려주는 값 거부(FR-086)", () => {
  test("수용 시나리오 1: 「1/2 지나기 전」 50% → 40% 는 걸린다", () => {
    const result = findTiersBelowTemplate(tiersOf(100, 67, 40, 0), HAKWON_ACT_TEMPLATE);
    expect(result).toEqual([{ point: "before_half", percent: 40, minimum: 50 }]);
  });

  test("수용 시나리오 1: 같은 칸을 67% 로 올리면 통과(더 돌려주는 쪽)", () => {
    expect(findTiersBelowTemplate(tiersOf(100, 67, 67, 0), HAKWON_ACT_TEMPLATE)).toEqual([]);
  });

  test("템플릿 값 그대로는 통과", () => {
    expect(findTiersBelowTemplate(tiersOf(100, 67, 50, 0), HAKWON_ACT_TEMPLATE)).toEqual([]);
  });

  test("2/3 을 내려 잡은 66% 는 걸린다 — 올림 기준(67)이 하한이다", () => {
    expect(findTiersBelowTemplate(tiersOf(100, 66, 50, 0), HAKWON_ACT_TEMPLATE)).toEqual([
      { point: "before_one_third", percent: 66, minimum: 67 },
    ]);
  });

  test("여러 시점이 걸리면 템플릿 순서대로 전부 돌려준다", () => {
    expect(findTiersBelowTemplate(tiersOf(90, 60, 50, 0), HAKWON_ACT_TEMPLATE)).toEqual([
      { point: "before_start", percent: 90, minimum: 100 },
      { point: "before_one_third", percent: 60, minimum: 67 },
    ]);
  });

  test("입력 순서가 섞여 있어도 시점으로 맞춰 본다", () => {
    const shuffled = [...tiersOf(100, 67, 50, 10)].reverse();
    expect(findTiersBelowTemplate(shuffled, HAKWON_ACT_TEMPLATE)).toEqual([]);
  });

  test("빠진 시점은 덜 돌려주는 것과 같아 percent null 로 걸린다", () => {
    const missingHalf = tiersOf(100, 67, 50, 0).filter((t) => t.point !== "before_half");
    expect(findTiersBelowTemplate(missingHalf, HAKWON_ACT_TEMPLATE)).toEqual([
      { point: "before_half", percent: null, minimum: 50 },
    ]);
  });

  test("「1/2 경과 후」 최소값이 0 이라 0% 는 통과, 더 주는 30% 도 통과", () => {
    expect(findTiersBelowTemplate(tiersOf(100, 67, 50, 0), HAKWON_ACT_TEMPLATE)).toEqual([]);
    expect(findTiersBelowTemplate(tiersOf(100, 100, 100, 30), HAKWON_ACT_TEMPLATE)).toEqual([]);
  });
});
