// S0-3.11(역할 4종 × 보호 경로 권한 행렬 테스트) — M0 완료 기준 「허용 밖 요청 0건」을 표 하나로 확인한다.
//   근거: 플랜 _workspace/06_master-plan.md 6-3(권한 표) · S0-3 수용 ①~④ · 계약 README §6-2(requireStaff 판정 순서)·§6-4(오류 코드)
//   관련: FR-004(역할 4종) · FR-005(역할별 데이터 범위) · FR-081a(강사 위임 범위) · FR-300(주소로 직접 들어가도 서버가 막는다) ·
//         FR-303(관리자 웹 2단계 인증, 운영자는 대표가 못 만든다)
//
// 읽는 법:
//   - 열(ACTORS) = 요청을 보내는 사람. 역할 4종(회원·강사·대표·운영자)에 「로그인 안 함」과 변형(위임 강사·다른 학원 대표·
//     2단계 전 세션)을 더했다.
//   - 행(MATRIX) = 보호 경로 하나. 칸에는 그 사람이 받아야 할 응답(상태 + code)을 손으로 적는다.
//   - 모든 칸을 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 실제 호출해 표와 견준다.
//   - 「허용 밖」 = 표는 막으라는데(4xx) 실제로 열린(2xx) 칸. 이 수가 0 이어야 한다.
//
// 새 경로가 생기면: MATRIX 에 한 줄 더한다. app/api/**/route.ts 가 늘었는데 ROUTE_FILE_COVERAGE 에 없으면
// 「모든 route.ts 가 표에 있다」 테스트가 실패한다 — 표에 넣는 것을 잊을 수 없게 묶어 두었다.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { STAFF_ROLE_NAMES } from "@/lib/domain/constants";
import { systemClock } from "@/lib/domain/time";
import { FakeNotificationSender } from "@/lib/server/fakes/fake-notification-sender";
import { FakeInstructorMembership } from "@/lib/server/fakes/fake-instructor-membership";
import { createInstructorLevelEvaluationsRoute, createInstructorMemberLevelsRoute } from "@/lib/server/services/instructor-level-evaluations";
import { createMeContactConsentRoutes } from "@/lib/server/services/me-contact-consent";
import {
  createNewClassCandidateListRoute,
  createNewClassCandidatesRoute,
  createRevealCandidateContactRoute,
} from "@/lib/server/services/new-class-candidates";
import { createMeLevelOfferRoutes } from "@/lib/server/services/me-level-offers";
import { createMeLevelsRoute } from "@/lib/server/services/me-levels";
import { createMeLevelCardsRoute } from "@/lib/server/services/me-level-cards";
import { createMeLevelCardRevealRoute } from "@/lib/server/services/me-level-card-reveal";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import { createCancelReservationRoute } from "@/lib/server/services/cancellation";
import { createCancellationPreviewRoute } from "@/lib/server/services/cancellation-preview";
import { createCancelOrderRoute } from "@/lib/server/services/order-cancel";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createConsoleRoute } from "@/lib/server/console-route";
import { createGuards } from "@/lib/server/guards";
import { parseJsonBody, withRoute } from "@/lib/server/http";
import { createFieldCipher } from "@/lib/server/field-encryption";
import { createGetMyApplicationRoute, createPutDraftRoute } from "@/lib/server/services/merchant-application-draft";
import { createSubmitApplicationRoute } from "@/lib/server/services/merchant-application-submit";
import { createWithdrawApplicationRoute } from "@/lib/server/services/merchant-application-withdraw";
import {
  createGetMerchantApplicationRoute,
  createListMerchantApplicationsRoute,
} from "@/lib/server/services/admin-merchant-applications";
import { createApproveRoute, createRejectRoute, createStartReviewRoute } from "@/lib/server/services/admin-merchant-review";
import { createRegistrationChangeRoute } from "@/lib/server/services/academy-registration-change";
import { createAcademyProfileRoute } from "@/lib/server/services/academy-profile";
import { createAcademyAppPageRoute } from "@/lib/server/services/academy-app-page";
import { createArchiveRoomRoute, createCreateRoomRoute, createListRoomsRoute } from "@/lib/server/services/academy-rooms";
import {
  createCreateStaffNoticeRoute,
  createPublishStaffNoticeRoute,
  createUpdateStaffNoticeRoute,
} from "@/lib/server/services/academy-staff-notices";
import {
  createListAcademyStaffNoticesRoute,
  createListInstructorStaffNoticesRoute,
  createReadInstructorStaffNoticeRoute,
} from "@/lib/server/services/staff-notice-reads";
import { createCreateInviteRoute, createListInvitesRoute, createRevokeInviteRoute } from "@/lib/server/services/academy-invites";
import { createAcceptInviteRoute } from "@/lib/server/services/instructor-invite-accept";
import { createApproveAffiliationRoute, createRejectAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { createListAcademyAffiliationsRoute } from "@/lib/server/services/academy-affiliation-list";
import { createOwnerDashboardRoute } from "@/lib/server/services/owner-dashboard";
import { createUpdateAffiliationPermissionsRoute } from "@/lib/server/services/academy-affiliation-permissions";
import { createUpdateAffiliationEmploymentRoute } from "@/lib/server/services/academy-affiliation-employment";
import { createReleaseAffiliationRoute } from "@/lib/server/services/academy-affiliation-release";
import {
  createGetShareRatesRoute,
  createUpdateShareRateOverrideRoute,
  createUpdateShareRateRoute,
} from "@/lib/server/services/academy-share-rates";
import {
  createApplyAffiliationRoute,
  createListMyAffiliationsRoute,
  createWithdrawAffiliationRoute,
} from "@/lib/server/services/instructor-affiliations";
import { createSearchAcademiesRoute, createSetAffiliationColorRoute } from "@/lib/server/services/instructor-academies";
import { createListAffiliationRoomsRoute } from "@/lib/server/services/instructor-affiliation-rooms";
import { createPutBusinessRegistrationRoute } from "@/lib/server/services/instructor-business-registration";
import { createInstructorPersonalEventRoutes } from "@/lib/server/services/instructor-personal-events";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { createClassPosterRoute } from "@/lib/server/services/class-poster";
import { createClassPromoAssetsRoutes } from "@/lib/server/services/class-promo-assets";
import { createClassWithdrawRoute } from "@/lib/server/services/class-withdrawal";
import {
  createClassApprovalListRoute,
  createClassSessionListRoute,
  createInstructorClassListRoute,
} from "@/lib/server/services/class-list-reads";
import { createSessionChangeRoutes } from "@/lib/server/services/session-changes";
import { createClassAnnouncementRoutes } from "@/lib/server/services/class-announcements";
import { createClassEditRequestRoutes } from "@/lib/server/services/class-edit-requests";
import { createInstructorScheduleRoutes } from "@/lib/server/services/instructor-schedule";
import { createInstructorDashboardRoute } from "@/lib/server/services/instructor-dashboard";
import { createInstructorHeadcountRoute } from "@/lib/server/services/instructor-headcount";
import { createPrivateLessonBookingRoutes } from "@/lib/server/services/private-lesson-bookings";
import { createPrivateLessonProductRoutes } from "@/lib/server/services/private-lesson-products";
import { createPrivateLessonRuleRoutes } from "@/lib/server/services/private-lesson-rules";
import { createPrivateLessonSlotRoutes } from "@/lib/server/services/private-lesson-slots";
import { createSubstituteRequestRoutes } from "@/lib/server/services/substitute-requests";
import { createClassScheduleCheckRoute } from "@/lib/server/services/class-schedule-check";
import { createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createInstructorProfileRoutes } from "@/lib/server/services/instructor-profile";
import { createReleaseRequestRoute } from "@/lib/server/services/instructor-release-request";
import {
  createDeclineReleaseRequestRoute,
  createListReleaseRequestsRoute,
  createWithdrawReleaseRequestRoute,
} from "@/lib/server/services/affiliation-release-request-decisions";
import {
  createInstructorReleasePreviewRoute,
  createOwnerReleasePreviewRoute,
} from "@/lib/server/services/affiliation-release-preview";
import { createPayoutAccountChangeRoute } from "@/lib/server/services/academy-payout-account";
import { createAcademySettingsRoute } from "@/lib/server/services/academy-settings";
import { createRoleGrantService } from "@/lib/server/services/role-grants";
import { createStaffMeRoute } from "@/lib/server/services/staff-me";
import {
  createListStaffNotificationsRoute,
  createReadAllStaffNotificationsRoute,
  createReadStaffNotificationRoute,
  createStaffUnreadCountRoute,
} from "@/lib/server/services/staff-notifications";
import { createAcademyConsentsRoute, createReadTermsNoticeRoute, createTermsVersionRoute } from "@/lib/server/services/terms-consent-records";
import { createRefundNoticeReadRoutes } from "@/lib/server/services/refund-notice-read";
import { createRefundNoticePublishRoute } from "@/lib/server/services/refund-notice-publish";
import { createPublishTermsVersionRoute } from "@/lib/server/services/terms-version-publish";
import { createAdminBusinessCheckRoutes } from "@/lib/server/services/admin-business-checks";
import { createAdminHolidaysRoutes } from "@/lib/server/services/admin-holidays";
import { createUploadFileRoute } from "@/lib/server/services/file-upload";
import { createDownloadFileRoute } from "@/lib/server/services/file-download";
import { createNoShowPolicyRoute } from "@/lib/server/services/no-show-policy";
import { createMerchantOnboardingTermsRoute } from "@/lib/server/services/merchant-onboarding-terms";
import { MERCHANT_ONBOARDING_ITEMS } from "@/lib/domain/merchant-consents";
import type { FileStoragePort } from "@/lib/server/ports/file-storage";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";
import { createMemberNotificationSettingsRoutes } from "@/lib/server/services/member-notification-settings";
import { createMemberSignupRoutes } from "@/lib/server/services/member-signup";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { createOwnerHeadcountRoute } from "@/lib/server/services/owner-headcount";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";
import { createMemberContactRevealRoute } from "@/lib/server/services/member-contact-reveal";
import { createAcademyMemberDetailRoute, createAcademyMembersRoute } from "@/lib/server/services/academy-members";
import { createOwnerOrderDetailRoute, createOwnerOrdersRoute } from "@/lib/server/services/owner-orders";
import { createPosterExtractionRoutes } from "@/lib/server/services/poster-extractions";
import { createAbsenceDisputeRoutes } from "@/lib/server/services/absence-disputes";
import { createStaffAbsenceMarkRoutes } from "@/lib/server/services/staff-absence-marks";
import { createSessionOnsiteHeadcountRoute } from "@/lib/server/services/session-onsite-headcount";
import { createSessionRosterRoute } from "@/lib/server/services/session-roster";
import { createHomeOfferingsRoute } from "@/lib/server/services/home-offerings";
import { createInstructorPublicProfileRoute } from "@/lib/server/services/instructor-public-profile";
import { createMeCalendarRoute } from "@/lib/server/services/me-calendar";
import { createMeNotificationsRoute } from "@/lib/server/services/me-notifications";
import { createMeOrdersRoute } from "@/lib/server/services/me-orders";
import { createPushTokenRoutes } from "@/lib/server/services/push-tokens";
import { createMeSessionAbsenceRoutes } from "@/lib/server/services/me-session-absence";
import { createOfferingDetailRoute } from "@/lib/server/services/offering-detail";
import { createOrderDetailRoute } from "@/lib/server/services/order-detail";
import { createRefundRequestRoute, createWithdrawRefundRequestRoute } from "@/lib/server/services/refund-requests";
import { createSaveRefundAccountRoute } from "@/lib/server/services/refund-accounts";
import { createRefundDecisionRoute, createRefundRequestDetailRoute } from "@/lib/server/services/refund-decisions";
import { createInquiryReplyRoutes } from "@/lib/server/services/inquiry-replies";
import { createRestrictionRoutes } from "@/lib/server/services/restrictions";
import { createReportRoutes } from "@/lib/server/services/reports";
import { createAiChatRoute } from "@/lib/server/ai/ai-chat-route";
import { insertCancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { staffSessionCookie } from "../setup/staff-cookie";

const SECRET = "permission-matrix-test-secret-0123456789-0123";
const BASE = "http://localhost:3000";
const APP_ROOT = join(__dirname, "..", "..");

// ---- 열: 요청을 보내는 사람 ------------------------------------------------------------------
// 역할 4종 = member(회원) · instructor(강사) · owner(대표) · admin(운영자). 나머지는 같은 역할의 변형이다.
const ACTORS = [
  "anonymous", //        로그인 안 함
  "member", //           회원(앱). 직원 계정이 없다(FR-011a — 회원과 직원은 다른 계정)
  "instructor", //       강사. 학원 A 에 소속돼 있지만 위임이 없다
  "delegateRoster", //   위임 강사. 학원 A 에서 명단 관리(roster_manage)를 받았다
  "delegateClass", //    위임 강사. 학원 A 에서 수업 관리(class_manage)를 받았다
  "delegateNo2fa", //    위임 강사(roster_manage)인데 인증 앱을 아직 켜지 않았다 — 1단계(비밀번호)만 마친 세션
  "ownerA", //           학원 A 의 대표
  "ownerB", //           학원 B 의 대표 — 학원 A 에는 아무 권한이 없다
  "admin", //            운영자
] as const;
type ActorKey = (typeof ACTORS)[number];

// ---- 칸에 적는 기대값 ------------------------------------------------------------------------
// 짧은 이름으로 적어 표를 한눈에 읽게 한다. 2xx 는 허용, 나머지는 거부.
const OK = "200";
const CREATED = "201";
const NO_SESSION = "401 UNAUTHENTICATED";
const NEED_2FA = "401 SECOND_FACTOR_REQUIRED";
const NOT_STAFF = "403 STAFF_ACCOUNT_REQUIRED";
const FORBIDDEN = "403 FORBIDDEN";
const NOT_MEMBER = "403 SIGNUP_INCOMPLETE";
// 권한은 통과했고 그다음 검사(필수 헤더 Idempotency-Key 없음)에서 멈춘 칸 — 권한 거부가 아니다(S1-1.11 제출 행)
const PASSED_NO_KEY = "400 BAD_REQUEST";
// 권한은 통과했고 그다음 검사(그 id 의 신청이 없음)에서 멈춘 칸 — 권한 거부가 아니다(S1-1.13 운영자 상세 행)
const PASSED_NOT_FOUND = "404 NOT_FOUND";
// 권한은 통과했고 그다음 검사(본문 {} 에 필수 칸이 없음)에서 멈춘 칸 — 권한 거부가 아니다(S1-1.15 반려 행)
const PASSED_INVALID_BODY = "422 VALIDATION_FAILED";
// 권한은 통과했고 그다음 검사(본문이 multipart 가 아님)에서 멈춘 칸 — 권한 거부가 아니다(S1-1.6 파일 올리기 행).
// PASSED_NO_KEY 와 글자는 같지만 멈춘 까닭이 달라 이름을 따로 둔다
const PASSED_NOT_MULTIPART = "400 BAD_REQUEST";
// 권한은 통과했고 그다음 검사(본문 {} 에 연락처 열람 사유가 없음)에서 멈춘 칸 — 권한 거부가 아니다(M3-FIX.1 연락처 보기 행)
const PASSED_NO_REASON = "422 CONTACT_REASON_REQUIRED";
// 회원 칸이 회원 가드를 통과했고 그다음 검사(기준 장르를 아직 안 골랐음)에서 멈춘 칸 — 권한 거부가 아니다(M3-FIX.1 홈 목록 행)
const PASSED_NO_BASE_GENRE = "409 BASE_GENRE_REQUIRED";
type Expected = typeof PASSED_NO_REASON | typeof PASSED_NO_BASE_GENRE | typeof OK | typeof CREATED | typeof PASSED_NO_KEY | typeof PASSED_NOT_MULTIPART | typeof PASSED_NOT_FOUND | typeof PASSED_INVALID_BODY | typeof NO_SESSION | typeof NEED_2FA | typeof NOT_STAFF | typeof FORBIDDEN | typeof NOT_MEMBER;
type Row = Record<ActorKey, Expected>;

const isAllowed = (cell: string) => cell.startsWith("2");

// ---- 행: 보호 경로 ----------------------------------------------------------------------------
// 키는 경로 이름. 실제 route.ts 가 있는 경로는 그 처리기(또는 route.ts 가 쓰는 같은 공장 함수)를 부르고,
// 아직 route.ts 가 없는 콘솔 메뉴는 콘솔 래퍼(createConsoleRoute — 콘솔 경로를 만드는 유일한 길)로 감싼 시험용 경로를 부른다.
// 그 메뉴의 실제 경로가 생기면 그 route.ts 의 처리기로 바꿔 끼운다.
const MATRIX = {
  // 실제 경로 · 계약 README §6-1. 「내가 무엇을 할 수 있나」를 묻는 경로라 직원이면 모두 200(2단계 전에도 — consoleAccess 로 답한다)
  "GET /api/staff/me": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: OK, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 실제 경로 · 내부 작업은 사람의 세션으로는 절대 열리지 않는다(X-Internal-Token 만, README §1)
  "POST /api/internal/jobs/holidays/sync": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 사업자 상태 매일 점검(S1-1.27) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/business-status/check": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 주인 없는 올린 파일 정리(S1-1.35) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/files/purge-unattached": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 수업 승인 24시간 재알림(S2-2.12) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/class-approval-reminders": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 대타 요청 만료(S2-3.11) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/substitute-requests-expire": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 개인 레슨 잡아 둔 시간 만료(S2-4.9) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/private-lesson-holds-expire": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 기한 지난 결제 대기 만료(S3-3.7, 계약 03 §5) — 위와 같이 사람의 세션으로는 열리지 않는다
  // 실제 경로 · 알림 발송 재시도(S7-1.6, 계약 15 §1-4) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/notifications/retry": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 수업 전 알림(S7-1.7, 계약 15 §1-4) — 위와 같이 사람의 세션으로는 열리지 않는다
  "POST /api/internal/jobs/notifications/pre-class": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  "POST /api/internal/orders/expire": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // 실제 경로 · 입점 신청 초안(S1-1.10, 계약 07 §2) — staff_self: 역할은 묻지 않고 2단계 인증을 마친 직원이면 누구나 자기 초안.
  // PUT 행을 GET 행보다 먼저 둔다 — 칸을 표 순서대로 부르므로 GET 때는 각자 만든 초안이 있어 200 이 된다
  "PUT /api/merchant-applications/me/draft": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  "GET /api/merchant-applications/me": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 실제 경로 · 입점 신청 제출(S1-1.11, 계약 07 §2) — 같은 staff_self. 표의 요청에는 Idempotency-Key 가 없어서,
  // 권한을 통과한 칸은 400 BAD_REQUEST 가 된다(권한 → 헤더 순서로 본다 — 막혀야 할 사람은 400 전에 401·403)
  "POST /api/merchant-applications/me/submit": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  // 실제 경로 · 입점 신청 철회(S1-1.12, 계약 07 §2) — 같은 staff_self. 위 PUT 행에서 각자 만든 초안이 있어 통과한 칸은 200
  // (제출 행은 키가 없어 400 으로 끝나 초안 그대로다). 철회 뒤에도 GET 행은 이미 앞에서 불렸다
  "POST /api/merchant-applications/me/withdraw": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 실제 경로 · 운영자 심사 목록·상세(S1-1.13, 계약 07 §3) — admin + 관리자 웹 2단계. 대표·강사는 403.
  // 상세 행은 없는 신청 id 로 부른다 — 권한을 통과한 운영자만 404 까지 간다(다른 사람은 그 전에 401·403)
  "GET /api/admin/merchant-applications": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  "GET /api/admin/merchant-applications/{id}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 심사 시작·승인(S1-1.14, 계약 07 §3) — 같은 admin + 관리자 웹 2단계. 없는 신청 id 로 부른다.
  // 심사 시작은 권한을 통과한 운영자만 404, 승인은 Idempotency-Key 가 먼저라 운영자만 400(권한 → 키 → id 순서)
  "POST /api/admin/merchant-applications/{id}/start-review": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  "POST /api/admin/merchant-applications/{id}/approve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NO_KEY,
  },
  // 실제 경로 · 심사 반려(S1-1.15, 계약 07 §3) — 같은 admin + 관리자 웹 2단계. 표의 본문은 {} 라 사유 코드가 없다 —
  // 권한 → 본문 → id 순서라 권한을 통과한 운영자만 422 까지 간다(다른 사람은 그 전에 401·403)
  "POST /api/admin/merchant-applications/{id}/reject": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_INVALID_BODY,
  },
  // 실제 경로 · 등록 형태 변경 신청(S1-1.17, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 표의 본문은 {} 라 registrationType 이 없다 — 권한 → 본문 순서라 학원 A 대표만 422 까지 간다(운영자·다른 학원 대표는 403)
  "POST /api/academies/{academyId}/registration-change": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 설정 조회(S1-1.18, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다. 읽기라 학원 A 대표는 200
  "GET /api/academies/{academyId}/settings": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 정보·판매자 정보 수정(S1-1.19, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 표의 본문은 {} 라 바꿀 칸이 없다 — 아무것도 바꾸지 않고 설정 본문을 돌려주므로 학원 A 대표는 200
  "PATCH /api/academies/{academyId}/profile": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 앱 페이지(S1-1.20, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 표의 본문은 {} 라 tagline·intro·photoFileIds 가 없다(PUT 전체 교체 — 셋 다 필수) → 학원 A 대표만 422 까지 간다
  "PUT /api/academies/{academyId}/app-page": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강의실 목록·추가·보관(S1-2.13, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 목록은 학원 A 대표만 200, 추가는 본문 {} 이라 학원 A 대표만 422, 보관은 없는 강의실 id 라 학원 A 대표만 404
  "GET /api/academies/{academyId}/rooms": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/rooms": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/rooms/{roomId}/archive": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 공지 초안·수정·올리기(S1-4.3, 계약 09 §3) — owner + 관리자 웹 2단계. 위임 강사도 403(위임 2종 밖). 학원 A 로 부른다.
  // 만들기·고치기는 본문 {} 이라 학원 A 대표만 422, 올리기는 없는 공지 id 라 학원 A 대표만 404
  "POST /api/academies/{academyId}/staff-notices": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "PATCH /api/academies/{academyId}/staff-notices/{noticeId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/staff-notices/{noticeId}/publish": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 대표 지난 공지(S1-4.4, 계약 09 §3) — 쓰기와 같은 owner + 관리자 웹 2단계. 위임 강사 403. 학원 A 로 부른다
  "GET /api/academies/{academyId}/staff-notices": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 정산 계좌 변경(S1-1.21, 계약 07 §4) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 표의 요청에는 Idempotency-Key 가 없다 → 학원 A 대표만 400 까지 간다(계좌·인증 앱 코드는 보지도 않는다)
  "PUT /api/academies/{academyId}/payout-account": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 초대 링크 만들기·목록·폐기(S1-2.4, 계약 08 §1) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 위임 강사도 못 쓴다(08 열린 점 ③ — 초대는 대표 고유 권한). 만들기는 본문 {} 그대로 201, 목록은 200.
  // 폐기는 없는 링크 id 로 부른다 — 권한을 통과한 학원 A 대표만 404 까지 간다
  "POST /api/academies/{academyId}/invites": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: CREATED, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/invites": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/invites/{inviteId}/revoke": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 목록(S1-2.8, 계약 08 §3) — owner + 관리자 웹 2단계. 위임 강사도 못 본다(대표 고유 권한). 학원 A 로 부른다
  "GET /api/academies/{academyId}/affiliations": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 대표 대시보드(S1-4.5, 계약 10 §1) — owner + 관리자 웹 2단계. 위임 강사는 403(재무 대시보드는 위임 대상 밖, FR-081a)
  "GET /api/academies/{academyId}/dashboard": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 승인·거절(S1-2.7, 계약 08 §3) — owner + 관리자 웹 2단계. 위임 강사도 못 쓴다(대표 고유 권한).
  // 본문 {} 라 isAcademyEmployee·reasonCode 가 없다 → 학원 A 대표만 본문 검사(422)까지 간다
  "POST /api/academies/{academyId}/affiliations/{id}/approve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/affiliations/{id}/reject": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 위임 권한 켜고 끄기(S1-2.9, 계약 08 §4) — owner + 관리자 웹 2단계. 위임 강사는 못 쓴다(시나리오 6).
  // 본문 {} 라 permissions 가 없다 → 학원 A 대표만 본문 검사(422)까지 간다
  "PUT /api/academies/{academyId}/affiliations/{id}/permissions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 직원 켜고 끄기(S1-2.11, 계약 08 §4) — owner + 관리자 웹 2단계. 정산에 닿아 위임 강사는 못 쓴다(FR-081a).
  // 본문 {} 라 isAcademyEmployee 가 없다 → 학원 A 대표만 본문 검사(422)까지 간다
  "PUT /api/academies/{academyId}/affiliations/{id}/employment": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 해제(S1-2.12, 계약 08 §5) — owner + 관리자 웹 2단계. 위임 강사는 못 쓴다(대표 고유 권한).
  // 표의 요청에는 Idempotency-Key 가 없다 → 학원 A 대표만 400 까지 간다(권한 → 키 → 본문 → id 순서)
  "POST /api/academies/{academyId}/affiliations/{id}/release": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 해제 미리 보기(S2-3.6, 계약 11 §9-1) — owner + 관리자 웹 2단계. 위임 강사는 못 쓴다(release 와 같다).
  // 본문 {} 는 받는다(남은 것 목록만) → 없는 소속 id 라 학원 A 대표만 404 까지 간다
  "POST /api/academies/{academyId}/affiliations/{id}/release-preview": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 해제 요청 목록·거절(S2-3.13, 계약 11 §9) — owner + 관리자 웹 2단계. 위임 강사는 못 쓴다(release 와 같다).
  // 목록은 요청이 없어도 빈 목록이라 학원 A 대표만 200, 거절은 본문 {}(사유 없음)이라 학원 A 대표만 본문 검사(422)까지 간다
  "GET /api/academies/{academyId}/affiliation-release-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 몫 비율 조회·변경·수업별 예외(S1-2.10, 계약 08 §4-1) — owner + 관리자 웹 2단계.
  // 위임 강사는 볼 수도 바꿀 수도 없다(정산은 위임 대상 밖, FR-081a). 조회는 없는 소속 id 라 학원 A 대표만 404 까지,
  // 두 PUT 은 본문 {} 이라 학원 A 대표만 본문 검사(422)까지 간다
  "GET /api/academies/{academyId}/affiliations/{id}/share-rates": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "PUT /api/academies/{academyId}/affiliations/{id}/share-rate": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 초대 링크 수락(S1-2.5, 계약 08 §2) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 없는 토큰으로 부른다 — 강사 역할인 사람(위임 여부·2단계 여부와 무관)만 404 까지 가고, 대표·운영자는 403
  "POST /api/instructor/invites/{token}/accept": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 신청·철회·내 소속 목록(S1-2.6, 계약 08 §2) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 신청은 빈 본문 {} 이라 강사만 본문 검사(422)까지 가고, 철회는 없는 id 라 강사만 404 까지 간다. 대표·운영자는 403
  "POST /api/instructor/affiliations": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/affiliations/{id}/withdraw": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/affiliations": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 쪽 해제 요청(S2-1.4, 계약 11 §3-3) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 표의 요청에는 Idempotency-Key 가 없다 → 강사 역할인 사람만 400 까지 간다(권한 → id 모양 → 키 순서). 대표·운영자는 403
  "POST /api/instructor/affiliations/{id}/release-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY,
    delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 쪽 해제 미리 보기(S2-3.6, 계약 11 §3 · §9-1) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 없는 소속 id 라 강사 역할인 사람만 404 에서 멈춘다. 대표·운영자는 403
  "POST /api/instructor/affiliations/{id}/release-preview": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 쪽 해제 요청 취소(S2-3.13, 계약 11 §3-3) — instructor 역할 + 본인 요청, 강사 앱(2단계를 묻지 않음).
  // 없는 요청 id 라 강사 역할인 사람만 404 에서 멈춘다. 대표·운영자는 403
  "POST /api/instructor/affiliation-release-requests/{requestId}/withdraw": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 학원 검색·학원 색(S2-1.9, 계약 11 §3-1·§3-2) — instructor 역할 + 강사 앱(2단계를 묻지 않음). 대표·운영자는 403.
  // 검색은 q 없이 부르면 받는 학원 목록(200). 색은 본문 {} 라 강사 역할인 사람만 본문 검사(422)까지 간다
  "GET /api/instructor/academies": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "PUT /api/instructor/affiliations/{id}/color": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 소속 학원 홀 목록(S2-2.8a, 계약 11 §3-4) — instructor 역할 + 강사 앱(2단계를 묻지 않음). 대표·운영자는 403.
  // 없는 소속 id 라 강사 역할인 사람은 404 에서 멈춘다. 소속·위임 판정 자체는 instructor-affiliation-rooms.db.test.ts 가 본다
  "GET /api/instructor/affiliations/{id}/rooms": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 사업자등록번호·등록증(S2-1.2b, 계약 11 §2-2) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 본문 {} 는 「둘 다 비우기」라 모양은 맞고, 표의 강사들은 가입 경로 밖에서 만들어 프로필이 없어 404 까지 간다. 대표·운영자는 403
  "PUT /api/instructor/me/business-registration": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 프로필·개인 일정(S2-1.6, 계약 11 §2-1·§2-3) — instructor 역할 + 강사 앱(2단계를 묻지 않음). 대표·운영자는 403.
  // 프로필: 표의 강사들은 가입 경로 밖에서 만들어 프로필이 없어 404 까지 간다(PUT 본문 {} 는 「전부 비우기」라 모양은 맞다).
  // 개인 일정: 넣기는 본문 {} 에 제목·시각이 없어 422, 지우기는 없는 일정 id 라 404 까지 간다
  "GET /api/instructor/me/profile": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "PUT /api/instructor/me/profile": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 수업 등록(S2-2.3, 계약 11 §4-2·§4-4) — 직원이면 판정까지 들어간다. 만들기는 Idempotency-Key 가 없어 400,
  // 상세·고치기·승인 요청은 없는 수업 id 라 404 에서 멈춘다(권한 거부가 아니다). 소속·위임 판정 자체는 class-registration.db.test.ts 가 본다
  "POST /api/classes": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY,
    delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "GET /api/classes/{classId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "PUT /api/classes/{classId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 수업 포스터(S2-2.8, 계약 11 §4-6) — 수업 등록 행과 같은 판정. 없는 수업 id 라 404 에서 멈춘다.
  // 파일·수업 권한 판정 자체는 class-poster.db.test.ts 가 본다
  "PUT /api/classes/{classId}/poster": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 수업 홍보 표지·소개 문구(SX-6.7, 계약 16 §4-7) — 수업 등록 행과 같은 판정. 없는 수업 id 라 404 에서 멈춘다.
  // 고를 수 있는 파일·생성·초안과 게시 관문은 class-promo-assets.db.test.ts 가 본다
  "GET /api/classes/{classId}/promo-assets": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "PUT /api/classes/{classId}/promo-assets": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/submit": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 수업 일정 겹침 미리보기(S2-2.8c, 계약 11 §4-1) — 직원이면 판정까지 들어간다. 본문 {} 에 학원·일정이 없어 422 에서 멈춘다.
  // class_writer 판정(소속·위임)과 미리보기 내용은 class-schedule-check.db.test.ts 가 본다
  "POST /api/classes/schedule-check": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: PASSED_INVALID_BODY, ownerB: PASSED_INVALID_BODY,
    admin: PASSED_INVALID_BODY,
  },
  // 실제 경로 · 수업 등록 취소(S2-2.8b, 계약 11 §4-4) — 직원이면 판정까지 들어간다. 없는 수업 id 라 404 에서 멈춘다.
  // 「올린 사람만」 판정과 상태 전이 자체는 class-withdrawal.db.test.ts 가 본다
  "POST /api/classes/{classId}/withdraw": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 회차 시간·장소 변경·휴강(S2-3.2, 계약 11 §6) — 직원이면 판정까지 들어간다. 없는 수업·회차 id 라 404 에서 멈춘다.
  // 「올린 사람·담당 강사·대표만」 판정과 변경 기록·알림 자체는 session-change-notifications.db.test.ts 가 본다
  "POST /api/classes/{classId}/sessions/{sessionId}/change-preview": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/sessions/{sessionId}/change": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/sessions/{sessionId}/cancel-preview": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/sessions/{sessionId}/cancel": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 강사 수업 공지(S2-3.5, 계약 11 §6-3). 직원이면 판정까지 들어간다 — 받는 사람 수·목록은 없는 수업 id 라 404,
  // 보내기는 키가 없어 400 에서 멈춘다. 회원용 「강사 공지」는 회원만(직원 세션은 회원 행이 없어 403), 없는 수업이라 404.
  // 「올린 사람·담당 강사·대표만」 판정과 공지·알림 행 자체는 class-announcements.db.test.ts 가 본다
  "GET /api/classes/{classId}/announcement-recipients": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/announcements": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY,
    delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "GET /api/classes/{classId}/announcements": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 회원 가입 완료(S3-1.2, 계약 01 §3) — 가입 전이라 회원 행이 없어도 된다(세션만 본다). 세션이 있으면 누구나 본문 검사(422)까지 간다.
  // 직원 세션을 막는 칸은 계약에 없다 — 판정은 member-signup.db.test.ts
  "POST /api/members": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: PASSED_INVALID_BODY, ownerB: PASSED_INVALID_BODY,
    admin: PASSED_INVALID_BODY,
  },
  // 회원 취향·기준 장르(S3-1.5, 계약 01 §4~§6) — 회원 가드. 직원 계정에는 회원 행이 없어 403 SIGNUP_INCOMPLETE.
  // 회원은 조회 200, 저장은 본문 {} 에 관심 장르·기준 장르가 없어 본문 검사(422)에서 멈춘다. 판정은 member-profile.db.test.ts
  "GET /api/me": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "PUT /api/me/profile": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S7-1.4(알림 설정 API) — 회원만. 직원 설정은 /api/staff/notification-settings 가 따로 맡는다
  "GET /api/me/notification-settings": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "PUT /api/me/notification-settings": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "PUT /api/me/base-genre": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/me/classes/{classId}/announcements": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 실제 경로 · 대타(S2-3.4, 계약 11 §8). 후보 목록은 직원이면 판정까지 들어가 없는 회차 id 라 404 에서 멈춘다
  // (「담당 강사·대표만」 판정은 substitute-request-flow.db.test.ts). 강사 경로는 강사 역할이 없으면 403, 있으면 다음 검사
  // (키 없음 400 · 없는 요청 404)에서 멈춘다. 대표 경로는 owner 만 — 학원 A 대표는 목록 200, 없는 요청 확인 404
  "GET /api/sessions/{sessionId}/substitute-candidates": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/instructor/substitute-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY,
    delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/substitute-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/substitute-requests/{requestId}/accept": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/substitute-requests/{requestId}/decline": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/substitute-requests/{requestId}/cancel": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/substitute-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: FORBIDDEN, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: FORBIDDEN, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 대표 수업 승인·수정 요청(S2-2.7, 계약 11 §4-5) — owner 만(위임 강사도 못 쓴다). 없는 수업 id 라
  // 학원 A 대표는 권한을 통과한 뒤 404 에서 멈춘다(권한 거부가 아니다). 앱(Bearer)·웹(쿠키) 둘 다 받는 경로라 2단계 판정은 쿠키일 때만 —
  // 이 표의 요청은 Bearer 라 delegateNo2fa 는 대표가 아니어서 403 이다(수업 등록 행과 같은 방식). 승인·반려 자체는 class-approval.db.test.ts 가 본다
  "POST /api/academies/{academyId}/classes/{classId}/approve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: FORBIDDEN, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/classes/{classId}/request-revision": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: FORBIDDEN, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 수업 목록 읽기(S2-2.13, 계약 11 §4 · §4-5 · §4-6).
  // 내 수업 목록은 강사 역할이 있으면 200(대표·운영자는 403). 회차 목록은 직원이면 판정까지 들어가 없는 수업 id 라 404.
  // 승인 대기 목록은 그 학원 대표만 200. 「자기가 올린 수업만」·상태 거르기·커서는 class-list-reads.db.test.ts 가 본다
  "GET /api/instructor/classes": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/classes/{classId}/sessions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "GET /api/academies/{academyId}/class-approvals": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: FORBIDDEN, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/personal-events": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "DELETE /api/instructor/personal-events/{eventId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 학원 공지 조회·읽음(S1-4.4, 계약 09 §3) — instructor 역할 + 강사 앱(2단계를 묻지 않음).
  // 읽음은 없는 공지 id 라 강사만 404 까지 간다. 대표·운영자는 403
  "GET /api/instructor/staff-notices": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/staff-notices/{noticeId}/read": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 공개 뒤 수업 수정 요청(S2-3.12, 계약 11 §5) — 직원이면 판정까지 들어간다(readStaff → 키 → 수업 순서).
  // 만들기는 표의 요청에 Idempotency-Key 가 없어 400, 취소는 없는 수업·요청 id 라 404. 「올린 사람만」은 class-edit-requests.db.test.ts 가 본다
  "POST /api/classes/{classId}/edit-requests": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY,
    ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 대표 승인·반려(S2-3.12, 계약 11 §5) — 그 학원 대표만. 앱(Bearer)·웹 둘 다 받는 경로라 이 표(Bearer)에서는 2단계를 묻지 않는다.
  // 없는 요청 id 라 학원 A 대표만 권한을 통과한 뒤 404
  "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN, delegateNo2fa: FORBIDDEN,
    ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN, delegateNo2fa: FORBIDDEN,
    ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 개인 레슨(S2-4.2·S2-4.7·S2-4.10, 계약 11 §10) — instructor 역할 + 강사 앱(2단계를 묻지 않음). 대표·운영자는 자기 학원이어도 403
  // (FR-052c 「개인 레슨은 대표도 볼 수 없다」). 목록·규칙 조회는 학원 A 소속이라 200, 키가 필수인 쓰기는 400, 없는 id 는 404,
  // 규칙 저장도 권한 → 키 → 본문 순서라 강사만 400 까지 간다(로그인 안 한 요청은 그 전에 401)
  "GET /api/instructor/private-lesson-products": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-products": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-products/{classId}/close": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-products/{classId}/slots": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "DELETE /api/instructor/private-lesson-slots/{slotId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/private-lesson-rules": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-rules": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/private-lesson-passes": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/private-lesson-passes/{passId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-passes/{passId}/bookings": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY, delegateNo2fa: PASSED_NO_KEY,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/private-lesson-bookings/{bookingId}/cancel": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND, delegateNo2fa: PASSED_NOT_FOUND,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 일정 대시보드(S2-4.5, 계약 11 §11) — instructor 역할. 세션의 계정 것만 읽는다. 대표·운영자는 403
  "GET /api/instructor/schedule": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 대시보드 집계(S3-5.6, 계약 18 §9) — instructor 역할. 자기 수업만 센다. 대표·운영자는 403
  "GET /api/instructor/dashboard": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 강사 하루 인원표(S3-5.9, 계약 18 §7 강사 경로) — instructor 역할. 자기 회차만. 대표·운영자는 403
  "GET /api/instructor/headcount": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // S6-3.4(강사 레벨 조절) — instructor 역할 + 강사 멤버십(가짜 = 멤버십). 권한을 지나면 없는 판매 단위라 404 · 빈 본문이라 422.
  //   대표·운영자는 instructor 역할이 없어 403. 그 수업 강사인지·결제 완료 수강생인지는 tests/db/instructor-level-evaluations.db.test.ts
  "GET /api/instructor/offerings/{offeringId}/member-levels": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: PASSED_NOT_FOUND, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/level-evaluations": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // S6-3.5(개강 후보) — instructor 역할 + 강사 멤버십(가짜 = 멤버십). 두 GET 은 조건 쿼리를 붙여 200(후보 0 명 포함),
  //   보기 POST 는 빈 본문이라 422. 대표·운영자는 instructor 역할이 없어 403. 동의 판정·학원 범위는 tests/db/new-class-candidates.db.test.ts
  "GET /api/instructor/new-class-candidates": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/instructor/new-class-candidates/list": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK, delegateNo2fa: OK,
    ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/instructor/new-class-candidates/{memberId}/reveal-contact": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY,
    delegateClass: PASSED_INVALID_BODY, delegateNo2fa: PASSED_INVALID_BODY, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 콘솔 · 대표 전용(매출·정산·금액 설정 — 위임으로는 열리지 않는다, FR-081a) · 학원 A
  "콘솔 owner 학원A(정산·금액)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 같은 메뉴를 학원 B 로 — 대표 A 가 남의 학원 id 로 부르면 403(S0-3 수용 ②, 404 로 숨기지 않는다)
  "콘솔 owner 학원B(정산·금액)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: OK, admin: FORBIDDEN,
  },
  // 콘솔 · 명단(roster_manage) · 학원 A — 위임 없는 강사가 주소로 들어오면 403(S0-3 수용 ①)
  "콘솔 roster_manage 학원A(예약·명단)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: OK, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 콘솔 · 수업(class_manage) · 학원 A
  "콘솔 class_manage 학원A(수업·포스터)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 콘솔 · 같은 명단 메뉴를 학원 B 로 — 학원 A 의 위임은 학원 B 에서 쓰이지 않는다
  "콘솔 roster_manage 학원B(예약·명단)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: OK, admin: FORBIDDEN,
  },
  // 콘솔 · 운영자 전용(입점 심사·수수료율 등 플랫폼 메뉴)
  "콘솔 admin(플랫폼)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  // 역할 부여 — 운영자(admin) 역할은 API 로 아무도 못 준다. 대표 콘솔 경로로 불러도, 운영자 자신이 불러도 403(S0-3 수용 ④)
  "콘솔 owner 학원A: 운영자 역할 부여": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "콘솔 admin: 운영자 역할 부여": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 대표 역할은 운영자만 준다(입점 승인 때, 데이터 모델 §7-2 「부여 경로」)
  "콘솔 admin: 대표 역할 부여": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: CREATED,
  },
  // 강사·대표 앱(bearer) · 명단 · 학원 A — 앱은 2단계를 묻지 않는다(FR-303 은 관리자 웹만). 권한 판정은 웹과 같다
  "앱 roster_manage 학원A(명단)": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: OK, delegateClass: FORBIDDEN,
    delegateNo2fa: OK, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · S0-5.1(취소 서비스·경로 이관) — 회원 본인의 예약·주문만. 직원 계정에는 회원 행이 없어 403 SIGNUP_INCOMPLETE
  "GET /api/reservations/{id}/cancellation-preview": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/reservations/{id}/cancel": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 결제 시작(S3-3.4, 계약 03 §1) — 회원 가드 → Idempotency-Key 순서. 표의 요청에는 키가 없어 회원만 400 까지 간다.
  // 주문이 실제로 생기는 판정은 order-create.db.test.ts 가 본다
  "POST /api/orders": {
    anonymous: NO_SESSION, member: PASSED_NO_KEY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/orders/{id}/cancel": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 실제 경로 · 직원 알림함(S1-4.6, 계약 10 §2) — staff_self: 역할은 묻지 않고 2단계 인증을 마친 직원이면 누구나 「내」 알림.
  // 받는 사람이 나인 행만 읽고 고치므로 권한 판정이 곧 받는 사람 판정이다. 읽음 행은 없는 알림 id 라 권한을 통과하면 404
  "GET /api/staff/notifications": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  "GET /api/staff/notifications/unread-count": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  "POST /api/staff/notifications/{id}/read": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND,
    admin: PASSED_NOT_FOUND,
  },
  "POST /api/staff/notifications/read-all": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 실제 경로 · 파일 올리기·내려받기(S1-1.6·S1-1.7, 계약 07 §1) — staff_self: 역할은 묻지 않고 2단계 인증을 마친 직원이면 누구나.
  // 올리기는 본문이 multipart 가 아니라 권한을 통과한 칸만 400 까지 가고, 내려받기는 없는 파일 id 라 권한을 통과한 칸만 404 까지 간다.
  // (파일이 있을 때 「올린 사람·붙은 학원 대표·운영자만」 판정은 file-download.db.test.ts 가 본다)
  // S2-1.2b 부터 2단계 확인이 multipart(목적)를 읽은 뒤로 옮겨졌다 — 강사 앱 목적(business_registration_evidence)은
  // 2단계 대신 instructor 역할을 본다(계약 11 열린 점 ⑩). 그래서 2단계 전 세션도 본문 형식 검사(400)까지 간다.
  // 관리자 웹 목적의 2단계 거부(401)는 tests/db/file-upload.db.test.ts 가 확인한다
  // S7-2.7(문의·신고 첨부 파일)부터 회원도 두 경로에 들어온다 — 회원은 첨부 목적만 올리고(그 밖은 403, file-upload 이 아니라
  // inquiry-report-attachments.db.test.ts 가 본다) 첨부만 연다. 그래서 회원 칸도 본문 검사(400)·없는 파일(404)까지 간다
  "POST /api/files": {
    anonymous: NO_SESSION, member: PASSED_NOT_MULTIPART, instructor: PASSED_NOT_MULTIPART, delegateRoster: PASSED_NOT_MULTIPART,
    delegateClass: PASSED_NOT_MULTIPART, delegateNo2fa: PASSED_NOT_MULTIPART, ownerA: PASSED_NOT_MULTIPART, ownerB: PASSED_NOT_MULTIPART,
    admin: PASSED_NOT_MULTIPART,
  },
  "GET /api/files/{fileId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND,
    admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 입점 약관 목록(S1-1.9, 계약 07 §2)·노쇼 기준(S1-3.8, 계약 09 §2) — 같은 staff_self. 읽기라 통과한 칸은 200
  "GET /api/terms/merchant-onboarding": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  "GET /api/no-show-policy": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 실제 경로 · 약관 판본 전문(S1-1.24, 계약 07 §5) — 로그인 직원(역할 무관) + 2단계. 없는 판본 id 라 통과한 칸만 404
  "GET /api/terms/versions/{termsVersionId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND,
    admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 약관 새 판본 올리기(S1-1.23, 계약 07 §5) — admin + 관리자 웹 2단계. 본문 {} 이라 운영자만 422 까지 간다
  "POST /api/admin/terms-versions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_INVALID_BODY,
  },
  // 실제 경로 · P9 공휴일(S7-4.8a, 계약 13 §10-1) — admin + 관리자 웹 2단계. 목록은 운영자만 200, 더하기·고치기는 본문 {} 이라 422,
  // 지우기는 없는 id 라 404
  "GET /api/admin/console/holidays": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  "POST /api/admin/console/holidays": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_INVALID_BODY,
  },
  "PATCH /api/admin/console/holidays/{holidayId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_INVALID_BODY,
  },
  "DELETE /api/admin/console/holidays/{holidayId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · P11 사업자 점검 게시 중단·소명 받아들이기(S1-1.29, 계약 13 §10-3) — admin + 관리자 웹 2단계. 없는 건 id 라 운영자만 404
  // 실제 경로 · P11 사업자 점검 목록·상세(S7-4.8c, 계약 13 §10-3) — admin + 관리자 웹 2단계. 목록은 운영자만 200, 상세는 없는 건 id 라 404
  "GET /api/admin/console/business-checks": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  "GET /api/admin/console/business-checks/{caseId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  "POST /api/admin/console/business-checks/{caseId}/suspend-listing": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  "POST /api/admin/console/business-checks/{caseId}/accept-explanation": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  // 실제 경로 · 학원 동의 기록·약관 변경 알림 읽음(S1-1.24, 계약 07 §5) — owner + 관리자 웹 2단계. 학원 A 로 부른다.
  // 동의 기록은 학원 A 대표만 200, 읽음은 없는 알림 id 라 학원 A 대표만 404
  "GET /api/academies/{academyId}/consents": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/terms-notices/{noticeId}/read": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 환불 공지 조회(S1-3.3, 계약 09 §1) — 대표, 또는 이 학원에서 위임을 하나라도 받은 소속 강사(읽기만) + 관리자 웹 2단계.
  // 위임 없는 강사·다른 학원 대표·운영자는 403. 학원 A 로 부른다. 현재 판본·판본 목록은 판본이 없어도 200(빈 값),
  // 판본 하나는 없는 번호(1)라 통과한 칸만 404
  "GET /api/academies/{academyId}/refund-notices": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/refund-notices/{kind}/versions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: PASSED_NOT_FOUND,
    delegateClass: PASSED_NOT_FOUND, delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 실제 경로 · 환불 공지 저장(S1-3.4, 계약 09 §1) — 대표만(위임 강사는 조회만). 정규(regular) 종류에 본문 {} 이라 학원 A 대표만 422
  "POST /api/academies/{academyId}/refund-notices/{kind}/versions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_INVALID_BODY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 회원 앱 경로(requireMember) — 직원 계정에는 회원 행이 없다
  "회원 앱 경로(requireMember)": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // ---- M3-FIX.1(전체 회귀 정리)에서 더한 행 — SX-2·SX-5·S3-5·S7-1 무렵 생긴 경로들 ----
  // 대표 앱도 부르는 콘솔 경로(appToo). 이 칸은 관리자 웹(쿠키)으로 부른 값이다 — 앱(Bearer) 값은 WEB_AND_APP 검사가 따로 본다
  "GET /api/academies/{academyId}/headcount": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/inquiries": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 없는 회원 id · 본문 {} 로 부른다 — 권한을 통과한 학원 A 대표만 그다음 검사(열람 사유 없음 422)까지 간다
  "POST /api/academies/{academyId}/members/{memberId}/contact-reveal": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_REASON, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/orders": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/orders/{orderId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // S4-1.4(대표 환불 입력) — 환불 요청 상세·결정은 대표만(위임 강사도 403, FR-081a). 상세는 없는 요청 id 라 404,
  // 결정은 권한 다음 검사(필수 헤더 Idempotency-Key 없음)에서 400 으로 멈춘다
  "GET /api/academies/{academyId}/refund-requests/{requestId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "POST /api/academies/{academyId}/refund-requests/{requestId}/decision": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 회원 명단은 roster_manage — 대표와 명단 위임 강사가 통과한다(FR-081a). 상세는 없는 회원 id 라 통과한 칸만 404
  "GET /api/academies/{academyId}/members": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: OK, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: OK, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  "GET /api/academies/{academyId}/members/{memberId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: PASSED_NOT_FOUND, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 운영자 문의함 — admin 은 늘 관리자 웹(2단계 필수)이라 Bearer 로 불러도 2단계를 묻는다
  "GET /api/admin/inquiries": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  // 수업 쪽 직원 경로(createClassAccess.readStaff — 쿠키면 2단계). 직원 계정만 확인하고 그다음은 자원 단위 판정이라
  // 없는 id·빠진 키·빈 본문으로 부르면 직원 칸은 모두 그다음 검사에서 멈춘다(자원을 찾은 뒤에야 학원·담당 판정을 한다)
  "POST /api/academies/{academyId}/poster-extractions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "GET /api/academies/{academyId}/poster-extractions/{extractionId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "PATCH /api/academies/{academyId}/poster-extractions/{extractionId}": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 검토는 본문보다 추출 행을 먼저 찾는다 — 없는 id 라 직원 칸은 404 에서 멈춘다
  "POST /api/academies/{academyId}/poster-extractions/{extractionId}/review": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/academies/{academyId}/poster-extractions/{extractionId}/submit": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "POST /api/attendance-marks/{markId}/dispute/resolve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "GET /api/classes/{classId}/sessions/{sessionId}/absences": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/sessions/{sessionId}/absences": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "GET /api/classes/{classId}/sessions/{sessionId}/roster": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 회원 앱 경로(requireMember). 직원 계정은 403 SIGNUP_INCOMPLETE. 없는 id 로 부르는 행은 회원만 404
  "POST /api/ai/chat": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 표의 회원은 기준 장르를 고르지 않았다(PUT /api/me/base-genre 행은 본문 {} 라 422) — 회원 가드를 통과한 뒤 409 에서 멈춘다
  "GET /api/home/offerings": {
    anonymous: NO_SESSION, member: PASSED_NO_BASE_GENRE, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/instructors/{instructorId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/me/attendance-marks/{markId}/dispute": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/me/calendar": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/me/notifications": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S6-3.4 — 내 레벨(회원만, 평가 레벨 없음)
  "GET /api/me/levels": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S6-3.8 — 내 등급 카드 모음(회원만)
  "GET /api/me/level-cards": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S6-3.10 — 카드 공개 연출을 봤다고 적기(회원만). 없는 카드 id 라 권한을 통과하면 404
  "POST /api/me/level-cards/{cardId}/reveal": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S6-3.9 — 강사 승급 제안 받기·거절(회원만). 없는 제안 id 라 권한을 통과하면 404
  "POST /api/me/level-offers/{offerId}/accept": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/me/level-offers/{offerId}/decline": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // S6-3.5 — 개강 후보 연락처 제공 동의(회원만). PUT 은 빈 본문이라 422
  "GET /api/me/contact-consent": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "PUT /api/me/contact-consent": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/me/orders": {
    anonymous: NO_SESSION, member: OK, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "PUT /api/me/sessions/{sessionId}/absence": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "DELETE /api/me/sessions/{sessionId}/absence": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/offerings/{offeringId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "GET /api/orders/{orderId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/refund-requests": {
    anonymous: NO_SESSION, member: PASSED_NO_KEY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  "POST /api/refund-requests/{requestId}/withdraw": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 회원이든 직원이든 「세션의 주인」 경로(문의·푸시 토큰). 직원은 앱에서 부르므로 2단계를 묻지 않는다(계약 15·17).
  // 남의 것은 주인 조건으로 걸러 404 — 권한 행렬로는 「로그인만 하면 자기 것」이 맞다
  "POST /api/inquiries": {
    anonymous: NO_SESSION, member: PASSED_NO_KEY, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY,
    delegateNo2fa: PASSED_NO_KEY, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "GET /api/inquiries": {
    anonymous: NO_SESSION, member: OK, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: OK, ownerA: OK, ownerB: OK, admin: OK,
  },
  "GET /api/inquiries/{inquiryId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  "POST /api/me/push-tokens": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: PASSED_INVALID_BODY, delegateRoster: PASSED_INVALID_BODY, delegateClass: PASSED_INVALID_BODY,
    delegateNo2fa: PASSED_INVALID_BODY, ownerA: PASSED_INVALID_BODY, ownerB: PASSED_INVALID_BODY, admin: PASSED_INVALID_BODY,
  },
  "DELETE /api/me/push-tokens/{tokenId}": {
    anonymous: NO_SESSION, member: PASSED_NOT_FOUND, instructor: PASSED_NOT_FOUND, delegateRoster: PASSED_NOT_FOUND, delegateClass: PASSED_NOT_FOUND,
    delegateNo2fa: PASSED_NOT_FOUND, ownerA: PASSED_NOT_FOUND, ownerB: PASSED_NOT_FOUND, admin: PASSED_NOT_FOUND,
  },
  // 내부 작업 — 사람의 세션으로는 열리지 않는다(X-Internal-Token 만, README §1)
  "POST /api/internal/jobs/absence-lock": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // S6-3.3(레벨 계산 작업) — 내부 작업, 토큰만
  "POST /api/internal/jobs/level-evaluation": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  "POST /api/internal/jobs/gender-imbalance-check": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  "POST /api/internal/jobs/payment-deadline-reminders": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  "GET /api/internal/ai/jobs/{jobId}/file": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  "POST /api/internal/ai/jobs/{jobId}/result": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
  // ---- M3-END.3(옛 AC 대응표 전체 재실행)에서 더한 행 — S4-1.2a·S7-2.3 이 만든 경로 4개 ----
  // 환불 계좌 저장(S4-1.2a) — 회원 가드 뒤 본문 검사. 본문 {} 라 회원 칸은 그다음 검사(422)에서 멈춘다
  "POST /api/refund-accounts": {
    anonymous: NO_SESSION, member: PASSED_INVALID_BODY, instructor: NOT_MEMBER, delegateRoster: NOT_MEMBER, delegateClass: NOT_MEMBER,
    delegateNo2fa: NOT_MEMBER, ownerA: NOT_MEMBER, ownerB: NOT_MEMBER, admin: NOT_MEMBER,
  },
  // 대표 답변(S7-2.3) — 그 학원 대표만(위임 강사 불가, FR-207), appToo. 통과한 칸은 Idempotency-Key 없음(400)에서 멈춘다
  "POST /api/academies/{academyId}/inquiries/{inquiryId}/replies": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: PASSED_NO_KEY, ownerB: FORBIDDEN, admin: FORBIDDEN,
  },
  // 운영자 답변(S7-2.3) — 운영자 문의함과 같은 가드. 통과한 운영자 칸만 Idempotency-Key 없음(400)에서 멈춘다
  "POST /api/admin/inquiries/{inquiryId}/replies": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NO_KEY,
  },
  // 이용 제한 절차 시작(S7-2.6) — 운영자 문의함과 같은 가드(관리자 웹 · 2단계 필수). 통과한 운영자 칸만 Idempotency-Key 없음(400)에서 멈춘다
  "POST /api/admin/restrictions": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NO_KEY,
  },
  // 신고 접수·내 신고(S7-2.5) — 문의와 같은 「세션의 주인」 경로. 앱에서 부르므로 2단계를 묻지 않는다.
  // 접수는 Idempotency-Key 를 역할 판정보다 먼저 보므로, 로그인한 칸은 모두 열쇠 없음(400)에서 멈춘다
  // (운영자 전용 계정의 403 은 그 뒤 신고자 역할을 정할 때 난다 — report-handling.db.test.ts ⑤)
  "POST /api/reports": {
    anonymous: NO_SESSION, member: PASSED_NO_KEY, instructor: PASSED_NO_KEY, delegateRoster: PASSED_NO_KEY, delegateClass: PASSED_NO_KEY,
    delegateNo2fa: PASSED_NO_KEY, ownerA: PASSED_NO_KEY, ownerB: PASSED_NO_KEY, admin: PASSED_NO_KEY,
  },
  "GET /api/reports": {
    anonymous: NO_SESSION, member: OK, instructor: OK, delegateRoster: OK, delegateClass: OK,
    delegateNo2fa: OK, ownerA: OK, ownerB: OK, admin: OK,
  },
  // 운영자 신고함·확인 시작·처리(S7-2.5) — 운영자 문의함과 같은 가드(관리자 웹 · 2단계 필수).
  // 통과한 운영자 칸은 없는 신고 id(404) · 빈 본문 {}(422)에서 멈춘다
  "GET /api/admin/reports": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: OK,
  },
  "POST /api/admin/reports/{reportId}/start-review": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_NOT_FOUND,
  },
  "POST /api/admin/reports/{reportId}/resolve": {
    anonymous: NO_SESSION, member: NOT_STAFF, instructor: FORBIDDEN, delegateRoster: FORBIDDEN, delegateClass: FORBIDDEN,
    delegateNo2fa: NEED_2FA, ownerA: FORBIDDEN, ownerB: FORBIDDEN, admin: PASSED_INVALID_BODY,
  },
  // 답 없는 문의 재알림(S7-2.3) — 내부 작업이라 사람의 세션으로는 열리지 않는다(X-Internal-Token 만)
  "POST /api/internal/jobs/inquiries/remind-overdue": {
    anonymous: NO_SESSION, member: NO_SESSION, instructor: NO_SESSION, delegateRoster: NO_SESSION, delegateClass: NO_SESSION,
    delegateNo2fa: NO_SESSION, ownerA: NO_SESSION, ownerB: NO_SESSION, admin: NO_SESSION,
  },
} as const satisfies Record<string, Row>;
type RouteName = keyof typeof MATRIX;

// ---- 웹과 앱이 함께 부르는 경로 ----------------------------------------------------------------
// 이 경로들은 요청이 어떻게 왔는지로 2단계 규칙이 갈린다(계약 README §6-2 ③, 2026-11-23):
//   쿠키(관리자 웹) → 2단계를 꼭 묻는다 · Bearer(대표·강사 앱) → 묻지 않는다.
// 그래서 MATRIX 칸은 더 엄한 쪽인 「관리자 웹(쿠키)」으로 부른 값이고, 같은 경로를 Bearer 로 한 번 더 불러
// 「2단계만 빠지고 나머지 판정은 같다」를 확인한다. 2단계 전 위임 강사(delegateNo2fa)는 명단 위임만 가진 강사라,
// 앱에서는 2단계 검사가 없으니 같은 위임을 가진 delegateRoster 와 같은 답을 받아야 한다(M3-FIX.1).
const WEB_AND_APP = new Set<RouteName>([
  // appToo 콘솔 경로(명세에 appToo: true)
  "POST /api/academies/{academyId}/invites",
  "GET /api/academies/{academyId}/affiliations",
  "GET /api/academies/{academyId}/dashboard",
  "POST /api/academies/{academyId}/affiliations/{id}/approve",
  "POST /api/academies/{academyId}/affiliations/{id}/reject",
  "PUT /api/academies/{academyId}/affiliations/{id}/permissions",
  "POST /api/academies/{academyId}/affiliations/{id}/release",
  "POST /api/academies/{academyId}/affiliations/{id}/release-preview",
  "GET /api/academies/{academyId}/consents",
  "POST /api/academies/{academyId}/terms-notices/{noticeId}/read",
  "GET /api/academies/{academyId}/headcount",
  "GET /api/academies/{academyId}/inquiries",
  "POST /api/academies/{academyId}/members/{memberId}/contact-reveal",
  "GET /api/academies/{academyId}/orders",
  "GET /api/academies/{academyId}/orders/{orderId}",
  "GET /api/academies/{academyId}/refund-requests/{requestId}",
  "POST /api/academies/{academyId}/refund-requests/{requestId}/decision",
  "GET /api/academies/{academyId}/members",
  "GET /api/academies/{academyId}/members/{memberId}",
  "POST /api/academies/{academyId}/inquiries/{inquiryId}/replies",
  // 직원 본인 알림함(staff_self — 2단계는 쿠키에만, 계약 11 열린 점 ⑩)
  "GET /api/staff/notifications",
  "GET /api/staff/notifications/unread-count",
  "POST /api/staff/notifications/{id}/read",
  "POST /api/staff/notifications/read-all",
  // 수업 쪽 직원 경로(createClassAccess.readStaff — 쿠키면 2단계)
  "POST /api/academies/{academyId}/poster-extractions",
  "GET /api/academies/{academyId}/poster-extractions/{extractionId}",
  "PATCH /api/academies/{academyId}/poster-extractions/{extractionId}",
  "POST /api/academies/{academyId}/poster-extractions/{extractionId}/review",
  "POST /api/academies/{academyId}/poster-extractions/{extractionId}/submit",
  "POST /api/attendance-marks/{markId}/dispute/resolve",
  "GET /api/classes/{classId}/sessions/{sessionId}/absences",
  "POST /api/classes/{classId}/sessions/{sessionId}/absences",
  "POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel",
  "PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount",
  "GET /api/classes/{classId}/sessions/{sessionId}/roster",
]);

/** 앱(Bearer)으로 부를 때의 기대값 — 웹 칸에서 2단계 칸만 같은 위임을 가진 강사의 답으로 바꾼다 */
const appExpectation = (route: RouteName): Row => ({ ...MATRIX[route], delegateNo2fa: MATRIX[route].delegateRoster });

// ---- route.ts ↔ 표 대응 ----------------------------------------------------------------------
// 실제 route.ts 파일 하나하나가 표의 어느 행인지, 또는 왜 표 밖인지(누구나 여는 공개 경로)를 적는다.
const ROUTE_FILE_COVERAGE: Record<string, RouteName | { public: string }> = {
  "app/api/health/route.ts": { public: "헬스 체크 — 로그인 없이 누구나(계약 §1)" },
  "app/api/auth/[...all]/route.ts": { public: "Better Auth 로그인·세션 경로 — 로그인 전에 불러야 하므로 누구나(계약 README §2). 판정은 Better Auth 가 한다" },
  "app/api/staff/me/route.ts": "GET /api/staff/me",
  "app/api/staff/notifications/route.ts": "GET /api/staff/notifications",
  "app/api/staff/notifications/unread-count/route.ts": "GET /api/staff/notifications/unread-count",
  "app/api/staff/notifications/[id]/read/route.ts": "POST /api/staff/notifications/{id}/read",
  "app/api/staff/notifications/read-all/route.ts": "POST /api/staff/notifications/read-all",
  "app/api/internal/jobs/holidays/sync/route.ts": "POST /api/internal/jobs/holidays/sync",
  "app/api/internal/jobs/business-status/check/route.ts": "POST /api/internal/jobs/business-status/check",
  "app/api/internal/jobs/files/purge-unattached/route.ts": "POST /api/internal/jobs/files/purge-unattached",
  "app/api/internal/jobs/class-approval-reminders/route.ts": "POST /api/internal/jobs/class-approval-reminders",
  "app/api/internal/jobs/substitute-requests-expire/route.ts": "POST /api/internal/jobs/substitute-requests-expire",
  "app/api/internal/jobs/private-lesson-holds-expire/route.ts": "POST /api/internal/jobs/private-lesson-holds-expire",
  "app/api/internal/jobs/notifications/retry/route.ts": "POST /api/internal/jobs/notifications/retry",
  "app/api/internal/jobs/notifications/pre-class/route.ts": "POST /api/internal/jobs/notifications/pre-class",
  "app/api/internal/orders/expire/route.ts": "POST /api/internal/orders/expire",
  "app/api/payments/webhook/route.ts": { public: "PG 결과 통지 — 세션 없이 웹훅 서명(webhook-signature)으로만 판정, 틀리면 401 INVALID_SIGNATURE(계약 03 §6, S3-3.9)" },
  "app/api/reservations/[id]/cancellation-preview/route.ts": "GET /api/reservations/{id}/cancellation-preview",
  "app/api/reservations/[id]/cancel/route.ts": "POST /api/reservations/{id}/cancel",
  "app/api/orders/route.ts": "POST /api/orders",
  "app/api/orders/[orderId]/cancel/route.ts": "POST /api/orders/{id}/cancel",
  "app/api/merchant-applications/me/draft/route.ts": "PUT /api/merchant-applications/me/draft",
  "app/api/merchant-applications/me/route.ts": "GET /api/merchant-applications/me",
  "app/api/merchant-applications/me/submit/route.ts": "POST /api/merchant-applications/me/submit",
  "app/api/merchant-applications/me/withdraw/route.ts": "POST /api/merchant-applications/me/withdraw",
  "app/api/admin/merchant-applications/route.ts": "GET /api/admin/merchant-applications",
  "app/api/admin/merchant-applications/[id]/route.ts": "GET /api/admin/merchant-applications/{id}",
  "app/api/admin/merchant-applications/[id]/start-review/route.ts": "POST /api/admin/merchant-applications/{id}/start-review",
  "app/api/admin/merchant-applications/[id]/approve/route.ts": "POST /api/admin/merchant-applications/{id}/approve",
  "app/api/admin/merchant-applications/[id]/reject/route.ts": "POST /api/admin/merchant-applications/{id}/reject",
  "app/api/academies/[academyId]/registration-change/route.ts": "POST /api/academies/{academyId}/registration-change",
  "app/api/academies/[academyId]/settings/route.ts": "GET /api/academies/{academyId}/settings",
  "app/api/academies/[academyId]/profile/route.ts": "PATCH /api/academies/{academyId}/profile",
  "app/api/academies/[academyId]/app-page/route.ts": "PUT /api/academies/{academyId}/app-page",
  "app/api/academies/[academyId]/payout-account/route.ts": "PUT /api/academies/{academyId}/payout-account",
  "app/api/academies/[academyId]/rooms/route.ts": "GET /api/academies/{academyId}/rooms",
  "app/api/academies/[academyId]/rooms/[roomId]/archive/route.ts": "POST /api/academies/{academyId}/rooms/{roomId}/archive",
  "app/api/academies/[academyId]/staff-notices/route.ts": "POST /api/academies/{academyId}/staff-notices",
  "app/api/academies/[academyId]/staff-notices/[noticeId]/route.ts": "PATCH /api/academies/{academyId}/staff-notices/{noticeId}",
  "app/api/academies/[academyId]/staff-notices/[noticeId]/publish/route.ts":
    "POST /api/academies/{academyId}/staff-notices/{noticeId}/publish",
  "app/api/academies/[academyId]/invites/route.ts": "POST /api/academies/{academyId}/invites",
  "app/api/academies/[academyId]/invites/[inviteId]/revoke/route.ts": "POST /api/academies/{academyId}/invites/{inviteId}/revoke",
  "app/api/academies/[academyId]/affiliations/route.ts": "GET /api/academies/{academyId}/affiliations",
  "app/api/academies/[academyId]/dashboard/route.ts": "GET /api/academies/{academyId}/dashboard",
  "app/api/academies/[academyId]/affiliations/[id]/approve/route.ts": "POST /api/academies/{academyId}/affiliations/{id}/approve",
  "app/api/academies/[academyId]/affiliations/[id]/reject/route.ts": "POST /api/academies/{academyId}/affiliations/{id}/reject",
  "app/api/academies/[academyId]/affiliations/[id]/permissions/route.ts": "PUT /api/academies/{academyId}/affiliations/{id}/permissions",
  "app/api/academies/[academyId]/affiliations/[id]/employment/route.ts": "PUT /api/academies/{academyId}/affiliations/{id}/employment",
  "app/api/academies/[academyId]/affiliations/[id]/release/route.ts": "POST /api/academies/{academyId}/affiliations/{id}/release",
  "app/api/academies/[academyId]/affiliations/[id]/release-preview/route.ts": "POST /api/academies/{academyId}/affiliations/{id}/release-preview",
  "app/api/academies/[academyId]/affiliations/[id]/share-rates/route.ts": "GET /api/academies/{academyId}/affiliations/{id}/share-rates",
  "app/api/academies/[academyId]/affiliations/[id]/share-rate/route.ts": "PUT /api/academies/{academyId}/affiliations/{id}/share-rate",
  "app/api/academies/[academyId]/affiliations/[id]/share-rate-overrides/[classId]/route.ts":
    "PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId}",
  "app/api/instructor/invites/[token]/accept/route.ts": "POST /api/instructor/invites/{token}/accept",
  "app/api/instructor/affiliations/route.ts": "POST /api/instructor/affiliations",
  "app/api/instructor/affiliations/[id]/withdraw/route.ts": "POST /api/instructor/affiliations/{id}/withdraw",
  "app/api/instructor/affiliations/[id]/release-requests/route.ts": "POST /api/instructor/affiliations/{id}/release-requests",
  "app/api/instructor/affiliations/[id]/release-preview/route.ts": "POST /api/instructor/affiliations/{id}/release-preview",
  "app/api/academies/[academyId]/affiliation-release-requests/route.ts": "GET /api/academies/{academyId}/affiliation-release-requests",
  "app/api/academies/[academyId]/affiliation-release-requests/[requestId]/decline/route.ts":
    "POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline",
  "app/api/instructor/affiliation-release-requests/[requestId]/withdraw/route.ts":
    "POST /api/instructor/affiliation-release-requests/{requestId}/withdraw",
  "app/api/instructor/academies/route.ts": "GET /api/instructor/academies",
  "app/api/instructor/affiliations/[id]/color/route.ts": "PUT /api/instructor/affiliations/{id}/color",
  "app/api/instructor/affiliations/[id]/rooms/route.ts": "GET /api/instructor/affiliations/{id}/rooms",
  "app/api/instructor/staff-notices/route.ts": "GET /api/instructor/staff-notices",
  "app/api/instructor/staff-notices/[noticeId]/read/route.ts": "POST /api/instructor/staff-notices/{noticeId}/read",
  "app/api/files/route.ts": "POST /api/files",
  "app/api/instructor/me/business-registration/route.ts": "PUT /api/instructor/me/business-registration",
  "app/api/instructor/me/profile/route.ts": "GET /api/instructor/me/profile", // 같은 파일의 PUT 도 표에 있다
  "app/api/classes/route.ts": "POST /api/classes",
  // GET(상세)·PUT(고치기) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/classes/[classId]/route.ts": "PUT /api/classes/{classId}",
  "app/api/classes/[classId]/submit/route.ts": "POST /api/classes/{classId}/submit",
  "app/api/classes/[classId]/poster/route.ts": "PUT /api/classes/{classId}/poster",
  "app/api/classes/[classId]/promo-assets/route.ts": "PUT /api/classes/{classId}/promo-assets", // 같은 파일의 GET 도 표에 있다
  "app/api/classes/[classId]/withdraw/route.ts": "POST /api/classes/{classId}/withdraw",
  "app/api/classes/schedule-check/route.ts": "POST /api/classes/schedule-check",
  "app/api/classes/[classId]/sessions/[sessionId]/change-preview/route.ts": "POST /api/classes/{classId}/sessions/{sessionId}/change-preview",
  "app/api/classes/[classId]/sessions/[sessionId]/change/route.ts": "POST /api/classes/{classId}/sessions/{sessionId}/change",
  "app/api/classes/[classId]/sessions/[sessionId]/cancel-preview/route.ts": "POST /api/classes/{classId}/sessions/{sessionId}/cancel-preview",
  "app/api/classes/[classId]/sessions/[sessionId]/cancel/route.ts": "POST /api/classes/{classId}/sessions/{sessionId}/cancel",
  "app/api/classes/[classId]/announcement-recipients/route.ts": "GET /api/classes/{classId}/announcement-recipients",
  // POST(보내기)·GET(보낸 목록) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/classes/[classId]/announcements/route.ts": "POST /api/classes/{classId}/announcements",
  "app/api/me/classes/[classId]/announcements/route.ts": "GET /api/me/classes/{classId}/announcements",
  "app/api/members/route.ts": "POST /api/members",
  "app/api/me/route.ts": "GET /api/me",
  "app/api/me/profile/route.ts": "PUT /api/me/profile",
  // GET·PUT 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/me/notification-settings/route.ts": "GET /api/me/notification-settings",
  "app/api/me/base-genre/route.ts": "PUT /api/me/base-genre",
  "app/api/sessions/[sessionId]/substitute-candidates/route.ts": "GET /api/sessions/{sessionId}/substitute-candidates",
  // POST(요청)·GET(내 목록) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/instructor/substitute-requests/route.ts": "POST /api/instructor/substitute-requests",
  "app/api/instructor/substitute-requests/[requestId]/accept/route.ts": "POST /api/instructor/substitute-requests/{requestId}/accept",
  "app/api/instructor/substitute-requests/[requestId]/decline/route.ts": "POST /api/instructor/substitute-requests/{requestId}/decline",
  "app/api/instructor/substitute-requests/[requestId]/cancel/route.ts": "POST /api/instructor/substitute-requests/{requestId}/cancel",
  "app/api/academies/[academyId]/substitute-requests/route.ts": "GET /api/academies/{academyId}/substitute-requests",
  "app/api/academies/[academyId]/substitute-requests/[requestId]/confirm/route.ts":
    "POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm",
  "app/api/academies/[academyId]/classes/[classId]/approve/route.ts": "POST /api/academies/{academyId}/classes/{classId}/approve",
  "app/api/academies/[academyId]/classes/[classId]/request-revision/route.ts":
    "POST /api/academies/{academyId}/classes/{classId}/request-revision",
  "app/api/instructor/classes/route.ts": "GET /api/instructor/classes",
  "app/api/classes/[classId]/sessions/route.ts": "GET /api/classes/{classId}/sessions",
  "app/api/academies/[academyId]/class-approvals/route.ts": "GET /api/academies/{academyId}/class-approvals",
  "app/api/instructor/personal-events/route.ts": "POST /api/instructor/personal-events",
  "app/api/instructor/personal-events/[eventId]/route.ts": "DELETE /api/instructor/personal-events/{eventId}",
  "app/api/files/[fileId]/route.ts": "GET /api/files/{fileId}",
  "app/api/terms/merchant-onboarding/route.ts": "GET /api/terms/merchant-onboarding",
  "app/api/no-show-policy/route.ts": "GET /api/no-show-policy",
  "app/api/terms/versions/[termsVersionId]/route.ts": "GET /api/terms/versions/{termsVersionId}",
  "app/api/admin/terms-versions/route.ts": "POST /api/admin/terms-versions",
  "app/api/admin/console/holidays/route.ts": "GET /api/admin/console/holidays",
  "app/api/admin/console/holidays/[holidayId]/route.ts": "PATCH /api/admin/console/holidays/{holidayId}",
  "app/api/admin/console/business-checks/route.ts": "GET /api/admin/console/business-checks",
  "app/api/admin/console/business-checks/[caseId]/route.ts": "GET /api/admin/console/business-checks/{caseId}",
  "app/api/admin/console/business-checks/[caseId]/suspend-listing/route.ts": "POST /api/admin/console/business-checks/{caseId}/suspend-listing",
  "app/api/admin/console/business-checks/[caseId]/accept-explanation/route.ts": "POST /api/admin/console/business-checks/{caseId}/accept-explanation",
  "app/api/academies/[academyId]/consents/route.ts": "GET /api/academies/{academyId}/consents",
  "app/api/academies/[academyId]/terms-notices/[noticeId]/read/route.ts":
    "POST /api/academies/{academyId}/terms-notices/{noticeId}/read",
  "app/api/academies/[academyId]/refund-notices/route.ts": "GET /api/academies/{academyId}/refund-notices",
  // GET(판본 목록)·POST(저장) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/academies/[academyId]/refund-notices/[kind]/versions/route.ts":
    "POST /api/academies/{academyId}/refund-notices/{kind}/versions",
  "app/api/academies/[academyId]/refund-notices/[kind]/versions/[version]/route.ts":
    "GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}",
  // S1-1.8(대표 가입 API) — 가입 전이라 세션이 없다. 본인확인 토큰·요청 제한으로 지킨다(계약 07 §0, 판정은 owner-signup.db.test.ts)
  "app/api/classes/[classId]/edit-requests/route.ts": "POST /api/classes/{classId}/edit-requests",
  "app/api/classes/[classId]/edit-requests/[editRequestId]/withdraw/route.ts":
    "POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw",
  "app/api/academies/[academyId]/class-edit-requests/[editRequestId]/approve/route.ts":
    "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve",
  "app/api/academies/[academyId]/class-edit-requests/[editRequestId]/reject/route.ts":
    "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject",
  // GET(목록)·POST(열기) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있고, 대응표에는 하나만 적는다
  "app/api/instructor/private-lesson-products/route.ts": "POST /api/instructor/private-lesson-products",
  "app/api/instructor/private-lesson-products/[classId]/close/route.ts": "POST /api/instructor/private-lesson-products/{classId}/close",
  "app/api/instructor/private-lesson-products/[classId]/slots/route.ts": "POST /api/instructor/private-lesson-products/{classId}/slots",
  "app/api/instructor/private-lesson-slots/[slotId]/route.ts": "DELETE /api/instructor/private-lesson-slots/{slotId}",
  // GET(조회)·POST(저장) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/instructor/private-lesson-rules/route.ts": "POST /api/instructor/private-lesson-rules",
  "app/api/instructor/private-lesson-passes/route.ts": "GET /api/instructor/private-lesson-passes",
  "app/api/instructor/private-lesson-passes/[passId]/route.ts": "GET /api/instructor/private-lesson-passes/{passId}",
  "app/api/instructor/private-lesson-passes/[passId]/bookings/route.ts": "POST /api/instructor/private-lesson-passes/{passId}/bookings",
  "app/api/instructor/private-lesson-bookings/[bookingId]/reschedule/route.ts":
    "POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule",
  "app/api/instructor/private-lesson-bookings/[bookingId]/cancel/route.ts": "POST /api/instructor/private-lesson-bookings/{bookingId}/cancel",
  "app/api/instructor/schedule/route.ts": "GET /api/instructor/schedule",
  "app/api/instructor/dashboard/route.ts": "GET /api/instructor/dashboard",
  "app/api/instructor/headcount/route.ts": "GET /api/instructor/headcount",
  "app/api/instructor/offerings/[offeringId]/member-levels/route.ts": "GET /api/instructor/offerings/{offeringId}/member-levels",
  "app/api/instructor/level-evaluations/route.ts": "POST /api/instructor/level-evaluations",
  "app/api/me/levels/route.ts": "GET /api/me/levels",
  "app/api/me/level-cards/route.ts": "GET /api/me/level-cards",
  "app/api/me/level-cards/[cardId]/reveal/route.ts": "POST /api/me/level-cards/{cardId}/reveal",
  "app/api/me/level-offers/[offerId]/accept/route.ts": "POST /api/me/level-offers/{offerId}/accept",
  "app/api/me/level-offers/[offerId]/decline/route.ts": "POST /api/me/level-offers/{offerId}/decline",
  "app/api/instructor/new-class-candidates/route.ts": "GET /api/instructor/new-class-candidates",
  "app/api/instructor/new-class-candidates/list/route.ts": "GET /api/instructor/new-class-candidates/list",
  "app/api/instructor/new-class-candidates/[memberId]/reveal-contact/route.ts": "POST /api/instructor/new-class-candidates/{memberId}/reveal-contact",
  // GET(조회)·PUT(바꾸기) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/me/contact-consent/route.ts": "PUT /api/me/contact-consent",
  "app/api/dev/identity/fake-verify/route.ts": {
    public: "개발용 가짜 본인확인 — KDANCE_DEV_ROUTES=true 일 때만 열리고 운영 값(false)에서는 404(dev-routes.ts). 가입 전에 부르므로 로그인 없음",
  },
  "app/api/dev/fake-pg/payments/[gatewayPaymentId]/deposit/route.ts": {
    public: "개발용 가짜 PG 입금 — KDANCE_DEV_ROUTES=true 이고 PG 가 가짜일 때만 열리고 아니면 404. 서명한 웹훅을 §6 처리기에 넘긴다(계약 03 §7, S3-3.14)",
  },
  "app/api/dev/fake-pg/webhooks/replay/route.ts": {
    public: "개발용 가짜 PG 웹훅 재전송 — 입금 경로와 같은 조건으로만 열린다(계약 03 §7, S3-3.14)",
  },
  "app/api/owner/signup/identity-check/route.ts": { public: "대표 가입 1단계 — 본인확인 토큰으로 자격 확인(계약 07 §0)" },
  "app/api/owner/signup/username-available/route.ts": { public: "대표 가입 아이디 중복 확인 — IP 요청 제한(계약 07 §0)" },
  "app/api/owner/signup/route.ts": { public: "대표 가입 — 본인확인 토큰 필수, owner 역할은 붙이지 않는다(계약 07 §0)" },
  "app/api/instructor/signup/identity-check/route.ts": { public: "강사 가입 1단계 — 본인확인 토큰으로 자격 확인(계약 11 §1-1)" },
  "app/api/instructor/signup/username-available/route.ts": { public: "강사 가입 아이디 중복 확인 — IP 요청 제한(계약 11 §1-2)" },
  "app/api/instructor/signup/route.ts": { public: "강사 가입 — 본인확인 토큰 필수, instructor 역할을 시스템이 붙인다(계약 11 §1-3)" },
  "app/api/instructor/account-recovery/lookup/route.ts": { public: "강사 계정 찾기 — 본인확인 토큰의 CI 로만 찾는다, IP 요청 제한(계약 11 §1-4)" },
  "app/api/instructor/account-recovery/reset-password/route.ts": { public: "강사 비밀번호 재설정 — 본인확인 토큰 1회용, 세션·기기 기억 전부 끝냄(계약 11 §1-4)" },
  // ---- M3-FIX.1 에서 더한 대응 ----
  "app/api/academies/[academyId]/headcount/route.ts": "GET /api/academies/{academyId}/headcount",
  "app/api/academies/[academyId]/inquiries/route.ts": "GET /api/academies/{academyId}/inquiries",
  "app/api/academies/[academyId]/members/[memberId]/contact-reveal/route.ts":
    "POST /api/academies/{academyId}/members/{memberId}/contact-reveal",
  "app/api/academies/[academyId]/members/[memberId]/route.ts": "GET /api/academies/{academyId}/members/{memberId}",
  "app/api/academies/[academyId]/members/route.ts": "GET /api/academies/{academyId}/members",
  "app/api/academies/[academyId]/orders/[orderId]/route.ts": "GET /api/academies/{academyId}/orders/{orderId}",
  "app/api/academies/[academyId]/orders/route.ts": "GET /api/academies/{academyId}/orders",
  "app/api/academies/[academyId]/refund-requests/[requestId]/route.ts": "GET /api/academies/{academyId}/refund-requests/{requestId}",
  "app/api/academies/[academyId]/refund-requests/[requestId]/decision/route.ts":
    "POST /api/academies/{academyId}/refund-requests/{requestId}/decision",
  "app/api/academies/[academyId]/poster-extractions/route.ts": "POST /api/academies/{academyId}/poster-extractions",
  // GET(읽기)·PATCH(고치기) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/academies/[academyId]/poster-extractions/[extractionId]/route.ts":
    "PATCH /api/academies/{academyId}/poster-extractions/{extractionId}",
  "app/api/academies/[academyId]/poster-extractions/[extractionId]/review/route.ts":
    "POST /api/academies/{academyId}/poster-extractions/{extractionId}/review",
  "app/api/academies/[academyId]/poster-extractions/[extractionId]/submit/route.ts":
    "POST /api/academies/{academyId}/poster-extractions/{extractionId}/submit",
  "app/api/admin/inquiries/route.ts": "GET /api/admin/inquiries",
  "app/api/ai/chat/route.ts": "POST /api/ai/chat",
  "app/api/attendance-marks/[markId]/dispute/resolve/route.ts": "POST /api/attendance-marks/{markId}/dispute/resolve",
  "app/api/classes/[classId]/sessions/[sessionId]/absences/[markId]/cancel/route.ts":
    "POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel",
  // GET(목록)·POST(표시) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/classes/[classId]/sessions/[sessionId]/absences/route.ts": "POST /api/classes/{classId}/sessions/{sessionId}/absences",
  "app/api/classes/[classId]/sessions/[sessionId]/onsite-headcount/route.ts":
    "PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount",
  "app/api/classes/[classId]/sessions/[sessionId]/roster/route.ts": "GET /api/classes/{classId}/sessions/{sessionId}/roster",
  "app/api/dev/fake-pg/payments/[gatewayPaymentId]/fail/route.ts": {
    public: "개발용 가짜 PG 결제 실패 — 입금 경로와 같은 조건(KDANCE_DEV_ROUTES=true · PG 가짜)으로만 열리고 아니면 404(dev-routes.ts)",
  },
  "app/api/home/offerings/route.ts": "GET /api/home/offerings",
  "app/api/inquiries/[inquiryId]/route.ts": "GET /api/inquiries/{inquiryId}",
  // POST(만들기)·GET(내 문의) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/inquiries/route.ts": "POST /api/inquiries",
  "app/api/instructors/[instructorId]/route.ts": "GET /api/instructors/{instructorId}",
  "app/api/internal/ai/jobs/[jobId]/file/route.ts": "GET /api/internal/ai/jobs/{jobId}/file",
  "app/api/internal/ai/jobs/[jobId]/result/route.ts": "POST /api/internal/ai/jobs/{jobId}/result",
  "app/api/internal/jobs/absence-lock/route.ts": "POST /api/internal/jobs/absence-lock",
  "app/api/internal/jobs/level-evaluation/route.ts": "POST /api/internal/jobs/level-evaluation",
  "app/api/internal/jobs/gender-imbalance-check/route.ts": "POST /api/internal/jobs/gender-imbalance-check",
  "app/api/internal/jobs/payment-deadline-reminders/route.ts": "POST /api/internal/jobs/payment-deadline-reminders",
  "app/api/me/attendance-marks/[markId]/dispute/route.ts": "POST /api/me/attendance-marks/{markId}/dispute",
  "app/api/me/calendar/route.ts": "GET /api/me/calendar",
  "app/api/me/notifications/route.ts": "GET /api/me/notifications",
  "app/api/me/orders/route.ts": "GET /api/me/orders",
  "app/api/me/push-tokens/[tokenId]/route.ts": "DELETE /api/me/push-tokens/{tokenId}",
  "app/api/me/push-tokens/route.ts": "POST /api/me/push-tokens",
  // PUT(켜기)·DELETE(끄기) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다
  "app/api/me/sessions/[sessionId]/absence/route.ts": "PUT /api/me/sessions/{sessionId}/absence",
  "app/api/offerings/[offeringId]/route.ts": "GET /api/offerings/{offeringId}",
  "app/api/orders/[orderId]/route.ts": "GET /api/orders/{orderId}",
  "app/api/refund-requests/[requestId]/withdraw/route.ts": "POST /api/refund-requests/{requestId}/withdraw",
  "app/api/refund-requests/route.ts": "POST /api/refund-requests",
  "app/api/refund-accounts/route.ts": "POST /api/refund-accounts",
  "app/api/academies/[academyId]/inquiries/[inquiryId]/replies/route.ts":
    "POST /api/academies/{academyId}/inquiries/{inquiryId}/replies",
  "app/api/admin/inquiries/[inquiryId]/replies/route.ts": "POST /api/admin/inquiries/{inquiryId}/replies",
  "app/api/admin/restrictions/route.ts": "POST /api/admin/restrictions",
  // POST(접수)·GET(내 신고) 두 처리기가 한 파일에 있다 — 두 행 모두 MATRIX 에 있다(S7-2.5)
  "app/api/reports/route.ts": "POST /api/reports",
  "app/api/admin/reports/route.ts": "GET /api/admin/reports",
  "app/api/admin/reports/[reportId]/start-review/route.ts": "POST /api/admin/reports/{reportId}/start-review",
  "app/api/admin/reports/[reportId]/resolve/route.ts": "POST /api/admin/reports/{reportId}/resolve",
  "app/api/internal/jobs/inquiries/remind-overdue/route.ts": "POST /api/internal/jobs/inquiries/remind-overdue",
};

/** app/api 아래의 route.ts 를 모두 찾는다(앱 루트 기준 상대 경로). */
function listRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listRouteFiles(path);
    return name === "route.ts" ? [relative(APP_ROOT, path).split("\\").join("/")] : [];
  });
}

const grantBodySchema = z.strictObject({ staffAccountId: z.uuid(), role: z.enum(STAFF_ROLE_NAMES) });

describe.skipIf(!dbAvailable())("역할 4종 × 보호 경로 권한 행렬(플랜 6-3 · README §6-2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  const academyA = randomUUID();
  const academyB = randomUUID();
  const tokens: Partial<Record<ActorKey, string>> = {};
  const staffIds: Record<string, string> = {};
  // 역할 부여의 대상 — 표의 사람들과 따로 둬서, 부여가 일어나도 다른 칸의 판정이 바뀌지 않게 한다
  let grantTargetId = "";

  // 실제로 부른 결과. 칸마다 「상태 code」 모양으로 모은다.
  const actual: Partial<Record<RouteName, Partial<Record<ActorKey, string>>>> = {};
  // WEB_AND_APP 경로를 앱(Bearer)으로 한 번 더 부른 결과
  const actualApp: Partial<Record<RouteName, Partial<Record<ActorKey, string>>>> = {};

  /** auth.user + 세션 하나. twoFactor=true 면 인증 앱을 켠 계정이라 세션이 「2단계를 마친 세션」으로 적힌다(staff-auth.ts 세션 훅). */
  async function makeUser(key: string, twoFactor: boolean): Promise<{ authUserId: string; token: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key.toLowerCase(), displayUsername: key },
      { method: "admin" },
    );
    if (twoFactor) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    const session = await ctx.internalAdapter.createSession(user.id);
    return { authUserId: user.id, token: session.token };
  }

  async function makeStaff(key: string, roles: string[], twoFactor = true): Promise<string> {
    const { authUserId, token } = await makeUser(key, twoFactor);
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, $3, now())", [id, authUserId, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    if ((ACTORS as readonly string[]).includes(key)) tokens[key as ActorKey] = token;
    return id;
  }

  async function makeOwner(key: string, academyId: string): Promise<void> {
    const id = await makeStaff(key, ["owner"]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, id]);
  }

  /** 강사 + 학원 A 의 active 소속 + 위임(없으면 빈 배열). */
  async function makeInstructor(key: string, permissions: string[], twoFactor = true): Promise<void> {
    const id = await makeStaff(key, ["instructor"], twoFactor);
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now()) RETURNING id`,
      [academyA, id],
    );
    const affiliationId = (rows[0] as { id: string }).id;
    for (const p of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        p,
        staffIds["ownerA"],
      ]);
    }
  }

  /** 행 이름 → 그 경로를 부르는 함수. 사람의 세션은 Bearer 토큰으로 싣는다(Better Auth bearer 플러그인이 같은 세션으로 읽는다). */
  let callers: Record<RouteName, (request: Request) => Promise<Response>>;

  /**
   * 칸 하나의 요청. mode "app" 은 Bearer 토큰(앱), "web" 은 서명한 세션 쿠키(관리자 웹)로 싣는다.
   * 둘을 나누는 까닭은 WEB_AND_APP 의 설명과 같다 — 같은 세션이라도 어떻게 왔는지로 2단계 규칙이 갈린다.
   */
  function requestFor(actor: ActorKey, route: RouteName, mode: "app" | "web" = "app"): Request {
    const headers = new Headers({ "content-type": "application/json" });
    const token = tokens[actor];
    if (token !== undefined && mode === "web") headers.set("cookie", staffSessionCookie(token, SECRET));
    else if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    const isGrant = route.includes("역할 부여");
    const role = route.includes("대표 역할") ? "owner" : "admin";
    return new Request(`${BASE}/api/matrix`, {
      method:
        isGrant || route.startsWith("POST") ? "POST" : route.startsWith("PUT") ? "PUT" : route.startsWith("PATCH") ? "PATCH" : "GET",
      headers,
      ...(isGrant
        ? { body: JSON.stringify({ staffAccountId: grantTargetId, role }) }
        : route.startsWith("POST") || route.startsWith("PUT") || route.startsWith("PATCH")
          ? { body: "{}" }
          : {}),
    });
  }

  /** 응답을 「상태 code」 한 줄로 줄인다. 성공이면 상태만. */
  async function summarize(res: Response): Promise<string> {
    if (res.status < 300) return String(res.status);
    const body = (await res.json()) as { code?: string };
    return `${res.status} ${body.code ?? "?"}`;
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = { db: handle.db, getSession: (headers: Headers) => auth.api.getSession({ headers }) };

    for (const [id, name] of [
      [academyA, "행렬 시험 학원 A"],
      [academyB, "행렬 시험 학원 B"],
    ] as const) {
      await q(`INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, $2, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`, [id, name]);
    }

    // 사람들(열)
    await makeOwner("ownerA", academyA);
    await makeOwner("ownerB", academyB);
    await makeInstructor("instructor", []);
    await makeInstructor("delegateRoster", ["roster_manage"]);
    await makeInstructor("delegateClass", ["class_manage"]);
    await makeInstructor("delegateNo2fa", ["roster_manage"], false);
    await makeStaff("admin", ["admin"]);
    const member = await makeUser("member", false);
    tokens.member = member.token;
    const memberRow = await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES (uuidv7(), $1, '행렬 회원', 'female', '1995-05-05', '010-2222-3333', $2, '시험 닉네임', now(), now()) RETURNING id`,
      [member.authUserId, `ci-matrix-${member.authUserId}`],
    );
    const memberId = (memberRow.rows[0] as { id: string }).id;
    // 취소 경로(S0-5.1)가 회원 칸에서 200 을 내도록 그 회원의 확정 예약 1건과 입금 전 주문 1건
    const paidChain = await insertCancellationChain(handle.pool, { memberId });
    const pendingChain = await insertCancellationChain(handle.pool, { memberId, stage: "pending" });
    // 역할을 받을 사람(열이 아니다)
    grantTargetId = await makeStaff("grantTarget", ["instructor"]);
    // 입점 약관 목록 경로가 200 을 내도록 입점 항목마다 시행 중인 판본 하나(없으면 운영자가 발행 안 한 상태라 500)
    for (const { item } of MERCHANT_ONBOARDING_ITEMS) {
      await q(
        `INSERT INTO terms_versions (id, kind, version, body, published_at, effective_at)
         VALUES ($1, $2, 'matrix-1', '본문', now() - interval '60 days', now() - interval '1 day')`,
        [randomUUID(), item],
      );
    }

    // 경로들(행)
    const guards = createGuards(deps);
    const consoleRoute = createConsoleRoute(deps);
    const roleGrants = createRoleGrantService({ db: handle.db });
    const pass = async () => Response.json({ ok: true });
    const academyRoute = (permission: "owner" | "roster_manage" | "class_manage", academyId: string) =>
      consoleRoute({ permission, academyId: () => academyId }, pass);
    const grantHandler = async (request: Request, _ctx: unknown, staff: Parameters<typeof roleGrants.grantRole>[0]) => {
      const body = await parseJsonBody(request, grantBodySchema);
      const result = await roleGrants.grantRole(staff, body);
      return Response.json(result, { status: result.created ? 201 : 200 });
    };
    // 실제 내부 작업 route.ts 를 그대로 부른다 — 토큰 검사가 처리기보다 먼저라 DB 를 건드리지 않는다
    const holidaySync = await import("@/app/api/internal/jobs/holidays/sync/route");
    const businessStatusCheck = await import("@/app/api/internal/jobs/business-status/check/route");
    const fileCleanup = await import("@/app/api/internal/jobs/files/purge-unattached/route");
    const classApprovalReminders = await import("@/app/api/internal/jobs/class-approval-reminders/route");
    const substituteRequestsExpire = await import("@/app/api/internal/jobs/substitute-requests-expire/route");
    const privateLessonHoldsExpire = await import("@/app/api/internal/jobs/private-lesson-holds-expire/route");
    const ordersExpire = await import("@/app/api/internal/orders/expire/route");
    const notificationRetry = await import("@/app/api/internal/jobs/notifications/retry/route");
    const preClassReminders = await import("@/app/api/internal/jobs/notifications/pre-class/route");
    // 답 없는 문의 재알림(S7-2.3) — 내부 작업 route 를 그대로 불러 X-Internal-Token 검사를 거치게 한다
    const inquiryRemindOverdue = await import("@/app/api/internal/jobs/inquiries/remind-overdue/route");
    const staffMe = createStaffMeRoute(deps); // app/api/staff/me/route.ts 가 쓰는 같은 공장 함수(테스트 DB 를 넘긴다)
    const appRoster = withRoute(async (request) => {
      await guards.requireStaff("roster_manage", { academyId: academyA, surface: "app", headers: request.headers });
      return Response.json({ ok: true });
    });
    const memberRoute = withRoute(async (request) => Response.json(await guards.requireMember(request)));
    // 취소 경로 셋 — route.ts 가 쓰는 같은 공장 함수에 테스트 DB·시험 Auth·가짜 PG(이 테스트 전용 원장)를 넘긴다
    const cancelDeps = {
      ...deps,
      clock: systemClock,
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
      notificationSender: new FakeNotificationSender(),
    };
    const cancelPreview = createCancellationPreviewRoute(cancelDeps);
    const cancelReservation = createCancelReservationRoute(cancelDeps);
    const cancelOrder = createCancelOrderRoute(cancelDeps);
    const createOrder = createOrderRoute(cancelDeps);
    // 입점 신청 초안 경로 둘 — route.ts 가 쓰는 같은 공장 함수(테스트 DB·시험 Auth·실행마다 뽑은 암호화 키)
    const draftDeps = { ...deps, fieldCipher: createFieldCipher(randomBytes(32).toString("base64")) };
    const putDraft = createPutDraftRoute(draftDeps);
    const getMyApplication = createGetMyApplicationRoute(draftDeps);
    const submitApplication = createSubmitApplicationRoute(draftDeps);
    const withdrawApplication = createWithdrawApplicationRoute(draftDeps);
    const adminListApplications = createListMerchantApplicationsRoute(draftDeps);
    const adminGetApplication = createGetMerchantApplicationRoute(draftDeps);
    const adminStartReview = createStartReviewRoute(draftDeps);
    const adminApprove = createApproveRoute(draftDeps);
    const adminReject = createRejectRoute(draftDeps);
    const registrationChange = createRegistrationChangeRoute(deps);
    const academySettings = createAcademySettingsRoute({ ...draftDeps, clock: systemClock });
    const academyProfile = createAcademyProfileRoute({ ...draftDeps, clock: systemClock });
    const academyAppPage = createAcademyAppPageRoute(deps);
    const listRooms = createListRoomsRoute(deps);
    const createRoom = createCreateRoomRoute(deps);
    const archiveRoom = createArchiveRoomRoute(deps);
    // 학원 공지 쓰기 셋(S1-4.3)
    const createStaffNotice = createCreateStaffNoticeRoute(deps);
    const updateStaffNotice = createUpdateStaffNoticeRoute(deps);
    const publishStaffNotice = createPublishStaffNoticeRoute(deps);
    // 초대 링크 셋(S1-2.4) — route.ts 가 쓰는 같은 공장 함수
    const inviteDeps = { ...deps, clock: systemClock, inviteBaseUrl: "https://k-dancex4.test" };
    const createInvite = createCreateInviteRoute(inviteDeps);
    const listInvites = createListInvitesRoute(inviteDeps);
    const revokeInvite = createRevokeInviteRoute(inviteDeps);
    // 초대 링크 수락(S1-2.5) — route.ts 가 쓰는 같은 공장 함수
    const acceptInvite = createAcceptInviteRoute({ ...deps, clock: systemClock });
    const missingInviteToken = randomBytes(32).toString("base64url");
    // 소속 승인·거절(S1-2.7) — route.ts 가 쓰는 같은 공장 함수
    // 소속 목록(S1-2.8) — route.ts 가 쓰는 같은 공장 함수
    const listAcademyAffiliations = createListAcademyAffiliationsRoute(deps);
    // 대표 대시보드(S1-4.5) — route.ts 가 쓰는 같은 공장 함수
    const ownerDashboard = createOwnerDashboardRoute({
      ...deps,
      clock: systemClock,
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    });
    const approveAffiliation = createApproveAffiliationRoute({ ...deps, clock: systemClock });
    const updateAffiliationPermissions = createUpdateAffiliationPermissionsRoute({ ...deps, clock: systemClock });
    const rejectAffiliation = createRejectAffiliationRoute({ ...deps, clock: systemClock });
    const academyAffiliationCtx = { params: Promise.resolve({ academyId: academyA, id: randomUUID() }) };
    // 강사 몫 비율 셋(S1-2.10) — route.ts 가 쓰는 같은 공장 함수
    const updateAffiliationEmployment = createUpdateAffiliationEmploymentRoute({ ...deps, clock: systemClock });
    const releaseAffiliation = createReleaseAffiliationRoute({ ...deps, clock: systemClock });
    const getShareRates = createGetShareRatesRoute(deps);
    const updateShareRate = createUpdateShareRateRoute({ ...deps, clock: systemClock });
    const updateShareRateOverride = createUpdateShareRateOverrideRoute({ ...deps, clock: systemClock });
    const shareOverrideCtx = { params: Promise.resolve({ academyId: academyA, id: randomUUID(), classId: randomUUID() }) };
    // 소속 신청·철회·목록(S1-2.6) — route.ts 가 쓰는 같은 공장 함수
    const affiliationDeps = { ...deps, clock: systemClock };
    const applyAffiliation = createApplyAffiliationRoute(affiliationDeps);
    const withdrawAffiliation = createWithdrawAffiliationRoute(affiliationDeps);
    const listMyAffiliations = createListMyAffiliationsRoute(affiliationDeps);
    // 강사 쪽 해제 요청(S2-1.4) — route.ts 가 쓰는 같은 공장 함수
    const releaseRequest = createReleaseRequestRoute(affiliationDeps);
    // 소속 해제 미리 보기 둘(S2-3.6) — route.ts 가 쓰는 같은 공장 함수
    const ownerReleasePreview = createOwnerReleasePreviewRoute(affiliationDeps);
    const instructorReleasePreview = createInstructorReleasePreviewRoute(affiliationDeps);
    // 해제 요청 목록·거절·취소(S2-3.13) — route.ts 가 쓰는 같은 공장 함수
    const listReleaseRequests = createListReleaseRequestsRoute(affiliationDeps);
    const declineReleaseRequest = createDeclineReleaseRequestRoute(affiliationDeps);
    const withdrawReleaseRequest = createWithdrawReleaseRequestRoute(affiliationDeps);
    const missingReleaseRequestCtx = { params: Promise.resolve({ academyId: academyA, requestId: randomUUID() }) };
    // 학원 검색·학원 색(S2-1.9) — route.ts 가 쓰는 같은 공장 함수
    const searchAcademies = createSearchAcademiesRoute(deps);
    const setAffiliationColor = createSetAffiliationColorRoute(deps);
    const listAffiliationRooms = createListAffiliationRoomsRoute(deps);
    // 사업자등록번호·등록증(S2-1.2b) — route.ts 가 쓰는 같은 공장 함수
    const putBusinessRegistration = createPutBusinessRegistrationRoute(affiliationDeps);
    // 강사 프로필·개인 일정(S2-1.6) — route.ts 가 쓰는 같은 공장 함수
    const instructorProfile = createInstructorProfileRoutes(affiliationDeps);
    const personalEvents = createInstructorPersonalEventRoutes(deps);
    const classRegistration = createClassRegistrationRoutes(deps);
    const classPoster = createClassPosterRoute(deps);
    const classPromo = createClassPromoAssetsRoutes(deps);
    const classApproval = createClassApprovalRoutes(deps);
    const classWithdraw = createClassWithdrawRoute(deps);
    const sessionChanges = createSessionChangeRoutes(deps);
    const substitutes = createSubstituteRequestRoutes(deps);
    const announcements = createClassAnnouncementRoutes(deps);
    const classScheduleCheck = createClassScheduleCheckRoute(deps);
    // 수업 수정 요청(S2-3.12)·개인 레슨(S2-4)·강사 일정(S2-4.5) — route.ts 가 쓰는 같은 공장 함수
    const classEdits = createClassEditRequestRoutes(deps);
    const lessonProducts = createPrivateLessonProductRoutes(deps);
    const lessonSlots = createPrivateLessonSlotRoutes(deps);
    const lessonRules = createPrivateLessonRuleRoutes(deps);
    const lessonBookings = createPrivateLessonBookingRoutes(deps);
    const instructorSchedule = createInstructorScheduleRoutes(deps);
    const instructorDashboard = createInstructorDashboardRoute(cancelDeps);
    const instructorHeadcount = createInstructorHeadcountRoute(cancelDeps);
    // S6-3.4 — 강사 멤버십은 가짜(모두 멤버십)라 권한 검사 뒤 판매 단위·본문 검사까지 간다
    const levelDeps = { ...deps, instructorMembership: new FakeInstructorMembership() };
    const instructorMemberLevels = createInstructorMemberLevelsRoute(levelDeps);
    const instructorLevelEvaluations = createInstructorLevelEvaluationsRoute(levelDeps);
    const meLevels = createMeLevelsRoute(deps);
    const meLevelCards = createMeLevelCardsRoute(deps);
    const meLevelOffers = createMeLevelOfferRoutes(deps);
    const meLevelCardReveal = createMeLevelCardRevealRoute(deps);
    // S6-3.5 — 개강 후보(같은 가짜 멤버십) · 회원 동의
    const candidateDeps = { ...levelDeps, revealRootSecret: SECRET };
    const newClassCandidates = createNewClassCandidatesRoute(candidateDeps);
    const newClassCandidateList = createNewClassCandidateListRoute(candidateDeps);
    const revealCandidateContact = createRevealCandidateContactRoute(candidateDeps);
    const meContactConsent = createMeContactConsentRoutes(deps);
    const candidateQuery = { detailGenre: "salsa", levelFrom: "0", levelTo: "3" };
    // 쿼리가 필수인 GET 경로에 쿼리를 붙인다 — 표의 요청 주소(/api/matrix)에는 쿼리가 없어 권한을 통과한 칸이 422 로 끝나지 않게
    const withQuery = (r: Request, query: Record<string, string>) =>
      new Request(`${BASE}/api/matrix?${new URLSearchParams(query).toString()}`, r);
    // 학원 공지 읽기 셋(S1-4.4) — route.ts 가 쓰는 같은 공장 함수
    const listAcademyStaffNotices = createListAcademyStaffNoticesRoute(deps);
    const listInstructorStaffNotices = createListInstructorStaffNoticesRoute(deps);
    const readInstructorStaffNotice = createReadInstructorStaffNoticeRoute(deps);
    // 정산 계좌 변경 — 표의 요청은 키 검사(400)에서 멈추므로 코드 확인·요청 제한까지 가지 않는다. 닿으면 실패하도록 둔다
    const unreachable = async (): Promise<never> => {
      throw new Error("권한 행렬 요청이 코드 확인까지 오면 안 된다");
    };
    const payoutAccount = createPayoutAccountChangeRoute({
      ...draftDeps,
      totp: unreachable,
      limiter: { assertAllowed: unreachable, recordFailure: unreachable, consume: unreachable },
      totpFailureRule: { name: "matrix-unused", limit: 1, windowSeconds: 1 },
    });
    // 회원 가입 완료(S3-1.2) — 표의 요청은 본문 검사(422)에서 멈춘다. 요청 제한은 세지 않고, 본인확인까지 오면 실패하도록 둔다
    const memberSignup = createMemberSignupRoutes({
      ...deps,
      clock: systemClock,
      limiter: { assertAllowed: async () => {}, recordFailure: async () => {}, consume: async () => {} },
      identityRule: { name: "matrix-unused", limit: 1, windowSeconds: 1 },
      identityVerification: { verify: unreachable },
    });
    // 회원 취향·기준 장르(S3-1.5) — route.ts 가 쓰는 같은 공장 함수
    const memberProfile = createMemberProfileRoutes({ ...deps, clock: systemClock });
    const memberNotificationSettings = createMemberNotificationSettingsRoutes({ ...deps, clock: systemClock });
    // 직원 알림함 넷(S1-4.6) — route.ts 가 쓰는 같은 공장 함수
    const notificationDeps = { ...deps, clock: systemClock };
    const staffNotifications = createListStaffNotificationsRoute(notificationDeps);
    const staffUnreadCount = createStaffUnreadCountRoute(notificationDeps);
    const staffReadNotification = createReadStaffNotificationRoute(notificationDeps);
    const staffReadAll = createReadAllStaffNotificationsRoute(notificationDeps);
    // 파일 둘(S1-1.6·S1-1.7) — 표의 요청은 본문 검사(400)·파일 행(404)에서 멈추므로 저장소까지 가지 않는다. 닿으면 실패하도록 둔다
    const unreachableStorage: FileStoragePort = { put: unreachable, get: unreachable, delete: unreachable };
    const uploadFile = createUploadFileRoute({ ...deps, fileStorage: unreachableStorage });
    const downloadFile = createDownloadFileRoute({ ...deps, fileStorage: unreachableStorage });
    // 약관·노쇼·동의 기록(계약 07 §2·§5) — route.ts 가 쓰는 같은 공장 함수
    const merchantOnboardingTerms = createMerchantOnboardingTermsRoute(deps);
    const noShowPolicy = createNoShowPolicyRoute(deps);
    const termsVersion = createTermsVersionRoute(deps);
    const publishTermsVersion = createPublishTermsVersionRoute({ ...deps, clock: systemClock });
    const adminHolidays = createAdminHolidaysRoutes({ ...deps, clock: systemClock });
    const holidayCtx = { params: Promise.resolve({ holidayId: randomUUID() }) };
    const businessChecks = createAdminBusinessCheckRoutes({ ...deps, clock: systemClock });
    const businessCaseCtx = { params: Promise.resolve({ caseId: randomUUID() }) };
    const academyConsents = createAcademyConsentsRoute({ ...deps, clock: systemClock });
    const readTermsNotice = createReadTermsNoticeRoute({ ...deps, clock: systemClock });
    // 환불 공지 조회 셋·저장(계약 09 §1) — route.ts 가 쓰는 같은 공장 함수
    const refundNoticeRead = createRefundNoticeReadRoutes(deps);
    const publishRefundNotice = createRefundNoticePublishRoute(deps);
    const refundKindCtx = { params: Promise.resolve({ academyId: academyA, kind: "regular" }) };
    const missingApplicationCtx = { params: Promise.resolve({ id: randomUUID() }) };
    const reservationCtx = { params: Promise.resolve({ id: paidChain.reservationId }) };
    const orderCtx = { params: Promise.resolve({ orderId: pendingChain.orderId }) };

    // ---- M3-FIX.1 에서 더한 경로들 — route.ts 가 쓰는 같은 공장 함수에 테스트 DB·시험 Auth 를 넘긴다 ----
    const ownerHeadcount = createOwnerHeadcountRoute(cancelDeps);
    const inquiries = createInquiryRoutes({ ...deps, clock: systemClock });
    // ---- M3-END.3(옛 AC 대응표 전체 재실행)에서 더한 경로 — route.ts 와 같은 공장 함수 ----
    // 환불 계좌 저장(S4-1.2a): 암호화 열쇠는 이 테스트에서만 쓰는 무작위 값이다(진짜 열쇠를 읽지 않는다)
    const saveRefundAccount = createSaveRefundAccountRoute({
      ...deps,
      clock: systemClock,
      fieldCipher: createFieldCipher(randomBytes(32).toString("base64")),
    });
    // 대표·운영자 문의 답변(S7-2.3)
    const inquiryReplies = createInquiryReplyRoutes({ ...deps, clock: systemClock });
    // 이용 제한 절차 시작(S7-2.6)
    const restrictions = createRestrictionRoutes({ ...deps, clock: systemClock });
    // 신고 접수·처리(S7-2.5)
    const reports = createReportRoutes({ ...deps, clock: systemClock });
    const contactReveal = createMemberContactRevealRoute(deps);
    const academyMembers = createAcademyMembersRoute({ ...deps, clock: systemClock });
    const academyMemberDetail = createAcademyMemberDetailRoute({ ...deps, clock: systemClock });
    const ownerOrders = createOwnerOrdersRoute(cancelDeps);
    const ownerOrderDetail = createOwnerOrderDetailRoute(cancelDeps);
    const refundRequestDetail = createRefundRequestDetailRoute(cancelDeps);
    const refundDecision = createRefundDecisionRoute(cancelDeps);
    // 포스터 읽기 — 표의 요청은 키·본문·id 검사에서 멈추므로 에이전트에게 일을 맡기는 데까지 가지 않는다. 닿으면 실패하도록 둔다
    const posterExtractions = createPosterExtractionRoutes({ ...deps, dispatchJob: unreachable });
    const absenceDisputes = createAbsenceDisputeRoutes({ ...deps, clock: systemClock });
    const staffAbsenceMarks = createStaffAbsenceMarkRoutes({ ...deps, clock: systemClock });
    const onsiteHeadcount = createSessionOnsiteHeadcountRoute({ ...deps, clock: systemClock });
    const sessionRoster = createSessionRosterRoute(cancelDeps);
    const homeOfferings = createHomeOfferingsRoute(cancelDeps);
    const instructorPublicProfile = createInstructorPublicProfileRoute({ ...deps, clock: systemClock });
    const meCalendar = createMeCalendarRoute({ ...deps, clock: systemClock });
    const meNotifications = createMeNotificationsRoute(deps);
    const meOrders = createMeOrdersRoute(cancelDeps);
    const pushTokens = createPushTokenRoutes({ ...deps, clock: systemClock });
    const meSessionAbsence = createMeSessionAbsenceRoutes({ ...deps, clock: systemClock });
    const offeringDetail = createOfferingDetailRoute(cancelDeps);
    const orderDetail = createOrderDetailRoute(cancelDeps);
    const refundRequest = createRefundRequestRoute({ ...deps, clock: systemClock });
    const withdrawRefundRequest = createWithdrawRefundRequestRoute({ ...deps, clock: systemClock });
    // AI 대화 — 표의 요청은 본문 검사(422)에서 멈춘다. 에이전트·일반 검색까지 오면 실패하도록 둔다
    const aiChat = createAiChatRoute({
      requireMember: (request) => guards.requireMember(request),
      agent: null,
      plainSearch: unreachable,
      newRunId: () => randomUUID(),
      issueAgentSessionToken: () => {
        throw new Error("권한 행렬 요청이 에이전트 토큰 발급까지 오면 안 된다");
      },
    });
    // 내부 작업 route.ts 다섯 — 위 내부 작업처럼 토큰 검사가 처리기보다 먼저라 DB·파일 저장소를 건드리지 않는다
    const absenceLock = await import("@/app/api/internal/jobs/absence-lock/route");
    const levelEvaluation = await import("@/app/api/internal/jobs/level-evaluation/route");
    const genderImbalanceCheck = await import("@/app/api/internal/jobs/gender-imbalance-check/route");
    const paymentDeadlineReminders = await import("@/app/api/internal/jobs/payment-deadline-reminders/route");
    const aiJobFile = await import("@/app/api/internal/ai/jobs/[jobId]/file/route");
    const aiJobResult = await import("@/app/api/internal/ai/jobs/[jobId]/result/route");
    const jobCtx = { params: Promise.resolve({ jobId: randomUUID() }) };
    const sessionCtx = { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID() }) };
    const extractionCtx = { params: Promise.resolve({ academyId: academyA, extractionId: randomUUID() }) };

    callers = {
      "GET /api/academies/{academyId}/headcount": (r) => ownerHeadcount(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/inquiries": (r) => inquiries.ownerInbox(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/members/{memberId}/contact-reveal": (r) =>
        contactReveal(r, { params: Promise.resolve({ academyId: academyA, memberId: randomUUID() }) }),
      "GET /api/academies/{academyId}/orders": (r) => ownerOrders(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/orders/{orderId}": (r) =>
        ownerOrderDetail(r, { params: Promise.resolve({ academyId: academyA, orderId: randomUUID() }) }),
      "GET /api/academies/{academyId}/refund-requests/{requestId}": (r) =>
        refundRequestDetail(r, { params: Promise.resolve({ academyId: academyA, requestId: randomUUID() }) }),
      "POST /api/academies/{academyId}/refund-requests/{requestId}/decision": (r) =>
        refundDecision(r, { params: Promise.resolve({ academyId: academyA, requestId: randomUUID() }) }),
      "GET /api/academies/{academyId}/members": (r) => academyMembers(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/members/{memberId}": (r) =>
        academyMemberDetail(r, { params: Promise.resolve({ academyId: academyA, memberId: randomUUID() }) }),
      "GET /api/admin/inquiries": (r) => inquiries.adminInbox(r, undefined),
      "POST /api/academies/{academyId}/poster-extractions": (r) =>
        posterExtractions.start(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/poster-extractions/{extractionId}": (r) => posterExtractions.read(r, extractionCtx),
      "PATCH /api/academies/{academyId}/poster-extractions/{extractionId}": (r) => posterExtractions.patch(r, extractionCtx),
      "POST /api/academies/{academyId}/poster-extractions/{extractionId}/review": (r) => posterExtractions.review(r, extractionCtx),
      "POST /api/academies/{academyId}/poster-extractions/{extractionId}/submit": (r) => posterExtractions.submit(r, extractionCtx),
      "POST /api/attendance-marks/{markId}/dispute/resolve": (r) =>
        absenceDisputes.resolveDispute(r, { params: Promise.resolve({ markId: randomUUID() }) }),
      "GET /api/classes/{classId}/sessions/{sessionId}/absences": (r) => staffAbsenceMarks.list(r, sessionCtx),
      "POST /api/classes/{classId}/sessions/{sessionId}/absences": (r) => staffAbsenceMarks.mark(r, sessionCtx),
      "POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel": (r) =>
        staffAbsenceMarks.cancel(r, { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID(), markId: randomUUID() }) }),
      "PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount": (r) => onsiteHeadcount(r, sessionCtx),
      "GET /api/classes/{classId}/sessions/{sessionId}/roster": (r) => sessionRoster(r, sessionCtx),
      "POST /api/ai/chat": (r) => aiChat(r, undefined),
      "GET /api/home/offerings": (r) => homeOfferings(r, undefined),
      "GET /api/instructors/{instructorId}": (r) =>
        instructorPublicProfile(r, { params: Promise.resolve({ instructorId: randomUUID() }) }),
      "POST /api/me/attendance-marks/{markId}/dispute": (r) =>
        absenceDisputes.requestDispute(r, { params: Promise.resolve({ markId: randomUUID() }) }),
      "GET /api/me/calendar": (r) => meCalendar(r, undefined),
      "GET /api/me/notifications": (r) => meNotifications(r, undefined),
      "GET /api/me/levels": (r) => meLevels(r, undefined),
      "GET /api/me/level-cards": (r) => meLevelCards(r, undefined),
      "POST /api/me/level-cards/{cardId}/reveal": (r) => meLevelCardReveal(r, { params: Promise.resolve({ cardId: randomUUID() }) }),
      "POST /api/me/level-offers/{offerId}/accept": (r) => meLevelOffers.accept(r, { params: Promise.resolve({ offerId: randomUUID() }) }),
      "POST /api/me/level-offers/{offerId}/decline": (r) => meLevelOffers.decline(r, { params: Promise.resolve({ offerId: randomUUID() }) }),
      "GET /api/me/contact-consent": (r) => meContactConsent.get(r, undefined),
      "PUT /api/me/contact-consent": (r) => meContactConsent.put(r, undefined),
      "GET /api/me/orders": (r) => meOrders(r, undefined),
      "PUT /api/me/sessions/{sessionId}/absence": (r) =>
        meSessionAbsence.put(r, { params: Promise.resolve({ sessionId: randomUUID() }) }),
      "DELETE /api/me/sessions/{sessionId}/absence": (r) =>
        meSessionAbsence.remove(r, { params: Promise.resolve({ sessionId: randomUUID() }) }),
      "GET /api/offerings/{offeringId}": (r) => offeringDetail(r, { params: Promise.resolve({ offeringId: randomUUID() }) }),
      "GET /api/orders/{orderId}": (r) => orderDetail(r, { params: Promise.resolve({ orderId: randomUUID() }) }),
      "POST /api/refund-requests": (r) => refundRequest(r, undefined),
      "POST /api/refund-requests/{requestId}/withdraw": (r) =>
        withdrawRefundRequest(r, { params: Promise.resolve({ requestId: randomUUID() }) }),
      "POST /api/inquiries": (r) => inquiries.create(r, undefined),
      "GET /api/inquiries": (r) => inquiries.listMine(r, undefined),
      "GET /api/inquiries/{inquiryId}": (r) => inquiries.readOne(r, { params: Promise.resolve({ inquiryId: randomUUID() }) }),
      "POST /api/me/push-tokens": (r) => pushTokens.postToken(r, undefined),
      "DELETE /api/me/push-tokens/{tokenId}": (r) =>
        pushTokens.deleteToken(r, { params: Promise.resolve({ tokenId: randomUUID() }) }),
      "POST /api/internal/jobs/absence-lock": (r) => absenceLock.POST(r, undefined),
      "POST /api/internal/jobs/level-evaluation": (r) => levelEvaluation.POST(r, undefined),
      "POST /api/internal/jobs/gender-imbalance-check": (r) => genderImbalanceCheck.POST(r, undefined),
      "POST /api/internal/jobs/payment-deadline-reminders": (r) => paymentDeadlineReminders.POST(r, undefined),
      "GET /api/internal/ai/jobs/{jobId}/file": (r) => aiJobFile.GET(r, jobCtx),
      "POST /api/internal/ai/jobs/{jobId}/result": (r) => aiJobResult.POST(r, jobCtx),
      "GET /api/staff/me": (r) => staffMe(r, {}),
      "POST /api/internal/jobs/holidays/sync": (r) => holidaySync.POST(r, undefined),
      "POST /api/internal/jobs/business-status/check": (r) => businessStatusCheck.POST(r, undefined),
      "POST /api/internal/jobs/files/purge-unattached": (r) => fileCleanup.POST(r, undefined),
      "POST /api/internal/jobs/class-approval-reminders": (r) => classApprovalReminders.POST(r, undefined),
      "POST /api/internal/jobs/substitute-requests-expire": (r) => substituteRequestsExpire.POST(r, undefined),
      "POST /api/internal/jobs/private-lesson-holds-expire": (r) => privateLessonHoldsExpire.POST(r, undefined),
      "POST /api/internal/orders/expire": (r) => ordersExpire.POST(r, undefined),
      "POST /api/internal/jobs/notifications/retry": (r) => notificationRetry.POST(r, undefined),
      "POST /api/internal/jobs/notifications/pre-class": (r) => preClassReminders.POST(r, undefined),
      "POST /api/refund-accounts": (r) => saveRefundAccount(r, undefined),
      "POST /api/academies/{academyId}/inquiries/{inquiryId}/replies": (r) =>
        inquiryReplies.ownerReply(r, { params: Promise.resolve({ academyId: academyA, inquiryId: randomUUID() }) }),
      "POST /api/admin/inquiries/{inquiryId}/replies": (r) =>
        inquiryReplies.adminReply(r, { params: Promise.resolve({ inquiryId: randomUUID() }) }),
      "POST /api/internal/jobs/inquiries/remind-overdue": (r) => inquiryRemindOverdue.POST(r, undefined),
      "POST /api/admin/restrictions": (r) => restrictions.open(r, undefined),
      "POST /api/reports": (r) => reports.create(r, undefined),
      "GET /api/reports": (r) => reports.listMine(r, undefined),
      "GET /api/admin/reports": (r) => reports.adminList(r, undefined),
      "POST /api/admin/reports/{reportId}/start-review": (r) =>
        reports.startReview(r, { params: Promise.resolve({ reportId: randomUUID() }) }),
      "POST /api/admin/reports/{reportId}/resolve": (r) =>
        reports.resolve(r, { params: Promise.resolve({ reportId: randomUUID() }) }),
      "콘솔 owner 학원A(정산·금액)": (r) => academyRoute("owner", academyA)(r, {}),
      "콘솔 owner 학원B(정산·금액)": (r) => academyRoute("owner", academyB)(r, {}),
      "콘솔 roster_manage 학원A(예약·명단)": (r) => academyRoute("roster_manage", academyA)(r, {}),
      "콘솔 class_manage 학원A(수업·포스터)": (r) => academyRoute("class_manage", academyA)(r, {}),
      "콘솔 roster_manage 학원B(예약·명단)": (r) => academyRoute("roster_manage", academyB)(r, {}),
      "콘솔 admin(플랫폼)": (r) => consoleRoute({ permission: "admin" }, pass)(r, {}),
      "콘솔 owner 학원A: 운영자 역할 부여": (r) => consoleRoute({ permission: "owner", academyId: () => academyA }, grantHandler)(r, {}),
      "콘솔 admin: 운영자 역할 부여": (r) => consoleRoute({ permission: "admin" }, grantHandler)(r, {}),
      "콘솔 admin: 대표 역할 부여": (r) => consoleRoute({ permission: "admin" }, grantHandler)(r, {}),
      "앱 roster_manage 학원A(명단)": (r) => appRoster(r, {}),
      "GET /api/reservations/{id}/cancellation-preview": (r) => cancelPreview(r, reservationCtx),
      "POST /api/reservations/{id}/cancel": (r) => cancelReservation(r, reservationCtx),
      "POST /api/orders": (r) => createOrder(r, undefined),
      "POST /api/orders/{id}/cancel": (r) => cancelOrder(r, orderCtx),
      "PUT /api/merchant-applications/me/draft": (r) => putDraft(r, undefined),
      "GET /api/merchant-applications/me": (r) => getMyApplication(r, undefined),
      "POST /api/merchant-applications/me/submit": (r) => submitApplication(r, undefined),
      "POST /api/merchant-applications/me/withdraw": (r) => withdrawApplication(r, undefined),
      "GET /api/admin/merchant-applications": (r) => adminListApplications(r, undefined),
      "GET /api/admin/merchant-applications/{id}": (r) => adminGetApplication(r, missingApplicationCtx),
      "POST /api/admin/merchant-applications/{id}/start-review": (r) => adminStartReview(r, missingApplicationCtx),
      "POST /api/admin/merchant-applications/{id}/approve": (r) => adminApprove(r, missingApplicationCtx),
      "POST /api/admin/merchant-applications/{id}/reject": (r) => adminReject(r, missingApplicationCtx),
      "POST /api/academies/{academyId}/registration-change": (r) =>
        registrationChange(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/settings": (r) => academySettings(r, { params: Promise.resolve({ academyId: academyA }) }),
      "PATCH /api/academies/{academyId}/profile": (r) => academyProfile(r, { params: Promise.resolve({ academyId: academyA }) }),
      "PUT /api/academies/{academyId}/app-page": (r) => academyAppPage(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/rooms": (r) => listRooms(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/rooms": (r) => createRoom(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/rooms/{roomId}/archive": (r) =>
        archiveRoom(r, { params: Promise.resolve({ academyId: academyA, roomId: randomUUID() }) }),
      "POST /api/academies/{academyId}/staff-notices": (r) =>
        createStaffNotice(r, { params: Promise.resolve({ academyId: academyA }) }),
      "PATCH /api/academies/{academyId}/staff-notices/{noticeId}": (r) =>
        updateStaffNotice(r, { params: Promise.resolve({ academyId: academyA, noticeId: randomUUID() }) }),
      "POST /api/academies/{academyId}/staff-notices/{noticeId}/publish": (r) =>
        publishStaffNotice(r, { params: Promise.resolve({ academyId: academyA, noticeId: randomUUID() }) }),
      "PUT /api/academies/{academyId}/payout-account": (r) =>
        payoutAccount(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/invites": (r) => createInvite(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/invites": (r) => listInvites(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/invites/{inviteId}/revoke": (r) =>
        revokeInvite(r, { params: Promise.resolve({ academyId: academyA, inviteId: randomUUID() }) }),
      "GET /api/academies/{academyId}/affiliations": (r) =>
        listAcademyAffiliations(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/dashboard": (r) => ownerDashboard(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/affiliations/{id}/approve": (r) => approveAffiliation(r, academyAffiliationCtx),
      "POST /api/academies/{academyId}/affiliations/{id}/reject": (r) => rejectAffiliation(r, academyAffiliationCtx),
      "PUT /api/academies/{academyId}/affiliations/{id}/permissions": (r) =>
        updateAffiliationPermissions(r, academyAffiliationCtx),
      "PUT /api/academies/{academyId}/affiliations/{id}/employment": (r) => updateAffiliationEmployment(r, academyAffiliationCtx),
      "POST /api/academies/{academyId}/affiliations/{id}/release": (r) => releaseAffiliation(r, academyAffiliationCtx),
      "POST /api/academies/{academyId}/affiliations/{id}/release-preview": (r) => ownerReleasePreview(r, academyAffiliationCtx),
      "GET /api/academies/{academyId}/affiliations/{id}/share-rates": (r) => getShareRates(r, academyAffiliationCtx),
      "PUT /api/academies/{academyId}/affiliations/{id}/share-rate": (r) => updateShareRate(r, academyAffiliationCtx),
      "PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId}": (r) =>
        updateShareRateOverride(r, shareOverrideCtx),
      "POST /api/instructor/invites/{token}/accept": (r) =>
        acceptInvite(r, { params: Promise.resolve({ token: missingInviteToken }) }),
      "POST /api/instructor/affiliations": (r) => applyAffiliation(r, undefined),
      "POST /api/instructor/affiliations/{id}/withdraw": (r) => withdrawAffiliation(r, missingApplicationCtx),
      "POST /api/instructor/affiliations/{id}/release-requests": (r) => releaseRequest(r, missingApplicationCtx),
      "POST /api/instructor/affiliations/{id}/release-preview": (r) => instructorReleasePreview(r, missingApplicationCtx),
      "GET /api/academies/{academyId}/affiliation-release-requests": (r) =>
        listReleaseRequests(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline": (r) =>
        declineReleaseRequest(r, missingReleaseRequestCtx),
      "POST /api/instructor/affiliation-release-requests/{requestId}/withdraw": (r) =>
        withdrawReleaseRequest(r, missingReleaseRequestCtx),
      "GET /api/instructor/affiliations": (r) => listMyAffiliations(r, undefined),
      "GET /api/instructor/academies": (r) => searchAcademies(r, undefined),
      "PUT /api/instructor/affiliations/{id}/color": (r) => setAffiliationColor(r, missingApplicationCtx),
      "GET /api/instructor/affiliations/{id}/rooms": (r) => listAffiliationRooms(r, missingApplicationCtx),
      "PUT /api/instructor/me/business-registration": (r) => putBusinessRegistration(r, undefined),
      "GET /api/instructor/me/profile": (r) => instructorProfile.get(r, undefined),
      "PUT /api/instructor/me/profile": (r) => instructorProfile.put(r, undefined),
      "POST /api/classes": (r) => classRegistration.create(r, undefined),
      "GET /api/classes/{classId}": (r) => classRegistration.read(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "PUT /api/classes/{classId}": (r) => classRegistration.update(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/classes/{classId}/submit": (r) => classRegistration.submit(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "PUT /api/classes/{classId}/poster": (r) => classPoster(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "GET /api/classes/{classId}/promo-assets": (r) => classPromo.read(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "PUT /api/classes/{classId}/promo-assets": (r) => classPromo.save(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/classes/{classId}/withdraw": (r) => classWithdraw(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/classes/{classId}/sessions/{sessionId}/change-preview": (r) =>
        sessionChanges.changePreview(r, { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID() }) }),
      "POST /api/classes/{classId}/sessions/{sessionId}/change": (r) =>
        sessionChanges.change(r, { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID() }) }),
      "POST /api/classes/{classId}/sessions/{sessionId}/cancel-preview": (r) =>
        sessionChanges.cancelPreview(r, { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID() }) }),
      "POST /api/classes/{classId}/sessions/{sessionId}/cancel": (r) =>
        sessionChanges.cancel(r, { params: Promise.resolve({ classId: randomUUID(), sessionId: randomUUID() }) }),
      "POST /api/classes/schedule-check": (r) => classScheduleCheck(r, undefined),
      "GET /api/classes/{classId}/announcement-recipients": (r) =>
        announcements.recipients(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/classes/{classId}/announcements": (r) => announcements.create(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "GET /api/classes/{classId}/announcements": (r) => announcements.list(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/members": (r) => memberSignup.signup(r, undefined),
      "GET /api/me": (r) => memberProfile.getMe(r, undefined),
      "PUT /api/me/profile": (r) => memberProfile.putProfile(r, undefined),
      "GET /api/me/notification-settings": (r) => memberNotificationSettings.getSettings(r, undefined),
      "PUT /api/me/notification-settings": (r) => memberNotificationSettings.putSettings(r, undefined),
      "PUT /api/me/base-genre": (r) => memberProfile.putBaseGenre(r, undefined),
      "GET /api/me/classes/{classId}/announcements": (r) =>
        announcements.listForMember(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "GET /api/sessions/{sessionId}/substitute-candidates": (r) =>
        substitutes.candidates(r, { params: Promise.resolve({ sessionId: randomUUID() }) }),
      "POST /api/instructor/substitute-requests": (r) => substitutes.create(r, undefined),
      "GET /api/instructor/substitute-requests": (r) => substitutes.listMine(r, undefined),
      "POST /api/instructor/substitute-requests/{requestId}/accept": (r) =>
        substitutes.accept(r, { params: Promise.resolve({ requestId: randomUUID() }) }),
      "POST /api/instructor/substitute-requests/{requestId}/decline": (r) =>
        substitutes.decline(r, { params: Promise.resolve({ requestId: randomUUID() }) }),
      "POST /api/instructor/substitute-requests/{requestId}/cancel": (r) =>
        substitutes.cancel(r, { params: Promise.resolve({ requestId: randomUUID() }) }),
      "GET /api/academies/{academyId}/substitute-requests": (r) =>
        substitutes.listAcademy(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm": (r) =>
        substitutes.confirm(r, { params: Promise.resolve({ academyId: academyA, requestId: randomUUID() }) }),
      "POST /api/academies/{academyId}/classes/{classId}/approve": (r) =>
        classApproval.approve(r, { params: Promise.resolve({ academyId: academyA, classId: randomUUID() }) }),
      "POST /api/academies/{academyId}/classes/{classId}/request-revision": (r) =>
        classApproval.requestRevision(r, { params: Promise.resolve({ academyId: academyA, classId: randomUUID() }) }),
      "GET /api/instructor/classes": (r) => createInstructorClassListRoute(deps)(r, undefined),
      "GET /api/classes/{classId}/sessions": (r) =>
        createClassSessionListRoute(deps)(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "GET /api/academies/{academyId}/class-approvals": (r) =>
        createClassApprovalListRoute(deps)(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/instructor/personal-events": (r) => personalEvents.create(r, undefined),
      "DELETE /api/instructor/personal-events/{eventId}": (r) =>
        personalEvents.remove(r, { params: Promise.resolve({ eventId: randomUUID() }) }),
      "POST /api/classes/{classId}/edit-requests": (r) =>
        classEdits.create(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw": (r) =>
        classEdits.withdraw(r, { params: Promise.resolve({ classId: randomUUID(), editRequestId: randomUUID() }) }),
      "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve": (r) =>
        classEdits.approve(r, { params: Promise.resolve({ academyId: academyA, editRequestId: randomUUID() }) }),
      "POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject": (r) =>
        classEdits.reject(r, { params: Promise.resolve({ academyId: academyA, editRequestId: randomUUID() }) }),
      "GET /api/instructor/private-lesson-products": (r) => lessonProducts.list(r, undefined),
      "POST /api/instructor/private-lesson-products": (r) => lessonProducts.create(r, undefined),
      "POST /api/instructor/private-lesson-products/{classId}/close": (r) =>
        lessonProducts.close(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "POST /api/instructor/private-lesson-products/{classId}/slots": (r) =>
        lessonSlots.open(r, { params: Promise.resolve({ classId: randomUUID() }) }),
      "DELETE /api/instructor/private-lesson-slots/{slotId}": (r) =>
        lessonSlots.remove(r, { params: Promise.resolve({ slotId: randomUUID() }) }),
      "GET /api/instructor/private-lesson-rules": (r) => lessonRules.get(withQuery(r, { academyId: academyA }), undefined),
      "POST /api/instructor/private-lesson-rules": (r) => lessonRules.save(r, undefined),
      "GET /api/instructor/private-lesson-passes": (r) => lessonBookings.listPasses(r, undefined),
      "GET /api/instructor/private-lesson-passes/{passId}": (r) =>
        lessonBookings.getPass(r, { params: Promise.resolve({ passId: randomUUID() }) }),
      "POST /api/instructor/private-lesson-passes/{passId}/bookings": (r) =>
        lessonBookings.book(r, { params: Promise.resolve({ passId: randomUUID() }) }),
      "POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule": (r) =>
        lessonBookings.reschedule(r, { params: Promise.resolve({ bookingId: randomUUID() }) }),
      "POST /api/instructor/private-lesson-bookings/{bookingId}/cancel": (r) =>
        lessonBookings.cancel(r, { params: Promise.resolve({ bookingId: randomUUID() }) }),
      "GET /api/instructor/schedule": (r) =>
        instructorSchedule.get(withQuery(r, { from: "2026-11-23", to: "2026-11-29" }), undefined),
      "GET /api/academies/{academyId}/staff-notices": (r) =>
        listAcademyStaffNotices(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/instructor/staff-notices": (r) => listInstructorStaffNotices(r, undefined),
      "GET /api/instructor/dashboard": (r) => instructorDashboard(r, undefined),
      "GET /api/instructor/headcount": (r) => instructorHeadcount(r, undefined),
      "GET /api/instructor/offerings/{offeringId}/member-levels": (r) =>
        instructorMemberLevels(r, { params: Promise.resolve({ offeringId: randomUUID() }) }),
      "POST /api/instructor/level-evaluations": (r) => instructorLevelEvaluations(r, undefined),
      "GET /api/instructor/new-class-candidates": (r) => newClassCandidates(withQuery(r, candidateQuery), undefined),
      "GET /api/instructor/new-class-candidates/list": (r) => newClassCandidateList(withQuery(r, candidateQuery), undefined),
      "POST /api/instructor/new-class-candidates/{memberId}/reveal-contact": (r) =>
        revealCandidateContact(r, { params: Promise.resolve({ memberId: randomUUID() }) }),
      "POST /api/instructor/staff-notices/{noticeId}/read": (r) =>
        readInstructorStaffNotice(r, { params: Promise.resolve({ noticeId: randomUUID() }) }),
      "GET /api/staff/notifications": (r) => staffNotifications(r, undefined),
      "GET /api/staff/notifications/unread-count": (r) => staffUnreadCount(r, undefined),
      "POST /api/staff/notifications/{id}/read": (r) => staffReadNotification(r, missingApplicationCtx),
      "POST /api/staff/notifications/read-all": (r) => staffReadAll(r, undefined),
      "POST /api/files": (r) => uploadFile(r, undefined),
      "GET /api/files/{fileId}": (r) => downloadFile(r, { params: Promise.resolve({ fileId: randomUUID() }) }),
      "GET /api/terms/merchant-onboarding": (r) => merchantOnboardingTerms(r, undefined),
      "GET /api/no-show-policy": (r) => noShowPolicy(r, undefined),
      "GET /api/terms/versions/{termsVersionId}": (r) =>
        termsVersion(r, { params: Promise.resolve({ termsVersionId: randomUUID() }) }),
      "POST /api/admin/terms-versions": (r) => publishTermsVersion(r, undefined),
      "GET /api/admin/console/holidays": (r) => adminHolidays.list(r, undefined),
      "POST /api/admin/console/holidays": (r) => adminHolidays.create(r, undefined),
      "PATCH /api/admin/console/holidays/{holidayId}": (r) => adminHolidays.update(r, holidayCtx),
      "DELETE /api/admin/console/holidays/{holidayId}": (r) => adminHolidays.remove(r, holidayCtx),
      "GET /api/admin/console/business-checks": (r) => businessChecks.list(r, undefined),
      "GET /api/admin/console/business-checks/{caseId}": (r) => businessChecks.detail(r, businessCaseCtx),
      "POST /api/admin/console/business-checks/{caseId}/suspend-listing": (r) => businessChecks.suspend(r, businessCaseCtx),
      "POST /api/admin/console/business-checks/{caseId}/accept-explanation": (r) => businessChecks.accept(r, businessCaseCtx),
      "GET /api/academies/{academyId}/consents": (r) => academyConsents(r, { params: Promise.resolve({ academyId: academyA }) }),
      "POST /api/academies/{academyId}/terms-notices/{noticeId}/read": (r) =>
        readTermsNotice(r, { params: Promise.resolve({ academyId: academyA, noticeId: randomUUID() }) }),
      "GET /api/academies/{academyId}/refund-notices": (r) =>
        refundNoticeRead.getCurrent(r, { params: Promise.resolve({ academyId: academyA }) }),
      "GET /api/academies/{academyId}/refund-notices/{kind}/versions": (r) => refundNoticeRead.listVersions(r, refundKindCtx),
      "GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}": (r) =>
        refundNoticeRead.getVersion(r, { params: Promise.resolve({ academyId: academyA, kind: "regular", version: "1" }) }),
      "POST /api/academies/{academyId}/refund-notices/{kind}/versions": (r) => publishRefundNotice(r, refundKindCtx),
      "회원 앱 경로(requireMember)": (r) => memberRoute(r, {}),
    };

    // 모든 칸을 실제로 부른다(행 × 열). 서로 영향을 주지 않도록 차례로 부른다.
    // WEB_AND_APP 경로는 표의 칸을 관리자 웹(쿠키)으로 부르고, 이어서 앱(Bearer)으로 한 번 더 부른다
    for (const route of Object.keys(MATRIX) as RouteName[]) {
      const both = WEB_AND_APP.has(route);
      for (const actor of ACTORS) {
        const res = await callers[route](requestFor(actor, route, both ? "web" : "app"));
        actual[route] = { ...actual[route], [actor]: await summarize(res) };
      }
      if (!both) continue;
      for (const actor of ACTORS) {
        const res = await callers[route](requestFor(actor, route, "app"));
        actualApp[route] = { ...actualApp[route], [actor]: await summarize(res) };
      }
    }
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // 행마다 하나의 테스트 — 실패하면 어느 경로의 어느 칸이 틀렸는지 바로 보인다
  for (const route of Object.keys(MATRIX) as RouteName[]) {
    test(`행: ${route}`, () => {
      expect(actual[route]).toEqual(MATRIX[route]);
    });
  }

  // 웹·앱 겸용 경로는 앱(Bearer)으로 부른 행도 본다 — 2단계 칸만 빠지고 나머지는 웹과 같아야 한다
  for (const route of [...WEB_AND_APP]) {
    test(`앱 행: ${route}`, () => {
      expect(actualApp[route]).toEqual(appExpectation(route));
    });
  }

  test(`허용 밖 요청 0건 (${Object.keys(MATRIX).length}행 × ${ACTORS.length}열 = ${Object.keys(MATRIX).length * ACTORS.length}칸 + 앱 ${WEB_AND_APP.size}행)`, () => {
    // 표는 막으라는데(4xx) 실제로 열린(2xx) 칸만 모은다. 이것이 M0 완료 기준의 「허용 밖」이다.
    const outOfPolicy = (Object.keys(MATRIX) as RouteName[]).flatMap((route) =>
      ACTORS.filter((actor) => !isAllowed(MATRIX[route][actor]) && isAllowed(actual[route]?.[actor] ?? "")).map(
        (actor) => `${route} / ${actor} → ${actual[route]?.[actor]}`,
      ),
    );
    const outOfPolicyApp = [...WEB_AND_APP].flatMap((route) =>
      ACTORS.filter((actor) => !isAllowed(appExpectation(route)[actor]) && isAllowed(actualApp[route]?.[actor] ?? "")).map(
        (actor) => `앱 ${route} / ${actor} → ${actualApp[route]?.[actor]}`,
      ),
    );
    expect([...outOfPolicy, ...outOfPolicyApp]).toEqual([]);
  });

  test("역할 4종마다 열리는 경로와 막히는 경로가 둘 다 있다(표가 전부 막거나 전부 여는 빈 껍데기가 아니다)", () => {
    const roleColumns: Record<string, readonly ActorKey[]> = {
      member: ["member"],
      instructor: ["instructor", "delegateRoster", "delegateClass", "delegateNo2fa"],
      owner: ["ownerA", "ownerB"],
      admin: ["admin"],
    };
    for (const [role, columns] of Object.entries(roleColumns)) {
      const cells = (Object.keys(MATRIX) as RouteName[]).flatMap((route) => columns.map((c) => MATRIX[route][c]));
      expect({ role, someAllowed: cells.some(isAllowed), someDenied: cells.some((c) => !isAllowed(c)) }).toEqual({
        role,
        someAllowed: true,
        someDenied: true,
      });
    }
  });

  test("운영자 역할은 어떤 경로로도 생기지 않고, 대표 역할 부여는 감사 기록 1행을 남긴다", async () => {
    const admins = await q("SELECT count(*)::int AS n FROM role_grants WHERE staff_account_id = $1 AND role = 'admin'", [grantTargetId]);
    expect((admins.rows[0] as { n: number }).n).toBe(0);
    const audits = await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'role_grant.changed'");
    expect((audits.rows[0] as { n: number }).n).toBe(1);
  });

  test("app/api 의 모든 route.ts 가 표에 있다(새 경로가 생기면 MATRIX 에 한 줄 더한다)", () => {
    const files = listRouteFiles(join(APP_ROOT, "app", "api")).sort();
    expect(files).toEqual(Object.keys(ROUTE_FILE_COVERAGE).sort());
    // 대응표가 가리키는 행이 실제로 MATRIX 에 있어야 한다
    for (const target of Object.values(ROUTE_FILE_COVERAGE)) {
      if (typeof target === "string") expect(Object.keys(MATRIX)).toContain(target);
    }
  });
});
