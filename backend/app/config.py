"""애플리케이션 설정. 환경변수(.env) 기반."""
# 학습 주석: SCH-01(기반 배선) 반영

# 사전 개념 요약
# - pydantic-settings(BaseSettings): 환경변수/.env 파일 값을 파이썬 타입으로 검증하며
#   읽어주는 라이브러리. 클래스에 타입 힌트로 필드를 선언하면 같은 이름의 환경변수를
#   찾아 그 타입으로 변환해준다 — 환경변수는 원래 전부 문자열이라 직접 다루면 타입
#   오류를 실행 중에야 발견하는데, 이를 미리 막아준다.
# - `@lru_cache`: 인자가 같으면 이전 반환값을 그대로 재사용하는 캐시 데코레이터.
#   `get_settings()`는 인자가 없으므로 사실상 "첫 호출 때만 Settings()를 만들고 이후
#   호출은 그 인스턴스를 재사용"하는 싱글턴 역할을 한다 — 매번 .env를 다시 읽고
#   파싱하는 비용을 없앤다.

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 이 파일(config.py)의 위치를 기준으로 .env 경로를 절대경로로 고정한다.
# 상대경로(".env")를 쓰면 프로세스를 어느 디렉터리에서 실행하느냐(uv run, pytest,
# alembic 등)에 따라 같은 .env를 못 찾는 문제가 생겨 절대경로로 계산해둔다.
_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


# db.py의 engine 생성, alembic/env.py, 그리고 설정값이 필요한 라우터/서비스가 모두
# get_settings()를 통해 이 클래스의 인스턴스를 읽는다 — 설정값의 단일 소스(source of truth).
class Settings(BaseSettings):
    """환경변수에서 읽는 런타임 설정.

    포트는 로컬 개발 컨테이너 기준이며 표준 포트가 아니다
    (Postgres 5433, Redis 6380 — 같은 머신의 다른 프로젝트 컨테이너와 충돌 회피).
    """

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql+psycopg://kdance:kdance@localhost:5433/kdance"
    test_database_url: str = (
        "postgresql+psycopg://kdance:kdance@localhost:5433/kdance_test"
    )
    redis_url: str = "redis://localhost:6380/0"


# db.py의 전역 engine 생성 등, 설정이 필요한 모든 곳이 이 함수를 통해서만 Settings에
# 접근한다 — Settings()를 직접 호출하지 않는 이유는 위 lru_cache 설명 참고.
@lru_cache
def get_settings() -> Settings:
    """프로세스 단위로 캐시된 Settings 인스턴스."""
    return Settings()
