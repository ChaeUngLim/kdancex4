# 최종 세로 2:3 카드 세트 (2026-10-03 2차 기준)

파일명 `{모델}-{장르}.jpg`, 1024×1536, 장르명은 Pillow 로 왼쪽 위에 얹음. 모델은 Animagine XL 4.0 / Illustrious XL v2.0 / Pony V6 XL, 셋 다 C 설정(1단계 LoRA 0 · 2단계 0.3). Pony 는 글로만 뽑는 새 장면에서 캐릭터를 못 잡는다(비교용). Pony 스윙은 다리 보정 없음.

| 장르 | 만든 법 |
|---|---|
| Swing | 콜라주 왼쪽 위 칸(원제 "Swing (Dance Sports)")을 35% 다듬고 페이 하체만 75% 재생성(seed 803) → 가운데 2:3 크롭 |
| Argentine Tango · Salsa/Bachata | 콜라주 칸을 35% 다듬어 2:3 크롭 |
| Dance Sports | 새 장면(궁궐 창가 달빛, 스파이크+줄리아) 글로만 seed 806, 832×1248 → 1248×1872 |

초안·마스크는 `reference/cards/`, 프롬프트는 `docs/prototype/prompts/bebop-cards-4-prompts.md`. 하체 재생성은 `local-sd/fix_legs.py`.
17:09 경 `compare/2026-10-03-*`·`samples/cards/`·`samples/cards2/`·`reference/cards/` 가 사라졌다(원인 미확인, 생성은 결정적이라 재현 가능). 이 폴더는 남았다.
