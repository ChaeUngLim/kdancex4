# 기능 정의서 — 역할별 지도

요구사항의 원본은 `specs/001-ai-dance-class-platform/spec.md` 다. 이 폴더는 그 요구사항을 **역할별·화면별로 모아 읽는 문서**다. 두 문서가 다르면 spec 이 맞다. 고칠 일이 생기면 spec 을 먼저 고치고 여기를 따라 고친다.

## 역할별 파일

| 역할 | 기능 정의서(규칙 원문) | 화면 기준 목록 | 쓰는 화면 |
|---|---|---|---|
| **회원** | [`member/member.md`](./member/member.md) | 없음 — 회원은 회원 앱 하나만 쓴다 | 회원 앱 (보드 M·C 계열) |
| **강사** | [`instructor/instructor.md`](./instructor/instructor.md) | [`instructor-app.md`](./instructor/instructor-app.md) · [`instructor-web.md`](./instructor/instructor-web.md) | 강사 앱이 본 작업장 (보드 I 계열). 관리자 웹은 대표가 권한을 맡겼을 때만 |
| **대표** | [`owner/owner.md`](./owner/owner.md) | [`owner-web.md`](./owner/owner-web.md) · [`owner-app.md`](./owner/owner-app.md) | 관리자 웹이 본 작업장 (보드 W 계열). 휴대폰에서 되는 일은 대표 앱에서도 (보드 O 계열) |

- **기능 정의서**에는 규칙이 있다. 옛 서비스 정의서의 해당 장을 원문 그대로 옮겼다.
- **화면 기준 목록**에는 「이 화면에서 무엇을 하나」만 있고, 규칙은 정의서의 절 번호로 가리킨다. 같은 규칙을 두 파일에 복사하지 않았다 — 한쪽만 고치면 어긋나기 때문이다.

## 역할에 걸치지 않는 파일

| 파일 | 내용 |
|---|---|
| [`00-overview.md`](./00-overview.md) | 서비스 한 줄 정의, 전체 구조, 역할별 재분석 요약, 최종 제품 정의 |
| [`events.md`](./events.md) | 이벤트·원데이·파티·공연·대회 |
| [`permissions.md`](./permissions.md) | 권한 구조, 웹·앱 역할 분리, 플랫폼 관리자 정산 콘솔 |

기술 문서는 `docs/planning/tech/`, 개발 우선순위는 `docs/planning/roadmap/` 에 있다. 전체 목차는 `docs/planning/kdancex4_service_definition_and_tech_stack.md` 다.
