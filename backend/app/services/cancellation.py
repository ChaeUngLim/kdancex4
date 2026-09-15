"""예약 취소 오케스트레이션.

TS-02(모델) · TS-03(환불액 산정) · TS-04(어댑터 3종)가 여기서 합류한다. 이 모듈이
지는 책임은 **순서와 경계**다. 금액을 계산하지도(``services/refund_policy.py``),
PG를 직접 때리지도(``adapters/payment_gateway.py``) 않는다.

취소 1건의 순서 (Phase 3 §2.5 / Phase 4 TS-05)
----------------------------------------------
1. ``SELECT ... FOR UPDATE``로 ``reservations`` 행을 잠근다 — 경합의 1차 방어선
2. 소유권 검증 (타인 예약이면 403)
3. **멱등 재생(replay) 검사** — 이미 진행중/성공한 환불이 있으면 그 결과를 그대로 돌려준다
4. 상태 전이 검증 (이미 취소 / 이미 시작·종료 거부)
5. 결제 원거래 확인 → 환불액 산정 (``calculate_refund``)
6. ``Refund`` INSERT — 유니크 위반이면 기존 행을 돌려준다 (아래 "멱등성" 참조)
7. PG 환불 호출
8. 성공·대기면 예약 취소 확정 + ``class_schedules.reserved_count -= 1`` + 주문 상태 갱신
9. ``refund_events`` INSERT (append-only 감사 로그)
10. **commit**
11. 커밋 **이후** 슬롯 락 해제 + 회원/학원 관리자 2방향 알림

10번과 11번의 순서가 핵심이다. 락 해제와 알림은 **커밋이 끝난 뒤에** 한다. 롤백될지도
모르는 트랜잭션을 근거로 회원에게 "취소됐습니다"를 보내면 안 되고, 반대로 캐시·푸시
장애가 이미 확정된 환불을 되돌려서도 안 된다.

멱등성 — "환불은 1회만 실행된다"
--------------------------------
수용 기준은 *환불이 한 번만 실행되는 것*이지 *두 번째 요청이 에러가 되는 것*이 아니다.
그래서 중복 요청에 409를 주지 않고 **기존 결과를 200으로 되돌려준다**
(:attr:`CancellationOutcome.replayed` 가 ``True``). 근거는 3겹이되 권위는 DB 하나다
(Phase 3 D5):

* ``refunds`` 부분 유니크 인덱스 ``UNIQUE (reservation_id) WHERE status <> 'failed'``
* ``refunds.idempotency_key`` UNIQUE
* 위 둘을 정상 경로에서 안 보이게 해 주는 ``SELECT ... FOR UPDATE``

``Idempotency-Key`` 헤더는 **선택**이다. 없으면 :func:`build_idempotency_key`가
``sha256("cancel:" + reservation_id)``로 결정적 키를 만든다 — 헤더를 안 보내는
클라이언트도 이중 환불을 낼 수 없다.

PG 실패 시 예약을 취소하지 않는 이유
------------------------------------
환불이 실패했는데 좌석까지 없애면 회원은 **자리도 돈도 잃는다.** 그래서 PG가 실패를
돌려주면 ``Refund`` 행을 ``failed``로 남기고(실패 사유 포함) 예약·정원은 건드리지
않는다. ``failed``는 부분 유니크 인덱스에서 제외되므로 회원이 그대로 재시도할 수 있다.

``pending``은 실패가 아니다
---------------------------
가상계좌 환불은 원거래 취소가 아니라 회원 계좌로의 별도 송금이라 즉시 완결되지 않는다.
``pending``에서도 **좌석은 반납되고 예약은 취소 확정**된다 — 송금 완료를 기다리는 동안
자리를 묶어둘 이유가 없다.
"""

# 학습 주석: SCH-05(취소 오케스트레이션 서비스 + deps.py), SCH-06(Pydantic 스키마 +
# 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용 — 아래 4가지를 모르면 이 파일이 왜 이렇게
# 짜여 있는지 이해하기 어렵다)
#
# - 트랜잭션(transaction): 여러 DB 작업(INSERT/UPDATE 등)을 "전부 성공 아니면
#   전부 취소"로 묶는 단위다. ``session.commit()``을 부르면 그때까지의 변경이
#   전부 확정되고, 그 전에 예외가 나서 세션이 롤백되면 전부 없었던 일이 된다.
#   이 파일이 환불 INSERT·예약 상태 변경·정원 감소를 한 번의 commit()으로 묶는
#   이유는 "환불만 되고 예약은 그대로다" 같은 어중간한 상태를 DB에 절대 남기지
#   않기 위해서다.
# - 행 잠금(row lock, ``SELECT ... FOR UPDATE``): 트랜잭션이 특정 행을 다 쓸
#   때까지 다른 트랜잭션이 같은 행을 못 건드리게(대기시키게) 막는 것. 같은
#   예약을 두 요청이 동시에 취소하려 하면, 뒤 요청은 이 잠금에서 대기하다가
#   앞 요청이 커밋을 마친 뒤에야 진행된다 — 그래서 "같은 예약에 환불 두 건"이
#   생기는 경합이 원천 차단된다.
# - 멱등성(idempotency): 같은 요청을 실수로(또는 네트워크 재시도로) 여러 번
#   보내도 실제로는 "처음 한 번"과 똑같은 결과가 나오는 성질. 이 파일은 두 번째
#   요청에 에러(409)를 주는 대신 **첫 번째 요청이 만든 결과를 그대로 200으로
#   돌려주는 방식**으로 멱등성을 구현한다.
# - SAVEPOINT(중첩 트랜잭션, ``session.begin_nested()``): 큰 트랜잭션 안에 심어
#   두는 작은 "체크포인트". 그 안에서만 실패(예: 유니크 제약 위반)해도 SAVEPOINT
#   지점까지만 되돌아가고, 바깥 트랜잭션(1번에서 건 행 잠금 포함)은 그대로
#   살아있다. 만약 SAVEPOINT 없이 바깥 트랜잭션 전체를 롤백했다면, 1번의 행
#   잠금까지 풀려서 애써 막아둔 경합이 다시 열려버린다.
#
# Protocol/어댑터 패턴 자체는 SCH-04(어댑터 3종: PG/알림/슬롯락)에서 이미
# 설명했으므로 여기서 반복하지 않는다. FastAPI 의존성 주입(``Depends()``)이
# 실제로 무엇을 하는지, 그리고 그것이 왜 위 Protocol과 연결되는지는
# ``app/deps.py``의 학습 주석을 참고.

from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.adapters.notification import NotificationEvent, NotificationSender
from app.adapters.payment_gateway import (
    PaymentGateway,
    RefundAccount,
    RefundRequest,
    RefundResult,
    RefundStatus,
    UnsupportedPaymentMethodError,
)
from app.adapters.slot_lock import SlotLock
from app.models.academy import Academy
from app.models.class_schedule import ClassSchedule
from app.models.order import Order
from app.models.payment import Payment
from app.models.refund import Refund
from app.models.refund_event import RefundEvent
from app.models.reservation import Reservation
from app.services.refund_policy import (
    CancellationReason,
    RefundCalculation,
    calculate_refund,
)

__all__ = [
    "ACTIVE_REFUND_STATUSES",
    "CancellationError",
    "CancellationOutcome",
    "CancellationPreview",
    "ClassAlreadyStartedError",
    "PaidPaymentNotFoundError",
    "RefundEventType",
    "ReservationAlreadyCancelledError",
    "ReservationNotCancellableError",
    "ReservationNotFoundError",
    "ReservationOwnershipError",
    "UnsupportedRefundMethodError",
    "build_idempotency_key",
    "cancel_reservation",
    "preview_cancellation",
]

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# 값 집합
# --------------------------------------------------------------------------- #

#: 예약 취소가 가능한 ``reservations.status`` 값. 공유 계약 §4.1의
#: ``{held, confirmed, cancelled}`` 중 ``cancelled``를 뺀 나머지다.
CANCELLABLE_RESERVATION_STATUSES: frozenset[str] = frozenset({"held", "confirmed"})

#: 부분 유니크 인덱스 ``WHERE status <> 'failed'``가 덮는 상태.
#: 이 상태의 환불이 이미 있으면 새로 만들지 않고 그대로 돌려준다.
ACTIVE_REFUND_STATUSES: frozenset[str] = frozenset(
    {RefundStatus.SUCCEEDED.value, RefundStatus.PENDING.value}
)

#: 멱등 키를 서버가 생성할 때 쓰는 접두사. 바꾸면 기존 요청과 다른 키가 나오므로
#: **고정값이다** (Phase 4 TS-05: ``sha256("cancel:" + reservation_id)``).
IDEMPOTENCY_KEY_PREFIX = "cancel:"

#: 카드 결제 환불 시도에 쓰는 실패 코드. 어댑터의
#: :class:`~app.adapters.payment_gateway.UnsupportedPaymentMethodError`를 감사 로그와
#: ``refunds.failure_code``에 남길 때의 표기다.
UNSUPPORTED_METHOD_CODE = "UNSUPPORTED_PAYMENT_METHOD"


class RefundEventType:
    """``refund_events.event_type`` 값. append-only 감사 로그의 사건 종류다.

    ``StrEnum``이 아니라 문자열 상수 모음인 이유: 이 값은 DB에 그대로 적히고
    CHECK 제약이 없다. 나중에 사건이 늘어나도 과거 행을 건드리지 않아야 하므로
    닫힌 값 집합으로 선언하지 않는다.
    """

    REQUESTED = "refund_requested"
    GATEWAY_SUCCEEDED = "gateway_succeeded"
    GATEWAY_PENDING = "gateway_pending"
    GATEWAY_FAILED = "gateway_failed"
    UNSUPPORTED_METHOD = "gateway_unsupported_method"
    RESERVATION_CANCELLED = "reservation_cancelled"


# --------------------------------------------------------------------------- #
# 예외 — HTTP 상태 코드를 값으로 들고 다닌다
# --------------------------------------------------------------------------- #


class CancellationError(Exception):
    """취소 오케스트레이션이 거부한 요청.

    ``status_code``를 예외에 실어두는 이유: 라우터(TS-06)가 예외 타입마다
    ``if/elif``로 코드를 되찾는 대신 ``exc.status_code``를 그대로 쓸 수 있다.
    분기가 한 군데 늘 때마다 라우터를 고치지 않아도 된다.

    FastAPI를 import하지 않는다 — 서비스 계층이 웹 프레임워크에 묶이면 단위
    테스트가 무거워진다. ``status_code``는 그냥 정수다.
    """

    status_code = 400
    code = "cancellation_error"

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class ReservationNotFoundError(CancellationError):
    """해당 예약이 없다."""

    status_code = 404
    code = "reservation_not_found"


class ReservationOwnershipError(CancellationError):
    """타인의 예약을 취소하려 했다.

    404가 아니라 **403**이다. 수용 기준이 "본인 예약만 취소, 타인 403"을 명시한다.
    (존재 여부를 숨기는 404 관례와는 다른 선택이지만, 기준이 먼저다.)
    """

    status_code = 403
    code = "reservation_forbidden"


class ReservationAlreadyCancelledError(CancellationError):
    """이미 취소된 예약이다.

    같은 예약의 **환불 기록이 남아 있는 경우엔 여기까지 오지 않는다** — 3단계 멱등
    재생 검사가 기존 결과를 200으로 돌려준다. 이 예외는 환불 없이 취소된 예약
    (예: 미결제 홀드 만료)을 다시 취소하려는 경우에만 난다.
    """

    status_code = 409
    code = "reservation_already_cancelled"


class ReservationNotCancellableError(CancellationError):
    """취소 가능한 상태가 아니다 (공유 계약 §4.1 밖의 값)."""

    status_code = 409
    code = "reservation_not_cancellable"


class ClassAlreadyStartedError(CancellationError):
    """수업이 이미 시작했거나 끝났다.

    ``class_schedules``에는 종료 시각 컬럼이 없다. 시작 시각이 지났으면 진행 중이든
    종료됐든 취소 대상이 아니므로 한 판정으로 묶는다.
    """

    status_code = 409
    code = "class_already_started"


class PaidPaymentNotFoundError(CancellationError):
    """결제 완료된 원거래가 없다 — 돌려줄 돈이 없다.

    이번 슬라이스에 결제 생성 경로가 없어서(F6) 실제로는 픽스처로 만든 데이터에서만
    발생한다. 조용히 0원 환불을 만들지 않고 거부한다.
    """

    status_code = 409
    code = "paid_payment_not_found"


class UnsupportedRefundMethodError(CancellationError):
    """이번 슬라이스가 환불을 지원하지 않는 결제수단이다 (카드 — Q2 확정상 범위 밖).

    어댑터의 :class:`~app.adapters.payment_gateway.UnsupportedPaymentMethodError`를
    **여기서 잡아 이 예외로 바꾼다.** 그대로 새 나가면 라우터가 HTTP 500을 내고,
    "서버가 고장났다"와 "이 결제수단은 아직 지원하지 않는다"가 구분되지 않는다.
    """

    status_code = 422
    code = "unsupported_payment_method"


# --------------------------------------------------------------------------- #
# 결과 모델
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class CancellationOutcome:
    """취소 1건의 결과. 라우터(TS-06)가 이걸 응답 스키마로 옮긴다.

    Attributes:
        reservation_id: 취소 대상 예약.
        refund_id: 생성(또는 재사용)된 ``refunds`` 행.
        status: 환불 상태. ``pending``은 **정상**이다.
        requested_amount: 산정된 환불액(원).
        refunded_amount: 실제로 회원에게 건너간 금액(원). ``pending``이면 아직 0이다.
        refund_rate_bp: 적용된 환불율(basis point).
        hours_before_start: 취소 시점 기준 수업 시작까지 남은 시간(시, 내림).
        reservation_status: 처리 후 예약 상태. PG 실패 시엔 취소되지 않고 그대로다.
        slot_restored: ``reserved_count``를 실제로 1 줄였는가.
        replayed: 기존 환불 결과를 그대로 돌려준 것인가 (중복 요청).
        failure_code / failure_message: PG 실패 사유. 성공·대기면 None.
        gateway_refund_id: PG가 부여한 취소 식별자.
    """

    reservation_id: uuid.UUID
    refund_id: uuid.UUID
    status: RefundStatus
    requested_amount: int
    refunded_amount: int
    refund_rate_bp: int
    hours_before_start: int
    reservation_status: str
    slot_restored: bool
    replayed: bool
    failure_code: str | None = None
    failure_message: str | None = None
    gateway_refund_id: str | None = None

    @property
    def is_failed(self) -> bool:
        """PG 환불이 실패했는가.

        라우터는 이 값으로 비-2xx를 낼지 정한다. 서비스는 예외를 던지지 않는다 —
        실패 사유가 이미 DB에 적혔고 그 커밋이 예외로 날아가면 안 되기 때문이다.
        """
        return self.status is RefundStatus.FAILED


@dataclass(frozen=True, slots=True)
class CancellationPreview:
    """취소 확정 **전에** 보여줄 예상 환불액 (수용 기준: 사전 고지).

    아무것도 쓰지 않는 순수 조회 경로다. ``cancellable``이 False면 ``reason_code``에
    거부 사유가 담긴다 — 미리 버튼을 막을 수 있게 예외 대신 값으로 돌려준다.

    ``payment_method``는 화면이 **확정 요청을 보내기 전에** 환불 계좌 입력 폼을
    띄울지 정하는 근거다 (가상계좌만 계좌가 필요하다 — Q2). 없으면 클라이언트는
    항상 계좌를 받거나, 422를 맞고 나서야 폼을 띄우는 두 나쁜 선택만 남는다.
    결제 원거래가 없으면 None이다.
    """

    reservation_id: uuid.UUID
    # SCH-06(Pydantic 스키마 + 라우터 + main.py)이 CancellationPreviewResponse로
    # 이 필드를 그대로 내보낸다 — 모바일이 "가상계좌일 때만 환불 계좌 입력 폼을
    # 띄운다"(Q2)는 분기를 취소를 확정하기 전에 하려면 결제수단을 미리 알아야
    # 한다(TS-09 I-2).
    payment_method: str | None
    paid_amount: int
    refund_amount: int
    refund_rate_bp: int
    hours_before_start: int
    seconds_before_start: int
    applied_tier_hours: int | None
    starts_at: datetime
    cancellable: bool
    reason_code: str | None = None


# --------------------------------------------------------------------------- #
# 멱등 키
# --------------------------------------------------------------------------- #


def build_idempotency_key(
    reservation_id: uuid.UUID | str, provided: str | None = None
) -> str:
    """``Idempotency-Key`` 헤더가 있으면 그대로, 없으면 결정적으로 만든다.

    생성 규칙은 ``sha256("cancel:" + reservation_id)`` 16진 다이제스트다. 예약당
    **항상 같은 키**가 나오므로, 헤더를 안 보내는 클라이언트가 취소를 두 번 눌러도
    두 번째 INSERT가 ``refunds.idempotency_key`` UNIQUE에 걸린다.

    헤더가 온 경우 그 값을 신뢰한다. 클라이언트가 매번 새 키를 보내면 결정적 키는
    우회되지만, 그때도 부분 유니크 인덱스
    (``UNIQUE (reservation_id) WHERE status <> 'failed'``)가 남아 있어 이중 환불은
    여전히 불가능하다. 방어가 2겹인 이유다.
    """
    if provided:
        stripped = provided.strip()
        if stripped:
            return stripped[:200]
    seed = f"{IDEMPOTENCY_KEY_PREFIX}{reservation_id}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# 조회 헬퍼
# --------------------------------------------------------------------------- #


def _as_utc(value: datetime) -> datetime:
    """tz-naive 시각을 UTC로 간주해 aware로 만든다.

    컬럼은 전부 ``TIMESTAMP WITH TIME ZONE``이라 드라이버가 aware를 돌려주지만,
    산정 함수가 naive를 거부하므로 경계에서 한 번 막아둔다.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# cancel_reservation()의 1단계에서 호출된다. 파일 상단 "사전 개념 요약"의
# 행 잠금(row lock)이 실제로 걸리는 지점이 바로 여기다.
def _lock_reservation(session: Session, reservation_id: uuid.UUID) -> Reservation:
    """``SELECT ... FOR UPDATE``로 예약 행을 잠근다.

    동시에 들어온 취소 요청 2건 중 하나는 여기서 대기한다. 대기가 풀렸을 땐 앞선
    요청이 이미 ``Refund``를 만든 뒤이므로, 뒤 요청은 멱등 재생 경로로 빠진다.
    """
    return session.execute(
        select(Reservation).where(Reservation.id == reservation_id).with_for_update()
    ).scalar_one_or_none()


def _find_active_refund(session: Session, reservation_id: uuid.UUID) -> Refund | None:
    """예약에 딸린 진행중/성공 환불을 찾는다 (부분 유니크 인덱스가 최대 1건 보장)."""
    return session.execute(
        select(Refund)
        .where(Refund.reservation_id == reservation_id)
        # frozenset 그대로 넘기지 않는다 — 바인드 파라미터 순서가 실행마다 달라지면
        # 쿼리 캐시 키가 흔들리고 로그 비교도 어려워진다.
        .where(Refund.status.in_(sorted(ACTIVE_REFUND_STATUSES)))
    ).scalars().first()


def _find_refund_by_idempotency_key(session: Session, key: str) -> Refund | None:
    return session.execute(
        select(Refund).where(Refund.idempotency_key == key)
    ).scalar_one_or_none()


def _find_paid_payment(session: Session, order_id: uuid.UUID) -> Payment | None:
    """주문의 결제 완료 원거래를 찾는다. 여러 건이면 가장 최근 입금 건."""
    return session.execute(
        select(Payment)
        .where(Payment.order_id == order_id)
        .where(Payment.paid_at.is_not(None))
        .order_by(Payment.paid_at.desc())
    ).scalars().first()


def _jsonable(value: Any) -> Any:
    """감사 로그 payload를 JSONB에 넣을 수 있는 형태로 바꾼다.

    ``uuid.UUID``와 ``datetime``이 그대로 들어가면 직렬화 단계에서 터진다. 감사 로그
    때문에 환불 트랜잭션이 실패하는 건 말이 안 되므로 여기서 평탄화한다.
    """
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)


def _record_event(
    session: Session,
    refund_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """``refund_events``에 감사 로그 1행을 추가한다. **INSERT만 한다** (append-only)."""
    session.add(
        RefundEvent(
            refund_id=refund_id,
            event_type=event_type,
            payload=_jsonable(payload),
        )
    )


def _outcome_from_refund(
    refund: Refund,
    *,
    reservation_status: str,
    hours_before_start: int,
    slot_restored: bool,
    replayed: bool,
) -> CancellationOutcome:
    return CancellationOutcome(
        reservation_id=refund.reservation_id,
        refund_id=refund.id,
        status=RefundStatus(refund.status),
        requested_amount=refund.requested_amount,
        refunded_amount=refund.refunded_amount,
        refund_rate_bp=refund.refund_rate_bp,
        hours_before_start=hours_before_start,
        reservation_status=reservation_status,
        slot_restored=slot_restored,
        replayed=replayed,
        failure_code=refund.failure_code,
        failure_message=refund.failure_message,
        gateway_refund_id=refund.gateway_refund_id,
    )


# --------------------------------------------------------------------------- #
# 사전 고지 (읽기 전용)
# --------------------------------------------------------------------------- #


# 라우터(SCH-06)의 GET /reservations/{id}/cancellation-preview가 이 함수를
# 호출할 예정이다(계획에 없던 추가 — §5-1 참고). 아무것도 쓰지 않으므로 트랜잭션/
# 커밋 개념과 무관하다 — 조회만 한다.
def preview_cancellation(
    session: Session,
    *,
    reservation_id: uuid.UUID,
    user_id: uuid.UUID,
    now: datetime | None = None,
) -> CancellationPreview:
    """취소 확정 전 예상 환불액을 계산한다. **DB에 아무것도 쓰지 않는다.**

    회원에게 약관 동의를 받는 이상 금액 사전 고지는 선택이 아니다
    (수용 기준 "모바일 예상 환불액 사전 고지").

    소유권 위반과 예약 부재는 예외로 던지지만(403/404), *지금 취소할 수 없는 상태*는
    ``cancellable=False``로 **값으로** 돌려준다 — 화면이 사유를 보여주고 버튼을
    비활성화하려면 금액과 사유를 같이 받아야 하기 때문이다.
    """
    now = now or datetime.now(UTC)

    reservation = session.get(Reservation, reservation_id)
    if reservation is None:
        raise ReservationNotFoundError(f"예약을 찾을 수 없습니다: {reservation_id}")
    if reservation.user_id != user_id:
        raise ReservationOwnershipError("본인의 예약만 조회할 수 있습니다.")

    schedule = session.get(ClassSchedule, reservation.class_schedule_id)
    if schedule is None:
        raise ReservationNotFoundError(
            f"예약에 연결된 수업 일정을 찾을 수 없습니다: {reservation.class_schedule_id}"
        )
    starts_at = _as_utc(schedule.starts_at)

    payment = _find_paid_payment(session, reservation.order_id)
    paid_amount = payment.amount if payment is not None else 0

    calculation = calculate_refund(
        paid_amount=paid_amount,
        starts_at=starts_at,
        now=now,
        tiers=_academy_tiers(session, schedule.academy_id),
        reason=CancellationReason.MEMBER_REQUEST,
    )

    reason_code = _preview_block_reason(reservation, payment, calculation)

    return CancellationPreview(
        reservation_id=reservation.id,
        # 원거래가 없으면 None이다 — 이때 cancellable=False,
        # reason_code="paid_payment_not_found"가 같이 나가므로, 화면은 계좌를
        # 물어볼 필요가 없다는 것도 함께 알 수 있다(SCH-06).
        payment_method=payment.method if payment is not None else None,
        paid_amount=paid_amount,
        refund_amount=calculation.refund_amount,
        refund_rate_bp=calculation.refund_rate_bp,
        hours_before_start=calculation.hours_before_start,
        seconds_before_start=calculation.seconds_before_start,
        applied_tier_hours=calculation.applied_tier_hours,
        starts_at=starts_at,
        cancellable=reason_code is None,
        reason_code=reason_code,
    )


def _preview_block_reason(
    reservation: Reservation,
    payment: Payment | None,
    calculation: RefundCalculation,
) -> str | None:
    """사전 고지 화면이 취소 버튼을 막아야 하는 사유. 막을 게 없으면 None.

    :func:`cancel_reservation`의 판정과 **같은 순서**여야 한다. 어긋나면 화면은
    취소 가능하다고 했는데 API가 거부하는 상태가 된다.
    """
    if reservation.status == "cancelled":
        return ReservationAlreadyCancelledError.code
    if reservation.status not in CANCELLABLE_RESERVATION_STATUSES:
        return ReservationNotCancellableError.code
    if calculation.seconds_before_start <= 0:
        return ClassAlreadyStartedError.code
    if payment is None:
        return PaidPaymentNotFoundError.code
    return None


def _academy_tiers(session: Session, academy_id: uuid.UUID) -> list[dict]:
    """학원의 환불 비율표. 학원 행이 없거나 값이 비어 있으면 빈 표(=24h 이내 0%)."""
    tiers = session.execute(
        select(Academy.refund_policy_tiers).where(Academy.id == academy_id)
    ).scalar_one_or_none()
    return tiers if isinstance(tiers, list) else []


# --------------------------------------------------------------------------- #
# 취소 오케스트레이션
# --------------------------------------------------------------------------- #


# 라우터(SCH-06, `app/routers/reservations.py`가 될 예정)가 취소 요청을 받으면 이
# 함수를 호출한다. 이 함수 하나가 통째로 하나의 트랜잭션이다 — 끝까지 가면 10단계
# 주석 근처의 session.commit()에서 확정되고, 중간에 예외(404/403/409/422)가 나면
# 그때까지의 변경은 전부 자동 롤백된다(트랜잭션 개념은 파일 상단 참고).
def cancel_reservation(
    session: Session,
    *,
    reservation_id: uuid.UUID,
    user_id: uuid.UUID,
    payment_gateway: PaymentGateway,
    notification_sender: NotificationSender,
    slot_lock: SlotLock,
    refund_account: RefundAccount | None = None,
    idempotency_key: str | None = None,
    reason: CancellationReason = CancellationReason.MEMBER_REQUEST,
    now: datetime | None = None,
) -> CancellationOutcome:
    """예약 1건을 취소하고 환불을 실행한다.

    어댑터 3종은 전부 **Protocol 타입**으로 받는다. 구상 클래스를 여기서 import하면
    테스트가 프로덕션 구현을 끌고 들어오고, PG를 갈아끼울 때 이 파일이 바뀐다.
    무엇을 주입할지는 ``app/deps.py``가 정한다.

    Args:
        session: 열린 DB 세션. **이 함수가 commit한다.**
        reservation_id: 취소 대상.
        user_id: 요청자. 예약 소유자와 다르면 403.
        payment_gateway: 환불 실행 포트.
        notification_sender: 회원·학원 관리자 2방향 알림 포트.
        slot_lock: 슬롯 락 해제 포트. **결과를 신뢰하지 않는다** (아래 참조).
        refund_account: 가상계좌 환불 수취 계좌. 필수 여부 검증은 스키마 계층(TS-06).
        idempotency_key: ``Idempotency-Key`` 헤더 값. None이면 결정적으로 생성한다.
        reason: 취소 사유. 이번 슬라이스는 ``member_request`` 하나뿐이다.
        now: 산정 기준 시각. **주입 가능** — 경계값 테스트를 위해 열어 둔다.

    Returns:
        CancellationOutcome. PG 실패도 **예외가 아니라 결과**다 (``status=failed``) —
        실패 사유를 DB에 남긴 커밋이 예외로 날아가면 안 된다.

    Raises:
        CancellationError: 요청 자체가 거부된 경우. ``status_code``에 HTTP 코드가 실린다.
    """
    now = now or datetime.now(UTC)
    key = build_idempotency_key(reservation_id, idempotency_key)

    # --- 1. 행 잠금 ------------------------------------------------------- #
    reservation = _lock_reservation(session, reservation_id)
    if reservation is None:
        raise ReservationNotFoundError(f"예약을 찾을 수 없습니다: {reservation_id}")

    # --- 2. 소유권 검증 ---------------------------------------------------- #
    if reservation.user_id != user_id:
        # 403이다. 404로 감추지 않는다 (수용 기준 "타인 예약 403").
        raise ReservationOwnershipError("본인의 예약만 취소할 수 있습니다.")

    schedule = session.get(ClassSchedule, reservation.class_schedule_id)
    if schedule is None:
        raise ReservationNotFoundError(
            f"예약에 연결된 수업 일정을 찾을 수 없습니다: {reservation.class_schedule_id}"
        )
    starts_at = _as_utc(schedule.starts_at)

    # --- 3. 멱등 재생 ------------------------------------------------------ #
    # 상태 전이 검증보다 **앞에** 둔다. 앞선 요청이 이미 예약을 cancelled로 바꿔
    # 놓았으므로, 순서가 반대면 중복 요청이 409로 튕겨 "기존 결과를 200으로"라는
    # 수용 기준이 깨진다.
    existing = _find_active_refund(session, reservation.id) or (
        _find_refund_by_idempotency_key(session, key)
    )
    if existing is not None:
        logger.info(
            "이미 처리된 취소 요청 — 기존 환불 결과를 그대로 반환합니다 "
            "(reservation_id=%s, refund_id=%s, status=%s)",
            reservation.id,
            existing.id,
            existing.status,
        )
        return _outcome_from_refund(
            existing,
            reservation_status=reservation.status,
            hours_before_start=_hours_before(starts_at, now),
            slot_restored=False,
            replayed=True,
        )

    # --- 4. 상태 전이 검증 -------------------------------------------------- #
    if reservation.status == "cancelled":
        raise ReservationAlreadyCancelledError("이미 취소된 예약입니다.")
    if reservation.status not in CANCELLABLE_RESERVATION_STATUSES:
        raise ReservationNotCancellableError(
            f"취소할 수 없는 예약 상태입니다: {reservation.status!r}"
        )
    if starts_at <= now:
        # 종료 시각 컬럼이 없으므로 "이미 시작"과 "이미 종료"를 한 판정으로 묶는다.
        raise ClassAlreadyStartedError("이미 시작했거나 종료된 수업은 취소할 수 없습니다.")

    # --- 5. 원거래 확인 + 환불액 산정 --------------------------------------- #
    payment = _find_paid_payment(session, reservation.order_id)
    if payment is None:
        raise PaidPaymentNotFoundError("결제 완료된 원거래가 없어 환불할 수 없습니다.")

    calculation = calculate_refund(
        paid_amount=payment.amount,
        starts_at=starts_at,
        now=now,
        tiers=_academy_tiers(session, schedule.academy_id),
        reason=reason,
    )

    # --- 6. Refund INSERT (멱등) ------------------------------------------- #
    refund = Refund(
        reservation_id=reservation.id,
        payment_id=payment.id,
        idempotency_key=key,
        requested_amount=calculation.refund_amount,
        refunded_amount=0,
        refund_rate_bp=calculation.refund_rate_bp,
        # 초기 상태는 pending이다. refunds.status 값 집합에 "요청됨"이 따로 없고,
        # pending으로 넣어야 부분 유니크 인덱스(WHERE status <> 'failed')가 지금부터
        # 작동해 동시 요청을 막는다.
        status=RefundStatus.PENDING.value,
        reason=CancellationReason(reason).value,
        refund_account_bank_code=refund_account.bank_code if refund_account else None,
        refund_account_number=refund_account.account_number if refund_account else None,
        refund_account_holder_name=refund_account.holder_name if refund_account else None,
    )

    try:
        # session.begin_nested() = SAVEPOINT 진입 (사전 개념 요약 참고). 이 블록
        # 안에서만 flush하고, 블록 안에서 IntegrityError가 나면 SAVEPOINT까지만
        # 되돌아간다. 바깥 트랜잭션과 1단계에서 건 FOR UPDATE 잠금은 살아남는다 —
        # 만약 여기서 바깥 트랜잭션 전체를 롤백했다면 잠금까지 풀려서 경합이 다시 열린다.
        with session.begin_nested():
            session.add(refund)
            session.flush()
    except IntegrityError:
        # 같은 예약(부분 유니크) 또는 같은 멱등 키(UNIQUE)로 앞선 요청이 이미 들어왔다.
        # **409가 아니라 기존 결과를 200으로 돌려준다** — 수용 기준은 "환불이 1회만
        # 실행된다"이지 "두 번째 요청이 에러난다"가 아니다 (Phase 3 D5).
        logger.info(
            "환불 INSERT 유니크 위반 — 기존 행으로 수렴합니다 (reservation_id=%s)",
            reservation.id,
            exc_info=True,
        )
        if refund in session:
            # SAVEPOINT 롤백이 이미 pending 객체를 세션에서 떼어냈을 수 있다.
            # 확인 없이 expunge하면 InvalidRequestError로 바뀌어 원인이 가려진다.
            session.expunge(refund)
        winner = _find_active_refund(session, reservation.id) or (
            _find_refund_by_idempotency_key(session, key)
        )
        if winner is None:
            # 유니크 위반인데 이긴 행이 안 보이는 상황. 조용히 덮지 않고 올린다.
            raise
        return _outcome_from_refund(
            winner,
            reservation_status=reservation.status,
            hours_before_start=calculation.hours_before_start,
            slot_restored=False,
            replayed=True,
        )

    _record_event(
        session,
        refund.id,
        RefundEventType.REQUESTED,
        {
            "reservation_id": reservation.id,
            "payment_id": payment.id,
            "user_id": user_id,
            "idempotency_key": key,
            "paid_amount": payment.amount,
            "requested_amount": calculation.refund_amount,
            "refund_rate_bp": calculation.refund_rate_bp,
            "hours_before_start": calculation.hours_before_start,
            "seconds_before_start": calculation.seconds_before_start,
            "applied_tier_hours": calculation.applied_tier_hours,
            "reason": CancellationReason(reason).value,
            "starts_at": starts_at,
            "now": now,
        },
    )

    # --- 7. PG 호출 -------------------------------------------------------- #
    gateway_request = RefundRequest(
        payment_key=payment.gateway_payment_key or str(payment.id),
        method=payment.method,
        amount=calculation.refund_amount,
        idempotency_key=key,
        refund_account=refund_account,
    )

    try:
        result = payment_gateway.refund(gateway_request)
    except UnsupportedPaymentMethodError as exc:
        # 어댑터가 카드 환불을 거부했다. 여기서 안 잡으면 라우터가 500을 낸다 —
        # "서버 고장"과 "아직 지원하지 않는 결제수단"은 다른 이야기다.
        # 실패로 확정해 두면 부분 유니크 인덱스에서 빠지므로, 카드 환불이 열렸을 때
        # 같은 예약을 그대로 재시도할 수 있다.
        _apply_failure(
            session,
            refund,
            failure_code=UNSUPPORTED_METHOD_CODE,
            failure_message=str(exc),
            event_type=RefundEventType.UNSUPPORTED_METHOD,
            extra={"method": payment.method},
        )
        session.commit()
        _notify(
            notification_sender,
            member_id=reservation.user_id,
            academy_id=schedule.academy_id,
            event=NotificationEvent.REFUND_FAILED,
            payload={
                "reservation_id": reservation.id,
                "refund_id": refund.id,
                "failure_code": UNSUPPORTED_METHOD_CODE,
            },
        )
        raise UnsupportedRefundMethodError(str(exc)) from exc

    # --- 8. 결과 반영 ------------------------------------------------------- #
    slot_restored = False
    if result.is_failed:
        # 환불이 실패했으면 예약도 정원도 건드리지 않는다. 좌석까지 없애면 회원은
        # 자리도 돈도 잃는다. failed는 인덱스 밖이라 재시도가 열려 있다.
        _apply_failure(
            session,
            refund,
            failure_code=result.failure_code,
            failure_message=result.failure_message,
            event_type=RefundEventType.GATEWAY_FAILED,
            extra={"raw_response": dict(result.raw_response)},
        )
    else:
        _apply_success(refund, result, calculation)
        reservation.status = "cancelled"
        reservation.cancelled_at = now

        order = session.get(Order, reservation.order_id)
        if order is not None:
            # 이번 슬라이스는 Order당 Reservation 1건이므로 전체 취소와 같다
            # (부분 취소는 Q5 확정상 범위 밖). 부분 취소가 들어오면 "남은 예약이
            # 있으면 refunded로 바꾸지 않는다"는 판정이 여기 붙는다.
            order.status = "refunded"

        slot_restored = _release_slot_capacity(session, reservation.class_schedule_id)

        # TODO(coupon): Q4 확정 — 취소 시 1+1 쿠폰을 복원한다(분기말 소멸 규칙 그대로).
        # Coupon 모델이 이번 슬라이스에 없어 미구현. 도입 시 **바로 여기**에 붙인다 —
        # 예약이 cancelled로 확정되고 정원이 복구된 직후, 같은 트랜잭션 안. 커밋
        # 이후로 미루면 쿠폰만 복원되고 취소는 롤백되는 상태가 생긴다.

        _record_event(
            session,
            refund.id,
            RefundEventType.GATEWAY_SUCCEEDED
            if result.is_succeeded
            else RefundEventType.GATEWAY_PENDING,
            {
                "status": result.status.value,
                "gateway_refund_id": result.gateway_refund_id,
                "pg_cancellation_id": result.pg_cancellation_id,
                "total_amount": result.total_amount,
                "requested_at": result.requested_at,
                "cancelled_at": result.cancelled_at,
                "raw_response": dict(result.raw_response),
            },
        )
        _record_event(
            session,
            refund.id,
            RefundEventType.RESERVATION_CANCELLED,
            {
                "reservation_id": reservation.id,
                "class_schedule_id": reservation.class_schedule_id,
                "slot_restored": slot_restored,
                "cancelled_at": now,
            },
        )

    # --- 9~10. 커밋 -------------------------------------------------------- #
    # 여기가 이 함수 전체 트랜잭션의 commit 지점이다(사전 개념 요약 참고). 이
    # 줄까지 도달했다는 것은 8단계까지의 모든 변경(환불 행, 예약 상태, 정원,
    # 감사 로그)이 전부 성공했다는 뜻이고, 여기서 한꺼번에 확정된다.
    session.commit()

    outcome = _outcome_from_refund(
        refund,
        reservation_status=reservation.status,
        hours_before_start=calculation.hours_before_start,
        slot_restored=slot_restored,
        replayed=False,
    )

    # --- 11. 커밋 이후: 부수효과 -------------------------------------------- #
    # 여기서부터는 **무슨 일이 나도 환불을 되돌리지 않는다.** 돈은 이미 움직였고
    # DB는 이미 커밋됐다.
    _release_slot_lock(slot_lock, reservation.class_schedule_id)
    _notify_outcome(notification_sender, reservation, schedule, outcome)

    return outcome


# --------------------------------------------------------------------------- #
# 단계별 헬퍼
# --------------------------------------------------------------------------- #


def _hours_before(starts_at: datetime, now: datetime) -> int:
    """수업 시작까지 남은 시간(시, 내림). 정수 연산만 쓴다."""
    return int((starts_at - now).total_seconds()) // 3600


def _apply_success(
    refund: Refund, result: RefundResult, calculation: RefundCalculation
) -> None:
    """PG 성공/대기 결과를 환불 행에 반영한다.

    ``pending``에서 ``refunded_amount``를 0으로 두는 이유: 가상계좌 환불은 아직
    회원 계좌로 송금되지 않았다. 여기에 금액을 채우면 "이미 받은 돈"으로 집계된다.
    송금 완료(포트원 웹훅)는 이번 슬라이스 범위 밖이다.
    """
    refund.status = result.status.value
    refund.gateway_refund_id = result.gateway_refund_id
    refund.failure_code = None
    refund.failure_message = None
    refund.refunded_amount = (
        calculation.refund_amount if result.is_succeeded else 0
    )


def _apply_failure(
    session: Session,
    refund: Refund,
    *,
    failure_code: str | None,
    failure_message: str | None,
    event_type: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """환불 행을 실패로 확정하고 사유를 남긴다 (수용 기준: 실패 사유 기록)."""
    refund.status = RefundStatus.FAILED.value
    refund.refunded_amount = 0
    refund.failure_code = (failure_code or "PG_UNKNOWN_ERROR")[:100]
    refund.failure_message = (failure_message or "")[:500] or None

    payload: dict[str, Any] = {
        "status": RefundStatus.FAILED.value,
        "failure_code": refund.failure_code,
        "failure_message": refund.failure_message,
    }
    payload.update(extra or {})
    _record_event(session, refund.id, event_type, payload)


def _release_slot_capacity(session: Session, class_schedule_id: uuid.UUID) -> bool:
    """``class_schedules.reserved_count``를 1 줄인다.

    읽고-고쳐-쓰지 않고 **한 문장의 UPDATE**로 감소시킨다. ``reserved_count > 0``
    조건을 걸어 CHECK 제약(``reserved_count >= 0``)에 부딪히는 대신 0행 갱신으로
    끝나게 한다 — 이미 0인 슬롯을 취소해도 트랜잭션이 죽지 않는다.
    """
    result = session.execute(
        update(ClassSchedule)
        .where(ClassSchedule.id == class_schedule_id)
        .where(ClassSchedule.reserved_count > 0)
        .values(reserved_count=ClassSchedule.reserved_count - 1)
    )
    if result.rowcount != 1:
        logger.warning(
            "reserved_count 감소 대상이 없습니다 (class_schedule_id=%s). "
            "이미 0이거나 일정이 삭제된 경우이며, 환불은 그대로 진행합니다.",
            class_schedule_id,
        )
        return False
    return True


def _release_slot_lock(slot_lock: SlotLock, class_schedule_id: uuid.UUID) -> None:
    """Redis 슬롯 락을 해제한다. **best-effort다.**

    반환된 ``bool``을 **의도적으로 버린다.** 해제 성공 여부로 취소 처리 성공을
    분기하면, 볼륨도 없는 캐시(``infra/docker-compose.yml``의 redis)의 장애가 이미
    확정된 금전 트랜잭션의 결과를 바꾸게 된다. 예약 가능 여부의 권위는
    ``class_schedules.reserved_count``이고 락은 TTL로도 풀린다.

    커밋 **이후**에 호출된다는 점도 같은 이유다 — 이 지점에서 무슨 일이 나도
    되돌릴 트랜잭션이 없다.
    """
    try:
        released = slot_lock.release(class_schedule_id)
    except Exception:
        # Protocol은 예외를 안 던지기로 돼 있지만, 구현체를 갈아끼울 사람이 그 약속을
        # 어겼을 때 환불이 무효가 되면 안 된다. 로그만 남기고 삼킨다.
        logger.warning(
            "슬롯 락 해제에서 예외가 났습니다 (class_schedule_id=%s) — 무시합니다.",
            class_schedule_id,
            exc_info=True,
        )
        return
    if not released:
        logger.warning(
            "슬롯 락 해제 실패 (class_schedule_id=%s) — 무시하고 진행합니다. "
            "락은 TTL로 만료되며 정원의 권위는 class_schedules.reserved_count다.",
            class_schedule_id,
        )


def _notify(
    sender: NotificationSender,
    *,
    member_id: uuid.UUID,
    academy_id: uuid.UUID,
    event: NotificationEvent,
    payload: dict[str, Any],
) -> None:
    """회원과 학원 관리자 **양쪽**에 알린다 (수용 기준: 2방향).

    알림 실패가 환불을 되돌리지 않는다 — 슬롯 락과 같은 이유다. 한쪽이 실패해도
    다른 쪽 발송은 시도한다.
    """
    body = _jsonable(payload)
    for send, recipient in (
        (sender.notify_member, member_id),
        (sender.notify_academy_admin, academy_id),
    ):
        try:
            send(str(recipient), event, body)
        except Exception:
            logger.warning(
                "알림 발송 실패 (event=%s, recipient=%s) — 무시합니다.",
                event,
                recipient,
                exc_info=True,
            )


def _notify_outcome(
    sender: NotificationSender,
    reservation: Reservation,
    schedule: ClassSchedule,
    outcome: CancellationOutcome,
) -> None:
    """결과 상태에 맞는 알림 이벤트를 고른다.

    ``pending``을 실패 알림으로 뭉뚱그리지 않는다 — 회원이 돈을 못 받는다고 오해한다.
    """
    if outcome.status is RefundStatus.SUCCEEDED:
        event = NotificationEvent.RESERVATION_CANCELLED
    elif outcome.status is RefundStatus.PENDING:
        event = NotificationEvent.REFUND_PENDING
    else:
        event = NotificationEvent.REFUND_FAILED

    _notify(
        sender,
        member_id=reservation.user_id,
        academy_id=schedule.academy_id,
        event=event,
        payload={
            "reservation_id": outcome.reservation_id,
            "refund_id": outcome.refund_id,
            "status": outcome.status.value,
            "requested_amount": outcome.requested_amount,
            "refunded_amount": outcome.refunded_amount,
            "refund_rate_bp": outcome.refund_rate_bp,
            "failure_code": outcome.failure_code,
        },
    )
