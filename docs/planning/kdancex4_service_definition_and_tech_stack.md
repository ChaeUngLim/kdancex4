# kdancex4 — 서비스 정의·기술 스택 문서 목차

**2026-11-13 에 이 파일을 12개 파일로 나눴다.** 한 파일에 기능 정의·약관 설명·기술 스택·아키텍처가 섞여 있어서 역할과 성격별로 나눴다. 내용은 원문 그대로 옮겼고, 이 파일에는 「옛 장 번호가 어느 파일로 갔는지」만 남긴다. 이 경로를 가리키는 다른 문서가 많아서 파일 자체는 지우지 않았다.

요구사항의 원본은 `specs/001-ai-dance-class-platform/spec.md` 다. 아래 문서들과 spec 이 다르면 spec 이 맞다.

## 기능 정의서 — `docs/planning/features/`

역할별 지도는 [`features/README.md`](./features/README.md)에 있다.

| 옛 장 | 새 파일 | 내용 |
|---|---|---|
| 머리말 · 1장 · 2장 머리말 · 18장 | [`features/00-overview.md`](./features/00-overview.md) | 서비스 한 줄 정의, 전체 구조, 역할별 재분석 요약, 최종 제품 정의 |
| 2.1절 · 17장 「사용자」 | [`features/member/member.md`](./features/member/member.md) | **회원** 기능 정의서 |
| 3장 · 17장 「강사」 | [`features/instructor/instructor.md`](./features/instructor/instructor.md) | **강사** 기능 정의서 |
| (새로 씀) | [`features/instructor/instructor-app.md`](./features/instructor/instructor-app.md) | 강사 — 강사 앱에서 하는 일 |
| (새로 씀) | [`features/instructor/instructor-web.md`](./features/instructor/instructor-web.md) | 강사 — 관리자 웹에서 하는 일(위임받았을 때만) |
| 4장 · 17장 「대표」 | [`features/owner/owner.md`](./features/owner/owner.md) | **대표** 기능 정의서 (입점과 약관 동의 포함) |
| (새로 씀) | [`features/owner/owner-web.md`](./features/owner/owner-web.md) | 대표 — 관리자 웹에서 하는 일 |
| (새로 씀) | [`features/owner/owner-app.md`](./features/owner/owner-app.md) | 대표 — 대표 앱에서 하는 일 |
| 5장 | [`features/events.md`](./features/events.md) | 이벤트·원데이·파티·공연·대회 |
| 12장 · 13장 | [`features/permissions.md`](./features/permissions.md) | 권한 구조, 웹·앱 역할 분리, 플랫폼 관리자 정산 콘솔 |

## 기술 문서 — `docs/planning/tech/`

| 옛 장 | 새 파일 | 내용 |
|---|---|---|
| **11장** (11-1 ~ 11-3) | [`tech/tech-stack.md`](./tech/tech-stack.md) | **기술 스택 고정표** — 버전 값의 원본. 버전을 정한 이유, 알려진 위험, 백엔드 교체 |
| 6장 ~ 10장 | [`tech/ai.md`](./tech/ai.md) | AI 추천, AI 에이전트 역할, LLM·RAG, 임베딩·벡터 검색, 리랭커 |
| 19장 | [`tech/architecture.md`](./tech/architecture.md) | 최종 아키텍처 — 전체 다이어그램, 서브 다이어그램, 파이프라인 |
| 16장 | [`tech/data-model.md`](./tech/data-model.md) | 데이터 모델 핵심 엔티티 |
| 14장 · 15장 | [`tech/dev-environment.md`](./tech/dev-environment.md) | 개발 환경 — Claude Code·MCP·Skills, OmniRoute |

## 우선순위 — `docs/planning/roadmap/`

| 옛 장 | 새 파일 | 내용 |
|---|---|---|
| 20장 · 「2026-11-10 필수 기능 점검이 남긴 결정 질문」 | [`roadmap/priorities.md`](./roadmap/priorities.md) | 개발 우선순위, 핵심 방향, 결정 질문 |

## 약관 문서는 여기 없다

실제 약관은 `docs/legal/` 에, 정책은 `docs/policy/` 에 있다. 옛 4.1a절 「입점과 약관」은 대표가 입점할 때 무엇에 동의하는지를 적은 **기능 설명**이라 대표 기능 정의서에 두었다.

## 다른 문서가 옛 장 번호로 가리킬 때

다른 문서에 「서비스 정의서 11. 기술 스택 고정표」「정의서 373줄」처럼 옛 장 번호나 줄 번호가 남아 있으면 위 표로 찾는다. 각 새 파일 안의 제목에는 옛 장 번호(예: `## 11. 기술 스택 고정표`)를 그대로 남겨 두었다.
