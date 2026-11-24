// S2-3.2(시간·장소 변경과 휴강 알림) — 회차 변경·휴강·폐강에 쓰는 순수 함수 모음(DB·시계를 직접 만지지 않는다).
//   계약: _workspace/03_contracts/11-instructor.md §6-1(시간·장소 변경) · §6-2(휴강·폐강)
//   데이터: data-model §8-5(session_changes) · §(g) closure_choices.deadline_at(확정일 + 7일의 KST 23:59)
//
// 여기 있는 것:
//   ① 시각 검사 — 10분 단위인가(계약 11 §6-1 「시각은 10분 단위」)
//   ② 회원이 휴강 회차를 옮기거나 환불을 고를 기한(Q16 임시 확정 7일, 안 고르면 환불)
//   ③ 회원 알림 문구 — 「11/16 (월) 시간과 장소가 바뀌었어요 · 20:30–21:30 A홀 → 21:00–22:00 B홀」
//   ④ 휴강 1회 금액 예시(결제액 ÷ 회차 수, 원 미만 올림 — FR-100(환불 정수 연산))
// 서비스(lib/server/services/session-changes.ts)와 미리 보기가 같은 함수를 써야 「미리 보기 문구」와 「실제 알림 문구」가 어긋나지 않는다.
import { ceilMulDiv } from "./money";
import { formatTimeOfDay, KST_TIME_ZONE, toKstDate, toKstTimeOfDay } from "./time";

/** 회차 시각은 10분 단위만 받는다(계약 11 §6-1) */
export const SESSION_TIME_STEP_MINUTES = 10;

/** 휴강 회차에서 회원이 고를 수 있는 날 수(data-model 설정값 CLOSURE_CHOICE_DAYS, Q16 임시 확정 7일) */
export const CLOSURE_CHOICE_DAYS = 7;

/** 휴강 사유 길이(계약 11 §6-2 — 1~100자, 추천값). 사유는 수강생에게 그대로 보인다 */
export const CANCEL_REASON_MAX = 100;

/** 휴강 회차에서 회원이 고르는 길(계약 11 §6-2 preview 의 memberChoice.options) — 고르지 않으면 환불 */
export const CLOSURE_CHOICE_OPTIONS = ["move_to_other_session", "refund_session_amount"] as const;
export const CLOSURE_CHOICE_DEFAULT = "refund_session_amount";

/** 순간이 10분 단위(초·밀리초 0)인가 — 「20:35」 같은 값은 거부한다 */
export function isOnTimeStep(at: Temporal.Instant): boolean {
  const ms = at.epochMilliseconds;
  return ms % (SESSION_TIME_STEP_MINUTES * 60 * 1000) === 0;
}

/**
 * 회원이 휴강 회차를 옮기거나 환불을 고를 기한.
 * 휴강을 알린 날(KST 달력)에서 7일 뒤 그날의 23:59(KST) — data-model closure_choices.deadline_at 규칙 그대로.
 * 왜 「알린 시각 + 168시간」이 아니라 「그날 23:59」인가: 회원에게 「11/28(금)까지」처럼 날짜로 안내하기 때문이다.
 * S4-3(휴강 선택 열기)이 선택 행을 만들 때도 이 함수를 써야 session_changes 의 사본과 원본이 같다.
 */
export function closureChoiceDeadline(notifiedAt: Temporal.Instant, days: number = CLOSURE_CHOICE_DAYS): Temporal.Instant {
  const lastDay = toKstDate(notifiedAt).add({ days });
  return lastDay.toZonedDateTime({ timeZone: KST_TIME_ZONE, plainTime: Temporal.PlainTime.from("23:59") }).toInstant();
}

/** 휴강 1회 금액 = 결제액 ÷ 회차 수(원 미만 올림). 회차 수가 0 이하면 예시를 만들 수 없다(null) */
export function perSessionAmount(paid: number, sessionTotal: number): number | null {
  if (sessionTotal <= 0) return null;
  return ceilMulDiv(paid, 1, sessionTotal);
}

// ---- 회원 알림 문구 ---------------------------------------------------------------------------

const WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"] as const;

/** 「11/16 (월)」 — KST 달력 */
export function formatKstMonthDay(at: Temporal.Instant): string {
  const date = toKstDate(at);
  return `${date.month}/${date.day} (${WEEKDAY_KO[date.dayOfWeek - 1]})`;
}

const clock = (at: Temporal.Instant): string => formatTimeOfDay(toKstTimeOfDay(at));

/** 회차 한 번의 시간·장소 */
export type SessionSlot = { startsAt: Temporal.Instant; endsAt: Temporal.Instant; roomName: string };

/** 회원 알림·미리 보기에 같이 쓰는 문구 묶음(계약 11 §6-1 memberMessage) */
export type MemberMessage = { title: string; body: string; refundHint: string };

/** 시간·장소 변경 알림을 받은 회원이 환불을 요청할 수 있다는 안내(I34). 금액은 대표가 정한다 */
export const TIME_PLACE_REFUND_HINT = "이 시간에 못 오면 환불을 요청할 수 있어요";

/** 「20:30–21:30 A홀」 — 홀이 없으면 시간만. 날짜가 다르면 앞에 날짜를 붙인다 */
function slotText(slot: SessionSlot, withDate: boolean): string {
  const time = `${clock(slot.startsAt)}–${clock(slot.endsAt)}`;
  const parts = [withDate ? formatKstMonthDay(slot.startsAt) : "", time, slot.roomName].filter((p) => p !== "");
  return parts.join(" ");
}

/**
 * 시간·장소 변경 알림 문구(계약 11 §6-1 예시 그대로).
 *   둘 다 바뀜 → 「시간과 장소가 바뀌었어요」 · 시간만 → 「시간이 바뀌었어요」 · 장소만 → 「장소가 바뀌었어요」
 *   날짜까지 바뀌면 → 뒤쪽에도 날짜를 붙여 「11/16 (월) 20:30–21:30 A홀 → 11/17 (화) 21:00–22:00 B홀」
 */
export function timePlaceMessage(classTitle: string, before: SessionSlot, after: SessionSlot): MemberMessage {
  const timeChanged = !before.startsAt.equals(after.startsAt) || !before.endsAt.equals(after.endsAt);
  const roomChanged = before.roomName !== after.roomName;
  const what = timeChanged && roomChanged ? "시간과 장소가" : timeChanged ? "시간이" : "장소가";
  const dateChanged = !toKstDate(before.startsAt).equals(toKstDate(after.startsAt));
  const body = `${formatKstMonthDay(before.startsAt)} ${what} 바뀌었어요 · ${slotText(before, false)} → ${slotText(after, dateChanged)}`;
  return { title: `수업 변경 · ${classTitle}`, body, refundHint: TIME_PLACE_REFUND_HINT };
}

/** 휴강 알림 문구 — 회원이 7일 안에 옮기기·환불을 고른다(Q16) */
export function sessionCancelledMessage(classTitle: string, session: SessionSlot, reason: string, deadline: Temporal.Instant): MemberMessage {
  return {
    title: `휴강 · ${classTitle}`,
    body: `${formatKstMonthDay(session.startsAt)} ${clock(session.startsAt)} 수업이 휴강해요 · ${reason}`,
    refundHint: `${formatKstMonthDay(deadline)}까지 다른 회차로 옮기거나 환불을 골라 주세요. 고르지 않으면 환불돼요`,
  };
}

/** 폐강 알림 문구 — 이 회차부터 남은 회차가 모두 닫힌다. 옮길 회차가 없어 환불만 있다 */
export function classClosedMessage(classTitle: string, first: SessionSlot, sessionCount: number, reason: string): MemberMessage {
  return {
    title: `폐강 · ${classTitle}`,
    body: `${formatKstMonthDay(first.startsAt)}부터 남은 ${sessionCount}회 수업이 폐강돼요 · ${reason}`,
    refundHint: "남은 회차 금액은 환불돼요",
  };
}
