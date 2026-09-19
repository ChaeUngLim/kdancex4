---
name: kdance-dev-harness
description: kdance 프로젝트(FastAPI backend / React admin-web / Expo mobile)에서 기능 구현, 버그 수정, 리팩터링 등 코드 변경이 걸린 작업을 요구사항 분석→기존 코드 구조 확인→구현 계획→Task 분리→구현→테스트→오류 수정→코드 리뷰→완료 검증의 9단계 파이프라인으로 오케스트레이션한다. "기능 만들어줘", "구현해줘", "버그 고쳐줘", "이거 개발해줘" 같은 코드 변경 요청 시 반드시 이 스킬을 사용한다. 후속 작업(이어서 진행, 재실행, Phase 5만 다시, 리뷰 지적 반영해서 다시, 테스트 실패 수정, 이전 결과 기반으로 계속) 요청에도 반드시 이 스킬을 사용한다. 단순 질문/설명/파일 하나 읽어달라는 요청에는 사용하지 않는다.
---

# kdance 개발 하네스 오케스트레이터

kdance 프로젝트의 코드 변경 작업을 9단계 파이프라인으로 조율하는 오케스트레이터. **Harness(이 스킬)가 흐름을 잡고, 실제 작업 수행은 ECC(everything-claude-code) 플러그인의 에이전트·스킬·MCP를 실행 수단으로 위임한다.**

## 실행 모드: 서브 에이전트 (파이프라인 + Phase 5 팬아웃)

9단계는 각 단계가 이전 단계 산출물에 강하게 의존하는 순차 파이프라인이라 실시간 팀 통신의 이점이 제한적이다(참고: `references/agent-design-patterns.md`의 "파이프라인" 패턴 적합성). 따라서 `Agent` 도구로 단계별 서브 에이전트를 순차 호출하고, 산출물은 파일(`_workspace/`)로 전달한다. **Phase 5(구현)만** Task가 여러 개고 서로 파일이 겹치지 않으면 단일 메시지에서 여러 `Agent` 호출로 병렬 팬아웃한다. Phase 7↔8(수정↔리뷰)은 최대 2회 왕복하는 생성-검증(producer-reviewer) 서브 루프다.

## 에이전트 구성

| Phase | 에이전트 | subagent_type | ECC 실행 리소스(핵심) | 출력 |
|---|---|---|---|---|
| 1 요구사항 분석 | kdance-req-analyst | `kdance-req-analyst` | AskUserQuestion, docs/*.md | `01_req-analyst_requirements.md` |
| 2 기존 코드 구조 확인 | code-searcher (기존 재사용) | `code-searcher` | `ecc:codebase-onboarding`, `mcp__postgres-kdance`, 구조 시각화 필요시 `mcp__mindpilot__*`(절차는 core-rules.md) | `02_code-searcher_structure.md` |
| 3 구현 계획 | kdance-impl-planner | `kdance-impl-planner` | `ecc:architect`, `ecc:code-architect`, `ecc:architecture-decision-records`, 구조 시각화 필요시 `mcp__mindpilot__*`(절차는 core-rules.md) | `03_impl-planner_plan.md` |
| 4 Task 분리 | kdance-task-splitter | `kdance-task-splitter` | `TaskCreate` | `04_task-splitter_tasks.md` |
| 5 구현 (팬아웃 가능) | kdance-implementer × N | `kdance-implementer` | `ecc:fastapi-patterns`/`python-patterns`/`react-patterns`/`react-native-patterns`/`postgres-patterns`, `mcp__postgres-kdance`, `mcp__context7` (코드 탐색·파일 수정·의존성 확인) | `05_implementer_{task-id}_summary.md` |
| 6 테스트 | kdance-test-runner | `kdance-test-runner` | `ecc:python-testing`, `ecc:react-testing`, `ecc:test-coverage` (테스트 실행) | `06_test-runner_results.md` |
| 7 오류 수정 | kdance-bug-fixer | `kdance-bug-fixer` | `ecc:build-fix`, `ecc:react-build-resolver` (디버깅) | `07_bug-fixer_fixes.md` |
| 8 코드 리뷰 | kdance-code-reviewer | `kdance-code-reviewer` | `code-review`, `ecc:fastapi-reviewer`/`react-reviewer`/`typescript-reviewer`/`database-reviewer`/`security-reviewer` | `08_code-reviewer_review.md` |
| 9 완료 검증 | kdance-completion-verifier | `kdance-completion-verifier` | `run`, `ecc:verification-loop` | `09_completion-verifier_report.md` |
| 9.5 학습 주석 재구성 + SCH 가이드 생성 (SCH 완료 시) | kdance-implementer (재사용) | `kdance-implementer` | `references/beginner-comment-style.md`, `references/sch-guide-template.md`, "다른 SCH와의 연관관계" 절에 플로우 다이어그램이 필요하면 `mcp__mindpilot__*`(절차는 core-rules.md) | 변경 파일에 학습 주석 반영 + `_workspace/guides/SCH-{번호}.html` 신규 + `kdance.html` SCH 완료·가이드 링크 갱신 |

Git 작업(커밋/브랜치)은 오케스트레이터(리더)가 사용자 승인 후 직접 수행한다(core-rules.md: 공유 상태 변경은 확인 후) — `ecc:git-workflow` 스킬 참고. 리팩터링은 Phase 8 지적을 Phase 7이 반영하거나, 범위가 크면 사용자에게 별도 `ecc:refactor-clean` 실행 여부를 확인한다.

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 지원)
1. `_workspace/` 존재 여부 확인.
2. 분기:
   - **미존재** → 초기 실행. Phase 1로.
   - **존재 + 부분 수정 요청** ("Phase 5만 다시", "리뷰 반영해서 다시" 등) → 해당 Phase 에이전트만 재호출, 이전 산출물을 프롬프트에 포함해 개선을 지시.
   - **존재 + 새 입력/새 기능 요청** → 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 새 `_workspace/` 생성, Phase 1부터.
3. 사용자 요청 원문을 `_workspace/00_input/request.md`에 저장.

### Phase 1~4: 분석·설계 (순차)
표의 순서대로 `Agent(subagent_type: "kdance-req-analyst" | "code-searcher" | "kdance-impl-planner" | "kdance-task-splitter", model: "opus")`를 하나씩 호출한다. 각 단계 완료 후 산출물을 Read로 확인하고 다음 단계 프롬프트에 파일 경로를 전달한다.

- Phase 1에서 `AskUserQuestion`이 필요하다고 보고되면, 오케스트레이터가 직접 사용자에게 확인 후 Phase 1을 재호출한다.
- Phase 2는 요구사항의 "대상 범위"를 프롬프트에 포함해 탐색 범위를 좁힌다.

### Phase 5: 구현 (팬아웃)
1. `04_task-splitter_tasks.md`에서 병렬 가능 태스크 그룹을 확인한다.
2. 병렬 가능 그룹은 **단일 메시지**에서 태스크 수만큼 `Agent(subagent_type: "kdance-implementer", model: "opus", run_in_background: true)`를 동시 호출한다. 의존 관계가 있는 태스크는 선행 그룹 완료 후 다음 그룹을 호출한다.
3. 각 구현 에이전트의 산출물(`05_implementer_{task-id}_summary.md`)을 Read로 수집한다.

### Phase 6: 테스트
`kdance-test-runner`를 호출한다. 전부 통과면 Phase 8로, 실패가 있으면 Phase 7로 진행한다.

### Phase 7↔8: 수정↔리뷰 서브 루프 (최대 2회)
1. Phase 7(`kdance-bug-fixer`) 호출 — 입력은 Phase 6 실패 로그(최초 진입) 또는 Phase 8 리뷰 지적(재진입).
2. Phase 7 완료 후: 최초 진입(테스트 실패발) 이었다면 Phase 6을 재실행해 통과 확인 후 Phase 8로. 재진입(리뷰발) 이었다면 바로 Phase 8을 재실행.
3. Phase 8(`kdance-code-reviewer`) 판정이 `CHANGES_NEEDED`(CRITICAL/HIGH 존재)면 Phase 7로 되돌아간다. 이 왕복은 **최대 2회**.
4. 2회 초과 후에도 CRITICAL/HIGH가 남으면 루프를 멈추고 사용자에게 미해결 항목을 보고, 진행 여부를 확인한다.

### Phase 9: 완료 검증
`kdance-completion-verifier` 호출. `INCOMPLETE`면 미충족 기준을 사용자에게 보고하고 Phase 5/7 재진입 여부를 확인한다. `COMPLETE`면 아래 "Phase 9.5"로.

### Phase 9.5: 학습 주석 재구성 + 왕초보 완벽분석가이드 생성 (SCH 완료 시)
`references/beginner-comment-style.md`(소스 내 학습 주석) + `references/sch-guide-template.md`(SCH별 HTML 가이드) 참고. 이번 작업이 `_workspace/kdance.html`의 SCH 항목에 대응하는 경우에만 수행한다(SCH 미부여 작업이면 생략하고 사용자에게 그 사실을 보고한 뒤 "정리"로 진행).

1. Phase 5 산출물(`05_implementer_*_summary.md`), Phase 6/8/9 산출물에서 이번 SCH가 건드린 파일·이슈·테스트 결과·인계 사항을 취합한다.
2. `kdance-implementer`를 "주석 재구성" 태스크로 재호출한다 — 입력은 변경 파일 목록 + 두 참고 문서 경로. 이 한 번의 호출로 두 가지를 만든다:
   - 로직 변경 금지, 주석만 추가/수정(`beginner-comment-style.md`). 이미 처리된 SCH 마커(`# 학습 주석: SCH-XX 반영`)가 있는 파일은 건드리지 않는다.
   - `_workspace/guides/SCH-{번호}.html` 신규 생성(`sch-guide-template.md`의 7개 섹션 구성 그대로) — 이슈/원인파악/해결/테스트 결과/다른 SCH와의 연관관계를 포함한다.
3. `kdance-test-runner`로 관련 테스트만 가볍게 재실행해 그린 유지를 확인한다. 실패하면 로직이 바뀐 것이므로 Phase 7로 되돌린다(예외적 재진입).
4. `_workspace/kdance.html`에서 해당 SCH 항목을 "완료"로 갱신하고, 그 `.item` 블록에 새 가이드로 연결되는 `가이드 보기` 링크를 추가한다.

### 정리
1. `_workspace/`는 삭제하지 않고 보존한다(감사 추적용).
2. 변경된 파일 목록과 최종 판정을 사용자에게 요약 보고한다.
3. Git 커밋은 **사용자가 명시적으로 요청할 때만** 수행한다. 커밋 메시지/PR 설명은 core-rules.md "Git 커밋 / PR 설명 (왕초보 기준)"을 따른다 — SCH 관련 작업이면 `SCH-XX(기능명)` 표기 + 이슈/해결/테스트 요약 + 해당 가이드(`_workspace/guides/SCH-XX.html`) 링크를 포함한다.
4. 사용자에게 개선 피드백 기회를 제공한다 — "결과에서 개선할 부분이 있나요?"

## 데이터 흐름

```
[사용자 요청]
   ↓
Phase1 req-analyst ──→ 01_requirements.md
   ↓
Phase2 code-searcher ─→ 02_structure.md
   ↓
Phase3 impl-planner ──→ 03_plan.md
   ↓
Phase4 task-splitter ─→ 04_tasks.md (+TaskCreate)
   ↓
Phase5 implementer×N ─→ 05_implementer_{task}_summary.md
   ↓
Phase6 test-runner ───→ 06_results.md ──(실패)──┐
   ↓ (통과)                                      ↓
Phase8 code-reviewer ←────────────────── Phase7 bug-fixer ──→ 07_fixes.md
   │  (CHANGES_NEEDED, 최대 2회) ─────────────────┘
   ↓ (PASS)
Phase9 completion-verifier ──→ 09_report.md
   ↓
[사용자 보고]
```

## 에러 핸들링

| 상황 | 전략 |
|---|---|
| 특정 Phase 에이전트 실패/중단 | 1회 재시도. 재실패 시 해당 Phase 없이 진행 불가능하면(1~4, 9) 사용자에게 보고 후 중단, 병렬 구현(Phase 5) 중 1개만 실패면 나머지로 계속 진행하고 실패 태스크는 미완료로 보고 |
| Phase 7↔8 루프 2회 초과 | 루프 중단, 미해결 CRITICAL/HIGH를 사용자에게 보고, 진행/보류 결정 요청 |
| Phase 5 병렬 태스크 간 파일 충돌 발견 | 즉시 중단, Phase 4(Task 분리)로 되돌아가 태스크 재분리 |
| Phase 2/6 인프라 문제(DB/테스트 커맨드 없음) | 가능한 범위로 진행, 산출물에 한계 명시 — 억지로 통과 처리하지 않음 |
| 상충 데이터(예: Phase 1과 Phase 3의 판단 불일치) | 삭제하지 않고 두 출처 병기, 오케스트레이터가 사용자에게 확인 |

## 테스트 시나리오

### 정상 흐름
1. 사용자: "예약 취소 시 잔여 수업권 환불 로직 추가해줘"
2. Phase 0: `_workspace/` 없음 → 초기 실행
3. Phase 1: 요구사항 정리, `docs/pricing-policy.md`와 상충 없음 확인
4. Phase 2: code-searcher가 backend 예약/결제 모듈 구조 파악
5. Phase 3~4: 계획 수립 후 backend 모델/API 태스크 2개로 분리(병렬 가능)
6. Phase 5: 2개 구현 에이전트 병렬 실행
7. Phase 6: pytest 통과
8. Phase 8: PASS 판정
9. Phase 9: 수용 기준 충족 확인, COMPLETE 보고

### 에러 흐름
1. Phase 6에서 backend 테스트 1건 실패
2. Phase 7이 원인 분석 후 수정, Phase 6 재실행하여 통과 확인
3. Phase 8 리뷰에서 HIGH 1건(입력 검증 누락) 발견 → CHANGES_NEEDED
4. Phase 7 재호출(리뷰 지적 반영) → Phase 8 재실행 → PASS (1회 왕복으로 해결)
5. Phase 9에서 COMPLETE 확인, 최종 보고
