"""이미지 엔진 포트 — 「영어 문장을 주면 그림 1장을 돌려준다」는 약속 하나 (SX-6.4(영어 번역·이미지 생성 경로)).

포트와 어댑터가 무엇인가
- 포트(port)는 「무엇을 할 수 있나」만 적은 모양이다. 여기서는 `generate(prompt) → 그림` 하나다.
- 어댑터(adapter)는 그 모양을 실제로 채우는 쪽이다. 지금은 Cloudflare Workers AI(`cloudflare_engine.py`)
  하나이고, 로컬 GPU 엔진이 실측을 통과하면 어댑터 파일만 더한다. 작업 흐름(`promo_job.py`)은
  어느 엔진인지 모르고 이 포트만 부른다 — 테스트는 가짜 어댑터를 끼워 진짜 엔진 없이 돌린다.
- 엔진은 그림을 **돌려주기만** 한다. 저장은 Next.js 가 결과를 받아 `uploaded_files` 에 한다(ADR-004).
"""

from dataclasses import dataclass, field
from typing import Protocol

# 엔진이 돌려준 그림이 받을 수 있는 형식·크기인지 확인할 때 쓰는 상한(포스터와 같은 10MB)
MAX_IMAGE_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class GeneratedImage:
    """엔진이 만든 그림 1장."""

    content_type: str
    data: bytes = field(repr=False)


class ImageEngineError(Exception):
    """엔진이 답하지 않았거나 답 모양이 틀렸다(→ 결과 `PROVIDER_ERROR`)."""


class ImageQuotaExhaustedError(ImageEngineError):
    """엔진 쪽 무료 한도가 끝났다(→ 결과 `PROVIDER_QUOTA_EXHAUSTED`, 계약 16 §7-1)."""


class ImageEngine(Protocol):
    """이미지 엔진 어댑터가 따를 모양."""

    # 엔진 목록 설정(`image_engines.json`)의 id — 결과에 「어느 엔진으로 만들었나」로 실린다
    engine_id: str
    # 엔진 안의 실제 모델 이름(검수·라이선스 확인용 기록)
    model_name: str

    async def generate(self, *, prompt: str) -> GeneratedImage:
        """영어 프롬프트로 그림 1장을 만든다. 한도 소진이면 ImageQuotaExhaustedError."""
        ...
