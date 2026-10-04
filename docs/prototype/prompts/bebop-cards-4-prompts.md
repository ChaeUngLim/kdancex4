# 카우보이 비밥 극장판 소셜 댄스 카드 4장 — 생성 프롬프트 (2026-10-03, 2차 기준)

세로 2:3 모바일 카드 4장(댄스스포츠·스윙·살사/바차타·아르헨티나 탱고). 화풍 기준은 사용자가 준 비교 보드 두 장 — 왼쪽 「Animagine XL 4.0 + LAnime Style LoRA」(선명한 색·깔끔한 선·원작 애니 느낌), 오른쪽 「FLUX.2 [dev] + Anime Style LoRA」(세밀한 디테일·영화 조명·반실사). **두 모델 모두 아직 실행하지 않았다.** 프롬프트와 설정만이다.

## 공통 — 네 카드의 장면·인물

| 카드 | 커플 | 장면 | 조명·색 |
|---|---|---|---|
| Dance Sports | 스파이크 + 줄리아 | 궁궐 같은 무도회장, 높은 창으로 달빛. 가까운 홀드, 속삭이듯 마주 봄. 그리움과 사랑의 노래 | 은청색 달빛 + 촛불의 금빛 |
| Swing | 스파이크 + 페이 | 재즈 클럽, 밴드 무대 앞. 회전 중, 한 손 연결, 드레스가 퍼짐 | 파랑·청록 조명 |
| Salsa / Bachata | 빈센트 + 일렉트라 | 라틴 클럽, 네온. 밀착 홀드, 체중 이동 | 강한 빨강 + 따뜻한 금빛 |
| Argentine Tango | 줄리아 + 비셔스 | 샹들리에·촛불의 고풍스러운 홀. 명확한 프레임, 긴장된 시선 | 어두운 정장, 깊은 그림자, 호박색 |

**인물 외형(원작 기준)** — 두 기준 그림과 어긋나는 곳은 `[교체]` 로 표시했다. 기준 그림대로 가려면 그 태그로 바꾼다.
- 스파이크: 짙은 초록 더벅머리, 가는 눈, 길쭉한 체형, 남색 정장·노란 셔츠·느슨한 검은 타이
- 페이: 보라 단발, 노란 머리띠, 초록 눈, 빨간 입술. 춤 장면은 빨간 백리스 드레스(원작 옷은 노란 크롭탑·반바지)
- 줄리아: 금발 큰 웨이브(원작) `[교체: 붉은 짧은 웨이브 — 두 기준 그림]`, 푸른 눈, 검은 슬릿 드레스
- 비셔스: 긴 은발(원작) `[교체: 긴 흑발 — 콜라주 기준]`, 창백한 피부, 날카로운 얼굴, 검은 정장
- 빈센트: 긴 곱슬 흑발, 콧수염·턱수염, 긴 검은 코트
- 일렉트라: 갈색 피부, 짙은 갈색 머리 묶음(원작) `[교체: 금발 올림머리 — 콜라주 기준]`, 빨간 드레스

**글씨·파일명** — 카드 왼쪽 위 장르명(`Dance Sports` / `Argentine Tango` / `Swing` / `Salsa/Bachata`)은 모델에게 시키지 않고 Pillow 후처리로 얹는다. 파일명은 `{모델}-{장르}.jpg`: `animagine-lanime-dancesport.jpg`, `flux2-anime-swing.jpg` 식.

**캐릭터 참조 이미지** — `docs/prototype/assets/genres/refs/{spike,faye,julia,vicious,vincent}.jpg`(일렉트라는 없음). B(FLUX.2)는 참조 이미지를 직접 받는다. A(Animagine)는 IP-Adapter 가 있어야 하는데 2026-10-03 실측에서 8GB 에 안 들어갔다(피크 12.2GB). 글 인코더 내리기 뒤에는 상주가 5.1GB 라 다시 잴 여지가 있지만 **미검증**이다.

---

## A. Animagine XL 4.0 + LAnime Style LoRA

### 설정
| 항목 | 값 | 비고 |
|---|---|---|
| 해상도 | 832×1248 (2:3) | SDXL 버킷에 가까운 832×1216 도 가능 |
| 샘플러 / 스텝 | DPM++ 2M Karras · 35 | |
| CFG | 5 | |
| hires fix | ×1.5 · denoise 0.45 · 28 steps | 1248×1872 |
| LoRA | LAnime Style LoRA 0.6 **[파일 미보유 — 저장소에 없다]** + Cowboy Bebop LoRA(Illustrious 학습, Animagine 에서 동작) 2단계만 0.3 | C 설정. 스타일 LoRA 는 Animagine/SDXL 학습본인지 확인 |
| clip skip | 주지 않는다 | |
| VRAM | 글 인코더 CPU 내리기 · VAE 타일링(서버 기본값) | 한 장 1~2분 |
| seed | 801 | |

### 공통 접두
```
masterpiece, high score, great score, absurdres, anime screencap, late 1990s theatrical anime film, clean sharp lineart, vivid saturated colors, cel shading with soft gradients, detailed hair strands, detailed cloth folds, cinematic lighting, volumetric light, dramatic shadows, subtle film grain, deep painted background, mature anime style, realistic adult proportions,
```
### 공통 네거티브
```
lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry, chibi, childlike, big head, moe, mobile game illustration, flat color, glossy plastic skin, 3d render, cgi, extra arms, extra legs, extra limbs, malformed hands, fused fingers, multiple views, duplicate, clone, 3boys, 3girls, logo, poster, border
```

### A-1 Dance Sports — 스파이크 + 줄리아
```
spiegel, 1boy, 1girl, couple, spike spiegel, julia \(cowboy bebop\), cowboy bebop, dark green hair, messy hair, narrow eyes, navy suit, yellow shirt, loose black necktie, tall, lanky, blonde hair, long wavy hair, [교체: red hair, short wavy hair,] blue eyes, red lips, black slit dress, bare back, ballroom dance, rumba, close hold, facing each other, holding hands, hand on back, foreheads almost touching, whispering, longing gaze, tender, only two people, couple centered, palace ballroom, tall arched windows, moonlight streaming through window, silver blue moonlight, candlelight, golden candle glow, marble floor reflection, chandelier, deep shadows, full body, portrait orientation, faces clearly visible, detailed faces, depth of field, detailed painted background
```
### A-2 Swing — 스파이크 + 페이
```
spiegel, v4l3nt1ne, 1boy, 1girl, couple, spike spiegel, faye valentine, cowboy bebop, dark green hair, messy hair, navy suit, yellow shirt, loose necktie, purple hair, short bob, yellow hairband, green eyes, red lips, red backless dress, flared skirt, high heels, lindy hop, swing dance, spinning, one hand connection, dress flaring with motion, dynamic pose, laughing, only two people, couple centered, dark jazz club at night, big band on stage in blurred background, blue and teal stage lighting, neon sign glow, polished floor reflection, blurred crowd silhouettes, bokeh, full body, portrait orientation, faces clearly visible, detailed faces, depth of field, detailed painted background
```
### A-3 Salsa / Bachata — 빈센트 + 일렉트라
```
ovirowa, 1boy, 1girl, couple, vincent volaju, electra ovilo, cowboy bebop: tengoku no tobira, cowboy bebop, tall gaunt man, long wavy black hair, stubble, long black coat, dark red shirt, tan skin, dark brown hair, hair tied up, [교체: blonde hair, curly updo,] red dress, bare back, gold belt, bachata, salsa, hips pressed together, hand on waist, hand on shoulder, rhythmic weight shift, foreheads almost touching, intimate, only two people, couple centered, latin club at night, red neon sign, warm golden lamplight, red and gold lighting, blurred dancing crowd, bokeh, polished floor reflection, full body, portrait orientation, faces clearly visible, detailed faces, depth of field, detailed painted background
```
### A-4 Argentine Tango — 줄리아 + 비셔스
```
1boy, 1girl, couple, julia \(cowboy bebop\), vicious \(cowboy bebop\), cowboy bebop, blonde hair, long wavy hair, [교체: red hair, short wavy hair,] blue eyes, red lips, black slit dress, bare back, black heels, long silver hair, [교체: long black hair,] pale skin, sharp hollow face, cold eyes, black suit, white shirt, argentine tango, close embrace, clear dance frame, chest to chest, stable balance, intense gaze, tension, only two people, couple centered, old grand hall, crystal chandelier, candlelight, deep shadows, warm amber glow, dark wood, polished floor reflection, full body, portrait orientation, faces clearly visible, detailed faces, depth of field, detailed painted background
```

---

## B. FLUX.2 [dev] + Anime Style LoRA

### 설정
| 항목 | 값 | 비고 |
|---|---|---|
| 해상도 | 1024×1536 (2:3) | 가능하면 1344×2016 |
| guidance | 3.5 | |
| steps | 32 | |
| LoRA | Anime Style LoRA 0.8 — 저장소 기록은 Civitai 2301918 「flux-2-trainer-v2_2D_Cel」(FLUX.2 D 학습) | **SDXL LoRA 는 쓸 수 없다**(구조가 다름). FLUX.2 학습본만 |
| 참조 이미지 | 커플별 캐릭터 참조 2장(`refs/`)을 `input_image` 로 | 외형 유지의 핵심. 텍스트만으로는 FLUX 가 비밥 인물을 모른다 |
| 네거티브 | 없음(FLUX 는 안 받는다) | 피할 것은 본문에 "not …" 로 |
| seed | 801 | |
| 실행처 | Civitai(무료 Buzz, 키 필요) 또는 Cloudflare Workers AI(무료 구간, **LoRA 미지원**) | 둘 다 무료 구간 안에서만. 한도 끝나면 멈춘다 |

### 공통 문단(각 프롬프트 앞)
```
A vertical 2:3 cinematic still in the mature style of a late-1990s Japanese theatrical anime film: precise confident line art, natural adult proportions, finely drawn hair strands and cloth folds, volumetric cinematic lighting with deep shadows, subtle film grain, a deep painted background, refined color grading. Semi-realistic anime, not cute, not chibi, no mobile-game gloss, no 3D render look. Exactly two people, correct hands and limbs, no extra limbs. Keep the two characters' faces, hairstyles, body types and costumes consistent with the reference images; do not reinterpret them as other characters. Leave the top-left corner free of detail for a title.
```
### B-1 Dance Sports
```
Inside a palace ballroom like a fairy-tale castle, moonlight pours through tall arched windows in silver-blue beams while candles add a warm gold glow and the marble floor mirrors the light. A tall lanky man with dark green fluffy messy hair, narrow eyes, a navy suit, yellow shirt and loose black tie (Spike Spiegel) holds a woman with long wavy blonde hair [교체: short wavy red hair], blue eyes and red lips in a black slit dress (Julia) in a close rumba hold. They face each other, foreheads almost touching, as if whispering a song of longing and love. Tender, quiet, intimate. Full body, both faces clearly visible.
```
### B-2 Swing
```
In a dark jazz club under blue and teal stage light, a big band plays out of focus behind them and a neon sign glows. Spike Spiegel (dark green messy hair, navy suit, yellow shirt, loose tie) swings Faye Valentine (short purple bob, yellow hairband, green eyes, red lips, red backless dress) through a fast spin: a single-hand connection, her dress flaring with the motion, both laughing. The polished floor reflects the lights; the crowd is a blur of silhouettes. Full body, dynamic, both faces clearly visible.
```
### B-3 Salsa / Bachata
```
In a latin club at night, intense red neon and warm golden lamplight wash over the floor and a blurred crowd dances behind. A tall gaunt man with long wavy black hair, stubble and a long black coat over a dark red shirt (Vincent Volaju) dances bachata pressed close to a tan woman with dark brown hair tied up [교체: a blonde curly updo] in a red dress with a gold belt (Electra Ovilo). His hand at her waist, hers on his shoulder, a rhythmic shift of weight, foreheads almost touching. Full body, intimate, both faces clearly visible.
```
### B-4 Argentine Tango
```
In an old grand hall lit by a crystal chandelier and candles, with deep shadows and amber light on dark wood, a woman with long wavy blonde hair [교체: short wavy red hair], blue eyes and red lips in a black slit dress (Julia) holds a tense Argentine tango frame with a pale, sharp-faced man with long silver hair [교체: long black hair] in a black suit and white shirt (Vicious). Clear frame, chest to chest, stable balance, a dramatic locked gaze full of tension. Full body, both faces clearly visible.
```

---

## 후처리와 파일명
1. 생성본 왼쪽 위에 장르명을 Pillow 로 얹는다(세리프 흰 글씨, 그림자). 모델이 쓴 글씨는 쓰지 않는다.
2. 저장: `animagine-lanime-{dancesport|swing|salsa_bachata|tango}.jpg`, `flux2-anime-{…}.jpg`.
3. A 는 로컬 서버(`local-sd/server.py`) 바디, B 는 Civitai 요청 형태로 `bebop-cards-4-prompts.json` 에 같이 둔다.

## 미확인·주의
- 「LAnime Style LoRA」 파일이 저장소에 없다. Animagine/SDXL 학습본인지 확인한 뒤 `~/models/sdxl/lora/` 에 둔다. 그 전까지 A 는 Cowboy Bebop LoRA 만으로 돈다.
- FLUX.2 는 오늘 실행 조건이 안 됐다(Civitai 무료 Buzz 소진 이력, Cloudflare 는 LoRA 미지원). 무료 구간이 풀리면 돌린다.
- 두 기준 그림의 줄리아(붉은 머리)·비셔스(흑발/금발)·일렉트라(금발)는 원작과 다르다. 본문은 원작, `[교체]` 가 기준 그림이다.
