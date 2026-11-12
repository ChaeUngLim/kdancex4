// 공유 계약 §4.10(포트) — PaymentGatewayPort 와 포트원 V2 취소 응답 파서.
// T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식). 옛 backend/app/adapters/payment_gateway.py
// (SCH-04(어댑터 3종: PG/알림/슬롯락))를 옮겼다.
//
// 서비스는 이 포트만 안다. 구상 구현은 `lib/server/deps.ts` 한 곳에서 고른다(§4.10 머리말).
// 1회차 구현은 `lib/server/fakes/fake-payment-gateway.ts` 하나다(plan D9).
//
// 파서(`parsePortoneCancelResponse`)는 가짜 전용이 아니라 실 연동에서도 그대로 쓰는 코드다.
// 그래서 fakes 가 아니라 이 파일에 둔다 — 실 어댑터가 가짜 모듈을 import 하지 않게 하려는 것이다.
// 실 연동 때 바뀌는 것은 「HTTP 호출」 한 겹뿐이고, 상태 매핑은 지금 테스트로 덮인 채 남는다.
import type { PaymentMethod, RefundStatus } from "../../domain/constants";

// --------------------------------------------------------------------------- //
// 포트 — §4.10 그대로
// --------------------------------------------------------------------------- //

/** 발급된 가상계좌 */
export interface VirtualAccount {
  bankCode: string;
  accountNumber: string;
  holder: string;
}

export interface CreatePaymentRequest {
  gatewayPaymentId: string;
  method: PaymentMethod;
  /** 원 단위 정수 */
  amount: number;
  /** 가상계좌면 입금 마감, 카드면 결제창 마감 — `computeDueAt` 결과(계약 03 §4) */
  dueAt: Temporal.Instant;
  orderName: string;
}

export interface CreatePaymentResult {
  status: "ready";
  virtualAccount?: VirtualAccount;
  cardCheckoutKey?: string;
}

/** PG 가 말하는 결제 상태. 웹훅 본문을 믿지 않고 이것으로 다시 묻는다(FR-287(웹훅 확정), plan D9) */
export interface GatewayPayment {
  status: "ready" | "paid" | "cancelled" | "expired";
  /** 입금 뒤에는 실제 입금액 — FR-115(결제 금액 대조)의 「PG 응답 금액」 */
  amount: number;
  paidAt?: Temporal.Instant;
  transactionId?: string;
}

export interface PaymentGatewayPort {
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  getPayment(gatewayPaymentId: string): Promise<GatewayPayment>;
  /** 입금 전 취소·만료 — 발급 계좌 폐기 */
  cancelPayment(gatewayPaymentId: string, reason: string): Promise<void>;
  /** 옛 `PaymentGateway.refund` 그대로 이식 */
  refund(req: RefundRequest): Promise<RefundResult>;
}

// --------------------------------------------------------------------------- //
// 환불 요청·결과 — 옛 RefundAccount·RefundRequest·RefundResult
// --------------------------------------------------------------------------- //

/**
 * 환불 수취 계좌. 가상계좌 결제는 원거래 취소 수단이 없어 플랫폼이 회원 계좌로 새로 송금한다.
 * `holderPhoneNumber` 는 포트원 기준 선택값이지만 스마트로 가상계좌 취소에는 필수다.
 */
export interface RefundAccount {
  bankCode: string;
  accountNumber: string;
  holderName: string;
  holderPhoneNumber?: string;
}

/**
 * 환불 1건 요청. 결제수단을 메서드로 쪼개지 않고 요청 안 태그로 둔다(포트원 취소 API 가 하나다).
 * `method` 는 DB 에서 읽은 평문도 받도록 `string` 이다 — 검사는 구현이 한다.
 */
export interface RefundRequest {
  /** 원거래 식별자 = 포트원 `paymentId` */
  paymentKey: string;
  method: string;
  /** 원 단위 정수 */
  amount: number;
  /** 같은 논리 요청의 재시도를 같은 결과로 되돌리는 키 */
  idempotencyKey: string;
  refundAccount?: RefundAccount;
  /** 포트원 `reason`(필수) */
  reason: string;
}

/** 환불 결과. 포트원 `PaymentCancellation` 한 건에 대응한다. `rawResponse` 는 감사 기록용 원문 */
export interface RefundResult {
  status: RefundStatus;
  gatewayRefundId?: string;
  pgCancellationId?: string;
  totalAmount?: number;
  requestedAt?: Temporal.Instant;
  cancelledAt?: Temporal.Instant;
  failureCode?: string;
  failureMessage?: string;
  rawResponse: Readonly<Record<string, unknown>>;
}

/** 옛 기본 사유. 이번 슬라이스의 취소 사유는 `member_request` 하나뿐이다 */
export const DEFAULT_CANCEL_REASON = "회원 요청 취소";

/** 포트원이 모르는 취소 상태를 돌려줬을 때의 실패 코드 */
export const UNRECOGNIZED_STATUS_CODE = "UNRECOGNIZED_CANCELLATION_STATUS";

/** 환불 계좌 없이 가상계좌 환불을 시도했을 때의 실패 코드 */
export const REFUND_ACCOUNT_REQUIRED_CODE = "REFUND_ACCOUNT_REQUIRED";

/**
 * 포트원 V2 `PaymentCancellation.status` → 환불 상태.
 * 핵심은 `REQUESTED → pending` 이다. 가상계좌 환불은 즉시 끝나지 않아 포트원이 `REQUESTED` 를 돌려준다.
 * 이걸 실패로 접으면 정상 환불이 실패로 기록된다.
 */
export const PORTONE_CANCELLATION_STATUS_MAP: Readonly<Record<string, RefundStatus>> = Object.freeze({
  SUCCEEDED: "succeeded",
  REQUESTED: "pending",
  FAILED: "failed",
});

// --------------------------------------------------------------------------- //
// 예외
// --------------------------------------------------------------------------- //

/** PG 어댑터가 던지는 예외 전부의 공통 조상 */
export class PaymentGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentGatewayError";
  }
}

/**
 * 지원하지 않는 결제수단으로 환불을 시도했다. 카드 승인취소는 범위 밖이다(옛 Q2 확정).
 * 조용히 가상계좌 경로로 흘리면 없는 환불 계좌로 송금하는 꼴이라 시끄럽게 실패한다.
 */
export class UnsupportedPaymentMethodError extends PaymentGatewayError {
  readonly method: string;

  constructor(method: string) {
    super(`지원하지 않는 결제수단입니다: ${JSON.stringify(method)}. 이번 슬라이스는 virtual_account 환불만 지원한다.`);
    this.name = "UnsupportedPaymentMethodError";
    this.method = method;
  }
}

/** PG 원장에 없는 결제 번호 */
export class PaymentNotFoundError extends PaymentGatewayError {
  readonly gatewayPaymentId: string;

  constructor(gatewayPaymentId: string) {
    super(`PG 에 없는 결제입니다: ${JSON.stringify(gatewayPaymentId)}`);
    this.name = "PaymentNotFoundError";
    this.gatewayPaymentId = gatewayPaymentId;
  }
}

// --------------------------------------------------------------------------- //
// 포트원 요청 본문 변환 — 옛 to_portone_payload
// --------------------------------------------------------------------------- //

export interface PortoneRefundAccountPayload {
  bank: string;
  number: string;
  holderName: string;
  holderPhoneNumber?: string;
}

export interface PortoneCancelRequestPayload {
  paymentId: string;
  reason: string;
  amount: number;
  refundAccount?: PortoneRefundAccountPayload;
}

/** 포트원 V2 `refundAccount` 모양. PG 를 바꿀 때 바뀌는 곳은 이 함수 하나다 */
export function refundAccountToPortonePayload(account: RefundAccount): PortoneRefundAccountPayload {
  return {
    bank: account.bankCode,
    number: account.accountNumber,
    holderName: account.holderName,
    ...(account.holderPhoneNumber ? { holderPhoneNumber: account.holderPhoneNumber } : {}),
  };
}

/** 포트원 V2 `POST /payments/{paymentId}/cancel` 요청 본문 모양 */
export function refundRequestToPortonePayload(req: RefundRequest): PortoneCancelRequestPayload {
  return {
    paymentId: req.paymentKey,
    reason: req.reason,
    amount: req.amount,
    ...(req.refundAccount ? { refundAccount: refundAccountToPortonePayload(req.refundAccount) } : {}),
  };
}

// --------------------------------------------------------------------------- //
// 포트원 응답 파서 — 옛 parse_portone_cancel_response (실 연동에서도 그대로 쓴다)
// --------------------------------------------------------------------------- //

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 포트원 ISO 8601 시각 → 순간. 실패해도 예외를 올리지 않는다 — 시각 한 칸 때문에 환불 결과
 * 전체를 버리는 게 더 나쁘다. 오프셋이 없는 문자열은 옛 파서처럼 UTC 로 읽는다.
 */
function parsePortoneInstant(value: unknown): Temporal.Instant | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return Temporal.Instant.from(value);
  } catch {
    try {
      return Temporal.PlainDateTime.from(value).toZonedDateTime("UTC").toInstant();
    } catch {
      return undefined;
    }
  }
}

/**
 * 포트원 V2 취소 응답(`{ cancellation: {...} }`)을 `RefundResult` 로 바꾼다.
 * 실 연동 어댑터와 `FakePaymentGateway` 가 같은 함수를 쓴다.
 */
export function parsePortoneCancelResponse(payload: unknown): RefundResult {
  const raw: Readonly<Record<string, unknown>> = isRecord(payload) ? { ...payload } : {};
  const cancellation = raw.cancellation;
  if (!isRecord(cancellation)) {
    return {
      status: "failed",
      failureCode: UNRECOGNIZED_STATUS_CODE,
      failureMessage: "포트원 응답에 cancellation 오브젝트가 없습니다.",
      rawResponse: raw,
    };
  }

  const rawStatus = typeof cancellation.status === "string" ? cancellation.status : "";
  const mapped = Object.hasOwn(PORTONE_CANCELLATION_STATUS_MAP, rawStatus)
    ? PORTONE_CANCELLATION_STATUS_MAP[rawStatus]
    : undefined;

  let failureCode = optionalString(cancellation.failureCode);
  let failureMessage = optionalString(cancellation.failureMessage);
  if (mapped === undefined) {
    // 포트원이 새 변종을 추가한 경우. 성공으로 넘겨짚지 않고 실패로 떨어뜨리되 원문 상태를 남긴다.
    failureCode = failureCode ?? UNRECOGNIZED_STATUS_CODE;
    failureMessage = failureMessage ?? `알 수 없는 포트원 취소 상태: ${JSON.stringify(rawStatus)}`;
  }

  const totalAmount = cancellation.totalAmount;
  return {
    status: mapped ?? "failed",
    gatewayRefundId: optionalString(cancellation.id),
    pgCancellationId: optionalString(cancellation.pgCancellationId),
    totalAmount: Number.isSafeInteger(totalAmount) ? (totalAmount as number) : undefined,
    requestedAt: parsePortoneInstant(cancellation.requestedAt),
    cancelledAt: parsePortoneInstant(cancellation.cancelledAt),
    failureCode,
    failureMessage,
    rawResponse: raw,
  };
}
