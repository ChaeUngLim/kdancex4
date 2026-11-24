/**
 * 강사 「새 반 열기 추천」(보드 I15) · 「후보 명단」(보드 I15B) — 경로 · 응답 모양 · 화면 글자 계산. S6-3.6(앱 강사 레벨·후보 화면).
 *
 * 부르는 경로(계약 14 §6-2, 서버는 S6-3.5 가 만들었다)
 *   GET  /api/instructor/new-class-candidates?조건                후보 수(남·여)와 근거 세 줄 — 개인을 가리키는 값은 없다
 *   GET  /api/instructor/new-class-candidates/list?조건&cursor=   연락처 제공에 동의한 후보만 이름·가린 번호(부를 때마다 서버가 기록)
 *   POST /api/instructor/new-class-candidates/{memberId}/reveal-contact   「보기」 — 전체 번호(볼 때마다 서버가 기록)
 *
 * 규칙(spec FR-164(개강 후보 추천) · FR-165(후보 연락처 동의) · FR-272(명단 출력 동의))
 *  - 명단은 「명단을 볼까요?」에서 `명단 보기`를 눌러야 연다(그 전에는 부르지 않는다).
 *  - 동의하지 않은 후보는 숫자로만 보인다. 앱은 그 사람들의 이름·번호를 받지도 않는다.
 *  - 강사 멤버십 기능이다 — 멤버십이 아니면 서버가 403 INSTRUCTOR_MEMBERSHIP_REQUIRED.
 *
 * 조건은 화면 사이를 주소(쿼리 글자)로 넘긴다 — 후보 수 화면과 명단 화면이 같은 조건을 쓰게 하려는 것이다.
 */
import { apiFetch } from '../api';
import type { LevelDetailGenre } from '../levels/level-cards-view';
import { DETAIL_GENRE_KO, LEVEL_MAX, LEVEL_MIN, stageLabelOf } from './level-api';

// ---- 조건(쿼리) ---------------------------------------------------------------------------------

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: readonly { key: Weekday; label: string }[] = [
  { key: 'mon', label: '월' },
  { key: 'tue', label: '화' },
  { key: 'wed', label: '수' },
  { key: 'thu', label: '목' },
  { key: 'fri', label: '금' },
  { key: 'sat', label: '토' },
  { key: 'sun', label: '일' },
];

export interface CandidateQuery {
  detailGenre: LevelDetailGenre;
  levelFrom: number;
  levelTo: number;
  weekdays: Weekday[];
  /** 「HH:MM」. 시간을 고르지 않았으면 둘 다 null(서버 규칙 — 둘 다 주거나 둘 다 뺀다) */
  timeFrom: string | null;
  timeTo: string | null;
  capacityMale: number;
  capacityFemale: number;
}

/** 세부 장르 14종을 대분류로 묶은 고르기 목록(장르 칸) */
export const DETAIL_GENRE_GROUPS: readonly { group: string; genres: readonly LevelDetailGenre[] }[] = [
  { group: '댄스스포츠(라틴)', genres: ['samba', 'cha_cha_cha', 'rumba', 'paso_doble', 'jive'] },
  { group: '댄스스포츠(스탠다드)', genres: ['waltz', 'tango', 'viennese_waltz', 'slow_foxtrot', 'quickstep'] },
  { group: '살사·바차타', genres: ['salsa', 'bachata'] },
  { group: '아르헨티나 탱고', genres: ['argentine_tango'] },
  { group: '스윙', genres: ['swing'] },
];

const DETAIL_GENRE_SET: ReadonlySet<string> = new Set(DETAIL_GENRE_GROUPS.flatMap((g) => g.genres));
const WEEKDAY_SET: ReadonlySet<string> = new Set(WEEKDAYS.map((w) => w.key));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 장르 칸 글자 「댄스스포츠(라틴) · 쌈바」 — 묶음 이름이 세부 장르와 같으면 이름만 */
export function genreRowText(genre: LevelDetailGenre): string {
  const group = DETAIL_GENRE_GROUPS.find((g) => g.genres.includes(genre))?.group ?? '';
  const name = DETAIL_GENRE_KO[genre];
  return group === '' || group === name ? name : `${group} · ${name}`;
}

/** 레벨대 칸 「입문 ~ 초급」(단계가 같으면 「입문 (Lv.0~1)」) */
export function levelRangeText(from: number, to: number): string {
  const a = stageLabelOf(from);
  const b = stageLabelOf(to);
  return a === b ? `${a} (Lv.${from}~${to})` : `${a} ~ ${b} (Lv.${from}~${to})`;
}

/** 요일·시간 칸 「화·목 20:30–21:30」 — 고르지 않은 것은 「아무 요일」·「아무 시간」 */
export function dayTimeText(query: Pick<CandidateQuery, 'weekdays' | 'timeFrom' | 'timeTo'>): string {
  const days = query.weekdays.length === 0 ? '아무 요일' : WEEKDAYS.filter((w) => query.weekdays.includes(w.key)).map((w) => w.label).join('·');
  const time = query.timeFrom === null || query.timeTo === null ? '아무 시간' : `${query.timeFrom}–${query.timeTo}`;
  return `${days} ${time}`;
}

/**
 * 시간 칸 검사 — 둘 다 비면 「시간 상관없음」(null, null), 하나만 있거나 모양이 틀리거나 끝이 앞서면 문구.
 * 서버도 같은 검사를 하지만, 누르기 전에 바로 알려 주려고 앱에서 먼저 본다.
 */
export function readTimeRange(fromText: string, toText: string): { ok: true; from: string | null; to: string | null } | { ok: false; message: string } {
  const from = fromText.trim();
  const to = toText.trim();
  if (from === '' && to === '') return { ok: true, from: null, to: null };
  if (from === '' || to === '') return { ok: false, message: '시간은 시작과 끝을 함께 넣어 주세요' };
  if (!HHMM.test(from) || !HHMM.test(to)) return { ok: false, message: '시간은 20:30 처럼 넣어 주세요' };
  if (from >= to) return { ok: false, message: '끝 시간이 시작 시간보다 늦어야 해요' };
  return { ok: true, from, to };
}

/** 조건 → 쿼리 글자(세 경로 공통). 시간·요일은 고른 것만 넣는다 */
export function queryString(query: CandidateQuery): string {
  const params: [string, string][] = [
    ['detailGenre', query.detailGenre],
    ['levelFrom', String(query.levelFrom)],
    ['levelTo', String(query.levelTo)],
  ];
  if (query.weekdays.length > 0) params.push(['weekdays', query.weekdays.join(',')]);
  if (query.timeFrom !== null && query.timeTo !== null) {
    params.push(['timeFrom', query.timeFrom], ['timeTo', query.timeTo]);
  }
  params.push(['capacityMale', String(query.capacityMale)], ['capacityFemale', String(query.capacityFemale)]);
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function readInt(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/**
 * 주소 인자 → 조건. 명단 화면은 주소로 조건을 받으므로 딥링크 값을 믿지 않고 하나씩 검사한다.
 * 하나라도 틀리면 null(화면은 「조건을 다시 골라 주세요」).
 */
export function readQueryParams(params: Readonly<Record<string, string | string[] | undefined>>): CandidateQuery | null {
  const one = (key: string): string | undefined => {
    const v = params[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const genre = one('detailGenre');
  if (genre === undefined || !DETAIL_GENRE_SET.has(genre)) return null;
  const levelFrom = readInt(one('levelFrom'), LEVEL_MIN, LEVEL_MAX);
  const levelTo = readInt(one('levelTo'), LEVEL_MIN, LEVEL_MAX);
  if (levelFrom === null || levelTo === null || levelFrom > levelTo) return null;
  const dayText = one('weekdays') ?? '';
  const weekdays = dayText === '' ? [] : dayText.split(',');
  if (!weekdays.every((d) => WEEKDAY_SET.has(d))) return null;
  const time = readTimeRange(one('timeFrom') ?? '', one('timeTo') ?? '');
  if (!time.ok) return null;
  const capacityMale = readInt(one('capacityMale') ?? '0', 0, 200);
  const capacityFemale = readInt(one('capacityFemale') ?? '0', 0, 200);
  if (capacityMale === null || capacityFemale === null) return null;
  return {
    detailGenre: genre as LevelDetailGenre,
    levelFrom,
    levelTo,
    weekdays: weekdays as Weekday[],
    timeFrom: time.from,
    timeTo: time.to,
    capacityMale,
    capacityFemale,
  };
}

// ---- 응답 모양(admin-web new-class-candidates.ts 의 zod 스키마와 같다) ---------------------------------

export type CandidateBasisKind = 'completed_same_detail_genre' | 'attending_same_genre' | 'preferred_time';

export interface CandidateSummary {
  total: number;
  male: number;
  female: number;
  capacity: number;
  basis: { kind: CandidateBasisKind; count: number; label: string }[];
  contactConsent: { consenting: number; notConsenting: number };
  disclaimer: string;
}

export type AgeGroup = '20s' | '30s' | '40s' | '50s' | '60s_plus';

export interface CandidateListItem {
  memberId: string;
  displayName: string;
  gender: 'male' | 'female';
  ageGroup: AgeGroup;
  detailGenre: LevelDetailGenre;
  level: number;
  basis: CandidateBasisKind;
  phoneMasked: string;
  revealToken: string;
}

export interface CandidateList {
  items: CandidateListItem[];
  notConsentingCount: number;
  nextCursor: string | null;
  notice: string;
}

export function candidatesPath(query: CandidateQuery): string {
  return `/api/instructor/new-class-candidates?${queryString(query)}`;
}

export function candidateListPath(query: CandidateQuery, cursor: string | null = null): string {
  const more = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return `/api/instructor/new-class-candidates/list?${queryString(query)}${more}`;
}

/** 다음 쪽 명단 — 「더 보기」 버튼 핸들러에서만 부른다 */
export function fetchCandidateList(query: CandidateQuery, cursor: string): Promise<CandidateList> {
  return apiFetch<CandidateList>(candidateListPath(query, cursor));
}

/** 「보기」 — 전체 번호. 누를 때마다 서버가 누가 언제 봤는지 기록한다 */
export function revealCandidateContact(memberId: string, revealToken: string): Promise<{ phone: string }> {
  return apiFetch<{ phone: string }>(`/api/instructor/new-class-candidates/${encodeURIComponent(memberId)}/reveal-contact`, {
    method: 'POST',
    body: { revealToken },
  });
}

// ---- 화면 글자 ----------------------------------------------------------------------------------

const AGE_LABEL: Record<AgeGroup, string> = { '20s': '20대', '30s': '30대', '40s': '40대', '50s': '50대', '60s_plus': '60대 이상' };

/** `보기`로 받은 번호를 읽기 쉽게 「010-1234-5678」로 — 모양이 다르면 받은 그대로 */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (/^01\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone;
}

/** 명단 둘째 칸 「여 · 20대 · 쌈바 Lv.1」(연령대는 FR-168) */
export function candidateSubLine(item: CandidateListItem): string {
  return `${item.gender === 'male' ? '남' : '여'} · ${AGE_LABEL[item.ageGroup]} · ${DETAIL_GENRE_KO[item.detailGenre]} Lv.${item.level}`;
}

/** 명단 근거 한 줄 — 후보 수 화면의 근거 문장보다 짧게 */
export function basisShortText(basis: CandidateBasisKind, genre: LevelDetailGenre): string {
  if (basis === 'completed_same_detail_genre') return `${DETAIL_GENRE_KO[genre]} 정규 과정을 마쳤어요`;
  if (basis === 'attending_same_genre') return '같은 장르 수업을 듣고 있어요';
  return '선호 시간이 맞아요';
}

/** 명단 머리 아래 줄 「쌈바 입문~초급 · 화·목 20:30–21:30 조건으로 찾았어요」 */
export function conditionLine(query: CandidateQuery): string {
  const a = stageLabelOf(query.levelFrom);
  const b = stageLabelOf(query.levelTo);
  const range = a === b ? a : `${a}~${b}`;
  return `${DETAIL_GENRE_KO[query.detailGenre]} ${range} · ${dayTimeText(query)} 조건으로 찾았어요`;
}
