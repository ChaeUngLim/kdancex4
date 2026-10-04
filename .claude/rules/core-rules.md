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
- `docs/*.md` · `docs/guide/*.html` 등 프로젝트 설명 문서
- `_workspace/guides/SCH-XX(기능명).html` 왕초보 완벽분석가이드
- README, 기획/정책 문서
- 커밋 메시지 본문 · PR 설명 (상세는 「Git 커밋 / PR 설명」 절)
- 분량 있는 학습 주석 블록(`beginner-comment-style.md` 기준으로 쓴 문단급 주석)

**경로 선택 — 점수를 먼저 보고 결정한다**

파이프라인에서 돈이 드는 건 `humanize-monolith` 에이전트 하나뿐이다(호출당 약 92,000토큰). 점수 계산(`prepare_monolith_input.py`)과 게이트 검증(`verify_gates.py`)은 Python 스크립트라 **LLM을 쓰지 않는다**. 그러니 무료인 점수부터 돌리고 에이전트를 부를지 정한다.

1. 초안을 쓴 뒤 shim을 돌려 `risk_score`와 `route_hint`를 얻는다 (무료)
   ```
   python3 ${SKILL_ROOT}/scripts/prepare_monolith_input.py --run-dir _workspace/{run_id} --genre {genre}
   ```
2. **`risk_score` 0 → 에이전트를 부르지 않는다.** 스크립트가 지목한 패턴만 직접 고치고 `verify_gates.py`로 확인한다 (무료)
3. **`risk_score` 1 이상 → 에이전트를 부른다**
4. **사용자가 읽는 문서**(`docs/*`·가이드·README·정책 문서)는 **점수와 무관하게 에이전트를 부른다** — 분량이 있어 티가 쌓이고, 읽는 사람이 다르다
5. 두세 문장은 `humanizer-kr` 단독으로 갈음한다. 한 줄짜리는 생략한다

**왜 이렇게 바꿨나 (2026-09-20 실측)** — 커밋 메시지 6건을 전부 에이전트로 돌린 결과 변경률이 0.0%·0.9%·1.3%·2.9%·3.7%·5.2%였다. 한 건은 고칠 게 하나도 없는 no-op였다. 초안을 규칙대로 쓰면 이미 대부분 걸러지기 때문이다. 반면 일부러 번역투를 심은 테스트(`risk_score` 1)는 13.3%가 나왔다 — **점수가 실제로 예측력이 있다.** 이 규칙이었다면 그날 8회 중 6회를 건너뛰어 약 55만 토큰이 남았다.

**윤문하지 않는 것** — 코드 식별자, 수치·테스트 결과·명령어·파일 경로·고유명사, 코드 블록, frontmatter, 링크, 영어 원문. **에이전트용 `.md` 문서(`_workspace/guides/SCH-XX(기능명).md`)도 제외한다** — 독자가 사람이 아니라 AI 에이전트이고, 문체보다 정확성이 우선이다. 스킬의 Do-NOT 대상이라 보통 변형되지 않지만 결과에서 한 번 더 확인한다.

**의미 보존이 문체보다 우선한다.** 윤문 후 원문과 대조해 수치·사실·주장이 바뀌지 않았는지 확인하고, 바뀐 문장은 원문으로 되돌린다.

### 식별자·용어 표기 통일

**번호나 코드만 단독으로 쓰지 않는다.** SCH·Task(`T1~`)·Phase·화면 ID·리스크(`R1~`)·미해결 질문(`Q1~`) 등 이 프로젝트가 쓰는 모든 식별자는 `식별자(핵심 기능)` 형태로 쓴다. 번호만으로는 그게 뭘 가리키는지 알 수 없어서, 문서를 처음 읽는 사람이 매번 정의부로 되돌아가야 한다.

| 이렇게 쓰지 않는다 | 이렇게 쓴다 |
|---|---|
| `SCH-04` | `SCH-04(어댑터 3종: PG/알림/슬롯락)` |
| `T3` | `T3(리다이렉트 브릿지 엔드포인트)` |
| `Phase 9.5` | `Phase 9.5(학습 주석 재구성·SCH 가이드 생성)` |
| `의존: T2~T5` | `의존: T2~T5(딥링크 생성 ~ 입금 확인 폴링)` |
| `R2` | `R2(Prisma 8 트랜잭션·행 잠금 미검증)` |
| `Q1` | `Q1(기존 backend 처리 방식)` |

- 괄호 안 기능명은 그 식별자의 **공식 한 줄 설명**을 쓴다 — SCH는 `_workspace/SCH_kdance.html`, Task는 해당 문서의 헤딩에서 가져온다. 새로 지어내지 않는다. 길면 핵심만 줄이되, 같은 식별자는 프로젝트 전체에서 같은 축약을 쓴다.
- **같은 섹션·같은 문단 안에서 반복**할 때는 번호만 써도 된다. 매번 괄호를 붙이면 오히려 읽기 어렵다. 새 섹션·새 파일·새 주석 블록에서는 다시 붙인다.
- **헤딩이 곧 정의인 자리**(`### T3. 리다이렉트 브릿지 엔드포인트`)는 이미 설명이 붙어 있으므로 괄호를 겹쳐 쓰지 않는다.
- **치환 전 실제 용례를 눈으로 확인한다.** 식별자처럼 보여도 다른 의미인 경우가 있다 — 실측 사례: `참가신청 D-12`·`수강권 D-18 소멸`은 화면 ID가 아니라 디데이였고, 어떤 문장의 `Phase 5`는 "번호만 쓰지 말라"는 규칙을 설명하려고 인용한 나쁜 예시였다. 버전 번호·좌표·기간 표기도 같은 함정이다. 정규식으로 찾은 결과를 그대로 치환하지 않는다.
- **괄호가 이미 있다고 기능명인 것은 아니다.** `SCH-01(1회 테스트)+SCH-03(50회 테스트)`의 괄호는 테스트 개수이고, CSS의 `D2Coding`은 폰트 이름이다. 괄호 안 내용이 무엇을 뜻하는지 확인하고, 수량·단위라면 단위를 붙여 기능명과 구분되게 쓴다.
- **다이어그램 노드 레이블은 건드리지 않는다.** Mermaid 레이블(`A_PG["PG 어댑터 · payment_gateway.py · 완료 SCH-04"]`)은 레이블 자체가 이미 기능 설명이고, 괄호를 넣으면 파싱이 깨질 수 있다.

**영문 용어는 `영문(한글)`로 병기한다** — 처음 나올 때 한 번이면 된다. 예: `deeplink(딥링크)`, `webhook(웹훅)`, `idempotency key(멱등키)`. 이미 한국어로 굳은 말(로그인·서버·테스트)은 병기하지 않는다. 한글이 먼저 나오는 게 자연스러운 자리에서는 `멱등키(idempotency key)`처럼 순서를 뒤집어도 된다 — 기준은 "읽는 사람이 무엇을 먼저 알아야 하는가"다.

**적용 범위는 「AI 티 제거」 절과 같다** — docs 문서, SCH 가이드, README, 커밋 메시지, 학습 주석 전부.

## 4계층 역할 정의 (2026-09-21 확정)

> 근거와 대안 검토는 `docs/planning/role-split-analysis.md`.

**「Harness」를 계층 이름으로 쓰지 않는다.** 이 단어가 두 가지를 가리켜 왔다 —
①`kdance-dev-harness` 스킬(9단계 파이프라인) ②CLAUDE.md·rules·hooks·permissions·MCP 로
이루어진 작업 환경. 같은 이름이라 경계 분쟁이 반복됐다(2026-09-21 한 세션에서 3회).
이제 계층은 아래 네 이름으로만 부르고, "Harness" 는 스킬 이름으로만 남긴다.

| 계층 | 이름 | 한 줄 | 실체 |
|---|---|---|---|
| 0 | **환경(Environment)** | AI 가 일할 작업장을 만든다 | `CLAUDE.md` · `.claude/rules/` · hooks · permissions · MCP 구성 |
| 1 | **명세(Spec)** | 무엇을 **왜** 만드나 | `/speckit-specify` → `specs/{번호}-{기능명}/spec.md` |
| 2 | **파이프라인(Pipeline)** | 무엇을 **어떤 순서로** | `kdance-dev-harness` Phase 1~9.5 + `kdance-*` 에이전트 |
| 3 | **공구(Toolbox)** | 어떻게 **제대로** | ECC 에이전트·스킬 |

### 경계 분쟁은 이 한 줄로 끝낸다 — 「코드를 보는가」

| 계층 | 코드를 | 왜 |
|---|---|---|
| **명세** | **안 본다**(봐서도 안 된다) | 구현에 오염되면 "지금 있는 것" 에 맞춰 요구사항을 깎게 된다 |
| **파이프라인** | **본다** | Phase 2(기존 코드 구조 확인)가 명시적으로 코드를 조사한다 |
| **공구** | **고친다** | 실제 파일을 편집하는 유일한 주체 |
| **환경** | 코드를 **다루지 않는다** | 누가 무엇을 할 수 있는지의 규칙만 정한다 |

애매한 업무가 나오면 "그 일을 하려면 코드를 읽어야 하나" 를 먼저 묻는다.

**한 줄 태그라인** — `별명 · 한 줄 정의 : 일의 흐름` 순서로 읽는다.

- 🧱 **환경**(`CLAUDE.md`·rules·hooks·permissions·MCP) — "작업장 · AI가 안전하게 일할 자리를 만든다":
  어떤 규칙으로 일할지 → 어떤 도구(MCP)를 쓸지 → 무엇을 금지할지 → 어디서 멈춰 세울지
- 📐 **명세**(`/speckit-specify`) — "설계도 · 건축주의 요구서":
  무엇을 만들지 → 왜 만드는지 → 누가 쓰는지 → 무엇이 되면 성공인지. **코드를 모른 채 쓴다**
- 🏗 **파이프라인**(`kdance-dev-harness`) — "지휘자 · 프로젝트를 움직이는 두뇌":
  무엇을 만들지 → 어떻게 쪼갤지 → 어떤 Agent가 할지 → 어떤 순서로 할지 → 결과를 어떻게 합칠지
- 🛡 **공구**(ECC) — "수석 엔지니어 · 코드 품질을 지킨다":
  어떻게 구현할지 → 테스트 → 보안 → 리뷰 → 리팩터링 → 품질 검증
- 🧪 Playwright "실제 사용자가 되어 테스트" · 🧠 MindPilot "복잡한 시스템을 그림으로 이해" · 📚 Context7 "최신 공식 문서 확인" · 🗄 PostgreSQL MCP "DB 직접 확인/작업"

**이 넷만 계층이다.** Playwright·MindPilot·Visual Guide 등은 계층과 경쟁하지 않고 그 위에 얹히는 실행/설명 도구다.

> **이름만 바뀌었고 역할은 그대로다.** 기존 「Harness」의 5대 업무는 **파이프라인**이,
> 「ECC」의 6대 업무는 **공구**가 그대로 이어받는다. 태그라인의 일의 흐름도 원문 그대로다.
> 바뀐 것은 계층 이름 하나뿐이고, 새로 **드러낸** 것은 환경과 명세 두 자리다 —
> 둘 다 원래 있었는데 이름이 없어서 규칙이 다루지 못하던 것이다.

### 계층 0 · 환경 = AI Runtime / Governance Layer
핵심 질문: **"AI가 어떤 규칙과 권한으로 일하게 할까?"** 코드를 다루지 않는다. 대신 **다른 계층이 무엇을 할 수 있고 어디서 멈추는지**를 정한다.

**6대 업무**:
① **Rules** — 프로젝트 규칙과 행동 규칙(`CLAUDE.md`·`.claude/rules/`)
② **Context** — Claude가 항상 알아야 하는 것: 구조·스택·실행법·테스트법·DB 규칙·Git 규칙
③ **MCP 구성** — 어떤 서버를 연결하고 어떤 조건에서 쓸지. MCP 를 **누가 호출하느냐**는 계층 2·3이 정하지만, **무엇을 켤지**는 여기다
④ **Hooks** — 코드가 바뀌면 무엇이 자동으로 돌지(format → lint → typecheck → unit test → E2E)
⑤ **Permissions** — 허용 / 승인 필요 / 금지. 예: `production DB DROP` 금지, credential 출력 금지, secrets 커밋 금지
⑥ **Quality Gates** — "작업 완료"의 자동 판정 조건

> **⑥ Quality Gates 는 2026-09-21 에 이 계층으로 올렸다.** 그 전에는 어느 계층 일인지 규칙에 없었다. 실측 결과 이 프로젝트에는 **품질 게이트 훅이 하나도 없다** — `.claude/settings.json` 에 graphify 훅 2개뿐이고 전역 훅은 0개다. 즉 지금은 Phase 6(테스트)이 "불러야" 돌고, 코드가 바뀔 때 **자동으로 막아서는 장치가 없다.**
>
> **설치는 검증선을 고친 뒤에 한다.** admin-web 의 `npm run lint` 가 깨져 있고 DB 컨테이너가 미기동이라, 지금 훅을 걸면 정상 작업까지 매번 막힌다. 순서를 지킨다.

### 계층 1 · 명세 = Spec-Driven Layer
핵심 질문: **"무엇을 왜 만드나?"** **코드를 보지 않는다.** 보면 "지금 있는 것"에 맞춰 요구사항을 깎게 된다.

**산출물**: `specs/{번호}-{기능명}/spec.md` — user story(P1~P3) · 수용 기준 · edge case · **측정 가능한 성공 기준** · 비기능 요구사항.

**이 계층이 제품 요구사항의 단일 진실 원천(SSOT)이다.** 기능을 무엇으로 정했는지 다투면 여기를 본다.

### 계층 2 · 파이프라인 = Agent Orchestration Layer
핵심 질문: **"이 큰 작업을 누구에게 어떤 순서로 시킬까?"** 코드를 **읽지만 고치지는 않는다** — 고치는 것은 공구(ECC)의 일이다.

**5대 업무** (kdance-dev-harness Phase 매핑):
① 요구사항 → 작업 분해 (Phase 1~3) — 예: 예약 기능 → DB Schema/Backend API/Service/Payment/Notification/Next.js/React Native/Admin/E2E
② Agent Team 구성·역할 배정 (Phase 4) — DB/Backend/Frontend/Payment/Notification/AI/QA Agent
③ 작업 의존성 관리 (Phase 4) — 예: DB 완료 → Backend 완료 → Frontend 구현 → Integration → E2E
④ 병렬 작업 — 의존성 없는 작업끼리 동시 진행(예: DB 완료 후 Frontend와 Admin UI를 동시에)
⑤ Agent 결과 취합 (Phase 5~9.5) — 각 Agent 산출물을 하나의 기능으로 통합, 학습 주석/가이드까지 포함

### 계층 3 · 공구(ECC) = Software Engineering Quality Layer
핵심 질문: **"이 코드를 어떻게 하면 제대로 만들 수 있지?"**

**6대 업무**: ① TDD(요구사항→Test→Implementation→Test→Refactor, "테스트부터 제대로 작성했나?") ② Code Review(버그/중복/복잡도/유지보수성/설계 문제) ③ Security — **예약·결제가 있는 이 프로젝트에서 특히 중요**(인증/권한/입력 검증/민감정보/API 보호/Webhook 검증/결제 위변조) ④ Refactoring(거대 파일을 Service/Repository/Domain/Validator/DTO 등으로 분리) ⑤ Coding Standard(Python: FastAPI/SQLAlchemy2/Pydantic, TypeScript: Next.js/React Native) ⑥ 테스트 품질(Unit/Integration/Security/Regression) — 단 **실제 브라우저 E2E 실행은 Playwright가 담당**(ECC는 품질 기준만).

실행 수단: 전문 Agent, Skills, Hooks, Rules(`ecc:fastapi-patterns`, `ecc:python-patterns`, `ecc:python-testing`, `ecc:security-reviewer`, `ecc:refactor-clean`, `code-review`, `ecc:build-fix` 등)로 코드 탐색·파일 수정·테스트 실행·Git 작업·의존성 확인·디버깅·리팩터링을 실제로 수행한다. **ECC의 방대한 스킬(387개+)을 전부 연결하려 하지 않는다** — 위 6대 업무 중심으로만 쓰고, 이 프로젝트와 무관한 스킬(마케팅/브랜딩/네트워크/블록체인 등)은 필요할 때만 개별적으로 고른다. 파이프라인도 마찬가지로 위 5대 업무(Feature Planning/Task Decomposition/Agent Assignment/Dependency/Parallelization/Integration)에만 집중한다.

**호출 주체를 비워 두지 않는다.** ECC 는 스스로 나서지 않는다 — Phase 6(테스트)이 `ecc:*-test`·`ecc:e2e-runner` 를, Phase 8(코드 리뷰)이 `ecc:code-reviewer`·`ecc:security-reviewer` 를 부른다. "언제 누가 부르는가" 가 규칙에 없으면 ECC 는 공구상자가 아니라 방치된 창고가 된다.

#### ECC 의 계획 스킬은 「구현 계획」에만 쓴다

ECC 에는 계획 도구가 여럿 깔려 있다 — `ecc:planner` · `ecc:architect` · `ecc:plan` · `ecc:plan-prd` · `ecc:plan-canvas` · `ecc:prp-plan` · `ecc:plan-orchestrate`. **이것들로 제품 계획이나 Task 체계를 새로 만들지 않는다.** 만들면 파이프라인의 Phase 3·4 와 겹쳐 "어느 계획이 맞나" 가 생긴다.

| 이렇게 쓰지 않는다 | 이렇게 쓴다 |
|---|---|
| 사용자 요구사항 → `ecc:planner` → ECC Task → 구현 | 명세 → Phase 3·4 → **Task 하나를 받아** `ecc:planner` → 구현 전략 검토 → 구현 |

**받는 단위는 Task 하나다.** 예를 들어 Phase 4 가 낸 `T005(추천 API)` 를 받아 — 어떤 service 로 분리할지, repository 패턴을 쓸지, 트랜잭션이 필요한지, 캐싱이 필요한지, 에러 처리와 테스트 전략은 무엇인지를 검토한다. 이건 **구현 계획**이고, 제품 계획이 아니다.

`ecc:architect` 도 같다 — 시스템 경계는 Phase 3 가 정하고, ECC 는 그 안의 **모듈 분리**를 본다(「역할 충돌 방지 매트릭스」의 SDD 행이 🟢 둘인 이유).

### 표준 실행 파이프라인
```
🧱 환경 — 규칙·권한·MCP 가 이미 깔려 있다 (상시)
   ↓
👤 사람 — "이 기능 만들어줘"
   ↓
📐 명세 — /speckit-specify → spec.md  ("무엇을 왜", 코드를 안 본다)
   ↓ 인계
🏗 파이프라인 ① 슬라이스 절단 + 요구사항 분석 (Phase 1)
   ↓
🏗 ② 기존 코드 구조 확인 (Phase 2)   ← 여기서 처음 코드를 본다
   ↓
🏗 ③ 구현 계획 = SDD (Phase 3)  → 설계 산출물 4종
   ↓
🏗 ④ Task 분리 — User Story 단위 수직 슬라이스 (Phase 4)
   ↓
🛡 ⑤ 구현 — 공구(ECC)로 (Phase 5, 병렬 팬아웃 가능)
   ↓
🛡 ⑥ 테스트 → 오류 수정 ↔ 코드 리뷰 (Phase 6·7·8)
   ↓
🧪 ⑦ Playwright — E2E 검증 (`ecc:e2e-runner`/`mcp__playwright`)
   ↓
🏗 ⑧ 완료 검증 (Phase 9)
   ↓
🏗 ⑨ 학습 산출물 3종 + SCH 갱신 (Phase 9.5)
   ↓
✅ 완료
```
한 줄 요약: **"명세가 무엇을 왜, 파이프라인이 어떤 순서로, 공구가 어떻게 제대로."**

kdance-implementer/test-runner/bug-fixer/code-reviewer 등 각 Phase 에이전트는 파이프라인이 배정한 "무엇을·누구에게·어떤 순서로"를 받아 ECC의 스킬/에이전트/MCP로 "어떻게 잘"을 실행한다 — 이 둘을 섞어서 하나가 다 하지 않는다.

**절대 금지 패턴**: 둘 이상의 계층이 각자 독립적으로 `Plan → Implement → Test → Review` 전체를 도는 구조는 만들지 않는다. **파이프라인은 하나뿐이다.** `Spec Kit → Plan` 과 `파이프라인 → Plan` 이 동시에 존재하면 "어느 계획이 맞나" 가 생긴다. 이것이 spec-kit 의 `plan`·`tasks`·`implement`·`analyze`·`converge` 를 쓰지 않는 유일한 이유다.

예외: 서브에이전트가 세션 한도(rate limit) 등으로 중단되어 이미 끝난 작업의 상태만 확인·정리해야 할 때, 또는 파일 몇 줄 수준의 사소한 마무리는 오케스트레이터가 직접 처리해도 된다 — 다만 이건 예외이지 기본 동작이 아니다.

### 역할 충돌 방지 매트릭스
🟢 주 역할 / 🟡 보조 / ⚪ 맡기지 않음 — 애매한 업무가 나오면 이 표로 판단한다.

| 업무 | 🧱 환경 | 📐 명세 | 🏗 파이프라인 | 🛡 공구(ECC) |
|---|---|---|---|---|
| Rules · Context · MCP 구성 · Permissions | 🟢 | ⚪ | ⚪ | ⚪ |
| **Hooks · Quality Gates**(자동 실행·통과 강제) | 🟢 | ⚪ | 🟡 | 🟡(기준 제공) |
| 사용자 시나리오 · 수용 기준 · 성공 지표 | ⚪ | 🟢 | 🟡(번역) | ⚪ |
| 슬라이스 절단(이번 회차 범위) | ⚪ | ⚪ | 🟢 | ⚪ |
| 요구사항 분석(코드에 비춘) | ⚪ | ⚪ | 🟢 | ⚪ |
| 기존 코드 구조 조사 | ⚪ | ⚪ | 🟢 | 🟡 |
| **시스템 설계(SDD)** | ⚪ | ⚪ | 🟢(시스템 관점) | 🟢(코드 관점) |
| Task 분해 · 의존성 · 병렬 배정 | ⚪ | ⚪ | 🟢 | ⚪ |
| 코드 작성 | ⚪ | ⚪ | 🟡(배정만) | 🟢 |
| **테스트 — 무엇을 만족해야 하나**(수용 기준) | ⚪ | 🟢 | 🟡(번역) | ⚪ |
| **테스트 — 어떻게 테스트하나**(작성) | ⚪ | ⚪ | ⚪ | 🟢 |
| **테스트 — 언제 강제하나**(게이트) | 🟢 | ⚪ | 🟡 | ⚪ |
| **보안 — 무엇을 지켜야 하나**(요구사항) | ⚪ | 🟢 | ⚪ | ⚪ |
| **보안 — 어떻게 구현·검사하나** | ⚪ | ⚪ | ⚪ | 🟢 |
| **보안 — 무엇을 아예 막나**(권한·차단) | 🟢 | ⚪ | ⚪ | ⚪ |
| TDD / Code Review / Refactoring / Coding Standard | ⚪ | ⚪ | ⚪ | 🟢 |
| Integration Test / Build 오류 | ⚪ | ⚪ | 🟡 | 🟢 |
| E2E | ⚪ | ⚪ | ⚪ | 🟡(작성 — 실행은 Playwright) |
| **제품 계획 · Task 체계 생성** | ⚪ | 🟡(무엇을) | 🟢 | ⚪ **ECC 계획 스킬 금지** |
| **구현 계획**(Task 하나의 service·패턴·트랜잭션·캐싱) | ⚪ | ⚪ | ⚪ | 🟢 |
| 전체 프로젝트 상태 · 완료 판단 | ⚪ | ⚪ | 🟢 | 🟡 |
| **학습 산출물 3종 · SCH 추적** | ⚪ | ⚪ | 🟢 | ⚪ |

### 테스트와 보안은 세 계층이 나눠 맡는다

한 업무를 한 계층이 독점하지 않는 자리가 둘 있다. 질문이 다르기 때문이다.

**테스트**

| 계층 | 질문 | 무엇을 |
|---|---|---|
| 📐 명세 | **무엇을** 만족해야 하는가 | 수용 기준. 예: "회원 위치 5km 이내 + 시간 가능 + 선호 장르 일치" |
| 🛡 공구 | **어떻게** 테스트할 것인가 | 단위·통합·E2E 테스트 작성. 실제 브라우저 실행은 Playwright |
| 🧱 환경 | **언제** 돌리고 통과를 **어떻게 강제**하는가 | Hooks·Quality Gates |

**보안**

| 계층 | 질문 | 무엇을 |
|---|---|---|
| 📐 명세 | 무엇을 지켜야 하는가 | 보안 요구사항. 예: 개인정보 보호, 인증 필요, 민감정보 로그 금지 |
| 🛡 공구 | 어떻게 구현·검사하는가 | 입력 검증, 인증·권한, SQL 주입·XSS·프롬프트 주입 점검 |
| 🧱 환경 | 무엇을 아예 막는가 | secret 출력 금지, production DB 위험 명령 차단, secrets 커밋 차단 |

**공구가 테스트를 만들고, 환경이 그 테스트를 언제 강제할지 정한다.** 둘을 한 계층에 두면 "테스트는 썼는데 아무도 안 돌린다" 가 된다.

### 비유로 이해하기
- **건축**: 환경 = 공사장과 안전 규정 · 명세 = 건축주가 원하는 집 · 파이프라인 = 현장소장 · 공구(ECC) = 기술자와 연장.
- **사람 역할**: 사용자 = Product Owner, 명세 = 기획자, 파이프라인 = Tech Lead/PM, 각 `kdance-*` 에이전트 = 개발자, ECC = Senior Engineer + QA 체계, Playwright = 실제 사용자 테스트 담당.
- **왜 혼자 개발할 때 특히 중요한가**: 사람 팀이면 "DB 담당·프론트 담당·결제 담당·QA 담당"으로 저절로 역할이 나뉘지만, 혼자 Claude Code로 개발할 때는 그 역할 분담을 파이프라인이 대신 해줘야 한다.

### 프로젝트 규모가 커질 때 — 팀 단위 조직
kdance는 예약 취소/환불 슬라이스를 넘어 수업·결제·캘린더·알림·학원·공지·대회·파티·뉴스·관리자·비용관리·PDF/이미지 등록·AI 검색·추천까지 넓어질 예정이다(`docs/*` 기획 문서 참고). 이 규모에서는 Task를 개별 나열하지 않고 **팀 단위**로 먼저 묶는다(파이프라인 Phase 3~4가 결정, 팀 내부 실행은 여전히 공구(ECC)에 위임):
- **Frontend Team**: Android(mobile), Next.js(admin-web), Admin — ECC 기준: TDD/Review/Refactor
- **Backend Team**: API, Auth, Reservation, Notification — ECC 기준: Security/API Review/DB Review
- **Data Team**: PostgreSQL, pgvector(`CLAUDE.md`의 Backend DB와 동일)
- **AI Team**: Search, RAG, Recommendation, Agent — ECC 기준: Evaluation/Prompt Review/RAG Test
- **QA Team**: Unit, Integration, E2E — 위 세 팀의 결과가 전부 여기로 수렴

### MCP 도구 — 어느 계층이 부르나
파이프라인과 공구(ECC) 둘 다 아래 MCP를 호출한다. MCP를 직접 고르지 않고 **어느 계층의 일이냐**로 자동으로 정해진다. MCP **구성**(어느 서버를 켤지, 무엇을 금지할지)은 환경 계층의 몫이다:
- `mcp__context7__*` 문서 · `mcp__postgres-kdance__*` DB 작업 · `mcp__playwright__*` E2E · `mcp__mindpilot__*` 구조도 시각화 **실행 도구** · `mcp__plugin_ecc_chrome-devtools__*` 브라우저 · claude-mem `mem-search` 스킬(플러그인 MCP `mcp-search`) 세션 간 기억 검색 — memory MCP(지식 그래프)는 2026-09-23 삭제, 근거는 `CLAUDE-decisions.md` ADR-001 · `mcp__figma__*` Figma 공식 원격 MCP(2026-09-30 추가, user 범위, OAuth — 이 터미널에서 `/mcp` 인증). 화면 프로토타입(`docs/prototype/`)을 Figma 캔버스로 올리거나 Figma 프레임에서 코드 컨텍스트를 읽을 때 쓴다

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
> 5. **OmniRoute 무료 모델 폴백 구성(영구 무료 + 최신 세대 + 용도에 맞는 카테고리만, 체험판/가입크레딧/구형/성격 안 맞는 모델은 전부 제외 — 상세는 `docs/guide/omniroute-setup.html`).** 위 2번 조건(Opus 소진)이 실제로 발동됐을 때 아래 구성을 따른다:
>    - **백엔드 4개는 순차 폴백 Combo**(`Free-fallback`, Strategy: Priority, 2026-09-18 실제 등록·테스트 완료): `kiro/claude-sonnet-4.5 → groq/qwen/qwen3.8-27b → gemini/gemini-3.8-flash → mistral/codestral-latest`. 작업 성격이 비슷해서 "제일 좋은 것부터, 막히면 다음"이 자연스럽다. (Kimi는 2026-09-18 재검토로 제외 — Groq가 서빙하던 Kimi K2 계열이 2026-03-23부로 지원 종료(deprecated)되어 `openai/gpt-oss-120b`로 대체된 것으로 확인돼, Groq 경유 접근 근거 자체가 무효화됨. Gemini 3.8 Flash는 공식 문서 기준 무료지만 하루 20건·분당 10건으로 한도가 매우 작음 — 순서는 유지하되 대량 작업 폴백으로는 기대하지 말 것)
>    - **프론트엔드 3개는 폴백이 아니라 역할별 직접 호출**: 화면 구조·상태관리 등 판단이 필요한 작업 → `kiro/claude-sonnet-4.5`(월 50회 한도라 아무 데나 먼저 쓰지 않음); 실제 컴포넌트/UI 코드 작성 **및 비슷한 화면 다수·일괄 스타일 같은 대량 반복** → `zai/glm-4.7-flash`(기본값 겸 물량 담당 — 만료 없는 영구 무료라 프론트엔드에서 볼륨을 받아낼 수 있는 유일한 모델); `gemini/gemini-3.8-flash`는 **예비(비상용)** — 하루 20건뿐이라 대량 작업에 쓸 수 없고 GLM이 막혔을 때 중요한 몇 건에만 쓴다. 지정한 모델의 한도가 막혔을 때만 안전망 Combo `fe-fallback`(`kiro/claude-sonnet-4.5 → zai/glm-4.7-flash → gemini/gemini-3.8-flash`, Priority, 아직 미생성)으로 대체한다.
>    - 3개월마다(다음: 2026-12-18) 클라우드 루틴이 이 구성의 최신성을 재검증한다 — 결과는 보고서만 남기고 자동 반영은 안 하므로, 다음 세션에서 사람이 확인 후 직접 반영한다.

**부가 계층(계층 0~3 위에 얹히는 것)**: 1) 도구 — 위 MCP 6종  2) UI — `frontend-design` + `ui-ux-pro-max` 스킬군(admin-web·mobile 화면 작업)  3) 왕초보 설명 계층 — SCH별 학습 주석(`beginner-comment-style.md`) + 왕초보 완벽분석가이드(`sch-guide-template.md`, `_workspace/guides/SCH-XX(기능명).html`) + **진행 리뷰(`docs/Review.md`)** + MindPilot  4) 에이전트 설명 계층 — 스택 개요(`docs/agent/ai-coding-agent.html`) + SCH별 버전 맞춤 문서(`agent-sch-doc-template.md`, `_workspace/guides/SCH-XX(기능명).md`). 3번은 사람이, 4번은 에이전트가 읽는다.

설명 계층(3·4번)은 계층 0~3이 끝난 결과를 설명만 할 뿐, 의사결정에 관여하지 않는다 — Visual Guide Skill과 MindPilot은 파이프라인·공구와 경쟁·대체 관계가 아니라 그 위에 얹는 부가 도구다.

전체 그림(다이어그램 중심 설명)은 `docs/guide/harness-ecc-guide.html` 참고.

**설치된 범용 `harness:harness` 메타스킬(harness-marketplace 플러그인)과 절대 혼동하지 않는다.** 이 메타스킬은 새 도메인에 처음부터 하네스를 만들어주는 범용 도구이고, "하네스 점검/감사/현황/에이전트-스킬 동기화" 같은 문구에 트리거된다. kdance는 이미 `kdance-dev-harness`가 만들어져 있고 Phase 9.5(학습 주석 재구성·SCH 가이드 생성)·SCH 표기 규칙·beginner-comment-style.md 등 이 프로젝트 전용으로 커스터마이징돼 있다 — 범용 메타스킬은 이 커스터마이징을 모른 채 자기 템플릿으로 재구성하려 들 수 있으므로, kdance에서 하네스를 점검·수정·확장할 때는 **범용 `harness:harness`를 호출하지 말고 `.claude/skills/kdance-dev-harness/`와 `.claude/agents/kdance-*.md`를 직접 Read/Edit한다.**

## spec-kit 과의 역할 분리 (2026-09-21 확정, 같은 날 축소)

GitHub spec-kit 의 `specify → plan → tasks → implement → analyze → converge` 는
`kdance-dev-harness` 의 9단계와 거의 같은 일을 한다. 그대로 두면 **파이프라인이 둘**이
되어 「4계층 역할 정의」의 **절대 금지 패턴**에 그대로 걸린다.

그래서 **맨 앞 하나만 쓴다.**

### 쓰는 것 — 1개

| 스킬 | 무엇 |
|---|---|
| `/speckit-specify` | 기능 명세. user story(P1~P3) · edge case · **측정 가능한 성공 기준** |

### 쓰지 않는 것 — 9개

| 스킬 | 왜 안 쓰나 |
|---|---|
| `/speckit-clarify` | **사용자가 현장에 있다.** clarify 는 답할 사람이 없을 때 spec 을 심문하는 도구다. 직접 물으면 더 빠르고 정확하다 — 실측: Q1(대학생 인증)·Q2(정원 기준)·Q3(강사 정산)를 몇 분 만에 확정했다 |
| `/speckit-checklist` | `/speckit-specify` 가 이미 `checklists/requirements.md` 를 낸다 |
| `/speckit-constitution` | `core-rules.md` 가 그 자리다. 실행하면 규칙 원본이 둘로 갈라진다 |
| `/speckit-plan` | Phase 3(구현 계획)과 중복 — **단 산출물 규격은 빌려 온다**(아래 참고) |
| `/speckit-tasks` | Phase 4(Task 분리)와 중복 — **단 US 단위 묶기는 빌려 온다** |
| `/speckit-implement` | Phase 5(구현)와 중복 |
| `/speckit-analyze` | Phase 8(코드 리뷰)과 중복 |
| `/speckit-converge` | Phase 9(완료 검증)와 중복 |
| `/speckit-taskstoissues` | 이 프로젝트는 GitHub 이슈로 작업을 관리하지 않는다 |

### 도구는 안 쓰되 규격은 빌려 온다

`speckit-plan`·`speckit-tasks` 의 **템플릿이 우리 Phase 3·4 보다 낫다.** 그래서 도구를
갈아타는 대신 산출물 규격만 올렸다(근거: `docs/planning/role-split-analysis.md` §4-1).

| Phase | 빌려 온 것 |
|---|---|
| **Phase 3(구현 계획)** | 산출물을 **4종으로 분리** — `plan.md`(요약·결정) · `data-model.md`(엔티티·제약) · `contracts/`(API 계약) · `research.md`(미확정 조사). 「공유 계약 §N」 번호 체계는 그대로 유지한다 |
| **Phase 4(Task 분리)** | **User Story 단위 수직 슬라이스.** P1 만 구현해도 굴러가야 한다. `[P]` 병렬 마커, MVP-first 절 |

### 인계 지점

`specs/{번호}-{기능명}/spec.md` 가 **Phase 1(요구사항 분석)의 입력**이 된다. Phase 1 은
그 spec 을 다시 쓰지 않고 kdance 고유의 것으로 **번역**한다.

| Phase 1 이 spec 에 더하는 것 |
|---|
| **슬라이스 절단** — spec 전체 중 이번 회차 범위와 그 근거 |
| 버전 정책·검증선 제약 (`next build` 로 검증한다 등) |
| 수용 기준을 실행 가능한 명령과 기대 결과로 |
| 리스크(`R1~`)와 미해결 질문(`Q1~`) |
| SCH 대응 관계 |

**spec 전체를 한 번에 넘기지 않는다.** kdance 의 spec 은 FR 205개(하위 번호 포함, 2026-09-24) 규모라 통째로는 어느
Phase 도 삼킬 수 없다. Phase 1 의 첫 일이 **어디를 자를지 정하는 것**이다.

spec 이 없으면 Phase 1 은 기존대로 처음부터 분석한다 — spec-kit 사용은 선택이다.

### 왜 이렇게 나눴나

spec-kit 의 강점은 **"무엇을 왜"를 사용자 시나리오로 풀어내는 템플릿**이다. 파이프라인의
강점은 Phase 2(기존 코드 구조 확인)·Phase 6~8(테스트·수정·리뷰)·Phase 9.5(학습 산출물
3종과 SCH 추적)이며, **spec-kit 에는 이 넷이 아예 없다.** 단계 수로 보면 파이프라인이
spec-kit 의 상위집합이다 — spec-kit 에만 있고 파이프라인에 없는 단계는 하나도 없다.

## 진행 리뷰 (`docs/Review.md`) — 핵심 기능

**이 프로젝트의 핵심 산출물 중 하나다.** 코드가 아니라 **배움**이 결과물인 자리다.

기존 두 산출물은 **끝난 것**을 설명한다 — 소스 학습 주석은 "이 파일이 무엇인지",
SCH 가이드는 "그 작업이 어떻게 끝났는지". 정작 배우는 데 가장 중요한
**"그때 무엇이 막혔고 왜 그 길을 골랐나"** 는 어디에도 남지 않는다. Review 가 그 자리다.

독자는 다른 두 문서와 같다 — 개발 경력 6개월차 비전공자. 바둑의 **지도바둑**처럼,
매 수마다 "왜 이 수인지"를 옆에서 설명해 주는 방식으로 쓴다.

### 언제 쓰나

**그날 일은 그날 적는다.** 작업이 끝난 뒤 몰아서 쓰지 않는다 — 결말을 알고 쓰면
헤맨 과정이 지워지고, 그 과정이 이 문서의 값어치 전부다.

갱신 시점은 둘이다.

| 시점 | 무엇을 적나 |
|---|---|
| **일별** | 그날 한 일·판단·막힌 것. 날짜 섹션을 새로 연다 |
| **SCH 완료 시** | Phase 9.5(학습 주석 재구성·SCH 가이드 생성)와 같은 시점에 2부 표에 한 줄 추가 |

### 구성 (문서의 「읽는 법」과 동일)

1부 일별 진행 · 2부 SCH별 정리 · 3부 개념 사전. 각 날짜는 **한 줄 → 무엇을 했나 →
개념 → 판단과 이슈** 순으로 적는다.

### 작성 원칙

- **막힌 것을 지우지 않는다.** 되돌린 시도, 틀린 판단, 잘못된 검증 전부 남긴다.
  실패 기록이 성공 기록보다 가르치는 게 많다
- **처음 나온 용어는 그 자리에서 푼다.** 그리고 3부 개념 사전에 한 줄로 올린다.
  영문 용어는 `영문(한글)` 병기(「식별자·용어 표기 통일」과 동일)
- **근거를 댄다.** 커밋 해시·파일 경로·실행 결과. 기억으로 쓰지 않는다
  (「Investigation & Accuracy」와 동일)
- **과장하지 않는다.** 안 된 것은 안 됐다고, 확인 안 한 것은 확인 안 했다고 적는다
- **식별자는 번호만 쓰지 않는다** — `SCH-04(어댑터 3종)` 형식
- **윤문 대상이다** — 사용자가 읽는 문서이므로 「AI 티 제거」 절을 따른다

## Git 커밋 / PR 설명 (왕초보 + 면접담당자 기준)
- 커밋 메시지와 PR 설명은 **두 종류의 독자** 모두가 읽고 이해할 수 있게 쓴다: ① 개발 경력 6개월차 비전공자(무엇을 왜 바꿨는지 개념부터 이해해야 함) ② 면접담당자/리뷰어(짧은 시간에 구조와 흐름, 판단력을 파악해야 함). 두 독자 모두 **장황한 나열보다 핵심만 정돈된 글**을 원한다 — 있었던 일을 전부 적지 말고, 그 커밋에서 가장 중요한 판단 1~2가지로 압축한다.
- 제목 줄은 기존 conventional commit 스타일(`feat:`/`fix:`/`chore:` 등, 이 저장소의 기존 로그 관례)을 유지하되 **한 줄만 보고도 무엇을 왜 했는지 알 수 있어야** 한다.
- 본문은 다음 4가지만 담고, 각 항목은 1~3문장으로 압축한다(더 길어지면 정말 중요한 것만 남기고 나머지는 뺀다):
  1. **무엇을, 왜** — 전문 용어는 처음 등장할 때 괄호로 짧게 풀이. "왜 이 방식을 택했는지"의 핵심 판단 1가지를 반드시 포함(면접담당자가 가장 궁금해하는 부분).
  2. **SCH 참조** (있다면) — 번호만 쓰지 않고 `SCH-04(어댑터 3종: PG/알림/슬롯락)`처럼 기능명을 붙인다(`beginner-comment-style.md`의 "SCH 표기 규칙"과 동일 기조).
  3. **검증** — 실행한 테스트와 결과를 한 줄로(예: `pytest 159 passed`). 알려진 제한/미해결이 있다면 과장 없이 한 줄로.
  4. **가이드 링크** (있다면) — 해당 SCH의 왕초보 가이드(`_workspace/guides/SCH-XX(기능명).html`) 경로.
- **커밋·푸시 전에 본문을 윤문한다 — 「AI 티 제거」 절의 필수 단계가 커밋 메시지·PR 설명에도 그대로 적용된다.** 위 4항목을 갖춰 초안을 쓰고, 스킬에 통과시킨 결과를 최종본으로 쓴다. 스킬이 내용 앵커를 보존하므로 4항목의 정보는 그대로 남는다.
  - **제목 줄은 윤문 대상이 아니다** — conventional commit 형식이 고정돼 있다.
  - 본문이 3문장 이상일 때만 적용한다. 한 줄 커밋은 생략.
  - **커밋 메시지는 「AI 티 제거」 절의 점수 분기를 그대로 따른다** — shim을 돌려 `risk_score` 0이면 에이전트를 부르지 않고 지목된 패턴만 직접 고친다. 실측상 커밋 본문은 거의 항상 0이 나온다(2026-09-20: 6건 중 6건).
- 하나의 커밋에 여러 변경을 욱여넣지 않는다 — 커밋을 나누는 기준 자체가 "면접담당자가 커밋 로그만 훑어도 작업 흐름이 보이는가"다. 논리적 단위(기능/SCH/계층)로 나눠서 커밋한다.
- Git 작업(커밋/푸시)은 여전히 **사용자가 명시적으로 요청할 때만** 수행한다 — 이 규칙은 "쓸 때의 문체"만 정하고 "언제 커밋할지"는 바꾸지 않는다.

## 버전 정책 (2026-09-20 확정)

**호환되는 선에서 최신을 쓴다.** "최신"과 "의존성 호환"이 충돌하면 **호환이 이긴다.**

확정된 버전표는 `docs/planning/kdancex4_service_definition_and_tech_stack.md` 의
「11. 기술 스택 고정표」다. 버전을 말하거나 문서에 적을 때는 **거기를 먼저 본다.**

### 버전을 추정하지 않는다

기억으로 버전을 쓰지 않는다. 학습 시점 이후에 나온 버전이 항상 있다. 실제 파일이나
레지스트리에서 읽는다.

| 무엇 | 어디서 |
|---|---|
| 설치된 JS 패키지 | `admin-web/package.json` · `mobile/package.json` |
| Expo 가 고정한 RN 버전 | `mobile/node_modules/expo/bundledNativeModules.json` |
| npm 최신 | `npm view <pkg> version` · 라인 내 최신은 `npm view <pkg>@<major.minor> version` |
| 안정판 vs RC 구분 | `npm view <pkg> dist-tags` — `latest` 가 RC 를 가리키는 경우가 있다 |
| 호환 범위 | `npm view <pkg>@<ver> peerDependencies` |
| DB·컨테이너 | `infra/docker-compose.yml` 의 이미지 태그 |

### 실측으로 확인한 함정 2가지

- **패키지 이름이 바뀌기도 한다.** Prisma 8 의 런타임은 `@prisma/client` 가 아니라
  `@prisma/orm-postgres` 다. 옛 이름만 조회하고 "해당 버전이 없다"고 결론짓지 않는다.
  없다고 판단하기 전에 그 메이저가 패키지를 재편했는지 확인한다.
- **`optional: true` 는 "아무 버전이나"가 아니다.** "없어도 된다"는 뜻일 뿐이라, 그 패키지가
  실제로 설치돼 있으면 npm 이 범위를 검사해 `ERESOLVE` 로 **설치를 막는다.** 실측: prisma 8 이
  깔린 상태에서 `npm install better-auth@1.7.5` 가 거부됐다(peer `^5 || ^6 || ^7`).
  `--legacy-peer-deps` 는 peer 검증을 통째로 끄므로 쓰지 않는다. `package.json` 의
  `overrides` 로 해당 항목 하나만 덮어쓴다 — 예: `"overrides": {"better-auth": {"prisma": "$prisma"}}`.
  기록이 `package.json` 에 남아 다른 PC·CI 에서도 동작한다.

### 올리기 전에

1. 그 패키지를 고정하는 상위 패키지가 있는지 먼저 본다(Expo · 프레임워크 · 메타패키지).
2. `peerDependencies` 로 표 안의 다른 항목과 충돌하는지 본다.
3. 메이저가 올라가면 패키지 이름·API 재편 여부를 확인한다.
4. 깨져 있는 검증선과 겹치지 않게 순서를 나눈다 — 한 번에 둘을 건드리면 원인 분리가 안 된다.
5. 올린 뒤 실제로 돌려 본다. 레지스트리 조회만으로 "된다"고 하지 않는다.

**미검증 항목은 미검증이라고 적는다.** 확정표의 「11-2. 알려진 위험」에 상태를 남긴다.

### 에이전트용 버전 맞춤 문서

에이전트의 학습 데이터에는 구버전 API 가 들어 있다. 적어 두지 않으면 우리 코드를 옛
방식으로 되돌린다 — Prisma 8 의 계약 기반 접근을 `new PrismaClient()` 로, AI SDK 7 의
agent 루프를 6 구조로, `@prisma/orm-postgres` 를 `@prisma/client` 오타로 보고 "고친다".

Next.js 16.3 이 `node_modules/next/dist/docs/` 와 `AGENTS.md` 를 깔아 주는 이유가 같다 —
에이전트가 학습 데이터 대신 **설치된 버전의 문서**를 읽게 만드는 것. 같은 방식을 이
프로젝트 소스에 적용한다.

| 문서 | 무엇 |
|---|---|
| `docs/agent/ai-coding-agent.html` | 스택 전체 개요. 최신에서만 되는 것, 그 대가, 버전 확인 방법. 항목마다 **실측 / 미검증** 을 표시한다 |
| `.claude/skills/kdance-dev-harness/references/agent-sch-doc-template.md` | SCH 단위 `.md` 문서 표준. 산출물은 `_workspace/guides/SCH-XX(기능명).md` |

- 스택·버전이 걸린 작업 전에 `docs/agent/ai-coding-agent.html` 을 먼저 본다. 버전 **값**의
  원본은 「11. 기술 스택 고정표」이고, 이 문서는 **왜 그 값인지와 실측 근거**를 담는다.
  값을 두 곳에 복제하지 않는다 — 복제하면 반드시 어긋난다.
- SCH 문서는 셋이 짝이다: 소스 안 학습 주석(`beginner-comment-style.md`) · 사람용 HTML
  가이드(`sch-guide-template.md`) · 에이전트용 `.md`(`agent-sch-doc-template.md`).
  앞의 둘은 **모르는 독자**를 가르치고, 셋째는 **잘못 아는 독자**를 교정한다. 셋의
  사실관계가 어긋나면 셋 다 못 믿게 되므로, 사실은 같고 서술 대상만 다르게 쓴다.
- 에이전트용 `.md` 의 핵심 절은 「쓰면 안 되는 것」이다. 에이전트에게는 "무엇을 하라"보다
  "무엇을 하지 말라"가 효과가 크다 — 잘못된 사전 지식이 기본값으로 깔려 있기 때문이다.

## 외부 API 는 무료 구간 안에서만 쓴다 (2026-09-30 확정, 2026-10-02 강화)

**호출하기 전에 그 API 가 무료인지 확인하고, 무료 한도 수치를 답에 먼저 적는다.** 사용자 규칙은 두 번 확인됐다 —
"무조건 무료 API 제공만 사용 가능한 조건이 필수"(09-30), "무료 API 범위에서만 꼭 써야 해 … **월 한도 무료 제공이 핵심**"(10-02).

- 외부 API 후보는 ①영구 무료 구간 ②가입·체험 크레딧(유한) ③종량제 셋으로 **구분해서** 제시한다. ③은 쓰지 않는다.
- 결제 수단 등록·유료 플랜 가입·크레딧 구매는 하지 않는다. 한도가 끝나면 그 자리에서 멈추고 사용자에게 알린다.
- 제품 안에서 반복 호출되는 자리에는 **영구 무료 구간이 있는 것만** 쓴다. 체험 크레딧은 일회성 작업에만.
- **로컬 실행이 가능하면 그쪽이 기본값이다** — 한도가 없고 키도 필요 없다(예: `docs/prototype/local-sd/` 의 SDXL 서버).
- 무료 한도 실측값은 사용자 메모리 `beta-free-api-only` 에 모아 둔다.

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
