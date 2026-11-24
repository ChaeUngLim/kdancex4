"""말로 찾기(AI 플래너)는 읽기만 한다 — 도구 목록에 쓰기 0개 (SX-5.6(신청하기는 수업 상세로만·쓰기 도구 0개)).

무엇을 지키는 테스트인가
- 회원이 「이준호 강사 주말 오전 수업」을 물으면 에이전트는 조건을 뽑고(SX-5.2) 읽기 도구로 수업을 찾는다
  (SX-5.1 find_instructors·find_academies, SX-5.3 search_offerings). 카드의 「신청하기」는 수업 상세로 가기뿐이고,
  예약·결제는 회원이 상세 화면에서 직접 한다 — 에이전트가 쓸 수 있는 쓰기 도구는 0개여야 한다(FR-214(AI 쓰기 금지)).
- SX-1.2 테스트가 허용 목록 전체를 본다면, 이 테스트는 **말로 찾기 흐름**이 실제로 닿는 자리를 본다:
  ① 허용 목록에 예약·주문·결제·취소 같은 쓰기 도구 이름이 0개 ② 말로 찾기가 부르는 세 도구가 모두 읽기 목록 안에 있고
  입력에 결제·좌석 칸이 없다 ③ 도구 서버가 `book_offering`·`create_order` 를 광고해도 에이전트 목록에는 들어오지 않고
  불러도 서버에 닿지 않는다 ④ 에이전트 소스가 Next.js 에 보내는 쓰기성 호출은 작업 결과 전달 하나뿐이다(계약 16 「쓰기 0 규칙」 ③).
"""

import re
from pathlib import Path
from typing import Any

import anyio
import pytest
from mcp import Client
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from app.tools.read_catalog import READ_TOOLS_BY_NAME, READ_TOOL_NAMES
from app.tools.read_only_toolbox import ReadOnlyToolbox, ToolNotAllowedError

APP_DIR = Path(__file__).resolve().parents[1] / "app"

# 말로 찾기 흐름이 부르는 도구(계약 16 §6 의 SX-5 행)
PLANNER_TOOLS = ("find_instructors", "find_academies", "search_offerings")

# 도구 이름을 `_` 로 나눈 마디 가운데 하나라도 이 동사면 쓰기 도구로 본다 — 예약·주문·결제·취소·게시·지우기.
# (「refund」는 넣지 않는다: get_refund_preview 의 refund 는 「환불 미리보기」라는 명사다. 첫 마디 규칙이 따로 막는다)
WRITE_VERBS = frozenset(
    {
        "create", "insert", "update", "delete", "remove", "cancel", "pay", "charge", "checkout", "book",
        "reserve", "submit", "approve", "publish", "post", "send", "confirm", "write", "save", "upsert",
        "transfer", "enroll", "apply", "purchase", "hold", "set", "edit", "add",
    }
)
# 읽기 도구 이름의 첫 마디는 이 셋뿐이다
READ_FIRST = frozenset({"get", "search", "find"})
# 입력에 이런 칸이 있으면 도구가 돈·자리를 움직일 수 있다는 뜻이다(검색 조건 maxPriceAmount 같은 거르기 칸은 해당 없음)
WRITE_FIELDS = frozenset(
    {"paymentMethod", "cardNumber", "amount", "seatKind", "quantity", "orderId", "reservationId", "idempotencyKey"}
)


def _is_write_name(name: str) -> bool:
    parts = name.split("_")
    return parts[0] not in READ_FIRST or any(part in WRITE_VERBS for part in parts)


def test_allowlist_has_zero_write_tools() -> None:
    # 허용 목록 이름 어디에도 쓰기 동사가 없다(첫 마디뿐 아니라 이름 전체 마디를 본다)
    assert [name for name in READ_TOOL_NAMES if _is_write_name(name)] == []
    # 판정기가 쓰기 이름을 실제로 잡는지도 본다 — 못 잡는 검사기는 검사기가 아니다
    assert all(_is_write_name(n) for n in ("book_offering", "create_order", "get_and_cancel_reservation", "pay_order"))


@pytest.mark.parametrize("name", PLANNER_TOOLS)
def test_planner_tools_are_read_only_and_carry_no_payment_fields(name: str) -> None:
    spec = READ_TOOLS_BY_NAME[name]  # 허용 목록에 있어야 한다(없으면 KeyError)
    fields = set(spec.input_model.model_fields)
    assert fields & WRITE_FIELDS == set()
    # 모르는 칸(예: 결제 수단)을 끼워 넣으면 거부한다
    with pytest.raises(ValueError):
        spec.input_model.model_validate({**spec.example_input, "paymentMethod": "card"})


def _server_with_booking_tools(calls: list[str]) -> MCPServer:
    """말로 찾기 도구 3개 + 쓰기 도구 3개(예약·주문·결제)를 광고하는 가짜 도구 서버."""
    server = MCPServer("fake-planner-tools")

    def make(name: str) -> Any:
        def handler(**kwargs: Any) -> dict[str, Any]:
            calls.append(name)
            return {"data": [], "sources": []}

        return handler

    for name in PLANNER_TOOLS:
        server.add_tool(make(name), name=name, annotations=ToolAnnotations(read_only_hint=True))
    # 일부러 「읽기」 힌트까지 달아 둔다 — 힌트를 믿지 않고 이름 허용 목록으로 막는지 본다
    for name in ("book_offering", "create_order", "pay_order"):
        server.add_tool(make(name), name=name, annotations=ToolAnnotations(read_only_hint=True))
    return server


def test_toolbox_exposes_no_booking_tool_and_never_calls_one() -> None:
    calls: list[str] = []
    server = _server_with_booking_tools(calls)

    async def scenario() -> tuple[list[str], list[str]]:
        async with Client(server) as client:
            toolbox = ReadOnlyToolbox(client)
            listing = await toolbox.list_read_tools()
            for name in ("book_offering", "create_order", "pay_order"):
                with pytest.raises(ToolNotAllowedError):
                    await toolbox.call(name, {"offeringId": "x"})
            return sorted(tool.name for tool in listing.allowed), sorted(listing.rejected)

    allowed, rejected = anyio.run(scenario)
    assert allowed == sorted(PLANNER_TOOLS)
    assert [name for name in allowed if _is_write_name(name)] == []  # 에이전트 목록의 쓰기 도구 0개
    assert rejected == ["book_offering", "create_order", "pay_order"]
    assert calls == []  # 막힌 호출은 서버에 한 번도 닿지 않았다


def test_agent_source_posts_to_next_only_for_job_results() -> None:
    # 에이전트 소스에서 Next.js(`/api/…`)로 가는 POST·PUT·PATCH·DELETE 를 모두 찾는다.
    # 허용되는 것은 계약 16 「쓰기 0 규칙」 ③ 의 작업 결과 전달 하나뿐이다.
    pattern = re.compile(r"\.(post|put|patch|delete)\(\s*f?[\"'](/api/[^\"']*)[\"']")
    found = sorted(
        {match.group(2) for path in APP_DIR.rglob("*.py") for match in pattern.finditer(path.read_text(encoding="utf-8"))}
    )
    assert found == ["/api/internal/ai/jobs/{job_id}/result"]


def test_planner_package_makes_no_next_calls_and_builds_no_card_actions() -> None:
    # 플래너(조건 뽑기)는 모델만 부르고 Next.js 에 쓰지 않는다. 카드 버튼 값도 만들지 않는다 —
    # 버튼 값은 Next.js 가 id 로 만든다(admin-web lib/domain/offering-card-action.ts).
    for path in (APP_DIR / "planner").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "/api/" not in text, path.name
        assert "open_offering" not in text and '"action"' not in text, path.name
