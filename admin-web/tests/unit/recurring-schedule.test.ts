// S2-2.2(반복 일정 생성) 단위 테스트 — FR-057(반복 일정 생성) · 계약 11-instructor §4-1(schedule)
// 요일·시각과 「회차 수」 또는 「끝나는 날」을 주면 회차 목록(날짜·시작·끝 순간)이 나오는지 본다.
// 기대 날짜는 실제 달력에서 손으로 셌다(2026-12-01 은 화요일, 2026-11-02 는 월요일).
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  MAX_RECURRING_SESSIONS,
  buildRecurringSessions,
  type RecurringScheduleInput,
} from "../../lib/domain/recurring-schedule";

/** 회차 목록을 비교하기 쉬운 글자로 바꾼다 */
const summarize = (input: RecurringScheduleInput) =>
  buildRecurringSessions(input).map((s) => ({
    seq: s.seq,
    date: s.date.toString(),
    startsAt: s.startsAt.toString(),
    endsAt: s.endsAt.toString(),
  }));

describe("buildRecurringSessions — 회차 수로 만들기", () => {
  test("화·목 20:30–21:30 8회차가 기대 날짜와 같다(KST → UTC 9시간 앞)", () => {
    const sessions = summarize({
      weekdays: ["tue", "thu"],
      startTime: "20:30",
      endTime: "21:30",
      periodFrom: "2026-12-01",
      sessionCount: 8,
    });

    expect(sessions.map((s) => s.date)).toEqual([
      "2026-12-01", // 화
      "2026-12-03", // 목
      "2026-12-08",
      "2026-12-10",
      "2026-12-15",
      "2026-12-17",
      "2026-12-22",
      "2026-12-24",
    ]);
    expect(sessions.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sessions[0]).toEqual({
      seq: 1,
      date: "2026-12-01",
      startsAt: "2026-12-01T11:30:00Z",
      endsAt: "2026-12-01T12:30:00Z",
    });
    expect(sessions[7]).toEqual({
      seq: 8,
      date: "2026-12-24",
      startsAt: "2026-12-24T11:30:00Z",
      endsAt: "2026-12-24T12:30:00Z",
    });
  });

  test("시작일이 고른 요일이 아니면 그 뒤 첫 고른 요일부터 센다", () => {
    // 2026-12-02 는 수요일 → 첫 회차는 12/3(목)
    const dates = summarize({
      weekdays: ["thu", "tue"], // 순서를 섞어 넣어도 날짜 순으로 나온다
      startTime: "19:00",
      endTime: "20:00",
      periodFrom: "2026-12-02",
      sessionCount: 3,
    }).map((s) => s.date);
    expect(dates).toEqual(["2026-12-03", "2026-12-08", "2026-12-10"]);
  });

  test("KST 이른 아침 수업은 UTC 로 전날이 된다 — 날짜는 KST 달력 그대로 둔다", () => {
    const [first] = summarize({
      weekdays: ["sat"],
      startTime: "07:00",
      endTime: "08:00",
      periodFrom: "2026-12-05",
      sessionCount: 1,
    });
    expect(first).toEqual({
      seq: 1,
      date: "2026-12-05",
      startsAt: "2026-12-04T22:00:00Z",
      endsAt: "2026-12-04T23:00:00Z",
    });
  });

  test("해를 넘겨도 7일 간격이 그대로다", () => {
    const dates = summarize({
      weekdays: ["wed"],
      startTime: "20:00",
      endTime: "21:00",
      periodFrom: "2026-12-23",
      sessionCount: 3,
    }).map((s) => s.date);
    expect(dates).toEqual(["2026-12-23", "2026-12-30", "2027-01-06"]);
  });

  test("같은 요일을 두 번 넣어도 한 번으로 친다", () => {
    const dates = summarize({
      weekdays: ["tue", "tue"],
      startTime: "20:00",
      endTime: "21:00",
      periodFrom: "2026-12-01",
      sessionCount: 2,
    }).map((s) => s.date);
    expect(dates).toEqual(["2026-12-01", "2026-12-08"]);
  });
});

describe("buildRecurringSessions — 끝나는 날로 만들기(계약 §4-1 예시)", () => {
  test("월·수 2026-11-02 ~ 2026-12-23 은 16회차, 첫 시작·마지막 끝이 계약 예시와 같다", () => {
    const sessions = summarize({
      weekdays: ["mon", "wed"],
      startTime: "20:30",
      endTime: "21:30",
      periodFrom: "2026-11-02",
      periodTo: "2026-12-23",
    });
    expect(sessions).toHaveLength(16);
    expect(sessions[0]?.startsAt).toBe("2026-11-02T11:30:00Z");
    expect(sessions[15]?.endsAt).toBe("2026-12-23T12:30:00Z");
  });

  test("끝나는 날 당일 회차도 넣는다(양 끝 포함)", () => {
    const dates = summarize({
      weekdays: ["tue"],
      startTime: "20:00",
      endTime: "21:00",
      periodFrom: "2026-12-01",
      periodTo: "2026-12-15",
    }).map((s) => s.date);
    expect(dates).toEqual(["2026-12-01", "2026-12-08", "2026-12-15"]);
  });
});

describe("buildRecurringSessions — 잘못된 입력은 RangeError", () => {
  const base: RecurringScheduleInput = {
    weekdays: ["tue", "thu"],
    startTime: "20:30",
    endTime: "21:30",
    periodFrom: "2026-12-01",
    sessionCount: 8,
  };

  test.each<[string, Partial<RecurringScheduleInput>]>([
    ["요일 없음", { weekdays: [] }],
    ["모르는 요일", { weekdays: ["xyz" as never] }],
    ["10분 단위가 아님", { startTime: "20:35" }],
    ["끝 시각이 10분 단위가 아님", { endTime: "21:31" }],
    ["끝이 시작과 같음", { endTime: "20:30" }],
    ["끝이 시작보다 앞(자정 넘김)", { startTime: "23:30", endTime: "00:30" }],
    ["시각 형식 틀림", { startTime: "8:30" }],
    ["없는 날짜", { periodFrom: "2026-02-30" }],
    ["회차 수 0", { sessionCount: 0 }],
    ["회차 수 소수", { sessionCount: 1.5 }],
    ["회차 수 상한 초과", { sessionCount: MAX_RECURRING_SESSIONS + 1 }],
    ["회차 수와 끝나는 날 둘 다", { periodTo: "2026-12-31" }],
    ["회차 수도 끝나는 날도 없음", { sessionCount: null }],
  ])("%s", (_name, patch) => {
    expect(() => buildRecurringSessions({ ...base, ...patch })).toThrow(RangeError);
  });

  test("끝나는 날이 시작일보다 앞이면 거부", () => {
    expect(() =>
      buildRecurringSessions({ ...base, sessionCount: null, periodTo: "2026-11-30" }),
    ).toThrow(RangeError);
  });

  test("기간 안에 고른 요일이 하나도 없으면(회차 0) 거부", () => {
    // 2026-12-02(수) 하루뿐인데 화·목만 골랐다
    expect(() =>
      buildRecurringSessions({ ...base, sessionCount: null, periodTo: "2026-12-02", periodFrom: "2026-12-02" }),
    ).toThrow(RangeError);
  });

  test("기간으로 만든 회차가 상한을 넘으면 거부", () => {
    // 매일 7개 요일 × 약 29주 → 200 초과
    expect(() =>
      buildRecurringSessions({
        weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        startTime: "10:00",
        endTime: "11:00",
        periodFrom: "2026-01-01",
        periodTo: "2026-12-31",
      }),
    ).toThrow(RangeError);
  });

  test("회차 수 상한 정확히 200 은 통과한다", () => {
    expect(buildRecurringSessions({ ...base, sessionCount: MAX_RECURRING_SESSIONS })).toHaveLength(
      MAX_RECURRING_SESSIONS,
    );
  });
});
