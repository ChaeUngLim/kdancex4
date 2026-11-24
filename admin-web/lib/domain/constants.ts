// 공유 계약 §4.1(상태·구분 값 집합) · §4.2(값 소유 모듈)
//
// TS 쪽 값 집합은 이 파일 한 곳에서만 `as const` 배열로 소유한다. 다른 모듈은 문자열을
// 직접 쓰지 말고 여기서 import 한다. 값은 `_workspace/03_data-model.md` §3 표를 그대로 옮겼다.
// DB CHECK(계약 PSL enum)와 문자 단위로 같아야 하며, 그 대조 테스트는
// S0-2.3(값 집합 계약 일치 테스트, tests/unit/constants-contract.test.ts)이 맡는다.

/** orders.status — FR-298(주문 상태 6종) */
export const ORDER_STATUSES = ["pending", "paid", "expired", "cancelled", "partially_refunded", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** payments.method — FR-280(결제수단 결정) 4종. 이벤트형은 easy_transfer·virtual_account 만 받는다(2026-11-10) */
export const PAYMENT_METHODS = ["virtual_account", "card", "easy_transfer", "easy_pay"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** payments.status — 옛 「paid_at IS NOT NULL = 결제 완료」 판정을 대신한다 */
export const PAYMENT_STATUSES = ["ready", "paid", "expired", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** reservations.status */
export const RESERVATION_STATUSES = ["held", "confirmed", "cancelled", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** reservations.cancel_reason — `self_cancel_unpaid` 는 FR-286(입금 전 셀프 취소), `payment_failed` 는 카드 승인 실패(M-03, S3-3.8) */
export const RESERVATION_CANCEL_REASONS = ["member_request", "self_cancel_unpaid", "payment_failed"] as const;
export type ReservationCancelReason = (typeof RESERVATION_CANCEL_REASONS)[number];

/** refunds.status */
export const REFUND_STATUSES = ["succeeded", "pending", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** refunds.reason */
export const REFUND_REASONS = ["member_request"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** 환불 원인(S4-1.5, data-model §9-6 · D21). 같은 원인으로 살아 있는 환불은 1건뿐이다(uq_refunds_basis_active) */
export const REFUND_BASIS_KINDS = ["request", "closure_choice", "bulk_item", "statutory_withdrawal"] as const;
export type RefundBasisKind = (typeof REFUND_BASIS_KINDS)[number];

/** 환불 실행 방식 — PG 부분 취소(카드·간편결제) · 대표 은행 송금(가상계좌·간편 계좌이체), FR-295 */
export const REFUND_EXECUTION_KINDS = ["pg_cancel", "owner_bank_transfer"] as const;
export type RefundExecutionKind = (typeof REFUND_EXECUTION_KINDS)[number];

/** 환불을 실행한 주체 */
export const REFUND_EXECUTED_BY = ["owner", "system_deadline", "system_bulk", "system_auto"] as const;
export type RefundExecutedBy = (typeof REFUND_EXECUTED_BY)[number];

/** refunds.reinput_reason — 계좌 환불을 「다시 입력 요청」으로 닫은 이유: 받는 사람 이름이 예금주와 다름 · 송금 반송(S4-1.5a, data-model §9-6) */
export const REFUND_REINPUT_REASONS = ["name_mismatch", "returned"] as const;
export type RefundReinputReason = (typeof REFUND_REINPUT_REASONS)[number];

// ── 환불 계좌·환불 요청(S4-1.1(환불 요청·환불 계좌 테이블), data-model §9-3·§9-6) ──
// DB CHECK 와 같은 값이다 — 한쪽만 고치면 constants-contract 테스트가 깨진다.

/** refund_accounts.status — 다시 입력하면 옛 행은 superseded, 새 행이 active */
export const REFUND_ACCOUNT_STATUSES = ["active", "superseded"] as const;
export type RefundAccountStatus = (typeof REFUND_ACCOUNT_STATUSES)[number];

/** refund_requests.kind — 정규(문의 경로) · 이벤트형(취소 신청) */
export const REFUND_REQUEST_KINDS = ["regular", "event"] as const;
export type RefundRequestKind = (typeof REFUND_REQUEST_KINDS)[number];

/** refund_requests.status — 상태 4종(접수·처리 중·완료·거절) + 철회(M-06) */
export const REFUND_REQUEST_STATUSES = ["received", "in_progress", "completed", "rejected", "withdrawn"] as const;
export type RefundRequestStatus = (typeof REFUND_REQUEST_STATUSES)[number];

/** refund_requests.reason_kind — 추천값(data-model §9-3 열린 점 ⑥) */
export const REFUND_REQUEST_REASON_KINDS = ["personal", "schedule_change", "other"] as const;
export type RefundRequestReasonKind = (typeof REFUND_REQUEST_REASON_KINDS)[number];

/** refund_requests.decision_kind — auto 는 기한 경과 자동 실행(카드분만) */
export const REFUND_REQUEST_DECISION_KINDS = ["approved", "rejected", "auto"] as const;
export type RefundRequestDecisionKind = (typeof REFUND_REQUEST_DECISION_KINDS)[number];

/** refund_requests.fee_window — 환불 공지 판본 feeTiers.window(§7-6) 와 같은 이름 */
export const REFUND_REQUEST_FEE_WINDOWS = [
  "same_day",
  "paid_within_7d_full",
  "d10_plus",
  "d9_d7",
  "d6_d3",
  "d2_to_deadline",
] as const;
export type RefundRequestFeeWindow = (typeof REFUND_REQUEST_FEE_WINDOWS)[number];

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
/**
 * classes.status — 수업 승인 상태(S2-2.1, data-model §8-7·§8-8, FR-050a).
 * 임시 저장 → 승인 중 → 공개 → (모든 회차 폐강) 폐강. 「반려」·「등록 취소」는 승인 중에서 임시 저장으로
 * 되돌아가는 전이라 상태가 따로 없고, CLASS_APPROVAL_ACTIONS 의 기록으로 남는다.
 */
export const CLASS_STATUSES = ["draft", "pending_approval", "published", "cancelled"] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

/** classes.sub_genre — 세부 장르(data-model §8-7). 댄스스포츠 = 라틴·스탠다드, 살사·바차타 = 살사·바차타 */
export const CLASS_SUB_GENRES = ["latin", "standard", "salsa", "bachata"] as const;
export type ClassSubGenre = (typeof CLASS_SUB_GENRES)[number];

/** classes.discipline — 댄스스포츠 종목(FR-021 · D11). 앞 다섯은 라틴, 뒤 다섯은 스탠다드(화면 순서) */
export const CLASS_DISCIPLINES = [
  "rumba",
  "cha_cha_cha",
  "samba",
  "paso_doble",
  "jive",
  "waltz",
  "tango",
  "viennese_waltz",
  "slow_foxtrot",
  "quickstep",
] as const;
export type ClassDiscipline = (typeof CLASS_DISCIPLINES)[number];

/** classes.target_level — 대상 레벨. 회원 경험 수준에서 「댄서」를 뺀 5개(data-model §8-7) */
export const CLASS_TARGET_LEVELS = ["entry", "beginner", "novice_intermediate", "intermediate", "advanced"] as const;
export type ClassTargetLevel = (typeof CLASS_TARGET_LEVELS)[number];

/** class_target_ages.age_group — 적정 연령(FR-028). all 은 다른 값과 같이 둘 수 없다 */
export const CLASS_AGE_GROUPS = ["all", "gen_2030", "gen_4050", "gen_5060"] as const;
export type ClassAgeGroup = (typeof CLASS_AGE_GROUPS)[number];
/** class_sessions.status — 회차 상태(S2-2.4, data-model §8-7). 예정(scheduled)인 회차만 시간을 점유한다(겹침 판정·EXCLUDE) */
export const CLASS_SESSION_STATUSES = ["scheduled", "cancelled", "closed"] as const;
export type ClassSessionStatus = (typeof CLASS_SESSION_STATUSES)[number];
/** class_approvals.action — 수업 승인 기록 한 줄의 행동(S2-2.1, data-model §8-7). revision_requested 가 「반려」다 */
export const CLASS_APPROVAL_ACTIONS = [
  "submitted",
  "withdrawn",
  "approved",
  "revision_requested",
  "auto_published",
  "edit_approved",
  "edit_rejected",
  "closed",
] as const;
export type ClassApprovalAction = (typeof CLASS_APPROVAL_ACTIONS)[number];
/**
 * session_changes.kind — 회차 변경 기록의 종류(S2-3.1, data-model §8-7).
 * 시간·장소 변경 · 이 회차만 휴강 · 폐강 · 강사 바뀜(대체 강사 배정·대타 확정)
 */
export const SESSION_CHANGE_KINDS = ["time_place", "cancelled", "closed", "instructor_changed"] as const;
export type SessionChangeKind = (typeof SESSION_CHANGE_KINDS)[number];
/** substitute_requests.status — 대타 요청 상태(S2-3.1, data-model §8-8). open → accepted → confirmed, 또는 cancelled·expired 로 끝난다 */
export const SUBSTITUTE_REQUEST_STATUSES = ["open", "accepted", "confirmed", "cancelled", "expired"] as const;
export type SubstituteRequestStatus = (typeof SUBSTITUTE_REQUEST_STATUSES)[number];
/** substitute_request_candidates.status — 대타 후보 한 명의 응답(S2-3.1). closed = 다른 강사가 먼저 수락해 닫힘 */
export const SUBSTITUTE_CANDIDATE_STATUSES = ["invited", "accepted", "declined", "closed"] as const;
export type SubstituteCandidateStatus = (typeof SUBSTITUTE_CANDIDATE_STATUSES)[number];
/** class_edit_requests.status — 공개 뒤 수업 수정 요청 상태(S2-3.12, data-model §8-7). pending → approved · rejected(사유) · withdrawn(올린 사람이 취소) */
export const CLASS_EDIT_REQUEST_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type ClassEditRequestStatus = (typeof CLASS_EDIT_REQUEST_STATUSES)[number];

/** class_announcements.kind — 강사 수업 공지 종류(S2-3.5(강사 수업 공지), data-model §8-7). 시간·장소 변경과 휴강은 공지 종류가 아니다(FR-063) */
export const CLASS_ANNOUNCEMENT_KINDS = ["general", "supplies", "progress"] as const;
export type ClassAnnouncementKind = (typeof CLASS_ANNOUNCEMENT_KINDS)[number];

/** private_lesson_products.status — 개인 레슨 상품(S2-4.1, data-model §8-7). open = 판매 중, closed = 닫음 */
export const PRIVATE_LESSON_PRODUCT_STATUSES = ["open", "closed"] as const;
export type PrivateLessonProductStatus = (typeof PRIVATE_LESSON_PRODUCT_STATUSES)[number];
/** private_lesson_slots.status — 레슨 모집 시간(S2-4.1). open(모집) → held(결제 대기) → booked(예약됨), 닫으면 closed */
export const PRIVATE_LESSON_SLOT_STATUSES = ["open", "held", "booked", "closed"] as const;
export type PrivateLessonSlotStatus = (typeof PRIVATE_LESSON_SLOT_STATUSES)[number];
/** private_lesson_passes.status — 회원 수강권(S2-4.1). 결제 대기 → 쓰는 중 → 다 씀·기한 지남, 또는 대표 환불 */
export const PRIVATE_LESSON_PASS_STATUSES = ["pending_payment", "active", "completed", "expired", "refunded"] as const;
export type PrivateLessonPassStatus = (typeof PRIVATE_LESSON_PASS_STATUSES)[number];
/**
 * private_lesson_bookings.status — 수강권에서 잡은 회차(S2-4.1).
 * 차감 없음 = cancelled_instructor(강사 사정) · cancelled_member_free(기한 전 회원 취소),
 * 1회 차감 = done · cancelled_member_late(기한 지난 회원 취소) · no_show
 */
export const PRIVATE_LESSON_BOOKING_STATUSES = [
  "booked",
  "done",
  "cancelled_instructor",
  "cancelled_member_free",
  "cancelled_member_late",
  "no_show",
] as const;
export type PrivateLessonBookingStatus = (typeof PRIVATE_LESSON_BOOKING_STATUSES)[number];
/** private_lesson_bookings.booked_by — 회차를 잡은 사람(강사가 대신 잡거나 회원이 직접) */
export const PRIVATE_LESSON_BOOKED_BY = ["instructor", "member"] as const;
export type PrivateLessonBookedBy = (typeof PRIVATE_LESSON_BOOKED_BY)[number];

/** attendance_marks.marked_by_kind — 결석을 표시한 사람(회원 본인의 결석 예정 · 강사 · 대표), data-model §7-8 */
export const ATTENDANCE_MARKED_BY_KINDS = ["member", "instructor", "owner"] as const;
export type AttendanceMarkedByKind = (typeof ATTENDANCE_MARKED_BY_KINDS)[number];
/** attendance_marks.dispute_status — 강사·대표가 표시한 결석에 회원이 건 이의의 상태(none → requested → accepted · rejected) */
export const ATTENDANCE_DISPUTE_STATUSES = ["none", "requested", "accepted", "rejected"] as const;
export type AttendanceDisputeStatus = (typeof ATTENDANCE_DISPUTE_STATUSES)[number];

/** payment_webhook_events.result */
export const WEBHOOK_EVENT_RESULTS = [
  "confirmed",
  "duplicate",
  "rejected_signature",
  "amount_mismatch",
  "deposit_on_closed_order",
  "ignored",
  // 카드 승인 실패 통지로 주문을 닫음(계약 03 §8 M-03, S3-3.8)
  "payment_failed",
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
  // M1 직원 알림함 값(S1-4.2, data-model §7-9)
  "share_rate_changed",
  "affiliation_requested",
  "affiliation_approved",
  "affiliation_rejected",
  "delegation_changed",
  "staff_notice_published",
  "merchant_application_approved",
  "merchant_application_rejected",
  "payout_account_changed",
  "terms_change_notice",
  // 이용 제한 통지 — 사업자 점검이 휴·폐업을 보고 학원 제한을 열면 대표에게 간다(S1-1.28)
  "restriction_notice",
  "listing_suspended",
  "business_restriction_lifted",
  // 소속 해제 완료 — 해제된 강사에게 간다(S1-2.12(소속 해제 API), 계약 11 §9 의 이름을 앞당겨 씀)
  "release_completed",
  // 소속 해제 요청 — 강사가 요청하면 그 학원 대표에게 간다(S2-1.4(강사 쪽 해제 요청), 계약 11 §3-3)
  "release_requested",
  // 수업 승인 요청 — 강사가 수업을 등록(승인 요청)하면 그 학원 대표에게 간다(S2-2.3(수업 등록 API), 계약 11 §4-4)
  "class_submitted",
  // 수업 승인 결과 — 대표의 승인·수정 요청(반려)이 수업을 올린 강사에게 간다(S2-2.7(대표 승인·반려·게시), 계약 11 §4-5)
  "class_approved",
  "class_revision_requested",
  // 수업 승인 재알림 — 승인 요청 뒤 24시간 답이 없으면 대표에게 한 번 더(S2-2.12(수업 승인 24시간 재알림 작업), 계약 11 §12)
  "class_approval_reminder",
  // 회차 변경·휴강·폐강 알림(S2-3.2(시간·장소 변경과 휴강 알림), 계약 11 §6 · §7) — 앞 셋은 회원, 마지막은 대표
  "session_time_place_changed",
  "session_cancelled",
  "class_closed",
  "instructor_session_changed",
  // 대타 요청 흐름(S2-3.4(대타 요청 흐름), 계약 11 §8) — 후보 강사 · 대표(수락 알림) · 요청 강사와 대타 강사(확정) · 회원(강사 바뀜)
  "substitute_requested",
  "substitute_accepted",
  "substitute_confirmed",
  "instructor_changed",
  // 강사 수업 공지(S2-3.5(강사 수업 공지), 계약 11 §6-3) — 그 수업 확정 수강생 회원마다 1건
  "class_announcement",
  // 대체 강사 배정(S2-3.7(대체 강사 배정 알림), 계약 11 §9-2) — 소속 해제 때 대표가 회차를 맡긴 대체 강사에게 회차마다 1건
  "substitute_assigned",
  // 개인 레슨 회차(S2-4.7(개인 레슨 규칙·수강생·회차 API), 계약 11 §10-3) — 강사가 잡거나 바꾸거나 취소하면 그 수강권 회원에게 1건
  "private_lesson_booked",
  "private_lesson_cancelled",
  // 공개 뒤 수업 수정 요청(S2-3.12(공개 뒤 수업 수정 요청 API), 계약 11 §5 · §7) — 대표(요청 옴) · 강사(승인·반려) · 회원(요일·시간·기간 바뀜)
  "class_edit_requested",
  "class_edit_approved",
  "class_edit_rejected",
  "class_changed",
  // 소속 해제 요청 거절(S2-3.13(소속 해제 요청 목록·거절·취소 API), 계약 11 §9) — 대표가 거절하면 요청한 강사에게 1건(사유 포함)
  "release_declined",
  // S3-4.3a(강사·대표 결석 표시 API) — 강사·대표가 결석을 표시하면 그 회원에게(계약 04 §6-1)
  "absence_marked",
  // S3-4.3c(결석 이의 신청·처리 API) — 회원이 이의를 걸면 표시한 직원에게, 처리 결과는 그 회원에게(계약 04 §8)
  "absence_dispute_requested",
  "absence_dispute_resolved",
  // S3-4.4(입금 기한 임박 알림 작업) — 입금 기한 1시간 전, 아직 입금하지 않은 가상계좌 주문의 회원에게(계약 04 §10, FR-114a)
  "payment_deadline_soon",
  // S3-5.10(역할 불균형 알림 작업) — 수업 전날 18:00(KST), 내일 회차의 남·여 결제 인원 차이가 3명 이상이면 담당 강사·대표에게(계약 18 §7, FR-107)
  "gender_imbalance",
  // S7-1.7(수업 전 알림 작업) — 회원이 고른 시점(FR-140)에 확정 예약 회원에게 회차마다 1건(계약 15 §1-4)
  "pre_class_reminder",
  // S7-2.3(답변과 응답 기한 재알림) — 문의 접수(대표에게)·답변(문의자에게)·1영업일 넘김 재알림(대표·운영자에게)(계약 15 §2)
  "inquiry_received",
  "inquiry_answered",
  "inquiry_overdue",
  // S7-2.5(신고 접수·처리) — 접수(신고자·운영자에게)·확인 시작·처리 결과(신고자에게)(계약 15 §2-7). 신고 대상에게는 보내지 않는다
  "report_received",
  "report_filed",
  "report_in_review",
  "report_resolved",
  // S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — 대표가 송금 완료를 누르면 · 이름이 다르거나 반송되면 그 회원에게(계약 12 §2-5)
  "refund_completed",
  "refund_account_reinput",
  // S6-3.3(레벨 계산 작업) — 정규 과정을 마쳐 레벨이 오르고 카드가 발급된 회원에게(계약 14 §5-1)
  "level_up",
  // S6-3.4(강사 레벨 조절) — 멤버십 강사가 회원 레벨보다 높게 정해 승급 안내를 보냈을 때 그 회원에게(계약 14 §6-1)
  "level_offer",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** notifications.category — 직원 알림함 칩(O21·O21B, S1-4.2). 회원 알림은 비워 둔다 */
export const NOTIFICATION_CATEGORIES = ["approval", "signup_close", "inquiry", "settlement", "operations"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * notifications.delivery_status — 만들 때 `pending`. 발송기가 선점하면 `sending`, 보내지 못하면 `retry_wait`(다시 보낼 때를 기다림),
 * 세 번째도 실패하면 `failed`(S7-1.6(발송 재시도 작업)). 알림함 행은 어느 상태든 그대로 보인다
 */
export const NOTIFICATION_DELIVERY_STATUSES = ["pending", "sending", "retry_wait", "sent", "skipped", "failed"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** settlement_entries.kind — 최소형. 나머지 단계는 SCH-31(정산 원장) */
export const SETTLEMENT_ENTRY_KINDS = ["payment_hold"] as const;
export type SettlementEntryKind = (typeof SETTLEMENT_ENTRY_KINDS)[number];

/** settlement_entries.status */
export const SETTLEMENT_ENTRY_STATUSES = ["hold"] as const;
export type SettlementEntryStatus = (typeof SETTLEMENT_ENTRY_STATUSES)[number];

// ───────────────────────── 직원 계정·역할·감사 기록 (S0-2.2, data-model §7-2·§7-7) ─────────────────────────

/** staff_accounts.status */
export const STAFF_ACCOUNT_STATUSES = ["active", "suspended", "withdrawn"] as const;
export type StaffAccountStatus = (typeof STAFF_ACCOUNT_STATUSES)[number];

/** role_grants.role — 직원 역할 3종. Dancer 는 members 행이라 여기에 없다(FR-004, FR-011a) */
export const STAFF_ROLE_NAMES = ["instructor", "owner", "admin"] as const;
export type StaffRoleName = (typeof STAFF_ROLE_NAMES)[number];

/** role_grants.status */
export const ROLE_GRANT_STATUSES = ["active", "revoked"] as const;
export type RoleGrantStatus = (typeof ROLE_GRANT_STATUSES)[number];

/** audit_logs.actor_kind */
export const AUDIT_ACTOR_KINDS = ["staff", "member", "system"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** platform_fee_rates.fee_category — 일반 수업·행사 / 개인 레슨(결정 12·13) */
export const PLATFORM_FEE_CATEGORIES = ["general", "private_lesson"] as const;
export type PlatformFeeCategory = (typeof PLATFORM_FEE_CATEGORIES)[number];

// 공휴일 종류·출처(data-model §10-13) — 계약 enum HolidayKind·HolidaySource 와 짝이다.
// 종류: 법정 공휴일 / 대체 공휴일 / 임시 공휴일. 출처: 특일 정보 API 자동 수집 / 운영자 입력.
export const HOLIDAY_KINDS = ["holiday", "substitute_holiday", "temporary_holiday"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];
export const HOLIDAY_SOURCES = ["api", "operator"] as const;
export type HolidaySource = (typeof HOLIDAY_SOURCES)[number];
/** 공휴일 자동 수집 결과(holiday_sync_runs.status, data-model §10-13) */
export const HOLIDAY_SYNC_STATUSES = ["success", "failed"] as const;
export type HolidaySyncStatus = (typeof HOLIDAY_SYNC_STATUSES)[number];

// 가드용 학원·대표·소속 표(S0-3.5a, data-model §7-3·§7-5·§7-9) — 계약 enum 과 짝이다.
// 위임 값(웹 roster_manage·class_manage + 앱 class_submit)은 권한 판정 모듈이 소유한다 — lib/domain/permissions.ts 의 ASSIGNABLE_DELEGATION_PERMISSIONS.
/** academy_owners.status — 지금 대표 / 물러난 대표 */
export const ACADEMY_OWNER_STATUSES = ["active", "ended"] as const;
export type AcademyOwnerStatus = (typeof ACADEMY_OWNER_STATUSES)[number];
/** instructor_affiliations.status — 대기·소속·거절·강사 취소·해제 */
export const AFFILIATION_STATUSES = ["pending", "active", "rejected", "withdrawn", "released"] as const;
export type AffiliationStatus = (typeof AFFILIATION_STATUSES)[number];
/** instructor_affiliations.source — 직접 신청 / 초대 링크 */
export const AFFILIATION_SOURCES = ["application", "invite"] as const;
export type AffiliationSource = (typeof AFFILIATION_SOURCES)[number];
/** instructor_affiliations.reject_reason_code — FR-071 */
export const AFFILIATION_REJECT_REASONS = ["not_recruiting", "genre_mismatch", "info_needed", "other"] as const;
export type AffiliationRejectReason = (typeof AFFILIATION_REJECT_REASONS)[number];
/** instructor_affiliations.release_initiated_by — 해제를 시작한 쪽(FR-082) */
export const AFFILIATION_RELEASE_INITIATORS = ["owner", "instructor"] as const;
export type AffiliationReleaseInitiator = (typeof AFFILIATION_RELEASE_INITIATORS)[number];
/** affiliation_release_requests.status — 강사가 시작한 해제 요청(S2-1.4, data-model §8-7). 대기 → 완료·취소·거절 */
export const AFFILIATION_RELEASE_REQUEST_STATUSES = ["requested", "completed", "withdrawn", "declined"] as const;
export type AffiliationReleaseRequestStatus = (typeof AFFILIATION_RELEASE_REQUEST_STATUSES)[number];
/** 해제할 때 남은 회차를 어떻게 할지(계약 11 §3-3) — 대체 강사 / 휴강 / 폐강. DB 칸이 아니라 jsonb 안의 값이다 */
export const RELEASE_SESSION_ACTIONS = ["substitute", "cancel_session", "close"] as const;
export type ReleaseSessionAction = (typeof RELEASE_SESSION_ACTIONS)[number];
/** 해제할 때 남은 개인 레슨 수강권을 어떻게 할지(계약 11 §3-3) — 먼저 마치기 / 환불 / 다른 강사에게 */
export const RELEASE_PASS_ACTIONS = ["finish_first", "refund", "handover"] as const;
export type ReleasePassAction = (typeof RELEASE_PASS_ACTIONS)[number];

// 학원 입점 칸(S1-1.1(학원·대표·지점 테이블 묶음), data-model §7-3·§7-9) — 계약 enum 과 짝이다.
/** academies.status — 정상 / 게시 제한(FR-250) / 해지 신청 / 해지 끝(FR-256) */
export const ACADEMY_STATUSES = ["active", "restricted", "termination_requested", "terminated"] as const;
export type AcademyStatus = (typeof ACADEMY_STATUSES)[number];
/** academies.registration_type — 교육청 학원 / 교습소 / 신고 체육시설 / 미등록(FR-085) */
export const ACADEMY_REGISTRATION_TYPES = ["academy", "tutoring_center", "sports_facility", "unregistered"] as const;
export type AcademyRegistrationType = (typeof ACADEMY_REGISTRATION_TYPES)[number];

// 입점 신청·증빙 파일·정산 계좌(S1-1.2(입점 신청·증빙·정산 계좌 테이블 묶음), data-model §7-3·§7-9) — 계약 enum 과 짝이다.
/** merchant_applications.status — 초안 → 제출 → 심사 중 → 승인·거절 / 초안·제출 → 철회 */
export const MERCHANT_APPLICATION_STATUSES = ["draft", "submitted", "in_review", "approved", "rejected", "withdrawn"] as const;
export type MerchantApplicationStatus = (typeof MERCHANT_APPLICATION_STATUSES)[number];
/** merchant_applications.reject_reason_code — FR-250 정해진 거절 사유 4종 */
export const MERCHANT_REJECT_REASONS = ["info_mismatch", "registration_missing", "prior_termination", "trust_violation"] as const;
export type MerchantRejectReason = (typeof MERCHANT_REJECT_REASONS)[number];
/** merchant_application_documents.doc_kind — 사업자등록증(모든 형태 필수) + 등록 형태별 증빙 */
export const MERCHANT_DOCUMENT_KINDS = [
  "business_registration",
  "academy_registration",
  "tutoring_center_report",
  "sports_facility_report",
] as const;
export type MerchantDocumentKind = (typeof MERCHANT_DOCUMENT_KINDS)[number];
/** uploaded_files.purpose — 입점 증빙·학원 사진·강사 사업자등록증(S2-1.2b). 뒤 슬라이스가 값을 더한다(data-model §14-2) */
export const UPLOADED_FILE_PURPOSES = [
  "merchant_evidence",
  "academy_photo",
  "business_registration_evidence",
  // 강사 프로필 사진(S2-1.6) — 공개
  "instructor_photo",
  // 수업 포스터(S2-2.8) — 공개
  "poster",
  // AI 가 만든 수업 홍보 이미지(SX-6.5) — 만들 때 비공개, 수업이 게시될 때 공개
  "class_promo_image",
  // 문의 첨부 · 신고 첨부 · 이용 제한 소명 첨부(S7-2.7) — 언제나 비공개. 회원도 올릴 수 있는 목적은 이 셋뿐이다
  "inquiry_attachment",
  "report_attachment",
  "restriction_explanation",
] as const;
export type UploadedFilePurpose = (typeof UPLOADED_FILE_PURPOSES)[number];
/** attachment_links.owner_kind — 첨부가 붙은 자리(S7-2.7): 문의 글 · 신고 · 이용 제한 소명 */
export const ATTACHMENT_OWNER_KINDS = ["inquiry_message", "report", "restriction_explanation"] as const;
export type AttachmentOwnerKind = (typeof ATTACHMENT_OWNER_KINDS)[number];
/** uploaded_files.visibility */
export const UPLOADED_FILE_VISIBILITIES = ["private", "public"] as const;
export type UploadedFileVisibility = (typeof UPLOADED_FILE_VISIBILITIES)[number];
/** academy_payout_accounts.status — 쓰는 계좌 / 바뀐 옛 계좌 */
export const PAYOUT_ACCOUNT_STATUSES = ["active", "replaced"] as const;
export type PayoutAccountStatus = (typeof PAYOUT_ACCOUNT_STATUSES)[number];
/** academy_payout_accounts.verification_status — 예금주 확인 상태(S1-1.22, data-model §10-5). verified 만 지급 대상이다 */
export const PAYOUT_VERIFICATION_STATUSES = ["awaiting_proof", "pending", "verified", "rejected"] as const;
export type PayoutVerificationStatus = (typeof PAYOUT_VERIFICATION_STATUSES)[number];
/** academy_payout_accounts.reject_reason_code — 예금주 확인 반려 사유(13 §10-2) */
export const PAYOUT_ACCOUNT_REJECT_REASONS = ["name_mismatch", "file_unreadable", "other"] as const;
export type PayoutAccountRejectReason = (typeof PAYOUT_ACCOUNT_REJECT_REASONS)[number];

// 약관·동의(S1-1.3(약관·동의 테이블 묶음), data-model §7-4·§7-9) — 계약 enum 과 짝이다.
/** terms_versions.kind · merchant_consents.item — 입점 약관·개인정보 수집 동의와 입점 고지 항목. 회원 약관 값은 뒤 슬라이스가 더한다(§12-9) */
export const TERMS_KINDS = [
  "merchant_terms",
  "merchant_privacy_collection",
  "privacy_policy",
  "platform_fee_notice",
  "card_fee_notice",
  "content_license",
  "one_plus_one_notice",
] as const;
export type TermsKind = (typeof TERMS_KINDS)[number];
/** merchant_consents.source — 입점 신청 때 / 약관이 바뀌어 다시 동의 */
export const MERCHANT_CONSENT_SOURCES = ["application", "re_consent"] as const;
export type MerchantConsentSource = (typeof MERCHANT_CONSENT_SOURCES)[number];

// 사업자 상태 확인·학원 제한(S1-1.4(사업자 상태 확인·학원 제한 테이블), data-model §7-3b) — 계약 enum 과 짝이다.
/** business_status_checks.trigger — 입점 심사 / 매일 점검 / 정산 지급 직전 / 운영자 수동 */
export const BUSINESS_CHECK_TRIGGERS = ["onboarding", "daily", "pre_payout", "manual"] as const;
export type BusinessCheckTrigger = (typeof BUSINESS_CHECK_TRIGGERS)[number];
/** business_status_checks.status — 계속·휴업·폐업·미등록·조회 실패. error 는 조치하지 않는다 */
export const BUSINESS_CHECK_STATUSES = ["active", "suspended", "closed", "not_found", "error"] as const;
export type BusinessCheckStatus = (typeof BUSINESS_CHECK_STATUSES)[number];
/** academy_restrictions.kind — 새 결제 막음 / 정산 지급 보류 / 앱 게시 중단 */
export const ACADEMY_RESTRICTION_KINDS = ["new_sales_blocked", "payout_hold", "listing_suspended"] as const;
export type AcademyRestrictionKind = (typeof ACADEMY_RESTRICTION_KINDS)[number];

// 환불·취소 공지 종류(S1-3.1(공지 판본 테이블 넓히기), data-model §7-6) — 계약 enum RefundNoticeKind 와 짝이다.
/** refund_notice_versions.notice_kind — 정규 / 이벤트형 / 개인 레슨. 종류마다 판본 번호를 따로 쌓는다 */
export const REFUND_NOTICE_KINDS = ["regular", "event", "private_lesson"] as const;
export type RefundNoticeKind = (typeof REFUND_NOTICE_KINDS)[number];

// 학원 공지(S1-4.1(학원 공지·받는 사람 테이블 묶음), data-model §7-6 끝) — 계약 enum StaffNoticeCategory·StaffNoticeStatus 와 짝이다.
/** academy_staff_notices.category — 휴강 / 수업 변경 / 학원 일정 / 기타 */
export const STAFF_NOTICE_CATEGORIES = ["class_cancelled", "class_changed", "academy_schedule", "other"] as const;
export type StaffNoticeCategory = (typeof STAFF_NOTICE_CATEGORIES)[number];
/** academy_staff_notices.status — 초안 → 올림(끝). 올린 공지는 고치지 않는다 */
export const STAFF_NOTICE_STATUSES = ["draft", "published"] as const;
export type StaffNoticeStatus = (typeof STAFF_NOTICE_STATUSES)[number];
/** rooms.status — 쓰는 중(active) / 보관(archived). 지난 수업 기록이 강의실을 가리키므로 지우지 않고 보관한다(data-model §7-3) */
export const ROOM_STATUSES = ["active", "archived"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

// 강사 자격·개인 일정(S2-1.1(강사 테이블), data-model §8-3) — 계약 enum InstructorCredentialKind·PersonalEventRepeat 와 짝이다.
/** instructor_credentials.kind — 자격증 / 대회 수상 */
export const INSTRUCTOR_CREDENTIAL_KINDS = ["qualification", "competition"] as const;
export type InstructorCredentialKind = (typeof INSTRUCTOR_CREDENTIAL_KINDS)[number];
/** instructor_personal_events.repeat_rule — 한 번 / 매주 / 매일. 반복 일정은 한 행이고 읽을 때 펼친다 */
export const PERSONAL_EVENT_REPEATS = ["none", "weekly", "daily"] as const;
export type PersonalEventRepeat = (typeof PERSONAL_EVENT_REPEATS)[number];

// 직원 가입 동의(S2-1.2(강사 가입 API), data-model §8-3 staff_consents) — 계약 enum StaffConsentSource 와 짝이다.
/** staff_consents.source — 지금은 강사 가입 하나뿐이다 */
export const STAFF_CONSENT_SOURCES = ["instructor_signup"] as const;
export type StaffConsentSource = (typeof STAFF_CONSENT_SOURCES)[number];

// 회원 가입 동의(S3-1.1(회원 동의 기록 테이블), 보드 C14A · FR-249(약관 동의 기록)) — 계약 enum MemberConsentItem · MemberConsentSource 와 짝이다.
/** member_consents.item — 필수 넷과 선택 둘을 합친 전체 목록 */
export const MEMBER_CONSENT_ITEMS = [
  "member_terms",
  "member_privacy_collection",
  "academy_sharing",
  "age_19_plus",
  "marketing_consent",
  "location_info",
] as const;
export type MemberConsentItem = (typeof MEMBER_CONSENT_ITEMS)[number];
/** 가입 때 빠지면 가입이 끝나지 않는 필수 동의 넷(S3-1 수용 ①). 필수인지는 DB 칸이 아니라 이 목록이 정한다 */
export const MEMBER_REQUIRED_CONSENT_ITEMS = [
  "member_terms",
  "member_privacy_collection",
  "academy_sharing",
  "age_19_plus",
] as const satisfies readonly MemberConsentItem[];
/** 고르지 않아도 가입되는 선택 동의 둘. 마이 › 알림 설정에서 끄고 켠다 */
export const MEMBER_OPTIONAL_CONSENT_ITEMS = ["marketing_consent", "location_info"] as const satisfies readonly MemberConsentItem[];
/** member_consents.source — 가입 때 / 설정에서 다시 켬 / 약관 변경 뒤 재동의 */
export const MEMBER_CONSENT_SOURCES = ["signup", "settings", "re_consent"] as const;
export type MemberConsentSource = (typeof MEMBER_CONSENT_SOURCES)[number];

// ---- MX(AI 트랙) · SX-2.3(검토 API) — data-model §13-8. 계약 enum 과 글자 단위로 같아야 한다(constants-contract.test.ts) ----

/** ai_jobs.kind — 에이전트에게 맡긴 비동기 작업 종류 */
export const AI_JOB_KINDS = ["poster_extract", "promo_image", "faq_draft"] as const;
export type AiJobKind = (typeof AI_JOB_KINDS)[number];
/** ai_jobs.status — queued → running → succeeded · failed · timed_out · cancelled */
export const AI_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];
/** ai_jobs.error_code */
export const AI_JOB_ERROR_CODES = [
  "EXTRACTION_FAILED",
  "PROVIDER_QUOTA_EXHAUSTED",
  "PROVIDER_ERROR",
  "INVALID_RESULT",
  "AGENT_UNAVAILABLE",
  "TIMEOUT",
] as const;
export type AiJobErrorCode = (typeof AI_JOB_ERROR_CODES)[number];
/** poster_extractions.target_kind — 같은 업로드 양식을 파티·공연·대회에도 쓴다(FR-077) */
export const POSTER_TARGET_KINDS = ["class", "party", "performance", "competition"] as const;
export type PosterTargetKind = (typeof POSTER_TARGET_KINDS)[number];
/** poster_extractions.status — 검토 끝(reviewed) 없이 submitted 로 가는 길은 없다(FR-074) */
export const POSTER_EXTRACTION_STATUSES = ["queued", "running", "ready", "failed", "reviewed", "submitted", "abandoned"] as const;
export type PosterExtractionStatus = (typeof POSTER_EXTRACTION_STATUSES)[number];
/** poster_extractions.failure_code */
export const POSTER_FAILURE_CODES = ["EXTRACTION_FAILED", "AGENT_UNAVAILABLE", "TIMEOUT", "INVALID_RESULT"] as const;
export type PosterFailureCode = (typeof POSTER_FAILURE_CODES)[number];
/** promo_image_generations.status — 홍보 이미지 만들기 한 번의 상태(SX-6.5, data-model §13-6) */
export const PROMO_IMAGE_GENERATION_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type PromoImageGenerationStatus = (typeof PROMO_IMAGE_GENERATION_STATUSES)[number];
/** promo_image_generations.failure_code — 이 이유로 실패하면 그날 횟수를 1 돌려준다(SX-6.5) */
export const PROMO_IMAGE_FAILURE_CODES = ["PROVIDER_QUOTA_EXHAUSTED", "PROVIDER_ERROR", "AGENT_UNAVAILABLE", "TIMEOUT", "INVALID_RESULT"] as const;
export type PromoImageFailureCode = (typeof PROMO_IMAGE_FAILURE_CODES)[number];
/** class_promo_assets.cover_source — 홍보 표지가 어디서 왔나. 올린 사진이 있으면 언제나 uploaded_photo(SX-6.7) */
export const PROMO_COVER_SOURCES = ["uploaded_photo", "ai_image"] as const;
export type PromoCoverSource = (typeof PROMO_COVER_SOURCES)[number];
/** class_promo_assets.intro_source — ai(초안 그대로) · ai_edited(고침) · user(직접 씀)(SX-6.7) */
export const PROMO_INTRO_SOURCES = ["ai", "ai_edited", "user"] as const;
export type PromoIntroSource = (typeof PROMO_INTRO_SOURCES)[number];
/**
 * poster_extraction_fields.field_key — 칸 키 17개(계약 16 §4-6). agent-server field_rules.py 와 같은 순서·글자.
 * 기간 칸 3개(start_date · end_date · session_count)는 SX-2.6(포스터 초안 기간 칸)에서 시간 칸 바로 뒤에 더했다.
 */
export const POSTER_FIELD_KEYS = [
  "genre",
  "genre_detail",
  "title",
  "weekday",
  "start_time",
  "end_time",
  "start_date",
  "end_date",
  "session_count",
  "room_name",
  "price_amount",
  "capacity_male",
  "capacity_female",
  "capacity_total",
  "instructor_name",
  "level",
  "class_kind",
] as const;
export type PosterFieldKey = (typeof POSTER_FIELD_KEYS)[number];
/** poster_extraction_fields.value_source — AI 가 채움 · 사람이 채움 · AI 값을 사람이 고침 */
export const POSTER_VALUE_SOURCES = ["ai", "user", "ai_edited"] as const;
export type PosterValueSource = (typeof POSTER_VALUE_SOURCES)[number];

// 알림 설정·푸시(S7-1.2(푸시 토큰·알림 설정 테이블), data-model §12-4·§12-9) — 계약 enum 과 짝이다.
/** notification_settings.pre_class_lead — 수업 전 알림 시점: 하루 전 / 2시간 전 / 1시간 전(기본) / 30분 전 */
export const PRE_CLASS_LEADS = ["day_before", "two_hours", "one_hour", "thirty_min"] as const;
export type PreClassLead = (typeof PRE_CLASS_LEADS)[number];
/** staff_notification_settings.topic — 직원이 휴대폰 푸시를 끌 수 있는 주제 5개(O34). 끌 수 없는 주제는 여기 없다 */
export const STAFF_NOTIFICATION_TOPICS = [
  "class_approval",
  "event_capacity",
  "inquiry",
  "schedule_room",
  "platform_notice",
] as const;
export type StaffNotificationTopic = (typeof STAFF_NOTIFICATION_TOPICS)[number];
/** push_tokens.platform — 베타는 안드로이드만 */
export const PUSH_PLATFORMS = ["android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
/** push_tokens.permission_state — 알림 권한 허용 / 거부 / 아직 모름 */
export const PUSH_PERMISSION_STATES = ["granted", "denied", "unknown"] as const;
export type PushPermissionState = (typeof PUSH_PERMISSION_STATES)[number];

// 문의·신고(S7-2.1(문의·답변·신고 테이블), data-model §12 · §12-9) — 계약 enum 과 짝이다.
/** inquiries.kind — 받는 곳: 학원(대표가 답함) / 플랫폼(운영자가 답함) */
export const INQUIRY_KINDS = ["academy", "system"] as const;
export type InquiryKind = (typeof INQUIRY_KINDS)[number];
/** inquiries.asker_kind — 문의자: 회원 / 강사 / 대표 */
export const INQUIRY_ASKER_KINDS = ["member", "instructor", "owner"] as const;
export type InquiryAskerKind = (typeof INQUIRY_ASKER_KINDS)[number];
/** inquiries.route — 처음부터 사람에게 / AI 상담에서 넘어옴 */
export const INQUIRY_ROUTES = ["human", "ai_handoff"] as const;
export type InquiryRoute = (typeof INQUIRY_ROUTES)[number];
/** inquiries.status — 답변 대기 / 답변함 / 닫힘 / AI 가 답함(MX) */
export const INQUIRY_STATUSES = ["answer_waiting", "answered", "closed", "ai_answered"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
/**
 * inquiries.category — 세 무리를 합친 전체 값. 어느 무리에서 고를 수 있는지는 (asker_kind, kind) 짝으로 앱이 본다(S7-2.2).
 * 회원→학원 class·refund·schedule·other / 강사→학원 settlement_basis·capacity·absence(결석, D10)·other /
 * 플랫폼 account·app_error·payment_outage·membership·other
 */
export const INQUIRY_CATEGORIES = [
  "class",
  "refund",
  "schedule",
  "settlement_basis",
  "capacity",
  "absence",
  "account",
  "app_error",
  "payment_outage",
  "membership",
  "other",
] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];
/** inquiry_messages.sender_kind — 문의자 / 학원 대표 / 운영자 / AI */
export const INQUIRY_MESSAGE_SENDER_KINDS = ["asker", "academy_owner", "operator", "ai"] as const;
export type InquiryMessageSenderKind = (typeof INQUIRY_MESSAGE_SENDER_KINDS)[number];
/** reports.reporter_kind — 신고자: 회원 / 강사 / 대표 */
export const REPORT_REPORTER_KINDS = ["member", "instructor", "owner"] as const;
export type ReportReporterKind = (typeof REPORT_REPORTER_KINDS)[number];
/** reports.target_kind — 신고 대상: 학원 / 강사 / 수업 / 회원 */
export const REPORT_TARGET_KINDS = ["academy", "instructor", "class", "member"] as const;
export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];
/** reports.status — 접수 / 검토 중 / 처리 끝 */
export const REPORT_STATUSES = ["received", "in_review", "resolved"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
/** reports.outcome — 기각 / 인정 */
export const REPORT_OUTCOMES = ["dismissed", "upheld"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];
/** reports.reason_code — 플랫폼 밖 결제 유도(FR-255) / 정보 불일치 / 괴롭힘 / 불법·위험 / 기타 */
export const REPORT_REASON_CODES = [
  "off_platform_payment",
  "info_mismatch",
  "harassment",
  "illegal_dangerous",
  "other",
] as const;
export type ReportReasonCode = (typeof REPORT_REASON_CODES)[number];
// S7-2.6(이용 제한 절차) — restriction_cases 의 값 집합(data-model §12-9). 규칙은 lib/domain/restriction.ts
/** restriction_cases.subject_kind — 제한 대상: 회원 / 강사 / 학원 */
export const RESTRICTION_SUBJECT_KINDS = ["member", "instructor", "academy"] as const;
export type RestrictionSubjectKind = (typeof RESTRICTION_SUBJECT_KINDS)[number];
/** restriction_cases.source — 절차를 연 길: 신고 처리 / 사업자 점검 / 운영자 직접 */
export const RESTRICTION_SOURCES = ["report", "business_status", "operator_manual"] as const;
export type RestrictionSource = (typeof RESTRICTION_SOURCES)[number];
/** restriction_cases.measure · planned_measure — 경고 / 기능 제한 / 수업 게시 제한 / 정산 보류 / 이용 정지 / 해지(FR-254) */
export const RESTRICTION_MEASURES = ["warning", "feature_limit", "listing_limit", "payout_hold", "suspension", "termination"] as const;
export type RestrictionMeasure = (typeof RESTRICTION_MEASURES)[number];
/** restriction_cases.state — 사유 통지 / 소명 들어옴 / 조치 확정 / 해제 / 기각 */
export const RESTRICTION_STATES = ["notice_sent", "explained", "measure_applied", "lifted", "dismissed"] as const;
export type RestrictionState = (typeof RESTRICTION_STATES)[number];
// S6-3.1(레벨·카드·후보 동의 테이블) — 레벨 표들의 값 집합(data-model §11-4 · §11-9). 계산 규칙은 S6-3.2 가 만든다
/** 레벨 숫자의 범위 — 0(입문 시작) ~ 10(댄서). DB CHECK ck_levels_range 등과 같다(FR-160) */
export const LEVEL_MIN = 0;
export const LEVEL_MAX = 10;
/** member_genre_levels·level_cards 등의 detail_genre — 레벨을 매기는 세부 장르. 댄스스포츠 10종목 + 아르헨티나 탱고·스윙 + 살사·바차타 */
export const LEVEL_DETAIL_GENRES = [
  "cha_cha_cha",
  "samba",
  "rumba",
  "paso_doble",
  "jive",
  "waltz",
  "tango",
  "viennese_waltz",
  "slow_foxtrot",
  "quickstep",
  "argentine_tango",
  "swing",
  "salsa",
  "bachata",
] as const;
export type LevelDetailGenre = (typeof LEVEL_DETAIL_GENRES)[number];
/** level_promotions.source — 정규 과정 완주 / 강사 레벨 제안 수락 */
export const LEVEL_PROMOTION_SOURCES = ["course_completion", "instructor_offer"] as const;
export type LevelPromotionSource = (typeof LEVEL_PROMOTION_SOURCES)[number];
/** level_offers.status — 열림 / 승급함 / 지금 레벨에서 키우기 / 강사가 다시 올려 줘서 닫힘 */
export const LEVEL_OFFER_STATUSES = ["offered", "accepted", "declined", "superseded"] as const;
export type LevelOfferStatus = (typeof LEVEL_OFFER_STATUSES)[number];
