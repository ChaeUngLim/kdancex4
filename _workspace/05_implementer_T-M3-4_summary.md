# Phase 5 구현 요약 — T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식)

슬라이스 S0-M3(순수 로직 이식) · 공유 계약 §4.10(포트) · plan D9(가짜 PG 원장·포트 모양) · research R-11(포트원 V2 웹훅 서명 규격) · SCH-04(어댑터 3종: PG/알림/슬롯락) 이식 · FR-287(웹훅 확정) 1단계

## 1. 변경 파일 (전부 신규, admin-web 아래)

| 파일 | 내용 |
|---|---|
| `lib/server/ports/payment-gateway.ts` | `PaymentGatewayPort` 4메서드(§4.10 시그니처 그대로) · `RefundAccount`/`RefundRequest`/`RefundResult` · 예외 3종(`PaymentGatewayError`·`UnsupportedPaymentMethodError`·`PaymentNotFoundError`) · `PORTONE_CANCELLATION_STATUS_MAP` · `parsePortoneCancelResponse`(옛 파서) · `refundRequestToPortonePayload`/`refundAccountToPortonePayload`(옛 `to_portone_payload`) |
| `lib/server/ports/webhook-verifier.ts` | `WebhookVerifier` 인터페이스 + 헤더 이름 상수 3개(`webhook-id`·`webhook-timestamp`·`webhook-signature`) |
| `lib/server/fakes/fake-payment-gateway.ts` | `FakePaymentGateway` — 메모리 원장(기본 `globalThis[Symbol.for("kdance.fakePaymentGateway.store")]`, 테스트는 `createFakePaymentGatewayStore()` 주입) · 발급/조회/취소 · 옛 refund(멱등 원장·실패 미고정·카드 거부) · 시험 조작 `deposit`·`expire`·`buildPaidWebhookBody`·`settleRefund`·`reset` |
| `lib/server/fakes/hmac-webhook-verifier.ts` | `HmacWebhookVerifier` + `signWebhook`(dev 경로·테스트용 서명기) |
| `tests/unit/adapters-pg.test.ts` | 51개 사례 |

`package.json`·lock·vitest 설정은 건드리지 않았다. 의존성은 Node 내장 `node:crypto` 와 기존 `temporal-polyfill` 뿐이다.

## 2. 실제 출력

```
$ cd admin-web && npx vitest run tests/unit/adapters-pg.test.ts
 RUN  v4.1.11 /home/user/kdance/admin-web
 Test Files  1 passed (1)
      Tests  51 passed (51)

$ npx tsc --noEmit -p . ; echo "tsc exit $?"
tsc exit 0
```

테스트를 먼저 쓰고 돌려 모듈이 없어 실패하는 것(Test Files 1 failed)을 확인한 뒤 구현했다.

## 3. 옛 테스트 → TS 테스트 대응 (이관 대응표 재료)

옛 파일 `backend/tests/test_adapters.py`. TS 테스트 이름 끝 `[옛 …]` 표기로 같은 대응을 남겼다.

| 옛 함수 | TS (`describe > test`) |
|---|---|
| `test_refund_status_values_match_db_check_constraint` | 포트원 상태 매핑 > 매핑 결과는 모두 REFUND_STATUSES 안의 값이다 (값 집합 자체는 T-M3-1(값 상수·금액·시각 도우미)·T-M2-2(값 집합 계약 일치 테스트) 몫) |
| `test_portone_requested_maps_to_pending_not_failed` | 포트원 상태 매핑 > 포트원 REQUESTED 는 실패가 아니라 pending 이다 |
| `test_parse_portone_succeeded_cancellation` | parsePortoneCancelResponse > SUCCEEDED 응답을 읽는다 |
| `test_parse_portone_requested_cancellation_has_no_settlement_fields` | parsePortoneCancelResponse > REQUESTED 응답에는 정산 필드가 없다 |
| `test_parse_portone_unknown_status_fails_loudly` | parsePortoneCancelResponse > 모르는 상태는 … 실패로 떨어뜨린다 |
| `test_parse_portone_malformed_payload_fails` | parsePortoneCancelResponse > cancellation 이 없는 응답은 실패다 |
| `test_refund_request_serializes_to_portone_field_names` | parsePortoneCancelResponse > 환불 요청을 포트원 필드 이름으로 바꾼다 |
| `test_refund_account_includes_holder_phone_when_present` | parsePortoneCancelResponse > 예금주 전화번호가 있으면 넣는다 |
| `test_fake_gateway_satisfies_protocol` | FakePaymentGateway.refund > 포트 타입을 만족한다 (런타임 Protocol 대신 타입 대입 + 메서드 존재) |
| `test_fake_gateway_produces_succeeded` | FakePaymentGateway.refund > 기본은 succeeded |
| `test_fake_gateway_produces_pending_via_pending_on` | … > pendingOn 이면 pending |
| `test_fake_gateway_produces_pending_via_force_pending` | … > forcePending 이면 전부 pending |
| `test_fake_gateway_produces_failed_via_fail_on` | … > failOn 이면 failed |
| `test_fake_gateway_is_deterministic` | … > 같은 입력이면 같은 식별자 |
| `test_fake_gateway_ledger_makes_retry_idempotent` | … > 같은 멱등키 재시도는 원장의 첫 결과를 돌려준다 |
| `test_fake_gateway_does_not_pin_failures_in_ledger` | … > 실패는 원장에 못박지 않는다 (옛 `fail_on.clear()` 변경 대신 같은 원장을 쓰는 새 인스턴스) |
| `test_fake_gateway_settle_promotes_pending_to_succeeded` | … > settleRefund 가 pending 을 succeeded 로 올린다 (`settle` → `settleRefund`) |
| `test_fake_gateway_fails_without_refund_account` | … > 환불 계좌 없는 가상계좌 환불은 failed |
| `test_card_method_raises_unsupported_payment_method_error` | … > 카드 환불은 예외로 막고 기록을 남기지 않는다 |
| `test_non_virtual_account_methods_are_rejected` (4 매개변수) | … > 가상계좌가 아닌 수단 %j 은 거부한다 (`test.each` 4건) |

옛 파일의 알림 3건은 T-M3-5(본인확인·알림 포트와 가짜 구현), 슬롯락 7건은 plan D8(슬롯 락 폐기)로 이관 대상이 아니다.

새로 더한 사례: 파서 2건(깨진 시각, 정수 아닌 금액) · 결제 원장 11건(발급 멱등·다른 내용 거부·카드 키·입금 전후 조회·늦은 입금·취소 멱등·만료·없는 번호·금액 검증·globalThis 공유·웹훅 본문 모양) · 웹훅 검증기 14건.

## 4. 보안 결정

| 결정 | 내용 |
|---|---|
| 상수 시간 비교 | `crypto.timingSafeEqual`. 디코딩한 서명이 32바이트(HMAC-SHA256)가 아니면 그 함수를 부르기 전에 거부 — 테스트 「길이가 다른 서명은 비교 전에 거부」(5바이트·64바이트) |
| 여러 서명 항목 | Standard Webhooks 처럼 공백으로 구분한 여러 `v1,…` 중 하나라도 맞으면 통과(비밀값 교체 기간). 항목은 끝까지 다 비교해 몇 번째가 맞았는지 시간으로 드러나지 않게 했다. 항목 수 상한 5 |
| 시각 허용 오차 | 계약 `03-checkout-payment.md` §6 1행 「허용 오차 5분」 → `DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300`. 과거·미래 양방향, 경계(정확히 300초)는 통과. timestamp 는 숫자 1~12자리만 |
| 형식 검사 | base64 정규식으로 먼저 거른다(`Buffer.from` 은 잘못된 문자를 조용히 버리기 때문). `v1` 이 아닌 버전·빈 값·헤더 누락은 false |
| 비밀값 | 생성자 주입만. 환경 변수(`PG_WEBHOOK_SECRET`)는 읽지 않는다 — `deps.ts` 몫. 빈 비밀값·0 이하 허용 오차는 생성자에서 거부, 오류 문구에 비밀값을 넣지 않는다(테스트로 확인) |
| `whsec_` 접두 | Standard Webhooks 관례대로 뒤를 base64 로 풀어 키로 쓴다. 접두가 없으면 UTF-8 바이트 그대로. 서명기·검증기가 같은 함수를 써서 어긋나지 않는다 |
| 원문 검증 | `verify` 는 파싱 전 원문 문자열을 받는다(계약 §6 「원문 바이트로 검증」) |
| 예외 없음 | `verify` 는 어떤 입력에도 false 를 돌려주고 던지지 않는다 — 처리기가 401 로 끝내기 쉽게 |

`ecc:security-reviewer` 리뷰는 Phase 8(코드 리뷰)에서 받는다. 구현 중에는 따로 부르지 않았다.

## 5. 구현 중 판단·불일치

1. **`HmacWebhookVerifier` 를 `fakes/` 에 두었다** — 배정 파일 목록대로다. 규격이 포트원 실제와 같은지 미검증(R-11)이라 이 위치가 맞다고 본다. 같으면 SCH-29(PG 결제) 때 옮긴다.
2. **파서는 `ports/payment-gateway.ts` 에 두었다** — 실 연동 어댑터가 가짜 모듈을 import 하지 않게. 옛 구조(파서가 프로덕션 코드)를 그대로 따른 것이다.
3. **포트 밖 시험 조작 메서드를 더했다**(`deposit`·`expire`·`buildPaidWebhookBody`·`settleRefund`·`reset`·`refundCalls`·`refundLedgerSize`). 계약 03 §7 dev 경로(입금 기록 → 서명된 웹훅)와 T-A4-2(금액 불일치·닫힌 주문 입금 처리)가 필요로 한다. **`deposit` 은 `cancelled`·`expired` 결제에도 기록된다** — FR-292(만료 뒤 늦은 입금) 재현용이고, 실 PG 에서 폐기된 가상계좌에 입금이 되는지는 확인하지 않았다.
4. **가짜 결제는 시각으로 스스로 만료되지 않는다.** 만료는 서비스가 판정하고(계약 §5) `cancelPayment` 를 부른다. `getPayment` 가 `expired` 를 돌려주는 경우는 `expire()` 를 직접 부를 때뿐이다.
5. **`createPayment` 멱등** — 같은 번호·같은 수단·같은 금액이면 첫 결과, 다르면 `PaymentGatewayError`. 계약에 명시가 없어 포트원의 중복 `paymentId` 거부를 흉내 냈다.
6. **설정 불변** — 옛 Fake 는 `fail_on` 집합을 테스트가 바꿨다. TS 판은 생성자 설정을 `ReadonlySet` 으로 고정하고, 원장(store)을 공유하는 새 인스턴스로 같은 시나리오를 만든다.
7. `RefundResult` 시각은 `Temporal.Instant`(§4.6 규칙), `rawResponse` 는 객체 얕은 복사.
8. `vitest` 는 `package.json` 에 아직 없고 `node_modules/.bin/vitest`(v4.1.11)로 돌았다 — T-M1-1(R2 스파이크) 쪽 설치로 보인다. 확인만 했고 손대지 않았다.

## 6. 차단·미해결

- 차단 없음.
- R-11(포트원 V2 웹훅 서명이 Standard Webhooks 와 같은가) 미검증 그대로. 키가 없어 1회차 실측 불가.
- `lib/server/deps.ts`(구상 주입)는 이 Task 범위가 아니다 — `PG_WEBHOOK_SECRET` 를 읽어 `new HmacWebhookVerifier({ secret })` 로 넘기는 일은 그쪽에서 한다.
