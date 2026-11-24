// S1-1.14(심사 시작·승인 API) — `POST /api/admin/merchant-applications/{id}/approve`(계약 07 §3, 헤더 Idempotency-Key 필수).
// 승인 한 번에 학원·첫 지점·정산 계좌·대표 연결·대표 역할이 함께 생긴다. 처리 내용은 lib/server/services/admin-merchant-review.ts 에 있고,
// 본문 검사(zod emptyBodySchema)도 그 파일에서 한다.
import { merchantApplicationAppDeps } from "@/lib/server/merchant-application-app";
import { createApproveRoute } from "@/lib/server/services/admin-merchant-review";

// 요청마다 다른 신청이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createApproveRoute(merchantApplicationAppDeps());
