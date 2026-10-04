# Phase 1 — 요구사항 분석: FastAPI 백엔드를 Next.js + Prisma 8 로 교체

- 작성일: 2026-09-20
- 담당: kdance-req-analyst
- 입력: `_workspace/00_input/request.md`("Prisma 8 RC 스택 전환 해줘")
- 근거 문서: `docs/planning/kdancex4_service_definition_and_tech_stack.md` 「11 · 11-1 · 11-2 · 11-3」, `docs/agent/ai-coding-agent.html`, `.claude/rules/core-rules.md` 「버전 정책」
- 직전 회차 산출물: 커밋 `7f28ab1^` 의 `_workspace/01_req-analyst_requirements.md`, `03_impl-planner_plan.md`(백업 폴더 `_workspace_20260920_183143/` 은 2026-09-29 에 지웠다)
- 상태: **Q1~Q5 미해결 (BLOCKING). Phase 2(기존 코드 구조 확인) 탐색은 병행 가능하나 Phase 3(구현 계획) 착수 전에 답이 필요하다.**

---

## 1. 요구사항 요약

### 1.1 What — 무엇을

`backend/`(FastAPI + SQLAlchemy 2 + Alembic + psycopg3, Python 3.12/uv)가 지금 제공하는 HTTP API와 도메인 로직을 `admin-web/`(Next.js 16.3.5 + Prisma 8 RC)로 옮긴다. **기능을 새로 만드는 작업이 아니라 같은 동작을 다른 언어·다른 접근 계층으로 재구현하는 작업이다.**

DB는 그대로 둔다. PostgreSQL 18.6 + pgvector 0.8.6 에 담길 스키마는 동일하고, 접근 계층만 SQLAlchemy 2 + psycopg3 에서 Prisma 8 계약(`@prisma/orm-postgres`)으로 바뀐다.

### 1.2 Why — 왜

`docs/planning/kdancex4_service_definition_and_tech_stack.md` 「11-3. 백엔드 교체」의 판단을 그대로 옮기면 두 가지다.

1. **확정된 스택이 TypeScript 단일 스택이다.** ORM(Prisma 8) · Auth(Better Auth) · AI UI(Vercel AI SDK 7) · Agent(LangGraph 1.4) 가 전부 TypeScript 전용이라, Python 백엔드를 남기면 도메인 로직과 AI 계층이 프로세스 경계로 갈린다.
2. **지금이 가장 싸다.** Alembic 마이그레이션이 `0001_initial_domain.py` 1개뿐이고, kdance DB 에는 테이블이 하나도 만들어져 있지 않다(2026-09-20 실측). 스키마가 커진 뒤에 옮기면 비용이 몇 배가 된다.

### 1.3 지금 실제로 있는 것 (실측, 2026-09-20)

| 항목 | 실측값 |
|---|---|
| `backend/app/` 소스 | 3,963줄 (`.venv` 제외) |
| `backend/alembic/` | 491줄 — 리비전은 `0001_initial_domain.py` 1개 |
| `backend/tests/` | 2,881줄 · `def test_` 118개 · `parametrize` 16곳 → **실행 시 159 passed** |
| 합계 | 7,335줄 |
| DB 실제 상태 | `postgresql://kdance:kdance@localhost:5433/kdance` — **테이블 0개, vector 확장 미생성** |
| admin-web 화면 | `app/page.tsx`(대시보드) · `app/refund-policy/page.tsx` + `components/RefundPolicySettings.tsx` · `lib/api-client.ts` |
| mobile | `App.tsx` 단일 파일. `EXPO_PUBLIC_API_URL` 기본값 `http://localhost:8000` |

---

## 2. 대상 범위 — 계층 매핑

### 2.1 backend → admin-web 계층 대응

| backend 계층 | 파일(줄) | 이관 대상 | 난이도·쟁점 |
|---|---|---|---|
| 설정 | `app/config.py`(52) | `admin-web` 환경변수 + zod 4.6.5 검증 | 낮음. pydantic-settings 대응물이 없으므로 zod 로 직접 짠다 |
| DB 접근 | `app/db.py`(58) — Engine/Session | `src/prisma/db.ts` — `postgres<Contract>({ contractJson, url })` | **높음.** Session 단위 unit-of-work 개념이 Prisma 8 에 그대로 있지 않다. 트랜잭션·행 잠금 API 를 먼저 확인해야 한다(§7 R2(Prisma 8 트랜잭션·행 잠금 미검증)) |
| 스키마 정의 | `app/models/*.py` 8파일(429) — `Academy` `ClassSchedule` `Order` `Payment` `Reservation` `Refund` `RefundEvent` + `Base` | `src/prisma/contract.prisma`(PSL) → `prisma contract emit` → `contract.json` + `contract.d.ts` | 중간 |
| 마이그레이션 | `alembic/versions/0001_initial_domain.py`(373) | `prisma migration` | **높음.** 부분 유니크 인덱스·CHECK 제약 표현 가능 여부 미검증(§7 R3(부분 유니크 인덱스 PSL 표현 미검증)) |
| 순수 계산 | `services/refund_policy.py`(267) · `services/fee_policy.py`(66) | `lib/domain/*.ts` | **낮음 — 가장 기계적.** IO 의존이 0이라 함수 시그니처째로 옮긴다. 정수 연산 유지가 조건 |
| 오케스트레이션 | `services/cancellation.py`(1,069) | `lib/services/cancellation.ts` | **최고.** 트랜잭션 경계·`FOR UPDATE`·부분 유니크 위반 포착·커밋 후 부수효과가 전부 여기 모여 있다 |
| 어댑터(포트) | `adapters/payment_gateway.py`(526) · `notification.py`(155) · `slot_lock.py`(186) | `lib/adapters/*.ts` | 중간. Python `Protocol` → TS `interface`. §7 R6(프로세스 싱글턴 서버리스 붕괴) 주의 |
| 요청/응답 검증 | `schemas/cancellation.py`(225) · `schemas/academy.py`(136) | zod 4.6.5 스키마 | 중간. Pydantic 의 422 응답 형태가 달라진다(§3.2) |
| 라우팅 | `routers/reservations.py`(205) · `routers/admin_academies.py`(146) · `main.py`(58) | Next.js Route Handler(`app/api/.../route.ts`) | 중간. 경로 접두어 쟁점(§8 Q4) |
| 의존성 주입 | `deps.py`(157) — `Depends()` + `@lru_cache` 싱글턴 | 모듈 레벨 팩토리 + 테스트에서 `vi.mock` | 중간. `app.dependency_overrides` 대응물을 새로 정해야 한다 |
| CORS | `main.py` 의 `CORSMiddleware` | **대체로 소멸** | admin-web 이 API 와 같은 오리진이 되므로 CORS 대상은 없어진다. mobile 은 원래 CORS 대상이 아니다 |
| 테스트 | `tests/*.py`(2,881) | vitest | **높음.** 러너부터 명시 선언해야 한다(§7 R5(테스트 러너 transitive)) |

### 2.2 이번 작업이 건드리는 디렉터리

- **`admin-web/`** — 주 작업 대상. 신규 코드 전부가 여기로 들어간다.
- **`backend/`** — 처리 방침 미정(§8 Q1). 삭제든 보존이든 **코드 수정은 하지 않는다.**
- **`infra/docker-compose.yml`** — Redis(`kdance-redis`, 6380) 를 계속 쓸지에 따라 달라진다(§8 Q6).
- **`docs/`** — 전환 완료 후 「11-3」 상태 갱신. 이번 Phase 범위는 아니다.

### 2.3 범위 밖

- **`mobile/`** — request.md 제약 5. Expo 58.0.0-preview.3 + RN 0.88.0-rc.0. **소스를 고치지 않는다.** 다만 §3.1 의 API 계약이 유지되는지는 `npx tsc --noEmit` 으로 확인한다.
- **신규 기능** — 예약 생성·결제 생성·부분 취소·학원 귀책 취소는 직전 회차에서 이미 범위 밖으로 확정됐다. 전환 작업이 그 결정을 되돌리지 않는다.
- **실 PG 연동** — `FakePaymentGateway` 그대로 옮긴다. PortOne 응답 파서(`parse_portone_cancel_response`)는 이미 프로덕션 코드이므로 동작까지 보존한다.
- **Vercel 실제 배포** — 「11-3」의 최종 목표지만, 전환 자체와 배포는 분리한다. 로컬 `next build` 가 이번 검증선이다.

---

## 3. 기능 보존 목록

전환 전후로 **동작이 같아야 하는 것**을 계층별로 적는다. 직전 회차의 `01_req-analyst_requirements.md` §7 수용 기준과 `03_impl-planner_plan.md` 를 대조해 누락을 막았다.

### 3.1 HTTP API 계약 (mobile·admin-web 이 실제로 부르는 것)

| 메서드 · 경로 | 호출자 | 보존 대상 |
|---|---|---|
| `GET /health` | mobile `App.tsx:105` | `{"status":"ok"}` |
| `GET /reservations/{id}/cancellation-preview` | mobile `App.tsx:117` | 응답 필드 12개: `reservation_id` `payment_method` `paid_amount` `refund_amount` `refund_rate_bp` `hours_before_start` `seconds_before_start` `applied_tier_hours` `starts_at` `cancellable` `reason_code` |
| `POST /reservations/{id}/cancel` | mobile `App.tsx:176` | 응답 필드 11개: `reservation_id` `refund_id` `status` `requested_amount` `refunded_amount` `refund_rate_bp` `hours_before_start` `reservation_status` `slot_restored` `replayed` `failure_code` `failure_message` `gateway_refund_id` |
| `GET /admin/academies/{id}/refund-policy` | admin-web `RefundPolicySettings.tsx` | 비율표 조회 |
| `PUT /admin/academies/{id}/refund-policy` | admin-web 저장 버튼 | 비율표 **전체 교체**(PATCH 아님) |

공통 헤더: `X-User-Id`(임시 인증 F7) · `Idempotency-Key`(선택).

**필드명은 전부 snake_case 다.** TypeScript 로 옮기면서 camelCase 로 바꾸고 싶어지는 자리인데, 바꾸면 mobile 이 조용히 깨진다. 계약 경계(직렬화 시점)에서는 snake_case 를 유지한다.

### 3.2 HTTP 상태 코드 규약

| 상황 | 현재 동작 | 보존 여부 |
|---|---|---|
| 타인 예약 취소 | 403 | 필수 |
| 없는 예약 | 404 | 필수 |
| 이미 취소 / 이미 시작한 수업 | 4xx (취소 경로) | 필수 |
| **preview 에서 취소 불가** | **200 + `cancellable:false` + `reason_code`** | 필수. 여기를 4xx 로 바꾸면 화면이 사유를 못 읽는다 |
| 중복 취소 요청 | **409 가 아니라 200 + `replayed:true`** | 필수. 수용 기준은 "환불이 1회만 실행되는 것"이지 "두 번째가 에러가 되는 것"이 아니다 |
| 잘못된 비율표 저장 | 422 | 코드는 유지. **응답 본문 형태는 Pydantic 과 zod 가 다르다** — `api-client.ts` 의 `extractMessage()` 가 `{"detail":[{"msg":...}]}` 를 파싱하므로 형태를 맞추거나 클라이언트를 같이 고친다 |

### 3.3 환불액 산정 — `SCH-03(환불액 산정)`

- 수업 시작까지 **24시간 이상** 남았으면 학원 비율표를 **보지 않고** 전액 환불(`FULL_REFUND_THRESHOLD_SECONDS = 86400`, 경계 포함)
- 24시간 미만이면 비율표에서 남은 시간을 만족하는 티어를 고르고, 만족하는 티어가 없으면 0%
- 비율표가 빈 배열이면 24시간 미만 전부 0% (정상 상태이고 `academies.refund_policy_tiers` 의 기본값)
- **금액은 정수 연산만 쓴다.** basis point 분모 10,000, 마지막에 올림(`_ceil_amount`), 결제액 초과 시 clamp
- 다음은 예외로 터뜨린다: 음수·비정수 결제액, tz-naive datetime, 알 수 없는 사유, 티어 구조/범위 위반(1~720시간)
- `calculate_refund()` 는 `now` 를 **주입받는다.** 내부에서 현재 시각을 읽지 않는다

### 3.4 취소 오케스트레이션 — `SCH-05(취소 오케스트레이션)`

11단계 순서가 곧 사양이다.

1. 예약 행 잠금(`SELECT ... FOR UPDATE`)
2. 소유권 검증 → 타인이면 403
3. 멱등 재생 검사 — 진행중/성공 환불이 있으면 그 결과를 그대로 반환
4. 상태 전이 검증 — 이미 취소·이미 시작/종료 거부
5. 결제 원거래 확인 → `calculate_refund()`
6. `Refund` INSERT — 유니크 위반이면 기존 행 반환
7. PG 환불 호출
8. 성공·대기면 예약 취소 확정 + `class_schedules.reserved_count -= 1` + 주문 상태 갱신
9. `refund_events` INSERT (append-only 감사 로그)
10. **commit**
11. 커밋 **이후** 슬롯 락 해제 + 회원·학원 관리자 2방향 알림

보존해야 할 판단 4가지:

- **10번과 11번의 순서.** 롤백될지 모르는 트랜잭션을 근거로 "취소됐습니다"를 보내지 않는다. 반대로 푸시 장애가 확정된 환불을 되돌려서도 안 된다.
- **PG 실패 시 예약을 취소하지 않는다.** `Refund` 를 `failed` 로 남기고 예약·정원은 그대로 둔다. `failed` 는 부분 유니크 인덱스 밖이라 회원이 재시도할 수 있다. 환불도 안 됐는데 좌석까지 없애면 돈도 자리도 잃는다.
- **`pending` 은 실패가 아니다.** 가상계좌 환불은 별도 송금이라 즉시 끝나지 않는데, 그동안 좌석을 묶어둘 이유가 없다. `pending` 에서도 좌석은 반납되고 예약은 취소 확정된다.
- **`Idempotency-Key` 는 선택.** 생략하면 `sha256("cancel:" + reservation_id)` 로 결정적 키를 만든다. 헤더를 안 보내는 클라이언트도 이중 환불을 낼 수 없다.

### 3.5 어댑터 3종 — `SCH-04(어댑터 3종)`

- **PG**: `RefundStatus`(succeeded/pending/failed) · `PaymentMethod`(virtual_account/card) · `RefundAccount`/`RefundRequest`/`RefundResult` · `parse_portone_cancel_response()` · 미지원 수단 예외 · `FakePaymentGateway` 의 결정적 ID 생성과 인메모리 멱등 원장
- **알림**: `NotificationAudience` 2종(회원·학원 관리자) · `NotificationEvent` · `FakeNotificationSender` 의 발송 기록
- **슬롯 락**: `slot_lock_key()` · `RedisSlotLock` — **Redis 가 꺼져 있어도 죽지 않는다**(경고 로그 + `False` 반환, 서비스는 그 반환값으로 분기하지 않음) · `NullSlotLock`

세 어댑터 모두 **구상 클래스가 아니라 인터페이스로 주입된다.** 이 경계가 무너지면 테스트에서 갈아끼울 수 없어진다.

### 3.6 DB 스키마와 제약 — `SCH-02(도메인 모델)`

테이블 7개: `academies` `orders` `class_schedules` `payments` `reservations` `refunds` `refund_events`.

반드시 살아남아야 하는 제약:

| 제약 | 무엇을 막나 |
|---|---|
| `uq_refunds_reservation_id_active` — `UNIQUE (reservation_id) WHERE status <> 'failed'` | **이중 환불.** 부분 인덱스라 실패 건 재시도는 허용 |
| `refunds.idempotency_key` UNIQUE | 같은 키의 중복 실행 |
| `ck_refunds_*` — 상태·사유 값 집합, 금액 0 이상, 환불액 ≤ 요청액 | 잘못된 금액 이동 |
| `ck_class_schedules_*` — `capacity > 0`, `reserved_count` 범위 | 정원 초과·음수 |
| `academies.refund_policy_tiers` JSONB `DEFAULT '[]'::jsonb` | 비율표 미설정 학원의 기본 동작 |
| `refund_events` ON DELETE CASCADE, `updated_at` 없음 | append-only 감사 로그 성격 |
| 모든 타임스탬프 `timezone=True` | tz-naive 유입 |

인덱스 8개(`ix_orders_user_id`, `ix_class_schedules_academy_id`, `ix_payments_order_id`, `ix_reservations_{order_id,class_schedule_id,user_id}`, `ix_refunds_{reservation_id,payment_id}`, `ix_refund_events_refund_id`)도 함께 옮긴다.

### 3.7 admin-web 화면 — `SCH-08(admin-web 환불 비율표)`

화면 자체는 이미 Next.js 라 그대로 남지만, **`lib/api-client.ts` 의 호출 대상이 외부 FastAPI 에서 같은 앱의 Route Handler 로 바뀐다.** `API_BASE_URL` 기본값 `http://localhost:8000` 이 의미를 잃는다. 비율표 저장이 전체 교체(PUT)라는 성격, 정렬·중복·범위 검증은 그대로 보존한다.

---

## 4. 수용 기준 (Acceptance Criteria)

> "pytest 159개를 TS 159개로" 가 아니라 **어떤 동작이 보존됐는지**로 판정한다. 159 는 `parametrize` 16곳이 펼쳐진 실행 건수라 재현 대상이 아니다. 실제 테스트 함수는 118개이고, TS 로 옮기면 개수는 달라질 수밖에 없다.

### 4.1 빌드·타입 (게이트 — 여기가 막히면 나머지는 의미 없다)

- [ ] `cd admin-web && npx next build` 가 exit 0 으로 끝난다
- [ ] `cd mobile && npx tsc --noEmit` 가 exit 0 으로 끝난다 (mobile 소스는 고치지 않았으므로 계약 유지의 증거)
- [ ] `npm run lint` 는 **판정 대상이 아니다** — eslint-config-next 16 × eslint 9 순환 설정으로 이미 깨져 있다(별도 사유). 이번에 고치지 않는다
- [ ] `new PrismaClient()` 가 코드베이스 어디에도 없다 (`grep -rn "new PrismaClient" admin-web --exclude-dir=node_modules` 가 0건)
- [ ] `@prisma/client` 를 import 하는 코드가 없다 — 런타임은 `@prisma/orm-postgres` 뿐이다

### 4.2 스키마·마이그레이션

- [ ] `prisma migration` 적용 후 `kdance` DB 에 테이블 7개가 생긴다 (psql 또는 `mcp__postgres-kdance__query` 로 확인)
- [ ] 부분 유니크 인덱스 `uq_refunds_reservation_id_active` 가 **`WHERE status <> 'failed'` 조건까지 포함해** 실제로 생성된다 (`pg_indexes.indexdef` 로 확인)
- [ ] CHECK 제약이 `0001_initial_domain.py` 와 같은 값 집합으로 존재한다 (`pg_constraint` 조회)
- [ ] 같은 `reservation_id` 로 `status='pending'` 환불을 2건 INSERT 하면 **DB 가 거부한다**
- [ ] 같은 `reservation_id` 로 `status='failed'` 환불은 2건 이상 들어간다
- [ ] 되돌리기(rollback) 경로가 동작한다 — Alembic `downgrade` 에 대응하는 절차가 있고 실행된다

### 4.3 환불액 산정 (순수 함수 — 가장 촘촘히 검증한다)

- [ ] 남은 시간 **24:00:01** → 전액 환불
- [ ] 남은 시간 **정확히 24:00:00** → 전액 환불 (경계 포함)
- [ ] 남은 시간 **23:59:59** → 비율표 적용
- [ ] 비율표가 빈 배열이고 24시간 미만 → 환불액 0
- [ ] 티어 여러 개가 있을 때 남은 시간을 만족하는 티어가 선택된다
- [ ] 만족하는 티어가 없으면 0%
- [ ] 나누어떨어지지 않는 금액이 **올림**된다 (내림·반올림이 아니다)
- [ ] 어떤 입력으로도 환불액이 결제액을 넘지 않는다
- [ ] 계산 경로에 부동소수 연산이 없다 (`Number` 나눗셈이 아닌 정수 연산)
- [ ] 음수 결제액 · tz 정보 없는 시각 · 범위 밖 티어(0시간, 721시간) · 중복 티어가 전부 예외로 거부된다
- [ ] `now` 를 주입하지 않으면 계산이 불가능하다 (함수가 시계를 직접 읽지 않는다)

### 4.4 취소 오케스트레이션

- [ ] 정상 취소 시 예약이 취소 확정되고 `reserved_count` 가 1 줄고 `Refund` 가 `succeeded` 로 남는다
- [ ] 타인 예약 취소는 403 이고 **DB 가 전혀 바뀌지 않는다**
- [ ] 이미 취소된 예약, 이미 시작한 수업은 거부된다
- [ ] **같은 요청을 2회 보내면 두 번째가 200 + `replayed:true` 로 같은 `refund_id` 를 돌려주고, PG 호출은 1회만 일어난다**
- [ ] `Idempotency-Key` 헤더 없이 2회 보내도 결과가 같다 (결정적 키 생성이 동작한다)
- [ ] PG 가 실패를 돌려주면 `Refund` 가 `failed` 로 남고 **예약 상태와 `reserved_count` 는 그대로다**, 이어서 재시도하면 성공한다
- [ ] PG 가 `pending` 을 돌려주면 좌석은 반납되고 예약은 취소 확정된다
- [ ] 취소 1건마다 `refund_events` 에 감사 로그가 남는다
- [ ] 슬롯 락 해제와 알림이 **커밋 이후에** 일어난다 (커밋 전 실행을 잡아내는 테스트가 있다)
- [ ] Redis 가 꺼져 있어도 취소가 성공한다
- [ ] 동시에 취소 요청 2건이 들어와도 환불은 1회만 실행된다

### 4.5 preview

- [ ] preview 는 DB 에 아무것도 쓰지 않는다
- [ ] 취소 불가 상태에서도 **200** 으로 금액과 `reason_code` 를 함께 돌려준다
- [ ] 없는 예약은 404, 타인 예약은 403

### 4.6 어댑터

- [ ] PortOne 취소 응답 파서가 기존과 같은 `RefundResult` 를 만든다 (성공·실패·시각 파싱 포함)
- [ ] 미지원 결제수단은 예외로 거부된다
- [ ] 가상계좌 환불에 환불계좌(은행·계좌번호·예금주)가 요구되고, 카드는 요구되지 않는다
- [ ] 알림이 회원·학원 관리자 2방향으로 발송된다
- [ ] Redis 연결 실패가 예외가 아니라 경고 로그 + `False` 로 흡수된다

### 4.7 admin 비율표

- [ ] 조회가 빈 비율표를 정상으로 돌려준다
- [ ] PUT 이 비율표를 **통째로 교체**한다
- [ ] 정렬 위반·중복 시간·범위 밖 값이 422 로 거부된다
- [ ] 저장 후 다시 조회하면 저장한 값이 그대로 나온다 (JSONB 갱신이 조용히 누락되지 않는다)

### 4.8 통합

- [ ] admin-web 의 비율표 화면이 새 Route Handler 를 상대로 조회·저장에 성공한다 (브라우저 또는 Playwright 확인)
- [ ] mobile 의 `App.tsx` 가 기대하는 필드명이 실제 응답에 전부 존재한다 (응답 JSON 대조)
- [ ] 테스트 러너가 `package.json` 에 **명시 선언**되어 있고 `npm test` 로 실행된다 (transitive 의존에 기대지 않는다)

---

## 5. 제약 조건

### 5.1 request.md 「반드시 지킬 제약」 5개 (원문 그대로 옮김)

1. **Prisma 8 은 계약 기반이다.** `new PrismaClient()` 를 쓰지 않는다 — 8 에 그 API 가 없다. 런타임은 `@prisma/client` 가 아니라 `@prisma/orm-postgres`. 형태: `postgres<Contract>({ contractJson, url })`. 스캐폴딩: `prisma orm init --target postgres --authoring psl`.
2. **인증은 Better Auth + kysely/pg 직결.** prisma 어댑터를 쓰지 않는다(`@better-auth/prisma-adapter` 는 Prisma 7 API 전제. better-auth 의 정식 dependency 라 설치는 되지만 설정에서 고르지 않으면 쓰이지 않는다). 쓸 것: `@better-auth/kysely-adapter`(`createKyselyAdapter` · `getPostgresSchema` 확인됨). `package.json` 의 `overrides {"better-auth":{"prisma":"$prisma"}}` 는 설치 충돌 회피용 — 지우면 `npm install` 이 ERESOLVE 로 깨진다.
3. **검증은 `npx next build`.** admin-web 의 `npm run lint` 는 별도 사유(eslint-config-next 16 × eslint 9 순환 설정)로 이미 깨져 있다. mobile 은 `npx tsc --noEmit`.
4. **버전을 기억으로 쓰지 않는다.** `package.json` · `node_modules` · `npm view dist-tags` 에서 읽는다.
5. **mobile 은 범위 밖.** Expo 58.0.0-preview.3 + RN 0.88.0-rc.0. API 계약만 유지한다.

### 5.2 이번 분석에서 추가로 확인한 제약

6. **금액은 정수(원)로만 다룬다.** 전환 과정에서 `Number` 부동소수가 끼어들 자리가 새로 생긴다 — Python `int` 는 임의 정밀도인데 JS `number` 는 배정밀도 부동소수다. basis point 곱셈·올림 경로에서 특히 주의한다. 현재 금액 범위(원 단위 결제액)는 `Number.MAX_SAFE_INTEGER` 안에 충분히 들어가지만, 나눗셈 결과를 그대로 쓰지 않고 정수 연산으로 유지해야 한다.
7. **snake_case API 계약을 유지한다.** §3.1 참고.
8. **`_workspace/` 기록과 하네스 9단계, ECC 를 그대로 쓴다** (「11-3」 유지 항목).
9. **단계마다 `next build` 로 그린을 확인할 수 있는 순서로 쪼갠다** (request.md 「진행 방식」). Phase 3(구현 계획)/4 의 설계 조건이다.
10. **Phase 4(Task 분리) 까지 나온 뒤 사용자 승인을 받고 Phase 5(구현) 로 들어간다.**

### 5.3 기존 정책 문서와의 충돌 여부

| 문서 | 확인 결과 |
|---|---|
| `docs/policy/pricing-policy.md` | 충돌 없음. 이번 작업은 금액 정책을 바꾸지 않는다 |
| `docs/policy/payment-method-policy.md` | 충돌 없음. 무료 API 우선 원칙도 그대로 — 새 유료 API 를 도입하지 않는다 |
| `docs/policy/admin-input-policy.md` | 직접 관련 없음 |
| `docs/policy/distribution-policy.md` | 직접 관련 없음 |
| `docs/planning/kdancex4_service_definition_and_tech_stack.md` 「11-3」 | **이 작업의 근거 문서다.** 충돌이 아니라 이행 |

**상충하는 정책은 발견되지 않았다.** 다만 「11-3」이 "배포: 로컬 Docker → Vercel" 을 적어 둔 것과 Redis 슬롯 락(`kdance-redis`, localhost:6380)이 로컬 컨테이너라는 점이 장기적으로 어긋난다(§8 Q6).

---

## 6. 비범위 (Out of Scope)

| 항목 | 이유 |
|---|---|
| mobile 소스 수정 | request.md 제약 5 |
| 예약 생성 · 결제 생성 API | 직전 회차에서 범위 밖 확정. 전환이 범위를 넓히지 않는다 |
| 부분 취소 · 학원 귀책 취소 | 직전 회차 Q5 에서 제외 확정 |
| 실 PG 연동 | Fake 어댑터 그대로 이관 |
| Vercel 실제 배포 | 전환과 분리. 이번 검증선은 로컬 `next build` |
| `npm run lint` 수정 | 별도 사유로 깨진 건이라 같이 건드리면 원인 분리가 안 된다 |
| pgvector · RAG · LangGraph 배선 | 스택 표에는 있지만 이번 전환 대상이 아니다 |
| `admin-web` 화면 디자인 변경 | 호출 대상만 바뀐다 |

---

## 7. 리스크

| ID | 리스크 | 근거 | 영향 |
|---|---|---|---|
| **R1** | **RC 2개를 동시에 쓴다** — Prisma 8.0.0-rc.15 / Expo 58.0.0-preview.3 + RN 0.88.0-rc.0 | 「11-2」에 "감수"로 기록됨 | 안정판 전까지 breaking change 가 올 수 있다. Prisma 쪽은 이번 작업의 심장이라 직격 |
| **R2** | **Prisma 8 의 트랜잭션·행 잠금 API 미검증** | `services/cancellation.py` 는 `SELECT ... FOR UPDATE` + 단일 트랜잭션 경계 위에 서 있다. Prisma 8 계약 기반 런타임이 이를 어떻게 표현하는지 이 프로젝트에서 돌려본 적이 없다 | **전환의 최대 단일 리스크.** 못 쓰면 §3.4 의 멱등성 3겹 방어 중 1겹이 사라진다. Phase 2(기존 코드 구조 확인)/3 에서 가장 먼저 확인할 것 |
| **R3** | **부분 유니크 인덱스·CHECK 제약의 PSL 표현 미검증** | `WHERE status <> 'failed'` 부분 인덱스가 이중 환불을 구조적으로 막는 장치다 | PSL 로 표현이 안 되면 raw SQL 마이그레이션을 따로 얹어야 한다. 빠뜨리면 **이중 환불이 가능해진다** |
| **R4** | **Better Auth 런타임 미검증** | 「11-2」 — 설치·import 는 확인했지만 세션·스키마 생성·로그인 흐름을 돌려보지 않았다 | 인증을 이번 전환에 포함하면(§8 Q5) 미검증 영역이 전환의 임계 경로에 들어온다 |
| **R5** | **테스트 러너가 transitive 다** | 실측: `vitest@4.1.11` 은 `better-auth` 의 의존성으로만 들어와 있고 `package.json` 에 없다. `pg@8.22.0`·`kysely@0.29.6` 도 마찬가지 | better-auth 가 의존성을 바꾸면 테스트 인프라가 사라진다. 명시 선언 필요 |
| **R6** | **프로세스 싱글턴 전제가 서버리스에서 깨진다** | `deps.py` 가 `@lru_cache` 로 어댑터를 프로세스 싱글턴으로 잡는다. `FakePaymentGateway` 의 멱등 원장이 **인메모리**라, 요청마다 새로 만들면 재시도가 매번 "처음 호출"로 보인다 | Vercel 서버리스는 인스턴스가 여러 개다. 멱등성의 실제 권위는 DB 제약이므로 치명적이진 않지만, **Fake 어댑터 기반 테스트가 환경에 따라 다르게 나올 수 있다** |
| **R7** | **`SCH-01(기반 배선)`~`SCH-07(통합 테스트 작성)` 가이드의 대상이 사라진다** | 7개 HTML(224KB, git 추적 중)이 전부 FastAPI 코드를 줄 단위로 설명한다. `_workspace/SCH_kdance.html` 의 진행표도 같은 코드를 가리킨다 | 방치하면 **틀린 설명을 가리키는 문서가 git 에 남는다.** 왕초보 학습 계층이 무너진다. §8 Q2 |
| **R8** | **검증선이 `next build` 하나뿐이다** | lint 가 깨져 있고 TypeScript 7 은 메이저 1단계 앞선다(「11-2」 — "순서 분리") | 타입 오류 외의 회귀를 잡을 그물이 얇다. 테스트를 일찍 세워야 한다 |
| **R9** | **Pydantic 422 응답 형태가 바뀐다** | `api-client.ts` 의 `extractMessage()` 가 `{"detail":[{"msg":...}]}` 를 파싱한다 | 조용한 회귀. 화면에 에러 메시지가 안 뜨는 형태로 나타난다 |
| **R10** | **한 번에 다 옮기면 원인 분리가 안 된다** | 7,335줄 · 계층 11개 | request.md 「진행 방식」이 이미 대응책을 지시했다(단계마다 `next build` 그린) |

---

## 8. 미해결 질문 — 사용자 결정 필요

> `AskUserQuestion` 은 오케스트레이터가 호출한다. 여기서는 선택지와 각 선택의 결과만 정리한다.
> **Q1~Q3 은 BLOCKING** — Phase 3(구현 계획) 착수 전에 답이 필요하다. Q4~Q8 은 늦어도 Phase 4(Task 분리) 이전.

### Q1. 기존 `backend/` 를 삭제하나, 참조용으로 남기나? (BLOCKING)

git 추적 파일 47개(`.venv` 제외), 소스 7,335줄.

- **A안 — 즉시 삭제.** 진실의 원천이 하나가 된다. 두 스택이 공존하는 혼란이 없다. 되돌리려면 git 이력을 뒤져야 한다.
- **B안 — 이관 완료까지 남기고 마지막에 삭제.** 이관 중 "원래 어떻게 동작했나"를 바로 옆에서 읽을 수 있다. 전환 기간 동안 `pytest` 로 기준 동작을 재확인할 수 있다. 대신 중간 상태에서 어느 쪽이 진짜인지 헷갈릴 여지가 있다.
- **C안 — `backend_legacy/` 로 옮겨 영구 보존.** 학습 자료로 남는다. 저장소에 죽은 코드가 쌓인다.

분석자 의견: **B안**. Prisma 8 의 트랜잭션 API 가 미검증(R2(Prisma 8 트랜잭션·행 잠금 미검증))이라, 이관 중 동작을 대조할 원본이 옆에 있는 편이 안전하다. 마지막 단계에서 삭제 여부를 다시 묻는다.

### Q2. `SCH-01(기반 배선)`~`SCH-07(통합 테스트 작성)` 과 그 가이드를 어떻게 하나? (BLOCKING)

대상: `_workspace/guides/` 의 7개 HTML(git 추적 중) + `_workspace/SCH_kdance.html` 의 진행표 + 각 소스 파일 안의 학습 주석.

- **A안 — 폐기.** 가이드를 지우고 SCH 번호를 새로 시작한다. 가장 깨끗하지만 224KB 분량의 학습 자산이 사라진다.
- **B안 — "FastAPI 시절 기록"으로 보존 + 헤더에 경고 배너.** 문서를 남기되 "이 코드는 2026-09-20 전환으로 대체됐다"를 각 가이드 상단에 명시한다. 왜 전환했는지의 맥락이 같이 남는다.
- **C안 — TypeScript 버전으로 재작성.** 학습 계층이 온전히 유지되지만 Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 재실행 비용이 7건 곱하기로 든다.
- **D안 — B + 전환 자체를 새 SCH 로 기록.** 기존 7개는 보존·배너 처리하고, 전환 작업을 `SCH-21(FastAPI→Next.js 전환)` 같은 새 번호로 문서화한다.

분석자 의견: **D안**. 전환의 판단 근거(왜 옮겼나, 무엇이 달라졌나)가 가장 값진 학습 자료인데, A안은 그걸 통째로 버리고 C안은 그걸 못 담는다.

### Q3. 전환 중 FastAPI 를 계속 동작 가능한 상태로 두나? (BLOCKING)

- **A안 — 병행 운영.** 전환이 끝날 때까지 `backend` 가 계속 뜨고, mobile 은 그쪽을 본다. 계층별로 하나씩 옮기며 양쪽 응답을 대조할 수 있다. 대신 DB 스키마를 Prisma 가 소유하는 시점부터 두 접근 계층이 같은 테이블을 본다 — **DB 테이블이 현재 0개라 이 충돌은 아직 실재하지 않는다.**
- **B안 — 끊고 갈아타기.** `backend` 를 멈추고 한 번에 옮긴다. 중간 상태가 단순하지만, 다 옮길 때까지 아무것도 돌지 않는다. `next build` 그린 단위로 쪼개라는 request.md 지시와는 맞물린다(빌드 그린과 서비스 동작은 다른 얘기다).

분석자 의견: **A안에 가깝되 느슨하게.** DB 가 비어 있어 충돌 위험이 실질적으로 없고, Q1-B(원본 보존)와 짝이 맞는다. 다만 "운영"이랄 것이 없는 개발 단계이므로, `backend` 를 띄워 두되 mobile 의 기본 대상은 전환이 끝나는 시점에 한 번에 옮긴다.

### Q4. API 경로에 `/api` 접두어가 붙는 것을 받아들이나?

Next.js Route Handler 의 관례 경로는 `app/api/reservations/[id]/cancel/route.ts` → `/api/reservations/{id}/cancel` 이다. 현재 계약은 접두어가 없다(`/reservations/...`).

- **A안 — 접두어 수용.** mobile 의 `EXPO_PUBLIC_API_URL` 에 `/api` 를 포함시킨다. mobile 소스는 안 고쳐도 되지만(§2.3 유지), 환경변수 값이 바뀐다.
- **B안 — rewrite 로 기존 경로 유지.** `next.config` 에서 `/reservations/*` → `/api/reservations/*` 로 넘긴다. 계약이 문자 단위로 보존되지만 배선이 한 겹 늘어난다.

### Q5. 인증(Better Auth)을 이번 전환에 포함하나?

현재는 `X-User-Id` 평문 헤더 하나로 신원을 주장하는 임시 구현(F7)이고, 코드에 "프로덕션 전 반드시 교체" 경고가 붙어 있다.

- **A안 — F7 을 그대로 옮긴다.** 전환의 범위가 "같은 동작을 다른 언어로"에 머문다. 미검증 영역(R4(Better Auth 런타임 미검증))이 임계 경로에 안 들어온다.
- **B안 — 이 기회에 Better Auth 를 넣는다.** 어차피 해야 할 일이고 스택 표에도 있다. 대신 **미검증 컴포넌트가 전환의 성공 판정에 끼어든다.**

분석자 의견: **A안.** 전환과 신규 도입을 같은 단계에 섞으면 실패했을 때 원인이 어느 쪽인지 알 수 없다. Better Auth 는 전환이 그린이 된 다음 별건으로 올린다.

### Q6. Redis 슬롯 락을 어떻게 하나?

현재 `infra/docker-compose.yml` 의 `kdance-redis`(localhost:6380). 「11-3」의 배포 목표는 Vercel 이라 로컬 컨테이너를 그대로 쓸 수 없다.

- **A안 — 로컬 Redis 유지.** 이번 전환은 접근 계층 교체에만 집중. 배포 시점에 다시 본다.
- **B안 — 관리형 Redis 로 전환.** 새 외부 의존이 생긴다 — `payment-method-policy.md` 의 무료 API 우선 원칙과 대조가 필요하다.
- **C안 — 이번엔 DB 정원 복구만 남기고 락은 `NullSlotLock` 으로.** `RedisSlotLock` 은 이미 Redis 가 꺼져 있어도 안전하게 설계돼 있다(§3.5).

분석자 의견: **A안.** 배포는 이번 범위 밖이고(§2.3), 전환 중에 인프라까지 같이 바꾸면 R10(한 번에 이관 시 원인 분리 불가) 이 커진다.

### Q7. 테스트 전략 — DB 통합 테스트를 어떻게 돌리나?

현재 `backend/tests/conftest.py`(491줄)가 별도 테스트 DB(`kdance_test`)를 쓴다.

- **A안 — 같은 방식.** 테스트용 DB 를 따로 두고 마이그레이션을 걸어 쓴다.
- **B안 — 트랜잭션 롤백 격리.** 테스트마다 트랜잭션을 열고 끝에 롤백한다. 빠르지만 Prisma 8 의 트랜잭션 API 에 의존한다(R2(Prisma 8 트랜잭션·행 잠금 미검증) 와 같은 미지).
- **C안 — 순수 로직만 유닛 테스트, DB 경로는 최소.** 가장 빠르게 그린을 볼 수 있지만 §4.2·§4.4 의 수용 기준 상당수를 못 채운다.

아울러 러너를 `package.json` 에 명시 선언할 것(R5(테스트 러너 transitive)). 현재 `vitest@4.1.11` 은 better-auth 의 transitive 다.

### Q8. `FakePaymentGateway` 의 인메모리 멱등 원장을 어떻게 하나? (R6(프로세스 싱글턴 서버리스 붕괴))

- **A안 — 그대로 이관하고 한계를 문서화.** 멱등성의 실제 권위는 DB 제약이므로 기능적으로는 성립한다.
- **B안 — Fake 의 원장도 DB 로 옮긴다.** 환경에 무관하게 같은 동작이 나오지만 Fake 가 무거워진다.

---

## 9. Phase 2(code-searcher) 인계 사항

탐색 범위는 **`backend/`(읽기 전용) + `admin-web/`** 이다. mobile 은 `App.tsx` 의 API 호출부만 확인하면 된다.

우선순위:

1. **`backend/app/services/cancellation.py`(1,069줄)를 트랜잭션 경계 기준으로 해부한다.** 어디서 세션이 열리고 닫히는지, `FOR UPDATE` 가 걸리는 지점, 유니크 위반을 잡아내는 `except` 위치, 커밋 이후 부수효과 2건의 경계. **이 파일이 전환 난이도를 혼자 결정한다.**
2. **`admin-web/node_modules/@prisma/orm-postgres` 의 실제 타입 정의를 읽는다.** 트랜잭션·행 잠금·raw SQL 지원 여부(R2(Prisma 8 트랜잭션·행 잠금 미검증)·R3(부분 유니크 인덱스 PSL 표현 미검증)). 기억이나 문서가 아니라 설치된 `.d.ts` 를 본다. 필요하면 context7 로 Prisma 8 문서를 함께 확인한다.
3. **`admin-web/node_modules/next/dist/docs/`** 를 확인한다 — `docs/agent/ai-coding-agent.html` 에 따르면 Next 16.3 이 설치 버전에 맞춘 문서를 동봉하고, `admin-web/AGENTS.md` 가 "코드를 쓰기 전에 이걸 읽어라"고 지시한다.
4. `backend/tests/conftest.py`(491줄)의 픽스처 구조 — TS 에서 무엇을 재현해야 하는지의 목록이다.
5. `backend/app/adapters/payment_gateway.py`(526줄)의 `parse_portone_cancel_response()` — 유일한 프로덕션 코드 부분.
6. `admin-web/lib/api-client.ts` 와 `components/RefundPolicySettings.tsx` — 호출 대상이 바뀔 때 같이 고쳐야 할 지점.
7. `admin-web/eslint.config.mjs` 는 **건드리지 않는다.** 깨진 상태 그대로 둔다(제약 3).

탐색하지 않아도 되는 것: `backend/.venv/`, `admin-web/.next/`, `admin-web/node_modules/` 중 위 2·3번 외 영역.

---

## 오케스트레이터 결정 기록 (2026-09-20, 사용자 확인 완료)

BLOCKING 질문 Q1~Q3 이 해소되었다. Phase 3(구현 계획) 착수 가능.

| 질문 | 결정 | 내용 |
|---|---|---|
| Q1. 기존 `backend/` | **B** | 이관 완료까지 남기고 **마지막에 삭제**. 작업 중에는 읽기 전용으로만 참조한다. R2(Prisma 8 트랜잭션·행 잠금 미검증) 때문에 대조할 원본이 필요하다 |
| Q2. SCH-01~07 과 가이드 | **D** | 기존 7개는 **보존 + 경고 배너**("이 코드는 2026-09-20 에 Next.js + Prisma 8 로 교체됨"). 전환 작업 자체를 **`SCH-21(FastAPI→Next.js 전환)`** 로 새로 기록한다 |
| Q3. 병행 운영 | **A** | 전환이 끝날 때까지 FastAPI 를 **동작 가능한 상태로 유지**한다. DB 테이블이 0개라 두 접근 계층이 아직 충돌하지 않는다 |

### 결정이 후속 Phase 에 거는 제약

- **`backend/` 는 읽기 전용이다.** Phase 5(구현)에서 `backend/` 의 파일을 수정·삭제하지 않는다.
  삭제는 전환 완료 후 사용자 승인을 받아 별도로 수행한다.
- **FastAPI 가 계속 떠야 한다.** 전환 중 `backend/` 의 의존성·설정을 깨뜨리는 변경을 하지 않는다.
- **`SCH-21(FastAPI→Next.js 전환)`** 을 `_workspace/SCH_kdance.html` 에 신규 항목으로 추가해야 한다.
  Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 에서 이 SCH 기준으로 산출물 3종(학습 주석 · 사람용 HTML 가이드 · 에이전트용 `.md`)을 만든다.
- 기존 가이드 7개에 경고 배너를 추가하는 작업이 범위에 포함된다.

### 아직 남은 질문 (Phase 4(Task 분리) 이전 필요)

Q4(`/api` 접두어) · Q5(인증 포함 여부) · Q6(Redis 슬롯 락) · Q7(DB 테스트 전략) ·
Q8(`FakePaymentGateway` 멱등 원장)은 미해결이다. Phase 3(구현 계획) 결과를 본 뒤 함께 확인한다.

### 오케스트레이터가 독립 검증한 항목 (2026-09-20)

| 주장 | 검증 결과 |
|---|---|
| `backend/app` 3,963줄 · `tests` 2,881줄 | 일치 |
| 테스트 함수 118개 (159 는 parametrize 전개 결과) | 일치 |
| `vitest`·`kysely`·`pg` 가 transitive (R5(테스트 러너 transitive)) | **일치** — 설치본 vitest 4.1.11 · kysely 0.29.6 · pg 8.22.0, `package.json` 선언은 `@types/pg` 하나뿐 |
