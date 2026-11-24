// S4-1.2(환불 요청 생성·철회) — `POST /api/refund-requests`(계약 12 §2-1). 회원이 환불을 요청한다.
// 처리 내용은 lib/server/services/refund-requests.ts 에 있다. 본문은 그 파일이 쓰는 createRefundRequestSchema(zod)로 검사한다.
// 재료(db · 세션 읽기 · 시계)는 취소 경로의 묶음(cancellation-route-deps)을 그대로 쓴다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRefundRequestRoute } from "@/lib/server/services/refund-requests";

// 회원마다 다른 응답이고 매번 DB 에 쓴다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createRefundRequestRoute(cancellationRouteDeps);
