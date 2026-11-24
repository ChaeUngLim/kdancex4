/**
 * 강사 계정 찾기 · 소속 신청 · 학원 색 — S2-1.10(앱 계정 찾기·소속 신청·학원 색 화면, 보드 I31B·I27·I27B·I9E).
 *
 * 부르는 서버 경로(모두 이미 있다 — 이 Task 는 새 경로를 만들지 않는다)
 *   POST /api/instructor/account-recovery/lookup           본인확인한 사람의 강사 계정 찾기(11 §1-4, I31B)
 *   POST /api/instructor/account-recovery/reset-password   비밀번호 새로 정하기 — 다른 기기 로그인 모두 끝남(11 §1-4)
 *   GET  /api/instructor/academies?q=&limit=               학원 검색(11 §3-1, I27)
 *   POST /api/instructor/affiliations                      소속 신청(08 §2, I27)
 *   POST /api/instructor/affiliations/{id}/withdraw        승인 대기 중 신청 취소(08 §2, I27B)
 *   PUT  /api/instructor/affiliations/{id}/color           학원 색 바꾸기(11 §3-2, I9E)
 *
 * 응답 모양은 admin-web 의 zod 스키마(instructor-account-recovery.ts · instructor-academies.ts ·
 * instructor-affiliations.ts)에서 화면이 읽는 칸만 옮겼다.
 */
import { apiFetch } from '../api';
import type { Genre } from '../onboarding/types';

// ---- 계정 찾기 · 비밀번호 새로 정하기(I31B) ---------------------------------------------------

/** lookup 200 — 아이디만 그대로 보이고 이름·전화는 가린 값이다 */
export interface RecoveredAccount {
  nameMasked: string;
  phoneMasked: string;
  username: string;
  /** 가입일(KST, YYYY-MM-DD) */
  joinedOn: string;
  /** 소속됨 학원 이름 앞 1개 */
  academyNames: string[];
  /** 소속됨 학원 전체 수 */
  academyCount: number;
}

export function lookupInstructorAccount(verificationToken: string): Promise<RecoveredAccount> {
  return apiFetch<RecoveredAccount>('/api/instructor/account-recovery/lookup', {
    method: 'POST',
    body: { verificationToken },
    auth: false,
  });
}

export interface PasswordResetResult {
  ok: true;
  /** 끝낸 로그인 세션 수(다른 기기 포함) */
  sessionsRevoked: number;
}

/** 같은 본인확인 토큰은 한 번만 쓸 수 있다(서버가 jti 를 기록한다) — 실패하면 본인확인부터 다시 한다 */
export function resetInstructorPassword(verificationToken: string, newPassword: string): Promise<PasswordResetResult> {
  return apiFetch<PasswordResetResult>('/api/instructor/account-recovery/reset-password', {
    method: 'POST',
    body: { verificationToken, newPassword },
    auth: false,
  });
}

// ---- 학원 검색 · 소속 신청(I27) ----------------------------------------------------------------

/** 검색 결과의 소속 상태. 철회(withdrawn)는 서버가 null 로 준다(다시 신청 가능) */
export type SearchAffiliationStatus = 'pending' | 'active' | 'rejected' | 'released';

export interface AcademySearchItem {
  academyId: string;
  name: string;
  region: { sido: string; gu: string };
  genres: Genre[];
  affiliation: { affiliationId: string; status: SearchAffiliationStatus } | null;
  canSubmitClass: boolean;
  canOpenPrivateLesson: boolean;
}

/** 검색 결과 최대 수. 서버 기본 20 · 최대 50 */
const SEARCH_LIMIT = 20;

/** 검색 주소. 빈 검색어면 받는 학원 전체(서버 규칙) */
export function academySearchPath(query: string): string {
  return `/api/instructor/academies?q=${encodeURIComponent(query.trim())}&limit=${SEARCH_LIMIT}`;
}

/**
 * 이 학원에 지금 신청할 수 있나 — 소속됨·승인 대기면 고를 수 없다(I27 「이미 소속·대기 중인 학원은 고를 수 없게」).
 * 거절·해제·없음은 다시 신청할 수 있다(FR-071 보완 「다시 신청 횟수 제한 없음」).
 */
export function canApplyTo(item: AcademySearchItem): boolean {
  return item.affiliation === null || item.affiliation.status === 'rejected' || item.affiliation.status === 'released';
}

/** 고를 수 없는 학원 줄 오른쪽에 보이는 상태 글자(보드 I27 「소속됨」·「신청 대기 중」) */
export function searchStatusLabel(item: AcademySearchItem): string | null {
  if (item.affiliation?.status === 'active') return '소속됨';
  if (item.affiliation?.status === 'pending') return '신청 대기 중';
  return null;
}

/** 대표에게 한마디 최대 글자 수 — 서버 APPLICANT_MESSAGE_MAX 와 같다 */
export const APPLY_MESSAGE_MAX = 200;

export interface AppliedAffiliation {
  affiliationId: string;
  academyId: string;
  status: 'pending';
  requestedAt: string;
}

/** 소속 신청 — 한마디가 비면 null 로 보낸다(서버도 빈 글을 null 로 바꾼다) */
export function applyAffiliation(academyId: string, message: string): Promise<AppliedAffiliation> {
  const trimmed = message.trim();
  return apiFetch<AppliedAffiliation>('/api/instructor/affiliations', {
    method: 'POST',
    body: { academyId, message: trimmed.length === 0 ? null : trimmed },
  });
}

// ---- 내 소속 신청(I27B) -----------------------------------------------------------------------

export function withdrawAffiliation(affiliationId: string): Promise<{ affiliationId: string; status: 'withdrawn' }> {
  return apiFetch(`/api/instructor/affiliations/${encodeURIComponent(affiliationId)}/withdraw`, { method: 'POST', body: {} });
}

/** 거절 사유 코드 → 강사에게 보이는 말. admin-web 의 대표 거절 알림 문구(academy-affiliation-decisions.ts)와 같다 */
const REJECT_REASON_LABELS: Readonly<Record<string, string>> = {
  not_recruiting: '지금은 강사를 모집하지 않아요',
  genre_mismatch: '학원 장르와 맞지 않아요',
  info_needed: '정보가 더 필요해요',
  other: '기타',
};

/** 「기타」면 대표가 쓴 한 줄을, 아니면 목록 문구를 보인다 */
export function rejectReasonLabel(code: string | null, text: string | null): string {
  if (code === 'other' && text !== null && text.trim().length > 0) return text;
  if (code !== null && REJECT_REASON_LABELS[code] !== undefined) return REJECT_REASON_LABELS[code]!;
  return text ?? '사유가 적혀 있지 않아요';
}

// ---- 학원 색(I9E) -----------------------------------------------------------------------------

/**
 * 12색 — 배열 자리 번호가 곧 서버에 저장하는 colorIndex(0~11)다. 순서를 바꾸면 이미 고른 색이 바뀐다.
 * 이름·순서는 admin-web `lib/domain/academy-colors.ts` 와 같고, 색 값(hex)은 Penpot 보드 I9E 의
 * 색 동그라미 채움을 그대로 읽어 왔다(2026-11-21). 빨강·주황 쪽은 결석(진한 빨강)·결제 대기(진한 주황)와
 * 헷갈리지 않게 연한 로즈·코랄만 둔다.
 */
export const ACADEMY_COLORS = [
  { key: 'rose', label: '로즈', hex: '#C46B7D' },
  { key: 'coral', label: '코랄', hex: '#D0866A' },
  { key: 'amber', label: '앰버', hex: '#C9A24A' },
  { key: 'olive', label: '올리브', hex: '#9AA54E' },
  { key: 'green', label: '그린', hex: '#6F9A7C' },
  { key: 'mint', label: '민트', hex: '#4FA38C' },
  { key: 'teal', label: '틸', hex: '#4F9A9F' },
  { key: 'sky', label: '스카이', hex: '#5B9BC4' },
  { key: 'blue', label: '블루', hex: '#5B7DB1' },
  { key: 'indigo', label: '인디고', hex: '#4A5AA8' },
  { key: 'purple', label: '퍼플', hex: '#8A72B5' },
  { key: 'magenta', label: '마젠타', hex: '#B36AA6' },
] as const;

export function setAffiliationColor(affiliationId: string, colorIndex: number): Promise<{ affiliationId: string; colorIndex: number }> {
  return apiFetch(`/api/instructor/affiliations/${encodeURIComponent(affiliationId)}/color`, {
    method: 'PUT',
    body: { colorIndex },
  });
}

// ---- 날짜 글자 --------------------------------------------------------------------------------

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 「2026-05-03」(KST 날짜 글자) → 「2026-05-03 (일)」. 날짜만 있는 값이라 시차 계산 없이 요일만 붙인다 */
export function dateWithWeekday(ymd: string): string {
  const time = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(time)) return ymd;
  return `${ymd} (${WEEKDAYS[new Date(time).getUTCDay()]})`;
}

/** 시각(…Z) → 한국 날짜 「11/9 (월)」(보드 I27B 카드의 신청·거절 날짜) */
export function kstMonthDayWeekday(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const kst = new Date(time + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} (${WEEKDAYS[kst.getUTCDay()]})`;
}
