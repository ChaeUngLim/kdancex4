// T-M3-2(환불액 산정 이식) — SCH-03(환불액 산정) 순수 함수. 공유 계약 §4.3(산정 함수 시그니처)·§4.4(환불 비율표 JSONB 형태)
//
// 옛 backend/app/services/refund_policy.py 의 calculate_refund 를 그대로 옮겼다. DB·IO·시스템 시각에
// 기대지 않는다 — 현재 순간 `now` 는 반드시 호출자가 넣는다. 그래야 「정확히 24시간 전」 같은 경계를
// 테스트로 못박을 수 있다.
//
// 산정 규칙(옛 Phase 3 §2.1·§2.2 결정 그대로):
// 1. 수업 시작까지 24시간 이상 남았으면 100%. 학원 비율표와 무관한 플랫폼 규칙이고, 정확히 24:00:00 은 전액 쪽이다.
// 2. 24시간 미만이면 남은 시간 h 에 대해 h <= hours_before_start 인 티어 중 hours 가 가장 작은 것을 쓴다.
// 3. 맞는 티어가 없으면 0%.
// 4. 금액은 올림(회원에게 유리한 쪽). 부동소수 없이 money.ts 의 ceilMulDiv(BigInt) 로 계산한다.
// 5. 결과는 결제액을 넘지 않게 막는다.
//
// 이미 시작한 수업·이미 취소된 예약을 걸러내는 일은 취소 서비스의 몫이다. 여기서는 남은 시간이
// 음수여도 예외 없이 규칙을 적용한다.
import "temporal-polyfill/full/global";

import { REFUND_REASONS, type RefundReason } from "./constants";
import { ceilMulDiv } from "./money";

/** 이 초 이상 남았으면 비율표와 무관하게 전액 환불(경계 포함) */
export const FULL_REFUND_THRESHOLD_SECONDS = 24 * 60 * 60;

/** basis point 분모. 10000bp = 100% */
export const BASIS_POINT_DENOMINATOR = 10_000;

export const FULL_REFUND_RATE_BP = 10_000;
export const NO_REFUND_RATE_BP = 0;

const SECONDS_PER_HOUR = 60 * 60;
const NANOSECONDS_PER_SECOND = BigInt(1_000_000_000);

/** 티어 시간 허용 범위 — admin 쓰기 경로와 같은 범위 */
const MIN_TIER_HOURS = 1;
const MAX_TIER_HOURS = 720;

/** §4.4 환불 비율표 한 줄. 칸 이름은 DB·JSON 과 같은 snake_case 를 유지한다 */
export interface RefundPolicyTier {
  readonly hours_before_start: number;
  readonly refund_rate_bp: number;
}

export interface RefundCalculationInput {
  /** 결제액(원, 0 이상 안전 정수) */
  paidAmount: number;
  startsAt: Temporal.Instant;
  /** 산정 기준 순간. 반드시 주입한다 */
  now: Temporal.Instant;
  /** `academies.refund_policy_tiers` JSONB 원본 그대로(§4.4) */
  tiers: readonly RefundPolicyTier[];
  /**
   * 취소 사유. 생략하면 `member_request`. 지금은 값이 하나라 산정에 영향을 주지 않고,
   * 학원 귀책 분기가 생길 자리만 열어 둔다(옛 시그니처 유지 — §4.3 에는 없는 칸).
   */
  reason?: RefundReason;
}

/**
 * 산정 결과. §4.3 의 세 칸(refundRateBp·refundAmount·hoursBeforeStart)에 옛 결과의
 * 두 칸(secondsBeforeStart·appliedTierHours)을 더했다.
 */
export interface RefundCalculation {
  /** 환불할 금액(원). 항상 0 <= refundAmount <= paidAmount */
  readonly refundAmount: number;
  /** 적용한 환불율(0~10000bp) */
  readonly refundRateBp: number;
  /** 시작까지 남은 시간(시). 내림 — 이미 시작했으면 음수 */
  readonly hoursBeforeStart: number;
  /** 시작까지 남은 시간(초). 내림. 경계 판정의 실제 근거 */
  readonly secondsBeforeStart: number;
  /** 적용한 티어의 hours_before_start. 24시간 규칙이거나 맞는 티어가 없으면 null */
  readonly appliedTierHours: number | null;
}

/** 환불액을 산정한다. DB·IO 없음. 잘못된 입력은 조용히 넘기지 않고 TypeError/RangeError 로 터뜨린다 */
export function calculateRefund(input: RefundCalculationInput): RefundCalculation {
  const { paidAmount, startsAt, now, tiers, reason = "member_request" } = input;

  if (typeof paidAmount !== "number" || !Number.isSafeInteger(paidAmount)) {
    throw new TypeError(`paidAmount 는 정수여야 한다: ${String(paidAmount)}`);
  }
  if (paidAmount < 0) {
    throw new RangeError(`paidAmount 는 0 이상이어야 한다: ${paidAmount}`);
  }
  requireInstant(startsAt, "startsAt");
  requireInstant(now, "now");
  if (!(REFUND_REASONS as readonly string[]).includes(reason)) {
    throw new RangeError(`알 수 없는 reason: ${String(reason)}`);
  }

  const secondsBeforeStart = secondsBetween(now, startsAt);

  let refundRateBp: number;
  let appliedTierHours: number | null;
  if (secondsBeforeStart >= FULL_REFUND_THRESHOLD_SECONDS) {
    // 플랫폼 고정 규칙 — 비율표를 보지 않는다
    refundRateBp = FULL_REFUND_RATE_BP;
    appliedTierHours = null;
  } else {
    [refundRateBp, appliedTierHours] = resolveTier(tiers, secondsBeforeStart);
  }

  // 결제액 clamp — 구조상 도달하지 않지만 돈이 움직이는 계산이라 여기서도 막는다(DB CHECK 와 이중 방어)
  const refundAmount = Math.min(ceilMulDiv(paidAmount, refundRateBp, BASIS_POINT_DENOMINATOR), paidAmount);

  return Object.freeze({
    refundAmount,
    refundRateBp,
    hoursBeforeStart: floorDiv(secondsBeforeStart, SECONDS_PER_HOUR),
    secondsBeforeStart,
    appliedTierHours,
  });
}

/** from → to 까지의 초. 초 미만은 음의 무한대 쪽으로 버린다(옛 `timedelta // 1초` 와 같다) */
function secondsBetween(from: Temporal.Instant, to: Temporal.Instant): number {
  const diffNs = to.epochNanoseconds - from.epochNanoseconds;
  const truncated = diffNs / NANOSECONDS_PER_SECOND; // BigInt 나눗셈은 0 쪽으로 버린다
  const floored = diffNs % NANOSECONDS_PER_SECOND < BigInt(0) ? truncated - BigInt(1) : truncated;
  return Number(floored);
}

/** 정수 바닥 나눗셈(음수도 음의 무한대 쪽). 두 인자 모두 정수일 때만 쓴다 */
function floorDiv(a: number, b: number): number {
  const remainder = a % b;
  const quotient = (a - remainder) / b; // 나누어떨어지므로 정확한 정수
  return remainder < 0 ? quotient - 1 : quotient;
}

/**
 * 24시간 미만 구간의 환불율을 비율표에서 고른다. 순서에 기대지 않고, hours 가 겹치면 먼저 나온 것을 쓴다.
 * 맞는 티어가 없으면 0%.
 */
function resolveTier(tiers: readonly unknown[], secondsBeforeStart: number): [number, number | null] {
  if (!Array.isArray(tiers)) {
    throw new TypeError(`tiers 는 배열이어야 한다: ${tiers === null ? "null" : typeof tiers}`);
  }

  let bestHours: number | null = null;
  let bestRateBp = NO_REFUND_RATE_BP;

  tiers.forEach((tier, index) => {
    const { hours, rateBp } = parseTier(tier, index);
    if (secondsBeforeStart > hours * SECONDS_PER_HOUR) {
      return;
    }
    if (bestHours === null || hours < bestHours) {
      bestHours = hours;
      bestRateBp = rateBp;
    }
  });

  return [bestRateBp, bestHours];
}

/** JSONB 는 DB 가 구조를 검증해 주지 않는다 — 티어 한 줄을 여기서 검증한다(§4.4) */
function parseTier(tier: unknown, index: number): { hours: number; rateBp: number } {
  if (typeof tier !== "object" || tier === null || Array.isArray(tier)) {
    throw new TypeError(`tiers[${index}] 는 객체여야 한다: ${tier === null ? "null" : typeof tier}`);
  }
  const record = tier as Record<string, unknown>;
  const hours = requireInteger(record, "hours_before_start", index);
  const rateBp = requireInteger(record, "refund_rate_bp", index);

  if (hours < MIN_TIER_HOURS || hours > MAX_TIER_HOURS) {
    throw new RangeError(
      `tiers[${index}].hours_before_start 는 ${MIN_TIER_HOURS}~${MAX_TIER_HOURS} 범위여야 한다: ${hours}`,
    );
  }
  if (rateBp < NO_REFUND_RATE_BP || rateBp > FULL_REFUND_RATE_BP) {
    throw new RangeError(
      `tiers[${index}].refund_rate_bp 는 ${NO_REFUND_RATE_BP}~${FULL_REFUND_RATE_BP} 범위여야 한다: ${rateBp}`,
    );
  }
  return { hours, rateBp };
}

function requireInteger(record: Record<string, unknown>, key: string, index: number): number {
  if (!Object.hasOwn(record, key)) {
    throw new RangeError(`tiers[${index}] 에 ${key} 가 없다`);
  }
  const value = record[key];
  // typeof 검사가 boolean·문자열 숫자를 거른다(옛 코드의 bool 제외와 같은 뜻)
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`tiers[${index}].${key} 는 정수여야 한다: ${String(value)}`);
  }
  return value;
}

/** 옛 tz-naive 거부 자리. Instant 가 아닌 값(시간대 없는 PlainDateTime 등)을 거부한다 */
function requireInstant(value: unknown, name: string): void {
  if (!(value instanceof Temporal.Instant)) {
    throw new TypeError(`${name} 은 Temporal.Instant 여야 한다(시간대 없는 시각 거부)`);
  }
}
