"""K-DanceX4 소셜댄스 입점 설명회 — 대표·강사·회원 공통 PPTX 생성 스크립트

spec(specs/001-ai-dance-class-platform/spec.md)과 정책·약관 문서의 2026-09-30 기준
"최종 예상 시나리오"를 세 독자 순서(회원 → 강사 → 대표 → 돈의 흐름)로 풀어 쓴다.
실행: cd backend && uv run --with python-pptx python build_onboarding_pptx.py
근거 FR 번호는 슬라이드 본문이 아니라 발표자 노트에 둔다.
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
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
BLUE = RGBColor(0x3D, 0x4C, 0x9E)
BLUE_BG = RGBColor(0xE7, 0xEA, 0xF7)
GOLD_BG = RGBColor(0xFA, 0xF0, 0xDC)

# 장르 4종 (docs/policy/genre-taxonomy-policy.md)
GENRES = [("댄스스포츠", BLUE), ("아르헨티나 탱고", ACCENT), ("스윙댄스", GOLD), ("살사/바차타", RGBColor(0xDB, 0x7B, 0x1E))]
ROLE_COLOR = {"회원": BLUE, "강사": OK, "대표": ACCENT, "돈": GOLD, "공통": DIM}
ROLE_BG = {"회원": BLUE_BG, "강사": OK_BG, "대표": ACCENT_SOFT, "돈": GOLD_BG, "공통": SURFACE2}

FONT = "맑은 고딕"
TOTAL = 22
BASIS = "2026-09-30"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
SW, SH = prs.slide_width, prs.slide_height
_no = [0]


def add_slide(bg=BG):
    s = prs.slides.add_slide(BLANK)
    r = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SW, SH)
    r.fill.solid(); r.fill.fore_color.rgb = bg
    r.line.fill.background(); r.shadow.inherit = False
    s.shapes._spTree.remove(r._element)
    s.shapes._spTree.insert(2, r._element)
    _no[0] += 1
    return s


def box(slide, l, t, w, h, fill=None, line_color=None, line_w=None, radius=None, shape=None):
    shp_type = shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE)
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


def text(slide, l, t, w, h, runs, size=14, color=INK, bold=False, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, line_spacing=1.15, wrap=True):
    tb = slide.shapes.add_textbox(Inches(l), Inches(t), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    if isinstance(runs, str):
        runs = [runs]
    for i, line in enumerate(runs):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        # ("텍스트", bold, color) 튜플이면 부분 서식
        parts = line if isinstance(line, list) else [(line, bold, color)]
        for seg in parts:
            if isinstance(seg, str):
                seg = (seg, bold, color)
            r = p.add_run()
            r.text = seg[0]
            r.font.size = Pt(size)
            r.font.bold = seg[1]
            r.font.name = FONT
            r.font.color.rgb = seg[2]
    return tb


def kicker(slide, l, t, label, color=ACCENT, bg=ACCENT_SOFT):
    w = 0.5 + 0.13 * len(label)
    box(slide, l, t, w, 0.34, fill=bg, radius=0.5)
    text(slide, l, t, w, 0.34, label, size=11, color=color, bold=True,
         align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    return w


def header(slide, role, kick, title, sub=None):
    """상단 공통: 페이지 번호 · 독자 태그 · 제목 · 부제"""
    text(slide, 0.6, 0.35, 5, 0.3, f"{_no[0]:02d} / {TOTAL} · 입점 설명회", size=10, color=FAINT)
    w = kicker(slide, 0.7, 0.8, role, color=ROLE_COLOR[role], bg=ROLE_BG[role])
    kicker(slide, 0.7 + w + 0.12, 0.8, kick)
    text(slide, 0.7, 1.3, 11.9, 0.7, title, size=26, bold=True)
    if sub:
        text(slide, 0.7, 2.0, 11.9, 0.5, sub, size=13, color=DIM)


def notes(slide, body):
    slide.notes_slide.notes_text_frame.text = body


def bullets(slide, l, t, w, h, items, size=12.5, color=INK, gap=1.35):
    runs = []
    for it in items:
        if isinstance(it, tuple):
            runs.append([("• ", True, ACCENT), (it[0], True, color), (it[1], False, DIM)])
        else:
            runs.append([("• ", True, ACCENT), (it, False, color)])
    text(slide, l, t, w, h, runs, size=size, line_spacing=gap)


def card(slide, l, t, w, h, title, body, num=None, color=ACCENT, fill=SURFACE, body_size=10.5):
    box(slide, l, t, w, h, fill=fill, line_color=LINE, line_w=1, radius=0.06)
    y = t + 0.22
    if num:
        text(slide, l + 0.28, y, w - 0.5, 0.5, num, size=24, bold=True, color=color)
        y += 0.6
    text(slide, l + 0.28, y, w - 0.5, 0.4, title, size=13, bold=True)
    text(slide, l + 0.28, y + 0.42, w - 0.5, h - (y - t) - 0.5, body, size=body_size, color=DIM, line_spacing=1.3)


def table(slide, l, t, headers, rows, colw, rowh=0.46, size=10.5, head_fill=SURFACE2):
    box(slide, l, t, sum(colw), rowh, fill=head_fill)
    cx = l
    for hd, w in zip(headers, colw):
        text(slide, cx + 0.18, t, w - 0.25, rowh, hd, size=size, bold=True, color=FAINT, anchor=MSO_ANCHOR.MIDDLE)
        cx += w
    y = t + rowh
    for row in rows:
        box(slide, l, y, sum(colw), rowh, fill=SURFACE, line_color=LINE, line_w=0.75)
        cx = l
        for i, (val, w) in enumerate(zip(row, colw)):
            text(slide, cx + 0.18, y, w - 0.25, rowh, val, size=size, bold=(i == 0),
                 color=INK if i == 0 else DIM, anchor=MSO_ANCHOR.MIDDLE)
            cx += w
        y += rowh
    return y


def flow(slide, l, t, steps, w_each=2.15, h=0.95, gap=0.42, color=ACCENT, fill=SURFACE, size=11):
    """가로 흐름: 상자 → 화살표 → 상자"""
    x = l
    for i, (title, sub) in enumerate(steps):
        box(slide, x, t, w_each, h, fill=fill, line_color=LINE, line_w=1, radius=0.12)
        box(slide, x, t, 0.07, h, fill=color)
        text(slide, x + 0.2, t + 0.12, w_each - 0.3, 0.3, title, size=size, bold=True)
        text(slide, x + 0.2, t + 0.44, w_each - 0.3, h - 0.5, sub, size=size - 2.5, color=DIM, line_spacing=1.25)
        if i < len(steps) - 1:
            ax = x + w_each + 0.08
            a = box(slide, ax, t + h / 2 - 0.13, gap - 0.16, 0.26, fill=FAINT, shape=MSO_SHAPE.RIGHT_ARROW)
        x += w_each + gap
    return x


def note_box(slide, l, t, w, h, title, body, color=GOLD, fill=GOLD_BG, size=11):
    box(slide, l, t, w, h, fill=fill, radius=0.08)
    box(slide, l, t, 0.08, h, fill=color)
    text(slide, l + 0.3, t + 0.15, w - 0.5, 0.3, title, size=size + 1, bold=True, color=color)
    text(slide, l + 0.3, t + 0.5, w - 0.5, h - 0.6, body, size=size, color=INK, line_spacing=1.3)


# =========================================================== 01 표지
s = add_slide()
text(s, 0.7, 0.5, 6, 0.3, f"K-DanceX4 · 소셜댄스 입점 설명회 · {BASIS} 기준", size=11, color=FAINT)
text(s, 0.7, 1.4, 11.5, 2.4, ["찾고, 예약하고, 결제하고,", "정산까지 한 앱에서 끝납니다."],
     size=40, bold=True, line_spacing=1.12)
text(s, 0.7, 3.65, 10.5, 1.0,
     "회원은 취향에 맞는 수업을 찾아 바로 결제하고, 강사는 수업과 명단을 관리하고,\n"
     "대표는 포스터 한 장으로 수업을 올리고 매달 5일 정산을 받습니다.",
     size=15, color=DIM, line_spacing=1.35)
gx = 0.7
for label, col in GENRES:
    gw = 0.55 + 0.15 * len(label)
    box(s, gx, 4.95, gw, 0.44, fill=SURFACE, line_color=LINE, line_w=1, radius=0.5)
    d = s.shapes.add_shape(MSO_SHAPE.OVAL, Inches(gx + 0.15), Inches(4.95 + 0.16), Inches(0.12), Inches(0.12))
    d.fill.solid(); d.fill.fore_color.rgb = col; d.line.fill.background(); d.shadow.inherit = False
    text(s, gx + 0.34, 4.95, gw - 0.34, 0.44, label, size=11, color=DIM, anchor=MSO_ANCHOR.MIDDLE)
    gx += gw + 0.16
text(s, 0.7, 5.75, 11.5, 0.7,
     "대상 — 입점을 검토하는 학원 대표 · 소속 강사 · 수업을 들을 회원\n"
     "이 자료는 확정된 요구사항(2026-09-30)을 기준으로 한 최종 예상 시나리오입니다. 화면은 개발 중입니다.",
     size=10.5, color=FAINT, line_spacing=1.3)
notes(s, "근거: spec Status(미해결 2건 남음), docs/policy/genre-taxonomy-policy.md(장르 4종), docs/policy/distribution-policy.md(Android·갤럭시 스토어). "
         "'개발 중' — SCH_kdance.html 기준 1회차 슬라이스(취소·환불)만 완료, 결제 생성 경로·인증은 미구현.")

# =========================================================== 02 오늘 이야기
s = add_slide()
header(s, "공통", "오늘 이야기", "세 사람의 하루를 따라갑니다", "같은 앱을 회원·강사·대표가 각자 다른 화면으로 씁니다. 마지막에 돈이 어떻게 흐르는지 한 장으로 모읍니다.")
cols = [
    ("회원", "찾기 → 결제 → 혜택 → 취소·환불 → 문의", ["장르·시간·지역으로 검색, AI 추천", "카드·간편결제·계좌 모두 PG 한 곳", "대학생 첫 결제 50%, 3개월 3,000원 멤버십", "정규 과정은 학원 규정, 행사는 공통 규정"]),
    ("강사", "프로필 → 수업 등록 → 운영 → 정산", ["장르·경력·레벨 프로필", "수업 8구분 × 운영 형태 6종", "명단·대기·출석·레벨 점수", "급여가 아닌 3단계 정산"]),
    ("대표", "입점 → 등록 → 환불 처리 → 정산", ["등록 형태 증빙, 항목별 동의", "포스터 한 장으로 수업 등록", "환불은 대표가 정하고 실행", "매월 5일, PG 가 직접 지급"]),
]
cx = 0.7
for role, path, items in cols:
    box(s, cx, 2.7, 3.85, 3.9, fill=SURFACE, line_color=LINE, line_w=1, radius=0.06)
    box(s, cx, 2.7, 3.85, 0.09, fill=ROLE_COLOR[role])
    text(s, cx + 0.3, 2.95, 3.3, 0.4, role, size=18, bold=True, color=ROLE_COLOR[role])
    text(s, cx + 0.3, 3.4, 3.3, 0.4, path, size=10.5, color=FAINT)
    bullets(s, cx + 0.3, 3.9, 3.3, 2.5, items, size=11.5)
    cx += 4.05
notes(s, "근거: spec User Story 1~13. US1(수업 찾아 결제)·US2(강사 수업·자리 관리)가 P1.")

# =========================================================== 03 구조 한 장
s = add_slide()
header(s, "공통", "전체 구조", "누가 누구와 이어지는가", "회사는 통신판매중개자입니다. 수업의 판매 당사자는 학원(주최자)이고, 돈은 결제대행사(PG)가 보관하고 나눠 보냅니다.")
# 중앙 앱, 좌우 역할, 아래 PG
box(s, 5.1, 2.75, 3.1, 1.2, fill=INK, radius=0.1)
text(s, 5.1, 2.75, 3.1, 1.2, ["K-DanceX4 앱", "검색 · 예약 · 결제 · 문의 · 정산 조회"], size=13, bold=True, color=WHITE, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
for (lbl, sub, x, col, bg) in [("회원", "수강생 · 파티 참가자", 0.9, BLUE, BLUE_BG), ("강사", "프리랜서 · 소속 학원 여럿 가능", 0.9, OK, OK_BG),
                                ("대표", "학원 · 승인받은 개인·동호회 주최자", 9.4, ACCENT, ACCENT_SOFT), ("플랫폼 운영자", "앱·웹 시스템만 관리, 문의는 받지 않음", 9.4, DIM, SURFACE2)]:
    pass
left = [("회원", "수강생 · 파티 참가자", BLUE, BLUE_BG), ("강사", "프리랜서 · 여러 학원 소속 가능", OK, OK_BG)]
right = [("대표", "학원 · 승인받은 개인·동호회 주최자", ACCENT, ACCENT_SOFT), ("플랫폼 운영자", "앱·웹 시스템만 관리. 사람 문의는 받지 않음", DIM, SURFACE2)]
for i, (lbl, sub, col, bg) in enumerate(left):
    y = 2.35 + i * 1.35
    box(s, 1.0, y, 3.2, 1.0, fill=bg, radius=0.1); box(s, 1.0, y, 0.08, 1.0, fill=col)
    text(s, 1.25, y + 0.15, 2.9, 0.3, lbl, size=13, bold=True, color=col)
    text(s, 1.25, y + 0.5, 2.9, 0.4, sub, size=9.5, color=DIM)
    box(s, 4.3, y + 0.38, 0.7, 0.24, fill=FAINT, shape=MSO_SHAPE.RIGHT_ARROW)
for i, (lbl, sub, col, bg) in enumerate(right):
    y = 2.35 + i * 1.35
    box(s, 9.1, y, 3.3, 1.0, fill=bg, radius=0.1); box(s, 9.1, y, 0.08, 1.0, fill=col)
    text(s, 9.35, y + 0.15, 3.0, 0.3, lbl, size=13, bold=True, color=col)
    text(s, 9.35, y + 0.5, 3.0, 0.4, sub, size=9.5, color=DIM)
    box(s, 8.3, y + 0.38, 0.7, 0.24, fill=FAINT, shape=MSO_SHAPE.LEFT_RIGHT_ARROW)
box(s, 6.5, 4.05, 0.3, 0.6, fill=FAINT, shape=MSO_SHAPE.DOWN_ARROW)
box(s, 4.6, 4.8, 4.1, 1.0, fill=GOLD_BG, radius=0.1); box(s, 4.6, 4.8, 0.08, 1.0, fill=GOLD)
text(s, 4.85, 4.93, 3.8, 0.3, "결제대행사(PG) — 돈을 보관하고 나눠 보냄", size=12, bold=True, color=GOLD)
text(s, 4.85, 5.28, 3.8, 0.45, "플랫폼은 돈을 쥐지 않고 누구에게 얼마를 보낼지만 지시합니다. 학원은 PG 의 하위 판매자로 등록됩니다.", size=9.5, color=DIM, line_spacing=1.25)
box(s, 0.9, 6.0, 11.5, 0.75, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
text(s, 1.15, 6.08, 11.1, 0.6, [[("AI 는 읽기만 합니다. ", True, INK), ("추천·문의 답변·홍보 이미지는 AI 가 초안을 내고, 게시와 결제·정산 기록은 사람과 앱이 합니다. AI 가 만든 결과에는 표시가 붙습니다.", False, DIM)]], size=10.5, anchor=MSO_ANCHOR.MIDDLE)
notes(s, "근거: 정의서 1장 구조도, FR-240(통신판매중개자 고지), FR-282d(정산 분배로 학원 직접 지급), FR-204(운영자 역할 한정), FR-258(AI 생성 결과 표시), CLAUDE-decisions ADR-004(에이전트는 MCP 로 읽기만).")

# =========================================================== 04 문제
s = add_slide()
header(s, "공통", "지금 겪는 일", "학원 밖에서 벌어지는 세 가지 낭비", "숫자보다 장면으로 말씀드립니다. 이 세 장면이 앱이 대신 맡는 일입니다.")
scenes = [
    ("찾는 사람과 학원이 서로를 못 찾는다", "블로그·SNS 검색으로는 장르·레벨·시간대·거리까지 맞는 사람을 걸러내지 못합니다. 여러 학원을 다니는 사람은 일정을 손으로 맞춥니다."),
    ("확인 전화와 노쇼가 원장 몫이다", "예약 확인, 수업 전 알림, 입금 확인, 취소·환불 문의가 전부 전화와 메시지로 옵니다. 정원이 찼는데 대기자를 받을 방법이 없습니다."),
    ("현금·계좌이체·카드 장부가 따로 논다", "결제 방법이 섞여 매달 손으로 맞춥니다. 강사에게 얼마를 언제 줄지, 환불한 건은 어디서 뺄지 근거가 흩어져 있습니다."),
]
cx = 0.7
for title, body in scenes:
    card(s, cx, 2.7, 3.85, 3.6, title, body, body_size=11)
    cx += 4.05
notes(s, "정성 서술로만 쓴다 — 예전 설명회 자료의 67%·1/5·월 6시간 같은 수치는 출처가 없어 쓰지 않는다. 근거: US1·US2·US4·US9 의 Why this priority.")

# =========================================================== 05 회원 — 찾기
s = add_slide()
header(s, "회원", "1 · 찾기", "취향·시간·거리로 좁혀서, 근거와 함께 추천받습니다")
bullets(s, 0.7, 2.25, 6.0, 4.2, [
    ("장르 4종 · 세부 장르 · 레벨 ", "— 댄스스포츠, 아르헨티나 탱고, 스윙댄스, 살사/바차타. 입문자에게는 입문 수업이 먼저 보입니다"),
    ("가능한 시간대 · 현재 위치에서 이동 가능한 범위 ", "— 지도와 이동 시간으로 거릅니다"),
    ("정렬 5종 ", "— 처음은 추천순, 인기순(최근 7일 조회)·거리·가격·마감 임박"),
    ("정원과 남은 자리가 바로 보입니다 ", "— 남·여 정원을 따로 두는 수업은 자리별로 표시"),
    ("이미 잡힌 일정과 겹치면 경고 ", "— 막지 않고, 겹치는 수업을 보여 준 뒤 진행할지 묻습니다"),
    ("이동 시간이 부족해도 경고 ", "— 시각은 안 겹쳐도 다음 수업까지 못 가면 알려 줍니다"),
], size=12)
box(s, 7.1, 2.25, 5.5, 4.2, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
text(s, 7.4, 2.45, 5.0, 0.4, "AI 에이전트 검색 (멤버십 혜택 · 가입 3개월 체험)", size=13, bold=True, color=BLUE)
text(s, 7.4, 2.9, 5.0, 1.0, "\"강남에서 평일 저녁, 살사 초급, 다음 주부터\" 처럼 말로 하면 조건에 맞는 수업을 찾아 왜 추천했는지 근거를 같이 보여 줍니다.", size=11, color=DIM, line_spacing=1.3)
bullets(s, 7.4, 3.95, 5.0, 2.4, [
    "추천 이유(장르·거리·시간·레벨 일치)를 항목으로 표시",
    "정해진 시간 안에 못 끝내면 필터 검색으로 자동 대체",
    "AI 가 만든 답에는 'AI 생성' 표시",
    "메인 상단 전광판 — 1+1 참여 학원 수업의 실시간 검색 순위",
], size=11)
notes(s, "근거: FR-020~FR-036a(장르·검색·정렬), FR-035(일정 겹침 표시, Q6 2026-09-30 확정), US4 시나리오 4(이동 시간), US6·FR-041(추천 시간 초과 대체), FR-112c/FR-112d(AI 검색은 멤버십·체험), FR-121d(실시간 수업 검색 순위), FR-258.")

# =========================================================== 06 회원 — 결제
s = add_slide()
header(s, "회원", "2 · 결제", "결제수단은 다 되고, 돈은 PG 가 보관합니다", "학원 계좌로 직접 보내는 방식은 없습니다. 모든 결제가 PG 한 곳을 거쳐야 정산과 환불이 어긋나지 않습니다.")
flow(s, 0.7, 2.75, [
    ("수업 선택", "정원·자리(남/여)·환불 규정 확인"),
    ("결제수단 선택", "카드 · 간편결제 · 계좌이체 · 가상계좌"),
    ("결제 기한 안에 완료", "카드·간편이체 15분, 가상계좌 24시간(수업 1시간 전까지)"),
    ("확정", "예약 확정 · 인원 반영 · 캘린더 등록 · 알림"),
    ("수업 전 알림", "하루 전 · 2시간 · 1시간 · 30분 전 중 선택"),
], w_each=2.2, h=1.15, gap=0.3, color=BLUE)
bullets(s, 0.7, 4.3, 6.2, 2.4, [
    ("결제 화면에 전부 보입니다 ", "— 수업료, 할인, 쿠폰, 예매 수수료(행사만 2,000원), 환불 규정, 환불 마감일"),
    ("결제 순간의 값이 고정됩니다 ", "— 나중에 규정·가격이 바뀌어도 결제 때 본 조건이 적용"),
    ("정원이 차면 결제 버튼이 닫힙니다 ", "— 결제 도중 찼으면 결제를 확정하지 않고 되돌립니다"),
    ("가상계좌 입금 전에는 스스로 취소 ", "— 돈이 안 오갔으니 환불이 아니라 자리만 풉니다"),
], size=11.5)
box(s, 7.2, 4.3, 5.4, 2.35, fill=BLUE_BG, radius=0.08); box(s, 7.2, 4.3, 0.08, 2.35, fill=BLUE)
text(s, 7.45, 4.45, 5.0, 0.3, "정원이 찼을 때 — 대기 신청", size=12.5, bold=True, color=BLUE)
bullets(s, 7.45, 4.85, 5.0, 1.8, [
    "수업 시작 24시간 전까지 대기, 순번이 보입니다",
    "자리가 나면 알림 → 1번 대기자에게 먼저 결제 기회",
    "멤버십 회원과 가입 3개월 체험 회원만 쓸 수 있습니다. 그 밖에는 멤버십 안내",
], size=10.5)
notes(s, "근거: FR-110(PG 단일 결제 경로), FR-111a(모든 결제 카드 허용), FR-280~FR-299(결제 상세), 전제 18(결제 기한), FR-284(주문 시점 값 고정), FR-091a(정원 마감 시 결제 비활성), FR-286(입금 전 셀프 취소), FR-093·FR-094(대기), FR-112c/d, FR-141(알림 시점).")

# =========================================================== 07 회원 — 혜택
s = add_slide()
header(s, "회원", "3 · 혜택", "대학생은 첫 결제 반값, 멤버십은 3개월 3,000원")
card(s, 0.7, 2.25, 3.9, 4.3, "대학생 첫 결제 50%", "학교 이메일(.ac.kr) 인증 한 번이면 됩니다. 처음 결제하는 수업 1건 1달치에만, 사람당 1회.\n\n허위 인증이 확인되면 할인분을 다시 청구합니다. 같은 이메일로 여러 계정이 받을 수 없습니다.", num="50%", color=BLUE)
card(s, 4.75, 2.25, 3.9, 4.3, "3개월 멤버십 3,000원 · 연 10,800원", "① AI 에이전트 검색\n② 정원 마감 수업 대기 신청·알림\n③ 1+1 할인권 — 3개월 멤버십 결제 즉시 1장(연 멤버십은 동반자 쿠폰)\n\n가입 후 3개월은 멤버십 없이도 ①②를 체험합니다. 결제 뒤 환불 없이 해지만 할 수 있습니다.", num="₩3,000", color=ACCENT)
card(s, 8.8, 2.25, 3.85, 4.3, "1+1 할인권은 이렇게 씁니다", "수업 1달을 정가로 신청할 때 쿠폰을 쓰면 내 레벨 이하의 다른 수업 1개를 1달 무료로 함께 신청합니다. 무료는 1달치뿐입니다.\n\n개강일이 쿠폰 유효기간 안이고 정가 수업 개강일 앞뒤 30일 안인 수업에, 발급 3개월 안에, 1+1 참여 학원에서만. 시범 기간에는 댄스스포츠 라틴 수업만.", num="1+1", color=GOLD)
notes(s, "근거: FR-006~FR-007(대학생 인증·회수), FR-112(3개월 3,000원, Q13 2026-09-30 확정)·FR-112a(연 10,800원)·FR-112c·FR-112d·FR-297a(14일 환불), FR-120~FR-123(1+1 쿠폰 규칙), docs/policy/subscription-benefits.md. 부가세 포함 소비자가로 적었다(전제).")

# =========================================================== 08 회원 — 취소·환불
s = add_slide()
header(s, "회원", "4 · 취소·환불", "정규 과정은 학원 규정대로, 행사는 공통 규정대로", "회원이 누르면 바로 환불되는 방식이 아닙니다. 대표가 정하고 대표가 실행합니다. 대신 어느 규정이 적용되는지 결제 전에 다 보입니다.")
box(s, 0.7, 2.75, 5.9, 3.85, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
box(s, 0.7, 2.75, 5.9, 0.09, fill=OK)
text(s, 1.0, 2.98, 5.3, 0.35, "정규 과정 · 개인 레슨", size=14, bold=True, color=OK)
bullets(s, 1.0, 3.45, 5.3, 3.0, [
    ("앱 > 문의 > 수업 선택 > 환불 요청 ", "— 담당 강사 확인 뒤 대표가 처리"),
    ("학원의 환불·취소 공지가 규정입니다 ", "— 취소 시점·기준·불가 사유·처리 기간·요청 방법·연락처 6항목"),
    ("법정 기준이 밑바닥입니다 ", "— 학원·교습소는 학원법 기준을 자동으로 넣고, 대표는 환불을 더 해 주는 쪽으로만 고칩니다"),
    ("결제 때 본 공지가 적용됩니다 ", "— 나중에 공지가 바뀌어도 소급하지 않습니다"),
], size=11)
box(s, 6.8, 2.75, 5.85, 3.85, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
box(s, 6.8, 2.75, 5.85, 0.09, fill=ACCENT)
text(s, 7.1, 2.98, 5.3, 0.35, "이벤트 · 원데이 · 파티 · 공연 · 대회", size=14, bold=True, color=ACCENT)
table(s, 7.1, 3.45, ["취소 시점", "취소 수수료"], [
    ("결제 당일 자정 전", "없음"),
    ("행사 10일 전까지", "10% 이내"),
    ("9~7일 전 / 6~3일 전", "10% / 20%"),
    ("2일 전 ~ 환불 마감일", "30%"),
    ("환불 마감일 이후", "취소·환불 불가"),
], [2.9, 2.35], rowh=0.36, size=10)
text(s, 7.1, 5.7, 5.3, 0.85, "예약 상세의 취소 버튼으로 신청하면 시스템이 계산한 금액을 대표가 확인해 실행합니다. 3영업일 안에 실행하지 않으면 자동 환불. 예매 수수료 2,000원은 돌려주지 않습니다(휴강·폐강·행사 취소·법정 청약철회는 예외).", size=9.5, color=DIM, line_spacing=1.25)
notes(s, "근거: FR-098~FR-098b(대표 처리 환불), FR-099~FR-099e(공지 양식·취소 규정·환불 마감일·행사 일괄 취소), FR-086(등록 형태별 템플릿), FR-245(결제 시점 정책 적용), FR-282a(예매 수수료), FR-293~FR-295. ⚠ 마감일 뒤 전면 불가·10일 전 수수료는 공정위 기준과 달라 법률 검토 대상(Q11 ①) — 발표 때 '검토 중'으로 말한다.")

# =========================================================== 09 회원 — 문의
s = add_slide()
header(s, "회원", "5 · 문의", "물어보면 답이 오고, 못 답하면 그 학원 대표에게 갑니다", "플랫폼 운영자는 앱·웹 시스템만 관리합니다. 수업·결제·환불·출석·레벨 문의는 전부 대표가 받습니다.")
flow(s, 0.7, 2.85, [
    ("질문 입력", "문의 화면에서 학원·수업을 검색하거나 내 예약에서 고름"),
    ("AI 가 등급을 나눔", "T0 안내 · T1 조회 · T2 판단형(멤버십) · T3 사람"),
    ("AI 답변", "내 예약 조회 · 자주 묻는 질문 · 규정 안내. AI 생성 표시"),
    ("대표 선택 화면", "AI 가 못 답하거나 사람이 필요하면 그 학원 대표에게 알림"),
    ("대표 답변", "환불 규정에 적은 처리 기간 안에"),
], w_each=2.2, h=1.25, gap=0.3, color=BLUE, size=10.5)
bullets(s, 0.7, 4.5, 11.9, 2.0, [
    ("여럿이 동시에 물어도 ", "순서와 진행 상태가 보이고, 베타는 노트북 한 대에서 동시 10명을 받도록 실측했습니다"),
    ("AI 의 근거는 학원이 승인한 지식뿐 ", "— 근거가 없으면 지어내지 않고 사람에게 넘깁니다"),
    ("문의 미응답이 반복되는 학원은 ", "사유 통지 → 소명 → 게시 제한 순서로 조치합니다"),
], size=11.5)
notes(s, "근거: US11·US12, FR-200~FR-209a(질문 4등급·대표 선택 문의·운영자 역할 한정), FR-226(지식 승인), FR-260~FR-279(동시 사용), SC-041(동시 10명), FR-254·FR-255(이용 제한 절차), local-ai-capacity.md 실측.")

# =========================================================== 10 강사 — 등록
s = add_slide()
header(s, "강사", "1 · 프로필과 수업 등록", "프로필을 만들고, 가능한 시간에 수업을 엽니다")
bullets(s, 0.7, 2.25, 6.1, 4.3, [
    ("프로필 ", "— 장르·세부 장르·경력·활동 학원·소개 영상(초상 이용 동의, 해당 수업 홍보에만)"),
    ("여러 학원 소속 가능 ", "— 다른 학원 일정과 겹치는 시간은 불가 시간으로 표시됩니다"),
    ("수업 구분 6종 ", "— 정규·이벤트·원데이·파티·공연·대회(축제·외부 행사는 대회로 표시)"),
    ("개인 레슨 ", "— 학원에서 여는 10회 수강권. 원데이·이벤트·파티·공연·대회는 회차 하나, 정규는 기간 전체로 신청"),
    ("정원 ", "— 전체 정원과 남·여 정원. 강의실이 같은 시각에 겹치면 등록이 거부됩니다"),
    ("행사형은 환불 마감일 필수 ", "— 비어 있으면 게시도 결제도 열리지 않습니다"),
], size=11.5)
box(s, 7.1, 2.25, 5.5, 4.3, fill=OK_BG, radius=0.08); box(s, 7.1, 2.25, 0.08, 4.3, fill=OK)
text(s, 7.4, 2.45, 5.0, 0.35, "AI 가 초안을 만들고, 강사가 검토한 뒤에만 게시", size=13, bold=True, color=OK)
bullets(s, 7.4, 2.95, 5.0, 3.5, [
    ("소개 문구 ", "— 올린 사진·영상과 수업 정보로 제목·소개 초안"),
    ("홍보 이미지 ", "— 강사가 쓴 문장대로 생성. 글자는 앱이 위에 얹습니다. 계정마다 하루 3회(베타), 사진이 있으면 사진 우선"),
    ("환불·취소 공지 자동 삽입 ", "— 대표가 학원 설정에 한 번 적어 두면 수업 등록 페이지에 그대로 들어갑니다. 강사는 고치지 않습니다"),
    ("빈 강의실 제안 ", "— 학원이 공개한 빈 시간대에 개설을 제안하면 대표 승인 뒤 등록"),
], size=10.5)
notes(s, "근거: FR-025(강사 프로필, Q10), FR-083(타 학원 일정 불가 시간), FR-051·FR-052·FR-052a, FR-050·FR-092(정원), FR-072(강의실 충돌), FR-099d(환불 마감일 필수), FR-061·FR-061a(AI 초안), FR-099a·FR-099b(공지 자동 입력), FR-062(빈 강의실 제안).")

# =========================================================== 11 강사 — 운영
s = add_slide()
header(s, "강사", "2 · 운영", "명단·대기·출석·레벨을 한 화면에서 봅니다")
bullets(s, 0.7, 2.25, 6.1, 4.3, [
    ("신청 명단과 남은 자리 ", "— 실시간. 정원이 차면 대기 순번까지"),
    ("출석 ", "— 강사가 기록하고, 수강생의 '불참 예정' 표시가 더해집니다. 출석은 정산의 근거라 사실대로"),
    ("휴강·보강·대타 ", "— 회차 단위로 휴강·폐강을 고르고, 대타를 요청합니다. 학원 사정 휴강은 예매 수수료까지 환불"),
    ("회차 옮기기 ", "— 대표가 허용한 수업만 수강생이 회차를 옮깁니다"),
    ("시간·장소가 바뀌면 ", "예약자 전원에게 변경 전후 값이 담긴 알림이 즉시 갑니다"),
    ("개강 인원 ", "— 수강 이력으로 레벨을 보고 개강 인원을 뽑습니다"),
], size=11.5)
box(s, 7.1, 2.25, 5.5, 4.3, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
text(s, 7.4, 2.45, 5.0, 0.35, "레벨 — 두 가지가 있습니다", size=13, bold=True, color=OK)
text(s, 7.4, 2.85, 5.0, 0.5, "경력으로 정하는 프로필 레벨과, 강사가 세부 장르마다 매기는 0~10 점수 레벨.", size=10.5, color=DIM, line_spacing=1.25)
table(s, 7.4, 3.45, ["경력 레벨", "경력", "점수 레벨", "점수"], [
    ("입문", "6개월 미만", "입문", "0~1"),
    ("초급", "6개월~1년", "초급", "2~3"),
    ("초중급", "1~2년", "초중급", "4~5"),
    ("중급", "2~4년", "중급", "6~7"),
    ("고급", "4~6년", "고급", "8~9"),
    ("댄서", "6년 이상", "댄서", "10"),
], [1.2, 1.35, 1.2, 1.2], rowh=0.32, size=10)
text(s, 7.4, 5.72, 5.0, 0.8, "점수 레벨은 무료 수업이 아닌 유료 수업을 실제로 가르친 강사만 매깁니다. 쿠폰의 '비슷한 레벨' 판정과 개강 인원 선발에 씁니다. 두 레벨의 관계는 아직 정리 중입니다(Q7).", size=9.5, color=DIM, line_spacing=1.25)
notes(s, "근거: US2·US7, FR-090·FR-093, FR-104·FR-104a(출석·불참 표시), FR-065·FR-059·FR-060(휴강·보강·대타), FR-109(회차 옮기기), US4 시나리오 3(변경 알림), FR-029(경력 구간)·FR-160~FR-162(점수 레벨·부여 제한), Q7 ②는 미해결.")

# =========================================================== 12 강사 — 정산
s = add_slide()
header(s, "강사", "3 · 정산", "급여가 아니라, 진행한 수업에 대한 정산입니다", "강사는 프리랜서입니다. 수업 기간이 끝난 몫만 강사 전용 계좌로 나가고, 본인 정산만 볼 수 있습니다.")
flow(s, 0.7, 2.85, [
    ("결제 완료", "수강생이 결제 → 금액은 '보류'로 쌓입니다"),
    ("수업 시작", "'정산 완료 예정' — 금액은 보이되 아직 안 나감"),
    ("수업 기간 종료", "'정산 완료' — 강사 전용 계좌로 지급"),
    ("취소·환불이 생기면", "환불을 먼저 처리하고 그 결과를 정산에 반영"),
], w_each=2.75, h=1.2, gap=0.35, color=OK)
bullets(s, 0.7, 4.5, 6.2, 2.2, [
    ("내역이 근거와 함께 나옵니다 ", "— 수업 건수, 보류분, 예정분, 완료분, 조정분, 공제 항목, 실지급액"),
    ("개인 레슨은 따로 계산 ", "— 학원 수업분과 개인 레슨분을 구분해 담습니다"),
    ("학원을 옮겨도 ", "보류분은 실제로 가르친 강사에게 귀속됩니다"),
], size=11.5)
note_box(s, 7.2, 4.5, 5.4, 2.2, "아직 확정 전인 것",
         "프리랜서 사업소득 원천징수의 세율과 처리 주체는 세무 확인 대상입니다. 내역에 구분 표기하는 것까지만 정했습니다. 개인 레슨의 플랫폼 수수료율도 개인 레슨 상품을 열기 전에 정합니다.", size=10)
notes(s, "근거: US9, FR-127~FR-135e(강사 프리랜서 ~ 강사 정산 내역), FR-128(3단계)·FR-129(시각 전이)·FR-133(전용 계좌)·FR-135(조회 범위)·FR-135a(개인 레슨 별도), 엣지 케이스(강사 학원 이탈), 전제 5b·5c. 입점 약관 제9조 '급여가 아닙니다'.")

# =========================================================== 13 대표 — 입점
s = add_slide()
header(s, "대표", "1 · 입점", "서류 셋과 동의 넷이면 시작합니다", "회사는 통신판매중개자, 수업의 판매자는 학원입니다. 입점 약관은 변호사 검토 전 초안이라 공개 전에 바뀔 수 있습니다.")
flow(s, 0.7, 2.85, [
    ("① 사업자·등록 형태·증빙", "학원·교습소·신고 체육시설 가운데 고르고 증빙 업로드. 판정은 업종코드가 아니라 등록 형태"),
    ("② 정산 계좌", "PG 하위 판매자로 등록. 돈은 PG 가 이 계좌로 직접 보냅니다"),
    ("③ 항목별 동의", "수수료 5%(1년 면제) · 카드·PG 수수료 부담 · 1+1 참여 여부 · 콘텐츠 무상 이용"),
    ("④ 환불·취소 공지", "6항목 양식. 등록 안 하면 수업을 게시할 수 없습니다"),
], w_each=2.75, h=1.45, gap=0.35, color=ACCENT, size=10.5)
table(s, 0.7, 4.7, ["약관이 약속하는 것", "내용"], [
    ("약관 변경", "7일 전 공지. 학원에 불리하면(수수료 인상 포함) 30일 전 개별 통지. 동의하지 않으면 해지할 수 있습니다"),
    ("이용 제한", "의무 위반·문의 미응답 반복·앱 밖 거래 유도·허위 수업은 사유 통지 → 소명 → 조치 순서로"),
    ("해지", "해지돼도 이미 결제된 수업은 끝까지 제공하고 정산합니다"),
    ("정산 보류", "분쟁·환불 미처리분, 이상 거래, 서류 미확인, 기관 요청 때만. 사유와 금액을 알립니다"),
], [2.6, 9.3], rowh=0.4, size=10)
notes(s, "근거: FR-085(등록 형태·증빙), FR-250·FR-251(입점 심사·동의 기록), FR-125b(카드 수수료 고지·동의), FR-121c(1+1 참여), FR-246(규정 없는 학원 게시 차단), FR-252~FR-259(정산 보류·상계·이용 제한·해지·약관 변경), docs/legal/merchant-terms.md(초안, 변호사 검토 7건 남음).")

# =========================================================== 14 대표 — 등록·운영
s = add_slide()
header(s, "대표", "2 · 등록과 운영", "포스터 한 장이면 시간표가 올라갑니다")
flow(s, 0.7, 2.35, [
    ("포스터·전단지·캡처 업로드", "쓰던 이미지 그대로"),
    ("자동 추출", "장르·시간·가격·정원을 읽어 채웁니다"),
    ("검토 (건너뛸 수 없음)", "신뢰도가 낮은 항목은 '확인필요' 표시"),
    ("게시", "예약·결제가 바로 열립니다"),
], w_each=2.75, h=1.0, gap=0.35, color=ACCENT)
bullets(s, 0.7, 3.75, 6.1, 2.9, [
    ("파티·공연·대회도 같은 업로드 ", "— 전 학원 통합 피드에 노출"),
    ("공지는 직접 씁니다 ", "— 휴강·이벤트처럼 급한 건 텍스트로 바로. 사진은 선택"),
    ("강사 관리 ", "— 소속·위임 범위·소속 해제 처리. 강사가 수업을 올려도 규정은 대표 것"),
    ("강의실 ", "— 같은 강의실 같은 시각 두 수업은 등록 거부. 빈 시간대를 공개하면 강사가 개설 제안"),
], size=11.5)
box(s, 7.1, 3.75, 5.5, 2.9, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
text(s, 7.4, 3.95, 5.0, 0.35, "대표 대시보드에서 보는 것", size=13, bold=True, color=ACCENT)
bullets(s, 7.4, 4.4, 5.0, 2.2, [
    "오늘 수업 · 예약 · 출석 · 매출 · 취소",
    "회원 목록 · 수강·예약·출석 이력 · 관심 장르 · 후기 · 문의",
    "대학생 혜택 사용 현황 — 차액을 내는 쪽이 이상 징후를 봅니다",
    "운영 알림 — 신청 급증 · 정원 마감 · 취소 급증 · 강사 일정 변경 · 결제 실패 · 환불 요청",
], size=10.5)
notes(s, "근거: FR-073~FR-076(포스터 자동 등록), docs/policy/admin-input-policy.md(검토 필수), FR-078(공지), FR-081a·FR-082(강사 위임·해제), FR-072·FR-062, FR-079(회원 관리), FR-006d(대학생 혜택 현황), FR-080·FR-145(운영 알림). 자동 추출 정확도 목표는 미정(전제 14).")

# =========================================================== 15 대표 — 환불 처리
s = add_slide()
header(s, "대표", "3 · 환불 처리", "환불은 대표가 정하고 대표가 실행합니다", "회원이 누르면 자동으로 빠져나가는 돈은 없습니다. 예외는 하나 — 행사형 취소를 3영업일 안에 처리하지 않으면 시스템이 계산값대로 실행합니다.")
cards3 = [
    ("정규 · 개인 레슨", "문의로 요청이 오면 환불·취소 공지 규정대로 여부와 금액을 대표가 정합니다.\n\n중도 환불이면 진행 회차·남은 회차·회차당 금액을 계산 보조로 보여 줍니다. 금액은 대표가 정합니다.\n\n개인 레슨도 지정된 소속 학원 대표가 받습니다.", OK),
    ("이벤트 · 원데이 · 파티 · 공연 · 대회", "회원이 예약 상세에서 취소 신청 → 시스템이 공통 규정으로 금액과 근거(구간·수수료율)를 계산.\n\n대표는 확인해 실행합니다. 올려 주는 조정만 가능, 거절 불가.\n\n공지한 처리 기간(상한 3영업일) 안에 실행하지 않으면 자동 실행.", ACCENT),
    ("행사 전체 취소", "회차를 통째로 취소합니다. 결정은 대표만, 강사는 요청만.\n\n사유는 불가항력 / 대표 사정 중 고르고 한 줄 설명.\n\n확정하면 결제자 전원에게 PG 로 일괄 전액 환불, 예매 수수료도 돌려줍니다. 이미 지급받은 돈은 다음 정산에서 상계.", GOLD),
]
cx = 0.7
for title, body, col in cards3:
    box(s, cx, 2.85, 3.85, 3.75, fill=SURFACE, line_color=LINE, line_w=1, radius=0.06)
    box(s, cx, 2.85, 3.85, 0.09, fill=col)
    text(s, cx + 0.28, 3.1, 3.3, 0.4, title, size=13, bold=True, color=col)
    text(s, cx + 0.28, 3.6, 3.3, 2.9, body, size=10.5, color=DIM, line_spacing=1.3)
    cx += 4.05
notes(s, "근거: FR-098·FR-098b, FR-293(대표 환불 입력)·FR-294(중도 환불 보조)·FR-295(수단별 환불 실행, 기한 경과 자동), FR-099e(행사 일괄 취소), FR-282a 예외, FR-253(상계). 환불 실행은 항상 PG 취소 — 학원 계좌로 직접 송금 금지(정산이 어긋남).")

# =========================================================== 16 돈의 흐름
s = add_slide()
header(s, "돈", "1 · 흐름", "플랫폼은 돈을 쥐지 않습니다", "회원이 낸 돈은 PG 가 보관했다가 정해진 날 나눠 보냅니다. 학원은 PG 의 하위 판매자입니다.")
box(s, 0.9, 2.9, 2.3, 1.1, fill=BLUE_BG, radius=0.1); box(s, 0.9, 2.9, 0.08, 1.1, fill=BLUE)
text(s, 1.15, 2.9, 2.0, 1.1, ["회원", "수업료 (+ 행사면 예매 수수료 2,000원)"], size=11, bold=True, color=BLUE, anchor=MSO_ANCHOR.MIDDLE)
box(s, 3.3, 3.32, 0.75, 0.26, fill=FAINT, shape=MSO_SHAPE.RIGHT_ARROW)
box(s, 4.15, 2.75, 3.0, 1.4, fill=GOLD_BG, radius=0.1); box(s, 4.15, 2.75, 0.08, 1.4, fill=GOLD)
text(s, 4.4, 2.75, 2.7, 1.4, ["결제대행사(PG)", "돈을 보관. 플랫폼 지시대로 분배"], size=12, bold=True, color=GOLD, anchor=MSO_ANCHOR.MIDDLE)
# 분배 화살표 둘
box(s, 7.25, 2.95, 0.75, 0.26, fill=FAINT, shape=MSO_SHAPE.RIGHT_ARROW)
box(s, 7.25, 3.75, 0.75, 0.26, fill=FAINT, shape=MSO_SHAPE.RIGHT_ARROW)
box(s, 8.1, 2.55, 4.5, 1.0, fill=SURFACE2, radius=0.1)
text(s, 8.35, 2.62, 4.1, 0.3, "플랫폼 계좌", size=12, bold=True, color=DIM)
text(s, 8.35, 2.92, 4.1, 0.6, "판매 수수료 5% (입점 1년 면제) · 예매 수수료 2,000원 · 취소 수수료의 플랫폼 몫 50% · 멤버십 요금 전액", size=9.5, color=DIM, line_spacing=1.25)
box(s, 8.1, 3.65, 4.5, 1.0, fill=ACCENT_SOFT, radius=0.1)
text(s, 8.35, 3.72, 4.1, 0.3, "학원 계좌 (개인·동호회 주최자 포함)", size=12, bold=True, color=ACCENT)
text(s, 8.35, 4.02, 4.1, 0.6, "나머지 전부. 카드·PG 수수료는 여기서 실비 공제(수업료 몫만, 면제 기간에도)", size=9.5, color=DIM, line_spacing=1.25)
table(s, 0.9, 4.95, ["상품", "학원에 돈이 나가는 날", "그 뒤 환불이 생기면"], [
    ("이벤트·원데이·파티·공연·대회", "환불 마감일 다음 날 바로 (행사 전 경비를 쓸 수 있게)", "다음 정산에서 상계, 없으면 반환 청구"),
    ("정규 과정 · 개인 레슨", "수업 기간이 끝난 몫을 매월 5일", "다음 지급분에서 상계"),
], [3.6, 4.6, 3.5], rowh=0.42, size=10)
text(s, 0.9, 6.35, 11.7, 0.4, "신규 개인·동호회 주최자의 처음 2번 행사는 몫의 30%를 행사가 끝날 때까지 보관합니다(베타 임시값). 학원에는 적용하지 않습니다.", size=9.5, color=FAINT)
notes(s, "근거: FR-282d(정산 분배로 학원 직접 지급)·FR-282e(이벤트형 환불 마감 뒤 즉시 지급)·FR-125(매월 5일)·FR-124·FR-125a~e·FR-282a·FR-282b·FR-112b(멤버십은 플랫폼 상품)·FR-253(상계). 그림은 docs/assets/review/d02-money.mmd·d10-payout.mmd 와 같은 내용. 개인·동호회 정산 동일은 2026-09-30 확정(FR-155).")

# =========================================================== 17 부담 정리
s = add_slide()
header(s, "돈", "2 · 누가 얼마를", "\"할인·수수료, 누가 부담하나요?\"", "검색·추천·자동 등록·결제 인프라는 플랫폼이 제공합니다. 할인과 결제 비용은 판매자가, 멤버십은 플랫폼이 부담합니다.")
table(s, 0.7, 2.85, ["항목", "부담", "정산에서 이렇게 보입니다"], [
    ("판매 수수료 5%", "학원 · 입점일부터 1년 면제", "실제 제공된 판매에만. 취소된 건은 환급. 면제 종료일을 정산 화면에 표시"),
    ("대학생 첫 결제 50%", "학원", "할인된 결제액 기준으로 정산"),
    ("1+1 할인권 추가 수업", "정산에 넣지 않음", "결제 0원이라 금액 없이 '1+1 쿠폰 사용'만 표시. 참여는 선택. 참여하면 실시간 검색 순위판에 오르고, 끊으면 바로 빠집니다"),
    ("카드·PG 결제 수수료", "학원 (수업료 몫만)", "플랫폼 수수료와 따로 실비 공제. 면제 기간에도. 예매 수수료 몫의 수수료는 플랫폼"),
    ("환불 때 못 돌려받은 PG 수수료", "학원 (수업 결제분)", "정산에서 '환불 PG 수수료' 한 줄로. 멤버십 환불분은 플랫폼"),
    ("취소 수수료 (행사형)", "회원이 냄 → 학원 5 : 플랫폼 5", "정규 과정에는 없음. 1년 면제 기간에도 배분"),
    ("예매 수수료 2,000원", "회원 → 플랫폼", "학원 정산과 무관. 취소해도 비환불(휴강·폐강·행사 취소·청약철회 예외)"),
    ("멤버십 요금 · 연 멤버십 10% 할인 · 멤버십 환불", "플랫폼", "학원 정산 대상이 아님"),
], [3.3, 2.9, 5.7], rowh=0.42, size=10)
notes(s, "근거: FR-124, FR-119(쿠폰·할인 차액 대표 부담), FR-121c·FR-121d, FR-125a·FR-125c·FR-125d·FR-125e, FR-282a·FR-282b, FR-112b, docs/policy/pricing-policy.md.")

# =========================================================== 18 파티·공연·대회
s = add_slide()
header(s, "공통", "파티 · 공연 · 대회", "수업이 파티로, 파티가 대회로 이어집니다", "전 학원 통합 피드에 올라갑니다. 다른 학원 회원에게도 보입니다.")
bullets(s, 0.7, 2.75, 6.1, 3.9, [
    ("주최자 표시 ", "— 학원인지 개인·동호회인지 상세 화면에 표시"),
    ("학원은 입점만으로 ", "파티·공연·대회를 올립니다"),
    ("개인·동호회는 플랫폼 승인 뒤 ", "— 주최자 신청과 정산 계좌 등록, 승인 전에는 결제를 열 수 없습니다"),
    ("정산·수수료는 학원과 동일 ", "— PG 하위 판매자, 5%(승인일부터 1년 면제), 환불 마감일 다음 날 지급. 플랫폼이 대신 내주는 돈은 없습니다"),
    ("크루·동호회 단체 신청 ", "— 묶어서 신청할 수 있습니다"),
    ("외부 예매 링크 ", "— 앱 밖에서 파는 행사는 링크로 연결"),
], size=11.5)
box(s, 7.1, 2.75, 5.5, 3.9, fill=SURFACE, line_color=LINE, line_w=1, radius=0.08)
text(s, 7.4, 2.95, 5.0, 0.35, "행사형 상품에 공통으로 붙는 것", size=13, bold=True, color=ACCENT)
bullets(s, 7.4, 3.45, 5.0, 3.1, [
    ("환불 마감일 필수 ", "— 개최일 전 날짜. 결제 화면에 표시. 마감 뒤 결제하는 회원은 '환불 불가' 동의"),
    ("예매 수수료 2,000원 ", "— 결제 화면에 수업료와 따로"),
    ("취소 수수료 표 ", "— 인터파크와 같은 구조. 대표는 낮출 수만 있습니다"),
    ("정원이 차면 결제 불가 ", "— 대기 신청만. 취소표가 나면 대기자에게 알림"),
    ("대회 참가 양식 ", "— 파트너·부문 같은 항목을 신청 때 받습니다"),
], size=10.5)
notes(s, "근거: US8, FR-150~FR-157(피드·주최자·참가 양식·출연자), FR-155(Q9 2026-09-29 확정, 정산 동일 2026-09-30 확정), FR-178(단체 신청), FR-099c·FR-099d·FR-282a·FR-282e. 승인 심사 기준·제출 서류는 미정.")

# =========================================================== 19 1+1 참여 학원
s = add_slide()
header(s, "대표", "4 · 노출", "1+1 에 참여하면 메인 전광판에 오릅니다", "참여 학원의 수업만 '수업명(학원명)' 형식으로 최근 24시간 검색 조회수 순서로 흘러갑니다. 핵심 기능입니다.")
box(s, 0.7, 2.85, 11.9, 0.7, fill=INK, radius=0.08)
text(s, 0.95, 2.85, 11.4, 0.7, "▶  1위 살사 초급 화요반(라 클라베)   2위 왈츠 입문(강남댄스스포츠)   3위 린디합 베이직(스윙타임)   4위 탱고 밀롱가 준비반(부에노스)   …",
     size=12, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)
text(s, 0.7, 3.6, 11.9, 0.3, "예시 화면 — 학원명·수업명은 가상입니다", size=9, color=FAINT)
bullets(s, 0.7, 4.1, 6.1, 2.5, [
    ("장르별 순위 ", "— 회원이 고른 장르의 순위만. 여러 장르를 가르치면 장르마다 오를 수 있습니다"),
    ("누르면 맨 위 카드 ", "— 추천 화면에 '방금 보신 수업'으로. 마감이면 대기 버튼"),
    ("새로 참여한 학원은 NEW 영역 ", "— 학원명만 보이는 자리"),
    ("참여를 끊으면 즉시 제외 ", "— 다시 참여하면 순위판에는 돌아오지만 NEW 는 없습니다"),
], size=11.5)
note_box(s, 7.1, 4.1, 5.5, 2.5, "참여 조건과 검토 중인 것",
         "참여하면 1+1 할인권으로 신청된 추가 수업 자리를 1달 무료로 내줍니다. 정산에는 금액 없이 '1+1 쿠폰 사용' 여부만 표시됩니다.\n\n비용을 조건으로 노출되는 순위라 순위 기준 공개·광고 표시 의무가 걸리는지 법률 검토 중입니다. 화면 기준 문구는 '검색 조회수 기준'입니다.", size=10)
notes(s, "근거: FR-121c~FR-121g(참여 학원·순위판·NEW 영역·조회수·모집 수업 추천), FR-036a(인기 7일과 별개로 순위판은 24시간). ⚠ 전자상거래법·표시광고법 검토 대상.")

# =========================================================== 20 일정
s = add_slide()
header(s, "공통", "언제, 어디서", "베타는 작게 시작합니다", "Android 갤럭시 스토어 단일 배포. 베타 1~10명, 개발 노트북 한 대로 첫 거래 한 바퀴를 돌리는 것이 첫 목표입니다.")
flow(s, 0.7, 2.95, [
    ("S0 · 베타", "회원 1~10명 · 노트북 1대 · 첫 거래(결제→수업→정산) 한 바퀴 · AI 동시 10명 실측 완료"),
    ("S1 · 파일럿", "AI 검색·추천 실사용자 개방 — 인원이 아니라 게시된 수업 데이터 기준으로"),
    ("S2 · S3", "3년 이후 1천~1만 명. 서버·클라우드 이전은 그때 판단"),
], w_each=3.7, h=1.4, gap=0.4, color=DIM, size=11)
bullets(s, 0.7, 4.75, 6.1, 1.9, [
    ("지금 입점하면 ", "입점일부터 1년 동안 판매 수수료가 없습니다"),
    ("소셜 로그인 ", "— 카카오·구글·네이버. 만 14세 미만은 보호자 계정의 자녀로"),
    ("가입 정보 ", "— 나이·성별·연락처는 필수. 성별은 남·여 정원 자리의 기본값이 됩니다"),
], size=11.5)
note_box(s, 7.1, 4.75, 5.5, 1.9, "구현 현황 (2026-09-30 실측)",
         "취소·환불 계산과 실행 경로만 완성돼 있고, 회원 가입·결제 생성·PG 실연동·출석은 아직 없습니다. 백엔드를 Next.js 로 옮기는 작업(SCH-21)이 다음 순서입니다.", size=10, color=DIM, fill=SURFACE2)
notes(s, "근거: docs/policy/distribution-policy.md, spec 규모 단계 S0~S3(2026-09-24 재구성, 10만 명 폐기), SC-040~SC-048, FR-001(소셜 로그인), FR-009a(자녀 등록), FR-002(Q4 확정), spec '현재 구현 상태' 표, _workspace/SCH_kdance.html.")

# =========================================================== 21 아직 정해지지 않은 것
s = add_slide()
header(s, "공통", "솔직하게", "아직 정해지지 않은 것", "설명회에서 질문이 나오면 '검토 중'이라고 답할 항목입니다. 정해지는 대로 약관과 안내에 반영합니다.")
table(s, 0.7, 2.85, ["항목", "지금 상태", "언제까지"], [
    ("약관 3종 법률 검토", "변호사 검토 전 초안. 검토 지점 7건 + 사업자 정보 빈칸", "스토어 제출 전"),
    ("행사형 환불 마감 뒤 환불 불가", "공정위 공연업 기준·청약철회 7일과 달라 검토 대상", "스토어 제출 전"),
    ("개인 레슨의 플랫폼 수수료율", "학원 5% 를 그대로 쓸 근거가 없어 미정", "개인 레슨 상품 열기 전"),
    ("강사 원천징수 세율·처리 주체", "세무 확인 대상. 내역 구분 표기까지만 확정", "첫 정산 지급 전"),
    ("개인·동호회 주최자 승인 기준·제출 서류", "정산은 학원과 동일로 확정. 심사 기준만 남음", "파티 기능 착수 시"),
    ("경력 레벨과 점수 레벨의 관계", "Q7 ② 미해결", "레벨 기능 착수 시"),
    ("대표 미응답·폐업 때 환불 경로", "Q11 ④ 미해결 — 운영자 개입이 없어 경로가 비어 있음", "약관 검토와 함께"),
], [3.9, 5.6, 2.4], rowh=0.44, size=10)
notes(s, "근거: spec 「아직 정해지지 않은 것」 표, Q7·Q11 행, 전제 5b·5c·5e, docs/legal/merchant-terms.md 검토 지점 7건, FR-155 ⚠. 2026-09-30 기준.")

# =========================================================== 22 마무리
s = add_slide(bg=INK)
text(s, 0.7, 0.4, 5, 0.3, f"{TOTAL} / {TOTAL}", size=10, color=RGBColor(150, 140, 160))
text(s, 0.7, 1.6, 11.9, 0.8, "입점 절차, 세 단계", size=30, bold=True, color=WHITE)
steps = [("1", "사업자·등록 형태 증빙과 정산 계좌", "판정은 등록 형태와 증빙으로. PG 하위 판매자로 등록됩니다"),
         ("2", "항목별 동의와 환불·취소 공지", "수수료·비용 부담·1+1 참여·콘텐츠 이용에 각각 동의. 공지 6항목을 채웁니다"),
         ("3", "포스터 한 장 업로드", "자동 추출 → 검토 → 게시. 첫 1년은 판매 수수료가 없습니다")]
cx = 0.7
for n, t_, b in steps:
    box(s, cx, 2.7, 3.85, 2.3, fill=RGBColor(0x2B, 0x22, 0x36), radius=0.06)
    text(s, cx + 0.3, 2.85, 1, 0.6, n, size=26, bold=True, color=GOLD)
    text(s, cx + 0.3, 3.5, 3.3, 0.4, t_, size=13, bold=True, color=WHITE)
    text(s, cx + 0.3, 3.95, 3.3, 0.9, b, size=10.5, color=RGBColor(200, 190, 210), line_spacing=1.3)
    cx += 4.05
text(s, 0.7, 5.5, 11.9, 0.6, "감사합니다.", size=28, bold=True, color=WHITE)
text(s, 0.7, 6.2, 11.9, 0.6, f"K-DanceX4 소셜댄스 입점 설명회 · {BASIS} 기준 최종 예상 시나리오 · 요구사항 원본은 specs/001-ai-dance-class-platform/spec.md",
     size=10.5, color=RGBColor(150, 140, 160))
notes(s, "입점 절차 근거: FR-085·FR-250·FR-251·FR-099a·FR-246·FR-073~FR-076·FR-124.")

OUT = str(Path(__file__).resolve().parents[1] / "docs" / "deck" / "K-DanceX4_입점설명회_대표강사회원.pptx")
prs.save(OUT)
print("saved", OUT, "slides", len(prs.slides))
