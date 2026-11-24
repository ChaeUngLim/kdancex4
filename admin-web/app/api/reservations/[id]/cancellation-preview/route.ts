// S0-5.1(취소 서비스·경로 이관) — `GET /api/reservations/{id}/cancellation-preview`(계약 05, 예상 환불액 사전 고지).
// 처리 내용은 lib/server/services/cancellation-preview.ts. 아무것도 쓰지 않는다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createCancellationPreviewRoute } from "@/lib/server/services/cancellation-preview";

export const dynamic = "force-dynamic";

export const GET = createCancellationPreviewRoute(cancellationRouteDeps);
