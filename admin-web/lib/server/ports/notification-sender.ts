// T-M3-5(본인확인·알림 포트와 가짜 구현) — 공유 계약 §4.10(포트) NotificationSenderPort
//
// FR-114(결제 확인 앱 알림)·plan D7(알림 위치): 알림 **기록**은 트랜잭션 안에서
// `notifications` 행으로 남기고, **발송**은 커밋 뒤 이 포트로 한다. 발송은 외부 일이라
// 트랜잭션에 넣을 수 없기 때문이다.
//
// 옛 Python 포트는 회원·관리자 두 메서드였다. 지금은 수신자·종류가 행에 들어 있으므로
// 포트는 행 id 만 받는다. 발송 실패가 이미 커밋된 결제·환불을 되돌리면 안 되는 점은 같다 —
// 호출하는 쪽은 이 Promise 의 실패를 삼키지 말고 기록하되, 업무 결과를 뒤집지 않는다.

/** 공유 계약 §4.10 — 커밋 뒤 `notifications` 행을 발송한다. 1회차 Fake 는 기록만 한다 */
export interface NotificationSenderPort {
  deliver(notificationIds: readonly string[]): Promise<void>;
}
