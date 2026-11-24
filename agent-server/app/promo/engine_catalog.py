"""이미지 엔진 목록 설정 — 어떤 엔진이 있고 그중 무엇이 켜져 있나 (SX-6.4(영어 번역·이미지 생성 경로)).

처음 보는 사람용 요약
- spec FR-061a 「생성 엔진은 사용자가 고른다」: 영구 무료 엔진 4개(Cloudflare FLUX.1 [schnell] +
  로컬 GPU 3개)를 카드로 보이고 사용자가 하나를 고른다.
- 목록은 코드에 박지 않고 `image_engines.json` 에 둔다. 지금 켠 것은 Cloudflare 하나다.
  로컬 3개(Sana Sprint · FLUX.2 [klein] · Z-Image Turbo)는 8GB GPU 에서 실제로 돌려 보기 전이라
  `enabled: false` 로 두고, 켜진 엔진만 요청을 받는다(꺼진 엔진 id 가 오면 접수 단계에서 422).
- 유료 API(Gemini Nano Banana 등)는 목록에 아예 넣지 않는다.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

_CATALOG_FILE = Path(__file__).with_name("image_engines.json")
# 요청에 엔진 id 가 없을 때 쓰는 엔진(지금 실제로 연결된 유일한 엔진)
DEFAULT_ENGINE_ID = "cloudflare_flux_schnell"


class EngineSpec(BaseModel):
    """엔진 한 줄 — 카드에 보일 이름·속도 한 마디와, 어디서 도는지·켜졌는지."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(pattern=r"^[a-z0-9_]{3,40}$")
    label: str = Field(min_length=1, max_length=40)
    speed: Literal["빠름", "보통", "화질 우선"]
    runtime: Literal["cloudflare_workers_ai", "local_gpu"]
    model: str = Field(min_length=1, max_length=100)
    enabled: bool


class _Catalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    engines: list[EngineSpec] = Field(min_length=1)

    @field_validator("engines")
    @classmethod
    def _unique_ids(cls, value: list[EngineSpec]) -> list[EngineSpec]:
        ids = [engine.id for engine in value]
        if len(ids) != len(set(ids)):
            raise ValueError("엔진 id 가 겹친다")
        return value


@lru_cache(maxsize=1)
def load_engine_catalog() -> tuple[EngineSpec, ...]:
    """설정 파일을 읽고 모양을 검사한다. 모양이 틀리면 서버가 뜰 때 바로 실패한다."""
    raw = json.loads(_CATALOG_FILE.read_text(encoding="utf-8"))
    return tuple(_Catalog.model_validate(raw).engines)


def enabled_engine_ids() -> tuple[str, ...]:
    """지금 요청을 받을 수 있는 엔진 id(설정 순서)."""
    return tuple(engine.id for engine in load_engine_catalog() if engine.enabled)
