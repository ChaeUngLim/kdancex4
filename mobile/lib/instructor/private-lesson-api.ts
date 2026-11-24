/**
 * 개인 레슨 수강생 상세 · 회차 바꾸기 · 규칙 — 경로 · 응답 모양 · 화면 계산. S2-4.8(앱 I20 · I20B · I20C).
 *
 * 부르는 경로(계약 11 §10-1 · §10-3 — 서버는 S2-4.7 이 만들었다)
 *   GET  /api/instructor/private-lesson-passes/{passId}                     수강생 상세 · 다음 회차 후보(I20 · I20B)
 *   POST /api/instructor/private-lesson-passes/{passId}/bookings            다음 회차 잡기(I20, Idempotency-Key)
 *   POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule     회차 시간 바꾸기(I20B)
 *   POST /api/instructor/private-lesson-bookings/{bookingId}/cancel         회차 취소 — 강사 사정 · 회원 요청(I20B)
 *   GET  /api/instructor/private-lesson-rules?academyId=                    학원별 개인 레슨 규칙(I20C)
 *   POST /api/instructor/private-lesson-rules                               규칙 저장 = 새 판본(I20C, Idempotency-Key)
 *
 * 응답 모양은 admin-web `lib/server/services/private-lesson-bookings.ts` · `private-lesson-rules.ts` 의 zod 스키마와 같다.
 * 이 파일의 계산 함수는 입력을 바꾸지 않는 순수 함수라 렌더 중에 바로 불러 쓴다.
 */
import { apiFetch } from '../api';
import { formatKstTime, toKstParts } from '../catalog/format';
import { DISCIPLINES_OF, SUB_GENRES_OF } from './class-api';
import { kstDateOf, slashDayWithWeekday, type PrivateLessonPass } from './schedule-api';

// ---- 수강생 상세(§10-3) ---------------------------------------------------------------------------

/** 회차 상태 — 차감 없음: 강사 사정·기한 전 회원 취소 / 1회 차감: 마침·기한 지난 회원 취소·오지 않음 */
export type BookingStatus = 'booked' | 'done' | 'cancelled_instructor' | 'cancelled_member_free' | 'cancelled_member_late' | 'no_show';

export interface PassBooking {
  bookingId: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  deducted: boolean;
}

export interface OpenSlot {
  slotId: string;
  startsAt: string;
  endsAt: string;
  roomName: string | null;
}

export interface PrivateLessonPassDetail extends PrivateLessonPass {
  /** 결제 읽기 값. 결제 전이면 null. 결제 수단은 M3 전이라 null 일 수 있다 */
  payment: { paidAt: string; method: string | null; amount: number } | null;
  /** 이 수강권에 고정된 규칙 판본(결제 때 판본 — 나중에 규칙을 바꿔도 그대로) */
  rule: { version: number; changeDeadlineHours: number; validityMonths: number };
  bookings: PassBooking[];
  /** 지금 잡을 수 있는 「레슨 모집」 시간(시작 전 · open) */
  openSlots: OpenSlot[];
}

export function passDetailPath(passId: string): string {
  return `/api/instructor/private-lesson-passes/${encodeURIComponent(passId)}`;
}

/** 회차 번호를 먹는 상태 — 서버 COUNTED_BOOKING_STATUSES(강사 일정의 sessionNo)와 같은 기준 */
const COUNTED: ReadonlySet<BookingStatus> = new Set(['booked', 'done', 'no_show', 'cancelled_member_late']);

/** 번호가 붙은 회차 — 시작 시각순으로 1, 2, 3 … (취소돼 회차를 돌려받은 것은 번호가 없다) */
export interface NumberedBooking extends PassBooking {
  sessionNo: number;
}

export function numberedBookings(bookings: readonly PassBooking[]): NumberedBooking[] {
  const counted = [...bookings].filter((b) => COUNTED.has(b.status)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return counted.map((b, index) => ({ ...b, sessionNo: index + 1 }));
}

/**
 * I20 화면에 필요한 숫자를 한 번에 계산한다.
 *  - 진행 = 차감된 회차(sessionsUsed) · 남은 = remainingSessions(서버 값 그대로)
 *  - 마지막 레슨 = 이미 시작한 회차 중 가장 늦은 것
 *  - 앞으로 잡힌 회차 = 아직 끝나지 않은 booked
 *  - 다음에 잡을 번호 = 번호 붙은 회차 수 + 1, 더 잡을 수 있는 수 = 전체 − 번호 붙은 회차 수
 */
export function passProgress(detail: PrivateLessonPassDetail, now: Date) {
  const numbered = numberedBookings(detail.bookings);
  const nowMs = now.getTime();
  const started = numbered.filter((b) => Date.parse(b.startsAt) <= nowMs);
  const upcoming = numbered.filter((b) => b.status === 'booked' && Date.parse(b.endsAt) > nowMs);
  return {
    last: started.length > 0 ? started[started.length - 1]! : null,
    upcoming,
    nextNo: numbered.length + 1,
    remainingToBook: Math.max(0, detail.sessionsTotal - numbered.length),
  };
}

/** 회차를 새로 잡을 수 있는 수강권인가 — 사용 중(active)만. 결제 대기·만료·환불·다 쓴 수강권은 못 잡는다 */
export function canBook(detail: PrivateLessonPassDetail): boolean {
  return detail.status === 'active' && detail.awaitingPayment === null;
}

export interface BookedSlot {
  bookingId: string;
  slotId: string;
  status: 'booked';
  remainingToBook: number;
}

/** 다음 회차 잡기 — 같은 키로 다시 보내면 서버가 처음 회차를 200 으로 돌려준다(중복 회차 없음) */
export function bookSlot(passId: string, slotId: string, idempotencyKey: string): Promise<BookedSlot> {
  return apiFetch<BookedSlot>(`${passDetailPath(passId)}/bookings`, { method: 'POST', body: { slotId }, idempotencyKey });
}

// ---- 회차 바꾸기 · 취소(§10-3, I20B) --------------------------------------------------------------

export interface RescheduledBooking {
  bookingId: string;
  slotId: string;
  startsAt: string;
  endsAt: string;
  status: 'booked';
}

export function rescheduleBooking(bookingId: string, slotId: string): Promise<RescheduledBooking> {
  return apiFetch<RescheduledBooking>(`/api/instructor/private-lesson-bookings/${encodeURIComponent(bookingId)}/reschedule`, {
    method: 'POST',
    body: { slotId },
  });
}

export interface CancelledBooking {
  bookingId: string;
  status: 'cancelled_instructor' | 'cancelled_member_free' | 'cancelled_member_late';
  deducted: boolean;
  sessionsUsed: number;
  remainingSessions: number;
}

/** 취소 사유 길이 상한 — 서버 CANCEL_REASON_MAX 와 같다 */
export const CANCEL_REASON_MAX = 200;

/**
 * 회차 취소. 강사 사정(`instructor`)은 서버가 사유를 꼭 받는다(1~200자, 회원에게 보임).
 * 회원 요청(`member`)은 사유가 없어도 된다 — 빈 칸이면 본문에서 뺀다.
 */
export function cancelBooking(bookingId: string, by: 'instructor' | 'member', reason: string): Promise<CancelledBooking> {
  const trimmed = reason.trim();
  const body = by === 'instructor' ? { by, reason: trimmed } : trimmed === '' ? { by } : { by, reason: trimmed };
  return apiFetch<CancelledBooking>(`/api/instructor/private-lesson-bookings/${encodeURIComponent(bookingId)}/cancel`, {
    method: 'POST',
    body,
  });
}

/**
 * 회원 요청 취소를 지금 기록하면 차감되나 — 화면 미리 보기용(최종 판정은 서버의 S2-4.3 함수).
 * 시작까지 남은 시간 ≥ 기한이면 차감 없음. 경계(정확히 기한 시각)도 차감 없음(계약 추천안과 같다).
 */
export function memberCancelIsFree(startsAt: string, changeDeadlineHours: number, now: Date): boolean {
  return Date.parse(startsAt) - now.getTime() >= changeDeadlineHours * 3_600_000;
}

// ---- 규칙(§10-1, I20C) ----------------------------------------------------------------------------

export const CHANGE_DEADLINE_HOURS = [12, 24, 48] as const;
export const VALIDITY_MONTHS = [2, 3, 6] as const;
export type ChangeDeadlineHours = (typeof CHANGE_DEADLINE_HOURS)[number];
export type ValidityMonths = (typeof VALIDITY_MONTHS)[number];
/** 추천값(기본값) — 서버 DEFAULT_PRIVATE_LESSON_* 와 같다 */
export const RECOMMENDED_VALIDITY_MONTHS: ValidityMonths = 3;

export interface PrivateLessonRule {
  academyId: string;
  version: number;
  changeDeadlineHours: number;
  validityMonths: number;
  effectiveFrom: string;
  memberNotice: string[];
}

/** GET 응답 — 저장한 적이 없으면 version·effectiveFrom 이 null, isDefault 가 true */
export interface PrivateLessonRuleView extends Omit<PrivateLessonRule, 'version' | 'effectiveFrom'> {
  version: number | null;
  effectiveFrom: string | null;
  current: Omit<PrivateLessonRule, 'memberNotice'> | null;
  isDefault: boolean;
}

export function rulePath(academyId: string): string {
  return `/api/instructor/private-lesson-rules?academyId=${encodeURIComponent(academyId)}`;
}

/** 규칙 저장. 지금 판본과 같은 값이면 서버가 200(새 판본 없음), 다르면 201 새 판본 — 화면은 판본 번호로 구별한다 */
export function saveRule(
  input: { academyId: string; changeDeadlineHours: ChangeDeadlineHours; validityMonths: ValidityMonths },
  idempotencyKey: string,
): Promise<PrivateLessonRule> {
  return apiFetch<PrivateLessonRule>('/api/instructor/private-lesson-rules', { method: 'POST', body: input, idempotencyKey });
}

/**
 * 「회원에게 이렇게 보여요」 네 줄 — 서버 privateLessonMemberNotice 와 글자까지 같다.
 * 칩을 바꾸는 즉시(저장 전) 미리 보이려고 화면이 같은 문장을 만든다. 저장한 뒤에는 서버 문장이 원본이다.
 */
export function memberNoticeLines(changeDeadlineHours: number, validityMonths: number): string[] {
  return [
    `레슨 시작 ${changeDeadlineHours}시간 전까지 바꾸거나 취소할 수 있어요`,
    '그 뒤에 취소하거나 오지 않으면 1회가 차감돼요',
    `수강권은 결제일부터 ${validityMonths}개월 안에 써요`,
    '남은 회차 환불은 학원에 문의해요',
  ];
}

export function isDeadline(value: number): value is ChangeDeadlineHours {
  return (CHANGE_DEADLINE_HOURS as readonly number[]).includes(value);
}

export function isValidity(value: number): value is ValidityMonths {
  return (VALIDITY_MONTHS as readonly number[]).includes(value);
}

// ---- 보드 글자 ---------------------------------------------------------------------------------------

/** 「11/12 (목) 21:00–21:50」 */
export function lessonWhen(startsAt: string, endsAt: string): string {
  return `${slashDayWithWeekday(kstDateOf(startsAt))} ${formatKstTime(startsAt)}–${formatKstTime(endsAt)}`;
}

/** 「11/12 (목) 21:00」 */
export function lessonStart(startsAt: string): string {
  return `${slashDayWithWeekday(kstDateOf(startsAt))} ${formatKstTime(startsAt)}`;
}

/** 「2027-01-05 (화)」 — 사용 기한 */
export function fullDateWithWeekday(iso: string): string {
  const ymd = kstDateOf(iso);
  return `${ymd} ${slashDayWithWeekday(ymd).replace(/^\S+ /, '')}`;
}

/** 결제 수단 글자. M3 전이라 null 이면 빈 글자(그 칸을 빼고 보인다) */
const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  card: '신용카드',
  bank_transfer: '계좌이체',
  virtual_account: '가상계좌',
  easy_pay: '간편결제',
};

export function paymentMethodLabel(method: string | null): string {
  if (method === null) return '';
  return PAYMENT_METHOD_LABELS[method] ?? method;
}

/** 「라틴」 — 종목(차차차 등)이 속한 세부 장르의 짧은 이름. 모르면 빈 글자 */
export function subGenreShortOf(discipline: string | null): string {
  if (discipline === null) return '';
  const subGenre = Object.keys(DISCIPLINES_OF).find((key) => DISCIPLINES_OF[key]!.some((d) => d.value === discipline));
  if (subGenre === undefined) return '';
  const label = Object.values(SUB_GENRES_OF).flat().find((s) => s?.value === subGenre)?.label ?? '';
  return label.replace(/^댄스스포츠\((.+)\)$/, '$1');
}

/** 수강권 상태 배지 */
export function passStatusLabel(detail: PrivateLessonPassDetail): string {
  if (detail.awaitingPayment !== null || detail.status === 'pending_payment') return '결제 대기';
  switch (detail.status) {
    case 'active':
      return '결제 완료';
    case 'completed':
      return '다 씀';
    case 'expired':
      return '기한 끝남';
    case 'refunded':
      return '환불됨';
    default:
      return detail.status;
  }
}

/** 「11/20 부터」 — 규칙 판본이 적용되기 시작한 날 */
export function effectiveFromLabel(iso: string): string {
  const p = toKstParts(new Date(iso));
  return `${p.month}/${p.day} 부터`;
}
