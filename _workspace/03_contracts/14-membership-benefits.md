# API 계약 — 멤버십·쿠폰·혜택·레벨·행사 피드 (M6: S6-1(회원·강사 멤버십 — 정기결제) · S6-2(1+1 쿠폰·참여 학원·대학생 혜택) · S6-3(레벨·카드·개강 후보) · S6-4(파티·공연·대회 피드))

공통 규칙은 `README.md`(경로 `/api` · 값 형식 §4.6 · 오류 §4.8 · 멱등 §4.9 · 직원 인증 §6). 데이터는 `evidence/penpot-doc-sync-2026-11-20/datamodel_draft_M6.md`(→ `03_data-model.md` §11). 작성 2026-11-20.

관련 요구: FR-112(멤버십 결제수단) · FR-112a(연 멤버십 10% 할인) · FR-112b(멤버십은 플랫폼 상품) · FR-112c(멤버십 전용 혜택) · FR-112d(신규 가입 3개월 체험) · FR-112e(강사 멤버십·1년 체험) · FR-113(정기결제 재시도) · FR-113a(멤버십 결제 수단 변경) · FR-297(멤버십 해지) · FR-297a(멤버십 환불 없음) · FR-120(멤버십 1+1 쿠폰) · FR-120a(쿠폰 생성 조건) · FR-120b(동반자 첫 수업 무료 쿠폰) · FR-121(1+1 쿠폰 사용 조건) · FR-121a(쿠폰 레벨 범위) · FR-121b(쿠폰 베타 적용 장르) · FR-121c(쿠폰 참여 학원) · FR-121i(참여 효과 리포트) · FR-122(1+1 쿠폰 소멸) · FR-123(쿠폰 본인 사용) · FR-123a(쿠폰 알림 세 순간) · FR-296(환불 후 쿠폰 처리) · FR-091a(정원 마감 시 결제·쿠폰 차단) · FR-006(대학생 이메일 인증)~FR-008(학교 이메일 미보관) · FR-118(대학생 첫 결제 50%) · FR-118a(대학생 할인 이벤트 팝업) · FR-119(할인 차액 대표 부담) · FR-160(레벨 0~10 부여) · FR-161(레벨 등급 구간) · FR-162(레벨 부여 제한) · FR-164(개강 후보 추천) · FR-165(후보 연락처 동의) · FR-169(세부 장르별 레벨 자동 계산) · FR-169a(출석률 반영 레벨) · FR-169d(강사 레벨 등급 조절) · FR-169e(등급 카드 발급 애니메이션) · FR-169f(카드 모음 화면) · FR-272(명단 출력 동의) · FR-150(파티·공연·대회 피드)~FR-157(공연 출연자) · FR-299(결제 정보 보안) · FR-185(감사 기록).

보드: M18(멤버십 가입) · M18B(멤버십 관리·해지 확인) · C8A(자동 결제 실패) · C8B(갱신 완료) · C16A(결제 수단 바꾸기) · C16B(갱신 7일 전 안내) · I9C(강사 멤버십 시트) · I29(체험 끝나기 30일 전) · I37·I37B(강사 멤버십 잠김·해지) · M17(대학생 인증) · M19·M19N·C28A(쿠폰함·지난 쿠폰) · C7A(1+1 무료 수업 고르기) · W7a·O41(1+1 참여·효과) · C32A·C32B(순위판·참여학원 목록) · M25·M25B·M25C(등급 카드 발급 3장) · M26·M26B·C24A(카드 모음) · I23(레벨 정하기 시트) · I15·I15B(새 반 열기 추천·후보 명단) · M24(행사 피드) · C3A·C3B·C3C(파티·공연 상세·신청) · C18A(대회 참가 신청).

**용어**: 유료 상품 이름은 「멤버십」이다(회원·강사·대표 모두). 「구독」은 학원 소식 받기(FR-023a)에만 쓴다 — 이 계약의 경로·코드·칸 이름에 `subscription` 을 쓰지 않는다.

## 0. 공통

| 항목 | 규칙 |
|---|---|
| 회원 경로(`/api/me/**`·`/api/events/**` 일부) | `requireMember`(README §2). 가입 미완료 403 `SIGNUP_INCOMPLETE` |
| 직원 경로(`/api/staff/**`·`/api/instructor/**`·`/api/academies/{academyId}/**`) | `requireStaff`(README §6-2). 강사 앱 경로는 `surface='app'`, 관리자 웹은 `'web'`. 대표 권한은 `owner` — 위임 강사는 열리지 않는다 |
| 운영자 경로(`/api/admin/**`) | 권한 `admin`(README §6-2 4번). 2단계 인증을 마친 웹 세션 |
| 내부 작업(`/api/internal/jobs/**`) | 헤더 `X-Internal-Token`(README §1). 전부 **멱등**이다. 본문 `{ "asOf": "…Z" }` 는 **`KDANCE_DEV_ROUTES=true` 일 때만** 쓴다(시험용 시계 — 아니면 무시). 응답은 처리 건수 |
| 정기결제 포트(빌링) | `PaymentGatewayPort` 와 따로 `BillingPort` 를 둔다(06-ports.md 에 더할 시그니처 — 아래 가정은 **SP-3(S6-1.1) 조사 결과가 이긴다**): `issueBillingKey(token)` → `{ billingKey, kind, autoRenewable, displayLabel }` · `charge({ billingKey, amount, gatewayPaymentId })` → `{ ok: true, transactionId } \| { ok: false, failureCode, failureMessage }` · `deleteBillingKey(billingKey)`. 가짜 구현은 카드 번호 끝자리로 성공·실패를 정한다(시험용). 서비스 코드는 포트만 import 한다 |
| 금액 | 원 단위 정수. 연 멤버십 요금은 앱 함수 `computeYearlyPrice` 가 계산하고 요금표(`membership_plans`)에 고정한다 |
| 개인정보 | 응답·로그·감사 기록에 **빌링 키·카드 번호·학교 이메일 원문·연락처 전체**를 넣지 않는다(FR-299 · FR-008 · FR-187). 가린 값만 내린다 |
| 알림 | 알림 **행**은 사건과 같은 트랜잭션에서 쓰고 `dedupe_key` 를 준다. 발송은 커밋 뒤(06-ports.md `NotificationSenderPort`, 실 발송은 M7) |

---

## 1. S6-1 회원 멤버십 — 권한 회원 본인

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/membership/plans` | 요금표(회원용 2종 + 연 할인 비교) | — | FR-112 · FR-112a | M18 |
| `GET /api/me/membership` | 지금 멤버십 상태·다음 결제·혜택 열림 | — | FR-112c · FR-112d · FR-113 | M18 · M18B · C8A · C8B · C16B |
| `POST /api/me/membership` | 가입(첫 결제) — 3개월 또는 연 | `Idempotency-Key` | FR-112 · FR-112a · FR-297a | M18 |
| `POST /api/me/membership/renew` | 직접 결제 수단의 다음 기간 결제 | `Idempotency-Key` | FR-112 | C16A(직접 결제) |
| `GET /api/me/billing-methods` | 등록한 결제 수단(가린 값) | — | FR-113a | C16A |
| `POST /api/me/billing-methods` | 정기결제 수단 등록(빌링 키 발급 결과 전달) | `Idempotency-Key` | FR-112 · FR-113a | C16A |
| `PUT /api/me/membership/billing-method` | 다음 결제부터 쓸 수단 바꾸기 | 같은 값이면 200 | FR-113a | C16A |
| `POST /api/me/membership/plan-change` | 3개월 → 연으로 다음 기간부터 바꾸기 | 같은 값이면 200 | FR-120a | M18B |
| `POST /api/me/membership/cancel` | 해지(다음 결제만 멈춤) | 이미 해지 예약이면 200 | FR-297 · FR-297a | M18B |
| `POST /api/me/membership/cancel-undo` | 기간 끝나기 전 해지 취소 | 이미 `active` 면 200 | FR-297 | M18B · I37B |

### 1-1. `GET /api/membership/plans`

200
```json
{ "plans": [
    { "code": "member_3m",   "label": "3개월 멤버십",    "priceAmount": 3000,  "periodMonths": 3,  "autoRenewable": true },
    { "code": "member_year", "label": "연 멤버십",       "priceAmount": 10800, "periodMonths": 12, "autoRenewable": true } ],
  "yearComparison": { "threeMonthTimesFour": 12000, "discountAmount": 1200, "yearPrice": 10800 },
  "notices": { "noRefundAfterPayment": true, "cancelStopsNextBillingOnly": true } }
```
결제 화면에는 3개월 멤버십 네 번 합계·할인액·연 요금을 나란히 보인다(FR-112a). `notices` 는 「결제한 뒤에는 환불되지 않아요」「해지하면 다음 결제만 멈추고 낸 기간은 끝까지 써요」를 화면이 결제 전에 반드시 띄운다는 표시다(FR-297a).

### 1-2. `GET /api/me/membership`

200 — 체험 중(M18)
```json
{ "membership": { "status": "trial", "planCode": null, "trial": { "endsAt": "2027-03-01T14:59:59Z", "daysLeft": 41 },
                  "period": null, "next": null, "billingMethod": null, "retry": null, "cancel": null },
  "benefits": { "aiSearch": true, "waitlist": true, "academyNews": true, "oneToOneCoupon": false, "companionCoupon": false },
  "trialCouponNote": "체험에는 쿠폰이 없어요" }
```
200 — 3개월 멤버십 2개월째(M18B)
```json
{ "membership": { "status": "active", "planCode": "member_3m", "trial": null,
                  "period": { "startsAt": "2026-10-14T15:00:00Z", "endsAt": "2027-01-14T14:59:59Z", "monthIndex": 2 },
                  "next": { "billingDate": "2026-12-15", "amount": 3000, "couponOnRenew": "one_plus_one" },
                  "billingMethod": { "id": "…", "kind": "card", "label": "카드 ****1234", "autoRenew": true },
                  "pendingPlanCode": null, "retry": null, "cancel": null },
  "benefits": { "aiSearch": true, "waitlist": true, "academyNews": true, "oneToOneCoupon": true, "companionCoupon": false } }
```
자동 결제가 실패한 상태(C8A) — `status: "retrying"`
```json
{ "membership": { "status": "retrying", "planCode": "member_3m", "period": { "…": "…" },
                  "retry": { "failedAt": "2026-12-15T01:00:00Z", "failureMessage": "유효기간 만료", "attemptsDone": 1,
                             "schedule": [ { "date": "2026-12-16", "attemptNo": 1, "result": "failed" },
                                           { "date": "2026-12-17", "attemptNo": 2, "result": "scheduled" },
                                           { "date": "2026-12-18", "attemptNo": 3, "result": "scheduled", "isLast": true } ],
                             "endsOn": "2026-12-18" },
                  "billingMethod": { "id": "…", "kind": "card", "label": "카드 ****1234", "autoRenew": true } },
  "benefits": { "aiSearch": true, "waitlist": true, "academyNews": true, "oneToOneCoupon": true, "companionCoupon": false } }
```
- 혜택(`benefits`)은 `trial`(쿠폰 제외)·`active`·`retrying`·`cancel_scheduled` 에서 열리고 `expired`·`ended` 에서 잠긴다. 서버가 함수 하나로 계산한다. `oneToOneCoupon` 은 3개월 멤버십 회원에게만, `companionCoupon` 은 연 멤버십 회원에게만 true(FR-120)
- 멤버십 행이 하나도 없으면 `{ "membership": null, "benefits": { … 모두 false } }`
- 응답에 빌링 키·카드 번호 전체를 넣지 않는다

### 1-3. `POST /api/me/membership` — 가입(첫 결제)

헤더 `Idempotency-Key`(필수, 8~200자) · 요청
```json
{ "planCode": "member_year", "billingMethodId": "…", "noticesAcknowledged": true }
```
직접 결제 수단이면 `billingMethodId` 대신 `"method": "virtual_account"`(또는 `"manual_transfer"`)을 보낸다.

| # | 단계 | 실패 시 |
|---|---|---|
| 1 | 같은 회원·같은 키 요청이 있으면 그 결과를 200 으로 돌려준다 | — |
| 2 | `noticesAcknowledged=true`(결제 뒤 환불 없음 고지 확인, FR-297a) | 422 `VALIDATION_FAILED` |
| 3 | 살아 있는 멤버십이 `trial` 이 아니면 거부(체험 중에 결제는 허용 — 체험은 끝나고 결제 기간이 시작한다, 열린 점 ②) | 409 `MEMBERSHIP_ALREADY_ACTIVE` |
| 4 | 요금표에서 `planCode` 의 지금 유효한 값을 읽어 금액을 고정(서버 계산 — 요청의 금액은 받지 않는다) | 422 `VALIDATION_FAILED` |
| 5 | 자동 갱신 수단이면 `BillingPort.charge` 즉시 청구. 직접 결제면 PG 에 발급(가상계좌 등)하고 charge `ready` | — |
| 6 | 청구 실패면 멤버십은 만들지 않고(체험은 그대로) 사유를 돌려준다 | 409 `MEMBERSHIP_PAYMENT_FAILED` |
| 7 | 성공이면 **한 트랜잭션**: `memberships` `active`(`anchor_date` = 오늘 KST) · charge `succeeded` · 쿠폰 발급(3개월 → 1+1 한 장 · 연 → 동반자 쿠폰 한 장) · 알림 `coupon_issued` · 이벤트 행 | — |

201(자동 갱신 수단, 즉시 성공)
```json
{ "membership": { "status": "active", "planCode": "member_year", "period": { "startsAt": "…Z", "endsAt": "…Z" },
                  "next": { "billingDate": "2027-11-20", "amount": 10800 } },
  "charge": { "id": "…", "status": "succeeded", "amount": 10800, "paidAt": "…Z" },
  "coupons": [ { "id": "…", "kind": "companion_free", "expiresAt": "…Z" } ] }
```
201(직접 결제 — 입금 대기)
```json
{ "membership": null,
  "charge": { "id": "…", "status": "ready", "amount": 10800, "dueAt": "…Z",
              "virtualAccount": { "bankCode": "088", "accountNumber": "110…", "holder": "K-DanceX4" } } }
```
입금이 확인되면 웹훅(`POST /api/payments/webhook`, 03 §6)이 `gateway_payment_id` 접두어(`mbr_`)로 이 청구를 찾아 위 7번을 실행한다. 금액·서명·멱등 규칙은 03 §6 과 같다.

오류

| HTTP | code | 언제 |
|---|---|---|
| 409 | `MEMBERSHIP_ALREADY_ACTIVE` | 이미 결제한 멤버십이 살아 있다 |
| 409 | `MEMBERSHIP_PAYMENT_FAILED` | 청구 실패. 본문 `failureMessage`(카드사 응답 문구, 개인정보 없음) |
| 422 | `BILLING_METHOD_INVALID` | 내 수단이 아니거나 `removed` · 직접 결제 수단과 자동 갱신 수단을 같이 보냄 |
| 422 | `VALIDATION_FAILED` | `planCode` 값 밖 · 고지 확인 안 함 |
| 400 | `BAD_REQUEST` | `Idempotency-Key` 없음 |

### 1-4. 결제 수단 — `GET /api/me/billing-methods` · `POST /api/me/billing-methods` · `PUT /api/me/membership/billing-method`

`POST /api/me/billing-methods` 요청 — 결제창이 돌려준 빌링 키 발급 토큰을 그대로 전달한다
```json
{ "kind": "card", "issueToken": "…" }
```
201 `{ "id": "…", "kind": "card", "label": "카드 ****5678", "autoRenew": true, "provider": "…" }`. 서버가 `BillingPort.issueBillingKey` 로 키를 받아 **암호화해 저장**하고 응답에는 키를 내리지 않는다. `autoRenew` 는 PG 가 알려 준 값이다(간편결제 중 정기결제를 지원하지 않는 것은 `false` — 화면에 「자동 갱신 안 됨」을 표시, FR-112).

`PUT /api/me/membership/billing-method` 요청 `{ "billingMethodId": "…" }`(C16A `카드 ****5678 로 바꾸기`)
- 200 `{ "membership": { …1-2 모양 }, "appliesFrom": "2026-12-15" }`. **바꿀 때 돈이 나가지 않는다.** 바꾼 수단은 다음 결제(`retrying` 이면 남은 다시 결제)부터 쓴다
- 직접 결제 수단으로 바꾸면 `auto_renew=false` 가 되고 기간 끝 3일 전 알림 대상이 된다. 같은 트랜잭션에서 알림 `membership_billing_method_changed` + 감사 `membership.billing_method_changed`(가린 값만)
- `status` 가 `trial`·`expired`·`ended` 면 409 `MEMBERSHIP_STATE_CONFLICT`
- 이미 그 수단이면 200 같은 본문(알림·감사 없음)

### 1-5. `POST /api/me/membership/plan-change` — 3개월 → 연

요청 `{ "toPlanCode": "member_year" }`(M18B `연 멤버십으로 바꾸기`). 200 `{ "pendingPlanCode": "member_year", "effectiveAt": "2027-01-14T15:00:00Z", "firstYearlyBilling": 10800 }`. 남은 3개월 기간이 끝나는 날 연 결제가 되고(FR-120a), 그 결제부터 1+1 대신 동반자 쿠폰 한 장을 받는다. 이미 받은 1+1 쿠폰은 기간 안에 쓴다. 연 → 3개월 방향은 받지 않는다(422 `VALIDATION_FAILED`). 감사 `membership.plan_changed`.

### 1-6. 해지 — `POST /api/me/membership/cancel` · `POST /api/me/membership/cancel-undo`

- `cancel`: `active`·`retrying` → `cancel_scheduled`. 200 `{ "status": "cancel_scheduled", "accessUntil": "…Z", "refund": null }`. **다음 결제만 멈추고 이미 낸 기간은 끝까지 쓴다. 환불 경로는 없다**(FR-297a) — 응답에 환불 칸이 없다. 이미 `cancel_scheduled` 면 200 같은 본문. `trial` 이면 409 `MEMBERSHIP_STATE_CONFLICT`(체험은 해지할 것이 없다)
- `cancel-undo`: `cancel_scheduled` → `active`(기간 안에서만). 기간이 이미 끝났으면 409 `MEMBERSHIP_STATE_CONFLICT`
- 해지 알림 `membership_cancel_requested`(끝나는 날 포함) + 감사 `membership.cancel_requested`
- 법에 따라 환불할 일이 생기면 운영자 문의로 처리한다(FR-297 — `15-ops.md`의 문의). 이 계약에 환불 경로를 만들지 않는다

### 1-7. `POST /api/me/membership/renew` — 직접 결제 수단의 다음 기간

자동 갱신이 안 되는 수단(일반 계좌이체·가상계좌)은 한 기간만 결제된다. 끝나기 3일 전 알림(`membership_manual_pay_notice`)을 받은 회원이 이 경로로 다음 기간을 결제한다. 요청 `{ "method": "virtual_account" }` + 헤더 `Idempotency-Key`. 201 `{ "charge": { "status": "ready", "amount": 3000, "dueAt": "…Z", "virtualAccount": { … } } }`. **기간이 끝나기 전에 입금이 확인되면 `current_period_end` 를 이어서 늘린다**(끊기지 않았으므로 계속된 것으로 본다). 기간이 끝난 뒤(`expired`)에는 409 `MEMBERSHIP_STATE_CONFLICT` — 새 가입(1-3)으로 간다. 한 기간에 이미 `ready`·`succeeded` 청구가 있으면 200 으로 그 청구를 돌려준다.

---

## 2. S6-1 강사·대표 멤버십 — 권한 로그인 직원 본인(`requireStaff`, 앱·웹 모두)

회원 멤버십과 **같은 모양**이다. 다른 점만 적는다(보드 I9C · I29 · I37 · I37B).

| 메서드·경로 | 역할 | 멱등 | 근거 FR |
|---|---|---|---|
| `GET /api/staff/membership` | 강사 멤버십 상태(I9C 시트) | — | FR-112e |
| `POST /api/staff/membership` | 체험 뒤 가입(월 또는 연) | `Idempotency-Key` | FR-112e |
| `POST /api/staff/membership/renew` | 직접 결제 수단의 다음 기간 | `Idempotency-Key` | FR-112 |
| `GET /api/staff/billing-methods` | 결제 수단 목록 | — | FR-113a |
| `POST /api/staff/billing-methods` | 수단 등록 | `Idempotency-Key` | FR-113a |
| `PUT /api/staff/membership/billing-method` | 수단 바꾸기 | 같은 값이면 200 | FR-113a |
| `POST /api/staff/membership/plan-change` | 월 → 연(다음 기간부터) | 같은 값이면 200 | FR-112e |
| `POST /api/staff/membership/cancel` | 해지 | 이미 예약이면 200 | FR-297 |
| `POST /api/staff/membership/cancel-undo` | 해지 취소 | 이미 `active` 면 200 | FR-297 |

- 요금: `instructor_month` 10,000원 · `instructor_year` 108,000원(120,000원에서 10% 할인). 가입 요청 `planCode` 는 이 두 값만. 회원용 값이면 422 `VALIDATION_FAILED`
- `GET /api/staff/membership` 응답은 1-2 와 같은 모양에 다음을 더한다. 가격·기한은 **이 시트에서만** 준다(FR-112e 「화면 문구 원칙」 — 마이·홈 응답에는 넣지 않는다)

```json
{ "membership": { "status": "trial", "trial": { "endsAt": "2027-05-03T14:59:59Z", "daysLeft": 210, "autoChargeAfterEnd": false },
                  "plans": [ { "code": "instructor_month", "priceAmount": 10000 }, { "code": "instructor_year", "priceAmount": 108000, "discountAmount": 12000 } ] },
  "features": { "rosterAndLevels": true, "calendar": true, "pastClasses": true, "aiSearch": true, "newClassRecommendation": true },
  "alwaysFree": ["class_registration", "settlement_view", "basic_notifications"] }
```
- `features` 는 서버가 멤버십 상태로 계산한다(`trial`·`active`·`retrying`·`cancel_scheduled` 에서 true). 끝나면(`expired`·`ended`) 모두 false — 클라이언트는 이 값으로 잠김 안내 창(I37)을 띄운다. 데이터는 지우지 않아 다시 가입하면 그대로 돌아온다(FR-112e)
- **강사 멤버십이 필요한 기능을 쓰려 하면 막지 않고 안내하게 하는 서버 코드**: 해당 경로(§5·§6 의 레벨·후보 경로, 회차 상세 명단 등)가 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED` 를 낸다. 화면은 「멤버십 기능이에요」 + `멤버십 알아보기` 창을 띄운다(I37)
- 체험은 **본인확인 CI 한 사람당 한 번**(`trial_grants`) — 강사 계정 활성일(대표는 입점 승인일)부터 1년. 같은 CI 로 다시 가입하면 체험 없이 `membership` 행이 없다. 체험 끝 30일 전·7일 전 안내는 내부 작업(§3)이 알림 `membership_trial_ending` 을 쓴다(I29)
- 대표 가맹점 프로모션(수수료 5% 시작일부터 1년 더 무료)은 같은 행의 `trial_ends_at` 을 늘려 표현한다. 늘리는 시점은 M5 의 수수료 시작일(`platform_fee_exempt_until`)이 정한다(열린 점 ⑤)
- 강사 멤버십 해지 시트(I37B)의 날짜 문구용으로 `GET /api/staff/membership` 이 `cancelPreview: { "accessUntil": "…", "nextBillingDate": "…" }` 를 함께 내린다

---

## 3. 내부 작업 — `X-Internal-Token`, 전부 멱등

| 메서드·경로 | 하는 일 | 멱등의 근거 | 근거 FR |
|---|---|---|---|
| `POST /api/internal/jobs/membership-renewal-notices` | 자동 갱신 **7일 전**(추천값) 고지 알림 + 직접 결제 수단 기간 끝 **3일 전** 알림 | `uq_membership_notices (membership_id, kind, target_date)` | FR-112 · C16B |
| `POST /api/internal/jobs/membership-billing` | 갱신일에 도래한 청구 실행 + 실패한 청구의 다시 결제(하루 1번, 3번) | `uq_charges_attempt` · `uq_charges_period_succeeded` | FR-113 |
| `POST /api/internal/jobs/membership-lifecycle` | 체험 끝 처리 · 강사 체험 30일·7일 전 안내 · 해지 예약·직접 결제 기간 만료 처리 | 조건부 갱신 `WHERE status=:from` · `uq_membership_notices` | FR-112d · FR-112e · FR-297 |
| `POST /api/internal/jobs/coupon-expiry` | 유효기간 지난 쿠폰 소멸 + 소멸 임박 안내 행 | `UPDATE … WHERE status='available' AND expires_at <= now()` | FR-122 · FR-120b |
| `POST /api/internal/jobs/level-evaluation` | 기간이 끝난 정규 수업의 완주·출석 판정과 레벨 반영·카드 발급 | `uq_completions_offering_member` · `uq_promotions_completion` | FR-169a · D7 |

응답 `{ "processed": 12 }`(작업마다 `notified`·`charged`·`failed`·`ended`·`expired`·`promoted` 같은 칸을 더해도 된다). 서버 시각은 `Clock` 주입 값을 쓴다 — 시험은 `asOf`.

**청구 규칙(`membership-billing`)** — S6-1 수용 ②③의 구현 근거

- 대상: `status IN ('active')` 이고 `auto_renew` 이고 `next billing date(KST) <= 오늘` 이고 그 기간(`period_start`)에 성공 청구가 없는 멤버십. 해지 예약(`cancel_scheduled`)은 청구하지 않는다
- 기간 계산: `기간 k 의 시작 = addMonthsClamped(anchor_date, k × period_months)`. 처음 기준일에서 매번 다시 계산하므로 재시도가 늦게 성공해도 **다음 결제일은 처음 기준일 그대로**다(FR-113 임시 확정 Q31)
- 실패(`attempt_no=0`)면 `retrying` 으로 바꾸고 알림 `membership_charge_failed`(사유·결제 수단 바꾸는 법 포함). **그동안 혜택은 유지한다.** 다시 결제는 실패한 날 다음 날부터 **하루 1번, 모두 3번**(추천값 3일). 같은 날 작업이 두 번 돌아도 `uq_charges_attempt` 때문에 한 번만 시도된다
- 다시 결제 성공이면 `retrying` → `active`, 쿠폰 한 장(발급 기준일 = 처음 기준일). 3번째도 실패면 `ended`(`retry_exhausted`) — 전용 혜택을 잠그고 그 회차 쿠폰은 없다. 구독한 학원 목록(소식 받기)은 남는다(C8A)
- 결제 수단을 바꿨으면 남은 다시 결제부터 새 수단을 쓴다
- 한 건의 PG 호출이 실패해도 다른 멤버십 처리를 막지 않는다. 한 건의 오류는 그 건만 `failed` 로 기록하고 작업은 계속된다

---

## 4. S6-2 쿠폰·대학생 혜택

### 4-1. 쿠폰함 — 권한 회원 본인(M19 · M19N · C28A)

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/me/coupons?view=active\|past&cursor=` | 쿠폰함 / 지난 쿠폰 | — | FR-122 · FR-123a | M19 · C28A |
| `POST /api/me/coupons/{couponId}/seen` | 안내를 보였다고 기록(받은 뒤 첫 접속 · 소멸 전) — 한 번씩만 보이게 | 이미 기록돼 있으면 200 | FR-123a | M19 |
| `GET /api/me/coupons/{couponId}/one-plus-one-options?paidOfferingId=` | 1+1 무료 수업 후보 목록 | — | FR-121 · FR-121a · FR-121b · FR-121c | C7A |
| `POST /api/me/price-preview` | 쿠폰·대학생 혜택을 반영한 가격 내역 미리보기 | — | FR-117 · FR-118a · FR-121 | C7A · 결제 화면 |

`GET /api/me/coupons?view=active` 200
```json
{ "header": { "membershipKind": "member_3m", "monthIndex": 2, "nextOneToOneAt": "2026-12-15" },
  "items": [ { "id": "…", "kind": "one_plus_one", "status": "available", "issuedAt": "2026-11-15T00:00:00Z",
               "expiresAt": "2027-02-14T14:59:59Z", "daysLeft": 86,
               "benefit": "추가 수업 1개 1달 무료", "conditions": ["개강일이 쿠폰 기간 안", "베타 댄스스포츠 라틴", "1+1 참여 학원", "내 레벨 범위"] } ],
  "howTo": ["신청", "레벨", "기간", "발급", "소멸"], "nextCursor": null }
```
- `view=past` 는 `used`·`expired` 쿠폰을 칩 필터(`status=used|expired`)로 나눈다. 쓴 쿠폰에는 `usedAt`·정가 수업 이름·무료 수업 이름·학원을, 소멸한 쿠폰에는 `expiredAt` 과 「되살릴 수 없어요」 문구용 `restorable: false` 를 준다. `nextOneToOneAt` 은 다음 갱신일(3개월 멤버십)이다
- **멤버십이 없는 회원**(M19N): 200 `{ "header": null, "items": [], "locked": true }` — 쿠폰 자체가 없다. 화면이 「불투명 유리」 안내를 보인다
- 연 멤버십 회원은 동반자 쿠폰만 나오고 `daysLeft` 는 멤버십 만료일 기준이다(FR-120b)
- `seen` 요청 `{ "moment": "first_open" }` 또는 `{ "moment": "expiry" }`. 소멸 7일 안(1+1) · 30일 안(동반자) 첫 접속에만 `expiry` 를 보이게 응답의 `showExpiryNotice` 로 알려 준다(FR-123a)

`GET /api/me/coupons/{couponId}/one-plus-one-options?paidOfferingId=…` 200 — 정가로 신청하는 수업을 기준으로 C7A 두 묶음
```json
{ "paid": { "offeringId": "…", "title": "쌈바(초급) · 12월", "startsOn": "2026-12-01" },
  "couponValidUntil": "2027-01-14",
  "selectable": [ { "offeringId": "…", "title": "룸바(입문)", "instructorName": "김하나", "startsOn": "2026-11-18", "detailGenre": "rumba", "myLevel": 1, "myLevelLabel": "입문" } ],
  "locked": [ { "offeringId": "…", "title": "쌈바(초중급)", "reason": "level_too_high", "message": "레벨이 오르면 열려요" },
              { "offeringId": "…", "title": "룸바(입문)", "reason": "academy_not_participating", "message": "쿠폰은 참여 업체에 한해 적용됩니다" } ] }
```
- 후보 조건(모두 서버가 검증, FR-121): 정규 수업 · 개강일이 **정가 수업 개강일 앞뒤 30일 안** · 개강일이 쿠폰 발급일~만료일 사이 · 댄스스포츠 라틴 세부 장르(차차차·쌈바·룸바·파소도블레·자이브, FR-121b) · 내 그 세부 장르 레벨 이하(입문=입문만, 초급=입문·초급, …, 댄서=모두 — 가입 직후 기록이 없으면 경험 수준 매핑, FR-121a) · 참여 학원(FR-121c). 날짜 범위 밖 수업은 목록에 넣지 않는다. 레벨 밖·미참여 학원 수업은 `locked` 에 이유와 함께 흐리게 내린다
- `reason` 값: `level_too_high` · `academy_not_participating`. 나머지 탈락 사유(정규 아님·날짜 밖·장르 밖)는 목록에서 뺀다

`POST /api/me/price-preview` — 요청 `{ "offeringId": "…", "seatKind": "female", "coupon": { "couponId": "…", "freeOfferingId": "…" } }`(쿠폰 없으면 `coupon` 생략). 200
```json
{ "priceBreakdown": [ { "kind": "list_price", "label": "정가", "amount": 120000 },
                      { "kind": "benefit_discount", "label": "대학생 첫 결제 50%", "amount": 60000 },
                      { "kind": "coupon_discount", "label": "쿠폰", "amount": 0 },
                      { "kind": "final", "label": "결제 금액", "amount": 60000 } ],
  "universityBenefit": { "applies": true, "popup": "대학생 첫 결제 50% 자동 적용" },
  "coupon": { "valid": true, "freeLine": { "offeringTitle": "룸바(입문) 1달 무료", "amount": 0 } } }
```
README §3 의 순서(`list_price` → `benefit_discount` → `coupon_discount` → `booking_fee` → `final`)를 지키고 0원 줄도 내린다. 쿠폰이 맞지 않으면 200 에 `"coupon": { "valid": false, "reason": "…" }` 로 이유를 알린다(오류가 아니다 — 미리보기). 03 에 가격 미리보기 경로가 없어 여기서 정의한다(열린 점 ⑥ — M3 와 조율).

### 4-2. 주문 생성 확장 — 03 §1 을 고치지 않고 덧붙인다

주문 생성(03 §1)의 요청에 다음 칸이 **선택**으로 더해진다. 같은 트랜잭션 순서에 아래 단계가 끼어든다.

```json
{ "offeringId": "…", "seatKind": "female", "method": "card", "noticesAcknowledged": true,
  "coupon": { "couponId": "…", "freeOfferingId": "…", "companion": { "memberId": "…", "gender": "male" } } }
```
- `coupon.freeOfferingId` 는 1+1 일 때만, `coupon.companion` 은 동반자 쿠폰일 때만. 둘 다·둘 다 없음이면 422 `VALIDATION_FAILED`(`fields` 에 `coupon.freeOfferingId`·`coupon.companion`)
- 동반자 쿠폰은 동반자의 **남/여 선택이 필수**다(FR-120b). 비어 있으면 422 `VALIDATION_FAILED`

| # | 단계(03 §1 의 가격 계산 앞뒤) | 실패 시 |
|---|---|---|
| a | 쿠폰 잠금 `UPDATE coupons SET status='held' … WHERE status='available' AND expires_at > now() AND member_id=:me` — 1행이어야 한다 | 409 `COUPON_NOT_AVAILABLE`(`reason`: `held`·`used`·`expired`) · 403 `FORBIDDEN`(남의 쿠폰) |
| b | **본인 사용만**(FR-123): 주문의 수강자가 쿠폰 소유 회원 본인이어야 한다(자녀 대신 신청은 거부) | 422 `COUPON_NOT_APPLICABLE`(`reason: "not_self"`) |
| c | 쿠폰 조건 검사(1+1: 정규·개강일 ±30일·쿠폰 기간 안·라틴·레벨·참여 학원 / 동반자: 정규 과정만·참여 학원(동반자 쿠폰 따로)·개강일이 쿠폰 기간 안). 하나라도 어긋나면 잠금을 풀고 거부 | 422 `COUPON_NOT_APPLICABLE`(`reason` 아래 표) |
| d | 정원 검사: 정가 수업 자리·추가 수업 자리·동반자의 성별 자리를 모두 같은 트랜잭션에서 센다(03 의 자리 잡기 + `companion_seats`). 하나라도 모자라면 **쿠폰을 쓰지 않은 상태로 되돌린다**(FR-091a) | 409 `SEAT_SOLD_OUT` · 409 `COUPON_SEAT_UNAVAILABLE`(`target`: `free_offering`·`companion`) |
| e | 대학생 혜택 자동 적용: 인증 `verified` 이고 `university_benefit_uses` 에 살아 있는 행이 없으면 신청한 수업 **1달치**의 50% 를 `benefit_discount_amount` 로 넣는다(회원이 고르지 않는다) | — |
| f | 두 할인의 합은 `list_price_amount` 를 넘지 않게 자른다(하한 0). `total = max(0, list − benefit − coupon) + booking_fee` — 03 §3 과 `ck_orders_total_formula` 그대로 | — |
| g | 1+1 이면 **추가 수업 주문**을 함께 만든다(`list_price` = 그 수업 1달치, `coupon_discount` = 같은 값, `total` 0 — 0원 경로로 `paid` 확정). `coupon_redemptions(held)` · `university_benefit_uses(applied)` 를 쓴다. 정가 주문이 `paid` 가 되면 redemption `used`·쿠폰 `used` | — |

`COUPON_NOT_APPLICABLE` 의 `reason`: `not_regular_course`(정규 수업만) · `academy_not_participating`(참여하지 않은 학원 — 화면 문구 「쿠폰은 참여 업체에 한해 적용됩니다」) · `genre_not_allowed`(베타 라틴만) · `level_too_high` · `out_of_date_range`(정가 수업 개강일 ±30일 밖) · `after_coupon_expiry`(개강일이 쿠폰 기간 밖) · `not_self` · `first_session_only_kind`(동반자 쿠폰은 정규 과정만).

- **한 신청에 쿠폰은 한 장**이다. 한 주문에 두 장을 보내는 모양은 요청 형식에 없다(`uq_redemptions_paid_order`)
- 정가 주문이 `expired`·`cancelled` 가 되면 같은 트랜잭션에서 redemption `released` · 쿠폰 `available` 로 돌아가고 `companion_seats` 도 풀린다(결제 대기 중에도 잠기는 만큼 풀리는 경로가 주문 만료·셀프 취소 처리에 붙는다)
- **환불(FR-296, S4-1 실행 경로에 붙는다)**: 전액 환불 + 쿠폰 유효기간 남음 → 쿠폰 `available` 로 되살림(redemption `restored`, 감사 `coupon.restored`), 부분 환불·유효기간 지남 → 되살리지 않음. 대학생 혜택은 전액 환불일 때만 `applied` → `reverted`
- 쿠폰·대학생 혜택의 대표 부담 줄(`coupon_burden` — 대학생은 차액 금액, 1+1·동반자는 금액 0 사용 표시)은 주문 확정과 같은 트랜잭션에서 정산 원장에 쓴다(M5 13-settlement.md 열린 점 ⑮ 와 조율 — 열린 점 ⑦)

### 4-3. 대학생 인증 — 권한 회원 본인(M17 · FR-006)

| 메서드·경로 | 역할 | 멱등 | 근거 FR |
|---|---|---|---|
| `GET /api/me/university-verification` | 인증 상태 | — | FR-006 |
| `POST /api/me/university-verification` | 학교 이메일로 인증 메일 보내기 | 같은 이메일 `pending` 이면 새로 보내지 않고 200 | FR-006 · FR-006b |
| `POST /api/me/university-verification/resend` | 메일 다시 보내기 | 최소 간격 안이면 200 같은 본문 | FR-006a |
| `POST /api/me/university-verification/confirm` | 메일 링크의 토큰 확인 → 인증 완료 | 이미 `verified` 면 200 | FR-006 |

`POST /api/me/university-verification` 요청 `{ "schoolEmail": "seoyeon@snu.ac.kr" }` → 202 `{ "status": "pending", "sentTo": "se•••@snu.ac.kr", "expiresAt": "…Z" }`
- **서버는 이메일 원문을 저장하지 않는다**(FR-008): 도메인(`snu.ac.kr`)과 HMAC 해시만 남기고, 메일을 보낸 뒤 원문은 버린다. 응답에는 가린 값만 쓴다
- `.ac.kr` 로 끝나지 않으면 422 `SCHOOL_EMAIL_DOMAIN_INVALID` · 같은 이메일(해시)이 이미 `verified`·`revoked` 면 409 `SCHOOL_EMAIL_ALREADY_USED`(FR-006b) · 이미 내 계정이 `verified` 면 409 `ALREADY_VERIFIED`
- `resend` 요청은 이메일을 **다시 받는다**(서버가 모르므로) — 해시가 `pending` 행과 같을 때만 보낸다. 다르면 422 `VALIDATION_FAILED`. 과도한 재발송은 429 `RATE_LIMITED`(최소 간격·일 한도는 추천값, 열린 점 ⑧)
- `confirm` 요청 `{ "token": "…" }`. 토큰 해시가 맞고 유효하면 `verified` · 알림 `university_verified` · 200 `{ "status": "verified", "benefit": "첫 결제 1회 50% 할인" }`. 유효 시간이 지났으면 410 `VERIFICATION_LINK_EXPIRED`(메일 다시 보내기로 안내) · 토큰이 없거나 틀리면 422 `VERIFICATION_TOKEN_INVALID`
- 인증은 선택이다. 인증하지 않아도 모든 경로가 정상이다(`GET` 이 `{ "status": "none" }`)

운영자 회수 — `POST /api/admin/university-verifications/{id}/revoke` 요청 `{ "reason": "not_student", "note": "졸업 확인" }`(FR-007). 권한 `admin`. `verified` → `revoked`(같은 이메일은 계속 막힌다) · 이미 쓴 혜택 행은 `clawback_due`(정상가 재청구 대상으로 **기록만**, 실행은 이 계약 밖) · 알림 `university_benefit_revoked` · 감사 `university_verification.revoked`. `verified` 가 아니면 409 `VERIFICATION_STATE_CONFLICT`. 이 경로는 FR-301(콘솔 조회 전용)이 말하는 플랫폼 정산 콘솔 밖의 운영 도구다(`15-ops.md` 와 조율 — 열린 점 ⑨).

### 4-4. 참여 학원 — 권한 `owner`(위임 강사는 열리지 않는다)

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/academies/{academyId}/coupon-participation` | 참여 상태 | — | FR-121c · FR-120b | W7a · O41 |
| `PUT /api/academies/{academyId}/coupon-participation` | 1+1 참여·동반자 쿠폰 참여 켜고 끄기 | 같은 값이면 200(감사 없음) | FR-121c · FR-120b | W7a · O41 |
| `GET /api/academies/{academyId}/coupon-participation/report?period=month\|week\|day&date=` | 참여 효과 리포트(우리 학원 숫자만) | — | FR-121i | W7a · O41 |
| `GET /api/academies/{academyId}/university-benefits?cursor=` | 우리 학원에서 쓴 대학생 혜택 사용 현황 | — | FR-006d | — |

`PUT` 요청 `{ "oneToOne": true, "companion": false }`(두 칸 모두 선택, 보낸 칸만 바꾼다 — **1+1 과 동반자 쿠폰은 따로 고른다**, FR-120b). 200 `{ "oneToOne": true, "companion": false, "firstJoinedAt": "2026-10-13T…Z", "changedAt": "…Z" }`. 처음 켠 순간 `coupon_first_enabled_at` 를 한 번 채운다(껐다 켜도 지우지 않는다). 감사 `academy.coupon_participation_changed`(전후 값). **끄면 그 학원 수업은 쿠폰 선택지가 막히고 「쿠폰 미적용」으로 표시된다**(S6-2.8). 이미 `held`·`used` 인 쿠폰은 영향받지 않는다.

`GET …/report` 200 — 우리 학원 숫자만, 원천이 아직 없는 칸은 `available: false`(10-owner-dashboard.md §1 의 뼈대 원칙과 같다 — 0 과 구별한다)
```json
{ "period": "month", "from": "2026-10-13", "to": "2026-11-09",
  "newCard":       { "available": false, "availableFrom": "S6-2.9", "impressions": null, "clicks": null, "daysLeft": null },
  "ranking":       { "available": false, "availableFrom": "S6-2.9", "classes": [], "bestRank": null },
  "participantList": { "available": false, "availableFrom": "S6-2.9", "clicks": null },
  "couponUses":    { "available": true, "count": 7 },
  "counting": { "perMemberPerDay": true, "excludesStaff": true } }
```
- `couponUses` 는 `coupon_redemptions`(`status='used'`, `bearer_academy_id` = 이 학원)에서 센다(금액 없이 건수만). 나머지 셋은 순위판·신규 참여 카드·참여학원 목록 화면이 노출 기록을 쓰기 시작해야 채워진다(열린 점 ⑩)
- 다른 학원 숫자는 내리지 않는다. 학원 B 대표가 학원 A 를 부르면 403 `FORBIDDEN`

`GET …/university-benefits` 200 `{ "items": [ { "usedAt": "…Z", "memberNickname": "수연", "orderId": "…", "discountAmount": 60000, "status": "applied" } ], "nextCursor": null }` — 이름·연락처 없이 닉네임만(FR-006d 의 이상 징후 확인용). 소속 학원 주문만 나온다.

### 4-4b. 순위판·참여학원 목록·신규 참여 카드 — 회원 홈(C32A · C32B) · S6-2.9 (2026-11-20 통합 때 추가, 열린 점 ⑩)

근거: FR-121d(1+1 참여 학원 실시간 수업 검색 순위) · FR-121e(신규 참여 학원 NEW 영역 — 참여일부터 한 달) · FR-121f(수업 검색 조회수를 공정하게 셈) · FR-121h(1+1 참여학원 목록) · FR-121i(참여 효과 리포트의 원천) · 보드 C32A·C32B. 근거가 없는 칸은 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인).

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/home/live-ranking?genre=&scope=participating\|all` | 실시간 인기 수업 TOP 10(고른 장르마다) | 읽기 | FR-121d · FR-121f | C32A |
| `GET /api/home/new-participants?genre=` | 처음 참여한 학원 카드 줄(참여일부터 한 달) | 읽기 | FR-121e | 홈 NEW 카드 줄 |
| `GET /api/coupon-participants?genre=` | 고른 장르의 1+1 참여 학원 전체(열 때마다 무작위) | 읽기 | FR-121h | C32B |
| `POST /api/exposure-events` | 카드 노출·누름·목록 누름 기록(회원 1명·학원·종류·하루 1번) | `uq_exposure_member_day` — 이미 있으면 204 | FR-121i | C32B · NEW 카드 |
| `POST /api/internal/jobs/live-ranking/refresh` | 6시간마다 순위 스냅샷 계산 | `(computed_at, genre, rank)` PK | FR-121d | — |

`GET /api/home/live-ranking?genre=salsa_bachata&scope=participating` 200
```json
{ "genre": "salsa_bachata", "scope": "participating", "computedAt": "2026-11-20T06:00:00Z", "windowHours": 6, "basis": "search_views",
  "items": [ { "rank": 1, "classId": "…", "offeringId": "…", "title": "바차타 센슈얼 입문", "academyName": "라틴하우스 강남", "startsAt": "2026-12-01T11:00:00Z",
               "seats": { "male": 1, "female": 3 }, "soldOut": false, "waitlistOpen": false, "movement": "up", "delta": 2 },
             { "rank": 2, "classId": "…", "offeringId": "…", "title": "살사 온투 기초", "academyName": "살사홀릭 강남", "startsAt": "…Z",
               "seats": { "male": 0, "female": 0 }, "soldOut": true, "waitlistOpen": true, "movement": "same", "delta": 0 } ],
  "participantCount": 12 }
```
- 순위·`movement`(`up`·`down`·`same`·`new`)·`delta` 는 마지막 `ranking_snapshots` 와 그 앞 스냅샷을 비교한 값이다. **남은 자리(`seats`)·`soldOut` 은 스냅샷이 아니라 부를 때 새로 읽는다**(보드 「잔여 자리는 열 때 새로 읽음」). 자리 칸은 수업의 정원 방식대로(`gender_split` 이면 `male`·`female`, `single` 이면 `any`)
- `scope=participating`(기본)은 1+1 참여 학원의 수업만(FR-121d 「참여 학원에게만」). `scope=all` 은 보드의 「전체 학원 순위」 토글 — 참여 여부와 상관없는 순위(열린 점 ⑲). `participantCount` 는 토글이 꺼져 있을 때 순위판 아래 「1+1 참여학원 ○곳 ›」에 쓴다(FR-121h)
- `genre` 는 §3 `genre` 4값. 없으면 회원이 첫 화면에서 고른 장르(FR-022a). 로그인 안 한 사용자도 읽는다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) — 홈 첫 화면)

`GET /api/home/new-participants?genre=` 200 `{ "items": [ { "academyId", "academyName", "joinedAt": "…Z", "featuredClass": { "classId", "title", "seats": { "male": 2, "female": 2 } } | null } ] }` — `coupon_first_enabled_at`(§4-4)이 지금으로부터 한 달 안인 참여 학원만, 최근 참여 순.

`GET /api/coupon-participants?genre=` 200 `{ "genre", "count": 12, "items": [ { "academyId", "academyName", "isNew": true, "featuredClass": { "classId", "title", "level": "beginner", "seats": { "male": 0, "female": 2 }, "recruiting": true } | null } ] }` — 순서는 **부를 때마다 무작위**(서버가 섞는다). `isNew` = 참여 한 달 안. `featuredClass` 는 보드 「대표가 고른 수업」(열린 점 ⑳) — 정한 값이 없으면 그 학원의 모집 중인 수업 가운데 개강이 가장 가까운 것(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 회원 화면이므로 연락처·금액 없음.

`POST /api/exposure-events` 요청 `{ "academyId": "…", "kind": "new_card_impression" | "new_card_click" | "participant_list_click" }` → 204. 회원 세션만 센다 — 직원 세션·로그인 안 함은 204 를 주되 쓰지 않는다(대표·강사 계정은 리포트에 넣지 않는다, data-model §11-3). `INSERT … ON CONFLICT DO NOTHING`(회원 1명·학원·종류·KST 하루 1번). 없는 학원이면 404 `NOT_FOUND`.

`POST /api/internal/jobs/live-ranking/refresh`(6시간마다) — 장르마다 최근 6시간 **수업 검색 조회수**(FR-121f) 상위 10개를 `ranking_snapshots` 에 쓴다. 조회수의 원천(누가 언제 어느 수업을 검색으로 봤는지)을 모으는 표는 아직 없다(열린 점 ⑲ — M3 S3-2 와 조율). 같은 `computed_at` 으로 다시 부르면 PK 때문에 더 늘지 않는다. 계산 뒤 §4-4 리포트의 `ranking` 칸이 `available:true` 가 된다.

### 4-5. 오류 코드(S6-2)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` | 남의 쿠폰 · 다른 학원 · 위임 강사 |
| 409 | `COUPON_NOT_AVAILABLE` | 쿠폰 상태가 `available` 이 아님. `reason` = `held`·`used`·`expired` |
| 409 | `COUPON_SEAT_UNAVAILABLE` | 추가 수업 또는 동반자 자리가 없다. `target` = `free_offering`·`companion`(FR-120b 문구 「동반자 자리가 없어 쿠폰을 쓸 수 없습니다」) |
| 409 | `SCHOOL_EMAIL_ALREADY_USED` · `ALREADY_VERIFIED` · `VERIFICATION_STATE_CONFLICT` | 대학생 인증 충돌 |
| 410 | `VERIFICATION_LINK_EXPIRED` | 인증 링크 유효 시간 지남 |
| 422 | `COUPON_NOT_APPLICABLE` | 쿠폰 조건 불충족(`reason` — 4-2 표) |
| 422 | `SCHOOL_EMAIL_DOMAIN_INVALID` · `VERIFICATION_TOKEN_INVALID` · `VALIDATION_FAILED` | 입력 오류 |
| 429 | `RATE_LIMITED` | 인증 메일 재발송 제한 |

---

## 5. S6-3 레벨·등급 카드 — 회원

레벨은 세부 장르(`detailGenre`)마다 따로, 0~10 이다. 단계 이름은 서버가 레벨에서 계산한다(0~1 입문 · 2~3 초급 · 4~5 초중급 · 6~7 중급 · 8~9 고급 · 10 댄서, FR-161). **강사 평가 레벨은 회원용 응답 어디에도 키가 없다**(S6-3 수용 ③, FR-169d). **출석 횟수·%·회차 수는 어떤 회원·강사 응답에도 내리지 않는다**(D7 — 화면 문구는 「정규 수업 한 기간을 끝까지 마치고 출석 70% 이상」 하나뿐이다). 나이 표현(아기~40대)은 쓰지 않는다(FR-169c).

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/me/levels` | 세부 장르별 내 레벨 | — | FR-169 | M25 · M26 · C24A |
| `GET /api/me/level-cards?detailGenre=&cursor=` | 카드 모음(받은 카드) | — | FR-169f | M26 · M26B · C24A |
| `POST /api/me/level-cards/{cardId}/reveal` | 등급 알림 연출을 봤다고 기록 | 이미 봤으면 200 | FR-169e | M25 · M25C |
| `PUT /api/me/featured-level-card` | 대표 캐릭터로 쓰기 | 같은 값이면 200 | FR-169c · FR-169f | M26B |
| `POST /api/me/level-offers/{offerId}/accept` | 강사가 올려 준 레벨 승급하기 → 카드 발급 | ~~이미 `accepted` 면 200~~ → 열린 제안에만 한 번. 두 번째 응답은 409 `OFFER_NOT_PENDING`(추천안·사후 확인 2026-11-24, S6-3.9) | FR-169d · FR-169e | M25B |
| `POST /api/me/level-offers/{offerId}/decline` | 지금 레벨에서 내가 키우기(카드·레벨 변화 없음) | ~~이미 `declined` 면 200~~ → 위와 같음(추천안·사후 확인 2026-11-24, S6-3.9) | FR-169e | M25B |
| `GET /api/me/contact-consent` · `PUT /api/me/contact-consent` | 개강 후보 연락처 제공 동의 | 같은 값이면 200 | FR-165 | (보드 없음 — 열린 점 ⑪) |

`GET /api/me/levels` 200
```json
{ "items": [ { "detailGenre": "samba", "level": 9, "stage": "advanced", "stageLabel": "고급", "gauge": { "filled": 9, "total": 10 } },
             { "detailGenre": "rumba", "level": 1, "stage": "entry", "stageLabel": "입문", "gauge": { "filled": 1, "total": 10 } } ],
  "pendingReveal": [ { "cardId": "…", "detailGenre": "samba", "level": 10, "stageLabel": "댄서", "reason": "course_completion" } ],
  "pendingOffers": [ { "offerId": "…", "detailGenre": "samba", "toLevel": 4, "toStageLabel": "초중급", "message": "이준호 강사님이 쌈바 레벨을 4(초중급)로 올려 줬어요" } ] }
```
- 수강 기록이 없는 세부 장르는 가입 때 고른 경험 수준에서 매핑한 값을 `level` 에 준다(FR-121a) — `source: "profile"`(수업 기록으로 오른 것이 아님을 표시)
- `pendingReveal`: `revealed_at IS NULL` 인 카드. 앱을 열었을 때 있으면 등급 알림 → 카드 공개 연출(M25 → M25C)을 보이고 `reveal` 을 부른다. **본인 레벨업(완주)은 묻지 않고 바로 카드가 발급된다**(FR-169e)
- `pendingOffers`: 강사가 올려 준 레벨 제안. 받았을 때 알림 `level_offer` 가 간다. 응답에 **제안한 강사의 평가 레벨은 없다**
- **S6-3.4 구현(추천안·사후 확인 2026-11-24)**: `GET /api/me/levels` 는 `admin-web/lib/server/services/me-levels.ts`. 강사 평가 표는 읽지도 않고, 응답은 strict 스키마(`meLevelsResponseSchema`)로 검사한 뒤 내보낸다. 지금은 **기록이 있는 세부 장르만** `items` 에 내리고 `source: "record"` 를 붙인다 — 가입 경험 수준 매핑 줄(`source: "profile"`)은 카드 화면 Task(S6-3.8)가 화면과 함께 더한다. `pendingOffers[].message` 는 알림 본문과 같은 문장(`levelOfferMessage`). S6-3.9(제안 받기·거절)의 「제안 목록」은 이 `pendingOffers` 를 쓴다
- **S6-3.5 구현(추천안·사후 확인 2026-11-24)**: `GET·PUT /api/me/contact-consent` 는 `admin-web/lib/server/services/me-contact-consent.ts`. 요청 `{ "consented": true|false }`(strict), 응답 `{ "consented", "consentedAt" }`(동의 안 함이면 `consentedAt: null`). 행이 없으면 동의 안 함 · 같은 값이면 쓰지 않고 200 · 값이 바뀔 때만 감사 `candidate.contact_consent_changed`(회원 행위, 대상 members) · 거두면 `withdrawn_at` 을 찍고 다시 동의하면 `consented_at` 새로·`withdrawn_at` 비움. 화면(M12 줄 하나)은 이 Task 밖
- `GET /api/me/level-cards` 항목 `{ "cardId", "detailGenre", "level", "stageLabel", "issuedAt", "isFeatured", "characterKey" }`. `characterKey` 는 이미지 선택용 키(세부 장르 × 단계 × 성별)다. 현재 레벨 카드만 프로필·홈에 보이고, 지난 레벨 카드는 모음에만 나온다
- **S6-3.8 구현(추천안·사후 확인 2026-11-24)**: `GET /api/me/level-cards` 는 `admin-web/lib/server/services/me-level-cards.ts`. 응답 `{ "items": [...], "nextCursor" }`, 항목에 **`isCurrent`(그 세부 장르의 지금 레벨 카드)를 더했다** — 카드 모음(M26)의 「지금」 표시를 앱이 `GET /api/me/levels` 와 맞춰 계산하지 않게. `characterKey` 모양은 `묶음/성별_단계`(예: `salsa/m_l01`) — 묶음은 라틴 5종 `samba`·스탠다드 5종 `viennese`·`argentine_tango`→`tango`·`swing`·`salsa`·`bachata`, 단계는 `l01·l23·l45·l67·l89·l10`(규칙 `lib/domain/level-card-art.ts`). 순서는 세부 장르 이름 → 레벨 오름차순, 커서는 (세부 장르, 레벨), 한 쪽 200장(한 회원 최대 154장이라 보통 한 쪽). `detailGenre` 가 14종 밖·모르는 칸·깨진 커서는 422. `GET /api/me/levels` 의 가입 경험 수준 줄(`source: "profile"`)은 이 Task 에서도 더하지 않았다 — 경험 수준→레벨 매핑 함수가 아직 없고 카드 모음 화면은 카드(발급 기록)만 보인다

`accept` — 200 `{ "level": 4, "card": { "cardId": "…", "level": 4 } }`. 한 트랜잭션: 제안 `accepted` · 레벨 조건부 갱신(`level < :to` — **이미 더 높으면 0행으로 레벨은 그대로**, 카드는 발급하지 않고 제안만 닫는다) · `level_promotions(instructor_offer)` · 카드 한 장 · 알림 `level_up`. `decline` — 200 `{ "level": 3 }`(변화 없음). **회원 화면 어디에도 「강사 쪽에 평가 레벨이 남는다」는 말을 쓰지 않는다**(2026-10-15 결정). 열린 제안이 아니면 409 `OFFER_NOT_PENDING`, 남의 제안이면 403 `FORBIDDEN`. 강사가 다시 올려 주면 이전 제안은 `superseded` 가 되고 새 제안이 만들어진다(다시 묻는다).

**S6-3.9 구현(추천안·사후 확인 2026-11-24)**: 서비스 `admin-web/lib/server/services/me-level-offers.ts`, 경로 `app/api/me/level-offers/[offerId]/accept|decline/route.ts`. 「제안 목록」은 새 경로를 두지 않고 `GET /api/me/levels` 의 `pendingOffers` 를 쓴다 · 본문 없음 · 판정 순서 = 회원 아님 401·403 → 제안 없음·uuid 아님 404 → 남의 제안 403 `FORBIDDEN`(상태를 알려 주지 않는다) → `offered` 아님 409 `OFFER_NOT_PENDING`, 본문 `reason` 에 지금 상태(`accepted`·`declined`·`superseded`). **같은 제안에 두 번째 응답은 같은 쪽이어도 409** — 표의 「이미 accepted 면 200」을 로드맵 verify(「같은 제안 두 번 응답 409」)에 맞춰 바꿨다. 앱은 `reason` 으로 「이미 받았어요」를 고른다 · 제안 줄을 `FOR UPDATE` 로 잠가 동시에 두 번 눌러도 하나만 200 · `accept` 응답 `card` 는 실제로 올랐을 때만, 이미 같거나 높으면 `null` · 레벨 올리기는 `INSERT … ON CONFLICT DO UPDATE … WHERE level < :to RETURNING old.level`(PostgreSQL 18) 한 문장 — 기록이 없으면 0 에서 새 줄 · 강사 제안 승급은 몇 칸이든 제안 레벨까지(`from_level` = 바로 전 레벨) · 카드는 `revealed_at` 비움(연출 M25C 뒤 `reveal`) · 알림 `level_up` payload `{title, body, detailGenre, level, stageLabel, cardId, offerId, reason: "instructor_offer"}`, 본문은 완주와 같은 「살사 Lv.4 (초중급) 카드를 받았어요」, 열쇠 `level-card:<cardId>:issued` · 감사 `level.offer_accepted`·`level.offer_declined`(회원 행위, 대상 level_offers, after 에 고른 결과·지금 레벨)

**S6-3.10 구현(추천안·사후 확인 2026-11-24)**: `POST /api/me/level-cards/{cardId}/reveal` 는 `admin-web/lib/server/services/me-level-card-reveal.ts`, 경로 `app/api/me/level-cards/[cardId]/reveal/route.ts` · 본문 없음 · 200 `{ "cardId", "revealedAt" }` — 내 카드이고 `revealed_at IS NULL` 일 때만 지금 시각을 적는 한 문장(동시에 두 번 불러도 처음 시각 하나) · 이미 봤으면 200 + 처음 본 시각 그대로(덮어쓰지 않음) · 판정 순서 = 회원 아님 401·403 → 없는 카드·uuid 아님 404 → 남의 카드 403 `FORBIDDEN`(봤는지 여부를 알려 주지 않는다) · 감사 기록 없음(회원 자신의 화면 상태라서). **`GET /api/me/levels` 칸을 더했다**: `pendingReveal[]` 에 `fromLevel`(「레벨 9 → 10」)·`issuedAt`(카드 발급일)·`characterKey`(카드 모음과 같은 그림 열쇠), `pendingOffers[]` 에 `instructorName`(M25B 문장을 영어 세부 장르로 짓기 위해 — `message` 는 한국어 장르 이름 그대로 둔다). 앱 연출 순서는 안 본 카드 먼저(발급 순) → 열린 안내, 연출은 홈(`app/(tabs)/home.tsx`) 위에 덮는다

### 5-1. 레벨 계산 규칙(내부 작업 `level-evaluation`, 순수 함수 `evaluateCompletion`) — 결정 D7

| 조건 | 판정 |
|---|---|
| 대상 | `class_kind='regular'` · `enrollment_unit='term'` 판매 단위. 마지막 회차 종료 + 48시간이 지난 것(결석 표시 확정 시점) |
| 끝까지 마침 | 기간이 끝날 때까지 그 예약이 `confirmed`, 주문이 `paid`(부분 환불·취소·중도 환불 없음) |
| 출석 | `attended × 10 >= total × 7`. 8회 과정이면 6회 이상. 결석 = **회원·강사·대표가 표시한 것**(`attendance_marks`, 취소·이의 인정된 것 제외). 표시가 없으면 참석 |
| 결과 | 둘 다 만족하면 그 세부 장르 레벨 **+1**(한 번에 1칸만, 10 이 상한). 못 미치면 그대로(깎지 않는다) |
| 멱등 | `(offering, member)` 한 번만 판정. 두 번 불러도 같은 결과·레벨 +1 은 한 번 |

판정마다 `course_completions` 한 행(횟수 포함 — 응답 밖), 승급이면 `level_promotions` + `level_cards`(바로 발급) + 알림 `level_up`.

**S6-3.2 구현(추천안·사후 확인 2026-11-24)**: 순수 함수는 `admin-web/lib/domain/level-evaluation.ts`(`evaluateCompletion`·`isEffectiveAbsence`·`levelStageLabel`·`levelGenreOf`). 결석으로 세는 표시 = `cancelled_at IS NULL` 이고 `dispute_status <> 'accepted'`(이의 신청 중·기각은 센다) · 같은 회차 표시 여러 줄은 1회 · 휴강 회차(`status='cancelled'`)에 걸린 표시는 무시 · 회차가 0 개(전부 휴강)면 올리지 않는다 · 끝까지 마침 = 예약 `confirmed` 이고 주문 `paid` 만(부분 환불 포함 다른 상태는 아님)

**S6-3.3 구현(추천안·사후 확인 2026-11-24)**: 작업 본문은 `admin-web/lib/server/services/level-evaluation-job.ts`(`runLevelEvaluation`), 응답 `{ processed, promoted, failed }`. 기간 종료 = `class_offerings.last_session_ends_at` 과 그 판매 단위 회차 `ends_at` 최댓값 중 늦은 쪽(`lib/domain/term-end.ts` — S5-1.3 도 이것을 쓴다), 판정은 `지금 > 기간 종료 + 48시간` · 대상 수강생 = 그 판매 단위에 예약이 있고 주문이 한 번이라도 결제된 사람(`paid_at` 있음 또는 paid·partially_refunded·refunded — 결제 전 만료·취소는 판정 기록도 없음), 한 사람이 예약을 여럿 가졌으면 확정+결제 완료 예약 우선 · 레벨 행이 없으면 0 에서 판정(가입 경험 수준 매핑은 화면 표시용, FR-121a) · 세부 장르를 정할 수 없는 수업은 판정 기록만 · 알림 `level_up`(분류 service, 열쇠 `level-card:<cardId>:issued`, 본문 「살사 Lv.4 (초중급) 카드를 받았어요」 — 출석 숫자 없음) · 폐강 회차(`class_sessions.status='closed'`)도 휴강처럼 분모에서 뺀다(S6-3.2 의 「closed 는 센다」를 바로잡음 — closed 는 폐강으로 닫힌 회차다)

### 5-2. 오류 코드(S6-3 회원)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` | 남의 카드·제안 |
| 409 | `OFFER_NOT_PENDING` | 이미 처리됐거나 `superseded` |
| 404 | `NOT_FOUND` | 없는 카드·제안 |
| 422 | `VALIDATION_FAILED` | `detailGenre`·`consented` 값 오류 |

---

## 6. S6-3 강사 — 레벨 조절·개강 후보 — 권한 `instructor`(`surface='app'`), **강사 멤버십 필요**

멤버십이 없으면(`expired`·`ended`) 이 절의 모든 경로가 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED`(§2). 데이터는 지우지 않는다.

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/instructor/offerings/{offeringId}/member-levels?detailGenre=` | 수강생의 현재 레벨·내 평가 레벨(I23 명단 칩 — 멤버십 여부 칸은 2026-11-24 뺌) | — | FR-162 · FR-169d | I23 |
| `POST /api/instructor/level-evaluations` | 레벨 정하기 최종 적용 | 같은 값이면 200(알림 중복 없음) | FR-169d | I23 |
| `GET /api/instructor/new-class-candidates?…` | 후보 수와 선정 근거 | — | FR-164 | I15 |
| `GET /api/instructor/new-class-candidates/list?…&cursor=` | 연락처 동의 후보 명단 | — | FR-164 · FR-165 · FR-272 | I15B |
| `POST /api/instructor/new-class-candidates/{memberId}/reveal-contact` | 연락처 전체 보기(기록 남김) | 같은 토큰이면 같은 값, 기록은 매번 | FR-165 · FR-187 | I15B |

### 6-1. 레벨 정하기 — `GET …/member-levels` · `POST /api/instructor/level-evaluations`

`GET` 200 — 그 수업의 **결제 완료** 수강생만(FR-162, 무료 수업은 신청 확정 = 결제 완료)
```json
{ "items": [ { "memberId": "…", "displayName": "김서연", "gender": "female", "monthsEnrolled": 2, "absenceScheduled": false,
               "level": 3, "stageLabel": "초급", "myEvaluation": null },
             { "memberId": "…", "displayName": "박민지", "gender": "female", "monthsEnrolled": 1, "absenceScheduled": false,
               "level": 4, "stageLabel": "초중급", "myEvaluation": 4 } ] }
```
- `myEvaluation` 은 **이 강사의** 평가 레벨(없으면 null). 다른 강사의 평가 레벨은 보이지 않는다. 출석률 열은 없다(I23). 연령은 연령대로만(FR-168)

`POST /api/instructor/level-evaluations` 요청(I23 `최종 적용`)
```json
{ "offeringId": "…", "detailGenre": "samba", "memberIds": ["…", "…"], "level": 4 }
```
- ~~멤버십 회원만 고를 수 있다(2026-10-15) · 409 `MEMBER_MEMBERSHIP_REQUIRED`~~ — **2026-11-24 spec FR-169d 개정으로 폐기.** 레벨 올리기는 **멤버십 강사만** 쓰고 받는 회원은 멤버십이 없어도 된다. 멤버십이 아닌 강사는 이 절의 두 경로 모두 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED`. 그래서 `GET` 응답의 `hasMembership`·`selectable`·`lockedReason` 칸도 뺐다(회원 체크박스는 멤버십으로 잠그지 않는다)
- 그 수업을 결제한 수강생이 아닌 회원 → 403 `FORBIDDEN`(FR-162)
- `level` 이 0~10 밖이면 422 `VALIDATION_FAILED`
- 한 트랜잭션: 각 회원마다 ① `instructor_level_evaluations` upsert(**평가 레벨 저장 — 올리든 내리든**) ② 회원의 현재 레벨보다 **높으면** `level_offers(offered)` 를 만들고(같은 회원·장르의 열린 제안은 `superseded`) 알림 `level_offer`, **낮거나 같으면 제안·알림 없음**(내린 레벨은 평가 레벨에만 남고 회원에게 보내지 않는다 — I23) ③ 감사 `level.evaluation_set`·`level.offer_sent`
- 같은 값을 다시 보내면(이미 평가 레벨이 같고 열린 제안이 같은 `to_level`) 아무것도 바꾸지 않고 같은 본문 200
- 200
```json
{ "results": [ { "memberId": "…", "evaluationSaved": true, "offerSent": true, "toLevel": 4 },
               { "memberId": "…", "evaluationSaved": true, "offerSent": false, "reason": "not_higher_than_member_level" } ] }
```
- **회원 레벨은 이 경로에서 바뀌지 않는다.** 회원이 `accept` 를 눌러야 오른다(§5)

**S6-3.4 구현(추천안·사후 확인 2026-11-24)**: 서비스 `admin-web/lib/server/services/instructor-level-evaluations.ts`, 계획 함수 `admin-web/lib/domain/level-offer.ts`(`planLevelApply`·`levelOfferMessage`), 강사 멤버십은 포트 `InstructorMembershipPort.isInstructorMember`(지금은 가짜 — 기본 「모두 멤버십」, 개발 서버는 `FAKE_INSTRUCTOR_NON_MEMBER_IDS` 의 강사만 아님. S6-1 이 생기면 구현만 바꾼다). 판정 순서 = 강사 역할 403 → 멤버십 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED` → 판매 단위 404 → 그 수업 강사(수업 담당 또는 그 판매 단위 회차 담당 + 지금 그 학원 active 소속) 아니면 403 → `detailGenre` 가 수업 장르 안이 아니면 422(`GET` 은 생략하면 수업의 세부 장르) → 결제 완료 수강생(예약 `confirmed` + 주문 `paid`·`partially_refunded`) 아닌 회원이 섞이면 전체 403 `FORBIDDEN`(`fields` 에 그 id) · `memberIds` 1~100명·중복 금지 · 회원 레벨 기록이 없으면 0 과 비교 · 같은 레벨로 연 **이 강사의** 안내가 있으면 그대로(알림 중복 없음), 다른 강사가 연 안내는 닫고 새로 보낸다 · 회원 레벨 이하로 정하면 **이 강사가 전에 연 안내를 닫는다**(회원에게 알림 없음) · 알림 `level_offer`(분류 service, 열쇠 `level-offer:<offerId>:sent`, payload `{title, body, offerId, detailGenre, toLevel, toStageLabel}` — 평가 레벨 칸 없음) · 감사 `level.evaluation_set`(대상 members, 값이 바뀔 때만) · `level.offer_sent`(대상 level_offers) · `GET` 의 `monthsEnrolled` = 그 학원 첫 결제 달부터 지금 달까지, `absenceScheduled` = 이 판매 단위의 앞으로 남은 회차에 살아 있는 결석 표시가 있음

### 6-2. 개강 후보 — `GET /api/instructor/new-class-candidates` · `…/list` · `…/reveal-contact`

쿼리(같은 조건을 세 경로가 공유): `detailGenre=samba&levelFrom=0&levelTo=3&weekdays=tue,thu&timeFrom=20:30&timeTo=21:30&capacityMale=8&capacityFemale=8`.

`GET …/new-class-candidates` 200 — 후보 수와 선정 근거만. **개인을 식별하는 값은 없다**
```json
{ "total": 23, "male": 9, "female": 14, "capacity": 16,
  "basis": [ { "kind": "completed_same_detail_genre", "count": 11, "label": "쌈바 입문 과정을 마쳤어요" },
             { "kind": "attending_same_genre", "count": 8, "label": "룸바·차차차 같은 라틴 수업을 듣고 있어요" },
             { "kind": "preferred_time", "count": 4, "label": "화·목 저녁을 선호 시간으로 골랐어요" } ],
  "contactConsent": { "consenting": 9, "notConsenting": 14 },
  "disclaimer": "AI 추천 · 실제 신청으로 이어진다는 뜻은 아니에요" }
```
- 후보 판정(FR-164): ① 그 세부 장르의 레벨이 `levelFrom`~`levelTo` 이고 같은 세부 장르 정규 과정을 끝까지 마쳤다 ② 같은 대분류 장르의 다른 수업을 듣고 있다 ③ 선호 시간대(`members.available_from/to`)가 요청 시간대와 겹친다. 한 사람이 여러 근거에 걸리면 `total` 은 한 번만 센다
- **요일 선호는 회원 데이터에 없다**(`weekdays` 는 받지만 후보 판정에는 시간대만 쓴다 — 열린 점 ⑫)
- 강사의 **평가 레벨**도 후보 판정에 쓸 수 있다(FR-169d ① 모집용). 조건: 그 강사가 매긴 평가 레벨이 있으면 그 값을 우선한다

`GET …/list` 200 — **연락처 제공에 동의한 후보만** 이름·성별·연령대·레벨·근거가 나온다. 연락처는 가린 값
```json
{ "items": [ { "memberId": "…", "displayName": "김서연", "gender": "female", "ageGroup": "20s", "detailGenre": "samba", "level": 1,
               "basis": "completed_same_detail_genre", "phoneMasked": "010-••••-4821", "revealToken": "…" } ],
  "notConsentingCount": 14, "nextCursor": null, "notice": "연락처는 새 반 안내 말고 다른 용도로 쓸 수 없어요" }
```
- 동의하지 않은 후보는 `notConsentingCount` 숫자로만 나온다(S6-3 수용 ④). 이름·연락처·id 모두 내리지 않는다
- 이 경로를 부르면 감사 `candidate.list_viewed`(조건 요약만, 개인 정보 없음)
- `revealToken` 은 이 목록 응답에 묶인 서명 토큰(강사 계정 id · 회원 id · 만료 15분 — **추천값**)이다. 임의의 회원 id 로 연락처를 훔쳐보지 못하게 한다

`POST …/{memberId}/reveal-contact` 요청 `{ "revealToken": "…" }` 200 `{ "phone": "010-2814-4821" }`
- 토큰이 틀리거나 만료면 422 `CANDIDATE_TOKEN_INVALID`. 회원이 동의하지 않았거나 동의를 철회했으면 403 `CONTACT_NOT_CONSENTED`(목록을 본 뒤 철회한 경우)
- **볼 때마다** 감사 `candidate.contact_viewed`(누가·언제·누구 것 — 전체 번호는 기록하지 않는다)를 한 줄 쓴다. 감사 쓰기가 실패하면 번호를 내리지 않는다(기록이 먼저)

**S6-3.5 구현(추천안·사후 확인 2026-11-24)**: 서비스 `admin-web/lib/server/services/new-class-candidates.ts`(세 경로가 같은 후보 조회 함수 하나를 쓴다), 순수 함수 `admin-web/lib/domain/new-class-candidates.ts`, 토큰 `admin-web/lib/server/candidate-reveal-token.ts`. 후보 대상 = **그 강사가 지금 active 로 소속된 학원에서 결제한 적 있는 회원**(다른 학원 회원은 세지도 않는다), 근거 ①②도 그 학원 수업만 본다 · 레벨 = 이 강사 평가 레벨 > 회원 레벨 > 0, 이 값이 `levelFrom~levelTo` 안이어야 후보 · 한 사람에게 대표 근거 하나(완주 > 수강 중 > 시간)라 근거별 인원 합 = `total`, `basis` 는 세 줄을 늘 같은 순서로(0명 포함) · ② 「듣고 있다」 = 같은 대분류 장르 판매 단위에 예약 `confirmed` + 주문 `paid`·`partially_refunded` 이고 끝나지 않은 예정 회차가 있음 · ③ 시간 = `available_from < timeTo AND available_to > timeFrom`, `timeFrom`·`timeTo` 는 둘 다 주거나 둘 다 빼고(빼면 ③ 근거를 쓰지 않는다) · `weekdays` 는 검사만 하고 판정·문장에 쓰지 않는다 · `capacity = capacityMale + capacityFemale`(생략 0) · 근거 문장 = 「<세부 장르> 정규 과정을 끝까지 마쳤어요」·「<대분류> 수업을 듣고 있어요」·「HH:MM~HH:MM 시간대를 선호 시간으로 골랐어요」(요일 문구는 넣지 않는다 — 판정에 쓰지 않으므로) · 명단 `displayName` 은 닉네임(FR-019a), `ageGroup` 은 `ageBandOf`(20s~60s_plus), `phoneMasked` 는 기존 `maskPhone` 모양 `010-****-4821`(위 예시의 `••••` 대신 다른 명단과 같은 모양) · 쪽 크기 50, `cursor` = 앞 쪽 마지막 회원 id(회원 id 차례) · `list_viewed` 감사 대상 = 명단을 연 강사(`staff_accounts`), after 에 조건·인원만 · 토큰 = HMAC(강사 id·회원 id·만료 15분), 서명 키는 새 환경 변수 없이 `BETTER_AUTH_SECRET` 에서 용도 글자로 뽑는다. 다른 회원·다른 강사·만료·위조는 모두 422 `CANDIDATE_TOKEN_INVALID` · 보기 감사 after = `{ phoneMasked }`, 한 트랜잭션에서 감사를 먼저 쓰고 번호를 낸다

### 6-3. 오류 코드(S6-3 강사)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `INSTRUCTOR_MEMBERSHIP_REQUIRED` | 강사 멤버십이 끝나 이 기능이 잠겨 있다(데이터는 그대로) |
| 403 | `FORBIDDEN` | 그 수업 강사가 아님 · 결제하지 않은 수강생 |
| 403 | `CONTACT_NOT_CONSENTED` | 연락처 제공에 동의하지 않았다 |
| ~~409~~ | ~~`MEMBER_MEMBERSHIP_REQUIRED`~~ | 2026-11-24 폐기 — 받는 회원은 멤버십 무관(FR-169d 개정, S6-3.4) |
| 422 | `CANDIDATE_TOKEN_INVALID` · `VALIDATION_FAILED` | 토큰 · 입력 오류 |

---

## 7. S6-4 파티·공연·대회 피드

### 7-1. 회원 — 피드·상세·관심

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/events?kind=&genre=&from=&to=&regionSido=&regionGu=&cursor=&limit=20` | 전 학원 통합 행사 피드 | — | FR-150 · FR-151 | M24 |
| `GET /api/events/{classId}` | 행사 상세(파티·공연·대회) | — | FR-152 · FR-153 · FR-155 · FR-157 | C3A · C3B · C3C · C18A |
| `PUT /api/events/{classId}/interest` | 관심(♡) 등록 | 이미 등록이면 200 | FR-154 | M24 · C3C |
| `DELETE /api/events/{classId}/interest` | 관심 해제 | 없으면 200 | FR-154 | M24 |
| `GET /api/me/event-interests` | 내 관심 행사 | — | FR-154 | M24 |

`GET /api/events` 200 — 게시된 행사만, 날짜순. 승인 안 된 개인·동호회 주최자의 행사는 애초에 게시되지 않으므로 나오지 않는다(S6-4 수용 ②)
```json
{ "items": [ { "classId": "…", "kind": "party", "title": "라틴 나이트", "startsAt": "2026-11-28T11:00:00Z",
               "host": { "kind": "individual", "label": "개인", "displayName": "수연" },
               "tags": ["party", "individual", "salsa_bachata"], "isFestival": false, "genre": "salsa_bachata",
               "seats": { "male": { "left": 4, "capacity": 20 }, "female": { "left": 0, "capacity": 20 } },
               "refundDeadline": "2026-11-26", "priceAmount": 30000, "bookingMode": "platform", "interested": false } ],
  "interestCount": 3, "nextCursor": null }
```
- `kind` 칩 `party` · `performance` · `competition`(전체는 생략). 장르는 회원의 장르를 기본으로 미리 골라 보내는 것은 앱의 몫이다(서버 기본값 없음). `from`·`to` 는 KST 날짜. 지역은 행사 장소(`event_details.region_*`) 기준
- 정렬은 시작 시각 오름차순이다. 「이번 주말」「다음 주 이후」 묶음은 앱이 `startsAt` 으로 나눈다
- `seats` 는 성별 정원이 있는 행사에만(한쪽이 마감이면 `left: 0`). 환불 마감일(`refundDeadline`)은 FR-099d 의 값이다 — 칸이 없으면 null

`GET /api/events/{classId}` 200(파티)
```json
{ "classId": "…", "kind": "party", "title": "라틴 나이트", "posterUrl": "…", "isFestival": false,
  "startsAt": "…Z", "endsAt": "…Z", "venue": { "name": "…", "address": "…", "regionSido": "서울", "regionGu": "강남구" },
  "host": { "id": "…", "kind": "individual", "label": "개인", "displayName": "수연" },
  "bookingMode": "platform", "externalBookingUrl": null,
  "fee": { "amount": 30000, "bookingFeePerPerson": 2000, "bookingFeeRefundable": false },
  "seats": { "male": { "left": 4, "capacity": 20 }, "female": { "left": 0, "capacity": 20 } },
  "refundDeadline": "2026-11-26",
  "paymentMethods": ["easy_transfer", "virtual_account"], "performers": [],
  "competition": null, "interested": false }
```
- **행사 신청은 계좌이체 수단만 보인다**(S6-4 수용 ①): `paymentMethods` 에 카드·간편결제가 없다. 값 이름은 M3 의 `payments.method` 를 따른다(열린 점 ③)
- 공연(C3C)이고 외부 예매면 `bookingMode: "external"` · `externalBookingUrl` 이 있고 `fee`·`paymentMethods`·`seats` 는 null/빈 값, `performers`(`teamName` · `instructorName` · `genre`)가 채워진다. 출연 팀이 4팀 이상이면 앱이 「그 밖에 n팀」으로 접는다. 앱 결제 화면을 거치지 않는다(FR-153)
- 대회(C18A)는 `competition` 이 채워진다
```json
{ "competition": { "disciplines": [ { "optionId": "…", "label": "왈츠", "pairFeeAmount": 40000 }, { "optionId": "…", "label": "탱고", "pairFeeAmount": 40000 } ],
                   "divisions": [ { "optionId": "…", "label": "아마추어 A" } ], "bookingFeePerPerson": 2000 } }
```
- 종목명은 D11 의 이름(「왈츠」「슬로우폭스트롯」)을 그대로 쓴다
- 게시되지 않은 행사·존재하지 않는 id 는 404 `NOT_FOUND`. 주최자 승인 전 행사도 404

`PUT /api/events/{classId}/interest` 200 `{ "interested": true, "count": 4 }`. 행사가 열리거나(`event_opened`) 일정이 확정·변경되면(`event_changed`) 관심 회원마다 알림 행을 쓴다(FR-154, S6-4.6) — `dedupe_key = event:<classId>:<kind>:<memberId>`(받는 사람별). 알림 쓰기는 행사 게시·변경 경로가 같은 트랜잭션에서 부른다. 발송은 M7.

### 7-2. 행사 신청 — 03 §1(주문 생성)을 그대로 쓴다

새 결제 경로를 만들지 않는다. 주문 생성 요청에 **대회일 때만** 아래 칸이 더해진다.
```json
{ "offeringId": "…", "seatKind": "male", "method": "easy_transfer", "noticesAcknowledged": true,
  "competitionEntry": { "divisionOptionId": "…", "disciplineOptionIds": ["…", "…"], "partner": { "name": "이하나", "gender": "female", "memberId": null } } }
```
- 종목은 여러 개·부문은 하나(FR-156). 서버가 종목별 `pair_fee_amount` 의 합을 정가로, 예매 수수료(FR-282a)는 참가자 수만큼 별도 줄로 계산한다 — 클라이언트 금액은 받지 않는다. 종목이 하나도 없거나 이 행사의 선택지가 아니면 422 `VALIDATION_FAILED`
- 서버가 막는 것: ① `bookingMode='external'` 행사는 주문을 만들지 않는다 → 409 `EXTERNAL_BOOKING_ONLY`(S6-4 수용 ③) ② 카드·간편결제 → 422 `METHOD_NOT_ALLOWED`(이벤트형 허용 수단 밖, FR-280) ③ 주최자가 승인 상태가 아니면(게시 전) 404
- 2명부터의 동반·단체 신청은 S4-4 가 같은 경로를 넓힌다. 취소·환불 규칙은 S4-2(이벤트형)가 정한다

### 7-3. 주최자 — 학원은 승인 없이, 개인·동호회는 신청 후 승인(FR-155)

| 메서드·경로 | 역할 | 권한 | 멱등 | 보드 |
|---|---|---|---|---|
| `POST /api/event-hosts` | 개인·동호회 주최자 신청 | 로그인 직원(대표 역할) | 열린 신청이 있으면 409 | (보드 없음 — 열린 점 ⑬) |
| `GET /api/event-hosts/me` | 내 주최자 상태 | 같음 | — | — |
| `GET /api/admin/event-hosts?status=pending&cursor=` | 신청 목록 | `admin` | — | — |
| `POST /api/admin/event-hosts/{hostId}/approve` | 승인 | `admin` | 이미 `approved` 면 200 | — |
| `POST /api/admin/event-hosts/{hostId}/reject` | 거절(사유) | `admin` | 이미 `rejected` 면 200 | — |

- 신청 요청 `{ "hostKind": "club", "displayName": "라틴 동호회 '밤'", "note": "월 1회 파티를 엽니다" }` → 201 `{ "hostId": "…", "status": "pending" }`. **심사 기준·제출 서류·정산 계좌 연결은 spec 이 정하지 않았다**(FR-155 ⚠). 지금은 이름·유형·소개 글만 받는다
- 승인 → `approved_at`(수수료 1년 면제 기산일) · 알림 `event_host_approved` · 감사 `event_host.approved`. 거절 `{ "reasonText": "…" }` 필수 → 알림 `event_host_rejected` · 감사 `event_host.rejected`. 이미 다른 상태면 409 `HOST_STATE_CONFLICT`
- **승인 전에는 행사 등록·게시·결제를 열지 않는다**: 행사 게시 경로(M2 의 수업 등록 가드)가 `host.status='approved'` 가 아니면 409 `HOST_NOT_APPROVED` 를 낸다. 학원 주최자는 입점 승인된 학원이면 승인 없이 올린다
- 열린 신청(`pending`·`approved`)이 이미 있으면 409 `HOST_APPLICATION_OPEN`

### 7-4. 오류 코드(S6-4)

| HTTP | code | 언제 |
|---|---|---|
| 404 | `NOT_FOUND` | 게시되지 않은 행사 · 없는 id |
| 409 | `EXTERNAL_BOOKING_ONLY` | 외부 예매 행사에 주문을 만들려 함 |
| 409 | `HOST_NOT_APPROVED` | 승인 전 주최자가 행사를 게시하려 함 |
| 409 | `HOST_APPLICATION_OPEN` · `HOST_STATE_CONFLICT` | 주최자 신청 충돌 |
| 422 | `METHOD_NOT_ALLOWED` | 이벤트형이 받지 않는 결제수단 |
| 422 | `VALIDATION_FAILED` | 대회 종목·부문·파트너 입력 오류 |

---

## 8. 상태 전이 요약

데이터 쪽 표는 `datamodel_draft_M6.md` §11-2·§11-6. 경로 관점의 요약만 적는다.

| 대상 | 전이 | 부르는 경로 |
|---|---|---|
| 멤버십 | (없음) → `trial`(가입·활성·입점 승인 때 자동) | 회원 가입·강사 활성·입점 승인 경로가 부른다 |
| 멤버십 | `trial`·(없음) → `active` | 1-3 가입 · 웹훅(직접 결제) |
| 멤버십 | `active` → `retrying` → `active`·`ended` | 내부 작업 `membership-billing` |
| 멤버십 | `active`·`retrying` → `cancel_scheduled` → `active`·`expired` | 1-6 해지·해지 취소 · `membership-lifecycle` |
| 쿠폰 | `available` → `held` → `used` · `available`(풀림) · `available` → `expired` | 4-2 주문 생성·만료·환불 · `coupon-expiry` |
| 쿠폰 | `used` → `available`(되살림) | 환불(S4-1 실행 경로, FR-296) |
| 레벨 제안 | `offered` → `accepted`·`declined`·`superseded` | 5 accept·decline · 6-1 |
| 주최자 | `pending` → `approved`·`rejected` | 7-3 |

## 9. 수용 시나리오

1. **Given** 갱신일 7일 전의 자동 갱신 멤버십 **When** `membership-renewal-notices` 를 두 번 부른다 **Then** `membership_notices` 와 알림 행이 1건(S6-1 수용 ①)
2. **Given** 3개월 멤버십 갱신일(기준일 3일)에 결제가 실패한다 **When** 다음 날부터 작업이 돈다 **Then** 상태 `retrying`·혜택 유지, 하루 1번 3번 시도, 3번째도 실패하면 `ended`·혜택 잠금·그 회차 쿠폰 없음(수용 ②). 같은 날 작업을 두 번 불러도 시도는 1번
3. **Given** 기준일 3일 결제가 실패해 5일에 재시도가 성공한다 **When** 다음 결제일을 계산한다 **Then** 다음 기간의 3일이다(수용 ③). 1+1 쿠폰은 이 순간 한 장, 발급 기준일은 처음 기준일
4. **Given** 연 멤버십 이용 중 **When** 해지한다 **Then** `cancel_scheduled`, 만료일까지 `benefits` 유지, 환불 행 0, 응답에 환불 칸 없음(수용 ④)
5. **Given** 쿠폰 1장·정가 수업 120,000원 · 추가 수업 120,000원(1달치) **When** 1+1 로 주문한다 **Then** 정가 주문 120,000원, 추가 수업 주문 total 0(`list 120000 − coupon 120000`), 쿠폰 `held` → 결제 확정 때 `used`
6. **Given** 추가 수업 정원이 이미 찼다 **When** 1+1 주문을 만든다 **Then** 409 `COUPON_SEAT_UNAVAILABLE`, 쿠폰 `available` 그대로(S6-2 수용 ②)
7. **Given** 쿠폰을 쓴 정가 주문 **When** 전액 환불되고 쿠폰 유효기간이 남았다 **Then** 쿠폰 `available` 로 되살아난다. 부분 환불이면 되살아나지 않는다(수용 ③)
8. **Given** 인증된 대학생의 첫 결제 **When** 주문한다 **Then** 1달치 50% 가 `benefit_discount` 로 들어가고, 두 번째 결제는 정가다. 정산에 대표 부담 차액 줄 1행이 따로 있고 합계가 보존된다(수용 ④)
9. **Given** 이미 인증된 학교 이메일 **When** 다른 계정이 같은 이메일로 인증을 시작한다 **Then** 409 `SCHOOL_EMAIL_ALREADY_USED`(수용 ⑤). 테이블에 이메일 원문이 없다
10. **Given** 8회 과정을 끝까지 마치고 6회 출석(결석 표시 2) **When** `level-evaluation` 을 돈다 **Then** 그 세부 장르 레벨 +1·카드 1장. 5회 출석이면 레벨 그대로(수용 ①). 강사 표시 결석도 센다(수용 ②). 작업을 두 번 불러도 +1 은 한 번
11. **Given** 강사가 레벨 시트에서 멤버십 회원 2명에게 레벨 4 를 최종 적용한다 **When** 회원이 `accept` 한다 **Then** 레벨이 오르고 카드 1장. `decline` 이면 레벨·카드 변화 없음. **회원용 어떤 응답에도 평가 레벨 키가 없다**(수용 ③)
12. **Given** 후보 23명 중 9명만 동의 **When** 강사가 후보를 찾고 명단을 연다 **Then** 동의한 9명만 이름·가린 연락처, 나머지는 「14명」 숫자만(수용 ④). `보기`를 누르면 전체 번호 + 감사 1행
13. **Given** 강사 멤버십이 끝난 강사 **When** 레벨 정하기·개강 후보를 부른다 **Then** 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED`, 데이터는 그대로
14. **Given** 승인 안 된 개인 주최자의 행사 **When** 피드를 조회한다 **Then** 0건(S6-4 수용 ②)
15. **Given** 파티 상세 **When** 결제 수단을 조회한다 **Then** 카드가 없다(수용 ①). 외부 예매 공연에 주문을 만들면 409 `EXTERNAL_BOOKING_ONLY`(수용 ③)
16. **Given** 학원 B 대표 **When** 학원 A 의 `coupon-participation/report` 를 부른다 **Then** 403 `FORBIDDEN`. 위임 강사도 403

## 10. Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | `computeYearlyPrice`(12,000−1,200=10,800 · 120,000−12,000=108,000) · `nextBillingDate`(FR-120a 예: 1/31 → 4/30 → 7/31 → 10/31, 2/29 → 다음 해 2/28, 4월로 밀려도 7월은 31일 기준) · 혜택 열림 함수(상태별) · 쿠폰 만료 계산 · 1+1 조건 판정(±30일·쿠폰 기간·레벨 매핑·라틴 장르) · `evaluateCompletion`(8회 6회 출석 +1 · 5회 0 · 휴강 제외 · 환불 있으면 0 · 레벨 10 상한) · 단계 이름 매핑 · 대학생 할인 1달치 50% · 할인 합 자르기 · 가린 이메일 |
| DB | `uq_memberships_member_live` 한 사람 한 멤버십 · `uq_charges_attempt`·`uq_charges_period_succeeded`(기간당 성공 1건) · `uq_trial_grants_ci` · `uq_coupons_source_kind` · 쿠폰 조건부 잠금 동시 2건 → 1건 · `uq_redemptions_paid_order`·`uq_redemptions_coupon_live` · `uq_univ_email_blocked` · 테이블에 이메일 원문 칸 없음(스키마 검사) · `ck_levels_range`·레벨 내려가는 쓰기 0행 · `uq_promotions_completion` · `ck_event_details_external` · `ck_event_hosts_shape` |
| 통합 | 시나리오 1~16 · 재시도 3번 후 종료 전체 흐름(가짜 빌링) · 정원 경합에서 쿠폰 되돌림 · 환불 뒤 쿠폰 처리 · 주문 만료로 쿠폰·동반자 자리 풀림 · 회원용 응답 JSON 에 `evaluation`·`eval` 류 키와 출석 숫자 키가 없음(키 이름 전수 검사) |
| E2E(Playwright·Expo 웹) | M18 · M18B · C8A · C8B · C16A · C16B · M19 · C7A · M25 → M25C · I23 · I15 · I15B · M24 · C3A · C3C 스크린샷 — 화면에 출석 횟수·%·나이 표현이 없는지 |

## 11. 열린 점

근거가 없는 칸·규칙의 추천값은 2026-11-20 사용자 결정 D20 으로 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이다. 데이터 쪽 열린 점은 `datamodel_draft_M6.md` §11-11.

| # | 무엇 | 추천·결정 필요 |
|---|---|---|
| ① | 요금표 변경 경로 — FR-112 「운영자가 바꿀 수 있게 설정」, FR-301 예외 목록에는 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 회차는 시드 + 운영자 스크립트. 콘솔 편집 화면은 FR-301 을 고친 뒤 |
| ② | 체험 중 결제하면 남은 체험 기간 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 결제하는 순간 체험이 끝나고 결제 기간이 시작(남은 체험은 버림) — M18 화면에 안내 문구가 필요 |
| ③ | 멤버십 청구와 `payments.method` 값 이름·웹훅 분기(`mbr_` 접두어) | **M3(03-checkout-payment.md)와 조율** |
| ④ | 법정 사전 고지 기한(FR-112 7일 전은 추천값) · 계좌이체 직접 결제의 3일 전 | 법률 확인 뒤 설정값 |
| ⑤ | 대표 가맹점 프로모션(수수료 5% 시작일부터 1년 더 무료)의 시작일 신호 | **M5 와 조율** — `platform_fee_exempt_until` 이 지나는 시점에 작업이 `trial_ends_at` 을 늘린다 |
| ⑥ | 가격 미리보기 경로(`/api/me/price-preview`)가 03 에 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 계약이 정의. M3 가 같은 일을 이미 정했으면 그쪽으로 합친다 |
| ⑦ | 정산 원장의 줄 이름(`coupon_burden` — M5 열린 점 ⑮ 가 M6 정의를 기다림)과 멤버십 수입 줄(플랫폼 수입 원장) | **M5(13-settlement.md)와 조율**. D5: P1·P5 의 멤버십 수입·비용·손익은 멤버십 결제가 열린 뒤 — 이 계약의 청구 성공이 그 원천이 된다 |
| ⑧ | 인증 메일의 재발송 간격·일 한도·링크 유효 시간 · 메일 발송 수단(무료 구간 확인) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 간격 60초 · 하루 5회 · 유효 24시간 / 발송은 가짜로 시작, 실 수단은 사용자 확인 |
| ⑨ | 학생 인증 회수 경로가 FR-301(콘솔 조회 전용) 밖에 있다 | **M7 15-ops.md 와 조율** — 운영자 도구로 둘지 |
| ⑩ | ~~순위판·신규 참여 카드·참여학원 목록 Task 가 로드맵에 없다~~ | **2026-11-20 통합으로 닫음** — 경로는 §4-4b, Task `S6-2.9`(순위판·참여 학원 목록·신규 참여 카드)를 로드맵에 더했다 |
| ⑪ | 개강 후보 연락처 동의를 받는 화면이 보드에 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 마이(M12)에 「새 반 안내에 연락처 제공」 줄 하나, 기본값은 동의 안 함 |
| ⑫ | 후보 판정의 **요일 선호** — 회원 데이터에 시간대(`available_from/to`)만 있고 요일이 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 회차는 시간대만으로 판정. 요일 칸은 M3(취향) 가 받는 칸이 생기면 |
| ⑬ | 개인·동호회 주최자 신청 화면·심사 기준·서류·정산 계좌 연결(FR-155 ⚠) · 그 사람의 계정 종류 | 결정 대기. 이 계약은 직원 계정(대표 역할)으로 신청한다고 가정 |
| ⑭ | 휴강·폐강 회차를 출석 분모에서 빼는가 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 뺀다. **M4 와 조율** |
| ⑮ | `classes.detail_genre`(세부 장르)·`class_offerings.monthly_price_amount`(1달치) 칸이 M2 에 정의돼 있는가 | **M2 와 조율**(대학생 50%·1+1 무료 1달치가 이 값을 쓴다) |
| ⑯ | 동반자의 첫 회차 자리를 회차별로 세는 방법 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 앱이 `seat_pools` 를 `FOR UPDATE` 로 잠그고 검사(데이터 §11-3). 회차별 정원 칸은 M3·M4 와 같이 |
| ⑰ | 「지금 다시 결제하기」(C8A 보조 버튼) 경로 | 만들지 않는다(보드 주석: 빼도 흐름이 성립). 필요하면 `membership-billing` 을 그 회원 하나에 부르는 경로를 더한다 |
| ⑱ | 알림의 거래·서비스·광고성 구분(끌 수 있는지) | **M7 15-ops.md 와 조율** — 이 계약의 멤버십 청구·고지·수단 변경은 거래, 쿠폰·행사·레벨은 서비스로 제안 |
| ⑲ | 순위판(§4-4b)의 **수업 검색 조회수** 원천 표 · 「전체 학원 순위」 토글(`scope=all`)이 참여하지 않은 학원 수업까지 보여 주는지 — FR-121d 는 「참여 학원에게만」 순위 혜택을 준다고 한다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 조회수는 수업 상세를 검색 결과에서 연 횟수를 회원·수업·시간(시) 단위 카운터로 센다(같은 회원 1시간 1번) — M3 S3-2 와 조율. `scope=all` 은 참여 여부와 무관한 전체 순위로 두고 기본값은 `participating` |
| ⑳ | 참여학원 목록(C32B)의 「대표가 고른 수업」을 고르는 화면·칸이 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 판은 고르는 칸 없이 「개강이 가장 가까운 모집 중 수업」으로 대신한다. 고르게 하려면 W7a 에 칸 하나(`featured_offering_id`)를 더한다 |
