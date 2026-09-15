"""``app.services.refund_policy.calculate_refund`` 단위 테스트.

DB·네트워크·픽스처 없이 돈다. ``conftest.py``를 만들지 않는 이유는 이 테스트가
순수 함수만 건드려서 픽스처가 필요 없기 때문이다 (테스트 하네스는 TS-07 소유).

경계값은 **수업 시작까지 남은 시간**으로 표현한다. ``now``를 주입할 수 있게
설계했으므로 시스템 시각과 무관하게 초 단위로 못박을 수 있다.
"""

# 학습 주석: SCH-03(환불액 산정 순수 함수 + 단위테스트) 반영
#
# 사전 개념:
# - 이 테스트가 DB나 서버 없이 도는 이유는 ``calculate_refund``가 순수 함수라서다
#   (사이드 이펙트가 없다는 뜻 — ``refund_policy.py`` 파일 상단 참고). 순수 함수는
#   "입력을 넣으면 출력이 나온다"만 확인하면 되므로 픽스처·모킹이 필요 없다.
# - ``@pytest.mark.parametrize``: 같은 검증 로직을 값 조합만 바꿔 여러 번 돌리는
#   pytest 기능. 예를 들어 아래 24시간 경계 테스트는 "23:59:59 / 24:00:00 /
#   24:00:01" 세 케이스를 함수 하나로 표현한다 — 케이스마다 함수를 복붙하면
#   나중에 규칙이 바뀔 때 일부만 고치고 넘어가는 실수가 나기 쉬운데, 파라미터
#   테이블 하나로 묶어두면 그런 실수가 줄어들고 실행 결과에도 각 케이스가
#   ``test_이름[레이블]`` 형태로 개별로 찍혀 어떤 조합이 깨졌는지 바로 보인다.
#   이 파일이 함수 24개로 50개 케이스를 검증하는 이유가 이것이다.

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.services.refund_policy import (
    BASIS_POINT_DENOMINATOR,
    FULL_REFUND_RATE_BP,
    FULL_REFUND_THRESHOLD_SECONDS,
    NO_REFUND_RATE_BP,
    CancellationReason,
    RefundCalculation,
    calculate_refund,
)

#: 모든 테스트의 기준 수업 시작 시각. ``now``를 이 시각에서 빼서 남은 시간을 만든다.
STARTS_AT = datetime(2026, 10, 1, 12, 0, 0, tzinfo=UTC)

REASON = CancellationReason.MEMBER_REQUEST

#: 24시간 미만 구간을 덮는 표준 비율표. 24h 티어가 있어도 "정확히 24시간 전"은
#: 플랫폼 고정 규칙(100%)이 이기는지를 이 표로 확인한다.
STANDARD_TIERS = [
    {"hours_before_start": 24, "refund_rate_bp": 5000},
    {"hours_before_start": 12, "refund_rate_bp": 3000},
    {"hours_before_start": 2, "refund_rate_bp": 0},
]


def at(*, before: timedelta) -> datetime:
    """수업 시작 ``before`` 전의 시각."""
    return STARTS_AT - before


def call(
    *,
    paid_amount: int = 100_000,
    before: timedelta = timedelta(hours=48),
    tiers: list[dict] | None = None,
    reason: CancellationReason = REASON,
) -> RefundCalculation:
    return calculate_refund(
        paid_amount=paid_amount,
        starts_at=STARTS_AT,
        now=at(before=before),
        tiers=STANDARD_TIERS if tiers is None else tiers,
        reason=reason,
    )


# --------------------------------------------------------------------------
# 24시간 경계 — 이번 슬라이스의 핵심 결정 (Phase 3 D2.2)
# --------------------------------------------------------------------------


def test_exactly_24h_before_start_is_full_refund() -> None:
    """**정확히 24:00:00 전은 전액 환불이다.**

    경계를 어느 쪽에 포함시킬지가 Phase 3 D2.2의 결정 사항이었다. 전액 환불 쪽에
    포함한다. 이 단정이 깨지면 회원이 1초 차이로 절반만 돌려받게 된다.

    비율표에 24h 티어(50%)가 있는데도 100%가 나와야 한다 — 24시간 이상 구간은
    학원 비율표보다 플랫폼 고정 규칙이 우선하기 때문이다.
    """
    result = call(paid_amount=100_000, before=timedelta(hours=24), tiers=STANDARD_TIERS)

    assert result.seconds_before_start == FULL_REFUND_THRESHOLD_SECONDS == 86_400
    assert result.refund_rate_bp == FULL_REFUND_RATE_BP == 10_000
    assert result.refund_amount == 100_000
    assert result.applied_tier_hours is None, "24h 규칙은 티어를 적용하지 않는다"


@pytest.mark.parametrize(
    ("label", "before", "expected_seconds", "expected_rate_bp", "expected_amount"),
    [
        # 23:59:59 남음 → 24시간 미만 → 비율표 해석 → 24h 티어(50%)
        ("23:59:59", timedelta(hours=23, minutes=59, seconds=59), 86_399, 5_000, 50_000),
        # 24:00:00 정각 → 경계 포함 → 전액
        ("24:00:00", timedelta(hours=24), 86_400, 10_000, 100_000),
        # 24:00:01 남음 → 24시간 초과 → 전액
        ("24:00:01", timedelta(hours=24, seconds=1), 86_401, 10_000, 100_000),
    ],
)
def test_24h_boundary_is_inclusive_of_full_refund(
    label: str,
    before: timedelta,
    expected_seconds: int,
    expected_rate_bp: int,
    expected_amount: int,
) -> None:
    """경계 앞뒤 1초를 함께 고정한다. 셋이 같은 테이블에 있어야 회귀가 눈에 띈다."""
    result = call(paid_amount=100_000, before=before, tiers=STANDARD_TIERS)

    assert result.seconds_before_start == expected_seconds, label
    assert result.refund_rate_bp == expected_rate_bp, label
    assert result.refund_amount == expected_amount, label


def test_sub_second_remainder_is_truncated_not_rounded_up() -> None:
    """23:59:59.999 남음은 24시간 **미만**이다. 초 미만을 올려서 전액을 주지 않는다."""
    now = STARTS_AT - timedelta(hours=24) + timedelta(microseconds=1)
    result = calculate_refund(
        paid_amount=100_000, starts_at=STARTS_AT, now=now, tiers=STANDARD_TIERS, reason=REASON
    )

    assert result.seconds_before_start == 86_399
    assert result.refund_rate_bp == 5_000


def test_far_future_is_full_refund_even_with_empty_tiers() -> None:
    """24시간 이상 남았으면 비율표가 비어 있어도 전액이다."""
    result = call(paid_amount=77_777, before=timedelta(days=30), tiers=[])

    assert result.refund_rate_bp == FULL_REFUND_RATE_BP
    assert result.refund_amount == 77_777


def test_timezone_differences_do_not_shift_the_boundary() -> None:
    """``now``가 다른 tz로 들어와도 경계는 절대시각으로 판정된다."""
    kst = timezone(timedelta(hours=9))
    now = (STARTS_AT - timedelta(hours=24)).astimezone(kst)

    result = calculate_refund(
        paid_amount=100_000, starts_at=STARTS_AT, now=now, tiers=STANDARD_TIERS, reason=REASON
    )

    assert result.seconds_before_start == 86_400
    assert result.refund_rate_bp == FULL_REFUND_RATE_BP


# --------------------------------------------------------------------------
# 티어 해석
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("before", "expected_tier_hours", "expected_rate_bp"),
    [
        # 남은 시간 h에 대해 h <= tier.hours 인 티어 중 hours 최솟값
        (timedelta(hours=23), 24, 5_000),
        (timedelta(hours=12, seconds=1), 24, 5_000),
        (timedelta(hours=12), 12, 3_000),
        (timedelta(hours=5), 12, 3_000),
        (timedelta(hours=2), 2, 0),
        (timedelta(minutes=30), 2, 0),
    ],
)
def test_tier_resolution_picks_smallest_covering_tier(
    before: timedelta, expected_tier_hours: int, expected_rate_bp: int
) -> None:
    result = call(paid_amount=100_000, before=before, tiers=STANDARD_TIERS)

    assert result.applied_tier_hours == expected_tier_hours
    assert result.refund_rate_bp == expected_rate_bp


def test_tier_boundary_is_inclusive() -> None:
    """``h == tier.hours_before_start``면 그 티어에 **포함**된다 (24h 규칙과 같은 방향)."""
    tiers = [{"hours_before_start": 6, "refund_rate_bp": 4_000}]

    included = call(paid_amount=10_000, before=timedelta(hours=6), tiers=tiers)
    excluded = call(paid_amount=10_000, before=timedelta(hours=6, seconds=1), tiers=tiers)

    assert included.refund_rate_bp == 4_000
    assert included.applied_tier_hours == 6
    # 6시간 1초 전은 6h 티어 밖이고 다른 티어도 없으므로 0%
    assert excluded.refund_rate_bp == NO_REFUND_RATE_BP
    assert excluded.applied_tier_hours is None


def test_tier_order_does_not_matter() -> None:
    """비율표 순서를 뒤섞어도 같은 결과가 나온다 — 정렬을 전제하지 않는다.

    JSONB 배열의 순서는 admin 화면에서 행을 추가한 순서에 좌우된다. 산정이 순서에
    의존하면 같은 정책이 화면 조작 이력에 따라 다른 금액을 낸다.
    """
    shuffled = [
        {"hours_before_start": 2, "refund_rate_bp": 0},
        {"hours_before_start": 24, "refund_rate_bp": 5000},
        {"hours_before_start": 12, "refund_rate_bp": 3000},
    ]

    for before in (timedelta(hours=23), timedelta(hours=12), timedelta(hours=1)):
        assert call(before=before, tiers=shuffled) == call(before=before, tiers=STANDARD_TIERS)


def test_empty_tiers_under_24h_is_zero_refund() -> None:
    """24시간 이내인데 학원이 비율표를 설정하지 않았으면 0원이다.

    ``academies.refund_policy_tiers``의 기본값이 ``[]``이므로 신규 학원이 바로 이
    경로를 탄다. 기본값을 "전액 환불"로 바꾸고 싶어질 수 있으나, 그러면 학원이
    설정하지 않은 정책을 플랫폼이 대신 약속하는 셈이 된다.
    """
    result = call(paid_amount=100_000, before=timedelta(hours=3), tiers=[])

    assert result.refund_rate_bp == NO_REFUND_RATE_BP
    assert result.refund_amount == 0
    assert result.applied_tier_hours is None


def test_no_covering_tier_is_zero_refund() -> None:
    """남은 시간을 덮는 티어가 없으면 0%다."""
    tiers = [{"hours_before_start": 12, "refund_rate_bp": 3_000}]
    result = call(paid_amount=100_000, before=timedelta(hours=13), tiers=tiers)

    assert result.refund_rate_bp == NO_REFUND_RATE_BP
    assert result.refund_amount == 0


def test_duplicate_tier_hours_uses_first_occurrence() -> None:
    """``hours_before_start``가 중복이면 앞에 나온 것을 쓴다 — 결정적이어야 한다.

    (중복은 admin 쓰기 경로에서 막지만, JSONB는 DB가 구조를 보장해주지 않으므로
    이미 저장된 데이터가 들어올 수 있다. 조용히 뒤의 것을 쓰거나 예외를 던지는
    대신 동작을 고정한다.)
    """
    tiers = [
        {"hours_before_start": 6, "refund_rate_bp": 4_000},
        {"hours_before_start": 6, "refund_rate_bp": 1_000},
    ]
    result = call(paid_amount=10_000, before=timedelta(hours=5), tiers=tiers)

    assert result.refund_rate_bp == 4_000


# --------------------------------------------------------------------------
# 금액 계산 — 올림, 정수 연산, clamp
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("paid_amount", "rate_bp", "expected"),
    [
        # 나누어떨어지는 경우
        (100_000, 5_000, 50_000),
        (30_000, 3_333, 9_999),
        # 올림이 실제로 1원을 올리는 경우
        (1_000, 3_333, 334),  # 333.3 → 334
        (1, 1, 1),  # 0.0001 → 1
        (1, 9_999, 1),  # 0.9999 → 1
        (999, 5_000, 500),  # 499.5 → 500
        (12_345, 3_333, 4_115),  # 4114.5885 → 4115
        (7, 10, 1),  # 0.007 → 1
    ],
)
def test_amount_is_rounded_up(paid_amount: int, rate_bp: int, expected: int) -> None:
    """반올림이 아니라 **올림(ceil)**이다 — 1원은 회원 쪽으로 간다."""
    tiers = [{"hours_before_start": 6, "refund_rate_bp": rate_bp}]
    result = call(paid_amount=paid_amount, before=timedelta(hours=5), tiers=tiers)

    assert result.refund_amount == expected


def test_nonzero_rate_never_refunds_zero() -> None:
    """환불율이 0이 아니면 최소 1원은 나간다 — 올림 규칙의 직접적 귀결."""
    tiers = [{"hours_before_start": 6, "refund_rate_bp": 1}]
    result = call(paid_amount=1, before=timedelta(hours=5), tiers=tiers)

    assert result.refund_amount == 1


def test_amounts_are_plain_ints_not_floats() -> None:
    """금액·비율 필드가 int여야 한다. float가 섞이면 원 단위가 조용히 어긋난다."""
    result = call(paid_amount=12_345, before=timedelta(hours=5))

    for value in (
        result.refund_amount,
        result.refund_rate_bp,
        result.hours_before_start,
        result.seconds_before_start,
    ):
        assert type(value) is int, f"{value!r}이 int가 아니다"


@pytest.mark.parametrize("rate_bp", [NO_REFUND_RATE_BP, FULL_REFUND_RATE_BP])
def test_rate_extremes(rate_bp: int) -> None:
    """0bp는 0원, 10000bp는 결제액 전액. 끝값에서 off-by-one이 나지 않아야 한다."""
    tiers = [{"hours_before_start": 6, "refund_rate_bp": rate_bp}]
    result = call(paid_amount=100_000, before=timedelta(hours=5), tiers=tiers)

    assert result.refund_rate_bp == rate_bp
    assert result.refund_amount == (100_000 * rate_bp) // BASIS_POINT_DENOMINATOR
    assert result.refund_amount == (0 if rate_bp == 0 else 100_000)


def test_full_rate_never_exceeds_paid_amount() -> None:
    """10000bp에서도 환불액은 결제액을 넘지 않는다 (clamp 이중 방어)."""
    result = call(paid_amount=99_999, before=timedelta(days=1, seconds=1), tiers=[])

    assert result.refund_amount == 99_999
    assert result.refund_amount <= 99_999


@pytest.mark.parametrize(
    "before",
    [timedelta(days=7), timedelta(hours=24), timedelta(hours=5), timedelta(minutes=1)],
)
def test_zero_paid_amount_refunds_zero(before: timedelta) -> None:
    """무료 예약(결제액 0원)은 어느 구간에서도 0원이다. 올림이 0을 1로 만들지 않는다."""
    result = call(paid_amount=0, before=before)

    assert result.refund_amount == 0


# --------------------------------------------------------------------------
# 이미 시작한 수업 — 호출자 책임이지만 계산 자체는 터지지 않아야 한다
# --------------------------------------------------------------------------


def test_after_start_is_zero_refund_without_raising() -> None:
    """수업이 이미 시작했어도 예외를 던지지 않고 0%를 낸다.

    상태 전이 거부는 취소 오케스트레이션 서비스의 책임이다. 순수 함수가 여기서
    예외를 던지면 사전 고지(preview) 경로가 500을 뱉게 된다.
    """
    result = call(paid_amount=100_000, before=timedelta(hours=-1), tiers=STANDARD_TIERS)

    assert result.seconds_before_start == -3_600
    assert result.hours_before_start == -1
    assert result.refund_rate_bp == NO_REFUND_RATE_BP
    assert result.refund_amount == 0


def test_hours_before_start_is_floored() -> None:
    """``hours_before_start``는 내림이다 (5시간 59분은 5시간)."""
    result = call(before=timedelta(hours=5, minutes=59))

    assert result.hours_before_start == 5


# --------------------------------------------------------------------------
# 입력 검증
# --------------------------------------------------------------------------


def test_naive_now_is_rejected() -> None:
    """tz-naive 시각은 거부한다 — 조용히 9시간 어긋나는 것보다 낫다."""
    with pytest.raises(ValueError, match="tz-aware"):
        calculate_refund(
            paid_amount=10_000,
            starts_at=STARTS_AT,
            now=datetime(2026, 9, 30, 12, 0, 0),
            tiers=[],
            reason=REASON,
        )


def test_naive_starts_at_is_rejected() -> None:
    with pytest.raises(ValueError, match="tz-aware"):
        calculate_refund(
            paid_amount=10_000,
            starts_at=datetime(2026, 10, 1, 12, 0, 0),
            now=at(before=timedelta(hours=5)),
            tiers=[],
            reason=REASON,
        )


def test_negative_paid_amount_is_rejected() -> None:
    with pytest.raises(ValueError, match="0 이상"):
        call(paid_amount=-1)


@pytest.mark.parametrize(
    "tiers",
    [
        pytest.param([{"refund_rate_bp": 5_000}], id="hours 키 없음"),
        pytest.param([{"hours_before_start": 6}], id="rate 키 없음"),
        pytest.param([{"hours_before_start": 6, "refund_rate_bp": 10_001}], id="rate 범위 초과"),
        pytest.param([{"hours_before_start": 6, "refund_rate_bp": -1}], id="rate 음수"),
        pytest.param([{"hours_before_start": 0, "refund_rate_bp": 5_000}], id="hours 0"),
        pytest.param([{"hours_before_start": 721, "refund_rate_bp": 5_000}], id="hours 범위 초과"),
        pytest.param([{"hours_before_start": 6, "refund_rate_bp": 50.0}], id="rate float"),
        pytest.param(["not-a-dict"], id="dict 아님"),
    ],
)
def test_malformed_tiers_raise(tiers: list) -> None:
    """JSONB는 DB가 구조를 검증해주지 않는다. 잘못된 비율표로 송금하느니 터뜨린다."""
    with pytest.raises(ValueError):
        call(before=timedelta(hours=5), tiers=tiers)


def test_cancellation_reason_has_only_member_request() -> None:
    """``academy_fault``는 이번 범위 밖(Q5 확정)이다. 값 집합이 ``refunds.reason``
    CHECK 제약과 문자 단위로 일치해야 한다 (Phase 4 §4.1)."""
    assert [member.value for member in CancellationReason] == ["member_request"]


def test_unknown_reason_is_rejected() -> None:
    with pytest.raises(ValueError):
        calculate_refund(
            paid_amount=10_000,
            starts_at=STARTS_AT,
            now=at(before=timedelta(hours=5)),
            tiers=[],
            reason="academy_fault",  # type: ignore[arg-type]
        )
