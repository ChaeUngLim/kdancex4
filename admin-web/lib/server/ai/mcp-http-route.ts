// SX-5.8(말로 찾기 실동작) — 읽기 도구 서버의 HTTP 문 `POST /api/internal/mcp`(계약 16 §1-2 · §6, 층 B2).
//
// 처음 보는 사람용 요약
// - 에이전트 서버(Python)는 DB 를 보지 않는다. 수업·강사·학원이 필요하면 이 문으로 MCP 요청을 보내 읽기 도구를 부른다(ADR-004).
// - 문은 두 겹으로 잠근다.
//   ① `X-Internal-Token` — 「에이전트 서버가 보낸 요청」인지(서버 대 서버, withInternalRoute 가 상수 시간으로 비교)
//   ② `Authorization: Bearer <agentSessionToken>` — 「어느 회원의 어느 질문(run)인지」. Next.js 가 질문마다 서명해 준 토큰을
//      그대로 돌려받아 서명·유효 시간(120초)을 확인한다. 틀리면 401(계약 §6)
// - 질문 한 건(runId)에서 도구를 부를 수 있는 횟수를 8번으로 막는다(계약 §6 「폭주 방지」). 넘으면 `TOOL_LIMIT` 오류 결과.
// - 요청마다 도구 서버를 새로 만들고 세션 없이(stateless) 답한다. 기억할 상태가 없어 서버를 여러 대 띄워도 같다.
// - 도구 목록과 실행은 read-tools.ts 그대로다 — 전부 읽기, 쓰기 0개(FR-214(AI 쓰기 금지)).
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { HttpError } from "../http";
import { withInternalRoute } from "../internal-routes";
import { verifyAgentSessionToken, type AgentSessionClaims } from "./agent-session-token";
import { createReadToolServer, type ReadToolDeps } from "./read-tools";

/** 질문 한 건의 도구 호출 상한(계약 16 §6 추천값) */
export const MAX_TOOL_CALLS_PER_RUN = 8;

export type McpHttpRouteDeps = Readonly<{
  readDeps: ReadToolDeps;
  /** 토큰 서명 키(AGENT_SESSION_SECRET). 비어 있으면 모든 요청이 401 */
  sessionSecret: () => string;
  nowEpochSeconds: () => number;
  /** 테스트용 — 생략하면 process.env 에서 INTERNAL_API_TOKEN 을 읽는다 */
  env?: Readonly<Record<string, string | undefined>>;
}>;

type JsonRpcMessage = { method?: unknown; id?: unknown };

/**
 * 본문 겉모양 검사 — JSON-RPC 2.0 메시지 하나 또는 그 배열(MCP Streamable HTTP).
 * 도구 이름·인자 같은 속 내용은 MCP 도구 서버(read-tools.ts)가 도구마다 zod 로 다시 검사하므로 여기서는 겉모양만 본다.
 */
const jsonRpcMessageSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1).max(100).optional(),
  id: z.union([z.string(), z.number()]).nullish(),
});
export const mcpRequestBodySchema = z.union([jsonRpcMessageSchema, z.array(jsonRpcMessageSchema).min(1).max(20)]);

/** 본문 안의 tools/call 수(한 요청에 여러 메시지를 묶어 보낼 수도 있다) */
function countToolCalls(body: unknown): number {
  const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body as JsonRpcMessage];
  return messages.filter((m) => typeof m === "object" && m !== null && m.method === "tools/call").length;
}

/** 상한을 넘은 tools/call 에 돌려줄 결과 — 데이터는 담지 않고 코드만(계약 §6 오류 모양) */
function toolLimitResponse(body: unknown): Response {
  const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body as JsonRpcMessage];
  const results = messages
    .filter((m) => m.method === "tools/call")
    .map((m) => ({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "TOOL_LIMIT" }) }] } }));
  return Response.json(Array.isArray(body) ? results : results[0], { headers: { "Cache-Control": "no-store" } });
}

export function createMcpHttpRoute(deps: McpHttpRouteDeps) {
  // run 별 도구 호출 수. 토큰 유효 시간이 지난 run 은 지운다(메모리가 쌓이지 않게)
  const callsByRun = new Map<string, { count: number; exp: number }>();
  const forget = (now: number) => {
    for (const [runId, entry] of callsByRun) if (entry.exp <= now) callsByRun.delete(runId);
  };

  const handle = async (request: Request): Promise<Response> => {
    // ② 회원 질문 토큰 — 서명·시간이 맞아야 도구를 부를 수 있다
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const now = deps.nowEpochSeconds();
    const claims: AgentSessionClaims | null = token === "" ? null : verifyAgentSessionToken(token, { secret: deps.sessionSecret(), nowEpochSeconds: now });
    if (claims === null) throw new HttpError("UNAUTHENTICATED", "인증이 필요해요");

    let body: unknown = undefined;
    if (request.method === "POST") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        throw new HttpError("VALIDATION_FAILED", "요청 본문이 JSON 이 아니에요");
      }
      const parsed = mcpRequestBodySchema.safeParse(raw);
      if (!parsed.success) throw new HttpError("VALIDATION_FAILED", "MCP 요청 모양이 아니에요");
      body = parsed.data;
      const calls = countToolCalls(body);
      if (calls > 0) {
        forget(now);
        const entry = callsByRun.get(claims.runId) ?? { count: 0, exp: claims.exp };
        if (entry.count + calls > MAX_TOOL_CALLS_PER_RUN) return toolLimitResponse(body);
        callsByRun.set(claims.runId, { count: entry.count + calls, exp: claims.exp });
      }
    }

    // 요청마다 새 도구 서버 — 세션 없이(sessionIdGenerator 없음) JSON 으로 바로 답한다
    const server = createReadToolServer(deps.readDeps);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  };

  return withInternalRoute<unknown>((request) => handle(request), deps.env);
}
