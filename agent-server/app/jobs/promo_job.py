"""홍보 이미지 작업 한 건을 끝까지 처리한다 — 영어로 옮기기 → 그림 만들기 → 결과 알리기 (SX-6.4(영어 번역·이미지 생성 경로)).

흐름(계약 16 §7-1 · §7-2)
1. `translate_promo_prompt` 가 대화 모델로 `sentenceKo` 를 영어로 옮기고 조건·글자 없음을 붙인다.
2. 고른 엔진 어댑터(포트 `ImageEngine`)가 그 영어 문장으로 그림 1장을 만든다.
3. `POST /api/internal/ai/jobs/{jobId}/result` 로 그림 바이트(base64)·`englishPrompt`·엔진 이름을 보낸다.
   에이전트는 그림을 저장하지도, DB 에 쓰지도 않는다 — Next.js 가 받아서 `uploaded_files` 에 저장하고
   `promo_image_generations` 를 고친다(ADR-004 · FR-214(AI 쓰기 금지)).
- 실패도 결과로 알린다: 엔진 한도 소진 → `PROVIDER_QUOTA_EXHAUSTED`, 그 밖 → `PROVIDER_ERROR`.
  Next.js 는 실패를 받으면 같은 트랜잭션에서 하루 횟수를 돌려준다.
- 기한(`deadlineMs`)을 넘기면 결과를 보내지 않는다. Next.js `sweep` 이 `timed_out` 으로 닫고 횟수를 돌려준다.
"""

import asyncio
import base64
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx2

from app.jobs.poster_job import NextInternalClient, sniff_image_type
from app.planner.text_client import TextClient
from app.promo.image_engine import MAX_IMAGE_BYTES, ImageEngine, ImageEngineError, ImageQuotaExhaustedError
from app.promo.prompt_translator import PromoCondition, TranslationFailedError, translate_promo_prompt


@dataclass(frozen=True)
class PromoJob:
    job_id: str
    engine_id: str
    sentence_ko: str
    conditions: tuple[PromoCondition, ...]
    deadline_ms: int


async def run_promo_job(
    job: PromoJob,
    *,
    text: TextClient,
    engines: Mapping[str, ImageEngine],
    next_client: NextInternalClient,
) -> dict[str, Any] | None:
    """작업 한 건을 처리하고 Next.js 에 보낸 본문을 돌려준다. 기한을 넘기거나 못 보냈으면 None."""
    try:
        body = await asyncio.wait_for(_generate_body(job, text, engines), timeout=job.deadline_ms / 1000)
    except TimeoutError:
        return None
    try:
        await next_client.report_result(job.job_id, body)
    except httpx2.HTTPError:
        # Next.js 가 꺼져 있었다 — 다시 보내지 않는다(sweep 이 기한 뒤 닫고 횟수를 돌려준다)
        return None
    return body


async def _generate_body(job: PromoJob, text: TextClient, engines: Mapping[str, ImageEngine]) -> dict[str, Any]:
    """번역 + 그림 → 결과 전달 본문(§7-2). 실패도 본문으로 만든다. 모델 원문·사용자 문장은 싣지 않는다."""
    started = time.monotonic()
    engine = engines.get(job.engine_id)
    if engine is None:
        # 접수 단계에서 꺼진 엔진은 막지만, 켜졌는데 어댑터가 없는 설정 실수도 실패로 알린다
        return _failed("PROVIDER_ERROR", "고른 이미지 엔진을 쓸 수 없다")
    try:
        translated = await translate_promo_prompt(sentence_ko=job.sentence_ko, conditions=job.conditions, client=text)
        image = await engine.generate(prompt=translated.english_prompt)
    except ImageQuotaExhaustedError:
        return _failed("PROVIDER_QUOTA_EXHAUSTED", "이미지 엔진의 무료 한도가 끝났다")
    except TranslationFailedError:
        return _failed("PROVIDER_ERROR", "영어 번역에 실패했다")
    except ImageEngineError:
        return _failed("PROVIDER_ERROR", "이미지 엔진이 그림을 만들지 못했다")
    # 어댑터가 무엇을 돌려주든 진짜 사진인지 한 번 더 본다 — Next.js 가 그대로 저장하기 때문이다
    if sniff_image_type(image.data) != image.content_type or len(image.data) > MAX_IMAGE_BYTES:
        return _failed("PROVIDER_ERROR", "이미지 엔진이 사진이 아닌 것을 돌려줬다")
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return {
        "status": "succeeded",
        "result": {
            "englishPrompt": translated.english_prompt,
            "image": {"contentType": image.content_type, "base64": base64.b64encode(image.data).decode()},
            "engine": engine.engine_id,
            "model": engine.model_name,
            "elapsedMs": elapsed_ms,
        },
        "elapsedMs": elapsed_ms,
    }


def _failed(code: str, message: str) -> dict[str, Any]:
    return {"status": "failed", "error": {"code": code, "message": message}}
