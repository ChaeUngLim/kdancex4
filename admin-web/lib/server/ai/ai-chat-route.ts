// SX-1.5(Next.js 스트림 번역) — `POST /api/ai/chat`(계약 16 §3 · §3-1 · §3-3)의 처리기.
//
// 흐름(계약 16 §3-1 중 이 Task 가 하는 칸)
//   ① 세션 → 회원(401 UNAUTHENTICATED · 403 SIGNUP_INCOMPLETE) ② 본문 검증(422)
//   ③ run id·신원 토큰 만들기 ⑤ 에이전트 서버 `POST /v1/chat/stream` 호출 → 이벤트를 AI SDK UI 스트림으로 번역해 내보냄
// 이 Task 가 아직 하지 않는 칸(뒤 SX Task 몫, 증거 EVIDENCE.md 에 적음):
//   ② 대화·질문 저장(ai_conversations·ai_messages) ③ ai_runs 기록·진행 중 run 취소 ⑥ T2 하루 횟수 ⑦ done 기록 ⑧ 끊김 취소 호출
// SX-5.5(시간 초과 때 일반 검색으로 대체)가 더한 칸: 첫 이벤트 기한·전체 기한(설정값, loadAiChatDeadlines)을 재고,
//   넘기거나 에이전트가 안 되면 플래너는 일반 검색 결과(planner-plain-search.ts)로 닫는다. 학원 문의는 그대로 사람에게.
// SX-4.3(시간 초과 대체)가 더한 칸: 추천 고르기 중에 멈추면 ① 에이전트가 보낸 조건이 있으면 그 조건으로 필터 검색
//   ② 수업 카드가 이미 나갔으면 다시 찾지 않고 안내와 닫기만(FR-041(추천 시간 초과 대체)).
//
// 왜 이렇게 나눴나: 번역 자체는 agent-stream-translate.ts 의 순수 함수가 하고, 이 파일은 「누가 묻나」와
// 「어디서 받아 어디로 흘리나」만 잇는다. 에이전트 연결은 deps 로 받아, 테스트는 가짜 에이전트로 돌린다.
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import type { MemberContext } from "../guards";
import { CLASS_TARGET_LEVELS, GENRES } from "../../domain/constants";
import { buildNoResultReply, type SearchConditions } from "../../domain/offering-no-result";
import { WEEKDAYS } from "../../domain/recurring-schedule";
import { parseJsonBody, withRoute } from "../http";
import { plainSearchChunks, type PlainSearchReason, type PlainSearchReply } from "./planner-plain-search";
import {
  finishUnterminated,
  initialTranslateState,
  translateAgentEvent,
  type AgentEvent,
  type AgentFallback,
  type TranslateState,
} from "./agent-stream-translate";

/** 전체 응답 시간 상한 기본값(계약 16 §3-1 대체 규칙 「전체 25초」, SC-041) */
export const AI_CHAT_DEADLINE_MS = 25_000;

/**
 * 제한 시간 두 가지(SX-5.5 — 「제한 시간은 설정값으로 둔다」).
 *   firstEventMs 에이전트가 첫 이벤트(queued·tier·stage 등 무엇이든)를 줄 때까지 기다리는 시간. 넘기면 모델이 막힌 것으로 본다
 *   totalMs      답 전체를 기다리는 시간. 에이전트에도 deadlineMs 로 같은 값을 알려 준다
 */
export type AiChatDeadlines = Readonly<{ firstEventMs: number; totalMs: number }>;

/** 추천값(계약 16 열린 점 ⑱): 첫 이벤트 1.5초(SC-046 의 1초 표시 + 번역 여유 0.5초) · 전체 25초(SC-041) */
export const DEFAULT_AI_CHAT_DEADLINES: AiChatDeadlines = { firstEventMs: 1_500, totalMs: AI_CHAT_DEADLINE_MS };

const deadlineMs = z.coerce.number().int().positive();

/**
 * 환경 변수 AI_CHAT_FIRST_EVENT_TIMEOUT_MS · AI_CHAT_TOTAL_TIMEOUT_MS 에서 기한을 읽는다.
 * 비우면 추천값, 양의 정수가 아니거나 첫 이벤트 기한이 전체보다 길면 바로 예외 — 잘못된 설정으로 뜨지 않게(rate-limit.ts 와 같은 방식).
 */
export function loadAiChatDeadlines(env: Record<string, string | undefined> = process.env): AiChatDeadlines {
  const read = (key: string, fallback: number): number => {
    const raw = env[key];
    return raw === undefined || raw.trim() === "" ? fallback : deadlineMs.parse(raw.trim());
  };
  const firstEventMs = read("AI_CHAT_FIRST_EVENT_TIMEOUT_MS", DEFAULT_AI_CHAT_DEADLINES.firstEventMs);
  const totalMs = read("AI_CHAT_TOTAL_TIMEOUT_MS", DEFAULT_AI_CHAT_DEADLINES.totalMs);
  if (firstEventMs > totalMs) throw new Error("AI_CHAT_FIRST_EVENT_TIMEOUT_MS 가 AI_CHAT_TOTAL_TIMEOUT_MS 보다 길다");
  return { firstEventMs, totalMs };
}

/** 기한·끊김으로 멈췄다는 표시. 원인은 abortReason 변수에 따로 적는다 */
class AgentWaitAborted extends Error {
  constructor() {
    super("에이전트 기다림을 멈췄다");
    this.name = "AgentWaitAborted";
  }
}

/** 신호가 오면 거부되는 약속. 기다리는 쪽과 경주(race)시켜 「영원히 안 오는 이벤트」에서 빠져나온다 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new AgentWaitAborted());
    else signal.addEventListener("abort", () => reject(new AgentWaitAborted()), { once: true });
  });
  // 아무도 기다리지 않을 때 「처리 안 된 거부」 경고가 나지 않게 해 둔다
  promise.catch(() => undefined);
  return promise;
}

/**
 * 이벤트를 하나씩 꺼내되, 신호가 오면 다음 이벤트를 기다리지 않고 곧바로 멈춘다.
 * 왜 필요한가: fetch 는 신호로 끊기지만, 연결 구현에 따라 next() 가 신호를 모른 채 계속 기다릴 수 있다.
 */
async function* untilAborted<T>(iterable: AsyncIterable<T>, aborted: Promise<never>): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done === true) {
        finished = true;
        return;
      }
      yield result.value;
    }
  } finally {
    // 중간에 멈췄으면 에이전트 스트림도 닫으라고 알린다(기다리지 않는다)
    if (!finished) void iterator.return?.()?.catch(() => undefined);
  }
}

// ---- 요청 계약(16 §3) -------------------------------------------------------------------------

const uuid = z.uuid();
const nameRef = z.strictObject({ name: z.string().trim().max(100).nullish(), id: uuid.nullish() });
const hhmmText = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);

/**
 * 이어 묻기(SX-5.8) — 앱이 앞 답에서 받은 조건(§5-1 열한 칸 + 「모집 중」만 보기)을 그대로 돌려보낸다.
 * 서버는 대화를 저장하지 않는다(대화 맥락은 앱 화면 안에서만). 모양만 보고 에이전트에 넘기며, 에이전트가 같은 모양으로 한 번 더 검사한다.
 */
export const previousConditionsSchema = z.strictObject({
  instructor: nameRef.nullish(),
  academy: nameRef.nullish(),
  genre: z.enum(GENRES).nullish(),
  weekdays: z.array(z.enum(WEEKDAYS)).max(7).nullish(),
  timeBand: z.union([z.enum(["morning", "afternoon", "evening"]), z.strictObject({ from: hhmmText, to: hhmmText })]).nullish(),
  level: z.enum(CLASS_TARGET_LEVELS).nullish(),
  regionSido: z.string().trim().min(1).max(50).nullish(),
  regionGu: z.string().trim().min(1).max(50).nullish(),
  maxPriceAmount: z.int().min(0).nullish(),
  dateFrom: z.iso.date().nullish(),
  dateTo: z.iso.date().nullish(),
  recruitOpenOnly: z.boolean().nullish(),
});

export const aiChatRequestSchema = z.strictObject({
  conversationId: uuid.nullable(),
  // 맥락 칸 안의 모르는 키는 지운다(z.object) — 에이전트에는 아래 네 칸만 넘어간다
  context: z.object({
    kind: z.enum(["planner", "inquiry"]),
    academyId: uuid.nullable(),
    offeringId: uuid.nullable(),
    instructorId: uuid.nullable(),
    // 이어 묻기(SX-5.8). 없으면 새 질문
    previousConditions: previousConditionsSchema.nullish(),
  }),
  // 1~500자. 앞뒤 공백만 있는 질문은 빈 질문으로 본다
  message: z.string().trim().min(1).max(500),
});
export type AiChatRequest = z.output<typeof aiChatRequestSchema>;

/** 에이전트 서버에 보내는 본문(계약 16 §3-2) */
export type AgentChatStreamRequest = Readonly<{
  runId: string;
  context: AiChatRequest["context"];
  message: string;
  degraded: boolean;
  deadlineMs: number;
  agentSessionToken: string;
}>;

/** 에이전트 연결. 실제 구현은 agent-chat-client.ts(HTTP), 테스트는 가짜 이벤트 목록 */
export interface AgentChatClient {
  streamChat(request: AgentChatStreamRequest, signal: AbortSignal): Promise<AsyncIterable<AgentEvent>>;
}

export type AiChatRouteDeps = Readonly<{
  requireMember: (request: Request) => Promise<MemberContext>;
  /** 에이전트 설정이 비어 있으면 null — 「에이전트 서버가 꺼져 있다」와 같게 즉시 대체 규칙으로 간다 */
  agent: AgentChatClient | null;
  newRunId: () => string;
  issueAgentSessionToken: (input: { memberId: string; runId: string }) => string;
  /** 제한 시간. 비우면 DEFAULT_AI_CHAT_DEADLINES */
  deadlines?: AiChatDeadlines;
  /**
   * 플래너의 일반 검색(SX-5.5). 운영은 DB 함수를 이은 runPlainSearch. null 이면 예전처럼 data-error 로 대체 방향만 알린다
   * (DB 없는 SX-1.5 번역 테스트용).
   */
  // agentConditions: 에이전트가 멈추기 전에 보낸 조건(conditions 이벤트 data, 없으면 null). 검사는 받는 쪽이 한다(SX-4.3)
  plainSearch?:
    | ((message: string, context: AiChatRequest["context"], agentConditions: unknown) => Promise<PlainSearchReply>)
    | null;
}>;

/** 대체 방향(계약 16 §3-1): 플래너는 일반 검색으로, 학원 문의는 사람에게 */
export function fallbackFor(kind: AiChatRequest["context"]["kind"]): AgentFallback {
  return kind === "planner" ? "plain_search" : "human";
}

export function createAiChatRoute(deps: AiChatRouteDeps) {
  const deadlines = deps.deadlines ?? DEFAULT_AI_CHAT_DEADLINES;
  return withRoute<unknown>(async (request) => {
    const { memberId } = await deps.requireMember(request);
    const input = await parseJsonBody(request, aiChatRequestSchema);
    const runId = deps.newRunId();
    const fallback = fallbackFor(input.context.kind);
    // 플래너이고 일반 검색이 이어져 있을 때만 일반 검색으로 대체한다
    const plainSearch = input.context.kind === "planner" ? (deps.plainSearch ?? null) : null;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // 답 한 건의 시작 표시. useChat 은 이 조각을 보고 assistant 메시지 하나를 새로 연다.
        // 메시지 id 는 run 에서 만든다 — 같은 run 의 답은 언제 다시 받아도 같은 id 다
        writer.write({ type: "start", messageId: `msg-${runId}` });
        let state: TranslateState = initialTranslateState(runId);

        // ---- 기한 재기(SX-5.5) ----
        // 두 타이머 중 먼저 울린 쪽이 이유를 적고 에이전트 호출을 멈춘다. 화면이 연결을 끊어도 멈춘다
        let reason: PlainSearchReason | null = null;
        const stopWaiting = new AbortController();
        const signal = AbortSignal.any([request.signal, stopWaiting.signal]);
        const aborted = rejectOnAbort(signal);
        const stopFor = (why: PlainSearchReason) => {
          reason ??= why;
          stopWaiting.abort();
        };
        const firstEventTimer = setTimeout(() => stopFor("first_event_timeout"), deadlines.firstEventMs);
        const totalTimer = setTimeout(() => stopFor("timeout"), deadlines.totalMs);
        let lastConditions: SearchConditions | null = null;
        let cardsShown = false;

        try {
          if (deps.agent === null) {
            reason = "agent_unavailable";
          } else {
            const events = await Promise.race([
              deps.agent.streamChat(
                {
                  runId,
                  context: input.context,
                  message: input.message,
                  degraded: false,
                  deadlineMs: deadlines.totalMs,
                  agentSessionToken: deps.issueAgentSessionToken({ memberId, runId }),
                },
                signal,
              ),
              aborted,
            ]);
            // 에이전트가 낸 마지막 조건 — 수업 카드가 0건이면 이 조건으로 결과 없음 버튼을 만든다(SX-5.8).
            // 시간이 넘으면 대체 검색도 이 조건으로 한다(SX-4.3)
            lastConditions = null;
            // 이벤트 하나씩 번역해 바로 흘린다 — 문장이 오는 대로 화면에 보이게(FR-262(진행 단계·점진 표시))
            for await (const event of untilAborted(events, aborted)) {
              // 첫 이벤트가 왔다 — 이제부터는 전체 기한만 본다
              clearTimeout(firstEventTimer);
              // 에이전트가 스스로 「일반 검색으로 바꿔 달라」고 하면(한국어 검사 실패 등, FR-266) 그 말을 따른다
              if (event.event === "error" && event.data.fallback === "plain_search" && plainSearch !== null) {
                reason = "agent_error";
                break;
              }
              if (event.event === "conditions") lastConditions = event.data as SearchConditions;
              const translated = translateAgentEvent(event, state);
              state = translated.state;
              for (const part of translated.parts) writer.write(part);
              // 에이전트 경로의 결과 없음(SX-5.4 와 같은 값) — 빈 수업 카드 뒤에 넓히기 버튼을 붙인다. 버튼은 Next.js 순수 함수가 만든다
              if (event.event === "cards" && event.data.kind === "offering_cards" && event.data.items.length === 0 && lastConditions !== null) {
                const reply = buildNoResultReply(lastConditions, []);
                if (reply !== null) writer.write({ type: "data-no-result", data: reply });
              }
              // 카드가 한 번이라도 나갔으면 대체 때 다시 찾지 않는다(SX-4.3)
              if (event.event === "cards") cardsShown = true;
              if (state.finished) break;
            }
          }
        } catch (error: unknown) {
          // 연결 실패·형식 위반·기한 초과. 원인은 서버 로그에만 남기고 화면에는 대체 안내만 보낸다
          if (!(error instanceof AgentWaitAborted)) console.error(`[ai-chat] run ${runId} 에이전트 스트림 실패`, error);
        } finally {
          clearTimeout(firstEventTimer);
          clearTimeout(totalTimer);
          // 남은 에이전트 호출을 정리한다(이미 끝났으면 아무 일도 없다)
          if (!state.finished) stopWaiting.abort();
        }
        if (state.finished) return;

        // done·error 없이 끝났다(서버 꺼짐·기한 초과·끊김). 이미 나간 조각은 되돌리지 않고 그 뒤에 잇는다.
        // 플래너는 일반 검색 결과로, 화면이 이미 떠났으면 검색하지 않는다
        if (plainSearch !== null && !request.signal.aborted) {
          // SX-4.3 — 추천 고르기 중에 멈췄어도 수업 카드가 이미 나갔으면 그 카드가 곧 필터 검색 결과다. 안내와 닫기만 잇는다
          if (cardsShown) {
            for (const part of plainSearchChunks({ kind: "cards_already_shown" }, reason ?? "agent_error", state).parts) writer.write(part);
            return;
          }
          try {
            // 화면이 정해 보낸 강사(context.instructorId — M15 입구·M10G 선택)도 넘긴다(SX-5.7)
            // 이어 묻기 중이면 앞 답의 강사도 정해진 강사로 쓴다(일반 검색은 이름만 보므로)
            const carried = input.context.previousConditions?.instructor?.id ?? null;
            // 에이전트가 조건까지 보냈으면 그 조건으로 찾는다(SX-4.3 — 이름 없는 추천 질문도 필터 검색 결과가 나오게)
            const reply = await plainSearch(
              input.message,
              { ...input.context, instructorId: input.context.instructorId ?? carried },
              lastConditions,
            );
            for (const part of plainSearchChunks(reply, reason ?? "agent_error", state).parts) writer.write(part);
            return;
          } catch (error: unknown) {
            console.error(`[ai-chat] run ${runId} 일반 검색 대체 실패`, error);
          }
        }
        for (const part of finishUnterminated(state, fallback).parts) writer.write(part);
      },
    });

    return createUIMessageStreamResponse({
      stream,
      headers: { "x-ai-run-id": runId, "Cache-Control": "private, no-store" },
    });
  });
}
