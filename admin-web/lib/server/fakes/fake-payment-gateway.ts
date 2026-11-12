// 공유 계약 §4.10(포트) — PaymentGatewayPort 의 1회차 구현. T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식).
// 옛 backend/app/adapters/payment_gateway.py 의 FakePaymentGateway(SCH-04(어댑터 3종: PG/알림/슬롯락))를
// 옮기고, 결제 발급·조회·취소(plan D9)를 더했다.
//
// - 원장은 **메모리**다. 기본값은 `globalThis` 에 붙인 원장이라 Next.js 개발 서버가 모듈을 다시 읽어도
//   남는다. 권위 있는 기록은 DB(payments·refunds·payment_webhook_events)이고, 멱등의 권위도 DB 유니크다.
//   그래서 이 원장이 사라져도 이중 반영은 생기지 않는다(plan D9).
// - 환불은 포트원 V2 응답 모양의 본문을 만들어 실 연동과 같은 파서(`parsePortoneCancelResponse`)에 통과시킨다.
// - 테스트는 `createFakePaymentGatewayStore()` 로 원장을 따로 만들어 주입한다.
import { createHash } from "node:crypto";

import { systemClock, type Clock } from "../../domain/time";
import {
  PaymentGatewayError,
  PaymentNotFoundError,
  REFUND_ACCOUNT_REQUIRED_CODE,
  UnsupportedPaymentMethodError,
  parsePortoneCancelResponse,
  type CreatePaymentRequest,
  type CreatePaymentResult,
  type GatewayPayment,
  type PaymentGatewayPort,
  type RefundRequest,
  type RefundResult,
} from "../ports/payment-gateway";

/** 가짜 가상계좌의 은행·예금주. 포트원 V2 `Bank` 값 중 하나를 쓴다 */
const FAKE_VA_BANK_CODE = "SHINHAN";
const FAKE_VA_HOLDER = "케이댄스(가짜 PG)";
const FAKE_VA_ACCOUNT_DIGITS = 14;

const DEFAULT_FAILURE_CODE = "PG_PROVIDER_ERROR";
const DEFAULT_FAILURE_MESSAGE = "PG사에서 환불 요청을 거절했습니다.";

interface FakePaymentRecord {
  readonly request: CreatePaymentRequest;
  readonly created: CreatePaymentResult;
  readonly status: GatewayPayment["status"];
  readonly paidAmount?: number;
  readonly paidAt?: Temporal.Instant;
  readonly transactionId?: string;
}

/** 가짜 PG 원장. 결제 원장 + 환불 멱등 원장 + 환불 호출 기록 */
export interface FakePaymentGatewayStore {
  readonly payments: Map<string, FakePaymentRecord>;
  /** idempotencyKey → 확정된 환불 결과. 실패는 넣지 않는다 */
  readonly refundLedger: Map<string, RefundResult>;
  /** 환불 호출 순서 기록. 서비스가 PG 를 몇 번 불렀는지 단정할 때 쓴다 */
  readonly refundCalls: RefundRequest[];
}

export function createFakePaymentGatewayStore(): FakePaymentGatewayStore {
  return { payments: new Map(), refundLedger: new Map(), refundCalls: [] };
}

const GLOBAL_STORE_KEY = Symbol.for("kdance.fakePaymentGateway.store");

/** 개발 서버 재적재에도 유지되는 기본 원장 */
function globalStore(): FakePaymentGatewayStore {
  const holder = globalThis as typeof globalThis & { [GLOBAL_STORE_KEY]?: FakePaymentGatewayStore };
  holder[GLOBAL_STORE_KEY] ??= createFakePaymentGatewayStore();
  return holder[GLOBAL_STORE_KEY];
}

export interface FakePaymentGatewayOptions {
  /** 생략하면 globalThis 원장 */
  store?: FakePaymentGatewayStore;
  clock?: Clock;
  /** 이 원거래(paymentKey)의 환불은 failed */
  failOn?: Iterable<string>;
  /** 이 원거래의 환불은 pending(포트원 REQUESTED) */
  pendingOn?: Iterable<string>;
  /** 모든 환불을 pending 으로 */
  forcePending?: boolean;
  failureCode?: string;
  failureMessage?: string;
}

/** 시드에서 결정적으로 만드는 식별자 — 같은 입력이면 항상 같은 값 */
function deterministicId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24)}`;
}

function deterministicDigits(seed: string, length: number): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  return BigInt(`0x${hex}`).toString().slice(0, length).padStart(length, "0");
}

function assertPositiveAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new PaymentGatewayError("금액은 원 단위 양의 정수여야 합니다.");
  }
}

export class FakePaymentGateway implements PaymentGatewayPort {
  private readonly store: FakePaymentGatewayStore;
  private readonly clock: Clock;
  private readonly failOn: ReadonlySet<string>;
  private readonly pendingOn: ReadonlySet<string>;
  private readonly forcePending: boolean;
  private readonly failureCode: string;
  private readonly failureMessage: string;

  constructor(options: FakePaymentGatewayOptions = {}) {
    this.store = options.store ?? globalStore();
    this.clock = options.clock ?? systemClock;
    this.failOn = new Set(options.failOn ?? []);
    this.pendingOn = new Set(options.pendingOn ?? []);
    this.forcePending = options.forcePending ?? false;
    this.failureCode = options.failureCode ?? DEFAULT_FAILURE_CODE;
    this.failureMessage = options.failureMessage ?? DEFAULT_FAILURE_MESSAGE;
  }

  // -- 결제 발급·조회·취소 (plan D9) ------------------------------------------ //

  /** 같은 번호·같은 내용의 재요청은 같은 결과(멱등). 같은 번호에 다른 내용이면 거부 */
  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    assertPositiveAmount(req.amount);
    const existing = this.store.payments.get(req.gatewayPaymentId);
    if (existing) {
      const same = existing.request.method === req.method && existing.request.amount === req.amount;
      if (!same) throw new PaymentGatewayError("같은 결제 번호가 다른 내용으로 이미 발급됐습니다.");
      return existing.created;
    }

    const created: CreatePaymentResult =
      req.method === "virtual_account"
        ? {
            status: "ready",
            virtualAccount: {
              bankCode: FAKE_VA_BANK_CODE,
              accountNumber: deterministicDigits(`va:${req.gatewayPaymentId}`, FAKE_VA_ACCOUNT_DIGITS),
              holder: FAKE_VA_HOLDER,
            },
          }
        : { status: "ready", cardCheckoutKey: deterministicId("checkout", req.gatewayPaymentId) };

    this.store.payments.set(req.gatewayPaymentId, { request: { ...req }, created, status: "ready" });
    return created;
  }

  async getPayment(gatewayPaymentId: string): Promise<GatewayPayment> {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "paid") {
      return {
        status: "paid",
        amount: record.paidAmount ?? record.request.amount,
        paidAt: record.paidAt,
        transactionId: record.transactionId,
      };
    }
    return { status: record.status, amount: record.request.amount };
  }

  /** 입금 전 취소·만료 때 계좌 폐기. 이미 취소·만료면 아무것도 하지 않는다. 입금된 결제는 환불 경로로 */
  async cancelPayment(gatewayPaymentId: string, _reason: string): Promise<void> {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "paid") {
      throw new PaymentGatewayError("입금된 결제는 취소할 수 없습니다. 환불 요청으로 처리하세요.");
    }
    if (record.status === "ready") {
      this.store.payments.set(gatewayPaymentId, { ...record, status: "cancelled" });
    }
  }

  // -- 환불 — 옛 refund 이식 ----------------------------------------------- //

  // 카드와 환불 계좌 누락은 둘 다 「잘못된 입력」처럼 보여도 다르게 다룬다. 카드는 이 경로에 들어오면
  // 안 되는 프로그래밍 오류라 예외로 막고, 계좌 누락은 PG 가 거절할 만한 실패라 failed 결과로 돌려준다
  // (서비스가 사유를 감사 기록에 남길 수 있어야 한다).
  async refund(req: RefundRequest): Promise<RefundResult> {
    if (req.method !== "virtual_account") {
      // 원장에도 호출 기록에도 남기지 않는다 — 실행되지 않은 요청이다
      throw new UnsupportedPaymentMethodError(req.method);
    }

    this.store.refundCalls.push({ ...req });

    const cached = this.store.refundLedger.get(req.idempotencyKey);
    if (cached) return cached;

    const result: RefundResult = req.refundAccount
      ? parsePortoneCancelResponse(this.buildPortoneCancelResponse(req, this.portoneStatusFor(req)))
      : {
          status: "failed",
          failureCode: REFUND_ACCOUNT_REQUIRED_CODE,
          failureMessage: "가상계좌 환불에는 환불 수취 계좌가 필요합니다.",
          rawResponse: {},
        };

    // 실패는 원장에 못박지 않는다. 실패 건 재시도는 도메인상 허용이다(refunds 부분 유니크가 failed 를 뺀다)
    if (result.status !== "failed") this.store.refundLedger.set(req.idempotencyKey, result);
    return result;
  }

  // -- 시험 조작 (dev 경로·테스트 전용, 포트 밖) ------------------------------- //

  /**
   * 입금(카드면 승인)을 기록한다. 취소·만료된 결제에도 기록할 수 있다 — FR-292(만료 뒤 늦은 입금)를
   * 재현하려는 것이다. 같은 결제에 두 번 입금하면 거부한다.
   */
  deposit(gatewayPaymentId: string, amount: number): { transactionId: string; paidAt: Temporal.Instant } {
    const record = this.requirePayment(gatewayPaymentId);
    assertPositiveAmount(amount);
    if (record.status === "paid") throw new PaymentGatewayError("이미 입금된 결제입니다.");

    const paidAt = this.clock();
    const transactionId = deterministicId("tx", `${gatewayPaymentId}:${amount}`);
    this.store.payments.set(gatewayPaymentId, { ...record, status: "paid", paidAmount: amount, paidAt, transactionId });
    return { transactionId, paidAt };
  }

  /** 입금 전 결제를 만료 상태로 둔다 */
  expire(gatewayPaymentId: string): void {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "ready") this.store.payments.set(gatewayPaymentId, { ...record, status: "expired" });
  }

  /** 입금 웹훅 본문 — 계약 03 §6 모양. 서명은 `signWebhook` 이 붙인다 */
  buildPaidWebhookBody(gatewayPaymentId: string): {
    type: "Transaction.Paid";
    timestamp: string;
    data: { paymentId: string; transactionId: string };
  } {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status !== "paid" || !record.transactionId || !record.paidAt) {
      throw new PaymentGatewayError("입금되지 않은 결제의 입금 웹훅은 만들 수 없습니다.");
    }
    return {
      type: "Transaction.Paid",
      timestamp: record.paidAt.toString(),
      data: { paymentId: gatewayPaymentId, transactionId: record.transactionId },
    };
  }

  /** pending 환불을 succeeded 로 확정한다(실제로는 포트원 웹훅이 하는 일) — 옛 settle */
  settleRefund(idempotencyKey: string): RefundResult {
    const current = this.store.refundLedger.get(idempotencyKey);
    if (!current) throw new PaymentGatewayError("원장에 없는 환불입니다.");
    const settled: RefundResult = {
      ...current,
      status: "succeeded",
      pgCancellationId: deterministicId("pg", idempotencyKey),
      cancelledAt: this.clock(),
    };
    this.store.refundLedger.set(idempotencyKey, settled);
    return settled;
  }

  refundCalls(): readonly RefundRequest[] {
    return [...this.store.refundCalls];
  }

  refundLedgerSize(): number {
    return this.store.refundLedger.size;
  }

  /** 원장을 비운다(주입 설정은 유지) */
  reset(): void {
    this.store.payments.clear();
    this.store.refundLedger.clear();
    this.store.refundCalls.length = 0;
  }

  // -- 내부 -------------------------------------------------------------- //

  private requirePayment(gatewayPaymentId: string): FakePaymentRecord {
    const record = this.store.payments.get(gatewayPaymentId);
    if (!record) throw new PaymentNotFoundError(gatewayPaymentId);
    return record;
  }

  private portoneStatusFor(req: RefundRequest): "SUCCEEDED" | "REQUESTED" | "FAILED" {
    if (this.failOn.has(req.paymentKey)) return "FAILED";
    if (this.forcePending || this.pendingOn.has(req.paymentKey)) return "REQUESTED";
    return "SUCCEEDED";
  }

  /** 포트원 V2 `CancelPaymentResponse` 모양 */
  private buildPortoneCancelResponse(req: RefundRequest, status: "SUCCEEDED" | "REQUESTED" | "FAILED") {
    const now = this.clock().toString();
    const base = {
      status,
      id: deterministicId("cancel", req.idempotencyKey),
      totalAmount: req.amount,
      taxFreeAmount: 0,
      vatAmount: 0,
      reason: req.reason,
      requestedAt: now,
      trigger: "API",
    };
    if (status === "SUCCEEDED") {
      return { cancellation: { ...base, pgCancellationId: deterministicId("pg", req.idempotencyKey), cancelledAt: now } };
    }
    if (status === "REQUESTED") {
      // 가상계좌 환불의 정상 경로. 송금이 아직 안 끝나 cancelledAt·pgCancellationId 가 없다(실 포트원과 같은 모양)
      return { cancellation: base };
    }
    return { cancellation: { ...base, failureCode: this.failureCode, failureMessage: this.failureMessage } };
  }
}
