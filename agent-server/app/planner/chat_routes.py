"""`POST /v1/chat/stream` — AI 플래너 질문 한 건(SSE) (SX-5.8(말로 찾기 실동작·챗봇 대화형 AI 답변), 계약 16 §3-2).

- Next.js 만 부른다(헤더 `X-Agent-Token`). 본문은 계약 §3-2 의 여섯 칸이고 모르는 칸은 거부한다.
- 이번 Task 는 플래너(`context.kind = "planner"`)만 답한다. 학원 문의(`inquiry`)는 SX-3 Task 몫이라
  `error{MODEL_UNAVAILABLE, fallback:"human"}` 으로 바로 닫는다 — Next.js 가 「사람에게 물어보기」로 이어 준다.
- 응답 한 덩어리 = `event: <이름>\\ndata: <JSON>\\n\\n`. 처리 중 예외가 나도 스트림을 그냥 끊지 않고
  `error{fallback:"plain_search"}` 로 닫는다 — Next.js 는 그것을 보고 일반 검색으로 대신 답한다(SX-5.5).
"""

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from mcp.types import TextContent
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.jobs.job_routes import _error, _token_ok
from app.planner.condition_extractor import ConditionExtraction, extract_conditions
from app.planner.planner_run import PlannerDeps, PlannerRequest, PlannerTools, ToolCallFailedError, run_planner
from app.planner.text_client import OpenAICompatTextClient, TextClient
from app.settings import load_settings
from app.tools.read_only_toolbox import ReadOnlyToolbox
from app.tools.read_catalog import SearchOfferingsInput
from app.tools.tool_session import AgentSessionToken, mcp_endpoint, open_read_toolbox

router = APIRouter()
logger = logging.getLogger("kdance.agent.chat")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PreviousConditions(SearchOfferingsInput):
    """앞 질문 조건(§5-1 열한 칸). 검색 입력과 같은 모양이되 limit 은 없다."""

    limit: int = Field(default=1, ge=1, le=20, exclude=True)
    # 「모집 중」만 보기(SX-5.8, 계약 열한 칸 밖 — 검색 입력에는 넣지 않고 결과를 거른다)
    recruitOpenOnly: bool | None = None


class ChatContext(_Strict):
    kind: Literal["planner", "inquiry"]
    academyId: UUID | None
    offeringId: UUID | None
    instructorId: UUID | None
    # 이어 묻기(SX-5.8) — 앱이 들고 있는 앞 답의 조건. 없으면 새 대화
    previousConditions: PreviousConditions | None = None


class ChatStreamBody(_Strict):
    runId: str = Field(min_length=1, max_length=100)
    context: ChatContext
    message: str = Field(min_length=1, max_length=500)
    degraded: bool
    deadlineMs: int = Field(ge=1000, le=60000)
    agentSessionToken: str = Field(min_length=1, repr=False)


class _ToolboxAdapter:
    """읽기 도구 상자 결과(MCP) → `{data, sources}` 사전. 도구 오류는 코드만 담은 예외로."""

    def __init__(self, toolbox: ReadOnlyToolbox) -> None:
        self._toolbox = toolbox

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self._toolbox.call(name, arguments)
        text = "".join(block.text for block in result.content if isinstance(block, TextContent))
        if result.is_error:
            raise ToolCallFailedError(name)
        body = json.loads(text)
        if not isinstance(body, dict):
            raise ToolCallFailedError(name)
        return body


class ChatRuntime:
    """경로가 쓰는 재료 — 진짜는 kdance-llm·Next.js MCP, 테스트는 가짜로 바꿔 끼운다."""

    def __init__(self, *, agent_api_token: str, extract_client: TextClient, writer: TextClient | None, tools_factory: Any) -> None:
        self.agent_api_token = agent_api_token
        self.extract_client = extract_client
        self.writer = writer
        # (agentSessionToken) → 비동기 컨텍스트 관리자(PlannerTools)
        self.tools_factory = tools_factory


@lru_cache(maxsize=1)
def get_chat_runtime() -> ChatRuntime:
    settings = load_settings()
    mcp_url = mcp_endpoint(settings.next_internal_base_url)

    def tools_factory(session_token: str):
        @asynccontextmanager
        async def opened() -> AsyncIterator[PlannerTools]:
            # 질문 한 건마다 새 신원 토큰으로 연다(SX-1.3) — 토큰은 열어 보지 않고 그대로 싣는다
            async with open_read_toolbox(
                mcp_url, session=AgentSessionToken(session_token), internal_token=settings.internal_api_token
            ) as toolbox:
                yield _ToolboxAdapter(toolbox)

        return opened()

    return ChatRuntime(
        agent_api_token=settings.agent_api_token,
        extract_client=OpenAICompatTextClient(
            base_url=settings.llm_base_url, model_name=settings.llm_chat_model, timeout_seconds=15.0, max_tokens=200
        ),
        # 소개 문장 1~2개 — 160 토큰이면 넉넉하다. 시간은 run_planner 가 남은 시간으로 다시 자른다
        writer=OpenAICompatTextClient(
            base_url=settings.llm_base_url, model_name=settings.llm_chat_model, timeout_seconds=15.0, max_tokens=160
        ),
        tools_factory=tools_factory,
    )


def sse(name: str, data: dict[str, Any]) -> bytes:
    return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n".encode()


async def stream_events(body: ChatStreamBody, runtime: ChatRuntime) -> AsyncIterator[bytes]:
    """질문 하나의 SSE 바이트를 낸다. 어떤 예외든 error 이벤트로 닫는다."""
    if body.context.kind != "planner":
        yield sse("error", {"code": "MODEL_UNAVAILABLE", "fallback": "human"})
        return
    previous = (
        body.context.previousConditions.model_dump(mode="json", by_alias=True) if body.context.previousConditions else None
    )

    async def extract(question: str) -> ConditionExtraction:
        return await extract_conditions(question, client=runtime.extract_client)

    deps = PlannerDeps(
        extract=extract,
        open_tools=lambda: runtime.tools_factory(body.agentSessionToken),
        writer=runtime.writer,
    )
    request = PlannerRequest(
        message=body.message,
        previous_conditions=previous,
        fixed_instructor_id=str(body.context.instructorId) if body.context.instructorId else None,
        deadline_ms=body.deadlineMs,
    )
    try:
        async for name, data in run_planner(request, deps):
            yield sse(name, data)
    except Exception as error:  # noqa: BLE001 — 스트림 중 예외는 모두 대체 규칙으로 닫는다
        # 원인 종류만 기록한다(질문·토큰·도구 결과는 싣지 않는다)
        logger.warning("run %s 플래너 실패: %s", body.runId, type(error).__name__)
        yield sse("error", {"code": "MODEL_UNAVAILABLE", "fallback": "plain_search"})


@router.post("/v1/chat/stream", response_model=None)
async def chat_stream(
    request: Request,
    runtime: Annotated[ChatRuntime, Depends(get_chat_runtime)],
    x_agent_token: Annotated[str | None, Header()] = None,
) -> StreamingResponse | JSONResponse:
    if not _token_ok(x_agent_token, runtime.agent_api_token):
        return _error(401, "UNAUTHORIZED", "에이전트 토큰이 맞지 않아요")
    try:
        body = ChatStreamBody.model_validate(await request.json())
    except (ValueError, ValidationError):
        return _error(422, "VALIDATION_FAILED", "입력값을 확인해 주세요")
    return StreamingResponse(
        stream_events(body, runtime),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
