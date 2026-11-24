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

/**
 * 결제수단 4종(계약 03 §1, 서버 `admin-web/lib/domain/constants.ts` 의 PAYMENT_METHODS).
 * 카드·간편결제·간편 계좌이체는 PG 결제창에서 승인되고, 가상계좌만 입금을 기다린다.
 */
export type PaymentMethod = 'card' | 'easy_pay' | 'easy_transfer' | 'virtual_account';

/** 수업 구분 9종(FR-051(수업 구분)). 서버가 새 값을 더해도 화면이 깨지지 않게 문자열도 받는다. */
export type ClassKind =
  | 'regular'
  | 'private_lesson'
  | 'basic'
  | 'lady_style'
  | 'one_day'
  | 'event'
  | 'party'
  | 'performance'
  | 'competition'
  | (string & {});

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
  classKind: ClassKind;
  academy: Academy;
  label: string;
  enrollmentUnit: string;
  sessionCount: number;
  firstSessionStartsAt: string;
  lastSessionEndsAt: string;
  priceAmount: number;
  capacity: Capacity;
}

/**
 * 홈 목록 정렬 3종(S3-2.2(시간대 필터·정렬), 계약 02 §1 「정렬」 줄). 거리·인기순은 아직 없다 —
 * 거리는 지도 API 무료 구간 확인 전, 인기순은 S6-2 에서 정한다(2026-11-23 사용자 결정).
 */
export type HomeSort = 'recommended' | 'deadline' | 'seats';

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

/**
 * 판매자 정보 6항목(S3-2.4(판매자 정보·결제 전 정책), 계약 02 §2 `seller`). 법정 표시 칸이라 전부 공개다.
 * 사업자등록번호는 숫자 10자리로 온다 — 화면이 「123-45-67890」 모양으로 바꾼다.
 */
export interface SellerInfo {
  businessName: string;
  representativeName: string;
  businessRegistrationNumber: string;
  /** 통신판매업 신고번호. 신고 전이면 null */
  mailOrderReportNumber: string | null;
  businessAddress: string;
  phone: string;
}

/** `GET /api/offerings/{offeringId}` */
export interface OfferingDetail {
  offeringId: string;
  title: string;
  academy: Academy;
  instructorName: string;
  /** 담당 강사 계정 id — 강사 프로필(M15)로 가는 길(SX-5.7). 옛 서버·담당 미정이면 없음 */
  instructorId?: string | null;
  label: string;
  sessions: readonly SessionTime[];
  priceAmount: number;
  seatMode: 'gender_split' | 'single';
  capacity: Capacity;
  seatSelection: { defaultSeatKind: SeatKind; options: readonly SeatOption[] };
  seller: SellerInfo;
  /** 학원이 공지를 안 썼으면 null — 그때 주문은 409 NOTICE_MISSING(FR-282(결제 화면 필수 표시)). */
  refundNotice: { versionId: string; body: string } | null;
  intermediaryNotice: { version: string; body: string };
  /**
   * 수업 구분(S3-3.15b(결제 화면용 서버 조각)). 결제 화면이 고를 수 있는 수단을 정할 때 쓴다 — 이벤트형은 계좌이체만(FR-280).
   * 옛 서버 응답에는 없을 수 있어 선택 칸으로 둔다.
   */
  classKind?: ClassKind;
  /**
   * 결제 전 가격 내역(S3-3.15b). 주문 생성과 같은 계산 함수의 결과라 결제 시작 응답의 `priceBreakdown` 과 같다.
   * 없으면(옛 서버) 결제 버튼을 닫아 둔다 — 앱이 금액을 스스로 계산하지 않는다.
   */
  priceBreakdownPreview?: readonly PriceLine[];
  /** 계약 예시는 null 뿐이고 서버도 아직 안 보낸다. 모양이 정해지지 않아 「있다/없다」로만 쓴다. */
  myReservation?: unknown;
}

/** FR-298(주문 상태 6종) 중 이 화면이 다루는 값. 모르는 값도 문자열로 받는다. */
export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'expired'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded'
  | (string & {});

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
  /** 결석 예정 토글이 부르는 회차 id(계약 04 §4-1). 옛 서버라 없으면 토글을 그리지 않는다. */
  sessionId?: string;
  sessionSeq: number;
  title: string;
  academyName: string;
  startsAt: string;
  endsAt: string;
  /** 살아 있는 결석 행. 없으면 null(=참석). 옛 서버면 칸 자체가 없다(계약 04 §4-1). */
  absence?: CalendarAbsence | null;
}

/** 결석 표시를 한 사람의 역할 — 회원 본인 · 강사 · 대표(이름은 내리지 않는다, 계약 04 열린 점 ③). */
export type AbsenceMarkedBy = 'member' | 'instructor' | 'owner' | (string & {});

/** `GET /api/me/calendar` 한 줄의 `absence` 칸(계약 04 §4-1). */
export interface CalendarAbsence {
  markId: string;
  markedByKind: AbsenceMarkedBy;
  disputeStatus: string;
  /** 내가 켠 결석이고 수업 시작 전일 때만 true — 서버가 계산한다(§5 와 같은 규칙). */
  canToggle: boolean;
}

/** `PUT /api/me/sessions/{sessionId}/absence` 응답(계약 04 §5). */
export interface AbsenceMark {
  markId: string;
  sessionId: string;
  reservationId: string;
  markedByKind: AbsenceMarkedBy;
  markedAt: string;
  disputeStatus: string;
  canToggle: boolean;
}

/** `GET /api/me/orders` 한 줄(계약 04 §9). 상태 글자는 앱이 만든다. */
export interface MyOrder {
  orderId: string;
  status: OrderStatus;
  offeringId: string;
  title: string;
  academyName: string;
  seatKind: SeatKind;
  method: PaymentMethod;
  totalAmount: number;
  refundedAmount: number;
  createdAt: string;
  paidAt: string | null;
  dueAt: string | null;
  receipt: { academyUrl: string | null; companyUrl: string | null; cashReceiptIssued: boolean };
}

/** `GET /api/me/notifications` 한 줄(계약 04 §2). payload 모양은 종류마다 다르다. */
export interface MemberNotification {
  id: string;
  kind: string;
  createdAt: string;
  readAt: string | null;
  orderId: string | null;
  payload: Readonly<Record<string, unknown>>;
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
