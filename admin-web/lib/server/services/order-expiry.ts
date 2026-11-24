// S3-3.7(만료 정리·셀프 취소·내부 경로) — 결제 기한이 지난 결제 대기 주문을 `expired` 로 닫고 자리를 푼다.
//   계약: _workspace/03_contracts/03-checkout-payment.md §5(만료 정리) · §1 2단계 · data-model §4-1 「pending → expired」 행
//   요구: FR-096(결제 대기 자리 잠금) · FR-285(결제 기한) · FR-298(주문 상태 6종)
//
// 한 줄로: 회원이 결제창을 열어 둔 채(또는 가상계좌를 받고 입금하지 않은 채) 기한이 지나면, 그 사람이 잡아 둔 자리(held)를
//          다른 사람이 살 수 있게 돌려준다.
//
// 누가 부르나(진입점 둘, 계약 §5 표):
//   ① 읽기·쓰기 전 정리 — 홈 목록·수업 상세·주문 생성 직전에 부른다(plan D15). 스케줄러가 없어도 회원이 보는 잔여석이 맞게.
//      상세·주문 생성은 그 판매 단위만(offeringId), 홈 목록은 전부.
//   ② `POST /api/internal/orders/expire` — 나중에 시간 작업(cron)이 부른다. 범위는 전부
//
// 한 건 = 한 트랜잭션. 순서:
//   1. 주문 `pending → expired` 조건부 UPDATE. 조건에 「살아 있는(ready) 결제의 기한이 지났다」를 함께 건다.
//      0행이면 건너뛴다 — 그사이 입금 웹훅이 주문을 `paid` 로 바꿨거나, 다른 정리 호출·셀프 취소가 먼저 닫았다.
//      이 한 문장이 동시 실행의 방어선이다(data-model §4-1 「모든 전이는 조건부 갱신」). 두 번 불러도 결과가 같다(멱등).
//   2. 결제 `ready → expired` · 예약 `held → expired` · 자리 묶음 held −1(0 밑으로 안 내려가게 조건부) · order_events 1행
//   3. 커밋 뒤 PG 에 계좌 폐기(cancelPayment). 실패해도 만료를 되돌리지 않고 기록만 한다 —
//      폐기 못 한 계좌로 늦게 입금되면 웹훅이 「닫힌 주문 입금」(FR-292)으로 받는다. 셀프 취소(order-cancel.ts)와 같은 규칙
//
// 하지 않는 것: 대기 줄 다음 사람에게 기회 주기(seat_offers `order_expired`)는 대기 슬라이스 몫이다.
import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import type { PaymentGatewayPort } from "../ports/payment-gateway";

export interface OrderExpiryDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly paymentGateway: PaymentGatewayPort;
}

/** 내부 경로 응답과 테스트가 읽는 결과 — 계약 §5 「응답 `{"expired": 3}`」 */
export interface OrderExpiryResult {
  /** 이번 호출에서 expired 로 바꾼 주문 수 */
  readonly expired: number;
}

/** order_events 의 사유 — 「결제 기한이 지나 정리 작업이 닫았다」 */
const EXPIRED_REASON = "payment_deadline_passed";
/** PG 계좌 폐기 때 넘기는 사유 */
const GATEWAY_CANCEL_REASON = "결제 기한 경과";

/**
 * 기한 지난 결제 대기를 정리한다. `offeringId` 를 주면 그 판매 단위만, 없으면 전부.
 * 「지났다」는 `due_at <= 지금`(기한 시각 순간부터 만료)이다.
 */
export async function expireDuePayments(deps: OrderExpiryDeps, scope: { offeringId?: string } = {}): Promise<OrderExpiryResult> {
  const { db } = deps;
  const at = deps.clock().toString();
  // raw 태그는 null 값을 받지 않아 「범위 없음」을 빈 글자로 표시한다(빈 글자면 판매 단위 조건이 빠진다)
  const offeringId = scope.offeringId ?? "";

  // 후보 고르기 — ix_payments_status_due(status, due_at)를 탄다. 여기서는 읽기만 하고, 실제로 닫을지는 건마다 조건부 UPDATE 가 정한다
  const candidates = await db.query(
    db.raw.sql`SELECT DISTINCT p.order_id
               FROM payments p
               JOIN orders o ON o.id = p.order_id
               WHERE p.status = 'ready' AND p.due_at <= ${at}::timestamptz
                 AND o.status = 'pending'
                 AND (${offeringId} = '' OR o.offering_id::text = ${offeringId})`
      .returnsRow({ order_id: "pg/uuid@1" })
      .build(),
  );

  let expired = 0;
  const gatewayPaymentIds: string[] = [];
  for (const candidate of candidates) {
    const closed = await expireOne(db, candidate.order_id, at);
    if (closed === null) continue; // 그사이 다른 쪽이 먼저 닫았다
    expired += 1;
    gatewayPaymentIds.push(...closed);
  }

  // 커밋이 다 끝난 뒤에 PG 를 부른다 — 트랜잭션 안에서 바깥 호출을 기다리면 행 잠금이 길어진다
  for (const gatewayPaymentId of gatewayPaymentIds) {
    await deps.paymentGateway.cancelPayment(gatewayPaymentId, GATEWAY_CANCEL_REASON).catch((error: unknown) => {
      console.warn(`[order-expiry] PG 계좌 폐기 실패(gateway_payment_id=${gatewayPaymentId}) — 주문 만료는 그대로`, error);
    });
  }
  return { expired };
}

/** 주문 한 건을 한 트랜잭션으로 닫는다. 닫았으면 폐기할 PG 결제 번호들, 건너뛰었으면 null */
async function expireOne(db: Db, orderId: string, at: string): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    // 1. 조건부 전이 — pending 이고, 기한 지난 ready 결제가 아직 있을 때만. 0행이면 아무것도 바꾸지 않고 끝낸다
    const [order] = await tx.query(
      tx.raw.sql`UPDATE orders SET status = 'expired', closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
                 WHERE id = ${orderId}::uuid AND status = 'pending'
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.order_id = orders.id AND p.status = 'ready' AND p.due_at <= ${at}::timestamptz)
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (order === undefined) return null;

    await tx.execute(
      tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
                 VALUES (uuidv7(), ${orderId}::uuid, 'pending', 'expired', ${EXPIRED_REASON})`
        .affectedCount()
        .build(),
    );

    // 2. 결제를 닫는다(끝 상태). 늦은 입금이 와도 paid 로 바뀌지 않는다(data-model §4-1)
    const payments = await tx.query(
      tx.raw.sql`UPDATE payments SET status = 'expired', updated_at = ${at}::timestamptz
                 WHERE order_id = ${orderId}::uuid AND status = 'ready'
                 RETURNING gateway_payment_id`
        .returnsRow({ gateway_payment_id: "pg/text@1" })
        .build(),
    );

    // 예약은 사유 없이 상태로만 표현한다(cancel_reason 은 취소 때만 — data-model §4-1)
    const reservations = await tx.query(
      tx.raw.sql`UPDATE reservations SET status = 'expired', updated_at = ${at}::timestamptz
                 WHERE order_id = ${orderId}::uuid AND status = 'held'
                 RETURNING seat_pool_id`
        .returnsRow({ seat_pool_id: "pg/uuid@1" })
        .build(),
    );
    // 잡아 둔 자리를 돌려준다. held_count > 0 조건은 CHECK 위반 대신 0행으로 끝나게 하는 안전장치다
    for (const reservation of reservations) {
      await tx.execute(
        tx.raw.sql`UPDATE seat_pools SET held_count = held_count - 1, updated_at = ${at}::timestamptz
                   WHERE id = ${reservation.seat_pool_id}::uuid AND held_count > 0`
          .affectedCount()
          .build(),
      );
    }
    return payments.map((p) => p.gateway_payment_id);
  });
}
