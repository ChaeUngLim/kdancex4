"""환불 감사 로그 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base 개념은 SCH-01(app/models/base.py) 참고. 이 모델은 TimestampMixin을
#   상속하지 않는다 — 이유는 아래 append-only 설명 참고.
# - "append-only(추가 전용) 감사 로그" 패턴: 한 번 쓰면 그 행을 절대 UPDATE·
#   DELETE하지 않고, 상태가 바뀔 때마다 새 행을 INSERT만 하는 테이블 설계다.
#   "언제 무슨 일이 있었는지"를 그대로 남겨야 하는 감사 로그에 쓴다. 이 모델이
#   `updated_at`을 갖는 TimestampMixin을 안 쓰는 이유가 바로 이것 — updated_at
#   컬럼이 있으면 "이 행은 나중에 고쳐질 수도 있다"는 인상을 주므로, 대신
#   `created_at`만 직접 선언해 append-only라는 의도를 컬럼 목록만 보고도
#   알 수 있게 한다.
# - JSONB 컬럼 개념은 academy.py 학습 주석 참고. 여기서는 이벤트 종류마다
#   담기는 필드가 달라지는 `payload`에 쓴다.
# - FK(외래키) 개념은 class_schedule.py 학습 주석 참고.

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


# services/cancellation.py가 환불 요청·산정·실행·실패 각 시점마다 이 테이블에
# INSERT만 한다(_record_event류 헬퍼, refund.py 참고). 이 리비전 시점에는 조회
# API가 없고, 장애 조사·사후 검증 목적의 감사 기록으로만 쓰인다.
class RefundEvent(Base):
    """환불 상태 전이 감사 로그. **append-only** — UPDATE도 DELETE도 하지 않는다.

    서비스가 요청·산정·실행·실패 시점마다 INSERT만 한다. 그래서 `TimestampMixin`을
    쓰지 않는다 — `updated_at`이 존재하면 이 테이블이 수정 가능한 것처럼 읽힌다.

    `payload`는 JSONB다. 이벤트 종류마다 담기는 필드가 달라서 컬럼으로 고정할 수
    없고, 감사 로그의 성격상 나중에 필드가 늘어나도 과거 행을 마이그레이션하지
    않아야 한다.
    """

    __tablename__ = "refund_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    refund_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("refunds.id", ondelete="CASCADE", name="fk_refund_events_refund_id"),
        nullable=False,
        index=True,
    )
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
