// T-M3-1(값 상수·금액·시각 도우미) — 공유 계약 §4.6(값 형식: 금액·가격 내역) 단위 테스트
import { describe, expect, test } from "vitest";

import { ceilMulDiv, computePriceBreakdown } from "../../lib/domain/money";

describe("ceilMulDiv — BigInt 올림 나눗셈", () => {
  test("나누어떨어지면 몫을 그대로 돌려준다", () => {
    expect(ceilMulDiv(10_000, 5_000, 10_000)).toBe(5_000);
  });

  test("나머지가 있으면 1 올린다", () => {
    // 9_999 * 5_000 / 10_000 = 4_999.5 → 5_000
    expect(ceilMulDiv(9_999, 5_000, 10_000)).toBe(5_000);
  });

  test("나누어떨어지기 1 모자란 분자도 1 올린다", () => {
    // 2 * 3 = 6, 6 / 7 → 1 (0.857… 올림)
    expect(ceilMulDiv(2, 3, 7)).toBe(1);
    // 7 * 1 = 7 은 나누어떨어짐, 6 은 1 모자람
    expect(ceilMulDiv(7, 1, 7)).toBe(1);
    expect(ceilMulDiv(6, 1, 7)).toBe(1);
    expect(ceilMulDiv(8, 1, 7)).toBe(2);
  });

  test("0 금액은 0 이다", () => {
    expect(ceilMulDiv(0, 5_000, 10_000)).toBe(0);
  });

  test("곱이 안전 정수를 넘어도 BigInt 라 정확하다", () => {
    // 9_007_199_254_740_991 * 3 은 안전 정수를 넘지만 / 3 결과는 안전 정수
    expect(ceilMulDiv(Number.MAX_SAFE_INTEGER, 3, 3)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("음수는 수학적 올림(양의 무한대 쪽)으로 계산한다", () => {
    // -7 / 2 = -3.5 → -3
    expect(ceilMulDiv(-7, 1, 2)).toBe(-3);
    // 7 / -2 = -3.5 → -3
    expect(ceilMulDiv(7, 1, -2)).toBe(-3);
    // -7 / -2 = 3.5 → 4
    expect(ceilMulDiv(-7, 1, -2)).toBe(4);
  });

  test("0 으로 나누면 예외", () => {
    expect(() => ceilMulDiv(100, 1, 0)).toThrow(RangeError);
  });

  test("안전 정수를 넘는 입력은 예외", () => {
    expect(() => ceilMulDiv(Number.MAX_SAFE_INTEGER + 1, 1, 1)).toThrow(RangeError);
    expect(() => ceilMulDiv(1, Number.MAX_SAFE_INTEGER + 1, 1)).toThrow(RangeError);
    expect(() => ceilMulDiv(1, 1, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  test("정수가 아닌 입력은 예외", () => {
    expect(() => ceilMulDiv(1.5, 1, 1)).toThrow(RangeError);
    expect(() => ceilMulDiv(Number.NaN, 1, 1)).toThrow(RangeError);
    expect(() => ceilMulDiv(Number.POSITIVE_INFINITY, 1, 1)).toThrow(RangeError);
  });

  test("결과가 안전 정수를 넘으면 예외", () => {
    expect(() => ceilMulDiv(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
  });
});

describe("computePriceBreakdown — FR-283(결제액 계산 순서)·FR-117(체크아웃 가격 내역)", () => {
  test("할인이 0 이어도 줄을 빼지 않고, 예매 수수료가 없으면 그 줄은 없다", () => {
    const lines = computePriceBreakdown({ listPrice: 120_000, benefitDiscount: 0, couponDiscount: 0 });

    expect(lines.map((l) => l.kind)).toEqual(["list_price", "benefit_discount", "coupon_discount", "final"]);
    expect(lines.map((l) => l.amount)).toEqual([120_000, 0, 0, 120_000]);
  });

  test("정가 → 혜택 할인 → 쿠폰 → 예매 수수료 → 최종 순서다", () => {
    const lines = computePriceBreakdown({
      listPrice: 50_000,
      benefitDiscount: 25_000,
      couponDiscount: 0,
      bookingFee: 2_000,
    });

    expect(lines.map((l) => l.kind)).toEqual([
      "list_price",
      "benefit_discount",
      "coupon_discount",
      "booking_fee",
      "final",
    ]);
    expect(lines.at(-1)?.amount).toBe(27_000);
  });

  test("예매 수수료가 0 으로 명시되면 0 줄을 넣는다", () => {
    const lines = computePriceBreakdown({ listPrice: 10_000, benefitDiscount: 0, couponDiscount: 0, bookingFee: 0 });

    expect(lines.find((l) => l.kind === "booking_fee")?.amount).toBe(0);
  });

  test("모든 줄에 한글 표시 이름이 붙는다", () => {
    const lines = computePriceBreakdown({ listPrice: 10_000, benefitDiscount: 0, couponDiscount: 0, bookingFee: 2_000 });

    expect(lines.map((l) => l.label)).toEqual(["정가", "혜택 할인", "쿠폰 할인", "예매 수수료", "최종 결제액"]);
  });

  test("할인이 정가보다 커도 최종액은 0 미만이 되지 않는다", () => {
    const lines = computePriceBreakdown({ listPrice: 10_000, benefitDiscount: 8_000, couponDiscount: 5_000 });

    expect(lines.at(-1)?.amount).toBe(0);
  });

  test("할인이 정가를 넘어도 예매 수수료는 깎이지 않는다", () => {
    const lines = computePriceBreakdown({
      listPrice: 10_000,
      benefitDiscount: 20_000,
      couponDiscount: 0,
      bookingFee: 2_000,
    });

    expect(lines.at(-1)?.amount).toBe(2_000);
  });

  test("음수·소수·안전 정수 초과 금액은 예외", () => {
    expect(() => computePriceBreakdown({ listPrice: -1, benefitDiscount: 0, couponDiscount: 0 })).toThrow(RangeError);
    expect(() => computePriceBreakdown({ listPrice: 100, benefitDiscount: 0.5, couponDiscount: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      computePriceBreakdown({ listPrice: Number.MAX_SAFE_INTEGER + 1, benefitDiscount: 0, couponDiscount: 0 }),
    ).toThrow(RangeError);
  });

  test("정가 + 예매 수수료가 안전 정수를 넘으면 예외", () => {
    expect(() =>
      computePriceBreakdown({
        listPrice: Number.MAX_SAFE_INTEGER,
        benefitDiscount: 0,
        couponDiscount: 0,
        bookingFee: 1,
      }),
    ).toThrow(RangeError);
  });

  test("돌려준 배열은 바꿀 수 없다", () => {
    const lines = computePriceBreakdown({ listPrice: 10_000, benefitDiscount: 0, couponDiscount: 0 });

    expect(Object.isFrozen(lines)).toBe(true);
    expect(Object.isFrozen(lines[0])).toBe(true);
  });
});
