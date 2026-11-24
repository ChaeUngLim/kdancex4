/**
 * 결제 화면이 쓰는 규칙 — 어떤 수단을 보여 주나, 수단 이름은 무엇인가(보드 M9·M9N·M9E).
 *
 * 수단 표의 원본은 서버 `admin-web/lib/domain/payment-methods.ts`(S3-3.1(결제수단 판정 함수))다.
 * 앱은 서버에서 그 표를 받지 않고 `classKind` 만 받으므로, 같은 표를 여기 옮겨 적는다.
 * 앱이 틀린 수단을 보내도 서버가 422 `METHOD_NOT_ALLOWED` 로 막으니(계약 03 §1 3-b) 돈이 잘못 나가지는 않는다 —
 * 이 표는 회원이 「고를 수 없는 수단」을 처음부터 안 보게 하려는 것이다.
 *
 * 규칙(spec FR-280(결제수단 결정) 표, 2026-11-10 사용자 결정):
 *   정규·단기·개인 레슨 → 카드(기본) · 간편결제 · 간편 계좌이체 · 가상계좌
 *   이벤트형(원데이·이벤트·파티·공연·대회) → 간편 계좌이체(기본) · 가상계좌만 — 카드 수수료 때문에 계좌이체를 기본이자 필수로 둔다
 */
import type { ClassKind, PaymentMethod } from './types';

/** 이벤트형 수업 구분 5종 — 서버 EVENT_CLASS_KINDS 와 같은 목록 */
const EVENT_CLASS_KINDS: readonly string[] = ['one_day', 'event', 'party', 'performance', 'competition'];

const CARD_FIRST: readonly PaymentMethod[] = ['card', 'easy_pay', 'easy_transfer', 'virtual_account'];
const TRANSFER_ONLY: readonly PaymentMethod[] = ['easy_transfer', 'virtual_account'];

export function isEventClassKind(kind: ClassKind | undefined): boolean {
  return kind !== undefined && EVENT_CLASS_KINDS.includes(kind);
}

/** 고를 수 있는 수단. 첫 줄이 기본 선택이다(서버 표와 같은 순서) */
export function paymentMethodsFor(kind: ClassKind | undefined): readonly PaymentMethod[] {
  return isEventClassKind(kind) ? TRANSFER_ONLY : CARD_FIRST;
}

/**
 * 결제창에서 바로 승인되는 수단인가. 가상계좌만 「입금을 기다린다」.
 * 결제 대기 화면이 입금 안내(M9C)와 결제창 승인 대기 중 무엇을 그릴지 이 값으로 고른다.
 */
export function isWindowMethod(method: PaymentMethod | string | undefined): boolean {
  return method === 'card' || method === 'easy_pay' || method === 'easy_transfer';
}

/** 수단 한 줄에 보이는 이름과 확정 시점(보드 M9 「즉시 확정」 · 「입금 확인 뒤 확정」) */
export const METHOD_TEXT: Readonly<Record<PaymentMethod, { name: string; when: string }>> = {
  card: { name: '신용·체크카드', when: '즉시 확정' },
  easy_pay: { name: '간편결제', when: '즉시 확정' },
  easy_transfer: { name: '간편 계좌이체', when: '즉시 확정' },
  virtual_account: { name: '가상계좌', when: '입금 확인 뒤 확정' },
};

export function methodName(method: PaymentMethod | string | undefined): string {
  return method !== undefined && method in METHOD_TEXT ? METHOD_TEXT[method as PaymentMethod].name : '결제수단 확인 중';
}
