# 샘플 — C 설정 기준 (2026-10-03)

앞으로 카드를 만들 때 비교 기준으로 쓰는 그림이다.

| 파일 | 무엇 | 설정 |
|---|---|---|
| `C-rumba-illustrious-seed801.jpg` | 룸바 · 스파이크+줄리아 · Illustrious XL v2.0 | **C 설정** — 1단계(1024) LoRA 0 → 2단계(1536, denoise 0.45) LoRA 0.3 · DPM++ 2M Karras 35 · CFG 5 · seed 801. 모델 이름 라벨이 구워져 있다 |
| `C-rumba-illustrious-seed801-clean.jpg` | 같은 조건, 라벨 없음 | 같은 seed 로 `--no-label` 재생성(12:58 완료) |
| `collage-ds-i2i-illustrious.jpg` · `collage-ds-i2i-animagine.jpg` | 기준 콜라주의 댄스스포츠 칸을 **img2img 초안**(60% 재생성)으로 넣은 결과 | C 설정 + `--init-image reference/dancesport-init.png --init-strength 0.6`. 기준 칸의 구도·빨간 드레스·재즈 클럽이 그대로 왔다. 라벨 있음 |
| `collage-ds-vs-reference.jpg` | 기준 칸 + 생성 5장 나란히 | 글로만 2장 / img2img 2장 / IP-Adapter 1장 |
| `ABC-rumba-compare.jpg` | A·B·C 나란히 | A 두 단계 0.3 / B 1단계만 0.3 / C 2단계만 0.3. 사용자가 C 를 골랐다 |

재현 명령(루트에서):
```
HR_LORA=0.3 bash docs/prototype/local-sd/hq_one_by_one.sh bebop_spike_faye local-illustrious-bebop-lora 0 <run_id> dancesport
```

약점과 고치는 법은 `docs/prototype/prompts/bebop-poster-prompts.md` 의 「알려진 약점 — 자세」, 실험 경위는 `docs/Review.md` 2026-10-03 ⑧.
