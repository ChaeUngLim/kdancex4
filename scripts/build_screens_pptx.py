"""kdance 화면 명세서 — PPTX 생성 스크립트 (일회성, 로컬 실행용)
HTML 원본: ../docs/guide/kdance-screens-spec.html 과 같은 내용을 슬라이드로 옮긴다.
"""
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

INK = RGBColor(0x1F, 0x17, 0x29)
BG = RGBColor(0xFB, 0xF8, 0xFB)
SURFACE = RGBColor(0xFF, 0xFF, 0xFF)
SURFACE2 = RGBColor(0xF3, 0xED, 0xF5)
ACCENT = RGBColor(0xD8, 0x45, 0x2F)
ACCENT_SOFT = RGBColor(0xFB, 0xE2, 0xDC)
GOLD = RGBColor(0xB8, 0x80, 0x1A)
DIM = RGBColor(0x5C, 0x52, 0x66)
FAINT = RGBColor(0x94, 0x8A, 0xA0)
OK = RGBColor(0x2E, 0x7D, 0x5B)
OK_BG = RGBColor(0xE5, 0xF3, 0xEB)
WARN = RGBColor(0x8A, 0x5A, 0x12)
WARN_BG = RGBColor(0xFB, 0xF0, 0xDC)
LINE = RGBColor(0xEE, 0xE6, 0xF0)
MUTED_PH = RGBColor(0xE9, 0xE4, 0xED)

TANGO = RGBColor(0xD8, 0x45, 0x2F)
BALLROOM = RGBColor(0x3D, 0x4C, 0x9E)
SALSA = RGBColor(0xDB, 0x7B, 0x1E)
BACHATA = RGBColor(0xC1, 0x3A, 0x72)
SWING = RGBColor(0xB8, 0x80, 0x1A)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

FONT_HEAD = "맑은 고딕"
FONT_BODY = "맑은 고딕"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = prs.slide_width, prs.slide_height


def add_slide(bg=BG):
    s = prs.slides.add_slide(BLANK)
    r = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
    r.fill.solid(); r.fill.fore_color.rgb = bg
    r.line.fill.background(); r.shadow.inherit = False
    s.shapes._spTree.remove(r._element)
    s.shapes._spTree.insert(2, r._element)
    return s


def box(slide, l, t, w, h, fill=None, line_color=None, line_w=None, radius=None):
    shp_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    shp = slide.shapes.add_shape(shp_type, Inches(l), Inches(t), Inches(w), Inches(h))
    if radius:
        try:
            shp.adjustments[0] = radius
        except Exception:
            pass
    if fill is None:
        shp.fill.background()
    else:
        shp.fill.solid(); shp.fill.fore_color.rgb = fill
    if line_color is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line_color
        shp.line.width = Pt(line_w or 0.75)
    shp.shadow.inherit = False
    return shp


def text(slide, l, t, w, h, runs, size=14, color=INK, bold=False, font=FONT_BODY,
         align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, line_spacing=1.15, wrap=True, italic=False):
    tb = slide.shapes.add_textbox(Inches(l), Inches(t), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left = 0; tf.margin_right = 0; tf.margin_top = 0; tf.margin_bottom = 0
    if isinstance(runs, str):
        runs = [runs]
    for i, line in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.italic = italic
        r.font.name = font
        r.font.color.rgb = color
    return tb


def kicker(slide, l, t, label):
    w = 0.4 + 0.1 * len(label)
    box(slide, l, t, w, 0.32, fill=ACCENT_SOFT, radius=0.5)
    text(slide, l, t, w, 0.32, label, size=10.5, color=ACCENT, bold=True,
         align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


def slide_no(slide, label):
    text(slide, 0.6, 0.38, 4.0, 0.3, label, size=10, color=FAINT, font="IBM Plex Mono")


# ================= 소형 폰 목업 =================
PW, PH = 2.3, 4.55
TAB_LABELS = ["홈", "캘린더", "피드", "마이"]


def phone(slide, l, t, title, rows, tab=None, header_icon=None):
    box(slide, l, t, PW, PH, fill=INK, radius=0.1)
    sw, sh = PW - 0.12, PH - 0.12
    sl, st = l + 0.06, t + 0.06
    box(slide, sl, st, sw, sh, fill=SURFACE, radius=0.08)
    hx = sl + 0.14
    if header_icon:
        text(slide, hx, st + 0.1, 0.2, 0.24, header_icon, size=11, bold=True, color=INK)
        hx += 0.16
    text(slide, hx, st + 0.1, sw - 0.28, 0.24, title, size=10.5, bold=True, color=INK)
    y = st + 0.4
    box(slide, sl + 0.14, y, sw - 0.28, 0.008, fill=LINE)
    y += 0.1
    bottom_limit = st + sh - (0.34 if tab is not None else 0.08)

    for r in rows:
        if y > bottom_limit - 0.15:
            break
        kind = r["kind"]
        iw = sw - 0.28
        if kind == "photo":
            ph_h = r.get("h", 0.75)
            box(slide, sl + 0.14, y, iw, ph_h, fill=MUTED_PH, radius=0.14)
            if r.get("badge"):
                bw = 0.3 + 0.07 * len(r["badge"])
                box(slide, sl + 0.14 + iw - bw - 0.06, y + ph_h - 0.26, bw, 0.2, fill=WHITE, radius=0.5)
                text(slide, sl + 0.14 + iw - bw - 0.06, y + ph_h - 0.26, bw, 0.2, r["badge"],
                     size=6.5, bold=True, color=INK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
            y += ph_h + 0.08
        elif kind == "chips":
            cx = sl + 0.14
            for label, col in r["chips"]:
                cw = 0.28 + 0.075 * len(label)
                box(slide, cx, y, cw, 0.22, fill=col, radius=0.5)
                text(slide, cx, y, cw, 0.22, label, size=7, bold=True, color=WHITE,
                     align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
                cx += cw + 0.06
            y += 0.32
        elif kind == "card":
            ch = r.get("h", 0.5)
            box(slide, sl + 0.14, y, iw, ch, fill=SURFACE2, line_color=LINE, line_w=0.75, radius=0.16)
            text(slide, sl + 0.22, y + 0.05, iw - 0.32, 0.22, r["title"], size=8.5, bold=True, color=INK)
            text(slide, sl + 0.22, y + 0.26, iw - 0.32, 0.2, r.get("sub", ""), size=7, color=DIM)
            y += ch + 0.08
        elif kind == "field":
            text(slide, sl + 0.14, y, iw, 0.16, r["label"], size=6.8, color=FAINT)
            text(slide, sl + 0.14, y + 0.16, iw, 0.2, r["value"], size=8.5, bold=True, color=INK)
            y += 0.42
        elif kind == "divider":
            box(slide, sl + 0.14, y + 0.04, iw, 0.008, fill=LINE)
            y += 0.14
        elif kind == "priceline":
            style = r.get("style")
            c = OK if style == "discount" else INK
            bold_ = style == "total"
            if style == "total":
                box(slide, sl + 0.14, y - 0.02, iw, 0.008, fill=LINE)
                y += 0.06
            text(slide, sl + 0.14, y, iw * 0.62, 0.2, r["k"], size=8 if bold_ else 7.2,
                 bold=bold_, color=c if style == "discount" else (INK if bold_ else DIM))
            text(slide, sl + 0.14 + iw * 0.62, y, iw * 0.38, 0.2, r["v"], size=9 if bold_ else 7.2,
                 bold=True, color=c if style == "discount" else INK, align=PP_ALIGN.RIGHT)
            y += 0.24 if not bold_ else 0.3
        elif kind == "payopt":
            sel = r.get("sel")
            box(slide, sl + 0.14, y, iw, 0.3, fill=SURFACE2 if sel else SURFACE,
                line_color=INK if sel else LINE, line_w=1.1 if sel else 0.75, radius=0.25)
            text(slide, sl + 0.24, y, iw - 0.2, 0.3, r["label"], size=7.6, bold=True, color=INK,
                 anchor=MSO_ANCHOR.MIDDLE)
            y += 0.36
        elif kind == "agree":
            text(slide, sl + 0.14, y, iw, 0.24, r["text"], size=6.3, color=FAINT, wrap=True)
            y += 0.3
        elif kind == "cal":
            days = ["일", "월", "화", "수", "목", "금", "토"]
            cw = iw / 7
            for i, d in enumerate(days):
                text(slide, sl + 0.14 + i * cw, y, cw, 0.16, d, size=6, color=DIM, align=PP_ALIGN.CENTER)
            y += 0.18
            nums = r["nums"]
            for i, (n, active, dot) in enumerate(nums):
                cxp = sl + 0.14 + i * cw
                if active:
                    box(slide, cxp + cw * 0.15, y, cw * 0.7, cw * 0.7, fill=INK, radius=0.5)
                text(slide, cxp, y, cw, cw * 0.7, str(n), size=6.5, bold=active,
                     color=WHITE if active else DIM, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
                if dot:
                    box(slide, cxp + cw / 2 - 0.02, y + cw * 0.68, 0.04, 0.04, fill=dot, radius=0.5)
            y += cw * 0.7 + 0.12
        elif kind == "agenda":
            ch = 0.5
            box(slide, sl + 0.14, y, iw, ch, fill=SURFACE2, line_color=LINE, line_w=0.75, radius=0.14)
            box(slide, sl + 0.14, y, 0.04, ch, fill=r.get("color", TANGO))
            text(slide, sl + 0.26, y + 0.06, iw - 0.36, 0.2, r["title"], size=8, bold=True, color=INK)
            text(slide, sl + 0.26, y + 0.26, iw - 0.36, 0.2, r["sub"], size=6.8, color=DIM)
            y += ch + 0.08
        elif kind == "map":
            ch = r.get("h", 1.1)
            box(slide, sl + 0.14, y, iw, ch, fill=MUTED_PH, radius=0.1)
            ln = slide.shapes.add_connector(1, Inches(sl + 0.3), Inches(y + ch - 0.2), Inches(sl + 0.14 + iw - 0.3), Inches(y + 0.2))
            ln.line.color.rgb = ACCENT; ln.line.width = Pt(1.6)
            y += ch + 0.08
        elif kind == "route":
            ch = 0.5
            box(slide, sl + 0.14, y, iw, ch, fill=SURFACE2, line_color=LINE, line_w=0.75, radius=0.16)
            text(slide, sl + 0.22, y + 0.05, iw - 0.32, 0.18, r["a"], size=7, color=DIM)
            text(slide, sl + 0.22, y + 0.25, iw - 0.32, 0.18, r["b"], size=7, color=DIM)
            y += ch + 0.08
        elif kind == "hero2":
            ch = r.get("h", 0.85)
            box(slide, sl + 0.14, y, iw, ch, fill=r.get("fill", BALLROOM), radius=0.16)
            text(slide, sl + 0.24, y + 0.09, iw - 0.4, 0.18, r["label"], size=7, color=WHITE)
            text(slide, sl + 0.24, y + 0.28, iw - 0.4, 0.4, r["big"], size=11.5, bold=True, color=WHITE, wrap=True)
            y += ch + 0.1
        elif kind == "coupon":
            ch = 0.44
            box(slide, sl + 0.14, y, iw, ch, line_color=ACCENT, line_w=1.2, radius=0.2)
            text(slide, sl + 0.22, y + 0.05, iw - 0.7, 0.18, r["title"], size=7.4, bold=True, color=INK)
            text(slide, sl + 0.22, y + 0.24, iw - 0.7, 0.16, r.get("status", ""), size=6.4, color=DIM)
            text(slide, sl + 0.14 + iw - 0.55, y + 0.05, 0.48, 0.3, r.get("d", ""), size=6, bold=True,
                 color=ACCENT, align=PP_ALIGN.RIGHT)
            y += ch + 0.08
        elif kind == "mini":
            text(slide, sl + 0.14, y, iw * 0.65, 0.2, r["k"], size=7.4, color=DIM)
            text(slide, sl + 0.14 + iw * 0.65, y, iw * 0.35, 0.2, r["v"], size=7.4, bold=True,
                 color=INK, align=PP_ALIGN.RIGHT)
            y += 0.26
        elif kind == "feed":
            ch = 0.62
            box(slide, sl + 0.14, y, iw, ch, fill=SURFACE, line_color=LINE, line_w=0.75, radius=0.16)
            box(slide, sl + 0.14, y, iw, 0.22, fill=MUTED_PH, radius=0.16)
            tagw = 0.3 + 0.07 * len(r["tag"])
            box(slide, sl + 0.2, y + 0.26, tagw, 0.16, fill=r.get("tagcolor", TANGO), radius=0.5)
            text(slide, sl + 0.2, y + 0.26, tagw, 0.16, r["tag"], size=5.6, bold=True, color=WHITE,
                 align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
            text(slide, sl + 0.2, y + 0.44, iw - 0.3, 0.16, r["title"], size=7.4, bold=True, color=INK)
            y += ch + 0.08
        elif kind == "notice":
            text(slide, sl + 0.14, y, iw, 0.18, ("📌 " if r.get("pin") else "") + r["title"],
                 size=7.6, bold=True, color=INK)
            text(slide, sl + 0.14, y + 0.2, iw, 0.16, r["meta"], size=6.4, color=FAINT)
            y += 0.36
            box(slide, sl + 0.14, y - 0.04, iw, 0.006, fill=LINE)
        elif kind == "upload":
            ch = 0.85
            box(slide, sl + 0.14, y, iw, ch, line_color=FAINT, line_w=1.2, radius=0.18)
            text(slide, sl + 0.14, y + 0.22, iw, 0.4, "포스터 · PDF · 인스타 캡처",
                 size=7.6, bold=True, color=INK, align=PP_ALIGN.CENTER)
            text(slide, sl + 0.14, y + 0.46, iw, 0.2, "끌어다 놓거나 눌러서 선택",
                 size=6.4, color=FAINT, align=PP_ALIGN.CENTER)
            y += ch + 0.1
        elif kind == "reviewfield":
            low = r.get("low")
            ch = 0.4
            box(slide, sl + 0.14, y, iw, ch, line_color=ACCENT if low else LINE,
                line_w=1.3 if low else 0.75, radius=0.14)
            text(slide, sl + 0.2, y + 0.04, iw - 0.3, 0.16, r["label"], size=6.4, color=FAINT)
            text(slide, sl + 0.2, y + 0.2, iw - 0.9, 0.16, r["value"], size=7.6, bold=True, color=INK)
            if low:
                text(slide, sl + 0.14 + iw - 0.62, y + 0.2, 0.55, 0.16, "확인필요", size=5.6,
                     bold=True, color=ACCENT, align=PP_ALIGN.RIGHT)
            y += ch + 0.08

    if tab is not None:
        tby = st + sh - 0.28
        box(slide, sl + 0.14, tby - 0.05, sw - 0.28, 0.006, fill=LINE)
        tw = (sw - 0.28) / 4
        for i, lbl in enumerate(TAB_LABELS):
            on = i == tab
            text(slide, sl + 0.14 + i * tw, tby, tw, 0.2, lbl, size=6.2, bold=on,
                 color=ACCENT if on else FAINT, align=PP_ALIGN.CENTER)


def caption(slide, l, t, w, num, title, desc):
    text(slide, l, t, w, 0.2, num, size=9, bold=True, color=ACCENT, font="IBM Plex Mono")
    text(slide, l, t + 0.22, w, 0.24, title, size=11.5, bold=True, font=FONT_HEAD)
    text(slide, l, t + 0.48, w, 0.9, desc, size=8.8, color=DIM, line_spacing=1.3)


def phone_row(slide, specs, y_phone=1.35):
    """specs: list of (x, phone_kwargs, cap_num, cap_title, cap_desc)"""
    for x, pk, num, ctitle, cdesc in specs:
        phone(slide, x, y_phone, **pk)
        caption(slide, x, y_phone + PH + 0.16, PW + 1.5, num, ctitle, cdesc)


# ================= Slide 01 — Cover =================
s = add_slide()
slide_no(s, "01 / 10 · 화면 명세서")
text(s, 0.7, 1.6, 11.5, 1.6, "kdance — 실제 구현 수준\n화면 명세", size=36, bold=True,
     color=INK, font=FONT_HEAD, line_spacing=1.15)
text(s, 0.7, 3.4, 10.5, 1.0,
     "검색·추천, 관리자 업로드 자동등록, 뉴스피드·공지, 대학생 첫 결제 50%, 1+1\n"
     "멤버십 할인권, 입점 1년 수수료 면제까지 — 2026-09-25 약관 기준으로 화면에 옮겼다.",
     size=14, color=DIM, line_spacing=1.35)
text(s, 0.7, 4.6, 10, 0.4, "탭바·카드 반경은 mobydick 실제 구현 패턴 참고 · 색은 kdance 고유 장르 5색 유지",
     size=10.5, color=FAINT, italic=True)

# ================= Slide 02 — 소비자 1/3 =================
s = add_slide()
slide_no(s, "02 / 10 · 소비자 앱")
kicker(s, 0.7, 0.8, "가입 → 검색 → 상세")
xs = [0.7, 3.65, 6.6]

phone(s, xs[0], 1.35, title="회원가입", rows=[
    {"kind": "field", "label": "휴대폰 번호", "value": "010-••••-5521 · 인증완료"},
    {"kind": "chips", "chips": [("댄스스포츠", BALLROOM), ("탱고", TANGO)]},
    {"kind": "card", "title": "🎓 대학생이신가요?", "sub": "학교 이메일 인증 시 3개월 요금제", "h": 0.55},
])
caption(s, xs[0], 1.35 + PH + 0.16, PW + 0.6, "01", "회원가입 · 대학생 인증",
        "장르 선호를 가입 시점에 받는다.")

phone(s, xs[1], 1.35, title="학원 찾기", tab=0, rows=[
    {"kind": "field", "label": "검색", "value": "강남 · 살사 · 평일 저녁"},
    {"kind": "chips", "chips": [("살사", SALSA), ("바차타", BACHATA)]},
    {"kind": "card", "title": "라 클라베 스튜디오 ★4.9", "sub": "강남역 3번 출구 · 도보 5분"},
    {"kind": "card", "title": "소셜살사 강남점 ★4.7", "sub": "역삼역 1번 출구 · 도보 9분"},
])
caption(s, xs[1], 1.35 + PH + 0.16, PW + 0.6, "02", "홈 — 카테고리 검색",
        "장르·지역·시간대 필터.")

phone(s, xs[2], 1.35, title="학원 상세", header_icon="‹", rows=[
    {"kind": "photo", "h": 0.7, "badge": "사진 6장"},
    {"kind": "field", "label": "라 클라베 댄스 스튜디오", "value": "★4.9 (212) · 도보 5분"},
    {"kind": "chips", "chips": [("살사", SALSA), ("바차타", BACHATA)]},
    {"kind": "card", "title": "살사 중급반 · 45,000원", "sub": "화·목 20:00 · 8/12"},
])
caption(s, xs[2], 1.35 + PH + 0.16, PW + 0.6, "03", "학원 상세 페이지",
        "정원 대비 신청 인원으로 마감 임박을 보여준다.")

# ================= Slide 03 — 소비자 2/3 =================
s = add_slide()
slide_no(s, "03 / 10 · 소비자 앱")
kicker(s, 0.7, 0.8, "결제 → 일정 → 길찾기")

phone(s, xs[0], 1.35, title="결제하기", header_icon="‹", rows=[
    {"kind": "field", "label": "수업", "value": "살사 중급반 · 화 20:00"},
    {"kind": "priceline", "k": "수업료 (1개월)", "v": "180,000원"},
    {"kind": "priceline", "k": "대학생 첫 결제 50%", "v": "-90,000원", "style": "discount"},
    {"kind": "priceline", "k": "총 결제금액", "v": "90,000원", "style": "total"},
    {"kind": "payopt", "label": "신용·체크카드", "sel": True},
    {"kind": "payopt", "label": "카카오페이", "sel": False},
    {"kind": "agree", "text": "이 학원의 환불·취소 공지에 동의합니다"},
])
caption(s, xs[0], 1.35 + PH + 0.16, PW + 0.6, "04 ★", "체크아웃 — 결제 화면",
        "할인·쿠폰이 항목별로 차감되는 걸 보여준다.")

phone(s, xs[1], 1.35, title="내 일정", tab=1, rows=[
    {"kind": "cal", "nums": [(1, False, None), (2, False, None), (3, True, SALSA),
                              (4, False, None), (5, False, BACHATA), (6, False, None), (7, False, None)]},
    {"kind": "agenda", "title": "🔔 살사 중급반", "sub": "오늘 저녁 8:00 · 30분 전 알람", "color": SALSA},
])
caption(s, xs[1], 1.35 + PH + 0.16, PW + 0.6, "05", "캘린더 & 알람",
        "결제 완료 시 자동으로 일정에 반영.")

phone(s, xs[2], 1.35, title="길찾기", tab=2, rows=[
    {"kind": "map", "h": 1.1},
    {"kind": "route", "a": "🚶 도보 · 12분 · 850m", "b": "🚇 강남역 3번 출구"},
])
caption(s, xs[2], 1.35 + PH + 0.16, PW + 0.6, "06", "길찾기",
        "예약 확인 화면에서 바로 진입.")

# ================= Slide 04 — 소비자 3/3 =================
s = add_slide()
slide_no(s, "04 / 10 · 소비자 앱")
kicker(s, 0.7, 0.8, "피드 → 공지 → 마이")

phone(s, xs[0], 1.35, title="피드", tab=2, rows=[
    {"kind": "feed", "tag": "파티", "tagcolor": BACHATA, "title": "강남 바차타 소셜파티"},
    {"kind": "feed", "tag": "대회", "tagcolor": BALLROOM, "title": "2026 전국 챔피언십"},
])
caption(s, xs[0], 1.35 + PH + 0.16, PW + 0.6, "07", "뉴스피드 — 파티·공연·대회",
        "전 학원 통합 노출, 같은 업로드 파이프라인 산출물.")

phone(s, xs[1], 1.35, title="라 클라베 공지", header_icon="‹", rows=[
    {"kind": "notice", "title": "추석 연휴 휴강 안내", "meta": "9/16 게시", "pin": True},
    {"kind": "notice", "title": "10월 정기 발표회 신청", "meta": "9/12 게시"},
    {"kind": "notice", "title": "신규 바차타 강사 합류", "meta": "9/5 게시"},
])
caption(s, xs[1], 1.35 + PH + 0.16, PW + 0.6, "08", "학원별 공지 게시판",
        "OCR 없이 텍스트로 바로 작성 — 속도 우선.")

phone(s, xs[2], 1.35, title="마이", tab=3, rows=[
    {"kind": "hero2", "label": "월 멤버십 중", "big": "다음 결제 10/13 · 15,000원", "fill": ACCENT, "h": 0.75},
    {"kind": "coupon", "title": "🎟 1+1 할인권", "status": "사용가능", "d": "D-18"},
    {"kind": "mini", "k": "예약 내역", "v": "›"},
    {"kind": "mini", "k": "대학생 인증", "v": "첫 결제 할인 사용"},
])
caption(s, xs[2], 1.35 + PH + 0.16, PW + 0.6, "09", "마이 — 멤버십·쿠폰 관리",
        "쿠폰 소멸일을 항상 보여준다.")

# ================= Slide 05 — 학원 관리자 =================
s = add_slide()
slide_no(s, "05 / 10 · 학원 관리자 웹")
kicker(s, 0.7, 0.8, "업로드 → 검토 → 정산")

phone(s, xs[0], 1.35, title="포스터 업로드", rows=[
    {"kind": "upload"},
    {"kind": "card", "title": "10월_시간표.jpg", "sub": "처리중 · 09:41"},
])
caption(s, xs[0], 1.35 + PH + 0.16, PW + 0.6, "10", "관리자 · 업로드",
        "형식 무관 — 이미지·PDF·스크린샷 전부 같은 경로.")

phone(s, xs[1], 1.35, title="추출 결과 검토", rows=[
    {"kind": "photo", "h": 0.55, "badge": "원본 보기"},
    {"kind": "reviewfield", "label": "장르", "value": "살사 중급반"},
    {"kind": "reviewfield", "label": "시간", "value": "화 20:00–21:00", "low": True},
    {"kind": "reviewfield", "label": "가격", "value": "45,000원", "low": True},
])
caption(s, xs[1], 1.35 + PH + 0.16, PW + 0.6, "11 ★", "관리자 · 검토 대기",
        "신뢰도 낮은 필드에 빨간 태그. 이 화면 없이 게시 불가.")

phone(s, xs[2], 1.35, title="이번 달 정산", rows=[
    {"kind": "hero2", "label": "실지급액", "big": "3,414,000원", "fill": BALLROOM, "h": 0.75},
    {"kind": "mini", "k": "플랫폼 수수료 (5% · 1년 면제 중)", "v": "0원"},
    {"kind": "mini", "k": "결제·카드 수수료 (수업료 몫 · 대표 부담)", "v": "-76,000원"},
    {"kind": "mini", "k": "1+1 쿠폰 사용", "v": "6건"},
    {"kind": "mini", "k": "신규 회원", "v": "14명"},
])
caption(s, xs[2], 1.35 + PH + 0.16, PW + 0.6, "12", "관리자 · 정산 대시보드",
        "1+1 쿠폰 사용 건수를 별도 표기. 예매 수수료가 붙은 결제는 수업료 몫 수수료만 공제.")

# ================= Slide 06 — 취소·환불 =================
s = add_slide()
slide_no(s, "06 / 10 · 취소·환불")
kicker(s, 0.7, 0.8, "취소 신청 → 환불 처리 → 행사 취소")

phone(s, xs[0], 1.35, title="예약 상세", header_icon="‹", rows=[
    {"kind": "field", "label": "파티", "value": "할로윈 살사 파티 · 10/30(금)"},
    {"kind": "mini", "k": "환불 마감", "v": "10/26(월)"},
    {"kind": "mini", "k": "오늘 취소하면", "v": "8일 전 (9~7일 전)"},
    {"kind": "priceline", "k": "참가비", "v": "30,000원"},
    {"kind": "priceline", "k": "취소 수수료 10%", "v": "-3,000원"},
    {"kind": "priceline", "k": "예매 수수료 (환불 안 됨)", "v": "2,000원"},
    {"kind": "priceline", "k": "예상 환불액", "v": "27,000원", "style": "total"},
    {"kind": "mini", "k": "처리 기한 (3영업일)", "v": "10/27(화)"},
    {"kind": "agree", "text": "기한이 지나면 이 금액으로 자동 환불된다"},
])
caption(s, xs[0], 1.35 + PH + 0.16, PW + 0.6, "13 ★", "회원 · 예약 상세 취소 신청",
        "이벤트형 전용. 구간·공제율·예상 환불액·처리 기한을 먼저 보여준다.")

phone(s, xs[1], 1.35, title="환불 처리", rows=[
    {"kind": "chips", "chips": [("이벤트형", INK), ("정규·일반", FAINT)]},
    {"kind": "mini", "k": "자동 실행까지", "v": "1영업일"},
    {"kind": "field", "label": "취소 신청", "value": "할로윈 살사 파티 · 김**"},
    {"kind": "card", "title": "환불액 27,000원 (시스템 계산)", "sub": "9~7일 전 · 수수료 10% · 올리기만 가능"},
    {"kind": "mini", "k": "거절", "v": "불가"},
    {"kind": "card", "title": "정규·일반 수업 요청이면", "sub": "여부·금액·근거 항목을 대표가 입력", "h": 0.5},
])
caption(s, xs[1], 1.35 + PH + 0.16, PW + 0.6, "14", "관리자 · 환불 처리",
        "이벤트형은 계산값을 올리기만 한다. 처리 기간이 지나면 시스템이 자동 실행.")

phone(s, xs[2], 1.35, title="행사 취소", header_icon="‹", rows=[
    {"kind": "field", "label": "행사", "value": "할로윈 살사 파티 · 10/30(금)"},
    {"kind": "payopt", "label": "불가항력 (천재지변·행정명령)", "sel": False},
    {"kind": "payopt", "label": "대표 사정·운영상 이유", "sel": True},
    {"kind": "mini", "k": "한 줄 설명", "v": "인원 미달"},
    {"kind": "mini", "k": "결제자", "v": "24명"},
    {"kind": "mini", "k": "환불 총액 (예매 수수료 포함)", "v": "768,000원"},
    {"kind": "mini", "k": "예매 수수료 몫 PG 수수료", "v": "대표 · 상계"},
])
caption(s, xs[2], 1.35 + PH + 0.16, PW + 0.6, "15", "관리자 · 행사 일괄 취소",
        "대표만 확정. 전원 전액 PG 일괄 환불, 연기 선택지·계좌 송금 없음.")

# ================= Slide 07 — 이용약관 핵심 =================
s = add_slide()
slide_no(s, "07 / 10")
kicker(s, 0.7, 0.85, "약관 초안")
text(s, 0.7, 1.35, 10.5, 0.6, "이용약관 핵심 요약", size=24, bold=True, font=FONT_HEAD)
text(s, 0.7, 1.9, 11, 0.5, "실제 약관은 아님 — 변호사 검토 전 초안. 화면·정책이 서로 안 어긋나는지 확인하는 용도.",
     size=11.5, color=DIM, italic=True)

tc = [
    ("결제·환불", ["정규·일반 — 문의로 요청, 대표가 결정·실행",
                "이벤트형 — 시스템 계산, 대표는 올리기만, 3영업일 뒤 자동",
                "예매 수수료 2,000원 환불 불가(휴강·폐강·행사 취소·청약철회 예외)"]),
    ("대학생 혜택", [".ac.kr 인증, 1인 1회", "첫 결제 1회 50%, 차액 학원 부담"]),
    ("멤버십 · 1+1 할인권", ["결제 뒤 환불 없음, 해지만", "3개월 유지마다 1장, 추가 수업 1달치 50%"]),
    ("학원 정산 · 베타", ["매월 5일 정산, 수수료 5%", "입점 1년 면제, 이후 정상 청구",
                       "예매 수수료 붙은 결제는 수업료 몫 수수료만 부담"]),
    ("업로드 콘텐츠", ["저작권·초상권은 업로드 학원 책임", "관리자 확인 전엔 게시·노출 안 됨"]),
    ("개인정보", ["전화번호 — 본인인증", "위치정보 — 길찾기 목적, 미저장"]),
]
cw, chh = 3.85, 1.55
for i, (title, items) in enumerate(tc):
    col, row = i % 3, i // 3
    cx = 0.7 + col * (cw + 0.25)
    cy = 2.55 + row * (chh + 0.2)
    box(s, cx, cy, cw, chh, fill=SURFACE, line_color=LINE, line_w=1, radius=0.06)
    text(s, cx + 0.25, cy + 0.16, cw - 0.5, 0.3, title, size=12.5, bold=True, font=FONT_HEAD)
    text(s, cx + 0.25, cy + 0.55, cw - 0.5, chh - 0.7,
         ["· " + it for it in items], size=9.5, color=DIM, line_spacing=1.3)

# ================= Slide 08 — 사용 절차: 회원 =================
s = add_slide()
slide_no(s, "08 / 10")
kicker(s, 0.7, 0.85, "사용 절차 · 회원")
text(s, 0.7, 1.35, 10, 0.6, "회원 — 가입부터 길찾기까지 6단계", size=24, bold=True, font=FONT_HEAD)

member_steps = [
    ("1", "가입 · 인증", "휴대폰 본인인증, 관심 장르 선택. 대학생이면 학교 이메일 인증(선택)."),
    ("2", "검색 · 추천", "장르·지역·시간대로 학원을 찾거나 홈 추천에서 고른다."),
    ("3", "학원 상세 확인", "시간표·정원·리뷰를 보고 수업을 고른다."),
    ("4", "결제", "할인·쿠폰이 자동 적용된 금액을 확인하고 결제한다."),
    ("5", "캘린더 · 알람", "예약이 자동으로 일정에 들어가고 30분 전 알람이 온다."),
    ("6", "길찾기", "당일 예약 확인 화면에서 바로 경로 안내로 이동한다."),
]
y = 2.15
for n, title, body in member_steps:
    text(s, 0.7, y, 0.5, 0.5, n, size=20, bold=True, color=GOLD, font=FONT_HEAD)
    text(s, 1.3, y + 0.02, 2.6, 0.4, title, size=13, bold=True)
    text(s, 4.0, y + 0.02, 8.2, 0.5, body, size=11, color=DIM)
    y += 0.72
    if n != "6":
        box(s, 0.7, y - 0.14, 11.9, 0.008, fill=LINE)

# ================= Slide 09 — 사용 절차: 학원 관리자 =================
s = add_slide()
slide_no(s, "09 / 10")
kicker(s, 0.7, 0.85, "사용 절차 · 학원 관리자")
text(s, 0.7, 1.35, 11, 0.6, "학원 관리자 — 가입부터 정산까지 5단계", size=24, bold=True, font=FONT_HEAD)

admin_steps = [
    ("1", "사업자 가입", "정산 계좌·사업자등록증 등록."),
    ("2", "포스터 업로드", "쓰던 홍보물을 그대로 올린다 — 형식 무관."),
    ("3", "추출 결과 검토", "자동으로 채워진 필드를 확인·수정하고 게시한다."),
    ("4", "예약 · 정산 확인", "매월 5일 입금 내역과 1+1 쿠폰 사용 건수를 확인한다."),
    ("5", "피드 · 공지 운영", "파티·대회는 같은 업로드 경로로, 급한 공지는 텍스트로."),
]
y = 2.15
for n, title, body in admin_steps:
    text(s, 0.7, y, 0.5, 0.5, n, size=20, bold=True, color=GOLD, font=FONT_HEAD)
    text(s, 1.3, y + 0.02, 2.6, 0.4, title, size=13, bold=True)
    text(s, 4.0, y + 0.02, 8.2, 0.5, body, size=11, color=DIM)
    y += 0.78
    if n != "5":
        box(s, 0.7, y - 0.16, 11.9, 0.008, fill=LINE)

# ================= Slide 10 — Closing =================
s = add_slide(bg=INK)
text(s, 0.7, 3.0, 11.9, 1.2, "kdance 화면 명세서", size=36, bold=True, color=WHITE, font=FONT_HEAD,
     align=PP_ALIGN.CENTER)
text(s, 0.7, 4.0, 11.9, 0.6, "10 / 10 · docs/kdance 폴더", size=13, color=RGBColor(200, 190, 210),
     align=PP_ALIGN.CENTER)

prs.save(str(Path(__file__).resolve().parents[1] / "docs" / "deck" / "kdance_화면명세서.pptx"))
print("saved")
