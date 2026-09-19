# Phase 5 — TS-05 구현 산출물: 취소 오케스트레이션 서비스 + 의존성 주입

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-05)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-05, `_workspace/03_impl-planner_plan.md` §2.5·D5
- 선행: TS-01~TS-04 완료물 위에 쌓음 (재작성 없음)
- 상태: **완료.** `cd backend && uv run pytest` → **120 passed** (기존 84 유지 + 신규 36)

---

## 1. 변경 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/app/services/cancellation.py` | 신규 | 취소 오케스트레이션 전체. 어댑터 3종을 **Protocol 타입으로만** 받는다 |
| `backend/app/deps.py` | 신규 | `current_user_id`(임시 인증, F7) · `get_payment_gateway` · `get_notification_sender` · `get_slot_lock` |
| `backend/tests/test_cancellation_service.py` | 신규 | DB 없이 검증 가능한 불변식 36건 |

**다른 태스크 소유 파일은 하나도 건드리지 않았다.** `conftest.py`(TS-07) · `test_refund_policy.py`(TS-03) · `main.py`(TS-06) 전부 무수정.

---

## 2. 구현한 순서 (요구된 순서 그대로)

```
1  SELECT ... FOR UPDATE  reservations 행 잠금
2  소유권 검증                           → 타인이면 403
3  멱등 재생 검사 (기존 refund 조회)      → 있으면 200으로 기존 결과 반환
4  상태 전이 검증                         → 이미 취소 409 / 이미 시작·종료 409
5  결제 원거래 확인 + calculate_refund()   (TS-03)
6  Refund INSERT (SAVEPOINT 안에서 flush) → IntegrityError면 기존 행으로 수렴
7  PaymentGateway.refund()                (TS-04)
8  성공·대기 → 예약 cancelled + reserved_count -= 1 + order refunded
   실패     → refunds.status=failed + 사유 기록, 예약·정원 **불변**
9  refund_events INSERT (append-only)
10 session.commit()
11 [커밋 이후] 슬롯 락 해제 + 회원/학원 관리자 2방향 알림
```

**3번을 4번보다 앞에 둔 것이 설계상 핵심이다.** 순서가 반대면 중복 요청이
"이미 취소됨 409"로 튕겨 나가 "기존 결과를 200으로 반환한다"는 수용 기준이 깨진다.
앞선 요청이 예약을 이미 `cancelled`로 바꿔 놓았기 때문이다.

---

## 3. 오케스트레이터가 지시한 경고 3건 — 반영 위치

### 3-1. `UnsupportedPaymentMethodError` → 500이 아니라 422

`cancel_reservation()` 7단계에서 `except UnsupportedPaymentMethodError`로 잡는다.
잡은 뒤 그냥 다시 던지지 않고:

1. `Refund` 행을 `failed` + `failure_code="UNSUPPORTED_PAYMENT_METHOD"`로 확정
2. `refund_events`에 `gateway_unsupported_method` 감사 로그 INSERT
3. **commit** (사유가 DB에 남아야 한다)
4. 실패 알림 2방향 발송
5. `UnsupportedRefundMethodError`(`status_code = 422`)로 바꿔 던진다

`failed`는 부분 유니크 인덱스(`WHERE status <> 'failed'`) 밖이므로, 카드 환불이
열렸을 때 **같은 예약을 그대로 재시도**할 수 있다. 잡아서 조용히 넘기면 회원은
"취소됐다"고 믿고 돈은 안 돌아온다 — 그래서 422로 시끄럽게 실패시킨다.

### 3-2. `RefundStatus.pending`은 정상 경로

- `ACTIVE_REFUND_STATUSES = {"succeeded", "pending"}` — 멱등 재생과 부분 유니크
  인덱스가 덮는 "살아 있는 환불"에 pending이 포함된다
- pending에서도 **예약은 cancelled로 확정되고 `reserved_count`가 복구된다.**
  송금 완료를 기다리는 동안 자리를 묶어둘 이유가 없다
- 알림은 `REFUND_PENDING`("환불 처리 중")이지 `REFUND_FAILED`가 아니다
- `refunded_amount`는 pending일 때 **0**이다 — 아직 회원 계좌로 송금되지 않았다.
  여기 금액을 채우면 "이미 받은 돈"으로 집계된다

### 3-3. `SlotLock.release()`의 `bool`로 분기하지 않음

`_release_slot_lock()`이 반환값을 **의도적으로 버린다.** 로그에만 쓴다.

- 호출 지점이 `session.commit()` **이후**다 — 되돌릴 트랜잭션이 남아 있지 않다
- 구현체가 Protocol 약속을 어기고 예외를 던져도 `try/except Exception`으로 삼킨다
- 테스트 `test_slot_lock_release_never_propagates`가 정상/실패/예외 3종 락으로 단정
- 테스트 `test_service_does_not_branch_on_slot_lock_result`가 **소스 수준으로**
  `if slot_lock.release` 패턴 부재와 커밋→해제 순서를 단정한다

같은 이유로 알림 발송 실패도 삼킨다(한쪽이 터져도 다른 쪽은 시도).

---

## 4. 완료 기준 대조

| 기준 | 결과 |
|---|---|
| Protocol 타입으로 주입 / `grep -n "FakePaymentGateway" .../cancellation.py` 히트 0 | **0 hits** (`FakeNotificationSender`·`RedisSlotLock`도 0 — 테스트가 단정) |
| `deps.py` 임시 인증에 F7 주석 실재 | 3곳 (섹션 헤더 / `.. warning::` 블록 / 401 detail). "위조 가능"·"프로덕션 배포 전 반드시 교체" 문구 포함 |
| 슬롯 락 해제 실패가 환불을 롤백시키지 않는 경로가 코드상 확인 가능 | `_release_slot_lock()` + 커밋 이후 호출. 테스트 2건이 단정 |
| `uv run pytest` 전체 초록 | **120 passed** (기존 84 + 신규 36), 실패·에러·skip 0 |
| 멱등 키: 헤더 없으면 `sha256("cancel:" + reservation_id)` | `build_idempotency_key()`. UUID/str 어느 쪽으로 넘겨도 같은 키 |
| IntegrityError → 409가 아니라 200으로 기존 결과 | SAVEPOINT(`begin_nested`) 안에서 flush → 유니크 위반 시 기존 행 조회 후 `replayed=True`로 반환 |
| 쿠폰 복원 훅 위치 주석 고정 | `# TODO(coupon): Q4 확정 …` — 예약 cancelled 확정 + 정원 복구 **직후, 같은 트랜잭션 안**에 위치 |

SQL은 DB 없이 Postgres dialect로 컴파일 검증했다 — `FOR UPDATE` 실제 생성 확인,
`reserved_count` 감소 UPDATE·JSONB 조회·부분 인덱스 대상 조회 전부 컴파일 성공.

---

## 5. 계획에 없던 결정 (리뷰 대상)

### 5-1. `preview_cancellation()`을 같은 파일에 추가했다 — 태스크 문구 밖

TS-06이 `GET /reservations/{id}/cancellation-preview`를 만드는데, 계획 §3에 그
엔드포인트가 쓸 서비스 함수가 없다. 안 넣으면 TS-06이 라우터에 DB 조회를
직접 쓰거나 새 서비스 파일을 만들게 된다. **읽기 전용**이며 아무것도 쓰지 않는다.

취소 불가 사유를 예외가 아니라 `cancellable=False` + `reason_code` **값으로**
돌려준다 — 화면이 금액과 사유를 같이 받아야 버튼을 비활성화할 수 있다.
`_preview_block_reason()`은 `cancel_reservation()`의 판정과 **같은 순서**이며
파라미터라이즈 테스트 7건이 이 일치를 못박는다. 어긋나면 화면은 취소 가능하다고
했는데 API가 거부한다.

### 5-2. PG 환불 실패 시 **예약을 취소하지 않는다**

계획이 명시하지 않은 지점이라 판단해서 정했다. 환불이 실패했는데 좌석까지
없애면 회원은 **자리도 돈도 잃는다.** `failed`가 부분 유니크 인덱스에서 제외된
설계(재시도 허용)도 예약이 살아 있어야 의미가 있다. 따라서:

- `Refund`는 `failed` + 사유 기록 후 **커밋**된다 (수용 기준: 실패 사유 기록)
- `reservations.status` · `class_schedules.reserved_count` · `orders.status` 불변
- 서비스는 **예외를 던지지 않고** `CancellationOutcome(status=failed)`를 반환한다 —
  실패 사유를 남긴 커밋이 예외로 날아가면 안 된다

### 5-3. 예외에 `status_code`를 값으로 실었다

`CancellationError.status_code`(int). FastAPI를 서비스 계층에 import하지 않으려고
`fastapi.status` 대신 정수를 쓴다. 라우터가 예외 타입별 `if/elif`를 쓰지 않고
`exc.status_code` 하나로 처리할 수 있다.

| 예외 | 코드 |
|---|---|
| `ReservationNotFoundError` | 404 |
| `ReservationOwnershipError` | **403** (404로 감추지 않음 — 수용 기준 우선) |
| `ReservationAlreadyCancelledError` / `ReservationNotCancellableError` / `ClassAlreadyStartedError` / `PaidPaymentNotFoundError` | 409 |
| `UnsupportedRefundMethodError` | **422** |

### 5-4. `Refund` 초기 상태를 `pending`으로 INSERT

`refunds.status` 값 집합에 "요청됨"이 없다(공유 계약 §4.1). `pending`으로 넣어야
부분 유니크 인덱스가 **PG 호출 전부터** 작동해 동시 요청을 막는다.

### 5-5. `reserved_count` 감소를 읽고-고쳐-쓰지 않는다

`UPDATE ... SET reserved_count = reserved_count - 1 WHERE id = :id AND reserved_count > 0`
한 문장. `> 0` 가드로 CHECK 제약(`reserved_count >= 0`) 위반 대신 0행 갱신으로
끝나게 했다 — 이미 0인 슬롯을 취소해도 트랜잭션이 죽지 않는다.

---

## 6. 발견한 불일치 / 미해결 사항

### 6-1. `class_schedules`에 종료 시각 컬럼이 없다 — "이미 종료" 판정 불가

수용 기준은 "이미 시작**/종료**된 건 거부"인데 모델에 `starts_at`만 있고
`ends_at`/`duration`이 없다. 시작 시각이 지났으면 진행 중이든 끝났든 취소 대상이
아니므로 `starts_at <= now` **한 판정으로 묶었다.** 실용적으로는 동등하지만,
"종료"를 별도로 판정해야 하는 요구가 생기면 마이그레이션 1건이 필요하다.
**계획·모델 어느 쪽에도 종료 시각이 없으므로 임의로 컬럼을 추가하지 않았다.**

### 6-2. PG 어댑터가 예상 밖 예외를 던지면 감사 기록이 남지 않는다

`PaymentGateway` Protocol은 "`UnsupportedPaymentMethodError` 외 예외를 던지지 않는
것을 지향"한다(TS-04 docstring). 실 연동체가 이 약속을 어기고 타임아웃 예외를
던지면, 트랜잭션이 커밋되지 않아 `pending` 환불 행도 감사 로그도 사라진다.
**요청이 PG에 실제로 도달한 뒤의 타임아웃이면 환불이 집행됐는데 기록이 없는 상태가
된다.** 이번 슬라이스는 Fake만 쓰므로 발생하지 않는다. 실 연동 어댑터를 붙일 때
"모든 네트워크 예외를 `RefundStatus.failed` 결과로 변환"을 반드시 지켜야 한다 —
**Phase 8 리뷰에서 이 제약을 어댑터 구현 계약으로 못박을 것을 권고한다.**

### 6-3. 학원 행이 없으면 비율표를 빈 표로 취급한다 (조용한 기본값)

`_academy_tiers()`가 `academies` 행 부재·비리스트 값을 빈 리스트로 떨어뜨린다.
결과적으로 24시간 이내 취소는 0% 환불이 된다. FK가 있어 정상 경로에선 도달
불가하지만, **금액이 걸린 조용한 기본값**이라 남겨 둔다. 예외로 바꾸는 편이
안전한지 Phase 8에서 판단 바란다.

### 6-4. `Idempotency-Key` 헤더를 클라이언트가 매번 새로 보내면 결정적 키가 우회된다

헤더가 오면 그 값을 신뢰한다(200자 절단). 이때 결정적 키 방어는 무력해지지만,
부분 유니크 인덱스(`UNIQUE (reservation_id) WHERE status <> 'failed'`)가 남아
있어 **이중 환불은 여전히 불가능**하다. 방어가 2겹인 이유다. 이 경로는 DB가 있어야
실증되므로 **TS-12 통합 테스트에 "매번 다른 Idempotency-Key로 동시 2건" 케이스를
추가할 것을 권고한다** — 현재 TS-07 테스트 목록에는 없다.

### 6-5. 실행 경로 자체는 아직 미검증 (Docker 차단 — F1)

신규 테스트 36건은 전부 **DB 없이 검증 가능한 불변식**만 다룬다. `FOR UPDATE` 실제
잠금, IntegrityError 수렴, `reserved_count` 복구, 감사 로그 INSERT는
**TS-12에서만 실증된다.** SQL 컴파일 검증까지가 지금 할 수 있는 전부다.
Phase 9는 이 항목들을 **통과가 아니라 미검증**으로 표기해야 한다.

---

## 7. TS-06(라우터) 인계 사항

1. `Idempotency-Key` 헤더는 **라우터가 읽어** `cancel_reservation(idempotency_key=...)`로
   넘긴다. `deps.py`에는 헤더 의존성을 두지 않았다(태스크가 지정한 4개만 구현)
2. 예외 처리: `except CancellationError as exc:` → `HTTPException(exc.status_code, exc.message)`
   한 줄이면 전부 덮인다. `exc.code`는 클라이언트용 안정 식별자다
3. `outcome.is_failed`가 True면 PG 환불 실패다. **502 권고** — 서비스는 이 경우
   예외를 던지지 않으므로 라우터가 판정해야 한다. 실패 사유는 `outcome.failure_code`
4. `outcome.replayed`가 True면 중복 요청이다. **200으로 그대로 반환한다** (409 아님)
5. `preview_cancellation()`은 `CancellationPreview`를 돌려준다 —
   `cancellable=False`일 때 `reason_code`가 거부 사유다
6. `refund_account`의 "가상계좌면 필수" 검증은 **스키마 계층 몫**이다. 서비스는
   `None`을 받아도 진행하고, 어댑터가 2차 방어로 `failed`를 돌려준다
