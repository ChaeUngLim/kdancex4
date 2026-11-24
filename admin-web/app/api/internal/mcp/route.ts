// SX-5.8(말로 찾기 실동작) — `POST /api/internal/mcp`(계약 16 §6). 에이전트 서버만 부르는 읽기 도구 문.
// 잠금(X-Internal-Token + 질문 토큰)과 호출 상한은 lib/server/ai/mcp-http-route.ts, 도구는 lib/server/ai/read-tools.ts.
import { createMcpHttpRoute } from "@/lib/server/ai/mcp-http-route";
import { systemClock } from "@/lib/domain/time";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const handler = createMcpHttpRoute({
  readDeps: { db, clock: systemClock },
  sessionSecret: () => process.env["AGENT_SESSION_SECRET"]?.trim() ?? "",
  nowEpochSeconds: () => Math.floor(Date.now() / 1000),
});

// POST 하나만 연다(계약 16 §6). 세션 없이(stateless) 답하므로 MCP 의 GET(서버 알림 스트림)·DELETE(세션 닫기)는 쓸 일이 없다 —
// 에이전트의 MCP 클라이언트는 세션 id 를 받지 못하면 둘 다 부르지 않는다. 열어 두지 않으면 Next.js 가 405 로 막는다.
export const POST = (request: Request) => handler(request, undefined);
