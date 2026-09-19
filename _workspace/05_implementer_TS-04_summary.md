# Phase 5 구현 결과 — TS-04 어댑터 3종 (PG / 알림 / 슬롯 락)

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-04)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-04·§4.1·§4.2, `_workspace/03_impl-planner_plan.md` D4, `docs/payment-method-policy.md`
- 상태: **완료.** 완료 기준 4개 전부 충족. `uv run pytest` 84 passed / 0 failed / 0 error / 0 skipped.

---

## 1. 변경한 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/app/adapters/__init__.py` | 신규 | 3개 모듈의 공개 심볼 re-export + 계층 규칙 주석(서비스는 Protocol만 import, 구상체는 `deps.py`가 주입) |
| `backend/app/adapters/payment_gateway.py` | 신규 | `RefundStatus`(§4.2 소유) · `PaymentMethod` · `RefundAccount` · `RefundRequest` · `RefundResult` · `PaymentGateway` Protocol(단일 메서드) · `parse_portone_cancel_response()` · `FakePaymentGateway` · `UnsupportedPaymentMethodError` |
| `backend/app/adapters/notification.py` | 신규 | `NotificationAudience` · `NotificationEvent` · `SentNotification` · `NotificationSender` Protocol(회원/학원관리자 2메서드) · `FakeNotificationSender` |
| `backend/app/adapters/slot_lock.py` | 신규 | `SLOT_LOCK_KEY_NAMESPACE="kdance:slot"` · `slot_lock_key()` · `SlotLock` Protocol · `RedisSlotLock`(지연 연결 + 전면 예외 흡수) · `NullSlotLock` |
| `backend/tests/test_adapters.py` | 신규 **(계획에 없던 파일 — §4 참조)** | 33개 단위 테스트. DB·Redis 불필요 |

**다른 태스크 파일은 건드리지 않았다.** `git status` 확인 결과 이 태스크가 만든 것은 `backend/app/adapters/`와 `backend/tests/test_adapters.py`뿐이고, `models/`·`services/`·`config.py`·`pyproject.toml` 등은 TS-01~03이 소유한 상태 그대로다.

---

## 2. 포트원 스키마 반영 — 오케스트레이터 지시사항 처리 결과

### 2.1 무엇이 충돌했나

Phase 3 D4는 "메서드를 카드/가상계좌로 쪼개지 않는 **이유**"를 **"PG사가 아직 미선정"**이라고 적었다. 그런데 `docs/payment-method-policy.md`(방식 A/B 라우팅)는 **포트원 확정**을 선언하고 "가짜 어댑터를 쓰더라도 포트원 응답 스키마를 흉내 낼 것"을 요구한다.

### 2.2 어떻게 조화시켰나 — 결론 유지, 근거 교체

**단일 Protocol 구조는 유지했다. 다만 그 근거를 "미선정이라 추측을 피한다"에서 "포트원 취소 API 자체가 하나이고 결제수단에 따라 `refundAccount` 유무만 갈린다"로 바꿨다.**

즉 결론은 같지만 **더 강한 근거로 바뀌었다.** 원래 논리는 "모르니까 안 쪼갠다"(정보 부족에 의존)였고, 지금은 "실제 API가 안 쪼개져 있으니 안 쪼갠다"(사실에 의존)다. 포트원 V2는 `POST /payments/{paymentId}/cancel` 하나이고, 가상계좌면 `refundAccount`를 실어 보낸다 — Protocol을 둘로 쪼개면 오히려 실제 API 모양과 어긋난 채 서비스가 분기를 떠안게 된다. 오케스트레이터가 지목한 "Phase 3 D4의 결론은 여전히 유효"와 일치한다.

`payment_gateway.py` 모듈 독스트링에서 "PG사 미선정" 서술을 **쓰지 않았다.** 대신 포트원 확정 사실과 필드 매핑표를 명시했다.

### 2.3 실제 확인한 포트원 V2 스키마 (context7 조회 — 기억에 의존하지 않음)

`mcp__context7__query-docs` / `/portone-io/developers.portone.io` (공식 문서 리포 + `src/schema/v2.openapi.yml`)로 2회 조회해 확인한 사실:

**요청** `POST /payments/{paymentId}/cancel`
- `paymentId` (필수), `reason` (필수, 문자열), `amount` (부분취소용 선택), `currentCancellableAmount` (검증용 잔액)
- `refundAccount: { bank, number, holderName, holderPhoneNumber? }` — `holderPhoneNumber`는 **스마트로 가상계좌 취소 시 필수**

**응답** `CancelPaymentResponse = { cancellation: PaymentCancellation }`
- `PaymentCancellation`은 `status`로 discriminate 되는 oneOf: `SucceededPaymentCancellation` / `RequestedPaymentCancellation` / `FailedPaymentCancellation`
- 필수 필드: `status`, `id`, `totalAmount`, `taxFreeAmount`, `vatAmount`, `reason`, `requestedAt`
- 선택 필드: `pgCancellationId`, `cancelledAt`, `trigger`
- 공식 SDK에 `isUnrecognizedPaymentCancellation()`이 존재 → **포트원이 나중에 상태 변종을 추가할 수 있다**는 것이 공식 전제다

### 2.4 코드에 반영한 매핑

| 포트원 V2 | 이 모듈 |
|---|---|
| `paymentId` | `RefundRequest.payment_key` |
| `reason` (필수) | `RefundRequest.reason` (기본값 `"회원 요청 취소"` — 이번 사유는 `member_request` 하나뿐) |
| `amount` | `RefundRequest.amount` |
| `refundAccount.bank` / `.number` / `.holderName` / `.holderPhoneNumber` | `RefundAccount.bank_code` / `.account_number` / `.holder_name` / `.holder_phone_number` |
| `cancellation.status` `SUCCEEDED` | `RefundStatus.succeeded` |
| `cancellation.status` **`REQUESTED`** | **`RefundStatus.pending`** |
| `cancellation.status` `FAILED` | `RefundStatus.failed` |
| `cancellation.id` | `RefundResult.gateway_refund_id` |
| `cancellation.pgCancellationId` | `RefundResult.pg_cancellation_id` |
| `cancellation.totalAmount` | `RefundResult.total_amount` |
| `cancellation.requestedAt` / `.cancelledAt` | `RefundResult.requested_at` / `.cancelled_at` |
| (전체 원문) | `RefundResult.raw_response` — 감사 로그에 PG 원문을 남기기 위함 |

**구조적으로 가장 중요한 결정 — 파서를 프로덕션 코드로 분리했다.**

`parse_portone_cancel_response(payload) -> RefundResult`는 실 연동 어댑터와 `FakePaymentGateway`가 **같이 쓴다.** Fake는 포트원 모양의 응답 dict를 만들어 이 파서에 통과시킬 뿐이다. 결과:

- Fake 기반 테스트가 **`REQUESTED` → `pending` 매핑을 실제로 검증**한다. 이게 틀리기 가장 쉬운 지점이고, Phase 3 D4가 "pending을 1급 상태로" 요구한 이유 그 자체다.
- 실 연동 시 교체되는 것은 **HTTP 호출 한 겹뿐**이다. 상태 매핑·필드 해석·타임스탬프 파싱은 이미 테스트로 덮인 채 그대로 살아남는다. D4의 "PG사 확정 후 어댑터 1파일 교체가 목표"가 "1파일 중 함수 1개 교체"로 더 좁아졌다.
- `SUCCEEDED`/`REQUESTED`/`FAILED` 외 상태는 `failed` + `failure_code="UNRECOGNIZED_CANCELLATION_STATUS"` + 원문 상태를 메시지에 남긴다 (`isUnrecognizedPaymentCancellation` 대응). **성공으로 넘겨짚지 않는다.**

### 2.5 도메인 값 집합은 포트원 표기를 따르지 않았다 (의도적)

`RefundStatus`는 `succeeded`/`pending`/`failed` **소문자 도메인 값**을 유지했고 포트원의 `SUCCEEDED`/`REQUESTED`/`FAILED`를 그대로 쓰지 **않았다.**

이유: 공유 계약 §4.1이 `refunds.status` CHECK 제약 및 부분 유니크 인덱스(`WHERE status <> 'failed'`)와 **문자 단위 일치**를 요구한다. 여긴 협상 불가 고정값이다. PG 표기를 DB 컬럼까지 끌고 들어가면 PG를 갈아끼울 때 마이그레이션이 필요해진다. 번역 지점을 파서 한 곳(`PORTONE_CANCELLATION_STATUS_MAP`)으로 고정하는 편이 맞다.

### 2.6 이번 범위와 별개 트랙임을 코드에 남긴 부분

방식 A/B 라우팅(딥링크 vs 포트원 PG)은 이번 환불 슬라이스와 별도 트랙이므로 **라우팅 분기를 어댑터에 넣지 않았다.** 이 어댑터는 "방식 B(포트원) 가상계좌 결제건의 환불" 하나만 다룬다 — 정책 문서 §"적용 범위"와 동일하다. 방식 A(딥링크 + 오픈뱅킹 폴링) 결제건의 환불 경로는 존재하지 않으며, 그런 결제건이 들어오면 `method`가 `virtual_account`가 아니므로 `UnsupportedPaymentMethodError`로 **시끄럽게** 걸린다.

---

## 3. 완료 기준 검증

| 완료 기준 | 결과 | 근거 |
|---|---|---|
| Redis 미기동 상태에서 `slot_lock` import + 해제 호출이 예외 없이 반환 | ✅ | 실환경 확인 — 6380 포트 미개방(`ss -ltn` 히트 0) 상태에서 `RedisSlotLock().release("sched-1")` → `False` 반환, 예외 없음. 경고 로그만 stderr로 나감. 테스트: `test_redis_slot_lock_release_returns_false_when_redis_is_down` |
| `FakePaymentGateway`로 succeeded / pending / failed 3가지 생성 | ✅ | `test_fake_gateway_produces_succeeded` / `..._pending_via_pending_on` / `..._pending_via_force_pending` / `..._failed_via_fail_on` |
| `method=card`가 `UnsupportedPaymentMethodError`를 던진다 | ✅ | `test_card_method_raises_unsupported_payment_method_error` (+ `kakaopay`/빈문자열/대문자 오타 파라미터라이즈) |
| `uv run pytest` 전체 초록 | ✅ | **84 passed, 0 failed, 0 error, 0 skipped** (TS-01 `test_health` + TS-03 `test_refund_policy` + TS-04 `test_adapters` 합산) |

추가로 §4.2 계약 준수를 테스트로 못박았다: `test_refund_status_values_match_db_check_constraint`가 `{"succeeded","pending","failed"}` 정확 일치를 단정한다. TS-02의 CHECK 제약이 어긋나면 TS-12에서 발견되기 전에 이 테스트가 먼저 잡지는 못하지만(모델을 import하지 않으므로), 최소한 어댑터 쪽 값이 바뀌는 사고는 막는다.

---

## 4. 구현 중 발견한 이슈 / 계획과의 불일치

### 4.1 [계획 공백] 테스트 파일 소유자가 지정되지 않았다 — `tests/test_adapters.py` 신설

Phase 4 §3 "파일 충돌 검증"은 `backend/tests/`를 TS-03(`test_refund_policy.py`)과 TS-07(`conftest.py` + 나머지)이 나눠 갖는다고 적었다. 그런데 **TS-04의 완료 기준 3개가 단위 테스트 통과를 요구하는데 그 테스트를 담을 파일이 어느 태스크에도 배정돼 있지 않다.**

`tests/test_adapters.py`를 신설했다. TS-03·TS-07 어느 쪽 소유 파일과도 겹치지 않고, TS-07 소유인 `conftest.py`는 **만들지 않았다**(어댑터 테스트는 픽스처가 필요 없다). 충돌 없음.

→ **Phase 7/8 확인 요청:** TS-07 구현자가 `conftest.py`에 DB 미가용 skip 훅을 넣을 때 `test_adapters.py`가 영향받지 않아야 한다. 이 파일의 테스트는 `requires_db` 마커가 없으므로 정상이라면 무관하다.

### 4.2 [D4 확장] `RefundRequest`에 `reason` 필드를 추가했다

Phase 3 D4의 필드 목록에는 없다. 포트원 V2가 `reason`을 **필수**로 요구하므로 넣지 않으면 실 연동 시 시그니처가 바뀐다. 기본값(`DEFAULT_CANCEL_REASON`)을 줘서 D4를 문자 그대로 따르는 호출도 깨지지 않게 했다. **TS-05는 이 필드를 몰라도 된다.**

### 4.3 [D4 확장] `RefundAccount`에 `holder_phone_number`를 추가했다

포트원 기준 선택값이지만 **스마트로 가상계좌 취소에는 필수**다. `None` 기본값이라 TS-06의 `CancelRequest` 스키마(`bank_code`/`account_number`/`holder_name` 3필드)와 그대로 호환된다.

→ **TS-06 구현자 참고:** 스키마에 `holder_phone_number`를 **넣지 않아도 지금은 동작한다.** 다만 실제 PG 계약사가 스마트로 계열이면 나중에 필수가 된다. 이번 슬라이스에서는 추가하지 않는 쪽을 권한다(범위 준수).

### 4.4 [설계 판단] 환불계좌 누락은 예외가 아니라 `failed` 결과로 돌려준다

`method == virtual_account`인데 `refund_account is None`인 경우, 예외를 던지지 않고 `RefundStatus.failed` + `failure_code="REFUND_ACCOUNT_REQUIRED"`를 반환한다.

근거: 정상 경로에서는 스키마 계층이 먼저 422로 막는다(Phase 3 D4 #2 — 검증은 어댑터가 아니라 스키마). 여기까지 왔다는 건 스키마를 우회한 내부 호출이라는 뜻인데, 이때 예외를 던지면 서비스가 감사 로그에 사유를 남기지 못한다. `failed` 결과로 주면 사유가 `refunds.failure_code`와 `refund_events`에 그대로 남는다 — 조용히 성공시키는 것도 아니고 추적도 된다.

**카드(`UnsupportedPaymentMethodError`)와 다르게 처리한 이유:** 카드는 "이 코드 경로가 아예 존재하지 않아야 한다"는 **프로그래밍 오류**(범위 밖 결제수단이 취소 경로에 들어옴)이고, 환불계좌 누락은 "PG가 거절할 요청"이라는 **런타임 실패**다. 전자는 로그로 덮이면 안 되고, 후자는 기록되어야 한다.

### 4.5 [설계 판단] `FakePaymentGateway`는 실패 건을 원장에 확정하지 않는다

`ledger`는 `idempotency_key` → 결과 매핑이고 재시도를 멱등하게 만든다. 다만 **`failed`는 저장하지 않는다.** 도메인상 실패 건 재시도가 허용되고(`refunds` 부분 유니크 인덱스가 `WHERE status <> 'failed'`), 저장하면 `fail_on`을 풀어도 계속 실패하는 Fake가 되어 "PG 실패 후 재시도 성공" 시나리오를 TS-07이 쓸 수 없다.

### 4.6 [주의] `slot_lock.release()`가 `Exception`을 통째로 삼킨다

의도적이고, 주석에 근거를 남겼다. redis-py는 연결 계열만 해도 `ConnectionError`/`TimeoutError`/`OSError`/`ValueError`를 상황에 따라 내고, 하나라도 새 나가면 **이미 돈이 움직인 환불 트랜잭션이 캐시 장애로 롤백된다.** 대신 `exc_info=True`로 스택 트레이스를 WARNING 로그에 남겨 조용히 묻히지 않게 했다.

→ **Phase 8 코드 리뷰 대상으로 미리 올린다.** 광범위 예외 포착은 보통 지적 대상이지만 여기서는 태스크 명세가 명시적으로 요구한 동작이다(`04_..._tasks.md:189`).

### 4.7 [미해결 — 이번 범위 밖] 슬롯 락 `acquire`가 없다

`SlotLock` Protocol에 `release`만 있다. 락을 거는 쪽은 예약/결제 생성 경로인데 그 경로 자체가 이번 슬라이스에 없다(살아있는 플래그 **F6** — 결제 생성 경로 없음). 지금 `acquire` 시그니처를 추측해서 넣으면 쓰이지도 않는 API가 고정된다. 모듈 독스트링에 사유를 남겼다.

**따라오는 함의:** 이번 슬라이스에서 `RedisSlotLock.release()`가 지우는 키를 **실제로 만드는 코드가 없다.** 즉 통합 테스트(TS-12)에서도 "키가 지워졌다"를 실측할 수 없고, 기껏해야 "해제가 호출됐다"(`NullSlotLock.released`)까지다. Phase 3 §7도 "실제 키 삭제 확인 불가"로 같은 판단을 적어뒀다.

→ **Phase 9는 "슬롯 락 해제 실동작"을 통과로 기록하면 안 된다.** 수용 기준 "슬롯 정원 복구"의 실체는 DB의 `class_schedules.reserved_count -= 1`(TS-05 소관)이고, Redis 락 해제는 부가 정리 작업이다. 둘을 같은 항목으로 묶어 검증하지 말 것.

### 4.8 [F4 재확인] 알림은 Fake까지만이다

`FakeNotificationSender`는 기록만 남기고 아무것도 보내지 않는다. 실제 Expo Push 발송(FR-90)과 관리자 웹 알림 채널(폴링/WS/SSE — 정책 문서상 **미정**)은 이번 범위 밖이다. 수용 기준 "회원·학원 관리자 알림"은 **Fake 호출 기록까지만** 검증된다 — Phase 9는 이걸 "알림 발송 동작 확인"으로 승격해 기록하면 안 된다.

`NotificationEvent`에 `REFUND_PENDING`을 `REFUND_FAILED`와 **따로** 뒀다. `pending`을 실패 알림으로 뭉뚱그리면 회원이 돈을 못 받는다고 오해한다.

### 4.9 [계약 확인] Protocol 메서드를 2개로 나눈 것에 대해

`NotificationSender`는 `notify_member` / `notify_academy_admin` 두 메서드다. 한 메서드에 수신자 태그를 넘기는 형태로 합치지 않은 이유: 정책 문서상 **전달 수단이 실제로 다르다**(회원 = Expo Push, 관리자 = 관리자 웹 채널). 합치면 서비스 호출부에서 "2방향 다 보냈는지"가 눈으로 확인되지 않는다.

PG(`PaymentGateway`)는 반대로 단일 메서드다 — 포트원 API가 실제로 하나이기 때문. **같은 원칙("실제 경계 모양을 따른다")의 서로 다른 귀결**이지 일관성 위반이 아니다.

---

## 5. 다음 태스크(TS-05)를 위한 인터페이스 요약

```python
from app.adapters import (
    PaymentGateway, RefundRequest, RefundAccount, RefundResult, RefundStatus,
    UnsupportedPaymentMethodError,
    NotificationSender, NotificationEvent,
    SlotLock,
)

result: RefundResult = gateway.refund(RefundRequest(
    payment_key=payment.gateway_payment_key,
    method=payment.method,                  # DB의 평문 str 그대로 넘겨도 된다
    amount=calculation.refund_amount,
    idempotency_key=idempotency_key,
    refund_account=RefundAccount(bank_code=..., account_number=..., holder_name=...),
))
# result.status ∈ {succeeded, pending, failed} — refunds.status에 그대로 넣는다
# result.gateway_refund_id / .pg_cancellation_id / .failure_code / .failure_message
# result.raw_response — refund_events 감사 로그에 PG 원문으로 남길 것

sender.notify_member(member_id, NotificationEvent.RESERVATION_CANCELLED, {...})
sender.notify_academy_admin(academy_id, NotificationEvent.RESERVATION_CANCELLED, {...})

slot_lock.release(schedule_id)   # 예외 없음. False 반환은 무시하고 진행할 것
```

**TS-05가 반드시 지킬 것**

1. `gateway.refund()`는 `UnsupportedPaymentMethodError`를 던질 수 있다. 카드 결제건 취소 요청은 이 예외를 잡아 **HTTP 400/422**로 변환하라 — 500으로 새 나가면 안 된다.
2. `result.status is RefundStatus.PENDING`은 **정상 경로**다. 실패로 처리하지 말 것.
3. `slot_lock.release()`의 반환값을 검사해 분기하지 말 것. `False`여도 트랜잭션을 계속 진행한다.
4. `deps.py`는 **Protocol 타입으로** 주입하라. `cancellation.py`에 `FakePaymentGateway`가 등장하면 TS-05 완료 기준 위반이다(`grep` 히트 0이어야 함).
