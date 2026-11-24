// S0-5.1(취소 서비스·경로 이관) — `POST /api/orders/{id}/cancel`(계약 03 §2, FR-286(입금 전 셀프 취소)).
// 처리 내용은 lib/server/services/order-cancel.ts. 본문은 받지 않는다(경로 id 만 zod 로 검사한다).
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createCancelOrderRoute } from "@/lib/server/services/order-cancel";

export const dynamic = "force-dynamic";

export const POST = createCancelOrderRoute(cancellationRouteDeps);
