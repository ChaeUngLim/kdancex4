# -*- coding: utf-8 -*-
"""_workspace/SCH_kdance.html 생성기.

쓰는 법: SCH 상태·문구가 바뀌면 아래 데이터(S0·S1·DONE·WAVES·DECISIONS·MEASURED)를 고치고
 를 돌린다. 카드·목록 표·웨이브 칩이 한 데이터에서 나와 서로
어긋나지 않는다. HTML 을 손으로 고치면 다음 생성 때 사라지므로 반드시 여기서 고친다.
표준 라이브러리만 쓴다(설치 없음).
"""
import html as H, os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'SCH_kdance.html')
BASIS = '2026-09-29'

S0 = [
 dict(n=21, name='FastAPI→Next.js 전환', track='기반', st='todo', badge='대기',
  t='Next.js + Prisma 8 스키마 계약, 기존 7테이블 이관',
  flow=['FastAPI 7테이블', 'Prisma 8 스키마 계약', '마이그레이션 적용', 'DB 통합 테스트', 'backend/ 삭제(승인 뒤)'],
  why='스키마 원본을 Prisma 계약 하나로 두는 일이 모든 것의 바닥이다.',
  d='폐기 코드(24시간 규칙·비율표·<code>refund_policy_tiers</code>)는 옮기지 않는다. <code>Order(주문)</code>에 수업료·예매 수수료·합계 CHECK 와 주문 시점 수수료율을 처음부터 넣는다. Temporal 폴리필 주입 위치를 정한다. 완료 기준에 Prisma 마이그레이션 적용과 DB 통합 테스트를 포함한다(옛 SCH-11·12 를 흡수). 이관이 끝나면 사용자 승인 뒤 <code>backend/</code>를 지운다.',
  pre='—', block='Q4~Q8(전환 세부) · R2(Prisma 8 트랜잭션·행 잠금 미검증)',
  done='Prisma 마이그레이션이 실제 DB 에 적용되고 기존 DB 통합 테스트 27개가 새 스택에서 통과한다.'),
 dict(n=22, name='에이전트 서버 뼈대', track='기반', st='todo', badge='대기',
  t='Python FastAPI + LangGraph, 스트림 한 바퀴',
  flow=['질문', 'Next.js Route Handler', '에이전트 서버(Python)', 'kdance-llm', 'SSE 자체 이벤트', 'Next.js 번역', '화면'],
  why='DB 에 닿지 않아 SCH-21 과 병렬로 갈 수 있다.',
  d='ADR-004(에이전트 서버는 Python)·ADR-005(자체 스트림, 번역은 Next.js)를 끝에서 끝까지 1회 통과시킨다. DB 에 닿지 않아 SCH-21 과 병렬. 실측 RAM 136MB·VRAM 0(뼈대 기준).',
  pre='—', block='—',
  done='질문 하나가 Python 서버를 거쳐 화면에 글자 단위로 흘러 들어온다.'),
 dict(n=23, name='품질 게이트 훅', track='기반', st='todo', badge='대기',
  t='lint 수리 → format·lint·typecheck·test 훅',
  flow=['lint 수리(FlatCompat 순환 참조)', 'format 훅', 'lint 훅', 'typecheck 훅', 'test 훅', '코드가 바뀔 때 자동 실행'],
  why='훅은 lint 를 고친 뒤 건다. 거꾸로 하면 정상 작업까지 매번 막힌다.',
  d='지금 품질 게이트 훅이 0개다. admin-web <code>npm run lint</code>의 <code>FlatCompat</code> 순환 참조를 먼저 고치고 훅을 건다.',
  pre='—', block='—',
  done='파일을 고치면 네 검사가 자동으로 돌고 실패하면 작업이 멈춘다.'),
 dict(n=24, name='인증·역할', track='기반', st='todo', badge='대기',
  t='Better Auth(Kysely 경로) · 소셜 로그인 · 역할별 범위',
  flow=['소셜 로그인(카카오·구글·네이버)', '휴대폰 본인확인(CI)', '역할 부여(회원·강사·업주·운영자)', '역할별 데이터 범위'],
  why='역할별 데이터 범위가 이후 모든 조회의 전제다.',
  d='FR-001(소셜 로그인)~FR-011(강사·업주 계정 승인), FR-020(장르 4종)~FR-029(경험 수준 구간). 지금은 <code>X-User-Id</code> 헤더로 신원을 주장한다. FR-005(역할별 데이터 범위)가 이후 모든 조회의 전제다. 나이·성별·연락처는 필수 수집(Q4(개인정보 수집 방식) 2026-09-29 확정), 만 14세 미만은 보호자 계정의 자녀(FR-009a(보호자 계정 자녀 등록)).',
  pre='SCH-21', block='본인확인 기관 · 소셜 로그인 3사 키',
  done='네 역할로 로그인해 각자 허용된 데이터만 조회된다.'),
 dict(n=25, name='학원 입점·약관 동의', track='거래 흐름', st='todo', badge='대기',
  t='입점 심사 · 등록 형태 · 환불 규정·공지 양식 · 약관 동의 기록',
  flow=['사업자 정보·정산 계좌', '등록 형태·증빙', '환불 규정·공지 양식', '약관 동의 기록', '입점 승인', '수업 게시 가능'],
  why='환불 규정을 등록하지 않은 학원은 수업을 게시할 수 없다.',
  d='FR-070(학원 정보 등록)~FR-072(강의실 중복 배정 거부), FR-085(학원 등록 형태·증빙)~FR-088(등록 형태 표시), FR-099(환불 규정 등록·표시)~FR-099b(공지 자동 입력), FR-240(통신판매중개자 고지)~FR-259(입점 약관 변경 통지). 이벤트형 처리 기간은 3영업일을 넘길 수 없다. 규정 없는 학원은 게시할 수 없다.',
  pre='SCH-24', block='Q11(환불 방식 변경의 뒤처리) ①③④',
  done='업주가 입점 절차를 끝내면 학원 안내 화면에 등록 형태와 환불 규정이 보인다.'),
 dict(n=26, name='수업·회차 등록', track='거래 흐름', st='todo', badge='대기',
  t='강사 수업 등록 · 회차 · 환불 마감일 필수',
  flow=['강사가 수업 등록', '회차·일정', '환불 마감일(이벤트형 필수)', '레벨 구간', '공개'],
  why='공급이 없으면 검색·예약은 빈 화면이다.',
  d='FR-050(강사 수업 등록)~FR-060(대타 요청), FR-065(회차 휴강·폐강 선택), FR-099d(환불 마감일 필수 입력·결제 적용). 이벤트·원데이·파티·공연·대회는 마감일이 비면 등록도 결제도 안 된다. 레벨 구간은 2026-09-29 확정 — 입문 0~6개월 · 초급 6개월~2년 · 중급 2~4년 · 고급 4년 초과(Q7(경험 수준 구간) ①).',
  pre='SCH-25', block='—',
  done='마감일이 빈 이벤트형 수업은 등록이 막히고 등록된 수업이 검색에 나온다.'),
 dict(n=27, name='검색·필터', track='거래 흐름', st='todo', badge='대기',
  t='조건 필터 검색 · 정렬 5종',
  flow=['조건 입력(날짜·지역·장르·레벨)', '정렬 5종(추천·검색·인기·마감·잔여석)', '결과 목록'],
  why='수업만 있으면 된다. SCH-28 과 병렬.',
  d='FR-030(수업 검색)~FR-036(입문자 입문 수업), FR-036a(검색 결과 정렬 5종 — 인기는 최근 7일 합산, 2026-09-29). 지도 API 가 정해지기 전에는 이동 범위 탐색을 뺀다.',
  pre='SCH-26', block='—',
  done='다섯 정렬이 각각 다른 순서를 내고 업주·강사 행동은 인기에 세지 않는다.'),
 dict(n=28, name='예약·정원·대기', track='거래 흐름', st='todo', badge='대기',
  t='남·여 정원 · 슬롯 락 · 대기 순번',
  flow=['수업 선택', '남·여 자리 선택(본인 성별 기본)', '슬롯 락', '예약 확정', '정원 초과면 대기 순번'],
  why='수업만 있으면 된다. SCH-27 과 병렬.',
  d='FR-090(정원·신청 인원 표시)~FR-097(먼저 입금 건 확정), FR-104a(사전 불참 표시)~FR-109(회차 옮기기). FR-093(대기 신청·순번)은 구독 전용이라 S0 에서는 기본 대기만 켠다.',
  pre='SCH-26', block='—',
  done='마지막 한 자리에 두 명이 동시에 신청해도 한 명만 확정된다.'),
 dict(n=29, name='PG 결제', track='돈', st='block', badge='PG 대기',
  t='PG 단일 경로 · 예매 수수료 · 수수료 안분 · 판매자별 영수증',
  flow=['결제 화면(수업료 + 예매 수수료 2,000원)', 'PG 결제', '금액 대조', '정산 분배(학원 몫 / 플랫폼 몫)', '영수증 2장'],
  why='매출이 생기는 유일한 경로. PG 계약 전에는 가짜 어댑터로.',
  d='FR-110(PG 단일 결제 경로)~FR-117(체크아웃 가격 내역), FR-280(결제수단 결정)~FR-299(결제 정보 보안), FR-282a(예매 수수료 2,000원)~FR-282c(판매자별 영수증·정산 분배), FR-114(결제 확인 앱 알림), FR-138(영수증·현금영수증). PG 계약 전에는 가짜 어댑터로 만든다.',
  pre='SCH-28', block='PG 미선정',
  done='요청 금액·PG 응답 금액·저장 금액이 일치하는 결제만 예약을 확정한다.'),
 dict(n=30, name='출석·수강 완료', track='거래 흐름', st='todo', badge='대기',
  t='출석 기록 · 분쟁 근거',
  flow=['출석 체크', '출석 기록', '수강 완료', '정산의 근거'],
  why='출석이 정산의 근거라 첫 거래부터 원장과 함께 남긴다.',
  d='FR-104(출석 기록), FR-135b(출석은 분쟁 근거), FR-166(오프라인 출석 확인). 출석은 정산의 근거라 첫 거래부터 남긴다.',
  pre='SCH-28', block='—',
  done='회차마다 누가 왔는지 남고 기간이 끝나면 수강 완료로 바뀐다.'),
 dict(n=31, name='정산 원장', track='돈', st='block', badge='PG 대기',
  t='학원 정산 원장 · 3단계 전이 · 보류 · 상계',
  flow=['결제·환불·수수료 사건', '원장에 추가만', '보류 → 예정 → 완료', '지급(이벤트형: 환불 마감일 뒤 / 정규형: 매월 5일)', '상계'],
  why='출석과 함께 첫 거래부터 남긴다.',
  d='FR-124(플랫폼 수수료 5%·1년 면제)~FR-125e(취소 수수료 5:5·판매 수수료 5%), FR-252(정산 보류), FR-253(정산 상계), <code>AcademyLedgerEntry(학원 정산 원장)</code>. 지급 시점(2026-09-29 확정): 이벤트형은 환불 마감일 다음 날(FR-282e(이벤트형 환불 마감 뒤 즉시 지급), 신규 개인·동호회 주최자는 첫 2번 행사 30% 보관), 정규·단기 과정과 개인 레슨은 수업 기간이 끝난 몫을 매월 5일(FR-282d(정산 분배로 학원 직접 지급)). S0 은 원장과 상태 전이만, 정산 화면은 SCH-40.',
  pre='SCH-29 · SCH-30', block='PG 미선정',
  done='원장 합계가 PG 분배 결과와 매일 맞아떨어진다.'),
 dict(n=32, name='정규 과정 환불', track='돈', st='todo', badge='대기',
  t='문의 → 업주가 금액 입력 → 업주가 PG 환불 실행',
  flow=['회원 문의', '업주가 학원 규정대로 금액 입력', '업주가 PG 환불 실행', '원장 반영'],
  why='환불은 결제와 원장이 있어야 되돌릴 수 있다.',
  d='FR-098(업주 처리 환불 방식), FR-293(업주 환불 입력)~FR-295(수단별 환불 실행). 기존 실행부(잠금·멱등키·감사 로그·PG 어댑터)를 재사용한다.',
  pre='SCH-29 · SCH-31', block='Q11(환불 방식 변경의 뒤처리) ③④',
  done='같은 환불 요청을 두 번 눌러도 한 번만 실행된다.'),
 dict(n=33, name='이벤트형 취소', track='돈', st='block', badge='달력 대기',
  t='예약 상세 취소 → 시스템 계산 → 업주 실행 · 3영업일 뒤 자동 실행',
  flow=['회원이 예약 상세에서 취소 신청', '시스템이 계산(취소 규정 표·환불 마감일)', '업주 실행(올리기만)', '3영업일 안 미실행이면 자동 실행'],
  why='행사 일괄 취소(SCH-34)가 이 위에 선다.',
  d='FR-098(업주 처리 환불 방식) 예외, FR-099a(환불·취소 공지 양식) 처리 기간 상한, FR-099c(이벤트·원데이·파티·공연·대회 취소 규정). 업주는 환불액을 올리기만 하고 거절할 수 없다. 5:5 배분은 실제로 남은 금액으로 계산한다.',
  pre='SCH-29 · SCH-31', block='공휴일 달력 출처',
  done='마감일 전 취소는 표대로 계산되고 마감일 뒤에는 취소 버튼이 사라진다.'),
 dict(n=34, name='행사 일괄 취소', track='돈', st='todo', badge='대기',
  t='업주가 사유 골라 확정 → 결제자 전원 PG 일괄 환불',
  flow=['업주가 사유 선택(불가항력 / 업주 사정)', '확정', '결제자 전원 PG 일괄 환불(예매 수수료 포함)', '실패 건 재시도 목록', '이미 지급한 돈은 상계·반환 청구'],
  why='이벤트형 취소(SCH-33)의 계산·실행부를 그대로 쓴다.',
  d='FR-099e(행사 일괄 취소). 연기 선택지는 없다. 예매 수수료까지 전액 돌려주고, 그 2,000원 몫의 PG 수수료만 사유에 따라 플랫폼 또는 업주가 낸다. 학원 계좌 직접 송금은 막는다.',
  pre='SCH-33', block='—',
  done='한 번 확정으로 결제자 전원이 환불되고 실패 건은 사유와 함께 목록에 남는다.'),
 dict(n=35, name='문의·사람 이관', track='AI · 문의', st='todo', badge='대기',
  t='T0(내 데이터 조회) · T3(사람) — 출시 게이트',
  flow=['질문', '4등급 분류(T0~T3)', 'T0: 내 데이터 조회 답변', 'T3: 업주에게 이관', '문의 이력 보관'],
  why='T0·T3 는 출시 게이트다.',
  d='FR-200(질문 4등급 분류)~FR-232(문의 이력 보관). 사람에게 가는 문의는 업주에게만 간다. 운영자는 FR-204(운영자 역할 한정) 범위만.',
  pre='SCH-24 · SCH-29', block='—',
  done='"내 예약 언제야" 는 즉시 답하고 환불 요청은 업주 화면에 도착한다.'),
 dict(n=36, name='AI 동시 질문', track='AI · 문의', st='todo', badge='대기',
  t='T2 판단형 동시 10건 · 고정 평가 세트',
  flow=['판단형 질문 10건 동시', '에이전트 서버', 'kdance-llm 10슬롯', '고정 평가 세트로 채점', 'S0 수용량 판정'],
  why='T2 는 평가 세트가 있어야 판정할 수 있다.',
  d='FR-260(판단형 동시 10건)~FR-279(심층 추론 기본 금지), FR-276(고정 평가 세트). SC-040~SC-048(S0 수용량)이 S0 통과 조건이다. 시험 데이터로 먼저 켜고, 실사용자에게는 게시 데이터가 쌓인 S1 에 연다.',
  pre='SCH-22 · SCH-35', block='평가 세트 없음',
  done='동시 10명 답 완료 p95 가 목표 안이고 비한국어 답·없는 사실 주장이 0건이다.'),
 dict(n=37, name='S0 정합성 E2E', track='QA', st='todo', badge='대기',
  t='결제·출석·수강 완료·정산·취소·환불 각 1건',
  flow=['Playwright 시나리오', '결제 1건', '출석 1건', '수강 완료 1건', '정산 1건', '취소·환불 1건', 'S0 판정'],
  why='S0 통과 조건을 판정한다.',
  d='SC-005 이후 정합성 지표와 SC-040~SC-048(S0 수용량)을 Playwright 로 판정한다. 통과하면 S1(파일럿)으로 넘어간다. 외부 공개 전에 법률 검토 묶음을 닫는다.',
  pre='W1~W9 전부', block='법률 검토 묶음(외부 공개 전)',
  done='여섯 시나리오가 실제 브라우저에서 전부 통과한다.'),
]

S1 = [
 (38,'알림','US4(일정 충돌·알림), FR-140(수업 전 알림 시점)~FR-146(광고성 알림 동의)',['사건 발생','알림 규칙','Push 발송','동의 확인'],'SCH-28 · Push 발송 수단 미정'),
 (39,'포스터 읽기','US3(포스터 등록·공간 충돌), FR-073(포스터 자동 추출)~FR-077(업로드 양식 재사용)',['포스터 업로드','비전 모델이 읽음','수업 정보 자동 채움','강사 검토'],'SCH-26·SCH-22 · 자동 추출 정확도 목표 미정'),
 (40,'정산 화면·강사 지급','US9(수강 완료분 정산), FR-127(강사 프리랜서)~FR-135e(강사 정산 내역)',['정산 원장','업주·강사 화면','강사 전용 계좌 지급'],'SCH-31 · 원천징수·개인 레슨 수수료율'),
 (41,'대학생 혜택','US5(대학생 혜택), FR-006(대학생 이메일 인증)~FR-008(학교 이메일 미보관), FR-118(대학생 첫 결제 50%)~FR-118b(대학생 할인 업주 부담)',['.ac.kr 이메일 인증','첫 결제 50%','차액은 업주 부담','남용 감시'],'SCH-24·SCH-29'),
 (42,'쿠폰·구독','FR-112(구독 결제수단)·FR-113(정기결제 재시도), FR-119(쿠폰·할인 차액 업주 부담)~FR-123(쿠폰 양도 금지), FR-297(구독 해지)·FR-297a(구독 환불 14일 이내), FR-121d(1+1 참여 학원 실시간 수업 검색 순위)~FR-121h(1+1 참여학원 목록)',['구독 결제(카드·간편결제·계좌)','1+1 쿠폰 발급','참여 학원 순위판','해지·환불'],'SCH-29 · Q13(구독 판매 주체·요금) 월 구독료'),
 (43,'홍보 이미지·소개 문구','FR-061(수업 소개 문구 생성)·FR-061a(홍보 이미지 생성 조건), FR-258(AI 생성 표시)',['강사가 문장 입력','이미지 생성(하루 3회)','앱이 글자 얹음','강사 검토·게시'],'SCH-26·SCH-22 · FLUX.1-dev·SDXL 라이선스 · 장당 실제 차감액 실측(월 약 80장은 미검증)'),
 (44,'AI 검색·추천','US6(AI 근거 추천), FR-037(자연어 조건 분해)~FR-043(선택 이력 학습)',['자연어 질문','조건 분해','임베딩 검색','리랭커','근거 달린 추천'],'SCH-27·SCH-36 · 임베딩·리랭커 호스팅 약관'),
 (45,'파티·공연·대회 피드','US8(파티·공연·대회 연결), FR-150(파티·공연·대회 피드)~FR-157(공연 출연자)',['주최자 등록(학원 / 승인받은 개인·동호회)','통합 피드','참가 신청·결제','외부 예매 링크'],'SCH-26·SCH-33 · 개인·동호회 승인 기준·사업자등록 조건 미정'),
 (46,'레벨·강사 대시보드·후기','US7(레벨 관리·개강 인원), FR-160(레벨 0~10 부여)~FR-168(연령대 표시), FR-062(빈 강의실 수업 제안)~FR-064(강사 대시보드 집계), FR-175(수강·참여 이력)~FR-178(단체 신청)',['강사가 레벨 0~10 부여','수강 이력','대시보드 집계','후기'],'SCH-30 · Q7(경험 수준 구간) ② 점수 레벨과의 관계'),
 (47,'관리자 정산 콘솔','US13(관리자 결산·수수료), FR-300(역할별 로그인 분기)~FR-319(기준 시각·월 마감)',['관리자 로그인(2단계 인증)','원장 대사','월 마감','장르별 결산'],'SCH-31 · FR-303(관리자 2단계 인증)'),
 (48,'운영자 시스템 관리','US10(운영자 시스템 관리), FR-185(조작 감사 기록)~FR-190(데이터 삭제 요청), FR-254(이용 제한 절차)',['운영자 조작','감사 기록','이용 제한 절차','삭제 요청 처리'],'SCH-24'),
 (49,'부하 시험','S3 통과 조건 — 동시 신청·규모 부하 시험',['부하 시나리오','동시 신청 시험','규모 부하','S3 판정'],'S2 통과 뒤'),
]

DONE = [
 (1,'기반 배선','models/base, env.py, config, db','done','완료',['설정(.env)','DB 연결','의존성 주입'],'',True),
 (2,'도메인 모델','7개 + 초기 마이그레이션','done','완료',['테이블 7종 정의','Alembic 마이그레이션','SQL 생성'],'실제 DB 적용은 검증하지 못했다(오프라인 SQL 생성까지만). SCH-21 이 Prisma 마이그레이션으로 다시 검증한다.',True),
 (3,'환불액 산정','24시간 경계·비율표 계산 순수 함수','review','완료 · 옮기지 않음',['취소 시각','24시간 경계·비율표','환불액'],'2026-09-25 환불이 업주 결정 방식으로 바뀌어 폐기가 확정됐다(Q11(환불 방식 변경의 뒤처리) ②). 이벤트형의 새 계산(SCH-33)은 이 코드가 아니라 FR-099c 표를 따른다.',True),
 (4,'어댑터 3종','PG/알림/슬롯락','done','완료',['인터페이스(약속)','가짜 구현(개발용)','진짜 구현(나중에 교체)'],'',True),
 (5,'취소 오케스트레이션','잠금·멱등키·감사 로그','done','완료',['잠금','멱등키 검사','환불 실행','감사 로그'],'실행부는 SCH-32·SCH-33 에서 재사용한다. 회원이 누르면 곧바로 환불하던 흐름은 쓰지 않는다.',True),
 (6,'스키마·라우터','Pydantic 스키마 + 라우터 + main.py','done','완료',['요청 형태','라우터(API 경로)','응답 형태'],'',True),
 (7,'통합 테스트 작성','conftest + DB 통합 테스트','done','완료',['테스트 DB 기동','시나리오 실행','186 passed'],'2026-09-23 DB 를 켜고 186 passed 를 확인했다. 09-26·09-29 는 Docker Desktop 이 꺼져 있어 27개가 skip 이다.',True),
 (8,'admin-web 환불 비율표','비율표 설정 화면·API','review','완료 · 옮기지 않음',['비율표 화면','저장 API'],'비율표 자체를 쓰지 않는다(Q11(환불 방식 변경의 뒤처리) ②). 대신 업주 환불 처리 화면(SCH-32·SCH-33)과 행사 일괄 취소 화면(SCH-34)을 만든다.',False),
 (9,'mobile 취소·환불계좌','데모 화면','review','완료 · 데모',['취소 버튼','환불 계좌 입력'],'회원이 누르면 곧바로 환불하던 옛 흐름의 데모다. 새 흐름(정규는 문의, 이벤트형은 예약 상세 취소 신청)으로 다시 만든다.',False),
 (10,'환불 정책 문서','payment-method-policy.md','done','완료',['결제수단 정책','환불 정책 문서'],'문서는 2026-09-25·26 결정으로 갱신했고, 옛 절에는 대체 표시가 달려 있다.',False),
]

WAVES = [
 ('W1',[21,22,23],'바닥 공사 — 스키마·에이전트 뼈대·훅','—'),
 ('W2',[24],'누가 무엇을 보나','SCH-21'),
 ('W3',[25],'학원이 들어온다','SCH-24'),
 ('W4',[26],'수업이 생긴다','SCH-25'),
 ('W5',[27,28],'찾고 예약한다','SCH-26'),
 ('W6',[29],'돈이 들어온다 (PG)','SCH-28 · PG'),
 ('W7',[30,31],'출석과 원장','SCH-28 · 29'),
 ('W8',[32,33,34],'돌려준다','SCH-29 · 31'),
 ('W9',[35,36],'묻고 답한다','SCH-22 · 24 · 29'),
 ('W10',[37],'S0 판정','W1~W9'),
]
SHORT = {21:'전환',22:'에이전트',23:'훅',24:'인증',25:'입점',26:'수업',27:'검색',28:'예약',29:'결제',30:'출석',31:'원장',32:'정규 환불',33:'이벤트 취소',34:'일괄 취소',35:'문의',36:'AI 동시',37:'E2E'}

DECISIONS = [
 ('외부 · PG 미선정','block','결제대행사를 고른다 — 정산 분배 · 판매자별 영수증 · 구독 결제수단 전부 · 지정일 지급이 조건',
  '예매 수수료가 붙은 결제는 판매자가 둘(학원·회사)이다. FR-282c(판매자별 영수증·정산 분배)가 정산 분배(지급대행) 지원 PG 를 우선하라고 정했다. 2026-09-29 추가 조건 — ① 구독 결제수단 전부: 카드 정기결제(빌링키)·계좌 자동이체·일반 계좌이체·가상계좌·간편결제 일반 결제(FR-112(구독 결제수단)). 간편결제 정기결제는 PG 가 지원하는 것만 쓴다 — 토스페이먼츠 공식 문서 기준 네이버페이·토스페이만 되고(별도 심사) 카카오페이는 안 된다. ② 결제분을 보관했다가 정한 날 지급하는 기능(FR-282e(이벤트형 환불 마감 뒤 즉시 지급)). 포트원의 결제수단별 지원 범위는 공식 문서로 확인하지 못했다.',
  'SCH-29 · SCH-31 · SCH-33 · SCH-34 · SCH-42'),
 ('SCH-21 · Q4~Q8','block','전환 세부 다섯 가지 — <code>/api</code> 접두어 · 인증 포함 · Redis 슬롯 락 · DB 테스트 전략 · 가짜 결제 원장',
  'Q1~Q3(기존 backend 처리 · SCH-01~07 가이드 · 병행 운영)는 2026-09-20 에 닫혔다. 남은 다섯은 Phase 3(구현 계획) 결과를 보고 닫기로 했다.',
  'SCH-21 Phase 4(Task 분리)'),
 ('외부 · 본인확인','open','휴대폰 본인확인 기관',
  '1인 1계정·미성년자 확인(FR-003(본인확인 계정 식별))이 여기에 걸린다. 소셜 로그인 3사 키도 필요하다. Q4(개인정보 수집 방식)는 2026-09-29 에 닫혔다 — 나이·성별·연락처는 필수다.',
  'SCH-24'),
 ('Q11 · ①③④','open','Q11(환불 방식 변경의 뒤처리) — 법정 하한 · 업주 응답 기한 · 폐업·무응답 때 경로',
  '정규 과정 환불은 업주가 정한다. 그 규정의 법정 하한과, 업주가 답하지 않을 때의 경로가 아직 없다.',
  'SCH-25 · SCH-32'),
 ('데이터 · 공휴일 달력','open','영업일 계산에 쓸 공휴일 달력 출처',
  '이벤트형 취소의 처리 기간 상한(3영업일)과 자동 실행 시점이 토·일·공휴일을 뺀 날로 계산된다.',
  'SCH-33'),
 ('법률 검토 묶음','block','출시 전 변호사 검토 — 약관 · 취소 규정 · 예매 수수료 · 3영업일 · 결제 흐름',
  'FR-099c(이벤트·원데이·파티·공연·대회 취소 규정) 두 항목, FR-099d(환불 마감일 필수 입력·결제 적용), FR-282a(예매 수수료 2,000원), 3영업일 상한의 적용 범위, 5:5 배분, FR-121d(1+1 참여 학원 실시간 수업 검색 순위)의 순위 기준 공개·광고 표시 의무, 개인·동호회 파티 주최자(FR-155(주최자 표시))의 통신판매업 신고 대상 여부. 구현은 막지 않지만 출시는 막는다.',
  'SCH-37 (S0 판정 → 외부 공개)'),
]

MEASURED = [
 ('backend pytest','159 passed · 27 skipped','<code>uv run pytest -q</code>(09-29 재실행). skip 27개는 <code>requires_db</code> — DB 가 없으면 전부 skip 된다'),
 ('DB 통합 테스트','2026-09-23: 186 passed','09-26·09-29 모두 Docker Desktop 이 꺼져 WSL 에서 <code>docker</code> 명령을 찾지 못했다(직접 확인 불가)'),
 ('admin-web build','성공 · 라우트 <code>/</code> · <code>/refund-policy</code>','<code>npm run build</code>(09-29 재실행). <code>/refund-policy</code>는 SCH-08 코드로 옮기지 않는다'),
 ('admin-web 의존성','prisma 8 RC · better-auth 설치, 스키마·사용 코드 없음','<code>package.json</code>. <code>@langchain/*</code>·AI SDK 도 설치만 돼 있다(사용처 없음 — 추정)'),
 ('admin-web lint','깨짐','<code>eslint.config.mjs</code>의 <code>FlatCompat</code> 순환 참조. SCH-23 의 첫 일'),
 ('mobile tsc','통과','<code>npx tsc --noEmit</code>(09-29 재실행, exit 0). 화면은 데모 <code>App.tsx</code> 하나'),
 ('에이전트 서버','코드 없음','저장소 전체에 LangGraph 를 쓰는 <code>.py</code> 0건(09-29 재확인). SCH-22 가 처음 만든다'),
 ('AI 생성 서버','동시 10명 첫 글자 p95 약 9초 (2026-09-23)','<code>infra/ai-bench/bench_pipeline.py</code>. <code>kdance-llm</code>(llama-server, 11436)'),
 ('코드 변경','09-26 이후 0건','<code>git log --since=2026-09-26 -- backend admin-web mobile infra</code>. 바뀐 것은 spec·약관의 결정뿐'),
]

REFS = [
 ('요구사항','US·FR·SC·규모 단계·미해결 질문의 원본','<code>specs/001-ai-dance-class-platform/spec.md</code>'),
 ('기술 스택','버전 고정표 · 알려진 위험 · 백엔드 교체 · 엔티티','<code>docs/kdancex4_service_definition_and_tech_stack.md</code>'),
 ('결정 기록','ADR-001~005','<code>CLAUDE-decisions.md</code>'),
 ('SCH-21 조사','전환 요구사항·코드 조사(Phase 1·2), Q1~Q8','<code>_workspace/01_req-analyst_requirements.md</code> · <code>02_code-searcher_structure.md</code>'),
 ('1회차 슬라이스','SCH-01~10 의 계획·태스크 원본','커밋 <code>7f28ab1^</code> 의 <code>_workspace/03_*</code>·<code>04_*</code>'),
 ('약관','회원·입점 약관(현행)과 조문별 근거 보관본','<code>docs/terms-of-service.md</code> · <code>docs/merchant-terms.md</code> · <code>docs/archive/terms-2026-09-25/</code>'),
 ('진행 리뷰','날짜별 판단과 막힌 것','<code>docs/Review.md</code>'),
]

def mini(steps, cls=''):
    return '<div class="mini %s">%s</div>' % (cls, ''.join('<span>%s</span>' % H.escape(s) for s in steps))

def sch_label(n, name): return 'SCH-%02d(%s)' % (n, name)

def card(x):
    blk = 'blk' if x['block'] != '—' else ''
    return f'''
        <article class="card s-{x['st']}" id="sch-{x['n']}">
          <div class="head"><span class="sch">{sch_label(x['n'],x['name'])}</span><span class="badge">{x['badge']}</span><span class="tr">{x['track']}</span></div>
          <p class="t">{x['t']}</p>
          <div class="lbl">핵심 그림 — 이 조각이 끝나면 이렇게 흐른다</div>
          {mini(x['flow'])}
          <div class="grid2">
            <div><div class="lbl">왜 이 자리인가</div><p>{x['why']}</p></div>
            <div><div class="lbl">완료 기준</div><p>{x['done']}</p></div>
          </div>
          <div class="lbl">범위와 규칙</div>
          <p class="d">{x['d']}</p>
          <div class="meta"><span>선행 <b>{x['pre']}</b></span><span>막는 것 <b class="{blk}">{x['block']}</b></span></div>
        </article>'''

def s1_card(n,name,scope,flow,pre):
    return f'''
        <article class="card s-todo compact" id="sch-{n}">
          <div class="head"><span class="sch">{sch_label(n,name)}</span><span class="badge">S1 이후</span></div>
          {mini(flow,'small')}
          <p class="d">{scope}</p>
          <div class="meta"><span>선행 · 막는 것 <b>{pre}</b></span></div>
        </article>'''

def done_card(n,name,t,st,badge,flow,d,guide):
    g = f'<a class="guide-link" href="guides/{sch_label(n,name)}.html">가이드 보기 →</a>' if guide else ''
    dd = f'<p class="d">{d}</p>' if d else ''
    return f'''
        <article class="card s-{st} compact" id="sch-{n}">
          <div class="head"><span class="sch">{sch_label(n,name)}</span><span class="badge">{badge}</span></div>
          <p class="t">{t}</p>
          {mini(flow,'small')}
          {dd}{g}
        </article>'''

def status_word(st): return {'done':'완료','review':'완료 · 옮기지 않음','todo':'대기','block':'외부 결정에 막힘','wip':'진행 중'}[st]

def list_rows():
    rows=[]
    for n,name,t,st,badge,flow,d,guide in DONE: rows.append((n,name,'완료 기록',st,'—','—'))
    for x in S0: rows.append((x['n'],x['name'],x['track'],x['st'],x['pre'],x['block']))
    for n,name,scope,flow,pre in S1: rows.append((n,name,'S1 이후','todo',pre,'—'))
    return '\n'.join(f'<tr class="r-{st}"><td class="k"><a href="#sch-{n}">{sch_label(n,name)}</a></td><td>{track}</td><td><span class="dot d-{st}"></span>{status_word(st)}</td><td>{pre}</td><td>{block}</td></tr>' for n,name,track,st,pre,block in rows)

def waves():
    cols=[]
    for w,ns,label,pre in WAVES:
        chips=''.join(f'<a class="chip s-{next(x for x in S0 if x["n"]==n)["st"]}" href="#sch-{n}"><b>SCH-{n}</b>{SHORT[n]}</a>' for n in ns)
        cols.append(f'<div class="wave"><div class="wn">{w}</div><div class="chips">{chips}</div><div class="wd">{label}</div><div class="wp">선행 {pre}</div></div>')
    return '<div class="waves">'+'<div class="warrow">→</div>'.join(cols)+'</div>'

def tracks(items):
    groups={}
    for x in items: groups.setdefault(x['track'],[]).append(x)
    sub={'기반':'스택 전환 · 인증 · 품질 게이트 · 에이전트 서버','거래 흐름':'입점 → 수업 → 검색 → 예약 → 출석','돈':'결제 · 정산 원장 · 환불 · 행사 취소','AI · 문의':'Triage · 동시 질문 · 평가 세트','QA':'S0 판정'}
    ids={'기반':'track-base','거래 흐름':'track-flow','돈':'track-money','AI · 문의':'track-ai','QA':'track-qa'}
    return '\n'.join(f'<h3 class="trh" id="{ids[tr]}">{tr} <span>{sub[tr]}</span></h3>'+''.join(card(x) for x in groups[tr]) for tr in ['기반','거래 흐름','돈','AI · 문의','QA'])

CSS = r'''
:root{--paper:#f7f9fc;--card:#fff;--ink:#0d1b2a;--ink-2:#2b3d52;--ink-3:#5a6b80;--rule:#d9e0ec;--rule-2:#edf1f7;--navy:#1c2340;
--todo:#2d6cdf;--wip:#e8a33d;--review:#7a5af8;--done:#2f9e44;--block:#d64545;
--todo-bg:#e8f0fe;--wip-bg:#fdf3e2;--review-bg:#efeafe;--done-bg:#e7f6ec;--block-bg:#fceaea;--acc:#0e7c86;--acc-bg:#e3f4f5}
@media (prefers-color-scheme:dark){:root{--paper:#0c1219;--card:#141c26;--ink:#eef3f9;--ink-2:#c3cedc;--ink-3:#8c9aac;--rule:#25313f;--rule-2:#1b2532;--navy:#c6d0e4;
--todo:#7fa8f5;--wip:#f0be6a;--review:#a88cff;--done:#5fc97a;--block:#f08080;--todo-bg:#16233a;--wip-bg:#30240f;--review-bg:#241b3d;--done-bg:#12301c;--block-bg:#341617;--acc:#5fc4cc;--acc-bg:#0f2a2d}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink-2);font:15px/1.7 'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
code{font-family:'D2Coding','SFMono-Regular',Menlo,monospace;font-size:.88em;background:var(--rule-2);padding:1px 5px;border-radius:3px;color:var(--ink)}
h1,h2,h3{color:var(--ink);margin:0}a{color:var(--todo)}
.layout{max-width:1280px;margin:0 auto;padding:32px 20px 80px;display:grid;grid-template-columns:1fr;gap:28px}
@media (min-width:1100px){.layout{grid-template-columns:230px minmax(0,1fr)}}
nav.toc{font-size:13px;align-self:start}
@media (min-width:1100px){nav.toc{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto}}
nav.toc .tt{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
nav.toc ol{list-style:none;margin:0 0 14px;padding:0}nav.toc li{margin:0 0 4px}nav.toc a{text-decoration:none;color:var(--ink-2)}nav.toc a:hover{color:var(--todo)}
nav.toc .sub{padding-left:12px;font-size:12px;color:var(--ink-3)}
header{border-bottom:3px solid var(--navy);padding-bottom:22px}
.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--ink-3);text-transform:uppercase}
h1{font-size:clamp(26px,4.5vw,38px);letter-spacing:-.02em;line-height:1.15;margin:8px 0 10px}
.lede{max-width:74ch;margin:0}
.stamp{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:16px;font-size:12.5px;color:var(--ink-3)}.stamp b{color:var(--ink);font-weight:600}
section{margin-top:48px;scroll-margin-top:16px}h2{font-size:clamp(19px,2.8vw,24px);letter-spacing:-.015em}
.sub{color:var(--ink-3);font-size:13.5px;margin:6px 0 0;max-width:78ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:22px}
.tile{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:14px 16px}
.tile .n{font-size:26px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}.tile .k{font-size:12.5px;color:var(--ink-3)}.tile .s{font-size:11.5px;color:var(--ink-3);margin-top:6px;padding-top:6px;border-top:1px solid var(--rule-2)}
.howto{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:18px}
.how{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:14px 16px;font-size:13.5px}.how b{display:block;color:var(--ink);margin-bottom:4px}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;font-size:12.5px;color:var(--ink-3)}.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.sys{margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.box{background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:12px 14px;font-size:13px}
.box b{display:block;color:var(--ink);font-size:14px}.box .who{font-size:11.5px;color:var(--acc);letter-spacing:.06em}.box .x{color:var(--ink-3);margin-top:4px;font-size:12.5px}
.box.core{border-color:var(--navy);border-width:2px}.box.ext{border-style:dashed}
.sysnote{font-size:12.5px;color:var(--ink-3);margin-top:8px}
.loop{margin-top:16px;overflow-x:auto}
.loop .row{display:flex;align-items:stretch;min-width:900px;gap:0}
.step{flex:1;background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:10px 10px;text-align:center;font-size:13px;position:relative;margin-right:22px}
.step:last-child{margin-right:0}.step::after{content:'→';position:absolute;right:-19px;top:50%;transform:translateY(-50%);color:var(--ink-3);font-weight:700}
.step:last-child::after{content:''}.step b{display:block;color:var(--ink)}.step small{display:block;color:var(--todo);font-weight:600;margin-top:4px}
.band{display:flex;gap:10px;min-width:900px;margin-top:10px}.band .step{margin-right:0}.band .step::after{content:''}.band .step.base{background:var(--rule-2)}
.bandlbl{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:14px 0 4px}
.waves{display:flex;align-items:stretch;gap:0;margin-top:16px;overflow-x:auto;padding-bottom:6px}
.wave{min-width:150px;flex:1;background:var(--card);border:1px solid var(--rule);border-radius:6px;padding:10px}
.warrow{align-self:center;padding:0 6px;color:var(--ink-3);font-weight:700}
.wn{font-size:11px;letter-spacing:.12em;color:var(--ink-3);font-weight:700}.chips{display:flex;flex-direction:column;gap:5px;margin:6px 0}
.chip{display:block;text-decoration:none;font-size:12px;padding:4px 8px;border-radius:4px;border-left:3px solid var(--rule);background:var(--paper);color:var(--ink)}
.chip b{display:block;font-size:11.5px}.chip.s-todo{border-left-color:var(--todo)}.chip.s-block{border-left-color:var(--block);background:var(--block-bg)}.chip.s-done{border-left-color:var(--done)}.chip.s-wip{border-left-color:var(--wip)}
.wd{font-size:12.5px;color:var(--ink);margin-top:4px}.wp{font-size:11px;color:var(--ink-3)}
.scroller{overflow-x:auto;margin-top:16px}table.grid{border-collapse:collapse;width:100%;min-width:720px;font-size:13.5px}
table.grid th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding:0 12px 8px 0;border-bottom:2px solid var(--navy);white-space:nowrap}
table.grid td{padding:8px 12px 8px 0;border-bottom:1px solid var(--rule-2);vertical-align:top}table.grid td.k{color:var(--ink);font-weight:500;white-space:nowrap}table.grid td.k a{text-decoration:none;color:var(--ink)}table.grid td.k a:hover{color:var(--todo)}
table.grid tbody tr:hover td{background:var(--rule-2)}
.dot{display:inline-block;width:9px;height:9px;border-radius:99px;margin-right:6px;vertical-align:-1px}.d-done{background:var(--done)}.d-review{background:var(--review)}.d-todo{background:var(--todo)}.d-block{background:var(--block)}.d-wip{background:var(--wip)}
.trh{font-size:15px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--rule);display:flex;justify-content:space-between;align-items:baseline;gap:10px;scroll-margin-top:16px}.trh span{font-size:11.5px;font-weight:500;color:var(--ink-3)}
.card{background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--rule);border-radius:4px;padding:14px 16px;margin-bottom:12px;scroll-margin-top:16px}
.card .head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.card .sch{font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.card .tr{font-size:11.5px;color:var(--ink-3);margin-left:auto}
.badge{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:99px;white-space:nowrap}
.card .t{margin:4px 0 8px;color:var(--ink);font-size:14px}.card p{margin:0;font-size:13px}.card .d{color:var(--ink-3);font-size:12.5px;line-height:1.55}
.lbl{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--acc);margin:10px 0 4px;font-weight:600}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 18px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;padding-top:8px;border-top:1px solid var(--rule-2);font-size:12px;color:var(--ink-3)}.meta b{color:var(--ink);font-weight:600}.meta b.blk{color:var(--block)}
.mini{display:flex;flex-wrap:wrap;gap:6px 0;align-items:center}
.mini span{background:var(--acc-bg);color:var(--ink);border:1px solid transparent;border-radius:4px;padding:3px 9px;font-size:12.5px;line-height:1.4}
.mini span+span::before{content:'→';color:var(--ink-3);margin:0 7px 0 1px;font-weight:700}
.mini.small span{font-size:11.5px;padding:2px 7px;background:var(--rule-2)}
.card.compact .t{margin-bottom:6px}.card.compact .d{margin-top:6px}
.s-todo{border-left-color:var(--todo)}.s-todo .badge{background:var(--todo-bg);color:var(--todo)}
.s-wip{border-left-color:var(--wip)}.s-wip .badge{background:var(--wip);color:#fff}
.s-review{border-left-color:var(--review)}.s-review .badge{background:var(--review-bg);color:var(--review)}
.s-done{border-left-color:var(--done)}.s-done .badge{background:var(--done-bg);color:var(--done)}
.s-block{border-left-color:var(--block)}.s-block .badge{background:var(--block-bg);color:var(--block)}
.guide-link{display:inline-block;margin-top:6px;font-size:11.5px;font-weight:600;text-decoration:none}
.cards2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:14px}.cards2 .card{margin:0}
.decisions{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:18px}
.dec{background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--block);border-radius:4px;padding:14px 16px}.dec.open{border-left-color:var(--todo)}
.dec .id{font-size:11.5px;font-weight:700;letter-spacing:.08em;color:var(--block)}.dec.open .id{color:var(--todo)}.dec h3{font-size:15px;margin:4px 0 6px;line-height:1.4}.dec p{margin:0;font-size:13px;color:var(--ink-3)}
.dec .blocks{display:block;margin-top:8px;padding-top:8px;border-top:1px solid var(--rule-2);font-size:12px;color:var(--ink-3)}.dec .blocks b{color:var(--block)}
ul.notes{margin:14px 0 0;padding:0;list-style:none;max-width:78ch}ul.notes li{position:relative;padding-left:20px;margin-bottom:9px;font-size:14px}ul.notes li::before{content:'▸';position:absolute;left:0;color:var(--todo);font-size:12px}ul.notes b{color:var(--ink)}
footer{margin-top:60px;padding-top:18px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--ink-3)}
@media print{body{background:#fff}nav.toc{display:none}.card,.tile,.dec,.wave{break-inside:avoid}}
'''

TOC = '''
      <nav class="toc" aria-label="목차">
        <p class="tt">목차</p>
        <ol>
          <li><a href="#howto">0. 이 문서 읽는 법</a></li>
          <li><a href="#overview">1. 한눈에 보기 — 무엇을 만드나</a></li>
          <li><a href="#now">2. 지금 어디인가</a></li>
          <li><a href="#loop">3. S0 한 바퀴 — 과정의 흐름</a></li>
          <li><a href="#waves">4. 착수 순서 W1~W10</a></li>
          <li><a href="#list">5. SCH 전체 목록</a></li>
          <li><a href="#s0">6. S0 경로 SCH-21~37 상세</a>
            <ol class="sub"><li><a href="#track-base">기반</a></li><li><a href="#track-flow">거래 흐름</a></li><li><a href="#track-money">돈</a></li><li><a href="#track-ai">AI · 문의</a></li><li><a href="#track-qa">QA</a></li></ol></li>
          <li><a href="#s1">7. S1 이후 SCH-38~49</a></li>
          <li><a href="#decisions">8. 먼저 닫아야 하는 결정</a></li>
          <li><a href="#done">9. 완료 기록 SCH-01~10</a></li>
          <li><a href="#measured">10. 실측 근거</a></li>
          <li><a href="#refs">11. 참고 자료</a></li>
          <li><a href="#rules">12. 이 문서의 규칙</a></li>
        </ol>
      </nav>'''

def build():
    s0_cnt=len(S0); s1_cnt=len(S1); done_cnt=len(DONE)
    blocked=sum(1 for x in S0 if x['st']=='block')
    dec_html=''.join(f'<div class="dec {"open" if k=="open" else ""}"><div class="id">{i}</div><h3>{h}</h3><p>{p}</p><span class="blocks">막는 것 <b>{b}</b></span></div>' for i,k,h,p,b in DECISIONS)
    page=f'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KDANCE SCH 스케줄</title>
<style>{CSS}</style>
</head>
<body>
<div class="layout">
{TOC}
<main>
      <header>
        <div class="eyebrow">개인 프로젝트 · 베타(S0) 첫 거래까지의 전체 스케줄</div>
        <h1>KDANCE SCH 스케줄</h1>
        <p class="lede">
          <b>SCH 관리는 이 문서에서만 한다.</b> 제품 요구사항의 원본은 <code>specs/001-ai-dance-class-platform/spec.md</code>이고,
          이 문서는 그 요구사항을 「무엇 다음에 무엇」 순서로 자른 작업 목록과 상태다. SCH-01~10 은 1회차 슬라이스(FastAPI
          예약 취소·환불)의 완료 기록이고, <b>SCH-21 부터가 앞으로 할 일</b>이다.
        </p>
        <div class="stamp">
          <span><b>기준</b> {BASIS}</span>
          <span><b>backend</b> 159 passed · 27 skipped (Docker Desktop 꺼짐, DB 테스트 skip)</span>
          <span><b>admin-web</b> <code>npm run build</code> 성공 · 라우트 2개</span>
          <span><b>mobile</b> <code>tsc --noEmit</code> 통과</span>
          <span><b>담당</b> 1인</span>
        </div>
      </header>

      <section id="howto">
        <h2>0. 이 문서 읽는 법</h2>
        <p class="sub">처음 읽으면 1 → 3 → 4 순서로 그림만 보고, 그다음 5 의 표에서 궁금한 조각을 눌러 6 의 카드로 간다.</p>
        <div class="howto">
          <div class="how"><b>SCH 가 무엇인가</b>기능을 세로로 얇게 썬 조각이다. "백엔드 다 만들고 → 프론트 다 만들고"가 아니라, 조각 하나가 처음부터 끝까지 동작하게 쌓아 간다. 조각마다 번호와 기능명이 붙고, 완료 기준은 그 조각의 FR(요구사항) 범위다.</div>
          <div class="how"><b>카드 한 장의 구성</b>번호(기능명) · 상태 · 한 줄 → 핵심 그림(이 조각이 끝나면 데이터가 어떻게 흐르나) → 왜 이 자리인가 · 완료 기준 → 범위와 규칙(FR 번호) → 선행과 막는 것.</div>
          <div class="how"><b>트랙과 웨이브</b>트랙은 성격별 묶음(기반·거래 흐름·돈·AI·QA)이고 웨이브(W1~W10)는 착수 순서다. 같은 웨이브 안의 조각은 서로 막지 않아 동시에 간다.</div>
          <div class="how"><b>S0 · S1 이 무엇인가</b>규모 단계다. S0 은 베타 1~10명, 노트북 한 대로 첫 거래 한 바퀴를 돌리는 단계. S1 은 파일럿·오픈 베타. S0 통과 조건에 없는 기능은 7 절에 모아 두고 S0 판정 뒤 순서를 다시 정한다.</div>
        </div>
        <div class="legend">
          <span><i style="background:var(--done)"></i>완료</span>
          <span><i style="background:var(--review)"></i>완료 · 코드 교체 예정(옮기지 않음)</span>
          <span><i style="background:var(--wip)"></i>진행 중</span>
          <span><i style="background:var(--todo)"></i>대기</span>
          <span><i style="background:var(--block)"></i>외부 결정에 막힘</span>
        </div>
      </section>

      <section id="overview">
        <h2>1. 한눈에 보기 — 무엇을 만드나</h2>
        <p class="sub">댄스 학원의 수업을 찾고, 예약하고, 결제하고, 환불받는 앱이다. 여덟 덩어리가 이렇게 이어진다. 굵은 테두리가 우리가 만드는 것, 점선이 남의 서비스다.</p>
        <div class="sys">
          <div class="box core"><span class="who">회원 · 강사</span><b>mobile (Expo · React Native)</b><div class="x">수업 검색 · 예약 · 결제 · 문의</div></div>
          <div class="box core"><span class="who">업주 · 운영자</span><b>admin-web (Next.js)</b><div class="x">입점 · 수업 등록 · 환불 처리 · 정산 조회</div></div>
          <div class="box core"><span class="who">유일한 DB 쓰기 주체</span><b>Next.js API + Prisma 8</b><div class="x">예약·결제·정산 원장. 인증은 Better Auth. SCH-21 이 FastAPI 를 여기로 옮긴다</div></div>
          <div class="box core"><span class="who">읽기 전용(MCP)</span><b>에이전트 서버 (Python · LangGraph)</b><div class="x">문의 분류 · AI 검색·추천. DB 에 직접 닿지 않는다</div></div>
          <div class="box"><span class="who">저장</span><b>PostgreSQL 18 + pgvector · Redis</b><div class="x">데이터 · 벡터 검색 · 슬롯 락</div></div>
          <div class="box"><span class="who">로컬 GPU</span><b>kdance-llm (llama-server 10슬롯)</b><div class="x">채팅·포스터 읽기. 임베딩·리랭커는 NVIDIA 호스팅</div></div>
          <div class="box ext"><span class="who">외부 · 미선정</span><b>PG(결제대행사)</b><div class="x">결제 → 정산 분배로 학원·플랫폼 계좌에 나눠 지급</div></div>
          <div class="box ext"><span class="who">외부</span><b>본인확인 기관 · 소셜 로그인 3사</b><div class="x">CI 로 한 사람 한 계정</div></div>
        </div>
        <p class="sysnote">돈의 길: 회원 → PG → (수수료는 플랫폼 계좌 / 나머지는 학원 계좌). 플랫폼은 돈을 쥐지 않고 "누구에게 얼마"만 지시한다(FR-282d(정산 분배로 학원 직접 지급)).</p>
      </section>

      <section id="now">
        <h2>2. 지금 어디인가</h2>
        <p class="sub">{BASIS} 에 코드와 문서를 실제로 조사한 값이다. 09-26 뒤로 코드는 한 줄도 바뀌지 않았고 바뀐 것은 spec·약관의 결정이다. 추정은 추정이라 적었다.</p>
        <div class="tiles">
          <div class="tile"><div class="n">{done_cnt}</div><div class="k">완료 기록 (SCH-01~10)</div><div class="s">FastAPI 취소·환불 슬라이스. SCH-21 에서 교체된다</div></div>
          <div class="tile"><div class="n">{s0_cnt}</div><div class="k">S0 경로 (SCH-21~37)</div><div class="s">베타 1~10명, 첫 거래 한 바퀴 + AI 수용량</div></div>
          <div class="tile"><div class="n">{s1_cnt}</div><div class="k">S1 이후 (SCH-38~49)</div><div class="s">파일럿·오픈 베타에서 켜는 기능</div></div>
          <div class="tile"><div class="n">0</div><div class="k">진행 중</div><div class="s">다음 착수: SCH-21 · SCH-22 · SCH-23</div></div>
          <div class="tile"><div class="n">{blocked}</div><div class="k">외부 결정에 막힘</div><div class="s">PG 미선정 2개 · 공휴일 달력 1개</div></div>
          <div class="tile"><div class="n">{len(DECISIONS)}</div><div class="k">먼저 닫을 결정</div><div class="s">PG 선정 · 전환 세부 · 본인확인 등</div></div>
          <div class="tile"><div class="n">0</div><div class="k">품질 게이트 훅</div><div class="s">lint 를 먼저 고쳐야 건다 (SCH-23)</div></div>
        </div>
      </section>

      <section id="loop">
        <h2>3. S0 한 바퀴 — 과정의 흐름</h2>
        <p class="sub">S0 의 목표는 "첫 거래 한 바퀴"다. 학원이 들어와 수업을 올리고, 회원이 찾아 예약·결제하고, 출석하고, 정산되고, 취소·환불까지 되돌아오는 길. 각 칸 아래 번호가 그 칸을 만드는 SCH 다.</p>
        <div class="loop">
          <div class="bandlbl">거래 — 왼쪽에서 오른쪽으로 한 바퀴</div>
          <div class="row">
            <div class="step"><b>입점</b>학원·약관 동의<small>SCH-25</small></div>
            <div class="step"><b>수업 등록</b>회차·환불 마감일<small>SCH-26</small></div>
            <div class="step"><b>검색</b>정렬 5종<small>SCH-27</small></div>
            <div class="step"><b>예약</b>남·여 정원·대기<small>SCH-28</small></div>
            <div class="step"><b>결제</b>PG · 예매 수수료<small>SCH-29</small></div>
            <div class="step"><b>출석</b>수강 완료<small>SCH-30</small></div>
            <div class="step"><b>정산</b>원장·지급<small>SCH-31</small></div>
            <div class="step"><b>취소·환불</b>정규 · 이벤트형 · 일괄<small>SCH-32 · 33 · 34</small></div>
          </div>
          <div class="bandlbl">그 옆에서 — 묻고 답한다 · 판정한다</div>
          <div class="band">
            <div class="step"><b>문의 분류 · 사람 이관</b><small>SCH-35</small></div>
            <div class="step"><b>AI 동시 질문 · 평가 세트</b><small>SCH-36</small></div>
            <div class="step"><b>S0 정합성 E2E 판정</b><small>SCH-37</small></div>
          </div>
          <div class="bandlbl">그 아래에서 — 전부를 받치는 바닥</div>
          <div class="band">
            <div class="step base"><b>FastAPI → Next.js 전환</b><small>SCH-21</small></div>
            <div class="step base"><b>에이전트 서버 뼈대</b><small>SCH-22</small></div>
            <div class="step base"><b>품질 게이트 훅</b><small>SCH-23</small></div>
            <div class="step base"><b>인증·역할</b><small>SCH-24</small></div>
          </div>
        </div>
      </section>

      <section id="waves">
        <h2>4. 착수 순서 W1~W10</h2>
        <p class="sub">왼쪽에서 오른쪽으로. 같은 칸(웨이브)에 있는 조각은 서로 막지 않으므로 동시에 간다. 빨간 조각은 외부 결정(PG·달력)이 먼저 닫혀야 실제 연동이 된다 — 가짜 어댑터로 먼저 만들 수는 있다.</p>
        {waves()}
      </section>

      <section id="list">
        <h2>5. SCH 전체 목록</h2>
        <p class="sub">번호를 누르면 카드로 간다. 11~20 번은 비어 있다 — SCH-11·12 는 SCH-21 에 흡수했고 SCH-13~20 은 2026-09-25 딥링크 폐지로 폐기했다.</p>
        <div class="scroller"><table class="grid">
          <thead><tr><th>SCH</th><th>트랙</th><th>상태</th><th>선행</th><th>막는 것</th></tr></thead>
          <tbody>
{list_rows()}
          </tbody></table></div>
      </section>

      <section id="s0">
        <h2>6. S0 경로 SCH-21~37 상세</h2>
        <p class="sub">혼자 하는 프로젝트라 「누가」가 아니라 <b>「무엇 다음에 무엇」</b>이 축이다. 트랙 이름은 core-rules 의 팀 단위 조직(기반·Backend·AI·Frontend·QA)을 따랐다. 각 카드의 FR 범위가 곧 완료 기준이다.</p>
        {tracks(S0)}
      </section>

      <section id="s1">
        <h2>7. S1 이후 SCH-38~49 — 파일럿·오픈 베타에서 켠다</h2>
        <p class="sub">S0 통과 조건에 들어 있지 않은 기능이다. 순서는 의존 관계를 따르고, 실제 착수 시점은 S0 판정 뒤에 다시 정한다.</p>
        <div class="cards2">
{''.join(s1_card(*r) for r in S1)}
        </div>
      </section>

      <section id="decisions">
        <h2>8. 먼저 닫아야 하는 결정</h2>
        <p class="sub">S0 경로를 실제로 막는 것만 골랐다. 전체 미해결 질문은 spec 의 Status 줄과 「미해결 질문」 표에 있다. 2026-09-29 에 Q4(개인정보 수집 방식)·Q7(경험 수준 구간) ①·Q9(파티 주최 주체)·Q10(강사 소개 영상)이 닫혔다.</p>
        <div class="decisions">
{dec_html}
        </div>
      </section>

      <section id="done">
        <h2>9. 완료 기록 — 1회차 슬라이스 SCH-01~10 (FastAPI 예약 취소·환불)</h2>
        <p class="sub">2026-09-14~15 에 끝냈다. 이 코드는 SCH-21(FastAPI→Next.js 전환)에서 교체된다. 번호는 소스 학습 주석과 가이드에 박혀 있어 그대로 둔다. 보라색은 요구사항이 바뀌어 새 스택으로 옮기지 않는 코드다.</p>
        <div class="cards2">
{''.join(done_card(*r) for r in DONE)}
        </div>
      </section>

      <section id="measured">
        <h2>10. 실측 근거 ({BASIS})</h2>
        <p class="sub">실제로 실행하거나 조회한 값. 추정은 「추정」이라 적는다.</p>
        <div class="scroller"><table class="grid">
          <thead><tr><th>무엇</th><th>값</th><th>어떻게 쟀나 · 단서</th></tr></thead>
          <tbody>{''.join(f'<tr><td class="k">{a}</td><td>{b}</td><td>{c}</td></tr>' for a,b,c in MEASURED)}</tbody></table></div>
      </section>

      <section id="refs">
        <h2>11. 참고 자료</h2>
        <div class="scroller"><table class="grid">
          <thead><tr><th>무엇</th><th>설명</th><th>원본 문서</th></tr></thead>
          <tbody>{''.join(f'<tr><td class="k">{a}</td><td>{b}</td><td>{c}</td></tr>' for a,b,c in REFS)}</tbody></table></div>
      </section>

      <section id="rules">
        <h2>12. 이 문서의 규칙</h2>
        <ul class="notes">
          <li><b>SCH 상태 관리는 이 문서에서만 한다.</b> 무엇을 만들지는 spec 이 정하고, 이 문서는 순서와 상태를 정한다. 각 SCH 의 FR 범위가 완료 기준이다.</li>
          <li><b>번호는 다시 쓰지 않는다.</b> SCH-11(마이그레이션 검증)·SCH-12(DB 통합 테스트)는 FastAPI 를 대상으로 해서 SCH-21 의 완료 기준으로 흡수했다. SCH-13~20 은 2026-09-25 딥링크 폐지로 폐기했다. 11~20 번은 비워 두고 쓰지 않는다.</li>
          <li><b>SCH 하나는 파이프라인 한 회차다.</b> 착수하면 <code>kdance-dev-harness</code> Phase 1(요구사항 분석)부터 돌고, 끝나면 Phase 9.5(학습 주석 재구성·SCH 가이드 생성)에서 가이드와 학습 주석을 만든다.</li>
          <li><b>실시간 반영.</b> 완료 보고가 들어올 때마다 해당 카드의 클래스(s-todo→s-wip→s-done)와 상단 타일·목록 표·웨이브 칩을 갱신한다.</li>
          <li><b>실측은 실측이라고 적는다.</b> 「실측 근거」의 값은 그 날짜에 실행·조회한 것이고, 미검증은 미검증이라 표시한다.</li>
          <li><b>외부 결정에 막힌 항목은 가짜로 먼저 만들 수 있다.</b> 다만 「완료」 표시는 실제 연동까지 끝났을 때만 한다.</li>
          <li><b>이 파일은 생성물이다.</b> <code>_workspace/build_sch_kdance.py</code> 의 데이터에서 목록 표(5)·웨이브(4)·카드(6·7·9)가 함께 나온다. 상태를 바꿀 때는 HTML 이 아니라 스크립트의 데이터를 고치고 다시 돌린다.</li>
        </ul>
      </section>

      <footer><p>KDANCE · 개인 프로젝트 · {BASIS} 기준<br />요구사항은 <code>specs/001-ai-dance-class-platform/spec.md</code>, 기술 스택은 <code>docs/kdancex4_service_definition_and_tech_stack.md</code>, 진행 기록은 <code>docs/Review.md</code>.</p></footer>
</main>
</div>
</body>
</html>
'''
    open(OUT,'w',encoding='utf-8').write(page)
    print('written', len(page))

if __name__=='__main__': build()
