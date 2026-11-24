// S3-3.4(주문 생성 API) — 결제 시작(`POST /api/orders`)이 주문에 고정하는 값 가운데 「DB 를 읽지 않고 정해지는 것」.
//   계약: _workspace/03_contracts/03-checkout-payment.md §1(서버 순서) · §3(가격 계산) · data-model §6-2(주문 시점 스냅샷 칸)
//
// 왜 순수 함수로 따로 두나:
//   돈을 정하는 규칙(예매 수수료를 붙이나, 금액이 얼마인가)은 경로 처리기 안 SQL 사이에 섞이면 테스트하기 어렵다.
//   여기 모아 두면 단위 테스트가 수업 종류 9종을 표로 한 번에 확인하고, 처리기는 결과만 주문 행에 넣는다.
//
// 클라이언트가 보낸 금액은 어디에도 쓰지 않는다 — 정가는 서버가 읽은 판매 단위 가격(class_offerings.price_amount)뿐이다
// (FR-298b(결제 멱등성·금액 재계산)).
import { isEventClassKind } from "./class-registration";
import type { ClassKind, SeatKind, SeatMode } from "./constants";
import { computePriceBreakdown, type PriceLine } from "./money";

/** FR-282a(예매 수수료 2,000원) — 이벤트·원데이·파티·공연·대회 결제에 1명당 붙는 금액(플랫폼 귀속) */
export const BOOKING_FEE_PER_PERSON = 2000;

/** FR-125e(취소 수수료 5:5) — 취소 수수료 가운데 플랫폼 몫. 1bp = 0.01%, 5000 = 50% */
export const CANCEL_FEE_PLATFORM_SHARE_BP = 5000;

/**
 * 회원 이용약관 판본(orders.member_terms_version). 회원 약관 판본 표는 S7-3.1 이 만든다 — 그 전에는 판본이 없으므로
 * 「판본 없음」이라는 사실을 그대로 적는다(data-model §6-2 「1회차는 설정 상수 판본 문자열」 추천안).
 * 입점 약관(merchant_terms_version)도 그 학원의 동의 기록이 없을 때 같은 글자를 쓴다.
 */
export const TERMS_VERSION_UNRECORDED = "unversioned-beta";

/**
 * 이 수업 종류·정가에 예매 수수료를 붙이나. 붙이면 금액, 안 붙이면 undefined(가격 내역에 줄 자체가 없다).
 *   - 정규 계열(정규·베이직·레이디 스타일·개인 레슨) → 없음(FR-282a 「정규 과정·멤버십에는 붙지 않는다」)
 *   - 이벤트형 유료 → 2,000원
 *   - 이벤트형 0원 → 없음. 0원 신청은 결제가 아니라서(PG 를 부르지 않는 확정 경로, S3-3.12) 수수료만 받는 주문을 만들지 않는다
 *     — 0원 행사에 수수료를 받을지는 spec 에 적혀 있지 않아 S3-3.12 가 정한다(임시 판단, 증거에 기록)
 */
export function bookingFeeFor(classKind: ClassKind, listPrice: number): number | undefined {
  if (!isEventClassKind(classKind)) return undefined;
  return listPrice > 0 ? BOOKING_FEE_PER_PERSON : undefined;
}

/** 주문에 고정할 금액 묶음 — orders 의 금액 칸과 price_breakdown(응답 priceBreakdown 과 같은 배열) */
export interface OrderAmounts {
  readonly listPrice: number;
  readonly benefitDiscount: number;
  readonly couponDiscount: number;
  readonly bookingFee: number;
  readonly total: number;
  readonly breakdown: readonly PriceLine[];
}

/**
 * 계약 03 §3 — 정가 → 혜택 할인 → 쿠폰 → 예매 수수료 → 최종(FR-283(결제액 계산 순서)).
 * 이번 회차는 혜택·쿠폰이 늘 0 이다(쿠폰은 S6-2 가 이 자리에 끼운다). 합계는 DB `ck_orders_total_formula` 와 같은 식이다.
 */
export function computeOrderAmounts(classKind: ClassKind, listPrice: number): OrderAmounts {
  const bookingFee = bookingFeeFor(classKind, listPrice);
  const breakdown = computePriceBreakdown({ listPrice, benefitDiscount: 0, couponDiscount: 0, bookingFee });
  const final = breakdown.find((line) => line.kind === "final");
  if (final === undefined) throw new Error("가격 내역에 최종 결제액 줄이 없다");
  return Object.freeze({ listPrice, benefitDiscount: 0, couponDiscount: 0, bookingFee: bookingFee ?? 0, total: final.amount, breakdown });
}

/**
 * 고른 자리 종류가 수업의 정원 방식에 맞나(계약 03 §1 3단계 — 안 맞으면 422).
 * 성별 정원(gender_split)은 male·female 만, 단일 정원(single)은 any 만 있다(FR-092 · FR-092c).
 */
export function seatKindFitsMode(seatMode: SeatMode, seatKind: SeatKind): boolean {
  return seatMode === "single" ? seatKind === "any" : seatKind !== "any";
}
