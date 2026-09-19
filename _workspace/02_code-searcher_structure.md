# Phase 2 — 코드베이스 구조 조사 (예약 취소 환불 로직)

조사일: 2026-09-14 / 브랜치 `main` / HEAD `48f048d`
조사 범위: backend, alembic, admin-web, mobile, infra, docs, 로컬 DB

**한 줄 결론:** Phase 1 요약("backend에 도메인 코드 사실상 없음")은 정확하다. 직접 확인 결과 `backend/`의 `.py` 파일은 `.venv` 제외 5개뿐이고, SQLAlchemy 모델·라우터·세션 코드가 **문자 단위로 0건**이다. 이번 수직 슬라이스는 사실상 그린필드다.

---

## 1. `backend/` 프로젝트 구조

### 1.1 실제 파일 목록 (`.venv`, `__pycache__` 제외)

```
backend/
├── pyproject.toml
├── uv.lock
├── alembic.ini
├── .python-version          # "3.12"
├── .env / .env.example      # DATABASE_URL 한 줄뿐
├── README.md                # 0 바이트 (빈 파일)
├── alembic/
│   ├── env.py
│   ├── README
│   ├── script.py.mako
│   └── versions/.gitkeep    # 리비전 0건
├── app/
│   ├── __init__.py          # 0 바이트
│   └── main.py              # 8줄
└── tests/
    ├── __init__.py          # 0 바이트
    └── test_health.py       # 11줄
```

전체 `.py` 파일: `alembic/env.py`, `app/__init__.py`, `app/main.py`, `tests/__init__.py`, `tests/test_health.py`. **끝.**

도메인 코드 부재 교차검증 — 다음 패턴으로 `backend/` 전체(`.venv` 제외)를 훑었고 **매치 0건**이다:
`DeclarativeBase` / `declarative_base` / `Mapped[` / `mapped_column` / `APIRouter` / `sessionmaker` / `create_engine` / `relationship(`

즉 모델 레이어, 라우터 분리, DB 세션 관리 중 **어느 것도 존재하지 않는다.** `app/main.py`가 `FastAPI()` 인스턴스를 직접 들고 데코레이터로 엔드포인트를 직접 다는 단일 파일 구조다.

### 1.2 `pyproject.toml` (`backend/pyproject.toml:1-22`)

```toml
requires-python = ">=3.12"
dependencies = [
    "alembic>=1.20.0",        # :11
    "fastapi>=0.141.1",       # :12
    "psycopg[binary]>=3.3.5", # :13
    "python-dotenv>=1.2.3",   # :14
    "sqlalchemy>=2",          # :15
]
[dependency-groups]
dev = ["httpx>=0.28.1", "pytest>=9.1.1"]   # :19-21
```

`.venv`에 **실제 설치된** 버전 (`importlib.metadata` 직접 조회):

| 패키지 | 버전 | 비고 |
|---|---|---|
| fastapi | 0.141.1 | |
| starlette | 1.6.0 | |
| sqlalchemy | 2.0.52 | 2.x 계열 확정 (`Mapped[]` / `mapped_column` 스타일 사용 가능) |
| alembic | 1.20.0 | |
| psycopg | 3.3.5 | psycopg3, binary 익스트라 |
| **pydantic** | **2.13.5** | ⚠️ **`pyproject.toml`에 선언 안 됨 — fastapi 통해 들어온 전이 의존성** |
| pydantic-core | 2.46.5 | |
| python-dotenv | 1.2.3 | |
| pytest | 9.1.1 | |
| httpx | 0.28.1 | TestClient 구동용 |
| greenlet | 3.5.5 | SQLAlchemy 동기/asyncio 브리지 |
| anyio | 4.15.1 | |

**미설치 (Phase 3에서 `uv add` 필요할 수 있는 것들):**

| 패키지 | 상태 | 이번 작업 관련성 |
|---|---|---|
| `uvicorn` | ❌ | `fastapi`를 `[standard]` 없이 bare로 깔아서 ASGI 서버가 없다. `.venv/bin/fastapi` 바이너리는 있으나 `fastapi dev` 실행 불가. `.superpowers/sdd/2026-09-13-kdance-scaffold/task-3-report.md:53`에 이 사실이 이미 기록돼 있다(“pytest evidence is the binding verification”). |
| `redis` | ❌ | **FR-42 슬롯 락 구현 시 필수** |
| `pytest-asyncio` | ❌ | async 엔드포인트/세션 테스트하려면 필요 |
| `asyncpg` | ❌ | 현재 DSN이 `postgresql+psycopg://`라 동기 psycopg3 전제. async 갈 거면 psycopg async 사용 가능(별도 설치 불필요) |
| `apscheduler` | ❌ | 개발 가이드에서 "신규"로 잡아둔 항목 (가이드 `:325-329`) |

### 1.3 없는 것 — 컨벤션 판단에 중요

- **`conftest.py` 없음** (파일 목록에 부재). 테스트 픽스처/DB 격리 장치가 전무.
- **`[tool.pytest.ini_options]` 없음** — `pyproject.toml`에 `[tool.*]` 섹션 자체가 0개. pytest는 rootdir 기준 기본 동작에 의존.
- **린터/포매터 없음** — backend에 ruff/black/mypy 설정 전무. (admin-web만 oxlint 있음)
- **설정(Settings) 모듈 없음** — `pydantic-settings` 미설치. 환경변수는 `alembic/env.py`에서만 `os.environ.get`으로 읽는다.
- **`app/` 하위 서브패키지 0개** — `models/`, `routers/`, `schemas/`, `services/`, `db/` 전부 없음.

### 1.4 빌드·테스트 명령 컨벤션 (`.superpowers/sdd/2026-09-13-kdance-scaffold/*.md`에서 확인)

CLAUDE.md의 "Build, Test & Verify" 섹션이 비어 있어서, 스캐폴드 작업 기록에서 실제 사용된 명령을 추출했다:

```bash
cd backend && uv run pytest tests/test_health.py -v
cd backend && uv run alembic current
cd backend && uv run alembic revision --autogenerate -m "..."
cd backend && uv run alembic upgrade head
cd backend && uv add <pkg>          # 런타임 의존성
cd backend && uv add --dev <pkg>    # 개발 의존성
cd admin-web && npm run build
cd admin-web && npm run dev
```

**모델을 어디에 둘지 판단 근거:** 기존 컨벤션이 사실상 없다. `app/` 패키지가 있고 `app.main:app`이 진입점이라는 것만 확정. 따라서 Phase 3가 레이아웃을 새로 정해야 하며, 그 결정을 제약하는 기존 코드는 없다. (§9 권고 참조)

---

## 2. `backend/alembic/` 설정 상태

### 2.1 `alembic.ini`

- `backend/alembic.ini:8` — `script_location = %(here)s/alembic`
- `backend/alembic.ini:21` — `prepend_sys_path = .` (→ `backend/`를 sys.path에 넣으므로 `from app.models import ...` 임포트가 env.py에서 동작함)
- `backend/alembic.ini:75` — `path_separator = os`
- `backend/alembic.ini:89` — `sqlalchemy.url = driver://user:pass@localhost/dbname` ← **플레이스홀더 그대로**. env.py가 런타임에 덮어쓴다.
- `:117-149` — 기본 로깅 설정. 커스터마이즈 없음.
- `:92-113` — `[post_write_hooks]` 전부 주석 처리 (ruff/black 훅 미적용)

### 2.2 `alembic/env.py` — 스캐폴드에서 2군데만 수정됨

```python
# backend/alembic/env.py:8-12
import os
from dotenv import load_dotenv
load_dotenv()

# backend/alembic/env.py:18-24
config.set_main_option(
    "sqlalchemy.url",
    os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://kdance:kdance@localhost:5433/kdance",
    ),
)

# backend/alembic/env.py:35
target_metadata = None          # ⚠️ 여기가 핵심
```

**`target_metadata = None` (`backend/alembic/env.py:35`)** — 이 상태에서는 `alembic revision --autogenerate`가 **빈 마이그레이션을 뱉는다.** 모델을 만든 직후 이 줄을 `Base.metadata`로 바꾸는 것이 Phase 3의 **첫 번째 필수 작업**이다. 이걸 빼먹으면 모델을 아무리 잘 만들어도 테이블이 안 생긴다.

나머지 `run_migrations_offline` (`:43-64`) / `run_migrations_online` (`:67-86`)은 alembic 기본 템플릿 그대로다. 동기 엔진(`engine_from_config` + `pool.NullPool`) 전제.

### 2.3 `versions/` — 리비전 0건 (확정)

```
backend/alembic/versions/
└── .gitkeep     (0 바이트, 유일한 파일)
```

`.superpowers/.../task-4-report.md`에도 "리비전 없음, 모델 없음"으로 기록돼 있고 `alembic current`가 클린하게 돌았다고 남아 있다. 즉 이번에 만들 마이그레이션이 **`down_revision = None`인 최초 리비전**이 된다.

### 2.4 `script.py.mako`

`backend/alembic/script.py.mako:15-18` — alembic 1.20 기본 템플릿. `revision: str`, `down_revision: Union[str, Sequence[str], None]` 타입 어노테이션 포함. 수정 없음.

---

## 3. `app/main.py` · `tests/test_health.py` 실제 코드

### 3.1 `backend/app/main.py` (전문, 8줄)

```python
from fastapi import FastAPI

app = FastAPI(title="kdance")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

읽히는 패턴:
- `app = FastAPI(title="kdance")` — 팩토리 함수(`create_app()`) 아님, **모듈 레벨 싱글턴**
- 라우트를 `main.py`에 데코레이터로 직접 부착 — `APIRouter` 미사용
- **동기 함수** (`def`, `async def` 아님)
- **반환 타입 어노테이션 사용** (`-> dict[str, str]`), PEP 585 내장 제네릭 (3.12)
- `response_model` 미지정, Pydantic 스키마 미사용

→ 새 API를 추가할 때 이 파일에 계속 붙일지, `APIRouter`로 분리하고 `app.include_router()` 할지는 열려 있다. 취소 API 하나만 봐도 예약·주문·결제·환불 4개 리소스가 엮이므로 라우터 분리가 합리적이다(§9).

### 3.2 `backend/tests/test_health.py` (전문, 11줄)

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

읽히는 패턴:
- `from app.main import app` — 절대 임포트. `backend/`가 rootdir이어야 동작 (§1.4의 `cd backend && uv run pytest`와 일치)
- **모듈 레벨 `TestClient(app)`** — 픽스처 없음
- 테스트 함수명 `test_<대상>_<기대결과>` 형태 (`test_health_returns_ok`)
- 클래스 그루핑 없음, 파라미터라이즈 없음, 마커 없음
- **DB를 전혀 건드리지 않는다** — 그래서 DB 없이도 통과한다

⚠️ **Phase 3가 반드시 풀어야 할 문제:** 취소/환불 테스트는 DB가 필요하다. 현재 `conftest.py`도, 테스트 DB 격리 전략(트랜잭션 롤백 / 스키마 분리 / SQLite 대체)도, `get_db` 의존성 오버라이드 훅도 **하나도 없다.** 이건 새로 설계해야 하는 항목이며, 기존 `test_health.py` 패턴은 여기에 아무 답을 주지 않는다.

---

## 4. `docs/social-dance-app-dev-guide.html` — API 계약 조사

### 4.1 결론부터: 취소·환불 계약은 **문서에 없다**

`docs/social-dance-app-dev-guide.html` (49,872 바이트) 전문을 파싱해 키워드 빈도를 센 결과:

| 키워드 | 히트 수 |
|---|---|
| `취소` | **0** |
| `환불` | **0** |
| `Refund` | **0** |
| `Reservation` | **0** |
| `FR-` (모든 FR 코드) | **0** |
| `예약` | 19 |
| `정원` | 5 |
| `슬롯` | 1 |
| `Redis` | 2 |
| `Push` | 2 |

**즉 이 파일에서 취소/환불 API 계약을 가져올 수 없다.** 그리고 **FR-42/FR-43/FR-92는 이 파일에 없다** — 아래 §4.4 참조.

### 4.2 화면↔API 매핑표 (`docs/social-dance-app-dev-guide.html:769-816`)

문서화된 유일한 API 목록이다. **엔드포인트 경로만 있고 request/response 필드 스키마는 어디에도 없다.**

| # | 화면 | API | 모델 | 우선순위 | 라인 |
|---|---|---|---|---|---|
| 01 | 회원가입·대학생 인증 | `POST /auth/verify-phone`, `POST /auth/verify-student` | `User.student_verified_at` | MVP | `:781-783` |
| 02 | 홈 — 카테고리 검색 | `GET /academies?genre&region&day` | 카카오 Local + pgvector | 2단계 | `:784-786` |
| 03 | 학원 상세 | `GET /academies/{id}` | `Academy`, `ClassSchedule` | MVP | `:787-789` |
| 04 | **체크아웃·결제** | **`POST /orders`** (정가−대학생할인−쿠폰 계산 → PG 호출) | **`Order`** | MVP | `:790-792` |
| 05 | 캘린더·알람 | `GET /me/schedule` | expo-notifications + APScheduler | 2단계 | `:793-795` |
| 06 | 길찾기 | 카카오 Local 경로 API 프록시 | — | 3단계 | `:796-797` |
| 07 | 뉴스피드 | `GET /events?type=party\|performance\|competition` | `Event(bookable:bool)` | 2단계 | `:798-800` |
| 08 | 학원 공지 | `GET·POST /academies/{id}/notices` | `Notice` | 2단계 | `:801-803` |
| 09 | 마이·구독 관리 | `GET /me/subscription`, `GET /me/coupons` | `Subscription`, `Coupon` | 4단계 | `:804-806` |
| 10 | 관리자·스케줄 입력 | `POST /admin/schedules` | `ClassSchedule` | MVP | `:807-809` |
| 11 | 관리자·미리보기 | `GET /admin/schedules/{id}/preview` | — | MVP | `:810-813` |
| 12 | 관리자·정산 대시보드 | `GET /admin/settlements` | — | MVP(기본)/4단계(쿠폰) | `:814-816` |

### 4.3 ⚠️ 네이밍 충돌 — Phase 3가 결정해야 함

**기존 설계에는 `Reservation`이라는 개념이 없다.** 결제 흐름의 주체는 `Order`다 (`:791`, 화면 04 "체크아웃 · 결제 ★"). 반면 Phase 1 요구사항은 `POST /reservations/{id}/cancel`을 예상하고 있다.

선택지는 둘:
1. **`POST /orders/{id}/cancel`** — 기존 문서의 `POST /orders`(`:791`)와 리소스 일관. 문서 정합성 ✅
2. **`Reservation`을 새로 도입** — `Order`(돈)와 `Reservation`(자리)을 분리. 개념적으로 더 깔끔하지만 문서에 근거 없음

`:462-465`가 힌트를 준다: 게시 시 "**같은 트랜잭션에서 예약 가능 슬롯과 결제 상품이 함께 생성된다**" — 즉 "예약 슬롯"과 "결제 상품"을 원래부터 **별개 개념으로 본다.** 이건 2번(분리)을 지지하는 근거다. 다만 명시적 모델명은 없다.

→ **Phase 3에서 명시적으로 결정하고 근거를 남겨야 할 항목.** 결정하지 않고 코딩하면 이후 화면 04 연동 때 충돌한다.

### 4.4 FR-42 / FR-43 / FR-92 — 실제 출처는 다른 파일

개발 가이드가 아니라 **`docs/requirements-analysis.md`**에 있다:

- **FR-42** (`docs/requirements-analysis.md:48`)
  > 가상계좌 발급 시점에 해당 슬롯을 Redis 락으로 잠그고, 입금 확인 시 확정·기한 초과 시 해제. 동일 슬롯에 복수 가상계좌가 발급된 경우 먼저 입금 확인된 주문만 확정 (`payment-method-policy.md`)

- **FR-43** (`docs/requirements-analysis.md:49`)
  > PG 웹훅(`payment.completed`) 수신 시 구매자·학원 관리자 양쪽에 즉시 앱 내 알림(Expo Push) 발송 — SMS는 사용하지 않음 (`payment-method-policy.md`, FR-90과 연계)

- **FR-92** (`docs/requirements-analysis.md:79`)
  > 결제 확인 알림은 SMS가 아니라 Expo Push 기반 앱 내 팝업으로 구현 — 무료 API 우선 원칙에 따른 결정 (2026-09-14). **관리자 웹 쪽 실시간 알림 전달 방식(폴링/WebSocket/SSE)은 미정**

관련 근거가 `docs/payment-method-policy.md:38`에도 있다:
> 같은 슬롯에 여러 명이 동시에 가상계좌를 발급받았다가 한 명만 입금한 경우, **먼저 입금 확인된 주문이 슬롯을 확정**하고 나머지는 자동 취소 처리한다.

### 4.5 🔑 환불 정책 원문 — `docs/kdance-screens-spec.html`에 있다

**개발 가이드가 아니라 화면 명세서에 있다.** 이게 "Academy 환불 비율표 설정 필드"의 실제 근거다.

`docs/kdance-screens-spec.html:502-506` (이용약관 핵심 요약 > 결제·환불):
```
수업 시작 24시간 전 취소 — 전액 환불
24시간 이내 취소 — 학원 정책에 따름 (학원 상세 페이지에 명시)
플랫폼은 통신판매중개자 — 학원과 회원 간 계약을 중개함을 결제 화면에 고지
```

동일 내용이 **FR-22**로 정리돼 있다 (`docs/requirements-analysis.md:31`).

체크아웃 화면에도 동의 항목이 이미 있다 — `docs/kdance-screens-spec.html:290`:
> "주문 내용과 취소·환불 정책에 동의합니다"

**환불액 산정 로직 설계에 직접 쓰이는 규칙:**
- 수업 시작 24시간 **초과** 전 취소 → 환불율 **100%** (플랫폼 고정 규칙)
- 수업 시작 24시간 **이내** 취소 → **학원별 설정값** ← 여기가 `Academy` 환불 비율표 필드가 필요한 지점
- 그 비율표는 **학원 상세 페이지에 노출**되어야 한다 (= `GET /academies/{id}` 응답에 포함돼야 함)

⚠️ `_workspace/01_req-analyst_requirements.md:55`가 지적한 갭이 여기서 확인된다 — `payment-method-policy.md`에 **환불 서술이 전무**하고, 가상계좌 환불(계좌 입력 필요)과 카드 승인취소는 구조가 다르다. 가짜 PG 어댑터 인터페이스를 설계할 때 이 둘을 구분할지 결정해야 한다.

### 4.6 Redis 용도 (개발 가이드 원문)

`docs/social-dance-app-dev-guide.html:554-557`:
> **Redis** — 신규
> APScheduler 잡 큐, 그리고 "첫 이용자 50% 할인" 중복 사용 방지용 **단기 락(lock)**에 사용.

`:937-940`:
> 배치·캐시 — APScheduler · Redis — 둘 다 오픈소스, Docker 셀프호스팅. 완전 무료

→ 가이드는 Redis 락을 "할인 중복 방지"용으로만 적어뒀다. **FR-42의 "슬롯 락"은 `requirements-analysis.md`에서 추가된 용도**이고, 두 용도가 같은 Redis 인스턴스를 공유한다. 키 네임스페이스 설계 필요.

### 4.7 알림 (Expo Push) 원문

`docs/social-dance-app-dev-guide.html:943-947`:
> 푸시 알림 — **Expo Push / FCM** — 완전 무료.
> "1일 전 점심 1회·1시간 전 선택 알람"은 **APScheduler가 발송 트리거를 만들고 Expo Push가 무료로 전달** — 추가 비용 없음

`:325-329`:
> **APScheduler** — 신규. 정산 배치, 대학생 무료체험 만료, 수업 전 알람 발송처럼 "정해진 시각에 한 번" 도는 작업이 셋이나 생겨서 필요.

→ 환불 알림은 **즉시 발송**(스케줄 아님)이므로 APScheduler 없이 Expo Push 직접 호출로 충분하다. APScheduler 도입을 이번 슬라이스에 끌어들일 필요 없음.

### 4.8 PG 어댑터 — 가짜 어댑터가 정당한 이유

`docs/social-dance-app-dev-guide.html:315-321`:
> **결제대행(PG) 클라이언트** — 신규.
> 포트원(아임포트) 또는 토스페이먼츠. 선정 기준 둘 — "**하위 가맹점 정산 분배**"와 "**정기결제(빌링키)**" 둘 다 지원 여부 — 학원 대신 받고 수수료를 뗀 나머지를 보내는 구조에, 월 구독까지 겹쳐서 일반 결제 연동보다 요구사항이 많다.

**PG사가 아직 미선정이다.** 따라서 가짜 어댑터(Protocol/ABC + Fake 구현)로 가는 것이 문서상 근거가 확실하다. 실제 SDK를 고르는 순간 되돌리기 비싼 결정이 된다.

### 4.9 정원(capacity) — 슬롯 복구의 대상

`docs/social-dance-app-dev-guide.html:470-473`:
> ⚠ 가격·**정원**은 검토 단계에서 반드시 확인.
> 가격·정원처럼 되돌리기 어려운 필드를 OCR이 잘못 추출한 채 그대로 게시하면 실제 예약·결제가 잘못된 조건으로 열린다 — 버그가 아니라 **돈 사고**다.

`:488-491` 표: 수업 스케줄은 "예약·결제: **있음** — 정원·가격 검토 필수"

→ `ClassSchedule`에 `capacity`(정원) 필드가 있어야 하고, **"슬롯 복구" = 해당 스케줄의 잔여 정원 +1**이다. 화면에도 이미 노출 중 — `docs/kdance-screens-spec.html:272` "정원 대비 신청 인원(8/12)을 보여줘 마감 임박을 유도한다".

---

## 5. `infra/docker-compose.yml` — Redis 구성

`infra/docker-compose.yml` 전문(33줄) 확인. **Redis는 이미 정의돼 있다.**

```yaml
# infra/docker-compose.yml:20-30
  redis:
    image: redis:alpine          # :21
    container_name: kdance-redis # :22
    restart: unless-stopped      # :23
    ports:
      - "6380:6379"              # :25  ← 호스트 6380
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]  # :27
      interval: 5s
      timeout: 3s
      retries: 5
```

DB 쪽 (`:2-18`): `pgvector/pgvector:pg18`, 컨테이너 `kdance-db`, 포트 **`5433:5432`**, user/pw/db 전부 `kdance`, 볼륨 `kdance-db-data`.

### Phase 3가 알아야 할 것

| 항목 | 상태 |
|---|---|
| Redis 호스트 포트 | **6380** (표준 6379 아님 — mobydick과의 충돌 회피 추정) |
| 접속 URL | `redis://localhost:6380/0` |
| 비밀번호 | 없음 (`requirepass` 미설정) |
| 영속성 | ❌ **볼륨 없음** — 컨테이너 재시작 시 전부 날아감. 슬롯 락 같은 단기 TTL 데이터에는 문제없으나, 락이 "유일한 진실"이 되면 안 된다는 뜻이다. 정원 잔여수는 반드시 **DB가 source of truth**여야 한다. |
| ⚠️ `REDIS_URL` 환경변수 | **`backend/.env`·`.env.example`에 없다.** 현재 `DATABASE_URL` 한 줄뿐(`backend/.env.example:1`). Phase 3에서 두 파일 모두에 추가해야 한다. |
| ⚠️ `redis` 파이썬 패키지 | **미설치.** `cd backend && uv add redis` 필요. |

---

## 6. `admin-web/` 구조

### 6.1 실제 파일

```
admin-web/
├── package.json, vite.config.ts, index.html
├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
├── .oxlintrc.json
├── public/{favicon.svg, icons.svg}
└── src/
    ├── main.tsx        # 10줄
    ├── App.tsx         # 21줄
    ├── index.css, App.css
    └── assets/{hero.png, react.svg, vite.svg}
```

`src/` 하위에 **디렉터리가 `assets/` 하나뿐이다.** `pages/`, `components/`, `api/`, `hooks/`, `routes/` 전부 없음.

### 6.2 의존성 (`admin-web/package.json:12-24`)

```json
"dependencies":   { "react": "^19.2.8", "react-dom": "^19.2.8" }
"devDependencies": { "@types/node": "^24.13.3", "@types/react": "^19.2.18",
                     "@types/react-dom": "^19.2.7", "@vitejs/plugin-react": "^6.1.1",
                     "oxlint": "^1.81.0", "typescript": "~6.0.2", "vite": "^8.3.0" }
```

**런타임 의존성이 react + react-dom **딱 둘**이다.**

| 라이브러리 | 상태 | Academy 설정 화면 영향 |
|---|---|---|
| 라우터 (`react-router`, `@tanstack/router`) | ❌ **없음** | 설정 화면을 별도 URL로 만들려면 라우터 도입이 선행 과제 |
| 상태관리 (`zustand`, `redux`, `jotai`) | ❌ **없음** | `useState`로 충분한 규모 |
| 데이터 페칭 (`@tanstack/react-query`, `swr`) | ❌ **없음** | 현재 생 `fetch` + `useEffect` |
| UI 라이브러리 (MUI, shadcn, Tailwind) | ❌ **없음** | 순수 CSS |
| 폼 (`react-hook-form`) | ❌ **없음** | 환불 비율표 입력 폼을 수동 구현하거나 도입 |
| 테스트 (vitest, testing-library) | ❌ **없음** | admin-web에 테스트 인프라 자체가 없음 |

스크립트 (`:6-11`): `dev`(vite) / `build`(`tsc -b && vite build`) / `lint`(oxlint) / `preview`.

### 6.3 `src/App.tsx` (전문, `admin-web/src/App.tsx:1-21`)

```tsx
import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState<string>("확인 중...");

  useEffect(() => {
    fetch("http://localhost:8000/health")   // :7  ← 하드코딩
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus("백엔드 연결 실패"));
  }, []);

  return (
    <main>
      <h1>kdance 관리자 콘솔</h1>
      <p>백엔드 상태: {status}</p>
    </main>
  );
}

export default App;
```

- 백엔드 URL이 **`admin-web/src/App.tsx:7`에 하드코딩**돼 있다. `.env`/`import.meta.env` 미사용. API 클라이언트 모듈 없음.
- UI 텍스트는 **한국어**.
- `main.tsx:6-9` — `StrictMode` + `createRoot`, 라우터 래핑 없음.
- `tsconfig.app.json:20-23` — `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch` 활성. **`strict`는 명시돼 있지 않다.**
- `.oxlintrc.json:4-7` — `react/rules-of-hooks: error`, `react/only-export-components: warn`

**Academy 설정 화면 배치 판단:** 라우터가 없으므로 선택지는 (a) 라우터 도입 후 `/settings/refund-policy` 같은 경로, (b) `App.tsx`에 탭/조건부 렌더링으로 임시 배치. 이번 수직 슬라이스의 "최소" 성격을 고려하면 (b)가 맞지만, 화면 12개가 예정된 프로젝트라 (a)를 언제 할지는 Phase 3가 판단할 것.

---

## 7. `mobile/` 구조

### 7.1 실제 파일

```
mobile/
├── package.json, app.json, tsconfig.json
├── index.ts        # 8줄  — registerRootComponent(App)
├── App.tsx         # 29줄
├── AGENTS.md, CLAUDE.md(11바이트), LICENSE
├── .env            # ⚠️ 14KB — §7.4 참조
└── assets/         # 아이콘 6종 (png)
```

`src/` 디렉터리 없음. 컴포넌트/화면/네비게이션 구조 전무.

### 7.2 의존성 (`mobile/package.json:5-14`)

```json
"dependencies":   { "expo": "^57.0.0", "expo-status-bar": "~57.0.1",
                    "react": "19.2.3", "react-native": "0.86.3" }
"devDependencies": { "@types/react": "~19.2.2", "typescript": "~6.0.3" }
```

Expo SDK 57 순정 템플릿 그대로. 스크립트는 `start`/`android`/`ios`/`web` (`:15-20`).

### 7.3 ⚠️ Push 알림 관련 설정 — **전무**

`mobile/app.json` 전문(24줄)을 확인했다:

```json
{ "expo": {
    "name": "mobile", "slug": "mobile", "version": "1.0.0",
    "orientation": "portrait", "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": { "supportsTablet": true },
    "android": { "adaptiveIcon": {...}, "predictiveBackGestureEnabled": false },
    "web": { "favicon": "./assets/favicon.png" }
} }
```

| 필요 항목 | 상태 |
|---|---|
| `expo-notifications` 패키지 | ❌ 미설치 (node_modules 검색 결과 notification/push 관련 패키지 0건) |
| `expo-device` / `expo-constants` | ❌ 미설치 |
| `extra.eas.projectId` | ❌ 없음 — **`getExpoPushTokenAsync()`에 필수** |
| `plugins` 배열 | ❌ 없음 (`expo-notifications` 플러그인 등록 자리) |
| `android.googleServicesFile` / FCM 설정 | ❌ 없음 |
| `notification` 설정 블록 | ❌ 없음 |
| **`android.package`** | ❌ **없음** — CLAUDE.md는 `com.kdancex3`라고 하는데 app.json에 반영 안 됨 |
| `name`/`slug` | ⚠️ 둘 다 `"mobile"` — 제품명 `K-DanceX3` 미반영 |
| 네비게이션 (expo-router, react-navigation) | ❌ 없음 |

→ **Expo Push는 이번 슬라이스에서 "구현"이 아니라 "인터페이스만 두고 no-op"으로 가는 것이 현실적이다.** 실제 푸시를 동작시키려면 EAS 프로젝트 생성 + `projectId` 발급 + 패키지 3종 설치 + 실기기 테스트가 필요하고, 이건 별개 작업 단위다. 백엔드 쪽은 `NotificationSender` Protocol + Fake 구현으로 충분하다(PG 어댑터와 같은 전략).

### 7.4 ⚠️ `mobile/.env` 위생 문제 (부수 발견)

`mobile/.env`가 **14,193 바이트**이고, 내용이 이 프로젝트 것이 아니다. 추출한 키 목록에 `NVIDIA_API_KEY`, `TOUR_API_KEY`, `ODSAY_API_KEY`, `KMA_API_HUB_KEY`, `CULTURE_FACILITY_ENDPOINT`, `MODEL_ROUTER`, `MODEL_RERANKER`, `EMBED_DIM`, `PG_DSN`, `TAVILY_API_KEY` 등 **다른 프로젝트(mobydick 추정)의 키가 대량 포함**돼 있고, `EXPO_PUBLIC_NAVER_MAP_CLIENT_ID`는 중복 정의돼 있다.

- 루트 `.gitignore:7`의 `.env`로 커밋에서는 제외된다 (유출 위험 낮음)
- 다만 kdance용으로 쓸 만한 키는 `EXPO_PUBLIC_API_URL` 정도이고, 나머지는 혼동만 유발한다
- `mobile/.env.example`이 없다
- **이번 작업 범위 밖이지만 Phase 3에서 "정리 권고" 항목으로 남길 가치가 있다**

---

## 8. DB 실제 상태 확인 — ⚠️ **검증 실패 (미확인)**

### 8.1 `mcp__postgres-kdance__query` 도구를 쓸 수 없었다

이 세션의 MCP 도구 목록에 **`mcp__postgres-kdance__query`가 존재하지 않는다.** 조회 가능한 postgres MCP는 `mcp__postgres-mobydick__query` 하나뿐이고, 이건 무관한 DB다. `ToolSearch`로 `select:mcp__postgres-kdance__query` 조회 시 "No matching deferred tools found" 응답.

(참고: `omniroute` MCP 서버도 ConnectionRefused로 연결 실패 상태다.)

### 8.2 직접 접속도 실패 — **DB가 떠 있지 않다**

우회로 `backend/.venv`의 psycopg3로 직접 붙어봤다:

```
postgresql://kdance:kdance@localhost:5433/kdance
→ OperationalError: connection failed:
  connection to server at "127.0.0.1", port 5433 failed: Connection refused
```

추가 확인:
- `docker` CLI: **이 WSL2 배포판에서 사용 불가** ("could not be found in this WSL 2 distro" — Docker Desktop WSL 통합 미활성)
- 리스닝 포트 스캔(`ss -ltn`): **5433, 6380, 5432, 6379 모두 열려 있지 않음**

→ `kdance-db`와 `kdance-redis` 컨테이너가 **현재 실행 중이 아니다.**

### 8.3 그래서 교차검증 결과는?

**직접 확인하지 못했다.** 정직하게 미확인으로 남긴다. 다만 코드 증거로 강하게 추론할 수 있다:

| 근거 | 내용 |
|---|---|
| `backend/alembic/versions/` | `.gitkeep` 외 파일 0개 → 적용 가능한 리비전이 애초에 없음 |
| `backend/alembic/env.py:35` | `target_metadata = None` |
| 모델 코드 | grep 결과 0건 (§1.1) |
| `.superpowers/.../task-4-report.md:30` | 당시 라이브 `kdance-db`에 대해 `alembic current`를 2회 실행, "zero revisions" 클린 결과 기록 |

→ **`alembic_version` 테이블조차 없을 가능성이 높다.** `alembic current`는 조회만 하므로 `alembic_version`을 생성하지 않고, `alembic upgrade`가 한 번도 실행된 적이 없기 때문이다. 도메인 테이블은 확실히 0개다(생성할 코드가 존재한 적 없음).

**신뢰도: 중간.** 코드·기록상으로는 "모델 0개 = DB 테이블 0개"가 일관되지만, 누군가 수동 SQL로 테이블을 만들었을 가능성은 배제하지 못했다.

### 8.4 Phase 3 착수 전 선행 조건 (블로커)

```bash
cd /home/user/kdance/infra && docker compose up -d    # Docker Desktop WSL 통합 활성화 필요
cd /home/user/kdance/backend && uv run alembic current   # 기대: 빈 출력(리비전 없음)
```

`docker` CLI가 이 환경에서 안 되므로, **사용자가 Docker Desktop의 WSL 통합을 켜야** 마이그레이션·DB 테스트가 가능하다. Phase 3 계획에 이걸 명시적 선행 조건으로 넣어야 한다.

---

## 9. 요약 — Phase 3를 위한 파일 배치 결론

### 9.1 현재 상태 한눈에

| 영역 | 상태 |
|---|---|
| 백엔드 도메인 코드 | **0** (모델·라우터·세션·스키마 전부 없음) |
| Alembic 리비전 | **0** (`target_metadata = None`) |
| DB 테이블 | **0으로 추정** (직접 확인 실패 — DB 미기동) |
| 백엔드 테스트 인프라 | `test_health.py` 1개, `conftest.py` 없음, DB 격리 전략 없음 |
| Redis | compose에 정의됨(6380), 파이썬 패키지 미설치, `REDIS_URL` 미정의 |
| admin-web | 라우터·상태관리·폼·데이터페칭 라이브러리 **전부 없음** |
| mobile | Push 관련 설정·패키지 **전부 없음**, `android.package`조차 미설정 |
| 취소/환불 API 계약 문서 | **없음** (개발 가이드에 `취소`/`환불` 0회) |
| 환불 정책 원문 | `docs/kdance-screens-spec.html:502-506` = FR-22 |

### 9.2 새 파일 배치 권고 (backend)

기존 컨벤션이 `app/main.py` 단일 파일뿐이라 제약이 없다. 아래는 FastAPI 관례 + 이번 슬라이스 범위에 맞춘 **권고안**이며, Phase 3가 확정할 사항이다.

```
backend/
├── app/
│   ├── main.py                  # 수정: include_router() 추가 (기존 /health는 유지)
│   ├── config.py                # 신규: DATABASE_URL / REDIS_URL 로딩
│   ├── db.py                    # 신규: engine, SessionLocal, get_db 의존성
│   ├── models/
│   │   ├── __init__.py          # Base + 전 모델 re-export (alembic autogenerate가 여기를 임포트)
│   │   ├── base.py              # DeclarativeBase, 공통 타임스탬프 믹스인
│   │   ├── academy.py           # Academy (+ 환불 비율표 필드)
│   │   ├── class_schedule.py    # ClassSchedule (capacity 포함)
│   │   ├── reservation.py       # Reservation  ← §4.3 네이밍 결정 필요
│   │   ├── order.py             # Order
│   │   ├── payment.py           # Payment
│   │   └── refund.py            # Refund
│   ├── schemas/
│   │   └── reservation.py       # Pydantic v2 request/response
│   ├── routers/
│   │   └── reservations.py      # POST /reservations/{id}/cancel
│   ├── services/
│   │   ├── refund_policy.py     # 환불액 산정 (순수 함수 — 테스트하기 쉽게)
│   │   └── cancellation.py      # 취소 오케스트레이션 (트랜잭션 + 슬롯 복구 + 알림)
│   └── adapters/
│       ├── pg.py                # PaymentGateway Protocol + FakePaymentGateway
│       ├── push.py              # NotificationSender Protocol + FakeNotificationSender
│       └── slot_lock.py         # Redis 슬롯 락 (해제/복구)
├── alembic/
│   ├── env.py                   # 수정 필수: :35 target_metadata = Base.metadata
│   └── versions/
│       └── <rev>_initial_domain_models.py   # down_revision = None (최초 리비전)
└── tests/
    ├── conftest.py              # 신규 필수: DB 픽스처, get_db 오버라이드, Fake 어댑터 주입
    ├── test_health.py           # 기존 유지
    ├── test_refund_policy.py    # 환불액 산정 단위 테스트 (DB 불필요 — 여기를 두껍게)
    └── test_cancel_api.py       # 취소 API 통합 테스트
```

**배치 근거:**
- `app/models/__init__.py`에 모든 모델을 모으는 이유 — `alembic/env.py`가 `prepend_sys_path = .`(`alembic.ini:21`) 덕분에 `from app.models import Base` 한 줄로 전체 메타데이터를 얻을 수 있다. 모델 파일을 빼먹으면 autogenerate가 조용히 그 테이블을 누락한다.
- `services/refund_policy.py`를 순수 함수로 분리하는 이유 — 개발 가이드 `:311`이 "**결제 금액 계산은 특히 케이스를 두껍게**"라고 명시했다. DB 없이 테스트 가능해야 케이스를 두껍게 쌓을 수 있다.
- `adapters/`에 Protocol + Fake를 두는 이유 — PG사 미선정(`:315-321`)이고 Expo Push도 인프라 미비(§7.3). 둘 다 같은 이유로 같은 패턴을 쓴다.

### 9.3 배치 권고 (admin-web / mobile)

- **admin-web**: 라우터가 없으므로 최소 변경으로는 `src/pages/RefundPolicySettings.tsx` 신규 + `App.tsx`에서 조건부 렌더링. 동시에 `src/api/client.ts`를 만들어 `App.tsx:7`의 하드코딩 URL을 `import.meta.env.VITE_API_BASE_URL`로 빼는 것을 권고(이번에 두 번째 fetch 지점이 생기므로 지금이 적기다).
- **mobile**: 이번 슬라이스에서 **변경하지 않는 것**을 권고. Push 실동작에는 EAS projectId 발급이 선행되어야 하고, 백엔드는 Fake sender로 계약만 맞춰두면 충분하다.

### 9.4 Phase 3가 반드시 결정해야 할 열린 항목

1. **`Reservation` vs `Order` 네이밍** — 문서에는 `Order`만 있다 (§4.3). 분리할지 통합할지.
2. **`alembic/env.py:35` 수정** — 잊으면 마이그레이션이 빈 파일로 나온다. 계획서에 명시적 단계로 넣을 것.
3. **테스트 DB 전략** — `conftest.py`가 없다. 트랜잭션 롤백 / 별도 스키마 / SQLite 중 택1.
4. **가상계좌 환불 vs 카드 승인취소** — 구조가 다르다 (`_workspace/01_req-analyst_requirements.md:55`). Fake 어댑터 인터페이스에서 구분할지.
5. **멱등성 키** — 이중 환불 방지 (`_workspace/01_req-analyst_requirements.md:95`). 어느 레이어에 둘지.
6. **`REDIS_URL` 추가** — `backend/.env`와 `.env.example` 양쪽 모두.
7. **선행 블로커: Docker 기동** — 현재 이 환경에서 `docker` CLI 사용 불가, DB·Redis 미기동 (§8.4).
