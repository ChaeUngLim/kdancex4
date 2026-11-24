// S0-5.1(취소 서비스·경로 이관) — `POST /api/reservations/{id}/cancel`(계약 05). 옛 FastAPI `POST /reservations/{id}/cancel` 의 이관.
// 처리 내용은 lib/server/services/cancellation.ts 에 있고, 이 파일은 앱의 db·세션·포트를 이어 줄 뿐이다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createCancelReservationRoute } from "@/lib/server/services/cancellation";

// 회원마다 다른 응답이고 매번 DB 를 써야 한다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createCancelReservationRoute(cancellationRouteDeps);
