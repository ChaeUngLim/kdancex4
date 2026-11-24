# 계약 — 어댑터 포트·산정 함수 (공유 계약 §4.3 · §4.10)

옛 SCH-04(어댑터 3종: PG/알림/슬롯락)의 「서비스는 포트만 안다, 구상 클래스는 한 곳에서 주입」 원칙을 TS 로 잇는다. 서비스 함수는 포트를 **인자(deps 객체)** 로 받는다 — 옛 `lru_cache` 싱글턴 + `dependency_overrides` 대신이다. 구상 구현을 고르는 곳은 `admin-web/lib/server/deps.ts` 하나뿐이다.

## §4.3 산정 함수 시그니처

```ts
// admin-web/lib/domain/refund-policy.ts — SCH-03(환불액 산정) 이식. DB·IO 없음
calculateRefund(input: {
  paidAmount: number;              // 원 단위 정수
  startsAt: Temporal.Instant;
  now: Temporal.Instant;           // 반드시 주입
  tiers: readonly RefundPolicyTier[]; // §4.4
}): { refundRateBp: number; refundAmount: number; hoursBeforeStart: number }

// admin-web/lib/domain/money.ts — 공유 계약 §4.6
ceilMulDiv(amount: number, numerator: number, denominator: number): number // BigInt 로 계산, 결과·입력이 안전 정수인지 검사
computePriceBreakdown(input: { listPrice: number; benefitDiscount: number; couponDiscount: number; bookingFee: number }): PriceLine[]

// admin-web/lib/domain/payment-deadline.ts — 전제 18(결제 기한 기본값)
computeDueAt(input: { method: PaymentMethod; issuedAt: Temporal.Instant; firstSessionStartsAt: Temporal.Instant; config: DeadlineConfig }): Temporal.Instant
```

**§4.4 환불 비율표 JSONB 형태 — 그대로**: `[{"hours_before_start": 24, "refund_rate_bp": 5000}, …]`. 칸 이름은 DB·JSON 에서 snake_case 를 유지한다(옛 데이터와 같은 모양).

## §4.10 포트

```ts
type Clock = () => Temporal.Instant;

interface PaymentGatewayPort {
  createPayment(req: { gatewayPaymentId: string; method: 'virtual_account' | 'card'; amount: number;
                       dueAt: Temporal.Instant; orderName: string }): Promise<
    { status: 'ready'; virtualAccount?: { bankCode: string; accountNumber: string; holder: string }; cardCheckoutKey?: string }>;
  getPayment(gatewayPaymentId: string): Promise<{ status: 'ready' | 'paid' | 'cancelled' | 'expired'; amount: number;
                                                  paidAt?: Temporal.Instant; transactionId?: string }>;
  cancelPayment(gatewayPaymentId: string, reason: string): Promise<void>; // 입금 전 취소·만료 — 계좌 폐기
  refund(req: RefundRequest): Promise<RefundResult>;                     // 옛 refund 그대로 이식
}

interface WebhookVerifier { verify(headers: Headers, rawBody: string, now: Temporal.Instant): boolean }

interface IdentityVerificationPort {
  verify(token: string, now: Temporal.Instant): Promise<
    { ok: true; ciHash: string; name: string; gender: 'male' | 'female'; birthDate: Temporal.PlainDate; phone: string }
    | { ok: false; reason: 'invalid' | 'expired' }>;
}

interface NotificationSenderPort { deliver(notificationIds: readonly string[]): Promise<void> } // 커밋 뒤. 1회차 Fake = 기록만

// S0-4.10(특일 정보 수집 작업). 실패는 SpecialDayProviderError(code: HTTP_ERROR·RESULT_CODE·BAD_RESPONSE·TIMEOUT·NETWORK_ERROR·NOT_CONFIGURED)로 던진다 — 빈 배열로 돌려주지 않는다
interface SpecialDayProviderPort { fetchPublicHolidays(year: number): Promise<readonly { date: string; name: string; kind: HolidayKind }[]> }
```

| 포트 | 1회차 구현 | 상태 저장 |
|---|---|---|
| PaymentGatewayPort | `FakePaymentGateway` — 포트원 V2 응답 모양 + 옛 파서(`parse_portone_cancel_response`) 이식 | **메모리**(`globalThis` 에 붙여 개발 서버 재적재에도 유지). 권위 있는 기록은 DB(payments·refunds·webhook 원장) — plan D9 |
| WebhookVerifier | HMAC-SHA256(Standard Webhooks 모양) | — |
| IdentityVerificationPort | `FakeIdentityVerification` — 서명 토큰(HMAC, 비밀값 `FAKE_IDENTITY_SECRET`), CI = HMAC(`IDENTITY_CI_PEPPER`, personKey) | 없음 |
| NotificationSenderPort | `FakeNotificationSender` — 호출 기록 | 메모리 |
| SpecialDayProviderPort(S0-4.10) | `FakeSpecialDayProvider` — 연도별로 넣어 둔 응답(공휴일 목록 또는 실패 코드). 실 어댑터 `KasiSpecialDayProvider`(`lib/server/adapters/kasi-special-days.ts`, S0-4.11) — `PUBLIC_DATA_HOLIDAY_KEY` 가 있으면 deps.ts 가 고른다. 같은 계약 시험(`tests/unit/special-days-adapter.test.ts`)을 둘 다 통과 | 메모리 / 없음 |
| 슬롯 락 | **없음**(폐기 — plan D8) | — |

`ciHash` 는 원래 CI 를 저장하지 않으려고 HMAC 한 값이다. 실제 기관이 붙어도 같은 함수로 만든다.
