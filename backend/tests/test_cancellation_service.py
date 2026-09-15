"""취소 오케스트레이션 서비스 + 의존성 주입 단위 테스트. **DB·Redis 불필요.**

전체 취소 흐름(FOR UPDATE → 환불 → 정원 복구)은 실 Postgres가 있어야 검증된다 —
그건 TS-07이 작성하고 TS-12가 실행한다. 여기서는 **DB 없이 지금 못박을 수 있는
불변식**만 다룬다:

1. 멱등 키가 결정적이다 — 헤더를 안 보내도 같은 예약은 같은 키를 낸다
2. 슬롯 락 해제 실패·예외가 밖으로 새지 않는다 (환불을 되돌리지 않는 근거)
3. 알림은 회원·학원 관리자 **양쪽**에 나가고, 한쪽이 터져도 다른 쪽을 막지 않는다
4. 서비스가 구상 어댑터 클래스를 import하지 않는다 (TS-05 완료 기준)
5. 임시 인증(F7)이 헤더를 어떻게 다루는가
"""

# 학습 주석: SCH-05(취소 오케스트레이션 서비스 + deps.py) 반영
#
# 트랜잭션/행 잠금(SELECT ... FOR UPDATE)/멱등성/SAVEPOINT 개념은
# `app/services/cancellation.py` 파일 상단 "사전 개념 요약"에 정리돼 있다 —
# 이 테스트 파일은 DB가 없어 그 개념들을 직접 실행해 보이지는 못하고, 대신 아래
# 섹션 2("슬롯 락 해제는 best-effort")·섹션 6("예외 → HTTP 상태 코드 매핑")처럼
# **그 설계가 실제로 지켜지는지를 소스 문자열/반환값으로 단정**한다. FastAPI
# 의존성 주입 Depends()의 동작 방식은 `app/deps.py` 학습 주석 참고 — 섹션 5의
# `auth_client` 픽스처가 그것을 실제로 확인한다.

from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.adapters.notification import (
    FakeNotificationSender,
    NotificationAudience,
    NotificationEvent,
    NotificationSender,
)
from app.adapters.payment_gateway import PaymentGateway
from app.adapters.slot_lock import NullSlotLock, SlotLock
from app.deps import (
    CurrentUserId,
    get_notification_sender,
    get_payment_gateway,
    get_slot_lock,
)
from app.models.payment import Payment
from app.models.reservation import Reservation
from app.services.cancellation import (
    ACTIVE_REFUND_STATUSES,
    CancellationError,
    ClassAlreadyStartedError,
    PaidPaymentNotFoundError,
    ReservationAlreadyCancelledError,
    ReservationNotCancellableError,
    ReservationNotFoundError,
    ReservationOwnershipError,
    UnsupportedRefundMethodError,
    _jsonable,
    _notify,
    _preview_block_reason,
    _release_slot_lock,
    build_idempotency_key,
)
from app.services.refund_policy import RefundCalculation

RESERVATION_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
MEMBER_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
ACADEMY_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")

CANCELLATION_SOURCE = (
    Path(__file__).resolve().parent.parent / "app" / "services" / "cancellation.py"
)


# --------------------------------------------------------------------------- #
# 1. 멱등 키 — 헤더를 안 보내도 이중 환불이 불가능해야 한다
# --------------------------------------------------------------------------- #


def test_idempotency_key_is_deterministic_without_header():
    """헤더가 없으면 sha256("cancel:" + reservation_id). 같은 예약은 늘 같은 키."""
    expected = hashlib.sha256(f"cancel:{RESERVATION_ID}".encode()).hexdigest()

    assert build_idempotency_key(RESERVATION_ID) == expected
    assert build_idempotency_key(RESERVATION_ID) == build_idempotency_key(
        RESERVATION_ID
    )
    # str/UUID 어느 쪽으로 넘겨도 같은 키여야 한다 — 라우터가 어떻게 넘기든 같은 행으로 수렴.
    assert build_idempotency_key(str(RESERVATION_ID)) == expected


def test_idempotency_key_differs_per_reservation():
    other = uuid.UUID("44444444-4444-4444-8444-444444444444")
    assert build_idempotency_key(RESERVATION_ID) != build_idempotency_key(other)


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_header_falls_back_to_deterministic_key(blank: str | None):
    """공백만 들어온 헤더를 키로 받아들이면 예약별 결정성이 깨진다."""
    assert build_idempotency_key(RESERVATION_ID, blank) == build_idempotency_key(
        RESERVATION_ID
    )


def test_provided_header_wins_and_is_trimmed():
    assert build_idempotency_key(RESERVATION_ID, "  client-key-1 ") == "client-key-1"
    # refunds.idempotency_key는 VARCHAR(200)이다. 넘치면 INSERT가 터진다.
    assert len(build_idempotency_key(RESERVATION_ID, "x" * 500)) == 200


# --------------------------------------------------------------------------- #
# 2. 슬롯 락 해제는 best-effort — 환불을 되돌리지 않는다
# --------------------------------------------------------------------------- #


class _FailingSlotLock:
    """해제에 실패했다고 보고하는 락 (Redis 미기동 시 RedisSlotLock의 동작)."""

    def release(self, schedule_id: Any) -> bool:
        return False


class _ExplodingSlotLock:
    """Protocol의 약속을 어기고 예외를 던지는 락."""

    def release(self, schedule_id: Any) -> bool:
        raise RuntimeError("redis is down")


@pytest.mark.parametrize(
    "lock", [NullSlotLock(), _FailingSlotLock(), _ExplodingSlotLock()]
)
def test_slot_lock_release_never_propagates(lock: SlotLock):
    """해제 실패도, 예외도 호출자에게 새지 않는다.

    이게 깨지면 볼륨도 없는 캐시의 장애가 **이미 커밋된 환불 트랜잭션**을
    되돌리게 된다. 취소 성공 여부는 슬롯 락 해제 결과로 분기되지 않는다.
    """
    assert _release_slot_lock(lock, uuid.uuid4()) is None


def test_service_does_not_branch_on_slot_lock_result():
    """소스 수준 확인: 해제 반환값이 취소 성공/실패 분기에 쓰이지 않는다."""
    source = CANCELLATION_SOURCE.read_text(encoding="utf-8")
    # 반환값을 받는 곳은 _release_slot_lock 내부 한 곳뿐이고, 그 값은 로그에만 쓰인다.
    assert source.count("slot_lock.release(") == 1
    assert "if slot_lock.release" not in source
    # 락 해제는 커밋 이후에 호출된다 — 되돌릴 트랜잭션이 남아 있지 않다.
    assert source.index("session.commit()\n\n    outcome") < source.index(
        "_release_slot_lock(slot_lock,"
    )


# --------------------------------------------------------------------------- #
# 3. 알림 2방향
# --------------------------------------------------------------------------- #


def test_notify_sends_to_both_audiences():
    sender = FakeNotificationSender()

    _notify(
        sender,
        member_id=MEMBER_ID,
        academy_id=ACADEMY_ID,
        event=NotificationEvent.RESERVATION_CANCELLED,
        payload={"reservation_id": RESERVATION_ID, "amount": 10_000},
    )

    assert len(sender.sent_to(NotificationAudience.MEMBER)) == 1
    assert len(sender.sent_to(NotificationAudience.ACADEMY_ADMIN)) == 1
    # payload는 JSONB에 들어갈 수 있는 형태로 평탄화돼 있어야 한다.
    assert sender.sent[0].payload["reservation_id"] == str(RESERVATION_ID)


class _HalfBrokenSender:
    """회원 발송만 실패하는 알림기."""

    def __init__(self) -> None:
        self.academy_calls = 0

    def notify_member(self, member_id: str, event: Any, payload: Any = None) -> None:
        raise RuntimeError("expo push down")

    def notify_academy_admin(
        self, academy_id: str, event: Any, payload: Any = None
    ) -> None:
        self.academy_calls += 1


def test_notify_failure_does_not_block_the_other_audience():
    """한쪽 채널 장애가 다른 쪽 발송을 막지 않고, 환불 결과에도 영향을 주지 않는다."""
    sender: NotificationSender = _HalfBrokenSender()

    _notify(
        sender,
        member_id=MEMBER_ID,
        academy_id=ACADEMY_ID,
        event=NotificationEvent.REFUND_PENDING,
        payload={},
    )

    assert sender.academy_calls == 1


# --------------------------------------------------------------------------- #
# 4. Protocol 경계 — 서비스가 구상 클래스를 모른다 (TS-05 완료 기준)
# --------------------------------------------------------------------------- #


def test_service_module_has_no_concrete_adapter_references():
    source = CANCELLATION_SOURCE.read_text(encoding="utf-8")
    for concrete in ("FakePaymentGateway", "FakeNotificationSender", "RedisSlotLock"):
        assert concrete not in source, f"{concrete}가 서비스 계층에 새어 들어왔다"


def test_deps_provide_protocol_satisfying_adapters():
    assert isinstance(get_payment_gateway(), PaymentGateway)
    assert isinstance(get_notification_sender(), NotificationSender)
    assert isinstance(get_slot_lock(), SlotLock)


def test_adapter_deps_are_process_singletons():
    """FakePaymentGateway의 멱등 원장이 인메모리라, 요청마다 새로 만들면 안 된다."""
    assert get_payment_gateway() is get_payment_gateway()
    assert get_notification_sender() is get_notification_sender()
    assert get_slot_lock() is get_slot_lock()


# --------------------------------------------------------------------------- #
# 5. 임시 인증 (F7)
# --------------------------------------------------------------------------- #


@pytest.fixture
def auth_client() -> TestClient:
    probe = FastAPI()

    @probe.get("/whoami")
    def whoami(user_id: CurrentUserId) -> dict[str, str]:
        return {"user_id": str(user_id)}

    return TestClient(probe)


def test_current_user_id_reads_header(auth_client: TestClient):
    response = auth_client.get("/whoami", headers={"X-User-Id": str(MEMBER_ID)})
    assert response.status_code == 200
    assert response.json() == {"user_id": str(MEMBER_ID)}


def test_missing_header_is_401(auth_client: TestClient):
    assert auth_client.get("/whoami").status_code == 401


def test_malformed_header_is_400(auth_client: TestClient):
    """UUID가 아니면 400. 500으로 터뜨리지 않는다."""
    assert auth_client.get("/whoami", headers={"X-User-Id": "not-a-uuid"}).status_code == 400


def test_temporary_auth_carries_the_f7_warning():
    """F7 경고 주석이 실재해야 한다 — 위조 가능하다는 사실이 코드에 남아 있어야 한다."""
    source = (Path(__file__).resolve().parent.parent / "app" / "deps.py").read_text(
        encoding="utf-8"
    )
    assert "F7" in source
    assert "위조" in source
    assert "프로덕션" in source


# --------------------------------------------------------------------------- #
# 6. 예외 → HTTP 상태 코드 매핑
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [
        (ReservationNotFoundError, 404),
        (ReservationOwnershipError, 403),
        (ReservationAlreadyCancelledError, 409),
        (ReservationNotCancellableError, 409),
        (ClassAlreadyStartedError, 409),
        (PaidPaymentNotFoundError, 409),
        # 카드 환불 시도가 500이 아니라 422여야 한다 — 어댑터의
        # UnsupportedPaymentMethodError를 서비스가 잡아 이 예외로 바꾼다.
        (UnsupportedRefundMethodError, 422),
    ],
)
def test_cancellation_errors_carry_http_status(
    error: type[CancellationError], expected_status: int
):
    instance = error("사유")
    assert isinstance(instance, CancellationError)
    assert instance.status_code == expected_status
    assert instance.message == "사유"


def test_unsupported_method_is_caught_in_the_service():
    """소스 수준 확인: PG의 UnsupportedPaymentMethodError를 서비스가 실제로 잡는다."""
    source = CANCELLATION_SOURCE.read_text(encoding="utf-8")
    assert "except UnsupportedPaymentMethodError" in source
    assert "raise UnsupportedRefundMethodError" in source


def test_pending_is_not_treated_as_failure():
    """pending은 정상 경로다 — 부분 유니크 인덱스가 덮는 '살아 있는 환불'에 포함된다."""
    assert ACTIVE_REFUND_STATUSES == {"succeeded", "pending"}


# --------------------------------------------------------------------------- #
# 7. 사전 고지 차단 사유 — 취소 API 판정과 같은 순서여야 한다
# --------------------------------------------------------------------------- #


def _calculation(seconds_before_start: int) -> RefundCalculation:
    return RefundCalculation(
        refund_amount=10_000,
        refund_rate_bp=10_000,
        hours_before_start=seconds_before_start // 3600,
        seconds_before_start=seconds_before_start,
        applied_tier_hours=None,
    )


def _reservation(status: str) -> Reservation:
    return Reservation(
        id=RESERVATION_ID,
        order_id=uuid.uuid4(),
        class_schedule_id=uuid.uuid4(),
        user_id=MEMBER_ID,
        status=status,
    )


def _payment() -> Payment:
    return Payment(
        id=uuid.uuid4(),
        order_id=uuid.uuid4(),
        method="virtual_account",
        amount=10_000,
        paid_at=datetime(2026, 9, 1, tzinfo=UTC),
    )


@pytest.mark.parametrize(
    ("status", "seconds", "payment", "expected"),
    [
        ("confirmed", 48 * 3600, True, None),
        ("held", 48 * 3600, True, None),
        ("cancelled", 48 * 3600, True, "reservation_already_cancelled"),
        ("expired", 48 * 3600, True, "reservation_not_cancellable"),
        ("confirmed", 0, True, "class_already_started"),
        ("confirmed", -60, True, "class_already_started"),
        ("confirmed", 48 * 3600, False, "paid_payment_not_found"),
    ],
)
def test_preview_block_reason(
    status: str, seconds: int, payment: bool, expected: str | None
):
    reason = _preview_block_reason(
        _reservation(status),
        _payment() if payment else None,
        _calculation(seconds),
    )
    assert reason == expected


# --------------------------------------------------------------------------- #
# 8. 감사 로그 payload 평탄화
# --------------------------------------------------------------------------- #


def test_jsonable_flattens_uuid_and_datetime():
    """UUID/datetime이 그대로 들어가면 JSONB 직렬화에서 터진다."""
    moment = datetime(2026, 9, 14, 12, 0, tzinfo=UTC)
    payload = _jsonable(
        {
            "reservation_id": RESERVATION_ID,
            "now": moment,
            "tiers": [{"hours_before_start": 24, "refund_rate_bp": 5000}],
            "nothing": None,
        }
    )

    assert payload["reservation_id"] == str(RESERVATION_ID)
    assert payload["now"] == moment.isoformat()
    assert payload["tiers"] == [{"hours_before_start": 24, "refund_rate_bp": 5000}]
    assert payload["nothing"] is None
