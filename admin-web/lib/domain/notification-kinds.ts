// S7-1.3(알림 종류와 밤 지연 판정) — 계약 15 §0-2(알림 종류 세 분류) · §1-4(발송 판정 ③) · data-model §12-2·§12-9
// spec FR-146(광고성 알림 동의) · Q27(광고성 알림의 밤) 임시 확정: 21:00~다음 날 08:00(KST)의 광고성 알림은 08:00 뒤로 미룬다.
//
// 이 파일이 「알림 kind → class」의 단일 원본이다(data-model 열린 점 ②). 알림 행을 쓰는 쪽은
// kind 와 함께 여기서 고른 class 를 쓰고, 발송기는 class 만 보고 판정한다.
// 모두 순수 함수다 — DB·현재 시각을 직접 읽지 않고, 시각과 설정값을 인자로 받는다.
import "temporal-polyfill/full/global";

import type { NotificationKind } from "./constants";
import { KST_TIME_ZONE, formatTimeOfDay, parseTimeOfDay } from "./time";

/** notifications.class — 거래(끌 수 없음) · 서비스(켜고 끔) · 광고성(동의해야 받고 밤에는 미룸) */
export const NOTIFICATION_CLASSES = ["transactional", "service", "marketing"] as const;
export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/**
 * 지금 있는 알림 kind 마다 class 를 정한 표.
 * `Record<NotificationKind, …>` 라서 constants.ts 에 kind 가 새로 생기면 여기 한 줄을 더하기 전까지 타입 검사가 실패한다
 * — 분류를 빠뜨린 채 알림을 쓰는 일을 막으려는 것이다.
 */
export const NOTIFICATION_KIND_CLASS: Readonly<Record<NotificationKind, NotificationClass>> = {
  // 결제·환불·예약 취소 — data-model §12-9 「기존 kind 의 class」 = 거래
  payment_confirmed_member: "transactional",
  payment_confirmed_owner: "transactional",
  reservation_cancelled: "transactional",
  refund_pending: "transactional",
  refund_failed: "transactional",
  payment_refund_due: "transactional",
  // 직원 알림함 10종(§7-9) = 거래. 대표·강사 앱에는 광고성이 없다(O34)
  share_rate_changed: "transactional",
  affiliation_requested: "transactional",
  affiliation_approved: "transactional",
  affiliation_rejected: "transactional",
  delegation_changed: "transactional",
  staff_notice_published: "transactional",
  merchant_application_approved: "transactional",
  merchant_application_rejected: "transactional",
  payout_account_changed: "transactional",
  terms_change_notice: "transactional",
  // 이용 제한·소속 해제 — §12-9 restriction_notice = 거래, 소속 해제도 계정·정산이 바뀌는 통지라 거래
  restriction_notice: "transactional",
  // P11 게시 중단 · 사업자 점검 제한 해제(S1-1.29) — data-model §12-9 에서 거래 알림으로 정했다
  listing_suspended: "transactional",
  business_restriction_lifted: "transactional",
  release_completed: "transactional",
  release_requested: "transactional",
  release_declined: "transactional",
  // 수업 승인 흐름(직원끼리) — 직원 알림이라 거래
  class_submitted: "transactional",
  class_approved: "transactional",
  class_revision_requested: "transactional",
  class_approval_reminder: "transactional",
  // 회차 변경·휴강·폐강·강사 바뀜 — 계약 15 §0-2 「예약 변경·휴강」 = 거래
  session_time_place_changed: "transactional",
  session_cancelled: "transactional",
  class_closed: "transactional",
  instructor_session_changed: "transactional",
  substitute_requested: "transactional",
  substitute_accepted: "transactional",
  substitute_confirmed: "transactional",
  instructor_changed: "transactional",
  substitute_assigned: "transactional",
  // 강사 수업 공지 — 그 수업을 산 수강생에게만 가는 수업 안내라 광고성이 아니다(추천안 — EVIDENCE.md 참고)
  class_announcement: "transactional",
  // 개인 레슨 회차·공개 뒤 수업 수정 — 이미 산 수업의 일정이 바뀌는 통지 = 거래
  private_lesson_booked: "transactional",
  private_lesson_cancelled: "transactional",
  class_edit_requested: "transactional",
  class_edit_approved: "transactional",
  class_edit_rejected: "transactional",
  class_changed: "transactional",
  // 결석 표시·이의 — 출석 기록(돈이 걸린 회차 소진)에 대한 통지 = 거래
  absence_marked: "transactional",
  absence_dispute_requested: "transactional",
  absence_dispute_resolved: "transactional",
  // 입금 기한 임박 — FR-146 임시 확정 「입금 기한 알림은 회원이 요청한 거래에 딸린 서비스 알림」
  payment_deadline_soon: "service",
  // 역할 불균형 경보 — data-model §15-4 ⑤ 「분류 service」(운영 안내라 직원이 켜고 끌 수 있는 서비스 알림)
  gender_imbalance: "service",
  // 수업 전 알림 — data-model §12-9 「pre_class_reminder(service)」 · 계약 15 §0-2 표의 서비스 묶음
  pre_class_reminder: "service",
  // 문의 접수·답변·기한 넘김 재알림 — data-model §12-9 「inquiry_*(transactional)」 · 계약 15 §0-2 「문의 답변」은 거래 묶음
  inquiry_received: "transactional",
  inquiry_answered: "transactional",
  inquiry_overdue: "transactional",
  // 신고 접수·확인 시작·결과·운영자 접수 알림 — data-model §12-9 「report_*(transactional)」 · 계약 15 §0-2 「신고 접수·결과」는 거래 묶음
  report_received: "transactional",
  report_filed: "transactional",
  report_in_review: "transactional",
  report_resolved: "transactional",
  // S4-1.5a — 계좌 환불 송금 완료 · 계좌 다시 입력 요청. 돈이 걸린 결과라 거래 알림이다(끌 수 없다)
  refund_completed: "transactional",
  refund_account_reinput: "transactional",
  // S6-3.3 — 정규 과정을 마쳐 레벨이 오르고 카드가 발급됨. 돈이 걸리지 않은 성장 소식이라 서비스 알림(켜고 끔, 추천안 — 증거 EVIDENCE.md)
  level_up: "service",
  // S6-3.4 — 강사가 올려 준 레벨 승급 안내. level_up 과 같은 성장 소식이라 서비스 알림(켜고 끔, 추천안 — 증거 EVIDENCE.md)
  level_offer: "service",
};

/** kind → class. 표에 없는 값은 타입이 막지만, 문자열로 들어온 경우를 위해 한 번 더 확인한다 */
export function notificationClassOf(kind: NotificationKind): NotificationClass {
  const cls = NOTIFICATION_KIND_CLASS[kind];
  if (!cls) {
    throw new RangeError(`분류되지 않은 알림 kind: "${kind}"`);
  }
  return cls;
}

/** 거래 알림만 끌 수 없다(계약 15 §0-2 「못 끈다」, S7-1 수용 ①) */
export function isDisableableClass(cls: NotificationClass): boolean {
  return cls !== "transactional";
}

/**
 * 광고성 알림을 보내지 않는 밤 — ops_settings 의 `notification.quiet_hours` 값 모양 그대로(data-model §12-4).
 * `from` 부터(포함) `to` 직전까지가 밤이다. `from > to` 면 자정을 넘는다(기본 21:00 → 08:00).
 */
export type QuietHours = { from: string; to: string };

/** 설정 표가 비었을 때 쓰는 기본값 — FR-146·Q27 임시 확정(2026-11-10) */
export const DEFAULT_QUIET_HOURS: QuietHours = { from: "21:00", to: "08:00" };

/** 하루 중 시각을 0시부터 지난 분으로 — 밤 범위 비교를 정수로 하려는 것 */
function minutesOfDay(time: Temporal.PlainTime): number {
  return time.hour * 60 + time.minute;
}

/** 설정값 검사: HH:MM 두 개이고 서로 달라야 한다(같으면 밤이 0분인지 24시간인지 뜻이 갈려 거부한다) */
function parseQuietHours(quiet: QuietHours): { from: number; to: number } {
  const from = minutesOfDay(parseTimeOfDay(quiet.from));
  const to = minutesOfDay(parseTimeOfDay(quiet.to));
  if (from === to) {
    throw new RangeError(`밤 시작과 끝이 같다: ${quiet.from}~${quiet.to}`);
  }
  return { from, to };
}

/**
 * 그 순간이 밤(KST)인가. 경계: 20:59 아님 · 21:00 밤 · 07:59 밤 · 08:00 아님(계약 15 §1-4).
 * 초는 버리고 분으로 비교한다 — 20:59:59 는 20:59 로 보아 밤이 아니고, 07:59:59 는 07:59 로 보아 아직 밤이다.
 */
export function isQuietHour(at: Temporal.Instant, quiet: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const { from, to } = parseQuietHours(quiet);
  const now = minutesOfDay(at.toZonedDateTimeISO(KST_TIME_ZONE).toPlainTime());
  // 자정을 넘는 밤(21:00~08:00): 21:00 이후거나 08:00 이전이면 밤
  if (from > to) {
    return now >= from || now < to;
  }
  // 같은 날 안의 범위(예: 01:00~06:00)
  return now >= from && now < to;
}

/**
 * 밤이 끝나는 순간 — 밤 안의 순간을 받아 「같은 날 또는 다음 날 08:00(KST)」을 돌려준다.
 * 21:30 이면 다음 날 08:00, 02:00 이면 그날 08:00 이다. 밤이 아니면 null.
 */
export function quietHoursEnd(at: Temporal.Instant, quiet: QuietHours = DEFAULT_QUIET_HOURS): Temporal.Instant | null {
  if (!isQuietHour(at, quiet)) {
    return null;
  }
  const zoned = at.toZonedDateTimeISO(KST_TIME_ZONE);
  const endTime = parseTimeOfDay(quiet.to);
  // 오늘의 끝 시각이 아직 안 왔으면 오늘, 이미 지났으면(밤이 막 시작된 저녁) 다음 날
  const today = zoned.toPlainDate();
  const endToday = today.toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: endTime }).toInstant();
  if (Temporal.Instant.compare(endToday, at) > 0) {
    return endToday;
  }
  return today.add({ days: 1 }).toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: endTime }).toInstant();
}

/**
 * 발송 판정 ③(계약 15 §1-4) — 이 알림을 지금 보내도 되는지, 미뤄야 하면 언제까지인지.
 * 광고성만 밤에 미룬다. 거래·서비스는 밤에도 그대로 보낸다(FR-146 임시 확정 — 대기·입금 기한·수업 전 알림 포함).
 * 돌려준 `deliverAfter` 를 notifications.deliver_after 에 쓰고 행은 pending 으로 둔다.
 */
export function deferralFor(
  cls: NotificationClass,
  at: Temporal.Instant,
  quiet: QuietHours = DEFAULT_QUIET_HOURS,
): { defer: false } | { defer: true; deliverAfter: Temporal.Instant } {
  if (cls !== "marketing") {
    return { defer: false };
  }
  const end = quietHoursEnd(at, quiet);
  return end ? { defer: true, deliverAfter: end } : { defer: false };
}

/** 화면 문구용 「21:00~08:00」 — 회원 알림 설정 응답의 quietHours 와 같은 모양으로 맞춘다 */
export function formatQuietHours(quiet: QuietHours = DEFAULT_QUIET_HOURS): string {
  return `${formatTimeOfDay(parseTimeOfDay(quiet.from))}~${formatTimeOfDay(parseTimeOfDay(quiet.to))}`;
}

// ---- 강사 정규 신청·취소는 휴대폰에 보내지 않는다(S7-1.4, 계약 15 §1-3 · 보드 I-08) ----------------------------

/** notifications.push_suppressed_reason 값(data-model §12-2). 알림함 행은 남기고 휴대폰 푸시만 건너뛴 까닭이다 */
export const PUSH_SUPPRESSED_REASONS = ["no_permission", "not_agreed", "instructor_regular_signup", "setting_off"] as const;
export type PushSuppressedReason = (typeof PUSH_SUPPRESSED_REASONS)[number];

/** 강사 앞으로 오는 수강 소식 가운데 정규 수업 신청·취소 — 하루에도 여러 번 생겨 휴대폰을 울리면 소음이 된다 */
export type InstructorEnrollmentEvent = "regular_signup" | "regular_cancel";

/**
 * 강사에게 가는 정규 수업 신청·취소 알림을 어떻게 다루나.
 * 늘 「알림함에는 쓰고 휴대폰 푸시는 보내지 않는다」이다(I-08). 강사가 설정으로 켤 수도 없다 — O34 의 끌 수 있는 주제에 없다.
 * 알림 행을 만드는 쪽이 이 결과의 reason 을 `push_suppressed_reason` 에 그대로 적는다.
 */
export function instructorEnrollmentDelivery(_event: InstructorEnrollmentEvent): {
  inbox: true;
  push: false;
  reason: "instructor_regular_signup";
} {
  return { inbox: true, push: false, reason: "instructor_regular_signup" };
}
