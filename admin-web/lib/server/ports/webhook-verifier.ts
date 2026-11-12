// 공유 계약 §4.10(포트) — WebhookVerifier. T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식).
//
// FR-287(웹훅 확정) 처리의 1단계(계약 03 §6 1행)가 이 포트를 부른다. 서명이나 시각이 맞지 않으면
// false 를 돌려주고, 처리기는 401 `INVALID_SIGNATURE` + `rejected_signature` 기록으로 끝낸다.
// 검증은 파싱 전 **원문 문자열**로 한다 — JSON 을 다시 직렬화하면 바이트가 달라진다.
//
// 헤더 이름은 Standard Webhooks 모양이다. 포트원 V2 실제 서명 규격과 같은지는 미검증이다
// (research R-11 — SCH-29(PG 결제) 착수 때 확인). 다르면 구현만 바꾸면 된다(포트 뒤).

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export interface WebhookVerifier {
  /** 서명·시각이 모두 맞을 때만 true. 예외를 던지지 않는다 */
  verify(headers: Headers, rawBody: string, now: Temporal.Instant): boolean;
}
