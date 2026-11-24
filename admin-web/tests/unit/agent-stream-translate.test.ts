// SX-1.5(Next.js 스트림 번역) — 에이전트 이벤트 → AI SDK UI 스트림 번역(계약 16 §3-3 · ADR-005).
//   ① 순수 함수 translateAgentEvent 가 표 10줄을 그대로 지킨다 — 모든 조각이 설치본 `ai` 의 uiMessageChunkSchema 를 통과
//   ② SSE 읽기가 네트워크 조각 경계와 무관하게 이벤트를 꺼내고, 약속 밖 조각은 오류로 알린다
//   ③ POST /api/ai/chat 처리기가 가짜 에이전트의 스트림을 v1 UI 스트림으로 흘리고, 에이전트가 없으면 대체 안내로 닫는다
import { createHmac } from "node:crypto";

import { uiMessageChunkSchema, type UIMessageChunk } from "ai";
import { describe, expect, test } from "vitest";

import {
  AgentStreamProtocolError,
  finishUnterminated,
  initialTranslateState,
  parseSseBlock,
  readAgentEvents,
  translateAgentEvent,
  type AgentEvent,
  type TranslateState,
} from "../../lib/server/ai/agent-stream-translate";
import { AGENT_SESSION_TOKEN_TTL_SECONDS, signAgentSessionToken } from "../../lib/server/ai/agent-session-token";
import { createAiChatRoute, type AgentChatClient, type AgentChatStreamRequest } from "../../lib/server/ai/ai-chat-route";
import { HttpError } from "../../lib/server/http";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TEXT_ID = `text-${RUN_ID}`;

/** 이벤트 목록을 차례로 번역해 나온 조각 전부 */
function translateAll(events: readonly AgentEvent[], start: TranslateState = initialTranslateState(RUN_ID)) {
  let state = start;
  const parts: UIMessageChunk[] = [];
  for (const event of events) {
    const result = translateAgentEvent(event, state);
    state = result.state;
    parts.push(...result.parts);
  }
  return { parts, state };
}

/** 설치본 AI SDK 가 받아들이는 조각인지 — useChat 이 실제로 쓰는 검증기로 본다 */
async function expectValidChunks(parts: readonly unknown[]) {
  const schema = uiMessageChunkSchema();
  for (const part of parts) {
    const result = await schema.validate!(part);
    expect(result.success, JSON.stringify(part)).toBe(true);
  }
}

// 계약 16 §3-2 예시 값을 그대로 쓴 이벤트 10종
const EVENTS = {
  queued: { event: "queued", data: { position: 3, etaSeconds: 25 } },
  tier: { event: "tier", data: { tier: "T2" } },
  stage: { event: "stage", data: { name: "candidates" } },
  conditions: { event: "conditions", data: { instructor: { name: "이준호", id: null }, weekdays: ["sat", "sun"] } },
  text1: { event: "text", data: { sentence: "이준호 강사님 수업은 두 개예요." } },
  text2: { event: "text", data: { sentence: "토요일 오전 살사 입문이 있어요." } },
  sources: { event: "sources", data: { items: [{ kind: "academy_notice", id: "n1", label: "쌈바(입문) 준비물", version: 2 }] } },
  // 카드 항목은 id 두 개가 uuid 여야 번역기를 지난다(SX-5.6 — 버튼 값은 id 로 다시 만든다)
  cards: {
    event: "cards",
    data: {
      kind: "offering_cards",
      items: [
        {
          offeringId: "33333333-3333-4333-8333-333333333333",
          classId: "44444444-4444-4444-8444-444444444444",
          action: {
            type: "open_offering",
            offeringId: "33333333-3333-4333-8333-333333333333",
            classId: "44444444-4444-4444-8444-444444444444",
          },
        },
      ],
    },
  },
  handoff: { event: "handoff", data: { reason: "low_confidence", needsAcademyPick: true } },
  done: { event: "done", data: { metrics: { tier: "T2", totalMs: 9400, modelCalls: 2 } } },
  error: { event: "error", data: { code: "QUEUE_FULL", fallback: "human" } },
} as const satisfies Record<string, AgentEvent>;

describe("① translateAgentEvent — 계약 16 §3-3 번역 표", () => {
  test("진행 표시 4종(queued·tier·stage·conditions)은 transient data 조각이 된다", async () => {
    const { parts } = translateAll([EVENTS.queued, EVENTS.tier, EVENTS.stage, EVENTS.conditions]);
    expect(parts).toEqual([
      { type: "data-queued", data: EVENTS.queued.data, transient: true },
      { type: "data-tier", data: EVENTS.tier.data, transient: true },
      { type: "data-stage", data: EVENTS.stage.data, transient: true },
      { type: "data-conditions", data: EVENTS.conditions.data, transient: true },
    ]);
    await expectValidChunks(parts);
  });

  test("text 는 상자를 한 번만 열고 문장마다 delta 하나, done 앞에서 닫고 finish", async () => {
    const { parts, state } = translateAll([EVENTS.text1, EVENTS.text2, EVENTS.done]);
    expect(parts).toEqual([
      { type: "text-start", id: TEXT_ID },
      { type: "text-delta", id: TEXT_ID, delta: EVENTS.text1.data.sentence },
      { type: "text-delta", id: TEXT_ID, delta: EVENTS.text2.data.sentence },
      { type: "text-end", id: TEXT_ID },
      { type: "finish" },
    ]);
    expect(state.finished).toBe(true);
    await expectValidChunks(parts);
  });

  test("근거·카드·넘기기는 기록에 남는(transient 없음) data 조각, done 의 측정값은 스트림에 안 싣는다", async () => {
    const { parts } = translateAll([EVENTS.sources, EVENTS.cards, EVENTS.handoff, EVENTS.done]);
    expect(parts).toEqual([
      { type: "data-sources", data: EVENTS.sources.data },
      { type: "data-cards", data: EVENTS.cards.data },
      { type: "data-handoff", data: EVENTS.handoff.data },
      { type: "finish" },
    ]);
    expect(JSON.stringify(parts)).not.toContain("totalMs");
    await expectValidChunks(parts);
  });

  test("error 는 열린 글 상자를 닫고 data-error → finish", async () => {
    const { parts } = translateAll([EVENTS.text1, EVENTS.error]);
    expect(parts.slice(-3)).toEqual([
      { type: "text-end", id: TEXT_ID },
      { type: "data-error", data: EVENTS.error.data },
      { type: "finish" },
    ]);
    await expectValidChunks(parts);
  });

  test("finish 뒤에 온 이벤트는 버리고, 입력 상태는 바꾸지 않는다(불변)", () => {
    const start = initialTranslateState(RUN_ID);
    const { parts } = translateAll([EVENTS.done, EVENTS.text1, EVENTS.error], start);
    expect(parts).toEqual([{ type: "finish" }]);
    expect(start).toEqual({ textId: TEXT_ID, textOpen: false, finished: false });
  });

  test("done·error 없이 끊기면 MODEL_UNAVAILABLE + 대체 방향으로 닫고, 이미 끝났으면 아무것도 안 낸다", () => {
    const open = translateAll([EVENTS.text1]).state;
    expect(finishUnterminated(open, "plain_search").parts).toEqual([
      { type: "text-end", id: TEXT_ID },
      { type: "data-error", data: { code: "MODEL_UNAVAILABLE", fallback: "plain_search" } },
      { type: "finish" },
    ]);
    const done = translateAll([EVENTS.done]).state;
    expect(finishUnterminated(done, "human").parts).toEqual([]);
  });
});

// ---- ② SSE 읽기 ------------------------------------------------------------------------------

const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** 글을 정해진 크기로 잘라 바이트 스트림으로 — 네트워크가 덩어리 중간에서 끊어 보내는 상황 */
function chunkedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("② SSE 읽기 — parseSseBlock · readAgentEvents", () => {
  test("3바이트씩 잘려 와도(한글 글자 중간 포함) 이벤트를 순서대로 꺼낸다. 주석 줄은 무시", async () => {
    const body = `: keep-alive\n\n${sse("tier", EVENTS.tier.data)}${sse("text", EVENTS.text1.data)}${sse("done", EVENTS.done.data)}`;
    const events = await collect(readAgentEvents(chunkedStream(body, 3)));
    expect(events).toEqual([EVENTS.tier, EVENTS.text1, EVENTS.done]);
  });

  test("끝에 빈 줄이 없는 마지막 덩어리도 읽는다", async () => {
    const body = `event: text\ndata: ${JSON.stringify(EVENTS.text1.data)}`;
    expect(await collect(readAgentEvents(chunkedStream(body, 7)))).toEqual([EVENTS.text1]);
  });

  test.each([
    ["모르는 이벤트 이름", "event: secret\ndata: {}"],
    ["JSON 이 아닌 data", "event: text\ndata: {oops"],
    ["모양이 다른 data", 'event: tier\ndata: {"tier":"T9"}'],
    ["event 줄 없음", 'data: {"sentence":"x"}'],
  ])("%s 는 AgentStreamProtocolError", (_label, block) => {
    expect(() => parseSseBlock(block)).toThrow(AgentStreamProtocolError);
  });
});

// ---- ③ POST /api/ai/chat 처리기 -------------------------------------------------------------

const BODY = {
  conversationId: null,
  context: { kind: "planner", academyId: null, offeringId: null, instructorId: null },
  message: "이준호 강사님의 라틴하우스 강남 수업 모두 알려줘",
};

function fakeAgent(events: readonly AgentEvent[], seen: AgentChatStreamRequest[] = []): AgentChatClient {
  return {
    async streamChat(request) {
      seen.push(request);
      return (async function* () {
        yield* events;
      })();
    },
  };
}

function makeRoute(agent: AgentChatClient | null, requireMember = async () => ({ authUserId: "u1", memberId: MEMBER_ID })) {
  return createAiChatRoute({
    requireMember,
    agent,
    newRunId: () => RUN_ID,
    issueAgentSessionToken: ({ memberId, runId }) => `token-for-${memberId}-${runId}`,
  });
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ai/chat", { method: "POST", body: JSON.stringify(body) });

/** 응답 SSE(`data: {json}`)를 조각 배열로. `[DONE]` 끝 표시는 뺀다 */
async function readUiChunks(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((line) => line !== "" && line !== "[DONE]")
    .map((line) => JSON.parse(line) as unknown);
}

describe("③ POST /api/ai/chat — 번역해 흘리는 경로", () => {
  test("에이전트 이벤트가 v1 UI 스트림으로 나가고 헤더에 run id 가 실린다. 에이전트에 토큰·25초 기한을 넘긴다", async () => {
    const seen: AgentChatStreamRequest[] = [];
    const route = makeRoute(fakeAgent([EVENTS.tier, EVENTS.stage, EVENTS.text1, EVENTS.sources, EVENTS.done], seen));
    const response = await route(post(BODY), undefined);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-ai-run-id")).toBe(RUN_ID);

    const chunks = await readUiChunks(response);
    // 처리기가 맨 앞에 start 를 붙인다. 그 뒤가 번역 결과 그대로다
    expect(chunks.map((c) => (c as { type: string }).type)).toEqual([
      "start",
      "data-tier",
      "data-stage",
      "text-start",
      "text-delta",
      "data-sources",
      "text-end",
      "finish",
    ]);
    await expectValidChunks(chunks);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      runId: RUN_ID,
      message: BODY.message,
      context: BODY.context,
      degraded: false,
      deadlineMs: 25_000,
      agentSessionToken: `token-for-${MEMBER_ID}-${RUN_ID}`,
    });
  });

  test("에이전트 설정이 없으면(꺼짐) 플래너는 plain_search 대체 안내로 바로 닫는다", async () => {
    const chunks = await readUiChunks(await makeRoute(null)(post(BODY), undefined));
    expect(chunks).toEqual([
      { type: "start", messageId: `msg-${RUN_ID}` },
      { type: "data-error", data: { code: "MODEL_UNAVAILABLE", fallback: "plain_search" } },
      { type: "finish" },
    ]);
  });

  test("에이전트 연결이 터지면 학원 문의(inquiry)는 사람에게(human) 넘기는 안내로 닫는다", async () => {
    const broken: AgentChatClient = {
      async streamChat() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8100");
      },
    };
    const body = { ...BODY, context: { ...BODY.context, kind: "inquiry", academyId: MEMBER_ID } };
    const chunks = await readUiChunks(await makeRoute(broken)(post(body), undefined));
    expect(chunks.at(-2)).toEqual({ type: "data-error", data: { code: "MODEL_UNAVAILABLE", fallback: "human" } });
    expect(JSON.stringify(chunks)).not.toContain("ECONNREFUSED");
  });

  test.each([
    ["빈 질문", { ...BODY, message: "   " }],
    ["501자 질문", { ...BODY, message: "가".repeat(501) }],
    ["모르는 칸(memberId)", { ...BODY, memberId: MEMBER_ID }],
    ["모르는 kind", { ...BODY, context: { ...BODY.context, kind: "staff" } }],
  ])("%s 는 422 VALIDATION_FAILED 이고 에이전트를 부르지 않는다", async (_label, body) => {
    const seen: AgentChatStreamRequest[] = [];
    const response = await makeRoute(fakeAgent([EVENTS.done], seen))(post(body), undefined);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    expect(seen).toHaveLength(0);
  });

  test("회원 가드가 막으면(세션 없음) 그 응답(401) 그대로", async () => {
    const route = makeRoute(fakeAgent([EVENTS.done]), async () => {
      throw new HttpError("UNAUTHENTICATED", "로그인이 필요해요");
    });
    expect((await route(post(BODY), undefined)).status).toBe(401);
  });
});

describe("신원 토큰 agentSessionToken(계약 16 §3-1 4번)", () => {
  test("본문 클레임은 kind·sub·runId·exp(=지금+120초)이고, 같은 키로 서명을 다시 만들면 일치한다", () => {
    const token = signAgentSessionToken({ secret: "s3cret", memberId: MEMBER_ID, runId: RUN_ID, nowEpochSeconds: 1_000 });
    const [body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(body!, "base64url").toString("utf8"))).toEqual({
      kind: "member",
      sub: MEMBER_ID,
      runId: RUN_ID,
      exp: 1_000 + AGENT_SESSION_TOKEN_TTL_SECONDS,
    });
    expect(signature).toBe(createHmac("sha256", "s3cret").update(body!).digest("base64url"));
    // 다른 키로는 같은 서명이 나오지 않는다
    expect(signAgentSessionToken({ secret: "other", memberId: MEMBER_ID, runId: RUN_ID, nowEpochSeconds: 1_000 })).not.toBe(token);
  });
});

describe("HTTP 연결 createHttpAgentChatClient — 실제 소켓으로 SSE 를 받는다", () => {
  test("X-Agent-Token 을 싣고 /v1/chat/stream 의 SSE 를 이벤트로 바꾼다. 200 이 아니면 형식 오류", async () => {
    const { createServer } = await import("node:http");
    const { createHttpAgentChatClient } = await import("../../lib/server/ai/agent-chat-client");
    const seen: { path?: string; token?: string; body?: string } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        Object.assign(seen, { path: req.url, token: req.headers["x-agent-token"], body });
        if (req.headers["x-agent-token"] !== "agent-token") {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(sse("tier", EVENTS.tier.data));
        res.end(sse("done", EVENTS.done.data));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const request: AgentChatStreamRequest = {
      runId: RUN_ID,
      context: { kind: "planner", academyId: null, offeringId: null, instructorId: null },
      message: "질문",
      degraded: false,
      deadlineMs: 25_000,
      agentSessionToken: "t",
    };
    try {
      const good = createHttpAgentChatClient({ baseUrl: `http://127.0.0.1:${port}`, apiToken: "agent-token" });
      const events = await collect(await good.streamChat(request, AbortSignal.timeout(5_000)));
      expect(events).toEqual([EVENTS.tier, EVENTS.done]);
      expect(seen.path).toBe("/v1/chat/stream");
      expect(JSON.parse(seen.body!)).toEqual(request);

      const bad = createHttpAgentChatClient({ baseUrl: `http://127.0.0.1:${port}`, apiToken: "wrong" });
      await expect(bad.streamChat(request, AbortSignal.timeout(5_000))).rejects.toThrow(AgentStreamProtocolError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
