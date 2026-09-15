"""initial domain — academies / class_schedules / orders / payments / reservations / refunds / refund_events

이 리비전은 **손으로 작성했다.** `--autogenerate`를 쓰지 않은 이유는 작성 시점에
Docker(Postgres)가 기동되지 않아 autogenerate가 요구하는 실제 DB 연결이 불가능했기
때문이다. 대신 `app/models/*`의 선언과 문자 단위로 일치시켰고, DB가 올라온 뒤
TS-11이 `upgrade head` → `--autogenerate`(빈 diff여야 정합) → `downgrade base`로
검증한다.

상태/구분 컬럼은 PG 네이티브 ENUM이 아니라 VARCHAR + CHECK다(공유 계약 §4.1).
네이티브 ENUM은 값 제거가 사실상 불가능하고 autogenerate가 변경을 감지하지 못한다.

Revision ID: 0001_initial_domain
Revises:
Create Date: 2026-09-14

"""
# 학습 주석: SCH-02(도메인 모델 7개 + 초기 마이그레이션) 반영

# 사전 개념 요약
# - Alembic 자체(무엇이고 왜 쓰는지, target_metadata와의 관계)는
#   SCH-01(backend/alembic/env.py) 참고. 여기서는 리비전 파일 "한 개"의
#   구조만 새로 설명한다.
# - 리비전 파일 구조: `revision`은 이 파일 자신을 가리키는 ID, `down_revision`은
#   "이 리비전이 적용되기 직전에 DB가 있어야 하는 리비전"이다. Alembic은 모든
#   리비전 파일의 이 두 값을 이어서 체인(연결 리스트)을 만들고, 그 순서대로
#   적용한다 — 이 파일은 `down_revision = None`이라 체인의 첫 리비전이다.
#   실제로 DB에 DDL(CREATE TABLE 등)을 실행하는 곳은 아래 `upgrade()`/
#   `downgrade()` 두 함수뿐이고, 파일 상단의 변수들은 Alembic이 "다음에 어느
#   리비전을 실행할지" 순서를 찾는 데만 쓰인다.

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001_initial_domain"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# `alembic upgrade head`(또는 TS-11의 검증 절차)가 호출한다. app/models/*의
# 7개 ORM 모델 선언과 문자 단위로 일치하도록 손으로 맞춘 DDL이며, 실행하면
# 이 리비전이 정의하는 7개 테이블이 실제 PostgreSQL(kdance-db)에 생성된다.
def upgrade() -> None:
    # --- academies -----------------------------------------------------
    op.create_table(
        "academies",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        # 환불 비율표. 기본값 [] — 비율표를 설정하지 않은 학원은 24h 이내 환불 0%가 된다.
        sa.Column(
            "refund_policy_tiers",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    # --- orders --------------------------------------------------------
    op.create_table(
        "orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("total_amount", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'paid', 'refunded')",
            name="ck_orders_status",
        ),
        sa.CheckConstraint("total_amount >= 0", name="ck_orders_total_amount"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_orders_user_id", "orders", ["user_id"], unique=False)

    # --- class_schedules -----------------------------------------------
    op.create_table(
        "class_schedules",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("academy_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price_amount", sa.Integer(), nullable=False),
        sa.Column("capacity", sa.Integer(), nullable=False),
        sa.Column(
            "reserved_count",
            sa.Integer(),
            server_default="0",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("price_amount >= 0", name="ck_class_schedules_price_amount"),
        sa.CheckConstraint("capacity > 0", name="ck_class_schedules_capacity"),
        # 슬롯 정원 복구가 음수나 정원 초과로 흐르는 것을 DB가 막는다.
        sa.CheckConstraint(
            "reserved_count >= 0 AND reserved_count <= capacity",
            name="ck_class_schedules_reserved_count",
        ),
        sa.ForeignKeyConstraint(
            ["academy_id"],
            ["academies.id"],
            name="fk_class_schedules_academy_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_class_schedules_academy_id",
        "class_schedules",
        ["academy_id"],
        unique=False,
    )

    # --- payments ------------------------------------------------------
    op.create_table(
        "payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("method", sa.String(length=32), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("gateway_payment_key", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "method IN ('virtual_account', 'card')",
            name="ck_payments_method",
        ),
        sa.CheckConstraint("amount >= 0", name="ck_payments_amount"),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name="fk_payments_order_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_payments_order_id", "payments", ["order_id"], unique=False)

    # --- reservations --------------------------------------------------
    op.create_table(
        "reservations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("class_schedule_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('held', 'confirmed', 'cancelled')",
            name="ck_reservations_status",
        ),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name="fk_reservations_order_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["class_schedule_id"],
            ["class_schedules.id"],
            name="fk_reservations_class_schedule_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reservations_order_id", "reservations", ["order_id"], unique=False)
    op.create_index(
        "ix_reservations_class_schedule_id",
        "reservations",
        ["class_schedule_id"],
        unique=False,
    )
    op.create_index("ix_reservations_user_id", "reservations", ["user_id"], unique=False)

    # --- refunds -------------------------------------------------------
    op.create_table(
        "refunds",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("reservation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("payment_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("requested_amount", sa.Integer(), nullable=False),
        sa.Column("refunded_amount", sa.Integer(), server_default="0", nullable=False),
        sa.Column("refund_rate_bp", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("refund_account_bank_code", sa.String(length=20), nullable=True),
        sa.Column("refund_account_number", sa.String(length=64), nullable=True),
        sa.Column("refund_account_holder_name", sa.String(length=100), nullable=True),
        sa.Column("gateway_refund_id", sa.String(length=200), nullable=True),
        sa.Column("failure_code", sa.String(length=100), nullable=True),
        sa.Column("failure_message", sa.String(length=500), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # 가상계좌 환불은 즉시 완료되지 않으므로 pending이 1급 상태다.
        sa.CheckConstraint(
            "status IN ('succeeded', 'pending', 'failed')",
            name="ck_refunds_status",
        ),
        # member_request 하나만. academy_fault는 이번 범위 밖(Q5 확정).
        sa.CheckConstraint(
            "reason IN ('member_request')",
            name="ck_refunds_reason",
        ),
        sa.CheckConstraint("requested_amount >= 0", name="ck_refunds_requested_amount"),
        sa.CheckConstraint("refunded_amount >= 0", name="ck_refunds_refunded_amount"),
        sa.CheckConstraint(
            "refunded_amount <= requested_amount",
            name="ck_refunds_amount_order",
        ),
        sa.CheckConstraint(
            "refund_rate_bp >= 0 AND refund_rate_bp <= 10000",
            name="ck_refunds_refund_rate_bp",
        ),
        sa.ForeignKeyConstraint(
            ["reservation_id"],
            ["reservations.id"],
            name="fk_refunds_reservation_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["payments.id"],
            name="fk_refunds_payment_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uq_refunds_idempotency_key"),
    )
    op.create_index("ix_refunds_reservation_id", "refunds", ["reservation_id"], unique=False)
    op.create_index("ix_refunds_payment_id", "refunds", ["payment_id"], unique=False)
    # 이중 환불이 구조적으로 불가능해지는 지점. 예약당 진행중/성공 환불은 최대 1건이고
    # 실패 건은 인덱스 밖이라 재시도를 허용한다. 'failed' 문자열은 위 ck_refunds_status의
    # 값 집합에 정확히 의존한다(공유 계약 §4.1).
    op.create_index(
        "uq_refunds_reservation_id_active",
        "refunds",
        ["reservation_id"],
        unique=True,
        postgresql_where=sa.text("status <> 'failed'"),
    )

    # --- refund_events -------------------------------------------------
    # append-only 감사 로그. UPDATE/DELETE 하지 않으므로 updated_at이 없다.
    op.create_table(
        "refund_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("refund_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(length=50), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["refund_id"],
            ["refunds.id"],
            name="fk_refund_events_refund_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_refund_events_refund_id", "refund_events", ["refund_id"], unique=False)


# `alembic downgrade base`(또는 TS-11의 왕복 검증: upgrade → autogenerate 빈 diff
# 확인 → downgrade)가 호출한다. upgrade()가 만든 7개 테이블을 전부 없애 스키마를
# 이 리비전 적용 이전 상태로 되돌린다.
def downgrade() -> None:
    # upgrade의 역순. 인덱스를 명시적으로 먼저 떨어뜨린다 — drop_table이 어차피
    # 같이 지우지만, 명시해야 "downgrade가 upgrade의 모든 객체를 되돌린다"를
    # 파일만 읽고 확인할 수 있다. CHECK·FK·UNIQUE 제약은 테이블에 귀속되므로
    # drop_table로 함께 제거된다.
    op.drop_index("ix_refund_events_refund_id", table_name="refund_events")
    op.drop_table("refund_events")

    op.drop_index("uq_refunds_reservation_id_active", table_name="refunds")
    op.drop_index("ix_refunds_payment_id", table_name="refunds")
    op.drop_index("ix_refunds_reservation_id", table_name="refunds")
    op.drop_table("refunds")

    op.drop_index("ix_reservations_user_id", table_name="reservations")
    op.drop_index("ix_reservations_class_schedule_id", table_name="reservations")
    op.drop_index("ix_reservations_order_id", table_name="reservations")
    op.drop_table("reservations")

    op.drop_index("ix_payments_order_id", table_name="payments")
    op.drop_table("payments")

    op.drop_index("ix_class_schedules_academy_id", table_name="class_schedules")
    op.drop_table("class_schedules")

    op.drop_index("ix_orders_user_id", table_name="orders")
    op.drop_table("orders")

    op.drop_table("academies")
