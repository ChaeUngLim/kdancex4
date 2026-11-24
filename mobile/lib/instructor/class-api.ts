/**
 * 강사 앱 수업 등록(보드 I2 · I2D · I2E · I2S)이 부르는 API · 응답 모양 · 화면 계산 — S2-2.9(앱 수업 등록 화면).
 *
 * 부르는 서버 경로(모두 이미 있다 — 새 경로를 만들지 않았다):
 *   GET  /api/instructor/affiliations/{id}/rooms   소속 학원의 홀 목록(11 §3-4, S2-2.8a)
 *   POST /api/classes/schedule-check               입력 중 겹침·회차 수 미리 보기, 쓰지 않음(11 §4-1, S2-2.8c)
 *   POST /api/classes                              임시 저장 만들기 — Idempotency-Key 필수(11 §4-2, S2-2.3)
 *   GET  /api/classes/{classId}                    등록 상세(11 §4-2 ClassRegistration, I2S)
 *   PUT  /api/classes/{classId}                    임시 저장 고치기 — 전체 교체(11 §4-2)
 *   POST /api/classes/{classId}/submit             수업 등록 = 대표에게 승인 요청(11 §4-4)
 *   POST /api/classes/{classId}/withdraw           등록 취소 → 임시 저장으로(11 §4-4, S2-2.8b)
 *
 * 흐름 한눈에(11 §4 머리 「수업 만들기는 두 단계」):
 *   I2(1/2) 칸 채우기 ─「다음」→ 임시 저장(POST 또는 PUT) → 서버가 붙여 준 학원 환불 공지(읽기 전용)를 받아
 *   I2D(정규 계열) · I2E(이벤트형) 2/2 에서 정원·환불 마감일을 넣고 ─「수업 등록」→ PUT + submit → I2S(승인 중)
 *   I2S 「등록 취소」→ withdraw → 다시 임시 저장(I2 로 돌아가 고친다)
 *
 * 응답 모양은 admin-web 의 zod 스키마(class-registration.ts `classRegistrationSchema` ·
 * class-schedule-check.ts · instructor-affiliation-rooms.ts)에서 이 화면이 읽는 칸만 옮겼다.
 * 값 이름(classKind·discipline 등)은 admin-web `lib/domain/constants.ts` 와 같다.
 */
import { apiFetch } from '../api';
import { formatWon } from '../catalog/format';
import type { Genre } from '../onboarding/types';

// ---- 값 목록(서버 영문 값 → 화면 글자) ------------------------------------------------------

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  mon: '월',
  tue: '화',
  wed: '수',
  thu: '목',
  fri: '금',
  sat: '토',
  sun: '일',
};

/** 수업 구분(FR-051). 개인 레슨은 이 화면에서 만들지 않는다(11 §4-2 — 개인 레슨 개설 §10 이 따로 있다) */
export type ClassKind =
  | 'regular'
  | 'basic'
  | 'lady_style'
  | 'one_day'
  | 'event'
  | 'party'
  | 'performance'
  | 'competition';
export const CLASS_KINDS: readonly ClassKind[] = [
  'regular',
  'basic',
  'lady_style',
  'one_day',
  'event',
  'party',
  'performance',
  'competition',
];
export const CLASS_KIND_LABELS: Readonly<Record<ClassKind, string>> = {
  regular: '정규',
  basic: '베이직',
  lady_style: '레이디 스타일',
  one_day: '원데이',
  event: '이벤트',
  party: '파티',
  performance: '공연',
  competition: '대회',
};
/** 이벤트형 다섯 — 하루 일정 한 번(single), 2단계가 I2E(환불 마감일·취소 수수료)다 */
const EVENT_KINDS: readonly ClassKind[] = ['one_day', 'event', 'party', 'performance', 'competition'];
export const isEventKind = (kind: ClassKind): boolean => EVENT_KINDS.includes(kind);

export type TargetLevel = 'entry' | 'beginner' | 'novice_intermediate' | 'intermediate' | 'advanced';
export const TARGET_LEVELS: readonly TargetLevel[] = ['entry', 'beginner', 'novice_intermediate', 'intermediate', 'advanced'];
export const TARGET_LEVEL_LABELS: Readonly<Record<TargetLevel, string>> = {
  entry: '입문',
  beginner: '초급',
  novice_intermediate: '초중급',
  intermediate: '중급',
  advanced: '고급',
};

export type AgeGroup = 'all' | 'gen_2030' | 'gen_4050' | 'gen_5060';
export const AGE_GROUPS: readonly AgeGroup[] = ['all', 'gen_2030', 'gen_4050', 'gen_5060'];
export const AGE_GROUP_LABELS: Readonly<Record<AgeGroup, string>> = {
  all: '전체',
  gen_2030: '2030세대',
  gen_4050: '4050세대',
  gen_5060: '5060세대',
};

/** 세부 장르 — 장르마다 고르는 값. 아르헨티나 탱고·스윙은 세부 장르가 없다(11 §4-2 「나머지 두 장르는 null」) */
export const SUB_GENRES_OF: Readonly<Partial<Record<Genre, readonly { value: string; label: string }[]>>> = {
  dance_sport: [
    { value: 'latin', label: '댄스스포츠(라틴)' },
    { value: 'standard', label: '댄스스포츠(스탠다드)' },
  ],
  salsa_bachata: [
    { value: 'salsa', label: '살사' },
    { value: 'bachata', label: '바차타' },
  ],
};

/** 댄스스포츠 종목 — 라틴 5 · 스탠다드 5(D11: 슬로우폭스트롯, 슬로우왈츠 없음) */
export const DISCIPLINES_OF: Readonly<Record<string, readonly { value: string; label: string }[]>> = {
  latin: [
    { value: 'rumba', label: '룸바' },
    { value: 'cha_cha_cha', label: '차차차' },
    { value: 'samba', label: '쌈바' },
    { value: 'paso_doble', label: '파소도블레' },
    { value: 'jive', label: '자이브' },
  ],
  standard: [
    { value: 'waltz', label: '왈츠' },
    { value: 'tango', label: '탱고' },
    { value: 'viennese_waltz', label: '비엔나왈츠' },
    { value: 'slow_foxtrot', label: '폭스트롯' },
    { value: 'quickstep', label: '퀵스텝' },
  ],
};

/** 레이디 스타일은 성별 구분 없는 한 칸 정원(서버 classDraftSchema 와 같은 규칙, 열린 점 ⑦) */
export const usesSingleCapacity = (kind: ClassKind): boolean => kind === 'lady_style';

// ---- 응답 모양 ---------------------------------------------------------------------------

export interface AffiliationRoom {
  roomId: string;
  branchName: string;
  name: string;
}

export type ClassSchedule =
  | { kind: 'recurring'; weekdays: Weekday[]; startTime: string; endTime: string; periodFrom: string; periodTo: string }
  | { kind: 'single'; date: string; startTime: string; endTime: string };

export interface ClassCapacity {
  mode: 'gender_split' | 'single';
  male: number | null;
  female: number | null;
  any: number | null;
}

/** 대표가 쓴 환불 공지 판본 — content 모양은 종류마다 다르다(admin-web refund-notice-body.ts) */
export interface RefundNotice {
  versionId: string;
  kind: 'regular' | 'event';
  version: number;
  content: Record<string, unknown>;
  readOnly: true;
}

export type ClassStatus = 'draft' | 'pending_approval' | 'published' | 'cancelled';

/** `ClassRegistration`(11 §4-2) */
export interface ClassRegistration {
  classId: string;
  academyId: string;
  academyName: string;
  status: ClassStatus;
  classKind: ClassKind;
  title: string;
  genre: Genre | null;
  subGenre: string | null;
  discipline: string | null;
  targetLevel: TargetLevel | null;
  targetAges: AgeGroup[];
  room: { roomId: string; name: string } | null;
  schedule: (ClassSchedule & { sessionCount: number | null }) | null;
  capacity: ClassCapacity | null;
  priceAmount: number | null;
  isFree: boolean;
  refundDeadlineOn: string | null;
  refundNotice: RefundNotice | null;
  instructor: { accountId: string; displayName: string } | null;
  revisionRequest: { reason: string; at: string } | null;
  submittedAt: string | null;
}

/** 서버로 보내는 임시 저장 본문(POST·PUT 공통 — PUT 은 전체 교체라 늘 모든 칸을 보낸다) */
export interface ClassDraftBody {
  academyId: string;
  classKind: ClassKind;
  title: string;
  genre: Genre;
  subGenre: string | null;
  discipline: string | null;
  targetLevel: TargetLevel | null;
  targetAges: AgeGroup[];
  roomId: string | null;
  priceAmount: number | null;
  schedule: ClassSchedule | null;
  capacity: { mode: 'gender_split'; male: number; female: number } | { mode: 'single'; any: number } | null;
  refundDeadlineOn: string | null;
  introText: string | null;
}

/** `POST /api/classes/schedule-check` 응답(11 §4-1) */
export interface ScheduleCheck {
  sessionCount: number;
  firstStartsAt: string;
  lastEndsAt: string;
  existing: { weekday: Weekday; startTime: string; endTime: string; label: string }[];
  conflicts: { startsAt: string; endsAt: string; overlapMinutes: number; label: string }[];
  roomConflicts: { startsAt: string; endsAt: string; overlapMinutes: number; label: string }[];
  suggestions: { weekday: Weekday; startTime: string; endTime: string }[];
}

// ---- 부르기 -------------------------------------------------------------------------------

export function roomsPath(affiliationId: string): string {
  return `/api/instructor/affiliations/${encodeURIComponent(affiliationId)}/rooms`;
}

export function classPath(classId: string): string {
  return `/api/classes/${encodeURIComponent(classId)}`;
}

export function checkSchedule(
  body: { academyId: string; roomId: string | null; excludeClassId: string | null; schedule: ClassSchedule },
  signal?: AbortSignal,
): Promise<ScheduleCheck> {
  return apiFetch<ScheduleCheck>('/api/classes/schedule-check', { method: 'POST', body, signal });
}

/**
 * 임시 저장 — 아직 서버에 없으면 만들고(POST, 멱등 키), 있으면 고친다(PUT).
 * 멱등 키는 화면이 한 번 만들어 들고 있다 — 응답을 못 받고 다시 눌러도 같은 수업 하나만 생긴다(README §5).
 */
export function saveClassDraft(classId: string | null, body: ClassDraftBody, idempotencyKey: string): Promise<ClassRegistration> {
  if (classId === null) {
    return apiFetch<ClassRegistration>('/api/classes', { method: 'POST', body, idempotencyKey });
  }
  return apiFetch<ClassRegistration>(classPath(classId), { method: 'PUT', body });
}

export function submitClass(classId: string): Promise<ClassRegistration> {
  return apiFetch<ClassRegistration>(`${classPath(classId)}/submit`, { method: 'POST', body: {} });
}

export function withdrawClass(classId: string): Promise<ClassRegistration> {
  return apiFetch<ClassRegistration>(`${classPath(classId)}/withdraw`, { method: 'POST', body: {} });
}

// ---- 화면 계산(렌더 중에 바로 쓰는 순수 함수) ---------------------------------------------

/** 「14:00」 → 분. 모양이 틀리면 null */
function minutesOf(hm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hm.trim());
  if (match === null) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h > 23 || m > 59 ? null : h * 60 + m;
}

/**
 * 시간 두 칸 검사 — 서버(timeIssues)와 같은 규칙: 「HH:MM」 · 10분 단위 · 끝 > 시작. 맞으면 null.
 * 화면이 미리 막아 서버에 틀린 값을 보내지 않게 한다(마지막 판정은 여전히 서버다).
 */
export function timeProblem(start: string, end: string): string | null {
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === null || e === null) return '시각은 「20:30」처럼 네 자리로 적어 주세요.';
  if (s % 10 !== 0 || e % 10 !== 0) return '10분 단위만 받아요(예: 20:30, 20:35 는 안 돼요).';
  if (e <= s) return '끝 시각이 시작보다 늦어야 해요.';
  return null;
}

/** 「YYYY-MM-DD」 이고 실제 있는 날짜인가 */
export function isYmd(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

/** 「2026-11-02」 → 「11월 2일」 */
export function monthDay(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

const KOREAN_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 「2026-10-15」 → 「10월 15일 (목)」(보드 I2E 환불 마감일 칸) */
export function monthDayWithWeekday(ymd: string): string {
  const day = new Date(Date.parse(`${ymd}T00:00:00Z`)).getUTCDay();
  return `${monthDay(ymd)} (${KOREAN_WEEKDAYS[day]})`;
}

/** 요일 반복 한 줄 — 「월·수 20:30–21:30」. 요일은 늘 월→일 순서로 쓴다 */
export function scheduleLine(schedule: ClassSchedule): string {
  if (schedule.kind === 'single') return `${monthDayWithWeekday(schedule.date)} ${schedule.startTime}–${schedule.endTime}`;
  const days = WEEKDAYS.filter((day) => schedule.weekdays.includes(day)).map((day) => WEEKDAY_LABELS[day]);
  return `${days.join('·')} ${schedule.startTime}–${schedule.endTime}`;
}

/** 기간 한 줄 — 「11월 2일 – 12월 23일 · 8주 16회」. 회차 수를 모르면 날짜만 */
export function periodLine(schedule: ClassSchedule, sessionCount: number | null): string {
  if (schedule.kind === 'single') return sessionCount === null ? '하루' : `하루 · ${sessionCount}회`;
  const range = `${monthDay(schedule.periodFrom)} – ${monthDay(schedule.periodTo)}`;
  if (sessionCount === null) return range;
  // 주 수 = 기간 일수 ÷ 7 을 올림(11/2 월 ~ 12/23 수 = 52일 → 8주)
  const days = (Date.parse(`${schedule.periodTo}T00:00:00Z`) - Date.parse(`${schedule.periodFrom}T00:00:00Z`)) / 86_400_000 + 1;
  return `${range} · ${Math.ceil(days / 7)}주 ${sessionCount}회`;
}

/** 장르 줄 — 「댄스스포츠(라틴) · 쌈바」(보드 I2S) */
export function genreLine(genre: Genre | null, subGenre: string | null, discipline: string | null): string {
  const sub = genre === null ? null : (SUB_GENRES_OF[genre] ?? []).find((item) => item.value === subGenre) ?? null;
  const disc = subGenre === null ? null : (DISCIPLINES_OF[subGenre] ?? []).find((item) => item.value === discipline) ?? null;
  const base = sub?.label ?? (genre === null ? '' : GENRE_NAMES[genre]);
  return disc === null ? base : `${base} · ${disc.label}`;
}

const GENRE_NAMES: Readonly<Record<Genre, string>> = {
  dance_sport: '댄스스포츠',
  argentine_tango: '아르헨티나 탱고',
  swing: '스윙댄스',
  salsa_bachata: '살사/바차타',
};
export const genreName = (genre: Genre): string => GENRE_NAMES[genre];

/** 정원 줄 — 「남 10 · 여 10」 또는 「10명」 */
export function capacityLine(capacity: ClassCapacity | null): string {
  if (capacity === null) return '-';
  if (capacity.mode === 'single') return `${capacity.any ?? 0}명`;
  return `남 ${capacity.male ?? 0} · 여 ${capacity.female ?? 0}`;
}

export function priceLine(priceAmount: number | null): string {
  if (priceAmount === null) return '-';
  return priceAmount === 0 ? '무료' : formatWon(priceAmount);
}

/** 상태 칩 글자(I2S 머리) */
export const STATUS_LABELS: Readonly<Record<ClassStatus, string>> = {
  draft: '임시 저장',
  pending_approval: '승인 중',
  published: '공개',
  cancelled: '폐강',
};

/**
 * 「1,000원」·「300000」 같은 입력 → 원 정수. 빈칸이면 null(아직 안 넣음), 숫자가 아니면 NaN.
 * 쉼표·「원」 글자는 빼고 읽는다 — 사람이 보이는 대로 다시 적어도 받아 주려는 것이다.
 */
export function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[,\s원]/g, '');
  if (cleaned === '') return null;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

// ---- 환불 공지 표(I2D · I2E) ----------------------------------------------------------------

const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 공지 content 의 tiers·feeTiers 배열에서 (이름 → %) 를 읽는다. 모양이 다르면 빈 값 */
function percentMap(list: unknown, key: 'point' | 'window'): Map<string, number> {
  const map = new Map<string, number>();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const name = record[key];
      const percent = asNumber(record['percent']);
      if (typeof name === 'string' && percent !== null) map.set(name, percent);
    }
  }
  return map;
}

/**
 * 정규 공지 → 보드 I2D 표의 여섯 줄(취소 가능 · 환불 기준 · 환불 안 됨 · 처리 기간 · 요청 방법 · 연락처).
 * 「환불 기준」은 보드처럼 짧게 「시작 전 100% · 1/3 전 67%」 두 줄로 줄인다.
 * 요청 방법은 대표가 고르지 않는 고정 값이다(FR-098b — 앱 문의로만 받는다).
 */
export function regularNoticeRows(content: Record<string, unknown>): { label: string; value: string }[] {
  const tiers = percentMap(content['tiers'], 'point');
  const pct = (point: string) => `${tiers.get(point) ?? 0}%`;
  const days = asNumber(content['processingBusinessDays']);
  return [
    { label: '취소 가능', value: asText(content['cancellableUntil']) },
    {
      label: '환불 기준',
      value: `시작 전 ${pct('before_start')} · 1/3 전 ${pct('before_one_third')}\n1/2 전 ${pct('before_half')} · 1/2 뒤 ${pct('after_half')}`,
    },
    { label: '환불 안 됨', value: asText(content['nonRefundableCases']) },
    { label: '처리 기간', value: days === null ? '' : `요청 확인 뒤 ${days}영업일 이내` },
    { label: '요청 방법', value: '앱 문의' },
    { label: '연락처', value: asText(content['ownerContact']) },
  ];
}

/** 이벤트형 취소 수수료 네 구간(보드 I2E 표) — 순서는 admin-web EVENT_FEE_WINDOWS 와 같다 */
export function eventFeeRows(content: Record<string, unknown>): { label: string; value: string }[] {
  const fees = percentMap(content['feeTiers'], 'window');
  const windows: readonly [string, string][] = [
    ['d10_plus', '10일 전까지'],
    ['d9_d7', '9일 전 ~ 7일 전'],
    ['d6_d3', '6일 전 ~ 3일 전'],
    ['d2_to_deadline', '2일 전 ~ 환불 마감일'],
  ];
  return windows.map(([key, label]) => ({ label, value: `${fees.get(key) ?? 0}%` }));
}
