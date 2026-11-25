# 최종 발표 제출물 — 임채웅

제출 조건: 파일명 `이름_발표장표` · PDF 또는 프레젠테이션(최대 100MB) · 발표 장표 말고 첨부 파일은 최대 5개.

## 발표 장표

| 파일 | 형식 | 크기 | 장 수 |
|---|---|---|---|
| `임채웅_발표장표.pptx` | PowerPoint 16:9 | 약 1.4MB | 21 |
| `임채웅_발표장표.pdf` | PDF(1280×720 한 장씩) | 약 2.2MB | 21 |

두 파일은 같은 원본 데이터로 만들어 내용과 순서가 같다. 다시 만들 때(저장소 루트):

```
uv run --with python-pptx --with pillow python scripts/build_submission_deck.py
```

PDF 는 Playwright 가 받아 둔 크롬(`~/.cache/ms-playwright/chromium-1255`)으로 찍는다. PPTX 는 글꼴 이름을 `Noto Sans KR` 로 적어 두었다. 발표할 PC 에 이 글꼴이 없으면 PowerPoint 가 다른 글꼴로 바꿔 보여 주니, 글꼴을 따로 설치할 수 없는 PC 에서는 PDF 로 발표한다.

## 첨부 후보 (최대 5개 중 4개)

영상은 여기로 복사하지 않았다. 아래 경로의 원본을 그대로 첨부한다.

| 순서 | 파일 | 길이 · 크기 | 내용 | 위치 |
|---|---|---|---|---|
| 1 | `highlight.mp4` | 1분 30초 · 약 1.9MB | 시연 요약(회원 30초 · 강사 30초 · 대표 30초) — **제출용** | `_workspace/evidence/demo-video-emulator-2026-11-25/highlight.mp4` |
| 2 | 기능명세서 PDF | — | 기능 명세 | 이 폴더(다른 작업에서 만든다) |
| 3 | `full.mp4` | 9분 3초 · 약 10.9MB | 로그인 입구 → 회원 → 강사 → 대표 전체 흐름 | `_workspace/evidence/demo-video-emulator-2026-11-25/full.mp4` |
| 4 | `levelup.mp4` | 36초 · 약 0.5MB | 회원 레벨업 카드 발급 연출 | `_workspace/evidence/demo-video-emulator-2026-11-25/levelup.mp4` |

영상 형식은 1440×900 H.264 mp4 다. 녹화 경위와 장면별 확인 기록은 같은 폴더의 `EVIDENCE.md` 에 있다.
