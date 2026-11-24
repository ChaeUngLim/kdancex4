// SX-5.5(시간 초과 때 일반 검색으로 대체) — FR-041(추천 시간 초과 대체) · 계약 16 §3-1 「대체 규칙」.
//
// 처음 보는 사람용 요약
// - AI 플래너는 보통 에이전트(모델)가 질문에서 조건을 뽑고(SX-5.2) 그 조건으로 수업을 찾는다(SX-5.3).
//   그런데 모델이 정해진 시간 안에 답을 못 하거나 꺼져 있으면 회원은 빈 화면만 보게 된다.
// - 그때 쓰는 「비상 경로」가 이 파일이다. 모델 없이, 질문 글자에서 **강사·학원 이름만** 찾아
//   SX-5.1(이름 후보)·SX-5.3(수업 카드)과 똑같은 함수로 수업 카드를 만든다.
// - 요일·시간대·장르는 뽑지 않는다. 그걸 글자 규칙으로 짐작하면 틀린 조건으로 수업을 거르게 되고,
//   이름만으로 찾으면 넓게 보여 줄 뿐 지어낸 수업은 나오지 않는다(FR-039(없는 항목 추천 금지)).
// - 결과는 AI SDK UI 스트림 조각으로 바꿔 내보낸다(plainSearchChunks). 바꾸기는 SX-1.5 번역기를 그대로 쓴다.
import type { UIMessageChunk } from "ai";

import { buildNoResultReply, type NoResultReply, type SearchConditions } from "../../domain/offering-no-result";
import type {
  AcademyCandidatesResult,
  FindAcademiesInput,
  FindInstructorsInput,
  InstructorCandidate,
  InstructorCandidatesResult,
} from "../services/name-candidates";
import { searchOfferingsInputSchema, type OfferingCard, type SearchOfferingsInput } from "../services/offering-search";
import { translateAgentEvent, type TranslateState, type Translation } from "./agent-stream-translate";

// ---- 고정 문구(모델이 쓰지 않는다 — aiGenerated 아님) --------------------------------------------------------

/** 대체했다는 안내(계약 16 §3-1 문장 그대로) */
export const PLAIN_SEARCH_NOTICE = "AI 가 응답하지 않아 일반 검색 결과를 보여 드려요";
/** 질문에서 이름을 하나도 못 찾았을 때 */
export const PLAIN_SEARCH_NEED_NAME = "강사나 학원 이름을 넣어 다시 물어봐 주세요.";
/** 같은 이름의 강사가 여럿일 때(SX-5 수용 ②) */
export const PLAIN_SEARCH_PICK_INSTRUCTOR = "같은 이름의 강사님이 여러 분이에요. 한 분을 골라 주세요.";

/** 수업 카드 최대 수(계약 16 §6 search_offerings limit 1..20 안) */
const PLAIN_SEARCH_CARD_LIMIT = 10;
/** 후보 카드 최대 수(계약 16 §6 find_instructors limit 1..5) */
const CANDIDATE_LIMIT = 5;
/** 질문 하나에서 찾아볼 낱말·묶음 수 상한 — 긴 질문이어도 DB 조회 수가 끝없이 늘지 않게 */
const MAX_WORDS = 20;
const MAX_PHRASES = 20;

// ---- 이름 토큰 뽑기 ---------------------------------------------------------------------------------------

// 이름 뒤에 붙는 부름말. 긴 것부터 본다(「강사님」을 「님」보다 먼저)
const HONORIFICS = ["원장님", "강사님", "선생님", "강사", "선생", "쌤", "님"] as const;
// 이름 뒤에 붙는 조사. 긴 것부터 본다
const PARTICLES = ["에서는", "에서", "에게", "으로", "이랑", "하고", "부터", "까지", "의", "은", "는", "이", "가", "을", "를", "에", "도", "랑", "와", "과", "로", "만"] as const;

/** 끝에서 suffix 하나를 뗀다. 떼고 나서 두 글자 미만이 되면 떼지 않는다(「이가」 같은 짧은 이름 보호) */
function stripSuffix(word: string, suffixes: readonly string[]): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 2) return word.slice(0, -suffix.length);
  }
  return word;
}

/** 「이준호강사님의」 → 「이준호」. 조사 → 부름말 → 조사 순으로 몇 번 떼어 본다 */
function stripWord(word: string): string {
  let current = word;
  for (let round = 0; round < 3; round += 1) {
    const next = stripSuffix(stripSuffix(current, PARTICLES), HONORIFICS);
    if (next === current) break;
    current = next;
  }
  // 「강사님의」처럼 부름말만 있던 낱말은 남는 게 없다
  return HONORIFICS.some((h) => current === h) ? "" : current;
}

export type NameTokens = Readonly<{ words: readonly string[]; phrases: readonly string[] }>;

/**
 * 질문 → 이름일 수 있는 낱말(words)과 두세 낱말 묶음(phrases).
 * - 학원 이름은 「라틴하우스 강남」처럼 띄어 쓴 두세 낱말일 때가 많아 묶음도 만든다
 * - 이름이 「…이」로 끝날 수도 있어(박은이) 부름말이 없는 낱말은 떼기 전 모양도 함께 낸다
 * - 한 글자 낱말은 버린다(사람·학원 이름은 두 글자 이상)
 */
export function extractNameTokens(question: string): NameTokens {
  const rawWords = question
    .replace(/[?？!！.,~·…"'“”‘’()[\]{}<>/\\|:;]/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
  const stripped = rawWords.map(stripWord).filter((w) => w.length >= 2);

  const words: string[] = [];
  const addWord = (w: string) => {
    if (w.length >= 2 && !words.includes(w) && words.length < MAX_WORDS) words.push(w);
  };
  for (const raw of rawWords) {
    const clean = stripWord(raw);
    addWord(clean);
    if (raw !== clean && !HONORIFICS.some((h) => raw.includes(h))) addWord(raw);
  }

  const phrases: string[] = [];
  for (let size = 3; size >= 2; size -= 1) {
    for (let start = 0; start + size <= stripped.length; start += 1) {
      const phrase = stripped.slice(start, start + size).join(" ");
      if (!phrases.includes(phrase) && phrases.length < MAX_PHRASES) phrases.push(phrase);
    }
  }
  return { words, phrases };
}

// ---- 일반 검색 ----------------------------------------------------------------------------------------

/** 찾기 함수 셋. 운영은 SX-5.1·SX-5.3 의 DB 함수를, 단위 테스트는 가짜를 넣는다 */
export type PlainSearchFinders = Readonly<{
  findInstructors: (input: FindInstructorsInput) => Promise<InstructorCandidatesResult>;
  findAcademies: (input: FindAcademiesInput) => Promise<AcademyCandidatesResult>;
  searchOfferings: (input: SearchOfferingsInput) => Promise<OfferingCard[]>;
  /**
   * 강사 id 로 공개 강사 카드 읽기(SX-5.7). 강사 프로필(M15) 입구와 후보 카드 「선택」(M10G)이 `context.instructorId` 를
   * 채워 부를 때 쓴다. 없으면(옛 테스트) 정해진 강사를 쓰지 않고 예전처럼 글자로만 찾는다.
   */
  findInstructorById?: (instructorId: string) => Promise<InstructorCandidate | null>;
}>;

/** 일반 검색 결과 네 갈래 */
export type PlainSearchReply =
  | Readonly<{ kind: "offering_cards"; cards: readonly OfferingCard[]; conditions: SearchConditions }>
  | Readonly<{ kind: "instructor_candidates"; candidates: readonly InstructorCandidate[] }>
  | Readonly<{ kind: "no_offering_result"; reply: NoResultReply; conditions: SearchConditions }>
  | Readonly<{ kind: "need_name" }>
  // SX-4.3 — 에이전트가 수업 카드를 이미 보낸 뒤 멈췄다. 다시 찾지 않고 안내 문장과 닫기만 낸다(같은 카드 두 번 금지)
  | Readonly<{ kind: "cards_already_shown" }>;

type Picked = { name: string; id: string } | null;

/** 학원: 하나로 정해진(unique) 학원이 딱 한 곳일 때만 고른다. 둘 이상 걸리거나 동명 학원이면 고르지 않는다 */
async function pickAcademy(finders: PlainSearchFinders, tokens: NameTokens): Promise<Picked> {
  // 긴 묶음부터 — 「라틴하우스 강남」이 「강남」보다 먼저
  const names = [...tokens.phrases, ...tokens.words];
  const results = await Promise.all(names.map((name) => finders.findAcademies({ name, limit: CANDIDATE_LIMIT })));
  const unique = new Map<string, string>();
  results.forEach((result) => {
    if (result.resolved !== null) unique.set(result.resolved.academyId, result.resolved.name);
  });
  if (unique.size !== 1) return null;
  const [[id, name]] = [...unique.entries()] as [[string, string]];
  return { id, name };
}

type InstructorPick = { kind: "picked"; ref: Picked } | { kind: "ambiguous"; candidates: readonly InstructorCandidate[] };

/**
 * 강사: 질문 앞쪽에서부터 처음 걸린 이름 하나를 본다.
 * 동명이인이면 질문의 학원 이름으로 한 번 더 좁혀 보고, 그래도 여럿이면 고르지 않고 후보를 돌려준다.
 */
async function pickInstructor(finders: PlainSearchFinders, tokens: NameTokens, academy: Picked): Promise<InstructorPick> {
  const results = await Promise.all(tokens.words.map((name) => finders.findInstructors({ name, limit: CANDIDATE_LIMIT })));
  const index = results.findIndex((r) => r.resolution !== "none");
  if (index === -1) return { kind: "picked", ref: null };
  const first = results[index]!;
  const name = tokens.words[index]!;
  if (first.resolved !== null) return { kind: "picked", ref: { name, id: first.resolved.instructorId } };

  if (academy !== null) {
    const narrowed = await finders.findInstructors({ name, academyName: academy.name, limit: CANDIDATE_LIMIT });
    if (narrowed.resolved !== null) return { kind: "picked", ref: { name, id: narrowed.resolved.instructorId } };
  }
  return { kind: "ambiguous", candidates: first.candidates };
}

/**
 * 모델 없이 질문 글자만으로 찾는 일반 검색(FR-041(추천 시간 초과 대체)).
 * 순서: 이름 토큰 → 학원 → 강사 → (이름이 하나라도 정해지면) search_offerings → 0건이면 결과 없음(SX-5.4).
 */
/** 화면이 미리 정해 보낸 값(계약 16 §3 `context`). 지금은 강사 하나뿐이다 */
export type PlainSearchFixed = Readonly<{ instructorId: string | null }>;

/** 계약 16 §5-1 열한 칸. 에이전트 조건에서 이 칸만 검색 입력으로 옮긴다 */
const CONDITION_KEYS = [
  "instructor",
  "academy",
  "genre",
  "weekdays",
  "timeBand",
  "level",
  "regionSido",
  "regionGu",
  "maxPriceAmount",
  "dateFrom",
  "dateTo",
] as const;

/**
 * SX-4.3(시간 초과 대체) — 에이전트가 시간 안에 못 끝냈지만 조건(conditions 이벤트)은 이미 보냈을 때의 필터 검색.
 * 왜: 추천은 「조건 뽑기 → 검색 → 고르기(모델)」 순이라, 고르기에서 멈추면 조건은 이미 정해져 있다.
 *     그 조건을 버리고 질문 글자에서 이름만 찾으면 「강남 평일 저녁 살사」 같은 이름 없는 질문은 빈손이 된다(FR-041).
 * 에이전트 값은 믿지 않는다 — search_offerings 와 같은 입력 규칙(searchOfferingsInputSchema)을 통과할 때만 쓰고,
 * 안 맞으면(이름만 있고 id 없음·모르는 장르·조건 없음) null 을 돌려 이름 검색으로 돌아가게 한다.
 */
async function runAgentConditionSearch(finders: PlainSearchFinders, agentConditions: unknown): Promise<PlainSearchReply | null> {
  if (typeof agentConditions !== "object" || agentConditions === null || Array.isArray(agentConditions)) return null;
  const raw = agentConditions as Record<string, unknown>;
  // 열한 칸만 옮긴다. 빈 요일 배열은 「조건 없음」으로 본다(에이전트 _search_input 과 같은 규칙)
  const picked = Object.fromEntries(
    CONDITION_KEYS.map((key) => [key, Array.isArray(raw[key]) && raw[key].length === 0 ? null : (raw[key] ?? null)]),
  );
  const parsed = searchOfferingsInputSchema.safeParse({ ...picked, limit: PLAIN_SEARCH_CARD_LIMIT });
  if (!parsed.success) return null;

  const { limit: _limit, ...conditions } = parsed.data;
  const found = await finders.searchOfferings(parsed.data);
  // 「모집 중」만 보기(SX-5.8 이어 묻기 칸)면 다 찬 수업은 뺀다 — 에이전트 경로(planner_run)와 같은 규칙
  const cards = raw.recruitOpenOnly === true ? found.filter((c) => c.recruitStatus !== "full") : found;
  const noResult = buildNoResultReply(conditions, cards);
  return noResult === null
    ? { kind: "offering_cards", cards, conditions }
    : { kind: "no_offering_result", reply: noResult, conditions };
}

/**
 * agentConditions — 에이전트가 시간 초과 전에 보낸 조건(SX-4.3). 검색 규칙에 맞으면 그 조건으로 찾고,
 * 없거나 안 맞으면 아래 이름 검색(SX-5.5)으로 간다.
 */
export async function runPlainSearch(
  finders: PlainSearchFinders,
  question: string,
  fixed: PlainSearchFixed = { instructorId: null },
  agentConditions: unknown = null,
): Promise<PlainSearchReply> {
  const byConditions = await runAgentConditionSearch(finders, agentConditions);
  if (byConditions !== null) return byConditions;

  const tokens = extractNameTokens(question);
  const academy = await pickAcademy(finders, tokens);
  // 강사가 이미 정해져 왔으면(M15 입구·M10G 선택) 글자에서 다시 고르지 않는다 — 동명이인 후보 카드가 또 나오지 않게.
  // 공개 강사가 아니면(숨겨졌거나 id 가 틀림) 정해진 값을 버리고 글자로 찾는다
  const fixedCard =
    fixed.instructorId !== null && finders.findInstructorById !== undefined ? await finders.findInstructorById(fixed.instructorId) : null;
  const instructor: InstructorPick =
    fixedCard !== null
      ? { kind: "picked", ref: { name: fixedCard.displayName, id: fixedCard.instructorId } }
      : await pickInstructor(finders, tokens, academy);

  if (instructor.kind === "ambiguous") return { kind: "instructor_candidates", candidates: instructor.candidates };
  // 이름이 하나도 없으면 검색하지 않는다(조건 없음 검색 금지, 계약 16 §5-1)
  if (instructor.ref === null && academy === null) return { kind: "need_name" };

  // 계약 16 §5-1 열한 칸. 이름 말고는 모두 비운다
  const conditions: SearchConditions = {
    instructor: instructor.ref,
    academy,
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
  // weekdays 는 읽기 전용 배열 타입이라 입력 타입에 맞춰 null 로 다시 적는다(값은 같다)
  const cards = await finders.searchOfferings({ ...conditions, weekdays: null, limit: PLAIN_SEARCH_CARD_LIMIT });
  const noResult = buildNoResultReply(conditions, cards);
  return noResult === null
    ? { kind: "offering_cards", cards, conditions }
    : { kind: "no_offering_result", reply: noResult, conditions };
}

// ---- 스트림 조각으로 바꾸기 ----------------------------------------------------------------------------------

/** 왜 대체했나 — 화면은 이 값으로 「AI 가 늦어요」 표시를 고르고, 기록 Task 가 ai_runs 에 남긴다 */
export type PlainSearchReason = "first_event_timeout" | "timeout" | "agent_unavailable" | "agent_error";

/**
 * 일반 검색 결과 → AI SDK UI 조각. 이미 나간 조각은 되돌리지 않고 그 뒤에 잇는다(계약 16 §3-1).
 *   data-fallback(대체 표시) → 글 상자에 안내 문장(이미 열려 있으면 줄을 바꿔 이어 씀) → 카드·결과 없음 → 닫기
 * 글·카드·닫기는 SX-1.5 번역기(translateAgentEvent)에 에이전트 이벤트 모양으로 넣어 만든다 — 조각 규칙이 한 곳에만 있게.
 */
export function plainSearchChunks(reply: PlainSearchReply, reason: PlainSearchReason, start: TranslateState): Translation {
  const parts: UIMessageChunk[] = [{ type: "data-fallback", data: { kind: "plain_search", reason } }];
  let state = start;
  const push = (translation: Translation) => {
    parts.push(...translation.parts);
    state = translation.state;
  };

  const lines: string[] = [PLAIN_SEARCH_NOTICE];
  if (reply.kind === "instructor_candidates") lines.push(PLAIN_SEARCH_PICK_INSTRUCTOR);
  if (reply.kind === "need_name") lines.push(PLAIN_SEARCH_NEED_NAME);
  if (reply.kind === "no_offering_result") lines.push(reply.reply.sentence, reply.reply.hint);
  // 찾은 조건(이름 칩, M10F). 에이전트의 conditions 이벤트와 같은 조각(data-conditions, 기록에 안 남음)으로 낸다
  if (reply.kind === "offering_cards" || reply.kind === "no_offering_result") {
    push(translateAgentEvent({ event: "conditions", data: { ...reply.conditions } }, state));
  }
  const sentence = `${state.textOpen ? "\n" : ""}${lines.join("\n")}`;
  push(translateAgentEvent({ event: "text", data: { sentence } }, state));

  if (reply.kind === "offering_cards") {
    push(translateAgentEvent({ event: "cards", data: { kind: "offering_cards", items: [...reply.cards] } }, state));
  }
  if (reply.kind === "instructor_candidates") {
    push(translateAgentEvent({ event: "cards", data: { kind: "instructor_candidates", items: [...reply.candidates] } }, state));
  }
  if (reply.kind === "no_offering_result") {
    // 넓히기 버튼 값(SX-5.4). 기록에 남겨 대화를 다시 열어도 버튼이 보이게 한다
    parts.push({ type: "data-no-result", data: reply.reply });
  }
  // done 은 글 상자를 닫고 finish 를 낸다. 측정값은 스트림에 싣지 않는다
  push(translateAgentEvent({ event: "done", data: { metrics: { fallbackUsed: true } } }, state));
  return { parts, state };
}
