// S2-1.5(강사 일정 겹침 판정) — FR-054(강사 일정 충돌 거부) · 계약 11 §4-1·§4-3 · 플랜 S2-1 수용 ③
// 「여러 학원에 소속돼도 겹침은 한 강사 기준으로 본다」를 순수 함수 수준에서 확인한다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  type InstructorScheduleItem,
  findInstructorOverlaps,
  hasInstructorOverlap,
  overlapMinutes,
} from "../../lib/domain/instructor-schedule-overlap";

const at = (iso: string) => Temporal.Instant.from(iso);
const range = (from: string, to: string) => ({ startsAt: at(from), endsAt: at(to) });

const ME = "acc-instructor-1";
const OTHER = "acc-instructor-2";

// 토요일 19:00~20:00(KST) = 10:00~11:00Z, 학원 A 의 수업
const academyASession: InstructorScheduleItem = {
  instructorAccountId: ME,
  academyId: "academy-A",
  kind: "class_session",
  label: "쌈바(입문)",
  ...range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z"),
};

describe("overlapMinutes — 두 구간이 겹치는 길이(분)", () => {
  test("30분 겹치면 30", () => {
    expect(
      overlapMinutes(
        range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z"),
        range("2026-11-28T10:30:00Z", "2026-11-28T11:30:00Z"),
      ),
    ).toBe(30);
  });

  test("한쪽이 다른 쪽을 품으면 짧은 쪽 길이", () => {
    expect(
      overlapMinutes(
        range("2026-11-28T09:00:00Z", "2026-11-28T12:00:00Z"),
        range("2026-11-28T10:00:00Z", "2026-11-28T10:50:00Z"),
      ),
    ).toBe(50);
  });

  test("끝과 시작이 맞닿으면 겹침이 아니다(0)", () => {
    expect(
      overlapMinutes(
        range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z"),
        range("2026-11-28T11:00:00Z", "2026-11-28T12:00:00Z"),
      ),
    ).toBe(0);
  });

  test("떨어져 있으면 0", () => {
    expect(
      overlapMinutes(
        range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z"),
        range("2026-11-28T13:00:00Z", "2026-11-28T14:00:00Z"),
      ),
    ).toBe(0);
  });

  test("끝이 시작보다 늦지 않은 구간은 RangeError", () => {
    expect(() =>
      overlapMinutes(
        range("2026-11-28T11:00:00Z", "2026-11-28T11:00:00Z"),
        range("2026-11-28T10:00:00Z", "2026-11-28T12:00:00Z"),
      ),
    ).toThrow(RangeError);
  });
});

describe("findInstructorOverlaps — 한 강사 기준 겹침(수용 ③)", () => {
  test("학원이 달라도 같은 시각이면 겹침이다(수용 ③)", () => {
    // 학원 B 에 같은 토요일 19:00~20:00 수업을 새로 올리려 한다
    const candidate = range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z");

    const result = findInstructorOverlaps(ME, [candidate], [academyASession]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ candidateIndex: 0, overlapMinutes: 60 });
    expect(result[0]?.existing.academyId).toBe("academy-A");
    expect(result[0]?.existing.label).toBe("쌈바(입문)");
    expect(hasInstructorOverlap(ME, [candidate], [academyASession])).toBe(true);
  });

  test("학원이 달라도 일부만 겹치면 겹친 분을 돌려준다(「30분 겹쳐요」)", () => {
    const candidate = range("2026-11-28T10:30:00Z", "2026-11-28T11:30:00Z");

    const result = findInstructorOverlaps(ME, [candidate], [academyASession]);

    expect(result.map((o) => o.overlapMinutes)).toEqual([30]);
  });

  test("다른 강사의 일정은 같은 시각이어도 겹침이 아니다", () => {
    const othersSession: InstructorScheduleItem = { ...academyASession, instructorAccountId: OTHER };
    const candidate = range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z");

    expect(findInstructorOverlaps(ME, [candidate], [othersSession])).toEqual([]);
    expect(hasInstructorOverlap(ME, [candidate], [othersSession])).toBe(false);
  });

  test("학원 사이 이동 여유는 두지 않는다 — 앞 수업이 끝나는 시각에 바로 시작해도 겹침 아님", () => {
    const candidate = range("2026-11-28T11:00:00Z", "2026-11-28T12:00:00Z");

    expect(findInstructorOverlaps(ME, [candidate], [academyASession])).toEqual([]);
  });

  test("반복 일정의 여러 회차 중 겹치는 회차만 골라낸다(시작 순서로 정렬)", () => {
    const privateLesson: InstructorScheduleItem = {
      instructorAccountId: ME,
      academyId: "academy-C",
      kind: "private_lesson_slot",
      label: "개인 레슨",
      ...range("2026-12-05T10:40:00Z", "2026-12-05T11:20:00Z"),
    };
    const candidates = [
      range("2026-12-05T10:00:00Z", "2026-12-05T11:00:00Z"), // 둘째 주 — 개인 레슨과 20분
      range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z"), // 첫째 주 — 학원 A 와 60분
      range("2026-12-12T10:00:00Z", "2026-12-12T11:00:00Z"), // 셋째 주 — 비어 있음
    ];

    const result = findInstructorOverlaps(ME, candidates, [privateLesson, academyASession]);

    expect(result.map((o) => [o.candidateIndex, o.existing.kind, o.overlapMinutes])).toEqual([
      [1, "class_session", 60],
      [0, "private_lesson_slot", 20],
    ]);
  });

  test("기존 일정이 없으면 빈 목록", () => {
    expect(findInstructorOverlaps(ME, [range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z")], [])).toEqual([]);
  });

  test("입력을 바꾸지 않는다", () => {
    const existing = [academyASession];
    const candidates = [range("2026-11-28T10:00:00Z", "2026-11-28T11:00:00Z")];
    const before = JSON.stringify({ existing, candidates });

    findInstructorOverlaps(ME, candidates, existing);

    expect(JSON.stringify({ existing, candidates })).toBe(before);
  });
});
