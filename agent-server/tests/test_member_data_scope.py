"""회원 A 세션으로 B 데이터를 요청하면 거부된다 (SX-1.3(권한 밖 데이터 차단), FR-215).

무엇을 지키는 테스트인가
- 에이전트는 「누구의 질문인가」를 도구 인자로 보내지 않는다. Next.js 가 준 `agentSessionToken` 을
  `Authorization: Bearer` 로 그대로 실어 보낼 뿐이다(계약 16 §6).
- 도구 서버는 그 토큰의 서명·유효시간을 확인해 얻은 신원으로만 「내 데이터」를 고른다. 회원 A 의
  토큰으로 B 의 예약 id 를 주면 `FORBIDDEN_SCOPE` 를 내고 데이터는 한 글자도 담지 않는다.
- 판정 규칙은 Next.js 쪽 S0-3(인증·역할·권한 경계)의 것이다: 세션(토큰)이 없거나 틀리면 401,
  남의 자원이면 거절(README §4 — 404 로 숨기지 않는다).

진짜 Next.js 도구 서버(`POST /api/internal/mcp`)는 다른 Task 몫이라, 같은 규칙으로 판정하는 가짜
서버를 MCP Streamable HTTP 로 띄운다. 네트워크 대신 `httpx2.ASGITransport` 로 메모리 안에서
주고받지만, 요청은 진짜 HTTP 요청(헤더 포함)이다. 에이전트 쪽은 운영 코드
`open_read_toolbox` 를 그대로 쓴다.
"""

import base64
import hashlib
import hmac
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, MutableMapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx2
import pytest
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import ValidationError

from app.tools.read_only_toolbox import ForbiddenScopeError
from app.tools.tool_session import (
    AgentSessionToken,
    ToolServerUnauthorizedError,
    open_read_toolbox,
    tool_server_headers,
)

MCP_URL = "http://127.0.0.1:3000/api/internal/mcp"
SESSION_SECRET = b"test-agent-session-secret"  # 테스트 전용 값(운영 값은 AGENT_SESSION_SECRET)
INTERNAL_TOKEN = "test-internal-token"

MEMBER_A = "11111111-1111-4111-8111-111111111111"
MEMBER_B = "22222222-2222-4222-8222-222222222222"
RES_A = "aaaaaaaa-0000-4000-8000-00000000000a"
RES_B = "bbbbbbbb-0000-4000-8000-00000000000b"

# 가짜 DB. B 의 예약에만 있는 값(제목·환불액)이 A 의 결과·오류에 새는지 본다.
RESERVATIONS: dict[str, dict[str, Any]] = {
    RES_A: {"memberId": MEMBER_A, "title": "살사 입문 A반", "refundAmount": 45000},
    RES_B: {"memberId": MEMBER_B, "title": "비밀 바차타 B반", "refundAmount": 98765},
}
B_ONLY_STRINGS = (RES_B, "비밀 바차타 B반", "98765", MEMBER_B)


# ---------------------------------------------------------------------------
# Next.js 쪽 흉내: 토큰 서명(계약 16 §3-1 4번)과 도구 서버(§6)
# ---------------------------------------------------------------------------


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign_member_token(member_id: str, *, run_id: str = "run-1", ttl_seconds: int = 120) -> str:
    """Next.js 가 질문 한 건마다 만드는 토큰 흉내: 클레임 kind·sub·runId·exp + HMAC-SHA256."""
    claims = {"kind": "member", "sub": member_id, "runId": run_id, "exp": int(time.time()) + ttl_seconds}
    body = _b64(json.dumps(claims, separators=(",", ":")).encode())
    sig = _b64(hmac.new(SESSION_SECRET, body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def verify_member_token(authorization: str | None) -> dict[str, Any] | None:
    """서명·유효시간을 확인해 신원을 돌려준다. 하나라도 틀리면 None(→ 401)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.removeprefix("Bearer ")
    body, _, sig = token.partition(".")
    expected = _b64(hmac.new(SESSION_SECRET, body.encode(), hashlib.sha256).digest())
    if not sig or not hmac.compare_digest(sig, expected):  # 상수 시간 비교
        return None
    padded = body + "=" * (-len(body) % 4)
    claims: dict[str, Any] = json.loads(base64.urlsafe_b64decode(padded))
    if claims.get("kind") != "member" or int(claims.get("exp", 0)) < time.time():
        return None
    return claims


def _ok(data: Any) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"data": data, "sources": []}))])


def _error(code: str) -> CallToolResult:
    # 계약 16 §6: 오류는 isError + {code} 만. 데이터는 담지 않는다.
    return CallToolResult(content=[TextContent(type="text", text=json.dumps({"code": code}))], is_error=True)


@dataclass
class FakeNextToolServer:
    """S0-3 규칙으로 판정하는 가짜 `POST /api/internal/mcp`."""

    tool_calls: list[tuple[str, str]] = field(default_factory=list)  # (도구 이름, 토큰이 말한 회원)
    http_statuses: list[int] = field(default_factory=list)

    def build_asgi(self) -> tuple[Any, Callable[..., Awaitable[None]]]:
        server = MCPServer("fake-next-tools")

        def caller(ctx: Context) -> str:
            # 도구 안에서도 신원은 헤더의 토큰에서만 얻는다(입구에서 이미 확인한 같은 토큰).
            claims = verify_member_token((ctx.headers or {}).get("authorization"))
            assert claims is not None  # 입구 검사를 통과한 요청만 여기 온다
            return str(claims["sub"])

        @server.tool(name="get_my_reservations", annotations=ToolAnnotations(read_only_hint=True))
        def get_my_reservations(ctx: Context, scope: str = "all", limit: int = 20) -> CallToolResult:
            member = caller(ctx)
            self.tool_calls.append(("get_my_reservations", member))
            mine = [
                {"reservationId": rid, "title": row["title"]}
                for rid, row in RESERVATIONS.items()
                if row["memberId"] == member
            ]
            return _ok(mine[:limit])

        @server.tool(name="get_refund_preview", annotations=ToolAnnotations(read_only_hint=True))
        def get_refund_preview(ctx: Context, reservationId: str) -> CallToolResult:
            member = caller(ctx)
            self.tool_calls.append(("get_refund_preview", member))
            row = RESERVATIONS.get(reservationId)
            if row is None:
                return _error("NOT_FOUND")
            if row["memberId"] != member:
                # 남의 자원: S0-3 규칙대로 숨기지 않고 거절한다. 본문에는 코드만.
                return _error("FORBIDDEN_SCOPE")
            return _ok({"refundAmount": row["refundAmount"], "refundRateBp": 10000})

        app = server.streamable_http_app(
            streamable_http_path="/api/internal/mcp",
            transport_security=TransportSecuritySettings(allowed_hosts=["127.0.0.1:*"]),
        )

        async def guarded(
            scope: MutableMapping[str, Any],
            receive: Callable[[], Awaitable[Any]],
            send: Callable[[MutableMapping[str, Any]], Awaitable[None]],
        ) -> None:
            """입구 검사: 내부 토큰 + 신원 토큰. 하나라도 틀리면 도구까지 가지 않고 401."""
            if scope["type"] == "http":
                headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
                internal_ok = hmac.compare_digest(headers.get("x-internal-token", ""), INTERNAL_TOKEN)
                if not internal_ok or verify_member_token(headers.get("authorization")) is None:
                    self.http_statuses.append(401)
                    await send(
                        {
                            "type": "http.response.start",
                            "status": 401,
                            "headers": [(b"content-type", b"application/json")],
                        }
                    )
                    await send({"type": "http.response.body", "body": b'{"code":"UNAUTHENTICATED"}'})
                    return
            await app(scope, receive, send)

        return app, guarded


@asynccontextmanager
async def running(fake: FakeNextToolServer) -> AsyncIterator[httpx2.ASGITransport]:
    app, guarded = fake.build_asgi()
    async with app.router.lifespan_context(app):  # MCP 세션 관리자를 띄운다
        yield httpx2.ASGITransport(app=guarded)


def _text(result: CallToolResult) -> str:
    return "".join(block.text for block in result.content if isinstance(block, TextContent))


# ---------------------------------------------------------------------------
# 1) 회원 A 의 세션으로는 A 의 데이터만 보인다
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_member_a_lists_only_own_reservations() -> None:
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(sign_member_token(MEMBER_A))
        async with open_read_toolbox(
            MCP_URL, session=session, internal_token=INTERNAL_TOKEN, transport=transport
        ) as toolbox:
            result = await toolbox.call("get_my_reservations", {"scope": "all", "limit": 20})

    body = _text(result)
    assert result.is_error is False
    assert RES_A in body
    for leaked in B_ONLY_STRINGS:
        assert leaked not in body
    # 서버가 본 신원은 토큰의 A 하나뿐이다.
    assert fake.tool_calls == [("get_my_reservations", MEMBER_A)]


# ---------------------------------------------------------------------------
# 2) A 의 세션으로 B 의 예약을 물으면 거부된다 — 데이터 0
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_member_a_asking_for_member_b_reservation_is_refused() -> None:
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(sign_member_token(MEMBER_A))
        with pytest.raises(ForbiddenScopeError) as refused:
            async with open_read_toolbox(
                MCP_URL, session=session, internal_token=INTERNAL_TOKEN, transport=transport
            ) as toolbox:
                await toolbox.call("get_refund_preview", {"reservationId": RES_B})

    # 거절 오류에는 도구 이름만 있다. B 의 id·제목·금액·회원 id 는 한 글자도 없다.
    message = str(refused.value)
    assert refused.value.tool_name == "get_refund_preview"
    for leaked in B_ONLY_STRINGS:
        assert leaked not in message
    assert fake.tool_calls == [("get_refund_preview", MEMBER_A)]


@pytest.mark.anyio
async def test_same_tool_answers_for_own_reservation() -> None:
    # 거절이 「도구가 고장」이 아니라 「신원이 달라서」임을 보이는 짝: A 자기 예약은 답이 온다.
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(sign_member_token(MEMBER_A))
        async with open_read_toolbox(
            MCP_URL, session=session, internal_token=INTERNAL_TOKEN, transport=transport
        ) as toolbox:
            result = await toolbox.call("get_refund_preview", {"reservationId": RES_A})

    assert result.is_error is False
    assert json.loads(_text(result))["data"]["refundAmount"] == 45000


@pytest.mark.anyio
async def test_member_b_session_sees_b_data_but_a_session_never_does() -> None:
    # 같은 질문이라도 결과를 정하는 것은 토큰의 신원이다.
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session_b = AgentSessionToken(sign_member_token(MEMBER_B))
        async with open_read_toolbox(
            MCP_URL, session=session_b, internal_token=INTERNAL_TOKEN, transport=transport
        ) as toolbox:
            result = await toolbox.call("get_refund_preview", {"reservationId": RES_B})

    assert json.loads(_text(result))["data"]["refundAmount"] == 98765
    assert fake.tool_calls == [("get_refund_preview", MEMBER_B)]


# ---------------------------------------------------------------------------
# 3) 신원을 인자로 바꿔 끼울 길이 없다
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_member_id_in_arguments_is_rejected_before_reaching_server() -> None:
    # 모델이 「B 의 것으로 보여 줘」라며 memberId 를 지어내도 서버로 나가지 않는다.
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(sign_member_token(MEMBER_A))
        async with open_read_toolbox(
            MCP_URL, session=session, internal_token=INTERNAL_TOKEN, transport=transport
        ) as toolbox:
            with pytest.raises(ValidationError):
                await toolbox.call("get_my_reservations", {"scope": "all", "limit": 5, "memberId": MEMBER_B})

    assert fake.tool_calls == []


def test_token_is_sent_verbatim_and_never_shown_in_repr() -> None:
    # 에이전트는 토큰을 열거나 고치지 않고 그대로 싣는다. repr·기록에는 값이 안 찍힌다.
    raw = sign_member_token(MEMBER_A)
    session = AgentSessionToken(raw)
    headers = tool_server_headers(session, INTERNAL_TOKEN)
    assert headers["Authorization"] == f"Bearer {raw}"
    assert headers["X-Internal-Token"] == INTERNAL_TOKEN
    assert raw not in repr(session)
    with pytest.raises(ValueError):
        AgentSessionToken("  ")


# ---------------------------------------------------------------------------
# 4) 토큰이 틀리면 도구까지 가지 않는다 — S0-3 의 401
# ---------------------------------------------------------------------------


def _forged_token_claiming_member_b() -> str:
    # A 의 서명을 그대로 두고 신원만 B 로 바꿔 끼운 토큰.
    signed_a = sign_member_token(MEMBER_A)
    _, _, sig_a = signed_a.partition(".")
    claims = {"kind": "member", "sub": MEMBER_B, "runId": "run-1", "exp": int(time.time()) + 120}
    return f"{_b64(json.dumps(claims, separators=(',', ':')).encode())}.{sig_a}"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("label", "token_factory"),
    [
        ("forged_sub", _forged_token_claiming_member_b),
        ("expired", lambda: sign_member_token(MEMBER_A, ttl_seconds=-1)),
        ("garbage", lambda: "not-a-token"),
    ],
)
async def test_bad_token_is_unauthorized_and_reaches_no_tool(label: str, token_factory: Callable[[], str]) -> None:
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(token_factory())
        with pytest.raises(ToolServerUnauthorizedError):
            async with open_read_toolbox(
                MCP_URL, session=session, internal_token=INTERNAL_TOKEN, transport=transport
            ) as toolbox:
                await toolbox.call("get_refund_preview", {"reservationId": RES_B})

    assert fake.http_statuses and set(fake.http_statuses) == {401}, label
    assert fake.tool_calls == []


@pytest.mark.anyio
async def test_wrong_internal_token_is_unauthorized() -> None:
    fake = FakeNextToolServer()
    async with running(fake) as transport:
        session = AgentSessionToken(sign_member_token(MEMBER_A))
        with pytest.raises(ToolServerUnauthorizedError):
            async with open_read_toolbox(
                MCP_URL, session=session, internal_token="wrong", transport=transport
            ) as toolbox:
                await toolbox.call("get_my_reservations", {"scope": "all", "limit": 5})

    assert fake.tool_calls == []
