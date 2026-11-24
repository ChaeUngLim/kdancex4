// SX-2.5(포스터 검토 화면) — 검토 화면(보드 O2)이 칸 17개를 사람 글자로 보여 주고, 사람이 고친 글자를 칸 값으로 되돌리는 순수 코드.
//   계약: _workspace/03_contracts/16-ai-agent.md §4-6(칸 키 17개 · PATCH 본문). 기간 칸 3개(개강일·종료일·회차 수)는 SX-2.6 에서 더했다
//   칸 값 모양 검사는 서버(lib/domain/poster-extraction.ts 의 zod)가 다시 한다. 여기서는 「숫자 칸에 글자」 같은 뻔한 실수만 먼저 막는다.
//
// 처음 보는 사람용 요약
//   서버는 값을 기계 글자로 준다(salsa_bachata · ["sat"] · 180000). 화면은 그것을 「살사 · 바차타」·「토」·「180,000원」으로 보여 주고,
//   고칠 때는 고르는 칸(장르·레벨·구분·요일)과 적는 칸(수업명·시각·금액·정원)을 나눠 받는다. 이 파일은 그 두 방향 변환만 한다.
import {
  CLASS_KINDS,
  CLASS_SUB_GENRES,
  CLASS_TARGET_LEVELS,
  GENRES,
  type ClassKind,
  type ClassSubGenre,
  type ClassTargetLevel,
  type Genre,
  type PosterFieldKey,
} from "./domain/constants";
import type { PosterFieldValue } from "./domain/poster-extraction";
import { WEEKDAYS, type Weekday } from "./domain/recurring-schedule";

/** 칸 이름(O2 보드의 칸 제목) */
export const POSTER_FIELD_LABELS: Record<PosterFieldKey, string> = {
  genre: "장르",
  genre_detail: "세부 장르",
  title: "수업명",
  weekday: "요일",
  start_time: "시작 시각",
  end_time: "끝 시각",
  start_date: "개강일",
  end_date: "종료일",
  session_count: "회차 수",
  room_name: "강의실",
  price_amount: "수강료",
  capacity_male: "정원 · 남",
  capacity_female: "정원 · 여",
  capacity_total: "정원 · 전체",
  instructor_name: "강사",
  level: "레벨",
  class_kind: "구분",
};

const GENRE_TEXT: Record<Genre, string> = {
  dance_sport: "댄스스포츠",
  argentine_tango: "아르헨티나 탱고",
  swing: "스윙",
  salsa_bachata: "살사 · 바차타",
};
const SUB_GENRE_TEXT: Record<ClassSubGenre, string> = { latin: "라틴", standard: "스탠다드", salsa: "살사", bachata: "바차타" };
const LEVEL_TEXT: Record<ClassTargetLevel, string> = {
  entry: "입문",
  beginner: "초급",
  novice_intermediate: "초중급",
  intermediate: "중급",
  advanced: "고급",
};
const KIND_TEXT: Record<ClassKind, string> = {
  regular: "정규",
  private_lesson: "개인 레슨",
  basic: "베이직",
  lady_style: "레이디 스타일",
  one_day: "원데이",
  event: "이벤트",
  party: "파티",
  performance: "공연",
  competition: "대회",
};
export const WEEKDAY_TEXT: Record<Weekday, string> = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };

/** 고르는 칸의 선택지(값 → 글자). 요일은 여러 개를 고르는 칸이라 따로 그린다 */
export const POSTER_FIELD_CHOICES: Partial<Record<PosterFieldKey, { value: string; label: string }[]>> = {
  genre: GENRES.map((value) => ({ value, label: GENRE_TEXT[value] })),
  genre_detail: CLASS_SUB_GENRES.map((value) => ({ value, label: SUB_GENRE_TEXT[value] })),
  level: CLASS_TARGET_LEVELS.map((value) => ({ value, label: LEVEL_TEXT[value] })),
  class_kind: CLASS_KINDS.map((value) => ({ value, label: KIND_TEXT[value] })),
};

const NUMBER_KEYS: readonly PosterFieldKey[] = ["price_amount", "capacity_male", "capacity_female", "capacity_total", "session_count"];
// 숫자 뒤에 붙는 단위 — 금액은 원, 회차 수는 회, 정원은 명
const NUMBER_UNIT: Partial<Record<PosterFieldKey, string>> = { price_amount: "원", session_count: "회" };

/** 칸 값 → 화면 글자. 못 읽은 칸(null)은 「비어 있음」 */
export function posterValueText(key: PosterFieldKey, value: PosterFieldValue): string {
  if (value === null) return "비어 있음";
  if (Array.isArray(value)) return value.map((d) => WEEKDAY_TEXT[d]).join(" · ");
  if (typeof value === "number") return `${value.toLocaleString("ko-KR")}${NUMBER_UNIT[key] ?? "명"}`;
  const choice = POSTER_FIELD_CHOICES[key]?.find((c) => c.value === value);
  return choice?.label ?? value;
}

/** 칸 값 → 고치기 입력칸에 처음 넣을 글자(요일은 체크 상자라 쓰지 않는다) */
export function posterValueInput(value: PosterFieldValue): string {
  if (value === null || Array.isArray(value)) return "";
  return String(value);
}

/** 신뢰도 → 「95%」. 없으면 null(화면이 딱지만 보여 준다) */
export function confidenceText(confidence: number | null): string | null {
  return confidence === null ? null : `${Math.round(confidence * 100)}%`;
}

/**
 * 고친 글자 → PATCH 로 보낼 칸 값. 빈 칸은 null(「비우기」).
 * 숫자 칸은 쉼표·「원」·「명」을 걷어 내고 정수만 받는다. 모양이 틀리면 화면에 보일 문장을 돌려준다
 */
export function parsePosterInput(key: PosterFieldKey, text: string, days: readonly Weekday[]): { ok: true; value: PosterFieldValue } | { ok: false; message: string } {
  if (key === "weekday") {
    // 체크 순서와 상관없이 월→일 순으로 보낸다
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
    return { ok: true, value: ordered.length === 0 ? null : ordered };
  }
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (NUMBER_KEYS.includes(key)) {
    const digits = trimmed.replace(/[,원명회\s]/g, "");
    if (!/^\d+$/.test(digits)) return { ok: false, message: "숫자만 넣어 주세요" };
    return { ok: true, value: Number(digits) };
  }
  // 날짜 칸 — 「2026.12.05」·「2026/12/05」도 받아 「2026-12-05」로 맞춘다. 달력에 있는 날인지는 서버(zod)가 다시 본다
  if (key === "start_date" || key === "end_date") {
    const date = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(trimmed);
    if (date === null) return { ok: false, message: "날짜는 2026-12-05 처럼 연·월·일로 넣어 주세요" };
    const [, year, month, dayOfMonth] = date;
    return { ok: true, value: `${year}-${month!.padStart(2, "0")}-${dayOfMonth!.padStart(2, "0")}` };
  }
  return { ok: true, value: trimmed as PosterFieldValue };
}

/** S2-2 수업 칸 이름 → 화면 글자. 승인 요청이 422 로 「빠진 칸」을 알려 줄 때 안내 문장에 쓴다(SX-2.6) */
const CLASS_FIELD_TEXT: Record<string, string> = {
  schedule: "일정",
  targetAges: "적정 연령",
  targetLevel: "레벨",
  roomId: "강의실",
  capacity: "정원",
  priceAmount: "수강료",
  genre: "장르",
  subGenre: "세부 장르",
  discipline: "종목",
  refundDeadlineOn: "환불 마감일",
  instructorAccountId: "담당 강사",
  title: "수업명",
  classKind: "구분",
};

/** 빠진 칸 목록 → 「일정 · 적정 연령」. 모르는 이름은 그대로 둔다 */
export function missingFieldsText(missing: readonly string[]): string {
  return missing.map((name) => CLASS_FIELD_TEXT[name] ?? POSTER_FIELD_LABELS[name as PosterFieldKey] ?? name).join(" · ");
}
