// S2-4.3(24시간 규칙 판정) — 개인 레슨 회차 취소 판정(순수 함수) 단위 테스트
//   계약: _workspace/03_contracts/11-instructor.md §10 「POST …/bookings/{bookingId}/cancel」 · Phase 6 단위 「24시간 규칙 판정(경계 앞뒤·정확히 24시간)」
//   설계: _workspace/03_data-model.md §8-6(24시간 규칙 판정)
//   수용: 마스터 플랜 S2-4 수용 ② 「시작 24시간 이내 취소 요청은 1회 차감으로 처리된다」 · 계약 11 시나리오 12(25시간 전·23시간 전)
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS,
  PRIVATE_LESSON_CHANGE_DEADLINE_HOURS,
  decidePrivateLessonCancel,
} from "../../lib/domain/private-lesson-cancel";

// 레슨 시작: 2026-12-06 14:00 KST(= 05:00Z)
const SLOT_START = Temporal.Instant.from("2026-12-06T05:00:00Z");
const hoursBefore = (hours: number) => SLOT_START.subtract({ minutes: Math.round(hours * 60) });

describe("decidePrivateLessonCancel — 회원 요청 취소(기한 24시간)", () => {
  const base = { by: "member" as const, slotStartsAt: SLOT_START, changeDeadlineHours: 24 };

  test("시작 25시간 전 → 차감 없음(cancelled_member_free), 시간은 다시 열린다", () => {
    expect(decidePrivateLessonCancel({ ...base, now: hoursBefore(25) })).toEqual({
      status: "cancelled_member_free",
      deducted: false,
      slotStatus: "open",
    });
  });

  test("시작 23시간 전 → 1회 차감(cancelled_member_late), 시간은 닫힌다", () => {
    expect(decidePrivateLessonCancel({ ...base, now: hoursBefore(23) })).toEqual({
      status: "cancelled_member_late",
      deducted: true,
      slotStatus: "closed",
    });
  });

  test("정확히 24시간 전(경계) → 차감 없음 쪽(계약 11 추천안)", () => {
    expect(decidePrivateLessonCancel({ ...base, now: hoursBefore(24) })).toMatchObject({
      status: "cancelled_member_free",
      deducted: false,
    });
  });

  test("경계 1초 뒤(23:59:59 전) → 1회 차감", () => {
    const now = SLOT_START.subtract({ hours: 24 }).add({ seconds: 1 });
    expect(decidePrivateLessonCancel({ ...base, now })).toMatchObject({ status: "cancelled_member_late", deducted: true });
  });

  test("이미 시작한 뒤의 회원 취소 → 1회 차감", () => {
    const now = SLOT_START.add({ minutes: 10 });
    expect(decidePrivateLessonCancel({ ...base, now })).toMatchObject({ status: "cancelled_member_late", deducted: true });
  });
});

describe("decidePrivateLessonCancel — 기한 값은 수강권에 고정된 규칙 판본에서 온다", () => {
  test("기한 12시간: 13시간 전은 무료, 11시간 전은 차감", () => {
    const base = { by: "member" as const, slotStartsAt: SLOT_START, changeDeadlineHours: 12 };
    expect(decidePrivateLessonCancel({ ...base, now: hoursBefore(13) }).deducted).toBe(false);
    expect(decidePrivateLessonCancel({ ...base, now: hoursBefore(11) }).deducted).toBe(true);
  });

  test("기한 48시간: 30시간 전이어도 차감", () => {
    const verdict = decidePrivateLessonCancel({
      by: "member",
      slotStartsAt: SLOT_START,
      changeDeadlineHours: 48,
      now: hoursBefore(30),
    });
    expect(verdict).toMatchObject({ status: "cancelled_member_late", deducted: true });
  });

  test("허용 값은 12·24·48, 기본값 24(data-model §8-6 ck_pl_rule_deadline)", () => {
    expect(PRIVATE_LESSON_CHANGE_DEADLINE_HOURS).toEqual([12, 24, 48]);
    expect(DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS).toBe(24);
  });

  test("허용 값 밖의 기한(예: 36)은 RangeError — 잘못된 판본을 조용히 쓰지 않는다", () => {
    expect(() =>
      decidePrivateLessonCancel({ by: "member", slotStartsAt: SLOT_START, changeDeadlineHours: 36, now: hoursBefore(40) }),
    ).toThrow(RangeError);
  });
});

describe("decidePrivateLessonCancel — 강사 사정 취소", () => {
  test("시작 1시간 전이어도 차감 없음(cancelled_instructor), 시간은 닫힌다", () => {
    expect(
      decidePrivateLessonCancel({ by: "instructor", slotStartsAt: SLOT_START, changeDeadlineHours: 24, now: hoursBefore(1) }),
    ).toEqual({ status: "cancelled_instructor", deducted: false, slotStatus: "closed" });
  });

  test("기한 전이어도 같은 결과", () => {
    expect(
      decidePrivateLessonCancel({ by: "instructor", slotStartsAt: SLOT_START, changeDeadlineHours: 24, now: hoursBefore(72) }),
    ).toEqual({ status: "cancelled_instructor", deducted: false, slotStatus: "closed" });
  });
});
