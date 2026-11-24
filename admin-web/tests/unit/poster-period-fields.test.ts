// SX-2.6(포스터 초안 기간 칸) — 기간 칸 3개(개강일 · 종료일 · 회차 수)의 값 모양 · 「채워야 하나」 판정 · 일정 만들기 · 화면 표시.
//   요구: FR-073(포스터 자동 추출) 하위 불릿 2026-11-24 — 기간이 비면 검토 화면에서 확인필요 빈 칸, 채울 때까지 제출을 막는다
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6(칸 키 17개) · 11-instructor.md §4-2(schedule)
import { describe, expect, test } from "vitest";

import { POSTER_FIELD_KEYS } from "@/lib/domain/constants";
import { missingPeriodKeys, parseFieldValue, toClassDraft, toSchedule, type ReviewedFields } from "@/lib/domain/poster-extraction";
import { posterFieldBadges, posterMustFillKeys, posterNeedsCheckKeys, type PosterFieldDisplayInput } from "@/lib/domain/poster-field-badges";
import { missingFieldsText, parsePosterInput, posterValueText } from "@/lib/poster-review-form";

const BASE: ReviewedFields = {
  class_kind: "regular",
  weekday: ["sat"],
  start_time: "19:00",
  end_time: "20:30",
};

const field = (over: Partial<PosterFieldDisplayInput> & Pick<PosterFieldDisplayInput, "key">): PosterFieldDisplayInput => ({
  value: null,
  confidence: null,
  valueSource: "ai",
  confirmedAt: null,
  ...over,
});

describe("칸 키 — 기간 칸 3개가 시간 칸 바로 뒤에", () => {
  test("17개이고 end_time 다음이 start_date · end_date · session_count", () => {
    const keys = [...POSTER_FIELD_KEYS];
    expect(keys).toHaveLength(17);
    const at = keys.indexOf("end_time");
    expect(keys.slice(at + 1, at + 4)).toEqual(["start_date", "end_date", "session_count"]);
  });
});

describe("값 모양(zod) — agent-server field_rules.py 와 같은 규칙", () => {
  test("날짜는 YYYY-MM-DD 이고 달력에 있는 날 · 연도 2020~2100", () => {
    expect(parseFieldValue("start_date", "2026-12-05")).toEqual({ ok: true, value: "2026-12-05" });
    expect(parseFieldValue("end_date", "2026-02-30").ok).toBe(false);
    expect(parseFieldValue("start_date", "12-05").ok).toBe(false);
    expect(parseFieldValue("start_date", "1926-12-05").ok).toBe(false);
    expect(parseFieldValue("start_date", null)).toEqual({ ok: true, value: null });
  });

  test("회차 수는 1~200 정수", () => {
    expect(parseFieldValue("session_count", 4)).toEqual({ ok: true, value: 4 });
    for (const bad of [0, 201, 2.5, "4회"]) expect(parseFieldValue("session_count", bad).ok).toBe(false);
  });
});

describe("missingPeriodKeys — 비어서 채워야 하는 기간 칸", () => {
  test("셋 다 비면 셋 다", () => {
    expect(missingPeriodKeys(BASE)).toEqual(["start_date", "end_date", "session_count"]);
  });

  test("개강일 + 종료일이면 회차 수는 비어도 된다 · 개강일 + 회차 수면 종료일은 비어도 된다", () => {
    expect(missingPeriodKeys({ ...BASE, start_date: "2026-12-05", end_date: "2026-12-26" })).toEqual([]);
    expect(missingPeriodKeys({ ...BASE, start_date: "2026-12-05", session_count: 4 })).toEqual([]);
  });

  test("끝만 있고 개강일이 없으면 개강일만", () => {
    expect(missingPeriodKeys({ ...BASE, end_date: "2026-12-26", session_count: 4 })).toEqual(["start_date"]);
  });

  test("이벤트형(하루 일정)은 개강일만 있으면 된다", () => {
    expect(missingPeriodKeys({ ...BASE, class_kind: "party" })).toEqual(["start_date"]);
    expect(missingPeriodKeys({ ...BASE, class_kind: "party", start_date: "2026-12-12" })).toEqual([]);
  });
});

describe("toSchedule · toClassDraft — 포스터 칸 → S2-2 일정", () => {
  test("개강일 + 종료일 → 반복 일정 그대로", () => {
    expect(toSchedule({ ...BASE, start_date: "2026-12-05", end_date: "2026-12-26", session_count: 4 })).toEqual({
      kind: "recurring",
      weekdays: ["sat"],
      startTime: "19:00",
      endTime: "20:30",
      periodFrom: "2026-12-05",
      periodTo: "2026-12-26",
    });
  });

  test("개강일 + 회차 수만 → 요일로 세어 마지막 회차 날짜가 끝나는 날(12/5 부터 토 4회 → 12/26)", () => {
    expect(toSchedule({ ...BASE, start_date: "2026-12-05", session_count: 4 })).toMatchObject({ periodFrom: "2026-12-05", periodTo: "2026-12-26" });
  });

  test("이벤트형은 하루 일정", () => {
    expect(toSchedule({ ...BASE, class_kind: "one_day", start_date: "2026-12-12" })).toEqual({
      kind: "single",
      date: "2026-12-12",
      startTime: "19:00",
      endTime: "20:30",
    });
  });

  test("모자라면 null — 기간 없음 · 요일 없음 · 회차를 셀 수 없는 시각(10분 단위 아님)", () => {
    expect(toSchedule(BASE)).toBeNull();
    expect(toSchedule({ ...BASE, weekday: null, start_date: "2026-12-05", end_date: "2026-12-26" })).toBeNull();
    expect(toSchedule({ ...BASE, start_time: "19:05", start_date: "2026-12-05", session_count: 4 })).toBeNull();
  });

  test("임시 저장 본문의 schedule 에 들어간다", () => {
    const draft = toClassDraft({ ...BASE, title: "바차타", start_date: "2026-12-05", end_date: "2026-12-26" }, {
      academyId: "a",
      roomId: null,
      instructorAccountId: null,
    });
    expect(draft.schedule).toMatchObject({ kind: "recurring", periodFrom: "2026-12-05", periodTo: "2026-12-26" });
  });
});

describe("표시(SX-2.4 판정에 반영) — 채워야 하는 빈 기간 칸은 언제나 확인필요", () => {
  const list = [
    field({ key: "weekday", value: ["sat"], confidence: 0.95 }),
    field({ key: "start_date" }),
    field({ key: "end_date" }),
    field({ key: "session_count", value: 4, confidence: 0.9 }),
  ];

  test("회차 수가 있으면 종료일은 채울 필요가 없고(맞아요 가능), 개강일만 채워야 한다", () => {
    expect(posterMustFillKeys(list)).toEqual(["start_date"]);
    expect(posterNeedsCheckKeys(list)).toEqual(["start_date", "end_date"]);
  });

  test("맞다고 확인했거나 사람이 비운 칸이어도 채워야 하면 확인필요(AI 생성은 아님)", () => {
    expect(posterFieldBadges(field({ key: "start_date", confirmedAt: "2026-11-24T00:00:00.000Z" }), undefined, true)).toEqual({
      needsCheck: true,
      aiGenerated: false,
      labels: ["확인필요"],
    });
    expect(posterFieldBadges(field({ key: "start_date", valueSource: "user" }), undefined, true).needsCheck).toBe(true);
  });

  test("기간이 다 차면 채워야 하는 칸이 없다", () => {
    expect(posterMustFillKeys([...list.slice(0, 1), field({ key: "start_date", value: "2026-12-05", confidence: 0.93 }), ...list.slice(2)])).toEqual([]);
  });
});

describe("검토 화면 글자 — 기간 칸", () => {
  test("값 글자: 날짜 그대로 · 회차 수는 「회」", () => {
    expect(posterValueText("start_date", "2026-12-05")).toBe("2026-12-05");
    expect(posterValueText("session_count", 4)).toBe("4회");
    expect(posterValueText("capacity_male", 6)).toBe("6명");
    expect(posterValueText("price_amount", 180000)).toBe("180,000원");
  });

  test("고친 글자: 2026.12.5 → 2026-12-05 · 「4회」 → 4 · 모양 밖은 안내", () => {
    expect(parsePosterInput("start_date", "2026.12.5", [])).toEqual({ ok: true, value: "2026-12-05" });
    expect(parsePosterInput("end_date", "2026-12-26", [])).toEqual({ ok: true, value: "2026-12-26" });
    expect(parsePosterInput("session_count", "4회", [])).toEqual({ ok: true, value: 4 });
    expect(parsePosterInput("start_date", "12월 5일", []).ok).toBe(false);
  });

  test("빠진 칸 안내: S2-2 칸 이름과 포스터 칸 이름을 화면 글자로", () => {
    expect(missingFieldsText(["schedule", "targetAges"])).toBe("일정 · 적정 연령");
    expect(missingFieldsText(["start_date", "end_date"])).toBe("개강일 · 종료일");
  });
});
