// S2-1.2(강사 가입 API) — 사업자등록번호 모양 검사(순수 함수). DB·네트워크를 모른다.
//   근거: 계약 11 §1-3 「번호를 보냈으면 10자리 숫자와 체크섬만 본다(국세청 조회 없음)」 · 데이터 §8-3 ck_instr_profiles_brn
//   강사 가입(S2-1.2)이 먼저 쓰고, 마이에서 나중에 넣는 경로(S2-1.2b)가 같은 함수를 쓴다.
//
// 체크섬이란: 사업자등록번호 10자리 중 마지막 한 자리는 앞 9자리로 계산한 「검사 숫자」다.
// 숫자 하나를 잘못 치면 이 계산이 안 맞아서, 국세청에 묻지 않고도 오타를 바로 잡을 수 있다.

/** 앞 9자리에 곱하는 가중치(국세청 공개 규칙) */
const WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5] as const;

/** 하이픈을 넣어 써도 받는다(「123-45-67890」). 그 밖의 글자가 섞이면 모양부터 틀린 것이다 */
const INPUT_PATTERN = /^\d{3}-?\d{2}-?\d{5}$/;

/**
 * 입력을 숫자 10자리로 맞춘다. 모양이 틀리면 null.
 * DB 칸(ck_instr_profiles_brn)은 하이픈 없는 10자리만 받으므로 저장 전에 꼭 이 함수를 거친다.
 */
export function normalizeBusinessRegistrationNumber(input: string): string | null {
  const trimmed = input.trim();
  if (!INPUT_PATTERN.test(trimmed)) return null;
  return trimmed.replace(/-/g, "");
}

/**
 * 숫자 10자리의 체크섬이 맞나.
 * 계산: 앞 9자리 × 가중치를 더하고, 9번째 자리 × 5 의 십의 자리를 한 번 더 더한다.
 *       (10 − 합의 일의 자리) 의 일의 자리가 마지막 숫자와 같으면 맞다.
 */
export function hasValidBusinessNumberChecksum(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  let sum = 0;
  WEIGHTS.forEach((w, i) => {
    sum += (d[i] ?? 0) * w;
  });
  sum += Math.floor(((d[8] ?? 0) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === d[9];
}

/** 모양 + 체크섬을 한 번에. 맞으면 저장할 10자리, 틀리면 null */
export function parseBusinessRegistrationNumber(input: string): string | null {
  const digits = normalizeBusinessRegistrationNumber(input);
  if (digits === null || !hasValidBusinessNumberChecksum(digits)) return null;
  return digits;
}
