/**
 * 강사 프로필 고치기(I40)·개인 일정(I36)이 부르는 API 와 화면 계산 — S2-1.11(앱 프로필 고치기·개인 일정 화면).
 *
 * 서버 경로는 S2-1.6 이 만든 것만 부른다(새 경로를 만들지 않았다).
 *   GET    /api/instructor/me/profile                  내 프로필 전체(계약 11 §2-1)
 *   PUT    /api/instructor/me/profile                  프로필 저장 — 여섯 칸 전체 교체, 대표 승인 없이 회원 화면에 바로 반영
 *   POST   /api/instructor/personal-events             개인 일정 넣기(11 §2-3)
 *   DELETE /api/instructor/personal-events/{eventId}   개인 일정 지우기(반복이면 시리즈 전체)
 *
 * 응답 모양은 admin-web 의 zod 스키마(instructor-profile.ts · instructor-personal-events.ts)에서 화면이 읽는 칸만 옮겼다.
 * 소개 영상·초상 동의는 이 판에서 받지 않는다(11 열린 점 ⑥ — 사람 결정 대기). 그래서 여기에도 그 칸이 없다.
 */
import { apiFetch } from '../api';
import type { Genre, Region } from '../onboarding/types';

// ---- 프로필(I40) ------------------------------------------------------------------------------

/** `GET`·`PUT /api/instructor/me/profile` 응답 */
export interface InstructorProfileDetail {
  accountId: string;
  displayName: string;
  activityGenre: Genre;
  photo: { fileId: string; url: string } | null;
  careerYears: number | null;
  regions: Region[];
  qualifications: string[];
  competitions: string[];
  bio: string | null;
  /** 세부 종목 코드(rumba 등). 서버가 강사가 연 수업에서 채운다 — 응답에만 있고 보내지 않는다 */
  disciplines: string[];
  affiliations: { academyId: string; name: string; status: 'pending' | 'active' }[];
}

/** PUT 이 받는 여섯 칸(계약 11 §2-1). 활동 장르·이름은 보내지 않는다 — 가입 때만 정한다 */
export interface InstructorProfileInput {
  photoFileId: string | null;
  careerYears: number | null;
  regions: Region[];
  qualifications: string[];
  competitions: string[];
  bio: string | null;
}

/** 서버 검사와 같은 한도(admin-web instructor-profile.ts) — 화면에서 먼저 막아 422 왕복을 줄인다 */
export const BIO_MAX = 500;
export const CAREER_MAX = 80;
export const CREDENTIAL_MAX = 20;
export const CREDENTIAL_TITLE_MAX = 100;
export const REGION_MAX = 20;

export function saveInstructorProfile(input: InstructorProfileInput): Promise<InstructorProfileDetail> {
  return apiFetch<InstructorProfileDetail>('/api/instructor/me/profile', { method: 'PUT', body: input });
}

/**
 * 경력 칸 글자 → 숫자. 비우면 null(「안 적음」), 0~80 의 정수가 아니면 undefined(틀림).
 * 틀린 값은 저장 버튼을 끄고 칸 아래에 이유를 보인다.
 */
export function parseCareerYears(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d{1,2}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value <= CAREER_MAX ? value : undefined;
}

/** 세부 종목 코드 → 한글(data-model §8-7 D11 순서). 모르는 코드는 그대로 보인다 */
const DISCIPLINE_LABELS: Readonly<Record<string, string>> = {
  rumba: '룸바',
  cha_cha_cha: '차차차',
  samba: '쌈바',
  paso_doble: '파소도블레',
  jive: '자이브',
  waltz: '왈츠',
  tango: '탱고',
  viennese_waltz: '비엔나왈츠',
  slow_foxtrot: '슬로우폭스트롯',
  quickstep: '퀵스텝',
};

/** I40 아래 안내 「수업 종목(룸바·쌈바·왈츠)은 내가 연 수업에서 저절로 보여요」 */
export function disciplinesNote(disciplines: readonly string[]): string {
  if (disciplines.length === 0) {
    return '수업 종목은 내가 연 수업에서 저절로 보여요. 아직 연 수업이 없어요.';
  }
  const names = disciplines.map((code) => DISCIPLINE_LABELS[code] ?? code).join('·');
  return `수업 종목(${names})은 내가 연 수업에서 저절로 보여요.`;
}

// ---- 개인 일정(I36) ---------------------------------------------------------------------------

export type PersonalEventRepeat = 'none' | 'weekly' | 'daily';

export interface PersonalEventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  repeat: PersonalEventRepeat;
}

/** `POST /api/instructor/personal-events` 201 */
export interface PersonalEvent extends Omit<PersonalEventInput, 'repeat'> {
  eventId: string;
  repeat: PersonalEventRepeat;
  /** 겹치는 수업·개인 레슨. 막지 않고 알린다(11 §2-3 「넣기 전에 알려 줘요」) */
  overlaps: { kind: 'class_session' | 'private_lesson_slot'; label: string; overlapMinutes: number }[];
}

export const PERSONAL_TITLE_MAX = 50;

export function addPersonalEvent(input: PersonalEventInput): Promise<PersonalEvent> {
  return apiFetch<PersonalEvent>('/api/instructor/personal-events', { method: 'POST', body: input });
}

export function deletePersonalEvent(eventId: string): Promise<void> {
  return apiFetch<void>(`/api/instructor/personal-events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 지금의 한국 날짜 「2026-11-21」 */
export function todayKst(now: number = Date.now()): string {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 주소 인자 `?date=` 검사 — 「YYYY-MM-DD」 이고 실제 있는 날짜만 받는다(딥링크 값은 믿지 않는다) */
export function readYmd(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const time = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== raw ? null : raw;
}

/** 날짜 고르기 칩 — 기준 날부터 n 일. 캘린더(I5)가 붙기 전까지 2주 안에서 고른다 */
export function nextDays(fromYmd: string, count: number): string[] {
  const start = Date.parse(`${fromYmd}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
}

/** 「2026-11-12」 → 「11/12 (목)」 */
export function monthDayWeekday(ymd: string): string {
  const date = new Date(Date.parse(`${ymd}T00:00:00Z`));
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()} (${WEEKDAYS[date.getUTCDay()]})`;
}

/** 「2026-11-12」의 요일 글자 「목」 — 반복 칩 「매주 목」 */
export function weekdayOf(ymd: string): string {
  return WEEKDAYS[new Date(Date.parse(`${ymd}T00:00:00Z`)).getUTCDay()] ?? '';
}

/** 「14:00」 → 하루 안의 분(840). 모양이 틀리면 null */
export function parseHm(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * 시간 두 칸 검사 — 틀린 이유 문장, 맞으면 null.
 * 서버(11 §2-3)와 같은 규칙: 10분 단위 · 끝 > 시작. 자정을 넘기는 일정은 보드에 없어 같은 날 안에서만 받는다.
 */
export function timeRangeProblem(startText: string, endText: string): string | null {
  const start = parseHm(startText);
  const end = parseHm(endText);
  if (start === null || end === null) return '시간은 「14:00」처럼 적어 주세요.';
  if (start % 10 !== 0 || end % 10 !== 0) return '시간은 10분 단위로 적어 주세요.';
  if (end <= start) return '끝 시간이 시작보다 늦어야 해요.';
  return null;
}

/**
 * 한국 날짜 + 「14:00」 → 서버에 보낼 UTC 시각(…Z). 서버는 UTC `Z` 글자로 저장·응답한다(S2-1.6).
 * 한국은 서머타임이 없어 +09:00 을 그대로 뺀다.
 */
export function kstToUtcIso(ymd: string, hm: string): string {
  return new Date(Date.parse(`${ymd}T${hm.trim().padStart(5, '0')}:00+09:00`)).toISOString();
}

/** 서버가 돌려준 시각(…Z) → 한국 「11/12 (목) 14:00」 */
export function kstDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const kst = new Date(time + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${monthDayWeekday(kst.toISOString().slice(0, 10))} ${hh}:${mm}`;
}

/** 서버 시각(…Z) → 한국 「16:00」 */
export function kstHm(iso: string): string {
  return kstDateTime(iso).slice(-5);
}

/** 반복 칩 글자 — 「안 함」·「매주 목」·「매일」 */
export function repeatLabel(repeat: PersonalEventRepeat, ymd: string): string {
  if (repeat === 'weekly') return `매주 ${weekdayOf(ymd)}`;
  if (repeat === 'daily') return '매일';
  return '안 함';
}
