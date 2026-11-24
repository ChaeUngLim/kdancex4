// S3-3.9(웹훅 확정 일괄 처리) — `POST /api/payments/webhook`(계약 03-checkout-payment.md §6, FR-287(웹훅 확정)).
//   데이터: data-model §4-1 「pending → 유효한 입금 웹훅 → paid」 행 · §4-4(자리 묶음 카운터) · 계약 04 §3(확정 알림 2건)
//   요구: FR-287(웹훅 확정) · FR-289(확정 후 일괄 처리) · FR-115(결제 금액 대조) · FR-116(결제 통지 중복 반영 방지) · 플랜 S3-3 수용 ⑤
//
// 한 줄로: PG 가 「돈이 들어왔다」고 알려 오면, 그 알림이 진짜인지(서명) · 처음 온 것인지(webhook-id) · PG 가 정말 그렇게 말하는지(재조회) ·
//          금액이 맞는지(세 값 대조)를 차례로 확인하고, 다 맞을 때만 주문·결제·예약·자리·캘린더·알림·정산 보류를 **한 트랜잭션**에서 바꾼다.
//
// 순서(계약 §6 표 번호):
//   1. 서명·시각 검증 — 원문 문자열로. 틀리면 401 `INVALID_SIGNATURE` + `rejected_signature` 기록(트랜잭션 밖, 따로 남는다)
//   2. webhook-id 원장 INSERT … ON CONFLICT DO NOTHING — 충돌이면 200 `duplicate`. 같은 id 가 동시에 두 번 와도 두 번째 INSERT 는
//      첫 트랜잭션이 끝날 때까지 기다렸다가 충돌로 빠진다(유니크 인덱스가 1차 방어선)
//   3. type 이 `Transaction.Paid`·`Transaction.Failed` 가 아니면 200 `ignored`. Failed 는 S3-3.8 의 전이를 같은 트랜잭션에서 부른다
//   4. `getPayment` 로 PG 에 다시 묻는다 — 본문의 금액·상태를 믿지 않는다
//   5. 세 금액 대조: 주문 total_amount = 결제 amount = PG 응답 금액. 다르면 확정하지 않고 200 `amount_mismatch`(돌려줄 대상 기록, S3-3.11)
//   6. 주문 `pending → paid` 조건부 UPDATE(0행이면 다른 웹훅이 먼저 확정 — 서로 다른 webhook-id 동시 2건의 방어선) →
//      결제 paid · 예약 confirmed · held −1 confirmed +1 · 캘린더(회차 수만큼) · 알림 2건(행만, 발송은 SCH-38(알림)) · 정산 hold 1건 · order_events
//   7. 주문이 이미 expired·cancelled 면 확정하지 않고 200 `deposit_on_closed_order`(pg_reported_amount 기록 + 돌려줄 대상 기록, S3-3.11)
//   8. 주문이 이미 paid 면 200 `ignored`
//   2~7 은 한 트랜잭션이다. 중간에 하나라도 실패하면 웹훅 기록까지 함께 롤백되고 500 — PG 가 다시 보내면 처음부터 다시 처리된다.
//
// S3-3.11(금액 불일치·늦은 입금·중복 결제)이 더한 것 — 5번·7번 자리(아래 `recordRefundDue`):
//   확정하지 않은 입금은 「돌려줄 돈」으로 payment_exceptions 에 1행(status refund_due, 입금액 전액) + 알림 payment_refund_due 2건(회원·대표).
//   한 결제의 돈은 한 번만 돌려줄 대상이 된다 — 같은 결제에 이미 예외 행이 있으면(재통지·다른 금액 뒤 만료) 더 만들지 않는다.
//   중복 결제(FR-291)는 같은 주문에 살아 있는 결제가 한 건뿐(uq_payments_order_live)이라 「같은 결제의 통지가 여러 번」으로만 온다 —
//   6번 주문 조건부 UPDATE 가 1건만 확정하고 나머지는 8번 `ignored` 로 받는다(돈은 한 번 들어왔으니 돌려줄 것이 없다).
//
// 이 Task 가 하지 않는 것(다른 Task 몫):
//   - dev 입금 흉내 경로 → S3-3.14
//
// S3-3.13(결제 시작·웹훅 요청 제한)이 더한 것 — 1번 서명 검증이 실패한 쪽에만(`signatureFailureLimit`):
//   서명 실패를 경로 전체 한 칸으로 세고, 10분에 20회(추천값)를 넘으면 그 뒤의 틀린 서명은 기록 없이 429.
//   서명이 맞는 통지는 세지도 막지도 않는다 — 정상 PG 재전송까지 막으면 확정이 빠진다(플랜 S3-3 수용 ⑦).
//
// S3-3.10(이벤트형 카드 승인 통지 전액 취소)이 더한 것 — 6번 확정 바로 앞(아래 `cancelDisallowedApproval`):
//   이벤트형(원데이·이벤트·파티·공연·대회)은 계좌이체만 받는다(FR-280(결제수단 결정) · FR-111a(카드 허용 범위) 강제 방법 ③).
//   주문 생성이 카드를 막아도(S3-3.6) 회원이 결제창에서 카드로 바꿔 승인하면 카드 승인 통지가 올 수 있다.
//   그때는 확정하지 않고 → 주문을 닫아 자리를 풀고 → PG 에 승인 전액 취소를 한 번 부른다.
//   판정은 주문 **스냅샷**의 상품 종류(orders.class_kind — 결제 뒤 대표가 수업을 고쳐도 그대로)와 PG 가 말한 승인 수단으로 한다.
import { z } from "zod";

import { withRoute } from "../http";
import type { RateLimiter, RateLimitRule } from "../rate-limit";

import type { Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import { CLASS_KINDS, PAYMENT_METHODS, type ClassKind, type PaymentMethod } from "../../domain/constants";
import { isPaymentMethodAllowed } from "../../domain/payment-methods";
import { PaymentNotFoundError, type PaymentGatewayPort } from "../ports/payment-gateway";
import { WEBHOOK_ID_HEADER, type WebhookVerifier } from "../ports/webhook-verifier";
import { closeOrderOnPaymentFailure, PAYMENT_FAILED_NOTICE } from "./payment-failure";

export interface PaymentWebhookDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly paymentGateway: PaymentGatewayPort;
  readonly webhookVerifier: WebhookVerifier;
  /**
   * 서명 실패 횟수 제한(S3-3.13). 앱 경로(app/api/payments/webhook/route.ts)는 반드시 넘긴다.
   * 생략하면 세지 않는다(제한과 상관없는 테스트용). rule 은 보통 loadRateLimitRules().webhookSignatureFailure
   */
  readonly signatureFailureLimit?: { readonly limiter: RateLimiter; readonly rule: RateLimitRule };
}

/**
 * 서명 실패를 세는 칸. IP 로 나누지 않고 웹훅 경로 전체를 한 칸으로 센다(플랜 S3-3 수용 ⑦ 「IP 가 아니라 서명 실패 횟수로」).
 * 이 칸이 차도 서명이 맞는 웹훅은 그대로 처리되므로, 한 칸으로 세도 정상 PG 통지는 막히지 않는다.
 */
const SIGNATURE_FAILURE_SUBJECT = "payment-webhook:signature-failure";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** payment_webhook_events.result 값 중 이 처리기가 쓰는 것 — data-model §3 표 */
export type WebhookOutcome =
  | "confirmed"
  | "duplicate"
  | "rejected_signature"
  | "amount_mismatch"
  | "deposit_on_closed_order"
  | "ignored"
  | "payment_failed";

/** 처리 결과. 라우트가 status 와 body 를 그대로 응답으로 쓴다 */
export interface PaymentWebhookResult {
  readonly status: 200 | 401;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * 웹훅 본문 — 계약 §6 「`{ type, timestamp, data: { paymentId, transactionId } }`」.
 * 모르는 칸은 받아 둔다(strict 아님) — PG 가 칸을 늘려도 확정이 멈추지 않게. 필요한 칸만 검사한다.
 */
export const paymentWebhookBodySchema = z.object({
  type: z.string().min(1).max(100),
  timestamp: z.string().max(100).optional(),
  data: z
    .object({
      paymentId: z.string().min(1).max(64),
      transactionId: z.string().max(200).optional(),
    })
    .optional(),
});

/** order_events.reason — 입금 확인으로 확정했다 */
const CONFIRMED_REASON = "입금 확인";
/** order_events.reason — 대표 알림을 받을 사람이 없어 만들지 못했다(계약 04 §3 「없으면 만들지 않고 order_events 에 사유 기록」) */
const OWNER_MISSING_REASON = "대표 알림 받을 사람 없음";
/** order_events.reason — 닫힌 주문에 입금이 들어왔다(상태 전이 아님, data-model §4-1) */
const CLOSED_DEPOSIT_REASON = "닫힌 주문 입금";
/** payment_exceptions.kind — data-model §4.1 */
type PaymentExceptionKind = "amount_mismatch" | "deposit_on_closed_order";
/** order_events.reason — 이벤트형 주문에 카드 승인이 와서 전액 취소했다(S3-3.10) */
const DISALLOWED_APPROVAL_REASON = "이벤트형 카드 승인 전액 취소";
/** PG 취소 사유(포트원 `reason` 필수 칸) */
const DISALLOWED_APPROVAL_PG_REASON = "이벤트형 상품은 계좌이체만 받습니다";
/** 앱이 그대로 보여 줄 안내 문구(추천값) */
export const DISALLOWED_APPROVAL_NOTICE = "이 수업은 계좌이체로만 결제할 수 있어 카드 승인을 전액 취소했어요";

/**
 * 웹훅 한 건을 처리한다. 예외는 「PG 장애·DB 오류」뿐이고, 라우트가 500 으로 바꾼다(PG 가 다시 보내게).
 * 같은 webhook-id 를 몇 번 보내도 반영은 한 번이다.
 */
export async function processPaymentWebhook(
  deps: PaymentWebhookDeps,
  input: { headers: Headers; rawBody: string },
): Promise<PaymentWebhookResult> {
  const { db } = deps;
  const now = deps.clock();

  // 1. 서명·시각 검증 — JSON 을 풀기 전 원문으로 한다(다시 직렬화하면 바이트가 달라진다)
  //    요청 제한(S3-3.13)은 **서명이 틀린 요청만** 센다. 서명 검사를 제한보다 먼저 하는 이유 — 제한을 앞에 두면
  //    누군가 틀린 서명을 쏟아 내는 동안 PG 의 진짜 통지·재전송까지 429 로 막혀 확정이 빠진다.
  //    한도를 넘은 틀린 서명은 rejected_signature 행을 남기지 않고 429 로 끝낸다(DB 에 쓰레기 행이 쌓이지 않게)
  if (!deps.webhookVerifier.verify(input.headers, input.rawBody, now)) {
    const limit = deps.signatureFailureLimit;
    if (limit !== undefined) await limit.limiter.consume(limit.rule, [SIGNATURE_FAILURE_SUBJECT]);
    await recordRejectedSignature(db, input.headers.get(WEBHOOK_ID_HEADER));
    return { status: 401, body: { detail: "웹훅 서명이 맞지 않아요", code: "INVALID_SIGNATURE" } };
  }

  // 서명이 맞았으니 webhook-id 헤더는 반드시 있다(검증기가 없으면 false 를 낸다)
  const webhookId = input.headers.get(WEBHOOK_ID_HEADER) ?? "";
  const body = parseBody(input.rawBody);
  const eventType = body?.type ?? "unparsable";
  const gatewayPaymentId = body?.data?.paymentId ?? "";

  // 2~7 한 트랜잭션 — 웹훅 기록도 안에 있어서, 확정이 실패하면 기록도 사라져 재전송이 duplicate 로 빠지지 않는다
  return db.transaction(async (tx) => {
    const [inserted] = await tx.query(
      tx.raw.sql`INSERT INTO payment_webhook_events (id, webhook_id, event_type, gateway_payment_id, result, payload)
                 VALUES (uuidv7(), ${webhookId}, ${eventType}, NULLIF(${gatewayPaymentId}, ''), 'ignored', ${payloadJson(input.rawBody)}::jsonb)
                 ON CONFLICT (webhook_id) DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    // 이미 받은 webhook-id — 아무것도 바꾸지 않는다(FR-116(결제 통지 중복 반영 방지))
    if (inserted === undefined) return ok({ result: "duplicate" });

    const outcome = await handleEvent(deps, tx, { eventType, gatewayPaymentId, at: now.toString() });
    await tx.execute(
      tx.raw.sql`UPDATE payment_webhook_events SET result = ${outcome.result} WHERE id = ${inserted.id}::uuid`.affectedCount().build(),
    );
    return ok(outcome);
  });
}

function ok(body: Readonly<Record<string, unknown>> & { result: WebhookOutcome }): PaymentWebhookResult {
  return { status: 200, body };
}

/** 본문을 풀고 모양을 검사한다. 서명이 맞았는데도 모양이 틀리면 null — 기록만 하고 `ignored` 로 받는다(PG 재전송을 멈춘다) */
function parseBody(rawBody: string): z.output<typeof paymentWebhookBodySchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const result = paymentWebhookBodySchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** payload 칸(jsonb)에 넣을 값. JSON 이 아니면 원문을 글자로 감싸 남긴다 */
function payloadJson(rawBody: string): string {
  try {
    JSON.parse(rawBody);
    return rawBody;
  } catch {
    return JSON.stringify({ unparsable: rawBody.slice(0, 2000) });
  }
}

/**
 * 서명이 틀린 요청 기록(계약 §6 1행). 트랜잭션 밖에서 따로 남긴다.
 * webhook_id 칸에는 요청이 주장한 id 를 넣지 않고 `rejected:<새 id>` 를 넣는다 — 주장한 id 를 넣으면 유니크 인덱스를 선점해,
 * 같은 id 로 나중에 온 **진짜** 웹훅이 duplicate 로 빠진다(위조 요청으로 확정을 막는 공격). 주장한 id 는 payload 에만 남긴다.
 * 본문·서명 원문은 남기지 않는다.
 */
async function recordRejectedSignature(db: Db, claimedWebhookId: string | null): Promise<void> {
  await db.execute(
    db.raw.sql`INSERT INTO payment_webhook_events (id, webhook_id, event_type, result, payload)
               VALUES (uuidv7(), 'rejected:' || uuidv7()::text, 'rejected', 'rejected_signature',
                       ${JSON.stringify({ claimedWebhookId: claimedWebhookId?.slice(0, 200) ?? null })}::jsonb)`
      .affectedCount()
      .build(),
  );
}

type EventOutcome = Readonly<Record<string, unknown>> & { result: WebhookOutcome };

/** 3~8 — 이벤트 종류별로 나눈다 */
async function handleEvent(
  deps: PaymentWebhookDeps,
  tx: Tx,
  input: { eventType: string; gatewayPaymentId: string; at: string },
): Promise<EventOutcome> {
  const { eventType, gatewayPaymentId, at } = input;
  if (gatewayPaymentId === "") return { result: "ignored" };
  if (eventType !== "Transaction.Paid" && eventType !== "Transaction.Failed") return { result: "ignored" };

  // 우리 결제인가 — 다른 환경의 통지·잘못된 번호면 손대지 않는다
  const [known] = await tx.query(
    tx.raw.sql`SELECT p.id AS payment_id, p.order_id, p.amount, p.status AS payment_status, p.method AS payment_method,
                      o.status AS order_status, o.total_amount, o.class_kind
               FROM payments p JOIN orders o ON o.id = p.order_id
               WHERE p.gateway_payment_id = ${gatewayPaymentId}`
      .returnsRow({
        payment_id: "pg/uuid@1",
        order_id: "pg/uuid@1",
        amount: "pg/int4@1",
        payment_status: "pg/text@1",
        payment_method: "pg/text@1",
        order_status: "pg/text@1",
        total_amount: "pg/int4@1",
        class_kind: "pg/text@1",
      })
      .build(),
  );
  if (known === undefined) return { result: "ignored", orderId: null, orderStatus: null };

  // 4. PG 재조회 — 본문이 「입금됨」이라 해도 PG 가 같은 말을 할 때만 움직인다. PG 장애는 던져서 500(재전송을 받는다)
  const reported = await deps.paymentGateway.getPayment(gatewayPaymentId).catch((error: unknown) => {
    if (error instanceof PaymentNotFoundError) return null;
    throw error;
  });
  if (reported === null) return { result: "ignored", orderId: known.order_id, orderStatus: known.order_status };

  if (eventType === "Transaction.Failed") {
    // M-03(카드 승인 실패) — S3-3.8 의 전이를 이 트랜잭션 안에서 부른다
    if (reported.status !== "failed") return { result: "ignored", orderId: known.order_id, orderStatus: known.order_status };
    const closed = await closeOrderOnPaymentFailure(tx, { orderId: known.order_id, gatewayPaymentId, at });
    if (!closed) return { result: "ignored", orderId: known.order_id, orderStatus: await currentOrderStatus(tx, known.order_id) };
    return { result: "payment_failed", orderId: known.order_id, orderStatus: "cancelled", charged: false, notice: PAYMENT_FAILED_NOTICE };
  }

  // 여기부터 Transaction.Paid. PG 가 입금됐다고 하지 않으면 믿지 않는다
  if (reported.status !== "paid") return { result: "ignored", orderId: known.order_id, orderStatus: known.order_status };

  // 8. 이미 확정된 주문 — 같은 결제의 재통지
  if (known.order_status === "paid") return { result: "ignored", orderId: known.order_id, orderStatus: "paid" };

  // 7. 끝 상태(expired·cancelled) 주문 — 확정하지 않는다(FR-292(만료 뒤 늦은 입금))
  if (known.order_status === "expired" || known.order_status === "cancelled") {
    return recordClosedOrderDeposit(tx, {
      paymentId: known.payment_id,
      orderId: known.order_id,
      orderStatus: known.order_status,
      reportedAmount: reported.amount,
      transactionId: reported.transactionId ?? null,
      at,
    });
  }
  if (known.order_status !== "pending" || known.payment_status !== "ready") {
    return { result: "ignored", orderId: known.order_id, orderStatus: known.order_status };
  }

  // S3-3.10 — 이 상품이 받지 않는 수단으로 승인됐으면 확정하지 않고 전액 취소한다(금액 대조보다 먼저:
  // 금액이 맞든 틀리든 카드로 빠져나간 돈은 돌려줘야 하고, 계좌 수단처럼 사람이 송금할 일이 아니라 PG 가 되돌린다)
  const classKind = asClassKind(known.class_kind);
  const approvedMethod = reported.method ?? asPaymentMethod(known.payment_method);
  if (!isPaymentMethodAllowed(classKind, approvedMethod)) {
    return cancelDisallowedApproval(deps, tx, {
      orderId: known.order_id,
      paymentId: known.payment_id,
      gatewayPaymentId,
      reportedAmount: reported.amount,
      approvedMethod,
      at,
    });
  }

  // 5. 세 금액 대조(FR-115) — 하나라도 다르면 확정하지 않는다. 들어온 돈은 전액 돌려줄 대상(FR-290(다른 금액 입금)).
  //    주문은 pending 그대로 둔다 — 상태를 새로 만들지 않고(계약 §6 5행), 기한이 지나면 만료 정리가 닫는다
  if (!(known.total_amount === known.amount && known.amount === reported.amount)) {
    await tx.execute(
      tx.raw.sql`UPDATE payments SET pg_reported_amount = ${reported.amount}, updated_at = ${at}::timestamptz WHERE id = ${known.payment_id}::uuid`
        .affectedCount()
        .build(),
    );
    await recordRefundDue(tx, {
      kind: "amount_mismatch",
      paymentId: known.payment_id,
      orderId: known.order_id,
      receivedAmount: reported.amount,
      transactionId: reported.transactionId ?? null,
    });
    return { result: "amount_mismatch", orderId: known.order_id, orderStatus: "pending" };
  }

  // 6. 확정
  const confirmed = await confirmOrder(tx, {
    orderId: known.order_id,
    paymentId: known.payment_id,
    reportedAmount: reported.amount,
    transactionId: reported.transactionId ?? "",
    paidAt: reported.paidAt?.toString() ?? at,
    at,
  });
  if (confirmed) return { result: "confirmed", orderId: known.order_id, orderStatus: "paid" };

  // 조건부 UPDATE 가 0행 — 같은 결제의 다른 웹훅(다른 webhook-id)이 먼저 확정했거나, 그사이 만료·취소됐다
  const status = await currentOrderStatus(tx, known.order_id);
  if (status === "expired" || status === "cancelled") {
    return recordClosedOrderDeposit(tx, {
      paymentId: known.payment_id,
      orderId: known.order_id,
      orderStatus: status,
      reportedAmount: reported.amount,
      transactionId: reported.transactionId ?? null,
      at,
    });
  }
  return { result: "ignored", orderId: known.order_id, orderStatus: status };
}

/** DB 의 글자를 상품 종류로 — CHECK 가 막지만, 모르는 값이면 판정하지 않고 되돌린다(아무 값이나 「허용 안 됨」으로 취소하지 않게) */
function asClassKind(value: string): ClassKind {
  if (!(CLASS_KINDS as readonly string[]).includes(value)) throw new WebhookConsistencyError(`모르는 상품 종류: ${value}`);
  return value as ClassKind;
}

function asPaymentMethod(value: string): PaymentMethod {
  if (!(PAYMENT_METHODS as readonly string[]).includes(value)) throw new WebhookConsistencyError(`모르는 결제수단: ${value}`);
  return value as PaymentMethod;
}

/**
 * S3-3.10(이벤트형 카드 승인 통지 전액 취소) — FR-111a(카드 허용 범위) 강제 방법 ③.
 * 순서: ① DB 먼저 — 주문 `pending → cancelled` · 결제 cancelled · 예약 cancelled · held −1(S3-3.8 의 닫기 전이를 그대로 쓴다)
 *       + PG 가 말한 금액 기록 ② 마지막에 PG 승인 전액 취소 1회.
 * PG 취소를 맨 뒤에 두는 이유: 취소가 실패(PG 장애)하면 던져서 ①까지 함께 롤백되고 500 — PG 가 웹훅을 다시 보내면 처음부터 다시 한다.
 * 닫기 조건부 UPDATE 가 0행이면(같은 결제의 다른 웹훅이 먼저 닫음) PG 를 부르지 않는다 — 그래서 취소는 한 번뿐이다.
 *
 * 값: 새 상태·새 CHECK 값을 만들지 않고 M-03(결제 실패)의 값(주문 cancelled · 예약 cancel_reason `payment_failed` ·
 * 웹훅 result `payment_failed`)을 쓴다. 구별은 order_events.reason 과 응답 본문 `cancelledApproval` 로 한다(추천안, 사후 확인).
 * 예외 기록(payment_exceptions)·환불 알림은 만들지 않는다 — 돈은 PG 가 바로 되돌리고, 예외 값 집합 조율은 S3-3.11·S8-1 몫.
 */
async function cancelDisallowedApproval(
  deps: PaymentWebhookDeps,
  tx: Tx,
  input: { orderId: string; paymentId: string; gatewayPaymentId: string; reportedAmount: number; approvedMethod: PaymentMethod; at: string },
): Promise<EventOutcome> {
  const { orderId, gatewayPaymentId, at } = input;
  const closed = await closeOrderOnPaymentFailure(tx, { orderId, gatewayPaymentId, at, orderEventReason: DISALLOWED_APPROVAL_REASON });
  if (!closed) return { result: "ignored", orderId, orderStatus: await currentOrderStatus(tx, orderId) };

  // 감사용 — PG 가 승인했다고 말한 금액을 남긴다(나중에 「얼마를 돌려줬나」를 맞춰 볼 근거)
  await tx.execute(
    tx.raw.sql`UPDATE payments SET pg_reported_amount = ${input.reportedAmount}, updated_at = ${at}::timestamptz
               WHERE id = ${input.paymentId}::uuid`
      .affectedCount()
      .build(),
  );

  // PG 승인 전액 취소 — 실패하면 던진다(위 DB 변경까지 롤백 → 500 → 재전송)
  await deps.paymentGateway.cancelPayment(gatewayPaymentId, DISALLOWED_APPROVAL_PG_REASON);

  return {
    result: "payment_failed",
    orderId,
    orderStatus: "cancelled",
    cancelledApproval: true,
    approvedMethod: input.approvedMethod,
    notice: DISALLOWED_APPROVAL_NOTICE,
  };
}

async function currentOrderStatus(tx: Tx, orderId: string): Promise<string | null> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT status FROM orders WHERE id = ${orderId}::uuid`.returnsRow({ status: "pg/text@1" }).build(),
  );
  return row?.status ?? null;
}

/**
 * 7번 — 닫힌 주문 입금(FR-292(만료 뒤 늦은 입금)). expired·cancelled 는 끝 상태라 주문·결제·예약·자리·캘린더·정산을 건드리지 않는다.
 * PG 가 말한 금액만 적고, order_events 에 사유 1행(상태 전이 아님), 돌려줄 대상 기록 + 알림 2건(S3-3.11).
 */
async function recordClosedOrderDeposit(
  tx: Tx,
  input: { paymentId: string; orderId: string; orderStatus: string; reportedAmount: number; transactionId: string | null; at: string },
): Promise<EventOutcome> {
  await tx.execute(
    tx.raw.sql`UPDATE payments SET pg_reported_amount = ${input.reportedAmount}, updated_at = ${input.at}::timestamptz
               WHERE id = ${input.paymentId}::uuid`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
               VALUES (uuidv7(), ${input.orderId}::uuid, ${input.orderStatus}, ${input.orderStatus}, ${CLOSED_DEPOSIT_REASON})`
      .affectedCount()
      .build(),
  );
  await recordRefundDue(tx, {
    kind: "deposit_on_closed_order",
    paymentId: input.paymentId,
    orderId: input.orderId,
    receivedAmount: input.reportedAmount,
    transactionId: input.transactionId,
  });
  return { result: "deposit_on_closed_order", orderId: input.orderId, orderStatus: input.orderStatus };
}

/**
 * S3-3.11 — 확정하지 않은 입금을 「돌려줄 돈」으로 남긴다(data-model §4.1 · 계약 03 §6 5·7행).
 * 기록은 payment_exceptions 에만 한다. refunds 는 확정 예약의 환불 원장(reservation_id 필수)이라 이 돈이 들어갈 자리가 아니다.
 *
 * 한 결제의 돈은 한 번만 돌려준다: 같은 결제에 예외 행이 **종류와 상관없이** 이미 있으면 새 행도 알림도 만들지 않는다.
 *   - 같은 통지가 다른 webhook-id 로 다시 와도(유니크 uq_payment_exceptions_payment_kind 가 같은 종류를 막는다)
 *   - 다른 금액으로 기록된 뒤 주문이 만료되고 같은 입금이 또 통지돼도(종류가 달라 유니크로는 못 막는다 — 그래서 NOT EXISTS)
 * 실제 송금은 1회차 범위 밖(운영자·대표 처리, SCH-29(PG 결제)).
 */
async function recordRefundDue(
  tx: Tx,
  input: { kind: PaymentExceptionKind; paymentId: string; orderId: string; receivedAmount: number; transactionId: string | null },
): Promise<void> {
  const [created] = await tx.query(
    tx.raw.sql`INSERT INTO payment_exceptions (id, payment_id, order_id, kind, received_amount, status, pg_transaction_id)
               SELECT uuidv7(), ${input.paymentId}::uuid, ${input.orderId}::uuid, ${input.kind}, ${input.receivedAmount}, 'refund_due',
                      NULLIF(${input.transactionId ?? ""}, '')
               WHERE NOT EXISTS (SELECT 1 FROM payment_exceptions WHERE payment_id = ${input.paymentId}::uuid)
               ON CONFLICT (payment_id, kind) DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  // 이미 돌려줄 대상으로 잡힌 돈 — 알림도 이미 나갔다
  if (created === undefined) return;
  await writeRefundDueNotifications(tx, input);
}

/**
 * 환불 대상 알림 2건(kind `payment_refund_due` — 회원·대표). 확정 알림과 같은 규칙으로 **행만 쓴다**(발송은 SCH-38(알림)).
 * 대표 몫은 확정 알림처럼 owner_member_id 가 있으면 그 회원, 없으면 대표 직원 계정마다 직원 알림함 행(칩 `settlement` —
 * spec 「결제 확인·다른 금액 입금·결제 실패는 정산」). 받는 사람이 없으면 order_events 에 사유를 남긴다.
 * payload 에는 수업 제목·입금액·주문액·사유만 — 회원 연락처·계좌번호는 넣지 않는다.
 */
async function writeRefundDueNotifications(
  tx: Tx,
  input: { kind: PaymentExceptionKind; orderId: string; receivedAmount: number },
): Promise<void> {
  const [info] = await tx.query(
    tx.raw.sql`SELECT o.member_id, o.status AS order_status, o.total_amount, c.title, c.academy_id, a.owner_member_id::text AS owner_member_id
               FROM orders o JOIN class_offerings f ON f.id = o.offering_id JOIN classes c ON c.id = f.class_id JOIN academies a ON a.id = c.academy_id
               WHERE o.id = ${input.orderId}::uuid`
      .returnsRow({
        member_id: "pg/uuid@1",
        order_status: "pg/text@1",
        total_amount: "pg/int4@1",
        title: "pg/text@1",
        academy_id: "pg/uuid@1",
        owner_member_id: "pg/text@1",
      })
      .build(),
  );
  if (info === undefined) throw new WebhookConsistencyError("주문의 수업을 찾지 못했습니다.");
  const payload = JSON.stringify({ title: info.title, reason: input.kind, receivedAmount: input.receivedAmount, orderAmount: info.total_amount });

  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, order_id, payload)
               VALUES (uuidv7(), ${info.member_id}::uuid, ${info.academy_id}::uuid, 'payment_refund_due', ${input.orderId}::uuid, ${payload}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );

  if (info.owner_member_id !== null && info.owner_member_id !== "") {
    await tx.execute(
      tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, order_id, payload)
                 VALUES (uuidv7(), ${info.owner_member_id}::uuid, ${info.academy_id}::uuid, 'payment_refund_due', ${input.orderId}::uuid, ${payload}::jsonb)
                 ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
    return;
  }
  const staffRows = await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, order_id, payload)
               SELECT uuidv7(), ao.staff_account_id, ${info.academy_id}::uuid, 'settlement', 'payment_refund_due',
                      'order:' || ${input.orderId} || ':refund_due:owner:' || ao.staff_account_id::text,
                      ${input.orderId}::uuid, ${payload}::jsonb
               FROM academy_owners ao WHERE ao.academy_id = ${info.academy_id}::uuid
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
  if (staffRows.affectedRows === 0) {
    await tx.execute(
      tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
                 VALUES (uuidv7(), ${input.orderId}::uuid, ${info.order_status}, ${info.order_status}, ${OWNER_MISSING_REASON})`
        .affectedCount()
        .build(),
    );
  }
}

/** 정합성이 깨졌을 때 던지는 오류 — 트랜잭션 전체를 되돌리고 500 이 된다 */
class WebhookConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConsistencyError";
  }
}

/** 0원 주문을 바로 확정할 때 order_events 에 남기는 사유(S3-3.12) — 「입금 확인」과 구별해 돈이 오가지 않았음을 남긴다 */
export const FREE_ORDER_CONFIRMED_REASON = "0원 바로 확정";

/**
 * 6번 확정 트랜잭션 본체(data-model §4-1 · FR-289(확정 후 일괄 처리)). 주문을 이겼으면 true.
 * 주문 전이를 맨 앞에 둔다 — 이 조건부 UPDATE 가 「한 결제는 한 번만 확정」의 잠금이다. 뒤의 행들은 이긴 쪽만 쓴다.
 *
 * S3-3.12(0원 주문)도 같은 함수를 부른다(주문 생성 트랜잭션 안에서) — 확정 뒤 일괄 처리(예약·자리·캘린더·알림)가 웹훅과
 * 갈리지 않게 하려는 것이다. 그때는 PG 가 말한 금액이 없으므로 `reportedAmount` 를 null 로 넘겨 pg_reported_amount 를 비워 두고,
 * 사유는 `FREE_ORDER_CONFIRMED_REASON` 이다. 금액이 0원이면 정산 보류 행을 쓰지 않는다(data-model 정산 ⑧ 「무료 수업 0원 줄은
 * 원장에 안 쓰고 조회가 예약에서 만든다」).
 */
export async function confirmOrder(
  tx: Tx,
  input: {
    orderId: string;
    paymentId: string;
    reportedAmount: number | null;
    transactionId: string;
    paidAt: string;
    at: string;
    reason?: string;
  },
): Promise<boolean> {
  const { orderId, at } = input;
  // pg_reported_amount 에 넣을 값 — PG 가 말한 금액이 없으면(0원 확정) -1 을 넘겨 SQL 의 NULLIF 가 NULL 로 바꾼다(금액은 0 이상이라 겹치지 않는다)
  const reportedOrMinusOne = input.reportedAmount ?? -1;

  const [order] = await tx.query(
    tx.raw.sql`UPDATE orders SET status = 'paid', paid_at = ${input.paidAt}::timestamptz, updated_at = ${at}::timestamptz
               WHERE id = ${orderId}::uuid AND status = 'pending'
               RETURNING member_id, offering_id, total_amount`
      .returnsRow({ member_id: "pg/uuid@1", offering_id: "pg/uuid@1", total_amount: "pg/int4@1" })
      .build(),
  );
  if (order === undefined) return false;

  await tx.execute(
    tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
               VALUES (uuidv7(), ${orderId}::uuid, 'pending', 'paid', ${input.reason ?? CONFIRMED_REASON})`
      .affectedCount()
      .build(),
  );

  // 결제 ready → paid. PG 거래 번호는 gateway_payment_key 칸에 남긴다(환불 때 원거래를 찾는 열쇠)
  const paidPayments = await tx.execute(
    tx.raw.sql`UPDATE payments SET status = 'paid', paid_at = ${input.paidAt}::timestamptz, pg_reported_amount = NULLIF(${reportedOrMinusOne}, -1),
                                   gateway_payment_key = COALESCE(NULLIF(${input.transactionId}, ''), gateway_payment_key),
                                   updated_at = ${at}::timestamptz
               WHERE id = ${input.paymentId}::uuid AND status = 'ready'`
      .affectedCount()
      .build(),
  );
  if (paidPayments.affectedRows !== 1) throw new WebhookConsistencyError("확정할 결제가 ready 가 아닙니다.");

  // 예약 held → confirmed
  const reservations = await tx.query(
    tx.raw.sql`UPDATE reservations SET status = 'confirmed', updated_at = ${at}::timestamptz
               WHERE order_id = ${orderId}::uuid AND status = 'held'
               RETURNING id, seat_pool_id, seat_kind`
      .returnsRow({ id: "pg/uuid@1", seat_pool_id: "pg/uuid@1", seat_kind: "pg/text@1" })
      .build(),
  );
  if (reservations.length === 0) throw new WebhookConsistencyError("확정할 예약(held)이 없습니다.");

  // 자리 묶음 held −1 · confirmed +1 — 0행이면 카운터가 어긋난 것이라 전체를 되돌린다(data-model §4-4 「확정」 행)
  for (const reservation of reservations) {
    const moved = await tx.execute(
      tx.raw.sql`UPDATE seat_pools SET held_count = held_count - 1, confirmed_count = confirmed_count + 1, updated_at = ${at}::timestamptz
                 WHERE id = ${reservation.seat_pool_id}::uuid AND held_count > 0`
        .affectedCount()
        .build(),
    );
    if (moved.affectedRows !== 1) throw new WebhookConsistencyError("자리 묶음 카운터가 맞지 않습니다.");

    // 캘린더 — 예정(scheduled) 회차마다 1행. 제목은 수업 제목 사본. 같은 회원·같은 회차는 한 번만(uq_calendar_member_session)
    await tx.execute(
      tx.raw.sql`INSERT INTO calendar_entries (id, member_id, reservation_id, session_id, starts_at, ends_at, title)
                 SELECT uuidv7(), ${order.member_id}::uuid, ${reservation.id}::uuid, s.id, s.starts_at, s.ends_at, c.title
                 FROM class_sessions s
                 JOIN class_offerings f ON f.id = s.offering_id
                 JOIN classes c ON c.id = f.class_id
                 WHERE s.offering_id = ${order.offering_id}::uuid AND s.status = 'scheduled'
                 ON CONFLICT (member_id, session_id) DO NOTHING`
        .affectedCount()
        .build(),
    );
  }

  await writeConfirmationNotifications(tx, {
    orderId,
    memberId: order.member_id,
    offeringId: order.offering_id,
    reservationId: reservations[0]!.id,
    seatKind: reservations[0]!.seat_kind,
    amount: order.total_amount,
  });

  // 0원 주문은 정산 원장에 쓰지 않는다 — 받은 돈이 없다(S3-3.12 · data-model 정산 ⑧)
  if (order.total_amount === 0) return true;

  // 정산 보류 1건(Q5(정산 보류 적립 포함 여부) 확정) — 금액은 회원이 낸 돈 전부. 나누기·수수료는 SCH-31(정산 원장)
  await tx.execute(
    tx.raw.sql`INSERT INTO settlement_entries (id, order_id, academy_id, kind, amount, status)
               SELECT uuidv7(), ${orderId}::uuid, c.academy_id, 'payment_hold', ${order.total_amount}, 'hold'
               FROM class_offerings f JOIN classes c ON c.id = f.class_id
               WHERE f.id = ${order.offering_id}::uuid
               ON CONFLICT (order_id, kind) DO NOTHING`
      .affectedCount()
      .build(),
  );
  return true;
}

/**
 * 확정 알림 2건(계약 04 §3 · FR-114(결제 확인 앱 알림)) — **행만 쓴다.** delivery_status 는 기본값 pending 으로 남고,
 * 실제 발송은 SCH-38(알림)이 이 행을 읽어 한다. payload 에 회원 연락처·계좌번호를 넣지 않는다.
 *
 * 대표 알림 받는 사람: 계약 04 §3 대로 `academies.owner_member_id` 가 있으면 그 회원. 없으면 그 학원의 대표 직원 계정
 * (`academy_owners`)마다 직원 알림함 행을 만든다 — 대표 가입이 직원 계정으로 바뀐 뒤(S1-4.2 직원 알림함) owner_member_id 가
 * 비어 있는 학원이 대부분이라서다. 둘 다 없으면 만들지 않고 order_events 에 사유를 남긴다.
 */
async function writeConfirmationNotifications(
  tx: Tx,
  input: { orderId: string; memberId: string; offeringId: string; reservationId: string; seatKind: string; amount: number },
): Promise<void> {
  const [info] = await tx.query(
    tx.raw.sql`SELECT c.title, c.academy_id, a.owner_member_id::text AS owner_member_id,
                      to_char(f.first_session_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_starts_at
               FROM class_offerings f JOIN classes c ON c.id = f.class_id JOIN academies a ON a.id = c.academy_id
               WHERE f.id = ${input.offeringId}::uuid`
      .returnsRow({ title: "pg/text@1", academy_id: "pg/uuid@1", owner_member_id: "pg/text@1", first_starts_at: "pg/text@1" })
      .build(),
  );
  if (info === undefined) throw new WebhookConsistencyError("주문의 수업을 찾지 못했습니다.");

  // 회원 알림 — 수업 제목·금액·첫 회차 시각
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, order_id, reservation_id, payload)
               VALUES (uuidv7(), ${input.memberId}::uuid, ${info.academy_id}::uuid, 'payment_confirmed_member', ${input.orderId}::uuid,
                       ${input.reservationId}::uuid,
                       ${JSON.stringify({ title: info.title, amount: input.amount, firstSessionStartsAt: info.first_starts_at })}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );

  // 대표 알림 — 수업 제목·금액·자리 종류(회원 연락처 없음)
  const ownerPayload = JSON.stringify({ title: info.title, amount: input.amount, seatKind: input.seatKind });
  if (info.owner_member_id !== null && info.owner_member_id !== "") {
    await tx.execute(
      tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, order_id, reservation_id, payload)
                 VALUES (uuidv7(), ${info.owner_member_id}::uuid, ${info.academy_id}::uuid, 'payment_confirmed_owner', ${input.orderId}::uuid,
                         ${input.reservationId}::uuid, ${ownerPayload}::jsonb)
                 ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
    return;
  }
  // 직원 계정 대표 — 회원 칸이 비어 (kind, order_id, recipient_member_id) 유니크가 듣지 않으므로 dedupe_key 로 한 번만 넣는다
  const staffRows = await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, order_id, reservation_id, payload)
               SELECT uuidv7(), ao.staff_account_id, ${info.academy_id}::uuid, 'signup_close', 'payment_confirmed_owner',
                      'order:' || ${input.orderId} || ':owner:' || ao.staff_account_id::text,
                      ${input.orderId}::uuid, ${input.reservationId}::uuid, ${ownerPayload}::jsonb
               FROM academy_owners ao WHERE ao.academy_id = ${info.academy_id}::uuid
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
  if (staffRows.affectedRows === 0) {
    await tx.execute(
      tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
                 VALUES (uuidv7(), ${input.orderId}::uuid, 'paid', 'paid', ${OWNER_MISSING_REASON})`
        .affectedCount()
        .build(),
    );
  }
}

/**
 * 라우트 처리기를 만든다. 세션을 보지 않는다 — 웹훅은 PG 가 보내므로 로그인이 없고, 서명이 곧 인증이다(계약 03 §6).
 * 본문은 `request.text()` 로 **원문 그대로** 읽는다. `request.json()` 을 먼저 부르면 서명을 검증할 바이트를 잃는다.
 * 처리 중 예상 못 한 오류(PG 장애·DB 오류)는 withRoute 가 500 `INTERNAL` 로 바꾼다 — 트랜잭션은 이미 롤백됐고 PG 가 다시 보낸다.
 */
export function createPaymentWebhookRoute(deps: PaymentWebhookDeps) {
  return withRoute(async (request: Request) => {
    const rawBody = await request.text();
    const result = await processPaymentWebhook(deps, { headers: request.headers, rawBody });
    return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  });
}
