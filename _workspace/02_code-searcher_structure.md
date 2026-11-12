# Phase 2(기존 코드 구조 확인) — US1(수업 찾아 결제) + 취소·환불 이관

- 작성 2026-11-06 · 입력 `_workspace/01_req-analyst_requirements.md`(「사용자 결정」 절 포함)
- 코드는 읽기만 했다. 실행한 것은 읽기 전용 명령뿐이다 — `pytest --collect-only`, `prisma <cmd> --help`, `npm view`, `npm ls`, `node -p`(설치 버전 읽기), `docker ps`
- 줄번호는 2026-11-06 작업 트리 기준이다. 표기 `파일:줄`
- 사용자 결정 반영: Q3(전환 범위) = **기존 7테이블 + DB 테스트 27개까지 Prisma 로 이관**, Q4(시드 수업 종류) = **정규 수업(기간 신청) 1건**, Q2(가입·로그인 방식) = 시드 로그인 + 가짜 본인확인

---

## 0. 한눈에 보기

| 영역 | 현재 상태 | 이관·신규 판단에 미치는 영향 |
|---|---|---|
| backend | 테이블 7개 · ORM 모델 7개 · Alembic 리비전 1개 · API 3개(+`/health`) · 서비스 3개 · 어댑터 3종 · 테스트 186개(DB 27) | 옮길 비즈니스 로직의 핵심은 `services/cancellation.py`(1069줄) 하나 |
| admin-web | Route Handler **0개**(`app/api/` 없음) · Prisma 스키마·config·마이그레이션 **0개** · 테스트 러너 **없음** | 제품 API 는 전부 새로 짓는다 |
| Prisma 8 | `prisma` 8.0.0-rc.15 · `@prisma/orm-postgres` 8.0.0-rc.11. 마이그레이션 명령은 `migration plan` → `db migrate` | Prisma 7 이하와 명령·API 가 다르다(§B-5) |
| better-auth | 1.7.5. 내장 prisma 어댑터는 Prisma 5~7 클라이언트 API(`$transaction`·`findFirst`)를 쓴다 | Prisma 8 façade 와 그대로는 안 붙는다. Kysely 어댑터 경로가 남는다(§B-6) |
| mobile | `App.tsx` 1개(500줄). 라우터 없음. FastAPI 취소 API 를 직접 `fetch` | 화면 8종은 새로 짓는다. 기존 취소 화면은 API 주소가 바뀐다 |
| DB | `docker` 명령 자체가 없다(Docker Desktop 꺼짐) | DB 기동 상태, `alembic_version` 존재 여부는 **미확인** |

---

## A. backend/ (FastAPI, 이관 대상)

### A-1. 테이블 7개 — SQLAlchemy 모델 · 컬럼 · 제약

원본은 마이그레이션 `backend/alembic/versions/0001_initial_domain.py` 이다. 모델은 `backend/app/models/*.py` 에 같은 내용이 있다.
공통 사항은 아래 넷이다.
- PK 는 전부 `UUID`(`postgresql.UUID(as_uuid=True)`)다. 기본값은 **DB 가 아니라 Python 쪽** `default=uuid.uuid4` 에서 정한다(`models/academy.py:37-41`). DB 에 서버 기본값은 없다
- 상태값 컬럼은 **PG 네이티브 ENUM 이 아니라 `VARCHAR + CHECK`** 다(`0001_initial_domain.py:9-10` 설계 메모)
- `created_at`·`updated_at` 은 `timestamptz` + `server_default now()` 다. `updated_at` 갱신은 **ORM `onupdate`** 가 맡고 DB 트리거는 없다(`models/base.py:29-42`)
- 금액은 전부 `Integer`(int4), 원 단위다

| 테이블(모델 파일) | 컬럼 | 제약·인덱스·FK | 마이그레이션 줄 |
|---|---|---|---|
| `academies` (`models/academy.py:24`) | id, name `varchar(200)`, `refund_policy_tiers jsonb default '[]'`, created_at, updated_at | PK | 49-74 |
| `orders` (`models/order.py:21`) | id, user_id `uuid`, status `varchar(32)`, total_amount int, ts | `ck_orders_status`: `status IN ('pending','paid','refunded')` · `ck_orders_total_amount >= 0` · `ix_orders_user_id` | 76-101 |
| `class_schedules` (`models/class_schedule.py:27`) | id, academy_id, starts_at `timestamptz`, price_amount int, capacity int, reserved_count int default 0, ts | `ck_..._price_amount >= 0` · `ck_..._capacity > 0` · `ck_class_schedules_reserved_count`: `reserved_count >= 0 AND reserved_count <= capacity` · FK academy_id→academies **CASCADE** · `ix_class_schedules_academy_id` | 104-149 |
| `payments` (`models/payment.py:24`) | id, order_id, method `varchar(32)`, amount int, paid_at `timestamptz NULL`, gateway_payment_key `varchar(200) NULL`, ts | `ck_payments_method`: `method IN ('virtual_account','card')` · `amount >= 0` · FK order_id→orders CASCADE · `ix_payments_order_id` | 152-185 |
| `reservations` (`models/reservation.py:24`) | id, order_id, class_schedule_id, user_id `uuid`, status `varchar(32)`, cancelled_at NULL, ts | `ck_reservations_status`: `status IN ('held','confirmed','cancelled')` · FK order_id→orders CASCADE · FK class_schedule_id→class_schedules CASCADE · 인덱스 3개(order_id, class_schedule_id, user_id) | 188-233 |
| `refunds` (`models/refund.py:37`) | id, reservation_id, payment_id, idempotency_key `varchar(200)`, requested_amount, refunded_amount default 0, refund_rate_bp, status, reason, refund_account_bank_code/number/holder_name(NULL), gateway_refund_id, failure_code, failure_message, ts | `status IN ('succeeded','pending','failed')` · `reason IN ('member_request')` · 금액 2종 `>= 0` · `refunded_amount <= requested_amount` · `refund_rate_bp` 0~10000 · FK 2개 CASCADE · **UNIQUE idempotency_key** · **부분 유니크 `uq_refunds_reservation_id_active` ON (reservation_id) WHERE status <> 'failed'** · 인덱스 2개 | 236-312 |
| `refund_events` (`models/refund_event.py:31`) | id, refund_id, event_type `varchar(50)`, payload `jsonb default '{}'`, created_at(updated_at 없음 — 추가 전용 감사 로그) | FK refund_id→refunds CASCADE · `ix_refund_events_refund_id` | 315-340 |

- **`user_id` 는 FK 가 아니다.** users 테이블이 없다(`orders.user_id`, `reservations.user_id`). 이관하면 새 users 테이블에 FK 를 걸지 정해야 한다
- **`payments` 에 상태 컬럼이 없다.** "결제 완료"는 `paid_at IS NOT NULL` 로 판정한다(`services/cancellation.py:426-433`)
- `refund_events.event_type` 값 6종: `refund_requested`·`gateway_succeeded`·`gateway_pending`·`gateway_failed`·`gateway_unsupported_method`·`reservation_cancelled`(`services/cancellation.py:174-179`). DB CHECK 는 없다

### A-1b. Alembic 이력

| 항목 | 값 | 근거 |
|---|---|---|
| 버전 파일 | **1개** — `0001_initial_domain.py` | `find backend/alembic/versions` |
| 마지막 리비전 | `0001_initial_domain`(`down_revision = None`) | `0001_initial_domain.py:38-39` |
| downgrade | 7테이블·인덱스 역순 삭제 | 같은 파일 350-373 |
| 테스트 DB 스키마 | Alembic 이 아니라 `Base.metadata.create_all()` 로 만든다 | `tests/conftest.py:173-186` |
| `kdance` DB 에 `alembic_version` 이 있는가 | **미확인** — DB 미기동. 확인 방법: DB 기동 뒤 `docker exec kdance-db psql -U kdance -d kdance -c '\dt'` |

### A-2. 비즈니스 로직 계층

| 모듈 | 하는 일 | 핵심 줄 |
|---|---|---|
| `services/cancellation.py` — SCH-05(취소 오케스트레이션) | 취소 1건의 11단계 순서(아래 표) · 미리보기 `preview_cancellation` | 순서 정의 1-23 · `cancel_reservation` 604-901 · `preview_cancellation` 504 |
| `services/refund_policy.py` — SCH-03(환불액 산정) | DB·IO 없는 순수 함수 `calculate_refund` | 123-186 |
| `services/fee_policy.py` | 상수만: `PLATFORM_FEE_RATE_BP=800`, `BETA_FEE_WAIVED=True`, `PG_FEE_BEARER="platform"`, `SETTLEMENT_REFUND_RECOVERY="next_month_deduction"` | 42-66. **app·tests 어디서도 import 하지 않는다**(grep 0건) |
| `adapters/` — SCH-04(어댑터 3종: PG/알림/슬롯락) | Protocol(포트) + Fake 구현. 서비스는 Protocol 만 import, 구상 클래스는 `deps.py` 가 주입 | `adapters/__init__.py:1-9` |

**SCH-05(취소 오케스트레이션)의 순서** — `services/cancellation.py`

| 단계 | 동작 | 줄 |
|---|---|---|
| 1 | `SELECT … FOR UPDATE` 로 reservations 행 잠금 | 398-406, 646 |
| 2 | 소유권 검사(남의 예약이면 403, 404 로 숨기지 않는다) | 651-653 |
| 3 | **멱등 재생** — 진행 중·성공 환불 또는 같은 멱등키가 있으면 기존 결과를 200 으로 돌려준다(상태 검사보다 **앞**) | 662-683 |
| 4 | 상태 검사 — `cancelled` 면 409, `held`·`confirmed` 만 허용, 시작 시각이 지났으면 409 | 686-694, 상수 148 |
| 5 | `paid_at` 이 있는 결제 원거래 조회 → `calculate_refund` | 697-707 |
| 6 | Refund INSERT 를 **SAVEPOINT**(`begin_nested`) 안에서. 유니크 위반이면 이긴 행으로 수렴(replayed) | 727-760 |
| 7 | PG 환불 호출. 카드는 `UnsupportedPaymentMethodError` → failed 로 커밋 후 예외 | 783-819 |
| 8 | 성공·대기 → 예약 `cancelled`, 주문 `refunded`, `reserved_count -1`(조건부 UPDATE 한 문장). 실패 → 예약·정원은 그대로 | 821-879, 956-976 |
| 9~10 | refund_events 기록 → **commit** | 881-885 |
| 11 | 커밋 **뒤**: 슬롯 락 해제(실패해도 삼킴) + 회원·학원 관리자 알림 | 895-899, 979-1006 |

- 멱등키: 헤더 `Idempotency-Key` 는 선택이다. 없으면 `sha256("cancel:" + reservation_id)`(`cancellation.py:36-38, 360`)
- `pending`(가상계좌 환불 송금 대기)도 예약 취소·좌석 반납은 확정한다. `refunded_amount` 는 0 으로 둔다(`cancellation.py:46-50, 914-929`)
- 쿠폰 복원 자리는 TODO 만 있다(`cancellation.py:848-851`)

**환불 계산 — SCH-03(환불액 산정)** `services/refund_policy.py`

| 규칙 | 값 | 줄 |
|---|---|---|
| 남은 시간 ≥ 24시간 → 100% | `FULL_REFUND_THRESHOLD_SECONDS = 86400` | 82, 164-166 |
| 24시간 미만 → 학원 비율표(`academies.refund_policy_tiers`)에서 남은 시간을 포함하는 티어 중 `hours_before_start` 가 가장 작은 것. 없으면 0% | `_resolve_tier` | 201-224 |
| 금액 = **올림** 정수 나눗셈 `-(-paid * bp // 10000)`, 결제액 상한 | `_ceil_amount` | 189-196, 171-172 |
| 시각은 **tz-aware 필수**, `now` 는 반드시 주입 | `_require_aware` | 262-267 |
| 경계 판정 단위는 초(`timedelta // 1초`), 시간 표시는 내림 | | 162, 181 |

**어댑터 3종 — SCH-04(어댑터 3종: PG/알림/슬롯락)**

| 어댑터 | 인터페이스 | Fake 동작 | 줄 |
|---|---|---|---|
| PG `payment_gateway.py` | `PaymentGateway.refund(RefundRequest) -> RefundResult` **환불만 있다.** 결제 생성·웹훅 수신 없음 | `FakePaymentGateway`: 포트원 V2 `CancelPaymentResponse` 모양을 만들어 실제 파서(`parse_portone_cancel_response`, 291)에 통과시킨다. 카드 → 예외, 가상계좌 + 환불계좌 없음 → failed(`REFUND_ACCOUNT_REQUIRED`). 멱등 원장은 **인메모리**(실패는 원장에 남기지 않는다). `settle()` 로 pending→succeeded | 346-358, 378-526 |
| 상태 매핑 | 포트원 `SUCCEEDED/REQUESTED/FAILED` → `succeeded/pending/failed` | | 118-122 |
| 알림 `notification.py` | `notify_member` · `notify_academy_admin`. 이벤트 3종 `reservation_cancelled`·`refund_pending`·`refund_failed` | `FakeNotificationSender` 가 호출 기록만 남긴다 | 51-61, 78-155 |
| 슬롯 락 `slot_lock.py` | **`release(schedule_id) -> bool` 하나뿐. acquire 가 없다** | `RedisSlotLock.release` = 키 `kdance:slot:{id}` 를 `DEL`. 연결은 지연 생성, 타임아웃 1초, **모든 예외를 삼키고 False**. `NullSlotLock` 은 기록만 | 1-19, 60-186 |

- 슬롯 락의 "TTL" 은 **이 코드에 없다.** 락을 거는 쪽(`SET … PX`)이 범위 밖이라 TTL 값도 코드에 없다(`slot_lock.py:6-10`). 정원의 권위는 `class_schedules.reserved_count` 라고 코드가 명시한다(`cancellation.py:984-985`)
- Redis 컨테이너에는 볼륨이 없다(`slot_lock.py:13`, `infra/docker-compose.yml:31-37` 에 volumes 없음)

### A-3. API 라우트와 인증

| 메서드 · 경로 | 핸들러 | 인증 | 줄 |
|---|---|---|---|
| GET `/health` | `main.health` | 없음 | `main.py:56-58` |
| GET `/reservations/{id}/cancellation-preview` | `get_cancellation_preview` | `X-User-Id` | `routers/reservations.py:100-105` |
| POST `/reservations/{id}/cancel` | `cancel` (헤더 `Idempotency-Key` 선택) | `X-User-Id` | `routers/reservations.py:137-160` |
| GET `/admin/academies/{id}/refund-policy` | `get_refund_policy` | **없음** | `routers/admin_academies.py:91-97` |
| PUT `/admin/academies/{id}/refund-policy` | 비율표 전체 교체 | **없음** | `routers/admin_academies.py:109-120` |

- `X-User-Id` 신원 주장 위치: `app/deps.py:54-96`. 헤더 없음 401, UUID 아님 400. 클라이언트가 마음대로 채우는 평문 헤더라는 경고가 주석에 있다(63-)
- 관리자 라우트는 인증 자체가 없다(`admin_academies.py:12-18` 주석)
- 라우터는 전부 **동기 `def`** 이고 세션은 `SessionLocal`(`autoflush=False`, `expire_on_commit=False`, `db.py:29-44`)
- CORS 허용 출처 `http://localhost:3000` 하나, 메서드 GET·POST·PUT·OPTIONS(`main.py:31-49`)
- 어댑터는 `lru_cache` 프로세스 싱글턴(`deps.py:104-125`). Fake PG 의 멱등 원장이 인메모리라 그렇다
- 비율표 검증(`schemas/academy.py`): 티어 최대 24개(50), `hours_before_start` 1~720 정수(68), `refund_rate_bp` 0~10000 정수(70), 시간 **엄격 내림차순**(93-), 모르는 필드 거부(`extra="forbid"`)

### A-4. 테스트 186개 구성

`uv run --frozen pytest --collect-only -q` 실측(186 tests collected).

| 파일 | 개수 | DB 필요 | 무엇을 검증하나 | TS 로 옮길 때 |
|---|---|---|---|---|
| `test_refund_policy.py` | 50 | 아니오 | `calculate_refund` 경계·올림·티어 해석·입력 오류 | 순수 함수 → 그대로 이식 가능 |
| `test_schemas.py` | 39 | 아니오 | Pydantic 요청·응답 스키마(미리보기 응답 포함) | zod 스키마 테스트로 옮김 |
| `test_cancellation_service.py` | 36 | 아니오 | 멱등키 결정성, 락 해제 예외 삼킴, 알림 양방향, **서비스 소스에 구상 어댑터 이름이 없는지 문자열 검사**(215), deps 싱글턴, 임시 인증 401/400, 예외→HTTP 코드 매핑 | 약 절반은 Python 구조(소스 문자열·`lru_cache`·FastAPI 의존성) 검사라 **1:1 이식이 안 된다** — 같은 의도를 TS 식으로 다시 써야 한다 |
| `test_adapters.py` | 33 | 아니오 | 포트원 응답 파서, Fake PG 멱등·주입, 알림·슬롯 락 | Fake 를 TS 로 옮기면 이식 |
| `test_admin_refund_policy.py` | **18** | **예** | 비율표 GET 3개 · PUT 2개 · 404 · 잘못된 입력 12종(parametrize) | DB 테스트 |
| `test_cancel_api.py` | **9** | **예** | 취소 성공·정원 복구, pending 도 정원 복구, 타인 403, 없음 404, 이미 취소 409, 시작 후 409, 중복 요청 재생, PG 실패 시 예약 유지, **동시 취소 2건 → 환불 1회**(`ThreadPoolExecutor` + `threading.Barrier`, 435-) | DB 테스트 |
| `test_health.py` | 1 | 아니오 | `/health` | — |

- **`requires_db` 27개 = `test_admin_refund_policy.py` 18 + `test_cancel_api.py` 9**(`pytest -m requires_db --collect-only` 실측). 마커 등록은 `pyproject.toml:29-30`
- **미리보기 API 는 DB 테스트가 없다.** `cancellation-preview` 를 부르는 테스트는 `test_schemas.py` 뿐이다(grep)
- conftest DB 준비 방식(`tests/conftest.py`)
  - 연결 실패면 에러가 아니라 **skip**(`pytest_runtest_setup`, 154-165)
  - 세션 스코프 엔진 + `Base.metadata.create_all()`(173-186). 대상 URL 은 `postgresql+psycopg://kdance:kdance@localhost:5433/kdance_test`(`config.py:41-43`)
  - 테스트마다 연결 1개 + 바깥 트랜잭션 → 끝나면 **무조건 rollback**(189-198). 세션은 `join_transaction_mode="create_savepoint"`(201-223)
  - 동시성 테스트만 `committed_scenario` 로 **실제 커밋**하고 teardown 에서 지운다(432-455)
  - API 테스트는 `app.dependency_overrides` 로 DB·어댑터 4종을 바꿔 끼운다(248-272)

### A-5. Prisma/TypeScript 로 옮길 때 의미가 달라질 수 있는 부분

| 주제 | 지금(Python) | Prisma 8 / TS 에서 확인된 사실 | 위험 · 미확인 |
|---|---|---|---|
| 트랜잭션 | `session.commit()` 1회, 성공 경로는 한 트랜잭션 | `db.transaction(async (tx) => …)` — 정상 반환이면 commit, throw 면 rollback(`@prisma/orm-postgres/skills/prisma-8/references/runtime.md:278-290`). 시그니처에 **옵션 인자가 없다**(`orm-postgres/dist/postgres-CBDyBUe9-Dg4ZOUYS.d.mts:93`) | **격리 수준 지정 API 없음** — 기본(READ COMMITTED)만 쓴다고 봐야 한다. raw `SET TRANSACTION ISOLATION LEVEL` 이 tx 안에서 되는지는 **미확인**(실측 필요) |
| 배열형 트랜잭션 | — | Prisma 7 식 `$transaction([a, b])` 없음 — 순차 실행된다(`queries.md:216`) | 옛 습관으로 쓰면 원자성이 깨진다 |
| 행 잠금 `FOR UPDATE` | `select(...).with_for_update()`(`cancellation.py:405`) | ORM·SQL 빌더 문서에 행 잠금 연산이 **없다**. 문서상 출구는 raw 레인 ``db.raw.sql`…` ``(`queries.md:212`). tx 컨텍스트에 `raw` 가 있다(`postgres-…d.mts:87`) | raw 레인으로 tx 안에서 `SELECT … FOR UPDATE` 가 실제로 잠그는지 **미확인** — R2(Prisma 8 트랜잭션·행 잠금 미검증)의 실측 대상 |
| SAVEPOINT | `begin_nested()` 로 유니크 위반만 되돌리고 잠금은 유지(`cancellation.py:727-747`) | 중첩 트랜잭션·SAVEPOINT API 를 설치본 문서에서 찾지 못했다 | **미확인.** 대안: `INSERT … ON CONFLICT DO NOTHING RETURNING` 으로 예외 없이 수렴(설계는 Phase 3) |
| 조건부 감소 | `UPDATE … SET reserved_count = reserved_count - 1 WHERE … AND reserved_count > 0` 한 문장, rowcount 확인(`cancellation.py:963-969`) | SQL 빌더 쓰기 결과는 `{ affectedRows }`(`queries-postgres.md:12`) | 같은 의미로 옮길 수 있어 보인다. 실측 전 |
| enum | `VARCHAR + CHECK`(이름 지정 `ck_*`) | PSL `enum` 은 **text 컬럼 + 플래너가 만든 CHECK**(`contract.md:272-289`) — 기존 방식과 같은 모양. 손으로 쓴 CHECK 는 `@@check(expression:, name:)`(293-312). 기존 제약을 그대로 들일 때는 `map:` 이고 본문을 바이트 단위로 비교한다(310) | 기존 `ck_*` 이름을 유지할지 새 이름으로 갈지 정해야 한다 |
| 부분 유니크 인덱스 | `UNIQUE (reservation_id) WHERE status <> 'failed'` | `@@index(..., where:, unique:)` 지원(`contract.md:120-124`) | 이중 환불 방지의 핵심이라 이관 뒤 동시 취소 테스트로 반드시 재확인 |
| 시각 | `timestamptz`, Python `datetime` tz-aware 강제 | `Timestamptz` 는 JS `Date` 가 **아니라 `Temporal.Instant`** 로 읽고 쓴다(`contract.md:118`). `temporal-polyfill` 1.0.5 설치됨 | 계산 코드가 `Date` 를 섞으면 형 불일치. KST 판정(가상계좌 「수업 1시간 전」)은 `Temporal.ZonedDateTime` 으로 해야 한다 |
| 금액 | Python `int`(무한 정밀도), `//` 정수 나눗셈 | DB 는 int4. JS `number` 는 2^53 까지 정확 | `paid * bp`(최대 약 2.1×10^13)는 안전 범위지만 **JS 에는 바닥 나눗셈이 없다** — 올림식을 `Math.ceil(a*b/d)` 로 옮기면 부동소수 경로를 탄다. `BigInt` 또는 `(a*b + d - 1) / d` 정수 처리를 Phase 3 이 정한다 |
| UUID PK | 클라이언트가 `uuid4` 생성 | 문서 예시는 `@default(uuid())`, TS 빌더 `uuidv7String()`(`contract.md:162, 262`) | `uuid()` 가 DB 기본값인지 클라이언트 생성인지 **미확인** |
| `updated_at` | ORM `onupdate` | Prisma 8 의 자동 갱신 속성 | **미확인**(설치본 문서에서 찾지 못함) |
| 커밋 뒤 부수효과 | 락 해제·알림을 commit 뒤에, 예외 삼킴 | — | `db.transaction` 콜백 **밖**에서 해야 같은 의미가 된다 |
| 멱등 원장 | Fake PG 원장이 프로세스 메모리 + `lru_cache` 싱글턴 | Next.js Route Handler 는 요청·워커 단위로 모듈 상태가 보장되지 않는다 | Fake 원장을 DB 로 옮길지 Phase 3 결정(Q4~Q8(전환 세부) 중 「가짜 결제 원장」) |

---

## B. admin-web/ (Next.js, 새 구현 주 무대)

### B-1. 구조 · package.json(실측)

| 경로 | 내용 |
|---|---|
| `app/layout.tsx` · `app/page.tsx` | 대시보드. `"use client"` 로 FastAPI `/health` 를 부른다(`app/page.tsx:1-11`) |
| `app/refund-policy/page.tsx` | `RefundPolicySettings` 컴포넌트를 렌더(1-4). CLAUDE.md 상 **2026-09-25 폐기 결정** 화면 |
| `components/AdminNav.tsx` · `components/RefundPolicySettings.tsx` | UI |
| `lib/api-client.ts` | `API_BASE_URL`(기본 `http://localhost:8000`, 8-10) · `ApiError` · `apiFetch`(63) · `userId` → `X-User-Id`(29) · `fetchRefundPolicy`/`updateRefundPolicy`(142-153). FastAPI `{"detail":…}` 해석(47-) |
| `AGENTS.md` | "This is NOT the Next.js you know — `node_modules/next/dist/docs/` 를 먼저 읽어라" |
| `tsconfig.json` | `strict: true`, `moduleResolution: bundler`, `paths: @/*`, target ES2017 |
| **없는 것** | `app/api/`(Route Handler), `middleware`, `.prisma`, `prisma.config.*`, `migrations/`, 테스트 파일 전부 |

scripts: `dev`·`build`·`start`·`lint`(lint 고장) — 테스트 스크립트 없음.

| 패키지 | 선언 범위 | 설치 실측 | 비고 |
|---|---|---|---|
| next | ^16.3.5 | 16.3.5 | |
| react / react-dom | ^19.3.0 | 19.3.0 | |
| typescript | ~6.0.3 | 6.0.3 | |
| prisma (dev) | ^8.0.0-rc.15 | 8.0.0-rc.15 | CLI |
| @prisma/orm-postgres | ^8.0.0-rc.11 | 8.0.0-rc.11 | 런타임. CLI 가 "skills out of date … Run: prisma skills sync" 경고 |
| better-auth | ^1.7.5 | 1.7.5 | |
| zod | ^4.6.5 | 4.6.5 | |
| ai | ^7.0.113 | 7.0.113 | |
| @langchain/langgraph | ^1.4.17 | 1.4.17 | |
| temporal-polyfill | ^1.0.5 | 1.0.5 | Prisma 8 시각 타입에 필요 |
| pg | (선언 없음) | 8.22.0 | `@prisma/orm-postgres`·`better-auth` 의 전이 의존 |
| kysely | (선언 없음) | 0.29.6 | 전이 의존 |
| vitest | (선언 없음) | **4.1.11** | `better-auth` 와 `prisma → @prisma/composer-cli → @effect/vitest` 의 전이 의존(`npm ls vitest`) |

`overrides`: `{"better-auth": {"prisma": "$prisma"}}` — better-auth 의 prisma peer(`^5 || ^6 || ^7`)를 설치된 prisma 8 로 덮는다.

### B-2. 환경 변수 예시

| 파일 | 변수 |
|---|---|
| `admin-web/.env.example` | `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` 하나뿐 — DB URL·Redis·인증 비밀값 예시 없음 |
| `mobile/.env.example` | `EXPO_PUBLIC_API_URL=http://localhost:8000` |
| `backend/app/config.py:40-44` | `database_url` → `kdance`, `test_database_url` → `kdance_test`, `redis_url` → `redis://localhost:6380/0` |

### B-3. Prisma 스키마·마이그레이션 = 0개 (확인)

`find admin-web -path ./node_modules -prune -o \( -name '*.prisma' -o -name 'prisma.config.*' -o -name migrations \)` 결과 **0건**. Phase 1 문서 0절의 기록과 같다.

### B-4. 테스트 러너 후보(Q10(테스트 러너)) — 사실만

| 확인 항목 | 결과 | 근거 |
|---|---|---|
| Next 설치본 공식 안내 | App Router 가이드에 **Vitest** 문서가 있다. "async Server Component 는 Vitest 가 지원하지 않는다 → 그건 E2E 로" | `node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md:9` |
| 안내된 설치 묶음 | `vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom vite-tsconfig-paths`, 설정 파일 `vitest.config.mts`, 스크립트 `"test": "vitest"` | 같은 파일 33-100 |
| npm 레지스트리 | vitest `latest` = **5.1.0**, `V4` = 4.1.12. jest `latest` = 30.5.2 | `npm view vitest dist-tags`, `npm view jest` |
| vitest 5.1.0 peer | `vite ^6.4 || ^7 || ^8`, `@types/node ^22 || >=24`, engines `node ^22.12 || ^24 || >=26` | `npm view vitest peerDependencies engines` |
| 이 환경 | Node **v24.22.0**, `@types/node` ^26.5.1 선언, vite 8.3.0 이 이미 전이 설치됨 | `node -v`, `node_modules/vite/package.json` |
| **충돌 후보** | `@effect/vitest`(prisma CLI 의 전이 의존)의 peer 가 **`vitest >=4.1.0 <5.0.0`**. better-auth 의 peer 는 `^2 … || ^5`(optional) | `node_modules/@effect/vitest/package.json`, `npm view better-auth@1.7.5 peerDependencies` |
| TypeScript 6.0.3 | vitest peer 에 typescript 가 없다 — 직접 충돌 없음 | 위 peer 목록 |

정리: vitest 를 최상위에 **5.x** 로 넣으면 `@effect/vitest` 의 peer(`<5`)와 부딪혀 `ERESOLVE` 가 날 수 있다(설치 전이라 **미검증**). **4.1.x** 를 고르면 이미 설치된 4.1.11 과 선언 범위가 맞는다. 결정은 Phase 3, 실측 설치는 Phase 5 에서 한다.

### B-5. Prisma 8 마이그레이션 명령 — 설치본으로 확인

Phase 1 이 「이름 미확인」 이라 적은 `migrate deploy` 는 **Prisma 8 에 없다.** `npx --no-install prisma <cmd> --help` 실측.

| 하고 싶은 일 | Prisma 8 명령 | 설명(도움말 요약) |
|---|---|---|
| 계약(PSL) → 산출물 | `prisma contract emit` | `contract.json`·`contract.d.ts` 생성. 편집 뒤 다시 돌리지 않으면 타입·plan 이 옛 모양을 본다(`contract.md:409`) |
| 마이그레이션 파일 만들기 | `prisma migration plan --name <slug>` | 오프라인. `migrations/app/<timestamp>/migration.ts` 생성 |
| 마이그레이션 적용 | `prisma db migrate --db <url>` | 디스크의 마이그레이션 그래프를 재생한다. `--show` 는 읽기 전용 미리보기 |
| 빠른 개발용 동기화 | `prisma db update --db <url>` | 마이그레이션 파일을 남기지 않는다. 파괴적 변경은 `--confirm <db이름>` 필요. 공유 이력이 없는 로컬 DB 에만(`migrations.md:33`) |
| 빈 DB 기준선 | `prisma db init --db <url>` | |
| 검증 · 서명 | `prisma db verify` · `prisma db sign` | DB 의 마커와 계약 대조 |
| **기존 DB 에서 계약 역추출** | `prisma contract infer --db <url> --output <path>` | 기존 7테이블을 PSL 로 들일 때 쓸 수 있다. CHECK·부분 인덱스는 `map:` 으로 들어온다(`contract.md:405`) |
| 초기화 | `prisma init` / `prisma orm init` | config(`prisma.config.ts`)·postinstall(skills sync) 생성 |

- 설치본 문서 위치: `admin-web/node_modules/@prisma/orm-postgres/skills/prisma-8/`(`SKILL.md`, `references/{migrations,migration-model,contract,runtime,queries,queries-postgres}.md`). `admin-web/node_modules/prisma/skills/` 에는 플랫폼 개념 문서 1개만 있다
- 쿼리 표면: `db.orm.public.<Model>`(ORM) / `db.sql.public.<table>`(SQL 빌더) / `db.raw.sql`(raw) — Postgres 는 **스키마 이름(namespace)이 경로에 들어간다**(`queries.md:41-46`)
- 서버 패턴: `db.ts` 모듈 싱글턴. 요청 핸들러 안에서 `await using` 하면 요청마다 풀을 만든다(`runtime.md:96-98, 340`)

### B-6. Better Auth 와 Prisma 8 (SCH-24(인증·역할) 대비)

| 사실 | 근거 |
|---|---|
| `@better-auth/prisma-adapter` 의 peer 는 `@prisma/client`·`prisma` `^5 || ^6 || ^7` | 해당 `package.json` |
| 그 어댑터 코드는 `$transaction`(5회)·`findFirst`·`findMany` — Prisma 7 이하 클라이언트 API | `@better-auth/prisma-adapter/dist/index.mjs` grep |
| Prisma 8 façade 에는 `$transaction` 배열형이 없고 모델 경로가 `db.orm.public.X` 다 | `queries.md:46, 216` |
| `@better-auth/kysely-adapter` peer `kysely ^0.28.17 || ^0.29.0`, kysely 0.29.6 설치됨, pg 8.22.0 설치됨 | `package.json`, `npm ls` |

→ 「prisma 어댑터로 Prisma 8 에 붙인다」 는 **그대로는 성립하지 않는다**(코드 실행 검증은 안 함). SCH-24 카드의 「Kysely 경로」 와 맞는다. Better Auth 테이블(user·session·account 등)이 Prisma 계약 밖에서 생기면 `contract`·`db verify` 와의 관계도 정해야 한다 — **미확인**.

---

## C. mobile/ (Expo)

| 항목 | 현재 | 근거 |
|---|---|---|
| 구조 | `index.ts` → `App.tsx`(500줄) 하나. `app.json`·`assets/` | `find mobile` |
| 라우터 | **없음**(`expo-router` 미설치) | `node_modules/expo-router` 없음 |
| API 호출 레이어 | 없음. `App.tsx` 안에서 직접 `fetch` — `/health`(105), `/reservations/{id}/cancellation-preview`(116-117), `/reservations/{id}/cancel`(175-176) | `App.tsx` |
| API 주소 | `process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000"` | `App.tsx:27` |
| 버전(실측) | expo **58.0.0-preview.6** · react-native **0.88.0-rc.1** · react 19.3.0 · typescript 6.0.3 · expo-status-bar ~58.0.1 | `package.json` + `node_modules/*/package.json` |
| 웹 실행 | `scripts.web` 은 있지만 `react-native-web`·`react-dom` **미설치** | R5(mobile 동작 검증 수단 부재) 판단 재료 |
| 검증선 | `npx tsc --noEmit` | CLAUDE.md |

현재 취소 화면은 SCH-09(mobile 취소·환불계좌) 산출물이다. 백엔드가 Next.js 로 옮겨 가면 경로·오류 형식(`{"detail":…}`)이 바뀌므로 함께 고쳐야 한다.

---

## D. DB · 인프라

| 항목 | 값 | 근거 |
|---|---|---|
| DB | `pgvector/pgvector:0.8.6-pg18`, `kdance-db`, 포트 `5433:5432`, user/db `kdance`, 비밀번호 `${POSTGRES_PASSWORD:-kdance}`, 볼륨 `kdance-db-data`, healthcheck 있음 | `infra/docker-compose.yml:9-30, 113-114` |
| Redis | `redis:alpine`, `kdance-redis`, `6380:6379`, **볼륨 없음**, healthcheck 있음 | 같은 파일 31-40 |
| AI | `kdance-llm`(llama-server), `11436:8080` | 51-100 |
| 현재 기동 여부 | **확인 불가** — `docker ps` 가 "The command 'docker' could not be found in this WSL 2 distro" 를 냈다(Docker Desktop 꺼짐). 기동 시도는 하지 않았다 | 실행 결과 |

**Alembic ↔ Prisma 가 한 DB 에 같이 있을 때의 위험** — Q3 결정으로 7테이블을 이관하므로 공존은 **전환 기간에만** 생긴다.

| 위험 | 내용 | 확인 방법 |
|---|---|---|
| 같은 테이블을 두 도구가 소유 | Prisma 계약이 `orders`·`reservations` 등을 선언하면 `db update`/`migrate` 가 Alembic 이 만든 테이블과 diff 를 낸다. `contract infer` 로 들이면 `map:` 으로 기존 이름을 받는다 | Phase 5 에서 `db update --dry-run` 결과 확인 |
| 이름 규칙 차이 | 기존 제약 이름은 `ck_*`·`fk_*`·`ix_*`·`uq_*`. Prisma 가 만드는 이름과 다르면 rename 마이그레이션이 생긴다(`contract.md:405`) | 같음 |
| 파괴적 변경 | `db update` 는 파괴적 변경을 `--confirm` 없이 하지 않지만, 확인하면 **backend 가 쓰던 열을 지울 수 있다** | — |
| 테스트 DB 가 두 방식으로 만들어짐 | backend 테스트는 `create_all`, Prisma 는 마커가 있는 DB 를 기대(`CONTRACT.MARKER_MISSING`, `migrations.md:76`). 같은 `kdance_test` 를 공유하면 서로의 스키마 가정이 깨진다 | 전환 중 backend 186 passed 를 유지할지부터 결정 |
| `alembic_version` 테이블 | `kdance` 에 있다면 Prisma 계약 밖의 테이블이다. `db verify` 가 이를 무엇으로 볼지 **미확인** | DB 기동 후 `\dt` · `prisma db verify` |
| 스키마 분리 선택지 | Prisma 8 은 Postgres 스키마를 namespace 로 다룬다(`queries.md:41`) — 새 테이블을 별도 스키마에 둘 수 있다 | 설계 선택(Phase 3) |

---

## E. 재사용 · 충돌 판단

### E-1. 3분류 표

| 대상 | 이미 있어 이관만 하면 됨 | 새로 만들어야 함 | 기존 코드와 충돌 |
|---|---|---|---|
| 데이터 모델 | academies, payments, refunds, refund_events 의 컬럼·제약(부분 유니크 포함) | users·프로필·관심 장르(FR-022(사용자 프로필)), 수업(정규 과정) ↔ 회차 ↔ 기간 신청 단위, 캘린더 기록, 알림 기록, 정산 `hold` 원장(Q5 가정), 공지 판본, 본인확인 CI | ① `class_schedules` 는 **회차 1행 = 정원 1개**(`capacity`·`reserved_count`). FR-092(성별 정원)의 남·여 정원과 맞지 않는다 ② 정규 과정(Q4 결정)은 「수업 → 여러 회차 → 기간 신청」 인데 지금은 회차만 있고 종료 시각도 없다 ③ `reservations` 에 자리 성별이 없다 ④ `orders.status` 에 `expired`·`cancelled` 가 없다(FR-285(결제 기한)·FR-286(입금 전 셀프 취소)) ⑤ `payments` 에 상태·기한 컬럼이 없다(`paid_at` 만) ⑥ `user_id` FK 없음 |
| 취소·환불 로직 | SCH-05(취소 오케스트레이션) 11단계 · SCH-03(환불액 산정) 순수 함수 · 멱등키 규칙 | — | ⑦ `held` 예약도 취소 대상(`cancellation.py:148`)이지만 결제 원거래(`paid_at`)가 없으면 409(697-699). FR-286 은 입금 전 취소를 **환불 없이 자리만 푸는** 흐름이라 경로가 갈라진다 ⑧ 정원 복구는 `reserved_count -1` 하나 — 성별 정원이면 어느 쪽을 줄일지 정보가 없다 ⑨ 24시간·학원 비율표 규칙은 원데이형 기준이고, 정규 과정 환불(SCH-32(정규 과정 환불))의 회차·기간 계산과 같은지 **미확인** |
| 환불 비율표 | GET/PUT API · 검증 규칙 18개 테스트 | — | ⑩ admin-web 비율표 화면은 2026-09-25 **폐기 결정**(CLAUDE.md, spec Q11(환불 방식 변경의 뒤처리) ②). 이관 범위에 넣을지 Phase 3 결정 |
| PG 어댑터 | 환불 포트 + 포트원 응답 파서 + Fake | **결제 생성, 가상계좌 발급, 웹훅 수신·서명 검증, 금액 대조** — 전부 없다 | ⑪ Fake 멱등 원장이 프로세스 메모리 싱글턴 — Route Handler 환경에서 의미가 달라진다 |
| 알림 어댑터 | 포트 + Fake(호출 기록) | 결제 확인 알림 이벤트(FR-114(결제 확인 앱 알림)) + **DB 기록**(FR-289 원자성에 묶이려면 테이블이어야 함) | ⑫ 지금 알림은 **커밋 뒤** 부수효과다. FR-289(확정 후 일괄 처리)는 알림 기록을 같은 트랜잭션에 넣으라고 한다 — 「기록」 과 「발송」 을 나눠야 둘이 같이 선다 |
| 슬롯 락 | `release` + 키 규칙 `kdance:slot:{id}` | acquire(결제 시작 시 자리 잡기) 전체 | ⑬ 기존 설계는 「권위는 DB `reserved_count`」. US1 의 `held` 자리 잡기(FR-096(결제 대기 자리 잠금))를 Redis 로 할지 DB 로 할지에 따라 이 어댑터가 남거나 사라진다 — Q11(슬롯 잠금 수단) |
| 인증 | — | 시드 로그인 + 가짜 본인확인(Q2), 세션 | ⑭ `X-User-Id` 헤더 방식(`deps.py:54`), admin 라우트 무인증 → 대체 대상. better-auth prisma 어댑터는 Prisma 8 과 안 맞는다(§B-6) |
| API 표면 | 경로·상태 코드 규칙(403/404/409/422, 중복 요청 200 재생) | 가입·프로필·검색·주문·웹훅·캘린더 Route Handler | ⑮ 오류 본문 형식이 FastAPI `{"detail":…}` — `lib/api-client.ts:47-` 와 `mobile/App.tsx` 가 여기에 기대고 있다 |
| 테스트 | 순수 로직 테스트 약 120개(refund_policy 50 + adapters 33 + schemas 39 중 해당분) | US1 AC 테스트 전부, 테스트 러너 | ⑯ `test_cancellation_service.py` 의 소스 문자열·`lru_cache`·FastAPI 의존성 검사는 TS 로 1:1 이식이 안 된다 ⑰ DB 테스트의 「바깥 트랜잭션 + SAVEPOINT 롤백」 격리는 Prisma 8 에서 같은 방식이 되는지 **미확인**(SAVEPOINT API 미확인) |

### E-2. Phase 1 수용 기준과의 대응

| AC | 기존 코드 재사용 | 비고 |
|---|---|---|
| AC-1(조건 검색) | 없음 | 수업·프로필 모델 신규 |
| AC-2(결제 확정 일괄 처리) | 트랜잭션 + 조건부 증감 패턴(`cancellation.py:963-969` 의 역방향) | 웹훅·캘린더·알림 기록·원장 신규. 알림 위치 충돌 ⑫ |
| AC-3(웹훅 신뢰성) | 멱등 수렴 패턴(유니크 + 재생 200) | 서명 검증·금액 대조 신규 |
| AC-4(입금 기한 만료) | `now` 주입 관례(`refund_policy.py` · Fake PG `clock`) | 만료 처리기·`expired` 상태 신규(충돌 ④) |
| AC-5(입금 전 셀프 취소) | — | 기존 취소와 경로 분리 필요(충돌 ⑦) |
| AC-6(정원 정합성) | `FOR UPDATE` + CHECK(`reserved_count <= capacity`) + 동시성 테스트 방식(`Barrier`) | 성별 정원으로 바뀜(충돌 ①). R2 실측 대상 |
| AC-7(성별 자리 기본값) | 없음 | 신규 |
| AC-8(결제 화면 필수 표시) | `fee_policy.py` 상수(미사용) | 가격 내역·공지 판본 고정 신규 |
| AC-9(가입 정보) | 없음 | 신규 |
| AC-10(끝까지 한 바퀴) | 없음 | 신규 |
| AC-11(회귀) | backend 186 | **Q3 결정으로 의미가 바뀐다** — 이관 뒤 backend 를 지우면 「186 passed」 대신 「이관된 27개 + 순수 로직 테스트가 TS 쪽에서 통과」 로 다시 정의해야 한다 |
| AC-12(빌드) | `npm run build` · `tsc --noEmit` | 그대로 |

### E-3. 그 밖에 확인한 것

- Q9(캘린더의 뜻): spec 에 기기 캘린더·외부 캘린더 연동 언급이 없다(`grep "기기 캘린더|구글 캘린더|캘린더 연동"` 0건). 「내 캘린더」 는 시나리오 2(spec 355행)와 FR-289(spec 1440행)에만 나온다 → **앱 안 캘린더 기록**이라는 Phase 1 가정과 어긋나는 근거를 찾지 못했다
- 이미 설치돼 있지만 아직 안 쓰는 패키지: `@tanstack/react-query`, `zustand`, `ai`, `@langchain/*`, `@modelcontextprotocol/sdk`(admin-web)

---

## F. Phase 3 에 넘기는 열린 사항

| # | 결정할 것 | 재료 |
|---|---|---|
| 1 | 7테이블을 들이는 방식: `contract infer`(기존 이름·`map:` 유지) vs 새 계약으로 다시 쓰기(이름 변경 마이그레이션) | §B-5, §D |
| 2 | 정원 모델 재설계 — 회차 단일 `capacity` → 성별 정원 + 단일 정원(FR-092·FR-092c(성별 구분 없는 단일 정원)), 정규 과정의 수업·회차·기간 신청 단위 | 충돌 ①②③⑧ |
| 3 | 행 잠금·SAVEPOINT 대체: raw `FOR UPDATE` 실측, `ON CONFLICT` 수렴, 격리 수준 | §A-5, R2 |
| 4 | 금액 정수 연산 규칙(BigInt 또는 정수 올림식) · 시각 타입(`Temporal.Instant`/KST 판정) | §A-5 |
| 5 | 상태값 확장: `orders`(만료·취소), `payments`(상태·기한), `reservations`(자리 성별) | 충돌 ④⑤ |
| 6 | 입금 전 셀프 취소와 기존 취소 경로 분리 | 충돌 ⑦ |
| 7 | 알림: 트랜잭션 안 기록 vs 커밋 뒤 발송 | 충돌 ⑫, Q12(알림 기록 형태) |
| 8 | 슬롯 잠금 수단(Redis acquire 신설 vs DB 만) | 충돌 ⑬, Q11 |
| 9 | 가짜 PG 원장 위치(메모리 → DB?) · 결제 생성·웹훅 포트 모양 | 충돌 ⑪, Q7(PG 결정 상태) |
| 10 | 인증: better-auth + Kysely 어댑터 경로 여부, Better Auth 테이블과 Prisma 계약의 관계 | §B-6 |
| 11 | 테스트 러너(vitest 4.1.x vs 5.x — `@effect/vitest` peer `<5`) · DB 테스트 격리 방식 | §B-4, 충돌 ⑰ |
| 12 | 환불 비율표(폐기 결정 화면)를 이관 범위에 넣을지 | 충돌 ⑩ |
| 13 | 전환 중 `kdance_test` 공유 여부, AC-11(회귀)의 새 정의, `backend/` 삭제 시점 | §D, §E-2 |
| 14 | 오류 응답 형식(FastAPI `detail` 호환 유지 여부) — admin-web·mobile 클라이언트 영향 | 충돌 ⑮ |

## G. 미확인 목록과 확인 방법

| 항목 | 확인 방법 |
|---|---|
| DB 기동 상태, `kdance` 의 `alembic_version` 유무, 실제 스키마 | Docker Desktop 기동 → `docker exec kdance-db psql -U kdance -d kdance -c '\dt'` |
| Prisma 8 tx 안 raw `SELECT … FOR UPDATE` 의 실제 잠금, 격리 수준 지정, SAVEPOINT | `kdance_test` 에서 2연결 동시 실행 스파이크(Phase 5 첫 Task, R2) |
| `@default(uuid())` 가 DB 기본값인지 | `prisma migration plan` 결과 `migration.ts` 확인 |
| `updated_at` 자동 갱신 방법 | 설치본 `contract.md` 정독 또는 context7 |
| vitest 5.x 설치 시 `ERESOLVE` 여부 | Phase 5 에서 `npm install -D vitest@<ver> --dry-run` |
| better-auth Kysely 어댑터가 pg 8.22 + Next 16.3 에서 도는지 | Phase 5 스파이크 |
| 정규 과정 환불 규칙이 기존 24시간·비율표와 같은지 | spec SCH-32(정규 과정 환불) 관련 FR 대조 |
