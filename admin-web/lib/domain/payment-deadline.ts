// T-M3-3(결제 기한 산정) — 공유 계약 §4.3(산정 함수 시그니처) · FR-285(결제 기한) · 전제 18(결제 기한 기본값)
//
// 규칙(03-checkout-payment.md §4):
//   card            → 발급(주문) 시각 + PAYMENT_CARD_DEADLINE_MINUTES(기본 15분)
//   easy_pay · easy_transfer → 카드와 같은 결제창 기한(S3-3.4(주문 생성 API)에서 더함).
//                     spec FR-285 표가 간편 계좌이체를 「결제 창을 연 뒤 정해진 몇 분」으로 적었다. 간편결제는 표에 없지만
//                     같은 결제창 수단이라 같은 규칙을 쓴다 — 플랜 S3-3 열린 점 「카드 결제 기한 15분이 간편결제에도 맞는지」의 사후 확인 대상
//   virtual_account → min(발급 시각 + PAYMENT_VA_DEADLINE_HOURS(기본 24시간),
//                         첫 회차 시작 − PAYMENT_VA_CUTOFF_MINUTES(기본 60분))
//
// 순간(`Temporal.Instant`)끼리의 계산이라 시간대가 끼지 않는다 — R8(기한 계산 시간대) 대응.
// `computeDueAt` 은 순수 함수다. 환경 변수 읽기는 `loadDeadlineConfig` 로 분리했고,
// 호출자가 설정 객체를 주입한다.
//
// 기한이 이미 지났는지(예: 가상계좌인데 첫 회차가 1시간 안)는 여기서 판정하지 않는다.
// 계산값을 그대로 돌려주고, 주문 생성 5단계(03-checkout-payment.md §1)가
// `dueAt <= now` 이면 409 `CHECKOUT_CLOSED` 로 막는다(만료 정리 §5 의 `due_at <= now` 와 같은 경계).
import "./time";

import type { PaymentMethod } from "./constants";

/** 결제 기한 설정 — 전제 18(결제 기한 기본값). 값은 모두 양의 정수 */
export interface DeadlineConfig {
  readonly cardDeadlineMinutes: number;
  readonly virtualAccountDeadlineHours: number;
  readonly virtualAccountCutoffMinutes: number;
}

/** 전제 18 기본값 — 03-checkout-payment.md §4 표 그대로 */
export const DEFAULT_DEADLINE_CONFIG: DeadlineConfig = Object.freeze({
  cardDeadlineMinutes: 15,
  virtualAccountDeadlineHours: 24,
  virtualAccountCutoffMinutes: 60,
});

/** 환경 변수 이름 — 03-checkout-payment.md §4 */
const ENV_KEYS = {
  cardDeadlineMinutes: "PAYMENT_CARD_DEADLINE_MINUTES",
  virtualAccountDeadlineHours: "PAYMENT_VA_DEADLINE_HOURS",
  virtualAccountCutoffMinutes: "PAYMENT_VA_CUTOFF_MINUTES",
} as const satisfies Record<keyof DeadlineConfig, string>;

const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

function readPositiveInteger(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new RangeError(`${key} 는 양의 정수여야 한다: "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${key} 값이 너무 크다: "${raw}"`);
  }
  return value;
}

/**
 * 환경 변수에서 결제 기한 설정을 읽는다. 비었거나 없으면 기본값, 형식이 틀리면 RangeError.
 * 기본 인자로 `process.env` 를 읽지만, 테스트는 객체를 직접 넘긴다.
 */
export function loadDeadlineConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeadlineConfig {
  return {
    cardDeadlineMinutes: readPositiveInteger(env, ENV_KEYS.cardDeadlineMinutes, DEFAULT_DEADLINE_CONFIG.cardDeadlineMinutes),
    virtualAccountDeadlineHours: readPositiveInteger(
      env,
      ENV_KEYS.virtualAccountDeadlineHours,
      DEFAULT_DEADLINE_CONFIG.virtualAccountDeadlineHours,
    ),
    virtualAccountCutoffMinutes: readPositiveInteger(
      env,
      ENV_KEYS.virtualAccountCutoffMinutes,
      DEFAULT_DEADLINE_CONFIG.virtualAccountCutoffMinutes,
    ),
  };
}

/** 공유 계약 §4.3 — `computeDueAt` 입력 */
export interface ComputeDueAtInput {
  readonly method: PaymentMethod;
  readonly issuedAt: Temporal.Instant;
  readonly firstSessionStartsAt: Temporal.Instant;
  readonly config: DeadlineConfig;
}

/**
 * 공유 계약 §4.3 — 수단별 결제 기한(FR-285(결제 기한)).
 * 가상계좌에서 두 기한이 같은 순간이면 그 순간을 돌려준다.
 */
export function computeDueAt(input: ComputeDueAtInput): Temporal.Instant {
  const { method, issuedAt, firstSessionStartsAt, config } = input;

  // 가상계좌만 「발급 + 24시간 vs 첫 회차 − 60분」이고, 결제창으로 결제하는 나머지 셋(카드·간편결제·간편 계좌이체)은 창 기한이다.
  // 예전에는 card 만 창 기한이고 나머지를 모두 가상계좌로 봤는데, 수단이 4종이 되면서 간편 수단이 24시간을 받는 틈이 생겨 고쳤다.
  if (method !== "virtual_account") {
    return issuedAt.add({ minutes: config.cardDeadlineMinutes });
  }

  // Instant.add 는 시·분·초 단위만 받는다(날짜 단위는 시간대가 필요하다) — 24시간은 hours 로 더한다
  const byIssue = issuedAt.add({ hours: config.virtualAccountDeadlineHours });
  const byFirstSession = firstSessionStartsAt.subtract({ minutes: config.virtualAccountCutoffMinutes });
  return Temporal.Instant.compare(byFirstSession, byIssue) < 0 ? byFirstSession : byIssue;
}
