// S3-3.1(결제수단 판정 함수) — FR-280(결제수단 결정) · FR-111(상품별 기본 결제수단) · FR-111a(카드 허용 범위)
//
// 상품(수업 구분)을 넣으면 「고를 수 있는 수단」과 「기본 수단」을 돌려주는 순수 함수다.
// 결제 화면은 이 목록만 보여 주고(FR-281), 주문 생성 서버는 목록 밖 수단을 거부하고(FR-111a 강제 방법 ②),
// 결제 통지 처리는 이벤트형 카드 승인을 전액 취소한다(강제 방법 ③). 세 곳이 같은 표를 보도록 한곳에 둔다.
//
// 규칙(spec FR-280 표, 2026-11-10 사용자 결정):
//   정규·단기(베이직·레이디 스타일)·개인 레슨 → 카드(기본) · 간편결제 · 간편 계좌이체 · 가상계좌
//   이벤트형(원데이·이벤트·파티·공연·대회)   → 간편 계좌이체(기본) · 가상계좌만
//     왜: 카드 수수료 문제로 이벤트형은 계좌이체를 기본이자 필수로 둔다.
//
// 이 함수가 다루지 않는 것: 0원 신청(결제 없이 확정 — 금액을 보는 주문 생성 쪽 몫),
// 멤버십(계좌 자동이체 같은 별도 수단 — 멤버십 슬라이스 몫), 외부 예매 공연(결제 없음).
import { isEventClassKind } from "./class-registration";
import type { ClassKind, PaymentMethod } from "./constants";

/** 한 상품의 결제수단 판정 결과. `allowed[0]` 이 늘 `defaultMethod` 다 — 화면이 첫 줄을 기본 선택으로 그린다 */
export interface PaymentMethodRule {
  readonly allowed: readonly PaymentMethod[];
  readonly defaultMethod: PaymentMethod;
}

// 표 두 줄을 미리 얼려 둔다. 호출자가 목록을 고쳐 다른 요청의 판정이 바뀌는 일을 막는다.
// 순서는 spec 표에 적힌 순서 그대로(기본 수단이 맨 앞).
const CARD_FIRST_RULE: PaymentMethodRule = Object.freeze({
  allowed: Object.freeze(["card", "easy_pay", "easy_transfer", "virtual_account"] as const),
  defaultMethod: "card",
});

const TRANSFER_ONLY_RULE: PaymentMethodRule = Object.freeze({
  allowed: Object.freeze(["easy_transfer", "virtual_account"] as const),
  defaultMethod: "easy_transfer",
});

/**
 * 수업 구분 → 고를 수 있는 수단과 기본 수단.
 * 갈림길은 하나뿐이다 — 이벤트형이면 계좌 수단 둘, 아니면 네 수단 모두(카드가 기본).
 * 이벤트형 판정은 수업 등록이 쓰는 `isEventClassKind` 를 그대로 써서 두 곳의 「이벤트형」 정의가 갈리지 않게 한다.
 */
export function paymentMethodsFor(classKind: ClassKind): PaymentMethodRule {
  return isEventClassKind(classKind) ? TRANSFER_ONLY_RULE : CARD_FIRST_RULE;
}

/** 이 수업에서 이 수단으로 결제할 수 있나. 주문 생성이 거부 여부를 정할 때 쓴다 */
export function isPaymentMethodAllowed(classKind: ClassKind, method: PaymentMethod): boolean {
  return paymentMethodsFor(classKind).allowed.includes(method);
}
