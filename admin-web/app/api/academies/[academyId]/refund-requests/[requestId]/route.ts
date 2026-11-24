// S4-1.4(대표 환불 입력) — `GET /api/academies/{academyId}/refund-requests/{requestId}`(계약 12 §2-2). 대표만, 웹·앱 공통.
// 결제·계산 보조·미리 채운 금액·근거 공지 항목·환불 상한을 돌려준다. 처리 내용은 lib/server/services/refund-decisions.ts.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRefundRequestDetailRoute } from "@/lib/server/services/refund-decisions";

export const dynamic = "force-dynamic";

export const GET = createRefundRequestDetailRoute(cancellationRouteDeps);
