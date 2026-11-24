"""글자 대화 모델(kdance-llm 의 Qwen)에 지시문 + 질문을 보내고 JSON 답 글자를 받는 연결.

- kdance-llm(llama-server, 포트 11436)이 여는 OpenAI 호환 `/v1/chat/completions` 를 부른다.
  포스터 읽기의 `VisionClient` 와 같은 서버지만 이미지가 없어 메시지 모양이 다르다.
- 이 연결은 「보내고 받기」만 한다. 무엇을 물을지와 답 거르기는 `condition_extractor` 가 맡는다.
  그래서 테스트에서는 이 연결만 가짜로 바꿔 끼우면 모델 없이도 거르기 규칙을 확인할 수 있다.
"""

from typing import Any, Protocol

import httpx2


class TextModelError(Exception):
    """모델 서버가 답하지 않았거나 답 모양이 예상과 다르다."""


class TextClient(Protocol):
    """글자 질의의 공통 모양. 진짜(llama-server)와 테스트용 가짜가 같은 모양을 따른다."""

    model_name: str

    async def complete_json(self, *, system_prompt: str, user_prompt: str, json_schema: dict[str, Any]) -> str:
        """모델의 답 글자(JSON 문자열이어야 한다)를 돌려준다."""
        ...


class OpenAICompatTextClient:
    """llama-server 의 OpenAI 호환 경로로 글자 질의를 보낸다."""

    def __init__(
        self,
        *,
        base_url: str,
        model_name: str,
        timeout_seconds: float = 20.0,
        max_tokens: int = 300,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = base_url.rstrip("/") + "/chat/completions"
        self.model_name = model_name
        # 조건 뽑기는 짧아야 한다 — 전체 25초(SC-041) 안에 검색·답 작성까지 끝나야 해서 20초로 끊는다
        self._timeout = timeout_seconds
        self._max_tokens = max_tokens
        self._transport = transport

    async def complete_json(self, *, system_prompt: str, user_prompt: str, json_schema: dict[str, Any]) -> str:
        body = {
            "model": self.model_name,
            # 같은 질문이면 같은 조건이 나오게 무작위성을 끈다
            "temperature": 0,
            "max_tokens": self._max_tokens,
            # 스키마 밖의 글자를 못 내게 막는다
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "planner_conditions", "schema": json_schema},
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        try:
            async with httpx2.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                response = await client.post(self._url, json=body)
        except httpx2.HTTPError as error:
            raise TextModelError(f"모델 서버 연결 실패: {type(error).__name__}") from error
        if response.status_code != 200:
            raise TextModelError(f"모델 서버 응답 {response.status_code}")
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise TextModelError("모델 답 모양이 OpenAI 호환 형식이 아니다") from error
        if not isinstance(content, str):
            raise TextModelError("모델 답 본문이 글자가 아니다")
        return content
