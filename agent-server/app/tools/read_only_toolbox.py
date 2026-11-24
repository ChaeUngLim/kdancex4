"""MCP 도구 서버로 가는 유일한 통로 — 읽기 도구만 통과시킨다 (SX-1.2(MCP 읽기 도구)).

처음 보는 사람용 요약
- 에이전트가 데이터를 볼 길은 이 상자 하나다. 상자는 MCP 클라이언트(`mcp.Client`)를 감싸고,
  `read_catalog.READ_TOOLS` 에 적힌 읽기 도구만 꺼내 주고 불러 준다(FR-214(AI 쓰기 금지)).
- 왜 서버를 믿지 않고 여기서도 거르나: 도구 서버(Next.js)에 실수로 쓰기 도구가 생기거나
  누가 끼워 넣어도, 에이전트 쪽 목록에는 들어오지 않게 하려는 이중 잠금이다. MCP 의
  `read_only_hint` 는 「힌트」일 뿐이라(믿지 말라고 SDK 가 적어 둠) **이름 허용 목록이 본 잠금**이고,
  힌트가 「읽기 아님」이라고 말하면 이름이 맞아도 한 번 더 뺀다.
- 막힌 호출은 네트워크로 나가기 전에 멈춘다 — 서버는 그런 요청을 받지도 않는다.
"""

import json
from dataclasses import dataclass
from typing import Any

from mcp import Client
from mcp.types import CallToolResult, TextContent, Tool

from app.tools.read_catalog import READ_TOOLS_BY_NAME


class ToolNotAllowedError(Exception):
    """허용 목록에 없는 도구(쓰기 도구·계약 밖 도구)를 부르려 했다."""


class ForbiddenScopeError(Exception):
    """도구 서버가 「이 회원의 데이터가 아니다」(`FORBIDDEN_SCOPE`)라고 거절했다 (SX-1.3(권한 밖 데이터 차단)).

    메시지에는 도구 이름만 담는다. 부른 인자(남의 예약 id 등)나 서버 응답 본문은 담지 않는다 —
    이 오류가 모델 문맥이나 기록으로 흘러가도 남의 데이터가 한 글자도 섞이지 않게(FR-215).
    """

    def __init__(self, tool_name: str) -> None:
        super().__init__(f"권한 밖 데이터라 도구 서버가 거절했다: {tool_name}")
        self.tool_name = tool_name


def _error_code(result: CallToolResult) -> str | None:
    """도구 오류 결과(`isError: true`)에서 계약 16 §6 의 `code` 를 꺼낸다. 모양이 다르면 None."""
    if not result.is_error:
        return None
    for block in result.content:
        if isinstance(block, TextContent):
            try:
                body = json.loads(block.text)
            except json.JSONDecodeError:
                continue
            if isinstance(body, dict) and isinstance(body.get("code"), str):
                return str(body["code"])
    return None


@dataclass(frozen=True)
class ReadToolListing:
    """도구 서버가 광고한 목록을 거른 결과."""

    allowed: tuple[Tool, ...]  # 에이전트에게 보여 줄 읽기 도구
    rejected: list[str]  # 걸러 낸 이름(기록·경보용)


def _is_allowed(tool: Tool) -> bool:
    """이 도구를 에이전트에게 보여 줘도 되나."""
    # 1) 본 잠금: 계약 §6 허용 목록에 이름이 있어야 한다.
    if tool.name not in READ_TOOLS_BY_NAME:
        return False
    # 2) 보조 잠금: 서버 스스로 「읽기 아님」이라고 밝힌 도구는 이름이 맞아도 뺀다.
    hints = tool.annotations
    if hints is not None and (hints.read_only_hint is False or hints.destructive_hint is True):
        return False
    return True


class ReadOnlyToolbox:
    """MCP 클라이언트를 감싸 읽기 도구만 나열·호출한다."""

    def __init__(self, client: Client) -> None:
        self._client = client

    async def list_read_tools(self) -> ReadToolListing:
        """`tools/list` 를 받아 허용 목록에 맞는 읽기 도구만 남긴다."""
        advertised = (await self._client.list_tools()).tools
        allowed = tuple(tool for tool in advertised if _is_allowed(tool))
        rejected = [tool.name for tool in advertised if not _is_allowed(tool)]
        return ReadToolListing(allowed=allowed, rejected=rejected)

    async def call(self, name: str, arguments: dict[str, Any]) -> CallToolResult:
        """읽기 도구 하나를 부른다. 목록 밖이거나 입력이 틀리면 서버에 보내기 전에 멈춘다."""
        spec = READ_TOOLS_BY_NAME.get(name)
        if spec is None:
            raise ToolNotAllowedError(f"읽기 허용 목록에 없는 도구다: {name}")
        # 입력을 계약 모양으로 검사한다. 모르는 칸(memberId 등)·범위 밖 값은 여기서 ValidationError.
        checked = spec.input_model.model_validate(arguments)
        payload = checked.model_dump(mode="json", by_alias=True, exclude_none=True)
        # 신원은 인자에 없다 — 연결(tool_session.open_read_toolbox)이 헤더의 토큰으로만 싣는다(SX-1.3).
        result = await self._client.call_tool(name, payload)
        # 도구 서버가 「남의 데이터」라고 거절하면 결과를 돌려주지 않고 멈춘다.
        # 결과 객체를 그대로 넘기면 부르는 쪽이 실수로 본문을 모델 문맥에 넣을 수 있어서다(FR-215).
        if _error_code(result) == "FORBIDDEN_SCOPE":
            raise ForbiddenScopeError(name)
        return result
