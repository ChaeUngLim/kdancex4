/**
 * 내 예약 · 결제 내역(보드 M16 · FR-298(주문 상태 6종) · 계약 04 §9)의 화면 계산.
 *
 * 서버는 주문 상태를 6종 값 그대로 준다(`pending` 등). 사람이 읽는 글자(「입금 대기」)와
 * 태그 색, 어느 탭·묶음에 넣을지는 앱이 여기서 정한다 — 계약이 「화면 글자는 앱이 만든다」고 했다.
 */
import type { MyOrder, OrderStatus, PaymentMethod } from '../catalog/types';

/** 태그 색 종류 — ui.tsx 의 shared.tagOk·tagWarn·tagDanger·tagClosed 에 맞춘다. */
export type StatusTone = 'ok' | 'warn' | 'danger' | 'closed';

const STATUS_LABELS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  pending: { label: '입금 대기', tone: 'warn' },
  paid: { label: '결제완료', tone: 'ok' },
  partially_refunded: { label: '부분 환불', tone: 'warn' },
  refunded: { label: '환불 완료', tone: 'closed' },
  expired: { label: '입금 기한 지남', tone: 'closed' },
  cancelled: { label: '입금 전 취소', tone: 'closed' },
};

/** 상태 값 → 태그 글자·색. 모르는 값(서버가 늘린 상태)은 값 그대로 회색으로 보인다. */
export function orderStatusLabel(status: OrderStatus): { label: string; tone: StatusTone } {
  return STATUS_LABELS[status] ?? { label: status, tone: 'closed' };
}

const METHOD_LABELS: Readonly<Record<string, string>> = {
  card: '카드',
  easy_pay: '간편결제',
  easy_transfer: '간편 계좌이체',
  virtual_account: '계좌이체',
};

export function paymentMethodLabel(method: PaymentMethod): string {
  return METHOD_LABELS[method] ?? method;
}

/** 「지난 주문」 한 줄로 접는 상태 — 만료·입금 전 취소(보드 M16). 전액 환불도 수업과 끊겼으므로 같이 접는다. */
const PAST_STATUSES: readonly string[] = ['expired', 'cancelled', 'refunded'];

/**
 * 「예약」 탭 목록을 둘로 나눈다. 서버가 준 순서(최신순)는 그대로 둔다.
 * 모르는 상태는 숨기지 않고 펼친 쪽에 둔다 — 사라진 주문처럼 보이면 안 된다.
 */
export function splitReservationTab(orders: readonly MyOrder[]): { active: MyOrder[]; past: MyOrder[] } {
  return {
    active: orders.filter((o) => !PAST_STATUSES.includes(o.status)),
    past: orders.filter((o) => PAST_STATUSES.includes(o.status)),
  };
}

/** 「결제·환불 내역」 탭에서 금액 줄 — 환불이 있으면 「결제 30,000원 · 환불 15,000원」처럼 둘 다 보인다. */
export function hasRefund(order: MyOrder): boolean {
  return order.refundedAmount > 0;
}
