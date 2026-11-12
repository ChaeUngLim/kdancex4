"""아르헨티나 탱고 레벨 캐릭터 — 삼바 확정 레시피 구조로 재작성(2026-10-06).
순서: 품질·화풍 → 캐릭터 → 나이 → 의상(아르헨티나 탱고 복장)·동작 → 구도 → 배경(밀롱가 A 실내 / B 야외 광장).
스파이크 페도라는 30대부터. 페이는 탱고 드레스 + 탱고 슈즈 포인트, 미성년(0~5)은 노출 없는 드레스·낮은 굽.
사용: python gen_tango6.py --bg=A|B [--only=...] [--bump=N]"""
import base64, json, sys, time, urllib.request
from pathlib import Path
REF = base64.b64encode((Path(__file__).parent / "ref_faye_tango.png").read_bytes()).decode()

arg = lambda k, d=None: next((a.split("=", 1)[1] for a in sys.argv if a.startswith(f"--{k}=")), d)
BG = arg("bg", "A"); BUMP = int(arg("bump", "0")); ONLY = arg("only").split(",") if arg("only") else None
OUT = Path(__file__).parent / arg("out", "tango7"); OUT.mkdir(exist_ok=True)

PREFIX = ("masterpiece, high score, great score, absurdres, official art, cowboy bebop, anime coloring, delicate cel shading, "
          "sharp clean lineart, vibrant saturated colors, highly detailed, detailed face, detailed eyes, ")
SCENE = 'night milonga in buenos aires plaza, stone pavement, vintage street lamps, string lights, tango couples dancing in background, blurred background'
SPIKE = "solo, 1boy, male focus, spike spiegel, spiegel, dark green hair, fluffy messy hair, brown eyes, "
FAYE = "solo, 1girl, faye valentine, v4l3nt1ne, dark purple hair, short bob, yellow hairband, green eyes, "
FRAME = "cowboy shot, large figure filling the frame, face clearly visible, looking at viewer"
NEG = ("lowres, bad anatomy, bad hands, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, low score, "
       "bad score, average score, jpeg artifacts, signature, watermark, username, blurry, text, sign, logo, "
       "multiple views, duplicate, extra people in foreground, 2girls, 2boys, deformed face, extra heads, nsfw, "
       "holding instrument, musical instrument in hands, double bass, cello, violin, guitar, accordion, instrument in foreground, tiny figure, far away, small character, casual clothes, street clothes, sportswear, jersey, t-shirt, hoodie, school uniform, sneakers")
CHILD_NEG = (", pink dress, off shoulder, bare chest, backless, bare back, short skirt, short dress, leotard, cleavage, navel, midriff, bare shoulders, revealing clothes, side slit, high slit, bare thighs, thighs, "
             "makeup, lipstick, mature female, adult, large breasts, high heels, stiletto, mature body, tall, long legs, curvy, adult proportions, long hair")
NEG_M = ", 1girl, female, breasts, blue suit, navy suit, green shirt, holding baby, doll, green headwear, red coat, red jacket, red hat, purple coat, yellow coat, purple suit"
NEG_F = ", 1boy, hat, fedora, yellow shirt, yellow leotard, red jacket, cropped jacket, shorts, pillow, stuffed toy, purple dress, navy dress, blue dress, green clothes, green ribbon, orange dress, yellow dress, brown dress, pink dress"

# (키, 라벨, 나이, 미성년, 스파이크 의상·동작, 페이 의상·동작, LoRA, seed)
STAGES = [
    ("l01", "0~1 입문 · 아기", "toddler, 1 year old, chibi, aged down, chubby cheeks, big round eyes, very young, small toddler body, ", True,
     "black tiny tango vest, white shirt, tiny bow tie, sitting, holding white milk bottle with both hands, happy",
     "all red outfit, red tiny ruffle tango dress, red ribbon in hair, red shoes, sitting, holding white milk bottle with both hands, happy", 0.25, 1301),
    ("l23", "2~3 초급 · 초등학생", "child, aged down, 8 years old, small child, child proportions, large head, short limbs, petite, big grin, ", True,
     "argentine tango outfit for boys, black vest, white shirt, black high-waisted tango trousers, black and white two-tone tango shoes, tango walk, caminata, chest proud, arms in embrace frame",
     "red satin dress, girls argentine tango dress, short sleeves, below-knee flared skirt, red low-heel ankle strap tango shoes, tango walk, chest proud, arms in embrace frame", 0.35, 2301),
    ("l45", "4~5 중급 · 중고생", "teenager, 15 years old, aged down, young teen, slim, petite, youthful face, confident smile, ", True,
     "black shirt, black vest, junior argentine tango costume, black satin shirt, slim black tango trousers, two-tone tango shoes, elegant tango posture, arm extended in embrace frame, graceful, confident",
     "red and black junior tango practice dress, long sleeves, high neckline, knee-length flared skirt with black lace hem, black low-heel tango shoes, fresh lively smile, energetic, tango ocho practice, skirt swirling", 0.45, 3401),
    ("l67", "6~7 중급 · 대학생", "young adult, 20 years old, slim, cocky grin, ", False,
     "black suit, white shirt, slim black argentine tango suit, open collar, two-tone tango shoes, elegant tango lead, arm extended in embrace frame, confident",
     "young woman, 20 years old, playful bright smile, cheerful, red tango dress with black lace trim, short sleeves, flared midi skirt, red flower in hair, red tango shoes, tango boleo, youthful", 0.55, 4501),
    ("l89", "8~9 고급 · 30대", "aged up, adult man, 30s, mature, sharp jawline, light stubble, cool half smile, ", False,
     "fedora, hat, black felt fedora tilted, black three-piece argentine tango suit, white shirt, black silk tie, cool smirk, elegant tango quebrada, arm extended, sophisticated",
     "aged up, adult woman, 30s, mature beauty, sultry, red lips, red silk slip dress, thin straps, backless, high side slit, red stiletto tango shoes, smoldering look, looking up, back arched, tango gancho", 0.6, 5601),
    ("l10", "10 고급 · 40대 귀족", "aged up, middle-aged man, 45 years old, neatly trimmed short beard, grey temples, aristocratic, distinguished, noble bearing, ", False,
     "fedora, hat, luxurious black fedora with silk band, noble aristocrat, distinguished gentleman, black velvet double-breasted suit, waistcoat, silk cravat, pocket square, gold watch chain, signet ring, white gloves, elegant tango salida, offering hand, regal",
     "aged up, middle-aged woman, 45 years old, elegant mature beauty, aristocratic, noble bearing, graceful smile, floor-length deep crimson velvet tango gown, long sleeves, jeweled neckline, black lace shawl, ruby earrings, red rose in hair, regal, elegant tango pose", 0.45, 6701),
]


def post(body):
    req = urllib.request.Request("http://localhost:7860/sdapi/v1/txt2img", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5400) as r:
        return json.loads(r.read())


def main():
    jobs = []
    for key, label, age, minor, spike, faye, lora, seed in STAGES:
        for sex in ("m", "f"):
            name = f"{sex}_{key}"
            if ONLY and name not in ONLY:
                continue
            anchor = ""
            if sex == "m" and key in ("l45", "l67"):
                anchor = "black suit, black clothes, "
            elif sex == "m" and key in ("l89", "l10"):
                anchor = "black fedora, black suit, black clothes, "
            elif sex == "f" and minor and key != "l01":
                anchor = "red dress, long sleeves, high neckline, covered shoulders, modest, "
            elif sex == "f" and key != "l01":
                anchor = "red dress, "
            if sex == "m":
                prompt_core = SPIKE + anchor + age + spike
                neg = NEG + NEG_M + ("" if key in ("l89", "l10") else ", hat, fedora, headwear")
            else:
                prompt_core = FAYE + anchor + (age if minor else "") + faye
                neg = NEG + NEG_F
            if minor:
                neg += CHILD_NEG
            if (sex, key) == ("m", "l45"):
                neg += ", yellow shirt, suspenders"
            if (sex, key) in (("f", "l45"), ("f", "l67")):
                neg += ", black dress, dark red dress, burgundy"
            if (sex, key) == ("m", "l89"):
                neg += ", from behind, back view, looking away, no hat"
            if (sex, key) == ("m", "l10"):
                neg += ", brown suit, brown jacket"
            if key == "l01":
                neg += ", red bottle, jar, cup, toy, holding baby, infant in arms, baby doll, multiple people, 2 children, sibling, another child, blanket"
            prompt = f"{PREFIX}{prompt_core}, {FRAME}, {SCENE}"
            jobs.append((name, label, prompt, neg, lora, seed + (1 if sex == "f" else 0) + BUMP, False))  # IP-Adapter 끔: VRAM 7.7GB 로 8GB 한도에 걸려 공유 메모리로 넘침(2026-10-06)
    for i, (name, label, prompt, neg, lora, seed, use_ref) in enumerate(jobs, 1):
        t = time.time()
        body = {"prompt": prompt, "negative_prompt": neg, "width": 832, "height": 1216, "seed": seed,
                "steps": 35, "cfg_scale": 5, "sampler_name": "DPM++ 2M Karras", "batch_size": 1,
                "enable_hr": True, "hr_scale": 1.5, "denoising_strength": 0.4, "hr_steps": 24,
                "override_settings": {"sd_model_checkpoint": "animagine-xl-4.0.safetensors", "offload_text_encoder": True, "vae_tiling": True,
                                      "loras": [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": lora}],
                                      **({"ip_adapter": {"images": [REF], "weight": 0.45, "hr_weight": 0}} if use_ref else {})}}
        (OUT / f"{name}.png").write_bytes(base64.b64decode(post(body)["images"][0]))
        (OUT / f"{name}.txt").write_text(f"{label}\nseed={seed} lora={lora}\n{prompt}\nNEG: {neg}\n", encoding="utf-8")
        print(f"[{BG} {i}/{len(jobs)}] {name} {label} {time.time()-t:.0f}s", flush=True)


if __name__ == "__main__":
    main()
