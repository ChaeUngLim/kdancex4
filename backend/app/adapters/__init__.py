"""외부 시스템 경계 어댑터.

각 모듈은 Protocol(포트) 하나 + Fake 구현을 제공한다. 서비스 계층은 **Protocol만**
import 하고 구상 클래스는 ``app/deps.py``가 주입한다.

* :mod:`~app.adapters.payment_gateway` — PG 환불 (포트원 V2 스키마 기준). ``RefundStatus`` 소유
* :mod:`~app.adapters.notification` — 회원·학원 관리자 2방향 알림
* :mod:`~app.adapters.slot_lock` — Redis 슬롯 락 해제 (실패 시 no-op)
"""

# 학습 주석: SCH-04(어댑터 3종: PG/알림/슬롯락) 반영
#
# 사전 개념 (이 폴더 전체를 읽기 전에):
# - Protocol(구조적 타이핑, structural typing): 파이썬 typing 모듈이 제공하는
#   기능으로, "이 타입을 상속해야 한다"가 아니라 "이 메서드들만 갖고 있으면
#   된다"는 방식으로 인터페이스를 정의한다. 예를 들어 아래 PaymentGateway는
#   refund() 메서드 하나만 요구하고, FakePaymentGateway는 PaymentGateway를
#   상속하지 않고도 refund()만 구현하면 "PaymentGateway답게" 취급된다(각 모듈의
#   @runtime_checkable이 그 사실을 isinstance()로도 확인할 수 있게 해준다).
#   서비스 계층(취소 오케스트레이션 서비스 — SCH-05)이 실제 포트원 연동
#   클래스가 아니라 이 Protocol 타입만 import하게 만드는 이유가 이것이다 —
#   PG사를 바꾸거나 테스트용 Fake로 바꿔치기해도 서비스 코드는 "refund()가
#   있다"는 사실만 알면 되므로 한 줄도 바뀌지 않는다.
# - 포트/어댑터 패턴: PG·알림·Redis처럼 이 프로젝트가 직접 통제할 수 없는
#   외부 시스템을, 서비스 코드가 직접 호출하지 않고 이 폴더의 얇은 계층
#   (어댑터)을 거쳐서만 호출하게 만드는 구조다. 외부 API가 바뀌거나(PG사
#   교체) 아예 없어도(로컬 개발, 테스트) 서비스 코드는 변경 없이 그대로
#   동작한다 — 위 모듈독스트링의 "계층 규칙"이 이 패턴을 코드로 표현한 것이다.
# - 이 폴더는 "무엇을 할 수 있어야 하는지"(Protocol)와 "테스트에서 쓸 가짜
#   구현"(Fake)까지만 정의한다. 실제 구상 클래스(RedisSlotLock 등)를 어디서
#   만들어 서비스에 주입하는지는 SCH-05가 만드는 app/deps.py의 몫이다.

from app.adapters.notification import (
    FakeNotificationSender,
    NotificationAudience,
    NotificationEvent,
    NotificationSender,
    SentNotification,
)
from app.adapters.payment_gateway import (
    FakePaymentGateway,
    PaymentGateway,
    PaymentGatewayError,
    PaymentMethod,
    RefundAccount,
    RefundRequest,
    RefundResult,
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

__all__ = [
    "SLOT_LOCK_KEY_NAMESPACE",
    "FakeNotificationSender",
    "FakePaymentGateway",
    "NotificationAudience",
    "NotificationEvent",
    "NotificationSender",
    "NullSlotLock",
    "PaymentGateway",
    "PaymentGatewayError",
    "PaymentMethod",
    "RedisSlotLock",
    "RefundAccount",
    "RefundRequest",
    "RefundResult",
    "RefundStatus",
    "SentNotification",
    "SlotLock",
    "UnsupportedPaymentMethodError",
    "parse_portone_cancel_response",
    "slot_lock_key",
]
