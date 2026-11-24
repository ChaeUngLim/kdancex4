# CLAUDE.md

<!-- Project-specific context only. Behavioral rules: .claude/rules/core-rules.md -->
<!-- Run /init to auto-populate (or CLAUDE_CODE_NEW_INIT=1 for interactive mode) -->
<!-- Keep under 200 lines. If removing a line wouldn't cause mistakes, cut it -->

## Project Overview

- Name: kdance (Android package `com.kdancex3`, product name K-DanceX3). **2026-09-14: "k-dancex4" confirmed as app working title / domain name** (`docs/policy/distribution-policy.md` — relationship to existing K-DanceX3 product name not yet clarified, both recorded)
- Stack: FastAPI + SQLAlchemy2 + Alembic + psycopg3 (backend, uv/Python 3.12) · **Next.js (App Router) + TS (admin-web, confirmed 2026-09-14 — replaces earlier Vite scaffold)** · Expo SDK 58 (58.0.23) + React Native 0.88.1 + TS (mobile — 2026-11-06 정식판으로 올림, 값의 원본은 기술 스택 문서 「11. 기술 스택 고정표」) · **AI 에이전트 서버만 Python(FastAPI + LangGraph) 별도 프로세스 — 웹·제품 API·모바일은 TypeScript. DB 쓰기는 Next.js 하나, 에이전트는 도구(MCP)로만 읽고 모델은 에이전트 서버만 부른다(2026-09-24, `CLAUDE-decisions.md` ADR-004 — ADR-003 의 언어만 대체)**
- Description: dance studio booking/membership app (Android). See `docs/policy/pricing-policy.md` and `docs/policy/distribution-policy.md` for business decisions made so far.
- Backend DB: PostgreSQL 18 + pgvector, local dev container `kdance-db` (port 5433, db name `kdance`). Redis is `kdance-redis` (port 6380). Both are defined in `infra/docker-compose.yml`

## Build, Test & Verify

완료 판정 전에 바뀐 영역의 명령을 돌린다. 기대 결과는 2026-09-23 실측값이다(DB 기동 상태 기준).

| 영역 | 명령 (각 디렉터리에서) | 기대 결과 |
|---|---|---|
| backend 테스트 | `uv run pytest -q` | 186 passed (DB 미기동 시 159 passed, 27 skipped) |
| backend DB 테스트만 | `uv run pytest -m requires_db -q` | 27 passed. DB 가 없으면 27개 전부 skip(에러가 나면 실패다). 테스트 DB 는 `kdance_test` — 스키마는 conftest 가 `create_all` 로 만든다 |
| admin-web | `npm run build` | 성공. 타입 검사도 여기서 한다 |
| admin-web 테스트 | `npm test` (단위만 `npm run test:unit`, DB만 `npm run test:db`) | 192 passed(단위 184 + DB 8). DB 가 꺼져 있으면 184 passed, 8 skipped — 완료 판정 전에는 DB 를 띄운다. DB 테스트는 `flock /tmp/kdance-next-test.lock npm run test:db -- <파일>` 로 한 번에 하나만 (2026-11-19 실측) |
| mobile | `npx tsc --noEmit` | 출력 없음 (exit 0) |
| AI 생성 서버 | `curl localhost:11436/health` · `python3 infra/ai-bench/bench_pipeline.py http://localhost:11436 10` (루트) | `{"status":"ok"}` · 예열 뒤 동시 10명 첫 글자 p95 약 9초, 완료 p95 약 15~17초. 기동 직후 첫 측정은 느리다 |
| DB·Redis·AI 기동 | `docker compose -f infra/docker-compose.yml up -d` (루트) | `kdance-db`·`kdance-redis` healthy. **Windows 의 Docker Desktop 이 켜져 있어야 한다** — 꺼져 있으면 WSL 의 `docker` 가 "could not be found in this WSL 2 distro" 를 낸다(WSL 연동 설정은 이미 켜져 있다). 새 컨테이너면 `docker exec kdance-db psql -U kdance -d kdance -c "CREATE DATABASE kdance_test OWNER kdance"` 를 한 번 실행한다 |

- backend 서버: `uv run uvicorn app.main:app --reload` (포트 8000). 환경 변수는 `backend/.env` (예시: `.env.example`)
- admin-web 환경 변수는 `.env.local` (예시: `admin-web/.env.example`)
- **쓰지 않는 명령**: admin-web `npm run lint` 는 고장 상태다 — 원인이 두 겹이었다. ① `typescript-eslint` 가 TypeScript 7 을 지원하지 않았다 → 2026-09-23 TS 를 6.0.3 으로 내려 해결. ② `eslint.config.mjs` 가 `FlatCompat` 으로 `next/core-web-vitals` 를 감싸는 옛 방식이라 순환 참조(`Converting circular structure to JSON`)가 난다 → 미해결. 검증은 `npm run build` 로 한다
- **AI 서버는 `kdance-llm`(llama-server, 포트 11436)이다. `ollama` 컨테이너는 멈춰 두고 자동 재시작을 껐다** — 둘이 동시에 모델을 올리면 GPU 8GB 를 다퉈 둘 다 느려진다. 모델을 새로 받을 때만 `docker start ollama` → `ollama pull` → `docker stop ollama`. blob 해시가 바뀌면 compose 의 `--model` 경로도 고친다. **포스터 읽기(비전)용 `~/models/qwen3.5-9b/mmproj-F16.gguf` 가 없으면 `kdance-llm` 이 뜨지 않는다** — 받는 법은 기술 스택 문서 11-2 「Qwen 비전 서빙」 행(2026-09-24). **임베딩·리랭커는 개발·베타 모두 NVIDIA 호스팅을 쓴다**(체험 약관 위험 인지, 운영에서 vLLM 으로 이전) — 키는 저장소 밖 `~/.config/kdance/nvidia.env`. 로컬 GPU 에는 채팅·비전만 둔다(11-2 「임베딩·리랭커 배치」) 근거: `specs/001-ai-dance-class-platform/local-ai-capacity.md`
- DB 를 안 띄우면 `requires_db` 마커가 붙은 27개가 skip 된다. 그 상태로는 DB 로직이 검증되지 않은 것이니 완료 판정 전에는 DB 를 띄워 186 passed 를 확인한다

## Code Style

2026-11-13 전역 규칙(`~/.claude/CLAUDE.md`)과 같은 규칙을 이 프로젝트에도 적용한다(사용자 지시).

- **React 의 `useEffect` 처럼 추상화 수준이 높은 코드는 쓰지 않는다**(admin-web·mobile 공통). 언제 실행되는지가 코드에 바로 드러나지 않아 읽기 어렵기 때문이다. 대신 이벤트 핸들러 안에서 직접 처리하거나, 렌더링 중에 값을 바로 계산하거나, Next.js 서버 컴포넌트에서 미리 데이터를 받아 오는 방식처럼 흐름이 눈에 보이는 방법을 쓴다.
- **핵심 코드에는 한국어로 쉬운 주석을 단다.** 무엇을 하는지, 왜 이렇게 했는지를 처음 보는 사람도 알아듣게 쓴다. 핵심 함수·분기·계산 같은 주요 지점에 달고, 문체는 `.claude/skills/kdance-dev-harness/references/beginner-comment-style.md` 를 따른다.

## 계획·설계 검증 — grill-with-docs (2026-11-19 사용자 지시로 프로젝트에 둠)

- 스킬 사본 3개를 프로젝트에 두었다 — `.claude/skills/grill-with-docs/`·`grilling/`·`domain-modeling/`(Matt Pocock `mattpocock/skills` 의 `skills/engineering/grill-with-docs`·`skills/productivity/grilling`·`skills/engineering/domain-modeling` 고정 사본, 전역 `~/.claude/skills/` 와 같은 내용). 다른 PC 에서도 쓰이게 하려는 것이다. 2026-11-19 원본 저장소 main 과 글자 단위로 같음을 확인했고, 숨은 문자·명령 실행·외부 접속·권한 확장 설정은 없었다. 원본의 `agents/openai.yaml`(다른 도구용 설정)은 넣지 않았다.
- **쓰는 법**: 사용자가 `/grill-with-docs` 를 입력하면 실행한다. 이 스킬은 자동 호출이 막혀 있으므로(`disable-model-invocation`), 에이전트가 계획·설계를 확정하기 전에 검증할 때는 `grilling` → `domain-modeling` 을 차례로 직접 부른다(전역 규칙 「계획·설계 검증」).
- 질문은 전역 「사용자 인터뷰 방식」(한 번에 하나, 선택지 3개, 추천 맨 앞)을 따른다.
- **기록 위치**: 되돌리기 어려운 결정은 새 `docs/adr/` 를 만들지 않고 `CLAUDE-decisions.md` 에 ADR 로 이어 적는다. 용어는 `GLOSSARY.md`(루트, 아직 없음 — 처음 쓸 때 만든다). 제품 요구사항이 바뀌면 spec 원본 `specs/001-ai-dance-class-platform/spec.md` 의 FR·변경 이력에도 반영한다.

## 보안 감사 — security-audit (2026-11-19 사용자 지시로 프로젝트에 둠)

- 스킬 사본 `.claude/skills/security-audit/`(Cloudflare `cloudflare/security-audit-skill` main `c1c8a8c`, MIT) — 다른 PC 에서도 쓰이게. 설치 전 점검(2026-11-19): 숨은 문자 0, 지시 무시·비밀값 요구·외부 전송 문구 없음, `allowed-tools`·hooks 같은 권한 확장 없음. 실행 파일은 결과 검증기 2개(`validate-findings.cjs`·`validate-coverage-ledger.cjs` — `fs`·`path`·`util` 만 쓰고 네트워크·명령 실행 없음)와 그 테스트(로컬 `node` 만 실행).
- **두 가지 모드**: 평소에는 「안내 모드」(보안 질문·특정 코드 리뷰에 필요한 부분만, 파일을 만들지 않음). 「전체 감사 모드」(6단계·여러 에이전트·결과 파일)는 사용자가 감사·모의 해킹·전체 보안 리뷰를 명시적으로 요청할 때만 쓴다 — 비용이 크다.
- 전체 감사 결과는 기본적으로 프로젝트 밖 `~/security-audit-skill/<repo>/run-N` 에 쓴다. 프로젝트 안에 두려면 git 이 그 폴더 전체를 무시하는지 먼저 확인한다(스킬 규칙). 감사 중에는 의존성을 설치하지 않고 배포 환경에 트래픽을 보내지 않는다.
- 공구 계층(ECC)의 `ecc:security-reviewer` 는 Phase 8(코드 리뷰)에서 바뀐 코드만 보는 리뷰이고, 이 스킬은 저장소 전체를 신뢰 경계 기준으로 훑는 감사다 — 겹치지 않게 쓴다.

## Astryx 디자인 시스템 (2026-11-13 사용자 지시로 허용)

- 스킬 사본 `.claude/skills/astryx/SKILL.md`(Meta `meta/astryx` 고정 사본, 전역 `~/.claude/skills/astryx/` 와 같은 내용)를 프로젝트에 두었다 — 다른 PC 에서도 쓰이게. CLI 는 각 PC 에서 `npm i -g @astryxdesign/cli@0.7.15` 로 깐다(보안 검사 기록은 전역 `~/.claude/CLAUDE.md`).
- **admin-web 에서만 쓴다**(Next 16.3 · React 19.3 — Astryx 는 React 19 이상). **mobile(React Native)에는 쓰지 않는다** — Astryx 는 웹 전용이다.
- 테마는 확정된 아이보리 바탕 + 딥 플럼·샴페인(2026-11-09)을 따른다. Astryx 기본 테마를 그대로 쓰지 않고 CSS 변수 덮어쓰기로 맞춘다.
- admin-web 에 `@astryxdesign/*` 패키지를 넣거나 `astryx init` 을 돌리는 것은 사용자 확인 뒤에 한다(아직 넣지 않았다).

## 프론트엔드 화면 검증

- **프론트엔드 작업(admin-web·mobile)은 언제나 브라우저 스크린샷으로 화면을 검증한다.** 화면을 바꿨으면 실제 브라우저로 열어 스크린샷을 남긴다. admin-web 은 `npm run dev` 로 띄운 뒤 Playwright MCP(`mcp__playwright__browser_take_screenshot`)로 찍고, mobile 은 Expo 웹(`npx expo start --web`)으로 열어 같은 방법으로 찍는다. 에이전트가 먼저 그 스크린샷을 직접 보고 의도대로 나왔는지 확인한 뒤, 사람에게 보고할 때 스크린샷 파일 경로를 함께 보여 준다. `npm run build`·`npx tsc --noEmit` 이 통과한 것만으로 화면이 맞다고 하지 않는다.

## 대화 마무리

- **대화를 마무리할 때는 그 대화에서 한 작업의 흐름을 Mermaid 다이어그램으로 보여 준다.** 답변 끝에 ` ```mermaid ` 코드 블록으로 붙인다. 무엇을 확인했고, 무엇을 바꿨고, 무엇이 남았는지가 순서대로 보이게 그린다.

## Architecture

- `docs/` — 2026-10-01 성격별 재편: `policy/`(정책 6종) · `legal/`(약관 3종+archive) · `planning/`(서비스 정의·기술 스택 고정표·기획 분석) · `guide/`(사람용 HTML 가이드, 옛 `docs/가이드/`) · `agent/`(ai-coding-agent.html · handoff) · `deprecated/`(딥링크 A안) · `deck/`(pptx) · `prototype/`(화면 보드·장르 카드). 전체 지도는 `docs/structure-map.md` + `docs/guide/structure-map.html`(`scripts/build_structure_map.py` 로 생성)
- `scripts/` — 저장소 전체 스크립트. pptx 생성기 3개(`build_*_pptx.py`, 출력은 `docs/deck/`) · 구조 지도 생성기 · `claude-free.sh`
- `backend/` — FastAPI API server (uv-managed)
- `admin-web/` — Next.js (App Router) admin console for studio owners. Routes: `app/page.tsx`(대시보드), `app/refund-policy/page.tsx`(환불 비율표 설정 — 2026-09-25 폐기 결정, spec Q11(환불 방식 변경의 뒤처리) ②. 대표 환불 입력 화면으로 대체 예정 — 이벤트형은 계산값 미리 채움(올리기만), 행사 일괄 취소 화면 포함). Client fetch wrapper in `lib/api-client.ts`, env var `NEXT_PUBLIC_API_BASE_URL`. `npm run build`/`dev`/`start`; `npm run lint` currently broken (`eslint.config.mjs` 의 `FlatCompat` 순환 참조 — TS 7 원인은 6.0.3 다운그레이드로 해소됨. 타입 검증은 `next build`).
- `mobile/` — Expo consumer app
- `infra/` — `docker-compose.yml` for local Postgres+pgvector and Redis

## Tools

`rg`/`fd`/`tree` are NOT installed in this environment — use `grep`/`find` instead.

## Dev Environment

Local dev machine spec (development is targeted/tuned for this hardware — factor it into resource-heavy suggestions: local models, Docker resource limits, parallel build/test jobs, emulator/simulator load):

- CPU: 13th Gen Intel Core i7-13700H (2.40GHz)
- RAM: 32GB (31.7GB usable)
- GPU: NVIDIA GeForce RTX 4060 Laptop (8GB VRAM) + Intel Iris Xe Graphics (128MB shared)
- Storage: 477GB total, 229GB used

## Rules Dependency

This template requires `.claude/rules/core-rules.md` for behavioral rules. If `.claude/rules/` is missing or empty, alert the user and direct them to https://github.com/centminmod/my-claude-code-setup to obtain the companion rules files.

## 하네스: kdance 개발 워크플로우

**목표:** 코드 변경 작업(기능 구현/버그 수정/리팩터링)을 요구사항 분석→기존 코드 구조 확인→구현 계획→Task 분리→구현→테스트→오류 수정→코드 리뷰→완료 검증의 9단계로 오케스트레이션하고, 실제 실행(코드 탐색/파일 수정/테스트 실행/Git 작업/의존성 확인/디버깅/리팩터링)은 ECC(everything-claude-code) 플러그인의 에이전트·스킬·MCP에 위임한다.

**트리거:** 기능 구현/버그 수정/리팩터링 등 코드 변경이 걸린 요청 시 `kdance-dev-harness` 스킬을 사용하라. 후속 작업(재실행, 특정 Phase만 다시, 리뷰 반영)도 동일 스킬 사용. 단순 질문/설명은 직접 응답.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-09-14 | 초기 구성 — 9-phase 파이프라인 오케스트레이터 + 8개 신규 에이전트(Phase 2는 기존 code-searcher 재사용) | `.claude/skills/kdance-dev-harness/`, `.claude/agents/kdance-*.md` | 사용자 요청 — Harness가 SDLC 흐름을, ECC가 실제 실행을 담당하는 역할 분리 구조 |
| 2026-09-15 | Phase 9.5(학습 주석 재구성) 추가 — SCH 항목이 `_workspace/SCH_kdance.html`에서 완료로 표시될 때 kdance-implementer를 재사용해 6개월차 비전공자 대상 "지도바둑식" 학습 주석(사전 개념 요약 + 전체 구성 내 위치 설명)으로 재구성 | `.claude/skills/kdance-dev-harness/SKILL.md`, `.claude/skills/kdance-dev-harness/references/beginner-comment-style.md`(신규), `.claude/agents/kdance-implementer.md` | 사용자 요청 — 비전공자가 완료된 소스만 보고도 아키텍처 맥락과 배경 개념을 따라갈 수 있게 하기 위함 |
| 2026-09-15 | Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 확장 — SCH 완료 시 소스 학습 주석과 같은 호출에서 `_workspace/guides/SCH-{번호}.html` 왕초보 완벽분석가이드(이슈→원인파악→해결, 테스트 결과, 다른 SCH와의 연관관계)도 생성하도록 추가 | `.claude/skills/kdance-dev-harness/SKILL.md`, `.claude/skills/kdance-dev-harness/references/sch-guide-template.md`(신규), `.claude/agents/kdance-implementer.md` | 사용자 요청 — 소스 내 주석만으로는 부족한 "작업 과정 전체(이슈·해결·테스트·SCH 간 연관관계)"를 별도 HTML로 남기기 위함 |
| 2026-09-15 | SCH 표기 규칙 추가(번호 단독 금지, `SCH-04(기능명)` 형식 강제) + Git 커밋/PR 설명도 왕초보 기준 문체 규칙 추가 | `.claude/skills/kdance-dev-harness/references/beginner-comment-style.md`, `references/sch-guide-template.md`, `.claude/rules/core-rules.md`, `.claude/skills/kdance-dev-harness/SKILL.md` | 사용자 요청 — 번호만으로는 어떤 SCH인지 알 수 없음 + GitHub push(커밋/PR)에도 동일한 왕초보 이해 기준을 적용 |
| 2026-09-20 | 에이전트 설명 계층 신설 — Phase 9.5(학습 주석 재구성·SCH 가이드 생성)가 산출물 3종을 만들도록 확장. 기존 2종(소스 내 학습 주석·사람용 HTML 가이드)에 `_workspace/guides/SCH-XX(기능명).md`(AI 에이전트용 버전 맞춤 문서)를 추가 | `.claude/skills/kdance-dev-harness/references/agent-sch-doc-template.md`(신규), `SKILL.md`, `.claude/rules/core-rules.md`, `docs/agent/ai-coding-agent.html`(신규) | 사용자 요청 — 에이전트의 학습 데이터에 구버전 API(Prisma 7 `new PrismaClient()`, AI SDK 6 등)가 남아 있어 최신 스택 코드를 옛 방식으로 되돌리는 문제. Next.js 16.3 이 `dist/docs`·`AGENTS.md` 로 푸는 방식을 프로젝트 소스에 적용 |
| 2026-09-21 | **4계층 보강(2차 검토 반영)** — 환경 계층에 6대 업무(Rules·Context·MCP·Hooks·Permissions·**Quality Gates**) 정의, 명세 계층 정의 추가, **테스트·보안을 3계층 분할**(무엇을 만족/어떻게 검사/언제 강제), **ECC 계획 스킬을 「구현 계획」 전용으로 제한**(제품 계획·Task 체계 생성 금지) | `.claude/rules/core-rules.md`, `docs/planning/role-split-analysis.md`(부록) | 외부 분석 2차(`ClaudeCode_SpecKit_Harness_ECC_최적역할분리.md`) 검토 — 품질 게이트 훅이 실제로 0개임을 실측 확인했고, `ecc:planner` 등 계획 스킬 7종이 Phase 3·4와 겹칠 위험이 명문화돼 있지 않았다. Spec Kit 에 plan·tasks 를 넘기자는 주장은 그 흐름에 **기존 코드 조사 단계가 없어** 불채택 |
| 2026-09-21 | **4계층 역할 재정의** — 「Harness/ECC 2축」을 **환경·명세·파이프라인·공구 4계층**으로 재편. 「Harness」를 계층 이름에서 제거(스킬 이름으로만 유지), 「코드를 보는가」 판별 기준 신설, spec-kit 을 `specify` 1개로 축소(3→1), Phase 3 산출물 4종 분리, Phase 4 를 US 단위 수직 슬라이스로, Phase 1 에 슬라이스 절단 책임 추가 | `.claude/rules/core-rules.md`, `.claude/agents/kdance-req-analyst.md`·`kdance-impl-planner.md`·`kdance-task-splitter.md`, `.claude/skills/kdance-dev-harness/SKILL.md`, `docs/planning/role-split-analysis.md`(신규) | 외부 분석 7장 검토 결과 — 「Harness」가 ①9단계 파이프라인 ②작업 환경 두 가지를 가리켜 한 세션에서 경계 분쟁이 3회 발생. 제안안(Spec Kit 에 파이프라인 이관)은 Phase 9.5 학습 산출물이 소멸해 불채택하고, **이름 체계와 산출물 규격만 흡수**하는 제3안 채택 |
| 2026-09-21 | spec-kit 도입 — 앞단(`/speckit-specify`·`clarify`·`checklist`)만 쓰고 구현부터는 기존 하네스가 받는다. `spec.md` 가 Phase 1(요구사항 분석)의 입력이 된다 | `.claude/skills/speckit-*`(신규 10종), `.specify/`, `.claude/rules/core-rules.md`, `.specify/memory/constitution.md` | spec-kit 의 `specify→plan→tasks→implement→converge` 가 하네스 9단계와 거의 같아 그대로 두면 파이프라인이 둘이 된다 — 「절대 금지 패턴」에 걸리므로 겹치는 7개 스킬은 쓰지 않기로 경계를 그었다 |
| 2026-09-23 | **기억 장치 재편** — 세션 기억은 claude-mem(로컬·Haiku)이 맡고, ECC 는 기억 담당에서 뺀다(품질 게이트·에이전트·스킬은 유지). memory MCP 삭제. 메모리 뱅크 `CLAUDE-decisions.md`·`CLAUDE-troubleshooting.md` 신설, Phase 9.5(학습 주석 재구성·SCH 가이드 생성)에 「claude-mem → git 문서로 옮기기」 5번 단계 추가(SCH 미부여 작업은 「정리」에서 수행) | `.claude/skills/kdance-dev-harness/SKILL.md`, `CLAUDE-decisions.md`(신규), `CLAUDE-troubleshooting.md`(신규), `.claude/rules/core-rules.md`(MCP 목록) | 손으로 채우는 기억 장치(memory MCP 엔티티 0, ECC instinct 0)가 계속 비어 있었다 — 자동 수집이 필요했다. 다만 claude-mem 은 이 PC 의 로컬 캐시라 1년 이상 가는 프로젝트에서는 오래 남길 판단을 git 으로 옮기는 단계가 따로 있어야 한다. 상세는 `CLAUDE-decisions.md` ADR-001 |

---

## Memory System

This project uses a dual-memory architecture:

**Primary (git-shared):** CLAUDE-*.md files in repo root — read on demand:

| File | Read When |
|------|-----------|
| CLAUDE-activeContext.md | Session start (state and goals) |
| CLAUDE-patterns.md | Before implementing (code patterns) |
| CLAUDE-decisions.md | Before design choices (ADRs) |
| CLAUDE-troubleshooting.md | When debugging (known fixes) |
| CLAUDE-config-variables.md | When touching config |

**Shadow (machine-local):** Native auto memory mirrors key content for resilience:

| Auto Memory File | Mirrors | Purpose |
|-----------------|---------|---------|
| memory/MEMORY.md | Index of all memory bank files | Always loaded (200 lines) |
| memory/patterns.md | CLAUDE-patterns.md | Survives CLAUDE.md reset |
| memory/architecture.md | CLAUDE-decisions.md | Survives CLAUDE.md reset |
| memory/build.md | Build, Test & Verify section | Survives CLAUDE.md reset |

All optional — check existence first.

**CLAUDE.md 는 git 으로 추적하고 변경 시 커밋한다** (2026-09-20 변경). 이전 규칙은 커밋에서 제외였는데, 파일은 이미 추적 중이라 git 버전만 뒤처지고 있었다. 다른 PC·다른 계정으로 이어받을 때 옛 버전이 넘어가는 문제가 있어 바꿨다. 인수인계 절차는 `docs/agent/handoff.md` 참고.

`CLAUDE-*.md` 메모리 뱅크는 2026-09-23 에 `CLAUDE-decisions.md`·`CLAUDE-troubleshooting.md` 두 개를 먼저 만들었다(나머지 셋은 아직 없음). 같은 기조로 git 에서 추적한다. 채우는 경로는 claude-mem(자동 세션 기록, 이 PC 로컬) → Phase 9.5 5번 단계 → 이 두 파일이다.

<!-- BACKUP TIP: Create a private git repo for memory bank backups:
     rsync -av ./CLAUDE.md ./CLAUDE-*.md ./.claude/ ~/my-project-memory-backup/
     This keeps CLAUDE-*.md version-controlled privately while excluded from the public repo. -->

### Sync Workflow

After significant work: update CLAUDE-*.md files, then sync key content to auto memory topic files.

If CLAUDE.md is ever reset or wiped, auto memory retains project knowledge — check `/memory` to recover context.

---

## Context Layers

| Layer | Location | Loads | Shared | Resilient |
|-------|----------|-------|--------|-----------|
| Project context | This file | Always | Git | No |
| Core rules | `.claude/rules/core-rules.md` | Always | Git | Yes |
| Auto memory | memory/MEMORY.md | Always (200 lines) | No | Yes |
| Auto memory topics | memory/*.md | On demand | No | Yes |
| Path-scoped rules | `.claude/rules/*.md` | Matching files | Git | Yes |
| User rules | `~/.claude/rules/*.md` | Always | No | Yes |
| Skills | `.claude/skills/` | On demand | Git | Yes |
| Personal overrides | `CLAUDE.local.md` | Always | No | Local |
| Memory bank | CLAUDE-*.md | On demand | Git | No |

<!-- To share rules across projects: ln -s ~/shared-rules .claude/rules/shared -->

Use `/memory` to inspect loaded files. Root CLAUDE.md survives `/compact`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
