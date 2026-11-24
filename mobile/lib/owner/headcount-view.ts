/**
 * 대표 앱 하루 인원표 — 경로 · 홈 표(O6) 글자 · 현장 등록(O40) 계산. S3-5.9c(대표 앱 현장 등록·주문 화면).
 *
 * 부르는 경로(계약 18)
 *   GET /api/academies/{academyId}/headcount?date=                         우리 학원의 하루 인원표(§7 대표 경로)
 *   PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount       그 회차 현장 인원을 통째로 바꾼다(§6)
 *
 * 숫자 규칙(서버가 계산해 준다 — 앱은 받은 값으로 글자만 만든다)
 *  - 오늘 인원(present) = 확정 − 결석 예정 + 현장. 홈 표의 「남 · 여」 칸이 이 값이다
 *  - 남은 자리(remaining) = 정원 − 결제 중(잡힌) − 확정 − 현장. 그래서 현장을 더 넣을 수 있는 최대는 remaining + onsite 다
 *  - 현장 인원은 0 아래로 못 내리고, 앱 예약과 합쳐 정원을 넘지 못한다(FR-106 · spec 2026-11-18 입력 방식).
 *    화면에서 먼저 막지만 마지막 판정은 서버가 한다(409 ONSITE_EXCEEDS_CAPACITY)
 *
 * 다른 파일을 런타임에 불러오지 않는다 — admin-web 의 단위 테스트가 이 파일을 그대로 불러 쓴다(타입만 가져온다).
 * 모든 함수는 입력을 바꾸지 않는 순수 함수다 — 렌더 중에 바로 불러 쓴다.
 */
import type { HeadcountClassItem, HeadcountItem, InstructorHeadcount, SeatKind } from '../instructor/headcount-api';

/** 대표 경로 응답은 강사 경로와 모양이 같다(계약 §7 「두 경로의 줄 모양이 같다」) */
export type OwnerHeadcount = InstructorHeadcount;

export function ownerHeadcountPath(academyId: string, date: string | null = null): string {
  const query = date === null ? '' : `?date=${date}`;
  return `/api/academies/${encodeURIComponent(academyId)}/headcount${query}`;
}

export function onsitePath(classId: string, sessionId: string): string {
  return `/api/classes/${encodeURIComponent(classId)}/sessions/${encodeURIComponent(sessionId)}/onsite-headcount`;
}

// ---- 시각 글자(KST) — Temporal·Intl 없이 9시간을 더해 계산한다(lib/catalog/format.ts 와 같은 방식) -------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const pad = (n: number) => String(n).padStart(2, '0');

function kst(iso: string): Date {
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS);
}

/** 「19:30」 */
export function kstTime(iso: string): string {
  const d = kst(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 응답 date(「2026-11-13」) → 「11/13 (금)」. 날짜만이라 UTC 자정으로 읽어도 요일이 같다 */
export function shortDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} (${WEEKDAYS[d.getUTCDay()]})`;
}

// ---- 홈 O6 「오늘 우리 학원 수업」 표 -------------------------------------------------------------

export interface TodayRow {
  key: string;
  time: string;
  title: string;
  /** 「이준호 · A홀」 — 강사·홀 중 없는 것은 뺀다 */
  sub: string;
  /** 남·여 칸 — 성별을 모르는 단일 정원 수업은 「—」 */
  male: string;
  female: string;
  /** 결석 예정 수(회원이 알린 것 + 강사·대표가 표시한 것) */
  absence: number;
}

function joinDot(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
}

/**
 * 하루 인원표 → 홈 표 줄. 서버가 준 순서(시작 시각 순)를 그대로 쓴다.
 * 개인 레슨 줄은 1:1 이라 그 수강생 성별 칸에 1 이 들어 있다(서버 present 그대로).
 */
export function todayRows(headcount: OwnerHeadcount): TodayRow[] {
  return headcount.items.map((item) => {
    if (item.kind === 'private_lesson') {
      return {
        key: `lesson-${item.bookingId}`,
        time: kstTime(item.startsAt),
        title: item.title,
        sub: joinDot([item.student.nickname, item.roomName]),
        male: String(item.present.male),
        female: String(item.present.female),
        absence: item.absencePlanned,
      };
    }
    const seat = (kind: SeatKind) => item.seats.find((s) => s.seatKind === kind);
    const male = seat('male');
    const female = seat('female');
    const absence = item.seats.reduce((sum, s) => sum + s.absencePlanned, 0);
    return {
      key: `class-${item.sessionId}`,
      time: kstTime(item.startsAt),
      title: item.title,
      sub: joinDot([item.instructor?.displayName, item.roomName]),
      male: male === undefined ? '—' : String(male.present),
      female: female === undefined ? '—' : String(female.present),
      absence,
    };
  });
}

/** 표 아래 합계 한 줄 — 「수업 3 · 개인 레슨 0 · 참석 9 (남 7 · 여 2) · 결석 예정 5」 */
export function todaySummaryLine(headcount: OwnerHeadcount): string {
  const s = headcount.summary;
  return `수업 ${s.classCount} · 개인 레슨 ${s.privateLessonCount} · 참석 ${s.present.total} (남 ${s.present.male} · 여 ${s.present.female}) · 결석 예정 ${s.absencePlanned}`;
}

// ---- 현장 등록 O40 -----------------------------------------------------------------------------

/** 현장 인원 칸의 입력 중 글자 — 빈 글자면 흐린 「0」 안내만 보이고 값은 0 이다 */
export type OnsiteDraft = Readonly<Record<string, Partial<Record<SeatKind, string>>>>;

const SEAT_WORD: Readonly<Record<SeatKind, string>> = { male: '남', female: '여', any: '인원' };

export function seatWord(kind: SeatKind): string {
  return SEAT_WORD[kind];
}

/**
 * 현장 등록 목록에 올릴 회차 — 단체 수업 회차 중 **아직 끝나지 않은 것**만.
 * 끝난 회차는 서버가 409 SESSION_ENDED 로 막으니 처음부터 보이지 않는다(진행 중 회차는 고칠 수 있다, 계약 §6 규칙 4).
 */
export function onsiteSessions(headcount: OwnerHeadcount, now: Date): HeadcountClassItem[] {
  return headcount.items.filter(
    (item): item is HeadcountClassItem => item.kind === 'class' && new Date(item.endsAt).getTime() > now.getTime(),
  );
}

/** 칸에 들어온 글자 → 숫자. 숫자 아닌 글자는 버리고 빈 칸은 0(음수는 만들 수 없다) */
export function onsiteValue(text: string | undefined): number {
  const digits = (text ?? '').replace(/\D/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** 처음 칸 글자 — 현장 인원이 0 이면 빈 칸(흐린 「0」 안내), 있으면 그 숫자 */
export function initialOnsiteText(onsite: number): string {
  return onsite === 0 ? '' : String(onsite);
}

/** 자리 하나의 현재 입력값(입력 전이면 서버 값) */
export function draftValue(draft: OnsiteDraft, item: HeadcountClassItem, kind: SeatKind): number {
  const typed = draft[item.sessionId]?.[kind];
  if (typed !== undefined) return onsiteValue(typed);
  return item.seats.find((s) => s.seatKind === kind)?.onsite ?? 0;
}

/** 이 자리에 현장 인원을 최대 몇 명까지 둘 수 있나 = 지금 현장 + 남은 자리 */
export function maxOnsite(item: HeadcountClassItem, kind: SeatKind): number {
  const seat = item.seats.find((s) => s.seatKind === kind);
  return seat === undefined ? 0 : seat.onsite + seat.remaining;
}

/** 0 ~ 상한으로 자른다 — 「+」가 정원을 넘지 않고 「−」가 0 아래로 가지 않게 */
export function clampOnsite(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

/** 「정원 남 10 · 여 10 · 앱 예약 남 6 · 여 7」 */
export function capacityLine(item: HeadcountClassItem): string {
  const cap = item.seats.map((s) => `${seatWord(s.seatKind)} ${s.capacity}`).join(' · ');
  const app = item.seats.map((s) => `${seatWord(s.seatKind)} ${s.confirmed}`).join(' · ');
  return `정원 ${cap} · 앱 예약 ${app}`;
}

/**
 * 「남은 자리 남 4 · 여 2 (현장 남 0 · 여 1 포함)」 — 지금 칸에 넣은 값으로 바로 다시 센다.
 * 저장 전에도 넣은 만큼 남은 자리가 줄어 보여야 대표가 정원을 넘기는지 알 수 있다.
 */
export function remainingLine(item: HeadcountClassItem, draft: OnsiteDraft): string {
  const left = item.seats
    .map((s) => `${seatWord(s.seatKind)} ${Math.max(0, maxOnsite(item, s.seatKind) - draftValue(draft, item, s.seatKind))}`)
    .join(' · ');
  const onsite = item.seats.map((s) => `${seatWord(s.seatKind)} ${draftValue(draft, item, s.seatKind)}`).join(' · ');
  return `남은 자리 ${left} (현장 ${onsite} 포함)`;
}

export interface OnsiteChange {
  classId: string;
  sessionId: string;
  title: string;
  /** PUT 본문 — 그 수업의 정원 방식에 맞는 칸만(남녀면 male·female, 단일이면 any) */
  body: Partial<Record<SeatKind, number>>;
}

/**
 * 저장할 것 — 값이 바뀐 회차만 고른다. 같은 값은 보내지 않는다(서버도 같은 값이면 기록을 남기지 않지만 호출 자체를 줄인다).
 * 한 회차는 자리 종류를 다 담아 통째로 보낸다(계약 §6 「통째로 바꾼다」).
 */
export function onsiteChanges(items: readonly HeadcountClassItem[], draft: OnsiteDraft): OnsiteChange[] {
  const changes: OnsiteChange[] = [];
  for (const item of items) {
    const body: Partial<Record<SeatKind, number>> = {};
    let changed = false;
    for (const seat of item.seats) {
      const next = clampOnsite(draftValue(draft, item, seat.seatKind), maxOnsite(item, seat.seatKind));
      body[seat.seatKind] = next;
      if (next !== seat.onsite) changed = true;
    }
    if (changed) changes.push({ classId: item.classId, sessionId: item.sessionId, title: item.title, body });
  }
  return changes;
}

/** 칸 하나를 고친 새 입력 상태(원래 객체는 바꾸지 않는다) */
export function withDraft(draft: OnsiteDraft, sessionId: string, kind: SeatKind, text: string): OnsiteDraft {
  return { ...draft, [sessionId]: { ...draft[sessionId], [kind]: text } };
}

export type { HeadcountItem };
