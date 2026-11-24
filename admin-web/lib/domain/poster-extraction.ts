// SX-2.3(검토 API) — 포스터 읽기 칸의 값 모양 · 「확인필요」 판정 · 검토 끝난 칸 → 수업 임시 저장 본문(DB 없이 도는 순수 코드).
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6(포스터 읽기) · 11-instructor.md §4-2(임시 저장 본문) · 열린 점 ⑭
//   데이터: data-model §13-5(poster_extraction_fields) · §13-8(칸 키 17개 — 기간 칸 3개는 SX-2.6 에서 더함)
//   요구: FR-073(포스터 자동 추출) · FR-074(추출 검토 필수) · FR-075(확인필요 표시) · FR-258(AI 생성 표시)
//
// 처음 보는 사람용 요약
//   AI 가 포스터에서 읽은 값은 「수업 등록 양식의 칸 17개」에 하나씩 들어간다. 이 파일은 네 가지를 정한다.
//   ① 칸마다 들어갈 수 있는 값 모양(zod) — AI 결과(결과 전달)와 사람이 고친 값(PATCH) 모두 같은 규칙으로 거른다.
//      값 목록은 agent-server/app/poster/field_rules.py 와 같은 글자다(한쪽만 바꾸면 결과 전달이 422 로 막힌다)
//   ② 「확인필요」 — 값이 없거나, 신뢰도가 없거나, 기준(0.80)보다 낮으면 사람이 꼭 봐야 하는 칸이다
//   ③ 기간 칸(개강일·종료일·회차 수, SX-2.6) — 기간이 비면 검토에서 「맞아요」로 넘길 수 없고 채워야 제출할 수 있다(FR-073 하위 불릿)
//   ④ 검토 끝난 칸 → S2-2 수업 임시 저장 본문(POST /api/classes). 요일·시간·기간으로 일정(schedule)을 만든다.
//      포스터 칸에 없는 값(적정 연령 등)은 비워 둔다 — S2-2 승인 요청 검증이 「빠진 칸」으로 알려 주고, 사람이 수업 편집에서 채운다
import { z } from "zod";

import { EVENT_CLASS_KINDS } from "./class-registration";
import { CLASS_KINDS, CLASS_SUB_GENRES, CLASS_TARGET_LEVELS, GENRES, POSTER_FIELD_KEYS, type PosterFieldKey } from "./constants";
import { buildRecurringSessions, MAX_RECURRING_SESSIONS, WEEKDAYS } from "./recurring-schedule";

/**
 * 「확인필요」 기준 신뢰도(**추천값** — 계약 16 열린 점 ⑬). O2 보드의 71% 는 확인필요, 87%·92% 는 아님과 맞는다.
 * 설정 표(ai_settings `poster.confidence_min`)는 아직 없어 여기 한 곳에 둔다 — 설정 표가 생기면 이 값을 기본값으로만 쓴다.
 */
export const POSTER_CONFIDENCE_MIN = 0.8;

// 칸 값 상한 — agent-server field_rules.py 의 _TEXT_MAX · _PRICE_MAX · _CAPACITY_MAX 와 같은 수
const TEXT_MAX = 80;
const PRICE_MAX = 10_000_000;
const CAPACITY_MAX = 500;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// 기간 날짜의 연도 범위 — agent-server field_rules.py 의 _YEAR_MIN · _YEAR_MAX 와 같은 수
const YEAR_MIN = 2020;
const YEAR_MAX = 2100;

const text = z.string().trim().min(1).max(TEXT_MAX);
const time = z.string().regex(TIME, "시각은 HH:MM 으로 넣어 주세요");
const seats = z.int().min(1).max(CAPACITY_MAX);
// 날짜는 「YYYY-MM-DD」(KST 달력)이고 달력에 있는 날이어야 한다(z.iso.date 가 2월 30일을 거른다)
const day = z.iso
  .date("날짜는 YYYY-MM-DD 로 넣어 주세요")
  .refine((v) => {
    const year = Number(v.slice(0, 4));
    return year >= YEAR_MIN && year <= YEAR_MAX;
  }, `연도는 ${YEAR_MIN}~${YEAR_MAX} 사이로 넣어 주세요`);

/** 칸마다 값 모양. null 은 「값 없음」(못 읽음 · 비움)이고 어느 칸이든 받는다 */
export const POSTER_FIELD_VALUE_SCHEMAS = {
  genre: z.enum(GENRES).nullable(),
  genre_detail: z.enum(CLASS_SUB_GENRES).nullable(),
  title: text.nullable(),
  // 요일은 여럿일 수 있다(배열). 같은 요일 두 번은 받지 않는다
  weekday: z
    .array(z.enum(WEEKDAYS))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "같은 요일을 두 번 넣었어요")
    .nullable(),
  start_time: time.nullable(),
  end_time: time.nullable(),
  start_date: day.nullable(),
  end_date: day.nullable(),
  // 회차 수 상한은 S2-2 반복 일정과 같다(계약 11 §4-1 「회차 수 1~200」)
  session_count: z.int().min(1).max(MAX_RECURRING_SESSIONS).nullable(),
  room_name: text.nullable(),
  price_amount: z.int().min(0).max(PRICE_MAX).nullable(),
  capacity_male: seats.nullable(),
  capacity_female: seats.nullable(),
  capacity_total: seats.nullable(),
  instructor_name: text.nullable(),
  level: z.enum(CLASS_TARGET_LEVELS).nullable(),
  class_kind: z.enum(CLASS_KINDS).nullable(),
} as const satisfies Record<PosterFieldKey, z.ZodType>;

export type PosterFieldValue = z.output<(typeof POSTER_FIELD_VALUE_SCHEMAS)[PosterFieldKey]>;

export const posterFieldKeySchema = z.enum(POSTER_FIELD_KEYS);

/** 칸 하나의 값을 칸 규칙으로 거른다. 맞으면 다듬은 값, 아니면 null 이 아니라 실패(호출한 쪽이 422 로 바꾼다) */
export function parseFieldValue(key: PosterFieldKey, value: unknown): { ok: true; value: PosterFieldValue } | { ok: false; message: string } {
  const checked = POSTER_FIELD_VALUE_SCHEMAS[key].safeParse(value);
  if (checked.success) return { ok: true, value: checked.data };
  return { ok: false, message: checked.error.issues[0]?.message ?? "값 모양이 맞지 않아요" };
}

/** 신뢰도는 소수 셋째 자리까지만 쓴다(data-model 은 numeric(4,3) — 같은 자릿수로 맞춘다) */
export const roundConfidence = (confidence: number): number => Math.round(confidence * 1000) / 1000;

/**
 * 「확인필요」 판정(FR-075) — 셋 중 하나면 사람이 꼭 봐야 한다.
 *   ① 값이 없다(못 읽음) ② 신뢰도가 없다 ③ 신뢰도가 기준보다 낮다
 * 사람이 고친 칸(user·ai_edited)은 이 함수를 거치지 않고 언제나 false 다(DB ck_poster_field_user_checked).
 */
export function needsCheckFor(value: PosterFieldValue, confidence: number | null, min: number = POSTER_CONFIDENCE_MIN): boolean {
  if (value === null) return true;
  if (confidence === null) return true;
  return confidence < min;
}

/** 검토 끝난 칸들(키 → 값). 빠진 키는 null 과 같다 */
export type ReviewedFields = Partial<Record<PosterFieldKey, PosterFieldValue>>;

/** 기간 칸 3개(SX-2.6) — 개강일 · 종료일 · 회차 수 */
export const POSTER_PERIOD_KEYS = ["start_date", "end_date", "session_count"] as const satisfies readonly PosterFieldKey[];
export type PosterPeriodKey = (typeof POSTER_PERIOD_KEYS)[number];

const isEventKind = (kind: PosterFieldValue): boolean => typeof kind === "string" && (EVENT_CLASS_KINDS as readonly string[]).includes(kind);

/**
 * 「기간이 비었나」 — 비어서 **채워야 하는** 기간 칸 목록(없으면 빈 목록). FR-073 하위 불릿(2026-11-24):
 * 기간이 없으면 수업을 게시할 수 없으니, 검토에서 「비어 있는 게 맞다」고 넘기지 못하게 하고 채울 때까지 제출을 막는다.
 *   - 개강일은 언제나 필요하다(첫 회차 날짜)
 *   - 반복 수업은 끝을 정할 값이 하나 더 필요하다 — 종료일 **또는** 회차 수(하나만 있어도 다른 하나는 계산된다).
 *     둘 다 비면 둘 다 돌려준다(화면은 둘 다 확인필요 빈 칸으로 보이고, 어느 하나를 채우면 둘 다 풀린다)
 *   - 이벤트형(원데이·이벤트·파티·공연·대회)은 하루 일정이라 개강일만 있으면 된다(계약 11 §4-2 `kind: "single"`)
 * 값 하나하나의 모양은 POSTER_FIELD_VALUE_SCHEMAS 가 따로 본다. 여기서는 「비었나」만 본다.
 */
export function missingPeriodKeys(fields: ReviewedFields): PosterPeriodKey[] {
  const missing: PosterPeriodKey[] = [];
  if ((fields.start_date ?? null) === null) missing.push("start_date");
  if (isEventKind(fields.class_kind ?? null)) return missing;
  if ((fields.end_date ?? null) === null && (fields.session_count ?? null) === null) missing.push("end_date", "session_count");
  return missing;
}

/** 계약 11 §4-2 의 일정 — 반복(요일·기간) 또는 하루(이벤트형) */
export type PosterClassSchedule =
  | { kind: "recurring"; weekdays: string[]; startTime: string; endTime: string; periodFrom: string; periodTo: string }
  | { kind: "single"; date: string; startTime: string; endTime: string };

/** S2-2 임시 저장 본문(계약 11 §4-2) 중 포스터에서 채울 수 있는 칸. 나머지 칸은 null 로 보낸다 */
export type PosterClassDraft = {
  academyId: string;
  classKind: string | null;
  title: string | null;
  genre: string | null;
  subGenre: string | null;
  discipline: null;
  targetLevel: string | null;
  targetAges: null;
  roomId: string | null;
  priceAmount: number | null;
  schedule: PosterClassSchedule | null;
  capacity: { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number } | null;
  refundDeadlineOn: null;
  introText: null;
  instructorAccountId: string | null;
};

const pick = <K extends PosterFieldKey>(fields: ReviewedFields, key: K): PosterFieldValue => fields[key] ?? null;
const asText = (value: PosterFieldValue): string | null => (typeof value === "string" ? value : null);
const asInt = (value: PosterFieldValue): number | null => (typeof value === "number" ? value : null);

/**
 * 검토 끝난 칸 → S2-2 임시 저장 본문. 판단을 새로 하지 않고 칸을 옮기기만 한다 — 「맞는 값인가」는 S2-2 가 본다
 * (장르가 담당 강사의 활동 장르와 다르면 GENRE_NOT_ALLOWED, 수업명 60자 초과면 VALIDATION_FAILED 처럼 그 계약의 오류가 그대로 나간다).
 *   - 정원: 남·여 둘 다 있으면 성별 두 칸, 아니면 전체 정원이 있으면 한 칸, 그 밖은 비움
 *   - 일정: 요일·시작·끝 시각 + 기간 칸(SX-2.6)으로 만든다(toSchedule). 모자라면 비우고 S2-2 승인 요청이 「일정」이 빠졌다고 알려 준다
 *   - 홀·담당 강사: 글자(이름)를 id 로 바꾸는 일은 DB 를 봐야 해서 서비스가 해 넘긴다(roomId · instructorAccountId)
 */
export function toClassDraft(
  fields: ReviewedFields,
  resolved: { academyId: string; roomId: string | null; instructorAccountId: string | null },
): PosterClassDraft {
  const male = asInt(pick(fields, "capacity_male"));
  const female = asInt(pick(fields, "capacity_female"));
  const total = asInt(pick(fields, "capacity_total"));
  const capacity =
    male !== null && female !== null
      ? { mode: "gender_split" as const, male, female }
      : total !== null
        ? { mode: "single" as const, any: total }
        : null;
  return {
    academyId: resolved.academyId,
    classKind: asText(pick(fields, "class_kind")),
    title: asText(pick(fields, "title")),
    genre: asText(pick(fields, "genre")),
    subGenre: asText(pick(fields, "genre_detail")),
    discipline: null,
    targetLevel: asText(pick(fields, "level")),
    targetAges: null,
    roomId: resolved.roomId,
    priceAmount: asInt(pick(fields, "price_amount")),
    schedule: toSchedule(fields),
    capacity,
    refundDeadlineOn: null,
    introText: null,
    instructorAccountId: resolved.instructorAccountId,
  };
}

/**
 * 포스터 칸 → S2-2 일정(계약 11 §4-2 schedule). 모자라면 null(S2-2 승인 요청이 「일정」 빠짐으로 알려 준다).
 *   - 이벤트형: 하루 일정 { date: 개강일, startTime, endTime }
 *   - 반복 수업: { weekdays, startTime, endTime, periodFrom: 개강일, periodTo }. S2-2 는 끝나는 날(periodTo)만 받으므로
 *     종료일이 있으면 그대로 쓰고, 없고 회차 수만 있으면 요일 규칙으로 회차를 세어 마지막 회차 날짜를 끝나는 날로 쓴다
 *     (「12월 5일부터 토요일 4회」 → 12월 26일). 종료일과 회차 수가 둘 다 있으면 종료일이 이긴다 — 회차는 S2-2 가 종료일로 다시 센다.
 * 판단(첫 회차가 미래인가 · 10분 단위인가 · 끝이 시작보다 늦은가)은 하지 않는다 — S2-2 가 같은 규칙으로 본다.
 */
export function toSchedule(fields: ReviewedFields): PosterClassSchedule | null {
  const startDate = asText(pick(fields, "start_date"));
  const startTime = asText(pick(fields, "start_time"));
  const endTime = asText(pick(fields, "end_time"));
  if (startDate === null || startTime === null || endTime === null) return null;
  if (isEventKind(pick(fields, "class_kind"))) return { kind: "single", date: startDate, startTime, endTime };

  const weekday = pick(fields, "weekday");
  if (!Array.isArray(weekday) || weekday.length === 0) return null;
  const weekdays = [...weekday];
  const endDate = asText(pick(fields, "end_date"));
  if (endDate !== null) return { kind: "recurring", weekdays, startTime, endTime, periodFrom: startDate, periodTo: endDate };

  const count = asInt(pick(fields, "session_count"));
  if (count === null) return null;
  try {
    const sessions = buildRecurringSessions({ weekdays, startTime, endTime, periodFrom: startDate, sessionCount: count });
    const last = sessions[sessions.length - 1];
    return last === undefined ? null : { kind: "recurring", weekdays, startTime, endTime, periodFrom: startDate, periodTo: last.date.toString() };
  } catch {
    // 시각이 10분 단위가 아니거나 끝이 시작보다 이르면 회차를 셀 수 없다 — 일정을 비워 S2-2 가 빠진 칸으로 알리게 한다
    return null;
  }
}
