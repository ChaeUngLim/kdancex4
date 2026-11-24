// S3-1.2(가짜 본인확인·가입 API) — 앱 실행 때 `POST /api/members` 에 넘길 deps 를 만든다.
// 재료(db · 본인확인 포트 · 시계 · 요청 제한)는 대표 가입과 같고, 회원 가입은 로그인 세션이 필요하니 세션 읽기를 더한다.
// 본인확인 포트를 「부를 때 꺼내는」 이유는 owner-signup-app.ts 머리 주석과 같다(import 만으로 비밀값을 읽지 않게).
import { ownerSignupAppDeps } from "./owner-signup-app";
import type { MemberSignupDeps } from "./services/member-signup";
import { readStaffSession } from "./staff-auth-instance";

export function memberSignupAppDeps(): MemberSignupDeps {
  // 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(계약 README §2)
  return { ...ownerSignupAppDeps(), getSession: readStaffSession };
}
