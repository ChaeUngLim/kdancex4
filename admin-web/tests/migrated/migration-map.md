# 이관 대응표 — 옛 backend pytest → admin-web vitest

옛 `backend/tests/` 의 테스트 하나(pytest 매개변수 사례 하나)가 이 표의 한 행이다. 각 행은
새 TS 테스트 이름이나 폐기 사유 한 줄로 이어진다. 이 표가 빈 칸 없이 186행이 되면
`backend/` 를 지울 근거가 된다(plan R-P1(이관 회귀 누락) · T-M9-1(backend 삭제·DB 이름 회수)).

| 회차 | 옛 파일 | 행 | 채운 Task |
|---|---|---|---|
| M3분 | `test_refund_policy.py` 50 · `test_adapters.py` 33 | 83 | S0-4.1(주입 지점과 이관 대응표) · T-M3-6 — 2026-11-20 |
| M4분(서비스·스키마) | `test_cancellation_service.py` 36 · `test_schemas.py` 39 | 75 | S0-5.2(서비스·스키마 단위 테스트 이식) — 2026-11-20 |
| M4분(취소 API) | `test_cancel_api.py` 9 | 9 | S0-5.3(옛 취소 9시나리오 이식) — 2026-11-20 |
| M4분(나머지) | `test_admin_refund_policy.py` 18 · `test_health.py` 1 | 19 | S0-5.6(이관 대응표 마감·회귀 확인) — 2026-11-20 |

- 옛 ID 는 `cd backend && uv run pytest --collect-only -q` 출력 그대로다.
- TS 이름은 `cd admin-web && ./node_modules/.bin/vitest list --project unit` 출력에서 `[unit] tests/unit/`(M4분 서비스·스키마는 `[unit] tests/migrated/`) 를 뗀 것이다.
- 폐기 사유 근거: plan D8(Q11(슬롯 잠금 수단): Redis 슬롯 락 폐기) · `_workspace/03_contracts/06-ports.md` 표 「슬롯 락: 없음」.
- 이식하며 뜻이 바뀐 곳(예: `naive` 시각 거부 → Temporal `PlainDateTime` 거부)은 `_workspace/05_implementer_T-M3-2_summary.md`·`T-M3-4_summary.md`·`T-M3-5_summary.md` 에 적었다.
- 2026-11-24 M3-END.3(옛 AC 대응표 전체 재실행): S4-1.5(수단별 환불 실행 — 카드 부분 취소)가 가짜 PG 의 카드 환불을 받게 바꾸며 테스트 이름을 바꿔, 69~73행의 TS 이름을 지금 이름으로 고쳤다. 69·70행은 뜻이 바뀌어 「이식(뜻 바뀜)」으로 적었다(추천안·사후 확인 2026-11-24).

## M3분 (83행)

| # | 옛 pytest ID | 처리 | TS 테스트(`tests/unit/` 파일 > describe > 이름) 또는 폐기 사유 |
|---|---|---|---|
| 1 | `tests/test_refund_policy.py::test_exactly_24h_before_start_is_full_refund` | 이식 | refund-policy.test.ts > 24시간 경계 > test_exactly_24h_before_start_is_full_refund — 정확히 24:00:00 전은 전액(24h 티어보다 플랫폼 규칙 우선) |
| 2 | `tests/test_refund_policy.py::test_24h_boundary_is_inclusive_of_full_refund[23:59:59-before0-86399-5000-50000]` | 이식 | refund-policy.test.ts > 24시간 경계 > test_24h_boundary_is_inclusive_of_full_refund['23:59:59'] |
| 3 | `tests/test_refund_policy.py::test_24h_boundary_is_inclusive_of_full_refund[24:00:00-before1-86400-10000-100000]` | 이식 | refund-policy.test.ts > 24시간 경계 > test_24h_boundary_is_inclusive_of_full_refund['24:00:00'] |
| 4 | `tests/test_refund_policy.py::test_24h_boundary_is_inclusive_of_full_refund[24:00:01-before2-86401-10000-100000]` | 이식 | refund-policy.test.ts > 24시간 경계 > test_24h_boundary_is_inclusive_of_full_refund['24:00:01'] |
| 5 | `tests/test_refund_policy.py::test_sub_second_remainder_is_truncated_not_rounded_up` | 이식 | refund-policy.test.ts > 24시간 경계 > test_sub_second_remainder_is_truncated_not_rounded_up — 23:59:59.999999 남음은 24시간 미만 |
| 6 | `tests/test_refund_policy.py::test_far_future_is_full_refund_even_with_empty_tiers` | 이식 | refund-policy.test.ts > 24시간 경계 > test_far_future_is_full_refund_even_with_empty_tiers — 24시간 이상이면 빈 비율표도 전액 |
| 7 | `tests/test_refund_policy.py::test_timezone_differences_do_not_shift_the_boundary` | 이식 | refund-policy.test.ts > 24시간 경계 > test_timezone_differences_do_not_shift_the_boundary — KST 로 만든 now 도 같은 순간이면 같은 판정 |
| 8 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before0-24-5000]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['23h'] |
| 9 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before1-24-5000]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['12h+1s'] |
| 10 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before2-12-3000]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['12h'] |
| 11 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before3-12-3000]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['5h'] |
| 12 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before4-2-0]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['2h'] |
| 13 | `tests/test_refund_policy.py::test_tier_resolution_picks_smallest_covering_tier[before5-2-0]` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_resolution_picks_smallest_covering_tier['30m'] |
| 14 | `tests/test_refund_policy.py::test_tier_boundary_is_inclusive` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_boundary_is_inclusive — h == hours_before_start 이면 그 티어에 포함 |
| 15 | `tests/test_refund_policy.py::test_tier_order_does_not_matter` | 이식 | refund-policy.test.ts > 티어 해석 > test_tier_order_does_not_matter — 비율표 순서를 섞어도 결과가 같다 |
| 16 | `tests/test_refund_policy.py::test_empty_tiers_under_24h_is_zero_refund` | 이식 | refund-policy.test.ts > 티어 해석 > test_empty_tiers_under_24h_is_zero_refund — 24시간 이내 + 비율표 미설정은 0원 |
| 17 | `tests/test_refund_policy.py::test_no_covering_tier_is_zero_refund` | 이식 | refund-policy.test.ts > 티어 해석 > test_no_covering_tier_is_zero_refund — 덮는 티어가 없으면 0% |
| 18 | `tests/test_refund_policy.py::test_duplicate_tier_hours_uses_first_occurrence` | 이식 | refund-policy.test.ts > 티어 해석 > test_duplicate_tier_hours_uses_first_occurrence — hours 중복이면 앞의 것 |
| 19 | `tests/test_refund_policy.py::test_amount_is_rounded_up[100000-5000-50000]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[100000-5000] |
| 20 | `tests/test_refund_policy.py::test_amount_is_rounded_up[30000-3333-9999]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[30000-3333] |
| 21 | `tests/test_refund_policy.py::test_amount_is_rounded_up[1000-3333-334]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[1000-3333] |
| 22 | `tests/test_refund_policy.py::test_amount_is_rounded_up[1-1-1]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[1-1] |
| 23 | `tests/test_refund_policy.py::test_amount_is_rounded_up[1-9999-1]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[1-9999] |
| 24 | `tests/test_refund_policy.py::test_amount_is_rounded_up[999-5000-500]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[999-5000] |
| 25 | `tests/test_refund_policy.py::test_amount_is_rounded_up[12345-3333-4115]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[12345-3333] |
| 26 | `tests/test_refund_policy.py::test_amount_is_rounded_up[7-10-1]` | 이식 | refund-policy.test.ts > 금액 계산 > test_amount_is_rounded_up[7-10] |
| 27 | `tests/test_refund_policy.py::test_nonzero_rate_never_refunds_zero` | 이식 | refund-policy.test.ts > 금액 계산 > test_nonzero_rate_never_refunds_zero — 비율이 0 이 아니면 최소 1원 |
| 28 | `tests/test_refund_policy.py::test_amounts_are_plain_ints_not_floats` | 이식 | refund-policy.test.ts > 금액 계산 > test_amounts_are_plain_ints_not_floats — 금액·비율·시간 칸이 모두 안전 정수 |
| 29 | `tests/test_refund_policy.py::test_rate_extremes[0]` | 이식 | refund-policy.test.ts > 금액 계산 > test_rate_extremes[0] — 0bp 는 0원, 10000bp 는 전액 |
| 30 | `tests/test_refund_policy.py::test_rate_extremes[10000]` | 이식 | refund-policy.test.ts > 금액 계산 > test_rate_extremes[10000] — 0bp 는 0원, 10000bp 는 전액 |
| 31 | `tests/test_refund_policy.py::test_full_rate_never_exceeds_paid_amount` | 이식 | refund-policy.test.ts > 금액 계산 > test_full_rate_never_exceeds_paid_amount — 10000bp 도 결제액을 넘지 않는다 |
| 32 | `tests/test_refund_policy.py::test_zero_paid_amount_refunds_zero[before0]` | 이식 | refund-policy.test.ts > 금액 계산 > test_zero_paid_amount_refunds_zero['7d'] — 결제액 0원은 어느 구간도 0원 |
| 33 | `tests/test_refund_policy.py::test_zero_paid_amount_refunds_zero[before1]` | 이식 | refund-policy.test.ts > 금액 계산 > test_zero_paid_amount_refunds_zero['24h'] — 결제액 0원은 어느 구간도 0원 |
| 34 | `tests/test_refund_policy.py::test_zero_paid_amount_refunds_zero[before2]` | 이식 | refund-policy.test.ts > 금액 계산 > test_zero_paid_amount_refunds_zero['5h'] — 결제액 0원은 어느 구간도 0원 |
| 35 | `tests/test_refund_policy.py::test_zero_paid_amount_refunds_zero[before3]` | 이식 | refund-policy.test.ts > 금액 계산 > test_zero_paid_amount_refunds_zero['1m'] — 결제액 0원은 어느 구간도 0원 |
| 36 | `tests/test_refund_policy.py::test_after_start_is_zero_refund_without_raising` | 이식 | refund-policy.test.ts > 이미 시작한 수업 > test_after_start_is_zero_refund_without_raising — 시작 1시간 뒤도 예외 없이 0% |
| 37 | `tests/test_refund_policy.py::test_hours_before_start_is_floored` | 이식 | refund-policy.test.ts > 이미 시작한 수업 > test_hours_before_start_is_floored — 5시간 59분은 5시간 |
| 38 | `tests/test_refund_policy.py::test_naive_now_is_rejected` | 이식 | refund-policy.test.ts > 입력 검증 > test_naive_now_is_rejected — 시간대 없는 now(PlainDateTime) 거부 |
| 39 | `tests/test_refund_policy.py::test_naive_starts_at_is_rejected` | 이식 | refund-policy.test.ts > 입력 검증 > test_naive_starts_at_is_rejected — 시간대 없는 startsAt(PlainDateTime) 거부 |
| 40 | `tests/test_refund_policy.py::test_negative_paid_amount_is_rejected` | 이식 | refund-policy.test.ts > 입력 검증 > test_negative_paid_amount_is_rejected — 음수 결제액 거부 |
| 41 | `tests/test_refund_policy.py::test_malformed_tiers_raise[hours 키 없음]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['hours 키 없음'] — 잘못된 비율표는 터뜨린다 |
| 42 | `tests/test_refund_policy.py::test_malformed_tiers_raise[rate 키 없음]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['rate 키 없음'] — 잘못된 비율표는 터뜨린다 |
| 43 | `tests/test_refund_policy.py::test_malformed_tiers_raise[rate 범위 초과]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['rate 범위 초과'] — 잘못된 비율표는 터뜨린다 |
| 44 | `tests/test_refund_policy.py::test_malformed_tiers_raise[rate 음수]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['rate 음수'] — 잘못된 비율표는 터뜨린다 |
| 45 | `tests/test_refund_policy.py::test_malformed_tiers_raise[hours 0]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['hours 0'] — 잘못된 비율표는 터뜨린다 |
| 46 | `tests/test_refund_policy.py::test_malformed_tiers_raise[hours 범위 초과]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['hours 범위 초과'] — 잘못된 비율표는 터뜨린다 |
| 47 | `tests/test_refund_policy.py::test_malformed_tiers_raise[rate float]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['rate float'] — 잘못된 비율표는 터뜨린다 |
| 48 | `tests/test_refund_policy.py::test_malformed_tiers_raise[dict 아님]` | 이식 | refund-policy.test.ts > 입력 검증 > test_malformed_tiers_raise['dict 아님'] — 잘못된 비율표는 터뜨린다 |
| 49 | `tests/test_refund_policy.py::test_cancellation_reason_has_only_member_request` | 이식 | refund-policy.test.ts > 입력 검증 > test_cancellation_reason_has_only_member_request — refunds.reason 값 집합은 member_request 하나 |
| 50 | `tests/test_refund_policy.py::test_unknown_reason_is_rejected` | 이식 | refund-policy.test.ts > 입력 검증 > test_unknown_reason_is_rejected — 알 수 없는 사유(academy_fault) 거부 |
| 51 | `tests/test_adapters.py::test_refund_status_values_match_db_check_constraint` | 이식 | adapters-pg.test.ts > 포트원 상태 매핑 > 매핑 결과는 모두 REFUND_STATUSES 안의 값이다 [옛 test_refund_status_values_match_db_check_constraint] |
| 52 | `tests/test_adapters.py::test_portone_requested_maps_to_pending_not_failed` | 이식 | adapters-pg.test.ts > 포트원 상태 매핑 > 포트원 REQUESTED 는 실패가 아니라 pending 이다 [옛 test_portone_requested_maps_to_pending_not_failed] |
| 53 | `tests/test_adapters.py::test_parse_portone_succeeded_cancellation` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > SUCCEEDED 응답을 읽는다 [옛 test_parse_portone_succeeded_cancellation] |
| 54 | `tests/test_adapters.py::test_parse_portone_requested_cancellation_has_no_settlement_fields` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > REQUESTED 응답에는 정산 필드가 없다 [옛 test_parse_portone_requested_cancellation_has_no_settlement_fields] |
| 55 | `tests/test_adapters.py::test_parse_portone_unknown_status_fails_loudly` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > 모르는 상태는 성공으로 넘겨짚지 않고 실패로 떨어뜨린다 [옛 test_parse_portone_unknown_status_fails_loudly] |
| 56 | `tests/test_adapters.py::test_parse_portone_malformed_payload_fails` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > cancellation 이 없는 응답은 실패다 [옛 test_parse_portone_malformed_payload_fails] |
| 57 | `tests/test_adapters.py::test_refund_request_serializes_to_portone_field_names` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > 환불 요청을 포트원 필드 이름으로 바꾼다 [옛 test_refund_request_serializes_to_portone_field_names] |
| 58 | `tests/test_adapters.py::test_refund_account_includes_holder_phone_when_present` | 이식 | adapters-pg.test.ts > parsePortoneCancelResponse > 예금주 전화번호가 있으면 넣는다 [옛 test_refund_account_includes_holder_phone_when_present] |
| 59 | `tests/test_adapters.py::test_fake_gateway_satisfies_protocol` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 포트 타입을 만족한다 [옛 test_fake_gateway_satisfies_protocol] |
| 60 | `tests/test_adapters.py::test_fake_gateway_produces_succeeded` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 기본은 succeeded [옛 test_fake_gateway_produces_succeeded] |
| 61 | `tests/test_adapters.py::test_fake_gateway_produces_pending_via_pending_on` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > pendingOn 이면 pending [옛 test_fake_gateway_produces_pending_via_pending_on] |
| 62 | `tests/test_adapters.py::test_fake_gateway_produces_pending_via_force_pending` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > forcePending 이면 전부 pending [옛 test_fake_gateway_produces_pending_via_force_pending] |
| 63 | `tests/test_adapters.py::test_fake_gateway_produces_failed_via_fail_on` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > failOn 이면 failed [옛 test_fake_gateway_produces_failed_via_fail_on] |
| 64 | `tests/test_adapters.py::test_fake_gateway_is_deterministic` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 같은 입력이면 같은 식별자 [옛 test_fake_gateway_is_deterministic] |
| 65 | `tests/test_adapters.py::test_fake_gateway_ledger_makes_retry_idempotent` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 같은 멱등키 재시도는 원장의 첫 결과를 돌려준다 [옛 test_fake_gateway_ledger_makes_retry_idempotent] |
| 66 | `tests/test_adapters.py::test_fake_gateway_does_not_pin_failures_in_ledger` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 실패는 원장에 못박지 않는다 [옛 test_fake_gateway_does_not_pin_failures_in_ledger] |
| 67 | `tests/test_adapters.py::test_fake_gateway_settle_promotes_pending_to_succeeded` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > settleRefund 가 pending 을 succeeded 로 올린다 [옛 test_fake_gateway_settle_promotes_pending_to_succeeded] |
| 68 | `tests/test_adapters.py::test_fake_gateway_fails_without_refund_account` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 환불 계좌 없는 가상계좌 환불은 failed [옛 test_fake_gateway_fails_without_refund_account] |
| 69 | `tests/test_adapters.py::test_card_method_raises_unsupported_payment_method_error` | 이식(뜻 바뀜) | adapters-pg.test.ts > FakePaymentGateway.refund > 카드 환불은 부분 취소로 받는다 — S4-1.5(수단별 환불 실행). 옛 「카드 거부」(옛 test_card_method_raises_unsupported_payment_method_error)를 대신한다 — 포트는 이제 카드를 받고, 옛 「카드 → 미지원」은 cancellation.ts 가 포트를 부르기 전에 지킨다 |
| 70 | `tests/test_adapters.py::test_non_virtual_account_methods_are_rejected[card]` | 이식(뜻 바뀜) | adapters-pg.test.ts > FakePaymentGateway.refund > 카드 환불은 부분 취소로 받는다 — S4-1.5(수단별 환불 실행). 옛 「카드 거부」(옛 test_card_method_raises_unsupported_payment_method_error)를 대신한다 — S4-1.5 로 카드가 환불 수단이 되어 거부 사례에서 빠졌다. 거부 목록의 그 자리는 "easy_transfer" 가 받았다 |
| 71 | `tests/test_adapters.py::test_non_virtual_account_methods_are_rejected[kakaopay]` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 가상계좌·카드·간편결제가 아닌 수단 "kakaopay" 은 거부한다 [옛 test_non_virtual_account_methods_are_rejected] |
| 72 | `tests/test_adapters.py::test_non_virtual_account_methods_are_rejected[]` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 가상계좌·카드·간편결제가 아닌 수단 "" 은 거부한다 [옛 test_non_virtual_account_methods_are_rejected] |
| 73 | `tests/test_adapters.py::test_non_virtual_account_methods_are_rejected[VIRTUAL_ACCOUNT]` | 이식 | adapters-pg.test.ts > FakePaymentGateway.refund > 가상계좌·카드·간편결제가 아닌 수단 "VIRTUAL_ACCOUNT" 은 거부한다 [옛 test_non_virtual_account_methods_are_rejected] |
| 74 | `tests/test_adapters.py::test_fake_notification_sender_records_both_directions` | 이식 | adapters-identity-notification.test.ts > FakeNotificationSender — FR-114(결제 확인 앱 알림) · §4.10 · plan D7 > deliver 호출을 순서대로 기록하고 실제로는 아무것도 보내지 않는다 |
| 75 | `tests/test_adapters.py::test_fake_notification_sender_copies_payload` | 이식 | adapters-identity-notification.test.ts > FakeNotificationSender — FR-114(결제 확인 앱 알림) · §4.10 · plan D7 > 기록은 호출자 배열의 복사본이다 — 나중에 배열을 바꿔도 기록이 오염되지 않는다 |
| 76 | `tests/test_adapters.py::test_notification_events_cover_pending_separately_from_failure` | 이식 | adapters-identity-notification.test.ts > FakeNotificationSender — FR-114(결제 확인 앱 알림) · §4.10 · plan D7 > 환불 처리 중 알림이 환불 실패 알림과 따로 있다 |
| 77 | `tests/test_adapters.py::test_slot_lock_key_namespace_is_fixed` | 폐기 | plan D8(슬롯 락 폐기) — Redis 키 공간(`kdance:slot`)이 없어진다. 정원은 DB 만 권위를 갖는다 |
| 78 | `tests/test_adapters.py::test_redis_slot_lock_construction_opens_no_socket` | 폐기 | plan D8(슬롯 락 폐기) — `RedisSlotLock` 을 이관하지 않는다 |
| 79 | `tests/test_adapters.py::test_redis_slot_lock_release_returns_false_when_redis_is_down` | 폐기 | plan D8(슬롯 락 폐기) — `RedisSlotLock` 을 이관하지 않는다 — 지킬 대상(Redis 꺼짐 무예외)이 사라진다 |
| 80 | `tests/test_adapters.py::test_redis_slot_lock_release_swallows_client_errors` | 폐기 | plan D8(슬롯 락 폐기) — `RedisSlotLock` 을 이관하지 않는다 |
| 81 | `tests/test_adapters.py::test_redis_slot_lock_release_deletes_namespaced_key` | 폐기 | plan D8(슬롯 락 폐기) — `RedisSlotLock` 을 이관하지 않는다 |
| 82 | `tests/test_adapters.py::test_null_slot_lock_records_releases` | 폐기 | plan D8(슬롯 락 폐기) — `NullSlotLock` 이 없다. 포트가 없으니 가짜 구현도 없다(06-ports.md 표 「슬롯 락: 없음」) |
| 83 | `tests/test_adapters.py::test_slot_lock_implementations_satisfy_protocol` | 폐기 | plan D8(슬롯 락 폐기) — 슬롯 락 포트가 없다(06-ports.md 표 「슬롯 락: 없음」) |

## M4분 — 서비스·스키마 (75행) — S0-5.2(서비스·스키마 단위 테스트 이식) · 2026-11-20

옛 `test_cancellation_service.py` 36행 · `test_schemas.py` 39행. **이식 66행**(그중 뜻이 바뀐 곳 24행은 사유를 같은 칸에 적었다) · **폐기 9행**(슬롯 락 3 · 같은 출처 CORS 1 · 비율표 저장 규칙 5). 이식 66행이 TS 테스트 69개가 된다 — 「구상 어댑터 이름이 없다」 1행을 서비스 파일 4개로 나눠 돌리기 때문이다(65 + 4).
TS 테스트 위치는 `tests/migrated/`(vitest unit 프로젝트가 `tests/**/*.test.ts` 로 함께 돈다). 가짜 db 는 `tests/migrated/cancellation-stub-db.ts`.

| # | 옛 pytest ID | 처리 | TS 테스트(`tests/migrated/` 파일 > describe > 이름) 또는 폐기 사유 |
|---|---|---|---|
| 84 | `tests/test_cancellation_service.py::test_idempotency_key_is_deterministic_without_header` | 이식 | cancellation-service.test.ts > 멱등 키 > 헤더가 없으면 sha256("cancel:" + 예약 id) 이고 같은 예약은 늘 같은 키다 [옛 test_idempotency_key_is_deterministic_without_header] |
| 85 | `tests/test_cancellation_service.py::test_idempotency_key_differs_per_reservation` | 이식 | cancellation-service.test.ts > 멱등 키 > 예약이 다르면 키도 다르다 [옛 test_idempotency_key_differs_per_reservation] |
| 86 | `tests/test_cancellation_service.py::test_blank_header_falls_back_to_deterministic_key[]` | 이식 | cancellation-service.test.ts > 멱등 키 > 빈 문자열 이면 결정적 키로 돌아간다 [옛 test_blank_header_falls_back_to_deterministic_key] |
| 87 | `tests/test_cancellation_service.py::test_blank_header_falls_back_to_deterministic_key[   ]` | 이식 | cancellation-service.test.ts > 멱등 키 > 공백만 든 헤더도 결정적 키로 돌아가고, 공백이 낀 8자 미만 키는 400 이다 [옛 test_blank_header_falls_back_to_deterministic_key['   ']] |
| 88 | `tests/test_cancellation_service.py::test_blank_header_falls_back_to_deterministic_key[None]` | 이식 | cancellation-service.test.ts > 멱등 키 > 헤더 없음 이면 결정적 키로 돌아간다 [옛 test_blank_header_falls_back_to_deterministic_key] |
| 89 | `tests/test_cancellation_service.py::test_provided_header_wins_and_is_trimmed` | 이식(뜻 바뀜) | cancellation-service.test.ts > 멱등 키 > 보낸 키가 이기고 앞뒤 공백은 걷힌다. 200자를 넘는 키는 잘라 쓰지 않고 400 이다 [옛 test_provided_header_wins_and_is_trimmed] — 200자 초과 키를 자르지 않고 400(§4.9 8~200자) |
| 90 | `tests/test_cancellation_service.py::test_slot_lock_release_never_propagates[lock0]` | 폐기 | plan D8(슬롯 락 폐기) — `_release_slot_lock`·`NullSlotLock` 을 이관하지 않는다. 커밋 뒤 부수 작업이 환불을 되돌리지 않는다는 뜻은 cancellation-service.test.ts > 커밋 뒤 부수 작업 이 본다 |
| 91 | `tests/test_cancellation_service.py::test_slot_lock_release_never_propagates[lock1]` | 폐기 | plan D8(슬롯 락 폐기) — `_release_slot_lock`·`NullSlotLock` 을 이관하지 않는다. 커밋 뒤 부수 작업이 환불을 되돌리지 않는다는 뜻은 cancellation-service.test.ts > 커밋 뒤 부수 작업 이 본다 |
| 92 | `tests/test_cancellation_service.py::test_slot_lock_release_never_propagates[lock2]` | 폐기 | plan D8(슬롯 락 폐기) — `_release_slot_lock`·`NullSlotLock` 을 이관하지 않는다. 커밋 뒤 부수 작업이 환불을 되돌리지 않는다는 뜻은 cancellation-service.test.ts > 커밋 뒤 부수 작업 이 본다 |
| 93 | `tests/test_cancellation_service.py::test_service_does_not_branch_on_slot_lock_result` | 이식(뜻 바뀜) | cancellation-service.test.ts > 커밋 뒤 부수 작업 > 서비스에 슬롯 락이 없고, 알림 발송은 트랜잭션이 끝난 뒤에만 부르며 실패를 삼킨다 [옛 test_service_does_not_branch_on_slot_lock_result] — 슬롯 락이 없어져 커밋 뒤 알림 발송 위치·실패 삼킴으로 같은 뜻을 본다 |
| 94 | `tests/test_cancellation_service.py::test_notify_sends_to_both_audiences` | 이식(뜻 바뀜) | cancellation-service.test.ts > 알림 > 취소가 끝나면 회원 알림을 트랜잭션 안에 기록하고 커밋 뒤 그 id 를 발송한다 [옛 test_notify_sends_to_both_audiences] — 알림이 회원 행 기록 + 커밋 뒤 발송으로 바뀌었고 학원 관리자 방향은 계약 05 kind 에 없다 |
| 95 | `tests/test_cancellation_service.py::test_notify_failure_does_not_block_the_other_audience` | 이식 | cancellation-service.test.ts > 알림 > 발송이 터져도 취소 결과는 그대로 200 이다 [옛 test_notify_failure_does_not_block_the_other_audience] |
| 96 | `tests/test_cancellation_service.py::test_service_module_has_no_concrete_adapter_references` | 이식 | cancellation-service.test.ts > 포트 경계 > (서비스 파일 4개 각각) 는 가짜 구현 이름도 fakes/ import 도 없다 [옛 test_service_module_has_no_concrete_adapter_references] — cancellation.ts·cancellation-queries.ts·cancellation-preview.ts·order-cancel.ts |
| 97 | `tests/test_cancellation_service.py::test_deps_provide_protocol_satisfying_adapters` | 이식(뜻 바뀜) | cancellation-service.test.ts > 포트 경계 > 앱 쪽 취소 deps 는 포트 모양(refund·deliver)을 갖춘 구현을 준다 [옛 test_deps_provide_protocol_satisfying_adapters] — Protocol isinstance 대신 refund·deliver 함수가 있는지 본다 |
| 98 | `tests/test_cancellation_service.py::test_adapter_deps_are_process_singletons` | 이식 | cancellation-service.test.ts > 포트 경계 > 앱 쪽 취소 deps 의 포트는 프로세스에 하나다(가짜 PG 원장이 요청마다 새로 생기지 않는다) [옛 test_adapter_deps_are_process_singletons] |
| 99 | `tests/test_cancellation_service.py::test_current_user_id_reads_header` | 이식(뜻 바뀜) | cancellation-service.test.ts > 신원(세션) > 세션 회원을 신원으로 쓴다 — 본인 예약이면 미리보기가 200 이다 [옛 test_current_user_id_reads_header] — X-User-Id → 세션 회원 |
| 100 | `tests/test_cancellation_service.py::test_missing_header_is_401` | 이식(뜻 바뀜) | cancellation-service.test.ts > 신원(세션) > 세션이 없으면 401 UNAUTHENTICATED 이고 DB 를 읽지 않는다 [옛 test_missing_header_is_401] — X-User-Id 없음 → 세션 없음 401 |
| 101 | `tests/test_cancellation_service.py::test_malformed_header_is_400` | 이식(뜻 바뀜) | cancellation-service.test.ts > 신원(세션) > 모양이 틀린 id 는 500 이 아니라 404 다 [옛 test_malformed_header_is_400] — 신원 헤더가 없어져 경로 id 의 모양 오류(404)로 같은 뜻을 본다 |
| 102 | `tests/test_cancellation_service.py::test_temporary_auth_carries_the_f7_warning` | 이식(뜻 바뀜) | cancellation-service.test.ts > 신원(세션) > 취소 경로는 위조할 수 있는 X-User-Id 헤더를 읽지 않는다 [옛 test_temporary_auth_carries_the_f7_warning] — F7 경고 주석 대신 위조 가능한 헤더를 읽지 않는지 본다 |
| 103 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[ReservationNotFoundError-404]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > 없는 예약은 404 NOT_FOUND [옛 test_cancellation_errors_carry_http_status[ReservationNotFoundError-404]] |
| 104 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[ReservationOwnershipError-403]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > 남의 예약은 403 FORBIDDEN [옛 test_cancellation_errors_carry_http_status[ReservationOwnershipError-403]] |
| 105 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[ReservationAlreadyCancelledError-409]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > ReservationAlreadyCancelledError 자리 → 409 RESERVATION_ALREADY_CANCELLED [옛 test_cancellation_errors_carry_http_status] |
| 106 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[ReservationNotCancellableError-409]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > ReservationNotCancellableError 자리 → 409 RESERVATION_NOT_CANCELLABLE [옛 test_cancellation_errors_carry_http_status] |
| 107 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[ClassAlreadyStartedError-409]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > ClassAlreadyStartedError 자리 → 409 CLASS_ALREADY_STARTED [옛 test_cancellation_errors_carry_http_status] |
| 108 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[PaidPaymentNotFoundError-409]` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > 결제 원거래가 없으면 409 PAID_PAYMENT_NOT_FOUND [옛 test_cancellation_errors_carry_http_status[PaidPaymentNotFoundError-409]] |
| 109 | `tests/test_cancellation_service.py::test_cancellation_errors_carry_http_status[UnsupportedRefundMethodError-422]` | 이식(뜻 바뀜) | cancellation-service.test.ts > 취소 판정의 상태 코드 > 카드 환불 시도는 422 가 아니라 200 + failed(UNSUPPORTED_PAYMENT_METHOD) 다 [옛 test_cancellation_errors_carry_http_status[UnsupportedRefundMethodError-422]] — 카드 환불은 422 가 아니라 200 + failed(계약 05 단계 7) |
| 110 | `tests/test_cancellation_service.py::test_unsupported_method_is_caught_in_the_service` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > PG 의 미지원 수단 오류를 서비스가 잡아 실패 환불로 남기고, 예약은 그대로 둔다 [옛 test_unsupported_method_is_caught_in_the_service] |
| 111 | `tests/test_cancellation_service.py::test_pending_is_not_treated_as_failure` | 이식 | cancellation-service.test.ts > 취소 판정의 상태 코드 > pending 은 실패가 아니다 — 살아 있는 환불(succeeded·pending)이고 예약 취소·정원 복구까지 간다 [옛 test_pending_is_not_treated_as_failure] |
| 112 | `tests/test_cancellation_service.py::test_preview_block_reason[confirmed-172800-True-None]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > confirmed · 시작 172800초 전 · 결제 true → null [옛 test_preview_block_reason] |
| 113 | `tests/test_cancellation_service.py::test_preview_block_reason[held-172800-True-None]` | 이식(뜻 바뀜) | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > held · 시작 172800초 전 · 결제 true → USE_ORDER_CANCEL [옛 test_preview_block_reason] — held 는 None 이 아니라 USE_ORDER_CANCEL(계약 05 단계 4) |
| 114 | `tests/test_cancellation_service.py::test_preview_block_reason[cancelled-172800-True-reservation_already_cancelled]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > cancelled · 시작 172800초 전 · 결제 true → RESERVATION_ALREADY_CANCELLED [옛 test_preview_block_reason] |
| 115 | `tests/test_cancellation_service.py::test_preview_block_reason[expired-172800-True-reservation_not_cancellable]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > expired · 시작 172800초 전 · 결제 true → RESERVATION_NOT_CANCELLABLE [옛 test_preview_block_reason] |
| 116 | `tests/test_cancellation_service.py::test_preview_block_reason[confirmed-0-True-class_already_started]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > confirmed · 시작 0초 전 · 결제 true → CLASS_ALREADY_STARTED [옛 test_preview_block_reason] |
| 117 | `tests/test_cancellation_service.py::test_preview_block_reason[confirmed--60-True-class_already_started]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > confirmed · 시작 -60초 전 · 결제 true → CLASS_ALREADY_STARTED [옛 test_preview_block_reason] |
| 118 | `tests/test_cancellation_service.py::test_preview_block_reason[confirmed-172800-False-paid_payment_not_found]` | 이식 | cancellation-service.test.ts > blockReason(옛 _preview_block_reason) > confirmed · 시작 172800초 전 · 결제 false → PAID_PAYMENT_NOT_FOUND [옛 test_preview_block_reason] |
| 119 | `tests/test_cancellation_service.py::test_jsonable_flattens_uuid_and_datetime` | 이식 | cancellation-service.test.ts > 감사 기록 payload > refund_events payload 의 id 는 글자, 시각은 ISO 문자열, 빈 값은 null 이다 [옛 test_jsonable_flattens_uuid_and_datetime] |
| 120 | `tests/test_schemas.py::test_all_routes_are_mounted` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 라우트 배선 > 취소·미리보기·헬스 경로가 붙어 있고, 비율표 경로는 이관하지 않았다 [옛 test_all_routes_are_mounted] — FastAPI OpenAPI 대신 route.ts 모듈의 GET·POST 와 비율표 경로 부재를 본다 |
| 121 | `tests/test_schemas.py::test_health_still_works` | 이식 | cancellation-schemas.test.ts > 라우트 배선 > 경로를 붙여도 헬스는 그대로 200 {status: ok} 다 [옛 test_health_still_works] |
| 122 | `tests/test_schemas.py::test_cors_allows_admin_web_origins` | 폐기 | 같은 출처 — admin-web 화면과 API 가 한 Next.js 서버라 CORS 허용 대상이 없다(옛 FastAPI 는 3000 → 8000 이라 필요했다). 모르는 출처 차단은 다음 행이 본다 |
| 123 | `tests/test_schemas.py::test_cors_does_not_allow_arbitrary_origin` | 이식 | cancellation-schemas.test.ts > 라우트 배선 > 모르는 출처(Origin)에 CORS 허용 헤더를 붙이지 않는다 [옛 test_cors_does_not_allow_arbitrary_origin] |
| 124 | `tests/test_schemas.py::test_virtual_account_without_refund_account_is_rejected` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 가상계좌라고 했는데 계좌가 없으면 refundAccount 칸에서 실패한다 [옛 test_virtual_account_without_refund_account_is_rejected] |
| 125 | `tests/test_schemas.py::test_virtual_account_with_refund_account_is_accepted` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 가상계좌 + 계좌는 통과하고, 예금주 전화번호는 선택값이라 비어 있다 [옛 test_virtual_account_with_refund_account_is_accepted] |
| 126 | `tests/test_schemas.py::test_method_omitted_does_not_require_refund_account` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 결제수단을 안 보내면 계좌를 요구하지 않는다 — 결제수단의 권위는 DB 다 [옛 test_method_omitted_does_not_require_refund_account] |
| 127 | `tests/test_schemas.py::test_card_method_does_not_require_refund_account` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 카드는 계좌를 요구하지 않는다 [옛 test_card_method_does_not_require_refund_account] |
| 128 | `tests/test_schemas.py::test_unknown_field_is_rejected` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 오타 난 칸은 조용히 버리지 않고 거부한다 [옛 test_unknown_field_is_rejected] — 오타 사례가 snake_case(refund_account)로 바뀌었다(칸 이름이 camelCase) |
| 129 | `tests/test_schemas.py::test_invalid_refund_account_is_rejected[account0]` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 잘못된 환불 계좌(bankCode 빈칸)는 거부한다 [옛 test_invalid_refund_account_is_rejected] |
| 130 | `tests/test_schemas.py::test_invalid_refund_account_is_rejected[account1]` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 잘못된 환불 계좌(holderName 빈칸)는 거부한다 [옛 test_invalid_refund_account_is_rejected] |
| 131 | `tests/test_schemas.py::test_invalid_refund_account_is_rejected[account2]` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 잘못된 환불 계좌(accountNumber 65자(refunds 칸 상한 64))는 거부한다 [옛 test_invalid_refund_account_is_rejected] |
| 132 | `tests/test_schemas.py::test_invalid_refund_account_is_rejected[account3]` | 이식 | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 잘못된 환불 계좌(holderName 누락)는 거부한다 [옛 test_invalid_refund_account_is_rejected] |
| 133 | `tests/test_schemas.py::test_cancel_endpoint_returns_422_without_refund_account` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > API 경계에서도 422 이고, 환불 트랜잭션을 열기 전에 막힌다 [옛 test_cancel_endpoint_returns_422_without_refund_account] — 세션 회원을 읽으려고 members 만 한 번 조회한다 — 환불 트랜잭션은 열지 않는다 |
| 134 | `tests/test_schemas.py::test_cancel_endpoint_requires_user_header` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > cancelReservationRequestSchema(옛 CancelRequest) > 로그인하지 않으면 401 이고 DB 를 타지 않는다 [옛 test_cancel_endpoint_requires_user_header] — X-User-Id 없음 → 로그인 없음 401 |
| 135 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier0]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(hours 0(1 미만))는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 136 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier1]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(hours 721(720 초과))는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 137 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier2]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(rate -1)는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 138 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier3]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(rate 10001)는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 139 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier4]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(hours 문자열)는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 140 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier5]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(hours 소수)는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 141 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier6]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(hours bool(정수가 아니다))는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 142 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier7]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 잘못된 티어(rate 누락)는 거부한다 [옛 test_invalid_tier_is_rejected] — Pydantic 저장 스키마 대신 읽기 쪽 parseTier 가 거부 |
| 143 | `tests/test_schemas.py::test_invalid_tier_is_rejected[tier8]` | 폐기 | plan D12 · U4(비율표 GET/PUT·화면은 이관하지 않음) — 저장 경로(`RefundPolicyUpdate`)가 없다. 읽기 쪽 산정 함수는 정해진 두 칸만 읽고 모르는 칸(note)은 보지 않는다 |
| 144 | `tests/test_schemas.py::test_valid_tier_boundaries_are_accepted` | 이식 | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 경계값 hours 1·rate 0 과 hours 720·rate 10000 은 받는다 [옛 test_valid_tier_boundaries_are_accepted] |
| 145 | `tests/test_schemas.py::test_descending_tiers_are_accepted` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 내림차순 3줄 표를 받아 12시간 전에는 12시간 티어(3000bp)를 쓴다 [옛 test_descending_tiers_are_accepted] — to_jsonb(저장) 대신 산정 함수가 내림차순 표를 받는지 본다 |
| 146 | `tests/test_schemas.py::test_empty_tiers_are_accepted` | 이식 | cancellation-schemas.test.ts > 비율표 티어 검증(옛 RefundPolicyTier → calculateRefund 의 parseTier) > 빈 표는 유효한 정책이다 — 24시간 미만은 0% [옛 test_empty_tiers_are_accepted] |
| 147 | `tests/test_schemas.py::test_unsorted_tiers_are_rejected` | 폐기 | plan D12 · U4(비율표 GET/PUT·화면은 이관하지 않음) — 저장 경로(`RefundPolicyUpdate`)가 없다. 읽기 쪽 산정 함수는 순서에 기대지 않는다(refund-policy.test.ts > 티어 해석 > test_tier_order_does_not_matter) |
| 148 | `tests/test_schemas.py::test_duplicate_tier_hours_are_rejected` | 폐기 | plan D12 · U4(비율표 GET/PUT·화면은 이관하지 않음) — 저장 경로(`RefundPolicyUpdate`)가 없다. 읽기 쪽 산정 함수는 hours 가 겹치면 앞의 것을 쓴다(refund-policy.test.ts > 티어 해석 > test_duplicate_tier_hours_uses_first_occurrence) |
| 149 | `tests/test_schemas.py::test_too_many_tiers_are_rejected` | 폐기 | plan D12 · U4(비율표 GET/PUT·화면은 이관하지 않음) — 저장 경로(`RefundPolicyUpdate`)가 없다. 읽기 쪽 산정 함수는 개수 상한(24줄)을 따로 두지 않는다 |
| 150 | `tests/test_schemas.py::test_body_must_be_wrapped_in_refund_policy_tiers_key` | 폐기 | plan D12 · U4(비율표 GET/PUT·화면은 이관하지 않음) — 저장 경로(`RefundPolicyUpdate`)가 없다. 읽기 쪽 산정 함수는 PUT 본문 키(`refund_policy_tiers`)를 받을 경로가 없다 |
| 151 | `tests/test_schemas.py::test_preview_exposes_payment_method_and_paid_amount` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 미리보기는 앱이 환불 계좌 칸을 띄울지 정하는 결제수단·결제액을 싣는다 [옛 test_preview_exposes_payment_method_and_paid_amount] |
| 152 | `tests/test_schemas.py::test_preview_returns_200_when_not_cancellable` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 취소할 수 없어도 오류가 아니라 200 + 사유다 [옛 test_preview_returns_200_when_not_cancellable] |
| 153 | `tests/test_schemas.py::test_domain_errors_keep_their_status_code[error0-404]` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 없는 예약 → 404 [옛 test_domain_errors_keep_their_status_code[error0-404]] |
| 154 | `tests/test_schemas.py::test_domain_errors_keep_their_status_code[error1-403]` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 남의 예약 → 403 [옛 test_domain_errors_keep_their_status_code[error1-403]] |
| 155 | `tests/test_schemas.py::test_domain_errors_keep_their_status_code[error2-409]` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 시작한 수업 취소 → 409 CLASS_ALREADY_STARTED [옛 test_domain_errors_keep_their_status_code[error2-409]] |
| 156 | `tests/test_schemas.py::test_domain_errors_keep_their_status_code[error3-422]` | 이식(뜻 바뀜) | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 카드 환불 → 422 가 아니라 200 + failed 다(계약 05 단계 7) [옛 test_domain_errors_keep_their_status_code[error3-422]] — 카드 환불은 422 가 아니라 200 + failed(계약 05 단계 7) |
| 157 | `tests/test_schemas.py::test_broken_refund_policy_becomes_422_not_500` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > 망가진 비율표는 500 이 아니라 422 이고 내부 값(99999)을 보이지 않는다 [옛 test_broken_refund_policy_becomes_422_not_500] |
| 158 | `tests/test_schemas.py::test_cancel_returns_200_on_gateway_failure` | 이식 | cancellation-schemas.test.ts > 미리보기·취소 라우트의 응답 > PG 환불 실패는 200 + status failed 와 실패 사유다 [옛 test_cancel_returns_200_on_gateway_failure] |

## M4분 — 취소 API 9시나리오 (9행) — S0-5.3(옛 취소 9시나리오 이식) · 2026-11-20

TS 이름은 `./node_modules/.bin/vitest list --project db tests/migrated/cancel-api-scenarios.db.test.ts` 출력에서 `[db] tests/migrated/` 를 뗀 것이다(DB 테스트).

| # | 옛 pytest ID | 처리 | TS 테스트(`tests/migrated/` 파일 > describe > 이름) 또는 폐기 사유 |
|---|---|---|---|
| 159 | `tests/test_cancel_api.py::test_cancel_succeeds_and_restores_slot` | 이식(뜻 바뀜) | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 정상 취소 — 200 + 전액 환불 + 자리 반납, 감사 3종, PG 1회 [옛 test_cancel_succeeds_and_restores_slot] — 옛 reserved_count −1 → seat_pools.confirmed_count −1(자리 묶음 확정 수) |
| 160 | `tests/test_cancel_api.py::test_cancel_with_pending_gateway_still_restores_slot` | 이식 | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > PG 가 pending 이어도 자리는 반납되고 예약은 취소 확정된다 [옛 test_cancel_with_pending_gateway_still_restores_slot] |
| 161 | `tests/test_cancel_api.py::test_cancel_other_users_reservation_is_forbidden` | 이식 | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 남의 예약은 403 이고(404 로 감추지 않는다) 아무것도 쓰지 않는다 [옛 test_cancel_other_users_reservation_is_forbidden] |
| 162 | `tests/test_cancel_api.py::test_cancel_unknown_reservation_returns_404` | 이식 | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 없는 예약은 404 이고 PG 를 부르지 않는다 [옛 test_cancel_unknown_reservation_returns_404] |
| 163 | `tests/test_cancel_api.py::test_cancel_already_cancelled_reservation_returns_409` | 이식(뜻 바뀜) | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 환불 기록 없이 이미 취소된 예약은 409 RESERVATION_ALREADY_CANCELLED [옛 test_cancel_already_cancelled_reservation_returns_409] — 옛 소문자 코드 → RESERVATION_ALREADY_CANCELLED(§4.8 대문자) |
| 164 | `tests/test_cancel_api.py::test_cancel_after_class_started_returns_409` | 이식(뜻 바뀜) | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 이미 시작한 수업은 409 CLASS_ALREADY_STARTED — 자리도 돈도 그대로 [옛 test_cancel_after_class_started_returns_409] — 옛 소문자 코드 → CLASS_ALREADY_STARTED(§4.8 대문자) |
| 165 | `tests/test_cancel_api.py::test_duplicate_cancel_request_is_replayed` | 이식 | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 두 번째 요청은 409 가 아니라 200 + 기존 결과 재생, 자리는 한 번만 반납 [옛 test_duplicate_cancel_request_is_replayed] |
| 166 | `tests/test_cancel_api.py::test_gateway_failure_records_reason_and_keeps_reservation` | 이식 | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > PG 환불 실패 — 200 + failed, 사유는 응답과 DB 에 남고 예약·자리는 그대로 [옛 test_gateway_failure_records_reason_and_keeps_reservation] |
| 167 | `tests/test_cancel_api.py::test_concurrent_cancel_requests_refund_only_once` | 이식(뜻 바뀜) | cancel-api-scenarios.db.test.ts > 옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py) > 같은 예약 취소 2건이 동시에 와도 환불은 1회 — 둘 다 200, 하나만 새로 만들고 하나만 자리 반납 [옛 test_concurrent_cancel_requests_refund_only_once] — 스레드 2개 + Barrier → Promise.all + 연결 8개 풀(서로 다른 연결로 행 잠금 경합) |

## M4분 — 나머지 (19행) — S0-5.6(이관 대응표 마감·회귀 확인) · 2026-11-20

옛 `test_admin_refund_policy.py` 18행은 **폐기**(인증 없는 비율표 관리 API 를 새 스택으로 옮기지 않는다 — plan D12·U4), `test_health.py` 1행은 **이식**(`tests/unit/health.test.ts`, 계약 §1(헬스)).
TS 이름은 `./node_modules/.bin/vitest list --project unit tests/unit/health.test.ts` 출력에서 `[unit] tests/unit/` 를 뗀 것이다.

| # | 옛 pytest ID | 처리 | TS 테스트(`tests/unit/` 파일 > 이름) 또는 폐기 사유 |
|---|---|---|---|
| 168 | `tests/test_admin_refund_policy.py::test_get_returns_stored_tiers` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 저장된 비율표 조회 경로가 없어진다. 칸 `academies.refund_policy_tiers` 는 남고 값은 시드가 넣는다 |
| 169 | `tests/test_admin_refund_policy.py::test_get_unknown_academy_returns_404` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 조회 경로가 없어 404 판정도 없다 |
| 170 | `tests/test_admin_refund_policy.py::test_get_empty_policy_is_not_an_error` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 조회 경로가 없다. 빈 비율표의 산정(24시간 이내 0원)은 #16 이 지킨다 |
| 171 | `tests/test_admin_refund_policy.py::test_put_replaces_whole_table_and_persists` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없다. 대표 환불은 S4-1 에서 금액 입력(FR-293(대표 환불 입력))으로 바뀐다 |
| 172 | `tests/test_admin_refund_policy.py::test_put_empty_list_clears_the_table` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없다 |
| 173 | `tests/test_admin_refund_policy.py::test_put_unknown_academy_returns_404` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 404 판정도 없다 |
| 174 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[ascending_order]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(ascending_order) 422 도 없다 |
| 175 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[duplicate_hours]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(duplicate_hours) 422 도 없다 |
| 176 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[bp_above_max]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(bp_above_max) 422 도 없다 |
| 177 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[bp_negative]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(bp_negative) 422 도 없다 |
| 178 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[hours_zero]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(hours_zero) 422 도 없다 |
| 179 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[hours_above_max]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(hours_above_max) 422 도 없다 |
| 180 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[hours_as_string]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(hours_as_string) 422 도 없다 |
| 181 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[bp_as_float]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(bp_as_float) 422 도 없다 |
| 182 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[unknown_field_in_tier]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(unknown_field_in_tier) 422 도 없다 |
| 183 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[missing_refund_rate_bp]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(missing_refund_rate_bp) 422 도 없다 |
| 184 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[bare_array_body]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(bare_array_body) 422 도 없다 |
| 185 | `tests/test_admin_refund_policy.py::test_put_rejects_invalid_policy[too_many_tiers]` | 폐기 | plan D12·U4(비율표 GET/PUT 이관 안 함, 2026-11-06 사용자 확정) — 비율표 저장 경로가 없어 입력 검증(too_many_tiers) 422 도 없다 |
| 186 | `tests/test_health.py::test_health_returns_ok` | 이식 | health.test.ts > 헬스 경로는 200 과 {status: ok} 를 돌려준다 [옛 test_health_returns_ok] |
