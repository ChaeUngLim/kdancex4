// 공유 계약 §4.1(상태·구분 값 집합) · §4.2(값 소유 모듈)
//
// TS 쪽 값 집합은 이 파일 한 곳에서만 `as const` 배열로 소유한다. 다른 모듈은 문자열을
// 직접 쓰지 말고 여기서 import 한다. 값은 `_workspace/03_data-model.md` §3 표를 그대로 옮겼다.
// DB CHECK(계약 PSL enum)와 문자 단위로 같아야 하며, 그 대조 테스트는
// T-M2-2(값 집합 계약 일치 테스트)가 맡는다.

/** orders.status — FR-298(주문 상태 6종) */
export const ORDER_STATUSES = ["pending", "paid", "expired", "cancelled", "partially_refunded", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** payments.method */
export const PAYMENT_METHODS = ["virtual_account", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** payments.status — 옛 「paid_at IS NOT NULL = 결제 완료」 판정을 대신한다 */
export const PAYMENT_STATUSES = ["ready", "paid", "expired", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** reservations.status */
export const RESERVATION_STATUSES = ["held", "confirmed", "cancelled", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** reservations.cancel_reason — `self_cancel_unpaid` 는 FR-286(입금 전 셀프 취소) */
export const RESERVATION_CANCEL_REASONS = ["member_request", "self_cancel_unpaid"] as const;
export type ReservationCancelReason = (typeof RESERVATION_CANCEL_REASONS)[number];

/** refunds.status */
export const REFUND_STATUSES = ["succeeded", "pending", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** refunds.reason */
export const REFUND_REASONS = ["member_request"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** seat_pools.seat_kind / reservations.seat_kind — `any` 는 FR-092c(성별 구분 없는 단일 정원) */
export const SEAT_KINDS = ["male", "female", "any"] as const;
export type SeatKind = (typeof SEAT_KINDS)[number];

/** members.gender — 출처는 본인확인 */
export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];

/** genre(members.base_genre · member_interest_genres.genre · classes.genre) — FR-020(장르 4종) */
export const GENRES = ["dance_sport", "argentine_tango", "swing", "salsa_bachata"] as const;
export type Genre = (typeof GENRES)[number];

/** members.experience_level — FR-029(경험 수준 구간) 6구간 */
export const EXPERIENCE_LEVELS = [
  "entry",
  "beginner",
  "novice_intermediate",
  "intermediate",
  "advanced",
  "dancer",
] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** classes.class_kind — FR-051(수업 구분) 9종 */
export const CLASS_KINDS = [
  "regular",
  "private_lesson",
  "basic",
  "lady_style",
  "one_day",
  "event",
  "party",
  "performance",
  "competition",
] as const;
export type ClassKind = (typeof CLASS_KINDS)[number];

/** classes.seat_mode */
export const SEAT_MODES = ["gender_split", "single"] as const;
export type SeatMode = (typeof SEAT_MODES)[number];

/** class_offerings.enrollment_unit — FR-052a(회차·기간 신청 단위) */
export const ENROLLMENT_UNITS = ["term", "session"] as const;
export type EnrollmentUnit = (typeof ENROLLMENT_UNITS)[number];

/** class_offerings.status */
export const OFFERING_STATUSES = ["open", "closed"] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

/** payment_webhook_events.result */
export const WEBHOOK_EVENT_RESULTS = [
  "confirmed",
  "duplicate",
  "rejected_signature",
  "amount_mismatch",
  "deposit_on_closed_order",
  "ignored",
] as const;
export type WebhookEventResult = (typeof WEBHOOK_EVENT_RESULTS)[number];

/** payment_exceptions.kind — FR-290(금액 불일치 입금) · FR-292(만료 뒤 늦은 입금) */
export const PAYMENT_EXCEPTION_KINDS = ["amount_mismatch", "deposit_on_closed_order"] as const;
export type PaymentExceptionKind = (typeof PAYMENT_EXCEPTION_KINDS)[number];

/** payment_exceptions.status */
export const PAYMENT_EXCEPTION_STATUSES = ["refund_due"] as const;
export type PaymentExceptionStatus = (typeof PAYMENT_EXCEPTION_STATUSES)[number];

/** notifications.kind — 뒤 셋은 옛 알림 이벤트 3종을 기록으로 옮긴 것 */
export const NOTIFICATION_KINDS = [
  "payment_confirmed_member",
  "payment_confirmed_owner",
  "reservation_cancelled",
  "refund_pending",
  "refund_failed",
  "payment_refund_due",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** notifications.delivery_status — 1회차는 `pending` 으로 남는다(발송은 SCH-38(알림)) */
export const NOTIFICATION_DELIVERY_STATUSES = ["pending", "sent", "skipped"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** settlement_entries.kind — 최소형. 나머지 단계는 SCH-31(정산 원장) */
export const SETTLEMENT_ENTRY_KINDS = ["payment_hold"] as const;
export type SettlementEntryKind = (typeof SETTLEMENT_ENTRY_KINDS)[number];

/** settlement_entries.status */
export const SETTLEMENT_ENTRY_STATUSES = ["hold"] as const;
export type SettlementEntryStatus = (typeof SETTLEMENT_ENTRY_STATUSES)[number];
