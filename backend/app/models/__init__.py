"""ORM 모델 패키지.

도메인 모델이 추가되면 여기서 import 해야 `Base.metadata`에 등록되고
alembic autogenerate가 인식한다. **하나라도 빠뜨리면 autogenerate가 그 테이블을
조용히 누락한다** — 에러가 아니라 빈 diff로 나오므로 눈치채기 어렵다.
"""
# 학습 주석: SCH-01(기반 배선), SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영
# (ORM/Base/metadata 개념은 app/models/base.py 참고)
# SCH-02(도메인 모델 7개 + 초기 마이그레이션)가 만든 도메인 모델 7개(Academy/ClassSchedule/Order/Payment/Refund/
# RefundEvent/Reservation)가 전부 여기서 re-export된다 — 다른 모듈은 개별
# `app.models.academy` 대신 `app.models`에서 바로 import해도 된다.

from app.models.academy import Academy
from app.models.base import Base, TimestampMixin
from app.models.class_schedule import ClassSchedule
from app.models.order import Order
from app.models.payment import Payment
from app.models.refund import Refund
from app.models.refund_event import RefundEvent
from app.models.reservation import Reservation

__all__ = [
    "Academy",
    "Base",
    "ClassSchedule",
    "Order",
    "Payment",
    "Refund",
    "RefundEvent",
    "Reservation",
    "TimestampMixin",
]
