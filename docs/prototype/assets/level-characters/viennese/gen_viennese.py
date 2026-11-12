"""스탠다드 비엔나왈츠 레벨 성장 캐릭터 — 삼바 샘플(docs/prototype/assets/level-characters/samba) 레시피를 스윙 카드 콘셉트로. 원본 설명:
삼바 레벨 성장 캐릭터 2차 — 사용자 참고 이미지(한낮 리우 카니발, 원작 의상, 선명한 셀 채색) 기준.
모델 Animagine XL 4.0 + Cowboy Bebop LoRA. 사용: python gen_samba_v2.py [--hq] [--only=m_l01,...]
"""
import base64, json, sys, time, urllib.request
from pathlib import Path

HQ = "--hq" in sys.argv
SEED_BUMP = int(next((a.split("=",1)[1] for a in sys.argv if a.startswith("--bump=")), "0"))
CKPT = next((a.split("=",1)[1] for a in sys.argv if a.startswith("--ckpt=")), "animagine-xl-4.0.safetensors")
OUT = Path(__file__).parent / next((a.split("=",1)[1] for a in sys.argv if a.startswith("--out=")), "viennese_out" if HQ else "viennese_out_std")
OUT.mkdir(exist_ok=True)
ONLY = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--only=")), None)

PREFIX = ("masterpiece, high score, great score, absurdres, official art, cowboy bebop, anime coloring, cel shading, "
          "sharp clean lineart, vibrant saturated colors, highly detailed, detailed face, detailed eyes, warm golden light, sparkling light, ")
SCENE = ("inside the grand ballroom of an austrian imperial palace in vienna, hofburg palace ballroom, white and gold baroque walls, "
         "huge crystal chandeliers, tall arched windows, gilded columns, red velvet drapes, red rose petals falling, polished parquet dance floor with reflections, "
         "waltzing couples in ball gowns blurred in background, viennese opera ball, warm golden light, shallow depth of field")
SPIKE = "solo, 1boy, male focus, spike spiegel, spiegel, dark green hair, fluffy messy hair, brown eyes, "
FAYE = "solo, 1girl, faye valentine, v4l3nt1ne, dark purple hair, short bob, yellow hairband, green eyes, "
NEG = ("lowres, bad anatomy, bad hands, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, low score, "
       "bad score, average score, jpeg artifacts, signature, watermark, username, blurry, text, english text, banner text, sign, logo, "
       "multiple views, duplicate, extra people in foreground, 2girls, 2boys, deformed face, extra heads, nsfw, "
       "daytime, outdoors, holding instrument, playing instrument, musical instrument, double bass, cello, violin, trumpet, guitar, saxophone, holding doll, stuffed toy, white dress, gold dress, yellow dress, leotard, pink hair, strapless, off-shoulder, miniskirt, crop top, tied shirt, slip dress, nightgown, holding pillow, holding bag, yellow collar, yellow shirt, cravat, ascot, cape, military uniform, epaulettes, crouching, holding object, holding orb, holding ball, white trousers, cluttered background, tiny figure, far away, small character, crowd in foreground, sportswear, jersey, soccer uniform, t-shirt, sweater, shorts, casual clothes, hawaiian shirt, flag on clothing, brazil flag print")
CHILD_NEG = (", cleavage, navel, midriff, bare shoulders, revealing clothes, swimsuit, bikini, crop top, underwear, makeup, lipstick, "
             "mature female, adult, large breasts, miniskirt, short skirt, thighs, bare legs")

# (키, 라벨, 나이 태그, 스파이크 의상·동작, 페이 의상·동작, LoRA, 아이 여부, seed)
STAGES = [
    ("l01", "0~1 입문 · 아기",
     "baby, infant, 1 year old, aged down, chubby cheeks, big round eyes, baby bottle in mouth, holding baby bottle with both hands, sitting",
     "tiny black tailcoat romper, tiny white bow tie, happy",
     "tiny red tulle baby dress with puffy short sleeves and small roses, red rose hair clip, dark purple hair, happy", 0.25, True, 5101),
    ("l23", "2~3 초급 · 초등학생",
     "child, aged down, 8 years old, small body, big grin",
     "kids ballroom practice wear, white shirt, black waistcoat, black bow tie, black trousers, ballroom shoes, basic waltz box step, arms in ballroom frame",
     "kids crimson red ballroom dress, red long sleeves, knee-length red tulle skirt with small roses, red rose hair clip, ballroom shoes, basic waltz step, arms in ballroom frame", 0.35, True, 5202),
    ("l45", "4~5 중급 · 중고생",
     "teenager, 15 years old, aged down, slim, youthful face, confident smile",
     "junior standard ballroom tailsuit, short black tailcoat, white waistcoat, white shirt, white bow tie, black trousers, ballroom shoes, standing on the ballroom floor, elegant upright waltz posture, arms raised in ballroom hold frame",
     "modest crimson red standard ballroom gown, red long sleeves, high neckline, floor-length flowing red skirt, red rose hair clip, natural turn, skirt flowing, arms in ballroom frame", 0.45, True, 5303),
    ("l67", "6~7 중급 · 대학생",
     "young man, 20 years old, tall, lanky, confident smile",
     "white tie and tails, black ballroom tailcoat with long tails, white waistcoat, white wing collar shirt, white bow tie, ballroom shoes, viennese waltz turn, upright posture, arms raised in ballroom hold frame, coattails swinging",
     "young woman, 20 years old, joyful smile, crimson red ballroom gown covered in red roses, fitted red bodice with sleeves, floor-length voluminous red skirt, red rose in hair, viennese waltz spin, gown swirling wide", 0.55, False, 5404),
    ("l89", "8~9 고급 · 30대",
     "aged up, adult man, 30s, mature, sharp jawline, light stubble, cool smile",
     "white tie and tails, black ballroom tailcoat with satin lapels and long tails, white waistcoat, white wing collar shirt, white bow tie, white gloves, elegant ballroom pose, chest lifted, arms raised in ballroom hold frame",
     "aged up, adult woman, 30s, mature beauty, red lips, voluminous crimson rose ballroom gown, red chiffon floats on wrists, red rose in hair, dramatic lean back, arched back, arm extended", 0.6, False, 5505),
    ("l10", "10 고급 · 40대 귀족",
     "aged up, middle-aged man, 45 years old, neatly trimmed short beard, grey temples, crow's feet, aristocratic, distinguished, noble bearing, gentle confident smile",
     "aristocratic white tie and tails, black ballroom tailcoat with gold embroidery and long tails, white waistcoat, white wing collar shirt, white bow tie, white gloves, imperial medal on chest, elegant waltz hold frame, upright regal posture",
     "aged up, middle-aged woman, 45 years old, elegant mature beauty, aristocratic, noble bearing, graceful smile, viennese opera ball debut of roses, voluminous floor-length crimson ballroom gown made of layered red rose petals and red roses, rose petal skirt flowing, red rose hair ornament, ruby jewelry, red chiffon floats, elegant oversway, arched back, regal", 0.4, False, 5606),
]

def post(body):
    req = urllib.request.Request("http://localhost:7860/sdapi/v1/txt2img", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5400) as r:
        return json.loads(r.read())

def main():
    jobs = []
    for key, label, age, spike, faye, lora, child, seed in STAGES:
        for sex, base_tags, outfit in (("m", SPIKE, spike), ("f", FAYE, faye)):
            name = f"{sex}_{key}"
            if ONLY and name not in ONLY:
                continue
            age_tags = (age + ", ") if (sex == "m" or child) else ""
            if child and "--younger" in sys.argv:  # 남녀 모두 — 2026-10-05 사용자: 스탠다드 아기 스파이크 느낌  # 2026-10-05 사용자 요청: 어린 단계 페이를 더 아이처럼
                age_tags += {"l01": "very young, small toddler body, ", "l23": "small child, child proportions, large head, short limbs, petite, ",
                             "l45": "young teen, petite, small frame, childlike face, "}.get(key, "")
            frame = ("full body, whole body visible from head to shoes, standing on the parade avenue, medium shot distance, samba pose, one arm raised high, other arm extended to the side, hips swaying"
                     if "--fullbody" in sys.argv else "cowboy shot, large figure filling the frame")  # 2026-10-05: 페이 중고생을 스파이크 중고생 구도에 맞춤
            prompt = f"{PREFIX}{base_tags}{age_tags}{outfit}, {frame}, face clearly visible, looking at viewer, {SCENE}"
            neg = NEG + (CHILD_NEG if child else "") + (", mature body, tall, long legs, curvy, adult proportions" if (child and "--younger" in sys.argv) else "") + (", leotard, bikini, bare legs, thighs, navel, cleavage" if key == "l10" and sex == "f" else "") + (", 1girl, female, breasts, feathers, feather wings, wings, headdress, yellow shirt, blue suit, navy suit, necktie" if sex == "m" else "")
            lora = {("f","l45"):0.12, ("f","l10"):0.3, ("m","l10"):0.4, ("m","l01"):0.25, ("f","l01"):0.25}.get((sex,key), lora)
            if (sex, key) == ("f", "l45"): neg += ", bikini top, bra, shorts, short shorts, belly"
            if key == "l01": neg += ", ball, toy, cup"
            jobs.append((name, label, prompt, neg, lora, seed + (7 if (sex,key) in (("f","l10"),("m","l10"),("m","l01")) else 0) + SEED_BUMP))
    for i, (name, label, prompt, neg, lora, seed) in enumerate(jobs, 1):
        t = time.time()
        body = {"prompt": prompt, "negative_prompt": neg, "width": 832, "height": 1216, "seed": seed,
                "steps": 35 if HQ else 28, "cfg_scale": 5 if HQ else 6, "sampler_name": "DPM++ 2M Karras" if HQ else "Euler a", "batch_size": 1,
                **({"enable_hr": True, "hr_scale": 1.5, "denoising_strength": 0.4, "hr_steps": 24} if HQ else {}),
                "override_settings": {"sd_model_checkpoint": CKPT, "offload_text_encoder": True, "vae_tiling": True,
                                      "loras": [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": lora}]}}
        img = base64.b64decode(post(body)["images"][0])
        (OUT / f"{name}.png").write_bytes(img)
        (OUT / f"{name}.txt").write_text(f"{label}\nseed={seed} lora={lora} hq={HQ}\n{prompt}\nNEG: {neg}\n", encoding="utf-8")
        print(f"[{i}/{len(jobs)}] {name} {label} {time.time()-t:.0f}s", flush=True)

if __name__ == "__main__":
    main()
