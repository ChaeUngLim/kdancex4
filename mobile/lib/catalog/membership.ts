/**
 * 결제 화면의 멤버십 안내(보드 M9N) 재료 — 회원의 멤버십 상태와 3개월 멤버십 금액.
 *
 * 지금은 멤버십 API(S6-1.4)가 없다. 2026-11-23 사용자 결정대로 M3 에서는 모든 회원을 「멤버십 가입한 적 없음」으로 보고,
 * 금액은 설정값에서 읽는다. 멤버십 API 가 생기면 `readMembershipForCheckout` 한 곳의 출처만 서버 응답으로 바꾸면 된다.
 *
 * 금액 3,000원의 원본은 spec FR-112(멤버십 결제수단) 「3개월 3,000원」이다. 운영자가 바꿀 수 있는 값이라
 * 코드 여러 곳에 숫자를 적지 않고 설정 하나(`EXPO_PUBLIC_MEMBERSHIP_THREE_MONTH_PRICE`)로 둔다.
 */

/** spec FR-112 기본값. 설정이 비었거나 숫자가 아니면 이 값을 쓴다 */
const DEFAULT_THREE_MONTH_PRICE = 3000;

export type MembershipState = 'never_joined' | 'active';

export interface CheckoutMembership {
  state: MembershipState;
  /** 3개월 멤버십 금액(원). 안내 문구에만 쓰고 결제액 계산에는 쓰지 않는다 */
  threeMonthPrice: number;
}

/** 설정값을 원 단위 양의 정수로 읽는다. 이상한 값이면 기본값 */
function readThreeMonthPrice(): number {
  const raw = process.env.EXPO_PUBLIC_MEMBERSHIP_THREE_MONTH_PRICE;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_THREE_MONTH_PRICE;
}

/**
 * 결제 화면이 보여 줄 멤버십 상태. 지금은 늘 「가입한 적 없음」이다(멤버십 API 전 — S6-1.4 에서 서버 값으로 바꾼다).
 */
export function readMembershipForCheckout(): CheckoutMembership {
  return { state: 'never_joined', threeMonthPrice: readThreeMonthPrice() };
}
