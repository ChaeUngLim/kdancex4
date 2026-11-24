// S2-1.8(강사 계정 찾기·비밀번호 재설정 API) — `POST /api/instructor/account-recovery/lookup`(계약 11 §1-4, 보드 I31B).
// 본인확인한 사람(CI)의 강사 계정 하나를 찾는다. 처리 내용은 lib/server/services/instructor-account-recovery.ts 에 있다.
import { instructorSignupAppDeps } from "@/lib/server/instructor-signup-app";
import { createInstructorAccountRecoveryRoutes } from "@/lib/server/services/instructor-account-recovery";

// 사람마다 다른 응답이고 DB 를 매번 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createInstructorAccountRecoveryRoutes(instructorSignupAppDeps()).lookup;
