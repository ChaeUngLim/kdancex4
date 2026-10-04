#!/usr/bin/env python3
"""gen_genre_multi.py 결과(모델 × 장르)를 한 페이지에 격자로 놓는다 — 어느 모델이 좋은지 고르는 비교용.

    python3 docs/prototype/build_multi_compare.py --run 2026-10-02-001
→ docs/prototype/genre-compare-multi-{실행ID}.html. 행 = 모델, 열 = 장르. 그림마다 왼쪽 위에 모델 이름 배지(CSS)가 붙고,
  아래쪽 「장르별로 보기」는 같은 장르를 모델끼리 가로로 늘어놓는다. 없는 그림은 빈 칸으로 둔다.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COMPARE = ROOT / "assets" / "genres" / "compare"
GENRE_KO = {"dancesport": "댄스스포츠 · 룸바", "samba": "댄스스포츠 · 쌈바", "tango": "아르헨티나 탱고", "swing": "스윙", "salsa_bachata": "살사 · 바차타"}
# 장르별 출연진 원화 썸네일(assets/genres/refs/) — 목표 보드처럼 카드 아래에 붙인다
CAST = {"dancesport": ["spike", "julia"], "samba": ["spike", "julia"], "tango": ["spike", "julia"], "swing": ["spike", "faye"], "salsa_bachata": ["spike", "faye"]}
CAST_KO = {"spike": "스파이크", "julia": "줄리아", "faye": "페이", "vicious": "비셔스", "vincent": "빈센트", "katerina": "카테리나"}
MODEL_INFO = {"local-animagine": "cagliostrolab/animagine-xl-4.0 · 로컬", "local-illustrious": "OnomaAIResearch/Illustrious-XL-v2.0 · 로컬",
              "local-animagine-bebop-lora": "animagine-xl-4.0 + Cowboy Bebop LoRA · 로컬", "local-illustrious-bebop-lora": "Illustrious-XL-v2.0 + Cowboy Bebop LoRA · 로컬",
              "flux2": "FLUX.2 [dev] · Cloudflare 무료", "civitai-flux2-anime-lora": "FLUX.2 [dev] + 2D Cel LoRA · Civitai 무료 Buzz"}


def cell(run: Path, model: str, genre: str) -> str:
    p = run / model / f"{genre}.jpg"
    if not p.exists():
        return f'<figure class="c empty"><div class="ph">없음</div><figcaption>{model} · {genre}</figcaption></figure>'
    rel = p.relative_to(ROOT).as_posix()
    thumbs = "".join(f'<img class="th" src="assets/genres/refs/{c}.jpg" alt="{CAST_KO[c]}" title="{CAST_KO[c]}">' for c in CAST.get(genre, []) if (ROOT / "assets/genres/refs" / f"{c}.jpg").exists())
    cast = " + ".join(CAST_KO[c] for c in CAST.get(genre, []))
    return (f'<figure class="c"><a href="{rel}" target="_blank"><img src="{rel}" alt="{model} {genre}" loading="lazy">'
            f'<span class="badge">{model}</span></a><div class="thumbs">{thumbs}</div>'
            f'<figcaption>{GENRE_KO.get(genre, genre)} · {cast} · {p.stat().st_size // 1024} KB</figcaption></figure>')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, help="실행ID (assets/genres/compare/ 아래 폴더 이름)")
    args = ap.parse_args()
    run = COMPARE / args.run
    meta = json.loads((run / "run.json").read_text(encoding="utf-8")) if (run / "run.json").exists() else {}
    # run.json 은 마지막 호출(예: --only samba)이 덮어쓰므로 폴더의 실제 파일과 합친다(2026-10-03 실측: 쌈바 칸만 그려짐)
    disk_models = sorted(p.name for p in run.iterdir() if p.is_dir())
    disk_genres = sorted({f.stem for d in run.iterdir() if d.is_dir() for f in d.glob("*.jpg")})
    models = list(dict.fromkeys((meta.get("models") or []) + disk_models))
    order = list(GENRE_KO)
    genres = sorted(set(meta.get("genres") or []) | set(disk_genres), key=lambda g: order.index(g) if g in order else 99)
    cols = len(genres)

    by_model = "".join(
        f'<section class="row"><h2>{m}</h2><div class="grid" style="--n:{cols}">' + "".join(cell(run, m, g) for g in genres) + "</div></section>"
        for m in models)
    by_genre = "".join(
        f'<section class="row"><h2>{GENRE_KO.get(g, g)} <small>{g}</small></h2><div class="grid" style="--n:{len(models)}">'
        + "".join(cell(run, m, g) for m in models) + "</div></section>" for g in genres)
    html = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>장르 카드 · 모델 비교 {args.run}</title>
<style>
:root{{--bg:#0f1115;--fg:#e8e8ea;--mute:#9a9aa3;--line:#2a2d35}}
body{{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:1400px;margin-inline:auto}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mute);margin:0 0 20px}} h2{{font-size:17px;margin:0 0 8px}} h2 small{{color:var(--mute);font-weight:400;margin-left:8px}}
.row{{border-top:1px solid var(--line);padding:16px 0}} .grid{{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:10px}}
@media(max-width:800px){{.grid{{grid-template-columns:repeat(2,1fr)}}}}
.c{{margin:0;position:relative}} .c a{{display:block;position:relative}} .c img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block;background:#222}}
.badge{{position:absolute;left:8px;top:8px;background:rgba(0,0,0,.72);color:#fff;font:600 12px/1 system-ui;padding:6px 8px;border-radius:6px;letter-spacing:.02em}}
.ph{{aspect-ratio:1;border:1px dashed var(--line);border-radius:10px;display:grid;place-items:center;color:var(--mute)}}
.thumbs{{display:flex;gap:4px;margin-top:6px}} .th{{width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}}
.info{{border-top:1px solid var(--line);margin-top:24px;padding-top:16px;color:var(--mute);font-size:13px;display:grid;grid-template-columns:1fr 1fr;gap:16px}} @media(max-width:800px){{.info{{grid-template-columns:1fr}}}} .info b{{color:var(--fg)}}
figcaption{{margin-top:4px;color:var(--mute);font-size:12px}} .tabs{{display:flex;gap:8px;margin:12px 0}} .tabs a{{color:var(--fg);text-decoration:none;border:1px solid var(--line);padding:6px 10px;border-radius:8px}}
</style></head><body>
<h1>장르 카드 · 이미지 모델 비교</h1>
<p class="sub">실행 {args.run} · 화풍 {meta.get('style', '?')} · 모델 {len(models)}개 × 장르 {len(genres)}개. 같은 프롬프트·같은 seed 로 동시에 뽑았다. 그림을 누르면 원본이 열린다.</p>
<div class="tabs"><a href="#m">모델별로 보기</a><a href="#g">장르별로 보기</a></div>
<h2 id="m">모델별로 보기 — 한 줄이 한 모델</h2>{by_model}
<h2 id="g" style="margin-top:28px">장르별로 보기 — 한 줄이 한 장르, 모델끼리 나란히</h2>{by_genre}
<div class="info"><div><b>MODEL &amp; GENERATION INFO</b><br>{'<br>'.join(f'{m}: {MODEL_INFO.get(m, m)}' for m in models)}<br>로컬 RTX 4060 · 1024×1024 · 28 steps · Euler a · 전부 무료</div>
<div><b>KEY POINT</b><br>춤의 정의(genre-dance-definitions.md)를 중심 지시로 · 원작 캐릭터 디자인 재현(genre-character-sheet.md) · 장르별 악기와 무대 · 극장판 「천국의 문」 분위기</div></div>
</body></html>"""
    out = ROOT / f"genre-compare-multi-{args.run}.html"
    out.write_text(html, encoding="utf-8")
    print(f"→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
