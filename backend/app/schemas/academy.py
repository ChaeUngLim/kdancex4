"""학원 환불 비율표(admin API)의 요청·응답 스키마.

**이 모듈이 비율표의 유일한 문지기다.** ``academies.refund_policy_tiers``는 JSONB라
DB가 구조를 검증해 주지 않는다. CHECK 제약으로 배열 원소의 형태를 강제할 수도 없다.
그래서 쓰기 경로에서 막지 못하면 ``{"hours_before_start": "24시간"}`` 같은 값이
그대로 저장되고, 나중에 **취소 시점에** ``calculate_refund``가 ``ValueError``로
터진다 — 설정을 저장한 사람과 피해를 보는 사람이 다르고, 시점도 다르다.

범위(1~720시간, 0~10000bp)는 ``app/services/refund_policy.py``의
``_MIN_TIER_HOURS``/``_MAX_TIER_HOURS``/``NO_REFUND_RATE_BP``/``FULL_REFUND_RATE_BP``와
**같은 값이어야 한다.** 여기가 더 느슨하면 저장은 되는데 산정이 터지고, 더 빡빡하면
기존 데이터를 못 고치는 상태가 된다.

정렬을 강제하는 이유
--------------------
산정 함수는 비율표의 **순서에 의존하지 않는다** (남은 시간을 포함하는 티어 중
``hours_before_start`` 최솟값을 고른다). 그런데도 내림차순을 요구하는 건 사람 때문이다.
비율표는 관리 화면에서 위에서 아래로 읽히고, 뒤섞인 표는 "24시간 50%, 6시간 0%,
12시간 30%"처럼 규칙이 어떻게 적용되는지 헷갈리게 만든다. 저장 시점에 한 가지 표현만
허용하면 화면·API·DB가 전부 같은 순서를 본다.
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - Pydantic 스키마 자체의 개념은 ``app/schemas/__init__.py``, ``model_validator``는
#   ``app/schemas/cancellation.py`` 참고.
# - ``StrictInt``: 보통 Pydantic의 ``int`` 필드는 ``"24"``(문자열)·``24.0``(실수)·
#   ``True``(bool)까지도 너그럽게 int로 변환해서 받아준다. ``StrictInt``는 이
#   변환을 끄고 **진짜 int만** 받는다. 여기서 느슨하게 받으면 저장은 성공하는데,
#   같은 값을 나중에 환불 계산 함수(``_require_int``)가 거부해서 취소 시점에야
#   터진다 — 설정한 사람과 피해를 보는 사람이 다르고 시점도 다른 버그가 된다.

from __future__ import annotations

import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

__all__ = [
    "MAX_TIER_COUNT",
    "RefundPolicyResponse",
    "RefundPolicyTier",
    "RefundPolicyUpdate",
]

#: 한 학원이 가질 수 있는 티어 수 상한. 24시간 미만 구간을 시간 단위로 다 쪼개도
#: 23개면 충분하다. 상한을 안 두면 JSONB 한 행이 무한정 커지는 걸 막을 것이 없다.
MAX_TIER_COUNT = 24


# RefundPolicyUpdate.refund_policy_tiers 리스트의 원소 타입이다. 단독으로도
# 쓰인다 — 산정 함수(refund_policy.py)가 거부하는 값을 이 스키마도 거부하는지
# 확인하는 테스트가 이 클래스를 직접 생성한다.
class RefundPolicyTier(BaseModel):
    """비율표 한 행. 공유 계약 §4.4의 JSONB 원소와 **같은 형태**다.

    두 필드 모두 ``StrictInt``다. 느슨한 int는 ``"24"``·``24.0``·``True``를 받아들이는데,
    셋 다 산정 함수(``_require_int``)가 거부하는 값이다. 여기서 통과시키면 저장은
    성공하고 환불 계산만 나중에 터진다.
    """

    model_config = ConfigDict(extra="forbid")

    #: 수업 시작 ``N시간`` 전까지의 구간. 산정 규칙은
    #: "남은 시간 <= ``hours_before_start``를 만족하는 티어 중 최솟값"이다.
    hours_before_start: Annotated[StrictInt, Field(ge=1, le=720)]
    #: 환불율(basis point, 10000 = 100%). 퍼센트도 소수도 아니다 — 부동소수 미사용.
    refund_rate_bp: Annotated[StrictInt, Field(ge=0, le=10_000)]


# 라우터(admin_academies.py)의 PUT /admin/academies/{id}/refund-policy가 요청
# 본문으로 받는 타입. 여기서 검증을 통과한 값만 to_jsonb()를 거쳐 DB에 쓰인다.
class RefundPolicyUpdate(BaseModel):
    """``PUT /admin/academies/{id}/refund-policy`` 요청 본문.

    배열을 그대로 받지 않고 ``refund_policy_tiers`` 키로 감싼 객체를 받는다. 최상위가
    배열이면 나중에 필드 하나(적용 시작일 등)를 더할 때 형태가 통째로 바뀐다.
    키 이름은 컬럼명 ``academies.refund_policy_tiers``와 같게 뒀다 — 화면·API·DB가
    같은 이름을 쓰면 어디서 어디로 옮겨진 값인지 추적할 필요가 없다.

    빈 배열은 **유효한 입력**이다. "24시간 미만이면 전부 0%"라는 정책을 표현하는
    유일한 방법이고, 비율표를 지우는 수단이기도 하다.
    """

    model_config = ConfigDict(extra="forbid")

    refund_policy_tiers: Annotated[
        list[RefundPolicyTier], Field(max_length=MAX_TIER_COUNT)
    ]

    @field_validator("refund_policy_tiers")
    @classmethod
    def _strictly_descending(
        cls, tiers: list[RefundPolicyTier]
    ) -> list[RefundPolicyTier]:
        """``hours_before_start`` 내림차순 + 중복 없음을 강제한다.

        중복을 따로 막는 이유: 같은 ``hours_before_start``에 다른 비율이 둘 있으면
        산정 함수는 **먼저 나온 것**을 쓴다. 배열 순서가 금액을 바꾸는 상태를
        저장 단계에서 없앤다 — 관리자가 의도를 표현할 방법이 없는 데이터다.
        """
        for previous, current in zip(tiers, tiers[1:], strict=False):
            if previous.hours_before_start == current.hours_before_start:
                raise ValueError(
                    "hours_before_start가 중복됩니다: "
                    f"{current.hours_before_start}시간"
                )
            if previous.hours_before_start < current.hours_before_start:
                raise ValueError(
                    "refund_policy_tiers는 hours_before_start 내림차순이어야 합니다: "
                    f"{previous.hours_before_start} < {current.hours_before_start}"
                )
        return tiers

    def to_jsonb(self) -> list[dict[str, int]]:
        """JSONB 컬럼에 그대로 넣을 수 있는 평범한 dict 리스트로 변환한다.

        Pydantic 모델을 그대로 대입하면 직렬화 단계에서 터진다. 검증을 통과한
        값만 여기까지 오므로 이 변환은 형태만 바꾼다.
        """
        return [tier.model_dump() for tier in self.refund_policy_tiers]


# 라우터(admin_academies.py)의 GET·PUT 두 엔드포인트가 공통으로 돌려주는 타입.
class RefundPolicyResponse(BaseModel):
    """``GET``/``PUT`` 공통 응답.

    두 엔드포인트가 같은 형태를 돌려주므로 저장 후 화면이 다시 조회할 필요가 없다.
    """

    model_config = ConfigDict(extra="forbid")

    academy_id: uuid.UUID
    refund_policy_tiers: list[RefundPolicyTier]
