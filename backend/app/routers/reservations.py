"""예약 취소 HTTP 경계.

이 모듈은 **옮기기만 한다.** 판정도 계산도 하지 않는다 — 순서와 트랜잭션은
``app/services/cancellation.py``가, 금액은 ``app/services/refund_policy.py``가,
PG 호출은 어댑터가 한다. 라우터에 도메인 판정이 한 줄이라도 들어가면 그 판정은
HTTP 없이는 테스트할 수 없게 된다.

예외 → HTTP 상태 매핑
---------------------
:class:`~app.services.cancellation.CancellationError`가 ``status_code``를 값으로
들고 다닌다. 그래서 여기에 예외 타입별 ``if/elif`` 사다리가 없다 — 사유가 하나 늘어도
이 파일은 안 바뀐다. 변환이 필요한 건 두 가지뿐이다:

* ``CancellationError`` → ``exc.status_code`` (404 / 403 / 409 / 422)
* ``ValueError`` → **422**. ``calculate_refund``가 망가진 비율표에
  ``ValueError``를 던진다(JSONB에는 CHECK를 걸 수 없다). 그대로 새면 500이 되고,
  "서버가 고장났다"와 "이 학원의 환불 비율표 설정이 잘못됐다"가 구분되지 않는다.
"""

# 학습 주석: SCH-06(Pydantic 스키마 + 라우터 + main.py) 반영
#
# 사전 개념 요약 (6개월차 비전공자용)
# - APIRouter 개념은 ``app/routers/__init__.py`` 참고. 이 파일의 ``router``는
#   ``app/main.py``에서 ``app.include_router(reservations.router)``로 최종
#   조립된다.
# - Pydantic 스키마 개념은 ``app/schemas/__init__.py``, ``model_validator``는
#   ``app/schemas/cancellation.py`` 참고 — 아래 엔드포인트의 요청/응답 타입
#   (``CancelRequest`` 등)이 전부 그 스키마다.
# - 예외 → HTTP 상태 코드 매핑 설계는 위 docstring 참고. 상태 코드를
#   ``CancellationError`` 자신이 값으로 들고 다니는 설계는
#   SCH-05(취소 오케스트레이션 서비스 + deps.py)가 만들었고, 이 라우터는 그걸
#   그대로 꺼내 쓰기만 한다.
# - ``Depends()``가 실제로 무엇을 하는지는 SCH-05(취소 오케스트레이션 서비스 +
#   deps.py)의 ``deps.py`` 학습 주석 참고.

from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Path, status
from sqlalchemy.orm import Session

from app.adapters.notification import NotificationSender
from app.adapters.payment_gateway import PaymentGateway
from app.adapters.slot_lock import SlotLock
from app.db import get_db
from app.deps import (
    CurrentUserId,
    get_notification_sender,
    get_payment_gateway,
    get_slot_lock,
)
from app.schemas.cancellation import (
    CancelRequest,
    CancelResponse,
    CancellationPreviewResponse,
)
from app.services.cancellation import (
    CancellationError,
    cancel_reservation,
    preview_cancellation,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reservations", tags=["reservations"])

ReservationId = Annotated[uuid.UUID, Path(description="예약 ID")]

#: 망가진 비율표를 422로 돌려줄 때 쓰는 문구. 회원에게 보일 수 있으므로 설정 오류라는
#: 사실만 전하고 내부 값은 노출하지 않는다 (원본 사유는 서버 로그에 남는다).
_INVALID_POLICY_MESSAGE = (
    "환불액을 계산할 수 없습니다. 학원의 환불 비율표 설정이 올바른지 확인해 주세요."
)


def _http_error(exc: CancellationError) -> HTTPException:
    """도메인 예외를 HTTP 예외로 바꾼다. 상태 코드는 예외가 이미 알고 있다."""
    return HTTPException(status_code=exc.status_code, detail=exc.message)


def _invalid_policy_error(exc: ValueError, reservation_id: uuid.UUID) -> HTTPException:
    """비율표 데이터 오류를 422로 바꾼다. 원인은 로그에만 남긴다."""
    logger.warning(
        "환불 비율표가 잘못돼 환불액을 산정하지 못했습니다 (reservation_id=%s): %s",
        reservation_id,
        exc,
    )
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=_INVALID_POLICY_MESSAGE,
    )


# 모바일 앱이 취소 확정 화면을 띄우기 전에 부른다. SCH-05(취소 오케스트레이션
# 서비스 + deps.py)의 preview_cancellation()을 그대로 호출하고, 결과를
# CancellationPreviewResponse로 감싸 내보내는 것 말고는 아무 판단도 하지 않는다.
@router.get(
    "/{reservation_id}/cancellation-preview",
    response_model=CancellationPreviewResponse,
    summary="예상 환불액 사전 고지",
)
def get_cancellation_preview(
    reservation_id: ReservationId,
    user_id: CurrentUserId,
    session: Annotated[Session, Depends(get_db)],
) -> CancellationPreviewResponse:
    """취소를 확정하기 **전에** 얼마가 돌아오는지 알려준다. DB에 아무것도 쓰지 않는다.

    ``cancellable=False``는 **에러가 아니다.** 지금 취소할 수 없는 상태(이미 시작한
    수업 등)도 200으로 돌려주고 사유를 ``reason_code``에 담는다. 화면이 버튼을
    비활성화하고 이유를 보여주려면 금액과 사유를 같이 받아야 한다. 400대로 돌려주면
    클라이언트는 사유를 파싱하는 대신 "조회 실패"만 띄우게 된다.

    예외로 남긴 건 요청 자체가 성립하지 않는 두 경우뿐이다 — 예약 없음(404),
    타인 예약(403).
    """
    try:
        preview = preview_cancellation(
            session, reservation_id=reservation_id, user_id=user_id
        )
    except CancellationError as exc:
        raise _http_error(exc) from exc
    except ValueError as exc:
        # 사전 고지 경로가 500을 내면 회원은 취소 화면에 아예 진입하지 못한다.
        raise _invalid_policy_error(exc, reservation_id) from exc

    return CancellationPreviewResponse.from_preview(preview)


# 회원이 취소 버튼을 눌렀을 때 모바일 앱이 부른다. 실제 취소 로직은 전부
# SCH-05(취소 오케스트레이션 서비스 + deps.py)의 cancel_reservation()에 있고,
# 이 함수는 요청 본문(CancelRequest)을 서비스 인자로 옮기고 결과/예외를 HTTP로
# 옮기는 일만 한다.
@router.post(
    "/{reservation_id}/cancel",
    response_model=CancelResponse,
    summary="예약 취소 + 환불",
)
def cancel(
    reservation_id: ReservationId,
    user_id: CurrentUserId,
    session: Annotated[Session, Depends(get_db)],
    payment_gateway: Annotated[PaymentGateway, Depends(get_payment_gateway)],
    notification_sender: Annotated[
        NotificationSender, Depends(get_notification_sender)
    ],
    slot_lock: Annotated[SlotLock, Depends(get_slot_lock)],
    payload: CancelRequest | None = None,
    idempotency_key: Annotated[
        str | None,
        Header(
            alias="Idempotency-Key",
            description="선택. 생략하면 서버가 예약 ID로 결정적으로 생성한다.",
        ),
    ] = None,
) -> CancelResponse:
    """예약 1건을 취소하고 환불을 실행한다.

    본문은 **선택**이다. 카드 결제 취소는 보낼 것이 없고, 가상계좌 취소만
    ``refund_account``가 필요하다.

    중복 요청은 409가 아니라 **200 + 기존 결과**(``replayed=true``)로 돌아온다.
    수용 기준은 "환불이 1회만 실행된다"이지 "두 번째 요청이 에러난다"가 아니다.

    PG 환불 실패도 **200**이다 (``status="failed"`` + ``failure_code``). 요청은
    정상 처리됐고 — 환불 행과 감사 로그가 남았다 — 결과가 실패인 것이다. 비-2xx로
    바꾸면 실패 사유가 담긴 본문이 클라이언트의 에러 처리로 빨려 들어가 회원에게
    이유를 못 보여준다. 반면 **요청 자체가 성립하지 않는 경우**(없는 예약, 타인
    예약, 이미 취소, 이미 시작, 지원하지 않는 결제수단)는 4xx다.
    """
    request = payload or CancelRequest()

    try:
        outcome = cancel_reservation(
            session,
            reservation_id=reservation_id,
            user_id=user_id,
            payment_gateway=payment_gateway,
            notification_sender=notification_sender,
            slot_lock=slot_lock,
            refund_account=(
                request.refund_account.to_domain()
                if request.refund_account is not None
                else None
            ),
            idempotency_key=idempotency_key,
        )
    except CancellationError as exc:
        # 카드 결제(UnsupportedRefundMethodError, 422)도 여기로 온다 — 서비스가 이미
        # 실패 사유를 DB에 커밋한 뒤 던지므로 롤백할 것이 없다.
        raise _http_error(exc) from exc
    except ValueError as exc:
        # 이 catch는 비율표 오류 외의 ValueError(예: DB에 들어간 알 수 없는
        # refunds.status 값을 RefundStatus()로 바꿀 때 나는 것)도 같은 422로
        # 접는다. 둘 다 "데이터가 계약을 어겼다"는 같은 부류라 422 자체는
        # 맞지만, 응답 문구는 비율표를 가리키므로 다소 넓다. 원인은 항상
        # logger.warning에 남으므로 운영 추적은 된다 — 더 좁히려면 서비스가
        # 전용 예외를 던지도록 SCH-05 파일을 바꿔야 해서 이번 SCH 범위 밖으로
        # 남겼다.
        raise _invalid_policy_error(exc, reservation_id) from exc

    return CancelResponse.from_outcome(outcome)
