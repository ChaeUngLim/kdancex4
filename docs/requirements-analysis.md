# kdance 요구사항 분석

- 작성일: 2026-09-14
- 근거: `docs/plan-summary.md`에 정리된 기획 문서 전체. 각 항목에 원 출처 파일을 표기해 추적 가능하게 함.
- 원칙: 문서에 명시되지 않은 내용은 "명시 안 됨, 확인 필요"로 표기하고 추측하지 않음.

## 1. 기능 요구사항 (도메인별)

### 1.1 인증 / 사용자

- FR-01: 휴대폰 본인인증 기반 회원가입 (`kdance-screens-spec.html` 화면01)
- FR-02: 가입 시 관심 장르 복수 선택 (`kdance-screens-spec.html` 화면01)
- FR-03: 학교 이메일(.ac.kr) 도메인 인증을 통한 대학생 인증, 선택 사항이며 마이페이지에서도 인증 가능 (`social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)
- FR-04: 대학생 허위 인증 확인 시 잔여 혜택 회수 및 정상가 재청구 (`kdance-screens-spec.html` 이용약관 요약)
- FR-05: `POST /auth/verify-phone`, `POST /auth/verify-student` API, `User.student_verified_at` 필드 (`social-dance-app-dev-guide.html` 화면 매핑표)
- FR-06: Google 로그인(OAuth) 지원 — Android OAuth 클라이언트 ID(SHA-1 지문) 작업 진행 중으로 언급됨, 배포 채널과 무관하게 필요 (`distribution-policy.md`)

### 1.2 학원(스튜디오) 관리

- FR-10: 학원 관리자가 포스터·전단지·스크린샷(형식 무관)을 업로드하면 OCR이 장르·요일·시간·가격·정원 필드를 자동 추출 (`admin-input-policy.md` 2026-09-14 확정, `kdance-screens-spec.html`, `social-dance-academy-pitch.html`)
- FR-11: 입력→미리보기→게시 3단계 플로우, 미리보기 단계를 건너뛰고 바로 게시하는 경로는 만들지 않음 (`social-dance-app-dev-guide.html`)
- FR-12: 게시 시 검색 인덱스(pgvector 임베딩)·예약 슬롯·결제 상품이 같은 트랜잭션으로 동시 생성 (`social-dance-app-dev-guide.html`)
- FR-13: 사업자 가입 시 정산 계좌·사업자등록증 등록 (`kdance-screens-spec.html` 사용 절차 가이드)
- FR-14: 학원 상세 페이지 — 사진·평점·시간표, 정원 대비 신청 인원 표시 (`kdance-screens-spec.html` 화면03)
- FR-15: `GET /academies`, `GET /academies/{id}`, `POST /admin/schedules`, `GET /admin/schedules/{id}/preview` API, `Academy`·`ClassSchedule` 모델 (`social-dance-app-dev-guide.html` 화면 매핑표)

### 1.3 예약 / 멤버십

- FR-20: 회원이 학원 상세에서 수업을 선택해 예약 (`kdance-screens-spec.html` 화면03·04)
- FR-21: 결제 완료 시 자동으로 캘린더에 등록, 수업 30분 전 알람 발송 (`kdance-screens-spec.html` 화면05, `social-dance-app-dev-guide.html`)
- FR-22: 수업 시작 24시간 전 취소 시 전액 환불, 24시간 이내는 학원 정책에 따름(학원 상세 페이지에 명시) (`kdance-screens-spec.html` 이용약관 요약)
- FR-23: `GET /me/schedule` API (`social-dance-app-dev-guide.html` 화면 매핑표)

### 1.4 결제 / 가격 정책

- FR-30: 체크아웃 화면에서 정가 대비 할인·쿠폰이 항목별로 순차 표시(대학생 할인, 분기 1+1 쿠폰 등) (`kdance-screens-spec.html` 화면04)
- FR-31: `POST /orders` — 정가-대학생할인-쿠폰 계산 후 PG 호출, `Order` 모델 (`social-dance-app-dev-guide.html` 화면 매핑표)
- FR-32: 대학생 3개월 램프 요금제(1개월 무료→2개월 반값→3개월부터 정상가), 차액은 학원 부담 (`pricing-policy.md`, `social-dance-app-dev-guide.html`)
- FR-33: 월 구독 결제자에게 분기 1회(연 4회) 1+1 쿠폰 자동 지급, 기존 결제 1건 이상 포함 시에만 사용 가능, 미사용 시 분기 말 소멸, 양도 불가 (`pricing-policy.md`, `social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)
- FR-34: 체크아웃 서버 검증 — "유료 수업 1건 이상 포함 여부"와 "쿠폰 대상 수업이 결제 수업과 같은 장르·비슷한 레벨인지"를 서버에서 동시 검증 (`social-dance-app-dev-guide.html`)
- FR-35: 할인·쿠폰 부정사용 방지는 기기 단위가 아니라 사람(전화번호 본인인증) 단위·분기 단위로 제한 (`social-dance-app-dev-guide.html`)
- FR-36: 정기결제(빌링키) 지원 — 매달 카드 정보 재입력 없이 자동 청구, 실패 시(카드 만료 등) 재시도 정책 필요 (`social-dance-app-dev-guide.html`)
- FR-37: `Coupon` 테이블 — 발급 시각, 유효기간(분기 말), 사용 여부, 사용된 예약 ID 보유. 쿠폰 발급은 APScheduler 배치가 구독 결제 성공 이력 기반으로 처리 (`social-dance-app-dev-guide.html`)
- FR-38: 일반 결제 수수료 학원 8% 부담, 92% 지급. 학원 정산은 매월 5일, 베타 첫 6개월 수수료 전액 면제 (`social-dance-app-dev-guide.html`, `kdance-screens-spec.html`)
- FR-39: 정산 대시보드 — 총 결제액/수수료/실지급액, 1+1 쿠폰 사용 건수(수수료 계산엔 미반영, 별도 표기), 신규 회원 수. `GET /admin/settlements` (`kdance-screens-spec.html` 화면12, `social-dance-app-dev-guide.html`)
- FR-40: MVP 단계는 학원이 직접 PG 가맹점을 갖는 단순 결제 구조, 로드맵 4단계에서 정산 분배형(하위 가맹점) 결제로 전환 (`social-dance-app-dev-guide.html`)
- FR-41: 단건 예약 결제는 가상계좌(무통장입금)를 기본 결제수단으로 제공, 월 구독(정기결제)은 카드만 지원 (`payment-method-policy.md`, 2026-09-14 확정)
- FR-42: 가상계좌 발급 시점에 해당 슬롯을 Redis 락으로 잠그고, 입금 확인 시 확정·기한 초과 시 해제. 동일 슬롯에 복수 가상계좌가 발급된 경우 먼저 입금 확인된 주문만 확정 (`payment-method-policy.md`)
- FR-43: PG 웹훅(`payment.completed`) 수신 시 구매자·학원 관리자 양쪽에 즉시 앱 내 알림(Expo Push) 발송 — SMS는 사용하지 않음 (`payment-method-policy.md`, FR-90과 연계)

### 1.5 장르 분류

- FR-50: 장르 4종(댄스스포츠·아르헨티나 탱고·스윙댄스·살사/바차타 통합) 기준으로 데이터 모델(enum, `ClassSchedule.genre`) 설계, 로드맵 2단계 착수 시점부터 적용 (`genre-taxonomy-policy.md`)
- FR-51: 장르별 UI accent color 매핑, 4종 기준으로 화면 구현 단계에서 재확정 (`genre-taxonomy-policy.md`)

### 1.6 입점 / 배포 정책

- FR-60: 앱 배포 채널은 갤럭시 스토어(Samsung Seller Portal) (`distribution-policy.md`)
- FR-61: Google 로그인(OAuth) 클라이언트 설정은 배포 채널과 무관하게 필요 (`distribution-policy.md`)
- FR-62: 갤럭시 스토어 자체 인앱결제 정책(자체 IAP 또는 Samsung IAP) 재검토 필요 (`distribution-policy.md`)

### 1.7 관리자 웹

- FR-70: 관리자 콘솔은 모바일 앱과 별도의 데스크톱 웹(React+Next.js), 같은 FastAPI 백엔드를 공유하되 배포·심사 주기 분리 (`social-dance-app-dev-guide.html`)
- FR-71: 스케줄 등록과 동일한 입력 폼을 파티/공연/대회(뉴스피드), 공지(텍스트만, `bookable` 없음) 3종 콘텐츠가 재사용, 예약 연결 여부만 분기 (`social-dance-app-dev-guide.html`)

### 1.8 모바일 앱 (소비자)

- FR-80: 홈 — 장르·지역·시간대 필터 검색, `GET /academies?genre&region&day`, 카카오 Local API + pgvector 유사도 (`kdance-screens-spec.html`, `social-dance-app-dev-guide.html`)
- FR-81: 길찾기 — 카카오 Local 경로 API 프록시, 도보/대중교통 경로 표시 (`kdance-screens-spec.html` 화면06)
- FR-82: 뉴스피드 — 전 학원 통합 파티/공연/대회 노출, `GET /events?type=party|performance|competition`, `Event(bookable: bool)` (`social-dance-app-dev-guide.html`)
- FR-83: 학원별 공지 게시판, 고정(pin) 공지 지원 (`kdance-screens-spec.html` 화면08)
- FR-84: 마이 — 구독 상태·다음 결제일, 쿠폰 소멸일(D-day) 상시 표시 (`kdance-screens-spec.html` 화면09)

### 1.9 알림

- FR-90: 로컬 알람(수업 30분 전) + 원격 푸시(예약 확정·정산 완료 등)를 expo-notifications 한 모듈로 처리 (`social-dance-app-dev-guide.html`)
- FR-91: 알람 발송 트리거는 APScheduler가 생성, Expo Push로 전달 (`social-dance-app-dev-guide.html`)
- FR-92: 결제 확인 알림은 SMS가 아니라 Expo Push 기반 앱 내 팝업으로 구현 — 무료 API 우선 원칙에 따른 결정 (`payment-method-policy.md`, 2026-09-14). 관리자 웹 쪽 실시간 알림 전달 방식(폴링/WebSocket/SSE)은 미정

## 2. 비-기능 요구사항

| 항목 | 내용 | 출처 | 상태 |
|---|---|---|---|
| 플랫폼 | Android 단일 플랫폼(iOS 제외) | `CLAUDE.md`, `distribution-policy.md` | 확정(2026-09-14) — 과거 상충은 §4.1 참고 |
| 결제 데이터 정합성 | "결제 요청 금액 = PG 응답 금액 = DB 기록 금액" 대조 체크리스트 필요 | `social-dance-app-dev-guide.html` | 명시됨(review-qa 스킬로 신규 생성 예정, 미구현) |
| 보안 | strix 보안 점검을 필수 정기 루틴으로 격상(결제·개인정보 취급 앱이므로), 스토어 출시 전 Critical 0건 통과가 완료 기준 | `social-dance-app-dev-guide.html` | 계획만 존재, 미실행 |
| 비밀정보 보호 | gitleaks로 PG 시크릿 키 커밋 유출 방지 | `social-dance-app-dev-guide.html` | 도구는 유지 항목으로 명시, 실제 설정 여부는 리포지토리에서 미확인 |
| 개인정보 | 위치정보는 저장하지 않고 요청 시점만 사용, 학교 이메일 인증 후 이메일 원문 미보관 | `kdance-screens-spec.html` 이용약관 요약 | 정책만 명시, 구현 여부는 코드 없음 |
| 확장성(트래픽) | 1만~10만 MAU 베타 기준, API 서버는 VPS 2~4대 + 로드밸런서, DB는 관리형/전용 서버로 전환 필요 | `kdance-beta-infra.html` | 계획 단계, 현재는 로컬 단일 컨테이너 |
| AI 서빙 성능 | 노트북 8GB VRAM GPU 1대로는 동시 채팅 처리 1~4건 수준 — 병목 확정, 대응 옵션(GPU 클라우드/사용량제한/LLM 호출 축소) 중 미확정 | `kdance-beta-infra.html` | 오픈 이슈 — 애초에 이 챗봇 기능 자체가 12화면 명세에 없어 범위 확인 필요(§4) |
| 오프라인 대응 | 명시 안 됨 — 확인 필요 | — | 미정 |
| 성능 목표(응답시간·동시접속 등 SLO) | 명시 안 됨 — 확인 필요 | — | 미정 |
| 접근성(a11y) | 명시 안 됨 — 확인 필요 | — | 미정 |
| 국제화/다국어 | 명시 안 됨(모든 화면·정책이 한국어·국내 서비스 전제) — 확인 필요 | — | 미정 |
| 데이터 백업/재해복구 | "베타부터는 매일 백업이 있어야 한다"는 원칙만 언급, 구체 RPO/RTO는 명시 안 됨 | `kdance-beta-infra.html` | 부분 명시, 세부 미정 |

## 3. 기획 vs 현재 코드베이스 구현 상태 갭 분석

현재 저장소(2026-09-14) 상태를 `find`로 확인한 결과, `backend/app/main.py`는 `GET /health` 하나만 존재하고 SQLAlchemy 모델·Alembic 리비전이 전무하며, `admin-web`·`mobile`도 백엔드 헬스 상태만 표시하는 placeholder 화면뿐이다. (근거: `superpowers/plans/2026-09-13-kdance-scaffold.md`, 저장소 파일 목록, git log)

| 영역 | 상태 | 비고 |
|---|---|---|
| 인프라(docker-compose, DB/Redis 컨테이너) | 구현됨 | `infra/docker-compose.yml` 존재, 뼈대 계획대로 완료 |
| 백엔드 기본 골격(FastAPI 프로젝트, `/health`) | 구현됨 | 도메인 모델 없음 |
| Alembic 마이그레이션 골격 | 구현됨(스켈레톤만) | 리비전·모델 0개 |
| admin-web 기본 골격 | 구현됨(헬스체크 placeholder만) | 로그인·스케줄 입력·정산 UI 전무 |
| mobile 기본 골격 | 구현됨(헬스체크 placeholder만) | 회원가입·검색·결제 등 화면 전무 |
| 인증(FR-01~06) | 미구현 | API·모델 없음 |
| 학원/스케줄 관리(FR-10~15) | 미구현 | `Academy`·`ClassSchedule` 모델 없음. 등록 방식은 OCR 자동추출로 확정(§4.2) — OCR 파이프라인 자체는 미착수 |
| 예약/멤버십(FR-20~23) | 미구현 | |
| 결제/가격정책(FR-30~40) | 미구현 | PG 연동 자체가 미착수, 정산 분배 구조는 로드맵 4단계라 더 먼 단계 |
| 장르 4종 데이터 모델(FR-50~51) | 미구현 | 정책 문서로만 확정, enum 코드 없음 |
| 배포 채널 설정(FR-60~62) | 미구현 | Samsung Developer 계정 생성 여부 등 확인 필요 상태로 문서에 남아있음 |
| 관리자 웹 실기능(FR-70~71) | 미구현 | 현재는 헬스체크 문자열만 표시 |
| 모바일 검색/길찾기/피드/공지/마이(FR-80~84) | 미구현 | |
| 알림(FR-90~91) | 미구현 | expo-notifications 미설치 |
| CI/CD, Fastlane, git 초기화 | 범위 밖으로 명시 제외 | 뼈대 스펙에서 의도적으로 제외됨(`superpowers/specs/2026-09-13-kdance-scaffold-design.md`) |

**요약**: 로드맵 5단계 중 어느 것도 아직 시작되지 않았고, 현재는 로드맵 착수 전 "뼈대(인프라+헬스체크)" 단계만 완료된 상태다. MVP 6화면(01·03·04·10·11·12) 중 구현된 것은 0개.

## 4. 모호하거나 상충되는 요구사항 / 추가 확인 필요 질문

### 4.1 해결됨(2026-09-14) — 배포 대상 플랫폼 (Android 단일 vs iOS+Android)

- `CLAUDE.md`: "dance studio booking/membership app (**Android**)", Android 패키지명만 존재
- `distribution-policy.md`: Android 전용 스토어인 갤럭시 스토어 채택, iOS 언급 전혀 없음
- `social-dance-app-dev-guide.html`(수정 전): React Native 0.86을 "한 코드로 **iOS·Android** 두 플랫폼"으로 명시, Apple Developer Program(연 $99) 비용을 스토어 등록 비용 항목에 포함, 로드맵 5단계에서 "TestFlight·Play 내부테스트"와 "**양쪽 스토어**에 제출"을 명시

→ **결정**: Android 단일(갤럭시 스토어)로 확정, iOS는 배포 대상이 아니다. `distribution-policy.md`에 명문화했고, `social-dance-app-dev-guide.html`의 iOS 로드맵 서술은 Android 단일 기준으로 수정 완료(2026-09-14).

### 4.2 해결됨(2026-09-14) — 관리자 스케줄 등록 방식 (수동 입력 폼 vs OCR 자동 추출)

- `social-dance-app-dev-guide.html`(수정 전): "무료·오픈 API만 쓴다는 원칙 때문에 이미지·PDF 자동 인식 파이프라인은 두지 않는다"고 명시적으로 결정, 관리자가 장르·요일·시간·가격·정원을 직접 입력하는 폼 방식으로 화면 10(관리자·스케줄 입력)을 설계
- `kdance-screens-spec.html`(화면10 "포스터 업로드", 화면11 "추출 결과 검토 ★")와 `social-dance-academy-pitch.html`(슬라이드06 "업로드 한 장이면 나머지는 저희가 합니다"): 포스터/PDF를 업로드하면 자동으로 장르·시간·가격이 추출되고, 신뢰도 낮은 필드(시간·가격)에 "확인필요" 태그가 붙는 검토 화면을 보여줌

→ **결정**: 포스터 업로드 → OCR 자동추출 → 검토 → 게시 방식으로 확정. `docs/admin-input-policy.md`에 명문화했고, `social-dance-app-dev-guide.html`의 수동 입력 서술은 OCR 기반으로 수정 완료(2026-09-14). 후속 영향: 백엔드에 OCR 파이프라인·오브젝트 스토리지(포스터 원본 저장)가 FR-10 구현 범위에 새로 포함되고, OCR 모델 선택·정확도 목표치는 `admin-input-policy.md`에 오픈 이슈로 남아 있음.

### 4.3 오픈 이슈 — AI 챗봇 기능의 범위 불명확

`social-dance-app-dev-guide.html`과 `kdance-beta-infra.html`은 Qwen3.5 9B(Ollama) 채팅 AI를 "채택 스택"으로 다루고 서빙 용량까지 상세히 분석하지만, `kdance-screens-spec.html`의 12개 화면 어디에도 챗봇 UI나 관련 API가 명시되어 있지 않다. 이 기능이 12화면 범위에 포함되는지, 별도 로드맵 단계로 예정된 것인지 확인 필요.

### 4.4 확인 필요 — 쿠폰 상세 정산 로직

`pricing-policy.md`가 "쿠폰 종류별 부담 비율, 정산 주기 등은 추후 논의 필요"라고 명시적으로 열어둔 상태 — FR-33·FR-37 구현 전 확정 필요.

### 4.5 확인 필요 — PG사 및 컴플라이언스

포트원/토스페이먼츠 중 최종 선정 여부, 전자금융거래법 관련 신고·등록 필요 여부는 `social-dance-app-dev-guide.html`에서 "법률 자문이 아니다, 실제 진행 전 PG사 기술영업·세무사와 반드시 1회 이상 확인할 것"으로 명시되어 있고 아직 확정되지 않았다. 로드맵 4단계(정산 분배형 결제) 착수의 선행 조건이다.

### 4.6 확인 필요 — 오브젝트 스토리지 및 AI 서빙 방식

MinIO 셀프호스팅 vs Cloudflare R2 승격 시점(`kdance-beta-infra.html`), AI 챗봇 서빙 옵션 A/B/C 중 실채택안(위 4.3과 연결) 모두 "베타 반응/실측 후 결정"으로 유보된 상태.

### 4.7 확인 필요 — Google OAuth 및 Samsung 배포 절차 진행 상황

`distribution-policy.md`가 "이미 진행 중"이라고 언급한 Android OAuth 클라이언트 ID(SHA-1) 작업의 현재 상태, Samsung Developer 계정 생성 여부는 문서만으로는 확인 불가 — 별도 확인 필요.
