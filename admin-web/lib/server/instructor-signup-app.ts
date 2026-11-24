// S2-1.2(강사 가입 API) — 앱 실행 때 강사 가입 경로 셋에 넘길 deps 를 한 곳에서 만든다(route.ts 셋이 같이 쓴다).
// 재료(db · 본인확인 포트 · 시계 · 요청 제한)는 대표 가입과 똑같다 — 그래서 같은 공장 함수를 그대로 쓴다.
// 본인확인 포트를 「부를 때 꺼내는」 이유는 owner-signup-app.ts 머리 주석을 본다(import 만으로 비밀값을 읽지 않게).
import { ownerSignupAppDeps } from "./owner-signup-app";
import type { InstructorSignupDeps } from "./services/instructor-signup";

export function instructorSignupAppDeps(): InstructorSignupDeps {
  return ownerSignupAppDeps();
}
