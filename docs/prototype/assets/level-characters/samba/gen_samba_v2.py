"""삼바 레벨 성장 캐릭터 2차 — 사용자 참고 이미지(한낮 리우 카니발, 원작 의상, 선명한 셀 채색) 기준.
모델 Animagine XL 4.0 + Cowboy Bebop LoRA. 사용: python gen_samba_v2.py [--hq] [--only=m_l01,...]
"""
import base64, json, sys, time, urllib.request
from pathlib import Path

HQ = "--hq" in sys.argv
SEED_BUMP = int(next((a.split("=",1)[1] for a in sys.argv if a.startswith("--bump=")), "0"))
CKPT = next((a.split("=",1)[1] for a in sys.argv if a.startswith("--ckpt=")), "animagine-xl-4.0.safetensors")
OUT = Path(__file__).parent / next((a.split("=",1)[1] for a in sys.argv if a.startswith("--out=")), "out_anim_hq" if HQ else "out_anim")
OUT.mkdir(exist_ok=True)
ONLY = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--only=")), None)

PREFIX = ("masterpiece, high score, great score, absurdres, official art, cowboy bebop, anime coloring, cel shading, "
          "sharp clean lineart, vibrant saturated colors, highly detailed, detailed face, detailed eyes, bright daylight, ")
SCENE = ("rio de janeiro carnival parade, sambadrome, daytime, bright sunlight, blue sky, white clouds, "
         "christ the redeemer statue on mountain in background, crowded grandstands, green yellow and blue feathers, "
         " colorful confetti, samba drummers blurred in background, palm trees, heavily blurred background, bokeh, shallow depth of field")
SPIKE = "solo, 1boy, male focus, spike spiegel, spiegel, dark green hair, fluffy messy hair, brown eyes, "
FAYE = "solo, 1girl, faye valentine, v4l3nt1ne, dark purple hair, short bob, yellow hairband, green eyes, "
NEG = ("lowres, bad anatomy, bad hands, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, low score, "
       "bad score, average score, jpeg artifacts, signature, watermark, username, blurry, text, english text, banner text, sign, logo, "
       "multiple views, duplicate, extra people in foreground, 2girls, 2boys, deformed face, extra heads, nsfw, "
       "night, dark, nightclub, cluttered background, tiny figure, far away, small character, crowd in foreground, sportswear, jersey, soccer uniform, t-shirt, sweater, shorts, casual clothes, hawaiian shirt, flag on clothing, brazil flag print")
CHILD_NEG = (", cleavage, navel, midriff, bare shoulders, revealing clothes, swimsuit, bikini, crop top, underwear, makeup, lipstick, "
             "mature female, adult, large breasts, miniskirt, short skirt, thighs, bare legs")

# (키, 라벨, 나이 태그, 스파이크 의상·동작, 페이 의상·동작, LoRA, 아이 여부, seed)
STAGES = [
    ("l01", "0~1 입문 · 아기",
     "baby, infant, 1 year old, aged down, chubby cheeks, big round eyes, baby bottle in mouth, holding baby bottle with both hands, sitting",
     "tiny gold and green samba romper with ruffled sleeves and sequin trim, tiny white bow tie, tiny dance shoes, happy",
     "tiny yellow ruffle dress, small green feather headband, bouncing to the samba drums, happy", 0.35, True, 111),
    ("l23", "2~3 초급 · 초등학생",
     "child, aged down, 8 years old, small body, big grin",
     "boys latin dance competition costume, black satin shirt with gold sequin trim, black latin dance trousers, latin dance shoes, latin dance pose, samba step, arms extended elegantly",
     "girls latin dance competition dress, yellow sequined dress with fringe skirt, long sleeves, knee-length, latin dance shoes, latin dance pose, samba step, arms extended elegantly", 0.35, True, 222),
    ("l45", "4~5 중급 · 중고생",
     "teenager, 15 years old, aged down, slim, youthful face, confident smile",
     "junior dancesport latin costume, black satin shirt with green and gold sequins, fitted black latin trousers, latin dance shoes, latin dance pose, samba bounce, arms extended elegantly",
     "junior dancesport latin dress, green and gold sequined fringe dress, long sleeves, high neckline, knee-length fringe skirt, latin dance shoes, latin dance pose, samba bounce, arms extended elegantly", 0.45, True, 343),
    ("l67", "6~7 중급 · 대학생",
     "young man, 20 years old, tall, lanky, cocky grin",
     "emerald satin latin shirt with open collar and gold sequin trim, high-waisted black latin trousers, latin dance shoes, samba walk, holding out hand, dynamic pose",
     "young woman, 20 years old, cheerful laugh, sequined green and gold carnival top, feathered skirt, feather headdress, samba walk, arm raised, dynamic pose", 0.55, False, 444),
    ("l89", "8~9 고급 · 30대",
     "aged up, adult man, 30s, mature, sharp jawline, light stubble, cool half smile",
     "golden yellow sequined latin shirt with ruffled sleeves and green trim matching a samba partner, high-waisted white latin trousers, gold belt, broad shoulders, powerful samba pose, arm extended, leaning",
     "aged up, adult woman, 30s, mature beauty, confident smile, golden sequined carnival costume, large green yellow blue feather headdress, feather back piece, gold armlets, powerful samba pose, arm raised high", 0.6, False, 555),
    ("l10", "10 고급 · 40대 귀족",
     "aged up, middle-aged man, 45 years old, neatly trimmed short beard, grey temples, crow's feet, aristocratic, distinguished, noble bearing, gentle confident smile",
     "aristocratic black latin dance jacket with gold embroidery, emerald brooch, white gloves, fitted latin trousers, elegant samba pose, regal",
     "aged up, middle-aged woman, 45 years old, elegant mature beauty, aristocratic, noble bearing, graceful smile, carnival queen, floor-length gold and emerald ball gown with long sleeves and jeweled high neckline, grand feather headdress and feather train, gold jewelry, elegant samba pose, regal", 0.6, False, 666),
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
            neg = NEG + (CHILD_NEG if child else "") + (", mature body, tall, long legs, curvy, adult proportions" if (child and "--younger" in sys.argv) else "") + (", leotard, bikini, bare legs, thighs, navel, cleavage" if key == "l10" and sex == "f" else "") + (", 1girl, female, breasts, feathers, feather wings, wings, headdress, blue suit, navy suit, yellow shirt, necktie, loose necktie, business suit, blazer" if sex == "m" else "")
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
