// T-M3-1(값 상수·금액·시각 도우미) — 공유 계약 §4.6(값 형식: 시각·하루 중 시각·날짜)·§4.10(Clock) 단위 테스트
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  KST_TIME_ZONE,
  fixedClock,
  formatKstDate,
  formatTimeOfDay,
  isWithinKstTimeWindow,
  kstDateRangeToInstants,
  kstToday,
  parseKstDate,
  parseTimeOfDay,
  systemClock,
  toKstDate,
  toKstTimeOfDay,
} from "../../lib/domain/time";

const instant = (iso: string) => Temporal.Instant.from(iso);

describe("Clock — 공유 계약 §4.10", () => {
  test("fixedClock 은 늘 같은 순간을 돌려준다", () => {
    const clock = fixedClock(instant("2026-11-10T10:30:00Z"));

    expect(clock().toString()).toBe("2026-11-10T10:30:00Z");
    expect(clock().equals(clock())).toBe(true);
  });

  test("systemClock 은 Temporal.Instant 를 돌려준다", () => {
    expect(systemClock()).toBeInstanceOf(Temporal.Instant);
  });

  test("시간대는 Asia/Seoul 이다", () => {
    expect(KST_TIME_ZONE).toBe("Asia/Seoul");
  });
});

describe("KST 자정 경계", () => {
  test("UTC 14:59:59 는 KST 같은 날 23:59:59 다", () => {
    const at = instant("2026-11-09T14:59:59Z");

    expect(toKstDate(at).toString()).toBe("2026-11-09");
    expect(formatTimeOfDay(toKstTimeOfDay(at))).toBe("23:59");
  });

  test("UTC 15:00:00 는 KST 다음 날 00:00 이다", () => {
    const at = instant("2026-11-09T15:00:00Z");

    expect(toKstDate(at).toString()).toBe("2026-11-10");
    expect(formatTimeOfDay(toKstTimeOfDay(at))).toBe("00:00");
  });

  test("kstToday 는 주입한 시계 기준 KST 날짜다", () => {
    expect(kstToday(fixedClock(instant("2026-12-31T15:00:00Z"))).toString()).toBe("2027-01-01");
    expect(kstToday(fixedClock(instant("2026-12-31T14:59:59.999Z"))).toString()).toBe("2026-12-31");
  });

  test("KST 날짜 범위는 시작일 00:00 KST 부터 끝날 다음 날 00:00 KST 전까지다", () => {
    const { start, endExclusive } = kstDateRangeToInstants(parseKstDate("2026-11-10"), parseKstDate("2026-11-10"));

    expect(start.toString()).toBe("2026-11-09T15:00:00Z");
    expect(endExclusive.toString()).toBe("2026-11-10T15:00:00Z");
  });

  test("끝날이 시작일보다 앞이면 예외", () => {
    expect(() => kstDateRangeToInstants(parseKstDate("2026-11-10"), parseKstDate("2026-11-09"))).toThrow(RangeError);
  });

  test("formatKstDate 는 YYYY-MM-DD 를 낸다", () => {
    expect(formatKstDate(instant("2026-11-09T15:00:00Z"))).toBe("2026-11-10");
  });
});

describe("값 형식 파싱 — 공유 계약 §4.6", () => {
  test("HH:MM 을 읽고 다시 쓴다", () => {
    expect(formatTimeOfDay(parseTimeOfDay("18:00"))).toBe("18:00");
    expect(formatTimeOfDay(parseTimeOfDay("00:05"))).toBe("00:05");
  });

  test("HH:MM 형식이 아니면 예외", () => {
    for (const bad of ["18", "8:00", "24:00", "18:60", "18:00:00", " 18:00", ""]) {
      expect(() => parseTimeOfDay(bad), bad).toThrow(RangeError);
    }
  });

  test("YYYY-MM-DD 를 읽는다", () => {
    expect(parseKstDate("2026-02-28").toString()).toBe("2026-02-28");
  });

  test("YYYY-MM-DD 형식이 아니거나 없는 날짜면 예외", () => {
    for (const bad of ["2026-2-28", "2026-02-30", "2026-13-01", "20261110", "2026-11-10T00:00", ""]) {
      expect(() => parseKstDate(bad), bad).toThrow(RangeError);
    }
  });
});

describe("isWithinKstTimeWindow — 가능 시간대 판정", () => {
  const from = parseTimeOfDay("18:00");
  const to = parseTimeOfDay("22:00");

  test("KST 19:30~21:00 회차는 18:00~22:00 안이다", () => {
    // KST 19:30 = UTC 10:30
    expect(isWithinKstTimeWindow(instant("2026-11-10T10:30:00Z"), instant("2026-11-10T12:00:00Z"), from, to)).toBe(
      true,
    );
  });

  test("경계와 정확히 같으면 안이다", () => {
    expect(isWithinKstTimeWindow(instant("2026-11-10T09:00:00Z"), instant("2026-11-10T13:00:00Z"), from, to)).toBe(
      true,
    );
  });

  test("끝이 1분이라도 넘으면 밖이다", () => {
    expect(isWithinKstTimeWindow(instant("2026-11-10T10:30:00Z"), instant("2026-11-10T13:01:00Z"), from, to)).toBe(
      false,
    );
  });

  test("KST 자정을 넘기는 회차는 밖이다", () => {
    const lateFrom = parseTimeOfDay("20:00");
    const lateTo = parseTimeOfDay("23:59");
    // KST 23:00 ~ 다음 날 00:30
    expect(
      isWithinKstTimeWindow(instant("2026-11-10T14:00:00Z"), instant("2026-11-10T15:30:00Z"), lateFrom, lateTo),
    ).toBe(false);
  });

  test("UTC 로는 같은 날이지만 KST 로는 아침인 회차는 저녁 시간대 밖이다", () => {
    // UTC 00:00~01:00 = KST 09:00~10:00
    expect(isWithinKstTimeWindow(instant("2026-11-10T00:00:00Z"), instant("2026-11-10T01:00:00Z"), from, to)).toBe(
      false,
    );
  });

  test("끝이 시작보다 앞이면 예외", () => {
    expect(() =>
      isWithinKstTimeWindow(instant("2026-11-10T12:00:00Z"), instant("2026-11-10T10:00:00Z"), from, to),
    ).toThrow(RangeError);
  });
});
