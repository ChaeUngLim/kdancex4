// S4-1.5a(계좌 환불 송금 완료·반송 처리 API) — `POST /api/academies/{academyId}/refund-transfers/{refundId}/request-reinput`(계약 12 §2-5).
// 받는 사람 이름이 예금주와 다르거나(name_mismatch) 송금이 반송되면(returned) 이 시도를 닫고 회원에게 계좌를 다시 받는다.
// 처리 내용은 lib/server/services/refund-transfers.ts.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRefundTransferReinputRoute } from "@/lib/server/services/refund-transfers";

export const dynamic = "force-dynamic";

export const POST = createRefundTransferReinputRoute(cancellationRouteDeps);
