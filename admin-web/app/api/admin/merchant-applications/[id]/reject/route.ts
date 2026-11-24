// S1-1.15(심사 반려 API) — `POST /api/admin/merchant-applications/{id}/reject`(계약 07 §3).
// 운영자가 심사 중인 신청을 정해진 사유 4종(FR-250) 중 하나와 설명 글로 반려한다. 처리 내용은 lib/server/services/admin-merchant-review.ts 에 있고,
// 본문 검사(zod rejectRequestSchema)도 그 파일에서 한다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createRejectRoute } from "@/lib/server/services/admin-merchant-review";

// 요청마다 다른 신청이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createRejectRoute(merchantApplicationAppDeps());
