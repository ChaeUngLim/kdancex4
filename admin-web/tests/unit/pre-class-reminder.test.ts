// S7-1.7(수업 전 알림 작업) — 시점 표·알림 열쇠·「지금 알릴 때인가」 순수 함수(FR-140)
import { describe, expect, test } from "vitest";

import { PRE_CLASS_LEADS } from "@/lib/domain/constants";
import {
  DEFAULT_PRE_CLASS_LEAD,
  PRE_CLASS_LEAD_MINUTES,
  PRE_CLASS_SCAN_MINUTES,
  isPreClassReminderDue,
  preClassDedupeKey,
} from "@/lib/domain/pre-class-reminder";

const START = Temporal.Instant.from("2026-12-01T10:00:00Z");

describe("수업 전 알림 시점(FR-140)", () => {
  test("네 시점이 모두 표에 있고 분 값이 맞다", () => {
    expect(Object.keys(PRE_CLASS_LEAD_MINUTES).sort()).toEqual([...PRE_CLASS_LEADS].sort());
    expect(PRE_CLASS_LEAD_MINUTES).toEqual({ day_before: 1440, two_hours: 120, one_hour: 60, thirty_min: 30 });
    expect(DEFAULT_PRE_CLASS_LEAD).toBe("one_hour");
  });

  test("작업은 가장 이른 시점(하루 전)만큼 앞을 훑는다", () => {
    expect(PRE_CLASS_SCAN_MINUTES).toBe(1440);
  });

  test("열쇠는 preclass:<회차>:<회원>:<시점>", () => {
    expect(preClassDedupeKey("s1", "m1", "thirty_min")).toBe("preclass:s1:m1:thirty_min");
  });

  test("알릴 시각 ≤ 지금 < 수업 시작일 때만 참", () => {
    expect(isPreClassReminderDue(START, "one_hour", START.subtract({ minutes: 61 }))).toBe(false);
    expect(isPreClassReminderDue(START, "one_hour", START.subtract({ minutes: 60 }))).toBe(true);
    expect(isPreClassReminderDue(START, "one_hour", START.subtract({ seconds: 1 }))).toBe(true);
    expect(isPreClassReminderDue(START, "one_hour", START)).toBe(false);
    expect(isPreClassReminderDue(START, "day_before", START.subtract({ hours: 3 }))).toBe(true);
  });
});
