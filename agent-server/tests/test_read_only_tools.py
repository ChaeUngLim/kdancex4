"""MCP 읽기 도구만 쓴다 — 도구 목록에 쓰기 0개 (SX-1.2(MCP 읽기 도구)).

무엇을 지키는 테스트인가
- 에이전트는 DB 에 직접 붙지 않고 Next.js 가 연 MCP 도구로만 데이터를 읽는다(ADR-004).
- 에이전트가 쓸 수 있는 도구는 계약 16 §6 표의 12개 읽기 도구뿐이어야 한다(FR-214(AI 쓰기 금지)).
- 도구 서버가 실수로(또는 누가 끼워 넣어) 쓰기 도구를 광고해도 에이전트 쪽 목록에는 들어오지 않고,
  불러 달라고 해도 서버에 요청이 나가지 않아야 한다.

진짜 Next.js 도구 서버(`POST /api/internal/mcp`)는 다른 Task 몫이라, 여기서는 같은 MCP 프로토콜로
말하는 가짜 서버(mcp SDK 의 MCPServer)를 메모리 안에서 띄워 실제 `tools/list`·`tools/call` 을 주고받는다.
"""

import inspect
import re
from pathlib import Path
from typing import Any

import anyio
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ValidationError

from app.tools.read_catalog import READ_TOOLS, READ_TOOL_NAMES
from app.tools.read_only_toolbox import ReadOnlyToolbox, ToolNotAllowedError

# 계약 원본. 테스트가 계약 표를 직접 읽어 「코드의 목록 = 계약의 목록」을 확인한다.
CONTRACT_16 = Path(__file__).resolve().parents[2] / "_workspace" / "03_contracts" / "16-ai-agent.md"

# 이름이 이런 동사로 시작하면 쓰기 도구로 본다(예약·취소·환불·결제·게시·지우기 등).
WRITE_VERB = re.compile(
    r"^(create|add|insert|update|edit|set|put|patch|delete|remove|cancel|refund|pay|charge|"
    r"book|reserve|submit|approve|publish|post|send|confirm|write|save|upsert|transfer)_"
)
# 읽기 도구 이름은 이 세 동사로만 시작한다.
READ_VERB = re.compile(r"^(get|search|find)_")


def _contract_tool_names() -> set[str]:
    """계약 16 §6 「도구 목록」 표의 첫 칸(도구 이름)을 모은다."""
    text = CONTRACT_16.read_text(encoding="utf-8")
    section = text.split("## 6. MCP 읽기 도구", 1)[1].split("\n## 7.", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", section, flags=re.MULTILINE))


def _fake_tool_server(calls: list[str], *, extra_write_tools: bool) -> MCPServer:
    """Next.js 도구 서버 흉내. 12개 읽기 도구 + (선택) 쓰기 도구 3개를 광고한다.

    `calls` 에 실제로 불린 도구 이름을 적어 두어, 막힌 호출이 서버까지 갔는지 볼 수 있게 한다.
    """
    server = MCPServer("fake-next-tools")

    def make_read(name: str, input_model: type[BaseModel]) -> Any:
        def handler(**kwargs: Any) -> dict[str, Any]:
            calls.append(name)
            return {"data": [], "sources": [], "echo": kwargs}

        # 가짜 서버의 입력 스키마를 계약 입력 칸 이름으로 맞춘다 — 모든 칸은 선택.
        # (`from` 처럼 파이썬 예약어인 칸은 파이썬 이름 `from_` 으로 둔다. 가짜 서버 흉내일 뿐이다.)
        handler.__signature__ = inspect.Signature(  # type: ignore[attr-defined]
            [
                inspect.Parameter(key, inspect.Parameter.KEYWORD_ONLY, default=None, annotation=Any)
                for key in input_model.model_fields
            ]
        )
        return handler

    for spec in READ_TOOLS:
        server.add_tool(
            make_read(spec.name, spec.input_model),
            name=spec.name,
            description=spec.description,
            annotations=ToolAnnotations(read_only_hint=True),
        )

    if extra_write_tools:

        def cancel_reservation(reservationId: str) -> dict[str, Any]:
            calls.append("cancel_reservation")
            return {"ok": True}

        def create_order(offeringId: str) -> dict[str, Any]:
            calls.append("create_order")
            return {"ok": True}

        def get_secret_export() -> dict[str, Any]:
            # 이름은 읽기처럼 보이지만 계약에 없는 도구 — 이름만 그럴듯하면 통과하는지 본다.
            calls.append("get_secret_export")
            return {"ok": True}

        server.add_tool(cancel_reservation, name="cancel_reservation")
        server.add_tool(create_order, name="create_order")
        server.add_tool(
            get_secret_export,
            name="get_secret_export",
            annotations=ToolAnnotations(read_only_hint=True),
        )
    return server


# ---------------------------------------------------------------------------
# 1) 에이전트 쪽 등록 목록 자체
# ---------------------------------------------------------------------------


def test_registered_tools_match_contract_table_exactly() -> None:
    # 등록 목록 = 계약 16 §6 표(12개). 더 있으면 계약 밖 도구, 덜 있으면 빠진 도구다.
    assert len(READ_TOOLS) == 12
    assert READ_TOOL_NAMES == _contract_tool_names()


def test_registered_write_tools_are_zero() -> None:
    # FR-214(AI 쓰기 금지): 이름이 쓰기 동사로 시작하는 도구 0개, 전부 get_/search_/find_ 로 시작.
    write_like = [name for name in READ_TOOL_NAMES if WRITE_VERB.match(name)]
    assert write_like == []
    assert all(READ_VERB.match(name) for name in READ_TOOL_NAMES)


def test_tool_inputs_carry_no_identity_and_reject_extra_keys() -> None:
    # 신원은 토큰으로만 온다(계약 16 §6). 입력 스키마에 memberId 같은 칸이 없고, 넣으면 거부한다.
    for spec in READ_TOOLS:
        fields = set(spec.input_model.model_fields)
        assert not {"memberId", "member_id", "userId", "sub"} & fields, spec.name
        with pytest.raises(ValidationError):
            spec.input_model.model_validate({**spec.example_input, "memberId": "someone-else"})
        # 예시 입력은 통과해야 한다(스키마가 너무 막혀 있지 않은지).
        spec.input_model.model_validate(spec.example_input)


# ---------------------------------------------------------------------------
# 2) MCP 로 실제 주고받기 — 서버가 쓰기 도구를 광고해도 에이전트 목록엔 0개
# ---------------------------------------------------------------------------


def test_toolbox_lists_only_read_tools_even_if_server_advertises_writes() -> None:
    calls: list[str] = []
    server = _fake_tool_server(calls, extra_write_tools=True)

    async def scenario() -> tuple[list[str], list[str], list[str]]:
        async with Client(server) as client:
            advertised = [tool.name for tool in (await client.list_tools()).tools]
            listing = await ReadOnlyToolbox(client).list_read_tools()
            return advertised, [tool.name for tool in listing.allowed], sorted(listing.rejected)

    advertised, allowed, rejected = anyio.run(scenario)

    assert len(advertised) == 15  # 서버는 12 + 3 을 광고했다
    assert set(allowed) == READ_TOOL_NAMES  # 에이전트 목록엔 12개 읽기 도구만
    assert [name for name in allowed if WRITE_VERB.match(name)] == []  # 쓰기 0개
    assert rejected == ["cancel_reservation", "create_order", "get_secret_export"]


def test_toolbox_blocks_non_catalog_tool_before_it_reaches_server() -> None:
    calls: list[str] = []
    server = _fake_tool_server(calls, extra_write_tools=True)

    async def scenario() -> None:
        async with Client(server) as client:
            toolbox = ReadOnlyToolbox(client)
            for name in ("cancel_reservation", "create_order", "get_secret_export"):
                with pytest.raises(ToolNotAllowedError):
                    await toolbox.call(name, {})

    anyio.run(scenario)
    assert calls == []  # 막힌 호출은 서버에 한 번도 닿지 않았다


def test_toolbox_drops_catalog_name_marked_not_read_only() -> None:
    # 이름은 목록에 있어도 서버가 「읽기 아님」(read_only_hint=False)이라고 광고하면 빼 둔다.
    server = MCPServer("fake-mislabelled")
    server.add_tool(
        lambda scope, limit: {"data": []},
        name="get_my_reservations",
        annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True),
    )

    async def scenario() -> tuple[list[str], list[str]]:
        async with Client(server) as client:
            listing = await ReadOnlyToolbox(client).list_read_tools()
            return [tool.name for tool in listing.allowed], listing.rejected

    allowed, rejected = anyio.run(scenario)
    assert allowed == []
    assert rejected == ["get_my_reservations"]


def test_toolbox_reads_through_mcp_with_validated_input() -> None:
    calls: list[str] = []
    server = _fake_tool_server(calls, extra_write_tools=False)

    async def scenario() -> Any:
        async with Client(server) as client:
            toolbox = ReadOnlyToolbox(client)
            # 범위 밖 값(limit 99)은 서버에 보내기 전에 거부한다.
            with pytest.raises(ValidationError):
                await toolbox.call("get_my_reservations", {"scope": "all", "limit": 99})
            return await toolbox.call("get_my_reservations", {"scope": "upcoming", "limit": 5})

    result = anyio.run(scenario)
    assert result.is_error is False
    assert calls == ["get_my_reservations"]  # 올바른 읽기 호출 1건만 서버에 닿았다
