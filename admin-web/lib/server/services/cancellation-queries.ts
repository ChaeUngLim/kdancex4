// S0-5.1(취소 서비스·경로 이관) — 취소 미리보기·예약 취소가 같이 쓰는 DB 읽기.
//   계약: _workspace/03_contracts/05-cancellation-migrated.md 「단계」 표
//
// 왜 따로 두나: 미리보기(쓰기 없음)와 취소(잠금 + 쓰기)가 「무엇을 어떻게 읽나」를 똑같이 해야
// 화면이 취소 가능하다고 했는데 API 가 거부하는 어긋남이 생기지 않는다. 판정 순서도 여기 한 곳(`blockReason`)에 둔다.
//
// raw 레인 주의(실측, holiday-sync.ts 와 같다):
//   - NULL 을 값으로 넘기지 못한다 → 빈 문자열로 넘기고 SQL 의 NULLIF 로 NULL 로 바꾼다
//   - 읽는 쪽도 NULL 칸은 COALESCE(…, '') 로 받아 TS 에서 null 로 되돌린다
//   - 시각은 to_char(… AT TIME ZONE 'UTC', …"Z") 로 ISO 문자열을 만들어 읽고 Temporal.Instant 로 바꾼다
//     (raw 템플릿 안에 문자열을 끼우면 값 자리가 되므로 SQL 문장에 그대로 풀어 쓴다)
import type { Db } from "../../../prisma/db";
import type { RefundStatus, ReservationStatus } from "../../domain/constants";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** 트랜잭션 안(tx)이든 밖(db)이든 raw 레인으로 읽고 쓰는 쪽 */
export type Runner = Pick<Tx, "raw" | "execute" | "query">;

/** 취소할 수 있는 예약 상태 — 옛 CANCELLABLE_RESERVATION_STATUSES 그대로 */
const CANCELLABLE: readonly ReservationStatus[] = ["held", "confirmed"];

/** 판정 사유 코드(§4.8 형식 — 대문자). 미리보기의 reasonCode 와 취소의 409 code 가 같은 값을 쓴다 */
export const BLOCK_CODES = {
  alreadyCancelled: "RESERVATION_ALREADY_CANCELLED",
  notCancellable: "RESERVATION_NOT_CANCELLABLE",
  classStarted: "CLASS_ALREADY_STARTED",
  useOrderCancel: "USE_ORDER_CANCEL",
  paidPaymentNotFound: "PAID_PAYMENT_NOT_FOUND",
} as const;
export type BlockCode = (typeof BLOCK_CODES)[keyof typeof BLOCK_CODES];

/** 사유마다 회원에게 보일 문장 */
export const BLOCK_DETAIL: Readonly<Record<BlockCode, string>> = {
  RESERVATION_ALREADY_CANCELLED: "이미 취소된 예약이에요",
  RESERVATION_NOT_CANCELLABLE: "취소할 수 없는 예약 상태예요",
  CLASS_ALREADY_STARTED: "이미 시작했거나 끝난 수업은 취소할 수 없어요",
  USE_ORDER_CANCEL: "입금 전 예약은 주문 취소로 처리해 주세요",
  PAID_PAYMENT_NOT_FOUND: "결제 완료된 원거래가 없어 환불할 수 없어요",
};

export const emptyToNull = (value: string): string | null => (value === "" ? null : value);

/** 취소 판정에 필요한 예약 사실 한 묶음 */
export interface ReservationFacts {
  id: string;
  orderId: string;
  memberId: string;
  status: ReservationStatus;
  seatPoolId: string;
  /** 시작 시각 = 판매 단위(class_offerings)의 첫 회차 시작(계약 05 단계 4) */
  startsAt: Temporal.Instant;
  academyId: string;
  /** academies.refund_policy_tiers JSONB 원본(§4.4) */
  tiers: unknown;
}

/**
 * 예약 하나와 그 시작 시각·학원 비율표를 읽는다.
 * `lock = true` 면 예약 행만 `FOR UPDATE OF r` 로 잠근다(옛 1단계) — 같은 예약에 동시에 들어온 취소 2건 중
 * 하나는 여기서 기다리고, 풀린 뒤에는 앞 요청이 만든 환불을 보고 재생 경로로 빠진다.
 */
export async function readReservation(runner: Runner, reservationId: string, lock: boolean): Promise<ReservationFacts | null> {
  const query = lock
    ? runner.raw.sql`SELECT r.id, r.order_id, r.member_id, r.status, r.seat_pool_id, c.academy_id,
                            to_char(o.first_session_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
                            a.refund_policy_tiers::text AS tiers
                     FROM reservations r
                     JOIN class_offerings o ON o.id = r.offering_id
                     JOIN classes c ON c.id = o.class_id
                     JOIN academies a ON a.id = c.academy_id
                     WHERE r.id = ${reservationId}::uuid
                     FOR UPDATE OF r`
    : runner.raw.sql`SELECT r.id, r.order_id, r.member_id, r.status, r.seat_pool_id, c.academy_id,
                            to_char(o.first_session_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
                            a.refund_policy_tiers::text AS tiers
                     FROM reservations r
                     JOIN class_offerings o ON o.id = r.offering_id
                     JOIN classes c ON c.id = o.class_id
                     JOIN academies a ON a.id = c.academy_id
                     WHERE r.id = ${reservationId}::uuid`;
  const [row] = await runner.query(
    query
      .returnsRow({
        id: "pg/uuid@1",
        order_id: "pg/uuid@1",
        member_id: "pg/uuid@1",
        status: "pg/text@1",
        seat_pool_id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        starts_at: "pg/text@1",
        tiers: "pg/text@1",
      })
      .build(),
  );
  if (row === undefined) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    memberId: row.member_id,
    status: row.status as ReservationStatus,
    seatPoolId: row.seat_pool_id,
    startsAt: Temporal.Instant.from(row.starts_at),
    academyId: row.academy_id,
    tiers: JSON.parse(row.tiers) as unknown,
  };
}

/** 결제 완료 원거래. 옛 「paid_at IS NOT NULL」 판정은 status = 'paid' 로 바뀌었다(계약 05 단계 5) */
export interface PaidPayment {
  id: string;
  method: string;
  amount: number;
  /** PG 에 넘길 원거래 식별자 — PG 가 준 키가 있으면 그것, 없으면 우리가 준 결제 id */
  paymentKey: string;
}

export async function readPaidPayment(runner: Runner, orderId: string): Promise<PaidPayment | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id, method, amount, COALESCE(gateway_payment_key, gateway_payment_id) AS payment_key
                   FROM payments
                   WHERE order_id = ${orderId}::uuid AND status = 'paid'
                   ORDER BY paid_at DESC NULLS LAST
                   LIMIT 1`
      .returnsRow({ id: "pg/uuid@1", method: "pg/text@1", amount: "pg/int4@1", payment_key: "pg/text@1" })
      .build(),
  );
  return row === undefined ? null : { id: row.id, method: row.method, amount: row.amount, paymentKey: row.payment_key };
}

/** 환불 행 중 응답에 필요한 칸 */
export interface RefundRow {
  id: string;
  reservationId: string;
  status: RefundStatus;
  requestedAmount: number;
  refundedAmount: number;
  refundRateBp: number;
  failureCode: string | null;
  failureMessage: string | null;
  gatewayRefundId: string | null;
}

/**
 * 이미 처리된 취소를 찾는다(옛 3단계 멱등 재생). 예약에 딸린 진행 중·성공 환불이 먼저,
 * 없으면 같은 멱등 키의 환불(실패 포함 — 같은 키로 다시 오면 처음 결과를 그대로 돌려준다).
 */
export async function findReplayableRefund(runner: Runner, reservationId: string, idempotencyKey: string): Promise<RefundRow | null> {
  const rows = await runner.query(
    runner.raw.sql`SELECT id, reservation_id, status, requested_amount, refunded_amount, refund_rate_bp,
                          COALESCE(failure_code, '') AS failure_code, COALESCE(failure_message, '') AS failure_message,
                          COALESCE(gateway_refund_id, '') AS gateway_refund_id,
                          CASE WHEN reservation_id = ${reservationId}::uuid AND status <> 'failed' THEN 0 ELSE 1 END AS rank
                   FROM refunds
                   WHERE (reservation_id = ${reservationId}::uuid AND status <> 'failed')
                      OR idempotency_key = ${idempotencyKey}
                   ORDER BY rank
                   LIMIT 1`
      .returnsRow({
        id: "pg/uuid@1",
        reservation_id: "pg/uuid@1",
        status: "pg/text@1",
        requested_amount: "pg/int4@1",
        refunded_amount: "pg/int4@1",
        refund_rate_bp: "pg/int4@1",
        failure_code: "pg/text@1",
        failure_message: "pg/text@1",
        gateway_refund_id: "pg/text@1",
        rank: "pg/int4@1",
      })
      .build(),
  );
  const [row] = rows;
  if (row === undefined) return null;
  return {
    id: row.id,
    reservationId: row.reservation_id,
    status: row.status as RefundStatus,
    requestedAmount: row.requested_amount,
    refundedAmount: row.refunded_amount,
    refundRateBp: row.refund_rate_bp,
    failureCode: emptyToNull(row.failure_code),
    failureMessage: emptyToNull(row.failure_message),
    gatewayRefundId: emptyToNull(row.gateway_refund_id),
  };
}

/** 시작까지 남은 초(내림). 이미 시작했으면 0 이하 */
export function secondsBefore(startsAt: Temporal.Instant, now: Temporal.Instant): number {
  return Math.floor(startsAt.since(now).total("seconds"));
}

/** 시작까지 남은 시간(시, 내림) — 옛 `int(total_seconds) // 3600` */
export function hoursBefore(startsAt: Temporal.Instant, now: Temporal.Instant): number {
  return Math.floor(Math.trunc(startsAt.since(now).total("seconds")) / 3600);
}

/**
 * 「지금 취소할 수 없는 이유」. 없으면 null.
 * 미리보기와 취소가 **같은 순서**로 이 함수를 쓴다(옛 `_preview_block_reason` 과 `cancel_reservation` 의 판정 순서).
 *   이미 취소 → 취소 가능한 상태가 아님 → 시작 뒤 → 입금 전 예약(held) → 결제 원거래 없음
 */
export function blockReason(
  reservation: Pick<ReservationFacts, "status" | "startsAt">,
  payment: PaidPayment | null,
  now: Temporal.Instant,
): BlockCode | null {
  if (reservation.status === "cancelled") return BLOCK_CODES.alreadyCancelled;
  if (!CANCELLABLE.includes(reservation.status)) return BLOCK_CODES.notCancellable;
  if (secondsBefore(reservation.startsAt, now) <= 0) return BLOCK_CODES.classStarted;
  // held = 아직 입금 전. 돌려줄 돈이 없으니 환불 경로가 아니라 주문 셀프 취소(FR-286)로 보낸다
  if (reservation.status === "held") return BLOCK_CODES.useOrderCancel;
  if (payment === null) return BLOCK_CODES.paidPaymentNotFound;
  return null;
}
