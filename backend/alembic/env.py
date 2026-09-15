# 학습 주석: SCH-01(기반 배선) 반영

# 사전 개념 요약
# - Alembic: SQLAlchemy 진영에서 쓰는 DB 마이그레이션 도구. "지금 코드의 모델 정의"와
#   "실제 DB에 적용된 스키마"를 비교해서 그 차이를 SQL로 바꿔주는 마이그레이션
#   스크립트(backend/alembic/versions/*.py)를 만들고 실행한다.
# - `target_metadata`: 위 비교의 기준이 되는 "코드가 말하는 정답 스키마". 여기서는
#   app/models/base.py의 Base.metadata를 가리키는데, app/models/__init__.py가 모든
#   모델을 import해둬야 그 모델들의 테이블 정의가 이 metadata에 실제로 채워진다.
# - offline/online 모드: online은 실제 DB에 연결해서 마이그레이션을 실행하고,
#   offline은 연결 없이 실행될 SQL 문자열만 출력한다(DB 접근 권한이 없는 환경에서
#   SQL을 미리 뽑아 DBA에게 전달하는 용도 등).

from logging.config import fileConfig

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

import os

from dotenv import load_dotenv

# alembic CLI는 backend/.env를 자동으로 읽지 않으므로, 여기서 직접 로드해
# DATABASE_URL 같은 환경변수를 마이그레이션 실행 시점에 쓸 수 있게 한다.
load_dotenv()

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# alembic.ini에 박아둔 접속 문자열 대신, 환경변수(DATABASE_URL)가 있으면 그걸 쓰고
# 없으면 로컬 개발 기본값으로 fallback한다 — 운영/테스트 환경마다 DB가 다르기 때문.
config.set_main_option(
    "sqlalchemy.url",
    os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://kdance:kdance@localhost:5433/kdance",
    ),
)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# add your model's MetaData object here
# for 'autogenerate' support
# app/models/__init__.py가 모든 모델을 import하는 부분이 바로 이 줄에서 트리거된다 —
# 이 import가 실행되어야 Base.metadata에 전체 테이블 정의가 채워진다.
from app.models import Base  # noqa: E402

# alembic autogenerate가 "코드가 말하는 정답"으로 참조하는 metadata. 아래 offline/online
# 두 실행 경로 모두 이 target_metadata를 context.configure()에 넘긴다.
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


# `alembic upgrade --sql`처럼 DB에 연결하지 않고 실행될 SQL만 뽑아내고 싶을 때
# 호출되는 경로.
def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


# 일반적인 `alembic upgrade head`/`alembic revision --autogenerate` 실행 시 호출되는
# 경로 — 실제로 DB에 연결해 마이그레이션을 적용(또는 비교)한다. 로컬 개발/CI에서
# 기본으로 쓰는 경로는 이쪽이다.
def run_migrations_online() -> None:
    """Run migrations in 'online' mode.

    In this scenario we need to create an Engine
    and associate a connection with the context.

    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection, target_metadata=target_metadata
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
