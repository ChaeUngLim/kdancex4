// S4-1.3(중도 환불 금액 미리 채움 계산) — FR-294(중도 환불 계산 보조) · FR-293(대표 환불 입력)
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §1-4(`suggestRegularRefund`) · 열린 점 ⑮(시점 판정 경계)
//
// 무엇을 하나:
//   정규 과정 중도 환불 요청을 대표가 열었을 때 보여 줄 「계산 보조」를 만든다.
//     - 진행한 회차 · 남은 회차 · 회차당 금액(결제액 ÷ 총 회차)
//     - 진행 정도로 고른 공지 시점(수강 시작 전 / 1/3 지나기 전 / 1/2 지나기 전 / 1/2 지난 뒤)과 그 시점의 환불 %
//     - 미리 채울 환불 금액 = 결제액 × % (원 미만 올림)
//
// 왜 「제안값」인가: spec 은 정규 중도 환불의 최종 금액을 대표가 확정한다고 정했다(2026-11-19 사용자 결정).
// 이 함수는 공지한 기준과 다른 금액이 실수로 나가지 않게 출발점을 줄 뿐이고, 대표는 올리거나 내리거나 거절할 수 있다.
// 그래서 돌려주는 값은 화면의 입력칸을 채우는 데만 쓴다 — 이 값을 그대로 환불로 실행하지 않는다.
//
// 모든 함수는 순수 함수다 — DB·현재 시각·환경 변수를 읽지 않는다. 「요청 시각 이전에 끝난 회차 수」는 호출하는 쪽이 세어 넘긴다.
import { ceilMulDiv } from "./money";
import type { RegularRefundPoint, RegularRefundTier } from "./refund-templates";

/** 미리 채움 계산에 넣는 값(계약 §1-4 입력 그대로) */
export interface RegularRefundSuggestionInput {
  /** 결제액(`orders.total_amount`, 원 단위 정수). 정규 수업은 예매 수수료가 없다 */
  readonly paidAmount: number;
  /** 주문 스냅샷의 총 회차 수(1 이상) */
  readonly sessionsTotal: number;
  /** 요청 시각 이전에 끝난 회차 수(0 ~ 총 회차) */
  readonly sessionsElapsed: number;
  /** 주문이 가리키는 공지 판본의 시점별 환불 % */
  readonly notice: { readonly tiers: readonly RegularRefundTier[] };
}

/** 대표 화면의 계산 보조 + 미리 채움값 */
export interface RegularRefundSuggestion {
  /** 진행 정도로 고른 공지 시점 */
  readonly point: RegularRefundPoint;
  /** 그 시점에 공지한 환불 % (0~100) */
  readonly percent: number;
  /** 미리 채울 환불 금액 = 결제액 × % (원 미만 올림). 대표가 고칠 수 있는 제안값 */
  readonly suggestedAmount: number;
  /** 회차당 금액 = 결제액 ÷ 총 회차 (원 미만 올림) — 계산 근거를 보여 주는 값 */
  readonly perSessionAmount: number;
  /** 남은 회차 = 총 회차 − 진행한 회차 */
  readonly remainingSessions: number;
}

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} 는 안전 정수여야 한다: ${value}`);
  }
}

/**
 * 진행한 회차 수로 공지 시점을 고른다(계약 열린 점 ⑮ 임시 확정 — 회차 수 기준).
 *
 *   진행 0회                     → 수강 시작 전(before_start)
 *   진행 × 3 ≤ 총 회차 (1/3 이하) → 1/3 지나기 전(before_one_third)
 *   진행 × 2 ≤ 총 회차 (1/2 이하) → 1/2 지나기 전(before_half)
 *   그 밖                         → 1/2 지난 뒤(after_half)
 *
 * 경계(정확히 1/3·1/2)를 「지나기 전」 쪽에 넣는 이유: 정확히 1/3 을 들은 순간은 아직 1/3 을 「넘지」 않았다.
 * 경계를 회원에게 유리한 쪽(더 높은 %)으로 두어 법정 기준보다 덜 돌려주는 일이 없게 한다.
 * 나눗셈 대신 곱셈으로 비교해 부동소수 오차(1/3 = 0.333…)가 끼지 않게 한다.
 * 법 기준이 확정되면(Q11 ①(학원 환불 규정의 법정 하한)) 이 판정만 바꾼다.
 */
export function regularRefundPointFor(sessionsElapsed: number, sessionsTotal: number): RegularRefundPoint {
  if (sessionsElapsed === 0) return "before_start";
  if (sessionsElapsed * 3 <= sessionsTotal) return "before_one_third";
  if (sessionsElapsed * 2 <= sessionsTotal) return "before_half";
  return "after_half";
}

/**
 * 정규 과정 중도 환불의 계산 보조와 미리 채움 금액을 만든다(FR-294).
 *
 * 예: 8회 120,000원 · 3회 진행 → 남은 5회 · 회차당 15,000원 · 3×3=9 > 8 이고 3×2=6 ≤ 8 이라 「1/2 지나기 전」
 *     → 공지가 그 시점 50% 면 미리 채움 = 120,000 × 50% = 60,000원.
 *
 * - 금액 계산은 `ceilMulDiv`(BigInt 정수 연산, 원 미만 올림)만 쓴다 — FR-100(환불 정수 연산)과 같은 기조.
 *   % 가 0~100 이라 미리 채움값은 결제액을 넘지 않는다.
 * - 잘못된 입력(음수 결제액·총 회차 0·진행이 총 회차보다 큼·% 범위 밖·공지에 그 시점이 없음)은 RangeError.
 *   공지 판본은 저장 때 시점 4개를 모두 검사받으므로(S1-3.4) 시점이 빠졌다면 데이터가 깨진 것이다 — 조용히 0원을 채우지 않는다.
 */
export function suggestRegularRefund(input: RegularRefundSuggestionInput): RegularRefundSuggestion {
  const { paidAmount, sessionsTotal, sessionsElapsed, notice } = input;
  assertSafeInteger("paidAmount", paidAmount);
  assertSafeInteger("sessionsTotal", sessionsTotal);
  assertSafeInteger("sessionsElapsed", sessionsElapsed);
  if (paidAmount < 0) throw new RangeError(`결제액은 0 이상이어야 한다: ${paidAmount}`);
  if (sessionsTotal < 1) throw new RangeError(`총 회차는 1 이상이어야 한다: ${sessionsTotal}`);
  if (sessionsElapsed < 0 || sessionsElapsed > sessionsTotal) {
    throw new RangeError(`진행한 회차는 0 ~ ${sessionsTotal} 이어야 한다: ${sessionsElapsed}`);
  }

  // 진행 정도 → 공지 시점 → 그 시점에 학원이 공지한 %
  const point = regularRefundPointFor(sessionsElapsed, sessionsTotal);
  const tier = notice.tiers.find((t) => t.point === point);
  if (tier === undefined) throw new RangeError(`공지 판본에 환불 시점 ${point} 이 없다`);
  const { percent } = tier;
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`환불 % 는 0~100 정수여야 한다: ${percent}`);
  }

  return Object.freeze({
    point,
    percent,
    suggestedAmount: ceilMulDiv(paidAmount, percent, 100),
    perSessionAmount: ceilMulDiv(paidAmount, 1, sessionsTotal),
    remainingSessions: sessionsTotal - sessionsElapsed,
  });
}
