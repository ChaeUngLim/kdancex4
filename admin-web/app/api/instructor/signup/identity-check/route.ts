// S2-1.2(강사 가입 API) — `POST /api/instructor/signup/identity-check`(계약 11 §1-1, 보드 I31C). ① 본인확인 결과로 가입 자격 먼저 보기.
// 처리 내용은 lib/server/services/instructor-signup.ts 에 있고, 이 파일은 앱의 db·본인확인·요청 제한을 이어 줄 뿐이다.
import { instructorSignupAppDeps } from "@/lib/server/instructor-signup-app";
import { createInstructorSignupRoutes } from "@/lib/server/services/instructor-signup";

// 사람마다 다른 응답이고 DB 를 매번 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createInstructorSignupRoutes(instructorSignupAppDeps()).identityCheck;
