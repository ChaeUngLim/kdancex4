# 05 구현 보고 — T-M3-2(환불액 산정 이식)

슬라이스 S0-M3(순수 로직 이식) · SCH-03(환불액 산정) 이식 · 공유 계약 §4.3(산정 함수 시그니처)·§4.4(환불 비율표 JSONB 형태)

## 변경 파일

| 파일 | 내용 |
|---|---|
| `admin-web/lib/domain/refund-policy.ts` (신규) | `calculateRefund` 와 상수 4개(`FULL_REFUND_THRESHOLD_SECONDS`·`BASIS_POINT_DENOMINATOR`·`FULL_REFUND_RATE_BP`·`NO_REFUND_RATE_BP`), 타입 `RefundPolicyTier`(§4.4 snake_case)·`RefundCalculationInput`·`RefundCalculation`. 금액은 T-M3-1 의 `ceilMulDiv`(BigInt) 를 재사용했고, 사유 값 집합은 `constants.ts` 의 `REFUND_REASONS` 를 쓴다 |
| `admin-web/tests/unit/refund-policy.test.ts` (신규) | 옛 사례 50개를 1:1 로 옮겼다. 파라미터 사례는 `test.each` 로 옮겨 옛 사례 하나가 vitest 테스트 하나다 |

T-M3-1 파일(`money.ts`·`constants.ts`·`time.ts`), `package.json`·lock, vitest 설정은 건드리지 않았다. import 는 상대 경로다.

## 실행 결과

```
$ cd admin-web && npx vitest run tests/unit/refund-policy.test.ts
 RUN  v4.1.11 /home/user/kdance/admin-web
 Test Files  1 passed (1)
      Tests  50 passed (50)
```

TDD 순서: 테스트를 먼저 쓰고 돌려 실패(모듈 없음, `Test Files 1 failed`)를 확인한 다음 구현했다.

```
$ npx tsc --noEmit -p .
tests/unit/adapters-identity-notification.test.ts(17,8): error TS2307: Cannot find module '../../lib/server/fakes/fake-identity' ...
exit 2
```

**exit 0 은 확인하지 못했다.** 남은 오류 1건은 병렬로 진행 중인 T-M3-5(본인확인·알림 포트와 가짜 구현)의 테스트 파일이 아직 없는 구현 파일을 import 해서 난다. `refund-policy` 가 들어간 오류는 0건이다(`grep -c refund-policy` → 0). T-M3-5 가 끝난 뒤 다시 돌려야 한다.

## 옛 테스트 50개 → TS 테스트 대응 (T-M3-6(주입 지점·이관 대응표 M3분) 재료)

vitest 테스트 이름이 옛 pytest 함수 이름으로 시작한다. 파라미터 사례는 `[레이블]` 이 붙는다.

| # | 옛 pytest (`backend/tests/test_refund_policy.py`) | 사례 수 | TS 테스트 이름 (`tests/unit/refund-policy.test.ts`) |
|---|---|---|---|
| 1 | `test_exactly_24h_before_start_is_full_refund` | 1 | 같은 이름 |
| 2 | `test_24h_boundary_is_inclusive_of_full_refund` | 3 | `[23:59:59]` `[24:00:00]` `[24:00:01]` |
| 3 | `test_sub_second_remainder_is_truncated_not_rounded_up` | 1 | 같은 이름 |
| 4 | `test_far_future_is_full_refund_even_with_empty_tiers` | 1 | 같은 이름 |
| 5 | `test_timezone_differences_do_not_shift_the_boundary` | 1 | 같은 이름 |
| 6 | `test_tier_resolution_picks_smallest_covering_tier` | 6 | `[23h]` `[12h+1s]` `[12h]` `[5h]` `[2h]` `[30m]` |
| 7 | `test_tier_boundary_is_inclusive` | 1 | 같은 이름 |
| 8 | `test_tier_order_does_not_matter` | 1 | 같은 이름 |
| 9 | `test_empty_tiers_under_24h_is_zero_refund` | 1 | 같은 이름 |
| 10 | `test_no_covering_tier_is_zero_refund` | 1 | 같은 이름 |
| 11 | `test_duplicate_tier_hours_uses_first_occurrence` | 1 | 같은 이름 |
| 12 | `test_amount_is_rounded_up` | 8 | `[100000-5000]` `[30000-3333]` `[1000-3333]` `[1-1]` `[1-9999]` `[999-5000]` `[12345-3333]` `[7-10]` |
| 13 | `test_nonzero_rate_never_refunds_zero` | 1 | 같은 이름 |
| 14 | `test_amounts_are_plain_ints_not_floats` | 1 | 같은 이름 (`type is int` → `Number.isSafeInteger`) |
| 15 | `test_rate_extremes` | 2 | `[0]` `[10000]` |
| 16 | `test_full_rate_never_exceeds_paid_amount` | 1 | 같은 이름 |
| 17 | `test_zero_paid_amount_refunds_zero` | 4 | `[7d]` `[24h]` `[5h]` `[1m]` |
| 18 | `test_after_start_is_zero_refund_without_raising` | 1 | 같은 이름 |
| 19 | `test_hours_before_start_is_floored` | 1 | 같은 이름 |
| 20 | `test_naive_now_is_rejected` | 1 | 같은 이름 (의미 변경 — 아래 ②) |
| 21 | `test_naive_starts_at_is_rejected` | 1 | 같은 이름 (의미 변경 — 아래 ②) |
| 22 | `test_negative_paid_amount_is_rejected` | 1 | 같은 이름 |
| 23 | `test_malformed_tiers_raise` | 8 | `[hours 키 없음]` `[rate 키 없음]` `[rate 범위 초과]` `[rate 음수]` `[hours 0]` `[hours 범위 초과]` `[rate float]` `[dict 아님]` |
| 24 | `test_cancellation_reason_has_only_member_request` | 1 | 같은 이름 (`CancellationReason` → `REFUND_REASONS`) |
| 25 | `test_unknown_reason_is_rejected` | 1 | 같은 이름 |
| | **합계** | **50** | **50** |

## Python 과 달라진 곳

1. **§4.3 시그니처보다 넓다.** 입력에 `reason?`(생략 시 `member_request`)을 더했고, 결과에 `secondsBeforeStart`·`appliedTierHours` 를 더했다. 둘 다 옛 동작과 옛 테스트 25번(`unknown_reason`)·1번(`applied_tier_hours`)을 살리려는 것이다. §4.3 의 세 칸은 이름 그대로 들어 있어 계약을 깨지는 않는다. 계약 문서를 고칠지는 오케스트레이터가 정한다.
2. **tz-naive 거부(20·21번)는 형태가 바뀌었다.** `Temporal.Instant` 는 언제나 절대 순간이라 naive 값이 있을 수 없다. TS 에서 남는 위험은 시간대 없는 `PlainDateTime` 을 타입 단언으로 흘려 넣는 경우뿐이어서, `instanceof Temporal.Instant` 가 아니면 `TypeError` 를 던지게 했다. 테스트도 그 경우로 바꿨다.
3. **`rate float`(23번) 사례 값이 바뀌었다.** Python 은 `50.0`(float) 을 거부하지만 JS 는 `50.0 === 50` 이라 둘을 가를 수 없다. JSON 에서 `"refund_rate_bp": 50.0` 을 읽으면 JS 에서는 정수 50 이 되어 **통과한다** — 옛 동작과 다른 점이다. 테스트는 정수가 아닌 `50.5` 로 옮겼다.
4. **정수 나눗셈.** 남은 초는 `epochNanoseconds`(BigInt) 차이를 10⁹ 로 나눠 구한다. BigInt 나눗셈은 0 쪽으로 버리므로 음수일 때 1을 빼 Python `//`(음의 무한대 쪽 버림)과 맞췄다. `hoursBeforeStart` 도 같은 바닥 나눗셈이다. 시작 1시간 뒤 → -3600초 / -1시간으로 옛 테스트와 같다. 초 미만이 남는 음수 사례(시작 0.5초 뒤 → -1초)는 옛 테스트에도 없어서 따로 테스트하지 않았다.
5. **올림.** `ceilMulDiv`(BigInt) 를 쓰고 결과를 `Math.min` 으로 결제액 이하로 막는다. 부동소수 경로는 없다. 입력·결과가 안전 정수(2^53) 범위를 벗어나면 RangeError 다(Python 은 범위가 없다).
6. **시각 정밀도.** Python `datetime` 은 마이크로초, Temporal 은 나노초다. 3번 사례(23:59:59.999999)는 같은 결과를 낸다.
7. **오류 타입.** Python 은 모두 `ValueError` 였다. TS 는 타입 문제면 `TypeError`, 범위·값 문제면 `RangeError` 로 나눴다(`money.ts` 의 RangeError 관례에 맞춤). 테스트는 메시지 일부(`0 이상`·`Temporal.Instant`·`reason`)나 `toThrow()` 로 확인한다. 호출 쪽이 `ValueError` 하나만 잡던 코드를 옮길 때는 두 타입을 다 잡아야 한다.
8. **`academies.refund_policy_tiers` 의 bool.** Python 은 `True` 를 따로 걸러야 했지만 JS 는 `typeof` 검사가 boolean 을 바로 거른다. 동작은 같다.

## 차단 · 미해결

- `tsc --noEmit` exit 0 은 T-M3-5 파일이 생긴 뒤 다시 확인해야 한다(위 실행 결과 참고).
- 계약 §4.3 에 `reason`·추가 결과 칸을 반영할지(위 1번)는 결정이 필요하다.
- 커밋하지 않았다.
