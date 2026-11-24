// SX-4.3(시간 초과 대체) — FR-041(추천 시간 초과 대체) · 계약 16 §3-1 「대체 규칙」.
//   추천(SX-4.2)은 조건 뽑기 → 검색 → 고르기(모델) 순으로 간다. 고르기에서 시간이 넘으면 회원은 빈 화면만 보게 된다.
//   이 파일은 그때 Next.js 가 「필터 기반 검색 결과」로 바꿔 주는지를 본다.
//   ① 에이전트가 조건(conditions)을 이미 보냈으면 그 조건 그대로 검색한다(질문 글자에서 이름만 찾는 SX-5.5 경로보다 앞선다)
//   ② 조건이 검색 입력 규칙(계약 16 §5-1)에 안 맞으면 SX-5.5 이름 검색으로 돌아간다
//   ③ 수업 카드가 이미 나갔으면 다시 찾지 않는다 — 같은 카드가 두 번 붙지 않게, 안내 문장과 닫기만
import { uiMessageChunkSchema } from "ai";
import { describe, expect, test } from "vitest";

import type { AgentEvent } from "../../lib/server/ai/agent-stream-translate";
import { createAiChatRoute, type AgentChatClient, type AiChatDeadlines, type AiChatRequest } from "../../lib/server/ai/ai-chat-route";
import {
  PLAIN_SEARCH_NEED_NAME,
  PLAIN_SEARCH_NOTICE,
  runPlainSearch,
  type PlainSearchFinders,
} from "../../lib/server/ai/planner-plain-search";
import type { SearchOfferingsInput } from "../../lib/server/services/offering-search";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TEXT_ID = `text-${RUN_ID}`;
const ACADEMY_ID = "55555555-5555-4555-8555-555555555555";
const OFFERING_ID = "77777777-7777-4777-8777-777777777777";
const CLASS_ID = "88888888-8888-4888-8888-888888888888";
const OFFERING2_ID = "99999999-9999-4999-8999-999999999999";
const CLASS2_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// ---- 가짜 데이터(SX-4.2 평가 묶음 「강남 평일 저녁」과 같은 결) ---------------------------------------------------

const card = (offeringId: string, classId: string, title: string, recruitStatus: "open" | "closing_soon" | "full") => ({
  offeringId,
  classId,
  title,
  genre: "salsa_bachata",
  isPrivateLesson: false,
  academy: { id: ACADEMY_ID, name: "라틴하우스 강남" },
  hall: "A홀",
  pattern: [{ weekday: "wed", startTime: "19:30", endTime: "21:00" }],
  firstSessionDate: "2026-12-02",
  lastSessionDate: "2026-12-23",
  sessionCount: 4,
  level: "entry",
  pools: [{ seatKind: "any", remaining: recruitStatus === "full" ? 0 : 5 }],
  priceAmount: 100_000,
  recruitStatus,
  waitlistAvailable: false,
  action: { type: "open_offering", offeringId, classId },
});

const SALSA_CARD = card(OFFERING_ID, CLASS_ID, "살사 입문 수요반", "open");
const FULL_CARD = card(OFFERING2_ID, CLASS2_ID, "바차타 기초 수요반", "full");

/** 에이전트가 보낸 조건(SX-4.1 조건 추출 결과 + 이름 칸은 비움) — 「강남 평일 저녁 살사 수업 추천해줘」 */
const AGENT_CONDITIONS = {
  instructor: null,
  academy: null,
  genre: "salsa_bachata",
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  timeBand: "evening",
  level: null,
  regionSido: "서울",
  regionGu: "강남구",
  maxPriceAmount: null,
  dateFrom: null,
  dateTo: null,
} as const;

/** 부른 기록을 남기는 가짜 찾기 함수. 이름 찾기는 늘 0건이다(질문에 이름이 없다) */
function fakeFinders(cards: unknown[]) {
  const calls = { names: 0, search: [] as SearchOfferingsInput[] };
  const none = { resolution: "none" as const, resolved: null, candidates: [] };
  const finders: PlainSearchFinders = {
    async findInstructors() {
      calls.names += 1;
      return none;
    },
    async findAcademies() {
      calls.names += 1;
      return none;
    },
    async searchOfferings(input) {
      calls.search.push(input);
      return cards as never;
    },
  };
  return { finders, calls };
}

const QUESTION = "강남 평일 저녁 살사 수업 추천해줘";

// ---- ①② 일반 검색 함수가 에이전트 조건을 받는다 ----------------------------------------------------------------

describe("① 에이전트 조건이 있으면 그 조건으로 필터 검색(runPlainSearch 넷째 인자)", () => {
  test("이름 없는 추천 질문도 조건(장르·요일·시간대·지역) 그대로 search_offerings — 이름 찾기는 부르지 않는다", async () => {
    const { finders, calls } = fakeFinders([SALSA_CARD]);
    const reply = await runPlainSearch(finders, QUESTION, { instructorId: null }, AGENT_CONDITIONS);

    expect(reply).toEqual({ kind: "offering_cards", cards: [SALSA_CARD], conditions: AGENT_CONDITIONS });
    expect(calls.names).toBe(0);
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0]).toMatchObject({
      genre: "salsa_bachata",
      weekdays: ["mon", "tue", "wed", "thu", "fri"],
      timeBand: "evening",
      regionSido: "서울",
      regionGu: "강남구",
      limit: 10,
    });
  });

  test("「모집 중」만 보기(recruitOpenOnly)면 다 찬 수업은 뺀다 — 열한 칸 밖 값이라 검색 입력에는 싣지 않는다", async () => {
    const { finders, calls } = fakeFinders([SALSA_CARD, FULL_CARD]);
    const reply = await runPlainSearch(finders, QUESTION, { instructorId: null }, { ...AGENT_CONDITIONS, recruitOpenOnly: true });

    expect(reply.kind).toBe("offering_cards");
    expect(reply.kind === "offering_cards" ? reply.cards.map((c) => c.title) : []).toEqual(["살사 입문 수요반"]);
    expect(calls.search[0]).not.toHaveProperty("recruitOpenOnly");
  });

  test("조건 검색이 0건이면 결과 없음(SX-5.4 값)과 넓히기 버튼", async () => {
    const { finders } = fakeFinders([]);
    const reply = await runPlainSearch(finders, QUESTION, { instructorId: null }, AGENT_CONDITIONS);
    expect(reply.kind).toBe("no_offering_result");
  });
});

describe("② 조건이 검색 규칙(계약 16 §5-1)에 안 맞으면 SX-5.5 이름 검색으로", () => {
  test("강사 이름만 있고 id 가 없는 조건(이름 확정 전) → 이름 검색 경로", async () => {
    const { finders, calls } = fakeFinders([SALSA_CARD]);
    const reply = await runPlainSearch(finders, QUESTION, { instructorId: null }, { ...AGENT_CONDITIONS, instructor: { name: "이준호", id: null } });
    expect(calls.names).toBeGreaterThan(0);
    // 질문에 이름이 없으니 다시 묻는다 — 조건 없는 검색은 하지 않는다
    expect(reply).toEqual({ kind: "need_name" });
    expect(calls.search).toHaveLength(0);
  });

  test("조건이 모두 비었으면 검색하지 않는다(조건 없음 검색 금지)", async () => {
    const { finders, calls } = fakeFinders([SALSA_CARD]);
    const empty = { instructor: null, academy: null, genre: null, weekdays: [], timeBand: null, level: null };
    const reply = await runPlainSearch(finders, QUESTION, { instructorId: null }, empty);
    expect(reply).toEqual({ kind: "need_name" });
    expect(calls.search).toHaveLength(0);
  });

  test("모르는 장르 값·모양이 틀린 값도 그대로 쓰지 않는다", async () => {
    const { finders, calls } = fakeFinders([SALSA_CARD]);
    await runPlainSearch(finders, QUESTION, { instructorId: null }, { ...AGENT_CONDITIONS, genre: "kpop" });
    await runPlainSearch(finders, QUESTION, { instructorId: null }, "genre=salsa");
    expect(calls.search).toHaveLength(0);
  });
});

// ---- ③ POST /api/ai/chat — 추천 고르기에서 시간이 넘을 때 -------------------------------------------------------

const BODY = {
  conversationId: null,
  context: { kind: "planner", academyId: null, offeringId: null, instructorId: null },
  message: QUESTION,
};
const FAST: AiChatDeadlines = { firstEventMs: 40, totalMs: 120 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 이벤트를 다 준 뒤 다음 이벤트를 영원히 안 주는 에이전트(추천 고르기 모델이 멈춘 경우) */
function stallAfter(events: readonly AgentEvent[]): AgentChatClient {
  return {
    async streamChat() {
      return (async function* () {
        for (const event of events) {
          await sleep(0);
          yield event;
        }
        await new Promise(() => undefined);
      })();
    },
  };
}

type PlainSearchCall = { message: string; agentConditions: unknown };

function makeRoute(agent: AgentChatClient, cards: unknown[], seen: PlainSearchCall[]) {
  const { finders } = fakeFinders(cards);
  return createAiChatRoute({
    requireMember: async () => ({ authUserId: "u1", memberId: MEMBER_ID }),
    agent,
    newRunId: () => RUN_ID,
    issueAgentSessionToken: () => "token",
    deadlines: FAST,
    plainSearch: async (message: string, context: AiChatRequest["context"], agentConditions: unknown) => {
      seen.push({ message, agentConditions });
      return runPlainSearch(finders, message, { instructorId: context.instructorId }, agentConditions);
    },
  });
}

const post = (body: unknown) => new Request("http://localhost/api/ai/chat", { method: "POST", body: JSON.stringify(body) });

async function readUiChunks(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((block) => block.replace(/^data: /, "").trim())
    .filter((line) => line !== "" && line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function expectValidChunks(parts: readonly unknown[]) {
  const schema = uiMessageChunkSchema();
  for (const part of parts) {
    const result = await schema.validate!(part);
    expect(result.success, JSON.stringify(part)).toBe(true);
  }
}

const TIER: AgentEvent = { event: "tier", data: { tier: "T2" } };
const STAGE_CANDIDATES: AgentEvent = { event: "stage", data: { name: "candidates" } };
const CONDITIONS: AgentEvent = { event: "conditions", data: { ...AGENT_CONDITIONS } };

describe("③ POST /api/ai/chat — 추천이 시간 안에 안 끝나면 필터 검색 결과로(FR-041)", () => {
  test("조건까지 받고 추천 고르기에서 멈추면 timeout — 그 조건으로 검색한 수업 카드로 닫는다", async () => {
    const seen: PlainSearchCall[] = [];
    const agent = stallAfter([TIER, STAGE_CANDIDATES, CONDITIONS]);
    const chunks = await readUiChunks(await makeRoute(agent, [SALSA_CARD], seen)(post(BODY), undefined));

    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "data-tier",
      "data-stage",
      "data-conditions",
      "data-fallback",
      "data-conditions",
      "text-start",
      "text-delta",
      "data-cards",
      "text-end",
      "finish",
    ]);
    expect(chunks[4]).toEqual({ type: "data-fallback", data: { kind: "plain_search", reason: "timeout" } });
    expect(chunks[7]).toEqual({ type: "text-delta", id: TEXT_ID, delta: PLAIN_SEARCH_NOTICE });
    expect(chunks[8]).toEqual({ type: "data-cards", data: { kind: "offering_cards", items: [SALSA_CARD] } });
    // 대체 검색에 에이전트가 보낸 조건이 그대로 넘어갔다 — 이름만 보는 경로였다면 「이름을 넣어 다시」가 나왔을 것
    expect(seen).toEqual([{ message: QUESTION, agentConditions: AGENT_CONDITIONS }]);
    expect(chunks.some((c) => c.delta === PLAIN_SEARCH_NEED_NAME)).toBe(false);
    await expectValidChunks(chunks);
  });

  test("수업 카드가 이미 나간 뒤 멈추면 다시 찾지 않는다 — 같은 카드가 두 번 붙지 않고 안내 문장과 닫기만", async () => {
    const seen: PlainSearchCall[] = [];
    const agent = stallAfter([
      TIER,
      CONDITIONS,
      { event: "cards", data: { kind: "offering_cards", items: [SALSA_CARD] } },
      { event: "text", data: { sentence: "조건에 맞는 수업을 1개 찾았어요." } },
      { event: "stage", data: { name: "writing" } },
    ]);
    const chunks = await readUiChunks(await makeRoute(agent, [SALSA_CARD], seen)(post(BODY), undefined));

    expect(seen).toEqual([]);
    expect(chunks.filter((c) => c.type === "data-cards")).toHaveLength(1);
    expect(chunks.find((c) => c.type === "data-fallback")).toEqual({ type: "data-fallback", data: { kind: "plain_search", reason: "timeout" } });
    const deltas = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta);
    expect(deltas).toEqual(["조건에 맞는 수업을 1개 찾았어요.", `\n${PLAIN_SEARCH_NOTICE}`]);
    expect(chunks.slice(-2).map((c) => c.type)).toEqual(["text-end", "finish"]);
    await expectValidChunks(chunks);
  });

  test("조건을 보내기 전에 멈췄으면 예전처럼(SX-5.5) 질문 글자로 찾는다 — 조건은 null 로 넘어간다", async () => {
    const seen: PlainSearchCall[] = [];
    const agent = stallAfter([TIER, STAGE_CANDIDATES]);
    const chunks = await readUiChunks(await makeRoute(agent, [SALSA_CARD], seen)(post(BODY), undefined));
    expect(seen).toEqual([{ message: QUESTION, agentConditions: null }]);
    // 이름이 없는 질문이라 다시 묻는다
    expect(chunks.filter((c) => c.type === "text-delta").map((c) => c.delta)).toEqual([`${PLAIN_SEARCH_NOTICE}\n${PLAIN_SEARCH_NEED_NAME}`]);
  });
});
