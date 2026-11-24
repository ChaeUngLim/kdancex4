// S7-1.7(수업 전 알림 작업) — 수업 전 알림 시점 표와 알림 열쇠(순수 함수, DB·현재 시각을 읽지 않는다).
//   요구: FR-140(수업 전 알림 시점 — 하루 전·2시간 전·1시간 전·30분 전 중에서 고른다)
//   계약: _workspace/03_contracts/15-ops.md §1-4 `POST /api/internal/jobs/notifications/pre-class`
//
// 이 파일이 「시점 이름 → 몇 분 전」의 단일 원본이다. 작업(SQL)은 이 표를 JSON 으로 받아 쓰므로
// 시점이 새로 생기면 constants.ts 의 PRE_CLASS_LEADS 와 여기 한 줄만 고치면 된다(Record 라 빠뜨리면 타입 검사가 실패한다).
import "temporal-polyfill/full/global";

import type { PreClassLead } from "./constants";

/** 회원이 알림 설정을 한 번도 저장하지 않았을 때의 시점 — notification_settings 기본값과 같다(1시간 전) */
export const DEFAULT_PRE_CLASS_LEAD: PreClassLead = "one_hour";

/** 시점마다 수업 시작 몇 분 전에 알리나 */
export const PRE_CLASS_LEAD_MINUTES: Readonly<Record<PreClassLead, number>> = {
  day_before: 24 * 60,
  two_hours: 2 * 60,
  one_hour: 60,
  thirty_min: 30,
};

/** 작업이 훑는 범위(분) — 가장 이른 시점(하루 전)까지 앞을 봐야 그 회원의 알림을 놓치지 않는다(계약 「24시간 앞까지 훑는다」) */
export const PRE_CLASS_SCAN_MINUTES: number = Math.max(...Object.values(PRE_CLASS_LEAD_MINUTES));

/**
 * 알림 중복을 막는 열쇠 — `preclass:<sessionId>:<memberId>:<lead>`(계약 15 §1-4).
 * 작업이 몇 번 돌아도 같은 회차·회원·시점이면 같은 열쇠라 DB 유니크(uq_notifications_dedupe)가 1건만 남긴다.
 */
export function preClassDedupeKey(sessionId: string, memberId: string, lead: PreClassLead): string {
  return `preclass:${sessionId}:${memberId}:${lead}`;
}

/**
 * 이 회차 알림을 지금 만들 때인가. 「알릴 시각 ≤ 지금 < 수업 시작」이면 참이다.
 * 알릴 시각이 이미 지난 뒤에 예약한 회원(예: 하루 전으로 골랐는데 3시간 전에 결제)도 수업 전이면 한 번 받는다 —
 * 늦게라도 수업 전에 알려 주는 편이 아예 안 알리는 것보다 낫다고 봤다(EVIDENCE 추천안 2).
 */
export function isPreClassReminderDue(startsAt: Temporal.Instant, lead: PreClassLead, now: Temporal.Instant): boolean {
  const remindAt = startsAt.subtract({ minutes: PRE_CLASS_LEAD_MINUTES[lead] });
  return Temporal.Instant.compare(remindAt, now) <= 0 && Temporal.Instant.compare(now, startsAt) < 0;
}
