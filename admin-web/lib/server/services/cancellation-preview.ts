// S0-5.1(취소 서비스·경로 이관) — `GET /api/reservations/{id}/cancellation-preview`(예상 환불액 사전 고지).
//   계약: _workspace/03_contracts/05-cancellation-migrated.md 「경로」 · 원본: 옛 preview_cancellation
//
// DB 에 아무것도 쓰지 않는다. 예약 없음(404)·남의 예약(403)만 오류이고, 「지금은 취소할 수 없음」은
// cancellable = false + reasonCode 로 **값으로** 돌려준다 — 화면이 사유를 보여 주고 버튼을 막으려면 금액과 사유를 같이 받아야 한다.
// 판정 순서는 취소와 같은 blockReason 하나를 쓴다(어긋나면 화면은 된다는데 API 가 거부한다).
import { calculateRefund, type RefundPolicyTier } from "../../domain/refund-policy";
import type { PaymentMethod } from "../../domain/constants";
import { createGuards } from "../guards";
import { HttpError, withRoute } from "../http";
import type { CancellationPreviewResponse } from "../schemas/cancellation";
import { blockReason, readPaidPayment, readReservation } from "./cancellation-queries";
import { INVALID_POLICY_DETAIL, readReservationIdParam, type CancellationDeps } from "./cancellation";

export type PreviewDeps = Pick<CancellationDeps, "db" | "getSession" | "clock">;

export async function previewCancellation(
  deps: PreviewDeps,
  input: { reservationId: string; memberId: string },
): Promise<CancellationPreviewResponse> {
  const now = deps.clock();
  const reservation = await readReservation(deps.db, input.reservationId, false);
  if (reservation === null) throw new HttpError("NOT_FOUND", "예약을 찾을 수 없어요");
  if (reservation.memberId !== input.memberId) throw new HttpError("FORBIDDEN", "본인의 예약만 조회할 수 있어요");

  const payment = await readPaidPayment(deps.db, reservation.orderId);
  const paidAmount = payment?.amount ?? 0;
  let calculation;
  try {
    calculation = calculateRefund({
      paidAmount,
      startsAt: reservation.startsAt,
      now,
      tiers: reservation.tiers as readonly RefundPolicyTier[],
      reason: "member_request",
    });
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError) throw new HttpError("VALIDATION_FAILED", INVALID_POLICY_DETAIL);
    throw error;
  }

  const reasonCode = blockReason(reservation, payment, now);
  return {
    reservationId: reservation.id,
    paymentMethod: (payment?.method ?? null) as PaymentMethod | null,
    paidAmount,
    refundAmount: calculation.refundAmount,
    refundRateBp: calculation.refundRateBp,
    hoursBeforeStart: calculation.hoursBeforeStart,
    secondsBeforeStart: calculation.secondsBeforeStart,
    appliedTierHours: calculation.appliedTierHours,
    startsAt: reservation.startsAt.toString(),
    cancellable: reasonCode === null,
    reasonCode,
  };
}

export function createCancellationPreviewRoute(deps: PreviewDeps) {
  const guards = createGuards(deps);
  return withRoute<{ params: Promise<{ id: string }> }>(async (request, context) => {
    const member = await guards.requireMember(request);
    const reservationId = await readReservationIdParam(context);
    return Response.json(await previewCancellation(deps, { reservationId, memberId: member.memberId }));
  });
}
