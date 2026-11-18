"""Penpot 보드 재배치 계획 — 역할 4구역(회원·강사·대표 앱·관리자 웹)을 세로 기둥으로 나누고 구역 안은 흐름별 소제목 줄로 놓는다.
보드 위치만 계산한다. 실행은 gen.py 가 만든 JS 조각이 한다."""
import json, re, sys
S = "/tmp/claude-1000/-home-user-kdance/9c1b01f8-c845-4703-b083-9dbe8e8b4be7/scratchpad"
rows = [r.split("\t") for r in open(f"{S}/names.tsv", encoding="utf-8").read().split("\n")]
boards = [dict(x=int(r[0]), y=int(r[1]), w=int(r[2]), h=int(r[3]), name=r[4]) for r in rows]
ARCH = lambda n: ("이전 안" in n) or ("폐기" in n)
key = lambda n: n.split(" · ")[0]
live = {}
for b in boards:
    if ARCH(b["name"]):
        continue
    live.setdefault(key(b["name"]), []).append(b)

XI, XO, XW = 6200, 12400, 18600   # 강사 · 대표 앱 · 관리자 웹 기둥의 왼쪽 끝
ZONES = {
 "member": dict(x0=0, y0=13000, pitch=440, wrap=10, subs=[
  ("01-11 가입·계정·내 정보", "C14A C14B C6A C6B C19A C21A"),
  ("01-12 검색·AI 플래너 (강사 수업 찾기 포함)", "C29A C22B C31A C32A C32B M10F M10G C23A"),
  ("01-13 수업 상세·신청·결제 (추가 상태)", "C13A C13B C17A C17B C4A C4B C5A C7A C9B C33A"),
  ("01-14 파티·공연·대회 신청", "C3A C3B C3C C18A"),
  ("01-15 캘린더·결석·회차 옮기기·휴강", "C24B C26A C4C C15D"),
  ("01-16 환불 요청·환불 규정·지난 주문", "C15A C15B C15C C9A C25A C32C C27A"),
  ("01-17 멤버십·쿠폰·레벨 카드", "C8A C8B C16A C16B C28A C24A"),
  ("01-18 알림·구독·문의·신고·찜", "C1A C22A C2A C2B C30A C11A C19B"),
  ("01-19 약관·탈퇴·점검·업데이트", "C10A C10B C11B C20A C20B C32D"),
 ]),
 "instructor": dict(x0=XI, y0=8500, pitch=440, wrap=12, subs=[
  ("02-7 가입·소속 신청·소속 해제·탈퇴", "I31 I31B I27 I27B I28 I28B I39 I30"),
  ("02-8 수업 탭·수업 등록·홍보 이미지·수정", "I19 I19B I44 I32B I32C I32 I32D I41 I42 I43 I33 I24"),
  ("02-9 회차 운영·인원·휴강·변경", "I22 I22B I23 I26 I25 I34 I35 I36"),
  ("02-10 대타 요청·새 반 열기", "I14 I14B I14C I15 I15B"),
  ("02-11 개인 레슨 수강생·회차·규칙", "I20 I20B I20C"),
  ("02-12 정산·정산 계좌·대표에게 문의", "I17 I17B I17C I17D I18 I18B I16"),
  ("02-13 수업 관리 플러스·프로필·약관", "I29 I31C I36B I37 I37B I38 I40 I40B"),
 ]),
 "owner": dict(x0=XO, y0=127, pitch=440, wrap=12, subs=[
  ("03-1 알림·승인·홈", "O5P O5 O6 O21 O21B O36 O36B"),
  ("03-2 캘린더·수업·행사·현장 등록", "O23 O24 O43 O44 O27 O40"),
  ("03-3 학원 — 강사·회원·공지", "O31 O37 O33 O38 O39 O39B O32 O28"),
  ("03-4 문의·환불 처리", "O22 O48 O48B"),
  ("03-5 매출·정산·지급", "O29 O45 O46 O47 O26 O49"),
  ("03-6 마이 — 계정·학원 페이지·1+1·자주 묻는 질문", "O25 O30 O34 O35 O41 O42"),
  ("03-7 수업 상세 · 시간표 (긴 화면)", "O8"),
 ]),
 "web": dict(x0=XW, y0=127, pitch=1330, wrap=4, subs=[
  ("W-1 로그인·2단계 인증·권한별 메뉴", "W1a W1b W1b3 W1b2 W1c"),
  ("W-2 입점 신청·설정·해지·학원 페이지", "W2a W2b W26 W22"),
  ("W-3 대시보드", "W29"),
  ("W-4 강사 관리·소속 해제·강의실·강사 몫", "W3a W3b W3b2 W3c W24"),
  ("W-5 수업·포스터 등록·행사·휴강", "W15 W16 O2 W25 W17 W18 W19"),
  ("W-6 환불·취소 공지 양식·정산 안내·학원 공지", "W4a W4b W8B W5"),
  ("W-7 예약·명단·회원·문의·1+1", "W6 W20 W21 W9 W7a"),
  ("W-8 환불 처리·주문·결제", "O3 W27 W10"),
  ("W-9 정산·지급·이의", "O4 W7b W11 W12 W13 W14 W28"),
  ("W-10 권한 받은 강사의 화면", "W23 W30"),
 ]),
}
moves, heads, problems, used = [], [], [], set()
for zone, z in ZONES.items():
    y = z["y0"]
    for title, ids in z["subs"]:
        ids = ids.split()
        heads.append(dict(x=z["x0"], y=y, text=title))
        by = y + 70
        for i in range(0, len(ids), z["wrap"]):
            line = ids[i:i + z["wrap"]]; mh = 0
            for j, k in enumerate(line):
                if k not in live or len(live[k]) != 1:
                    problems.append(f"{k}: 현행 보드 {len(live.get(k, []))}장"); continue
                b = live[k][0]; used.add(k); mh = max(mh, b["h"])
                moves.append(dict(key=k, x=z["x0"] + j * z["pitch"], y=by, ox=b["x"], oy=b["y"]))
            by += mh + 110
        y = by + 20
    z["end"] = y
# 빠진 보드 검사 — 옮겨야 하는 옛 줄에 있던 보드는 모두 분류돼 있어야 한다
for b in boards:
    if ARCH(b["name"]):
        continue
    old_row = b["y"] in (13100, 21504, 22576, 23700, 24828) or (b["y"] == 14492 and b["x"] >= 2640)
    if old_row and key(b["name"]) not in used:
        problems.append(f"분류 안 됨: {b['name'][:30]} ({b['x']},{b['y']})")
print("이동", len(moves), "· 소제목", len(heads), "· 문제", problems)
for zname, z in ZONES.items(): print(zname, "끝 y =", z["end"])
json.dump(dict(moves=moves, heads=heads, XI=XI, XO=XO, XW=XW, ends={k: v["end"] for k, v in ZONES.items()}), open(f"{S}/relayout/plan.json", "w"), ensure_ascii=False)
