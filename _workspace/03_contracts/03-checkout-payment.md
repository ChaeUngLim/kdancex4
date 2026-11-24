# API 계약 — 주문·결제·웹훅·만료 (US1-A3(결제 시작·만료·셀프 취소) · US1-A4(웹훅 확정 일괄 처리))

공통 규칙은 `README.md`. 관련 요구: FR-096(결제 대기 자리 잠금) · FR-097(먼저 입금 건 확정) · FR-110(PG 단일 결제 경로) · FR-111(상품별 기본 결제수단) · FR-111a(카드 허용 범위) · FR-280(결제수단 결정) · FR-115(결제 금액 대조) · FR-116(결제 통지 중복 반영 방지) · FR-117(체크아웃 가격 내역) · FR-282(결제 화면 필수 표시) · FR-283(결제액 계산 순서) · FR-284(주문 시점 값 고정) · FR-285(결제 기한) · FR-286(입금 전 셀프 취소) · FR-287(웹훅 확정) · FR-289(확정 후 일괄 처리) · FR-290(금액 불일치 입금) · FR-292(만료 뒤 늦은 입금).

## 1. `POST /api/orders` — 결제 시작

헤더: `Idempotency-Key`(필수, §4.9). 인증 필요.

> 2026-11-10 변경 — 결제수단은 상품 종류별로 나뉜다(이전: 단건 기본은 가상계좌, 모든 결제에서 카드 허용). 정규·단기 과정·개인 레슨은 카드가 기본이고 카드·간편결제·간편 계좌이체·가상계좌를 고를 수 있다. 이벤트형은 간편 계좌이체(기본)·가상계좌만 받으며, 서버가 카드·간편결제 주문 생성을 거부하고 카드 승인 통지는 확정하지 않고 전액 취소한다(FR-280(결제수단 결정)). 1회차 시드는 정규 수업뿐이라 이 계약의 흐름은 그대로고, 이벤트형 거부 규칙은 이벤트형 상품이 들어오는 후속 회차에서 넣는다.

요청
```json
{ "offeringId": "…", "seatKind": "male", "method": "virtual_account", "noticesAcknowledged": true }
```

서버 순서(**한 트랜잭션**, 외부 호출 1회 포함 — 아래 주의)

| # | 단계 | 실패 시 |
|---|---|---|
| 0-a | (S3-3.13, 2026-11-23 추가 — 플랜 S3-3 수용 ⑦ 추천값) 요청 제한: 회원 확인 바로 뒤, 키·본문 검사보다 먼저 센다. **IP 가 아니라 회원 한 명 기준**(R28(요청 제한이 정상 사용자를 막음) — 학원 공유기 하나로 여럿 접속). 같은 키 재요청도 1회로 센다. 값은 `RATE_LIMIT_CHECKOUT_MAX`·`RATE_LIMIT_CHECKOUT_WINDOW_SECONDS`(기본 1분 10회). Redis 가 꺼지면 막는 쪽으로 실패 | 429 `RATE_LIMITED` + `Retry-After`(README §6-4 모양) |
| 0 | 회원이 만 19세 이상인가(FR-009(미성년자 결제 차단) · Q17 임시 확정). `members.birth_date` 를 서버가 읽고 기준일은 요청 시각의 KST 날짜(생일 당일부터 통과). 가드 `assertMemberCanStartPayment`(S3-1.3) — 트랜잭션을 열기 전에 부른다 | 403 `MEMBER_UNDER_19`(「만 19세 미만은 직접 결제할 수 없어요. 보호자 계정에서 자녀로 신청해 주세요」). 코드 이름·상태 403 은 임시 확정(2026-11-23 S3-1.3 — 추천안으로 진행, 사후 확인) |
| 1 | 같은 회원·같은 키 주문이 있으면 그대로 200 | — |
| 2 | 기한 지난 주문 정리(§5, 이 판매 단위만) | — |
| 3 | 판매 단위 `open`·첫 회차 전, seatKind 가 seat_mode 와 맞는지 | 404 · 409 `CHECKOUT_CLOSED` · 422 |
| 3-a | 학원에 열린 「새 결제 막음」(`academy_restrictions.kind = 'new_sales_blocked'`, `ended_at IS NULL`)이 없는지(FR-250·FR-254, S3-3.4a). DB 의 열린 행만 읽고 국세청 API 는 부르지 않는다(점검은 새벽 작업 S1-1.28 몫). 이미 만든 주문·확정 예약은 그대로 — 1단계 재요청·M-04 복구는 이 단계 전에 돌려준다 | 409 `ACADEMY_RESTRICTED`(본문 `reason: "new_sales_blocked"`, 「지금은 이 학원의 새 신청을 받을 수 없어요」). 코드는 11·15 의 학원 제한 코드를 함께 쓴다 — 임시 확정(2026-11-23 S3-3.4a, 사후 확인) |
| 3-b | 결제수단이 상품 종류에 허용되는지(FR-280(결제수단 결정) · FR-111a(카드 허용 범위) 강제 방법 ②, S3-3.6). 이벤트형(원데이·이벤트·파티·공연·대회)은 `easy_transfer`·`virtual_account` 만, 그 밖은 네 수단 모두. 판정은 S3-3.1 `isPaymentMethodAllowed` — 결제 화면·통지 처리와 같은 표. 자리·주문·PG 호출 전이라 행이 남지 않는다 | 422 `METHOD_NOT_ALLOWED`(`fields: [{path: "method"}]`, 「이 수업은 계좌이체(간편 계좌이체·가상계좌)로만 결제할 수 있어요」). 코드는 14 의 행사 주문(S6-4 수용 ③ 옆 ②)과 같은 코드를 함께 쓴다 |
| 4 | 학원 현재 공지 판본 존재, `noticesAcknowledged=true` | 409 `NOTICE_MISSING` · 422 |
| 5 | 결제 기한 계산(§4) — 기한이 이미 지났으면 | 409 `CHECKOUT_CLOSED` |
| 6 | 가격 계산(§3) | — |
| 7 | 자리 잡기 조건부 UPDATE(data-model §4-4) | 409 `SEAT_SOLD_OUT` |
| 8 | orders `pending`(금액·공지 판본·중개자 고지 판본 고정, FR-284. **2026-11-10 추가:** 예매 수수료 `booking_fee_amount`·적용 수수료율 `platform_fee_rate_bp`·`cancel_fee_platform_share_bp`·약관 판본 `member_terms_version`·`merchant_terms_version` 도 같은 INSERT 에 고정 — data-model §6-2) · reservations `held` · order_events INSERT. 회원·판매 단위 활성 예약 유니크 충돌 | 409 `ALREADY_RESERVED` |
| 9 | `PaymentGatewayPort.createPayment(...)` → payments `ready` INSERT(가상계좌 정보 또는 카드 결제창 키) | PG 오류 → 전체 롤백, 500 `INTERNAL`(가짜 어댑터라 1회차에는 거의 없다) |

**주의 — 트랜잭션 안의 외부 호출**: 실 PG 로 갈 때는 9 를 트랜잭션 밖으로 빼고 「주문 먼저 커밋 → PG 호출 → 결제 행 갱신」 2단계로 바꿔야 한다(긴 잠금 방지). 1회차는 가짜 어댑터(메모리, 즉시 응답)라 한 트랜잭션에 둔다. 위험 R-P3 로 기록(plan §6).

응답 201(재생은 200)
```json
{ "orderId": "…", "status": "pending", "reservationId": "…", "seatKind": "male",
  "priceBreakdown": [ {"kind":"list_price","label":"정가","amount":120000},
                      {"kind":"benefit_discount","label":"혜택 할인","amount":0},
                      {"kind":"coupon_discount","label":"쿠폰","amount":0},
                      {"kind":"final","label":"최종 결제액","amount":120000} ],
  "payment": { "paymentId": "…", "method": "virtual_account", "status": "ready", "amount": 120000, "dueAt": "…Z",
    "virtualAccount": { "bankCode": "004", "accountNumber": "…", "holder": "케이댄스" }, "cardCheckout": null },
  "refundNoticeVersionId": "…", "intermediaryNoticeVersion": "2026-11-06" }
```
카드면 `virtualAccount: null`, `cardCheckout: {"checkoutKey":"…"}`(가짜 결제창 키).

**S3-3.4(주문 생성 API) 구현에서 정한 것(2026-11-23, 임시 확정 — 추천안으로 진행, 사후 확인)**
- 4단계의 「공지 판본」은 **수업에 고정된 판본**(`classes.refund_notice_version_id`, 이 학원의 것)이다. 수업 상세(02 §2, S3-2.4)가 회원에게 보여 준 판본과 같아야 해서다(FR-242(표시된 정책 우선)). 붙은 판본이 없으면 409 `NOTICE_MISSING`.
- 간편결제·간편 계좌이체도 결제창 수단이라 기한은 카드와 같은 `PAYMENT_CARD_DEADLINE_MINUTES`(15분)다(§4 표에 없던 두 수단 — FR-285 표의 간편 계좌이체 행).
- 예매 수수료(FR-282a)는 유료 이벤트형에만 2,000원 줄을 더한다. `member_terms_version` 은 회원 약관 판본 표(S7-3.1)가 생기기 전이라 `unversioned-beta`, `merchant_terms_version` 은 그 학원이 동의한 최신 `merchant_terms` 판본(없으면 같은 글자). `cancel_fee_platform_share_bp` = 5000(FR-125e).
- 응답의 `status` 는 새 주문·복구면 `pending`, 같은 키 재요청이면 그 주문의 지금 상태다.

**S3-3.12(0원 주문) 구현에서 정한 것(2026-11-23, 임시 확정 — 추천안으로 진행, 사후 확인)** — M-05(0원 신청) · 플랜 S3-3 수용 ⑥
- 6단계 결과 `total_amount = 0` 이면 9단계에서 **PG 를 부르지 않는다.** 5단계 결제 기한 검사도 건너뛴다(기다릴 입금이 없다 — 첫 회차가 코앞이어도 신청된다).
- 결제 행은 만든다: `amount 0` · 요청한 `method` 그대로 · `gateway_payment_id = free_<무작위>`(PG 에 보내지 않은 번호) · `gateway_payment_key`·`pg_reported_amount` NULL · `due_at` = 주문 시각. 주문당 살아 있는 결제 하나(`uq_payments_order_live`)를 전제로 읽는 경로가 그대로 돌게 하려는 것이다.
- 같은 트랜잭션에서 §6 6번 확정과 같은 처리를 한다(주문·결제 `paid` · 예약 `confirmed` · held −1 confirmed +1 · 캘린더 · 확정 알림 2건). order_events 사유는 `0원 바로 확정`. **정산 보류(`settlement_entries`)는 쓰지 않는다**(data-model 정산 ⑧ 「무료 수업 0원 줄은 원장에 안 쓴다」).
- 응답 201 은 `status: "paid"`, `payment.status: "paid"`, `amount: 0`, `virtualAccount: null`, `cardCheckout: null`. 같은 키 재요청도 PG 를 부르지 않는다. 다른 키로 다시 누르면 확정 예약이 있으니 409 `ALREADY_RESERVED`.
- 남은 빈칸: 0원 **이벤트형**은 등록 때 공지 판본이 붙지 않는데(data-model `classes.refund_notice_version_id` 「0원 이벤트형은 NULL」) `orders.refund_notice_version_id` 가 NOT NULL 이고 4단계가 판본을 요구해 409 `NOTICE_MISSING` 이 난다. 칸을 NULL 허용으로 바꿀지는 데이터 모델 결정이라 이 Task 에서 하지 않았다.

## 2. `GET /api/orders/{orderId}` · `POST /api/orders/{orderId}/cancel`

- 조회: 200 위와 같은 모양 + `status` 최신값. 남의 주문 403
  - (S3-3.15b 구현에서 정한 것, 2026-11-23 — 추천안·사후 확인) 없는 주문·모양이 틀린 id 404 `NOT_FOUND`, 남의 주문 403 `FORBIDDEN`(주인 확인이 정리·PG 조회보다 먼저). 읽기 전에 그 판매 단위의 기한 지난 결제 대기를 정리한다(§5) — 그래서 기한이 지난 주문은 `expired` 로 보인다. 결제창 키(`cardCheckout`)는 결제가 `ready` 일 때만 PG 에 다시 묻고, 끝난 결제(취소·만료·실패·입금)면 `null`. `Cache-Control: private, no-store`
- 셀프 취소(FR-286): `pending` 만 → 200 `{"orderId":"…","status":"cancelled"}`. 이미 `cancelled` → 200 같은 본문. `paid` → 409 `ORDER_NOT_CANCELLABLE`(`detail` 에 「입금 뒤에는 환불 요청으로만」). `expired` → 409 같은 코드
- 셀프 취소 처리: 주문 `cancelled` · 결제 `cancelled`(+ `PaymentGatewayPort.cancelPayment` 로 발급 계좌 폐기) · 예약 `cancelled`(`self_cancel_unpaid`) · held −1 · order_events. **환불 행을 만들지 않는다**(돈이 오가지 않았다) — 기존 취소 API 와 경로를 나눈 이유(plan D6)

## 3. 가격 계산 — 공유 계약 §4.6 의 가격 내역

```
final = list_price − benefit_discount − coupon_discount (+ booking_fee)   // 모두 원 단위 정수, 0 미만이면 0
```
`orders.total_amount` 는 이 식의 결과와 같아야 하고 DB `ck_orders_total_formula` 가 같은 식으로 검사한다(`GREATEST(0, list − benefit − coupon) + booking_fee_amount`, data-model §6-1, 2026-11-10 고침). 응답의 `priceBreakdown` 에서 `booking_fee` 줄이 있으면 그 `amount` 가 `booking_fee_amount` 이고, 없으면 0 이다. 스냅샷 비율 칸은 응답에 내리지 않는다(서버 내부 기록).

1회차: 혜택·쿠폰은 항상 0, 예매 수수료는 정규라 없음(FR-282a(예매 수수료 2,000원)는 원데이·이벤트형만). 계산 함수 자리는 FR-283(결제액 계산 순서) 그대로 둔다 — 나중에 할인을 끼울 자리다.

## 4. 결제 기한 — 전제 18(결제 기한 기본값)

| 수단 | dueAt | 설정 변수(기본값) |
|---|---|---|
| card | 주문 시각 + 15분 | `PAYMENT_CARD_DEADLINE_MINUTES=15` |
| virtual_account | min(발급 시각 + 24시간, 첫 회차 시작 − 60분) | `PAYMENT_VA_DEADLINE_HOURS=24`, `PAYMENT_VA_CUTOFF_MINUTES=60` |

순간(Instant) 계산이라 시간대가 끼지 않는다. 시계는 주입한다(`Clock`, `06-ports.md`). 가상계좌는 PG 에 이 `dueAt` 을 입금 마감으로 넘긴다.

## 5. 만료 정리

| 진입점 | 범위 |
|---|---|
| 읽기·쓰기 전 정리(`expireDuePayments({ offeringId? , now })`) | 홈 목록·상세·주문 생성 직전. `payments.status='ready' AND due_at <= now` |
| `POST /api/internal/orders/expire` | 전부. 헤더 `X-Internal-Token`. 응답 `{"expired": 3}`. 나중에 스케줄러가 부른다(1회차엔 부르는 주체 없음 — 위 정리가 주력) |

한 건 처리 = 한 트랜잭션: 주문 `pending→expired` 조건부 UPDATE(0행이면 건너뜀 — 그사이 입금 확정됨) · 결제 `expired` · 예약 `expired` · held −1 · order_events · `PaymentGatewayPort.cancelPayment`(계좌 폐기, 실패해도 만료는 유지하고 기록).

## 6. `POST /api/payments/webhook` — PG 결과 통지(FR-287)

포트원 V2 모양을 흉내 낸다(Q7(PG 결정 상태) — plan D9). 헤더 `webhook-id` · `webhook-timestamp` · `webhook-signature`(`v1,<base64 HMAC-SHA256(secret, id + "." + timestamp + "." + rawBody)>`). 비밀값 `PG_WEBHOOK_SECRET`. 포트원 실제 서명 규격과 같은지는 **미검증**(research R-11).

본문: `{ "type": "Transaction.Paid", "timestamp": "…Z", "data": { "paymentId": "<gateway_payment_id>", "transactionId": "…" } }`

| # | 처리 | 결과(`payment_webhook_events.result`) · HTTP |
|---|---|---|
| 1 | 서명·시각 검증(허용 오차 5분). 원문 바이트로 검증 | 실패 → 401 `INVALID_SIGNATURE`, 기록 `rejected_signature` |
| 1-a | (S3-3.13, 2026-11-23 추가 — 추천값·사후 확인) 서명 실패 횟수 제한: 1번이 실패한 요청만 센다(IP 로 나누지 않고 경로 전체 한 칸). 값은 `RATE_LIMIT_WEBHOOK_SIGNATURE_FAILURE_MAX`·`…_WINDOW_SECONDS`(기본 10분 20회). **서명이 맞는 요청은 세지도 막지도 않는다** — 정상 PG 재전송이 막히면 확정이 빠진다 | 한도를 넘은 틀린 서명 → 429 `RATE_LIMITED`, `rejected_signature` 기록 없음 |
| 2 | `webhook-id` 유니크 INSERT(ON CONFLICT DO NOTHING) | 충돌 → 200, `duplicate` |
| 3 | `type` 이 `Transaction.Paid` 아님 | 200, `ignored` |
| 4 | `PaymentGatewayPort.getPayment(paymentId)` 로 **PG 가 말하는 상태·금액**을 다시 묻는다(본문 금액을 믿지 않는다) | — |
| 5 | 세 금액 대조: 주문 `total_amount`(예매 수수료 포함) = 결제 `amount` = PG 응답 금액(FR-115) | 다르면 200, `amount_mismatch` + payment_exceptions `amount_mismatch` + 알림 `payment_refund_due` 2건(FR-290). 확정하지 않음 |
| 5-a | (S3-3.10, 2026-11-23 추가 — 추천안·사후 확인) 주문 스냅샷 `orders.class_kind` 가 이벤트형인데 승인 수단(PG 가 말한 수단, 없으면 `payments.method`)이 카드·간편결제 — S3-3.1 `isPaymentMethodAllowed` 로 판정(FR-111a(카드 허용 범위) 강제 방법 ③). 금액 대조보다 먼저 본다. **확정하지 않는다**: M-03 닫기 전이를 그대로(주문 `cancelled`·결제 `cancelled`·예약 `cancelled`(`payment_failed`)·held −1, `order_events.reason` = `이벤트형 카드 승인 전액 취소`) + `pg_reported_amount` 기록, 마지막에 `cancelPayment`(승인 전액 취소) 1회. 취소가 실패하면 전부 롤백 → 500(재전송이 다시 처리). 새 상태·CHECK 값은 만들지 않는다 | 200, `payment_failed` + 본문 `cancelledApproval: true`·`approvedMethod`·`notice` |
| 6 | 주문 `pending` → 확정 트랜잭션(data-model §4-1, FR-289) | 200, `confirmed` |
| 7 | 주문 `expired`·`cancelled`(끝 상태) → **확정하지 않는다.** payments 상태는 그대로, `pg_reported_amount` 기록 · payment_exceptions `deposit_on_closed_order`(`refund_due`, 입금액 전액) · 알림 `payment_refund_due` 2건(회원·대표) · order_events 사유 1행. 자리 유무를 보지 않는다 | 200, `deposit_on_closed_order`(FR-292(만료 뒤 늦은 입금) 2026-11-06 개정). 응답 본문 `{"result":"deposit_on_closed_order","orderStatus":"expired"}` — PG 재전송을 멈추려고 200 으로 받는다 |
| 8 | 주문 `paid` | 200, `ignored`(이미 확정. 같은 결제의 재통지) |

돌려줄 대상은 **`payment_exceptions` 에만** 남긴다. `refunds` 에는 넣지 않는다 — `refunds` 는 확정 예약의 환불 원장(`reservation_id` 필수)이고, 이 돈은 확정 예약이 없다. 실제 송금은 1회차 범위 밖(운영자·대표 처리, SCH-29(PG 결제))이다.

(S3-3.11(금액 불일치·늦은 입금·중복 결제), 2026-11-23 추가 — 추천안·사후 확인) 5·7행의 기록 규칙:
- **한 결제의 돈은 한 번만 돌려줄 대상이 된다.** 같은 결제에 예외 행이 종류와 상관없이 이미 있으면 새 행·알림을 만들지 않는다. 다른 금액으로 기록된 입금이 주문 만료 뒤 다시 통지돼도 `amount_mismatch` 1행만 남는다(유니크 `(payment_id, kind)` 만으로는 종류가 달라 못 막는다).
- `payment_exceptions.pg_transaction_id` = PG 재조회가 준 거래 번호. `received_amount` = PG 재조회 금액.
- 알림 `payment_refund_due` payload = `{ title, reason(kind), receivedAmount, orderAmount }`(연락처·계좌번호 없음). 대표 몫은 확정 알림과 같은 받는 사람 규칙(owner_member_id → 없으면 `academy_owners` 직원 계정마다, 칩 `settlement`, dedupe_key `order:<id>:refund_due:owner:<staff>`).
- **중복 결제(FR-291(중복 결제 환불))**: 주문 하나에 살아 있는 결제는 한 건뿐(`uq_payments_order_live`)이라, 1회차에서는 같은 결제의 통지가 여러 번 오는 모양으로만 생긴다. 6행 조건부 UPDATE 가 1건만 확정하고 나머지는 8행 `ignored`(돈은 한 번 들어왔다). PG 쪽 실제 이중 승인의 자동 전액 환불은 실 어댑터(S8-1) 몫이다.

2~7 은 한 트랜잭션. 확정 트랜잭션 중 하나라도 실패하면 전부 롤백하고 500 — PG 가 재전송하면 다시 처리된다(웹훅 기록도 같이 롤백되므로 재전송이 `duplicate` 로 빠지지 않는다).

「앱이 결제 완료 화면으로 돌아왔다」 는 서버에 아무 요청도 만들지 않는다. 앱은 `GET /api/orders/{id}` 로 상태를 다시 읽을 뿐이다(AC-3(웹훅 신뢰성)).

## 7. 시험 전용 — 가짜 PG 조작(`KDANCE_DEV_ROUTES=true`)

| 경로 | 하는 일 |
|---|---|
| `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/deposit` `{ "amount": 120000 }` | 가짜 PG 원장에 입금 기록 → 서명된 웹훅을 만들어 §6 처리기를 **직접 호출**(HTTP 왕복 없음). 응답 = 웹훅 처리 결과 |
| `POST /api/dev/fake-pg/webhooks/replay` `{ "webhookId": "…" }` | 같은 웹훅 재전송(중복 시험) |
| `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/fail` (본문 없음) | (S3-3.15b, 2026-11-23) 결제창을 연(`ready`) 결제의 승인 실패를 가짜 PG 원장에 기록 → 서명된 `Transaction.Failed` 웹훅을 만들어 §6 처리기를 직접 호출(§8 M-03). 응답 = 웹훅 처리 결과(`payment_failed` 면 `charged:false`·`notice`) + `webhookId`. 이미 입금·취소·만료·실패한 결제면 409 `PAYMENT_NOT_FAILABLE`, 모르는 결제 번호 404 |

테스트(vitest)는 이 경로 대신 어댑터 함수를 바로 부른다.

## 8. 2026-11-10 필수 기능 점검 보완 (추천안, 사용자 확인 대기)

출처: `_workspace/role-essentials/integration.md` M-03(결제 실패 시 자리 해제·주문 종료) · M-04(진행 중 주문 복구). 위 §1~§7 을 고치지 않고 덧붙인다. 상태·값 변경은 data-model §6-3.

- **M-03 카드 승인 실패**: §6 웹훅에 `type = Transaction.Failed` 를 처리하는 행을 추가한다. 서명·`webhook-id`·PG 재조회(4번)까지 같고, 주문이 `pending` 이면 → 주문 `cancelled`(`order_events.reason` = `결제 실패`) · 결제 `cancelled` · 예약 `cancelled`(`cancel_reason = payment_failed`) · held −1 을 한 트랜잭션에 하고 200 `payment_failed` 로 답한다. 이미 끝난 주문이면 `ignored`. 앱은 `GET /api/orders/{id}` 로 `cancelled` 를 읽고 「결제가 되지 않았고 돈이 청구되지 않았다」를 보여 준다. 다시 결제하면 새 `Idempotency-Key` 로 새 주문을 만든다.
- **M-04 진행 중 주문 복구**: §1 의 서버 순서 8번에서 같은 회원·같은 판매 단위의 `pending` 주문이 있으면 새 주문을 만들지 않고 그 주문을 **200 + 같은 모양**으로 돌려준다(결제창 이탈·앱 종료 뒤 재진입). 기한이 지난 주문은 2번 정리에서 이미 `expired` 라 새 주문이 만들어진다. `ALREADY_RESERVED` 는 `confirmed` 예약이 있을 때만 남는다.
- 둘 다 가짜 PG 시험 경로(§7)에 `fail` 조작을 더해야 AC 로 검증된다. ~~이 조작은 Task 로 만들지 않고 플랜을 다시 짤 때 정한다.~~
  **정함(2026-11-23 사용자 결정, S3-3.15b(결제 화면용 서버 조각))**: §7 표의 `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/fail` 로 만든다. 다른 dev 경로와 같이 `KDANCE_DEV_ROUTES=true` 일 때만 켜지고(아니면 처리기를 부르지 않고 404), 운영 배포 값 `false` 에서는 꺼진다. PG 구현이 가짜가 아니어도 404. 앱 결제 실패 화면(X2)을 실제 흐름으로 확인하는 데 쓴다.

