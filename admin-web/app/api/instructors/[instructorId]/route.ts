// SX-5.7 — `GET /api/instructors/{instructorId}`(계약 16 §4-8). 회원 앱 강사 프로필(M15)이 읽는 공개 강사 카드.
// 읽기는 lib/server/services/instructor-public-profile.ts 에 있고, 이 파일은 앱의 재료(db · 세션 · 시계)를 이어 줄 뿐이다.
import { catalogAppDeps } from "@/lib/server/member-profile-app";
import { createInstructorPublicProfileRoute } from "@/lib/server/services/instructor-public-profile";

export const dynamic = "force-dynamic";

export const GET = createInstructorPublicProfileRoute(catalogAppDeps);
