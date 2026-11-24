// S7-1.6(발송 재시도 작업) — 「기다림이 끝난 실패 알림을 다시 보내라」는 포트.
//   계약: _workspace/03_contracts/15-ops.md §1-4 retry(`POST /api/internal/jobs/notifications/retry`)
//
// 왜 NotificationSenderPort(§4.10)에 넣지 않았나: 그 포트는 업무 코드가 커밋 뒤 「이 id 들을 보내라」고 부르는 공유 계약이라
// 모양을 바꾸면 결제·취소 등 모든 호출처가 흔들린다. 재시도는 시간 작업 하나만 부르므로 따로 둔다.

/** 한 번 돌린 결과 건수(계약 응답 `{ retried, failed }` + 로그용 sent) */
export type NotificationRetryReport = {
  readonly retried: number;
  readonly sent: number;
  readonly failed: number;
};

export interface NotificationRetryPort {
  /** next_attempt_at 이 지난 retry_wait 행을 최대 limit 개 다시 보낸다 */
  retryDue(limit?: number): Promise<NotificationRetryReport>;
}
