// S2-3.12(공개 뒤 수업 수정 요청 API) — 갈래 나누기 · 회차 옮기기 · 환불 마감일 앞당기기 판정 · 저장 값 합치기(순수 함수).
//   계약: _workspace/03_contracts/11-instructor.md §5 · 열린 점 ⑬
import { describe, expect, test } from "vitest";

import {
  judgeRefundDeadlineChange,
  lockedFieldsIn,
  mergeApprovedPayload,
  planScheduleMove,
  splitEditChanges,
  type ExistingSession,
} from "@/lib/domain/class-edit-request";
import { planSessions, type ClassPayload, type ClassSchedule } from "@/lib/domain/class-registration";

const rule = (startTime: string, endTime: string, periodTo = "2026-12-24"): Extract<ClassSchedule, { kind: "recurring" }> => ({
  kind: "recurring",
  weekdays: ["tue", "thu"],
  startTime,
  endTime,
  periodFrom: "2026-12-01",
  periodTo,
});

/** 지금 회차 — 화·목 20:30~21:30, 8회 */
const existing: ExistingSession[] = planSessions(rule("20:30", "21:30")).map((s) => ({
  sessionId: `s${s.seq}`,
  seq: s.seq,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  status: "scheduled",
}));

describe("공개 뒤 수정 값 갈래(계약 11 §5)", () => {
  test("잠긴 칸을 찾고, 바로 바뀌는 값과 재승인 값을 나눈다", () => {
    expect(lockedFieldsIn({ genre: "x", introText: "y", classKind: "event" })).toEqual(["genre", "classKind"]);
    expect(lockedFieldsIn({ priceAmount: 1 })).toEqual([]);
    expect(splitEditChanges({ introText: "a", posterFileId: null, priceAmount: 1, capacity: { male: 2 } })).toEqual({
      immediate: { introText: "a", posterFileId: null },
      approval: { priceAmount: 1, capacity: { male: 2 } },
    });
  });
});

describe("일정 변경 → 회차 옮기기(열린 점 ⑬)", () => {
  test("모든 회차가 미래면 8개 모두 같은 seq 의 새 시각으로 옮긴다", () => {
    const result = planScheduleMove({ schedule: rule("19:00", "20:00"), classKind: "regular", existing, now: Temporal.Instant.from("2026-11-21T00:00:00Z") });
    if (!result.ok) throw new Error("통과해야 한다");
    expect(result.moves).toHaveLength(8);
    expect(result.moves[0]?.after.startsAt.toString()).toBe("2026-12-01T10:00:00Z");
  });

  test("지난 회차는 그대로 두고 시작 전 회차만 옮긴다 — 정확히 지금 시작하는 회차도 지난 것으로 본다", () => {
    const second = existing[1];
    if (second === undefined) throw new Error("회차가 없다");
    const result = planScheduleMove({ schedule: rule("21:00", "22:00"), classKind: "regular", existing, now: second.startsAt });
    if (!result.ok) throw new Error("통과해야 한다");
    expect(result.moves.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(result.finalSessions[0]?.startsAt.equals(existing[0]!.startsAt)).toBe(true);
  });

  test("회차 수가 달라지면 EDIT_SESSION_COUNT_CHANGED", () => {
    const result = planScheduleMove({ schedule: rule("19:00", "20:00", "2026-12-17"), classKind: "regular", existing, now: Temporal.Instant.from("2026-11-21T00:00:00Z") });
    expect(result.ok ? null : result.code).toBe("EDIT_SESSION_COUNT_CHANGED");
  });

  test("시작 전 회차를 지난 시각으로 옮기거나, 수업 구분과 일정 모양이 다르거나, 10분 단위가 아니면 VALIDATION_FAILED", () => {
    // 하루 당겨 월·수로 바꾸면 1회차(12/1 화)는 지났지만 2회차의 새 시각(12/2 수 19:00 KST = 10:00Z)이 지금(12/2 12:00Z)보다 앞이다
    const shifted: ClassSchedule = { ...rule("19:00", "20:00"), weekdays: ["mon", "wed"], periodFrom: "2026-11-30", periodTo: "2026-12-23" };
    const past = planScheduleMove({ schedule: shifted, classKind: "regular", existing, now: Temporal.Instant.from("2026-12-02T12:00:00Z") });
    expect(past.ok ? null : past.code).toBe("VALIDATION_FAILED");
    const single = planScheduleMove({ schedule: { kind: "single", date: "2026-12-06", startTime: "19:00", endTime: "20:00" }, classKind: "regular", existing, now: Temporal.Instant.from("2026-11-21T00:00:00Z") });
    expect(single.ok ? null : single.code).toBe("VALIDATION_FAILED");
    const odd = planScheduleMove({ schedule: rule("19:05", "20:00"), classKind: "regular", existing, now: Temporal.Instant.from("2026-11-21T00:00:00Z") });
    expect(odd.ok ? null : odd.code).toBe("VALIDATION_FAILED");
  });
});

describe("환불 마감일은 늦추기만(FR-099d)", () => {
  test("잡힌 자리가 있으면 앞당기기만 거부, 같은 날·늦추기는 된다. 자리가 없거나 마감일이 없으면 된다", () => {
    expect(judgeRefundDeadlineChange("2026-12-05", "2026-12-04", 1).ok).toBe(false);
    expect(judgeRefundDeadlineChange("2026-12-05", "2026-12-05", 1).ok).toBe(true);
    expect(judgeRefundDeadlineChange("2026-12-05", "2026-12-06", 1).ok).toBe(true);
    expect(judgeRefundDeadlineChange("2026-12-05", "2026-12-01", 0).ok).toBe(true);
    expect(judgeRefundDeadlineChange(null, "2026-12-01", 3).ok).toBe(true);
  });
});

describe("승인 뒤 저장 값 합치기", () => {
  const payload: ClassPayload = {
    classKind: "regular",
    title: "쌈바",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: null,
    priceAmount: 300000,
    schedule: rule("20:30", "21:30"),
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: "소개",
  };
  test("보낸 칸만 바꾸고 정원 모드는 지킨다. 원본은 그대로", () => {
    const merged = mergeApprovedPayload(payload, { priceAmount: 320000, capacity: { male: 8 } });
    expect(merged.priceAmount).toBe(320000);
    expect(merged.capacity).toEqual({ mode: "gender_split", male: 8, female: 6 });
    expect(merged.schedule).toEqual(payload.schedule);
    expect(payload.capacity).toEqual({ mode: "gender_split", male: 6, female: 6 });
  });
});
