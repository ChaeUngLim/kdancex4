// T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식) 단위 테스트 — 공유 계약 §4.10(포트). DB 불필요.
//
// 옛 backend/tests/test_adapters.py 의 PG 사례를 옮겼다. 각 테스트 이름 끝의 [옛 test_…] 가
// 옛 함수 이름이다(이관 대응표 재료). 옛 SCH-04(어댑터 3종: PG/알림/슬롯락)의 알림·슬롯락
// 사례는 이 파일 범위가 아니다(알림은 T-M3-5, 슬롯락은 plan D8 로 폐기).
// 웹훅 검증기 사례는 새로 썼다 — 옛 backend 에는 웹훅 수신 경로가 없었다(FR-287(웹훅 확정)).
import "temporal-polyfill/full/global";

import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import {
  FakePaymentGateway,
  createFakePaymentGatewayStore,
} from "../../lib/server/fakes/fake-payment-gateway";
import {
  HmacWebhookVerifier,
  signWebhook,
} from "../../lib/server/fakes/hmac-webhook-verifier";
import {
  PORTONE_CANCELLATION_STATUS_MAP,
  PaymentGatewayError,
  PaymentNotFoundError,
  UnsupportedPaymentMethodError,
  parsePortoneCancelResponse,
  refundAccountToPortonePayload,
  refundRequestToPortonePayload,
  type PaymentGatewayPort,
  type RefundAccount,
  type RefundRequest,
} from "../../lib/server/ports/payment-gateway";
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type WebhookVerifier,
} from "../../lib/server/ports/webhook-verifier";

const FIXED_NOW = Temporal.Instant.from("2026-09-14T12:00:00Z");
const clock = fixedClock(FIXED_NOW);
const ACCOUNT: RefundAccount = { bankCode: "SHINHAN", accountNumber: "110123456789", holderName: "홍길동" };

function makeRequest(
  paymentKey = "pay_001",
  overrides: Partial<Omit<RefundRequest, "paymentKey">> = {},
): RefundRequest {
  return {
    paymentKey,
    method: "virtual_account",
    amount: 50_000,
    idempotencyKey: `idem_${paymentKey}`,
    refundAccount: ACCOUNT,
    reason: "회원 요청 취소",
    ...overrides,
  };
}

/** 테스트마다 새 원장 — globalThis 기본 원장을 공유하지 않게 한다 */
function makeGateway(options: Omit<ConstructorParameters<typeof FakePaymentGateway>[0] & object, "store"> = {}) {
  return new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock, ...options });
}

// --------------------------------------------------------------------------- //
// 값 집합 — refunds.status CHECK 와 문자 단위 일치
// --------------------------------------------------------------------------- //

describe("포트원 상태 매핑", () => {
  test("포트원 REQUESTED 는 실패가 아니라 pending 이다 [옛 test_portone_requested_maps_to_pending_not_failed]", () => {
    expect(PORTONE_CANCELLATION_STATUS_MAP).toEqual({
      SUCCEEDED: "succeeded",
      REQUESTED: "pending",
      FAILED: "failed",
    });
  });
  // [옛 test_refund_status_values_match_db_check_constraint] 은 T-M3-1(값 상수·금액·시각 도우미)의
  // REFUND_STATUSES 와 T-M2-2(값 집합 계약 일치 테스트)가 맡는다 — 여기서는 매핑 값이 그 집합 안인지만 본다.
  test("매핑 결과는 모두 REFUND_STATUSES 안의 값이다 [옛 test_refund_status_values_match_db_check_constraint]", async () => {
    const { REFUND_STATUSES } = await import("../../lib/domain/constants");
    for (const status of Object.values(PORTONE_CANCELLATION_STATUS_MAP)) {
      expect(REFUND_STATUSES).toContain(status);
    }
  });
});

// --------------------------------------------------------------------------- //
// 포트원 응답 파서
// --------------------------------------------------------------------------- //

describe("parsePortoneCancelResponse", () => {
  test("SUCCEEDED 응답을 읽는다 [옛 test_parse_portone_succeeded_cancellation]", () => {
    const result = parsePortoneCancelResponse({
      cancellation: {
        status: "SUCCEEDED",
        id: "cancel_abc",
        pgCancellationId: "pg_xyz",
        totalAmount: 50_000,
        taxFreeAmount: 0,
        vatAmount: 0,
        reason: "회원 요청 취소",
        requestedAt: "2026-09-14T12:00:00Z",
        cancelledAt: "2026-09-14T12:00:03Z",
      },
    });
    expect(result.status).toBe("succeeded");
    expect(result.gatewayRefundId).toBe("cancel_abc");
    expect(result.pgCancellationId).toBe("pg_xyz");
    expect(result.totalAmount).toBe(50_000);
    expect(result.cancelledAt?.equals(Temporal.Instant.from("2026-09-14T12:00:03Z"))).toBe(true);
    expect(result.failureCode).toBeUndefined();
  });

  test("REQUESTED 응답에는 정산 필드가 없다 [옛 test_parse_portone_requested_cancellation_has_no_settlement_fields]", () => {
    const result = parsePortoneCancelResponse({
      cancellation: {
        status: "REQUESTED",
        id: "cancel_abc",
        totalAmount: 50_000,
        reason: "회원 요청 취소",
        requestedAt: "2026-09-14T12:00:00Z",
      },
    });
    expect(result.status).toBe("pending");
    expect(result.cancelledAt).toBeUndefined();
    expect(result.pgCancellationId).toBeUndefined();
  });

  test("모르는 상태는 성공으로 넘겨짚지 않고 실패로 떨어뜨린다 [옛 test_parse_portone_unknown_status_fails_loudly]", () => {
    const result = parsePortoneCancelResponse({ cancellation: { status: "WEIRD_NEW" } });
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("UNRECOGNIZED_CANCELLATION_STATUS");
    expect(result.failureMessage).toContain("WEIRD_NEW");
  });

  test("cancellation 이 없는 응답은 실패다 [옛 test_parse_portone_malformed_payload_fails]", () => {
    expect(parsePortoneCancelResponse({}).status).toBe("failed");
    expect(parsePortoneCancelResponse(null).status).toBe("failed");
  });

  test("시각 문자열이 깨져도 결과 전체를 버리지 않는다(새 사례)", () => {
    const result = parsePortoneCancelResponse({
      cancellation: { status: "SUCCEEDED", requestedAt: "not-a-date", cancelledAt: "2026-09-14T12:00:03" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.requestedAt).toBeUndefined();
    // 오프셋 없는 시각은 옛 파서처럼 UTC 로 읽는다
    expect(result.cancelledAt?.equals(Temporal.Instant.from("2026-09-14T12:00:03Z"))).toBe(true);
  });

  test("totalAmount 가 정수가 아니면 버린다(새 사례 — 금액은 원 단위 정수만)", () => {
    const result = parsePortoneCancelResponse({ cancellation: { status: "SUCCEEDED", totalAmount: 100.5 } });
    expect(result.totalAmount).toBeUndefined();
  });

  test("환불 요청을 포트원 필드 이름으로 바꾼다 [옛 test_refund_request_serializes_to_portone_field_names]", () => {
    const payload = refundRequestToPortonePayload(makeRequest());
    expect(payload.paymentId).toBe("pay_001");
    expect(payload.amount).toBe(50_000);
    expect(payload.reason).toBeTruthy();
    expect(payload.refundAccount).toEqual({ bank: "SHINHAN", number: "110123456789", holderName: "홍길동" });
  });

  test("예금주 전화번호가 있으면 넣는다 [옛 test_refund_account_includes_holder_phone_when_present]", () => {
    const payload = refundAccountToPortonePayload({ ...ACCOUNT, holderPhoneNumber: "01012345678" });
    expect(payload.holderPhoneNumber).toBe("01012345678");
  });
});

// --------------------------------------------------------------------------- //
// FakePaymentGateway.refund — succeeded / pending / failed
// --------------------------------------------------------------------------- //

describe("FakePaymentGateway.refund", () => {
  test("포트 타입을 만족한다 [옛 test_fake_gateway_satisfies_protocol]", () => {
    const port: PaymentGatewayPort = makeGateway();
    expect(typeof port.createPayment).toBe("function");
    expect(typeof port.getPayment).toBe("function");
    expect(typeof port.cancelPayment).toBe("function");
    expect(typeof port.refund).toBe("function");
  });

  test("기본은 succeeded [옛 test_fake_gateway_produces_succeeded]", async () => {
    const result = await makeGateway().refund(makeRequest("pay_ok"));
    expect(result.status).toBe("succeeded");
    expect(result.gatewayRefundId).toBeDefined();
    expect(result.pgCancellationId).toBeDefined();
    expect(result.totalAmount).toBe(50_000);
    expect(result.cancelledAt?.equals(FIXED_NOW)).toBe(true);
    expect((result.rawResponse.cancellation as Record<string, unknown>).status).toBe("SUCCEEDED");
  });

  test("pendingOn 이면 pending [옛 test_fake_gateway_produces_pending_via_pending_on]", async () => {
    const result = await makeGateway({ pendingOn: ["pay_slow"] }).refund(makeRequest("pay_slow"));
    expect(result.status).toBe("pending");
    expect(result.cancelledAt).toBeUndefined();
    expect((result.rawResponse.cancellation as Record<string, unknown>).status).toBe("REQUESTED");
  });

  test("forcePending 이면 전부 pending [옛 test_fake_gateway_produces_pending_via_force_pending]", async () => {
    expect((await makeGateway({ forcePending: true }).refund(makeRequest("any"))).status).toBe("pending");
  });

  test("failOn 이면 failed [옛 test_fake_gateway_produces_failed_via_fail_on]", async () => {
    const result = await makeGateway({ failOn: ["pay_bad"] }).refund(makeRequest("pay_bad"));
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("PG_PROVIDER_ERROR");
    expect(result.failureMessage).toBeTruthy();
  });

  test("같은 입력이면 같은 식별자 [옛 test_fake_gateway_is_deterministic]", async () => {
    const a = await makeGateway().refund(makeRequest("pay_ok"));
    const b = await makeGateway().refund(makeRequest("pay_ok"));
    expect(a.gatewayRefundId).toBe(b.gatewayRefundId);
    expect(a.pgCancellationId).toBe(b.pgCancellationId);
  });

  test("같은 멱등키 재시도는 원장의 첫 결과를 돌려준다 [옛 test_fake_gateway_ledger_makes_retry_idempotent]", async () => {
    const gateway = makeGateway();
    const request = makeRequest("pay_ok", { idempotencyKey: "idem_same" });
    const first = await gateway.refund(request);
    const second = await gateway.refund(request);
    expect(second).toBe(first);
    expect(gateway.refundCalls()).toHaveLength(2);
    expect(gateway.refundLedgerSize()).toBe(1);
  });

  test("실패는 원장에 못박지 않는다 [옛 test_fake_gateway_does_not_pin_failures_in_ledger]", async () => {
    const store = createFakePaymentGatewayStore();
    const failing = new FakePaymentGateway({ store, clock, failOn: ["pay_bad"] });
    const request = makeRequest("pay_bad");
    expect((await failing.refund(request)).status).toBe("failed");
    expect(failing.refundLedgerSize()).toBe(0);

    // 옛 테스트는 fail_on.clear() 로 같은 객체를 바꿨다. 여기서는 설정을 바꾸지 않고
    // 같은 원장을 쓰는 새 인스턴스를 만든다(불변 설정).
    const healthy = new FakePaymentGateway({ store, clock });
    expect((await healthy.refund(request)).status).toBe("succeeded");
  });

  test("settleRefund 가 pending 을 succeeded 로 올린다 [옛 test_fake_gateway_settle_promotes_pending_to_succeeded]", async () => {
    const gateway = makeGateway({ forcePending: true });
    const request = makeRequest("pay_slow");
    expect((await gateway.refund(request)).status).toBe("pending");
    const settled = gateway.settleRefund(request.idempotencyKey);
    expect(settled.status).toBe("succeeded");
    expect(settled.cancelledAt?.equals(FIXED_NOW)).toBe(true);
  });

  test("환불 계좌 없는 가상계좌 환불은 failed [옛 test_fake_gateway_fails_without_refund_account]", async () => {
    const result = await makeGateway().refund(makeRequest("pay_ok", { refundAccount: undefined }));
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("REFUND_ACCOUNT_REQUIRED");
  });

  test("카드 환불은 부분 취소로 받는다 — S4-1.5(수단별 환불 실행). 옛 「카드 거부」(옛 test_card_method_raises_unsupported_payment_method_error)를 대신한다", async () => {
    // 옛 이관 경로의 「카드 → 미지원」 동작은 cancellation.ts 가 포트를 부르기 전에 스스로 지킨다(cancellation-service.test.ts)
    const gateway = makeGateway();
    const result = await gateway.refund(makeRequest("pay_card", { method: "card", refundAccount: undefined }));
    expect(result.status).toBe("succeeded");
    expect(gateway.refundCalls()).toHaveLength(1);
    expect(gateway.refundLedgerSize()).toBe(1);
    // 같은 키로 다시 부르면 같은 결과(두 번 취소되지 않는다)
    expect(await gateway.refund(makeRequest("pay_card", { method: "card", refundAccount: undefined }))).toEqual(result);
    expect(gateway.refundLedgerSize()).toBe(1);
  });

  test("카드 부분 취소는 원장의 승인 금액을 넘지 못하고, 승인 전 결제는 취소할 수 없다", async () => {
    const gateway = makeGateway();
    const dueAt = FIXED_NOW.add({ hours: 1 });
    await gateway.createPayment({ gatewayPaymentId: "pay_cap", method: "card", amount: 10000, dueAt, orderName: "살사" });
    expect((await gateway.refund(makeRequest("pay_cap", { method: "card", amount: 10000, idempotencyKey: "k-ready" }))).failureCode).toBe("PAYMENT_NOT_PAID");
    gateway.deposit("pay_cap", 10000);
    expect((await gateway.refund(makeRequest("pay_cap", { method: "card", amount: 6000, idempotencyKey: "k-1" }))).status).toBe("succeeded");
    const over = await gateway.refund(makeRequest("pay_cap", { method: "card", amount: 4001, idempotencyKey: "k-2" }));
    expect(over).toMatchObject({ status: "failed", failureCode: "CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT" });
    expect((await gateway.refund(makeRequest("pay_cap", { method: "card", amount: 4000, idempotencyKey: "k-3" }))).status).toBe("succeeded");
  });

  test.each(["easy_transfer", "kakaopay", "", "VIRTUAL_ACCOUNT"])(
    "가상계좌·카드·간편결제가 아닌 수단 %j 은 거부한다 [옛 test_non_virtual_account_methods_are_rejected]",
    async (method) => {
      await expect(makeGateway().refund(makeRequest("pay_x", { method }))).rejects.toBeInstanceOf(
        UnsupportedPaymentMethodError,
      );
    },
  );
});

// --------------------------------------------------------------------------- //
// FakePaymentGateway — 결제 발급·조회·취소·입금 (새 사례, plan D9)
// --------------------------------------------------------------------------- //

describe("FakePaymentGateway 결제 원장", () => {
  const dueAt = FIXED_NOW.add({ hours: 24 });

  test("가상계좌 발급 → ready + 계좌, 같은 요청 재시도는 같은 계좌", async () => {
    const gateway = makeGateway();
    const req = { gatewayPaymentId: "gp_1", method: "virtual_account" as const, amount: 120_000, dueAt, orderName: "살사 기초" };
    const first = await gateway.createPayment(req);
    expect(first.status).toBe("ready");
    expect(first.virtualAccount?.accountNumber).toMatch(/^\d{14}$/);
    expect(first.cardCheckoutKey).toBeUndefined();
    expect(await gateway.createPayment(req)).toEqual(first);
  });

  test("같은 결제 번호를 다른 금액으로 다시 만들면 거부한다", async () => {
    const gateway = makeGateway();
    const req = { gatewayPaymentId: "gp_1", method: "virtual_account" as const, amount: 120_000, dueAt, orderName: "살사 기초" };
    await gateway.createPayment(req);
    await expect(gateway.createPayment({ ...req, amount: 1 })).rejects.toBeInstanceOf(PaymentGatewayError);
  });

  test("카드 발급은 결제창 키를 준다", async () => {
    const result = await makeGateway().createPayment({ gatewayPaymentId: "gp_c", method: "card", amount: 10_000, dueAt, orderName: "탱고" });
    expect(result.cardCheckoutKey).toBeTruthy();
    expect(result.virtualAccount).toBeUndefined();
  });

  test("입금 전에는 ready·요청 금액, 입금 뒤에는 paid·입금 금액(FR-115(결제 금액 대조) 의 PG 응답 금액)", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 120_000, dueAt, orderName: "x" });
    expect(await gateway.getPayment("gp_1")).toEqual({ status: "ready", amount: 120_000 });

    const deposit = gateway.deposit("gp_1", 100_000);
    const paid = await gateway.getPayment("gp_1");
    expect(paid.status).toBe("paid");
    expect(paid.amount).toBe(100_000);
    expect(paid.transactionId).toBe(deposit.transactionId);
    expect(paid.paidAt?.equals(FIXED_NOW)).toBe(true);
  });

  test("취소된 결제에도 늦은 입금을 기록할 수 있다(FR-292(만료 뒤 늦은 입금) 시험용)", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 120_000, dueAt, orderName: "x" });
    await gateway.cancelPayment("gp_1", "결제 기한 만료");
    expect((await gateway.getPayment("gp_1")).status).toBe("cancelled");
    gateway.deposit("gp_1", 120_000);
    expect((await gateway.getPayment("gp_1")).status).toBe("paid");
    expect(() => gateway.deposit("gp_1", 120_000)).toThrow(PaymentGatewayError);
  });

  test("cancelPayment 는 다시 불러도 같다, 입금된 결제는 취소 대신 환불 경로", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 1_000, dueAt, orderName: "x" });
    await gateway.cancelPayment("gp_1", "셀프 취소");
    await expect(gateway.cancelPayment("gp_1", "셀프 취소")).resolves.toBeUndefined();

    await gateway.createPayment({ gatewayPaymentId: "gp_2", method: "virtual_account", amount: 1_000, dueAt, orderName: "x" });
    gateway.deposit("gp_2", 1_000);
    await expect(gateway.cancelPayment("gp_2", "셀프 취소")).rejects.toBeInstanceOf(PaymentGatewayError);
  });

  test("만료 표시 뒤 조회는 expired", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 1_000, dueAt, orderName: "x" });
    gateway.expire("gp_1");
    expect((await gateway.getPayment("gp_1")).status).toBe("expired");
  });

  test("모르는 결제 번호는 PaymentNotFoundError", async () => {
    const gateway = makeGateway();
    await expect(gateway.getPayment("nope")).rejects.toBeInstanceOf(PaymentNotFoundError);
    await expect(gateway.cancelPayment("nope", "x")).rejects.toBeInstanceOf(PaymentNotFoundError);
    expect(() => gateway.deposit("nope", 1)).toThrow(PaymentNotFoundError);
  });

  test("입금 금액은 양의 안전 정수만", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 1_000, dueAt, orderName: "x" });
    expect(() => gateway.deposit("gp_1", 0)).toThrow(PaymentGatewayError);
    expect(() => gateway.deposit("gp_1", 10.5)).toThrow(PaymentGatewayError);
  });

  test("store 를 주지 않으면 globalThis 원장을 공유한다(개발 서버 재적재 대비)", async () => {
    const a = new FakePaymentGateway({ clock });
    a.reset();
    await a.createPayment({ gatewayPaymentId: "gp_global", method: "card", amount: 1_000, dueAt, orderName: "x" });
    const b = new FakePaymentGateway({ clock });
    expect((await b.getPayment("gp_global")).status).toBe("ready");
    b.reset();
  });

  test("입금 웹훅 본문은 계약 §6 모양이다", async () => {
    const gateway = makeGateway();
    await gateway.createPayment({ gatewayPaymentId: "gp_1", method: "virtual_account", amount: 1_000, dueAt, orderName: "x" });
    const { transactionId } = gateway.deposit("gp_1", 1_000);
    expect(gateway.buildPaidWebhookBody("gp_1")).toEqual({
      type: "Transaction.Paid",
      timestamp: FIXED_NOW.toString(),
      data: { paymentId: "gp_1", transactionId },
    });
  });
});

// --------------------------------------------------------------------------- //
// HmacWebhookVerifier — FR-287(웹훅 확정) 1단계 서명·시각 검증 (새 사례)
// --------------------------------------------------------------------------- //

describe("HmacWebhookVerifier", () => {
  const SECRET = "test-webhook-secret";
  const BODY = JSON.stringify({ type: "Transaction.Paid", data: { paymentId: "gp_1" } });
  const NOW_SECONDS = FIXED_NOW.epochMilliseconds / 1000;

  function headersFor(overrides: Record<string, string | undefined> = {}, body = BODY, timestamp = NOW_SECONDS) {
    const signed = signWebhook({ secret: SECRET, webhookId: "wh_1", timestampSeconds: timestamp, rawBody: body });
    const merged: Record<string, string | undefined> = { ...signed, ...overrides };
    const headers = new Headers();
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) headers.set(k, v);
    return headers;
  }

  const verifier: WebhookVerifier = new HmacWebhookVerifier({ secret: SECRET });

  test("올바른 서명은 통과", () => {
    expect(verifier.verify(headersFor(), BODY, FIXED_NOW)).toBe(true);
  });

  test("서명은 Standard Webhooks 모양(v1,base64 HMAC-SHA256(id.timestamp.body))", () => {
    const expected = createHmac("sha256", SECRET).update(`wh_1.${NOW_SECONDS}.${BODY}`).digest("base64");
    expect(headersFor().get(WEBHOOK_SIGNATURE_HEADER)).toBe(`v1,${expected}`);
  });

  test("틀린 서명은 거부(같은 길이)", () => {
    const wrong = createHmac("sha256", "other-secret").update(`wh_1.${NOW_SECONDS}.${BODY}`).digest("base64");
    expect(verifier.verify(headersFor({ [WEBHOOK_SIGNATURE_HEADER]: `v1,${wrong}` }), BODY, FIXED_NOW)).toBe(false);
  });

  test("본문이 한 글자라도 바뀌면 거부", () => {
    expect(verifier.verify(headersFor(), BODY.replace("gp_1", "gp_2"), FIXED_NOW)).toBe(false);
  });

  test("webhook-id 를 바꾸면 거부", () => {
    expect(verifier.verify(headersFor({ [WEBHOOK_ID_HEADER]: "wh_other" }), BODY, FIXED_NOW)).toBe(false);
  });

  test("길이가 다른 서명은 비교 전에 거부", () => {
    const short = Buffer.from("short").toString("base64");
    expect(verifier.verify(headersFor({ [WEBHOOK_SIGNATURE_HEADER]: `v1,${short}` }), BODY, FIXED_NOW)).toBe(false);
    const long = Buffer.alloc(64, 1).toString("base64");
    expect(verifier.verify(headersFor({ [WEBHOOK_SIGNATURE_HEADER]: `v1,${long}` }), BODY, FIXED_NOW)).toBe(false);
  });

  test("base64 가 아닌 서명·v1 이 아닌 버전·빈 값은 거부", () => {
    for (const bad of ["v1,!!!!", "v2," + headersFor().get(WEBHOOK_SIGNATURE_HEADER)!.slice(3), "", "v1,", "garbage"]) {
      expect(verifier.verify(headersFor({ [WEBHOOK_SIGNATURE_HEADER]: bad }), BODY, FIXED_NOW)).toBe(false);
    }
  });

  test("여러 서명 중 하나가 맞으면 통과(비밀값 교체 기간)", () => {
    const good = headersFor().get(WEBHOOK_SIGNATURE_HEADER)!;
    const wrong = `v1,${Buffer.alloc(32, 7).toString("base64")}`;
    expect(verifier.verify(headersFor({ [WEBHOOK_SIGNATURE_HEADER]: `${wrong} ${good}` }), BODY, FIXED_NOW)).toBe(true);
  });

  test("헤더가 빠지면 거부", () => {
    for (const name of [WEBHOOK_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER]) {
      expect(verifier.verify(headersFor({ [name]: undefined }), BODY, FIXED_NOW)).toBe(false);
    }
  });

  test("오래된 timestamp(5분 초과)는 서명이 맞아도 거부", () => {
    const old = NOW_SECONDS - 301;
    expect(verifier.verify(headersFor({}, BODY, old), BODY, FIXED_NOW)).toBe(false);
  });

  test("미래 timestamp(5분 초과)도 거부", () => {
    expect(verifier.verify(headersFor({}, BODY, NOW_SECONDS + 301), BODY, FIXED_NOW)).toBe(false);
  });

  test("경계 — 정확히 5분 전은 통과", () => {
    expect(verifier.verify(headersFor({}, BODY, NOW_SECONDS - 300), BODY, FIXED_NOW)).toBe(true);
  });

  test("숫자가 아닌 timestamp 는 거부", () => {
    expect(verifier.verify(headersFor({ [WEBHOOK_TIMESTAMP_HEADER]: "12abc" }), BODY, FIXED_NOW)).toBe(false);
  });

  test("whsec_ 접두 비밀값은 base64 를 풀어 키로 쓴다(Standard Webhooks 관례)", () => {
    const keyBytes = Buffer.from("raw-key-bytes-0123456789");
    const secret = `whsec_${keyBytes.toString("base64")}`;
    const signed = signWebhook({ secret, webhookId: "wh_1", timestampSeconds: NOW_SECONDS, rawBody: BODY });
    const expected = createHmac("sha256", keyBytes).update(`wh_1.${NOW_SECONDS}.${BODY}`).digest("base64");
    expect(signed[WEBHOOK_SIGNATURE_HEADER]).toBe(`v1,${expected}`);
    expect(new HmacWebhookVerifier({ secret }).verify(new Headers(signed), BODY, FIXED_NOW)).toBe(true);
  });

  test("빈 비밀값으로는 만들 수 없고, 오류 문구에 비밀값이 들어가지 않는다", () => {
    expect(() => new HmacWebhookVerifier({ secret: "" })).toThrow();
    expect(() => new HmacWebhookVerifier({ secret: "whsec_" })).toThrow();
    try {
      new HmacWebhookVerifier({ secret: SECRET, toleranceSeconds: -1 });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });
});
