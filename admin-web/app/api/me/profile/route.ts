// S3-1.5(취향·기준 장르 API) — `PUT /api/me/profile`(계약 01 §5, FR-022(사용자 프로필)). 관심 장르·지역·가능 시간대·경험 수준을 통째로 저장한다.
// 본문 검사(zod)와 저장은 lib/server/services/member-profile.ts 에 있고, 이 파일은 앱의 재료를 이어 줄 뿐이다.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createMemberProfileRoutes } from "@/lib/server/services/member-profile";

export const dynamic = "force-dynamic";

export const PUT = createMemberProfileRoutes(memberProfileAppDeps).putProfile;
