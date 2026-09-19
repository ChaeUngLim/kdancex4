# Phase 3 — 구현 계획: 예약 취소 환불 로직

- 작성일: 2026-09-14 / 담당: kdance-impl-planner
- 입력: `_workspace/01_req-analyst_requirements.md` (§9 사용자 결정이 최신 확정 스코프), `_workspace/02_code-searcher_structure.md` (§9 배치 권고, §9.4 열린 항목 7개)
- 이전 계획: 없음 (`_workspace/03_*` 최초 작성)
- 상태: **Phase 4(Task 분리) 착수 가능.** 단 §7 전제 조건(Docker)과 §8 플래그 3건을 오케스트레이터가 확인할 것.

---

## 0. 계획 요약

Q1=B안(수직 슬라이스) / Q2=가상계좌 환불계좌 수집 / Q3=(a) 학원별 환불 비율표 / 자동 즉시 환불 — 이 4개 결정을 전제로, 백엔드 그린필드에 **예약 취소 → 환불액 산정 → 환불 실행(Fake PG) → 슬롯 복구 → 감사 로그** 경로를 세로로 낸다.

17개 태스크 중 **T-01 ~ T-11, T-14 ~ T-17 (15개)는 DB 없이 지금 작성·검증 가능**하고, **T-12·T-13 (2개)만 Docker 기동 이후로 막힌다**(§7).

Q4(수수료·쿠폰·정산 역산)·Q5(부분 취소·학원 귀책)는 **추측하지 않는다.** 확장 지점만 열어두고 임시값을 상수 한 곳에 모은다 — §6에 재작업 범위를 파일 단위로 명시했다.

---

## 1. 열린 항목 7건 — 결정과 근거

### D1. `Reservation` vs `Order` 네이밍 → **분리한다 (`Order` = 돈, `Reservation` = 자리)**

**결정:** 두 모델을 모두 만들고 `Order 1 : N Reservation`으로 둔다. 취소 API는 `POST /reservations/{id}/cancel`, 기존 문서의 `POST /orders`(`docs/social-dance-app-dev-guide.html:791`)는 이름 그대로 남겨둔다(이번 슬라이스에서 구현하지 않음).

**근거:**

1. **기존 설계가 이미 둘을 분리해서 본다.** `docs/social-dance-app-dev-guide.html:462-465` — "같은 트랜잭션에서 예약 가능 슬롯과 결제 상품이 함께 생성된다". 슬롯과 결제 상품이 별개 개념이라고 문서가 먼저 말하고 있다.
2. **FR-42가 1:1을 구조적으로 금지한다.** `docs/requirements-analysis.md:48` — "동일 슬롯에 복수 가상계좌가 발급된 경우 먼저 입금 확인된 주문만 확정". 한 슬롯에 동시에 여러 Order가 살아 있어야 하므로, Order와 좌석을 한 행에 합치면 이 요구사항을 표현할 수 없다.
3. **상태 머신이 둘이다.** 결제 상태(`pending → paid → refunded`)와 좌석 상태(`held → confirmed → cancelled`)는 전이 시점이 다르다. 한 테이블에 합치면 "결제는 미완인데 좌석은 홀드" 같은 정상 상태를 표현할 수 없다.
4. **Q5(부분 취소) 확정 시 스키마 재작업을 피한다.** 취소 단위가 Reservation이므로, 한 Order에 Reservation이 여러 개여도 부분 취소는 "그중 하나를 취소"로 자연히 확장된다. 통합했다면 Q5 확정 순간 마이그레이션이 필요하다.
5. **문서와 충돌하지 않는다.** 개발 가이드에 취소/환불 API는 아예 없다(`02_..._structure.md` §4.1 — `취소`·`환불` 키워드 히트 0). 새 엔드포인트를 추가하는 것이지 기존 계약을 바꾸는 게 아니다.

**비용:** 테이블 1개 증가. 이번 슬라이스는 `Order` 1건당 `Reservation` 1건만 생성한다(부분 취소 미지원 = Q5 미확정). 스키마가 N을 허용하므로 Q5 확정 시 **마이그레이션 없이 서비스/API 로직만 바꾸면 된다.**

### D2. `alembic/env.py:35` → **계획의 명시적 첫 단계 (T-01)**

`backend/alembic/env.py:35`의 `target_metadata = None`을 `target_metadata = Base.metadata`로 바꾼다. 이걸 빼먹으면 `alembic revision --autogenerate`가 조용히 빈 마이그레이션을 뱉는다.

**순서 주의:** `from app.models import Base`가 성립하려면 모델 패키지가 먼저 있어야 한다. 그래서 T-01은 "빈 `Base` 선언 + env.py 배선"을 한 덩어리로 묶는다. 개별 모델(T-04)은 그 위에 얹는다. `backend/alembic.ini:21`의 `prepend_sys_path = .` 덕분에 `backend/`를 rootdir로 하면 이 import가 동작한다.

**T-04 이후 모든 모델 태스크의 완료 조건에 "`app/models/__init__.py`에 re-export 추가"를 넣는다.** 모델 파일을 빼먹으면 autogenerate가 그 테이블을 조용히 누락한다.

### D3. 테스트 DB 전략 → **실 Postgres(`kdance_test` DB) + 함수 단위 트랜잭션 롤백**

**결정:**
- 세션 스코프 엔진 → 전용 테스트 DB `kdance_test` (환경변수 `TEST_DATABASE_URL`, 기본 `postgresql+psycopg://kdance:kdance@localhost:5433/kdance_test`)
- 스키마 생성은 `Base.metadata.create_all()` (빠름). 마이그레이션 자체의 정합성은 **T-12에서 별도로** 왕복 검증한다(두 관심사를 분리).
- 함수 스코프 픽스처: 커넥션 열기 → 바깥 트랜잭션 시작 → `Session(bind=connection, join_transaction_mode="create_savepoint")` → 테스트 종료 시 바깥 트랜잭션 **rollback**.
  - `join_transaction_mode="create_savepoint"`(SQLAlchemy 2.0)가 핵심이다. 서비스 코드가 내부에서 `session.commit()`을 호출해도 SAVEPOINT 릴리스로 처리되어 격리가 깨지지 않는다. 이게 없으면 취소 서비스처럼 스스로 커밋하는 코드를 롤백 방식으로 테스트할 수 없다.
- `app.dependency_overrides[get_db]`로 API 테스트에 같은 세션을 주입.

**SQLite를 버리는 이유 (중요):** 이번 수용 기준의 안전성 항목들이 **Postgres 전용 기능에 의존한다.**
- 멱등성 보장 = **partial unique index** (`WHERE status <> 'failed'`) — SQLite는 부분 인덱스를 지원하지만 문법·동작이 다르고, 애초에 이걸 SQLite에서 통과시켜도 프로덕션 보장의 증거가 되지 못한다.
- 환불 비율표 = **JSONB**
- 상태 전이 원자성 = **`SELECT ... FOR UPDATE`** (SQLite에 행 수준 잠금 개념 없음)
- 프로덕션이 psycopg3 **동기** 엔진 전제이므로, 드라이버를 바꿔 테스트할 이유가 없다.

수용 기준 "환불액이 원결제액을 초과하는 경우가 **구조적으로 불가능**"을 DB 제약으로 보장하기로 한 이상, 테스트 DB가 그 제약을 실제로 걸 수 있어야 한다. SQLite로는 이 기준을 검증했다고 말할 수 없다.

**스키마 분리(테스트별 schema)를 버리는 이유:** `search_path` 조작이 들어가면 `db.py`의 엔진 설정과 alembic 설정 양쪽에 테스트 전용 분기가 생긴다. 트랜잭션 롤백이 더 빠르고 프로덕션 코드에 흔적을 남기지 않는다.

**Docker 블로커 대응 (이게 이 결정의 실무적 핵심):**
- `pyproject.toml`에 `[tool.pytest.ini_options]`를 새로 만들고 마커 `requires_db`를 등록한다.
- `conftest.py`가 세션 시작 시 DB 연결을 1회 시도하고, 실패하면 `requires_db` 마커가 붙은 테스트를 **skip**한다(에러 아님).
- 결과: 지금 이 환경에서 `cd backend && uv run pytest`가 **초록으로 통과한다** — 환불액 산정 단위 테스트(두꺼운 쪽)는 전부 실행되고, DB 테스트만 skip으로 남는다. Docker가 뜨면 같은 명령이 skip 없이 전부 돈다.

### D4. Fake PG 어댑터 인터페이스 → **단일 Protocol + 결제수단 태그 + 비동기 결과 모델링**

**결정:** `app/adapters/payment_gateway.py`에 Protocol 하나.

```
PaymentGateway.refund(request: RefundRequest) -> RefundResult
```

- `RefundRequest`: `payment_key`(원거래 식별자), `method: PaymentMethod`, `amount: int`, `idempotency_key: str`, `refund_account: RefundAccount | None`
- `RefundResult`: `status: RefundStatus ∈ {succeeded, pending, failed}`, `gateway_refund_id: str | None`, `failure_code/failure_message`
- `RefundAccount`: `bank_code`, `account_number`, `holder_name`

**메서드를 카드/가상계좌로 쪼개지 않는 이유:** PG사가 아직 미선정이다(`docs/social-dance-app-dev-guide.html:315-321`). 포트원·토스 모두 실제로는 취소/환불 API가 하나이고 결제수단에 따라 파라미터가 달라지는 형태다. 지금 Protocol을 둘로 쪼개면 아직 고르지도 않은 SDK의 모양을 추측해서 고정하는 셈이 된다. 결제수단은 **요청 안의 태그**로 두는 쪽이 어떤 PG가 오든 얇은 매핑으로 흡수된다.

**대신 차이를 명시적으로 드러내는 3가지:**
1. `RefundStatus.pending`이 **1급 상태다.** 가상계좌 환불은 수취 계좌로의 별도 송금이라 즉시 완료되지 않는다(`01_..._requirements.md:91`). 카드 승인취소만 생각하고 `bool`을 반환하게 설계하면, 나중에 pending을 끼워넣을 때 서비스·모델·API가 전부 바뀐다.
2. `refund_account`는 **`method == virtual_account`일 때 필수**다. 검증은 어댑터가 아니라 **Pydantic 스키마 계층**(`schemas/cancellation.py`)에서 한다 — PG를 갈아끼워도 검증 규칙이 살아남는다.
3. `method == card`는 이번 슬라이스에서 `UnsupportedPaymentMethodError`를 던진다. Q2 결정상 카드 승인취소는 범위 밖이다. **조용히 잘못된 경로로 흐르는 것보다 눈에 보이는 구멍이 낫다.**

`FakePaymentGateway`: 인메모리 원장, 결정적 동작, 테스트용 실패 주입(`FakePaymentGateway(fail_on={payment_key})`) 및 pending 강제 옵션 제공.

### D5. 멱등성 키 → **DB 제약이 유일한 권위. 위에 서비스 락과 API 키를 얹는다**

3겹이되 진실은 하나다.

| 계층 | 수단 | 역할 |
|---|---|---|
| **DB (권위)** | `refunds` 부분 유니크 인덱스 `UNIQUE (reservation_id) WHERE status <> 'failed'` | 예약당 진행중/성공 환불 1건. 실패 건은 재시도 허용. **이중 환불이 구조적으로 불가능해지는 지점** |
| **DB (권위)** | `refunds.idempotency_key` UNIQUE | 같은 논리 요청의 재시도를 동일 결과로 되돌려줌 |
| 서비스 | `SELECT ... FOR UPDATE`로 `reservations` 행 잠금 → 상태 전이 검증 → 환불 | 경합의 1차 방어선. 정상 경로에서 IntegrityError를 안 보게 함 |
| API | `Idempotency-Key` 헤더(선택) | 없으면 서버가 `sha256("cancel:" + reservation_id)`로 **결정적 키를 생성**. 즉 헤더를 안 보내도 이중 환불은 불가능 |

**Redis에 두지 않는 이유:** `infra/docker-compose.yml`의 redis에 **볼륨이 없다**(`02_..._structure.md` §5). 재시작하면 전부 날아간다. 금전 이동의 유일한 진실을 휘발성 저장소에 둘 수 없다. Redis는 FR-42 슬롯 락(단기 TTL) 용도로만 쓴다.

**동작:** 유니크 위반(IntegrityError) 발생 시 → 기존 `Refund` 행을 조회 → **HTTP 409가 아니라 기존 결과를 200으로 반환**한다. 수용 기준은 "환불은 1회만 실행된다"이지 "두 번째 요청이 에러난다"가 아니다. 클라이언트 재시도가 자연스럽게 성공하는 편이 낫다.

### D6. `REDIS_URL` → **양쪽 파일 모두에 추가 (T-02)**

- `backend/.env.example`: `REDIS_URL=redis://localhost:6380/0` 추가 (현재 `DATABASE_URL` 한 줄뿐 — 직접 확인함)
- `backend/.env`: 동일 추가 (gitignore 대상, 로컬 개발용)
- `backend/.env.example`에 `TEST_DATABASE_URL`도 함께 추가 (D3)
- **포트 6380**이다. 표준 6379 아님 — `infra/docker-compose.yml:25`에서 직접 확인.
- `cd backend && uv add redis` 필요.

### D7. Docker 인프라 블로커 → **전제 조건으로 명시, 차단선은 T-12/T-13 앞**

§7에서 상세히 다룬다.

---

## 2. 도메인 설계 결정 (파일을 쓰기 전에 고정해야 하는 것들)

### 2.1 환불 비율표 스키마 (Q3=(a)의 실체)

`academies.refund_policy_tiers` — **JSONB, 기본값 `[]`**

```
[{"hours_before_start": 24, "refund_rate_bp": 5000},
 {"hours_before_start": 12, "refund_rate_bp": 0}]
```

**해석 규칙 (순수 함수로 구현, 테스트로 못박음):**
- 수업 시작까지 남은 시간 `h`가 **24시간 이상**이면 환불율 100% — 플랫폼 고정 규칙, 티어와 무관 (FR-22, `docs/kdance-screens-spec.html:502-506`)
- `h < 24시간`이면, `h <= tier.hours_before_start`를 만족하는 티어 중 **`hours_before_start`가 가장 작은 것**을 적용
- 만족하는 티어가 없으면 0%
- 검산: 위 예시에서 `h=20h` → 24만 만족 → 50%. `h=6h` → 24·12 둘 다 만족, 최소는 12 → 0%. 의도대로다.

**`_bp`(basis point, 0~10000 정수)를 쓰는 이유:** 부동소수 금지(`01_..._requirements.md:98`). 퍼센트를 float로 두는 순간 이 제약이 깨진다.

**JSONB를 쓰는 이유:** 티어 개수가 학원마다 다르고, Q4/Q5 확정 시 필드가 늘어날 가능성이 높다. 별도 테이블로 빼면 그때마다 마이그레이션이 필요하다. 다만 **JSONB는 DB가 구조를 검증해주지 않으므로**, 쓰기 경로(admin API)에서 Pydantic 모델로 반드시 검증한다(정렬·중복·범위).

**노출:** `docs/kdance-screens-spec.html:503`이 "학원 상세 페이지에 명시"를 요구한다 → `GET /academies/{id}` 응답에 포함되어야 한다. **단 `GET /academies/{id}`는 이번 슬라이스에 없다.** T-15의 admin 화면에서만 읽고 쓴다. 이 항목은 §8 플래그로 남긴다.

### 2.2 경계값 — "정확히 24시간 00분 00초"

**결정: `h >= 24시간`이면 100% 환불** (경계를 전액 환불 쪽에 포함).

근거: 약관 문구가 "수업 시작 24시간 **전** 취소 — 전액 환불"이다. 정확히 24시간 전은 "24시간 전"에 포함된다고 읽는 것이 자연스럽고, 소비자에게 유리한 해석이 분쟁 리스크가 낮다. 수용 기준이 명시적 정의와 테스트를 요구하므로(`01_..._requirements.md:158`) 이 경계를 파라미터라이즈 테스트로 못박는다(23:59:59 / 24:00:00 / 24:00:01).

시각은 전부 **timezone-aware UTC**(`TIMESTAMP WITH TIME ZONE`). 산정 함수는 `now`를 **파라미터로 주입**받는다 — `datetime.now()`를 함수 안에서 호출하면 경계값 테스트가 불가능해진다.

### 2.3 반올림 — **올림(ceil)**

`refund_amount = ceil(paid_amount * rate_bp / 10000)`, 정수 연산으로 `-(-paid_amount * rate_bp // 10000)`.

근거: 1원 단위 차이지만, 내림은 "회원에게 덜 준" 방향이라 분쟁 시 불리하다. 올림이 안전하다. 단 **누적 환불액이 결제액을 넘지 않도록 clamp**하고, 그 상한은 DB CHECK로도 건다(§2.5).

### 2.4 Enum은 PG 네이티브 타입이 아니라 **VARCHAR + CHECK**

모든 상태/구분 컬럼(`reservation.status`, `order.status`, `payment.method`, `refund.status`, `cancellation.reason`)을 `String` + `CHECK (col IN (...))`로 둔다. Python 쪽은 `enum.StrEnum`.

근거: **Q4/Q5가 미확정이라 값 집합이 바뀔 것이 거의 확실하다.** PG 네이티브 ENUM은 값 추가는 되지만 제거·순서 변경이 사실상 불가능하고, alembic autogenerate가 enum 변경을 감지하지 못하는 잘 알려진 함정이 있다. CHECK 제약은 drop/add로 되돌리기 쉽다.

### 2.5 슬롯 복구 — **DB가 source of truth, Redis는 보조**

- `class_schedules.capacity` (정원) + `class_schedules.reserved_count` (확정 예약 수)
- `CHECK (reserved_count >= 0 AND reserved_count <= capacity)`
- 취소 시 `SELECT ... FOR UPDATE` 안에서 `reserved_count = reserved_count - 1`

`reserved_count`를 집계가 아니라 컬럼으로 두는 이유: `docs/kdance-screens-spec.html:272`가 "정원 대비 신청 인원(8/12)"을 목록 화면에 요구한다 — 조회가 잦으므로 매번 COUNT 하는 것보다 싸고, CHECK 제약이 음수·초과를 구조적으로 막아준다.

**Redis 슬롯 락 해제는 best-effort다.** `adapters/slot_lock.py`가 취소 시 해당 슬롯 락 키를 삭제하되, **Redis 연결 실패가 환불 트랜잭션을 실패시키지 않는다**(경고 로그 + 계속 진행). Redis에 볼륨이 없어 어차피 진실의 원천이 아니고, 금전 트랜잭션이 캐시 장애로 롤백되는 게 훨씬 나쁘다.

### 2.6 감사 추적 — append-only 테이블

`refund_events`: `id`, `refund_id`, `event_type`, `payload` JSONB, `created_at`. **UPDATE/DELETE 하지 않는다.** 서비스가 상태 전이마다 INSERT. 요청·산정·실행·실패가 전부 남는다(`01_..._requirements.md:96`).

### 2.7 이번 슬라이스에서 **만들지 않는 것**

- `POST /orders` (결제 생성) — 취소는 "이미 결제된 건"을 전제한다. 테스트는 픽스처로 Order/Payment를 직접 삽입한다. **결과적으로 앱에서 end-to-end 데모는 불가능하다** — §8 플래그.
- `User` 인증 — 소유권 검증(수용 기준 "본인 예약만 취소, 타인 403")이 필요하므로 `reservations.user_id`(UUID) 컬럼은 둔다. 인증은 `X-User-Id` 헤더를 읽는 **임시 의존성**(`app/deps.py:current_user_id`)으로 대체하고, 함수 하나만 교체하면 실제 인증으로 바뀌도록 격리한다. 이 임시성을 코드 주석과 계획에 모두 명시한다.
- `Coupon`, `Subscription`, 정산 — Q4 미확정(§6).
- mobile 네비게이션/Push 실연동 — §5.3.

---

## 3. 변경 파일 목록 — backend

경로는 전부 `/home/user/kdance/` 기준. **[신규]/[수정]** 표기.

| # | 파일 | 변경 내용 | 태스크 |
|---|---|---|---|
| 1 | `backend/app/models/base.py` | **[신규]** `class Base(DeclarativeBase)`, `TimestampMixin`(`created_at`/`updated_at`, `server_default=func.now()`) | T-01 |
| 2 | `backend/app/models/__init__.py` | **[신규]** `Base` + 전 모델 re-export. alembic이 여기 하나만 import | T-01 → T-04에서 확장 |
| 3 | `backend/alembic/env.py` | **[수정]** `:35` `target_metadata = None` → `from app.models import Base` / `target_metadata = Base.metadata` | **T-01 (첫 단계)** |
| 4 | `backend/pyproject.toml` | **[수정]** deps: `redis`, `pydantic-settings` 추가 / dev: `uvicorn` 추가 / `[tool.pytest.ini_options]` 신설(`markers = ["requires_db: ..."]`, `testpaths = ["tests"]`) | T-02 |
| 5 | `backend/.env.example` | **[수정]** `REDIS_URL=redis://localhost:6380/0`, `TEST_DATABASE_URL=...kdance_test` 추가 | T-02 |
| 6 | `backend/.env` | **[수정]** 동일 2줄 추가 (gitignore 대상) | T-02 |
| 7 | `backend/app/config.py` | **[신규]** `pydantic-settings` 기반 `Settings`(`database_url`, `redis_url`, `test_database_url`) + `get_settings()` lru_cache | T-02 |
| 8 | `backend/app/db.py` | **[신규]** `create_engine`(동기, psycopg3), `SessionLocal`, `get_db()` FastAPI 의존성(yield + close) | T-03 |
| 9 | `backend/app/models/academy.py` | **[신규]** `Academy`: `id`(UUID pk), `name`, **`refund_policy_tiers` JSONB default `[]`**, timestamps | T-04 |
| 10 | `backend/app/models/class_schedule.py` | **[신규]** `ClassSchedule`: `id`, `academy_id` FK, `starts_at`(timestamptz), `price_amount`(Integer, CHECK>=0), **`capacity`**, **`reserved_count`** + CHECK | T-04 |
| 11 | `backend/app/models/order.py` | **[신규]** `Order`: `id`, `user_id`, `status`(VARCHAR+CHECK), `total_amount`, timestamps | T-04 |
| 12 | `backend/app/models/payment.py` | **[신규]** `Payment`: `id`, `order_id` FK, `method`(VARCHAR+CHECK: `virtual_account`/`card`), `amount`, `paid_at`, `gateway_payment_key` | T-04 |
| 13 | `backend/app/models/reservation.py` | **[신규]** `Reservation`: `id`, `order_id` FK, `class_schedule_id` FK, `user_id`, `status`(VARCHAR+CHECK), `cancelled_at` | T-04 |
| 14 | `backend/app/models/refund.py` | **[신규]** `Refund`: `id`, `reservation_id` FK, `payment_id` FK, `idempotency_key` UNIQUE, `requested_amount`, `refunded_amount`, `refund_rate_bp`, `status`, `reason`, `refund_account_*`, `gateway_refund_id`, `failure_code/message` + **partial unique index** | T-04 |
| 15 | `backend/app/models/refund_event.py` | **[신규]** `RefundEvent` append-only 감사 로그 | T-04 |
| 16 | `backend/alembic/versions/0001_initial_domain.py` | **[신규]** 최초 리비전(`down_revision = None`). **손으로 작성**(§7 근거). upgrade/downgrade 양방향 + partial unique index + 모든 CHECK | T-05 |
| 17 | `backend/app/services/refund_policy.py` | **[신규] 핵심 순수 함수.** `calculate_refund(paid_amount, starts_at, now, tiers, reason) -> RefundCalculation`. DB·IO 의존 0. 경계·올림·bp·티어 해석 전부 여기 | T-06 |
| 18 | `backend/app/services/fee_policy.py` | **[신규] Q4 임시 격리소.** `PLATFORM_FEE_RATE_BP=800`, `BETA_FEE_WAIVED=True`, `PG_FEE_BEARER="platform"`. 파일 상단에 `# Q4 미확정 — 확정 시 이 파일만 교체` 주석 | T-06 |
| 19 | `backend/app/adapters/payment_gateway.py` | **[신규]** `PaymentGateway` Protocol + `RefundRequest/RefundResult/RefundAccount` + `FakePaymentGateway`(실패·pending 주입 가능) + `UnsupportedPaymentMethodError` | T-08 |
| 20 | `backend/app/adapters/notification.py` | **[신규]** `NotificationSender` Protocol + `FakeNotificationSender`(호출 기록만). 회원·학원 관리자 2방향 | T-08 |
| 21 | `backend/app/adapters/slot_lock.py` | **[신규]** Redis 슬롯 락 해제. 키 네임스페이스 `kdance:slot:{schedule_id}` 고정(§4.6 할인 락과 충돌 방지). **연결 실패 시 no-op + 경고** | T-08 |
| 22 | `backend/app/services/cancellation.py` | **[신규]** 취소 오케스트레이션: FOR UPDATE 잠금 → 상태 전이 검증 → 소유권 검증 → 환불액 산정 → Refund INSERT(멱등) → PG 호출 → reserved_count 복구 → 감사 로그 → 알림. IntegrityError 시 기존 Refund 반환 | T-09 |
| 23 | `backend/app/deps.py` | **[신규]** `current_user_id`(임시: `X-User-Id` 헤더), `get_payment_gateway`, `get_notification_sender`, `get_slot_lock` — 전부 FastAPI Depends로 교체 가능하게 | T-09 |
| 24 | `backend/app/schemas/cancellation.py` | **[신규]** `CancelRequest`(`refund_account` — `method=virtual_account`면 필수, model_validator), `CancelResponse`, `CancellationPreview` | T-10 |
| 25 | `backend/app/schemas/academy.py` | **[신규]** `RefundPolicyTier`(`hours_before_start` 1~720, `refund_rate_bp` 0~10000), `RefundPolicyUpdate`(정렬·중복 검증) | T-10 |
| 26 | `backend/app/routers/reservations.py` | **[신규]** `POST /reservations/{id}/cancel`, `GET /reservations/{id}/cancellation-preview`(사전 고지용) | T-10 |
| 27 | `backend/app/routers/admin_academies.py` | **[신규]** `GET·PUT /admin/academies/{id}/refund-policy` | T-10 |
| 28 | `backend/app/main.py` | **[수정]** `include_router` 2줄 추가 + CORS 미들웨어(admin-web `localhost:5173`). **기존 `GET /health`는 손대지 않는다** | T-10 |
| 29 | `backend/tests/conftest.py` | **[신규]** 엔진/세션 픽스처(D3), `get_db` 오버라이드, Fake 어댑터 주입, DB 미가용 시 `requires_db` skip 훅, 도메인 팩토리 픽스처 | T-11 |
| 30 | `backend/tests/test_refund_policy.py` | **[신규] 가장 두껍게.** 경계(23:59:59/24:00:00/24:00:01), 티어 해석, 빈 티어, 올림, bp 범위, 0원, 순서 뒤섞인 티어. **DB 불필요 — 지금 전부 실행 가능** | T-07 |
| 31 | `backend/tests/test_cancel_api.py` | **[신규]** `requires_db`. 정상/403 타인/404/상태오류(이미 취소·이미 시작)/**동시 2건 중복 요청**/PG 실패 시 상태·사유 기록/슬롯 복구 확인 | T-11 |
| 32 | `backend/tests/test_admin_refund_policy.py` | **[신규]** `requires_db`. 비율표 CRUD + 검증 실패 케이스 | T-11 |
| 33 | `backend/tests/test_health.py` | **[변경 없음]** 회귀 확인용으로 계속 통과해야 함 | 전 구간 |

---

## 4. 변경 파일 목록 — admin-web

| # | 파일 | 변경 내용 | 태스크 |
|---|---|---|---|
| 34 | `admin-web/src/api/client.ts` | **[신규]** `API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"` + 얇은 fetch 래퍼 | T-14 |
| 35 | `admin-web/.env.example` | **[신규]** `VITE_API_BASE_URL=http://localhost:8000` | T-14 |
| 36 | `admin-web/src/App.tsx` | **[수정]** `:7` 하드코딩 URL을 client.ts로 교체 + 환불정책 화면 조건부 렌더링(탭) | T-14/T-15 |
| 37 | `admin-web/src/pages/RefundPolicySettings.tsx` | **[신규]** 학원별 환불 비율표 조회·편집(티어 행 추가/삭제, bp 입력, 저장). 순수 CSS + `useState` | T-15 |

**라우터를 도입하지 않는 이유:** `admin-web`에 런타임 의존성이 react/react-dom 둘뿐이다(직접 확인). 라우터 도입은 화면 12개 전체의 URL 설계가 걸린 별개 결정이고, 이번 슬라이스(화면 1개)를 위해 끌어들이면 범위가 새어나간다. **`App.tsx` 조건부 렌더링으로 간다.** 다만 `src/api/client.ts`는 지금 만든다 — fetch 지점이 2개가 되는 시점이 하드코딩을 걷어낼 적기다.

**권고(별도 작업):** 라우터 도입 시점 결정. 이번 계획 범위 밖.

---

## 5. 변경 파일 목록 — mobile

| # | 파일 | 변경 내용 | 태스크 |
|---|---|---|---|
| 38 | `mobile/App.tsx` | **[수정]** 취소 확인 화면(예상 환불액 사전 고지) + 가상계좌 환불계좌 입력 폼. 네비게이션 없이 단일 화면 상태 전환 | T-16 |
| 39 | `mobile/.env.example` | **[신규]** `EXPO_PUBLIC_API_URL=http://localhost:8000` | T-16 |

### 5.1 이 범위의 한계 (정직하게)

Q2 결정이 "환불계좌 입력 UI 필요"이므로 mobile을 완전히 빼지는 않는다. 다만 `mobile/`은 Expo 순정 템플릿 그대로이고 **네비게이션 라이브러리조차 없다**. 이번에 만드는 것은 **데모 수준 단일 화면**이며, 실제 제품 화면은 네비게이션 도입 후 재작성된다. §8 플래그.

### 5.2 mobile에서 **하지 않는 것**

- `expo-notifications` 등 Push 패키지 설치 — EAS `projectId` 발급이 선행되어야 하는 별개 작업(`02_..._structure.md` §7.3). 백엔드는 Fake sender로 계약만 맞춘다.
- `app.json`의 `android.package`(`com.kdancex3`) 누락 수정 — 이번 요청과 무관. **권고 항목으로만 남긴다.**
- `mobile/.env` 위생 문제(14KB, 타 프로젝트 키 대량 포함) — 범위 밖. **권고: 정리 필요.**

---

## 6. Q4 / Q5 미확정 — 최소 구현과 재작업 범위

> **이 두 항목을 추측해서 확정하지 않는다.** 아래는 "결정을 내리지 않고도 동작하는 최소 형태"이며, 확정 시 어느 파일을 고쳐야 하는지를 명시한다.

### Q4 (수수료·쿠폰·정산 역산) — 최소 구현

| 항목 | 이번 처리 | 확정 시 재작업 대상 |
|---|---|---|
| 플랫폼 수수료 8% 환급 여부 | `services/fee_policy.py`에 상수로만 존재. **환불액 산정에 반영하지 않는다**(베타 6개월 면제 중이므로 실효 0 — FR-38) | `services/fee_policy.py`, `services/cancellation.py` 호출부 1곳 |
| 반환 안 되는 PG 건당 수수료 부담자 | `PG_FEE_BEARER = "platform"` 임시 상수. 계산에 미반영 | 동일 파일 + `Refund` 모델에 부담액 컬럼 추가 시 **마이그레이션 필요** |
| 정산 후 환불 회수 | **미구현.** `Refund`에 `order_id`·`refunded_amount`·`refunded_at`이 남으므로 정산 재계산의 원천 데이터는 확보됨 | 정산 모듈 자체가 미착수 — 별건 |
| 쿠폰 복원 | **미구현.** `Coupon` 모델이 이번 슬라이스에 없으므로 해당 사항 없음 | `Coupon` 도입 시 `services/cancellation.py`에 복원 훅 추가 |

**재작업 규모 추정:** `fee_policy.py` 교체 + `cancellation.py` 호출 1곳. **금액을 `Refund`에 추가 기록해야 한다면 마이그레이션 1건.** 지금 추측해서 컬럼을 미리 박아두지 않는 이유가 이것이다 — 잘못 박은 컬럼을 지우는 게 없는 컬럼을 더하는 것보다 비싸다.

### Q5 (부분 취소·학원 귀책) — 최소 구현

| 항목 | 이번 처리 | 확정 시 재작업 대상 |
|---|---|---|
| 부분 취소 | **스키마는 이미 지원**(`Order 1:N Reservation`, D1). 다만 이번엔 Order당 Reservation 1건만 다루므로 실질 전체 취소 | **마이그레이션 불필요.** `services/cancellation.py`의 "Order 전체 취소 여부" 판정과 `routers/reservations.py` 응답 형태만 |
| 학원 귀책 취소 | `reason` enum에 `member_request` **하나만** 둔다. `academy_fault`를 추측해서 넣지 않는다. 단 `calculate_refund(..., reason)` 시그니처가 이미 `reason`을 받으므로 분기 추가 지점은 열려 있다 | `services/refund_policy.py` 분기 추가 + CHECK 제약 변경 **마이그레이션 1건**(VARCHAR+CHECK이라 저렴 — D2.4가 이걸 노린 결정) |

**Phase 4 착수 전 오케스트레이터가 사용자에게 Q4·Q5를 재질의할 것** (`01_..._requirements.md:145-146`이 요구).

---

## 7. 전제 조건 — Docker 인프라 블로커 (차단선)

### 7.1 현재 상태 (직접 재확인함)

- `ss -ltn` — 5433·6380·5432·6379 **전부 미개방**. `kdance-db`·`kdance-redis` 미기동.
- `docker` CLI — 이 WSL2 배포판에서 **사용 불가** (Docker Desktop WSL 통합 미활성).
- 따라서 **이 에이전트도, Phase 5 구현 에이전트도 스스로 DB를 띄울 수 없다.**

### 7.2 해소 절차 (사용자 조치 — T-00)

```bash
# 1) Docker Desktop → Settings → Resources → WSL Integration에서 이 배포판 활성화
cd /home/user/kdance/infra && docker compose up -d
# 2) 확인
docker compose ps                                   # db, redis 둘 다 healthy
cd /home/user/kdance/backend && uv run alembic current   # 기대: 빈 출력(리비전 0건)
# 3) 테스트 DB 생성 (D3)
docker exec kdance-db psql -U kdance -c 'CREATE DATABASE kdance_test;'
```

### 7.3 차단선 — 어디까지 되고 어디부터 막히나

**진행 가능 (DB 불필요, 지금 전부 작업 가능):**

| 태스크 | 비고 |
|---|---|
| T-01 메타데이터 배선 + `env.py:35` | 파일 편집만 |
| T-02 설정·의존성·`REDIS_URL` | `uv add`는 네트워크만 필요 |
| T-03 `db.py` | 엔진 **생성**은 실제 연결을 하지 않는다(lazy) |
| T-04 모델 7개 | 선언만 |
| T-05 초기 마이그레이션 **손작성** | ↓ 7.4 |
| T-06 환불액 산정 + fee_policy | 순수 함수 |
| **T-07 산정 단위 테스트** | **DB 불필요 — 지금 실제로 실행해서 통과시킬 수 있다. 이게 이번 작업의 검증 핵심** |
| T-08 어댑터 3종 | Fake는 인메모리. `slot_lock`도 연결 실패 시 no-op이라 import·단위 테스트 가능 |
| T-09 취소 서비스 | 코드 작성 |
| T-10 스키마·라우터·main.py | 코드 작성. `GET /health` 회귀 테스트는 계속 통과 |
| T-11 `conftest.py` + DB 테스트 **작성** | `requires_db` 마커로 skip되어 pytest는 초록 |
| T-14~T-17 admin-web·mobile·문서 | 백엔드 DB와 무관 |

**차단됨 (Docker 기동 필수):**

| 태스크 | 막히는 이유 |
|---|---|
| **T-12 마이그레이션 적용 검증** | `alembic upgrade head` / `downgrade base`가 실제 연결을 요구. `--autogenerate`도 DB에 붙는다 |
| **T-13 DB 통합 테스트 실행** | `test_cancel_api.py`·`test_admin_refund_policy.py` 전체 |
| (부수) Redis 슬롯 락 실동작 확인 | 코드 경로는 T-08에서 작성·단위 테스트 가능하나 실제 키 삭제 확인 불가 |

**수용 기준 중 T-12/T-13 없이는 충족을 선언할 수 없는 항목:** "Alembic 마이그레이션 up/down 정상 동작", "취소 API 통합 테스트 통과", "동시 2건 요청 시 환불 1회". Phase 9(완료 검증)는 이 3개를 **미검증**으로 남겨야 하며, 통과했다고 써선 안 된다.

### 7.4 초기 마이그레이션을 손으로 쓰는 결정

`alembic revision --autogenerate`는 **DB에 연결한다** → 지금 불가능. 반면 `alembic revision -m "..."`(빈 리비전 생성)은 연결하지 않는다.

**결정: 최초 리비전을 손으로 작성한다.** 부가 이유:
- partial unique index, CHECK 제약, JSONB 기본값은 autogenerate가 어차피 완전히 못 만들어서 손질이 필요하다.
- downgrade(수용 기준)를 제대로 쓰려면 어차피 사람이 봐야 한다.

**정합성 증명 방법 (T-12):**
```bash
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "verify"   # 생성된 파일의 upgrade/downgrade가 pass여야 정합
uv run alembic downgrade base && uv run alembic upgrade head
```
autogenerate가 **빈 diff**를 뱉으면 손작성 마이그레이션이 모델과 일치한다는 증거다. 확인 후 verify 리비전은 삭제.

---

## 8. 오케스트레이터에게 남기는 플래그

| # | 내용 | 필요한 조치 |
|---|---|---|
| **F1** | **Docker 미기동 + docker CLI 사용 불가** — T-12/T-13이 차단된다 | **사용자 조치 필요**(§7.2). 해소 전에는 Phase 9에서 마이그레이션·통합테스트 수용 기준을 "미검증"으로 표시 |
| **F2** | **Q4·Q5 미확정** | `01_..._requirements.md:145-146`대로 **Phase 4 착수 전 재질의**. 확정되면 §6 표의 파일만 재작업 |
| **F3** | **mobile UI가 데모 수준이다** — 네비게이션 없는 단일 화면(§5.1). Q2 결정("환불계좌 입력 UI 필요")을 형식적으로는 만족하나 제품 화면은 아니다 | 사용자에게 "이번엔 데모 수준으로 가고 제품 화면은 네비게이션 도입 후 별건" 확인 권고 |
| **F4** | **수용 기준 "회원·학원 관리자에게 알림 발송"을 Fake로만 만족한다** — 실제 Expo Push는 EAS projectId 미발급으로 불가(`02_..._structure.md` §7.3) | Phase 9는 "발송 호출이 일어남"까지만 검증. 실발송은 별건으로 분리 |
| **F5** | **환불 비율표의 "학원 상세 페이지 노출"(FR-22)이 이번 범위 밖** — `GET /academies/{id}`가 없다(§2.1) | 학원 상세 API 구현 시 응답에 `refund_policy_tiers` 포함 필요. 백로그 기록 |
| **F6** | **결제 생성 경로(`POST /orders`)가 없어 end-to-end 데모 불가**(§2.7) | 예상된 범위 축소. 수용 기준에 위배되지 않으나 시연 기대치 조정 필요 |
| **F7** | **인증이 `X-User-Id` 헤더 임시 구현**(§2.7). 소유권 403 검증은 되지만 위조 가능 | 프로덕션 전 반드시 교체. `app/deps.py:current_user_id` 한 곳만 바꾸면 됨 |
| **F8** | (부수) `mobile/.env`가 14KB, 타 프로젝트 API 키 대량 포함 / `app.json`에 `android.package` 누락 | 범위 밖. 별도 정리 권고 |

**요구사항 ↔ 코드 구조 상충:** 없음. Phase 2 산출물은 계획 수립에 충분하다(추가 탐색 불필요).

---

## 9. 실행 순서 (Phase 4가 그대로 태스크로 변환)

```
T-00 [사용자] Docker 기동                     ← T-12/T-13의 전제. 나머지와 병렬
  │
T-01 메타데이터 배선 + alembic/env.py:35      ← 반드시 최초
  ├── T-02 설정·의존성·REDIS_URL              ┐ 병렬
  └── T-03 db.py                              ┘
  │
T-04 도메인 모델 7개 (+ __init__ re-export)
  ├── T-05 초기 마이그레이션 손작성
  ├── T-06 refund_policy.py + fee_policy.py   ┐ 병렬 (T-04와도 사실상 독립)
  │     └── T-07 산정 단위 테스트  ★지금 실행 가능★
  └── T-08 어댑터 3종 (PG / 알림 / 슬롯락)     ┘
  │
T-09 cancellation.py + deps.py                ← T-04·T-06·T-08 필요
  │
T-10 schemas + routers + main.py include
  │
T-11 conftest.py + DB 통합 테스트 작성 (skip 상태로 초록)
  │
  ├─[Docker 필요]─ T-12 마이그레이션 up/autogenerate-empty/down 검증
  │                  └── T-13 DB 통합 테스트 실행
  │
  ├── T-14 admin-web api/client.ts + .env.example + App.tsx URL 정리   ┐
  ├── T-15 admin-web RefundPolicySettings.tsx                          │ 백엔드와 병렬
  ├── T-16 mobile 취소·환불계좌 화면 (F3)                               │
  └── T-17 docs/payment-method-policy.md 환불 섹션 추가                 ┘
```

**병렬 가능 묶음:** `{T-02, T-03}` / `{T-05, T-06, T-08}` / `{T-14, T-15, T-16, T-17}` — 서로 파일이 겹치지 않는다.
**단, T-14와 T-15는 `App.tsx`를 함께 건드린다** → 순차 실행하거나 한 태스크로 합칠 것.

---

## 10. 위험 요소

| 위험 | 영향 | 완화 |
|---|---|---|
| **되돌리기 어려움 — 최초 마이그레이션** | `down_revision = None`이라 downgrade는 전 테이블 drop. 데이터가 쌓인 뒤 스키마를 바꾸면 되돌리기가 비싸다 | 지금은 **데이터 0건**이므로 스키마를 확정하기 가장 싼 시점이다. Q4/Q5 관련 컬럼을 추측해서 미리 넣지 않는 것(§6)이 이 위험을 줄인다 |
| **`env.py:35`를 빼먹음** | autogenerate가 조용히 빈 마이그레이션 생성 → 테이블 0개인데 성공한 것처럼 보임 | T-01로 강제. T-12의 "autogenerate 빈 diff" 검증이 2차 그물 |
| **VARCHAR+CHECK vs 네이티브 ENUM 선택** | CHECK가 늘면 마이그레이션이 지저분해질 수 있음 | Q4/Q5로 값 집합이 바뀔 게 확실한 상황에선 여전히 CHECK가 유리(D2.4). 값이 안정되면 그때 ENUM 전환 검토 |
| **Fake PG로만 검증** | 실제 PG 연동 시 pending/실패 코드 체계가 달라 서비스 로직이 바뀔 수 있음 | `RefundStatus.pending`을 1급 상태로 미리 모델링(D4)해서 가장 흔한 재설계 원인을 제거. PG사 확정 후 어댑터 1파일 교체가 목표 |
| **동시성 테스트의 신뢰도** | 트랜잭션 롤백 픽스처는 단일 커넥션이라 진짜 동시 2세션을 재현하기 어렵다 | 별도 커넥션 2개를 쓰는 전용 테스트를 `test_cancel_api.py`에 두되 이 테스트만 롤백 픽스처 밖에서 돌리고 명시적으로 정리. **T-13에서 실측 필요 — Docker 전에는 검증 불가** |
| **Redis 락 해제 실패를 삼킴** | 락이 남아 슬롯이 막힐 수 있음 | DB `reserved_count`가 진실이므로 예약 가능 판정은 영향 없음. 락은 TTL로 자연 해제. 경고 로그 필수 |
| **기존 기능 회귀** | `main.py` 수정이 `GET /health`를 깨뜨릴 수 있음 | `tests/test_health.py`를 **손대지 않고** 전 태스크에서 계속 통과시킨다. `include_router` 추가만 하고 기존 데코레이터는 유지 |
| **admin-web 라우터 부재로 화면이 임시 배치** | 화면이 늘면 `App.tsx` 조건부 렌더링이 무너짐 | 이번 화면 1개까지는 감당 가능. 라우터 도입을 백로그로 기록 |
| **인증 임시 구현(F7)** | `X-User-Id` 헤더는 위조 가능 | 프로덕션 배포 전 차단 필요. `app/deps.py` 한 곳에 격리 |

---

## 11. 수용 기준 연결 (Phase 9용)

| 수용 기준 (`01_..._requirements.md` §7) | 담당 태스크 | Docker 없이 검증 가능? |
|---|---|---|
| 취소 API 존재 / 타인 예약 403 | T-10, T-11 | ❌ (T-13) |
| 24h 초과 → 전액 환불 | T-06 | ✅ **T-07** |
| 24h 이내 → 학원 설정 규칙 적용 | T-06, T-04(JSONB), T-15 | ✅ **T-07** |
| 경계값(정확히 24:00:00) 정의·테스트 | T-06 (`h >= 24h` → 100%, D2.2) | ✅ **T-07** |
| 이미 시작/종료/취소된 건 거부 | T-09, T-11 | ❌ (T-13) |
| 슬롯 정원 복구 (FR-42 연계) | T-09(`reserved_count`), T-08(락 해제) | ❌ (T-13) |
| `Refund` 영속화 + 실패 사유 기록 | T-04, T-09 | ❌ (T-13) |
| 회원·학원 관리자 알림 | T-08, T-09 | ✅ Fake 호출 검증 — **F4** |
| 모바일 예상 환불액 사전 고지 | T-10(preview API), T-16 | ✅ (API 단위) / UI는 **F3** |
| **동시 2건 → 환불 1회** | T-04(partial unique), T-09(FOR UPDATE) | ❌ (T-13) |
| 환불액 > 결제액 구조적 불가 | T-04(CHECK), T-06(clamp) | 부분 ✅ (계산은 T-07) |
| 부동소수 미사용 + 반올림 규칙 문서화 | T-06 (bp 정수, ceil, D2.3) | ✅ **T-07** |
| 감사 로그 | T-04(`refund_events`), T-09 | ❌ (T-13) |
| 신규 유료 외부 API 없음 | 전 구간 (redis·pydantic-settings·uvicorn만 추가 — 전부 OSS) | ✅ |
| 정책 문서 반영 | T-17 | ✅ |
| 산정 로직 단위 테스트 통과 | **T-07** | ✅ |
| 취소 API 통합 테스트 통과 | T-13 | ❌ |
| 마이그레이션 up/down 동작 | T-12 | ❌ |
| `GET /health` 및 기존 테스트 유지 | 전 구간 | ✅ |
