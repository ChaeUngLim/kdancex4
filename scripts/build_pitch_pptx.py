"""소셜댄스 입점 설명회 — PPTX 생성 스크립트 (일회성, 로컬 실행용)
../docs/guide/kdance-screens-spec.html 의 12화면 전부를 학원 원장님 설득 관점 캡션으로 다시 구성한다.
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
LINE = RGBColor(0xEE, 0xE6, 0xF0)
MUTED_PH = RGBColor(0xE9, 0xE4, 0xED)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

TANGO = RGBColor(0xD8, 0x45, 0x2F)
BALLROOM = RGBColor(0x3D, 0x4C, 0x9E)
SALSA = RGBColor(0xDB, 0x7B, 0x1E)
BACHATA = RGBColor(0xC1, 0x3A, 0x72)
SWING = RGBColor(0xB8, 0x80, 0x1A)

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
    text(slide, 0.6, 0.38, 4.5, 0.3, label, size=10, color=FAINT, font="IBM Plex Mono")


# ================= 폰 목업 엔진 =================
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
            bold_ = style == "total"
            if style == "total":
                box(slide, sl + 0.14, y - 0.02, iw, 0.008, fill=LINE)
                y += 0.06
            c = OK if style == "discount" else INK
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
            for i, (n, active, dot) in enumerate(r["nums"]):
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


XS = [0.7, 3.65, 6.6]
YP = 1.35


# ================= 01 — Cover =================
s = add_slide()
slide_no(s, "01 / 09 · 입점 설명회")
text(s, 0.7, 1.5, 9.4, 2.4, ["춤출 곳을 못 찾아서", "안 오는 회원은, 없앱니다."],
     size=38, bold=True, color=INK, font=FONT_HEAD, line_spacing=1.15)
text(s, 0.7, 3.5, 8.6, 1.0,
     "검색 → 예약 → 결제 → 정산까지 한 앱에서 끝나는 소셜댄스 전문 플랫폼.\n"
     "시간표는 쓰시던 포스터 사진 한 장만 올리면 자동으로 등록됩니다.",
     size=15, color=DIM, line_spacing=1.3)
gx = 0.7
for label, col in [("댄스스포츠", BALLROOM), ("아르헨티나 탱고", TANGO), ("스윙댄스", SWING),
                    ("살사", SALSA), ("바차타", BACHATA)]:
    gw = 0.5 + 0.14 * len(label)
    box(s, gx, 4.75, gw, 0.42, fill=SURFACE, line_color=LINE, line_w=1, radius=0.5)
    dot = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(gx + 0.14), Inches(4.75 + 0.15), Inches(0.12), Inches(0.12))
    dot.fill.solid(); dot.fill.fore_color.rgb = col; dot.line.fill.background(); dot.shadow.inherit = False
    text(s, gx + 0.32, 4.75, gw - 0.32, 0.42, label, size=10.5, color=DIM, anchor=MSO_ANCHOR.MIDDLE)
    gx += gw + 0.16
text(s, 0.7, 5.6, 9, 0.4, "대상 — 입점 검토 중인 댄스 학원 원장님   ·   형식 — 실제 구현 화면 12개 기준 설명",
     size=11, color=FAINT)

# ================= 02 — 문제 제기 =================
s = add_slide()
slide_no(s, "02 / 09")
kicker(s, 0.7, 0.85, "지금 학원이 겪는 일")
text(s, 0.7, 1.35, 9, 0.7, "숫자로 보면, 문제는 셋뿐입니다.", size=26, bold=True, font=FONT_HEAD)
cards = [
    ("67%", "신규 문의가 “검색”에서 옴", "블로그·SNS로는 장르별 취향까지 걸러진 사람을 찾기 어렵습니다."),
    ("1/5", "수업의 노쇼·지각", "예약 확인 전화, 알람 문자를 원장님이 직접 보내는 학원이 대부분입니다."),
    ("월 6시간", "수기 장부·정산 정리", "현금·계좌이체·카드가 섞인 결제 내역을 매달 손으로 맞추는 시간입니다."),
]
cx = 0.7
for num, title, body in cards:
    box(s, cx, 2.3, 3.75, 3.4, fill=SURFACE, line_color=LINE, line_w=1, radius=0.06)
    text(s, cx + 0.3, 2.55, 3.2, 0.7, num, size=32, bold=True, color=ACCENT, font=FONT_HEAD)
    text(s, cx + 0.3, 3.35, 3.2, 0.5, title, size=13.5, bold=True)
    text(s, cx + 0.3, 3.85, 3.2, 1.7, body, size=10.5, color=DIM, line_spacing=1.3)
    cx += 3.98

# ================= 03~05 — 소비자 9화면 (원장님 설득 캡션) =================
def consumer_slide(no_label, kicker_label, headline, specs):
    s = add_slide()
    slide_no(s, no_label)
    kicker(s, 0.7, 0.85, kicker_label)
    text(s, 0.7, 1.3, 11, 0.5, headline, size=20, bold=True, font=FONT_HEAD)
    for x, pk, num, title, desc in specs:
        phone(s, x, YP + 0.15, **pk)
        caption(s, x, YP + 0.15 + PH + 0.14, PW + 0.6, num, title, desc)
    return s


consumer_slide(
    "03 / 09", "회원 화면 1/3", "가입 장벽을 낮춰서, 검색까지 바로 갑니다",
    [
        (XS[0], dict(title="회원가입", rows=[
            {"kind": "field", "label": "휴대폰 번호", "value": "010-••••-5521 · 인증완료"},
            {"kind": "chips", "chips": [("댄스스포츠", BALLROOM), ("탱고", TANGO)]},
            {"kind": "card", "title": "🎓 대학생이신가요?", "sub": "학교 이메일 인증", "h": 0.5},
        ]), "01", "회원가입 3초", "본인인증만 하면 바로 시작 — 이탈 없이 검색으로 넘어갑니다."),
        (XS[1], dict(title="학원 찾기", tab=0, rows=[
            {"kind": "field", "label": "검색", "value": "강남 · 살사 · 평일 저녁"},
            {"kind": "chips", "chips": [("살사", SALSA), ("바차타", BACHATA)]},
            {"kind": "card", "title": "라 클라베 스튜디오 ★4.9", "sub": "강남역 3번 출구 · 도보 5분"},
        ]), "02", "취향까지 걸러서 검색", "장르·지역·시간대로 좁힌 사람이 학원 앞까지 옵니다."),
        (XS[2], dict(title="학원 상세", header_icon="‹", rows=[
            {"kind": "photo", "h": 0.7, "badge": "사진 6장"},
            {"kind": "field", "label": "라 클라베 댄스 스튜디오", "value": "★4.9 (212) · 도보 5분"},
            {"kind": "card", "title": "살사 중급반 · 45,000원", "sub": "화·목 20:00 · 8/12"},
        ]), "03", "전화 문의가 줄어듭니다", "사진·시간표·정원까지 한 화면 — 물어볼 게 없어집니다."),
    ]
)

consumer_slide(
    "04 / 09", "회원 화면 2/3", "결제부터 방문까지, 이탈 없이 이어집니다",
    [
        (XS[0], dict(title="결제하기", header_icon="‹", rows=[
            {"kind": "field", "label": "수업", "value": "살사 중급반 · 화 20:00"},
            {"kind": "priceline", "k": "수업료", "v": "180,000원"},
            {"kind": "priceline", "k": "대학생 할인", "v": "-90,000원", "style": "discount"},
            {"kind": "priceline", "k": "총 결제금액", "v": "90,000원", "style": "total"},
            {"kind": "payopt", "label": "신용·체크카드", "sel": True},
        ]), "04", "투명한 결제 화면", "할인·쿠폰이 항목별로 보여서 결제 중 이탈이 없습니다."),
        (XS[1], dict(title="내 일정", tab=1, rows=[
            {"kind": "cal", "nums": [(1, False, None), (2, False, None), (3, True, SALSA),
                                      (4, False, None), (5, False, BACHATA), (6, False, None), (7, False, None)]},
            {"kind": "agenda", "title": "🔔 살사 중급반", "sub": "오늘 저녁 8:00 · 30분 전 알람", "color": SALSA},
        ]), "05", "노쇼가 줄어듭니다", "결제 즉시 캘린더 등록, 수업 30분 전 자동 알람."),
        (XS[2], dict(title="길찾기", tab=2, rows=[
            {"kind": "map", "h": 1.1},
            {"kind": "route", "a": "🚶 도보 · 12분 · 850m", "b": "🚇 강남역 3번 출구"},
        ]), "06", "첫 방문 포기를 막습니다", "예약 확인 화면에서 바로 경로 안내로 이어집니다."),
    ]
)

consumer_slide(
    "05 / 09", "회원 화면 3/3", "재방문과 노출까지 앱이 대신합니다",
    [
        (XS[0], dict(title="피드", tab=2, rows=[
            {"kind": "feed", "tag": "파티", "tagcolor": BACHATA, "title": "강남 바차타 소셜파티"},
            {"kind": "feed", "tag": "대회", "tagcolor": BALLROOM, "title": "2026 전국 챔피언십"},
        ]), "07", "다른 학원 회원에게도 노출", "우리 학원 파티·공연이 전체 뉴스피드에 올라갑니다."),
        (XS[1], dict(title="라 클라베 공지", header_icon="‹", rows=[
            {"kind": "notice", "title": "추석 연휴 휴강 안내", "meta": "9/16 게시", "pin": True},
            {"kind": "notice", "title": "10월 정기 발표회 신청", "meta": "9/12 게시"},
        ]), "08", "전화 대신 공지 하나로", "휴강·이벤트를 텍스트로 바로 올립니다 — OCR도 필요 없습니다."),
        (XS[2], dict(title="마이", tab=3, rows=[
            {"kind": "hero2", "label": "월 멤버십 중", "big": "다음 결제 10/13", "fill": ACCENT, "h": 0.7},
            {"kind": "coupon", "title": "🎟 1+1 할인권", "status": "사용가능", "d": "D-18"},
        ]), "09", "예측 가능한 매출", "멤버십 회원은 매달 자동 결제됩니다."),
    ]
)

# ================= 06 — 관리자 3화면 =================
s = add_slide()
slide_no(s, "06 / 09")
kicker(s, 0.7, 0.85, "원장님 화면")
text(s, 0.7, 1.3, 11, 0.5, "업로드 한 장이면, 나머지는 저희가 합니다", size=20, bold=True, font=FONT_HEAD)
admin_specs = [
    (XS[0], dict(title="포스터 업로드", rows=[
        {"kind": "upload"},
        {"kind": "card", "title": "10월_시간표.jpg", "sub": "처리중 · 09:41"},
    ]), "10", "타이핑 없이 업로드", "쓰던 포스터·전단지 사진 그대로 올리면 끝."),
    (XS[1], dict(title="추출 결과 검토", rows=[
        {"kind": "photo", "h": 0.55, "badge": "원본 보기"},
        {"kind": "reviewfield", "label": "장르", "value": "살사 중급반"},
        {"kind": "reviewfield", "label": "시간", "value": "화 20:00–21:00", "low": True},
        {"kind": "reviewfield", "label": "가격", "value": "45,000원", "low": True},
    ]), "11", "확인만 하면 됩니다", "자동으로 채워진 내용을 한 번 보고 게시 버튼만 누르시면 됩니다."),
    (XS[2], dict(title="이번 달 정산", rows=[
        {"kind": "hero2", "label": "실지급액", "big": "3,414,000원", "fill": BALLROOM, "h": 0.75},
        {"kind": "mini", "k": "플랫폼 수수료 (5% · 1년 면제 중)", "v": "0원"},
        {"kind": "mini", "k": "결제·카드 수수료 (수업료 몫 · 대표 부담)", "v": "-76,000원"},
        {"kind": "mini", "k": "신규 회원", "v": "14명"},
    ]), "12", "장부 정리가 사라집니다", "카드·현금·계좌이체 결제가 한 화면에 자동으로 정리됩니다."),
]
for x, pk, num, title, desc in admin_specs:
    phone(s, x, YP + 0.15, **pk)
    caption(s, x, YP + 0.15 + PH + 0.14, PW + 0.6, num, title, desc)

# ================= 07 — 할인 구조 표 =================
s = add_slide()
slide_no(s, "07 / 09")
kicker(s, 0.7, 0.85, "자주 묻는 질문")
text(s, 0.7, 1.35, 10, 0.6, "“할인·쿠폰, 저희가 부담하나요?”", size=22, bold=True, font=FONT_HEAD)
text(s, 0.7, 1.95, 9.5, 0.5,
     "네, 할인·쿠폰의 차액은 학원이 부담합니다. 대신 검색·추천·자동등록·결제 인프라는 플랫폼이 전부 무료로 제공합니다.",
     size=12.5, color=DIM)
rows_data = [
    ("대학생 첫 결제 1회 50%", "학원(대표)", "할인된 결제액 기준 정산"),
    ("1+1 할인권 (참여 학원만)", "학원(대표)", "추가 수업 1달치 50% 차액 부담"),
    ("결제·카드 수수료", "학원(대표) · 수업료 몫만", "실비 공제. 예매 수수료 몫은 플랫폼 부담"),
    ("플랫폼 수수료", "학원 (5%, 입점 1년 면제)", "결제액의 95% 지급"),
]
tx0, ty0 = 0.7, 2.6
colw = [4.2, 2.8, 4.0]
rowh = 0.5
headers = ["항목", "부담 주체", "학원 정산 기준"]
box(s, tx0, ty0, sum(colw), rowh, fill=SURFACE2)
cx = tx0
for h, w in zip(headers, colw):
    text(s, cx + 0.22, ty0, w - 0.3, rowh, h, size=11, bold=True, color=FAINT, anchor=MSO_ANCHOR.MIDDLE)
    cx += w
y = ty0 + rowh
for item, who, calc in rows_data:
    box(s, tx0, y, sum(colw), rowh, fill=SURFACE, line_color=LINE, line_w=0.75)
    cx = tx0
    for val, w, bold_ in zip([item, who, calc], colw, [True, False, False]):
        text(s, cx + 0.22, y, w - 0.3, rowh, val, size=10.5, bold=bold_, color=INK if bold_ else DIM,
             anchor=MSO_ANCHOR.MIDDLE)
        cx += w
    y += rowh

# ================= 08 — 입점 절차 =================
s = add_slide()
slide_no(s, "08 / 09")
kicker(s, 0.7, 0.85, "입점 절차")
text(s, 0.7, 1.35, 9, 0.6, "서류 없이, 3단계면 됩니다.", size=26, bold=True, font=FONT_HEAD)
steps = [
    ("1", "계좌·사업자 등록", "정산받을 계좌와 사업자등록증만 준비하시면 됩니다."),
    ("2", "포스터 한 장만 업로드", "쓰시던 포스터·전단지 사진을 올리면 장르·시간표·가격이 자동으로 채워집니다."),
    ("3", "베타 오픈", "입점 후 1년은 플랫폼 수수료 없이 운영하고, 이후 5%를 청구합니다."),
]
cx = 0.7
for n, title, body in steps:
    box(s, cx, 2.3, 3.75, 2.3, fill=SURFACE, line_color=LINE, line_w=1, radius=0.06)
    text(s, cx + 0.3, 2.5, 1.0, 0.6, n, size=26, bold=True, color=GOLD, font=FONT_HEAD)
    text(s, cx + 0.3, 3.15, 3.2, 0.4, title, size=13.5, bold=True)
    text(s, cx + 0.3, 3.55, 3.2, 0.9, body, size=10.5, color=DIM, line_spacing=1.3)
    cx += 3.98
box(s, 0.7, 4.95, 11.93, 1.5, fill=SURFACE2, radius=0.08)
text(s, 1.1, 5.2, 11, 0.5, "지금 시작하면, 첫 1년은 플랫폼 수수료가 없습니다.", size=17, bold=True, font=FONT_HEAD)
text(s, 1.1, 5.75, 11, 0.4, "입점 후 1년 동안은 플랫폼 수수료 5%를 면제합니다. 결제·카드 수수료는 실비로 공제하되, 예매 수수료가 붙는 결제는 수업료 몫만 학원이 부담합니다.", size=12, color=DIM)

# ================= 09 — Closing =================
s = add_slide(bg=INK)
text(s, 0.7, 3.0, 11.9, 1.2, "감사합니다.", size=40, bold=True, color=WHITE, font=FONT_HEAD, align=PP_ALIGN.CENTER)
text(s, 0.7, 4.1, 11.9, 0.6, "09 / 09 · 소셜댄스 입점 설명회 (화면 12개 전체 기준)", size=13,
     color=RGBColor(200, 190, 210), align=PP_ALIGN.CENTER)

prs.save(str(Path(__file__).resolve().parents[1] / "docs" / "deck" / "소셜댄스_입점설명회.pptx"))
print("saved")
