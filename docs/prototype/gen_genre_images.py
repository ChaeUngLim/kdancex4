#!/usr/bin/env python3
"""장르 카드 사진 4장을 FLUX 로 만든다.

FLUX 계열은 FLUX.2 [dev] 하나만 쓴다 (2026-10-02 결정: FLUX.1 [dev]·[schnell] 은 전 세대라 제거).

- cloudflare-flux2 : Workers AI 의 FLUX.2 [dev]. 출력 타일당·step당 약 37 뉴런이라 1024×1024 · 24 steps 한 장 ≈ 1,000 뉴런(실측),
               하루 10,000 뉴런 무료 → 하루 약 10장. 무료 구간은 매일 초기화(정확한 시각은 미확정 — 24시간 이동 창으로 보임).
               키: ~/.config/kdance/cloudflare.env 의 CLOUDFLARE_ACCOUNT_ID · CLOUDFLARE_API_TOKEN (권한: Account → Workers AI → Read 이상)
  한도가 끝났을 때의 대체 경로는 애니 전용 모델 제공처(gen_genre_multi.py 참고)다.

사용법:
    python3 docs/prototype/gen_genre_images.py --check              # 키가 맞는지만 확인(뉴런 소모 없음)
    python3 docs/prototype/gen_genre_images.py                      # cloudflare-flux2, 4장 전부
    python3 docs/prototype/gen_genre_images.py --only dancesport    # 한 장만
    python3 docs/prototype/gen_genre_images.py --dry-run            # 호출 없이 요청 내용만 출력

표준 라이브러리만 쓴다. 결과는 docs/prototype/assets/genres/{이름}.jpg 에 덮어쓴다.
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "assets" / "genres"
CONFIG_DIR = Path.home() / ".config" / "kdance"

REFERENCE = OUT_DIR / "reference.jpg"  # 사용자가 준 댄스스포츠 유화 카드(353×297). FLUX.2 [dev] 의 input_image_0 으로 넣는다

# 댄스스포츠만 사용자가 준 유화(reference.jpg)를 참고 이미지로 넣어 화풍을 맞춘다.
BALLROOM_STYLE = (
    "Painted in exactly the same style as image 0: a romantic digital oil painting with soft visible brushstrokes, "
    "warm golden-amber palette, glowing chandelier light from above, hazy luminous background, seated musicians "
    "with sheet music around the dance floor, polished wooden floor with warm reflections, cinematic depth, "
    "one couple centered mid-dance, no text, no watermark"
)

# 이름 · 장면+화풍 · seed · 참고 이미지 사용 여부. 장르마다 화풍을 완전히 다르게 잡는다(2026-09-30 사용자 요청).
JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (
        "Ballroom dancesport: a couple dancing a waltz in a grand gilded ballroom with balconies, the woman in a "
        "flowing crimson-orange gown, the man in a dark tailcoat, a string orchestra seated at tables. " + BALLROOM_STYLE,
        77, True,
    ),
    "tango": (
        "Argentine tango on a rain-wet cobblestone street corner of La Boca, Buenos Aires, at midnight: colorful "
        "corrugated-iron facades in the background, a single amber street lamp, an old cafe with fogged windows, a "
        "bandoneon player seated on the curb. A couple in a tight close embrace with intertwined legs, the woman in a "
        "black slit dress and red heels, the man in a dark suit and fedora. Style: dramatic film-noir chiaroscuro, deep "
        "crimson and black palette with a single red spotlight, smoky air, Art Deco poster feel, no text, no watermark",
        22, False,
    ),
    "swing": (
        "Lindy hop swing dance inside the Savoy Ballroom, Harlem, 1940s: a wide sprung dance floor packed with "
        "dancers, a raised bandstand with a full brass big band, a glowing neon 'SWING' marquee and chrome Art Deco "
        "railings in the background, confetti and spotlights. In front, a couple mid-air kick, the woman in a polka-dot "
        "swing dress, the man in suspenders and two-tone shoes. Style: vibrant retro screen-print poster, saturated "
        "teal, mustard yellow and cherry red, halftone grain, bold flat shapes, motion lines, joyful, no text",
        33, False,
    ),
    "salsa_bachata": (
        "Salsa and bachata at a Caribbean seaside street party in old Havana at night: pastel colonial arcades and "
        "a 1950s vintage car in the background, palm trees, string lights over the street, the ocean and a full moon "
        "beyond the sea wall, congas and a trumpet player on a small stage. In front, a couple spinning hip to hip, "
        "the woman in a white flowing dress, the man in an open linen shirt. Style: bold contemporary digital "
        "illustration, electric magenta, turquoise and sunset orange, neon glow, humid tropical night, no text",
        44, False,
    ),
}

# 2026-10-02 사용자 요청: 같은 4장을 90년대 레트로 애니(셀 애니메이션) 화풍으로 다시 뽑아 기존 유화 세트와 비교한다.
# 참고 이미지(유화)는 넣지 않는다 — 화풍이 충돌한다. 배경은 장르마다 어울리는 분위기로 잡는다.
# 2026-10-02 채택 확정. 간판·마키를 그리라고 하면 FLUX 가 'no text' 를 무시하고 글자를 넣는다(스윙·탱고 1차 결과) —
# 그래서 탱고·스윙 프롬프트는 간판 자체를 빼고 'no signboard, no lettering' 으로 바꿨다.
RETRO90S_STYLE = (
    "Style: late-1990s Japanese TV anime cel still (Sailor Moon, Slayers, Cardcaptor Sakura, Cowboy Bebop era): "
    "crisp clean digital-cel coloring, sharp confident ink linework, large expressive anime eyes, glossy highlight "
    "streaks in the hair, bright saturated palette with clean two-tone cel shadows, hand-painted anime background "
    "with soft airbrushed light, subtle lens flare, 16:9 TV anime framing, no 1980s film grain, no VHS blur, "
    "no text, no watermark, no subtitles"
)
# NVIDIA FLUX.1 [dev] 는 밀착 포옹·슬릿 드레스·맨가슴 같은 표현에 CONTENT_FILTERED(6KB 검은 JPEG)를 돌려준다(2026-10-02 실측,
# finishReason 필드로 확인). 그래서 포즈·의상 표현을 순화해 뒀다 — 네 장 모두 "classic frame / spinning together" 수준으로.
RETRO90S_JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (
        "Ballroom dancesport waltz in a grand gilded ballroom: crystal chandelier, marble columns, mirrored walls, "
        "a string orchestra on a raised stage, sparkling shojo-anime light flares and floating sparkles. A couple "
        "centered mid-turn in a classic ballroom frame, the woman in a flowing crimson-orange ballgown with long "
        "gloves, the man in a dark tailcoat, elegant and dreamy. Warm gold and ivory palette. " + RETRO90S_STYLE,
        2077, False,
    ),
    "tango": (
        "Argentine tango on a rain-wet cobblestone street in Buenos Aires at midnight: an old corner cafe with warm "
        "fogged golden windows and a bare brick facade, absolutely no signboard and no lettering anywhere, wet "
        "pavement reflections, a lone amber street lamp, a bandoneon player seated on the curb. A couple dancing a "
        "dramatic tango step in a classic close frame, the woman in a long elegant black dress and red heels, the "
        "man in a dark suit and fedora. Moody midnight-blue and crimson palette, dramatic shadows. " + RETRO90S_STYLE,
        2022, False,
    ),
    "swing": (
        "Lindy hop swing dance inside a 1940s Harlem ballroom: a full brass big band with trumpets, trombones and "
        "saxophones playing on a raised bandstand right behind the couple, a gilded Art Deco sunburst ornament and "
        "velvet curtains above the stage, absolutely no marquee, no signboard and no lettering anywhere, checkered "
        "dance floor, confetti and spotlights, a crowd of cheering dancers. In front, a couple mid-air kick, the "
        "woman in a polka-dot swing dress, the man in suspenders and two-tone shoes, big joyful anime smiles. Bright "
        "mustard yellow, teal and cherry red palette, energetic speed lines. " + RETRO90S_STYLE,
        2033, False,
    ),
    "salsa_bachata": (
        "Salsa and bachata street party by the sea in old Havana at night: pastel colonial arcades, a 1950s "
        "vintage car, palm trees, string lights across the street, the ocean and a full moon beyond the sea wall, "
        "congas and a trumpet player on a small stage. In front, a couple spinning together with joined hands, the "
        "woman in a white flowing dress, the man in a light linen shirt. Electric magenta, turquoise and sunset "
        "orange palette, humid tropical night glow. " + RETRO90S_STYLE,
        2044, False,
    ),
}

# 2026-10-02 사용자 요청 2차: 가와지리 요시아키(獣兵衛忍風帖·사이버 시티 오에도 808) 화풍으로 전체 교체.
# (당시 NVIDIA FLUX.1 [dev] 로 뽑았다 — 2026-10-02 밤 제거. 그 필터는 긴 프롬프트(의상·포즈 묘사가 많은)에서 CONTENT_FILTERED 를
# 돌려주고 짧은 프롬프트는 5/5 통과했다(2026-10-02 실측). 볼룸·스윙은 한 구절만 늘려도 다시 걸렸다 — 그래서 이 묶음은 짧게 쓴다. 작가·작품명을 넣은 버전도 걸려서 특징만 풀어 썼다.
KAWAJIRI_STYLE = (
    "1990s Japanese OVA anime cel style, sharply angular faces, narrow intense eyes, razor-sharp ink lines, heavy "
    "black cel shadows, dramatic chiaroscuro, dark palette with vivid crimson, no text"
)
KAWAJIRI_JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (
        "Ballroom waltz in a gilded ballroom with chandelier, a couple in a ballroom frame, woman in a crimson gown, "
        "man in tailcoat. " + KAWAJIRI_STYLE,
        501, False,
    ),
    "tango": (
        "Argentine tango on a rainy cobblestone street at night, a couple in a tango step, man in fedora, woman in "
        "long black dress. " + KAWAJIRI_STYLE,
        501, False,
    ),
    "swing": (
        "Lindy hop swing dance in a 1940s Harlem ballroom under warm golden spotlights, a couple mid-air kick, big "
        "band behind. " + KAWAJIRI_STYLE,
        501, False,
    ),
    "salsa_bachata": (
        "Salsa street party by the sea in old Havana at night, a couple spinning with joined hands, congas on stage. "
        + KAWAJIRI_STYLE,
        501, False,
    ),
}

# 2026-10-02 사용자 요청 3차: 카우보이 비밥 극장판(2001) 화풍으로 전체 교체. 작품명을 넣으면 NVIDIA 필터에 걸려 특징만 풀어 썼다.
BEBOP_STYLE = (
    "early-2000s theatrical anime film cel style, realistic slim proportions, lean sharp faces with heavy-lidded "
    "eyes, thin confident ink lines, soft two-tone cel shading, muted jazz-noir palette of warm amber, teal and "
    "smoky brown, detailed painted cinematic background, no text"
)
BEBOP_JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (
        "Ballroom waltz in a gilded ballroom with chandelier, a couple in a ballroom frame, woman in a crimson gown, "
        "man in tailcoat. " + BEBOP_STYLE,
        601, False,
    ),
    "tango": (
        "Argentine tango on a rainy cobblestone street at night, a couple in a tango step, man in fedora, woman in "
        "long black dress. " + BEBOP_STYLE,
        601, False,
    ),
    "swing": (
        "Lindy hop swing dance in a 1940s Harlem ballroom under warm golden spotlights, a couple mid-air kick, big "
        "band behind. " + BEBOP_STYLE,
        601, False,
    ),
    "salsa_bachata": (
        "Salsa street party by the sea in old Havana at night, a couple spinning with joined hands, congas on stage. "
        + BEBOP_STYLE,
        601, False,
    ),
}

# 2026-10-02 사용자 요청 4차: 「천국의 문」 등장인물 조합. 이름을 넣으면 NVIDIA 필터에 걸리고 모델도 이름을 모르므로 외형만 적는다.
# 댄스스포츠·스윙 = 스파이크(짙은 녹색 더벅머리·파란 정장·노란 셔츠) + 페이(보라색 단발·녹색 눈) /
# 살사·바차타 = 빈센트(긴 검은 머리 묶음·검은 롱코트·수척) + 일렉트라(갈색 피부·긴 흑발·붉은 입술) /
# 탱고 = 비셔스(은발·창백·검은 코트) + 줄리아(긴 금발 웨이브·붉은 입술). 저작권상 내부 프로토타입용.
# 'short violet bob' 은 NVIDIA 필터에 걸린다(4변형 실측) — 'chin-length purple hair' 는 통과.
BEBOP_CAST_JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (
        "Ballroom waltz in a gilded ballroom with chandelier: a lanky man with dark green messy hair in a blue suit, "
        "and a woman with chin-length purple hair in a crimson gown, in a ballroom frame. " + BEBOP_STYLE,
        701, False,
    ),
    "tango": (
        "Argentine tango on a rainy cobblestone street at night: a gaunt pale man with long silver hair in a black "
        "coat, and a woman with long wavy blonde hair and red lips in a long black dress, in a tango step. "
        + BEBOP_STYLE,
        701, False,
    ),
    "swing": (
        "Lindy hop swing in a 1940s Harlem ballroom under golden spotlights: a lanky man with dark green messy hair "
        "in a blue suit, and a woman with chin-length purple hair in a yellow dress, mid-air kick. " + BEBOP_STYLE,
        701, False,
    ),
    "salsa_bachata": (
        "Salsa street party by the sea in old Havana at night: a tall gaunt man with long dark hair tied back in a "
        "long black coat, and a tan-skinned woman with long dark hair and red lips in a white dress, spinning with "
        "joined hands, congas on stage. " + BEBOP_STYLE,
        701, False,
    ),
}

# 2026-10-02 사용자 요청 5차: 참고 이미지 16장을 분석한 캐릭터 시트로 짝을 다시 짰다.
# 룸바(댄스스포츠) = 스파이크 + 줄리아 / 탱고 = 빈센트 + 카테리나 솔렌산 / 스윙 = 스파이크 + 페이 / 바차타 = 비셔스 + 줄리아.
BEBOP_CAST2_JOBS: dict[str, tuple[str, int, bool]] = {
    # 2026-10-03: 춤의 정의(genre-dance-definitions.md)의 영문 요지 + 장르별 악기를 앞에 둔다.
    "dancesport": ("Rumba — if samba is laughter bursting under the sun, rumba is a sigh of longing whispered in moonlight: "
                   "a couple apart at arm's length, only fingertips touching, hips swaying slowly, eyes locked. A string "
                   "orchestra with violins and cello plays beside a moonlit chandelier ballroom. A lanky man with dark green "
                   "messy hair in a navy suit and yellow shirt, and a woman with long wavy golden hair and red lips in a red "
                   "latin dress. " + BEBOP_STYLE, 801, False),
    "tango": ("Argentine tango — the silence of a farewell under a street lamp: chest to chest, legs wrapping and unwrapping, "
              "spines upright, utterly still. A bandoneon player sits on the curb, sheet music scattered on the wet "
              "cobblestones, one amber lamp in the rain. A gaunt man with long messy dark grey hair and stubble in a dark "
              "military coat, and a woman with wavy brown hair, a blue ribbon and red lips in a magenta dress. " + BEBOP_STYLE, 801, False),
    "swing": ("Lindy hop — freedom regained by letting go of the hand: both dancers mid-air, feet off the floor, laughing, "
              "about to catch each other again. A brass big band with trumpets and saxophones on stage in a 1940s dance "
              "hall, warm spotlight, crowd cheering. A lanky man with dark green messy hair in a navy suit, and a woman with "
              "a purple bob and yellow headband in a yellow top and red cardigan. " + BEBOP_STYLE, 801, False),
    "samba": ("Ballroom samba — if rumba is a sigh in moonlight, samba is laughter bursting under the sun, a pulse of life "
              "that keeps surging outward: a couple bouncing on the balls of their feet, hips rolling, arms flung open, huge "
              "smiles, fringe flying. A bright sunlit ballroom with a percussion band — surdo drums, tambourines, cuíca — "
              "and confetti. A lanky man with dark green messy hair in a navy suit and yellow shirt, and a woman with long "
              "wavy golden hair and red lips in a bright yellow fringe samba dress. " + BEBOP_STYLE, 801, False),
    "salsa_bachata": ("Bachata — a lover's warmth glowing in a back-alley window: hips pressed together, bodies rippling in a "
                      "small circle, foreheads almost touching, a whispered confession. Conga players in the warm lamplight of "
                      "a seaside town at night, the ocean far behind. A pale man with long silver hair over one eye in a black "
                      "coat, and a woman with long wavy golden hair in a black dress. " + BEBOP_STYLE, 801, False),
}

# 2026-10-03 2차 기준 — FLUX.2 용 자연어(세로 2:3 카드 4장). 원본은 docs/prototype/prompts/bebop-cards-4-prompts.md 의 B. 태그 모델은 gen_genre_multi 의 TAG_SCENES 를 쓴다.
# BEBOP_STYLE 을 뒤에 붙이는 이유: tagify() 가 이 문자열로 짧은 화풍 태그를 고른다.
BEBOP_CARDS2_COMMON = "A vertical 2:3 cinematic still in the mature style of a late-1990s Japanese theatrical anime film: precise confident line art, natural adult proportions, finely drawn hair strands and cloth folds, volumetric cinematic lighting with deep shadows, subtle film grain, a deep painted background, refined color grading. Semi-realistic anime, not cute, not chibi, no mobile-game gloss, no 3D render look. Exactly two people, correct hands and limbs, no extra limbs. Keep the two characters' faces, hairstyles, body types and costumes consistent with the reference images; do not reinterpret them as other characters. Leave the top-left corner free of detail for a title."
BEBOP_CARDS2_JOBS: dict[str, tuple[str, int, bool]] = {
    "dancesport": (BEBOP_CARDS2_COMMON + " " + "Inside a palace ballroom like a fairy-tale castle, moonlight pours through tall arched windows in silver-blue beams while candles add a warm gold glow and the marble floor mirrors the light. A tall lanky man with dark green fluffy messy hair, narrow eyes, a navy suit, yellow shirt and loose black tie (Spike Spiegel) holds a woman with short wavy red hair, blue eyes and red lips in a black slit dress (Julia) in a close rumba hold. They face each other, foreheads almost touching, as if whispering a song of longing and love. Tender, quiet, intimate. Full body, both faces clearly visible." + " " + BEBOP_STYLE, 801, False),
    "swing": (BEBOP_CARDS2_COMMON + " " + "In a dark jazz club under blue and teal stage light, a big band plays out of focus behind them and a neon sign glows. Spike Spiegel (dark green messy hair, navy suit, yellow shirt, loose tie) swings Faye Valentine (short purple bob, yellow hairband, green eyes, red lips, red backless dress) through a fast spin: a single-hand connection, her dress flaring with the motion, both laughing. The polished floor reflects the lights; the crowd is a blur of silhouettes. Full body, dynamic, both faces clearly visible." + " " + BEBOP_STYLE, 801, False),
    "salsa_bachata": (BEBOP_CARDS2_COMMON + " " + "In a latin club at night, intense red neon and warm golden lamplight wash over the floor and a blurred crowd dances behind. A tall gaunt man with long wavy black hair, stubble and a long black coat over a dark red shirt (Vincent Volaju) dances bachata pressed close to a tan woman with a blonde curly updo in a red dress with a gold belt (Electra Ovilo). His hand at her waist, hers on his shoulder, a rhythmic shift of weight, foreheads almost touching. Full body, intimate, both faces clearly visible." + " " + BEBOP_STYLE, 801, False),
    "tango": (BEBOP_CARDS2_COMMON + " " + "In an old grand hall lit by a crystal chandelier and candles, with deep shadows and amber light on dark wood, a woman with short wavy red hair, blue eyes and red lips in a black slit dress (Julia) holds a tense Argentine tango frame with a pale, sharp-faced man with long silver hair in a black suit and white shirt (Vicious). Clear frame, chest to chest, stable balance, a dramatic locked gaze full of tension. Full body, both faces clearly visible." + " " + BEBOP_STYLE, 801, False),
}

STYLES: dict[str, dict[str, tuple[str, int, bool]]] = {
    "bebop_cast2": BEBOP_CAST2_JOBS,
    "bebop_spike_faye": BEBOP_CAST2_JOBS,  # 태그 장면은 gen_genre_multi 에, FLUX 용 자연어는 cast2 를 임시 공유
    "bebop_collage": BEBOP_CAST2_JOBS,
    "bebop_cards2": BEBOP_CARDS2_JOBS,    # 2026-10-03 2차 기준(세로 카드 4장). FLUX 자연어는 여기, 태그 장면은 gen_genre_multi 에     # 2026-10-03 사용자 콜라주 기준 이미지(3×2) 재현용. 태그 장면은 gen_genre_multi 에
    "bebop_cast": BEBOP_CAST_JOBS,
    "bebop": BEBOP_JOBS,
    "kawajiri": KAWAJIRI_JOBS,
    "oil": JOBS,            # 현재 보드 세트(유화)
    "retro90s": RETRO90S_JOBS,
}

MIN_BYTES = 20_000  # 이보다 작으면 검은 화면(안전 필터)으로 본다


def read_env(name: str) -> dict[str, str]:
    """~/.config/kdance/{name} 을 KEY=VALUE 로 읽는다. 없으면 빈 dict."""
    path = CONFIG_DIR / name
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def post_json(url: str, body: dict, headers: dict[str, str], timeout: int = 300) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **headers}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())




def post_multipart(url: str, fields: dict[str, str], files: dict[str, Path], headers: dict[str, str],
                   timeout: int = 300) -> dict:
    """표준 라이브러리만으로 multipart/form-data 를 보낸다(문자열 필드 + 파일 필드)."""
    boundary = "----kdance" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for k, v in fields.items():
        chunks.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode())
    for k, path in files.items():
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: image/jpeg\r\n\r\n".encode() + path.read_bytes() + b"\r\n"
        )
    body = b"".join(chunks) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}", **headers}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def gen_cloudflare_flux2(prompt: str, seed: int, env: dict[str, str], use_reference: bool = False) -> bytes:
    """FLUX.2 [dev] 는 multipart 로만 받는다(2026-09-30 실측: JSON 은 400 'required multipart').
    use_reference 가 True 일 때만 참고 이미지(reference.jpg, 512×512 미만)를 input_image_0 으로 넣는다."""
    account = env.get("CLOUDFLARE_ACCOUNT_ID")
    token = env.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        raise SystemExit(
            "cloudflare.env 에 CLOUDFLARE_ACCOUNT_ID 와 CLOUDFLARE_API_TOKEN 이 필요하다 "
            f"({CONFIG_DIR / 'cloudflare.env'})"
        )
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-dev"
    fields = {"prompt": prompt, "steps": "24", "width": "1024", "height": "1024", "seed": str(seed)}  # 24 steps ≈ 3,600 뉴런
    files = {"input_image_0": REFERENCE} if (use_reference and REFERENCE.exists()) else {}
    data = post_multipart(url, fields, files, {"Authorization": f"Bearer {token}"})
    if not data.get("success", True) and data.get("errors"):
        raise RuntimeError(f"cloudflare 오류: {data['errors']}")
    result = data.get("result", data)
    return base64.b64decode(result["image"])



def check_cloudflare(env: dict[str, str]) -> int:
    """토큰 검증 엔드포인트만 부른다 — Workers AI 뉴런을 쓰지 않는다."""
    account = env.get("CLOUDFLARE_ACCOUNT_ID")
    token = env.get("CLOUDFLARE_API_TOKEN")
    if not account or not token:
        print(f"키 파일이 없거나 비어 있다: {CONFIG_DIR / 'cloudflare.env'}", file=sys.stderr)
        return 2
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}/tokens/verify",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"토큰 확인 실패: HTTP {e.code} {e.read()[:300]!r}", file=sys.stderr)
        return 1
    status = (data.get("result") or {}).get("status")
    print(f"토큰 상태: {status} · 계정 {account[:6]}…")
    return 0 if data.get("success") and status == "active" else 1


PROVIDERS = {
    "cloudflare-flux2": ("cloudflare.env", gen_cloudflare_flux2),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", choices=PROVIDERS, default="cloudflare-flux2")
    ap.add_argument("--check", action="store_true", help="Cloudflare 토큰이 유효한지만 확인하고 끝낸다")
    ap.add_argument("--only", choices=JOBS, action="append", help="이 장르만 (여러 번 지정 가능)")
    ap.add_argument("--dry-run", action="store_true", help="호출하지 않고 요청 내용만 출력")
    ap.add_argument("--retries", type=int, default=2, help="검은 화면이 나오면 seed 를 바꿔 다시 시도하는 횟수")
    ap.add_argument("--seed-offset", type=int, default=0,
                    help="모든 장르의 seed 에 더하는 값. 같은 프롬프트로 다른 그림을 뽑아 비교할 때 쓴다")
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="결과를 저장할 폴더. 기본은 oil 이면 assets/genres(현재 카드를 덮어쓴다), "
                         "다른 화풍이면 assets/genres/{화풍 이름}")
    ap.add_argument("--style", choices=STYLES, default="oil",
                    help="프롬프트 묶음. oil 은 현재 유화 세트, retro90s 는 90년대 레트로 애니 화풍, kawajiri 는 가와지리 요시아키 OVA 화풍, bebop 은 카우보이 비밥 극장판 화풍, bebop_cast 는 같은 화풍에 「천국의 문」 등장인물 조합")
    args = ap.parse_args()
    jobs = STYLES[args.style]

    env_name, gen = PROVIDERS[args.provider]
    env = read_env(env_name)
    if args.check:
        return check_cloudflare(env)
    names = args.only or list(jobs)
    out_dir: Path = args.out_dir or (OUT_DIR if args.style == "oil" else OUT_DIR / args.style)
    out_dir.mkdir(parents=True, exist_ok=True)

    failed: list[str] = []
    for name in names:
        prompt, seed, use_ref = jobs[name]
        seed += args.seed_offset
        out = out_dir / f"{name}.jpg"
        if args.dry_run:
            print(f"[dry-run] {args.provider} → {out} seed={seed}\n  {prompt[:110]}…")
            continue
        for attempt in range(args.retries + 1):
            t0 = time.time()
            try:
                raw = gen(prompt, seed + attempt * 1000, env, use_ref)
            except urllib.error.HTTPError as e:
                print(f"{name}: HTTP {e.code} {e.read()[:300]!r}", file=sys.stderr)
                failed.append(name)
                break
            if len(raw) < MIN_BYTES:
                print(f"{name}: {len(raw)} bytes — 검은 화면으로 보여 seed 를 바꿔 다시 시도 ({attempt + 1}/{args.retries})")
                continue
            out.write_bytes(raw)
            print(f"{name}: OK {len(raw):,} bytes · {time.time() - t0:.1f}s → {out}")
            break
        else:
            failed.append(name)

    if failed:
        print(f"실패: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
