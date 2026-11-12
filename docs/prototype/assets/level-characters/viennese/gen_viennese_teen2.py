"""비엔나 왈츠 레벨 4~5(중고생) 스파이크·페이 재생성 — 2026-10-06 사용자 지적 반영.
- 두 사람 크기·비율·포즈를 맞춘다: 같은 전신 구도, 같은 왈츠 동작
- 중고생 체형 태그를 남녀 모두에 넣는다
- 페이 의상: 촌스러운 빨강 → 페이 분위기에 맞는 검정 스탠다드 드레스
레시피는 samba/gen_samba_v2.py(확정 샘플)와 같다. 사용: python gen_viennese_teen.py [--bump=N]
"""
import base64, json, sys, time, urllib.request
from pathlib import Path

BUMP = int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--bump=")), "0"))
OUT = Path(__file__).parent / "viennese_teen2"
OUT.mkdir(exist_ok=True)

PREFIX = ("masterpiece, high score, great score, absurdres, official art, cowboy bebop, anime coloring, cel shading, "
          "sharp clean lineart, vibrant saturated colors, highly detailed, detailed face, detailed eyes, ")
SCENE = ('grand golden palace ballroom, huge crystal chandeliers, red velvet curtains with gold embroidery, red rose petals falling, polished marble floor with reflections, warm golden light, sparkling light, heavily blurred background, bokeh, shallow depth of field')
TEEN = "teenager, 15 years old, aged down, young teen, slim, petite, small frame, youthful face, "
FRAME = ('cowboy shot, large figure filling the frame, dynamic viennese waltz pose, one arm extended gracefully toward the viewer, other hand raised, body turning, face clearly visible, looking at viewer')
SPIKE = ('solo, 1boy, male focus, spike spiegel, spiegel, dark green hair, fluffy messy hair, brown eyes, teenager, 15 years old, aged down, slim, youthful face, boyish confident grin, junior ballroom dancer, black junior tailcoat with coattails, white waistcoat, white wing collar shirt, white bow tie, black trousers')
FAYE = ('solo, 1girl, faye valentine, v4l3nt1ne, dark purple hair, short bob, yellow hairband, green eyes, teenager, 15 years old, aged down, young teen, slim, petite, youthful face, confident smile, junior ballroom standard dress, crimson red ballroom dress, long sleeves, high neckline, fitted red velvet bodice with fine gold embroidery, flowing layered red chiffon skirt, skirt swirling')
NEG = ("lowres, bad anatomy, bad hands, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, low score, "
       "bad score, average score, jpeg artifacts, signature, watermark, username, blurry, text, sign, logo, "
       "multiple views, duplicate, extra people in foreground, 2girls, 2boys, deformed face, extra heads, nsfw, "
       "tiny figure, far away, small character, full body, wide shot, crowd in foreground, ball, sphere, toy, object on floor, "
       "cleavage, navel, midriff, bare shoulders, revealing clothes, makeup, lipstick, mature female, adult, large breasts, "
       "short skirt, thighs, bare legs, mature body, tall, long legs, curvy, adult proportions, muscular, broad shoulders, stubble")
NEG_M = ", 1girl, female, breasts, yellow collar, yellow shirt, yellow lapels, blue suit, navy suit, necktie, cravat, ascot, cape, military uniform"
NEG_F = ", 1boy, black dress, navy dress, pink, pink tulle, tutu, puffy sleeves, ruffled collar, plunging neckline"

JOBS = [("m_l45", SPIKE, NEG + NEG_M, 0.45, 3461), ("m_l45b", SPIKE, NEG + NEG_M, 0.45, 3462),
        ("f_l45", FAYE, NEG + NEG_F, 0.3, 4171), ("f_l45b", FAYE, NEG + NEG_F, 0.3, 4172)]


def post(body):
    req = urllib.request.Request("http://localhost:7860/sdapi/v1/txt2img", json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5400) as r:
        return json.loads(r.read())


def main():
    for i, (name, who, neg, lora, seed) in enumerate(JOBS, 1):
        t = time.time()
        prompt = f"{PREFIX}{who}, {FRAME}, {SCENE}"
        body = {"prompt": prompt, "negative_prompt": neg, "width": 832, "height": 1216, "seed": seed + BUMP,
                "steps": 35, "cfg_scale": 5, "sampler_name": "DPM++ 2M Karras", "batch_size": 1,
                "enable_hr": True, "hr_scale": 1.5, "denoising_strength": 0.4, "hr_steps": 24,
                "override_settings": {"sd_model_checkpoint": "animagine-xl-4.0.safetensors", "offload_text_encoder": True, "vae_tiling": True,
                                      "loras": [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": lora}]}}
        (OUT / f"{name}.png").write_bytes(base64.b64decode(post(body)["images"][0]))
        (OUT / f"{name}.txt").write_text(f"4~5 중급 · 중고생\nseed={seed + BUMP} lora={lora}\n{prompt}\nNEG: {neg}\n", encoding="utf-8")
        print(f"[{i}/{len(JOBS)}] {name} {time.time()-t:.0f}s", flush=True)


if __name__ == "__main__":
    main()
