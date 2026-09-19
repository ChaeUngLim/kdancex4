# Core Rules

<!-- Loaded automatically at session start for all files -->

## Language (언어 규칙)
- 사용자에게 보여주는 모든 응답(채팅 답변, 계획, 요약, 커밋 설명 등)은 한국어로 작성한다. 사용자가 영어로 질문해도 응답은 한국어로 한다.
- 새로 작성하거나 수정하는 소스 코드의 주석, docstring, JSDoc은 한국어로 작성한다. 변수/함수/클래스/파일명 등 코드 식별자는 기존 관례(영어)를 그대로 유지한다 — 식별자 번역은 코드를 깨뜨릴 수 있으므로 하지 않는다.
- `docs/*.md` 등 프로젝트 설명 문서도 한국어로 작성한다.
- 라이브러리 표준 용어, 에러 코드/상수, 외부 API 스펙에 정의된 문자열 등 영어 유지가 자연스럽거나 필수인 경우는 예외로 둔다.
- MCP 서버(context7 등)나 외부 스킬이 반환하는 원문 자료는 영어일 수 있다 — 이를 인용할 때는 반드시 한국어로 요약/설명해서 전달하고, 원문을 그대로 답변에 붙여넣지 않는다.

### AI 티 제거 — 윤문 필수 단계

**산출하는 모든 한국어 글은 초안을 쓴 뒤 `humanize-korean` 스킬(im-not-ai 플러그인)로 한 번 윤문하고, 그 결과를 최종본으로 쓴다.** 한국어로 쓰라는 위 규칙만으로는 부족하다 — 규칙을 지켜 써도 번역투("~에 있어서", "~에 의해"), 피동 남발("~되고 있다", "~것으로 확인되었다"), 지시대명사 직역("그것은"), 결산 공식("결론적으로, ~라고 할 수 있다") 같은 AI 티가 남는다. 이건 읽는 사람이 가장 먼저 감지하는 신호이고, 면접담당자에게는 특히 그렇다.

**적용 대상**
- `docs/*.md` · `docs/가이드/*.html` 등 프로젝트 설명 문서
- `_workspace/guides/SCH-XX.html` 왕초보 완벽분석가이드
- README, 기획/정책 문서
- 커밋 메시지 본문 · PR 설명 (상세는 「Git 커밋 / PR 설명」 절)
- 분량 있는 학습 주석 블록(`beginner-comment-style.md` 기준으로 쓴 문단급 주석)

**경로 선택**
- 문단급 이상 → `humanize-korean` (어휘+구조 전체, 진단→윤문→게이트)
- 두세 문장 → `humanizer-kr` 단독으로 갈음 가능. 짧은 글에 3콜 파이프라인은 과하다
- 한 줄짜리는 생략한다

**윤문하지 않는 것** — 코드 식별자, 수치·테스트 결과·명령어·파일 경로·고유명사, 코드 블록, frontmatter, 링크, 영어 원문. 스킬의 Do-NOT 대상이라 보통 변형되지 않지만 결과에서 한 번 더 확인한다.

**의미 보존이 문체보다 우선한다.** 윤문 후 원문과 대조해 수치·사실·주장이 바뀌지 않았는지 확인하고, 바뀐 문장은 원문으로 되돌린다.

### 식별자·용어 표기 통일

**번호나 코드만 단독으로 쓰지 않는다.** SCH·Task(`T1~`)·Phase·화면 ID 등 이 프로젝트가 쓰는 모든 식별자는 `식별자(핵심 기능)` 형태로 쓴다. 번호만으로는 그게 뭘 가리키는지 알 수 없어서, 문서를 처음 읽는 사람이 매번 정의부로 되돌아가야 한다.

| 이렇게 쓰지 않는다 | 이렇게 쓴다 |
|---|---|
| `SCH-04` | `SCH-04(어댑터 3종: PG/알림/슬롯락)` |
| `T3` | `T3(리다이렉트 브릿지 엔드포인트)` |
| `Phase 9.5` | `Phase 9.5(학습 주석 재구성·SCH 가이드 생성)` |
| `의존: T2~T5` | `의존: T2~T5(딥링크 생성 ~ 입금 확인 폴링)` |

- 괄호 안 기능명은 그 식별자의 **공식 한 줄 설명**을 쓴다 — SCH는 `_workspace/kdance.html`, Task는 해당 문서의 헤딩에서 가져온다. 새로 지어내지 않는다. 길면 핵심만 줄이되, 같은 식별자는 프로젝트 전체에서 같은 축약을 쓴다.
- **같은 섹션·같은 문단 안에서 반복**할 때는 번호만 써도 된다. 매번 괄호를 붙이면 오히려 읽기 어렵다. 새 섹션·새 파일·새 주석 블록에서는 다시 붙인다.
- **헤딩이 곧 정의인 자리**(`### T3. 리다이렉트 브릿지 엔드포인트`)는 이미 설명이 붙어 있으므로 괄호를 겹쳐 쓰지 않는다.
- **치환 전 실제 용례를 눈으로 확인한다.** 식별자처럼 보여도 다른 의미인 경우가 있다 — 실측 사례: `참가신청 D-12`·`수강권 D-18 소멸`은 화면 ID가 아니라 디데이였고, 어떤 문장의 `Phase 5`는 "번호만 쓰지 말라"는 규칙을 설명하려고 인용한 나쁜 예시였다. 버전 번호·좌표·기간 표기도 같은 함정이다. 정규식으로 찾은 결과를 그대로 치환하지 않는다.
- **다이어그램 노드 레이블은 건드리지 않는다.** Mermaid 레이블(`A_PG["PG 어댑터 · payment_gateway.py · 완료 SCH-04"]`)은 레이블 자체가 이미 기능 설명이고, 괄호를 넣으면 파싱이 깨질 수 있다.

**영문 용어는 `영문(한글)`로 병기한다** — 처음 나올 때 한 번이면 된다. 예: `deeplink(딥링크)`, `webhook(웹훅)`, `idempotency key(멱등키)`. 이미 한국어로 굳은 말(로그인·서버·테스트)은 병기하지 않는다. 한글이 먼저 나오는 게 자연스러운 자리에서는 `멱등키(idempotency key)`처럼 순서를 뒤집어도 된다 — 기준은 "읽는 사람이 무엇을 먼저 알아야 하는가"다.

**적용 범위는 「AI 티 제거」 절과 같다** — docs 문서, SCH 가이드, README, 커밋 메시지, 학습 주석 전부.

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
- `mcp__context7__*` 문서 · `mcp__postgres-kdance__*` DB 작업 · `mcp__playwright__*` E2E · `mcp__mindpilot__*` 구조도 시각화 **실행 도구** · `mcp__plugin_ecc_chrome-devtools__*` 브라우저 · `mcp__memory__*` 세션 간 기억(지식 그래프)

> **`mcp__mindpilot__*`는 다이어그램·아키텍처·구조도 시각화 요청의 실행 도구로 명시한다.** "다이어그램 보여줘", "구조도 그려줘", "mindpilot UI로 보여줘" 같은 요청에는 mindpilot-mcp를 우선 실행 도구로 사용한다(연결 여부는 아래 절차로 먼저 확인). 안정성이 더 중요한 반복 작업이면 `diagram-this` 스킬로 대체한다(절차 5번).

> **mindpilot-mcp 사용 절차(2026-09-19 원인 규명, WSL 환경).** 근본 원인은 **패키지 버그**다 — 재조사할 필요 없다. `@mindpilot/mcp` 0.5.1은 UI를 Electron 앱(`dist/electron/main.js`)으로 띄우는데, `electron`이 `package.json`의 **devDependencies**에 들어 있다. `npx`로 설치하면 devDependencies는 안 깔리므로 `node_modules/.bin/electron`이 비어 있고, `open_ui` 호출이 `spawn ... ENOENT`로 실패하면서 그 예외가 MCP 서버 프로세스를 통째로 죽인다. 이것이 "간헐적으로 끊긴다"고 기록해 둔 현상의 정체다(2026-09-16자 기록은 stdio 전송 문제로 오진했다 — 그 진단은 폐기).
>
> **우회 수단이 있다.** 같은 패키지 안에 Electron 없이 도는 웹서버 진입점이 들어 있다. 이걸 직접 띄우면 `localhost:4000` UI가 그대로 열린다:
> ```bash
> node ~/.npm/_npx/*/node_modules/@mindpilot/mcp/dist/http/server.js
> ```
> 다만 이 웹서버는 MCP 연결과 별개라, UI는 보여도 `render_mermaid` 도구 호출은 MCP가 붙어 있어야 한다. 근본 해결은 해당 패키지 디렉터리에서 `npm i electron`(150MB+, WSLg 필요)을 한 번 깔아 주는 것이다.
>
> **아래 절차를 따른다:**
>
> 1. mindpilot 도구 호출 전 `ToolSearch("select:mcp__mindpilot__render_mermaid,mcp__mindpilot__open_ui")`로 연결 확인.
> 2. 안 잡히면 사용자에게 **이 터미널에서** `/mcp` 재연결을 요청한다(다른 터미널/세션에서 재연결해도 이 세션에는 반영 안 됨 — 반드시 같은 터미널).
> 3. 재연결 직후에는 여러 호출이 자동으로 잘 이어지는 구간이 있다(로그상 확인됨) — **그 요청에 필요한 mindpilot 호출을 한 번에 몰아서 실행**하고, 다음 사용자 메시지를 기다리며 시간을 끌지 않는다.
> 4. UI는 기본 `localhost:4000` 공유 웹서버이고, `open_ui`의 자동 브라우저 열기가 이 WSL 환경에서 안 먹거나 빈 화면으로 뜰 수 있다 — 그럴 땐 `explorer.exe`로 `http://localhost:4000`을 직접 열게 안내한다.
> 5. 안정성이 우선인 요청(반복 작업, 여러 다이어그램)이면 먼저 `diagram-this` 스킬(설치됨, 서버 연결 없이 mermaid.js를 정적 HTML로 구워 `explorer.exe`로 여는 방식 — `.diagrams/<하위폴더>/`에 저장)을 기본으로 제안하고, mindpilot은 사용자가 명시적으로 mindpilot UI를 요청할 때만 쓴다.

> **OmniRoute 무료 모델 사용 정책(프론트엔드 개발, 2026-09-18 확정).** OmniRoute는 로컬 LLM 게이트웨이로 무료/오픈 모델까지 라우팅할 수 있지만, 에이전틱 코딩(멀티파일 수정·도구 호출·긴 컨텍스트 유지)에서는 무료 모델이 아직 Claude Opus 5.0급을 못 따라간다 — 특히 "지시를 정확히 따르고 스스로 검증하는" 능력 차이가 커서, 무료 모델 산출물은 검증·리뷰 부담이 늘어난다. 그래서 다음 하이브리드 원칙을 따른다(전면 전환 금지):
> 1. **Opus 5.0 토큰이 남아있는 동안**은 구조 설계·복잡한 로직·컴포넌트 아키텍처를 Opus로 진행한다.
> 2. **Opus 토큰 소진 후에만** 반복적·저위험 작업(단순 CRUD 폼, 스타일링, 보일러플레이트)에 한해 OmniRoute 무료 모델로 전환한다.
> 3. 어느 모델로 만들었든 결과물은 `ecc:code-reviewer`/`ecc:react-review`로 반드시 재검증한다 — 무료 모델 산출물이라고 리뷰를 생략하지 않는다.
> 4. OmniRoute 무료 모델은 어디까지나 "비용 절감용 보조 채널"이며 기본 개발 채널을 대체하지 않는다.
> 5. **OmniRoute 무료 모델 폴백 구성(영구 무료 + 최신 세대 + 용도에 맞는 카테고리만, 체험판/가입크레딧/구형/성격 안 맞는 모델은 전부 제외 — 상세는 `docs/omniroute-setup.html`).** 위 2번 조건(Opus 소진)이 실제로 발동됐을 때 아래 구성을 따른다:
>    - **백엔드 4개는 순차 폴백 Combo**(`Free-fallback`, Strategy: Priority, 2026-09-18 실제 등록·테스트 완료): `kiro/claude-sonnet-4.5 → groq/qwen/qwen3.8-27b → gemini/gemini-3.8-flash → mistral/codestral-latest`. 작업 성격이 비슷해서 "제일 좋은 것부터, 막히면 다음"이 자연스럽다. (Kimi는 2026-09-18 재검토로 제외 — Groq가 서빙하던 Kimi K2 계열이 2026-03-23부로 지원 종료(deprecated)되어 `openai/gpt-oss-120b`로 대체된 것으로 확인돼, Groq 경유 접근 근거 자체가 무효화됨. Gemini 3.8 Flash는 공식 문서 기준 무료지만 하루 20건·분당 10건으로 한도가 매우 작음 — 순서는 유지하되 대량 작업 폴백으로는 기대하지 말 것)
>    - **프론트엔드 3개는 폴백이 아니라 역할별 직접 호출**: 화면 구조·상태관리 등 판단이 필요한 작업 → `kiro/claude-sonnet-4.5`(월 50회 한도라 아무 데나 먼저 쓰지 않음); 실제 컴포넌트/UI 코드 작성 **및 비슷한 화면 다수·일괄 스타일 같은 대량 반복** → `zai/glm-4.7-flash`(기본값 겸 물량 담당 — 만료 없는 영구 무료라 프론트엔드에서 볼륨을 받아낼 수 있는 유일한 모델); `gemini/gemini-3.8-flash`는 **예비(비상용)** — 하루 20건뿐이라 대량 작업에 쓸 수 없고 GLM이 막혔을 때 중요한 몇 건에만 쓴다. 지정한 모델의 한도가 막혔을 때만 안전망 Combo `fe-fallback`(`kiro/claude-sonnet-4.5 → zai/glm-4.7-flash → gemini/gemini-3.8-flash`, Priority, 아직 미생성)으로 대체한다.
>    - 3개월마다(다음: 2026-12-18) 클라우드 루틴이 이 구성의 최신성을 재검증한다 — 결과는 보고서만 남기고 자동 반영은 안 하므로, 다음 세션에서 사람이 확인 후 직접 반영한다.

**전체 4계층**: 1) 핵심 조합 — Harness + ECC  2) 도구 계층 — 위 MCP 6종  3) UI 계층 — `frontend-design` + `ui-ux-pro-max` 스킬군(admin-web·mobile 화면 작업)  4) 왕초보 설명 계층 — SCH별 학습 주석(`beginner-comment-style.md`) + 왕초보 완벽분석가이드(`sch-guide-template.md`, `_workspace/guides/SCH-XX.html`) + MindPilot.

4번(왕초보 설명 계층)은 1~3번이 끝난 결과를 설명만 할 뿐, 의사결정에 관여하지 않는다 — Visual Guide Skill과 MindPilot은 Harness/ECC와 경쟁·대체 관계가 아니라 그 위에 얹는 부가 계층이다.

전체 그림(다이어그램 중심 설명)은 `docs/가이드/harness-ecc-guide.html` 참고.

**설치된 범용 `harness:harness` 메타스킬(harness-marketplace 플러그인)과 절대 혼동하지 않는다.** 이 메타스킬은 새 도메인에 처음부터 하네스를 만들어주는 범용 도구이고, "하네스 점검/감사/현황/에이전트-스킬 동기화" 같은 문구에 트리거된다. kdance는 이미 `kdance-dev-harness`가 만들어져 있고 Phase 9.5·SCH 표기 규칙·beginner-comment-style.md 등 이 프로젝트 전용으로 커스터마이징돼 있다 — 범용 메타스킬은 이 커스터마이징을 모른 채 자기 템플릿으로 재구성하려 들 수 있으므로, kdance에서 하네스를 점검·수정·확장할 때는 **범용 `harness:harness`를 호출하지 말고 `.claude/skills/kdance-dev-harness/`와 `.claude/agents/kdance-*.md`를 직접 Read/Edit한다.**

## Git 커밋 / PR 설명 (왕초보 + 면접담당자 기준)
- 커밋 메시지와 PR 설명은 **두 종류의 독자** 모두가 읽고 이해할 수 있게 쓴다: ① 개발 경력 6개월차 비전공자(무엇을 왜 바꿨는지 개념부터 이해해야 함) ② 면접담당자/리뷰어(짧은 시간에 구조와 흐름, 판단력을 파악해야 함). 두 독자 모두 **장황한 나열보다 핵심만 정돈된 글**을 원한다 — 있었던 일을 전부 적지 말고, 그 커밋에서 가장 중요한 판단 1~2가지로 압축한다.
- 제목 줄은 기존 conventional commit 스타일(`feat:`/`fix:`/`chore:` 등, 이 저장소의 기존 로그 관례)을 유지하되 **한 줄만 보고도 무엇을 왜 했는지 알 수 있어야** 한다.
- 본문은 다음 4가지만 담고, 각 항목은 1~3문장으로 압축한다(더 길어지면 정말 중요한 것만 남기고 나머지는 뺀다):
  1. **무엇을, 왜** — 전문 용어는 처음 등장할 때 괄호로 짧게 풀이. "왜 이 방식을 택했는지"의 핵심 판단 1가지를 반드시 포함(면접담당자가 가장 궁금해하는 부분).
  2. **SCH 참조** (있다면) — 번호만 쓰지 않고 `SCH-04(어댑터 3종: PG/알림/슬롯락)`처럼 기능명을 붙인다(`beginner-comment-style.md`의 "SCH 표기 규칙"과 동일 기조).
  3. **검증** — 실행한 테스트와 결과를 한 줄로(예: `pytest 159 passed`). 알려진 제한/미해결이 있다면 과장 없이 한 줄로.
  4. **가이드 링크** (있다면) — 해당 SCH의 왕초보 가이드(`_workspace/guides/SCH-XX.html`) 경로.
- **커밋·푸시 전에 본문을 윤문한다 — 「AI 티 제거」 절의 필수 단계가 커밋 메시지·PR 설명에도 그대로 적용된다.** 위 4항목을 갖춰 초안을 쓰고, 스킬에 통과시킨 결과를 최종본으로 쓴다. 스킬이 내용 앵커를 보존하므로 4항목의 정보는 그대로 남는다.
  - **제목 줄은 윤문 대상이 아니다** — conventional commit 형식이 고정돼 있다.
  - 본문이 3문장 이상일 때만 적용한다. 한 줄 커밋은 생략.
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
