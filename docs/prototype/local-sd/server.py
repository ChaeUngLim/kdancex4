#!/usr/bin/env python3
"""로컬 SDXL 생성 서버 — A1111/Forge 의 /sdapi/v1/txt2img 와 /sdapi/v1/sd-models 만 흉내 낸다.
gen_genre_multi.py 의 local-* 제공처가 이 서버를 부른다. (2026-10-02, 사용자 결정 「로컬로 진행」)

- 체크포인트: ~/models/sdxl/*.safetensors (Animagine XL 4.0 · Illustrious XL 2.0 — Hugging Face 에서 받은 단일 파일)
- RTX 4060 8GB: fp16 + VAE 슬라이싱으로 1024² 가 들어간다. 모델 전환은 한 번에 하나만 올리고(VRAM) 요청은 직렬로 처리한다.
- Docker 의 kdance-llm(llama-server)이 떠 있으면 VRAM 을 다투니 내리고 쓴다.

실행:
    cd docs/prototype/local-sd && .venv/bin/python server.py            # http://localhost:7860
환경: LOCAL_SD_MODELS_DIR(기본 ~/models/sdxl) · LOCAL_SD_PORT(기본 7860) · LOCAL_SD_DEFAULT(기본 animagine-xl-4.0.safetensors)
"""
from __future__ import annotations

import base64
import gc
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch
from PIL import Image
from diffusers import (AutoencoderKL, DPMSolverMultistepScheduler, EulerAncestralDiscreteScheduler, EulerDiscreteScheduler,
                       StableDiffusionXLImg2ImgPipeline, StableDiffusionXLPipeline)

MODELS_DIR = Path(os.environ.get("LOCAL_SD_MODELS_DIR", Path.home() / "models" / "sdxl"))
PORT = int(os.environ.get("LOCAL_SD_PORT", "7860"))
DEFAULT = os.environ.get("LOCAL_SD_DEFAULT", "animagine-xl-4.0.safetensors")
LORA_DIR = MODELS_DIR / "lora"  # override_settings.loras = [{"name": "파일.safetensors", "weight": 0.8}, ...]
VAE_DIR = MODELS_DIR / "vae-fp16-fix"  # madebyollin/sdxl-vae-fp16-fix — 있으면 모든 체크포인트의 VAE 를 이것으로 바꾼다
# (2026-10-02 실측: Illustrious v0.1 이 내장 VAE + fp16 에서 줄무늬·바랜 색으로 깨졌다. SDXL fp16 의 알려진 VAE 오버플로.)

SAMPLERS = {
    "Euler a": lambda cfg: EulerAncestralDiscreteScheduler.from_config(cfg),
    "Euler": lambda cfg: EulerDiscreteScheduler.from_config(cfg),
    "DPM++ 2M Karras": lambda cfg: DPMSolverMultistepScheduler.from_config(cfg, use_karras_sigmas=True),
}

_lock = threading.Lock()
_pipe: StableDiffusionXLPipeline | None = None
_loaded: str | None = None
_base_sched_cfg: dict | None = None  # 체크포인트 원래 스케줄러 설정 — 호출마다 여기서 새로 만든다(설정 누수 방지)
_loras_loaded: tuple = ()  # 지금 붙어 있는 (이름, 가중치) 묶음
# IP-Adapter(2026-10-03, 캐릭터 참조 이미지로 외형 고정): ~/models/ip-adapter 는 h94/IP-Adapter 의 sdxl_models/*vit-h* + models/image_encoder.
# 8GB 대책 — 이미지 인코더(CLIP ViT-H, fp16 약 1.2GB)는 참조 사진을 벡터로 바꿀 때만 GPU 에 올리고 바로 CPU 로 내린다.
# 생성 중에는 어댑터 가중치만 남는다. hires 2단계는 기본 세기 0(어댑터 영향 없음) — 피크 VRAM 을 더 안 올리려는 것.
IP_DIR = Path(os.environ.get("LOCAL_SD_IP_DIR", Path.home() / "models" / "ip-adapter"))
IP_WEIGHTS = {"plus": "ip-adapter-plus_sdxl_vit-h.safetensors", "plus-face": "ip-adapter-plus-face_sdxl_vit-h.safetensors"}
_ip_loaded: str | None = None  # 지금 붙어 있는 어댑터 파일 이름
_ip_encoder = None  # CLIPVisionModelWithProjection — 한 번 읽어 CPU 에 둔다


def load(name: str) -> StableDiffusionXLPipeline:
    """체크포인트를 올린다. 이미 올라 있으면 그대로, 다른 것이면 내리고 새로 올린다(8GB 라 둘을 동시에 못 둔다)."""
    global _pipe, _loaded, _base_sched_cfg
    if _pipe is not None and _loaded == name:
        return _pipe
    path = MODELS_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"체크포인트 없음: {path}")
    if _pipe is not None:
        del _pipe
        _pipe = None
        torch.cuda.empty_cache()
    t0 = time.time()
    pipe = StableDiffusionXLPipeline.from_single_file(str(path), torch_dtype=torch.float16, use_safetensors=True)
    if (VAE_DIR / "diffusion_pytorch_model.safetensors").exists():
        pipe.vae = AutoencoderKL.from_pretrained(str(VAE_DIR), torch_dtype=torch.float16)
    pipe.to("cuda")
    # diffusers 0.40: 파이프라인의 enable_vae_slicing() 이 사라지고 vae.enable_slicing() 으로 옮겨 갔다(2026-10-02 실측)
    if hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()
    elif hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    pipe.set_progress_bar_config(disable=True)
    _pipe, _loaded = pipe, name
    _base_sched_cfg = dict(pipe.scheduler.config)
    global _loras_loaded, _ip_loaded
    _loras_loaded = ()
    _ip_loaded = None  # 새 파이프라인에는 어댑터가 없다
    print(f"[load] {name} · {time.time() - t0:.0f}s · VRAM {torch.cuda.memory_allocated() / 2**30:.1f} GB", flush=True)
    return pipe


def _ip_encoder_cpu():
    """이미지 인코더를 한 번만 디스크에서 읽어 CPU 에 둔다."""
    global _ip_encoder
    if _ip_encoder is None:
        from transformers import CLIPVisionModelWithProjection
        _ip_encoder = CLIPVisionModelWithProjection.from_pretrained(str(IP_DIR / "models" / "image_encoder"), torch_dtype=torch.float16)
        _ip_encoder.eval()
    return _ip_encoder


def set_ip_adapter(pipe: StableDiffusionXLPipeline, kind: str | None) -> None:
    """요청에 맞춰 IP-Adapter 를 붙이거나 뗀다. kind 는 IP_WEIGHTS 의 키 또는 None(뗌)."""
    global _ip_loaded
    want = IP_WEIGHTS[kind] if kind else None
    if want == _ip_loaded:
        return
    if _ip_loaded:
        pipe.unload_ip_adapter()  # attn processor 복원 + image_encoder/feature_extractor 등록 해제
        _ip_loaded = None
    if want:
        from transformers import CLIPImageProcessor
        pipe.register_modules(image_encoder=_ip_encoder_cpu(), feature_extractor=CLIPImageProcessor())
        pipe.load_ip_adapter(str(IP_DIR), subfolder="sdxl_models", weight_name=want, image_encoder_folder=None)
        _ip_loaded = want
    print(f"[ip-adapter] {want or '없음'} · VRAM {torch.cuda.memory_allocated() / 2**30:.1f} GB", flush=True)


def ip_image_embeds(pipe: StableDiffusionXLPipeline, images: list[Image.Image]):
    """참조 이미지들을 어댑터 입력 벡터로 바꾼다. 인코더는 이때만 GPU 에 올렸다가 바로 내린다."""
    enc = _ip_encoder_cpu()
    enc.to("cuda")
    try:
        embeds = pipe.prepare_ip_adapter_image_embeds(ip_adapter_image=[images], ip_adapter_image_embeds=None, device=pipe.device,
                                                      num_images_per_prompt=1, do_classifier_free_guidance=True)
    finally:
        enc.to("cpu")
        gc.collect(); torch.cuda.empty_cache()
    print(f"[ip-adapter] 참조 {len(images)}장 → 벡터 · VRAM {torch.cuda.memory_allocated() / 2**30:.1f} GB", flush=True)
    return embeds


def apply_loras(pipe: StableDiffusionXLPipeline, loras: list[dict]) -> None:
    """요청의 LoRA 목록을 파이프라인에 붙인다. 같은 묶음이면 그대로, 다르면 전부 떼고 다시 붙인다(2026-10-02, Cowboy Bebop LoRA 비교용)."""
    global _loras_loaded
    want = tuple((str(l["name"]), float(l.get("weight", 1.0))) for l in loras if float(l.get("weight", 1.0)) > 0)
    if want == _loras_loaded:
        return
    if _loras_loaded:
        pipe.unload_lora_weights()
    names = []
    for i, (fname, w) in enumerate(want):
        path = LORA_DIR / fname
        if not path.exists():
            raise FileNotFoundError(f"LoRA 없음: {path}")
        adapter = f"lora{i}"
        # (2026-10-03) 글 인코더 가중치(lora_te*)가 든 LoRA 는 diffusers 0.40 의 load_lora_into_text_encoder 가 IndexError 로 죽는다
        # (cowboy-bebop-style-illustriousXL 실측). UNet 부분만 올린다 — 화풍 LoRA 의 효과는 대부분 UNet 쪽이고, 글 인코더는 어차피 CPU 로 내린다.
        from safetensors.torch import load_file
        sd = load_file(str(path))
        unet_sd = {k: v for k, v in sd.items() if not k.startswith(("lora_te", "text_encoder"))}
        if len(unet_sd) != len(sd):
            print(f"[lora] {fname}: 글 인코더 키 {len(sd) - len(unet_sd)}개 건너뜀(UNet {len(unet_sd)}개만 적용)", flush=True)
        pipe.load_lora_weights(unet_sd, adapter_name=adapter)
        del sd, unet_sd
        names.append(adapter)
    if names:
        pipe.set_adapters(names, adapter_weights=[w for _, w in want])
    _loras_loaded = want
    print(f"[lora] {want or '없음'}", flush=True)


def encode_long(pipe: StableDiffusionXLPipeline, text: str):
    """77 토큰 제한 없이 프롬프트를 임베딩한다. 반환: (prompt_embeds [1, 77*k, 2048], pooled [1, 1280])."""
    device = pipe.text_encoder.device
    embeds, pooled = [], None
    for tok, enc in ((pipe.tokenizer, pipe.text_encoder), (pipe.tokenizer_2, pipe.text_encoder_2)):
        ids = tok(text, truncation=False, add_special_tokens=False).input_ids
        chunks = [ids[i:i + 75] for i in range(0, len(ids), 75)] or [[]]
        outs = []
        for ch in chunks:
            ch = [tok.bos_token_id] + ch + [tok.eos_token_id]
            ch = ch + [tok.pad_token_id] * (77 - len(ch))
            with torch.no_grad():
                o = enc(torch.tensor([ch], device=device), output_hidden_states=True)
            outs.append(o.hidden_states[-2])
            if enc is pipe.text_encoder_2 and pooled is None:
                pooled = o[0]  # CLIPTextModelWithProjection → text_embeds
        embeds.append(torch.cat(outs, dim=1))
    return torch.cat(embeds, dim=-1), pooled


def _pad_seq(pipe: StableDiffusionXLPipeline, e, n: int):
    """프롬프트·네거티브의 청크 수를 맞춘다 — 짧은 쪽에 빈 청크 임베딩을 덧붙인다."""
    if e.shape[1] >= n:
        return e
    empty, _ = encode_long(pipe, "")
    while e.shape[1] < n:
        e = torch.cat([e, empty], dim=1)
    return e


def txt2img(req: dict) -> dict:
    name = (req.get("override_settings") or {}).get("sd_model_checkpoint") or DEFAULT
    # clip_skip 은 기본으로 쓰지 않는다 — diffusers 에 clip_skip=1(A1111 의 2)을 주면 Illustrious 가 줄무늬·노이즈로 깨졌다(2026-10-02 실측,
    # Animagine 은 멀쩡). 꼭 필요하면 override_settings.diffusers_clip_skip 로 명시한다.
    clip_skip = (req.get("override_settings") or {}).get("diffusers_clip_skip")
    with _lock:
        pipe = load(name)
        ov = req.get("override_settings") or {}
        hr_w = ov.get("hr_lora_weight")
        loras = ov.get("loras") or []
        # C안(2026-10-03 LoRA 단계별 비교): 1단계 세기가 전부 0이어도 2단계 세기가 있으면 어댑터는 2단계 세기로 올려 두고
        # 1단계에서만 끈다. apply_loras 가 세기 0을 아예 안 올리므로 이 분기가 없으면 2단계에서 켤 어댑터가 없다(실측 버그).
        base_off = hr_w is not None and float(hr_w) > 0 and bool(loras) and all(float(l.get("weight", 1.0)) <= 0 for l in loras)
        if base_off:
            apply_loras(pipe, [{**l, "weight": float(hr_w)} for l in loras])
            pipe.disable_lora()
            print("[lora] 1단계 끔(2단계만)", flush=True)
        else:
            apply_loras(pipe, loras)
        cfg = dict(_base_sched_cfg)  # 원래 설정 복사본 — 이전 호출의 override 가 남지 않는다(2026-10-02 실측: 누수로 v-pred 가 남아 있었다)
        if ov.get("prediction_type"):   # "epsilon" | "v_prediction"
            cfg["prediction_type"] = ov["prediction_type"]
        if "zero_snr" in ov:            # zero terminal SNR 재스케일
            cfg["rescale_betas_zero_snr"] = bool(ov["zero_snr"])
        pipe.scheduler = SAMPLERS.get(req.get("sampler_name", "Euler a"), SAMPLERS["Euler a"])(cfg)
        # IP-Adapter: override_settings.ip_adapter = {"images": [base64 PNG/JPG ...], "weight": 0.6, "hr_weight": 0, "model": "plus"|"plus-face"}
        ip = ov.get("ip_adapter") or {}
        set_ip_adapter(pipe, (ip.get("model") or "plus") if ip.get("images") else None)
        ip_embeds = None
        if ip.get("images"):
            ref_imgs = [Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB") for b in ip["images"]]
            ip_embeds = ip_image_embeds(pipe, ref_imgs)
            pipe.set_ip_adapter_scale(float(ip.get("weight", 0.6)))
        ip_kw = {"ip_adapter_image_embeds": ip_embeds} if ip_embeds is not None else {}
        seed = int(req.get("seed", -1))
        gen = torch.Generator("cuda").manual_seed(seed) if seed >= 0 else None
        t0 = time.time()
        torch.cuda.reset_peak_memory_stats()  # 피크 VRAM 은 요청 단위로 잰다
        # 긴 프롬프트: CLIP 은 77 토큰까지만 읽어 뒤쪽 태그(인물 외형)가 잘렸다(2026-10-03 실측). 75토큰 청크로 나눠 두 인코더로
        # 각각 임베딩한 뒤 이어 붙인다(A1111 방식). pooled 는 첫 청크의 것을 쓴다.
        # (2026-10-03 VRAM 실험 E4 → 기본값) 글 인코더 두 개(fp16 약 1.5GB)를 벡터를 뽑은 뒤 CPU 로
        # 내린다. 그림을 그리는 동안은 쓰지 않는 부품이라 그만큼 2단계 피크가 내려간다. 다음 요청 때 다시 올린다.
        # 2026-10-03 실측(E4): 내리기만으로 1127초 → 152초, 피크 9.0 → 7.5GB, 결과 픽셀 동일. 그래서 기본값 켬. 끄려면 override_settings.offload_text_encoder=false.
        offload_te = bool(ov.get("offload_text_encoder", True))
        if offload_te and pipe.text_encoder.device.type != "cuda":
            pipe.text_encoder.to("cuda"); pipe.text_encoder_2.to("cuda")
        pe, ppe = encode_long(pipe, req.get("prompt", ""))
        npe, nppe = encode_long(pipe, req.get("negative_prompt") or "")
        n = max(pe.shape[1], npe.shape[1])
        pe, npe = _pad_seq(pipe, pe, n), _pad_seq(pipe, npe, n)
        if offload_te:
            pipe.text_encoder.to("cpu"); pipe.text_encoder_2.to("cpu")
            gc.collect(); torch.cuda.empty_cache()
            print(f"[offload] 글 인코더 CPU 로 · VRAM {torch.cuda.memory_allocated() / 2**30:.1f} GB", flush=True)
        # (2026-10-03 VRAM 실험) override_settings.attention_slicing = true 면 어텐션을 잘라 계산해 피크를 낮춘다(속도는 조금 느려짐)
        if ov.get("attention_slicing"):
            pipe.enable_attention_slicing("auto")
        elif not _ip_loaded:
            # (2026-10-05) IP-Adapter 가 붙어 있으면 건너뛴다 — disable_attention_slicing 이 어텐션 처리기를 기본값으로 되돌려
            # IP-Adapter 처리기가 사라지고, UNet 이 넘기는 (글, 이미지) 묶음을 기본 처리기가 받아 'tuple' 오류(500)가 났다
            pipe.disable_attention_slicing()
        # (2026-10-03 VRAM 실험 E6) override_settings.vae_tiling = true 면 1단계 디코드부터 VAE 타일링을 켠다. 실측 E1~E3 에서 2단계 배율·어텐션
        # 슬라이싱을 바꿔도 피크가 9.0GB 로 똑같았다 → 피크는 2단계가 아니라 1단계 끝의 1024 디코드(타일링 없음)로 보인다.
        # 실측(E6c·I2): 1단계 타일링까지 켜면 피크 7.5 → 6.7GB, 시간 152 → 67초(Animagine)·90 → 62초(Illustrious), 그림은 눈으로 구분 불가
        # (평균 밝기차 1.9~2.9/255). 기본값 켬. 끄려면 override_settings.vae_tiling=false.
        if ov.get("vae_tiling", True) and hasattr(pipe.vae, "enable_tiling"):
            pipe.vae.enable_tiling()
        elif hasattr(pipe.vae, "disable_tiling"):
            pipe.vae.disable_tiling()
        init_b64 = req.get("init_image")  # (2026-10-03) 초안 이미지: 있으면 1단계를 txt2img 대신 img2img 로 — 기준 그림의 구도·조명을 그대로 가져온다
        if init_b64:
            w, h = int(req.get("width", 1024)), int(req.get("height", 1024))
            init = Image.open(io.BytesIO(base64.b64decode(init_b64))).convert("RGB").resize((w, h), Image.LANCZOS)
            comps = {k: getattr(pipe, k) for k in ("vae", "text_encoder", "text_encoder_2", "tokenizer", "tokenizer_2", "unet", "scheduler")}
            mask_b64 = req.get("init_mask")
            if mask_b64:
                # (2026-10-03) 인페인팅: 마스크(흰색)가 친 자리만 새로 그리고 나머지는 초안을 그대로 둔다. 기준 그림의 글씨·인셋 초상을 지우고
                # 그림이 이어지게 채우는 용도. 일반 SDXL UNet(4채널)도 diffusers 인페인트 파이프라인이 받아 준다.
                from diffusers import StableDiffusionXLInpaintPipeline
                mask = Image.open(io.BytesIO(base64.b64decode(mask_b64))).convert("L").resize((w, h), Image.NEAREST)
                inp = StableDiffusionXLInpaintPipeline(**comps)
                inp.set_progress_bar_config(disable=True)
                out = inp(image=init, mask_image=mask, strength=float(req.get("init_strength", 1.0)), width=w, height=h,
                          prompt_embeds=pe, negative_prompt_embeds=npe, pooled_prompt_embeds=ppe, negative_pooled_prompt_embeds=nppe,
                          num_inference_steps=int(req.get("steps", 28)), guidance_scale=float(req.get("cfg_scale", 6)), generator=gen, **ip_kw)
                del inp
                print(f"[init] inpaint strength={req.get('init_strength', 1.0)}", flush=True)
            else:
                i2i0 = StableDiffusionXLImg2ImgPipeline(**comps)
                i2i0.set_progress_bar_config(disable=True)
                out = i2i0(image=init, strength=float(req.get("init_strength", 0.6)),
                           prompt_embeds=pe, negative_prompt_embeds=npe, pooled_prompt_embeds=ppe, negative_pooled_prompt_embeds=nppe,
                           num_inference_steps=int(req.get("steps", 28)), guidance_scale=float(req.get("cfg_scale", 6)), generator=gen, **ip_kw)
                del i2i0
                print(f"[init] img2img strength={req.get('init_strength', 0.6)}", flush=True)
        else:
            out = pipe(
                prompt_embeds=pe, negative_prompt_embeds=npe, pooled_prompt_embeds=ppe, negative_pooled_prompt_embeds=nppe,
                width=int(req.get("width", 1024)), height=int(req.get("height", 1024)),
                num_inference_steps=int(req.get("steps", 28)), guidance_scale=float(req.get("cfg_scale", 6)),
                generator=gen,
                num_images_per_prompt=int(req.get("batch_size", 1)),
                **ip_kw,
            )
        # 고해상도 2단계(2026-10-03, "실사에 가까운 고화질"): enable_hr 이면 hr_scale 배로 키워 img2img 로 세부를 다시 그린다(A1111 hires fix).
        if req.get("enable_hr"):
            # 2026-10-03 OOM 대책: 1536 단계 전에 캐시를 비우고 VAE 타일링을 켠다(1536 디코드가 피크). 그래도 OOM 이면 1.25배로 한 번 더.
            scale = float(req.get("hr_scale", 1.5)); strength = float(req.get("denoising_strength", 0.4))
            base_images = out.images
            del out
            gc.collect(); torch.cuda.empty_cache()
            i2i = StableDiffusionXLImg2ImgPipeline(**{k: getattr(pipe, k) for k in ("vae", "text_encoder", "text_encoder_2", "tokenizer", "tokenizer_2", "unet", "scheduler")})
            i2i.set_progress_bar_config(disable=True)
            if hasattr(pipe.vae, "enable_tiling"):
                pipe.vae.enable_tiling()
            # 단계별 LoRA(2026-10-03 사용자 제안 검증용): hr_lora_weight 가 있으면 hires 단계에만 그 세기로 바꾼다(0 = LoRA 끔).
            adapters = [f"lora{i}" for i in range(len(_loras_loaded))]
            if hr_w is not None and adapters:
                if float(hr_w) <= 0:
                    pipe.disable_lora()
                else:
                    pipe.enable_lora()  # base_off(1단계 끔)였으면 여기서 처음 켠다
                    pipe.set_adapters(adapters, adapter_weights=[float(hr_w)] * len(adapters))
                print(f"[hires] LoRA {hr_w}", flush=True)
            if ip_embeds is not None:
                pipe.set_ip_adapter_scale(float(ip.get("hr_weight", 0)))
            hi = []
            for im in base_images:
                for attempt_scale in (scale, 1.25):
                    big = im.resize((int(im.width * attempt_scale) // 8 * 8, int(im.height * attempt_scale) // 8 * 8), Image.LANCZOS)
                    try:
                        r = i2i(image=big, strength=strength, prompt_embeds=pe, negative_prompt_embeds=npe, pooled_prompt_embeds=ppe,
                                negative_pooled_prompt_embeds=nppe, num_inference_steps=int(req.get("hr_steps", 24)),
                                guidance_scale=float(req.get("cfg_scale", 6)), generator=torch.Generator("cuda").manual_seed(seed if seed >= 0 else 0), **ip_kw)
                        hi.append(r.images[0]); break
                    except torch.cuda.OutOfMemoryError:
                        print(f"[hires] OOM at x{attempt_scale} — 캐시 비우고 작은 배율로 재시도", flush=True)
                        gc.collect(); torch.cuda.empty_cache()
                else:
                    hi.append(im)  # 둘 다 실패하면 1024 원본을 돌려준다
            if hasattr(pipe.vae, "disable_tiling"):
                pipe.vae.disable_tiling()
            if hr_w is not None and adapters:  # base 세기로 복원
                pipe.enable_lora()
                pipe.set_adapters(adapters, adapter_weights=[w for _, w in _loras_loaded])
            del i2i
            class _O: pass
            out = _O(); out.images = hi
            gc.collect(); torch.cuda.empty_cache()
        images = []
        for im in out.images:
            buf = io.BytesIO(); im.save(buf, "PNG"); images.append(base64.b64encode(buf.getvalue()).decode())
        gc.collect(); torch.cuda.empty_cache()
        print(f"[txt2img] {name} seed={seed} {time.time() - t0:.0f}s · VRAM {torch.cuda.memory_allocated() / 2**30:.1f} GB · 피크 {torch.cuda.max_memory_allocated() / 2**30:.1f} GB", flush=True)
        return {"images": images, "parameters": {"model": name, "seed": seed}, "info": ""}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict | list) -> None:
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/sdapi/v1/sd-models"):
            self._json(200, [{"title": p.name, "model_name": p.stem, "filename": str(p)} for p in sorted(MODELS_DIR.glob("*.safetensors"))])
        elif self.path.startswith("/health"):
            self._json(200, {"status": "ok", "loaded": _loaded})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/sdapi/v1/txt2img"):
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", "0"))
        req = json.loads(self.rfile.read(n) or b"{}")
        try:
            self._json(200, txt2img(req))
        except Exception as e:  # noqa: BLE001 — 호출 쪽에 원인을 그대로 돌려준다
            import traceback; traceback.print_exc()  # (2026-10-03) 서버 로그에도 위치를 남긴다
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt: str, *args) -> None:  # 요청 로그는 txt2img 쪽에서만 찍는다
        pass


if __name__ == "__main__":
    print(f"models: {MODELS_DIR} · default: {DEFAULT} · http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
