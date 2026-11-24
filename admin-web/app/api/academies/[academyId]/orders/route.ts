// S3-5.1(대표 주문 목록 API) — `GET /api/academies/{academyId}/orders`(계약 18 §2-1, FR-079a(대표 주문·결제 목록)).
// 대표가 관리자 웹(W10)·대표 앱(O45)에서 자기 학원 주문을 기간·수업·상태·수단·검색어로 걸러 본다. 위임 강사는 403.
// 처리 내용은 lib/server/services/owner-orders.ts 에 있다. 재료(db·세션·시계·PG 포트)는 회원 결제 내역과 같은
// cancellationRouteDeps 를 쓴다 — 기한 지난 결제 대기를 닫을 때 같은 가짜 PG 원장을 봐야 해서다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createOwnerOrdersRoute } from "@/lib/server/services/owner-orders";

// 요청마다 다른 학원·다른 세션·다른 시각이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createOwnerOrdersRoute(cancellationRouteDeps);
