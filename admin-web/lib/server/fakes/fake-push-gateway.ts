// S7-1.6(발송 재시도 작업) — HTTP 없이 도는 가짜 푸시 게이트웨이(PushGatewayPort).
//
// 모드 둘:
//   - "ok"          모든 메시지를 받았다고 답한다
//   - "always_fail" 모든 메시지에 오류(http_503, retryable)를 준다 — 「계속 실패하는 가짜 발송기」(로드맵 S7-1.6 verify)
// 받은 메시지는 순서대로 적어 둔다(테스트가 「몇 번 시도했나」를 센다). 토큰 값은 바깥에 찍지 않는다.
import type { PushGatewayPort, PushMessage, PushOutcome } from "../ports/push-gateway";

export type FakePushGatewayMode = "ok" | "always_fail";

export class FakePushGateway implements PushGatewayPort {
  #mode: FakePushGatewayMode;
  #sent: PushMessage[] = [];

  constructor(mode: FakePushGatewayMode = "ok") {
    this.#mode = mode;
  }

  /** 받은 메시지 기록(복사본) */
  get sent(): readonly PushMessage[] {
    return [...this.#sent];
  }

  /** 도중에 모드를 바꾼다 — 「두 번 실패하다 세 번째에 살아남」 같은 시험용 */
  setMode(mode: FakePushGatewayMode): void {
    this.#mode = mode;
  }

  async send(messages: readonly PushMessage[]): Promise<readonly PushOutcome[]> {
    this.#sent = [...this.#sent, ...messages];
    return messages.map((message, index) =>
      this.#mode === "ok"
        ? { to: message.to, status: "ok" as const, ticketId: `fake-ticket-${this.#sent.length - messages.length + index + 1}` }
        : { to: message.to, status: "error" as const, code: "http_503", retryable: true },
    );
  }
}
