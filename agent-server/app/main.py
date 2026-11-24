"""kdance AI 에이전트 서버의 조립 지점 (SX-1.1(에이전트 서버 뼈대)).

이 서버가 무엇인가 — 처음 보는 사람용 요약
- 제품 API·DB 쓰기는 Next.js(admin-web) 하나가 맡는다. 이 서버는 그 옆에서 따로 도는
  **Python 프로세스**로, 모델(LLM·임베딩·리랭커)을 부르는 유일한 곳이다(ADR-004).
- 그래서 이 서버에는 DB 접속 코드가 없다. 데이터가 필요하면 나중 Task(SX-1(에이전트 서버
  뼈대·읽기 도구)의 MCP 읽기 도구)에서 Next.js 가 연 읽기 전용 도구로만 본다(FR-214(AI 쓰기 금지)).
- 살아 있는지 묻는 ``GET /health`` 와, 포스터 읽기 작업을 받는 ``POST /v1/jobs``(SX-2.2)를 연다.
  띄우는 법(계약 ``_workspace/03_contracts/16-ai-agent.md`` §0, 포트 8100):
  ``cd agent-server && uv run uvicorn app.main:app --port 8100``
"""

from fastapi import FastAPI

from app.jobs.job_routes import router as job_router
from app.planner.chat_routes import router as chat_router
from app.promo.intro_routes import router as intro_router

app = FastAPI(title="kdance-agent-server")
# 비동기 작업 접수 `POST /v1/jobs`(SX-2.2(포스터 → 초안 추출) — 지금은 포스터 읽기만)
app.include_router(job_router)
# 소개 문구 틀 `POST /v1/intro-drafts`(SX-6.6(소개 문구 초안)) — 동기 경로, 숫자는 쓰지 않고 자리표시자만
app.include_router(intro_router)
# AI 플래너 질문 한 건 `POST /v1/chat/stream`(SX-5.8(말로 찾기 실동작)) — 조건 뽑기·MCP 읽기 도구 검색·답 문장을 SSE 로
app.include_router(chat_router)


@app.get("/health")
def health() -> dict[str, str]:
    """살아 있는지만 답한다.

    토큰 없이 열려 있는 유일한 경로다(계약 16 §1-4). Next.js 나 사람이 "프로세스가 떠 있나"를
    볼 때 쓰므로, 모델 서버·DB 같은 바깥 연결은 일부러 확인하지 않는다 — 바깥이 죽어도
    이 서버 자체가 살아 있으면 ok 다. 바깥 연결 점검은 나중 Task 의 ``/health/deps`` 몫이다.
    """
    return {"status": "ok"}
