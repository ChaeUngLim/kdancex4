"""스키마·라우터 배선 단위 테스트 (TS-06). **DB가 필요 없다.**

여기서 검증하는 건 두 가지다.

1. **경계 검증이 스키마 계층에 실재하는가** — 가상계좌 환불에 계좌 없이 들어온
   요청이 422로 막히는가, 망가진 환불 비율표가 저장 경로에서 막히는가.
2. **라우터가 실제로 붙었는가** — 경로 4개가 앱에 등록되고 기존 ``/health``가 살아
   있는가.

DB를 안 쓰는 게 중요하다. 이 검증들은 Postgres 없이도 항상 돌아야 하고, 실제로
Docker 없이 전부 통과한다. DB가 필요한 통합 테스트는 TS-07/TS-12의 몫이다.
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - Pydantic 스키마·APIRouter 개념은 ``app/schemas/__init__.py``·
#   ``app/routers/__init__.py`` 참고.
# - ``TestClient``: 실제 서버 프로세스를 띄우지 않고, 파이썬 프로세스 안에서
#   FastAPI ``app``에 직접 요청을 흘려보내는 테스트용 HTTP 클라이언트다. 그래서
#   포트를 열거나 네트워크를 타지 않고도 라우터·CORS·예외 매핑을 검증할 수
#   있다.
# - ``app.dependency_overrides``: ``Depends(get_db)`` 같은 의존성을 테스트가
#   원하는 다른 함수로 통째로 갈아끼우는 FastAPI 기능이다. 아래
#   ``stub_session`` fixture가 이것으로 실제 DB 커넥션을 열지 않는 가짜 세션을
#   끼워 넣는다 — Depends() 개념 자체는 SCH-05(취소 오케스트레이션 서비스 +
#   deps.py) 참고.
# - OpenAPI 스키마 개념과 "왜 app.routes 대신 app.openapi()를 보는가"는
#   ``app/main.py``의 학습 주석과 바로 아래 ``test_all_routes_are_mounted``의
#   docstring 참고 (I-1: 계획 문서가 지정한 검증 명령이 이 FastAPI 버전에서
#   깨져서 대체한 방법이다).

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.adapters.payment_gateway import PaymentMethod
from app.db import get_db
from app.main import app
from app.schemas.academy import RefundPolicyTier, RefundPolicyUpdate
from app.schemas.cancellation import CancelRequest
from app.services import cancellation as cancellation_service

client = TestClient(app)

VALID_ACCOUNT = {
    "bank_code": "088",
    "account_number": "110-123-456789",
    "holder_name": "임채웅",
}


# --------------------------------------------------------------------------- #
# 라우터 배선
# --------------------------------------------------------------------------- #


def test_all_routes_are_mounted():
    """신규 경로 4개(= 엔드포인트 5개) + 기존 ``/health``가 전부 등록돼 있다.

    ``app.routes``를 직접 훑지 않는다. FastAPI 0.141부터 ``include_router``로 붙인
    라우터가 ``_IncludedRouter``라는 래퍼로 들어가 ``.path``가 없다. OpenAPI 스키마는
    버전이 바뀌어도 형태가 같고, 무엇보다 **클라이언트가 실제로 보는 계약**이다.
    """
    paths = app.openapi()["paths"]
    assert {
        "/health",
        "/reservations/{reservation_id}/cancel",
        "/reservations/{reservation_id}/cancellation-preview",
        "/admin/academies/{academy_id}/refund-policy",
    } <= set(paths)
    # 환불 비율표는 한 경로에 GET·PUT 둘이 붙는다.
    assert set(paths["/admin/academies/{academy_id}/refund-policy"]) == {"get", "put"}


def test_health_still_works():
    """라우터를 붙여도 기존 엔드포인트는 그대로다 (회귀 방지)."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_allows_admin_web_origins():
    """admin-web 개발 서버(Next.js 3000)가 허용된다."""
    for origin in ("http://localhost:3000",):
        response = client.get("/health", headers={"Origin": origin})
        assert response.headers.get("access-control-allow-origin") == origin


def test_cors_does_not_allow_arbitrary_origin():
    """와일드카드가 아니다 — 모르는 출처에는 허용 헤더가 붙지 않는다."""
    response = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in response.headers


# --------------------------------------------------------------------------- #
# CancelRequest — 환불 계좌 필수 검증
# --------------------------------------------------------------------------- #


def test_virtual_account_without_refund_account_is_rejected():
    """가상계좌라고 선언했는데 계좌가 없으면 검증 실패다."""
    with pytest.raises(ValidationError):
        CancelRequest(method=PaymentMethod.VIRTUAL_ACCOUNT)


def test_virtual_account_with_refund_account_is_accepted():
    request = CancelRequest(
        method=PaymentMethod.VIRTUAL_ACCOUNT, refund_account=VALID_ACCOUNT
    )
    account = request.refund_account.to_domain()
    assert account.bank_code == "088"
    assert account.holder_name == "임채웅"
    # 선택값이라 안 보내면 None이다 (스마트로 가상계좌 취소에는 나중에 필요해진다).
    assert account.holder_phone_number is None


def test_method_omitted_does_not_require_refund_account():
    """결제수단을 안 보내면 스키마는 통과시킨다 — 권위는 DB의 ``payments.method``다."""
    assert CancelRequest().refund_account is None
    assert CancelRequest(refund_account=VALID_ACCOUNT).method is None


def test_card_method_does_not_require_refund_account():
    assert CancelRequest(method=PaymentMethod.CARD).refund_account is None


def test_unknown_field_is_rejected():
    """오타 난 필드가 조용히 무시되면 회원은 계좌를 보냈다고 믿게 된다."""
    with pytest.raises(ValidationError):
        CancelRequest(refundAccount=VALID_ACCOUNT)


@pytest.mark.parametrize(
    "account",
    [
        {**VALID_ACCOUNT, "bank_code": ""},
        {**VALID_ACCOUNT, "holder_name": ""},
        {**VALID_ACCOUNT, "account_number": "1" * 65},  # refunds 컬럼 상한 64
        {"bank_code": "088", "account_number": "110-1"},  # holder_name 누락
    ],
)
def test_invalid_refund_account_is_rejected(account):
    with pytest.raises(ValidationError):
        CancelRequest(method=PaymentMethod.VIRTUAL_ACCOUNT, refund_account=account)


def test_cancel_endpoint_returns_422_without_refund_account():
    """API 경계에서도 422다. **DB를 건드리기 전에** 막힌다.

    본문 검증이 실패하면 엔드포인트 함수가 아예 실행되지 않으므로, Postgres가
    꺼져 있어도 이 테스트는 통과한다 — 검증이 스키마 계층에 있다는 증거다.
    """
    response = client.post(
        f"/reservations/{uuid.uuid4()}/cancel",
        headers={"X-User-Id": str(uuid.uuid4())},
        json={"method": "virtual_account"},
    )
    assert response.status_code == 422


def test_cancel_endpoint_requires_user_header():
    """임시 인증(F7)이 없으면 401이다. 이 역시 DB를 타지 않는다."""
    response = client.post(f"/reservations/{uuid.uuid4()}/cancel", json={})
    assert response.status_code == 401


# --------------------------------------------------------------------------- #
# 환불 비율표 — JSONB 쓰기 경로의 유일한 문지기
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "tier",
    [
        {"hours_before_start": 0, "refund_rate_bp": 5000},  # 1 미만
        {"hours_before_start": 721, "refund_rate_bp": 5000},  # 720 초과
        {"hours_before_start": 24, "refund_rate_bp": -1},
        {"hours_before_start": 24, "refund_rate_bp": 10_001},
        {"hours_before_start": "24", "refund_rate_bp": 5000},  # 문자열
        {"hours_before_start": 24.5, "refund_rate_bp": 5000},  # 소수
        {"hours_before_start": True, "refund_rate_bp": 5000},  # bool은 int가 아니다
        {"hours_before_start": 24},  # 비율 누락
        {"hours_before_start": 24, "refund_rate_bp": 5000, "note": "x"},  # 미지 필드
    ],
)
def test_invalid_tier_is_rejected(tier):
    """산정 함수(``_parse_tier``)가 거부하는 값은 저장 경로에서도 거부된다.

    여기가 느슨하면 저장은 성공하고 **취소 시점에** 환불 계산이 터진다 — 설정한
    사람과 피해 보는 사람이 다르고 시점도 다르다.
    """
    with pytest.raises(ValidationError):
        RefundPolicyTier(**tier)


def test_valid_tier_boundaries_are_accepted():
    assert RefundPolicyTier(hours_before_start=1, refund_rate_bp=0)
    assert RefundPolicyTier(hours_before_start=720, refund_rate_bp=10_000)


def test_descending_tiers_are_accepted():
    update = RefundPolicyUpdate(
        refund_policy_tiers=[
            {"hours_before_start": 24, "refund_rate_bp": 5000},
            {"hours_before_start": 12, "refund_rate_bp": 3000},
            {"hours_before_start": 6, "refund_rate_bp": 0},
        ]
    )
    assert update.to_jsonb() == [
        {"hours_before_start": 24, "refund_rate_bp": 5000},
        {"hours_before_start": 12, "refund_rate_bp": 3000},
        {"hours_before_start": 6, "refund_rate_bp": 0},
    ]


def test_empty_tiers_are_accepted():
    """빈 표는 "24시간 미만은 전부 0%"를 뜻하는 유효한 정책이다."""
    assert RefundPolicyUpdate(refund_policy_tiers=[]).to_jsonb() == []


def test_unsorted_tiers_are_rejected():
    with pytest.raises(ValidationError, match="내림차순"):
        RefundPolicyUpdate(
            refund_policy_tiers=[
                {"hours_before_start": 6, "refund_rate_bp": 0},
                {"hours_before_start": 24, "refund_rate_bp": 5000},
            ]
        )


def test_duplicate_tier_hours_are_rejected():
    """같은 시간에 다른 비율이 둘이면 배열 순서가 금액을 바꾼다. 저장 단계에서 없앤다."""
    with pytest.raises(ValidationError, match="중복"):
        RefundPolicyUpdate(
            refund_policy_tiers=[
                {"hours_before_start": 24, "refund_rate_bp": 5000},
                {"hours_before_start": 24, "refund_rate_bp": 0},
            ]
        )


def test_too_many_tiers_are_rejected():
    with pytest.raises(ValidationError):
        RefundPolicyUpdate(
            refund_policy_tiers=[
                {"hours_before_start": hours, "refund_rate_bp": 0}
                for hours in range(720, 720 - 25, -1)
            ]
        )


def test_body_must_be_wrapped_in_refund_policy_tiers_key():
    """admin-web이 보내는 형태(``{"refund_policy_tiers": [...]}``)와 일치한다."""
    with pytest.raises(ValidationError):
        RefundPolicyUpdate(tiers=[])


# --------------------------------------------------------------------------- #
# 라우터의 예외 → HTTP 매핑
# --------------------------------------------------------------------------- #
#
# 서비스를 가짜로 바꿔 **라우터만** 검증한다. DB가 필요 없고, 실제 취소 흐름은
# TS-07/TS-12의 통합 테스트가 본다. 여기서 보려는 건 하나다 — 서비스가 들고 온
# 상태 코드가 그대로 HTTP로 나가는가, 그리고 ``ValueError``가 500이 아닌 422가 되는가.


@pytest.fixture
def stub_session():
    """``get_db``를 아무것도 하지 않는 객체로 바꾼다. 커넥션을 열지 않는다."""

    def _override():
        yield object()

    app.dependency_overrides[get_db] = _override
    yield
    app.dependency_overrides.clear()


def _preview(**overrides):
    fields = {
        "reservation_id": uuid.uuid4(),
        "payment_method": "virtual_account",
        "paid_amount": 30_000,
        "refund_amount": 15_000,
        "refund_rate_bp": 5000,
        "hours_before_start": 12,
        "seconds_before_start": 12 * 3600,
        "applied_tier_hours": 24,
        "starts_at": datetime(2026, 10, 1, 10, 0, tzinfo=UTC),
        "cancellable": True,
        "reason_code": None,
    }
    fields.update(overrides)
    return cancellation_service.CancellationPreview(**fields)


def test_preview_exposes_payment_method_and_paid_amount(stub_session, monkeypatch):
    """모바일이 환불 계좌 폼을 띄울지 정하는 두 필드가 응답에 실제로 실린다 (TS-09 I-2)."""
    monkeypatch.setattr(
        "app.routers.reservations.preview_cancellation",
        lambda *a, **kw: _preview(),
    )
    response = client.get(
        f"/reservations/{uuid.uuid4()}/cancellation-preview",
        headers={"X-User-Id": str(uuid.uuid4())},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["payment_method"] == "virtual_account"
    assert body["paid_amount"] == 30_000
    assert body["refund_amount"] == 15_000


def test_preview_returns_200_when_not_cancellable(stub_session, monkeypatch):
    """취소 불가는 에러가 아니다 — 사유와 금액을 함께 200으로 돌려준다."""
    monkeypatch.setattr(
        "app.routers.reservations.preview_cancellation",
        lambda *a, **kw: _preview(
            cancellable=False, reason_code="class_already_started"
        ),
    )
    response = client.get(
        f"/reservations/{uuid.uuid4()}/cancellation-preview",
        headers={"X-User-Id": str(uuid.uuid4())},
    )
    assert response.status_code == 200
    assert response.json()["reason_code"] == "class_already_started"


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [
        (cancellation_service.ReservationNotFoundError("없음"), 404),
        (cancellation_service.ReservationOwnershipError("타인"), 403),
        (cancellation_service.ClassAlreadyStartedError("시작함"), 409),
        (cancellation_service.UnsupportedRefundMethodError("카드"), 422),
    ],
)
def test_domain_errors_keep_their_status_code(
    stub_session, monkeypatch, error, expected_status
):
    """예외가 들고 다니는 ``status_code``가 그대로 HTTP 상태가 된다."""

    def _raise(*args, **kwargs):
        raise error

    monkeypatch.setattr("app.routers.reservations.preview_cancellation", _raise)
    response = client.get(
        f"/reservations/{uuid.uuid4()}/cancellation-preview",
        headers={"X-User-Id": str(uuid.uuid4())},
    )
    assert response.status_code == expected_status
    assert response.json()["detail"] == error.message


def test_broken_refund_policy_becomes_422_not_500(stub_session, monkeypatch):
    """``calculate_refund``의 ``ValueError``가 그대로 새면 500이 된다 (TS-03 경고).

    JSONB에는 CHECK를 걸 수 없으므로 망가진 비율표가 DB에 남아 있을 수 있다.
    그때 사전 고지 화면이 500을 받으면 회원은 취소 화면에 진입조차 못 한다.
    """

    def _raise(*args, **kwargs):
        raise ValueError("tiers[0].refund_rate_bp는 0~10000 범위여야 한다: 99999")

    monkeypatch.setattr("app.routers.reservations.preview_cancellation", _raise)
    response = client.get(
        f"/reservations/{uuid.uuid4()}/cancellation-preview",
        headers={"X-User-Id": str(uuid.uuid4())},
    )
    assert response.status_code == 422
    # 내부 값(99999)을 회원에게 그대로 보여주지 않는다. 원본은 서버 로그에만 남는다.
    assert "99999" not in response.json()["detail"]


def test_cancel_returns_200_on_gateway_failure(stub_session, monkeypatch):
    """PG 실패는 200 + ``status="failed"``다.

    비-2xx로 바꾸면 실패 사유가 담긴 본문이 클라이언트의 에러 처리로 빨려 들어가
    회원에게 이유를 못 보여준다. 모바일(TS-09)도 이 형태를 전제로 화면을 만들었다.
    """
    outcome = cancellation_service.CancellationOutcome(
        reservation_id=uuid.uuid4(),
        refund_id=uuid.uuid4(),
        status=cancellation_service.RefundStatus.FAILED,
        requested_amount=15_000,
        refunded_amount=0,
        refund_rate_bp=5000,
        hours_before_start=12,
        reservation_status="confirmed",
        slot_restored=False,
        replayed=False,
        failure_code="PG_TIMEOUT",
        failure_message="게이트웨이 응답 없음",
    )
    monkeypatch.setattr(
        "app.routers.reservations.cancel_reservation", lambda *a, **kw: outcome
    )
    response = client.post(
        f"/reservations/{uuid.uuid4()}/cancel",
        headers={"X-User-Id": str(uuid.uuid4())},
        json={"refund_account": VALID_ACCOUNT},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["failure_code"] == "PG_TIMEOUT"
    assert body["failure_message"] == "게이트웨이 응답 없음"
