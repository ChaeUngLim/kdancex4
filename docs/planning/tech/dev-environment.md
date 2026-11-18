# 개발 환경 — Claude Code·MCP·Skills·OmniRoute

> 출처: 옛 `docs/planning/kdancex4_service_definition_and_tech_stack.md` 의 14장 · 15장. 2026-11-13 파일을 나누면서 원문 그대로 옮겼다.
> 요구사항의 원본은 `specs/001-ai-dance-class-platform/spec.md` 다. 두 문서가 다르면 spec 이 맞다.

## 14. Claude Code + MCP + Skills

### 개발 철학

**Claude Code가 코드를 작성하고 MCP가 외부 도구/데이터에 연결되며 Skills가 반복적인 개발 작업의 절차를 표준화한다.**

```text
Claude Code
     │
     ├── Plugin
     │
     ├── MCP
     │
     └── Skills
           │
           ↓
      실제 프로젝트
```

### 현재 환경에서 핵심적으로 사용할 영역

#### MCP

| MCP | 역할 | 이유 |
|---|---|---|
| postgres-kdance | PostgreSQL DB | DB 구조/쿼리/데이터 확인 |
| chrome-devtools | 브라우저 | Web 디버깅/성능 확인 |
| playwright | E2E | 실제 사용자 흐름 검증 |
| context7 | 공식 문서 | 라이브러리 최신 문서 확인 |
| agent-reach | 외부 정보 | Agent의 외부 정보 접근 |
| claude-mem(`mem-search`) | 세션 기억 | 세션 사이 맥락 검색. memory MCP 는 2026-09-23 삭제(`CLAUDE-decisions.md` ADR-001) |
| mindpilot | 사고/계획 | 복잡한 작업 구조화 |

#### Plugin

| Plugin | 역할 | 이유 |
|---|---|---|
| ECC | 개발 작업 표준화 | 대규모 개발 작업 보조 |
| frontend-design | UI 구현 | 화면 설계 품질 보조 |
| harness | Agent 실행 관리 | 반복적인 Agent 작업 관리 |
| humanizer | AI 문체 개선 | AI 생성 문구를 자연스럽게 조정 |
| ui-ux-pro-max | UX/UI | 화면/UX 설계 보조 |

#### Skills

| Skill | 역할 | 사용하는 이유 |
|---|---|---|
| ai-image-creator | 이미지 생성 | 서비스 이미지/콘텐츠 제작 |
| anthropic:apply-thinking-to | 사고 구조화 | 복잡한 문제 분석 |
| anthropic:convert-to-todo | 작업 분해 | 큰 작업을 단계별 Task로 변환 |
| anthropic:update-memory-bank | 프로젝트 기억 | 장기 개발 맥락 유지 |
| architecture:explain-architecture-pattern | 아키텍처 설명 | 구조 검토/학습 |
| audit-session-metrics | 세션 분석 | Agent 작업 품질 확인 |
| ccusage | Claude 사용량 | 토큰/비용 확인 |
| cleanup-context | Context 정리 | 긴 세션 최적화 |
| diagram-this | 다이어그램 | 시스템 구조 시각화 |
| documentation | 문서화 | README/문서 자동화 |
| graphify | 코드 구조 시각화 | 프로젝트 이해 |
| humanizer-kr | 한국어 문체 | AI 문장 자연스럽게 수정 |
| kdance-dev-harness | 프로젝트 개발 | kdancex4 전용 개발 규칙 |

---

## 15. OmniRoute

현재 캡처상:

```text
omniroute MCP → failed
```

따라서 **핵심 기술 스택에 포함시키지 않는다.**

현재 구조는:

```text
Claude Code
 ├─ MCP
 ├─ Plugins
 └─ Skills
```

를 중심으로 구성한다.

향후 OmniRoute가 정상 연결되고 실제 모델 라우팅에 필요한 경우 별도 선택 구성으로 추가한다.
