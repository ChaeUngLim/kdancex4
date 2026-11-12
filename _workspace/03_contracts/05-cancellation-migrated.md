# API 계약 — 이관하는 취소 API (S0-M4(취소 API 이관))

공통 규칙은 `README.md`. 원본은 `backend/app/routers/reservations.py` · `backend/app/services/cancellation.py`(SCH-05(취소 오케스트레이션)) · `backend/app/services/refund_policy.py`(SCH-03(환불액 산정)).

**원칙: 동작 보존 이관.** 단계·상태 코드·멱등 규칙은 그대로 옮긴다. 바뀌는 것은 아래 「바뀌는 점」 표뿐이다. 이관된 동작과 spec FR-295(대표가 환불 실행)의 정렬은 SCH-32(정규 과정 환불)·SCH-33(이벤트형 취소)에서 한다(plan U4 — 2026-11-06 사용자 확정).

## 경로

| 옛 경로(FastAPI) | 새 경로 |
|---|---|
| `GET /reservations/{id}/cancellation-preview` | `GET /api/reservations/{id}/cancellation-preview` |
| `POST /reservations/{id}/cancel` | `POST /api/reservations/{id}/cancel` |
| `GET·PUT /admin/academies/{id}/refund-policy` | **이관하지 않는다**(폐기 결정 화면의 API — plan D12, U4 2026-11-06 사용자 확정) |

요청·응답 본문의 칸 이름은 옛 Pydantic 스키마(`backend/app/schemas/`)를 camelCase 로 바꾼 것이다. 정확한 칸 목록은 Phase 5 가 옛 스키마에서 1:1 로 옮기고, zod 스키마 테스트가 옛 `test_schemas.py` 의 해당 사례를 이식한다.

## 단계(옛 11단계 → 새 구현)

| 옛 단계 | 새 구현 |
|---|---|
| 1 `SELECT … FOR UPDATE`(reservations) | raw 레인 `SELECT … FOR UPDATE` — **R2(Prisma 8 트랜잭션·행 잠금 미검증) 스파이크 결과에 따른다**(research S-2). 실패 시 대체: 같은 트랜잭션에서 `pg_advisory_xact_lock` |
| 2 소유권(남의 예약 403) | 같음. 신원은 세션 회원 |
| 3 멱등 재생(상태 검사보다 먼저) | 같음 |
| 4 상태 검사(`cancelled` 409, 시작 뒤 409) | 같음. **시작 시각 = 판매 단위 첫 회차 시작**. `held` 예약은 409 `USE_ORDER_CANCEL`(옛 코드도 결제 원거래가 없어 409 였다 — 코드 이름만 새로) |
| 5 결제 원거래 → `calculateRefund` | 원거래 판정을 `paid_at IS NOT NULL` → `payments.status='paid'` 로 |
| 6 Refund INSERT(SAVEPOINT) | `INSERT … ON CONFLICT DO NOTHING RETURNING` → 없으면 이긴 행으로 수렴 |
| 7 PG 환불 호출 | `PaymentGatewayPort.refund` 그대로(카드 → 미지원 → failed) |
| 8 예약 `cancelled` · 주문 `refunded` · 정원 −1 | **정원 −1 은 `seat_pools.confirmed_count`**(예약의 seat_pool_id) + **calendar_entries 삭제**(신규) |
| 9~10 refund_events · 커밋 | 같음 + **알림을 `notifications` 에 트랜잭션 안에서 기록**(kind `reservation_cancelled`·`refund_pending`·`refund_failed`) |
| 11 커밋 뒤 슬롯 락 해제 + 알림 발송 | **슬롯 락 해제 삭제**(Redis 슬롯 락 폐기 — plan D8). 발송 포트 호출은 커밋 뒤에 남긴다(Fake 는 기록만) |

## 바뀌는 점(요약)

| 항목 | 옛 | 새 |
|---|---|---|
| 신원 | `X-User-Id` 헤더 | 세션 |
| 오류 본문 | `{"detail": …}` | `{"detail": …, "code": …}`(§4.8) |
| 정원 | `class_schedules.reserved_count` | `seat_pools.confirmed_count` |
| 슬롯 락 | Redis `DEL kdance:slot:{id}` | 없음 |
| 알림 | 커밋 뒤 호출만 | 기록은 트랜잭션 안, 발송은 커밋 뒤 |
| 정산 `hold` 행 | (없었음) | **건드리지 않는다** — 조정은 SCH-31(정산 원장). 위험 R-P5 |

## 상태 코드(옛 테스트 9개가 지키던 것 — 그대로)

200 성공 · 200 중복 요청 재생 · 403 남의 예약 · 404 없음 · 409 이미 취소 · 409 시작 뒤 · PG 실패 시 예약 유지 · `pending` 환불도 정원 복구 · 동시 취소 2건 → 환불 1회.
