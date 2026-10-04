#!/usr/bin/env python3
"""같은 입력(화풍 묶음 × 장르 4종)으로 등록된 이미지 모델을 **전부 동시에** 돌려 모델별 카드 4장을 만든다.
어느 모델 그림이 좋은지 고르기 위한 비교용이다 (2026-10-02 사용자 요청).

결과: docs/prototype/assets/genres/compare/{실행ID}/{모델}/{장르}.jpg  (실행ID 는 YYYY-MM-DD-NNN)
       각 그림 왼쪽 위에 모델 이름을 구워 넣는다(Pillow 가 있을 때). 비교 페이지는 build_multi_compare.py 가 만든다.

모델(제공처)과 키 — 키 파일은 전부 ~/.config/kdance/ 아래, 저장소 밖:
  flux2                Cloudflare Workers AI · FLUX.2 [dev]              cloudflare.env  CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
  pixai-tsubaki        PixAI · Tsubaki (기본 Tsubaki.2 1983308862240288769)  pixai.env       PIXAI_API_KEY, (선택) PIXAI_MODEL_VERSION_ID
  civitai-animagine    Civitai 생성 API · Animagine XL 4.0 (1188071@1337429)  civitai.env     CIVITAI_API_KEY
  civitai-illustrious  Civitai 생성 API · Illustrious XL 2.0 (1369089@1546777) civitai.env     CIVITAI_API_KEY
  civitai-flux2-anime-lora  Civitai 생성 API · FLUX.2 [dev] + 2D Cel 애니 LoRA(2301918)  civitai.env     CIVITAI_API_KEY (Buzz 필요)
      ※ 정의(2026-10-02 사용자 결정): 「FLUX.2 [dev] + Anime Style LoRA」 는 **무료 API 호출(Civitai 매일 무료 Blue Buzz)** 로 만든다.
        로컬 실행(32B, 8GB 불가)·Cloudflare(LoRA 미지원)는 쓰지 않는다. 유료 플랜·Buzz 구매는 하지 않는다.
  local-animagine      로컬 서버(local-sd/server.py) · Animagine XL 4.0 (~/models/sdxl)   local-sd.env    LOCAL_SD_URL
  local-illustrious    로컬 서버(local-sd/server.py) · Illustrious XL 2.0 (~/models/sdxl)  local-sd.env    LOCAL_SD_URL
  NijiJourney v6 는 공식 API 가 없어(2026-09 기준) 넣지 않았다.

사용법:
    python3 docs/prototype/gen_genre_multi.py --check                       # 키 파일·인증만 확인(무료)
    python3 docs/prototype/gen_genre_multi.py --style bebop_cast            # 등록된 모델 전부, 4장씩 동시에
    python3 docs/prototype/gen_genre_multi.py --style bebop_cast --model pixai-tsubaki --model flux2
    python3 docs/prototype/gen_genre_multi.py --style bebop_cast --only tango --dry-run
그 뒤: python3 docs/prototype/build_multi_compare.py --run {실행ID}

표준 라이브러리만 쓴다(Pillow 는 있으면 라벨 굽기에만 쓴다). 시스템 python3 에는 pip 가 없으니 라벨까지 구우려면
    uv run --with pillow --python 3.12 docs/prototype/gen_genre_multi.py --style bebop_cast
로 돌린다(2026-10-02 확인). 프롬프트 묶음(STYLES)은 gen_genre_images.py 것을 그대로 쓴다.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gen_genre_images as base  # STYLES · read_env · post_json · post_multipart · gen_cloudflare_flux2 · MIN_BYTES

ROOT = Path(__file__).resolve().parent
COMPARE_DIR = ROOT / "assets" / "genres" / "compare"
CONFIG_DIR = base.CONFIG_DIR

# 태그 기반 애니 모델(SDXL 계열: Animagine·Illustrious·PixAI SDXL)은 품질 태그를 앞에 붙이고 부정 프롬프트를 준다.
# FLUX·Tsubaki(DiT) 는 자연어 그대로 쓴다.
TAG_PREFIX = ("masterpiece, best quality, very aesthetic, absurdres, semi-realistic, painterly, soft shading, glossy hair, "
              "detailed skin texture, highly detailed face, detailed eyes, realistic anatomy, dramatic rim lighting, chiaroscuro, "
              "dark nightclub, candlelight, warm amber and teal color grading, high contrast, cinematic, film still, ")
LORA_WEIGHT_OVERRIDE: float | None = None  # --lora-weight
IP_REFS: list[Path] = []  # --ip-ref 참조 이미지(캐릭터 외형 고정, 로컬 서버 IP-Adapter)
IP_WEIGHT: float = 0.6  # --ip-weight
IP_HR_WEIGHT: float = 0.0  # --ip-hr-weight (2단계 기본 0 — VRAM 피크를 안 올린다)
IP_MODEL: str = "plus"  # --ip-model plus|plus-face
INIT_IMAGE: Path | None = None  # --init-image 초안(기준 그림의 칸). 1단계가 img2img 가 된다
INIT_STRENGTH: float = 0.6  # --init-strength
INIT_MASK: Path | None = None  # --init-mask 흰색 = 새로 그릴 자리. 있으면 ① 마스크 채우기(1024) → ② 그 결과를 초안으로 고품질, 두 요청
HR_SCALE: float = 1.5  # --hr-scale (2단계 배율, VRAM 실험용)
ATTN_SLICING: bool = False  # --attn-slicing
OFFLOAD_TE: bool = False  # --offload-te (글 인코더를 벡터 추출 뒤 CPU 로)
VAE_TILING: bool = False  # --vae-tiling (1단계 디코드부터 타일링)
WIDTH: int = 1024  # --width
HEIGHT: int = 1024  # --height (2:3 카드는 832×1248)
HQ: bool = False  # --hq
HR_LORA: float | None = None  # --hr-lora-weight: hires 단계 LoRA 세기(0=끔). None 이면 base 와 같음: DPM++ 2M Karras 35 steps + 1.5배 고해상도 2단계(서버 enable_hr)
# FLUX.2 [dev] 용 애니 LoRA — Civitai 2301918 "flux-2-trainer-v2_2D_Cel"(2D 셀 화풍, Flux.2 D 학습)
FLUX2_ANIME_LORA_AIR = "urn:air:flux2:lora:civitai:2301918@2590116"
# SDXL 계열은 CLIP 토큰 77개까지만 읽는다 — FLUX 용 긴 화풍 문장을 그대로 붙이면 뒤가 잘린다(실측 118 토큰).
# 그래서 태그 모델에는 장면 문장만 남기고 화풍은 짧은 태그로 바꿔 붙인다.
COMPACT_STYLE = {
    base.BEBOP_STYLE: "cowboy bebop \\(series\\) style, 2000s anime film, semi-realistic anime, cinematic lighting, dramatic shadows, nightclub atmosphere, highly detailed, detailed painted background",
    base.KAWAJIRI_STYLE: "1990s OVA anime screencap, sharp angular faces, heavy black shadows, dark crimson palette",
    base.RETRO90S_STYLE: "1990s anime screencap, cel shading, bright clean colors, painted background",
    base.BALLROOM_STYLE: "romantic oil painting, warm golden light",
}


# 태그 모델(Animagine·Illustrious)은 자연어 장면을 잘못 읽는다 — 스모크 실측: "gaunt pale man with long silver hair" 가 여자로,
# 커플이 여자 둘로 나왔다. 그래서 묶음·장르별로 Danbooru 태그 장면을 따로 둔다. 없는 묶음은 tagify() 가 자연어를 그대로 줄인다.
# Animagine·Illustrious 는 Danbooru 로 학습돼 캐릭터 이름 태그를 안다(2026-10-02 사용자 요청 "캐릭터 그대로 살려서"). 작품 태그와
# 캐릭터 태그를 앞에 두고 외형 태그는 뒤에 보조로 둔다. 괄호는 \( \) 로 이스케이프(Animagine 4 권장 표기).
TAG_SCENES: dict[str, dict[str, str]] = {
    # 2026-10-02 5차: 참고 이미지 16장 분석 → 캐릭터 태그 + 외형 보조 태그. 짝: 룸바 스파이크+줄리아 / 탱고 빈센트+카테리나 / 스윙 스파이크+페이 / 바차타 비셔스+줄리아
    # 2026-10-03 사용자 결정: 네 장르 모두 스파이크 + 페이. LoRA 가 둘을 알아 얼굴이 흔들리지 않는다. 춤의 정의·유화 구도는 그대로.
    "bebop_spike_faye": {
        "samba": ("1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, "
                  "dark green hair, messy hair, navy suit, yellow shirt, necktie, tall, lanky, "
                  "blonde hair, long wavy hair, black hairband, blue eyes, red lips, big smile, laughing, yellow fringe dress, samba dress, "
                  "feathers, high heels, "
                  "ballroom samba, samba bounce, bouncing, hips rolling, arms wide open, energetic, joyful, carnival energy, motion, "
                  "only two people, couple centered, percussion instruments in blurred background, surdo drums, tambourine, out of focus band silhouettes, "
                  "dark ballroom with warm golden spotlights, confetti falling, golden sparkle, blurred crowd silhouettes, bokeh, polished floor reflection, "
                  "cowboy shot, faces clearly visible, detailed faces, depth of field, detailed background"),
        "dancesport": ("1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, dark green hair, messy hair, navy suit, yellow shirt, necktie, tall, lanky, blonde hair, long wavy hair, black hairband, blue eyes, long eyelashes, red lips, slight smile, red latin dress, fringe dress, high heels, "
                       "rumba, latin ballroom dance, standing apart, arms extended, fingertips touching, hip sway, longing gaze, eye contact, "
                       "only two people, couple centered, string instruments on empty chairs in blurred background, cello, music stands, out of focus, "
                       "dark grand ballroom, crystal chandelier above, candlelit, spotlight on couple, blurred crowd silhouettes, bokeh, polished floor reflection, red rose petals, "
                       "cowboy shot, faces clearly visible, detailed faces, depth of field, detailed background"),
        "tango": ("1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, dark green hair, messy hair, navy suit, yellow shirt, necktie, tall, lanky, blonde hair, long wavy hair, black hairband, blue eyes, long eyelashes, red lips, slight smile, black slit dress, red heels, "
                  "argentine tango, tango pose, chest to chest, close embrace, leg hook, gancho, leg wrapped around partner, upright posture, "
                  "intense gaze, "
                  "only two people, couple centered, bandoneon resting on a chair beside, scattered sheet music on floor, "
                  "dark candlelit tango hall, chandelier, deep shadows, warm amber glow, blurred crowd silhouettes, bokeh, polished floor reflection, "
                  "cowboy shot, faces clearly visible, detailed faces, depth of field, detailed background"),
        "swing": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, "
                  "dark green hair, messy hair, navy suit, yellow shirt, necktie, "
                  "purple hair, short hair, yellow hairband, green eyes, smirk, playful, yellow crop top, red cardigan, yellow shorts, suspenders, "
                  "lindy hop, jitterbug, partner dance, both dancing, holding one hand, kicking, mid-air, feet off the floor, laughing, "
                  "only two people, couple centered, brass instruments and double bass on a stage in blurred background, out of focus band silhouettes, music stands, "
                  "dark 1940s jazz club, neon sign glow, warm spotlight on couple, blurred crowd silhouettes, bokeh, polished wooden floor reflection, "
                  "cowboy shot, faces clearly visible, detailed faces, depth of field, detailed background"),
        "salsa_bachata": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, dark green hair, messy hair, navy suit, open collar, yellow shirt, purple hair, short hair, yellow hairband, green eyes, red lips, red backless dress, bare shoulders, "
                          "bachata, hips touching, pressed together, body wave, hand on waist, foreheads touching, intimate, "
                          "only two people, couple centered, conga drums beside, out of focus, "
                          "dark latin club at night, red neon glow, warm lamplight, blurred dancing crowd silhouettes, bokeh, polished floor reflection, "
                          "cowboy shot, faces clearly visible, detailed faces, depth of field, detailed background"),
    },
    # 2026-10-03 사용자 콜라주 기준 이미지(3열×2행: 스파이크·페이 스윙/댄스스포츠 · 빈센트·일렉트라 살사·바차타 · 줄리아·비셔스 탱고) 재현.
    # 글씨·프로필 썸네일 없이 그림만. 기준의 공통점: 반실사 유화 질감, 어두운 클럽, 한 색(파랑·빨강·금빛)이 지배하는 조명, 커플 클로즈 홀드의 역동적 자세.
    "bebop_collage": {
        "dancesport": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, "
                       "dark green hair, messy hair, navy suit, yellow shirt, loose necktie, tall, lanky, "
                       "purple hair, short hair, bob cut, yellow hairband, green eyes, red lips, red backless dress, halter dress, high slit, high heels, "
                       "ballroom dance, dancesport, facing each other, closed hold, holding hands, dance frame, hand on partner's back, hand on shoulder, bodies close, leaning, leg extended, dynamic pose, motion, intense eye contact, "
                       "only two people, couple centered, "
                       "dark jazz club at night, large window, blue night sky, city lights, neon sign, jazz band on stage in blurred background, out of focus musicians, "
                       "warm stage spotlight on couple, blue and amber lighting, blurred crowd silhouettes, bokeh, polished floor reflection, "
                       "full body, faces clearly visible, detailed faces, depth of field, detailed painted background"),
        "swing": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, "
                  "dark green hair, messy hair, navy suit, yellow shirt, loose necktie, tall, lanky, "
                  "purple hair, short hair, bob cut, yellow hairband, green eyes, red lips, red backless dress, flared skirt, high heels, "
                  "lindy hop, swing dance, partner dance, spinning, one hand connection, dress flaring with motion, dynamic pose, laughing, "
                  "only two people, couple centered, "
                  "dark jazz club at night, big band on stage in blurred background, large window, blue and purple lighting, "
                  "polished floor reflection, blurred crowd silhouettes, bokeh, "
                  "full body, faces clearly visible, detailed faces, depth of field, detailed painted background"),
        # 기준 캡처대로: 일렉트라는 금발 올림머리(원작은 짙은 갈색), 비셔스는 긴 흑발(원작은 은발)
        "salsa_bachata": ("1boy, 1girl, couple, vincent volaju, electra ovilo, cowboy bebop: tengoku no tobira, cowboy bebop, "
                          "tall man, long wavy black hair, stubble, sharp face, black coat, dark red shirt, "
                          "tan skin, blonde hair, curly hair, hair up, updo, red dress, bare back, gold belt, "
                          "bachata, salsa, hips pressed together, hand on waist, hand on shoulder, foreheads almost touching, intimate, rhythmic, "
                          "only two people, couple centered, "
                          "latin club at night, red neon sign, warm golden lamplight, red and gold lighting, blurred dancing crowd silhouettes, bokeh, polished floor reflection, "
                          "full body, faces clearly visible, detailed faces, depth of field, detailed painted background"),
        "tango": ("1boy, 1girl, couple, julia \\(cowboy bebop\\), vicious \\(cowboy bebop\\), cowboy bebop, "
                  "short wavy hair, red hair, crimson hair, dark red hair, blue eyes, red lips, black slit dress, bare back, black heels, "
                  "long black hair, pale skin, sharp face, cold eyes, black suit, white shirt, "
                  "argentine tango, close embrace, dance frame, chest to chest, holding hands, intense gaze, tension, "
                  "only two people, couple centered, "
                  "old grand hall, crystal chandelier, candlelight, deep shadows, warm amber glow, dark wood, blurred crowd silhouettes, bokeh, polished floor reflection, "
                  "full body, faces clearly visible, detailed faces, depth of field, detailed painted background"),
    },
    # 2026-10-03 2차 기준(세로 2:3 카드 4장, 비교 보드 화풍). 프롬프트 원본은 docs/prototype/prompts/bebop-cards-4-prompts.md
    "bebop_cards2": {
        "dancesport": "1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, dark green hair, messy hair, narrow eyes, navy suit, yellow shirt, loose black necktie, tall, lanky, black slit dress, black evening dress, bare back, blonde hair, long wavy hair, blue eyes, red lips, ballroom dance, rumba, close hold, facing each other, holding hands, hand on back, foreheads almost touching, whispering, longing gaze, tender, only two people, couple centered, palace ballroom, tall arched windows, moonlight streaming through window, silver blue moonlight, candlelight, golden candle glow, marble floor reflection, chandelier, deep shadows, cowboy shot, upper body and thighs, large figures filling the frame, faces clearly visible, detailed faces, depth of field, detailed painted background",
        "swing": "1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, dark green hair, messy hair, navy suit, yellow shirt, loose necktie, purple hair, short bob, yellow hairband, green eyes, red lips, red backless dress, flared skirt, high heels, lindy hop, swing dance, spinning, one hand connection, dress flaring with motion, dynamic pose, laughing, only two people, couple centered, dark jazz club at night, big band on stage in blurred background, blue and teal stage lighting, neon sign glow, polished floor reflection, blurred crowd silhouettes, bokeh, full body, faces clearly visible, detailed faces, depth of field, detailed painted background",
        "salsa_bachata": "1boy, 1girl, couple, vincent volaju, electra ovilo, cowboy bebop: tengoku no tobira, cowboy bebop, tall gaunt man, long wavy black hair, stubble, long black coat, dark red shirt, tan skin, dark brown hair, hair tied up, red dress, bare back, gold belt, bachata, salsa, hips pressed together, hand on waist, hand on shoulder, rhythmic weight shift, foreheads almost touching, intimate, only two people, couple centered, latin club at night, red neon sign, warm golden lamplight, red and gold lighting, blurred dancing crowd, bokeh, polished floor reflection, full body, faces clearly visible, detailed faces, depth of field, detailed painted background",
        "tango": "1boy, 1girl, couple, julia \\(cowboy bebop\\), vicious \\(cowboy bebop\\), cowboy bebop, blonde hair, long wavy hair, blue eyes, red lips, black slit dress, bare back, black heels, long silver hair, pale skin, sharp hollow face, cold eyes, black suit, white shirt, argentine tango, close embrace, clear dance frame, chest to chest, stable balance, intense gaze, tension, only two people, couple centered, old grand hall, crystal chandelier, candlelight, deep shadows, warm amber glow, dark wood, polished floor reflection, full body, faces clearly visible, detailed faces, depth of field, detailed painted background",
    },
    "bebop_cast2": {
        # 2026-10-03 최종(캡처 3장 기준): 인물→외형→춤 동작→유화 구도(커플 가운데, 악사 둘러앉음, 샹들리에, 금빛 안개, 바닥 반사).
        "samba": ("1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, official style, "
                  "dark green hair, messy hair, navy suit, yellow shirt, necktie, tall, lanky, "
                  "blonde hair, long wavy hair, black hairband, blue eyes, red lips, big smile, laughing, yellow fringe dress, samba dress, "
                  "feathers, high heels, "
                  "ballroom samba, samba bounce, bouncing, hips rolling, arms wide open, energetic, joyful, carnival energy, motion, "
                  "couple centered, percussion band seated around, surdo drums, tambourine, cuica, "
                  "bright sunlit ballroom, daylight through tall windows, warm sunshine, confetti, golden sparkle, polished floor reflection, "
                  "full body, detailed background"),
        "dancesport": ("1boy, 1girl, couple, spike spiegel, julia \\(cowboy bebop\\), cowboy bebop, official style, "
                       "dark green hair, messy hair, navy suit, yellow shirt, necktie, tall, lanky, "
                       "blonde hair, long wavy hair, black hairband, blue eyes, long eyelashes, red lips, slight smile, red latin dress, high heels, "
                       "rumba, latin ballroom dance, standing apart, arms extended, fingertips touching, hip sway, longing gaze, eye contact, "
                       "couple centered, string orchestra seated around the dance floor, violinists, cellist, music stands, "
                       "grand ballroom, crystal chandelier above, golden haze, warm glow, polished floor reflection, red rose petals, "
                       "full body, detailed background"),
        "tango": ("1boy, 1girl, couple, vincent volaju, katerina solensan, cowboy bebop, official style, "
                  "long curly grey hair, thick eyebrows, goatee, heavy-lidded eyes, intense stare, sharp jaw, gaunt, dark military coat, "
                  "dark skin, brown wavy hair, blue ribbon, long eyelashes, red lips, diamond dangle earrings, magenta slit dress, red heels, "
                  "argentine tango, tango pose, chest to chest, close embrace, leg hook, gancho, leg wrapped around partner, upright posture, "
                  "farewell, sorrowful, "
                  "couple centered, bandoneon player seated beside, accordion, scattered sheet music on floor, "
                  "night, under street lamp, cobblestone, rain, wet floor reflection, amber glow, golden haze, "
                  "full body, detailed background"),
        "swing": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, official style, "
                  "dark green hair, messy hair, navy suit, yellow shirt, necktie, "
                  "purple hair, short hair, yellow hairband, green eyes, smirk, playful, yellow crop top, red cardigan, yellow shorts, suspenders, "
                  "lindy hop, jitterbug, partner dance, both dancing, holding one hand, kicking, mid-air, feet off the floor, laughing, "
                  "couple centered, brass big band seated behind, trumpets, trombones, saxophones, double bass, music stands, "
                  "1940s dance hall, chandelier, warm golden spotlight, polished wooden floor reflection, golden haze, "
                  "full body, detailed background"),
        "salsa_bachata": ("1boy, 1girl, couple, vicious \\(cowboy bebop\\), julia \\(cowboy bebop\\), cowboy bebop, official style, "
                          "silver-grey hair, long hair, parted bangs, hair over one eye, sunken cheeks, sharp cheekbones, piercing gaze, pale skin, "
                          "black military coat, high collar, gold buttons, "
                          "blonde hair, long wavy hair, black hairband, blue eyes, red lips, slight smile, black turtleneck, black long coat, "
                          "bachata, hips touching, pressed together, body wave, hand on waist, foreheads touching, intimate, "
                          "couple centered, conga players seated beside, bongo, "
                          "night, warm lamplight, string lights, chandelier, golden haze, polished floor reflection, seaside town, "
                          "full body, detailed background"),
    },
    "bebop_cast": {
        "dancesport": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, official style, ballroom dance, waltz, "
                       "dance frame, holding hands, looking at each other, dark green hair, blue suit, purple hair, red dress, "
                       "ballgown, long gloves, ballroom, chandelier, full body"),
        "tango": ("1boy, 1girl, couple, vicious \\(cowboy bebop\\), julia \\(cowboy bebop\\), cowboy bebop, official style, tango, "
                  "dancing, close embrace, grey hair, long hair, black coat, blonde hair, wavy hair, red lips, black dress, "
                  "night, rain, cobblestone street, street lamp, full body"),
        "swing": ("1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, official style, swing dance, lindy hop, "
                  "jumping, kicking, holding hands, smile, dark green hair, blue suit, suspenders, purple hair, yellow dress, "
                  "1940s, ballroom, spotlight, big band, checkered floor, full body"),
        "salsa_bachata": ("1boy, 1girl, couple, vincent volaju, electra ovilo, cowboy bebop: tengoku no tobira, cowboy bebop, "
                          "official style, salsa, dancing, holding hands, spinning, black hair, ponytail, black coat, dark skin, "
                          "long hair, white dress, night, seaside, palm tree, string lights, conga drums, full body"),
    },
}


def tagify(prompt: str, style: str | None = None, genre: str | None = None) -> str:
    """자연어 프롬프트(장면 + 화풍 문장)를 태그 모델용으로 바꾼다: 품질 태그 + 장면(태그 사전이 있으면 그것) + 짧은 화풍 태그."""
    if style in TAG_SCENES and genre in TAG_SCENES[style]:
        style_tag = next((short for long, short in COMPACT_STYLE.items() if long in prompt), "anime screencap, cel shading")
        return f"{TAG_PREFIX}{TAG_SCENES[style][genre]}, {style_tag}"
    scene = prompt
    style_tag = "anime screencap, cel shading"
    for long, short in COMPACT_STYLE.items():
        if long in scene:
            scene = scene.replace(long, "").strip().rstrip(".").strip()
            style_tag = short
            break
    return f"{TAG_PREFIX}{scene}, {style_tag}"
TAG_NEGATIVE = ("lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, "
                "worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry, "
                "simple background, plain background, grey background, flat color, flat shading, 1990s anime screencap, poster, multiple views, duplicate, english text, logo, scar, blood, torn clothes, injury, playground swing, rope swing, chains, hearts, pink background, guitar, holding instrument, kneeling, sitting, hugging only, "
                "crowd, many people, extra people, 3boys, multiple boys, clone, duplicate person, deformed face, bad face, ugly face, small face, extra heads")
_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def http_get(url: str, headers: dict[str, str], timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_get_json(url: str, headers: dict[str, str], timeout: int = 120) -> dict:
    return json.loads(http_get(url, {"Accept": "application/json", **headers}, timeout))


# ───────────────────────── 제공처별 생성 함수 — (prompt, seed, env) -> bytes ─────────────────────────

def gen_flux2(prompt: str, seed: int, env: dict[str, str]) -> bytes:
    return base.gen_cloudflare_flux2(prompt, seed, env, use_reference=False)


def gen_pixai(prompt: str, seed: int, env: dict[str, str]) -> bytes:
    """PixAI v2: POST /v2/image/create → GET /v1/task/{id} 를 1.5초 간격으로 폴링 → outputs.mediaUrls[0] 내려받기.
    (문서: platform.pixai.art/en/docs — 2026-10-02 확인. 생성물은 영구 보관되지 않으니 바로 내려받는다.)"""
    key = env.get("PIXAI_API_KEY")
    if not key:
        raise SystemExit(f"pixai.env 에 PIXAI_API_KEY 가 필요하다 ({CONFIG_DIR / 'pixai.env'})")
    model_version = env.get("PIXAI_MODEL_VERSION_ID", "1983308862240288769")  # Tsubaki.2 — Tsubaki.3 는 모델 페이지 URL 의 ID 로 바꾼다
    headers = {"Authorization": f"Bearer {key}"}
    body = {"modelVersionId": model_version, "prompt": prompt, "negativePrompt": TAG_NEGATIVE,
            "aspectRatio": "1:1", "size": "1k", "seed": seed, "batchSize": 1, "promptHelper": "disable"}
    if env.get("PIXAI_MODE"):  # Tsubaki 전용: lite | standard | pro | ultra
        body["mode"] = env["PIXAI_MODE"]
    task = base.post_json("https://api.pixai.art/v2/image/create", body, headers)
    task_id = task["id"]
    for _ in range(200):  # 최대 5분
        time.sleep(1.5)
        task = http_get_json(f"https://api.pixai.art/v1/task/{task_id}", headers)
        status = task.get("status")
        if status == "completed":
            urls = (task.get("outputs") or {}).get("mediaUrls") or []
            if not urls:
                media = (task.get("outputs") or {}).get("mediaIds") or []
                urls = [f"https://api.pixai.art/v1/media/{m}/image" for m in media]
            return http_get(urls[0], headers)
        if status in ("failed", "cancelled"):
            raise RuntimeError(f"pixai 작업 {status}: {json.dumps(task)[:300]}")
    raise TimeoutError("pixai 작업이 5분 안에 끝나지 않았다")


def _civitai_fetch_image(data: dict) -> bytes:
    """recipes/imageGen 응답에서 첫 그림을 내려받는다. url 이 없으면 previewUrl 을 쓴다."""
    images = data.get("images") or []
    if not images:
        raise RuntimeError(f"civitai 응답에 그림이 없다: {json.dumps(data)[:300]}")
    url = images[0].get("url") or images[0].get("previewUrl")
    if not url:
        raise RuntimeError(f"civitai 그림 주소가 없다: {json.dumps(images[0])[:300]}")
    return http_get(url, {})


def _gen_civitai_flux2(loras: list[dict] | None = None):
    def gen(prompt: str, seed: int, env: dict[str, str]) -> bytes:
        """Civitai 오케스트레이션 · FLUX.2 [dev] + LoRA. **무료 API 호출(매일 받는 Blue Buzz) 범위에서만 쓴다**(2026-10-02 사용자 결정).
        로컬은 32B 라 8GB 로 불가능하고 Cloudflare 는 LoRA 입력이 없어 이 길뿐이다.
        경로는 `/v2/consumer/recipes/imageGen` — 입력을 바로 받아 결과를 돌려준다(2026-10-02 실측,
        `/v2/consumer/workflows` 는 400 'workflowTemplate field is required' 가 난다)."""
        key = env.get("CIVITAI_API_KEY")
        if not key:
            raise SystemExit(f"civitai.env 에 CIVITAI_API_KEY 가 필요하다 ({CONFIG_DIR / 'civitai.env'})")
        body = {"engine": "flux2", "model": "dev", "operation": "createImage", "prompt": prompt,
                "width": WIDTH, "height": HEIGHT, "seed": seed, "quantity": 1,
                "guidanceScale": 2.5, "numInferenceSteps": 28, "outputFormat": "jpeg",
                **({"loras": loras} if loras else {})}
        data = base.post_json("https://orchestration.civitai.com/v2/consumer/recipes/imageGen", body,
                              {"Authorization": f"Bearer {key}"}, timeout=900)
        return _civitai_fetch_image(data)
    return gen


def _gen_civitai(model_air: str):
    def gen(prompt: str, seed: int, env: dict[str, str]) -> bytes:
        """Civitai 오케스트레이션 · SDXL(comfy 엔진) 체크포인트를 AIR 로 지정해 생성한다. 무료 Buzz 범위에서만 쓴다."""
        key = env.get("CIVITAI_API_KEY")
        if not key:
            raise SystemExit(f"civitai.env 에 CIVITAI_API_KEY 가 필요하다 ({CONFIG_DIR / 'civitai.env'})")
        body = {"engine": "comfy", "ecosystem": "sdxl", "operation": "createImage",
                "model": model_air, "prompt": prompt, "negativePrompt": TAG_NEGATIVE,
                "width": 1024, "height": 1024, "steps": 28, "cfgScale": 6, "seed": seed, "quantity": 1,
                "sampler": "euler_ancestral", "scheduler": "normal", "clipSkip": 2, "outputFormat": "jpeg"}
        data = base.post_json("https://orchestration.civitai.com/v2/consumer/recipes/imageGen", body,
                              {"Authorization": f"Bearer {key}"}, timeout=900)
        return _civitai_fetch_image(data)
    return gen


# 이름 → (키 파일, 생성 함수, 설명). 키 파일이 없으면 그 모델은 건너뛴다.
def _gen_local(checkpoint: str, loras: list[dict] | None = None, prompt_prefix: str | None = None, extra_override: dict | None = None):
    def gen(prompt: str, seed: int, env: dict[str, str]) -> bytes:
        if prompt_prefix:  # Pony 계열: 점수 태그가 맨 앞에 와야 한다. 공통 품질 접두는 뺀다
            prompt = prompt_prefix + prompt.replace(TAG_PREFIX, "", 1)
        """로컬 서버(local-sd/server.py, A1111 호환 /sdapi/v1/txt2img). 체크포인트는 ~/models/sdxl/ 의 파일 이름.
        (Animagine XL 4.0: cagliostrolab/animagine-xl-4.0 · Illustrious XL 2.0: OnomaAIResearch/Illustrious-XL-v2.0 에서 받음)
        8GB VRAM 이라 서버가 모델을 하나씩 바꿔 올린다 — 로컬 모델 둘은 동시에 호출해도 서버 안에서 직렬로 돈다.
        loras 는 ~/models/sdxl/lora/ 의 파일 이름과 가중치. --lora-weight 로 가중치를 덮어쓸 수 있다."""
        url = env.get("LOCAL_SD_URL", "http://localhost:7860").rstrip("/")
        body = {"prompt": prompt, "negative_prompt": TAG_NEGATIVE, "width": WIDTH, "height": HEIGHT,
                **({"init_image": base64.b64encode(INIT_IMAGE.read_bytes()).decode(), "init_strength": INIT_STRENGTH} if INIT_IMAGE else {}),
                "steps": 35 if HQ else 28, "cfg_scale": 5 if HQ else 6, "seed": seed, "sampler_name": "DPM++ 2M Karras" if HQ else "Euler a", "batch_size": 1,
                **({"enable_hr": True, "hr_scale": HR_SCALE, "denoising_strength": 0.45, "hr_steps": 28} if HQ else {}),
                **({"override_settings_hr_lora": HR_LORA} if False else {}),
                "override_settings": {"sd_model_checkpoint": checkpoint, **(extra_override or {}),
                                      **({"attention_slicing": True} if ATTN_SLICING else {}),
                                      **({"offload_text_encoder": True} if OFFLOAD_TE else {}),
                                      **({"vae_tiling": True} if VAE_TILING else {}),
                                      **({"hr_lora_weight": HR_LORA} if HR_LORA is not None else {}),
                                      **({"ip_adapter": {"images": [base64.b64encode(r.read_bytes()).decode() for r in IP_REFS], "weight": IP_WEIGHT, "hr_weight": IP_HR_WEIGHT, "model": IP_MODEL}} if IP_REFS else {}),
                                      **({"loras": [{**l, "weight": LORA_WEIGHT_OVERRIDE if LORA_WEIGHT_OVERRIDE is not None else l.get("weight", 1.0)} for l in loras]} if loras else {})}}
        if INIT_MASK and INIT_IMAGE:
            # ① 마스크 자리 채우기: 고품질 없이 1024 에서 strength 1.0(마스크 안은 새로, 밖은 초안 그대로)
            fill = {k: v for k, v in body.items() if k not in ("enable_hr", "hr_scale", "denoising_strength", "hr_steps")}
            fill.update({"init_mask": base64.b64encode(INIT_MASK.read_bytes()).decode(), "init_strength": 1.0, "steps": 30})
            filled = base.post_json(f"{url}/sdapi/v1/txt2img", fill, {}, timeout=5400)["images"][0]
            body = {**body, "init_image": filled}  # ② 채운 그림을 초안으로 정상 경로(60% 재생성 + 고품질)
        data = base.post_json(f"{url}/sdapi/v1/txt2img", body, {}, timeout=5400)  # HQ 는 한 장 25분까지 걸리고 서버가 직렬이라 넉넉히
        return base64.b64decode(data["images"][0])
    return gen


MODELS: dict[str, tuple[str, object, str]] = {
    "flux2": ("cloudflare.env", gen_flux2, "FLUX.2 [dev] · Cloudflare Workers AI"),
    "pixai-tsubaki": ("pixai.env", gen_pixai, "PixAI Tsubaki (modelVersionId 는 pixai.env 로)"),
    "civitai-animagine": ("civitai.env", _gen_civitai("urn:air:sdxl:checkpoint:civitai:1188071@1337429"), "Animagine XL 4.0 · Civitai"),
    "civitai-illustrious": ("civitai.env", _gen_civitai("urn:air:sdxl:checkpoint:civitai:1369089@1546777"), "Illustrious XL 2.0 · Civitai"),
    "local-animagine": ("local-sd.env", _gen_local("animagine-xl-4.0.safetensors"), "Animagine XL 4.0 · 로컬 RTX 4060"),
    # Illustrious 는 diffusers 에 clip_skip 을 주면 깨진다(v2.0 은 노이즈, v0.1 은 줄무늬 — 2026-10-02 실측). 서버가 clip_skip 을
    # 안 주도록 고친 뒤 둘 다 정상. 최신판 v2.0 을 쓴다(v0.1 도 ~/models/sdxl/ 에 있음).
    "local-illustrious": ("local-sd.env", _gen_local("Illustrious-XL-v2.0.safetensors"), "Illustrious XL 2.0 · 로컬 RTX 4060"),
    # Cowboy Bebop LoRA(Civitai 940639 "the Movie / Characters and Style", Illustrious 학습, 트리거 spiegel·v4l3nt1ne·ovirowa) — ~/models/sdxl/lora/
    # 2026-10-02 사용자 요청 "Animagine + Anime Style LoRA vs FLUX.2 + LoRA" — FLUX.2 쪽은 Civitai 키가 있어야 한다(로컬 불가, Cloudflare 는 LoRA 미지원).
    # FLUX.2 [dev] + 애니 스타일 LoRA — Civitai 호스팅(키 필요). LoRA 는 Civitai 2301918 "flux-2-trainer-v2_2D_Cel"(Flux.2 D, 2D 셀 화풍).
    "civitai-flux2-anime-lora": ("civitai.env", _gen_civitai_flux2([{"air": FLUX2_ANIME_LORA_AIR, "strength": 0.8}]),
                                 "FLUX.2 [dev] + 2D Cel 애니 LoRA · Civitai"),
    "local-animagine-bebop-lora": ("local-sd.env", _gen_local("animagine-xl-4.0.safetensors",
                                   [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": 0.8}]), "Animagine XL 4.0 + Cowboy Bebop LoRA"),
    # Pony Diffusion V6 XL(2026-10-03 추가, Civitai 290640 가중치 공개·로컬): 점수 태그 + source_anime 접두, clip skip 2(diffusers 1). 비밥 캐릭터 태그는 거의 모른다 → 기준 칸 35% 다듬기 용도
    "local-pony-v6": ("local-sd.env", _gen_local("ponyDiffusionV6XL.safetensors", None,
                      prompt_prefix="score_9, score_8_up, score_7_up, source_anime, rating_safe, ", extra_override={"diffusers_clip_skip": 1}), "Pony Diffusion V6 XL · 로컬 RTX 4060"),
    # 모델 3 대체재(2026-10-03): "LAnime Style LoRA" 파일이 없어, 폴더에 있던 비밥 화풍 LoRA(Illustrious 학습)를 Animagine 에 얹는다. C 설정.
    "local-animagine-bebop-style-lora": ("local-sd.env", _gen_local("animagine-xl-4.0.safetensors",
                                         [{"name": "cowboy-bebop-style-illustriousXL.safetensors", "weight": 0.8}]), "Animagine XL 4.0 + Cowboy Bebop Style LoRA(화풍)"),
    "local-pony-v6-bebop-lora": ("local-sd.env", _gen_local("ponyDiffusionV6XL.safetensors", [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": 0.8}],
                                 prompt_prefix="score_9, score_8_up, score_7_up, source_anime, rating_safe, ", extra_override={"diffusers_clip_skip": 1}), "Pony V6 XL + Cowboy Bebop LoRA(C 설정)"),
    "local-illustrious-bebop-lora": ("local-sd.env", _gen_local("Illustrious-XL-v2.0.safetensors",
                                     [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": 0.8}]), "Illustrious XL 2.0 + Cowboy Bebop LoRA"),
}


def next_run_id() -> str:
    today = dt.date.today().isoformat()
    n = sum(1 for p in COMPARE_DIR.glob(f"{today}-*") if p.is_dir()) + 1
    return f"{today}-{n:03d}"


def burn_label(path: Path, label: str) -> bool:
    """그림 왼쪽 위에 모델 이름을 굽는다. Pillow 가 없으면 False (비교 페이지가 CSS 라벨로 대신한다)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    im = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(im, "RGBA")
    size = max(18, im.width // 28)
    font = None
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"):
        if Path(f).exists():
            font = ImageFont.truetype(f, size)
            break
    font = font or ImageFont.load_default()
    pad = size // 2
    box = draw.textbbox((0, 0), label, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.rectangle([0, 0, w + pad * 2, h + pad * 2], fill=(0, 0, 0, 170))
    draw.text((pad, pad - box[1]), label, font=font, fill=(255, 255, 255, 255))
    im.save(path, "JPEG", quality=92)
    return True


def check(models: list[str]) -> int:
    """키 파일과 인증만 확인한다. 뉴런·크레딧·Buzz 를 쓰지 않는다(Civitai 는 whatif=true 로 견적만)."""
    rc = 0
    for name in models:
        env_name, _, desc = MODELS[name]
        env = base.read_env(env_name)
        if not env:
            print(f"[{name}] 키 파일 없음 → 건너뜀: {CONFIG_DIR / env_name}")
            continue
        try:
            if name == "flux2":
                rc |= base.check_cloudflare(env)
            elif name == "pixai-tsubaki":
                http_get_json("https://api.pixai.art/v1/task/0", {"Authorization": f"Bearer {env['PIXAI_API_KEY']}"})
                print(f"[{name}] 인증 OK")
            elif name.startswith("civitai"):
                headers = {"Authorization": f"Bearer {env['CIVITAI_API_KEY']}"}
                if name == "civitai-flux2-anime-lora":
                    body = {"engine": "flux2", "model": "dev", "operation": "createImage", "prompt": "test",
                            "width": 1024, "height": 1024, "numInferenceSteps": 28, "quantity": 1,
                            "loras": [{"air": FLUX2_ANIME_LORA_AIR, "strength": 0.8}]}
                else:
                    air = "urn:air:sdxl:checkpoint:civitai:1188071@1337429" if name.endswith("animagine") else "urn:air:sdxl:checkpoint:civitai:1369089@1546777"
                    body = {"engine": "comfy", "ecosystem": "sdxl", "operation": "createImage", "model": air,
                            "prompt": "test", "width": 1024, "height": 1024, "steps": 28, "quantity": 1}
                est = base.post_json("https://orchestration.civitai.com/v2/consumer/recipes/imageGen?whatif=true", body, headers)
                print(f"[{name}] 인증 OK · whatif 응답 {json.dumps(est)[:160]}")
            elif name.startswith("local-"):
                models = http_get_json(env.get("LOCAL_SD_URL", "http://localhost:7860").rstrip("/") + "/sdapi/v1/sd-models", {})
                print(f"[{name}] 서버 응답 OK · 체크포인트 {[m['title'] for m in models]}")
        except urllib.error.HTTPError as e:
            body = e.read()[:200]
            if name == "pixai-tsubaki" and e.code == 404:
                print(f"[{name}] 인증 OK (존재하지 않는 작업 조회가 404 — 키는 통과)")
            else:
                print(f"[{name}] HTTP {e.code} {body!r}", file=sys.stderr); rc = 1
        except Exception as e:  # noqa: BLE001 — 점검용이라 종류를 가리지 않고 보여 준다
            print(f"[{name}] 실패: {e}", file=sys.stderr); rc = 1
    return rc


TAG_MODELS = ("civitai-animagine", "civitai-illustrious", "local-animagine", "local-illustrious",
              "local-animagine-bebop-lora", "local-illustrious-bebop-lora", "local-pony-v6", "local-pony-v6-bebop-lora", "local-animagine-bebop-style-lora")


def run_one(name: str, genre: str, prompt: str, seed: int, out_dir: Path, retries: int, style: str | None = None,
            label: bool = True, flat: bool = False) -> tuple[str, str, str]:
    env_name, gen, desc = MODELS[name]
    env = base.read_env(env_name)
    if name in TAG_MODELS:
        prompt = tagify(prompt, style, genre)
        if name.endswith("-bebop-lora"):  # LoRA 트리거 단어(작성자 안내): 스파이크 spiegel · 페이 v4l3nt1ne · 일렉트라 ovirowa
            sf = "spiegel, yellow shirt, necktie, v4l3nt1ne, hairband"
            table = {"bebop_cast2": {"dancesport": "spiegel, yellow shirt, necktie, suit", "swing": sf},
                     "bebop_spike_faye": {"dancesport": "spiegel, yellow shirt, necktie, suit", "samba": "spiegel, yellow shirt, necktie, suit", "tango": "spiegel, yellow shirt, necktie, suit", "swing": sf, "salsa_bachata": sf},
                     "bebop_collage": {"dancesport": sf, "swing": sf, "salsa_bachata": "ovirowa, choker", "tango": ""},
                     "bebop_cards2": {"dancesport": "spiegel, yellow shirt, necktie, suit", "swing": sf, "salsa_bachata": "ovirowa", "tango": ""}}
            default = {"dancesport": "spiegel, yellow shirt, necktie, suit, v4l3nt1ne, hairband",
                       "swing": "spiegel, yellow shirt, necktie, v4l3nt1ne, hairband",
                       "salsa_bachata": "ovirowa, choker", "tango": ""}
            trig = table.get(style, default).get(genre, "")
            if trig:
                prompt = prompt.replace(TAG_PREFIX, TAG_PREFIX + trig + ", ", 1)
    out = (out_dir if flat else out_dir / name) / f"{genre}.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(retries + 1):
        t0 = time.time()
        try:
            raw = gen(prompt, seed + attempt * 1000, env)
        except urllib.error.HTTPError as e:
            return name, genre, f"HTTP {e.code} {e.read()[:160]!r}"
        except Exception as e:  # noqa: BLE001 — 한 모델의 실패가 다른 모델을 막지 않게 한다
            return name, genre, f"실패: {e}"
        if len(raw) < base.MIN_BYTES:
            log(f"  {name}/{genre}: {len(raw)} bytes — 검은 화면, seed 바꿔 재시도 ({attempt + 1}/{retries})")
            continue
        out.write_bytes(raw)
        if label:
            burn_label(out, name)
        return name, genre, f"OK {len(raw):,} bytes · {time.time() - t0:.0f}s"
    return name, genre, "실패: 재시도 소진"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--style", choices=base.STYLES, default="bebop_cast", help="프롬프트 묶음(gen_genre_images.py 의 STYLES)")
    ap.add_argument("--model", choices=MODELS, action="append", help="이 모델만 (여러 번). 기본은 키 파일이 있는 모델 전부")
    ap.add_argument("--only", choices=sorted({g for jobs in base.STYLES.values() for g in jobs}), action="append", help="이 장르만 (여러 번)")
    ap.add_argument("--check", action="store_true", help="키·인증만 확인하고 끝낸다")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--retries", type=int, default=1)
    ap.add_argument("--seed-offset", type=int, default=0)
    ap.add_argument("--run", help="실행ID 를 직접 지정(기본 YYYY-MM-DD-NNN 자동)")
    ap.add_argument("--no-label", action="store_true", help="그림에 모델 이름을 굽지 않는다(채택한 세트를 카드로 쓸 때)")
    ap.add_argument("--hr-lora-weight", type=float, help="고품질 2단계(1536)에만 적용할 LoRA 세기. 0 이면 2단계에서 LoRA 끔. 기본은 1단계와 동일")
    ap.add_argument("--ip-ref", type=Path, action="append", help="IP-Adapter 참조 이미지(여러 번). 로컬 모델만. 캐릭터 외형을 사진으로 고정한다")
    ap.add_argument("--ip-weight", type=float, default=0.6, help="IP-Adapter 1단계 세기(기본 0.6)")
    ap.add_argument("--ip-hr-weight", type=float, default=0.0, help="IP-Adapter 2단계(1536) 세기(기본 0)")
    ap.add_argument("--hr-scale", type=float, default=1.5, help="고품질 2단계 배율(기본 1.5 = 1536). VRAM 이 넘치면 1.375(1408)·1.25(1280)")
    ap.add_argument("--width", type=int, default=1024); ap.add_argument("--height", type=int, default=1024, help="1단계 해상도. 2:3 카드는 832 1248")
    ap.add_argument("--vae-tiling", action="store_true", help="1단계 디코드부터 VAE 타일링(1024 디코드 피크를 낮춘다)")
    ap.add_argument("--offload-te", action="store_true", help="글 인코더를 벡터 추출 뒤 CPU 로 내려 VRAM 약 1.4GB 를 비운다")
    ap.add_argument("--attn-slicing", action="store_true", help="어텐션 슬라이싱(VRAM 피크를 낮춤, 조금 느림)")
    ap.add_argument("--init-image", type=Path, help="img2img 초안(로컬 모델만). 기준 그림의 구도·조명을 가져온다")
    ap.add_argument("--init-mask", type=Path, help="초안에서 새로 그릴 자리(흰색) 마스크. 글씨·인셋을 지우고 그림이 이어지게 채운다")
    ap.add_argument("--init-strength", type=float, default=0.6, help="초안을 얼마나 다시 그리나(0.6 = 60%%). 낮을수록 원본에 가깝다")
    ap.add_argument("--ip-model", choices=["plus", "plus-face"], default="plus", help="plus=외형 전체, plus-face=얼굴 위주")
    ap.add_argument("--hq", action="store_true", help="고품질: DPM++ 2M Karras 35 steps + 1536 고해상도 2단계(로컬 모델만, 한 장 6~9분)")
    ap.add_argument("--lora-weight", type=float, help="*-lora 모델의 LoRA 가중치를 이 값으로 덮어쓴다(기본 0.8). 0.4~0.5 가 춤 장면에 맞다")
    ap.add_argument("--out-dir", type=Path, help="결과 폴더를 직접 지정(기본 assets/genres/compare/{실행ID})")
    args = ap.parse_args()
    global LORA_WEIGHT_OVERRIDE, HQ, HR_LORA, IP_REFS, IP_WEIGHT, IP_HR_WEIGHT, IP_MODEL
    LORA_WEIGHT_OVERRIDE = args.lora_weight
    IP_REFS, IP_WEIGHT, IP_HR_WEIGHT, IP_MODEL = (args.ip_ref or []), args.ip_weight, args.ip_hr_weight, args.ip_model
    global INIT_IMAGE, INIT_STRENGTH
    INIT_IMAGE, INIT_STRENGTH = args.init_image, args.init_strength
    global INIT_MASK
    INIT_MASK = args.init_mask
    if INIT_MASK and not INIT_MASK.exists():
        print(f"마스크 없음: {INIT_MASK}", file=sys.stderr); return 2
    global HR_SCALE, ATTN_SLICING
    HR_SCALE, ATTN_SLICING = args.hr_scale, args.attn_slicing
    global OFFLOAD_TE
    OFFLOAD_TE = args.offload_te
    global VAE_TILING
    VAE_TILING = args.vae_tiling
    global WIDTH, HEIGHT
    WIDTH, HEIGHT = args.width, args.height
    if INIT_IMAGE and not INIT_IMAGE.exists():
        print(f"초안 이미지 없음: {INIT_IMAGE}", file=sys.stderr); return 2
    for r in IP_REFS:
        if not r.exists():
            print(f"참조 이미지 없음: {r}", file=sys.stderr); return 2
    HQ = args.hq
    HR_LORA = args.hr_lora_weight

    if args.check:
        return check(args.model or list(MODELS))
    models = args.model or [m for m in MODELS if base.read_env(MODELS[m][0])]
    if not models:
        print("키 파일이 있는 모델이 하나도 없다. ~/.config/kdance/ 에 pixai.env · civitai.env · cloudflare.env 중 하나 이상을 둔다.", file=sys.stderr)
        return 2
    jobs = base.STYLES[args.style]
    genres = args.only or list(jobs)
    run_id = args.run or next_run_id()
    out_dir = args.out_dir or (COMPARE_DIR / run_id)
    flat = args.out_dir is not None  # 직접 지정한 폴더면 모델 하위 폴더 없이 {장르}.jpg 로
    print(f"실행ID {run_id} · 모델 {len(models)}개 × 장르 {len(genres)}개 = {len(models) * len(genres)}장 동시 실행 → {out_dir}")

    tasks = [(m, g, jobs[g][0], jobs[g][1] + args.seed_offset) for m in models for g in genres]
    if args.dry_run:
        for m, g, prompt, seed in tasks:
            shown = tagify(prompt, args.style, g) if m in TAG_MODELS else prompt
            print(f"[dry-run] {m:<20} {g:<14} seed={seed}  {shown[:90]}…")
        return 0
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "run.json").write_text(json.dumps({"run": run_id, "style": args.style, "models": models, "genres": genres,
                                                    "started": dt.datetime.now().isoformat(timespec="seconds")}, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = 0
    with ThreadPoolExecutor(max_workers=len(tasks)) as pool:
        for name, genre, msg in pool.map(lambda t: run_one(t[0], t[1], t[2], t[3], out_dir, args.retries, args.style, not args.no_label, flat), tasks):
            log(f"  {name:<20} {genre:<14} {msg}")
            failed += not msg.startswith("OK")
    print(f"끝. 실패 {failed}/{len(tasks)} · 비교 페이지: python3 docs/prototype/build_multi_compare.py --run {run_id}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
