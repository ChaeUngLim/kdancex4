# kdance 저장소 구조 지도 — 파일 계층 · 연관성 · 정합성 점검

- 기준일: 2026-09-29 (커밋 `4711a85` 이후 작업 트리)
- 누가 읽나: 개발 경력 6개월차 비전공자와 이 저장소를 처음 여는 에이전트
- 어떻게 확인했나: git 이 추적하는 파일 208개(`git ls-files`, 벤더 파일 제외)를 하나씩 열어 제목·역할을 적고, 문서 안의 경로 참조 전부를 실제 파일과 대조했다. 버전은 `package.json`·`pyproject.toml`·`docker-compose.yml` 과 기술 스택 고정표를 맞춰 봤고, backend 는 `from app.… import` 줄로 파일끼리의 의존을 그렸다.

---

## 목차

1. [한눈에 — 다섯 층으로 본 저장소](#1)
2. [디렉터리 계층 — 폴더마다 무엇이 있고 어떤 성격인가](#2)
3. [문서의 연관성 — 무엇이 원본이고 누가 읽나](#3)
4. [소스의 연관성 — backend · admin-web · mobile · infra](#4)
5. [정합성 점검 결과](#5)
6. [정리 제안](#6)
7. [이 문서를 유지하는 법](#7)

---

<a id="1"></a>
## 1. 한눈에 — 다섯 층으로 본 저장소

이 저장소는 코드보다 문서와 규칙이 많다. 파일을 폴더 이름이 아니라 **역할**로 나누면 다섯 층이 된다. 위 네 층은 `core-rules.md` 의 4계층(환경·명세·파이프라인·공구)이고, 다섯째는 사람과 에이전트가 읽기만 하는 설명 층이다.

![그림 1 · 저장소를 다섯 층으로](assets/structure/s01-repo-layers.png)

*그림 1 · 저장소를 다섯 층으로 — 왼쪽에서 오른쪽으로 규칙 → 명세 → 순서 → 코드 → 설명*

| 층 | 핵심 질문 | 대표 파일 | 코드를 |
|---|---|---|---|
| 🧱 환경 | 어떤 규칙과 권한으로 일하나 | `CLAUDE.md` · `.claude/rules/core-rules.md` · `.claude/settings.json` · `CLAUDE-decisions.md` | 다루지 않는다 |
| 📐 명세 | 무엇을 왜 만드나 | `specs/…/spec.md` · `docs/kdancex4_service_definition_and_tech_stack.md` · 약관·정책 md | 보지 않는다 |
| 🏗 파이프라인 | 어떤 순서로 하나 | `.claude/skills/kdance-dev-harness/` · `.claude/agents/kdance-*.md` · `_workspace/SCH_kdance.html` | 보되 고치지 않는다 |
| 🛡 공구 | 어떻게 제대로 만드나 | `backend/` · `admin-web/` · `mobile/` · `infra/` · `scripts/` | 고친다 |
| 설명 | 끝난 것과 판단을 어떻게 남기나 | `docs/Review.md` · `docs/가이드/*.html` · `_workspace/guides/` · `graphify-out/` | 결정하지 않는다 |

---

<a id="2"></a>
## 2. 디렉터리 계층

성격 표시: **원본** = 다른 파일이 참조하는 단일 진실 원천 · **파생** = 원본에서 만들어지거나 원본을 요약 · **로컬** = git 이 추적하지 않음 · **폐기 예정** = 결정은 났지만 파일은 남아 있음 · **재생성** = 명령 한 번으로 다시 만들 수 있음

```
kdance/
├── CLAUDE.md                     환경 · 프로젝트 문맥과 빌드·검증 명령 (원본)
├── CLAUDE-decisions.md           환경 · ADR-001~005 (원본)
├── CLAUDE-troubleshooting.md     환경 · 알려진 오류와 해결 (원본)
├── README.md                     설명 · 학습 진입점
├── .gitignore                    환경 · 무엇을 추적하지 않나 (Review.md 와 그 그림은 로컬)
├── skills-lock.json              환경 · 설치된 스킬 잠금
│
├── .claude/                      환경 + 파이프라인
│   ├── rules/core-rules.md         규칙 원본 — 언어 · 4계층 · 식별자 표기 · 버전 정책 · 진행 리뷰
│   ├── settings.json               훅 2개(graphify)
│   ├── agents/kdance-*.md (8)      Phase 1~9 담당 에이전트
│   ├── agents/code-searcher.md 등  공용 에이전트 4개
│   ├── skills/kdance-dev-harness/  Phase 1~9.5 오케스트레이터 + 산출물 표준 3종
│   ├── skills/speckit-*/ (10)      spec-kit — specify 하나만 쓰고 나머지 9개는 규칙상 사용 금지
│   ├── skills/diagram-this          → .agents/skills/diagram-this 의 심볼릭 링크
│   └── skills/(그 밖에 4종)         claude-docs-consultant · task-breakdown · session-metrics · graphify …
├── .agents/skills/diagram-this/  Mermaid → HTML 뷰어 스킬 (mermaid.min.js 3.5MB 포함)
├── .specify/                     명세 · spec-kit 설정 — constitution.md 는 core-rules.md 를 가리키는 포인터
│
├── specs/001-ai-dance-class-platform/
│   ├── spec.md                     요구사항 원본 — FR·US·SC · 변경 이력 · 미해결 질문 · FR 색인 (294KB)
│   ├── checklists/requirements.md  명세 품질 체크리스트
│   └── local-ai-capacity.md        노트북 AI 수용량 실측 (S0 근거)
│
├── docs/                         명세 + 설명 (25개 파일 + 하위)
│   ├── kdancex4_service_definition_and_tech_stack.md   서비스 정의 · 「11. 기술 스택 고정표」= 버전 원본 (136KB)
│   ├── terms-of-service.md · merchant-terms.md · privacy-policy.md   약관 3종 (법률 검토 전 초안)
│   ├── archive/terms-2026-09-25/   약관 상세판 보관본 (조문별 근거)
│   ├── payment-method-policy.md · pricing-policy.md · distribution-policy.md · genre-taxonomy-policy.md · admin-input-policy.md · subscription-benefits.md   정책 원본
│   ├── plan-summary.md · requirements-analysis.md · role-split-analysis.md   기획·분석 요약 (파생)
│   ├── payment-deeplink-reference.md · sch-payment-deeplink-implementation.md   ⛔ 09-25 폐기 표시 (기록으로만)
│   ├── handoff.md + handoff/       다른 PC·계정으로 옮기는 절차와 설정 묶음
│   ├── Review.md                   진행 리뷰 — 일별 · SCH별 (로컬 · 푸시 금지)
│   ├── assets/review/              Review 의 그림 12장 .mmd + .png (로컬)
│   ├── assets/structure/           이 문서의 그림 3장 .mmd + .png
│   ├── assets/omniroute-guide/     OmniRoute 가이드의 이미지 43장
│   ├── ai-coding-agent.html        에이전트용 스택 개요 — 최신에서만 되는 것
│   ├── kdance-screens-spec.html · kdance-beta-infra.html · reservation-refund-diagrams.html · payment-system-guide-for-beginners.html · omniroute-setup.html   설명 HTML
│   ├── 가이드/*.html (5) · *.pptx (2)   왕초보 가이드 · 입점 설명회 · 개발 가이드 원본
│   └── build_pitch_pptx.py · build_screens_pptx.py   pptx 생성 스크립트 (일회성)
│
├── _workspace/                   파이프라인 산출물
│   ├── SCH_kdance.html             SCH 목록·순서·상태 원본 — 여기서만 관리
│   ├── build_sch_kdance.py         SCH_kdance.html 생성기 (데이터를 여기서 고친다)
│   ├── 01_req-analyst_requirements.md · 02_code-searcher_structure.md   SCH-21 회차 Phase 1·2 산출물
│   ├── guides/SCH-01~07(…).html    끝난 조각의 왕초보 가이드 (파생)
│   └── guides/diagrams/            가이드 그림 21장 .mmd + .png
│
├── backend/                      공구 · FastAPI 1회차 슬라이스 (SCH-21 에서 교체 예정)
│   ├── app/ (config · db · deps · main · adapters/3 · models/7+base · routers/2 · schemas/2 · services/3)
│   ├── alembic/ (env.py · versions/0001_initial_domain.py)
│   ├── tests/ (8 파일 · 186 건)
│   └── pyproject.toml · uv.lock · .env.example
├── admin-web/                    공구 · Next.js 16 업주 콘솔 (앞으로 API 도 여기로)
│   ├── app/ (layout · page · refund-policy/page ⛔ 폐기 예정)
│   ├── components/ (AdminNav · RefundPolicySettings ⛔)
│   ├── lib/api-client.ts           FastAPI 를 부르는 얇은 fetch 래퍼
│   └── AGENTS.md · CLAUDE.md       Next.js 16 이 설치한 에이전트용 문서
├── mobile/                       공구 · Expo 58 회원 앱 — App.tsx 데모 화면 하나
├── infra/                        공구 · docker-compose (DB · Redis · llama-server · ollama) · ai-bench/ 측정 스크립트
├── scripts/claude-free.sh        공구 · OmniRoute 무료 체인으로 Claude Code 실행
└── graphify-out/                 설명 · 지식 그래프 (재생성 · 로컬)
```

로컬 전용이라 저장소에 없는 것: `docs/Review.md` 와 `docs/assets/review/`, `.diagrams/`, `graphify-out/`, `.playwright-mcp/`, `_workspace/00_input/`, 각 패키지의 `node_modules/`·`.venv/`·`.env`.

---

<a id="3"></a>
## 3. 문서의 연관성 — 무엇이 원본이고 누가 읽나

같은 값을 두 곳에 적으면 반드시 한 곳이 뒤처진다. 그래서 값마다 원본을 하나만 두고 나머지는 참조한다. 화살표는 "누가 누구를 읽거나 갱신하나"다.

![그림 2 · 문서 연관도](assets/structure/s02-doc-links.png)

*그림 2 · 문서 연관도 — 노란색이 원본, 파란색이 규칙, 초록색이 파이프라인, 보라색이 설명*

| 값 | 원본 (여기서만 고친다) | 참조하는 곳 |
|---|---|---|
| 요구사항 FR·US·SC 와 공식 짧은 이름 | `specs/…/spec.md` | SCH_kdance.html · 약관 · Review · 가이드 · 정의서 |
| 버전 | 정의서 「11. 기술 스택 고정표」 | CLAUDE.md · ai-coding-agent.html · 에이전트 md (값을 복제하지 않고 표를 가리킨다) |
| 실제 설치본 | `package.json` · `pyproject.toml` · `docker-compose.yml` | 실측 뒤 고정표를 고친다 — 표가 설치본을 따라간다 |
| 규칙 | `.claude/rules/core-rules.md` | CLAUDE.md · 하네스 스킬 · 에이전트 · `.specify/memory/constitution.md`(포인터) |
| 설계 결정 | `CLAUDE-decisions.md` (ADR) | 정의서 · Review · 스케줄표 |
| SCH 번호·기능명·상태 | `_workspace/SCH_kdance.html` (← `build_sch_kdance.py`) | Review 2부 · 가이드 · 소스 학습 주석 · core-rules 의 표기 규칙 |
| 결제·환불 정책 | `docs/payment-method-policy.md` + spec | 약관 · 가이드 · 스케줄표 |
| 진행 판단과 막힌 것 | `docs/Review.md` (로컬) | — (읽기만) |

**흐름으로 보면**: `spec.md` 가 무엇을 정하고 → 하네스가 `SCH_kdance.html` 로 순서를 자르고 → 코드가 만들어지면 → Phase 9.5 가 가이드·학습 주석·Review 를 남긴다. 반대 방향(설치본 → 고정표 → 문서)은 버전에만 있다.

---

<a id="4"></a>
## 4. 소스의 연관성

### backend — 요청이 들어와 DB 에 닿기까지

![그림 3 · backend 모듈 의존도](assets/structure/s03-backend-deps.png)

*그림 3 · backend 모듈 의존도 — `from app.… import` 줄을 그대로 옮겼다. 빨간 상자는 09-25 결정으로 폐기 예정*

| 층 | 파일 | 무엇을 | 의존 |
|---|---|---|---|
| 문 | `main.py` | 앱 조립 · CORS(5173·3000) · `/health` | routers |
| 문 | `routers/reservations.py` | 취소 · 취소 미리보기 | schemas.cancellation · services.cancellation · deps · db · adapters |
| 문 | `routers/admin_academies.py` ⛔ | 환불 비율표 GET·PUT | schemas.academy · models.academy · db |
| 모양 | `schemas/cancellation.py` | 요청·응답 형태 | services.cancellation · adapters.payment_gateway |
| 모양 | `schemas/academy.py` ⛔ | 비율표 형태 | — |
| 판단 | `services/cancellation.py` | 취소 11단계 | models 6종 · adapters 3종 · services.refund_policy |
| 판단 | `services/refund_policy.py` ⛔ | 환불액 순수 함수 | — |
| 판단 | `services/fee_policy.py` | 정산 상수 4개 (읽는 코드 없음) | — |
| 경계 | `deps.py` | 임시 인증(`X-User-Id`) · 어댑터 주입 | adapters 3종 |
| 경계 | `adapters/*.py` | PG · 알림 · 슬롯락 Protocol + Fake | — |
| 데이터 | `db.py` ← `config.py` ← `.env` | 엔진 · 세션 · `get_db` | — |
| 데이터 | `models/*.py` ← `base.py` | 테이블 7종 | — |
| 데이터 | `alembic/env.py` → `versions/0001_initial_domain.py` | 마이그레이션 (17문) | models |

테스트 8파일은 어느 층을 검증하나: `test_refund_policy`(50) → 판단 · `test_adapters`(33) → 경계 · `test_cancellation_service`(36) → 판단+경계 · `test_schemas`(39) → 문+모양 · `conftest` + `test_cancel_api`(9) + `test_admin_refund_policy`(17) → 전 층을 실제 DB 로(`requires_db` 27건) · `test_health`(1).

### admin-web · mobile · infra

| 파일 | 무엇을 | 부르는 곳 |
|---|---|---|
| `admin-web/app/layout.tsx` → `components/AdminNav.tsx` | 공통 틀 | — |
| `admin-web/app/page.tsx` → `lib/api-client.ts` | 대시보드 · `/health` 확인 | `http://localhost:8000` (FastAPI) |
| `admin-web/app/refund-policy/page.tsx` → `components/RefundPolicySettings.tsx` ⛔ | 비율표 설정 | `/admin/academies/{id}/refund-policy` |
| `mobile/index.ts` → `App.tsx` | 데모 화면 — 취소 미리보기 · 취소 | `/reservations/{id}/cancellation-preview` · `/cancel` |
| `infra/docker-compose.yml` | `kdance-db`(pgvector 0.8.6-pg18) · `kdance-redis`(redis:alpine) · `kdance-llm`(llama-server 10슬롯) · `ollama`(멈춤) | backend `.env` 의 5433·6380, AI 11436 |
| `infra/ai-bench/*.py` | 동시 N명 첫 글자·완료 시간 측정 | `kdance-llm` |

admin-web 에 설치된 prisma 8 · better-auth · ai · langgraph · MCP SDK 는 **아직 어느 소스도 import 하지 않는다** — SCH-21·22 가 처음 쓴다.

---

<a id="5"></a>
## 5. 정합성 점검 결과

문서 안의 경로 참조 전부, 세 manifest 와 고정표의 버전, backend import 를 대조한 결과다. **고쳤음**은 이번에 바로잡은 것, **결정 필요**는 판단이 걸려 그대로 둔 것이다.

### 5-1. 고쳤음 (2026-09-29)

| # | 어디 | 무엇이 어긋났나 | 어떻게 |
|---|---|---|---|
| 1 | `README.md` 9행 | 학습 진입점 1번 링크가 `docs/harness-ecc-guide.html` 을 가리켰는데 실제 파일은 `docs/가이드/` 아래 | 경로 수정 |
| 2 | `README.md` 3행 | 스택을 "FastAPI + SQLAlchemy2(backend)" 라고만 적어 09-20 교체 결정이 안 보였다 | SCH-21 교체 예정 표기, 이 문서 링크 추가 |
| 3 | `CLAUDE.md` 10행 | "Expo SDK 57" — 실제는 `mobile/package.json` 의 `expo 58.0.0-preview.6`(09-25 올림) | 58 로 고치고 값의 원본이 고정표임을 표기 |
| 4 | `.gitignore` 28행 주석 | 추적 목록에 `kdance.html` — 09-29 에 `SCH_kdance.html` 로 바뀜 | 주석 수정 |
| 5 | `docs/plan-summary.md` 5행 | `docs/social-dance-*.html` 두 파일이 `docs/가이드/` 로 옮겨져 있었고, `docs/superpowers/specs/…` 는 저장소에 없다 | 경로 수정, 없는 파일은 그렇다고 표기 |
| 6 | 가이드 7개(14곳) | 작성 기준으로 적힌 `_workspace/05_implementer_TS-0N_summary.md` 가 09-20 회차 전환 때 지워짐(커밋 `7f28ab1^` 에만 있음) | 커밋 위치 병기 |
| 7 | 참조 24개 파일 | 옛 이름 `_workspace/kdance.html` | 09-29 이름 변경 때 일괄 수정(커밋 `4711a85`) |

### 5-2. 결정 필요 — 그대로 두었다

| # | 어디 | 무엇 | 왜 그대로 두었나 · 제안 |
|---|---|---|---|
| A | `infra/docker-compose.yml` 32행 | `redis:alpine` 은 내용이 바뀌는 부동 태그. 09-20 에 pgvector 는 `0.8.6-pg18` 로 고정하면서 redis 는 두었다 | 인프라 변경은 컨테이너 재생성이 따라와서 사용자 확인 뒤. `redis:8.2-alpine` 처럼 고정 권장 |
| B | backend `routers/admin_academies.py` · `schemas/academy.py` · `services/refund_policy.py` · `tests/test_admin_refund_policy.py` · `tests/test_refund_policy.py`, admin-web `app/refund-policy/` · `components/RefundPolicySettings.tsx` | 09-25 결정(Q11 ②)으로 폐기가 확정된 코드가 남아 있고 테스트 67건이 계속 돈다 | SCH-21(FastAPI→Next.js 전환)이 "옮기지 않는다" 로 처리하기로 이미 정해져 있다. 그 전에 지우면 SCH-01~07 가이드·학습 주석과 어긋난다 |
| C | `docs/handoff.md` 184행 | "`_workspace/mobydick-v2-schedule.html` 과 `.gitignore` 34행을 지운다" 는 할 일이 남아 있는데, 파일은 이미 없고 `.gitignore` 줄만 남았다 | `.gitignore` 34행 삭제 + handoff 표에서 완료 표시 |
| D | `docs/archive/terms-2026-09-25.zip` | 미추적 파일. 같은 내용이 `docs/archive/terms-2026-09-25/` 에 추적되고 있다 | 중복이므로 삭제 권장. 09-29 세 차례 확인 요청 |
| E | `.claude/skills/speckit-*` 9개 | 규칙(core-rules 「spec-kit 과의 역할 분리」)상 쓰지 않는데 설치는 되어 있다 | 실수로 `/speckit-plan` 을 돌릴 위험. 지우거나 SKILL.md 머리에 "사용 금지" 한 줄 |
| F | `docs/build_pitch_pptx.py` · `build_screens_pptx.py` | 문서 폴더에 실행 스크립트 | `scripts/` 로 옮기면 폴더 성격이 맞는다 |
| G | `docs/` 25개 파일이 한 층 | 정책·약관·기획·설명·스크립트가 섞여 있다 | 6절 제안 참고 |
| H | `mobile/App.tsx` | FastAPI 의 옛 취소 흐름(회원이 누르면 곧바로 환불)을 부른다 | SCH-09 기록대로 데모. 새 흐름은 SCH-32·33 에서 다시 만든다 |
| I | `.specify/extensions.yml` | speckit 스킬 10개가 참조하지만 파일이 없다 | spec-kit 기본 동작(없으면 건너뜀). E 와 함께 정리 |

### 5-3. 맞는 것으로 확인함

- 버전: `next 16.3.5` · `react 19.3.0` · `expo 58.0.0-preview.6` · `react-native 0.88.0-rc.1` · `typescript 6.0.3` · `prisma 8.0.0-rc.15` / `@prisma/orm-postgres 8.0.0-rc.11` · `better-auth 1.7.5` · `ai 7.0.113` · `@modelcontextprotocol/sdk 1.30.1` · `zod 4.6.5` · `temporal-polyfill 1.0.5` · `fastapi ≥0.141.1` · Python 3.12 · `pgvector/pgvector:0.8.6-pg18` — 세 manifest 와 고정표가 전부 같다.
- `SCH_kdance.html` · `Review.md` 2부 · 가이드의 SCH 번호·기능명 — 한 데이터(`build_sch_kdance.py`)에서 나와 같다.
- backend import 에 순환이 없다. `schemas` 가 `services` 를 읽는 한 방향뿐이고, `models` 는 `base` 만 읽는다.
- 에이전트 md 가 가리키는 `_workspace/03_*`·`04_*`·`06_*`~`09_*` 는 파이프라인이 도는 동안 생기는 산출물이라 지금 없는 것이 정상이다.
- `.claude/skills/diagram-this` 는 `.agents/skills/diagram-this` 의 심볼릭 링크 — 한 벌이다.

---

<a id="6"></a>
## 6. 정리 제안

지금 구조에서 읽는 사람이 헤매는 곳은 `docs/` 하나다. 25개 파일이 성격 구분 없이 한 층에 있다. 폴더를 나누면 링크를 고쳐야 하므로(README · CLAUDE.md · 스케줄표 · 가이드 등 30곳 남짓) 한 번에 하는 것이 낫다.

```
docs/
├── policy/      정책 6종 (payment-method · pricing · distribution · genre-taxonomy · admin-input · subscription-benefits)
├── legal/       약관 3종 + archive/
├── planning/    plan-summary · requirements-analysis · role-split-analysis · service-definition(기술 스택 문서)
├── guide/       왕초보 가이드 HTML 전부 (지금의 docs/가이드 + docs/*.html)
├── agent/       ai-coding-agent.html · handoff/
├── deprecated/  payment-deeplink-reference · sch-payment-deeplink-implementation
└── Review.md · assets/
```

그 밖에: `build_*_pptx.py` 는 `scripts/` 로, 안 쓰는 speckit 스킬 9개는 삭제, redis 태그 고정. 셋 다 5-2 표에 있다.

---

<a id="7"></a>
## 7. 이 문서를 유지하는 법

1. 파일을 옮기거나 이름을 바꾸면 2절 트리와 3절 표를 같이 고친다. 참조 검사는 문서 안의 `폴더/…확장자` 꼴 문자열을 뽑아 `os.path.exists` 로 확인하는 것이 전부다(오탐: 정규식이 `.tsx` 를 `.ts` 로 자르는 경우가 있으니 결과를 눈으로 본다).
2. 버전을 올리면 고정표 → 이 문서 5-3 순서로 확인한다.
3. 그림 3장의 원본은 `docs/assets/structure/*.mmd` 다. `mmdc -i s0N-*.mmd -o s0N-*.png -b white -s 2 --size 1100` 으로 다시 굽는다(Chrome 과 한국어 글꼴 필요 — Review.md 「이어 쓰는 법」 9번과 같다).
4. 5-2 의 항목이 처리되면 5-1 로 옮기고 날짜를 적는다.
