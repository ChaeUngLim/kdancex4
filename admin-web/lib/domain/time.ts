// 공유 계약 §4.6(값 형식: 시각·하루 중 시각·날짜) · §4.10(Clock)
//
// 규칙(plan D4): 저장·비교는 순간(`Temporal.Instant`)으로만 한다. 시간대가 끼는 곳은
// 「하루 중 시각」(가능 시간대 필터)과 「날짜」(날짜 필터·캘린더) 판정뿐이고, 그때만
// `ZonedDateTime('Asia/Seoul')` 로 바꾼다. 현재 시각은 반드시 `Clock` 으로 주입받는다.
//
// Node 24 에는 `Temporal` 전역이 없다. 아래 import 가 폴리필을 전역에 설치한다
// (네이티브가 있으면 그것을 쓴다). 이 모듈을 먼저 import 한 곳은 전역 `Temporal` 을 쓸 수 있다.
import "temporal-polyfill/full/global";

/** 하루 중 시각·날짜 판정에 쓰는 시간대 */
export const KST_TIME_ZONE = "Asia/Seoul";

/** 공유 계약 §4.10 — 현재 순간을 돌려주는 시계. 서비스는 이것을 인자로 받는다 */
export type Clock = () => Temporal.Instant;

/** 실제 시계 — 구상 주입은 `lib/server/deps.ts` 한 곳에서만 한다 */
export const systemClock: Clock = () => Temporal.Now.instant();

/** 테스트용 멈춘 시계 */
export function fixedClock(at: Temporal.Instant): Clock {
  return () => at;
}

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toKst(at: Temporal.Instant): Temporal.ZonedDateTime {
  return at.toZonedDateTimeISO(KST_TIME_ZONE);
}

/** 순간 → KST 달력 날짜 */
export function toKstDate(at: Temporal.Instant): Temporal.PlainDate {
  return toKst(at).toPlainDate();
}

/** 순간 → KST 하루 중 시각 */
export function toKstTimeOfDay(at: Temporal.Instant): Temporal.PlainTime {
  return toKst(at).toPlainTime();
}

/** 주입한 시계 기준 오늘(KST) */
export function kstToday(clock: Clock): Temporal.PlainDate {
  return toKstDate(clock());
}

/** 순간 → `"YYYY-MM-DD"`(KST 달력) */
export function formatKstDate(at: Temporal.Instant): string {
  return toKstDate(at).toString();
}

/** `"HH:MM"`(24시간) → PlainTime. 형식이 다르면 RangeError */
export function parseTimeOfDay(value: string): Temporal.PlainTime {
  const match = TIME_OF_DAY_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`하루 중 시각은 HH:MM 형식이어야 한다: "${value}"`);
  }
  return Temporal.PlainTime.from({ hour: Number(match[1]), minute: Number(match[2]) });
}

/** PlainTime → `"HH:MM"`. 초 이하는 버린다 */
export function formatTimeOfDay(time: Temporal.PlainTime): string {
  return time.toString({ smallestUnit: "minute" });
}

/** `"YYYY-MM-DD"` → PlainDate. 형식이 다르거나 없는 날짜(2월 30일 등)면 RangeError */
export function parseKstDate(value: string): Temporal.PlainDate {
  if (!DATE_PATTERN.test(value)) {
    throw new RangeError(`날짜는 YYYY-MM-DD 형식이어야 한다: "${value}"`);
  }
  // overflow: 'reject' — 없는 날짜를 가까운 날로 맞추지 않고 거부한다
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

/**
 * KST 날짜 범위 [from, to](양 끝 포함)를 순간 구간 [start, endExclusive) 로 바꾼다.
 * DB 조회는 `starts_at >= start AND starts_at < endExclusive` 로 쓴다.
 */
export function kstDateRangeToInstants(
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): { start: Temporal.Instant; endExclusive: Temporal.Instant } {
  if (Temporal.PlainDate.compare(from, to) > 0) {
    throw new RangeError(`끝날(${to.toString()})이 시작일(${from.toString()})보다 앞이다`);
  }
  return {
    start: from.toZonedDateTime(KST_TIME_ZONE).toInstant(),
    endExclusive: to.add({ days: 1 }).toZonedDateTime(KST_TIME_ZONE).toInstant(),
  };
}

/**
 * 회차 [startsAt, endsAt] 가 KST 하루 중 시각 [from, to](양 끝 포함) 안에 들어가는가.
 * 가능 시간대 필터(02-catalog.md §1)에서 회차마다 부른다. KST 자정을 넘기는 회차는
 * 하루 안의 구간으로 표현할 수 없으므로 밖으로 본다.
 */
export function isWithinKstTimeWindow(
  startsAt: Temporal.Instant,
  endsAt: Temporal.Instant,
  from: Temporal.PlainTime,
  to: Temporal.PlainTime,
): boolean {
  if (Temporal.Instant.compare(startsAt, endsAt) > 0) {
    throw new RangeError("회차 끝이 시작보다 앞이다");
  }
  const start = toKst(startsAt);
  const end = toKst(endsAt);
  if (!start.toPlainDate().equals(end.toPlainDate())) {
    return false;
  }
  return (
    Temporal.PlainTime.compare(start.toPlainTime(), from) >= 0 &&
    Temporal.PlainTime.compare(end.toPlainTime(), to) <= 0
  );
}
