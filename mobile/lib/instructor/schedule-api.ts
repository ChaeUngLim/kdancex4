/**
 * 강사 일정·개인 레슨 — 경로 · 응답 모양 · 화면 계산. S2-4.6(앱 개인 레슨·일정 화면).
 *
 * 부르는 경로(계약 11)
 *   GET  /api/instructor/schedule?from=&to=&academyId=&include=     강사 일정 한 줄 목록(§11, S2-4.5 가 만듦)
 *   POST /api/instructor/private-lesson-products                    개인 레슨 수강권 상품 열기(§10-1, S2-4.2 가 만듦)
 *   GET  /api/instructor/private-lesson-passes?academyId=           수강생별 수강권 · 남은 횟수(§10-3)
 *   POST /api/instructor/private-lesson-products/{classId}/slots    「레슨 모집」 시간 열기(§10-2)
 *
 * 뒤의 두 경로는 계약에만 있고 서버에는 아직 없다(로드맵에 맡은 Task 이름이 없다 — 증거 EVIDENCE.md 에 적었다).
 * 그래서 화면은 그 두 경로가 실패해도 나머지 칸은 그대로 그리고, 실패한 칸에만 「다시 시도」를 단다.
 *
 * 시각은 서버가 UTC(`…Z`)로만 준다. 한국 표준시는 늘 UTC+9 라 9시간을 더해 읽는다(lib/catalog/format.ts 와 같은 방식).
 * 이 파일의 계산 함수는 모두 입력을 바꾸지 않는 순수 함수다 — 렌더 중에 바로 불러 쓴다.
 */
import { apiFetch } from '../api';
import { formatDateKey, toKstDateKey, toKstParts } from '../catalog/format';

// ---- 응답 모양(계약 11 §11 · admin-web instructor-schedule.ts 의 zod 스키마와 같다) ------------------

export interface ScheduleAcademy {
  academyId: string;
  name: string;
  /** 학원 색 번호(0~11). 아직 색이 없으면 null */
  colorIndex: number | null;
}

export interface SeatCounts {
  male: number | null;
  female: number | null;
  any: number | null;
}

export interface ClassSessionItem {
  kind: 'class_session';
  id: string;
  classId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  academy: ScheduleAcademy;
  room: string | null;
  status: 'scheduled' | 'cancelled' | 'closed';
  isSubstitute: boolean;
  paid: SeatCounts;
  capacity: SeatCounts;
}

export interface PrivateLessonItem {
  kind: 'private_lesson';
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  academy: ScheduleAcademy;
  /** 멤버십이 끝나면 null — 시간·횟수만 남는다(§10-3) */
  student: { displayName: string } | null;
  sessionNo: number;
  sessionsTotal: number;
  state: 'booked' | 'done' | 'no_show';
}

export interface PrivateLessonOpenItem {
  kind: 'private_lesson_open';
  id: string;
  startsAt: string;
  endsAt: string;
  academy: ScheduleAcademy;
}

export interface PersonalItem {
  kind: 'personal';
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  repeat: 'none' | 'weekly' | 'daily';
}

export type ScheduleItem = ClassSessionItem | PrivateLessonItem | PrivateLessonOpenItem | PersonalItem;

export interface InstructorSchedule {
  from: string;
  to: string;
  items: ScheduleItem[];
  overlaps: { a: { kind: string; id: string }; b: { kind: string; id: string }; minutes: number }[];
}

export type ScheduleInclude = 'sessions' | 'private' | 'personal' | 'open';

/** 일정 주소. 학원을 고르지 않았으면(전체) academyId 를 빼서 모든 학원을 한 줄로 받는다 */
export function schedulePath(from: string, to: string, include: readonly ScheduleInclude[], academyId: string | null = null): string {
  const academy = academyId === null ? '' : `&academyId=${encodeURIComponent(academyId)}`;
  return `/api/instructor/schedule?from=${from}&to=${to}&include=${include.join(',')}${academy}`;
}

// ---- 개인 레슨 수강권(§10-3) ------------------------------------------------------------------------

export interface PrivateLessonPass {
  passId: string;
  academyId: string;
  academyName: string;
  productClassId: string;
  lessonMinutes: number;
  student: { displayName: string } | null;
  nameVisible: boolean;
  discipline: string | null;
  status: 'pending_payment' | 'active' | 'expired' | 'refunded' | (string & {});
  sessionsTotal: number;
  sessionsUsed: number;
  remainingSessions: number;
  paidAt: string | null;
  validUntil: string | null;
  nextBooking: { bookingId: string; startsAt: string; endsAt: string; sessionNo: number; state: string } | null;
  /** 결제 대기 수강권이면 결제 마감 시각 */
  awaitingPayment: { until: string } | null;
}

export function passesPath(academyId: string | null): string {
  return academyId === null
    ? '/api/instructor/private-lesson-passes'
    : `/api/instructor/private-lesson-passes?academyId=${encodeURIComponent(academyId)}`;
}

/**
 * 「수강생별 남은 횟수」에 보일 수강권 — 쓰는 중(active)과 결제 대기만.
 * 만료·환불된 수강권은 이 표에 올리지 않는다(I10 은 「지금 시간을 잡아 줄 사람」 목록이다).
 */
export function visiblePasses(passes: readonly PrivateLessonPass[]): PrivateLessonPass[] {
  return passes.filter((pass) => pass.status === 'active' || pass.awaitingPayment !== null);
}

// ---- 개인 레슨 상품 열기(§10-1) ---------------------------------------------------------------------

export const LESSON_MINUTES = [50, 80] as const;
export type LessonMinutes = (typeof LESSON_MINUTES)[number];
/** 수강권 횟수 기본 10 · 상한 50(서버 PRIVATE_LESSON_SESSION_MAX 와 같다) */
export const DEFAULT_SESSION_COUNT = 10;
export const SESSION_COUNT_MAX = 50;
/** 금액 상한 1,000만 원(서버 CLASS_PRICE_MAX 와 같다) */
export const PRICE_MAX = 10_000_000;

export interface PrivateLessonProductInput {
  academyId: string;
  subGenre: string | null;
  lessonMinutes: LessonMinutes;
  sessionCount: number;
  priceAmount: number;
}

export interface PrivateLessonProduct {
  classId: string;
  academyId: string;
  academyName: string;
  genre: string;
  subGenre: string | null;
  lessonMinutes: number;
  sessionCount: number;
  priceAmount: number;
  status: 'open' | 'closed';
  rule: { version: number; changeDeadlineHours: number; validityMonths: number };
  refundNoticeVersionId: string | null;
  payoutAcademy: string;
}

/** 상품 열기 — 멱등 키는 화면이 한 번 만들어 들고 있다(응답을 못 받고 다시 눌러도 상품은 하나) */
export function openPrivateLessonProduct(input: PrivateLessonProductInput, idempotencyKey: string): Promise<PrivateLessonProduct> {
  return apiFetch<PrivateLessonProduct>('/api/instructor/private-lesson-products', { method: 'POST', body: input, idempotencyKey });
}

/** 금액 칸 글자 → 원. 숫자가 아니거나 범위를 벗어나면 null(서버 0~1,000만 원과 같은 규칙) */
export function parsePrice(text: string): number | null {
  const digits = text.replace(/[,\s원]/g, '');
  if (!/^\d{1,8}$/.test(digits)) return null;
  const value = Number(digits);
  return value <= PRICE_MAX ? value : null;
}

// ---- 열 시간(§10-2) -------------------------------------------------------------------------------

export interface NewSlot {
  startsAt: string;
  endsAt: string;
}

export interface OpenedSlots {
  created: { slotId: string; startsAt: string; endsAt: string; status: string }[];
  repeatGroupId: string | null;
}

/** 매주 반복이면 8주(계약 기본값 · 추천값, 열린 점 ⑰), 아니면 1주(그 주 한 번) */
export const REPEAT_WEEKS = 8;

export function openLessonSlots(classId: string, slots: readonly NewSlot[], repeatWeeks: number, idempotencyKey: string): Promise<OpenedSlots> {
  return apiFetch<OpenedSlots>(`/api/instructor/private-lesson-products/${encodeURIComponent(classId)}/slots`, {
    method: 'POST',
    body: { slots, repeatWeeks },
    idempotencyKey,
  });
}

/**
 * 「21:10」 칸 검사 — 네 자리 시각 · 10분 단위(서버 규칙과 같다). 맞으면 분, 틀리면 안내 문장.
 * 화면이 미리 막아 틀린 값을 보내지 않게 한다(마지막 판정은 서버다).
 */
export function readSlotTime(text: string): { minutes: number } | { problem: string } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return { problem: '시각은 「21:10」처럼 적어 주세요.' };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { problem: '없는 시각이에요.' };
  if (minute % 10 !== 0) return { problem: '10분 단위만 열 수 있어요(예: 21:10).' };
  return { minutes: hour * 60 + minute };
}

/** KST 날짜(YYYY-MM-DD) + 그날 몇 분 → UTC ISO(`…Z`). 한국은 늘 UTC+9 라 9시간을 뺀다 */
export function kstInstant(ymd: string, minutesOfDay: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d, 0, minutesOfDay) - 9 * 60 * 60 * 1000;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// ---- 날짜 계산(KST 달력) -----------------------------------------------------------------------------

const KOREAN_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 오늘(KST) 「YYYY-MM-DD」 */
export function kstToday(now: Date = new Date()): string {
  return toKstDateKey(now);
}

/** 날짜에 n일을 더한다(달·해 넘김은 Date 가 맞춘다) */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return formatDateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function weekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 그 날짜가 든 주의 월요일 — 보드 I10 · I10C 는 월요일부터 일요일까지 한 주를 보인다 */
export function mondayOf(ymd: string): string {
  const weekday = weekdayOf(ymd);
  return addDays(ymd, weekday === 0 ? -6 : 1 - weekday);
}

/** 월요일부터 7일 */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** 「11/24」 */
export function monthSlashDay(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 「화 11/24」(I10 · I10C 날짜 칸) */
export function weekdaySlashDay(ymd: string): string {
  return `${KOREAN_WEEKDAYS[weekdayOf(ymd)]} ${monthSlashDay(ymd)}`;
}

/** 「11/24 (화)」(I1 머리) */
export function slashDayWithWeekday(ymd: string): string {
  return `${monthSlashDay(ymd)} (${KOREAN_WEEKDAYS[weekdayOf(ymd)]})`;
}

/** UTC 시각이 KST 로 어느 날인가 */
export function kstDateOf(iso: string): string {
  return toKstDateKey(new Date(iso));
}

/** 「11/26 23:59」(결제 대기 마감) */
export function slashDayTime(iso: string): string {
  const p = toKstParts(new Date(iso));
  return `${p.month}/${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 시작 시각순(같으면 끝 시각순). 서버도 정렬해 주지만, 화면이 합친 목록도 같은 순서를 쓴다 */
export function byStart<T extends { startsAt: string; endsAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt));
}

// ---- 보드 글자 ---------------------------------------------------------------------------------------

/** I10 상태 칸 — 지난 회차 「완료」, 오지 않음 「결석」, 오늘 잡힌 회차 「오늘」, 나머지 「확정」 */
export function lessonStateLabel(item: PrivateLessonItem, today: string): string {
  if (item.state === 'done') return '완료';
  if (item.state === 'no_show') return '결석';
  return kstDateOf(item.startsAt) === today ? '오늘' : '확정';
}

/** 이름이 숨겨진 수강권(멤버십 끝)은 이름 자리에 「수강생」만 쓴다 */
export function studentName(student: { displayName: string } | null): string {
  return student?.displayName ?? '수강생';
}

/**
 * I10 요약 한 줄 — 「1:1 레슨 6회 · 수강생 4명 · 오늘 1회 · 결제 대기 1」.
 * 수강권 목록을 못 읽었으면(passes = null) 수강생 수는 이번 주 레슨의 이름으로 세고 결제 대기 칸은 뺀다.
 */
export function lessonSummary(lessons: readonly PrivateLessonItem[], passes: readonly PrivateLessonPass[] | null, today: string): string {
  const todayCount = lessons.filter((item) => kstDateOf(item.startsAt) === today).length;
  const students =
    passes !== null ? passes.length : new Set(lessons.map((item) => item.student?.displayName ?? item.id)).size;
  const parts = [`1:1 레슨 ${lessons.length}회`, `수강생 ${students}명`, `오늘 ${todayCount}회`];
  if (passes !== null) parts.push(`결제 대기 ${passes.filter((pass) => pass.awaitingPayment !== null).length}`);
  return parts.join(' · ');
}

/** I1 「참석 남 · 여」 칸 — 남·여 따로 받는 수업이면 둘, 한 칸 정원이면 「인원 N」 */
export function paidLine(paid: SeatCounts): string {
  if (paid.male !== null || paid.female !== null) return `남 ${paid.male ?? 0} · 여 ${paid.female ?? 0}`;
  return `인원 ${paid.any ?? 0}`;
}
