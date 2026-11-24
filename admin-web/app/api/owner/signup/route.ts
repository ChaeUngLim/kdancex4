// S1-1.8(대표 가입 API) — `POST /api/owner/signup`(계약 07 §0). ③ 대표 직원 계정 만들기(owner 역할은 붙이지 않는다).
// 처리 내용은 lib/server/services/owner-signup.ts 에 있고, 이 파일은 앱의 db·본인확인·요청 제한을 이어 줄 뿐이다.
import { ownerSignupAppDeps } from "@/lib/server/owner-signup-app";
import { createOwnerSignupRoutes } from "@/lib/server/services/owner-signup";

// 사람마다 다른 응답이고 DB 를 매번 읽어야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createOwnerSignupRoutes(ownerSignupAppDeps()).signup;
