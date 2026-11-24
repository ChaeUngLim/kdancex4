// SX-1.5(Next.js 스트림 번역) — 에이전트 서버의 자체 SSE 이벤트를 AI SDK UI 스트림 조각으로 바꾼다.
//   계약: _workspace/03_contracts/16-ai-agent.md §3-2(에이전트 이벤트 10종) · §3-3(번역 표)
//   결정: CLAUDE-decisions.md ADR-005 — 에이전트 서버(Python)는 AI SDK 를 모르고, 번역은 Next.js 한 곳에서만 한다.
//
// 처음 보는 사람용 요약
// - 앱 화면은 AI SDK(`ai` 7.0.113)의 `useChat` 으로 만든다. `useChat` 은 `text-start`·`text-delta`·`finish`
//   같은 약속된 조각만 알아듣는다. 에이전트 서버는 `text{sentence}`·`done{metrics}` 같은 자기 이벤트를 보낸다.
// - 그 사이를 잇는 「통역」이 이 파일이다. 통역을 **순수 함수**(입력이 같으면 출력이 같고, 바깥을 건드리지 않음)로
//   떼어 둔 이유: 네트워크 없이 단위 테스트로 표 한 줄 한 줄을 확인할 수 있고, AI SDK 형식이 바뀌어도 여기만 고친다.
// - 상태(state)는 「글 상자를 열었나」「끝났나」 두 가지뿐이다. 함수는 상태를 고치지 않고 새 상태를 돌려준다.
import type { UIMessageChunk } from "ai";
import { z } from "zod";

import { sanitizeOfferingCardItems } from "../../domain/offering-card-action";

// ---- 에이전트 이벤트(계약 16 §3-2) — 들어오는 쪽의 모양을 zod 로 고정한다 ----------------------------

const tierSchema = z.enum(["T0", "T1", "T2", "T3"]);

/** 에이전트가 보내는 오류 코드 6종 + Next.js 가 스스로 만드는 연결 실패(MODEL_UNAVAILABLE 를 재사용) */
export const AGENT_ERROR_CODES = [
  "QUEUE_FULL",
  "T2_DAILY_LIMIT",
  "DEGRADED",
  "MODEL_UNAVAILABLE",
  "LANGUAGE_CHECK_FAILED",
  "NO_EVIDENCE",
] as const;
export const AGENT_FALLBACKS = ["human", "plain_search", "none"] as const;

const sourceItemSchema = z.object({
  kind: z.enum(["knowledge_item", "academy_notice", "refund_notice", "terms", "offering", "order", "reservation"]),
  id: z.string(),
  label: z.string(),
  version: z.number().int().optional(),
});

// 카드 항목 모양(§5-2)은 SX-4·SX-5 가 고정한다. 번역기는 항목을 그대로 넘기기만 하므로 객체인지만 본다
const cardItemSchema = z.record(z.string(), z.unknown());

/** 이벤트 이름 → data 모양. SSE 한 덩어리의 `event:` 줄이 이름, `data:` 줄이 JSON 이다 */
export const agentEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("queued"), data: z.object({ position: z.number().int(), etaSeconds: z.number() }) }),
  z.object({ event: z.literal("tier"), data: z.object({ tier: tierSchema }) }),
  z.object({
    event: z.literal("stage"),
    data: z.object({ name: z.enum(["conditions", "candidates", "writing"]) }),
  }),
  // 조건 칩 모양(§5-1)도 뒤 Task 가 채운다 — 여기서는 객체인지만 본다
  z.object({ event: z.literal("conditions"), data: z.record(z.string(), z.unknown()) }),
  z.object({ event: z.literal("text"), data: z.object({ sentence: z.string() }) }),
  z.object({ event: z.literal("sources"), data: z.object({ items: z.array(sourceItemSchema) }) }),
  z.object({
    event: z.literal("cards"),
    data: z.object({
      kind: z.enum(["offering_cards", "instructor_candidates", "recommendations"]),
      items: z.array(cardItemSchema),
    }),
  }),
  z.object({
    event: z.literal("handoff"),
    data: z.object({
      reason: z.enum(["sensitive", "low_confidence", "user_request"]),
      needsAcademyPick: z.boolean(),
    }),
  }),
  z.object({ event: z.literal("done"), data: z.object({ metrics: z.record(z.string(), z.unknown()) }) }),
  z.object({
    event: z.literal("error"),
    data: z.object({ code: z.enum(AGENT_ERROR_CODES), fallback: z.enum(AGENT_FALLBACKS) }),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
export type AgentFallback = (typeof AGENT_FALLBACKS)[number];

/** 에이전트가 약속 밖의 조각을 보냈다(모르는 이름·JSON 아님·모양 틀림). 받은 값은 메시지에 싣지 않는다 */
export class AgentStreamProtocolError extends Error {
  constructor(reason: string) {
    super(`에이전트 스트림 형식이 계약과 다르다: ${reason}`);
    this.name = "AgentStreamProtocolError";
  }
}

// ---- 번역 상태 -------------------------------------------------------------------------------

/**
 * 한 run 의 번역 상태. 바뀌지 않는 값으로만 다룬다(새 상태를 돌려받아 갈아 끼운다).
 *   textId   글 상자 id. run 하나에 글 상자 하나라 runId 로 만든다(다시 열어도 같은 id)
 *   textOpen `text-start` 를 이미 냈나 — 문장이 여러 개 와도 상자는 한 번만 연다
 *   finished `finish` 를 냈나 — 그 뒤에 오는 이벤트는 버린다(화면이 이미 끝난 답을 받았다)
 */
export type TranslateState = Readonly<{ textId: string; textOpen: boolean; finished: boolean }>;

export function initialTranslateState(runId: string): TranslateState {
  return { textId: `text-${runId}`, textOpen: false, finished: false };
}

export type Translation = Readonly<{ parts: readonly UIMessageChunk[]; state: TranslateState }>;

/** 열린 글 상자가 있으면 닫는 조각. `done`·`error` 앞에서 쓴다 — 닫지 않으면 화면이 「쓰는 중」으로 남는다 */
function closeText(state: TranslateState): Translation {
  if (!state.textOpen) return { parts: [], state };
  return { parts: [{ type: "text-end", id: state.textId }], state: { ...state, textOpen: false } };
}

/**
 * 이벤트 하나 → AI SDK 조각 여러 개(계약 16 §3-3 표 그대로).
 *   - 진행 표시(queued·tier·stage·conditions)는 `transient: true` — 화면 onData 에서만 받고 대화 기록에 안 남는다
 *   - 근거·카드·넘기기는 기록에 남긴다 — 대화를 다시 열어도 「근거 ›」 링크와 카드가 보이게
 *   - done 의 측정값은 스트림에 싣지 않는다(기록은 Next.js 가 DB 에 한다, FR-274(질문별 측정 기록))
 */
export function translateAgentEvent(event: AgentEvent, state: TranslateState): Translation {
  // 이미 끝난 답 뒤에 온 이벤트는 버린다 — finish 뒤 조각은 useChat 이 오류로 본다
  if (state.finished) return { parts: [], state };

  switch (event.event) {
    case "queued":
      return { parts: [{ type: "data-queued", data: event.data, transient: true }], state };
    case "tier":
      return { parts: [{ type: "data-tier", data: event.data, transient: true }], state };
    case "stage":
      return { parts: [{ type: "data-stage", data: event.data, transient: true }], state };
    case "conditions":
      return { parts: [{ type: "data-conditions", data: event.data, transient: true }], state };
    case "text": {
      // 첫 문장이면 상자를 먼저 열고, 문장 하나를 delta 하나로 보낸다(문장 단위 점진 표시, FR-262)
      const open: UIMessageChunk[] = state.textOpen ? [] : [{ type: "text-start", id: state.textId }];
      return {
        parts: [...open, { type: "text-delta", id: state.textId, delta: event.data.sentence }],
        state: { ...state, textOpen: true },
      };
    }
    case "sources":
      return { parts: [{ type: "data-sources", data: event.data }], state };
    case "cards": {
      // 수업 카드·추천 카드의 「신청하기」는 수업 상세로 가기뿐이다(SX-5.6 · FR-214(AI 쓰기 금지)).
      // 에이전트가 보낸 버튼 값은 믿지 않고 id 로 다시 만든다 — 예약·결제 값이 화면까지 가지 않게.
      if (event.data.kind === "instructor_candidates") return { parts: [{ type: "data-cards", data: event.data }], state };
      const items = sanitizeOfferingCardItems(event.data.items);
      return { parts: [{ type: "data-cards", data: { kind: event.data.kind, items } }], state };
    }
    case "handoff":
      return { parts: [{ type: "data-handoff", data: event.data }], state };
    case "done": {
      const closed = closeText(state);
      return { parts: [...closed.parts, { type: "finish" }], state: { ...closed.state, finished: true } };
    }
    case "error": {
      // 오류도 「답이 끝났다」로 닫는다 — 화면은 data-error 를 보고 대체 안내(사람 문의·일반 검색)를 띄운다
      const closed = closeText(state);
      return {
        parts: [...closed.parts, { type: "data-error", data: event.data }, { type: "finish" }],
        state: { ...closed.state, finished: true },
      };
    }
  }
}

/**
 * 에이전트 스트림이 `done`·`error` 없이 끊겼을 때(서버 죽음·연결 끊김·시간 초과) 마무리 조각.
 * 이미 끝났으면 아무것도 내지 않는다. 대체 규칙(계약 16 §3-1)대로 플래너는 일반 검색, 문의는 사람에게.
 */
export function finishUnterminated(state: TranslateState, fallback: AgentFallback): Translation {
  return translateAgentEvent({ event: "error", data: { code: "MODEL_UNAVAILABLE", fallback } }, state);
}

// ---- SSE 읽기 -------------------------------------------------------------------------------

/**
 * SSE 한 덩어리(빈 줄로 끝나는 `event:`·`data:` 줄 묶음)를 이벤트로 바꾼다.
 * `data:` 가 여러 줄이면 줄바꿈으로 잇는다(SSE 규칙). 주석 줄(`:` 로 시작, 연결 유지용)은 무시한다.
 * 빈 덩어리면 null.
 */
export function parseSseBlock(block: string): AgentEvent | null {
  let name: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // 「필드: 값」에서 콜론 뒤 공백 한 칸은 규칙상 지운다
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }
  if (name === null && dataLines.length === 0) return null;
  if (name === null) throw new AgentStreamProtocolError("event 줄이 없다");

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new AgentStreamProtocolError(`${name} 의 data 가 JSON 이 아니다`);
  }
  const parsed = agentEventSchema.safeParse({ event: name, data });
  if (!parsed.success) throw new AgentStreamProtocolError(`${name} 이벤트 모양이 다르다`);
  return parsed.data;
}

/**
 * 바이트 스트림 → 에이전트 이벤트를 하나씩 꺼낸다. 네트워크 조각은 덩어리 경계와 상관없이 잘려 오므로,
 * 빈 줄(`\n\n`)이 나올 때까지 모아 두었다가 한 덩어리씩 넘긴다.
 */
export async function* readAgentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = parseSseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== null) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    // 끝에 빈 줄 없이 남은 마지막 덩어리도 처리한다
    const last = parseSseBlock(buffer);
    if (last !== null) yield last;
  } finally {
    reader.releaseLock();
  }
}
