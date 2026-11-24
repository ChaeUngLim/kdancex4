"""포스터 읽기 작업 한 건을 끝까지 처리한다 — 파일 받기 → 초안 뽑기 → 결과 알리기.

흐름(계약 16 §7-1 · §7-2)
1. Next.js 내부 경로 `fileUrl`(`/api/internal/ai/jobs/{jobId}/file`)에서 포스터 원본 바이트를 받는다.
   에이전트는 DB 도 파일 저장소도 직접 보지 않는다(ADR-004) — 파일은 Next.js 가 작업 동안만 내준다.
2. 사진 형식·크기를 확인하고(JPEG·PNG·WebP, 10MB 이하) `extract_poster_draft` 로 초안을 뽑는다.
3. 결과를 `POST /api/internal/ai/jobs/{jobId}/result` 로 알린다. 에이전트가 Next.js 에 하는
   쓰기성 호출은 이것 하나뿐이다(계약 16 §0 「쓰기 0 규칙」 ③) — DB 에 쓰는 것은 Next.js 다.
- 기한(`deadlineMs`)을 넘기면 결과를 보내지 않는다. Next.js `sweep` 이 `timed_out` 으로 닫는다.
"""

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx2

from app.poster.poster_extractor import ExtractionFailedError, extract_poster_draft
from app.poster.vision_client import VisionClient

# 받는 사진 형식과 크기(계약 16 §1-5 `POSTER_FILE_UNSUPPORTED` 추천값)
ALLOWED_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")
MAX_POSTER_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class PosterJob:
    job_id: str
    file_url: str
    field_keys: tuple[str, ...]
    deadline_ms: int


class PosterFileError(Exception):
    """포스터 파일을 받지 못했거나 사진이 아니다."""


def sniff_image_type(data: bytes) -> str | None:
    """앞 몇 바이트로 실제 사진 형식을 알아낸다. 헤더의 Content-Type 만 믿지 않는다."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class NextInternalClient:
    """Next.js 내부 경로(층 B2) 호출 — `X-Internal-Token` 을 붙인다."""

    def __init__(
        self,
        *,
        base_url: str,
        internal_token: str,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {"X-Internal-Token": internal_token}
        self._transport = transport

    def _client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            base_url=self._base_url, headers=self._headers, transport=self._transport, timeout=30.0
        )

    async def fetch_poster(self, file_url: str) -> tuple[bytes, str]:
        """포스터 바이트와 사진 형식을 돌려준다. 형식·크기 밖이면 PosterFileError."""
        async with self._client() as client:
            response = await client.get(file_url)
        if response.status_code != 200:
            raise PosterFileError(f"포스터 파일 응답 {response.status_code}")
        data = response.content
        if len(data) > MAX_POSTER_BYTES:
            raise PosterFileError("포스터 파일이 10MB 를 넘는다")
        image_type = sniff_image_type(data)
        if image_type not in ALLOWED_IMAGE_TYPES:
            raise PosterFileError("포스터 파일이 JPEG·PNG·WebP 사진이 아니다")
        return data, image_type

    async def report_result(self, job_id: str, body: dict[str, Any]) -> int:
        """작업 결과를 Next.js 에 알린다. 응답 코드만 돌려준다(늦은 결과면 Next.js 가 applied:false)."""
        async with self._client() as client:
            response = await client.post(f"/api/internal/ai/jobs/{job_id}/result", json=body)
        return response.status_code


async def run_poster_job(
    job: PosterJob,
    *,
    vision: VisionClient,
    next_client: NextInternalClient,
) -> dict[str, Any] | None:
    """작업 한 건을 처리하고 Next.js 에 보낸 본문을 돌려준다. 기한을 넘기면 아무것도 안 보내고 None."""
    try:
        body = await asyncio.wait_for(_extract_body(job, vision, next_client), timeout=job.deadline_ms / 1000)
    except TimeoutError:
        # 기한 초과 — 결과를 보내지 않는다(계약 16 §7-1). Next.js sweep 이 timed_out 으로 닫는다
        return None
    try:
        await next_client.report_result(job.job_id, body)
    except httpx2.HTTPError:
        # Next.js 가 꺼져 결과를 못 알렸다 — 작업은 Next.js sweep 이 기한 뒤 닫는다(다시 보내지 않는다)
        return None
    return body


async def _extract_body(job: PosterJob, vision: VisionClient, next_client: NextInternalClient) -> dict[str, Any]:
    """파일 받기 + 초안 뽑기 → 결과 전달 본문(§7-2). 실패도 본문으로 만들어 돌려준다."""
    try:
        image_bytes, image_type = await next_client.fetch_poster(job.file_url)
        draft = await extract_poster_draft(
            image_bytes=image_bytes,
            content_type=image_type,
            field_keys=job.field_keys,
            client=vision,
        )
    except (PosterFileError, ExtractionFailedError, httpx2.HTTPError) as error:
        # 앱은 실패를 보면 직접 입력 화면으로 보낸다(계약 16 §4-6). 모델 원문은 싣지 않는다
        return {
            "status": "failed",
            "error": {"code": "EXTRACTION_FAILED", "message": _safe_message(error)},
        }
    return {"status": "succeeded", "result": draft.to_result(), "elapsedMs": draft.elapsed_ms}


def _safe_message(error: Exception) -> str:
    if isinstance(error, httpx2.HTTPError):
        return "포스터 파일을 받지 못했다"
    return str(error)
