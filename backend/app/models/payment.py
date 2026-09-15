"""결제 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - CHECK 제약: `method`처럼 허용값 집합을, `amount >= 0`처럼 숫자 범위를 DB가
#   직접 강제한다(class_schedule.py 학습 주석에 상세 설명).
# - FK(외래키): `order_id`가 실제 존재하는 `orders.id`를 가리키도록 DB가
#   보장한다. `ondelete="CASCADE"`로 주문이 지워지면 결제 행도 함께 지워진다.

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# services/cancellation.py의 _find_paid_payment가 order_id로 이 테이블에서
# paid_at이 채워진(완료된) 결제를 찾아 gateway_payment_key를 얻고, 그 값으로
# adapters/payment_gateway.py에 실제 환불을 요청한다.
class Payment(TimestampMixin, Base):
    """주문에 대한 결제 원거래. 환불은 이 행의 `gateway_payment_key`를 참조한다."""

    __tablename__ = "payments"
    __table_args__ = (
        # 공유 계약 §4.1: payments.method = {virtual_account, card}
        # card는 이번 범위 밖이지만 값 집합에는 존재한다(어댑터가 명시적으로 거부).
        CheckConstraint(
            "method IN ('virtual_account', 'card')",
            name="ck_payments_method",
        ),
        CheckConstraint("amount >= 0", name="ck_payments_amount"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="CASCADE", name="fk_payments_order_id"),
        nullable=False,
        index=True,
    )
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    gateway_payment_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
