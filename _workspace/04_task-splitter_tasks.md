# Phase 4 — Task 분리: 예약 취소 환불 로직

- 작성일: 2026-09-14 / 담당: kdance-task-splitter
- 입력: `_workspace/01_req-analyst_requirements.md` (§9 결정 — Q1~Q5 **전부 확정**), `_workspace/03_impl-planner_plan.md` (§3~§5 변경 파일 목록, §9 실행 순서)
- 이전 태스크 목록: 없음 (`_workspace/04_*` 최초 작성)
- 상태: **Phase 5(구현) 착수 가능.** 진행 가능 태스크 10개, Docker 차단 태스크 2개.

> **도구 관련 고지:** 에이전트 정의는 `TaskCreate`로 공유 작업 목록에 등록하도록 지시하나, **이 세션에는 `TaskCreate`(및 동등한 작업 목록 도구)가 제공되지 않았다** — `ToolSearch`로 확인함. 따라서 **이 파일이 공유 작업 목록 역할을 한다.** 오케스트레이터는 아래 §2 표를 그대로 읽어 Phase 5 에이전트에 배정하면 된다.

---

## 0. 요약

Phase 3의 T-01~T-17(18개, T-00 포함)을 **실행 단위 12개**로 재편했다. 쪼갠 게 아니라 **합쳤다** — Phase 3의 태스크 입도는 파일 단위에 가까워 그대로 팬아웃하면 조율 비용이 이득을 넘어선다.

| 구분 | 개수 | 태스크 ID |
|---|---|---|
| 진행 가능 | **10** | TS-01 ~ TS-10 |
| **Docker 차단** | **2** | **TS-11, TS-12** |
| 사용자 선행 조치(에이전트 태스크 아님) | 1 | TS-00 |

**Docker로 차단된 태스크는 TS-11(마이그레이션 up/down 검증)과 TS-12(DB 통합 테스트 실행) 2개다.** 태스크 자체는 완료 기준까지 정의해 두었으므로 Docker가 뜨면 즉시 실행 가능하다.

**최대 병렬 폭 4.** 실행 웨이브는 6개(§3).

### Phase 3 태스크 → Phase 4 태스크 매핑

| Phase 3 | Phase 4 | 합친 이유 |
|---|---|---|
| T-01 + T-02 + T-03 | **TS-01** | 전부 배선용 소파일이고 루트라 어차피 직렬. 셋으로 쪼개면 에이전트 3회 기동 비용만 든다 |
| T-04 + T-05 | **TS-02** | 모델과 손작성 마이그레이션은 **한 사람이 써야 일치한다**. 분리하면 TS-11의 "autogenerate 빈 diff" 기준이 거의 확실히 깨진다 |
| T-06 + T-07 | **TS-03** | 순수 함수와 그 단위 테스트. 분리 시 인터페이스 왕복이 생긴다 |
| T-08 | TS-04 | 그대로 |
| T-09 | TS-05 | 그대로 |
| T-10 | TS-06 | 그대로 |
| T-11 | TS-07 | 그대로 |
| **T-12** | **TS-11 [차단]** | 그대로 |
| **T-13** | **TS-12 [차단]** | 그대로 |
| T-14 + T-15 | **TS-08** | **둘 다 `App.tsx`를 건드린다.** Phase 3 §9가 직접 "순차 실행하거나 한 태스크로 합칠 것"이라고 지시함 |
| T-16 | TS-09 | 그대로 |
| T-17 | TS-10 | 그대로 |
| T-00 | TS-00 | 사용자 조치 |

---

## 1. Q4/Q5 확정에 따른 Phase 3 계획 보정 (중요)

Phase 3 계획은 **Q4·Q5가 미확정이던 시점에 작성**되어 §6이 "추측하지 않는다 / Phase 4 착수 전 재질의"로 남아 있다. `01_..._requirements.md` §9에서 **둘 다 확정됐다.** Phase 5 구현자가 계획의 옛 서술을 그대로 따르면 틀린 주석을 남기게 되므로 아래로 덮어쓴다.

| 항목 | 확정 내용 | 이번 슬라이스 구현 | 반영 태스크 |
|---|---|---|---|
| PG 건당 수수료 손실 부담자 | **플랫폼 부담** | `PG_FEE_BEARER = "platform"` — **확정값**이지 임시값이 아니다. 환불액 산정에는 미반영(회원 환불액은 손실과 무관) | TS-03 |
| 플랫폼 수수료 8% 환급 | 베타 6개월 면제 중이라 **징수 자체가 없음** → 환급 로직 불필요. 면제 종료 후 재검토 | `PLATFORM_FEE_RATE_BP=800`, `BETA_FEE_WAIVED=True` 상수만. 산정 미반영 | TS-03 |
| 정산 후 환불 회수 | **다음 달 정산에서 차감** | 정산 모듈 자체가 미착수 → **이번 미구현.** `SETTLEMENT_REFUND_RECOVERY = "next_month_deduction"` 상수 + 근거 주석으로 결정을 코드에 남긴다 | TS-03, TS-10 |
| 1+1 쿠폰(FR-33) | **복원한다** (분기말 소멸 규칙 그대로) | `Coupon` 모델이 이번 슬라이스에 없음 → **이번 미구현.** `services/cancellation.py`에 복원 훅 위치를 `# TODO(coupon): Q4 확정 — 취소 시 쿠폰 복원. Coupon 모델 도입 시 여기` 주석으로 고정 | TS-05, TS-10 |
| 부분 취소 | **이번 범위 제외** | Order당 Reservation 1건. 스키마는 이미 1:N이라 마이그레이션 불필요 | TS-02, TS-05 |
| 학원 귀책 취소 | **이번 범위 제외** | `reason` 값 집합에 **`member_request` 하나만.** `academy_fault`를 넣지 않는다 | TS-02, TS-03 |

**Phase 3 §6 서술 중 폐기되는 것:**
- `fee_policy.py` 상단 주석 `# Q4 미확정 — 확정 시 이 파일만 교체` → **`# Q4 확정(2026-09-14, requirements §9). 값 자체는 확정이며 산정 미반영 사유를 각 상수에 주석으로 남긴다`** 로 교체.
- §6 말미 "Phase 4 착수 전 오케스트레이터가 사용자에게 Q4·Q5를 재질의할 것" → **이미 완료.** Phase 3 §8의 플래그 **F2는 종결됐다.**

**살아 있는 플래그:** F1(Docker), F3(mobile 데모 수준), F4(알림 Fake), F5(학원 상세 노출 범위 밖), F6(결제 생성 경로 없음), F7(`X-User-Id` 임시 인증), F8(mobile 위생).

---

## 2. 태스크 목록

> 경로는 전부 `/home/user/kdance/` 기준. **병렬 가능 = 같은 웨이브의 다른 태스크와 동시에 `Agent` 호출해도 파일 충돌이 없다**는 뜻이다.

### TS-00 [사용자 조치 — 에이전트 태스크 아님] Docker 인프라 기동

| | |
|---|---|
| **대상** | `infra/docker-compose.yml` (변경 없음, 기동만) |
| **의존** | 없음 |
| **병렬** | 전 태스크와 병렬 (아무것도 막지 않음) |
| **차단 상태** | 사용자만 해소 가능 — 이 환경에서 `docker` CLI 사용 불가 (WSL 통합 미활성) |

**절차** (Phase 3 §7.2):
```bash
# Docker Desktop → Settings → Resources → WSL Integration 활성화 후
cd /home/user/kdance/infra && docker compose up -d
docker compose ps                                        # db, redis 둘 다 healthy
docker exec kdance-db psql -U kdance -c 'CREATE DATABASE kdance_test;'
```

**완료 기준**
- `ss -ltn`에 5433·6380 개방
- `cd backend && uv run alembic current` 실행 시 연결 오류 없음(리비전 0건이라 빈 출력이 정상)
- `kdance_test` DB 존재

---

### TS-01 기반 배선 — 메타데이터·설정·DB 세션

| | |
|---|---|
| **대상 파일** | `backend/app/models/base.py` [신규] · `backend/app/models/__init__.py` [신규] · `backend/alembic/env.py` [수정 :35] · `backend/pyproject.toml` [수정] · `backend/.env.example` [수정] · `backend/.env` [수정] · `backend/app/config.py` [신규] · `backend/app/db.py` [신규] |
| **의존** | 없음 (**루트 태스크**) |
| **병렬** | TS-08 · TS-09 · TS-10과 병렬 가능 (backend 파일을 아무도 안 건드림) |
| **Docker** | 불필요 — 엔진 생성은 lazy, 실제 연결 없음 |

**해야 할 일**
1. `models/base.py`: `class Base(DeclarativeBase)` + `TimestampMixin`(`created_at`/`updated_at`, `server_default=func.now()`)
2. `models/__init__.py`: `Base` re-export (모델은 TS-02가 추가)
3. `alembic/env.py:35` `target_metadata = None` → `from app.models import Base` / `target_metadata = Base.metadata`
4. `pyproject.toml`: deps에 `redis`·`pydantic-settings`, dev에 `uvicorn` 추가. `[tool.pytest.ini_options]` 신설 — `markers = ["requires_db: DB 연결이 필요한 테스트"]`, `testpaths = ["tests"]`
5. `.env.example` + `.env`: `REDIS_URL=redis://localhost:6380/0` (표준 6379 아님), `TEST_DATABASE_URL=postgresql+psycopg://kdance:kdance@localhost:5433/kdance_test`
6. `config.py`: pydantic-settings `Settings`(`database_url`, `redis_url`, `test_database_url`) + `get_settings()` lru_cache
7. `db.py`: 동기 `create_engine`(psycopg3), `SessionLocal`, `get_db()` yield 의존성

**완료 기준**
- `cd backend && uv run python -c "from app.models import Base; print(Base.metadata)"` 성공
- `cd backend && uv run python -c "from app.db import get_db, SessionLocal"` 성공 (연결 시도 없이)
- `cd backend && uv run pytest` 초록 (`tests/test_health.py` 통과 유지)
- `alembic/env.py`에 `target_metadata = Base.metadata`가 실제로 들어감 — **이걸 빼먹으면 autogenerate가 조용히 빈 마이그레이션을 뱉는다**

---

### TS-02 도메인 모델 7개 + 초기 마이그레이션 손작성

| | |
|---|---|
| **대상 파일** | `backend/app/models/academy.py` · `class_schedule.py` · `order.py` · `payment.py` · `reservation.py` · `refund.py` · `refund_event.py` [전부 신규] · `backend/app/models/__init__.py` [수정 — re-export 확장] · `backend/alembic/versions/0001_initial_domain.py` [신규] |
| **의존** | **TS-01** |
| **병렬** | **TS-03 · TS-04와 병렬 가능** (파일 겹침 없음) |
| **Docker** | 불필요 — 선언과 파일 작성만. 적용 검증은 TS-11 |

**해야 할 일**
- 모델 7개 (Phase 3 §3 #9~#15 명세대로). 모든 시각 컬럼은 `TIMESTAMP WITH TIME ZONE`, 금액은 정수(원)
- **상태/구분 컬럼은 PG 네이티브 ENUM이 아니라 `String` + `CHECK (col IN (...))`** (Phase 3 D2.4)
- `academies.refund_policy_tiers` JSONB, 기본값 `[]`
- `class_schedules`: `capacity`, `reserved_count` + `CHECK (reserved_count >= 0 AND reserved_count <= capacity)`
- `refunds`: `idempotency_key` UNIQUE + **partial unique index `UNIQUE (reservation_id) WHERE status <> 'failed'`**
- `refund_events`: append-only 감사 로그
- `models/__init__.py`에 **7개 전부 re-export** — 빠뜨리면 autogenerate가 그 테이블을 조용히 누락한다
- `0001_initial_domain.py`: `down_revision = None`, upgrade/downgrade **양방향** 손작성. partial unique index·모든 CHECK·JSONB 기본값 포함

**완료 기준**
- `cd backend && uv run python -c "from app.models import Base; print(sorted(Base.metadata.tables))"` → 7개 테이블 전부 출력
- `0001_initial_domain.py`의 `downgrade()`가 upgrade에서 만든 **모든** 객체를 역순으로 제거 (인덱스·제약 포함)
- §4 공유 계약의 값 집합과 CHECK 제약이 문자 단위로 일치
- `cd backend && uv run pytest` 여전히 초록
- **실제 DB 적용 여부는 이 태스크의 완료 기준이 아니다 — TS-11 소관**

---

### TS-03 환불액 산정 순수 함수 + 수수료 정책 + 단위 테스트 [검증 핵심]

| | |
|---|---|
| **대상 파일** | `backend/app/services/refund_policy.py` [신규] · `backend/app/services/fee_policy.py` [신규] · `backend/tests/test_refund_policy.py` [신규] |
| **의존** | **TS-01** (`app` 패키지 골격) — **TS-02와는 무관** |
| **병렬** | **TS-02 · TS-04와 병렬 가능** |
| **Docker** | **불필요. 이 태스크는 지금 실제로 실행해서 통과시킬 수 있다 — 이번 작업 검증의 중심이다** |

**해야 할 일**
- `calculate_refund(paid_amount: int, starts_at: datetime, now: datetime, tiers: list[dict], reason: CancellationReason) -> RefundCalculation`. **DB·IO 의존 0.** `now`를 **반드시 파라미터로 주입** — 함수 안에서 `datetime.now()`를 부르면 경계값 테스트가 불가능해진다
- 티어 해석 규칙: `h >= 24h`면 100%(플랫폼 고정, 티어 무관) / `h < 24h`면 `h <= tier.hours_before_start`를 만족하는 티어 중 **`hours_before_start`가 최소**인 것 / 없으면 0%
- 반올림 **올림(ceil)**, 정수 연산 `-(-paid_amount * rate_bp // 10000)`. **부동소수 사용 금지**
- 결과를 `paid_amount`로 **clamp** (환불액 > 결제액 구조적 불가 — DB CHECK와 이중 방어)
- `fee_policy.py`: §1 표의 **확정값** 4개 상수 + 각 상수에 "왜 산정에 반영하지 않는가"를 주석으로. 파일 상단 주석은 `# Q4 확정(2026-09-14)` — **`미확정`이라고 쓰지 말 것**
- `test_refund_policy.py`: 경계 파라미터라이즈(**23:59:59 / 24:00:00 / 24:00:01**), 티어 해석, 빈 티어, 순서 뒤섞인 티어, 올림 1원 케이스, bp 0/10000, `paid_amount=0`

**완료 기준**
- `cd backend && uv run pytest tests/test_refund_policy.py -v` → **skip 없이 전부 통과**
- 24:00:00 정각이 **100% 환불**로 단정되는 테스트가 존재 (Phase 3 D2.2 결정)
- `grep -n "float\|/ 100\|round(" backend/app/services/refund_policy.py` → 금액 계산 경로에 히트 0
- `cd backend && uv run pytest` 전체 초록

---

### TS-04 어댑터 3종 — PG / 알림 / 슬롯 락

| | |
|---|---|
| **대상 파일** | `backend/app/adapters/payment_gateway.py` [신규] · `backend/app/adapters/notification.py` [신규] · `backend/app/adapters/slot_lock.py` [신규] (+ `backend/app/adapters/__init__.py`) |
| **의존** | **TS-01** (`config.get_settings().redis_url`) |
| **병렬** | **TS-02 · TS-03과 병렬 가능** |
| **Docker** | 불필요 — Fake는 인메모리, `slot_lock`은 연결 실패 시 no-op |

**해야 할 일**
- `PaymentGateway` Protocol: `refund(request: RefundRequest) -> RefundResult` **단일 메서드** (카드/가상계좌로 쪼개지 않는다 — PG사 미선정, Phase 3 D4)
- `RefundStatus`에 **`pending`을 1급 상태로** 포함 — 가상계좌 환불은 즉시 완료되지 않는다. `bool` 반환으로 설계하면 나중에 서비스·모델·API가 전부 바뀐다
- `method == card` → `UnsupportedPaymentMethodError` (Q2상 범위 밖. **조용히 잘못된 경로로 흐르는 것보다 눈에 보이는 구멍이 낫다**)
- `FakePaymentGateway`: 인메모리 원장, 결정적 동작, `fail_on={payment_key}` 실패 주입, pending 강제 옵션
- `NotificationSender` Protocol + `FakeNotificationSender`(호출 기록만). **회원·학원 관리자 2방향**
- `slot_lock.py`: 키 네임스페이스 **`kdance:slot:{schedule_id}` 고정**. **Redis 연결 실패가 예외를 밖으로 던지지 않는다** — 경고 로그 + no-op. 금전 트랜잭션이 캐시 장애로 롤백되는 게 훨씬 나쁘다

**완료 기준**
- Redis 미기동 상태에서 `from app.adapters.slot_lock import ...` 및 해제 호출이 **예외 없이** 반환
- `FakePaymentGateway`로 succeeded / pending / failed 3가지 결과를 각각 만들어내는 단위 테스트 통과
- `method=card` 호출이 `UnsupportedPaymentMethodError`를 던지는 테스트 통과
- `cd backend && uv run pytest` 전체 초록

---

### TS-05 취소 오케스트레이션 서비스 + 의존성 주입

| | |
|---|---|
| **대상 파일** | `backend/app/services/cancellation.py` [신규] · `backend/app/deps.py` [신규] |
| **의존** | **TS-02, TS-03, TS-04** (셋 다 필요) |
| **병렬** | 불가 — 합류 지점 |
| **Docker** | 불필요 (코드 작성. 실동작 검증은 TS-12) |

**해야 할 일**
- 순서: `SELECT ... FOR UPDATE`로 `reservations` 행 잠금 → 소유권 검증(타인 403) → 상태 전이 검증(이미 취소·이미 시작·종료 거부) → 환불액 산정(TS-03 호출) → `Refund` INSERT(멱등) → PG 호출(TS-04) → `reserved_count -= 1` → `refund_events` INSERT → 알림 2방향
- **IntegrityError(유니크 위반) 시 기존 `Refund` 행을 조회해 HTTP 409가 아니라 200으로 기존 결과를 반환.** 수용 기준은 "환불은 1회만 실행된다"이지 "두 번째 요청이 에러난다"가 아니다
- `Idempotency-Key` 헤더가 없으면 `sha256("cancel:" + reservation_id)`로 **결정적 키 생성** — 헤더를 안 보내도 이중 환불 불가
- 쿠폰 복원 훅 위치를 주석으로 고정 (§1 — Q4 확정이나 `Coupon` 모델 부재로 이번 미구현)
- `deps.py`: `current_user_id`(**임시 — `X-User-Id` 헤더. 위조 가능. 프로덕션 전 교체 필수라는 주석 필수 — F7**), `get_payment_gateway`, `get_notification_sender`, `get_slot_lock`

**완료 기준**
- 서비스가 `PaymentGateway`/`NotificationSender`/`SlotLock`을 **구상 클래스가 아니라 Protocol로** 받는다 (`grep -n "FakePaymentGateway" backend/app/services/cancellation.py` → 히트 0)
- `deps.py`의 임시 인증에 F7 주석이 실재
- 슬롯 락 해제 실패가 환불 트랜잭션을 롤백시키지 않는 경로가 코드상 확인 가능
- `cd backend && uv run pytest` 전체 초록

---

### TS-06 Pydantic 스키마 + 라우터 + main.py 배선

| | |
|---|---|
| **대상 파일** | `backend/app/schemas/cancellation.py` [신규] · `backend/app/schemas/academy.py` [신규] · `backend/app/routers/reservations.py` [신규] · `backend/app/routers/admin_academies.py` [신규] · `backend/app/main.py` [수정] |
| **의존** | **TS-05** |
| **병렬** | 불가 |
| **Docker** | 불필요 |

**해야 할 일**
- `CancelRequest`: `refund_account`(bank_code/account_number/holder_name) — **`method == virtual_account`면 필수**를 `model_validator`로. 검증은 어댑터가 아니라 **스키마 계층**에 둔다(PG를 갈아끼워도 살아남게)
- `CancelResponse`, `CancellationPreview`
- `RefundPolicyTier`(`hours_before_start` 1~720, `refund_rate_bp` 0~10000) + `RefundPolicyUpdate`(정렬·중복 검증) — **JSONB는 DB가 구조를 검증해주지 않으므로 쓰기 경로에서 반드시 막는다**
- `POST /reservations/{id}/cancel`, `GET /reservations/{id}/cancellation-preview`
- `GET·PUT /admin/academies/{id}/refund-policy`
- `main.py`: `include_router` 2줄 + CORS(admin-web `http://localhost:5173`). **기존 `GET /health` 데코레이터는 손대지 않는다**

**완료 기준**
- `cd backend && uv run pytest tests/test_health.py` 통과 — **회귀 없음**
- `cd backend && uv run python -c "from app.main import app; print([r.path for r in app.routes])"` → 4개 신규 경로 + `/health` 출력
- `refund_account` 누락 시 422를 내는 스키마 단위 테스트 통과 (DB 불필요)
- `cd backend && uv run pytest` 전체 초록

---

### TS-07 테스트 하네스 + DB 통합 테스트 **작성**

| | |
|---|---|
| **대상 파일** | `backend/tests/conftest.py` [신규] · `backend/tests/test_cancel_api.py` [신규] · `backend/tests/test_admin_refund_policy.py` [신규] |
| **의존** | **TS-06** |
| **병렬** | 불가 |
| **Docker** | **작성은 불필요.** 실행이 TS-12 |

**해야 할 일**
- 세션 스코프 엔진 → `TEST_DATABASE_URL`, 스키마는 `Base.metadata.create_all()`
- 함수 스코프: 커넥션 → 바깥 트랜잭션 → `Session(bind=connection, join_transaction_mode="create_savepoint")` → 종료 시 rollback. **`join_transaction_mode="create_savepoint"`가 핵심** — 서비스가 내부에서 `session.commit()`을 불러도 격리가 깨지지 않는다
- `app.dependency_overrides[get_db]` + Fake 어댑터 주입
- **DB 미가용 시 `requires_db` 마커 테스트를 skip하는 훅** (에러 아님)
- `test_cancel_api.py`: 정상 / 타인 403 / 404 / 이미 취소 / 이미 시작 / **동시 2건 중복 요청** / PG 실패 시 상태·사유 기록 / `reserved_count` 복구
- 동시성 테스트는 **별도 커넥션 2개**를 쓰므로 롤백 픽스처 밖에서 돌리고 명시적으로 정리
- `test_admin_refund_policy.py`: 비율표 CRUD + 검증 실패 케이스

**완료 기준**
- **Docker 없이** `cd backend && uv run pytest`가 **초록** — DB 테스트는 `skipped`, 나머지는 `passed`. `error`가 하나도 없어야 한다
- `uv run pytest -m requires_db --collect-only` → 대상 테스트가 전부 수집됨
- 동시성 테스트가 단일 커넥션 픽스처에 의존하지 않음이 코드상 확인 가능

---

### TS-08 admin-web — API 클라이언트 + 환불 비율표 설정 화면

| | |
|---|---|
| **대상 파일** | `admin-web/src/api/client.ts` [신규] · `admin-web/.env.example` [신규] · `admin-web/src/App.tsx` [수정] · `admin-web/src/pages/RefundPolicySettings.tsx` [신규] |
| **의존** | 없음 (API 계약은 §4에 고정 — 백엔드 완성을 기다리지 않는다) |
| **병렬** | **TS-01~TS-07 전부와 병렬 가능** |
| **Docker** | 불필요 |

**T-14와 T-15를 합친 이유:** 둘 다 `App.tsx`를 수정한다. 병렬로 띄우면 같은 파일에 동시 편집이 일어난다. Phase 3 §9가 직접 합치라고 지시했다.

**해야 할 일**
- `client.ts`: `API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"` + 얇은 fetch 래퍼
- `.env.example`: `VITE_API_BASE_URL=http://localhost:8000`
- `App.tsx:7`의 **하드코딩 URL 제거** → client.ts 경유 + 탭 조건부 렌더링
- `RefundPolicySettings.tsx`: 티어 행 추가/삭제, bp 입력, 저장. **순수 CSS + `useState`** — 라우터·상태관리 라이브러리 도입 금지(런타임 의존성은 react/react-dom 둘뿐이어야 한다)

**완료 기준**
- `cd admin-web && npm run build` 성공 (타입 에러 0)
- `grep -rn "localhost:8000" admin-web/src/` → `api/client.ts` 한 곳에만 히트
- `package.json`의 `dependencies`가 여전히 react/react-dom 둘뿐

---

### TS-09 mobile — 취소 확인 + 환불계좌 입력 화면 (데모 수준, F3)

| | |
|---|---|
| **대상 파일** | `mobile/App.tsx` [수정] · `mobile/.env.example` [신규] |
| **의존** | 없음 |
| **병렬** | **전 태스크와 병렬 가능** |
| **Docker** | 불필요 |

**해야 할 일**
- 취소 확인 화면 — **예상 환불액 사전 고지**(`GET /reservations/{id}/cancellation-preview` 호출). 약관 동의를 받는 이상 필수
- 가상계좌 환불계좌 입력 폼(은행/계좌번호/예금주)
- 네비게이션 라이브러리 없이 **단일 화면 상태 전환**
- `.env.example`: `EXPO_PUBLIC_API_URL=http://localhost:8000`

**범위 밖 (건드리지 말 것):** `expo-notifications` 설치(EAS projectId 미발급), `app.json`의 `android.package` 누락, `mobile/.env` 위생 문제 — 전부 별건 권고 항목이다.

**완료 기준**
- `cd mobile && npx tsc --noEmit` 통과
- 새 npm 의존성 **0개** (네비게이션 라이브러리 도입 금지)
- 취소 확정 버튼을 누르기 **전에** 예상 환불액이 화면에 표시되는 경로가 존재
- 이 화면이 데모 수준임을 코드 주석에 명시 (F3)

---

### TS-10 정책 문서에 환불 규칙 반영

| | |
|---|---|
| **대상 파일** | `docs/payment-method-policy.md` [수정 — 환불 섹션 추가] |
| **의존** | 없음 |
| **병렬** | **전 태스크와 병렬 가능** |
| **Docker** | 불필요 |

**해야 할 일** — 수용 기준 "이번에 새로 결정된 사항은 해당 정책 문서에 반영된다"를 충족시킨다. 문서화 대상:
- 24h 경계 규칙과 **정각 24:00:00은 전액 환불** 결정 + 근거
- 학원별 환불 비율표(basis point 정수, 티어 해석 규칙) — Q3 (a)안
- 가상계좌 환불 = 별도 송금이므로 환불계좌 수집이 필요하다는 점, `pending`이 정상 상태라는 점
- **Q4 확정 사항 4건** (§1 표): PG 수수료 손실 플랫폼 부담 / 정산 후 환불은 다음 달 차감 / 1+1 쿠폰 복원 / 8% 수수료는 베타 면제 중이라 환급 대상 아님
- **Q5 범위 제외 2건**: 부분 취소·학원 귀책 취소는 이번 범위 아님
- 반올림 = **올림(ceil)**, 금액은 정수(원), 부동소수 미사용

**완료 기준**
- 위 6개 항목이 전부 문서에 존재
- `docs/pricing-policy.md`와 모순 없음 (쿠폰 차액 업주 부담 서술과 충돌하지 않는지 확인)
- **미구현 항목(쿠폰 복원·정산 차감)은 "결정됐으나 이번 슬라이스 미구현"으로 명시** — 결정과 구현을 혼동하게 쓰지 말 것

---

### TS-11 [**Docker 차단**] 마이그레이션 up / autogenerate-빈diff / down 검증

| | |
|---|---|
| **대상 파일** | `backend/alembic/versions/0001_initial_domain.py` (수정 가능성 있음 — 불일치 발견 시) |
| **의존** | **TS-02** + **TS-00(Docker)** |
| **병렬** | TS-12 앞에서만 직렬. TS-05~TS-10과는 병렬 가능 |
| **차단 사유** | `alembic upgrade head` / `downgrade base` / `--autogenerate` **전부 실제 DB 연결을 요구**한다 |

**절차** (Phase 3 §7.4)
```bash
cd /home/user/kdance/backend
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "verify"   # 생성 파일의 upgrade/downgrade가 pass여야 정합
uv run alembic downgrade base && uv run alembic upgrade head
# 확인 후 verify 리비전 파일 삭제
```

**완료 기준**
- `upgrade head` 성공, 테이블 7개 생성
- **`--autogenerate`가 빈 diff를 뱉는다** — 손작성 마이그레이션이 모델과 일치한다는 증거. 빈 diff가 아니면 마이그레이션을 고치고 재검증
- `downgrade base` 성공 후 잔여 테이블·인덱스 0
- 재`upgrade head` 성공
- verify 리비전 파일 삭제됨 (`backend/alembic/versions/`에 `0001_*` 하나만 남음)

**미해소 시 Phase 9 처리:** 수용 기준 "Alembic 마이그레이션 up/down 정상 동작"을 **미검증**으로 표기. 통과했다고 쓰지 말 것.

---

### TS-12 [**Docker 차단**] DB 통합 테스트 실행

| | |
|---|---|
| **대상 파일** | 실행만 (실패 시 `backend/tests/*`·구현 코드 수정) |
| **의존** | **TS-07, TS-11** + **TS-00(Docker)** |
| **병렬** | 불가 — 마지막 |
| **차단 사유** | `requires_db` 테스트 전체가 실제 Postgres를 요구 |

**절차**
```bash
cd /home/user/kdance/backend && uv run pytest -v        # skip 0건이어야 함
```

**완료 기준**
- `uv run pytest` 실행 시 **skip 0건, 실패 0건**
- 다음 케이스가 실제로 통과: 정상 취소 / 타인 403 / 404 / 이미 취소·이미 시작 거부 / **동시 2건 → 환불 1회** / PG 실패 시 상태·사유 기록 / `reserved_count` 복구 / 감사 로그 INSERT
- 환불 비율표 CRUD + 검증 실패 케이스 통과

**미해소 시 Phase 9 처리:** "취소 API 통합 테스트 통과", "동시 2건 요청 시 환불 1회"를 **미검증**으로 표기.

---

## 3. 실행 웨이브 — 오케스트레이터 팬아웃 지침

```
[즉시 시작 가능]
  W1 ────────────────────────────────────────────────
    TS-01 기반 배선            ┐
    TS-08 admin-web            │  4개 동시 Agent 호출
    TS-09 mobile               │  (최대 병렬 폭 4)
    TS-10 docs                 ┘
    TS-00 Docker 기동 [사용자]  ← 어느 웨이브와도 병렬

  W2 ──── TS-01 완료 후 ──────────────────────────────
    TS-02 모델 + 마이그레이션   ┐
    TS-03 산정 함수 + 단위테스트 │  3개 동시 호출
    TS-04 어댑터 3종            ┘

  W3 ──── TS-02·03·04 전부 완료 후 ───────────────────
    TS-05 취소 서비스 + deps          (단독)

  W4 ──── TS-05 완료 후 ──────────────────────────────
    TS-06 스키마 + 라우터 + main      (단독)

  W5 ──── TS-06 완료 후 ──────────────────────────────
    TS-07 conftest + DB테스트 작성    (단독)

  WB ──── [Docker 해소 후에만] ───────────────────────
    TS-11 마이그레이션 검증  →  TS-12 통합 테스트 실행
```

### 파일 충돌 검증 (병렬 안전성 근거)

| 웨이브 | 동시 실행 태스크 | 겹치는 파일 |
|---|---|---|
| W1 | TS-01 / TS-08 / TS-09 / TS-10 | **없음** — backend / admin-web / mobile / docs 로 완전 분리 |
| W2 | TS-02 / TS-03 / TS-04 | **없음** — `models/*`+`versions/*` / `services/refund_policy·fee_policy` / `adapters/*` |

- `app/models/__init__.py`는 TS-01이 만들고 TS-02가 확장 — **직렬 의존이라 안전**
- `App.tsx`는 TS-08 단독 소유 (T-14/T-15를 합친 이유)
- `main.py`는 TS-06 단독 소유
- `backend/tests/`는 TS-03(`test_refund_policy.py`)과 TS-07(나머지)이 **다른 파일**을 쓴다. 단 `conftest.py`는 TS-07 소유이므로 **TS-03은 `conftest.py`를 만들지 않는다** (순수 함수 테스트라 픽스처 불필요)

### 실패 시 파급

| 실패 태스크 | 막히는 후속 |
|---|---|
| TS-01 | TS-02·03·04·05·06·07 (backend 전부) |
| TS-02 | TS-05·06·07·11·12 |
| TS-03 | TS-05 이후 전부 + **수용 기준 4건이 미검증으로 남는다** (24h 전액/24h 이내/경계값/부동소수) |
| TS-04 | TS-05 이후 전부 |
| TS-08·09·10 | 없음 (리프) |

---

## 4. 공유 계약 — 병렬 태스크 간 합의사항 (반드시 지킬 것)

> W2에서 TS-02·TS-03·TS-04가 **동시에** 값 집합과 시그니처를 정의한다. 여기서 어긋나면 TS-05에서 합류할 때 깨진다. 아래는 **협상 불가 고정값**이다.

### 4.1 상태·구분 값 집합 (VARCHAR + CHECK)

| 컬럼 | 허용 값 | 소유 태스크 | 참조 태스크 |
|---|---|---|---|
| `reservations.status` | `held`, `confirmed`, `cancelled` | TS-02 | TS-05 |
| `orders.status` | `pending`, `paid`, `refunded` | TS-02 | TS-05 |
| `payments.method` | `virtual_account`, `card` | TS-02 | TS-04, TS-06 |
| `refunds.status` | `succeeded`, `pending`, `failed` | TS-02 | **TS-04가 `RefundStatus` StrEnum으로 동일 값 선언** |
| `refunds.reason` | **`member_request` 하나만** | TS-02 | **TS-03이 `CancellationReason` StrEnum으로 동일 값 선언** |

- `academy_fault`를 **넣지 않는다** (Q5 확정 — 이번 범위 제외). 나중에 추가할 땐 CHECK 제약 변경 마이그레이션 1건이면 된다
- `refunds`의 partial unique index는 **`WHERE status <> 'failed'`** — 위 `refunds.status` 값 집합에 정확히 의존한다

### 4.2 Python enum 소유권 (순환 import 방지)

- `RefundStatus` → **`app/adapters/payment_gateway.py`가 소유** (TS-04). 서비스·라우터가 여기서 import
- `CancellationReason` → **`app/services/refund_policy.py`가 소유** (TS-03)
- **모델(TS-02)은 이 둘을 import하지 않는다.** CHECK 제약에 문자열 리터럴을 직접 쓴다 — models가 services/adapters를 import하면 계층이 역전된다. 값 일치는 위 4.1 표로 보장하고, TS-12의 통합 테스트가 실측한다

### 4.3 산정 함수 시그니처 (TS-03 확정 → TS-05가 호출)

```
calculate_refund(
    paid_amount: int,
    starts_at: datetime,        # tz-aware UTC
    now: datetime,              # tz-aware UTC. 반드시 주입
    tiers: list[dict],          # academies.refund_policy_tiers 원본 그대로
    reason: CancellationReason,
) -> RefundCalculation          # refund_amount: int, refund_rate_bp: int, hours_before_start: ...
```

### 4.4 환불 비율표 JSONB 형태 (TS-02 / TS-06 / TS-08이 공유)

```json
[{"hours_before_start": 24, "refund_rate_bp": 5000},
 {"hours_before_start": 12, "refund_rate_bp": 0}]
```

`refund_rate_bp`는 **basis point 정수 0~10000**. 퍼센트나 float를 쓰면 "부동소수 미사용" 수용 기준이 깨진다.

### 4.5 API 계약 (TS-06 확정 → TS-08 / TS-09가 선행 구현)

| 메서드 | 경로 | 소유 | 소비 |
|---|---|---|---|
| POST | `/reservations/{id}/cancel` | TS-06 | TS-09 |
| GET | `/reservations/{id}/cancellation-preview` | TS-06 | TS-09 |
| GET·PUT | `/admin/academies/{id}/refund-policy` | TS-06 | TS-08 |

인증은 임시로 **`X-User-Id` 헤더** (F7). 멱등성은 **`Idempotency-Key` 헤더(선택)** — 없으면 서버가 결정적으로 생성한다.

---

## 5. 분해 불가 항목

**없다.** Phase 3 §3~§5의 변경 파일 39개가 전부 파일 경로와 변경 내용까지 특정돼 있어 태스크 경계를 긋는 데 모호함이 없었다. "Phase 3 재검토 필요"로 넘길 항목은 발생하지 않았다.

다만 **계획 자체의 결함은 아니나 Phase 5 구현자가 걸려 넘어질 지점** 2건을 §4에 계약으로 못박았다:
1. 병렬 태스크 3개가 같은 값 집합(`RefundStatus`, `CancellationReason`)을 각자 선언한다 → §4.1·4.2
2. Phase 3 계획이 Q4 미확정 시점에 작성돼 `fee_policy.py` 주석 지시가 현재 사실과 어긋난다 → §1

---

## 6. Phase 9(완료 검증)용 체크리스트 — 태스크 ↔ 수용 기준

| 수용 기준 (`01_..._requirements.md` §7) | 검증 태스크 | Docker 없이 검증 가능 |
|---|---|---|
| 취소 API 존재 / 타인 예약 403 | TS-06, TS-12 | 불가 |
| 24h 초과 → 전액 환불 | **TS-03** | **가능** |
| 24h 이내 → 학원 설정 규칙 적용 | **TS-03**, TS-02, TS-08 | **가능** |
| 경계값(정확히 24:00:00) 정의·테스트 | **TS-03** | **가능** |
| 이미 시작/종료/취소된 건 거부 | TS-05, TS-12 | 불가 |
| 슬롯 정원 복구 | TS-05, TS-04, TS-12 | 불가 |
| `Refund` 영속화 + 실패 사유 기록 | TS-02, TS-05, TS-12 | 불가 |
| 회원·학원 관리자 알림 | TS-04, TS-05 | 가능 (Fake 호출까지만 — **F4**) |
| 모바일 예상 환불액 사전 고지 | TS-06(preview API), TS-09 | 가능 (API 단위) / UI는 **F3** |
| 동시 2건 → 환불 1회 | TS-02(partial unique), TS-05(FOR UPDATE), **TS-12** | 불가 |
| 환불액 > 결제액 구조적 불가 | TS-02(CHECK), **TS-03**(clamp) | 부분 가능 (계산은 TS-03) |
| 부동소수 미사용 + 반올림 규칙 문서화 | **TS-03**, TS-10 | **가능** |
| 감사 로그 | TS-02, TS-05, TS-12 | 불가 |
| 신규 유료 외부 API 없음 | TS-01 (redis·pydantic-settings·uvicorn만, 전부 OSS) | **가능** |
| 정책 문서 반영 | **TS-10** | **가능** |
| 산정 로직 단위 테스트 통과 | **TS-03** | **가능** |
| 취소 API 통합 테스트 통과 | **TS-12** | 불가 |
| 마이그레이션 up/down 동작 | **TS-11** | 불가 |
| `GET /health` 및 기존 테스트 유지 | 전 태스크 | **가능** |

**Docker 미해소 시 Phase 9가 "미검증"으로 남겨야 하는 수용 기준은 8건이다** (위 표의 "불가" 행). 통과했다고 기록해선 안 된다.
