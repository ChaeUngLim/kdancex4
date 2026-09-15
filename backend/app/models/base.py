"""SQLAlchemy 선언적 기반 클래스와 공통 믹스인."""
# 학습 주석: SCH-01(기반 배선) 반영

# 사전 개념 요약
# - ORM(Object-Relational Mapping): SQL 문을 직접 쓰는 대신 DB 테이블을 파이썬 클래스로
#   다루는 방식. 클래스 하나가 테이블 하나, 인스턴스 하나가 행(row) 하나에 대응한다.
# - `DeclarativeBase`를 상속한 `Base`: "이 클래스를 상속하는 모든 서브클래스는 ORM
#   모델이다"라고 표시하는 공통 부모(SQLAlchemy 2.0 스타일). Base가 갖는 `metadata`
#   객체에 모든 모델의 테이블 정의가 자동으로 모이고, alembic이 이 metadata와 실제
#   DB 스키마를 비교해 마이그레이션을 만든다(backend/alembic/env.py 참고).
# - Mixin 패턴: 여러 모델이 공통으로 갖는 컬럼(여기서는 생성/수정 시각)을 별도 클래스로
#   뽑아 두고, 필요한 모델이 다중 상속으로 갖다 쓰는 방식. 컬럼 정의 중복을 없앤다.

from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# 이 프로젝트의 모든 ORM 모델(Academy, ClassSchedule, Order 등, models/__init__.py 참고)이
# 이 클래스를 상속한다. 각 모델이 import되는 순간 그 테이블 정의가 Base.metadata에
# 쌓이고, alembic/env.py의 target_metadata가 이 metadata를 참조해 자동 마이그레이션을 만든다.
class Base(DeclarativeBase):
    """모든 ORM 모델의 공통 기반. alembic의 target_metadata가 이 metadata를 본다."""


# created_at/updated_at이 필요한 모델이 Base와 함께 다중 상속해서 쓰는 믹스인.
# 그 자체로는 테이블을 갖지 않고 컬럼 정의만 제공한다.
class TimestampMixin:
    """생성/수정 시각 컬럼. 기본값은 DB 서버 시각(UTC)."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
