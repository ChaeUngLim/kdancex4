"""홍보 이미지 경로를 진짜 엔진으로 한 번 돌려 보는 확인용 스크립트 (SX-6.4(영어 번역·이미지 생성 경로)).

- 번역은 진짜 kdance-llm(LLM_BASE_URL, 기본 11436), 그림은 진짜 Cloudflare Workers AI FLUX.1 [schnell](무료 한도 안).
- 키는 `--env-file`(예: ../admin-web/.env)에서 CLOUDFLARE_ACCOUNT_ID·CLOUDFLARE_API_TOKEN 두 줄만 읽고, 화면에 찍지 않는다.
- 운영 경로가 아니다. 테스트(pytest)는 가짜 어댑터로 돌고, 이 스크립트는 사람이 손으로 한 번 확인할 때만 쓴다.
- 쓰는 법: `cd agent-server && uv run python scripts/promo_image_smoke.py --env-file ../admin-web/.env --out /경로/그림.jpg`
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.planner.text_client import OpenAICompatTextClient  # noqa: E402
from app.promo.cloudflare_engine import CloudflareFluxSchnellEngine  # noqa: E402
from app.promo.prompt_translator import PromoCondition, translate_promo_prompt  # noqa: E402
from app.settings import load_settings  # noqa: E402

# spec FR-061a 예시 문장과 admin-web promo-image-conditions.json 의 살사 조건
SENTENCE_KO = "커플이 스튜디오에서 빨간 조명 아래 열정적으로 살사를 추는 모습"
CONDITIONS = (
    PromoCondition("genre_pose", "a man and a woman facing each other in a social partner dance hold, salsa or bachata"),
    PromoCondition(
        "full_body",
        "full body shot with the dancers visible from head to toe, not ballet, not hip-hop, not any other dance style",
    ),
)
_KEYS = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")


def _read_keys(env_file: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        if name.strip() in _KEYS:
            found[name.strip()] = value.strip().strip('"').strip("'")
    return found


async def _main(env_file: Path, out: Path) -> int:
    keys = _read_keys(env_file)
    settings = load_settings()
    text = OpenAICompatTextClient(base_url=settings.llm_base_url, model_name=settings.llm_chat_model, timeout_seconds=60)
    engine = CloudflareFluxSchnellEngine(
        account_id=keys.get("CLOUDFLARE_ACCOUNT_ID", ""), api_token=keys.get("CLOUDFLARE_API_TOKEN", "")
    )
    translated = await translate_promo_prompt(sentence_ko=SENTENCE_KO, conditions=CONDITIONS, client=text)
    print(f"sentenceKo: {SENTENCE_KO}")
    print(f"englishSentence: {translated.english_sentence}")
    print(f"englishPrompt: {translated.english_prompt}")
    image = await engine.generate(prompt=translated.english_prompt)
    out.write_bytes(image.data)
    print(f"engine: {engine.engine_id} model: {engine.model_name}")
    print(f"image: {image.content_type} {len(image.data)} bytes -> {out}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    sys.exit(asyncio.run(_main(args.env_file, args.out)))
