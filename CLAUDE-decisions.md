# CLAUDE-decisions.md — 설계 결정 기록(ADR)

> **이 파일이 왜 있나.** 세션 기록은 claude-mem 이 자동으로 쌓지만, 이 PC 에만 있는
> 캐시라서 PC 교체·재설치·도구 교체 때 사라진다. 1년 넘게 가져가야 하는 판단은
> 여기(git)로 옮긴다. 옮기는 시점은 Phase 9.5(학습 주석 재구성·SCH 가이드 생성)다.
>
> **복제하지 않는다.** 이미 다른 문서에 원본이 있는 결정은 「원본 위치」만 적는다.
> 값을 두 곳에 두면 반드시 어긋난다(`core-rules.md` 「버전 정책」과 같은 원칙).

## 적는 기준

- **적는다**: 되돌리기 어렵거나, 다음 사람이 "왜 이렇게 했지?"라고 물을 판단.
  버린 대안과 버린 이유가 있는 것.
- **적지 않는다**: 코드·git 로그만 봐도 알 수 있는 것. 한 번 쓰고 끝나는 임시 조치.

## 항목 형식

```
## ADR-{번호}. {제목} ({YYYY-MM-DD})
- 상태: 채택 | 대체됨(→ ADR-N) | 폐기
- 맥락: 무엇이 문제였나
- 결정: 무엇을 골랐나
- 버린 대안: 무엇을, 왜 버렸나
- 근거: 커밋 해시 · 파일 경로 · 실측 결과 · claude-mem 관찰 ID
- 관련: SCH-XX(기능명) · 다른 ADR
```

---

## 원본이 다른 곳에 있는 결정 (색인)

| 날짜 | 결정 | 원본 위치 |
|---|---|---|
| 2026-09-14 | admin-web 을 Vite 에서 Next.js(App Router)로 | `CLAUDE.md` Project Overview |
| 2026-09-18 | OmniRoute 무료 모델은 Opus 소진 후 보조 채널로만 | `.claude/rules/core-rules.md` 「OmniRoute 무료 모델 사용 정책」 |
| 2026-09-20 | 버전은 호환되는 선에서 최신 | `.claude/rules/core-rules.md` 「버전 정책」, `docs/kdancex4_service_definition_and_tech_stack.md` 「11. 기술 스택 고정표」 |
| 2026-09-20 | `CLAUDE.md` 를 git 으로 추적 | `CLAUDE.md` Memory System |
| 2026-09-21 | 4계층(환경·명세·파이프라인·공구) 역할 정의 | `.claude/rules/core-rules.md` 「4계층 역할 정의」, `docs/role-split-analysis.md` |
| 2026-09-21 | spec-kit 은 `/speckit-specify` 하나만 사용 | `.claude/rules/core-rules.md` 「spec-kit 과의 역할 분리」 |

---

## ADR-001. 세션 기억을 claude-mem 으로, ECC 는 기억 담당에서 제외 (2026-09-23)

- 상태: 채택
- 맥락: 기억 장치가 넷(auto memory · ECC 세션 요약 · ECC instinct · memory MCP)이었는데,
  손으로 채워야 하는 장치는 전부 비어 있었다. memory MCP 그래프는 엔티티 0개, ECC
  instinct 0개(`~/.claude/homunculus` 폴더 자체가 없음), ECC 세션 요약의
  「Notes for Next Session」도 비어 있었다. 요약에는 요청 목록만 남고 해결 과정은
  남지 않아 "예전에 이 문제를 어떻게 풀었나"를 찾을 수 없었다.
- 결정: 역할마다 담당을 하나로 정한다.

  | 역할 | 담당 |
  |---|---|
  | 작업 기록(무슨 일이 있었나) | claude-mem — 로컬, `--provider claude`, Haiku 4.5, cloud sync·telemetry 끔 |
  | 행동 규칙(어떻게 일해야 하나) | Claude Code auto memory (feedback) |
  | 오래 남길 판단 | git 문서 — 이 파일, `CLAUDE-troubleshooting.md`, `docs/Review.md` |
  | 품질 검사·에이전트·스킬 | ECC (기억 관련 훅만 끔) |

  ECC 에서 끄는 훅: `stop:session-end` · `stop:evaluate-session` · `pre:observe`,
  그리고 `ECC_SESSION_START_CONTEXT=off`(`~/.claude/settings.json` env).
- 버린 대안:
  - **ECC 만 쓰기** — 자동 수집·검색이 없다. 압축 비용 말고는 앞서는 항목이 없었고,
    사용자가 비용은 판단 기준에서 빼라고 했다.
  - **ECC 와 claude-mem 동시 사용** — 세션 시작 때 요약이 두 번 주입된다.
  - **CMEM Pro(claude-mem 호스팅)** — 작업 기록이 외부 서버(cmem.ai)로 나간다.
    결제 기능이 있는 프로젝트라 거부.
  - **memory MCP 유지** — 몇 달간 한 번도 쓰이지 않았다. 삭제.
- 근거: `claude mcp list`(memory 제거 확인), `~/.claude-mem/settings.json`
  (`CLAUDE_MEM_PROVIDER=claude`, `CLAUDE_MEM_MODEL=claude-haiku-4-5-20251001`)
- 관련: `CLAUDE-troubleshooting.md` 「claude-mem 설치가 EALLOWSCRIPTS 로 중단」

---

## ADR-002. AI 에이전트 서버를 Python 으로 분리하고, DB 쓰기는 Next.js 하나로 모은다 (2026-09-24)

- 상태: 대체됨(→ ADR-003) — 서버 분리와 쓰기 규칙은 ADR-003 이 이어받고, **언어(Python)만 뒤집혔다**
- 맥락: 「11-3. 백엔드 교체」는 "TypeScript 단일 스택이라 Python 이 설 자리가 없다"며
  LangGraph 까지 JS 판(`@langchain/langgraph`)으로 Next.js 안에 넣는 구성이었다. 두 가지가
  걸렸다. ① 에이전트는 LLM 을 여러 번 부르는 긴 스트리밍 작업이다(동시 10명 완료 p95
  15~17초, `infra/ai-bench`). 짧은 예약·결제 요청과 한 프로세스에 두면 장애가 번진다.
  ② LLM 은 이미 앱 서버와 다른 장비(베타 노트북 GPU, 운영 GPU 서버)에 있다.
  반대로 에이전트만 Python 으로 떼면, 두 언어가 한 DB 를 만지면서 스키마 원본이 둘로
  갈라지고(Prisma 8 계약 + SQLAlchemy 모델) 인증 로직도 한 벌 더 필요하다.
- 결정: 서비스를 분리하되 **계산하는 쪽과 기록하는 쪽**을 나눈다.

  | 영역 | 담당 | 맡는 일 |
  |---|---|---|
  | 클라이언트 | mobile(Expo) · Next.js 화면 | 화면, AI SDK 채팅 UI |
  | 제품 API | **Next.js (TS)** | 인증(Better Auth), 도메인 로직, **DB·pgvector 쓰기 전부**(Prisma 8), 권한 검사, Triage 의 `T0`·`T1`·`T3`, 사람 이관 처리, 도구 서버(MCP) |
  | 에이전트 서버 | **Python** (FastAPI + LangGraph) | `T2` 추론(Search → Planner → Reviewer → Writer), 문서 처리 계산(OCR·구조화·청킹·임베딩), eval |
  | 모델 서빙 | llama-server 등 | LLM · 임베딩 · 리랭커. OpenAI 호환 API 로만 부른다 |

  규칙 세 가지:
  1. **DB 에 쓰는 곳은 Next.js 하나다.** 에이전트 서버는 DB 에 접속하지 않고, Next.js 가
     여는 도구(MCP·HTTP)로만 데이터를 읽는다.
  2. **벡터는 Python 이 계산하고 Next.js 가 기록한다.** 벡터는 원본(수업·강사·파티)의
     파생물이라, 원본과 같은 트랜잭션에서 함께 바뀌어야 한다. 예: 수업 취소와 그 벡터의
     비활성을 한 트랜잭션으로 묶는다. 두 서비스가 따로 커밋하면 "취소된 수업을 추천"하는
     중간 상태가 생긴다.
  3. **돈·사람이 걸린 판단은 Next.js 에서 끝낸다.** 에이전트는 이관을 제안만 하고
     실행하지 않는다.
- 버린 대안:
  - **LangGraph JS 를 Next.js 안에서 실행**(기존 11-3) — 장애 격리가 안 되고, 에이전트
    배포가 결제 코드 배포와 묶인다. Vercel 함수의 실행 시간 제한과도 맞지 않는다
    (제한값은 확인하지 않았다).
  - **Python 에이전트 서버가 DB 에 직접 읽고 쓰기** — 스키마 원본이 둘이 되고, 권한
    검사를 Python 에 다시 만들어야 한다. 원본과 벡터가 따로 커밋돼 불일치가 생긴다.
  - **에이전트 서버를 분리하되 TS 로** — 가능한 선택이다. 에이전트 추론만 놓고 보면
    TS 로도 충분하다. Python 을 고른 이유는 문서 처리(OCR·파싱)와 eval 까지 이 서버가
    맡기 때문이고, 이 영역은 Python 생태계가 확실히 두껍다. **문서 처리와 eval 이 베타
    범위에 들어가지 않으면 TS 안이 다시 유리해진다** — 그때 이 ADR 을 재검토한다.
  - **FastAPI 백엔드를 그대로 유지** — Better Auth·Prisma 8 이 TS 전용이다. 앱 백엔드는
    예정대로 Next.js 로 옮긴다.
- 근거: LangGraph 는 두 판 모두 활발하다(2026 릴리스 Python 39회 · JS 49회, 두 판 모두
  Postgres 체크포인터 제공 — 2026-09-24 레지스트리 조회). Better Auth 는 Prisma 8 과 같은
  `pg@8.22.0` 드라이버로 스모크 테스트 10항목 통과(2026-09-24). 이 판단을 내린 대화는
  claude-mem 2026-09-24 세션.
- 미확인:
  - Python 서버의 스트림을 AI SDK 7 채팅 UI 에 붙이는 방법. Python 이 AI SDK 스트림
    형식을 직접 내보낼지, Next.js 가 변환할지 확인하지 않았다
  - Python 쪽 패키지는 PyPI 조회만 했다. 설치해 보지 않았다
  - Prisma 8 계약과 Better Auth 인증 테이블의 관계(마이그레이션 충돌·`user` 외래키)
- 관련: `docs/kdancex4_service_definition_and_tech_stack.md` 「11. 기술 스택 고정표」·
  「11-3. 백엔드 교체」, `docs/kdance-beta-infra.html` 배포 구조도

---

## ADR-003. 에이전트 서버는 분리하되 TypeScript 로 — 포스터는 Qwen 비전으로 읽는다 (2026-09-24)

- 상태: **부분 대체됨(→ ADR-004)** — 에이전트 서버의 **언어(TypeScript)만** 뒤집혔다. 서버 분리·쓰기 규칙·모델 창구·포스터 비전·임베딩·리랭커 배치는 ADR-004 가 그대로 이어받는다
- 맥락: ADR-002 는 Python 을 고른 근거를 "문서 처리(OCR·파싱)와 eval" 에 두고, 둘이 빠지면
  TS 안을 재검토한다고 적었다. 같은 날 두 가지가 실측됐다.
  ① Qwen 3.5 9B 가 비전 인코더를 품고 있어 포스터를 **OCR 없이 한 번의 호출로** 구조화한다
  (합성 포스터 18/18, `docs/kdancex4_service_definition_and_tech_stack.md` 11-2 「Qwen 3.5 9B 비전 입력」·「Qwen 비전 서빙」).
  ② 그 호출을 **AI SDK 7 에서** 할 수 있다 — `@ai-sdk/openai-compatible` 3.0.55 +
  `supportsStructuredOutputs: true` 로 `json_schema` 가 전송되고 zod 검증까지 통과했다(18/18, 2회).
  남은 Python 의 몫(에이전트 추론·청킹·eval)은 전부 TS 로 된다.
- 결정:
  - **에이전트 서버는 계속 분리한다.** 이유는 언어가 아니라 성격이다 — 긴 LLM 호출
    (포스터 26~28초, T2 완료 p95 15~17초)을 결제·예약 요청과 한 프로세스에 두지 않는다.
  - **언어는 TypeScript.** Node 24 LTS + Hono(HTTP) + LangGraph JS + AI SDK 7 + MCP SDK.
    Hono 는 MCP SDK 가 이미 의존하는 서버 라이브러리라 새 계열을 들이지 않는다.
  - **모델에 닿는 곳은 에이전트 서버 하나다.** Next.js 는 llama-server·임베딩 서버를 직접
    부르지 않는다. 모델 위치(노트북 → GPU 서버)가 바뀌어도 에이전트 서버만 고친다.
  - ADR-002 의 쓰기 규칙 세 가지는 그대로다 — ① DB 에 쓰는 곳은 Next.js 하나,
    에이전트는 도구(MCP)로만 읽는다 ② 벡터는 에이전트가 계산하고 Next.js 가 원본과 같은
    트랜잭션으로 기록한다 ③ 돈·사람이 걸린 판단은 Next.js 에서 끝낸다.
- 에이전트 서버가 하는 일 — 세 가지뿐이다:

  | 일 | 들어오는 길 | 나가는 길 |
  |---|---|---|
  | **T2 질문**(Search → Planner → Reviewer → Writer) | Next.js 가 Triage 로 T2 를 골라 `POST /runs` (사용자 ID·권한 범위를 담은 단기 토큰 동봉) | 도구 호출은 MCP 로 Next.js 에, 답은 스트림으로 Next.js 에 돌려주고 Next.js 가 `useChat` 으로 흘린다. 이관이 필요하면 **제안 이벤트**만 보낸다 |
  | **포스터 읽기** | Next.js 가 원본을 R2 에 올리고 작업을 큐(기존 `kdance-redis`)에 넣는다. 에이전트 워커가 **동시 1건**으로 꺼낸다 | Qwen 비전 + `Output.object`(zod) → 결과를 Next.js 내부 API 로 돌려준다. Next.js 는 「확인 대기」로 저장하고, **업주가 확인해야** 수업으로 확정된다 |
  | **임베딩 계산** | Next.js 가 저장 직전에 `POST /embeddings` (동기, 짧다) | 벡터를 돌려주면 Next.js 가 원본과 한 트랜잭션으로 기록한다 |

- 구현 규칙(실측에서 나온 것):
  1. `createOpenAICompatible({ ..., supportsStructuredOutputs: true })` 필수. 끄면 스키마가
     빠진 `json_object` 만 가서 마크다운이 돌아온다(실측)
  2. 형식(날짜·시각·금액)은 **프롬프트로 유도하고 zod `regex` 로 검증**한다. llama-server 는
     JSON schema 의 `pattern` 을 생성 때 강제하지 않는다(실측) — zod 가 막아야 틀린 값이 안 들어간다
  3. 검증 실패는 1회 재시도, 그래도 실패하면 업주 직접 입력으로 넘긴다
  4. 체크포인터는 베타에서 메모리(`MemorySaver`). DB 에 접속하지 않는다
- 버린 대안:
  - **Python 에이전트 서버(ADR-002)** — 근거였던 OCR·문서 처리가 비전 호출 1회로 바뀌었다.
    남는 것은 두 언어의 비용(스키마 계약 두 벌, 검증선 두 벌, 생태계 두 개)뿐이다
  - **Next.js 안에서 직접 호출**(분리 없음) — 포스터 26~28초를 요청 처리 안에서 기다리게 되고,
    Vercel 에서는 노트북·GPU 서버의 모델에 닿지도 않는다
  - **별도 OCR 라이브러리**(PaddleOCR·docling) — 비전 1회 호출이 18/18 이라 필요 없다.
    실제 사진 포스터에서 정확도가 무너지면 그때 다시 본다
- 대가:
  - LangGraph 출력을 `useChat` 스트림으로 바꾸는 `@ai-sdk/langchain` 은 `ai` 를 **정확한 번호**로
    고정한다(3.0.113 → `ai` 7.0.113). 쓰게 되면 `ai` 와 함께 올려야 한다
  - VLM 은 틀릴 때 그럴듯하게 틀린다 — 업주 확인 단계를 빼지 않는다
- 미확인:
  - 실제 사진 포스터의 정확도(합성 1장만 쟀다)
  - LangGraph JS → AI SDK UI 스트림 연결을 돌려 보지 않았다
  - 운영 단계에서 Vercel 의 Next.js 가 GPU 서버 옆 에이전트 서버에 닿는 경로(터널·사설망).
    베타는 전부 노트북이라 문제가 없다
  - 큐 라이브러리(BullMQ 6.3.8 후보)는 조회만 했다
- 근거: 이 대화의 실측(2026-09-24) — 비전 GGUF 텐서 확인, Ollama·llama-server 비전 시험,
  mmproj VRAM 측정(A 7,869MiB · B 6,836MiB), AI SDK `json_schema` 시험.
  `infra/docker-compose.yml` 의 `--mmproj`·`--no-mmproj-offload`
- 관련: ADR-002(대체됨)
- 보강(2026-09-24, 같은 날): **임베딩·리랭커 배치** — 개발은 둘 다 NVIDIA 호스팅
  (`nemotron-3-embed-1b`, `llama-nemotron-rerank-vl-1b-v2`), 로컬 GPU 는 Qwen 채팅·비전 전용.
  이유: ① 로컬 llama.cpp 임베딩은 양방향 어텐션을 재현하지 못해 원본과 벡터 일치 0.82 ②
  리랭커 1B-v2 는 호스팅 종료·llama.cpp 미지원 ③ 임베딩을 GPU 에 올리면 비전을 CPU 로 내려야
  하는데, 그러면 포스터 처리 중 채팅 p95 가 24초로 무너진다. 반영 후 최악 부하에서 채팅 p95 6.98초.
  에이전트 서버 규칙 추가: 임베딩·리랭커 주소와 모델은 환경 변수, 벡터에 모델·엔진 기록, 리랭커
  실패 시 벡터 순위로 물러섬. **베타도 NVIDIA 호스팅으로 결정**(같은 날, 사용자 결정 — 위험 인지). 전제: 베타 사용자는 개발자 본인뿐(혼자 시험)이라 체험 범위로 본다 — 외부 사용자가 실제로 쓰기 시작하면 재검토:
  체험 약관 1.2항의 운영 사용 금지, 예고 없는 종료, 입력의 외부 전송이 알려진 위험이다.
  대비책 — 리랭커 실패 시 벡터 순위, 임베딩 실패 시 SQL 조건 검색으로 물러선다. 운영 단계에서 vLLM 자체 서빙으로 옮긴다. 상세: 기술 스택 문서 11-2 「임베딩·리랭커 배치」

---

## ADR-004. 에이전트 서버 언어를 Python 으로 — 채용·포트폴리오 가치를 기준에 넣는다 (2026-09-24)

- 상태: 채택 (ADR-003 의 언어 결정만 대체)
- 맥락: ADR-003 은 "혼자서 제품을 빨리, 덜 깨지게"라는 기준 하나로 TypeScript 를 골랐다.
  사용자가 두 가지를 짚었다. ① 실무에서 AI 에이전트 개발자는 Python 으로 채용하는 경우가 많다
  ② 이 프로젝트는 커밋·PR 을 면접담당자가 읽는 것을 전제로 한다(`core-rules.md` 「Git 커밋 / PR 설명」).
  "제품 백엔드는 다른 언어, AI 에이전트 서비스는 Python"은 대기업에서 흔한 구조다.
- 결정: **에이전트 서버는 Python**(FastAPI + LangGraph). 나머지는 ADR-003 그대로다.

  | 그대로인 것 (ADR-003) | 바뀐 것 |
  |---|---|
  | 에이전트 서버는 Next.js 와 분리된 별도 프로세스 | 언어 TypeScript → **Python 3.12** |
  | DB 쓰기는 Next.js 하나, 에이전트는 MCP 도구로만 읽는다 | Hono → **FastAPI** + uvicorn |
  | 모델을 부르는 곳은 에이전트 서버 하나 | LangGraph JS → **LangGraph(Python)** |
  | 하는 일 3가지: T2 추론 · 포스터 읽기 · 임베딩·리랭크 호출 | AI SDK(openai-compatible) → **langchain-openai / openai** |
  | 포스터는 Qwen 비전 1회 호출(OCR 없음), 업주 확인 후 확정 | zod → **pydantic**(에이전트 쪽). 계약은 JSON Schema 로 맞춘다 |
  | 임베딩·리랭커는 개발·베타 NVIDIA 호스팅 | 큐 BullMQ(Node 전용) → **Redis Streams**(언어 중립) |

- 판단 근거:
  - **노트북 자원은 차이를 만들지 않는다**(실측 2026-09-24): 에이전트 서버는 두 언어 모두 VRAM 0.
    WSL RAM 은 15.8GB 중 사용 가능 약 8.0GB(`kdance-llm` 4.7GB), 에이전트 서버는 약 0.2~0.5GB(추정).
    Python 3.14·uv 0.12 는 이미 설치돼 있고 `backend/` 도 uv·Python 3.12 다
  - **경계가 언어 비용을 줄인다**: ADR-003 이 에이전트 서버를 HTTP·MCP 로만 대화하고 DB 에 접속하지
    않게 잡아 뒀다. 그래서 ADR-002 때 걱정한 큰 비용(스키마 원본 두 벌, 인증 재구현)은 생기지 않는다
  - Python 생태계: LangGraph 원조 구현, 평가(eval)·문서 처리 도구가 두텁다
- 버린 대안:
  - **TypeScript 유지(ADR-003)** — 제품 속도는 가장 빠르다. 채용·포트폴리오 기준을 넣으면 우위가 줄어든다
  - **Next.js 안에서 에이전트 실행** — ADR-003 에서 버린 이유 그대로(장애 격리, 긴 작업, 모델 위치)
- 대가 (새로 생기는 일):
  - 계약 두 벌 — Next.js 의 zod 와 에이전트의 pydantic 이 같은 JSON Schema 를 가리키게 맞춘다
    (MCP 도구 스키마는 JSON Schema 라 두 언어가 그대로 읽는다)
  - 검증선 두 벌 — 에이전트 서버는 pytest + ruff
  - 채팅 스트림 — Python 이 AI SDK UI 스트림 형식을 직접 내보내거나 Next.js 가 변환해야 한다
- 구현 규칙 (ADR-003 실측을 Python 으로 옮긴 것):
  1. llama-server 에는 `response_format` 을 **`json_schema`** 로 보낸다. `json_object` 만 보내면 코드블록·마크다운이 온다(실측)
  2. 형식(날짜·시각·금액)은 프롬프트로 유도하고 **pydantic 으로 검증**한다. llama-server 는 schema 의 `pattern` 을 생성 때 강제하지 않는다(실측)
  3. 검증 실패는 1회 재시도, 그래도 실패하면 업주 직접 입력
  4. 임베딩은 `query: `·`passage: ` 접두어, 리랭커는 NVIDIA 호스팅 형식(`query.text`, `passages[].text`)
  5. 체크포인터는 베타에서 메모리. DB 에 접속하지 않는다
  6. 리랭커 실패 → 벡터 순위, 임베딩 실패 → SQL 조건 검색으로 물러선다
- 미확인:
  - Python → AI SDK `useChat` 스트림 연결(가장 불확실 — 구현 첫 단계에서 검증). 연결 방식은 ADR-005(에이전트 스트림은 자체 형식, 번역은 Next.js)로 정했다. 동작 검증은 아직이다
  - Python 클라이언트에서의 `json_schema` 경로(서버 동작은 AI SDK 시험으로 확인했지만 Python 클라이언트로는 안 돌렸다)
  - Redis Streams 를 Next.js·Python 이 함께 쓰는 구성, Python 패키지 설치
- 관련: ADR-002(같은 방향, 근거가 OCR 이었다가 사라짐) · ADR-003(언어만 대체됨)

## ADR-005. 에이전트 서버는 자체 스트림 형식으로 보내고, AI SDK 형식 번역은 Next.js 가 맡는다 (2026-09-25)

- 상태: 채택
- 맥락: 채팅 화면은 AI SDK(`ai` 7.0.113)의 `useChat` 으로 만든다. `useChat` 은 약속된 형식의
  스트림만 알아듣는다. 헤더 `x-vercel-ai-ui-message-stream: v1` 에 `text-start`·`text-delta`·`finish`
  같은 조각을 SSE 로 받는 형식이다(설치본 `admin-web/node_modules/ai/dist` 에서 확인).
  Next.js 안에서 AI SDK 로 모델을 부르면 이 형식이 저절로 나온다. 그런데 ADR-004(에이전트 서버만
  Python)로 모델을 부르는 곳이 Python 서버가 됐고 Python 에는 AI SDK 가 없다. ADR-004 가
  "가장 불확실"로 남긴 항목이 이것이다.
- 결정: **에이전트 서버는 자기 이벤트 형식으로 SSE 를 보내고 Next.js Route Handler 가 이를 AI SDK UI
  스트림으로 번역해 화면에 넘긴다.** 에이전트 서버는 AI SDK 를 모른다.

  ```
  에이전트 서버(Python) ──SSE, 자체 형식──▶ Next.js Route Handler(번역) ──AI SDK UI 스트림──▶ useChat
  ```

  이벤트 초안(이름과 필드는 구현 때 JSON Schema 로 고정한다):

  | 이벤트 | 뜻 | 대응 요구사항 |
  |---|---|---|
  | `queued{position, eta}` | 대기열 순번과 예상 대기 시간 | FR-261(대기열·순번 표시) |
  | `stage{name}` | 지금 단계(조건 분석·후보 찾기·답 작성) | FR-262(진행 단계·점진 표시) |
  | `text{sentence}` | 검사를 통과한 문장 하나 | FR-266(한국어로만 답)·FR-267(입력에 없는 사실 금지) |
  | `done{metrics}` | 완료. 대기·첫 내용·완료 시간, 모델 호출 수 | FR-274(질문별 측정 기록). 기록은 Next.js 가 한다 |
  | `error{fallback}` | 실패. 대체 답이나 사람 문의 안내 | FR-278(모델 장애 감지·자동 복구) |

- 판단 근거:
  - **형식 변경이 한 곳에서 끝난다.** AI SDK 는 메이저가 자주 바뀐다(6 → 7 에서 에이전트 API 가 바뀌었다).
    형식이 `v1` 에서 바뀌어도 Next.js 의 번역기만 고치면 되고 Python 쪽은 그대로다
  - **어차피 지나가는 길목이다.** 로그인 확인(Better Auth)과 측정값 기록(FR-274)을 Next.js 가 하므로
    화면의 요청은 Next.js 를 거친다. 번역도 거기서 하면 경로가 늘지 않는다
  - **경계가 ADR-004 와 맞는다.** 에이전트 서버는 HTTP·MCP 로만 대화하고 화면 기술을 모른다.
    모바일(Expo)이 같은 스트림을 받게 되어도 에이전트 서버는 고칠 것이 없다
- 버린 대안:
  - **Python 이 AI SDK 형식(UI Message Stream Protocol)을 직접 맞춰 보낸다** — 불가능한 길은 아니다.
    설치본 문서(`ai/docs/04-ai-sdk-ui/20-streaming-data.mdx`)에 Python·FastAPI 같은 외부 백엔드에서
    이 프로토콜로 보낼 수 있다고 나와 있다. 번역 코드가 없어 경로도 가장 짧다. 버린 이유는 결합이다.
    Python 라이브러리가 없어 형식을 손으로 맞춰야 하고 AI SDK 가 형식을 바꿀 때마다 Python 도 함께
    고쳐야 한다
- 대가: Next.js 에 번역기 코드가 생긴다(이벤트 5종 → AI SDK 조각). 번역기 단위 테스트가 필요하다
- 번역에 쓸 API (설치본 `ai` 7.0.113 의 `index.d.ts`·`docs/04-ai-sdk-ui/20-streaming-data.mdx` 에서 확인):
  - Route Handler 에서 `createUIMessageStream({ execute: ({ writer }) => ... })` 로 스트림을 열고
    `writer.write({ type: 'text-delta', ... })` 로 조각을 쓴다. 응답은 `createUIMessageStreamResponse`
  - `queued`·`stage` 는 `data-*` 조각에 `transient: true` 를 붙여 보낸다. 대화 기록에 남지 않고
    화면의 `useChat` `onData` 에서만 받는다. 순번·진행 표시처럼 지나가는 정보에 맞는다
- 미확인: 위 API 로 실제 Python SSE 를 번역해 화면까지 흘려 본 적은 없다. 에이전트 서버를 만들 때
  첫 단계에서 끝에서 끝까지 한 번 통과시킨다
- 관련: ADR-004(에이전트 서버만 Python) — 그 "미확인" 첫 항목의 연결 방식을 정한 것이다
