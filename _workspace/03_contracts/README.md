# Phase 3(구현 계획) 산출물 — API 계약 공통 규칙

- 작성 2026-11-06 · 이 폴더는 공유 계약 §4.5(API 계약)다. 파일 목록:

| 파일 | 다루는 것 | 슬라이스 |
|---|---|---|
| `README.md` | 공통 — 경로·인증·형식(§4.6)·오류(§4.8)·멱등(§4.9) | 전부 |
| `01-member-onboarding.md` | 로그인·가짜 본인확인·가입·취향·기준 장르 | US1-A1(가입·취향) |
| `02-catalog.md` | 홈 목록(거르기)·수업 상세·기본 자리 | US1-A2(시드·검색·상세) |
| `03-checkout-payment.md` | 주문 생성·조회·셀프 취소·웹훅·만료·가짜 PG 시험 경로 | US1-A3·A4 |
| `04-me-calendar-notifications.md` | 내 캘린더·알림 조회 · 결석 예정 토글·강사·대표 결석 표시·48시간 확정·이의 · 내 결제 내역 | US1-A4 · M3: S3-4 |
| `05-cancellation-migrated.md` | 이관하는 취소 미리보기·취소 | S0-M4(취소 API 이관) |
| `06-ports.md` | 어댑터 포트·산정 함수 시그니처(§4.3·§4.10) | S0-M3 이후 전부 |
| `07-owner-onboarding.md` | 입점 신청·심사·학원 정보·정산 계좌·파일·약관 동의 | S1-1(입점 신청·심사·학원 정보·정산 계좌) |
| `08-owner-staff.md` | 강사 초대·소속 승인/거절·위임 권한·소속 해제 | S1-2(강사 소속·권한 위임·강의실) |
| `09-owner-notices.md` | 환불·취소 공지 판본·노쇼 기준·학원 공지 | S1-3(환불·취소 공지 양식·노쇼 기준) · S1-4(학원 공지) |
| `10-owner-dashboard.md` | 대표 대시보드(W29)·직원 알림함 | S1-4(학원 공지·대표 대시보드 뼈대·대표 알림함) |
| `11-instructor.md` | 강사 가입·프로필·수업 등록·승인·변경·휴강·대타·공지·소속 해제 완성·개인 레슨·일정 | M2: S2-1 ~ S2-4 |
| `12-refund-cancel-waitlist.md` | 환불 요청·대표 처리·계좌 환불 송금·이벤트형 취소·행사 일괄 취소·휴강 선택·옮기기·대기·우선 결제·동반·단체 | M4: S4-1 ~ S4-4 |
| `13-settlement.md` | 정산 원장·강사 정산 유형·계좌·명세·대표 승인 일괄 지급·대사·월 마감 · **운영자 P9(공휴일)·P10(예금주 확인)·P11(사업자 점검)** | M5: S5-1 ~ S5-4 · M7 의 S7-4.8a~c(P9~P11 API) |
| `14-membership-benefits.md` | 멤버십·정기결제·쿠폰·대학생 혜택·참여 학원·순위판·레벨·카드·개강 후보·행사 피드 | M6: S6-1 ~ S6-4 |
| `15-ops.md` | 알림 발송·설정·푸시·문의·신고·이용 제한 절차·약관·탈퇴·입점 해지·권리·자녀·운영자 콘솔(P1~P8)·점검·PG 장애·앱 버전 | M7: S7-1 ~ S7-4 |
| `16-ai-agent.md` | 에이전트 서버·문의 AI·포스터 읽기·강사 수업 말로 찾기·홍보 이미지·소개 문구 | MX: SX-1 ~ SX-6 |
| `17-real-adapters.md` | 실 PG(포트원 V2)·웹훅 서명·하위 판매자·영수증·지급대행·소셜 로그인·휴대폰 본인확인 | M8: S8-1 · S8-2 |
| `18-after-payment-views.md` | 결제 뒤 대표·강사 쪽 보기 — 대표 주문 목록·회원 조회·회차 명단·연락처 전체 열람(사유·감사)·현장 등록 인원·오늘 인원·오늘 결석 목록·강사 집계 | M3: S3-5(결제 뒤 대표·강사 쪽 보기) |

**한 경로는 한 파일에만 정의한다**(2026-11-20 통합). 다른 파일이 기존 경로를 넓힐 때는 「더하는 것」 표로만 적는다 — 아래 §0 모음표가 그 목록이다. 겹침을 어떻게 정했는지는 `_workspace/evidence/penpot-doc-sync-2026-11-20/integration.md`.

### 0. 다른 계약이 기존 경로에 더하는 것 (2026-11-20 통합 모음)

| 원래 경로(정의 파일) | 더하는 파일 | 더하는 것 |
|---|---|---|
| 주문 생성(03) | `12` §5-2·§5-4 | 선택 칸 `offerId`(대기 결제 기회)·`prioritySlotId`(우선 결제 자리) · 대기 줄이 살아 있으면 일반 신청 409 `SEAT_SOLD_OUT` |
| 주문 생성(03) | `14` §4-2 · §7-2 | 쿠폰·대학생 혜택(`coupon` 묶음) · 행사·대회 신청 `competitionEntry` |
| 주문 생성(03) | `15` §0-1 | 409 `TERMS_RECONSENT_REQUIRED` · 503 `MAINTENANCE_ACTIVE` · `attendeeChildId` |
| 주문 생성(03) | `17` §0 · §3-1 | 응답에 `checkout`(실 PG 결제창 재료) |
| 웹훅(03) | `17` §4 | 실 PG 서명 규격(`webhook-id` 멱등) |
| 취소 미리보기(05) | `12` §2-1 | 응답 교체(비율표 → 공지 요약·이벤트형 수수료 표) |
| 대시보드 응답(10 §1) | `18` §0 · 열린 점 ⑦ | 칸 `newMembers`(이번 달 이 학원에서 첫 결제 완료한 회원 수 — 대표 앱 홈 O6) · `sessions` 타일 계산은 18 §7 의 오늘 인원 함수 |
| 캘린더 조회(04 §1) | `04` §4-1 | 항목 칸 `sessionId` · `absence`(결석 상태 — M11 의 참석/결석 토글) |
| 파일 올리기(07) | `11` 열린 점 ⑩ · `13` §3-4 · `15` §0-1 · `16` §4-6 | `purpose` 값 추가(데이터 모델 §14-2 의 통합 목록이 원본) |

---

## 1. 경로·런타임

| 항목 | 규칙 |
|---|---|
| 접두어 | 모든 제품 API 는 `/api/...`(Next.js Route Handler, `admin-web/app/api/**/route.ts`). FastAPI 의 무접두 경로는 이관하면서 `/api` 를 붙인다 |
| 런타임 | Node.js 런타임 고정(Prisma 8 · `pg` 사용). Edge 런타임 금지 |
| 시험 전용 경로 | `/api/dev/**` 는 `KDANCE_DEV_ROUTES=true` 일 때만 응답하고, 아니면 404. 운영 배포 값은 `false` |
| 내부 경로 | `/api/internal/**` 는 헤더 `X-Internal-Token` 이 환경 변수 `INTERNAL_API_TOKEN` 과 같을 때만(상수 시간 비교) |
| 헬스 | `GET /api/health` → `200 {"status":"ok"}` |

## 2. 인증

| 항목 | 규칙 |
|---|---|
| 신원 | Better Auth 세션. 웹은 쿠키, 모바일은 `Authorization: Bearer <token>`(Better Auth `bearer` 플러그인). 위치: `/api/auth/[...all]` |
| 회원 확인 | 보호 경로는 `requireMember(request)` 가 세션 → `members.auth_user_id` 로 회원을 찾는다. 세션 없음 401 `UNAUTHENTICATED`, 세션은 있는데 가입 미완료 403 `SIGNUP_INCOMPLETE` |
| 옛 `X-User-Id` | **폐기.** 이관 경로도 세션으로 바꾼다 |
| 대표 경로 | 1회차에는 없다(대표 알림은 기록만) |

## 3. 공유 계약 §4.6 — 값 형식

| 값 | JSON 형식 | 예 |
|---|---|---|
| id | UUID 문자열 | `"0193…"` |
| 시각 | ISO 8601 UTC, `Z` 끝(`Temporal.Instant.toString()`) | `"2026-11-10T10:30:00Z"` |
| 화면용 현지 시각 | 서버가 함께 내려주지 않는다. 앱이 `Asia/Seoul` 로 바꿔 보여 준다 | — |
| 하루 중 시각(가능 시간대) | `"HH:MM"` 24시간, KST 기준 | `"18:00"` |
| 날짜 | `"YYYY-MM-DD"`(KST 달력) | `"2026-11-10"` |
| 금액 | 원 단위 정수(`number`). 소수 금지 | `120000` |
| 가격 내역 | 순서가 고정된 배열. `kind` 는 `list_price` → `benefit_discount` → `coupon_discount` → `booking_fee` → `final` 순(FR-283(결제액 계산 순서)). 할인 줄은 0 이어도 내려준다(FR-117(체크아웃 가격 내역)). `booking_fee` 는 해당 상품일 때만 | `[{"kind":"list_price","label":"정가","amount":120000}, …]` |
| 장르·구분 값 | §4.1 영문 값. 한글 이름은 앱이 붙인다 | `"salsa_bachata"` |

## 4. 공유 계약 §4.8 — 오류 응답

FastAPI 의 `{"detail": …}` 모양을 **유지하고** 기계용 `code` 를 더한다. `admin-web/lib/api-client.ts` 와 `mobile` 이 `detail` 을 읽고 있어서 클라이언트 수정이 최소가 된다.

```json
{ "detail": "사람이 읽는 한국어 문장", "code": "SEAT_SOLD_OUT" }
```

검증 실패만 `fields` 가 붙는다: `{ "detail": "입력값을 확인해 주세요", "code": "VALIDATION_FAILED", "fields": [{"path": "seatKind", "message": "…"}] }`

| HTTP | code | 언제 |
|---|---|---|
| 400 | `BAD_REQUEST` | 본문이 JSON 이 아님, 필수 헤더 없음(`Idempotency-Key`) |
| 401 | `UNAUTHENTICATED` | 세션 없음 |
| 401 | `INVALID_SIGNATURE` | 웹훅 서명 불일치(`/api/payments/webhook` 만) |
| 403 | `SIGNUP_INCOMPLETE` · `FORBIDDEN` | 가입 미완료 · 남의 자원(옛 규칙대로 404 로 숨기지 않는다) |
| 404 | `NOT_FOUND` | 자원 없음 |
| 409 | `BASE_GENRE_REQUIRED` · `SEAT_SOLD_OUT` · `ALREADY_RESERVED` · `CHECKOUT_CLOSED` · `NOTICE_MISSING` · `ORDER_NOT_CANCELLABLE` · `IDENTITY_ALREADY_USED` · `USE_ORDER_CANCEL` · `RESERVATION_ALREADY_CANCELLED` · `CLASS_ALREADY_STARTED` | 상태 충돌. 각 파일에 정의 |
| 422 | `VALIDATION_FAILED` | zod 검증 실패 |
| 500 | `INTERNAL` | 예상 못 한 오류. `detail` 에 내부 정보를 담지 않는다 |

- 응답 본문에 스택·SQL·연락처·환불계좌를 넣지 않는다(FR-299(결제 정보 보안))
- 성공 응답은 감싸지 않은 자원 JSON 이다(FastAPI 때와 같음). 목록은 `{ "items": [...] }`

## 5. 공유 계약 §4.9 — 멱등 규칙

| 대상 | 키 | 처음 | 다시 오면 |
|---|---|---|---|
| `POST /api/orders` | 헤더 `Idempotency-Key`(필수, 8~200자) + 회원 | 201 + 주문 | **200 + 같은 주문**(본문이 달라도 처음 것을 돌려준다). DB `uq_orders_member_idempotency` 가 권위 |
| `POST /api/orders/{id}/cancel` | 주문 상태 | 200 `cancelled` | 이미 `cancelled` 면 200 같은 본문. 다른 상태면 409 |
| `POST /api/payments/webhook` | 헤더 `webhook-id` | 처리 결과 200 | `uq_webhook_events_webhook_id` 충돌 → 200(아무것도 바꾸지 않음) |
| 결제 확정 자체 | 주문 상태 조건부 갱신 `pending→paid` | 1행 | 0행이면 이미 처리 — 아무것도 바꾸지 않는다 |
| `POST /api/reservations/{id}/cancel`(이관) | 헤더 `Idempotency-Key`(선택), 없으면 `sha256("cancel:" + reservationId)` | 옛 규칙 그대로 | 옛 규칙 그대로(200 재생) |

삽입 경합은 `INSERT … ON CONFLICT DO NOTHING RETURNING id` 로 받는다. 돌아온 행이 없으면 이긴 행을 다시 읽어 그 결과로 수렴한다 — 옛 SAVEPOINT 방식(`begin_nested`)의 대체다(plan D3).

---

## 6. 직원 인증 — 관리자 웹·강사·대표 앱 (2026-11-19 추가, S0-3(인증·역할·권한 경계))

§2 의 「대표 경로 1회차에는 없다」를 이 절이 대신한다. 데이터는 `03_data-model.md` §7-2. 관련: FR-300(로그인 하나·콘솔 하나) · FR-303(관리자 웹 2단계 인증) · FR-081a(위임 가능한 관리 권한) · FR-185(감사 기록).

파일 목록에 더한다: `07-owner-onboarding.md`(입점·학원 정보·정산 계좌·약관 동의, S1-1) · `08-owner-staff.md`(초대·소속·위임·해제, S1-2) · `09-owner-notices.md`(환불 공지 판본·노쇼 기준·학원 공지, S1-3·S1-4) · `10-owner-dashboard.md`(대시보드·알림함, S1-4).

### 6-1. 세션과 로그인 흐름

| 항목 | 규칙 |
|---|---|
| 계정 | 직원 계정(`staff_accounts`) 하나로 강사·대표 앱과 관리자 웹에 들어온다. 아이디·비밀번호는 Better Auth `username` 플러그인(설치본 경로 `/sign-in/username` 실측) |
| 관리자 웹 세션 | Better Auth 쿠키 세션(httpOnly · Secure · SameSite=Lax). **2단계 인증을 마친 세션만** 콘솔 경로를 쓸 수 있다 |
| 강사·대표 앱 | 같은 계정, bearer 토큰(§2). 2단계 인증을 묻지 않는다(FR-303 은 관리자 웹만). 앱에서 돈 나가는 동작은 승인 버튼 → 확인 팝업(결정 10) |
| 2단계 인증 | Better Auth `two-factor` 플러그인의 TOTP(인증 앱 6자리)만 켠다. 문자·이메일 OTP·패스키 경로는 끈다(결정 10) |

```
① POST /api/auth/sign-in/username {username, password}
   ├ 같은 기기 30일 쿠키(trust_device)가 유효 → 세션 발급 → ④
   └ 아니면 200 {twoFactorRedirect: true} + 임시 쿠키(two_factor) — 세션 아님
② 인증 앱 미등록(첫 로그인) → POST /api/auth/two-factor/enable {password} → totpURI(QR) → ③ 으로 확인해야 등록 끝
③ POST /api/auth/two-factor/verify-totp {code: "482107", trustDevice: true|false} → 세션 발급
④ GET /api/staff/me → 콘솔 메뉴 결정(아래)
```

- `/api/auth/**` 응답은 Better Auth 모양 그대로다(§2 와 같다). 우리 `code` 표(§4)는 `/api/**` 의 나머지 경로에만 적용한다. 단 **429 는 우리 모양으로** 낸다 — 요청 제한을 Better Auth before 훅에서 걸기 때문이다(동작은 SP-8(2단계 인증 플러그인 실측)에서 확인)
- 위임 권한이 하나도 없는 강사는 ①이 끝난 뒤 `GET /api/staff/me` 가 `consoleAccess: false` 를 주고 화면은 「관리자 웹에서 쓸 메뉴가 없어요」를 띄운다(FR-300 추천안). 인증 앱 등록(②)을 시키지 않으려고 ① 직후 판정한다

`GET /api/staff/me` 200
```json
{ "accountId": "…", "displayName": "이준호", "roles": ["instructor"], "secondFactorVerified": true, "consoleAccess": true,
  "academies": [ { "academyId": "…", "name": "라틴하우스 강남", "as": "delegate",
                   "permissions": ["roster_manage"], "menus": ["roster"] } ],
  "platformMenus": [] }
```
`as` 는 `owner` · `delegate` 둘. `menus` 는 서버가 권한에서 계산한다(대응: `roster_manage` → `roster`(예약·명단), `class_manage` → `classes`(수업·포스터 등록), 대표는 전체, `admin` 역할은 `platform_settlement` 추가). 화면은 이 목록만 그린다.
- (2026-11-20 S0-3.7(직원 정보 조회 API) 구현 때 더함) 학원에 매이지 않는 운영자 메뉴는 `platformMenus` 에 담는다 — `admin` 역할이면 `["platform_settlement", "reports"]`(`reports` = 신고 처리 화면 `/admin/reports`, 2026-11-25 최종 점검에서 메뉴 입구를 더함), 아니면 `[]`. 대표의 `permissions` 는 `["owner"]`. 위임이 하나도 없는 학원은 `academies` 에 넣지 않는다. `consoleAccess` = `platformMenus` 또는 어느 학원의 `menus` 가 비어 있지 않음. 「대표는 전체」는 지금 이름이 정해진 `roster`·`classes` 둘이고, 대표 전용 화면의 메뉴 이름은 그 화면의 Task 가 여기에 먼저 적는다. 응답 스키마 원본: `admin-web/lib/server/services/staff-me.ts` 의 `staffMeResponseSchema`
- (2026-11-21 S1-1.32(학원 설정 화면 W2b·W22) 구현 때 더함) 대표 전용 메뉴 `settings`(입점·설정, 보드 W2b·W22)를 `menus` 에 더했다 — 대표는 이제 `["roster", "classes", "settings"]` 를 받는다. 위임으로는 열리지 않는다. 화면 주소는 `/academies/{academyId}/settings`(입점·설정)·`/academies/{academyId}/app-page`(학원 앱 페이지)
- (2026-11-21 S1-2.14(강사·소속 화면 W3a) 구현 때 더함) 대표 전용 메뉴 `instructors`(강사 관리, 보드 W3a)를 `menus` 에 더했다 — 대표는 이제 `["roster", "classes", "instructors", "settings"]` 를 받는다. 소속 승인·위임 관리는 대표 고유 권한이라(08 시나리오 6) 위임으로는 열리지 않는다. 화면 주소는 `/academies/{academyId}/instructors`

### 6-2. `requireStaff(permission, { academyId?, surface })` 판정 순서

먼저 실패한 단계의 응답을 그대로 돌려준다. 권한 정보는 세션에 넣지 않고 **매 요청 DB 에서 읽는다**(위임을 끄면 다음 요청부터 403 — O-11(위임 끄면 즉시 차단)).

| # | 검사 | 실패 응답 |
|---|---|---|
| 1 | 세션이 있다 | 401 `UNAUTHENTICATED` |
| 2 | 세션의 사용자에게 `staff_accounts` 가 있고 `active` 다 | 403 `STAFF_ACCOUNT_REQUIRED` · 403 `ACCOUNT_SUSPENDED` |
| 3 | `surface='web'` 이면 이 세션이 2단계 인증을 마쳤다. 대표 앱도 부르는 콘솔 경로(명세 `appToo: true` — 대시보드·소속 목록·승인·거절·위임·초대 만들기·해제·해제 미리 보기·동의 기록·약관 통지 읽음)는 Bearer 요청을 `surface='app'` 으로 보고 쿠키 요청만 `web` 으로 본다(2026-11-23 사용자 결정 — 대표 앱이 실서버에서 401 이던 문제, 수업 승인 경로와 같은 방식). 직원 본인 경로(`staff_self` — 직원 알림함 `GET/POST /api/staff/notifications…`)도 2단계는 쿠키 요청에만 묻는다(11 열린 점 ⑩ 적용, 같은 날) | 401 `SECOND_FACTOR_REQUIRED` |
| 4 | `permission` 이 `admin` 이면 `role_grants(admin, active)` | 403 `FORBIDDEN` |
| 5 | `academyId` 가 있으면 학원이 있다 | 404 `NOT_FOUND` |
| 6 | 대표 권한(`owner`)이면 `academy_owners(active)` 가 그 계정이다 | 403 `FORBIDDEN` |
| 7 | 위임 권한(`roster_manage`·`class_manage`)이면 대표이거나, `active` 소속 + 그 위임 행이 있다 | 403 `FORBIDDEN` |
| 8 | 경로별 학원 상태 조건(예: `restricted` 학원의 새 게시 거부) | 409 각 계약의 코드 |

- 다른 학원의 id 로 부르면 6·7 에서 403 이다 — §4 의 「404 로 숨기지 않는다」를 따른다
- 매출·정산·금액 설정·재무 대시보드는 `owner` 만 받는다. 위임 권한으로는 열리지 않는다(FR-081a)

### 6-3. 권한 없는 화면 주소로 직접 들어올 때

| 상황 | 응답 |
|---|---|
| 세션 없음 | 서버 컴포넌트가 `/login` 으로 리다이렉트(307) |
| 2단계 인증 전 | `/login/second-factor` 로 리다이렉트 |
| 권한 없음 | **HTTP 403** 과 403 화면(「이 메뉴를 쓸 권한이 없어요」). 메뉴·데이터는 그리지 않는다. Next 16.3 설치본의 `forbidden()`(실험 기능, `experimental.authInterrupts` 필요 — `node_modules/next/dist/docs/…/forbidden.md` 실측)을 쓴다. 실험 기능을 켜지 않기로 하면 403 응답을 직접 만드는 `app/(console)/layout.tsx` 판정으로 대신한다 |

화면 판정과 API 판정은 같은 `requireStaff` 함수를 부른다. 메뉴에서 숨기는 것만으로 막지 않는다(FR-300 「주소로 직접 들어가도 서버가 막는다」).

### 6-4. 직원 경로 오류 코드 추가(§4 표에 더함)

| HTTP | code | 언제 · 본문 예 |
|---|---|---|
| 401 | `SECOND_FACTOR_REQUIRED` | 2단계 인증 전 세션 · 계좌 변경 같은 재확인 동작에 코드가 없을 때 |
| 403 | `STAFF_ACCOUNT_REQUIRED` · `ACCOUNT_SUSPENDED` · `FORBIDDEN` | 6-2 |
| 409 | 각 계약 파일에 정의 | 상태 충돌 |
| 422 | `VALIDATION_FAILED` · `TOTP_INVALID` | 검증 실패 · 재확인용 6자리가 틀림 |
| 429 | `RATE_LIMITED` | `{ "detail": "잠시 뒤 다시 시도해 주세요", "code": "RATE_LIMITED", "retryAfterSeconds": 840 }` + 헤더 `Retry-After: 840` |

요청 제한(플랜 S0-3 수용 ⑤, 값은 **추천값**): 로그인·인증 코드 실패가 같은 계정 또는 같은 IP 에서 15분에 5회를 넘으면 15분 동안 429. Redis 에 세고, Redis 가 꺼져 있으면 **막는 쪽**으로 실패한다. 실패마다 `audit_logs`(`staff.login_failed`·`staff.second_factor_failed`)에 1행 — 비밀번호·코드 값은 남기지 않는다.
