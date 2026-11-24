// S3-5.1(대표 주문 목록 API) — `GET /api/academies/{academyId}/orders/{orderId}`(계약 18 §2-2 이력 펼침).
// 주문 줄을 누르면 결제·환불 이력을 최신이 먼저 오게 보여 준다. 다른 학원 주문은 404, 위임 강사는 403.
// 처리 내용은 lib/server/services/owner-orders.ts 에 있다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createOwnerOrderDetailRoute } from "@/lib/server/services/owner-orders";

// 요청마다 다른 학원·다른 세션·다른 시각이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createOwnerOrderDetailRoute(cancellationRouteDeps);
