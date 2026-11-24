// S3-1.2(가짜 본인확인·가입 API) — `POST /api/members`(계약 01 §3). 본인확인 값으로 회원 가입을 끝낸다.
// 처리 내용은 lib/server/services/member-signup.ts 에 있고, 이 파일은 앱의 db·세션·본인확인·요청 제한을 이어 줄 뿐이다.
import { memberSignupAppDeps } from "@/lib/server/member-signup-app";
import { createMemberSignupRoutes } from "@/lib/server/services/member-signup";

// 사람마다 다른 응답이고 DB 를 매번 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createMemberSignupRoutes(memberSignupAppDeps()).signup;
