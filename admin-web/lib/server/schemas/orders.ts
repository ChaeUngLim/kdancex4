// S3-3.4(주문 생성 API) — `POST /api/orders` 의 요청·응답 모양(계약 03 §1).
//   요청 스키마는 처리기가 parseJsonBody 로 검사하고, 응답 스키마는 처리기가 내보내기 전에 parse 한다 —
//   계약과 다른 칸이 응답에 섞이면 그 자리에서 500 으로 드러나게 하려는 것이다(테스트도 같은 스키마로 읽는다).
import { z } from "zod";

import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, SEAT_KINDS } from "../../domain/constants";
import { PRICE_LINE_KINDS } from "../../domain/money";

/**
 * 요청 본문. 금액 칸은 없다 — 앱이 `amount` 같은 칸을 보내도 z.object 가 버리고, 서버는 판매 단위 가격만 쓴다
 * (FR-298b(결제 멱등성·금액 재계산)). 알 수 없는 칸을 422 로 막지 않는 까닭: 뒤 Task 들이 선택 칸(쿠폰·대기 기회 등)을
 * 더할 때 옛 앱이 깨지지 않게 하려는 것이다(계약 README §0 「더하는 것」 표).
 */
export const createOrderRequestSchema = z.object({
  offeringId: z.uuid(),
  seatKind: z.enum(SEAT_KINDS),
  method: z.enum(PAYMENT_METHODS),
  noticesAcknowledged: z.literal(true, { error: "환불·취소 공지와 중개자 고지를 확인해 주세요" }),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

const priceLineSchema = z.strictObject({
  kind: z.enum(PRICE_LINE_KINDS),
  label: z.string(),
  amount: z.number().int().nonnegative(),
});

/** 응답 본문(계약 03 §1). 새로 만들면 201, 같은 키 재요청·진행 중 주문 복구(M-04)는 200 에 같은 모양 */
export const orderResponseSchema = z.strictObject({
  orderId: z.uuid(),
  // 새 주문·진행 중 복구는 pending. 같은 키 재요청은 그 주문의 지금 상태(이미 확정됐으면 paid)를 그대로 보여 준다
  status: z.enum(ORDER_STATUSES),
  reservationId: z.uuid(),
  seatKind: z.enum(SEAT_KINDS),
  priceBreakdown: z.array(priceLineSchema).min(1),
  payment: z.strictObject({
    paymentId: z.uuid(),
    method: z.enum(PAYMENT_METHODS),
    status: z.enum(PAYMENT_STATUSES),
    amount: z.number().int().nonnegative(),
    dueAt: z.iso.datetime(),
    virtualAccount: z.strictObject({ bankCode: z.string(), accountNumber: z.string(), holder: z.string() }).nullable(),
    cardCheckout: z.strictObject({ checkoutKey: z.string() }).nullable(),
  }),
  refundNoticeVersionId: z.uuid(),
  intermediaryNoticeVersion: z.string(),
});
export type OrderResponse = z.infer<typeof orderResponseSchema>;
