// S0-2.3(값 집합 계약 일치 테스트) — 공유 계약 §4.2(값 소유 모듈)
//
// constants.ts 의 `as const` 배열과 계약 PSL(prisma/contract.prisma)의 enum 이 문자 단위로
// 같은지 대조한다. 한쪽만 고치면 DB CHECK 와 앱 코드의 값이 어긋나 결제·예약이 조용히 깨진다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import * as constants from "../../lib/domain/constants";
import { ASSIGNABLE_DELEGATION_PERMISSIONS } from "../../lib/domain/permissions";
import { DEPLOY_ENVIRONMENTS } from "../../lib/server/env";

// 계약 PSL 을 읽어 `enum 이름 → 값 배열(적힌 순서)` 표로 만든다.
// 형식: enum Name { @@type(...)  key = "value" ... }  — 줄마다 `키 = "값"` 한 쌍이다.
function parseContractEnums(psl: string): Map<string, string[]> {
  const enums = new Map<string, string[]>();
  for (const match of psl.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const values = [...match[2].matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm)].map((m) => {
      // `키 = "값"` 에서 키와 값이 다르면 DB 에는 값이 들어간다. 계약은 둘을 같게 쓰기로 했다.
      expect(m[1], `enum ${match[1]} 의 키와 값이 다르다`).toBe(m[2]);
      return m[2];
    });
    enums.set(match[1], values);
  }
  return enums;
}

const contractEnums = parseContractEnums(
  readFileSync(join(__dirname, "../../prisma/contract.prisma"), "utf8"),
);

// constants.ts 의 배열 ↔ 계약 enum 짝. 이름이 서로 달라서 표로 적는다.
const PAIRS: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ["ORDER_STATUSES", constants.ORDER_STATUSES, "OrderStatus"],
  ["PAYMENT_METHODS", constants.PAYMENT_METHODS, "PaymentMethod"],
  ["PAYMENT_STATUSES", constants.PAYMENT_STATUSES, "PaymentStatus"],
  ["RESERVATION_STATUSES", constants.RESERVATION_STATUSES, "ReservationStatus"],
  ["RESERVATION_CANCEL_REASONS", constants.RESERVATION_CANCEL_REASONS, "CancelReason"],
  ["REFUND_STATUSES", constants.REFUND_STATUSES, "RefundStatus"],
  ["REFUND_REASONS", constants.REFUND_REASONS, "RefundReason"],
  ["REFUND_BASIS_KINDS", constants.REFUND_BASIS_KINDS, "RefundBasisKind"],
  ["REFUND_EXECUTION_KINDS", constants.REFUND_EXECUTION_KINDS, "RefundExecutionKind"],
  ["REFUND_EXECUTED_BY", constants.REFUND_EXECUTED_BY, "RefundExecutedBy"],
  ["REFUND_REINPUT_REASONS", constants.REFUND_REINPUT_REASONS, "RefundReinputReason"],
  ["REFUND_ACCOUNT_STATUSES", constants.REFUND_ACCOUNT_STATUSES, "RefundAccountStatus"],
  ["REFUND_REQUEST_KINDS", constants.REFUND_REQUEST_KINDS, "RefundRequestKind"],
  ["REFUND_REQUEST_STATUSES", constants.REFUND_REQUEST_STATUSES, "RefundRequestStatus"],
  ["REFUND_REQUEST_REASON_KINDS", constants.REFUND_REQUEST_REASON_KINDS, "RefundRequestReasonKind"],
  ["REFUND_REQUEST_DECISION_KINDS", constants.REFUND_REQUEST_DECISION_KINDS, "RefundRequestDecisionKind"],
  ["REFUND_REQUEST_FEE_WINDOWS", constants.REFUND_REQUEST_FEE_WINDOWS, "RefundRequestFeeWindow"],
  ["SEAT_KINDS", constants.SEAT_KINDS, "SeatKind"],
  ["GENDERS", constants.GENDERS, "Gender"],
  ["GENRES", constants.GENRES, "Genre"],
  ["EXPERIENCE_LEVELS", constants.EXPERIENCE_LEVELS, "ExperienceLevel"],
  ["CLASS_KINDS", constants.CLASS_KINDS, "ClassKind"],
  ["SEAT_MODES", constants.SEAT_MODES, "SeatMode"],
  ["ENROLLMENT_UNITS", constants.ENROLLMENT_UNITS, "EnrollmentUnit"],
  ["OFFERING_STATUSES", constants.OFFERING_STATUSES, "OfferingStatus"],
  ["CLASS_STATUSES", constants.CLASS_STATUSES, "ClassStatus"],
  ["CLASS_APPROVAL_ACTIONS", constants.CLASS_APPROVAL_ACTIONS, "ClassApprovalAction"],
  ["CLASS_SUB_GENRES", constants.CLASS_SUB_GENRES, "ClassSubGenre"],
  ["CLASS_DISCIPLINES", constants.CLASS_DISCIPLINES, "ClassDiscipline"],
  ["CLASS_TARGET_LEVELS", constants.CLASS_TARGET_LEVELS, "ClassTargetLevel"],
  ["CLASS_AGE_GROUPS", constants.CLASS_AGE_GROUPS, "ClassAgeGroup"],
  ["CLASS_SESSION_STATUSES", constants.CLASS_SESSION_STATUSES, "ClassSessionStatus"],
  ["SESSION_CHANGE_KINDS", constants.SESSION_CHANGE_KINDS, "SessionChangeKind"],
  ["SUBSTITUTE_REQUEST_STATUSES", constants.SUBSTITUTE_REQUEST_STATUSES, "SubstituteRequestStatus"],
  ["SUBSTITUTE_CANDIDATE_STATUSES", constants.SUBSTITUTE_CANDIDATE_STATUSES, "SubstituteCandidateStatus"],
  ["CLASS_EDIT_REQUEST_STATUSES", constants.CLASS_EDIT_REQUEST_STATUSES, "ClassEditRequestStatus"],
  ["CLASS_ANNOUNCEMENT_KINDS", constants.CLASS_ANNOUNCEMENT_KINDS, "ClassAnnouncementKind"],
  ["PRIVATE_LESSON_PRODUCT_STATUSES", constants.PRIVATE_LESSON_PRODUCT_STATUSES, "PrivateLessonProductStatus"],
  ["PRIVATE_LESSON_SLOT_STATUSES", constants.PRIVATE_LESSON_SLOT_STATUSES, "PrivateLessonSlotStatus"],
  ["PRIVATE_LESSON_PASS_STATUSES", constants.PRIVATE_LESSON_PASS_STATUSES, "PrivateLessonPassStatus"],
  ["PRIVATE_LESSON_BOOKING_STATUSES", constants.PRIVATE_LESSON_BOOKING_STATUSES, "PrivateLessonBookingStatus"],
  ["PRIVATE_LESSON_BOOKED_BY", constants.PRIVATE_LESSON_BOOKED_BY, "PrivateLessonBookedBy"],
  // S3-4.1(결석 기록 테이블) — attendance_marks 의 두 값 집합
  ["ATTENDANCE_MARKED_BY_KINDS", constants.ATTENDANCE_MARKED_BY_KINDS, "AttendanceMarkedByKind"],
  ["ATTENDANCE_DISPUTE_STATUSES", constants.ATTENDANCE_DISPUTE_STATUSES, "AttendanceDisputeStatus"],
  ["AI_JOB_KINDS", constants.AI_JOB_KINDS, "AiJobKind"],
  ["AI_JOB_STATUSES", constants.AI_JOB_STATUSES, "AiJobStatus"],
  ["AI_JOB_ERROR_CODES", constants.AI_JOB_ERROR_CODES, "AiJobErrorCode"],
  ["POSTER_TARGET_KINDS", constants.POSTER_TARGET_KINDS, "PosterTargetKind"],
  ["POSTER_EXTRACTION_STATUSES", constants.POSTER_EXTRACTION_STATUSES, "PosterExtractionStatus"],
  ["POSTER_FAILURE_CODES", constants.POSTER_FAILURE_CODES, "PosterFailureCode"],
  ["POSTER_FIELD_KEYS", constants.POSTER_FIELD_KEYS, "PosterFieldKey"],
  ["POSTER_VALUE_SOURCES", constants.POSTER_VALUE_SOURCES, "PosterValueSource"],
  // SX-6.5(하루 횟수·생성 요청 API) — 홍보 이미지 만들기 상태 · 실패 이유
  ["PROMO_IMAGE_GENERATION_STATUSES", constants.PROMO_IMAGE_GENERATION_STATUSES, "PromoImageGenerationStatus"],
  ["PROMO_IMAGE_FAILURE_CODES", constants.PROMO_IMAGE_FAILURE_CODES, "PromoImageFailureCode"],
  ["PROMO_COVER_SOURCES", constants.PROMO_COVER_SOURCES, "PromoCoverSource"],
  ["PROMO_INTRO_SOURCES", constants.PROMO_INTRO_SOURCES, "PromoIntroSource"],
  ["WEBHOOK_EVENT_RESULTS", constants.WEBHOOK_EVENT_RESULTS, "WebhookResult"],
  ["PAYMENT_EXCEPTION_KINDS", constants.PAYMENT_EXCEPTION_KINDS, "PaymentExceptionKind"],
  ["PAYMENT_EXCEPTION_STATUSES", constants.PAYMENT_EXCEPTION_STATUSES, "PaymentExceptionStatus"],
  ["NOTIFICATION_KINDS", constants.NOTIFICATION_KINDS, "NotificationKind"],
  ["NOTIFICATION_DELIVERY_STATUSES", constants.NOTIFICATION_DELIVERY_STATUSES, "DeliveryStatus"],
  ["SETTLEMENT_ENTRY_KINDS", constants.SETTLEMENT_ENTRY_KINDS, "SettlementKind"],
  ["SETTLEMENT_ENTRY_STATUSES", constants.SETTLEMENT_ENTRY_STATUSES, "SettlementStatus"],
  ["STAFF_ACCOUNT_STATUSES", constants.STAFF_ACCOUNT_STATUSES, "StaffAccountStatus"],
  ["STAFF_ROLE_NAMES", constants.STAFF_ROLE_NAMES, "RoleName"],
  ["ROLE_GRANT_STATUSES", constants.ROLE_GRANT_STATUSES, "RoleGrantStatus"],
  ["AUDIT_ACTOR_KINDS", constants.AUDIT_ACTOR_KINDS, "AuditActorKind"],
  ["PLATFORM_FEE_CATEGORIES", constants.PLATFORM_FEE_CATEGORIES, "PlatformFeeCategory"],
  ["HOLIDAY_KINDS", constants.HOLIDAY_KINDS, "HolidayKind"],
  ["HOLIDAY_SOURCES", constants.HOLIDAY_SOURCES, "HolidaySource"],
  ["HOLIDAY_SYNC_STATUSES", constants.HOLIDAY_SYNC_STATUSES, "HolidaySyncStatus"],
  ["ACADEMY_OWNER_STATUSES", constants.ACADEMY_OWNER_STATUSES, "AcademyOwnerStatus"],
  ["ACADEMY_STATUSES", constants.ACADEMY_STATUSES, "AcademyStatus"],
  ["ACADEMY_REGISTRATION_TYPES", constants.ACADEMY_REGISTRATION_TYPES, "AcademyRegistrationType"],
  ["MERCHANT_APPLICATION_STATUSES", constants.MERCHANT_APPLICATION_STATUSES, "MerchantApplicationStatus"],
  ["MERCHANT_REJECT_REASONS", constants.MERCHANT_REJECT_REASONS, "MerchantRejectReason"],
  ["MERCHANT_DOCUMENT_KINDS", constants.MERCHANT_DOCUMENT_KINDS, "MerchantDocumentKind"],
  ["UPLOADED_FILE_PURPOSES", constants.UPLOADED_FILE_PURPOSES, "UploadedFilePurpose"],
  ["UPLOADED_FILE_VISIBILITIES", constants.UPLOADED_FILE_VISIBILITIES, "UploadedFileVisibility"],
  ["PAYOUT_ACCOUNT_STATUSES", constants.PAYOUT_ACCOUNT_STATUSES, "PayoutAccountStatus"],
  ["PAYOUT_VERIFICATION_STATUSES", constants.PAYOUT_VERIFICATION_STATUSES, "PayoutVerificationStatus"],
  ["PAYOUT_ACCOUNT_REJECT_REASONS", constants.PAYOUT_ACCOUNT_REJECT_REASONS, "PayoutAccountRejectReason"],
  ["TERMS_KINDS", constants.TERMS_KINDS, "TermsKind"],
  ["MERCHANT_CONSENT_SOURCES", constants.MERCHANT_CONSENT_SOURCES, "MerchantConsentSource"],
  ["BUSINESS_CHECK_TRIGGERS", constants.BUSINESS_CHECK_TRIGGERS, "BusinessCheckTrigger"],
  ["BUSINESS_CHECK_STATUSES", constants.BUSINESS_CHECK_STATUSES, "BusinessCheckStatus"],
  ["ACADEMY_RESTRICTION_KINDS", constants.ACADEMY_RESTRICTION_KINDS, "AcademyRestrictionKind"],
  ["REFUND_NOTICE_KINDS", constants.REFUND_NOTICE_KINDS, "RefundNoticeKind"],
  ["STAFF_NOTICE_CATEGORIES", constants.STAFF_NOTICE_CATEGORIES, "StaffNoticeCategory"],
  ["STAFF_NOTICE_STATUSES", constants.STAFF_NOTICE_STATUSES, "StaffNoticeStatus"],
  ["ROOM_STATUSES", constants.ROOM_STATUSES, "RoomStatus"],
  ["INSTRUCTOR_CREDENTIAL_KINDS", constants.INSTRUCTOR_CREDENTIAL_KINDS, "InstructorCredentialKind"],
  ["PERSONAL_EVENT_REPEATS", constants.PERSONAL_EVENT_REPEATS, "PersonalEventRepeat"],
  ["STAFF_CONSENT_SOURCES", constants.STAFF_CONSENT_SOURCES, "StaffConsentSource"],
  ["MEMBER_CONSENT_ITEMS", constants.MEMBER_CONSENT_ITEMS, "MemberConsentItem"],
  ["MEMBER_CONSENT_SOURCES", constants.MEMBER_CONSENT_SOURCES, "MemberConsentSource"],
  ["NOTIFICATION_CATEGORIES", constants.NOTIFICATION_CATEGORIES, "NotificationCategory"],
  ["AFFILIATION_STATUSES", constants.AFFILIATION_STATUSES, "AffiliationStatus"],
  ["AFFILIATION_SOURCES", constants.AFFILIATION_SOURCES, "AffiliationSource"],
  ["AFFILIATION_REJECT_REASONS", constants.AFFILIATION_REJECT_REASONS, "AffiliationRejectReason"],
  ["AFFILIATION_RELEASE_INITIATORS", constants.AFFILIATION_RELEASE_INITIATORS, "AffiliationReleaseInitiator"],
  ["AFFILIATION_RELEASE_REQUEST_STATUSES", constants.AFFILIATION_RELEASE_REQUEST_STATUSES, "AffiliationReleaseRequestStatus"],
  // 위임 값은 권한 판정 모듈(S0-3.5)이 소유한다. DB 값 집합은 웹 2종 + 앱 1종이다(S1-2.9 — 앱 class_submit 을 더했다).
  ["ASSIGNABLE_DELEGATION_PERMISSIONS", ASSIGNABLE_DELEGATION_PERMISSIONS, "DelegationPermission"],
  // 배포 환경 이름은 환경 변수 스키마(S0-6.2)가 소유한다 — DB 환경 표식(S0-6.3)이 이 값과 같아야 대조가 맞는다.
  ["DEPLOY_ENVIRONMENTS", DEPLOY_ENVIRONMENTS, "DeployEnvironment"],
  // S7-1.2(푸시 토큰·알림 설정 테이블)
  ["PRE_CLASS_LEADS", constants.PRE_CLASS_LEADS, "PreClassLead"],
  ["STAFF_NOTIFICATION_TOPICS", constants.STAFF_NOTIFICATION_TOPICS, "StaffNotificationTopic"],
  ["PUSH_PLATFORMS", constants.PUSH_PLATFORMS, "PushPlatform"],
  ["PUSH_PERMISSION_STATES", constants.PUSH_PERMISSION_STATES, "PushPermissionState"],
  // S7-2.1(문의·답변·신고 테이블)
  ["INQUIRY_KINDS", constants.INQUIRY_KINDS, "InquiryKind"],
  ["INQUIRY_ASKER_KINDS", constants.INQUIRY_ASKER_KINDS, "InquiryAskerKind"],
  ["INQUIRY_ROUTES", constants.INQUIRY_ROUTES, "InquiryRoute"],
  ["INQUIRY_STATUSES", constants.INQUIRY_STATUSES, "InquiryStatus"],
  ["INQUIRY_CATEGORIES", constants.INQUIRY_CATEGORIES, "InquiryCategory"],
  ["INQUIRY_MESSAGE_SENDER_KINDS", constants.INQUIRY_MESSAGE_SENDER_KINDS, "InquiryMessageSenderKind"],
  ["REPORT_REPORTER_KINDS", constants.REPORT_REPORTER_KINDS, "ReportReporterKind"],
  ["REPORT_TARGET_KINDS", constants.REPORT_TARGET_KINDS, "ReportTargetKind"],
  ["REPORT_STATUSES", constants.REPORT_STATUSES, "ReportStatus"],
  ["REPORT_OUTCOMES", constants.REPORT_OUTCOMES, "ReportOutcome"],
  ["REPORT_REASON_CODES", constants.REPORT_REASON_CODES, "ReportReasonCode"],
  // S7-2.7(문의·신고 첨부 파일)
  ["ATTACHMENT_OWNER_KINDS", constants.ATTACHMENT_OWNER_KINDS, "AttachmentOwnerKind"],
  // S7-2.6(이용 제한 절차)
  ["RESTRICTION_SUBJECT_KINDS", constants.RESTRICTION_SUBJECT_KINDS, "RestrictionSubjectKind"],
  ["RESTRICTION_SOURCES", constants.RESTRICTION_SOURCES, "RestrictionSource"],
  ["RESTRICTION_MEASURES", constants.RESTRICTION_MEASURES, "RestrictionMeasure"],
  ["RESTRICTION_STATES", constants.RESTRICTION_STATES, "RestrictionState"],
  // S6-3.1(레벨·카드·후보 동의 테이블)
  ["LEVEL_DETAIL_GENRES", constants.LEVEL_DETAIL_GENRES, "LevelDetailGenre"],
  ["LEVEL_PROMOTION_SOURCES", constants.LEVEL_PROMOTION_SOURCES, "LevelPromotionSource"],
  ["LEVEL_OFFER_STATUSES", constants.LEVEL_OFFER_STATUSES, "LevelOfferStatus"],
];

describe("constants.ts 값 집합 ↔ 계약 PSL enum", () => {
  test.each(PAIRS)("%s 는 계약 enum %s 와 문자 단위로 같다", (_name, values, enumName) => {
    const contractValues = contractEnums.get(enumName);
    expect(contractValues, `계약에 enum ${enumName} 이 없다`).toBeDefined();
    // 순서까지 같아야 한다(값이 같아도 순서가 다르면 한쪽을 손댄 흔적이다).
    expect([...values]).toEqual(contractValues);
  });

  test("계약 enum 은 전부 constants.ts 짝이 있다(빠뜨린 enum 이 없다)", () => {
    const covered = new Set(PAIRS.map(([, , enumName]) => enumName));
    const missing = [...contractEnums.keys()].filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  test("결제수단은 4종이다(FR-280 결제수단 결정)", () => {
    expect([...constants.PAYMENT_METHODS]).toEqual(["virtual_account", "card", "easy_transfer", "easy_pay"]);
  });
});
