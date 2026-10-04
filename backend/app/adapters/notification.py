"""알림 발송 어댑터 — 취소/환불 결과를 회원과 학원 관리자 **양쪽**에 알린다.

``docs/policy/payment-method-policy.md`` "결제 확인 알림 방식"이 정한 규칙을 그대로 따른다.

* 회원 → Expo Push (무료, 기존 스택). **SMS 발송 API는 쓰지 않는다** —
  "무료 API 우선 원칙" 위반이다.
* 학원 관리자 → 관리자 웹 알림. 전달 방식(폴링 / WebSocket / SSE)은 아직 미정이라
  같은 문서의 오픈 이슈로 남아 있다.

두 수신자의 **전달 수단이 실제로 다르기 때문에** Protocol 메서드를 둘로 나눴다.
한 메서드에 수신자 태그를 넘기는 형태로 합치면, 서비스 호출부에서 "양쪽에 다
보냈는지"가 눈으로 확인되지 않고 Expo Push와 웹 채널의 차이가 구현체 안쪽으로
숨는다.

**F4 — 이번 슬라이스는 Fake까지만이다.** 실제 Expo Push 발송(FR-90)과 관리자 웹
알림 채널은 구현하지 않는다. 수용 기준 "회원·학원 관리자 알림"은 Fake 호출이
기록되는 것까지만 검증된다.
"""

# 학습 주석: SCH-04(어댑터 3종: PG/알림/슬롯락) 반영
#
# 사전 개념: Protocol·Fake 객체·포트/어댑터 패턴은 app/adapters/__init__.py와
# payment_gateway.py에서 이미 설명했다 — 이 파일은 그 개념을 그대로 재사용할
# 뿐 새로 설명할 개념은 없다. NotificationSender(Protocol)와
# FakeNotificationSender의 관계는 PaymentGateway/FakePaymentGateway와 같은
# 구조다.

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

__all__ = [
    "FakeNotificationSender",
    "NotificationAudience",
    "NotificationEvent",
    "NotificationSender",
    "SentNotification",
]


class NotificationAudience(StrEnum):
    """알림 수신 대상."""

    MEMBER = "member"
    ACADEMY_ADMIN = "academy_admin"


class NotificationEvent(StrEnum):
    """알림 이벤트 종류.

    환불 상태 3종(:class:`~app.adapters.payment_gateway.RefundStatus`)에 대응한다.
    ``pending``은 오류가 아니라 정상 상태이므로 "환불 처리 중" 알림이 따로 있다 —
    실패 알림으로 뭉뚱그리면 회원이 돈을 못 받는다고 오해한다.
    """

    RESERVATION_CANCELLED = "reservation_cancelled"
    REFUND_PENDING = "refund_pending"
    REFUND_FAILED = "refund_failed"


@dataclass(frozen=True, slots=True)
class SentNotification:
    """발송된(혹은 발송 시도된) 알림 1건의 기록."""

    audience: NotificationAudience
    recipient_id: str
    event: NotificationEvent
    payload: Mapping[str, Any] = field(default_factory=dict)


# 서비스 계층(SCH-05)이 import하는 것은 이 Protocol이고, 실제로 무엇을 주입할지는
# SCH-05의 deps.py 몫이다. 메서드가 2개인 이유(PaymentGateway는 1개)는 회원·
# 관리자의 전달 수단이 실제로 다르기 때문 — 모듈 독스트링 참고.
@runtime_checkable
class NotificationSender(Protocol):
    """알림 발송 포트. 회원·학원 관리자 **2방향**.

    구현체는 **예외를 밖으로 던지지 않는 것을 지향**한다. 알림 발송 실패 때문에
    이미 실행된 환불 트랜잭션이 롤백되면 안 된다 — 슬롯 락 해제와 같은 이유다
    (``app/adapters/slot_lock.py`` 참조).
    """

    def notify_member(
        self,
        member_id: str,
        event: NotificationEvent,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        """회원에게 알린다 (Expo Push)."""
        ...

    def notify_academy_admin(
        self,
        academy_id: str,
        event: NotificationEvent,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        """학원 관리자에게 알린다 (관리자 웹 알림)."""
        ...


# NotificationSender를 상속하지 않고도 두 메서드만 구현해 "NotificationSender답게"
# 취급되는 Fake 객체다. 테스트가 이 클래스를 서비스에 주입해 "취소 처리 중
# 회원·관리자 양쪽에 알림을 보냈는가"를 실제 발송 없이 확인한다.
class FakeNotificationSender:
    """호출 기록만 남기는 알림 발송기. **실제로 아무것도 보내지 않는다** (F4).

    테스트는 :attr:`sent`를 직접 보거나 :meth:`sent_to`로 수신자별로 추려 단정한다.
    """

    def __init__(self) -> None:
        #: 발송 순서를 보존한 전체 기록.
        self.sent: list[SentNotification] = []

    def notify_member(
        self,
        member_id: str,
        event: NotificationEvent,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        self.sent.append(
            SentNotification(
                audience=NotificationAudience.MEMBER,
                recipient_id=str(member_id),
                event=event,
                payload=dict(payload or {}),
            )
        )

    def notify_academy_admin(
        self,
        academy_id: str,
        event: NotificationEvent,
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        self.sent.append(
            SentNotification(
                audience=NotificationAudience.ACADEMY_ADMIN,
                recipient_id=str(academy_id),
                event=event,
                payload=dict(payload or {}),
            )
        )

    # -- 테스트 편의 -------------------------------------------------------- #

    def sent_to(self, audience: NotificationAudience) -> list[SentNotification]:
        """특정 수신자 대상 기록만 추린다."""
        return [n for n in self.sent if n.audience is audience]

    def reset(self) -> None:
        self.sent.clear()
