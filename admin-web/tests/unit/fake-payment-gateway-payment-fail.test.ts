// S3-3.15b(결제 화면용 서버 조각) ③ 가짜 PG 결제 실패 조작 — DB 불필요.
//   계약: _workspace/03_contracts/03-checkout-payment.md §7(시험 전용 경로 표의 `…/fail` 행) · §8 M-03(카드 승인 실패)
//
// 확인하는 것
//   ① 가짜 PG 원장: 결제창을 연(ready) 결제만 failed 가 되고, 그 결제에서만 `Transaction.Failed` 본문을 만든다
//   ② dev `fail` 처리기: 원장에 실패를 적고 → 서명한 실패 웹훅을 처리기에 넘기고 → 처리 결과에 webhookId 를 붙여 돌려준다
//   ③ 끝난 결제(입금·취소·실패)에는 409 PAYMENT_NOT_FAILABLE, 모르는 번호 404 — 이때 웹훅을 보내지 않는다
//   ④ 운영 설정(`KDANCE_DEV_ROUTES` 가 "true" 아님)이면 처리기를 부르지도 않고 404, PG 가 가짜가 아니어도 404
import "temporal-polyfill/full/global";

import { describe, expect, test, vi } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { DEV_ROUTES_ENV, withDevRoute } from "../../lib/server/dev-routes";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "../../lib/server/fakes/hmac-webhook-verifier";
import { PaymentGatewayError, type CreatePaymentRequest } from "../../lib/server/ports/payment-gateway";
import { createDevFakePgHandlers, type DevFakePgDeps } from "../../lib/server/services/dev-fake-pg";
import type { PaymentWebhookResult } from "../../lib/server/services/payment-webhook";

const NOW = Temporal.Instant.from("2026-11-23T03:00:00Z");
const SECRET = "whsec-unit-test-secret-0123456789";
const OPEN = { [DEV_ROUTES_ENV]: "true" } as const;

function makeGateway() {
  return new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(NOW) });
}

function cardRequest(gatewayPaymentId: string): CreatePaymentRequest {
  return { gatewayPaymentId, method: "card", amount: 120_000, dueAt: NOW.add({ minutes: 15 }), orderName: "쌈바 정규 · 12월" };
}

/** dev fail 경로를 앱과 같은 모양(withDevRoute 감싸기)으로 만든다. processWebhook 은 받은 헤더·본문을 기록하는 가짜 */
function makeRoute(gateway: FakePaymentGateway | null, env: Record<string, string | undefined> = OPEN) {
  const received: { headers: Headers; rawBody: string }[] = [];
  const processWebhook = vi.fn(async (input: { headers: Headers; rawBody: string }): Promise<PaymentWebhookResult> => {
    received.push(input);
    return { status: 200, body: { result: "payment_failed", orderId: "o-1", orderStatus: "cancelled" } } as PaymentWebhookResult;
  });
  const deps: DevFakePgDeps = {
    gateway: () => gateway,
    sign: (input) => signWebhook({ secret: SECRET, ...input }),
    clock: fixedClock(NOW),
    processWebhook,
    ledger: { sent: new Map() },
  };
  const route = withDevRoute(createDevFakePgHandlers(deps).fail, env);
  const call = async (gatewayPaymentId: string) => {
    const res = await route(new Request(`http://localhost/api/dev/fake-pg/payments/${gatewayPaymentId}/fail`, { method: "POST" }), {
      params: Promise.resolve({ gatewayPaymentId }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, processWebhook, received };
}

describe("① 가짜 PG 원장 — 승인 실패 기록과 실패 웹훅 본문", () => {
  test("ready 결제를 failApproval 하면 PG 조회가 failed, 실패 웹훅 본문은 Transaction.Failed + 결제 번호(거래 번호 없음)", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_a"));
    gateway.failApproval("pay_a");

    expect((await gateway.getPayment("pay_a")).status).toBe("failed");
    expect(gateway.buildFailedWebhookBody("pay_a")).toEqual({
      type: "Transaction.Failed",
      timestamp: NOW.toString(),
      data: { paymentId: "pay_a" },
    });
  });

  test("실패하지 않은 결제(ready·paid)의 실패 웹훅은 만들지 않는다 — 있지도 않은 실패를 지어내지 않는다", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_ready"));
    expect(() => gateway.buildFailedWebhookBody("pay_ready")).toThrow(PaymentGatewayError);

    await gateway.createPayment(cardRequest("pay_paid"));
    gateway.deposit("pay_paid", 120_000);
    gateway.failApproval("pay_paid"); // 입금된 결제는 그대로 둔다
    expect((await gateway.getPayment("pay_paid")).status).toBe("paid");
    expect(() => gateway.buildFailedWebhookBody("pay_paid")).toThrow(PaymentGatewayError);
  });
});

describe("② dev fail 처리기 — 원장 기록 → 서명한 실패 웹훅 → 처리 결과", () => {
  test("200 처리 결과 + webhookId, 처리기에 넘긴 웹훅은 진짜 검증기로 서명이 맞고 본문은 Transaction.Failed", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_b"));
    const { call, received } = makeRoute(gateway);

    const res = await call("pay_b");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "payment_failed", orderStatus: "cancelled" });
    expect(String(res.body["webhookId"])).toMatch(/^wh_dev_/);
    expect((await gateway.getPayment("pay_b")).status).toBe("failed");

    expect(received).toHaveLength(1);
    const [hook] = received;
    expect(JSON.parse(hook!.rawBody)).toEqual({ type: "Transaction.Failed", timestamp: NOW.toString(), data: { paymentId: "pay_b" } });
    expect(new HmacWebhookVerifier({ secret: SECRET }).verify(hook!.headers, hook!.rawBody, NOW)).toBe(true);
    expect(hook!.headers.get("webhook-id")).toBe(res.body["webhookId"]);
  });
});

describe("③ 끝난 결제·모르는 번호 — 웹훅을 보내지 않는다", () => {
  test("이미 실패한 결제를 다시 fail 하면 409 PAYMENT_NOT_FAILABLE", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_c"));
    const { call, processWebhook } = makeRoute(gateway);
    expect((await call("pay_c")).status).toBe(200);

    const again = await call("pay_c");
    expect(again.status).toBe(409);
    expect(again.body["code"]).toBe("PAYMENT_NOT_FAILABLE");
    expect(processWebhook).toHaveBeenCalledTimes(1);
  });

  test("입금된 결제·취소된 결제도 409, 원장 상태는 바뀌지 않는다", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_paid"));
    gateway.deposit("pay_paid", 120_000);
    await gateway.createPayment(cardRequest("pay_cancelled"));
    await gateway.cancelPayment("pay_cancelled", "회원 셀프 취소");
    const { call, processWebhook } = makeRoute(gateway);

    expect((await call("pay_paid")).body["code"]).toBe("PAYMENT_NOT_FAILABLE");
    expect((await call("pay_cancelled")).status).toBe(409);
    expect((await gateway.getPayment("pay_paid")).status).toBe("paid");
    expect((await gateway.getPayment("pay_cancelled")).status).toBe("cancelled");
    expect(processWebhook).not.toHaveBeenCalled();
  });

  test("모르는 결제 번호는 404", async () => {
    const { call, processWebhook } = makeRoute(makeGateway());
    const res = await call("pay_nobody");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "찾을 수 없어요", code: "NOT_FOUND" });
    expect(processWebhook).not.toHaveBeenCalled();
  });
});

describe("④ 운영에서는 꺼진다(2026-11-23 사용자 결정 — KDANCE_DEV_ROUTES=true 일 때만)", () => {
  test.each([{ [DEV_ROUTES_ENV]: "false" }, {}, { [DEV_ROUTES_ENV]: "TRUE" }])("설정 %j 이면 404, 원장·웹훅 모두 손대지 않는다", async (env) => {
    const gateway = makeGateway();
    await gateway.createPayment(cardRequest("pay_d"));
    const { call, processWebhook } = makeRoute(gateway, env);

    const res = await call("pay_d");

    expect(res.status).toBe(404);
    expect((await gateway.getPayment("pay_d")).status).toBe("ready");
    expect(processWebhook).not.toHaveBeenCalled();
  });

  test("열려 있어도 PG 가 가짜가 아니면(gateway() 가 null) 404", async () => {
    const { call, processWebhook } = makeRoute(null);
    expect((await call("pay_e")).status).toBe(404);
    expect(processWebhook).not.toHaveBeenCalled();
  });
});
