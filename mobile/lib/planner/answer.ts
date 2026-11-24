/**
 * AI 플래너 답 읽기 — `POST /api/ai/chat` 응답(AI SDK UI 스트림)을 화면이 그릴 값 하나로 바꾼다(SX-5.7).
 *
 * 처음 보는 사람용 요약
 *  - 서버(Next.js)는 답을 `data: {...}` 줄 여러 개로 보낸다(계약 16 §3-3). 한 줄이 「조각」 하나다.
 *    글 조각(text-delta), 조건 칩(data-conditions), 수업 카드(data-cards), 결과 없음(data-no-result),
 *    대체 표시(data-fallback), 실패(data-error) 등이 섞여 온다.
 *  - 이 파일은 그 조각들을 모아 `PlannerAnswer` 하나로 만든다. 화면은 이 값만 보고 그린다.
 *  - **서버 값을 믿고 그대로 쓰지 않는다.** 모양이 틀린 카드는 버리고, 카드의 이동 경로는
 *    서버가 준 글자가 아니라 id 로 앱이 직접 만든다(계약 16 §5-2 「신청하기는 수업 상세로만」, SX-5.6).
 *    그래서 카드 버튼은 예약·결제 경로로 갈 수 없다.
 *  - 순수 함수만 있다. 입력을 바꾸지 않는다.
 *  - SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)이 더한 것: 답이 오는 중에도 읽을 수 있게 「다 온 줄까지만」 자르기,
 *    이어 묻기에 돌려보낼 앞 조건(`carryConditions`), 지금 단계(`stage`), 답 아래 추천 질문 칩(`followUpSuggestions`).
 */
import type { Genre } from '../onboarding/types';

// ---------------------------------------------------------------- 값 모양(계약 16 §5)

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface NameRef {
  name: string;
  id: string | null;
}

/** 찾은 조건(§5-1). 화면은 이름 칩(강사·학원)과 요일·시간대·레벨·모집 중 칩만 그린다 */
export interface PlannerConditions {
  instructor: NameRef | null;
  academy: NameRef | null;
  weekdays: readonly Weekday[] | null;
  timeBand: string | null;
  level: string | null;
  /** 「모집 중」만 보기(SX-5.8) */
  recruitOpenOnly: boolean;
}

/** 수업 카드(§5-2 offering_cards) — 화면에 쓰는 칸만 */
export interface PlannerOfferingCard {
  offeringId: string | null;
  classId: string;
  title: string;
  isPrivateLesson: boolean;
  academyName: string;
  hall: string | null;
  pattern: readonly { weekday: Weekday; startTime: string; endTime: string }[];
  firstSessionDate: string | null;
  lastSessionDate: string | null;
  sessionCount: number | null;
  level: string | null;
  pools: readonly { seatKind: string; remaining: number }[];
  priceAmount: number;
  recruitStatus: 'open' | 'closing_soon' | 'full';
  waitlistAvailable: boolean;
}

/** 강사 후보 카드(§5-2 instructor_candidates, 보드 M10G) */
export interface PlannerInstructorCandidate {
  instructorId: string;
  displayName: string;
  photoUrl: string | null;
  genres: readonly Genre[];
  academies: readonly { id: string; name: string }[];
  publishedOfferingCount: number;
}

/** 결과 없음의 넓히기 버튼(SX-5.4 widen_search) */
export interface PlannerWidenAction {
  label: string;
  instructor: NameRef | null;
  academy: NameRef | null;
}

export interface PlannerAnswer {
  /** 글 상자 글(서버가 준 문장 그대로. 여러 줄일 수 있다) */
  text: string;
  conditions: PlannerConditions | null;
  offeringCards: readonly PlannerOfferingCard[];
  instructorCandidates: readonly PlannerInstructorCandidate[];
  /** 결과 없음 — null 이면 결과가 있거나 다른 답 */
  noResult: { sentence: string; hint: string; actions: readonly PlannerWidenAction[] } | null;
  /** 에이전트 대신 일반 검색으로 답했는지(SX-5.5) */
  usedPlainSearch: boolean;
  /** 서버가 실패로 닫았는지(data-error) */
  failed: boolean;
  /**
   * 이어 묻기(SX-5.8) 때 서버에 그대로 돌려보낼 앞 조건(계약 16 §3 `context.previousConditions`).
   * 서버가 준 조건 중 계약에 있는 칸만 골라 둔다. 대화 맥락은 이 화면 안에서만 쓰고 서버에 저장하지 않는다
   */
  carryConditions: Json | null;
  /** 에이전트가 지금 하는 단계(conditions·candidates·writing…). 답이 오는 중 「입력 중」 옆 글자에 쓴다 */
  stage: string | null;
}

// ---------------------------------------------------------------- 작은 검사 도구

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// id 는 uuid 모양만 받는다 — 경로에 넣을 값이라 다른 글자는 믿지 않는다
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown): string | null => {
  const text = str(value);
  return text !== null && UUID.test(text) ? text : null;
};
const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const isWeekday = (value: unknown): value is Weekday => WEEKDAYS.includes(value as Weekday);

function readNameRef(value: unknown): NameRef | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  return name === null ? null : { name, id: uuidOrNull(value.id) };
}

function readConditions(value: unknown): PlannerConditions | null {
  if (!isRecord(value)) return null;
  const weekdays = Array.isArray(value.weekdays) ? value.weekdays.filter(isWeekday) : null;
  // 시간대는 이름(morning…) 또는 {from,to}. 칩 글자로만 쓰므로 글자로 줄인다
  const band = value.timeBand;
  const timeBand = typeof band === 'string' ? band : isRecord(band) ? `${str(band.from) ?? ''}–${str(band.to) ?? ''}` : null;
  return {
    instructor: readNameRef(value.instructor),
    academy: readNameRef(value.academy),
    weekdays,
    timeBand,
    level: str(value.level),
    recruitOpenOnly: value.recruitOpenOnly === true,
  };
}

/** 이어 묻기로 돌려보낼 수 있는 칸(계약 16 §5-1 열한 칸 + 「모집 중」만 보기). 서버 검사가 모르는 칸을 막으므로 이 밖은 버린다 */
const CARRY_KEYS = [
  'instructor',
  'academy',
  'genre',
  'weekdays',
  'timeBand',
  'level',
  'regionSido',
  'regionGu',
  'maxPriceAmount',
  'dateFrom',
  'dateTo',
  'recruitOpenOnly',
] as const;

/** 서버 조건 → 이어 묻기용 사본. 값이 null 인 칸은 빼고, 이름 칸은 {name,id} 만 남긴다 */
function readCarryConditions(value: unknown): Json | null {
  if (!isRecord(value)) return null;
  const entries = CARRY_KEYS.flatMap((key): [string, unknown][] => {
    const v = value[key];
    if (v === null || v === undefined) return [];
    if (key === 'instructor' || key === 'academy') {
      if (!isRecord(v)) return [];
      return [[key, { name: str(v.name), id: uuidOrNull(v.id) }]];
    }
    return [[key, v]];
  });
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function readOfferingCard(value: unknown): PlannerOfferingCard | null {
  if (!isRecord(value)) return null;
  const classId = uuidOrNull(value.classId);
  const offeringId = uuidOrNull(value.offeringId);
  const title = str(value.title);
  const priceAmount = num(value.priceAmount);
  const isPrivateLesson = value.isPrivateLesson === true;
  // 정규 수업인데 판매 단위 id 가 없으면 상세로 갈 수 없다 — 버린다
  if (classId === null || title === null || priceAmount === null || (!isPrivateLesson && offeringId === null)) return null;
  const academy = isRecord(value.academy) ? str(value.academy.name) : null;
  const pattern = Array.isArray(value.pattern)
    ? value.pattern.flatMap((p) =>
        isRecord(p) && isWeekday(p.weekday) && str(p.startTime) !== null && str(p.endTime) !== null
          ? [{ weekday: p.weekday, startTime: p.startTime as string, endTime: p.endTime as string }]
          : [],
      )
    : [];
  const pools = Array.isArray(value.pools)
    ? value.pools.flatMap((p) => (isRecord(p) && str(p.seatKind) !== null && num(p.remaining) !== null ? [{ seatKind: p.seatKind as string, remaining: p.remaining as number }] : []))
    : [];
  const status = value.recruitStatus;
  return {
    offeringId,
    classId,
    title,
    isPrivateLesson,
    academyName: academy ?? '',
    hall: str(value.hall),
    pattern,
    firstSessionDate: str(value.firstSessionDate),
    lastSessionDate: str(value.lastSessionDate),
    sessionCount: num(value.sessionCount),
    level: str(value.level),
    pools,
    priceAmount,
    recruitStatus: status === 'full' || status === 'closing_soon' ? status : 'open',
    waitlistAvailable: value.waitlistAvailable === true,
  };
}

function readCandidate(value: unknown): PlannerInstructorCandidate | null {
  if (!isRecord(value)) return null;
  const instructorId = uuidOrNull(value.instructorId);
  const displayName = str(value.displayName);
  if (instructorId === null || displayName === null) return null;
  const photo = str(value.photoUrl);
  return {
    instructorId,
    displayName,
    // 사진은 서버 파일 경로(/api/files/…)만 받는다
    photoUrl: photo !== null && photo.startsWith('/api/files/') ? photo : null,
    genres: Array.isArray(value.genres) ? (value.genres.filter((g) => typeof g === 'string') as Genre[]) : [],
    academies: Array.isArray(value.academies)
      ? value.academies.flatMap((a) => (isRecord(a) && uuidOrNull(a.id) !== null && str(a.name) !== null ? [{ id: a.id as string, name: a.name as string }] : []))
      : [],
    publishedOfferingCount: num(value.publishedOfferingCount) ?? 0,
  };
}

function readNoResult(value: unknown): PlannerAnswer['noResult'] {
  if (!isRecord(value)) return null;
  const actions = Array.isArray(value.actions)
    ? value.actions.flatMap((a) => {
        if (!isRecord(a) || a.type !== 'widen_search' || str(a.label) === null || !isRecord(a.conditions)) return [];
        return [{ label: a.label as string, instructor: readNameRef(a.conditions.instructor), academy: readNameRef(a.conditions.academy) }];
      })
    : [];
  return { sentence: str(value.sentence) ?? '', hint: str(value.hint) ?? '', actions };
}

// ---------------------------------------------------------------- 조각 → 답

/**
 * 답이 오는 중의 글자에서 **끝까지 온 줄만** 남긴다. 마지막 줄은 반쯤 온 JSON 일 수 있어 다음 조각을 기다린다.
 * 스트림이 끝난 뒤에는 이 함수를 거치지 않고 전체를 읽는다.
 */
export function completeLines(raw: string): string {
  const end = raw.lastIndexOf('\n');
  return end < 0 ? '' : raw.slice(0, end + 1);
}

/** 응답 글자 → 조각 목록. 줄마다 `data: ` 뒤가 JSON 하나다. 끝 표시 `[DONE]`·읽을 수 없는 줄은 건너뛴다 */
export function parseUiChunks(raw: string): Json[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .flatMap((payload) => {
      try {
        const value: unknown = JSON.parse(payload);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
}

const EMPTY_ANSWER: PlannerAnswer = {
  text: '',
  conditions: null,
  offeringCards: [],
  instructorCandidates: [],
  noResult: null,
  usedPlainSearch: false,
  failed: false,
  carryConditions: null,
  stage: null,
};

/**
 * 글 조각 잇기. 에이전트는 문장 하나를 조각 하나로 보내고 문장 끝에 띄어쓰기를 붙이지 않는다.
 * 앞 글이 문장 끝(. ! ?)으로 끝나면 한 칸 띄워 잇는다 — 「3개예요.강사」처럼 붙지 않게
 */
function joinText(before: string, delta: string): string {
  if (before === '' || delta === '' || /\s$/.test(before) || /^\s/.test(delta)) return before + delta;
  return /[.!?]$/.test(before) ? `${before} ${delta}` : before + delta;
}

/** 조각 목록 → 화면 값. 조각 하나씩 새 값을 만들어 쌓는다(앞 값을 고치지 않는다) */
export function buildPlannerAnswer(chunks: readonly Json[]): PlannerAnswer {
  return chunks.reduce<PlannerAnswer>((answer, chunk) => {
    switch (chunk.type) {
      case 'text-delta':
        return { ...answer, text: joinText(answer.text, str(chunk.delta) ?? '') };
      case 'data-conditions':
        return { ...answer, conditions: readConditions(chunk.data), carryConditions: readCarryConditions(chunk.data) };
      case 'data-stage': {
        const data = isRecord(chunk.data) ? chunk.data : {};
        return { ...answer, stage: str(data.name) };
      }
      case 'data-cards': {
        const data = isRecord(chunk.data) ? chunk.data : {};
        const items = Array.isArray(data.items) ? data.items : [];
        if (data.kind === 'offering_cards') {
          return { ...answer, offeringCards: items.flatMap((i) => readOfferingCard(i) ?? []) };
        }
        if (data.kind === 'instructor_candidates') {
          return { ...answer, instructorCandidates: items.flatMap((i) => readCandidate(i) ?? []) };
        }
        return answer;
      }
      case 'data-no-result':
        return { ...answer, noResult: readNoResult(chunk.data) };
      case 'data-fallback':
        return { ...answer, usedPlainSearch: true };
      case 'data-error':
        return { ...answer, failed: true };
      default:
        return answer;
    }
  }, EMPTY_ANSWER);
}

// ---------------------------------------------------------------- 카드 버튼이 가는 곳

/**
 * 「신청하기」·「대기 신청」이 가는 곳 — 수업 상세뿐이다(SX-5.6 · 계약 16 §5-2, 서버 offeringCardDestination 과 같은 규칙).
 * 개인 레슨 구매 화면(M15B)은 아직 없어 null — 버튼을 닫아 둔다.
 */
export function offeringCardHref(card: PlannerOfferingCard): `/offering/${string}` | null {
  if (card.isPrivateLesson || card.offeringId === null) return null;
  return `/offering/${card.offeringId}`;
}

/** 넓히기 버튼을 눌렀을 때 다시 보낼 질문과 정해 둘 강사(계약 16 §5-2 widen_search — 그 조건으로 다시 찾는다) */
export function widenRequest(action: PlannerWidenAction): { message: string; instructorId: string | null } {
  const parts = [action.instructor !== null ? `${action.instructor.name} 강사님` : null, action.academy?.name ?? null].filter(
    (p): p is string => p !== null,
  );
  return { message: `${parts.join(' ')} 수업 모두 알려줘`.trim(), instructorId: action.instructor?.id ?? null };
}

// ---------------------------------------------------------------- 답 아래 추천 질문 칩(SX-5.8)

const WEEKDAY_FULL: Readonly<Record<Weekday, string>> = {
  mon: '월요일',
  tue: '화요일',
  wed: '수요일',
  thu: '목요일',
  fri: '금요일',
  sat: '토요일',
  sun: '일요일',
};
const LEVEL_WORD: Readonly<Record<string, string>> = {
  entry: '입문',
  beginner: '초급',
  novice_intermediate: '초중급',
  intermediate: '중급',
  advanced: '고급',
};
/** 칩은 많아야 셋(2026-11-24 사용자 지시 「추천 질문 칩 2~3개」) */
const MAX_SUGGESTIONS = 3;

/**
 * 답 아래에 붙일 이어 묻기 질문 2~3개. **받은 카드·조건 값으로만** 만든다 — 카드에 없는 요일·레벨을 권하지 않는다.
 * 누르면 그 글이 다음 질문이 되고, 앞 답의 조건을 실어 보내 좁힌다(서버 follow_up 규칙).
 *  ① 카드 요일이 둘 이상이면 「그중 ○요일만」 ② 카드 레벨이 둘 이상이고 레벨을 아직 안 정했으면 「○○만」
 *  ③ 마감 카드가 섞여 있으면 「모집 중인 것만」 ④ 학원을 정해 찾았으면 「모든 학원 수업 보기」
 *  ⑤ 강사만 정하고 요일은 안 정했으면 「주말 수업만」
 */
export function followUpSuggestions(answer: PlannerAnswer): string[] {
  const cards = answer.offeringCards;
  if (cards.length === 0) return [];
  const conditions = answer.conditions;
  const weekdays = WEEKDAYS.filter((w) => cards.some((c) => c.pattern.some((p) => p.weekday === w)));
  const levels = [...new Set(cards.flatMap((c) => (c.level !== null && LEVEL_WORD[c.level] !== undefined ? [c.level] : [])))];
  const firstLevel = levels[0];
  const firstWeekday = weekdays[0];
  const candidates: (string | null)[] = [
    weekdays.length > 1 && firstWeekday !== undefined ? `그중 ${WEEKDAY_FULL[firstWeekday]}만` : null,
    levels.length > 1 && conditions?.level == null && firstLevel !== undefined ? `${LEVEL_WORD[firstLevel]}만 보여줘` : null,
    cards.some((c) => c.recruitStatus === 'full') && conditions?.recruitOpenOnly !== true ? '모집 중인 것만' : null,
    conditions?.instructor != null && conditions.academy != null ? '모든 학원 수업 보여줘' : null,
    conditions?.instructor != null && (conditions.weekdays ?? []).length === 0 ? '주말 수업만' : null,
  ];
  return candidates.filter((t): t is string => t !== null).slice(0, MAX_SUGGESTIONS);
}
