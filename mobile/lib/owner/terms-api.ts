/**
 * 대표 앱 「약관·동의 기록」(보드 O35) 이 부르는 API 와 응답 모양 — S1-1.34(대표 앱 약관·수수료 변경 안내).
 *
 * 서버는 S1-1.24(동의 기록·약관 전문·통지 읽음 API)가 만든 경로를 그대로 쓴다(계약 07 §5).
 *   GET  /api/staff/me                                              내 학원 목록(대표인 학원을 고른다)
 *   GET  /api/academies/{academyId}/consents                       동의 기록 + 아직 시행 전인 약관 변경 통지
 *   POST /api/academies/{academyId}/terms-notices/{noticeId}/read  통지 읽음(두 번 눌러도 처음 읽은 시각 그대로)
 *
 * 인증은 `apiFetch` 가 붙이는 Bearer 토큰이다. 서버 규칙(2단계 인증을 마친 세션만 받는다,
 * 계약 07 열린 점 ⑰ ⓐ)은 이 Task 에서 바꾸지 않았다.
 */
import { apiFetch } from '../api';

/** terms_versions.kind · merchant_consents.item — admin-web `TERMS_KINDS` 와 같은 7가지 */
export type TermsKind =
  | 'merchant_terms'
  | 'merchant_privacy_collection'
  | 'privacy_policy'
  | 'platform_fee_notice'
  | 'card_fee_notice'
  | 'content_license'
  | 'one_plus_one_notice';

/** 동의 기록 한 줄 — 항목마다 지금 유효한 동의 하나 */
export interface ConsentItem {
  item: TermsKind;
  version: string;
  termsVersionId: string;
  agreedAt: string;
  current: true;
}

/** 약관 변경 통지 한 줄. 읽음 처리 응답도 같은 모양이다 */
export interface TermsNotice {
  noticeId: string;
  item: TermsKind;
  version: string;
  effectiveAt: string;
  notifiedAt: string;
  /** 아직 안 읽었으면 null */
  readAt: string | null;
}

export interface AcademyConsents {
  items: ConsentItem[];
  pendingChanges: TermsNotice[];
}

/** `GET /api/staff/me` 에서 이 화면이 쓰는 칸만 */
export interface StaffMe {
  academies: { academyId: string; name: string; as: 'owner' | 'delegate' }[];
}

/** 화면에 보일 항목 이름 — 보드 O35 의 줄 제목을 따랐다. 모르는 값은 원래 값 그대로 보인다 */
const TERMS_LABELS: Readonly<Record<TermsKind, string>> = {
  merchant_terms: '입점 이용약관(학원·강사)',
  merchant_privacy_collection: '개인정보 수집·이용',
  privacy_policy: '개인정보 처리방침',
  platform_fee_notice: '판매 수수료',
  card_fee_notice: '결제·카드 수수료 대표 부담',
  content_license: '콘텐츠 이용 허락',
  one_plus_one_notice: '1+1 할인권 안내 확인',
};

export function termsLabel(kind: string): string {
  return TERMS_LABELS[kind as TermsKind] ?? kind;
}

/** 대표로 있는 첫 학원. 위임만 받은 학원은 이 화면(대표 전용)의 대상이 아니다 */
export function pickOwnerAcademy(me: StaffMe): { academyId: string; name: string } | null {
  const owned = (me.academies ?? []).find((academy) => academy.as === 'owner');
  return owned === undefined ? null : { academyId: owned.academyId, name: owned.name };
}

export function consentsPath(academyId: string): string {
  return `/api/academies/${encodeURIComponent(academyId)}/consents`;
}

/** 통지 읽음 — 서버가 처음 읽은 시각을 채운 같은 모양의 한 줄을 돌려준다 */
export function markTermsNoticeRead(academyId: string, noticeId: string): Promise<TermsNotice> {
  return apiFetch<TermsNotice>(
    `/api/academies/${encodeURIComponent(academyId)}/terms-notices/${encodeURIComponent(noticeId)}/read`,
    { method: 'POST' },
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 적용일까지 남은 날 수(올림). 「D-30」 처럼 보이려고 쓴다.
 * 지금 시각은 렌더할 때 넘겨받는다 — 같은 화면 안에서 줄마다 다른 「지금」이 섞이지 않게.
 */
export function daysUntil(iso: string, now: Date): number | null {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return null;
  }
  return Math.max(0, Math.ceil((target - now.getTime()) / DAY_MS));
}
