# Spec Kit · Harness · ECC 역할 분담 재검토 보고서

- 작성일: 2026-09-21
- 계기: 외부 분석(ChatGPT) 7장이 현재 `core-rules.md` 와 다른 역할 분담을 제안함
- 판단 대상: 현행 유지 / 제안안 채택 / 제3안

---

## 0. 결론 먼저

**현행 구조를 유지하되, 제안안에서 세 가지를 흡수한다.** 통째로 갈아타지 않는다.

| | 판단 | 한 줄 이유 |
|---|---|---|
| 제안안 통째 채택 | ✗ | Phase 9.5(학습 주석·SCH 가이드) 가 갈 곳이 없어진다. 이 프로젝트의 목적 자체가 사라진다 |
| 현행 그대로 | △ | 구조는 맞지만 이름이 겹쳐 경계 분쟁이 반복된다. 오늘만 3번 헤맸다 |
| **제3안(권고)** | ✅ | 파이프라인 주인은 그대로, **산출물 규격과 이름 체계만** 제안안에서 빌려온다 |

**전환 비용이 이유가 아니다.** 제안안이 더 나은 부분이 분명히 있고, 그건 받는다. 다만
그 부분이 "도구를 바꿔야만" 얻어지는 게 아니라서 도구는 바꾸지 않는다.

---

## 1. 제안안은 무엇을 말하고 있나

7장을 종합하면 이렇다.

```
사람  →  Spec Kit  →  Harness  →  ECC  →  Claude Code  →  Test  →  Converge
       (설계자)   (개발환경/감독관) (공구상자)  (실제 개발자)
```

| 도구 | 제안안이 준 역할 |
|---|---|
| **Spec Kit** | 요구사항 · 시나리오 · 예외조건 · 명세 · **기술 설계** · **Task 분해** · **명세 검증** |
| **Harness** | CLAUDE.md · Rules · Hooks · Permissions · MCP 구성 · **품질 Gate** |
| **ECC** | Frontend · Backend · DB · TDD · Testing · Security · Review · Refactoring · Docs |
| **Claude Code** | 실제 코드 작성 |

제안안의 핵심 경고는 3장에 있고, 이건 **정확하다**.

> ✗ 나쁜 구조
> `Spec Kit → Plan` · `ECC → Plan` · `GSD → Plan` · `Harness → Plan`
> 이렇게 하지 않는 게 좋습니다.

그리고 ECC 영역별로 충돌 강도를 표시한 것도 정확하다 — Planning 🔴, Task breakdown 🔴,
Architecture 🟠, 나머지 구현·테스트·보안 🟢.

---

## 2. 핵심 발견 — "Harness" 가 두 가지를 가리킨다

**이것이 모든 혼란의 뿌리다.**

| | 제안안의 Harness | kdance 의 Harness |
|---|---|---|
| 정체 | **환경** — CLAUDE.md, Rules, Hooks, Permissions, MCP | **파이프라인** — `kdance-dev-harness` 스킬 + 전용 에이전트 8개 |
| 하는 일 | AI 가 안전하게 일할 작업장을 만든다 | 9단계를 순서대로 돌린다 |
| 산출물 | 설정 파일 | `_workspace/01~09_*.md` |

제안안 2장의 문장이 이를 잘 보여준다.

> "Spec Kit이 설계도를 만들면 Harness는 그 설계도를 가지고 AI가 안전하게 작업할 수 있는
> **작업장을 만드는** 역할"

**같은 단어가 다른 물건을 가리키고 있다.** 그래서 "Harness가 요구사항 명세를 ★2 로
잘 못한다" 는 제안안의 평가는, 제안안이 말하는 Harness(환경) 기준으로는 맞지만
kdance 의 Harness(파이프라인 + `kdance-req-analyst`) 기준으로는 틀리다.

`CLAUDE.md` 가 이미 비슷한 경고를 하고 있다 — *"설치된 범용 `harness:harness` 메타스킬과
절대 혼동하지 않는다."* 같은 함정을 외부 분석도 밟았다.

---

## 3. 두 모델은 같은 문제를 반대 방향으로 풀었다

둘 다 **"파이프라인은 하나여야 한다"** 를 지킨다. 방향만 다르다.

| | 파이프라인 주인 | 나머지 |
|---|---|---|
| **제안안** | Spec Kit (specify→plan→tasks→analyze→converge) | Harness = 환경, ECC = 공구 |
| **현행 kdance** | Harness (Phase 1~9.5) | Spec Kit = 앞단 3개, ECC = 품질 |

**논리적으로 둘 다 유효하다.** 그래서 "어느 쪽이 맞나" 가 아니라 **"이 프로젝트에 무엇이
남아야 하나"** 로 판단해야 한다.

---

## 4. 실제 능력 대조 — 읽어서 확인한 것

추측하지 않고 스킬 본문과 템플릿을 직접 읽었다.

### 4-1. Spec Kit 이 실제로 더 나은 부분

| 항목 | speckit | kdance Phase |
|---|---|---|
| 설계 산출물 | `research.md` · `data-model.md` · `contracts/` · `quickstart.md` · `plan.md` **5종 분리** | `03_impl-planner_plan.md` **1종** |
| Task 구성 | **User Story 단위 수직 슬라이스.** P1 만 구현해도 MVP 가 선다 | 파일/모듈 단위 분해 + 의존 관계 |
| 병렬 표시 | `[P]` 마커로 명시 | Phase 5 팬아웃 판단으로 처리 |
| MVP 전략 | 템플릿에 `Implementation Strategy / MVP First` 절이 고정 | 없음 |

**이건 인정해야 한다.** `tasks-template.md` 가 Task 를 US 단위로 묶는 방식은 kdance
Phase 4 보다 구조가 낫다. "US1 만 끝내도 굴러간다" 를 강제하기 때문이다.

### 4-2. kdance 에만 있는 것 — 대체물이 없다

| 항목 | 있나 |
|---|---|
| **Phase 9.5 학습 산출물 3종** (소스 학습 주석 · 사람용 HTML 가이드 · 에이전트용 `.md`) | **Spec Kit 에 없음** |
| **SCH 추적** (`_workspace/SCH_kdance.html` 현황판, 가이드 7종) | 없음 |
| **Phase 2 기존 코드 구조 조사** | 없음 (speckit 은 코드를 안 본다) |
| **Phase 7↔8 수정↔리뷰 서브 루프**(최대 2회) | 없음 |
| **Phase 0 후속 작업 지원**(부분 재실행, 회차 보존) | 없음 |
| **`_workspace/` 감사 추적** | 없음 |

그리고 **코드가 이미 Phase 3 산출물을 번호로 인용하고 있다.**

```python
# backend/app/models/refund.py
# 공유 계약 §4.1: refunds.status = {succeeded, pending, failed}
# 각 원소 형태는 공유 계약 §4.4 고정
```

모델·서비스·어댑터가 같은 계약 번호를 인용해서 계층 간 값 불일치가 나지 않았다.
이 끈을 끊으면 다시 이어야 한다.

### 4-3. 단계 수 비교 — kdance 가 상위집합이다

| kdance Phase | speckit 대응 |
|---|---|
| 1 요구사항 분석 | specify + clarify (단 kdance 는 **코드를 본다**) |
| 2 기존 코드 구조 확인 | **없음** |
| 3 구현 계획 | plan |
| 4 Task 분리 | tasks |
| 5 구현 | implement |
| 6 테스트 | **없음** |
| 7 오류 수정 | **없음** |
| 8 코드 리뷰 | analyze |
| 9 완료 검증 | converge |
| 9.5 학습 산출물 | **없음** |

speckit 에만 있고 kdance 에 없는 단계는 **하나도 없다.** 현행 규칙이 "겹치는 7개를
쓰지 않는다" 고 정한 것은 이 사실에 근거해 맞다.

---

## 5. 각 모델의 약점

### 제안안의 약점 3

1. **학습 산출물이 통째로 빠진다.** 이 프로젝트는 "비전공자가 완성된 소스만 보고도
   맥락을 따라갈 수 있게" 하는 것이 목적의 절반이다(`CLAUDE.md` 변경 이력 3건이 전부
   이 주제다). 제안안 어디에도 그 자리가 없다.
2. **자기 모순이 하나 있다.** 4장에서 "반복 실행 / 품질 Gate: Harness" 라고 했는데,
   품질 Gate 는 파이프라인 개입이다. Harness 를 순수 환경으로 두자는 자기 전제와 어긋난다.
3. **ECC 를 공구상자로만 두면 호출 주체가 사라진다.** 지금은 Phase 6/8 이 `ecc:code-reviewer`
   `ecc:security-reviewer` 를 부른다. 제안안에는 "언제 누가 부르는지" 가 없다.

### 현행의 약점 3

1. **이름이 겹쳐 경계 분쟁이 반복된다.** 오늘 한 세션에서 3번 헤맸다 — spec-kit 과 Phase 1
   의 관계, SDD 의 주인, clarify 실행 여부. 규칙을 눈앞에 두고도 그랬다.
2. **Spec Kit 을 3개 허용하고 1개만 쓴다.** `/speckit-clarify` 와 `/speckit-checklist` 는
   허용 목록에 있지만 실제로는 건너뛰었고, clarify 의 일은 사용자에게 직접 물어 해결했다
   (Q1·Q2·Q3, 몇 분 소요). 허용해 두면 매번 "돌려야 하나" 판단 비용이 든다.
3. **「슬라이스 절단」의 주인이 없다.** FR 185개를 어디부터 자를지가 어느 Phase 일인지
   규칙에 없다. 이번에 즉흥으로 판단했다.
4. **환경 계층에 이름이 없다.** CLAUDE.md · rules · hooks · permissions · MCP 는 실재하는데
   규칙이 이것을 하나의 계층으로 다루지 않는다. 제안안이 바로 이 자리를 짚었다.

---

## 6. 세 선택지

| | A. 현행 유지 | B. 제안안 채택 | **C. 제3안 (권고)** |
|---|---|---|---|
| 파이프라인 주인 | Harness | Spec Kit | **Harness** |
| Spec Kit 범위 | 앞단 3개 | 전체 7개 | **`specify` 1개** |
| Phase 9.5 학습 산출물 | 유지 | **소멸** | **유지** |
| SCH 추적 | 유지 | 소멸 | 유지 |
| 설계 산출물 규격 | 1종 | 5종 분리 | **5종 분리로 상향** |
| Task 구성 | 파일 단위 | US 단위 | **US 단위로 상향** |
| 환경 계층 이름 | 없음 | 있음(Harness) | **있음(별도 이름)** |
| 전환 비용 | 0 | 에이전트 8개 폐기 + 계약 재매핑 | **에이전트 프롬프트 수정만** |
| 경계 분쟁 | 계속 | 해소 | **해소** |

---

## 7. 권고안 (C) — 구체적 변경 5가지

### ① 계층 이름을 넷으로 가른다

제안안의 가장 큰 기여다. **"Harness" 라는 한 단어가 두 물건을 가리키는 것을 끝낸다.**

| 계층 | 이름 | 무엇 | 실체 |
|---|---|---|---|
| 0 | **환경(Environment)** | AI 가 일할 작업장 | `CLAUDE.md` · `.claude/rules/` · hooks · permissions · MCP |
| 1 | **명세(Spec)** | 무엇을 왜 | `/speckit-specify` → `specs/*/spec.md` |
| 2 | **파이프라인(Pipeline)** | 무엇을 어떤 순서로 | `kdance-dev-harness` Phase 1~9.5 |
| 3 | **공구(Toolbox)** | 어떻게 제대로 | ECC 에이전트·스킬 |

"Harness" 라는 말은 **계층 이름으로 쓰지 않는다.** 스킬 이름(`kdance-dev-harness`)으로만 남긴다.

### ② 한 줄 판별 기준을 넣는다

경계 분쟁이 나면 이 한 줄로 끝낸다.

| | 코드를 | 판별 |
|---|---|---|
| 명세 | **안 본다** (봐서도 안 된다) | 구현에 오염되면 "지금 있는 것" 에 맞춰 요구사항을 깎게 된다 |
| 파이프라인 | **본다** | Phase 2 가 명시적으로 코드를 조사한다 |
| 공구 | **고친다** | 실제 편집 주체 |

### ③ Spec Kit 을 `specify` 1개로 줄인다

`/speckit-clarify` · `/speckit-checklist` 를 「쓰지 않는 것」으로 옮긴다.

근거: **사용자가 현장에 있다.** clarify 는 답할 사람이 없을 때 spec 을 심문하는 도구다.
직접 물으면 더 빠르고 정확하다 — 실측: Q1·Q2·Q3 를 몇 분 만에 확정했다. checklist 는
`specify` 가 이미 `checklists/requirements.md` 를 낸다.

### ④ Phase 3·4 산출물 규격을 Spec Kit 템플릿 수준으로 올린다

**도구를 바꾸지 않고 규격만 빌려온다.**

| Phase | 지금 | 바꿀 것 |
|---|---|---|
| 3(구현 계획) | `03_impl-planner_plan.md` 1종 | `plan.md` + `data-model.md` + `contracts/` + `research.md` 로 분리. 「공유 계약」 번호 체계는 유지 |
| 4(Task 분리) | 파일/모듈 단위 | **User Story 단위 수직 슬라이스** + `[P]` 병렬 마커 + MVP-first 절 |

### ⑤ Phase 1 에 「슬라이스 절단」 책임을 명시한다

지금 Phase 1 은 "범위·제약·수용 기준" 만 한다. 여기에 **"spec 의 어느 부분을 이번 회차로
자를 것인가와 그 근거"** 를 추가한다. FR 185개를 통째로 넘길 수 없기 때문이다.

---

## 8. 바꾸지 않는 것

| 항목 | 이유 |
|---|---|
| Phase 9.5 학습 산출물 3종 | 이 프로젝트 목적의 절반. 대체물 없음 |
| SCH 추적과 현황판 | 코드 주석·커밋 메시지·가이드가 전부 이 번호에 걸려 있음 |
| 「공유 계약 §N」 인용 방식 | 문서와 코드를 묶는 끈. 실제로 불일치를 막아 왔음 |
| Phase 2 코드 구조 조사 | Spec Kit 에 없는 단계. 이 프로젝트에서 가장 값어치 있는 산출물 중 하나 |
| Phase 7↔8 서브 루프 | 리뷰 지적을 반영하는 경로 |
| ECC 6대 업무 | 제안안도 동일하게 평가함(🟢 거의 안 겹침) |

---

## 9. 제안안에서 받아들인 것 / 받지 않은 것

| 제안안의 주장 | 판정 |
|---|---|
| 파이프라인은 하나여야 한다 | ✅ **동의.** 현행도 같은 원칙 |
| ECC 의 Planning/Task 가 Spec Kit 과 충돌한다 | ✅ **동의.** 현행은 ECC 를 품질로 한정해 이미 해결 |
| Harness 는 환경 계층이다 | ✅ **부분 수용.** 환경 계층에 이름을 준다. 단 kdance 의 파이프라인과 구분 |
| Spec Kit = 설계자 (plan·tasks 까지) | ❌ **불채택.** 산출물 규격만 빌려오고 주인은 파이프라인 |
| Spec Kit 7개 전부 활성화 | ❌ **반대.** 오히려 1개로 줄인다 |
| 품질 Gate = Harness | ⚠ **제안안 내부 모순.** 환경이면서 파이프라인에 개입할 수 없다 |
| ECC = 공구상자 | ✅ 동의하되 **호출 주체(Phase 6/8)를 명시**해야 함 |

---

## 10. 남은 판단 — 사용자 확인 필요

이 보고서는 **권고안 C** 를 제시할 뿐 확정하지 않는다. 규칙을 고치는 것은
`core-rules.md` 를 바꾸는 일이라 사용자 결정 사항이다.

| 질문 | 선택지 |
|---|---|
| 어느 안으로 갈 것인가 | A(현행) / B(제안안) / **C(권고)** |
| C 로 가면 5가지를 전부 반영할 것인가 | 전부 / 일부 |

---

# 부록 · 2차 검토 (2026-09-21, 같은 날)

외부 분석이 한 번 더 들어왔다 — `ClaudeCode_SpecKit_Harness_ECC_최적역할분리.md`(845줄).
앞선 이미지 7장보다 정교하고, **제 규칙의 빈틈을 실제로 짚었다.**

## 이 문서의 주장

```
Spec Kit = WHAT / WHY          (SDD 전체 lifecycle)
Harness  = HOW THE AGENT WORKS (Rules · Context · MCP · Hooks · Permissions · Gates)
ECC      = HOW TO BUILD IT WELL
Claude   = EXECUTE
```

핵심은 앞선 제안과 같다 — **Spec Kit 에 `plan`·`tasks`·`analyze`·`converge` 까지 맡기고
Harness 를 운영 환경으로 둔다.** 다만 논거가 훨씬 낫고 다음 셋을 새로 짚었다.

## 이미 일치하던 것 — 5개

| 문서의 주장 | 우리 규칙 |
|---|---|
| Spec Kit = 제품 요구사항 SSOT | 계층 1 명세 |
| **Spec Kit = System Architecture / ECC = Implementation Architecture** | 매트릭스 SDD 행이 🟢 둘(시스템 관점·코드 관점) |
| ECC = 구현·품질 전담 | 계층 3 공구 6대 업무 |
| 세 도구가 같은 일을 하지 않게 | 절대 금지 패턴 |
| GSD OFF | kdance 는 GSD 미사용 |

## 받아들인 것 — 4개

### ① Quality Gates 를 환경 계층 업무로 승격 — **실측으로 확인된 구멍**

```
.claude/settings.json        → graphify 훅 2개뿐
.claude/settings.local.json  → hooks 없음
~/.claude/settings.json      → hooks 없음
```

format·lint·typecheck·test 를 **자동으로 강제하는 훅이 하나도 없다.** 지금은 Phase 6 이
"불러야" 돌고, 코드가 바뀔 때 막아서는 장치가 없다. 환경 계층 6대 업무에 명시했다.

**설치는 미룬다** — admin-web `npm run lint` 가 깨져 있고 DB 컨테이너가 미기동이라, 지금
훅을 걸면 정상 작업까지 매번 막힌다. 검증선을 고친 뒤에 건다.

### ② 테스트 3분할

명세 "무엇을 만족해야" · 공구 "어떻게 테스트" · 환경 "언제 강제". 기존 매트릭스는
테스트를 통째로 공구에 몰아놨다.

### ③ 보안 3분할

같은 구조. 명세가 요구사항을, 공구가 구현·검사를, 환경이 차단을.

### ④ ECC 계획 스킬 용도 제한 — 실제 충돌 위험

ECC 에 `ecc:planner`·`ecc:architect`·`ecc:plan`·`ecc:plan-prd`·`ecc:plan-canvas`·
`ecc:prp-plan`·`ecc:plan-orchestrate` 가 전부 깔려 있다. 기존 규칙은 "ECC 는 6대 업무만"
이라고만 했지 **"제품 계획에 쓰지 말라"** 를 명시하지 않았다. 받는 단위를 **Task 하나**로
못박았다.

## 받지 않은 것 — 1개

### ✗ Spec Kit 에 `plan`·`tasks`·`analyze`·`converge` 활성화

거절 근거는 **문서 흐름에 없는 단계 하나**다.

```
문서 §11:  Specify → Clarify → Plan → Tasks → Analyze → 구현 → Gates → Converge
                                   ↑
                       기존 코드를 조사하는 단계가 없다
```

**이 문서는 greenfield 를 전제한다.** kdance 는 아니다 — 테이블 7개, 테스트 118개,
FastAPI→Prisma 8 전환 중, admin-web lint 고장.

Phase 2(기존 코드 구조 확인)가 지난 회차에 실제로 찾은 것:

> Prisma 8 에 `FOR UPDATE` 빌더 API 가 없다(raw SQL 우회 가능) · SAVEPOINT 가 없다
> (전 패키지 grep) · `postgresServerless()` 가 `transaction()` 을 의도적으로 빼놨다
> → Vercel Edge 를 쓰면 취소 트랜잭션이 아예 불가능

**이건 spec 에서 나오지 않는다.** 설치된 `.d.mts`·`.mjs` 를 직접 읽어야 나온다. 코드를
보지 않는 계층이 세운 계획은 이 지점에서 무너진다. 그리고 Phase 9.5 학습 산출물 3종은
이 문서에도 갈 자리가 없다.

## 의도적 이탈 — `/speckit-clarify`

문서는 Clarify 를 ★★★★★ Spec Kit 으로 둔다. 우리는 쓰지 않는다.

> clarify 는 **답할 사람이 없을 때** spec 을 심문하는 도구다. 이 프로젝트는 1인 개발이라
> 사용자가 항상 현장에 있고 직접 묻는 쪽이 빠르다 — 실측: Q1·Q2·Q3 를 몇 분 만에 확정.

**되돌릴 조건** — 비동기로 일하는 사람이 늘거나, 사용자 부재중에 spec 을 써야 할 때.
