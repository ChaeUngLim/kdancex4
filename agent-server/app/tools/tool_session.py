"""도구 서버에 「누구의 질문인가」를 토큰으로만 싣는 연결 (SX-1.3(권한 밖 데이터 차단)).

처음 보는 사람용 요약
- 회원이 질문하면 Next.js 가 그 질문 한 건용 짧은 토큰(`agentSessionToken`, HMAC 서명·120초)을
  만들어 에이전트에게 준다(계약 16 §3-1 4번). 토큰 안에는 회원 id 가 들어 있지만, **에이전트는 그
  토큰을 열어 보지 않는다** — 그냥 들고 있다가 도구를 부를 때마다 `Authorization: Bearer` 로 그대로
  보낸다(계약 16 §6).
- 그러면 「누구의 데이터인가」는 Next.js 도구 서버가 서명을 확인해서만 정한다. 권한 판정 규칙도
  Next.js 의 것(S0-3(인증·역할·권한 경계): 세션이 없으면 401, 남의 자원이면 403 — 404 로 숨기지
  않는다)이 그대로 쓰인다. 에이전트 쪽에는 판정 코드가 따로 없다 — 규칙을 두 군데 두면 어긋난다.
- 도구 인자에는 신원 칸이 아예 없다(`read_catalog` 의 `extra="forbid"`). 모델이 `memberId` 를
  지어내도 서버로 나가기 전에 막힌다. 그래서 회원 A 의 질문이 B 의 데이터로 갈 길이 없다(FR-215).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from app.tools.read_only_toolbox import ReadOnlyToolbox


# Next.js 읽기 도구 서버의 경로(계약 16 §1-2). 에이전트가 Next.js 에 붙는 길은 이 읽기 문 하나다(SX-5.8)
MCP_PATH = "/api/internal/mcp"


def mcp_endpoint(next_internal_base_url: str) -> str:
    return next_internal_base_url.rstrip("/") + MCP_PATH


class ToolServerUnauthorizedError(Exception):
    """도구 서버가 401 을 줬다 — 토큰이 없거나, 위조됐거나, 시간이 지났다."""


@dataclass(frozen=True)
class AgentSessionToken:
    """Next.js 가 질문 한 건마다 준 신원 토큰. 에이전트는 내용을 해석하지 않는다.

    `repr` 에 값이 찍히지 않게 막아, 기록(log)이나 오류 메시지로 토큰이 새지 않게 한다.
    """

    value: str = field(repr=False)

    def __post_init__(self) -> None:
        # 빈 토큰으로 도구를 부르면 「누구인지 모르는」 호출이 된다 — 시작부터 막는다.
        if not self.value.strip():
            raise ValueError("agentSessionToken 이 비어 있다")


def tool_server_headers(session: AgentSessionToken, internal_token: str) -> dict[str, str]:
    """도구 서버 호출에 붙일 헤더 두 개(계약 16 §0 층 B2).

    - `X-Internal-Token`: 「에이전트 서버가 부른 것」을 증명(서버 대 서버).
    - `Authorization`: 「어느 회원의 질문인가」 — 받은 토큰을 한 글자도 바꾸지 않고 그대로 싣는다.
    """
    return {
        "X-Internal-Token": internal_token,
        "Authorization": f"Bearer {session.value}",
    }


async def _raise_on_unauthorized(response: httpx2.Response) -> None:
    """도구 서버의 401 을 알아볼 수 있는 오류로 바꾼다(그냥 두면 「서버 오류」로만 보인다)."""
    if response.status_code == 401:
        raise ToolServerUnauthorizedError("도구 서버가 신원 토큰을 받아 주지 않았다(401)")


def _single_leaf(group: BaseExceptionGroup[BaseException]) -> BaseException | None:
    """MCP 클라이언트가 안쪽 작업 묶음(task group)에서 감싼 오류가 하나뿐이면 그 하나를 꺼낸다."""
    leaves: list[BaseException] = []
    stack: list[BaseException] = [group]
    while stack:
        current = stack.pop()
        if isinstance(current, BaseExceptionGroup):
            stack.extend(current.exceptions)
        else:
            leaves.append(current)
    return leaves[0] if len(leaves) == 1 else None


@asynccontextmanager
async def open_read_toolbox(
    mcp_url: str,
    *,
    session: AgentSessionToken,
    internal_token: str,
    transport: httpx2.AsyncBaseTransport | None = None,
) -> AsyncIterator[ReadOnlyToolbox]:
    """질문 한 건 동안 쓸 읽기 도구 상자를 연다.

    이 상자로 나가는 모든 MCP 요청(`initialize`·`tools/list`·`tools/call`)에 같은 신원 헤더가
    붙는다. 질문이 끝나면 닫고, 다음 질문은 새 토큰으로 새로 연다 — 토큰을 질문 사이에 돌려
    쓰지 않는다(유효 120초).

    `transport` 는 테스트에서 진짜 네트워크 대신 메모리 안 서버로 보낼 때만 준다.
    """
    http_client = httpx2.AsyncClient(
        headers=tool_server_headers(session, internal_token),
        transport=transport,
        event_hooks={"response": [_raise_on_unauthorized]},
    )
    try:
        async with http_client:
            async with Client(streamable_http_client(mcp_url, http_client=http_client)) as client:
                yield ReadOnlyToolbox(client)
    except BaseExceptionGroup as group:
        # 오류가 하나뿐이면 감싼 묶음을 벗겨 그 오류로 다시 던진다 — 부르는 쪽이
        # `except ToolServerUnauthorizedError` · `except ForbiddenScopeError` 로 바로 잡게.
        leaf = _single_leaf(group)
        if leaf is None:
            raise
        raise leaf from None
