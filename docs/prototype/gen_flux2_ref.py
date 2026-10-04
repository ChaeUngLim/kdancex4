#!/usr/bin/env python3
"""FLUX.2 [dev](Cloudflare Workers AI, 무료 하루 약 10장)에 **참고 원화를 직접 넣어** 비밥 캐릭터 카드를 만든다.
2026-10-03 사용자 요청: "첨부한 이미지의 캐릭터를 완벽 분석해 그대로 느낌과 원본을 살려서". FLUX.2 는 캐릭터 이름을 모르므로
`input_image_N`(512px 이하)으로 원화를 보여 주고 "이 그림의 인물 그대로" 라고 지시한다. 짝은 bebop_cast2 와 같다.

    uv run --with pillow --python 3.12 docs/prototype/gen_flux2_ref.py            # 4장
    uv run --with pillow --python 3.12 docs/prototype/gen_flux2_ref.py --only tango
참고 이미지는 ~/Downloads 원본을 512px 로 줄인 사본(--refs 폴더). 결과: assets/genres/compare/{run}/flux2-ref/{장르}.jpg
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.error
from pathlib import Path

import gen_genre_images as base

ROOT = Path(__file__).resolve().parent
STYLE = ("Keep the characters exactly as drawn in the reference images: same faces, hair, eyes and outfits. "
         "2000s anime film cel style like the original show, clean linework, muted amber and teal palette, "
         "detailed painted background, full body, no text")
CARDS: dict[str, tuple[list[str], str]] = {
    "dancesport": (["spike_julia"],
        "The man and the woman from the reference image dancing a rumba in a gilded ballroom under a chandelier, "
        "latin dance frame, holding hands, looking at each other. " + STYLE),
    "tango": (["vincent", "katerina"],
        "The man from image 0 (long messy dark grey hair, gaunt sharp face, stubble, dark military coat) and the woman "
        "from image 1 (wavy brown hair with a blue ribbon, red lips, green dangle earrings, magenta dress) dancing "
        "Argentine tango in a close embrace on a rainy cobblestone street at night under a street lamp. " + STYLE),
    "swing": (["spike_faye"],
        "The man and the woman from the reference image dancing lindy hop swing in a 1940s ballroom under golden "
        "spotlights with a big band behind, mid-air kick, big smiles. " + STYLE),
    "salsa_bachata": (["vicious_julia_spike", "julia_full"],
        "The silver-haired man in the dark coat from image 0 and the blonde woman from image 1 dancing bachata hip to "
        "hip by the sea at night under string lights and palm trees. " + STYLE),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=CARDS, action="append")
    ap.add_argument("--refs", type=Path, default=Path("/tmp/claude-1000/-home-user-kdance/063de942-7297-4439-a677-ceb2c854f812/scratchpad/refs"))
    ap.add_argument("--run", default="2026-10-03-flux2-ref")
    ap.add_argument("--seed", type=int, default=901)
    ap.add_argument("--steps", type=int, default=24)
    args = ap.parse_args()
    env = base.read_env("cloudflare.env")
    account, token = env.get("CLOUDFLARE_ACCOUNT_ID"), env.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        raise SystemExit("cloudflare.env 가 필요하다")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-dev"
    out_dir = ROOT / "assets" / "genres" / "compare" / args.run / "flux2-ref"; out_dir.mkdir(parents=True, exist_ok=True)
    failed = 0
    for genre in (args.only or list(CARDS)):
        refs, prompt = CARDS[genre]
        files = {f"input_image_{i}": args.refs / f"{r}.jpg" for i, r in enumerate(refs)}
        fields = {"prompt": prompt, "steps": str(args.steps), "width": "1024", "height": "1024", "seed": str(args.seed)}
        t0 = time.time()
        try:
            data = base.post_multipart(url, fields, files, {"Authorization": f"Bearer {token}"})
        except urllib.error.HTTPError as e:
            body = e.read()[:200]
            print(f"{genre}: HTTP {e.code} {body!r}", file=sys.stderr); failed += 1
            if e.code == 429:
                print("Cloudflare 무료 한도 소진 — 초기화 뒤 다시 돌린다.", file=sys.stderr); break
            continue
        import base64
        raw = base64.b64decode((data.get("result") or data)["image"])
        if len(raw) < base.MIN_BYTES:
            print(f"{genre}: {len(raw)} bytes — 검은 화면"); failed += 1; continue
        (out_dir / f"{genre}.jpg").write_bytes(raw)
        print(f"{genre}: OK {len(raw):,} bytes · {time.time() - t0:.0f}s · refs={refs}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
