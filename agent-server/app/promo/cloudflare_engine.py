"""Cloudflare Workers AI 의 FLUX.1 [schnell] 어댑터 (SX-6.4(영어 번역·이미지 생성 경로)).

- 지금 실제로 연결하는 유일한 엔진이다(spec FR-061a — 영구 무료 한도 안에서만 쓴다).
- 부르는 곳: `POST https://api.cloudflare.com/client/v4/accounts/{계정}/ai/run/@cf/black-forest-labs/flux-1-schnell`
  본문 `{"prompt": 영어 문장, "steps": 4}` → 답 `{"success": true, "result": {"image": base64 JPEG}}`.
- 무료 한도가 끝나면 Cloudflare 는 429 나 오류 코드 4006(「daily free allocation」)을 낸다.
  둘 다 `ImageQuotaExhaustedError` 로 바꿔 Next.js 가 「이번 달 무료량 소진」 안내로 돌릴 수 있게 한다.
- 키(계정 id·API 토큰)는 환경 변수에서만 받고, 로그·repr 에 찍히지 않게 숨긴다(SC-024).
"""

import base64
import binascii
from typing import Any

import httpx2

from app.jobs.poster_job import sniff_image_type
from app.promo.image_engine import MAX_IMAGE_BYTES, GeneratedImage, ImageEngineError, ImageQuotaExhaustedError

_API_BASE = "https://api.cloudflare.com/client/v4/accounts"
# Cloudflare 가 무료 한도 소진에 쓰는 오류 코드(「you have used up your daily free allocation」)
_QUOTA_ERROR_CODES = frozenset({4006})
# schnell 은 4단계가 기본이고 8단계까지 받는다 — 빠르게 1장 만드는 기본값을 쓴다
_DEFAULT_STEPS = 4


class CloudflareFluxSchnellEngine:
    engine_id = "cloudflare_flux_schnell"

    def __init__(
        self,
        *,
        account_id: str,
        api_token: str,
        model_name: str = "@cf/black-forest-labs/flux-1-schnell",
        steps: int = _DEFAULT_STEPS,
        timeout_seconds: float = 60.0,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self.model_name = model_name
        self._account_id = account_id
        self._api_token = api_token
        self._steps = steps
        self._timeout = timeout_seconds
        self._transport = transport

    def __repr__(self) -> str:
        # 토큰이 오류 메시지·로그에 새지 않게 이름만 보인다
        return f"CloudflareFluxSchnellEngine(model_name={self.model_name!r})"

    async def generate(self, *, prompt: str) -> GeneratedImage:
        if not self._account_id or not self._api_token:
            raise ImageEngineError("Cloudflare 키(CLOUDFLARE_ACCOUNT_ID·CLOUDFLARE_API_TOKEN)가 설정되지 않았다")
        url = f"{_API_BASE}/{self._account_id}/ai/run/{self.model_name}"
        try:
            async with httpx2.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
                response = await client.post(
                    url,
                    json={"prompt": prompt, "steps": self._steps},
                    headers={"Authorization": f"Bearer {self._api_token}"},
                )
        except httpx2.HTTPError as error:
            raise ImageEngineError(f"Cloudflare 연결 실패: {type(error).__name__}") from error
        body = _json_or_none(response)
        if response.status_code == 429 or _has_quota_code(body):
            raise ImageQuotaExhaustedError("Cloudflare 무료 한도 소진")
        if response.status_code != 200 or not isinstance(body, dict) or body.get("success") is not True:
            raise ImageEngineError(f"Cloudflare 응답 {response.status_code}")
        return _decode_image(body)


def _json_or_none(response: httpx2.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def _has_quota_code(body: Any) -> bool:
    """답의 errors 목록에 무료 한도 소진 코드가 있나."""
    if not isinstance(body, dict):
        return False
    errors = body.get("errors")
    if not isinstance(errors, list):
        return False
    return any(isinstance(e, dict) and e.get("code") in _QUOTA_ERROR_CODES for e in errors)


def _decode_image(body: dict[str, Any]) -> GeneratedImage:
    """base64 그림을 바이트로 풀고, 진짜 사진 형식인지 앞 바이트로 확인한다."""
    result = body.get("result")
    encoded = result.get("image") if isinstance(result, dict) else None
    if not isinstance(encoded, str) or not encoded:
        raise ImageEngineError("Cloudflare 답에 그림이 없다")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ImageEngineError("Cloudflare 그림이 base64 가 아니다") from error
    content_type = sniff_image_type(data)
    if content_type is None or len(data) > MAX_IMAGE_BYTES:
        raise ImageEngineError("Cloudflare 그림이 받을 수 있는 사진 형식·크기가 아니다")
    return GeneratedImage(content_type=content_type, data=data)
