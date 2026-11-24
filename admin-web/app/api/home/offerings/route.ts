// S3-2.1(홈 목록 API) — `GET /api/home/offerings`(계약 02 §1). 기준 장르·관심 지역·가능 시간대로 거른 게시 수업 목록.
// 거르기·읽기는 lib/server/services/home-offerings.ts 에 있고, 이 파일은 앱의 재료(db · 세션 읽기 · 시계)를 이어 줄 뿐이다.
// 재료는 회원 취향 경로(S3-1.5)와 같아 그 재료에 읽기 전 정리용 PG 를 더한 catalogAppDeps 를 쓴다(S3-3.7).
import { catalogAppDeps } from "@/lib/server/member-profile-app";
import { createHomeOfferingsRoute } from "@/lib/server/services/home-offerings";

export const dynamic = "force-dynamic";

export const GET = createHomeOfferingsRoute(catalogAppDeps);
