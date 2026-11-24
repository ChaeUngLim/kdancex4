// S3-1.5(취향·기준 장르 API) — `PUT /api/me/base-genre`(계약 01 §6, FR-022a(첫 화면 장르 선택·유지)). 기준 장르 1개를 정하거나 바꾼다.
// 본문 검사(zod)와 저장은 lib/server/services/member-profile.ts 에 있고, 이 파일은 앱의 재료를 이어 줄 뿐이다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";

export const dynamic = "force-dynamic";

export const PUT = createMemberProfileRoutes(memberProfileAppDeps).putBaseGenre;
