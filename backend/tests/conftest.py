"""DB 통합 테스트 하네스 (TS-07).

이 파일이 지는 책임은 **격리와 skip** 두 가지다.

격리 — 왜 ``join_transaction_mode="create_savepoint"`` 인가
-----------------------------------------------------------
:func:`~app.services.cancellation.cancel_reservation`은 스스로 ``session.commit()``
을 부른다. 그게 정상이다 — 커밋 이후에야 슬롯 락 해제와 알림을 보내는 순서가
그 함수의 핵심이기 때문이다. 그래서 테스트가 "커밋하지 않는 세션"을 넘겨서 격리를
만들 수는 없다.

대신 한 겹 아래에서 막는다:

1. 커넥션을 하나 연다 (``connection = engine.connect()``)
2. 그 커넥션에 **바깥 트랜잭션**을 건다 (``connection.begin()``)
3. 세션을 그 커넥션에 묶되 ``join_transaction_mode="create_savepoint"``로 만든다
4. 테스트가 끝나면 바깥 트랜잭션을 **rollback**한다

3번이 없으면 서비스의 ``session.commit()``이 바깥 트랜잭션까지 커밋해 버리고,
테스트 데이터가 DB에 그대로 남는다. ``create_savepoint``를 주면 세션은 커밋할 때마다
자기 SAVEPOINT만 RELEASE하고 바깥 트랜잭션은 손대지 않는다. 서비스 코드는 아무것도
모르는 채로 평소처럼 커밋하고, 4번의 rollback 한 번이 전부를 되돌린다.

``cancel_reservation``이 내부에서 쓰는 ``session.begin_nested()``는 이 SAVEPOINT
안에 또 하나의 SAVEPOINT를 만든다. PostgreSQL은 중첩 SAVEPOINT를 지원하므로
유니크 위반 → SAVEPOINT 롤백 경로도 격리 안에서 그대로 재현된다.

**예외: 동시성 테스트.** 락 경합을 재현하려면 커넥션이 2개여야 하는데, 위 픽스처는
커넥션 1개를 공유한다. 같은 커넥션에서는 ``SELECT ... FOR UPDATE``가 서로를
막지 못하므로 이 하네스로는 경합을 만들 수 없다. 그래서 동시성 테스트는
:func:`committed_scenario`를 쓴다 — **실제로 커밋하고, 명시적으로 지운다.**

skip — DB가 없으면 에러가 아니라 skip
--------------------------------------
이 환경에는 Docker가 없다 (Phase 4 F1). ``requires_db`` 마커가 붙은 테스트는
:func:`pytest_runtest_setup`에서 연결을 한 번 확인한 뒤 **skip**된다. ``error``가
아니라 ``skipped``인 것이 중요하다 — 인프라 부재가 테스트 스위트의 신호를 빨갛게
만들면, 진짜 회귀가 섞여 들어와도 아무도 못 알아본다.

수집(collection)은 연결을 요구하지 않는다. ``uv run pytest -m requires_db
--collect-only``는 DB 없이도 대상 테스트를 전부 보여준다.
"""

# 학습 주석: SCH-07(conftest + DB 통합 테스트 작성) 반영
#
# 사전 개념 — 트랜잭션/행 잠금/SAVEPOINT/멱등성의 기본 개념은
# SCH-05(취소 오케스트레이션 서비스 + deps.py)에서 이미 설명했다. 위 모듈
# docstring이 그 개념을 "테스트 격리"라는 새로운 용도에 적용하는 방법을 설명한다.
# 이 파일에서 처음 나오는 개념 하나만 짚는다:
# - pytest fixture(픽스처)란 테스트 함수가 필요로 하는 준비물(DB 세션, 클라이언트
#   등)을 함수 인자 이름으로 자동 주입받는 pytest의 기능이다. `scope="session"`이면
#   테스트 전체에서 한 번만 만들고(예: db_engine), `scope="function"`이면 테스트마다
#   새로 만든다(예: db_session — 매 테스트가 독립된 트랜잭션을 갖게 하려고).
# - `pytest_runtest_setup`은 pytest가 "각 테스트 실행 직전"에 자동으로 불러주는
#   후크(hook)다. 여기서 DB 연결을 확인해 안 되면 그 테스트를 skip 처리한다.

from __future__ import annotations

import uuid
from collections.abc import Generator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, delete, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.adapters.notification import FakeNotificationSender
from app.adapters.payment_gateway import FakePaymentGateway
from app.adapters.slot_lock import NullSlotLock
from app.config import get_settings
from app.db import get_db
from app.deps import (
    get_notification_sender,
    get_payment_gateway,
    get_slot_lock,
)
from app.main import app
from app.models import (
    Academy,
    Base,
    ClassSchedule,
    Order,
    Payment,
    Refund,
    RefundEvent,
    Reservation,
)

#: 연결 확인에 쓰는 제한 시간(초). DB가 없을 때 스위트 전체가 멈추면 안 된다.
#: libpq의 ``connect_timeout``이라 초 단위 정수여야 한다.
CONNECT_TIMEOUT_SECONDS = 3

#: 동시성 테스트에서 락 대기 상한. 이게 없으면 잠금 버그가 "실패"가 아니라
#: "영원히 멈춘 pytest"로 나타나 원인을 못 찾는다.
LOCK_TIMEOUT = "20s"

#: 기본 비율표. 24시간 이상은 플랫폼 고정 100%라 표를 보지 않으므로,
#: 이 표는 24시간 **미만** 구간에서만 의미가 있다 (내림차순 — 스키마가 강제한다).
DEFAULT_REFUND_TIERS: list[dict[str, int]] = [
    {"hours_before_start": 12, "refund_rate_bp": 5000},
    {"hours_before_start": 3, "refund_rate_bp": 0},
]


# --------------------------------------------------------------------------- #
# DB 가용성 판정
# --------------------------------------------------------------------------- #


def test_database_url() -> str:
    """테스트 DB URL. ``TEST_DATABASE_URL`` 환경변수 → ``.env`` → 기본값 순."""
    return get_settings().test_database_url


def _redacted(url: str) -> str:
    """비밀번호를 가린 URL. skip 사유가 로그·CI 출력에 그대로 찍히기 때문이다."""
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:  # pragma: no cover - URL 파싱 실패는 아래 메시지로 충분하다
        return "<파싱할 수 없는 URL>"


@lru_cache(maxsize=1)
def _engine_or_reason() -> tuple[Engine | None, str | None]:
    """엔진을 만들고 연결을 한 번 확인한다. 결과는 프로세스 단위로 캐시된다.

    Returns:
        ``(engine, None)`` 또는 ``(None, skip 사유)``. **예외를 올리지 않는다** —
        DB 부재는 테스트의 실패가 아니라 실행 조건 미충족이다.
    """
    url = test_database_url()
    try:
        engine = create_engine(
            url,
            future=True,
            pool_pre_ping=True,
            connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS},
        )
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except Exception as exc:
        return None, (
            f"테스트 DB에 연결할 수 없어 건너뜁니다 ({_redacted(url)}): "
            f"{type(exc).__name__}: {exc}"
        )
    return engine, None


def pytest_runtest_setup(item: pytest.Item) -> None:
    """``requires_db`` 마커가 붙은 테스트를 DB 없을 때 skip한다.

    수집이 아니라 **setup** 단계에서 판정한다. 수집 단계에서 걸러내면
    ``--collect-only``가 대상 테스트를 보여주지 못해 "무엇이 안 돌고 있는지"를
    확인할 방법이 사라진다 (TS-07 완료 기준).
    """
    if item.get_closest_marker("requires_db") is None:
        return
    _, reason = _engine_or_reason()
    if reason is not None:
        pytest.skip(reason)


# --------------------------------------------------------------------------- #
# 엔진 · 커넥션 · 세션
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="session")
def db_engine() -> Engine:
    """세션 스코프 엔진. 스키마는 ``Base.metadata.create_all()``로 만든다.

    alembic을 돌리지 않는 이유: 마이그레이션 up/down 검증은 **별도 태스크**(TS-11)의
    일이고, 통합 테스트가 그것까지 겸하면 마이그레이션이 깨졌을 때 취소 로직 테스트가
    같이 빨개져서 원인이 섞인다. 모델과 마이그레이션의 일치는 TS-11이 autogenerate
    빈 diff로 따로 보장한다.
    """
    engine, reason = _engine_or_reason()
    if engine is None:
        pytest.skip(reason or "테스트 DB를 사용할 수 없습니다.")
    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def db_connection(db_engine: Engine) -> Iterator[Connection]:
    """커넥션 1개 + 바깥 트랜잭션. 테스트가 끝나면 무조건 rollback한다."""
    connection = db_engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()


@pytest.fixture
def db_session(db_connection: Connection) -> Iterator[Session]:
    """바깥 트랜잭션 안의 SAVEPOINT에 묶인 세션.

    ``autoflush``/``expire_on_commit`` 설정은 :data:`app.db.SessionLocal`과 같게
    맞춘다. 다르게 두면 프로덕션에서만 나는 flush 타이밍 버그를 테스트가 못 잡는다.
    """
    session = Session(
        bind=db_connection,
        autoflush=False,
        expire_on_commit=False,
        # 이 한 줄이 격리의 전부다. 모듈 docstring 참조.
        join_transaction_mode="create_savepoint",
    )
    try:
        yield session
    finally:
        session.close()


# --------------------------------------------------------------------------- #
# Fake 어댑터 3종
# --------------------------------------------------------------------------- #


@pytest.fixture
def payment_gateway() -> FakePaymentGateway:
    """테스트마다 새 인스턴스. 원장이 인메모리라 공유하면 멱등 판정이 새어 나간다."""
    return FakePaymentGateway()


@pytest.fixture
def notification_sender() -> FakeNotificationSender:
    return FakeNotificationSender()


@pytest.fixture
def slot_lock() -> NullSlotLock:
    """Redis를 쓰지 않는 슬롯 락. 해제 호출 여부만 기록한다."""
    return NullSlotLock()


# --------------------------------------------------------------------------- #
# API 클라이언트
# --------------------------------------------------------------------------- #


@pytest.fixture
def api_client(
    db_session: Session,
    payment_gateway: FakePaymentGateway,
    notification_sender: FakeNotificationSender,
    slot_lock: NullSlotLock,
) -> Generator[TestClient, None, None]:
    """의존성이 전부 갈아끼워진 ``TestClient``.

    ``get_db``를 롤백 세션으로 덮는 것이 핵심이다. 덮지 않으면 라우터가
    :data:`app.db.SessionLocal`로 **다른 커넥션**을 열어, 테스트가 넣은 데이터를
    보지 못한다 (바깥 트랜잭션이 아직 커밋되지 않았으므로).

    :func:`app.deps.get_payment_gateway` 등은 ``lru_cache``된 프로세스 싱글턴을
    돌려준다. 덮지 않으면 테스트 간에 PG 원장이 공유돼 멱등 판정이 오염된다.
    """
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[get_payment_gateway] = lambda: payment_gateway
    app.dependency_overrides[get_notification_sender] = lambda: notification_sender
    app.dependency_overrides[get_slot_lock] = lambda: slot_lock
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def auth_headers(user_id: uuid.UUID) -> dict[str, str]:
    """임시 인증 헤더 (F7). 서명도 검증도 없다 — ``app.deps.current_user_id`` 참조."""
    return {"X-User-Id": str(user_id)}


def refund_account_payload() -> dict[str, str]:
    """가상계좌 환불 수취 계좌. 어댑터가 계좌 없는 가상계좌 환불을 실패로 돌린다."""
    return {
        "bank_code": "0004",
        "account_number": "1002-333-444555",
        "holder_name": "임채웅",
    }


# --------------------------------------------------------------------------- #
# 시나리오 데이터
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Scenario:
    """취소 1건을 돌리는 데 필요한 행들의 식별자 묶음.

    ORM 객체가 아니라 **식별자**를 들고 다닌다. 동시성 테스트는 세션을 여러 개 쓰는데,
    한 세션에 붙은 객체를 다른 세션에서 건드리면 DetachedInstanceError가 난다.
    """

    academy_id: uuid.UUID
    class_schedule_id: uuid.UUID
    order_id: uuid.UUID
    payment_id: uuid.UUID
    reservation_id: uuid.UUID
    user_id: uuid.UUID
    gateway_payment_key: str
    paid_amount: int
    capacity: int
    reserved_count: int
    starts_at: datetime


def build_scenario(
    session: Session,
    *,
    now: datetime | None = None,
    hours_until_start: float = 48,
    paid_amount: int = 50_000,
    tiers: list[dict[str, int]] | None = None,
    reservation_status: str = "confirmed",
    order_status: str = "paid",
    payment_method: str = "virtual_account",
    paid: bool = True,
    capacity: int = 10,
    reserved_count: int = 3,
    user_id: uuid.UUID | None = None,
) -> Scenario:
    """학원→일정→주문→결제→예약 한 줄을 만든다. **commit은 호출자가 한다.**

    커밋을 여기서 하지 않는 이유: 롤백 픽스처를 쓰는 테스트는 커밋하면 안 되고
    (SAVEPOINT가 풀린다), 동시성 테스트는 반드시 커밋해야 한다. 판단을 호출자에게
    남겨 두면 픽스처 한 벌로 둘 다 쓸 수 있다.
    """
    now = now or datetime.now(UTC)
    resolved_user_id = user_id or uuid.uuid4()
    gateway_payment_key = f"pay_{uuid.uuid4().hex[:16]}"
    starts_at = now + timedelta(hours=hours_until_start)

    academy = Academy(
        id=uuid.uuid4(),
        name="테스트 스튜디오",
        refund_policy_tiers=(
            DEFAULT_REFUND_TIERS if tiers is None else tiers
        ),
    )
    schedule = ClassSchedule(
        id=uuid.uuid4(),
        academy_id=academy.id,
        starts_at=starts_at,
        price_amount=paid_amount,
        capacity=capacity,
        reserved_count=reserved_count,
    )
    order = Order(
        id=uuid.uuid4(),
        user_id=resolved_user_id,
        status=order_status,
        total_amount=paid_amount,
    )
    payment = Payment(
        id=uuid.uuid4(),
        order_id=order.id,
        method=payment_method,
        amount=paid_amount,
        # paid_at이 None이면 _find_paid_payment가 못 찾아 409(paid_payment_not_found)가
        # 난다. "결제 원거래 없음" 케이스는 paid=False로 명시한다.
        paid_at=now - timedelta(days=1) if paid else None,
        gateway_payment_key=gateway_payment_key,
    )
    reservation = Reservation(
        id=uuid.uuid4(),
        order_id=order.id,
        class_schedule_id=schedule.id,
        user_id=resolved_user_id,
        status=reservation_status,
        cancelled_at=now if reservation_status == "cancelled" else None,
    )

    session.add_all([academy, schedule, order, payment, reservation])
    session.flush()

    return Scenario(
        academy_id=academy.id,
        class_schedule_id=schedule.id,
        order_id=order.id,
        payment_id=payment.id,
        reservation_id=reservation.id,
        user_id=resolved_user_id,
        gateway_payment_key=gateway_payment_key,
        paid_amount=paid_amount,
        capacity=capacity,
        reserved_count=reserved_count,
        starts_at=starts_at,
    )


@pytest.fixture
def scenario(db_session: Session) -> Scenario:
    """기본 시나리오 — 48시간 뒤 수업, 가상계좌 5만원 결제, 정원 10 중 3명."""
    return build_scenario(db_session)


def purge_scenario(engine: Engine, target: Scenario) -> None:
    """시나리오가 만든 행을 **명시적으로** 지운다 (동시성 테스트 전용).

    FK가 전부 ``ON DELETE CASCADE``라 학원 하나만 지워도 대부분 따라 지워지지만,
    그러면 무엇이 지워지고 무엇이 남는지가 스키마를 읽어야만 보인다. 정리 누락은
    다음 실행을 오염시키므로 순서를 눈에 보이게 적는다.
    """
    with Session(bind=engine) as session:
        refund_ids = select(Refund.id).where(
            Refund.reservation_id == target.reservation_id
        )
        session.execute(delete(RefundEvent).where(RefundEvent.refund_id.in_(refund_ids)))
        session.execute(
            delete(Refund).where(Refund.reservation_id == target.reservation_id)
        )
        session.execute(
            delete(Reservation).where(Reservation.id == target.reservation_id)
        )
        session.execute(delete(Payment).where(Payment.order_id == target.order_id))
        session.execute(delete(Order).where(Order.id == target.order_id))
        session.execute(
            delete(ClassSchedule).where(ClassSchedule.id == target.class_schedule_id)
        )
        session.execute(delete(Academy).where(Academy.id == target.academy_id))
        session.commit()


@pytest.fixture
def committed_scenario(db_engine: Engine) -> Iterator[Scenario]:
    """**커밋된** 시나리오. 롤백 픽스처 밖이다.

    동시성 테스트에만 쓴다. 두 커넥션이 같은 예약 행을 두고 ``SELECT ... FOR UPDATE``
    로 경합하려면, 그 행이 **양쪽 커넥션에서 보여야** 한다 — 즉 커밋돼 있어야 한다.
    :func:`db_session`의 바깥 트랜잭션 안에 있는 행은 다른 커넥션에 보이지 않으므로
    그 픽스처로는 이 상황을 만들 수 없다.

    자동 롤백이 없으니 정리도 자동이 아니다. :func:`purge_scenario`가 teardown에서
    반드시 돌도록 ``finally``에 둔다.
    """
    with Session(bind=db_engine, expire_on_commit=False) as session:
        created = build_scenario(session)
        session.commit()
    try:
        yield created
    finally:
        purge_scenario(db_engine, created)


# --------------------------------------------------------------------------- #
# 단정 헬퍼
# --------------------------------------------------------------------------- #


def fetch_refunds(session: Session, reservation_id: uuid.UUID) -> list[Refund]:
    """예약에 딸린 환불 행 전부 (실패 건 포함). 생성 순."""
    return list(
        session.execute(
            select(Refund)
            .where(Refund.reservation_id == reservation_id)
            .order_by(Refund.created_at)
        ).scalars()
    )


def fetch_event_types(session: Session, refund_id: uuid.UUID) -> list[str]:
    """감사 로그의 ``event_type``들. append-only라 순서가 곧 처리 순서다."""
    return list(
        session.execute(
            select(RefundEvent.event_type)
            .where(RefundEvent.refund_id == refund_id)
            .order_by(RefundEvent.created_at)
        ).scalars()
    )


def fetch_reserved_count(session: Session, class_schedule_id: uuid.UUID) -> int:
    return session.execute(
        select(ClassSchedule.reserved_count).where(
            ClassSchedule.id == class_schedule_id
        )
    ).scalar_one()


def read_committed(engine: Engine, statement: Any) -> Any:
    """커밋된 상태를 **새 커넥션**에서 읽는다 (동시성 테스트용)."""
    with Session(bind=engine) as session:
        return session.execute(statement).scalar_one()
