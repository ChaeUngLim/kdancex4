# FR-022a(첫 화면 장르 선택·유지) 일부 — 단일 전환 + 세부 장르

사용자 결정(2026-11-25): 범위 「단일 전환 + 세부 장르」. 범위 밖: 여러 장르 동시 선택, 장르별 색 테마 6종, 카드 사진 3초 교차·더블 탭.
SCH 대응 없음(SCH 미부여 작업 → Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 생략).

## Phase 1 요구사항(수용 기준)
- AC-1 회원 앱 홈 머리말의 장르 제목 옆에 「장르 바꾸기」 버튼이 있다. 누르면 기준 장르 화면(카드 4장, 단일 선택)으로 가고, 고르면 홈으로 돌아와 목록·제목이 바뀐다.
- AC-2 댄스스포츠·살사/바차타 카드를 고르면 세부 장르 칩이 나온다: 댄스스포츠 = 전체·라틴·스탠다드, 살사/바차타 = 전체·살사·바차타. 탱고·스윙은 세부 장르 없음. 기본값 「전체」.
- AC-3 홈 목록은 세부 장르가 정해져 있으면 classes.sub_genre 가 같은 수업만 보인다. 「전체」(null)면 지금처럼 장르 전체.
- AC-4 홈 제목: 세부 장르가 있으면 「댄스스포츠(라틴)」 — 괄호 부분은 조금 작게(spec FR-022a). 없으면 「댄스스포츠」.
- AC-5 가입 직후 첫 선택 흐름(온보딩 base-genre → 홈)은 지금처럼 동작한다(세부 장르는 선택, 안 골라도 진행).
- AC-6 서버가 검증한다: 세부 장르가 그 장르에 속하지 않으면 422(예: argentine_tango + latin). 화면만 막지 않는다.

## Phase 2 기존 코드(확인함)
- DB 스키마: admin-web/prisma/contract.prisma 485행 `base_genre Genre?` (model members). 스키마 변경은 `npm run db:emit` → `npm run db:migrate`(prisma 8 rc.24). 테스트 DB 도 반영 필요(admin-web DB 테스트 셋업 확인).
- 저장 API: admin-web/app/api/me/base-genre/route.ts → lib/server/services/member-profile.ts 96행 `memberBaseGenreRequestSchema`, 200행 UPDATE.
- 조회: GET /api/me → lib/server/services/member-signup.ts 93·168행(회원 응답 모양 baseGenre).
- 홈 목록: lib/server/services/home-offerings.ts 260~311행(base_genre 읽고 c.genre = baseGenre 로 거름).
- classes.sub_genre CHECK: dance_sport → latin|standard, salsa_bachata → salsa|bachata(이미 있음).
- 계약: _workspace/03_contracts/01-member-onboarding.md §6(PUT /api/me/base-genre), 02-catalog.md §1(홈 목록).
- mobile: app/base-genre.tsx(카드 4장 단일 선택, 저장 뒤 router.replace(HOME_ROUTE)), lib/onboarding/members-api.ts(saveBaseGenre·fetchMe), lib/onboarding/types.ts(Member.baseGenre), app/(tabs)/home.tsx(HomeHeader — 오늘 fetchMe 로 baseGenre 제목 표시하도록 고침, 미커밋).

## Phase 3 설계
- DB: members 에 `base_sub_genre` text NULL 추가 + CHECK(NULL 이거나 (base_genre='dance_sport' AND in latin,standard) OR (base_genre='salsa_bachata' AND in salsa,bachata)). 기존 행은 NULL(= 전체).
- 계약 01 §6: 요청 `{ baseGenre, baseSubGenre?: "latin"|"standard"|"salsa"|"bachata"|null }`. 안 보내면 null(전체)로 저장. 맞지 않는 조합 422(기존 오류 모양 그대로).
- 회원 응답(GET /api/me·PUT 응답): `baseSubGenre: string|null` 칸 추가.
- 계약 02 §1: 홈 목록은 base_sub_genre 가 있으면 `AND c.sub_genre = base_sub_genre` 추가. 응답 모양은 그대로.
- mobile: base-genre 화면에 세부 장르 칩 줄(선택한 카드가 dance_sport·salsa_bachata 일 때만). 진입 경로 두 가지: 온보딩(지금 그대로) · 홈의 「장르 바꾸기」. 저장 뒤 홈으로(홈은 useFocusEffect 로 새로 읽음). 홈 머리말: 제목 = 장르 이름 + 작은 글씨 「(라틴)」, 옆에 「장르 바꾸기」 버튼(accessibilityRole button). 현재 선택값을 카드·칩에 미리 표시.
- 규칙: useEffect 새로 쓰지 않는다. 핵심 지점 한국어 주석. 색은 lib/theme 토큰.

## Phase 4 Task(수직 슬라이스 하나, 순서대로)
- T1 서버: 스키마·마이그레이션(개발 DB kdance_next + 테스트 DB) · member-profile 스키마·UPDATE · member-signup 응답 · home-offerings 필터 · 계약 01 §6·02 §1 문서 갱신 · 테스트 추가(조합 검증 422, 세부 장르 필터, 응답 칸).
- T2 mobile: types·members-api · base-genre 화면 칩·미리 선택·진입 경로 · home 머리말 버튼·괄호 제목.
