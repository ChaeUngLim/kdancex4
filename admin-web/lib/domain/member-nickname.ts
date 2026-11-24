// S3-1.2(가짜 본인확인·가입 API) — 회원 닉네임 규칙(FR-019a(회원 닉네임 표시) · 계약 01 §3 「닉네임」 표).
//
// 강사·대표·다른 회원에게 보이는 이름은 닉네임뿐이다(본명은 내리지 않는다). 그래서 가입 때 반드시 받고,
// 비어 있으면 본명으로 채우지 않는다 — 본명이 그대로 드러나는 것을 막기 위해서다.
//
// 규칙은 이 파일 한 곳에만 둔다(계약 01 열린 점 ②: 「바꾸려면 상수 셋만 고친다」).
//   - 앞뒤 공백을 자르고, 가운데 연속 공백은 한 칸으로 줄인 뒤 2~12자(글자 수 기준)
//   - 한글·영문·숫자·공백·`_`·`.` 만
//   - 중복은 허용한다(UNIQUE 없음 — data-model §15-4 ①)
//   - 금칙어가 들어 있으면(부분 일치) 따로 NICKNAME_NOT_ALLOWED 로 알린다
// DB 에도 같은 길이 규칙이 걸려 있다(ck_members_nickname). 둘이 어긋나면 tests/unit/member-nickname.test.ts 가 잡는다.

/** 최소·최대 글자 수. DB 제약 ck_members_nickname 의 `BETWEEN 2 AND 12` 와 같은 값이다 */
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 12;

/**
 * 금칙어(부분 일치, 영문은 대소문자 무시). 욕설과 운영 주체를 사칭하는 말을 막는다.
 * 목록 내용은 계약이 「구현 때 정한다」고 남겨 둔 값이다 — 임시 확정(2026-11-23, 추천안으로 진행, 사후 확인).
 */
export const NICKNAME_BLOCKED_WORDS = [
  // 사칭 — 앱 운영 주체·직원처럼 보이게 하는 말
  "운영자",
  "관리자",
  "운영팀",
  "고객센터",
  "kdance",
  "k-dance",
  "admin",
  // 욕설 — 흔한 것만. 자모를 풀어 쓰는 우회까지 막지는 않는다(신고·운영자 처리 몫)
  "씨발",
  "시발",
  "개새끼",
  "병신",
  "좆",
  "fuck",
] as const;

/** 허용 문자: 한글 음절·영문·숫자·공백·밑줄·점 */
const ALLOWED_CHARS = /^[가-힣A-Za-z0-9 _.]+$/u;

/** 앞뒤 공백을 자르고, 가운데 연속 공백(탭·줄바꿈 포함)을 한 칸으로 줄인다. 저장하는 값은 이 결과다 */
export function normalizeNickname(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ");
}

/**
 * 모양 검사 — 문제가 있으면 사람이 읽을 안내 문장을, 없으면 null.
 * 입력은 normalizeNickname 을 거친 값이어야 한다. 글자 수는 UTF-16 길이가 아니라 글자(코드 포인트) 수로 센다.
 */
export function nicknameShapeProblem(normalized: string): string | null {
  const length = [...normalized].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX) {
    return `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 적어 주세요`;
  }
  if (!ALLOWED_CHARS.test(normalized)) {
    return "닉네임에는 한글·영문·숫자·공백·_·. 만 쓸 수 있어요";
  }
  return null;
}

/** 금칙어가 들어 있나(부분 일치). 공백·점·밑줄을 빼고도 한 번 더 봐서 「운 영 자」 같은 띄어 쓰기 우회를 막는다 */
export function containsBlockedWord(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  const squeezed = lower.replace(/[\s_.]/gu, "");
  return NICKNAME_BLOCKED_WORDS.some((word) => lower.includes(word) || squeezed.includes(word.replace(/[\s_.-]/gu, "")));
}
