/**
 * 대표 앱 주문·결제 찾기(보드 O45) — 경로 · 응답 모양 · 화면 글자. S3-5.9c(대표 앱 현장 등록·주문 화면).
 *
 * 부르는 경로(계약 18 §2 — 관리자 웹 W10 과 같은 경로·같은 규칙)
 *   GET /api/academies/{academyId}/orders?status=&q=&from=&to=&cursor=     주문 목록(최신순, 쪽 넘김)
 *   GET /api/academies/{academyId}/orders/{orderId}                         한 주문의 결제·환불 이력(줄을 누르면 펼침)
 *
 * 칩은 서버 값 묶음이다(계약 §2-1): 「결제 완료」 = paid · 「입금 대기」 = pending · 「환불」 = partially_refunded,refunded.
 * 서버에 칩 이름을 만들지 않고, 앱이 status 값으로 바꿔 보낸다.
 *
 * 「찾기」 화면이라 기간을 이번 달로 좁히지 않고 오늘부터 1년 전까지 본다(서버 상한 366일).
 * 다른 파일을 런타임에 불러오지 않는다 — admin-web 단위 테스트가 이 파일을 그대로 불러 쓴다.
 */

export type OwnerOrderStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'partially_refunded' | 'refunded';
export type OwnerPaymentMethod = 'card' | 'easy_pay' | 'easy_transfer' | 'virtual_account';

export interface OwnerOrder {
  orderId: string;
  createdAt: string;
  member: { memberId: string; nickname: string };
  class: { classId: string; offeringId: string; title: string; kindLabel: string; classKind: string };
  amount: number;
  method: OwnerPaymentMethod;
  status: OwnerOrderStatus;
  paidAt: string | null;
  dueAt: string | null;
  refundRequest: { requestId: string; status: 'received' | 'in_progress'; kind: string } | null;
}

export interface OwnerOrderList {
  items: OwnerOrder[];
  nextCursor: string | null;
}

export interface OrderTimelineItem {
  at: string;
  kind: string;
  label: string;
  detail: string | null;
  amount: number | null;
}

export interface OwnerOrderDetail {
  orderId: string;
  status: OwnerOrderStatus;
  amount: number;
  refundedAmount: number;
  timeline: OrderTimelineItem[];
}

// ---- 칩 · 주소 ---------------------------------------------------------------------------------

export type OrderChip = 'all' | 'paid' | 'pending' | 'refund';

export const ORDER_CHIPS: readonly { key: OrderChip; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'paid', label: '결제 완료' },
  { key: 'pending', label: '입금 대기' },
  { key: 'refund', label: '환불' },
];

/** 칩 → 서버 status 값(쉼표). 「전체」는 거르지 않는다 */
const CHIP_STATUS: Readonly<Record<OrderChip, string | null>> = {
  all: null,
  paid: 'paid',
  pending: 'pending',
  refund: 'partially_refunded,refunded',
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 찾는 기간 — 오늘 포함 366일(서버 상한과 같다). 그 앞 주문은 관리자 웹에서 기간을 골라 본다 */
const SEARCH_DAYS = 366;

/** KST 달력 날짜 「2026-11-24」 */
function kstDateKey(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 목록 주소. 검색어는 앞뒤 공백을 자르고, 비었으면 보내지 않는다.
 * from·to 는 now 로 계산해 넣는다 — 서버 기본값(이번 달)으로는 지난달 주문을 찾을 수 없어서다.
 */
export function ownerOrdersPath(academyId: string, chip: OrderChip, q: string, now: Date, cursor: string | null = null): string {
  const params: string[] = [
    `from=${kstDateKey(new Date(now.getTime() - (SEARCH_DAYS - 1) * DAY_MS))}`,
    `to=${kstDateKey(now)}`,
  ];
  const status = CHIP_STATUS[chip];
  if (status !== null) params.push(`status=${status}`);
  const text = q.trim();
  if (text !== '') params.push(`q=${encodeURIComponent(text)}`);
  if (cursor !== null) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `/api/academies/${encodeURIComponent(academyId)}/orders?${params.join('&')}`;
}

export function ownerOrderDetailPath(academyId: string, orderId: string): string {
  return `/api/academies/${encodeURIComponent(academyId)}/orders/${encodeURIComponent(orderId)}`;
}

// ---- 줄 글자 -----------------------------------------------------------------------------------

/** 정수에 세 자리 쉼표 + 원 — 「160,000원」 */
export function won(amount: number): string {
  return `${String(Math.trunc(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

/** 결제 수단 글자 — 보드 O45 「신용카드 · 간편 계좌이체 · 가상계좌」 */
const METHOD_LABELS: Readonly<Record<OwnerPaymentMethod, string>> = {
  card: '신용카드',
  easy_pay: '간편결제',
  easy_transfer: '간편 계좌이체',
  virtual_account: '가상계좌',
};

/** 상태 글자 — FR-298(주문 상태 6종)을 대표 쪽 말로 */
const STATUS_LABELS: Readonly<Record<OwnerOrderStatus, string>> = {
  pending: '입금 대기',
  paid: '결제 완료',
  partially_refunded: '부분 환불',
  refunded: '환불 완료',
  expired: '입금 기한 지남',
  cancelled: '입금 전 취소',
};

export type OrderTone = 'accent' | 'danger' | 'muted';

/** 「11/14」 — KST 월/일 */
function monthDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * 줄 오른쪽 아래 한 줄 — 「신용카드 · 결제 완료」 「가상계좌 · 입금 대기 (11/14까지)」 「신용카드 · 환불 요청」.
 * 처리 전 환불 요청이 있으면 상태보다 그것을 먼저 보인다(대표가 할 일이라서).
 * 색: 입금 대기는 빨강(기한이 있는 일), 만료·취소는 흐리게, 나머지는 강조색.
 */
export function orderStatusLine(order: OwnerOrder): { text: string; tone: OrderTone } {
  const method = METHOD_LABELS[order.method] ?? order.method;
  if (order.refundRequest !== null) return { text: `${method} · 환불 요청`, tone: 'accent' };
  const label = STATUS_LABELS[order.status] ?? order.status;
  if (order.status === 'pending') {
    const due = order.dueAt === null ? '' : ` (${monthDay(order.dueAt)}까지)`;
    return { text: `${method} · ${label}${due}`, tone: 'danger' };
  }
  if (order.status === 'expired' || order.status === 'cancelled') return { text: `${method} · ${label}`, tone: 'muted' };
  return { text: `${method} · ${label}`, tone: 'accent' };
}

/** 줄 왼쪽 아래 — 「바차타 센슈얼 입문 · 정규 4주」 */
export function orderClassLine(order: OwnerOrder): string {
  return order.class.kindLabel === '' ? order.class.title : `${order.class.title} · ${order.class.kindLabel}`;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 이력 한 줄 — 왼쪽 「11/12 (목)」, 가운데 글자, 오른쪽 금액·상태(없으면 「—」) */
export function timelineRow(item: OrderTimelineItem): { date: string; label: string; right: string } {
  const d = new Date(new Date(item.at).getTime() + KST_OFFSET_MS);
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEKDAYS[d.getUTCDay()]})`;
  const right = item.amount !== null ? won(item.amount) : item.detail ?? '—';
  return { date, label: item.label, right };
}
