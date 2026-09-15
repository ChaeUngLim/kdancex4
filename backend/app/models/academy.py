"""학원(스튜디오) 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - JSONB 컬럼: PostgreSQL 전용 타입으로, 컬럼 하나에 구조화된 JSON을 그대로
#   저장한다. 학원마다 환불 비율 구간 개수·경계가 달라 고정된 컬럼(24h_rate,
#   48h_rate ...)으로는 표현할 수 없는 데이터에 쓴다. 다만 DB가 내부 구조(배열
#   원소의 필드·범위 등)까지 검증해주지는 않으므로, 쓰는 쪽(admin API)의 Pydantic
#   스키마가 그 역할을 대신 해야 한다.

import uuid

from sqlalchemy import String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# routers/admin_academies.py가 이 테이블의 refund_policy_tiers를 조회·수정하고,
# services/cancellation.py(취소 처리 중 환불액 산정 단계)가 같은 컬럼을 읽어
# 환불 비율을 계산한다.
class Academy(TimestampMixin, Base):
    """학원. 환불 비율표를 학원 단위로 보유한다.

    `refund_policy_tiers`는 JSONB 배열이며 각 원소 형태는 공유 계약 §4.4 고정:
        [{"hours_before_start": 24, "refund_rate_bp": 5000}, ...]
    `refund_rate_bp`는 basis point 정수(0~10000)다. 부동소수를 쓰지 않는다.

    JSONB는 DB가 구조를 검증해주지 않으므로 쓰기 경로(admin API)의
    Pydantic 스키마가 정렬·중복·범위를 반드시 막아야 한다.
    """

    __tablename__ = "academies"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    refund_policy_tiers: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
