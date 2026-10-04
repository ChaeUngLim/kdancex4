"""페이 하체 다시 그리기: 지정 영역만 마스크, 캐릭터·자세 태그로 재생성. 사용: fix_legs.py <입력> <출력접두> <model_ckpt> <strength> <seed...>"""
import sys, io, base64, json, urllib.request
from PIL import Image, ImageFilter, ImageDraw
sys.path.insert(0, "docs/prototype"); import gen_genre_multi as g
src, outp, ckpt, strength = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]); seeds = [int(x) for x in sys.argv[5:]]
im = Image.open(src).convert("RGB")
mask = Image.new("L", im.size, 0); ImageDraw.Draw(mask).rounded_rectangle((250, 790, 900, 1536), radius=60, fill=255); mask = mask.filter(ImageFilter.GaussianBlur(20)).point(lambda v: 255 if v > 80 else 0)
def b64(x):
    b = io.BytesIO(); x.save(b, "PNG"); return base64.b64encode(b.getvalue()).decode()
prompt = (g.TAG_PREFIX + "v4l3nt1ne, 1girl, faye valentine, red dress, red backless dress, flowing skirt, long legs, slender legs, standing, dance pose, one leg forward, weight on back foot, high heels, red high heels, "
          "natural anatomy, correct proportions, knees and ankles correct, lower body, dark jazz club, polished floor reflection, candlelight, detailed painted background, cowboy bebop \\(series\\) style, semi-realistic anime, cinematic lighting")
neg = g.TAG_NEGATIVE + ", extra legs, three legs, deformed legs, twisted legs, broken knee, bent backwards, extra feet, missing leg, bad proportions, 1boy"
for sd in seeds:
    body = {"prompt": prompt, "negative_prompt": neg, "width": im.width, "height": im.height, "steps": 32, "cfg_scale": 5.5, "seed": sd, "sampler_name": "DPM++ 2M Karras", "batch_size": 1,
            "init_image": b64(im), "init_mask": b64(mask), "init_strength": strength,
            "override_settings": {"sd_model_checkpoint": ckpt, "loras": [{"name": "cowboy-bebop-illustrious-v2.safetensors", "weight": 0.3}]}}
    req = urllib.request.Request("http://localhost:7860/sdapi/v1/txt2img", json.dumps(body).encode(), {"Content-Type": "application/json"})
    out = Image.open(io.BytesIO(base64.b64decode(json.load(urllib.request.urlopen(req, timeout=1800))["images"][0]))).convert("RGB")
    out.save(f"{outp}-s{sd}.jpg", quality=95); print("seed", sd, "done")
