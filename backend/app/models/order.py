"""주문 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - CHECK 제약(`CheckConstraint`): 컬럼 값이 특정 범위·집합을 벗어나지 못하게
#   DB 엔진이 직접 막는 제약. 아래 `status` 컬럼처럼 "이 문자열들 중 하나여야
#   한다"는 허용값 강제에도 쓰고, `total_amount >= 0`처럼 숫자 범위 강제에도 쓴다.

import uuid

from sqlalchemy import CheckConstraint, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# services/cancellation.py가 취소 확정 시 이 행의 status를 "refunded"로 갱신한다
# (Order당 Reservation 1건이 전제이므로 취소 = 전체 취소와 같다).
class Order(TimestampMixin, Base):
    """결제 단위 주문. 이번 슬라이스에서는 Order당 Reservation 1건(부분 취소 범위 제외).

    상태 컬럼은 PG 네이티브 ENUM이 아니라 VARCHAR + CHECK다. 값 집합이 바뀔 때
    네이티브 ENUM은 제거·순서 변경이 사실상 불가능하고 autogenerate가 변경을 놓친다.
    """

    __tablename__ = "orders"
    __table_args__ = (
        # 공유 계약 §4.1: orders.status = {pending, paid, refunded}
        CheckConstraint(
            "status IN ('pending', 'paid', 'refunded')",
            name="ck_orders_status",
        ),
        CheckConstraint("total_amount >= 0", name="ck_orders_total_amount"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    total_amount: Mapped[int] = mapped_column(Integer, nullable=False)
