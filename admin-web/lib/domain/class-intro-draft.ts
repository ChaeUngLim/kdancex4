// SX-6.6(소개 문구 초안) — 수업 정보와 「강조할 점」 한 줄로 소개 문구 초안을 만드는 규칙(DB·모델 없이 도는 순수 코드).
//   계약: _workspace/03_contracts/16-ai-agent.md §4-7 `POST /api/ai/class-intro-drafts` · `POST /v1/intro-drafts`
//   요구: FR-061(수업 소개 문구 생성) · FR-258(AI 생성 표시) · FR-270(입력 지시문은 데이터)
//
// 핵심 규칙 — 「숫자는 모델이 쓰지 않는다」
//   모델(대화 모델)은 숫자를 그럴듯하게 지어낼 수 있다. 시간·가격·회차가 틀린 소개 문구는 환불 분쟁으로 이어진다.
//   그래서 모델에게는 숫자 대신 자리표시자(`{{schedule}}` 같은 표)를 쓰게 하고, 그 자리를 수업 데이터 값으로
//   이 파일의 순수 함수가 채운다. 모델이 자리표시자 밖에 숫자를 하나라도 쓰면 그 문장은 버린다.
//
// 흐름(서비스 class-intro-drafts.ts 가 이 순서로 부른다)
//   ① parseIntroEmphasis — 강조할 점 검사(선택, 60자 이하. 61자는 거부)
//   ② buildIntroFacts    — 수업 데이터 → 채울 값(facts). 시간·가격·회차 중 빈 것이 있으면 만들 수 없다
//   ③ buildIntroAgentPayload — 에이전트에게 보낼 것. 수업 이름·장르·강조할 점·「어떤 자리표시자를 쓸 수 있나」뿐이다.
//      홍보 이미지의 칩·그림 문장(조명·색감)은 넣지 않는다 — 소개 문구에 그림 묘사가 섞이지 않게(SX-6 method)
//   ④ fillIntroTemplate  — 모델이 돌려준 틀을 검사하고 facts 로 채운다. 틀이 규칙을 어기면 거부(서비스가 한 번 다시 만든다)
//   ⑤ fallbackIntroBody  — 두 번 다 거부되면 facts 만 나열한 기본 문장
import { z } from "zod";

import type { ClassTargetLevel, Genre } from "./constants";
import { countSessions, type ClassPayload } from "./class-registration";
import type { Weekday } from "./recurring-schedule";
import { parseKstDate } from "./time";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 강조할 점 최대 글자 수(계약 16 §4-7 · data-model ck_intro_emphasis_len). 61자는 422 */
export const INTRO_EMPHASIS_MAX = 60;
/** 완성된 소개 문구 최대 글자 수 — 저장 칸 class_promo_assets.intro_text 상한(600)과 같다 */
export const INTRO_BODY_MAX = 600;

/**
 * 모델이 쓸 수 있는 자리표시자. 앞의 넷은 계약에 적힌 수업 사실이고,
 * title·emphasis 는 이 Task 가 더한 것이다(추천안·사후 확인 2026-11-24) — 수업 이름(「8주 완성」처럼 숫자가 든 이름)과
 * 강조할 점(「8주 동안」)은 사람이 쓴 글이라 모델이 옮겨 적다가 숫자 검사에 걸리지 않도록 자리로 받는다.
 */
export const INTRO_PLACEHOLDERS = ["schedule", "sessionCount", "price", "level", "title", "emphasis"] as const;
export type IntroPlaceholder = (typeof INTRO_PLACEHOLDERS)[number];
/** 소개 문구에 반드시 들어가야 하는 사실(수용 ④ 「시간·가격·회차는 수업 데이터 값 그대로」) */
export const INTRO_REQUIRED_FACTS = ["schedule", "sessionCount", "price"] as const;
export type IntroRequiredFact = (typeof INTRO_REQUIRED_FACTS)[number];

const WEEKDAY_KO: Record<Weekday, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
// Temporal 의 dayOfWeek 는 1(월)~7(일)
const DAY_OF_WEEK_KO = ["월", "화", "수", "목", "금", "토", "일"] as const;
const LEVEL_KO: Record<ClassTargetLevel, string> = {
  entry: "입문",
  beginner: "초급",
  novice_intermediate: "초중급",
  intermediate: "중급",
  advanced: "고급",
};
const GENRE_KO: Record<Genre, string> = {
  dance_sport: "댄스스포츠",
  argentine_tango: "아르헨티나 탱고",
  swing: "스윙",
  salsa_bachata: "살사 · 바차타",
};

// ---- ① 강조할 점 ------------------------------------------------------------------------------

/** 글자 수는 화면에 보이는 글자 단위로 센다(이모지 한 개를 2로 세지 않게 코드 포인트로) */
const charCount = (text: string): number => [...text].length;

/**
 * 요청 본문 모양. emphasis 는 선택이고, 앞뒤 공백을 뗀 뒤 60자 이하여야 한다. 빈 글자는 「안 보냄」과 같다.
 */
export const introDraftRequestSchema = z.strictObject({
  classId: z.uuid(),
  emphasis: z
    .string()
    .trim()
    .refine((text) => charCount(text) <= INTRO_EMPHASIS_MAX, `강조할 점은 ${INTRO_EMPHASIS_MAX}자까지 쓸 수 있어요`)
    .nullish()
    .transform((text) => (text === undefined || text === null || text === "" ? null : text)),
});
export type IntroDraftRequest = z.infer<typeof introDraftRequestSchema>;

export type EmphasisCheck = { ok: true; emphasis: string | null } | { ok: false; message: string };

/** 강조할 점만 따로 볼 때(화면 글자 수 안내 등). 규칙은 위 스키마와 같다 */
export function parseIntroEmphasis(raw: string | null | undefined): EmphasisCheck {
  const text = (raw ?? "").trim();
  if (charCount(text) > INTRO_EMPHASIS_MAX) return { ok: false, message: `강조할 점은 ${INTRO_EMPHASIS_MAX}자까지 쓸 수 있어요` };
  return { ok: true, emphasis: text === "" ? null : text };
}

// ---- ② 수업 데이터 → 채울 값 -------------------------------------------------------------------

/** 자리에 채울 값. 계약 응답의 `facts` 와 같은 모양이다 */
export type IntroFacts = {
  schedule: string;
  sessionCount: number;
  price: string;
  level: string | null;
};

export type IntroFactsResult = { ok: true; facts: IntroFacts } | { ok: false; missing: IntroRequiredFact[] };

/** 금액 → 「300,000원」. 0원은 「무료」(추천안 — 0원 이벤트형 수업, FR-099d) */
export function formatIntroPrice(amount: number): string {
  if (amount === 0) return "무료";
  return `${amount.toLocaleString("ko-KR")}원`;
}

/** 일정 → 「월·수 20:30–21:30」(요일 반복) 또는 「12월 6일(토) 19:00–21:00」(하루) */
export function formatIntroSchedule(schedule: NonNullable<ClassPayload["schedule"]>): string {
  const time = `${schedule.startTime}–${schedule.endTime}`;
  if (schedule.kind === "recurring") {
    // 요일은 고른 순서가 아니라 월→일 순서로(같은 수업이면 늘 같은 글자가 나오게)
    const order = Object.keys(WEEKDAY_KO) as Weekday[];
    const days = order.filter((day) => schedule.weekdays.includes(day)).map((day) => WEEKDAY_KO[day]);
    return `${days.join("·")} ${time}`;
  }
  const date = parseKstDate(schedule.date);
  return `${date.month}월 ${date.day}일(${DAY_OF_WEEK_KO[date.dayOfWeek - 1]}) ${time}`;
}

/**
 * 수업 데이터(임시 저장 값)에서 채울 값을 만든다. 시간·가격·회차 중 하나라도 없으면 만들 수 없다
 * (→ 409 INTRO_FACTS_MISSING). 레벨은 없어도 된다 — 그때는 모델에게 레벨 자리를 쓰지 말라고 알린다.
 */
export function buildIntroFacts(payload: Pick<ClassPayload, "schedule" | "priceAmount" | "targetLevel">): IntroFactsResult {
  const missing: IntroRequiredFact[] = [];
  const sessionCount = countSessions(payload.schedule);
  if (payload.schedule === null) missing.push("schedule");
  if (sessionCount === null) missing.push("sessionCount");
  if (payload.priceAmount === null) missing.push("price");
  if (missing.length > 0 || payload.schedule === null || sessionCount === null || payload.priceAmount === null) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    facts: {
      schedule: formatIntroSchedule(payload.schedule),
      sessionCount,
      price: formatIntroPrice(payload.priceAmount),
      level: payload.targetLevel === null ? null : LEVEL_KO[payload.targetLevel],
    },
  };
}

// ---- ③ 에이전트에게 보낼 것 ---------------------------------------------------------------------

/** `POST /v1/intro-drafts` 요청 본문. 숫자 값(facts)은 싣지 않는다 — 모델이 숫자를 볼 일이 없게 */
export type IntroAgentPayload = {
  classTitle: string;
  genre: string | null;
  emphasis: string | null;
  /** 이 수업에서 쓸 수 있는 자리표시자(레벨이 없으면 level 이 빠지고, 강조할 점이 없으면 emphasis 가 빠진다) */
  placeholders: IntroPlaceholder[];
};

/**
 * 에이전트 요청을 만든다. 넣는 것은 위 네 칸뿐이다 — 홍보 이미지의 칩·그림 문장은 받지도 않는다.
 * 강조할 점은 사람이 쓴 글이라 「데이터」로만 넘긴다(FR-270). 에이전트는 user 칸 JSON 으로 싣는다.
 */
export function buildIntroAgentPayload(input: {
  title: string;
  genre: Genre | null;
  facts: IntroFacts;
  emphasis: string | null;
}): IntroAgentPayload {
  const placeholders = INTRO_PLACEHOLDERS.filter(
    (name) => !(name === "level" && input.facts.level === null) && !(name === "emphasis" && input.emphasis === null),
  );
  return {
    classTitle: input.title,
    genre: input.genre === null ? null : GENRE_KO[input.genre],
    emphasis: input.emphasis,
    placeholders,
  };
}

// ---- ④ 틀 검사 + 채우기 --------------------------------------------------------------------------

export type IntroTemplateRejection = "digit_outside_placeholder" | "unknown_placeholder" | "too_long" | "empty";
export type IntroFillResult = { ok: true; body: string } | { ok: false; reason: IntroTemplateRejection };

const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*\}\}/g;
// 아라비아 숫자와 전각 숫자. 한글 수사(「열여섯」)는 낱말 판정이 오탐이 많아 보지 않는다(추천안·사후 확인 2026-11-24)
const DIGIT = /[0-9０-９]/;

/** 자리 하나에 들어갈 글자. 회차는 「16회」로 단위까지 채운다 */
function placeholderText(name: IntroPlaceholder, facts: IntroFacts, extra: { title: string; emphasis: string | null }): string {
  switch (name) {
    case "schedule":
      return facts.schedule;
    case "sessionCount":
      return `${facts.sessionCount}회`;
    case "price":
      return facts.price;
    case "level":
      return facts.level ?? "";
    case "title":
      return extra.title;
    case "emphasis":
      return extra.emphasis ?? "";
  }
}

/**
 * 모델이 준 틀(bodyTemplate)을 검사하고 수업 데이터로 채운다.
 *   - 자리표시자를 뺀 나머지 글에 숫자가 있으면 거부 — 모델이 숫자를 직접 쓴 것이다
 *   - 모르는 자리표시자, 이 수업에서 쓸 수 없는 자리(레벨 없음·강조할 점 없음)를 쓰면 거부
 *   - 시간·가격·회차 자리 중 빠진 것이 있으면 끝에 「월·수 20:30–21:30 · 16회 · 300,000원.」처럼 붙인다
 *     (모델이 하나를 빠뜨려도 소개 문구에는 세 값이 반드시 데이터 그대로 들어가게)
 *   - 완성 문장이 600자를 넘으면 거부
 */
export function fillIntroTemplate(
  template: string,
  facts: IntroFacts,
  extra: { title: string; emphasis: string | null },
): IntroFillResult {
  const trimmed = template.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // 자리표시자 밖의 숫자 — 자리를 지운 글에서 찾는다
  if (DIGIT.test(trimmed.replace(PLACEHOLDER, ""))) return { ok: false, reason: "digit_outside_placeholder" };

  const allowed = new Set<string>(INTRO_PLACEHOLDERS);
  const used = new Set<IntroPlaceholder>();
  for (const match of trimmed.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!allowed.has(name)) return { ok: false, reason: "unknown_placeholder" };
    const placeholder = name as IntroPlaceholder;
    if ((placeholder === "level" && facts.level === null) || (placeholder === "emphasis" && extra.emphasis === null)) {
      return { ok: false, reason: "unknown_placeholder" };
    }
    used.add(placeholder);
  }

  // 채우기. 모델이 「{{sessionCount}}회」처럼 단위를 또 붙였으면 한 번만 남긴다
  const filled = trimmed
    .replace(/\{\{\s*sessionCount\s*\}\}\s*회/g, "{{sessionCount}}")
    .replace(PLACEHOLDER, (_whole, name: string) => placeholderText(name as IntroPlaceholder, facts, extra));

  const missingFacts = INTRO_REQUIRED_FACTS.filter((name) => !used.has(name));
  const tail = missingFacts.length === 0 ? "" : ` ${missingFacts.map((name) => placeholderText(name, facts, extra)).join(" · ")}.`;
  const body = `${filled}${tail}`.replace(/\s+/g, " ").trim();
  if (charCount(body) > INTRO_BODY_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, body };
}

// ---- ⑤ 기본 문장 ---------------------------------------------------------------------------------

/**
 * 모델 틀이 두 번 다 거부됐을 때 쓰는 문장 — 수업 데이터만 나열한다.
 * 예: 「살사 LA 입문. 월·수 20:30–21:30 · 16회 · 300,000원 · 입문. 처음 오는 분도 파트너 없이 신청할 수 있어요」
 */
export function fallbackIntroBody(facts: IntroFacts, extra: { title: string; emphasis: string | null }): string {
  const parts = [facts.schedule, `${facts.sessionCount}회`, facts.price, ...(facts.level === null ? [] : [facts.level])];
  const emphasis = extra.emphasis === null ? "" : ` ${extra.emphasis}`;
  return `${extra.title}. ${parts.join(" · ")}.${emphasis}`;
}

// ---- 다시 만들기 1회 + 기본 문장 ---------------------------------------------------------------------

/** 모델 틀 하나를 받아 오는 함수. 에이전트가 꺼졌거나 제한 시간을 넘기면 "unavailable" */
export type IntroTemplateWriter = () => Promise<{ template: string; model: string } | "unavailable">;

/** 틀을 몇 번까지 받아 보나 — 처음 1번 + 다시 만들기 1번(계약 16 §4-7 「거부하고 한 번 다시 만든다」) */
export const INTRO_TEMPLATE_ATTEMPTS = 2;

export type IntroDraftOutcome =
  | { kind: "ai"; body: string; model: string }
  | { kind: "fallback"; body: string; rejections: IntroTemplateRejection[] }
  | { kind: "unavailable" };

/**
 * 틀을 받아 채운다. 규칙을 어긴 틀은 버리고 한 번 더 받는다. 두 번 다 버리면 기본 문장.
 * 첫 번째부터 에이전트가 답하지 않으면 "unavailable"(→ 503, 앱은 손으로 쓰게 한다).
 * 다시 만들기에서 에이전트가 답하지 않으면 이미 facts 가 있으니 기본 문장으로 끝낸다.
 */
export async function draftIntroBody(
  write: IntroTemplateWriter,
  facts: IntroFacts,
  extra: { title: string; emphasis: string | null },
): Promise<IntroDraftOutcome> {
  const rejections: IntroTemplateRejection[] = [];
  for (let attempt = 0; attempt < INTRO_TEMPLATE_ATTEMPTS; attempt += 1) {
    const answer = await write();
    if (answer === "unavailable") {
      if (attempt === 0) return { kind: "unavailable" };
      break;
    }
    const filled = fillIntroTemplate(answer.template, facts, extra);
    if (filled.ok) return { kind: "ai", body: filled.body, model: answer.model };
    rejections.push(filled.reason);
  }
  return { kind: "fallback", body: fallbackIntroBody(facts, extra), rejections };
}
