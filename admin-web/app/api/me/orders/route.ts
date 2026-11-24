// S3-4.6(결제 내역·주문 상태 표시 API) — `GET /api/me/orders?status=&limit=20&cursor=`(계약 04 §9).
// 내 주문을 최신순으로 한 쪽씩, 주문 상태 6종 이름 그대로 돌려준다. 처리 내용은 lib/server/services/me-orders.ts.
// 재료(db · 세션 읽기 · 시계 · PG 포트)는 단건 조회 GET /api/orders/{orderId} 와 같은 cancellationRouteDeps 를 쓴다 —
// 기한 지난 결제 대기를 닫을 때 같은 가짜 PG 원장을 봐야 해서다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createMeOrdersRoute } from "@/lib/server/services/me-orders";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMeOrdersRoute(cancellationRouteDeps);
