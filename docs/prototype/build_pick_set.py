#!/usr/bin/env python3
"""여러 비교 실행(assets/genres/compare/{run}/{model}/)에서 장르별로 하나씩 골라 한 세트로 모은다.

    python3 docs/prototype/build_pick_set.py --out picks-2026-10-03 \\
        dancesport=2026-10-03-scene-lora-v2/local-animagine-bebop-lora \\
        tango=2026-10-03-scene-nolora/local-illustrious \\
        swing=2026-10-03-scene-lora-v2/local-illustrious-bebop-lora \\
        salsa_bachata=2026-10-03-scene-nolora/local-illustrious
→ assets/genres/{out}/{장르}.jpg 로 복사(라벨이 구워진 비교본이면 --regen 안내를 출력) + genre-cards-{out}.html 뷰어.
현재 카드로 채택하려면 --promote 를 붙인다(assets/genres/*.jpg 덮어씀, 옛 것은 assets/genres/_prev/ 에 보관).
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GEN = ROOT / "assets" / "genres"
KO = {"dancesport": "댄스스포츠 · 룸바", "samba": "댄스스포츠 · 쌈바", "tango": "아르헨티나 탱고", "swing": "스윙", "salsa_bachata": "살사 · 바차타"}
CAST = {"dancesport": "스파이크 + 줄리아", "samba": "스파이크 + 줄리아", "tango": "스파이크 + 줄리아", "swing": "스파이크 + 페이", "salsa_bachata": "스파이크 + 페이"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("picks", nargs="+", help="장르=실행ID/모델")
    ap.add_argument("--out", required=True, help="assets/genres/ 아래 세트 폴더 이름")
    ap.add_argument("--promote", action="store_true", help="현재 카드(assets/genres/*.jpg)로 복사")
    args = ap.parse_args()
    out = GEN / args.out; out.mkdir(parents=True, exist_ok=True)
    rows = []
    for item in args.picks:
        genre, src = item.split("=", 1)
        run, model = src.split("/", 1)
        p = GEN / "compare" / run / model / f"{genre}.jpg"
        if not p.exists():
            raise SystemExit(f"없음: {p}")
        shutil.copy2(p, out / f"{genre}.jpg")
        rows.append((genre, run, model))
        print(f"{genre:<14} ← {run}/{model}")
    if args.promote:
        prev = GEN / "_prev"; prev.mkdir(exist_ok=True)
        for genre, _, _ in rows:
            cur = GEN / f"{genre}.jpg"
            if cur.exists():
                shutil.copy2(cur, prev / f"{genre}.jpg")
            shutil.copy2(out / f"{genre}.jpg", cur)
        print("현재 카드로 채택했다(옛 카드는 assets/genres/_prev/).")
    figs = "".join(
        f'<figure><a href="assets/genres/{args.out}/{g}.jpg" target="_blank"><img src="assets/genres/{args.out}/{g}.jpg" alt="{KO[g]}"></a>'
        f'<figcaption>{KO[g]}<small>{CAST[g]} · {m} · {r}</small></figcaption></figure>' for g, r, m in rows)
    html = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>장르 카드 · {args.out}</title><style>
body{{margin:0;padding:24px 16px;background:#0f1115;color:#e8e8ea;font:15px/1.5 system-ui,sans-serif;max-width:1400px;margin-inline:auto}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#9a9aa3;margin:0 0 20px}}
.grid{{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}} @media(max-width:700px){{.grid{{grid-template-columns:1fr}}}}
figure{{margin:0}} img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:14px;display:block;background:#222}}
figcaption{{margin-top:8px;font-size:16px}} figcaption small{{color:#9a9aa3;margin-left:8px;font-size:12px}}
</style></head><body><h1>장르 세션 카드 · {args.out}</h1>
<p class="sub">장르별로 가장 나은 모델 결과를 골라 모은 세트. 「천국의 문」 등장인물 · 로컬 생성(무료). 비교본은 왼쪽 위 모델 라벨이 남아 있을 수 있다.</p>
<div class="grid">{figs}</div></body></html>"""
    page = ROOT / f"genre-cards-{args.out}.html"; page.write_text(html, encoding="utf-8")
    print(f"→ {page}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
