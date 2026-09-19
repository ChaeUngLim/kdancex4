# kdance (k-dancex4)

K-Social Dance 수업·행사·파티 멀티 에이전트 검색·예약·결제 시스템. FastAPI + SQLAlchemy2(backend) · Next.js(admin-web) · Expo(mobile).

## 이 저장소를 처음 보신다면 (학습 진입점)

이 프로젝트는 "Harness(작업 지휘) + ECC(품질 보증)" 구조로 개발됩니다. 코드를 훑기 전에 아래 순서로 보시면 전체 흐름과 각 조각이 왜 그렇게 짜였는지 이해하기 쉽습니다.

1. **[Harness × ECC 왕초보 완벽분석가이드](docs/harness-ecc-guide.html)** — 이 프로젝트를 어떤 방식(누가 무엇을, 누가 품질을 검사하는지)으로 개발하는지 그림으로 설명합니다.
2. **[SCH 진행 스케줄표](_workspace/kdance.html)** — 지금까지 어떤 조각이 어떤 순서로 만들어졌는지, 각 조각의 완료 상태를 한눈에 보여줍니다.
3. **SCH별 왕초보 완벽분석가이드** — 각 조각이 "무엇을, 왜, 어떤 이슈를 거쳐" 만들어졌는지 6개월차 비전공자 기준으로 설명합니다(위 스케줄표의 "가이드 보기" 링크로 연결됩니다):
   - [SCH-01 기반 배선](_workspace/guides/SCH-01.html) · [SCH-02 도메인 모델](_workspace/guides/SCH-02.html) · [SCH-03 환불액 산정](_workspace/guides/SCH-03.html) · [SCH-04 어댑터 3종](_workspace/guides/SCH-04.html) · [SCH-05 취소 오케스트레이션](_workspace/guides/SCH-05.html) · [SCH-06 스키마+라우터](_workspace/guides/SCH-06.html) · [SCH-07 DB 통합 테스트](_workspace/guides/SCH-07.html)
4. **소스 코드 안의 학습 주석** — `backend/app/` 하위 파일 상단에 "사전 개념 요약"과 함수별 위치 설명이 한국어로 달려 있습니다(`# 학습 주석: SCH-XX(기능명) 반영` 마커로 표시).

> 위 HTML 문서들은 GitHub에서는 원문(raw)으로만 보입니다 — 내려받아 브라우저로 열어야 다이어그램·스타일이 제대로 보입니다.

## 프로젝트 구조

- `backend/` — FastAPI API 서버(uv 관리). `uv run pytest`로 테스트.
- `admin-web/` — Next.js(App Router) 학원 관리자 콘솔. `npm run dev`/`build`.
- `mobile/` — Expo(React Native) 소비자 앱.
- `infra/` — 로컬 Postgres+pgvector, Redis용 `docker-compose.yml`.
- `docs/` — 정책/설계 문서, 왕초보 가이드.
- `.claude/` — 개발 하네스(kdance-dev-harness) 및 규칙(core-rules.md) 설정.

자세한 개발 규칙과 아키텍처 결정은 `CLAUDE.md`를 참고하세요.
