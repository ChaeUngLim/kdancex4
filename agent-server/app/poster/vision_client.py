"""비전 모델(kdance-llm 의 Qwen 비전)에 이미지 1장 + 지시문을 보내고 답 글자를 받는 연결.

- kdance-llm(llama-server, 포트 11436)은 OpenAI 와 같은 모양의 `/v1/chat/completions` 를 연다.
  이미지는 `data:` 주소(base64)로 실어 보낸다 — 파일을 모델 서버에 따로 올리지 않는다.
- 이 연결은 「보내고 받기」만 한다. 무엇을 물을지(프롬프트)와 답 거르기는 `poster_extractor` 가 맡는다.
  그래서 테스트에서는 이 연결만 가짜로 바꿔 끼우면 모델 없이도 추출 규칙을 확인할 수 있다.
"""

import base64
from typing import Any, Protocol

import httpx2


class VisionModelError(Exception):
    """모델 서버가 답하지 않았거나 답 모양이 예상과 다르다."""


class VisionClient(Protocol):
    """이미지 1장 질의의 공통 모양. 진짜(llama-server)와 테스트용 가짜가 같은 모양을 따른다."""

    model_name: str

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        image_bytes: bytes,
        content_type: str,
        json_schema: dict[str, Any],
    ) -> str:
        """모델의 답 글자(JSON 문자열이어야 한다)를 돌려준다."""
        ...


class OpenAICompatVisionClient:
    """llama-server 의 OpenAI 호환 경로로 비전 질의를 보낸다."""

    def __init__(
        self,
        *,
        base_url: str,
        model_name: str,
        timeout_seconds: float = 90.0,
        max_tokens: int = 1200,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self._url = base_url.rstrip("/") + "/chat/completions"
        self.model_name = model_name
        self._timeout = timeout_seconds
        self._max_tokens = max_tokens
        self._transport = transport

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        image_bytes: bytes,
        content_type: str,
        json_schema: dict[str, Any],
    ) -> str:
        data_url = f"data:{content_type};base64,{base64.b64encode(image_bytes).decode()}"
        body = {
            "model": self.model_name,
            # 같은 포스터면 같은 답이 나오게 무작위성을 끈다
            "temperature": 0,
            "max_tokens": self._max_tokens,
            # 스키마 밖의 글자를 못 내게 막는다(계약 16 §7-1 「response_format 은 json_schema」)
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "poster_draft", "schema": json_schema},
            },
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": user_prompt},
                    ],
                },
            ],
        }
        try:
            async with httpx2.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                response = await client.post(self._url, json=body)
        except httpx2.HTTPError as error:
            raise VisionModelError(f"모델 서버 연결 실패: {type(error).__name__}") from error
        if response.status_code != 200:
            raise VisionModelError(f"모델 서버 응답 {response.status_code}")
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise VisionModelError("모델 답 모양이 OpenAI 호환 형식이 아니다") from error
        if not isinstance(content, str):
            raise VisionModelError("모델 답 본문이 글자가 아니다")
        return content
