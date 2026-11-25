/**
 * 가입·취향 흐름에서 주고받는 값의 타입 — T-A5-2(가입·취향 화면 5종).
 *
 * 모양의 원본은 `_workspace/03_contracts/01-member-onboarding.md`(US1-A1(가입·취향) API 계약)이고,
 * 값 집합은 `_workspace/03_data-model.md` §3(§4.1(상태·구분 값 집합))이다.
 * 서버 쪽 상수(`admin-web/lib/domain/constants.ts`)와 같은 값을 쓴다 — 앱은 다른 패키지라
 * import 할 수 없어 여기 다시 적었다. 값이 바뀌면 두 곳을 같이 고친다.
 */

/** FR-020(장르 4종). 화면 표기는 `labels.ts` 가 붙인다. */
export const GENRES = ['dance_sport', 'argentine_tango', 'swing', 'salsa_bachata'] as const;
export type Genre = (typeof GENRES)[number];

/** FR-022a(첫 화면 장르 선택·유지) 세부 장르 — 서버 `CLASS_SUB_GENRES` 와 같은 값. null 은 「전체」. */
export const SUB_GENRES = ['latin', 'standard', 'salsa', 'bachata'] as const;
export type SubGenre = (typeof SUB_GENRES)[number];

/**
 * 장르마다 고를 수 있는 세부 장르(서버 `SUB_GENRES_OF` 와 같은 짝).
 * 탱고·스윙은 목록이 비어 있어 세부 장르 칩이 나오지 않는다.
 */
export const SUB_GENRES_OF: Readonly<Record<Genre, readonly SubGenre[]>> = {
  dance_sport: ['latin', 'standard'],
  argentine_tango: [],
  swing: [],
  salsa_bachata: ['salsa', 'bachata'],
};

/** FR-029(경험 수준 구간) 6구간. */
export const EXPERIENCE_LEVELS = [
  'entry',
  'beginner',
  'novice_intermediate',
  'intermediate',
  'advanced',
  'dancer',
] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** 성별 — 출처는 본인확인 결과(FR-002(가입 정보 수집·고지)). */
export type Gender = 'male' | 'female';

/** 활동 지역 한 칸. 계약 §5(취향) `regions` 원소. */
export interface Region {
  readonly sido: string;
  readonly gu: string;
}

/** 계약 §5(취향) 요청 본문. PUT 이라 전체 교체다. */
export interface ProfileInput {
  readonly interestGenres: readonly Genre[];
  readonly regions: readonly Region[];
  readonly availableFrom: string | null;
  readonly availableTo: string | null;
  readonly experienceLevel: ExperienceLevel | null;
}

/** 계약 §3(가입 완료)의 `Member` 응답. */
export interface Member {
  readonly id: string;
  readonly name: string;
  /** FR-019a(회원 닉네임 표시) — 강사·대표·다른 회원에게 보이는 이름. 가입 때 한 번 정한다. */
  readonly nickname: string;
  readonly gender: Gender;
  readonly birthDate: string;
  readonly phoneMasked: string;
  readonly profile: ProfileInput;
  readonly baseGenre: Genre | null;
  /** 기준 장르 안의 세부 장르(FR-022a). null 이면 「전체」. */
  readonly baseSubGenre: SubGenre | null;
  readonly onboarding: {
    readonly profileDone: boolean;
    readonly baseGenreDone: boolean;
  };
}

/**
 * 계약 §3(가입 완료) `consents` 여섯 칸 — M-01(동의 항목) · 보드 C14A(약관 동의).
 * 앞 넷이 필수, `marketing`·`location` 이 선택이다. 서버는 필수 넷 중 하나라도 false 면
 * 422 `CONSENT_REQUIRED` 로 가입을 막는다(S3-1 수용 ①).
 */
export const REQUIRED_CONSENTS = ['memberTerms', 'memberPrivacyCollection', 'academySharing', 'age19Plus'] as const;
export const OPTIONAL_CONSENTS = ['marketing', 'location'] as const;
export type ConsentKey = (typeof REQUIRED_CONSENTS)[number] | (typeof OPTIONAL_CONSENTS)[number];
export type SignupConsents = Readonly<Record<ConsentKey, boolean>>;

/** 계약 §3(가입 완료) 요청 본문. 이름·성별·생년·연락처는 본인확인 값으로만 채우므로 싣지 않는다. */
export interface SignupInput {
  readonly verificationToken: string;
  readonly noticeAcknowledged: true;
  readonly nickname: string;
  readonly consents: SignupConsents;
}

/** 계약 §2(가짜 본인확인) 요청 본문. dev 전용 경로다. */
export interface FakeVerifyInput {
  readonly name: string;
  readonly gender: Gender;
  readonly birthDate: string;
  readonly phone: string;
  readonly personKey: string;
}

/** 계약 §2(가짜 본인확인) 응답. */
export interface FakeVerifyResult {
  readonly verificationToken: string;
  readonly expiresAt: string;
}

/**
 * Better Auth 1.7.5 `sign-in/email` 응답 중 이 앱이 읽는 칸만.
 * 응답 모양은 Better Auth 가 정한다(계약 §1(로그인)) — 그래서 전부 선택 칸으로 둔다.
 */
export interface SignInResponse {
  readonly token?: string | null;
}
