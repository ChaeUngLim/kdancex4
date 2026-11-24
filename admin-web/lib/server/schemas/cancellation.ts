// S0-5.1(취소 서비스·경로 이관) — 취소 경로의 요청·응답 모양(zod).
//   계약: _workspace/03_contracts/05-cancellation-migrated.md(예약 취소·미리보기) · 03-checkout-payment.md §2(주문 셀프 취소)
//   원본: backend/app/schemas/cancellation.py(SCH-06(Pydantic 스키마 + 라우터)) — 칸 이름만 camelCase 로 바꿨다.
//
// 이 파일은 「경계 검증과 모양」만 맡는다. 금액을 계산하거나 DB 를 읽지 않는다.
// 응답 스키마는 테스트가 응답 본문을 parse 해서 키 이름·타입을 1대1로 확인하는 데도 쓴다(strict — 모르는 키가 있으면 실패).
import { z } from "zod";

import { ORDER_STATUSES, PAYMENT_METHODS, REFUND_STATUSES, RESERVATION_STATUSES } from "../../domain/constants";

/**
 * 환불 받을 계좌(가상계좌 환불 전용). 길이 상한은 refunds 칸 길이와 같다 —
 * 여기서 안 막으면 PG 호출 직전 INSERT 에서 터지고, 그때는 실패 지점이 훨씬 나쁘다.
 */
export const refundAccountSchema = z.strictObject({
  bankCode: z.string().trim().min(1).max(20),
  accountNumber: z.string().trim().min(1).max(64),
  holderName: z.string().trim().min(1).max(100),
  holderPhoneNumber: z.string().trim().max(20).optional(),
});

/**
 * `POST /api/reservations/{id}/cancel` 요청 본문. 본문 전체가 **선택**이다(카드는 보낼 것이 없다).
 * `method` 는 참고값이다 — 결제수단의 권위는 DB 의 payments.method 이고, 서비스는 그것만 본다.
 * 다만 회원이 「가상계좌」라고 말했는데 계좌가 없으면 PG 까지 가기 전에 422 로 막는다(옛 규칙 그대로).
 * strict 인 이유: 오타 난 칸(`refund_account` 등)을 조용히 버리면 회원은 계좌를 냈다고 믿는데 서버는 못 받는다.
 */
export const cancelReservationRequestSchema = z
  .strictObject({
    method: z.enum(PAYMENT_METHODS).optional(),
    refundAccount: refundAccountSchema.optional(),
  })
  .refine((body) => body.method !== "virtual_account" || body.refundAccount !== undefined, {
    message: "가상계좌 환불에는 refundAccount(bankCode·accountNumber·holderName)가 필요해요",
    path: ["refundAccount"],
  });
export type CancelReservationRequest = z.output<typeof cancelReservationRequestSchema>;

/**
 * 예약 취소 응답. **PG 환불 실패도 200 + 이 모양**이다(status = failed). 요청은 정상 처리됐고(환불 행·감사 기록이 남았다)
 * 결과가 실패인 것이라 상태는 본문에 싣는다 — 4xx 로 보내면 실패 사유가 앱의 오류 처리로 빨려 들어가 회원에게 이유를 못 보여 준다.
 */
export const cancelReservationResponseSchema = z.strictObject({
  reservationId: z.uuid(),
  refundId: z.uuid(),
  status: z.enum(REFUND_STATUSES),
  requestedAmount: z.number().int(),
  refundedAmount: z.number().int(),
  refundRateBp: z.number().int(),
  hoursBeforeStart: z.number().int(),
  reservationStatus: z.enum(RESERVATION_STATUSES),
  slotRestored: z.boolean(),
  replayed: z.boolean(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  gatewayRefundId: z.string().nullable(),
});
export type CancelReservationResponse = z.infer<typeof cancelReservationResponseSchema>;

/**
 * 취소 미리보기 응답(예상 환불액 사전 고지). `cancellable = false` 여도 금액은 채워 보낸다 —
 * 화면이 「왜 못 하는지」와 「했다면 얼마였는지」를 같이 보여 줄 수 있어야 한다.
 * `paymentMethod` 는 화면이 확정 전에 환불 계좌 입력 칸을 띄울지 정하는 근거다(가상계좌만 계좌가 필요).
 */
export const cancellationPreviewResponseSchema = z.strictObject({
  reservationId: z.uuid(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  paidAmount: z.number().int(),
  refundAmount: z.number().int(),
  refundRateBp: z.number().int(),
  hoursBeforeStart: z.number().int(),
  secondsBeforeStart: z.number().int(),
  appliedTierHours: z.number().int().nullable(),
  startsAt: z.string(),
  cancellable: z.boolean(),
  reasonCode: z.string().nullable(),
});
export type CancellationPreviewResponse = z.infer<typeof cancellationPreviewResponseSchema>;

/** `POST /api/orders/{id}/cancel`(FR-286(입금 전 셀프 취소)) 응답. 이미 취소된 주문을 다시 불러도 같은 본문이다 */
export const cancelOrderResponseSchema = z.strictObject({
  orderId: z.uuid(),
  status: z.literal("cancelled" satisfies (typeof ORDER_STATUSES)[number]),
});
export type CancelOrderResponse = z.infer<typeof cancelOrderResponseSchema>;

/** 경로의 id 칸. 모양이 틀린 id 를 DB 에 넘기면 형 변환 오류(500)가 나므로 미리 걸러 404 로 답한다 */
export const routeIdSchema = z.uuid();
