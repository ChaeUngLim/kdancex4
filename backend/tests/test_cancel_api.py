"""``POST /reservations/{id}/cancel`` DB 통합 테스트 (TS-07).

여기서 검증하는 것은 **여러 계층이 합류했을 때의 결과**다. 라우터·스키마·서비스·
어댑터·모델 각각은 이미 자기 단위 테스트(``test_schemas.py`` ·
``test_cancellation_service.py`` · ``test_adapters.py`` · ``test_refund_policy.py``)가
있다. 그 테스트들이 못 잡는 것이 둘 있다:

1. **트랜잭션 경계** — 환불 행·예약 상태·정원·감사 로그가 정말 한 덩어리로
   커밋되는가, PG가 실패하면 정말 아무것도 바뀌지 않는가.
2. **행 잠금** — 같은 예약에 취소 요청이 동시에 2건 들어와도 환불이 1회만
   실행되는가. 이건 커넥션이 2개여야만 재현된다.

둘 다 실 PostgreSQL이 없으면 확인할 방법이 없으므로 이 파일의 모든 테스트에는
``requires_db`` 마커가 붙는다 (모듈 하단이 아니라 :data:`pytestmark`로 한 번에
붙인다 — 개별 데코레이터를 빠뜨릴 여지를 없애기 위해서다). DB가 없으면 ``error``가
아니라 ``skipped``로 나온다 (``conftest.py`` 참조).

격리 두 가지가 섞여 있다
------------------------
* 대부분의 테스트: ``db_session``/``api_client`` — 커넥션 1개 + 바깥 트랜잭션,
  끝나면 rollback. 아무것도 남지 않는다.
* :func:`test_concurrent_cancel_requests_refund_only_once` **하나만**:
  ``db_engine``/``committed_scenario`` — 실제로 커밋하고 teardown에서 지운다.
  롤백 픽스처로는 두 커넥션이 같은 행을 볼 수 없어 경합 자체를 만들 수 없다.
"""

# 학습 주석: SCH-07(conftest + DB 통합 테스트 작성) 반영
#
# 사전 개념 — 행 잠금/멱등성/트랜잭션 기본 개념은 SCH-05(취소 오케스트레이션
# 서비스 + deps.py)에서 이미 설명했다. 여기서 새로 나오는 건 "동시 요청을 실제로
# 만드는 도구"다:
# - `threading.Barrier(2)`는 두 스레드가 "둘 다 준비될 때까지" 기다렸다가 동시에
#   출발하게 만드는 장치다 — 이게 없으면 한쪽이 먼저 끝나버려서 진짜 동시 요청이
#   재현되지 않는다.
# - `ThreadPoolExecutor`는 여러 스레드를 동시에 돌리고 결과를 모아주는 도구다.
# - `SET LOCAL lock_timeout`은 "이 트랜잭션이 잠금을 얼마나 기다릴지" 상한을 거는
#   PostgreSQL 설정이다 — 락 버그가 나면 테스트가 멈추는 대신 실패로 드러나게 한다.

from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session

from app.adapters.notification import FakeNotificationSender
from app.adapters.payment_gateway import FakePaymentGateway
from app.adapters.slot_lock import NullSlotLock
from app.db import get_db
from app.deps import (
    get_notification_sender,
    get_payment_gateway,
    get_slot_lock,
)
from app.main import app
from app.models import ClassSchedule, Refund, Reservation
from app.services.cancellation import RefundEventType
from tests.conftest import (
    LOCK_TIMEOUT,
    Scenario,
    auth_headers,
    build_scenario,
    fetch_event_types,
    fetch_refunds,
    fetch_reserved_count,
    refund_account_payload,
)

#: 이 모듈의 모든 테스트가 실 PostgreSQL을 요구한다. DB가 없으면 전부 skip된다.
#: 개별 함수에 데코레이터를 붙이지 않는 이유는 하나를 빠뜨리면 그 테스트만 DB 없이
#: 돌다 ``error``를 내기 때문이다 — 수집(``-m requires_db --collect-only``)에는
#: 모듈 단위 마커도 개별 마커와 똑같이 잡힌다.
pytestmark = pytest.mark.requires_db


def cancel_url(reservation_id: uuid.UUID) -> str:
    return f"/reservations/{reservation_id}/cancel"


def cancel_body() -> dict[str, dict[str, str]]:
    """가상계좌 환불 요청 본문. 계좌가 없으면 어댑터가 실패 결과를 돌려준다."""
    return {"refund_account": refund_account_payload()}


# --------------------------------------------------------------------------- #
# 정상 취소
# --------------------------------------------------------------------------- #


def test_cancel_succeeds_and_restores_slot(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payment_gateway: FakePaymentGateway,
) -> None:
    """정상 취소 — 200 + 전액 환불 + 좌석 반납.

    기본 시나리오는 수업 시작 48시간 전이다. 24시간 이상 남았으면 학원 비율표와
    무관하게 100%(10000bp)이므로, 이 단정이 깨졌다면 플랫폼 고정 규칙이나 비율표
    적용 순서 중 하나가 무너진 것이다.
    """
    response = api_client.post(
        cancel_url(scenario.reservation_id),
        json=cancel_body(),
        headers=auth_headers(scenario.user_id),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "succeeded"
    assert body["replayed"] is False
    assert body["slot_restored"] is True
    assert body["reservation_status"] == "cancelled"
    assert body["refund_rate_bp"] == 10_000
    assert body["requested_amount"] == scenario.paid_amount
    assert body["refunded_amount"] == scenario.paid_amount
    assert body["failure_code"] is None

    # DB가 응답과 같은 이야기를 하는지 확인한다. 응답만 보면 "계산은 맞았지만
    # 커밋되지 않은" 상태를 못 잡는다.
    refunds = fetch_refunds(db_session, scenario.reservation_id)
    assert len(refunds) == 1
    assert refunds[0].status == "succeeded"
    assert refunds[0].refunded_amount == scenario.paid_amount
    assert refunds[0].refund_account_holder_name == refund_account_payload()[
        "holder_name"
    ]

    reservation = db_session.get(Reservation, scenario.reservation_id)
    db_session.refresh(reservation)
    assert reservation.status == "cancelled"
    assert reservation.cancelled_at is not None

    # 좌석 반납. 정원이 아니라 **예약 수**가 1 줄어든다.
    assert fetch_reserved_count(db_session, scenario.class_schedule_id) == (
        scenario.reserved_count - 1
    )

    # 감사 로그는 집합으로만 단정한다. ``created_at``의 기본값이 PostgreSQL
    # ``now()``라 같은 트랜잭션 안의 세 행은 **시각이 전부 같다** — 순서로 단정하면
    # DB가 돌려주는 순서에 따라 깜빡이는 테스트가 된다 (아래 이슈 주석 참조).
    assert set(fetch_event_types(db_session, refunds[0].id)) == {
        RefundEventType.REQUESTED,
        RefundEventType.GATEWAY_SUCCEEDED,
        RefundEventType.RESERVATION_CANCELLED,
    }

    # PG를 정확히 한 번 불렀다.
    assert len(payment_gateway.calls) == 1


def test_cancel_with_pending_gateway_still_restores_slot(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payment_gateway: FakePaymentGateway,
) -> None:
    """``pending``은 실패가 아니다 — 좌석은 반납되고 예약은 취소 확정된다.

    가상계좌 환불은 원거래 취소가 아니라 회원 계좌로의 별도 송금이라 즉시 완결되지
    않는다. 송금을 기다리는 동안 자리를 묶어두면 그 자리는 아무도 못 쓴다.
    ``refunded_amount``가 0인 것도 정상이다 — 아직 건너가지 않은 돈이다.
    """
    payment_gateway.pending_on.add(scenario.gateway_payment_key)

    response = api_client.post(
        cancel_url(scenario.reservation_id),
        json=cancel_body(),
        headers=auth_headers(scenario.user_id),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "pending"
    assert body["refunded_amount"] == 0
    assert body["requested_amount"] == scenario.paid_amount
    assert body["slot_restored"] is True
    assert body["reservation_status"] == "cancelled"

    assert fetch_reserved_count(db_session, scenario.class_schedule_id) == (
        scenario.reserved_count - 1
    )


# --------------------------------------------------------------------------- #
# 거부되는 요청 — 403 / 404 / 409
# --------------------------------------------------------------------------- #


def test_cancel_other_users_reservation_is_forbidden(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payment_gateway: FakePaymentGateway,
) -> None:
    """타인의 예약은 403. 404로 감추지 않는다 (수용 기준)."""
    intruder = uuid.uuid4()
    assert intruder != scenario.user_id

    response = api_client.post(
        cancel_url(scenario.reservation_id),
        json=cancel_body(),
        headers=auth_headers(intruder),
    )

    assert response.status_code == 403
    # 거부는 "아무것도 하지 않았다"까지 확인해야 의미가 있다. 상태 코드만 보면
    # 환불을 만들어 놓고 403을 낸 경우를 못 잡는다.
    assert fetch_refunds(db_session, scenario.reservation_id) == []
    assert payment_gateway.calls == []
    assert fetch_reserved_count(db_session, scenario.class_schedule_id) == (
        scenario.reserved_count
    )


def test_cancel_unknown_reservation_returns_404(
    api_client: TestClient, payment_gateway: FakePaymentGateway
) -> None:
    """존재하지 않는 예약은 404."""
    response = api_client.post(
        cancel_url(uuid.uuid4()),
        json=cancel_body(),
        headers=auth_headers(uuid.uuid4()),
    )

    assert response.status_code == 404
    assert payment_gateway.calls == []


def test_cancel_already_cancelled_reservation_returns_409(
    api_client: TestClient,
    db_session: Session,
    payment_gateway: FakePaymentGateway,
) -> None:
    """환불 기록 없이 이미 취소된 예약은 409.

    **환불 기록이 있는 경우는 여기 오지 않는다** — 그건 중복 요청이고 멱등 재생
    경로가 200으로 받는다 (:func:`test_duplicate_cancel_request_is_replayed`).
    이 테스트가 재현하는 건 미결제 홀드가 만료돼 취소된 예약 같은 경우다.
    """
    target = build_scenario(db_session, reservation_status="cancelled")

    response = api_client.post(
        cancel_url(target.reservation_id),
        json=cancel_body(),
        headers=auth_headers(target.user_id),
    )

    assert response.status_code == 409
    assert payment_gateway.calls == []
    assert fetch_refunds(db_session, target.reservation_id) == []


def test_cancel_after_class_started_returns_409(
    api_client: TestClient,
    db_session: Session,
    payment_gateway: FakePaymentGateway,
) -> None:
    """이미 시작한 수업은 409. 좌석도 돈도 그대로 둔다."""
    target = build_scenario(db_session, hours_until_start=-1)

    response = api_client.post(
        cancel_url(target.reservation_id),
        json=cancel_body(),
        headers=auth_headers(target.user_id),
    )

    assert response.status_code == 409
    assert payment_gateway.calls == []
    assert fetch_reserved_count(db_session, target.class_schedule_id) == (
        target.reserved_count
    )


# --------------------------------------------------------------------------- #
# 멱등성 — 중복 요청
# --------------------------------------------------------------------------- #


def test_duplicate_cancel_request_is_replayed(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payment_gateway: FakePaymentGateway,
) -> None:
    """두 번째 요청은 409가 아니라 **200 + 기존 결과**다.

    수용 기준은 "환불이 1회만 실행된다"이지 "두 번째 요청이 에러난다"가 아니다.
    회원이 취소 버튼을 두 번 눌렀을 때 에러 화면을 띄우면, 실제로는 취소가 됐는데
    안 됐다고 오해하게 된다.

    ``Idempotency-Key`` 헤더를 **일부러 보내지 않는다** — 헤더 없이도 서버가
    결정적 키를 만들어 이중 환불을 막는지가 이 테스트의 핵심이다.
    """
    url = cancel_url(scenario.reservation_id)
    headers = auth_headers(scenario.user_id)

    first = api_client.post(url, json=cancel_body(), headers=headers)
    second = api_client.post(url, json=cancel_body(), headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["replayed"] is False
    assert second.json()["replayed"] is True
    # 같은 환불 행으로 수렴한다.
    assert second.json()["refund_id"] == first.json()["refund_id"]
    # 재생 응답은 좌석을 **다시** 반납하지 않았다고 말한다.
    assert second.json()["slot_restored"] is False

    assert len(fetch_refunds(db_session, scenario.reservation_id)) == 1
    # 이게 이 테스트의 진짜 단정이다 — 정원이 2 줄었으면 이중 환불이 일어난 것이다.
    assert fetch_reserved_count(db_session, scenario.class_schedule_id) == (
        scenario.reserved_count - 1
    )
    # 3단계 멱등 재생이 PG 호출 **앞에서** 끊었다.
    assert len(payment_gateway.calls) == 1


# --------------------------------------------------------------------------- #
# PG 실패
# --------------------------------------------------------------------------- #


def test_gateway_failure_records_reason_and_keeps_reservation(
    api_client: TestClient,
    db_session: Session,
    scenario: Scenario,
    payment_gateway: FakePaymentGateway,
) -> None:
    """PG 환불 실패 — 200이지만 ``status="failed"``이고 **좌석은 그대로다.**

    환불이 실패했는데 좌석까지 없애면 회원은 자리도 돈도 잃는다. 그래서 실패 시엔
    예약·정원을 건드리지 않고 사유만 남긴다.

    HTTP 상태가 200인 것도 의도다. 요청 자체는 정상 처리됐고(환불 행과 감사 로그가
    남았다) 결과가 실패인 것이라, 비-2xx로 바꾸면 실패 사유를 담은 본문이 클라이언트의
    에러 처리로 빨려 들어가 회원에게 이유를 못 보여준다.
    """
    payment_gateway.fail_on.add(scenario.gateway_payment_key)

    response = api_client.post(
        cancel_url(scenario.reservation_id),
        json=cancel_body(),
        headers=auth_headers(scenario.user_id),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert body["failure_code"] == payment_gateway.failure_code
    assert body["failure_message"] == payment_gateway.failure_message
    assert body["slot_restored"] is False
    assert body["reservation_status"] != "cancelled"
    assert body["refunded_amount"] == 0

    # 실패 사유가 DB에도 남았다 (수용 기준: 실패 시 상태·사유 기록).
    refunds = fetch_refunds(db_session, scenario.reservation_id)
    assert len(refunds) == 1
    assert refunds[0].status == "failed"
    assert refunds[0].failure_code == payment_gateway.failure_code
    assert refunds[0].failure_message == payment_gateway.failure_message
    assert set(fetch_event_types(db_session, refunds[0].id)) == {
        RefundEventType.REQUESTED,
        RefundEventType.GATEWAY_FAILED,
    }

    # 좌석과 예약은 손대지 않았다.
    reservation = db_session.get(Reservation, scenario.reservation_id)
    db_session.refresh(reservation)
    assert reservation.status == "confirmed"
    assert reservation.cancelled_at is None
    assert fetch_reserved_count(db_session, scenario.class_schedule_id) == (
        scenario.reserved_count
    )


# --------------------------------------------------------------------------- #
# 동시 요청 — 여기서부터는 롤백 픽스처를 쓰지 않는다
# --------------------------------------------------------------------------- #


@contextmanager
def committed_clients(
    engine: Engine,
    *,
    payment_gateway: FakePaymentGateway,
    notification_sender: FakeNotificationSender,
    slot_lock: NullSlotLock,
    count: int,
) -> Iterator[list[TestClient]]:
    """요청마다 **새 커넥션**에서 실제로 커밋하는 ``TestClient``를 ``count``개 만든다.

    ``conftest.py``의 :func:`api_client`를 쓰지 않는 이유가 이 함수의 존재 이유
    전부다. 그 픽스처는 커넥션 하나를 모든 요청이 공유하게 만든다. 같은 커넥션에서는
    ``SELECT ... FOR UPDATE``가 서로를 막지 않으므로(잠금의 소유자가 같다) 경합을
    재현할 수 없고, 바깥 트랜잭션이 커밋되지 않아 다른 커넥션에서 예약 행이 보이지도
    않는다.

    정리는 호출자의 몫이다 — 커밋한 데이터는 ``purge_scenario``가 지운다
    (``committed_scenario`` 픽스처의 teardown).
    """

    def override_get_db() -> Iterator[Session]:
        session = Session(bind=engine, autoflush=False, expire_on_commit=False)
        try:
            # 락 대기 상한. 이게 없으면 잠금 버그가 "실패"가 아니라 "영원히 멈춘
            # pytest"로 나타나 원인을 못 찾는다. ``SET LOCAL``이라 이 트랜잭션에만
            # 적용되고 커넥션이 풀로 돌아갈 때 남지 않는다.
            session.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_payment_gateway] = lambda: payment_gateway
    app.dependency_overrides[get_notification_sender] = lambda: notification_sender
    app.dependency_overrides[get_slot_lock] = lambda: slot_lock
    # 클라이언트를 스레드 수만큼 따로 만든다. 하나를 공유해도 대개 동작하지만,
    # 동시성 테스트가 테스트 도구의 동시성 문제로 깜빡이면 진단이 두 배로 어려워진다.
    clients = [TestClient(app) for _ in range(count)]
    try:
        yield clients
    finally:
        for client in clients:
            client.close()
        app.dependency_overrides.clear()


def test_concurrent_cancel_requests_refund_only_once(
    db_engine: Engine,
    committed_scenario: Scenario,
) -> None:
    """같은 예약에 취소 요청 2건이 **동시에** 들어와도 환불은 1회만 실행된다.

    이 테스트만 ``db_engine``/``committed_scenario``를 쓴다 — 롤백 픽스처
    (``db_session``/``api_client``)에 의존하지 않는다. 이유는
    :func:`committed_clients` 참조.

    :class:`threading.Barrier`로 두 요청의 출발선을 맞춘다. 그래도 실제로 잠금
    경합이 났는지는 스케줄러가 정한다 — 그래서 단정은 "경합이 났다"가 아니라
    **"어느 순서로 실행되든 환불은 1건"**이다. 경합이 안 난 실행에서도 이 불변식은
    성립해야 하고, 깨진다면 그건 진짜 버그다.
    """
    payment_gateway = FakePaymentGateway()
    notification_sender = FakeNotificationSender()
    slot_lock = NullSlotLock()

    url = cancel_url(committed_scenario.reservation_id)
    headers = auth_headers(committed_scenario.user_id)
    body = cancel_body()
    start_line = threading.Barrier(2)

    def send(client: TestClient) -> tuple[int, dict]:
        start_line.wait(timeout=30)
        response = client.post(url, json=body, headers=headers)
        return response.status_code, response.json()

    with committed_clients(
        db_engine,
        payment_gateway=payment_gateway,
        notification_sender=notification_sender,
        slot_lock=slot_lock,
        count=2,
    ) as clients:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(send, client) for client in clients]
            results = [future.result(timeout=60) for future in futures]

    statuses = [status_code for status_code, _ in results]
    bodies = [payload for _, payload in results]

    # 중복 요청은 409가 아니라 200이다 — 둘 다.
    assert statuses == [200, 200]
    # 같은 환불 행으로 수렴했다.
    assert bodies[0]["refund_id"] == bodies[1]["refund_id"]
    # 정확히 한 쪽만 "내가 만들었다"고 말한다. 둘 다 False면 환불이 아예 안 생긴
    # 것이고, 둘 다 True면 이중 환불이다.
    assert [payload["replayed"] for payload in bodies].count(False) == 1
    assert [payload["slot_restored"] for payload in bodies].count(True) == 1

    # 커밋된 상태를 **새 커넥션**에서 확인한다. 위 두 요청의 세션은 이미 닫혔다.
    with Session(bind=db_engine) as verifier:
        refund_count = verifier.execute(
            select(func.count())
            .select_from(Refund)
            .where(Refund.reservation_id == committed_scenario.reservation_id)
        ).scalar_one()
        reserved_count = verifier.execute(
            select(ClassSchedule.reserved_count).where(
                ClassSchedule.id == committed_scenario.class_schedule_id
            )
        ).scalar_one()
        reservation_status = verifier.execute(
            select(Reservation.status).where(
                Reservation.id == committed_scenario.reservation_id
            )
        ).scalar_one()

    assert refund_count == 1
    # 정원이 2 줄었다면 좌석이 두 번 반납된 것이고, 그건 환불도 두 번 나갔다는 뜻이다.
    assert reserved_count == committed_scenario.reserved_count - 1
    assert reservation_status == "cancelled"
    # PG는 한 번만 맞았다. 3단계 멱등 재생이 두 번째 요청을 PG 앞에서 끊는다.
    assert len(payment_gateway.calls) == 1
