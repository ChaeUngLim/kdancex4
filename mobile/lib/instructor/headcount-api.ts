/**
 * 강사 하루 인원표·회차 명단 — 경로 · 응답 모양 · 화면 글자 계산. S3-5.9(앱 강사 명단 화면, 보드 I1 · I7 · I23).
 *
 * 부르는 경로(계약 18)
 *   GET /api/instructor/headcount?date=&academyId=                  내 회차의 하루 인원표(§7) — I1 「오늘 수업 인원」·I7
 *   GET /api/classes/{classId}/sessions/{sessionId}/roster          그 회차의 결제 완료 수강생과 결제 대기 수(§4) — I23
 *
 * 숫자 규칙(서버가 계산해 준다 — 앱은 그대로 그린다)
 *  - 오늘 인원(present) = 확정 − 결석 예정 + 현장. 「참석 남 · 여」 칸은 이 값이다
 *  - 결제 대기는 단체 수업이면 숫자만 온다(이름 없음, Q20). 1:1 개인 레슨은 결제 대기여도 닉네임이 온다
 *  - 출석률·출석 횟수는 없다(D7) — 명단에는 「N개월째」(수강 개월 수)만 보인다
 *
 * 이 파일의 계산 함수는 모두 입력을 바꾸지 않는 순수 함수다 — 렌더 중에 바로 불러 쓴다.
 */

// ---- 응답 모양(계약 18 §7 · admin-web instructor-headcount.ts 의 zod 스키마와 같다) ------------------

export type SeatKind = 'male' | 'female' | 'any';

export interface HeadcountSeat {
  seatKind: SeatKind;
  capacity: number;
  confirmed: number;
  absencePlanned: number;
  onsite: number;
  present: number;
  remaining: number;
}

export interface HeadcountClassItem {
  kind: 'class';
  classId: string;
  sessionId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  academy: { id: string; name: string };
  roomName: string | null;
  instructor: { displayName: string } | null;
  seatMode: 'gender_split' | 'single';
  seats: HeadcountSeat[];
  absence: Partial<Record<SeatKind, number>>;
}

export interface HeadcountLessonItem {
  kind: 'private_lesson';
  bookingId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  academy: { id: string; name: string };
  roomName: string | null;
  student: { nickname: string; gender: 'male' | 'female'; awaitingPayment: boolean };
  present: { male: number; female: number };
  absencePlanned: number;
}

export type HeadcountItem = HeadcountClassItem | HeadcountLessonItem;

export interface InstructorHeadcount {
  date: string;
  summary: {
    classCount: number;
    privateLessonCount: number;
    present: { male: number; female: number; total: number };
    absencePlanned: number;
  };
  items: HeadcountItem[];
}

/** 하루 인원표 주소. 학원을 고르지 않았으면(전체) academyId 를 뺀다 */
export function headcountPath(date: string, academyId: string | null = null): string {
  const academy = academyId === null ? '' : `&academyId=${encodeURIComponent(academyId)}`;
  return `/api/instructor/headcount?date=${date}${academy}`;
}

// ---- 회차 명단(계약 18 §4) -------------------------------------------------------------------------

export interface RosterSeat {
  seatKind: SeatKind;
  capacity: number;
  appConfirmed: number;
  absencePlanned: number;
  onsite: number;
  present: number;
  remaining: number;
  maxOnsite: number;
}

export interface RosterMember {
  memberId: string;
  nickname: string;
  gender: 'male' | 'female';
  ageBand: '20s' | '30s' | '40s' | '50s' | '60s_plus';
  phoneMasked: string;
  monthsEnrolled: number;
  absence: { markedByKind: 'member' | 'instructor' | 'owner'; markedAt: string } | null;
}

export interface SessionRoster {
  classId: string;
  sessionId: string;
  /** 이 회차의 판매 단위 — 레벨 정하기 경로(계약 14 §6-1)를 부를 때 쓴다(S6-3.6에서 계약 18 §4 에 더함) */
  offeringId: string;
  academyId: string;
  title: string;
  seatMode: 'gender_split' | 'single';
  startsAt: string;
  endsAt: string;
  roomName: string | null;
  sessionStatus: 'scheduled' | 'cancelled' | 'closed';
  seats: RosterSeat[];
  awaitingPayment: Partial<Record<SeatKind, number>>;
  members: RosterMember[];
}

export function rosterPath(classId: string, sessionId: string): string {
  return `/api/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}/roster`;
}

// ---- 화면 글자(보드 I1 · I7 · I23) ------------------------------------------------------------------

/** 자리 하나 찾기 — 그 종류가 없는 수업이면 undefined */
function seatOf<T extends { seatKind: SeatKind }>(seats: readonly T[], kind: SeatKind): T | undefined {
  return seats.find((seat) => seat.seatKind === kind);
}

/**
 * 한 줄의 「참석」 칸 — 남녀 정원이면 남·여 오늘 인원, 단일 정원이면 「n명」.
 * 개인 레슨은 수강생 성별 칸에 1(보드 I7 「남 0 · 여 1」).
 */
export function presentCounts(item: HeadcountItem): { male: number; female: number } | { any: number } {
  if (item.kind === 'private_lesson') return item.present;
  const any = seatOf(item.seats, 'any');
  if (item.seatMode === 'single' && any !== undefined) return { any: any.present };
  return { male: seatOf(item.seats, 'male')?.present ?? 0, female: seatOf(item.seats, 'female')?.present ?? 0 };
}

/**
 * 「결석」 칸 — 개인 레슨은 「확정」(결제 대기면 「결제 대기」), 결석 예정이 있으면 「결석 1 (여)」, 없으면 「없음」.
 * 남·여가 다 있으면 「결석 2 (남 1 · 여 1)」로 나눠 적는다.
 */
export function absenceLabel(item: HeadcountItem): string {
  if (item.kind === 'private_lesson') return item.student.awaitingPayment ? '결제 대기' : '확정';
  const male = item.absence.male ?? 0;
  const female = item.absence.female ?? 0;
  const any = item.absence.any ?? 0;
  const total = male + female + any;
  if (total === 0) return '없음';
  if (any > 0 || (male > 0 && female > 0)) {
    return male > 0 && female > 0 ? `결석 ${total} (남 ${male} · 여 ${female})` : `결석 ${total}`;
  }
  return `결석 ${total} (${male > 0 ? '남' : '여'})`;
}

/** 줄의 결석 예정 수(색을 바꿀지 정할 때) */
export function absenceTotal(item: HeadcountItem): number {
  if (item.kind === 'private_lesson') return item.absencePlanned;
  return (item.absence.male ?? 0) + (item.absence.female ?? 0) + (item.absence.any ?? 0);
}

/** 줄의 둘째 줄 — 개인 레슨은 「김서연 · 라틴하우스 강남 연습실」, 수업은 「라틴하우스 강남 A홀」 */
export function itemPlace(item: HeadcountItem): string {
  const place = item.roomName === null ? item.academy.name : `${item.academy.name} ${item.roomName}`;
  return item.kind === 'private_lesson' ? `${item.student.nickname} · ${place}` : place;
}

/** I7 요약줄 「수업 2 · 개인 레슨 1 · 참석 21 (남 9 · 여 12) · 결석 예정 1」 */
export function headcountSummaryLine(summary: InstructorHeadcount['summary']): string {
  const { male, female, total } = summary.present;
  const genders = male + female === total ? ` (남 ${male} · 여 ${female})` : '';
  return `수업 ${summary.classCount} · 개인 레슨 ${summary.privateLessonCount} · 참석 ${total}${genders} · 결석 예정 ${summary.absencePlanned}`;
}

/**
 * 좌석 점 막대(보드 I7 「● ● ● ● ○」) — 칠할 칸 수와 전체 칸 수. 정원이 크면 10칸으로 줄여 비율만 보인다.
 * 개인 레슨·정원 없는 칸은 null.
 */
export const GAUGE_MAX_DOTS = 10;
export function gaugeDots(present: number, capacity: number): { filled: number; total: number } | null {
  if (capacity <= 0) return null;
  const total = Math.min(capacity, GAUGE_MAX_DOTS);
  const filled = Math.min(total, Math.round((Math.min(present, capacity) / capacity) * total));
  return { filled, total };
}

/** I23 요약줄 「수업 전 인원 · 참석 17 (남 8 · 여 9) · 결석 예정 2」 */
export function rosterSummaryLine(seats: readonly RosterSeat[]): string {
  const male = seatOf(seats, 'male');
  const female = seatOf(seats, 'female');
  const total = seats.reduce((sum, seat) => sum + seat.present, 0);
  const absent = seats.reduce((sum, seat) => sum + seat.absencePlanned, 0);
  const genders = male !== undefined || female !== undefined ? ` (남 ${male?.present ?? 0} · 여 ${female?.present ?? 0})` : '';
  return `수업 전 인원 · 참석 ${total}${genders} · 결석 예정 ${absent}`;
}

/** 결제 대기 줄 — 숫자만(Q20). 없으면 null. 「결제 대기 남 1 · 여 0 · 이름은 결제가 끝나면 보여요」 */
export function awaitingLine(awaiting: SessionRoster['awaitingPayment']): string | null {
  const male = awaiting.male ?? 0;
  const female = awaiting.female ?? 0;
  const any = awaiting.any ?? 0;
  const total = male + female + any;
  if (total === 0) return null;
  const parts = any > 0 ? `${total}명` : `남 ${male} · 여 ${female}`;
  return `결제 대기 ${parts} · 이름은 결제가 끝나면 보여요`;
}

const AGE_LABEL: Record<RosterMember['ageBand'], string> = { '20s': '20대', '30s': '30대', '40s': '40대', '50s': '50대', '60s_plus': '60대 이상' };

/** 명단 한 줄의 둘째 줄 — 「여 · 20대 · 3개월째 · 결석 예정」(보드 I23. 연령대는 FR-168) */
export function memberSubLine(member: RosterMember): string {
  const parts = [member.gender === 'male' ? '남' : '여', AGE_LABEL[member.ageBand], `${member.monthsEnrolled}개월째`];
  if (member.absence !== null) parts.push('결석 예정');
  return parts.join(' · ');
}
