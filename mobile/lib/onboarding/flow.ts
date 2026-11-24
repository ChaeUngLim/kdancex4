/**
 * 가입 흐름의 순서와 화면 사이 임시 값 — T-A5-2(가입·취향 화면 5종).
 *
 * 순서(계약 `01-member-onboarding.md` 「흐름」 + 보드 C14A(약관 동의)):
 *   login → consent(약관 동의) → identity(가짜 본인확인) → signup(가입 완료) → preferences(취향) → base-genre(기준 장르) → 홈
 * 약관 동의는 spec M-01(동의 항목) 화면 문단대로 본인확인 앞에 둔다(S3-1.8(앱 가입·동의·취향 화면 보정)).
 */
import type { FakeVerifyInput, FakeVerifyResult, Member, SignupConsents } from './types';
import { REQUIRED_CONSENTS } from './types';

/** 가입을 아직 안 끝낸 사람이 처음 갈 화면 — 약관 동의(보드 C14A). */
export const SIGNUP_START_ROUTE = '/consent';

/**
 * T-A5-3(홈·상세·결제 대기·캘린더 화면)이 만드는 `app/(tabs)/home.tsx` 의 주소.
 * 괄호 폴더 `(tabs)` 는 주소에 들어가지 않는다(expo-router 의 그룹 규칙).
 */
export const HOME_ROUTE = '/home';

export type OnboardingRoute = '/preferences' | '/base-genre' | typeof HOME_ROUTE;

/**
 * 가입을 마친 회원이 다음에 갈 화면. 서버가 준 `onboarding` 플래그만 본다.
 * 취향 → 기준 장르 순서다. FR-022a(첫 화면 장르 선택·유지): 기준 장르 없이는 홈에 가지 않는다.
 */
export function nextOnboardingRoute(member: Member): OnboardingRoute {
  if (!member.onboarding.profileDone) {
    return '/preferences';
  }
  if (!member.onboarding.baseGenreDone) {
    return '/base-genre';
  }
  return HOME_ROUTE;
}

/** 본인확인 화면에서 넘겨받아 가입 화면이 보여 주고 보내는 값. */
export interface VerifiedIdentity {
  readonly input: FakeVerifyInput;
  readonly result: FakeVerifyResult;
}

/*
 * 본인확인 토큰은 주소(검색 파라미터)에 싣지 않고 메모리에만 둔다.
 * 주소는 기록·딥링크로 남을 수 있고, 토큰은 10분짜리 일회성이라 저장할 이유도 없다.
 * 앱을 껐다 켜면 사라지는데, 그때는 본인확인을 다시 하면 된다.
 * 객체를 고치지 않고 통째로 바꿔 끼운다.
 */
let verifiedIdentity: VerifiedIdentity | null = null;

export function setVerifiedIdentity(value: VerifiedIdentity): void {
  verifiedIdentity = value;
}

export function getVerifiedIdentity(): VerifiedIdentity | null {
  return verifiedIdentity;
}

export function clearVerifiedIdentity(): void {
  verifiedIdentity = null;
}

/** 토큰 유효 시각이 지났는지. 시각을 못 읽으면 지난 것으로 본다. */
export function isVerificationExpired(identity: VerifiedIdentity, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(identity.result.expiresAt);
  return Number.isNaN(expiresAt) || expiresAt <= now;
}

/*
 * 약관 동의 결과도 본인확인 토큰과 같은 까닭으로 메모리에만 둔다.
 * 서버에 남는 동의 기록은 가입 요청(`POST /api/members`)이 성공할 때 한 번에 쓴다 —
 * 동의 화면에서 따로 저장하지 않으니, 가입 전에 앱을 끄면 동의도 다시 받는다.
 */
let signupConsents: SignupConsents | null = null;

export function setSignupConsents(value: SignupConsents): void {
  signupConsents = value;
}

export function getSignupConsents(): SignupConsents | null {
  return signupConsents;
}

export function clearSignupConsents(): void {
  signupConsents = null;
}

/** 필수 넷에 모두 동의했는지. 화면 버튼과 가입 화면 진입 검사가 같은 판정을 쓴다. */
export function hasRequiredConsents(consents: SignupConsents | null): consents is SignupConsents {
  return consents !== null && REQUIRED_CONSENTS.every((key) => consents[key]);
}
