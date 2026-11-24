// S4-1.5(수단별 환불 실행) — 대표가 승인한 환불 요청을 실제 돈의 움직임으로 바꾼다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §1-3(환불 1회 보장 — 트랜잭션 밖 PG 호출) · §2-3(승인 트랜잭션)
//   설계: _workspace/03_data-model.md §9-2(orders.refunded_total_amount · ck_orders_refunded_cap) · §9-3(refunds 원인·실행 칸)
//   spec: FR-295(수단별 환불 실행) · FR-102(환불 1회 보장) · FR-103(환불 실패 기록) · SC-010(환불 초과 0건)
//
// 돈이 한 번만 나가게 하는 순서(계약 §1-3):
//   ① [승인 트랜잭션 안] 주문 환불 합계를 조건부로 올리고(넘치면 0행 → 409, 승인까지 통째로 롤백)
//      환불 행을 pending 으로 넣는다 → 커밋. 이 함수가 startRequestRefund 다.
//   ② [커밋 뒤] 카드·간편결제면 포트 refund(부분 취소)를 부른다. 키는 환불 행의 멱등 키 — 같은 키면 PG 가 같은 결과를 준다.
//   ③ [새 트랜잭션] pending → succeeded|failed 조건부 갱신. 성공이면 요청 completed, 실패면 올렸던 합계를 되돌린다.
//   ②에서 서버가 죽어도 pending 행이 남는다. 대표가 같은 승인을 다시 보내면(재생) ②③을 같은 키로 다시 돌려 수렴한다.
//
// 계좌 결제분(가상계좌·간편 계좌이체)은 ①에서 멈춘다 — 플랫폼은 돈을 보내지 않고, 대표가 송금한 뒤
// 「송금 완료」(S4-1.5a)를 누를 때까지 pending(송금 대기)이다(D1). 그래서 포트를 부르지 않는다.
//
// 이 Task 가 일부러 하지 않은 것(EVIDENCE.md 「추천안·사후 확인」): 주문 상태(partially_refunded·refunded) 전이 · 결과 알림 ·
// 환불 감사 행 · 실패 뒤 새 시도 행 — S4-1.7(주문 상태 전이·감사·실패 기록·결과 알림). 정규 예약 취소·자리 반납도 S4-1.7 과 함께 간다.
import type { PaymentMethod, RefundExecutionKind, RefundStatus } from "../../domain/constants";
import { refundExecutionKindFor, refundIdempotencyKey, refundRateBpFor } from "../../domain/refund-execution";
import { refundAnswerDueAt } from "../../domain/refund-request";
import type { ServerDeps } from "../deps";
import type { GuardDeps } from "../guards";
import { HttpError } from "../http";
import { PaymentGatewayError, type RefundResult } from "../ports/payment-gateway";
import { loadHolidayCalendar } from "./admin-holidays";
import type { Runner } from "./cancellation-queries";

export type RefundExecutionDeps = Pick<GuardDeps, "db"> & Pick<ServerDeps, "clock" | "paymentGateway">;

/** refund_events.event_type — 추가 전용 기록(DB 에 CHECK 가 없는 앱 상수, data-model §9-6) */
export const REFUND_EXECUTION_EVENTS = {
  requested: "refund_requested",
  gatewaySucceeded: "gateway_succeeded",
  gatewayFailed: "gateway_failed",
} as const;

/** 정규 공지에 처리 기간이 없을 때 계좌분 송금 기한 — 승인 + 5영업일(D6) */
export const DEFAULT_TRANSFER_BUSINESS_DAYS = 5;

/** PG 가 이유를 붙이지 않고 거절했을 때 남기는 실패 코드 */
const GATEWAY_ERROR_CODE = "PG_GATEWAY_ERROR";
/** 포트원 `reason`(필수) — 회원이 요청하고 대표가 승인한 환불 */
const REQUEST_REFUND_REASON = "회원 환불 요청 — 학원 승인";

/** 응답·재실행에 필요한 환불 행 칸 */
export interface RequestRefundRow {
  refundId: string;
  orderId: string;
  requestId: string;
  executionKind: RefundExecutionKind;
  status: RefundStatus;
  requestedAmount: number;
  refundedAmount: number;
  idempotencyKey: string;
  paymentKey: string;
  paymentMethod: PaymentMethod;
}

const REFUND_ROW_SHAPE = {
  id: "pg/uuid@1",
  order_id: "pg/uuid@1",
  refund_request_id: "pg/uuid@1",
  execution_kind: "pg/text@1",
  status: "pg/text@1",
  requested_amount: "pg/int4@1",
  refunded_amount: "pg/int4@1",
  idempotency_key: "pg/text@1",
  payment_key: "pg/text@1",
  method: "pg/text@1",
} as const;

type RefundRowRaw = {
  id: string;
  order_id: string;
  refund_request_id: string;
  execution_kind: string;
  status: string;
  requested_amount: number;
  refunded_amount: number;
  idempotency_key: string;
  payment_key: string;
  method: string;
};

function toRow(row: RefundRowRaw): RequestRefundRow {
  return {
    refundId: row.id,
    orderId: row.order_id,
    requestId: row.refund_request_id,
    executionKind: row.execution_kind as RefundExecutionKind,
    status: row.status as RefundStatus,
    requestedAmount: row.requested_amount,
    refundedAmount: row.refunded_amount,
    idempotencyKey: row.idempotency_key,
    paymentKey: row.payment_key,
    paymentMethod: row.method as PaymentMethod,
  };
}

/** 이 요청이 원인인 환불 중 가장 최근 시도 하나(없으면 null). 재생·응답이 이것을 본다 */
export async function readLatestRequestRefund(runner: Runner, requestId: string): Promise<RequestRefundRow | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT rf.id, rf.order_id, rf.refund_request_id, rf.execution_kind, rf.status, rf.requested_amount, rf.refunded_amount,
                          rf.idempotency_key, COALESCE(p.gateway_payment_key, p.gateway_payment_id) AS payment_key, p.method
                     FROM refunds rf JOIN payments p ON p.id = rf.payment_id
                    WHERE rf.basis_kind = 'request' AND rf.basis_id = ${requestId}::uuid
                    ORDER BY rf.attempt_no DESC
                    LIMIT 1`
      .returnsRow(REFUND_ROW_SHAPE)
      .build(),
  );
  return row === undefined ? null : toRow(row);
}

async function recordEvent(runner: Runner, refundId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await runner.execute(
    runner.raw.sql`INSERT INTO refund_events (id, refund_id, event_type, payload)
                   VALUES (uuidv7(), ${refundId}::uuid, ${eventType}, ${JSON.stringify(payload)}::jsonb)`
      .affectedCount()
      .build(),
  );
}

export interface StartRequestRefundInput {
  requestId: string;
  /** 대표가 정한 환불액(원, 0 이상 정수 — 상한은 decide 가 이미 확인했다) */
  amount: number;
  staffAccountId: string;
  /** 공지 판본의 처리 기간(영업일). 없으면 DEFAULT_TRANSFER_BUSINESS_DAYS */
  processingBusinessDays: number | null;
  now: Temporal.Instant;
}

/**
 * ① 승인 트랜잭션 안에서 부른다(요청 행·주문 행은 이미 잠겨 있다). 환불 행 하나를 pending 으로 만든다.
 * 0원 승인은 돌려줄 돈이 없어 환불 행을 만들지 않고 요청을 바로 completed 로 닫는다(null 을 돌려준다).
 * 주문 환불 합계가 상한을 넘으면 409 REFUND_EXCEEDS_PAID — 던지면 승인 기록까지 함께 롤백된다.
 */
export async function startRequestRefund(tx: Runner, input: StartRequestRefundInput): Promise<RequestRefundRow | null> {
  const { requestId, amount, now } = input;
  if (amount === 0) {
    await tx.execute(
      tx.raw.sql`UPDATE refund_requests SET status = 'completed', completed_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                  WHERE id = ${requestId}::uuid AND status = 'in_progress'`
        .affectedCount()
        .build(),
    );
    return null;
  }

  // 요청·주문·결제 원거래를 한 번에 읽는다. 결제 원거래는 「paid」 한 건 — 그 수단이 실행 방식을 정한다
  const [facts] = await tx.query(
    tx.raw.sql`SELECT rr.order_id, rr.reservation_id, COALESCE(rr.refund_account_id::text, '') AS refund_account_id,
                      o.total_amount, p.id AS payment_id, p.method,
                      (SELECT COALESCE(max(rf.attempt_no), 0)::int FROM refunds rf
                        WHERE rf.basis_kind = 'request' AND rf.basis_id = rr.id) AS last_attempt
                 FROM refund_requests rr
                 JOIN orders o ON o.id = rr.order_id
                 JOIN LATERAL (SELECT id, method FROM payments WHERE order_id = o.id AND status = 'paid'
                                ORDER BY paid_at DESC NULLS LAST LIMIT 1) p ON true
                WHERE rr.id = ${requestId}::uuid`
      .returnsRow({
        order_id: "pg/uuid@1",
        reservation_id: "pg/uuid@1",
        refund_account_id: "pg/text@1",
        total_amount: "pg/int4@1",
        payment_id: "pg/uuid@1",
        method: "pg/text@1",
        last_attempt: "pg/int4@1",
      })
      .build(),
  );
  if (facts === undefined) throw HttpError.conflict("REFUND_NOT_ALLOWED_STATE", "결제가 끝난 주문만 환불할 수 있어요");

  const method = facts.method as PaymentMethod;
  const executionKind = refundExecutionKindFor(method);
  const attemptNo = facts.last_attempt + 1;
  const key = refundIdempotencyKey("request", requestId, attemptNo);

  // 합계 상한(SC-010) — 한 문장 조건부 증가. 0행이면 결제액 − 예매 수수료를 넘는다는 뜻이다(D15)
  const raised = await tx.execute(
    tx.raw.sql`UPDATE orders SET refunded_total_amount = refunded_total_amount + ${amount}, updated_at = ${now.toString()}::timestamptz
                WHERE id = ${facts.order_id}::uuid AND status IN ('paid', 'partially_refunded')
                  AND refunded_total_amount + ${amount} <= total_amount - booking_fee_amount + booking_fee_refunded_amount`
      .affectedCount()
      .build(),
  );
  if (raised.affectedRows !== 1) throw HttpError.conflict("REFUND_EXCEEDS_PAID", "결제 금액보다 많이 돌려줄 수 없어요");

  // 계좌분은 송금 기한을 정한다 — 승인 시각 + 공지의 처리 기간(영업일, 토·일·공휴일 제외)
  const transferDueAt =
    executionKind === "owner_bank_transfer"
      ? refundAnswerDueAt(now, await loadHolidayCalendar(tx), input.processingBusinessDays ?? DEFAULT_TRANSFER_BUSINESS_DAYS).toString()
      : "";

  // ON CONFLICT DO NOTHING — 같은 키·같은 원인의 살아 있는 환불이 이미 있으면 0행(요청 행 잠금 뒤라 평소엔 일어나지 않는 마지막 방어선)
  const inserted = await tx.query(
    tx.raw.sql`INSERT INTO refunds (id, reservation_id, payment_id, order_id, refund_request_id, idempotency_key, requested_amount, refunded_amount,
                                    refund_rate_bp, status, reason, basis_kind, basis_id, execution_kind, executed_by,
                                    executed_by_staff_account_id, refund_account_id, attempt_no, transfer_due_at, updated_at)
               VALUES (uuidv7(), ${facts.reservation_id}::uuid, ${facts.payment_id}::uuid, ${facts.order_id}::uuid, ${requestId}::uuid, ${key},
                       ${amount}, 0, ${refundRateBpFor(amount, facts.total_amount)}, 'pending', 'member_request', 'request', ${requestId}::uuid,
                       ${executionKind}, 'owner', ${input.staffAccountId}::uuid,
                       NULLIF(${executionKind === "owner_bank_transfer" ? facts.refund_account_id : ""}, '')::uuid,
                       ${attemptNo}, NULLIF(${transferDueAt}, '')::timestamptz, ${now.toString()}::timestamptz)
               ON CONFLICT DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  const [row] = inserted;
  if (row === undefined) throw HttpError.conflict("REFUND_ALREADY_DECIDED", "이미 실행 중인 환불이 있어요");

  await recordEvent(tx, row.id, REFUND_EXECUTION_EVENTS.requested, {
    refund_request_id: requestId,
    execution_kind: executionKind,
    method,
    amount,
    attempt_no: attemptNo,
    idempotency_key: key,
    ...(transferDueAt === "" ? {} : { transfer_due_at: transferDueAt }),
  });
  const created = await readLatestRequestRefund(tx, requestId);
  if (created === null) throw new Error(`방금 만든 환불 행을 읽지 못했다: ${row.id}`);
  return created;
}

/** 포트 호출 결과 → 갱신할 값. 예외도 결과로 바꾼다(실패 사유를 행에 남기려는 것) */
type GatewayOutcome = { kind: "settled"; result: RefundResult } | { kind: "unknown" };

async function callGateway(deps: RefundExecutionDeps, refund: RequestRefundRow): Promise<GatewayOutcome> {
  try {
    const result = await deps.paymentGateway.refund({
      paymentKey: refund.paymentKey,
      method: refund.paymentMethod,
      amount: refund.requestedAmount,
      idempotencyKey: refund.idempotencyKey,
      reason: REQUEST_REFUND_REASON,
    });
    return { kind: "settled", result };
  } catch (error: unknown) {
    // PG 가 「이건 안 된다」고 분명히 말한 경우(모르는 결제·수단)는 실패로 남긴다
    if (error instanceof PaymentGatewayError) {
      return { kind: "settled", result: { status: "failed", failureCode: error.name, failureMessage: error.message, rawResponse: {} } };
    }
    // 네트워크 끊김처럼 결과를 모르는 경우는 pending 그대로 둔다 — 같은 키로 다시 부르면 수렴한다(계약 §1-3)
    console.warn("[refund-execution] PG 부분 취소 결과를 받지 못해 pending 으로 둔다", refund.refundId, error);
    return { kind: "unknown" };
  }
}

/**
 * ②③ 커밋 뒤에 카드·간편결제 환불을 PG 부분 취소로 실행한다. pending 이 아닌 행·계좌분은 아무것도 하지 않고 그대로 돌려준다.
 * 두 요청이 동시에 와도 pending → 결과 갱신이 조건부라 한 번만 반영된다(늦은 쪽은 0행 → 지금 행을 다시 읽는다).
 */
export async function executePgCancel(deps: RefundExecutionDeps, refund: RequestRefundRow): Promise<RequestRefundRow> {
  if (refund.executionKind !== "pg_cancel" || refund.status !== "pending") return refund;
  const outcome = await callGateway(deps, refund);
  if (outcome.kind === "unknown") return refund;
  const { result } = outcome;
  // PG 가 아직 처리 중(REQUESTED)이라고 하면 pending 그대로 — 카드 부분 취소는 보통 바로 끝난다
  if (result.status === "pending") return refund;

  const now = deps.clock();
  const succeeded = result.status === "succeeded";
  return deps.db.transaction(async (tx) => {
    const changed = await tx.execute(
      tx.raw.sql`UPDATE refunds
                    SET status = ${result.status}, refunded_amount = ${succeeded ? refund.requestedAmount : 0},
                        gateway_refund_id = NULLIF(${result.gatewayRefundId ?? ""}, ''),
                        failure_code = NULLIF(${succeeded ? "" : (result.failureCode ?? GATEWAY_ERROR_CODE)}, ''),
                        failure_message = NULLIF(${succeeded ? "" : (result.failureMessage ?? "").slice(0, 500)}, ''),
                        updated_at = ${now.toString()}::timestamptz
                  WHERE id = ${refund.refundId}::uuid AND status = 'pending'`
        .affectedCount()
        .build(),
    );
    if (changed.affectedRows === 1) {
      if (succeeded) {
        // 돈이 돌아갔다 — 요청을 끝낸다(계좌분은 송금 완료 때 끝난다, S4-1.5a)
        await tx.execute(
          tx.raw.sql`UPDATE refund_requests SET status = 'completed', completed_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                      WHERE id = ${refund.requestId}::uuid AND status = 'in_progress'`
            .affectedCount()
            .build(),
        );
      } else {
        // 실패 — ①에서 올린 합계를 되돌린다. 요청은 처리 중으로 남아 다시 시도할 수 있다(FR-103)
        await tx.execute(
          tx.raw.sql`UPDATE orders SET refunded_total_amount = refunded_total_amount - ${refund.requestedAmount}, updated_at = ${now.toString()}::timestamptz
                      WHERE id = ${refund.orderId}::uuid AND refunded_total_amount >= ${refund.requestedAmount}`
            .affectedCount()
            .build(),
        );
      }
      await recordEvent(tx, refund.refundId, succeeded ? REFUND_EXECUTION_EVENTS.gatewaySucceeded : REFUND_EXECUTION_EVENTS.gatewayFailed, {
        gateway_refund_id: result.gatewayRefundId ?? null,
        failure_code: succeeded ? null : (result.failureCode ?? GATEWAY_ERROR_CODE),
        raw_response: result.rawResponse,
      });
    }
    const latest = await readLatestRequestRefund(tx, refund.requestId);
    if (latest === null) throw new Error(`환불 행을 다시 읽지 못했다: ${refund.refundId}`);
    return latest;
  });
}
