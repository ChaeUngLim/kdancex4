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


---

## 7. 바닥·M1(대표) — 2판 추가 (2026-11-19)

- 범위: 마스터 플랜(`06_master-plan.md`) §5 의 S0-2(데이터 계약 1판)·S0-3(인증·역할·권한 경계)·S1-1(입점 신청·심사)·S1-2(강사 소속·위임)·S1-3(환불·취소 공지·노쇼 기준)·S1-4(학원 공지·대시보드·알림함). 출석 칸(7-8)만 M2 를 미리 본다
- 기준: 2026-11-19 사용자 결정 3(초대 링크 강사도 승인 대기) · 7(강사·대표의 결석 대신 표시 + 감사 기록) · 8(멤버십 명칭 — 식별자는 영어 그대로) · 10(인증 앱 6자리만·콘솔 하나)
- §0 공통 규칙(uuid PK·text+CHECK·Timestamptz·금액 int·신규 FK 는 Restrict)을 그대로 따른다. 이 절에서 더하는 규칙 셋:
  - **감사 대상**은 각 테이블 머리에 「감사 ○」로 표시한다. 그 테이블을 바꾸는 쓰기는 같은 트랜잭션에서 `audit_logs`(7-7) 1행을 쓴다
  - **민감 칸**(계좌번호·연락처 전체)은 앱에서 암호화한 `bytea` 로 두고 보이는 용도의 끝 4자리·가린 값을 따로 둔다. 감사 기록의 전후 값에도 가린 값만 넣는다(FR-187(연락처 마스킹)·FR-299(결제 정보 보안)). 암호화 방식(AES-GCM, 키는 S0-6(환경 분리·비밀값 목록) 목록에 추가)은 **추천안**
  - 판정에 쓰는 권한·소속·위임은 **세션에 복사하지 않고 요청마다 이 테이블들에서 읽는다** — 위임을 끄면 다음 요청부터 막힌다(O-11(위임 끄면 즉시 차단))

### 7-1. 엔티티 목록

| # | 테이블 | 묶음 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 21 | `staff_accounts` | 계정 | 강사·대표 앱과 관리자 웹이 같이 쓰는 직원 계정(아이디·비밀번호) | S0-3 |
| 22 | `role_grants` | 계정 | 역할 부여(강사·대표·운영자). 한 계정 여러 역할 | S0-3 |
| 23 | `academy_owners` | 학원 | 학원 ↔ 대표 | S1-1 |
| 24 | `academy_branches` · 25 `rooms` | 학원 | 지점 · 강의실·홀 | S1-1 · S1-2 |
| 26 | `merchant_applications` | 입점 | 입점 신청·심사 | S1-1 |
| 27 | `uploaded_files` · 28 `merchant_application_documents` | 입점 | 올린 파일 · 신청에 붙인 증빙 | S1-1 |
| 29 | `academy_payout_accounts` | 입점 | 학원 정산 계좌(판본처럼 쌓음) | S1-1 |
| 30 | `terms_versions` · 31 `merchant_consents` · 32 `terms_change_notices` | 약관 | 약관 판본 · 항목별 동의 · 변경 개별 통지 | S1-1 |
| 33 | `instructor_affiliations` · 34 `instructor_invites` · 35 `instructor_delegations` | 소속 | 소속(신청·초대·승인 대기·소속·해제) · 초대 링크 · 위임 권한 | S1-2 |
| 39 | `instructor_share_rates` · 40 `instructor_share_rate_overrides` | 소속·정산 | 강사 기본 몫 비율 · 수업별 예외(결정 11) | S1-2(만듦) · S5-1(씀) |
| 41 | `platform_fee_rates` | 정산 | 상품 분류별 플랫폼 수수료율(결정 12) | S0-2(칸) · S5-1(씀) |
| 36 | `academy_staff_notices` · 37 `academy_staff_notice_recipients` | 공지 | 소속 강사 전용 학원 공지 · 받는 사람과 읽음 | S1-4 |
| 38 | `audit_logs` | 감사 | 수정·삭제 불가 감사 기록 | S0-2 |
| — | `refund_notice_versions`(확장) · `notifications`(확장) · `academies`(칸 추가) | — | 7-6 · 7-7 · 7-3 | S1-1·S1-3·S1-4 |
| — | `auth.twoFactor` · `auth.verification`(Better Auth 소유) | 계정 | 인증 앱 비밀 · 같은 기기 30일 기억 | S0-3 |

### 7-2. 계정·역할 — FR-004(역할 4종·복수 역할) · FR-011(강사·대표 계정 승인) · FR-011a(앱 둘·서버 하나) · FR-303(관리자 웹 2단계 인증)

**`staff_accounts`** — 감사 ○(상태 변경만)
- 칸: `id uuid` · `auth_user_id text`(→ `auth.user.id`, 아이디는 Better Auth `username` 플러그인 칸) · `display_name text` · `identity_ci_hash text NULL` · `birth_date date NULL` · `phone_enc bytea NULL` · `phone_masked text NULL` · `status text = 'active'` · `created_at` · `updated_at`
- 제약: `uq_staff_accounts_auth_user_id` · **`uq_staff_accounts_ci (identity_ci_hash) WHERE identity_ci_hash IS NOT NULL`**(한 사람 한 강사 계정, FR-011 2026-11-18) · `ck_staff_accounts_status`
- 상태: `active` → `suspended`(FR-257(가입 거절·사후 해지)) ↔ `active` / → `withdrawn`(끝)
- 회원(`members`)과는 **다른 계정**이다. 앱이 달라 한 사람이 둘 다 가질 수 있다(FR-011a). 둘을 잇는 칸은 두지 않는다 — 필요하면 `identity_ci_hash` 로 맞춘다

**`role_grants`** — 감사 ○
- 칸: `id` · `staff_account_id → staff_accounts` · `role text` · `status text = 'active'` · `granted_by_account_id uuid NULL`(NULL = 시스템·플랫폼) · `granted_at` · `revoked_at NULL`
- 제약: **`uq_role_grants_active (staff_account_id, role) WHERE status = 'active'`** · `ck_role_grants_role` · `ck_role_grants_revoked`: `status='revoked'` ↔ `revoked_at IS NOT NULL`
- 부여 경로: `instructor` = 강사 가입(S2-1) · `owner` = 입점 승인(7-3) · `admin` = 플랫폼 스크립트만(**API 없음** — FR-303 「관리자 계정은 대표가 만들 수 없다」). 회원 역할(Dancer)은 `members` 행이 있으면 갖는다 — 여기 넣지 않는다

**2단계 인증** — Better Auth `two-factor` 플러그인(설치본 `better-auth/dist/plugins/two-factor` 실측)을 쓴다. 우리 테이블을 따로 만들지 않는다
- `auth.twoFactor`(secret·backupCodes·userId·verified) + `auth.user.twoFactorEnabled` — 인증 앱 비밀
- 같은 기기 기억: 서명 쿠키 `trust_device` + `auth.verification` 행(identifier `trust-device-…`, `expiresAt`). 설치본 기본값이 2,592,000초(30일)이고 **처음 인증한 날부터 고정 30일이고 로그인마다 늘리지 않는다**(7-12 열린 점 ② 확정 — 설치본 기본은 로그인마다 새로 만드므로 래핑한다)
- SP-8(2단계 인증 플러그인 × Kysely·`auth` 스키마)이 실패하면 대안: `staff_totp_secrets(staff_account_id PK, secret_enc bytea, confirmed_at, last_used_step bigint)` + `staff_trusted_devices(id, staff_account_id, token_hash UNIQUE, expires_at, revoked_at NULL)`. 계약(API) 모양은 둘 다 같다
- 로그인·인증 코드 실패 횟수는 테이블이 아니라 Redis 에 센다(플랜 S0-3 추천안). 실패 사실은 `audit_logs`(`staff.login_failed`·`staff.second_factor_failed`)에 남긴다(FR-185(감사 기록) 보완)

### 7-3. 학원·입점 — FR-070(학원 정보) · FR-085(등록 형태·증빙) · FR-087(엄격 기준) · FR-240(판매자 정보) · FR-250(입점 심사) · FR-139(계좌 변경)

**`academies` 칸 추가**(§2-1 행에 더한다) — 감사 ○(판매자 정보·등록 형태·상태)
- `status text = 'active'` · `registration_type text` · `registration_verified_at timestamptz NULL` · `industry_code text NULL`(참고용) · `business_name text` · `representative_name text` · `business_registration_number text` · `mail_order_report_number text NULL` · `business_address text` · `phone text` · `card_payment_enabled boolean = false`(FR-125b(카드 수수료 입점 동의)) · `platform_fee_exempt_until date NULL`(FR-124(1년 면제)) · `business_status text NULL` · `business_status_checked_at NULL`(O-17(사업자 상태 재확인)) · `tagline text NULL` · `intro text NULL` · `approved_at timestamptz`
- 제약: `ck_academies_brn`: `business_registration_number ~ '^[0-9]{10}$'` · `ck_academies_status` · `ck_academies_registration_type`
- 상태: `active` → `restricted`(게시 제한, FR-250 사유) ↔ `active` / `active` → `termination_requested` → `terminated`(남은 결제건 처리 뒤 — FR-256, Q11 ⑥ 미정이라 전이 조건은 S7 몫)
- 학원 행은 **입점 승인 때** 만든다. 승인 전 정보는 `merchant_applications` 에만 있다 → 승인 전 학원의 수업은 존재할 수 없다(S1-1 수용 ③)
- 사진: `academy_photos(academy_id, file_id UNIQUE → uploaded_files, position int)` PK(academy_id, position), 최대 10장(앱 검사, FR-070 W22)

**`academy_owners`** — 감사 ○
- 칸: `id` · `academy_id` · `staff_account_id → staff_accounts` · `status text = 'active'`(`active`·`ended`) · `started_at` · `ended_at NULL`
- 제약: `uq_academy_owners_active (academy_id) WHERE status='active'`(학원당 활성 대표 1명 — 7-12 ④ 확정) · `ix_academy_owners_account (staff_account_id, status)`
- 입점 승인 트랜잭션이 `academies` · 첫 `academy_branches` · `academy_payout_accounts` · `academy_owners` · `role_grants(owner)` 를 한 번에 만든다

**`academy_branches`** — 칸: `id` · `academy_id` · `name` · `address` · `region_sido` · `region_gu` · `phone NULL` · `opening_hours text NULL` · `facilities text NULL` · `parking text NULL` · `accessibility text NULL` · ts. 제약: `uq_branches_academy_name`. 운영시간은 W2b·W22 처럼 자유 글(구조화는 필요해질 때)

**`rooms`** — 칸: `id` · `branch_id` · `name` · `size_sqm int NULL` · `base_capacity int NULL` · `facilities text NULL` · `status text = 'active'`(`active`·`archived`) · ts. 제약: `uq_rooms_branch_name (branch_id, name) WHERE status='active'` · `base_capacity > 0`. 겹침 거부(FR-072(강의실 중복 배정 거부))는 회차가 강의실을 가리키는 M2 에서 `class_sessions` 에 `EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` 로 건다(`btree_gist` 확장 필요 — S2-2 확인)

**`merchant_applications`** — 감사 ○
- 칸: `id` · `applicant_account_id → staff_accounts` · `status text = 'draft'` · `academy_name` · `branch_name` · `business_name` · `representative_name` · `business_registration_number` · `mail_order_report_number NULL` · `business_address` · `region_sido` · `region_gu` · `phone` · `registration_type` · `industry_code NULL` · `payout_bank_code` · `payout_account_enc bytea` · `payout_account_last4 text` · `payout_holder_name` · `reject_reason_code text NULL` · `reject_reason_text text NULL` · `reviewed_by_account_id NULL` · `submitted_at NULL` · `review_started_at NULL` · `decided_at NULL` · `academy_id NULL`(승인 때 채움) · ts. 초안(`draft`)에서는 판매자 칸이 비어도 된다(NULL 허용, 제출 때 앱이 전부 검사)
- 제약: **`uq_merchant_app_open (applicant_account_id) WHERE status IN ('draft','submitted','in_review')`**(열린 신청 하나) · `ck_merchant_app_rejected`: `status='rejected'` ↔ `reject_reason_code IS NOT NULL` · `ck_..._approved`: `status='approved'` ↔ `academy_id IS NOT NULL` · `ix_merchant_app_status_submitted (status, submitted_at)`
- 상태: `draft` → `submitted` → `in_review` → `approved` · `rejected` / `draft`·`submitted` → `withdrawn`. 거절 뒤 재신청은 **새 행**(FR-250 「정해진 사유」 4종은 §7-9)

**`uploaded_files`**(파일 저장 경계 6-8) — 칸: `id` · `uploader_account_id → staff_accounts` · `purpose text` · `visibility text` · `storage_key text` · `mime_type text` · `size_bytes int` · `sha256 text` · `display_name text` · `attached_at NULL` · `created_at`
- 제약: `uq_files_storage_key` · `ck_files_mime` {`image/jpeg`,`image/png`,`image/webp`,`application/pdf`} · `ck_files_size`: `size_bytes BETWEEN 1 AND 10485760`(10MB **추천값**) · `ck_files_evidence_private`: `purpose='merchant_evidence'` → `visibility='private'` · `ix_files_unattached (created_at) WHERE attached_at IS NULL`(24시간 지난 주인 없는 파일 정리, 6-7)
- `storage_key` 는 서버가 지은 이름이다. `display_name` 은 화면 표시용으로만 쓴다(경로 조작 방지)

**`merchant_application_documents`** — 칸: `application_id` · `doc_kind text` · `file_id → uploaded_files` · `created_at`. PK(application_id, doc_kind) · `uq_app_docs_file`. 제출 규칙(앱): `business_registration` 은 **모든 등록 형태 필수**(FR-250 2026-11-18) + 등록 형태별 증빙 1종(`unregistered` 는 사업자등록증만)

**`academy_payout_accounts`** — 감사 ○(가린 값)
- 칸: `id` · `academy_id` · `bank_code text` · `account_enc bytea` · `account_last4 text` · `holder_name text` · `holder_verified_at NULL` · `holder_verify_method text NULL`(`manual_document` 만 — 통장 사본·계좌 개설 확인서를 운영자가 보고 예금주 이름을 대조. R15 확정 2026-11-19) · `holder_proof_file_id → uploaded_files NULL`(통장 사본, 그 대표와 운영자만 열람) · `holder_verified_by_account_id → staff_accounts NULL`(확인한 운영자) · `status text = 'active'` · `created_by_account_id` · `created_at` · `replaced_at NULL`
- 제약: **`uq_payout_accounts_active (academy_id) WHERE status='active'`** · `ck_payout_accounts_last4 ~ '^[0-9]{4}$'`
- 상태: `active` → `replaced`(끝). 바꾸기 = 옛 행 `replaced` + 새 행 `active` 를 한 트랜잭션에서. 지난 지급이 어느 계좌로 갔는지 남기려고 고치지 않고 쌓는다

### 7-3b. 사업자 상태 확인 기록 — FR-250(입점 심사·게시 제한) · FR-252(정산 보류) · FR-254(이용 제한 절차) (2026-11-19 확정)

**`business_status_checks`**(국세청 상태조회 결과, 매일 1회 + 정산일 지급 직전) — 감사 ○
- 칸: `id uuid PK` · `academy_id uuid FK → academies` · `checked_at timestamptz` · `trigger text CHECK IN ('onboarding','daily','pre_payout','manual')` · `business_no text`(조회한 등록번호) · `status text CHECK IN ('active','suspended','closed','not_found','error')`(계속·휴업·폐업·미등록·조회 실패) · `closed_on date NULL`(폐업일) · `tax_type text NULL` · `raw_response jsonb`(원문 보관)
- 인덱스: `ix_bsc_academy_checked (academy_id, checked_at DESC)`
- 조치 연결: `status IN ('suspended','closed')` 가 처음 나오면 `academy_restrictions`(없으면 S1-1 에서 만든다 — 칸: `academy_id` · `kind text CHECK IN ('new_sales_blocked','payout_hold','listing_suspended')` · `reason text` · `source_check_id FK → business_status_checks NULL` · `started_at` · `ended_at NULL` · `ended_by_account_id NULL`)에 `new_sales_blocked`·`payout_hold` 두 행을 열고 대표 알림·운영자 확인 작업을 만든다. 7일 안에 소명으로 풀리지 않으면 `listing_suspended` 를 연다(FR-254). `error` 는 조치하지 않고 다음 점검에서 다시 본다(조회 실패를 폐업으로 오판하지 않으려고).
- 결제 시작·정산 지급 코드는 `academy_restrictions` 에 열린 행(`ended_at IS NULL`)이 있는지만 읽는다 — 국세청 API 를 요청 경로에서 부르지 않는다.

### 7-4. 약관·동의 — FR-251(입점 조건 동의) · FR-125b · FR-249(동의 기록) · FR-259(변경 30일 전 개별 통지)

**`terms_versions`** — 칸: `id` · `kind text` · `version text` · `body text`(전문) · `published_at` · `effective_at` · `created_at`. 제약: `uq_terms_kind_version` · `effective_at >= published_at`. 같은 `kind` 의 두 번째 판본부터 `effective_at − published_at ≥ 30일` 은 행 사이 비교라 CHECK 로 못 건다 → 발행 API 가 검사하고 테스트 1개로 고정한다
- `kind` 에 입점 고지 항목도 판본으로 넣는다. 그래야 「누르면 그때 동의한 판본 전문」(O35)을 항목마다 열 수 있다

**`merchant_consents`** — 감사 ×(이 테이블 자체가 추가 전용 기록)
- 칸: `id` · `application_id → merchant_applications` · `academy_id NULL`(승인 때 채움) · `staff_account_id` · `terms_version_id → terms_versions` · `item text`(= 그 판본의 kind 사본) · `agreed_at timestamptz` · `withdrawn_at NULL` · `source text`(`application`·`re_consent`)
- 제약: `uq_consents_app_version (application_id, terms_version_id)` · `ix_consents_academy (academy_id, item)`. `agreed_at` 은 **서버 시각**(요청 본문의 시각을 믿지 않는다)
- 카드 수수료 동의(`card_fee_notice`)가 있으면 승인 때 `academies.card_payment_enabled = true`(FR-125b)

**`terms_change_notices`** — 칸: `id` · `terms_version_id` · `academy_id` · `notified_at` · `notification_id → notifications` · `read_at NULL`. 제약: `uq_terms_notice (terms_version_id, academy_id)`. 새 판본 발행 트랜잭션이 그때 `active` 인 모든 학원에 1행씩 쓴다

### 7-5. 강사 소속·위임 — FR-071(소속 강사 관리) · FR-011(소속 승인) · FR-081·FR-081a(위임 가능한 관리 권한) · FR-082(소속 해제)

**`instructor_affiliations`** — 감사 ○
- 칸: `id` · `academy_id` · `instructor_account_id → staff_accounts` · `status text = 'pending'` · `source text`(`application`·`invite`) · `invite_id NULL → instructor_invites` · `applicant_message text NULL` · `is_academy_employee boolean = false`(학원 직원 표시, FR-127 — 정산 영향) · `requested_at` · `decided_at NULL` · `decided_by_account_id NULL` · `reject_reason_code NULL` · `reject_reason_text NULL` · `released_at NULL` · `release_initiated_by text NULL`(`owner`·`instructor`) · ts
- 제약: **`uq_affiliations_open (academy_id, instructor_account_id) WHERE status IN ('pending','active')`** · `ck_aff_source_invite`: `source='invite'` ↔ `invite_id IS NOT NULL` · `ck_aff_rejected`: `status='rejected'` ↔ `reject_reason_code IS NOT NULL` · `ix_aff_academy_status (academy_id, status)` · `ix_aff_instructor (instructor_account_id, status)`
- 상태: `pending` → `active`(대표 승인) · `rejected`(사유 필수) · `withdrawn`(강사 취소) / `active` → `released`. 모두 끝 상태이고 다시 신청하면 **새 행**이다. **초대 링크로 들어와도 `pending` 으로 시작한다**(결정 3 — spec FR-011 본문과 W3a 는 아직 「바로 소속」, 7-11 ①)
- 해제: M1 은 남은 회차 0 일 때만(S1-2 열린 점). 회차 처리 칸은 S2-3(대타·해제)이 더한다. 해제 트랜잭션에서 그 소속의 위임 행을 지운다

**`instructor_invites`** — 감사 ○(만들기·폐기)
- 칸: `id` · `academy_id` · `created_by_account_id` · `token_hash text`(sha256, 원문은 저장하지 않음) · `expires_at` · `used_at NULL` · `used_by_account_id NULL` · `revoked_at NULL` · `created_at`
- 제약: `uq_invites_token_hash` · `ck_invites_used`: `(used_at IS NULL) = (used_by_account_id IS NULL)` · `expires_at > created_at`. 유효기간 7일·1회용은 **추천값**(FR-071 보완, I-01)
- 상태(칸으로 판정): 유효 = `used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`. 쓰기는 `UPDATE … SET used_at=now(), used_by_account_id=$2 WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()` 한 문장 — 영향 0 행이면 거부(S1-2 수용 ①)

**`instructor_delegations`** — 감사 ○(전후 값 = 권한 집합)
- 칸: `affiliation_id → instructor_affiliations` · `permission text` · `granted_at` · `granted_by_account_id`. PK(affiliation_id, permission)
- 소속이 `active` 일 때만 행이 있다(앱 검사 + 해제 때 삭제). 이력은 `audit_logs` 에 남기고 이 테이블은 「지금 켜진 것」만 둔다

**`instructor_share_rates`**(강사 기본 몫 비율, 결정 11 — Q33(강사 몫 비율) 확정) — 감사 ○
- 칸: `id` · `affiliation_id → instructor_affiliations` · `rate_bp int`(10,000 = 100%) · `effective_from timestamptz` · `created_by_account_id` · `created_at`
- 제약: `ck_share_rate_bp`: `rate_bp BETWEEN 0 AND 10000` · `uq_share_rates_aff_from (affiliation_id, effective_from)` · `ix_share_rates_aff_from (affiliation_id, effective_from DESC)`
- 고치지 않고 쌓는다(판본). 결제 시각에 유효한 행 = `effective_from <= paid_at` 중 가장 늦은 것 → 「바꾼 뒤 결제분부터」, 이미 계산한 지급액은 그대로. 바꾼 사람·이전 값·새 값은 감사 `share_rate.changed`, 강사에게 알림 `share_rate_changed`
- **기본값 없음**. 소속 승인(`pending` → `active`) 트랜잭션이 첫 행을 반드시 만든다(학원 직원 강사 제외). 빈칸이면 정산일에 그 강사를 지급 표에서 빼고 알리는 안전망은 S5-3(지급 승인) 몫
- 학원 직원(`is_academy_employee = true`)은 행이 없어도 된다 — 강사 몫이 학원 매출로 들어간다. 직원 표시를 끄면 그 요청에 비율을 함께 받는다(08 §4)

**`instructor_share_rate_overrides`**(수업별 예외, 개인 레슨 포함) — 감사 ○
- 칸: `id` · `affiliation_id` · `class_id → classes`(개인 레슨도 `classes` 의 한 행, `class_kind='private_lesson'`) · `rate_bp int` · `effective_from` · `created_by_account_id` · `created_at`
- 제약: `rate_bp BETWEEN 0 AND 10000` · `uq_share_overrides (affiliation_id, class_id, effective_from)` · `ix_share_overrides_lookup (affiliation_id, class_id, effective_from DESC)`
- 판정: 그 수업의 예외가 결제 시각에 있으면 그 값, 없으면 기본 비율. 수업이 생기는 M2 부터 쓴다 — M1 은 테이블만 만든다
- 주문에 「적용 강사 몫 비율」을 스냅샷으로 넣을지(플랜 6-1 의 담당 강사 id 와 함께)는 S5-1(정산 원장)이 정한다

### 7-6. 공지·기준 판본 — FR-086(등록 형태별 템플릿) · FR-099a(공지 양식) · FR-099c(이벤트형 취소 수수료) · FR-135c(노쇼 기준) · FR-063a(소속 강사 공지)

**`refund_notice_versions` 확장**(§2-2) — 감사 ○
- 더하는 칸: `notice_kind text = 'regular'`(`regular`·`event`·`private_lesson`) · `content jsonb` · `template_code text NULL` · `template_version text NULL` · `created_by_account_id NULL`. 기존 `body text` 는 화면용 본문으로 남긴다(서버가 `content` 로 만든다)
- 제약: 유니크를 **`uq_refund_notice_academy_kind_version (academy_id, notice_kind, version)`** 로 바꾼다(§2-2 와 다름 — 종류가 생겼다) · `ix_refund_notice_latest (academy_id, notice_kind, version DESC)`
- `content` 모양 — 정규: `{cancellableUntil, tiers:[{point:'before_start'|'before_one_third'|'before_half'|'after_half', percent}], nonRefundableCases, processingBusinessDays, ownerContact}` · 이벤트형: `{feeTiers:[{window:'d10_plus'|'d9_d7'|'d6_d3'|'d2_to_deadline', percent}], nonRefundableCases, processingBusinessDays, ownerContact}`. 환불 요청 방법은 고정 문구라 저장하지 않는다
- 검사(앱, 저장 거부): 정규 `percent` 가 템플릿 최소보다 작으면 거부(FR-086 「더 돌려주는 쪽만」, 분수는 올림 — 2/3 → 67) · 이벤트형 상한 `d10_plus ≤ 10 · d9_d7 ≤ 10 · d6_d3 ≤ 20 · d2_to_deadline ≤ 30`(FR-099c, 결정 4) · 이벤트형 `processingBusinessDays ≤ 3`(FR-099a)
- `private_lesson` 은 Q22(개인 레슨 전용 양식) 임시 확정의 틀만 — `content` 모양은 S2-4 가 정한다
- 템플릿 값은 테이블이 아니라 코드 상수(`lib/domain/refund-templates.ts`, `template_version` 붙임)다. 학원법 반환 기준이 미검증(Q11 ①)이라 바뀌면 상수 판본을 올리고 이후 저장부터 적용한다

**노쇼 기준** — 테이블을 만들지 않는다. Q15(출결 방식) 임시 확정으로 기준이 「빠진 회차는 환불·보강 없이 정산」 하나로 고정됐고 W8B 는 「저장할 것이 없어요」다. 코드 상수 `NO_SHOW_POLICY = {version, memberNoticeText}` 로 두고, 주문 스냅샷 칸 `orders.no_show_policy_version text`(플랜 6-1 제안)만 S3-3 에서 더한다

**`academy_staff_notices`** — 칸: `id` · `academy_id` · `author_account_id` · `category text` · `title text` · `body text` · `status text = 'draft'` · `published_at NULL` · `recipient_count int NULL` · ts. 제약: `ck_staff_notice_published`: `status='published'` ↔ `published_at IS NOT NULL` · `char_length(title) BETWEEN 1 AND 100`(100 은 **추천값**) · `ix_staff_notices_academy_pub (academy_id, published_at DESC)`. 상태 `draft` → `published`(끝, 올린 뒤 고치기·지우기 없음 — **추천안**)

**`academy_staff_notice_recipients`** — 칸: `notice_id` · `instructor_account_id` · `read_at NULL`. PK(notice_id, instructor_account_id). 올리는 순간 `active` 소속 강사로 고정한다(W5 「강사 3명에게 보냄」). 강사 쪽 조회는 **지금도 `active` 인 소속**의 공지만 보인다(I39 「해제하면 그 학원 공지는 더 보이지 않는다」)

### 7-7. 감사 기록·알림함 — FR-185(감사 기록) · FR-187 · FR-080(대표 운영 알림) · FR-145(관리자 웹 알림)

**`audit_logs`** — 추가 전용
- 칸: `id` · `occurred_at timestamptz = now()` · `actor_kind text`(`staff`·`member`·`system`) · `actor_staff_account_id NULL` · `actor_member_id NULL` · `actor_role text NULL`(그때 쓴 역할) · `academy_id NULL` · `action text` · `target_table text` · `target_id uuid` · `before jsonb NULL` · `after jsonb NULL` · `reason text NULL` · `request_id text NULL` · `ip_hash text NULL`
- 제약: `ck_audit_actor`: kind 와 id 칸 짝이 맞아야 한다 · `ix_audit_academy_time (academy_id, occurred_at DESC)` · `ix_audit_target (target_table, target_id)`
- **수정·삭제 불가**: 앱 DB 역할에 `UPDATE`·`DELETE` 권한을 주지 않고, `BEFORE UPDATE OR DELETE` 트리거가 예외를 낸다. 트리거·권한은 Prisma 8 계약으로 표현되지 않으므로 손으로 쓴 마이그레이션 SQL 로 넣는다 — 계약 밖 SQL 을 `prisma db migrate` 가 받아 주는지 S0-2 에서 확인(열린 점 ⑦)
- `action` 값(M1 분): §7-9. 대표의 감사 기록 조회는 플랜 6-3 의 「제안」이라 M1 에서는 API 를 만들지 않는다

**`notifications` 확장**(§2-2) — 직원 알림함(O21·O21B, 관리자 웹)도 같은 테이블을 쓴다
- 더하는 칸: `recipient_staff_account_id uuid NULL` · `academy_id uuid NULL` · `category text NULL`(알림함 칩) · `dedupe_key text NULL`. **`recipient_member_id` 는 NULL 허용으로 바꾼다**(§2-2 와 다름)
- 제약: **`ck_notifications_one_recipient`: `num_nonnulls(recipient_member_id, recipient_staff_account_id) = 1`** · `uq_notifications_dedupe (kind, dedupe_key) WHERE dedupe_key IS NOT NULL`(주문이 없는 알림의 재처리 방지. 예: `affiliation:<id>:requested`) · `ix_notifications_staff_created (recipient_staff_account_id, created_at DESC)`
- 기존 `uq_notifications_kind_order_recipient` 는 회원 알림용으로 그대로 둔다

### 7-8. 출석 — M2 미리보기(결정 7, 칸만 확정)

**`attendance_marks`**(S2·S3 에서 만든다. 지금은 칸만 고정) — 감사 ○(강사·대표가 표시·이의 처리할 때)
- 칸: `id` · `reservation_id` · `session_id` · `member_id` · `marked_by_kind text`(`member`·`instructor`·`owner`) · `marked_by_member_id NULL` · `marked_by_staff_account_id NULL` · `marked_at` · `cancelled_at NULL` · `dispute_status text = 'none'` · `dispute_requested_at NULL` · `dispute_reason text NULL` · `dispute_resolved_by_account_id NULL` · `dispute_resolved_at NULL`
- 제약: `uq_attendance_session (reservation_id, session_id) WHERE cancelled_at IS NULL` · `ck_attendance_marker`: `member` ↔ `marked_by_member_id`, 그 밖 ↔ `marked_by_staff_account_id`
- 뜻: 행이 있으면 결석이다(출석은 기본값, Q15). 회원이 미리 알린 결석 예정(FR-092e)과 강사·대표가 대신 표시한 결석을 같은 테이블에 두고 `marked_by_kind` 로 나눈다 — 레벨 계산(FR-169a(출석률 반영 레벨), 결정 6)은 둘 다 센다
- 이의: `none` → `requested` → `accepted`(그 행 `cancelled_at` 채움) · `rejected`. 강사·대표 표시 행에만 이의를 걸 수 있다. 값 이름과 처리자(강사인가 대표인가)는 **추천안**

### 7-8b. 플랫폼 수수료율 — 칸 설계만(결정 12, M5 정산이 쓴다)

**`platform_fee_rates`** — 감사 ○(운영자 변경, FR-316(수수료율 변경))
- 칸: `id` · `fee_category text`(`general`(일반 수업·행사)·`private_lesson`) · `rate_bp int` · **`onboarding_exemption_applies boolean`**(입점 1년 면제를 이 분류에 적용하나) · `effective_from timestamptz` · `created_by_account_id` · `created_at`
- 제약: `ck_platform_fee_bp`: `rate_bp BETWEEN 0 AND 10000` · `uq_platform_fee (fee_category, effective_from)`. 시드: `general` 500(5%)·면제 적용 `true` · `private_lesson` 100(1%)·면제 적용 **`false`**(결정 13 — 개인 레슨 1% 는 입점 첫날부터)
- 미래 날짜만 넣을 수 있다(앱 검사, FR-316) — 행 사이 비교라 CHECK 로 못 건다. 학원 개별 통지는 FR-259 와 같은 30일 기준
- 상품 → 분류: `classes.class_kind = 'private_lesson'` 이면 `private_lesson`, 그 밖은 `general`. 결제 때 `orders.platform_fee_rate_bp`(§6-2)에 **실제 적용값**을 고정한다 — 결제 시각이 입점 1년 면제(`academies.platform_fee_exempt_until`) 안이고 그 분류 행의 `onboarding_exemption_applies = true` 일 때만 0 이다. 그래서 면제 기간에도 일반 수업·행사는 0%, 개인 레슨은 1%(결정 13). 면제 적용 여부를 요율 행에 둔 이유: 나중에 분류가 늘거나 면제 정책이 바뀌어도 요율과 같은 판본(`effective_from`)으로 쌓여 결제 시점 값이 남는다
- 학원별 다른 요율은 두지 않는다(spec 근거 없음). 필요해지면 `academy_id NULL` 칸을 더한다

### 7-9. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| staff_accounts.status | `active` · `suspended` · `withdrawn` |
| role_grants.role / status | `instructor` · `owner` · `admin` / `active` · `revoked` |
| academies.status | `active` · `restricted` · `termination_requested` · `terminated` |
| academies.registration_type | `academy`(교육청 학원) · `tutoring_center`(교습소) · `sports_facility`(신고 체육시설) · `unregistered`(미등록) — FR-085 |
| merchant_applications.status | `draft` · `submitted` · `in_review` · `approved` · `rejected` · `withdrawn` |
| merchant_applications.reject_reason_code | `info_mismatch`(정보·서류 불일치·미확인) · `registration_missing`(등록·신고 미비) · `prior_termination`(위반 해지 이력) · `trust_violation`(신뢰를 해치는 수업·광고) — FR-250 |
| merchant_application_documents.doc_kind | `business_registration` · `academy_registration` · `tutoring_center_report` · `sports_facility_report` |
| uploaded_files.purpose / visibility | `merchant_evidence` · `academy_photo`(이후 `instructor_photo`·`poster`·`inquiry_attachment` 추가) / `private` · `public` |
| terms_versions.kind | `merchant_terms` · `merchant_privacy_collection` · `privacy_policy` · `platform_fee_notice` · `card_fee_notice` · `content_license` · `one_plus_one_notice` |
| instructor_affiliations.status / source | `pending` · `active` · `rejected` · `withdrawn` · `released` / `application` · `invite` |
| instructor_affiliations.reject_reason_code | `not_recruiting` · `genre_mismatch` · `info_needed` · `other` — FR-071 |
| instructor_delegations.permission | `roster_view`(전체 수강생 조회) · `class_manage`(수업 등록과 취소) · `headcount_manage`(인원 관리) — FR-081a 3종 · `class_submit`(앱 수업 등록 권한, O31·O38) |
| refund_notice_versions.notice_kind | `regular` · `event` · `private_lesson` |
| academy_staff_notices.category / status | `class_cancelled`(휴강) · `class_changed`(수업 변경) · `academy_schedule`(학원 일정) · `other` / `draft` · `published` |
| platform_fee_rates.fee_category | `general` · `private_lesson` |
| notifications.kind(추가) | `share_rate_changed` · `affiliation_requested` · `affiliation_approved` · `affiliation_rejected` · `delegation_changed` · `staff_notice_published` · `merchant_application_approved` · `merchant_application_rejected` · `payout_account_changed` · `terms_change_notice` |
| notifications.category | `approval`(승인) · `signup_close`(신청·마감) · `inquiry`(문의) · `settlement`(정산) · `operations`(운영) — O21·O21B 칩 |
| audit_logs.action(M1) | `staff.login_failed` · `staff.second_factor_failed` · `role_grant.changed` · `merchant_application.submitted`·`.review_started`·`.approved`·`.rejected` · `academy.seller_info_changed` · `payout_account.changed` · `invite.created`·`.revoked` · `affiliation.approved`·`.rejected`·`.released`·`.employee_flag_changed` · `share_rate.changed` · `platform_fee_rate.changed` · `delegation.changed` · `refund_notice.published` · `terms_version.published` |

### 7-10. 왜 이렇게 나눴나

- **직원 계정을 `members` 와 나눴다** — FR-011a 가 회원 앱(소셜)과 강사·대표 앱(아이디·비밀번호)을 다른 계정으로 정했다. 한 테이블에 두면 「회원 1인 1계정」(FR-003) 유니크와 「강사 1인 1계정」 유니크가 서로를 막는다
- **역할과 학원 연결을 따로 뒀다** — `owner` 역할은 「대표 메뉴를 볼 수 있다」이고, 어느 학원인지는 `academy_owners` 가 정한다. 한 대표가 학원 여러 곳을 가져도 역할 행은 하나다
- **위임은 「지금 켜진 것」만 테이블에, 이력은 감사 기록에** — 요청마다 읽는 표가 작아야 매 요청 판정이 싸다

### 7-11. 기존 절과 다른 곳

| 위치 | 다른 점 | 이유 |
|---|---|---|
| ① spec FR-011 본문 · 보드 W3a | 「초대 링크로 들어오면 바로 소속」 → 여기서는 `pending` | 2026-11-19 결정 3. spec·보드 수정은 다른 작업이 맡는다(O37 은 이미 「승인 대기로 들어와요」) |
| ② §2-1 `academies.owner_member_id → members` | 쓰지 않는다. 대표는 `academy_owners.staff_account_id` | 대표는 회원 계정이 아니라 직원 계정이다(FR-011a). 계약 04 §3 의 `payment_confirmed_owner` 받는 사람도 `academy_owners`(active)의 직원 계정으로 바뀐다 |
| ③ §2-2 `refund_notice_versions` 유니크 | `(academy_id, version)` → `(academy_id, notice_kind, version)` | 정규·이벤트형·개인 레슨 공지가 따로 판본을 쌓는다 |
| ④ §2-2 `notifications.recipient_member_id` | NOT NULL → NULL 허용 + 받는 사람 둘 중 하나 CHECK | 직원 알림함을 같은 테이블에 둔다 |
| ⑤ 플랜 6-1 「노쇼 기준」 엔티티 | 테이블 없음, 코드 상수 + 주문 판본 칸 | Q15 임시 확정으로 고를 값이 없다 |

### 7-12. 열린 점(데이터)

| # | 무엇 | 결정(추천안은 2026-11-19 사용자 확정, 남은 행은 사용자 확인 대기) |
|---|---|---|
| ① | 대표 계정의 본인확인 — FR-011 은 강사만 가입 때 휴대폰 본인확인 필수로 정했다. 대표(입점 신청자)는 spec 에 없다 | **확정**: 대표 가입도 강사처럼 휴대폰 본인확인 필수 + 입점 신청 전에 2단계 인증(인증 앱) 등록. 예금주·사업자 대표자명 대조의 기준이 된다 |
| ② | 「같은 기기 30일」을 고정 30일로 볼지, 로그인할 때마다 30일씩 늘릴지 — 설치본 플러그인 기본은 늘린다 | **확정**: 처음 인증한 날부터 고정 30일, 로그인마다 늘리지 않는다. FR-303 의 「30일 동안」 문장에 가깝고 고시 요건 확인(공개 운영 전)에도 보수적이다. 플러그인 기본과 다르면 래핑한다 |
| ③ | 플러그인이 만드는 백업 코드 — FR-303 은 「코드를 받을 수 없으면 플랫폼 지원 문의」뿐이다 | **확정**: 백업 코드는 쓰지 않는다(화면에 내보이지 않고 경로를 차단). 복구는 운영자 수동 — 코드를 못 받으면 「플랫폼 지원 문의」 |
| ④ | 학원당 대표 수 | **확정**: 한 학원 = 활성 대표 1명(`uq_academy_owners_active (academy_id) WHERE status='active'`). 한 대표가 여러 학원은 허용 |
| ⑤ | 위임 권한 4종의 대응 — FR-081a 3종(관리자 웹)과 앱 「수업 등록 권한」(O31)이 같은 것인지 | **확정**: 다른 것으로 둔다(`class_submit` 별도). O38 이 토글을 따로 그렸다 |
| ⑥ | 입점 뒤 등록 형태·판매자 정보를 바꾸면 다시 심사하나 | **확정**: 등록 형태 변경은 운영자 재심사(`registration_verified_at` 을 비우고 그동안 FR-087 엄격 기준), 상호·주소·전화는 바로 반영 + 감사 기록 |
| ⑦ | 감사 기록 트리거·권한 SQL 을 계약 밖 마이그레이션으로 넣을 수 있는지 | S0-2 스파이크에서 확인. 안 되면 앱 계층 검사 + 테스트로만 지킨다(약해짐을 기록) |
| ⑧ | 학원 공지 글자 수 상한·올린 뒤 고치기 | **확정**: 제목 100자, 올린 뒤 고치기·지우기 없음(받은 강사 기록이 바뀌지 않게). 고칠 일은 판본으로 새로 올린다 |
