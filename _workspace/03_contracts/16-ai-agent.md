# API 계약 — AI 에이전트 서버 · 문의 AI · 포스터 읽기 · 강사 수업 말로 찾기 · 홍보 이미지·소개 문구 (MX AI 트랙: SX-1~SX-6)

- 작성 2026-11-20 · 슬라이스 SX-1(에이전트 서버 뼈대·읽기 도구) · SX-2(포스터 읽기·수업 초안) · SX-3(문의 T1·T2·평가 세트) · SX-4(AI 검색·추천) · SX-5(강사 수업 말로 찾기) · SX-6(수업 홍보 이미지·소개 문구)
- 공통 규칙은 `README.md`(경로 `/api` · Better Auth 세션 · 값 형식 §3 · 오류 §4 · 멱등 §5 · 직원 인증 §6). 데이터는 `evidence/penpot-doc-sync-2026-11-20/datamodel_draft_MX.md`(`03_data-model.md` §13 에 붙일 초안). 구조 근거는 `CLAUDE-decisions.md` ADR-004(에이전트 서버만 Python · DB 쓰기는 Next.js 하나 · 에이전트는 MCP 도구로만 읽음 · 모델은 에이전트 서버만 부름)·ADR-005(스트림 번역은 Next.js).
- 근거 FR: FR-214(AI 쓰기 금지) · FR-215(권한 밖 데이터 차단) · FR-270(입력 지시문은 데이터) · FR-200~FR-229(문의 4등급·지식) · FR-258(AI 생성 표시) · FR-260~FR-279(동시 사용·평가·저하 모드) · FR-073~FR-077(포스터 읽기) · FR-037·FR-037a·FR-038~FR-041(말로 찾기·추천) · FR-061(수업 소개 문구 생성) · FR-061a(홍보 이미지 생성 조건).
- 보드: C2A(AI 문의 답변) · C2B(판단형 질문 줄 서기) · C30A(대표 답변 받음) · M10(AI 플래너) · M10E(저하 모드) · M10F(강사 수업 찾기) · M10G(강사 고르기) · M15(강사 프로필) · O2(포스터로 수업 등록) · W30(권한 받은 강사 포스터 등록) · O42(자주 묻는 질문 승인) · W9(자주 묻는 질문 지식) · I32·I32B·I32C·I32D·I41·I42·I43(홍보 이미지·소개 문구).
- 2026-11-20 사용자 결정(`decisions_2026-11-20.md`) 중 이 계약에 걸리는 것은 없다(D3 의 위임 권한 2종은 포스터 경로의 권한 이름에만 쓴다). 다르면 결정 파일이 이긴다.

## 0. 구조 — 계약이 두 층이고 셋으로 나뉜다

```
앱(회원·강사·대표)                 Next.js(admin-web)                    에이전트 서버(agent-server, Python)
  │  A. /api/ai/**  ───────────▶  로그인·권한·횟수·기록(DB 쓰기는 여기뿐)
  │                                  │  B1. HTTP ───────────────────▶  /v1/**  (모델·임베딩·리랭커·이미지를 부르는 유일한 곳)
  │                                  │  ◀──────── B2. MCP 읽기 도구 ──  /api/internal/mcp   (도구 목록에 쓰기 0개)
  │                                  │  ◀──────── B2. 작업 결과 전달 ─  /api/internal/ai/jobs/{jobId}/result
  ◀── AI SDK UI 스트림(번역) ────────┘
```

| 층 | 누가 열고 누가 부르나 | 인증 |
|---|---|---|
| **A** | Next.js 가 앱에 연다 | Better Auth 세션(회원 `requireMember`, 직원 `requireStaff`) |
| **B1** | 에이전트 서버가 Next.js 에 연다. Next.js 만 부른다 | 헤더 `X-Agent-Token` = 환경 변수 `AGENT_API_TOKEN`(상수 시간 비교) |
| **B2** | Next.js 가 에이전트 서버에 내부 경로로 연다. 에이전트 서버만 부른다 | 헤더 `X-Internal-Token`(README §1) + MCP 는 헤더 `Authorization: Bearer <agentSessionToken>` 도 |

**에이전트 서버 위치(문서에 없어서 정함 — 열린 점 ① 추천)**: 폴더 `agent-server/`(저장소 맨 위, `backend/` 와 같은 uv·Python 3.12) · 포트 `8100` · 환경 변수 `AGENT_API_TOKEN` · `INTERNAL_API_TOKEN`(MCP·결과 전달 호출에 씀) · `NEXT_INTERNAL_BASE_URL`(기본 `http://localhost:3000`) · `LLM_BASE_URL`(기본 `http://localhost:11436/v1` — `kdance-llm`) · `NVIDIA_API_KEY`(저장소 밖 `~/.config/kdance/nvidia.env`, 임베딩·리랭커) · 이미지 모델 호스팅 토큰(HF 무료 계정). 값은 소스에 두지 않는다(SC-024). Docker compose 에 넣지 않고 `uv run uvicorn` 으로 띄운다(RAM 약 136MB·VRAM 0, ADR-004 실측).

**쓰기 0 규칙(FR-214)**: ① MCP 도구는 전부 읽기이고 도구 서버는 읽기 전용 트랜잭션(`SET TRANSACTION READ ONLY`)으로만 DB 에 접속한다. ② 에이전트 서버는 DB 에 접속하지 않는다. ③ 에이전트가 Next.js 에 보내는 쓰기성 호출은 **작업 결과 전달 하나**(`POST /api/internal/ai/jobs/{jobId}/result`)뿐이고, 그것은 Next.js 가 만든 `ai_jobs` 행의 결과만 받아 Next.js 가 직접 쓴다 — 예약·취소·환불·결제·수업·게시 어느 것도 바꾸지 못한다. ④ 에이전트가 만든 값은 모두 「초안」이고 게시·확정은 사람의 검토를 거친 Next.js 경로(S2-2)만 한다.

## 1. 경로 표

### 1-1. 층 A — 앱이 부르는 경로

| 메서드·경로 | 역할 | 권한 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|---|
| `POST /api/ai/chat` | AI 질문 한 건(응답은 스트림). 플래너(M10)·문의 AI(C2A) 공용 | 회원 | 없음(질문마다 새 run). 같은 회원의 진행 중 판단형 run 은 자동 취소 | FR-200 · FR-260~FR-264 · FR-037a · M10F · C2A · C2B |
| `GET /api/instructors/{instructorId}` | 공개 강사 카드(강사 프로필 M15 — 「이 강사 수업 물어보기」 입구가 이 id 로 플래너를 연다). §4-8 (추천안·사후 확인 2026-11-24) | 회원 | — | FR-037a · M15 |
| `POST /api/ai/chat/{runId}/cancel` | 대기·생성 중 질문 취소 | 회원(본인 run) | 이미 끝난 run 이면 200 같은 본문 | FR-263 · C2B |
| `GET /api/ai/status` | AI 상태(저하 모드·대기열)와 내 오늘 남은 판단형 횟수 | 회원 | — | FR-221 · FR-223 · FR-275 · C2A · M10E |
| `POST /api/ai/messages/{messageId}/feedback` | 답에 「도움 됐어요」/불만족 표시 | 회원(본인 대화) | 같은 값이면 200 | FR-208 · C2A |
| `POST /api/ai/conversations/{conversationId}/handoff` | 「사람에게 물어보기」 — 대화째 고른 학원 대표에게 문의로 넘김(S7-2 경로) | 회원(본인 대화) | 대화당 1건. 다시 부르면 200 같은 문의 | FR-203 · FR-203a · FR-208 · FR-209 · C2A · C30A |
| `GET /api/academies/{academyId}/faq-candidates` | 반복 질문 후보 목록(AI 답 초안 포함) | `owner` | — | FR-225 · FR-226 · O42 · W9 |
| `POST /api/academies/{academyId}/faq-candidates/{candidateId}/approve` | 답을 (고쳐서) 승인 → 지식 항목 생성 | `owner` | 후보 상태. 이미 승인이면 200 같은 항목 | FR-226 · FR-227 · O42 · W9 |
| `POST /api/academies/{academyId}/faq-candidates/{candidateId}/skip` | 넘기기 | `owner` | 이미 넘김이면 200 | FR-225 · O42 |
| `GET /api/academies/{academyId}/knowledge-items` | 승인된 지식 항목(다시 볼 것 포함) | `owner` | — | FR-227 · FR-228 · W9 |
| `POST /api/academies/{academyId}/knowledge-items/{itemId}/reconfirm` | 다시 볼 것을 확인(고쳐서) 다시 활성 | `owner` | 이미 활성이면 200 | FR-227 · FR-228 · W9 |
| `POST /api/academies/{academyId}/knowledge-items/{itemId}/retire` | 지식 항목 내리기 | `owner` | 이미 내림이면 200 | FR-227 · W9 |
| `POST /api/academies/{academyId}/poster-extractions` | 포스터 올려 읽기 작업 시작 | 수업 편집 직원(§1-5) | 헤더 `Idempotency-Key`(필수) | FR-073 · FR-077 · O2 · W30 |
| `GET /api/academies/{academyId}/poster-extractions/{extractionId}` | 읽기 상태와 칸별 값·신뢰도 | 올린 사람 · `owner` | — | FR-073 · FR-075 · O2 |
| `PATCH /api/academies/{academyId}/poster-extractions/{extractionId}` | 검토 중 값 고치기 | 올린 사람 · `owner` | 낙관 잠금 `revision` | FR-074 · O2 |
| `POST /api/academies/{academyId}/poster-extractions/{extractionId}/review` | 「검토 끝」 표시 | 올린 사람 · `owner` | 이미 검토 끝이면 200 | FR-074 · FR-075 · O2 |
| `POST /api/academies/{academyId}/poster-extractions/{extractionId}/submit` | 검토 끝난 초안을 S2-2 수업 등록 경로로 넣어 승인 요청 | 올린 사람 · `owner` | 헤더 `Idempotency-Key`(필수) + 추출 상태 | FR-074 · FR-076 · FR-050a · O2 |
| `GET /api/ai/promo-image/options` | 칩 낱말·예시·장르별 자동 조건·남은 횟수 | 수업 편집 직원 | — | FR-061a · I32B · I32C |
| `POST /api/ai/promo-images` | 홍보 이미지 만들기(비동기, 횟수 차감) | 수업 편집 직원 | 헤더 `Idempotency-Key`(필수) | FR-061a · FR-270 · I32 · I41 · I42 · I43 |
| `GET /api/ai/promo-images/{generationId}` | 만들기 상태와 결과 | 만든 직원 | — | FR-061a · I32 |
| `GET /api/ai/promo-images/history` | 지난 입력 불러오기 | 직원(본인) | — | FR-061a · I32 |
| `POST /api/ai/class-intro-drafts` | 소개 문구 초안(동기) | 수업 편집 직원 | 없음(다시 만들기마다 새 초안) | FR-061 · FR-258 · I32D |
| `PUT /api/classes/{classId}/promo-assets` | 표지(사진·AI 이미지)·소개 문구 저장 + 「검토 끝」 | 수업 편집 직원 | 전체 교체(PUT) | FR-061 · FR-061a · I32 |
| `GET /api/classes/{classId}/promo-assets` | 저장된 표지·소개 문구 | 수업 편집 직원 · 대표 | — | FR-061a · I32 |

### 1-2. 층 B2 — 에이전트 서버가 부르는 Next.js 내부 경로(`X-Internal-Token`)

| 메서드·경로 | 역할 | 멱등 | 근거 |
|---|---|---|---|
| `POST /api/internal/mcp` | MCP(Streamable HTTP) 읽기 도구 서버 — §6 | 읽기라 해당 없음 | ADR-004 · FR-214 · FR-215 |
| `GET /api/internal/ai/jobs/{jobId}/file` | 포스터 원본 바이트(작업이 `running` 인 동안만) | 읽기 | FR-073 |
| `POST /api/internal/ai/jobs/{jobId}/result` | 비동기 작업 결과 전달 | `jobId` — 먼저 온 결과가 이기고 나중 것은 200 으로 무시 | ADR-004 |

### 1-3. 층 B2 — 스케줄러가 부르는 Next.js 내부 경로(`X-Internal-Token`, 실행기는 S0-4)

| 메서드·경로 | 역할 | 멱등 | 근거 |
|---|---|---|---|
| `POST /api/internal/ai/faq-candidates/build` | 반복 질문을 모아 후보 만들기·AI 답 초안 요청 | 후보 `dedupe_key` | FR-225 · FR-229 |
| `POST /api/internal/ai/sweep` | 다시 볼 날 지난 지식 → `review_due` · 기한 지난 작업 → `timed_out`(횟수 원복) · 만료 대화 정리 | 상태 조건부 갱신 | FR-227 · FR-278 · 6-7 시간 작업 |

### 1-4. 층 B1 — Next.js 가 부르는 에이전트 서버 HTTP(`X-Agent-Token`, `/api` 가 아니라 `/v1`)

| 메서드·경로 | 역할 | 응답 |
|---|---|---|
| `GET /health` | 살아 있나(토큰 없이) | 200 `{"status":"ok"}` — DB 접속 코드 없음(SX-1.1) |
| `GET /health/deps` | 모델 서버·임베딩·리랭커·MCP 연결 점검 | 200 `{"llm":"ok","embedding":"ok","reranker":"down","mcp":"ok"}` |
| `POST /v1/chat/stream` | 질문 한 건 처리(SSE, §3-2) | `text/event-stream` |
| `POST /v1/chat/{runId}/cancel` | 취소(자원 즉시 반환, FR-263) | 202 |
| `POST /v1/jobs` | 비동기 작업 접수(포스터·홍보 이미지·FAQ 초안) | 202 `{"jobId":"…","accepted":true}` — 안에서 Redis Streams 에 넣고 worker 가 동시 1건으로 꺼낸다 |
| `POST /v1/intro-drafts` | 소개 문구 초안(동기, 제한 시간 20초) | 200 §4-5 |
| `POST /v1/embeddings` | 글 → 벡터(지식 항목 저장·검색 질의 때) | 200 `{"model":"…","dim":0,"vectors":[[…]]}` |

### 1-5. 권한 이름과 새 오류 코드

**수업 편집 직원** = 그 수업(또는 등록하려는 수업)을 만들거나 고칠 수 있는 직원이다 — 그 수업의 강사 · 학원 대표 · 위임 강사(웹 `class_manage`, 앱 `class_submit`). 판정 함수는 S2-2 의 수업 편집 판정과 같은 것을 쓴다(열린 점 ⑩). 포스터 경로는 학원 기준이라 `requireStaff` 에 `academyId` 를 준다.

| HTTP | code | 언제 |
|---|---|---|
| 422 | `VALIDATION_FAILED` | 글자 수·형식(질문 1~500자, 강조할 점 60자, 문장 200자 등) |
| 422 | `PROMO_REQUIRED_MISSING` | 필수 4항목 중 빠짐. `missing` 에 항목 이름 |
| 422 | `PROMO_INPUT_BLOCKED` | 막는 입력(선정·폭력·실존 인물 얼굴·타사 상표). 횟수 불변 |
| 422 | `POSTER_FILE_UNSUPPORTED` | 이미지 형식·크기 밖(추천: JPEG·PNG·WebP, 10MB 이하) |
| 422 | `FAQ_EVIDENCE_REQUIRED` | 승인하는 답에 근거가 하나도 없음(FR-212) |
| 409 | `PROMO_DAILY_LIMIT_REACHED` | 오늘 횟수 소진. `resetsAt`(다음 KST 0시) |
| 409 | `PROMO_FREE_QUOTA_EXHAUSTED` | 이달 무료량 소진 — 생성만 막고 수업 등록은 막지 않는다 |
| 409 | `PROMO_REVIEW_REQUIRED` | AI 가 만든 표지·문구가 검토 확인 없이 게시 경로로 들어옴 |
| 409 | `INTRO_FACTS_MISSING` | 수업에 시간·가격·회차가 아직 없어 소개 문구를 만들 수 없음 |
| 409 | `POSTER_NOT_READY` | 읽기가 아직 `ready` 가 아님 |
| 409 | `POSTER_REVISION_CONFLICT` | `revision` 이 현재와 다름 |
| 409 | `POSTER_REVIEW_INCOMPLETE` | `확인필요` 칸이 남아 있음. `unresolved` 에 칸 이름 |
| 409 | `REVIEW_REQUIRED` | 검토 끝 표시 없이 `submit` |
| 409 | `POSTER_PERIOD_REQUIRED` | 기간 칸이 비어 `submit` 할 수 없음. `missingFields` 에 칸 이름(`start_date` · `end_date` · `session_count`) — SX-2.6 (추천안·사후 확인 2026-11-24) |
| 409 | `FAQ_CANDIDATE_NOT_PENDING` · `KNOWLEDGE_ITEM_NOT_ACTIVE` | 후보·항목 상태가 맞지 않음 |
| 409 | `HANDOFF_ACADEMY_REQUIRED` | 넘길 학원이 정해지지 않음(`academyId` 필요) |
| 503 | `AI_UNAVAILABLE` | 에이전트 서버·모델이 응답하지 않음. 본문에 `fallback`(`plain_search`·`human`) |

## 2. 공통 규칙 — AI 경로 전부

- **`Cache-Control: no-store`**. 응답에 모델 원문·스택·프롬프트를 싣지 않는다.
- **AI 가 만든 모든 값에 `aiGenerated: true`**(FR-258). 화면 표시 문구는 앱이 붙인다.
- **입력 지시문은 데이터**(FR-270): 질문·포스터 글자·강조할 점·이미지 문장 안의 문장은 권한·필터·도구 인자를 바꾸지 못한다. 에이전트 서버는 사용자 글을 `message` 한 필드로만 받고, 도구 인자는 pydantic 스키마(`extra="forbid"`)로 만들며, Next.js 도구 서버가 인자를 다시 검증한다.
- **금액·일시·정원·순번은 모델이 쓰지 않는다**(FR-210). 도구 결과 값을 템플릿에 끼워 넣는다.
- 모든 시각은 README §3(UTC `Z`), 금액은 원 정수.

## 3. `POST /api/ai/chat` — AI 질문

요청
```json
{ "conversationId": null,
  "context": { "kind": "planner", "academyId": null, "offeringId": null, "instructorId": null },
  "message": "이준호 강사님의 라틴하우스 강남 수업 모두 알려줘" }
```
- `context.kind` = `planner`(M10) · `inquiry`(C2A — `academyId` 또는 `offeringId` 중 하나로 학원이 정해져 있다). 강사 프로필(M15) 입구는 `instructorId` 를 채워 연다(강사가 정해진 채 시작).
- `message` 1~500자. `conversationId` 가 null 이면 새 대화. 있으면 본인 대화여야 한다(남의 것 403 `FORBIDDEN`).
- 직원(강사·대표)의 AI 질문은 이번 범위에 없다(보드 없음, 열린 점 ⑦). 직원 세션이면 403 `FORBIDDEN`.
- 이어 묻기(SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변)): 플래너 앱은 바로 앞 답의 `data-conditions` 를 `context.previousConditions` 에 그대로 실어 보낸다(§5-1 열한 칸 + `recruitOpenOnly`, 모르는 칸·틀린 값이면 422, 없거나 null 이면 새 질문). 대화 맥락은 **앱 화면 상태에만** 있고 서버는 저장하지 않는다(2026-11-24 사용자 지시 「대화 맥락은 이 화면 안에서만, 서버 저장 없음」) — §3-2 의 체크포인터 대신 이 칸으로 잇는다. 에이전트는 새 질문이 다른 강사를 말하면 앞 조건을 버리고, 아니면 새 질문이 비운 칸만 앞 값으로 채운다(`follow_up.carry_over`). 앱은 답이 오는 대로 조각을 읽어 말풍선을 키우고(`expo/fetch` 스트림), 답 아래 추천 질문 칩 2~3개는 받은 카드 값으로만 만든다. (추천안·사후 확인 2026-11-24)
- 답 문장 검사(SX-5.8): 에이전트는 모델이 쓴 문장을 한 문장씩 결과 값과 대조해 결과 밖 수업명·학원·요일·숫자·다른 강사 이름이 있거나, **결과가 있는데 「수업이 없다·찾지 못했다」고 하는 문장**을 버린다. 다 버려지면 같은 결과로 만든 고정 틀 문장을 쓴다. (추천안·사후 확인 2026-11-24)

### 3-1. 서버 처리 순서

1. 세션 → 회원(401 `UNAUTHENTICATED` · 403 `SIGNUP_INCOMPLETE`). 입력 검증(422).
2. 대화 만들기·찾기(`ai_conversations`). 회원 질문을 `ai_messages` 에 저장(원문 — 이 대화는 회원과, 넘긴 뒤에는 받는 대표만 읽는다).
3. 같은 회원의 진행 중 판단형 run 이 있으면 취소하고 새 run 을 연다(FR-264). `ai_runs` 에 `queued` 로 한 줄(`question_masked` — 전화·메일·계좌 모양을 가린 본문, FR-274).
4. 대화 한 세션용 `agentSessionToken`(HMAC 서명, 유효 120초, 클레임 `kind=member`·`sub=memberId`·`runId`·`exp`)을 만든다 — 에이전트는 회원 id 를 모르고 이 토큰을 도구 호출에 그대로 실어 보낸다(§6). 열린 점 ②.
5. 에이전트 서버 `POST /v1/chat/stream` 호출(§3-2). 응답 이벤트를 AI SDK UI 스트림으로 **번역**해 내보낸다(§3-3, ADR-005).
6. `tier` 이벤트가 `T2` 면 오늘 판단형 횟수를 조건부 갱신으로 센다(`UPDATE … SET t2_count = t2_count + 1 WHERE t2_count < :limit`). 한도에 걸리면 에이전트 run 을 취소하고 `error{code:'T2_DAILY_LIMIT'}` 를 낸다 — **T0·T1·T3 는 한도와 무관하게 계속 답한다**(FR-222 · SC-048).
7. `done` 이 오면 답(`ai_messages` assistant 행: 근거·도구 호출 기록·`generationKind`)과 측정값(`ai_runs`)을 한 트랜잭션에 쓴다(FR-216 · FR-274). 질문을 받은 학원 문의 후보에 연결한다(FR-225).
8. 클라이언트가 연결을 끊으면 `POST /v1/chat/{runId}/cancel` 을 부르고 run 을 `cancelled` 로 닫는다.

**대체 규칙(FR-041 · FR-266 · FR-278)**: 에이전트가 1.5초 안에 `queued`·`stage` 첫 이벤트를 안 주거나(SC-046 은 1초 안 표시 — 번역 여유 0.5초) 전체 25초(SC-041 완료 기준)를 넘기면 Next.js 가 run 을 `timed_out` 으로 닫고 **플래너(`planner`)는 일반 검색 결과로** 바꿔 준다 — 질문에서 강사·학원 이름 토큰을 `find_instructors` 와 같은 함수로 찾아 `cards` 와 안내 문장 「AI 가 응답하지 않아 일반 검색 결과를 보여 드려요」를 낸다(SX-4.3 · SX-5.5). `inquiry` 는 사람에게 넘기는 버튼(`handoff` 이벤트)을 낸다. 에이전트 서버가 꺼져 있으면 즉시 같은 규칙이고, 이미 나간 이벤트는 되돌리지 않는다.

- 대체 구현 규칙(SX-5.5): 기한은 설정값이다 — `AI_CHAT_FIRST_EVENT_TIMEOUT_MS`(기본 1500) · `AI_CHAT_TOTAL_TIMEOUT_MS`(기본 25000), 비우면 기본값, 양의 정수가 아니거나 첫 이벤트 기한이 전체보다 길면 서버가 뜨지 않는다(`loadAiChatDeadlines`). 첫 이벤트는 이름과 상관없이 에이전트가 보낸 **아무 이벤트**나 센다. 전체 기한 값은 에이전트 요청의 `deadlineMs` 로도 넘긴다. 일반 검색(`lib/server/ai/planner-plain-search.ts` 의 `runPlainSearch`)은 모델 없이 질문 글자에서 **강사·학원 이름만** 찾고(부름말·조사를 떼고, 학원은 두세 낱말 묶음까지, 조회 상한 40개) 요일·시간대·장르는 뽑지 않는다. 학원은 하나로 정해진 곳이 딱 한 곳일 때만, 강사는 질문 앞에서 처음 걸린 이름 — 동명이인이면 질문의 학원 이름으로 좁혀 보고 그래도 여럿이면 `instructor_candidates` 카드. 이름이 하나도 없으면 검색하지 않고 「강사나 학원 이름을 넣어 다시 물어봐 주세요.」, 0건이면 SX-5.4 결과 없음 값. 스트림 조각 순서: `data-fallback{kind:"plain_search", reason}`(`reason` = `first_event_timeout` · `timeout` · `agent_unavailable` · `agent_error`) → 안내 문장(글 상자가 이미 열려 있으면 줄을 바꿔 이어 씀) → `data-cards`(`offering_cards` 또는 `instructor_candidates`) 또는 `data-no-result`(SX-5.4 `no_offering_result` 값) → `text-end` · `finish`. 에이전트가 `error{fallback:"plain_search"}` 를 보내도 같은 경로다(`reason: agent_error`). 일반 검색마저 실패하면 `data-error{MODEL_UNAVAILABLE, fallback:"plain_search"}` 로 닫는다(추천안·사후 확인 2026-11-24)
- 추천 시간 초과 대체 규칙(SX-4.3(시간 초과 대체)): 플래너가 대체로 갈 때 Next.js 는 ① 에이전트가 수업 카드(`cards` 이벤트, 종류 무관)를 이미 보냈으면 **다시 찾지 않는다** — `data-fallback{kind:"plain_search", reason}` → 안내 문장(열린 글 상자에 줄을 바꿔 이음) → `text-end` · `finish` 만 잇는다(같은 카드가 두 번 붙지 않게, 나간 카드가 곧 필터 검색 결과). ② 카드는 없지만 `conditions` 이벤트가 왔으면 **그 조건으로 필터 검색**한다 — 열한 칸만 옮겨(빈 요일 배열은 비움) `search_offerings` 입력 규칙(`searchOfferingsInputSchema`, limit 10)을 통과할 때만 쓰고, `recruitOpenOnly: true` 면 `full` 카드를 뺀다. 조각 순서는 SX-5.5 와 같고 `data-conditions` 는 그 조건이다. ③ 조건이 없거나 규칙에 안 맞으면(이름만 있고 id 없음·모르는 값·조건 없음) SX-5.5 이름 검색으로 간다. 구현은 `runPlainSearch` 의 넷째 인자 `agentConditions` 와 `ai-chat-route.ts` 의 `plainSearch(message, context, agentConditions)`(추천안·사후 확인 2026-11-24)

**저하 모드**: Next.js 가 `GET /health/deps` 를 5초마다 불러(추천값) 3번 연속 `llm` 이 `down` 이면 `ai:degraded` 를 켠다 — 첫 실패에서 15초, 판정까지 최대 약 30초(SC-048). 켜져 있는 동안 요청 본문에 `degraded: true` 를 실어 보내고 에이전트는 T2 를 `error{code:'DEGRADED'}` 로 즉시 끝낸다. 연속 2번 성공하면 끈다(사람 개입 없음).

### 3-2. 에이전트 서버 `POST /v1/chat/stream` (층 B1)

요청 `{ "runId": "…", "context": {…§3 요청 그대로}, "message": "…", "degraded": false, "deadlineMs": 25000, "agentSessionToken": "…" }`. 대화 맥락(후속 질문, FR-269)은 에이전트 서버 메모리 체크포인터가 `thread_id = conversationId` 로 들고 있고 30분 안 쓰면 버린다(추천값, ADR-004 규칙 5). 재시작하면 새 대화처럼 답한다.

SSE 이벤트(ADR-005 의 5종에 4종을 더한다 — 열린 점 ④). 한 줄 형식 `event: <이름>\ndata: <JSON>\n\n`.

| 이벤트 | `data` | 뜻 |
|---|---|---|
| `queued` | `{"position":3,"etaSeconds":25}` | 대기열 순번(FR-261). 동시 처리 10건(FR-260) 넘으면 대기. 대기열 상한(추천 30) 넘으면 `error{code:'QUEUE_FULL'}` |
| `tier` | `{"tier":"T0"\|"T1"\|"T2"\|"T3"}` | 분류 결과(규칙, 모델 없음). 첫 이벤트 근처에 온다 |
| `stage` | `{"name":"conditions"\|"candidates"\|"writing"}` | 진행 단계(FR-262). 화면은 「조건 분석 › 후보 찾기 › 답 작성」 |
| `conditions` | `{"instructor":{"name":"이준호","id":null},"academy":{"name":"라틴하우스 강남","id":null},"weekdays":["sat","sun"],"timeBand":"morning","genre":null,"level":null}` | 질문에서 뽑은 조건(M10F 의 조건 칩). §5-1 |
| `text` | `{"sentence":"…"}` | 검사를 통과한 한국어 문장 하나(FR-266 · FR-267). 모델이 쓴 수치 주장은 걸러진다 |
| `sources` | `{"items":[{"kind":"academy_notice","id":"…","label":"쌈바(입문) 준비물","version":2}]}` | 근거(FR-212). 종류 `knowledge_item`·`academy_notice`·`refund_notice`·`terms`·`offering`·`order`·`reservation` |
| `cards` | `{"kind":"offering_cards"\|"instructor_candidates"\|"recommendations","items":[…]}` | 카드. 모양은 §5-2 |
| `handoff` | `{"reason":"sensitive"\|"low_confidence"\|"user_request","needsAcademyPick":true}` | 사람에게 넘기라는 제안(FR-201 · FR-202). 모델에 보내지 않고 규칙으로 정한다 |
| `done` | `{"metrics":{"tier":"T2","waitMs":1200,"firstContentMs":3100,"totalMs":9400,"modelCalls":2,"toolCalls":3,"degraded":false,"fallbackUsed":false}}` | 완료. 기록은 Next.js 가 한다(FR-274) |
| `error` | `{"code":"QUEUE_FULL"\|"T2_DAILY_LIMIT"\|"DEGRADED"\|"MODEL_UNAVAILABLE"\|"LANGUAGE_CHECK_FAILED"\|"NO_EVIDENCE","fallback":"human"\|"plain_search"\|"none"}` | 실패. `done` 은 따라오지 않는다 |

규칙: `tier` 가 `T0`·`T1` 이면 모델을 부르지 않는다(`modelCalls` = 0, SC-042 의 1초). `T3` 는 `handoff` 뒤 바로 `done`. 한국어가 아닌 문자가 섞인 문장은 다시 만들고 두 번 실패하면 `error{LANGUAGE_CHECK_FAILED, fallback:'plain_search'}`(FR-266). 근거가 없는 사실 문장은 내보내지 않는다 — 근거 없이 답할 수 없으면 `error{NO_EVIDENCE, fallback:'human'}` 가 아니라 「모른다」 문장(FR-217)과 `handoff{reason:'low_confidence'}` 를 낸다. 추천(`recommendations`)은 설정 `ai.recommend_enabled`(기본 꺼짐, 게시 수업이 쌓인 뒤 켠다)가 켜졌을 때만 낸다.

### 3-3. 번역 — 에이전트 이벤트 → AI SDK UI 스트림(ADR-005, 설치본 `ai` 7.0.113)

응답 `200 text/event-stream`, 헤더 `x-vercel-ai-ui-message-stream: v1` · `x-ai-run-id: <runId>`. Route Handler 에서 `createUIMessageStream({ execute: ({ writer }) => … })` + `createUIMessageStreamResponse`. 번역은 순수 함수 `translateAgentEvent(event, state) → parts[]` 로 떼어 단위 테스트한다(SX-1.5).

| 에이전트 이벤트 | AI SDK 조각 |
|---|---|
| `queued` | `data-queued`(`transient: true`) — 화면 `onData` 에서만 받는다. 대화 기록에 안 남는다 |
| `tier` | `data-tier`(`transient: true`) |
| `stage` · `conditions` | `data-stage` · `data-conditions`(`transient: true`) |
| `text` | `text-start`(없으면 한 번) → `text-delta`(문장 하나) … `text-end` |
| `sources` | `data-sources`(기록에 남는다 — 「근거 ›」 링크) |
| `cards` | `data-cards`(기록에 남는다) — 다시 열어도 카드가 보인다 |
| `handoff` | `data-handoff` |
| `done` | `finish`. 측정값은 스트림에 싣지 않는다 |
| `error` | `data-error` → `finish` |

## 4. 층 A 상세

### 4-1. `POST /api/ai/chat/{runId}/cancel`

`200 {"runId":"…","status":"cancelled"}`. 본인 run 이 아니면 404 `NOT_FOUND`(run id 존재를 알리지 않는다). 이미 `succeeded`·`failed` 면 200 으로 그 상태를 돌려준다.

### 4-2. `GET /api/ai/status`

```json
{ "tier2": { "available": true, "degraded": false, "queueLength": 0, "etaSeconds": 0 },
  "myUsage": { "t2Limit": 20, "t2Used": 2, "t2Remaining": 18, "resetsAt": "2026-11-20T15:00:00Z" } }
```
한도 `t2Limit` 은 설정 `ai.t2_daily_limit`(열린 점 ⑥ 추천 20 — C2A 의 「오늘 18회 남았어요」 예시와 맞다). `resetsAt` 은 다음 KST 0시. `degraded: true` 면 앱은 M10E 의 「판단형 질문만 잠시 쉬어요」를 보인다.

### 4-3. `POST /api/ai/messages/{messageId}/feedback`

요청 `{ "helpful": false }` → 200 `{ "messageId": "…", "helpful": false, "suggestHandoff": true }`. `false` 면 `suggestHandoff: true`(FR-208 — 앱이 「사람에게 물어보기」를 강조). 답(assistant) 메시지가 아니면 422 `VALIDATION_FAILED`.

### 4-4. `POST /api/ai/conversations/{conversationId}/handoff` — 사람에게 넘기기

요청 `{ "academyId": "…", "reason": "user_request" }` — `reason` 은 `user_request`(FR-209) · `unsatisfied`(FR-208) · `sensitive`(FR-201) · `low_confidence`(FR-202). 대화의 `context` 로 학원이 정해져 있으면 `academyId` 생략 가능, 정해지지 않았는데 없으면 409 `HANDOFF_ACADEMY_REQUIRED`(앱이 대표 고르기 화면으로 간다, FR-203).

처리: S7-2 의 문의 만들기 서비스를 **Next.js 가** 부른다(에이전트는 쓰지 않는다, SX-3.5). 문의는 그 학원 대표에게 가고 대화 전체(회원·AI 메시지)가 같이 간다. 운영자에게는 앱·웹 시스템 문의만 간다(FR-204) — `reason` 이 시스템 문의면 S7-2 의 운영자 문의 경로를 쓴다(조율). 대화 상태 `open` → `handed_over`.

응답 `201 { "inquiryId": "…", "academyId": "…", "handedOverAt": "…Z", "replyNotice": { "businessDays": 1, "serviceHours": "평일 13:00–22:00" } }`. 이미 넘긴 대화면 200 같은 본문. `replyNotice` 는 S7-2·S1-1 의 응대 시간 설정에서 가져온다(FR-231, 모델이 쓰지 않는다). 받는 대표의 알림은 S7-2 가 만든다.

### 4-5. 지식(대표 · O42·W9)

`GET …/faq-candidates?status=pending` 200
```json
{ "items": [ { "id": "…", "question": "수업 환불은 언제까지 되나요?", "askCount": 11, "lastAskedAt": "…Z", "status": "pending",
               "draft": { "text": "학원 환불·취소 공지 기준이에요. …", "aiGenerated": true,
                          "sources": [ {"kind":"refund_notice","id":"…","label":"환불·취소 공지","version":3} ] },
               "origin": "ai_conversation" } ], "nextCursor": null }
```
`status` = `pending`(기본) · `skipped` · `approved`. `draft` 는 초안이 없을 수 있다(`null` — 근거를 못 찾은 질문). `origin` = `ai_conversation` · `human_reply`(사람이 답한 내용에서 모은 후보, FR-229).

`POST …/approve` 요청
```json
{ "answer": "건물 지하 주차장을 2시간 무료로 쓸 수 있어요. 수업 전에 안내 데스크에서 등록해 주세요.",
  "evidence": [ {"kind":"academy_info","id":"…"} ], "reviewAfter": "2027-05-20" }
```
- `answer` 1~1000자임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인). 초안에서 고쳤는지 서버가 비교해 `edited` 를 기록한다. `evidence` 1개 이상(0개면 422 `FAQ_EVIDENCE_REQUIRED`, FR-212). `reviewAfter` 생략 시 오늘 + 6개월(W9 기본) — KST 날짜.
- 승인하면 같은 트랜잭션에서 `knowledge_items` 한 줄(`status='active'`)과 후보 `approved` 를 쓴 뒤 **트랜잭션 밖에서** 에이전트 `POST /v1/embeddings` 로 벡터를 받아 채운다. 벡터가 비어 있는 동안에는 검색에 안 잡힌다(승인 전 답이 지식에 안 들어간다 — SX-3.9). 응답 `201 KnowledgeItem`: `{ "id", "scope": "academy", "academyId", "question", "answer", "evidence": […], "status": "active", "reviewAfter", "approvedAt", "version": 1, "embeddingReady": false }`.
- 이미 승인된 후보면 200 같은 항목. `pending` 이 아니고 `approved` 도 아니면(`skipped`) 409 `FAQ_CANDIDATE_NOT_PENDING`. 남의 학원 후보는 403 `FORBIDDEN`.
- `POST …/skip` → 200 `{ "id", "status": "skipped" }`. **넘긴 질문이 다시 3번 더 묻히면 후보로 돌아온다**(추천값, O42 「다시 묻는 사람이 늘면 후보로 돌아와요」) — 스케줄 경로 `faq-candidates/build` 가 한다.
- `GET …/knowledge-items?status=active|review_due|retired`. 항목 모양은 위 `KnowledgeItem` + `reviewDueReason`(`date_passed` · `evidence_changed`).
- `POST …/reconfirm` 요청 `{ "answer": "…(선택)", "reviewAfter": "2027-06-01" }` → `review_due` 항목을 `active` 로 되돌리고 `version` +1, 답이 바뀌었으면 벡터를 다시 받는다. `review_due` 가 아니면 200 같은 항목.
- `POST …/retire` → `retired`(AI 가 쓰지 않는다). 되돌리기는 새 후보로.
- **다시 볼 것 표시(FR-227 · FR-228)**: ① `reviewAfter` 가 지나면 `sweep` 이 `review_due`(`date_passed`). ② 근거로 단 환불 공지·학원 정보가 새 판본이 되면 그 판본 저장 서비스(S1-3 등)가 같은 트랜잭션에서 근거로 단 항목을 `review_due`(`evidence_changed`)로 바꾼다 — 판본 저장 경로의 응답은 달라지지 않는다. `review_due` 는 확인할 때까지 `search_knowledge` 가 돌려주지 않는다.
- 운영자의 플랫폼 지식(앱·약관) 승인 경로는 보드가 없어 만들지 않는다(열린 점 ⑧).

### 4-6. 포스터 읽기(SX-2)

`POST …/poster-extractions` 요청 `{ "fileId": "…", "targetKind": "class" }` — `fileId` 는 `POST /api/files`(07 계약)로 올린 파일(`purpose` = `poster`, §13 값 집합 추가). `targetKind` = `class`·`party`·`performance`·`competition`(FR-077 같은 양식 재사용 — 종류별 칸은 열린 점 ⑬). 응답 `202 { "extractionId": "…", "status": "queued", "revision": 1 }`. 학원 대표·권한 위임 강사만. 처리: `uploaded_files` 확인 → `poster_extractions`·`ai_jobs` 한 줄 → 커밋 뒤 에이전트 `POST /v1/jobs`(`kind: poster_extract`). 에이전트가 안 받으면 `ai_jobs` 는 `queued` 로 남고 `sweep` 이 기한(추천 120초)이 지나면 `failed`(`failureCode: AGENT_UNAVAILABLE`)로 닫는다 — 대표는 직접 입력으로 넘어간다.

`GET …/{extractionId}` 200
```json
{ "extractionId": "…", "status": "ready", "targetKind": "class", "revision": 3,
  "overallConfidence": 0.87, "reviewedAt": null, "submittedClassId": null,
  "fields": [
    { "key": "genre_detail", "value": "bachata", "confidence": 0.98, "needsCheck": false, "valueSource": "ai", "confirmedAt": null },
    { "key": "title", "value": "바차타 센슈얼 입문 · 11월", "confidence": 0.95, "needsCheck": false, "valueSource": "ai", "confirmedAt": null },
    { "key": "price_amount", "value": 180000, "confidence": 0.71, "needsCheck": true, "valueSource": "ai", "confirmedAt": null },
    { "key": "capacity_male", "value": 6, "confidence": null, "needsCheck": true, "valueSource": "ai", "confirmedAt": null } ],
  "conflicts": [ { "kind": "room_overlap", "message": "…", "relatedClassId": "…" } ],
  "failureCode": null }
```
- `status` = `queued` → `running` → `ready` · `failed` → (대표가 고침) `reviewed` → `submitted`. `abandoned`(대표가 버림).
- **칸 키(FR-073 · O2 화면 값, 17개)**: `genre`(§4.1 genre) · `genre_detail` · `title` · `weekday`(`mon`…`sun`, 여럿 가능 — 값이 배열) · `start_time` · `end_time`(`HH:MM` KST) · **`start_date` · `end_date`(`YYYY-MM-DD` KST 달력, 연도 2020~2100 — 포스터에 연도까지 적혀 있을 때만) · `session_count`(정수 1~200)** · `room_name` · `price_amount`(원 정수) · `capacity_male` · `capacity_female` · `capacity_total` · `instructor_name` · `level` · `class_kind`(§4.1). 값을 못 읽은 칸은 `value: null`, `confidence: null`, `needsCheck: true`.
- **기간 칸(SX-2.6, spec FR-073 하위 불릿 2026-11-24)** (추천안·사후 확인 2026-11-24): 개강일은 언제나, 반복 수업은 종료일 **또는** 회차 수 하나가 더 있어야 한다(이벤트형 `one_day`·`event`·`party`·`performance`·`competition` 은 개강일만). 이 조건을 못 채운 빈 기간 칸은 「채워야 하는 칸」이다 — `review` 의 `confirmedKeys` 로 넘길 수 없고(사람이 `PATCH` 로 비운 칸 포함) `unresolved` 에 남는다. 화면은 그 칸을 「확인필요」 빈 칸으로 보이고 「맞아요」 체크를 두지 않는다. 다른 하나(예: 회차 수가 있을 때의 빈 종료일)는 보통 확인필요 칸처럼 「맞다」로 넘길 수 있다.
- `needsCheck` = `confidence < 기준` 이거나 값이 없거나 형식 검증을 못 넘은 칸(FR-075). 기준은 설정 `poster.confidence_min`(열린 점 ⑬ 추천 0.80 — O2 보드의 71% 는 확인필요, 87%·92% 는 아님과 맞다).
- `valueSource` = `ai`(AI 가 채움 — 「AI 생성」 표시, FR-258) · `user`(대표가 직접 채움) · `ai_edited`(AI 값을 대표가 고침). `PATCH` 로 값을 바꾸면 `user` 또는 `ai_edited` 로 바뀌고 `needsCheck` 는 `false`.
- `conflicts` 는 S2-2 의 검증(강의실 겹침 FR-072 · 강사 일정 겹침 FR-054)을 **읽기 전용으로** 돌린 결과다. 게시를 막는 것은 `submit` 이 S2-2 로 넘길 때의 오류이고 이 목록은 O2 의 「충돌 · 살사 중급반」 안내용이다.
- 읽기 작업은 대화 응답보다 뒤로 밀린다(FR-265): 에이전트 worker 는 동시 1건이고 `queued` 이벤트 대기열에 질문이 있으면 잠시 기다린다.
- 읽기 실패(검증 실패 1회 재시도 뒤에도 실패, ADR-004 규칙 3)면 `status: "failed"`, `failureCode`(`EXTRACTION_FAILED` · `AGENT_UNAVAILABLE` · `TIMEOUT`), `fields: []` — 앱은 직접 입력 화면으로 보낸다.

`PATCH …/{extractionId}` 요청 `{ "revision": 3, "fields": [ { "key": "price_amount", "value": 180000 } ] }` → 200 위 상세(`revision` +1). `ready`·`reviewed` 에서만(`reviewed` 에서 고치면 `ready` 로 돌아가고 검토를 다시 해야 한다). 값 형식이 칸 규칙에 안 맞으면 422 `VALIDATION_FAILED` + `fields`. `revision` 이 다르면 409 `POSTER_REVISION_CONFLICT`. 다른 상태면 409 `POSTER_NOT_READY`.

`POST …/{extractionId}/review` 요청 `{ "revision": 4, "confirmedKeys": ["capacity_male","capacity_female"] }` — `needsCheck` 인 칸은 고쳤거나(`user`·`ai_edited`) 여기서 `confirmedKeys` 로 「맞다」고 확인해야 한다. 남아 있으면 409 `POSTER_REVIEW_INCOMPLETE` + `unresolved`. 성공하면 200 상세(`status: "reviewed"`, `reviewedAt`·`reviewedBy` 기록). **이 단계를 건너뛰는 경로는 없다**(FR-074).

`POST …/{extractionId}/submit` — 헤더 `Idempotency-Key`. 본문 없음. `status` 가 `reviewed` 이고 마지막 `review` 뒤에 `PATCH` 가 없었을 때만. 그렇지 않으면 409 `REVIEW_REQUIRED`(`ready` 에서 곧바로 부르는 경우 포함 — SX-2.3 「검토 없이 게시 요청 거부」). 처리: 기간 칸이 비었으면(위 「기간 칸」 조건) 수업을 만들지 않고 409 `POSTER_PERIOD_REQUIRED` + `missingFields`(검토가 이미 막지만, 기간 칸이 생기기 전에 검토를 끝낸 읽기도 여기서 걸린다 — SX-2.6). 검토된 값으로 S2-2 의 **수업 등록 서비스**(S2-2.3 의 초안 만들기 + 승인 요청, 게시는 S2-2.7 로만)를 부르고 `submitted_class_id` 를 쓴다. 응답 `201 { "extractionId": "…", "classId": "…", "approvalStatus": "pending_approval" }`. S2-2 가 거부하면(강의실 겹침·강사 일정 겹침·환불 공지 없음 등) 그 계약의 409 코드를 그대로 돌려주고 추출은 `reviewed` 로 남는다 — 고친 뒤 다시 `submit`. **S2-2 승인 요청이 빠진 칸으로 422 를 내면 본문에 `classId`(만들어 둔 임시 저장)와 `missingFields`(빠진 칸 — S2-2 칸 이름의 첫 마디, 예 `["targetAges"]`)를 더해 돌려준다** — 화면이 그 수업의 수정 폼으로 바로 보낸다. 임시 저장 만들기부터 422 로 막히면(예: 대표가 올렸는데 포스터의 강사 이름으로 담당 강사를 못 찾음) 아직 수업이 없으니 `classId` 없이 `missingFields` 만 더한다. 예 `422 { "code": "VALIDATION_FAILED", "detail": "…", "fields": [ { "path": "targetAges", "message": "…" } ], "classId": "…", "missingFields": ["targetAges"] }` (SX-2.6 (추천안·사후 확인 2026-11-24)). 임시 저장 본문의 `schedule` 은 요일 · 시작 · 끝 시각 + 기간 칸으로 만든다 — 종료일이 있으면 `periodTo` 로, 없고 회차 수만 있으면 요일 규칙으로 세어 마지막 회차 날짜를 `periodTo` 로(「12/5 부터 토 4회」 → 12/26), 이벤트형은 `kind: "single"`(`date` = 개강일). 모자라면 `null` 이고 S2-2 가 「일정」 빠짐으로 422 를 낸다. 이미 `submitted` 면 200 같은 본문. 승인 전에는 회원 목록에 나오지 않는다(S2-2 수용).

### 4-7. 홍보 이미지·소개 문구(SX-6)

`GET /api/ai/promo-image/options?classId=…` 200 — 칩·예시·자동 조건은 코드에 박지 않고 설정(`ai_settings`)에서 읽는다(FR-061a 「설정값」).
```json
{ "genre": "salsa_bachata",
  "requiredChips": [ { "key": "who", "label": "누가", "options": ["커플","단체","솔로"] },
                     { "key": "mood", "label": "분위기", "options": ["열정적인","우아한","경쾌한","로맨틱한","편안한"] },
                     { "key": "place", "label": "장소", "options": ["스튜디오","무대","파티 홀","야외"] },
                     { "key": "color", "label": "색감·조명", "options": ["빨간 조명","따뜻한 노을빛","푸른 밤","밝은 자연광"] } ],
  "examples": [ { "id": "…", "text": "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습.", "chips": { "who": "커플", "place": "스튜디오", "color": "빨간 조명", "mood": "열정적인" } } ],
  "autoConditions": [ { "id": "genre_pose", "label": "마주 선 커플 소셜댄스 자세", "defaultOn": true, "removable": true },
                      { "id": "full_body", "label": "온몸이 보이는 구도 · 다른 종류의 춤 아님", "defaultOn": true, "removable": true },
                      { "id": "no_text", "label": "이미지 안에 글자 없음", "defaultOn": true, "removable": false } ],
  "usage": { "dailyLimit": 3, "used": 1, "remaining": 2, "resetsAt": "2026-11-20T15:00:00Z", "betaPhase": true, "freeQuotaExhausted": false },
  "maxSentenceLength": 200 }
```
`genre` 는 수업에서 가져온 값(잠긴 칩). `autoConditions[].id` 가 `no_text` 인 항목은 항상 `removable: false` 이고 요청에서 빼도 서버가 넣는다. 칩 낱말·예시·장르별 조건 문장은 추천안이다(spec 「사용자 확인 대기」). 필수 4항목 판정과 문장 채우기는 순수 함수 `admin-web/lib/domain/promo-image-chips.ts`(`checkPromoRequiredChips`·`fillPromoSentence`·`promoGenreChip`) 하나를 화면과 서버가 같이 쓰고, `requiredChips` 기본값은 설정 파일 `promo-image-chips.json` 에 둔다(설정 표 `promo_image.chips` 가 생기면 그 기본값). 칩 목록에 없는 낱말을 칩 값으로 보내면 빠진 것으로 본다 — 칩에 없는 표현은 `{"custom":"…"}` 로만 받는다(SX-6.1 (추천안·사후 확인 2026-11-24)). 자동 조건은 순수 함수 `admin-web/lib/domain/promo-image-conditions.ts`(`promoAutoConditionOptions`·`resolvePromoAutoConditions`·`buildPromoImageAgentPayload`)가 정하고, 조건 문장(한글 `label`·영어 `textEn`·`removable`)은 설정 파일 `promo-image-conditions.json` 에 둔다(설정 표 `promo_image.auto_conditions` 가 생기면 그 기본값). `genre_pose` 는 장르마다 문장이 다르고(`perGenre`, 네 장르 모두 필수), `full_body`·`no_text` 는 모든 장르 공통(`all`)이다. 요청의 `autoConditionIds` 에서 알 수 없는 id 는 무시하고 겹친 id 는 한 번만, 붙는 순서는 설정 순서다. 에이전트 payload(§7-1)의 `autoConditions` 에는 `no_text` 도 들어가고 `textless` 는 늘 `true` 다 — `promo_image_generations.auto_condition_ids` 에는 실제로 붙인 id(`no_text` 포함)를 남긴다(SX-6.2 (추천안·사후 확인 2026-11-24)).

**구현(SX-6.9 (추천안·사후 확인 2026-11-24))** — 위 `GET /api/ai/promo-image/options` 경로. 서비스 `admin-web/lib/server/services/promo-image-options.ts`, route `app/api/ai/promo-image/options/route.ts`, 순수 함수 `admin-web/lib/domain/promo-image-options.ts`(`promoExamplesFor`·`promoEngineCards`·`promoPreselectedEngineId`·`promoUsageSummary`). 권한은 만들기 요청 1단계와 같다(수업을 고칠 수 있는 사람). 위 예시와 다르거나 더한 것:
- `genreChip: { genre, label, locked: true }` — `label` 은 문장에 들어갈 춤 이름(`promoGenreChip`, 예: 「바차타」). 앱이 칩으로 문장을 채울 때 쓴다(앱은 admin-web 코드를 가져올 수 없어 `fillPromoSentence` 와 같은 규칙을 `mobile/lib/instructor/promo-api.ts` 에 옮겼고, 판정은 서버가 다시 한다).
- `examples` 는 설정 파일 `promo-image-examples.json`(spec FR-061a 예시 세 문장, 칩 네 개가 모두 든 문장만)이고 이 수업 장르가 맨 앞이다. 항목에 `genre`·`genreLabel` 을 더했다.
- **`engines`**(엔진 카드, 보드 I32B 2026-11-24): 켜진 엔진만 — `{ id, label, speed, etaSeconds, available, blockedScope, resetsAt, lastPicked }`. 이름·한 마디·예상 시간은 `promo-image-quota.json` 엔진 항목에 더한 `label`·`speed`·`etaSeconds`(Cloudflare 「약 5초」는 보드 문구, 실측 전). `available`·`blockedScope` 는 만들기 요청 4단계와 같은 `decidePromoFreeQuota`. `lastPicked` = 이 사람의 가장 최근 생성 엔진. `preselectedEngineId` = 지난번 엔진 → 기본 엔진 → 쓸 수 있는 첫 카드, 다 막혔으면 null.
- `usage` 에 `freeQuotaScope`(`monthly`|`engine_daily`|null)를 더했다. `freeQuotaExhausted` 는 「켜진 엔진이 모두 막혔다」.
- **`lastGeneration`**: 이 사람이 이 수업에서 마지막으로 만든 생성(성공·만드는 중, 실패 제외) — `{ generationId, status, imageUrl, engine, sentence, chips, autoConditionIds, createdOn }` 또는 null. 화면을 다시 열어도 검토 단계(I32)로 이어 가고, 오늘 다 쓴 날(I42) 「오늘 마지막으로 만든 이미지」를 보인다.
- `GET·PUT /api/classes/{classId}/promo-assets` 응답에 `aiImageGenerationId`·`introDraftId` 를 더했다 — 전체 교체(PUT)라 앱이 저장된 AI 표지·초안을 그대로 다시 보낼 수 있어야 한다.
- 파일 내려받기(`GET /api/files/{id}`, 계약 07): 목적 `class_promo_image` 는 앱(Bearer)에서 2단계 인증 없이 연다(강사 앱에는 2단계가 없다). 누가 여는지(올린 사람·붙은 학원 대표)는 그대로 본다. 증빙·통장 사본 같은 다른 비첨부 파일은 여전히 2단계가 필요하다.

`POST /api/ai/promo-images` — 헤더 `Idempotency-Key`(필수)
```json
{ "classId": "…", "chips": { "who": "커플", "mood": "열정적인", "place": "스튜디오", "color": "빨간 조명" },
  "sentence": "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습", "autoConditionIds": ["genre_pose","full_body"] }
```
서버 순서(앞 단계에서 실패하면 **횟수는 줄지 않는다**):
1. 수업 편집 권한 확인(403 `FORBIDDEN`) · `classId` 가 있고 장르가 정해져 있다.
2. 길이·형식(`sentence` 1~200자) — 422 `VALIDATION_FAILED`. 필수 4항목 중 빠짐(`직접 쓰기` 로 넣은 항목은 채운 것으로 본다 — `chips` 값에 `{"custom":"…"}`) — 422 `PROMO_REQUIRED_MISSING` + `{"missing":["place"]}`(SX-6.1).
3. 막는 입력 판정(규칙 — 열린 점 ⑪): 선정·폭력 낱말, 실존 인물(유명 댄서·연예인) 이름 목록, 타사 상표·로고 목록. 걸리면 422 `PROMO_INPUT_BLOCKED` + `{"blockedKind":"explicit"|"violence"|"real_person"|"trademark","remaining":2}`. 입력 문장은 명령이 아니라 데이터다 — 판정은 문장을 해석하지 않고 낱말 목록·정규식으로만 한다(FR-270, SX-6.3). 판정 결과와 상관없이 `no_text` 조건은 요청에 들어간다. 판정은 순수 함수 `admin-web/lib/domain/promo-image-blocklist.ts`(`screenPromoInput`·`guardPromoGeneration`)가 하고, 목록은 설정 파일 `promo-image-blocklist.json`(갈래마다 `reason`·`terms`·`patterns`)에 둔다(설정 표 `promo_image.blocklist` 가 생기면 그 기본값). 문장과 칩(직접 쓰기 포함)을 함께 보고, 글자를 NFKC·소문자·악센트 제거로 맞춘 뒤 한국어 낱말·정규식은 띄어쓰기·문장부호를 뺀 글에서, 영어 낱말은 낱말 단위로 찾는다. 낱말은 두 글자 이상만 둔다(「총 8회」 오탐 방지). 여러 갈래에 걸리면 `explicit → violence → real_person → trademark` 순서의 앞 갈래 하나를 돌려주고, 본문에는 막힌 까닭 한 줄(`reason`)만 싣고 걸린 낱말은 싣지 않는다. `guardPromoGeneration` 은 막히면 횟수 차감·생성 요청(5·6단계)을 담은 콜백을 부르지 않는다(SX-6.3 (추천안·사후 확인 2026-11-24)).
4. 이달 무료량 확인 — 이번 달(KST) 성공 생성 수가 설정 `promo_image.monthly_free_cap` 이상이거나 공급자가 한도 소진을 알린 표시(`promo_image.provider_exhausted_until`)가 살아 있으면 409 `PROMO_FREE_QUOTA_EXHAUSTED`(수업 등록은 막지 않는다 — FR-061a).
5. **횟수 차감(조건부 갱신)** `UPDATE promo_image_usage SET used_count = used_count + 1 WHERE staff_account_id = :id AND usage_date = :kstToday AND used_count < :limit`. 0행이면 409 `PROMO_DAILY_LIMIT_REACHED` + `resetsAt`. `limit` 은 설정 `promo_image.daily_limit`(베타 3, 정식 1). 다시 만들기도 1번으로 센다.
6. `promo_image_generations`(`queued`)·`ai_jobs` 한 줄 → 커밋 뒤 에이전트 `POST /v1/jobs`(`kind: promo_image`).

응답 `202 { "generationId": "…", "status": "queued", "remaining": 2 }`. 같은 `Idempotency-Key` 가 다시 오면 200 같은 `generationId`(횟수 다시 차감하지 않음).

`GET /api/ai/promo-images/{generationId}` 200
```json
{ "generationId": "…", "status": "succeeded", "aiGenerated": true, "imageFileId": "…", "imageUrl": "/api/files/…",
  "refunded": false, "remaining": 2, "failureCode": null }
```
`status` = `queued` · `running` · `succeeded` · `failed`. **횟수 원복**: `failed`(모델 오류·시간 초과·공급자 오류)가 되는 순간 같은 트랜잭션에서 `used_count - 1`(0 밑으로 안 내려감)과 `quota_refunded_at` 을 쓴다 — `refunded: true`, `remaining` 이 다시 늘어난다(I41 「실패하면 횟수를 돌려줘요」). 한 생성은 한 번만 원복한다(`quota_refunded_at IS NULL` 조건). 공급자가 한도 소진을 알리면 `failureCode: PROVIDER_QUOTA_EXHAUSTED` 와 함께 월 무료량 소진 표시를 켠다. 앱은 2초 간격(추천값)으로 읽는다. 만든 직원(또는 같은 학원 대표)만 읽는다. 이미지에는 글자가 없다 — 수업명·시간·장소·회차·금액은 앱이 수업 데이터로 이미지 위에 얹고 서버는 글자를 합성하지 않는다.

`GET /api/ai/promo-images/history?limit=20` 200 `{ "items": [ { "generationId": "…", "createdOn": "2026-11-19", "sentence": "…", "chips": {…}, "autoConditionIds": […], "status": "succeeded" } ] }` — 본인 것만, 최신순, 막힌 입력은 남기지 않으므로 목록에 없다. 다음 날 같은 문장을 불러와 고쳐 쓴다(SX-6.5).

**구현(SX-6.5 (추천안·사후 확인 2026-11-24))** — `admin-web/lib/server/services/promo-image-generations.ts`(경로 셋: 위 POST · `GET …/{generationId}` · `GET …/history`), 마이그레이션 `20261124T1142_promo_image_quota`. 하루 횟수 N 과 엔진 목록은 설정 파일 `admin-web/lib/domain/promo-image-quota.json`(`dailyLimit` 3 · `defaultEngineId` · `engines[]` 의 `enabled`·`engineDailyLimit`, 설정 표 `promo_image.daily_limit` 이 생기면 그 기본값)이고 엔진 id·켜짐은 `agent-server/app/promo/image_engines.json` 과 같다(단위 테스트가 견준다). 위 문서와 다르거나 더한 것:
- 요청 본문에 `engineId`(선택 — 없으면 기본 엔진 `cloudflare_flux_schnell`)를 더했다(FR-061a 「생성 엔진은 사용자가 고른다」). 꺼졌거나 목록 밖이면 422 `VALIDATION_FAILED`(`fields[0].path = "engineId"`), 횟수 불변. 고른 엔진은 생성 행 `engine` 에 적고 §7-1 payload `engineId` 로 넘긴다.
- **엔진별 전체 하루 한도**: 표 `promo_image_engine_usage(engine, usage_date)` 를 사람 횟수와 같은 트랜잭션·같은 조건부 갱신으로 센다(`engineDailyLimit`, Cloudflare 추천 100 — 무료 10,000 neurons/일 기준 추정, 미검증). 닿으면 409 `PROMO_FREE_QUOTA_EXHAUSTED` + `engineId` · `resetsAt`(새 코드를 만들지 않고 「무료량 소진」 코드를 같이 쓴다). 사람 횟수와 달리 실패해도 돌려주지 않는다(요청을 보냈으면 공급자 무료량을 썼을 수 있다). 이달 무료량(4단계)은 SX-6.8 이 더한다.
- 409 `PROMO_DAILY_LIMIT_REACHED` 본문에 `remaining: 0` 도 싣는다. 422 `PROMO_INPUT_BLOCKED` 본문의 `reason` 은 SX-6.3 판정 그대로.
- **에이전트가 접수하지 않으면**(꺼짐·거절) 기다리게 두지 않고 그 자리에서 작업·생성을 `failed`(`AGENT_UNAVAILABLE`)로 닫고 횟수를 돌려준다 — 응답은 그대로 202 이고 `status: "failed"`, `remaining` 은 돌려받은 값이다(503 을 쓰지 않는다 — 공통 오류 표에 503 이 없고, 앱은 같은 `generationId` 를 읽어 I41 「실패하면 횟수를 돌려줘요」를 보인다).
- `GET …/{generationId}` 응답에 `engine` 을 더했다. `remaining` 은 읽는 사람의 오늘 남은 횟수다. 대표는 같은 학원 수업의 생성을 읽을 수 있다.
- `history` 항목에 `engine` 을 더했다. `createdOn` 은 횟수를 차감한 KST 날짜(`usage_date`)다. `limit` 1~50(기본 20).
- **원복은 차감한 날 줄에서** 한다 — 23:59 KST 에 만들고 0시 뒤에 실패해도 전날 횟수가 돌아온다. 결과 전달(§7-2)의 실패·결과 모양 틀림(사진 바이트가 아님 포함)은 같은 트랜잭션에서 원복하고, 성공은 그림을 `uploaded_files`(`class_promo_image` · `private`, 올린 사람 = 만든 직원)에 넣는다.

**구현(SX-6.8 (추천안·사후 확인 2026-11-24))** — AI 생성 표시·무료량 소진. 순수 함수 `admin-web/lib/domain/ai-generated-mark.ts`(`aiGeneratedMark`·`coverAiMark`·`introAiMark`·`promoAiMarks`)와 `admin-web/lib/domain/promo-image-free-quota.ts`(`decidePromoFreeQuota`·`promoMonthRange`·`nextPromoMonthStartAt`·`providerExhaustedEngineCount`·`promoGenerateLock`·`promoActionAllowed`·`promoFreeQuotaNotice`). 위 문서와 다르거나 더한 것:
- **4단계 이달 무료량은 엔진마다** 센다. 설정 `promo-image-quota.json` 의 엔진 항목에 `monthlyFreeCap`(null = 달 단위로 막지 않음)을 더했다 — 위 문서의 학원 전체 하나짜리 `promo_image.monthly_free_cap`(80) 대신이다. 엔진을 고를 수 있게 된 뒤로 무료량은 공급자(엔진)마다 따로라서다. 출시 설정의 Cloudflare FLUX.1 [schnell] 은 무료 구간이 하루 단위라 `monthlyFreeCap: null` 이고 하루 한도(`engineDailyLimit` 100)로 막는다. 셈은 그 엔진으로 이번 달(KST, `usage_date`) 만든 장수 중 `queued`·`running`·`succeeded`(실패 제외). 읽기 셈이라 동시에 몰리면 한두 장 넘을 수 있다 — 달 한도는 실제 무료량보다 조금 낮게 둔다.
- 409 `PROMO_FREE_QUOTA_EXHAUSTED` 본문에 **`quotaScope`** 를 더했다: `monthly`(이달 무료량, `resetsAt` = 다음 달 1일 0시 KST) · `engine_daily`(엔진 하루 한도·공급자 소진, `resetsAt` = 다음 KST 0시). 둘 다 바닥나면 더 오래 막는 `monthly` 를 준다. 화면 문구는 `monthly` → 「이번 달 무료 생성량을 모두 썼어요. 사진을 올려 주세요.」, `engine_daily` → 「오늘은 이 엔진을 더 쓸 수 없어요」, 둘 다 `사진 올리기` 로 잇는다. 사람 하루 횟수는 줄지 않는다.
- **공급자 소진 표시**(`promo_image.provider_exhausted_until`)는 설정 칸을 따로 만들지 않고, `failureCode: PROVIDER_QUOTA_EXHAUSTED` 결과가 오는 같은 트랜잭션에서 그 생성의 KST 날짜·엔진 줄(`promo_image_engine_usage`)을 `engineDailyLimit` 까지 채운다 → 다음 KST 0시까지 그 엔진만 `engine_daily` 로 막힌다. 하루 한도가 없는 엔진(로컬)은 채우지 않는다. 그 생성의 사람 횟수는 다른 실패와 같이 돌려준다.
- **막는 것은 만들기 요청 하나뿐**이다. 수업 저장·승인 요청·대표 승인(S2-2)·홍보 자료 저장(`PUT …/promo-assets`)은 무료량을 읽지 않는다.
- **AI 생성 표시**: `GET`·`PUT /api/classes/{classId}/promo-assets` 응답에 `aiMarks: { cover, intro }` 를 더했다. 각 칸은 `null` 이거나 `{ aiGenerated: true, kind, badge: "AI 생성", note }` 다. 표지는 `ai_image` 일 때만(올린 사진은 표시 없음), 문구는 `ai`(「AI 가 만든 소개 문구예요」)와 `ai_edited`(「AI 초안을 고친 소개 문구예요」 — 고쳐도 표시를 떼지 않는다)일 때 붙고 `user` 는 없다. 배지 글자는 포스터 칸 배지(`POSTER_BADGE_LABELS.aiGenerated`)와 같다. 표시가 붙는 조합은 게시 관문의 「AI 가 만든 것이 있다」(`containsAiContent`)와 늘 같다(단위 테스트가 모든 조합을 견준다).

`POST /api/ai/class-intro-drafts` 요청 `{ "classId": "…", "emphasis": "처음 오는 분도 파트너 없이 신청할 수 있어요" }`(`emphasis` 선택, 60자 이하 — 61자는 422 `VALIDATION_FAILED`)
```json
{ "draftId": "…", "body": "살사의 기본 리듬과 바운스를 8주 동안 익혀요. 월·수 20:30–21:30 · 16회 · 300,000원. 처음 오는 분도 파트너 없이 신청할 수 있어요.",
  "aiGenerated": true, "facts": { "schedule": "월·수 20:30–21:30", "sessionCount": 16, "price": "300,000원", "level": "입문" } }
```
- 시간·가격·회차·레벨은 **모델이 쓰지 않는다.** Next.js 가 수업 데이터로 `facts` 를 만들어 에이전트 `POST /v1/intro-drafts` 에 주고, 에이전트는 자리표시자(`{{schedule}}` `{{sessionCount}}` `{{price}}` `{{level}}`)가 든 `bodyTemplate` 을 돌려주며 Next.js 가 `facts` 로 채운다. 자리표시자가 아닌 숫자가 본문에 있으면 거부하고 한 번 다시 만든다(실패하면 `facts` 만 나열한 기본 문장). 이미지 프롬프트(조명·색감)는 소개 문구에 쓰지 않는다.
- 수업에 시간·가격·회차가 없으면 409 `INTRO_FACTS_MISSING`. 제한 시간 20초(추천, 로컬 모델 응답 시간 미측정 — 열린 점 ⑫) — 넘으면 503 `AI_UNAVAILABLE` 이고 앱은 손으로 쓰게 한다. 다시 만들기는 횟수에 세지 않는다(소개 문구는 대화 모델이고 무료량과 무관) — 단 계정별 분당 10회 요청 제한(`RATE_LIMITED`, 추천값).
**구현(SX-6.6 (추천안·사후 확인 2026-11-24))** — 순수 함수 `admin-web/lib/domain/class-intro-draft.ts`(`introDraftRequestSchema`·`buildIntroFacts`·`buildIntroAgentPayload`·`fillIntroTemplate`·`fallbackIntroBody`·`draftIntroBody`), 서비스 `admin-web/lib/server/services/class-intro-drafts.ts`, 에이전트 `agent-server/app/promo/intro_writer.py`·`intro_routes.py`, 마이그레이션 `20261124T1207_class_intro_drafts`. 위 문서와 다르거나 더한 것:
- **facts 글자 모양**: `schedule` 은 요일 반복이면 「월·수 20:30–21:30」(요일은 월→일 순), 하루 일정이면 「12월 5일(토) 19:00–21:00」. `price` 는 「300,000원」, 0원은 「무료」. `sessionCount` 는 S2-2 의 `countSessions`(등록 경로가 실제로 만드는 회차 수). `level` 은 대상 레벨 한글(없으면 `null` — 그때 `{{level}}` 자리는 쓸 수 없다).
- **자리표시자 둘 추가**: `{{title}}`(수업 이름) · `{{emphasis}}`(강조할 점, 보냈을 때만). 둘 다 사람이 쓴 글이라 「8주 완성」 같은 숫자가 있어도 모델이 옮겨 적다 숫자 검사에 걸리지 않게 자리로 받는다. `{{sessionCount}}` 는 「16회」로 단위까지 채우고, 모델이 「{{sessionCount}}회」로 쓰면 단위를 한 번만 남긴다.
- **틀 검사(Next.js 가 원본)**: 자리 밖 아라비아·전각 숫자 → 거부. 모르는 자리·이 수업에서 쓸 수 없는 자리 → 거부. 시간·가격·회차 자리 중 빠진 것이 있으면 문장 끝에 그 값을 붙인다(세 값은 언제나 데이터 그대로 들어간다). 600자 초과 → 거부. 거부되면 한 번 더 받고, 두 번 다 거부되면 기본 문장 「{수업 이름}. {schedule} · {n}회 · {price}[ · {level}].[ {강조할 점}]」. 한글 수사(「열여섯」)는 오탐이 많아 보지 않는다.
- **에이전트 `POST /v1/intro-drafts`**: 요청 `{ "classTitle", "genre"(한글 장르명|null), "emphasis"(|null), "placeholders": ["schedule","sessionCount","price",…] }` — 수업 숫자와 홍보 이미지 칩·그림 문장은 싣지 않고, 모르는 칸은 422. 응답 200 `{ "bodyTemplate", "model" }`. 에이전트도 자리 밖 숫자가 있으면 한 번 더 묻지만 최종 판정은 Next.js 다. 모델이 답하지 않거나 두 번 다 JSON 이 아니면 503 `AI_UNAVAILABLE`. 강조할 점은 user 칸 JSON 데이터로만 싣는다(FR-270). 위 §1-4 표의 「200 §4-5」 는 이 절(§4-7)을 가리킨다.
- **503**: 첫 틀부터 에이전트가 답하지 않으면(꺼짐·20초 초과·주소 미설정) 503 `AI_UNAVAILABLE` + `fallback: "human"`, 초안 행 없음. 다시 만들기 도중에 멈추면 이미 facts 가 있으니 기본 문장으로 200. 공통 표에 503 이 없어 `HttpError.unavailable` 상자를 더했다.
- 409 `INTRO_FACTS_MISSING` 본문에 `missingFields`(`schedule`·`sessionCount`·`price` 중 빈 것). 요청 제한은 Redis 공통 제한기 규칙 `classIntroDraft`(계정당 60초 10회, `RATE_LIMIT_INTRO_DRAFT_*`) — 권한·facts 검사를 통과한 요청만 센다.
- 이 경로는 수업의 소개 문구를 바꾸지 않는다 — 저장·검토는 `PUT …/promo-assets`(SX-6.7). 기본 문장으로 끝난 초안도 `aiGenerated: true` 이고 `class_intro_drafts.model` 만 NULL 이다.

`PUT /api/classes/{classId}/promo-assets` — 전체 교체
```json
{ "uploadedPhotoFileId": null, "aiImageGenerationId": "…", "introText": "…", "introSource": "ai_edited", "introDraftId": "…",
  "reviewConfirmed": true }
```
- 표지 결정은 서버가 한다: `uploadedPhotoFileId` 가 있으면 **사진이 먼저**(`coverSource: "uploaded_photo"`), 없고 `aiImageGenerationId`(내 것·`succeeded`)가 있으면 AI 이미지(`coverSource: "ai_image"`), 둘 다 없으면 표지 없음(`null`).
- `introSource` = `ai`(초안 그대로) · `ai_edited`(고침) · `user`(직접). `reviewConfirmed: true` 는 「강사·대표가 이미지와 문구를 검토·교체했다」는 확인이다 — 저장하며 `reviewed_at`·`reviewed_by` 를 쓴다. `false` 면 저장은 되지만 검토 안 됨 상태로 남는다.
- **검토 없이 게시 못 한다(FR-061 · FR-061a, SX-6.7)**: AI 가 만든 표지(`ai_image`)나 AI 문구(`introSource` 가 `ai`·`ai_edited`)가 있는데 `reviewed_at` 이 없으면 S2-2 의 승인 요청(S2-2.3)과 대표 승인(S2-2.7)이 `PROMO_REVIEW_REQUIRED`(409)로 거부한다 — 두 서비스가 `assertPromoAssetsReviewed(classId)` 를 부른다(열린 점 ⑩, S2-2 계약에 이 코드를 더한다). 사진만·직접 쓴 글만이면 검토 확인이 필요 없다. 문구·표지를 고치면 `reviewed_at` 이 비워진다.
- 응답 200 `PromoAssets`: `{ "classId", "coverSource", "coverFileId", "coverUrl", "introText", "introSource", "aiGenerated": true, "reviewedAt", "textOverlay": { "source": "class_data" } }`. `textOverlay.source` 는 이미지 위 글자의 원본이 수업 데이터임을 알리는 고정값이다.
- 다른 학원·강사 수업이면 403 `FORBIDDEN`. 이미 `approved`(게시된) 수업의 표지·문구 바꾸기는 S2-2 의 수정 요청 경로를 따른다(이 경로는 거부: 409 `CLASS_NOT_EDITABLE`, S2-2 와 조율).
**구현(SX-6.7 (추천안·사후 확인 2026-11-24))** — 서비스 `admin-web/lib/server/services/class-promo-assets.ts`(`createClassPromoAssetsRoutes`·`assertPromoAssetsReviewed`·`publishPromoCoverFile`), 순수 함수 `admin-web/lib/domain/class-promo-assets.ts`, route `app/api/classes/[classId]/promo-assets/route.ts`, 마이그레이션 `20261124T1225_class_promo_assets`. 위 문서와 다르거나 더한 것:
- **본문 칸은 모두 생략 가능**(빠지면 null · `reviewConfirmed` 는 false) — 전체 교체라 빠진 칸은 「없음」이다. 다른 칸(예: 이미지 위 글자)은 422.
- **사진이 먼저 — 수업 포스터도 사진이다**: 본문 `uploadedPhotoFileId` 가 없어도 수업에 S2-2.8 포스터(`classes.poster_file_id`)가 붙어 있으면 그 사진이 표지다. 사진이 이기면 보낸 AI 이미지는 저장하지 않는다(`ai_image_generation_id` NULL). 새로 고른 사진은 부르는 사람이 올린 `poster` 파일이고 다른 수업의 포스터·표지가 아니어야 한다(S2-2.8 과 같은 422).
- **고를 수 있는 AI 이미지·초안**: 이 수업(`class_id`)의 성공한 생성 · 이 수업의 초안이고, 부르는 사람이 만든 것이거나 **이미 이 수업에 저장된 것**(대표가 강사의 AI 표지·초안을 그대로 둔 채 검토 확인할 수 있게). 아니면 422 `VALIDATION_FAILED`(path `aiImageGenerationId`·`introDraftId`).
- **출처 검사**: `introSource: "ai"` 인데 글이 초안 본문과 다르면 422(path `introSource` — 고쳤으면 `ai_edited`). `ai`·`ai_edited` 는 `introDraftId` 필수, `user` 는 `introDraftId` 를 보내지 않는다. `introText`·`introSource` 는 짝.
- **검토 확인**: `reviewConfirmed: true` 인 저장마다 `reviewed_at = now()`·`reviewed_by` 와 감사 `promo_assets.reviewed` 1행. false 인 저장은 둘 다 비운다(고친 저장은 검토 확인을 다시 받아야 한다).
- **상태**: `published`·`cancelled` 수업은 409 `CLASS_NOT_EDITABLE`. `draft`·`pending_approval` 은 저장된다 — 승인 대기 중에 검토 확인을 지우는 저장을 하면 대표 승인이 `PROMO_REVIEW_REQUIRED` 로 막힌다.
- **게시 관문의 자리**: 승인 요청(S2-2.3)·대표 승인(S2-2.7) 모두 수업 행을 조건부 UPDATE 로 잠근 **같은 트랜잭션 안에서** `assertPromoAssetsReviewed` 를 부른다(저장도 같은 행을 FOR UPDATE — 엇갈려도 옛 검토 확인으로 통과하지 않는다). 대표가 직접 올린 수업(바로 공개)도 같은 관문을 지난다. 수업이 공개되는 트랜잭션에서 `publishPromoCoverFile` 이 AI 표지 파일을 `public` 으로 바꾼다(data-model §13-6 열린 점 ⑤).
- **응답 `aiGenerated`** 는 고정 true 가 아니라 계산값 — AI 표지이거나 문구가 `ai`·`ai_edited` 면 true. `coverUrl` 은 `/api/files/{id}`(S2-2.8 포스터와 같은 방식). 파일 내려받기(`file-download.ts`)는 표지 사진·AI 표지를 「붙은 학원」에 더해 그 학원 대표가 승인 전에 열어 본다.
- GET 권한은 PUT 과 같다(수업을 올린 강사 — 지금도 소속·위임 — 또는 그 학원 대표). 저장한 적이 없으면 모든 칸 null 인 모양을 200 으로 준다.

### 4-8. `GET /api/instructors/{instructorId}` — 강사 프로필(M15) 입구 (SX-5.7)

응답 200 — `instructor_candidates` 항목(§5-2)에서 `action` 만 뺀 모양:
```json
{ "instructorId": "…", "displayName": "이준호", "photoUrl": null, "genres": ["salsa_bachata"],
  "academies": [ { "id": "…", "name": "라틴하우스 강남" } ], "publishedOfferingCount": 2 }
```
- 읽기는 `find_instructors` 와 같은 함수·같은 공개 조건(`lib/server/services/name-candidates.ts` 의 `findPublicInstructorById`)이다 — 이름으로 안 나오는 강사(소속 대기·역할 취소·계정 정지·게시 제한 학원만 소속)는 id 로도 404 `NOT_FOUND`. id 모양이 틀려도 같은 404. 연락처·본명은 읽지 않는다.
- 회원 세션만(`requireMember`, 수업 상세와 같다). `Cache-Control: private, no-store`.
- 소개 영상·자격·관심 강사·1:1 개인 레슨 칸은 아직 없다 — 그 기능 Task 가 칸을 더한다.
- 앱은 수업 상세의 `instructorId`(02 §2 에 더함)와 강사 후보 카드로 이 화면에 들어온다. 「AI 플래너에게 이 강사 수업 물어보기」는 `POST /api/ai/chat` 을 `context.instructorId` 로 부른다(§3). (추천안·사후 확인 2026-11-24)

## 5. 검색 조건·카드 모양

### 5-1. 조건(`conditions` 이벤트 · `search_offerings` 입력 공통)

```json
{ "instructor": { "name": "이준호", "id": null }, "academy": { "name": "라틴하우스 강남", "id": null },
  "genre": null, "weekdays": ["sat", "sun"], "timeBand": "morning", "level": null,
  "regionSido": null, "regionGu": null, "maxPriceAmount": null, "dateFrom": null, "dateTo": null }
```
- `weekdays` `mon`…`sun`. `timeBand` = `morning`(06:00–12:00)·`afternoon`(12:00–18:00)·`evening`(18:00–24:00) 또는 `{"from":"18:00","to":"21:00"}`(KST, 열린 점 ⑨ 추천 경계). 비워 둔 칸은 `null`.
- **S3-2(탐색) 의 검색 조건과 같은 서비스 함수**를 쓴다 — 이름이 다르면 S3-2 가 이기고 이 표를 맞춘다(열린 점 ⑨). 추가된 칸은 `instructor`·`academy`(이름→id)뿐이다(FR-037a).
- 조건 뽑기에서 어떤 칸도 못 뽑으면 조건 없음으로 검색하지 않는다 — 「조건을 더 알려 주세요」 문장만 낸다.
- 조건 뽑기(SX-5.2) 구현 규칙: 에이전트 `app/planner/condition_extractor.py` 의 LangGraph 노드 1개(`extract_conditions`)가 강사·학원·요일·시간대·장르·레벨 여섯 칸만 채우고 `regionSido`·`regionGu`·`maxPriceAmount`·`dateFrom`·`dateTo` 는 늘 `null` 이다. 이름은 「강사님·선생님」 같은 부름말을 떼고 질문 글자 안에 있을 때만 받는다(`id` 는 SX-5.1 도구가 채운다). 「전체 학원」「모든 학원」은 `academy: null`. 장르는 강사·학원 이름을 뺀 질문에 장르 낱말이 있을 때만 받는다(「라틴하우스 강남」의 「라틴」은 장르가 아님). 모델 답이 두 번 다 망가지면 조건 뽑기 실패(추천안·사후 확인 2026-11-24)
- 지역 칸(SX-4.1(조건 추출)): 같은 노드가 `regionSido`·`regionGu` 도 채운다 — SX-5.2 의 「지역은 늘 `null`」은 이 줄이 바꾼다. 값은 학원 표 낱말(시·도 「서울」 · 구·군·시 「강남구」「수원시」)이고, `app/planner/region_names.py` 의 표 찾기가 「강남」→강남구 · 「서울특별시」→서울 · 동네 이름(「홍대」→서울 마포구 등)을 맞춘다. 한 시·도에만 있는 구는 시·도를 채우고(강남구→서울), 여러 도시에 있는 구(중구·강서구 …)는 말하지 않으면 시·도를 비운다. 표 찾기를 먼저 쓰고 빈 칸만 모델 값(질문 글자 안에 있을 때만)으로 채운다. 강사·학원 이름을 지운 질문에서만 찾는다(「라틴하우스 강남」은 지역 아님). 여러 지역을 말하면 앞의 하나만. 모델이 장르를 비워도 이름 밖에 한 장르 낱말만 있으면 그 장르로 본다. 예산·날짜는 여전히 `null`(추천안·사후 확인 2026-11-24)

### 5-2. `cards` 항목

`offering_cards`(M10F · FR-037a 「수업 카드」)
```json
{ "offeringId": "…", "classId": "…", "title": "바차타 커플반", "genre": "salsa_bachata", "isPrivateLesson": false,
  "academy": { "id": "…", "name": "라틴하우스 강남" }, "hall": "B홀",
  "pattern": [ { "weekday": "thu", "startTime": "21:00", "endTime": "22:00" } ],
  "firstSessionDate": "2026-11-12", "lastSessionDate": "2026-12-31", "sessionCount": 8, "level": "beginner",
  "pools": [ { "seatKind": "male", "remaining": 2 }, { "seatKind": "female", "remaining": 3 } ],
  "priceAmount": 140000, "recruitStatus": "open", "waitlistAvailable": false,
  "action": { "type": "open_offering", "offeringId": "…" } }
```
- `recruitStatus` = `open`(모집 중) · `closing_soon`(마감 임박 — 남은 자리가 정원의 10% 이하이거나 2자리 이하, W29 와 같은 함수) · `full`(마감, `waitlistAvailable` 이 대기 신청 가능 여부, FR-093).
- **`action.type` 은 `open_offering` 하나뿐이다**(SX-5.6 「신청하기는 수업 상세로만」). 예약·결제를 일으키는 값은 없다. 앱은 `GET /api/offerings/{offeringId}`(02 계약)로 이어 간다.
- 신청하기(SX-5.6) 구현 규칙: 버튼 값은 Next.js `lib/domain/offering-card-action.ts` 의 `openOfferingAction(offeringId, classId)` 한 함수로만 만들고(id 두 개 말고는 담지 않는다), 앱 이동 경로는 같은 파일의 `offeringCardDestination` 이 id 로 계산한다 — 정규 수업 `/offering/{offeringId}`(홈 목록 카드와 같은 상세), 개인 레슨 `/offering/private-lesson/{classId}`(M15B 화면 자리). 경로를 카드 값에 따로 싣지 않는다. 스트림 번역(SX-1.5)은 `offering_cards`·`recommendations` 항목의 `action` 을 에이전트 값 대신 id 로 다시 만들고, 약속한 칸 밖의 칸(예 `checkoutUrl`)은 빼며, id 가 uuid 가 아닌 항목은 버린다(추천안·사후 확인 2026-11-24)
- 개인 레슨(`isPrivateLesson`)은 「레슨 모집」 시간만 보이고 `priceAmount` 는 학원이 정한 값 그대로다(FR-052c).
- 승인 전 수업·입점 심사 전 학원의 수업·판매 중이 아닌 판매 단위는 나오지 않는다(SX-5.3 수용 ③ — 도구 서버가 S3-2 의 공개 조건과 같은 필터를 쓴다). `level` 은 S2-2 가 `classes.level` 을 만들면 채운다(없으면 `null`, 열린 점 ⑨).
- 수업 카드(SX-5.3) 구현 규칙: Next.js `lib/server/services/offering-search.ts` 의 `searchOfferingCards` 가 홈 목록·상세와 같은 공개 조건으로 DB 를 직접 읽어 카드 값을 그대로 옮긴다(읽기 전용 — 기한 지난 결제 정리도 부르지 않는다). `level` 은 `classes.target_level`, `hall` 은 수업 기본 홀 이름. 요일·시간대는 **모든 예정 회차**가 들어가야 맞고 자정을 넘는 회차는 어떤 시간대에도 들지 않는다. `recruitStatus` 는 모든 자리 묶음이 0 이면 `full`, 한 묶음이라도 0 이거나 `isNearlyFull`(W29 함수)이면 `closing_soon`. **개인 레슨**은 판매 단위가 없어 `offeringId: null` · `classId` = 상품 수업 id · `pools: []` · `sessionCount` = 수강권 횟수 · `level: null` 이고, `pattern`·기간은 지금 이후의 `open`(「레슨 모집」) 시간에서만 만든다(held·booked 제외, 칸마다 조건을 걸러 하나라도 남은 상품만). 레벨 조건이 있으면 개인 레슨은 고르지 않는다. `action` 은 `{ "type": "open_offering", "offeringId": … \| null, "classId": "…" }` 로 `classId` 를 더했다. 입력은 이름만 있고 `id` 가 없는 `instructor`·`academy`, 조건이 하나도 없는 요청, `from >= to` 시각 구간을 `INVALID_INPUT` 으로 거부한다. 정렬은 첫 회차(개인 레슨은 첫 모집 시간)가 가까운 순(추천안·사후 확인 2026-11-24)

`no_offering_result`(결과 없음 — SX-5.4, FR-037a 「찾지 못했어요」): `search_offerings` 가 0건이면 Next.js 순수 함수 `lib/domain/offering-no-result.ts` 의 `buildNoResultReply(conditions, cards)` 가 아래 값을 만든다(1건 이상이면 `null`).
```json
{ "kind": "no_offering_result", "sentence": "조건에 맞는 수업을 찾지 못했어요.", "hint": "아래 버튼으로 조건을 넓혀 다시 찾아볼 수 있어요.", "aiGenerated": false,
  "actions": [ { "type": "widen_search", "widen": "instructor_other_offerings", "label": "이준호 강사님의 다른 수업 보기", "conditions": { §5-1 열한 칸, 강사만 남김 } },
               { "type": "widen_search", "widen": "drop_academy", "label": "모든 학원 수업 보기", "conditions": { … } } ] }
```
- 버튼 조건은 원래 조건에서 **칸을 빼기만** 한다(값을 바꾸거나 더하지 않음 — FR-039). 순서 `instructor_other_offerings`(강사만 남김) → `drop_academy` → `drop_time_band` → `drop_weekdays` → `drop_level` → `drop_genre` → `drop_date`(시작·끝 함께) → `drop_price` → `drop_region`(시·도·구 함께). 조건이 하나도 안 남거나 원래·앞 버튼과 같은 조건이면 건너뛰고 최대 3개. 버튼 조건은 그대로 `search_offerings` 입력(+`limit`)으로 통과한다.
- 버튼이 없으면 `hint` 는 강사만으로 0건일 때 「이 강사님이 지금 모집 중인 수업이 없어요.」, 그 밖에는 「다른 장르나 강사 이름으로 다시 물어봐 주세요.」. 문장은 고정 문구라 `aiGenerated: false`(FR-210). 버튼별 수업 수는 세지 않는다(순수 함수). 앱(SX-5.7)은 `widen_search` 를 누르면 그 `conditions` 로 다시 찾는다 — `action.type` 이 `open_offering` 하나뿐이라는 규칙은 수업 카드(`offering_cards`)의 것이고, 이 버튼은 예약·결제를 일으키지 않는 조회다(추천안·사후 확인 2026-11-24)

`instructor_candidates`(M10G)
```json
{ "instructorId": "…", "displayName": "김하나", "photoUrl": null, "genres": ["dance_sport"],
  "academies": [ { "id": "…", "name": "라틴하우스 강남" } ], "publishedOfferingCount": 3,
  "action": { "type": "select_instructor", "instructorId": "…" } }
```
후보가 둘 이상이면 **수업 카드를 함께 내지 않는다**(「AI 가 짐작해서 답하지 않아요」). 앱이 `select_instructor` 를 누르면 같은 `POST /api/ai/chat` 을 `context.instructorId` 로 다시 부른다. 일반 검색 대체(SX-5.5)도 `context.instructorId` 가 공개 강사면 글자에서 강사를 다시 고르지 않고 그 강사로 찾으며, 찾은 조건을 `data-conditions`(transient) 로 카드 앞에 낸다 — 앱의 조건 칩. 공개 강사가 아니면 정해진 값을 버리고 글자로 찾는다(SX-5.7, 추천안·사후 확인 2026-11-24). 학원 이름도 같은 방식(`academy_candidates`, 모양은 `academies` 대신 `region` 포함 — 열린 점 ⑨).

`recommendations`(SX-4) 항목은 `offering_cards` 항목 + `{ "reason": "취향 장르(살사/바차타)와 18시 이후 가능 시간이 맞아요", "reasonSources": [ {"kind":"profile","label":"가입 때 고른 관심 장르"} ] }`. **없는 수업 추천 0건(SC-011)을 두 번 막는다**: 에이전트가 이 run 에서 `search_offerings` 가 돌려준 `offeringId` 안에서만 고르고, Next.js 가 번역 전에 같은 run 의 도구 결과 id 집합과 DB 를 다시 대조해 없는 항목은 버린다(버린 수는 `ai_runs` 에 기록). 추천 근거는 문장 한 줄(FR-040)이고 시간 충돌·정원·존재는 규칙으로 검증한다(FR-038, 모델 호출 없음 — FR-268).
- 추천 구현 규칙(SX-4.2(있는 수업만 추천)): 에이전트 `app/planner/recommender.py` 의 `recommend` 가 이 run 의 `search_offerings` 카드만 후보로 받는다. ① 규칙 검사 — `offeringId` 없음·중복·`recruitStatus=full`·`get_my_schedule` 회차와 같은 날 시각 겹침(끝과 시작이 붙는 것은 겹침 아님)을 뺀다. 이동 거리는 카드에 위치 값이 없어 아직 보지 않는다. ② 고르기 — 모델에게 id 없이 번호 붙인 후보 목록과 회원 취향만 주고(질문 원문은 주지 않음, FR-270) 번호 배열(많아야 3개)로 받는다. 목록 밖·겹친 번호는 버리고, 모델이 실패하거나 다 버려지면 취향과 맞는 수가 많은 순서(같으면 검색 순서)로 고른다. ③ 근거 — `reason` 은 모델이 아니라 규칙이 맞춰 본 사실(관심 장르·가능 시간대·가능 요일·레벨 → 없으면 질문 조건 → 없으면 모집 상태)로 만든 문장이고, `reasonSources` 는 그 출처(`profile`·`conditions`·`offering`)다. ④ 마지막에 추천 id 를 검색 결과 id 집합과 다시 대조한다. 회원 취향은 요청 맥락의 `memberTaste`(`genres`·`timeBands`·`weekdays`·`level`·`schedule`)로 받는다 — 프로필 읽기 도구가 계약에 없어서다. 평가는 `eval/run_eval.py --group recommend`(문항 12개, 검색 결과는 `eval/fixtures/recommend_search_results.json`). Next.js 쪽 두 번째 대조는 이 Task 범위 밖이다 (추천안·사후 확인 2026-11-24)

## 6. MCP 읽기 도구 — `POST /api/internal/mcp` (층 B2)

MCP Streamable HTTP, 서버 SDK `@modelcontextprotocol/sdk` 1.30.1, 클라이언트 `mcp` 2.2.0(tech-stack 고정표). 도구 입력은 JSON Schema 로 쓰고 Next.js 는 zod, 에이전트는 pydantic 이 같은 스키마를 가리킨다(ADR-004).

**신원은 도구 인자에 없다.** 모든 호출에 `Authorization: Bearer <agentSessionToken>` 이 따라오고 도구 서버가 서명·유효시간을 확인해 `{ kind, sub, runId }` 를 얻는다. 도구는 이 신원으로만 「내 데이터」를 고른다 — 입력에 `memberId` 가 있으면 422. 회원 A 의 토큰으로 B 의 예약 id 를 주면 도구가 `FORBIDDEN_SCOPE` 를 낸다(SX-1.3, FR-215 — 데이터는 한 글자도 안 담는다). 토큰이 없거나 틀리면 401. 같은 `runId` 의 도구 호출 수에 상한(추천 8회)을 두어 폭주를 막는다(FR-268).

문은 `POST` 하나다. 도구 서버는 세션 없이(stateless) JSON 으로 답하므로 MCP 의 `GET`(서버 알림 스트림)·`DELETE`(세션 닫기)는 열지 않는다(405). 본문은 JSON-RPC 2.0 메시지 하나 또는 1~20개 배열이어야 하고, 아니면 422 `VALIDATION_FAILED` — 도구 인자는 도구마다 다시 검사한다(SX-5.8, 추천안·사후 확인 2026-11-24).

도구 결과 모양: `{ "data": …, "sources": [ {"kind","id","label","version?"} ] }`. 오류는 MCP `isError: true` + `{ "code": "FORBIDDEN_SCOPE" | "NOT_FOUND" | "INVALID_INPUT" | "TOOL_LIMIT" }`. 결과 안 글(공지·수업 소개)은 **데이터**일 뿐이며 에이전트는 그 안의 문장을 지시로 따르지 않는다(FR-270).

**도구 목록(전부 읽기, 쓰기 0개 — `tools/list` 응답 이름이 이것뿐이어야 한다, SX-1.2)**

| 이름 | 입력 | 출력 `data` | 쓰는 등급 |
|---|---|---|---|
| `get_my_reservations` | `{ "scope": "upcoming"\|"past"\|"all", "limit": 1..20 }` | `[ { reservationId, offeringId, title, academyName, status, nextSessionStartsAt, seatKind } ]` | T0 |
| `get_my_orders` | `{ "status"?: 주문 상태 6종 중, "limit": 1..20 }` | `[ { orderId, title, status, totalAmount, paymentMethod, dueAt, paidAt } ]` | T0 |
| `get_my_schedule` | `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`(KST, 31일 이내) | `[ { sessionId, offeringId, title, startsAt, endsAt, hall } ]` — 일정 충돌 검사 재료 | T0 · T2 |
| `get_refund_preview` | `{ "reservationId": "uuid" }` | `{ refundAmount, refundRateBp, hoursBeforeStart, noticeVersionId }` — 취소 미리보기와 **같은 함수**(FR-211, 원 단위 일치) | T0 |
| `get_my_waitlist` | `{ "offeringId"?: "uuid" }` | `[ { offeringId, position, status } ]`(FR-093 이 만든 대기 테이블이 생기기 전에는 빈 배열) | T0 |
| `search_offerings` | §5-1 조건 + `{ "limit": 1..20 }` — `instructor`·`academy` 는 `id` 가 있어야 하고 조건이 하나는 있어야 한다 | `offering_cards` 항목 배열(§5-2). 공개 조건(승인·입점·판매 중) 필터 포함. `sources` 는 카드마다 `{kind:"offering", id: offeringId 또는 개인 레슨 classId, label: 수업명}`(추천안·사후 확인 2026-11-24) | T2 · SX-5 |
| `find_instructors` | `{ "name": "…", "academyName"?: "…", "limit": 1..5 }` | `{ "resolution": "unique"\|"ambiguous"\|"none", "candidates": [ instructor_candidates 항목 ] }` — 같은 이름이 둘 이상이면 `ambiguous` 이고 `resolved` 는 없다. 하나면 `unique`. 실제 모양은 `{ "resolution", "resolved": 후보 하나 \| null, "candidates" }` — `resolved` 는 `unique` 일 때만 채우고 판정은 limit 으로 자르기 전 전체 수로 한다. 이름은 앞뒤 공백만 떼고 정확히 같은 것만, 후보는 공개 학원(active·노출 중지 없음)에 active 소속이 있는 강사만(추천안·사후 확인 2026-11-24) | SX-5 |
| `find_academies` | `{ "name": "…", "limit": 1..5 }` | `{ "resolution": …, "resolved": 후보 하나 \| null, "candidates": [ { academyId, name, regionSido, regionGu, publishedOfferingCount } ] }` — 공개 학원(active·노출 중지 없음)만, `resolved` 규칙은 `find_instructors` 와 같다(추천안·사후 확인 2026-11-24) | SX-5 |
| `get_offering_detail` | `{ "offeringId": "uuid" }` | 02 계약 상세의 읽기 부분(회차·가격·정원·환불 공지 본문·중개자 고지) — 공개 조건 밖이면 `NOT_FOUND` | T0 · T2 |
| `get_academy_info` | `{ "academyId": "uuid" }` | `{ name, address, phone(가림 여부는 공개 정보 규칙), openingHours, facilities, parking, accessibility, currentNotices: [ {kind, version, summary} ], closures: [ … ] }` — 학원 정보 질문(FR-273) | T0 · T1 |
| `get_policy_text` | `{ "kind": "terms"\|"privacy"\|"refund_notice"\|"membership_plan", "academyId"?: "uuid" }` | `{ version, effectiveFrom, body }` — 현재 판본 본문(약관·환불 정책·요금제) | T1 |
| `search_knowledge` | `{ "queryEmbedding": number[], "academyId"?: "uuid", "topK": 1..20 }` | `[ { knowledgeItemId, scope, academyId, question, answer, evidence, reviewAfter, score } ]` — `status='active'` 만(`review_due`·`retired` 제외, FR-226 · FR-227). 벡터는 에이전트 서버가 임베딩 호출로 만들어 넘긴다 | T1 · T2 |

- 도구 서버는 모델·임베딩을 부르지 않는다(「모델은 에이전트 서버만」). `search_knowledge` 의 질의 벡터를 에이전트가 만드는 이유다.
- 도구 호출 기록(이름·인자·결과 요약·건수)은 Next.js 가 `ai_messages.tool_calls` 에 남긴다(FR-216). 결과 본문 전체는 남기지 않는다.
- 강사·대표용 도구(정산·명단 등)는 이번 범위에 없다(열린 점 ⑦). 추가하더라도 이 표의 규칙(신원은 토큰, 쓰기 없음, 범위 밖 `FORBIDDEN_SCOPE`)을 따른다.
- FAQ 초안(`faq_draft` 작업)은 `kind=job`·`academyId` 클레임의 토큰으로 `get_academy_info`·`get_policy_text`·`search_knowledge` 만 부를 수 있다(그 학원 데이터만).

## 7. 층 B1 — 에이전트 서버 HTTP 상세

### 7-1. `POST /v1/jobs` — 비동기 작업

공통 요청 `{ "jobId": "…", "kind": "poster_extract"\|"promo_image"\|"faq_draft", "deadlineMs": 120000, "agentSessionToken"?: "…", "payload": {…} }`. 응답 202 `{ "jobId": "…", "accepted": true }`. 같은 `jobId` 는 두 번 접수하지 않는다(200 `accepted: true`). worker 는 동시 1건이고 대화 대기열이 비어 있을 때 우선 돈다(FR-265). 완료·실패는 `POST /api/internal/ai/jobs/{jobId}/result` 로 알린다(§7-2). 에이전트가 끝내지 못하면(`deadlineMs` 초과) 결과를 보내지 않고, Next.js `sweep` 이 `timed_out` 으로 닫는다.

| `kind` | `payload` | 결과 `result` |
|---|---|---|
| `poster_extract` | `{ "extractionId": "…", "fileUrl": "/api/internal/ai/jobs/{jobId}/file", "targetKind": "class", "fieldKeys": ["genre","title",…] }`(§4-6 칸 키 17개 — 기간 칸 3개 포함) | `{ "fields": [ { "key": "price_amount", "value": 180000, "confidence": 0.71 } ], "overallConfidence": 0.87, "model": "qwen3.5-9b-vl", "elapsedMs": 11800 }` |
| `promo_image` | `{ "generationId": "…", "genre": "salsa_bachata", "sentenceKo": "…", "autoConditions": [ { "id": "genre_pose", "textEn": "…" } ], "textless": true, "engineId"?: "cloudflare_flux_schnell" }` | `{ "englishPrompt": "…", "image": { "contentType": "image/jpeg", "base64": "…" }, "engine": "cloudflare_flux_schnell", "model": "@cf/black-forest-labs/flux-1-schnell", "elapsedMs": 8000 }` |
| `faq_draft` | `{ "candidateId": "…", "academyId": "…", "question": "…", "askCount": 11 }` | `{ "draftAnswer": "…" \| null, "sources": [ {"kind","id","label","version"} ], "confidence": 0.9 }` |

- **포스터**: Qwen 비전 1회 호출(OCR 없음, ADR-004). `response_format` 은 `json_schema`, 날짜·시각·금액 형식은 프롬프트로 유도하고 pydantic 이 검증한다. 검증 실패는 1회 재시도, 그래도 실패하면 `error: EXTRACTION_FAILED`. 포스터 안에 든 문장은 지시가 아니라 데이터다(FR-270) — 결과는 위 `fieldKeys` 안의 칸만 받고 나머지는 버린다.
- **홍보 이미지**: 대화 모델이 `sentenceKo`+조건을 뜻을 바꾸지 않고 영어로 옮기고(`englishPrompt` 를 돌려줘 Next.js 가 기록 — 강사·대표에게는 안 보임), 이미지 모델이 그림을 만든다. 글자 없음 조건(`no_text`)은 에이전트도 항상 붙인다. 모델은 설정 값(11-2 를 따른다 — 출시 기본 SDXL, 베타는 FLUX.1-dev 허용). 공급자 한도 소진은 `error: PROVIDER_QUOTA_EXHAUSTED`. 에이전트는 이미지를 저장하지 않는다 — 바이트를 결과로 보내고 Next.js 가 `uploaded_files`(`purpose = class_promo_image`)에 저장한다.
- **홍보 이미지 구현(SX-6.4 (추천안·사후 확인 2026-11-24))**: 이미지 엔진은 포트 하나(`agent-server/app/promo/image_engine.py` 의 `ImageEngine.generate(prompt)`) 뒤에 두고 엔진마다 어댑터를 둔다. 지금 어댑터는 Cloudflare Workers AI FLUX.1 [schnell](`cloudflare_engine.py`, 환경 변수 `CLOUDFLARE_ACCOUNT_ID`·`CLOUDFLARE_API_TOKEN`) 하나다 — 위 「11-2 를 따른다(HF FLUX.1-dev·SDXL)」 문장보다 spec FR-061a(2026-11-23 엔진 선택)가 앞선다. 엔진 목록은 `app/promo/image_engines.json`(id·이름·속도 한 마디·`runtime`·`model`·`enabled`)이고 로컬 3개(`local_sana_sprint`·`local_flux2_klein`·`local_z_image_turbo`)는 8GB 실측 전이라 `enabled:false` 다. payload `engineId` 는 사용자가 고른 엔진이고 없으면 `cloudflare_flux_schnell`, 꺼졌거나 목록에 없으면 422 `VALIDATION_FAILED`. 결과에 `engine`(엔진 id)과 `model`(엔진 안 모델 이름)을 함께 싣는다(FR-061a 「어느 엔진으로 만들었는지 기록」). 번역은 `sentenceKo` 만 대화 모델이 옮기고(입력은 user 칸 JSON 데이터, 한글이 남거나 JSON 이 아니면 1회 재시도) 조건 문장은 받은 영어를 그대로 붙이며 `no_text` 영어는 payload 에 없어도 맨 끝에 한 번 붙는다. `englishPrompt` 는 엔진에 실제로 보낸 문장 전체다. 실패 코드: Cloudflare 429·오류 코드 4006 → `PROVIDER_QUOTA_EXHAUSTED`, 번역 실패·엔진 오류·사진 아닌 답 → `PROVIDER_ERROR`. 엔진별 전체 하루 한도는 DB 셈이 필요해 Next.js(SX-6.5) 몫이다.
- **FAQ 초안**: 도구로만 근거를 읽고, 근거 없는 사실 문장은 내지 않는다. 근거를 못 찾으면 `draftAnswer: null`.

### 7-2. `POST /api/internal/ai/jobs/{jobId}/result` — 결과 전달(층 B2)

요청 `{ "status": "succeeded", "result": {…}, "elapsedMs": 11800 }` 또는 `{ "status": "failed", "error": { "code": "EXTRACTION_FAILED", "message": "…" } }`. `X-Internal-Token` 필수.

| 상황 | 응답 |
|---|---|
| `ai_jobs` 가 `queued`·`running` 이고 결과가 스키마를 통과 | 200 `{"applied":true}` — kind 별로 Next.js 가 쓴다: 포스터 → `poster_extraction_fields` 채움·상태 `ready` · 홍보 이미지 → `uploaded_files` 저장·상태 `succeeded` · FAQ → `faq_candidates.draft_*` |
| 이미 끝난 작업(두 번째 결과·늦게 온 결과) | 200 `{"applied":false}` — 아무것도 바꾸지 않는다 |
| 결과가 스키마를 못 넘음(칸 키 밖·값 형식 밖) | 422 `VALIDATION_FAILED` — 작업은 `failed`(`INVALID_RESULT`)로 닫고 홍보 이미지면 횟수를 돌려준다 |
| `failed` | 200 `{"applied":true}` — 작업 `failed`. 홍보 이미지면 같은 트랜잭션에서 횟수 원복 |
| 모르는 `jobId` | 404 `NOT_FOUND` |

작업이 `running` 인 동안에만 `GET /api/internal/ai/jobs/{jobId}/file`(포스터 원본)을 받을 수 있고 그 밖에는 404.

### 7-3. 스케줄 경로

- `POST /api/internal/ai/faq-candidates/build` — 본문 없음. 그 사이 쌓인 질문(`ai_runs` 중 `T1`·`T2`·`T3` 이관된 것, 학원 맥락이 있는 것)을 학원별로 묶는다. 묶기는 정규화한 질문 글 일치로 시작한다(벡터 유사도 묶기는 SX-3.2 뒤 — 열린 점 ⑭). 묶음 크기가 `faq.candidate_min_asks`(추천 3) 이상이면 `faq_candidates` 를 만들고 `faq_draft` 작업을 접수한다. 응답 `{ "created": 2, "returned": 1, "draftJobs": 2 }`. 두 번 불러도 같은 후보는 `dedupe_key` 로 1건.
- `POST /api/internal/ai/sweep` — 응답 `{ "reviewDue": 1, "jobsTimedOut": 0, "conversationsClosed": 4 }`. 작업 기한 초과 시 홍보 이미지 횟수를 원복하고, 보관 기간(열린 점 ⑮)이 지난 미이관 대화를 닫는다.

## 8. 평가 세트 형식(SX-3.1 · FR-276)

파일 `agent-server/eval/set.jsonl`(한 줄 한 문항, 최소 50문항) · 실행 `uv run python eval/run_eval.py [--dry-run] [--group t1|t2|recommend]`.

```json
{ "id": "t1-017", "group": "t1", "context": {"kind":"inquiry","academyFixture":"latin-house"},
  "question": "첫 수업에 신발은 어떤 걸 신어야 하나요?",
  "expect": { "tier": "T1", "mustCite": ["knowledge_item:shoes"], "mustInclude": ["실내 운동화"], "language": "ko" },
  "forbid": { "claims": ["가격","잔여석"], "phrases": ["환불해 드리겠습니다"], "tools": ["search_offerings"] } }
```
`group` 은 `t0`·`t1`·`t2`·`t3`·`recommend`·`search`. 합격 기준은 SC-044(비한국어 답 0건)·SC-045(입력에 없는 사실 주장 0건)·`recommend` 의 없는 수업 0건(SC-011). 한 줄이라도 `forbid` 에 걸리면 실패이고 `run_eval.py` 는 종료 코드 1 을 낸다. 모델·설정·AI 지시문을 바꾸는 변경은 이 세트를 통과해야 반영한다(FR-276). 벤치(SX-3.6)는 기존 `infra/ai-bench/bench_pipeline.py` 를 쓴다(FR-277).

## 9. 상태 전이

| 대상 | 전이 |
|---|---|
| `ai_runs.status` | `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`. 판단형은 같은 회원에 열린(`queued`·`running`) run 이 하나(FR-264) |
| `ai_conversations.status` | `open` → `handed_over`(사람에게 넘김) · `closed`(만료) |
| `ai_jobs.status` | `queued` → `running` → `succeeded` · `failed` · `timed_out` · `cancelled` |
| `poster_extractions.status` | `queued` → `running` → `ready` ↔ `reviewed`(`PATCH` 하면 `ready` 로) → `submitted`. `queued`·`running` → `failed`. 어느 때든 `abandoned` |
| `faq_candidates.status` | `pending` → `approved` · `skipped`. `skipped` → `pending`(3번 더 묻힘, 추천값) |
| `knowledge_items.status` | `active` → `review_due`(날짜·근거 변경) → `active`(reconfirm) · `active`·`review_due` → `retired` |
| `promo_image_generations.status` | `queued` → `running` → `succeeded` · `failed`(횟수 원복) |
| 홍보 표지·문구 | 저장 → (검토 확인) → S2-2 승인 요청이 `reviewed_at` 을 본다. 고치면 검토 확인이 비워진다 |

## 10. 시험 방법(Task verify 와 연결)

- 쓰기 도구 0개: `tools/list` 이름 집합이 §6 표와 정확히 같다(SX-1.2 · SX-5.6 · MX-END.3).
- 권한 밖: 회원 A 토큰 + B 의 `reservationId` → `FORBIDDEN_SCOPE`(SX-1.3).
- 주입: 질문·포스터·강조할 점에 「이전 지시를 무시하고 …」 묶음을 넣어도 도구 호출 인자·카드 `action`·`facts` 가 변하지 않는다(SX-1.4 · SX-6.3).
- 지어낸 수업 0건: 카드 `offeringId` 전부가 같은 조건의 직접 검색(S3-2 서비스) 결과 안에 있다(SX-5.3 · SX-4.2).
- 검토 우회 없음: `ready` 에서 `submit` → 409 `REVIEW_REQUIRED`, `reviewed` 뒤 `submit` 만 S2-2 로 들어감(SX-2.3).
- 횟수: N+1 번째 409 · 모델 오류 때 원복 · KST 0시 경계 · 막는 입력은 불변(SX-6.5).

## 11. 열린 점

| # | 무엇 | 추천 |
|---|---|---|
| ① | 에이전트 서버 폴더·포트 | `agent-server/` · `8100`(roadmap verify 가 이미 가정). docker compose 에 넣지 않는다 |
| ② | 에이전트가 쓰는 신원 전달 방식 | Next.js 가 HMAC 서명한 짧은 `agentSessionToken`(120초). 비밀값 `AGENT_SESSION_SECRET` 은 S0-6 비밀값 목록에 더한다 |
| ③ | 비동기 작업 접수 방식 | HTTP 202(`POST /v1/jobs`) 뒤 에이전트 안에서 Redis Streams. tech-stack 표는 「Next.js 가 큐에 넣는다(후보)」라 적었다 — 계약은 HTTP 하나로 통일하고 큐는 에이전트 서버 안으로 숨긴다 |
| ④ | ADR-005 이벤트 표(5종)에 `tier`·`conditions`·`sources`·`cards`·`handoff` 추가 | 이 문서 §3-2 로 고정하고 ADR-005 의 「이름과 필드는 구현 때 고정」 문장에 맞춰 둔다 |
| ⑤ | 임베딩 차원·모델 이름·리랭커 호출 규격 | SX-3.2 실측으로 확정(R16 약관 확인이 먼저). `knowledge_items.embedding` 은 차원을 못 박지 않는다 |
| ⑥ | 판단형 하루 한도 · 후보 최소 질문 수 · 후보 복귀 기준 | 20회 · 3회 · 3번 더. 모두 `ai_settings` 값(spec 에 수가 없다) |
| ⑦ | 강사·대표의 AI 질문(FR-215 가 강사 질문을 예로 든다) | 보드가 없어 이번 범위 밖. 필요해지면 `kind=staff` 토큰과 도구를 더한다 |
| ⑧ | 운영자의 플랫폼 지식 승인 화면 · FR-275 운영자 AI 지표 화면 | 보드가 없어 만들지 않는다. 베타 플랫폼 지식은 시드 스크립트로 넣고, 지표 칸은 `ai_runs` 에 있어 S7-4 가 화면만 얹으면 된다 |
| ⑨ | S3-2 의 검색 조건 이름 · 수업 `level` 칸 · 강사 프로필 id(S2-1) · 학원 후보 카드 모양 · 시간대 경계(`morning`=06~12시 등) | S3-2·S2-1·S2-2 계약과 조율. 다르면 그쪽이 이긴다 |
| ⑩ | S7-2 문의 만들기 서비스 이름·테이블 · S2-2 의 수업 편집 판정·`PROMO_REVIEW_REQUIRED` 반영 · `CLASS_NOT_EDITABLE` | S7-2·S2-2 담당과 조율. 이 계약은 호출 지점만 정한다 |
| ⑪ | 막는 입력 판정 방식 | 낱말·이름·상표 목록 + 정규식(모델 판정 없음 — 로컬 모델 시간·오탐). 목록은 `ai_settings` 로 고친다. 실존 인물·타사 상표 목록의 범위는 사용자 확인 |
| ⑫ | 소개 문구 동기 호출 시간 | 로컬 대화 모델 응답 시간 미측정. 20초 안에 안 오면 직접 쓰기 |
| ⑬ | 포스터: 확인필요 기준 · 파티·공연·대회의 칸 키 · 정확도 목표 | 0.80 · S6-4 와 조율 · 목표 미정(SCH 카드). 지금 칸 키는 정규 수업 기준 |
| ⑭ | 반복 질문 묶기(글 일치 vs 벡터 유사도) · 수업·강사 벡터 색인(추천 SX-4) | 처음은 글 일치. 벡터 색인은 필요해질 때 `offering_embeddings` 를 더한다 |
| ⑮ | 대화 보관 기간 · 질문 가림 규칙의 범위 | 넘기지 않은 대화 30일임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 가림은 전화·메일·계좌·주민번호 모양. 문의 이력 보관(FR-232)·개인정보 보존 표(O-16)와 맞춘다 |
| ⑯ | 월 무료 이미지량 | 약 80장은 검색 결과 기준 미검증(tech-stack 11-2). 설정 `promo_image.monthly_free_cap`(추천 80)과 공급자 소진 신호 둘로 막는다 |
| ⑰ | 추천(SX-4) 켜는 때 | 설정 `ai.recommend_enabled` 기본 꺼짐. 게시 수업이 쌓인 뒤 사람이 켠다(spec). SX-5 는 베타부터 켠다 |
| ⑱ | 판단형 첫 이벤트 기준 1.5초 · 전체 25초 · 헬스 5초 간격 3번 | 추천값. SC-046·SC-041·SC-048 에서 역산. 실측으로 고친다 |
