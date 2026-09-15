"""DB 엔진 · 세션 · FastAPI 의존성.

`create_engine`은 lazy라 모듈 import 시점에 실제 연결을 열지 않는다
(DB가 꺼져 있어도 import는 성공해야 한다).
"""
# 학습 주석: SCH-01(기반 배선) 반영

# 사전 개념 요약
# - Engine: SQLAlchemy에서 실제 DB 커넥션 풀을 관리하는 객체. 앱 전체에서 하나만
#   만들어 재사용한다(요청마다 새로 만들지 않음) — 커넥션을 맺고 끊는 비용이 크기 때문.
# - Session: Engine에서 커넥션을 빌려와 쓰는 "작업 단위(unit of work)". 하나의 요청 —
#   또는 하나의 트랜잭션 — 동안 조회/추가/수정한 내용을 추적하다가 commit 시점에
#   한 번에 DB에 반영한다. Engine은 앱 생명주기 동안 하나, Session은 요청마다 새로 만든다.
# - 의존성 주입 제너레이터 패턴(`get_db`): FastAPI 라우터 함수에
#   `db: Session = Depends(get_db)`로 주입되는 함수. `yield` 이전은 "요청 시작 시 준비",
#   `yield`한 값이 라우터에 전달되는 세션, `finally`의 `db.close()`는 "요청이 끝나면
#   (정상/예외 무관) 반드시 정리"를 보장한다 — FastAPI가 이 제너레이터를 컨텍스트
#   매니저처럼 다뤄준다.

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

# 앱 전체에서 공유하는 단일 Engine. 라우터/서비스 계층은 이 engine을 직접 쓰지 않고
# 아래 get_db()를 통해 세션 단위로만 접근한다.
engine = create_engine(
    get_settings().database_url,
    # 커넥션 풀에서 꺼낸 연결이 실제로 살아있는지 매번 가벼운 ping으로 확인한다.
    # DB 컨테이너 재시작 등으로 죽은 커넥션을 재사용하다 에러가 나는 상황을 막는다.
    pool_pre_ping=True,
    future=True,
)

# 요청마다 새로 생성되는 Session의 "설계도"(팩토리). get_db()가 이 SessionLocal()을
# 호출해 실제 Session 인스턴스를 만든다.
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    # commit 후에도 이미 조회한 객체의 속성값을 그대로 메모리에 들고 있게 한다.
    # 기본값(True)이면 commit 직후 객체 속성에 접근할 때마다 DB를 다시 조회하는데,
    # 응답을 만들 때 이미 커밋된 객체를 계속 읽는 경우가 많아 불필요한 재조회를 막기 위해 끈다.
    expire_on_commit=False,
)


# FastAPI 라우터가 `Depends(get_db)`로 주입받는 함수. 요청마다 세션을 새로 열고,
# 응답이 끝나면(성공/예외 무관) 반드시 닫는다 — 위 "의존성 주입 제너레이터 패턴" 참고.
def get_db() -> Generator[Session, None, None]:
    """요청 단위 세션을 주는 FastAPI 의존성."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
