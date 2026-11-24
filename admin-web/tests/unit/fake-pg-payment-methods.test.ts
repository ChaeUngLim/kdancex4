// S3-3.3(가짜 PG 수단 2종 더하기) 단위 테스트 — DB 불필요.
//
// 가짜 PG 가 결제수단 4종(카드·간편결제·간편 계좌이체·가상계좌, FR-280(결제수단 결정))을 모두
// 발급·조회·취소할 수 있는지 본다. 포트(`PaymentGatewayPort`)는 그대로 두고 가짜 구현만 넓혔다.
//
// 응답 모양 규칙(포트원 V2 기준 — 계약 17 §3-1):
// - 가상계좌만 서버가 계좌를 바로 돌려준다(`virtualAccount`).
// - 카드·간편결제·간편 계좌이체는 셋 다 포트원 결제창(SDK `requestPayment`)으로 결제한다.
//   그래서 가짜도 셋 다 「결제창 키」(`cardCheckoutKey`)만 돌려준다. 포트 칸 이름은 그대로 둔다.
import "temporal-polyfill/full/global";

import { describe, expect, test } from "vitest";

import { PAYMENT_METHODS, type PaymentMethod } from "../../lib/domain/constants";
import { fixedClock } from "../../lib/domain/time";
import {
  FakePaymentGateway,
  createFakePaymentGatewayStore,
} from "../../lib/server/fakes/fake-payment-gateway";
import { PaymentGatewayError, type CreatePaymentRequest } from "../../lib/server/ports/payment-gateway";

const NOW = Temporal.Instant.from("2026-11-23T03:00:00Z");
const dueAt = NOW.add({ minutes: 15 });

function makeGateway() {
  return new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(NOW) });
}

function request(method: PaymentMethod, gatewayPaymentId = `gp_${method}`): CreatePaymentRequest {
  return { gatewayPaymentId, method, amount: 33_000, dueAt, orderName: "바차타 원데이" };
}

/** 결제창으로 결제하는 수단 3종 */
const CHECKOUT_METHODS = ["card", "easy_pay", "easy_transfer"] as const satisfies readonly PaymentMethod[];

describe("수단 4종 발급", () => {
  test("값 집합은 4종이고 이 테스트가 전부 덮는다", () => {
    expect([...PAYMENT_METHODS].sort()).toEqual(["card", "easy_pay", "easy_transfer", "virtual_account"]);
  });

  test("가상계좌는 계좌만 주고 결제창 키는 없다", async () => {
    const created = await makeGateway().createPayment(request("virtual_account"));
    expect(created.status).toBe("ready");
    expect(created.virtualAccount).toMatchObject({ bankCode: "SHINHAN" });
    expect(created.virtualAccount?.accountNumber).toMatch(/^\d{14}$/);
    expect(created.cardCheckoutKey).toBeUndefined();
  });

  test.each(CHECKOUT_METHODS)("%s 는 결제창 키만 주고 가상계좌는 없다", async (method) => {
    const created = await makeGateway().createPayment(request(method));
    expect(created.status).toBe("ready");
    expect(created.cardCheckoutKey).toMatch(/^checkout_/);
    expect(created.virtualAccount).toBeUndefined();
  });

  test("간편결제·간편 계좌이체 결제창 키는 수단별 머리말로 구별된다", async () => {
    const gateway = makeGateway();
    const pay = await gateway.createPayment(request("easy_pay", "gp_1"));
    const transfer = await gateway.createPayment(request("easy_transfer", "gp_2"));
    expect(pay.cardCheckoutKey).toMatch(/^checkout_easypay_[0-9a-f]{24}$/);
    expect(transfer.cardCheckoutKey).toMatch(/^checkout_transfer_[0-9a-f]{24}$/);
  });

  test("카드 결제창 키 모양은 예전 그대로다(기존 주문 흐름을 깨지 않는다)", async () => {
    const created = await makeGateway().createPayment(request("card"));
    expect(created.cardCheckoutKey).toMatch(/^checkout_[0-9a-f]{24}$/);
  });

  test.each(PAYMENT_METHODS)("%s 같은 요청 재전송은 같은 결과(멱등)", async (method) => {
    const gateway = makeGateway();
    const first = await gateway.createPayment(request(method));
    expect(await gateway.createPayment(request(method))).toEqual(first);
  });

  test("같은 결제 번호를 다른 수단으로 다시 발급하면 거부한다", async () => {
    const gateway = makeGateway();
    await gateway.createPayment(request("easy_transfer", "gp_same"));
    await expect(gateway.createPayment(request("easy_pay", "gp_same"))).rejects.toBeInstanceOf(PaymentGatewayError);
  });

  test("모르는 수단 문자열은 발급하지 않고 원장에도 남기지 않는다", async () => {
    const gateway = makeGateway();
    const bogus = { ...request("card", "gp_bogus"), method: "bank_wire" as unknown as PaymentMethod };
    await expect(gateway.createPayment(bogus)).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(gateway.getPayment("gp_bogus")).rejects.toBeInstanceOf(PaymentGatewayError);
  });
});

describe("수단 4종 조회", () => {
  test.each(PAYMENT_METHODS)("%s 발급 직후는 ready, 금액은 요청 금액", async (method) => {
    const gateway = makeGateway();
    await gateway.createPayment(request(method));
    expect(await gateway.getPayment(`gp_${method}`)).toEqual({ status: "ready", amount: 33_000 });
  });

  test.each(PAYMENT_METHODS)("%s 입금·승인 뒤에는 paid 와 거래 번호", async (method) => {
    const gateway = makeGateway();
    await gateway.createPayment(request(method));
    const { transactionId } = gateway.deposit(`gp_${method}`, 33_000);
    expect(await gateway.getPayment(`gp_${method}`)).toEqual({
      status: "paid",
      amount: 33_000,
      paidAt: NOW,
      transactionId,
    });
  });

  test.each(PAYMENT_METHODS)("%s 입금 전 취소 뒤에는 cancelled", async (method) => {
    const gateway = makeGateway();
    await gateway.createPayment(request(method));
    await gateway.cancelPayment(`gp_${method}`, "회원 요청 취소");
    expect((await gateway.getPayment(`gp_${method}`)).status).toBe("cancelled");
  });

  test.each(PAYMENT_METHODS)("%s 결제 기한이 지나면 expired", async (method) => {
    const gateway = makeGateway();
    await gateway.createPayment(request(method));
    gateway.expire(`gp_${method}`);
    expect((await gateway.getPayment(`gp_${method}`)).status).toBe("expired");
  });
});
