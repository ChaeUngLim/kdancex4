// S4-1.2(환불 요청 생성·철회) — `POST /api/refund-requests/{requestId}/withdraw`(계약 12 §2-1). 대표 결정 전 철회.
// 처리 내용은 lib/server/services/refund-requests.ts 에 있다. 본문은 받지 않는다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createWithdrawRefundRequestRoute } from "@/lib/server/services/refund-requests";

export const dynamic = "force-dynamic";

export const POST = createWithdrawRefundRequestRoute(cancellationRouteDeps);
