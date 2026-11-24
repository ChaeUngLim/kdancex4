// 공유 계약 §4.10(포트) — PaymentGatewayPort 의 1회차 구현. T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식).
// 옛 backend/app/adapters/payment_gateway.py 의 FakePaymentGateway(SCH-04(어댑터 3종: PG/알림/슬롯락))를
// 옮기고, 결제 발급·조회·취소(plan D9)를 더했다.
//
// - 원장은 **메모리**다. 기본값은 `globalThis` 에 붙인 원장이라 Next.js 개발 서버가 모듈을 다시 읽어도
//   남는다. 권위 있는 기록은 DB(payments·refunds·payment_webhook_events)이고, 멱등의 권위도 DB 유니크다.
//   그래서 이 원장이 사라져도 이중 반영은 생기지 않는다(plan D9).
// - 환불은 포트원 V2 응답 모양의 본문을 만들어 실 연동과 같은 파서(`parsePortoneCancelResponse`)에 통과시킨다.
// - 테스트는 `createFakePaymentGatewayStore()` 로 원장을 따로 만들어 주입한다.
// - 결제수단은 4종(카드·간편결제·간편 계좌이체·가상계좌, FR-280(결제수단 결정))을 모두 발급·조회한다
//   (S3-3.3(가짜 PG 수단 2종 더하기)). 환불은 가상계좌(옛 이관 경로)와 카드·간편결제 부분 취소(S4-1.5)를 받는다.
//   간편 계좌이체는 PG 가 돌려줄 길이 없어 대표 송금(owner_bank_transfer)으로 가므로 여기서 거부한다.
import { createHash } from "node:crypto";

import { PAYMENT_METHODS, type PaymentMethod } from "../../domain/constants";
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
/** 남은 취소 가능 금액보다 많이 취소하려 할 때 — 포트원 V2 `CancelAmountExceedsCancellableAmountError` 에 대응 */
export const CANCEL_AMOUNT_EXCEEDS_CODE = "CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT";
/** 승인되지 않은(입금 전·취소·만료) 결제를 부분 취소하려 할 때 */
export const PAYMENT_NOT_PAID_CODE = "PAYMENT_NOT_PAID";
/** PG 가 원거래를 부분 취소할 수 있는 수단(S4-1.5(수단별 환불 실행)) — 계좌로 들어온 돈은 대표 송금으로 간다 */
const PARTIAL_CANCEL_METHODS: readonly string[] = ["card", "easy_pay"];
const DEFAULT_FAILURE_MESSAGE = "PG사에서 환불 요청을 거절했습니다.";

interface FakePaymentRecord {
  readonly request: CreatePaymentRequest;
  readonly created: CreatePaymentResult;
  readonly status: GatewayPayment["status"];
  readonly paidAmount?: number;
  readonly paidAt?: Temporal.Instant;
  readonly transactionId?: string;
  /** 승인·입금 때 실제로 쓴 수단 — `deposit(…, { method })` 로 정했을 때만 있다(결제창에서 수단을 바꾼 경우를 흉내) */
  readonly approvedMethod?: PaymentMethod;
  /** 카드·간편결제 부분 취소로 이미 돌려준 금액 합(S4-1.5) — 취소할 수 있는 남은 금액을 따진다 */
  readonly cancelledAmount?: number;
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

// -- 수단별 발급 모양 (S3-3.3(가짜 PG 수단 2종 더하기)) ---------------------------- //
//
// 포트원 V2 에서 서버가 결제 정보를 바로 돌려받는 수단은 가상계좌 하나다. 카드·간편결제·간편 계좌이체는
// 셋 다 결제창(SDK `requestPayment`)에서 회원이 직접 결제한다(계약 17 §3-1). 그래서 가짜도
// 가상계좌 = 계좌 번호, 나머지 셋 = 결제창 키 로 나눈다. 포트는 고치지 않으므로 결제창 키는
// 기존 칸 `cardCheckoutKey` 에 담는다(이름은 카드지만 「결제창 키」라는 뜻으로 쓴다).
//
// 결제창 키 머리말을 수단마다 다르게 둔 이유: 로그·테스트에서 키만 보고도 어떤 수단 결제창인지
// 알 수 있게 하려는 것이다. 카드는 기존 주문 흐름이 쓰던 `checkout` 그대로 둔다.
const CHECKOUT_KEY_PREFIX = Object.freeze({
  card: "checkout",
  easy_pay: "checkout_easypay",
  easy_transfer: "checkout_transfer",
} as const satisfies Record<Exclude<PaymentMethod, "virtual_account">, string>);

/** 값 집합(`PAYMENT_METHODS`)에 있는 수단인지 — DB·요청에서 온 문자열을 막는 마지막 문 */
function isKnownMethod(method: unknown): method is PaymentMethod {
  return typeof method === "string" && (PAYMENT_METHODS as readonly string[]).includes(method);
}

/** 수단 하나에 대한 가짜 발급 결과. 같은 결제 번호면 늘 같은 값(결정적)이다 */
function issueFor(req: CreatePaymentRequest): CreatePaymentResult {
  if (req.method === "virtual_account") {
    return {
      status: "ready",
      virtualAccount: {
        bankCode: FAKE_VA_BANK_CODE,
        accountNumber: deterministicDigits(`va:${req.gatewayPaymentId}`, FAKE_VA_ACCOUNT_DIGITS),
        holder: FAKE_VA_HOLDER,
      },
    };
  }
  return { status: "ready", cardCheckoutKey: deterministicId(CHECKOUT_KEY_PREFIX[req.method], req.gatewayPaymentId) };
}

/**
 * 가짜 PG 를 알아보는 전역 표식(S3-3.14(가짜 PG dev 경로)). `instanceof` 대신 이것으로 판별한다 —
 * next dev 가 모듈을 다시 읽으면 클래스가 새로 만들어져, globalThis 에 남은 옛 인스턴스가 instanceof 에 안 걸린다
 * (fake-identity.ts 의 FAKE_IDENTITY_BRAND 와 같은 이유). Symbol.for 는 프로세스 전체에서 같은 값이다.
 */
export const FAKE_PAYMENT_GATEWAY_BRAND: unique symbol = Symbol.for("kdance.fakePaymentGateway") as never;

/** 이 구현이 가짜 PG 인가 — 실 PG 어댑터가 붙으면 거짓이 되어 dev 입금 경로가 404 를 낸다 */
export function isFakePaymentGateway(port: unknown): port is FakePaymentGateway {
  return typeof port === "object" && port !== null && (port as Record<symbol, unknown>)[FAKE_PAYMENT_GATEWAY_BRAND] === true;
}

export class FakePaymentGateway implements PaymentGatewayPort {
  /** 전역 표식 — isFakePaymentGateway 가 본다 */
  readonly [FAKE_PAYMENT_GATEWAY_BRAND] = true;
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
    // 모르는 수단은 결제창 키를 지어내 주지 않고 시끄럽게 실패한다 — 원장에도 남기지 않는다
    if (!isKnownMethod(req.method)) {
      throw new PaymentGatewayError(`지원하지 않는 결제수단입니다: ${JSON.stringify(req.method)}`);
    }
    assertPositiveAmount(req.amount);
    const existing = this.store.payments.get(req.gatewayPaymentId);
    if (existing) {
      const same = existing.request.method === req.method && existing.request.amount === req.amount;
      if (!same) throw new PaymentGatewayError("같은 결제 번호가 다른 내용으로 이미 발급됐습니다.");
      return existing.created;
    }

    const created = issueFor(req);
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
        // 승인 수단을 따로 정한 경우에만 알려 준다 — 없으면 웹훅 처리기가 결제 행의 수단을 쓴다
        ...(record.approvedMethod ? { method: record.approvedMethod } : {}),
      };
    }
    return { status: record.status, amount: record.request.amount };
  }

  /** 입금 전 취소·만료 때 계좌 폐기. 이미 취소·만료면 아무것도 하지 않는다. 승인된 카드·간편결제는 전액 취소, 입금된 계좌 결제는 환불 경로로 */
  async cancelPayment(gatewayPaymentId: string, _reason: string): Promise<void> {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "paid") {
      // 카드·간편결제 승인은 PG 가 전액 취소할 수 있다(포트원 결제 취소 — 계약 17 §3-3, S3-3.10).
      // 계좌로 들어온 돈은 PG 가 되돌릴 길이 없으니 예전처럼 거부한다(환불 경로·사람 송금)
      const method = record.approvedMethod ?? record.request.method;
      if (method !== "card" && method !== "easy_pay") {
        throw new PaymentGatewayError("입금된 결제는 취소할 수 없습니다. 환불 요청으로 처리하세요.");
      }
      this.store.payments.set(gatewayPaymentId, { ...record, status: "cancelled" });
      return;
    }
    if (record.status === "ready") {
      this.store.payments.set(gatewayPaymentId, { ...record, status: "cancelled" });
    }
  }

  // -- 환불 — 옛 refund 이식 ----------------------------------------------- //

  // 모르는 수단과 환불 계좌 누락은 둘 다 「잘못된 입력」처럼 보여도 다르게 다룬다. 모르는 수단(간편 계좌이체 포함)은 이 경로에 들어오면
  // 안 되는 프로그래밍 오류라 예외로 막고, 계좌 누락은 PG 가 거절할 만한 실패라 failed 결과로 돌려준다
  // (서비스가 사유를 감사 기록에 남길 수 있어야 한다).
  async refund(req: RefundRequest): Promise<RefundResult> {
    // 카드·간편결제는 원거래 부분 취소다(S4-1.5(수단별 환불 실행), 계약 12 §2-3 「포트 refund(부분 취소)」)
    if (PARTIAL_CANCEL_METHODS.includes(req.method)) return this.partialCancel(req);
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

  /**
   * 카드·간편결제 부분 취소. 같은 멱등 키는 처음 결과를 그대로 돌려준다(두 번 취소되지 않는다).
   * 원장에 그 결제가 있으면 실 PG 처럼 「승인된 결제인가」·「남은 취소 가능 금액 안인가」를 따져 실패로 돌려준다.
   * 원장에 없으면(개발 서버를 다시 켜 메모리 원장이 비었을 때) 금액 검사 없이 받는다 — 돈의 권위는 DB 다
   * (주문 환불 합계 CHECK `ck_orders_refunded_cap` 이 결제액 초과를 막는다, plan D9).
   */
  private partialCancel(req: RefundRequest): RefundResult {
    this.store.refundCalls.push({ ...req });
    const cached = this.store.refundLedger.get(req.idempotencyKey);
    if (cached) return cached;
    assertPositiveAmount(req.amount);

    const record = this.store.payments.get(req.paymentKey);
    let status = this.portoneStatusFor(req);
    let failure: { code: string; message: string } | null = null;
    if (record !== undefined && status !== "FAILED") {
      const paid = record.paidAmount ?? record.request.amount;
      const cancelled = record.cancelledAmount ?? 0;
      if (record.status !== "paid") {
        failure = { code: PAYMENT_NOT_PAID_CODE, message: "승인된 결제만 취소할 수 있습니다." };
      } else if (cancelled + req.amount > paid) {
        failure = { code: CANCEL_AMOUNT_EXCEEDS_CODE, message: `취소 가능 금액(${paid - cancelled}원)을 넘었습니다.` };
      }
      if (failure !== null) status = "FAILED";
    }
    const body = this.buildPortoneCancelResponse(req, status);
    const result = parsePortoneCancelResponse(
      failure === null ? body : { cancellation: { ...body.cancellation, failureCode: failure.code, failureMessage: failure.message } },
    );
    if (result.status === "failed") return result;
    // 성공·대기는 원장에 못박고, 승인 기록의 취소 누계를 올린다
    this.store.refundLedger.set(req.idempotencyKey, result);
    if (record !== undefined) {
      this.store.payments.set(req.paymentKey, { ...record, cancelledAmount: (record.cancelledAmount ?? 0) + req.amount });
    }
    return result;
  }

  // -- 시험 조작 (dev 경로·테스트 전용, 포트 밖) ------------------------------- //

  /**
   * 입금(카드면 승인)을 기록한다. 취소·만료된 결제에도 기록할 수 있다 — FR-292(만료 뒤 늦은 입금)를
   * 재현하려는 것이다. 같은 결제에 두 번 입금하면 거부한다.
   */
  deposit(
    gatewayPaymentId: string,
    amount: number,
    options: { method?: PaymentMethod } = {},
  ): { transactionId: string; paidAt: Temporal.Instant } {
    const record = this.requirePayment(gatewayPaymentId);
    assertPositiveAmount(amount);
    if (record.status === "paid") throw new PaymentGatewayError("이미 입금된 결제입니다.");
    if (options.method !== undefined && !isKnownMethod(options.method)) {
      throw new PaymentGatewayError(`지원하지 않는 결제수단입니다: ${JSON.stringify(options.method)}`);
    }

    const paidAt = this.clock();
    const transactionId = deterministicId("tx", `${gatewayPaymentId}:${amount}`);
    // options.method: 회원이 결제창에서 다른 수단(예: 계좌이체 주문인데 카드)으로 승인한 경우를 흉내 낸다(S3-3.10)
    this.store.payments.set(gatewayPaymentId, {
      ...record,
      status: "paid",
      paidAmount: amount,
      paidAt,
      transactionId,
      ...(options.method ? { approvedMethod: options.method } : {}),
    });
    return { transactionId, paidAt };
  }

  /** 입금 전 결제를 만료 상태로 둔다 */
  expire(gatewayPaymentId: string): void {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "ready") this.store.payments.set(gatewayPaymentId, { ...record, status: "expired" });
  }

  /**
   * 카드 승인 실패를 흉내 낸다(계약 03 §8 M-03, S3-3.8). 결제창을 연(ready) 결제만 `failed` 가 된다 —
   * 이미 입금·취소·만료된 결제는 그대로 둔다. 실패 통지 처리(payment-failure.ts)는 이 상태를 PG 재조회로 읽는다.
   */
  failApproval(gatewayPaymentId: string): void {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status === "ready") this.store.payments.set(gatewayPaymentId, { ...record, status: "failed" });
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

  /**
   * 승인 실패 웹훅 본문 — 계약 03 §6 모양에 `type = Transaction.Failed`(§8 M-03). 서명은 `signWebhook` 이 붙인다.
   * S3-3.15b(결제 화면용 서버 조각) — dev 경로 `…/fail` 이 이 본문으로 웹훅 처리기를 직접 부른다.
   * 원장이 `failed` 가 아닌 결제(입금됨·취소·만료·아직 ready)의 실패 통지는 만들지 않는다 — 있지도 않은 실패를 지어내지 않게.
   * 실패에는 거래 번호가 없어 `transactionId` 칸을 넣지 않는다(웹훅 본문 스키마에서 선택 칸이다).
   */
  buildFailedWebhookBody(gatewayPaymentId: string): {
    type: "Transaction.Failed";
    timestamp: string;
    data: { paymentId: string };
  } {
    const record = this.requirePayment(gatewayPaymentId);
    if (record.status !== "failed") {
      throw new PaymentGatewayError("승인이 실패하지 않은 결제의 실패 웹훅은 만들 수 없습니다.");
    }
    return { type: "Transaction.Failed", timestamp: this.clock().toString(), data: { paymentId: gatewayPaymentId } };
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
