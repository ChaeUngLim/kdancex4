# 계약 — 실 어댑터(M8): 실 PG(포트원 V2) · 웹훅 서명 · 하위 판매자·영수증·지급대행 · 소셜 로그인 3사 · 휴대폰 본인확인 (S8-1(실 PG 연동) · S8-2(소셜 로그인·본인확인 실연동))

- 작성 2026-11-20 · 공통 규칙은 `README.md`(경로 `/api` · §3 값 형식 · §4 오류 · §5 멱등 · §6 직원 인증). 이 문서는 `06-ports.md`(포트 시그니처)를 **고치지 않는다** — 포트는 그대로 두고 실 어댑터가 지킬 것과, 가짜일 때는 드러나지 않던 모양 차이를 흡수하는 방법만 적는다.
- 근거: FR-110(PG 단일 결제 경로) · FR-282c(판매자별 영수증·정산 분배) · FR-282d(정산 분배로 학원 직접 지급) · FR-138(영수증·현금영수증) · FR-137(결제 자격 증명 비포함) · FR-299(결제 정보 보안) · FR-287(웹훅 확정) · FR-115(결제 금액 대조) · FR-102(환불 1회 보장) · FR-295(수단별 환불 실행) · FR-001(소셜 로그인 3사) · FR-003(본인확인 계정 식별) · FR-009(미성년자 결제 차단) · SC-023(보안 치명 0건) · SC-024(소스 자격 증명 0건) · R-11(웹훅 서명 규격) · R-P3(PG 호출은 트랜잭션 밖으로) · R12(지급대행 불가 위험) · R15(무료 확인 수단 부재 — 휴대폰 본인확인은 PG 와 같은 필수 유료 예외) · SP-2(PG 지급대행 조사) · SP-5(본인확인 업체·금액) · SP-11(노트북 외부 접속 경로).
- 외부 API 는 무료 구간만 쓴다는 규칙의 예외는 **PG 결제와 휴대폰 본인확인 둘뿐**이다(2026-11-19). 소셜 로그인 3사 OAuth 는 무료이고 그 밖의 새 유료 호출은 이 문서가 만들지 않는다.
- 이 문서가 확인한 근거: 포트원 개발자 문서(Context7 `/portone-io/developers.portone.io`)와 설치본 `admin-web/node_modules/@better-auth/core/dist/social-providers/{kakao,naver,google}`. 확인하지 못한 것은 각 절에서 **미확인**이라고 적었다. 실측은 S8-1.5(테스트 모드 한 바퀴)와 S8-1.1(SP-2)에서 한다.

## 0. 이 문서의 범위 — 새 경로는 거의 없다

M8 은 새 기능이 아니라 가짜 자리에 실물을 끼우는 일이다. 새로 생기거나 모양이 바뀌는 경로만 아래에 모았다. 나머지는 어댑터 규칙(§2~§8)이다.

| 메서드·경로 | 새로/바뀜 | 역할 | 권한 | 멱등 | 근거 · 보드 |
|---|---|---|---|---|---|
| `POST /api/identity/verifications` | **새로** | 휴대폰 본인확인 시작 — 서버가 `identityVerificationId` 를 만들고 이 세션에 묶는다 | 세션(가입 미완료여도 됨) | 열린 시도가 있으면 같은 id(유효 10분) | FR-003 · S8-2.3 |
| `POST /api/members` | 바뀜(`01-member-onboarding.md` §3) | 가입 완료 — 실 본인확인 + 같은 CI 계정 묶기 | 세션 | 같은 CI·같은 회원이면 200 | FR-003 · S8-2.2 |
| `POST /api/orders` | 바뀜(`03-checkout-payment.md` §1) | 응답에 `checkout`(결제창 재료)이 붙고 가상계좌는 나중에 채워진다 | 회원 | `Idempotency-Key` | FR-110 · S8-1.3 |
| `POST /api/payments/webhook` | 바뀜(`03-checkout-payment.md` §6) | 실 서명 검증 + 처리 순서를 트랜잭션 밖 PG 호출로 | 서명 | `webhook-id` | FR-287 · R-11 · R-P3 |
| `GET /api/orders/{orderId}/receipts` | **새로임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** | 판매자별 영수증 두 장(학원 · 회사) 링크 | 주문한 회원 | 읽기 | FR-138 · FR-282c · S8-1.6 |
| `POST /api/academies/{academyId}/sub-merchant/register` | **새로임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** | 하위 판매자 등록 재시도(운영자) | `admin` | 이미 등록이면 200 같은 본문 | FR-282d · S8-1.6 |
| `POST /api/auth/sign-in/social` | Better Auth 경로 | 카카오·네이버·구글로 로그인 시작 | 공개 | — | FR-001 · S8-2.1 |
| `GET /api/auth/callback/{provider}` | Better Auth 경로 | 공급자가 돌아오는 주소 | 공개 | — | FR-001 · S8-2.1 |

- Better Auth 경로의 응답 모양은 Better Auth 1.7.5 그대로다(README §2). 설치본에 `kakao`·`naver`·`google` 공급자가 모두 들어 있다(실측 — `@better-auth/core/dist/social-providers`).
- `POST /api/dev/identity/fake-verify`(`01-member-onboarding.md` §2)와 `POST /api/dev/fake-pg/**`(`03-checkout-payment.md` §7)는 운영 배포에서 `KDANCE_DEV_ROUTES=false` 라 404 다. 실 어댑터를 켜는 환경에서는 가짜 어댑터를 부팅 때 거부한다(S0-6 수용 ②③).
- 지급대행(S8-1.8)은 새 경로가 없다. 대표 앱 지급 승인 경로(S5-3 이 정한다)가 `PayoutPort` 의 실 구현을 부를 뿐이다(§7).

## 1. 지켜야 할 큰 규칙 열 가지

1. **포트 시그니처는 바뀌지 않는다.** 서비스 코드는 `deps.ts` 에서 주입된 포트만 알고 가짜와 실물을 구별하지 않는다(`06-ports.md`).
2. **같은 계약 테스트를 통과한다.** 가짜와 실물이 같은 테스트 묶음(`tests/contract/<port>.contract.ts`)을 돈다. 실물 쪽은 테스트 모드 키가 없으면 **skip 이 아니라 실패**한다(S8-1.3).
3. **PG 호출은 DB 트랜잭션 밖에서 한다**(R-P3, §3). 어댑터는 트랜잭션 안에서 불리면 예외를 던진다.
4. **웹훅 본문은 믿지 않는다.** 서명이 맞아도 `getPayment` 로 PG 가 말하는 상태·금액을 다시 읽는다(FR-287 · FR-115).
5. **모르는 것은 성공으로도 실패로도 단정하지 않는다.** 시간 초과·모호한 응답은 `pending` 으로 두고 PG 에 다시 물어 확정한다(§2-3).
6. **키는 소스에 없다**(SC-024). 환경 변수 이름만 코드에 있고 값은 저장소 밖 파일에 둔다(§2-4).
7. **로그에 카드번호·계좌·CI·키·웹훅 본문 전체를 남기지 않는다**(FR-299). 남기는 것은 요청 id · `gatewayPaymentId` · 금액 · 상태 · 소요 시간뿐이다.
8. **멱등은 우리 DB 가 권위다.** PG 의 멱등 키는 보조이고(보장 기간 3시간), 이중 처리 방지는 `refunds` 부분 유니크·`payment_webhook_events` 유니크·주문 상태 조건부 갱신이 한다(README §5).
9. **테스트 모드와 운영은 키·웹훅 주소·DB 가 섞이지 않는다.** `PG_MODE` 와 DB 환경 표식이 맞지 않으면 부팅 거부(S0-6).
10. **어댑터 오류는 한 가지 모양으로 올린다**: `AdapterError { kind: 'rejected' | 'not_found' | 'timeout' | 'unavailable' | 'invalid_response' | 'unsupported_method' | 'config', retryable: boolean, gatewayCode?: string }`. 서비스는 `kind` 만 보고 분기하고 PG 의 원문 메시지를 응답에 싣지 않는다(README §4 「`detail` 에 내부 정보를 담지 않는다」).

## 2. 실 어댑터 공통

### 2-1. 시간 제한과 재시도(추천값 — 실측으로 고친다)

| 호출 | 제한 | 재시도 | 멱등 키 |
|---|---|---|---|
| `getPayment`(읽기) | 5초 | 시간 초과·5xx·연결 오류에 2번(200ms · 800ms 뒤) | 해당 없음 |
| `cancelPayment`·`refund`(쓰기) | 15초 | **같은 멱등 키로만**, 시간 초과·연결 오류에 1번 | 아래 |
| 본인확인 조회 | 10초 | 연결 오류에만 1번 | 해당 없음 |
| 하위 판매자 등록·지급대행(쓰기) | 15초 | 같은 멱등 키로만 1번 | 아래 |

- 포트원 V2 REST 는 헤더 `Idempotency-Key`(16~256자 ASCII, 보장 기간 3시간 — 공식 문서 확인)를 받는다. 우리 키는 8~200자(README §5)라 길이가 안 맞는다. 어댑터가 `sha256(<종류> + ":" + <우리 멱등 키 또는 refund id>)` 의 16진 64자를 PG 키로 쓴다. 3시간이 지난 재시도는 PG 키가 못 막으므로 **재시도하기 전에 `getPayment` 로 상태를 먼저 읽고**, 이미 취소돼 있으면 쓰기를 다시 보내지 않는다.
- 4xx(요청이 틀림·거절)는 재시도하지 않는다. 5xx·시간 초과·연결 오류만 `retryable: true`.

### 2-2. 포트원 → 우리 값 변환

| 우리 | 포트원 | 비고 |
|---|---|---|
| `GatewayPayment.status = 'ready'` | `READY` · `PENDING` · `VIRTUAL_ACCOUNT_ISSUED` · `PAY_PENDING` | 아직 돈이 안 들어옴 |
| `'paid'` | `PAID` · `PARTIAL_CANCELLED` | 부분 취소돼도 결제는 유효하다. 취소분은 `refunds` 원장이 권위이고 포트에는 칸이 없다(열린 점 ⑤) |
| `'cancelled'` | `CANCELLED` · `FAILED` | 실패한 결제도 「돈이 안 나갔다」는 뜻으로 같다(`03-checkout-payment.md` §8 M-03) |
| `'expired'` | (PG 상태가 아님) | 입금 기한 경과는 우리 `due_at` 로 판정한다. 가상계좌 만료 때 포트원 상태가 무엇으로 바뀌는지는 **미확인** — S8-1.5 에서 실측 |
| `amount` | `amount.total` | 정수 원. 정수가 아니거나 안전 정수 밖이면 `invalid_response` |
| `transactionId` | `transactionId` | 웹훅 `data.transactionId` 와 같은 값이어야 한다(다르면 기록만) |
| 결제수단 `payMethod` | 카드 `CARD` · 간편결제 `EASY_PAY` · 간편 계좌이체 `TRANSFER` 또는 `EASY_PAY`(**미확인**) · 가상계좌 `VIRTUAL_ACCOUNT` | 우리 값 이름은 S3-3 이 정한 `payments.method` 를 따른다. 「간편 계좌이체」가 포트원의 어느 값인지는 PG 계약·채널 구성에 따라 달라 S8-1.1(SP-2)·S8-1.5 에서 확정 |
| 가상계좌 입금 기한 | 결제창 요청의 `virtualAccount.accountExpiry.dueDate`(RFC 3339) | 우리 `dueAt`(`computeDueAt`)을 그대로 쓴다. 포트원은 KST 날짜·시각으로 바꿔 PG 에 넘긴다 |

웹훅 `type`(버전 `2024-04-25`, 공식 문서 확인)별 처리:

| `type` | 처리 |
|---|---|
| `Transaction.Paid` | 확정 처리(`03-checkout-payment.md` §6) — 가상계좌는 입금이 끝난 순간 |
| `Transaction.VirtualAccountIssued` | 발급된 가상계좌를 `payments.virtual_account_*` 에 채운다(§3-1). 상태는 안 바꾼다 |
| `Transaction.Failed` | 결제 실패 처리(M-03) |
| `Transaction.Cancelled` · `Transaction.PartialCancelled` | 우리가 낸 환불·취소의 결과면 `refunds`(`pending` → `succeeded`)를 확정하고, 우리가 낸 것이 아닌 취소(PG 콘솔에서 직접 한 취소)면 `payment_webhook_events.result = 'ignored'` + 운영자 경보 |
| `Transaction.CancelPending` | 환불 `pending` 유지(비동기 취소 — 완료 통지를 기다린다) |
| `Transaction.DisputeCreated` · `Transaction.DisputeResolved` | 차지백 통지 — 기록 + 운영자 경보. 지급 보류는 S5 의 FR-252a 규칙이 한다 |
| `Transaction.Ready` · `Transaction.PayPending` · 그 밖(빌링키 계열 등) | `ignored` |

### 2-3. 실패했을 때 우리 쪽 상태 — 가장 중요한 표

| 사건 | 우리 상태 | 응답·후속 |
|---|---|---|
| 웹훅 서명·시각 불일치·헤더 누락 | 아무것도 바꾸지 않는다. `payment_webhook_events.result = 'rejected_signature'` | 401 `INVALID_SIGNATURE` + 운영자 경보(S7-4 「웹훅 서명 실패」) |
| 웹훅 처리 중 `getPayment` 시간 초과·5xx | 확정하지 않는다. 웹훅 행은 `received` 로 남는다(§4-1) | 500 — PG 가 다시 보낸다. 다시 온 같은 `webhook-id` 는 처리를 이어 간다 |
| `getPayment` → 결제 없음(`not_found`) | 확정하지 않는다 | 200 `ignored`(포트원 공식 예시도 이 경우 200) + 기록 |
| 세 금액(주문·결제·PG)이 다름 | 확정하지 않는다(`amount_mismatch`, FR-115) | 카드·간편결제면 **같은 처리 안에서 PG 전액 취소를 부른다**(§3-3). 계좌 입금이면 `payment_exceptions.refund_due` 만 남긴다(돌려줄 송금은 사람이 한다, FR-290) |
| 입금 전 취소·만료 때 `cancelPayment` 시간 초과·실패 | **주문 만료·취소는 유지**한다(`payments.status` 도 `expired`/`cancelled`). PG 쪽 정리 실패는 `payments.gateway_cancel_pending = true` 로 기록 | 정리 작업이 다시 시도한다. 계속 실패하면 운영자 알림. 늦게 들어온 입금은 `deposit_on_closed_order` 가 받는다(FR-292) |
| 환불 `refund()` 시간 초과·연결 오류·모호한 응답 | **`refunds.status = 'pending'` 으로 둔다**(`failed` 로 단정하지 않는다) | `getPayment` 로 취소 내역을 다시 읽어 확정한다(`succeeded` 또는 `failed`). 확정 전에는 같은 원인의 새 환불을 만들지 않는다 — 부분 유니크 `uq_refunds_basis_active (basis_kind, basis_id) WHERE status <> 'failed'` 가 `failed` 일 때만 재시도를 허락하므로 단정하면 이중 환불이 난다(FR-102)(2026-11-20 사용자 결정 D13 — 이전: 같은 예약의 새 환불 · `uq_refunds_reservation_id_active`) |
| 환불 PG 가 명시적으로 거절(금액 초과·이미 취소됨 등) | `refunds.status = 'failed'` + `failureCode` + `refund_events` | 운영자 경보(「환불 실패」), 대표·회원 알림(FR-103). 「이미 취소됨」은 먼저 `getPayment` 로 확인해 사실이면 `succeeded` 로 수렴 |
| 환불 요청 금액이 취소 가능 잔액을 넘음 | 거절(`rejected`, `gatewayCode`) | `currentCancellableAmount` 를 채워 보내 PG 가 잔액이 맞을 때만 취소하게 한다(공식 문서 확인 — 동시 환불 이중 취소 방어선 2중) |
| 키·설정 오류(`config`) | 부팅 때 실패(운영). 요청 중이면 503 | `PG_UNAVAILABLE` / `IDENTITY_UNAVAILABLE` — 결제는 시작되지 않고 돈·자리는 건드리지 않는다 |
| 본인확인 조회 시간 초과·5xx | 가입하지 않는다 | 503 `IDENTITY_UNAVAILABLE`(시도는 열린 채로 남아 다시 누를 수 있다) |

새 오류 코드(README §4 표에 더한다): 503 `PG_UNAVAILABLE` · 503 `IDENTITY_UNAVAILABLE` · 409 `SELLER_NOT_READY` · 422 `IDENTITY_NOT_VERIFIED`.

### 2-4. 비밀값 — 이름만 소스에 둔다(SC-024 · FR-137)

저장소 밖 `~/.config/kdance/portone.test.env`·`portone.live.env`(NVIDIA 키 `nvidia.env` 와 같은 방식, 추천)에 두고 S0-6 비밀값 목록에 더한다. 같은 기계에서 테스트와 운영 파일을 따로 둔다(10-3 ⑪).

| 이름 | 비밀인가 | 어디서 쓰나 |
|---|---|---|
| `PORTONE_API_SECRET` | **비밀** | 서버가 PG REST 를 부를 때(`Authorization: PortOne <secret>`) |
| `PORTONE_WEBHOOK_SECRET` | **비밀** | 웹훅 서명 검증 |
| `PORTONE_STORE_ID` · `PORTONE_CHANNEL_KEY_<수단>` · `PORTONE_IDENTITY_CHANNEL_KEY` | 공개 식별자(결제창 SDK 에 쓰인다) | `checkout` 조립. `NEXT_PUBLIC_` 으로 노출하지 않고 서버가 `checkout` 응답으로 내려준다 |
| `PG_MODE`(`test`·`live`) | — | 위 값 묶음과 DB 환경 표식이 맞는지 부팅 때 대조 |
| `KAKAO_CLIENT_ID` · `KAKAO_CLIENT_SECRET` · `NAVER_…` · `GOOGLE_…` | **비밀**(secret 쪽) | Better Auth 소셜 공급자 |
| `IDENTITY_CI_PEPPER` | **비밀** | CI → `ciHash`(가짜와 같은 값. 바꾸면 기존 회원의 CI 가 어긋난다 — 바꾸지 않는다) |

소스 검사: `grep -rnE 'PORTONE|imp_[0-9a-z]{8}|sk_(live|test)_' admin-web/lib admin-web/app mobile/app mobile/lib` 가 환경 변수 **이름** 말고는 0건이어야 한다(S8-1.7 — 이름을 쓰는 곳은 설정 읽기 한 모듈로 모은다). 웹훅·API 비밀은 로그·오류 본문·`rawResponse` 어디에도 없다.

## 3. S8-1.2 — PG 호출을 트랜잭션 밖으로, 그리고 포트원이 가짜와 다른 점

### 3-1. 모양 차이 하나: 포트원 V2 는 결제를 **브라우저 SDK** 가 만든다

가짜 PG 는 서버가 `createPayment` 로 결제를 만들고 가상계좌를 바로 돌려준다(`06-ports.md`). 포트원 V2 는 결제창 SDK(`requestPayment({ storeId, channelKey, paymentId, orderName, totalAmount, currency, payMethod, … })`)가 결제를 만들고, 서버는 **그 뒤** `getPayment`·웹훅으로 확인한다(공식 문서 확인). 가상계좌 번호는 결제창이 끝난 뒤 `Transaction.VirtualAccountIssued` 웹훅으로 알려진다. 포트를 고치지 않고 이렇게 흡수한다.

1. 실 어댑터의 `createPayment` 는 **PG 를 부르지 않고** `{ status: 'ready' }` 만 돌려준다(`cardCheckoutKey`·`virtualAccount` 없음).
2. `POST /api/orders` 가 응답에 `checkout` 을 더한다. 재료는 설정값과 주문값이라 포트가 알 필요가 없다(06-ports 개정 불필요).

```json
{ "id": "…", "status": "pending", "…": "(03 §1 기존 칸 그대로)",
  "checkout": { "provider": "portone", "storeId": "store-…", "channelKey": "channel-key-…",
                "paymentId": "<gateway_payment_id>", "payMethod": "CARD", "totalAmount": 120000, "currency": "KRW",
                "orderName": "살사 정규 입문 · 12월 기간",
                "virtualAccount": { "dueDate": "2026-11-21T09:00:00Z" } } }
```
`virtualAccount` 는 가상계좌 주문일 때만 있다. `checkout` 은 가짜 어댑터를 쓰는 환경에서는 `null` 이고 가상계좌가 응답에 바로 들어 있다 — **앱은 둘 다 처리한다**(`checkout` 이 있으면 SDK 를 열고, 없으면 기존 화면). 가상계좌 번호는 `GET /api/orders/{orderId}` 가 웹훅 뒤에 채워서 준다(`virtualAccount: null` → 값). 앱이 번호를 못 받은 채 이탈해도 주문 조회로 복구된다(M-04).

3. **금액은 클라이언트가 정한다**(`totalAmount` 는 SDK 인자). 그래서 서버는 확정 때 주문 `total_amount` · 결제 `amount` · PG 응답 금액 셋을 대조하고(FR-115), 다르면 §3-3 으로 간다.

### 3-2. 트랜잭션 경계 — 모든 PG 호출은 커밋 밖(R-P3)

`03-checkout-payment.md` 의 §5(만료)·§6(웹훅)은 PG 호출을 한 트랜잭션 안에 두는 모양이다. 실 PG 는 응답이 느릴 수 있어 그 사이 행 잠금을 쥐면 안 된다. 아래 순서로 바꾼다(주문·예약 상태 전이 규칙은 그대로, **PG 호출의 위치만** 바뀐다).

| 흐름 | 1단계 — 트랜잭션 안(DB 만) | PG 호출 — 트랜잭션 밖 | 2단계 — 트랜잭션 안(결과 반영) |
|---|---|---|---|
| 주문 생성 | 주문 `pending` · 예약 `held` · 결제 `ready`(`gateway_payment_id` 채번) | 없음(§3-1) | — |
| 웹훅 확정 | 서명·시각 검증(로컬) → `webhook-id` 행을 `received` 로 넣는다(§4-1) → 커밋 | `getPayment` | 세 금액 대조 → 주문 `pending → paid` 조건부 갱신 · 예약·정원·캘린더·알림·정산 보류 → 웹훅 행 결과 확정 |
| 만료 정리(입금 전 취소 포함) | 주문 `pending → expired`/`cancelled` 조건부 갱신 · 결제·예약 · `held -1` · 이벤트 | `cancelPayment`(계좌 폐기) | 성공이면 변화 없음, 실패면 `gateway_cancel_pending = true` |
| 환불(대표가 실행, 카드) | `refunds` 행 `pending` 삽입(원인당 부분 유니크 `uq_refunds_basis_active` 와 주문 합계 CHECK 가 이중 환불을 막는다, D13) · `refund_events` | `refund()` | `succeeded` · `failed` · 모호하면 `pending` 유지 |
| 지급 승인(§7) | 지급 건 `approved → requested` 조건부 갱신 · 감사 | `requestPayout` | `paid` · `failed` · 모호하면 `requested` 유지 |

**지키는 방법**: DB 트랜잭션 도우미가 `AsyncLocalStorage` 에 「트랜잭션 안」 표지를 켜고, 실 어댑터의 모든 네트워크 호출은 그 표지가 켜져 있으면 `AdapterError{ kind: 'config', detail: 'called inside transaction' }` 를 던진다. 가짜 어댑터도 같은 표지를 검사해 가짜일 때부터 어긴 코드가 걸리게 한다(S8-1.2 수용: 가짜 그대로 구조만 바꾸고 기존 테스트를 통과). 정적 검사 `! grep -rn 'transaction' admin-web/lib/server | grep -i 'gateway'` 는 근사치라 위 표지 검사를 권위로 둔다.

### 3-3. 금액이 다르거나 닫힌 주문에 승인이 온 카드 결제

카드·간편결제는 웹훅이 오기 전에 이미 승인돼 돈이 빠졌다. 가상계좌처럼 「돌려줄 송금」으로 처리할 수 없다.
- 금액 불일치 · 닫힌 주문(`expired`·`cancelled`)에 승인 · 이벤트형에 카드 승인(FR-280) → 기록(`payment_exceptions`)을 먼저 남기고 같은 처리의 PG 호출 단계에서 `cancelPayment`(전액)를 부른다. 성공하면 예외 행을 `resolved`(값 이름은 S3-3 의 `payment_exceptions.status` 에 맞춘다 — 조율), 시간 초과·실패면 `refund_due` 로 남겨 운영자가 본다.
- 계좌 입금(가상계좌·간편 계좌이체)은 우리가 돌려주는 PG 호출이 없다. 기록(`refund_due`)만 남기고 사람이 처리한다(FR-290 · FR-292).

## 4. 웹훅 서명 검증(R-11 · S8-1.4)

### 4-1. 규격 — 확인한 것과 못 한 것

| 항목 | 상태 |
|---|---|
| 헤더 3개 `webhook-id` · `webhook-timestamp` · `webhook-signature` | 가짜가 Standard Webhooks 모양으로 만들었다. 포트원 공식 예시는 서버 SDK 의 `Webhook.verify(secret, rawBody, headers)` 를 쓰고 **원문 본문**이 필요하다고 적었다(`bodyParser.text`) — 확인 |
| 웹훅 payload 모양 `type` · `timestamp` · `data.paymentId` · `data.transactionId` | 콘솔의 웹훅 버전 `2024-04-25` 에서 — 확인. 구버전(`2024-01-01`: `payment_id`·`tx_id`·`status`)은 쓰지 않는다. 콘솔에서 **버전을 `2024-04-25` 로 고정**하고, 구형 모양이 오면 `ignored` + 경보 |
| 서명 문자열 규격(`v1,<base64 HMAC-SHA256>` · 서명 대상 `id.timestamp.body` · 비밀값 해석) | **미확인** — 문서에서 직접 읽지 못했다. S8-1.4 가 설치한 서버 SDK(`@portone/server-sdk`) 소스로 확정한다. 결과를 이 문서에 반영하기 전까지 R-11 은 「부분 확인」 |
| 웹훅 재전송 횟수·간격 | **미확인** — 우리는 2xx 가 아니면 재전송된다고 가정하고 멱등으로 받는다 |

### 4-2. 검증기 `WebhookVerifier.verify(headers, rawBody, now): boolean`

포트는 **동기 boolean** 이고 SDK 의 `Webhook.verify` 는 비동기·예외 방식이라 모양이 다르다. 그래서 실 검증기는 SDK 를 부르지 않고 `node:crypto` 로 직접 짜며(가짜와 같은 방식), **SDK 는 시험에서 교차 검증용으로만** 쓴다 — 같은 입력에 SDK 와 우리 검증기의 판정이 같아야 한다.

1. 헤더 셋 모두 필수. 하나라도 없으면 `false`.
2. 서명은 원문 문자열 그대로(`await request.text()`) 검증한다. JSON 으로 읽었다 다시 직렬화한 값은 쓰지 않는다.
3. 시각 허용 오차는 가짜와 같이 5분, 과거·미래 양쪽(`now` 는 주입).
4. `webhook-signature` 에 서명 후보가 여럿(공백 구분)이면 하나라도 맞으면 통과한다(비밀값 교체 기간).
5. 비교는 `timingSafeEqual`, 길이가 다르면 먼저 `false`. 예외를 던지지 않는다.
6. 비밀값 해석(접두어가 있으면 떼고 base64 로 푸는지 등)은 §4-1 의 미확인 항목이라 SDK 교차 시험으로 정한다.
7. 실패한 요청은 본문을 믿지 않고 어떤 상태도 바꾸지 않는다 — 401 `INVALID_SIGNATURE`(README §4) + `rejected_signature` 기록 + 경보.

### 4-3. 멱등과 재전송 — `webhook-id`

가짜 구조(`03-checkout-payment.md` §6)는 웹훅 행 삽입과 처리를 한 트랜잭션에 넣어, 실패하면 행도 같이 롤백돼 재전송이 `duplicate` 로 빠지지 않았다. PG 호출을 트랜잭션 밖으로 빼면 이 성질이 깨지므로 행에 처리 단계를 둔다.

- 1단계에서 `INSERT … ON CONFLICT (webhook_id) DO UPDATE SET attempts = attempts + 1, last_seen_at = now WHERE result = 'received' AND last_seen_at < now - 60초 RETURNING`(처리 중인 행은 다른 요청이 가로채지 못하게 60초 이내 재도착은 `duplicate`). 돌아온 행이 있으면 처리를 이어 가고, 없으면(이미 확정된 행·처리 중인 행) 200 `duplicate`.
- 새 값 `payment_webhook_events.result = 'received'`(처리 중)와 칸 `attempts int`·`last_seen_at timestamptz` 가 필요하다 — `03_data-model.md` 의 M4 담당 절에 더한다(열린 점 ②). `received` 로 오래 남은 행은 `sweep` 이 `getPayment` 로 다시 맞춘다(O-14).

### 4-4. 테스트 묶음(S8-1.4)

가짜와 같은 시험(맞음 · 틀림 · 재전송 · 시각 초과 · 헤더 누락) + 서명 후보 여럿 · 원문과 재직렬화가 다를 때 거부 · SDK 교차 · 중간에 죽은 `received` 행을 재전송이 이어받는 경우.

## 5. 실 PG 어댑터 — 포트 메서드별(S8-1.3)

| 메서드 | 실 구현 |
|---|---|
| `createPayment` | 네트워크 호출 없음(§3-1). 입력 검증(금액 정수·`dueAt` 미래)만 하고 `{status:'ready'}` |
| `getPayment` | `GET /payments/{paymentId}`. 없으면 `AdapterError{ not_found }`. §2-2 로 변환. 응답 금액·상태를 신뢰의 원천으로 쓴다 |
| `cancelPayment`(입금 전 취소·만료 — 계좌 폐기) | `POST /payments/{paymentId}/cancel`. 이미 취소된 결제면 성공으로 본다. **미확인**: 가상계좌가 발급만 되고 입금되지 않은 상태에서 취소 API 가 계좌를 폐기하는지는 PG 마다 다를 수 있다 — S8-1.5 에서 수단 4종 모두 「입금 전 취소」 칸을 더해 실측한다 |
| `refund` | **카드·간편결제만** `POST /payments/{paymentId}/cancel` `{ reason, amount, currentCancellableAmount }`. 부분·전액 모두 같은 호출이다. 응답의 취소 내역 한 건 → `RefundResult`(`pgCancellationId` · `cancelledAt` 등, 원문은 `rawResponse` 에 — 카드번호·계좌는 가려서) |
| `refund`(가상계좌·간편 계좌이체) | **부르지 않는다.** 계좌 결제분의 환불은 대표가 은행에서 송금하고 「송금 완료」를 누르는 기록이다(FR-295 · W31 · O48C, 2026-11-19·20 결정 — 플랫폼은 돈을 보내지 않는다). 어댑터가 이 수단으로 `refund` 를 받으면 `AdapterError{ unsupported_method }` 를 던져 실수로 PG 환불 API 가 나가지 않게 한다. 포트의 `refundAccount`·`holderPhoneNumber` 경로(`06-ports.md` 이식분)는 운영에서 쓰지 않는다 |
| 간편결제 환불 | FR-295 표가 카드와 계좌 둘만 정해서 **미결정**(열린 점 ④). 추천: 카드와 같이 PG 취소(`EASY_PAY` 는 카드·포인트 혼합이 있을 수 있어 S8-1.5 에서 부분 취소를 실측) |

테스트 모드 수단 4종 한 바퀴(S8-1.5)의 표는 열 3개 — 카드·간편결제는 확정 → 부분 PG 취소 → 전액 PG 취소, 가상계좌·간편 계좌이체는 확정 → 부분 **송금 기록** → 전액 **송금 기록**(PG 환불 호출 0회임을 같이 확인) — 에 입금 전 취소 열을 더한다.

## 6. 하위 판매자 · 판매자별 영수증 · 정산 분배(S8-1.6, SP-2 결과에 달림)

R12 처럼 SP-2(S8-1.1)가 지원 여부를 정하기 전이라 **포트 시그니처는 정하지 않는다.** 어댑터가 지킬 성질만 적는다. 시그니처는 S5-3·S5-4 계약과 함께 정하고, 맞지 않으면 그쪽이 이긴다(`06_master-plan.md` 6-4 「제안 추가」 행).

- **등록 시점**: 입점 승인(S1-1.6) 트랜잭션이 커밋된 뒤 **밖에서** 하위 판매자 등록을 부른다. 학원 행에 `pg_seller_status`(`not_registered` · `pending` · `registered` · `failed`)와 `pg_seller_id` 를 둔다(칸 제안 — 열린 점 ②). 등록은 멱등(판매자 키 = 학원 id 로 만든 안정 값)이고 시간 초과는 `pending` 으로 두고 PG 에 다시 물어 확정한다.
- **결제 시작 조건**: `pg_seller_status != 'registered'` 인 학원의 수업은 `PG_SELLER_REQUIRED=true` 인 환경에서 주문 생성이 409 `SELLER_NOT_READY` 다. 안 막으면 대금이 회사로 들어와 FR-282c·전자금융 검토 항목 1 에 걸린다. 테스트·베타 기간에는 `false` 로 두어 기존 흐름을 유지한다(S8-4.7 앞에서 `true`).
- **실패**: `failed` 로 남기고 운영자 알림. 운영자가 `POST /api/academies/{academyId}/sub-merchant/register` 로 다시 시도한다(이미 `registered` 면 200 같은 본문, `pending` 이면 202). 사업자 정보·정산 계좌 변경(FR-139)은 새 계좌로 판매자 정보를 갱신해야 하며 갱신 전 지급은 하지 않는다(FR-252 정산 계좌 미확인 보류와 같은 규칙).
- **영수증**: 수업료는 학원 명의, 예매 수수료는 회사 명의 두 장(FR-282c · FR-138). PG 가 발급한 영수증 링크를 우리는 저장·표시만 한다.

`GET /api/orders/{orderId}/receipts` 200
```json
{ "orderId": "…", "items": [
  { "issuer": "academy", "label": "수업료", "amount": 120000, "receiptUrl": "https://…", "cashReceipt": false },
  { "issuer": "company", "label": "예매 수수료", "amount": 2000, "receiptUrl": "https://…", "cashReceipt": false } ] }
```
예매 수수료가 없는 주문은 `items` 가 한 장이다. 영수증이 아직 없으면(결제 직후 지연) `items: []` 와 `pending: true`. 남의 주문은 403 `FORBIDDEN`. 영수증 URL 은 PG 가 준 값이라 만료·접근 제한을 우리가 정하지 않는다 — 그대로 내려주고 로그에 URL 을 남기지 않는다. 이 경로 이름이 M4 의 내역 화면 계약(`04-me-calendar-notifications.md` 확장)과 겹치면 그쪽을 따른다(열린 점 ⑥).

## 7. 지급대행(S8-1.8 — 대표 앱 지급 승인, 보드 O49)

지급이 PG 지급대행으로 되는지는 SP-2 결과에 달렸다(R12 — 안 되면 베타의 수동 지급을 유지한다). 되는 경우 어댑터와 서비스가 지킬 것:

- 승인 방법은 **승인 버튼 → 확인 팝업**이다(패스키 아님 — 결정 10). 그 뒤 서버가 지급 건을 조건부 갱신으로 `requested` 로 만들고(같은 트랜잭션에서 감사 기록) **커밋 뒤** 밖에서 지급대행을 부른다(§3-2). 같은 지급 건은 한 번만 나간다 — PG 멱등 키는 지급 건 id 에서 만들고, 우리 DB 의 상태 조건부 갱신이 권위다.
- 시간 초과·모호한 응답은 `requested` 로 둔다(`paid`/`failed` 로 단정하지 않는다). PG 에 다시 물어 확정한다.
- 정산 계좌 확인이 안 된 판매자·보류 중인 건(FR-252 · FR-252a)은 호출 전에 막는다. 송금 반송은 지급 보류로 간다(FR-133a).
- 지급 결과 통지 방식(웹훅 여부)은 **미확인** — S8-1.1 결과를 받아 정한다. 통지가 없다면 `sweep` 이 조회로 보정한다(O-14 와 같은 방식).
- 호출 실패·거절은 운영자 경보 항목(「환불 실패」와 같은 줄에 「지급 실패」를 더할지는 S7-4 와 조율).

## 8. 소셜 로그인 3사 · 휴대폰 본인확인(S8-2)

### 8-1. 소셜 로그인(S8-2.1)

- Better Auth 1.7.5 의 `socialProviders` 에 `kakao` · `naver` · `google` 을 설정한다(설치본에 세 공급자가 있음 — 실측). 로그인 시작 `POST /api/auth/sign-in/social` `{ "provider": "kakao", "callbackURL": "…" }`, 공급자 복귀 `GET /api/auth/callback/{provider}`. 응답은 Better Auth 모양 그대로.
- **소셜은 「누구인가」의 증거가 아니다.** 이름·성별·생년·연락처의 원본은 본인확인(FR-003)이다. 소셜이 준 이름·이메일은 `auth.user` 에만 있고 `members` 로 복사하지 않는다. 요청 범위(scope)는 공급자별 최소(식별자 + 프로필)로 하고 이메일 동의가 필수인 공급자가 있으면 그 사실을 앱 검수 자료에 적는다(열린 점 ⑧).
- **이메일로 계정을 자동 합치지 않는다**(`accountLinking` 끔, 추천). 이메일을 믿고 합치면 공급자 쪽 이메일 탈취로 남의 계정에 들어가는 길이 된다. 합치는 기준은 아래 CI 하나뿐이다.
- 앱(Expo)의 로그인 방식(브라우저 리다이렉트 vs 공급자 ID 토큰 교환)과 딥링크 스킴(`com.kdancex3`)은 **미검증**이다(R-10 — bearer 헤더 이름도 실측 전). 웹 흐름이 먼저고, 앱은 S8-2.1 의 공급자별 성공 기록(`login-kakao.md` · `login-naver.md` · `login-google.md`)에서 확인한다.
- 소셜 앱 등록·검수는 사람이 한다(8절 「소셜 로그인 3사 앱 등록·검수」, M3 부터). 구글은 배포 채널과 무관하게 OAuth 설정이 필요하다(`distribution-policy.md`).

### 8-2. 본인확인(S8-2.3)

`POST /api/identity/verifications` — 세션 필요. 요청 본문 없음.
```json
{ "identityVerificationId": "idv-0193…", "storeId": "store-…", "channelKey": "channel-key-…", "expiresAt": "2026-11-20T10:10:00Z" }
```
서버가 만든 `identityVerificationId` 를 이 세션의 사용자에게 묶어 `identity_verification_attempts`(칸 제안: `id` · `auth_user_id` · `requested_at` · `expires_at` · `consumed_at NULL`)에 남긴다. 앱은 이 값으로 포트원 본인인증 SDK 를 열고, 끝나면 **`POST /api/members` 의 `verificationToken` 에 같은 `identityVerificationId` 를 넣는다**(요청 모양은 `01-member-onboarding.md` §3 그대로). 열린 시도가 있으면 새로 만들지 않고 같은 값을 돌려준다.

**`IdentityVerificationPort.verify(token, now)` 실 구현**
1. 서비스(`POST /api/members`)가 포트를 부르기 전에 이 `identityVerificationId` 가 **현재 세션의 시도**이고 만료·소비되지 않았는지 확인한다(남의 인증 결과로 가입하는 것을 막는다 — 포트는 세션을 모른다).
2. 어댑터가 `GET /identity-verifications/{id}` 를 부른다(제한 10초). 상태가 인증 완료가 아니면 `{ ok: false, reason: 'invalid' }`, 인증 시각이 `now` 보다 10분 넘게 이전이면 `{ ok: false, reason: 'expired' }`.
3. 결과 중 **이름 · 성별 · 생년 · 연락처 · CI** 네 가지만 이름 있는 칸으로 옮기고 나머지는 버린다(화이트리스트). CI 는 받자마자 `HMAC(IDENTITY_CI_PEPPER, ci)` 로 바꿔 `ciHash` 만 쓰고 원본은 메모리에서도 곧 버리며 로그·예외 메시지·`rawResponse` 에 싣지 않는다. 주민등록번호는 응답에 없고, 있더라도 옮기지 않는다(S8-2.4).
4. 성별이 남·여로 안 오거나 생년·이름이 비면 `{ ok: false, reason: 'invalid' }` — 가입하지 않는다(AC-9). 연락처 칸 이름은 **미확인**(공식 예시는 CI·이름·성별·생년만 보여 준다) — 응답 필드 이름을 S8-2.3 에서 실측해 확정하고, 없으면 연락처는 가입 화면 입력으로 받는다.
5. 시간 초과·5xx는 `AdapterError{ timeout | unavailable }` → `POST /api/members` 가 503 `IDENTITY_UNAVAILABLE`. 인증이 안 끝났는데 부르면 422 `IDENTITY_NOT_VERIFIED`.
6. 한 인증은 한 번만 쓴다: 가입이 성공하면 시도 행에 `consumed_at` 을 쓰고 같은 id 의 두 번째 가입 요청은 `VALIDATION_FAILED`(토큰 무효, 01 §3).

### 8-3. 같은 CI 는 한 계정으로 묶는다(S8-2.2)

`01-member-onboarding.md` §3 은 같은 CI 가 다른 계정에 있으면 409 `IDENTITY_ALREADY_USED` 였다. 소셜 3사가 붙으면 한 사람이 카카오로 가입했다가 나중에 네이버로 들어오는 것이 정상 경로라 이 규칙이 다음처럼 바뀐다(`POST /api/members`, 한 트랜잭션).

| 같은 CI 의 기존 회원 | 결과 |
|---|---|
| 없음 | 가입(201). 기존 그대로 |
| 있고 같은 로그인 계정 | 200 같은 `Member`(기존 그대로) |
| 있고 다른 로그인 계정, 회원 상태 `active` | **연결**: 지금 세션의 공급자 계정을 기존 로그인 계정에 붙이고(빈 계정 정리), 기존 `Member` 를 200 으로 돌려주며 응답에 `"linked": true` 를 더한다. 이 세션은 기존 계정의 세션으로 바꿔 발급한다(웹 쿠키·앱 `set-auth-token`). 감사 `member.account_linked` |
| 있고 정지·탈퇴 상태 | 409 `IDENTITY_ALREADY_USED`(FR-257 — 정지된 사람의 재가입 거부. 탈퇴 후 재가입은 열린 점 ⑨) |

연결은 공급자 계정(`auth.account`) 행의 소유 계정을 옮기는 일이라 Better Auth 가 제공하는 계정 연결 경로로 할 수 있는지, 직접 옮겨야 하는지는 **미검증**이다(S8-2.2 의 첫 일). 방식과 상관없이 시험 기준은 같다: **3사로 들어와도 같은 CI 면 회원 1명**(수용 ①), 한 로그인 계정에 같은 공급자 계정이 두 번 붙지 않는다.

## 9. 공유하는 데이터 칸(`03_data-model.md` 에는 쓰지 않음 — 담당 절과 조율)

| 대상 | 추가 칸·값 | 쓰는 곳 |
|---|---|---|
| `payments` | `gateway_cancel_pending boolean = false` · 가상계좌 칸이 웹훅 뒤에 채워진다는 점(이미 `NULL` 허용) | §2-3 · §3-1 |
| `payment_webhook_events` | `result` 에 `received` 추가 · `attempts int = 1` · `last_seen_at timestamptz` | §4-3 |
| `academies` | `pg_seller_status text = 'not_registered'`(`not_registered`·`pending`·`registered`·`failed`) · `pg_seller_id text NULL` | §6 |
| `identity_verification_attempts`(새) | `id`(우리가 만든 `identityVerificationId`) · `auth_user_id` · `requested_at` · `expires_at` · `consumed_at NULL` | §8-2 |
| `audit_logs.action` | `member.account_linked` · `sub_merchant.registered`·`.failed` · `payout.requested` | §6 · §7 · §8-3 |

## 10. 시험 기준(Task verify 와 연결)

- 실 PG·실 본인확인은 가짜와 **같은 계약 테스트**를 통과한다. 테스트 모드 키가 없으면 실패다(S8-1.3 · S8-2.3).
- 트랜잭션 안에서 어댑터를 부르면 예외(S8-1.2). 기존 테스트 전부 통과.
- 웹훅: 맞음 · 틀림 · 재전송 · SDK 교차(S8-1.4). 소스에 PG 키 0건(S8-1.7).
- 환불 시간 초과 때 `pending` 유지·이중 환불 0건, 카드 금액 불일치 때 PG 전액 취소 호출(§2-3 · §3-3 — 가짜 PG 에 지연·오류 조작을 더해 시험).
- 계좌 결제분 환불에서 PG 환불 호출 0회(§5).
- 본인확인 결과의 저장 칸이 이름·성별·생년(+가입 연락처 칸)이고 주민등록번호가 스키마·로그에 없다(S8-2.4 — 열린 점 ⑩).

## 11. 열린 점

| # | 무엇 | 추천 · 조율 |
|---|---|---|
| ① | 실 PG 는 서버가 결제를 만들지 못한다(§3-1). `06-ports.md` 의 `createPayment` 가 가상계좌를 돌려준다는 모양과 어긋난다 | 포트는 그대로 두고 `checkout` 을 주문 응답에서 조립한다(이 문서). 포트에 `clientCheckout` 칸을 더하는 것이 더 깔끔하다는 의견이 나오면 `06-ports.md` 개정은 사용자 확인 뒤에 한다 |
| ② | 데이터 칸 제안(§9) | M4(웹훅·결제)·S1-1(학원) 데이터 담당과 조율해 각 절에 반영 |
| ③ | 서명 규격(`v1,` 접두·비밀값 해석)·웹훅 재전송 간격 | S8-1.4 에서 SDK 소스로 확정. 확정 전 R-11 은 부분 확인 |
| ④ | 간편결제(`EASY_PAY`)의 환불 수단과 「간편 계좌이체」의 포트원 값 | 간편결제는 카드처럼 PG 취소임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인). 값은 S8-1.1(SP-2)·S8-1.5 실측 |
| ⑤ | `GatewayPayment` 에 부분 취소된 금액 칸이 없다(대사 S5-4 가 필요할 수 있다) | 대사는 `refunds` 원장과 PG 거래 조회로 한다. 칸이 필요해지면 그때 포트에 더한다(사용자 확인) |
| ⑥ | 영수증 경로 이름 | M4 내역 화면 계약과 겹치면 그쪽을 따른다 |
| ⑦ | PG 지급대행·하위 판매자 지원 여부(SP-2)·지급 결과 통지 방식 | S8-1.1 결과로 §6·§7 의 시그니처를 S5-3·S5-4 계약에 맞춰 정한다. 안 되면 R12 대로 베타 수동 지급 유지 |
| ⑧ | 소셜 공급자별 필수 동의 항목·앱 검수 요건 | 사람이 공급자 콘솔에서 확인(8절). 이 문서는 식별자만 쓰는 최소 범위를 전제한다 |
| ⑨ | 탈퇴한 회원이 같은 CI 로 다시 가입할 때(FR-010 재가입 혜택 차단과의 관계) | S3-1·S7-3 담당과 조율. 이 문서는 정지만 거부로 둔다 |
| ⑩ | 본인확인 결과 중 연락처: 포트는 `phone` 을 돌려주고 `members.phone` 에 저장하는데, S8-2.4 verify 는 저장 칸을 이름·성별·생년 셋으로 적었다 | 연락처는 FR-002 의 가입 정보 칸이라 별개로 본다. **S8-2.4 에서 이 판정으로 확정**: 검사 테스트 `admin-web/tests/db/identity-stored-fields.db.test.ts` 가 members 의 사람 정보 칸을 이름·성별·생년 + 가입 연락처 + CI 해시 + 닉네임으로 고정한다(추천안·사후 확인 2026-11-24) |
| ⑪ | 테스트 모드 웹훅이 노트북에 닿는 길(SP-11) | 닿지 않는 동안은 `getPayment` 조회 보정(O-14)으로 한 바퀴를 돌릴 수 있지만 웹훅 검증(S8-1.4)은 단위 시험까지만 된다 |
