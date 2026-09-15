# Core Rules

<!-- Loaded automatically at session start for all files -->

## Language (언어 규칙)
- 사용자에게 보여주는 모든 응답(채팅 답변, 계획, 요약, 커밋 설명 등)은 한국어로 작성한다. 사용자가 영어로 질문해도 응답은 한국어로 한다.
- 새로 작성하거나 수정하는 소스 코드의 주석, docstring, JSDoc은 한국어로 작성한다. 변수/함수/클래스/파일명 등 코드 식별자는 기존 관례(영어)를 그대로 유지한다 — 식별자 번역은 코드를 깨뜨릴 수 있으므로 하지 않는다.
- `docs/*.md` 등 프로젝트 설명 문서도 한국어로 작성한다.
- 라이브러리 표준 용어, 에러 코드/상수, 외부 API 스펙에 정의된 문자열 등 영어 유지가 자연스럽거나 필수인 경우는 예외로 둔다.
- MCP 서버(context7 등)나 외부 스킬이 반환하는 원문 자료는 영어일 수 있다 — 이를 인용할 때는 반드시 한국어로 요약/설명해서 전달하고, 원문을 그대로 답변에 붙여넣지 않는다.

## Harness / ECC 역할 분리

**최종 원칙**: Harness = 프로젝트의 지휘자(Orchestrator, "무엇을 할까?") / ECC = 소프트웨어 엔지니어링 전문가(Engineering System, "어떻게 잘 만들까?"). 최종 중심축은 이 둘뿐이다 — 나머지(Playwright/MindPilot/Visual Guide 등)는 이 둘과 경쟁하지 않고 그 위에 얹히는 실행/설명 도구다. 한 줄 구분: **Harness = 프로젝트 레벨("무엇을 어떤 순서로"), ECC = 코드/엔지니어링 레벨("어떻게 제대로")**.

**한 줄 태그라인**
- 🏗 Harness — "프로젝트를 움직이는 두뇌": 무엇을 만들지 → 어떻게 쪼갤지 → 어떤 Agent가 할지 → 어떤 순서로 할지 → 결과를 어떻게 합칠지
- 🛡 ECC — "코드 품질을 지키는 수석 엔지니어": 어떻게 구현할지 → 테스트 → 보안 → 리뷰 → 리팩터링 → 품질 검증
- 🧪 Playwright "실제 사용자가 되어 테스트" · 🧠 MindPilot "복잡한 시스템을 그림으로 이해" · 📚 Context7 "최신 공식 문서 확인" · 🗄 PostgreSQL MCP "DB 직접 확인/작업"

### Harness = Agent Orchestration Layer
핵심 질문: **"이 큰 작업을 누구에게 어떤 순서로 시킬까?"** 코드를 직접 짜거나 고치지 않는다.

**5대 업무** (kdance-dev-harness Phase 매핑):
① 요구사항 → 작업 분해 (Phase 1~3) — 예: 예약 기능 → DB Schema/Backend API/Service/Payment/Notification/Next.js/React Native/Admin/E2E
② Agent Team 구성·역할 배정 (Phase 4) — DB/Backend/Frontend/Payment/Notification/AI/QA Agent
③ 작업 의존성 관리 (Phase 4) — 예: DB 완료 → Backend 완료 → Frontend 구현 → Integration → E2E
④ 병렬 작업 — 의존성 없는 작업끼리 동시 진행(예: DB 완료 후 Frontend와 Admin UI를 동시에)
⑤ Agent 결과 취합 (Phase 5~9.5) — 각 Agent 산출물을 하나의 기능으로 통합, 학습 주석/가이드까지 포함

### ECC = Software Engineering Quality Layer
핵심 질문: **"이 코드를 어떻게 하면 제대로 만들 수 있지?"**

**6대 업무**: ① TDD(요구사항→Test→Implementation→Test→Refactor, "테스트부터 제대로 작성했나?") ② Code Review(버그/중복/복잡도/유지보수성/설계 문제) ③ Security — **예약·결제가 있는 이 프로젝트에서 특히 중요**(인증/권한/입력 검증/민감정보/API 보호/Webhook 검증/결제 위변조) ④ Refactoring(거대 파일을 Service/Repository/Domain/Validator/DTO 등으로 분리) ⑤ Coding Standard(Python: FastAPI/SQLAlchemy2/Pydantic, TypeScript: Next.js/React Native) ⑥ 테스트 품질(Unit/Integration/Security/Regression) — 단 **실제 브라우저 E2E 실행은 Playwright가 담당**(ECC는 품질 기준만).

실행 수단: 전문 Agent, Skills, Hooks, Rules(`ecc:fastapi-patterns`, `ecc:python-patterns`, `ecc:python-testing`, `ecc:security-reviewer`, `ecc:refactor-clean`, `code-review`, `ecc:build-fix` 등)로 코드 탐색·파일 수정·테스트 실행·Git 작업·의존성 확인·디버깅·리팩터링을 실제로 수행한다. **ECC의 방대한 스킬(387개+)을 전부 연결하려 하지 않는다** — 위 6대 업무 중심으로만 쓰고, 이 프로젝트와 무관한 스킬(마케팅/브랜딩/네트워크/블록체인 등)은 필요할 때만 개별적으로 고른다. Harness도 마찬가지로 위 5대 업무(Feature Planning/Task Decomposition/Agent Assignment/Dependency/Parallelization/Integration)에만 집중한다.

### 표준 실행 파이프라인
```
사용자 요구사항
   ↓
① Harness — "이 기능을 어떻게 쪼갤까?" (Phase 1~3)
   ↓
② Agent Team 구성 + ③ 의존성 결정 (Phase 4)
   ↓
④ 각 Agent 구현 — 병렬 가능한 것은 동시에 (Phase 5)
   ↓
⑤ ECC — TDD → Security → Review (Phase 6, 8)
   ↓
⑥ Playwright — E2E 검증 (Phase 6/8, `ecc:e2e-runner`/`mcp__playwright`)
   ↓
⑦ Harness — 전체 완료 판단 (Phase 9 + 9.5 학습 주석/가이드)
   ↓
⑧ 완료
```
한 줄 요약: **"Harness가 작업을 지휘하고, ECC가 작업의 품질을 검사한다."**

kdance-implementer/test-runner/bug-fixer/code-reviewer 등 각 Phase 에이전트는 Harness가 배정한 "무엇을·누구에게·어떤 순서로"를 받아 ECC의 스킬/에이전트/MCP로 "어떻게 잘"을 실행한다 — 이 둘을 섞어서 하나가 다 하지 않는다.

**절대 금지 패턴**: Harness와 ECC가 각자 독립적으로 `Plan → Implement → Test → Review` 전체 파이프라인을 따로 도는 구조는 만들지 않는다 — "Harness가 계획을 세웠는데 ECC가 또 계획을 세우는" 중복·혼란이 생긴다.

예외: 서브에이전트가 세션 한도(rate limit) 등으로 중단되어 이미 끝난 작업의 상태만 확인·정리해야 할 때, 또는 파일 몇 줄 수준의 사소한 마무리는 오케스트레이터가 직접 처리해도 된다 — 다만 이건 예외이지 기본 동작이 아니다.

### 역할 충돌 방지 매트릭스
🟢 주 역할 / 🟡 보조 / ⚪ 맡기지 않음 — 애매한 업무가 나오면 이 표로 판단한다.

| 업무 | Harness | ECC |
|---|---|---|
| 요구사항 분석 / 기능 분해 / Agent 구성·배정 / 작업 순서 / 의존성 관리 / 병렬 실행 / 결과 통합 | 🟢 | ⚪ |
| 코드 작성 | 🟡(Agent 실행) | 🟢(품질 기준) |
| Architecture | 🟢(시스템 관점) | 🟢(코드 관점) — 둘 다 주 역할, 관점이 다름 |
| TDD / Unit Test / Security / Code Review / Refactoring / Coding Standard | ⚪ | 🟢 |
| Integration Test / Build 오류 | 🟡 | 🟢 |
| E2E | ⚪ | 🟡(품질 기준만 — 실행은 Playwright) |
| 전체 프로젝트 상태 | 🟢 | ⚪ |
| 전체 완료 판단 | 🟢 | 🟡 |

### 비유로 이해하기
- **자동차**: Harness = 주행 시스템(어디로 갈까 → 어떤 경로 → 누가 운전 → 어떤 순서 → 언제 멈출까). ECC = 품질/안전 시스템(브레이크? 엔진? 안전벨트? 경고등? 검사?). 둘 다 있어야 목적지에 안전하게 도착한다.
- **사람 역할**: 사용자 = Product Owner, Harness = Tech Lead/PM, 각 Agent = 개발자, ECC = Senior Engineer + QA/Code Quality 체계, Playwright = 실제 사용자 테스트 담당.
- **왜 혼자 개발할 때 특히 중요한가**: 사람 팀이면 "DB 담당·프론트 담당·결제 담당·QA 담당"으로 저절로 역할이 나뉘지만, 혼자 Claude Code로 개발할 때는 그 역할 분담을 Harness가 대신 해줘야 한다.

### 프로젝트 규모가 커질 때 — 팀 단위 조직
kdance는 예약 취소/환불 슬라이스를 넘어 수업·결제·캘린더·알림·학원·공지·대회·파티·뉴스·관리자·비용관리·PDF/이미지 등록·AI 검색·추천까지 넓어질 예정이다(`docs/*` 기획 문서 참고). 이 규모에서는 Task를 개별 나열하지 않고 **팀 단위**로 먼저 묶는다(Harness Phase 3~4가 결정, 팀 내부 실행은 여전히 ECC에 위임):
- **Frontend Team**: Android(mobile), Next.js(admin-web), Admin — ECC 기준: TDD/Review/Refactor
- **Backend Team**: API, Auth, Reservation, Notification — ECC 기준: Security/API Review/DB Review
- **Data Team**: PostgreSQL, pgvector(`CLAUDE.md`의 Backend DB와 동일)
- **AI Team**: Search, RAG, Recommendation, Agent — ECC 기준: Evaluation/Prompt Review/RAG Test
- **QA Team**: Unit, Integration, E2E — 위 세 팀의 결과가 전부 여기로 수렴

### MCP 도구 계층 + 전체 4계층 구조
Harness(WORKFLOW)와 ECC(QUALITY) 둘 다 아래 MCP를 호출해 실제 작업을 한다 — MCP를 직접 고르지 않고 Harness/ECC 어느 쪽 일이냐로 자동으로 정해진다:
- `mcp__context7__*` 문서 · `mcp__postgres-kdance__*` DB 작업 · `mcp__playwright__*` E2E · `mcp__mindpilot__*` 구조도 · `mcp__plugin_ecc_chrome-devtools__*` 브라우저 · `mcp__memory__*` 세션 간 기억(지식 그래프)

**전체 4계층**: 1) 핵심 조합 — Harness + ECC  2) 도구 계층 — 위 MCP 6종  3) UI 계층 — `frontend-design` + `ui-ux-pro-max` 스킬군(admin-web·mobile 화면 작업)  4) 왕초보 설명 계층 — SCH별 학습 주석(`beginner-comment-style.md`) + 왕초보 완벽분석가이드(`sch-guide-template.md`, `_workspace/guides/SCH-XX.html`) + MindPilot.

4번(왕초보 설명 계층)은 1~3번이 끝난 결과를 설명만 할 뿐, 의사결정에 관여하지 않는다 — Visual Guide Skill과 MindPilot은 Harness/ECC와 경쟁·대체 관계가 아니라 그 위에 얹는 부가 계층이다.

전체 그림(다이어그램 중심 설명)은 `docs/harness-ecc-guide.html` 참고.

## Git 커밋 / PR 설명 (왕초보 + 면접담당자 기준)
- 커밋 메시지와 PR 설명은 **두 종류의 독자** 모두가 읽고 이해할 수 있게 쓴다: ① 개발 경력 6개월차 비전공자(무엇을 왜 바꿨는지 개념부터 이해해야 함) ② 면접담당자/리뷰어(짧은 시간에 구조와 흐름, 판단력을 파악해야 함). 두 독자 모두 **장황한 나열보다 핵심만 정돈된 글**을 원한다 — 있었던 일을 전부 적지 말고, 그 커밋에서 가장 중요한 판단 1~2가지로 압축한다.
- 제목 줄은 기존 conventional commit 스타일(`feat:`/`fix:`/`chore:` 등, 이 저장소의 기존 로그 관례)을 유지하되 **한 줄만 보고도 무엇을 왜 했는지 알 수 있어야** 한다.
- 본문은 다음 4가지만 담고, 각 항목은 1~3문장으로 압축한다(더 길어지면 정말 중요한 것만 남기고 나머지는 뺀다):
  1. **무엇을, 왜** — 전문 용어는 처음 등장할 때 괄호로 짧게 풀이. "왜 이 방식을 택했는지"의 핵심 판단 1가지를 반드시 포함(면접담당자가 가장 궁금해하는 부분).
  2. **SCH 참조** (있다면) — 번호만 쓰지 않고 `SCH-04(어댑터 3종: PG/알림/슬롯락)`처럼 기능명을 붙인다(`beginner-comment-style.md`의 "SCH 표기 규칙"과 동일 기조).
  3. **검증** — 실행한 테스트와 결과를 한 줄로(예: `pytest 159 passed`). 알려진 제한/미해결이 있다면 과장 없이 한 줄로.
  4. **가이드 링크** (있다면) — 해당 SCH의 왕초보 가이드(`_workspace/guides/SCH-XX.html`) 경로.
- 하나의 커밋에 여러 변경을 욱여넣지 않는다 — 커밋을 나누는 기준 자체가 "면접담당자가 커밋 로그만 훑어도 작업 흐름이 보이는가"다. 논리적 단위(기능/SCH/계층)로 나눠서 커밋한다.
- Git 작업(커밋/푸시)은 여전히 **사용자가 명시적으로 요청할 때만** 수행한다 — 이 규칙은 "쓸 때의 문체"만 정하고 "언제 커밋할지"는 바꾸지 않는다.

## Investigation & Accuracy
- Never speculate about code you have not read. Read files and ripgrep for usages before making claims
- If the user references a file, read it before answering
- If uncertain, say so and propose how to verify. Do not fabricate APIs, paths, or behavior

## Scope Discipline
- Do what has been asked; nothing more, nothing less
- When intent is ambiguous, default to research and recommendations — only edit when explicitly asked
- Make only the changes requested. Do not refactor adjacent code, add docstrings to unchanged code, or create abstractions for a single use
- Follow scoping words ("only", "just", "exactly") literally

## Verification & Safety
- Before declaring done: re-check requirements, run tests and lint, state what changed and what you could not verify
- Ask before destructive actions: deleting files/branches, force pushes, hard resets, --no-verify
- Edit existing files in place. Do not create new files unless required. Clean up scratch files

## Efficiency
- Parallelize independent tool calls; serialize dependent ones
- Never use placeholder or guessed parameters

## Memory Resilience
- When updating CLAUDE-*.md memory bank files, also sync key content to native auto memory topic files
- Maintain memory/MEMORY.md as an index of memory bank files and their current state
- After learning behavioral preferences from corrections, save them as auto memory entries
- If CLAUDE.md is reset or wiped, check auto memory via `/memory` to recover project context
