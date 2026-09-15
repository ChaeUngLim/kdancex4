"""``GET``/``PUT /admin/academies/{id}/refund-policy`` DB 통합 테스트 (TS-07).

``academies.refund_policy_tiers``는 JSONB다. **DB가 구조를 검증해 주지 않는다** —
배열 원소의 형태에는 CHECK 제약을 걸 수 없다. 그래서 이 경로가 뚫리면
``{"hours_before_start": "24시간"}`` 같은 값이 그대로 저장되고, 터지는 건 한참 뒤
**다른 회원이 취소를 누르는 순간**이다. 설정한 사람과 피해자가 다르고 시점도 다르다.

``test_schemas.py``가 :class:`~app.schemas.academy.RefundPolicyUpdate`를 직접 호출해
같은 규칙을 이미 단정한다. 그런데도 여기서 다시 보는 이유는 **스키마가 실제로 그
경로에 꽂혀 있는지**는 스키마 단위 테스트가 확인할 수 없기 때문이다 — 라우터가
``dict``를 그냥 받아 넘기도록 바뀌어도 스키마 테스트는 전부 초록이다.

DB를 쓰므로 모듈 전체에 ``requires_db`` 마커가 붙는다. DB가 없으면 ``error``가
아니라 ``skipped``다 (``conftest.py`` 참조).
"""

# 학습 주석: SCH-07(conftest + DB 통합 테스트 작성) 반영
#
# 사전 개념 — JSONB는 SCH-02(도메인 모델 7개 + 초기 마이그레이션), Pydantic
# 스키마 검증은 SCH-06(Pydantic 스키마 + 라우터 + main.py)에서 이미 설명했다.
# 이 파일은 새 개념 없이, "스키마가 실제로 그 API 경로에 연결돼 있는지"를
# DB까지 붙여서 다시 확인하는 것뿐이다(위 docstring 참고).

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Academy
from app.schemas.academy import MAX_TIER_COUNT
from tests.conftest import DEFAULT_REFUND_TIERS, Scenario

#: 이 모듈의 모든 테스트가 실 PostgreSQL을 요구한다 (``test_cancel_api.py`` 참조).
pytestmark = pytest.mark.requires_db


def policy_url(academy_id: uuid.UUID) -> str:
    return f"/admin/academies/{academy_id}/refund-policy"


# --------------------------------------------------------------------------- #
# 조회
# --------------------------------------------------------------------------- #


def test_get_returns_stored_tiers(
    api_client: TestClient, scenario: Scenario
) -> None:
    """저장된 비율표를 그대로 돌려준다."""
    response = api_client.get(policy_url(scenario.academy_id))

    assert response.status_code == 200
    body = response.json()
    assert body["academy_id"] == str(scenario.academy_id)
    assert body["refund_policy_tiers"] == DEFAULT_REFUND_TIERS


def test_get_unknown_academy_returns_404(api_client: TestClient) -> None:
    response = api_client.get(policy_url(uuid.uuid4()))

    assert response.status_code == 404


def test_get_empty_policy_is_not_an_error(
    api_client: TestClient, db_session: Session
) -> None:
    """빈 비율표는 정상이다 — "24시간 미만이면 전부 0%"라는 뜻이고 컬럼 기본값이다.

    여기서 404나 500을 내면 관리자는 아직 설정하지 않은 학원의 설정 화면에 아예
    들어가지 못한다.
    """
    academy = Academy(id=uuid.uuid4(), name="비율표 없는 스튜디오", refund_policy_tiers=[])
    db_session.add(academy)
    db_session.flush()

    response = api_client.get(policy_url(academy.id))

    assert response.status_code == 200
    assert response.json()["refund_policy_tiers"] == []


# --------------------------------------------------------------------------- #
# 저장 (전체 교체)
# --------------------------------------------------------------------------- #


def test_put_replaces_whole_table_and_persists(
    api_client: TestClient, db_session: Session, scenario: Scenario
) -> None:
    """PUT은 **통째로 교체**한다 (PATCH가 아니다). 저장 결과가 DB와 재조회에 모두 보인다.

    응답만 확인하면 부족하다. JSONB 컬럼은 제자리 수정 시 SQLAlchemy가 변경을 감지하지
    못해 UPDATE가 조용히 누락될 수 있다 — "저장 버튼을 눌렀는데 아무 일도 안 일어나는"
    그 버그는 응답 본문에는 정상으로 보인다. 그래서 DB를 직접 읽는다.
    """
    new_tiers = [
        {"hours_before_start": 24, "refund_rate_bp": 10_000},
        {"hours_before_start": 12, "refund_rate_bp": 5_000},
        {"hours_before_start": 1, "refund_rate_bp": 0},
    ]

    response = api_client.put(
        policy_url(scenario.academy_id),
        json={"refund_policy_tiers": new_tiers},
    )

    assert response.status_code == 200
    assert response.json()["refund_policy_tiers"] == new_tiers

    # 기존 2행이 남아 합쳐지지 않았는지까지 본다 (전체 교체).
    academy = db_session.get(Academy, scenario.academy_id)
    db_session.refresh(academy)
    assert academy.refund_policy_tiers == new_tiers

    assert api_client.get(policy_url(scenario.academy_id)).json()[
        "refund_policy_tiers"
    ] == new_tiers


def test_put_empty_list_clears_the_table(
    api_client: TestClient, db_session: Session, scenario: Scenario
) -> None:
    """빈 배열은 **유효한 입력**이다 — 비율표를 지우는 유일한 수단이기도 하다."""
    response = api_client.put(
        policy_url(scenario.academy_id), json={"refund_policy_tiers": []}
    )

    assert response.status_code == 200
    assert response.json()["refund_policy_tiers"] == []

    academy = db_session.get(Academy, scenario.academy_id)
    db_session.refresh(academy)
    assert academy.refund_policy_tiers == []


def test_put_unknown_academy_returns_404(api_client: TestClient) -> None:
    """본문이 유효해도 학원이 없으면 404 (422가 아니다)."""
    response = api_client.put(
        policy_url(uuid.uuid4()),
        json={"refund_policy_tiers": [{"hours_before_start": 12, "refund_rate_bp": 0}]},
    )

    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# 검증 실패 — 전부 422이고, **아무것도 저장되지 않는다**
# --------------------------------------------------------------------------- #


#: 거부돼야 하는 본문들. ``id`` 라벨이 실패 출력에 그대로 찍히므로 "무엇을 막는
#: 규칙인지"를 이름에 담는다.
INVALID_PAYLOADS: list[tuple[str, dict[str, Any]]] = [
    (
        "ascending_order",
        # 내림차순 위반. 산정 함수는 순서에 의존하지 않지만, 뒤섞인 표는 관리 화면에서
        # 규칙이 어떻게 적용되는지 읽을 수 없게 만든다.
        {
            "refund_policy_tiers": [
                {"hours_before_start": 3, "refund_rate_bp": 5_000},
                {"hours_before_start": 12, "refund_rate_bp": 0},
            ]
        },
    ),
    (
        "duplicate_hours",
        # 같은 시간에 다른 비율이 둘이면 배열 순서가 금액을 바꾼다 — 관리자가 의도를
        # 표현할 방법이 없는 데이터다.
        {
            "refund_policy_tiers": [
                {"hours_before_start": 12, "refund_rate_bp": 5_000},
                {"hours_before_start": 12, "refund_rate_bp": 3_000},
            ]
        },
    ),
    (
        "bp_above_max",
        {"refund_policy_tiers": [{"hours_before_start": 12, "refund_rate_bp": 10_001}]},
    ),
    (
        "bp_negative",
        {"refund_policy_tiers": [{"hours_before_start": 12, "refund_rate_bp": -1}]},
    ),
    (
        "hours_zero",
        {"refund_policy_tiers": [{"hours_before_start": 0, "refund_rate_bp": 5_000}]},
    ),
    (
        "hours_above_max",
        {"refund_policy_tiers": [{"hours_before_start": 721, "refund_rate_bp": 5_000}]},
    ),
    (
        "hours_as_string",
        # StrictInt가 아니면 "12"가 통과한다. 저장은 되고 산정만 나중에 터진다.
        {"refund_policy_tiers": [{"hours_before_start": "12", "refund_rate_bp": 5_000}]},
    ),
    (
        "bp_as_float",
        # 부동소수는 값 집합 밖이다 (수용 기준: 부동소수 미사용).
        {"refund_policy_tiers": [{"hours_before_start": 12, "refund_rate_bp": 5000.5}]},
    ),
    (
        "unknown_field_in_tier",
        # 오타 난 필드가 조용히 무시되면 관리자는 설정했다고 믿는데 서버는 못 받는다.
        {
            "refund_policy_tiers": [
                {
                    "hours_before_start": 12,
                    "refund_rate_bp": 5_000,
                    "refund_rate_percent": 50,
                }
            ]
        },
    ),
    (
        "missing_refund_rate_bp",
        {"refund_policy_tiers": [{"hours_before_start": 12}]},
    ),
    (
        "bare_array_body",
        # 최상위가 배열이면 나중에 필드 하나를 더할 때 형태가 통째로 바뀐다.
        {"tiers": [{"hours_before_start": 12, "refund_rate_bp": 5_000}]},
    ),
    (
        "too_many_tiers",
        # JSONB 한 행이 무한정 커지는 걸 막을 것이 없으면 안 된다.
        {
            "refund_policy_tiers": [
                {"hours_before_start": hours, "refund_rate_bp": 0}
                for hours in range(MAX_TIER_COUNT + 1, 0, -1)
            ]
        },
    ),
]


@pytest.mark.parametrize(
    "payload",
    [payload for _, payload in INVALID_PAYLOADS],
    ids=[label for label, _ in INVALID_PAYLOADS],
)
def test_put_rejects_invalid_policy(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payload: dict[str, Any],
) -> None:
    """검증 실패는 전부 422이고, 기존 비율표는 **그대로 남는다**.

    두 번째 단정이 본체다. 422를 내면서 일부를 저장해 버리면 관리자는 "실패했다"는
    화면을 보고 있는데 정책은 이미 바뀐 상태가 된다 — 취소가 들어오기 전까지 아무도
    모른다.
    """
    response = api_client.put(policy_url(scenario.academy_id), json=payload)

    assert response.status_code == 422

    academy = db_session.get(Academy, scenario.academy_id)
    db_session.refresh(academy)
    assert academy.refund_policy_tiers == DEFAULT_REFUND_TIERS
