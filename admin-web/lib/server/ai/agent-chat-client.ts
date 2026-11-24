// SX-1.5(Next.js 스트림 번역) — 에이전트 서버 `POST /v1/chat/stream`(계약 16 §1-4 · §3-2)을 HTTP 로 부르는 연결.
// 서버 대 서버 증명은 헤더 `X-Agent-Token`(환경 변수 AGENT_API_TOKEN). 응답 SSE 는 readAgentEvents 가 이벤트로 바꾼다.
import type { AgentChatClient, AgentChatStreamRequest } from "./ai-chat-route";
import { AgentStreamProtocolError, readAgentEvents, type AgentEvent } from "./agent-stream-translate";

export function createHttpAgentChatClient(config: { baseUrl: string; apiToken: string }): AgentChatClient {
  return {
    async streamChat(request: AgentChatStreamRequest, signal: AbortSignal): Promise<AsyncIterable<AgentEvent>> {
      const response = await fetch(new URL("/v1/chat/stream", config.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Agent-Token": config.apiToken,
        },
        body: JSON.stringify(request),
        signal,
      });
      // 200 + SSE 가 아니면 번역할 것이 없다 — 호출한 쪽이 대체 규칙으로 닫는다
      if (!response.ok || response.body === null) {
        throw new AgentStreamProtocolError(`에이전트 응답 상태 ${response.status}`);
      }
      return readAgentEvents(response.body);
    },
  };
}
