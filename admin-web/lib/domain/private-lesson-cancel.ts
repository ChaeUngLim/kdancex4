// S2-4.3(24시간 규칙 판정) — 개인 레슨 회차를 취소할 때 「차감하나, 안 하나」를 정하는 순수 함수
//   계약: _workspace/03_contracts/11-instructor.md §10 「POST …/bookings/{bookingId}/cancel」
//   설계: _workspace/03_data-model.md §8-6(private_lesson_rule_versions · 24시간 규칙 판정)
//   수용: 마스터 플랜 S2-4 수용 ② 「시작 24시간 이내 취소 요청은 1회 차감으로 처리된다」
//
// 규칙(I20C, 값을 바꿀 칸이 없는 고정 규칙):
//   강사 사정 취소           → cancelled_instructor   · 차감 없음(회차를 돌려준다) · 그 시간은 closed
//   회원 요청, 기한 전 취소   → cancelled_member_free  · 차감 없음                 · 그 시간은 open 으로 돌아감
//   회원 요청, 기한 지난 취소 → cancelled_member_late  · 1회 차감                  · 그 시간은 closed
//
// 「기한」의 시간 값(12·24·48, 기본 24)은 코드에 박지 않는다. 수강권이 결제될 때 고정된
// 규칙 판본(`private_lesson_rule_versions.change_deadline_hours`)에서 받아 인자로 넘긴다.
// 현재 시각도 `now` 로 주입받는다 — 그래서 DB·시계 없이 테스트할 수 있다.
import "./time";

import type { PrivateLessonBookingStatus, PrivateLessonSlotStatus } from "./constants";

/** 변경·취소 기한으로 고를 수 있는 시간 값 — data-model §8-6 `ck_pl_rule_deadline` 과 같다 */
export const PRIVATE_LESSON_CHANGE_DEADLINE_HOURS = [12, 24, 48] as const;
export type PrivateLessonChangeDeadlineHours = (typeof PRIVATE_LESSON_CHANGE_DEADLINE_HOURS)[number];

/** 규칙을 한 번도 저장하지 않은 (학원, 강사)의 기본값(FR-052c) */
export const DEFAULT_PRIVATE_LESSON_CHANGE_DEADLINE_HOURS: PrivateLessonChangeDeadlineHours = 24;

/** 누가 취소를 원했나 — 계약 11 cancel 요청의 `by` */
export type PrivateLessonCancelBy = "instructor" | "member";

export interface PrivateLessonCancelInput {
  readonly by: PrivateLessonCancelBy;
  /** 잡은 회차의 레슨 시작 시각(`private_lesson_slots.starts_at`) */
  readonly slotStartsAt: Temporal.Instant;
  /** 수강권에 고정된 규칙 판본의 기한(시간) */
  readonly changeDeadlineHours: number;
  /** 지금 — 호출자가 `Clock` 으로 얻어 넘긴다 */
  readonly now: Temporal.Instant;
}

export interface PrivateLessonCancelVerdict {
  /** 회차(`private_lesson_bookings.status`)가 바뀔 값 */
  readonly status: Extract<
    PrivateLessonBookingStatus,
    "cancelled_instructor" | "cancelled_member_free" | "cancelled_member_late"
  >;
  /** 수강권에서 1회를 깎나(`private_lesson_bookings.deducted`) */
  readonly deducted: boolean;
  /** 그 시간(`private_lesson_slots.status`)이 바뀔 값 */
  readonly slotStatus: Extract<PrivateLessonSlotStatus, "open" | "closed">;
}

function isAllowedDeadlineHours(hours: number): hours is PrivateLessonChangeDeadlineHours {
  return (PRIVATE_LESSON_CHANGE_DEADLINE_HOURS as readonly number[]).includes(hours);
}

/**
 * 취소 한 건의 결과를 정한다.
 * 경계(남은 시간이 정확히 기한과 같을 때)는 회원에게 유리한 「차감 없음」 쪽이다(계약 11 추천안).
 * 허용 값(12·24·48) 밖의 기한이 오면 RangeError — 잘못 저장된 판본으로 조용히 판정하지 않으려는 것이다.
 */
export function decidePrivateLessonCancel(input: PrivateLessonCancelInput): PrivateLessonCancelVerdict {
  if (!isAllowedDeadlineHours(input.changeDeadlineHours)) {
    throw new RangeError(`변경·취소 기한은 12·24·48시간 중 하나여야 한다: ${input.changeDeadlineHours}`);
  }

  // 강사 사정이면 언제 취소해도 회원 책임이 아니므로 회차를 돌려준다. 그 시간은 강사가 못 쓰니 닫는다
  if (input.by === "instructor") {
    return { status: "cancelled_instructor", deducted: false, slotStatus: "closed" };
  }

  // 마감 순간 = 레슨 시작 − 기한. 지금이 마감 순간 이전(같음 포함)이면 무료 취소다
  const cutoff = input.slotStartsAt.subtract({ hours: input.changeDeadlineHours });
  const beforeCutoff = Temporal.Instant.compare(input.now, cutoff) <= 0;

  if (beforeCutoff) {
    // 다른 회원이 그 시간을 다시 잡을 수 있게 연다
    return { status: "cancelled_member_free", deducted: false, slotStatus: "open" };
  }
  // 늦은 취소는 1회 차감. 너무 임박해 다른 회원이 잡기 어려우므로 그 시간은 닫는다
  return { status: "cancelled_member_late", deducted: true, slotStatus: "closed" };
}
