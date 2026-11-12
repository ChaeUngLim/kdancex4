// 공유 계약 §4.6(값 형식: 금액·가격 내역) · §4.3(산정 함수 시그니처)
//
// 금액은 모두 원 단위 정수(`number`)다. JS 의 `number` 는 부동소수라 곱셈 결과가
// 2^53 을 넘으면 정밀도를 잃고, 정수 바닥 나눗셈 연산자도 없다. 그래서 비율 계산은
// BigInt 로 하고, 경계(입력·결과)에서만 안전 정수인지 검사한다(plan D4).
// `Math.ceil(a * b / d)` 같은 부동소수 경로는 쓰지 않는다.

/** 가격 내역 줄 종류 — 이 순서가 곧 FR-283(결제액 계산 순서)다 */
export const PRICE_LINE_KINDS = ["list_price", "benefit_discount", "coupon_discount", "booking_fee", "final"] as const;
export type PriceLineKind = (typeof PRICE_LINE_KINDS)[number];

const PRICE_LINE_LABELS: Readonly<Record<PriceLineKind, string>> = {
  list_price: "정가",
  benefit_discount: "혜택 할인",
  coupon_discount: "쿠폰 할인",
  booking_fee: "예매 수수료",
  final: "최종 결제액",
};

/** 가격 내역 한 줄. 할인 줄의 `amount` 도 양수(빼는 금액)로 담는다 — DB 의 할인 칸(`>= 0`)과 같은 부호 */
export interface PriceLine {
  readonly kind: PriceLineKind;
  readonly label: string;
  readonly amount: number;
}

export interface PriceBreakdownInput {
  listPrice: number;
  benefitDiscount: number;
  couponDiscount: number;
  /**
   * FR-282a(예매 수수료 2,000원) 대상 상품일 때만 넣는다.
   * 생략하면 줄 자체가 없다(정규 수업). 0 을 명시하면 0 줄이 들어간다.
   */
  bookingFee?: number;
}

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} 는 안전 정수여야 한다: ${value}`);
  }
}

function assertNonNegativeAmount(name: string, value: number): void {
  assertSafeInteger(name, value);
  if (value < 0) {
    throw new RangeError(`${name} 는 0 이상이어야 한다: ${value}`);
  }
}

/**
 * `ceil(amount * numerator / denominator)` 를 정수 연산만으로 구한다.
 *
 * - 입력 셋과 결과가 모두 안전 정수여야 한다. 아니면 RangeError.
 * - 곱셈은 BigInt 라 중간값이 2^53 을 넘어도 정확하다.
 * - 음수도 수학적 올림(양의 무한대 쪽)으로 계산한다. 금액이 음수가 될 수 없다는
 *   규칙은 호출하는 쪽(예: 환불액 산정)이 지킨다.
 * - denominator 가 0 이면 RangeError.
 */
export function ceilMulDiv(amount: number, numerator: number, denominator: number): number {
  assertSafeInteger("amount", amount);
  assertSafeInteger("numerator", numerator);
  assertSafeInteger("denominator", denominator);
  if (denominator === 0) {
    throw new RangeError("denominator 는 0 일 수 없다");
  }

  const product = BigInt(amount) * BigInt(numerator);
  const divisor = BigInt(denominator);
  // BigInt 나눗셈은 0 쪽으로 버린다. 나머지가 있고 몫이 양수 쪽이면 1 을 더해 올림이 된다.
  const truncated = product / divisor;
  const hasRemainder = product % divisor !== BigInt(0);
  const isPositive = product > BigInt(0) === divisor > BigInt(0);
  const ceiled = hasRemainder && isPositive ? truncated + BigInt(1) : truncated;

  const result = Number(ceiled);
  if (!Number.isSafeInteger(result) || BigInt(result) !== ceiled) {
    throw new RangeError(`결과가 안전 정수를 넘는다: ${ceiled.toString()}`);
  }
  return result;
}

/**
 * 가격 내역을 FR-283(결제액 계산 순서) 순서로 만든다 — 정가 → 혜택 할인 → 쿠폰 → 예매 수수료 → 최종.
 *
 * - 할인 줄은 0 이어도 넣는다(FR-117(체크아웃 가격 내역)).
 * - 할인 뒤 금액이 0 미만이면 0 으로 막고, 예매 수수료는 그 위에 더한다
 *   (03-checkout-payment.md §3: `final = list − benefit − coupon (+ booking_fee)`, 0 미만이면 0).
 * - 돌려주는 배열과 각 줄은 얼려서(freeze) 돌려준다.
 */
export function computePriceBreakdown(input: PriceBreakdownInput): readonly PriceLine[] {
  const { listPrice, benefitDiscount, couponDiscount, bookingFee } = input;
  assertNonNegativeAmount("listPrice", listPrice);
  assertNonNegativeAmount("benefitDiscount", benefitDiscount);
  assertNonNegativeAmount("couponDiscount", couponDiscount);
  if (bookingFee !== undefined) {
    assertNonNegativeAmount("bookingFee", bookingFee);
  }

  const discounted = Math.max(0, listPrice - benefitDiscount - couponDiscount);
  const finalAmount = discounted + (bookingFee ?? 0);
  assertSafeInteger("final", finalAmount);

  const line = (kind: PriceLineKind, amount: number): PriceLine =>
    Object.freeze({ kind, label: PRICE_LINE_LABELS[kind], amount });

  const lines: PriceLine[] = [
    line("list_price", listPrice),
    line("benefit_discount", benefitDiscount),
    line("coupon_discount", couponDiscount),
    ...(bookingFee === undefined ? [] : [line("booking_fee", bookingFee)]),
    line("final", finalAmount),
  ];
  return Object.freeze(lines);
}
