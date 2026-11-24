"""모델이 낸 도구 호출을 읽기 도구 상자로 보내는 유일한 길 (SX-1.4(프롬프트 주입 테스트), FR-270(입력 지시문은 데이터)).

처음 보는 사람용 요약
- 모델(LLM)은 회원 질문이나 도구 결과 안의 「이전 지시를 무시하고 …」 같은 문장에 넘어갈 수 있다.
  그래서 모델이 낸 도구 호출(`AIMessage.tool_calls`)을 믿지 않고, 이 함수 하나를 꼭 지나가게 한다.
- 여기서 하는 일은 셋뿐이다.
  1) 허용 목록 밖 이름(쓰기 도구·꾸민 이름)은 서버로 보내지 않는다(`ReadOnlyToolbox`, SX-1.2(MCP 읽기 도구)).
  2) 계약 모양과 다른 인자(모르는 칸·범위 밖 값·`memberId` 같은 신원 칸)도 보내지 않는다(`extra="forbid"`).
  3) 결과는 `tool` 역할 메시지(데이터)로만 돌려준다. 결과 안 글을 읽고 새 호출을 만들지 않는다.
- 신원은 인자가 아니라 연결 헤더의 토큰으로만 간다(SX-1.3(권한 밖 데이터 차단)). 모델은 헤더를 만질 수 없다.
- 막힌 호출은 정해진 짧은 오류 코드만 모델에게 돌려준다. 주입이 넣은 값(남의 id·토큰 등)을
  오류 글에 되울리지 않는다 — 되울리면 그 값이 다시 모델 문맥으로 들어가기 때문이다.
"""

import json
from collections.abc import Sequence

from langchain_core.messages import ToolCall, ToolMessage
from mcp.types import CallToolResult, TextContent
from pydantic import ValidationError

from app.tools.read_only_toolbox import ForbiddenScopeError, ReadOnlyToolbox, ToolNotAllowedError


def _error_message(call: ToolCall, code: str) -> ToolMessage:
    """막힌 호출의 결과. 본문은 `{"code": …}` 하나 — 인자·서버 응답은 담지 않는다."""
    return ToolMessage(
        content=json.dumps({"code": code}),
        tool_call_id=call["id"] or "",
        name=call["name"],
        status="error",
    )


def _result_text(result: CallToolResult) -> str:
    """MCP 결과의 글 조각을 이어 붙인다. 내용은 해석하지 않는다(데이터로만 넘긴다)."""
    return "".join(block.text for block in result.content if isinstance(block, TextContent))


async def run_tool_calls(toolbox: ReadOnlyToolbox, tool_calls: Sequence[ToolCall]) -> list[ToolMessage]:
    """모델이 낸 도구 호출을 차례로 부르고, 호출마다 결과 메시지 하나를 돌려준다.

    한 호출이 막혀도 나머지는 계속 부른다 — 정상 호출까지 같이 버리면 주입 문장 하나로
    답을 망칠 수 있어서다. 다만 막힌 호출은 서버로 한 바이트도 나가지 않는다.
    토큰이 틀린 경우(`ToolServerUnauthorizedError`)는 질문 전체가 무효라 잡지 않고 위로 올린다.
    """
    messages: list[ToolMessage] = []
    for call in tool_calls:
        try:
            result = await toolbox.call(call["name"], call["args"])
        except ToolNotAllowedError:
            messages.append(_error_message(call, "TOOL_NOT_ALLOWED"))
            continue
        except ValidationError:
            # pydantic 오류 글에는 입력값이 그대로 들어 있으니 코드만 돌려준다.
            messages.append(_error_message(call, "INVALID_INPUT"))
            continue
        except ForbiddenScopeError:
            messages.append(_error_message(call, "FORBIDDEN_SCOPE"))
            continue
        messages.append(
            ToolMessage(
                content=_result_text(result),
                tool_call_id=call["id"] or "",
                name=call["name"],
                status="error" if result.is_error else "success",
            )
        )
    return messages
