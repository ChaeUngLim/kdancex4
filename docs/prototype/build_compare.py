#!/usr/bin/env python3
"""장르 카드 비교 페이지를 만든다 — 현재 세트(assets/genres)와 후보 세트(assets/genres/candidate)를 나란히 놓는다.

사용법:
    python3 docs/prototype/build_compare.py            # docs/prototype/genre-compare.html 생성
결과 페이지는 브라우저로 열어 본다(WSL 이면 explorer.exe genre-compare.html).
후보가 없는 장르는 현재 카드를 그대로 보여 주고 '후보 없음' 으로 표시한다.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CUR = ROOT / "assets" / "genres"
CAND = CUR / "candidate"
OUT = ROOT / "genre-compare.html"

# 후보 폴더 이름 → (페이지 부제, 장르별 설명). 새 화풍을 뽑으면 여기에 한 묶음 더한다.
CANDIDATE_SETS: dict[str, tuple[str, dict[str, str]]] = {
    "candidate": ("장르별 다른 화풍 후보(2026-09-30)", {
        "dancesport": "참고 유화 화풍(어제 확정) — 두 세트 공통",
        "tango": "현재: 유화 화풍 통일 · 후보: 필름 누아르, 라보카 골목",
        "swing": "현재: 유화 화풍 통일 · 후보: 레트로 실크스크린 포스터, 사보이 볼룸",
        "salsa_bachata": "현재: 유화 화풍 통일 · 후보: 네온 디지털 일러스트, 아바나 해변",
    }),
    "illustrious": ("Illustrious XL 2.0 로컬 생성 · 「천국의 문」 등장인물(2026-10-02 심야 채택)", {
        "dancesport": "현재(옛 유화 보관본) · 후보: 스파이크 + 페이, 빨간 장갑·샹들리에 볼룸",
        "tango": "현재(옛 유화 보관본) · 후보: 비셔스 + 줄리아, 비 오는 밤거리",
        "swing": "현재(옛 유화 보관본) · 후보: 스파이크 + 페이, 공중 킥",
        "salsa_bachata": "현재(옛 유화 보관본) · 후보: 빈센트 + 일렉트라, 해변·콩가",
    }),
    "bebop_cast": ("비밥 극장판 화풍 + 「천국의 문」 등장인물(2026-10-02 밤, FLUX.1)", {
        "dancesport": "현재(옛 유화 보관본) · 후보: 스파이크 + 페이, 커튼 볼룸",
        "tango": "현재(옛 유화 보관본) · 후보: 비셔스 + 줄리아, 비 젖은 골목",
        "swing": "현재(옛 유화 보관본) · 후보: 스파이크 + 페이, 황금 조명 할렘 볼룸",
        "salsa_bachata": "현재(옛 유화 보관본) · 후보: 빈센트 + 일렉트라, 아바나 해변 거리",
    }),
    "bebop": ("카우보이 비밥 극장판 화풍(2026-10-02 저녁)", {
        "dancesport": "현재(옛 유화 보관본) · 후보: 비밥풍, 커튼·샹들리에 볼룸·진홍 드레스",
        "tango": "현재(옛 유화 보관본) · 후보: 비밥풍, 틸·앰버 비 젖은 골목",
        "swing": "현재(옛 유화 보관본) · 후보: 비밥풍, 황금 스포트라이트·콘트라베이스",
        "salsa_bachata": "현재(옛 유화 보관본) · 후보: 비밥풍, 해변 테라스·콩가·도시 야경",
    }),
    "kawajiri": ("가와지리 요시아키 OVA 화풍(2026-10-02 낮 후보)", {
        "dancesport": "현재(옛 유화 보관본) · 후보: 가와지리풍, 샹들리에 볼룸·진홍 드레스",
        "tango": "현재(옛 유화 보관본) · 후보: 가와지리풍, 비 젖은 골목·가로등",
        "swing": "현재(옛 유화 보관본) · 후보: 가와지리풍, 황금 스포트라이트·빅밴드·공중 킥",
        "salsa_bachata": "현재(옛 유화 보관본) · 후보: 가와지리풍, 아바나 해변 야간·콩가",
    }),
    "retro90s": ("90년대 레트로 애니 화풍(2026-10-02)", {
        "dancesport": "현재: 금빛 유화 · 후보: 90년대 셀 애니, 대리석 기둥·샹들리에 볼룸",
        "tango": "현재: 금빛 유화 · 후보: 90년대 셀 애니, 비 젖은 부에노스아이레스 골목·네온 카페",
        "swing": "현재: 금빛 유화 · 후보: 90년대 셀 애니, 1940년대 할렘 볼룸·빅밴드·체크 바닥",
        "salsa_bachata": "현재: 금빛 유화 · 후보: 90년대 셀 애니, 아바나 해변 야간 거리 파티",
    }),
}
GENRE_KO = [("dancesport", "댄스스포츠"), ("tango", "탱고"), ("swing", "스윙"), ("salsa_bachata", "살사·바차타")]


def card(path: Path, label: str) -> str:
    if not path.exists():
        return f'<figure class="card empty"><div class="ph">후보 없음</div><figcaption>{label}</figcaption></figure>'
    kb = path.stat().st_size // 1024
    rel = path.relative_to(ROOT).as_posix()
    return f'<figure class="card"><img src="{rel}" alt="{label}"><figcaption>{label} · {kb} KB</figcaption></figure>'


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cand", choices=CANDIDATE_SETS, default="candidate",
                    help="후보 폴더 이름(assets/genres/{이름}). 기본은 candidate")
    ap.add_argument("--cur", default=".",
                    help="'현재' 쪽 폴더 이름(assets/genres/{이름}). 기본은 assets/genres 자체. "
                         "채택 뒤 옛 세트와 비교할 때는 보관 폴더(예: oil)를 준다")
    args = ap.parse_args()
    CUR = Path(__file__).resolve().parent / "assets" / "genres" / args.cur
    CAND = CUR.parent / args.cand if args.cur != "." else CUR / args.cand
    subtitle, notes = CANDIDATE_SETS[args.cand]
    GENRES = [(k, ko, notes[k]) for k, ko in GENRE_KO]
    OUT = ROOT / ("genre-compare.html" if args.cand == "candidate" else f"genre-compare-{args.cand}.html")
    rows = []
    for key, ko, note in GENRES:
        rows.append(
            f'<section class="row"><h2>{ko} <small>{key}</small></h2><p class="note">{note}</p>'
            f'<div class="pair">{card(CUR / f"{key}.jpg", "현재")}{card(CAND / f"{key}.jpg", "후보")}</div></section>'
        )
    html = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>장르 카드 비교</title>
<style>
:root{{--bg:#0f1115;--fg:#e8e8ea;--mute:#9a9aa3;--line:#2a2d35}}
body{{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin-inline:auto}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mute);margin:0 0 24px}}
.row{{border-top:1px solid var(--line);padding:20px 0}} h2{{font-size:18px;margin:0}} h2 small{{color:var(--mute);font-weight:400;margin-left:8px}}
.note{{color:var(--mute);margin:4px 0 12px}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:16px}} @media(max-width:640px){{.pair{{grid-template-columns:1fr}}}}
.card{{margin:0}} .card img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;display:block;background:#222}}
.card .ph{{aspect-ratio:1;border:1px dashed var(--line);border-radius:12px;display:grid;place-items:center;color:var(--mute)}}
figcaption{{margin-top:6px;color:var(--mute);font-size:13px}}
.grid4{{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0 16px}} .grid4 img{{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}}
@media(max-width:640px){{.grid4{{grid-template-columns:repeat(2,1fr)}}}}
</style></head><body>
<h1>장르 카드 비교 — 현재 vs 후보</h1>
<p class="sub" style="margin:0">{subtitle}</p>
<p class="sub">왼쪽이 지금 보드에 올라간 세트, 오른쪽이 새로 뽑은 세트. 아래 4장 묶음은 회원 앱 M4·M6 의 2×2 격자처럼 본 것.</p>
<h2>세트로 보기</h2>
<p class="note">현재 세트</p><div class="grid4">{''.join(f'<img src="{(CUR / (k + ".jpg")).relative_to(ROOT).as_posix()}" alt="{k}">' for k,_,_ in GENRES)}</div>
<p class="note">후보 세트(후보가 없는 장르는 현재 카드)</p><div class="grid4">{''.join(f'<img src="{(f"assets/genres/{args.cand}/"+k+".jpg") if (CAND/(k+".jpg")).exists() else ("assets/genres/"+k+".jpg")}" alt="{k}">' for k,_,_ in GENRES)}</div>
{''.join(rows)}
</body></html>"""
    OUT.write_text(html, encoding="utf-8")
    print(f"→ {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
