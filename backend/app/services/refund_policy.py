"""예약 취소 시 회원에게 돌려줄 환불액을 산정하는 순수 함수.

이 모듈은 DB·네트워크·시스템 시각 어디에도 의존하지 않는다. 현재 시각 ``now``는
반드시 호출자가 주입한다 — 함수 안에서 시스템 시각을 읽으면 "수업 시작 정확히
24시간 전" 같은 경계값을 테스트로 못박을 수 없기 때문이다.

금액은 전부 정수(원)로만 다룬다. 환불율은 basis point(0~10000 정수)이며
소수 타입을 일절 쓰지 않는다 (요구사항 §7 "부동소수 미사용").

산정 규칙 (Phase 3 §2.1 / §2.2 결정):

1. 수업 시작까지 남은 시간이 **24시간 이상이면 환불율 100%**. 플랫폼 고정 규칙이며
   학원이 설정한 비율표와 무관하다. 경계(정확히 24:00:00)는 **전액 환불 쪽에 포함**한다.
2. 24시간 미만이면 남은 시간 ``h``에 대해 ``h <= tier.hours_before_start``를 만족하는
   티어 중 ``hours_before_start``가 **가장 작은** 것을 적용한다.
3. 만족하는 티어가 없으면 0%.
4. 반올림은 **올림(ceil)** — 회원에게 유리한 쪽. 정수 연산만으로 구현한다.
5. 산정 결과는 결제액으로 clamp한다 (환불액 > 결제액은 구조적으로 불가).

**호출자 책임:** 이미 시작했거나 종료된 수업, 이미 취소된 예약을 걸러내는 것은
취소 오케스트레이션 서비스(``app/services/cancellation.py``)의 몫이다. 이 함수는
남은 시간이 음수여도 예외를 던지지 않고 규칙을 그대로 적용한다 — 순수 함수에
상태 전이 판정을 섞으면 두 책임이 같이 썩는다.
"""

# 학습 주석: SCH-03(환불액 산정 순수 함수 + 단위테스트) 반영
#
# 사전 개념 (이 파일을 읽기 전에):
# - 순수 함수(pure function): 같은 입력이면 언제 불러도 같은 출력을 내고, DB에
#   쓰거나 시스템 시각을 읽는 등 "바깥 세상"을 건드리지 않는 함수. 이 모듈이
#   현재 시각을 스스로 읽지 않고 ``now`` 파라미터로 받는 이유가 이것이다 —
#   시스템 시각을 직접 읽으면 "24시간 정각"처럼 애매한 순간을 테스트에서 재현할
#   방법이 없다. 테스트 쪽에서 ``now``에 원하는 시각을 그대로 넣어주면 된다.
# - ``StrEnum``: 아래 ``CancellationReason``처럼 "문자열이면서 동시에 열거형"인
#   타입. 멤버를 비교할 때는 보통 Enum처럼 쓰고(``reason == CancellationReason.
#   MEMBER_REQUEST``), DB에 저장하거나 JSON으로 내보낼 때는 그냥 문자열
#   (``"member_request"``)처럼 다룰 수 있어 변환 코드가 따로 필요 없다.
# - 정수만으로 올림(ceil) 처리하는 이유: 돈 계산에 실수(소수) 연산을 쓰면 컴퓨터가
#   내부적으로 이진수로 근사해서 저장하는 특성 때문에 아주 드물게 오차가 생길 수
#   있다. 금액은 원 단위까지 정확해야 하므로, 이 모듈은 나눗셈 결과를 항상 정수
#   바닥나눗셈(``//``)만으로 구하고 올림이 필요하면 부호를 뒤집는 트릭
#   (``_ceil_amount`` 참고)을 쓴다. 선행 SCH(모델 계층)의 개념은 이 파일이
#   모델을 아예 import하지 않아 참고할 일이 없다.
#
# 함수 위치: 이 모듈 전체는 라우터(app/routers)나 취소 오케스트레이션 서비스가
# "환불액이 얼마인지"를 물어볼 때 호출하는 계산 담당이다. DB·PG(결제대행사)
# 어댑터와 무관하며, 계산된 금액을 실제로 돌려주는 것은 다른 계층의 몫이다.

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

__all__ = [
    "BASIS_POINT_DENOMINATOR",
    "FULL_REFUND_RATE_BP",
    "FULL_REFUND_THRESHOLD_SECONDS",
    "NO_REFUND_RATE_BP",
    "CancellationReason",
    "RefundCalculation",
    "calculate_refund",
]


# 이 열거형의 값 하나하나가 곧 문자열이다(StrEnum) — DB의 ``refunds.reason``
# 컬럼에 그대로 저장되고, API 응답 JSON에도 따옴표 붙은 문자열로 그대로 나간다.
class CancellationReason(StrEnum):
    """취소 사유. 이 모듈이 소유한다 (Phase 4 §4.2 — 모델은 이 enum을 import하지 않는다).

    값 집합은 ``refunds.reason`` CHECK 제약과 문자 단위로 일치해야 한다 (Phase 4 §4.1).

    ``academy_fault``(학원 귀책)는 **의도적으로 넣지 않는다** — Q5 확정상 이번 범위
    밖이다. 추가할 때는 여기에 멤버를 더하고 CHECK 제약 변경 마이그레이션 1건을
    붙이면 된다. ``calculate_refund``가 이미 ``reason``을 받으므로 분기 지점은 열려 있다.
    """

    MEMBER_REQUEST = "member_request"


#: 이 시간 이상 남았으면 학원 비율표와 무관하게 전액 환불 (경계 포함).
FULL_REFUND_THRESHOLD_SECONDS = 24 * 60 * 60

#: basis point 분모. 10000bp = 100%.
BASIS_POINT_DENOMINATOR = 10_000

FULL_REFUND_RATE_BP = 10_000
NO_REFUND_RATE_BP = 0

_SECONDS_PER_HOUR = 60 * 60
_ONE_SECOND = timedelta(seconds=1)

#: 비율표 티어가 가질 수 있는 시간 범위. admin 쓰기 경로(Pydantic)와 같은 범위.
_MIN_TIER_HOURS = 1
_MAX_TIER_HOURS = 720


# ``calculate_refund``가 반환하는 결과 그릇. 이 값을 그대로 취소 오케스트레이션
# 서비스가 받아 실제 송금(PG 어댑터)과 감사 로그 기록에 쓴다.
@dataclass(frozen=True, slots=True)
class RefundCalculation:
    """환불액 산정 결과. 전 필드가 정수이거나 None이다.

    Attributes:
        refund_amount: 실제 환불할 금액(원). 항상 ``0 <= refund_amount <= paid_amount``.
        refund_rate_bp: 적용된 환불율(basis point, 0~10000).
        hours_before_start: 수업 시작까지 남은 시간(시). 내림. 이미 시작했으면 음수.
        seconds_before_start: 수업 시작까지 남은 시간(초). 내림. 경계 판정의 실제 근거.
        applied_tier_hours: 적용된 티어의 ``hours_before_start``.
            24시간 규칙이 적용됐거나 만족하는 티어가 없으면 None.
    """

    refund_amount: int
    refund_rate_bp: int
    hours_before_start: int
    seconds_before_start: int
    applied_tier_hours: int | None


# 라우터/취소 오케스트레이션 서비스가 "이 취소 건은 얼마를 돌려줘야 하나"를
# 물어볼 때 부르는 이 모듈의 유일한 공개 진입점. DB·PG 어댑터를 호출하지 않고
# 오직 넘겨받은 값만으로 계산한다(순수 함수 — 위 파일 상단 사전 개념 참고).
def calculate_refund(
    paid_amount: int,
    starts_at: datetime,
    now: datetime,
    tiers: list[dict],
    reason: CancellationReason,
) -> RefundCalculation:
    """환불액을 산정한다. DB·IO 의존 0.

    Args:
        paid_amount: 결제액(원, 0 이상 정수).
        starts_at: 수업 시작 시각. tz-aware여야 한다.
        now: 산정 기준 시각. tz-aware여야 한다. **반드시 주입** — 내부에서 읽지 않는다.
        tiers: ``academies.refund_policy_tiers`` JSONB 원본 그대로.
            ``[{"hours_before_start": 24, "refund_rate_bp": 5000}, ...]``
        reason: 취소 사유. 현재 값이 하나뿐이라 산정에 영향을 주지 않으나,
            학원 귀책 분기가 생길 자리를 시그니처에 미리 열어 둔 것이다.

    Returns:
        RefundCalculation

    Raises:
        ValueError: 결제액이 음수이거나, 시각이 tz-naive이거나, 사유가 알 수 없는
            값이거나, 비율표 티어가 구조·범위를 벗어난 경우. JSONB는 DB가 구조를
            검증해주지 않으므로 여기서 조용히 넘기지 않고 터뜨린다 — 잘못된 비율표로
            엉뚱한 금액을 송금하는 것보다 낫다.
    """
    if not isinstance(paid_amount, int) or isinstance(paid_amount, bool):
        raise ValueError(f"paid_amount는 정수여야 한다: {paid_amount!r}")
    if paid_amount < 0:
        raise ValueError(f"paid_amount는 0 이상이어야 한다: {paid_amount}")

    _require_aware(starts_at, "starts_at")
    _require_aware(now, "now")

    # 알 수 없는 사유는 여기서 걸린다. 현재는 분기하지 않는다 (Q5 — 학원 귀책 범위 밖).
    CancellationReason(reason)

    # timedelta // timedelta는 정수를 돌려준다. 소수 연산을 타지 않는다.
    seconds_before_start = (starts_at - now) // _ONE_SECOND

    if seconds_before_start >= FULL_REFUND_THRESHOLD_SECONDS:
        # 플랫폼 고정 규칙. 학원 비율표를 보지 않는다.
        refund_rate_bp = FULL_REFUND_RATE_BP
        applied_tier_hours: int | None = None
    else:
        refund_rate_bp, applied_tier_hours = _resolve_tier(tiers, seconds_before_start)

    refund_amount = _ceil_amount(paid_amount, refund_rate_bp)

    # 결제액 clamp. DB CHECK 제약과 이중 방어 — 구조적으로 도달 불가한 경로지만
    # 금전 이동이라 계산 쪽에서도 막는다.
    if refund_amount > paid_amount:
        refund_amount = paid_amount

    return RefundCalculation(
        refund_amount=refund_amount,
        refund_rate_bp=refund_rate_bp,
        hours_before_start=seconds_before_start // _SECONDS_PER_HOUR,
        seconds_before_start=seconds_before_start,
        applied_tier_hours=applied_tier_hours,
    )


# ``calculate_refund``가 환불율을 정한 다음 마지막에 실제 원 단위 금액으로
# 바꾸는 곳. 왜 정수만 쓰는지는 파일 상단 사전 개념 요약 참고.
def _ceil_amount(paid_amount: int, rate_bp: int) -> int:
    """``paid_amount``에 ``rate_bp``를 곱해 basis point 분모로 나눈 값을 올림한 정수.

    ``-(-a * b // d)``는 a, b, d가 모두 음이 아닐 때 올림 나눗셈과 같다. 나눗셈
    연산자는 정수 바닥나눗셈 ``//`` 하나만 쓴다 — 참나눗셈이나 표준 반올림 함수를
    쓰면 금액이 부동소수를 타게 되고, 수용 기준 "부동소수 미사용"이 깨진다.
    """
    return -(-paid_amount * rate_bp // BASIS_POINT_DENOMINATOR)


# ``calculate_refund``가 24시간 미만 구간이라고 판단했을 때만 호출한다. 학원이
# admin-web에서 설정한 비율표(JSONB)를 실제로 해석하는 부분.
def _resolve_tier(tiers: list[dict], seconds_before_start: int) -> tuple[int, int | None]:
    """24시간 미만 구간의 환불율을 비율표에서 해석한다.

    남은 시간을 포함하는 티어 중 ``hours_before_start``가 가장 작은 것을 고른다.
    비율표의 순서에 의존하지 않는다. ``hours_before_start``가 중복이면 먼저 나온 것을 쓴다.
    만족하는 티어가 없으면 0%.
    """
    if tiers is None:
        raise ValueError("tiers는 리스트여야 한다: None")
    if not isinstance(tiers, list):
        raise ValueError(f"tiers는 리스트여야 한다: {type(tiers).__name__}")

    best_hours: int | None = None
    best_rate_bp = NO_REFUND_RATE_BP

    for index, tier in enumerate(tiers):
        hours, rate_bp = _parse_tier(tier, index)
        if seconds_before_start > hours * _SECONDS_PER_HOUR:
            continue
        if best_hours is None or hours < best_hours:
            best_hours = hours
            best_rate_bp = rate_bp

    return best_rate_bp, best_hours


# ``_resolve_tier``가 비율표를 한 줄씩 훑을 때 항목 하나를 검증하려고 호출한다.
def _parse_tier(tier: object, index: int) -> tuple[int, int]:
    """티어 dict 하나를 (hours_before_start, refund_rate_bp) 정수 쌍으로 검증·변환한다."""
    if not isinstance(tier, dict):
        raise ValueError(f"tiers[{index}]는 dict여야 한다: {type(tier).__name__}")

    hours = _require_int(tier, "hours_before_start", index)
    rate_bp = _require_int(tier, "refund_rate_bp", index)

    if not _MIN_TIER_HOURS <= hours <= _MAX_TIER_HOURS:
        raise ValueError(
            f"tiers[{index}].hours_before_start는 "
            f"{_MIN_TIER_HOURS}~{_MAX_TIER_HOURS} 범위여야 한다: {hours}"
        )
    if not NO_REFUND_RATE_BP <= rate_bp <= FULL_REFUND_RATE_BP:
        raise ValueError(
            f"tiers[{index}].refund_rate_bp는 "
            f"{NO_REFUND_RATE_BP}~{FULL_REFUND_RATE_BP} 범위여야 한다: {rate_bp}"
        )

    return hours, rate_bp


# ``_parse_tier``가 두 개의 필수 필드(시간, 비율)를 각각 검증할 때 재사용하는 헬퍼.
def _require_int(tier: dict, key: str, index: int) -> int:
    if key not in tier:
        raise ValueError(f"tiers[{index}]에 {key}가 없다")
    value = tier[key]
    # bool은 int의 하위 타입이라 명시적으로 거른다. True가 1로 통과하면 안 된다.
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"tiers[{index}].{key}는 정수여야 한다: {value!r}")
    return value


# ``calculate_refund``가 ``starts_at``·``now`` 두 시각을 각각 검증할 때 부른다.
def _require_aware(value: datetime, name: str) -> None:
    """tz-naive 시각을 거부한다. 경계 판정을 naive 시각으로 하면 조용히 어긋난다."""
    if not isinstance(value, datetime):
        raise ValueError(f"{name}은 datetime이어야 한다: {type(value).__name__}")
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError(f"{name}은 tz-aware여야 한다 (UTC 권장): {value!r}")
