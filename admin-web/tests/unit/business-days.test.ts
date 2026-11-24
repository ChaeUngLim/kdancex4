// S0-4.8(영업일 계산 함수) 단위 테스트 — Q35(정산일이 주말·공휴일일 때) · data-model §10-13(holidays)
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  addBusinessDays,
  countBusinessDays,
  createHolidayCalendar,
  isBusinessDay,
  isWeekend,
  settlementDateForPeriod,
  type HolidayRow,
} from "../../lib/domain/business-days";

const day = (iso: string) => Temporal.PlainDate.from(iso);
const row = (iso: string, deletedAt: string | null = null): HolidayRow => ({
  date: day(iso),
  deletedAt: deletedAt ? Temporal.Instant.from(deletedAt) : null,
});

// 테스트용 공휴일 표 — 2025년 10월 추석 연휴(실제 달력).
// 10/3(금) 개천절 · 10/5(일)~7(화) 추석 · 10/8(수) 추석 대체공휴일(10/5 가 일요일) · 10/9(목) 한글날
const CHUSEOK_2025 = createHolidayCalendar([
  row("2025-10-03"),
  row("2025-10-05"),
  row("2025-10-06"),
  row("2025-10-07"),
  row("2025-10-08"),
  row("2025-10-09"),
]);

// 테스트용 공휴일 표 — 2026년 12월은 평일 공휴일이 없다(12/25 성탄절만)
const DECEMBER_2026 = createHolidayCalendar([row("2026-12-25")]);

describe("영업일 판정", () => {
  test("토요일·일요일은 영업일이 아니다", () => {
    expect(isWeekend(day("2026-12-05"))).toBe(true); // 토
    expect(isWeekend(day("2026-12-06"))).toBe(true); // 일
    expect(isWeekend(day("2026-12-07"))).toBe(false); // 월
    expect(isBusinessDay(day("2026-12-05"), DECEMBER_2026)).toBe(false);
    expect(isBusinessDay(day("2026-12-07"), DECEMBER_2026)).toBe(true);
  });

  test("표에 있는 공휴일·대체공휴일은 영업일이 아니다", () => {
    expect(isBusinessDay(day("2025-10-06"), CHUSEOK_2025)).toBe(false); // 추석
    expect(isBusinessDay(day("2025-10-08"), CHUSEOK_2025)).toBe(false); // 대체공휴일
    expect(isBusinessDay(day("2025-10-10"), CHUSEOK_2025)).toBe(true); // 연휴 뒤 금요일
  });

  test("운영자가 넣은 임시공휴일도 빠지고, 지운 줄은 다시 영업일이 된다", () => {
    const withTemporary = createHolidayCalendar([row("2026-06-03")]);
    const deleted = createHolidayCalendar([row("2026-06-03", "2026-05-30T00:00:00Z")]);

    expect(isBusinessDay(day("2026-06-03"), withTemporary)).toBe(false);
    expect(isBusinessDay(day("2026-06-03"), deleted)).toBe(true);
  });
});

describe("영업일 더하기 — addBusinessDays", () => {
  test("추석 연휴에 걸친 3영업일: 2025-10-02(목) + 3 → 2025-10-14(화)", () => {
    // 10/3 개천절 · 10/4~5 주말 · 10/6~8 추석·대체 · 10/9 한글날 → 10/10(1) · 10/13(2) · 10/14(3)
    expect(addBusinessDays(day("2025-10-02"), 3, CHUSEOK_2025).toString()).toBe("2025-10-14");
  });

  test("같은 기간을 공휴일 표 없이 세면 주말만 빠진다(표를 실제로 읽는지 확인)", () => {
    const empty = createHolidayCalendar([]);

    expect(addBusinessDays(day("2025-10-02"), 3, empty).toString()).toBe("2025-10-07");
  });

  test("0영업일은 시작일 그대로, 시작일 자체는 세지 않는다", () => {
    expect(addBusinessDays(day("2026-12-05"), 0, DECEMBER_2026).toString()).toBe("2026-12-05");
    expect(addBusinessDays(day("2026-12-07"), 1, DECEMBER_2026).toString()).toBe("2026-12-08");
  });

  test("음수·소수 영업일은 거부한다", () => {
    expect(() => addBusinessDays(day("2026-12-07"), -1, DECEMBER_2026)).toThrow(RangeError);
    expect(() => addBusinessDays(day("2026-12-07"), 1.5, DECEMBER_2026)).toThrow(RangeError);
  });
});

describe("영업일 세기 — countBusinessDays", () => {
  test("추석 연휴 구간 (10/2, 10/14] 은 3영업일", () => {
    expect(countBusinessDays(day("2025-10-02"), day("2025-10-14"), CHUSEOK_2025)).toBe(3);
  });

  test("더하기와 짝이 맞는다 — count(s, add(s, n)) = n", () => {
    for (const n of [0, 1, 2, 5, 10]) {
      const end = addBusinessDays(day("2025-10-01"), n, CHUSEOK_2025);
      expect(countBusinessDays(day("2025-10-01"), end, CHUSEOK_2025)).toBe(n);
    }
  });

  test("끝이 시작과 같거나 앞이면 0", () => {
    expect(countBusinessDays(day("2026-12-07"), day("2026-12-07"), DECEMBER_2026)).toBe(0);
    expect(countBusinessDays(day("2026-12-08"), day("2026-12-07"), DECEMBER_2026)).toBe(0);
  });

  test("금요일에 올린 건은 주말이 지나도 월요일까지는 1영업일 안이다(P10 「1영업일 넘음」)", () => {
    expect(countBusinessDays(day("2026-12-04"), day("2026-12-07"), DECEMBER_2026)).toBe(1);
    expect(countBusinessDays(day("2026-12-04"), day("2026-12-08"), DECEMBER_2026)).toBe(2);
  });
});

describe("정산일 — Q35(정산일 5일은 옮기지 않는다)", () => {
  test("정산일이 토요일이어도 그대로 5일이다: 2026-11 분 → 2026-12-05(토)", () => {
    const settleOn = settlementDateForPeriod(Temporal.PlainYearMonth.from("2026-11"));

    expect(settleOn.toString()).toBe("2026-12-05");
    expect(settleOn.dayOfWeek).toBe(6); // 토요일 — 월요일로 밀리지 않았다
  });

  test("승인 기한은 정산일 + 5영업일: 12/5(토) → 12/11(금)(13-settlement W11)", () => {
    const settleOn = settlementDateForPeriod(Temporal.PlainYearMonth.from("2026-11"));

    expect(addBusinessDays(settleOn, 5, DECEMBER_2026).toString()).toBe("2026-12-11");
  });

  test("12월 분은 해를 넘겨 다음 해 1월 5일", () => {
    expect(settlementDateForPeriod(Temporal.PlainYearMonth.from("2026-12")).toString()).toBe("2027-01-05");
  });
});
