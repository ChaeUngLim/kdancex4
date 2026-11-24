// S0-5.1(취소 서비스·경로 이관) — `POST /api/reservations/{id}/cancel` 의 처리기.
//   계약: _workspace/03_contracts/05-cancellation-migrated.md(단계 표·바뀌는 점·상태 코드) · README §5(멱등)
//   원본: backend/app/services/cancellation.py(SCH-05(취소 오케스트레이션)) — **동작 보존 이관**이다.
//
// 취소 1건의 순서(옛 11단계 → 새 구현). 한 트랜잭션 안에서 1~10, 커밋 뒤 11.
//   1  예약 행 잠금(raw 레인 SELECT … FOR UPDATE — S0-1.5 판정: Prisma db.transaction + raw 레인)
//   2  소유권(남의 예약 403)            3  멱등 재생(상태 검사보다 먼저 — 두 번째 요청은 200 + 처음 결과)
//   4  상태 검사(이미 취소·시작 뒤·입금 전 409)   5  결제 원거래(status='paid') → calculateRefund
//   6  환불 INSERT … ON CONFLICT DO NOTHING RETURNING — 0행이면 이긴 행으로 수렴(옛 SAVEPOINT 대체)
//   7  PG 환불(PaymentGatewayPort.refund)
//   8  성공·대기면 예약 cancelled · 주문 refunded · seat_pools.confirmed_count −1(조건부) · calendar_entries 삭제
//   9  refund_events(추가 전용) + notifications 기록(트랜잭션 안)   10 커밋
//   11 커밋 뒤 알림 발송(NotificationSenderPort). 옛 Redis 슬롯 락 해제는 없앴다(plan D8)
//
// 왜 PG 실패에도 예약을 그대로 두나: 환불이 실패했는데 자리까지 없애면 회원은 자리도 돈도 잃는다.
// 실패 환불은 failed 로 남기고(사유 포함) 예약·정원은 건드리지 않는다.
// 왜 pending 은 성공처럼 다루나: 가상계좌 환불은 별도 송금이라 바로 끝나지 않는다. 그동안 자리를 묶어 둘 이유가 없다.
//
// 환불 중복 방지(2026-11-20 사용자 결정 D13): 막는 단위는 「원인(basis)당 진행 중 1건 + 주문 환불 합계 상한」이다.
// 원인 칸(basis_kind·basis_id)과 합계 CHECK 는 S4-1 이 데이터 계약에 더한다. 지금 계약에서는 이관 취소의 원인이
// 「회원 요청 취소」 하나뿐이라, 같은 예약의 활성 환불 1건 부분 유니크(uq_refunds_reservation_id_active)가 곧 같은 원인 1건이다.
import { createHash } from "node:crypto";

import { calculateRefund, type RefundCalculation, type RefundPolicyTier } from "../../domain/refund-policy";
import type { RefundStatus } from "../../domain/constants";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseWith, readIdempotencyKey, withRoute } from "../http";
import {
  DEFAULT_CANCEL_REASON,
  UnsupportedPaymentMethodError,
  type RefundAccount,
  type RefundResult,
} from "../ports/payment-gateway";
import {
  cancelReservationRequestSchema,
  routeIdSchema,
  type CancelReservationRequest,
  type CancelReservationResponse,
} from "../schemas/cancellation";
import {
  BLOCK_CODES,
  BLOCK_DETAIL,
  blockReason,
  findReplayableRefund,
  hoursBefore,
  readPaidPayment,
  readReservation,
  type RefundRow,
  type Runner,
  type Tx,
} from "./cancellation-queries";

export type CancellationDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway" | "notificationSender">;

/** refund_events.event_type — 옛 RefundEventType 그대로(DB 에 CHECK 가 없는 앱 상수, §4.2) */
export const REFUND_EVENT_TYPES = {
  requested: "refund_requested",
  gatewaySucceeded: "gateway_succeeded",
  gatewayPending: "gateway_pending",
  gatewayFailed: "gateway_failed",
  unsupportedMethod: "gateway_unsupported_method",
  reservationCancelled: "reservation_cancelled",
} as const;

/** 카드처럼 이번 슬라이스가 환불하지 않는 결제수단의 실패 코드(옛 값 그대로) */
export const UNSUPPORTED_METHOD_CODE = "UNSUPPORTED_PAYMENT_METHOD";

const NOT_FOUND_DETAIL = "예약을 찾을 수 없어요";
const FORBIDDEN_DETAIL = "본인의 예약만 취소할 수 있어요";
/** 학원 비율표가 망가져 산정 함수가 거부했을 때(옛 ValueError → 422) */
export const INVALID_POLICY_DETAIL = "환불액을 계산할 수 없어요. 학원의 환불 비율표 설정을 확인해 주세요";

/**
 * Idempotency-Key 헤더가 있으면 그대로, 없으면 `sha256("cancel:" + 예약 id)`(README §5).
 * 예약마다 늘 같은 키가 나오므로 헤더를 안 보내는 앱이 취소를 두 번 눌러도 두 번째 INSERT 가 키 유니크에 걸린다.
 */
export function buildIdempotencyKey(reservationId: string, provided: string | null): string {
  if (provided !== null) return provided;
  return createHash("sha256").update(`cancel:${reservationId}`, "utf8").digest("hex");
}

/** 서비스가 돌려주는 결과 = 응답 본문 그대로 */
export type CancellationOutcome = CancelReservationResponse;

export interface CancelReservationInput {
  reservationId: string;
  memberId: string;
  idempotencyKey: string | null;
  refundAccount?: RefundAccount;
}

/** 환불 행 → 응답. 재생(replayed)일 때도 같은 모양이다 */
function outcomeFromRefund(
  refund: RefundRow,
  extra: { reservationStatus: CancellationOutcome["reservationStatus"]; hoursBeforeStart: number; slotRestored: boolean; replayed: boolean },
): CancellationOutcome {
  return {
    reservationId: refund.reservationId,
    refundId: refund.id,
    status: refund.status,
    requestedAmount: refund.requestedAmount,
    refundedAmount: refund.refundedAmount,
    refundRateBp: refund.refundRateBp,
    hoursBeforeStart: extra.hoursBeforeStart,
    reservationStatus: extra.reservationStatus,
    slotRestored: extra.slotRestored,
    replayed: extra.replayed,
    failureCode: refund.failureCode,
    failureMessage: refund.failureMessage,
    gatewayRefundId: refund.gatewayRefundId,
  };
}

/** 산정 함수가 망가진 비율표에 던지는 TypeError·RangeError 를 422 로 바꾼다(500 과 구분되게) */
function calculateOr422(input: Parameters<typeof calculateRefund>[0]): RefundCalculation {
  try {
    return calculateRefund(input);
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof RangeError) {
      console.warn("[cancellation] 환불 비율표가 잘못돼 산정하지 못했다", error.message);
      throw new HttpError("VALIDATION_FAILED", INVALID_POLICY_DETAIL);
    }
    throw error;
  }
}

/** refund_events 1행(추가 전용 — UPDATE·DELETE 하지 않는다) */
async function recordEvent(tx: Runner, refundId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO refund_events (id, refund_id, event_type, payload)
               VALUES (uuidv7(), ${refundId}::uuid, ${eventType}, ${JSON.stringify(payload)}::jsonb)`
      .affectedCount()
      .build(),
  );
}

/**
 * 앱 안 알림 기록(트랜잭션 안 — plan D7). 같은 (종류, 주문, 받는 사람)은 1건이라 다시 처리해도 늘지 않는다.
 * 새로 쓴 행의 id 만 돌려준다 — 커밋 뒤 발송할 목록이다.
 */
async function recordNotification(
  tx: Runner,
  input: { kind: string; memberId: string; orderId: string; reservationId: string; payload: Record<string, unknown> },
): Promise<string[]> {
  const rows = await tx.query(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, kind, order_id, reservation_id, payload)
               VALUES (uuidv7(), ${input.memberId}::uuid, ${input.kind}, ${input.orderId}::uuid,
                       ${input.reservationId}::uuid, ${JSON.stringify(input.payload)}::jsonb)
               ON CONFLICT DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return rows.map((r) => r.id);
}

/** 환불 행을 실패로 확정하고 사유를 남긴다(옛 _apply_failure). 칸 길이에 맞게 자른다 */
async function markRefundFailed(
  tx: Tx,
  refund: RefundRow,
  failure: { code: string | undefined; message: string | undefined; eventType: string; extra: Record<string, unknown> },
  now: Temporal.Instant,
): Promise<RefundRow> {
  const code = (failure.code ?? "PG_UNKNOWN_ERROR").slice(0, 100);
  const message = (failure.message ?? "").slice(0, 500);
  await tx.execute(
    tx.raw.sql`UPDATE refunds SET status = 'failed', refunded_amount = 0, failure_code = ${code},
                                  failure_message = NULLIF(${message}, ''), updated_at = ${now.toString()}::timestamptz
               WHERE id = ${refund.id}::uuid`
      .affectedCount()
      .build(),
  );
  await recordEvent(tx, refund.id, failure.eventType, {
    status: "failed",
    failure_code: code,
    failure_message: message === "" ? null : message,
    ...failure.extra,
  });
  return { ...refund, status: "failed", refundedAmount: 0, failureCode: code, failureMessage: message === "" ? null : message };
}

/**
 * 예약 1건을 취소하고 환불을 실행한다. PG 실패도 **예외가 아니라 결과**(status = failed)다 —
 * 실패 사유를 남긴 커밋이 예외로 날아가면 안 된다. 요청 자체가 성립하지 않으면 HttpError(4xx).
 */
export async function cancelReservation(deps: CancellationDeps, input: CancelReservationInput): Promise<CancellationOutcome> {
  const now = deps.clock();
  const key = buildIdempotencyKey(input.reservationId, input.idempotencyKey);

  const { outcome, notificationIds } = await deps.db.transaction(async (tx) => {
    // 1 잠금
    const reservation = await readReservation(tx, input.reservationId, true);
    if (reservation === null) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    // 2 소유권 — 없는 예약(404)과 남의 예약(403)을 구분한다(옛 수용 기준 「타인 403」)
    if (reservation.memberId !== input.memberId) throw new HttpError("FORBIDDEN", FORBIDDEN_DETAIL);

    // 3 멱등 재생 — 상태 검사보다 먼저. 이미 취소된 예약도 환불 기록이 있으면 409 가 아니라 처음 결과를 돌려준다
    const existing = await findReplayableRefund(tx, reservation.id, key);
    if (existing !== null) {
      return {
        outcome: outcomeFromRefund(existing, {
          reservationStatus: reservation.status,
          hoursBeforeStart: hoursBefore(reservation.startsAt, now),
          slotRestored: false,
          replayed: true,
        }),
        notificationIds: [] as string[],
      };
    }

    // 4·5 상태 검사 → 결제 원거래. 판정 순서는 미리보기와 같은 blockReason 하나다
    const payment = await readPaidPayment(tx, reservation.orderId);
    const blocked = blockReason(reservation, payment, now);
    if (blocked !== null) throw HttpError.conflict(blocked, BLOCK_DETAIL[blocked]);
    if (payment === null) throw HttpError.conflict(BLOCK_CODES.paidPaymentNotFound, BLOCK_DETAIL.PAID_PAYMENT_NOT_FOUND);

    const calculation = calculateOr422({
      paidAmount: payment.amount,
      startsAt: reservation.startsAt,
      now,
      tiers: reservation.tiers as readonly RefundPolicyTier[],
      reason: "member_request",
    });

    // 6 환불 INSERT. 부분 유니크(예약당 활성 1건)·멱등 키 유니크에 걸리면 예외 없이 0행이 온다(research R-07)
    const account = input.refundAccount;
    const inserted = await tx.query(
      tx.raw.sql`INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount,
                                      refund_rate_bp, status, reason, refund_account_bank_code, refund_account_number,
                                      refund_account_holder_name, updated_at)
                 VALUES (uuidv7(), ${reservation.id}::uuid, ${payment.id}::uuid, ${key}, ${calculation.refundAmount}, 0,
                         ${calculation.refundRateBp}, 'pending', 'member_request',
                         NULLIF(${account?.bankCode ?? ""}, ''), NULLIF(${account?.accountNumber ?? ""}, ''),
                         NULLIF(${account?.holderName ?? ""}, ''), ${now.toString()}::timestamptz)
                 ON CONFLICT DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    const [insertedRow] = inserted;
    if (insertedRow === undefined) {
      // 다른 요청이 먼저 넣었다 — 이긴 행으로 수렴한다(잠금이 있어 평소엔 3단계에서 걸러지고, 여기는 마지막 방어선)
      const winner = await findReplayableRefund(tx, reservation.id, key);
      if (winner === null) throw new Error("환불 INSERT 충돌 뒤 이긴 행을 찾지 못했다");
      return {
        outcome: outcomeFromRefund(winner, {
          reservationStatus: reservation.status,
          hoursBeforeStart: calculation.hoursBeforeStart,
          slotRestored: false,
          replayed: true,
        }),
        notificationIds: [] as string[],
      };
    }

    let refund: RefundRow = {
      id: insertedRow.id,
      reservationId: reservation.id,
      status: "pending",
      requestedAmount: calculation.refundAmount,
      refundedAmount: 0,
      refundRateBp: calculation.refundRateBp,
      failureCode: null,
      failureMessage: null,
      gatewayRefundId: null,
    };
    await recordEvent(tx, refund.id, REFUND_EVENT_TYPES.requested, {
      reservation_id: reservation.id,
      payment_id: payment.id,
      member_id: input.memberId,
      idempotency_key: key,
      paid_amount: payment.amount,
      requested_amount: calculation.refundAmount,
      refund_rate_bp: calculation.refundRateBp,
      hours_before_start: calculation.hoursBeforeStart,
      seconds_before_start: calculation.secondsBeforeStart,
      applied_tier_hours: calculation.appliedTierHours,
      reason: "member_request",
      starts_at: reservation.startsAt.toString(),
      now: now.toString(),
    });

    const notify = (kind: string, payload: Record<string, unknown>) =>
      recordNotification(tx, { kind, memberId: reservation.memberId, orderId: reservation.orderId, reservationId: reservation.id, payload });

    // 7 PG 환불. 카드는 이번 슬라이스가 환불하지 않는다 — 계약 05 「카드 → 미지원 → failed」
    let result: RefundResult;
    try {
      // 이 옛 경로는 가상계좌만 환불한다(계약 05). 가짜 PG 가 S4-1.5 부터 카드 부분 취소를 받으므로,
      // 옛 동작(카드 → 미지원 → failed)을 지키려고 포트를 부르기 전에 여기서 막는다. S4-1.9 가 이 경로를 걷어 낸다.
      if (payment.method !== "virtual_account") throw new UnsupportedPaymentMethodError(payment.method);
      result = await deps.paymentGateway.refund({
        paymentKey: payment.paymentKey,
        method: payment.method,
        amount: calculation.refundAmount,
        idempotencyKey: key,
        reason: DEFAULT_CANCEL_REASON,
        ...(account === undefined ? {} : { refundAccount: account }),
      });
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedPaymentMethodError)) throw error;
      refund = await markRefundFailed(
        tx,
        refund,
        { code: UNSUPPORTED_METHOD_CODE, message: error.message, eventType: REFUND_EVENT_TYPES.unsupportedMethod, extra: { method: payment.method } },
        now,
      );
      const ids = await notify("refund_failed", { refund_id: refund.id, failure_code: UNSUPPORTED_METHOD_CODE });
      return {
        outcome: outcomeFromRefund(refund, { reservationStatus: reservation.status, hoursBeforeStart: calculation.hoursBeforeStart, slotRestored: false, replayed: false }),
        notificationIds: ids,
      };
    }

    if (result.status === "failed") {
      // PG 실패 — 예약·정원은 그대로 둔다
      refund = await markRefundFailed(
        tx,
        refund,
        { code: result.failureCode, message: result.failureMessage, eventType: REFUND_EVENT_TYPES.gatewayFailed, extra: { raw_response: result.rawResponse } },
        now,
      );
      const ids = await notify("refund_failed", { refund_id: refund.id, failure_code: refund.failureCode });
      return {
        outcome: outcomeFromRefund(refund, { reservationStatus: reservation.status, hoursBeforeStart: calculation.hoursBeforeStart, slotRestored: false, replayed: false }),
        notificationIds: ids,
      };
    }

    // 8 성공·대기 — 환불 행 갱신 → 예약 취소 → 주문 refunded → 자리 반납 → 캘린더 삭제
    const succeeded = result.status === "succeeded";
    // pending 이면 아직 송금 전이라 받은 돈(refunded_amount)은 0 이다. 여기에 금액을 채우면 「이미 받은 돈」으로 집계된다
    const refundedAmount = succeeded ? calculation.refundAmount : 0;
    await tx.execute(
      tx.raw.sql`UPDATE refunds SET status = ${result.status}, refunded_amount = ${refundedAmount},
                                    gateway_refund_id = NULLIF(${result.gatewayRefundId ?? ""}, ''),
                                    failure_code = NULL, failure_message = NULL, updated_at = ${now.toString()}::timestamptz
                 WHERE id = ${refund.id}::uuid`
        .affectedCount()
        .build(),
    );
    refund = { ...refund, status: result.status as RefundStatus, refundedAmount, gatewayRefundId: result.gatewayRefundId ?? null };

    await tx.execute(
      tx.raw.sql`UPDATE reservations SET status = 'cancelled', cancel_reason = 'member_request',
                                         cancelled_at = ${now.toString()}::timestamptz, updated_at = ${now.toString()}::timestamptz
                 WHERE id = ${reservation.id}::uuid`
        .affectedCount()
        .build(),
    );

    // 주문 paid → refunded(data-model §4-1). 조건부라 이미 다른 상태면 0행이고 상태 기록도 남기지 않는다
    const orderMoved = await tx.query(
      tx.raw.sql`UPDATE orders SET status = 'refunded', updated_at = ${now.toString()}::timestamptz
                 WHERE id = ${reservation.orderId}::uuid AND status = 'paid'
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (orderMoved.length === 1) {
      await tx.execute(
        tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
                   VALUES (uuidv7(), ${reservation.orderId}::uuid, 'paid', 'refunded', 'member_request_cancel')`
          .affectedCount()
          .build(),
      );
    }

    // 정원 −1 은 seat_pools.confirmed_count(계약 05 「바뀌는 점」). 읽고-고쳐-쓰지 않고 한 문장의 조건부 UPDATE —
    // 이미 0 이면 CHECK 에 부딪히는 대신 0행으로 끝나 트랜잭션이 죽지 않는다(옛 _release_slot_capacity 와 같은 판단)
    const released = await tx.query(
      tx.raw.sql`UPDATE seat_pools SET confirmed_count = confirmed_count - 1, updated_at = ${now.toString()}::timestamptz
                 WHERE id = ${reservation.seatPoolId}::uuid AND confirmed_count > 0
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    const slotRestored = released.length === 1;
    if (!slotRestored) console.warn(`[cancellation] confirmed_count 감소 대상이 없다(seat_pool_id=${reservation.seatPoolId}) — 환불은 그대로 진행`);

    // 취소된 예약의 회차는 내 캘린더에서 빠진다(계약 05 — 새로 생긴 단계)
    await tx.execute(
      tx.raw.sql`DELETE FROM calendar_entries WHERE reservation_id = ${reservation.id}::uuid`.affectedCount().build(),
    );

    // 9 감사 기록 + 알림 기록
    await recordEvent(tx, refund.id, succeeded ? REFUND_EVENT_TYPES.gatewaySucceeded : REFUND_EVENT_TYPES.gatewayPending, {
      status: result.status,
      gateway_refund_id: result.gatewayRefundId ?? null,
      pg_cancellation_id: result.pgCancellationId ?? null,
      total_amount: result.totalAmount ?? null,
      requested_at: result.requestedAt?.toString() ?? null,
      cancelled_at: result.cancelledAt?.toString() ?? null,
      raw_response: result.rawResponse,
    });
    await recordEvent(tx, refund.id, REFUND_EVENT_TYPES.reservationCancelled, {
      reservation_id: reservation.id,
      seat_pool_id: reservation.seatPoolId,
      slot_restored: slotRestored,
      cancelled_at: now.toString(),
    });
    const ids = [
      ...(await notify("reservation_cancelled", { refund_id: refund.id, refund_status: refund.status })),
      ...(succeeded ? [] : await notify("refund_pending", { refund_id: refund.id, requested_amount: refund.requestedAmount })),
    ];

    return {
      outcome: outcomeFromRefund(refund, {
        reservationStatus: "cancelled",
        hoursBeforeStart: calculation.hoursBeforeStart,
        slotRestored,
        replayed: false,
      }),
      notificationIds: ids,
    };
  });
  // 10 커밋은 db.transaction 이 끝나며 일어났다.

  // 11 커밋 뒤 발송. 발송 실패가 이미 확정된 환불을 되돌리면 안 되므로 기록만 하고 결과는 그대로 돌려준다
  if (notificationIds.length > 0) {
    await deps.notificationSender.deliver(notificationIds).catch((error: unknown) => {
      console.warn("[cancellation] 알림 발송 실패 — 환불 결과는 그대로", error);
    });
  }
  return outcome;
}

/** 빈 본문은 「보낼 것 없음」({})이다. 본문이 있으면 JSON 이어야 하고 계약 모양이어야 한다 */
async function readCancelBody(request: Request): Promise<CancelReservationRequest> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  return parseWith(cancelReservationRequestSchema, raw);
}

type IdParams = { params: Promise<{ id: string }> };

/** 경로의 예약 id. 모양이 틀리면 없는 예약과 같게 404 */
export async function readReservationIdParam(context: IdParams): Promise<string> {
  const { id } = await context.params;
  const parsed = routeIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
  return parsed.data;
}

/** 라우트 처리기를 만든다. 앱은 공용 db·세션·getDeps() 를, 테스트는 테스트 DB·가짜를 넘긴다 */
export function createCancelReservationRoute(deps: CancellationDeps) {
  const guards = createGuards(deps);
  return withRoute<IdParams>(async (request, context) => {
    // 신원은 세션 회원(옛 X-User-Id 헤더 대신 — 계약 05 「바뀌는 점」)
    const member = await guards.requireMember(request);
    const reservationId = await readReservationIdParam(context);
    const idempotencyKey = readIdempotencyKey(request, { required: false });
    const body = await readCancelBody(request);
    const outcome = await cancelReservation(deps, {
      reservationId,
      memberId: member.memberId,
      idempotencyKey,
      ...(body.refundAccount === undefined ? {} : { refundAccount: body.refundAccount }),
    });
    return Response.json(outcome);
  });
}
