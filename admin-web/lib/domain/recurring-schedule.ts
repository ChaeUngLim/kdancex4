// S2-2.2(반복 일정 생성) — FR-057(반복 일정 생성) · 계약 11-instructor §4-1(schedule)
// · data-model `class_offerings.schedule_rule`
//
// 강사가 「화·목 20:30–21:30, 12월 1일부터 8회」처럼 한 번만 정하면 회차 목록을 통째로 만든다.
// 끝을 정하는 방법은 둘 중 하나다 — 회차 수(`sessionCount`) 또는 끝나는 날(`periodTo`, 그날 포함).
//
// 순수 함수다 — 현재 시각·DB·환경 변수를 읽지 않는다. 「첫 회차는 미래」 같은 시계가 필요한
// 검사와 겹침 검사(FR-054)는 이 함수를 부르는 쪽(수업 등록 API)의 몫이다.
// 요일·날짜·시각은 모두 KST 달력·시계로 보고, 저장용 순간(Instant)으로 바꾸는 일은 time.ts 규칙(plan D4)을 따른다.
import { KST_TIME_ZONE, parseKstDate, parseTimeOfDay } from "./time";

/** 계약의 요일 값 — 월요일부터 */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** 한 수업이 만들 수 있는 최대 회차 수(계약 §4-1 「회차 수 1~200」, **추천값**) */
export const MAX_RECURRING_SESSIONS = 200;

/** 시각은 10분 단위만 받는다(계약 §4-1 — `20:35` 는 거부) */
const TIME_STEP_MINUTES = 10;

export interface RecurringScheduleInput {
  readonly weekdays: readonly Weekday[];
  /** KST `"HH:MM"` */
  readonly startTime: string;
  /** KST `"HH:MM"` — 시작보다 늦어야 한다(자정을 넘기는 수업은 받지 않는다) */
  readonly endTime: string;
  /** 첫날 `"YYYY-MM-DD"`(KST). 이날이 고른 요일이 아니면 그 뒤 첫 고른 요일부터 센다 */
  readonly periodFrom: string;
  /** 끝나는 날(그날 포함). `sessionCount` 와 둘 중 하나만 준다 */
  readonly periodTo?: string | null;
  /** 만들 회차 수. `periodTo` 와 둘 중 하나만 준다 */
  readonly sessionCount?: number | null;
}

export interface GeneratedSession {
  /** 1부터 시작하는 회차 번호(날짜 순) */
  readonly seq: number;
  /** KST 달력 날짜 */
  readonly date: Temporal.PlainDate;
  readonly startsAt: Temporal.Instant;
  readonly endsAt: Temporal.Instant;
}

/** `"HH:MM"` 을 읽고 10분 단위인지 확인한다 */
function parseStepTime(value: string, label: string): Temporal.PlainTime {
  const time = parseTimeOfDay(value);
  if (time.minute % TIME_STEP_MINUTES !== 0) {
    throw new RangeError(`${label}은 ${TIME_STEP_MINUTES}분 단위여야 한다: "${value}"`);
  }
  return time;
}

/** 요일 목록을 Temporal 요일 번호(월=1 … 일=7) 집합으로 바꾼다. 같은 요일이 두 번 와도 한 번으로 친다 */
function toWeekdayNumbers(weekdays: readonly Weekday[]): ReadonlySet<number> {
  if (weekdays.length === 0) {
    throw new RangeError("요일을 하나 이상 골라야 한다");
  }
  const numbers = new Set<number>();
  for (const weekday of weekdays) {
    const index = WEEKDAYS.indexOf(weekday);
    if (index < 0) {
      throw new RangeError(`모르는 요일: "${String(weekday)}"`);
    }
    numbers.add(index + 1);
  }
  return numbers;
}

/**
 * 끝 조건을 하나로 정리한다.
 * 회차 수와 끝나는 날을 둘 다 주면 둘이 어긋날 때 어느 쪽이 맞는지 알 수 없어 거부한다.
 */
function resolveStop(
  input: RecurringScheduleInput,
  from: Temporal.PlainDate,
): { kind: "count"; count: number } | { kind: "until"; until: Temporal.PlainDate } {
  const hasCount = input.sessionCount !== undefined && input.sessionCount !== null;
  const hasUntil = input.periodTo !== undefined && input.periodTo !== null;
  if (hasCount === hasUntil) {
    throw new RangeError("회차 수(sessionCount)와 끝나는 날(periodTo) 중 하나만 줘야 한다");
  }
  if (hasCount) {
    const count = input.sessionCount as number;
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_RECURRING_SESSIONS) {
      throw new RangeError(`회차 수는 1~${MAX_RECURRING_SESSIONS} 사이 정수여야 한다: ${count}`);
    }
    return { kind: "count", count };
  }
  const until = parseKstDate(input.periodTo as string);
  if (Temporal.PlainDate.compare(from, until) > 0) {
    throw new RangeError(`끝나는 날(${until.toString()})이 시작일(${from.toString()})보다 앞이다`);
  }
  return { kind: "until", until };
}

/** KST 날짜 + 하루 중 시각 → 순간 */
function kstInstant(date: Temporal.PlainDate, time: Temporal.PlainTime): Temporal.Instant {
  return date.toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: time }).toInstant();
}

/**
 * 반복 규칙으로 회차 목록을 만든다(날짜 순, seq 1부터).
 * 시작일부터 하루씩 넘기며 고른 요일이면 회차 하나를 더한다 — 회차 수가 찼거나 끝나는 날을 지나면 멈춘다.
 * 하루씩 보는 단순한 방식이라 상한(200회 · 요일 하나면 약 4년)이 있어도 반복은 짧다.
 * 입력이 틀리면 RangeError 를 던진다 — API 는 이것을 422 `VALIDATION_FAILED` 로 바꾼다.
 */
export function buildRecurringSessions(input: RecurringScheduleInput): GeneratedSession[] {
  const weekdayNumbers = toWeekdayNumbers(input.weekdays);
  const start = parseStepTime(input.startTime, "시작 시각");
  const end = parseStepTime(input.endTime, "끝 시각");
  // 같은 날 안에서 끝이 시작보다 늦어야 한다. 자정을 넘기는 수업은 「하루 중 시각」 두 개로 표현이 안 된다
  if (Temporal.PlainTime.compare(end, start) <= 0) {
    throw new RangeError(`끝 시각(${input.endTime})이 시작 시각(${input.startTime})보다 늦어야 한다`);
  }
  const from = parseKstDate(input.periodFrom);
  const stop = resolveStop(input, from);

  const sessions: GeneratedSession[] = [];
  let date = from;
  while (true) {
    if (stop.kind === "count" && sessions.length >= stop.count) {
      break;
    }
    if (stop.kind === "until" && Temporal.PlainDate.compare(date, stop.until) > 0) {
      break;
    }
    if (weekdayNumbers.has(date.dayOfWeek)) {
      // 기간으로 만들 때는 개수를 미리 모르므로 상한을 넘는 순간 멈추고 거부한다
      if (sessions.length >= MAX_RECURRING_SESSIONS) {
        throw new RangeError(`회차가 ${MAX_RECURRING_SESSIONS}개를 넘는다 — 기간을 줄여야 한다`);
      }
      sessions.push({
        seq: sessions.length + 1,
        date,
        startsAt: kstInstant(date, start),
        endsAt: kstInstant(date, end),
      });
    }
    date = date.add({ days: 1 });
  }

  // 기간 안에 고른 요일이 하루도 없으면 수업이 성립하지 않는다
  if (sessions.length === 0) {
    throw new RangeError("기간 안에 고른 요일이 없어 회차가 0개다");
  }
  return sessions;
}
