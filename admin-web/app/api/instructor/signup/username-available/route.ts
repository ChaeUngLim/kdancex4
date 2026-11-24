// S2-1.2(강사 가입 API) — `GET /api/instructor/signup/username-available`(계약 11 §1-2, 보드 I31). ② 아이디 중복 확인.
// 처리 내용은 lib/server/services/instructor-signup.ts 에 있고, 이 파일은 앱의 db·본인확인·요청 제한을 이어 줄 뿐이다.
import { instructorSignupAppDeps } from "@/lib/server/instructor-signup-app";
import { createInstructorSignupRoutes } from "@/lib/server/services/instructor-signup";

// 사람마다 다른 응답이고 DB 를 매번 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createInstructorSignupRoutes(instructorSignupAppDeps()).usernameAvailable;
