# Phase 3(구현 계획) 산출물 — 데이터 모델

- 작성 2026-11-06 · 짝 문서: `03_impl-planner_plan.md`(결정 근거) · `03_contracts/`(API) · `03_research.md`(미확인 실측 계획)
- 대상: 이관 7테이블(academies·orders·class_schedules·payments·reservations·refunds·refund_events) + US1-A(가입~결제 확정) 신규 테이블
- **판 기록**: 1판 2026-11-06(§1~§5 · 이관 + US1) · §6 2026-11-10 필수 기능 점검 · 2판 2026-11-19(§7 바닥·M1 대표) · **3판 2026-11-20 통합**(§8 M2 강사 · §9 M4 환불·취소·대기 · §10 M5 정산·지급·대사 · §11 M6 멤버십·쿠폰·혜택·레벨·행사 · §12 M7 운영 · §13 MX AI 트랙 · §14 통합 정리). §8~§13 은 마일스톤별 초안(`evidence/penpot-doc-sync-2026-11-20/datamodel_draft_*.md`)을 붙인 것이고 절 안의 「n판 추가」 표기는 초안 때 이름이다. **두 절이 어긋나 보이면 §14 가 이긴다**
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

**21번부터의 엔티티**: 21~41 은 §7-1(바닥·M1) · 42~59 §8-1(M2 강사) · 60~74 §9-1(M4 환불·취소·대기) · 76~90 §10-1(M5 정산 — 89·90 공휴일 표는 M0 이 만든다) · 91~118 §11-1(M6 멤버십·쿠폰·레벨·행사) · 119~135 §12-1(M7 운영) · 136~150 §13-1(MX AI). 기존 표를 넓히는 것(18 `settlement_entries` · 19 `refunds` 등)은 번호를 새로 주지 않는다. 마일스톤 사이 겹침을 정한 표는 §14

---

## 2. 컬럼·제약

### 2-1. 이관 테이블

| 테이블 | 컬럼(변경점만 굵게) | 제약·인덱스 |
|---|---|---|
| `academies` | id, name `varchar(200)`, refund_policy_tiers `jsonb default '[]'`(§4.4), **region_sido `text`**, **region_gu `text`**, **owner_member_id `uuid NULL` → members**, created_at, updated_at | PK. `ix_academies_region (region_sido, region_gu)` |
| `orders` | id, **member_id `uuid` → members**(옛 `user_id`), **offering_id → class_offerings**, status, **list_price_amount**, **benefit_discount_amount default 0**, **coupon_discount_amount default 0**, total_amount, **booking_fee_amount default 0**(2026-11-10 추가), **price_breakdown `jsonb`**(§4.6 줄 형태), **refund_notice_version_id → refund_notice_versions**, **intermediary_notice_version `text`**, **member_terms_version `text`**·**merchant_terms_version `text`**(2026-11-10 추가), **platform_fee_rate_bp `int`**·**cancel_fee_platform_share_bp `int`**(2026-11-10 추가, 1bp = 0.01%), **idempotency_key `varchar(200)`**, **paid_at NULL**, **closed_at NULL**, ts | `ck_orders_status`(§4.1, 6종) · 금액 5칸 `>= 0` · **`ck_orders_total_formula`: `total_amount = GREATEST(0, list_price_amount - benefit_discount_amount - coupon_discount_amount) + booking_fee_amount`**(2026-11-10 수정, 아래 §6-1) · `ck_orders_fee_rates`: 두 비율 칸 `BETWEEN 0 AND 10000`(2026-11-10 추가) · **`uq_orders_member_idempotency (member_id, idempotency_key)`** · `ix_orders_member_id` |
| `payments` | id, order_id, method, amount, paid_at NULL, gateway_payment_key NULL(PG 거래 id), **gateway_payment_id `varchar(64)`**(우리가 PG 에 주는 결제 id), **status**, **due_at `timestamptz`**, **virtual_account_bank_code NULL**, **virtual_account_number NULL**, **virtual_account_holder NULL**, **pg_reported_amount NULL**, ts | `ck_payments_method` {virtual_account, card} 유지 · **`ck_payments_status`**(§4.1) · `amount >= 0` · **`uq_payments_gateway_payment_id`** · **`uq_payments_order_live (order_id) WHERE status IN ('ready','paid')`** · `ix_payments_order_id` · **`ix_payments_status_due (status, due_at)`**(만료 정리용) |
| `reservations` | id, order_id, **offering_id**(옛 `class_schedule_id`), **seat_pool_id → seat_pools**, **seat_kind**(§4.1, 결제 시점 사본), **member_id**(옛 `user_id`), status, cancelled_at NULL, **cancel_reason NULL**, ts | `ck_reservations_status`(§4.1, 4종) · **`ck_reservations_cancel_reason`** · **`uq_reservations_member_offering_active (member_id, offering_id) WHERE status IN ('held','confirmed')`** · 인덱스 3개(order_id, offering_id, member_id) |
| `refunds` | 변경 없음 → **§9-3 이 교체**(2026-11-20 사용자 결정 D13) | 기존 CHECK·UNIQUE 중 이중 환불 방지 핵심은 **원인당 부분 유니크 `uq_refunds_basis_active (basis_kind, basis_id) WHERE status <> 'failed'` + 주문 환불 합계 CHECK `ck_orders_refunded_cap`** 이다(2026-11-20 사용자 결정 D13 — 이전: 「예약당 부분 유니크 `uq_refunds_reservation_id_active ON (reservation_id) WHERE status <> 'failed'` 유지」) |
| `refund_events` | 변경 없음(추가 전용) | 기존과 같음. `event_type` 값 6종은 앱 상수(§4.2) |

옛 `user_id` 에는 FK 가 없었다. 새 `member_id` 는 `members` FK 를 건다(Phase 2 충돌 ⑥ 해소).

### 2-2. 신규 테이블

| 테이블 | 컬럼 | 제약·인덱스 |
|---|---|---|
| `refund_notice_versions` | id, academy_id, version `int`, body `text`, created_at | `uq_refund_notice_academy_version (academy_id, version)` · `version >= 1` |
| `members` | id, auth_user_id `text`, name `text`, gender(§4.1), birth_date `date`, phone `text`, identity_ci_hash `text`, **nickname `text`**(2026-11-20 추가 — 아래 §15-4 ①), **nickname_changed_at `timestamptz NULL`**(예약 칸 — 한 번 정하면 고정·멤버십 회원만 1년에 한 번, FR-019a), signup_notice_ack_at `timestamptz`, base_genre NULL(§4.1 genre), **base_sub_genre NULL**(2026-11-25 추가 — 기준 세부 장르, classes.sub_genre 와 같은 값. NULL = 그 장르 「전체」. FR-022a(첫 화면 장르 선택·유지), 마이그레이션 `20261125T0249_member_base_sub_genre`), experience_level NULL(§4.1), available_from `time NULL`, available_to `time NULL`, ts | **`uq_members_auth_user_id`** · **`uq_members_identity_ci_hash`**(FR-003, 1인 1계정) · `ck_members_available_window`: 둘 다 NULL 이거나 둘 다 있고 from < to · **`ck_members_nickname`**: `nickname = btrim(nickname) AND char_length(nickname) BETWEEN 2 AND 12`(길이는 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 상수 `NICKNAME_MIN`·`NICKNAME_MAX` 와 같다) · **닉네임 UNIQUE 는 없다**(중복 허용) · **`ck_members_base_sub_genre`**: base_sub_genre 가 NULL 이거나, base_genre='dance_sport' 일 때 latin·standard, base_genre='salsa_bachata' 일 때 salsa·bachata |
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
| payments.method | `virtual_account` · `card` | 그대로 — **2026-11-20 통합: §14-2 에서 4수단(`card`·`easy_pay`·`easy_transfer`·`virtual_account`)으로 넓힌다(S3-3)** |
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
| **settlement_entries.kind / status** | kind `payment_hold` / status `hold` | 신규 최소형. 나머지 단계는 SCH-31(정산 원장) — **§10-9 가 14종(D23 으로 13종에서 하나 늘어남)·`stage` 로 바꾼다(2026-11-20 통합, `payment_hold` → `sale`)** |

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
| `booking_fee_amount` | 그 주문에 붙은 예매 수수료(FR-282a). 수업료와 따로 보존해야 취소해도 환불하지 않는다는 규칙(FR-282a)을 나중에 적용할 수 있다 — 환불 상한 `ck_orders_refunded_cap` 도 이 칸을 뺀다(2026-11-20 사용자 결정 D15) | 정규 0 · 이벤트형 2,000 |
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
- `status text = 'active'` · `registration_type text` · `registration_verified_at timestamptz NULL` · `industry_code text NULL`(참고용) · `business_name text` · `representative_name text` · `business_registration_number text` · `mail_order_report_number text NULL` · `business_address text` · `phone text` · `card_payment_enabled boolean = false`(FR-125b(카드 수수료 입점 동의)) · `platform_fee_exempt_until date NULL`(FR-124(1년 면제)) · `business_status text NULL` · `business_status_checked_at NULL`(O-17(사업자 상태 재확인)) · `tagline text NULL` · `intro text NULL` · `approved_at timestamptz` · 등록 형태 변경 신청 칸(2026-11-20 S1-1.17, 계약 07 열린 점 ⑫ 임시 확정): `pending_registration_type text NULL` · `pending_registration_evidence_file_id → uploaded_files NULL` · `registration_change_requested_at timestamptz NULL`
- 제약: `ck_academies_brn`: `business_registration_number ~ '^[0-9]{10}$'` · `ck_academies_status` · `ck_academies_registration_type` · `ck_academies_registration_change`(형태·시각은 함께 차거나 함께 빈다, 신청 없이 서류만 둘 수 없다)
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
- 조치 연결: `status IN ('suspended','closed')` 가 처음 나오면 `academy_restrictions`(없으면 S1-1 에서 만든다 — 칸: `academy_id` · `kind text CHECK IN ('new_sales_blocked','payout_hold','listing_suspended')` · `reason text` · `source_check_id FK → business_status_checks NULL` · `started_at` · `ended_at NULL` · `ended_by_account_id NULL`)에 `new_sales_blocked`·`payout_hold` 두 행을 열고 대표 알림·운영자 확인 작업을 만든다. 7일 안에 소명으로 풀리지 않으면 운영자가 `suspend-listing`(계약 13)을 눌러 `listing_suspended` 를 연다(FR-254 — 자동으로 열지 않는다, 2026-11-21 사용자 결정). `error` 는 조치하지 않고 다음 점검에서 다시 본다(조회 실패를 폐업으로 오판하지 않으려고).
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
- 상태: `pending` → `active`(대표 승인) · `rejected`(사유 필수) · `withdrawn`(강사 취소) / `active` → `released`. 모두 끝 상태이고 다시 신청하면 **새 행**이다. **초대 링크로 들어와도 `pending` 으로 시작한다**(결정 3 — spec FR-011 본문은 2026-11-19 에 「승인 대기」로 고쳤다. 보드 W3a 는 7-11 ①)
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
- `rate_bp` 는 NULL 을 받는다 — NULL 판본 = 「이때부터 예외 없음, 기본 비율을 따른다」(08 §4-1 의 `rateBp: null`). 예외를 끌 때 옛 행을 지우면 끄기 전 결제분까지 기본 비율로 계산되므로 지우지 않고 NULL 판본을 쌓는다(S1-2.10, 2026-11-21 — 마이그레이션 `20261121T0127_share_override_nullable_rate`)
- 제약: `rate_bp IS NULL OR rate_bp BETWEEN 0 AND 10000` · `uq_share_overrides (affiliation_id, class_id, effective_from)` · `ix_share_overrides_lookup (affiliation_id, class_id, effective_from DESC)`
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
- 제약: `ck_platform_fee_bp`: `rate_bp BETWEEN 0 AND 10000` · `uq_platform_fee (fee_category, effective_from)`. 시드: `general` 500(5%)·면제 적용 `true` · `private_lesson` 100(1%)·면제 적용 **`false`**(결정 13 — 입점 1년 면제는 개인 레슨에 쓰지 않는다. 2026-11-23 변경 — 이전: 개인 레슨 1% 는 첫날부터. 개인 레슨은 대신 **강사 가입일부터 1년 면제(0%), 그 뒤 1%**를 쓴다 — FR-124(플랫폼 수수료 5%·1년 면제). 판정에 강사 가입일이 필요하다: `instructor_profiles.signup_completed_at`(강사 가입을 마친 시각, KST 날짜 + 1년 그날까지 면제)을 쓴다 — S3-3.17(개인 레슨 수수료 강사 가입 1년 면제)(추천안·사후 확인 2026-11-24)). 학원별 예외 칸은 없다 — `academy_id` 가 없는 분류별 한 벌이 맞다(2026-11-20 사용자 결정, FR-312·314·316 의 학원별 문장 삭제와 일치)
- 미래 날짜만 넣을 수 있다(앱 검사, FR-316) — 행 사이 비교라 CHECK 로 못 건다. 학원 개별 통지는 FR-259 와 같은 30일 기준
- 상품 → 분류: `classes.class_kind = 'private_lesson'` 이면 `private_lesson`, 그 밖은 `general`. 결제 때 `orders.platform_fee_rate_bp`(§6-2)에 **실제 적용값**을 고정한다 — 결제 시각이 입점 1년 면제(`academies.platform_fee_exempt_until`) 안이고 그 분류 행의 `onboarding_exemption_applies = true` 일 때만 0 이다. 그래서 입점 면제 기간에도 일반 수업·행사는 0%, 개인 레슨은 입점 면제와 무관하게 강사 가입일부터 1년은 0%·그 뒤 1%(결정 13, 2026-11-23 변경 — 이전: 개인 레슨 항상 1%. 강사 가입일 칸은 `instructor_profiles.signup_completed_at`(강사 가입을 마친 시각, KST 날짜 + 1년 그날까지 면제)을 쓴다 — S3-3.17(개인 레슨 수수료 강사 가입 1년 면제)(추천안·사후 확인 2026-11-24)). 면제 적용 여부를 요율 행에 둔 이유: 나중에 분류가 늘거나 면제 정책이 바뀌어도 요율과 같은 판본(`effective_from`)으로 쌓여 결제 시점 값이 남는다
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
| uploaded_files.purpose / visibility | `merchant_evidence` · `academy_photo`(이후 추가분까지 합친 목록은 §14-2) / `private` · `public` |
| terms_versions.kind | `merchant_terms` · `merchant_privacy_collection` · `privacy_policy` · `platform_fee_notice` · `card_fee_notice` · `content_license` · `one_plus_one_notice` |
| instructor_affiliations.status / source | `pending` · `active` · `rejected` · `withdrawn` · `released` / `application` · `invite` |
| instructor_affiliations.reject_reason_code | `not_recruiting` · `genre_mismatch` · `info_needed` · `other` — FR-071 |
| instructor_delegations.permission | `roster_manage`(예약·명단 — 전체 수강생 조회 + 인원 관리) · `class_manage`(수업·포스터 등록 — 수업 등록과 취소) — FR-081a 2종(2026-11-20 사용자 결정 — 이전: `roster_view`·`class_manage`·`headcount_manage` 3종) · `class_submit`(앱 수업 등록 권한, O31·O38) |
| refund_notice_versions.notice_kind | `regular` · `event` · `private_lesson` |
| academy_staff_notices.category / status | `class_cancelled`(휴강) · `class_changed`(수업 변경) · `academy_schedule`(학원 일정) · `other` / `draft` · `published` |
| platform_fee_rates.fee_category | `general` · `private_lesson` |
| notifications.kind(추가) | `share_rate_changed` · `affiliation_requested` · `affiliation_approved` · `affiliation_rejected` · `delegation_changed` · `staff_notice_published` · `merchant_application_approved` · `merchant_application_rejected` · `payout_account_changed` · `terms_change_notice` · `restriction_notice`(S1-1.28 — 사업자 점검이 휴·폐업으로 제한을 열 때 대표에게, §12 값을 앞당겨 씀, 2026-11-20) |
| notifications.category | `approval`(승인) · `signup_close`(신청·마감) · `inquiry`(문의) · `settlement`(정산) · `operations`(운영) — O21·O21B 칩 |
| audit_logs.action(M1) | `staff.login_failed` · `staff.second_factor_failed` · `role_grant.changed` · `merchant_application.submitted`·`.review_started`·`.approved`·`.rejected` · `academy.seller_info_changed` · `payout_account.changed` · `invite.created`·`.revoked` · `affiliation.approved`·`.rejected`·`.released`·`.employee_flag_changed` · `share_rate.changed` · `platform_fee_rate.changed` · `delegation.changed` · `refund_notice.published` · `terms_version.published` · `academy_restriction.opened`(S1-1.28 — 점검이 연 제한 행마다 1행, 수행자 system. 닫을 때는 §10 의 `.released`) |

### 7-10. 왜 이렇게 나눴나

- **직원 계정을 `members` 와 나눴다** — FR-011a 가 회원 앱(소셜)과 강사·대표 앱(아이디·비밀번호)을 다른 계정으로 정했다. 한 테이블에 두면 「회원 1인 1계정」(FR-003) 유니크와 「강사 1인 1계정」 유니크가 서로를 막는다
- **역할과 학원 연결을 따로 뒀다** — `owner` 역할은 「대표 메뉴를 볼 수 있다」이고, 어느 학원인지는 `academy_owners` 가 정한다. 한 대표가 학원 여러 곳을 가져도 역할 행은 하나다
- **위임은 「지금 켜진 것」만 테이블에, 이력은 감사 기록에** — 요청마다 읽는 표가 작아야 매 요청 판정이 싸다

### 7-11. 기존 절과 다른 곳

| 위치 | 다른 점 | 이유 |
|---|---|---|
| ① 보드 W3a (spec FR-011 본문은 2026-11-19 반영 끝) | 「초대 링크로 들어오면 바로 소속」 → 여기서는 `pending` | 2026-11-19 결정 3. spec·보드 수정은 다른 작업이 맡는다(O37 은 이미 「승인 대기로 들어와요」) |
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
| ⑤ | 위임 권한 3종의 대응 — FR-081a 2종(관리자 웹, 2026-11-20 사용자 결정으로 3종 → 2종)과 앱 「수업 등록 권한」(O31)이 같은 것인지 | **확정**: 다른 것으로 둔다(`class_submit` 별도). O38 이 토글을 따로 그렸다 |
| ⑥ | 입점 뒤 등록 형태·판매자 정보를 바꾸면 다시 심사하나 | **확정**: 등록 형태 변경은 운영자 재심사(`registration_verified_at` 을 비우고 그동안 FR-087 엄격 기준), 상호·주소·전화는 바로 반영 + 감사 기록 |
| ⑦ | 감사 기록 트리거·권한 SQL 을 계약 밖 마이그레이션으로 넣을 수 있는지 | S0-2 스파이크에서 확인. 안 되면 앱 계층 검사 + 테스트로만 지킨다(약해짐을 기록) |
| ⑧ | 학원 공지 글자 수 상한·올린 뒤 고치기 | **확정**: 제목 100자, 올린 뒤 고치기·지우기 없음(받은 강사 기록이 바뀌지 않게). 고칠 일은 판본으로 새로 올린다 |

---

## 8. 강사(M2) — 4판 추가 (2026-11-20)

- 작성 2026-11-20 · 짝 문서: `_workspace/03_contracts/11-instructor.md`(API)
- 범위: 마스터 플랜 S2-1(강사 가입·소속 신청·프로필) · S2-2(수업 등록·대표 승인·게시) · S2-3(변경·휴강 예고·대타·강사 공지) · S2-4(개인 레슨 개설·강사 일정)
- 기준: 2026-11-19 결정 3(초대 링크도 승인 대기)·7(결석 표시)·11(강사 몫 비율)·12·13(수수료 분류) · **2026-11-20 결정 D3**(관리자 웹 위임 권한 2개 + 앱 `class_submit`) · **D10**(문의 칩 「결석」) · **D11**(스탠다드 종목 「왈츠」·「슬로우폭스트롯」) · **D12**(개인 레슨 1% 공제 줄은 대표 명세에만)


§0 공통 규칙(uuid PK · text+CHECK · Timestamptz · 금액 int · 신규 FK Restrict)과 §7 의 세 규칙(감사 대상 표시 · 민감 칸 암호화 · 권한은 요청마다 DB 에서 읽기)을 그대로 따른다. 이 절에서 더하는 규칙 셋:

- **겹침은 DB 가 마지막으로 막는다.** 같은 강사의 두 회차, 같은 강의실의 두 회차는 `class_sessions` 의 `EXCLUDE USING gist` 로 거부한다(`btree_gist` 확장 필요 — §7-3 `rooms` 와 같은 확인). 회차와 개인 레슨 시간(테이블이 달라 EXCLUDE 로 못 묶는다)은 같은 강사의 트랜잭션 어드바이저리 잠금(`pg_advisory_xact_lock(hashtext('instructor:' || account_id))`) 안에서 앱이 검사한다. EXCLUDE 는 Prisma 8 계약으로 표현되지 않아 손으로 쓴 마이그레이션 SQL 로 넣는다(§7-7 감사 트리거와 같은 길 — 열린 점 ⑦ 결과를 따른다)
- **개인 레슨은 대표에게 보이지 않는다**(FR-052c). 개인 레슨 테이블(`private_lesson_*`)은 대표 권한 경로가 읽지 않는다. 대표에게 겹침을 알릴 때는 「강사 일정과 겹쳐요」만 준다
- **수업을 올리는 동안의 값은 `registration_payload`(jsonb)가 원본**이다. 승인 요청(`submit`) 때 그 값으로 `class_offerings` · `class_sessions` · `seat_pools` 를 만들고, 수정 요청·등록 취소로 임시 저장에 돌아가면 만든 행을 지운다. 결제 가능한 상태(`published`)가 되기 전에는 주문이 가리킬 수 없어 지워도 안전하다

### 8-1. 엔티티 목록

| # | 테이블 | 묶음 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 42 | `instructor_profiles` | 강사 | 강사 프로필·활동 장르·사업자 정보(선택) | S2-1 |
| 43 | `instructor_regions` · 44 `instructor_credentials` | 강사 | 활동 지역 · 자격·대회 | S2-1 |
| 45 | `staff_consents` | 강사 | 직원 계정이 가입 때 동의한 약관 판본 | S2-1 |
| 46 | `instructor_personal_events` | 강사 | 개인 일정(나만 보임, 학원엔 「불가 시간」) | S2-1 |
| 47 | `affiliation_release_requests` | 소속 | 강사가 시작하는 소속 해제 요청 | S2-1(만듦) · S2-3(완성) |
| 48 | `class_target_ages` | 수업 | 수업의 적정 연령(여러 개) | S2-2 |
| 49 | `class_approvals` | 수업 | 수업 승인 기록(추가 전용) | S2-2 |
| 50 | `class_edit_requests` | 수업 | 공개 뒤 수정의 대표 재승인 요청 | S2-3 |
| 51 | `session_changes` | 수업 | 회차 시간·장소 변경·휴강·폐강 기록 | S2-3 |
| 52 | `substitute_requests` · 53 `substitute_request_candidates` | 수업 | 대타 요청 · 알린 후보 강사 | S2-3 |
| 54 | `class_announcements` | 수업 | 강사의 수업 공지 | S2-3 |
| 55 | `private_lesson_rule_versions` | 개인 레슨 | 강사×학원 개인 레슨 취소·환불 규칙 판본 | S2-4 |
| 56 | `private_lesson_products` | 개인 레슨 | 10회 수강권 상품(`classes` 행의 짝) | S2-4 |
| 57 | `private_lesson_slots` | 개인 레슨 | 「레슨 모집」 시간 | S2-4 |
| 58 | `private_lesson_passes` · 59 `private_lesson_bookings` | 개인 레슨 | 회원의 수강권 · 잡은 회차 | S2-4(만듦) · M3 확장(구매) |
| — | `classes` · `class_offerings` · `class_sessions` · `instructor_affiliations` · `staff_accounts`(칸 추가) | — | 8-2 | S2-1·S2-2·S2-3 |

`class_schedules` 대체 모델(§1 #7~#9: `class_offerings` · `class_sessions` · `seat_pools`)은 그대로 쓴다. 처음 만드는 곳은 S0-2 계약이고, S2-2 가 **생산자**(실제 행을 쓰는 쪽)다.

### 8-2. 기존 엔티티에 칸 추가 (정의는 원 절, 여기에는 더하는 것만)

**`staff_accounts`**(§7-2) — 칸 추가
- `identity_name_enc bytea NULL` · `identity_name_masked text NULL` — 본인확인 이름. 정산 계좌 예금주 대조(FR-133)와 대표자명 대조(§7-12 ①)의 기준이다. 가입 때 본인확인 결과(`IdentityVerificationPort`)에서 채운다. **추천안** — 칸이 §7-2 에 없다(M1·M5 와 조율, 열린 점 ⑩)
- `display_name` 은 강사 가입의 「회원에게 보이는 이름」(I31)이다. 강사 프로필과 수업 카드가 이 값을 쓴다. 바꾸기는 이 절에서 열지 않는다

**`instructor_affiliations`**(§7-5) — 칸 추가
- `calendar_color_index smallint NULL` — 학원 색(I12·I9E, 12색 팔레트의 번호 0~11). 승인(`active`) 때 그 강사가 아직 안 쓴 가장 작은 번호를 넣는다(앱 규칙, **추천안**). `ck_aff_color`: `calendar_color_index BETWEEN 0 AND 11`. 12색의 이름·값은 앱 상수(`lib/domain/academy-colors.ts`)다
- `release_requested_at timestamptz NULL` — 열린 해제 요청이 있는지 한눈에 보려는 비정규 칸. 원본은 `affiliation_release_requests`

**`uploaded_files`**(§7-3) — 값 집합만 넓힌다(8-7)
- `purpose` 에 `instructor_photo`(public) · `poster`(private → 수업이 게시될 때 `public`, §14-2) · `business_registration_evidence`(private) 를 더한다. `ck_files_evidence_private` 를 `purpose IN ('merchant_evidence','business_registration_evidence')` → `visibility='private'` 로 넓힌다

**`classes`**(§2-2 #6) — 칸 추가 · 감사 ○(상태·승인)
- `instructor_account_id uuid NULL → staff_accounts` — 담당 강사. NULL 은 1회차 시드 행(옛 `instructor_name` 만 있음)뿐이다. 새로 만드는 행은 앱이 NOT NULL 로 강제한다
- `created_by_account_id uuid NULL → staff_accounts` — 올린 사람(강사 또는 대표). Q45(권한 받은 강사는 자기가 올린 수업만)의 판정 칸
- `status text = 'draft'` — 8-7. 시드 행은 마이그레이션이 `published` 로 채운다
- `sub_genre text NULL` · `discipline text NULL` — 세부 장르 · 종목(8-7). 종목명은 D11 을 따른다
- `target_level text NULL` — 대상 레벨. `members.experience_level` 값 집합 중 `entry` ~ `advanced` 5개. NULL = 레벨 무관(이벤트형 기본, FR-051)
- `room_id uuid NULL → rooms` — 홀. 같은 수업의 회차는 보통 같은 홀이라 수업에 기본값을 두고, 회차(`class_sessions.room_id`)가 실제 값이다
- `poster_file_id uuid NULL → uploaded_files` · `intro_text text NULL` — 바로 반영되는 칸(소개 문구·사진, I24). 소개 문구의 생성 흐름은 SX-6 몫이라 칸만 둔다
- `refund_notice_version_id uuid NULL → refund_notice_versions` — 등록(`submit`) 때 그 학원의 최신 판본을 붙인다(정규·베이직·레이디 스타일 = `regular`, 이벤트형 = `event`). 0원 이벤트형은 NULL(환불할 돈이 없다, FR-099d). 개인 레슨 행은 NULL
- `registration_payload jsonb NOT NULL = '{}'` — 8 머리의 원본 값
- `submitted_at timestamptz NULL` · `approved_at timestamptz NULL` · `approved_by_account_id uuid NULL` · `last_revision_reason text NULL` · `last_revision_at timestamptz NULL` · `approval_reminded_at timestamptz NULL`(24시간 재알림을 보냈다는 표시, FR-050a)
- `idempotency_key varchar(200) NULL`
- 제약:
  - `ck_classes_status`(8-7)
  - `ck_classes_genre_sub`: `genre='dance_sport'` ↔ `sub_genre IN ('latin','standard')` · `genre='salsa_bachata'` ↔ `sub_genre IN ('salsa','bachata')` · 그 밖의 두 장르는 `sub_genre IS NULL`
  - `ck_classes_discipline`: `discipline IS NOT NULL` ↔ `genre='dance_sport'`, 그리고 종목이 속한 세부 장르가 `sub_genre` 와 같다(값 짝은 8-7 표)
  - `ck_classes_approved`: `status IN ('published','cancelled')` → `approved_at IS NOT NULL`
  - `ck_classes_revision`: `last_revision_reason IS NULL` 이거나 `char_length(last_revision_reason) BETWEEN 1 AND 200`(200 은 **추천값**)
  - `uq_classes_creator_idempotency (created_by_account_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
  - `ix_classes_academy_status (academy_id, status)` · `ix_classes_instructor_status (instructor_account_id, status)`
- 개인 레슨 상품도 `classes` 의 한 행이다(`class_kind='private_lesson'`, §7-5 `instructor_share_rate_overrides` 가 이 FK 를 쓴다). 승인 흐름이 없어 `draft` 를 거치지 않고 바로 `published` 로 만든다(FR-050a)

**`class_offerings`**(§2-2 #7) — 칸 추가
- `schedule_rule jsonb NULL` — 반복 규칙 `{weekdays:['mon','wed'], startTime:'20:30', endTime:'21:30', periodFrom:'2026-11-02', periodTo:'2026-12-23'}`(KST 달력·시각). 한 번만 하는 행사는 NULL. 회차 행은 이 규칙에서 만든 사본이고 보여 주기·수정 비교용으로 규칙을 남긴다
- `refund_deadline_on date NULL` — 환불 마감일(KST 달력, FR-099d). 이벤트형(원데이·이벤트·파티·공연·대회)이고 금액이 0 보다 크면 NOT NULL — **행 사이 비교(수업 구분은 `classes`)라 CHECK 로 못 건다**. 등록 검증(S2-2.6)과 게시 판정(approve)에서 두 번 검사하고 테스트 1개로 고정한다
- 제약: `ck_offerings_free_no_deadline`: `price_amount = 0` → `refund_deadline_on IS NULL` · `ck_offerings_deadline_not_after_start`: `refund_deadline_on IS NULL OR refund_deadline_on <= (first_session_starts_at AT TIME ZONE 'Asia/Seoul')::date`(Prisma 계약으로 못 쓰면 앱 검사 + 테스트로만 지킨다 — S2-2.1 에서 확인, 약해짐을 기록)
- 결제한 회원이 생긴 뒤 마감일을 앞당기지 못한다(FR-099d) — `seat_pools.confirmed_count + held_count > 0` 인 판매 단위는 앱이 거부한다

**`class_sessions`**(§2-2 #8) — 칸 추가
- `room_id uuid NULL → rooms` · `instructor_account_id uuid NOT NULL → staff_accounts` · `status text = 'scheduled'`(8-7) · `cancelled_at timestamptz NULL` · `cancel_reason text NULL`
- `instructor_account_id` 는 **그 회차를 실제로 가르치는 강사**다. 처음에는 수업의 담당 강사이고, 대타가 확정되거나 대표가 대체 강사를 배정하면 바뀐다(정산은 이 칸의 강사 몫, I-10). 정산 쪽 읽기는 S5-1
- 제약: `ck_sessions_status` · `ck_sessions_cancelled`: `status IN ('cancelled','closed')` ↔ `cancelled_at IS NOT NULL` ·
  **`ex_sessions_instructor`**: `EXCLUDE USING gist (instructor_account_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'scheduled')` · **`ex_sessions_room`**: `EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'scheduled' AND room_id IS NOT NULL)`(FR-054·FR-072) · `ix_sessions_instructor_time (instructor_account_id, starts_at)`
- 회차 행은 수업이 `pending_approval` 이상일 때만 있다(8 머리). 그래서 승인을 기다리는 수업도 시간을 점유한다(같은 강사가 같은 시각에 다른 수업을 올릴 수 없다)

### 8-3. S2-1 — 강사 가입·소속·프로필 · FR-011 · FR-011b · FR-025 · FR-053 · FR-082

**`instructor_profiles`** — 감사 ○(사업자 정보·활동 장르 최초 저장)
- 칸: `staff_account_id uuid PK → staff_accounts` · `activity_genre text`(§3 genre 4값) · `bio text NULL` · `career_years int NULL` · `photo_file_id uuid NULL → uploaded_files` · `business_registration_number text NULL` · `business_registration_file_id uuid NULL → uploaded_files` · `marketing_opt_in_at timestamptz NULL` · `signup_completed_at timestamptz` · `created_at` · `updated_at`
- 제약: `ck_instr_profiles_bio`: `bio IS NULL OR char_length(bio) <= 500`(I40 「44 / 500」) · `ck_instr_profiles_career`: `BETWEEN 0 AND 80`(80 은 **추천값**) · `ck_instr_profiles_brn`: `business_registration_number IS NULL OR ~ '^[0-9]{10}$'` · `ck_instr_profiles_brn_file`: `business_registration_file_id IS NULL OR business_registration_number IS NOT NULL`
- **활동 장르는 가입 때만 정한다**(FR-011b, 2026-10-11) — 칸은 한 번 쓰고 고치지 않는다. DB 로 막지 않고(트리거는 과하다) 앱이 변경 요청을 422 로 거부하고, 테스트 1개로 고정한다
- 한 사람 한 강사 계정(Q23)은 `uq_staff_accounts_ci`(§7-2)가 지킨다. 이 테이블은 그 계정에 `instructor` 역할이 있는 사람만 갖는다
- 사업자등록번호·등록증은 비워 둬도 가입된다(수용 ⑤). 번호의 국세청 상태 조회는 하지 않는다(**추천안** — 입점 학원 대표 재확인(§7-3b)과 달리 정산 계산서 발행 여부 안내용이다)
- 소개 영상(FR-025)과 초상권 동의(Q10)의 칸은 이 판에서 만들지 않는다(열린 점 ⑥)

**`instructor_regions`** — 칸: `staff_account_id` · `region_sido` · `region_gu`. PK(staff_account_id, region_sido, region_gu). 모양은 `member_regions` 와 같다

**`instructor_credentials`** — 칸: `id` · `staff_account_id` · `kind text`(`qualification`·`competition`) · `title text` · `position int` · `created_at`. 제약: `ck_instr_cred_kind` · `ck_instr_cred_title`: `char_length(title) BETWEEN 1 AND 100` · `uq_instr_cred_position (staff_account_id, kind, position)`. 한 사람 최대 20개(앱 검사, **추천값**)

**`staff_consents`** — 추가 전용(감사 ×)
- 칸: `id` · `staff_account_id` · `terms_version_id → terms_versions` · `item text`(= 그 판본의 kind 사본) · `agreed_at timestamptz`(서버 시각) · `withdrawn_at NULL` · `source text`(`instructor_signup`) · `created_at`
- 제약: `uq_staff_consents (staff_account_id, terms_version_id)` · `ix_staff_consents_account (staff_account_id, item)`
- 강사 가입의 필수 동의 둘(`merchant_terms`·`merchant_privacy_collection`, Q41)을 담는다. `merchant_consents`(§7-4)는 입점 신청 단위(`application_id` 필수)라 쓰지 않는다. 광고성 알림(선택, FR-146)은 판본이 없는 선택 동의라 `instructor_profiles.marketing_opt_in_at` 에 둔다 — 알림 설정(O34, S7-1)이 생기면 거기로 옮길지는 열린 점 ⑪

**`instructor_personal_events`**(개인 일정, FR-053 · I36) — 감사 ×
- 칸: `id` · `staff_account_id` · `title text` · `starts_at` · `ends_at` · `repeat_rule text = 'none'`(`none`·`weekly`·`daily`) · `repeat_until date NULL` · `created_at`
- 제약: `ends_at > starts_at` · `ck_personal_title`: `char_length(title) BETWEEN 1 AND 50`(50 은 **추천값**) · `ck_personal_repeat`: `repeat_rule = 'none'` → `repeat_until IS NULL` · `ix_personal_account_time (staff_account_id, starts_at)`
- 반복 일정은 한 행이고 읽을 때 날짜 범위로 펼친다. 보드는 끝나는 날을 받지 않으므로 `repeat_until` 이 NULL 이면 지울 때까지 계속이다(**추천안**)
- 개인 일정은 **수업 등록을 막지 않는다** — 겹치면 알리기만 한다(FR-053 · I36 「막지는 않는다」). 대표에게는 제목 없이 「불가 시간」으로만 보인다(FR-083 · 8 머리 규칙과 같은 방식)

**`affiliation_release_requests`**(강사가 시작하는 해제, FR-082 · I28) — 감사 ○
- 칸: `id` · `affiliation_id → instructor_affiliations` · `requested_by_account_id` · `status text = 'requested'`(8-7) · `session_choices jsonb NOT NULL = '[]'`(`[{sessionId, action}]`, 강사가 미리 정한 의향) · `private_lesson_choices jsonb NOT NULL = '[]'`(`[{passId, action}]`) · `note text NULL` · `requested_at` · `resolved_at NULL` · `resolved_by_account_id NULL` · `idempotency_key varchar(200)`
- 제약: **`uq_release_req_open (affiliation_id) WHERE status = 'requested'`**(열린 요청 하나) · `ck_release_req_resolved`: `status <> 'requested'` ↔ `resolved_at IS NOT NULL` · `uq_release_req_idem (requested_by_account_id, idempotency_key)`
- 강사의 의향은 대표 화면(W3b·O39)의 선택칸에 미리 채워지는 값일 뿐이고, 최종 처리는 대표의 `release`(S2-3 완성본)다. 회차가 지난 뒤에 남은 선택은 무시한다

### 8-4. S2-2 — 수업 등록·대표 승인·게시 · FR-050 · FR-050a · FR-051 · FR-052a · FR-057 · FR-076 · FR-092 · FR-092c · FR-099b · FR-099d

**`class_target_ages`** — 칸: `class_id` · `age_group text`(`all`·`gen_2030`·`gen_4050`·`gen_5060`). PK(class_id, age_group). 규칙(앱): 1개 이상 필수(FR-028) · `all` 이면 다른 값과 같이 둘 수 없다. 이벤트형도 필수다(FR-028 「반드시」)

**`class_approvals`** — 추가 전용(수업의 승인 흐름 기록, 감사 대상 자체)
- 칸: `id` · `class_id` · `action text`(8-7) · `actor_account_id → staff_accounts` · `reason text NULL` · `revision_no int`(몇 번째 제출인지, 1부터) · `created_at`
- 제약: `ck_class_approvals_reason`: `action = 'revision_requested'` ↔ `reason IS NOT NULL`, 길이 1~200 · `ix_class_approvals_class (class_id, created_at)` · `uq_class_approvals_submit (class_id, revision_no) WHERE action IN ('submitted','auto_published')`
- 승인 대기 목록(O5·대시보드 `pendingClassApprovals`)은 이 테이블이 아니라 `classes.status='pending_approval'` 에서 읽는다. 이 테이블은 「누가 언제 무엇을 했나」(강사 알림의 사유·감사)다

**수업 상태·회차 만들기 규칙**
- `submit`: `classes` 행 `draft` → `pending_approval`(대표 본인이면 곧바로 `published`, 승인 기록 `auto_published`) + `class_offerings`(상태 `closed`) · `class_sessions` · `seat_pools` 생성 + 환불 공지 판본 붙이기 — **한 트랜잭션**. 회차 겹침(`ex_sessions_*`)은 여기서 마지막으로 걸린다
- `approve`: `pending_approval` → `published` + `class_offerings.status` `closed` → `open` — **한 트랜잭션**(FR-076: 검색 노출 = `classes.status`, 예약 슬롯 = `seat_pools`, 결제 상품 = `open` 판매 단위가 셋 다 있거나 아무것도 없다)
- 공개 목록(`02-catalog`)은 `classes.status = 'published' AND class_offerings.status = 'open'` 로 읽는다 — 카탈로그 계약과 조율(열린 점 ⑫)

### 8-5. S2-3 — 변경·휴강·대타·강사 공지 · FR-055 · FR-056 · FR-060 · FR-063 · FR-065 · FR-082

**`class_edit_requests`**(공개 뒤 수정 중 대표 재승인이 필요한 값, FR-050a · Q38) — 감사 ○
- 칸: `id` · `class_id` · `requested_by_account_id` · `status text = 'pending'`(8-7) · `changes jsonb`(바꿀 값만) · `before jsonb`(요청 때 값) · `reject_reason text NULL` · `decided_by_account_id NULL` · `decided_at NULL` · `idempotency_key` · `created_at`
- 제약: **`uq_class_edit_open (class_id) WHERE status = 'pending'`** · `ck_class_edit_reject`: `status = 'rejected'` ↔ `reject_reason IS NOT NULL` · `ck_class_edit_decided`: `status IN ('approved','rejected')` ↔ `decided_at IS NOT NULL` · `uq_class_edit_idem (requested_by_account_id, idempotency_key)`
- 승인 대기 동안 회원에게는 **고치기 전 값**이 공개된다 — `classes`·`class_offerings` 는 승인 전까지 바뀌지 않는다
- 「바로 바뀌는 값」(소개 문구·사진)은 이 테이블을 거치지 않고 `classes` 에 쓰고 감사 `class.updated` 를 남긴다

**`session_changes`** — 추가 전용(회차 하나의 변경 기록)
- 칸: `id` · `class_id` · `session_id` · `kind text`(8-7) · `batch_id uuid NULL`(같은 요청에 묶인 폐강·해제) · `before jsonb` · `after jsonb` · `reason text NULL` · `changed_by_account_id` · `notified_member_count int` · `member_choice_deadline_at timestamptz NULL` · `created_at`
- 제약: `ck_session_changes_deadline`: `kind = 'cancelled'` ↔ `member_choice_deadline_at IS NOT NULL`(휴강만 회원이 7일 안에 고른다, Q16) · `ix_session_changes_session (session_id, created_at)` · `ix_session_changes_batch (batch_id) WHERE batch_id IS NOT NULL`
- 휴강 선택 기한은 S4-3 의 `openClosureChoices(sessionId)`(`12-refund-cancel-waitlist.md` §4)가 정한 값(알린 날부터 7일, Q16 임시 확정)을 같이 남기는 사본이다 — 원본은 M4 의 선택 행. 회원이 옮기기·환불을 고르는 처리와 환불액(결제액 ÷ 회차 수)은 S4-3 몫이라 여기에는 두지 않는다

**`substitute_requests`** — 감사 ○
- 칸: `id` · `session_id` · `requested_by_account_id` · `message text NULL` · `status text = 'open'`(8-7) · `accepted_candidate_account_id NULL` · `accepted_at NULL` · `confirmed_by_account_id NULL` · `confirmed_at NULL` · `cancelled_at NULL` · `idempotency_key` · `created_at`
- 제약: **`uq_substitute_active (session_id) WHERE status IN ('open','accepted')`**(회차당 열린 요청 하나) · `ck_substitute_accepted`: `status IN ('accepted','confirmed')` → `accepted_candidate_account_id IS NOT NULL AND accepted_at IS NOT NULL` · `ck_substitute_confirmed`: `status = 'confirmed'` ↔ `confirmed_at IS NOT NULL` · `ck_substitute_msg`: `message IS NULL OR char_length(message) <= 200` · `uq_substitute_idem (requested_by_account_id, idempotency_key)`
- **먼저 수락한 한 명**은 한 문장으로 정한다: `UPDATE substitute_requests SET status='accepted', accepted_candidate_account_id=$2, accepted_at=now() WHERE id=$1 AND status='open'` — 영향 0 행이면 이미 닫힌 요청(FR-060 「다른 강사가 먼저 수락하면 닫힌다」)

**`substitute_request_candidates`** — 칸: `request_id` · `candidate_account_id` · `status text = 'invited'`(`invited`·`accepted`·`declined`·`closed`) · `responded_at NULL`. PK(request_id, candidate_account_id). 후보 자격(같은 학원 `active` 소속 · 활동 장르가 수업 장르와 같음 · 그 시간에 일정 없음)은 **요청을 만들 때** 검사해 저장한다. 수락할 때 시간 여유를 한 번 더 본다(그 사이 일정이 생겼을 수 있다)

**`class_announcements`**(FR-063 · I13) — 추가 전용
- 칸: `id` · `class_id` · `session_id uuid NULL` · `author_account_id` · `kind text`(8-7) · `title text` · `body text` · `push_requested boolean = true` · `recipient_count int` · `idempotency_key` · `created_at`
- 제약: `ck_announce_title`: `char_length(title) BETWEEN 1 AND 100`(100 은 **추천값** — 보드는 글자 수를 안 보인다) · `ck_announce_body`: `char_length(body) BETWEEN 1 AND 500`(I13 「62 / 500」) · `uq_announce_idem (author_account_id, idempotency_key)` · `ix_announce_class (class_id, created_at DESC)`
- 받는 사람은 보낼 때의 **그 수업 확정 수강생**으로 고정한다. 결제 대기·대기 신청은 받지 않는다(I13). 회원별 알림 행은 `notifications`(kind `class_announcement`, `dedupe_key = announcement:<id>:<memberId>`)다. 회원의 수업 상세 「강사 공지」(M8C)는 이 테이블에서 읽는다

### 8-6. S2-4 — 개인 레슨 · FR-052c · FR-058 · FR-135a · FR-099b(개인 레슨 양식)

수강권을 **회차권 테이블**(`private_lesson_passes` + `private_lesson_bookings`)로 둔다 — 마스터 플랜 S2-4 열린 점(주문 1건에 묶을지, 따로 둘지)의 **추천안**이다. 이유: 한 수강권에서 회차마다 시간·상태·차감이 달라지고, 주문(`orders`)은 돈의 기록으로 단순하게 둔다. 구매 흐름(회원 M15B)은 M3 의 확장이라 이 절은 구매 뒤의 모양만 정한다(열린 점 ⑫).

**`private_lesson_rule_versions`**(I20C) — 추가 전용(판본 쌓기)
- 칸: `id` · `academy_id` · `instructor_account_id` · `version int` · `change_deadline_hours int` · `validity_months int` · `created_at`
- 제약: `uq_pl_rule (academy_id, instructor_account_id, version)` · `ck_pl_rule_deadline`: `IN (12, 24, 48)` · `ck_pl_rule_validity`: `IN (2, 3, 6)` · `version >= 1`
- 기본값 24시간 · 3개월(FR-052c). **기한이 지난 취소·노쇼 = 1회 차감, 강사 사정 취소 = 회차 복구는 칸 없이 고정**(I20C). 남은 회차 환불 금액은 대표가 정한다(칸 없음). 규칙은 **저장한 뒤 결제하는 수강권부터** 적용한다 — 수강권이 만들어질 때의 판본 id 를 가리킨다(`private_lesson_passes.rule_version_id`)

**`private_lesson_products`**(상품 = `classes` 의 짝) — 감사 ○(개설·닫기)
- 칸: `class_id uuid PK → classes`(`class_kind='private_lesson'`) · `sub_genre text NULL`(회원이 종목을 고르는 범위, 8-7) · `lesson_minutes int` · `session_count int = 10` · `price_amount int` · `status text = 'open'`(`open`·`closed`) · `rule_version_id → private_lesson_rule_versions` · `refund_notice_version_id uuid NULL → refund_notice_versions`(학원의 `private_lesson` 양식이 있으면 함께 붙인다, 열린 점 ⑨) · `idempotency_key` · `created_at` · `updated_at`
- 제약: `ck_pl_product_minutes`: `IN (50, 80)` · `ck_pl_product_count`: `session_count >= 1`(기본 10 — `−`·`+` 로 바꾼다, 상한은 앱 **추천값** 50) · `price_amount >= 0` · `uq_pl_product_idem (class_id)` 대신 `classes.uq_classes_creator_idempotency` 가 중복 개설을 막는다
- 판매자는 `classes.academy_id`(개설할 때 고른 학원)다 — 그 학원이 결제를 받고 정산한다(FR-135a, 수용 ①). 소속이 `active` 가 아니면 만들지 못한다(앱 검사). 개인 레슨 수수료 1% 는 `platform_fee_rates`(§7-8b)에서 읽고 **강사 명세에는 줄이 없다**(D12) — 이 절의 테이블·응답에 수수료 칸을 두지 않는다

**`private_lesson_slots`**(「레슨 모집」 시간)
- 칸: `id` · `product_class_id → private_lesson_products` · `academy_id` · `instructor_account_id` · `room_id uuid NULL → rooms` · `starts_at` · `ends_at` · `status text = 'open'`(8-7) · `held_until timestamptz NULL` · `repeat_group_id uuid NULL`(매주 반복으로 만든 묶음) · `created_at`
- 제약: `ends_at > starts_at` · `ck_pl_slot_held`: `status = 'held'` ↔ `held_until IS NOT NULL` · **`ex_pl_slots_instructor`**: `EXCLUDE USING gist (instructor_account_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('open','held','booked'))` · **`ex_pl_slots_room`**: 같은 모양, `room_id IS NOT NULL` 일 때 · `ix_pl_slots_product_time (product_class_id, starts_at) WHERE status = 'open'`
- 강사의 회차(`class_sessions`)와는 8 머리의 어드바이저리 잠금 규칙으로 겹침을 검사한다. 시작·끝은 10분 단위(앱 검사)
- `held`(결제 대기)는 회원이 첫 시간을 골라 결제를 시작한 동안의 점유다(I10 「결제 대기 · 10/17 23:59까지」). 기한이 지나면 `open` 으로 돌린다(시간 작업 — 6-7 표에 한 줄 더, 열린 점 ⑫)

**`private_lesson_passes`**(회원의 수강권)
- 칸: `id` · `product_class_id → private_lesson_products` · `member_id → members` · `order_id uuid NULL → orders` · `rule_version_id → private_lesson_rule_versions` · `discipline text NULL`(회원이 고른 종목) · `status text = 'pending_payment'`(8-7) · `sessions_total int` · `sessions_used int = 0`(차감된 수 — 마친 회차 + 늦은 취소 + 오지 않음) · `paid_at NULL` · `valid_until timestamptz NULL` · `created_at` · `updated_at`
- 제약: `ck_pl_pass_used`: `sessions_used BETWEEN 0 AND sessions_total` · `ck_pl_pass_active`: `status IN ('active','completed','expired')` → `valid_until IS NOT NULL AND paid_at IS NOT NULL` · `uq_pl_pass_order (order_id) WHERE order_id IS NOT NULL` · `ix_pl_pass_member (member_id, status)` · `ix_pl_pass_product (product_class_id, status)`
- 남은 횟수 = `sessions_total − sessions_used`. **`valid_until` = `paid_at` + `validity_months`**(보드 I20·I20C 「결제일부터」 — spec FR-052c 임시 확정 문구는 「첫 레슨일부터」라 어긋난다, 열린 점 ⑧)

**`private_lesson_bookings`**(수강권에서 잡은 회차)
- 칸: `id` · `pass_id → private_lesson_passes` · `slot_id → private_lesson_slots` · `status text = 'booked'`(8-7) · `booked_by text`(`instructor`·`member`) · `deducted boolean = false` · `cancel_reason text NULL` · `cancelled_at NULL` · `created_at` · `updated_at`
- 제약: **`uq_pl_booking_slot_live (slot_id) WHERE status = 'booked'`**(한 시간에 레슨 하나) · `ck_pl_booking_cancel`: `status LIKE 'cancelled_%'` ↔ `cancelled_at IS NOT NULL` · `ck_pl_booking_deduct`: `status IN ('cancelled_instructor','cancelled_member_free')` → `deducted = false`, `status IN ('cancelled_member_late','no_show','done')` → `deducted = true`(앞은 돌려주고 뒤는 차감) · `ix_pl_booking_pass (pass_id, status)`
- 24시간 규칙 판정(S2-4.3): `slot.starts_at − now() ≥ rule.change_deadline_hours` 이면 회원 요청 취소는 `cancelled_member_free`, 아니면 `cancelled_member_late`(1회 차감). 강사 사정 취소 = `cancelled_instructor`(회차 복구). 판정 함수는 `now` 를 주입받는 순수 함수다
- 회원의 캘린더(`calendar_entries`)는 `reservation_id`·`session_id` 가 필수라 개인 레슨 회차를 담지 못한다 — `booking_id` 칸을 NULL 허용으로 더하고 둘 중 하나가 있어야 하게 바꿔야 한다(M3 와 조율, 열린 점 ⑫)

### 8-7. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| classes.status | `draft`(임시 저장) · `pending_approval`(승인 중) · `published`(공개) · `cancelled`(폐강으로 모든 회차가 닫힘). 「마감」은 판매 단위(`class_offerings.status = 'closed'`)의 일이라 여기 없다. 「종료」는 마지막 회차가 지난 것으로 읽을 때 계산한다(저장하지 않는다) |
| classes.sub_genre | `latin` · `standard`(`dance_sport`) / `salsa` · `bachata`(`salsa_bachata`) / 그 밖의 장르는 NULL(2026-10-11 「아르헨티나 탱고·스윙은 나누지 않는다」) |
| classes.discipline (FR-021 · **D11**) | `dance_sport`+`latin`: `rumba` · `cha_cha_cha` · `samba` · `paso_doble` · `jive` / `dance_sport`+`standard`: `waltz`(왈츠) · `tango` · `viennese_waltz`(비엔나왈츠) · `slow_foxtrot`(슬로우폭스트롯) · `quickstep`(퀵스텝). 화면 순서는 룸바·차차차·쌈바·파소도블레·자이브(FR-050) |
| classes.target_level | `entry` · `beginner` · `novice_intermediate` · `intermediate` · `advanced`(= §3 `members.experience_level` 에서 `dancer` 를 뺀 5개) · NULL = 레벨 무관 |
| class_target_ages.age_group | `all` · `gen_2030` · `gen_4050` · `gen_5060` |
| class_approvals.action | `submitted` · `withdrawn`(강사의 등록 취소) · `approved` · `revision_requested` · `auto_published`(대표가 올려 바로 공개) · `edit_approved` · `edit_rejected` · `closed`(폐강으로 닫힘) |
| class_edit_requests.status | `pending` · `approved` · `rejected` · `withdrawn` |
| class_sessions.status | `scheduled` · `cancelled`(이 회차만 휴강) · `closed`(이후 회차 폐강) |
| session_changes.kind | `time_place`(시간·장소 변경) · `cancelled` · `closed` · `instructor_changed`(대체 강사 배정·대타 확정) |
| substitute_requests.status | `open` · `accepted` · `confirmed` · `cancelled` · `expired` |
| class_announcements.kind | `general`(일반) · `supplies`(준비물) · `progress`(진도·복습) — 시간·장소 변경과 휴강은 공지 종류가 아니다(FR-063) |
| affiliation_release_requests.status | `requested` · `completed` · `withdrawn` · `declined` |
| release 선택 행동 | 회차: `substitute` · `cancel_session` · `close` / 개인 레슨 수강권: `finish_first`(해제 전에 마치기) · `refund` · `handover`(다른 강사에게) |
| private_lesson_products.status | `open` · `closed` |
| private_lesson_slots.status | `open`(레슨 모집) · `held`(결제 대기) · `booked`(예약됨) · `closed` |
| private_lesson_passes.status | `pending_payment` · `active` · `completed` · `expired` · `refunded` |
| private_lesson_bookings.status | `booked` · `done` · `cancelled_instructor` · `cancelled_member_free` · `cancelled_member_late` · `no_show` |
| staff_consents.item | `merchant_terms` · `merchant_privacy_collection`(§7-9 `terms_versions.kind` 의 두 값) |
| instructor_personal_events.repeat_rule | `none` · `weekly` · `daily` |
| instructor_credentials.kind | `qualification` · `competition` |
| uploaded_files.purpose(추가) / visibility | `instructor_photo` / `public` · `poster` / `private`(게시 때 `public`) · `business_registration_evidence` / `private` — 통합 목록은 §14-2 |
| notifications.kind(추가 — 직원, `recipient_staff_account_id`) | 대표: `class_submitted` · `class_edit_requested` · `class_approval_reminder` · `substitute_accepted` · `release_requested` · `instructor_session_changed` / 강사: `class_approved` · `class_revision_requested` · `class_edit_approved` · `class_edit_rejected` · `substitute_requested` · `substitute_confirmed` · `substitute_assigned` · `release_completed` · `release_declined` |
| notifications.kind(추가 — 회원, `recipient_member_id`) | `class_announcement` · `class_changed`(수업 요일·시간·기간 수정 승인) · `session_time_place_changed` · `session_cancelled`(휴강) · `class_closed`(폐강) · `instructor_changed` · `private_lesson_booked` · `private_lesson_cancelled` |
| notifications.category(직원) 쓰임 | `approval`: `class_submitted` · `class_edit_requested` · `class_approval_reminder` · `substitute_accepted`(O21B 「대타」, 승인 칩에 모은다) · `release_requested` / `operations`: 나머지 |
| audit_logs.action(M2) | `class.submitted`·`.withdrawn`·`.approved`·`.revision_requested`·`.auto_published`·`.updated`·`.closed` · `class_edit.requested`·`.approved`·`.rejected` · `session.time_place_changed`·`.cancelled`·`.closed` · `session.instructor_changed` · `substitute.requested`·`.accepted`·`.confirmed`·`.cancelled` · `release_request.created`·`.completed` · `instructor.signup_completed` · `instructor.business_registration_changed` · `private_lesson_product.opened`·`.closed` · `private_lesson_rule.published` · `private_lesson_booking.cancelled` |
| 다른 마일스톤이 소유하는 값(이름만 고정) | 운영 문의 종류 칩(S7-2, **D10**): `settlement_basis`(정산 금액 근거) · `capacity`(정원) · **`absence`(결석)** · `other` — 「출석」이 아니라 「결석」으로 통일 |

### 8-8. 상태 전이

**수업(`classes.status`)** — FR-050a

```
draft ──submit──▶ pending_approval ──approve──▶ published ──(모든 회차 폐강)──▶ cancelled
  ▲                    │   │                       │
  │◀── withdraw ───────┘   └─ request-revision ────┘ (둘 다 draft 로, 회차·판매 단위 삭제)
  대표 본인이 올리면 draft ──submit──▶ published (auto_published)
```
- 전이는 조건부 갱신 한 문장(`… WHERE id=$1 AND status=$2`). 이미 같은 결과면 200 같은 본문, 다른 상태면 409 `CLASS_STATE_CONFLICT`
- `published` 에서는 `draft` 로 돌아가지 않는다. 공개 뒤 수정은 `class_edit_requests` 가 맡는다(승인 전에는 옛 값이 그대로 공개)

**수업 수정 요청** `pending` → `approved`(값을 `classes`·`class_offerings` 에 쓰고 결제한 회원에게 전후 값 알림) · `rejected`(사유, 옛 값 유지) · `withdrawn`(강사가 취소)

**회차** `scheduled` → `cancelled`(이 회차만 휴강) · `closed`(폐강). 끝 상태. 시간·장소 변경은 상태를 바꾸지 않고 `session_changes` 만 쌓는다

**대타 요청** `open` → `accepted` → `confirmed` / `open`·`accepted` → `cancelled`(요청한 강사, 대표 확인 전까지) / `open`·`accepted` → `expired`(회차 시작 시각이 지남, **추천안**)

**강사 해제 요청** `requested` → `completed`(대표가 `release` 를 끝냄) · `withdrawn`(강사 취소) · `declined`(대표가 거절)

**개인 레슨 슬롯** `open` → `held`(결제 시작) → `booked`(결제 확정·회차 잡음) / `held` → `open`(기한 지남·결제 실패) / `booked` → `open`(기한 전 회원 취소) · `closed`(강사 사정·늦은 취소 — 그 시간은 닫는다, **추천안**)

**개인 레슨 수강권** `pending_payment` → `active` → `completed`(횟수 모두 소진) · `expired`(기한) / `active` → `refunded`(대표 환불 — S4)

### 8-9. 왜 이렇게 나눴나

- **`registration_payload` 를 원본으로 둔 이유**: 임시 저장(FR-050a)은 항목이 비어 있을 수 있어 `class_offerings.price_amount NOT NULL` 같은 완성본 제약과 맞지 않는다. 임시 저장 값은 jsonb 에 두고 승인 요청 때만 제약이 있는 행으로 바꾼다
- **회차에 강사 칸을 둔 이유**: 대타(I-10)·대체 강사 배정(결정 2026-11-13)에서 「실제로 수업한 강사」가 회차마다 다르고, 강사 겹침(FR-054)·정산(S5-1)·캘린더가 모두 이 한 칸을 읽는다. 수업의 담당 강사 칸만 있으면 대타가 겹침 판정에서 빠진다
- **승인 기록과 수정 요청을 나눈 이유**: 기록은 추가 전용이고 읽는 쪽이 「무슨 일이 있었나」인데, 수정 요청은 「지금 대표가 판단해야 하는 값」이라 상태와 부분 유니크가 필요하다
- **개인 레슨을 `classes` 행의 짝으로 둔 이유**: §7-5 `instructor_share_rate_overrides.class_id` 가 개인 레슨도 `classes` 의 한 행이라고 이미 정했고(결정 11), 판매자·장르·수수료 분류(`class_kind='private_lesson'`, §7-8b)가 같은 칸을 읽는다

### 8-10. 기존 절과 다른 곳

| 위치 | 다른 점 | 이유 |
|---|---|---|
| ① §2-2 `classes.instructor_name text` | 그대로 두고 `instructor_account_id` 를 더한다. 이름은 가입한 이름(`staff_accounts.display_name`)의 사본이다 | 시드·옛 행 호환, 이름이 바뀌어도 이미 낸 수업 카드가 흔들리지 않게 |
| ② §7-3 `rooms` 의 EXCLUDE 위치 | `rooms` 가 아니라 **`class_sessions`(강사·강의실)** 에 둔다. 7-3 이 말한 `class_sessions` 의 EXCLUDE 가 이 절에서 확정된다 | 강사 겹침을 같은 방식으로 같이 막으려고 |
| ③ §7-5 08 계약의 「`release` 는 `owner`·`instructor` 둘 다」 | 강사 시작은 요청 행(`affiliation_release_requests`)만 만들고 완료는 대표가 한다 | Task S2-1.4 「요청 기록만 만든다」, FR-082 「대표가 대체 강사를 정한 뒤 알림」 — 계약 쪽 정리는 열린 점 ① |
| ④ §7-7 `uploaded_files` 의 `ck_files_evidence_private` | 비공개 목적이 하나 더(`business_registration_evidence`) | 강사 사업자 등록증 |
| ⑤ §2-2 `calendar_entries` | 개인 레슨 회차를 담으려면 `booking_id` 칸 필요 | M3 와 조율 |

### 8-11. 열린 점(데이터)

| # | 무엇 | 결정(전부 사용자 확인 대기, 추천안 표시) |
|---|---|---|
| ① | 강사 시작 해제: 요청 → 대표 처리가 맞나, 남은 회차가 0 이면 강사가 바로 해제하나 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 항상 요청 행을 만들고 대표가 처리한다. 남은 회차 0 이면 대표는 한 번 누르면 끝(알림 확인 수준) |
| ② | 개인 일정이 수업 등록을 막나 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 막지 않고 알린다(FR-053 · I36). 수업·개인 레슨끼리만 거부 |
| ③ | 12색 팔레트의 이름·값 | 앱 상수로 두고 번호만 저장(I9E 「12색 · 무지개 순」 — 값은 보드에서 읽어 구현 때 확정) |
| ④ | 스윙·아르헨티나 탱고 종목 값 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 칸 NULL — FR-021 이 종목을 정하지 않았다. 정해지면 8-7 `classes.discipline` 에 더한다 |
| ⑤ | 정원 한 칸(`single`) 수업의 종류 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `lady_style` 은 단일 정원으로 강제, 나머지는 강사가 고름(FR-092c 「솔로 스타일·레이디스타일 등」). 보드 I2D·I2E 는 남·여 둘만 그려 단일 정원 화면이 없다 |
| ⑥ | 소개 영상(FR-025 · I40)과 초상권 동의(Q10) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 판은 칸을 만들지 않는다. S2-1.6 은 사진까지만 말한다 — 영상은 동의 기록(사람마다, 시각) 테이블과 함께 별도 Task |
| ⑦ | 이벤트형이 여러 회차일 때(FR-099d 「회차가 여럿이면 첫 회차」) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 지금은 이벤트형 = 회차 1개로 제한한다. 여러 날 행사는 S6-4(행사) 가 정한다 |
| ⑧ | 개인 레슨 유효기간 기산 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 결제일부터(보드 I20·I20C 와 같다). spec FR-052c 임시 확정은 「첫 레슨일부터」 — 문서를 보드에 맞춘다 |
| ⑨ | 개인 레슨 규칙의 주인 | 플랜 S2-4.4 는 「학원의 개인 레슨 양식 판본」, 보드 I20C·FR-052c 는 「강사가 학원마다 정한다」. 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 둘 다 둔다 — 강사 규칙 판본(필수)과 대표의 `private_lesson` 양식(있으면) |
| ⑩ | `staff_accounts.identity_name_*` 칸 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) §7-2 에 더한다. M1·M5 와 조율 |
| ⑪ | 광고성 알림 동의의 저장 자리 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 지금은 `instructor_profiles.marketing_opt_in_at`, S7-1 이 알림 설정을 만들 때 옮긴다 |
| ⑫ | M3 와 만나는 곳 | 공개 목록의 `classes.status='published'` 조건 · 개인 레슨 주문(`orders.offering_id` 가 개인 레슨 상품을 가리킬 수 없다 → `orders` 에 `private_lesson_product_id` NULL 허용 칸 + 둘 중 하나 CHECK, 추천) · `calendar_entries.booking_id` · 개인 레슨 `held` 만료 시간 작업(6-7 표에 한 줄) — 모두 M3 담당과 조율 |
| ⑬ | 공개 뒤 수정이 진행 중인 회차에 닿을 때 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 시작 전 회차만 `seq` 순서로 새 규칙에 맞춰 바꾸고 지난 회차는 그대로, **회차 수가 달라지는 수정은 거부**(회차 단위 폐강으로 한다) |
| ⑮ | ~~M5 와 겹침~~ **2026-11-20 통합으로 닫음(§14-1)** —: M5 `instructor_settlement_profiles` 가 사업자등록번호·등록증 칸을 따로 갖는다(`13-settlement.md` §3-1) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `instructor_profiles` 한 곳, M5 는 `tax_type` 만 — M5 담당과 조율 |
| ⑭ | 승인 대기 중에 대표가 환불 공지를 새 판본으로 올렸을 때 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 승인 시점에 최신 판본으로 다시 붙인다(결제 시점 판본은 주문이 따로 고정) |

---

## 9. M4(환불·취소·대기) — 5판 추가 (2026-11-20)

- 범위: 마스터 플랜(`06_master-plan.md`) S4-1(정규 과정 환불 요청·대표 처리 — 비율표 교체) · S4-2(이벤트형 취소·행사 일괄 취소) · S4-3(휴강·폐강·변경과 회원 선택·회차 옮기기) · S4-4(대기·자리 넘김·우선 결제·동반·단체). API 는 `03_contracts/12-refund-cancel-waitlist.md`
- 근거: FR-098(대표 처리 환불 방식) · FR-098b(환불 요청 경로) · FR-293(대표 환불 입력) · FR-294(중도 환불 계산 보조) · FR-295(수단별 환불 실행) · FR-100~FR-103(환불 정수 연산·감사·1회 보장·실패 기록) · FR-299(결제 정보 보안) · FR-099c·FR-099d·FR-099e(이벤트형 취소 규정·환불 마감일·행사 일괄 취소) · FR-059·FR-065·FR-109(휴강 선택·회차 휴강·폐강·회차 옮기기) · FR-093~FR-095·FR-094a·FR-108(대기) · FR-052b(다음 기간 우선 결제) · FR-105·FR-178(동반·단체) · 2026-11-20 결정 D1·D6·D9
- 기준 결정(2026-11-20): **D1** 계좌 결제분은 일괄 취소여도 대표가 은행에서 송금(W31) · 기한 경과 자동 실행은 카드분만, 계좌분은 대표 재알림 + 운영자 확인 · **D6** 접수 뒤 3영업일 안에 답, 승인하면 5영업일 안에 환불 · **D9** 대기 1번 결제 기회 30분
- §0 공통 규칙(uuid PK · text+CHECK · Timestamptz · 금액 int · 신규 FK Restrict)과 §7 의 감사 규칙(「감사 ○」 = 같은 트랜잭션에서 `audit_logs` 1행)을 그대로 따른다. 번호(#)는 §8 다음으로 이었다(2026-11-20 통합)

### 9-1. 엔티티 목록

| # | 테이블 | 구분 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 60 | `refund_accounts` | 신규 | 회원이 입력한 환불받을 계좌(암호화) — 주문당 활성 1건 | S4-1 |
| 61 | `refund_requests` | 신규 | 환불 요청(정규 문의 경로) · 이벤트형 취소 신청. 상태 4종 + 철회(M-06) | S4-1 · S4-2 |
| (19) | `refunds` | **이관 + 칸 추가·제약 교체**(번호는 §1 의 19 그대로) | 환불 1회 시도 = 1행. 원인(`basis`)당 활성 1건 | S4-1 |
| 63 | `event_cancellations` | 신규 | 행사 일괄 취소 1건(행사당 한 번) | S4-2 |
| 64 | `event_cancellation_items` | 신규 | 일괄 취소의 주문별 줄 — 재시도 단위 | S4-2 |
| 65 | `event_cancel_suggestions` | 신규 | 강사가 사유를 적어 올린 취소 요청(확정은 대표) | S4-2 |
| 66 | `closure_choices` | 신규 | 휴강 회차마다 회원 1명의 선택(옮기기·환불·미선택)과 기한 | S4-3 |
| 67 | `reservation_moves` | 신규 | 회차 옮기기 기록(이벤트형 예약 이동 · 정규 휴강 보강 1회) | S4-3 |
| 68 | `session_seat_counters` | 신규 | 회차별 보강 이동 인원 카운터 | S4-3 |
| 69 | `waitlist_entries` | 신규 | 대기 신청(자리 종류별 순번) | S4-4 |
| 70 | `waitlist_counters` | 신규 | (판매 단위·자리 종류)별 순번 발급기 | S4-4 |
| 71 | `seat_offers` | 신규 | 결제 기회(대기 1번에게 30분) | S4-4 |
| 72 | `priority_slots` | 신규 | 정규 수강생의 다음 기간 우선 결제 자리 | S4-4 |
| 73 | `companion_groups` · 74 `companion_group_members` | 신규 | 2인 동반·단체 신청 묶음과 구성원 | S4-4 |
| — | `orders` · `reservations` · `refund_events` · `notifications`(확장) | 칸 추가만 | 9-2 | S4-1~S4-4 |

**다시 정의하지 않는 것**: `orders`·`payments`·`reservations`·`seat_pools`·`calendar_entries`·`notifications`·`audit_logs`·`refund_notice_versions`·`members`·`staff_accounts`·`academy_owners` 의 기본 칸은 §2·§7 그대로다. 이 절은 칸 추가와 값 집합 추가만 적는다.

### 9-2. 칸 추가 — 기존 엔티티

**`orders`**(§2-1·§6)
- `refunded_total_amount int NOT NULL DEFAULT 0` — 이 주문에서 돌려주기로 **잡아 둔** 금액 합(실패한 시도는 되돌려 뺀다)
- **`booking_fee_refunded_amount int NOT NULL DEFAULT 0`**(가칭, 2026-11-20 사용자 결정 D21) — 예매 수수료를 돌려준 금액. **환불 원인 `basis_kind = 'statutory_withdrawal'`(법정 청약철회)인 환불이 성공할 때만** `booking_fee_amount` 로 올라가고 그 밖의 원인은 0 그대로다. 제약 `ck_orders_booking_fee_refunded`: `booking_fee_refunded_amount IN (0, booking_fee_amount)`
- 제약: **`ck_orders_refunded_cap`**: `refunded_total_amount >= 0 AND refunded_total_amount <= total_amount - booking_fee_amount + booking_fee_refunded_amount` — 결제액 초과 환불을 DB 가 막는 최후 방어선(SC-010(환불 초과 0건)). 상한은 **법정 청약철회 환불이면 결제액, 그 밖이면 결제액 − 예매 수수료**다. 환불 원인(`basis_kind`)이 `statutory_withdrawal` 일 때만 `booking_fee_refunded_amount` 가 `booking_fee_amount` 가 되어 상한이 결제액으로 열린다(2026-11-20 사용자 결정 D13·D15·D21 — D15 만 있던 때: `<= total_amount - booking_fee_amount`, 처음: `<= total_amount`)
- 갱신은 한 문장 조건부다: `UPDATE orders SET refunded_total_amount = refunded_total_amount + :x WHERE id = :id AND status IN ('paid','partially_refunded') AND refunded_total_amount + :x <= total_amount - booking_fee_amount + booking_fee_refunded_amount`(청약철회 환불은 같은 문장에서 `booking_fee_refunded_amount` 도 함께 올린다, D21). 영향 행 0 → 409 `REFUND_EXCEEDS_PAID`(§4-4 의 자리 카운터와 같은 방식)
- `status` 전이는 돈이 실제로 `succeeded` 가 될 때: 합 = `total_amount − booking_fee_amount + booking_fee_refunded_amount` → `refunded`, 0 < 합 < 그 값 → `partially_refunded`(데이터 모델 §4-1 의 「1회차에서 만드는 경로 없음」을 이 슬라이스가 연다). 예매 수수료는 돌려주지 않으므로 이벤트형도 참가비를 모두 돌려주면 `refunded` 다(2026-11-20 사용자 결정 D15 — 이전: 합 = `total_amount` 일 때만 `refunded` 이고 이벤트형은 마지막 상태가 `partially_refunded`)
- **M3(S3-3)가 정의하고 이 절이 읽는 칸**: 상품 종류(`classes.class_kind` 사본) · 환불 마감일 · 첫 회차 시작 시각 · 회차 수 · 이벤트형 수수료 표 사본 · 공지 판본(`refund_notice_version_id`) · 취소 수수료 플랫폼 몫(`cancel_fee_platform_share_bp`). 칸 이름은 S3-3 과 조율한다(열린 점 ⑤)
- 옮기기(S4-3.5) 뒤에는 환불 마감일·첫 회차 시작 시각 사본을 **옮긴 회차 기준으로 덮어쓴다**(Q26(회차 옮긴 뒤 기준)). 덮어쓰기는 `order_events` 에 사유 1행(`reservation_moved`)

**`reservations`**(§2-1)
- `share_amount int NULL` — 동반·단체 주문에서 이 구성원의 몫(참가비). NULL = 주문 전체. `refunded_amount int NOT NULL DEFAULT 0` — 이 예약에서 돌려준 금액 합
- 제약: **`ck_reservations_refunded_cap`**: `share_amount IS NULL OR refunded_amount <= share_amount`. 구성원 한 명만 취소해도 남은 구성원의 몫은 건드리지 않는다(Q25(동반·단체 취소 범위))
- `moved_from_reservation_id uuid NULL`(옮기기로 새로 만든 예약이 가리키는 옛 예약) · `companion_group_id uuid NULL → companion_groups`
- `cancel_reason` 값 추가(§3): `refund_regular`(정규 환불 승인으로 수강 종료) · `event_member_cancel`(이벤트형 회원 취소) · `event_bulk_cancel`(행사 일괄 취소, 입금 대기 주문 포함) · `moved`(옮기기로 옛 예약 닫음)

**`refund_events`**(이관, 추가 전용) — 구조 변경 없음. `event_type` 은 CHECK 가 없는 앱 상수라 값만 늘린다(9-6).

**`notifications`**(§2-2·§7-7) — 구조 변경 없음. `kind` 값만 늘린다(9-6). 받는 사람은 회원 또는 직원 한 명(`ck_notifications_one_recipient`).

### 9-3. 환불 계좌·환불 요청·환불 (S4-1·S4-2)

**`refund_accounts`**(a) — 감사 ○(저장·바꿈·전체 열람)
- 칸: `id` · `order_id → orders` · `member_id → members`(입력한 사람 = 주문자) · `bank_code text` · `account_number_enc bytea`(앱에서 암호화 — §7 의 민감 칸 규칙, 키는 S0-6 목록) · `account_masked text`(예 `국민은행 ****-**-7890`, 저장 때 만든다) · `holder_name text` · `holder_matches_identity boolean NOT NULL` · `status text = 'active'` · `superseded_at NULL` · `created_at`
- 제약: **`ck_refund_accounts_holder_match`**: `holder_matches_identity = true`(본인확인 이름과 다른 예금주는 INSERT 자체가 안 된다 — FR-295 「본인 명의 계좌만」) · **`uq_refund_accounts_order_active (order_id) WHERE status = 'active'`** · `ix_refund_accounts_member` · `ck_refund_accounts_holder_name`(앞뒤 공백 없는 1~100자) · `ck_refund_accounts_superseded`(`(status = 'superseded') = (superseded_at IS NOT NULL)`)(추천안·사후 확인 2026-11-24)
- 계좌를 새로 입력하면 한 트랜잭션에서 옛 행 `active → superseded` 후 새 행 INSERT. 원문 번호는 어떤 응답·로그·감사 `before`/`after` 에도 넣지 않는다(FR-299, §7 규칙). 전체 열람은 7-7 `audit_logs` 에 `refund_account.revealed` 1행(누가·언제·어느 환불)

**`refund_requests`**(b) — 감사 ○
- 칸: `id` · `order_id` · `reservation_id` · `academy_id → academies`(대표 조회 범위, 사본) · `member_id` · `kind text`(`regular`·`event`) · `status text = 'received'` · `reason_kind text`(`personal`·`schedule_change`·`other` — **추천값**, 열린 점 ⑥) · `reason_text text NULL`(500자 이하) · `desired_text text NULL`(「바라는 것」 C15B) · `refund_account_id NULL → refund_accounts` · `notice_version_id → refund_notice_versions`(주문의 판본 사본) · `received_at = now()` · `answer_due_at` · `due_soon_notified_at NULL` · `overdue_notified_at NULL` · `in_progress_at NULL` · `decision_kind text NULL`(`approved`·`rejected`·`auto`) · `decided_at NULL` · `decided_by_staff_account_id NULL` · `decided_amount int NULL` · `notice_item_code text NULL`(근거가 된 공지 항목, 예 `tier:before_one_third` · `no_refund_case` · `window:d9_d7`) · `decision_note text NULL`(대표 한마디, 500자 이하) · `suggested_amount int NULL`(공지 기준 %로 미리 채운 값 / 이벤트형은 계산값) · `base_amount int NULL` · `cancel_fee_bp int NULL` · `cancel_fee_amount int NULL` · `fee_window text NULL`(이벤트형) · `withdrawn_at NULL` · `completed_at NULL` · `change_ref_id uuid NULL`(시간·장소 변경 기록, S4-3.6 — FK 는 S2-3 테이블 확정 뒤) · `idempotency_key text` · ts
- 제약
  - `ck_refund_requests_status`: `received`·`in_progress`·`completed`·`rejected`·`withdrawn`(9-6)
  - **`uq_refund_requests_idem (member_id, idempotency_key)`**(재생 = 같은 행)
  - **`uq_refund_requests_open (reservation_id) WHERE status IN ('received','in_progress')`** — 같은 예약에 처리 전 요청 둘을 막는다
  - `ck_refund_requests_decided`: `status IN ('completed','rejected')` → `decided_at IS NOT NULL` · `status = 'completed'` → `completed_at IS NOT NULL` · `status = 'withdrawn'` → `withdrawn_at IS NOT NULL`
  - `ck_refund_requests_event_final`: `NOT (kind = 'event' AND (decision_kind = 'rejected' OR status = 'withdrawn'))` — 이벤트형은 거절·철회가 없다(FR-293 「환불액을 올리는 조정만, 거절할 수 없다」 · 취소는 자리를 바로 풀기 때문, 열린 점 ⑦)
  - `ck_refund_requests_amount`: `decided_amount IS NULL OR decided_amount >= 0` · `ck_refund_requests_reject_item`: `decision_kind = 'rejected'` → `notice_item_code IS NOT NULL`(거절도 근거 항목을 고른다 — FR-293)
  - `ck_refund_requests_event_amount`: `kind = 'event'` → `decided_amount IS NULL OR decided_amount >= suggested_amount`(올리기만, 앱 검사와 같은 식을 DB 가 한 번 더 막는다)
  - `ix_refund_requests_academy_due (academy_id, status, answer_due_at)` · `ix_refund_requests_member (member_id, created_at DESC)` — 계약 문법에 DESC 가 없어 `(member_id, created_at)` 오름차순으로 만들었다(btree 역방향 읽기). 금액 보조 칸 `ck_refund_requests_calc_amounts`(음수 없음·`cancel_fee_bp` 0~10000) · 글 칸 `ck_refund_requests_text_len`(500자) 추가, `ck_refund_requests_event_amount` 는 `suggested_amount IS NULL` 도 통과(추천안·사후 확인 2026-11-24)
- `answer_due_at`: `regular` = 접수 + 3영업일(설정값 `REFUND_ANSWER_BUSINESS_DAYS`, 추천값 O-09, 영업일 계산은 S0-4.8) · `event` = 접수 + 공지 판본의 `processingBusinessDays`(상한 3). 「처리 대기 중」(회원 화면)은 **저장하지 않고** `now > answer_due_at AND status IN ('received','in_progress')` 로 계산한다

**`refunds`**(c, 이관 — §2-1 「변경 없음」을 이 절이 바꾼다) — 감사 ○
- 칸 추가: `order_id → orders NOT NULL` · `refund_request_id NULL → refund_requests` · **`basis_kind text NOT NULL`**(`request`·`closure_choice`·`bulk_item`·`statutory_withdrawal` — 법정 청약철회 환불은 수업 시작 전, 법정 철회 기간 안의 단순 취소이며 `basis_id` 는 그 취소 신청(`refund_requests.id` 또는 예약 취소 기록) id. 2026-11-20 사용자 결정 D21 — 이전: 앞의 3값) · **`basis_id uuid NOT NULL`**(그 원인 행의 id) · `execution_kind text NOT NULL`(`pg_cancel`·`owner_bank_transfer`) · `executed_by text NOT NULL`(`owner`·`system_deadline`·`system_bulk`·`system_auto`) · `executed_by_staff_account_id NULL` · `refund_account_id NULL → refund_accounts` · `cancel_fee_amount int NOT NULL DEFAULT 0`(취소 잔여금 — M5 가 5:5 로 나눈다, FR-125e) · `attempt_no int NOT NULL DEFAULT 1` · `transfer_due_at timestamptz NULL` · `transfer_completed_at NULL` · `transfer_completed_by_staff_account_id NULL` · `reinput_requested_at NULL` · `reinput_reason text NULL`(`name_mismatch`·`returned`) · `operator_flagged_at NULL`(계좌분 기한 경과, D1)
  - **S4-1.5 마이그레이션 `20261124T0909_refund_execution` 이 실제로 넣은 것(추천안·사후 확인 2026-11-24)**: `order_id`·`basis_kind`·`basis_id`·`execution_kind`·`executed_by` 는 **NULL 허용**으로 두고 `ck_refunds_basis_complete`(넷이 함께 차거나 함께 빈다 · 차면 `order_id` 필수)로 묶었다 — 옛 취소 서비스가 만든 행(원인 칸 없음)이 남아 있어 NOT NULL 로 올릴 수 없다. 옛 `uq_refunds_reservation_id_active` 는 지우지 않고 `basis_kind IS NULL`(옛 행)에만 걸리게 좁혔다. 송금 완료·재입력 칸(`transfer_completed_*`·`reinput_*`·`operator_flagged_at`)은 S4-1.5a·S4-1.14 가 넣는다. NOT NULL 승격은 S4-1.9(옛 비율표 코드 걷어 내기)가 옛 행을 정리한 뒤
- `reason` 값 추가(§3 의 `refunds.reason`): `closure_choice`(휴강 선택 환불) · `closure_auto`(7일 미선택 자동 환불) · `bulk_cancel`(행사 일괄 취소). 정규 환불·이벤트형 취소는 기존 `member_request`
- 옛 칸 `refund_account_bank_code`·`refund_account_number`·`refund_account_holder_name`(옛 FastAPI 모델의 평문 3칸) → **쓰지 않는다**. S4-1.1 마이그레이션이 삭제한다(평문 계좌는 FR-299 위반. 이관 때 값이 있었는지는 S0-5 가 확인 — 열린 점 ③) — **S4-1.1 은 두 표만 만들고 이 3칸은 남겼다**: 옛 취소 서비스(`lib/server/services/cancellation.ts`)가 아직 이 칸에 쓰므로, 그 코드를 걷어 내는 S4-1.9(옛 비율표 코드 걷어 내기)·S4-1.5(수단별 환불 실행)가 새 경로로 옮길 때 같은 마이그레이션에서 지운다(추천안·사후 확인 2026-11-24)
- **제약 교체(핵심)**: 옛 `uq_refunds_reservation_id_active (reservation_id) WHERE status <> 'failed'` 를 **`uq_refunds_basis_active (basis_kind, basis_id) WHERE status <> 'failed'`** 로 바꾼다. 옛 식은 「예약당 환불 1건」이라 한 예약에 휴강 환불 → 중도 환불처럼 부분 환불이 둘 이상 생기는 것(FR-059·FR-294)을 담지 못한다. 「같은 원인으로 두 번 환불 없음」(FR-102)은 이 유니크가, 「합이 결제액을 넘지 않음」(SC-010)은 `ck_orders_refunded_cap` 이 맡는다. 마스터 플랜 S4-1.6 의 「예약당 활성 환불 부분 유니크」 문구는 이 교체에 맞춰 고쳤다(2026-11-20 사용자 결정 D13 으로 확정 — 열린 점 ①)
- `uq_refunds_idempotency_key`(옛) 유지. 키 규칙: `refund:{basis_kind}:{basis_id}:{attempt_no}`(S4-1.5 가 만든다 — 같은 원인·같은 시도 번호는 같은 키)
- `ck_refunds_transfer_account`: `execution_kind = 'owner_bank_transfer' AND status = 'succeeded'` → `refund_account_id IS NOT NULL AND transfer_completed_at IS NOT NULL`
  - **S4-1.5a 마이그레이션 `20261124T1127_refund_transfer` 이 실제로 넣은 것(추천안·사후 확인 2026-11-24)**: `transfer_completed_at`·`transfer_completed_by_staff_account_id → staff_accounts`·`reinput_requested_at`·`reinput_reason`(`name_mismatch`·`returned`) 넷. `ck_refunds_transfer_account` 는 누른 사람(`transfer_completed_by_staff_account_id IS NOT NULL`)까지 요구하게 넓혔고, `ck_refunds_reinput`(시각·이유가 함께 차고, 차면 `status = 'failed'`)을 더했다. `notifications.kind` 에 `refund_completed`·`refund_account_reinput` 을 더했다. `operator_flagged_at` 은 S4-1.14 가 넣는다
- `ck_refunds_cancel_fee`: `cancel_fee_amount >= 0` · 기존 `refunded_amount <= requested_amount` 유지
- `ix_refunds_transfer_list (execution_kind, status, transfer_due_at)`(W31 목록·기한 경과 작업) · `ix_refunds_order (order_id)`
- `refund_rate_bp`(옛 NOT NULL, 0~10000)는 **파생값**이다: `ceilMulDiv(requested_amount, 10000, order.total_amount)`(10000 상한). 이제 산정의 입력이 아니라 기록용이다

### 9-4. 행사 일괄 취소 · 휴강 · 옮기기 (S4-2·S4-3)

**`event_cancellations`**(d) — 감사 ○
- 칸: `id` · `offering_id` · `academy_id` · `reason_kind text`(`force_majeure`·`owner_circumstance` — W18) · `reason_text text`(1~200자) · `confirmed_by_staff_account_id` · `confirmed_at = now()` · `status text = 'queued'` · `order_count int` · `participation_total int` · `booking_fee_total int` · `refund_total int` · ts
- 제약: **`uq_event_cancellations_offering (offering_id)`**(한 행사는 한 번만 취소 — 재실행은 줄 단위 재시도) · `status` 4값(9-6) · 금액 `>= 0` · `ck_event_cancellations_total`: `refund_total = participation_total`(참가비 전액 환불 — 예매 수수료 `booking_fee_total` 은 기록만 하고 돌려주지 않는다, FR-099e · 2026-11-20 사용자 결정 D15 — 이전: `refund_total = participation_total + booking_fee_total`)
- `reason_kind` 는 M5 가 PG 수수료 부담 주체를 가르는 입력이다(불가항력 = 플랫폼, 대표 사정 = 대표 상계, FR-282a)

**`event_cancellation_items`**(e)
- 칸: `id` · `event_cancellation_id` · `order_id` · `item_kind text`(`card_paid`·`account_paid`·`unpaid_closed`) · `reservation_count int` · `participation_amount int` · `booking_fee_amount int` · `refund_amount int` · `status text = 'queued'` · `refund_id NULL → refunds` · `attempt_count int = 0` · `last_failure_code NULL` · `last_attempt_at NULL` · `account_reminded_3d_at NULL` · `account_reminded_6d_at NULL` · `account_overdue_flagged_at NULL`(D14 — 계좌분이 `awaiting_account` 로 3일·6일 재알림, 7일 뒤 운영자 연락 대상 표시) · ts
- 제약: **`uq_ec_items_order (event_cancellation_id, order_id)`** · `ck_ec_items_amount`: `refund_amount = participation_amount`(예매 수수료는 환불액에 넣지 않는다 — 2026-11-20 사용자 결정 D15, 이전: `participation_amount + booking_fee_amount`) · `unpaid_closed` ↔ `refund_amount = 0`(입금 전 취소로 닫은 주문은 돈이 오가지 않는다) · `ix_ec_items_status (event_cancellation_id, status)`
- 재시도 = `status = 'failed'` 줄만 다시 집어 같은 멱등 키(`refund:bulk_item:{itemId}:{attempt}`)로 새 시도 행을 만든다. 성공·진행 중 줄은 건드리지 않는다(수용: 24건 중 3건 실패 → 재실행은 3건만)

**`event_cancel_suggestions`**(f) — 칸: `id` · `offering_id` · `academy_id` · `instructor_account_id` · `reason_text` · `status text = 'open'`(`open`·`confirmed`·`dismissed`) · `created_at` · `handled_at NULL`. 제약: `uq_ec_suggestion_open (offering_id, instructor_account_id) WHERE status = 'open'`

**`closure_choices`**(g) — 감사 ○(선택·자동 환불)
- 칸: `id` · `reservation_id` · `order_id` · `member_id` · `offering_id` · `session_id`(닫힌 회차) · `status text = 'open'` · `confirmed_at`(휴강 확정 시각) · `deadline_at`(확정일 + 7일의 KST 23:59, 설정값 `CLOSURE_CHOICE_DAYS`) · `unit_amount int`(= `ceilMulDiv(order.total_amount, 1, order.session_count)`, 만들 때 고정) · `chosen_at NULL` · `substitute_session_id NULL` · `move_id NULL → reservation_moves` · `refund_id NULL → refunds` · `notified_at NULL` · ts
- 제약: **`uq_closure_reservation_session (reservation_id, session_id)`**(휴강 확정을 두 번 불러도 선택 행은 하나) · `ck_closure_moved`: `(status = 'moved') = (substitute_session_id IS NOT NULL)` · `unit_amount >= 0` · `ix_closure_open_deadline (deadline_at) WHERE status = 'open'`(7일 자동 환불 작업이 쓴다)
- 행은 **S2-3 의 휴강 확정 트랜잭션 안에서** `openClosureChoices(sessionId)` 가 만든다(그 회차를 포함한 `confirmed` 예약마다 1행, 같은 트랜잭션에서 알림 `closure_choice_open`). 이 슬라이스에 행을 만드는 API 는 없다

**`reservation_moves`**(h) — 감사 ○
- 칸: `id` · `kind text`(`event_reschedule`·`closure_substitute`) · `order_id` · `member_id` · `seat_kind` · `from_reservation_id` · `to_reservation_id NULL` · `closure_choice_id NULL` · `from_session_id NULL` · `to_session_id NULL` · `created_at`
- 제약: **`uq_moves_order_reschedule (order_id) WHERE kind = 'event_reschedule'`**(주문당 1번, Q26) · **`uq_moves_closure_choice (closure_choice_id) WHERE kind = 'closure_substitute'`** · `ck_moves_kind`: `event_reschedule` → `to_reservation_id IS NOT NULL`; `closure_substitute` → `closure_choice_id`·`from_session_id`·`to_session_id` 모두 NOT NULL
- `event_reschedule` = 이벤트·원데이 예약을 같은 수업의 다른 회차(판매 단위)로 옮긴다(FR-109, C4C). 한 트랜잭션에서 새 예약 INSERT · 옛 예약 `cancelled`(`moved`) · 두 판매 단위의 `seat_pools` 카운터 · 캘린더 교체 · 주문 사본 덮어쓰기. 결제는 그대로(환불·재결제 없음)
- `closure_substitute` = 정규 과정에서 휴강된 1회분을 같은 과정의 다른 회차에 한 번 출석한다(C15D). 예약은 그대로 두고 대상 회차의 인원만 늘린다(`session_seat_counters`)

**`session_seat_counters`**(i) — PK(`session_id`, `seat_kind`) · `substitute_count int NOT NULL DEFAULT 0` · `ck_session_seat_substitute >= 0`
- 증가는 한 문장 조건부다(§4-4 와 같은 방식): `UPDATE session_seat_counters c SET substitute_count = c.substitute_count + 1 FROM seat_pools p WHERE c.session_id = :s AND c.seat_kind = :k AND p.offering_id = :o AND p.seat_kind = :k AND p.held_count + p.confirmed_count + c.substitute_count < p.capacity`. 행이 없으면 먼저 `INSERT … ON CONFLICT DO NOTHING`. 영향 행 0 → 409 `SEAT_SOLD_OUT`
- 회차별 자리 카운터가 데이터 모델에 없어서 만든 칸이다(`seat_pools` 는 판매 단위별). **추천안**(열린 점 ②)

### 9-5. 대기 · 우선 결제 · 동반·단체 (S4-4)

**`waitlist_entries`**(j)
- 칸: `id` · `offering_id` · `seat_kind` · `member_id` · `seq bigint`(순번 발급기가 준 번호, 작을수록 먼저) · `status text = 'waiting'` · `joined_at = now()` · `ended_at NULL` · ts
- 제약: **`uq_waitlist_seq (offering_id, seat_kind, seq)`** · **`uq_waitlist_member_active (member_id, offering_id) WHERE status IN ('waiting','offered')`**(같은 회원 중복 대기 방지) · **`ix_waitlist_next (offering_id, seat_kind, seq) WHERE status = 'waiting'`**(「1번」을 찾는 인덱스)
- 화면의 「대기 n번」 = 같은 (판매 단위·자리 종류)에서 `seq` 가 나보다 작은 `waiting`·`offered` 줄 수 + 1(저장하지 않고 센다 — 앞사람이 빠지면 자동으로 올라간다, FR-094a)
- 대기 신청은 수업 시작 24시간 전까지(FR-093·FR-108), 판매 단위가 `open`이고 해당 자리 종류가 마감일 때만(앱 검사)

**`waitlist_counters`**(k) — PK(`offering_id`, `seat_kind`) · `last_seq bigint NOT NULL DEFAULT 0`. 발급은 `INSERT … ON CONFLICT (offering_id, seat_kind) DO UPDATE SET last_seq = waitlist_counters.last_seq + 1 RETURNING last_seq` 한 문장 — 동시에 신청해도 번호가 겹치지 않는다

**`seat_offers`**(l) — 감사 ○(만료·소비)
- 칸: `id` · `entry_id → waitlist_entries` · `offering_id` · `seat_kind` · `member_id` · `cause text`(`order_cancelled`·`order_expired`·`refund_cancelled`·`priority_released`·`priority_expired`·`offer_expired`·`seat_added`) · `offered_at = now()` · `expires_at` · `status text = 'open'` · `order_id NULL` · `closed_at NULL`
- 제약: **`uq_seat_offers_open (offering_id, seat_kind) WHERE status = 'open'`**(결제 기회를 받은 사람은 언제나 한 명, FR-094a) · **`uq_seat_offers_entry (entry_id)`**(한 대기 줄은 기회를 한 번만) · `ck_seat_offers_window`: `expires_at > offered_at` · `ix_seat_offers_expiry (expires_at) WHERE status = 'open'`(넘김 작업이 쓴다)
- `expires_at = min(offered_at + 30분, 수업 시작 3시간 전)`(FR-095·FR-108, 설정값 `WAITLIST_OFFER_MINUTES`·`WAITLIST_END_BEFORE_START_HOURS`)
- **기회가 열리면 자리를 잡아 둔다**: 기회를 만드는 같은 트랜잭션에서 `seat_pools.held_count + 1`(§4-4 「자리 잡기」 조건부 UPDATE). 기회가 만료·소비되면 `held` 를 되돌리거나 주문의 `held` 로 이어진다. 그래서 대기 줄이 있는 동안 자리는 일반 판매에 다시 나오지 않는다

**`priority_slots`**(m) — 감사 ○
- 칸: `id` · `member_id` · `source_reservation_id`(지금 기간 예약) · `next_offering_id` · `seat_kind` · `deadline_at`(다음 기간 첫 수업 D-3 의 KST 23:59, FR-052b) · `status text = 'held'` · `released_at NULL` · `order_id NULL` · ts
- 제약: **`uq_priority_source_next (source_reservation_id, next_offering_id)`** · `ix_priority_deadline (deadline_at) WHERE status = 'held'`
- 슬롯을 만들 때 다음 기간 `seat_pools.held_count + 1` 조건부 UPDATE(자리가 없으면 슬롯을 만들지 않는다). 만료·「쉬어 갈래요」(`released`)면 `held` 를 풀고 `advanceWaitlist` 로 대기 1번에게 기회를 넘긴다

**`companion_groups`**(n) — 감사 ○
- 칸: `id` · `offering_id` · `kind text`(`pair`·`group`) · `payer_member_id` · `crew_name text NULL` · `size int` · `status text = 'inviting'` · `order_id NULL` · ts
- 제약: `ck_companion_size`: `size >= 2` · `kind = 'pair'` → `size = 2`(상한 10 은 설정값 `COMPANION_GROUP_MAX`라 DB CHECK 로 박지 않는다 — Q25 추천값) · `status` 5값(9-6) · `uq_companion_order (order_id) WHERE order_id IS NOT NULL`

**`companion_group_members`**(o) — PK(`group_id`, `member_id`) · `seat_kind` · `invite_status text`(`invited`·`accepted`·`declined`·`not_required`) · `reservation_id NULL`. 제약: `uq_companion_member_active (member_id, group_id)` 는 PK 와 같아 두지 않는다 · `reservation_id` 가 채워진 줄은 `uq_reservations_member_offering_active` 가 이중 신청을 막는다
- 2인 동반은 초대 수락이 필요하다(`accepted`), 단체는 크루 이름 아래 구성원을 직접 골라 `not_required`(C4B, 열린 점 ⑧)
- **결제는 한 사람(`payer_member_id`)이 주문 1건으로** 하고 예약은 구성원마다 1건(`reservations.companion_group_id`, `share_amount` = 참가비 몫). 자리 잡기는 종류별로 묶어 한 트랜잭션에서 `held_count + n` 조건부 UPDATE — 하나라도 0행이면 전체 롤백(함께 확정되거나 함께 실패, FR-105)

### 9-6. 값 집합 추가 (§4.1)

| 테이블.칸 | 값 |
|---|---|
| refund_requests.kind | `regular`(정규 문의 경로) · `event`(이벤트·원데이·파티·공연·대회 취소 신청) |
| refund_requests.status | `received`(접수) · `in_progress`(처리 중) · `completed`(완료) · `rejected`(거절) · `withdrawn`(철회) — M-06, 회원 화면 C15A·C15B 와 내 예약 카드가 같은 값 |
| refund_requests.decision_kind | `approved` · `rejected` · `auto`(기한 경과 자동 실행, 카드분만) |
| refund_requests.reason_kind | `personal` · `schedule_change` · `other`(**추천값**) |
| refund_requests.fee_window | `same_day`(결제 당일 자정 전) · `paid_within_7d_full`(결제 후 7일 전액, 10일 이상 남음) · `d10_plus` · `d9_d7` · `d6_d3` · `d2_to_deadline` — W4b·§7-6 `feeTiers.window` 와 같은 이름 |
| refunds.basis_kind | `request` · `closure_choice` · `bulk_item` · `statutory_withdrawal`(D21) |
| refunds.execution_kind | `pg_cancel`(카드 승인 취소·부분 취소) · `owner_bank_transfer`(계좌 결제분, 대표가 은행에서 송금) |
| refunds.executed_by | `owner` · `system_deadline`(기한 경과, 카드분만) · `system_bulk`(일괄 취소) · `system_auto`(휴강 7일 자동) |
| refunds.reason(추가) | `closure_choice` · `closure_auto` · `bulk_cancel` |
| refunds.reinput_reason | `name_mismatch`(받는 사람 이름이 예금주와 다름) · `returned`(송금 반송) |
| refunds.failure_code(앱 상수, 추가) | `ACCOUNT_NAME_MISMATCH` · `TRANSFER_RETURNED` · `UNSUPPORTED_PAYMENT_METHOD`(옛) · `GATEWAY_REJECTED` |
| refund_accounts.status | `active` · `superseded` |
| event_cancellations.reason_kind | `force_majeure`(불가항력) · `owner_circumstance`(대표 사정·학원 운영상 이유) |
| event_cancellations.status | `queued` · `running` · `completed` · `completed_with_failures` |
| event_cancellation_items.item_kind / status | `card_paid`·`account_paid`·`unpaid_closed` / `queued`·`awaiting_account`·`refund_started`·`done`·`failed` |
| event_cancel_suggestions.status | `open` · `confirmed` · `dismissed` |
| closure_choices.status | `open`(미선택) · `moved`(옮기기) · `refund_chosen`(환불 선택) · `auto_refund`(7일 미선택 자동 환불) · `void`(예약이 먼저 끝나 무효) |
| reservation_moves.kind | `event_reschedule` · `closure_substitute` |
| waitlist_entries.status | `waiting` · `offered`(결제 기회 받음) · `paid`(결제함) · `passed`(무응답·넘김) · `ended`(수업 3시간 전 종료) · `cancelled`(대기 취소) |
| seat_offers.status | `open` · `consumed`(주문으로 이어짐) · `expired` · `cancelled` |
| priority_slots.status | `held` · `consumed`(결제함) · `released`(「이번엔 쉬어 갈래요」) · `expired`(D-3 지남) |
| companion_groups.kind / status | `pair`·`group` / `inviting`·`ready`·`confirmed`·`failed`·`cancelled` |
| companion_group_members.invite_status | `invited` · `accepted` · `declined` · `not_required` |
| orders.status | 값 집합은 §3 그대로 — 이 슬라이스가 `partially_refunded`·`refunded` 로 가는 경로를 연다 |
| notifications.kind(추가, 회원) | `refund_request_received` · `refund_request_waiting`(처리 대기 중) · `refund_completed` · `refund_rejected` · `refund_account_reinput` · `refund_failed_member` · `event_cancelled` · `closure_choice_open` · `closure_choice_deadline` · `closure_auto_refund` · `waitlist_position_up` · `waitlist_offer` · `waitlist_offer_expired` · `waitlist_ended` · `priority_slot_open` · `priority_slot_deadline` · `priority_slot_expired` · `companion_invite` · `companion_confirmed` |
| notifications.kind(추가, 직원) | `refund_request_received_owner`(category `inquiry`) · `refund_request_due_soon_owner` · `refund_request_overdue_owner` · `refund_transfer_due_owner` · `refund_transfer_overdue_owner` · `refund_failed_owner`(category `operations`) · `refund_request_notice_instructor`(담당 강사 확인용) · `event_cancel_suggested_owner`(category `approval`) |
| refund_events.event_type(추가, 앱 상수) | `request_received` · `request_withdrawn` · `request_in_progress` · `owner_approved` · `owner_rejected` · `auto_executed` · `transfer_completed` · `transfer_reinput_requested` · `account_replaced` · `reservation_ended`(옛 `reservation_cancelled` 와 같은 자리) · `order_status_changed` |
| audit_logs.action(M4) | `refund_request.created`·`.withdrawn`·`.started`·`.approved`·`.rejected`·`.auto_executed` · `refund.executed`·`.failed`·`.transfer_completed`·`.reinput_requested` · `refund_account.saved`·`.revealed` · `event_cancellation.confirmed`·`.retried` · `event_cancel_suggestion.created` · `closure_choice.chosen`·`.auto_refunded` · `reservation.moved` · `waitlist.offer_expired` · `priority_slot.released`·`.expired` · `companion_group.confirmed` |
| 설정값(상수 한 곳) | `REFUND_ANSWER_BUSINESS_DAYS = 3` · `REFUND_DUE_SOON_HOUR_KST = 9` · `CLOSURE_CHOICE_DAYS = 7` · `WAITLIST_OFFER_MINUTES = 30` · `WAITLIST_JOIN_CLOSE_HOURS = 24` · `WAITLIST_END_BEFORE_START_HOURS = 3` · `PRIORITY_DEADLINE_DAYS_BEFORE_START = 3` · `COMPANION_GROUP_MAX = 10`(추천값) |

### 9-7. 상태 전이

**환불 요청(`refund_requests.status`)** — 모든 전이는 `UPDATE … SET status=:to WHERE id=:id AND status IN (:from)` 조건부 갱신이고 영향 행 0 이면 그 처리 전체를 되돌린다(§4-1 과 같은 방식). 같은 트랜잭션에서 `audit_logs` 1행.

| 현재 | 사건 | 다음 | 같은 트랜잭션에서 함께 바뀌는 것 |
|---|---|---|---|
| (없음) | 회원이 요청(정규) | `received` | `answer_due_at` 계산 · 담당 강사·대표 알림 · 감사 |
| (없음) | 회원이 취소(이벤트형) | `received` | **예약 `cancelled`(`event_member_cancel`) · `seat_pools.confirmed_count −1` · 캘린더 삭제 · `suggested_amount`(수수료 표 적용)** · 알림 · `advanceWaitlist`(자리가 풀림). 취소가 곧 자리를 푼다 |
| `received` | 대표가 처리 시작 | `in_progress` | `in_progress_at` · 감사 |
| `received` · `in_progress` | 회원 철회(정규만) | `withdrawn` | 예약은 그대로 · 감사 |
| `received` · `in_progress` | 대표 승인 | `in_progress` 유지(`decision_kind=approved`) | `refunds` 행 INSERT(`pending`) · `orders.refunded_total_amount` 조건부 증가 · **정규는 예약 `cancelled`(`refund_regular`) + 자리 −1 + 캘린더 삭제 + `advanceWaitlist`** |
| `received` · `in_progress` | 대표 거절(정규만) | `rejected` | 근거 항목 필수 · 알림 · 감사 |
| `in_progress` | 환불 `succeeded` | `completed` | 주문 `partially_refunded`·`refunded` · `refund_events` · 알림 |
| `in_progress` | 환불 `failed` | `in_progress` 유지 | 새 시도 행을 만들 수 있다(FR-103). 계좌분이면 `reinput_requested_at` |
| `received` | 기한 경과 + 카드분 + 이벤트형 | `in_progress` → `completed` | `decision_kind=auto`, 계산된 금액으로 PG 환불 |

**환불(`refunds.status`)** — `pending` → `succeeded` · `failed`(재시도는 새 시도 행). 카드(`pg_cancel`)는 포트 응답이 즉시 `succeeded`/`failed`(카드사 반영은 영업일이 걸려도 PG 취소 승인이면 `succeeded`), 계좌(`owner_bank_transfer`)는 `pending`(송금 대기) → 대표의 「송금 완료」로 `succeeded`, 「이름이 달라요」·반송으로 `failed`(+ 재입력). 같은 건은 한 번만 완료된다.

**휴강 선택(`closure_choices.status`)** — `open` → `moved` · `refund_chosen`(+환불 행) · `auto_refund`(기한 경과, 7일 작업) · `void`. 한 번 고르면 되돌리지 않는다.

**대기 줄(`waitlist_entries.status`)** — `waiting` → `offered`(자리 기회) → `paid` · `passed`(30분 안에 주문을 시작하지 않음). `waiting`·`offered` → `ended`(수업 3시간 전) · `cancelled`(본인). **결제 기회(`seat_offers`)** — `open` → `consumed`(주문 생성) · `expired` · `cancelled`. **우선 결제(`priority_slots`)** — `held` → `consumed` · `released` · `expired`.

### 9-8. 왜 이렇게 했나

- **환불 요청과 환불을 나눴다** — 요청은 회원·대표의 대화(상태 4종 + 철회)이고, 환불은 돈의 한 번의 시도다. 요청 하나가 실패한 시도를 여럿 가질 수 있고(FR-103), 요청 없이 생기는 환불(휴강·일괄 취소)도 있다. 그래서 `refunds` 가 `basis_kind`/`basis_id` 로 원인을 가리킨다
- **환불 1회 보장을 세 겹으로 둔다** — ① 멱등 키 `refund:{basis_kind}:{basis_id}:{attempt_no}` 유니크 ② 원인당 활성 환불 부분 유니크 ③ 주문 총액 상한 CHECK. 거기에 모든 전이가 조건부 갱신이라 동시 두 요청 중 하나는 0행으로 되돌아간다(FR-102, SC-007(중복 환불 0건))
- **계좌분은 `pending` 이 정상이다** — 계좌 결제는 원거래 취소가 없고 플랫폼은 돈을 맡지 않는다(D1). 그래서 「송금 대기」가 대기실이고, 대표가 은행에서 보낸 뒤 눌러야 끝난다

### 9-9. 열린 점(데이터)

| # | 무엇 | 추천 |
|---|---|---|
| ① | ~~마스터 플랜 S4-1.6·옛 `uq_refunds_reservation_id_active` 와 어긋난다. 예약당 환불 1건이면 휴강 환불 뒤 중도 환불이 막힌다~~ | **→ 2026-11-20 사용자 결정 D13 으로 확정** — 원인(`basis`)당 진행 중 1건 + 한 주문 환불 합계 ≤ 결제액(DB CHECK `ck_orders_refunded_cap`)으로 교체(9-3). S4-1.6 의 문구와 05 이관 테스트 설명(`동시 취소 2건 → 환불 1회`)도 같이 고쳤다 |
| ② | 회차 단위 자리 카운터가 데이터 모델에 없다(정규 휴강 보강 1회의 정원 판정). 마스터 플랜 S4-3.5 는 「새 예약 + 옛 예약 cancelled」로만 적어 이벤트형 옮기기만 설명한다 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 이벤트형은 새 예약(`event_reschedule`), 정규 휴강 보강은 `session_seat_counters`(`closure_substitute`). 보드 C15D 가 「같은 과정의 다른 날 수업에 한 번 와요」라 정규 보강은 이쪽이 맞다 |
| ③ | 옛 `refunds.refund_account_*` 평문 3칸에 이관된 값이 있는지 | S0-5 이관 점검에서 확인. 값이 있으면 암호화해 `refund_accounts` 로 옮기고 삭제. 없으면 바로 삭제 |
| ④ | 정규 환불 승인이 **예약을 끝내는가** | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 끝낸다(`refund_regular`, 자리 −1, 캘린더 삭제). 부분 환불이어도 중도 환불 = 수강 종료로 본다(C9A 「환불을 요청할 예약」). 휴강 환불은 예약을 끝내지 않는다. 사용자 확인 대기 |
| ⑤ | M3·S2-2 가 만드는 주문 스냅샷 칸의 이름(상품 종류 · 환불 마감일 · 첫 회차 시작 · 회차 수 · 수수료 표 사본) | M3 담당과 조율 — 이 절은 이름을 정하지 않고 「읽는다」고만 적었다 |
| ⑥ | `reason_kind` 값 집합 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** `personal`·`schedule_change`·`other`. `schedule_change` 는 S4-3.6(변경 알림에서 환불 요청으로)이 쓴다. spec 에 값 목록이 없다 |
| ⑦ | 이벤트형 취소는 철회할 수 없나 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 철회 없음 — 취소가 곧 자리를 풀어 대기자에게 기회가 가므로(FR-094a) 되돌리면 대기자와 충돌한다. spec 에 이벤트형 철회 문장이 없다 |
| ⑧ | 크루·동호회(FR-178)의 엔티티 · 단체 구성원의 수락 여부 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 크루 엔티티를 만들지 않고 `crew_name` 문자열 + 구성원 직접 선택(수락 없음). 크루 생성·초대 화면은 보드에 없다 |
| ⑨ | 폐강(이후 회차 전체, FR-065)의 선택 방식 — 회차마다 선택 행이 생기면 회원이 여러 번 고른다 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 같은 휴강 확정에 묶인 선택 행은 한 번의 선택을 모두에 적용(`scope: all`, 계약 12 §4). 옮길 회차가 없으면 환불만 열린다. spec 에 없음 |
| ⑩ | 대기에서 `passed` 가 된 사람 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 줄에서 빠진다(다시 걸려면 새로 신청). spec 은 「다음 순번으로 넘기고 당사자에게 통지」까지만 |
| ⑪ | ~~계좌분 일괄 취소 건의 환불 계좌를 누가 언제 입력하나~~ | **→ 2026-11-20 사용자 결정 D14 로 확정** — 일괄 취소가 확정되면 회원에게 가는 알림(`event_cancelled`)에서 바로 C9A 와 같은 입력으로 이어지고 그때 W31 에 올라와 `transfer_due_at` 이 시작된다. 줄 상태 `awaiting_account`. 3일·6일 재알림, 7일 뒤 운영자가 연락해 받는다(`account_overdue_flagged_at`). 환불받을 권리는 사라지지 않는다 |
| ⑫ | `completed` 의 뜻 — 계좌분은 송금 완료 뒤, 카드분은 PG 취소 응답 뒤 | 위 표대로. 「카드사 반영 영업일」은 상태가 아니라 안내 문구 |

---

## 10. M5(정산·지급·대사) — 6판 추가 (2026-11-20)

- 범위: 마스터 플랜(`06_master-plan.md`) 의 S5-1(정산 원장과 3단계 전이) · S5-2(강사 정산 계좌·본인확인·명세) · S5-3(대표 승인 일괄 지급 — 베타 수동) · S5-4(대사·월 마감). 짝 계약: `03_contracts/13-settlement.md`
- 기준: 2026-11-20 결정 D4(학원별 수수료 예외 없음 — 일반 5% · 개인 레슨 1%) · D12(개인 레슨 1% 공제 줄은 대표 명세에만). 2026-11-19 Q35(정산일 5일은 옮기지 않고 영업일 기한은 토·일·공휴일을 뺀다) · Q33(강사 몫 비율) · R15(예금주는 통장 사본 수동 확인). 플랫폼은 돈을 보관하지 않는다 — 지급은 대표가 은행 대량이체를 하고 「지급 완료」를 누르는 **기록**이다(Q14)
- §0 공통 규칙(uuid PK · text + CHECK · Timestamptz · 금액 `int` 원 단위 · 신규 FK 는 Restrict)과 §7 의 규칙(감사 대상 표시 · 민감 칸은 암호화한 `bytea` + 가린 값)을 그대로 따른다. **§7-3(정산 계좌) · §7-3b(사업자 상태 확인 기록) · §7-5(강사 몫 비율·직원 표시) · §7-8b(플랫폼 수수료율)는 다시 정의하지 않고** 읽거나 칸만 더한다
- 읽는 말 둘: **단계**(`stage`) = 돈이 익는 정도(`hold` 보류 → `scheduled` 정산 완료 예정 → `completed` 정산 완료). **지급 보류**(`payout_hold`) = 돈이 멈춘 것(분쟁·차지백·반송). 둘은 다른 말이다(I-06)

### 10-1. 엔티티 목록

번호는 §9 다음으로 이었다(2026-11-20 통합 — 초안의 임시 번호 `M5-n` 을 바꿈). 79 `instructor_settlement_profiles` 와 89 `holidays`·90 `holiday_sync_runs`(§10-13, M0 이 만든다)도 이 절이 정의한다.

| # | 테이블 | 구분 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| (18) | `settlement_entries` | **확장**(§2-2 #18 — 번호 그대로) | 정산 원장. 추가만 하는 줄(sale·refund·수수료·조정·상계·지급 보류) | S5-1 |
| 76 | `settlement_periods` | 신규 | 학원별 정산 기간(N월분, 정산일 다음 달 5일) · 마감 합계 | S5-1 · S5-4 |
| 77 | `payout_holds` | 신규 | 지급 보류(차지백·반송·환불 처리 중·계좌 미확인 …) | S5-1 · S5-3 |
| 78 | `chargeback_cases` | 신규 | 카드 이의제기(차지백) 사건 · 소명 | S5-1 |
| 79 | `instructor_settlement_profiles` | 신규 | 강사 정산 유형(프리랜서·사업자) | S5-2 |
| 80 | `instructor_identity_rechecks` | 신규 | 계좌 등록 직전 본인확인 재확인 기록 | S5-2 |
| 81 | `instructor_payout_accounts` | 신규 | 강사 정산 계좌(판본처럼 쌓음, 예금주 확인 상태) | S5-2 |
| 82 | `payout_batches` | 신규 | 학원·정산 기간별 지급 묶음 | S5-3 |
| 83 | `payout_items` | 신규 | 묶음 안의 강사별 지급 항목 | S5-3 |
| 84 | `payout_item_lines` | 신규 | 항목의 줄(수업별 몫·조정·풀린 보류·이월) | S5-3 |
| 85 | `settlement_disputes` · 86 `settlement_dispute_files` | 신규 | 정산 이의(강사 → 대표 · 대표 → 플랫폼) · 첨부 | S5-3 |
| 87 | `reconciliation_runs` | 신규 | 매일 대사 한 번의 결과 | S5-4 |
| 88 | `reconciliation_findings` | 신규 | 어긋남·웹훅 유실 보정 기록 | S5-4 |
| 89 | `holidays` | 신규(M0 이 만든다) | 공휴일 표 — 영업일 계산의 유일한 원천 | S0-4.7 · §10-13 |
| 90 | `holiday_sync_runs` | 신규(M0 이 만든다) | 특일 정보 자동 수집 기록(P9 상단 띠) | S0-4.10 · §10-13 |
| — | `academy_payout_accounts`(칸 추가 §10-5) · `uploaded_files`(값 추가) · `notifications`(값 추가) · `audit_logs`(값 추가) | 확장 | — | S5-2 · S5-3 |
| — | `business_status_checks` · `academy_restrictions` · `instructor_affiliations` · `instructor_share_rates`(+`_overrides`) · `platform_fee_rates` | **참조만** | 정의는 §7-3b · §7-5 · §7-8b | — |

`holidays`(공휴일 표)·`holiday_sync_runs`(수집 기록)는 M0(S0-4.7 · S0-4.10)이 만들지만 **정의는 이 절의 §10-13 한 곳**이다(2026-11-20 통합 — M5 초안의 기대 칸과 M7 초안의 칸 추가를 합쳤다). 영업일 계산 함수(S0-4.8)가 이 표만 읽는다.

---

### 10-2. 정산 원장 — `settlement_entries` 확장 (S5-1 · FR-128 ~ FR-132 · FR-125a ~ FR-125e · FR-252 · FR-253 · FR-319a)

**원장은 추가만 한다.** 틀린 줄은 고치지 않고 반대 금액의 조정 줄을 더한다(FR-319a(정산 원장 불변·마감·대사 중단)). 한 줄 = 돈의 변화 하나. 부호는 **학원 입장**이다(들어오면 +, 나가면 −). 감사 ○(조정·상계·보류 줄 — 수행자·사유).

**기존 칸**(§2-2 #18): `id` · `order_id` · `academy_id` · `kind` · `amount` · `status` · `created_at`.

**바뀌는 것**
- `kind`: 값 집합을 14종으로 넓힌다(§10-9, 2026-11-20 D23 으로 13종 → 14종). 기존 값 `payment_hold` 는 **`sale` 로 이름을 바꾼다**(데이터 이관: `UPDATE … SET kind='sale'`)
- `status`(값 `hold`) → **`stage`**(값 `hold` · `scheduled` · `completed`). `sale` 줄에만 값이 있고 다른 줄은 NULL
- `amount`: 0 이상 CHECK 를 없애고 **종류별 부호 CHECK** 로 바꾼다
- `order_id`: NULL 허용(운영자 수동 조정·이의 조정처럼 주문 없는 줄이 있다)

**더하는 칸**

| 칸 | 뜻 |
|---|---|
| `stage_changed_at timestamptz NULL` | 마지막 단계 전이 시각 |
| `scheduled_at timestamptz NULL` | `sale` 줄만. 보류 → 예정이 되는 시각(첫 회차 시작). 이벤트형은 NULL(예정을 거치지 않는다) |
| `accrues_at timestamptz NOT NULL` | **이 줄이 정산 기간에 들어갈 수 있는 시각.** `sale` = 정산 완료 시각(마지막 회차 끝 · 이벤트형은 환불 마감일 다음 날 00:00 KST, 마감 뒤 결제는 결제 시각). 그 주문의 수수료·환불 줄 = 같은 `sale` 의 값. 조정·상계·보류 줄 = `GREATEST(created_at, 관련 sale 의 accrues_at)` |
| `period_id uuid NULL → settlement_periods` | 정산일 계산이 기간을 붙인다. NULL = 아직 어느 기간에도 안 들어감 |
| `instructor_account_id uuid NULL → staff_accounts` | 결제 시점의 **담당 강사**(수업의 강사). 대타 몫은 열린 점 ⑥ |
| `instructor_is_employee boolean NULL` | `sale` 줄만. 결제 시점의 「학원 직원」 표시 사본(`instructor_affiliations.is_academy_employee`) — 표시를 바꿔도 이미 결제된 건은 그대로(이후 결제분부터 적용, 08 §4 의 열린 질문의 답) |
| `fee_category text NULL` | `sale`·수수료 줄. `general` · `private_lesson`(§7-8b) |
| `rate_bp int NULL` | 수수료 줄에 **그때 적용한 비율**(FR-125e 「항목마다 주문 시점의 수수료율과 배분 비율을 함께 적는다」) |
| `base_amount int NULL` | 수수료 줄의 계산 기준 금액 |
| `payment_id uuid NULL → payments` | 카드·PG 수수료 줄이 어느 결제에서 나왔나 |
| `source_refund_id uuid NULL → refunds` | 환불에서 나온 줄(환불·수수료 환급·취소 수수료 배분·환불 PG 수수료) |
| `adjusts_entry_id uuid NULL → settlement_entries` | 조정·상계가 바로잡는 줄 |
| `adjustment_reason text NULL` | 조정·상계 사유(§10-9) |
| `source_dispute_id uuid NULL → settlement_disputes` | 이의가 받아들여져 생긴 조정 줄 |
| `source_hold_id uuid NULL → payout_holds` | 지급 보류·해제 줄 |
| `note text NULL` · `created_by_account_id uuid NULL` | 수동 조치 사유·수행자(NULL = 시스템. FR-198(운영자 수동 조치 감사)) |

**줄 종류와 부호**(`ck_settlement_amount_sign`)

| kind | 부호 | 만드는 때 | 금액 |
|---|---|---|---|
| `sale` | + | 결제 확정(M3 S3-3.9, 같은 트랜잭션) | `orders.total_amount − booking_fee_amount`(회원이 실제로 낸 수업료 몫 — 예매 수수료는 플랫폼 몫이라 뺀다, FR-282b) |
| `platform_fee` | − | 결제 확정 | `ceilMulDiv(sale, orders.platform_fee_rate_bp, 10000)` — 면제 기간 일반 수업·행사는 0(`rate_bp=0`), 개인 레슨은 강사 가입일부터 1년 0·그 뒤 1%(결정 13, 2026-11-23 변경 — 이전: 개인 레슨 항상 1%) |
| `card_fee` · `pg_fee` | − | 결제 확정 | `payments.method='card'` 면 `card_fee`, 그 밖은 `pg_fee`. 면제 기간에도 공제(FR-125a · FR-125d). 비율은 PG 응답의 수수료 또는 설정값(열린 점 ⑭) |
| `refund` | − | 환불 실행 때, **그 주문의 `sale` 이 아직 `completed` 가 아니면** | 환불액. 보류·예정 구간은 그 자리에서 차감(FR-132) |
| `platform_fee_refund` | + | 같은 환불 | 판매 수수료 환급(취소된 몫은 판매 수수료를 받지 않는다, FR-125e). 이벤트형 취소 잔여금이 있으면 전액 환급 후 `cancel_fee_platform_share` 를 따로 |
| `cancel_fee_platform_share` | − | 이벤트형 환불(FR-099c 규정에 따른 취소 잔여금) | `ceilMulDiv(잔여금, orders.cancel_fee_platform_share_bp, 10000)`(기본 50%). 입점 1년 면제 기간에도 적용(FR-125e) |
| `booking_fee_reimbursement` | **+** | **법정 청약철회 환불 중 계좌분**(`basis_kind='statutory_withdrawal'` · `execution_kind='owner_bank_transfer'`)이 송금 완료(`succeeded`)될 때 — 카드분은 줄이 없다 | 그 환불에 포함된 예매 수수료 `booking_fee_amount`(2,000원). 대표가 예매 수수료까지 전액 송금했으므로 플랫폼이 다음 정산에서 대표에게 보전한다(플랫폼이 부담, 2026-11-20 사용자 결정 D23). `source_refund_id` 필수, `accrues_at` = 송금 완료 시각(다음 정산 기간에 들어간다). 정보 줄이 아니라 지급 합계에 더한다 |
| `refund_pg_fee` | − | 환불 실행 | PG 가 돌려주지 않은 수수료(대표 부담, FR-125c). 멤버십 환불은 플랫폼 부담이라 이 원장에 오지 않는다 |
| `payout_hold` | − | 학원 몫 지급 보류가 열릴 때(차지백 · 처리 중 환불 요청 · 행정기관 요청) | 멈춘 금액. `source_hold_id` 필수 |
| `payout_hold_release` | + | 그 보류가 풀릴 때 | 같은 금액. `accrues_at` = 푼 시각 → 다음 정산 기간에 들어간다 |
| `coupon_burden` | − | M6(S6-2)가 정의·작성 | 쿠폰·대학생 할인 차액 대표 부담(FR-119). **값 이름만 예약**(열린 점 ⑮) |
| `adjustment` | ± (0 아님) | 확정(`completed`) 뒤 환불 · 이의 수용 · 운영자 수동 · 대사 보정 | 다음 기간에 들어간다. `adjusts_entry_id`(확정 뒤 환불일 때)·사유 필수 |
| `offset` | − | 학원이 회사에 줄 돈을 정산금에서 뺄 때(FR-253(정산 상계)) | 이긴 카드 이의제기 · 행사 취소로 이미 지급한 돈 · 취소 수수료 배분금 · 입점 해지 뒤 회원 환불금(`termination_refund`, 2026-11-20 사용자 결정 D19) |

- 한 주문의 `sale` 은 하나(`uq_settlement_order_sale`). 부분 환불이 여러 번이면 `refund` 줄도 여럿이다
- **확정 뒤 환불**: `sale` 이 `completed` 면 `refund` 가 아니라 `adjustment`(사유 `refund_after_completion`, 음수 1줄 + 환급·수수료 줄은 같은 사유의 양수·음수 조정으로)를 쓴다 — 확정분은 고치지 않는다(S5-1 수용 ③)

**제약**
- `ck_settlement_kind` · `ck_settlement_adjustment_reason`(§10-9)
- **`ck_settlement_amount_sign`**: `sale`·`platform_fee_refund`·`payout_hold_release`·`booking_fee_reimbursement` → `amount >= 0` · `refund`·`platform_fee`·`cancel_fee_platform_share`·`card_fee`·`pg_fee`·`refund_pg_fee`·`payout_hold`·`coupon_burden`·`offset` → `amount <= 0` · `adjustment` → `amount <> 0`
- **`ck_settlement_stage_sale_only`**: `(kind = 'sale') = (stage IS NOT NULL)` · `ck_settlement_scheduled_sale_only`: `scheduled_at IS NULL OR kind = 'sale'`
- `ck_settlement_order_required`: `kind IN (sale, refund, platform_fee, platform_fee_refund, cancel_fee_platform_share, card_fee, pg_fee, refund_pg_fee, booking_fee_reimbursement)` → `order_id IS NOT NULL`
- `ck_settlement_sale_fields`: `kind = 'sale'` → `instructor_is_employee IS NOT NULL AND fee_category IS NOT NULL`
- `ck_settlement_adjusts`: `kind IN ('adjustment','offset')` → `adjustment_reason IS NOT NULL` · `adjustment_reason = 'refund_after_completion'` → `adjusts_entry_id IS NOT NULL`
- `ck_settlement_rate_bp`: `rate_bp IS NULL OR rate_bp BETWEEN 0 AND 10000` · `ck_settlement_accrues_after_created`: `accrues_at >= created_at`
- 기존 `uq_settlement_order_kind (order_id, kind)` 는 없앤다(환불·조정이 여러 줄이라서). 대신
  - `uq_settlement_order_sale (order_id) WHERE kind = 'sale'`
  - `uq_settlement_order_fee (order_id, kind) WHERE kind IN ('platform_fee','card_fee','pg_fee')`
  - `uq_settlement_refund_kind (source_refund_id, kind) WHERE source_refund_id IS NOT NULL`(같은 환불이 두 번 줄을 만들지 않는다)
  - `uq_settlement_hold_kind (source_hold_id, kind) WHERE source_hold_id IS NOT NULL`
  - `uq_settlement_dispute_adjustment (source_dispute_id) WHERE source_dispute_id IS NOT NULL`(이의 하나 = 조정 줄 하나)
- 인덱스: `ix_settlement_academy_accrues (academy_id, accrues_at)` · `ix_settlement_period (period_id)` · `ix_settlement_stage_due (stage, accrues_at) WHERE stage IN ('hold','scheduled')`(전이 작업) · `ix_settlement_unassigned (academy_id, accrues_at) WHERE period_id IS NULL`(정산일 계산) · `ix_settlement_instructor (instructor_account_id, period_id)`
- **고치지 않는 구조**(손으로 쓴 마이그레이션 SQL 트리거 — §7-12 ⑦ 과 같은 확인 필요): `DELETE` 금지. `UPDATE` 는 ① `stage`·`stage_changed_at` 을 **앞으로만**(`hold` → `scheduled` → `completed`) ② `scheduled_at`·`accrues_at` 를 `stage <> 'completed' AND period_id IS NULL` 일 때만(수업 시간이 바뀐 경우) ③ `period_id` 를 NULL → 값으로 **한 번만**. 그 밖의 칸 변경은 예외. 트리거가 안 되면 앱 계층 검사 + 테스트로만 지킨다(약해짐을 기록)

**합계 규칙**(속성 테스트의 정답 — S5-1.7 · SC-010b(정산 합계 일치))
1. **단계 합**: 한 학원의 `sale` 줄 `amount` 와 그 주문의 `refund` 줄 합(음수)을 더한 값을 `stage` 별로 모은 것이 보류분·예정분·완료분이다. 세 값 모두 `>= 0`
2. **결제 총액 일치**: 어느 기간이든 `보류분 + 예정분 + 완료분 + 환불분(refund 줄과 확정 뒤 환불 조정의 크기) + 조정분(확정 뒤 환불 조정·이의 조정)` = 그 기간 결제 총액(`Σ sale`)
3. **명세 합계**: 기간의 `net = Σ amount`(그 `period_id` 의 모든 줄). W13 의 「실지급액」과 1원도 다르면 안 된다
4. **환불 한도**: 한 주문의 환불 누계 ≤ 결제액(SC-010) — `refunds` 의 기존 검사에 더해 원장 쓰기 직전에도 다시 센다

### 10-3. 정산 기간 — `settlement_periods` (S5-1 · S5-4 · FR-125 · FR-319 · FR-319a)

학원마다 한 달에 한 행. **「N월분」 = N월에 수업 기간이 끝난 몫**이고 정산일은 다음 달 5일이다(I17 「11월 5일 정산 · 10월에 기간이 끝난 수업분」). 감사 ○(마감).

- 칸: `id` · `academy_id → academies` · `period_month char(7)`(`'2026-11'`) · `settle_on date`(다음 달 5일 — 주말·공휴일이어도 옮기지 않는다, Q35) · `cutoff_at timestamptz`(= 정산일 00:00 KST, 「정산일 전날 23:59:59 까지 기록된 것」, FR-319a) · `status text = 'open'` · `calculated_at NULL` · `totals jsonb NULL`(정산일 계산 때 명세 합계: 줄 종류별 합 + `net` + `entry_count`) · `closed_at NULL` · `closing_totals jsonb NULL`(마감 때 같은 모양) · `created_at`
- 제약: **`uq_periods_academy_month (academy_id, period_month)`** · `ck_periods_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'` · `ck_periods_settle_day`: `EXTRACT(day FROM settle_on) = 5` · `ck_periods_status`(§10-9) · `ck_periods_timestamps`: `status <> 'open'` ↔ `calculated_at IS NOT NULL`, `status = 'closed'` ↔ `closed_at IS NOT NULL AND closing_totals IS NOT NULL` · `ix_periods_status_settle (status, settle_on)`
- 줄이 기간에 들어가는 규칙: 정산일 계산이 `accrues_at < cutoff_at AND period_id IS NULL` 인 줄에 `period_id` 를 붙인다. 놓친 날이 있어도 다음 실행이 따라잡는다. 마감된 달의 `cutoff_at` 이후에 생긴 줄은 `accrues_at >= created_at` 이라 자연히 다음 기간으로 간다 — 마감한 달의 숫자는 바뀌지 않는다(FR-319(기준 시각·월 마감))
- 상태: `open` → `calculated`(정산일 계산 끝, 명세 합계 검증 통과) → `closed`(월 마감 — 이의 기한(정산일 + 14일)이 지났고 지급 묶음이 모두 `completed` 일 때, 열린 점 ⑫). 되돌리지 않는다

### 10-4. 지급 보류와 카드 이의제기 — `payout_holds` · `chargeback_cases` (S5-1 · S5-3 · FR-252 · FR-252a · FR-133a)

**`payout_holds`** — 감사 ○(열기·풀기). **지급 보류 = 단계 `hold` 와 다른 말**(I-06).
- 칸: `id` · `academy_id` · `party text`(`academy`·`instructor` — 누구 몫이 멈췄나, W12 「학원 몫 / 강사 몫」) · `instructor_account_id uuid NULL → staff_accounts` · `kind text` · `amount int` · `order_id uuid NULL` · `period_id uuid NULL`(보류가 열린 기간) · `source_chargeback_id uuid NULL → chargeback_cases` · `source_refund_request_id uuid NULL`(M4 의 환불 요청 — 칸 이름은 S4-1 의 테이블명에 맞춘다) · `source_item_id uuid NULL → payout_items`(항목에서 나온 보류 — 반송·계좌 미확인·대표가 뺌) · `reason_text text NULL` · `status text = 'open'` · `opened_at` · `opened_by_kind text`(`system`·`owner`·`admin`) · `opened_by_account_id NULL` · `released_at NULL` · `release_reason text NULL` · `released_batch_id uuid NULL → payout_batches`(풀린 몫이 합쳐진 묶음) · `created_at`
- 제약: `amount > 0` · `ck_holds_party`: `party = 'instructor'` ↔ `instructor_account_id IS NOT NULL` · `ck_holds_released`: `status = 'released'` ↔ `released_at IS NOT NULL AND release_reason IS NOT NULL` · `ck_holds_party_kind`: `chargeback`·`refund_pending`·`regulatory` 는 `academy`, 나머지는 `instructor` · **`uq_holds_chargeback (source_chargeback_id) WHERE source_chargeback_id IS NOT NULL`** · **`uq_holds_item (source_item_id) WHERE source_item_id IS NOT NULL`**(한 항목이 두 번 보류되지 않는다) · **`uq_holds_open_refund (order_id, kind) WHERE status = 'open' AND kind = 'refund_pending'`**(같은 주문의 처리 중 환불은 한 번만 보류) · `ix_holds_academy_status (academy_id, status)` · `ix_holds_instructor_open (instructor_account_id) WHERE status = 'open'`
- 원장과의 관계: `party='academy'` 보류는 같은 트랜잭션에 `payout_hold` 원장 줄(−)을 쓰고, 풀리면 `payout_hold_release` 줄(+)을 쓴다 — 보류·해제가 원장에 남는다(FR-252). `party='instructor'` 보류는 학원이 강사에게 주는 돈의 이야기라 **플랫폼 원장에 줄을 쓰지 않는다**(W13 의 「지급 보류 −160,000」은 학원 몫만 — W12 의 강사 몫 126,000 은 빠져 있다)
- 풀린 강사 몫(`party='instructor'`, `released_at` 있음, `released_batch_id IS NULL`)은 다음 정산일 계산이 그 강사 항목에 `hold_release` 줄로 더하고 `released_batch_id` 를 채운다
- 강사 몫이 걸린 보류가 열리면 그 강사에게 알림 `payout_held`(사유·금액, 자기 몫이 걸린 것만 — FR-252 보완)

**`chargeback_cases`** — 감사 ○
- 칸: `id` · `academy_id` · `order_id` · `payment_id` · `pg_case_id text`(PG 사건 번호) · `amount int` · `card_reason text` · `notified_at timestamptz` · `response_due_at timestamptz`(통지 + 7일 — 보드 예시값, Q37) · `status text = 'open'` · `response_note text NULL` · `responded_at NULL` · `responded_by_account_id NULL` · `decided_at NULL` · `decision_source text NULL`(`pg`·`no_response`) · `created_at`
- 소명 첨부는 `chargeback_case_files(case_id, file_id)` — PK(case_id, file_id), `file_id` 는 `uploaded_files`(`purpose='chargeback_evidence'`)
- 제약: **`uq_chargeback_pg_case (pg_case_id)`**(같은 통지가 다시 와도 한 건) · `amount > 0` · `ck_chargeback_responded`: `status = 'responded'` → `responded_at IS NOT NULL` · `ck_chargeback_decided`: `status IN ('decided_academy','decided_member')` ↔ `decided_at IS NOT NULL` · `ix_chargeback_academy_status (academy_id, status)`
- 상태: `open` → `responded` → `decided_academy`(카드사가 학원 쪽 — 보류 해제) · `decided_member`(회원 쪽 — 환불로 처리, 이미 지급했으면 `offset` 줄). 기한 안에 소명이 없으면 `open` → `decided_member`(`decision_source='no_response'`, 「기한 안에 올리지 않으면 이의제기가 받아들여져요」 O47). 환불 사유 값에 `chargeback` 이 필요한지는 M4(`refunds.reason`)와 조율

---

### 10-5. 강사 정산 유형·계좌 · 기존 테이블에 더하는 칸 (S5-2 · FR-127 · FR-133 · FR-139 · R15)

**`instructor_settlement_profiles`**(강사 정산 유형 — 학원 직원 표시는 학원마다 다르므로 `instructor_affiliations.is_academy_employee`(§7-5)가 맡고 여기에는 두지 않는다) — 감사 ○
- 칸: `instructor_account_id uuid PK → staff_accounts` · `tax_type text = 'freelancer'` · `created_at` · `updated_at`
- **사업자등록번호·등록증은 이 표에 두지 않는다**(2026-11-20 통합, §14-1) — `instructor_profiles.business_registration_number`·`business_registration_file_id`(§8-3) 한 곳에 있고 이 표는 읽기만 한다
- 제약: `ck_profiles_tax_type`(`freelancer`·`business`). 「`business` 면 사업자등록번호가 있다」는 두 표에 걸친 조건이라 CHECK 로 못 건다 — 정산 유형 저장 API(13 §3-1)가 검사하고 테스트로 고정
- **주민등록번호 칸은 만들지 않는다**(Q18(원천징수는 금액만 표시)). 정산 유형 판정: 그 학원 소속의 `is_academy_employee` 면 `academy_employee`, 아니면 이 표의 `tax_type`(행이 없으면 `freelancer`) — 순수 함수 `resolveSettlementType`

**`instructor_identity_rechecks`**(계좌 등록 직전 본인확인 재확인, Q23) — 추가 전용
- 칸: `id` · `staff_account_id → staff_accounts` · `purpose text = 'payout_account'` · `result text`(`matched`·`mismatch`) · `ci_hash text` · `verified_name text` · `birth_date date` · `verified_at timestamptz` · `expires_at timestamptz`(+30분 **추천값**) · `used_at NULL` · `used_for_account_id uuid NULL → instructor_payout_accounts`
- 제약: `ck_rechecks_used`: `(used_at IS NULL) = (used_for_account_id IS NULL)` · `ck_rechecks_used_matched`: `used_at IS NOT NULL` → `result = 'matched'` · `ix_rechecks_staff_time (staff_account_id, verified_at DESC)`
- `matched` = `ci_hash` 가 `staff_accounts.identity_ci_hash` 와 같다. 일치 값만 계좌 등록에 쓰인다. 실패 횟수 제한은 Redis(README §6-4)

**`instructor_payout_accounts`**(강사 1명에 계좌 1개, 모든 소속 학원의 정산에 같이 쓴다 — I18B) — 감사 ○(가린 값)
- 칸: `id` · `instructor_account_id → staff_accounts` · `bank_code text` · `account_enc bytea` · `account_last4 text` · `holder_name text` · `recheck_id uuid → instructor_identity_rechecks` · `holder_proof_file_id uuid → uploaded_files` · `proof_uploaded_at timestamptz` · `verification_status text = 'pending'` · `holder_verified_at NULL` · `holder_verified_by_account_id NULL → staff_accounts` · `holder_verify_method text NULL`(`manual_document` — R15 확정) · `reject_reason_code NULL` · `reject_reason_text NULL` · `status text = 'active'` · `created_at` · `replaced_at NULL`
- 제약: **`uq_instructor_accounts_active (instructor_account_id) WHERE status = 'active'`** · `ck_instructor_accounts_last4 ~ '^[0-9]{4}$'` · `ck_instructor_accounts_status`(`active`·`replaced`) · `ck_instructor_accounts_verified`: `verification_status = 'verified'` ↔ `holder_verified_at IS NOT NULL AND holder_verified_by_account_id IS NOT NULL` · `ck_instructor_accounts_rejected`: `verification_status = 'rejected'` ↔ `reject_reason_code IS NOT NULL`(`other` 면 `reject_reason_text` 도) · `ix_instructor_accounts_review (verification_status, proof_uploaded_at) WHERE status = 'active'`(P10 대기 목록)
- 바꾸기 = 옛 행 `replaced` + 새 행 `active` 를 한 트랜잭션에서. 지난 지급이 어느 계좌로 갔는지 남기려고 고치지 않고 쌓는다(§7-3 과 같음)
- **지급 가능 판정(`isPayableAccount`, S1-1.22 와 같은 함수)**: `status = 'active' AND verification_status = 'verified'`. 대표 계좌·강사 계좌가 같은 함수를 쓴다
- 예금주(`holder_name`)는 재확인의 `verified_name` 과 같아야 저장된다(앱 검사) — 다른 사람·법인 명의 계좌는 받지 않는다(FR-133)

**`academy_payout_accounts` 칸 추가**(§7-3 — M1 과 조율, 열린 점 ⑩)
- 더하는 칸: `verification_status text = 'awaiting_proof'` · `proof_uploaded_at timestamptz NULL` · `reject_reason_code text NULL`(`name_mismatch`·`file_unreadable`·`other`) · `reject_reason_text text NULL` — M7 초안의 `holder_status`·`holder_reject_*` 칸은 이것으로 합쳤다(2026-11-20 통합, P10 경로는 13 §10-2)
- 제약: `ck_payout_accounts_verified`: `verification_status = 'verified'` ↔ `holder_verified_at IS NOT NULL`(기존 칸과 맞춘다) · `ck_payout_accounts_rejected`: `rejected` ↔ `reject_reason_code IS NOT NULL` · `ck_payout_accounts_proof`: `verification_status IN ('pending','verified')` → `holder_proof_file_id IS NOT NULL`
- 기존 `holder_verified_at IS NULL` 행은 `awaiting_proof`(사본을 올리기 전)로 이관한다. 값 집합은 강사 계좌와 같다(§10-9 `verification_status` 4종)

**`uploaded_files`**(§7-3) — `purpose` 값 추가: `holder_proof`(통장 사본) · `dispute_attachment`(이의 첨부) · `chargeback_evidence`(소명 자료). 모두 `visibility = 'private'` — `ck_files_evidence_private` 를 이 값들까지 넓힌다. 열람: 올린 사람 + 운영자 + (`dispute_attachment`·`chargeback_evidence` 는 그 학원 대표와 그 이의의 처리자)

### 10-6. 지급 묶음·항목·줄 (S5-3 · FR-133a · FR-133b · FR-135d · FR-135e)

정산일 계산이 학원·기간마다 묶음 하나와 강사마다 항목 하나를 만든다. **플랫폼은 돈을 보내지 않는다** — 묶음은 「대표가 보낼 돈 목록」과 「보냈다는 기록」이다.

**`payout_batches`** — 감사 ○
- 칸: `id` · `academy_id` · `period_id → settlement_periods` · `settle_on date` · `approval_due_on date`(= `settle_on` + 5영업일, 계산 때 고정 — 12/5 토 → 12/11 금, W11) · `status text = 'calculated'` · `mode text = 'manual'`(`manual`·`pg_payout`) · `calculated_at` · `approved_at NULL` · `approved_by_account_id NULL` · `approved_item_count int NULL` · `approved_net_total int NULL` · `transfer_file_first_downloaded_at NULL`(첫 내려받기, 이후 기록은 감사) · `completed_at NULL` · `completed_by_account_id NULL` · `reminder_count int = 0` · `last_reminded_at NULL` · `snoozed_until NULL` · `created_at`
- 제약: **`uq_payout_batches_period (academy_id, period_id)`**(같은 기간 두 번 계산해도 묶음 하나) · `ck_payout_batches_status`(`calculated`·`approved`·`completed`) · `ck_payout_batches_approved`: `status <> 'calculated'` ↔ `approved_at IS NOT NULL AND approved_by_account_id IS NOT NULL` · `ck_payout_batches_completed`: `status = 'completed'` ↔ `completed_at IS NOT NULL` · `ck_payout_batches_amounts`: `approved_net_total >= 0` · `ix_payout_batches_academy_settle (academy_id, settle_on DESC)` · `ix_payout_batches_due (status, approval_due_on)`(재알림 작업)

**`payout_items`** — 감사 ○. 강사 한 명의 이번 지급. **학원 직원 강사는 항목을 만들지 않는다**(몫이 학원 매출로 남는다, FR-127). 몫 비율이 빈칸인 강사도 만들지 않는다(대표·강사 알림만).
- 칸: `id` · `batch_id → payout_batches` · `academy_id`(조회용 사본) · `instructor_account_id → staff_accounts` · `settlement_type text`(`freelancer`·`business`) · `gross_amount int`(세전 = 줄 합) · `withholding_rate_bp int = 0`(프리랜서 330) · `withholding_amount int = 0` · `net_amount int`(= `gross_amount − withholding_amount`) · `account_id uuid NULL → instructor_payout_accounts`(지급할 계좌 — 계좌가 없으면 NULL) · `status text = 'calculated'` · `held_reason text NULL` · `excluded_reason_text text NULL` · `approved_at NULL` · `paid_at NULL` · `returned_at NULL` · `return_reason_text NULL` · `created_at`
- 제약: **`uq_payout_items_batch_instructor (batch_id, instructor_account_id)`** · `ck_payout_items_amounts`: `gross_amount >= 0 AND withholding_amount >= 0 AND net_amount = gross_amount − withholding_amount` · `ck_payout_items_withholding`: `settlement_type = 'business'` → `withholding_amount = 0` · `ck_payout_items_held`: `status = 'held'` ↔ `held_reason IS NOT NULL` · `ck_payout_items_returned`: `status = 'returned'` ↔ `returned_at IS NOT NULL AND return_reason_text IS NOT NULL` · `ck_payout_items_paid`: `status IN ('paid','returned')` → `paid_at IS NOT NULL` · `ck_payout_items_account`: `status IN ('approved','paid','returned')` → `account_id IS NOT NULL` · `ix_payout_items_instructor (instructor_account_id, status)` · `ix_payout_items_batch (batch_id, status)`
- 합계 규칙(S5-3.8): 한 묶음에서 `Σ net(paid) + Σ net(returned + held) + Σ net(calculated·approved 미처리분) = Σ net(전체)` 이고, `returned`·`held` 의 금액은 같은 금액의 `payout_holds` 와 일치한다

**`payout_item_lines`** — 추가 전용. 강사 화면 I17B 「수업별 내역」의 근거.
- 칸: `id` · `item_id → payout_items` · `line_kind text` · `offering_id uuid NULL → class_offerings` · `class_id uuid NULL → classes` · `paid_count int NULL`(결제 인원) · `class_amount int NULL`(수업료 합) · `share_rate_bp int NULL`(결제 시각에 유효한 비율, 수업별 예외가 있으면 그 값 — Q33) · `share_amount int`(강사 몫, 조정은 음수 가능) · `ledger_entry_id uuid NULL → settlement_entries`(확정 뒤 환불 조정의 출처) · `dispute_id uuid NULL → settlement_disputes` · `hold_id uuid NULL → payout_holds` · `created_at`
- 제약: `ck_item_lines_kind`(§10-9) · `ck_item_lines_class`: `line_kind IN ('academy_class','private_lesson')` → `offering_id IS NOT NULL AND class_amount IS NOT NULL AND share_amount >= 0` · `ck_item_lines_refs`: `refund_adjustment` → `ledger_entry_id`, `dispute_adjustment` → `dispute_id`, `hold_release` → `hold_id` 가 NOT NULL · `ck_item_lines_rate`: `share_rate_bp IS NULL OR BETWEEN 0 AND 10000` · **`uq_item_lines_class (item_id, line_kind, offering_id, COALESCE(share_rate_bp, -1)) WHERE offering_id IS NOT NULL`**(무료 수업은 비율이 NULL) · **`uq_item_lines_dispute (dispute_id) WHERE dispute_id IS NOT NULL`**(이의 하나 = 조정 줄 하나) · **`uq_item_lines_hold (hold_id) WHERE hold_id IS NOT NULL`**(풀린 보류가 두 묶음에 들어가지 않는다)
- 강사 몫 계산: 몫 = `ceilMulDiv`(수업료, 비율)이 아니라 **내림**(강사에게 주는 돈은 학원 몫을 넘지 않게, 열린 점 ④ — 2026-11-20 사용자 결정 D16 으로 확정, 세무 확인 필요). 개인 레슨 줄은 개설한 학원의 정산에 들어간다(FR-135a). **개인 레슨 1% 공제 줄은 이 표에 없다**(D12 — 대표 명세에만, 강사 몫 계산에 들어가지 않는다)
- 마이너스 이월: 항목의 `Σ share_amount` 가 음수면 `gross_amount` 는 0 으로 두고 음수분을 다음 묶음의 `carry_forward` 줄로 넘긴다(열린 점 ⑪)

### 10-7. 정산 이의 · 대사 (S5-3 · S5-4 · FR-135f · FR-318 · FR-319)

**`settlement_disputes`** — 감사 ○. 강사 → 대표 / 대표 → 플랫폼.
- 칸: `id` · `academy_id` · `filer_kind text`(`instructor`·`owner`) · `filer_account_id → staff_accounts` · `period_id → settlement_periods` · `payout_item_id uuid NULL → payout_items`(강사 이의) · `payout_item_line_id uuid NULL → payout_item_lines` · `statement_line_code text NULL`(대표 이의가 가리킨 명세 줄 — `card_fee` 등) · `reason_code text` · `system_amount int NULL`(명세 금액) · `claimed_amount int NULL`(말한 금액) · `body text`(1~2000자, **추천값**) · `status text = 'received'` · `filed_at` · `deadline_on date`(= 정산일 + 14일, **추천값** — FR-135f) · `handler_kind text`(`owner`·`admin`) · `answered_by_account_id NULL` · `answered_at NULL` · `answer_text NULL` · `adjustment_amount int NULL` · `adjustment_entry_id uuid NULL → settlement_entries`(대표 이의 수용) · `idempotency_key varchar(200)`
- 첨부: `settlement_dispute_files(dispute_id, file_id)` PK(dispute_id, file_id) — `uploaded_files.purpose='dispute_attachment'`
- 제약: `ck_disputes_target`: `filer_kind = 'instructor'` → `payout_item_id IS NOT NULL`, `filer_kind = 'owner'` → `statement_line_code IS NOT NULL` · `ck_disputes_handler`: `handler_kind = 'owner'` ↔ `filer_kind = 'instructor'` · `ck_disputes_answered`: `status <> 'received'` ↔ `answered_at IS NOT NULL AND answered_by_account_id IS NOT NULL` · `ck_disputes_accepted`: `status = 'accepted'` → `adjustment_amount IS NOT NULL AND adjustment_amount <> 0` · `ck_disputes_rejected`: `status = 'rejected'` → `answer_text IS NOT NULL` · `ck_disputes_not_received`: `reason_code = 'not_received'` → `payout_item_id IS NOT NULL` · **`uq_disputes_idempotency (filer_account_id, idempotency_key)`** · **`uq_disputes_open_item_line (filer_account_id, payout_item_line_id) WHERE status = 'received'`** · **`uq_disputes_open_statement (academy_id, period_id, statement_line_code) WHERE filer_kind = 'owner' AND status = 'received'`** · `ix_disputes_handler (academy_id, handler_kind, status, filed_at DESC)`
- 이의 기한 판정은 앱이 `now() <= deadline_on 끝 (KST)` 로 한다. 행 사이 비교가 아니라 칸 비교지만 시계가 들어가 CHECK 로 못 건다

**`reconciliation_runs`** — 추가 전용. 매일 대사 한 번(FR-318).
- 칸: `id` · `run_date date`(KST) · `started_at` · `finished_at NULL` · `data_as_of timestamptz`(기준 시각, FR-319) · `status text`(`ok`·`mismatch`·`error`) · `pg_transactions_checked int = 0` · `finding_count int = 0` · `recovered_count int = 0` · `error_message text NULL`
- 제약: `ck_recon_runs_status` · `ck_recon_runs_finished`: `status <> 'error'` → `finished_at IS NOT NULL` · `ix_recon_runs_date (run_date DESC, started_at DESC)`(같은 날 다시 돌릴 수 있어 유니크를 두지 않는다)

**`reconciliation_findings`**
- 칸: `id` · `run_id → reconciliation_runs`(처음 발견한 실행) · `finding_key text`(같은 어긋남의 열쇠, 예 `ledger_sum_mismatch:<academyId>:2026-11` · `pg_missing_in_ledger:<gatewayPaymentId>`) · `kind text` · `academy_id uuid NULL` · `order_id uuid NULL` · `payment_id uuid NULL` · `gateway_payment_id text NULL` · `expected_amount int` · `actual_amount int` · `diff_amount int`(`actual − expected`) · `detail jsonb NULL` · `status text = 'open'` · `resolution text NULL` · `resolved_at NULL` · `resolved_by_account_id NULL`(NULL = 시스템) · `created_at`
- 제약: **`uq_recon_findings_open_key (finding_key) WHERE status = 'open'`**(같은 어긋남은 열린 채로 한 건 — 매일 다시 만들지 않는다) · `ck_recon_findings_diff`: `diff_amount = actual_amount − expected_amount` · `ck_recon_findings_resolved`: `status <> 'open'` ↔ `resolved_at IS NOT NULL AND resolution IS NOT NULL` · `ix_recon_findings_academy_open (academy_id) WHERE status = 'open'`(승인 막기 판정) · `ix_recon_findings_run (run_id)`
- 열린 어긋남이 있는 학원은 `payout_batches` 승인이 막힌다(FR-319a). 웹훅 유실 보정(`pg_missing_in_ledger`)은 보정이 끝나면 곧바로 `recovered`·`recovered_from_pg` 로 닫고 기록만 남는다(S5-4 수용 ①)

---

### 10-8. 상태 전이

모든 전이는 조건부 갱신 한 문장(`UPDATE … WHERE id=$1 AND status=$이전 상태`)이고, 영향 0 행이면 이미 처리된 것이다. 감사 행을 같은 트랜잭션에 쓴다.

| 대상 | 전이 | 누가·언제 |
|---|---|---|
| 정산 원장 `stage`(`sale` 줄) | `hold` → `scheduled`(`scheduled_at <= now`) → `completed`(`accrues_at <= now`). 건너뛰기: `hold` → `completed` 는 이벤트형·마감 뒤 결제·시간 작업이 늦은 경우에만. **뒤로 가지 않는다** | 시간 작업 `advance-stages`(출석을 보지 않는다, FR-129) |
| 정산 기간 | `open` → `calculated` → `closed` | 정산일 계산 · 월 마감 |
| 지급 묶음 | `calculated` → `approved` → `completed` | 대표 승인 · 「지급 완료」 |
| 지급 항목 | `calculated` → `approved` → `paid` → `returned`. `calculated` → `held`(계좌 미확인·대표가 뺌·학원 제한). `returned`·`held` 는 보류 행을 열고 끝난다 — 풀리면 **다음 묶음에 새 항목의 `hold_release` 줄**로 합쳐진다(옛 항목을 되살리지 않는다) | 승인 · 완료 · 반송 입력 |
| 지급 보류 | `open` → `released` | 사유가 풀릴 때(`resolved` · `account_verified` · `refund_processed` · `academy_won` · `member_won` · `admin_decision`) |
| 카드 이의제기 | `open` → `responded` → `decided_academy` · `decided_member` / `open` → `decided_member`(기한 경과) | 소명 제출 · PG 통지 · 기한 작업 |
| 정산 이의 | `received` → `accepted` · `rejected`(끝) | 대표(강사 이의) · 운영자(대표 이의) |
| 강사 계좌 확인 | `pending` → `verified` · `rejected` / (대표 계좌만) `awaiting_proof` → `pending` | 운영자(P10) · 사본 올리기 |
| 본인확인 재확인 | 행 생성 시 `matched` 또는 `mismatch`, `matched` 만 `used_at` 로 한 번 쓴다 | 강사 |
| 대사 어긋남 | `open` → `recovered` · `resolved`(끝) | 대사 보정 · 시스템 오류 수정 |

**강사 화면 단계와 항목 상태**(I17 `계산 완료 › 대표 승인 › 지급 완료`): `calculated` = 1단계(대표 승인 대기) · `approved` = 2단계(대표가 승인했고 이체 중) · `paid` = 3단계. `returned`·`held` 는 단계에 안 나오고 지급 보류 상자로 간다.

### 10-9. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| settlement_entries.kind | `sale` · `refund` · `platform_fee` · `platform_fee_refund` · `cancel_fee_platform_share` · `card_fee` · `pg_fee` · `refund_pg_fee` · `booking_fee_reimbursement`(D23 — 14종째) · `payout_hold` · `payout_hold_release` · `coupon_burden`(M6 예약) · `adjustment` · `offset` — 기존 `payment_hold` 는 `sale` 로 이름을 바꿈 |
| settlement_entries.stage | `hold`(보류) · `scheduled`(정산 완료 예정) · `completed`(정산 완료) |
| settlement_entries.adjustment_reason | `refund_after_completion`(확정 뒤 환불) · `dispute_accepted`(이의 수용) · `manual_correction`(운영자 수동 — FR-198) · `reconciliation_fix`(대사 보정) · `chargeback_lost`(카드 이의제기에서 짐, `offset`) · `termination_refund`(입점 해지 뒤 회원 환불금을 남은 정산금에서 상계, `offset` — 2026-11-20 사용자 결정 D19) · `event_cancel_return`(행사 전체 취소로 이미 지급한 돈 반환, `offset`) · `cancel_fee_owed`(취소 수수료 배분금 상계, `offset`) |
| settlement_periods.status | `open` · `calculated` · `closed` |
| payout_holds.kind | `chargeback` · `refund_pending` · `regulatory`(행정기관·법원 요청 — 운영자가 열고 이 마일스톤은 값만) · `transfer_returned` · `account_unverified` · `academy_restricted` · `owner_excluded`. (몫 비율이 빈칸이라 항목을 만들지 못한 강사는 보류 행 없이 알림 `share_rate_missing` 만 간다) |
| payout_holds.party / status / opened_by_kind | `academy` · `instructor` / `open` · `released` / `system` · `owner` · `admin` |
| payout_holds.release_reason | `resolved` · `account_verified` · `refund_processed` · `academy_won` · `member_won` · `admin_decision` |
| chargeback_cases.status / decision_source | `open` · `responded` · `decided_academy` · `decided_member` / `pg` · `no_response` |
| instructor_settlement_profiles.tax_type | `freelancer`(프리랜서 — 원천징수 3.3% 표시) · `business`(사업자 — 계산서) |
| (계산값) 정산 유형 | `freelancer` · `business` · `academy_employee`(학원 직원 — 항목 없음) |
| instructor_identity_rechecks.purpose / result | `payout_account` / `matched` · `mismatch` |
| instructor_payout_accounts.status / academy_payout_accounts.status | `active` · `replaced` |
| **verification_status**(instructor_payout_accounts · academy_payout_accounts 공통) | `awaiting_proof`(사본 올리기 전 — 대표 계좌만) · `pending`(운영자 대기) · `verified` · `rejected` |
| payout_batches.status / mode | `calculated` · `approved` · `completed` / `manual` · `pg_payout` |
| payout_items.status | `calculated` · `approved` · `paid` · `returned` · `held` |
| payout_items.held_reason | `account_unverified`(계좌 없음·확인 전) · `academy_restricted`(휴·폐업 제한) · `owner_excluded`(대표가 뺌) |
| payout_item_lines.line_kind | `academy_class` · `private_lesson` · `refund_adjustment` · `dispute_adjustment` · `hold_release` · `carry_forward` |
| settlement_disputes.filer_kind / handler_kind / status | `instructor` · `owner` / `owner` · `admin` / `received` · `accepted` · `rejected` |
| settlement_disputes.reason_code | `amount_differs`(금액이 달라요) · `missing_class`(빠진 수업이 있어요) · `refund_deduction`(환불 차감) · `other`(기타) · `not_received`(받지 못했어요, 지급 완료 항목만) |
| reconciliation_runs.status | `ok` · `mismatch` · `error` |
| reconciliation_findings.kind | `ledger_sum_mismatch`(원장 ↔ 결제·환불) · `statement_sum_mismatch`(명세 합 ↔ 원장 합) · `period_closed_drift`(마감 합계가 달라짐) · `pg_missing_in_ledger`(PG 에만 있음 — 웹훅 유실) · `ledger_missing_in_pg`(우리에게만 있음) · `pg_amount_mismatch` |
| reconciliation_findings.status / resolution | `open` · `recovered` · `resolved` / `recovered_from_pg` · `manual_fix` · `false_alarm` |
| holidays.kind / source(§10-13) | `holiday` · `substitute_holiday` · `temporary_holiday` / `api` · `operator` |
| reject_reason_code(두 계좌 표 공통) | `name_mismatch` · `file_unreadable` · `other` |
| uploaded_files.purpose(추가) | `holder_proof` · `dispute_attachment` · `chargeback_evidence` — 모두 `private`(강사 사업자 증빙은 §8 의 `business_registration_evidence`) |
| notifications.kind(추가) | 강사: `payout_paid` · `payout_held` · `payout_account_verified` · `payout_account_rejected` · `settlement_dispute_answered` · `share_rate_missing` · `payout_approval_reminder` — 대표: `payout_ready` · `payout_approval_reminder` · `settlement_dispute_filed` · `chargeback_opened` · `chargeback_decided` · `share_rate_missing` · `payout_blocked` — 운영자: `settlement_dispute_filed` · `reconciliation_mismatch` · `payout_account_review_requested`. (`payout_account_changed` 는 §7-9 값을 강사 본인에게도 쓴다) |
| notifications.category | 위 알림은 모두 `settlement`(정산), 예금주 확인·대사·공휴일 알림은 `operations` |
| audit_logs.action(추가) | `settlement_entry.adjusted` · `settlement_entry.offset` · `payout_hold.opened` · `payout_hold.released` · `chargeback.responded` · `payout_batch.calculated` · `payout_batch.approved` · `payout.transfer_file_downloaded` · `payout_batch.completed` · `payout_item.returned` · `settlement.exported` · `settlement_dispute.filed` · `settlement_dispute.answered` · `instructor_settlement_profile.changed` · `instructor_payout_account.changed` · `payout_account.holder_verified` · `payout_account.holder_rejected` · `settlement_period.closed` · `reconciliation.mismatch_found` · `reconciliation.webhook_recovered` · `holiday.added` · `holiday.removed` · `academy_restriction.released` |

### 10-10. 왜 이렇게 나눴나

- **원장은 줄(row)로 쌓고 명세는 그 줄의 합으로 만든다** — 명세를 따로 저장하면 원장과 어긋날 수 있다. 정산일에 합계 스냅샷(`totals`)만 남겨 월 마감 때 다시 계산한 값과 비교한다
- **단계는 `sale` 줄에만 둔다** — 수수료·환불 줄은 어느 단계인지가 아니라 「언제 기간에 들어가는가」(`accrues_at`)만 중요하다
- **강사 지급 항목을 학원 원장과 따로 뒀다** — 플랫폼 원장은 학원과 플랫폼 사이의 돈이고, 강사 몫은 학원이 대표 승인으로 주는 돈이다(플랫폼은 보관하지 않는다). 그래서 강사 쪽 지급 보류는 원장에 줄을 쓰지 않는다
- **반송·보류된 항목을 되살리지 않고 다음 묶음에 줄로 합친다** — 지난 지급 기록(어느 계좌로 갔나)을 고치지 않는다

### 10-11. 기존 절과 다른 곳

| 위치 | 다른 점 | 이유 |
|---|---|---|
| ① §2-2 `settlement_entries`(#18) · §3 값 표의 `settlement_entries.kind / status` 줄 | `kind` 값 `payment_hold` → `sale`(14종으로 확장), `status` → `stage`, `amount >= 0` → 종류별 부호, `uq_settlement_order_kind` 를 부분 유니크 여러 개로, `order_id` NULL 허용 | 환불·수수료·조정이 같은 원장에 줄로 쌓인다(S5-1.1). 데이터 이관은 이름 바꾸기 UPDATE 하나 |
| ② §7-3 `academy_payout_accounts` | `verification_status`·`proof_uploaded_at`·`reject_reason_text` 칸 추가 | P10 의 반려 · 사본 올리기 전 상태를 담는다. 기존 `holder_verified_at` 과 CHECK 로 맞춤 |
| ③ §7-5 끝의 「주문에 적용 강사 몫 비율 스냅샷」 | **두지 않는다.** 결제 시각(`orders.paid_at`)에 유효한 `instructor_share_rates` 행을 계산 때 찾는다. 행이 쌓이기만 하고 고치지 않아 결과가 같다 | 주문 칸을 늘리지 않는다. 학원 직원 표시만 결제 시점 값이 필요해 `settlement_entries.instructor_is_employee` 사본을 둔다 |
| ④ 플랜 6-1 「주문 스냅샷: 판매자(학원) id · 담당 강사 id」 | 주문이 아니라 **원장 `sale` 줄**(`academy_id`·`instructor_account_id`)에 둔다 | 정산 쓰임이라 원장이 소유한다. `orders` 에 새 칸 없음 |
| ⑤ §7-9 `uploaded_files.purpose` · `notifications.kind` · `audit_logs.action` | 값 추가(§10-9) | 이 마일스톤의 파일·알림·감사 |
| ⑥ §7-12 ⑦(감사 기록 트리거 확인) | 원장 줄을 고치지 못하게 하는 트리거도 같은 확인에 기댄다 | 같은 마이그레이션 SQL 경로 |

### 10-12. 열린 점(데이터)

| # | 무엇 | 추천값 — 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) |
|---|---|---|
| ① | 이벤트형의 완료 시각(환불 마감 다음 날)이 SC-010a 와 글자로 충돌 | FR-282e 예외로 두고 SC-010a 시험에서 이벤트형을 뺀다(spec 정리 필요) |
| ② | 한 기간의 `sale` 이 `completed` 로 넘어간 뒤 수업 시간이 바뀌면(S2-3) `accrues_at` 를 못 고친다 | `stage <> 'completed'` 일 때만 고치도록 막아 둠. 완료 뒤 변경은 조정 줄 |
| ③ | `payment_hold`(기존 값)의 이관 영향 — M3 가 이미 줄을 쓰고 있다면 이름 바꾸기 | 이관 UPDATE 1회. 시험 DB 는 새로 만든다 |
| ④ | ~~끝수: 플랫폼 수수료는 올림(spec). PG·카드 수수료·강사 몫·원천징수는 spec 에 없다~~ | **→ 2026-11-20 사용자 결정 D16 으로 확정** — 플랫폼 수수료 올림 · 강사 몫과 원천징수 3.3% 는 내림(`floorMulDiv` 추가). 세무 확인 필요. PG·카드 수수료는 올림(D20 임시 확정) |
| ⑤ | W13 보드의 「총 결제액」이 단계와 무관한 월 전체 — 명세는 완료분만 | 계약은 완료분만 기간에 넣는다. 보드 정정 요청 |
| ⑥ | 대타 회차 몫(I-10) | S2-3 과 조율 — 안 정해지면 담당 강사 1명에게 전부 |
| ⑦ | 대표 이의(W14)를 처리하는 운영자 화면 없음 | M7 과 조율. 테이블은 `handler_kind='admin'` 으로 준비됨 |
| ⑧ | 무료 수업 0원 줄 | 원장에 안 쓰고 조회가 예약에서 만든다 |
| ⑨ | `payout_batches.transfer_file_first_downloaded_at` 외에 내려받기 횟수 제한·재확인 | 제한 없이 감사로만 |
| ⑩ | **2026-11-20 통합으로 닫음** — 공휴일 표는 §10-13, 계좌 확인 칸은 §10-5, 소명 글은 §12 `restriction_explanations`, 운영자 API 는 13 §10. (옛 내용) `holidays`(M0) · `academy_restrictions` 소명 칸(§7-3b, M1) · `academy_payout_accounts` 칸(§7-3, M1) · 공휴일·예금주·사업자 운영자 API(M7) | 각 담당과 조율. 이 절의 칸은 제안 |
| ⑪ | 강사 지급이 음수가 되는 달 | 0 원 + `carry_forward` 줄로 이월 |
| ⑫ | 월 마감 시점 | 정산일 + 14일 뒤 + 묶음 모두 `completed` |
| ⑬ | 정산일 09:00 알림 | 행은 계산 때, 발송 시각은 S7-1 |
| ⑭ | 카드·PG 수수료율 출처 | PG 응답 수수료 우선, 없으면 설정값. SP-2 확인 |
| ⑮ | **2026-11-20 통합으로 닫음(§14-3)** — `coupon_burden` 줄(M6) · sale 이 실제 낸 금액인지 정가인지 | M6 와 조율 — 이 절은 값 이름만 예약 |
| ⑯ | `payout_item_lines` 가 수업(제공) 단위라 주문 단위 근거(이의 시 개별 주문)는 원장 줄로 거슬러 올라간다 | 줄에 `offering_id` 만 두고 주문은 원장 조회로 |
| ⑰ | I17 「다음 정산까지 쌓이는 금액」이 수업료 기준인지 강사 몫 기준인지 보드에 없다(「받을 금액」과 같은 선상이라 몫으로 읽힌다) | 강사 몫 기준(결제 시각 비율 적용, 원천징수 전). 비율이 빈칸인 수업은 제외하고 안내 |

### 10-13. 공휴일 표·수집 기록 — 정의 한 곳 (2026-11-20 통합 · M0 의 S0-4.7(공휴일 표 칸)·S0-4.10(특일 정보 수집 작업)이 만든다)

M5 초안(기대 칸)과 M7 초안(§12-3 칸 추가 · `holiday_sync_runs`)을 합쳤다. 영업일 계산 함수(S0-4.8)·정산 승인 기한(13 §7)·문의 응답 기한(15 §2-2)·P10 「1영업일 넘음」이 이 표 하나만 읽는다. 운영자 경로는 13 §10-1.

**`holidays`**(89) — 감사 ○(운영자 입력 줄만)
- 칸: `id` · `date date` · `name text` · `kind text`(`holiday`·`substitute_holiday`·`temporary_holiday`) · `source text`(`api`·`operator`) · `created_by_account_id uuid NULL → staff_accounts` · `created_at` · `updated_at` · `deleted_at timestamptz NULL`(운영자 입력 줄 지우기)
- 제약: **`uq_holidays_date (date) WHERE deleted_at IS NULL`** · `ck_holidays_kind` · `ck_holidays_source` · `ck_holidays_operator`: `source='operator'` ↔ `created_by_account_id IS NOT NULL` · `ck_holidays_api_not_deleted`: `source='api'` → `deleted_at IS NULL`(자동 수집 줄은 고치거나 지울 수 없다, Q35 — 수정 금지는 API 가 409 `HOLIDAY_NOT_EDITABLE`)
- 같은 날짜에 자동 값이 들어오면 자동 값이 이긴다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 15 열린 점 ⑱ — 사람 결정 대기): 운영자 줄을 `deleted_at` 으로 닫고 자동 줄을 넣는다

**`holiday_sync_runs`**(90) — 추가 전용
- 칸: `id` · `ran_at timestamptz` · `source text = 'kasi_special_days'`(공공데이터포털 특일 정보) · `year int` · `status text`(`success`·`failed`) · `rows_upserted int` · `error_code text NULL`
- 제약: `ck_holiday_sync_status` · `ix_holiday_sync_ran (ran_at DESC)`. 실패하면 `holidays` 는 그대로 두고 이 행과 운영자 알림만 남긴다(S0-4.10). P9 상단 「마지막 자동 수집 … 성공」을 만든다

---

## 11. M6(멤버십·쿠폰·혜택·레벨·행사) — 7판 추가 (2026-11-20)

- 작성 2026-11-20
- 짝: `_workspace/03_contracts/14-membership-benefits.md`(API) · `contract_map_M6.json`(Task 연결)
- 범위: 마스터 플랜 S6-1(회원·강사 멤버십 — 정기결제) · S6-2(1+1 쿠폰·참여 학원·대학생 혜택) · S6-3(레벨·카드·개강 후보) · S6-4(파티·공연·대회 피드)
- 기준: §0 공통 규칙(uuid PK · text+CHECK · timestamptz · 금액 int 원 단위 · 신규 FK 는 Restrict) · §7 의 「감사 ○」 표기 · 2026-11-20 결정 D7(레벨업 = 정규 수업 한 기간을 끝까지 마치고 출석 70% 이상, 결석 표시는 레벨에 반영) · FR-112 계열 · FR-121 계열 현행 문장
- 이미 있는 엔티티(`members` · `staff_accounts` · `orders` · `order_events` · `payments` · `payment_webhook_events` · `reservations` · `class_sessions` · `class_offerings` · `seat_pools` · `notifications` · `audit_logs` · `settlement_entries` · `attendance_marks` · `uploaded_files`)는 다시 정의하지 않는다. 칸을 더할 때만 「칸 추가」로 적는다
- **「멤버십」은 회원·강사·대표의 유료 상품 이름이다. 「구독」은 학원 소식 받기(FR-023a)에만 쓴다.** 테이블·칸 이름에 `subscription` 을 쓰지 않는다(이 절의 이름은 모두 `membership`)

### 11-1. 엔티티 목록

번호는 §10 다음으로 이었다(2026-11-20 통합 — 초안의 임시 번호 `M6-n` 을 바꿈).

| # | 테이블 | 묶음 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 91 | `membership_plans` | 멤버십 | 요금표(판본으로 쌓음) — 회원 3개월·연, 강사 월·연 | S6-1 |
| 92 | `memberships` | 멤버십 | 회원·강사(대표 포함) 멤버십 한 건 — 체험부터 종료까지 | S6-1 |
| 93 | `membership_events` | 멤버십 | 멤버십 상태 전이 기록(추가 전용) | S6-1 |
| 94 | `billing_methods` | 멤버십 | 정기결제 수단(빌링 키는 암호화) | S6-1 |
| 95 | `membership_charges` | 멤버십 | 청구 시도(첫 결제·갱신·재시도·직접 결제) | S6-1 |
| 96 | `membership_notices` | 멤버십 | 갱신 고지·체험 종료 안내 기록(멱등 근거) | S6-1 |
| 97 | `trial_grants` | 멤버십 | 체험은 본인확인 CI 한 사람당 한 번 | S6-1 |
| 98 | `coupons` | 쿠폰 | 1+1 쿠폰·동반자 첫 수업 무료 쿠폰 | S6-2 |
| 99 | `coupon_redemptions` | 쿠폰 | 쿠폰을 어느 주문에 걸고 썼는지(잠금·사용·되살림) | S6-2 |
| 100 | `companion_seats` | 쿠폰 | 동반자가 첫 회차에 차지하는 남·여 자리 | S6-2 |
| 101 | `university_verifications` | 혜택 | 학교 이메일 인증(이메일 원문 없음) | S6-2 |
| 102 | `university_benefit_uses` | 혜택 | 대학생 첫 결제 50% 사용 기록 | S6-2 |
| 103 | `academy_exposure_events` | 참여 효과 | 1+1 참여 학원 노출·누름 집계 원천(회원 1명·하루 1번) | S6-2 |
| 104 | `ranking_snapshots` | 참여 효과 | 실시간 인기 수업 순위판 스냅샷(대표 리포트 원천) | S6-2 |
| 105 | `member_genre_levels` | 레벨 | 회원의 세부 장르별 레벨 0~10 | S6-3 |
| 106 | `course_completions` | 레벨 | 정규 과정 한 기간의 완주·출석 판정 기록 | S6-3 |
| 107 | `level_promotions` | 레벨 | 레벨이 오른 이력(완주·강사 승급) | S6-3 |
| 108 | `level_cards` | 레벨 | 발급된 등급 카드(카드 모음) | S6-3 |
| 109 | `instructor_level_evaluations` | 레벨 | 강사 평가 레벨(모집용, 회원에게 보이지 않음) | S6-3 |
| 110 | `level_offers` | 레벨 | 강사가 올려 준 레벨 제안(멤버십 강사가 보냄, 회원이 고름 — 2026-11-24) | S6-3 |
| 111 | `candidate_contact_consents` | 레벨 | 개강 후보 연락처 제공 동의 | S6-3 |
| 112 | `event_hosts` | 행사 | 주최자(학원·개인·동호회) + 승인 상태 | S6-4 |
| 113 | `event_details` | 행사 | 파티·공연·대회 상세(주최자·장소·외부 예매) — `classes` 와 1:1 | S6-4 |
| 114 | `event_performers` | 행사 | 공연 출연 팀·장르 | S6-4 |
| 115 | `competition_options` | 행사 | 대회 종목·부문 선택지와 종목별 한 쌍 참가비 | S6-4 |
| 116 | `competition_entries` · 117 `competition_entry_disciplines` | 행사 | 대회 신청(부문·파트너·고른 종목) | S6-4 |
| 118 | `event_interests` | 행사 | 관심(♡) 등록 | S6-4 |

---

### 11-2. S6-1 멤버십 — FR-112(멤버십 결제수단) · FR-112a(연 멤버십 10% 할인) · FR-112b(멤버십은 플랫폼 상품) · FR-112d(신규 가입 3개월 체험) · FR-112e(강사 멤버십·1년 체험) · FR-113(정기결제 재시도) · FR-113a(멤버십 결제 수단 변경) · FR-297(멤버십 해지) · FR-297a(멤버십 환불 없음)

**`membership_plans`** — 감사 ○(요금 변경은 회원 약관 제9조 ④ 가격 인상 통지 규칙을 따른다)
- 칸: `id` · `plan_code text` · `price_amount int` · `period_months smallint` · `audience text` · `effective_from timestamptz` · `created_by_account_id NULL` · `created_at`
- 제약: `ck_plans_code`(§11-9) · `price_amount >= 0` · `period_months IN (1, 3, 12)` · `uq_plans_code_effective (plan_code, effective_from)`. 가입 시점의 값을 `memberships`·`membership_charges.amount` 에 **복사해 고정**한다(요금표를 바꿔도 지난 청구는 그대로)
- 시드(2026-11-20 spec 현행): `member_3m` 3,000(3개월) · `member_year` 10,800(12개월) · `instructor_month` 10,000(1개월) · `instructor_year` 108,000(12개월). 연 요금은 「월(3개월) 요금 × 기간 수 − 10%」를 **앱 함수 하나**(`computeYearlyPrice`)가 계산해 판본으로 넣는다. 행 사이 계산이라 CHECK 로 못 건다 → 단위 테스트가 12,000 − 1,200 = 10,800 · 120,000 − 12,000 = 108,000 을 고정한다
- 요금을 바꾸는 API 는 이 회차에 만들지 않는다(운영자 스크립트·시드 — 열린 점 ①)

**`memberships`** — 감사 ○(해지·수단 변경·플랜 변경). 사람 한 명(회원 또는 직원 계정)당 지금 살아 있는 멤버십은 하나다
- 칸: `id` · `owner_kind text`(`member`·`staff`) · `member_id uuid NULL → members` · `staff_account_id uuid NULL → staff_accounts` · `plan_code text NULL` · `status text` · `trial_source text NULL` · `trial_started_at NULL` · `trial_ends_at NULL` · `anchor_date date NULL`(처음 기준일, KST 달력 — Q31) · `period_index int = 0`(몇 번째 기간인가) · `current_period_start timestamptz NULL` · `current_period_end timestamptz NULL`(끝 시각, 이 시각 전까지 쓴다) · `auto_renew boolean = false` · `billing_method_id uuid NULL → billing_methods` · `pending_plan_code text NULL`(다음 기간부터 바뀔 플랜 — 3개월 → 연) · `retry_count smallint = 0` · `first_failed_at timestamptz NULL` · `cancel_requested_at NULL` · `ended_at NULL` · `ended_reason text NULL` · ts
- 제약:
  - `ck_memberships_owner`: `(owner_kind='member' AND member_id IS NOT NULL AND staff_account_id IS NULL) OR (owner_kind='staff' AND staff_account_id IS NOT NULL AND member_id IS NULL)`
  - `ck_memberships_status`(§11-9) · `ck_memberships_trial`: `status='trial'` 이면 `plan_code IS NULL AND trial_ends_at IS NOT NULL`
  - `ck_memberships_paid`: `status IN ('active','retrying','cancel_scheduled')` 이면 `plan_code`·`anchor_date`·`current_period_start`·`current_period_end` 모두 NOT NULL, `current_period_end > current_period_start`
  - `ck_memberships_retry`: `retry_count BETWEEN 0 AND 3` · `retry_count > 0` ↔ `status='retrying'`
  - `ck_memberships_cancel`: `status='cancel_scheduled'` ↔ `cancel_requested_at IS NOT NULL`(해지를 취소하면 `active` 로 돌아가며 칸을 비운다)
  - `ck_memberships_plan_owner`: `plan_code LIKE 'member\_%'` 이면 `owner_kind='member'`, `instructor\_%` 이면 `'staff'`
  - `ck_memberships_ended`: `status IN ('expired','ended')` ↔ `ended_at IS NOT NULL`
  - **`uq_memberships_member_live (member_id) WHERE status IN ('trial','active','retrying','cancel_scheduled')`** · **`uq_memberships_staff_live (staff_account_id) WHERE …같은 상태…`** — 한 사람 한 멤버십(FR-112e 「한 강사가 여러 학원에서 가르쳐도 멤버십은 하나」)
  - `ix_memberships_due (status, current_period_end)` — 갱신 청구·만료 작업이 읽는다 · `ix_memberships_trial_end (status, trial_ends_at)`
- **다음 결제일은 늘 처음 기준일에서 다시 계산한다**(Q31). `기간 k 의 시작일 = addMonthsClamped(anchor_date, k × period_months)` — 없는 날짜는 그달 말일(FR-120a: 1월 31일 → 4월 30일 → 7월 31일). 재시도로 5일에 성공해도 다음 결제일은 기준일 3일이다. 순수 함수 `nextBillingDate(anchorDate, periodIndex, periodMonths)` 하나가 계산하고 단위 테스트가 FR-120a 예를 고정한다
- 체험(`trial`): 회원은 가입일부터 3개월(FR-112d, 쿠폰 없음), 직원 계정은 강사 계정 활성일 또는 대표 입점 승인일부터 1년(FR-112e). 대표의 「가맹점 프로모션」(수수료 5% 시작일부터 1년 더 무료)은 `trial_ends_at` 을 늘리는 것으로 표현하고 `membership_events` 에 사유를 남긴다 — 수수료 시작일의 출처는 `academies.platform_fee_exempt_until`(§7-3, M5 와 조율)
- 체험에서 결제로 넘어갈 때 체험 남은 기간은 버린다(추천 — 열린 점 ②)

**`membership_events`** — 추가 전용(수정·삭제 불가 — `audit_logs` 와 같은 방식, 열린 점은 §7-12 ⑦ 과 같다)
- 칸: `id` · `membership_id` · `from_status NULL` · `to_status` · `reason text`(`first_payment`·`renewal_paid`·`retry_failed`·`retry_paid`·`retry_exhausted`·`cancel_requested`·`cancel_undone`·`period_ended`·`trial_ended`·`trial_extended`·`plan_changed`) · `charge_id NULL` · `created_at`. `ix_membership_events_membership (membership_id, created_at)`

**`billing_methods`** — 감사 ○(수단 교체). **빌링 키·계좌 정보는 응답·로그·감사 기록 어디에도 내보내지 않는다**(FR-299). 화면용 가린 값만 따로 둔다
- 칸: `id` · `owner_kind` · `member_id NULL` · `staff_account_id NULL`(같은 짝 CHECK) · `kind text`(§11-9) · `auto_renewable boolean` · `provider text`(PG 이름) · `billing_key_enc bytea NULL`(자동 갱신 수단만, AES-GCM — §7 민감 칸 규칙, 키는 S0-6 목록에 추가) · `display_label text`(예 `카드 ****1234`) · `status text = 'active'`(`active`·`replaced`·`removed`) · `created_at` · `replaced_at NULL`
- 제약: `ck_billing_methods_key`: `auto_renewable` 이면 `billing_key_enc IS NOT NULL`, 아니면 NULL · `ix_billing_methods_member (member_id, status)` · `ix_billing_methods_staff (staff_account_id, status)`
- 자동 갱신 여부(`auto_renewable`)는 **수단 종류가 정하지 않고 등록 때 PG 가 알려 준 값**이다 — 간편결제는 PG 가 정기결제를 지원하는 것만 `true`(FR-112 「간편결제 자동 갱신은 PG 가 지원하는 것만」). 지원하지 않으면 `kind='easy_pay'` 라도 `false` 로 둔다
- 직접 결제 수단(`manual_transfer`·`virtual_account`)은 빌링 키가 없다. 행은 「이 회원이 직접 결제를 고른 수단」을 남기는 용도다

**`membership_charges`** — 감사 ×(이 테이블이 청구 기록 자체). 멤버십 결제는 `orders`·`payments` 를 쓰지 않는다 — 수업 주문 모양(`offering_id` 필수)과 맞지 않고 플랫폼 상품이라 학원 정산을 타지 않는다(FR-112b)
- 칸: `id` · `membership_id` · `billing_method_id NULL` · `kind text`(`first`·`renewal`·`manual_renewal`) · `attempt_no smallint = 0`(0 = 정규 청구, 1~3 = 다시 결제) · `plan_code` · `amount int`(고정값) · `period_start timestamptz` · `period_end timestamptz` · `basis_date date`(그 기간의 처음 기준일 계산값 — 쿠폰 발급·소멸 기준) · `scheduled_at` · `attempted_at NULL` · `status text` · `method text NULL`(§11-9) · `gateway_payment_id varchar(64) NULL` · `pg_transaction_id NULL` · `virtual_account_bank_code/_number/_holder NULL`(직접 결제) · `due_at NULL`(직접 결제 입금 기한) · `failure_code text NULL` · `failure_message text NULL`(카드사 응답 문구 — 개인정보 없음, C8A 에 그대로 보임) · `paid_at NULL` · `created_at`
- 제약:
  - `ck_charges_status`(§11-9) · `amount >= 0` · `attempt_no BETWEEN 0 AND 3` · `period_end > period_start`
  - `ck_charges_succeeded`: `status='succeeded'` ↔ `paid_at IS NOT NULL`
  - **`uq_charges_attempt (membership_id, period_start, attempt_no)`**(같은 시도를 두 번 만들지 않는다 — 작업이 겹쳐 돌아도 1행)
  - **`uq_charges_period_succeeded (membership_id, period_start) WHERE status='succeeded'`**(한 기간에 성공은 한 번 — 이중 청구 방지의 DB 최후 방어선)
  - `uq_charges_gateway_payment_id (gateway_payment_id) WHERE gateway_payment_id IS NOT NULL` · `ix_charges_due (status, scheduled_at)`
- 웹훅은 `gateway_payment_id` 의 접두어(`mbr_`)로 수업 결제(`payments`)와 갈라 이 테이블로 보낸다. 같은 `payment_webhook_events` 원장(`uq_webhook_events_webhook_id`)을 그대로 쓴다(열린 점 ③)

**`membership_notices`** — 감사 ×
- 칸: `id` · `membership_id` · `kind text`(§11-9) · `target_date date`(그 고지가 가리키는 결제일·종료일) · `notification_id → notifications` · `created_at`
- **`uq_membership_notices (membership_id, kind, target_date)`** — 갱신 7일 전 고지가 작업을 두 번 불러도 1건(S6-1 수용 ①). 알림 행의 `dedupe_key` 는 `membership:<id>:<kind>:<target_date>`

**`trial_grants`** — 감사 ×(추가 전용)
- 칸: `id` · `kind text`(`member_trial`·`staff_trial`) · `identity_ci_hash text` · `membership_id → memberships` · `granted_at`
- **`uq_trial_grants_ci (kind, identity_ci_hash)`** — 체험은 본인확인 CI 한 사람당 한 번(FR-112d·FR-112e·FR-010(재가입 혜택 차단)). 탈퇴 뒤 다시 가입해도 이 행이 남는다(§11-8 보존 규칙과 같은 기한 — M7 15-ops 와 조율). 대표가 강사로 먼저 체험을 받았으면 `staff_trial` 이 이미 있어 다시 주지 않는다

#### 상태 전이 — 멤버십(`memberships.status`)

| 현재 | 사건 | 다음 | 같은 트랜잭션에서 함께 바뀌는 것 |
|---|---|---|---|
| (없음) | 회원 가입 완료 / 강사 계정 활성 / 대표 입점 승인 | `trial` | `trial_grants` 1행(CI 가 이미 있으면 **체험 없이** 만들지 않는다) · `trial_ends_at` |
| `trial` | 첫 결제 성공 | `active` | `plan_code`·`anchor_date`(= 성공한 날 KST)·`current_period_*`·`period_index=0` · charge `succeeded` · 쿠폰 발급(3개월 → 1+1 한 장, 연 → 동반자 한 장) |
| `trial` | `trial_ends_at` 경과 | `ended`(`trial_ended`) | 혜택 잠금 |
| `active` | 갱신 청구 성공 | `active` | `period_index + 1`·`current_period_*` 갱신 · 쿠폰 발급 |
| `active` | 갱신 청구 실패(정규 시도) | `retrying` | `retry_count=0` 유지·`first_failed_at`·charge `failed` · 알림 · **혜택은 유지** |
| `retrying` | 다시 결제 성공 | `active` | 기간·`anchor_date` 는 **처음 기준일 그대로**(Q31) · 쿠폰은 이 순간 한 장(기준일 = 처음 기준일) |
| `retrying` | 다시 결제 실패 3번째 | `ended`(`retry_exhausted`) | 혜택 잠금 · 그 회차 쿠폰 없음 |
| `active`·`retrying` | 회원이 해지 | `cancel_scheduled` | `cancel_requested_at` · 다음 청구 만들지 않음 · 이미 받은 쿠폰은 기간 안에 쓴다 |
| `cancel_scheduled` | 같은 기간 안에 해지 취소 | `active` | `cancel_requested_at = NULL` |
| `cancel_scheduled` | `current_period_end` 경과 | `expired` | 혜택 잠금 · 남은 기간 환불 없음(FR-297a) |
| `active`(자동 갱신 아님) | `current_period_end` 까지 다음 기간 결제 없음 | `expired` | 3일 전 알림은 `membership_notices(manual_pay_3d)` |
| `active`(자동 갱신 아님) | 끝나기 전 직접 결제 성공 | `active` | `current_period_end` 를 **이어서** 늘린다(끊기지 않으면 계속된 것으로 본다 — FR-112) |
| `expired`·`ended` | 다시 가입 | **새 행** | 옛 행은 그대로 남긴다. 체험은 주지 않는다(`trial_grants`) |

혜택 열림 판정(`benefits`): `trial`(쿠폰 제외)·`active`·`retrying`·`cancel_scheduled` 은 열림, `expired`·`ended` 는 잠김. 서버가 이 함수 하나로 계산하고 화면은 값만 그린다.

---

### 11-3. S6-2 쿠폰·혜택 — FR-120(멤버십 1+1 쿠폰) · FR-120a(쿠폰 생성 조건) · FR-120b(동반자 첫 수업 무료 쿠폰) · FR-121(1+1 쿠폰 사용 조건) · FR-121a~121c · FR-122(1+1 쿠폰 소멸) · FR-123(쿠폰 본인 사용) · FR-123a(쿠폰 알림 세 순간) · FR-296(환불 후 쿠폰 처리) · FR-091a(정원 마감 시 결제·쿠폰 차단) · FR-006~008(대학생 인증) · FR-118(대학생 첫 결제 50%) · FR-119(할인 차액 대표 부담)

**`academies` 칸 추가**(§7-3 행에 더한다) — 감사 ○(`academy.coupon_participation_changed`)
- `one_plus_one_enabled boolean = false`(FR-121c) · `companion_coupon_enabled boolean = false`(FR-120b — 1+1 과 **따로** 고른다) · `coupon_first_enabled_at timestamptz NULL`(처음 켠 시각 — 신규 참여 학원 NEW 한 달(FR-121e)의 시작. 껐다 켜도 지우지 않는다)

**`coupons`** — 감사 ×(쿠폰의 사용·소멸은 `coupon_redemptions` 와 이 행의 상태가 기록)
- 칸: `id` · `member_id → members` · `kind text`(`one_plus_one`·`companion_free`) · `status text = 'available'` · `source_charge_id → membership_charges` · `basis_date date`(발급 기준일 — 재시도로 늦게 성공해도 **처음 기준일**, FR-120a) · `issued_at timestamptz`(실제 발급 시각) · `expires_at timestamptz` · `used_at NULL` · `expired_at NULL` · `first_seen_at NULL`(받은 뒤 첫 접속 안내를 보인 시각 — FR-123a ②) · `expiry_notice_shown_at NULL`(소멸 전 안내) · ts
- 만료: 1+1 은 `addMonthsClamped(basis_date, 3)` 의 KST 하루 끝, 동반자 쿠폰은 **그 연 멤버십의 `current_period_end`**(FR-120b — 달력 연말이 아니다)
- 제약: `ck_coupons_kind`·`ck_coupons_status`(§11-9) · `expires_at > issued_at` · `ck_coupons_used`: `status='used'` ↔ `used_at IS NOT NULL` · **`uq_coupons_source_kind (source_charge_id, kind)`**(결제 한 번 = 쿠폰 한 장, 작업이 겹쳐도 1장) · `ix_coupons_member_status (member_id, status, expires_at)`
- **잠금은 한 문장 조건부 갱신이다**: `UPDATE coupons SET status='held' WHERE id=:id AND member_id=:me AND status='available' AND expires_at > now()` — 영향 행이 1 이 아니면 쓸 수 없다. 같은 쿠폰이 두 결제에 동시에 잡히지 않는다(FR-121 마지막 불릿, FR-096 과 같은 방식)

**`coupon_redemptions`** — 감사 ○(되살림 `coupon.restored`)
- 칸: `id` · `coupon_id` · `member_id` · `kind text`(쿠폰 종류 사본) · `status text`(`held`·`used`·`released`·`restored`) · `paid_order_id → orders`(정가로 신청한 주문) · `free_offering_id → class_offerings NULL`(1+1 추가 수업) · `free_order_id → orders NULL`(추가 수업의 0원 주문) · `companion_member_id → members NULL` · `companion_gender text NULL`(§3 `members.gender`) · `bearer_academy_id → academies`(자리를 내주는 참여 학원) · `discount_amount int = 0`(추가 수업 1달치 — 쿠폰 줄 금액) · `held_at` · `used_at NULL` · `released_at NULL` · `release_reason text NULL`(`order_expired`·`order_cancelled`·`seat_lost`) · `restored_at NULL` · ts
- 제약:
  - `ck_redemptions_kind_shape`: `kind='one_plus_one'` 이면 `free_offering_id`·`free_order_id` NOT NULL, `companion_*` NULL · `kind='companion_free'` 이면 `companion_member_id`·`companion_gender` NOT NULL, `free_*` NULL
  - **`uq_redemptions_paid_order (paid_order_id)`**(한 신청에 쿠폰 한 장 — 1+1 두 장·1+1 과 동반자 겹침 모두 막는다) · `uq_redemptions_free_order (free_order_id) WHERE free_order_id IS NOT NULL`
  - **`uq_redemptions_coupon_live (coupon_id) WHERE status IN ('held','used')`**(쿠폰 하나는 살아 있는 사용이 하나) · `discount_amount >= 0` · `ck_redemptions_used`: `status='used'` ↔ `used_at IS NOT NULL`
- 1+1 의 두 주문: 정가 주문(§2-1 `orders`, 쿠폰 줄 0)과 **추가 수업 주문**(`list_price_amount` = 그 수업 1달치 가격, `coupon_discount_amount` = 같은 값, `total_amount` = 0, `price_breakdown` 에 쿠폰 줄). 추가 수업 주문은 결제 없이(0원 경로, S3-3) 같은 트랜잭션에서 `paid` 로 확정된다. 동반자 쿠폰은 쿠폰 줄이 없다(동반자는 돈을 내지 않고 자리만 쓴다)

**`companion_seats`** — 동반자 쿠폰의 첫 회차 자리
- 칸: `redemption_id → coupon_redemptions`(PK) · `session_id → class_sessions`(그 수업의 **첫 회차**) · `seat_kind text`(`male`·`female`) · `status text`(`held`·`confirmed`·`released`) · `created_at`
- 제약: `ix_companion_seats_session (session_id, seat_kind, status)`. 회차별 정원 칸이 없어(`seat_pools` 는 판매 단위별) **DB CHECK 로 못 건다** — 쿠폰 사용 때 `seat_pools` 행을 `FOR UPDATE` 로 잠그고 `confirmed_count + held_count + (이 회차의 활성 동반자 수) < capacity` 를 앱이 검사한다(열린 점 ⑤)

**`university_verifications`** — 감사 ○(`university_verification.revoked`). **학교 이메일 원문 칸은 없다**(FR-008)
- 칸: `id` · `member_id → members` · `school_domain text`(예 `snu.ac.kr`) · `email_hash text`(HMAC-SHA256(`UNIVERSITY_EMAIL_PEPPER`, 소문자 정규화 이메일) — 키는 S0-6 목록에 추가) · `status text`(`pending`·`verified`·`expired`·`revoked`) · `token_hash text`(인증 링크 토큰의 해시) · `token_expires_at timestamptz` · `last_sent_at` · `send_count smallint = 1` · `verified_at NULL` · `revoked_at NULL` · `revoke_reason text NULL`(`not_student`·`fraud`) · ts
- 제약: `ck_univ_domain`: `school_domain ~ '\.ac\.kr$'`(FR-006) · **`uq_univ_email_blocked (email_hash) WHERE status IN ('verified','revoked')`**(FR-006b — 같은 이메일로 두 번째 인증 거부. 허위로 판명돼 회수된 이메일도 계속 막는다) · `uq_univ_member_open (member_id) WHERE status IN ('pending','verified')` · `ck_univ_verified`: `status='verified'` ↔ `verified_at IS NOT NULL`
- 「메일 다시 보내기」는 서버가 이메일을 모르므로 **요청에 이메일을 다시 받아** 해시가 같은지 확인한 뒤 보낸다. 이메일은 요청이 끝나면 어디에도 남지 않는다(메일 발송 수단은 열린 점 ⑥)
- 유효 시간(`token_expires_at`)의 값은 spec 이 정하지 않았다(FR-006a — 화면에 숫자를 쓰지 않는다) → 설정값, 추천 24시간

**`university_benefit_uses`** — 감사 ○
- 칸: `id` · `member_id` · `identity_ci_hash text` · `verification_id → university_verifications` · `order_id → orders` · `discount_amount int` · `status text`(`applied`·`reverted`·`clawback_due`·`clawed_back`) · `applied_at` · `reverted_at NULL` · `clawback_marked_at NULL` · ts
- 제약: **`uq_univ_benefit_order (order_id)`** · **`uq_univ_benefit_member_live (member_id) WHERE status <> 'reverted'`** · **`uq_univ_benefit_ci_live (identity_ci_hash) WHERE status <> 'reverted'`**(첫 결제 1회뿐 — 탈퇴 뒤 재가입으로 다시 받지 못한다, FR-010) · `discount_amount >= 0`
- `reverted` = 전액 환불로 혜택 회차를 되돌림(FR-296), `clawback_due` = 허위 인증 판명(FR-007)으로 정상가 재청구 대상으로 기록, `clawed_back` = 재청구 처리 끝. 재청구 실행 경로는 이 회차에 없다 — 기록만(열린 점 ⑦)
- `orders.benefit_discount_amount` 에 같은 금액이 들어간다. 할인액 = 신청한 수업 **1달치** 가격의 50%(여러 달이 묶여도 1달치만, FR-118) — 1달치 가격의 출처는 열린 점 ④

**`academy_exposure_events`** — 참여 효과 리포트(FR-121i)의 원천. **회원 1명이 한 학원에 하루 1번만 센다**(대표·강사 계정은 넣지 않는다)
- 칸: `id` · `academy_id` · `member_id` · `kind text`(`new_card_impression`·`new_card_click`·`participant_list_click`) · `occurred_on date`(KST) · `created_at`
- 제약: **`uq_exposure_member_day (academy_id, member_id, kind, occurred_on)`**(`INSERT … ON CONFLICT DO NOTHING`) · `ix_exposure_academy_day (academy_id, kind, occurred_on)`
- 이 행을 쓰는 쪽은 신규 참여 학원 카드(FR-121e)·참여학원 목록(FR-121h, 보드 C32B) 화면이다. **그 화면을 만드는 Task 가 로드맵에 없다**(열린 점 ⑧) — 그 전에는 리포트의 해당 칸이 `available: false`

**`ranking_snapshots`** — 6시간마다 계산한 실시간 인기 수업 순위(FR-121d, 보드 C32A)
- 칸: `computed_at timestamptz` · `genre text` · `rank smallint` · `class_id → classes` · `academy_id` · `search_views int` · PK(`computed_at`, `genre`, `rank`) · `rank BETWEEN 1 AND 10`
- 대표 리포트의 「최고 순위」「순위판에 오른 수업」이 읽는다. 만드는 쪽은 열린 점 ⑧

**정산 연결(M5 와 조율 — 13-settlement.md)**: `settlement_entries.kind`(§3)에 `coupon_burden`(M5 13-settlement.md 열린 점 ⑮ 가 이 이름으로 M6 의 정의를 기다린다) 하나를 더하자고 **제안**한다 — 주문 하나에 한 줄이다. 대학생 50% 주문은 `amount = −orders.benefit_discount_amount`(부호는 §10-2 `ck_settlement_amount_sign` 을 따른다 — §14-3)(대표 부담 차액 — 합계에 더하지 않는 정보 줄), 1+1 추가 수업·동반자 쿠폰 주문은 `amount = 0`(사용 표시만 — FR-121c·FR-119 「정산에는 금액 없이 사용 여부만」). 합계 보존 식: `list_price_amount = (total_amount − booking_fee_amount) + benefit_discount_amount + coupon_discount_amount`(앱이 두 할인의 합을 `list_price_amount` 로 자른다 — 하한 0 때문에 식이 깨지지 않게). `uq_settlement_order_kind (order_id, kind)` 는 그대로 맞는다

---

### 11-4. S6-3 레벨·카드·개강 후보 — FR-160~FR-163 · FR-164(개강 후보 추천) · FR-165(후보 연락처 동의) · FR-169(세부 장르별 레벨 자동 계산) · FR-169a(출석률 반영 레벨) · FR-169d(강사 레벨 등급 조절) · FR-169e(등급 카드 발급 애니메이션) · FR-169f(카드 모음 화면) · FR-272(명단 출력 동의)

**결정 D7(2026-11-20)**: 레벨업 = 「정규 수업 한 기간을 끝까지 마치고 출석 70% 이상」. 화면에는 출석 횟수·% 숫자를 띄우지 않고 이 문구 하나만 쓴다. **결석은 회원·강사·대표가 표시한 것을 센다**(`attendance_marks`, §7-8 — 행이 있으면 결석). 판정에 쓰는 횟수는 서버 안에서만 쓰고 응답에 내리지 않는다

**`members` 칸 추가**: `featured_level_card_id uuid NULL → level_cards`(`ON DELETE SET NULL` — 대표 캐릭터, FR-169c). `ix` 불필요

**`member_genre_levels`** — 감사 ×
- 칸: `member_id → members` · `detail_genre text`(§11-9, 세부 장르) · `level smallint` · `updated_at` · PK(`member_id`, `detail_genre`)
- 제약: `ck_levels_range`: `level BETWEEN 0 AND 10`(FR-160) · 행이 없으면 레벨 0 이고, 수강 기록이 없을 때만 가입 때 고른 경험 수준(`members.experience_level`)으로 읽는다(`entry`→0 · `beginner`→2 · `novice_intermediate`→4 · `intermediate`→6 · `advanced`→8 · `dancer`→10 — **추천 매핑**, 열린 점 ⑨)
- **레벨은 내려가지 않는다**(FR-169): 모든 쓰기는 `UPDATE … SET level = :to WHERE member_id=:m AND detail_genre=:g AND level < :to` 한 문장이고, 0행이면 이미 그 이상이라는 뜻이다
- 단계 이름은 저장하지 않고 레벨에서 계산한다: 0~1 입문 · 2~3 초급 · 4~5 초중급 · 6~7 중급 · 8~9 고급 · 10 댄서(FR-161)

**`course_completions`** — 정규 과정 한 기간의 판정 기록(멱등 근거 + 강사 「지난 수업」의 수강 완료 이력(보드 I38)의 원천)
- 칸: `id` · `offering_id → class_offerings` · `member_id` · `reservation_id` · `order_id` · `completed boolean`(기간이 끝날 때까지 환불하지 않고 수강을 유지) · `attended_sessions smallint` · `total_sessions smallint`(**서버 안 전용** — 응답에 내리지 않는다) · `level_awarded boolean` · `promotion_id → level_promotions NULL` · `evaluated_at`
- 제약: **`uq_completions_offering_member (offering_id, member_id)`**(작업을 두 번 불러도 같은 결과) · `attended_sessions BETWEEN 0 AND total_sessions`
- 판정(순수 함수 `evaluateCompletion`): 대상 = `classes.class_kind='regular'` 이고 `enrollment_unit='term'` 인 판매 단위. 시각 조건 = **마지막 회차 종료 + 48시간 뒤**(결석 표시 확정 시점 — S3-4.3b). `completed` = 그때까지 그 예약이 `confirmed` 이고 그 주문이 `paid`(부분 환불·취소 없음). `total_sessions` = 휴강·폐강 회차를 뺀 회차 수(열린 점 ⑩). `attended_sessions = total − (유효한 결석 표시 수)`. **`completed AND attended_sessions × 10 >= total_sessions × 7`** 이면 1칸(8회 과정이면 6회 이상)
- `ck_completions_award`: `level_awarded` ↔ `promotion_id IS NOT NULL`

**`level_promotions`** — 감사 ×(추가 전용)
- 칸: `id` · `member_id` · `detail_genre` · `from_level smallint` · `to_level smallint` · `source text`(`course_completion`·`instructor_offer`) · `offering_id NULL` · `offer_id → level_offers NULL` · `created_at`
- 제약: `to_level > from_level` · 두 칸 `BETWEEN 0 AND 10` · **`uq_promotions_completion (member_id, offering_id) WHERE source='course_completion'`** · `ck_promotions_source`: `course_completion` ↔ `offering_id IS NOT NULL` / `instructor_offer` ↔ `offer_id IS NOT NULL` · 완주 승급은 한 번에 +1 만(`to_level = from_level + 1` — 앱 검사 + 테스트)

**`level_cards`** — 감사 ×
- 칸: `id` · `member_id` · `detail_genre` · `level smallint` · `promotion_id → level_promotions` · `revealed_at timestamptz NULL`(등급 알림 연출을 본 시각 — 앱을 열었을 때 NULL 인 카드가 있으면 연출) · `created_at`
- 제약: **`uq_level_cards_member_genre_level (member_id, detail_genre, level)`** · **`uq_level_cards_promotion (promotion_id)`**. 카드는 발급된 것만 행이 있다 — 강사 승급을 「아니오」로 거절하면 카드도 레벨 변화도 없다(FR-169e). 본인 레벨업(완주)은 **묻지 않고** 바로 발급한다

**`instructor_level_evaluations`** — 감사 ○(`level.evaluation_set`). **회원에게 보이지 않는다**(수용 ③) — 응답 모양에서 키 자체를 뺀다
- 칸: `instructor_account_id → staff_accounts` · `member_id` · `detail_genre` · `eval_level smallint` · `evaluated_at` · PK(`instructor_account_id`, `member_id`, `detail_genre`) · `ck`: 0~10
- 강사는 올리고 내릴 수 있다(내리면 평가 레벨에만 남고 회원에게 안내하지 않는다 — I23). 강사가 새 반 후보를 모을 때 쓴다(FR-164)

**`level_offers`** — 감사 ○(`level.offer_sent`). **멤버십 강사만** 보낼 수 있고 받는 회원은 멤버십 무관(2026-11-24 FR-169d 개정 — 이전 2026-10-15 「멤버십 회원에게만」). 회원 레벨 이하로 다시 정하면 그 강사가 연 제안은 `superseded` 로 닫는다(추천안·사후 확인 2026-11-24, S6-3.4)
- 칸: `id` · `member_id` · `instructor_account_id` · `offering_id NULL`(어느 수업 명단에서) · `detail_genre` · `from_level` · `to_level` · `status text`(`offered`·`accepted`·`declined`·`superseded`) · `offered_at` · `responded_at NULL` · ts
- 제약: `to_level > from_level`(**올리는 경우만** — 회원 레벨은 내려가지 않는다) · **`uq_level_offers_open (member_id, detail_genre) WHERE status='offered'`**(같은 회원·장르에 열린 제안은 하나 — 강사가 다시 올려 주면 이전 제안을 `superseded` 로 닫고 새로 만든다)
- `accepted` = 「이 레벨로 승급하기」 → `level_promotions(instructor_offer)` + 카드 발급 · `declined` = 「지금 레벨에서 내가 키우기」 → 레벨·카드 변화 없음. 한 번 답한 제안(`accepted`·`declined`)과 `superseded` 에 다시 답하면 409 — 레벨이 이미 제안 이상이면 `accepted` 로 닫되 승급 기록·카드는 없다(추천안·사후 확인 2026-11-24, S6-3.9)

**`candidate_contact_consents`** — 감사 ○
- 칸: `member_id`(PK) · `consented boolean` · `consented_at NULL` · `withdrawn_at NULL` · `updated_at`
- 행이 없으면 **동의하지 않은 것**이다. 동의를 받는 화면이 보드에 없다(열린 점 ⑪)
- 연락처 「보기」 조회는 `audit_logs`(`candidate.contact_viewed`, 대상 = `members`) 에 남긴다. 새 테이블을 만들지 않는다(누가 언제 봤는지가 §7-7 열이 이미 담는다)
- **S6-3.1 구현에서 더한 것(추천안·사후 확인 2026-11-24)**: 레벨 칸은 `smallint` 대신 `int`(계약 문법·다른 표 관례) · CHECK 추가 `ck_completions_award_requires_completed`(완주 안 하면 지급 불가) · `ck_promotions_completion_step`(완주 1칸을 DB 도 막음) · `ck_level_offers_responded`(`accepted`·`declined` ↔ `responded_at`) · `ck_candidate_consents_state`(동의 중이면 `consented_at` 있고 `withdrawn_at` 없음) · `ck_level_cards_range`(0~10) · 부분 UNIQUE `uq_promotions_offer`(같은 제안으로 두 번 승급 금지) · 색인 `ix_level_cards_unrevealed`·`ix_evaluations_candidates`·`ix_promotions_member_genre`·`ix_completions_member`·`ix_level_offers_instructor` · `level_promotions.offering_id` 에 `class_offerings` FK · 완주 승급은 `offer_id IS NULL` 도 요구

---

### 11-5. S6-4 파티·공연·대회 피드 — FR-150(파티·공연·대회 피드) · FR-151(파티 검색) · FR-152(파티 신청·결제) · FR-153(외부 예매 연결) · FR-154(관심 이벤트 알림) · FR-155(주최자 표시) · FR-156(대회 참가 양식) · FR-157(공연 출연자)

행사는 `classes`(`class_kind IN ('party','performance','competition','event')`)와 `class_offerings`·`class_sessions`·`seat_pools` 를 그대로 쓴다. 이 절은 행사만 필요한 칸을 **`event_details` 하나로** 모은다 — `classes` 를 넓히지 않는다

**`event_hosts`** — 감사 ○(`event_host.approved`·`.rejected`)
- 칸: `id` · `host_kind text`(`academy`·`individual`·`club`) · `academy_id → academies NULL` · `applicant_staff_account_id → staff_accounts NULL` · `display_name text` · `status text`(`pending`·`approved`·`rejected`·`suspended`) · `submitted_at NULL` · `decided_at NULL` · `decided_by_account_id NULL` · `approved_at NULL`(수수료 1년 면제 기산일 — FR-155) · `reject_reason_text NULL` · ts
- 제약: `ck_event_hosts_shape`: `host_kind='academy'` 이면 `academy_id IS NOT NULL AND status='approved'`, 아니면 `academy_id IS NULL AND applicant_staff_account_id IS NOT NULL` · **`uq_event_hosts_academy (academy_id) WHERE academy_id IS NOT NULL`** · **`uq_event_hosts_applicant_open (applicant_staff_account_id) WHERE status IN ('pending','approved')`** · `ck_event_hosts_decided`: `status IN ('approved','rejected')` ↔ `decided_at IS NOT NULL`
- 학원 주최자 행은 그 학원의 첫 행사 등록 때 만든다(입점 승인된 학원은 승인 없이 올릴 수 있다 — FR-155). 개인·동호회는 신청 → 운영자 승인 뒤에만 행사를 올린다. **심사 기준·제출 서류·정산 계좌 연결은 spec 이 정하지 않았다**(⚠ FR-155) — 열린 점 ⑫

**`event_details`** — `classes` 와 1:1
- 칸: `class_id → classes`(PK) · `host_id → event_hosts` · `booking_mode text = 'platform'`(`platform`·`external`) · `external_booking_url text NULL` · `is_festival boolean = false`(FR-077 축제 태그) · `venue_name text` · `venue_address text` · `region_sido text` · `region_gu text` · `poster_file_id → uploaded_files NULL` · ts
- 제약: **`ck_event_details_external`**: `(booking_mode='external') = (external_booking_url IS NOT NULL)` · `external_booking_url ~ '^https://'` · `ix_event_details_region (region_sido, region_gu)` · `ix_event_details_host (host_id)`
- 외부 예매는 공연에만 둔다(FR-153) — `classes.class_kind='performance'` 인지는 두 테이블에 걸쳐 CHECK 로 못 건다 → 등록 API 검사 + 테스트(열린 점 ⑬). `booking_mode='external'` 인 행사에는 판매 단위·주문이 생기지 않는다(S6-4 수용 ③)
- **게시 판정**: 행사는 `host.status='approved'` 일 때만 `published` 로 갈 수 있다(S6-4 수용 ②) — 게시 상태기계(`classes`/`class_offerings` — M2 `S2-2`)의 게시 가드에 조건 하나를 더한다. 이 절은 규칙만 정하고 가드 코드는 M2 와 조율
- 행사를 등록하는 경로는 수업 등록(S2-2)이 같은 양식을 재사용한다(FR-077) — 등록 Task 가 `event_details` 도 채우도록 조율

**`event_performers`** — 공연 출연자(FR-157)
- 칸: `id` · `class_id` · `seq smallint` · `team_name text` · `instructor_name text NULL` · `genre text NULL`(§3 genre) · 제약 `uq_event_performers_seq (class_id, seq)`

**`competition_options`** — 대회 종목·부문(FR-156)
- 칸: `id` · `class_id` · `option_kind text`(`discipline`·`division`) · `label text` · `pair_fee_amount int NULL`(종목마다 **한 쌍** 기준 참가비) · `seq smallint`
- 제약: `ck_competition_options_fee`: `discipline` 이면 `pair_fee_amount >= 0` NOT NULL, `division` 이면 NULL · `uq_competition_options_label (class_id, option_kind, label)`. 부문의 나이·경력 기준은 대회 공지 글로 넘긴다(FR-156)

**`competition_entries`** · **`competition_entry_disciplines`** — 한 쌍을 신청한 한 사람이 결제한다
- `competition_entries`: `id` · `order_id → orders`(UNIQUE) · `class_id` · `division_option_id → competition_options` · `partner_name text` · `partner_gender text` · `partner_member_id → members NULL`(파트너가 앱 회원이면 일정 알림) · `created_at`
- `competition_entry_disciplines`: `entry_id → competition_entries` · `option_id → competition_options` · PK(`entry_id`, `option_id`) — 종목은 여러 개, 부문은 하나(FR-156)
- 주문의 `list_price_amount` 는 고른 종목의 `pair_fee_amount` 합이고, 예매 수수료(FR-282a)는 참가자 수만큼 별도 줄이다. **가격 계산이 판매 단위 가격 대신 합계를 쓰는 분기가 생긴다 — M3(03 §3 가격 계산)와 조율**(열린 점 ⑭)

**`event_interests`** — 관심 등록(♡, FR-154)
- 칸: `member_id` · `class_id` · `created_at` · PK(`member_id`, `class_id`) · `ix_event_interests_class (class_id)`
- 알림: 관심 표시한 행사가 열리거나(`event_opened`) 일정이 확정·변경되면(`event_changed`) `notifications` 행을 쓴다. 받는 사람이 여럿이라 **`dedupe_key` 에 받는 사람 id 를 넣는다**(`event:<classId>:opened:<memberId>`) — §7-7 의 `uq_notifications_dedupe (kind, dedupe_key)` 는 받는 사람별 구분이 없어서다

---

### 11-6. 상태 전이 모음(이 절이 새로 만드는 상태 기계)

| 대상 | 전이 | 근거 |
|---|---|---|
| 멤버십 | §11-2 표 | FR-112 · FR-113 · FR-297 |
| 청구 시도 | `scheduled` → `succeeded` · `failed` / 직접 결제 `ready` → `succeeded` · `expired` · `cancelled` | FR-113 · FR-112 |
| 쿠폰 | `available` → `held`(주문 잠금) → `used`(주문 확정) · `available`(주문 만료·취소로 풀림) / `available` → `expired`(유효기간) / `used` → `available`(전액 환불·유효기간 남음 — 되살림, FR-296) | FR-121 · FR-122 · FR-296 |
| 쿠폰 사용 | `held` → `used` · `released` / `used` → `restored` | FR-296 |
| 대학생 인증 | `pending` → `verified` · `expired` / `verified` → `revoked` | FR-006 · FR-007 |
| 대학생 혜택 | `applied` → `reverted`(전액 환불) · `clawback_due` → `clawed_back` | FR-296 · FR-007 |
| 레벨 제안 | `offered` → `accepted` · `declined` · `superseded` | FR-169d · FR-169e |
| 주최자 | `pending` → `approved` · `rejected` / `approved` → `suspended` | FR-155 |

모든 전이는 `UPDATE … WHERE id=:id AND status=:from` 조건부 갱신 한 문장으로 하고, 영향 행이 1 이 아니면 그 처리 전체를 되돌린다(§4-1 과 같다).

### 11-7. 쿠폰과 주문·환불이 맞물리는 규칙(쓰는 곳 S6-2.3 · S6-2.4 · S4-1)

- 쿠폰을 쓰는 주문 생성은 **한 트랜잭션**에서 ① 쿠폰 잠금(조건부 갱신) ② 추가 수업 판매 단위·자리 검사(`SEAT_SOLD_OUT` 이면 쿠폰을 쓰지 않은 상태로 되돌린다 — FR-091a) ③ `coupon_redemptions(held)` ④ 주문·0원 추가 주문 생성을 한다
- 정가 주문이 `expired`·`cancelled` 가 되면 같은 트랜잭션에서 `held` → `released` 로 쿠폰이 `available` 로 돌아온다
- 환불 확정(S4-1 실행 경로) 때 FR-296: **전액 환불 + 쿠폰 유효기간 남음** → `used` → `available`·redemption `restored`, **부분 환불·유효기간 지남** → 되살리지 않는다. 동반자 쿠폰·1+1 모두 같다. 대학생 혜택은 **전액 환불일 때만** `applied` → `reverted`
- 정원이 이미 찬 수업의 결제·쿠폰은 막는다(FR-091a). 결제가 진행되는 사이에 차면 그 결제를 확정하지 않고 쿠폰도 쓰지 않은 상태로 되돌린다

### 11-8. 보존 연결(M7 15-ops 와 조율)

`trial_grants`·`university_benefit_uses`(`identity_ci_hash`)는 **탈퇴 뒤에도 남아야 재가입 혜택 차단이 된다**(FR-010). 이 두 표의 식별 칸은 개인정보 보존 기한(O-16 5년·3년·3개월) 표에 「재가입 차단용으로 남김」 항목으로 올린다. 나머지(`memberships`·`coupons`·`level_*`·`event_interests`)는 탈퇴 때 회원 화면에서 사라지고 보존 기한 표를 따른다.

### 11-9. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| membership_plans.plan_code | `member_3m` · `member_year` · `instructor_month` · `instructor_year` |
| memberships.owner_kind | `member` · `staff` |
| memberships.status | `trial` · `active` · `retrying` · `cancel_scheduled` · `expired` · `ended` |
| memberships.trial_source | `member_signup` · `instructor_activation` · `owner_approval` · `owner_fee_start_extension` |
| memberships.ended_reason | `trial_ended` · `retry_exhausted` · `period_ended` |
| billing_methods.kind | `card` · `easy_pay` · `auto_transfer`(계좌 자동이체) · `manual_transfer`(일반 계좌이체) · `virtual_account` |
| billing_methods.status | `active` · `replaced` · `removed` |
| membership_charges.kind / status | `first` · `renewal` · `manual_renewal` / `scheduled` · `ready` · `succeeded` · `failed` · `expired` · `cancelled` |
| membership_charges.method | `card` · `easy_pay` · `auto_transfer` · `manual_transfer` · `virtual_account`(§3 `payments.method` 의 값과 이름을 맞출 필요는 M3 와 조율 — 열린 점 ③) |
| membership_notices.kind | `renewal_7d` · `manual_pay_3d` · `trial_ending_30d` · `trial_ending_7d` · `trial_ended` |
| trial_grants.kind | `member_trial` · `staff_trial` |
| coupons.kind / status | `one_plus_one` · `companion_free` / `available` · `held` · `used` · `expired` |
| coupon_redemptions.status / release_reason | `held` · `used` · `released` · `restored` / `order_expired` · `order_cancelled` · `seat_lost` |
| companion_seats.status | `held` · `confirmed` · `released` |
| university_verifications.status / revoke_reason | `pending` · `verified` · `expired` · `revoked` / `not_student` · `fraud` |
| university_benefit_uses.status | `applied` · `reverted` · `clawback_due` · `clawed_back` |
| academy_exposure_events.kind | `new_card_impression` · `new_card_click` · `participant_list_click` |
| level_promotions.source | `course_completion` · `instructor_offer` |
| level_offers.status | `offered` · `accepted` · `declined` · `superseded` |
| **detail_genre**(세부 장르) | `cha_cha_cha` · `samba` · `rumba` · `paso_doble` · `jive` · `waltz` · `tango` · `viennese_waltz` · `slow_foxtrot` · `quickstep` · `argentine_tango` · `swing` · `salsa` · `bachata` — **2026-11-20 통합: `classes` 에 `detail_genre` 칸을 따로 두지 않는다.** 레벨의 세부 장르는 수업 칸에서 계산한다 — `discipline`(댄스스포츠 10종, §8-7)이 있으면 그것, 없으면 `sub_genre`(`salsa`·`bachata`), 그것도 없으면 `genre`(`argentine_tango`·`swing`). 순수 함수 `levelGenreOf(class)` 하나(§14-1). 초안의 `lindy_hop` 은 §3 `genre` 값 `swing` 으로 맞췄다(FR-169e 카드 표기·D11 종목명 「왈츠」「슬로우폭스트롯」). 화면 표기는 한글, 카드 안은 영어 |
| event_hosts.host_kind / status | `academy` · `individual` · `club` / `pending` · `approved` · `rejected` · `suspended` |
| event_details.booking_mode | `platform` · `external` |
| competition_options.option_kind | `discipline` · `division` |
| notifications.kind(추가) | `membership_renewal_notice` · `membership_manual_pay_notice` · `membership_trial_ending` · `membership_renewed` · `membership_charge_failed` · `membership_ended` · `membership_billing_method_changed` · `membership_cancel_requested` · `coupon_issued` · `coupon_expiring` · `university_verified` · `university_benefit_revoked` · `level_up` · `level_offer` · `event_opened` · `event_changed` · `event_host_approved` · `event_host_rejected` |
| settlement_entries.kind(추가, M5 와 조율) | `coupon_burden` |
| audit_logs.action(추가) | `membership.billing_method_changed` · `membership.cancel_requested` · `membership.cancel_undone` · `membership.plan_changed` · `academy.coupon_participation_changed` · `coupon.restored` · `university_verification.revoked` · `level.evaluation_set` · `level.offer_sent` · `candidate.list_viewed` · `candidate.contact_viewed` · `event_host.approved` · `event_host.rejected` · `candidate.contact_consent_changed`(회원이 개강 후보 연락처 동의를 바꿈 — 추천안·사후 확인 2026-11-24, S6-3.5) |
| uploaded_files.purpose | 새 값 없음 — 행사 포스터도 §8 의 `poster` 를 쓴다(2026-11-20 통합) |

알림의 거래·서비스·광고성 구분(끌 수 있는지)은 M7 이 정한다. 이 절의 제안: 멤버십 청구·고지·결제 수단 변경은 **거래**, 쿠폰 소멸·행사 관심·레벨업은 **서비스**, 광고성 없음.

### 11-10. 왜 이렇게 나눴나

- **멤버십 결제를 `orders` 에 넣지 않았다** — `orders` 는 `offering_id` 필수·학원 정산 대상이다. 멤버십은 플랫폼 수입이라(FR-112b) 모양이 다르다. 대신 청구 시도 테이블이 같은 방어선(기간당 성공 1건 부분 UNIQUE)을 갖는다
- **체험을 행으로 두었다** — 플랜의 상태 기계가 `체험 → 활성` 이라, 체험도 같은 행의 상태(`trial`)로 읽는 쪽이 「지금 멤버십 상태」 조회를 하나로 만든다. 체험 1인 1회는 상태가 아니라 `trial_grants`(CI 유니크)가 막는다 — 탈퇴·재가입에서도 남아야 해서 분리했다
- **쿠폰 잠금을 상태 + 조건부 갱신으로 했다** — 「결제 대기 중에도 같은 쿠폰이 두 결제에 잡히지 않게」(FR-121)는 `UPDATE … WHERE status='available'` 한 문장이 가장 단순하고 동시성에 강하다
- **1+1 추가 수업을 별도 0원 주문으로 했다** — 주문 모양(수업 하나·금액식)을 바꾸지 않고, 환불·정산·캘린더가 수업마다 기존 경로를 그대로 탄다
- **레벨 판정 기록(`course_completions`)을 따로 뒀다** — 작업 멱등, 강사 「지난 수업」 이력, 출석 판정 근거를 한 행이 맡는다. 횟수는 서버 안 전용이라 D7 의 「화면에 숫자 없음」을 데이터 계층에서 지킨다

### 11-11. 열린 점(데이터) — 근거가 없는 칸·규칙. 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)은 추천값

| # | 무엇 | 추천 |
|---|---|---|
| ① | 요금표를 바꾸는 경로 — spec 은 「운영자가 바꿀 수 있게 설정」(FR-112)이라고만 한다. FR-301 은 콘솔을 조회 전용으로 두고 예외 4개에 요금이 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 회차는 시드 + 운영자 스크립트. 콘솔 편집 화면은 예외 목록에 FR-301 을 고친 뒤 |
| ② | 체험 중에 결제하면 남은 체험 기간 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 결제하는 순간 체험은 끝나고 결제 기간이 시작한다(남은 체험은 버림). 쿠폰은 그 결제부터 받는다 |
| ③ | 멤버십 청구의 웹훅 분기 · 결제수단 값 이름 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `gateway_payment_id` 접두어 `mbr_` 로 분기, 값 이름은 M3 의 `payments.method` 를 따른다 — **M3 와 조율** |
| ④ | 「1달치 가격」의 출처 — `class_offerings.price_amount` 는 판매 단위 전체 가격이다. 대학생 50%(FR-118)·1+1 무료 1달치(FR-121)가 이 값을 쓴다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `class_offerings.monthly_price_amount int NULL` 칸을 M2 가 등록 때 받는다. 없으면 `ceil(price_amount ÷ 개월 수)` — **M2 와 조율** |
| ⑤ | 동반자 첫 회차 자리를 `seat_pools`(판매 단위 단위)로 못 센다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) §11-3 대로 앱이 `FOR UPDATE` 검사. 회차별 정원 칸이 필요해지면 M3·M4 와 같이 |
| ⑥ | 인증 메일 발송 수단(무료 구간 확인 필요) | 포트 `MailSenderPort` 를 두고 가짜로 시작. 실 수단은 무료 한도를 확인한 뒤 사용자 확인 |
| ⑦ | 허위 인증 판명 뒤 정상가 재청구를 실제로 실행하는 경로 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 회차는 `clawback_due` 기록까지만. 실행은 M5 정산 상계(FR-253)와 같이 |
| ⑧ | 신규 참여 학원 카드(FR-121e)·참여학원 목록(보드 C32B)·실시간 인기 수업(보드 C32A) 화면과 노출 기록 쓰기를 맡는 Task — 로드맵에 없다(`S6-2.9` 번호가 비어 있다) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `S6-2.9` 로 새 Task 를 만든다. 그 전엔 리포트 칸을 `available: false` |
| ⑨ | 경험 수준 6구간 → 레벨 숫자 매핑 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 0·2·4·6·8·10 |
| ⑩ | 휴강·폐강 회차를 출석률 분모에서 빼는가 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 뺀다(수업이 없었으므로). M4 의 회차 상태 값과 **조율** |
| ⑪ | 개강 후보 연락처 제공 동의를 받는 화면 — 보드에 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 마이(M12)에 「새 반 안내에 연락처 제공」 줄 하나. 기본값은 동의 안 함 |
| ⑫ | 개인·동호회 주최자의 신청서·심사 기준·제출 서류·정산 계좌 연결(FR-155 ⚠) | 결정 대기. 그 전에는 신청 API 가 이름·유형·연락 사유 글만 받고 승인은 운영자 수동 |
| ⑬ | 외부 예매 = 공연만이라는 규칙의 DB 보장 | 등록 API 검사 + 테스트(두 테이블에 걸친 CHECK 불가) |
| ⑭ | 대회 참가비 합계 계산이 03 의 가격 계산에 들어가는 방식 | **M3 와 조율** — 주문 생성이 `competitionEntry` 가 있으면 종목 합계를 정가로 쓴다 |

---

## 12. M7(운영) — 8판 추가 (2026-11-20)

- 작성 2026-11-20 · 짝: `_workspace/03_contracts/15-ops.md` · 범위: S7-1(알림 발송·설정·푸시) · S7-2(문의·신고·이용 제한) · S7-3(약관 판본·탈퇴·보존·자녀) · S7-4(점검·앱 버전·설정·공휴일 칸·예금주 확인 칸)
- §0 공통 규칙(uuid PK · text+CHECK · Timestamptz · 금액 Int · 신규 FK Restrict) · §7 규칙(감사 ○ 표시·민감 칸 암호화·판정은 매 요청 DB) 그대로. **기존 §2·§7 엔티티는 다시 정의하지 않고 「칸 추가」로만 적는다**
- 다른 마일스톤과 겹치는 것: `member_consents`(S3-1 정의) · `holidays`·정산 원장·강사 계좌·대사 결과(M5) · `orders` 칸(M3) · 환불 요청(S4-1) · `uploaded_files`(§7-3)·`notifications`·`audit_logs`(§7-7)는 참조·칸 추가만

### 12-1. 엔티티 목록

| # | 테이블 | 구분 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 119 | `notification_settings` | 신규 | 회원 알림 설정(수업 전 시점·쿠폰·대기). 광고성 동의는 `member_consents` | S7-1 |
| 120 | `staff_notification_settings` | 신규 | 직원 휴대폰 푸시 주제별 켜고 끄기(O34) | S7-1 |
| 121 | `push_tokens` | 신규 | 기기 푸시 토큰과 권한 상태 | S7-1 |
| 122 | `inquiries` | 신규 | 문의(받는 곳·종류·상태·응답 기한) | S7-2 |
| 123 | `inquiry_messages` | 신규(추가 전용) | 문의 대화 | S7-2 |
| 124 | `reports` | 신규 | 신고(대상·사유·진행 상태) | S7-2 |
| 125 | `restriction_cases` | 신규 | 이용 제한 절차(사유 통지 → 소명 → 조치) | S7-2 · S7-4 |
| 126 | `restriction_explanations` | 신규(추가 전용) | 소명 글 | S7-2 · S7-4 |
| 127 | `attachment_links` | 신규 | 문의·신고·소명에 붙은 파일 | S7-2 |
| 128 | `account_withdrawals` | 신규 | 회원·강사 탈퇴 요청과 진행 | S7-3 |
| 129 | `withdrawn_identities` | 신규 | 탈퇴한 사람의 본인확인 해시와 사용한 한 번뿐인 혜택(재가입 혜택 차단) | S7-3 |
| 130 | `data_requests` | 신규 | 개인정보 처리정지·삭제 요청 | S7-3 |
| 131 | `data_retention_items` | 신규 | 보존 기한이 걸린 기록(5년·3년·3개월)과 삭제 사실 | S7-3 |
| 132 | `guardian_children` | 신규 | 보호자 계정의 자녀(만 19세 미만) | S7-3 |
| 133 | `maintenance_windows` | 신규 | 점검·PG 장애로 결제를 막은 구간 | S7-4 |
| 134 | `app_version_policies` | 신규 | 앱 최소·최신 버전 | S7-4 |
| 135 | `ops_settings` | 신규 | 운영 설정값(기한·간격·경보 기준) | S7-1~4 |
| (90) | `holiday_sync_runs` | §10-13 으로 옮김 | 공휴일 자동 수집 결과(P9 상단 띠) — 정의는 §10-13 한 곳 | S0-4.10 |
| — | 칸 추가 | `notifications` · `terms_versions` · `members` · `platform_fee_rates` · `academy_restrictions` | 12-3 | |

신규 17개(`holiday_sync_runs` 는 §10-13). 규모 목표(1~10명 → 최대 10만 명)에서 `notifications`·`audit_logs` 외에는 작은 표다.

### 12-2. `notifications` 칸 추가 (§2-2·§7-7 위에 더한다)

- 더하는 칸: `class text`(`transactional`·`service`·`marketing`) · `deliver_after timestamptz NULL`(밤 지연 — 광고성만 채운다) · `attempt_count int = 0` · `next_attempt_at timestamptz NULL` · `last_attempt_at timestamptz NULL` · `delivery_error_code text NULL` · `delivered_at timestamptz NULL` · `push_suppressed_reason text NULL`(`no_permission`·`not_agreed`·`instructor_regular_signup`·`setting_off`)
- `class` 는 만드는 쪽이 `kind` 마다 정해 쓴다. 제약: **`ck_notifications_class`**: `class IN ('transactional','service','marketing')` · NOT NULL(기존 행은 마이그레이션이 `kind` 표로 채운다 — 값 대응은 아래 §12-9) · `ck_notifications_marketing_member`: `class='marketing'` 이면 `recipient_member_id IS NOT NULL`(대표·강사 앱에는 광고성이 없다 — O34) · `ck_notifications_attempts`: `attempt_count >= 0`
- 인덱스: `ix_notifications_dispatch (delivery_status, deliver_after) WHERE delivery_status IN ('pending','retry_wait')` · `ix_notifications_retry (next_attempt_at) WHERE delivery_status='retry_wait'`
- `delivery_status` 값 집합 확장: `pending` · `sending` · `retry_wait` · `sent` · `skipped` · `failed` (§3 은 `pending`·`sent`·`skipped` 셋). 전이는 12-5
- S7-1.6(발송 재시도 작업) 적용분(추천안·사후 확인 2026-11-24): 마이그레이션 `20261124T0627_notification_delivery_retry` 가 상태 6값 · `attempt_count` · `next_attempt_at` · `last_attempt_at` · `delivery_error_code` · `delivered_at` · `ck_notifications_attempts` · `ix_notifications_retry` 를 더했다. `class` · `deliver_after` · `push_suppressed_reason` · `ix_notifications_dispatch` 는 아직 없다(dispatch 를 만드는 Task 몫). 선점한 채 10분 넘은 `sending` 은 retry 작업이 실패 1번(`sending_timeout`)으로 센다

### 12-3. 기존 테이블 칸 추가

| 테이블 | 더하는 칸 · 제약 | 이유 |
|---|---|---|
| `terms_versions`(§7-4) | `audience text = 'merchant'`(`merchant`·`member`) · `is_unfavorable boolean = false` · `change_summary jsonb NULL`(`[{article, text}]`, C10A 「바뀐 내용」) · `notice_sent_at timestamptz NULL`. 제약: **`ck_terms_member_notice`**: 같은 `kind` 의 이전 판본이 있을 때의 `effective_at − published_at ≥ 7일`(`is_unfavorable` 이면 30일)은 행 사이 비교라 CHECK 로 못 건다 → 발행 API 가 검사하고 테스트로 고정(§7-4 와 같은 처리) | 회원 약관은 불리한 변경 30일·그 밖 7일(약관 제3조 ②). 입점 약관은 07 이 모두 30일로 이미 정했다(`audience='merchant'`) |
| `members`(§2-2) | `status text = 'active'`(`active`·`suspended`·`withdrawn_pending`·`withdrawn`) · `processing_stopped_at timestamptz NULL` · `withdrawn_at timestamptz NULL`. 제약 `ck_members_status` | 탈퇴·이용 정지·처리정지(S7-3). 이름·연락처 등 개인 칸은 `withdrawn` 이 되면 앱이 비운다(NOT NULL 이면 NULL 허용으로 바꾸는 마이그레이션 필요 — 열린 점 ⑥) |
| (통합) `academy_payout_accounts`(§7-3) · `holidays` | 이 절에서 더하지 않는다 — 계좌 확인 칸은 §10-5(`verification_status` 4종), 공휴일 표는 §10-13 에 합쳤다(2026-11-20 통합. 초안의 `holder_status`·`holder_reject_*` 는 버림) | P10·P9 |
| `platform_fee_rates`(§7-8b) | `terms_version_id uuid NULL → terms_versions`(바꿈 통지에 쓴 `platform_fee_notice` 판본) · `change_note text NULL`. 제약 없음 | P8 새 수수료율 저장이 판본·개별 통지(FR-316·FR-259)와 묶인다 |
| `academy_restrictions`(§7-3b) | `source_case_id uuid NULL → restriction_cases` | 사업자 점검·신고에서 연 제한과 절차를 잇는다. 7-3b 의 `source_check_id` 와 함께 쓴다 |

### 12-4. 신규 테이블 — 칸·제약

#### 알림 설정·푸시 (S7-1)

**`notification_settings`** — 감사 ×(회원 본인 설정)
- 칸: `member_id uuid PK → members` · `pre_class_lead text = 'one_hour'`(`day_before`·`two_hours`·`one_hour`·`thirty_min`) · `coupon_expiry_notice boolean = true` · `waitlist_notice boolean = true` · `updated_at`
- 제약: `ck_notification_settings_lead`. 광고성 동의는 이 표에 두지 않는다 — `member_consents`(S3-1, 항목 `marketing`)의 마지막 줄이 권위다(동의·철회 시각이 쌓인다, FR-249). 회원 가입 때 기본 행을 만든다(없으면 읽을 때 기본값)

**`staff_notification_settings`**
- 칸: `staff_account_id → staff_accounts` · `topic text` · `phone_enabled boolean = true` · `updated_at`. PK `(staff_account_id, topic)`
- 제약: `ck_staff_notif_topic`: `class_approval`·`event_capacity`·`inquiry`·`schedule_room`·`platform_notice`(끌 수 있는 5개) 만 — 끌 수 없는 `refund_request`·`payment_failure`·`payout_approval` 은 **행을 만들지 않는다**(항상 켜짐을 코드 상수로, O34)

**`push_tokens`**
- 칸: `id` · `member_id uuid NULL → members` · `staff_account_id uuid NULL → staff_accounts` · `platform text = 'android'` · `token text` · `device_id text` · `permission_state text`(`granted`·`denied`·`unknown`) · `last_seen_at` · `revoked_at NULL` · `created_at`
- 제약: `ck_push_tokens_one_owner`: `num_nonnulls(member_id, staff_account_id) = 1` · **`uq_push_tokens_token (token) WHERE revoked_at IS NULL`**(같은 기기에서 다른 계정으로 로그인하면 옛 행을 `revoked_at` 으로 닫고 새 행) · `ck_push_tokens_platform`(베타는 `android`) · `ix_push_tokens_member (member_id) WHERE revoked_at IS NULL` · `ix_push_tokens_staff (staff_account_id) WHERE revoked_at IS NULL`
- 더한 제약(추천안·사후 확인 2026-11-24, S7-1.2): `ck_push_tokens_not_blank`(`char_length(token) > 0 AND char_length(device_id) > 0`) · `ck_push_tokens_revoked_after_created`(`revoked_at IS NULL OR revoked_at >= created_at`). `last_seen_at`·`created_at` 기본값 now()
- 토큰 값은 비밀은 아니지만 계정과 묶여 있어 응답·로그에 내리지 않는다(앞 6자만 로그)

#### 문의 (S7-2)

**`inquiries`** — 감사 ×(이 표와 `inquiry_messages` 자체가 기록)
- 칸: `id` · `kind text`(`academy`·`system`) · `asker_kind text`(`member`·`instructor`·`owner`) · `asker_member_id NULL → members` · `asker_staff_account_id NULL → staff_accounts` · `academy_id NULL → academies` · `category text`(12-9) · `reservation_id NULL → reservations` · `offering_id NULL → class_offerings` · `refund_request_id uuid NULL`(S4-1 의 환불 요청, FK 는 그 표가 생긴 뒤 추가) · `related_settlement_ref uuid NULL`(M5 정산 줄, FK 없음) · `route text = 'human'`(`human`·`ai_handoff`) · `ai_conversation_id text NULL` · `status text = 'answer_waiting'`(`answer_waiting`·`answered`·`closed` + MX 가 쓰는 `ai_answered`) · `first_response_due_at timestamptz` · `overdue_reminded_at NULL` · `last_message_at` · `closed_at NULL` · `created_at`
- 제약: **`ck_inquiries_asker`**: `asker_kind='member'` ↔ `asker_member_id IS NOT NULL`, 그 밖 ↔ `asker_staff_account_id IS NOT NULL`(번호 하나만) · **`ck_inquiries_target`**: `kind='academy'` ↔ `academy_id IS NOT NULL` · `ck_inquiries_category`(12-9 전체 값) + 앱이 (askerKind, kind, category) 짝을 검사 · `ck_inquiries_reservation_member`: `reservation_id` 는 `asker_kind='member'` 일 때만 · **`uq_inquiries_idempotency (asker_member_id, asker_staff_account_id, idempotency_key)`** 용 칸 `idempotency_key varchar(200)` 추가(`NULLS NOT DISTINCT`가 필요 — 회원·직원 둘 중 하나가 NULL 이라 두 부분 UNIQUE 로 나눈다: `uq_inquiries_idem_member (asker_member_id, idempotency_key) WHERE asker_member_id IS NOT NULL` · `uq_inquiries_idem_staff (asker_staff_account_id, idempotency_key) WHERE asker_staff_account_id IS NOT NULL`) · `ix_inquiries_academy_status (academy_id, status, created_at DESC) WHERE academy_id IS NOT NULL` · `ix_inquiries_asker_member (asker_member_id, created_at DESC)` · `ix_inquiries_asker_staff (asker_staff_account_id, created_at DESC)` · `ix_inquiries_overdue (first_response_due_at) WHERE status='answer_waiting' AND overdue_reminded_at IS NULL`(재알림 작업 전용)
- 조회 권한은 요청마다 읽는다 — 대표는 `academy_owners(active)` 학원의 `kind='academy'` 만, 운영자는 `kind='system'` 만(SC-029b·FR-204)
- 보존: 소비자 불만·분쟁 처리 기록으로 3년(`data_retention_items`)
- 더한 제약·바꾼 모양(추천안·사후 확인 2026-11-24, S7-2.1): `ck_inquiries_closed`(`(status='closed') = (closed_at IS NOT NULL)`) · `ck_inquiries_idempotency_key`(빈 열쇠 거부) · `idempotency_key` NOT NULL · `last_message_at`·`created_at` 기본값 now(). `ix_inquiries_*` 의 `created_at DESC` 는 계약 문법에 정렬 방향이 없어 오름차순으로 뒀다(btree 역방향 읽기). `refund_request_id` 는 FK 없이 두고 S7-2.4 가 잇는다

**`inquiry_messages`** — 추가 전용(수정·삭제 트리거로 거부, §7-7 `audit_logs` 와 같은 방식)
- 칸: `id` · `inquiry_id → inquiries` · `sender_kind text`(`asker`·`academy_owner`·`operator`·`ai`) · `sender_member_id NULL` · `sender_staff_account_id NULL` · `body text` · `created_at`
- 제약: `ck_inquiry_messages_sender`: `asker` 는 둘 중 하나(문의자 종류와 맞는 쪽), `academy_owner`·`operator` 는 `sender_staff_account_id` 필수, `ai` 는 둘 다 NULL · `char_length(body) BETWEEN 1 AND 2000`임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) · `ix_inquiry_messages_inquiry (inquiry_id, created_at)`
- 더한 칸(추천안·사후 확인 2026-11-24, S7-2.3): `idempotency_key varchar(200) NULL` — 답변 경로의 `Idempotency-Key`. 첫 글은 `inquiries.idempotency_key` 가 맡아 NULL. `uq_inquiry_messages_idem (inquiry_id, idempotency_key) WHERE idempotency_key IS NOT NULL` · `ck_inquiry_messages_idempotency_key`(빈 열쇠 거부). 마이그레이션 `20261124T0713_inquiry_message_idempotency`. 알림 kind `inquiry_received`·`inquiry_answered`·`inquiry_overdue` 는 `20261124T0712_inquiry_notifications`
- 추가 전용 트리거(추천안·사후 확인 2026-11-24, S7-2.1): `trg_inquiry_messages_append_only` 가 UPDATE·DELETE 만 막는다. TRUNCATE 는 막지 않는다 — 공용 테스트 도우미 `truncateAll` 이 TRUNCATE 를 쓰는데 그 파일은 S0-M1 소유다(audit_logs 만 예외 처리돼 있다)

#### 신고·이용 제한 (S7-2 · S7-4)

**`reports`** — 감사 ○(처리 결과)
- 칸: `id` · `reporter_kind text`(`member`·`instructor`·`owner`) · `reporter_member_id NULL` · `reporter_staff_account_id NULL` · `target_kind text`(`academy`·`instructor`·`class`·`member`) · `target_id uuid` · `reason_code text` · `detail text NULL` · `status text = 'received'`(`received`·`in_review`·`resolved`) · `outcome text NULL`(`dismissed`·`upheld`) · `outcome_note text NULL` · `resolved_by_account_id NULL → staff_accounts` · `restriction_case_id NULL → restriction_cases` · `idempotency_key varchar(200)` · `received_at` · `reviewed_at NULL` · `resolved_at NULL`
- 제약: `ck_reports_reporter`(회원/직원 짝) · `ck_reports_reason`(12-9) · `ck_reports_resolved`: `status='resolved'` ↔ `outcome IS NOT NULL AND resolved_at IS NOT NULL` · **`uq_reports_open (reporter_member_id, reporter_staff_account_id, target_kind, target_id, reason_code) WHERE status <> 'resolved'`**(`NULLS NOT DISTINCT` — Postgres 15+, 이 프로젝트는 PG 18) · `uq_reports_idem_member (reporter_member_id, idempotency_key) WHERE reporter_member_id IS NOT NULL` · `uq_reports_idem_staff (reporter_staff_account_id, idempotency_key) WHERE reporter_staff_account_id IS NOT NULL` · `ix_reports_status (status, received_at)`
- 상대에게 신고자 정보를 내리지 않는다(앱 규칙, 테스트로 고정). 처리 뒤 보존 3년
- 바꾼 모양(추천안·사후 확인 2026-11-24, S7-2.1): `uq_reports_open` 의 `NULLS NOT DISTINCT` 한 개 대신 같은 뜻의 부분 UNIQUE 둘(`uq_reports_open_member`·`uq_reports_open_staff`, 문의 열쇠와 같은 방식 — 계약 문법으로 표현된다). `ck_reports_resolved` 는 「처리 전이면 결과·처리 시각 둘 다 NULL」까지 넣었다. `ck_reports_idempotency_key`(빈 열쇠 거부). `restriction_case_id` 는 FK 없이 두고 S7-2.6 이 표를 만들 때 붙인다

**`restriction_cases`** — 감사 ○
- 칸: `id` · `subject_kind text`(`member`·`instructor`·`academy`) · `subject_member_id NULL → members` · `subject_staff_account_id NULL → staff_accounts` · `subject_academy_id NULL → academies` · `source text`(`report`·`business_status`·`operator_manual`) · `source_report_id NULL → reports` · `source_check_id NULL → business_status_checks` · `reason_code text` · `reason_text text` · `planned_measure text NULL` · `measure text NULL`(`warning`·`feature_limit`·`listing_limit`·`payout_hold`·`suspension`·`termination`) · `state text`(`notice_sent`·`explained`·`measure_applied`·`lifted`·`dismissed`) · `urgent boolean = false` · `notice_sent_at timestamptz` · `explanation_due_at timestamptz NULL` · `measure_applied_at NULL` · `lifted_at NULL` · `opened_by_account_id NULL → staff_accounts`(자동 점검이 연 것은 NULL) · `closed_by_account_id NULL` · `created_at` · `updated_at`
- 제약: **`ck_restriction_subject`**: `subject_kind` 와 대상 칸이 짝(회원=`subject_member_id`, 강사=`subject_staff_account_id`, 학원=`subject_academy_id`, 나머지 NULL) · `ck_restriction_state_measure`: `state IN ('measure_applied','lifted')` 이면 `measure IS NOT NULL`(`lifted` 가 조치 없는 기각이 아니라면) · **`uq_restriction_open (subject_kind, subject_member_id, subject_staff_account_id, subject_academy_id, source) WHERE state IN ('notice_sent','explained','measure_applied')`**(`NULLS NOT DISTINCT` — 같은 대상·같은 출처로 열린 절차 하나) · `ix_restriction_state (state, explanation_due_at)` · `ix_restriction_subject_academy (subject_academy_id)`
- 전이는 12-5. 이용이 정지돼도 회원의 기존 결제 환불 청구권은 막지 않는다 — 환불 경로는 이 표를 읽지 않는다(테스트로 고정)
- 바꾼 모양(추천안·사후 확인 2026-11-24, S7-2.6): `uq_restriction_open` 의 `NULLS NOT DISTINCT` 한 개 대신 대상 종류별 부분 UNIQUE 셋(`uq_restriction_open_member`·`_staff`·`_academy`, 신고 표와 같은 방식) · 운영자 직접 열기의 재생용 `idempotency_key varchar(200) NULL` + `uq_restriction_idem (opened_by_account_id, idempotency_key)` · `ck_restriction_state_measure` 는 `measure_applied` 일 때만 `measure`·`measure_applied_at` 필수(lifted 는 조치 없는 해제가 있어 묻지 않는다) · `ck_restriction_reason`(사유 코드·글 비움 금지) · `reason_code` 값은 신고 사유 5종 + `business_closed`·`business_suspended`·`terms_violation`(앱 코드에서 검사) · 마이그레이션 `20261124T0905_restriction_cases` 가 이 표와 `academy_restrictions.source_case_id`·`reports.restriction_case_id` FK 를 만들었다. `restriction_explanations` 는 소명 경로를 만드는 Task 로 미뤘다

**`restriction_explanations`** — 추가 전용
- 칸: `id` · `case_id → restriction_cases` · `submitted_by_member_id NULL` · `submitted_by_staff_account_id NULL` · `body text` · `created_at`
- 제약: `ck_explanation_submitter`: 둘 중 하나 · `ix_explanations_case (case_id, created_at)`
- 만든 때(추천안·사후 확인 2026-11-24, S1-1.29): 마이그레이션 `20261124T1253_restriction_explanations` 가 이 표와 `notifications.kind` 의 `listing_suspended`·`business_restriction_lifted` 를 넣었다. 소명 경로보다 먼저 만든 까닭은 P11 `accept-explanation` 의 409 `NO_EXPLANATION` 판정이 이 표를 읽어서다. 칸은 위 그대로이고 `ck_explanation_body`(빈 글 금지)를 더했다. 추가 전용 트리거와 첨부 연결은 소명 제출 경로를 만드는 Task 가 붙인다

**`attachment_links`** — 문의·신고·소명에 붙은 파일
- 칸: `id` · `owner_kind text`(`inquiry_message`·`report`·`restriction_explanation`) · `owner_id uuid` · `file_id uuid → uploaded_files` · `position int` · `created_at`
- 제약: **`uq_attachment_file (file_id)`**(한 파일은 한 곳에만) · `uq_attachment_position (owner_kind, owner_id, position)` · `ck_attachment_owner_kind` · `ix_attachment_owner (owner_kind, owner_id)` · `ck_attachment_position`(position ≥ 0, 추천안·사후 확인 2026-11-24 S7-2.7).
- `uploaded_files` 칸 추가(S7-2.7, 추천안·사후 확인 2026-11-24): `uploader_member_id → members NULL`, `uploader_account_id` 는 NULL 허용으로 바꿈. `ck_files_uploader`: `num_nonnulls(uploader_account_id, uploader_member_id) = 1` · `ck_files_member_purpose`: 회원이 올린 파일은 첨부 목적 셋만 · `ck_files_evidence_private` 를 첨부 목적 셋까지 넓힘. 왜: 문의·신고는 회원도 보내는데 07 의 `uploaded_files` 는 직원만 올린다고 정해져 있었다 — 다른 후보(회원용 파일 표를 따로 두기)는 저장 포트·정리 작업·내려받기 판정이 둘로 갈라져 고르지 않았다.
- 파일 `purpose`·`visibility='private'` 는 07 의 `uploaded_files` 가 갖는다. 접근 판정은 `GET /api/files/{fileId}` 에 owner_kind 별 규칙(당사자와 받는 쪽만, 신고 첨부는 신고자와 운영자만)을 더해 한 함수로 한다
- 올린 뒤 24시간 안에 연결되지 않은 파일은 §6-8 의 「주인 없는 파일 정리」가 지운다(새로 만들 작업 없음)

#### 탈퇴·보존·자녀 (S7-3)

**`account_withdrawals`** — 감사 ○
- 칸: `id` · `account_kind text`(`member`·`staff`) · `member_id NULL → members` · `staff_account_id NULL → staff_accounts` · `status text = 'requested'`(`requested`·`awaiting_refunds`·`completed`·`cancelled`) · `ack_coupons boolean` · `ack_membership boolean` · `ack_one_time_benefits boolean` · `preview_snapshot jsonb`(요청 시점 미리보기 — 어떤 일이 어떻게 처리됐는지 분쟁 때 쓴다) · `auto_cancelled_order_ids uuid[]` · `idempotency_key varchar(200)` · `requested_at` · `completed_at NULL`
- 제약: `ck_withdrawals_account`(회원/직원 짝) · **`uq_withdrawals_active_member (member_id) WHERE status IN ('requested','awaiting_refunds')`** · `uq_withdrawals_active_staff (staff_account_id) WHERE status IN ('requested','awaiting_refunds')` · `uq_withdrawals_idem (account_kind, member_id, staff_account_id, idempotency_key)`(`NULLS NOT DISTINCT`) · `ck_withdrawals_completed`: `completed` ↔ `completed_at IS NOT NULL`
- 완료(익명화)는 같은 트랜잭션에서 `members` 의 이름·연락처·생년월일·`identity_ci_hash`·`auth_user_id`·학교 인증 정보를 비우고, **취향(`member_interest_genres` 행 삭제)과 환불 계좌(`refund_accounts` 의 `account_number_enc`·`account_masked`·`holder_name` 비움, 2026-11-20 사용자 결정 D18 — 법률 검토 대상)**도 비운다(결제·예약·환불 행은 `member_id` 로 남는다 — FK 가 남은 채 사람을 가리킬 수 없는 상태가 되는 것이 「익명화」다)

**`withdrawn_identities`**
- 칸: `ci_hash text PK` · `withdrawn_at` · `used_benefits text[]`(`university_first_payment_50`·`member_trial_3m`·`instructor_trial_1y` — 12-9) · `last_member_id uuid → members`(익명화된 행) · `retain_until timestamptz`
- 뜻: 재가입 혜택 차단(FR-010)과 강사 1년 체험 CI 당 1회(FR-112e)를 지키려는 최소 정보. **원문 CI 는 저장하지 않는다**(해시만, §2-2 `identity_ci_hash`). 보존 기한은 `ops_settings`(추천 3년, 열린 점 ⑥)

**`data_requests`** — 감사 ○
- 칸: `id` · `member_id → members` · `kind text`(`processing_stop`·`deletion`) · `status text = 'received'`(`received`·`in_progress`·`done`·`rejected`) · `note text NULL` · `due_at timestamptz` · `result_note text NULL` · `resolved_by_account_id NULL` · `resolved_at NULL` · `withdrawal_id NULL → account_withdrawals` · `idempotency_key varchar(200)` · `created_at`
- 제약: **`uq_data_requests_open (member_id, kind) WHERE status IN ('received','in_progress')`** · `uq_data_requests_idem (member_id, idempotency_key)` · `ck_data_requests_resolved`: `done`·`rejected` ↔ `resolved_at IS NOT NULL` · `ix_data_requests_due (status, due_at)`

**`data_retention_items`**
- 칸: `id` · `kind text`(`transaction_record`(계약·청약철회·대금 결제 5년) · `dispute_record`(소비자 불만·분쟁 처리 3년) · `access_log`(접속 기록 3개월)) · `source_table text` · `source_id uuid` · `subject_member_id NULL` · `retain_until timestamptz` · `purged_at timestamptz NULL` · `created_at`
- 제약: `ck_retention_kind` · `uq_retention_source (source_table, source_id, kind)` · `ix_retention_due (retain_until) WHERE purged_at IS NULL`. 기한 값은 `ops_settings`(`retention.transaction_record_months=60`·`dispute_record_months=36`·`access_log_months=3`, O-16)
- 지운 줄은 `purged_at` 만 채우고 남긴다(삭제 사실의 기록). 결제 기록 본문은 원래 표(`payments`·`refunds`)에 남아 있고 **기한이 지나면 작업이 그 행을 지우고 연결된 `order_events`·`audit_logs`(회원 관련 가린 값)는 정책에 따라 정리**한다 — 어떤 표를 어떻게 지울지의 목록은 S7-3.4 가 정한다(열린 점 ⑥)

**`guardian_children`** — 감사 ○
- 칸: `id` · `guardian_member_id → members` · `name text` · `gender text`(§3 `male`·`female`) · `birth_date date` · `guardian_consent_at timestamptz` · `consent_terms_version_id → terms_versions` · `status text = 'active'`(`active`·`removed`) · `adult_on date`(= `birth_date + 19년`, 앱이 계산해 저장 — 생성 칸(`GENERATED`)은 윤일 경계가 헷갈려 쓰지 않는다) · `adult_flagged_at NULL` · `removed_at NULL` · `idempotency_key varchar(200)` · `created_at`
- 제약: `ck_children_under_19`: `birth_date > (created_at AT TIME ZONE 'Asia/Seoul')::date - INTERVAL '19 years'`(등록 시점 만 19세 미만 — 날짜 비교라 DB 에서도 막는다. 경계는 생일 당일 만 19세) · **`uq_children_guardian_identity (guardian_member_id, name, birth_date) WHERE status='active'`** · `uq_children_idem (guardian_member_id, idempotency_key)` · `ck_children_removed`: `removed` ↔ `removed_at IS NOT NULL` · `ix_children_guardian (guardian_member_id) WHERE status='active'` · `ix_children_adult (adult_on) WHERE adult_flagged_at IS NULL AND status='active'`
- `removed` 가 되면 `name`·`birth_date` 를 비운다(NOT NULL 이라 `'(삭제됨)'`·`'1900-01-01'` 같은 자리 값으로 덮는 방법은 쓰지 않는다 — 두 칸을 NULL 허용으로 바꾸고 `ck_children_removed` 가 `active` 일 때만 NOT NULL 을 강제 — 열린 점 ⑧)
- 자녀는 로그인하지 않는다 — 계정 표가 아니다. 주문의 수강 대상 칸(`orders.attendee_child_id`)은 M3 가 추가한다

#### 운영 설정 (S7-4)

**`maintenance_windows`** — 감사 ○
- 칸: `id` · `kind text`(`maintenance`·`pg_outage`) · `status text = 'scheduled'`(`scheduled`·`active`·`ended`·`cancelled`) · `starts_at` · `ends_at timestamptz NULL`(장애는 끝 시각을 모른다) · `message text` · `notice_at timestamptz NULL`(= `starts_at − 24시간`, 점검만) · `notice_sent_at NULL` · `ended_at NULL` · `extended_seconds int NULL`(끝낼 때 입금 기한에 더한 초) · `extended_order_count int NULL` · `created_by_account_id → staff_accounts` · `idempotency_key varchar(200)` · `created_at`
- 제약: `ck_mw_times`: `ends_at IS NULL OR ends_at > starts_at` · `ck_mw_pg_outage_open`: `kind='pg_outage'` 이면 `status IN ('active','ended')`(예약 없음) · `ck_mw_ended`: `ended` ↔ `ended_at IS NOT NULL AND extended_seconds IS NOT NULL` · **`uq_mw_one_active_per_kind (kind) WHERE status='active'`** · `uq_mw_idem (created_by_account_id, idempotency_key)` · `ix_mw_active (status, starts_at)`
- 활성 판정은 시각으로 한다 — `status IN ('scheduled','active') AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`. 작업(`ops-alerts/scan`)이 `status` 를 시각에 맞춰 바꾼다(읽기 판정은 상태 갱신이 늦어도 맞다)

**`app_version_policies`**
- 칸: `id` · `platform text = 'android'` · `min_supported_version text` · `latest_version text` · `effective_from timestamptz` · `created_by_account_id` · `created_at`
- 제약: `ck_avp_semver`: 두 버전이 `^[0-9]+\.[0-9]+\.[0-9]+$` · `ck_avp_range`는 문자열 비교가 틀리므로(`1.10.0` < `1.9.0`) **앱 검사 + 테스트로 고정**(DB 에서는 `string_to_array` 를 정수 배열로 바꾼 식 `string_to_array(min_supported_version,'.')::int[] <= string_to_array(latest_version,'.')::int[]` 를 CHECK 로 쓸 수 있다 — 쓴다) · **`uq_avp (platform, effective_from)`**

**`ops_settings`** — 감사 ○(바꿀 때)
- 칸: `key text PK` · `value jsonb` · `updated_by_account_id NULL` · `updated_at`
- 시드 키: `notification.quiet_hours`(`{"from":"21:00","to":"08:00"}`) · `notification.retry`(`{"maxAttempts":3,"delaysSeconds":[60,300]}`) · `inquiry.response_business_days`(`1`) · `inquiry.overdue_repeat_business_days`(`null` — 열린 점) · `data_request.due_days`(`10`) · `terms.member_notice_days`(`{"normal":7,"unfavorable":30}`) · `retention.transaction_record_months`(60) · `retention.dispute_record_months`(36) · `retention.access_log_months`(3) · `restriction.explanation_days`(7) · `app.optional_update_remind_days`(7) · `alert.webhook_silence_minutes`(10) · `alert.reconciliation_mismatch_threshold`(1) · `alert.refund_failed_threshold`(1) · `maintenance.notice_hours`(24)
- 제약: `ck_ops_settings_key`: 알려진 키 목록(앱 상수와 단위 테스트 대조 — §4.2 방식). 값 모양은 앱이 zod 로 검사. 설정 바꾸기 UI·경로는 이 슬라이스에 없다(시드 + 마이그레이션 SQL 로만 바꾼다 — 열린 점 ⑨)
- M5 가 같은 이름의 설정 표를 이미 만들었으면 그것을 쓰고 이 표는 만들지 않는다(열린 점 ③)

**`holiday_sync_runs`** — §10-13 으로 옮겼다(2026-11-20 통합).

### 12-5. 상태 전이

| 대상 | 현재 → 다음 | 조건 | 같은 트랜잭션에서 함께 |
|---|---|---|---|
| `notifications.delivery_status` | `pending` → `sending` | 발송 작업이 선점(조건부 갱신, `attempt_count+1`) | — |
| | `sending` → `sent` | 포트 성공 | `delivered_at` |
| | `sending` → `retry_wait` | 포트 실패이고 `attempt_count < 3` | `next_attempt_at`, `delivery_error_code` |
| | `retry_wait` → `sending` → … | `next_attempt_at <= now()` | — |
| | `sending`/`retry_wait` → `failed` | 시도 3번째 실패 | `delivery_error_code`(알림함 행은 그대로) |
| | `pending` → `skipped` | 권한 없음·미동의·설정 끔 | `push_suppressed_reason` |
| | `pending` → `pending` | 광고성이 야간에 걸림 | `deliver_after` 만 08:00 으로 |
| `inquiries.status` | `answer_waiting` → `answered` | 대표·운영자가 답함 | `inquiry_messages` 1행 · 알림 |
| | `answered` → `answer_waiting` | 문의자가 추가 글을 씀 | `first_response_due_at` 새로 계산, `overdue_reminded_at` 비움 |
| | `answered` → `closed` | 문의자가 닫거나 N일 무응답 | `closed_at`(자동 종료 일수는 열린 점 ⑩, 지금은 닫는 경로 없음) |
| | `ai_answered` → `answer_waiting` | 사람 응대 요청(`human-request`) | `route='ai_handoff'` |
| `reports.status` | `received` → `in_review` | 운영자 `start-review` | `reviewed_at` · 신고자 알림 |
| | `in_review` → `resolved` (`received` 에서 곧바로도 가능) | 운영자 `resolve` | `outcome`·`resolved_at` · 신고자 알림 · (`upheld`+조치면) `restriction_cases` 1행 |
| `restriction_cases.state` | (없음) → `notice_sent` | 운영자 열기 / 점검이 휴·폐업 감지 / 신고 처리 | 대상 알림 · `explanation_due_at` |
| | (없음) → `measure_applied` | 긴급(`urgent`) | 조치 효과 즉시 + 알림 |
| | `notice_sent` → `explained` | 대상이 소명 | `restriction_explanations` 1행 |
| | `notice_sent`·`explained` → `measure_applied` | 운영자 `apply` / 게시 중단 | 조치 효과(아래) · 감사 |
| | `notice_sent`·`explained`·`measure_applied` → `lifted` | 운영자 `lift` / 소명 받아들임 | 열린 `academy_restrictions` `ended_at` · 감사 |
| | `notice_sent`·`explained` → `dismissed` | 신고 기각 등 | — |
| 조치 효과 | `listing_limit`·`payout_hold`(학원) | `academy_restrictions` 행 열기(`listing_suspended`·`payout_hold`) | `source_case_id` |
| | `suspension`(회원) | `members.status='suspended'` | 로그인 유지 여부(환불 조회·요청은 막지 않는다 — FR-254) |
| `account_withdrawals.status` | (없음) → `requested` | 탈퇴 요청이고 막힘 없음 | 입금 대기 주문 `cancelled`(사유 `withdrawal`) · 쿠폰 소멸 표시 · `members.status='withdrawn_pending'` |
| | `requested` → `awaiting_refunds` | 처리 중인 환불·분쟁이 있음 | — (없으면 곧바로 `completed`) |
| | `requested`·`awaiting_refunds` → `completed` | 환불 모두 끝남 | 익명화 · `withdrawn_identities` · `data_retention_items` · 자녀 정리 · `members.status='withdrawn'` |
| | `requested` → `cancelled` | (경로 없음 — 열린 점 ⑪) | — |
| `data_requests.status` | `received` → `in_progress` → `done`·`rejected` | 운영자 | 결과 알림 · (`processing_stop`+`done` 이면) `members.processing_stopped_at` |
| `maintenance_windows.status` | `scheduled` → `active` | `starts_at` 도래(작업이 반영) | — |
| | `active` → `ended` | `end` 호출 또는 `ends_at` 경과 | `payments.due_at += 멈춘 시간`(`status='ready'` 만) · `order_events` 사유 행 · 알림 |
| | `scheduled` → `cancelled` | (경로 없음 — 열린 점 ⑫) | — |
| `academy_payout_accounts.verification_status`(§10-5) | `pending` → `verified` · `rejected` | 운영자 확인·반려(13 §10-2) | `holder_verified_at`·`holder_verify_method`·`holder_verified_by_account_id` · 알림 · 감사 |
| | `pending` → `rejected` | 운영자 반려 | 사유 칸 · 알림 · 감사 |
| `guardian_children.status` | `active` → `removed` | 보호자가 지움 / 탈퇴 마무리 | 이름·생년월일 비움 · `removed_at` |

### 12-6. 인덱스·조회 경로 요약

- 발송 작업: `ix_notifications_dispatch`·`ix_notifications_retry`(위 부분 인덱스 — `pending`·`retry_wait` 행만 잡아 표가 커져도 작업이 가볍다)
- 대표 문의함: `ix_inquiries_academy_status` · 회원·직원 내 문의: `ix_inquiries_asker_*`
- 재알림: `ix_inquiries_overdue`
- 감사 기록 조회(S7-4.1): §7-7 의 `ix_audit_academy_time`·`ix_audit_target` 에 **`ix_audit_action_time (action, occurred_at DESC)`** 하나를 더한다(필터 `action` 이 목록 조회의 가장 흔한 조건)
- 콘솔 집계(P1~P7)는 이 절에 새 표가 없고 M5 원장·`orders`·`payments`·`refunds` 를 읽는다. 규모 목표(1~10명)에서는 즉석 집계로 충분하다고 보고 **집계 표를 만들지 않는다**(느려지면 M5 가 검토 — 10 §1 과 같은 판단)

### 12-7. 감사 대상(`audit_logs.action`) 추가 — 7-9 표에 더한다

`terms_version.published`(회원 판본, 기존 값 재사용) · `console.viewed` · `console.exported` · `report.resolved` · `restriction.opened`·`.applied`·`.lifted` · `holiday.created`·`.updated`·`.deleted` · `payout_account.holder_verified`·`.holder_rejected` · `maintenance_window.created`·`.ended` · `app_version_policy.changed` · `ops_setting.changed` · `data_request.resolved` · `member.withdrawal_requested`·`.withdrawn` · `member.account_recovered` · `member.contact_changed` · `child.registered`·`.removed` · `platform_fee_rate.changed`(M1 에 이미 있는 값 재사용)

화면 조회 기록(`console.viewed`)은 `audit_logs.target_id` 가 uuid NOT NULL 이라 화면 이름을 그대로 못 담는다 → **화면별 고정 UUIDv5**(이름공간 + `"console:dashboard"` 같은 문자열)를 `target_id`, `target_table='console_screen'`, 화면 이름·필터는 `after` 에 담는다(열린 점 ⑬ 이전 계약 15 의 ⑬).

### 12-8. 쓰지 않기로 한 것

- 알림 설정 하나로 합친 광고성 동의 칸 — 동의·철회 시각이 쌓여야 해서(FR-249) `member_consents` 가 권위다
- 문의·신고 첨부를 표마다 따로 두는 것 — `attachment_links` 한 표로 둔다
- 콘솔 집계 표 — 규모 목표상 불필요
- 점검 플래그 한 칸(`app_flags.maintenance=true`) — 시작·끝·멈춘 시간이 있어야 입금 기한을 정확히 늘릴 수 있어서 구간 표를 둔다

### 12-9. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| notifications.class | `transactional` · `service` · `marketing` |
| notifications.delivery_status(확장) | `pending` · `sending` · `retry_wait` · `sent` · `skipped` · `failed` |
| notifications.push_suppressed_reason | `no_permission` · `not_agreed` · `instructor_regular_signup` · `setting_off` |
| notifications.kind(추가, 괄호는 class) | `pre_class_reminder`(service) · `inquiry_received`·`inquiry_answered`·`inquiry_overdue`(transactional) · `report_received`·`report_in_review`·`report_resolved`·`report_filed`(transactional) · `restriction_notice`·`business_restriction_lifted`·`listing_suspended`(transactional) · `terms_change_notice`(회원용, transactional — 직원용은 §7-9 에 이미 있다) · `data_request_received`·`data_request_resolved`(transactional) · `child_turned_adult`(transactional) · `maintenance_notice`·`payment_deadline_extended`·`pg_outage_started`·`pg_outage_recovered`(transactional) · `fee_rate_change_notice`(transactional) · `payout_account_verified`·`payout_account_rejected`(transactional) · `ops_alert_webhook_signature`·`ops_alert_webhook_silence`·`ops_alert_reconciliation_mismatch`·`ops_alert_refund_failed`(transactional) |
| 기존 `kind` 의 class | `payment_confirmed_member`·`payment_confirmed_owner`·`reservation_cancelled`·`refund_pending`·`refund_failed`·`payment_refund_due` = transactional · 직원 알림 10종(§7-9) = transactional · 대기 자리·쿠폰 소멸 = service/marketing 은 만드는 슬라이스가 정한다 |
| notifications.category(추가 없음) | 운영자 경보·점검·장애는 `operations` 를 쓴다(§7-9 의 5값 그대로) |
| push_tokens.platform / permission_state | `android` / `granted` · `denied` · `unknown` |
| notification_settings.pre_class_lead | `day_before` · `two_hours` · `one_hour` · `thirty_min` |
| staff_notification_settings.topic | `class_approval` · `event_capacity` · `inquiry` · `schedule_room` · `platform_notice` |
| inquiries.kind / asker_kind / route / status | `academy` · `system` / `member` · `instructor` · `owner` / `human` · `ai_handoff` / `answer_waiting` · `answered` · `closed` · `ai_answered` |
| inquiries.category | 회원→학원 `class` · `refund` · `schedule` · `other` / 강사→학원 `settlement_basis` · `capacity` · `absence` · `other` / 시스템 `account` · `app_error` · `payment_outage` · `membership` · `other`(D10: 강사 칩 「결석」 = `absence`) |
| inquiry_messages.sender_kind | `asker` · `academy_owner` · `operator` · `ai` |
| reports.reporter_kind / target_kind / status / outcome | `member` · `instructor` · `owner` / `academy` · `instructor` · `class` · `member` / `received` · `in_review` · `resolved` / `dismissed` · `upheld` |
| reports.reason_code | `off_platform_payment`(FR-255) · `info_mismatch` · `harassment` · `illegal_dangerous` · `other` |
| restriction_cases.subject_kind / source / state | `member` · `instructor` · `academy` / `report` · `business_status` · `operator_manual` / `notice_sent` · `explained` · `measure_applied` · `lifted` · `dismissed` |
| restriction_cases.measure | `warning` · `feature_limit` · `listing_limit` · `payout_hold` · `suspension` · `termination`(FR-254) |
| attachment_links.owner_kind | `inquiry_message` · `report` · `restriction_explanation` |
| uploaded_files.purpose(추가) | `inquiry_attachment` · `report_attachment` · `restriction_explanation` |
| terms_versions.audience | `merchant` · `member` |
| terms_versions.kind(추가) | `member_terms` · `member_privacy_collection` · `academy_sharing` · `location_info` · `marketing_consent` |
| members.status | `active` · `suspended` · `withdrawn_pending` · `withdrawn` |
| account_withdrawals.account_kind / status | `member` · `staff` / `requested` · `awaiting_refunds` · `completed` · `cancelled` |
| withdrawn_identities.used_benefits | `university_first_payment_50` · `member_trial_3m` · `instructor_trial_1y` |
| data_requests.kind / status | `processing_stop` · `deletion` / `received` · `in_progress` · `done` · `rejected` |
| data_retention_items.kind | `transaction_record` · `dispute_record` · `access_log` |
| guardian_children.status | `active` · `removed` |
| maintenance_windows.kind / status | `maintenance` · `pg_outage` / `scheduled` · `active` · `ended` · `cancelled` |
| payout holder reject reason | `name_mismatch` · `file_unreadable` · `other` |
| holidays.kind / source | §10-13 (`holiday` · `substitute_holiday` · `temporary_holiday` / `api` · `operator`) |
| orders 취소 사유(M3 와 조율) | `withdrawal` 추가 |

### 12-10. 기존 절과 다른 곳

| 위치 | 다른 점 | 이유 |
|---|---|---|
| §7-9 `notifications.category` | 새 값 없음(`operations` 재사용) | 칩 이름이 O21·O21B 에서 이미 정해졌다 |
| §7-4 `terms_versions` | `audience`·`is_unfavorable`·`change_summary` 칸 | 회원 약관이 같은 표를 쓰되 기간 규칙이 다르다(07 은 입점 약관 30일 하나) |
| §3 `notifications.delivery_status` | 값 3 → 6 | 선점·재시도 대기·실패를 표현 |
| 06-6-5 「받는 곳은 앱 알림함(항상) + 푸시」 | 알림함 행은 설정과 무관하게 항상 쓴다는 원칙 유지 | O34·C1A 문구와 일치 |

### 12-11. 열린 점(데이터)

| # | 무엇 | 추천(근거 없는 것은 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) |
|---|---|---|
| ① | `inquiries.status` 의 `closed` 가 언제 되나 — 자동 종료 일수 spec 에 없음 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 지금은 닫는 경로를 두지 않고 `answered` 로 남긴다. FR-232 이력 보관이 목적이다 |
| ② | 알림 `class` 를 `kind` 마다 어디서 정하나 | 쓰는 쪽이 `kind` 와 함께 쓴다. 상수 표(`lib/domain/notification-kinds.ts`)가 단일 원본이고 단위 테스트가 위 12-9 표와 대조 |
| ③ | **2026-11-20 통합으로 닫음** — 공휴일 표·수집 기록은 §10-13, 영업일 함수는 S0-4.8 하나, 설정 표는 `ops_settings` 하나(MX 의 `ai_settings` 는 AI 전용으로 따로). (옛 내용) `holidays`·설정 표·영업일 함수가 M5 에도 생길 수 있다 | M5 와 조율 — 먼저 만든 쪽이 정의, 이 절은 칸 추가분만 |
| ④ | `notifications` 행 수 증가(광고성 포함) — 표가 커진다 | 베타 규모는 문제 없음. 3년 이후 파티셔닝(월별)은 그때 검토 |
| ⑤ | `inquiry_messages` 추가 전용 트리거 | `audit_logs` 와 같은 손 쓴 마이그레이션 SQL(S0-2 열린 점 ⑦과 같은 확인) |
| ⑥ | 탈퇴 익명화의 정확한 칸 목록·`members` 의 NOT NULL 칸 완화·삭제할 표 목록·`withdrawn_identities` 보존 기한 | **일부 → 2026-11-20 사용자 결정 D18 로 확정** — 비울 것: 이름·연락처·**취향·환불 계좌**(즉시 익명화), 남길 것: 주문·결제·환불 기록 5년 · 불만·분쟁 기록 3년(법률 검토 대상). S7-3.4 구현 전에 정할 것: `members`·`refund_accounts` 의 NOT NULL 칸 완화 방법·삭제할 표 전체 목록. 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이름·연락처·생년월일·본인확인 해시·로그인 연결을 비우고 `withdrawn_identities` 만 3년 보존 |
| ⑦ | `academy_payout_accounts` 에 `submitted_at` 이 따로 필요한가 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 기존 `created_at` 을 올린 시각으로 쓴다(계좌를 바꾸면 새 행이라 같은 뜻). 칸 추가 없음 |
| ⑧ | `guardian_children` 의 `name`·`birth_date` NULL 허용(삭제 시 비움) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) NULL 허용 + `ck_children_removed` 가 `active` 일 때만 NOT NULL |
| ⑨ | `ops_settings` 바꾸기 UI | 이 슬라이스에 없음. 운영자 콘솔 메뉴는 보드에 없다 — 보드가 생기면 추가 |
| ⑩ | `notification_settings` 기본 행을 가입 때 만들까, 읽을 때 기본값을 줄까 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 읽을 때 기본값, 바꿀 때 행 생성(마이그레이션 없이 기본값을 바꿀 수 있다) |
| ⑪ | 탈퇴 요청 취소(마음 바꿈) 경로 | 보드·spec 에 없다. 지금은 `cancelled` 값만 두고 경로는 만들지 않는다 |
| ⑫ | 점검 예약 취소 경로 | 같음 — 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 필요해지면 `…/cancel` 추가 |
| ⑬ | `console.viewed` 를 읽기 요청마다 쓰면 감사 표가 빨리 커진다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 같은 사람·같은 화면·1분 안 중복은 합친다(계약 15 열린 점 ⑬) |

---

## 13. MX(AI 트랙) — 9판 추가 (2026-11-20)

- 작성 2026-11-20 · 짝 문서: `_workspace/03_contracts/16-ai-agent.md`(API) · `CLAUDE-decisions.md` ADR-004·ADR-005
- §0 공통 규칙(uuid PK · text+CHECK · Timestamptz · 금액 int · 신규 FK 는 Restrict · `created_at` 은 `now()`, `updated_at` 은 앱이 쓴다)을 그대로 따른다. §7 의 「감사 ○」 표기(그 테이블을 바꾸는 쓰기는 같은 트랜잭션에서 `audit_logs` 1행)와 민감 칸 규칙(암호화 + 가린 값)도 따른다. 이 절에서 더하는 규칙 셋:
  - **DB 쓰기는 Next.js 하나**(ADR-004). 에이전트 서버는 DB 에 접속하지 않고, 도구 서버는 읽기 전용 트랜잭션만 쓴다. 아래 모든 테이블의 쓰기 주체는 Next.js 서비스 함수다.
  - **AI 가 만든 값은 칸이나 행 수준에서 표시한다**(FR-258): `ai_generated`·`value_source`·`generation_kind`. 사람이 고친 값은 표시가 바뀐다.
  - **개인정보를 두 곳에 두지 않는다**: 대화 원문은 `ai_messages` 에만, 측정·분석용 `ai_runs.question_masked` 에는 전화·메일·계좌·주민번호 모양을 가린 글만 둔다(FR-274).
- 기존 §7 엔티티는 다시 정의하지 않는다. 이 절이 참조하는 것: `members`(§2-2) · `academies` · `classes` · `class_offerings` · `class_sessions`(§2-2) · `staff_accounts`(§7-2) · `uploaded_files`(§7-3) · `audit_logs`(§7-7) · 강사 프로필(S2-1 이 만든다 — 이름 조율) · 문의(S7-2 가 만든다 — 이름 조율).

### 13-1. 엔티티 목록

| # | 테이블 | 묶음 | 한 줄 | 슬라이스 |
|---|---|---|---|---|
| 136 | `ai_conversations` | 대화 | 회원의 AI 대화 한 줄기(플래너·학원 문의). 사람에게 넘기면 문의와 이어진다 | SX-1·SX-3 |
| 137 | `ai_messages` | 대화 | 대화의 말풍선(회원 질문 원문·AI 답·근거·카드·도움 표시) | SX-3 |
| 138 | `ai_runs` | 대화 | 질문 한 건의 처리 기록(등급·대기·첫 내용·완료 시간·모델 호출 수) | SX-1·SX-3 |
| 139 | `ai_chat_usage` | 대화 | 회원×날짜 판단형 질문 횟수(하루 한도) | SX-3 |
| 140 | `ai_jobs` | 작업 | 에이전트에게 맡긴 비동기 작업 한 건(포스터·이미지·FAQ 초안) | SX-2·SX-3·SX-6 |
| 141 | `faq_candidates` | 지식 | 반복 질문 후보와 AI 답 초안 | SX-3 |
| 142 | `faq_candidate_runs` | 지식 | 후보를 이룬 질문(run) 연결 | SX-3 |
| 143 | `knowledge_items` | 지식 | 대표(또는 운영자)가 승인한 T1 지식. 임베딩 칸 포함 | SX-3 |
| 144 | `poster_extractions` | 포스터 | 포스터 한 장의 읽기·검토·제출 상태 | SX-2 |
| 145 | `poster_extraction_fields` | 포스터 | 칸별 읽은 값·신뢰도·확인필요·AI/사람 표시 | SX-2 |
| 146 | `promo_image_generations` | 홍보 | 홍보 이미지 만들기 한 번(입력·상태·결과·횟수 원복) | SX-6 |
| 147 | `promo_image_usage` | 홍보 | 직원×날짜 이미지 생성 사용 횟수 | SX-6 |
| 148 | `class_intro_drafts` | 홍보 | 소개 문구 초안 기록 | SX-6 |
| 149 | `class_promo_assets` | 홍보 | 수업의 표지(사진·AI 이미지)·소개 문구·검토 확인 | SX-6 |
| 150 | `ai_settings` | 설정 | 하루 한도·칩·장르 조건·기준값 같은 설정(배포 없이 고침) | SX-3·SX-6 |
| — | `uploaded_files`(값 추가) · `audit_logs.action`(값 추가) | — | §13-8 | SX-2·SX-6 |

### 13-2. 대화·기록 — FR-200·FR-216·FR-258·FR-264·FR-269·FR-274

**`ai_conversations`** — 감사 ✕(회원 본인 대화)
- 칸: `id uuid` · `member_id → members` · `context_kind text`(`planner`·`inquiry`) · `academy_id uuid NULL → academies` · `offering_id uuid NULL → class_offerings` · `instructor_id uuid NULL`(강사 프로필 id — FK 는 S2-1 테이블이 생기면 건다) · `inquiry_id uuid NULL`(S7-2 문의 — FK 는 S7-2 가 테이블을 만들면 건다) · `status text = 'open'`(`open`·`handed_over`·`closed`) · `created_at` · `last_activity_at` · `closed_at NULL`
- 제약: `ck_ai_conv_context_kind` · `ck_ai_conv_status` · **`ck_ai_conv_inquiry_academy`: `context_kind <> 'inquiry' OR academy_id IS NOT NULL`**(문의 맥락은 학원이 정해져 있다 — API 가 `offeringId` 를 학원으로 풀어 넣는다) · **`ck_ai_conv_handed_over`: `(status = 'handed_over') = (inquiry_id IS NOT NULL)`** · **`uq_ai_conv_inquiry (inquiry_id) WHERE inquiry_id IS NOT NULL`**(대화 하나에 문의 하나) · `ck_ai_conv_closed`: `(status = 'closed') = (closed_at IS NOT NULL)` · `ix_ai_conv_member_activity (member_id, last_activity_at DESC)`
- 에이전트 서버가 들고 있는 후속 질문 맥락(메모리 체크포인터)은 이 테이블과 별개다 — 재시작하면 사라지지만 대화·말풍선은 남는다.

**`ai_messages`** — 감사 ✕. **이 대화는 회원과, 사람에게 넘긴 뒤에는 받는 대표만 읽는다**(FR-207 · SC-029b)
- 칸: `id` · `conversation_id → ai_conversations` · `run_id uuid NULL → ai_runs` · `role text`(`member`·`assistant`) · `body text` · `sources jsonb NULL`(`[{kind,id,label,version?}]`, FR-212) · `tool_calls jsonb NULL`(`[{name,args,resultCount}]`, FR-216 — 결과 본문은 넣지 않는다) · `cards jsonb NULL`(보낸 카드, 다시 열 때 그대로 보이게) · `generation_kind text NULL`(`lookup`=T0 · `knowledge`=T1 · `generated`=T2 · `fallback`=저하·대체 답) · `ai_generated boolean = false` · `helpful boolean NULL` · `feedback_at NULL` · `created_at`
- 제약: `ck_ai_messages_role` · `ck_ai_messages_body_len`: `char_length(body) BETWEEN 1 AND 4000` · **`ck_ai_messages_ai_flag`: `role = 'assistant'` 이면 `ai_generated = true AND generation_kind IS NOT NULL`, `role = 'member'` 이면 `ai_generated = false AND generation_kind IS NULL AND helpful IS NULL`**(FR-258 — 어시스턴트 행은 전부 AI 생성 표시) · `ck_ai_messages_feedback`: `(helpful IS NULL) = (feedback_at IS NULL)` · `ix_ai_messages_conv_created (conversation_id, created_at)` · `ix_ai_messages_run (run_id)`

**`ai_runs`** — 질문 한 건의 측정 기록. 분석·운영자 지표(FR-275)·후보 모으기의 원천
- 칸: `id` · `conversation_id → ai_conversations` · `member_id → members`(조회 편의 사본) · `tier text NULL`(`T0`·`T1`·`T2`·`T3` — `tier` 이벤트가 오면 채움) · `status text = 'queued'`(`queued`·`running`·`succeeded`·`failed`·`cancelled`·`timed_out`) · `question_masked text`(개인정보 모양을 가린 질문) · `queued_at = now()` · `started_at NULL` · `first_content_at NULL` · `finished_at NULL` · `wait_ms int NULL` · `first_content_ms int NULL` · `total_ms int NULL` · `model_calls int = 0`(대화 모델 호출 수 — 임베딩·리랭커 호출은 세지 않는다) · `tool_call_count int = 0` · `degraded boolean = false` · `fallback_used boolean = false` · `handoff_reason text NULL` · `error_code text NULL` · `dropped_card_count int = 0`(Next.js 가 DB 와 대조해 버린 카드 수 — SC-011 방어선 기록) · `t2_counted boolean = false` · `t2_refunded_at NULL` · `created_at`
- 제약: **`uq_ai_runs_member_open (member_id) WHERE status IN ('queued','running')`**(한 회원에 열린 질문 하나 — FR-264. 새 질문은 같은 트랜잭션에서 앞 run 을 `cancelled` 로 닫고 연다) · **`ck_ai_runs_no_model_for_t013`: `tier IN ('T0','T1','T3')` 이면 `model_calls = 0`**(FR-201 · FR-220 · SC-042 — 모델을 안 쓰는 등급이 모델을 불렀으면 기록 단계에서 막힌다) · `ck_ai_runs_done`: `status IN ('succeeded','failed','cancelled','timed_out')` 이면 `finished_at IS NOT NULL` · `ck_ai_runs_ms`: 세 `*_ms` 는 NULL 이거나 `>= 0` · `ck_ai_runs_t2_refund`: `t2_refunded_at IS NULL OR t2_counted` · `ck_ai_runs_tier` · `ck_ai_runs_status` · `ix_ai_runs_member_created (member_id, created_at DESC)` · `ix_ai_runs_created (created_at)`(최근 1시간 중앙값·p95, FR-275) · `ix_ai_runs_conversation (conversation_id)`
- 판단형 횟수는 `tier` 가 `T2` 로 정해진 순간 `ai_chat_usage` 를 조건부 갱신으로 올리고 `t2_counted = true`. 첫 내용이 나가기 전에 `failed`·`timed_out`·`cancelled` 로 끝나면 같은 트랜잭션에서 내리고 `t2_refunded_at` 을 쓴다(추천 — 모델 장애로 한도를 잃지 않게. spec 에는 규칙이 없다).

**`ai_chat_usage`**
- 칸: `member_id → members` · `usage_date date`(KST 달력) · `t2_count int = 0`
- 제약: PK(member_id, usage_date) · `ck_ai_chat_usage_nonneg`: `t2_count >= 0`. 상한 검사는 값이 설정(`ai.t2_daily_limit`)이라 DB CHECK 로 못 걸고 **조건부 UPDATE**(`WHERE t2_count < :limit`)가 권위다.

### 13-3. 비동기 작업

**`ai_jobs`**
- 칸: `id` · `kind text`(`poster_extract`·`promo_image`·`faq_draft`) · `status text = 'queued'`(`queued`·`running`·`succeeded`·`failed`·`timed_out`·`cancelled`) · `subject_id uuid`(그 작업이 채울 행의 id — kind 로 테이블이 정해진다: 포스터 → `poster_extractions` · 이미지 → `promo_image_generations` · 초안 → `faq_candidates`) · `deadline_at timestamptz` · `accepted_at NULL`(에이전트가 202 를 준 때) · `finished_at NULL` · `error_code text NULL` · `created_at`
- 제약: `ck_ai_jobs_kind` · `ck_ai_jobs_status` · **`uq_ai_jobs_subject (kind, subject_id)`**(한 행에 작업 하나 — 다시 읽기는 새 행) · `ck_ai_jobs_done`: `status IN ('succeeded','failed','timed_out','cancelled')` 이면 `finished_at IS NOT NULL` · `ck_ai_jobs_error`: `status IN ('failed','timed_out')` 이면 `error_code IS NOT NULL` · `ix_ai_jobs_open_deadline (deadline_at) WHERE status IN ('queued','running')`(`sweep` 이 훑는다)
- `subject_id` 는 kind 마다 다른 테이블을 가리켜 FK 를 걸 수 없다. 대신 각 테이블이 `job_id → ai_jobs` 를 들고 있고(아래), 결과 전달 서비스가 짝이 맞는지 확인한다.

### 13-4. 지식 — FR-225~FR-229

**`faq_candidates`** — 감사 ○(승인·넘기기)
- 칸: `id` · `scope text`(`academy`·`platform`) · `academy_id uuid NULL → academies` · `question_text text`(가린 질문 중 대표 한 문장) · `dedupe_key text`(정규화한 질문의 해시) · `ask_count int = 1` · `first_asked_at` · `last_asked_at` · `origin text`(`ai_conversation`·`human_reply`) · `status text = 'pending'`(`pending`·`approved`·`skipped`) · `skipped_at_ask_count int NULL` · `draft_text text NULL` · `draft_sources jsonb NULL` · `draft_job_id uuid NULL → ai_jobs` · `draft_at NULL` · `knowledge_item_id uuid NULL → knowledge_items` · `decided_by_staff_account_id NULL → staff_accounts` · `decided_at NULL` · `created_at` · `updated_at`
- 제약: `ck_faq_scope_academy`: `(scope = 'academy') = (academy_id IS NOT NULL)` · **`uq_faq_candidates_academy_dedupe (academy_id, dedupe_key) WHERE academy_id IS NOT NULL`** · **`uq_faq_candidates_platform_dedupe (dedupe_key) WHERE scope = 'platform'`**(같은 질문이 후보로 두 번 안 생긴다 — `build` 를 두 번 불러도 1건) · `ck_faq_decided`: `(status IN ('approved','skipped')) = (decided_at IS NOT NULL)` · `ck_faq_approved_item`: `(status = 'approved') = (knowledge_item_id IS NOT NULL)` · `ck_faq_skipped_count`: `(status = 'skipped') = (skipped_at_ask_count IS NOT NULL)` · `ck_faq_ask_count`: `ask_count >= 1` · `ix_faq_candidates_academy_status (academy_id, status, ask_count DESC)`
- 후보가 `skipped` 인 채로 `ask_count >= skipped_at_ask_count + 3`(설정 `faq.return_after_asks`)이면 `build` 가 `pending` 으로 되돌리고 `skipped_at_ask_count`·`decided_at`·`decided_by` 를 비운다(O42 「다시 묻는 사람이 늘면 후보로 돌아와요」).

**`faq_candidate_runs`** — 칸: `candidate_id → faq_candidates` · `run_id → ai_runs`. 제약: PK(candidate_id, run_id) · `ix_faq_candidate_runs_run (run_id)`. (사람이 답한 내용에서 온 후보 `origin = 'human_reply'` 는 이 연결이 없다.)

**`knowledge_items`** — 감사 ○(승인·다시 확인·내림). 이 테이블에 든 것만 T1 답이 된다(FR-226)
- 칸: `id` · `scope text`(`academy`·`platform`) · `academy_id uuid NULL → academies` · `question text`(≤ 200자) · `answer text`(≤ 1000자) · `evidence jsonb`(`[{kind,id}]`, 1개 이상 — FR-212) · `status text = 'active'`(`active`·`review_due`·`retired`) · `review_due_reason text NULL`(`date_passed`·`evidence_changed`) · `review_after date`(KST 날짜, 기본 승인일 + 6개월) · `approved_by_staff_account_id → staff_accounts` · `approved_at` · `last_reviewed_at NULL` · `version int = 1` · `edited_from_draft boolean = false` · `embedding vector NULL` · `embedding_model text NULL` · `embedding_updated_at NULL` · `created_at` · `updated_at`
- 제약: `ck_knowledge_scope_academy`: `(scope = 'academy') = (academy_id IS NOT NULL)` · `ck_knowledge_evidence`: `jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1` · **`ck_knowledge_review_reason`: `(status = 'review_due') = (review_due_reason IS NOT NULL)`** · `ck_knowledge_embedding_pair`: `(embedding IS NULL) = (embedding_model IS NULL)` · `ck_knowledge_version`: `version >= 1` · `ck_knowledge_lengths`(질문 1~200, 답 1~1000) · `ix_knowledge_academy_status (academy_id, status)` · `ix_knowledge_review_after (review_after) WHERE status = 'active'`(`sweep` 이 훑는다)
- **임베딩 차원은 못 박지 않는다**: `vector` 를 차원 없이 둔다. SX-3.2 가 모델의 실제 차원을 재면 `vector(N)` 으로 바꾸고 HNSW 인덱스를 건다(열린 점 ②). 베타 규모(항목 수백 개)는 순차 검색으로 충분하다. `search_knowledge` 는 `status = 'active' AND embedding IS NOT NULL` 만 읽는다 — 승인 직후 임베딩 전에는 검색에 안 잡힌다.
- `platform` 항목은 운영자(`admin`)만 승인한다 — 앱 검사. 베타는 시드 스크립트로 넣는다(16-ai-agent 열린 점 ⑧).

### 13-5. 포스터 — FR-073~FR-077

**`poster_extractions`** — 감사 ○(검토 끝·제출)
- 칸: `id` · `academy_id → academies` · `uploaded_by_staff_account_id → staff_accounts` · `source_file_id → uploaded_files` · `target_kind text`(`class`·`party`·`performance`·`competition`) · `status text = 'queued'`(`queued`·`running`·`ready`·`failed`·`reviewed`·`submitted`·`abandoned`) · `revision int = 1` · `overall_confidence numeric(4,3) NULL` · `failure_code text NULL` · `job_id uuid NULL → ai_jobs` · `model text NULL` · `elapsed_ms int NULL` · `reviewed_at timestamptz NULL` · `reviewed_by_staff_account_id NULL → staff_accounts` · `submitted_class_id uuid NULL → classes` · `submitted_at NULL` · `created_at` · `updated_at`
- 제약: `uq_poster_source_file (source_file_id)`(올린 파일 하나에 읽기 하나 — 다시 읽으려면 다시 올린다) · `ck_poster_status` · `ck_poster_target_kind` · `ck_poster_revision`: `revision >= 1` · `ck_poster_confidence`: 0~1 · **`ck_poster_reviewed`: `status IN ('reviewed','submitted')` 이면 `reviewed_at IS NOT NULL AND reviewed_by_staff_account_id IS NOT NULL`, `status IN ('queued','running','ready','failed')` 이면 `reviewed_at IS NULL`**(검토 끝 표시 없이 `reviewed`·`submitted` 가 될 수 없다 — FR-074 의 DB 쪽 방어선) · **`ck_poster_submitted`: `(status = 'submitted') = (submitted_class_id IS NOT NULL)`** · `ck_poster_failed`: `(status = 'failed') = (failure_code IS NOT NULL)` · **`uq_poster_submitted_class (submitted_class_id) WHERE submitted_class_id IS NOT NULL`**(한 수업은 한 포스터에서만) · `ix_poster_academy_status (academy_id, status, created_at DESC)` · `ix_poster_uploader (uploaded_by_staff_account_id, created_at DESC)`(위임 강사는 자기가 올린 것만 본다 — W30)
- 값을 고치면(`PATCH`) `revision` +1, `reviewed` 였으면 `ready` 로 돌아가며 `reviewed_at`·`reviewed_by` 를 비운다(앱이 한 문장으로 처리).

**`poster_extraction_fields`**
- 칸: `extraction_id → poster_extractions` · `field_key text` · `value jsonb NULL` · `confidence numeric(4,3) NULL` · `needs_check boolean` · `value_source text = 'ai'`(`ai`·`user`·`ai_edited`) · `confirmed_at timestamptz NULL` · `updated_at`
- 제약: PK(extraction_id, field_key) · `ck_poster_field_key`(§13-8 의 17개 — 기간 칸 3개는 SX-2.6 (추천안·사후 확인 2026-11-24), 마이그레이션 `20261124T0134_poster_period_fields` 가 이미 읽은 포스터에 「못 읽음」 줄 3개를 채운다) · `ck_poster_field_conf`: `confidence IS NULL OR confidence BETWEEN 0 AND 1` · **`ck_poster_field_user_checked`: `value_source IN ('user','ai_edited')` 이면 `needs_check = false`**(사람이 손댄 칸은 확인필요가 아니다) · **`ck_poster_field_null_flagged`: `value_source <> 'ai' OR value IS NOT NULL OR needs_check`**(AI 가 못 읽은 칸은 반드시 확인필요 — FR-075)
- `review` 는 `needs_check = true` 인 칸이 남았는지만 센다(고치거나 `confirmedKeys` 로 확인하면 `needs_check = false`, `confirmed_at` 을 쓴다).

### 13-6. 홍보 이미지·소개 문구 — FR-061·FR-061a·FR-258

**`promo_image_generations`**
- 칸: `id` · `staff_account_id → staff_accounts` · `class_id → classes` · `genre text`(§4.1 genre — 수업에서 가져온 값 사본) · `chips jsonb`(`{who,mood,place,color}` 각 값은 칩 낱말 또는 `{"custom":"…"}`) · `sentence text` · `auto_condition_ids text[] = '{}'` · `english_prompt text NULL`(번역 기록 — 앱에는 안 보인다) · `usage_date date`(KST, 차감한 날) · `status text = 'queued'`(`queued`·`running`·`succeeded`·`failed`) · `image_file_id uuid NULL → uploaded_files` · `engine text NULL`(만든 엔진 id — 에이전트 결과 `engine`, FR-061a 「엔진 이름 기록」 SX-6.4 (추천안·사후 확인 2026-11-24)) · `model text NULL` · `failure_code text NULL` · `quota_refunded_at timestamptz NULL` · `idempotency_key text` · `job_id uuid NULL → ai_jobs` · `ai_generated boolean = true` · `created_at` · `finished_at NULL`
- 제약: **`uq_promo_gen_staff_idem (staff_account_id, idempotency_key)`** · `ck_promo_gen_sentence`: `char_length(sentence) BETWEEN 1 AND 200` · `ck_promo_gen_ai`: `ai_generated` 는 항상 true · **`ck_promo_gen_succeeded_image`: `(status = 'succeeded') = (image_file_id IS NOT NULL)`** · `ck_promo_gen_failed`: `(status = 'failed') = (failure_code IS NOT NULL)` · **`ck_promo_gen_refund`: `quota_refunded_at IS NULL OR status = 'failed'`**(성공한 생성은 횟수를 돌려주지 않는다) · `ix_promo_gen_staff_created (staff_account_id, created_at DESC)`(지난 입력 불러오기) · `ix_promo_gen_month (created_at) WHERE status IN ('queued','running','succeeded')`(이달 무료량 셈)
- **막는 입력은 행을 만들지 않는다**(횟수 불변 — 422 로 끝). 입력 판정 결과 기록이 필요하면 `audit_logs` 가 아니라 앱 로그(`promo.input_blocked`, 종류만 — 문장은 남기지 않는다).

**`promo_image_usage`** — 칸: `staff_account_id → staff_accounts` · `usage_date date` · `used_count int = 0`. 제약: PK(staff_account_id, usage_date) · `ck_promo_usage_nonneg`: `used_count >= 0`. 상한은 설정 `promo_image.daily_limit`(베타 3, 정식 1)이라 CHECK 가 아니라 **조건부 UPDATE**(`WHERE used_count < :limit`)가 권위이고, 원복은 `GREATEST(used_count - 1, 0)`.

**`promo_image_engine_usage`** — 칸: `engine text`(엔진 id) · `usage_date date`(KST) · `used_count int = 0`. 제약: PK(engine, usage_date) · `ck_promo_engine_usage_nonneg`: `used_count >= 0`. 엔진별 전체 하루 한도(spec FR-061a)를 사람 수와 상관없이 지킨다 — 상한은 설정 파일 `promo-image-quota.json` 의 `engineDailyLimit`, 사람 횟수와 같은 트랜잭션의 조건부 UPDATE 가 권위이고 실패해도 돌려주지 않는다. (SX-6.5 추천안·사후 확인 2026-11-24) SX-6.8: 공급자가 `PROVIDER_QUOTA_EXHAUSTED` 를 알리면 그 생성의 엔진·날짜 줄을 `engineDailyLimit` 까지 채워 그날 그 엔진을 막는다 — `ai_settings` 의 `promo_image.provider_exhausted_until` 칸 대신이다. 이달 무료량은 학원 전체 `promo_image.monthly_free_cap` 대신 엔진마다 `monthlyFreeCap`(설정 파일, null = 달 단위로 막지 않음)으로 `promo_image_generations` 를 센다. (SX-6.8 추천안·사후 확인 2026-11-24)

SX-6.5 구현에서 위 `promo_image_generations` 설계와 다르게 한 것(추천안·사후 확인 2026-11-24): ① `auto_condition_ids` 는 `text[]` 대신 `json` 배열(기본 `[]`) — 계약 도구가 배열 칸을 쓰지 않는 다른 표들과 맞췄다 ② `engine` 은 NULL 허용 대신 NOT NULL — 고른 엔진을 만들 때 적고, 결과가 오면 에이전트가 알린 엔진 id 로 덮는다 ③ `ck_promo_gen_done`(끝난 생성은 `finished_at` 있음)을 더했다 ④ `uploaded_files.purpose` 에 `class_promo_image` 를 더했다(만들 때 private). 마이그레이션 `admin-web/migrations/app/20261124T1142_promo_image_quota`.

**`class_intro_drafts`** — 칸: `id` · `staff_account_id` · `class_id → classes` · `emphasis text NULL`(강조할 점) · `body text`(자리표시자를 채운 최종 문장) · `facts jsonb`(`{schedule, sessionCount, price, level}` — 수업 데이터에서 가져온 값) · `model text NULL` · `ai_generated boolean = true` · `created_at`. 제약: `ck_intro_emphasis_len`: `emphasis IS NULL OR char_length(emphasis) <= 60` · `ck_intro_ai`: `ai_generated` 는 항상 true · `ix_intro_class_created (class_id, created_at DESC)`. 구현(SX-6.6 (추천안·사후 확인 2026-11-24)): `facts` 는 `json`, `ck_intro_body_len`(`body` 1~600자 — `class_promo_assets.intro_text` 상한과 같음) 추가, 인덱스는 `(class_id, created_at)`(정렬 방향은 Prisma 계약으로 못 적어 오름차순 — 역순 읽기도 같은 인덱스를 쓴다), `model` 은 모델 틀이 두 번 다 거부돼 기본 문장을 쓴 행에서 NULL. 마이그레이션 `20261124T1207_class_intro_drafts`.

**`class_promo_assets`** — 감사 ○(검토 확인)
- 칸: `class_id → classes`(PK) · `uploaded_photo_file_id NULL → uploaded_files` · `ai_image_generation_id NULL → promo_image_generations` · `cover_source text NULL`(`uploaded_photo`·`ai_image`) · `intro_text text NULL` · `intro_source text NULL`(`ai`·`ai_edited`·`user`) · `intro_draft_id NULL → class_intro_drafts` · `reviewed_at timestamptz NULL` · `reviewed_by_staff_account_id NULL → staff_accounts` · `updated_at`
- 제약: **`ck_promo_assets_cover`**: ① `uploaded_photo_file_id IS NOT NULL` 이면 `cover_source = 'uploaded_photo'`(**사진이 먼저**) ② `cover_source = 'ai_image'` 이면 `ai_image_generation_id IS NOT NULL AND uploaded_photo_file_id IS NULL` ③ `cover_source IS NULL` 이면 `uploaded_photo_file_id IS NULL AND ai_image_generation_id IS NULL` · `ck_promo_assets_intro`: `(intro_text IS NULL) = (intro_source IS NULL)` · `ck_promo_assets_intro_len`: `intro_text IS NULL OR char_length(intro_text) <= 600`임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) · `ck_promo_assets_review`: `(reviewed_at IS NULL) = (reviewed_by_staff_account_id IS NULL)`
- **「검토가 필요한가」 판정식**(S2-2 의 승인 요청·승인 서비스가 쓴다): `cover_source = 'ai_image' OR intro_source IN ('ai','ai_edited')` 이고 `reviewed_at IS NULL` 이면 거부(`PROMO_REVIEW_REQUIRED`). 이 판정은 `classes` 상태 전이와 한 줄로 걸어야 하므로 DB 트리거가 아니라 서비스 함수 하나(`assertPromoAssetsReviewed`)와 DB 테스트로 지킨다.
- 표지·문구를 고치면 `reviewed_at`·`reviewed_by` 를 비운다(앱).
- 구현(SX-6.7 (추천안·사후 확인 2026-11-24)): 마이그레이션 `20261124T1225_class_promo_assets`. 값 집합은 Prisma enum `PromoCoverSource`·`PromoIntroSource`(앱 상수 `PROMO_COVER_SOURCES`·`PROMO_INTRO_SOURCES`). `ck_promo_assets_intro_len` 은 빈 글자를 막으려고 `BETWEEN 1 AND 600`. 사진이 이기면 `ai_image_generation_id` 는 NULL 로 둔다(쓰지 않는 그림을 걸어 두지 않는다). `updated_at` 기본값 `now()`. 「고치면 비운다」는 PUT 전체 교체가 `reviewConfirmed` 없는 저장마다 비우는 것으로 지킨다.

### 13-7. 설정 — FR-061a(「코드에 박지 않고 설정값」) · FR-276

**`ai_settings`** — 감사 ○(운영자 변경)
- 칸: `key text`(PK) · `value jsonb` · `description text` · `updated_by_staff_account_id NULL` · `updated_at`
- 제약: `ck_ai_settings_key`: §13-8 의 키 목록(앱 상수와 문자 단위로 같게 — 값 집합 단위 테스트 1개). 값 모양은 키마다 앱이 zod 로 검증한다. 변경은 운영자(`admin`)만, 같은 트랜잭션에서 `audit_logs`(`ai_setting.changed`, 전후 값).
- 시드(추천값은 16-ai-agent 열린 점): 키마다 기본값 한 줄을 시드 스크립트가 넣는다.

### 13-8. 공유 계약 §4.1 추가 값 집합

| 테이블.칸 | 값 |
|---|---|
| ai_conversations.context_kind / status | `planner` · `inquiry` / `open` · `handed_over` · `closed` |
| ai_messages.role / generation_kind | `member` · `assistant` / `lookup`(T0) · `knowledge`(T1) · `generated`(T2) · `fallback` |
| ai_runs.tier | `T0` · `T1` · `T2` · `T3` |
| ai_runs.status | `queued` · `running` · `succeeded` · `failed` · `cancelled` · `timed_out` |
| ai_runs.handoff_reason | `sensitive` · `low_confidence` · `user_request` · `unsatisfied` |
| ai_runs.error_code | `QUEUE_FULL` · `T2_DAILY_LIMIT` · `DEGRADED` · `MODEL_UNAVAILABLE` · `LANGUAGE_CHECK_FAILED` · `NO_EVIDENCE` · `AGENT_TIMEOUT` · `AGENT_UNAVAILABLE` |
| ai_jobs.kind / status | `poster_extract` · `promo_image` · `faq_draft` / `queued` · `running` · `succeeded` · `failed` · `timed_out` · `cancelled` |
| ai_jobs.error_code | `EXTRACTION_FAILED` · `PROVIDER_QUOTA_EXHAUSTED` · `PROVIDER_ERROR` · `INVALID_RESULT` · `AGENT_UNAVAILABLE` · `TIMEOUT` |
| faq_candidates.scope / status / origin | `academy` · `platform` / `pending` · `approved` · `skipped` / `ai_conversation` · `human_reply` |
| knowledge_items.status / review_due_reason | `active` · `review_due` · `retired` / `date_passed` · `evidence_changed` |
| knowledge_items.evidence[].kind · ai_messages.sources[].kind | `knowledge_item` · `academy_notice` · `refund_notice` · `terms` · `academy_info` · `offering` · `order` · `reservation` · `profile` |
| poster_extractions.status | `queued` · `running` · `ready` · `failed` · `reviewed` · `submitted` · `abandoned` |
| poster_extractions.target_kind | `class` · `party` · `performance` · `competition` |
| poster_extractions.failure_code | `EXTRACTION_FAILED` · `AGENT_UNAVAILABLE` · `TIMEOUT` · `INVALID_RESULT` |
| poster_extraction_fields.field_key | `genre` · `genre_detail` · `title` · `weekday` · `start_time` · `end_time` · `start_date` · `end_date` · `session_count` · `room_name` · `price_amount` · `capacity_male` · `capacity_female` · `capacity_total` · `instructor_name` · `level` · `class_kind` — 기간 칸 3개는 SX-2.6 (추천안·사후 확인 2026-11-24) |
| poster_extraction_fields.value_source | `ai` · `user` · `ai_edited` |
| promo_image_generations.status / failure_code | `queued` · `running` · `succeeded` · `failed` / `PROVIDER_QUOTA_EXHAUSTED` · `PROVIDER_ERROR` · `AGENT_UNAVAILABLE` · `TIMEOUT` · `INVALID_RESULT` |
| promo_image_generations.chips 키 | `who`(커플·단체·솔로) · `mood`(열정적인·우아한·경쾌한·로맨틱한·편안한) · `place`(스튜디오·무대·파티 홀·야외) · `color`(빨간 조명·따뜻한 노을빛·푸른 밤·밝은 자연광) — 낱말 목록은 설정이라 CHECK 는 키 4개만 건다(추천안, 사용자 확인 대기) |
| class_promo_assets.cover_source / intro_source | `uploaded_photo` · `ai_image` / `ai` · `ai_edited` · `user` |
| ai_settings.key (기본값) | `ai.t2_daily_limit`(20) · `ai.recommend_enabled`(false) · `faq.candidate_min_asks`(3) · `faq.return_after_asks`(3) · `poster.confidence_min`(0.80) · `promo_image.daily_limit`(3 — 베타, 정식 1) · `promo_image.monthly_free_cap`(80) · `promo_image.provider_exhausted_until`(null) · `promo_image.model`(11-2 를 따름) · `promo_image.chips`(칩 낱말) · `promo_image.examples`(예시 문장) · `promo_image.auto_conditions`(장르별 조건 — id·한글 문장·영어 문장·끌 수 있는지) · `promo_image.blocked_terms`(막는 낱말·이름·상표 목록) · `chat.conversation_retention_days`(30) |
| uploaded_files.purpose / visibility(추가) | `poster`(§8 과 같은 값 — private, 게시 때 public) · `class_promo_image`(private → 수업이 승인·게시될 때 S2-2 가 `public` 으로) |
| audit_logs.action(MX) | `knowledge_item.approved`·`.reconfirmed`·`.retired` · `faq_candidate.skipped` · `poster_extraction.reviewed`·`.submitted` · `promo_assets.reviewed` · `ai_setting.changed` |

### 13-9. 상태 전이

| 대상 | 전이 |
|---|---|
| `ai_runs` | `queued` → `running` → `succeeded`·`failed`·`cancelled`·`timed_out`. 새 질문이 오면 열린 run 은 같은 트랜잭션에서 `cancelled` |
| `ai_conversations` | `open` → `handed_over`(문의가 만들어질 때 `inquiry_id` 를 함께) · `closed`(보관 기간 지남, `sweep`) |
| `ai_jobs` | `queued` → `running` → `succeeded`·`failed`·`timed_out`. 끝난 작업에 온 결과는 무시 |
| `poster_extractions` | `queued` → `running` → `ready` ⇄ `reviewed`(`PATCH` 하면 `ready`) → `submitted`. `queued`·`running` → `failed`. 어느 때든 `abandoned`. `submitted`·`abandoned` 는 끝 |
| `faq_candidates` | `pending` → `approved`(끝) · `skipped` → `pending`(3번 더 묻힘) |
| `knowledge_items` | `active` → `review_due`(날짜 · 근거 판본 변경) → `active`(`reconfirm`, `version` +1) · `active`·`review_due` → `retired`(끝) |
| `promo_image_generations` | `queued` → `running` → `succeeded` · `failed`(횟수 원복 1회). 끝 상태에서는 안 바뀐다 |
| `class_promo_assets.reviewed_at` | 비어 있음 → 검토 확인으로 채움 → 표지·문구를 고치면 다시 비움 |

### 13-10. 왜 이렇게 나눴나

- **대화(`ai_messages`)와 측정(`ai_runs`)을 따로 뒀다** — 원문은 회원과 받는 대표만 읽어야 하고(FR-207) 측정·후보 모으기는 가린 글로만 해야 한다(FR-274). 한 테이블에 두면 운영자 지표 조회가 원문을 끌고 온다.
- **작업(`ai_jobs`)을 하나로 모았다** — 포스터·이미지·FAQ 초안이 같은 접수·기한·결과 전달·중복 방지 규칙을 쓴다. 결과가 들어갈 자리(`subject_id`)만 다르다.
- **횟수를 행 수가 아니라 카운터 행으로 센다** — 「N+1번째 거부」를 `SELECT count` 뒤 `INSERT` 로 하면 동시에 눌렀을 때 N 을 넘는다(정원 초과와 같은 문제). 조건부 UPDATE 한 문장이 DB 에서 직렬화한다.
- **지식(`knowledge_items`)과 후보(`faq_candidates`)를 나눴다** — 후보는 AI 가 만든 초안이고 지식은 사람이 승인한 것이다(FR-226). 모델이 만든 답이 검토 없이 지식이 될 길을 테이블 단계에서 없앴다(후보에는 `embedding` 이 없고, `search_knowledge` 는 `knowledge_items` 만 읽는다).
- **포스터 칸을 행으로 풀었다**(`poster_extraction_fields`) — 「확인필요 칸이 남았나」·「AI 가 못 읽은 칸은 반드시 확인필요」를 CHECK 와 한 줄 쿼리로 시험할 수 있다. 칸 목록이 종류(파티·공연·대회)마다 달라져도 테이블이 안 바뀐다.
- **홍보 이미지 위 글자는 저장하지 않는다** — 수업 데이터가 원본이고 앱이 얹는다(FR-061a). 그래서 `class_promo_assets` 에는 글자 칸이 없고 `textOverlay.source` 는 응답 고정값이다.

### 13-11. 열린 점(데이터)

| # | 무엇 | 추천 · 조율 |
|---|---|---|
| ① | 문의(`inquiries`)·강사 프로필 테이블 이름과 FK | S7-2·S2-1 이 만든 뒤 `ai_conversations.inquiry_id`·`instructor_id` 에 FK 를 건다. 그때까지 uuid 칸만 둔다 |
| ② | 임베딩 차원·인덱스 | SX-3.2 실측(R16 약관 확인 뒤)으로 `vector(N)` + HNSW. 수업·강사 벡터 색인(`offering_embeddings`)은 SX-4 가 필요하다고 판단할 때 더한다 |
| ③ | `classes.level`(수업 레벨) | 카드에 레벨이 나오는데 §2-2 `classes` 에 칸이 없다. S2-2 와 조율 — 없으면 카드의 `level` 은 `null` |
| ④ | 대화·질문 보관 기간 | 넘기지 않은 대화 30일(추천, `chat.conversation_retention_days`). 문의로 넘긴 대화는 문의 보존 기간(FR-232 · O-16)을 따른다 |
| ⑤ | `class_promo_image` 파일의 공개 시점 | 만들 때 `private`, 수업이 게시될 때 `public`. 전환은 S2-2.7 이 부른다(조율) |
| ⑥ | `ai_runs` 보관 | 질문은 가린 글이라 길게 둬도 되지만 FR-275 는 최근 1시간만 본다. 추천: 원본 행 90일, 이후 일 단위 집계만(집계 테이블은 S7-4 에서) |
| ⑦ | 판단형 횟수 원복 | 실패·시간 초과·첫 내용 전 취소는 돌려준다(추천, spec 에 규칙 없음) |
| ⑧ | 포스터 칸 키 | 정규 수업 기준 17개(2026-11-24 기간 칸 3개 추가 — SX-2.6 (추천안·사후 확인 2026-11-24)). 파티·공연·대회는 S6-4 가 칸을 더한다(`field_key` CHECK 값 추가) |

---

## 14. 통합 정리 (2026-11-20) — 마일스톤별 초안의 겹침을 하나로 정한 것

§8~§13 은 마일스톤마다 따로 쓴 초안을 붙인 것이다. 같은 것을 두 초안이 다르게 정의한 곳은 아래처럼 하나로 정했고, 각 절의 본문도 이 표에 맞춰 고쳤다. 사용자 확인이 필요한 것은 고치지 않고 `_workspace/evidence/penpot-doc-sync-2026-11-20/integration.md` 의 「사람 결정 목록」에 올렸다. **구현 중 이 문서의 두 절이 어긋나 보이면 이 §14 가 이긴다.**

### 14-1. 공유 엔티티 — 정의는 한 곳

| 무엇 | 정의하는 곳 | 읽거나 칸만 더하는 곳 | 정한 것 |
|---|---|---|---|
| 강사 사업자등록번호·등록증 | `instructor_profiles`(§8-3) | §10-5 `instructor_settlement_profiles` 는 `tax_type` 만 | M5 초안의 `business_registration_number`·`business_proof_file_id` 칸을 뺐다. 경로도 11 §2-2 하나(13 §3-1 은 `taxType` 만 받는다) |
| 공휴일 표·수집 기록 | §10-13 `holidays`·`holiday_sync_runs` | M0 이 만든다(S0-4.7 · S0-4.10). 영업일 함수는 S0-4.8 하나 | M5·M7 초안이 서로 「상대가 만든다」고 적었다. 운영자 경로(P9)는 13 §10-1 |
| 정산 계좌 예금주 확인 상태 | §10-5 `verification_status`(대표·강사 두 계좌 표 공통) | P10 경로 13 §10-2 | M7 초안의 `academy_payout_accounts.holder_status`(`confirmed`)는 버리고 `verified` 로 통일. 반려 사유는 `reject_reason_code`·`reject_reason_text` |
| 이용 제한 | 학원 조치 행 `academy_restrictions`(§7-3b) · 절차와 소명 `restriction_cases`·`restriction_explanations`(§12) | 사업자 점검(13 §10-3)이 둘을 함께 연다. `academy_restrictions.source_case_id`(§12-3)로 잇는다 | 소명 **제출** 경로는 15 §2-8 하나. 07~10 에는 없다 |
| 쿠폰·대학생 할인 차액 줄 | 값 이름·부호는 §10-2(`coupon_burden`, `amount <= 0`) | 쓰는 쪽은 §11-3(S6-2.5) | §14-3 |
| 레벨의 세부 장르 | 수업 칸 `discipline`·`sub_genre`·`genre`(§8-2 · §8-7 · §3) | §11-4 의 `detail_genre` 칸(레벨·카드·평가 표) | `classes.detail_genre` 칸은 만들지 않는다. `levelGenreOf(class)` = `discipline` ?? `sub_genre` ?? `genre`. 값은 댄스스포츠 10종 + `salsa`·`bachata` + `argentine_tango`·`swing`(초안의 `lindy_hop` 은 `swing` 으로) |
| 설정 값 표 | 운영은 `ops_settings`(§12), AI 는 `ai_settings`(§13) | — | 둘을 합치지 않는다(AI 설정은 에이전트 기준값이 많고 바꾸는 사람이 다르다) |
| 포스터 파일 | `uploaded_files.purpose='poster'`(§8) | 행사 포스터(§11)·포스터 읽기(§13)도 같은 값 | M6 초안의 `event_poster` 는 버림. 공개 범위는 §14-2 |

### 14-2. 값 집합 — §3·§7-9 위에 더하는 통합 목록

| 테이블.칸 | 값 | 정한 근거 |
|---|---|---|
| payments.method | `card` · `easy_pay`(간편결제) · `easy_transfer`(간편 계좌이체) · `virtual_account` | §3 의 2값을 FR-280(결제수단 결정)의 4수단으로 넓힌다. 이름은 14·15 계약이 이미 쓰는 것. CHECK 교체는 S3-3(결제 시작~확정)이 한다. 포트원 값 대응은 17 §2-2(간편 계좌이체 값은 미확인) |
| membership_charges.method · billing_methods.kind(§11-2) | §11-9 그대로 | 멤버십 정기결제 전용(`auto_transfer`·`manual_transfer` 는 멤버십에만). `payments.method` 와 이름이 같은 값은 뜻도 같다 |
| uploaded_files.purpose / visibility | `merchant_evidence`(private) · `academy_photo`(public) · `instructor_photo`(public) · `poster`(private, 수업이 게시될 때 public) · `business_registration_evidence`(private) · `holder_proof`(private) · `dispute_attachment`(private) · `chargeback_evidence`(private) · `inquiry_attachment`(private) · `report_attachment`(private) · `restriction_explanation`(private) · `class_promo_image`(private, 게시 때 public) | §7-9·§8·§10-5·§12-9·§13-8 을 한 줄로. `ck_files_evidence_private` 는 private 값 전부로 넓힌다. M2 초안의 「`poster` 는 처음부터 public」은 §13(포스터 읽기)과 맞춰 「게시 때 public」으로 바꿨다 |
| notifications.class | `transactional` · `service` · `marketing` | §12-2. kind 마다의 class 는 `lib/domain/notification-kinds.ts` 한 표(§12-11 ②). 다른 절의 kind 는 그 절의 제안을 따르되 쿠폰 소멸 안내(`coupon_expiring`)는 사람 결정 대기(§11-9 는 service, 15 열린 점 ② 는 marketing) |
| holidays.kind / source | `holiday` · `substitute_holiday` · `temporary_holiday` / `api` · `operator` | M5 초안의 `substitute`·`temporary` 는 버림 |
| verification_status / reject_reason_code | `awaiting_proof` · `pending` · `verified` · `rejected` / `name_mismatch` · `file_unreadable` · `other` | §10-9 · 13 §10-2 |
| inquiries.category(강사 → 학원) | `settlement_basis` · `capacity` · `absence`(결석) · `other` | D10 — §8-7·§12-9·15 §2-1 이 같다 |

**오류 코드 이름 통일**(계약 파일도 고쳤다): P9 `HOLIDAY_DATE_EXISTS`·`HOLIDAY_NOT_EDITABLE`(13 초안의 `HOLIDAY_DATE_TAKEN`·`HOLIDAY_AUTO_ROW_READONLY` 버림) · P10 `VERIFICATION_STATE_CONFLICT`·`NAME_MISMATCH_CONFIRM`(13 초안의 `REVIEW_ALREADY_DECIDED` 버림) · 계좌 예금주가 본인확인 이름과 다름 `ACCOUNT_HOLDER_MISMATCH`(13 의 `HOLDER_NAME_MISMATCH` 를 12 이름으로) · 감사·알림 `payout_account.holder_verified`·`payout_account_verified`(M7 초안의 `…confirmed` 버림).

### 14-3. `coupon_burden` 줄의 금액

M5 의 부호 규칙(`ck_settlement_amount_sign`: `coupon_burden` → `amount <= 0`)이 이긴다. 대학생 50% 주문은 `amount = −orders.benefit_discount_amount`, 1+1 추가 수업·동반자 쿠폰 주문은 `amount = 0`(사용 표시만, FR-119 · FR-121c). **정보 줄이다** — `sale` 이 이미 회원이 실제로 낸 금액이므로 지급액·단계 합계·보존식(`Σ 단계 + 환불분 ± 조정 = 결제 총액`)에서 `kind = 'coupon_burden'` 줄은 뺀다. 대표 명세(W13)에는 「대표 부담 할인」 줄로 보인다.

### 14-4. 통합 때 새 계약 경로를 위해 더한 칸

| 테이블 | 더하는 칸 · 제약 | 경로 |
|---|---|---|
| `academies`(§2-2 · §7-3) | `termination_requested_at timestamptz NULL` · `termination_requested_by_account_id uuid NULL → staff_accounts` · `termination_reason_text text NULL`(1~200자) · `terminated_at timestamptz NULL`. 제약 `ck_academies_termination`: `status='termination_requested'` → `termination_requested_at IS NOT NULL` · `status='terminated'` → `terminated_at IS NOT NULL`. 감사 `academy.termination_requested`·`academy.terminated`. 알림 kind `academy_terminated`(service) | 15 §3-7 — FR-256(입점 해지) · W26 |
| (새 표 없음) | 순위판·참여학원 목록·신규 참여 카드는 §11-3 의 `ranking_snapshots`·`academy_exposure_events` 와 `coupon_first_enabled_at` 을 그대로 쓴다. 수업 검색 조회수 원천 표는 아직 없다(14 열린 점 ⑲) | 14 §4-4b — S6-2.9 |

### 14-5. 엔티티 번호

§7 의 41 다음부터 절 순서대로 이었다: §8 42~59 · §9 60~74 · §10 75~90(89·90 은 §10-13 공휴일) · §11 91~118 · §12 119~135 · §13 136~150. 초안의 임시 번호(`a`·`M5-n`·`M6-n`·`M7-n`·`MX-n`)는 쓰지 않는다. 62·75 는 비워 두었다 — 그 자리의 `refunds`·`settlement_entries` 는 §1 의 19·18 을 확장하는 것이라 새 번호를 주지 않았다.

### 14-6. 2026-11-20 2차 사용자 결정 D13~D20 반영

| 결정 | 데이터 모델에서 무엇이 달라졌나 | 어디 |
|---|---|---|
| D13 환불 중복 방지 | 예약당 부분 유니크 `uq_refunds_reservation_id_active` → **원인당 부분 유니크 `uq_refunds_basis_active (basis_kind, basis_id) WHERE status <> 'failed'`** + 주문 환불 합계 CHECK `ck_orders_refunded_cap` | §2-3 `refunds` 행 · §9-3 · §9-9 ① |
| D14 일괄 취소 계좌분 | `event_cancellation_items` 에 `account_reminded_3d_at`·`account_reminded_6d_at`·`account_overdue_flagged_at` 3칸(3일·6일 재알림, 7일 뒤 운영자 연락 표시). 줄 상태 `awaiting_account` 는 그대로 | §9-4 · §9-9 ⑪ |
| D23 청약철회 예매 수수료 부담 | 법정 청약철회로 돌려주는 예매 수수료는 **플랫폼 부담**: 카드분은 PG 전액 환불로 플랫폼 몫이 줄고(원장 줄 없음), 계좌분은 대표가 전액 송금한 뒤 `settlement_entries` 새 줄 `booking_fee_reimbursement`(+, 청약철회 계좌분만)로 다음 정산에서 보전한다. 줄 종류는 13종 → 14종, `uq_settlement_refund_kind (source_refund_id, kind)` 가 두 번 보전을 막는다 | §10-3 줄 종류 표 · §10-9 |
| D15 · D21 예매 수수료 | **예매 수수료는 법정 청약철회(수업 시작 전, 법정 철회 기간 안의 단순 취소)만 예외로 전액 환불하고(D21) 그 밖의 어떤 환불에서도 환불하지 않는다.** `orders.booking_fee_refunded_amount`(가칭) 와 `refunds.basis_kind='statutory_withdrawal'` 이 더해졌고 `ck_orders_refunded_cap` 상한은 `total_amount − booking_fee_amount + booking_fee_refunded_amount` 다. 나머지는 그대로:  `ck_orders_refunded_cap` 상한이 `total_amount` 에서 `total_amount − booking_fee_amount` 로, `ck_event_cancellations_total`·`ck_ec_items_amount` 가 `refund = participation`(예매 수수료 제외)으로, 주문 `refunded` 전이 조건이 합 = `total_amount − booking_fee_amount` 로 바뀐다. **정산 원장에 새 줄 종류는 없다**(보전 줄·대표 부담 차감 줄 모두 폐기 — `settlement_entries` 의 `sale` 은 이미 예매 수수료를 뺀 값이라 고칠 것이 없다) | §9-3 `orders` · §9-4 |
| D16 끝수 | 값·함수만: 플랫폼 수수료 `ceilMulDiv`(올림), 강사 몫·원천징수 3.3% `floorMulDiv`(버림, 세무 확인 필요). 칸 변화 없음 | §10-9 · §14-6 |
| D17 수수료율 시작일 | 칸 변화 없음. `platform_fee_rates.effective_from` 이 저장 시각 + 30일 이후여야 한다는 앱 검사(계약 15 `NOTICE_PERIOD_TOO_SHORT`) | 계약 15 §4 |
| D18 탈퇴 보관·익명화 | 익명화 대상에 **취향(`member_interest_genres` 행 삭제)·환불 계좌(`refund_accounts` 의 번호·가린 번호·예금주 비움)** 추가. 보관은 `data_retention_items` 의 `transaction_record` 5년(주문·결제·환불) · `dispute_record` 3년. 법률 검토 대상 표시. NOT NULL 칸 완화 방법은 S7-3.4 가 정한다 | §12 탈퇴·보존 · §12 열린 점 ⑥ |
| D19 입점 해지 | `settlement_entries.adjustment_reason` 에 `termination_refund`(해지 뒤 회원 환불금을 남은 정산금에서 상계, `offset`) 추가. 모자란 금액의 대표 청구는 운영자 수동이라 새 표 없음. 신청 취소가 없어 `academies` 의 해지 상태에 되돌리는 전이가 없다 | §10-9 · §14-4 |
| D20 임시 확정 | 위 §1~§13 의 「(추천)」 표시를 모두 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」으로 바꿨다 | 전체 |

---

## 15. 읽기 전용 화면이 읽는 테이블 — 「읽기 지도」 (2026-11-20)

**새 테이블을 만들지 않는다.** 이 절은 읽는 화면(S3-2 · SX-5 · S3-5)과 실 PG(S8-1)가 §2~§14 의 어느 테이블·칸을 읽거나 채우는지, 어떤 인덱스가 필요한지, 개인정보를 어떻게 가리는지를 한 곳에 모은 표다. 정의는 원래 절이 이긴다 — 여기서 칸이 **없다**고 확인된 것만 §15-4 에서 칸 제안으로 올렸다. 인덱스 이름 뒤 「추천」은 모두 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)이다. 규모 목표(설계 상한 10만명, 베타 1~10명)에서는 즉석 조회로 충분하다고 보고 집계 표를 만들지 않는다(12-6 과 같은 판단). 계약은 `03_contracts/02-catalog.md`(S3-2) · `16-ai-agent.md`(SX-5) · `18-after-payment-views.md`(S3-5) · `17-real-adapters.md`(S8-1).

### 15-1. S3-2(탐색·수업 상세·판매자 정보) — 회원 앱 M7·M8·C13A

| 슬라이스 | FR | 읽는 테이블·칸 | 필요한 인덱스 | 개인정보 · 노출 규칙 |
|---|---|---|---|---|
| S3-2 | FR-030(수업 검색) | `classes`(`genre`·`sub_genre`·`discipline`·`target_level`·`instructor_account_id`·`class_kind`·`status='published'`) → `class_offerings`(`status='open'`·`first_session_starts_at`) → `academies`(`status='active'`·`region_sido`·`region_gu`) · 강사 이름은 `staff_accounts.display_name` | 있음: `ix_classes_genre` · `ix_classes_academy_status` · `ix_offerings_start (status, first_session_starts_at)` · `ix_academies_region`. 추천: 강사 이름 부분 일치는 베타 규모에서 인덱스 없이 읽고, 학원 100곳을 넘으면 `pg_trgm` GIN(`staff_accounts.display_name`)을 검토 | 승인 전·입점 심사 전 학원의 수업은 나오지 않는다(S3-2 수용 ③). 강사는 `display_name` 만 — 연락처·본인확인 이름 칸은 읽지 않는다 |
| S3-2 | FR-033(시간대 필터) | `members.available_from`·`available_to` ↔ 판매 단위의 모든 `class_sessions.starts_at`·`ends_at`(KST 하루 시각으로 바꿔 비교) | 있음: `ix_sessions_offering_id`. 추천: 회차 수가 판매 단위당 수십 개라 별도 인덱스 없음 | 회원 본인의 가능 시간대만 읽는다(남의 값 아님) |
| S3-2 | FR-036a(정렬 5가지 — 추천순) | `members`(`base_genre`) · `member_interest_genres` · `member_regions` · `available_from~to` + 검색 조건 + FR-036a 의 인기 항. **거리·나이 항은 읽을 칸이 없다**(`academy_branches` 는 주소 글뿐 좌표 칸이 없고 수업에 연령 칸이 없다) | 있음(위와 같음). 추천: 정렬은 후보 수십 개를 앱에서 점수로 매기므로 인덱스 없음 | 추천 근거로 회원 프로필을 **서버 안에서만** 읽고 응답에 칸을 내리지 않는다. 임시 확정: 베타의 추천순은 「장르 일치 + 지역 일치 + 시간대 일치 + 인기」로 하고 거리·나이 항은 뺀다(거리는 지도 API 무료 구간 확인 뒤, 마스터 플랜 S3-2 열린 점) |
| S3-2 | FR-036a(검색순) | 수업별 검색 조회수 + 검색 뒤 신청으로 이어진 비율 — **원천 칸이 없다**(14 열린 점 ⑲ 와 같은 문제). 신청 쪽은 `orders.offering_id`·`created_at` 으로 셀 수 있다 | 추천: 조회 카운터(§15-4 ③)의 `(offering_id, viewed_hour)` | 조회 기록은 회원 id 를 남기되 응답에는 합계만 낸다 |
| S3-2 | FR-036a(인기순) | 최근 상세 클릭 60% + 조회 40% — 같은 조회 카운터(§15-4 ③)의 `source`(`detail_click`·`view`) | 위와 같음 | 합계만 |
| S3-2 | FR-036a(마감 임박순) | **신청 마감 일시 칸이 없다.** 임시 확정: 신청 마감 = `class_offerings.first_session_starts_at`(02 가 첫 회차 시작 전까지만 판매 상태로 보는 것과 같다) | 있음: `ix_offerings_start` | 개인정보 없음 |
| S3-2 | FR-036a(잔여석 임박순) | `seat_pools`(`capacity − held_count − confirmed_count`, 자리 종류 중 가장 적은 값) · 현장 인원은 S3-5.4 가 더한 뒤 같이 뺀다(§15-3) | 있음: `uq_seat_pools_offering_kind` | 신청 인원은 확정 수만 센다(결제 대기 제외, S3-2 수용 ②). 이름은 안 낸다 |
| S3-2 | FR-241(학원 결제·환불 정책 표시) | `classes.refund_notice_version_id` → `refund_notice_versions`(`body`·`version`·`notice_kind`) · `academies.card_payment_enabled` · 판매자 정보 `academies`(`business_name`·`representative_name`·`business_registration_number`·`mail_order_report_number`·`business_address`·`phone` — FR-248) | 있음: `uq_refund_notice_academy_version` | 법정 표시 의무 칸이라 **전부 공개**. 대표 개인 계좌·정산 계좌·본인확인 칸은 읽지 않는다. 공지가 없으면 `refundNotice: null`(주문 생성은 409 `NOTICE_MISSING`) |

### 15-2. SX-5(강사 수업 말로 찾기) — AI 에이전트 서버

에이전트는 **읽기 도구**로만 DB 를 본다(ADR-004 — DB 쓰기는 Next.js 하나, FR-214(AI 쓰기 금지)). 아래 읽기는 S3-2 의 검색과 **같은 조회 함수**를 부른다 — 에이전트가 따로 SQL 을 갖지 않는다.

| 슬라이스 | FR | 읽는 테이블·칸 | 필요한 인덱스 | 개인정보 · 노출 규칙 |
|---|---|---|---|---|
| SX-5 | FR-037a(강사·학원 이름으로 수업 찾기) | 강사 후보: `staff_accounts.display_name` + `role_grants(instructor, active)` + `instructor_profiles`(사진·활동 장르) + `instructor_affiliations(status='active')` → `academies.name`. 학원 후보: `academies.name`(`status='active'`). 수업 카드: S3-2 와 같은 칸 + `seat_pools` 남은 자리 | 있음: `ix_classes_instructor_status`. 추천: 이름 비슷한 말(오타·띄어쓰기)은 방식 미정이라 인덱스를 정하지 않는다(16 열린 점) | 후보 카드는 **사진·활동 장르·소속 학원 이름**만. 본명(`identity_name_*`)·연락처·사업자번호·정산 칸은 읽지 않는다. 승인 전 수업·입점 심사 전 학원 0건 |
| SX-5 | FR-030(수업 검색) | 위 S3-2 FR-030 행과 같다(장르·레벨·요일 조건) | 같음 | 같음 |
| SX-5 | FR-032(강사의 여러 학원 수업 조회) | `classes.instructor_account_id` 로 모은다(대타가 확정된 회차는 `class_sessions.instructor_account_id`) → `academies` | 있음: `ix_classes_instructor_status` · `ix_sessions_instructor_time` | 학원마다 구분만 하고 그 강사의 소속 해제된 학원 수업은 제외한다 |
| SX-5 | FR-033(시간대 필터) | S3-2 FR-033 과 같은 비교 + 요일(`class_sessions.starts_at` 의 KST 요일) | 같음 | 같음 |
| SX-5 | FR-037a(개인 레슨) | `private_lesson_slots.status='open'` 만(「레슨 모집」으로 보이는 시간) — 예약된 시간은 안 낸다 | 있음: `ex_pl_slots_instructor` | 수강생 정보는 읽지 않는다 |

### 15-3. S3-5(결제 뒤 대표·강사 쪽 보기)

대표·강사 화면이 결제를 **읽는** 곳이다. 주문에는 `academy_id` 칸이 없어 `orders.offering_id → class_offerings.class_id → classes.academy_id` 로 학원을 찾는다(§10 의 원장 `sale` 줄에는 `academy_id` 가 있지만 결제 직후에는 아직 줄이 없을 수 있어 원장을 쓰지 않는다).

| 슬라이스 | FR | 읽는 테이블·칸 | 필요한 인덱스 | 개인정보 가림 |
|---|---|---|---|---|
| S3-5 | FR-019a(회원 닉네임 표시) | `members.nickname`(**칸이 없다 — §15-4 ①**) | `members` PK 로 충분 | 강사·대표·다른 회원에게 **닉네임만**. 본명(`members.name`)은 내리지 않는다 |
| S3-5 | FR-168(연령대 표시) | `members.birth_date` 에서 서버가 `ageBandOf(birthDate, todayKst)` 로 **그때그때 계산**(칸을 저장하지 않는다) | — | 「20대」꼴 값(`20s`·`30s`·`40s`·`50s`·`60s_plus`)만. 만 나이·생년월일은 응답에 없다. 정확한 나이는 법정대리인 동의 판정 같은 시스템 판정에만 쓴다 |
| S3-5 | FR-079a(대표 주문·결제 목록) | `orders`(`status`·`total_amount`·`created_at`·`member_id`·`offering_id`) → `class_offerings` → `classes` · `payments`(`method`·`paid_at`·`due_at`) · `refund_requests`(처리 전 1건) · `order_events`(상세 이력) · `refunds`(환불 완료) | 추천: **`ix_orders_offering_created (offering_id, created_at DESC)`** · 있음: `ix_offerings_class_id` · `ix_classes_academy_id` · `ix_refund_requests_academy_due` | 닉네임만. 카드번호·가상계좌 번호·환불 계좌는 읽지 않는다(FR-299). 위임 강사는 이 경로 전체가 403 |
| S3-5 | FR-079(대표 회원 조회) | `orders`(결제 이력이 있는 회원 모으기) · `members`(`nickname`·`gender`·`birth_date`·`phone`) · `member_interest_genres` · `reservations` · `attendance_marks`(결석 예정 이력) · `inquiries`(건수·상태만) | 추천: **`ix_orders_member_offering (member_id, offering_id)`** | 목록·상세 모두 `phoneMasked`. 위임 강사에게는 결제·문의 칸이 **칸 자체로** 빠진다(W23). 전체 번호는 사유 기록 뒤에만(아래 FR-187 행) |
| S3-5 | FR-005(역할별 데이터 범위) · FR-187(연락처 마스킹) | 회차 명단: `reservations(status='confirmed')` + `orders(status IN ('paid','partially_refunded'))` + `members` + `attendance_marks` + `seat_pools`. 전체 연락처는 `members.phone` | 있음: `uq_reservations_member_offering_active` · `uq_attendance_session`(7-8). 추천: **`ix_reservations_offering_status (offering_id, status)`** | 결제 완료만 닉네임·가린 연락처. 단체 수업의 결제 대기는 **숫자만**(이름 없음). 1:1 개인 레슨은 결제 대기여도 닉네임(Q20). 전체 열람은 `audit_logs`(`member.contact_revealed`, 사유·열람자·맥락 — SC-025) 1행을 **같은 트랜잭션에서 먼저** 쓴다 |
| S3-5 | FR-106(현장 등록 반영) — **쓰기** | 회차별 현장 인원을 담을 칸이 **없다 — §15-4 ②**. 읽는 쪽은 `seat_pools`(정원·`held_count`·`confirmed_count`) + 그 회차의 현장 인원 | `session_seat_counters` PK `(session_id, seat_kind)` 로 충분 | 인원 숫자만 저장한다 — **이름·연락처 칸이 없다**(「이름 없이 인원만 기록돼요」). 누가 언제 바꿨는지는 `audit_logs`(`session.onsite_headcount_changed`). 정산·주문 테이블은 쓰지도 읽지도 않는다(O-07) |
| S3-5 | FR-107(역할 불균형 경보) | 전날 18:00 판정: `seat_pools.confirmed_count`(남·여) · `class_sessions.starts_at` · 알림 수신자: `class_sessions.instructor_account_id` + `academy_owners` | 있음: `ix_sessions_instructor_time` · `ix_notifications_staff_created`. 추천: **`ix_sessions_start_scheduled (starts_at) WHERE status='scheduled'`**(내일 회차만 뽑는 작업용 부분 인덱스) | 알림에 인원 차이·부족 성별만. 회원 이름 없음 |
| S3-5 | FR-064(강사 대시보드 집계) | 신청 인원 `seat_pools.confirmed_count` · 남은 자리 `capacity − held − confirmed` · 취소 `reservations.cancelled_at` · 요일 `class_offerings.schedule_rule` · 대기자 수 `waitlist_entries`(S4-4 가 만들기 전엔 `available:false`) · 관심 등록 수 — **FR-023(관심 강사·학원)이 베타 뒤(D22)라 원천이 없다** | 있음: `ix_classes_instructor_status` · `uq_seat_pools_offering_kind`. 추천: **`ix_reservations_cancelled (offering_id, cancelled_at) WHERE status='cancelled'`** | 숫자만. 회원 이름이 한 줄도 없다 |

### 15-4. 칸 제안 (읽기 지도를 만들다 확인된 빈칸 — 모두 임시 확정, 사후 확인)

| # | 어디에 | 제안 | 쓰는 곳 |
|---|---|---|---|
| ① | `members`(§2-2) | **정식 반영 완료(2026-11-20 마무리) — §2-2 `members` 줄에 칸이 있다. 아래는 근거 기록이다.** **`nickname text NOT NULL`**. 중복은 허용한다(FR-019a 가 정하지 않았다 — UNIQUE 를 걸지 않는다). 가입 때 입력(본명을 써도 된다)·시드는 이름에서 만든다. 「한 번 정하면 못 바꾼다 · 멤버십 회원은 1년에 1번」은 별도 칸 `nickname_changed_at timestamptz NULL` 이 필요하지만 변경 경로가 이 슬라이스 밖이라 칸만 예약한다 | S3-5 의 모든 명단·목록 · 12·14·15 계약이 이미 쓰는 `nickname` |
| ② | `session_seat_counters`(§9-4 의 표 — M4 의 S4-3 이 `substitute_count` 와 함께 정의) | **`onsite_count int NOT NULL DEFAULT 0` + `ck_session_seat_onsite >= 0`**. 이 표는 M3 의 S3-5.4 가 **먼저** 만들고(`session_id`, `seat_kind`, `onsite_count`), M4 의 **S4-3** 은 이미 있는 표에 `substitute_count` 칸만 더한다 — 먼저 만드는 마일스톤이 정의한다는 원칙(§14). 행은 회차 생성 때 자리 종류별로 `onsite_count = 0` 으로 만들어 둔다 | S3-5.4 · 02 의 `remaining` · 03 의 주문 생성(앞으로 올 회차 중 현장 인원 최댓값을 뺀다) |
| ③ | 수업 검색 조회 카운터(원천 표) | 14 열린 점 ⑲ 가 이미 요구한 **같은 표**를 한 번만 만든다 — `(member_id, offering_id, viewed_hour timestamptz, source)` · `source` ∈ `search_view`·`detail_click` · UNIQUE `(member_id, offering_id, viewed_hour, source)`(같은 회원 1시간 1번, `ON CONFLICT DO NOTHING`). 이 절은 표를 새로 정의하지 않고 **S3-2 검색순·인기순과 S6-2.9 순위판이 같은 표를 읽는다**는 약속만 한다 — 누가 만드는지는 S3-2 와 S6-2 가 조율한다 | S3-2 FR-036a(검색순·인기순) · 14 §4-4b |
| ④ | `audit_logs.action`(§7-9 표에 더함) | `member.contact_revealed` · `session.onsite_headcount_changed` | S3-5.3 · S3-5.4 |
| ⑤ | `notifications.kind`(§3·§7-9 에 더함) | `gender_imbalance`(직원 알림, 분류 `service`, `category='operations'`, `dedupe_key='imbalance:<sessionId>:<staffAccountId>'` — 받는 직원마다 1건, (추천안·사후 확인 2026-11-24) S3-5.10 이 마이그레이션 `20261124T0226_gender_imbalance_notification` 으로 kind CHECK 에 더함) | S3-5.5 의 FR-107 알림 |
| ⑥ | `payments`(§2-1) | 실 PG 의 영수증 링크: `receipt_academy_url text NULL` · `receipt_company_url text NULL` · `cash_receipt_issued boolean NOT NULL DEFAULT false`(아래 S8-1 행) | S8-1 · 17 §6 |
| ⑦ | `notifications.kind` · `audit_logs.action`(결석 쓰기 경로, 04 §5~§8) | kind: `absence_marked`(회원) · `absence_dispute_requested`(직원) · `absence_dispute_resolved`(회원) — 모두 `dedupe_key`(`absence:<markId>:marked` · `:dispute` · `:resolved`) 로 재처리를 막는다. action: `attendance.marked` · `attendance.cancelled` · `attendance.dispute_requested` · `attendance.dispute_resolved` · `attendance.session_locked`. 칸은 늘지 않는다(2026-11-20 임시 확정 — 추천안으로 진행, 사후 확인) | S3-4.3a · S3-4.3b · S3-4.3c |
| ⑧ | `notifications.kind`(회원, 입금 기한 임박 — 04 §10) | `payment_deadline_soon` — 주문 알림이라 기존 유니크 `uq_notifications_kind_order_recipient` 로 주문·회원마다 1건. `dedupe_key` 없음. 칸은 늘지 않는다(2026-11-23 임시 확정 — 추천안으로 진행, 사후 확인) | S3-4.4 |

### 15-5. S8-1(실 PG 연동) — 실 어댑터가 채우는 칸

가짜 PG(S3-3)가 이미 채우던 칸은 그대로고, 실 어댑터(포트원 V2)가 **새로 채우거나 의미가 생기는** 칸만 적는다. 17 §9 의 「공유하는 데이터 칸」을 이 절이 정식으로 받는다.

| 슬라이스 | FR | 테이블·칸 | 언제 누가 채우나 |
|---|---|---|---|
| S8-1 | FR-110(모든 유료 결제를 PG 한 경로로) | `payments.method`(4수단 `card`·`easy_pay`·`easy_transfer`·`virtual_account`, §14-2) · `gateway_payment_id`(우리가 PG 에 준 결제 id) · `gateway_payment_key`(PG 거래 id) · `status`(`ready`→`paid`…) · `pg_reported_amount`(PG 가 알려 준 금액 — 주문 금액과 다르면 FR-290) · `due_at`(결제 기한) | 주문 생성이 `gateway_payment_id`·`due_at` 을 쓰고, **웹훅·PG 조회**가 `gateway_payment_key`·`pg_reported_amount`·`status` 를 확정한다(PG 호출은 트랜잭션 밖, R-P3) |
| S8-1 | FR-110 | 가상계좌 칸 `virtual_account_bank_code`·`virtual_account_number`·`virtual_account_holder` | 가짜 PG 는 주문 생성 때 만들었지만 **실 PG 는 결제창이 열린 뒤 웹훅으로** 들어온다 — 그때까지 `NULL`(이미 NULL 허용) |
| S8-1 | FR-110 | `payments.gateway_cancel_pending boolean NOT NULL DEFAULT false`(17 §9) | PG 취소 호출이 시간 초과·모호했을 때 켜고 `sweep` 이 PG 에 다시 물어 끈다 |
| S8-1 | FR-110 | `payment_webhook_events`: `result` 에 `received` 추가 · `attempts int NOT NULL DEFAULT 1` · `last_seen_at timestamptz`(17 §9) | 실 웹훅이 다시 올 때마다 `attempts`·`last_seen_at` 만 갱신하고 `webhook-id` 유니크(`uq_webhook_events_webhook_id`)가 멱등을 지킨다 |
| S8-1 | FR-282c(영수증을 판매자별로 나눠 발급) | `payments.receipt_academy_url`(수업료 — 학원 명의) · `receipt_company_url`(예매 수수료 — 회사 명의, 예매 수수료가 있는 주문만) · `cash_receipt_issued`(§15-4 ⑥) | 결제 확정 직후 PG 가 발급한 링크를 **저장만** 한다(발급은 PG 몫). 아직 없으면 `NULL` 이고 `GET …/receipts` 가 `pending: true` 를 낸다. URL 은 로그에 남기지 않는다 |
| S8-1 | FR-282d(PG 대금을 학원 계좌에 직접 지급) | `academies.pg_seller_status`(`not_registered`·`pending`·`registered`·`failed`)·`pg_seller_id`(17 §9 — 하위 판매자 등록) · `payout_batches.mode='pg_payout'` · `payout_items.status`(`requested` — 모호한 응답은 `paid` 로 단정하지 않는다) | 입점 승인 트랜잭션이 **커밋된 뒤 밖에서** 등록을 부르고 결과를 쓴다. `PG_SELLER_REQUIRED=true` 인 환경에서 `registered` 가 아닌 학원은 주문 생성이 409 `SELLER_NOT_READY` |
| S8-1 | FR-110 · FR-282d | `audit_logs.action` 에 `sub_merchant.registered`·`.failed` · `payout.requested`(17 §9) | 등록·지급 호출 결과 |

SP-2(S8-1.1) 결과에 따라 달라질 수 있는 것: 지급대행 지원 여부(안 되면 `mode='manual'` 유지) · 판매자별 영수증 지원 여부(안 되면 `receipt_*_url` 이 하나만 차거나 비는 경우를 허용) · 가상계좌 번호가 오는 시점. 지원이 안 되는 것은 **미검증**으로 두고 표를 고치지 않는다.

### 15-6. FR-020(장르 4종 고정) — 계약에 없는 이유

FR-020 은 **값 집합**이지 경로가 아니다. 장르 4종(`dance_sport` · `argentine_tango` · `swing` · `salsa_bachata`)은 `admin-web/lib/domain/constants.ts` 의 `GENRES` 한 곳이 소유하고(§4.2 규칙: 계약 PSL enum 과 문자 단위로 같은지 단위 테스트 1개가 대조) §3 의 `genre` 줄이 DB CHECK 로 같은 값을 지키므로, 추가·수정·삭제 API 가 없다. 이 값을 쓰는 곳(`members.base_genre` · `member_interest_genres.genre` · `classes.genre`)은 각자 계약(01·11)에 이미 있다. 슬라이스는 S0-2(데이터 계약 1판·DB 테스트 바닥)가 만든다.
