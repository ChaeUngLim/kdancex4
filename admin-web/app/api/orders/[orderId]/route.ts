// S3-3.15b(결제 화면용 서버 조각) — `GET /api/orders/{orderId}`(계약 03 §2 조회). 본인 주문만, 응답은 결제 시작과 같은 모양.
// 처리 내용은 lib/server/services/order-detail.ts. 재료(db · 세션 읽기 · 시계 · PG 포트)는 결제 시작·셀프 취소와 같은
// cancellationRouteDeps 를 쓴다 — 같은 가짜 PG 원장을 봐야 결제창 키가 결제 시작 때와 같게 나온다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createOrderDetailRoute } from "@/lib/server/services/order-detail";

export const dynamic = "force-dynamic";

export const GET = createOrderDetailRoute(cancellationRouteDeps);
