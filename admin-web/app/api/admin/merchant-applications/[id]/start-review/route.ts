// S1-1.14(심사 시작·승인 API) — `POST /api/admin/merchant-applications/{id}/start-review`(계약 07 §3).
// 운영자가 제출된 신청의 심사를 시작한다(submitted → in_review). 처리 내용은 lib/server/services/admin-merchant-review.ts 에 있다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createStartReviewRoute } from "@/lib/server/services/admin-merchant-review";

// 요청마다 다른 신청이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createStartReviewRoute(merchantApplicationAppDeps());
