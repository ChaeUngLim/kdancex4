// S0-4.8(영업일 계산 함수) — Q35(정산일이 주말·공휴일일 때) · data-model §10-13(holidays)
//
// 규칙(2026-11-19 사용자 확정, Q35):
//   - 영업일 = 토요일·일요일·공휴일(대체공휴일·임시공휴일 포함)을 뺀 날.
//   - 공휴일은 `holidays` 표 하나만 원천이다. 이 파일은 그 표에서 읽은 줄을 인자로 받아 계산만 한다.
//     외부 API(특일 정보)는 부르지 않는다 — 그건 하루 한 번 표를 채우는 S0-4.10 의 일이다.
//   - 정산일(매월 5일)은 주말·공휴일이어도 옮기지 않는다. 그 뒤의 기한(승인 5영업일 등)만 영업일로 센다.
//
// 모든 함수는 순수 함수다 — 같은 입력이면 늘 같은 값을 낸다. 현재 시각·DB·환경 변수를 읽지 않는다.
// 날짜는 시간대 없는 달력 날짜(`Temporal.PlainDate`, KST 달력 기준)로만 다룬다.
import "./time";

/** `holidays` 표에서 읽은 한 줄 중 계산에 필요한 칸만 */
export interface HolidayRow {
  readonly date: Temporal.PlainDate;
  /** 운영자가 지운 줄은 값이 있다. 지운 줄은 공휴일로 치지 않는다 */
  readonly deletedAt?: Temporal.Instant | null;
}

/** 공휴일 달력 — 「이 날이 공휴일인가」만 빠르게 답한다. `createHolidayCalendar` 로 만든다 */
export interface HolidayCalendar {
  isHoliday(date: Temporal.PlainDate): boolean;
}

/** Temporal 의 요일 번호: 월=1 … 토=6, 일=7 */
const SATURDAY = 6;
const SUNDAY = 7;

/**
 * 표의 줄 목록으로 공휴일 달력을 만든다.
 * 날짜를 `"YYYY-MM-DD"` 글자로 바꿔 Set 에 넣는다 — PlainDate 객체는 Set 에서 값으로 비교되지 않기 때문이다.
 * 같은 날짜가 자동 수집 줄과 운영자 줄 둘 다 있어도 결과는 같다(그날은 공휴일).
 */
export function createHolidayCalendar(rows: Iterable<HolidayRow>): HolidayCalendar {
  const dates = new Set<string>();
  for (const row of rows) {
    // 지운 운영자 줄은 건너뛴다 — 지운 뒤의 계산부터 영업일로 돌아온다
    if (row.deletedAt) {
      continue;
    }
    dates.add(row.date.toString());
  }
  return {
    isHoliday: (date) => dates.has(date.toString()),
  };
}

/** 토요일이나 일요일인가 */
export function isWeekend(date: Temporal.PlainDate): boolean {
  return date.dayOfWeek === SATURDAY || date.dayOfWeek === SUNDAY;
}

/** 영업일인가 — 주말도 공휴일도 아니면 영업일이다 */
export function isBusinessDay(date: Temporal.PlainDate, calendar: HolidayCalendar): boolean {
  return !isWeekend(date) && !calendar.isHoliday(date);
}

function assertNonNegativeInteger(days: number): void {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new RangeError(`영업일 수는 0 이상의 정수여야 한다: ${days}`);
  }
}

/**
 * 시작일 다음 날부터 영업일을 `days` 개 세어, 마지막으로 센 날을 돌려준다.
 * 예: 12/5(토) + 5영업일 → 12/7(월)이 1, …, 12/11(금)이 5 → 12/11.
 * 시작일 자체는 세지 않는다(「접수 + 3영업일」의 접수일은 0일째). `days = 0` 이면 시작일 그대로.
 * 공휴일 표는 유한하므로 반복은 반드시 끝난다.
 */
export function addBusinessDays(
  start: Temporal.PlainDate,
  days: number,
  calendar: HolidayCalendar,
): Temporal.PlainDate {
  assertNonNegativeInteger(days);
  let current = start;
  let counted = 0;
  while (counted < days) {
    current = current.add({ days: 1 });
    if (isBusinessDay(current, calendar)) {
      counted += 1;
    }
  }
  return current;
}

/**
 * (from, to] 구간의 영업일 수 — from 은 빼고 to 는 넣는다.
 * `addBusinessDays` 와 짝이라 `countBusinessDays(s, addBusinessDays(s, n)) === n` 이 늘 맞다.
 * 「올린 뒤 1영업일을 넘겼나」(P10)는 `countBusinessDays(올린 날, 오늘) > 1` 처럼 쓴다.
 * to 가 from 과 같거나 앞이면 0 이다(아직 하루도 안 지났다).
 */
export function countBusinessDays(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
  calendar: HolidayCalendar,
): number {
  let count = 0;
  let current = from;
  while (Temporal.PlainDate.compare(current, to) < 0) {
    current = current.add({ days: 1 });
    if (isBusinessDay(current, calendar)) {
      count += 1;
    }
  }
  return count;
}

/** 정산일 — 정산 대상 달의 다음 달 며칠인가(spec 전제 5, 매월 5일) */
export const SETTLEMENT_DAY_OF_MONTH = 5;

/**
 * 정산 대상 달(`"2026-11"`)의 정산일 = 다음 달 5일.
 * Q35: 토요일·일요일·공휴일이어도 **옮기지 않는다** — 그래서 공휴일 달력을 받지 않는다.
 * 승인 기한은 이 날짜에 `addBusinessDays(…, 5, …)` 를 해서 따로 구한다.
 */
export function settlementDateForPeriod(periodMonth: Temporal.PlainYearMonth): Temporal.PlainDate {
  return periodMonth.add({ months: 1 }).toPlainDate({ day: SETTLEMENT_DAY_OF_MONTH });
}
