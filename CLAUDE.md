# CLAUDE.md

<!-- Project-specific context only. Behavioral rules: .claude/rules/core-rules.md -->
<!-- Run /init to auto-populate (or CLAUDE_CODE_NEW_INIT=1 for interactive mode) -->
<!-- Keep under 200 lines. If removing a line wouldn't cause mistakes, cut it -->

## Project Overview

- Name: kdance (Android package `com.kdancex3`, product name K-DanceX3). **2026-09-14: "k-dancex4" confirmed as app working title / domain name** (`docs/distribution-policy.md` — relationship to existing K-DanceX3 product name not yet clarified, both recorded)
- Stack: FastAPI + SQLAlchemy2 + Alembic + psycopg3 (backend, uv/Python 3.12) · **Next.js (App Router) + TS (admin-web, confirmed 2026-09-14 — replaces earlier Vite scaffold)** · Expo SDK 57 + React Native + TS (mobile)
- Description: dance studio booking/membership app (Android). See `docs/pricing-policy.md` and `docs/distribution-policy.md` for business decisions made so far.
- Backend DB: PostgreSQL 18 + pgvector, local dev container `kdance-db` (port 5433, db name `kdance`). Redis is `kdance-redis` (port 6380). Both are defined in `infra/docker-compose.yml`

## Build, Test & Verify

<!-- No build yet — nothing to install/build/test until the stack is chosen. -->

## Code Style

<!-- Not yet established. -->

## Architecture

- `docs/` — planning notes and setup guides (pricing/distribution/genre-taxonomy policy, OmniRoute setup guide)
- `backend/` — FastAPI API server (uv-managed)
- `admin-web/` — Next.js (App Router) admin console for studio owners. Routes: `app/page.tsx`(대시보드), `app/refund-policy/page.tsx`(환불 비율표 설정). Client fetch wrapper in `lib/api-client.ts`, env var `NEXT_PUBLIC_API_BASE_URL`. `npm run build`/`dev`/`start`; `npm run lint` currently broken (eslint-config-next 16 × eslint 9 circular-config bug, not yet fixed — TypeScript check via `next build` is the reliable verification for now).
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
| 2026-09-15 | Phase 9.5(학습 주석 재구성) 추가 — SCH 항목이 `_workspace/kdance.html`에서 완료로 표시될 때 kdance-implementer를 재사용해 6개월차 비전공자 대상 "지도바둑식" 학습 주석(사전 개념 요약 + 전체 구성 내 위치 설명)으로 재구성 | `.claude/skills/kdance-dev-harness/SKILL.md`, `.claude/skills/kdance-dev-harness/references/beginner-comment-style.md`(신규), `.claude/agents/kdance-implementer.md` | 사용자 요청 — 비전공자가 완료된 소스만 보고도 아키텍처 맥락과 배경 개념을 따라갈 수 있게 하기 위함 |
| 2026-09-15 | Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 확장 — SCH 완료 시 소스 학습 주석과 같은 호출에서 `_workspace/guides/SCH-{번호}.html` 왕초보 완벽분석가이드(이슈→원인파악→해결, 테스트 결과, 다른 SCH와의 연관관계)도 생성하도록 추가 | `.claude/skills/kdance-dev-harness/SKILL.md`, `.claude/skills/kdance-dev-harness/references/sch-guide-template.md`(신규), `.claude/agents/kdance-implementer.md` | 사용자 요청 — 소스 내 주석만으로는 부족한 "작업 과정 전체(이슈·해결·테스트·SCH 간 연관관계)"를 별도 HTML로 남기기 위함 |
| 2026-09-15 | SCH 표기 규칙 추가(번호 단독 금지, `SCH-04(기능명)` 형식 강제) + Git 커밋/PR 설명도 왕초보 기준 문체 규칙 추가 | `.claude/skills/kdance-dev-harness/references/beginner-comment-style.md`, `references/sch-guide-template.md`, `.claude/rules/core-rules.md`, `.claude/skills/kdance-dev-harness/SKILL.md` | 사용자 요청 — 번호만으로는 어떤 SCH인지 알 수 없음 + GitHub push(커밋/PR)에도 동일한 왕초보 이해 기준을 적용 |
| 2026-09-20 | 에이전트 설명 계층 신설 — Phase 9.5(학습 주석 재구성·SCH 가이드 생성)가 산출물 3종을 만들도록 확장. 기존 2종(소스 내 학습 주석·사람용 HTML 가이드)에 `_workspace/guides/SCH-XX(기능명).md`(AI 에이전트용 버전 맞춤 문서)를 추가 | `.claude/skills/kdance-dev-harness/references/agent-sch-doc-template.md`(신규), `SKILL.md`, `.claude/rules/core-rules.md`, `docs/ai-coding-agent.html`(신규) | 사용자 요청 — 에이전트의 학습 데이터에 구버전 API(Prisma 7 `new PrismaClient()`, AI SDK 6 등)가 남아 있어 최신 스택 코드를 옛 방식으로 되돌리는 문제. Next.js 16.3 이 `dist/docs`·`AGENTS.md` 로 푸는 방식을 프로젝트 소스에 적용 |

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

**CLAUDE.md 는 git 으로 추적하고 변경 시 커밋한다** (2026-09-20 변경). 이전 규칙은 커밋에서 제외였는데, 파일은 이미 추적 중이라 git 버전만 뒤처지고 있었다. 다른 PC·다른 계정으로 이어받을 때 옛 버전이 넘어가는 문제가 있어 바꿨다. 인수인계 절차는 `docs/handoff.md` 참고.

`CLAUDE-*.md` 메모리 뱅크 파일은 아직 만들지 않았다 — 만들면 같은 기조로 추적한다.

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
