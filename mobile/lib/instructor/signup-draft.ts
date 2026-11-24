/**
 * 강사 가입 두 화면(I31C 본인확인 → I31 아이디 만들기) 사이에서 넘기는 값 — S2-1.7.
 *
 * 본인확인 토큰은 비밀번호와 같은 무게라 화면 주소(딥링크·기록에 남는다)에 싣지 않는다.
 * 회원 가입(`lib/onboarding/flow.ts`)과 같은 방식으로 앱 메모리에만 둔다. 앱을 끄면 사라지고,
 * 토큰은 10분 뒤 서버에서도 만료된다(계약 01 §2) — 그때는 본인확인부터 다시 한다.
 */
export interface InstructorSignupDraft {
  verificationToken: string;
  nameMasked: string;
  phoneMasked: string;
}

let draft: InstructorSignupDraft | null = null;

export function setInstructorSignupDraft(next: InstructorSignupDraft): void {
  draft = next;
}

export function getInstructorSignupDraft(): InstructorSignupDraft | null {
  return draft;
}

/** 가입을 마치면 지운다 — 같은 토큰으로 두 번 보내지 않게 */
export function clearInstructorSignupDraft(): void {
  draft = null;
}
