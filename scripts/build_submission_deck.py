"""최종 발표 장표 생성기 — PPTX 와 PDF 를 같은 원본 데이터에서 만든다.

실행(저장소 루트, 일회성 환경 — 프로젝트 의존성에 넣지 않는다):
    uv run --with python-pptx --with pillow python scripts/build_submission_deck.py

무엇을 하나
- 슬라이드를 「도형·글자·그림」 목록으로 한 번만 정의한다(좌표는 1280×720 픽셀 기준).
- 같은 목록을 두 번 그린다: python-pptx 로 PPTX, HTML 로 그린 뒤 Playwright 가 받아 둔 크롬으로 PDF.
  원본이 하나라 두 파일의 내용·순서가 어긋나지 않는다.
- 휴대폰 캡처(1080×2400 PNG)는 Pillow 로 줄여 JPEG 로 바꾼다 — 파일 크기를 제출 한도(100MB) 안에 두려고.

근거 수치는 모두 _workspace/evidence/* 와 _workspace/roadmap-tasks.json 실측값이다(슬라이드 안에 출처를 적었다).
"""
from __future__ import annotations

import html
import json
import shutil
import subprocess
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "submission"
OUT_PPTX = OUT_DIR / "임채웅_발표장표.pptx"
OUT_PDF = OUT_DIR / "임채웅_발표장표.pdf"
EV = ROOT / "_workspace" / "evidence"
DEMO = EV / "demo-video-emulator-2026-11-25"
GENRE = EV / "genre-cards-2026-11-25" / "screens"
CHROME = Path.home() / ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
FONT_DIR = Path.home() / ".fonts"

# ---- 테마: 아이보리 바탕 + 딥 플럼 강조 + 샴페인 포인트(mobile/lib/theme.ts 값). 녹색은 쓰지 않는다 ----
IVORY = "F4F1EC"
SURFACE = "FFFFFF"
INK = "141216"
INK2 = "4A4450"
INK3 = "8B8490"
LINE = "E4DED6"
PLUM = "5B3A63"
PLUM_DARK = "2E1F33"
PLUM_SOFT = "EDE4EF"
CHAMP = "C9A96E"
CHAMP_SOFT = "F6EFE2"
FRAME = "1E1A22"

FONT = "Noto Sans KR"  # PPTX 에는 글꼴 이름만 적는다. PDF 는 ~/.fonts 의 Noto Sans CJK KR 로 그린다
W, H = 1280, 720
PX_EMU = 9525  # 1px(1/96인치) = 9525 EMU


# ================= 원본 데이터 모델 =================
@dataclass
class Rect:
    x: float; y: float; w: float; h: float
    fill: str | None = None
    line: str | None = None
    radius: float = 0  # 픽셀


@dataclass
class Text:
    x: float; y: float; w: float; h: float
    lines: list[str]
    size: float = 16  # pt
    color: str = INK
    bold: bool = False
    align: str = "left"  # left | center | right
    valign: str = "top"  # top | middle | bottom


@dataclass
class Img:
    x: float; y: float; w: float; h: float
    path: Path
    radius: float = 0


@dataclass
class Slide:
    title: str
    items: list = field(default_factory=list)
    bg: str = IVORY

    def add(self, *els):
        self.items.extend(els)
        return self


# ================= 그림 준비 =================
_IMG_CACHE: dict[Path, tuple[Path, int, int]] = {}
_TMP = Path(tempfile.mkdtemp(prefix="kdance-deck-"))


def prep(src: Path) -> tuple[Path, int, int]:
    """원본 캡처를 줄여 JPEG 로 저장하고 (경로, 폭, 높이)를 돌려준다. 같은 그림은 한 번만 만든다."""
    if src in _IMG_CACHE:
        return _IMG_CACHE[src]
    im = Image.open(src).convert("RGB")
    long_side = 1100 if im.height > im.width else 1600
    scale = min(1.0, long_side / max(im.size))
    if scale < 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    out = _TMP / f"{len(_IMG_CACHE):02d}-{src.stem}.jpg"
    im.save(out, "JPEG", quality=86, optimize=True)
    _IMG_CACHE[src] = (out, im.width, im.height)
    return _IMG_CACHE[src]


# ================= 공통 부품 =================
def frame(s: Slide, n: int, total: int, section: str, title: str):
    """내용 슬라이드 공통 머리: 구역 이름(샴페인) · 제목 · 아래 쪽 번호."""
    s.add(
        Rect(0, 0, 10, H, fill=PLUM),
        Text(56, 34, 900, 22, [section], size=11, color=CHAMP, bold=True),
        Text(56, 58, 1170, 48, [title], size=26, color=INK, bold=True),
        Rect(56, 112, 64, 4, fill=CHAMP),
        Text(1100, 684, 140, 20, [f"{n} / {total}"], size=10, color=INK3, align="right"),
        Text(56, 684, 600, 20, ["K-DanceX4 · 임채웅"], size=10, color=INK3),
    )


def phone(s: Slide, src: Path, x: float, y: float, h: float, caption: str | None = None,
          cap_w: float | None = None) -> float:
    """휴대폰 캡처 한 장을 어두운 테두리 안에 놓는다. 그린 폭을 돌려준다."""
    p, iw, ih = prep(src)
    w = h * iw / ih
    b = 5
    s.add(Rect(x - b, y - b, w + 2 * b, h + 2 * b, fill=FRAME, radius=18),
          Img(x, y, w, h, p, radius=13))
    if caption:
        cw = cap_w or (w + 40)
        s.add(Text(x + w / 2 - cw / 2, y + h + 14, cw, 44, [caption], size=11.5, color=INK2,
                   align="center"))
    return w


def phones_row(s: Slide, srcs_caps: list[tuple[Path, str]], y: float = 140, h: float = 470,
               gap: float = 46, x0: float | None = None, x1: float | None = None):
    """휴대폰 여러 장을 가운데 정렬로 나란히 둔다."""
    widths = [h * prep(p)[1] / prep(p)[2] for p, _ in srcs_caps]
    total = sum(widths) + gap * (len(widths) - 1)
    left = x0 if x0 is not None else 56
    right = x1 if x1 is not None else W - 56
    x = left + (right - left - total) / 2
    for (p, cap), w in zip(srcs_caps, widths):
        phone(s, p, x, y, h, cap, cap_w=w + gap - 6)
        x += w + gap


def card(s: Slide, x, y, w, h, head: str, body: list[str], head_color=PLUM, size=13.5,
         fill=SURFACE, head_size=16):
    s.add(Rect(x, y, w, h, fill=fill, line=LINE, radius=14),
          Rect(x + 20, y + 22, 4, 22, fill=CHAMP),
          Text(x + 34, y + 16, w - 50, 36, [head], size=head_size, bold=True, color=head_color),
          Text(x + 22, y + 60, w - 44, h - 72, body, size=size, color=INK2))


def note(s: Slide, txt: str, y: float = 650):
    s.add(Text(56, y, 1170, 22, [txt], size=10, color=INK3))


# ================= 실측값 읽기 =================
def roadmap_stats():
    data = json.loads((ROOT / "_workspace" / "roadmap-tasks.json").read_text())
    tasks = data["tasks"]
    by_ms: dict[str, Counter] = defaultdict(Counter)
    for t in tasks:
        by_ms[t["milestone"]][t["status"]] += 1
    return data["updated"][:10], len(tasks), Counter(t["status"] for t in tasks), by_ms


# ================= 슬라이드 정의 =================
def build_slides() -> list[Slide]:
    S: list[Slide] = []
    TOTAL = 21
    upd, n_tasks, st, by_ms = roadmap_stats()
    done = st["done"]

    # 1 표지 — 캐릭터 그림은 장식으로 쓰지 않는다(저작권 메모)
    s = Slide("표지", bg=PLUM_DARK)
    s.add(
        Rect(0, 0, 14, H, fill=CHAMP),
        Text(96, 150, 900, 28, ["최종 발표"], size=14, color=CHAMP, bold=True),
        Text(96, 186, 1100, 120, ["K-DanceX4"], size=66, color="FFFFFF", bold=True),
        Text(96, 300, 1100, 44, ["AI 소셜댄스 수업 예약·멤버십 플랫폼"], size=26, color="F1E9F3"),
        Rect(96, 370, 80, 4, fill=CHAMP),
        Text(96, 396, 1100, 60, ["회원은 찾고, 강사는 올리고, 대표는 승인한다 — 한곳에서",
                                 "Android 앱(회원 · 강사 · 대표) + 관리자 웹 + AI 에이전트 서버"],
             size=15, color="D9CCDC"),
        Text(96, 588, 600, 36, ["임채웅"], size=20, color="FFFFFF", bold=True),
        Text(96, 626, 600, 24, ["2026-11-25"], size=13, color="D9CCDC"),
    )
    S.append(s)

    # 2 목차
    s = Slide("목차"); frame(s, 2, TOTAL, "CONTENTS", "목차")
    toc = [("01", "문제와 해결", "소셜댄스 수업·학원 운영의 불편"),
           ("02", "사용자와 기능", "4역할 · 장르 4종 · 핵심 기능"),
           ("03", "시연 화면", "로그인 · 회원 · 강사 · 대표 (에뮬레이터 실제 캡처)"),
           ("04", "시스템과 AI", "아키텍처 · 포스터 읽기 · 말로 찾기 · 홍보 이미지"),
           ("05", "보안 · 품질 · 개발 방식", "2단계 인증 · 테스트 실측 · 4계층"),
           ("06", "진행 현황과 계획", "로드맵 · 시연 영상 · 다음 단계")]
    for i, (no, head, sub) in enumerate(toc):
        col, row = i % 2, i // 2
        x, y = 56 + col * 590, 150 + row * 160
        s.add(Rect(x, y, 560, 130, fill=SURFACE, line=LINE, radius=14),
              Text(x + 28, y + 28, 80, 50, [no], size=30, bold=True, color=CHAMP),
              Text(x + 120, y + 30, 420, 34, [head], size=19, bold=True, color=INK),
              Text(x + 120, y + 72, 420, 40, [sub], size=12.5, color=INK3))
    S.append(s)

    # 3 문제 정의
    s = Slide("문제"); frame(s, 3, TOTAL, "01 문제와 해결", "학원 · 강사 · 회원이 각자 따로 고생한다")
    cols = [("학원(대표)", ["장르 취향이 맞는 수강생을 블로그·SNS 로는 걸러 찾기 어렵다",
                           "현금·계좌이체·카드가 섞인 결제를 손으로 정산한다",
                           "수업 등록·예약 확인·알림을 원장이 손으로 한다"]),
            ("강사(프리랜서)", ["여러 학원을 다녀 일정이 흩어진다",
                              "급여가 아니라 끝난 수업 몫만 받는다 — 언제 얼마인지 알기 어렵다",
                              "수강생 레벨·이력이 쌓이지 않아 새 반을 열기 어렵다"]),
            ("회원(수강생)", ["여러 학원·강사 수업을 한곳에서 찾을 수 없다",
                            "남·여 짝을 맞추는 수업이라 정원이 성별로 갈린다",
                            "학원마다 환불 규정이 달라 미리 알기 어렵다"])]
    for i, (head, body) in enumerate(cols):
        card(s, 56 + i * 396, 150, 372, 300, head, [f"• {b}" for b in body], size=14.5,
             head_size=19)
    note(s, "근거: PRD 2절(문제와 기회) · spec US1~US9(사용자 스토리). 이 장에는 검증하지 않은 외부 수치를 넣지 않았다.", 480)
    S.append(s)

    # 4 해결책
    s = Slide("해결"); frame(s, 4, TOTAL, "01 문제와 해결", "수업 한 건이 등록부터 신청까지 한 앱 안에서 흐른다")
    flow = ["강사 등록", "대표 승인", "회원 노출", "신청 · 결제", "수강 · 레벨"]
    for i, f in enumerate(flow):
        x = 56 + i * 236
        s.add(Rect(x, 150, 206, 70, fill=PLUM if i < 4 else CHAMP, radius=35),
              Text(x, 150, 206, 70, [f], size=17, bold=True, color="FFFFFF", align="center",
                   valign="middle"))
        if i < 4:
            s.add(Text(x + 206, 150, 30, 70, ["›"], size=24, color=INK3, align="center",
                       valign="middle"))
    vals = [("한곳에서 찾고 신청", ["장르 · 레벨 · 일정 · 남녀 잔여석을 보고 바로 신청",
                               "학원 환불 공지는 결제 전에 반드시 보여 준다"]),
            ("운영 일을 앱으로", ["수업 등록 → 대표 승인 → 공개가 앱 안에서 끝난다",
                              "강사 소속 · 권한 · 명단 · 공지를 대표가 직접 관리"]),
            ("AI 가 일을 덜어 준다", ["포스터 한 장 → 수업 초안",
                                 "「주말 수업 알려줘」 → 수업 카드",
                                 "한 줄 설명 → 홍보 이미지"])]
    for i, (head, body) in enumerate(vals):
        card(s, 56 + i * 396, 270, 372, 250, head, [f"• {b}" for b in body], size=14.5,
             head_size=18)
    note(s, "양면 시장 — 수요(회원)와 공급(강사 · 대표) 중 하나만 있으면 거래가 0건이라, 회원 신청(US1)과 강사 수업 관리(US2)를 함께 1순위로 두었다.", 560)
    S.append(s)

    # 5 사용자 4역할 · 장르 4종
    s = Slide("역할"); frame(s, 5, TOTAL, "02 사용자와 기능", "사용자 4역할 · 장르 4종")
    roles = [("회원", "수업 찾기 · 신청 · 결석 예정 알리기 · 레벨 카드", "회원 앱"),
             ("강사", "수업 등록 · 명단 · 레벨 정하기 · 홍보 이미지", "강사·대표 앱"),
             ("대표", "강사 소속 승인 · 수업 승인 · 공지 · 정산", "강사·대표 앱 + 관리자 웹"),
             ("운영자", "신고 처리 · 플랫폼 정산 조회 · 입점 심사", "관리자 웹")]
    for i, (r, job, dev) in enumerate(roles):
        x = 56 + i * 296
        s.add(Rect(x, 150, 276, 250, fill=SURFACE, line=LINE, radius=14),
              Rect(x, 150, 276, 8, fill=PLUM if i < 3 else CHAMP),
              Text(x + 24, 178, 230, 40, [r], size=22, bold=True, color=PLUM),
              Text(x + 24, 230, 230, 90, [job], size=13.5, color=INK2),
              Text(x + 24, 350, 230, 30, [dev], size=11.5, bold=True, color=INK3))
    s.add(Text(56, 430, 600, 28, ["장르 4종(세부 장르까지 고른다)"], size=15, bold=True, color=INK))
    genres = [("댄스스포츠", "라틴 · 스탠다드"), ("아르헨티나 탱고", "밀롱가"),
              ("스윙댄스", "린디합 · 찰스턴"), ("살사 / 바차타", "라틴 클럽")]
    for i, (g, sub) in enumerate(genres):
        x = 56 + i * 296
        s.add(Rect(x, 470, 276, 84, fill=CHAMP_SOFT, line=CHAMP, radius=42),
              Text(x, 482, 276, 30, [g], size=17, bold=True, color=INK, align="center"),
              Text(x, 515, 276, 24, [sub], size=12, color=INK2, align="center"))
    note(s, "앱은 둘(회원 앱 · 강사·대표 앱), 서버는 하나. 한 사람이 여러 역할을 함께 가질 수 있다 — PRD 4절 · FR-004(역할 4종·복수 역할) · FR-011a(역할별 화면·강사·대표 입구).", 590)
    S.append(s)

    # 6 핵심 기능 한눈에
    s = Slide("기능"); frame(s, 6, TOTAL, "02 사용자와 기능", "핵심 기능 한눈에")
    feats = [("회원", ["장르 사진 카드 · 세부 장르 고르기", "수업 찾기 · 남녀 잔여석 · 신청",
                      "AI 플래너 — 말로 수업 찾기", "레벨업 알림 · 레벨 카드 모음"]),
             ("강사", ["수업 만들기(일정 겹침 검사)", "홍보 이미지 AI 생성(하루 3회)",
                      "오늘 수업 명단 · 결석 예정", "레벨 정하기 → 승급 안내"]),
             ("대표", ["강사 소속 승인 · 몫 비율 입력", "수업 승인 → 회원 앱에 공개",
                      "예약·명단 · 학원 공지 · 앱 페이지", "관리자 웹 2단계 인증"]),
             ("운영자", ["신고 처리", "플랫폼 정산 조회",
                        "권한 행렬로 메뉴 · 경로 차단", "관리자 웹 2단계 인증"])]
    for i, (head, body) in enumerate(feats):
        card(s, 56 + i * 296, 150, 276, 320, head, [f"• {b}" for b in body], size=14,
             head_size=20)
    note(s, "모두 이번 시연 영상과 증거 스크린샷(_workspace/evidence/*-2026-11-25)으로 동작을 확인한 기능이다. 실결제 · 환불 · 정산 지급은 아직이다(18장).", 500)
    S.append(s)

    # 7 시연 ① 로그인
    s = Slide("시연-로그인"); frame(s, 7, TOTAL, "03 시연 화면", "로그인 — 회원 화면은 단순하게, 직원 입구는 숨겨 둔다")
    phones_row(s, [(DEMO / "01-entry-member-login.png", "회원 로그인 — 직원 표시 없음"),
                   (DEMO / "02-entry-instructor-login.png", "바탕 3번 탭 → 강사 로그인"),
                   (DEMO / "03-entry-owner-login.png", "대표 탭으로 전환")],
               x0=56, x1=840)
    s.add(Rect(870, 160, 354, 400, fill=SURFACE, line=LINE, radius=14),
          Text(894, 184, 310, 30, ["역할별 로그인"], size=17, bold=True, color=PLUM),
          Text(894, 228, 310, 320,
               ["• 회원: 이메일 · 비밀번호",
                "• 강사·대표 앱: 아이디 · 비밀번호(앱 전용 경로, ADR-007)",
                "• 관리자 웹: 비밀번호 + 인증 앱 6자리(FR-303(관리자 웹 2단계 인증))",
                "• 회원 화면에 강사·대표 버튼을 두지 않아 혼동을 줄였다"],
               size=13.5, color=INK2))
    S.append(s)

    # 8 시연 ② 회원 — 장르 사진 카드
    s = Slide("시연-장르"); frame(s, 8, TOTAL, "03 시연 화면 · 회원", "장르 사진 카드가 3초마다 바뀌고, 누른 사진의 세부 장르가 골라진다")
    phones_row(s, [(GENRE / "01-base-genre-moment-a.png", "처음 — 쌈바 · 살사 사진"),
                   (GENRE / "02-base-genre-moment-b.png", "3초 뒤 — 비엔나왈츠 · 바차타"),
                   (DEMO / "13-member-genre-latin-picked.png", "라틴 사진에서 누름 → 「라틴」"),
                   (DEMO / "14-member-home-latin.png", "홈이 라틴 수업만 보여 줌")])
    S.append(s)

    # 9 시연 ③ 회원 — AI 플래너 · 레벨 카드
    s = Slide("시연-플래너"); frame(s, 9, TOTAL, "03 시연 화면 · 회원", "말로 수업을 찾고, 강사가 올려 준 레벨은 카드로 받는다")
    phones_row(s, [(DEMO / "21-member-planner-answer.png", "AI 플래너 — 강사 이름으로 찾은 수업"),
                   (DEMO / "46-levelup-alert.png", "LEVEL UP 알림"),
                   (DEMO / "49-levelup-card.png", "카드 발급 — Waltz Lv.3"),
                   (DEMO / "51-levelup-collection.png", "마이 › 레벨 카드 모음")])
    S.append(s)

    # 10 시연 ④ 강사 — 회원 관리 · 레벨
    s = Slide("시연-강사1"); frame(s, 10, TOTAL, "03 시연 화면 · 강사", "오늘 수업 명단을 보고, 수강생 레벨을 정한다")
    phones_row(s, [(DEMO / "41-inst-home-today.png", "강사 홈 — 오늘 수업 · 남녀 인원"),
                   (DEMO / "42-inst-roster.png", "명단 — 결석 예정이 맨 위"),
                   (DEMO / "43-inst-level-sheet.png", "레벨 정하기(여러 명 한 번에)"),
                   (DEMO / "44-inst-level-applied.png", "「2명에게 승급 안내를 보냈어요」")])
    S.append(s)

    # 11 시연 ⑤ 강사 — 수업 등록 · 홍보 이미지
    s = Slide("시연-강사2"); frame(s, 11, TOTAL, "03 시연 화면 · 강사", "수업을 만들고, 홍보 이미지는 AI 가 그린다")
    phones_row(s, [(DEMO / "51-inst-class-step1.png", "수업 만들기 — 「겹치는 일정 없어요」"),
                   (DEMO / "53-inst-promo-chips.png", "칩으로 원하는 이미지 설명"),
                   (DEMO / "55-inst-promo-result.png", "AI 이미지 + 글자는 앱이 얹음"),
                   (DEMO / "61-inst-class-submitted.png", "등록 → 대표 승인 대기")])
    S.append(s)

    # 12 시연 ⑥ 대표
    s = Slide("시연-대표"); frame(s, 12, TOTAL, "03 시연 화면 · 대표", "대표가 강사 소속과 수업을 승인하면 회원 앱에 바로 보인다")
    p, iw, ih = prep(DEMO / "93-owner-web-instructors.png")
    ww = 540; wh = ww * ih / iw
    s.add(Rect(51, 155, ww + 10, wh + 10, fill=FRAME, radius=10), Img(56, 160, ww, wh, p, radius=6),
          Text(56, 160 + wh + 18, ww, 24, ["관리자 웹 · 강사 관리 — 소속 신청 승인, 권한 2종 토글"],
               size=11.5, color=INK2, align="center"),
          Text(56, 160 + wh + 46, ww, 60,
               ["• 승인할 때 강사 몫 비율(프리랜서 · 사업자)을 함께 넣는다",
                "• 강사에게 맡길 수 있는 권한은 「예약·명단」 「수업·포스터 등록」 둘뿐"],
               size=12, color=INK2))
    phones_row(s, [(DEMO / "73-owner-app-class-review.png", "대표 앱 — 수업 승인"),
                   (DEMO / "74-owner-app-class-approved.png", "「회원에게 공개됐어요」"),
                   (DEMO / "81-member-home-new-class.png", "회원 홈에 새 수업")],
               y=150, h=400, gap=30, x0=616, x1=W - 30)
    S.append(s)

    # 13 아키텍처 — 도형으로
    s = Slide("아키텍처"); frame(s, 13, TOTAL, "04 시스템과 AI", "시스템 아키텍처 — DB 쓰기는 한 곳, 모델 호출도 한 곳")

    def node(x, y, w, h, head, sub, fill=SURFACE, hc=PLUM, line=LINE, hs=14.5):
        s.add(Rect(x, y, w, h, fill=fill, line=line, radius=12),
              Text(x + 8, y + 12, w - 16, 28, [head], size=hs, bold=True, color=hc, align="center"),
              Text(x + 12, y + 42, w - 24, h - 50, sub, size=11, color=INK2, align="center"))

    def arrow(x, y, w, h, label=""):
        s.add(Rect(x, y, w, h, fill=CHAMP))
        if label:
            s.add(Text(x - 60 if h > w else x, y + (h / 2 - 9 if h > w else -20),
                       120 if h > w else w, 18, [label], size=9.5, color=INK3, align="center"))

    node(56, 150, 250, 110, "회원 앱", ["Expo SDK 58 · React Native 0.88", "Android"])
    node(56, 290, 250, 110, "강사·대표 앱", ["같은 코드에서 이름·아이콘만 바꿈", "Android"])
    node(56, 430, 250, 110, "관리자 웹", ["Next.js 16 화면", "대표 · 운영자 콘솔"])
    node(400, 170, 330, 330, "Next.js 16 (App Router)",
         ["제품 API 전부 · 인증 Better Auth", "Prisma 8 로 DB 쓰기 — 이 서버 하나만",
          "가드 · 권한 행렬 · 요청 제한", "AI 스트림을 앱 형식으로 번역"],
         fill=PLUM_SOFT, line=PLUM)
    for yy in (205, 345, 485):
        arrow(306, yy - 2, 94, 4)
    node(400, 520, 160, 110, "PostgreSQL 18", ["+ pgvector", "수업 · 예약 · 정산"], hs=13)
    node(570, 520, 160, 110, "Redis", ["로그인 실패 제한", "잠금 · 큐"])
    arrow(478, 500, 4, 20); arrow(648, 500, 4, 20)
    node(830, 150, 394, 150, "AI 에이전트 서버(Python)",
         ["FastAPI + LangGraph", "포스터 읽기 · 말로 찾기 · 이미지 생성", "DB 에 직접 쓰지 않고 도구(MCP)로 읽기만"],
         fill=CHAMP_SOFT, line=CHAMP)
    arrow(730, 300, 100, 4)
    node(830, 350, 190, 140, "로컬 LLM", ["llama-server", "Qwen 3.5 9B(비전)", "노트북 GPU 8GB"])
    node(1034, 350, 190, 140, "무료 이미지 API", ["Cloudflare Workers AI", "FLUX.1 [schnell]"])
    arrow(923, 300, 4, 50); arrow(1127, 300, 4, 50)
    s.add(Text(830, 510, 394, 110,
               ["원칙(ADR-004)", "• 웹 · 제품 API · 앱은 TypeScript, 에이전트만 Python",
                "• 모델이 바뀌어도 에이전트 서버만 고친다",
                "• 외부 API 는 영구 무료 구간만 — 예외는 PG · 본인확인"],
               size=11.5, color=INK2))
    S.append(s)

    # 14 AI 기능
    s = Slide("AI"); frame(s, 14, TOTAL, "04 시스템과 AI", "AI 기능 3가지 — 사람이 마지막에 확인한다")
    ai = [("포스터 읽기", ["포스터 한 장 → 수업 초안 + 항목별 신뢰도",
                         "Qwen 3.5 9B 비전, 로컬 GPU",
                         "합성 포스터 18개 항목 18/18, 11~12초(실측)",
                         "대표가 검토해야 확정(FR-074(추출 검토 필수))",
                         "실제 사진 포스터로는 아직 재지 않았다"]),
          ("말로 수업 찾기", ["「○○ 강사 주말 수업 알려줘」",
                            "질문 → 요일·시간대·모집 상태 조건으로 바꿈",
                            "게시된 수업만 카드로 + AI 답변 한 줄",
                            "LangGraph 에이전트 · 로컬 LLM",
                            "시연: 9장 AI 플래너"]),
          ("홍보 이미지", ["한글 한 줄 → 영어로 옮김 → 그림",
                         "Cloudflare Workers AI FLUX.1 [schnell] 무료 구간",
                         "한글 글자는 모델 대신 앱이 얹는다",
                         "계정당 하루 3회(베타) — 넘으면 사진 올리기",
                         "시연: 11장 홍보 이미지"])]
    for i, (head, body) in enumerate(ai):
        card(s, 56 + i * 396, 150, 372, 340, head, [f"• {b}" for b in body], size=14,
             head_size=19)
    note(s, "근거: 기술 스택 문서 11-2(Qwen 비전 서빙 · 이미지 생성) · 로드맵 SX-2.2(포스터 → 초안 추출) · SX-5.8(말로 찾기 실동작) · SX-6.4(영어 번역 · 이미지 생성 경로).", 520)
    S.append(s)

    # 15 보안
    s = Slide("보안"); frame(s, 15, TOTAL, "05 보안 · 품질 · 개발 방식", "보안 — 재현 테스트로 먼저 뚫고, 고친 뒤 다시 막혔는지 본다")
    s.add(Rect(56, 150, 520, 420, fill=SURFACE, line=LINE, radius=14),
          Text(80, 172, 470, 30, ["로그인 설계"], size=18, bold=True, color=PLUM),
          Text(80, 216, 476, 340,
               ["• 관리자 웹: 비밀번호 + 인증 앱 6자리",
                "   (FR-303(관리자 웹 2단계 인증))",
                "• 강사·대표 앱: 2단계 없이 앱 전용 로그인",
                "   경로(ADR-007) — 사용자 결정",
                "• 대신 앱 세션은 허용 목록 5개 경로만 쓴다",
                "   (2단계 설정 · 비밀번호 변경 등은 403)",
                "• 로그인 실패 제한: 아이디 · IP 15분 5회(Redis)",
                "• 권한 행렬 DB 테스트 281건으로 경로별 차단 확인"],
               size=13.5, color=INK2))
    steps = [("1차 리뷰", "CRITICAL 1 · HIGH 1",
              "앱 토큰으로 인증 앱을 지우고 재등록 → 관리자 콘솔 진입 / 비밀번호 변경 · 세션 끊기 가능"),
             ("2차 리뷰", "CRITICAL 1",
              "따옴표로 감싼 쿠키로 허용 목록 검사를 건너뜀"),
             ("3차 리뷰", "PASS",
              "CRITICAL · HIGH 0건. 남은 LOW 2건 중 1건도 반영")]
    for i, (head, tag, body) in enumerate(steps):
        y = 150 + i * 142
        last = i == 2
        s.add(Rect(606, y, 618, 124, fill=CHAMP_SOFT if last else SURFACE,
                   line=CHAMP if last else LINE, radius=14),
              Text(630, y + 18, 150, 28, [head], size=16, bold=True, color=INK),
              Rect(780, y + 16, 190, 30, fill=CHAMP if last else PLUM, radius=15),
              Text(780, y + 16, 190, 30, [tag], size=12, bold=True, color="FFFFFF", align="center",
                   valign="middle"),
              Text(630, y + 60, 570, 56, [body], size=12.5, color=INK2))
    note(s, "각 지적은 고치기 전에 재현 테스트가 실패(RED)하는 것을 먼저 확인했다 — staff-app-sign-in.db.test.ts 16 passed. 근거: _workspace/app-2fa-bypass/ · CLAUDE-decisions.md ADR-007.", 590)
    S.append(s)

    # 16 품질 · 테스트
    s = Slide("테스트"); frame(s, 16, TOTAL, "05 보안 · 품질 · 개발 방식", "품질 — 2026-11-25 실측, 전부 통과")
    tiles = [("1,704", "admin-web DB 테스트", "194 files · 실제 PostgreSQL"),
             ("1,768", "admin-web 단위 테스트", "127 files"),
             ("199", "AI 에이전트 서버", "pytest"),
             ("186", "backend", "pytest"),
             ("0", "mobile 타입 오류", "npx tsc --noEmit"),
             ("성공", "admin-web 빌드", "next build(타입 검사 포함)")]
    for i, (num, head, sub) in enumerate(tiles):
        col, row = i % 3, i // 3
        x, y = 56 + col * 396, 150 + row * 200
        s.add(Rect(x, y, 372, 176, fill=SURFACE, line=LINE, radius=14),
              Text(x + 28, y + 18, 320, 72, [num], size=40, bold=True, color=PLUM),
              Text(x + 28, y + 96, 320, 28, [head], size=15, bold=True, color=INK),
              Text(x + 28, y + 130, 320, 24, [sub], size=11.5, color=INK3))
    note(s, "로그: _workspace/app-2fa-bypass/07_bug-fixer_fixes.md(DB · 단위) · _workspace/evidence/final-verify-2026-11-25/logs/(나머지). 모두 exit 0.", 560)
    note(s, "화면 기능은 테스트 통과만으로 끝내지 않고, 에뮬레이터 · 브라우저 스크린샷을 장면마다 남겨 직접 열어 확인했다.", 584)
    S.append(s)

    # 17 개발 방식
    s = Slide("개발방식"); frame(s, 17, TOTAL, "05 보안 · 품질 · 개발 방식", "개발 방식 — AI 와 혼자 만들되, 역할을 4계층으로 나눴다")
    layers = [("환경", "작업장", "규칙 · 권한 · MCP · 훅", "무엇을 금지하고 어디서 멈출지"),
              ("명세", "설계도", "spec.md — 사용자 시나리오 · 수용 기준", "코드를 보지 않고 「무엇을 왜」"),
              ("파이프라인", "지휘자", "요구사항 → 계획 → Task 분리 → 구현 → 테스트 → 리뷰 → 검증",
               "누구에게 어떤 순서로"),
              ("공구", "수석 엔지니어", "TDD · 코드 리뷰 · 보안 리뷰 · 리팩터링", "어떻게 제대로")]
    for i, (name, nick, what, why) in enumerate(layers):
        y = 145 + i * 96
        s.add(Rect(56, y, 760, 84, fill=SURFACE, line=LINE, radius=12),
              Rect(56, y, 160, 84, fill=PLUM if i != 2 else PLUM_DARK, radius=12),
              Text(56, y + 14, 160, 30, [name], size=17, bold=True, color="FFFFFF", align="center"),
              Text(56, y + 46, 160, 24, [nick], size=11, color="E6DAE8", align="center"),
              Text(236, y + 14, 560, 30, [what], size=13, bold=True, color=INK),
              Text(236, y + 48, 560, 24, [why], size=11.5, color=INK3))
    s.add(Rect(846, 145, 378, 372, fill=CHAMP_SOFT, line=CHAMP, radius=14),
          Text(870, 167, 330, 30, ["증거 남기기"], size=18, bold=True, color=PLUM),
          Text(870, 210, 334, 300,
               ["• 「끝났다」고 말하기 전에 다른 사람이 다시 확인할 수 있는 증거를 남긴다",
                "• 장면별 스크린샷 · 명령 로그 · 계약 린터",
                "• 검사기가 PASS 여야 보고",
                "• 크리틱 에이전트는 워커의 말을 믿지 않고 테스트를 직접 다시 돌린다"],
               size=13, color=INK2))
    note(s, "명세는 FR 약 345개(하위 번호 포함). 한 번에 넘기지 않고 회차마다 범위를 잘라 구현했다 — core-rules.md 「4계층 역할 정의」.", 560)
    S.append(s)

    # 18 진행 현황
    s = Slide("진행"); frame(s, 18, TOTAL, "06 진행 현황과 계획", f"진행 현황 — 로드맵 {n_tasks}개 Task 중 {done}개 완료({done / n_tasks:.0%})")
    names = {"M0": "기반", "M1": "대표", "M2": "강사", "M3": "회원 결제", "M4": "환불·취소·대기",
             "M5": "정산·지급·대사", "M6": "멤버십·쿠폰", "M7": "운영", "M8": "출시 준비", "MX": "AI 트랙"}
    order = ["M0", "M1", "M2", "M3", "MX", "M7", "M6", "M4", "M5", "M8"]
    bar_x, bar_w = 270, 520
    for i, m in enumerate(order):
        c = by_ms[m]; tot = sum(c.values()); d = c["done"]
        y = 146 + i * 46
        s.add(Text(56, y + 4, 200, 24, [f"{m} {names[m]}"], size=12.5, bold=True, color=INK),
              Rect(bar_x, y + 6, bar_w, 22, fill=LINE, radius=11))
        if d:
            s.add(Rect(bar_x, y + 6, max(22, bar_w * d / tot), 22, fill=PLUM, radius=11))
        s.add(Text(bar_x + bar_w + 14, y + 4, 120, 24, [f"{d} / {tot}"], size=12, color=INK2))
    s.add(Rect(930, 146, 294, 450, fill=SURFACE, line=LINE, radius=14),
          Text(952, 166, 250, 28, ["남은 것"], size=17, bold=True, color=PLUM),
          Text(952, 206, 254, 380,
               ["• 실제 PG 연동 — 지금 결제는 가짜 PG 어댑터로 흐름만 검증. 실 웹훅은 PG 계약 뒤",
                "• 환불 · 취소 · 대기(M4)",
                "• 정산 · 지급 · 대사(M5)",
                "• 갤럭시 스토어 등록 · 처리방침 공개",
                f"• 막힘 {st['blocked']}건 — 사업자 등록 · PG 계약 · 도메인처럼 사람이 해야 하는 일"],
               size=12.5, color=INK2))
    note(s, f"근거: _workspace/roadmap-tasks.json(갱신 {upd}) — 완료 {done} · 할 일 {st['todo']} · 막힘 {st['blocked']}.", 620)
    S.append(s)

    # 19 시연 영상 안내
    s = Slide("영상"); frame(s, 19, TOTAL, "06 진행 현황과 계획", "시연 영상 — 첨부 파일로 제출")
    p, iw, ih = prep(DEMO / "frames" / "hl-52s.png")
    ww = 620; wh = ww * ih / iw
    s.add(Rect(51, 145, ww + 10, wh + 10, fill=FRAME, radius=10), Img(56, 150, ww, wh, p, radius=6),
          Text(56, 150 + wh + 16, ww, 22, ["highlight.mp4 의 52초 장면 — 강사 앱 홍보 이미지 결과"],
               size=11, color=INK3, align="center"))
    vids = [("highlight.mp4", "1분 30초", "회원 30초 · 강사 30초 · 대표 30초 — 제출용 요약"),
            ("full.mp4", "9분 3초", "로그인 입구 → 회원 → 강사 → 대표 전체 흐름"),
            ("levelup.mp4", "36초", "회원 레벨업 카드 발급 연출")]
    for i, (f, dur, desc) in enumerate(vids):
        y = 150 + i * 126
        s.add(Rect(710, y, 514, 108, fill=CHAMP_SOFT if i == 0 else SURFACE,
                   line=CHAMP if i == 0 else LINE, radius=14),
              Text(734, y + 18, 300, 30, [f], size=17, bold=True, color=PLUM),
              Text(1060, y + 20, 140, 26, [dur], size=14, bold=True, color=INK, align="right"),
              Text(734, y + 60, 470, 40, [desc], size=12.5, color=INK2))
    note(s, "Android 에뮬레이터(1080×2400)에서 실제 앱을 조작해 녹화했다. 관리자 웹 장면은 브라우저 1440×900. 1440×900 H.264 mp4.", 600)
    S.append(s)

    # 20 향후 계획
    s = Slide("계획"); frame(s, 20, TOTAL, "06 진행 현황과 계획", "다음 단계 — 돈이 맞게 흐르는 것부터")
    plan = [("다음", ["환불 · 취소 · 대기(M4)", "정산 · 지급 · 대사(M5)",
                     "가짜 PG 로 결제 → 환불 → 정산 한 바퀴"]),
            ("사업자 등록 뒤", ["PG 계약 → 실 어댑터 · 웹훅 서명 검증", "휴대폰 본인확인 · 소셜 로그인 3사",
                             "갤럭시 스토어 등록 · 처리방침 공개"]),
            ("AI · 확장", ["실제 사진 포스터로 읽기 정확도 재기", "임베딩 · 리랭커를 영구 무료 경로로 정하기",
                          "베타 1~10명 → 운영 초기 학원 10곳 · 1천 명"])]
    for i, (head, body) in enumerate(plan):
        card(s, 56 + i * 396, 150, 372, 250, head, [f"• {b}" for b in body], size=14.5,
             head_size=19)
    note(s, "단계 기준: PRD 1-4(출시 단계) — 앞 단계의 통과 조건(결제 · 환불 · 정산 각 1건이 정합성 위반 없이 완료 등)을 채워야 다음으로 간다.", 430)
    S.append(s)

    # 21 마무리
    s = Slide("마무리", bg=PLUM_DARK)
    s.add(Rect(0, 0, 14, H, fill=CHAMP),
          Text(96, 214, 1100, 100, ["감사합니다"], size=54, bold=True, color="FFFFFF"),
          Text(96, 320, 1100, 48, ["Q & A"], size=26, color=CHAMP, bold=True),
          Rect(96, 390, 80, 4, fill=CHAMP),
          Text(96, 416, 1100, 70,
               ["K-DanceX4 — 회원은 찾고, 강사는 올리고, 대표는 승인한다",
                f"로드맵 {done}/{n_tasks} 완료 · 테스트 전부 통과 · 실결제 · 정산은 PG 계약 뒤"],
               size=15, color="D9CCDC"),
          Text(96, 606, 600, 34, ["임채웅"], size=18, color="FFFFFF", bold=True))
    S.append(s)

    assert len(S) == TOTAL, len(S)
    return S


# ================= PPTX 렌더러 =================
def _rgb(h):
    return RGBColor.from_string(h)


def _emu(px):
    return Emu(int(round(px * PX_EMU)))


def _set_font(run, size, bold, color):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.name = FONT
    run.font.color.rgb = _rgb(color)
    rpr = run._r.get_or_add_rPr()
    # 한글은 「동아시아 글꼴」 칸을 따로 본다 — 여기에도 같은 이름을 적어야 한글이 지정 글꼴로 나온다
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = rpr.makeelement(qn(tag), {})
            rpr.append(el)
        el.set("typeface", FONT)


def render_pptx(slides: list[Slide], out: Path):
    prs = Presentation()
    prs.slide_width, prs.slide_height = _emu(W), _emu(H)
    blank = prs.slide_layouts[6]
    for sd in slides:
        sl = prs.slides.add_slide(blank)
        sl.background.fill.solid()
        sl.background.fill.fore_color.rgb = _rgb(sd.bg)
        for el in sd.items:
            if isinstance(el, Rect):
                kind = MSO_SHAPE.ROUNDED_RECTANGLE if el.radius else MSO_SHAPE.RECTANGLE
                sh = sl.shapes.add_shape(kind, _emu(el.x), _emu(el.y), _emu(el.w), _emu(el.h))
                if el.radius:
                    sh.adjustments[0] = min(0.5, el.radius / min(el.w, el.h))
                if el.fill:
                    sh.fill.solid(); sh.fill.fore_color.rgb = _rgb(el.fill)
                else:
                    sh.fill.background()
                if el.line:
                    sh.line.color.rgb = _rgb(el.line); sh.line.width = Pt(0.75)
                else:
                    sh.line.fill.background()
                sh.shadow.inherit = False
            elif isinstance(el, Img):
                sl.shapes.add_picture(str(el.path), _emu(el.x), _emu(el.y), _emu(el.w), _emu(el.h))
            elif isinstance(el, Text):
                tb = sl.shapes.add_textbox(_emu(el.x), _emu(el.y), _emu(el.w), _emu(el.h))
                tf = tb.text_frame
                tf.word_wrap = True
                tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
                tf.vertical_anchor = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE,
                                      "bottom": MSO_ANCHOR.BOTTOM}[el.valign]
                for i, line in enumerate(el.lines):
                    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    p.alignment = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER,
                                   "right": PP_ALIGN.RIGHT}[el.align]
                    # 줄 간격은 「배수」가 아니라 pt 로 고정한다 — 글꼴마다 배수 기준이 달라 PDF 와 어긋나기 때문
                    p.line_spacing = Pt(el.size * 1.3)
                    r = p.add_run(); r.text = line
                    _set_font(r, el.size, el.bold, el.color)
        sl.notes_slide.notes_text_frame.text = sd.title
    prs.save(out)


# ================= HTML → PDF 렌더러 =================
def render_html(slides: list[Slide]) -> Path:
    reg = (FONT_DIR / "NotoSansCJKkr-Regular.otf").as_uri()
    bold = (FONT_DIR / "NotoSansCJKkr-Bold.otf").as_uri()
    css = f"""
@font-face {{ font-family: 'Deck'; src: url('{reg}'); font-weight: 400; }}
@font-face {{ font-family: 'Deck'; src: url('{bold}'); font-weight: 700; }}
@page {{ size: {W}px {H}px; margin: 0; }}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ font-family: 'Deck', 'Noto Sans CJK KR', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
.s {{ position: relative; width: {W}px; height: {H}px; overflow: hidden; page-break-after: always; break-after: page; }}
.s:last-child {{ page-break-after: auto; break-after: auto; }}
.e {{ position: absolute; }}
.t {{ display: flex; flex-direction: column; word-break: keep-all; overflow-wrap: anywhere; }}
.t p {{ white-space: pre-wrap; }}
"""
    parts = [f"<!DOCTYPE html><html lang='ko'><head><meta charset='utf-8'><style>{css}</style></head><body>"]
    for sd in slides:
        parts.append(f"<div class='s' style='background:#{sd.bg}'>")
        for el in sd.items:
            pos = f"left:{el.x}px;top:{el.y}px;width:{el.w}px;height:{el.h}px;"
            if isinstance(el, Rect):
                st = pos + (f"background:#{el.fill};" if el.fill else "")
                st += f"border:1px solid #{el.line};" if el.line else ""
                r = min(el.radius, el.w / 2, el.h / 2)
                st += f"border-radius:{r}px;" if r else ""
                parts.append(f"<div class='e' style='{st}'></div>")
            elif isinstance(el, Img):
                parts.append(f"<img class='e' src='{el.path.as_uri()}' style='{pos}border-radius:{el.radius}px'>")
            elif isinstance(el, Text):
                px = el.size * 96 / 72
                jc = {"top": "flex-start", "middle": "center", "bottom": "flex-end"}[el.valign]
                st = (pos + f"font-size:{px:.2f}px;line-height:{px * 1.3:.2f}px;color:#{el.color};"
                      f"font-weight:{700 if el.bold else 400};text-align:{el.align};justify-content:{jc};")
                body = "".join(f"<p>{html.escape(l)}</p>" for l in el.lines)
                parts.append(f"<div class='e t' style='{st}'>{body}</div>")
        parts.append("</div>")
    parts.append("</body></html>")
    out = _TMP / "deck.html"
    out.write_text("".join(parts), encoding="utf-8")
    return out


def render_pdf(html_path: Path, out: Path):
    cmd = [str(CHROME), "--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
           "--run-all-compositor-stages-before-draw", "--virtual-time-budget=15000",
           f"--print-to-pdf={out}", html_path.as_uri()]
    subprocess.run(cmd, check=True, capture_output=True, timeout=180)


# ================= 넘침 점검(대략) =================
def _char_w(ch: str) -> float:
    if ch == " ":
        return 0.3
    if ord(ch) > 0x2E80:
        return 1.0
    if ch.isupper() or ch.isdigit():
        return 0.62
    if ch.isalpha():
        return 0.52
    return 0.38


def overflow_report(slides: list[Slide]) -> list[str]:
    """글자 폭을 어림해 상자보다 넘칠 것 같은 글 상자를 찾는다(줄바꿈 포함)."""
    warn = []
    for n, sd in enumerate(slides, 1):
        for el in sd.items:
            if not isinstance(el, Text):
                continue
            em = el.size * 96 / 72
            lines = 0
            for line in el.lines:
                width = sum(_char_w(c) for c in line) * em
                lines += max(1, -(-int(width) // max(1, int(el.w))))
            need = lines * em * 1.3
            if need > el.h + 2:
                warn.append(f"{n}장 「{el.lines[0][:18]}」 필요 {need:.0f}px > 상자 {el.h:.0f}px")
    return warn


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    slides = build_slides()
    render_pptx(slides, OUT_PPTX)
    render_pdf(render_html(slides), OUT_PDF)
    for w in overflow_report(slides):
        print("넘침 의심:", w)
    print(f"PPTX {OUT_PPTX.stat().st_size / 1e6:.1f}MB · PDF {OUT_PDF.stat().st_size / 1e6:.1f}MB · {len(slides)}장")
    shutil.rmtree(_TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
