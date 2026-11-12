// T-M3-2(환불액 산정 이식) — SCH-03(환불액 산정) 단위 테스트. 공유 계약 §4.3(산정 함수 시그니처)·§4.4(환불 비율표 JSONB 형태)
//
// 옛 backend/tests/test_refund_policy.py 50개 사례를 1:1 로 옮겼다. 각 describe/test 이름 앞의
// `test_...` 는 옛 pytest 함수 이름이다 — T-M3-6(주입 지점·이관 대응표 M3분)이 이 이름으로 짝을 찾는다.
// 파라미터 사례는 `test.each` 로 옮겨 옛 사례 하나가 vitest 테스트 하나가 되게 했다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { REFUND_REASONS } from "../../lib/domain/constants";
import {
  BASIS_POINT_DENOMINATOR,
  FULL_REFUND_RATE_BP,
  FULL_REFUND_THRESHOLD_SECONDS,
  NO_REFUND_RATE_BP,
  type RefundCalculation,
  type RefundPolicyTier,
  calculateRefund,
} from "../../lib/domain/refund-policy";

/** 모든 테스트의 기준 수업 시작 순간. `now` 를 여기서 빼서 남은 시간을 만든다 */
const STARTS_AT = Temporal.Instant.from("2026-10-01T12:00:00Z");

/** 24시간 미만 구간을 덮는 표준 비율표(§4.4 모양 그대로) */
const STANDARD_TIERS: readonly RefundPolicyTier[] = [
  { hours_before_start: 24, refund_rate_bp: 5000 },
  { hours_before_start: 12, refund_rate_bp: 3000 },
  { hours_before_start: 2, refund_rate_bp: 0 },
];

type Before = Temporal.DurationLike;

/** 수업 시작 `before` 전의 순간 */
function at(before: Before): Temporal.Instant {
  return STARTS_AT.subtract(before);
}

function call(
  opts: { paidAmount?: number; before?: Before; tiers?: readonly unknown[] } = {},
): RefundCalculation {
  return calculateRefund({
    paidAmount: opts.paidAmount ?? 100_000,
    startsAt: STARTS_AT,
    now: at(opts.before ?? { hours: 48 }),
    tiers: (opts.tiers ?? STANDARD_TIERS) as readonly RefundPolicyTier[],
  });
}

// ---------------------------------------------------------------------------
// 24시간 경계
// ---------------------------------------------------------------------------

describe("24시간 경계", () => {
  test("test_exactly_24h_before_start_is_full_refund — 정확히 24:00:00 전은 전액(24h 티어보다 플랫폼 규칙 우선)", () => {
    const result = call({ paidAmount: 100_000, before: { hours: 24 } });

    expect(result.secondsBeforeStart).toBe(FULL_REFUND_THRESHOLD_SECONDS);
    expect(FULL_REFUND_THRESHOLD_SECONDS).toBe(86_400);
    expect(result.refundRateBp).toBe(FULL_REFUND_RATE_BP);
    expect(FULL_REFUND_RATE_BP).toBe(10_000);
    expect(result.refundAmount).toBe(100_000);
    expect(result.appliedTierHours).toBeNull();
  });

  test.each([
    // 23:59:59 남음 → 24시간 미만 → 24h 티어(50%)
    { label: "23:59:59", before: { hours: 23, minutes: 59, seconds: 59 }, seconds: 86_399, rate: 5_000, amount: 50_000 },
    // 정각 → 경계 포함 → 전액
    { label: "24:00:00", before: { hours: 24 }, seconds: 86_400, rate: 10_000, amount: 100_000 },
    // 24시간 초과 → 전액
    { label: "24:00:01", before: { hours: 24, seconds: 1 }, seconds: 86_401, rate: 10_000, amount: 100_000 },
  ])("test_24h_boundary_is_inclusive_of_full_refund[$label]", ({ before, seconds, rate, amount }) => {
    const result = call({ paidAmount: 100_000, before });

    expect(result.secondsBeforeStart).toBe(seconds);
    expect(result.refundRateBp).toBe(rate);
    expect(result.refundAmount).toBe(amount);
  });

  test("test_sub_second_remainder_is_truncated_not_rounded_up — 23:59:59.999999 남음은 24시간 미만", () => {
    const now = STARTS_AT.subtract({ hours: 24 }).add({ microseconds: 1 });
    const result = calculateRefund({ paidAmount: 100_000, startsAt: STARTS_AT, now, tiers: STANDARD_TIERS });

    expect(result.secondsBeforeStart).toBe(86_399);
    expect(result.refundRateBp).toBe(5_000);
  });

  test("test_far_future_is_full_refund_even_with_empty_tiers — 24시간 이상이면 빈 비율표도 전액", () => {
    // Temporal.Instant 는 days 단위 산술을 받지 않아 30일을 시간으로 적는다
    const result = call({ paidAmount: 77_777, before: { hours: 30 * 24 }, tiers: [] });

    expect(result.refundRateBp).toBe(FULL_REFUND_RATE_BP);
    expect(result.refundAmount).toBe(77_777);
  });

  test("test_timezone_differences_do_not_shift_the_boundary — KST 로 만든 now 도 같은 순간이면 같은 판정", () => {
    const now = STARTS_AT.subtract({ hours: 24 }).toZonedDateTimeISO("Asia/Seoul").toInstant();
    const result = calculateRefund({ paidAmount: 100_000, startsAt: STARTS_AT, now, tiers: STANDARD_TIERS });

    expect(result.secondsBeforeStart).toBe(86_400);
    expect(result.refundRateBp).toBe(FULL_REFUND_RATE_BP);
  });
});

// ---------------------------------------------------------------------------
// 티어 해석
// ---------------------------------------------------------------------------

describe("티어 해석", () => {
  test.each([
    // 남은 시간 h 에 대해 h <= tier.hours 인 티어 중 hours 최솟값
    { label: "23h", before: { hours: 23 }, tier: 24, rate: 5_000 },
    { label: "12h+1s", before: { hours: 12, seconds: 1 }, tier: 24, rate: 5_000 },
    { label: "12h", before: { hours: 12 }, tier: 12, rate: 3_000 },
    { label: "5h", before: { hours: 5 }, tier: 12, rate: 3_000 },
    { label: "2h", before: { hours: 2 }, tier: 2, rate: 0 },
    { label: "30m", before: { minutes: 30 }, tier: 2, rate: 0 },
  ])("test_tier_resolution_picks_smallest_covering_tier[$label]", ({ before, tier, rate }) => {
    const result = call({ paidAmount: 100_000, before });

    expect(result.appliedTierHours).toBe(tier);
    expect(result.refundRateBp).toBe(rate);
  });

  test("test_tier_boundary_is_inclusive — h == hours_before_start 이면 그 티어에 포함", () => {
    const tiers = [{ hours_before_start: 6, refund_rate_bp: 4_000 }];

    const included = call({ paidAmount: 10_000, before: { hours: 6 }, tiers });
    const excluded = call({ paidAmount: 10_000, before: { hours: 6, seconds: 1 }, tiers });

    expect(included.refundRateBp).toBe(4_000);
    expect(included.appliedTierHours).toBe(6);
    expect(excluded.refundRateBp).toBe(NO_REFUND_RATE_BP);
    expect(excluded.appliedTierHours).toBeNull();
  });

  test("test_tier_order_does_not_matter — 비율표 순서를 섞어도 결과가 같다", () => {
    const shuffled = [
      { hours_before_start: 2, refund_rate_bp: 0 },
      { hours_before_start: 24, refund_rate_bp: 5000 },
      { hours_before_start: 12, refund_rate_bp: 3000 },
    ];

    for (const before of [{ hours: 23 }, { hours: 12 }, { hours: 1 }]) {
      expect(call({ before, tiers: shuffled })).toEqual(call({ before, tiers: STANDARD_TIERS }));
    }
  });

  test("test_empty_tiers_under_24h_is_zero_refund — 24시간 이내 + 비율표 미설정은 0원", () => {
    const result = call({ paidAmount: 100_000, before: { hours: 3 }, tiers: [] });

    expect(result.refundRateBp).toBe(NO_REFUND_RATE_BP);
    expect(result.refundAmount).toBe(0);
    expect(result.appliedTierHours).toBeNull();
  });

  test("test_no_covering_tier_is_zero_refund — 덮는 티어가 없으면 0%", () => {
    const tiers = [{ hours_before_start: 12, refund_rate_bp: 3_000 }];
    const result = call({ paidAmount: 100_000, before: { hours: 13 }, tiers });

    expect(result.refundRateBp).toBe(NO_REFUND_RATE_BP);
    expect(result.refundAmount).toBe(0);
  });

  test("test_duplicate_tier_hours_uses_first_occurrence — hours 중복이면 앞의 것", () => {
    const tiers = [
      { hours_before_start: 6, refund_rate_bp: 4_000 },
      { hours_before_start: 6, refund_rate_bp: 1_000 },
    ];
    const result = call({ paidAmount: 10_000, before: { hours: 5 }, tiers });

    expect(result.refundRateBp).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// 금액 계산 — 올림, 정수 연산, clamp
// ---------------------------------------------------------------------------

describe("금액 계산", () => {
  test.each([
    // 나누어떨어지는 경우
    { paid: 100_000, rate: 5_000, expected: 50_000 },
    { paid: 30_000, rate: 3_333, expected: 9_999 },
    // 올림이 실제로 1원을 올리는 경우
    { paid: 1_000, rate: 3_333, expected: 334 }, // 333.3 → 334
    { paid: 1, rate: 1, expected: 1 }, // 0.0001 → 1
    { paid: 1, rate: 9_999, expected: 1 }, // 0.9999 → 1
    { paid: 999, rate: 5_000, expected: 500 }, // 499.5 → 500
    { paid: 12_345, rate: 3_333, expected: 4_115 }, // 4114.5885 → 4115
    { paid: 7, rate: 10, expected: 1 }, // 0.007 → 1
  ])("test_amount_is_rounded_up[$paid-$rate]", ({ paid, rate, expected }) => {
    const tiers = [{ hours_before_start: 6, refund_rate_bp: rate }];
    const result = call({ paidAmount: paid, before: { hours: 5 }, tiers });

    expect(result.refundAmount).toBe(expected);
  });

  test("test_nonzero_rate_never_refunds_zero — 비율이 0 이 아니면 최소 1원", () => {
    const tiers = [{ hours_before_start: 6, refund_rate_bp: 1 }];
    const result = call({ paidAmount: 1, before: { hours: 5 }, tiers });

    expect(result.refundAmount).toBe(1);
  });

  test("test_amounts_are_plain_ints_not_floats — 금액·비율·시간 칸이 모두 안전 정수", () => {
    const result = call({ paidAmount: 12_345, before: { hours: 5 } });

    for (const value of [
      result.refundAmount,
      result.refundRateBp,
      result.hoursBeforeStart,
      result.secondsBeforeStart,
    ]) {
      expect(Number.isSafeInteger(value), `${value} 이 정수가 아니다`).toBe(true);
    }
  });

  test.each([NO_REFUND_RATE_BP, FULL_REFUND_RATE_BP])("test_rate_extremes[%i] — 0bp 는 0원, 10000bp 는 전액", (rate) => {
    const tiers = [{ hours_before_start: 6, refund_rate_bp: rate }];
    const result = call({ paidAmount: 100_000, before: { hours: 5 }, tiers });

    expect(result.refundRateBp).toBe(rate);
    expect(result.refundAmount).toBe((100_000 * rate) / BASIS_POINT_DENOMINATOR);
    expect(result.refundAmount).toBe(rate === 0 ? 0 : 100_000);
  });

  test("test_full_rate_never_exceeds_paid_amount — 10000bp 도 결제액을 넘지 않는다", () => {
    const result = call({ paidAmount: 99_999, before: { hours: 24, seconds: 1 }, tiers: [] });

    expect(result.refundAmount).toBe(99_999);
    expect(result.refundAmount).toBeLessThanOrEqual(99_999);
  });

  test.each([
    { label: "7d", before: { hours: 7 * 24 } },
    { label: "24h", before: { hours: 24 } },
    { label: "5h", before: { hours: 5 } },
    { label: "1m", before: { minutes: 1 } },
  ])("test_zero_paid_amount_refunds_zero[$label] — 결제액 0원은 어느 구간도 0원", ({ before }) => {
    const result = call({ paidAmount: 0, before });

    expect(result.refundAmount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 이미 시작한 수업 — 호출자 책임이지만 계산은 터지지 않는다
// ---------------------------------------------------------------------------

describe("이미 시작한 수업", () => {
  test("test_after_start_is_zero_refund_without_raising — 시작 1시간 뒤도 예외 없이 0%", () => {
    const now = STARTS_AT.add({ hours: 1 });
    const result = calculateRefund({ paidAmount: 100_000, startsAt: STARTS_AT, now, tiers: STANDARD_TIERS });

    expect(result.secondsBeforeStart).toBe(-3_600);
    expect(result.hoursBeforeStart).toBe(-1);
    expect(result.refundRateBp).toBe(NO_REFUND_RATE_BP);
    expect(result.refundAmount).toBe(0);
  });

  test("test_hours_before_start_is_floored — 5시간 59분은 5시간", () => {
    const result = call({ before: { hours: 5, minutes: 59 } });

    expect(result.hoursBeforeStart).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 입력 검증
// ---------------------------------------------------------------------------

describe("입력 검증", () => {
  // 옛 사례는 tz-naive datetime 거부였다. Temporal.Instant 는 늘 절대 순간이라 naive 가 생길 수 없다.
  // TS 에서 남는 위험은 시간대 없는 PlainDateTime 등을 타입 단언으로 흘려 넣는 것이라 그것을 거부한다.
  test("test_naive_now_is_rejected — 시간대 없는 now(PlainDateTime) 거부", () => {
    expect(() =>
      calculateRefund({
        paidAmount: 10_000,
        startsAt: STARTS_AT,
        now: Temporal.PlainDateTime.from("2026-09-30T12:00:00") as unknown as Temporal.Instant,
        tiers: [],
      }),
    ).toThrow(/Temporal\.Instant/);
  });

  test("test_naive_starts_at_is_rejected — 시간대 없는 startsAt(PlainDateTime) 거부", () => {
    expect(() =>
      calculateRefund({
        paidAmount: 10_000,
        startsAt: Temporal.PlainDateTime.from("2026-10-01T12:00:00") as unknown as Temporal.Instant,
        now: at({ hours: 5 }),
        tiers: [],
      }),
    ).toThrow(/Temporal\.Instant/);
  });

  test("test_negative_paid_amount_is_rejected — 음수 결제액 거부", () => {
    expect(() => call({ paidAmount: -1 })).toThrow(/0 이상/);
  });

  test.each([
    { id: "hours 키 없음", tiers: [{ refund_rate_bp: 5_000 }] },
    { id: "rate 키 없음", tiers: [{ hours_before_start: 6 }] },
    { id: "rate 범위 초과", tiers: [{ hours_before_start: 6, refund_rate_bp: 10_001 }] },
    { id: "rate 음수", tiers: [{ hours_before_start: 6, refund_rate_bp: -1 }] },
    { id: "hours 0", tiers: [{ hours_before_start: 0, refund_rate_bp: 5_000 }] },
    { id: "hours 범위 초과", tiers: [{ hours_before_start: 721, refund_rate_bp: 5_000 }] },
    // 옛 사례는 50.0(float) 이었다. JS 는 50.0 과 50 을 구분하지 못하므로 정수가 아닌 50.5 로 옮겼다
    { id: "rate float", tiers: [{ hours_before_start: 6, refund_rate_bp: 50.5 }] },
    { id: "dict 아님", tiers: ["not-a-dict"] },
  ])("test_malformed_tiers_raise[$id] — 잘못된 비율표는 터뜨린다", ({ tiers }) => {
    expect(() => call({ before: { hours: 5 }, tiers })).toThrow();
  });

  test("test_cancellation_reason_has_only_member_request — refunds.reason 값 집합은 member_request 하나", () => {
    expect([...REFUND_REASONS]).toEqual(["member_request"]);
  });

  test("test_unknown_reason_is_rejected — 알 수 없는 사유(academy_fault) 거부", () => {
    expect(() =>
      calculateRefund({
        paidAmount: 10_000,
        startsAt: STARTS_AT,
        now: at({ hours: 5 }),
        tiers: [],
        reason: "academy_fault" as unknown as "member_request",
      }),
    ).toThrow(/reason/);
  });
});
