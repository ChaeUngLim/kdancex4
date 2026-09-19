# TS-01 기반 배선 — 구현 요약

- **태스크**: TS-01 기반 배선 — 메타데이터·설정·DB 세션
- **웨이브**: W1 (TS-08/09/10과 병렬). backend 외 파일 미변경 — 충돌 없음
- **상태**: 완료. 완료 기준 4개 전부 통과
- **Docker**: 꺼진 상태로 완료. 실제 DB 연결 없음

---

## 1. 변경 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/app/models/base.py` | 신규 | `class Base(DeclarativeBase)` + `TimestampMixin`(`created_at`/`updated_at`, `DateTime(timezone=True)`, `server_default=func.now()`, `updated_at`에 `onupdate=func.now()`) |
| `backend/app/models/__init__.py` | 신규 | `Base`·`TimestampMixin` re-export + `__all__`. 도메인 모델은 TS-02가 추가 |
| `backend/app/config.py` | 신규 | pydantic-settings `Settings`(`database_url`, `test_database_url`, `redis_url`) + `@lru_cache get_settings()`. `env_file`은 `Path(__file__).parent.parent / ".env"` 절대경로 — cwd 무관하게 로드 |
| `backend/app/db.py` | 신규 | `create_engine(get_settings().database_url, pool_pre_ping=True, future=True)`, `SessionLocal`(`autoflush=False`, `expire_on_commit=False`), `get_db()` yield/close 의존성 |
| `backend/alembic/env.py` | 수정 (35행) | `target_metadata = None` → `from app.models import Base` / `target_metadata = Base.metadata` |
| `backend/pyproject.toml` | 수정 | deps에 `pydantic-settings>=2.7.0`·`redis>=5.2.0`, dev에 `uvicorn>=0.34.0`. `[tool.pytest.ini_options]` 신설 (`testpaths = ["tests"]`, `markers = ["requires_db: ..."]`) |
| `backend/.env.example` | 수정 | `TEST_DATABASE_URL`·`REDIS_URL` 추가 |
| `backend/.env` | 수정 | 동일 2줄 추가 (gitignore 대상이라 `git status`에 안 나옴 — 정상) |
| `backend/uv.lock` | 수정 | `uv sync --all-groups` 결과. 신규 설치: `pydantic-settings 2.15.0`, `redis 8.1.0`, `uvicorn 0.52.4`, `click 8.5.0`(uvicorn 전이) |

---

## 2. 완료 기준 검증

| 기준 | 결과 | 실측 |
|---|---|---|
| `uv run python -c "from app.models import Base; print(Base.metadata)"` | **통과** | `MetaData()` 출력 (모델 0건이라 빈 것이 정상) |
| `uv run python -c "from app.db import get_db, SessionLocal"` | **통과** | 연결 시도 없이 import 성공. `Engine(postgresql+psycopg://kdance:***@localhost:5433/kdance)` — lazy 확인 |
| `uv run pytest` 초록 (`test_health.py` 유지) | **통과** | `1 passed`. `configfile: pyproject.toml`, `testpaths: tests` 적용 확인 |
| `alembic/env.py`에 `target_metadata = Base.metadata` 실제 반영 | **통과** | 파일 반영 + `uv run alembic upgrade head --sql`(오프라인, DB 불필요) exit=0 — env.py가 실제로 `from app.models import Base`를 실행하고 통과함을 실측 |

추가 실측: `get_settings()`가 `.env`에서 3개 값 모두 로드 — `redis://localhost:6380/0`, `.../kdance_test` 확인.

---

## 3. 발견한 이슈 / 후속 태스크에 전달할 사항

### 3.1 `db.py` 엔진은 import 시점에 `database_url`로 고정된다 (TS-07 주의)
`engine`을 모듈 최상단에서 생성하므로 `TEST_DATABASE_URL`로 갈아끼우는 방법은 **엔진 교체가 아니라 `app.dependency_overrides[get_db]` 오버라이드**다.
Phase 3 계획 §61이 "트랜잭션 롤백 방식, 프로덕션 코드에 흔적 남기지 않음"으로 정한 것과 일치하므로 `db.py`에 테스트 분기를 넣지 않았다.
TS-07은 자체 엔진을 `get_settings().test_database_url`로 따로 만들고 `get_db`를 오버라이드할 것.

### 3.2 `alembic/env.py`의 `from app.models import Base`는 cwd에 의존
`alembic.ini:21 prepend_sys_path = .`가 **cwd 기준 상대경로**라, alembic은 반드시 `backend/`에서 실행해야 한다.
TS-11의 up/down/autogenerate 검증 시 `cd backend && uv run alembic ...` 형태 유지 필요. (기존 설정을 그대로 둔 것이고 이번에 바꾸지 않았다.)

### 3.3 `Base.metadata`가 현재 비어 있는 것은 정상이나 TS-02가 지켜야 할 전제
`models/__init__.py`에 모델을 import해야 `Base.metadata`에 등록된다. TS-02가 모델 파일만 만들고 `__init__.py`에 import를 추가하지 않으면 **autogenerate가 조용히 빈 diff를 뱉는다** (TS-01 완료 기준이 경고한 것과 같은 실패 모드가 한 단계 뒤로 옮겨진 것). `__init__.py` docstring에 해당 내용을 명시해 뒀다.

### 3.4 `python-dotenv`와 `pydantic-settings` 이중 로드
`alembic/env.py`는 기존대로 `load_dotenv()`로 `DATABASE_URL`을 읽고, 앱 코드는 `pydantic-settings`로 읽는다. 두 경로가 같은 `.env`를 보므로 값 불일치는 없지만 로더가 둘이다.
`env.py`를 `get_settings()` 기반으로 통일하는 것은 **TS-01 범위 밖**(계획에 없음)이라 건드리지 않았다. 정리하려면 별도 태스크 필요.

### 3.5 기존 경고 (이번 변경과 무관, 사전 존재)
`pytest` 출력에 `StarletteDeprecationWarning: Using httpx with starlette.testclient is deprecated; install httpx2 instead` 2건. 테스트는 통과하며 TS-01이 유발한 것이 아니다. TS-07이 테스트 하네스를 만들 때 `httpx2` 전환 여부를 판단할 것.

---

## 4. 미해결 사항

없음. Phase 7 이관 대상 없음. 계획과 실제 코드 간 불일치도 없었다 (`alembic/env.py:35`의 `target_metadata = None`이 계획대로 그 위치에 있었음).
