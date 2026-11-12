# Phase 3(구현 계획) 산출물 — 데이터 모델

- 작성 2026-11-06 · 짝 문서: `03_impl-planner_plan.md`(결정 근거) · `03_contracts/`(API) · `03_research.md`(미확인 실측 계획)
- 대상: 이관 7테이블(academies·orders·class_schedules·payments·reservations·refunds·refund_events) + US1-A(가입~결제 확정) 신규 테이블
- 계약 원본은 Phase 5(구현)에서 `admin-web/prisma/contract.prisma`(PSL) 한 파일로 만든다. 이 문서는 그 파일의 **설계도**다 — PSL 문법은 설치본 `@prisma/orm-postgres/skills/prisma-8/references/contract.md` 를 따른다
- **공유 계약 번호 §4.1(상태·구분 값 집합)·§4.4(환불 비율표 JSONB 형태)는 기존 backend 주석이 인용하는 번호를 그대로 잇는다**(`backend/app/models/refund.py` 등). 새 번호는 §4.6 부터 붙인다. 전체 목록은 plan §3

---

## 0. 공통 규칙

| 항목 | 규칙 | 근거 |
|---|---|---|
| DB | 이관 기간에는 **새 DB `kdance_next`(개발)·`kdance_next_test`(테스트)** 에 만든다. 기존 `kdance`·`kdance_test` 는 backend 가 계속 쓴다 | plan 결정 D1·D13 — R3(두 접근 계층이 한 DB 에 공존) 제거 |
| 스키마(namespace) | 제품 테이블은 전부 `public`. Better Auth 테이블은 `auth` 스키마, 계약에는 `@@control(external)` 로만 선언 | D10 |
| PK | `uuid`. 앱에서 UUIDv7 문자열을 만든다(`@default(uuid())` 가 DB 기본값인지는 미확인 — research R-05). 기존처럼 DB 서버 기본값에 기대지 않는다 | Phase 2 A-1 |
| 상태·구분 값 | **text + CHECK**(PSL `enum` + `@@type("pg/text@1")` → 플래너가 CHECK 생성). 값 집합은 §4.1 | Phase 2 A-5 |
| 제약 이름 | 손으로 쓰는 CHECK·인덱스는 `name:` 에 **옛 이름을 접두어로** 준다(예: `uq_refunds_reservation_id_active` → 실제 이름 `uq_refunds_reservation_id_active_<8자리 해시>`). `map:` 은 쓰지 않는다 | D1 — `map:` 은 바이트 비교라 새로 쓰는 식에는 가짜 drift 를 낸다(contract.md) |
| 시각 | `Timestamptz` → 런타임 `Temporal.Instant`. 날짜만 필요한 칸은 `Date` → `Temporal.PlainDate`, 시각만은 `Time` → `Temporal.PlainTime`. Node 24 라 `import 'temporal-polyfill/full/global'` 를 첫 쿼리 전에 | contract.md 「Temporal columns」 |
| 금액 | `Int`(int4), 원 단위 정수, 모든 금액 칸에 `>= 0` CHECK | FR-283(결제액 계산 순서) |
| created_at / updated_at | `created_at` 은 DB 기본값 `now()`. `updated_at` 은 **앱이 쓰기마다 직접 넣는다**(Prisma 8 자동 갱신 속성 미확인 — R-06) | Phase 2 A-5 |
| FK 삭제 동작 | 이관 테이블은 기존과 같이 `Cascade`. 신규 테이블은 기본 `Restrict`(돈·이력은 연쇄 삭제하지 않는다) | contract.md(기본 Restrict) |

---

## 1. 엔티티 목록

| # | 테이블 | 구분 | 한 줄 |
|---|---|---|---|
| 1 | `academies` | 이관(+칸) | 학원. 비율표 JSONB 유지(§4.4) + 지역·대표 |
| 2 | `refund_notice_versions` | 신규 | 학원 환불·취소 공지 판본(FR-284(주문 시점 값 고정)) |
| 3 | `members` | 신규 | 회원 = 본인확인 1인(FR-003(본인확인 계정 식별)) |
| 4 | `member_interest_genres` | 신규 | 관심 장르(필수·복수, FR-022(사용자 프로필)) |
| 5 | `member_regions` | 신규 | 관심 지역(선택·복수) |
| 6 | `classes` | 신규 | 수업(장르·구분·자리 방식) |
| 7 | `class_offerings` | 신규 — **`class_schedules` 대체** | 신청·결제 단위(정규 = 기간, 원데이 = 회차 1개, FR-052a(회차·기간 신청 단위)) |
| 8 | `class_sessions` | 신규 — **`class_schedules` 대체** | 회차(시작·끝 시각) |
| 9 | `seat_pools` | 신규 — **`class_schedules.capacity/reserved_count` 대체** | 자리 묶음(남·여·구분없음)별 정원과 잡힌 수 |
| 10 | `orders` | 이관(+칸·상태 확장) | 주문 = 돈. 금액·공지 판본 고정 |
| 11 | `order_events` | 신규 | 주문 상태 전이 감사 기록(FR-298(주문 상태 6종)) |
| 12 | `payments` | 이관(+상태·기한) | PG 거래 1건 |
| 13 | `payment_webhook_events` | 신규 | 웹훅 수신 원장(FR-116(결제 통지 중복 반영 방지)) |
| 14 | `payment_exceptions` | 신규 | **돌려줄 대상(환불 대상) 기록의 유일한 자리**(FR-290(금액 불일치 입금)·FR-292(만료 뒤 늦은 입금)). `refunds` 에는 넣지 않는다 — `refunds` 는 확정 예약(`reservation_id` 필수)의 환불 원장이고, 이 돈은 확정된 예약이 없다 |
| 15 | `reservations` | 이관(+자리) | 예약 = 자리 |
| 16 | `calendar_entries` | 신규 | 내 캘린더(회차별 1행) |
| 17 | `notifications` | 신규 | 앱 내 알림 기록(FR-114(결제 확인 앱 알림)) |
| 18 | `settlement_entries` | 신규(최소형) | 정산 `hold` 적립(Q5(정산 보류 적립 포함 여부) — 2026-11-06 사용자 확정) |
| 19 | `refunds` | 이관(그대로) | 환불 |
| 20 | `refund_events` | 이관(그대로) | 환불 감사 로그 |
| — | `auth.user`·`auth.session`·`auth.account`·`auth.verification` | 외부(Better Auth 소유) | 계약에 `@@control(external)` 로 선언만 |

`class_schedules` 는 **이관하지 않고 7·8·9 로 쪼갠다.** 회차 1행 = 정원 1개 모델로는 FR-092(성별 정원)와 정규 과정 기간 신청을 담을 수 없다(Phase 2 충돌 ①②③⑧).

---

## 2. 컬럼·제약

### 2-1. 이관 테이블

| 테이블 | 컬럼(변경점만 굵게) | 제약·인덱스 |
|---|---|---|
| `academies` | id, name `varchar(200)`, refund_policy_tiers `jsonb default '[]'`(§4.4), **region_sido `text`**, **region_gu `text`**, **owner_member_id `uuid NULL` → members**, created_at, updated_at | PK. `ix_academies_region (region_sido, region_gu)` |
| `orders` | id, **member_id `uuid` → members**(옛 `user_id`), **offering_id → class_offerings**, status, **list_price_amount**, **benefit_discount_amount default 0**, **coupon_discount_amount default 0**, total_amount, **booking_fee_amount default 0**(2026-11-10 추가), **price_breakdown `jsonb`**(§4.6 줄 형태), **refund_notice_version_id → refund_notice_versions**, **intermediary_notice_version `text`**, **member_terms_version `text`**·**merchant_terms_version `text`**(2026-11-10 추가), **platform_fee_rate_bp `int`**·**cancel_fee_platform_share_bp `int`**(2026-11-10 추가, 1bp = 0.01%), **idempotency_key `varchar(200)`**, **paid_at NULL**, **closed_at NULL**, ts | `ck_orders_status`(§4.1, 6종) · 금액 5칸 `>= 0` · **`ck_orders_total_formula`: `total_amount = GREATEST(0, list_price_amount - benefit_discount_amount - coupon_discount_amount) + booking_fee_amount`**(2026-11-10 수정, 아래 §6-1) · `ck_orders_fee_rates`: 두 비율 칸 `BETWEEN 0 AND 10000`(2026-11-10 추가) · **`uq_orders_member_idempotency (member_id, idempotency_key)`** · `ix_orders_member_id` |
| `payments` | id, order_id, method, amount, paid_at NULL, gateway_payment_key NULL(PG 거래 id), **gateway_payment_id `varchar(64)`**(우리가 PG 에 주는 결제 id), **status**, **due_at `timestamptz`**, **virtual_account_bank_code NULL**, **virtual_account_number NULL**, **virtual_account_holder NULL**, **pg_reported_amount NULL**, ts | `ck_payments_method` {virtual_account, card} 유지 · **`ck_payments_status`**(§4.1) · `amount >= 0` · **`uq_payments_gateway_payment_id`** · **`uq_payments_order_live (order_id) WHERE status IN ('ready','paid')`** · `ix_payments_order_id` · **`ix_payments_status_due (status, due_at)`**(만료 정리용) |
| `reservations` | id, order_id, **offering_id**(옛 `class_schedule_id`), **seat_pool_id → seat_pools**, **seat_kind**(§4.1, 결제 시점 사본), **member_id**(옛 `user_id`), status, cancelled_at NULL, **cancel_reason NULL**, ts | `ck_reservations_status`(§4.1, 4종) · **`ck_reservations_cancel_reason`** · **`uq_reservations_member_offering_active (member_id, offering_id) WHERE status IN ('held','confirmed')`** · 인덱스 3개(order_id, offering_id, member_id) |
| `refunds` | 변경 없음 | 기존 CHECK·UNIQUE 전부, **부분 유니크 `uq_refunds_reservation_id_active ON (reservation_id) WHERE status <> 'failed'`** 유지(이중 환불 방지 핵심) |
| `refund_events` | 변경 없음(추가 전용) | 기존과 같음. `event_type` 값 6종은 앱 상수(§4.2) |

옛 `user_id` 에는 FK 가 없었다. 새 `member_id` 는 `members` FK 를 건다(Phase 2 충돌 ⑥ 해소).

### 2-2. 신규 테이블

| 테이블 | 컬럼 | 제약·인덱스 |
|---|---|---|
| `refund_notice_versions` | id, academy_id, version `int`, body `text`, created_at | `uq_refund_notice_academy_version (academy_id, version)` · `version >= 1` |
| `members` | id, auth_user_id `text`, name `text`, gender(§4.1), birth_date `date`, phone `text`, identity_ci_hash `text`, signup_notice_ack_at `timestamptz`, base_genre NULL(§4.1 genre), experience_level NULL(§4.1), available_from `time NULL`, available_to `time NULL`, ts | **`uq_members_auth_user_id`** · **`uq_members_identity_ci_hash`**(FR-003, 1인 1계정) · `ck_members_available_window`: 둘 다 NULL 이거나 둘 다 있고 from < to |
| `member_interest_genres` | member_id, genre | PK(member_id, genre) |
| `member_regions` | member_id, region_sido, region_gu | PK(member_id, region_sido, region_gu) |
| `classes` | id, academy_id, title, instructor_name `text`, genre, class_kind(§4.1, FR-051(수업 구분)), seat_mode(§4.1), ts | `ix_classes_academy_id` · `ix_classes_genre` |
| `class_offerings` | id, class_id, label `text`(예 "12월 기간"), enrollment_unit(§4.1), price_amount, first_session_starts_at, last_session_ends_at, status(§4.1), ts | `price_amount >= 0` · `last_session_ends_at > first_session_starts_at` · `ix_offerings_class_id` · `ix_offerings_start (status, first_session_starts_at)` |
| `class_sessions` | id, offering_id, seq `int`, starts_at, ends_at | `uq_sessions_offering_seq` · `ends_at > starts_at` · `ix_sessions_offering_id` |
| `seat_pools` | id, offering_id, seat_kind(§4.1), capacity, held_count default 0, confirmed_count default 0, ts | **`uq_seat_pools_offering_kind (offering_id, seat_kind)`** · `capacity > 0` · `held_count >= 0` · `confirmed_count >= 0` · **`ck_seat_pools_not_over`: `held_count + confirmed_count <= capacity`**(FR-091(정원 초과 방지) 의 DB 최후 방어선) |
| `order_events` | id, order_id, from_status NULL, to_status, reason `text`, created_at | 추가 전용. `ix_order_events_order_id` |
| `payment_webhook_events` | id, webhook_id `text`, event_type `text`, gateway_payment_id NULL, result(§4.1), payload `jsonb`, received_at | **`uq_webhook_events_webhook_id`** |
| `payment_exceptions` | id, payment_id, order_id, kind(§4.1), received_amount(PG 가 알려 준 입금액 전액), status `refund_due`(§4.1), pg_transaction_id NULL, created_at | `received_amount >= 0` · `uq_payment_exceptions_payment_kind (payment_id, kind)`(같은 통지가 다시 와도 1건) |
| `calendar_entries` | id, member_id, reservation_id, session_id, starts_at, ends_at, title `text`(사본), created_at | **`uq_calendar_member_session (member_id, session_id)`** · `ix_calendar_member_start (member_id, starts_at)` |
| `notifications` | id, recipient_member_id, kind(§4.1), order_id NULL, reservation_id NULL, payload `jsonb`, delivery_status(§4.1) default `pending`, read_at NULL, created_at | **`uq_notifications_kind_order_recipient (kind, order_id, recipient_member_id)`**(재처리해도 1건) · `ix_notifications_recipient_created` |
| `settlement_entries` | id, order_id, academy_id, kind(§4.1), amount, status(§4.1), created_at | `amount >= 0` · **`uq_settlement_order_kind (order_id, kind)`** |

---

## 3. 공유 계약 §4.1 — 상태·구분 값 집합 (text + CHECK)

기존 §4.1 의 원칙(값 집합은 DB CHECK 와 앱 상수가 **문자 단위로** 같다)을 그대로 잇는다. 새로 생긴 칸은 굵게.

| 테이블.칸 | 값 | 바뀐 점 |
|---|---|---|
| orders.status | `pending` · `paid` · `expired` · `cancelled` · `partially_refunded` · `refunded` | `expired`·`cancelled`·`partially_refunded` 추가(FR-298(주문 상태 6종)) |
| payments.method | `virtual_account` · `card` | 그대로 |
| **payments.status** | `ready` · `paid` · `expired` · `cancelled` | 신규. 옛 「`paid_at IS NOT NULL` = 결제 완료」 판정은 `status='paid'` 로 바꾼다 |
| reservations.status | `held` · `confirmed` · `cancelled` · `expired` | `expired` 추가 |
| **reservations.cancel_reason** | `member_request`(입금 뒤 회원 취소) · `self_cancel_unpaid`(FR-286(입금 전 셀프 취소)) | 신규. `expired` 는 상태로 표현하므로 사유 없음 |
| refunds.status | `succeeded` · `pending` · `failed` | 그대로 |
| refunds.reason | `member_request` | 그대로 |
| **seat_pools.seat_kind / reservations.seat_kind** | `male` · `female` · `any` | 신규. `any` = FR-092c(성별 구분 없는 단일 정원) |
| **members.gender** | `male` · `female` | 신규. 출처는 본인확인 |
| **genre**(members.base_genre, member_interest_genres.genre, classes.genre) | `dance_sport` · `argentine_tango` · `swing` · `salsa_bachata` | 신규. FR-020(장르 4종). 화면 표기는 한글 |
| **members.experience_level** | `entry` · `beginner` · `novice_intermediate` · `intermediate` · `advanced` · `dancer` | 신규. FR-029(경험 수준 구간) 6구간 |
| **classes.class_kind** | `regular` · `private_lesson` · `basic` · `lady_style` · `one_day` · `event` · `party` · `performance` · `competition` | 신규. FR-051(수업 구분) 9종. 1회차 시드는 `regular` 만 |
| **classes.seat_mode** | `gender_split` · `single` | 신규 |
| **class_offerings.enrollment_unit** | `term` · `session` | 신규. FR-052a(회차·기간 신청 단위) |
| **class_offerings.status** | `open` · `closed` | 신규 |
| **payment_webhook_events.result** | `confirmed` · `duplicate` · `rejected_signature` · `amount_mismatch` · `deposit_on_closed_order` · `ignored` | 신규 |
| **payment_exceptions.kind / status** | kind `amount_mismatch`(FR-290) · `deposit_on_closed_order`(`expired`·`cancelled` 주문에 들어온 입금, FR-292) / status `refund_due` | 신규 |
| **notifications.kind** | `payment_confirmed_member` · `payment_confirmed_owner` · `reservation_cancelled` · `refund_pending` · `refund_failed` · `payment_refund_due` | 신규. 뒤 셋은 옛 알림 이벤트 3종을 기록으로 옮긴 것 |
| **notifications.delivery_status** | `pending` · `sent` · `skipped` | 신규. 1회차는 `pending` 으로 남는다(발송은 SCH-38(알림)) |
| **settlement_entries.kind / status** | kind `payment_hold` / status `hold` | 신규 최소형. 나머지 단계는 SCH-31(정산 원장) |

**§4.2(값 소유 모듈)** — TS 에서는 값 집합을 `admin-web/lib/domain/constants.ts` 한 곳에서 `as const` 배열로 소유하고, 계약 PSL enum 과 일치하는지 단위 테스트 1개가 문자 단위로 대조한다(옛 Python enum 소유권 규칙의 TS 판).

---

## 4. 상태 전이

### 4-1. 주문(orders.status) — FR-298(주문 상태 6종)

| 현재 | 사건 | 다음 | 같은 트랜잭션에서 함께 바뀌는 것 |
|---|---|---|---|
| (없음) | 결제 시작 `POST /api/orders` | `pending` | payments `ready` 생성, reservations `held` 생성, seat_pools.held_count +1, order_events 1행 |
| `pending` | 유효한 입금 웹훅 | `paid` | payments `paid`, reservations `confirmed`, held −1 · confirmed +1, calendar_entries(회차 수만큼), notifications 2건, settlement_entries `hold` 1건, order_events (FR-289(확정 후 일괄 처리)) |
| `pending` | 기한 경과(정리 작업) | `expired` | payments `expired`, reservations `expired`, held −1 |
| `pending` | 회원 셀프 취소 | `cancelled` | payments `cancelled`, reservations `cancelled`(`self_cancel_unpaid`), held −1 |
| `expired` | 늦은 입금 웹훅(자리 유무와 상관없이) | **`expired` 유지** | payments 는 `expired` 그대로 두고 `pg_reported_amount` 만 기록 · payment_exceptions `deposit_on_closed_order`(`refund_due`, 입금액 전액) · notifications `payment_refund_due` 2건(회원·대표) · order_events 에 사유 1행(상태 전이 아님). 예약·자리·캘린더·정산은 건드리지 않는다 — FR-292(만료 뒤 늦은 입금) 2026-11-06 개정, 사용자 결정 |
| `cancelled` | 셀프 취소 뒤 입금 웹훅(계좌 폐기와 입금이 엇갈림) | **`cancelled` 유지** | 위 `expired` 행과 같은 처리 |
| `paid` | 이관 취소 API(전액) | `refunded` | 옛 SCH-05(취소 오케스트레이션) 그대로 + confirmed −1 + calendar_entries 삭제 |
| `paid` | 부분 환불 | `partially_refunded` | **1회차에서 만드는 경로 없음**(SCH-32(정규 과정 환불)) |

상태는 되돌아가지 않는다. **예외 없음** — `expired`·`cancelled` 는 끝 상태다(FR-298(주문 상태 6종), 2026-11-06 사용자 결정). 모든 전이는 `UPDATE orders SET status=:to WHERE id=:id AND status=:from` 조건부 갱신으로 하고, 영향 행이 1이 아니면 그 처리 전체를 되돌린다 — 이것이 동시 웹훅·동시 만료의 1차 방어선이다(§4.9).

### 4-2. 예약(reservations.status)

| 현재 | 다음 | 언제 |
|---|---|---|
| (없음) | `held` | 결제 시작 |
| `held` | `confirmed` · `expired` · `cancelled` | 주문이 `paid` · `expired` · `cancelled` 로 갈 때 |
| `confirmed` | `cancelled` | 이관 취소 API |

### 4-3. 결제(payments.status)

`ready` → `paid` · `expired` · `cancelled`. `expired`·`cancelled` 는 끝 상태다 — 늦은 입금이 와도 `paid` 로 바꾸지 않고 `pg_reported_amount` 만 채운다.

### 4-4. 자리 묶음 카운터(seat_pools) — 공유 계약 §4.7

| 사건 | SQL(한 문장, 조건부) | 영향 행 0 이면 |
|---|---|---|
| 자리 잡기 | `UPDATE seat_pools SET held_count = held_count + 1 WHERE id = $1 AND held_count + confirmed_count < capacity` | 409 `SEAT_SOLD_OUT` |
| 확정 | `… SET held_count = held_count - 1, confirmed_count = confirmed_count + 1 WHERE id = $1 AND held_count > 0` | 처리 전체 롤백(정합성 오류) |
| 만료·셀프 취소 | `… SET held_count = held_count - 1 WHERE id = $1 AND held_count > 0` | 처리 전체 롤백 |
| 확정 뒤 취소 | `… SET confirmed_count = confirmed_count - 1 WHERE id = $1 AND confirmed_count > 0` | 옛 코드와 같음(rowcount 확인) |

READ COMMITTED 에서 PostgreSQL 은 잠금을 기다린 뒤 갱신된 행으로 WHERE 를 다시 평가한다. 그래서 이 한 문장이 **행 잠금 + 검사 + 증감**을 한 번에 하고, `FOR UPDATE` 에 기대지 않는다. 실제로 그런지 R2(Prisma 8 트랜잭션·행 잠금 미검증) 스파이크가 실측한다(research S-3).

화면의 「신청 인원」 = `confirmed_count`, 「잔여」 = `capacity − held_count − confirmed_count`. 시나리오 2 의 8/12 → 9/12 는 확정 때 바뀐다(결제 시작 때 아님).

---

## 5. 시드(1회차, Q6(첫 수업 데이터 출처) = 시드 스크립트)

| 무엇 | 값 |
|---|---|
| 학원 | 1곳, 서울·강남구, 대표 회원 1명(`owner_member_id`), 환불·취소 공지 판본 1 |
| 수업 | 정규(`regular`) 살사/바차타 1건, `gender_split` |
| 판매 단위(2026-11-10 변경 — 정규 수업의 기본 결제수단은 이제 카드이고, 이벤트형 상품은 `payments.method` 를 계좌 수단으로만 받는다. 이벤트형 판정 값은 후속 회차에서 정한다) | 기간(`term`) 1개, 4주 × 주 2회 = 8회차, 화·목 19:30~21:00 KST, 첫 회차는 시드 실행 시점 기준 다음 주 화요일. 가격은 시드 상수(예 120,000원) |
| 자리 | 남 6 · 여 6. 확정 남 4 · 여 4 = **8/12**(가짜 회원 8명 + 각자 `paid` 주문·`confirmed` 예약을 실제로 만든다 — 카운터와 행 수를 맞춘다) |
| 시험 회원 | 성인 남성 1명(시나리오 7(남 자리 기본 선택)), 본인확인 끝, 관심 장르 살사/바차타, 지역 강남구, 시간 18:00~22:00, 기준 장르 미선택(가입 흐름 시험용) |

여 자리 마감(시나리오 6) · 조건 밖 수업 3건(AC-1(조건 검색))은 시드가 아니라 **테스트 픽스처**로 만든다.

---

## 6. 2026-11-10 필수 기능 점검 반영 (`_workspace/role-essentials/integration.md` D-04(주문 테이블))

출처: 필수 기능 점검(owner.md ㊷·㊻). 6-1·6-2 는 기존 칸·식의 **고침**이고(승인된 결정을 뒤집지 않는다), 6-3 은 **추천안, 사용자 확인 대기**다.

### 6-1. `ck_orders_total_formula` 고침 — 근거 owner.md ㊻, 소스 `admin-web/lib/domain/money.ts` `computePriceBreakdown`

| | 식 |
|---|---|
| 고치기 전 | `total_amount = list_price_amount - benefit_discount_amount - coupon_discount_amount` |
| 고친 뒤 | `total_amount = GREATEST(0, list_price_amount - benefit_discount_amount - coupon_discount_amount) + booking_fee_amount` |

고친 이유: FR-283(결제액 계산 순서)의 정가 → 혜택 할인 → 쿠폰 → 최종액에, 계약 03 §3 과 `computePriceBreakdown` 이 하는 두 가지가 식에 없었다. ① 할인이 정가를 넘으면 0원으로 막는다 ② 이벤트·원데이 등 FR-282a(예매 수수료 2,000원) 대상은 할인 뒤 금액에 수수료를 더한다. 옛 식이면 이벤트형 주문(합계 = 수업료 + 2,000원)이 CHECK 위반으로 INSERT 되지 않는다. 1회차 시드(정규)는 `booking_fee_amount = 0` 이라 결과가 달라지지 않는다.

손계산(식이 참인지):

| 사례 | list | benefit | coupon | booking_fee | `GREATEST(0, …)` | 식의 우변 | 저장할 `total_amount` | 참? |
|---|---|---|---|---|---|---|---|---|
| 정규 수업(1회차 시드) | 120,000 | 0 | 0 | 0 | 120,000 | 120,000 | 120,000 | 참 |
| 이벤트형 | 30,000 | 0 | 0 | 2,000 | 30,000 | 32,000 | 32,000 | 참 |
| 이벤트형 + 쿠폰 5,000 | 30,000 | 0 | 5,000 | 2,000 | 25,000 | 27,000 | 27,000 | 참 |
| 할인이 정가 초과(하한) | 1,000 | 0 | 3,000 | 2,000 | 0 | 2,000 | 2,000 | 참 |
| 고치기 전 식으로 이벤트형 | 30,000 | 0 | 0 | 2,000 | — | 30,000 | 32,000 | **거짓(위반)** |

### 6-2. 주문 시점 스냅샷 칸 추가 — 근거 owner.md ㊷, FR-284(주문 시점 값 고정)·FR-245(결제 시점 정책 적용)·FR-125e(취소 수수료 5:5·판매 수수료 5%)

| 칸 | 담는 것 | 값 예 |
|---|---|---|
| `booking_fee_amount` | 그 주문에 붙은 예매 수수료(FR-282a). 수업료와 따로 보존해야 취소해도 환불하지 않는다는 규칙(FR-282a)을 나중에 적용할 수 있다 | 정규 0 · 이벤트형 2,000 |
| `platform_fee_rate_bp` | 주문 시점에 **실제로 적용한** 플랫폼 판매 수수료율(FR-124(플랫폼 수수료 5%·1년 면제)). 입점 면제 기간이면 0 | 500(5%) · 면제 0 |
| `cancel_fee_platform_share_bp` | 취소 수수료 중 플랫폼 몫(FR-125e 5:5) | 5000(50%) |
| `member_terms_version` · `merchant_terms_version` | 결제 시점에 회원이 동의한 이용약관 판본과 해당 학원의 입점 약관 판본(FR-245). 기존 `refund_notice_version_id`·`intermediary_notice_version` 은 그대로 둔다 | `text`(판본 문자열) |

- 비율은 소수가 아니라 정수 bp(10,000 = 100%)로 둔다. 금액 계산은 정수 연산만 쓰는 원칙(FR-100(환불 정수 연산), `ceilMulDiv`)과 같다. **칸 이름의 `_bp` 접미어와 이 단위는 추천안**이다.
- 1회차 시드·`POST /api/orders` 는 이 칸들을 학원·약관 현재 판본에서 읽어 채운다. 약관 판본의 출처 테이블(약관 판본을 담는 곳)은 아직 이 문서에 없으므로 1회차는 설정 상수 판본 문자열을 쓴다(**추천안**).
- 시드의 가짜 회원 8명의 `paid` 주문도 같은 칸을 채운다(`platform_fee_rate_bp` = 0, 입점 첫해 면제 가정 — 시드 값일 뿐이다).
- 수수료를 **계산하는** 곳(정산 분배, SCH-31(정산 원장))은 이 칸을 읽는다. 원 미만 끝수는 올림이 소스 규칙(`ceilMulDiv`)이고, 수수료 기준 금액(정가인지 할인 뒤인지)은 spec 에 없다 — 요구사항 문서 Q-O-1(수수료 기준 금액·끝수)로 올렸다.

### 6-3. 추천안 — US1 에 걸리는 상태·값 보완 (사용자 확인 대기)

**[보완 2026-11-10 — 필수 기능 점검, 추천안·사용자 확인 대기]** 판단 근거는 plan §10.

| 지침 | 바뀌는 것 | 비고 |
|---|---|---|
| M-03(결제 실패 시 자리 해제·주문 종료) | `payment_webhook_events.result` 에 `payment_failed` 추가. `reservations.cancel_reason` 에 `payment_failed` 추가(CHECK 값 집합 확장). 주문은 새 상태 없이 `cancelled`, `order_events.reason` 에 `결제 실패` | FR-298(주문 상태 6종)은 늘리지 않는다 |
| M-04(진행 중 주문 복구) | 테이블 변경 없음. `uq_reservations_member_offering_active` 가 이미 중복을 막으므로 `POST /api/orders` 가 충돌 대신 기존 `pending` 주문을 돌려주게 한다(계약 03 §1 보완) | 유니크 충돌 `ALREADY_RESERVED` 는 `held` 가 아닌 `confirmed` 일 때만 남긴다 |

