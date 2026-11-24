// S3-1.5(취향·기준 장르 API) — `GET /api/me`(계약 01 §4). 내 회원 정보(취향·기준 장르 포함)를 돌려준다.
// 처리 내용은 lib/server/services/member-profile.ts 에 있고, 이 파일은 앱의 재료를 이어 줄 뿐이다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMemberProfileRoutes(memberProfileAppDeps).getMe;
