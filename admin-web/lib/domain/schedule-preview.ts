// S2-2.8c(수업 일정 겹침 미리보기 API) — 미리보기 응답의 `existing`(이미 있는 일정)과 `suggestions`(가까운 빈 시간 칩)을
// 만드는 순수 함수들(DB·시계를 모른다). 계약: _workspace/03_contracts/11-instructor.md §4-1 · 요구: FR-054 ①②(겹침 세 번 막기)
//
// 한눈에:
//   expandPersonalEvent — 반복 개인 일정(매주·매일, 한 행)을 기간 안의 실제 시간들로 펼친다
//   summarizeExisting   — 기간 안의 일정들을 「고른 요일 · 시작–끝 · 이름」 한 줄씩으로 줄인다(매주 같은 수업은 한 줄)
//   suggestFreeSlots    — 겹친 요일마다 같은 길이로 30분씩 앞뒤로 옮겨 보며 「다 비는」 가까운 시간 최대 3개를 고른다
//
// 칩 규칙은 **추천안**이다 — 계약은 「가까운 빈 시간 2~3개」만 정했고 고르는 법은 정하지 않았다(S2-2.4 증거에도 「schedule-check 와
// 함께 정한다」로 남겨 둠). 그래서 값들을 이름 있는 상수로 모아 두었다. 겹침이 없으면 칩을 내지 않는다.
import { WEEKDAYS, type Weekday } from "./recurring-schedule";
import { formatTimeOfDay, toKstDate, toKstTimeOfDay } from "./time";
import type { TimeRange } from "./instructor-schedule-overlap";

/** 칩 간격(분, 추천값) — 10분 단위로 옮기면 칩이 「20:30 · 20:40 · 20:50」처럼 붙어 나와 고를 이유가 없다 */
export const SUGGESTION_STEP_MINUTES = 30;
/** 앞뒤로 옮겨 볼 최대 폭(분, 추천값) — 3시간 넘게 옮긴 시간은 「가까운」 시간이 아니다 */
export const SUGGESTION_MAX_SHIFT_MINUTES = 180;
/** 칩 개수 상한(계약 「2~3개」) */
export const MAX_SUGGESTIONS = 3;
/** 칩이 들어갈 하루 범위(KST, 추천값) — 이른 새벽 칩은 내지 않는다. 끝은 「HH:MM」 이 10분 단위로 가질 수 있는 마지막 값 */
const DAY_FIRST_MINUTE = 6 * 60;
const DAY_LAST_MINUTE = 23 * 60 + 50;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** 개인 일정 반복 값(data-model instructor_personal_events.repeat_rule) */
export type PersonalEventRepeat = "none" | "weekly" | "daily";

export interface PersonalEvent extends TimeRange {
  readonly title: string;
  readonly repeat: PersonalEventRepeat;
  /** 반복이 끝나는 날(KST, 그날 시작분까지 포함). null 이면 지울 때까지 반복 */
  readonly repeatUntil: Temporal.PlainDate | null;
}

/** 이름 붙은 시간 구간 — existing 의 재료 */
export interface LabeledRange extends TimeRange {
  readonly label: string;
}

export interface ExistingSlot {
  readonly weekday: Weekday;
  readonly startTime: string;
  readonly endTime: string;
  readonly label: string;
}

export interface SuggestedSlot {
  readonly weekday: Weekday;
  readonly startTime: string;
  readonly endTime: string;
}

/** 순간 → 계약의 요일 값(KST 달력 기준). Temporal 의 dayOfWeek 는 월요일이 1 이다 */
export function weekdayOf(at: Temporal.Instant): Weekday {
  const weekday = WEEKDAYS[toKstDate(at).dayOfWeek - 1];
  if (weekday === undefined) throw new RangeError(`요일을 알 수 없다: ${at.toString()}`);
  return weekday;
}

const overlaps = (a: TimeRange, b: TimeRange): boolean =>
  Temporal.Instant.compare(a.startsAt, b.endsAt) < 0 && Temporal.Instant.compare(b.startsAt, a.endsAt) < 0;

/**
 * 개인 일정 한 행을 기간 [window.startsAt, window.endsAt) 에 걸친 실제 시간들로 펼친다.
 * 한국은 서머타임이 없어 하루·한 주를 고정 길이로 더해도 KST 시각이 밀리지 않는다.
 * 오래전에 시작한 반복 일정도 처음부터 하나씩 세지 않고 기간 바로 앞까지 한 번에 건너뛴다.
 */
export function expandPersonalEvent(event: PersonalEvent, window: TimeRange): TimeRange[] {
  if (event.repeat === "none") return overlaps(event, window) ? [{ startsAt: event.startsAt, endsAt: event.endsAt }] : [];

  const stepMs = (event.repeat === "weekly" ? 7 : 1) * MS_PER_DAY;
  const lengthMs = event.endsAt.epochMilliseconds - event.startsAt.epochMilliseconds;
  // 기간 시작 전에 끝나는 회차는 건너뛴다 — 몇 번 건너뛸지 나눗셈으로 바로 구한다
  const behindMs = window.startsAt.epochMilliseconds - event.endsAt.epochMilliseconds;
  let index = behindMs > 0 ? Math.floor(behindMs / stepMs) : 0;

  const result: TimeRange[] = [];
  for (;;) {
    const startsAt = Temporal.Instant.fromEpochMilliseconds(event.startsAt.epochMilliseconds + index * stepMs);
    if (Temporal.Instant.compare(startsAt, window.endsAt) >= 0) break;
    if (event.repeatUntil !== null && Temporal.PlainDate.compare(toKstDate(startsAt), event.repeatUntil) > 0) break;
    const occurrence = { startsAt, endsAt: Temporal.Instant.fromEpochMilliseconds(startsAt.epochMilliseconds + lengthMs) };
    if (overlaps(occurrence, window)) result.push(occurrence);
    index += 1;
  }
  return result;
}

const kstClock = (at: Temporal.Instant): string => formatTimeOfDay(toKstTimeOfDay(at));

/**
 * 일정들 → 「고른 요일에 이미 있는 일정」 목록(계약 §4-1 existing).
 * 매주 반복되는 수업은 같은 요일·시각·이름이라 한 줄로 합친다. 요일(월→일) · 시작 시각 · 이름 순.
 */
export function summarizeExisting(items: readonly LabeledRange[], weekdays: readonly Weekday[]): ExistingSlot[] {
  const picked = new Set<Weekday>(weekdays);
  const byKey = new Map<string, ExistingSlot>();
  for (const item of items) {
    const weekday = weekdayOf(item.startsAt);
    if (!picked.has(weekday)) continue;
    const slot = { weekday, startTime: kstClock(item.startsAt), endTime: kstClock(item.endsAt), label: item.label };
    byKey.set(`${slot.weekday}|${slot.startTime}|${slot.endTime}|${slot.label}`, slot);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) ||
      a.startTime.localeCompare(b.startTime) ||
      a.label.localeCompare(b.label),
  );
}

/** 옮겨 볼 폭 — 가까운 순, 같은 거리면 이른 쪽 먼저(−30, +30, −60, +60 …) */
function shiftOrder(): number[] {
  const shifts: number[] = [];
  for (let d = SUGGESTION_STEP_MINUTES; d <= SUGGESTION_MAX_SHIFT_MINUTES; d += SUGGESTION_STEP_MINUTES) shifts.push(-d, d);
  return shifts;
}

/**
 * 가까운 빈 시간 칩(계약 §4-1 suggestions, FR-054 ②).
 *   ① 겹친 회차(conflicted)가 있는 요일만 본다. 겹침이 없으면 빈 배열
 *   ② 그 요일의 회차를 모두 같은 폭만큼 옮겨 보고, 옮긴 회차 **전부**가 busy(그 강사의 수업 · 그 홀의 수업 · 개인 일정) 어느 것과도
 *      겹치지 않으면 후보다. 개인 일정은 저장을 막지는 않지만(열린 점 ②) 「빈 시간」으로 권하지는 않는다
 *   ③ 하루 범위(06:00~23:50) 안에서만, 가까운 순으로 최대 3개
 */
export function suggestFreeSlots(input: {
  sessions: readonly TimeRange[];
  conflicted: readonly TimeRange[];
  busy: readonly TimeRange[];
}): SuggestedSlot[] {
  const conflictedDays = new Set(input.conflicted.map((s) => weekdayOf(s.startsAt)));
  const candidates: { weekday: Weekday; shift: number; slot: SuggestedSlot }[] = [];

  for (const weekday of WEEKDAYS.filter((w) => conflictedDays.has(w))) {
    const daySessions = input.sessions.filter((s) => weekdayOf(s.startsAt) === weekday);
    const first = daySessions[0];
    if (first === undefined) continue;
    // 한 요일의 회차는 모두 같은 KST 시각이다(같은 규칙에서 나왔다) — 첫 회차로 하루 범위를 본다
    const startClock = toKstTimeOfDay(first.startsAt);
    const startMinute = startClock.hour * 60 + startClock.minute;
    const lengthMinutes = (first.endsAt.epochMilliseconds - first.startsAt.epochMilliseconds) / MS_PER_MINUTE;

    for (const shift of shiftOrder()) {
      const from = startMinute + shift;
      if (from < DAY_FIRST_MINUTE || from + lengthMinutes > DAY_LAST_MINUTE) continue;
      const moved = daySessions.map((s) => ({
        startsAt: Temporal.Instant.fromEpochMilliseconds(s.startsAt.epochMilliseconds + shift * MS_PER_MINUTE),
        endsAt: Temporal.Instant.fromEpochMilliseconds(s.endsAt.epochMilliseconds + shift * MS_PER_MINUTE),
      }));
      const free = moved.every((m) => input.busy.every((b) => !overlaps(m, b)));
      if (!free) continue;
      const head = moved[0];
      if (head === undefined) continue;
      candidates.push({ weekday, shift, slot: { weekday, startTime: kstClock(head.startsAt), endTime: kstClock(head.endsAt) } });
    }
  }

  return candidates
    .sort(
      (a, b) =>
        Math.abs(a.shift) - Math.abs(b.shift) || a.shift - b.shift || WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((c) => c.slot);
}
