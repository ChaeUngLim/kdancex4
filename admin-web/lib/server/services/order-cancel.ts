// S0-5.1(취소 서비스·경로 이관) — `POST /api/orders/{id}/cancel`(FR-286(입금 전 셀프 취소)).
//   계약: _workspace/03_contracts/03-checkout-payment.md §2 · README §5(멱등: 주문 상태)
//
// 왜 예약 취소와 경로를 나눴나(plan D6): 입금 전 주문은 돈이 오가지 않았다. 환불 행을 만들 일이 없고,
// 묶어 둔 자리(held)를 풀고 발급한 가상계좌를 닫으면 끝이다. 입금 뒤 취소는 예약 취소(환불) 경로로 간다.
//
// 처리(한 트랜잭션): 주문 잠금 → pending 이면 주문 cancelled · 결제(ready) cancelled · 예약(held) cancelled(self_cancel_unpaid)
//   · seat_pools.held_count −1(조건부) · order_events. 커밋 뒤 PG cancelPayment 로 계좌 폐기 —
//   PG 호출이 실패해도 취소는 그대로 두고 기록만 한다(만료 정리 §5 와 같은 규칙).
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { routeIdSchema, type CancelOrderResponse } from "../schemas/cancellation";

export type OrderCancelDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway">;

const NOT_FOUND_DETAIL = "주문을 찾을 수 없어요";
const NOT_CANCELLABLE_DETAIL = "입금 뒤에는 환불 요청으로만 취소할 수 있어요";
const SELF_CANCEL_REASON = "self_cancel_unpaid";

export async function cancelUnpaidOrder(deps: OrderCancelDeps, input: { orderId: string; memberId: string }): Promise<CancelOrderResponse> {
  const now = deps.clock();
  const at = now.toString();

  const gatewayPaymentIds = await deps.db.transaction(async (tx) => {
    const [order] = await tx.query(
      tx.raw.sql`SELECT id, member_id, status FROM orders WHERE id = ${input.orderId}::uuid FOR UPDATE`
        .returnsRow({ id: "pg/uuid@1", member_id: "pg/uuid@1", status: "pg/text@1" })
        .build(),
    );
    if (order === undefined) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    if (order.member_id !== input.memberId) throw new HttpError("FORBIDDEN", "본인의 주문만 취소할 수 있어요");
    // 멱등: 이미 취소된 주문은 아무것도 바꾸지 않고 같은 본문(README §5)
    if (order.status === "cancelled") return [] as string[];
    // paid·expired·환불됨 — 셀프 취소 대상이 아니다
    if (order.status !== "pending") throw HttpError.conflict("ORDER_NOT_CANCELLABLE", NOT_CANCELLABLE_DETAIL);

    await tx.execute(
      tx.raw.sql`UPDATE orders SET status = 'cancelled', closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
                 WHERE id = ${order.id}::uuid`
        .affectedCount()
        .build(),
    );
    await tx.execute(
      tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
                 VALUES (uuidv7(), ${order.id}::uuid, 'pending', 'cancelled', ${SELF_CANCEL_REASON})`
        .affectedCount()
        .build(),
    );

    // 살아 있는(ready) 결제를 닫는다. 계좌 폐기는 커밋 뒤에 PG 에 알린다
    const payments = await tx.query(
      tx.raw.sql`UPDATE payments SET status = 'cancelled', updated_at = ${at}::timestamptz
                 WHERE order_id = ${order.id}::uuid AND status = 'ready'
                 RETURNING gateway_payment_id`
        .returnsRow({ gateway_payment_id: "pg/text@1" })
        .build(),
    );

    // 묶어 둔 예약을 풀고 자리 묶음의 held 를 하나씩 돌려준다(조건부 — 0 이면 CHECK 대신 0행)
    const reservations = await tx.query(
      tx.raw.sql`UPDATE reservations SET status = 'cancelled', cancel_reason = ${SELF_CANCEL_REASON},
                                         cancelled_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
                 WHERE order_id = ${order.id}::uuid AND status = 'held'
                 RETURNING seat_pool_id`
        .returnsRow({ seat_pool_id: "pg/uuid@1" })
        .build(),
    );
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

  // 커밋 뒤 계좌 폐기. 실패해도 취소를 되돌리지 않는다 — 폐기 못 한 계좌로 입금이 오면 웹훅이 「닫힌 주문 입금」으로 받는다
  for (const gatewayPaymentId of gatewayPaymentIds) {
    await deps.paymentGateway.cancelPayment(gatewayPaymentId, "회원 셀프 취소").catch((error: unknown) => {
      console.warn(`[order-cancel] PG 계좌 폐기 실패(gateway_payment_id=${gatewayPaymentId}) — 주문 취소는 그대로`, error);
    });
  }
  return { orderId: input.orderId, status: "cancelled" };
}

type OrderParams = { params: Promise<{ orderId: string }> };

export function createCancelOrderRoute(deps: OrderCancelDeps) {
  const guards = createGuards(deps);
  return withRoute<OrderParams>(async (request, context) => {
    const member = await guards.requireMember(request);
    const { orderId } = await context.params;
    const parsed = routeIdSchema.safeParse(orderId);
    if (!parsed.success) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    return Response.json(await cancelUnpaidOrder(deps, { orderId: parsed.data, memberId: member.memberId }));
  });
}
