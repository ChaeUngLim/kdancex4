/**
 * 신청한 수업 상세(보드 M8C)의 「수업 일정」 달력 계산 — 화면 없이 값만 만드는 순수 함수 모음.
 *
 * 규칙(spec FR-050(강사 수업 등록) 아래 「회원의 신청한 수업 상세 화면」 ④, 2026-11-21 사용자 요청)
 *  - 달력은 **한 번에 한 달만** 보인다. 카드 오른쪽 위 ‹ › 로 앞뒤 달을 넘긴다
 *  - 처음 보이는 달 = **다음 수업이 있는 달**. 수업이 전부 끝났으면 마지막 수업이 있는 달
 *  - 넘길 수 있는 범위 = 첫 수업의 달 ~ 마지막 수업의 달. 그 밖으로는 ‹ › 가 막힌다
 *  - 수업 있는 날은 아이보리 동그라미, 아래에 「총 N회 (첫날 ~ 끝날)」
 *
 * 날짜는 모두 한국 시간(KST) 달력 날짜로 센다 — 서버는 시각을 UTC 로 주므로(README §3(값 형식))
 * 밤 11시 넘어 끝나는 수업이 다른 날로 찍히지 않게 `toKstParts` 로 바꿔 읽는다.
 * 이 파일의 함수는 입력을 바꾸지 않고 새 값만 돌려준다.
 */
import { parseInstant, toKstParts } from '../catalog/format';
import type { SessionTime } from '../catalog/types';

/** 달력이 가리키는 달. month 는 1~12. */
export interface MonthCursor {
  year: number;
  month: number;
}

/** 수업 회차 하나를 KST 달력 날짜로 바꾼 값. */
interface SessionDay {
  year: number;
  month: number;
  day: number;
  startsAt: Date;
  endsAt: Date;
}

/** 보드 M8C 는 월요일부터 시작한다(월 화 수 목 금 토 일). */
export const WEEK_LABELS_MON_FIRST = ['월', '화', '수', '목', '금', '토', '일'] as const;

/** 달을 하나의 정수로 — 앞뒤 비교와 더하기를 쉽게 하려는 것이다. */
function monthIndex({ year, month }: MonthCursor): number {
  return year * 12 + (month - 1);
}

function fromMonthIndex(index: number): MonthCursor {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** 회차를 KST 날짜로 바꾸고 시작 순서로 정렬한다. 시각을 못 읽는 회차는 뺀다(서버 값이 비어도 화면이 깨지지 않게). */
function toSessionDays(sessions: readonly SessionTime[]): readonly SessionDay[] {
  return sessions
    .map((session) => ({ startsAt: parseInstant(session.startsAt), endsAt: parseInstant(session.endsAt) }))
    .filter((pair): pair is { startsAt: Date; endsAt: Date } => pair.startsAt !== null && pair.endsAt !== null)
    .map(({ startsAt, endsAt }) => {
      const parts = toKstParts(startsAt);
      return { year: parts.year, month: parts.month, day: parts.day, startsAt, endsAt };
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** 달력 전체가 쓰는 값 — 화면은 렌더할 때 이 값을 한 번 계산해 쓴다. */
export interface ClassCalendarPlan {
  /** 회차 수(시각을 읽을 수 있는 것만) */
  totalCount: number;
  /** 첫 수업 달 ~ 마지막 수업 달. 회차가 없으면 null */
  firstMonth: MonthCursor | null;
  lastMonth: MonthCursor | null;
  /** 처음 보일 달 — 다음 수업이 있는 달(다 끝났으면 마지막 달) */
  initialMonth: MonthCursor | null;
  /** 「10월 5일 ~ 11월 25일」 — 첫 회차 날 ~ 마지막 회차 날 */
  periodText: string;
  /** 다음 수업(아직 끝나지 않은 첫 회차). 다 끝났으면 null */
  nextSession: { seq: number; startsAt: Date; endsAt: Date } | null;
  /** 날짜 열쇠(YYYY-MM-DD)별 회차 수 */
  countByDate: Readonly<Record<string, number>>;
  /** 수업이 있는 요일(월=0 … 일=6) — 달력 머리의 요일 글자를 굵게 한다(보드 M8C 「월·수」) */
  classWeekdaysMonFirst: readonly number[];
}

const dateKey = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * 수업 회차 목록과 지금 시각으로 달력 계획을 만든다.
 * 「다음 수업」은 시작이 아니라 **끝**을 기준으로 고른다 — 지금 진행 중인 수업도 「다음(지금) 수업」으로 보인다.
 */
export function planClassCalendar(sessions: readonly SessionTime[], now: Date): ClassCalendarPlan {
  const days = toSessionDays(sessions);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    return {
      totalCount: 0,
      firstMonth: null,
      lastMonth: null,
      initialMonth: null,
      periodText: '',
      nextSession: null,
      countByDate: {},
      classWeekdaysMonFirst: [],
    };
  }
  // 회차 seq 는 서버 값을 쓴다. 정렬 뒤 위치로 다시 세지 않는다(휴강 등으로 번호가 비어도 서버와 맞게)
  const seqByStart = new Map(sessions.map((s) => [parseInstant(s.startsAt)?.getTime(), s.seq]));
  const upcoming = days.find((d) => d.endsAt.getTime() > now.getTime());
  const anchor = upcoming ?? last;
  const countByDate = days.reduce<Record<string, number>>((acc, d) => {
    const key = dateKey(d.year, d.month, d.day);
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
  return {
    totalCount: days.length,
    firstMonth: { year: first.year, month: first.month },
    lastMonth: { year: last.year, month: last.month },
    initialMonth: { year: anchor.year, month: anchor.month },
    periodText: `${first.month}월 ${first.day}일 ~ ${last.month}월 ${last.day}일`,
    nextSession:
      upcoming === undefined
        ? null
        : { seq: seqByStart.get(upcoming.startsAt.getTime()) ?? 0, startsAt: upcoming.startsAt, endsAt: upcoming.endsAt },
    countByDate,
    // 요일은 KST 달력 날짜로 센다(일=0 을 월=0 기준으로 돌린다)
    classWeekdaysMonFirst: [...new Set(days.map((d) => (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7))],
  };
}

/** 지금 달에서 앞(‹)·뒤(›)로 갈 수 있나 — 수업 기간 밖으로는 못 넘긴다. */
export function navState(plan: ClassCalendarPlan, cursor: MonthCursor): { canPrev: boolean; canNext: boolean } {
  if (plan.firstMonth === null || plan.lastMonth === null) {
    return { canPrev: false, canNext: false };
  }
  return {
    canPrev: monthIndex(cursor) > monthIndex(plan.firstMonth),
    canNext: monthIndex(cursor) < monthIndex(plan.lastMonth),
  };
}

/**
 * ‹ › 를 눌렀을 때 옮겨 갈 달. 수업 기간 밖이면 끝 달에 멈춘다(버튼이 막혀 있어도 한 번 더 막는다 —
 * 웹에서 빠르게 두 번 눌러도 범위를 넘지 않게).
 */
export function shiftWithinPlan(plan: ClassCalendarPlan, cursor: MonthCursor, delta: number): MonthCursor {
  if (plan.firstMonth === null || plan.lastMonth === null) {
    return cursor;
  }
  const target = monthIndex(cursor) + delta;
  const clamped = Math.min(Math.max(target, monthIndex(plan.firstMonth)), monthIndex(plan.lastMonth));
  return fromMonthIndex(clamped);
}

/** 달력 칸 — 월요일 시작. 앞쪽 빈칸(null) + 1일~말일. 요일은 달력 날짜 자체로 계산해 시간대가 끼지 않는다. */
export function monthCellsMonFirst(cursor: MonthCursor): readonly (number | null)[] {
  const sundayFirst = new Date(Date.UTC(cursor.year, cursor.month - 1, 1)).getUTCDay(); // 0=일
  const leading = (sundayFirst + 6) % 7; // 월=0 … 일=6
  const lastDay = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
  return [...Array.from({ length: leading }, () => null), ...Array.from({ length: lastDay }, (_, i) => i + 1)];
}

/** 그 달 그 날의 회차 수(없으면 0). */
export function sessionCountOn(plan: ClassCalendarPlan, cursor: MonthCursor, day: number): number {
  return plan.countByDate[dateKey(cursor.year, cursor.month, day)] ?? 0;
}

/**
 * 달력 아래 안내 한 줄(보드 M8C: 「수업일은 총 16회예요 (10월 5일 ~ 11월 25일). › 로 11월을 봐요.」).
 * 뒤에 달이 남았으면 › 안내, 마지막 달이면 ‹ 안내, 한 달짜리 수업이면 넘길 안내를 붙이지 않는다.
 */
export function calendarFootnote(plan: ClassCalendarPlan, cursor: MonthCursor): string {
  const base = `수업일은 총 ${plan.totalCount}회예요 (${plan.periodText}).`;
  const { canPrev, canNext } = navState(plan, cursor);
  if (canNext) {
    return `${base} › 로 ${fromMonthIndex(monthIndex(cursor) + 1).month}월을 봐요.`;
  }
  if (canPrev) {
    return `${base} ‹ 로 ${fromMonthIndex(monthIndex(cursor) - 1).month}월을 봐요.`;
  }
  return base;
}
