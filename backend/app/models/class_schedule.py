"""수업 일정(슬롯) 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - CHECK 제약(`CheckConstraint`): "이 컬럼(들)은 항상 이 조건을 만족해야 한다"를
#   DB 엔진 레벨에서 강제하는 제약. 애플리케이션 코드가 검증을 깜빡하거나 다른
#   경로(수동 SQL, 다른 서비스)로 값이 들어와도 DB가 거부하므로, 파이썬 레벨
#   검증보다 한 단계 더 안전한 최후 방어선이 된다.
# - FK(외래키, `ForeignKey`): 이 컬럼의 값이 다른 테이블의 특정 컬럼(대개 PK)에
#   실제로 존재해야 함을 DB가 보장하는 제약. `ondelete="CASCADE"`는 참조 대상
#   행이 삭제되면 이 행도 함께 삭제하라는 지시다.

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# services/cancellation.py가 취소 처리 중 이 테이블을 두 번 건드린다:
# starts_at으로 "이미 시작한 수업인가"를 판정하고, 취소가 확정되면
# `UPDATE ... WHERE reserved_count > 0`으로 reserved_count를 원자적으로 감소시킨다.
class ClassSchedule(TimestampMixin, Base):
    """수업 1회차. 슬롯 정원의 source of truth는 Redis가 아니라 이 테이블이다.

    `reserved_count`를 집계가 아니라 컬럼으로 두는 이유: 목록 화면이 정원 대비
    신청 인원(8/12)을 자주 조회하고, CHECK 제약이 음수·정원 초과를 구조적으로 막는다.
    취소 시 `SELECT ... FOR UPDATE` 안에서 감소시킨다.
    """

    __tablename__ = "class_schedules"
    __table_args__ = (
        CheckConstraint("price_amount >= 0", name="ck_class_schedules_price_amount"),
        CheckConstraint("capacity > 0", name="ck_class_schedules_capacity"),
        CheckConstraint(
            "reserved_count >= 0 AND reserved_count <= capacity",
            name="ck_class_schedules_reserved_count",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    academy_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("academies.id", ondelete="CASCADE", name="fk_class_schedules_academy_id"),
        nullable=False,
        index=True,
    )
    # 전 시각 컬럼은 TIMESTAMP WITH TIME ZONE(UTC). 24시간 경계 판정의 기준값이다.
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 금액은 정수(원). 부동소수를 쓰지 않는다.
    price_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    reserved_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
