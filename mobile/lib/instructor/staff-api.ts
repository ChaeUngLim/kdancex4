/**
 * 강사·대표 앱이 부르는 API 와 응답 모양 — S2-1.7(앱 강사 가입·소속·프로필 화면).
 *
 * 서버 경로는 이미 있는 것만 부른다(새 경로를 만들지 않았다).
 *   POST /api/auth/sign-in/username                  Better Auth 아이디 로그인(README §6-1). 앱은 bearer 토큰을 받는다
 *   POST /api/auth/sign-out                          로그아웃(토큰을 서버에서도 끝낸다)
 *   GET  /api/staff/me                               내 역할·학원별 위임 권한(README §6-1)
 *   POST /api/dev/identity/fake-verify               가짜 휴대폰 본인확인(01 §2, 실제 기관이 붙기 전까지)
 *   POST /api/instructor/signup/identity-check       본인확인으로 가입 자격 보기(11 §1-1, I31C)
 *   GET  /api/instructor/signup/username-available   아이디 중복 확인(11 §1-2, I31)
 *   POST /api/instructor/signup                      강사 계정 만들기(11 §1-3, I31)
 *   GET  /api/instructor/me/profile                  내 프로필 — 마이 첫 줄(11 §2-1, I9)
 *   GET  /api/instructor/affiliations                학원별 소속 상태 카드(08 §2, I12 칩)
 *   GET  /api/instructor/staff-notices?academyId=    그 학원 대표가 보낸 공지(09 §3, I12 「학원 공지」)
 *
 * 응답 모양은 admin-web 의 zod 스키마(instructor-profile.ts · instructor-affiliations.ts ·
 * staff-notice-reads.ts · staff-me.ts · instructor-signup.ts)에서 이 화면이 읽는 칸만 옮겼다.
 */
import { ApiError, apiFetch } from '../api';
import type { Genre } from '../onboarding/types';
import { clearSessionToken, setSessionToken } from '../session';

/** 로그인 화면의 두 탭. 서버 역할 이름과 같다 */
export type StaffRole = 'instructor' | 'owner';

/** `GET /api/staff/me` 에서 앱이 읽는 칸 */
export interface StaffMe {
  accountId: string;
  displayName: string;
  roles: string[];
  academies: { academyId: string; name: string; as: 'owner' | 'delegate'; permissions: string[] }[];
}

/** `GET /api/instructor/affiliations` 카드 한 장 — 학원마다 가장 최근 소속 행 하나 */
export interface AffiliationCard {
  affiliationId: string;
  academyId: string;
  academyName: string;
  status: 'pending' | 'active' | 'rejected' | 'withdrawn' | 'released' | (string & {});
  source: string;
  requestedAt: string;
  decidedAt: string | null;
  rejectReasonCode: string | null;
  rejectReasonText: string | null;
  releasedAt: string | null;
  /** 학원 색 번호(0~11, 12색 무지개 순 자리). 아직 색이 없으면 null — I9E 가 처음 상태를 이 값으로 그린다(계약 08 §2) */
  calendarColorIndex: number | null;
  /** 앱에서 이 학원에 수업을 올릴 수 있나 — 소속됨 + 대표가 켠 앱 「수업 등록」(class_submit). 서버가 판정한다(계약 08 §2, 2026-11-23) */
  canSubmitClass: boolean;
}

/** `GET /api/instructor/me/profile` */
export interface InstructorProfile {
  accountId: string;
  displayName: string;
  activityGenre: Genre;
  photo: { fileId: string; url: string } | null;
  careerYears: number | null;
  bio: string | null;
  affiliations: { academyId: string; name: string; status: 'pending' | 'active' }[];
}

/** 학원 공지 분류 4종(admin-web `STAFF_NOTICE_CATEGORIES`) */
export type StaffNoticeCategory = 'class_cancelled' | 'class_changed' | 'academy_schedule' | 'other';

/** `GET /api/instructor/staff-notices` 한 장 */
export interface InstructorNotice {
  noticeId: string;
  academyId: string;
  academyName: string;
  category: StaffNoticeCategory | (string & {});
  title: string;
  body: string;
  publishedAt: string;
  readAt: string | null;
}

/** 공지 분류 → 작은 배지 글자(보드 I12 「휴강」·「변경」) */
const NOTICE_CATEGORY_LABELS: Readonly<Record<StaffNoticeCategory, string>> = {
  class_cancelled: '휴강',
  class_changed: '변경',
  academy_schedule: '학원 일정',
  other: '안내',
};

export function noticeCategoryLabel(category: string): string {
  return NOTICE_CATEGORY_LABELS[category as StaffNoticeCategory] ?? '안내';
}

// ---- 로그인 · 로그아웃 ------------------------------------------------------------------

/** Better Auth 아이디 로그인 응답에서 읽는 칸. 2단계 인증이 걸린 계정이면 token 대신 twoFactorRedirect 가 온다 */
interface UsernameSignInResponse {
  token?: string | null;
  twoFactorRedirect?: boolean;
}

/** 로그인 실패를 화면 문구로 바꾼 오류. code 로 화면이 갈래를 고른다 */
export const WRONG_CREDENTIALS = '아이디 또는 비밀번호가 맞지 않아요.';

/**
 * 아이디·비밀번호로 로그인하고 토큰을 저장한다.
 *
 * Better Auth 의 실패 본문은 우리 오류 모양(§4)이 아니라 `apiFetch` 가 UNEXPECTED_RESPONSE 로 바꾼다.
 * 그래서 상태 401 은 「아이디·비밀번호가 틀림」으로 읽는다.
 * 앱은 2단계 인증을 묻지 않는다(README §6-1). 그래도 서버가 twoFactorRedirect 를 주면(관리자 웹에서
 * 인증 앱을 켠 계정) 세션이 없으니 그대로 멈추고 알린다 — 이 경우를 어떻게 풀지는 서버 쪽 결정이다.
 */
export async function signInWithUsername(username: string, password: string): Promise<void> {
  let response: UsernameSignInResponse;
  try {
    response = await apiFetch<UsernameSignInResponse>('/api/auth/sign-in/username', {
      method: 'POST',
      body: { username, password },
      auth: false,
    });
  } catch (error: unknown) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
      throw new ApiError(401, 'BAD_REQUEST', WRONG_CREDENTIALS);
    }
    throw error;
  }
  if (response?.twoFactorRedirect === true) {
    throw new ApiError(
      403,
      'TWO_FACTOR_REQUIRED',
      '이 계정은 인증 앱 확인이 켜져 있어 앱에서 바로 로그인할 수 없어요. 관리자 웹에서 로그인해 주세요.',
    );
  }
  if (!response?.token) {
    throw new ApiError(0, 'UNEXPECTED_RESPONSE', '로그인 응답을 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  }
  await setSessionToken(response.token);
}

/** 로그아웃 — 서버 세션을 먼저 끝내고, 실패해도 기기의 토큰은 지운다(남겨 두면 다시 들어와진다) */
export async function signOutStaff(): Promise<void> {
  try {
    await apiFetch<unknown>('/api/auth/sign-out', { method: 'POST', body: {} });
  } catch {
    // 서버가 이미 세션을 잃었거나 연결이 안 돼도 기기에서는 로그아웃한다
  }
  await clearSessionToken();
}

export function fetchStaffMe(signal?: AbortSignal): Promise<StaffMe> {
  return apiFetch<StaffMe>('/api/staff/me', { signal });
}

/** 역할별로 로그인 뒤 처음 갈 화면. 강사 홈(I1)이 아직 없어 학원 탭(I12)으로 연다 */
export const ROLE_HOME = { instructor: '/instructor/academy', owner: '/owner' } as const;

/** 고른 탭의 역할이 없는 계정에 보일 문구(계약 11 §1 「이 계정에는 강사 권한이 없어요」) */
export const ROLE_MISSING: Readonly<Record<StaffRole, string>> = {
  instructor: '이 계정에는 강사 권한이 없어요.',
  owner: '이 계정에는 대표 권한이 없어요.',
};

/**
 * 로그인 → 역할 확인. 고른 탭의 역할이 없으면 바로 로그아웃시키고 오류를 던진다.
 * 화면 보호는 서버가 매 요청 역할을 다시 보므로(FR-011a) 이 확인은 「잘못 고른 탭」 안내용이다.
 */
export async function signInAs(role: StaffRole, username: string, password: string): Promise<StaffMe> {
  await signInWithUsername(username, password);
  const me = await fetchStaffMe();
  if (!me.roles.includes(role)) {
    await signOutStaff();
    throw new ApiError(403, 'ROLE_MISSING', ROLE_MISSING[role]);
  }
  return me;
}

// ---- 강사 가입(I31C → I31) ---------------------------------------------------------------

export interface IdentityCheckResult {
  eligible: true;
  nameMasked: string;
  phoneMasked: string;
  ageVerified: boolean;
}

export function checkInstructorIdentity(verificationToken: string): Promise<IdentityCheckResult> {
  return apiFetch<IdentityCheckResult>('/api/instructor/signup/identity-check', {
    method: 'POST',
    body: { verificationToken },
    auth: false,
  });
}

export interface UsernameAvailability {
  available: boolean;
  reason?: 'taken' | 'format';
}

export function checkUsernameAvailable(username: string): Promise<UsernameAvailability> {
  return apiFetch<UsernameAvailability>(
    `/api/instructor/signup/username-available?username=${encodeURIComponent(username)}`,
    { auth: false },
  );
}

export interface InstructorSignupInput {
  verificationToken: string;
  username: string;
  password: string;
  displayName: string;
  activityGenre: Genre;
  businessRegistrationNumber: string | null;
  consents: { merchantTerms: boolean; merchantPrivacyCollection: boolean; marketing: boolean };
}

export interface InstructorSignupResult {
  accountId: string;
  username: string;
  displayName: string;
  activityGenre: Genre;
  roles: ['instructor'];
  next: 'sign_in';
}

export function signupInstructor(input: InstructorSignupInput): Promise<InstructorSignupResult> {
  return apiFetch<InstructorSignupResult>('/api/instructor/signup', { method: 'POST', body: input, auth: false });
}

// ---- 화면 계산(렌더 중에 바로 쓰는 순수 함수) ---------------------------------------------

/** 마이 첫 줄 아래 글자 — 소속 학원 첫 이름 + 「외 N」. 소속이 없으면 안내 */
export function affiliationSummary(affiliations: readonly { name: string; status: string }[]): string {
  const active = affiliations.filter((a) => a.status === 'active');
  if (active.length === 0) {
    return affiliations.length > 0 ? '소속 승인을 기다리고 있어요' : '아직 소속 학원이 없어요';
  }
  const first = active[0]!.name;
  return active.length === 1 ? first : `${first} 외 ${active.length - 1}`;
}

/**
 * 학원 탭 칩 — 소속됨(active)·승인 대기(pending)만. 끝난 소속(거절·철회·해제)은 칩으로 보이지 않는다.
 * 소속됨을 앞에 둔다 — 아무 칩도 안 눌렀을 때 첫 칩이 골라지므로, 시간표·공지가 열린 학원이 먼저 보이게 하려는 것이다.
 * 같은 상태 안에서는 서버 순서(최근 신청이 위)를 그대로 둔다.
 */
export function academyChips(cards: readonly AffiliationCard[]): AffiliationCard[] {
  const active = cards.filter((card) => card.status === 'active');
  const pending = cards.filter((card) => card.status === 'pending');
  return [...active, ...pending];
}

/** 학원 이름의 첫 글자 — 보드 I12 머리의 동그란 학원 표시(「L」)와 칩 앞 글자 */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.length === 0 ? '?' : trimmed.charAt(0).toUpperCase();
}

/**
 * 앱 수업 등록 권한(class_submit)이 그 학원에 켜져 있나 — 소속 카드의 canSubmitClass 를 본다.
 * 전에는 staff/me 의 학원별 권한에서 찾았는데, staff/me 는 계약상 관리자 웹 위임만 담아(README §6-1)
 * 대표가 권한을 켜도 늘 「없음」으로 보였다(2026-11-23 실서버 시연에서 발견). 소속됨이 아니면 언제나 false.
 */
export function canSubmitClass(card: Pick<AffiliationCard, 'status' | 'canSubmitClass'>): boolean {
  return card.status === 'active' && card.canSubmitClass === true;
}

/** 공지 날짜 「10/2」 — 한국 시각 기준 월/일 */
export function shortKstDate(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return '';
  }
  const kst = new Date(time + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()}`;
}
