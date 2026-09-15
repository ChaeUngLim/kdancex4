"""예약 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - CHECK 제약: `status` 허용값 집합을 DB가 강제한다(class_schedule.py 학습
#   주석에 상세 설명).
# - FK(외래키): `order_id`/`class_schedule_id`가 각각 실제 존재하는
#   `orders.id`/`class_schedules.id`를 가리키도록 DB가 보장한다.

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# routers/reservations.py의 취소/미리보기 API가 다루는 중심 테이블이다.
# services/cancellation.py가 `SELECT ... FOR UPDATE`로 이 행을 잠근 뒤 소유권
# (user_id)과 상태를 검사하고, 취소가 확정되면 status를 "cancelled"로 바꾼다.
class Reservation(TimestampMixin, Base):
    """수업 일정에 대한 예약. 취소 시 `SELECT ... FOR UPDATE`로 이 행을 잠근다.

    `user_id`는 소유권 검증(본인 예약만 취소, 타인 403)용이다. 인증 자체는
    이번 슬라이스에 없고 `X-User-Id` 헤더를 읽는 임시 의존성으로 대체한다.
    """

    __tablename__ = "reservations"
    __table_args__ = (
        # 공유 계약 §4.1: reservations.status = {held, confirmed, cancelled}
        CheckConstraint(
            "status IN ('held', 'confirmed', 'cancelled')",
            name="ck_reservations_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="CASCADE", name="fk_reservations_order_id"),
        nullable=False,
        index=True,
    )
    class_schedule_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "class_schedules.id",
            ondelete="CASCADE",
            name="fk_reservations_class_schedule_id",
        ),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
