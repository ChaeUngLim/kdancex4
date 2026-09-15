"""어댑터 3종(PG / 알림 / 슬롯 락) 단위 테스트. **DB·Redis 불필요.**

TS-04 완료 기준을 그대로 코드로 옮긴 것이다:

1. Redis 미기동 상태에서 ``slot_lock`` import와 해제 호출이 예외 없이 반환
2. ``FakePaymentGateway``로 succeeded / pending / failed 3가지를 각각 만든다
3. ``method == "card"`` 호출이 ``UnsupportedPaymentMethodError``를 던진다
"""

# 학습 주석: SCH-04(어댑터 3종: PG/알림/슬롯락) 반영
#
# 사전 개념: 이 파일이 검증하는 세 어댑터(PG/알림/슬롯 락)의 Protocol·Fake 객체
# 개념은 app/adapters/__init__.py·payment_gateway.py·slot_lock.py에서 이미
# 설명했다. 여기서는 "그 개념이 실제로 테스트에서 어떻게 쓰이는지"만 위치
# 설명으로 덧붙인다. conftest.py가 없다는 점이 특징이다 — 이 테스트들은 DB나
# Redis 접속이 필요 없는 순수 단위 테스트라 픽스처가 필요 없다.

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.adapters.notification import (
    FakeNotificationSender,
    NotificationAudience,
    NotificationEvent,
)
from app.adapters.payment_gateway import (
    PORTONE_CANCELLATION_STATUS_MAP,
    FakePaymentGateway,
    PaymentGateway,
    RefundAccount,
    RefundRequest,
    RefundStatus,
    UnsupportedPaymentMethodError,
    parse_portone_cancel_response,
)
from app.adapters.slot_lock import (
    SLOT_LOCK_KEY_NAMESPACE,
    NullSlotLock,
    RedisSlotLock,
    SlotLock,
    slot_lock_key,
)

FIXED_NOW = datetime(2026, 9, 14, 12, 0, 0, tzinfo=UTC)
ACCOUNT = RefundAccount(
    bank_code="SHINHAN",
    account_number="110123456789",
    holder_name="홍길동",
)


def make_request(
    payment_key: str = "pay_001",
    *,
    method: str = "virtual_account",
    amount: int = 50_000,
    idempotency_key: str | None = None,
    refund_account: RefundAccount | None = ACCOUNT,
) -> RefundRequest:
    return RefundRequest(
        payment_key=payment_key,
        method=method,
        amount=amount,
        idempotency_key=idempotency_key or f"idem_{payment_key}",
        refund_account=refund_account,
    )


# --------------------------------------------------------------------------- #
# 값 집합 — 공유 계약 §4.1 (refunds.status CHECK와 문자 단위 일치해야 한다)
# --------------------------------------------------------------------------- #


def test_refund_status_values_match_db_check_constraint():
    assert {s.value for s in RefundStatus} == {"succeeded", "pending", "failed"}


def test_portone_requested_maps_to_pending_not_failed():
    """포트원의 ``REQUESTED``는 정상 상태다. 실패로 접으면 정상 환불이 실패로 기록된다."""
    assert PORTONE_CANCELLATION_STATUS_MAP["SUCCEEDED"] is RefundStatus.SUCCEEDED
    assert PORTONE_CANCELLATION_STATUS_MAP["REQUESTED"] is RefundStatus.PENDING
    assert PORTONE_CANCELLATION_STATUS_MAP["FAILED"] is RefundStatus.FAILED


# --------------------------------------------------------------------------- #
# 포트원 응답 파서
# --------------------------------------------------------------------------- #


def test_parse_portone_succeeded_cancellation():
    result = parse_portone_cancel_response(
        {
            "cancellation": {
                "status": "SUCCEEDED",
                "id": "cancel_abc",
                "pgCancellationId": "pg_xyz",
                "totalAmount": 50_000,
                "taxFreeAmount": 0,
                "vatAmount": 0,
                "reason": "회원 요청 취소",
                "requestedAt": "2026-09-14T12:00:00Z",
                "cancelledAt": "2026-09-14T12:00:03Z",
            }
        }
    )
    assert result.status is RefundStatus.SUCCEEDED
    assert result.gateway_refund_id == "cancel_abc"
    assert result.pg_cancellation_id == "pg_xyz"
    assert result.total_amount == 50_000
    assert result.cancelled_at == datetime(2026, 9, 14, 12, 0, 3, tzinfo=UTC)
    assert result.failure_code is None


def test_parse_portone_requested_cancellation_has_no_settlement_fields():
    result = parse_portone_cancel_response(
        {
            "cancellation": {
                "status": "REQUESTED",
                "id": "cancel_abc",
                "totalAmount": 50_000,
                "reason": "회원 요청 취소",
                "requestedAt": "2026-09-14T12:00:00Z",
            }
        }
    )
    assert result.status is RefundStatus.PENDING
    assert result.is_pending
    assert result.cancelled_at is None
    assert result.pg_cancellation_id is None


def test_parse_portone_unknown_status_fails_loudly():
    """포트원이 새 변종을 추가해도 성공으로 넘겨짚지 않는다."""
    result = parse_portone_cancel_response({"cancellation": {"status": "WEIRD_NEW"}})
    assert result.status is RefundStatus.FAILED
    assert result.failure_code == "UNRECOGNIZED_CANCELLATION_STATUS"
    assert "WEIRD_NEW" in result.failure_message


def test_parse_portone_malformed_payload_fails():
    result = parse_portone_cancel_response({})
    assert result.status is RefundStatus.FAILED


def test_refund_request_serializes_to_portone_field_names():
    payload = make_request().to_portone_payload()
    assert payload["paymentId"] == "pay_001"
    assert payload["amount"] == 50_000
    assert payload["reason"]
    assert payload["refundAccount"] == {
        "bank": "SHINHAN",
        "number": "110123456789",
        "holderName": "홍길동",
    }


def test_refund_account_includes_holder_phone_when_present():
    """스마트로 가상계좌 취소는 ``holderPhoneNumber``가 필수다."""
    account = RefundAccount("SHINHAN", "110123456789", "홍길동", "01012345678")
    assert account.to_portone_payload()["holderPhoneNumber"] == "01012345678"


# --------------------------------------------------------------------------- #
# FakePaymentGateway — succeeded / pending / failed 3종 (완료 기준)
# --------------------------------------------------------------------------- #


# @runtime_checkable Protocol이라 isinstance()로 "이 객체가 PaymentGateway가
# 요구하는 메서드를 실제로 갖고 있는가"를 직접 확인할 수 있다 — 상속 관계가
# 전혀 없는데도 이 단정이 통과하는 것 자체가 구조적 타이핑의 증거다.
def test_fake_gateway_satisfies_protocol():
    assert isinstance(FakePaymentGateway(), PaymentGateway)


def test_fake_gateway_produces_succeeded():
    gateway = FakePaymentGateway(clock=lambda: FIXED_NOW)
    result = gateway.refund(make_request("pay_ok"))

    assert result.status is RefundStatus.SUCCEEDED
    assert result.gateway_refund_id is not None
    assert result.pg_cancellation_id is not None
    assert result.total_amount == 50_000
    assert result.cancelled_at == FIXED_NOW
    assert result.raw_response["cancellation"]["status"] == "SUCCEEDED"


def test_fake_gateway_produces_pending_via_pending_on():
    gateway = FakePaymentGateway(pending_on={"pay_slow"}, clock=lambda: FIXED_NOW)
    result = gateway.refund(make_request("pay_slow"))

    assert result.status is RefundStatus.PENDING
    assert result.cancelled_at is None
    assert result.raw_response["cancellation"]["status"] == "REQUESTED"


def test_fake_gateway_produces_pending_via_force_pending():
    gateway = FakePaymentGateway(force_pending=True, clock=lambda: FIXED_NOW)
    assert gateway.refund(make_request("any")).status is RefundStatus.PENDING


def test_fake_gateway_produces_failed_via_fail_on():
    gateway = FakePaymentGateway(fail_on={"pay_bad"}, clock=lambda: FIXED_NOW)
    result = gateway.refund(make_request("pay_bad"))

    assert result.status is RefundStatus.FAILED
    assert result.failure_code == "PG_PROVIDER_ERROR"
    assert result.failure_message


def test_fake_gateway_is_deterministic():
    """같은 입력 → 같은 식별자. 스냅샷 단정이 가능해야 한다."""
    a = FakePaymentGateway(clock=lambda: FIXED_NOW).refund(make_request("pay_ok"))
    b = FakePaymentGateway(clock=lambda: FIXED_NOW).refund(make_request("pay_ok"))
    assert a.gateway_refund_id == b.gateway_refund_id
    assert a.pg_cancellation_id == b.pg_cancellation_id


def test_fake_gateway_ledger_makes_retry_idempotent():
    gateway = FakePaymentGateway(clock=lambda: FIXED_NOW)
    request = make_request("pay_ok", idempotency_key="idem_same")

    first = gateway.refund(request)
    second = gateway.refund(request)

    assert first == second
    assert len(gateway.calls) == 2
    assert len(gateway.ledger) == 1


def test_fake_gateway_does_not_pin_failures_in_ledger():
    """실패 건 재시도는 도메인상 허용이다 (부분 유니크 인덱스가 failed를 제외한다)."""
    gateway = FakePaymentGateway(fail_on={"pay_bad"}, clock=lambda: FIXED_NOW)
    request = make_request("pay_bad")

    assert gateway.refund(request).status is RefundStatus.FAILED
    assert gateway.ledger == {}

    gateway.fail_on.clear()
    assert gateway.refund(request).status is RefundStatus.SUCCEEDED


def test_fake_gateway_settle_promotes_pending_to_succeeded():
    gateway = FakePaymentGateway(force_pending=True, clock=lambda: FIXED_NOW)
    request = make_request("pay_slow")
    assert gateway.refund(request).status is RefundStatus.PENDING

    settled = gateway.settle(request.idempotency_key)
    assert settled.status is RefundStatus.SUCCEEDED
    assert settled.cancelled_at == FIXED_NOW


def test_fake_gateway_fails_without_refund_account():
    """스키마 계층이 먼저 막지만 어댑터가 2차 방어한다 — 조용히 성공시키지 않는다."""
    gateway = FakePaymentGateway()
    result = gateway.refund(make_request("pay_ok", refund_account=None))

    assert result.status is RefundStatus.FAILED
    assert result.failure_code == "REFUND_ACCOUNT_REQUIRED"


# --------------------------------------------------------------------------- #
# 카드 결제수단 거부 (완료 기준)
# --------------------------------------------------------------------------- #


def test_card_method_raises_unsupported_payment_method_error():
    gateway = FakePaymentGateway()
    with pytest.raises(UnsupportedPaymentMethodError) as excinfo:
        gateway.refund(make_request("pay_card", method="card"))

    assert excinfo.value.method == "card"
    assert gateway.calls == []
    assert gateway.ledger == {}


@pytest.mark.parametrize("method", ["card", "kakaopay", "", "VIRTUAL_ACCOUNT"])
def test_non_virtual_account_methods_are_rejected(method: str):
    with pytest.raises(UnsupportedPaymentMethodError):
        FakePaymentGateway().refund(make_request("pay_x", method=method))


# --------------------------------------------------------------------------- #
# 알림 — 회원·학원 관리자 2방향
# --------------------------------------------------------------------------- #


def test_fake_notification_sender_records_both_directions():
    sender = FakeNotificationSender()
    payload = {"reservation_id": "r-1", "refund_amount": 50_000}

    sender.notify_member("member-1", NotificationEvent.RESERVATION_CANCELLED, payload)
    sender.notify_academy_admin(
        "academy-1", NotificationEvent.RESERVATION_CANCELLED, payload
    )

    assert len(sender.sent) == 2
    member = sender.sent_to(NotificationAudience.MEMBER)
    admin = sender.sent_to(NotificationAudience.ACADEMY_ADMIN)
    assert [n.recipient_id for n in member] == ["member-1"]
    assert [n.recipient_id for n in admin] == ["academy-1"]
    assert member[0].event is NotificationEvent.RESERVATION_CANCELLED
    assert member[0].payload == payload


def test_fake_notification_sender_copies_payload():
    """기록이 호출자 dict와 공유되면 나중 변경이 과거 기록을 오염시킨다."""
    sender = FakeNotificationSender()
    payload = {"amount": 1}
    sender.notify_member("m", NotificationEvent.REFUND_PENDING, payload)
    payload["amount"] = 999
    assert sender.sent[0].payload == {"amount": 1}


def test_notification_events_cover_pending_separately_from_failure():
    assert NotificationEvent.REFUND_PENDING != NotificationEvent.REFUND_FAILED


# --------------------------------------------------------------------------- #
# 슬롯 락 — Redis 미기동에서도 예외 없음 (완료 기준)
# --------------------------------------------------------------------------- #


def test_slot_lock_key_namespace_is_fixed():
    assert SLOT_LOCK_KEY_NAMESPACE == "kdance:slot"
    assert slot_lock_key("sched-1") == "kdance:slot:sched-1"


def test_redis_slot_lock_construction_opens_no_socket():
    """생성자에서 연결하면 Redis가 꺼진 환경에서 의존성 주입 자체가 터진다."""
    RedisSlotLock(redis_url="redis://127.0.0.1:6399/0")


# 이 테스트가 바로 "예외를 삼키는 방어적 설계"를 실증한다 — 실제로 6399
# 포트에는 아무것도 떠 있지 않은데도(Redis 미기동을 흉내) release() 호출이
# 예외를 던지지 않고 False로 조용히 끝난다.
def test_redis_slot_lock_release_returns_false_when_redis_is_down(caplog):
    """Redis 미기동 — **예외 없이** False를 돌려주고 경고만 남긴다."""
    lock = RedisSlotLock(redis_url="redis://127.0.0.1:6399/0", timeout_seconds=0.2)
    with caplog.at_level("WARNING"):
        assert lock.release("sched-1") is False
    assert caplog.records, "조용히 삼키지 말고 경고 로그를 남겨야 한다"


def test_redis_slot_lock_release_swallows_client_errors(caplog):
    class ExplodingClient:
        def delete(self, key: str) -> int:
            raise RuntimeError("boom")

    lock = RedisSlotLock(client=ExplodingClient())
    with caplog.at_level("WARNING"):
        assert lock.release("sched-1") is False


def test_redis_slot_lock_release_deletes_namespaced_key():
    class RecordingClient:
        def __init__(self) -> None:
            self.deleted: list[str] = []

        def delete(self, key: str) -> int:
            self.deleted.append(key)
            return 1

    client = RecordingClient()
    assert RedisSlotLock(client=client).release("sched-7") is True
    assert client.deleted == ["kdance:slot:sched-7"]


def test_null_slot_lock_records_releases():
    lock = NullSlotLock()
    assert lock.release("sched-1") is True
    assert lock.released == ["kdance:slot:sched-1"]


def test_slot_lock_implementations_satisfy_protocol():
    assert isinstance(NullSlotLock(), SlotLock)
    assert isinstance(RedisSlotLock(redis_url="redis://127.0.0.1:6399/0"), SlotLock)
