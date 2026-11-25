#!/usr/bin/env python3
"""제출용 기능 명세서(임채웅_기능명세서) HTML·PDF 를 만든다.

흐름: ① 이 스크립트가 본문 HTML 초안을 쓴다(Mermaid 원문 포함)
      ② 설치된 Playwright(admin-web/node_modules) + Chrome for Testing 으로 열어
         Mermaid 를 SVG 로 굽고, 장(chapter)마다 쪽 수를 세어 목차에 쪽 번호를 넣는다
      ③ 다 구운 HTML 을 저장하고 A4 PDF 로 찍는다.
새 도구는 설치하지 않는다. 다시 돌리면 같은 파일을 덮어쓴다.

실행: python3 scripts/build_submission_spec.py  (저장소 루트에서)
"""
from __future__ import annotations

import html
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs" / "submission"
OUT_HTML = OUT_DIR / "임채웅_기능명세서.html"
OUT_PDF = OUT_DIR / "임채웅_기능명세서.pdf"
PLAYWRIGHT = ROOT / "admin-web" / "node_modules" / "playwright"
CHROME = Path.home() / ".cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
# 이 PC 의 npx 캐시에 이미 있는 mermaid(12.1.0, @mermaid-js/mermaid-cli 의존). 새로 받지 않는다
MERMAID = Path.home() / ".npm/_npx/668c188756b835f3/node_modules/mermaid/dist/mermaid.min.js"
EV = "../../_workspace/evidence"  # HTML 기준 상대 경로(그림)


def esc(s: str) -> str:
    return html.escape(s, quote=False)


def table(headers, rows, cls="", widths=None) -> str:
    """표 하나. 칸 값은 이미 HTML 로 쓴 문자열이라 이스케이프하지 않는다."""
    cols = ""
    if widths:
        cols = "<colgroup>" + "".join(f'<col style="width:{w}">' for w in widths) + "</colgroup>"
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}">{cols}<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def mermaid(src: str, caption: str) -> str:
    return f'<figure class="diagram"><pre class="mermaid">{esc(src.strip())}</pre><figcaption>{caption}</figcaption></figure>'


def phones(items) -> str:
    """에뮬레이터 화면(1080×2400)을 한 줄에 여러 장."""
    cells = "".join(
        f'<figure class="phone"><img src="{EV}/{p}" alt="{esc(c)}"><figcaption>{c}</figcaption></figure>'
        for p, c in items
    )
    return f'<div class="phones">{cells}</div>'


def code(s: str) -> str:
    return f"<pre class=\"code\">{esc(s.strip())}</pre>"


def st(s: str) -> str:
    """구현 상태 표시 배지."""
    label, _, detail = s.partition("(")
    label = label.strip()
    cls = {"완료": "ok", "통과": "ok", "부분": "part", "PG 도입 후": "pg", "미구현": "no"}.get(label, "part")
    # 괄호 안 설명은 배지 밖 작은 글자로 내려 좁은 칸에서도 넘치지 않게 한다
    extra = f"<br><small>{detail.rstrip(')')}</small>" if detail else ""
    return f'<span class="badge {cls}">{label}</span>{extra}'


# ───────────────────────────── 본문 ─────────────────────────────

CHAPTERS: list[tuple[str, str, str]] = []  # (id, 제목, 본문 HTML)


def chapter(cid: str, title: str, body: str) -> None:
    CHAPTERS.append((cid, title, body))


# 1. 기능 개요 ----------------------------------------------------
chapter("c1", "1. 기능 개요", f"""
<p>K-DanceX4 는 소셜 댄스 학원 수업을 찾고, 결제하고, 수강 이력과 레벨을 쌓는 Android 앱과 관리자 웹이다.
회원은 취향·일정·레벨에 맞는 수업을 고르고, 강사는 수업과 수강생을 관리하며, 대표는 학원·강사·수업 승인을 한곳에서 처리한다.
AI 는 수업 검색(AI 플래너), 포스터 읽기, 홍보 이미지·소개 문구 초안을 맡는다.</p>

<h3>1-1. 구성 요소</h3>
{table(["구성", "누가 쓰나", "무엇을 하나", "기술"], [
 ["회원 앱", "회원", "가입·장르 선택·수업 탐색·결제 대기·AI 플래너·캘린더·레벨 카드", "Expo SDK 58 · React Native 0.88.1 · TypeScript"],
 ["강사·대표 앱", "강사·대표", "오늘 수업·명단·결석·레벨 정하기·수업 등록·홍보 이미지 / 수업 승인·예약 명단·알림. <b>회원 앱과 같은 코드의 한 앱</b>이고 로그인한 역할로 화면이 갈린다", "같음"],
 ["관리자 웹", "대표·위임 받은 강사·운영자", "입점·강사 소속·공지·앱 페이지·예약 명단(대표), 입점 심사·신고·사업자 점검(운영자). 2단계 인증 필수", "Next.js 16.3 App Router · React 19.3"],
 ["제품 API", "앱·웹", "모든 업무 규칙과 DB 쓰기를 맡는 유일한 서버(<code>/api/**</code>)", "Next.js Route Handler · Prisma 8 · Better Auth 1.7.5"],
 ["AI 에이전트 서버", "제품 API 만 부른다", "질문 해석·검색 도구 호출·답 작성, 포스터 읽기, 홍보 이미지 생성. DB 에 직접 접속하지 않는다", "Python 3.12 · FastAPI · LangGraph"],
], widths=["15%", "17%", "44%", "24%"])}

<h3>1-2. 역할 4종과 장르 4종</h3>
{table(["역할", "한 줄 정의", "들어오는 곳"], [
 ["회원(Dancer)", "수업을 찾아 결제하고 수강하는 사람. 강사·대표·다른 회원에게는 닉네임으로만 보인다(FR-019a(회원 닉네임 표시))", "회원 앱 — 이메일 로그인(베타)"],
 ["강사(Instructor)", "프리랜서. 여러 학원에 소속해 수업을 연다. 아이디·비밀번호로 자유 가입(FR-011(대표 입점 승인·강사 자유 가입))", "강사·대표 앱 / 위임 받으면 관리자 웹"],
 ["대표(Owner)", "학원 운영자. 운영자의 입점 승인 뒤 활성화된다", "강사·대표 앱 · 관리자 웹"],
 ["운영자(Admin)", "앱·웹 시스템 관리자. 학원의 결제·환불 분쟁은 다루지 않는다(FR-204(운영자 범위))", "관리자 웹"],
], widths=["17%", "58%", "25%"])}
{table(["장르(FR-020(장르 4종 고정))", "세부 장르(FR-021(세부 장르 관리))"], [
 ["댄스스포츠", "라틴(차차차·쌈바·룸바·파소도블레·자이브) · 스탠다드(왈츠·탱고·비엔나왈츠·슬로우폭스트롯·퀵스텝)"],
 ["아르헨티나 탱고", "세부 장르 없음"],
 ["스윙댄스", "세부 장르 없음"],
 ["살사/바차타", "살사 · 바차타"],
], widths=["30%", "70%"])}

<h3>1-3. 핵심 기능 지도</h3>
{mermaid('''
flowchart TB
  subgraph SM[회원 앱]
    direction TB
    M1[가입·본인확인] --> M2[기준 장르·관심 장르] --> M3[홈 수업 목록·상세] --> M4[결제 대기·캘린더]
    M5[AI 플래너 말로 찾기]
    M6[레벨 카드·레벨업 연출]
  end
  subgraph SI[강사 앱]
    direction TB
    I1[오늘 수업·명단·결석] --> I2[레벨 정하기]
    I3[수업 등록·포스터 읽기] --> I4[홍보 이미지·소개 문구 AI]
  end
  subgraph SO[대표 앱·관리자 웹]
    direction TB
    O1[입점 신청] --> O2[강사 소속 승인·위임]
    O3[수업 승인] --> O4[예약 명단·공지·앱 페이지]
  end
  subgraph SA[운영자 · 관리자 웹]
    direction TB
    A1[입점 심사] --> A2[신고·이용 제한·사업자 점검]
  end
  I4 -. 승인 요청 .-> O3
  O3 -. 공개 .-> M3
  I2 -. 승급 안내 .-> M6
  O1 -. 심사 .-> A1
''', "그림 1. 역할별 핵심 기능과 역할 사이의 연결(점선)")}
""")

# 2. 목적 -----------------------------------------------------------
chapter("c2", "2. 목적", f"""
<p>이 서비스는 <b>양면 시장(two-sided market)</b>이다. 수업을 찾는 회원과 수업을 여는 강사·대표 가운데 한쪽만 있으면 거래가 한 건도 생기지 않는다.
그래서 「회원이 수업을 찾아 결제한다」(US1)와 「강사가 수업을 열고 자리를 관리한다」(US2)를 둘 다 최우선(P1)에 두었다.</p>

<h3>2-1. 풀려는 문제</h3>
{table(["누구", "지금의 불편", "제품의 답"], [
 ["대표", "블로그·SNS 로는 취향이 맞는 수강생을 걸러 찾기 어렵다. 예약 확인·알림·결제 정리를 손으로 한다. 수업 등록이 번거롭다", "장르·지역·시간 검색, 결제 즉시 캘린더 등록과 알림, 포스터 한 장으로 수업 초안 만들기(FR-073(포스터 자동 추출)) + 검토 필수(FR-074(추출 검토 필수))"],
 ["강사", "여러 학원을 다녀 일정이 흩어지고, 수강생 레벨·이력이 쌓이지 않는다", "학원이 달라도 겹치는 수업 저장 거부(FR-054(강사 일정 충돌 거부)), 세부 장르별 레벨과 개강 후보(FR-164(개강 후보 추천))"],
 ["회원", "여러 학원 수업을 한곳에서 보기 어렵고, 남·여 짝 수업이라 정원이 성별로 갈리며, 학원마다 환불 규정이 다르다", "한 화면 검색, 「남 ○석·여 ○석」 표시(FR-092(성별 정원)), 결제 전 학원 환불 공지 표시(FR-282(결제 화면 필수 표시))"],
], widths=["10%", "45%", "45%"])}

<h3>2-2. 대상 사용자와 규모</h3>
{table(["단계", "규모", "통과 조건(요약)"], [
 ["S0 내부", "노트북 1대 · 시험자 1명 · AI 동시 사용자 10명", "결제·수강 완료·정산·취소·환불 각 1건이 정합성 지표 위반 없이 끝난다"],
 ["S1 베타", "실사용자 1~10명 · 학원 1~3곳 · 동시 접속 100명까지 버팀", "학원이 스스로 수업을 게시하고, 포스터 자동 등록이 성공한다"],
 ["S2~S3 운영", "3년 뒤 1천~1만 명", "부하 시험(SC-016(동시 신청)·SC-017(1만 규모)) 통과, 가용성 99.5%"],
 ["S4 설계 상한", "10만 명", "구조를 다시 짜지 않고 서버·DB 증설만으로 버틴다(SC-017a(10만 설계 상한))"],
], widths=["14%", "38%", "48%"])}

<h3>2-3. 기대 효과 — 측정 가능한 성공 기준(spec 확정값)</h3>
{table(["성공 기준", "목표"], [
 ["SC-001(첫 결제 5분)", "앱 설치부터 첫 수업 결제까지 5분 안"],
 ["SC-002(수업 등록 3분)", "강사가 수업 하나를 등록해 공개 요청까지 3분 안"],
 ["SC-003(포스터 게시 2분)", "포스터 1장 → 게시 2분 안, 손으로 고치는 항목 평균 2개 이하"],
 ["SC-005(정원 초과 0건)", "동시 신청 부하에서도 정원을 넘는 예약 확정 0건"],
 ["SC-006·SC-007(금액 불일치·중복 환불 0건)", "결제 요청 금액과 기록 금액 불일치 0건, 같은 취소 요청의 중복 환불 0건"],
 ["SC-008·SC-009(강의실·강사 겹침 0건)", "같은 강의실·같은 강사가 같은 시각 두 수업에 잡힌 사례 0건"],
 ["SC-011(없는 수업 추천 0건)", "AI 추천에 실제로 없는 수업·강사가 섞인 사례 0건"],
 ["SC-015(검색 1초)", "검색의 95%가 1초 안에 결과를 보인다"],
 ["SC-023·SC-024(보안 치명 0건·소스 자격 증명 0건)", "출시 시점 치명 등급 발견 0건, 소스 안 비밀값 0건"],
], widths=["40%", "60%"])}
""")

# 3. 기능 요구사항 --------------------------------------------------
def frs(rows):
    return table(["FR(기능명)", "요구 내용", "화면·경로", "구현 상태"], rows, cls="fr", widths=["22%", "43%", "21%", "14%"])


chapter("c3", "3. 기능 요구사항", f"""
<p>요구사항 원본은 <code>specs/001-ai-dance-class-platform/spec.md</code>(FR 약 345개)다. 아래는 2026-11-25 시연 범위를 중심으로 역할별 핵심 FR 을 추린 표다.
「구현 상태」는 로드맵(<code>_workspace/roadmap-tasks.json</code>, Task 512개 중 완료 320 · 할 일 175 · 막힘 17 — 2026-11-24 갱신분)과 오늘 작업 증거를 근거로 적었다.</p>
{table(["표시", "뜻"], [
 [st("완료"), "코드·테스트·화면 증거가 있다"],
 [st("부분"), "흐름은 돌지만 가짜 어댑터(가짜 본인확인·가짜 PG)로만 검증했거나 일부 기능이 빠졌다"],
 [st("PG 도입 후"), "실제 결제대행(PG) 계약이 있어야 끝낼 수 있다. 지금은 PG 미연동이다"],
 [st("미구현"), "아직 만들지 않았다"],
], widths=["20%", "80%"])}

<h3>3-1. 공통 — 가입·로그인·인증</h3>
{frs([
 ["FR-001(소셜 로그인 3사)", "카카오·구글·네이버 로그인", "—", st("미구현") + "<br><small>사업자 등록 뒤 앱 등록</small>"],
 ["(베타 대체) 회원 이메일 로그인", "이메일·비밀번호로 로그인. 로그인 화면에는 강사·대표 표시를 두지 않는다", "<code>/login</code> · <code>POST /api/auth/sign-in/email</code>", st("완료")],
 ["FR-002·FR-003(가입 정보·본인확인 계정)", "이름·성별·생년·연락처는 본인확인 결과에서만 받고, 같은 CI 의 두 번째 계정은 막는다", "<code>POST /api/members</code>", st("부분(가짜 본인확인)")],
 ["FR-011a(역할별 화면·강사·대표 입구)", "앱이 하나인 동안(베타·시연) 회원 로그인 바탕을 0.6초 안에 세 번 누르면 강사·대표 로그인이 열린다. 역할 탭(Instructor/Owner)마다 다른 그림", "<code>/staff-login</code>", st("완료")],
 ["FR-011(강사 자유 가입)", "강사는 아이디·비밀번호로 가입하고 활동 장르를 고른다(FR-011b(강사 활동 장르))", "<code>POST /api/instructor/signup</code>", st("완료")],
 ["FR-303(관리자 웹 2단계 인증)", "관리자 웹은 비밀번호 + 인증 앱 6자리(TOTP). 강사·대표 앱은 2단계를 묻지 않고 앱 전용 경로로 로그인하며, 그 세션으로는 관리자 웹 콘솔과 계정 관리 경로를 쓸 수 없다(ADR-007)", "<code>/api/auth/two-factor/*</code> · <code>POST /api/auth/sign-in/staff-app</code>", st("완료")],
 ["FR-300(로그인 하나·콘솔 하나)", "관리자 웹은 로그인 화면 하나, 콘솔 하나. 역할·위임 권한에 따라 메뉴만 다르고, 주소로 직접 들어와도 서버가 막는다", "<code>GET /api/staff/me</code>", st("완료")],
])}

<h3>3-2. 회원</h3>
{frs([
 ["FR-022a(첫 화면 장르 선택·유지)", "가입 뒤 처음 들어오면 기준 장르 1개를 먼저 받는다. 사진 카드 2×2 가 3초마다 세부 장르 사진으로 바뀌고, 누른 순간 보이던 세부 장르로 골라진다. 칩(전체·라틴·스탠다드 등)으로 고칠 수 있고 더블 탭은 바로 저장. 홈 「장르 바꾸기」로 다시 연다", "<code>/base-genre</code> · <code>PUT /api/me/base-genre</code>", st("완료") + "<br><small>2026-11-25</small>"],
 ["FR-022(사용자 프로필)", "관심 장르(여러 개)·지역·가능 시간대·경험 수준 저장. 관심 장르는 작은 사진 카드로 여러 개 고른다", "<code>/preferences</code> · <code>PUT /api/me/profile</code>", st("완료")],
 ["FR-030·FR-033(수업 검색·시간대 필터)", "홈 목록은 기준 장르·세부 장르·관심 지역·가능 시간대로 거른다. 기준 장르가 없으면 목록을 주지 않는다", "<code>GET /api/home/offerings</code>", st("완료")],
 ["FR-036a(검색 결과 정렬)", "정렬 5종 중 추천순·마감 임박·잔여석 임박 3종", "같은 경로 <code>?sort=</code>", st("부분")],
 ["FR-090·FR-091(정원 표시·초과 방지)", "정원 대비 신청 인원, 남·여 자리별 잔여석. 동시 신청에도 정원을 넘지 않는다", "<code>GET /api/offerings/{id}</code>", st("완료")],
 ["FR-285(결제 시작·자리 잡기)", "결제를 시작하면 자리를 대기(held)로 잡고 수단별 기한을 정한다. 기한이 지나면 자리를 푼다", "<code>/pay/[offeringId]</code> · <code>POST /api/orders</code>", st("부분(가짜 PG)")],
 ["FR-287(웹훅 확정)", "PG 결과 통지(웹훅, webhook)로만 결제를 확정하고 서명·금액을 대조한다", "<code>POST /api/payments/webhook</code>", st("PG 도입 후") + "<br><small>가짜 PG 로 검증</small>"],
 ["FR-037·FR-037a(자연어 검색·강사 이름으로 찾기)", "AI 플래너에 말로 물으면 조건을 뽑아 실제 게시 수업을 찾고, 말풍선 답 + 수업 카드로 돌려준다. 이어 묻기로 좁힌다", "<code>/planner</code> · <code>POST /api/ai/chat</code>", st("완료")],
 ["FR-039·FR-041(없는 항목 금지·시간 초과 대체)", "검색 결과 밖의 수업을 말하지 않는다. AI 가 늦으면 일반 검색 결과로 바꿔 준다", "에이전트 답 검사 · 대체 규칙", st("완료")],
 ["S3-4(내 캘린더·결석 예정)", "확정된 수업이 캘린더에 오르고, 못 가는 회차만 「결석 예정」으로 알린다(FR-092e(결석 예정 미리 알리기))", "캘린더 탭 · <code>GET /api/me/calendar</code>", st("완료")],
 ["FR-169c·e·f(레벨 캐릭터·레벨업 연출·카드 모음)", "세부 장르마다 레벨 카드. 레벨이 오르면 알림 → 카드 뒤집기 연출 → 카드 모음에 쌓인다. 표기는 <code>Lv.N (단계)</code>", "<code>/my/level-cards</code> · <code>/api/me/level-cards</code>", st("완료")],
 ["FR-176·FR-203(문의·대표 선택 문의)", "회원이 학원·수업을 골라 문의하고 대표가 답한다", "<code>/api/inquiries</code>", st("완료")],
 ["FR-140(수업 전 알림 시점)", "하루 전·2시간 전·1시간 전·30분 전 중 고른다. 실기기 푸시 수신 확인은 남았다", "<code>/my/notification-settings</code>", st("부분")],
 ["FR-093(대기 신청)", "정원이 찬 수업의 대기 순번", "—", st("미구현")],
 ["FR-098(대표 처리 환불)", "회원이 환불을 요청하고 학원이 자기 규정대로 처리", "<code>POST /api/refund-requests</code>", st("PG 도입 후") + "<br><small>요청·결정 경로만</small>"],
 ["FR-112(멤버십 결제)", "3개월·연 멤버십 정기결제", "—", st("PG 도입 후")],
 ["학원 탭", "학원 둘러보기 화면", "—", st("미구현") + "<br><small>「준비 중」</small>"],
])}

<h3>3-3. 강사</h3>
{frs([
 ["FR-058(강사 일정 대시보드)", "오늘 수업·이번 주 일정. 학원별 색으로 구분", "강사 앱 홈 · <code>GET /api/instructor/schedule</code>", st("완료")],
 ["S3-5(회차 명단·회원 관리)", "결제 완료 수강생 명단, 연락처는 가려 보이고 전체 열람은 사유와 함께 기록(FR-187(연락처 가림·열람 기록))", "<code>GET /api/classes/{id}/sessions/{sid}/roster</code>", st("완료")],
 ["FR-092e(결석 예정 미리 알리기)", "출석 체크(QR·호명)는 없다. 결제한 수강생은 참석으로 보고, 강사는 결석 표시와 이의 처리를 본다", "<code>/api/classes/{id}/sessions/{sid}/absences</code>", st("완료")],
 ["FR-169d(강사 레벨 등급 조절)", "멤버십 강사가 결제 완료 수강생의 세부 장르 레벨을 정한다. 회원보다 높으면 승급 안내가 가고, 회원이 받아야 레벨이 오른다. 평가 레벨은 회원에게 보이지 않는다", "<code>POST /api/instructor/level-evaluations</code>", st("완료") + "<br><small>강사 멤버십 판정은 가짜 포트</small>"],
 ["FR-050·FR-050a(수업 등록·대표 승인 뒤 공개)", "장르·세부 장르·레벨·구분·일시·장소·정원·수강료로 수업을 만들고 승인 요청. 대표가 승인해야 회원에게 보인다", "<code>POST /api/classes</code> · <code>…/submit</code>", st("완료")],
 ["FR-054·FR-072(강사·강의실 겹침 거부)", "학원이 달라도 같은 강사 같은 시각, 같은 강의실 같은 시각이면 저장을 거부", "<code>POST /api/classes/schedule-check</code>", st("완료")],
 ["FR-073~FR-075(포스터 읽기)", "포스터 사진에서 장르·요일·시간·가격·정원·기간을 뽑고, 믿기 어려운 칸에 「확인필요」. 검토 없이는 게시할 수 없다", "<code>/api/academies/{id}/poster-extractions</code>", st("완료")],
 ["FR-061a(홍보 이미지 생성)", "칩·문장으로 글자 없는 홍보 배경을 만든다. 엔진은 사용자가 고르고(기본 Cloudflare FLUX.1 [schnell]), 하루 3번, 실패하면 횟수를 돌려준다. AI 생성 표시를 붙인다(FR-258(AI 생성 표시))", "<code>/instructor/classes/promo</code> · <code>POST /api/ai/promo-images</code>", st("완료")],
 ["FR-061(소개 문구 초안)", "수업 정보로 소개 문구 초안. 숫자(시간·가격·회차)는 모델이 쓰지 않고 수업 데이터로 채운다", "<code>POST /api/ai/class-intro-drafts</code>", st("완료")],
 ["FR-060·FR-052c(대타·개인 레슨)", "대타 요청·수락, 1:1 개인 레슨 상품·시간 열기", "<code>/api/instructor/substitute-requests</code> 등", st("완료")],
 ["FR-164(개강 후보 추천)", "개강 조건에 맞는 수강생 후보와 근거, 동의한 사람만 연락처", "<code>GET /api/instructor/new-class-candidates</code>", st("완료")],
 ["FR-128·FR-135(정산 3단계·본인 정산 조회)", "보류 → 정산 완료 예정 → 정산 완료, 강사 본인 몫만", "—", st("PG 도입 후")],
])}

<h3>3-4. 대표</h3>
{frs([
 ["FR-085·FR-250(입점 신청·심사)", "등록 형태·증빙·사업자 정보·정산 계좌를 내고 운영자 심사를 받는다", "<code>/merchant-application</code> · <code>/api/merchant-applications/me</code>", st("완료")],
 ["FR-071·FR-081a(강사 소속 승인·위임 권한)", "소속 신청 승인·거절, 「예약·명단」·「수업」 두 위임 토글, 소속 해제", "<code>/api/academies/{id}/affiliations</code>", st("완료")],
 ["FR-050a(수업 승인)", "강사가 올린 수업을 승인하거나 수정 요청. 승인 때 환불 공지 판본이 수업에 고정된다", "대표 앱 수업 검토 · <code>…/classes/{cid}/approve</code>", st("완료")],
 ["FR-079a(주문·예약 명단)", "기간·수업·상태로 주문을 걸러 보고, 회원·회차 명단을 본다", "<code>/api/academies/{id}/orders</code> · <code>…/members</code>", st("완료")],
 ["FR-063a(학원 공지)", "소속 강사에게만 보이는 학원 공지 작성·게시", "<code>/api/academies/{id}/staff-notices</code>", st("완료")],
 ["FR-070(학원 정보)·학원 앱 페이지", "주소·운영시간·시설 등 학원 정보와 회원에게 보이는 학원 페이지", "<code>PUT /api/academies/{id}/app-page</code>", st("완료")],
 ["FR-079b(대표 대시보드)", "오늘 신청·결제, 승인 대기 수업, 이번 달 신규 회원", "<code>GET /api/academies/{id}/dashboard</code>", st("완료")],
 ["FR-099a 계열(환불·취소 공지 판본)", "등록 형태별 정규 과정 템플릿, 이벤트형 공지, 판본 관리", "<code>/api/academies/{id}/refund-notices</code>", st("완료")],
 ["FR-098·FR-295(환불 결정·실행)", "환불 요청 결정과 계좌 환불 송금 완료 표시. 카드 환불 실행은 PG 가 있어야 한다", "<code>…/refund-requests/{rid}/decision</code>", st("PG 도입 후")],
 ["FR-125(학원 월 정산)·강사 지급 승인", "매월 정산과 강사 몫 일괄 지급 승인", "—", st("PG 도입 후")],
])}

<h3>3-5. 운영자</h3>
{frs([
 ["FR-250(입점 심사)", "입점 신청 목록·심사 시작·승인·반려", "<code>/admin/merchant-applications</code>", st("완료")],
 ["FR-254·FR-255(이용 제한 절차·신고)", "신고 접수 → 검토 → 처리, 사유 통지·소명·조치. 2026-11-25 운영자 메뉴에 「신고 처리」 입구를 더했다", "<code>/admin/reports</code> · <code>POST /api/admin/restrictions</code>", st("완료")],
 ["P11(사업자 점검)·P9(공휴일)", "국세청 공공데이터로 사업자 상태 점검, 휴·폐업 학원 노출 중지. 공휴일 관리", "<code>/admin/business-checks</code> · <code>/admin/holidays</code>", st("완료")],
 ["FR-300~FR-305(플랫폼 정산 콘솔)", "조회 전용 결산 대시보드·추이·증감. 메뉴 글자만 있다", "—", st("PG 도입 후")],
])}
""")

# 4. 시스템 흐름 ------------------------------------------------------
chapter("c4", "4. 시스템 흐름", f"""
<h3>4-1. 아키텍처</h3>
<p>DB 에 쓰는 곳은 Next.js 제품 API 하나다. AI 에이전트 서버는 별도 Python 프로세스로, 모델·이미지 엔진을 부르는 유일한 곳이다.
에이전트는 DB 에 직접 붙지 않고, Next.js 가 열어 둔 읽기 전용 MCP(Model Context Protocol) 도구로만 데이터를 읽는다(ADR-004). 도구 목록에 쓰기 도구는 0개다.</p>
{mermaid('''
flowchart TB
  APP[Android 앱 · Expo RN<br/>회원·강사·대표]
  WEB[관리자 웹 화면<br/>Next.js]
  subgraph Next[Next.js 16 제품 API · /api/**]
    direction LR
    AUTH[Better Auth<br/>쿠키·Bearer·TOTP] --> SVC[업무 서비스<br/>Prisma 8]
    MCP[MCP 읽기 도구<br/>/api/internal/mcp]
  end
  DB[(PostgreSQL 18<br/>+ pgvector)]
  RD[(Redis<br/>요청 제한·작업 큐)]
  PG[결제대행 PG<br/>미연동 · 가짜 어댑터]
  subgraph AG[AI 에이전트 서버 · Python]
    LG[FastAPI + LangGraph]
  end
  LLM[로컬 LLM<br/>Qwen3.5 9B · llama-server]
  CF[Cloudflare Workers AI<br/>FLUX.1 schnell 무료 구간]
  APP -->|Bearer| AUTH
  WEB -->|쿠키 + 2단계| AUTH
  SVC --> DB
  SVC --> RD
  SVC -. 포트 .-> PG
  SVC -->|X-Agent-Token| LG
  LG -->|X-Internal-Token| MCP
  MCP -->|읽기 전용| DB
  LG --> LLM
  LG --> CF
''', "그림 2. 구성 요소와 호출 방향. 점선은 아직 가짜 어댑터로만 붙은 자리")}
{table(["계층", "기술(버전은 기술 스택 고정표 기준)"], [
 ["앱", "Expo SDK 58.0.23 · React Native 0.88.1 · TypeScript 6.0.3"],
 ["웹·API", "Next.js 16.3.5 · React 19.3.0 · Node.js 24 LTS · Better Auth 1.7.5 · zod 4.6.5"],
 ["데이터", "Prisma 8.0.0-rc.24(@prisma/orm-postgres) · PostgreSQL 18.6 · pgvector 0.8.6 · Redis"],
 ["AI", "Python 3.12 · FastAPI 0.141.1 · LangGraph 1.2.12 · Qwen3.5 9B(llama-server, 로컬 GPU 8GB) · Cloudflare Workers AI FLUX.1 [schnell] · MCP SDK 1.30.1"],
 ["검증", "Vitest(단위·DB) · pytest · Playwright 1.65.1(E2E·스크린샷)"],
], widths=["15%", "85%"])}

<h3>4-2. 회원 가입 → 장르 선택 → 탐색 → 결제 대기</h3>
{mermaid('''
sequenceDiagram
  autonumber
  actor U as 회원
  participant A as 회원 앱
  participant N as Next.js API
  participant D as DB
  U->>A: 이메일·비밀번호 로그인
  A->>N: POST /api/auth/sign-in/email
  N-->>A: Bearer 토큰
  A->>N: POST /api/members (본인확인 토큰·닉네임·동의)
  N->>D: 회원 행 + 동의 기록 (같은 CI 면 409)
  A->>N: PUT /api/me/profile (관심 장르 여러 개)
  U->>A: 사진 카드에서 기준 장르 선택 (보이던 세부 장르)
  A->>N: PUT /api/me/base-genre {dance_sport, latin}
  A->>N: GET /api/home/offerings
  N->>D: 기한 지난 주문 정리 → 장르·세부 장르·지역·시간 거르기
  N-->>A: 수업 카드 목록 (잔여석 포함)
  U->>A: 수업 상세 → 자리 선택 → 결제
  A->>N: POST /api/orders + Idempotency-Key
  N->>D: 한 트랜잭션 — 자리 held, 주문 pending, 금액 고정
  N-->>A: 201 결제 대기 (가상계좌 또는 결제창, 기한)
  Note over N,D: 확정은 PG 웹훅으로만. 지금은 가짜 PG 시험 경로로 검증
''', "그림 3. 회원 첫 흐름")}

<h3>4-3. 강사 수업 등록 → 홍보 이미지 → 대표 승인 → 회원 노출</h3>
{mermaid('''
sequenceDiagram
  autonumber
  actor I as 강사
  participant A as 강사 앱
  participant N as Next.js API
  participant G as 에이전트 서버
  participant C as Cloudflare FLUX
  actor O as 대표
  I->>A: 수업 정보 입력 (1단계·2단계)
  A->>N: POST /api/classes/schedule-check
  N-->>A: 강사·강의실 겹침 없음 (겹치면 409)
  A->>N: POST /api/classes (임시 저장)
  I->>A: 칩·문장 고르고 엔진 확인
  A->>N: POST /api/ai/promo-images + Idempotency-Key
  N->>N: 하루 횟수 조건부 차감 (3번)
  N->>G: POST /v1/jobs (promo_image)
  G->>C: 영어 프롬프트 (글자 없음 조건)
  C-->>G: 이미지
  G->>N: POST /api/internal/ai/jobs/{id}/result
  A->>N: GET /api/ai/promo-images/{id} (2초마다)
  A->>N: PUT /api/classes/{id}/promo-assets → POST /api/classes/{id}/submit
  N-->>O: 승인 대기 알림
  O->>N: POST /api/academies/{a}/classes/{c}/approve
  N->>N: 게시 판정 다시 + 환불 공지 판본 고정 + 판매 단위 open
  Note over N: 이후 회원 홈 목록에 나타난다
''', "그림 4. 수업이 회원에게 보이기까지")}

<h3>4-4. 강사 레벨 정하기 → 회원 승급 안내 → 카드 발급</h3>
{mermaid('''
sequenceDiagram
  autonumber
  actor I as 강사
  participant N as Next.js API
  participant D as DB
  actor M as 회원
  I->>N: GET /api/instructor/offerings/{o}/member-levels
  N-->>I: 결제 완료 수강생 + 지금 레벨
  I->>N: POST /api/instructor/level-evaluations {samba, 회원들, level 4}
  N->>D: 평가 레벨 저장, 회원보다 높으면 level_offers(offered) + 알림
  M->>N: 홈 진입 → GET /api/me/levels (pendingOffers)
  M->>N: POST /api/me/level-offers/{id}/accept
  N->>D: 제안 행 잠금 → 레벨 올림 → 카드 발급 → level_up 알림
  M->>N: POST /api/me/level-cards/{id}/reveal (연출 본 시각)
  Note over M: 카드 뒤집기 연출 → 카드 모음에 쌓임
''', "그림 5. 레벨 승급. 회원이 받기를 눌러야 레벨이 오른다")}

<h3>4-5. AI 플래너 검색</h3>
{mermaid('''
sequenceDiagram
  autonumber
  actor M as 회원
  participant N as Next.js API
  participant G as 에이전트 서버
  participant T as MCP 읽기 도구
  participant L as 로컬 LLM
  M->>N: POST /api/ai/chat {kind: planner, message}
  N->>N: 회원 확인 · run 기록(연락처 모양 가림) · 120초 세션 토큰
  N->>G: POST /v1/chat/stream
  G->>L: 조건 뽑기 (장르·요일·강사·학원)
  G->>T: search_offerings / find_instructors (읽기 전용 트랜잭션)
  T-->>G: 실제 게시 수업
  G->>L: 결과만 근거로 답 문장
  G->>G: 문장마다 결과와 대조, 결과 밖 이름·숫자는 버림
  G-->>N: conditions · cards · text 이벤트
  N-->>M: AI SDK UI 스트림으로 번역해 전달
  Note over N: 1.5초 안 첫 이벤트가 없거나 25초를 넘기면 일반 검색 결과로 대체
''', "그림 6. AI 플래너 한 질문의 흐름")}

<h3>4-6. 로그인과 2단계 인증 — 웹은 필수, 앱은 앱 전용 경로</h3>
{mermaid('''
flowchart TD
  S[직원 로그인] --> W{어디서?}
  W -->|관리자 웹| U[POST /api/auth/sign-in/username]
  U --> T{인증 앱 등록?}
  T -->|아니오| E[two-factor/enable → QR]
  T -->|예| V[two-factor/verify-totp 6자리]
  E --> V
  V --> OK[쿠키 세션 · secondFactorVerified=true<br/>콘솔 열림]
  W -->|강사·대표 앱| P[POST /api/auth/sign-in/staff-app]
  P --> R{아이디·IP 15분 5회 초과?}
  R -->|예| X[429 RATE_LIMITED]
  R -->|아니오| B[Bearer 세션 · appSession=true<br/>secondFactorVerified=false]
  B --> AP[앱 경로 200]
  B --> WC[웹 콘솔 401 SECOND_FACTOR_REQUIRED]
  B --> AM[2단계·계정 관리 403 APP_SESSION_FORBIDDEN]
''', "그림 7. 같은 직원 계정이 웹과 앱에서 다르게 들어온다(ADR-007)")}
""")

# 5. 오류처리 -----------------------------------------------------------
chapter("c5", "5. 오류처리", f"""
<h3>5-1. 공통 오류 응답 모양</h3>
<p>모든 <code>/api/**</code> 오류는 사람이 읽는 한국어 문장(<code>detail</code>)과 기계가 읽는 코드(<code>code</code>)를 함께 준다. 검증 실패에만 칸별 <code>fields</code> 가 붙는다.
본문에 스택·SQL·연락처·환불 계좌를 담지 않는다(FR-299(결제 정보 보안)). <code>/api/auth/**</code> 는 Better Auth 모양을 그대로 쓰되 429 만 우리 모양으로 낸다.</p>
{code('''{ "detail": "사람이 읽는 한국어 문장", "code": "SEAT_SOLD_OUT" }

{ "detail": "입력값을 확인해 주세요", "code": "VALIDATION_FAILED",
  "fields": [ { "path": "baseSubGenre", "message": "…" } ] }

HTTP 429 · Retry-After: 840
{ "detail": "잠시 뒤 다시 시도해 주세요", "code": "RATE_LIMITED", "retryAfterSeconds": 840 }''')}

<h3>5-2. 주요 오류 코드</h3>
{table(["HTTP", "code", "언제"], [
 ["400", "<code>BAD_REQUEST</code>", "본문이 JSON 이 아님, 필수 헤더(<code>Idempotency-Key</code>) 없음"],
 ["401", "<code>UNAUTHENTICATED</code>", "세션 없음"],
 ["401", "<code>SECOND_FACTOR_REQUIRED</code>", "2단계 인증 전 세션으로 관리자 웹 콘솔 경로 호출(앱 로그인 세션 포함)"],
 ["401", "<code>INVALID_SIGNATURE</code>", "웹훅 서명 불일치(<code>/api/payments/webhook</code> 만)"],
 ["403", "<code>SIGNUP_INCOMPLETE</code>", "로그인은 했지만 회원 가입을 마치지 않음"],
 ["403", "<code>FORBIDDEN</code>", "남의 자원. 404 로 숨기지 않는다"],
 ["403", "<code>STAFF_ACCOUNT_REQUIRED</code> · <code>ACCOUNT_SUSPENDED</code>", "직원 계정 없음 · 정지된 계정"],
 ["403", "<code>APP_SESSION_FORBIDDEN</code>", "앱 로그인 세션으로 2단계·계정 관리 경로 호출"],
 ["403", "<code>INSTRUCTOR_MEMBERSHIP_REQUIRED</code>", "멤버십이 아닌 강사가 레벨 정하기 호출"],
 ["404", "<code>NOT_FOUND</code>", "자원 없음"],
 ["409", "<code>BASE_GENRE_REQUIRED</code>", "기준 장르를 고르기 전에 홈 목록 요청 — 화면이 아니라 API 에서 막는다"],
 ["409", "<code>SEAT_SOLD_OUT</code> · <code>CHECKOUT_CLOSED</code> · <code>NOTICE_MISSING</code>", "자리 마감 · 판매 종료·기한 지남 · 학원 환불 공지 없음"],
 ["409", "<code>SCHEDULE_CONFLICT</code> · <code>ROOM_CONFLICT</code>", "같은 강사 같은 시각 · 같은 강의실 같은 시각(FR-054·FR-072)"],
 ["409", "<code>CLASS_STATE_CONFLICT</code> · <code>ACADEMY_RESTRICTED</code>", "수업 상태가 맞지 않음 · 이용 제한된 학원의 게시"],
 ["409", "<code>IDENTITY_ALREADY_USED</code>", "같은 본인확인(CI)으로 두 번째 가입"],
 ["409", "<code>OFFER_NOT_PENDING</code>", "이미 답한 레벨 승급 안내에 다시 응답"],
 ["409", "<code>PROMO_DAILY_LIMIT_REACHED</code> · <code>PROMO_FREE_QUOTA_EXHAUSTED</code>", "홍보 이미지 하루 횟수 소진 · 엔진 무료량 소진(<code>resetsAt</code> 포함)"],
 ["422", "<code>VALIDATION_FAILED</code> · <code>CONSENT_REQUIRED</code> · <code>NICKNAME_NOT_ALLOWED</code>", "zod 검증 실패 · 필수 동의 빠짐 · 금칙어 닉네임"],
 ["422", "<code>PROMO_INPUT_BLOCKED</code>", "홍보 이미지 입력에 막는 표현"],
 ["429", "<code>RATE_LIMITED</code>", "로그인·인증 코드 실패 15분 5회, 결제 시작 분당 10회, 본인확인 하루 5회"],
 ["503", "<code>AI_UNAVAILABLE</code> · <code>MAINTENANCE_ACTIVE</code>", "에이전트·모델 무응답(<code>fallback</code> 포함) · 점검 중"],
 ["500", "<code>INTERNAL</code>", "예상 못 한 오류. 내부 정보를 담지 않는다"],
], widths=["8%", "40%", "52%"])}

<h3>5-3. 멱등키(Idempotency-Key)와 중복 처리</h3>
{table(["대상", "키", "다시 오면"], [
 ["<code>POST /api/orders</code>", "헤더 <code>Idempotency-Key</code>(필수, 8~200자) + 회원", "200 + 처음 주문 그대로. DB 유니크 제약이 최종 판정"],
 ["<code>POST /api/orders/{id}/cancel</code>", "주문 상태", "이미 취소면 200 같은 본문, 다른 상태면 409"],
 ["<code>POST /api/payments/webhook</code>", "헤더 <code>webhook-id</code>", "200, 아무것도 바꾸지 않음"],
 ["결제 확정", "주문 상태 조건부 갱신 <code>pending→paid</code>", "0행이면 이미 처리된 것"],
 ["<code>POST /api/ai/promo-images</code> · 포스터 읽기", "헤더 <code>Idempotency-Key</code>(필수)", "같은 생성·같은 작업을 돌려주고 횟수를 다시 빼지 않는다"],
], widths=["30%", "35%", "35%"])}
<p>삽입 경합은 <code>INSERT … ON CONFLICT DO NOTHING RETURNING id</code> 로 받고, 돌아온 행이 없으면 이긴 행을 다시 읽어 같은 결과로 맞춘다.
자리·횟수 차감은 「남아 있을 때만 줄이는」 조건부 UPDATE 한 문장이라 동시 요청에도 정원과 한도를 넘지 않는다.</p>

<h3>5-4. 화면의 빈 상태·오류 상태</h3>
{table(["상황", "화면"], [
 ["기준 장르 없음(409 BASE_GENRE_REQUIRED)", "홈 대신 기준 장르 화면으로 보낸다"],
 ["조건에 맞는 수업 0건", "제목(예: 「아르헨티나 탱고」)은 유지하고 빈 목록 안내"],
 ["자리 마감", "마감 표시, 결제 버튼을 끈다. 반대 성별 자리가 남으면 바꿀 수 있다"],
 ["권한 없는 콘솔 주소", "HTTP 403 화면 「이 메뉴를 쓸 권한이 없어요」. 메뉴·데이터는 그리지 않는다"],
 ["2단계 전", "<code>/login/second-factor</code> 로 보낸다"],
 ["하루 횟수 소진", "「오늘 마지막으로 만든 이미지」를 보여 주고 <code>사진 올리기</code> 로 잇는다"],
], widths=["40%", "60%"])}

<h3>5-5. 외부 API 실패</h3>
{table(["외부 의존", "실패할 때"], [
 ["로컬 LLM(llama-server)", "첫 이벤트 1.5초·전체 25초 기한. 넘으면 run 을 닫고 플래너는 일반 검색 결과로 대체. 5초마다 상태를 보고 3번 연속 실패면 저하 모드로 판단형 질문만 잠시 막는다(SC-048)"],
 ["Cloudflare Workers AI(이미지)", "공급자 한도(429·코드 4006) → <code>PROVIDER_QUOTA_EXHAUSTED</code>, 그 엔진을 다음 KST 0시까지 막는다. 모델 오류·시간 초과면 사람 하루 횟수를 한 번만 돌려준다. 엔진 전체 하루 한도는 100(추천값, 실측 전)"],
 ["소개 문구 초안", "20초 안에 답이 없으면 503 <code>AI_UNAVAILABLE</code>, 앱은 손으로 쓰게 한다"],
 ["Redis(요청 제한)", "꺼지면 <b>막는 쪽</b>으로 실패한다 — 로그인 실패 제한이 풀리지 않게"],
 ["PG", "지금은 가짜 어댑터. 실 PG 로 갈 때 주문 커밋 → PG 호출 → 결제 행 갱신 2단계로 바꿔야 한다(위험 R-P3)"],
], widths=["25%", "75%"])}
""")

# 6. 테스트 케이스 ------------------------------------------------------
TC = [
 ["TC-01", "회원 가입", "본인확인 토큰·필수 동의 넷", "<code>POST /api/members</code>", "201, 이름·성별·생년·연락처는 본인확인 값", "member-signup.db.test.ts"],
 ["TC-02", "1인 1계정", "같은 CI 로 이미 가입", "같은 CI 로 두 번째 가입(동시 2건 포함)", "하나만 201, 나머지 409 IDENTITY_ALREADY_USED", "member-signup.db.test.ts"],
 ["TC-03", "필수 동의", "필수 동의 하나 false", "가입 요청", "422 CONSENT_REQUIRED, 행 0", "member-signup.db.test.ts"],
 ["TC-04", "관심 장르 다중", "가입 끝난 회원", "장르 2개 + 중복 1개 저장", "중복은 하나로, 0개면 422 이고 기존 값 유지", "member-profile.db.test.ts"],
 ["TC-05", "기준 장르 필수", "기준 장르 없음", "<code>GET /api/home/offerings</code>", "409 BASE_GENRE_REQUIRED, 지역·시간대가 있어도 목록 없음", "home-offerings.db.test.ts"],
 ["TC-06", "세부 장르 필터", "라틴·스탠다드 수업 공개", "기준 세부 장르 latin → standard → 전체", "라틴만 → 스탠다드만 → 둘 다", "home-offerings.db.test.ts"],
 ["TC-07", "세부 장르 짝 검사", "—", "<code>argentine_tango + latin</code> 저장", "422 fields baseSubGenre, 저장값 그대로", "member-profile.db.test.ts"],
 ["TC-08", "승인 전 수업 숨김", "임시 저장·승인 대기·제한 학원 수업", "홈 목록", "0건", "home-offerings.db.test.ts"],
 ["TC-09", "마지막 자리 경쟁", "정원 1 남성 자리", "여러 회원 동시 결제 시작", "201 한 건, 나머지 409 SEAT_SOLD_OUT, held 1", "last-seat-concurrency.db.test.ts"],
 ["TC-10", "주문 멱등", "주문 1건 생성", "같은 Idempotency-Key 재요청(본문 다름)", "200 처음 주문, 행·자리 그대로", "order-create.db.test.ts"],
 ["TC-11", "서버 금액 계산", "—", "본문에 amount 를 넣어 주문", "금액은 서버가 계산, 본문 값 무시", "order-create.db.test.ts"],
 ["TC-12", "웹훅 서명·중복", "결제 대기 주문", "틀린 서명 → 진짜 웹훅 2번", "401 → 확정 1회, 두 번째는 duplicate", "payment-webhook.db.test.ts"],
 ["TC-13", "금액 3중 대조", "결제 대기 주문", "PG 입금액이 다른 웹훅", "확정하지 않음(amount_mismatch), 자리 held 유지", "payment-webhook.db.test.ts"],
 ["TC-14", "기한 만료", "기한 지난 결제 대기", "만료 작업 실행", "주문·결제·예약 expired, 자리 −1", "order-expiry.db.test.ts"],
 ["TC-15", "강사 겹침", "다른 학원에 같은 시각 수업", "submit", "409 SCHEDULE_CONFLICT, 회차 0", "class-schedule-conflict.db.test.ts"],
 ["TC-16", "강의실 겹침", "같은 홀 같은 시각", "다른 강사 수업 submit", "409 ROOM_CONFLICT", "class-schedule-conflict.db.test.ts"],
 ["TC-17", "수업 승인", "승인 대기 수업", "반려 → 수정 → 재제출 → 승인", "공개 목록 1건, 동시 두 번 승인도 공개 1회", "class-approval.db.test.ts"],
 ["TC-18", "포스터 검토 필수", "읽기 끝난 초안", "검토 없이 게시 요청", "409 REVIEW_REQUIRED, 수업 0", "poster-extraction-review.db.test.ts"],
 ["TC-19", "홍보 이미지 하루 한도", "하루 3번 사용", "4번째 요청 · 동시 5번", "409 PROMO_DAILY_LIMIT_REACHED · 3번만 들어감", "promo-image-quota.db.test.ts"],
 ["TC-20", "실패 시 횟수 원복", "생성 진행 중", "PROVIDER_ERROR 결과", "refunded: true, 남은 횟수 +1, 한 번만", "promo-image-quota.db.test.ts"],
 ["TC-21", "레벨 정하기", "결제 완료 수강생 2명", "레벨 4 적용", "레벨이 낮은 회원에게만 안내·알림, 회원 레벨은 그대로, 평가 레벨은 회원 응답에 없음", "instructor-level-evaluations.db.test.ts"],
 ["TC-22", "승급 받기", "열린 승급 안내", "accept → 다시 accept", "레벨 +1·카드 1장 → 409 OFFER_NOT_PENDING", "level-promotion-offer.db.test.ts"],
 ["TC-23", "웹 2단계", "인증 앱 등록 계정", "비밀번호만으로 콘솔 호출", "401 SECOND_FACTOR_REQUIRED, 6자리 뒤 200", "second-factor-gate.db.test.ts"],
 ["TC-24", "앱 로그인", "인증 앱을 켠 대표", "<code>POST /api/auth/sign-in/staff-app</code>", "200 + 토큰, 쿠키 없음, 앱 경로 200, 웹 콘솔 401", "staff-app-sign-in.db.test.ts"],
 ["TC-25", "로그인 실패 제한", "—", "같은 계정 5회 실패 뒤 6번째", "429 + 남은 시간, Redis 꺼지면 429", "rate-limit.db.test.ts"],
 ["TC-26", "권한 행렬", "역할 4종 계정", "모든 route.ts × 역할 호출", "허용 밖 요청 0건, 새 route 가 표에 없으면 실패", "permission-matrix.db.test.ts"],
 ["TC-27", "AI 쓰기 도구 0개", "에이전트 도구 목록", "도구 이름·권한 검사", "쓰기 도구 없음", "agent-server test_planner_no_write_tools.py"],
 ["TC-28", "검색 밖 추천 금지", "검색 결과 N건", "답 문장 생성", "결과 밖 수업은 추천하지 않음", "agent-server test_recommend_only_searched.py"],
]

chapter("c6", "6. 테스트 케이스", f"""
<h3>6-1. 테스트 전략</h3>
{table(["층", "무엇을", "도구", "언제"], [
 ["단위", "순수 함수(가격 계산·레벨 계산·메뉴 계산·검증 스키마)", "Vitest <code>npm run test:unit</code>", "코드 변경마다"],
 ["DB 통합", "경로 → 서비스 → 실제 PostgreSQL·Redis. 동시성·멱등·제약을 실제 DB 에서 확인", "Vitest <code>npm run test:db</code>(테스트 DB 분리)", "완료 판정 전"],
 ["권한 행렬", "모든 <code>route.ts</code> × 역할 4종의 허용·차단", "<code>permission-matrix.db.test.ts</code>", "새 경로가 생길 때 표도 같이 늘림"],
 ["에이전트", "조건 뽑기·도구 읽기 전용·프롬프트 주입 방어·답 검사", "pytest(<code>agent-server/tests</code>)", "에이전트 변경마다"],
 ["타입", "앱·웹 타입 검사", "<code>npx tsc --noEmit</code> · <code>next build</code>", "변경마다"],
 ["E2E·화면", "대표·운영자 웹 흐름, 앱 화면은 Expo 웹(390×844)과 Android 에뮬레이터 스크린샷을 증거 폴더에 남긴다", "Playwright 1.65.1 · 에뮬레이터", "화면을 바꿀 때마다"],
], widths=["12%", "43%", "27%", "18%"])}

<h3>6-2. 실측 결과(2026-11-25)</h3>
{table(["영역", "결과", "근거"], [
 ["admin-web DB 통합", "194 파일 · 1704 passed", "<code>_workspace/app-2fa-bypass/07_bug-fixer_fixes.md</code> 2차 검증(DB·Redis 기동)"],
 ["admin-web 단위", "127 파일 · 1768 passed", "<code>_workspace/evidence/fr022a/logs/admin-test-unit.log</code> · 같은 날 재실행 동일"],
 ["mobile 타입 검사", "exit 0(출력 없음)", "<code>_workspace/evidence/genre-cards-2026-11-25/logs/tsc.log</code>"],
 ["backend(옛 FastAPI)", "186 passed", "<code>_workspace/evidence/final-verify-2026-11-25/logs/backend-pytest.log</code>"],
 ["agent-server", "199 passed", "<code>_workspace/evidence/final-verify-2026-11-25/logs/agent-pytest.log</code>"],
 ["권한 행렬(보강 뒤)", "281 passed", "<code>_workspace/evidence/final-verify-2026-11-25/logs/permission-matrix-after.log</code>"],
], widths=["22%", "28%", "50%"])}
<p class="note">같은 날 앞선 전체 DB 실행(1668건)에서는 권한 행렬 1건이 실패했다. 표에 빠진 route 9개를 넣어 고친 뒤 권한 행렬 281건이 통과했고, 마지막 전체 실행이 위의 1704건이다.
1704건은 로그 파일이 아니라 수정 보고서에 적힌 값이다.</p>

<h3>6-3. 대표 테스트 케이스</h3>
<p>근거 파일은 <code>admin-web/tests/db/</code> 아래 파일 이름이다(TC-27·28 은 <code>agent-server/tests/</code>). 결과는 6-2 의 마지막 전체 실행 기준이다.</p>
{table(["ID", "기능", "사전 조건", "절차", "기대 결과", "근거 파일", "결과"],
       [r + [st("완료").replace("완료", "통과")] for r in TC], cls="tc",
       widths=["6%", "11%", "15%", "20%", "26%", "16%", "6%"])}

<h3>6-4. 보안 테스트 — 앱 세션 우회를 재현하고 막았다</h3>
<p>앱 로그인(ADR-007)을 만든 뒤 보안 리뷰에서 우회 경로가 나왔다. 고치기 전에 공격을 테스트로 먼저 재현했고(RED), 막은 뒤 같은 테스트가 통과했다(GREEN).</p>
{table(["단계", "공격", "고치기 전", "고친 뒤"], [
 ["C1", "앱 토큰으로 인증 앱 끄기 → 다시 등록 → 6자리 확인", "웹 콘솔 200 — 「2단계를 마친 세션」을 얻음", "앱 세션 이름표 <code>appSession=true</code> + 허용 목록 밖 403 <code>APP_SESSION_FORBIDDEN</code>"],
 ["H1", "앱 토큰으로 계정 관리 경로 24개 호출", "열림", "전부 403, 세션 읽기·로그아웃만 허용"],
 ["R2-C1", "따옴표로 감싼 쿠키 <code>name=\"TOKEN.서명\"</code> 로 허용 목록 판정 건너뛰기", "2단계 끄기 200", "쿠키를 Better Auth 와 같은 함수로 읽고, 데이터 쪽 길목(databaseHooks)에서 한 번 더 막음 → 403, 계정 값 그대로"],
], widths=["9%", "33%", "24%", "34%"])}
<p>근거: <code>_workspace/app-2fa-bypass/07_red_c1.log</code>(RED 4 failed) · <code>07_red_r2.log</code>(RED 3 failed) · <code>07_layer2_only.log</code>(앞단 훅을 끄고 데이터 길목만으로도 막히는지) · 최종 <code>staff-app-sign-in.db.test.ts</code> 16 passed. 3차 리뷰는 PASS 였다.</p>
""")

# 7. API 설계 -----------------------------------------------------------
API = [
 # (메서드, 경로, 역할, 설명)
 ("POST", "/api/auth/sign-in/email", "회원", "이메일 로그인(Better Auth)"),
 ("POST", "/api/auth/sign-in/username", "직원(웹)", "아이디 로그인 → 2단계로 넘김"),
 ("POST", "/api/auth/two-factor/verify-totp", "직원(웹)", "인증 앱 6자리 확인 → 세션"),
 ("POST", "/api/auth/sign-in/staff-app", "직원(앱)", "앱 전용 로그인, Bearer 토큰"),
 ("GET", "/api/staff/me", "직원", "역할·학원별 메뉴·2단계 여부"),
 ("POST", "/api/dev/identity/fake-verify", "개발 전용", "가짜 본인확인 토큰(운영 404)"),
 ("POST", "/api/members", "회원(가입 전)", "가입 완료"),
 ("GET", "/api/me", "회원", "내 정보·온보딩 상태"),
 ("PUT", "/api/me/profile", "회원", "관심 장르·지역·시간대·경험(전체 교체)"),
 ("PUT", "/api/me/base-genre", "회원", "기준 장르·세부 장르"),
 ("GET", "/api/home/offerings", "회원", "홈 목록(거르기·정렬)"),
 ("GET", "/api/offerings/{offeringId}", "회원", "수업 상세·기본 자리·판매자 정보·환불 공지"),
 ("POST", "/api/orders", "회원", "결제 시작(Idempotency-Key 필수)"),
 ("POST", "/api/orders/{orderId}/cancel", "회원", "결제 대기 셀프 취소"),
 ("POST", "/api/payments/webhook", "PG", "결제 결과 통지(서명·webhook-id)"),
 ("GET", "/api/me/calendar", "회원", "내 캘린더"),
 ("PUT·DELETE", "/api/me/sessions/{sessionId}/absence", "회원", "결석 예정 표시·취소"),
 ("GET", "/api/me/levels", "회원", "세부 장르별 레벨·안 본 카드·열린 승급 안내"),
 ("POST", "/api/me/level-offers/{offerId}/accept", "회원", "승급 받기 → 카드 발급"),
 ("GET", "/api/me/level-cards", "회원", "카드 모음"),
 ("POST", "/api/me/level-cards/{cardId}/reveal", "회원", "등급 연출을 본 시각 기록"),
 ("POST", "/api/ai/chat", "회원", "AI 플래너·문의 AI 질문(스트림)"),
 ("GET", "/api/instructors/{instructorId}", "회원", "공개 강사 카드"),
 ("POST·GET", "/api/inquiries", "회원", "문의 남기기·내 문의"),
 ("POST", "/api/instructor/signup", "강사(가입 전)", "강사 가입"),
 ("GET", "/api/instructor/schedule", "강사", "강사 일정(학원별 색)"),
 ("POST·GET", "/api/instructor/affiliations", "강사", "학원 소속 신청·목록"),
 ("POST", "/api/classes/schedule-check", "수업 편집 직원", "강사·강의실 겹침 미리 확인"),
 ("POST", "/api/classes", "수업 편집 직원", "수업 임시 저장"),
 ("POST", "/api/classes/{classId}/submit", "수업 편집 직원", "대표 승인 요청"),
 ("GET", "/api/classes/{classId}/sessions/{sessionId}/roster", "강사·위임·대표", "회차 명단(연락처 가림)"),
 ("GET", "/api/instructor/offerings/{offeringId}/member-levels", "멤버십 강사", "레벨 정하기 대상"),
 ("POST", "/api/instructor/level-evaluations", "멤버십 강사", "레벨 정하기 적용"),
 ("GET", "/api/ai/promo-image/options", "수업 편집 직원", "칩·예시·엔진 카드·남은 횟수"),
 ("POST", "/api/ai/promo-images", "수업 편집 직원", "홍보 이미지 만들기(비동기, 횟수 차감)"),
 ("GET", "/api/ai/promo-images/{generationId}", "만든 직원·대표", "생성 상태·결과"),
 ("POST", "/api/ai/class-intro-drafts", "수업 편집 직원", "소개 문구 초안"),
 ("POST", "/api/academies/{academyId}/poster-extractions", "수업 편집 직원", "포스터 읽기 시작"),
 ("PUT", "/api/merchant-applications/me/draft", "대표(입점 전)", "입점 신청 임시 저장"),
 ("POST", "/api/academies/{academyId}/affiliations/{id}/approve", "대표", "강사 소속 승인"),
 ("PUT", "/api/academies/{academyId}/affiliations/{id}/permissions", "대표", "위임 권한 토글"),
 ("GET", "/api/academies/{academyId}/class-approvals", "대표", "승인 대기 수업"),
 ("POST", "/api/academies/{academyId}/classes/{classId}/approve", "대표", "수업 승인 → 공개"),
 ("GET", "/api/academies/{academyId}/orders", "대표", "주문 목록(기간·수업·상태)"),
 ("GET", "/api/academies/{academyId}/dashboard", "대표", "대표 대시보드"),
 ("POST·GET", "/api/academies/{academyId}/staff-notices", "대표", "학원 공지"),
 ("PUT", "/api/academies/{academyId}/app-page", "대표", "학원 앱 페이지"),
 ("POST", "/api/admin/merchant-applications/{id}/approve", "운영자", "입점 승인"),
 ("GET", "/api/admin/reports", "운영자", "신고 목록"),
 ("POST", "/api/admin/restrictions", "운영자", "이용 제한 조치"),
 ("POST", "/api/internal/mcp", "에이전트(내부 토큰)", "MCP 읽기 도구 서버"),
 ("POST", "/api/internal/ai/jobs/{jobId}/result", "에이전트(내부 토큰)", "비동기 작업 결과 전달"),
]

chapter("c7", "7. API 설계", f"""
<h3>7-1. 설계 원칙</h3>
{table(["원칙", "규칙"], [
 ["경로·런타임", "모든 제품 API 는 <code>/api/**</code>(Next.js Route Handler, Node.js 런타임 고정). 실제 <code>route.ts</code> 는 217개"],
 ["자원 중심 REST", "조회 GET, 생성·동작 POST, 전체 교체 PUT, 일부 수정 PATCH. 상태를 바꾸는 동작은 <code>…/approve</code>·<code>…/cancel</code> 처럼 동사 하위 경로로 드러낸다"],
 ["인증", "Better Auth 세션. 웹은 쿠키(httpOnly·Secure·SameSite=Lax), 앱은 <code>Authorization: Bearer</code>. 내부 경로는 <code>X-Internal-Token</code>, 에이전트 서버는 <code>X-Agent-Token</code>(상수 시간 비교)"],
 ["권한", "회원은 <code>requireMember</code>, 직원은 <code>requireStaff(permission, {academyId, surface})</code>. 권한은 세션에 넣지 않고 요청마다 DB 에서 읽는다 — 위임을 끄면 다음 요청부터 403"],
 ["값 형식", "id 는 UUID, 시각은 ISO 8601 UTC(<code>Z</code>), 날짜는 KST 달력, 금액은 원 단위 정수. 장르는 영문 값(<code>salsa_bachata</code>)이고 한글 이름은 앱이 붙인다"],
 ["응답", "성공은 감싸지 않은 자원 JSON, 목록은 <code>{ \"items\": [...], \"nextCursor\" }</code>. 오류는 5장의 <code>{detail, code}</code>"],
 ["멱등", "돈·횟수가 걸린 생성은 <code>Idempotency-Key</code> 필수(5-3)"],
 ["시험 전용", "<code>/api/dev/**</code> 는 <code>KDANCE_DEV_ROUTES=true</code> 일 때만, 운영은 404"],
 ["권한 행렬", "역할 4종 × 모든 route 의 허용·차단을 표로 두고 테스트가 강제한다. 새 route 가 표에 없으면 테스트가 실패한다"],
], widths=["17%", "83%"])}

<h3>7-2. 직원 경로 판정 순서 — <code>requireStaff</code></h3>
{table(["#", "검사", "실패"], [
 ["1", "세션이 있다", "401 UNAUTHENTICATED"],
 ["2", "직원 계정이 있고 active", "403 STAFF_ACCOUNT_REQUIRED · ACCOUNT_SUSPENDED"],
 ["3", "웹 요청이면 2단계를 마쳤다(대표 앱도 부르는 경로는 Bearer 를 앱으로 본다)", "401 SECOND_FACTOR_REQUIRED"],
 ["4", "운영자 권한이면 운영자 역할", "403 FORBIDDEN"],
 ["5", "학원이 있다", "404 NOT_FOUND"],
 ["6~7", "대표 권한이면 그 학원 대표 / 위임 권한이면 대표이거나 active 소속 + 위임", "403 FORBIDDEN"],
 ["8", "학원 상태 조건(예: 이용 제한 학원의 새 게시)", "409 각 계약 코드"],
], widths=["7%", "63%", "30%"])}

<h3>7-3. 주요 엔드포인트</h3>
{table(["메서드", "경로", "역할", "설명"],
       [[f"<code>{m}</code>", f"<code>{esc(p)}</code>", r, d] for m, p, r, d in API], cls="api",
       widths=["10%", "47%", "16%", "27%"])}
<p class="note">모든 경로는 <code>admin-web/app/api/**/route.ts</code> 에 실제로 있다. <code>/api/auth/**</code> 는 Better Auth 의 <code>[...all]</code> 라우트 하나가 받는다.
계약 문서는 <code>_workspace/03_contracts/</code> 18개 파일이고, 한 경로는 한 파일에만 정의한다.</p>

<h3>7-4. 요청·응답 예시</h3>
<h4>① 기준 장르 저장 — <code>PUT /api/me/base-genre</code></h4>
{code('''요청
{ "baseGenre": "dance_sport", "baseSubGenre": "latin" }

200
{ "id": "…", "nickname": "서연", "gender": "female",
  "profile": { "interestGenres": ["dance_sport", "argentine_tango"], "regions": [{"sido":"서울","gu":"강남구"}], … },
  "baseGenre": "dance_sport", "baseSubGenre": "latin",
  "onboarding": { "profileDone": true, "baseGenreDone": true } }

422 (짝이 맞지 않음: argentine_tango + latin)
{ "detail": "입력값을 확인해 주세요", "code": "VALIDATION_FAILED", "fields": [{ "path": "baseSubGenre", … }] }''')}
<h4>② 홈 목록 — <code>GET /api/home/offerings?sort=deadline</code></h4>
{code('''200
{ "items": [ {
    "offeringId": "…", "classId": "…", "title": "살사 정규 입문", "genre": "salsa_bachata", "classKind": "regular",
    "academy": { "id": "…", "name": "…", "regionSido": "서울", "regionGu": "강남구" },
    "label": "12월 기간", "enrollmentUnit": "term", "sessionCount": 8,
    "firstSessionStartsAt": "…Z", "lastSessionEndsAt": "…Z", "priceAmount": 120000,
    "capacity": { "total": 12, "enrolled": 8,
      "pools": [ {"seatKind":"male","capacity":6,"enrolled":4,"remaining":2},
                 {"seatKind":"female","capacity":6,"enrolled":4,"remaining":2} ] } } ],
  "nextCursor": null }

409 (기준 장르 없음)
{ "detail": "…", "code": "BASE_GENRE_REQUIRED" }''')}
<h4>③ 결제 시작 — <code>POST /api/orders</code></h4>
{code('''Idempotency-Key: 6f1c…(8~200자)
{ "offeringId": "…", "seatKind": "male", "method": "virtual_account", "noticesAcknowledged": true }

201 (같은 키로 다시 오면 200 + 같은 주문)
{ "orderId": "…", "status": "pending", "reservationId": "…", "seatKind": "male",
  "priceBreakdown": [ {"kind":"list_price","label":"정가","amount":120000},
                      {"kind":"benefit_discount","label":"혜택 할인","amount":0},
                      {"kind":"coupon_discount","label":"쿠폰","amount":0},
                      {"kind":"final","label":"최종 결제액","amount":120000} ],
  "payment": { "paymentId": "…", "method": "virtual_account", "status": "ready", "amount": 120000, "dueAt": "…Z",
               "virtualAccount": { "bankCode": "004", "accountNumber": "…", "holder": "케이댄스" } } }''')}
<h4>④ 앱 로그인 — <code>POST /api/auth/sign-in/staff-app</code></h4>
{code('''요청  { "username": "owner_kim", "password": "…" }
200   { "token": "…", "user": { "id": "…", "username": "owner_kim", "displayUsername": "…", "name": "…" } }   ※ 쿠키 없음
401   { "code": "INVALID_USERNAME_OR_PASSWORD", "message": "Invalid username or password" }   ※ 계정 유무를 흘리지 않음
403   { "code": "STAFF_ACCOUNT_REQUIRED", "detail": "…", "message": "…" }   ※ 비밀번호가 맞은 뒤 직원 계정이 아닐 때
이 토큰으로 /api/auth/two-factor/disable 등 계정 관리 경로를 부르면
403   { "code": "APP_SESSION_FORBIDDEN", "detail": "앱 로그인으로는 쓸 수 없는 기능이에요. 관리자 웹에서 해 주세요" }''')}
""")

# 8. 비기능 요구사항 ----------------------------------------------------
chapter("c8", "8. 비기능 요구사항", f"""
<h3>8-1. 성능·규모</h3>
{table(["요구", "값", "근거"], [
 ["운영 목표", "베타 1~10명 → 3년 뒤 1천~1만 명", "spec 규모 단계 S1~S3"],
 ["설계 상한", "10만 명 — 코드·데이터 구조 변경 없이 서버·DB 증설만으로", "SC-017a(10만 설계 상한)"],
 ["베타 동시 접속", "100명까지 버틴다", "규모 단계 S1"],
 ["검색 응답", "95%가 1초 안", "SC-015(검색 1초)"],
 ["AI 판단형 질문(동시 10명)", "95%가 첫 내용 15초·완료 25초 안. 실측: 예열 뒤 동시 10명 첫 글자 p95 약 9초, 완료 p95 약 15~17초", "SC-041 · <code>infra/ai-bench/bench_pipeline.py</code>"],
 ["알림", "수업 전 알림 ±1분 99%, 변경·휴강 알림 저장 뒤 1분 안", "SC-013 · SC-014"],
 ["정합성", "정원 초과·금액 불일치·중복 환불 0건, 정산 합계 차이 0원", "SC-005~SC-010b"],
], widths=["22%", "50%", "28%"])}
<p class="note">부하 시험(SC-016·SC-017)은 아직 하지 않았다. 동시성은 DB 통합 테스트(마지막 자리·중복 환불·동시 승인)로 확인한 수준이다.</p>

<h3>8-2. 보안·개인정보</h3>
{table(["요구", "구현"], [
 ["관리자 웹 2단계 인증", "TOTP(인증 앱 6자리)만. 문자·이메일 OTP·패스키 경로는 404 로 끔. 같은 기기 30일 기억 선택(FR-303)"],
 ["앱 세션 제한(ADR-007)", "앱은 2단계를 묻지 않는 대신 아이디·IP 15분 5회 실패 제한을 걸고, 앱 세션은 웹 콘솔·계정 관리 경로를 못 쓴다. 비밀번호만 알면 대표 앱에서 회원 정보를 볼 수 있다는 위험은 사용자가 알고 골랐고, 개인정보 안전성 확보조치 기준 해당 여부는 공개 운영 전 확인이 남았다"],
 ["로그인·요청 제한", "로그인·인증 코드 15분 5회, 본인확인 하루 5회, 결제 시작 분당 10회. Redis 에 세고 Redis 가 꺼지면 막는다. Redis 키에 IP·계정 원문을 남기지 않는다"],
 ["비밀번호", "Better Auth 해시. 없는 아이디도 해시 지연을 같게 두어 계정 유무를 흘리지 않는다"],
 ["개인정보 최소 노출", "회원은 닉네임으로만 보인다. 연락처는 기본 가림, 전체 열람은 사유·열람자 기록(SC-025). 강사 화면은 나이 대신 연령대. 위치는 저장하지 않는다(FR-186)"],
 ["결제 정보", "카드번호를 저장하지 않고 PG 식별값만. 환불·정산 계좌는 암호화·가림 표시"],
 ["감사 기록", "결제·환불·개인정보·권한 조작은 수행자·시각·대상·전후 값(FR-185)"],
 ["AI", "에이전트는 DB 에 직접 접속하지 않고 읽기 전용 도구만 쓴다. 질문 기록은 전화·메일·계좌 모양을 가린다. 사용자 입력은 데이터 칸으로만 넣어 프롬프트 주입을 막는다(<code>test_prompt_injection_guard.py</code>). AI 생성물에 생성 표시"],
 ["비밀값", "소스에 자격 증명 0건(SC-024). 환경별 설정을 나누고 필수 비밀값이 없으면 서버가 시작을 거부"],
], widths=["22%", "78%"])}

<h3>8-3. 가용성·운영</h3>
{table(["요구", "값"], [
 ["월 가용성", "99.5% 이상(SC-018) — 목표값, 운영 배포 전이라 미측정"],
 ["AI 저하 모드", "모델 서버가 3번 연속 응답하지 않으면 판단형 질문만 멈추고, 내 데이터 조회·정해진 지식·사람 문의는 계속 답한다. 연속 2번 성공하면 사람 손 없이 풀린다"],
 ["백업(추천값 확정)", "매일 전체 백업 + 트랜잭션 로그, RPO 15분 · RTO 4시간, 분기 1회 복원 훈련"],
 ["점검·버전", "점검 중에는 결제 시작을 막고 안내, 지원하지 않는 옛 앱에는 업데이트 요구(FR-022b)"],
 ["로컬 개발 환경", "PostgreSQL·Redis·LLM 을 Docker 로 띄운다. LLM 은 노트북 GPU 8GB 하나에 채팅·비전만 둔다"],
], widths=["22%", "78%"])}

<h3>8-4. 비용 — 무료 API 정책</h3>
<p>외부 API 는 영구 무료 구간이 있는 것만 반복 호출 자리에 쓴다. 결제 수단 등록·유료 플랜 가입은 하지 않고, 한도가 끝나면 그 자리에서 멈춘다.
유료 예외는 대체 수단이 없는 <b>PG(결제)</b>와 <b>휴대폰 본인확인</b> 두 가지뿐이다.</p>
{table(["자리", "무엇을 쓰나", "비용"], [
 ["대화·포스터 읽기", "로컬 Qwen3.5 9B(llama-server)", "한도 없음 · 키 없음"],
 ["홍보 이미지", "Cloudflare Workers AI FLUX.1 [schnell]", "무료 구간 하루 10,000 neurons — 엔진 하루 한도 100장(추천값, 미검증)"],
 ["사업자 상태 점검", "국세청 공공데이터 API", "하루 100만 건 무료"],
 ["예금주 확인", "운영자가 통장 사본으로 수동 대조", "0원"],
 ["PG · 본인확인", "미정(사업자 등록 뒤 계약)", "유료 예외"],
], widths=["22%", "45%", "33%"])}

<h3>8-5. 접근성(추천값 확정)</h3>
<p>본문 글자 대비 4.5 : 1 이상, 누르는 영역 48dp 이상, 모든 버튼에 TalkBack 레이블, 기기 글자 크기 200%에서도 깨지지 않을 것,
마감·결석·오류는 색과 글자로 함께 표시한다. 「동작 줄이기」를 켠 사용자에게는 움직이는 순위판을 멈춘다. 아직 접근성 전수 점검은 하지 않았다.</p>

<h3>8-6. 유지보수</h3>
{table(["원칙", "내용"], [
 ["버전 정책", "<b>호환되는 선에서 최신</b>. 최신과 의존성 호환이 부딪치면 호환이 이긴다. 예: React Native 는 Expo SDK 58 이 고정한 0.88.1 을 따른다"],
 ["기술 스택 고정표", "버전 값의 원본은 <code>docs/planning/tech/tech-stack.md</code> 「11. 기술 스택 고정표」 한 곳. 다른 문서에 복제하지 않는다"],
 ["요구사항 원본", "spec 이 단일 원본이다. 화면 보드에서 요구가 바뀌면 같은 작업 안에서 spec FR 과 변경 이력을 고친다"],
 ["결정 기록", "되돌리기 어려운 결정은 <code>CLAUDE-decisions.md</code> ADR(ADR-001~007)"],
 ["계약 우선", "API 계약(<code>_workspace/03_contracts/</code>)·데이터 모델을 먼저 쓰고 구현한다. 한 경로는 한 파일에만 정의"],
 ["회귀 방지", "Better Auth 를 올릴 때는 앱 세션 테스트와 「데이터 길목만 켠 확인」을 반드시 다시 돌린다(ADR-007)"],
], widths=["20%", "80%"])}
""")

# 부록: 화면 -----------------------------------------------------------
chapter("c9", "부록. 시연 화면(2026-11-25, Android 에뮬레이터)", f"""
<p>모든 그림은 <code>_workspace/evidence/demo-video-emulator-2026-11-25/</code> 의 스크린샷이다.</p>
<h4>회원</h4>
{phones([
 ("demo-video-emulator-2026-11-25/01-entry-member-login.png", "회원 로그인"),
 ("demo-video-emulator-2026-11-25/12-member-genre-cards.png", "기준 장르 사진 카드"),
 ("demo-video-emulator-2026-11-25/14-member-home-latin.png", "홈 — 댄스스포츠(라틴)"),
 ("demo-video-emulator-2026-11-25/15-member-offering-detail.png", "수업 상세"),
 ("demo-video-emulator-2026-11-25/21-member-planner-answer.png", "AI 플래너 답"),
])}
{phones([
 ("demo-video-emulator-2026-11-25/32-member-interest-four.png", "관심 장르 다중 선택"),
 ("demo-video-emulator-2026-11-25/46-levelup-alert.png", "레벨업 알림"),
 ("demo-video-emulator-2026-11-25/49-levelup-card.png", "레벨 카드 발급"),
 ("demo-video-emulator-2026-11-25/51-levelup-collection.png", "카드 모음"),
 ("demo-video-emulator-2026-11-25/81-member-home-new-class.png", "승인된 새 수업 노출"),
])}
<h4>강사·대표</h4>
{phones([
 ("demo-video-emulator-2026-11-25/02-entry-instructor-login.png", "강사 로그인"),
 ("demo-video-emulator-2026-11-25/41-inst-home-today.png", "강사 오늘 수업"),
 ("demo-video-emulator-2026-11-25/43-inst-level-sheet.png", "레벨 정하기"),
 ("demo-video-emulator-2026-11-25/55-inst-promo-result.png", "홍보 이미지 결과"),
 ("demo-video-emulator-2026-11-25/73-owner-app-class-review.png", "대표 앱 수업 검토"),
])}
<h4>관리자 웹(대표)</h4>
<div class="webshots">
<figure><img src="{EV}/demo-video-emulator-2026-11-25/92-owner-web-dashboard.png" alt="대표 대시보드"><figcaption>대표 대시보드</figcaption></figure>
<figure><img src="{EV}/demo-video-emulator-2026-11-25/96-owner-web-roster.png" alt="예약 명단"><figcaption>예약 명단</figcaption></figure>
</div>
""")


# ───────────────────────────── 조립 ─────────────────────────────

CSS = """
@page { size: A4; margin: 16mm 15mm 17mm 15mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Noto Sans CJK KR', 'Noto Sans KR', sans-serif; font-size: 9.6pt; line-height: 1.6;
       color: #2a2330; margin: 0; }
code, pre { font-family: 'D2Coding', monospace; }
code { font-size: 0.92em; background: #f4eef2; padding: 0 3px; border-radius: 3px; color: #4a2340; word-break: break-all; }
h2 { font-size: 17pt; color: #5b2a4e; border-bottom: 2.5px solid #c9a96e; padding-bottom: 4px; margin: 0 0 12px; }
h3 { font-size: 12pt; color: #5b2a4e; margin: 18px 0 6px; break-after: avoid; }
h4 { font-size: 10.2pt; margin: 12px 0 4px; break-after: avoid; color: #3d2a38; }
p { margin: 4px 0 8px; }
.note { font-size: 8.6pt; color: #6b5a66; background: #fbf8f1; border-left: 3px solid #c9a96e; padding: 4px 8px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 8.6pt; table-layout: fixed; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th { background: #5b2a4e; color: #fff; font-weight: 700; text-align: left; padding: 4px 6px; }
td { border-bottom: 1px solid #e6dce2; padding: 4px 6px; vertical-align: top; word-break: keep-all; overflow-wrap: anywhere; }
tbody tr:nth-child(even) td { background: #fbf8f1; }
table.tc, table.api { font-size: 7.9pt; }
table.tc td { padding: 3px 5px; line-height: 1.45; }
td small { color: #7a6a74; }
.badge { display: inline-block; padding: 0 6px; border-radius: 9px; font-size: 7.8pt; font-weight: 700; white-space: nowrap; }
.badge.ok { background: #e7e0f0; color: #3e2a66; }
.badge.part { background: #f6ead2; color: #7a5410; }
.badge.pg { background: #f3dbe4; color: #7b1f45; }
.badge.no { background: #e9e6e8; color: #555; }
pre.code { background: #2a2330; color: #f3ede6; font-size: 7.8pt; line-height: 1.5; padding: 8px 10px; border-radius: 5px;
           white-space: pre-wrap; word-break: break-all; break-inside: avoid; margin: 4px 0 10px; }
figure { margin: 8px 0 12px; }
figure.diagram { break-inside: avoid; text-align: center; border: 1px solid #eee4ea; border-radius: 6px; padding: 8px 4px 4px; }
figure.diagram svg { display: inline-block; }
figcaption { font-size: 8pt; color: #6b5a66; text-align: center; margin-top: 4px; }
pre.mermaid { font-family: 'Noto Sans CJK KR', sans-serif; }
.phones { display: flex; gap: 3mm; justify-content: space-between; break-inside: avoid; margin-bottom: 4mm; }
.phone { margin: 0; width: 33mm; }
.phone img { width: 33mm; height: auto; border: 1px solid #ccc; border-radius: 4px; display: block; }
.webshots { display: flex; gap: 4mm; break-inside: avoid; }
.webshots figure { margin: 0; width: 50%; }
.webshots img { width: 100%; border: 1px solid #ccc; border-radius: 4px; }
section.chap { break-before: page; }
.cover { height: 258mm; display: flex; flex-direction: column; justify-content: center; padding: 0 12mm;
         background: linear-gradient(160deg, #fbf8f1 0%, #fbf8f1 60%, #efe3d0 100%); border-left: 10mm solid #5b2a4e; }
.cover .kicker { color: #c9a96e; font-weight: 700; letter-spacing: 3px; font-size: 11pt; }
.cover h1 { font-size: 40pt; margin: 6mm 0 2mm; color: #5b2a4e; }
.cover .sub { font-size: 16pt; color: #3d2a38; margin-bottom: 18mm; }
.cover dl { display: grid; grid-template-columns: 30mm auto; row-gap: 3mm; font-size: 11pt; margin: 0; }
.cover dt { color: #8a7480; } .cover dd { margin: 0; font-weight: 700; }
.toc { break-before: page; }
.toc ol { list-style: none; padding: 0; margin: 8mm 0; font-size: 12pt; }
.toc li { display: flex; align-items: baseline; padding: 3.2mm 0; border-bottom: 1px dotted #c9a96e; }
.toc li a { color: #2a2330; text-decoration: none; font-weight: 700; }
.toc li .desc { color: #7a6a74; font-size: 9pt; margin-left: 4mm; flex: 1; }
.toc li .pg { color: #5b2a4e; font-weight: 700; min-width: 10mm; text-align: right; }
"""

TOC_DESC = {
    "c1": "구성 요소 · 역할 4종 · 장르 4종 · 기능 지도",
    "c2": "풀려는 문제 · 대상 사용자 · 성공 기준",
    "c3": "역할별 핵심 FR 과 구현 상태",
    "c4": "아키텍처 · 주요 흐름 시퀀스 5종",
    "c5": "오류 응답 모양 · 오류 코드 · 멱등키 · 외부 API 실패",
    "c6": "테스트 전략 · 실측 결과 · 대표 케이스 28개 · 보안 테스트",
    "c7": "설계 원칙 · 권한 판정 · 엔드포인트 52개 · 예시",
    "c8": "성능 · 보안 · 가용성 · 비용 · 접근성 · 유지보수",
    "c9": "에뮬레이터·관리자 웹 화면",
}


def build_html() -> str:
    cover = """
<div class="cover" id="cover">
  <div class="kicker">FUNCTIONAL SPECIFICATION</div>
  <h1>K-DanceX4</h1>
  <div class="sub">AI 소셜댄스 수업 예약·멤버십 플랫폼<br>기능 명세서</div>
  <dl>
    <dt>작성자</dt><dd>임채웅</dd>
    <dt>작성일</dt><dd>2026-11-25</dd>
    <dt>대상</dt><dd>회원 앱 · 강사·대표 앱 · 관리자 웹 · AI 에이전트 서버</dd>
    <dt>요구사항 원본</dt><dd>specs/001-ai-dance-class-platform/spec.md</dd>
  </dl>
</div>"""
    items = "".join(
        f'<li><a href="#{cid}">{esc(title)}</a><span class="desc">{TOC_DESC[cid]}</span><span class="pg" data-for="{cid}"></span></li>'
        for cid, title, _ in CHAPTERS
    )
    toc = f'<div class="toc" id="toc"><h2>목차</h2><ol>{items}</ol></div>'
    secs = "".join(f'<section class="chap" id="{cid}"><h2>{esc(t)}</h2>{b}</section>' for cid, t, b in CHAPTERS)
    return (
        '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
        "<title>임채웅_기능명세서 — K-DanceX4</title>"
        f"<style>{CSS}</style></head><body>{cover}{toc}{secs}</body></html>"
    )


NODE = r"""
const { chromium } = require(process.env.PW);
const fs = require('fs');
// Chrome 이 만든 PDF 의 쪽 객체 수를 센다(/Type /Page — /Pages 는 제외)
const countPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![s])/g) || []).length;
function startsFromPdf(buf) {
  const t = buf.toString('latin1');
  const obj = (n) => { const m = t.match(new RegExp('(?:^|\\n)' + n + ' 0 obj\\s*([\\s\\S]*?)endobj')); return m ? m[1] : ''; };
  const rootPages = t.match(/\/Type\s*\/Catalog[\s\S]*?\/Pages (\d+) 0 R/)[1];
  const order = [];
  const walk = (n) => { const o = obj(n); const kids = o.match(/\/Kids\s*\[([^\]]*)\]/);
    if (kids) [...kids[1].matchAll(/(\d+) 0 R/g)].forEach((k) => walk(k[1])); else order.push(n); };
  walk(rootPages);
  const destsRef = t.match(/\/Dests (\d+) 0 R/)[1];
  const start = { cover: 1, toc: 2 };
  for (const m of obj(destsRef).matchAll(/\/(c\d+) \[(\d+) 0 R/g)) start[m[1]] = order.indexOf(m[2]) + 1;
  return start;
}
const pdfOpts = {
  format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#8a7480;padding:0 15mm;display:flex;justify-content:space-between;font-family:'Noto Sans CJK KR',sans-serif">
     <span>K-DanceX4 기능 명세서 · 임채웅</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
};
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await page.goto('file://' + process.env.HTML, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: process.env.MERMAID });
  // Mermaid 를 SVG 로 굽는다. 글꼴을 문서와 같게 맞춰야 글자 폭 계산이 맞는다
  await page.evaluate(async () => {
    mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict',
      themeVariables: { fontFamily: 'Noto Sans CJK KR, sans-serif', fontSize: '13px',
        primaryColor: '#f4eef2', primaryBorderColor: '#5b2a4e', primaryTextColor: '#2a2330',
        lineColor: '#7a5a70', secondaryColor: '#fbf3e4', tertiaryColor: '#fbf8f1',
        actorBkg: '#f4eef2', actorBorder: '#5b2a4e', noteBkgColor: '#fbf3e4', noteBorderColor: '#c9a96e' },
      flowchart: { curve: 'basis', useMaxWidth: true }, sequence: { useMaxWidth: true, mirrorActors: false } });
    await mermaid.run({ querySelector: 'pre.mermaid' });
    document.querySelectorAll('script').forEach((s) => s.remove());
    // 세로로 긴 그림이 한 쪽을 넘지 않게: 높이 상한(약 170mm = 642px)에 맞춰 폭을 정해 둔다
    const MAX_H = 642;
    document.querySelectorAll('figure.diagram svg').forEach((svg) => {
      const vb = svg.viewBox.baseVal; if (!vb || !vb.width) return;
      const boxW = svg.parentElement.clientWidth || 680;
      const natural = parseFloat(svg.style.maxWidth) || vb.width;
      const w = Math.min(boxW, natural * 1.25, MAX_H * vb.width / vb.height);
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.style.maxWidth = 'none'; svg.style.width = w + 'px'; svg.style.height = 'auto';
    });
  });
  const bad = await page.evaluate(() => document.querySelectorAll('pre.mermaid:not([data-processed])').length
     + [...document.querySelectorAll('pre.mermaid svg')].filter(s => s.textContent.includes('Syntax error')).length);
  if (bad) { console.error('MERMAID_FAIL', bad); process.exit(2); }
  const brokenImgs = await page.evaluate(() => [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => i.src));
  if (brokenImgs.length) { console.error('IMG_FAIL', brokenImgs); process.exit(3); }
  await page.emulateMedia({ media: 'print' });
  // 목차 쪽 번호: 완성 PDF 의 이름 붙은 목적지(/Dests — 목차 링크 #c1… 가 만든 것)가 가리키는 쪽을 읽는다
  const first = await page.pdf(pdfOpts);
  const start = startsFromPdf(first);
  await page.evaluate((start) => document.querySelectorAll('.toc .pg').forEach((el) => { el.textContent = start[el.dataset.for]; }), start);
  fs.writeFileSync(process.env.HTML, '<!DOCTYPE html>\n' + (await page.evaluate(() => document.documentElement.outerHTML)));
  const buf = await page.pdf(pdfOpts);
  fs.writeFileSync(process.env.PDF, buf);
  console.log(JSON.stringify({ start, startFinal: startsFromPdf(buf), total: countPages(buf), bytes: buf.length }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
"""


def main() -> int:
    for need in (PLAYWRIGHT, CHROME, MERMAID):
        if not need.exists():
            print(f"필요한 파일이 없다: {need}", file=sys.stderr)
            return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_HTML.write_text(build_html(), encoding="utf-8")
    env = {**os.environ, "PW": str(PLAYWRIGHT), "CHROME": str(CHROME), "MERMAID": str(MERMAID),
           "HTML": str(OUT_HTML), "PDF": str(OUT_PDF)}
    r = subprocess.run(["node", "-e", NODE], env=env, capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    if r.returncode == 0:
        info = json.loads(r.stdout.strip().splitlines()[-1])
        # 목차 숫자를 넣은 뒤 쪽이 밀렸는지 다시 확인한다
        if info["start"] != info["startFinal"]:
            print("경고: 목차 쪽 번호와 최종 PDF 의 장 시작 쪽이 다르다 — 다시 돌린다", file=sys.stderr)
            return 4
    return r.returncode


if __name__ == "__main__":
    raise SystemExit(main())
