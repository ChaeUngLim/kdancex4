"""FastAPI 의존성 — 인증(임시)과 어댑터 3종 주입.

이 파일의 존재 이유는 **구상 클래스를 서비스 밖에 묶어두는 것**이다.
``app/services/cancellation.py``는 ``PaymentGateway``/``NotificationSender``/
``SlotLock`` Protocol만 알고, 무엇을 끼울지는 여기서만 정한다. 그래서 PG사를 붙일
때도, 테스트에서 Fake로 바꿀 때도 서비스 코드는 그대로다.

테스트는 ``app.dependency_overrides[get_payment_gateway] = ...`` 로 갈아끼운다.
"""

# 학습 주석: SCH-05(취소 오케스트레이션 서비스 + deps.py) 반영
#
# 사전 개념 — FastAPI 의존성 주입 ``Depends()``가 실제로 하는 일
# ---------------------------------------------------------------
# 라우터 함수의 파라미터에 ``Annotated[T, Depends(f)]``라고 써 두면, FastAPI가
# 요청이 들어올 때마다 ``f()``를 대신 호출해서 그 반환값을 파라미터 자리에
# 꽂아준다 — 이게 "의존성 주입"이다. 라우터는 "누가 이 값을 만드는지"를 몰라도
# 되고, 호출자가 직접 ``get_payment_gateway()``를 부를 필요도 없다.
#
# 이 파일의 ``get_payment_gateway``/``get_notification_sender``/``get_slot_lock``이
# 전부 **반환 타입을 구상 클래스가 아니라 Protocol로 선언**해 두는 이유가 여기서
# 나온다: ``services/cancellation.py``는 "``PaymentGateway`` Protocol을 만족하는
# 무언가"만 알면 되고, 그 자리에 실제로 무엇이 꽂히는지(지금은 SCH-04(어댑터
# 3종: PG/알림/슬롯락)의 Fake 구현, 나중엔 실 PG 연동체)는 이 파일 한 곳만 바꾸면
# 된다. 테스트가 ``app.dependency_overrides``로 이 함수들을 통째로 갈아끼울 수
# 있는 것도 같은 원리 — Depends()가 호출을 간접화해 주기 때문이다.

from __future__ import annotations

import uuid
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from app.adapters.notification import FakeNotificationSender, NotificationSender
from app.adapters.payment_gateway import FakePaymentGateway, PaymentGateway
from app.adapters.slot_lock import RedisSlotLock, SlotLock

__all__ = [
    "CurrentUserId",
    "current_user_id",
    "get_notification_sender",
    "get_payment_gateway",
    "get_slot_lock",
]


# --------------------------------------------------------------------------- #
# 인증 — 임시 구현 (F7)
# --------------------------------------------------------------------------- #


def current_user_id(
    x_user_id: Annotated[str | None, Header(alias="X-User-Id")] = None,
) -> uuid.UUID:
    """요청자 ID를 ``X-User-Id`` 헤더에서 읽는다.

    .. warning::

       **F7 — 임시 구현이다. 이건 인증이 아니다.**

       ``X-User-Id``는 클라이언트가 마음대로 채워 보낼 수 있는 평문 헤더다. 아무나
       남의 UUID를 적어 넣으면 **그 사람의 예약을 취소하고 그 사람 몫의 환불을
       일으킬 수 있다.** 소유권 검증(타인 403)이 코드상 존재하더라도, 신원 자체가
       위조 가능하면 그 검증은 아무것도 막지 못한다.

       이번 슬라이스에 인증·회원 모델이 없어서(Phase 3 §2.7) 취소 API의 소유권
       판정을 돌리기 위한 **자리 표시자**로만 둔 것이다.

       **프로덕션 배포 전 반드시 교체한다.** 교체 지점은 이 함수 하나뿐이다 —
       서명된 토큰(JWT 등)을 검증해 subject를 돌려주도록 본문만 바꾸면 라우터와
       서비스는 손대지 않아도 된다. 그러라고 여기 격리해 둔 것이다.

    Raises:
        HTTPException: 헤더가 없으면 401, UUID 형식이 아니면 400.
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="X-User-Id 헤더가 필요합니다. (임시 인증 — F7)",
        )
    try:
        return uuid.UUID(x_user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"X-User-Id가 UUID 형식이 아닙니다: {x_user_id!r}",
        ) from exc


#: 라우터에서 ``user_id: CurrentUserId`` 로 쓰기 위한 별칭.
#: ``Depends(current_user_id)``가 곧 의존성 주입 선언이다 — 라우터가 이 타입으로
#: 파라미터를 받으면, 요청마다 FastAPI가 위 ``current_user_id()``를 대신 호출해서
#: 그 반환값(또는 예외)을 그 자리에 넣어준다(위 "사전 개념" 참고).
CurrentUserId = Annotated[uuid.UUID, Depends(current_user_id)]


# --------------------------------------------------------------------------- #
# 어댑터 주입
# --------------------------------------------------------------------------- #


@lru_cache
def _payment_gateway() -> FakePaymentGateway:
    """프로세스 단위 PG 인스턴스.

    싱글턴인 이유: :class:`FakePaymentGateway`의 멱등 원장이 인메모리라, 요청마다
    새로 만들면 재시도가 매번 "처음 호출"로 보인다.
    """
    return FakePaymentGateway()


@lru_cache
def _notification_sender() -> FakeNotificationSender:
    return FakeNotificationSender()


@lru_cache
def _slot_lock() -> RedisSlotLock:
    """Redis 슬롯 락. 연결은 지연 생성이라 Redis가 꺼져 있어도 여기서 죽지 않는다."""
    return RedisSlotLock()


# 라우터(SCH-06)가 `payment_gateway: Annotated[PaymentGateway, Depends(get_payment_gateway)]`
# 형태로 선언해 두면, cancel_reservation()(SCH-05(취소 오케스트레이션 서비스 +
# deps.py))의 payment_gateway 인자에 이 함수의 반환값이 그대로 흘러 들어간다.
def get_payment_gateway() -> PaymentGateway:
    """환불 실행 포트.

    **F6 — 아직 실제 PG에 붙지 않는다.** 결제 생성 경로 자체가 이번 슬라이스에
    없어서 실 연동을 검증할 방법이 없다. 포트원 연동 어댑터가 생기면 이 함수의
    반환값만 바꾼다 (``app/adapters/payment_gateway.py``의 응답 파서는 이미
    프로덕션 코드다).

    반환 타입을 Protocol로 못박아 둔다 — 서비스가 구상 타입에 물들지 않게 하는 게
    이 파일의 목적이다.
    """
    return _payment_gateway()


def get_notification_sender() -> NotificationSender:
    """알림 발송 포트 (회원·학원 관리자 2방향).

    **F4 — Fake까지만이다.** 실제 Expo Push 발송과 관리자 웹 알림 채널은 이번
    슬라이스 범위 밖이라, 지금은 호출 기록만 남는다.
    """
    return _notification_sender()


def get_slot_lock() -> SlotLock:
    """슬롯 락 해제 포트.

    Redis가 꺼져 있어도 안전하다 — 어댑터가 연결 실패를 경고 로그 + ``False``
    반환으로 흡수하고, 서비스는 그 반환값으로 분기하지 않는다.
    """
    return _slot_lock()
