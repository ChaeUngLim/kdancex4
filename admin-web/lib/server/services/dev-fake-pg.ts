// S3-3.14(가짜 PG dev 경로) — 계약 03-checkout-payment.md §7 「시험 전용 — 가짜 PG 조작」
//   `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/deposit` `{ amount }` — 가짜 PG 원장에 입금을 기록하고,
//       서명된 웹훅을 만들어 §6 처리기를 **직접 호출**한다(HTTP 왕복 없음). 응답 = 웹훅 처리 결과
//   `POST /api/dev/fake-pg/webhooks/replay` `{ webhookId }` — 같은 웹훅을 한 번 더 보낸다(중복 시험)
//   `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/fail` — (S3-3.15b, 계약 03 §7·§8) 카드·간편결제 결제창의 승인 실패를
//       가짜 PG 원장에 적고, `Transaction.Failed` 웹훅을 같은 방식으로 처리기에 넘긴다. 앱 결제 실패 화면(X2)을 실제 흐름으로
//       보려고 만든 문이다. 운영에서는 아래 두 겹 차단이 그대로 걸린다(2026-11-23 사용자 결정 — `KDANCE_DEV_ROUTES=true` 일 때만)
//
// 무엇을 하나: 실제 PG 가 없는 개발 환경에서 「회원이 입금했다」를 흉내 낸다. 앱 화면으로 결제 흐름 끝까지
// (주문 → 입금 → 확정) 가 보려면 누군가 PG 대신 웹훅을 보내 줘야 하는데, 그 일을 이 경로가 한다.
//
// 왜 처리기를 「직접」 부르나: 웹훅 경로(`/api/payments/webhook`)에 HTTP 로 다시 보내면 서버 주소·포트를 알아야 하고
// 요청이 하나 더 생긴다. 대신 진짜 웹훅과 **같은 서명 헤더·같은 원문 바이트**를 만들어 같은 처리 함수에 넘긴다.
// 그래서 서명 검증·중복 판정·금액 대조가 운영과 똑같이 돈다 — 이 경로가 확정 규칙을 건너뛰는 뒷문이 되지 않는다.
//
// 왜 dev 전용인가: 누구나 「입금됐다」를 만들 수 있는 문이다. 운영에서 열리면 돈을 안 내고 예약이 확정된다. 그래서
//   1. route.ts 가 `withDevRoute` 로 감싸 `KDANCE_DEV_ROUTES=true` 가 아니면 처리기를 부르지도 않고 404 (S0-4.2(dev 전용 경로 차단))
//   2. PG 구현이 가짜가 아니면(실 PG 가 붙은 뒤) 열려 있어도 404 — 실 PG 원장은 흉내 낼 수 없다
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Clock } from "../../domain/time";
import { PaymentGatewayError, PaymentNotFoundError } from "../ports/payment-gateway";
import { HttpError, parseJsonBody } from "../http";
import type { PaymentWebhookResult } from "./payment-webhook";

/** 가짜 PG 에서 이 경로가 쓰는 조작만 — FakePaymentGateway 와 같은 모양(서비스는 fakes 를 직접 import 하지 않는다) */
export interface DevFakePgGateway {
  deposit(gatewayPaymentId: string, amount: number): { transactionId: string; paidAt: Temporal.Instant };
  buildPaidWebhookBody(gatewayPaymentId: string): unknown;
  /** S3-3.15b — 결제창을 연(ready) 결제의 승인을 실패로 적는다. 다른 상태면 아무것도 바꾸지 않는다 */
  failApproval(gatewayPaymentId: string): void;
  /** 원장의 지금 상태(포트의 getPayment) — fail 조작이 「결제창을 연(ready) 결제인가」를 먼저 본다. 모르는 번호면 PaymentNotFoundError */
  getPayment(gatewayPaymentId: string): Promise<{ status: string }>;
  /** S3-3.15b — 원장이 failed 인 결제의 `Transaction.Failed` 본문. failed 가 아니면 PaymentGatewayError */
  buildFailedWebhookBody(gatewayPaymentId: string): unknown;
}

/** 보낸 웹훅 한 건 — 재전송 때 같은 id·같은 원문을 다시 쓴다 */
interface SentWebhook {
  readonly webhookId: string;
  readonly rawBody: string;
}

/** 보낸 웹훅 기록. 메모리에만 있다 — 권위 있는 기록은 DB 의 payment_webhook_events 다 */
export interface DevWebhookLedger {
  readonly sent: Map<string, SentWebhook>;
}

export function createDevWebhookLedger(): DevWebhookLedger {
  return { sent: new Map() };
}

const GLOBAL_LEDGER_KEY = Symbol.for("kdance.devFakePg.webhookLedger");

/** 개발 서버 재적재에도 남는 기본 기록(가짜 PG 원장과 같은 방식) */
function globalLedger(): DevWebhookLedger {
  const holder = globalThis as typeof globalThis & { [GLOBAL_LEDGER_KEY]?: DevWebhookLedger };
  holder[GLOBAL_LEDGER_KEY] ??= createDevWebhookLedger();
  return holder[GLOBAL_LEDGER_KEY];
}

/** 기록을 끝없이 키우지 않는다 — 넘치면 가장 오래된 것부터 버린다(재전송 시험은 방금 보낸 웹훅이면 충분하다) */
const MAX_SENT_WEBHOOKS = 500;

export interface DevFakePgDeps {
  /** 요청 때 가짜 PG 를 꺼낸다. 가짜가 아니면 null — 그때는 404 */
  gateway: () => DevFakePgGateway | null;
  /** 웹훅 헤더 3개 서명. 웹훅 검증기와 같은 비밀값(PG_WEBHOOK_SECRET)을 쓴다 — deps.ts getDevWebhookSigner */
  sign: (input: { webhookId: string; timestampSeconds: number; rawBody: string }) => Record<string, string>;
  clock: Clock;
  /** §6 웹훅 처리 함수. 앱 경로에서는 processPaymentWebhook 에 진짜 웹훅과 같은 재료(paymentWebhookRouteDeps)를 넣은 것 */
  processWebhook: (input: { headers: Headers; rawBody: string }) => Promise<PaymentWebhookResult>;
  /** 생략하면 globalThis 기록 */
  ledger?: DevWebhookLedger;
}

/** 가짜 PG 결제 번호 — payments.gateway_payment_id 와 같은 길이 제한(웹훅 본문 스키마 max 64) */
const gatewayPaymentIdSchema = z.string().min(1).max(64);

/** 계약 03 §7 입금 요청. 금액은 원 단위 양의 정수. 모르는 칸은 받지 않는다 */
export const fakePgDepositRequestSchema = z.strictObject({
  amount: z.number().int().positive().max(100_000_000),
});

/** 계약 03 §7 재전송 요청 */
export const fakePgReplayRequestSchema = z.strictObject({
  webhookId: z.string().min(1).max(200),
});

// 404 문구는 withDevRoute 와 같게 둔다 — 「PG 가 가짜가 아니라서」 닫혔다는 사실도 새지 않게
const NOT_FOUND_DETAIL = "찾을 수 없어요";

export type DepositParams = { params: Promise<{ gatewayPaymentId: string }> };

/**
 * dev 경로 두 개의 처리기를 만든다. dev 경로 차단(withDevRoute)은 route.ts 가 감싼다 — 오류(HttpError)를
 * 계약 모양 응답으로 바꾸는 것도 withDevRoute 안의 withRoute 가 한다.
 * 응답은 웹훅 처리 결과(상태·본문 그대로)에 `webhookId` 를 더한 것 — 재전송 경로에 그 id 를 넣으면 된다.
 */
export function createDevFakePgHandlers(deps: DevFakePgDeps) {
  const ledger = deps.ledger ?? globalLedger();

  /** 서명한 웹훅 한 건을 §6 처리기에 넘긴다. 서명 시각은 지금 — 재전송도 새 시각으로 서명해야 5분 허용 오차를 넘지 않는다 */
  async function send(webhook: SentWebhook): Promise<Response> {
    const timestampSeconds = Math.floor(deps.clock().epochMilliseconds / 1000);
    const headers = new Headers({
      ...deps.sign({ webhookId: webhook.webhookId, timestampSeconds, rawBody: webhook.rawBody }),
      "content-type": "application/json",
    });
    const result = await deps.processWebhook({ headers, rawBody: webhook.rawBody });
    return Response.json({ ...result.body, webhookId: webhook.webhookId }, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }

  function remember(webhook: SentWebhook): void {
    ledger.sent.set(webhook.webhookId, webhook);
    if (ledger.sent.size > MAX_SENT_WEBHOOKS) {
      const oldest = ledger.sent.keys().next().value;
      if (oldest !== undefined) ledger.sent.delete(oldest);
    }
  }

  function requireGateway(): DevFakePgGateway {
    const gateway = deps.gateway();
    if (gateway === null) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    return gateway;
  }

  const deposit = async (request: Request, context: DepositParams): Promise<Response> => {
    const gateway = requireGateway();
    const parsedId = gatewayPaymentIdSchema.safeParse((await context.params).gatewayPaymentId);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    const gatewayPaymentId = parsedId.data;
    const input = await parseJsonBody(request, fakePgDepositRequestSchema);

    // 1. 가짜 PG 원장에 입금을 적는다. 웹훅 처리기는 본문 금액을 믿지 않고 이 원장을 다시 조회한다(§6 4번)
    try {
      gateway.deposit(gatewayPaymentId, input.amount);
    } catch (error: unknown) {
      if (error instanceof PaymentNotFoundError) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
      // 같은 결제에 두 번 입금 — 같은 웹훅을 다시 보내려면 재전송 경로를 쓴다
      if (error instanceof PaymentGatewayError) throw HttpError.conflict("ALREADY_DEPOSITED", "이미 입금된 결제예요. 같은 웹훅은 재전송 경로로 보내 주세요");
      throw error;
    }

    // 2. 진짜 PG 가 보낼 모양의 본문(Transaction.Paid)과 새 webhook-id 로 웹훅을 만들어 보낸다
    const webhook: SentWebhook = { webhookId: `wh_dev_${randomUUID()}`, rawBody: JSON.stringify(gateway.buildPaidWebhookBody(gatewayPaymentId)) };
    remember(webhook);
    return send(webhook);
  };

  const replay = async (request: Request): Promise<Response> => {
    requireGateway();
    const input = await parseJsonBody(request, fakePgReplayRequestSchema);
    const webhook = ledger.sent.get(input.webhookId);
    if (webhook === undefined) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    // 같은 id·같은 원문 그대로 — §6 2번(webhook-id 유니크)이 duplicate 로 받아야 한다
    return send(webhook);
  };

  /**
   * 승인 실패 조작(S3-3.15b). 본문은 받지 않는다. 순서는 입금과 같다 — 원장에 먼저 적고, 그 원장을 근거로 웹훅을 만든다.
   * 결제창을 연(ready) 결제가 아니면(이미 입금·취소·만료·실패) 실패를 지어내지 않고 409 PAYMENT_NOT_FAILABLE 로 답한다.
   * 웹훅 처리기는 본문을 믿지 않고 PG 를 다시 조회하므로(§6 4번) 여기서 원장을 바꾸지 않으면 주문도 바뀌지 않는다.
   */
  const fail = async (_request: Request, context: DepositParams): Promise<Response> => {
    const gateway = requireGateway();
    const parsedId = gatewayPaymentIdSchema.safeParse((await context.params).gatewayPaymentId);
    if (!parsedId.success) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    const gatewayPaymentId = parsedId.data;

    let rawBody: string;
    try {
      // 이미 실패·입금·취소·만료된 결제는 다시 실패시키지 않는다 — 같은 실패 웹훅을 다시 보내려면 재전송 경로를 쓴다
      const current = await gateway.getPayment(gatewayPaymentId);
      if (current.status !== "ready") throw new PaymentGatewayError("결제창을 연 결제가 아니다");
      gateway.failApproval(gatewayPaymentId);
      rawBody = JSON.stringify(gateway.buildFailedWebhookBody(gatewayPaymentId));
    } catch (error: unknown) {
      if (error instanceof PaymentNotFoundError) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
      if (error instanceof PaymentGatewayError) {
        throw HttpError.conflict("PAYMENT_NOT_FAILABLE", "결제창을 연 결제만 실패로 바꿀 수 있어요(이미 입금·취소·만료·실패한 결제예요)");
      }
      throw error;
    }

    const webhook: SentWebhook = { webhookId: `wh_dev_${randomUUID()}`, rawBody };
    remember(webhook);
    return send(webhook);
  };

  return { deposit, replay, fail };
}
