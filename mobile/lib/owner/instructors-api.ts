/**
 * 대표 앱 「강사 관리」(보드 O37)·「강사 권한」(보드 O38) 이 부르는 API 와 응답 모양
 * — S1-2.16(대표 앱 강사 소속·위임 화면).
 *
 * 서버는 관리자 웹(S1-2.14)과 같은 경로를 그대로 쓴다(계약 08-owner-staff.md).
 *   GET  /api/staff/me                                                  내가 대표인 학원 고르기
 *   GET  /api/academies/{academyId}/affiliations?status=pending|active  소속 신청·소속 강사 목록(§3)
 *   POST /api/academies/{academyId}/affiliations/{id}/approve           승인(+ 강사 몫 비율, §3)
 *   PUT  /api/academies/{academyId}/affiliations/{id}/permissions       위임 권한 전체 교체(§4)
 *   POST /api/academies/{academyId}/invites                             1회용 초대 링크(§1)
 *
 * 화면과 나눠 둔 이유: 「60 을 넣으면 6000bp」, 「토글 하나를 눌러도 나머지 권한은 그대로」 같은 규칙은
 * 버튼 모양과 상관이 없다. 웹(admin-web/lib/instructors-form.ts)과 같은 규칙이어야 해서 같은 방식으로 적었다.
 */
import { apiFetch } from '../api';
import type { Genre } from '../onboarding/types';

/** 위임 권한 3종(2026-11-20 사용자 결정 D3). 앱 수업 등록 `class_submit` 은 웹 2종과 따로 둔다(FR-081a) */
export type DelegationPermission = 'roster_manage' | 'class_manage' | 'class_submit';

/** 소속 목록 한 줄(계약 08 §3). 연락처는 서버가 가린 값만 준다(FR-187) */
export interface Affiliation {
  affiliationId: string;
  status: 'pending' | 'active';
  source: 'invite' | 'application' | (string & {});
  requestedAt: string;
  instructor: {
    accountId: string;
    displayName: string;
    phoneMasked: string | null;
    /** 강사 프로필(S2-1) 전에는 늘 null */
    activityGenre: Genre | null;
  };
  message: string | null;
  isAcademyEmployee: boolean;
  permissions: DelegationPermission[];
}

export interface AffiliationList {
  items: Affiliation[];
}

export interface ApprovedAffiliation {
  affiliationId: string;
  status: 'active';
  isAcademyEmployee: boolean;
  /** 학원 직원이면 null(비율이 없다) */
  shareRateBp: number | null;
  decidedAt: string;
}

export interface UpdatedDelegations {
  affiliationId: string;
  permissions: DelegationPermission[];
  changedAt: string;
}

export interface CreatedInvite {
  inviteId: string;
  /** 토큰 원문이 든 링크. 이 응답에서만 볼 수 있다(서버는 해시만 저장) */
  inviteUrl: string;
  expiresAt: string;
}

/**
 * O38 의 토글 3개 — 보드 순서·문구 그대로.
 * 맨 위 「수업 등록」이 앱 권한이고, 아래 둘이 관리자 웹 위임 2종이다.
 */
export const PERMISSION_TOGGLES: readonly { permission: DelegationPermission; title: string; hint: string }[] = [
  { permission: 'class_submit', title: '수업 등록', hint: '켜도 대표가 승인해야 회원에게 공개돼요' },
  {
    permission: 'roster_manage',
    title: '관리자 웹 · 예약·명단',
    hint: '전체 수강생 조회와 인원 관리를 관리자 웹에서 할 수 있어요',
  },
  { permission: 'class_manage', title: '관리자 웹 · 수업·포스터 등록', hint: '관리자 웹에서 수업을 올리고 취소할 수 있어요' },
];

/** 계약 enum 순서 — 서버도 이 순서로 저장·응답한다 */
const PERMISSION_ORDER: readonly DelegationPermission[] = ['roster_manage', 'class_manage', 'class_submit'];

/**
 * 토글 하나를 눌렀을 때 서버에 보낼 「켜 둘 권한 전부」(PUT 은 전체 교체다).
 * 핵심: 지금 켜진 다른 권한은 그대로 두고 누른 것 하나만 뒤집는다.
 * 이걸 빠뜨리면 앱에서 수업 등록만 껐는데 웹 위임까지 같이 꺼진다.
 */
export function togglePermission(
  current: readonly DelegationPermission[],
  permission: DelegationPermission,
): DelegationPermission[] {
  const next = new Set(current);
  if (next.has(permission)) {
    next.delete(permission);
  } else {
    next.add(permission);
  }
  return PERMISSION_ORDER.filter((p) => next.has(p));
}

/** 승인 입력의 고용 형태 — 프리랜서·사업자는 몫 비율이 있고, 학원 직원은 없다(결정 11) */
export type Employment = 'freelancer' | 'employee';

export interface ApproveForm {
  employment: Employment;
  ratePercent: string;
}

export const EMPTY_APPROVE_FORM: ApproveForm = { employment: 'freelancer', ratePercent: '' };

/**
 * 입력 → 승인 본문(계약 08 §3). 보낼 수 없으면 이유 한 줄을 돌려준다.
 *  - 학원 직원: `{ isAcademyEmployee: true }` — 비율 칸을 아예 보내지 않는다(보내면 422)
 *  - 프리랜서·사업자: % 정수 0~100 을 bp(×100)로 바꾼다(열린 점 ④). 기본값이 없어서 비우면 못 보낸다
 */
export function buildApproveBody(
  form: ApproveForm,
): { ok: true; body: { isAcademyEmployee: boolean; shareRateBp?: number } } | { ok: false; reason: string } {
  if (form.employment === 'employee') {
    return { ok: true, body: { isAcademyEmployee: true } };
  }
  const text = form.ratePercent.trim();
  if (text === '') {
    return { ok: false, reason: '강사 몫 비율을 넣어 주세요' };
  }
  if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
    return { ok: false, reason: '비율은 0~100 사이 정수로 넣어 주세요' };
  }
  return { ok: true, body: { isAcademyEmployee: false, shareRateBp: Number(text) * 100 } };
}

/** bp → 「60%」 */
export function percentLabel(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

const academyPath = (academyId: string, rest: string) => `/api/academies/${encodeURIComponent(academyId)}/${rest}`;

export function affiliationsPath(academyId: string, status: 'pending' | 'active'): string {
  return academyPath(academyId, `affiliations?status=${status}`);
}

export function approveAffiliation(
  academyId: string,
  affiliationId: string,
  body: { isAcademyEmployee: boolean; shareRateBp?: number },
): Promise<ApprovedAffiliation> {
  return apiFetch<ApprovedAffiliation>(academyPath(academyId, `affiliations/${encodeURIComponent(affiliationId)}/approve`), {
    method: 'POST',
    body,
  });
}

export function updatePermissions(
  academyId: string,
  affiliationId: string,
  permissions: DelegationPermission[],
): Promise<UpdatedDelegations> {
  return apiFetch<UpdatedDelegations>(
    academyPath(academyId, `affiliations/${encodeURIComponent(affiliationId)}/permissions`),
    { method: 'PUT', body: { permissions } },
  );
}

export function createInvite(academyId: string): Promise<CreatedInvite> {
  return apiFetch<CreatedInvite>(academyPath(academyId, 'invites'), { method: 'POST', body: {} });
}
