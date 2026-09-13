# kdance 뼈대(스캐폴딩) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** kdance 프로젝트의 로컬 인프라(DB/Redis)와 backend/admin-web/mobile 세 서브프로젝트의 최소 뼈대를 세워, 각각 헬스체크 하나로 서로 연결됨을 확인할 수 있는 상태로 만든다.

**Architecture:** 모노레포(`backend/`, `admin-web/`, `mobile/`, `infra/`) 안에 독립 실행 가능한 서브프로젝트 3개를 만든다. 백엔드는 `GET /health`를 노출하고, admin-web과 mobile은 각각 그 엔드포인트를 호출해 상태를 화면에 표시하는 것으로 "연결됨"을 검증한다. 실제 도메인 로직(인증·예약·결제 등)은 포함하지 않는다.

**Tech Stack:** FastAPI + SQLAlchemy 2 + Alembic + psycopg3 (uv 관리, Python 3.12) · PostgreSQL 18 + pgvector · Redis · React + Vite + TypeScript · Expo SDK 57 + React Native + TypeScript

**Spec:** `docs/superpowers/specs/2026-09-13-kdance-scaffold-design.md`

## Global Constraints

- Python은 `uv`로 3.12를 격리 설치해서 쓴다 (시스템 python은 3.14.4, 사용하지 않음).
- kdance 전용 Postgres는 호스트 포트 **5433**, Redis는 호스트 포트 **6380**을 쓴다 — 5432는 `mobydick-db`가 이미 점유 중이라 절대 5432를 쓰지 않는다.
- DB 접속 문자열은 `postgresql+psycopg://kdance:kdance@localhost:5433/kdance`로 고정한다.
- 이 저장소는 서브에이전트 기반 실행을 위해 최초 `git init` + 현재 상태(docs/, CLAUDE.md, .claude/) 초기 커밋을 controller가 먼저 만든 뒤 태스크를 시작한다. 각 태스크는 "파일 작성 → 검증 명령 실행 → 통과 확인 → `git commit`"으로 마무리한다.
- 이번 스코프는 뼈대만이다 — 인증·예약·결제·정산 등 실제 기능 코드는 어떤 태스크에도 포함하지 않는다.
- 백엔드 로컬 개발 서버는 포트 **8000**을 쓴다 (`fastapi dev` 기본값).

---

### Task 1: 인프라 — `infra/docker-compose.yml`

**Files:**
- Create: `infra/docker-compose.yml`

**Interfaces:**
- Produces: `localhost:5433`에서 접속 가능한 PostgreSQL(DB `kdance`, 계정 `kdance`/`kdance`), `localhost:6380`에서 접속 가능한 Redis. 이후 모든 태스크가 이 접속 정보를 그대로 쓴다.

- [ ] **Step 1: `infra/docker-compose.yml` 작성**

```yaml
services:
  db:
    image: pgvector/pgvector:pg18
    container_name: kdance-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: kdance
      POSTGRES_PASSWORD: kdance
      POSTGRES_DB: kdance
    ports:
      - "5433:5432"
    volumes:
      - kdance-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U kdance -d kdance"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:alpine
    container_name: kdance-redis
    restart: unless-stopped
    ports:
      - "6380:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  kdance-db-data:
```

- [ ] **Step 2: 컨테이너 기동**

Run: `docker compose -f infra/docker-compose.yml up -d`

- [ ] **Step 3: 헬시 상태 확인**

Run: `docker ps --filter "name=kdance-" --format "table {{.Names}}\t{{.Status}}"`
Expected: `kdance-db`, `kdance-redis` 둘 다 `Up ... (healthy)`

- [ ] **Step 4: DB 접속 확인**

Run: `docker exec kdance-db psql -U kdance -d kdance -c "select 1;"`
Expected: `1` 한 행 출력, 에러 없음

- [ ] **Step 5: 커밋**

```bash
cd /home/user/kdance
git add infra/docker-compose.yml
git commit -m "feat(infra): add kdance-db and kdance-redis via docker-compose"
```

---

### Task 2: `backend/` 프로젝트 스캐폴드

**Files:**
- Create: `backend/pyproject.toml` (uv가 생성)
- Create: `backend/.python-version` (uv가 생성, 내용 `3.12`)
- Create: `backend/.env.example`
- Create: `backend/app/__init__.py`
- Create: `backend/tests/__init__.py`

**Interfaces:**
- Consumes: 없음 (Task 1과 독립 — DB가 안 떠 있어도 스캐폴드 자체는 가능)
- Produces: `uv run <cmd>`로 실행 가능한 backend 프로젝트, `app` 패키지, `tests` 패키지. Task 3이 이 위에 `app/main.py`를 만든다.

- [ ] **Step 1: uv 프로젝트 초기화 (애플리케이션 모드, 패키징 불필요)**

Run:
```bash
cd /home/user/kdance
uv init backend --python 3.12
```

- [ ] **Step 2: 기본 생성물 정리**

`uv init`이 기본으로 만드는 `backend/main.py`는 쓰지 않는다 — 이 프로젝트는 `app/` 패키지 레이아웃을 쓴다.

Run:
```bash
cd backend
rm main.py
mkdir -p app tests
touch app/__init__.py tests/__init__.py
```

- [ ] **Step 3: 의존성 추가**

Run:
```bash
cd backend
uv add fastapi "sqlalchemy>=2" alembic "psycopg[binary]" python-dotenv
uv add --dev pytest httpx
```

`httpx`는 FastAPI `TestClient`가 내부적으로 요구하는 의존성이라 dev 그룹에 같이 넣는다.

- [ ] **Step 4: `.env.example` 작성**

```bash
DATABASE_URL=postgresql+psycopg://kdance:kdance@localhost:5433/kdance
```

- [ ] **Step 5: 설치 검증**

Run: `cd backend && uv run python -c "import fastapi, sqlalchemy, alembic, psycopg; print('ok')"`
Expected: `ok` 출력, 에러 없음

- [ ] **Step 6: 커밋**

```bash
cd /home/user/kdance
git add backend/pyproject.toml backend/uv.lock backend/.python-version backend/app backend/tests backend/.env.example backend/README.md
git commit -m "feat(backend): scaffold FastAPI project with uv"
```

---

### Task 3: 백엔드 `/health` 엔드포인트 (TDD)

**Files:**
- Create: `backend/app/main.py`
- Create: `backend/tests/test_health.py`

**Interfaces:**
- Consumes: Task 2의 `app` 패키지, `pytest`/`httpx` 의존성
- Produces: `app.main:app` (FastAPI 인스턴스), `GET /health` → `{"status": "ok"}` (200). Task 5·6이 이 응답 형태를 그대로 fetch해서 화면에 표시한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_health.py`:
```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && uv run pytest tests/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`

- [ ] **Step 3: 최소 구현 작성**

`backend/app/main.py`:
```python
from fastapi import FastAPI

app = FastAPI(title="kdance")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && uv run pytest tests/test_health.py -v`
Expected: PASS

- [ ] **Step 5: 실제 서버로 수동 확인**

Run (백그라운드 또는 별도 터미널): `cd backend && uv run fastapi dev app/main.py`
그 다음: `curl -s localhost:8000/health`
Expected: `{"status":"ok"}`

- [ ] **Step 6: 커밋**

```bash
cd /home/user/kdance
git add backend/app/main.py backend/tests/test_health.py
git commit -m "feat(backend): add GET /health endpoint"
```

---

### Task 4: 백엔드 Alembic 스캐폴드

**Files:**
- Create: `backend/alembic.ini` (alembic이 생성)
- Create: `backend/alembic/env.py` (alembic이 생성 후 수정)
- Create: `backend/alembic/versions/` (빈 디렉터리, alembic이 생성)

**Interfaces:**
- Consumes: Task 2의 `.env.example` 포맷(`DATABASE_URL`), `python-dotenv` 의존성
- Produces: `uv run alembic revision`/`upgrade` 실행 가능한 마이그레이션 스켈레톤 (리비전 없음, 모델 없음 — 실제 모델은 이번 스코프 밖)

- [ ] **Step 1: alembic 초기화**

Run: `cd backend && uv run alembic init alembic`

- [ ] **Step 2: `alembic/env.py`가 `DATABASE_URL` 환경변수를 읽도록 수정**

`backend/alembic/env.py` 최상단 import 구역 바로 아래, `config = context.config` 라인 앞에 추가:

```python
import os

from dotenv import load_dotenv

load_dotenv()
```

그리고 기존에 있는 `config = context.config` 라인 바로 다음 줄에 추가:

```python
config.set_main_option(
    "sqlalchemy.url",
    os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://kdance:kdance@localhost:5433/kdance",
    ),
)
```

- [ ] **Step 3: `backend/.env` 생성 (로컬 전용, `.env.example` 복사)**

Run: `cd backend && cp .env.example .env`

- [ ] **Step 4: alembic이 DB에 연결되는지 확인**

Run: `cd backend && uv run alembic current`
Expected: 에러 없이 실행됨(리비전이 없으니 출력은 비어 있어도 됨) — Task 1의 `kdance-db` 컨테이너가 떠 있어야 한다.

- [ ] **Step 5: 빈 `versions/` 디렉터리가 git에 남도록 `.gitkeep` 추가 후 커밋**

```bash
cd /home/user/kdance
touch backend/alembic/versions/.gitkeep
git add backend/alembic.ini backend/alembic
git commit -m "chore(backend): scaffold Alembic migrations"
```

`backend/.env`는 로컬 전용 시크릿이라 커밋하지 않는다 (아래 `.gitignore`로 이미 제외됨).

---

### Task 5: `admin-web/` 스캐폴드 + 헬스체크 페이지

**Files:**
- Create: `admin-web/` 전체 (Vite가 생성)
- Modify: `admin-web/src/App.tsx`

**Interfaces:**
- Consumes: Task 3의 `GET http://localhost:8000/health` → `{"status": "ok"}`
- Produces: `npm run dev`로 뜨는 페이지에 백엔드 상태 문자열 표시

- [ ] **Step 1: Vite 프로젝트 생성**

Run:
```bash
cd /home/user/kdance
npm create vite@latest admin-web -- --template react-ts
cd admin-web
npm install
```

- [ ] **Step 2: `src/App.tsx`를 헬스체크 표시 화면으로 교체**

`admin-web/src/App.tsx` 전체를 아래로 교체:

```tsx
import { useEffect, useState } from "react";

function App() {
  const [status, setStatus] = useState<string>("확인 중...");

  useEffect(() => {
    fetch("http://localhost:8000/health")
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

- [ ] **Step 3: 빌드 검증**

Run: `cd admin-web && npm run build`
Expected: 에러 없이 `dist/` 생성

- [ ] **Step 4: 수동 확인 (Task 3의 백엔드가 떠 있어야 함)**

Run: `cd admin-web && npm run dev`
브라우저에서 표시된 주소(기본 `http://localhost:5173`) 접속 후 "백엔드 상태: ok" 표시되는지 확인

- [ ] **Step 5: 커밋**

```bash
cd /home/user/kdance
git add admin-web
git commit -m "feat(admin-web): scaffold Vite React app with backend health check"
```

---

### Task 6: `mobile/` 스캐폴드 (Expo SDK 57) + 헬스체크 화면

**Files:**
- Create: `mobile/` 전체 (create-expo-app이 생성)
- Modify: `mobile/App.tsx`

**Interfaces:**
- Consumes: Task 3의 `GET http://localhost:8000/health` → `{"status": "ok"}`
- Produces: Expo Go에서 여는 화면에 백엔드 상태 문자열 표시

- [ ] **Step 1: Expo 프로젝트 생성**

Run:
```bash
cd /home/user/kdance
npx create-expo-app@latest mobile --template blank-typescript
```

- [ ] **Step 2: Expo SDK 57로 고정**

Run:
```bash
cd mobile
npx expo install expo@^57.0.0
npx expo install --fix
```

- [ ] **Step 3: `package.json`의 expo 버전 확인**

Run: `cd mobile && cat package.json | grep '"expo"'`
Expected: `"expo": "^57.x.x"` (57대 버전)

- [ ] **Step 4: `App.tsx`를 헬스체크 표시 화면으로 교체**

`mobile/App.tsx` 전체를 아래로 교체:

```tsx
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

export default function App() {
  const [status, setStatus] = useState<string>("확인 중...");

  useEffect(() => {
    fetch("http://localhost:8000/health")
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus("백엔드 연결 실패"));
  }, []);

  return (
    <View style={styles.container}>
      <Text>kdance 앱</Text>
      <Text>백엔드 상태: {status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
```

- [ ] **Step 5: 타입체크 검증**

Run: `cd mobile && npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 6: 수동 확인 (실기기/에뮬레이터, 참고용)**

Run: `cd mobile && npx expo start`
Expo Go 앱으로 QR 스캔 후 화면에 "백엔드 상태: ok" 표시되는지 확인. 실기기에서 `localhost`는 개발 머신을 가리키지 않을 수 있으므로, 실기기 테스트 시에는 `App.tsx`의 URL을 일시적으로 개발 머신의 LAN IP로 바꿔 확인한다 (뼈대 검증용 참고 절차이며 코드에 반영하지 않음).

- [ ] **Step 7: 커밋**

```bash
cd /home/user/kdance
git add mobile
git commit -m "feat(mobile): scaffold Expo SDK 57 app with backend health check"
```

---

### Task 7: `CLAUDE.md` 갱신

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1~6에서 만들어진 실제 디렉터리 구조 및 접속 정보
- Produces: 없음 (문서 갱신)

- [ ] **Step 1: `Stack` 라인 교체**

`CLAUDE.md`에서:
```
- Stack: not yet chosen — project is in planning; no application source code exists yet
```
를 아래로 교체:
```
- Stack: FastAPI + SQLAlchemy2 + Alembic + psycopg3 (backend, uv/Python 3.12) · React + Vite + TS (admin-web) · Expo SDK 57 + React Native + TS (mobile)
```

- [ ] **Step 2: `Backend DB` 라인 교체**

`CLAUDE.md`에서:
```
- Backend DB: PostgreSQL, local dev container `mobydick-db` (db name `mobydick`)
```
를 아래로 교체:
```
- Backend DB: PostgreSQL 18 + pgvector, local dev container `kdance-db` (port 5433, db name `kdance`) — separate from the unrelated `mobydick-db` container on this machine
```

- [ ] **Step 3: `Architecture` 섹션에 서브프로젝트 추가**

`CLAUDE.md`에서:
```
- `docs/` — planning notes and setup guides (pricing/distribution policy, OmniRoute setup guide)
- No `src/` yet
```
를 아래로 교체:
```
- `docs/` — planning notes and setup guides (pricing/distribution/genre-taxonomy policy, OmniRoute setup guide)
- `backend/` — FastAPI API server (uv-managed)
- `admin-web/` — React + Vite admin console for studio owners
- `mobile/` — Expo consumer app
- `infra/` — `docker-compose.yml` for local Postgres+pgvector and Redis
```

- [ ] **Step 4: 검증**

Run: `grep -n "mobydick-db\|not yet chosen\|No \`src/\` yet" /home/user/kdance/CLAUDE.md`
Expected: 아무 것도 출력되지 않음 (전부 교체됨)

- [ ] **Step 5: 커밋**

```bash
cd /home/user/kdance
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with confirmed stack and kdance-db"
```
