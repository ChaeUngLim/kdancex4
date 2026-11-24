// S4-1.4(대표 환불 입력) — `POST /api/academies/{academyId}/refund-requests/{requestId}/decision`(계약 12 §2-3).
// 승인(금액 0원~환불 상한) · 거절(근거 항목 필수). 서버가 결제액과 다시 비교한다. 처리 내용은 lib/server/services/refund-decisions.ts.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRefundDecisionRoute } from "@/lib/server/services/refund-decisions";

export const dynamic = "force-dynamic";

export const POST = createRefundDecisionRoute(cancellationRouteDeps);
