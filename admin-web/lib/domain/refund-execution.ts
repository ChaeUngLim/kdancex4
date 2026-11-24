// S4-1.5(수단별 환불 실행) — 환불을 「어떻게」 돌려줄지 정하는 순수 규칙. DB·IO 없음.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §1-3(환불 1회 보장 — 키 규칙) · §2-3(승인 트랜잭션)
//   설계: _workspace/03_data-model.md §9-3(refunds 의 basis_kind · execution_kind · attempt_no · refund_rate_bp)
//   spec: FR-295(수단별 환불 실행) · FR-100(환불 정수 연산) · FR-102(환불 1회 보장)
//
// 왜 수단마다 길이 다른가:
//   카드·간편결제는 PG 가 원래 결제를 일부만 취소할 수 있다(부분 취소) — 그래서 서버가 포트를 불러 바로 끝낸다.
//   계좌로 들어온 돈(가상계좌·간편 계좌이체)은 PG 가 되돌릴 길이 없다 — 대표가 은행 앱에서 회원 계좌로 직접 보낸다.
//   플랫폼은 돈을 보내지 않으므로 이 경우 포트를 부르지 않고 「송금 대기」로만 남긴다(D1).
import type { PaymentMethod, RefundBasisKind, RefundExecutionKind } from "./constants";
import { ceilMulDiv } from "./money";
import { needsRefundAccount } from "./refund-request";

/** 결제수단 → 환불 실행 방식. 계좌 결제분은 대표 송금, 나머지(카드·간편결제)는 PG 부분 취소 */
export function refundExecutionKindFor(method: PaymentMethod): RefundExecutionKind {
  return needsRefundAccount(method) ? "owner_bank_transfer" : "pg_cancel";
}

/**
 * 환불 멱등 키 `refund:{원인 종류}:{원인 id}:{시도 번호}`(계약 §1-3, data-model §9-3).
 * 같은 원인·같은 시도면 늘 같은 키라, 서버가 중간에 죽은 뒤 다시 불러도 PG 는 같은 결과를 돌려준다(두 번 취소되지 않는다).
 * 실패한 뒤 다시 시도하면 시도 번호가 1 올라 새 키가 된다(FR-103 「재시도 가능한 상태로 유지」).
 */
export function refundIdempotencyKey(basisKind: RefundBasisKind, basisId: string, attemptNo: number): string {
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) throw new RangeError(`시도 번호는 1 이상의 정수여야 한다: ${attemptNo}`);
  if (basisId.trim() === "") throw new RangeError("원인 id 가 비어 있다");
  return `refund:${basisKind}:${basisId}:${attemptNo}`;
}

/** 비율 표기의 끝값 — 10000bp = 100% */
const FULL_BP = 10000;

/**
 * 기록용 환불 비율(bp, 0~10000) = 환불액 ÷ 결제액, 원 미만 올림(FR-100).
 * 이제 금액을 정하는 입력이 아니라 「결제액의 몇 %를 돌려줬나」를 남기는 파생값이다(data-model §9-3).
 * 0원 결제는 나눌 수 없으니 0 으로 둔다. 반올림 때문에 100% 를 넘지 않게 자른다.
 */
export function refundRateBpFor(refundAmount: number, paidAmount: number): number {
  if (!Number.isSafeInteger(refundAmount) || refundAmount < 0) throw new RangeError(`환불액은 0 이상의 정수여야 한다: ${refundAmount}`);
  if (!Number.isSafeInteger(paidAmount) || paidAmount < 0) throw new RangeError(`결제액은 0 이상의 정수여야 한다: ${paidAmount}`);
  if (paidAmount === 0) return 0;
  return Math.min(FULL_BP, ceilMulDiv(refundAmount, FULL_BP, paidAmount));
}
