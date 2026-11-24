// S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — `POST /api/academies/{academyId}/refund-transfers/{refundId}/complete`(계약 12 §2-5).
// 대표가 은행에서 회원 계좌로 보낸 뒤, 이체 화면의 받는 사람 이름을 대조했다는 체크(nameChecked)와 함께 누른다.
// 포트(PG)는 부르지 않는다 — 돈은 대표가 이미 보냈다. 처리 내용은 lib/server/services/refund-transfers.ts.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRefundTransferCompleteRoute } from "@/lib/server/services/refund-transfers";

export const dynamic = "force-dynamic";

export const POST = createRefundTransferCompleteRoute(cancellationRouteDeps);
