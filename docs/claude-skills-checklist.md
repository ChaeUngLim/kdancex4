# Claude Code 스킬 체크리스트

kdance에서 쓰는 Claude Code 스킬을 **언제 켜고 언제 끌지** 정리한 문서다.

**on/off 상태는 `.claude/settings.local.json`의 `skillOverrides`에 저장된다** (2026-09-20 재확인 — 이전에 "어디에도 저장되지 않는다"고 적었던 것은 틀렸다. `settings.json`과 `~/.claude.json`만 뒤져서 못 찾았던 것이고, 실제로는 프로젝트 쪽 `settings.local.json`에 18개가 들어 있다). 경로 기반이라 계정을 바꿔도 남는다.

다만 그 파일은 `~/.config/git/ignore`의 `**/.claude/settings.local.json` 규칙에 걸려 git 에 올라가지 않는다. 그래서 사본을 `docs/handoff/settings.project.local.json`에 둔다. **무엇을 왜 껐는지**는 기계가 읽는 그 JSON 에 안 남으므로 여기 적어둔다.

---

## 1. 끄기 진행 상황

### 이미 끈 것 (2026-09-20)

| 대상 | 토큰 | 왜 껐나 |
|------|-----|--------|
| `computer-use` · `built-in-browser` · `chrome-browser` | 2,512 | 데스크톱 앱·Chrome 확장 전용. 이 CLI에서 **호출 자체가 불가능** |
| `deep-research` | 570 | `ecc:deep-research`와 중복 |
| `anthropic-skills:docs` | 250 | claude.ai 문서 커넥터 전용. 커넥터가 없어 발동 불가 |
| `anthropic-skills:morning` | 91 | 아침 브리핑. 프로젝트 무관 |
| `anthropic-skills:setup-writing-style` | 123 | 개인 문체 학습. 한국어 윤문은 `humanize-korean`이 맡는다 |
| `security:test-examples:*` 6종 | 110 | 프롬프트 인젝션 **테스트용 공격 샘플**. 도구가 아니다 |
| `anthropic-skills:docx` · `pdf` · `pptx` · `xlsx` | 620 | 사용자 판단으로 추가 정리 |
| `ai-image-creator` | 138 | 로고·배너를 AI로 만들 일이 생기면 다시 켠다 |

**주의** — pptx를 껐으므로 `docs/가이드/`의 pptx 2개(`kdance_화면명세서`, `소셜댄스_입점설명회`)를 읽거나 고칠 수 없다. 필요하면 다시 켠다.

### 아직 안 끈 것

| 우선순위 | 대상 | 토큰 | 판단 |
|---|------|-----|------|
| **높음** | `harness` 플러그인 | 110 | **토큰이 아니라 안전 문제.** 아래 표 참조 |
| 낮음 | `anthropic-skills:import-memory` | 43 | 43토큰이라 꺼도 체감 없음 |
| 낮음 | `audit-session-metrics` · `session-metrics` · `task-breakdown` | 546 | 비용 점검 때만. 자주 안 쓰면 끄는 쪽이 낫다 |

### 같이 끌 것 — 플러그인 1개

| 플러그인 | 토큰 | 왜 끄나 |
|---------|-----|--------|
| `harness` (harness-marketplace) | 110 | **범용 하네스 생성 메타스킬**이다. `core-rules.md`가 *"범용 `harness:harness`를 호출하지 말라"*고 명시한 바로 그 도구다 — "하네스 점검해줘" 같은 말에 트리거되어, Phase 9.5(학습 주석 재구성·SCH 가이드 생성)나 SCH 표기 규칙 같은 kdance 전용 커스터마이징을 자기 템플릿으로 갈아엎을 수 있다. 끄면 규칙을 지킬 필요 없이 구조적으로 막힌다 |

**혼동 주의** — 프로젝트 스킬 `kdance-dev-harness`(100토큰)와 다른 물건이다. 그쪽이 `core-rules.md`가 말하는 진짜 Harness이고 **상시 켜둔다**.

---

## 2. 켜둘 것

### 실제로 쓰는 것

| 스킬 | 무엇 | 언제 발동 |
|------|------|----------|
| `kdance-dev-harness` | 9단계 개발 파이프라인 | "기능 만들어줘", "버그 고쳐줘" 같은 코드 변경 요청 |
| `humanizer-kr` | 한국어 어휘·조사·어미 1패스 | 짧은 글 — 코드 리뷰 코멘트·Q&A·커밋 메시지 |
| `humanize-korean` | 어휘+구조 전체 + 정량 게이트 | 분량 있는 문서·커밋 본문 |
| `graphify` | 코드베이스 지식 그래프 질의 | "이 코드 어디 있어" 같은 구조 질문 |
| `diagram-this` | Mermaid를 정적 HTML로 구워 브라우저로 연다 | 다이어그램 요청. MCP 연결이 필요 없다 |
| `claude-docs-consultant` | Claude Code 공식 문서 조회 | 훅·스킬·MCP·플러그인을 설정할 때 |

### 아직 안 썼지만 남겨두는 것

| 스킬 | 토큰 | 이유 |
|------|-----|------|
| `anthropic-skills:docx` `xlsx` `pptx` `pdf` | 863 | `docs/가이드/`에 pptx 2개가 실재한다. 정산·통계에서 xlsx를 쓸 수 있다 |
| `anthropic-skills:skill-creator` | 88 | 새 스킬을 만들거나 고칠 때 |
| `ui-ux-pro-max` · `frontend-design` | — | admin-web·mobile 화면 작업 예정 |

### 상시 켜두는 핵심 2종 — 끄지 않는다

| | 규모 | 왜 켜두나 |
|---|---|---|
| `ecc` 플러그인 | 293종 · 약 15,000~23,000토큰 | `core-rules.md`의 **품질 계층**이다. `ecc:security-reviewer`·`ecc:react-review`는 예약·결제를 다루는 이 프로젝트에 특히 필요하다. 사용 0회인 것은 아직 코드 작업을 시작하지 않아서이지 쓸모가 없어서가 아니다 |
| `kdance-dev-harness` | 1종 · 100토큰 | **프로젝트 지휘자**. 9단계 파이프라인 본체다 |

`ecc`는 이 설정에서 단연 가장 비싸다(나머지 전부의 5~7배). 그래도 끄지 않는 대신, ECC 자체 규칙대로 **6대 업무 중심으로만 쓴다** — `ecc:energy-procurement`(에너지 조달)·`ecc:inventory-demand-planning`(재고 수요예측)처럼 kdance와 무관한 스킬은 끌어다 쓰지 않는다.

### 개당 10~30토큰이라 꺼도 체감 없는 것

`anthropic:*` · `architecture:*` · `ccusage:*` · `cleanup:*` · `documentation:*` · `promptengineering:*` · `refactor:*` · `security:` 본체 3종.

---

## 3. 상황별 조합

| 하려는 일 | 켤 것 | 순서·비고 |
|----------|------|----------|
| **비용 점검** | `session-metrics` → `task-breakdown` → `audit-session-metrics` | 집계 → 작업 단위 묶기 → 낭비 감사 순. 끝나면 다시 끈다 |
| **화면 작업** (admin-web·mobile) | `frontend-design` → `ui-ux-pro-max` | ① 미적 방향(색·폰트) ② 설계+구현. **`ui-styling` 하위 스킬은 직접 부르지 않는다** — Tailwind·shadcn 고정이라 admin-web의 순수 CSS와 충돌한다 |
| **기능 개발** | `kdance-dev-harness` | 나머지는 하네스가 알아서 ECC 스킬을 부른다 |
| **문서 작성** | `humanize-korean` | 초안 → 윤문 → 게이트. 두세 문장이면 `humanizer-kr`로 갈음한다 |
| **다이어그램** | `diagram-this` | 반복 작업이면 이쪽. mindpilot UI가 꼭 필요할 때만 MCP를 쓴다 |
| **보안 점검** | `security:security-audit` · `secure-prompts` | 분석기를 **검증**할 때만 `test-examples:` 6종을 켠다 |
| **라이브러리 사용법** | `claude-docs-consultant` + `mcp__context7` | 학습 데이터 대신 실제 문서를 본다 |

---

## 3-1. 개발 단계별 on/off

현재 상태(2026-09-20 기준)에서 **바꿔야 할 것만** 적는다. 표에 없는 것은 그대로 둔다.

### 구현 단계 — 백엔드 (SCH-13~20 방식 A 딥링크)

| | 대상 | 비고 |
|---|---|---|
| **켠다** | (없음) | 지금 구성으로 충분하다 |
| **끈다** | (없음) | |
| **쓰는 것** | `kdance-dev-harness` · `ecc` · `graphify` · `humanize-korean` | 하네스가 ECC를 알아서 부른다 |
| **MCP** | `postgres-kdance` · `context7` | DB 확인과 라이브러리 문서 |

ECC 쪽에서 실제로 불릴 것: `ecc:fastapi-patterns` · `ecc:python-testing` · `ecc:tdd-workflow` · `ecc:postgres-patterns` · `ecc:database-migrations`, 에이전트 `fastapi-reviewer` · `database-reviewer` · `security-reviewer` · `tdd-guide`.

**결제·예약 코드는 `security-reviewer`를 반드시 거친다** — `core-rules.md`가 이 프로젝트에서 보안을 특히 강조한 이유다.

### 프론트엔드 단계 — admin-web · mobile

| | 대상 | 비고 |
|---|---|---|
| **켠다** | (없음 — 이미 켜져 있음) | `frontend-design` · `ui-ux-pro-max` |
| **끈다** | (없음) | |
| **MCP** | `playwright` 추가로 사용 | 화면을 눈으로 확인 |

순서는 ① `frontend-design`으로 미적 방향(색·폰트·인상) → ② `ui-ux-pro-max` 상위 스킬로 설계+구현.

**`ui-ux-pro-max:ui-styling` 하위 스킬은 직접 부르지 않는다.** Tailwind+shadcn 고정이라 admin-web의 순수 CSS(`app/globals.css`, CSS 변수 30개, `className` 미사용)와 충돌한다. 상위 스킬은 `package.json`을 읽어 스택을 감지하므로 안전하다.

ECC 쪽: `/ecc:react-review` · `/ecc:react-test` · `ecc:frontend-a11y` · `ecc:react-native-patterns`(mobile), 에이전트 `react-reviewer`.

**첫 화면 작업 때 검증할 것** — `ui-ux-pro-max`가 정말 순수 CSS로 내놓는지 확인한다. Tailwind 코드가 나오면 감지가 실패한 것이므로 그때 조정한다.

### QA 단계 — 테스트·리뷰·E2E

| | 대상 | 토큰 | 비고 |
|---|---|---|---|
| **켠다** | `security:test-examples:*` 6종 | 110 | **`secure-prompts` 분석기를 검증할 때만.** 끝나면 다시 끈다 |
| **끈다** | (없음) | | |
| **MCP** | `playwright` · `chrome-devtools` · `postgres-kdance` | | E2E · 성능 · DB 통합 테스트 |

ECC 쪽: `/ecc:code-review` · `/ecc:test-coverage` · `/ecc:security-scan` · `ecc:e2e-testing` · `ecc:browser-qa`, 에이전트 `code-reviewer` · `e2e-runner` · `pr-test-analyzer`.

**E2E 실행은 Playwright가 한다** — ECC는 품질 기준만 제시한다(`core-rules.md`의 역할 분리).

**SCH-11(마이그레이션 검증)·SCH-12(DB 통합 테스트 실행)은 Docker 기동이 전제다.** Docker Desktop을 먼저 켠다.

### 비용 점검 회차 (분기 1회 정도)

| | 대상 | 토큰 |
|---|---|---|
| **켠다** | `session-metrics` → `task-breakdown` → `audit-session-metrics` | 546 |
| **끝나면 끈다** | 위 3종 | |

현재 셋 다 켜져 있다. 자주 안 쓸 것 같으면 지금 끄고 필요할 때 켜는 쪽이 낫다.

### 문서·자료 만들 때

| 상황 | 켤 것 |
|---|---|
| pptx 편집·읽기 | `anthropic-skills:pptx` — **현재 off**. `docs/가이드/`의 pptx 2개를 다루려면 켠다 |
| pdf 작업 | `anthropic-skills:pdf` — **현재 off** |
| docx 작업 | `anthropic-skills:docx` — **현재 off** |
| 로고·배너 생성 | `ai-image-creator` |

---

## 4. 헷갈리기 쉬운 짝

| 짝 | 구분 |
|----|------|
| `security:security-audit` ↔ `security:test-examples:*` | 앞은 **분석기 본체**, 뒤는 그걸 시험하는 **공격 샘플**. 이름에 `test-examples:`가 붙은 것만 끈다 |
| `anthropic-skills:docs` ↔ `docx`·`pdf`·`pptx`·`xlsx` | 앞은 claude.ai **문서 커넥터**용이라 이 환경에서 발동하지 않는다. 뒤는 **오피스 파일** 처리다 |
| `ui-ux-pro-max`(상위) ↔ `ui-ux-pro-max:ui-styling`(하위) | 상위는 `package.json`을 읽어 스택을 **감지**한다(*"Never assume a stack"*). 하위는 Tailwind+shadcn **고정**이고 감지 로직이 한 줄도 없다 |
| `humanizer-kr` ↔ `humanize-korean` | 앞은 어휘층만 보는 1패스(짧은 글), 뒤는 어휘+구조에 정량 게이트까지 붙는다(긴 글) |
| `frontend-design` ↔ `ui-ux-pro-max` | 앞은 71줄짜리 **미감 지침**이고 코드 내용이 0줄이다. 구현은 뒤가 한다 |

---

## 5. 조작 방법과 제약

**켜고 끄기** — `/plugin` 실행 → 방향키로 이동 → Enter나 Space로 토글.

**제약 세 가지** (2026-09-20 확인)

1. **대화 중에는 못 바꾼다.** 스킬 설명문은 세션이 시작될 때 시스템 프롬프트에 한 번 박힌다. 작업 도중 켜도 그 세션에는 반영되지 않고 다음 세션부터 걸린다.
2. **CLI로 못 한다.** `claude plugin disable`은 **플러그인 단위**만 받아서 스킬 하나를 지정할 수 없다.
3. **파일로 쓸 수 있다.** `.claude/settings.local.json`의 `skillOverrides`에 `"스킬명": "off"`를 직접 넣어도 된다. 다음 세션부터 걸린다(1번 제약은 그대로다). 다만 **왜 껐는지**는 JSON 에 안 남으므로 이 문서를 같이 고친다.

---

## 6. 갱신

스킬을 켜거나 끌 때마다 위 표를 고친다. 토큰 수치는 `/plugin` 화면에 뜨는 값을 그대로 쓴다.

**기준 (2026-09-20)**

| | 종수 | 토큰 |
|---|---|---|
| 전체 | 38 | 3,056 |
| 실제로 써본 것 | 5 | 549 |
| 한 번도 안 쓴 것 | 33 | 2,507 (82%) |
| 끌 대상 | 14 | 1,301 (42%) |

**실익을 오해하지 않는다.** 14종을 다 꺼도 1,301토큰이다. 윤문 서브에이전트는 **호출 한 번에 약 92,000토큰**을 쓴다. 스킬 정리는 해두면 좋지만 비용 문제의 본체가 아니다. 비용을 줄이려면 윤문 호출 횟수부터 본다.
