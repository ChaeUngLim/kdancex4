# SCH별 왕초보 완벽분석가이드 (HTML) 표준

## 목적

`beginner-comment-style.md`가 **소스 코드 안**에 지도바둑식 학습 주석을 남기는 표준이라면,
이 문서는 **소스 밖**에서 SCH 하나의 작업 전체를 왕초보가 처음부터 끝까지 따라갈 수 있게
정리한 HTML 가이드의 표준이다. 대상 독자는 `beginner-comment-style.md`와 동일(개발 경력
약 6개월, 비전공자).

## 적용 시점 (트리거)

`beginner-comment-style.md`의 트리거와 동일 — `_workspace/kdance.html`에서 특정 SCH 항목이
"완료"로 바뀌는 시점에, Phase 9.5의 일부로 함께 생성한다(소스 학습 주석 재구성과 같은 단계,
별도 승인 불필요).

## SCH 표기 규칙

`beginner-comment-style.md`의 "SCH 표기 규칙"과 동일 — 번호만 단독으로 쓰지 않는다.
목차, "다른 SCH와의 연관관계"의 `.flow` 다이어그램/표, 본문 어디서든 SCH를 새로
언급할 때는 `SCH-04(어댑터 3종: PG/알림/슬롯락)`처럼 기능명을 괄호로 붙인다. 기능명은
`_workspace/kdance.html`의 해당 SCH 공식 문구를 그대로 쓴다. 같은 문단/같은 다이어그램
박스 안에서 반복 언급할 때만 번호 단독 표기를 허용한다.

## 저장 위치 / 네이밍

- `_workspace/guides/SCH-{번호}.html` (예: `_workspace/guides/SCH-05.html`)
- `_workspace/kdance.html`의 해당 SCH `.item` 블록에 `가이드 보기` 링크를 추가해 연결한다
  (`<a class="guide-link" href="guides/SCH-05.html">가이드 보기 →</a>`).
- 시각 스타일은 기존 `docs/payment-system-guide-for-beginners.html`의 다크 테마 CSS를
  그대로 재사용한다(`:root` 색상 변수, `.callout`, `.flow`, `.badge`, `details` 등) —
  프로젝트 안에서 "완벽분석가이드"라는 이름의 문서는 톤과 스타일이 통일되어 있어야 한다.

## 필수 구성 (섹션 순서)

1. **개요** — 이 SCH가 무엇을 만들었는지 2~3문장. `_workspace/kdance.html`의 해당 SCH
   한 줄 설명을 확장한 수준.
2. **사전 개념** — 이 SCH를 이해하는 데 필요한 배경 개념. `beginner-comment-style.md`의
   "사전 개념 요약"과 내용은 같되, 여기서는 왕초보 독자를 위해 문단 형태로 더 풀어써도
   된다. 이전 SCH가 이미 설명한 개념은 반복하지 않고 "SCH-XX(기능명) 가이드 참고" 링크로
   대신한다(`<a href="SCH-01.html#개념-앵커">SCH-01(기반 배선)에서 설명함</a>`).
3. **무엇을, 왜 이렇게 만들었나** — 변경/신규 파일 목록과 핵심 설계 판단. `_workspace/05_
   implementer_TS-{번호}_summary.md`의 "변경 파일"·"구현 중 발견한 이슈" 중 **설계 판단**에
   해당하는 부분을 왕초보 언어로 번역한다(전문 용어를 처음 쓸 때 괄호로 짧게 풀이).
4. **이슈 → 원인 파악 → 해결** — 이 SCH 작업 중 실제로 발생한 문제들을 하나씩:
   - 무슨 일이 있었나(현상)
   - 왜 그랬는지(원인 파악 — 근본 원인)
   - 어떻게 해결했는지(또는 왜 이번 SCH 범위에서 해결하지 않고 다음 SCH로 넘겼는지)
   `_workspace/05_implementer_TS-{번호}_summary.md`의 "구현 중 발견한 이슈"·"미해결 사항"
   절이 원 소스다 — 지어내지 않는다. 실제로 기록된 이슈가 없으면 "이번 SCH는 계획대로
   진행되어 별도 이슈가 없었다"고 명시한다(과장 금지, core-rules.md).
5. **테스트로 확인한 것** — 실행한 테스트 명령과 결과(예: `51 passed`), 그리고 "이 테스트가
   실제로 무엇을 증명하는지"를 왕초보 언어로 설명한다. Docker/DB 등 인프라 문제로 **검증하지
   못한 부분**은 반드시 별도로 표시한다(예: 경고색 `.callout.warn`) — 통과로 오해하게 두지
   않는다.
6. **다른 SCH와의 연관관계** — 이 SCH가 어떤 SCH 위에 쌓였고(선행), 어떤 SCH가 이 SCH의
   결과물을 이어받는지(후속)를 `.flow` 다이어그램 + 표로 정리하고, 각 항목을 해당
   `SCH-XX.html`로 링크한다. 단순 나열이 아니라 "왜 이 순서여야 하는지"(의존 이유)를
   한 줄씩 붙인다.
7. **다음 SCH로 이어지는 것** — 이 SCH가 다음 SCH에게 남긴 인터페이스/주의사항(있다면),
   즉 implementer 산출물의 "인계 사항"을 요약.

## 작성 원칙

- 이 문서의 사실관계(이슈/원인/해결/테스트 결과/인계 사항)는 전부 `_workspace/05_
  implementer_TS-{번호}_summary.md`, `_workspace/06_test-runner_results.md`,
  `_workspace/08_code-reviewer_review.md`, `_workspace/09_completion-verifier_report.md`
  중 존재하는 것에서 가져온다 — 추측이나 미화 금지.
- 코드 조각을 인용할 때는 `beginner-comment-style.md`가 이미 그 파일에 반영한 학습
  주석과 모순되지 않게 쓴다(같은 프로젝트 안에서 두 문서의 설명이 어긋나면 안 된다).
- 한국어로 작성한다(core-rules.md 언어 규칙).

## 하네스 연계 (kdance-dev-harness 오케스트레이터)

Phase 9.5 안에서 `beginner-comment-style.md` 기반 소스 재구성과 **같은 호출**로 처리한다:

1. `kdance-implementer`를 "주석 재구성" 태스크로 재호출할 때, 이 문서 경로도 함께 입력으로
   전달하고 `_workspace/guides/SCH-{번호}.html` 생성까지 같은 태스크에 포함한다.
2. 생성 후 `_workspace/kdance.html`의 해당 SCH `.item`에 가이드 링크를 추가한다(SCH 완료
   갱신과 같은 시점).
3. SCH 대응 관계를 알 수 없는 작업은 `beginner-comment-style.md`와 동일하게 이 단계를
   건너뛴다.
