/**
 * 가입·취향 API 호출 묶음 — T-A5-2(가입·취향 화면 5종).
 *
 * 경로·본문은 `_workspace/03_contracts/01-member-onboarding.md` 를 그대로 옮겼다.
 * 실제 전송·오류 해석은 `mobile/lib/api.ts` 의 `apiFetch` 가 한다.
 */
import { apiFetch } from '../api';
import { setSessionToken } from '../session';
import type {
  FakeVerifyInput,
  FakeVerifyResult,
  Genre,
  Member,
  ProfileInput,
  SignInResponse,
  SignupInput,
  SubGenre,
} from './types';

/**
 * 계약 §1(로그인) — Better Auth 이메일 로그인 후 토큰을 저장한다.
 *
 * 계약은 bearer 플러그인의 응답 헤더 `set-auth-token` 을 저장하라고 하지만 헤더 이름은 미확인(R-10)이고,
 * `apiFetch` 는 본문만 돌려준다. 그래서 지금은 Better Auth 응답 본문의 `token` 을 저장한다.
 * 이 값이 bearer 로 통하는지는 T-M1-4(Better Auth 스모크)에서 확인해야 한다.
 */
export async function signInWithEmail(email: string, password: string): Promise<void> {
  const response = await apiFetch<SignInResponse>('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email, password },
    auth: false,
  });
  if (!response?.token) {
    throw new Error('로그인 응답에 토큰이 없다');
  }
  await setSessionToken(response.token);
}

/** 계약 §4 — 내 회원 정보. 가입 전이면 403 `SIGNUP_INCOMPLETE`. */
export function fetchMe(signal?: AbortSignal): Promise<Member> {
  return apiFetch<Member>('/api/me', { signal });
}

/** 계약 §2 — 가짜 본인확인(dev 전용). 실제 본인확인 기관이 생기면 이 호출이 사라진다. */
export function fakeVerifyIdentity(input: FakeVerifyInput): Promise<FakeVerifyResult> {
  return apiFetch<FakeVerifyResult>('/api/dev/identity/fake-verify', { method: 'POST', body: input });
}

/**
 * 계약 §3 — 가입 완료. 처음이면 201, 이미 가입했으면 200 으로 같은 회원이 온다.
 * 본문은 본인확인 토큰·고지 확인·닉네임·동의 여섯 칸이다(S3-1.8(앱 가입·동의·취향 화면 보정)에서 닉네임·동의를 더함).
 */
export function completeSignup(input: SignupInput): Promise<Member> {
  return apiFetch<Member>('/api/members', { method: 'POST', body: input });
}

/** 계약 §5 — 취향 전체 교체(FR-022(사용자 프로필)). */
export function saveProfile(profile: ProfileInput): Promise<Member> {
  return apiFetch<Member>('/api/me/profile', { method: 'PUT', body: profile });
}

/**
 * 계약 §6 — 기준 장르 1개와 세부 장르(FR-022a(첫 화면 장르 선택·유지)).
 * 세부 장르는 null(「전체」)이어도 늘 같이 보낸다 — 서버가 두 칸을 함께 덮어써서 예전 값이 남지 않는다.
 */
export function saveBaseGenre(baseGenre: Genre, baseSubGenre: SubGenre | null): Promise<Member> {
  return apiFetch<Member>('/api/me/base-genre', { method: 'PUT', body: { baseGenre, baseSubGenre } });
}
