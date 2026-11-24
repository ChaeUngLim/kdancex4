// SX-5.5(시간 초과 때 일반 검색으로 대체) — FR-041(추천 시간 초과 대체) · 계약 16 §3-1 「대체 규칙」 · SX-5 수용 ⑤.
//   ① 제한 시간은 설정값이다 — 기본 첫 이벤트 1.5초 · 전체 25초, 환경 변수로 바꾸고 잘못된 값이면 바로 예외
//   ② 일반 검색(runPlainSearch) — 질문에서 강사·학원 이름 토큰을 찾아(SX-5.1 과 같은 함수) 수업 카드(SX-5.3)를 낸다.
//      동명이인이면 후보 카드, 이름이 없으면 다시 묻기, 0건이면 결과 없음(SX-5.4)
//   ③ POST /api/ai/chat — 에이전트가 첫 이벤트를 안 주거나 전체 시간을 넘기면 플래너는 일반 검색 응답으로 닫는다.
//      이미 나간 조각은 되돌리지 않고, 학원 문의(inquiry)는 그대로 사람에게(human) 넘긴다
import { uiMessageChunkSchema } from "ai";
import { describe, expect, test } from "vitest";

import type { AgentEvent } from "../../lib/server/ai/agent-stream-translate";
import {
  createAiChatRoute,
  DEFAULT_AI_CHAT_DEADLINES,
  loadAiChatDeadlines,
  type AgentChatClient,
  type AgentChatStreamRequest,
  type AiChatDeadlines,
} from "../../lib/server/ai/ai-chat-route";
import {
  extractNameTokens,
  PLAIN_SEARCH_NEED_NAME,
  PLAIN_SEARCH_NOTICE,
  PLAIN_SEARCH_PICK_INSTRUCTOR,
  runPlainSearch,
  type PlainSearchFinders,
  type PlainSearchReply,
} from "../../lib/server/ai/planner-plain-search";
import type { SearchOfferingsInput } from "../../lib/server/services/offering-search";
import type { AcademyCandidate, InstructorCandidate } from "../../lib/server/services/name-candidates";
import { NO_RESULT_SENTENCE } from "../../lib/domain/offering-no-result";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const TEXT_ID = `text-${RUN_ID}`;
const LEE_ID = "33333333-3333-4333-8333-333333333333";
const LEE2_ID = "44444444-4444-4444-8444-444444444444";
const ACADEMY_ID = "55555555-5555-4555-8555-555555555555";
const ACADEMY2_ID = "66666666-6666-4666-8666-666666666666";
const OFFERING_ID = "77777777-7777-4777-8777-777777777777";
const CLASS_ID = "88888888-8888-4888-8888-888888888888";

// ---- 가짜 데이터(spec FR-037a 질문 예 · SX-5.3 증거의 쌈바 입문반 카드 값) -------------------------------------

const academy = (id: string, name: string): AcademyCandidate => ({
  academyId: id,
  name,
  regionSido: "서울",
  regionGu: "강남구",
  publishedOfferingCount: 3,
});

const instructor = (id: string, academies: { id: string; name: string }[]): InstructorCandidate => ({
  instructorId: id,
  displayName: "이준호",
  photoUrl: null,
  genres: ["dance_sport"],
  academies,
  publishedOfferingCount: 2,
  action: { type: "select_instructor", instructorId: id },
});

const SAMBA_CARD = {
  offeringId: OFFERING_ID,
  classId: CLASS_ID,
  title: "쌈바 입문반",
  genre: "dance_sport",
  isPrivateLesson: false,
  academy: { id: ACADEMY_ID, name: "라틴하우스 강남" },
  hall: "A홀",
  pattern: [
    { weekday: "tue", startTime: "19:00", endTime: "20:00" },
    { weekday: "thu", startTime: "19:00", endTime: "20:00" },
  ],
  firstSessionDate: "2026-12-01",
  lastSessionDate: "2026-12-24",
  sessionCount: 8,
  level: "entry",
  pools: [
    { seatKind: "male", remaining: 1 },
    { seatKind: "female", remaining: 6 },
  ],
  priceAmount: 120_000,
  recruitStatus: "closing_soon",
  waitlistAvailable: false,
  action: { type: "open_offering", offeringId: OFFERING_ID, classId: CLASS_ID },
} as const;

type Store = {
  instructors: Record<string, InstructorCandidate[]>;
  academies: Record<string, AcademyCandidate[]>;
  cards: unknown[];
};

/** 이름 → 후보 표를 쓰는 가짜 찾기 함수. 부른 기록을 남긴다(실제 함수는 SX-5.1·SX-5.3 DB 테스트가 확인했다) */
function fakeFinders(store: Store) {
  const calls = { instructors: [] as { name: string; academyName?: string | null }[], academies: [] as string[], search: [] as SearchOfferingsInput[] };
  const resolution = <T>(all: T[]) => ({
    resolution: all.length === 0 ? ("none" as const) : all.length === 1 ? ("unique" as const) : ("ambiguous" as const),
    resolved: all.length === 1 ? all[0]! : null,
    candidates: all,
  });
  const finders: PlainSearchFinders = {
    async findInstructors(input) {
      calls.instructors.push({ name: input.name, academyName: input.academyName });
      const all = store.instructors[input.name.trim()] ?? [];
      const narrowed = input.academyName == null ? all : all.filter((c) => c.academies.some((a) => a.name === input.academyName));
      return resolution(narrowed);
    },
    async findAcademies(input) {
      calls.academies.push(input.name);
      return resolution(store.academies[input.name.trim()] ?? []);
    },
    async searchOfferings(input) {
      calls.search.push(input);
      return store.cards as never;
    },
  };
  return { finders, calls };
}

const STORE: Store = {
  instructors: { 이준호: [instructor(LEE_ID, [{ id: ACADEMY_ID, name: "라틴하우스 강남" }])] },
  academies: { "라틴하우스 강남": [academy(ACADEMY_ID, "라틴하우스 강남")] },
  cards: [SAMBA_CARD],
};

// ---- ① 설정값 ------------------------------------------------------------------------------------------------

describe("① 제한 시간은 설정값이다(loadAiChatDeadlines)", () => {
  test("비우면 계약 16 §3-1 추천값 — 첫 이벤트 1.5초 · 전체 25초(SC-041)", () => {
    expect(DEFAULT_AI_CHAT_DEADLINES).toEqual({ firstEventMs: 1_500, totalMs: 25_000 });
    expect(loadAiChatDeadlines({})).toEqual(DEFAULT_AI_CHAT_DEADLINES);
    expect(loadAiChatDeadlines({ AI_CHAT_FIRST_EVENT_TIMEOUT_MS: " ", AI_CHAT_TOTAL_TIMEOUT_MS: "" })).toEqual(DEFAULT_AI_CHAT_DEADLINES);
  });

  test("환경 변수로 바꾼다", () => {
    expect(loadAiChatDeadlines({ AI_CHAT_FIRST_EVENT_TIMEOUT_MS: "2000", AI_CHAT_TOTAL_TIMEOUT_MS: "30000" })).toEqual({
      firstEventMs: 2_000,
      totalMs: 30_000,
    });
  });

  test.each([
    ["0", "25000"],
    ["-5", "25000"],
    ["1.5", "25000"],
    ["abc", "25000"],
    ["1500", "0"],
    // 첫 이벤트 기한이 전체보다 길면 앞 기한이 뜻이 없다 — 잘못된 설정으로 뜨지 않게 막는다
    ["30000", "25000"],
  ])("잘못된 값(첫 %s · 전체 %s)은 바로 예외", (first, total) => {
    expect(() => loadAiChatDeadlines({ AI_CHAT_FIRST_EVENT_TIMEOUT_MS: first, AI_CHAT_TOTAL_TIMEOUT_MS: total })).toThrow();
  });
});

// ---- ② 일반 검색 -----------------------------------------------------------------------------------------------

describe("② 질문에서 이름 토큰 뽑기(extractNameTokens)", () => {
  test("부름말(강사님·선생님·쌤)과 조사를 떼고, 학원 이름처럼 두세 낱말짜리 묶음도 낸다", () => {
    const { words, phrases } = extractNameTokens("이준호 강사님의 라틴하우스 강남 수업 모두 알려줘");
    expect(words).toContain("이준호");
    expect(words).not.toContain("강사님의");
    expect(phrases).toContain("라틴하우스 강남");
  });

  test("붙여 쓴 부름말·조사도 뗀다(이준호강사님의 → 이준호, 이준호쌤 → 이준호)", () => {
    expect(extractNameTokens("이준호강사님의 수업").words).toContain("이준호");
    expect(extractNameTokens("이준호쌤 주말 수업?").words).toContain("이준호");
    expect(extractNameTokens("라틴하우스에서 하는 수업").words).toContain("라틴하우스");
  });

  test("한 글자 낱말·문장 부호는 버리고, 같은 토큰은 한 번만", () => {
    const { words } = extractNameTokens("이준호, 이준호! 꼭 알려 줘?");
    expect(words.filter((w) => w === "이준호")).toHaveLength(1);
    expect(words.every((w) => w.length >= 2)).toBe(true);
  });

  test("긴 질문도 찾는 수에 상한이 있다(DB 조회가 질문 길이만큼 늘지 않게)", () => {
    const { words, phrases } = extractNameTokens(Array.from({ length: 200 }, (_, i) => `낱말${i}`).join(" "));
    expect(words.length + phrases.length).toBeLessThanOrEqual(40);
  });
});

// 「이준호 강사님의 라틴하우스 강남 수업」에서 찾은 조건(계약 16 §5-1 열한 칸) — 화면의 조건 칩(M10F)이 된다(SX-5.7)
const LEE_ACADEMY_CONDITIONS = {
  instructor: { name: "이준호", id: LEE_ID },
  academy: { name: "라틴하우스 강남", id: ACADEMY_ID },
  genre: null,
  weekdays: null,
  timeBand: null,
  level: null,
  regionSido: null,
  regionGu: null,
  maxPriceAmount: null,
  dateFrom: null,
  dateTo: null,
};

describe("② 일반 검색(runPlainSearch) — 이름으로 찾아 수업 카드", () => {
  test("「이준호 강사님의 라틴하우스 강남 수업」 → 강사·학원 id 로 search_offerings 를 불러 수업 카드", async () => {
    const { finders, calls } = fakeFinders(STORE);
    const reply = await runPlainSearch(finders, "이준호 강사님의 라틴하우스 강남 수업 모두 알려줘");

    expect(reply).toEqual({ kind: "offering_cards", cards: [SAMBA_CARD], conditions: LEE_ACADEMY_CONDITIONS });
    expect(calls.search).toHaveLength(1);
    expect(calls.search[0]).toMatchObject({
      instructor: { name: "이준호", id: LEE_ID },
      academy: { name: "라틴하우스 강남", id: ACADEMY_ID },
    });
    // 이름 말고 다른 조건(요일·시간대·장르)은 뽑지 않는다 — 모델 없이 짐작하지 않는다
    expect(calls.search[0]?.weekdays ?? null).toBeNull();
    expect(calls.search[0]?.timeBand ?? null).toBeNull();
  });

  test("학원 이름이 없으면 그 강사의 모든 학원 수업(FR-032)", async () => {
    const { finders, calls } = fakeFinders(STORE);
    await runPlainSearch(finders, "이준호 강사 수업 알려줘");
    expect(calls.search[0]?.instructor).toEqual({ name: "이준호", id: LEE_ID });
    expect(calls.search[0]?.academy ?? null).toBeNull();
  });

  test("같은 이름 강사가 둘이면 수업을 고르지 않고 후보 카드(SX-5 수용 ②)", async () => {
    const two: Store = {
      ...STORE,
      instructors: {
        이준호: [instructor(LEE_ID, [{ id: ACADEMY_ID, name: "라틴하우스 강남" }]), instructor(LEE2_ID, [{ id: ACADEMY2_ID, name: "탱고원 합정" }])],
      },
    };
    const { finders, calls } = fakeFinders(two);
    const reply = await runPlainSearch(finders, "이준호 강사님 수업 알려줘");
    expect(reply.kind).toBe("instructor_candidates");
    expect(reply.kind === "instructor_candidates" && reply.candidates.map((c) => c.instructorId)).toEqual([LEE_ID, LEE2_ID]);
    expect(calls.search).toHaveLength(0);
  });

  test("동명이인이라도 질문의 학원 이름으로 하나로 좁혀지면 그 강사로 찾는다", async () => {
    const two: Store = {
      ...STORE,
      instructors: {
        이준호: [instructor(LEE_ID, [{ id: ACADEMY_ID, name: "라틴하우스 강남" }]), instructor(LEE2_ID, [{ id: ACADEMY2_ID, name: "탱고원 합정" }])],
      },
    };
    const { finders, calls } = fakeFinders(two);
    const reply = await runPlainSearch(finders, "이준호 강사님의 라틴하우스 강남 수업");
    expect(reply.kind).toBe("offering_cards");
    expect(calls.search[0]?.instructor).toEqual({ name: "이준호", id: LEE_ID });
  });

  test("이름이 하나도 안 걸리면 검색하지 않고 다시 묻는다(조건 없음 검색 금지, 계약 16 §5-1)", async () => {
    const { finders, calls } = fakeFinders(STORE);
    expect(await runPlainSearch(finders, "주말 오전 라틴 수업 있어?")).toEqual({ kind: "need_name" });
    expect(calls.search).toHaveLength(0);
  });

  test("이름은 맞지만 수업이 0건이면 결과 없음 안내와 넓히기 버튼(SX-5.4 와 같은 값)", async () => {
    const { finders } = fakeFinders({ ...STORE, cards: [] });
    const reply = await runPlainSearch(finders, "이준호 강사님의 라틴하우스 강남 수업");
    expect(reply.kind).toBe("no_offering_result");
    if (reply.kind !== "no_offering_result") throw new Error("결과 없음이어야 한다");
    expect(reply.reply.sentence).toBe(NO_RESULT_SENTENCE);
    expect(reply.reply.actions[0]).toMatchObject({ widen: "instructor_other_offerings", label: "이준호 강사님의 다른 수업 보기" });
  });

  test("학원만 말하면 그 학원 수업", async () => {
    const { finders, calls } = fakeFinders(STORE);
    const reply = await runPlainSearch(finders, "라틴하우스 강남 수업 보여줘");
    expect(reply.kind).toBe("offering_cards");
    expect(calls.search[0]?.academy).toEqual({ name: "라틴하우스 강남", id: ACADEMY_ID });
    expect(calls.search[0]?.instructor ?? null).toBeNull();
  });
});

// ---- ③ 처리기 -------------------------------------------------------------------------------------------------

const BODY = {
  conversationId: null,
  context: { kind: "planner", academyId: null, offeringId: null, instructorId: null },
  message: "이준호 강사님의 라틴하우스 강남 수업 모두 알려줘",
};

/** 테스트용 짧은 기한 — 실제 값은 1.5초·25초. 설정값이라 테스트가 몇십 ms 로 줄여 돌릴 수 있다 */
const FAST: AiChatDeadlines = { firstEventMs: 40, totalMs: 120 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 이벤트를 주되 `waitBeforeMs[i]` 만큼 기다린 뒤 i 번째를 준다. 받은 신호(signal)를 기록한다 */
function slowAgent(events: readonly AgentEvent[], waitBeforeMs: readonly number[], seen: { request?: AgentChatStreamRequest; signal?: AbortSignal } = {}): AgentChatClient {
  return {
    async streamChat(request, signal) {
      seen.request = request;
      seen.signal = signal;
      return (async function* () {
        for (const [index, event] of events.entries()) {
          await sleep(waitBeforeMs[index] ?? 0);
          yield event;
        }
      })();
    },
  };
}

/** 아무 이벤트도 주지 않고 영원히 기다리는 에이전트(모델이 멈춘 경우) */
function stuckAgent(seen: { signal?: AbortSignal } = {}): AgentChatClient {
  return {
    async streamChat(_request, signal) {
      seen.signal = signal;
      return {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<AgentEvent>>(() => undefined) }),
      };
    },
  };
}

function makeRoute(options: {
  agent: AgentChatClient | null;
  plainSearch?: (message: string) => Promise<PlainSearchReply>;
  deadlines?: AiChatDeadlines;
}) {
  return createAiChatRoute({
    requireMember: async () => ({ authUserId: "u1", memberId: MEMBER_ID }),
    agent: options.agent,
    newRunId: () => RUN_ID,
    issueAgentSessionToken: ({ memberId, runId }) => `token-for-${memberId}-${runId}`,
    deadlines: options.deadlines ?? FAST,
    plainSearch: options.plainSearch ?? null,
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

/** 실제 runPlainSearch 를 가짜 찾기 함수로 돌리는 대체 경로. 불린 질문을 기록한다 */
function plainSearchWith(store: Store, asked: string[] = []) {
  const { finders } = fakeFinders(store);
  return async (message: string) => {
    asked.push(message);
    return runPlainSearch(finders, message);
  };
}

const TIER: AgentEvent = { event: "tier", data: { tier: "T2" } };
const STAGE: AgentEvent = { event: "stage", data: { name: "conditions" } };
const DONE: AgentEvent = { event: "done", data: { metrics: { tier: "T2", fallbackUsed: false } } };
const TEXT: AgentEvent = { event: "text", data: { sentence: "이준호 강사님의 수업을 찾았어요." } };

describe("③ POST /api/ai/chat — 시간 초과면 일반 검색 응답(SX-5 수용 ⑤)", () => {
  test("첫 이벤트가 기한(설정값) 안에 안 오면 일반 검색 결과로 닫는다 — 안내 문장 + 수업 카드", async () => {
    const asked: string[] = [];
    const seen: { signal?: AbortSignal } = {};
    const started = Date.now();
    const response = await makeRoute({ agent: stuckAgent(seen), plainSearch: plainSearchWith(STORE, asked) })(post(BODY), undefined);
    const chunks = await readUiChunks(response);
    const elapsed = Date.now() - started;

    expect(chunks).toEqual([
      { type: "start", messageId: `msg-${RUN_ID}` },
      { type: "data-fallback", data: { kind: "plain_search", reason: "first_event_timeout" } },
      // 찾은 조건(이름 칩) — 진행 표시라 기록에 남지 않는다(transient, SX-5.7)
      { type: "data-conditions", data: LEE_ACADEMY_CONDITIONS, transient: true },
      { type: "text-start", id: TEXT_ID },
      { type: "text-delta", id: TEXT_ID, delta: PLAIN_SEARCH_NOTICE },
      { type: "data-cards", data: { kind: "offering_cards", items: [SAMBA_CARD] } },
      { type: "text-end", id: TEXT_ID },
      { type: "finish" },
    ]);
    await expectValidChunks(chunks);
    // 일반 검색은 회원 질문 원문으로 했다
    expect(asked).toEqual([BODY.message]);
    // 첫 이벤트 기한(40ms)에서 끊었다 — 전체 기한(120ms)까지 기다리지 않았다
    expect(elapsed).toBeLessThan(FAST.totalMs + 100);
    // 에이전트 호출도 멈추라고 신호를 보냈다
    expect(seen.signal?.aborted).toBe(true);
  });

  test("첫 이벤트는 왔지만 전체 기한을 넘기면 timeout — 이미 나간 조각(tier·stage)은 그대로 두고 뒤에 일반 검색", async () => {
    const agent = slowAgent([TIER, STAGE, DONE], [0, 10, 500]);
    const chunks = await readUiChunks(await makeRoute({ agent, plainSearch: plainSearchWith(STORE) })(post(BODY), undefined));
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "data-tier",
      "data-stage",
      "data-fallback",
      "data-conditions",
      "text-start",
      "text-delta",
      "data-cards",
      "text-end",
      "finish",
    ]);
    expect(chunks[3]).toEqual({ type: "data-fallback", data: { kind: "plain_search", reason: "timeout" } });
    await expectValidChunks(chunks);
  });

  test("에이전트가 문장을 쓰다 멈췄으면 같은 글 상자에 줄을 바꿔 안내를 잇는다(되돌리지 않음)", async () => {
    const agent = slowAgent([TIER, TEXT, DONE], [0, 0, 500]);
    const chunks = await readUiChunks(await makeRoute({ agent, plainSearch: plainSearchWith(STORE) })(post(BODY), undefined));
    const deltas = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta);
    expect(deltas).toEqual(["이준호 강사님의 수업을 찾았어요.", `\n${PLAIN_SEARCH_NOTICE}`]);
    // 글 상자는 한 번만 열고 한 번만 닫는다
    expect(chunks.filter((c) => c.type === "text-start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "text-end")).toHaveLength(1);
  });

  test("기한 안에 done 이 오면 대체하지 않는다 — 일반 검색을 부르지 않는다", async () => {
    const asked: string[] = [];
    const agent = slowAgent([TIER, TEXT, DONE], [0, 5, 5]);
    const chunks = await readUiChunks(await makeRoute({ agent, plainSearch: plainSearchWith(STORE, asked) })(post(BODY), undefined));
    expect(chunks.map((c) => c.type)).toEqual(["start", "data-tier", "text-start", "text-delta", "text-end", "finish"]);
    expect(asked).toEqual([]);
  });

  test("에이전트에 넘기는 deadlineMs 는 설정한 전체 기한이다", async () => {
    const seen: { request?: AgentChatStreamRequest } = {};
    await readUiChunks(await makeRoute({ agent: slowAgent([DONE], [0], seen), deadlines: { firstEventMs: 900, totalMs: 9_000 } })(post(BODY), undefined));
    expect(seen.request?.deadlineMs).toBe(9_000);
  });

  test("에이전트가 꺼져 있으면(설정 없음) 기다리지 않고 바로 일반 검색 — reason agent_unavailable", async () => {
    const chunks = await readUiChunks(await makeRoute({ agent: null, plainSearch: plainSearchWith(STORE) })(post(BODY), undefined));
    expect(chunks[1]).toEqual({ type: "data-fallback", data: { kind: "plain_search", reason: "agent_unavailable" } });
    expect(chunks.at(-1)).toEqual({ type: "finish" });
  });

  test("에이전트 연결이 터져도 일반 검색 — 원인 글은 화면에 싣지 않는다", async () => {
    const broken: AgentChatClient = {
      async streamChat() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8100");
      },
    };
    const chunks = await readUiChunks(await makeRoute({ agent: broken, plainSearch: plainSearchWith(STORE) })(post(BODY), undefined));
    expect(chunks[1]).toEqual({ type: "data-fallback", data: { kind: "plain_search", reason: "agent_error" } });
    expect(JSON.stringify(chunks)).not.toContain("ECONNREFUSED");
  });

  test("에이전트가 error{fallback:plain_search}(한국어 검사 실패 등, FR-266)를 보내도 일반 검색으로 바꾼다", async () => {
    const languageFail: AgentEvent = { event: "error", data: { code: "LANGUAGE_CHECK_FAILED", fallback: "plain_search" } };
    const chunks = await readUiChunks(
      await makeRoute({ agent: slowAgent([TIER, languageFail], [0, 0]), plainSearch: plainSearchWith(STORE) })(post(BODY), undefined),
    );
    expect(chunks.map((c) => c.type)).not.toContain("data-error");
    expect(chunks.find((c) => c.type === "data-fallback")).toEqual({
      type: "data-fallback",
      data: { kind: "plain_search", reason: "agent_error" },
    });
    expect(chunks.find((c) => c.type === "data-cards")).toBeDefined();
  });

  test("동명이인이면 후보 카드와 고르기 안내로 닫는다", async () => {
    const two: Store = {
      ...STORE,
      instructors: {
        이준호: [instructor(LEE_ID, [{ id: ACADEMY_ID, name: "라틴하우스 강남" }]), instructor(LEE2_ID, [{ id: ACADEMY2_ID, name: "탱고원 합정" }])],
      },
    };
    const body = { ...BODY, message: "이준호 강사님 수업 알려줘" };
    const chunks = await readUiChunks(await makeRoute({ agent: stuckAgent(), plainSearch: plainSearchWith(two) })(post(body), undefined));
    expect(chunks.find((c) => c.type === "text-delta")).toMatchObject({ delta: `${PLAIN_SEARCH_NOTICE}\n${PLAIN_SEARCH_PICK_INSTRUCTOR}` });
    const cards = chunks.find((c) => c.type === "data-cards") as { data: { kind: string; items: { instructorId: string }[] } };
    expect(cards.data.kind).toBe("instructor_candidates");
    expect(cards.data.items.map((i) => i.instructorId)).toEqual([LEE_ID, LEE2_ID]);
    await expectValidChunks(chunks);
  });

  test("이름이 없는 질문이면 카드 없이 다시 묻는 안내", async () => {
    const body = { ...BODY, message: "주말 오전 라틴 수업 있어?" };
    const chunks = await readUiChunks(await makeRoute({ agent: stuckAgent(), plainSearch: plainSearchWith(STORE) })(post(body), undefined));
    expect(chunks.find((c) => c.type === "text-delta")).toMatchObject({ delta: `${PLAIN_SEARCH_NOTICE}\n${PLAIN_SEARCH_NEED_NAME}` });
    expect(chunks.find((c) => c.type === "data-cards")).toBeUndefined();
  });

  test("수업이 0건이면 결과 없음 안내와 넓히기 버튼 값(data-no-result)", async () => {
    const chunks = await readUiChunks(
      await makeRoute({ agent: stuckAgent(), plainSearch: plainSearchWith({ ...STORE, cards: [] }) })(post(BODY), undefined),
    );
    const delta = chunks.find((c) => c.type === "text-delta") as { delta: string };
    expect(delta.delta.startsWith(`${PLAIN_SEARCH_NOTICE}\n${NO_RESULT_SENTENCE}`)).toBe(true);
    const noResult = chunks.find((c) => c.type === "data-no-result") as { data: { kind: string; actions: unknown[] } };
    expect(noResult.data.kind).toBe("no_offering_result");
    expect(noResult.data.actions.length).toBeGreaterThan(0);
    await expectValidChunks(chunks);
  });

  test("일반 검색마저 실패하면 예전처럼 data-error(plain_search) 로 닫는다 — 응답이 끊기지 않는다", async () => {
    const chunks = await readUiChunks(
      await makeRoute({
        agent: stuckAgent(),
        plainSearch: async () => {
          throw new Error("db down");
        },
      })(post(BODY), undefined),
    );
    expect(chunks.slice(-2)).toEqual([
      { type: "data-error", data: { code: "MODEL_UNAVAILABLE", fallback: "plain_search" } },
      { type: "finish" },
    ]);
    expect(JSON.stringify(chunks)).not.toContain("db down");
  });

  test("학원 문의(inquiry)는 시간이 넘어도 일반 검색이 아니라 사람에게(human) 넘긴다", async () => {
    const asked: string[] = [];
    const body = { ...BODY, context: { ...BODY.context, kind: "inquiry", academyId: ACADEMY_ID } };
    const chunks = await readUiChunks(await makeRoute({ agent: stuckAgent(), plainSearch: plainSearchWith(STORE, asked) })(post(body), undefined));
    expect(chunks.slice(-2)).toEqual([
      { type: "data-error", data: { code: "MODEL_UNAVAILABLE", fallback: "human" } },
      { type: "finish" },
    ]);
    expect(asked).toEqual([]);
  });
});
