// S3-3.8(결제 실패 시 자리 해제) — 카드 승인이 실패하면 잡아 둔 자리를 바로 풀고 주문을 닫는다.
//   계약: _workspace/03_contracts/03-checkout-payment.md §8 M-03(카드 승인 실패) · §6(웹훅 4번 PG 재조회)
//   데이터: data-model §6-3 M-03 — 주문은 새 상태 없이 `cancelled`, order_events.reason = `결제 실패`,
//           reservations.cancel_reason = `payment_failed`, payment_webhook_events.result = `payment_failed`
//   요구: FR-096(결제 대기 자리 잠금) · FR-298(주문 상태 6종 — 늘리지 않는다) · 플랜 S3-3 수용 ④
//
// 한 줄로: 회원이 카드 결제창에서 승인에 실패하면(한도 초과·잘못된 카드 등), 그 사람이 잡아 둔 자리(held)를 기한(15분)까지
//          묶어 두지 않고 그 자리에서 다른 사람에게 돌려준다. 돈은 빠져나가지 않았으니 환불 행도 만들지 않는다.
//
// 누가 부르나: 웹훅 처리기(S3-3.9(웹훅 확정 일괄 처리))가 `type = Transaction.Failed` 통지를 받았을 때.
//   서명 검증·webhook-id 중복 막기는 웹훅 처리기 몫이고, 이 함수는 「PG 재조회 → 상태 전이」만 한다.
//
// 순서:
//   1. PG 에 결제 상태를 다시 묻는다(통지 본문을 믿지 않는다 — §6 4번과 같은 규칙). PG 가 `failed` 라고 하지 않으면 손대지 않는다
//   2. 한 트랜잭션: 주문 `pending → cancelled` 조건부 UPDATE(이 결제가 아직 ready 일 때만). 0행이면 `ignored`
//      — 그사이 입금 확정(paid)·만료(expired)·셀프 취소(cancelled)로 이미 끝났다. 이 한 문장이 동시 실행의 방어선이다
//   3. 같은 트랜잭션에서 결제 `cancelled` · 예약 `cancelled`(사유 payment_failed) · 자리 묶음 held −1 · order_events 1행
//   PG 에 계좌 폐기(cancelPayment)를 부르지 않는다 — PG 가 이미 실패로 닫은 결제다.
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import { PaymentNotFoundError, type PaymentGatewayPort } from "../ports/payment-gateway";

export interface PaymentFailureDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly paymentGateway: PaymentGatewayPort;
}

/** 앱 화면에 그대로 보일 문구 — 계약 03 §8 「결제가 되지 않았고 돈이 청구되지 않았다」 */
export const PAYMENT_FAILED_NOTICE = "결제가 되지 않았고 돈이 청구되지 않았어요";

/**
 * 실패 통지 처리 결과. 웹훅 처리기가 `result` 를 payment_webhook_events 에 적고, 본문을 그대로 200 으로 돌려준다.
 * - `payment_failed`: 이번 통지로 주문을 닫았다. `charged: false` 가 「청구되지 않았다」 값이다
 * - `ignored`: 바꾼 것이 없다(모르는 결제·PG 가 실패라고 하지 않음·이미 끝난 주문)
 */
export type PaymentFailureResult =
  | {
      readonly result: "payment_failed";
      readonly orderId: string;
      readonly orderStatus: "cancelled";
      /** 회원 카드에서 돈이 빠져나갔는가 — 승인 실패라 늘 false */
      readonly charged: false;
      readonly notice: typeof PAYMENT_FAILED_NOTICE;
    }
  | { readonly result: "ignored"; readonly orderId: string | null; readonly orderStatus: string | null };

/** order_events.reason — data-model §6-3 M-03 이 정한 글자 */
const ORDER_EVENT_REASON = "결제 실패";
/** reservations.cancel_reason — 같은 곳 */
const RESERVATION_CANCEL_REASON = "payment_failed";

/** 카드 승인 실패 통지 한 건을 처리한다. 두 번 불러도 결과가 같다(두 번째는 `ignored`) */
export async function releaseSeatOnPaymentFailure(
  deps: PaymentFailureDeps,
  input: { gatewayPaymentId: string },
): Promise<PaymentFailureResult> {
  const { db } = deps;
  const { gatewayPaymentId } = input;

  // 우리 DB 에 없는 결제 번호면 아무것도 하지 않는다(다른 환경의 통지·잘못된 통지)
  const [known] = await db.query(
    db.raw.sql`SELECT p.order_id, o.status AS order_status
               FROM payments p JOIN orders o ON o.id = p.order_id
               WHERE p.gateway_payment_id = ${gatewayPaymentId}`
      .returnsRow({ order_id: "pg/uuid@1", order_status: "pg/text@1" })
      .build(),
  );
  if (known === undefined) return { result: "ignored", orderId: null, orderStatus: null };

  // 1. PG 재조회 — 통지가 「실패」라고 해도 PG 가 같은 말을 할 때만 닫는다(위조·순서 뒤바뀐 통지 방어)
  const reported = await deps.paymentGateway.getPayment(gatewayPaymentId).catch((error: unknown) => {
    if (error instanceof PaymentNotFoundError) return null;
    throw error; // PG 장애는 500 으로 올려 PG 가 다시 보내게 한다(§6 「롤백하고 500」과 같은 규칙)
  });
  if (reported === null || reported.status !== "failed") {
    return { result: "ignored", orderId: known.order_id, orderStatus: known.order_status };
  }

  const at = deps.clock().toString();
  const closed = await db.transaction((tx) =>
    closeOrderOnPaymentFailure(tx, { orderId: known.order_id, gatewayPaymentId, at }),
  );

  if (!closed) {
    // 이미 끝난 주문 — 지금 상태만 알려 준다(계약 §8 「이미 끝난 주문이면 ignored」)
    const [current] = await db.query(
      db.raw.sql`SELECT status FROM orders WHERE id = ${known.order_id}::uuid`.returnsRow({ status: "pg/text@1" }).build(),
    );
    return { result: "ignored", orderId: known.order_id, orderStatus: current?.status ?? known.order_status };
  }
  return { result: "payment_failed", orderId: known.order_id, orderStatus: "cancelled", charged: false, notice: PAYMENT_FAILED_NOTICE };
}

/** 트랜잭션 한 겹 — Db.transaction 콜백이 받는 tx 타입 */
export type PaymentFailureTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 실패 통지의 상태 전이만 하는 부분. **부르는 쪽이 연 트랜잭션 안에서** 돈다.
 * 웹훅 처리기(S3-3.9)는 웹훅 기록과 이 전이를 한 트랜잭션에 묶으려고 이 함수를 바로 부른다(계약 03 §6 「2~7 은 한 트랜잭션」).
 * 닫았으면 true, 이미 다른 쪽이 끝낸 주문이면 false.
 */
export async function closeOrderOnPaymentFailure(
  tx: PaymentFailureTx,
  input: {
    orderId: string;
    gatewayPaymentId: string;
    at: string;
    /** order_events.reason. 생략하면 `결제 실패`. 이벤트형 카드 승인 전액 취소(S3-3.10)가 자기 사유를 넣는다 */
    orderEventReason?: string;
  },
): Promise<boolean> {
  const { orderId, gatewayPaymentId, at } = input;
  const orderEventReason = input.orderEventReason ?? ORDER_EVENT_REASON;
  // 2. 조건부 전이 — 주문이 pending 이고 이 결제가 아직 ready 일 때만. 0행이면 다른 쪽이 먼저 끝냈다
  const [order] = await tx.query(
    tx.raw.sql`UPDATE orders SET status = 'cancelled', closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
               WHERE id = ${orderId}::uuid AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM payments p
                             WHERE p.order_id = orders.id AND p.gateway_payment_id = ${gatewayPaymentId} AND p.status = 'ready')
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (order === undefined) return false;

  await tx.execute(
    tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
               VALUES (uuidv7(), ${order.id}::uuid, 'pending', 'cancelled', ${orderEventReason})`
      .affectedCount()
      .build(),
  );
  // 3. 결제·예약을 닫고 자리를 돌려준다. 돈이 오가지 않았으니 환불 행은 만들지 않는다(셀프 취소와 같은 이유, plan D6)
  await tx.execute(
    tx.raw.sql`UPDATE payments SET status = 'cancelled', updated_at = ${at}::timestamptz
               WHERE order_id = ${order.id}::uuid AND status = 'ready'`
      .affectedCount()
      .build(),
  );
  const reservations = await tx.query(
    tx.raw.sql`UPDATE reservations SET status = 'cancelled', cancel_reason = ${RESERVATION_CANCEL_REASON},
                                       cancelled_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
               WHERE order_id = ${order.id}::uuid AND status = 'held'
               RETURNING seat_pool_id`
      .returnsRow({ seat_pool_id: "pg/uuid@1" })
      .build(),
  );
  // held_count > 0 조건은 CHECK 위반 대신 0행으로 끝나게 하는 안전장치다(만료 정리와 같다)
  for (const reservation of reservations) {
    await tx.execute(
      tx.raw.sql`UPDATE seat_pools SET held_count = held_count - 1, updated_at = ${at}::timestamptz
                 WHERE id = ${reservation.seat_pool_id}::uuid AND held_count > 0`
        .affectedCount()
        .build(),
    );
  }
  return true;
}
