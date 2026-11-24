// SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변) — 일반 검색 대체가 아니라 「에이전트 경로」로 답할 때 Next.js 가 하는 일.
//
// ① 이어 묻기: 앱이 보낸 앞 답 조건(context.previousConditions)을 에이전트 요청에 그대로 싣는다. 모양이 틀리면 422.
// ② 에이전트가 빈 수업 카드를 보내면 SX-5.4 결과 없음 버튼(data-no-result)을 붙인다.
// ③ 에이전트가 안 될 때 일반 검색은 앞 답의 강사를 정해진 강사로 쓴다.
// ④ 읽기 도구 문(POST /api/internal/mcp): 내부 토큰 + 질문 토큰이 맞아야 열리고, 도구 목록은 읽기뿐이며, 질문 한 건에 8번까지만.
import { describe, expect, test } from "vitest";

import { signAgentSessionToken, verifyAgentSessionToken } from "../../lib/server/ai/agent-session-token";
import type { AgentEvent } from "../../lib/server/ai/agent-stream-translate";
import { createAiChatRoute, type AgentChatStreamRequest } from "../../lib/server/ai/ai-chat-route";
import { createMcpHttpRoute, MAX_TOOL_CALLS_PER_RUN } from "../../lib/server/ai/mcp-http-route";
import type { PlainSearchReply } from "../../lib/server/ai/planner-plain-search";

const JUNHO = "11111111-1111-4111-8111-111111111111";
const PREVIOUS = { instructor: { name: "이준호", id: JUNHO }, weekdays: ["sat", "sun"], recruitOpenOnly: null };

function chatRoute(events: AgentEvent[] | null, seen: AgentChatStreamRequest[] = [], plain?: (ctx: { instructorId: string | null }) => void) {
  return createAiChatRoute({
    requireMember: async () => ({ authUserId: "u1", memberId: "m1" }),
    agent:
      events === null
        ? null
        : {
            async streamChat(request) {
              seen.push(request);
              return (async function* () {
                yield* events;
              })();
            },
          },
    newRunId: () => "run-1",
    issueAgentSessionToken: () => "token",
    plainSearch: async (_message, context): Promise<PlainSearchReply> => {
      plain?.(context);
      return { kind: "need_name", sentence: "강사나 학원 이름을 넣어 다시 물어봐 주세요." } as unknown as PlainSearchReply;
    },
  });
}

async function post(route: ReturnType<typeof chatRoute>, context: Record<string, unknown>, message = "그중 토요일만") {
  const body = { conversationId: null, context: { kind: "planner", academyId: null, offeringId: null, instructorId: null, ...context }, message };
  const response = await route(
    new Request("http://localhost/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    undefined,
  );
  return { status: response.status, text: await response.text() };
}

describe("POST /api/ai/chat — 에이전트 경로", () => {
  test("이어 묻기 조건(previousConditions)을 에이전트 요청에 그대로 싣는다", async () => {
    const seen: AgentChatStreamRequest[] = [];
    const { status } = await post(chatRoute([{ event: "done", data: { metrics: {} } }], seen), { previousConditions: PREVIOUS });
    expect(status).toBe(200);
    expect(seen[0]?.context.previousConditions).toEqual(PREVIOUS);
    expect(seen[0]?.message).toBe("그중 토요일만");
  });

  test("앞 조건 모양이 틀리면(모르는 칸·틀린 요일) 422 — 에이전트를 부르지 않는다", async () => {
    const seen: AgentChatStreamRequest[] = [];
    const bad = await post(chatRoute([], seen), { previousConditions: { ...PREVIOUS, memberId: "x" } });
    const badDay = await post(chatRoute([], seen), { previousConditions: { weekdays: ["saturday"] } });
    expect([bad.status, badDay.status]).toEqual([422, 422]);
    expect(seen).toHaveLength(0);
  });

  test("빈 수업 카드가 오면 결과 없음 버튼(SX-5.4)을 붙이고, 문장은 에이전트 것 그대로다", async () => {
    const events: AgentEvent[] = [
      { event: "conditions", data: { ...PREVIOUS, weekdays: ["mon"] } },
      { event: "cards", data: { kind: "offering_cards", items: [] } },
      { event: "text", data: { sentence: "조건에 맞는 수업을 찾지 못했어요." } },
      { event: "done", data: { metrics: {} } },
    ];
    const { text } = await post(chatRoute(events), {});
    expect(text).toContain('"type":"data-no-result"');
    expect(text).toContain("이준호 강사님의 다른 수업 보기");
    expect(text).toContain('"delta":"조건에 맞는 수업을 찾지 못했어요."');
    expect(text).not.toContain("data-fallback");
  });

  test("수업 카드가 있으면 결과 없음 버튼을 붙이지 않는다", async () => {
    const events: AgentEvent[] = [
      { event: "conditions", data: PREVIOUS },
      { event: "cards", data: { kind: "instructor_candidates", items: [] } },
      { event: "done", data: { metrics: {} } },
    ];
    expect((await post(chatRoute(events), {})).text).not.toContain("data-no-result");
  });

  test("에이전트가 꺼져 있으면 일반 검색이 앞 답의 강사를 정해진 강사로 쓴다", async () => {
    const seen: { instructorId: string | null }[] = [];
    const { text } = await post(chatRoute(null, [], (ctx) => seen.push(ctx)), { previousConditions: PREVIOUS });
    expect(seen[0]?.instructorId).toBe(JUNHO);
    expect(text).toContain('"type":"data-fallback"');
  });
});

describe("질문 토큰 확인(verifyAgentSessionToken)", () => {
  const token = signAgentSessionToken({ secret: "s3cret", memberId: "m1", runId: "run-1", nowEpochSeconds: 1000 });
  test("서명·시간이 맞으면 클레임을 돌려준다", () => {
    expect(verifyAgentSessionToken(token, { secret: "s3cret", nowEpochSeconds: 1050 })).toEqual({ kind: "member", sub: "m1", runId: "run-1", exp: 1120 });
  });
  test("다른 키·시간 지남·본문 바꿔치기·빈 키는 null", () => {
    const [body, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ kind: "member", sub: "m2", runId: "run-1", exp: 9999 })).toString("base64url")}.${sig}`;
    expect(verifyAgentSessionToken(token, { secret: "other", nowEpochSeconds: 1050 })).toBeNull();
    expect(verifyAgentSessionToken(token, { secret: "s3cret", nowEpochSeconds: 1120 })).toBeNull();
    expect(verifyAgentSessionToken(forged, { secret: "s3cret", nowEpochSeconds: 1050 })).toBeNull();
    expect(verifyAgentSessionToken(`${body}`, { secret: "s3cret", nowEpochSeconds: 1050 })).toBeNull();
    expect(verifyAgentSessionToken(token, { secret: "", nowEpochSeconds: 1050 })).toBeNull();
  });
});

describe("POST /api/internal/mcp — 읽기 도구 문", () => {
  const now = 2000;
  const mcp = () =>
    createMcpHttpRoute({
      // 이 테스트는 DB 를 부르지 않는 요청만 보낸다(목록·없는 도구·상한)
      readDeps: { db: null as never, clock: { now: () => new Date() } as never },
      sessionSecret: () => "s3cret",
      nowEpochSeconds: () => now,
      env: { INTERNAL_API_TOKEN: "internal" },
    });
  const session = signAgentSessionToken({ secret: "s3cret", memberId: "m1", runId: "run-9", nowEpochSeconds: now });
  const rpc = (route: ReturnType<typeof mcp>, message: unknown, headers: Record<string, string>) =>
    route(
      new Request("http://localhost/api/internal/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(message),
      }),
      undefined,
    );
  const good = { "X-Internal-Token": "internal", Authorization: `Bearer ${session}` };

  test("내부 토큰이나 질문 토큰이 없거나 틀리면 401", async () => {
    const route = mcp();
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await rpc(route, list, { Authorization: `Bearer ${session}` })).status).toBe(401);
    expect((await rpc(route, list, { "X-Internal-Token": "internal" })).status).toBe(401);
    expect((await rpc(route, list, { "X-Internal-Token": "internal", Authorization: "Bearer nope.nope" })).status).toBe(401);
  });

  test("도구 목록은 계약의 읽기 도구뿐이고 모두 읽기 전용 표시가 있다(쓰기 0개, FR-214)", async () => {
    const response = await rpc(mcp(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, good);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["find_academies", "find_instructors", "search_offerings"]);
    expect(body.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  test("JSON-RPC 2.0 겉모양이 아니면 422 — 도구 서버까지 가지 않는다", async () => {
    const route = mcp();
    expect((await rpc(route, { id: 1, method: "tools/list" }, good)).status).toBe(422);
    expect((await rpc(route, "tools/list", good)).status).toBe(422);
    expect((await rpc(route, [], good)).status).toBe(422);
  });

  test(`질문 한 건(run)의 도구 호출은 ${MAX_TOOL_CALLS_PER_RUN}번까지 — 넘으면 TOOL_LIMIT`, async () => {
    const route = mcp();
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "reserve_seat", arguments: {} } });
    for (let i = 1; i <= MAX_TOOL_CALLS_PER_RUN; i += 1) {
      const text = await (await rpc(route, call(i), good)).text();
      // 목록 밖 이름(쓰기 도구 흉내)은 NOT_FOUND — 서버가 실행하지 않는다
      expect(text).toContain("NOT_FOUND");
    }
    const over = await (await rpc(route, call(99), good)).text();
    expect(over).toContain("TOOL_LIMIT");
  });
});
