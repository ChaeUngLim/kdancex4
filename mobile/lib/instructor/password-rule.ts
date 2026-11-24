/**
 * 강사 비밀번호 규칙(Q41(강사 가입 규칙) 임시 확정) — 가입(I31)과 비밀번호 새로 정하기(I31B)가 같이 쓴다.
 *
 * 8자 이상 · 영문·숫자·기호가 모두 섞임 · 아이디와 같으면 안 됨.
 * 서버(admin-web staff-signup.ts 의 passwordProblem)도 같은 규칙으로 다시 본다.
 * 이 함수는 버튼을 미리 끄고 칸 아래 안내를 보이는 용도다 — 최종 판정은 서버가 한다.
 *
 * S2-1.7(앱 강사 가입 화면)이 가입 화면 안에 두던 함수를 S2-1.10(I31B)에서 같이 쓰려고 이 파일로 옮겼다.
 * 두 화면이 규칙을 따로 들고 있으면 한쪽만 고쳐지는 일이 생겨서다.
 */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < 8) return '비밀번호는 8자 이상이에요';
  // 기호 = 영문·숫자·공백이 아닌 글자(서버 staff-signup.ts 와 같은 판정)
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
    return '영문·숫자·기호를 섞어 주세요';
  }
  // 대소문자만 다른 것도 같은 것으로 본다 — 로그인 아이디는 소문자라서
  if (password.toLowerCase() === username.toLowerCase()) return '아이디와 같은 비밀번호는 쓸 수 없어요';
  return null;
}
