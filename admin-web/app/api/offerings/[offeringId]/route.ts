// S3-2.3(수업 상세 API) — `GET /api/offerings/{offeringId}`(계약 02 §2). 자리 묶음별 정원·신청 인원(확정만)·잔여와 기본 자리.
// 읽기·계산은 lib/server/services/offering-detail.ts 에 있고, 이 파일은 앱의 재료(db · 세션 읽기)를 이어 줄 뿐이다.
// 재료는 회원 취향 경로(S3-1.5)·홈 목록(S3-2.1)과 같아 그 재료에 읽기 전 정리용 PG 를 더한 catalogAppDeps 를 쓴다(S3-3.7).
import { catalogAppDeps } from "@/lib/server/member-profile-app";
import { createOfferingDetailRoute } from "@/lib/server/services/offering-detail";

export const dynamic = "force-dynamic";

export const GET = createOfferingDetailRoute(catalogAppDeps);
