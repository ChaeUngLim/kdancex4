// S7-1.1(SP-4 푸시 경로 조사) — 푸시 발송 포트. 알림 행(notifications)이 아니라 「기기 토큰에 메시지 몇 건」을 보낸다.
//
// 왜 NotificationSenderPort(§4.10)와 따로 두나: 그 포트는 「커밋된 알림 행 id 를 보내라」는 업무 단위이고,
// 이 포트는 그 아래 바깥 서비스(Expo 푸시 서비스) 한 번 부르기다. S7-1.5(발송 포트 실구현)가
// 알림 행 → 받는 사람 토큰 → 이 포트 순으로 잇는다. 이 Task 는 아래 포트와 Expo 형식 구현·가짜 서버까지만 만든다.

/** 기기 하나에 보낼 메시지. 토큰 값은 응답·로그에 내리지 않는다(앞 6자만) */
export type PushMessage = {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  /** 앱이 눌렀을 때 열 화면 등. 문자열만 담는다(개인정보는 넣지 않는다) */
  readonly data?: Readonly<Record<string, string>>;
};

/**
 * 메시지 한 건의 결과(보낸 순서와 같다).
 *   ok            — 푸시 서비스가 받았다(ticketId 로 나중에 영수증을 볼 수 있다)
 *   invalid_token — 그 기기는 더 이상 등록돼 있지 않다 → 토큰 줄을 닫는다(revokeInvalidPushTokens)
 *   error         — 보내지 못했다. retryable 이면 S7-1.6(발송 재시도 작업)이 나중에 다시 보낸다
 */
export type PushOutcome =
  | { readonly to: string; readonly status: "ok"; readonly ticketId: string }
  | { readonly to: string; readonly status: "invalid_token" }
  | { readonly to: string; readonly status: "error"; readonly code: string; readonly retryable: boolean };

export interface PushGatewayPort {
  send(messages: readonly PushMessage[]): Promise<readonly PushOutcome[]>;
}
