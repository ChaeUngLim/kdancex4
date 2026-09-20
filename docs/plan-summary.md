# kdance 기획 정리

- 작성일: 2026-09-14
- 목적: `docs/` 아래 흩어진 기획 자료(정책 문서·개발 가이드·화면 명세·인프라 가이드·입점 피치)를 하나로 종합. 개별 원문은 그대로 두고, 이 문서는 요약·상호 참조용.
- 원문 출처: `docs/pricing-policy.md`, `docs/distribution-policy.md`, `docs/genre-taxonomy-policy.md`, `docs/admin-input-policy.md`, `docs/payment-method-policy.md`, `docs/social-dance-app-dev-guide.html`, `docs/kdance-screens-spec.html`, `docs/kdance-beta-infra.html`, `docs/social-dance-academy-pitch.html`, `docs/superpowers/specs/2026-09-13-kdance-scaffold-design.md`

## 1. 프로젝트 개요 / 비전

소셜댄스(댄스스포츠·아르헨티나 탱고·스윙댄스·살사·바차타) 장르를 묶어, 검색·추천·경로안내로 회원을 학원까지 데려오고, 학원이 스케줄을 등록하면 바로 예약·결제까지 열리는 예약·멤버십 앱. (출처: `social-dance-app-dev-guide.html`)

핵심 문구: "학원이 관리자 콘솔에서 스케줄을 직접 등록하면 바로 예약·결제까지 열리는 것"이 앱의 핵심. 검색·추천은 "회원을 학원까지 데려오는" 절반, 관리자 등록→게시 흐름은 "학원이 등록하면 바로 열리게 만드는" 나머지 절반. (출처: `social-dance-app-dev-guide.html`)

개발 주체는 개인 개발자 1인, 목표는 "베타 → 안정화 → 스토어 정식 출시". (출처: `social-dance-app-dev-guide.html`)

**앱 가칭/도메인 (2026-09-14 확정):** "k-dancex4". 기존 제품명 "K-DanceX3"(Android 패키지 `com.kdancex3`)와의 관계(대체 vs 병행)는 아직 명시적으로 정리되지 않아 `distribution-policy.md`에 두 이름을 병기해 뒀다.

## 2. 타겟 유저

| 역할 | 설명 | 핵심 화면/기능 | 출처 |
|---|---|---|---|
| 회원(수강생) | 소셜댄스를 배우려는 일반 사용자. 대학생 세그먼트는 별도 요금제 대상 | 회원가입, 검색, 학원 상세, 결제, 캘린더, 길찾기, 뉴스피드, 공지, 마이/구독 | `kdance-screens-spec.html` |
| 학원 관리자(원장) | 스케줄 등록·정산을 담당하는 스튜디오 운영자. 모바일이 아닌 데스크톱 웹 콘솔 사용자 | 스케줄 입력, 미리보기, 정산 대시보드, 공지 작성 | `social-dance-app-dev-guide.html`, `kdance-screens-spec.html` |

관리자(학원) 화면은 의도적으로 모바일 앱에 넣지 않는다 — 여러 필드 입력·표 비교 작업은 데스크톱이 편해서 관리자 콘솔은 같은 백엔드를 보는 별도 웹(React+Next.js)으로 분리한다. (출처: `social-dance-app-dev-guide.html`, 2026-09-14 Android 단일 확정에 따라 Apple 심사 관련 근거는 제거)

## 3. 핵심 가치 제안 / 문제 정의

`social-dance-academy-pitch.html`(입점 설명회 자료)이 제시하는 학원 측 문제 3가지:

- 신규 문의의 67%가 검색에서 발생하지만, 블로그·SNS로는 장르별 취향을 걸러진 잠재고객을 찾기 어려움
- 수업의 1/5이 노쇼·지각 — 예약 확인·알람을 원장이 수동으로 처리
- 월 6시간을 현금/계좌이체/카드가 섞인 결제 내역 수기 정산에 소요

앱이 제시하는 해결: 검색·추천으로 신규 유입, 결제 즉시 캘린더 등록 + 자동 알람으로 노쇼 감소, 정산 대시보드로 수기 장부 제거. (출처: `social-dance-academy-pitch.html`)

## 4. 비즈니스 모델 요약

### 4.1 결제·수수료 구조

- 일반 결제 수수료: 학원 부담 8%, 92% 학원 지급 (출처: `social-dance-app-dev-guide.html`, `social-dance-academy-pitch.html`)
- 베타서비스 입점 학원: 첫 6개월 수수료 전액 면제, 7개월차부터 정상 청구 (출처: `kdance-screens-spec.html`, `social-dance-academy-pitch.html`)
- 정산 주기: 결제일로부터 매월 5일 (출처: `kdance-screens-spec.html`)

### 4.2 대학생 3개월 요금제

1개월차 무료 → 2개월차 반값 → 3개월차부터 정상가. 차액은 **학원(업주)이 부담**(2026-09-13 확정, `pricing-policy.md`). 정산은 실제 결제액 기준 — 1개월차는 정산 0원, 2개월차는 반값 결제액에서 수수료 8%를 뗀 금액 지급. 학교 이메일(.ac.kr) 인증, 1인 1회만 적용. (출처: `pricing-policy.md`, `social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)

### 4.3 월 구독 1+1 수강권

구독 결제 중인 회원에게 분기마다(연 4회) 쿠폰 1장 지급. 기존 수업 결제 1건 이상에 포함해서만 사용 가능(단독 무료 수강 불가), 같은 수준·비슷한 장르 수업 1개 추가 무료. 비용은 학원 부담(좌석 무료 제공), 결제된 1건에는 정상 수수료 8% 적용. 미사용 쿠폰은 분기 종료 시 소멸, 양도 불가. 기기당이 아니라 **사람당 1회/분기** 기준(전화번호 본인인증 기반)으로 부정사용 방지. (출처: `pricing-policy.md`, `social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)

### 4.4 쿠폰/할인 차액 부담 원칙 (확정 정책)

쿠폰/할인 프로모션으로 발생하는 차액은 플랫폼이 아니라 업주가 부담한다. 상세 정산 로직(쿠폰 종류별 부담 비율, 정산 주기 등)은 추후 논의 필요라고 명시됨. (출처: `pricing-policy.md`)

### 4.5 결제대행(PG) 구조

"학원 대신 결제를 받고 수수료를 뗀 나머지를 보내는" 하위 가맹점 정산 분배 구조. PG 선정 기준은 **하위 가맹점 정산 분배**와 **정기결제(빌링키)** 둘 다 지원 여부. 후보: 포트원(아임포트), 토스페이먼츠. 전자금융거래법 관련 신고·등록 대상 가능성, 통신판매중개자 지위 고지 필요 — 법률 자문 아님, 실제 진행 전 PG사·세무사 확인 필요. (출처: `social-dance-app-dev-guide.html`)

**로드맵상 결제 구조는 단계적으로 바뀐다**: MVP 단계는 정산 분배 없이 학원이 직접 PG 가맹점을 갖는 단순 구조로 시작하고, PG 하위가맹점 계약과 컴플라이언스 검토가 끝난 뒤(로드맵 4단계)에만 정산 분배형 결제로 전환한다. (출처: `social-dance-app-dev-guide.html`)

### 4.6 결제수단 및 결제 확인 알림 (확정, 2026-09-14)

단건 예약 결제는 **가상계좌(무통장입금)**를 기본 결제수단으로 하고, 카드는 정기결제(구독)에만 사용한다 — 가상계좌는 카드망이 아닌 은행 간 입금통보망을 쓰기 때문에 수수료가 건당 정액이라 강습료 기준 실질 수수료율이 카드보다 낮다. 가상계좌는 결제가 즉시 승인되지 않으므로 입금 대기 동안 슬롯을 Redis 락으로 잠갔다가 입금 확인 시 확정한다. 결제 확인 알림은 SMS가 아니라 Expo Push 기반 앱 내 팝업으로 구매자·학원 관리자 양쪽에 발송한다 — **무료 API 우선 원칙**에 따른 결정. (출처: `payment-method-policy.md`)

## 5. 앱 배포 정책

Google Play 개발자 등록(최초 1회 $25) 대신 **갤럭시 스토어(Galaxy Store)로 배포** — 등록비 무료. Google 로그인(OAuth) 설정은 배포 채널과 무관하게 별도로 필요(SHA-1 지문 작업은 그대로 필요). 갤럭시 스토어는 Samsung 기기 전용이라 도달 범위가 좁을 수 있음. 갤럭시 스토어 자체 심사 기준·인앱결제 정책이 Google Play와 달라 결제 연동 방식 재검토 필요. Samsung Developer 계정 생성·앱 서명 절차는 추후 확인 필요. **배포 플랫폼은 Android 단일이며 iOS는 대상이 아니다** (2026-09-14 확정). (출처: `distribution-policy.md`)

> **해결됨(2026-09-14)**: `social-dance-app-dev-guide.html`에 있던 iOS 로드맵(양쪽 스토어 제출, Apple Developer Program 연 $99, TestFlight)은 이 정책과 상충되어 Android 단일 기준으로 수정 완료. 상세는 `distribution-policy.md` 참고.

## 6. 장르 카테고리 정책 (확정)

기존 5개 장르(댄스스포츠·아르헨티나 탱고·스윙댄스·살사·바차타) 중 **살사와 바차타를 통합**하여 4종으로 확정: ① 댄스스포츠 ② 아르헨티나 탱고 ③ 스윙댄스 ④ 살사/바차타. 데이터 모델(장르 enum, `ClassSchedule.genre` 등)은 로드맵 2단계(검색·추천) 착수 시점부터 4종 기준으로 설계한다. UI 토큰(장르별 accent color)도 4종에 맞게 실제 화면 구현 단계에서 재확정한다. (출처: `genre-taxonomy-policy.md`, 2026-09-13 확정)

**단, 이미 배포된 입점 설명회 피치(`social-dance-academy-pitch.html`, `소셜댄스_입점설명회.pptx`)와 개발 가이드(`social-dance-app-dev-guide.html`)는 이 결정에서 의도적으로 수정하지 않음** — 학원 대상으로 이미 쓰인 자료라 별도 요청 시에만 갱신. 즉 이 문서들과 화면 명세서(`kdance-screens-spec.html`)에 등장하는 5장르 표기는 **의도된 과거 스냅샷**이며 오류가 아니다. (출처: `genre-taxonomy-policy.md`)

## 7. 핵심 기능 / 화면 구성 요약 (12화면, `kdance-screens-spec.html` 기준)

| # | 화면 | 우선순위 | 비고 |
|---|---|---|---|
| 01 | 회원가입·대학생 인증 | MVP | |
| 02 | 홈 — 카테고리 검색 | 2단계 | pgvector 유사도 기반 |
| 03 | 학원 상세 | MVP | |
| 04 | 체크아웃·결제 | MVP | 할인·쿠폰 순차 차감 표시 |
| 05 | 캘린더·알람 | 2단계 | expo-notifications + APScheduler |
| 06 | 길찾기 | 3단계 | 카카오 Local API |
| 07 | 뉴스피드(파티·공연·대회) | 2단계 | 전 학원 통합 노출 |
| 08 | 학원 공지 | 2단계 | 텍스트 직접 작성 |
| 09 | 마이·구독 관리 | 4단계 | 구독·쿠폰 D-day 표시 |
| 10 | 관리자·스케줄 입력 | MVP | 포스터 업로드 → OCR 자동추출 (`admin-input-policy.md` 확정, 2026-09-14) |
| 11 | 관리자·미리보기 | MVP | 게시 전 필수 검토 단계 |
| 12 | 관리자·정산 대시보드 | MVP(기본)/4단계(쿠폰표기) | |

**MVP는 6개 화면(01·03·04·10·11·12)** — "업로드→검토→게시→예약→결제→정산" 한 바퀴가 실제로 도는지가 앱 전체의 전제 조건이기 때문. (출처: `social-dance-app-dev-guide.html`)

같은 입력 폼을 콘텐츠 3종(수업 스케줄/파티·공연·대회/공지)이 공유하고, 예약 연결 여부(`bookable: bool`)만 다르게 처리하는 설계 방향이 제시됨 — 수업과 같은 테이블을 쓸지 별도 `Event` 모델을 둘지는 구현 단계(SCH 단위 착수 시)에서 확정. (출처: `social-dance-app-dev-guide.html`)

## 8. 기술 스택 / 인프라 개요

### 8.1 확정 스택 (현재 코드베이스에 반영됨, `CLAUDE.md` 기준)

- 백엔드: FastAPI + SQLAlchemy2 + Alembic + psycopg3 (uv, Python 3.12)
- 관리자 웹: React + Next.js + TS
- 모바일: Expo SDK 57 + React Native + TS
- DB: PostgreSQL 18 + pgvector, 로컬 컨테이너 `kdance-db`(포트 5433)
- Redis: 로컬 컨테이너 `kdance-redis`(포트 6380) — 스케줄러 잡큐, 쿠폰 중복방지 락 용도로 예정, 아직 미사용

### 8.2 개발 가이드가 추가로 제시하는 신규 스택 (아직 코드베이스에 미반영, `social-dance-app-dev-guide.html`)

- 백엔드: PG 클라이언트(포트원/토스페이먼츠), APScheduler(정산 배치·알람), 카카오 Local API, 오브젝트 스토리지(S3 호환 — 베타 인프라 가이드는 MinIO 우선 권장)
- 모바일: expo-notifications, react-native-calendars, react-native-maps, react-native-webview
- 배포 도구: Fastlane(신규)

### 8.3 베타 규모 인프라 갭 (`kdance-beta-infra.html`)

노트북 개발환경(1인) 기준 스택이 1만~10만 MAU 베타로 갈 때 그대로 못 쓰는 지점:

- API 서버·DB: 노트북 로컬 → 클라우드 VPS 2~4대 + 관리형 DB(백업·복제) 필수 전환
- 채팅 AI(Qwen3.5 9B, Ollama): 8GB VRAM 노트북 GPU로는 동시 처리 1~4건 수준 — 가장 먼저 막히는 병목. 3가지 대응 옵션 제시(저가 GPU 클라우드/사용량 제한+대기열/LLM 호출 범위 축소), **B+C 우선 적용 후 A는 반응 보고 결정**을 권장
- 예상 월 고정비: GPU 서버 없이 시작 시 ₩0~5만원, GPU 서버 추가 시 ₩40만~60만원 (PG 거래수수료 별도, ±50% 오차 감안)

> 채팅 AI(Qwen3.5 9B/Ollama) 자체는 개발 가이드·베타 인프라 가이드에서 "채택됨"으로 다뤄지지만, 이 챗봇 기능이 12개 화면 명세·요구사항 어디에도 명시적 기능 요구사항으로 나타나지 않는다 — 화면 12개 범위 밖의 별도 기능으로 추정되며 확인 필요 (`requirements-analysis.md` 오픈 이슈 참고).

## 9. 로드맵 (5단계, `social-dance-app-dev-guide.html`)

1. **MVP** — 관리자 스케줄 입력 + 예약·결제, 단일 학원(화면 01·03·04·10·11·12). 결제는 정산 분배 없는 단순 구조로 시작. 완료 기준: 실제 스케줄 1건 입력→미리보기→게시→예약→결제 1회 성공
2. **검색 플래너 + 캘린더·알람·피드·공지**(화면 02·05·07·08). pgvector 기반 추천 시작. 완료 기준: 알람 실기기 수신 확인
3. **경로 내비게이션 지도**(화면 06). 완료 기준: 실기기 도보·대중교통 경로 표시 확인
4. **정산 분배형 결제 + 구독·쿠폰 전환**(화면 09, 12 쿠폰 표기). 선행 조건: PG 하위가맹점 계약 완료 + 컴플라이언스 확인
5. **베타테스트 → 스토어 정식 출시**. 갤럭시 스토어 베타 트랙(또는 사내 테스트) → strix 보안 점검(Critical 0건) → 갤럭시 스토어 정식 제출

현재 코드베이스 상태(2026-09-14 기준, 커밋 로그): 로드맵 착수 전 "뼈대(스캐폴딩)" 단계만 완료 — infra(docker-compose), backend `/health`, admin-web·mobile 헬스체크 화면, Alembic 스켈레톤(모델 없음). 실제 도메인 로직(인증·예약·결제 등)은 코드에 아직 없음. (출처: `superpowers/plans/2026-09-13-kdance-scaffold.md`, git log)

## 10. 확정된 의사결정 vs 오픈 이슈

### 확정됨

- 쿠폰/할인 차액은 업주 부담 (`pricing-policy.md`)
- 갤럭시 스토어 배포 채널 채택, **Android 단일(iOS 제외)** (`distribution-policy.md`, 2026-09-14 iOS 범위 확정)
- 관리자 스케줄 등록은 **포스터 업로드 → OCR 자동추출 → 검토 → 게시** 방식 (`admin-input-policy.md`, 2026-09-14 확정)
- 단건 예약 결제는 가상계좌 우선(구독은 카드만), 결제 확인은 SMS 대신 앱 내 푸시 알림 (`payment-method-policy.md`, 2026-09-14 확정)
- 장르 4종 통합(살사/바차타) (`genre-taxonomy-policy.md`)
- 대학생 3개월 램프·분기 1+1 쿠폰 구조, 일반 수수료 8%, 베타 6개월 수수료 면제 (`social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)
- 기술 스택(백엔드/관리자웹/모바일/DB) 및 뼈대 스캐폴딩 (`CLAUDE.md`, 커밋 로그)
- MVP 범위 = 화면 01·03·04·10·11·12, 정산 분배 없는 단순 결제로 시작 (`social-dance-app-dev-guide.html`)

### 오픈 이슈 / 미정 (문서에 "추후 확인 필요"로 명시된 것)

- 쿠폰 종류별 부담 비율, 정산 주기 상세 로직 (`pricing-policy.md`)
- Google 로그인(OAuth) 설정 진행 상황, Samsung Developer 계정·앱 서명 절차 (`distribution-policy.md`)
- 관리자 콘솔에서 수업/파티/공지 데이터 모델을 하나로 합칠지 분리할지(`bookable: bool` 플래그 vs 별도 `Event` 모델) — SCH 단위 착수 시 결정 (`social-dance-app-dev-guide.html`)
- PG사 선정(포트원 vs 토스페이먼츠), 전자금융거래법 관련 신고·등록 필요 여부 — 법률·세무 자문 필요 (`social-dance-app-dev-guide.html`)
- 오브젝트 스토리지 최종 선택(MinIO 셀프호스팅 vs Cloudflare R2) — 디스크 용량 실측 후 결정 (`kdance-beta-infra.html`)
- AI 챗봇 서빙 방식(옵션 A/B/C 중 실제 채택안) — "베타 반응 보고 결정"으로 유보 (`kdance-beta-infra.html`)

### 문서 간 상충 → 해결됨 (2026-09-14)

- **배포 플랫폼 범위**: Android 단일로 확정 (`distribution-policy.md`). `social-dance-app-dev-guide.html`의 iOS 로드맵 서술은 수정 완료.
- **관리자 업로드 방식**: 포스터 업로드 → OCR 자동추출 → 검토 방식으로 확정 (`admin-input-policy.md` 신규 작성). `social-dance-app-dev-guide.html`의 수동 입력 서술은 수정 완료.

## 11. 아키텍처 심화 메모 (2026-09-14, 외부 자료 검토 반영)

사용자가 외부에서 받은 아키텍처 조언을 검토한 결과, **기존 결정과 충돌 없이 대부분 그대로 부합**한다. 새로 확인·추가할 점만 기록한다.

### 11.1 Harness/ECC 역할 분리 — 이미 구현됨, 외부 조언과 일치

외부 조언: "ECC = 개발 능력과 규칙, Harness = Agent 조직으로 잡는 게 편하다." → 이 프로젝트가 이미 그 구조다: `kdance-dev-harness`(오케스트레이션, `.claude/skills/`)가 9단계 흐름을 잡고, ECC(everything-claude-code) 플러그인의 에이전트·스킬이 각 단계의 실행 규칙/능력을 제공한다. 추가 조치 불필요 — 기존 CLAUDE.md "하네스" 섹션 참고.

### 11.2 Background Worker — APScheduler 잡 목록 구체화

8.2절의 APScheduler 항목을 아래 5개 구체 잡으로 확정한다(실제 구현은 로드맵 2단계 이후, 캘린더·알람 화면과 함께 착수):
- 수업 시작 1일 전 알림
- 수업 시작 2시간 전 알림
- 결제 완료 알림 (PG 웹훅 트리거, 즉시 발송 — 스케줄 아님)
- 환불 완료/실패 알림 (즉시 발송)
- 학원(업주) 입금 확인 알림

### 11.3 관리자 업로드 — `course-pdf-image-extractor` 스킬 제안 (TODO, 미착수)

`admin-input-policy.md`의 OCR 자동추출 흐름(이미지→OCR/Vision→구조화 추출→Pydantic 검증→DB)을 실제 Claude Code 스킬로 만들 때의 이름 후보: **`course-pdf-image-extractor`**. 핵심 요구사항은 **HITL(Human-in-the-loop) 필수** — OCR이 수업료를 220,000원으로 잘못 읽고 실제는 200,000원인 경우처럼, 가격·정원 등 "되돌리기 어려운 필드"는 AI가 자동 게시하지 않고 반드시 관리자 확인을 거친다(`admin-input-policy.md`와 이미 일치하는 원칙). 이번 대화 범위 밖 — 로드맵 1단계(MVP, 관리자 스케줄 입력) 착수 시 별도로 만든다.

### 11.4 AI Agent 챗봇 아키텍처 — §9 오픈 이슈 구체화

기존 §9 "AI 챗봇 서빙 방식... 베타 반응 보고 결정으로 유보"에 아키텍처 초안을 추가한다: 사용자 → AI Chat Agent → Intent 분석(수업검색/학원검색/대회검색/파티검색/예약/내일정/비용조회) → Tool Calling → PostgreSQL/Search/RAG. 아직 미착수, 채택 여부도 미정 — 화면 12개 요구사항에 명시적으로 없다는 기존 지적은 유효하다.

### 11.5 ⚠️ 가드레일 — Postgres MCP는 개발 전용, 운영 AI Agent에 직결 금지

**중요, 반드시 지킬 것:** 이 세션에서 Claude Code가 쓰는 `postgres-kdance` MCP(개발자가 DB를 직접 조회하기 위한 도구)는 **개발 보조용**이다. 향후 AI Agent 챗봇(11.4)을 실제로 구현할 때, 그 챗봇이 Postgres MCP를 Tool로 직접 호출하게 만들면 안 된다.

- **운영 서비스 경로:** `AI Agent → Backend Tool → Service Layer → Repository → PostgreSQL` (인증·권한·검증이 서비스 계층에서 강제됨)
- **개발 중 Claude Code 경로:** `Claude Code → Postgres MCP` (사람이 감독하는 세션에서만, 프로덕션 트래픽과 무관)

이 둘을 분리하는 이유: MCP는 세션 보안·요청량 제한·비즈니스 규칙 검증이 없어 운영 트래픽에 직접 노출하면 안 된다. 챗봇 기능을 실제로 만들 때(착수 여부 자체가 미정) 이 원칙을 지킬 것.

### 11.6 최종 아키텍처 트리 (참고용, 기존 스택과 동일)

```
Claude Code
 ├─ ECC (개발 능력/규칙)         ┐
 └─ Harness (Agent Team)        ┘→ 전문 개발 Agent
       ├─ Frontend: React Native/Expo
       ├─ Backend: FastAPI → SQLAlchemy2
       └─ AI: AI Agent → RAG (11.4, 미착수)
            └─ PostgreSQL 18 + pgvector
                 ├─ 예약/결제 → PG API
                 ├─ 일정/알림 → FCM/APNs(Expo Push로 대체됨 — Android 단일이라 FCM 경로 하나)
                 └─ 비용/정산 → 관리자(웹)
```

기존 CLAUDE.md 스택과 100% 일치 — 새 기술 도입 없음.
