// S7-1.6(발송 재시도 작업) — 알림 발송이 실패했을 때 「언제 다시 보낼지, 아니면 끝낼지」를 정하는 순수 함수.
//   계약: _workspace/03_contracts/15-ops.md §1-4 retry · §1-5 수용 ④ · 열린 점 ③(횟수·간격 임시 확정)
//
// 규칙 한 줄: 시도는 처음 포함 최대 3번이고, 1번째 실패 뒤 1분, 2번째 실패 뒤 5분을 기다린다. 3번째도 실패하면 `failed`.
// DB 도, 시계도 부르지 않는다 — 「지금」과 「몇 번째 시도였나」를 받아 결정만 돌려준다(경계 값을 단위 테스트로 고정하려고).
// time.ts 를 먼저 불러 전역 Temporal(폴리필)을 깐다 — 아래 상수가 모듈을 읽는 순간 Temporal 을 쓰기 때문이다.
import "./time";

/** 처음 보내기를 포함한 최대 시도 횟수 */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** n 번째 시도가 실패한 뒤 기다릴 시간(n = 1, 2). 길이는 MAX_DELIVERY_ATTEMPTS - 1 */
export const RETRY_DELAYS: readonly Temporal.Duration[] = [Temporal.Duration.from({ minutes: 1 }), Temporal.Duration.from({ minutes: 5 })];

/**
 * 선점(`sending`)한 채로 이만큼 지나도 결과가 안 적힌 행은 「발송 중 서버가 멈춘」 것으로 보고 실패 1번으로 센다.
 * 정상 발송은 몇 초면 끝난다(가짜·실제 Expo 모두). 너무 짧으면 느린 발송을 두 번 보낼 수 있어 넉넉히 잡았다.
 */
export const STALE_SENDING_AFTER = Temporal.Duration.from({ minutes: 10 });

export type RetryDecision =
  | { readonly kind: "retry"; readonly nextAttemptAt: Temporal.Instant }
  | { readonly kind: "failed" };

/**
 * attemptCount 번째 시도가 방금 실패했다 → 다음에 할 일.
 * attemptCount 는 이번 시도까지 센 값(1부터)이다. 0 이하는 1번째로 본다.
 */
export function decideAfterFailure(attemptCount: number, failedAt: Temporal.Instant): RetryDecision {
  const attempt = Math.max(1, Math.trunc(attemptCount));
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return { kind: "failed" };
  // attempt 는 1 또는 2 — 배열 범위 안이다
  const delay = RETRY_DELAYS[attempt - 1] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1]!;
  return { kind: "retry", nextAttemptAt: failedAt.add(delay) };
}
