"""환불 모델."""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - ORM/Base/TimestampMixin 개념은 SCH-01(app/models/base.py) 참고.
# - CHECK 제약: 허용값 집합·숫자 범위를 DB가 강제한다(class_schedule.py 학습
#   주석에 상세 설명). 이 모델은 status/reason 허용값과 금액 범위 모두에 쓴다.
# - UNIQUE 제약과 "partial unique index"(조건부 유니크): 그냥 `UNIQUE(reservation_id)`를
#   걸면 그 예약에 대한 환불 행이 영원히 1건으로 묶여, 실패한 환불을 재시도할
#   새 행을 만들 수 없다. `postgresql_where`로 조건을 건 partial unique index는
#   "status가 'failed'가 아닌 행끼리만" 유니크를 검사하므로, 실패 건은 그대로
#   두고 새 시도 행을 추가할 수 있다 — 일반 UNIQUE로는 이 구분을 표현할 수 없다.
# - FK(외래키): `reservation_id`/`payment_id`가 각각 실제 존재하는 행을
#   가리키도록 DB가 보장한다.

import uuid

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


# services/cancellation.py의 cancel_reservation이 취소 확정 시 이 행을 INSERT하고,
# adapters/payment_gateway.py 호출 결과에 따라 status(succeeded/pending/failed)와
# failure_code/failure_message를 채운다. refund_events(같은 패키지)는 이 행에
# 벌어진 상태 전이를 별도로 감사 로그로 남긴다.
class Refund(TimestampMixin, Base):
    """예약 취소에 따른 환불. 이중 환불을 DB 차원에서 구조적으로 막는다.

    두 겹의 방어가 있다:

    1. `idempotency_key` UNIQUE — 같은 논리 요청의 재시도가 같은 행으로 수렴한다.
       클라이언트가 `Idempotency-Key` 헤더를 안 보내도 서비스가 결정적으로 생성한다.
    2. partial unique index `UNIQUE (reservation_id) WHERE status <> 'failed'` —
       예약당 진행중(pending)/성공(succeeded) 환불은 최대 1건. 실패 건은 남겨두고
       재시도를 허용해야 하므로 인덱스에서 제외한다.

    `status`/`reason`은 PG 네이티브 ENUM이 아니라 VARCHAR + CHECK다(공유 계약 §4.1).
    모델 계층은 `RefundStatus`(adapters)·`CancellationReason`(services)을
    **import하지 않는다** — models가 services/adapters를 참조하면 계층이 역전된다.
    값 일치는 공유 계약 §4.1 표가 보증하고 통합 테스트가 실측한다(§4.2).
    """

    __tablename__ = "refunds"
    __table_args__ = (
        # 공유 계약 §4.1: refunds.status = {succeeded, pending, failed}
        # 가상계좌 환불은 즉시 완료되지 않으므로 pending이 정상 상태다.
        CheckConstraint(
            "status IN ('succeeded', 'pending', 'failed')",
            name="ck_refunds_status",
        ),
        # 공유 계약 §4.1: refunds.reason = {member_request} 하나만.
        # 학원 귀책 취소(academy_fault)는 이번 범위 밖(Q5 확정). 추가할 때는
        # 이 CHECK를 바꾸는 마이그레이션 1건이면 된다.
        CheckConstraint(
            "reason IN ('member_request')",
            name="ck_refunds_reason",
        ),
        CheckConstraint("requested_amount >= 0", name="ck_refunds_requested_amount"),
        CheckConstraint("refunded_amount >= 0", name="ck_refunds_refunded_amount"),
        # 실제 환불액이 산정액을 넘을 수 없다. 결제액 대비 상한은 CHECK로 표현할 수
        # 없으므로(다른 테이블 참조 불가) 산정 함수의 clamp가 담당한다.
        CheckConstraint(
            "refunded_amount <= requested_amount",
            name="ck_refunds_amount_order",
        ),
        CheckConstraint(
            "refund_rate_bp >= 0 AND refund_rate_bp <= 10000",
            name="ck_refunds_refund_rate_bp",
        ),
        # 이름을 명시한다. 이름 없이 두면 PG가 `refunds_idempotency_key_key`를
        # 붙이고 손작성 마이그레이션과 이름이 어긋나 autogenerate가 diff를 낸다.
        UniqueConstraint("idempotency_key", name="uq_refunds_idempotency_key"),
        Index(
            "uq_refunds_reservation_id_active",
            "reservation_id",
            unique=True,
            postgresql_where=text("status <> 'failed'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    reservation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("reservations.id", ondelete="CASCADE", name="fk_refunds_reservation_id"),
        nullable=False,
        index=True,
    )
    payment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("payments.id", ondelete="CASCADE", name="fk_refunds_payment_id"),
        nullable=False,
        index=True,
    )
    idempotency_key: Mapped[str] = mapped_column(String(200), nullable=False)
    # 금액은 전부 정수(원). 부동소수를 쓰지 않는다.
    requested_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    refunded_amount: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
    )
    # basis point 정수 0~10000 (공유 계약 §4.4). 퍼센트·float를 쓰지 않는다.
    refund_rate_bp: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str] = mapped_column(String(32), nullable=False)
    # 가상계좌 환불은 별도 송금이라 환불 계좌 수집이 필요하다.
    # 카드 환불은 원거래 취소라 계좌가 없으므로 전부 nullable이다.
    refund_account_bank_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    refund_account_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    refund_account_holder_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    gateway_refund_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 수용 기준: 환불 실패 시 사유가 기록되어야 한다.
    failure_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    failure_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
