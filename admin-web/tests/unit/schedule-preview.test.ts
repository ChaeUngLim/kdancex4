// S2-2.8c(수업 일정 겹침 미리보기 API) — 미리보기의 순수 함수(개인 일정 펼치기 · existing 줄이기 · 빈 시간 칩)를 DB 없이 본다.
import { describe, expect, test } from "vitest";

import { expandPersonalEvent, suggestFreeSlots, summarizeExisting, weekdayOf } from "@/lib/domain/schedule-preview";

const at = (iso: string) => Temporal.Instant.from(iso);
/** KST 시각 글자 → 순간. 「2026-11-09 19:30」 */
const kst = (text: string) => Temporal.PlainDateTime.from(text.replace(" ", "T")).toZonedDateTime("Asia/Seoul").toInstant();
const range = (from: string, to: string) => ({ startsAt: kst(from), endsAt: kst(to) });

describe("expandPersonalEvent — 반복 개인 일정 펼치기", () => {
  const window = range("2026-11-09 00:00", "2026-11-23 00:00"); // 11/09(월) ~ 11/22(일)

  test("한 번뿐인 일정은 기간에 걸칠 때만 나온다", () => {
    const inside = { ...range("2026-11-10 10:00", "2026-11-10 11:00"), title: "a", repeat: "none" as const, repeatUntil: null };
    const outside = { ...range("2026-11-02 10:00", "2026-11-02 11:00"), title: "b", repeat: "none" as const, repeatUntil: null };
    expect(expandPersonalEvent(inside, window)).toHaveLength(1);
    expect(expandPersonalEvent(outside, window)).toEqual([]);
  });

  test("매주 — 기간 앞에서 시작한 일정도 기간 안의 날짜로 펼친다", () => {
    const event = { ...range("2026-01-05 10:00", "2026-01-05 11:00"), title: "a", repeat: "weekly" as const, repeatUntil: null };
    const result = expandPersonalEvent(event, window);
    expect(result.map((r) => r.startsAt)).toEqual([kst("2026-11-09 10:00"), kst("2026-11-16 10:00")]);
    expect(result[0]?.endsAt).toEqual(kst("2026-11-09 11:00"));
  });

  test("매일 · 반복 끝나는 날(그날 포함)까지만", () => {
    const event = {
      ...range("2026-11-08 22:00", "2026-11-08 23:00"),
      title: "a",
      repeat: "daily" as const,
      repeatUntil: Temporal.PlainDate.from("2026-11-11"),
    };
    expect(expandPersonalEvent(event, window).map((r) => r.startsAt)).toEqual([
      kst("2026-11-09 22:00"),
      kst("2026-11-10 22:00"),
      kst("2026-11-11 22:00"),
    ]);
  });
});

describe("summarizeExisting — 고른 요일의 일정 한 줄씩", () => {
  test("매주 같은 수업은 한 줄 · 고르지 않은 요일은 빠진다 · 요일→시각 순", () => {
    const items = [
      { ...range("2026-11-11 18:00", "2026-11-11 19:00"), label: "왈츠" }, // 수
      { ...range("2026-11-09 19:30", "2026-11-09 20:30"), label: "룸바" }, // 월
      { ...range("2026-11-16 19:30", "2026-11-16 20:30"), label: "룸바" }, // 다음 월(같은 줄)
      { ...range("2026-11-10 19:30", "2026-11-10 20:30"), label: "차차" }, // 화(안 고름)
    ];
    expect(summarizeExisting(items, ["mon", "wed"])).toEqual([
      { weekday: "mon", startTime: "19:30", endTime: "20:30", label: "룸바" },
      { weekday: "wed", startTime: "18:00", endTime: "19:00", label: "왈츠" },
    ]);
  });

  test("요일은 KST 달력으로 본다 — UTC 로는 일요일 15:00 이 KST 월요일 00:00", () => {
    expect(weekdayOf(at("2026-11-08T15:00:00Z"))).toBe("mon");
  });
});

describe("suggestFreeSlots — 가까운 빈 시간 칩(추천안)", () => {
  const mondays = [range("2026-11-09 20:00", "2026-11-09 21:00"), range("2026-11-16 20:00", "2026-11-16 21:00")];
  const rumba = [range("2026-11-09 19:30", "2026-11-09 20:30"), range("2026-11-16 19:30", "2026-11-16 20:30")];

  test("겹침이 없으면 칩을 내지 않는다", () => {
    expect(suggestFreeSlots({ sessions: mondays, conflicted: [], busy: rumba })).toEqual([]);
  });

  test("30분씩 가까운 순(같은 거리면 이른 쪽) · 겹치는 후보는 빠진다 · 최대 3개", () => {
    expect(suggestFreeSlots({ sessions: mondays, conflicted: mondays, busy: rumba })).toEqual([
      { weekday: "mon", startTime: "20:30", endTime: "21:30" },
      { weekday: "mon", startTime: "21:00", endTime: "22:00" },
      { weekday: "mon", startTime: "18:30", endTime: "19:30" },
    ]);
  });

  test("한 주라도 겹치면 그 시간은 후보가 아니다", () => {
    // 11/16 에만 20:30–21:30 일정이 더 있다 — 20:30 칩은 빠진다
    const busy = [...rumba, range("2026-11-16 20:30", "2026-11-16 21:30")];
    const result = suggestFreeSlots({ sessions: mondays, conflicted: mondays, busy });
    expect(result.map((s) => s.startTime)).toEqual(["18:30", "21:30", "18:00"]);
  });

  test("하루 범위(06:00~23:50) 밖으로는 옮기지 않는다", () => {
    const early = [range("2026-11-09 06:00", "2026-11-09 07:00")];
    const result = suggestFreeSlots({ sessions: early, conflicted: early, busy: early });
    expect(result).toEqual([
      { weekday: "mon", startTime: "07:00", endTime: "08:00" },
      { weekday: "mon", startTime: "07:30", endTime: "08:30" },
      { weekday: "mon", startTime: "08:00", endTime: "09:00" },
    ]);
  });
});
