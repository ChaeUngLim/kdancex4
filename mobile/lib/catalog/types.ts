/**
 * 홈·상세·결제 대기·캘린더·취소 화면이 받는 API 응답 타입.
 *
 * 원본은 Phase 3(구현 계획) 계약 문서다. 여기 적은 것은 그 계약을 옮겨 적은 사본이라
 * 서버가 바뀌면 같이 고친다. 실행 중에는 검사하지 않으므로(`apiFetch<T>` 는 형 변환만 한다)
 * 화면은 값이 비어도 깨지지 않게 다룬다.
 *  - `02-catalog.md` §1·§2(홈 목록·수업 상세)
 *  - `03-checkout-payment.md` §1·§2(결제 시작·주문 조회·셀프 취소)
 *  - `04-me-calendar-notifications.md` §1(내 캘린더)
 *  - `05-cancellation-migrated.md`(이관 취소 API — 옛 Pydantic 스키마를 camelCase 로)
 */

/** FR-020(장르 4종) 영문 값. 한글 이름은 앱이 붙인다(README §3(값 형식)). */
export type Genre = 'dance_sport' | 'argentine_tango' | 'swing' | 'salsa_bachata' | (string & {});

/** 자리 종류 — FR-092(성별 정원)·FR-092c(성별 구분 없는 단일 정원). */
export type SeatKind = 'male' | 'female' | 'any';

export type PaymentMethod = 'virtual_account' | 'card';

export interface Academy {
  id: string;
  name: string;
  regionSido: string;
  regionGu: string;
}

export interface SeatPool {
  seatKind: SeatKind;
  capacity: number;
  enrolled: number;
  remaining: number;
}

export interface Capacity {
  total: number;
  enrolled: number;
  pools: readonly SeatPool[];
}

/** `GET /api/home/offerings` 의 한 줄. */
export interface OfferingSummary {
  offeringId: string;
  classId: string;
  title: string;
  genre: Genre;
  classKind: string;
  academy: Academy;
  label: string;
  enrollmentUnit: string;
  sessionCount: number;
  firstSessionStartsAt: string;
  lastSessionEndsAt: string;
  priceAmount: number;
  capacity: Capacity;
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

/** 가격 내역 한 줄 — README §3 순서 고정(FR-283(결제액 계산 순서)). */
export type PriceLineKind = 'list_price' | 'benefit_discount' | 'coupon_discount' | 'booking_fee' | 'final';

export interface PriceLine {
  kind: PriceLineKind | (string & {});
  label: string;
  amount: number;
}

export interface SessionTime {
  seq: number;
  startsAt: string;
  endsAt: string;
}

export interface SeatOption {
  seatKind: SeatKind;
  available: boolean;
  reason?: string;
}

/** `GET /api/offerings/{offeringId}` */
export interface OfferingDetail {
  offeringId: string;
  title: string;
  academy: Academy;
  instructorName: string;
  label: string;
  sessions: readonly SessionTime[];
  priceAmount: number;
  seatMode: 'gender_split' | 'single';
  capacity: Capacity;
  seatSelection: { defaultSeatKind: SeatKind; options: readonly SeatOption[] };
  /** 학원이 공지를 안 썼으면 null — 그때 주문은 409 NOTICE_MISSING(FR-282(결제 화면 필수 표시)). */
  refundNotice: { versionId: string; body: string } | null;
  intermediaryNotice: { version: string; body: string };
  priceBreakdownPreview: readonly PriceLine[];
  /** 계약 예시는 null 뿐이다. 모양이 정해지지 않아 「있다/없다」로만 쓴다(summary 「계약 모호점」). */
  myReservation: unknown;
}

/** FR-298(주문 상태 6종) 중 이 화면이 다루는 값. 모르는 값도 문자열로 받는다. */
export type OrderStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'refunded' | (string & {});

export interface OrderPayment {
  paymentId: string;
  method: PaymentMethod;
  status: string;
  amount: number;
  dueAt: string;
  virtualAccount: { bankCode: string; accountNumber: string; holder: string } | null;
  cardCheckout: { checkoutKey: string } | null;
}

/** `POST /api/orders` 응답 · `GET /api/orders/{orderId}` 응답(같은 모양). */
export interface Order {
  orderId: string;
  status: OrderStatus;
  reservationId: string;
  seatKind: SeatKind;
  priceBreakdown: readonly PriceLine[];
  payment: OrderPayment;
  refundNoticeVersionId: string;
  intermediaryNoticeVersion: string;
}

export interface CreateOrderBody {
  offeringId: string;
  seatKind: SeatKind;
  method: PaymentMethod;
  noticesAcknowledged: boolean;
}

/** `GET /api/me/calendar` 의 한 줄. */
export interface CalendarEntry {
  entryId: string;
  reservationId: string;
  offeringId: string;
  sessionSeq: number;
  title: string;
  academyName: string;
  startsAt: string;
  endsAt: string;
}

/** `GET /api/reservations/{id}/cancellation-preview` — 옛 `CancellationPreviewResponse` 의 camelCase. */
export interface CancellationPreview {
  reservationId: string;
  paymentMethod: PaymentMethod | null;
  paidAmount: number;
  refundAmount: number;
  refundRateBp: number;
  hoursBeforeStart: number;
  secondsBeforeStart: number;
  appliedTierHours: number | null;
  startsAt: string;
  cancellable: boolean;
  reasonCode: string | null;
}

export interface RefundAccountInput {
  bankCode: string;
  accountNumber: string;
  holderName: string;
}

/** `POST /api/reservations/{id}/cancel` 요청 — 옛 `CancelRequest` 의 camelCase. */
export interface CancelRequestBody {
  method?: PaymentMethod;
  refundAccount?: RefundAccountInput;
}

export type RefundStatus = 'succeeded' | 'pending' | 'failed';

/** `POST /api/reservations/{id}/cancel` 응답 — 옛 `CancelResponse` 의 camelCase. */
export interface CancelResult {
  reservationId: string;
  refundId: string;
  status: RefundStatus;
  requestedAmount: number;
  refundedAmount: number;
  refundRateBp: number;
  hoursBeforeStart: number;
  reservationStatus: string;
  slotRestored: boolean;
  replayed: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  gatewayRefundId: string | null;
}
