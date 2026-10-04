# 카우보이 비밥 극장판 댄스 포스터 — 생성 프롬프트 (2026-10-03)

기준: 사용자 콜라주 이미지(3열×2행 + 하단 정보 패널). 아래는 **프롬프트와 설정만**이다. 두 모델 모두 아직 실행하지 않았다.

원작과 기준 그림이 어긋나는 두 곳은 원작을 따랐다 — 일렉트라 머리색(원작 짙은 갈색 / 기준 금발), 비셔스 머리색(원작 은발 / 기준 흑발). 기준 그림대로 가려면 `[교체]` 표시 태그만 바꾼다.

---

## A. Animagine XL 4.0 + Cowboy Bebop LoRA (로컬, `local-sd/server.py`)

SDXL 은 한 장에 3:2 멀티패널·글씨·인셋을 못 그린다. **패널 6장을 2:3 세로로 따로 뽑고**, 3×2 조립·초상 인셋·텍스트·하단 정보 패널은 Pillow 후처리로 넣는다.

LoRA 는 범용 애니 스타일 LoRA 보다 **캐릭터 LoRA**(Civitai 940639 "Cowboy Bebop the Movie", 트리거 `spiegel` `v4l3nt1ne` `ovirowa`)가 맞다 — 스타일은 체크포인트가 이미 갖고 있고, 부족한 건 "누구인지"다. 세기는 **1단계 0, 2단계(hires) 0.3** — 2026-10-03 룸바 A·B·C 비교에서 사용자가 고른 C 설정. 1단계에 LoRA 가 있으면 영화 스틸 구도로 끌려가고, 2단계에만 두면 체크포인트가 춤 장면을 짜고 LoRA 가 얼굴·질감만 입힌다. 앞으로 C 가 표준이다.

### 공통 설정
| 항목 | 값 |
|---|---|
| 해상도 | 832×1216 (2:3 세로, Animagine 4.0 권장 버킷) |
| 샘플러 / 스텝 | DPM++ 2M Karras · 35 |
| CFG | 5 |
| hires fix | ×1.5 · denoise 0.45 · 28 steps · **LoRA 0.3** |
| LoRA(1단계) | **0** — C 설정 |
| clip skip | 주지 않는다(diffusers 기본) |
| VRAM | 글 인코더 CPU 내리기 · 1단계 VAE 타일링(서버 기본값) | 피크 6.7GB, 한 장 1분 안팎 |
| seed | 패널마다 고정값 하나(예: 801) — 재현용 |

### 공통 접두(품질·화풍) — 모든 패널 앞에
```
masterpiece, high score, great score, absurdres, semi-realistic, painterly, soft shading, detailed skin texture, highly detailed face, detailed eyes, realistic anatomy, mature anime film style, late 1990s theatrical anime, thin confident ink lines, detailed hair strands, detailed cloth folds, cinematic lighting, volumetric light, chiaroscuro, subtle film grain, deep background, cinematic color grading, film still,
```

### 공통 네거티브
```
lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry, chibi, childlike, big head, moe, mobile game illustration, flat color, flat shading, glossy plastic skin, 3d render, cgi, simple background, extra arms, extra legs, extra limbs, malformed hands, fused fingers, multiple views, duplicate, clone, 3boys, 3girls, crowd in foreground, logo, poster, border
```

### 패널 1 — 스파이크 + 페이, 스윙 (상단 왼쪽, 파랑·청록)
> 댄스스포츠 변형은 `gen_genre_multi.py` 의 `bebop_collage/dancesport` 참고 — 닫힌 홀드 태그를 앞에 둔다.
```
spiegel, v4l3nt1ne, 1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, dark green hair, messy fluffy hair, narrow eyes, navy suit, yellow shirt, loose black necktie, tall, lanky, purple hair, short bob, yellow hairband, green eyes, red lips, red backless halter dress, flared skirt, high heels, lindy hop, swing dance, partner dance, spinning, one hand connection, dress flaring with motion, leaning, dynamic pose, laughing, eye contact, only two people, couple centered, dark jazz club at night, large window, blue night sky, neon sign, jazz band on stage out of focus, blue and teal stage lighting, warm spotlight on couple, blurred crowd silhouettes, bokeh, polished floor reflection, full body, faces clearly visible, depth of field, detailed painted background
```

### 패널 2 — 빈센트 + 일렉트라, 살사·바차타 (상단 중앙, 빨강·황금)
```
ovirowa, 1boy, 1girl, couple, vincent volaju, electra ovilo, cowboy bebop: tengoku no tobira, cowboy bebop, tall gaunt man, long wavy black hair, stubble, sharp face, long black coat, dark red shirt, tan skin, dark brown hair, [교체: blonde hair, curly updo], wavy hair tied up, red dress, bare back, gold belt, hips pressed together, bachata, salsa, body wave, hand on waist, hand on shoulder, foreheads almost touching, rhythmic weight shift, intimate, only two people, couple centered, latin club at night, red neon sign, warm golden lamplight, red and gold lighting, blurred dancing crowd silhouettes, bokeh, polished floor reflection, full body, faces clearly visible, depth of field, detailed painted background
```

### 패널 3 — 줄리아 + 비셔스, 아르헨티나 탱고 (상단 오른쪽, 촛불·샹들리에)
```
1boy, 1girl, couple, julia \(cowboy bebop\), vicious \(cowboy bebop\), cowboy bebop, short wavy red hair, blue eyes, red lips, black slit dress, bare back, black heels, long silver hair, [교체: long black hair], pale skin, sharp hollow face, cold eyes, black suit, white shirt, argentine tango, close embrace, clear frame, chest to chest, leg hook, upright posture, stable balance, intense gaze, tension, only two people, couple centered, old grand hall, crystal chandelier, candlelight, deep shadows, warm amber glow, dark wood, blurred crowd silhouettes, bokeh, polished floor reflection, full body, faces clearly visible, depth of field, detailed painted background
```

### 패널 4·5·6 — 하단 스틸컷 (같은 커플, 다른 순간)
패널 1~3 프롬프트에서 **동작 구절만** 아래로 바꾸고 seed 를 +1 한다.
- 4(스윙): `jumping, kicking, mid-air, feet off the floor, big band on stage, checkered floor` + `wide shot, full moon through window`
- 5(살사·바차타): `spinning turn, arm raised, dress flaring, back to back, looking over shoulder`
- 6(탱고): `dip, leaning back, dramatic backbend, hand on back, close-up, upper body`

### 후처리(텍스트·인셋·조립)
글씨는 모델에 시키지 않는다. 조립 스크립트가 3:2 캔버스(예: 3072×2048)에 패널 6장을 넣고, 각 상단 패널 왼쪽 아래에 초상 2개(해당 패널에서 얼굴만 잘라 축소), 상단 문구·하단 `COWBOY BEBOP: THE MOVIE / 天国の扉`, 네이비 정보 영역을 Pillow 로 그린다.

---

## B. Illustrious XL v2.0 + 호환 애니 스타일 LoRA (로컬, `local-sd/server.py`)

A 와 같은 **패널 6장 + 후처리** 구조다. Illustrious 도 SDXL 이라 3:2 멀티패널·글씨는 못 그린다. 패널 프롬프트(장면 태그)는 A 의 패널 1~6 을 **그대로** 쓰고, 아래 접두·네거티브·설정만 바꾼다.

LoRA 는 이 저장소의 **Cowboy Bebop LoRA(Civitai 940639, Illustrious 학습)** 가 호환 1순위다 — Illustrious 로 학습된 LoRA 라 Animagine 보다 Illustrious 에서 얼굴이 덜 흔들린다(2026-10-03 룸바 실측). 범용 애니 스타일 LoRA 를 더 얹을 때는 Illustrious 학습본만 고르고 세기 0.3 이하로 둔다 — 셀 질감이 올라와 반실사 유화 느낌을 깎는다.

### 설정
| 항목 | 값 | 비고 |
|---|---|---|
| 해상도 | 832×1216 (2:3 세로) | |
| 샘플러 / 스텝 | DPM++ 2M Karras · 35 | Euler a 도 무난 |
| CFG | 5 | Illustrious v2.0 은 4~6 에서 안정 |
| clip skip | **주지 않는다** | diffusers 에 clip_skip 을 주면 v2.0 은 노이즈가 된다(2026-10-02 실측) |
| prediction | epsilon(기본) | v-pred 아님 — 2026-10-02 누수 사고 참고 |
| hires fix | ×1.5 · denoise 0.45 · 28 steps · LoRA 0.3 | |
| LoRA | cowboy-bebop-illustrious-v2 · **1단계 0 · 2단계 0.3** (C 설정) | 추가 스타일 LoRA 도 2단계에만, ≤0.3 |
| seed | 801 고정 | |
| 시간 | 한 장 약 1분(RTX 4060 8GB, HQ) | 2026-10-03 오후 글 인코더 CPU 내리기·VAE 타일링을 서버 기본값으로 켠 뒤. 그 전에는 17~19분 |

### 공통 접두 — 모든 패널 앞에
```
masterpiece, best quality, very aesthetic, absurdres, newest, semi-realistic, painterly, soft shading, detailed skin texture, highly detailed face, detailed eyes, realistic anatomy, mature anime film style, late 1990s theatrical anime, thin confident ink lines, detailed hair strands, detailed cloth folds, cinematic lighting, volumetric light, chiaroscuro, subtle film grain, deep background, cinematic color grading, film still,
```
Animagine 과 다른 점: `high score, great score` 같은 점수 태그는 Animagine 4.0 전용이라 뺀다. Illustrious 는 `very aesthetic`·`newest`(연도 계열 태그)를 읽는다.

### 공통 네거티브
```
worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, jpeg artifacts, signature, watermark, username, artist name, text, error, blurry, chibi, childlike, big head, moe, mobile game illustration, flat color, flat shading, glossy plastic skin, 3d, cgi, simple background, extra arms, extra legs, extra limbs, malformed hands, fused fingers, multiple views, duplicate, clone, 3boys, 3girls, crowd in foreground, logo, poster, border
```

### 패널 프롬프트
A 의 패널 1~6 과 동일. 트리거 단어(`spiegel`·`v4l3nt1ne`·`ovirowa`)도 같다. 패널 3(줄리아·비셔스)은 LoRA 에 트리거가 없어 캐릭터 태그 `julia \(cowboy bebop\)`·`vicious \(cowboy bebop\)` 에만 기댄다 — Illustrious 가 Danbooru 태그로 둘을 안다.

### 두 모델 중 고를 때
같은 seed·같은 패널 프롬프트로 A·B 를 한 장씩 뽑아 나란히 본 뒤 하나로 간다. 둘 다 6장씩 뽑으면 2시간이다.

---

## API 전달용 JSON
`bebop-poster-prompts.json` 에 같은 내용을 넣어 두었다. A·B 각각 로컬 서버 `/sdapi/v1/txt2img` 바디 6개(패널별)다. `override_settings.loras`(1단계 세기 0)와 `hr_lora_weight`(0.3)는 `local-sd/server.py` 가 읽는다.

---

## 알려진 약점 — 자세 (2026-10-03 룸바 C 실측)

C 설정의 룸바는 그림체·질감은 좋았지만 **마주보고 손잡는 댄스스포츠 홀드가 아니었다**(나란히 서서 한 손만 잡음). 원인은 룸바 프롬프트의
"standing apart, fingertips touching" 과 태그 모델의 느슨한 자세 추종이다. IP-Adapter 는 외형만 고치고 자세는 못 고친다. 고치는 순서:

| 순서 | 방법 | 비용 | 상태 |
|---|---|---|---|
| ① | 프롬프트 앞쪽에 `facing each other, closed hold, holding hands, dance frame`, negative 에 `standing apart, side by side, back to back` | 없음 | 콜라주 댄스스포츠에 적용 |
| ② | hires 없이 1024 로 seed 여러 개(장당 1분) → 홀드 맞는 seed 만 고품질 | 시간만 | 바로 가능 |
| ③ | img2img — 기준 콜라주의 칸을 초안으로, **denoise 0.35**(0.6 은 얼굴·비율이 무너짐, 2026-10-03 오후 실측) | `--init-image` 구현 | **실측 통과** — 댄스스포츠 칸에서 구도·의상·배경이 기준과 거의 같게 나왔다(`samples/collage-ds-i2i-*.jpg`). "똑같이"가 목표면 이 길이 기본이다 |
| ④ | ControlNet OpenPose 로 뼈대 강제 | VRAM +2.5GB | 8GB 에서 미검증, 해상도 낮춰야 할 가능성 |
