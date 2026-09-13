# kdance 프로젝트 뼈대(스캐폴딩) 설계

- 날짜: 2026-09-13
- 범위: 인프라 확인 + 백엔드/관리자웹/모바일 앱의 **뼈대만** 셋업. 실제 기능
  (인증·예약·결제 등)은 이 스펙 범위 밖 — 이후 별도 phase에서 plan을 잡아 구현한다.
- 근거 문서: `docs/social-dance-app-dev-guide.html`(스택·로드맵 확정본),
  `docs/kdance-beta-infra.html`(베타 규모 인프라 참고), `docs/genre-taxonomy-policy.md`

## 로컬 환경 확인 결과 (2026-09-13 실측)

| 도구 | 버전 | 비고 |
| --- | --- | --- |
| Docker | 29.6.2 | Docker Compose v5.3.1 포함 |
| Node.js | v24.20.0 | 개발 가이드 기준(24)과 일치 |
| Python (system) | 3.14.4 | 개발 가이드 기준은 3.12 — `uv`로 격리 설치해 맞춘다 |
| uv | 0.12.10 | 설치돼 있음 |
| JDK | 미설치 | Android 빌드 단계(로드맵 5단계)에서만 필요 — 지금 단계는 막지 않음 |
| git | 2.53.0 | 설치는 돼 있으나 이 저장소는 아직 미초기화, 이번 스코프에서 git init 안 함 |

기존 Docker 컨테이너 중 `mobydick-db`(`pgvector/pgvector:pg18`)가 호스트 포트
**5432**를 이미 점유하고 있다. kdance는 완전히 별도의 컨테이너·포트를 쓴다.

## 레포 구조

```
kdance/
├─ backend/           # FastAPI + SQLAlchemy2 + Alembic (uv 관리)
├─ admin-web/         # React + Vite + TS — 학원 관리자 콘솔
├─ mobile/            # Expo SDK 57 + React Native + TS — 소비자 앱
├─ infra/
│  └─ docker-compose.yml
└─ docs/              # 기존 문서 유지
```

## 인프라 (`infra/docker-compose.yml`)

| 서비스 | 이미지 | 호스트 포트 | 컨테이너명 | 비고 |
| --- | --- | --- | --- | --- |
| db | `pgvector/pgvector:pg18` | 5433 → 5432 | `kdance-db` | DB명 `kdance`, 계정 `kdance`/`kdance`(로컬 전용 기본값) |
| redis | `redis:alpine` | 6380 → 6379 | `kdance-redis` | 지금은 미사용, 이후 스케줄러 잡큐·쿠폰 중복방지 락에 사용 예정이라 미리 같이 띄움 |

MinIO(오브젝트 스토리지)는 포함하지 않는다 — 포스터 업로드 기능(화면 10) 구현
시점에 별도로 추가한다.

## `backend/`

- `uv init` 후 `uv python pin 3.12`
- 의존성: `fastapi`, `sqlalchemy>=2`, `alembic`, `psycopg[binary]`,
  `python-dotenv`, dev 의존성으로 `pytest`
- `app/main.py` — `GET /health` 하나만 반환하는 최소 FastAPI 앱
- `alembic/` 초기화(마이그레이션 스켈레톤, 모델·리비전 없음)
- `.env.example`:
  ```
  DATABASE_URL=postgresql+psycopg://kdance:kdance@localhost:5433/kdance
  ```
- `tests/test_health.py` — `/health` 200 응답 확인 pytest 1개

## `admin-web/`

- `npm create vite@latest admin-web -- --template react-ts`
- 기본 페이지에서 백엔드 `/health`를 fetch 해 상태 문자열만 표시(연결 확인용 placeholder)

## `mobile/`

- `npx create-expo-app mobile --template expo-template-blank-typescript` (Expo SDK 57)
- 홈 화면에서 백엔드 `/health` fetch 결과를 텍스트로만 표시(연결 확인용 placeholder)

## `CLAUDE.md` 갱신

- `Stack: not yet chosen` → 확정된 스택 요약으로 교체
- `Backend DB: PostgreSQL, local dev container mobydick-db (db name mobydick)`
  → `PostgreSQL 18+pgvector, local dev container kdance-db (port 5433, db name kdance)`
- `Architecture` 섹션에 `backend/`·`admin-web/`·`mobile/`·`infra/` 추가

## 에러 처리 / 검증

- 뼈대 단계라 별도 에러 처리 로직은 없음 — `/health` 엔드포인트가 200을 반환하는지만 확인.
- 검증 방법:
  1. `docker compose -f infra/docker-compose.yml up -d` 후 `docker ps`로 `kdance-db`·`kdance-redis` 헬시 확인
  2. `cd backend && uv run pytest` 통과
  3. `cd backend && uv run fastapi dev app/main.py` 로 띄운 뒤 `curl localhost:8000/health` 200 확인
  4. `cd admin-web && npm run dev` 로 뜬 페이지가 백엔드 health 상태를 표시하는지 브라우저로 확인
  5. `cd mobile && npx expo start` 로 Expo Go에서 홈 화면이 백엔드 health 상태를 표시하는지 확인

## 스코프에서 제외

- 인증·예약·결제·정산 등 실제 기능 코드
- CI/CD, git 초기화, Fastlane
- MinIO, PG(결제대행) 연동
- 장르 enum 등 도메인 모델(별도 정책 문서 `docs/genre-taxonomy-policy.md`로 결정만
  기록, 모델 구현은 로드맵 2단계에서)
