// S1-1.8(대표 가입 API) — 직원(대표·강사) 가입의 순수 규칙. DB·시계·네트워크를 모른다.
//   근거: spec Q41(강사 가입 규칙) 임시 확정 · 계약 07 §0 · 11 §1-1~§1-3
//   대표 가입이 먼저 쓰고, 강사 가입(S2-1.2)이 같은 규칙을 그대로 가져다 쓴다(D24 「서비스 코드는 나눠 둔다」).
import { z } from "zod";

/** 아이디: 영문 소문자·숫자 4~20자(Q41). Better Auth 기본 규칙(밑줄·점 허용)보다 좁다 */
export const STAFF_USERNAME_PATTERN = /^[a-z0-9]{4,20}$/;
/** 비밀번호 최소 길이(Q41) */
export const STAFF_PASSWORD_MIN_LENGTH = 8;
/** 비밀번호 최대 길이 — 해시 계산(scrypt)에 아주 긴 값을 넣어 서버를 붙잡지 못하게(Better Auth 기본 128 과 같다) */
export const STAFF_PASSWORD_MAX_LENGTH = 128;
/** 표시 이름 길이(추천값, 계약 07 §0) */
export const STAFF_DISPLAY_NAME_MAX_LENGTH = 30;
/** 가입 가능한 나이(만). 회원·강사와 같다(계약 07 열린 점 ⑤ ⓑ) */
export const STAFF_MIN_AGE_YEARS = 19;

export function isValidStaffUsername(value: string): boolean {
  return STAFF_USERNAME_PATTERN.test(value);
}

/**
 * 비밀번호 규칙(Q41): 8자 이상 · 영문·숫자·기호를 **모두** 섞음 · 아이디와 같으면 안 됨.
 * 틀린 이유를 문장으로 돌려준다(맞으면 null) — 422 의 fields 에 그대로 싣는다.
 */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) return `비밀번호는 ${STAFF_PASSWORD_MIN_LENGTH}자 이상이어야 해요`;
  if (password.length > STAFF_PASSWORD_MAX_LENGTH) return `비밀번호는 ${STAFF_PASSWORD_MAX_LENGTH}자까지예요`;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /\d/.test(password);
  // 기호 = 영문·숫자·공백이 아닌 글자
  const hasSymbol = /[^A-Za-z0-9\s]/.test(password);
  if (!hasLetter || !hasDigit || !hasSymbol) return "비밀번호는 영문·숫자·기호를 모두 섞어 주세요";
  // 대소문자만 다른 것도 같은 것으로 본다 — 로그인 아이디는 소문자로 맞춰지기 때문이다
  if (password.toLowerCase() === username.toLowerCase()) return "비밀번호를 아이디와 다르게 정해 주세요";
  return null;
}

/**
 * 만 나이가 기준 이상인가. 생일이 지나야 한 살이 늘어난다(2월 29일생은 평년 2월 28일에 늘어난다 — Temporal 의 덧셈 규칙).
 * today 는 호출하는 쪽이 KST 날짜로 넘긴다(계약: 기준일은 요청 시각의 KST 날짜).
 */
export function isAtLeastAge(birthDate: Temporal.PlainDate, today: Temporal.PlainDate, years: number): boolean {
  return Temporal.PlainDate.compare(birthDate.add({ years }), today) <= 0;
}

/** 이름 가리기: 「김대표」→「김*표」, 「이준」→「이*」. 첫 글자와(세 글자 이상이면) 끝 글자만 남긴다 */
export function maskPersonName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length <= 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/** 휴대폰 가리기: 「01012345821」→「010-****-5821」. 앞 세 자리와 끝 네 자리만 남긴다 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

/** 아이디 가리기: 「latinhouse01」→「lat***e01」. 짧은 아이디(6자 이하)는 앞 두 자만 남긴다 */
export function maskUsername(username: string): string {
  if (username.length <= 6) return `${username.slice(0, 2)}${"*".repeat(Math.max(username.length - 2, 1))}`;
  return `${username.slice(0, 3)}***${username.slice(-3)}`;
}

/** 본인확인 토큰 칸 — 모양만 본다. 진짜인지는 IdentityVerificationPort 가 푼다 */
export const verificationTokenSchema = z.string().min(1).max(4096);
