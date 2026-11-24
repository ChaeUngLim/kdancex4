# API 계약 — 결제 뒤 대표·강사 쪽 보기 (M3: S3-5(결제 뒤 대표·강사 쪽 보기))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §15(읽기 지도)와 기존 §2·§7·§8·§9. 작성 2026-11-20. 이 파일은 **읽기 화면 중심**이고 쓰기는 현장 인원 고치기(§5)와 연락처 전체 열람 기록(§4) 둘뿐이다.

**근거 FR**: FR-079a(대표 주문·결제 목록) · FR-079(대표 회원 조회) · FR-005(역할별 데이터 범위) · FR-187(연락처 마스킹) · FR-019a(회원 닉네임 표시) · FR-168(연령대 표시) · FR-106(현장 등록 반영) · FR-107(역할 불균형 경보) · FR-064(강사 대시보드 집계) · SC-025(연락처 열람 기록 100%) · O-07(현장 수납은 플랫폼 밖) · Q20(강사 명단 표시 범위) · FR-081a(위임 가능한 관리 권한)

**2026-11-20 결정**: D3(위임 권한 = `roster_manage`(예약·명단) · `class_manage`(수업·포스터 등록) — 이 파일의 명단·현장 인원 경로는 `roster_manage` 를 쓴다) · D7(결석은 레벨에만 쓰고 화면에 출석률·횟수 숫자를 띄우지 않는다) · D22(FR-023(관심 강사·학원)은 베타 뒤 — 강사 집계의 「관심 등록 수」는 준비 중) · D20(근거가 없는 값은 모두 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」)

**보드**: W10(주문·결제, 관리자 웹) · W6(예약·명단 — 현장 등록 남·여 `− n +`와 회원 명단) · W23(위임 강사의 예약·명단) · W29(대표 대시보드) · O6(대표 앱 홈) · O40(대표 앱 현장 등록) · O45(대표 앱 주문·결제 찾기) · I1(강사 홈) · I7(수업 인원 한눈에) · I23(회원 관리 탭) · I26(오늘 결석 알린 수강생) · I22(현장 등록·정원) · I22B(인원 차이 알림)

## 0. 이미 정의돼 있어 다시 쓰지 않는 것

| 경로·규칙 | 정의 파일 | 이 파일이 하는 일 |
|---|---|---|
| 대표 대시보드 타일(`todayOrders` · `refundRequests` · `month` · `sessions` …) | `10-owner-dashboard.md` §1(`GET /api/academies/{academyId}/dashboard`) | 타일의 숫자를 채우는 **같은 계산 함수**만 §6 에서 정한다. 경로·모양은 10 이 이긴다 |
| 강사의 개인 레슨 수강생·회차(I10 · I20) | `11-instructor.md` §10-3 | §6 의 오늘 인원에 개인 레슨 줄을 **읽기만** 한다 |
| 결석 표시·취소·이의(`attendance_marks` 쓰기) | S3-4.3 · S3-4.3a · S3-4.3c — 경로 정의가 `04-me-calendar-notifications.md` 에 **아직 없다**(열린 점 ①) | §7 이 이미 표시된 결석을 **읽기만** 한다 |
| 환불 요청 목록·처리·계좌 송금 | `12-refund-cancel-waitlist.md` | O45 의 「환불 요청 보기 ›」는 12 의 목록으로 간다. §2 의 주문 줄은 환불 요청 상태 한 칸만 읽는다 |
| 정원 수정(수업 수정 요청) | `11-instructor.md` §2 의 `edit-requests` | 이 파일은 정원을 고치지 않는다. **현장 인원**만 고친다(§5) |
| 문의 목록·답변 | `15-ops.md` §2 | 회원 상세(§3-2)는 문의 **건수·상태**만 읽는다 |
| 감사 기록 조회 | `15-ops.md` §4(콘솔 P8) | §4 가 쓴 열람 기록을 거기서 본다 |

## 1. 공통

### 1-1. 권한

`○` 허용 · `담당` 그 회차의 담당 강사(`class_sessions.instructor_account_id`)만 · `-` 불가. 판정은 모두 서버(README §6-2). 위임을 끄면 다음 요청부터 403(O-11(위임 끄면 즉시 차단)).

| 경로 | 대표(`owner`) | 위임 강사(`roster_manage`) | 담당 강사 | 그 밖의 강사 |
|---|---|---|---|---|
| §2 주문 목록·상세 | ○ | **-**(FR-079a) | - | - |
| §3 회원 명단·상세 | ○ | ○(문의·결제 칸은 빠진다) | - | - |
| §4 회차 명단 | ○ | ○ | ○ | - |
| §5 연락처 전체 열람 | ○ | - | - | - |
| §6 현장 인원 고치기 | ○ | ○ | 담당 | - |
| §7 오늘 인원(대표 / 강사) | ○ / - | - | - / ○(자기 회차) | - |
| §8 오늘 결석 | ○ | ○ | 담당 | - |
| §9 강사 집계 | - | - | ○(자기 수업만) | ○(자기 수업만) |

- 대표 경로는 `requireStaff('owner', { academyId, surface })`, 위임 경로는 `requireStaff('roster_manage', …)`(대표는 자동 통과), 강사 경로는 `requireStaff('instructor', { surface: 'app' })` 다. 앱·관리자 웹이 같은 경로·같은 판정이다(W6 ↔ O40 「같은 규칙」)
- 다른 학원 id 로 부르면 403 `FORBIDDEN`(README §4 — 404 로 숨기지 않는다). 존재하지 않는 id 는 404 `NOT_FOUND`

### 1-2. 회원을 보여 주는 규칙 (세 응답 전부에 같다)

| 값 | 규칙 | 근거 |
|---|---|---|
| 이름 | **닉네임만** 내린다(`nickname`). 본명·생년월일은 응답에 없다 | FR-019a · Q20 |
| 연령 | **연령대**만(`ageBand`: `20s` · `30s` · `40s` · `50s` · `60s_plus`, 화면은 「20대」 — 회원은 만 19세 이상이라 20대부터). 만 나이·생년월일을 내리지 않는다. 자녀 계정은 회원이 아니라 15 의 자녀 규칙(`ageBand`)을 따른다 | FR-168 |
| 연락처 | 기본은 가린 값(`phoneMasked`, 예 `010-****-1234` — 가운데 네 자리를 `****` 로). 전체는 §5 로만 | FR-187 |
| 결제 대기 | 단체 수업 명단에서는 **이름 없이 인원 수**(`awaitingPayment`)로만. 1:1 개인 레슨은 결제 대기여도 닉네임을 보인다(§7 의 개인 레슨 줄) | Q20 · 2026-11-19 |
| 결제 완료의 뜻 | 주문 `paid` · `partially_refunded` + 예약 `confirmed`. 무료 수업은 신청이 확정된 것을 결제 완료와 같게 본다 | FR-005 |

가림 함수 `maskPhone(phone)` · `ageBandOf(birthDate, todayKst)` 는 순수 함수이고 응답을 만드는 모든 경로가 이것만 쓴다(단위 테스트 1개로 형식 고정). 응답 본문·로그에 전체 연락처를 넣지 않는다(FR-299).

### 1-3. 오류 코드 추가(README §4 표에 더한다)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` | 권한 없음 · 남의 학원 · 위임 강사가 주문 목록을 부름 |
| 409 | `SESSION_ENDED` · `SESSION_CANCELLED` | 끝났거나 휴강·폐강된 회차의 현장 인원을 고침 |
| 409 | `ONSITE_EXCEEDS_CAPACITY` | 앱 결제 + 현장 인원이 정원을 넘음 — 본문 `maxOnsite` |
| 422 | `VALIDATION_FAILED` | 음수 · 정수 아님 · 정원 방식(`gender_split`·`single`)과 맞지 않는 칸 |
| 422 | `CONTACT_REASON_REQUIRED` | 연락처 전체 열람에 사유가 비었거나 200자 초과 |

## 2. 대표 주문 목록 (S3-5.1 · W10 · O45)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/academies/{academyId}/orders` | `owner` | 주문·결제 목록(걸러서 조회·검색) | 읽기 | FR-079a | W10 · O45 |
| `GET /api/academies/{academyId}/orders/{orderId}` | `owner` | 한 주문의 결제·환불 이력(줄을 누르면 펼침) | 읽기 | FR-079a · FR-298 | O45 |

### 2-1. 목록

쿼리: `from`·`to`(`YYYY-MM-DD`, KST 달력, 주문 생성일 기준, 기본 이번 달 1일~오늘) · `classId` · `status`(`pending` · `paid` · `expired` · `cancelled` · `partially_refunded` · `refunded` 중 쉼표로 여러 개, 6종은 FR-298) · `method`(`card` · `easy_pay` · `easy_transfer` · `virtual_account`) · `q`(검색) · `limit`(기본 20, 최대 50) · `cursor`.

- 앱 O45 는 「찾기」 화면이라 기간을 이번 달로 좁히지 않고 `from` = 오늘 − 365일 · `to` = 오늘(366일, 서버 상한)을 보낸다(추천안·사후 확인 2026-11-24, S3-5.9c)
- 앱 O45 의 칩은 서버 값 묶음이다: 「결제 완료」 = `paid` · 「입금 대기」 = `pending` · 「환불」 = `partially_refunded`,`refunded`. 앱이 `status` 를 위 값으로 바꿔 보낸다 — 서버에 칩 이름을 만들지 않는다
- `q`: **닉네임 또는 수업명**에 부분 일치(대소문자 무시). 본명·연락처 전체로는 찾지 않는다(FR-019a). 숫자 4자리만 넣으면 연락처 **뒷 4자리**도 본다(O45 「이름·수업으로 검색」·W6 「이름·연락처로 찾기」 — 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))
- 정렬은 주문 생성 시각 내림차순 1종. 커서는 `(created_at, id)`

200
```json
{ "items": [ {
  "orderId": "…", "createdAt": "2026-11-10T01:20:00Z",
  "member": { "memberId": "…", "nickname": "김서연" },
  "class": { "classId": "…", "offeringId": "…", "title": "바차타 센슈얼 입문", "kindLabel": "정규 4주", "classKind": "regular" },
  "amount": 160000, "method": "card", "status": "partially_refunded",
  "paidAt": "2026-11-10T01:21:30Z", "dueAt": null,
  "refundRequest": { "requestId": "…", "status": "received", "kind": "regular" } } ],
  "nextCursor": null }
```
- `amount` = `orders.total_amount`(회원이 낸 금액, 예매 수수료 포함). `dueAt` 은 `pending` + 가상계좌일 때만(입금 기한, O45 「11/14까지」). `refundRequest` 는 그 주문의 **처리 전**(`received`·`in_progress`) 요청이 있을 때만, 없으면 `null`
- 주문이 열린 환불 요청을 하나만 가질 수 있어 한 건이다(12 `uq_refund_requests_open` 이 예약당 하나)

### 2-2. 이력 펼침

200
```json
{ "orderId": "…", "status": "partially_refunded", "amount": 160000, "refundedAmount": 40000,
  "timeline": [
    { "at": "2026-11-12T03:00:00Z", "kind": "refund_requested", "label": "환불 요청 접수", "detail": "검토 중" },
    { "at": "2026-11-10T01:21:30Z", "kind": "paid", "label": "결제 완료 · 신용카드", "amount": 160000 },
    { "at": "2026-11-10T01:20:00Z", "kind": "order_created", "label": "수업 신청 · 결제 시작", "amount": null } ] }
```
- `timeline` 은 최신이 먼저. 원천은 `order_events`(주문 전이) · `payments`(결제 시각) · `refund_requests`·`refunds`(환불 접수·완료). `kind` 는 `order_created` · `paid` · `expired` · `cancelled` · `refund_requested` · `refund_completed` · `refund_rejected`
- 카드번호·가상계좌 번호·환불 계좌는 넣지 않는다(FR-299). 영수증 링크는 `17-real-adapters.md` §6 의 경로를 쓴다

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 위임 강사 · 다른 학원 |
| 404 `NOT_FOUND` | 주문이 없거나 다른 학원 소속(상세) |
| 422 `VALIDATION_FAILED` | `from` > `to` · 기간 366일 초과(추천값) · 모르는 `status` |

## 3. 대표 회원 조회 (S3-5.2 · W6 회원 명단)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/academies/{academyId}/members` | `owner` · `roster_manage` | 이 학원 회원 목록 | 읽기 | FR-079 · FR-019a · FR-168 | W6 · W23 |
| `GET /api/academies/{academyId}/members/{memberId}` | `owner` · `roster_manage` | 한 회원의 수강·예약·결석 예정 이력 | 읽기 | FR-079 | W6 |

### 3-1. 목록

**이 학원 회원** = 이 학원 수업의 주문이 `paid`·`partially_refunded`·`refunded` 중 하나인 적이 있는 회원(환불한 회원도 이력이 남는다). 쿼리: `q`(닉네임 · 숫자 4자리면 연락처 뒷 4자리) · `sessionId`(주면 각 줄에 그 회차 상태가 붙는다) · `limit`(기본 30, 최대 100) · `cursor`.

200
```json
{ "total": 128,
  "items": [ { "memberId": "…", "nickname": "김서연", "gender": "female", "ageBand": "20s",
               "interestGenres": ["salsa_bachata"], "completedTerms": 3,
               "thisSession": { "state": "paid", "absencePlanned": false },
               "openInquiries": 0 } ],
  "nextCursor": null }
```
- `completedTerms` = 이 학원에서 결제 완료한 **수강 과정 수**(W6 「3과정 수강」). 환불이 끝난 주문은 세지 않는다
- `thisSession.state`: `paid`(결제 · 앱) · `refunded` · `none`. `absencePlanned` 는 `attendance_marks` 에 살아 있는 결석 행이 있을 때 `true`(회원이 알린 것과 강사·대표가 표시한 것 모두, D7)
- `openInquiries` = 답변 대기 문의 수. **위임 강사에게는 이 칸과 `refundedAmount` 류 결제 칸을 내리지 않는다**(W23 「결제 금액·수단·문의는 보이지 않고」). 칸이 아예 없는 응답이다(`null` 아님)

### 3-2. 상세

200
```json
{ "memberId": "…", "nickname": "김서연", "gender": "female", "ageBand": "20s", "phoneMasked": "010-****-1234",
  "interestGenres": ["salsa_bachata", "argentine_tango"],
  "enrollments": [ { "offeringId": "…", "classTitle": "바차타 센슈얼 입문", "label": "11월 기간", "paidAt": "…Z", "status": "paid", "sessionCount": 8 } ],
  "absenceHistory": [ { "sessionId": "…", "startsAt": "…Z", "markedByKind": "member", "markedAt": "…Z", "disputeStatus": "none" } ],
  "inquiries": [ { "inquiryId": "…", "category": "refund", "status": "open", "createdAt": "…Z" } ] }
```
- **위임 강사에게는 `enrollments[].paidAt` 외 결제 칸과 `inquiries` 를 내리지 않는다**(칸 없음). `absenceHistory` 는 「결석 예정 이력」이다(2026-11-10 변경 — 출석 이력이 아님). 출석률·횟수 숫자는 없다(D7)
- 이름·전체 연락처가 필요하면 §5 로 간다

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 다른 학원 · 그 학원 회원이 아님(결제 이력이 없는 회원 id) |
| 404 `NOT_FOUND` | 회원 없음 |

## 4. 회차 명단 (S3-5.2 · W6 · I23 · O40 일부)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/classes/{classId}/sessions/{sessionId}/roster` | `owner` · `roster_manage` · 담당 강사 | 그 회차의 확정 수강생(닉네임·연령대·가린 연락처)과 결제 대기 인원 | 읽기 | FR-005 · FR-019a · FR-168 · FR-187 · FR-106 | W6 · W23 · I23 |

200
```json
{ "classId": "…", "sessionId": "…", "offeringId": "…", "academyId": "…", "title": "쌈바(입문)", "classKind": "regular", "seatMode": "gender_split",
  "startsAt": "2026-11-11T11:30:00Z", "endsAt": "2026-11-11T12:30:00Z", "roomName": "A홀", "sessionStatus": "scheduled",
  "seats": [
    { "seatKind": "male",   "capacity": 10, "appConfirmed": 8, "absencePlanned": 1, "onsite": 0, "present": 7, "remaining": 2, "maxOnsite": 2 },
    { "seatKind": "female", "capacity": 10, "appConfirmed": 9, "absencePlanned": 1, "onsite": 1, "present": 9, "remaining": 0, "maxOnsite": 0 } ],
  "awaitingPayment": { "male": 1, "female": 0 },
  "members": [ { "memberId": "…", "nickname": "최하은", "gender": "female", "ageBand": "20s", "phoneMasked": "010-****-1234",
                 "monthsEnrolled": 3, "absence": { "markedByKind": "member", "markedAt": "2026-11-10T12:05:00Z" } },
               { "memberId": "…", "nickname": "김서연", "gender": "female", "ageBand": "20s", "phoneMasked": "010-****-5678",
                 "monthsEnrolled": 2, "absence": null } ] }
```
- `offeringId` = 이 회차가 속한 판매 단위. 강사 앱 I23 이 레벨 정하기 경로(14 §6-1 `GET /api/instructor/offerings/{offeringId}/member-levels` · `POST /api/instructor/level-evaluations`)를 부를 때 쓴다 — S6-3.6(앱 강사 레벨·후보 화면)에서 더함(추천안·사후 확인 2026-11-24). 다른 후보는 앱이 수업 상세를 읽어 판매 단위를 찾는 안이었는데, 대표가 올린 수업은 강사에게 수업 상세가 403(Q45)이라 쓸 수 없다
- `members` 는 결제 완료만(§1-2). **결석 예정이 맨 위**(2026-10-05 결정), 그 안은 닉네임 순. `awaitingPayment` 는 **숫자만**이고 이름·연락처·결제 수단이 없다. 개인 레슨은 이 경로가 아니라 §7 로 본다(회차 행이 `class_sessions` 가 아니다)
- `seats[]` 의 계산: `appConfirmed` = `seat_pools.confirmed_count` · `onsite` = §6 의 현장 인원 · `present` = §7 의 오늘 인원 함수 · `remaining` = `capacity − held_count − confirmed_count − onsite` · `maxOnsite` = 지금 `+` 로 더 넣을 수 있는 현장 인원의 상한 포함 값(§6 과 같은 식). 단일 정원(`single`)이면 `seats` 가 `any` 하나
- `monthsEnrolled` = 이 학원에서 첫 결제 완료한 달부터 이 회차 달까지 센 개월 수(I23 「3개월째」). 서버가 `payments.paid_at` 에서 계산하고 칸은 저장하지 않는다. 출석률·출석 횟수는 내리지 않는다(D7 — I23 에는 수강 개월 수만)
- 대표 W6 의 「이 회차 앱 9 · 현장 1」은 `seats` 합으로 만든다. 성별·연령대·연락처 가림 규칙은 §1-2

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 담당이 아닌 강사 · 위임이 꺼진 강사 · 다른 학원 |
| 404 `NOT_FOUND` | 회차가 없거나 `classId` 와 짝이 아님 |

## 5. 연락처 전체 열람 (S3-5.3 · FR-187 · SC-025)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `POST /api/academies/{academyId}/members/{memberId}/contact-reveal` | `owner` | 사유를 적고 그 회원의 전체 연락처를 본다. **열람 1번 = 감사 행 1건** | 아니오(부를 때마다 1건) | FR-187 · FR-185 · SC-025 | W6 · O45 |

요청
```json
{ "reason": "수업 변경 안내 전화", "sessionId": "…" }
```
- `reason`: 앞뒤 공백을 자른 뒤 **1~200자 필수**(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 비었거나 넘으면 422 `CONTACT_REASON_REQUIRED`. `sessionId` 는 어느 화면에서 열었는지 알려 주는 선택 칸이다(열람 근거의 맥락, 감사 `after` 에 같이 남는다)
- 이 학원 회원(§3-1 의 정의)이 아니면 403 `FORBIDDEN` — 학원 밖 회원의 연락처는 대표도 못 본다(FR-005)

200
```json
{ "memberId": "…", "phone": "010-1234-5678", "revealedAt": "2026-11-12T03:10:00Z" }
```

**기록 규칙 (SC-025 「열람 100%에 기록」)**

1. 감사 행 `audit_logs`(`action='member.contact_revealed'`, `target_table='members'`, `target_id=memberId`, `reason=<사유>`, `academy_id`, `actor_staff_account_id`, `actor_role='owner'`, `after={"context":{"sessionId":…},"masked":"010-****-5678"}`)를 **같은 트랜잭션 안에서 먼저 쓰고**, 쓰기가 성공해야 번호를 응답에 싣는다. 감사 쓰기가 실패하면 번호를 내리지 않고 500 `INTERNAL` 이다(`14-membership-benefits.md` §개강 후보 의 `candidate.contact_viewed` 와 같은 순서). 전체 번호는 감사 행에 **남기지 않는다**(가린 값만)
2. 열람 횟수에 상한은 두지 않는다. 같은 회원을 다시 열어도 새 사유로 새 행이 생긴다(재사용 쿠키·캐시로 사유 없이 다시 보는 길을 열지 않는다). 응답에 `Cache-Control: no-store`
3. **이상 접근 경보**: 한 계정이 1시간에 열람 50건을 넘으면 운영자 콘솔(P1~P8)에 경보를 올린다 — 막지는 않는다(spec 「이상 접근 경보」, 추천값 50). 경보 줄은 15 의 콘솔 기록이 읽는다
4. 열람 기록은 고칠 수 없고 추천값 **2년** 보관한다. ⚠ 보관 기간이 법령 기준과 맞는지는 법률 검토 대상
5. 이 경로는 **대표만**이다. 담당 강사·위임 강사는 가린 번호까지만 본다(Q20 은 가림을 말하고, 전체 열람 권한은 spec 에 강사에게 준다는 문장이 없다 — 열린 점 ②)

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 대표가 아님 · 다른 학원 · 그 학원 회원이 아님 |
| 404 `NOT_FOUND` | 회원 없음 |
| 422 `CONTACT_REASON_REQUIRED` | 사유가 비었거나 200자 초과 |

## 6. 현장 등록 인원 (S3-5.4 · FR-106 · W6 · O40 · I22)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount` | `owner` · `roster_manage` · 담당 강사 | 그 회차의 현장 등록 인원을 남·여(또는 단일)로 **통째로 바꾼다** | 같은 값이면 변화 없음(감사 행 안 씀) | FR-106 · O-07 · FR-185 | W6 · O40 · I22 |

요청(정원 방식에 맞는 칸만 받는다)
```json
{ "male": 1, "female": 2 }
```
단일 정원(`single`)이면 `{ "any": 3 }`. 값은 0 이상의 정수. 칸이 정원 방식과 맞지 않으면 422 `VALIDATION_FAILED`.

200
```json
{ "sessionId": "…", "seats": [
    { "seatKind": "male",   "capacity": 10, "appConfirmed": 6, "onsite": 1, "remaining": 3, "maxOnsite": 4 },
    { "seatKind": "female", "capacity": 10, "appConfirmed": 7, "onsite": 2, "remaining": 1, "maxOnsite": 3 } ],
  "changed": [ { "seatKind": "male", "from": 0, "to": 1 }, { "seatKind": "female", "from": 1, "to": 2 } ],
  "updatedAt": "2026-11-13T09:00:00Z" }
```

**규칙**

1. 상한: 성별 `k` 마다 `onsite[k] ≤ capacity[k] − held_count[k] − confirmed_count[k] − 그 회차의 보강 이동 인원(`session_seat_counters.substitute_count`, M4) − 그 회차의 동반자 자리(`companion_seats`, M6)`. 넘으면 409 `ONSITE_EXCEEDS_CAPACITY` + `{ "maxOnsite": { "male": 4, "female": 3 } }`. 판정은 `seat_pools` 두 행을 `seat_kind` 순서로 `FOR UPDATE` 로 잠근 뒤 한다 — 앱 결제와 동시에 눌러도 한 자리씩 잠그고 판정한다(FR-106 「서버가 한 자리씩 잠그고」). **정원을 넘겨 받지 않는다**(FR-091)
2. `−` 는 현장 인원만 줄인다. 앱으로 결제한 수강생은 이 경로로 빠지지 않는다(취소·환불 절차는 12)
3. 줄어서 자리가 생기면 그 성별 **대기 1번에게 알린다**(FR-094) — S4-4 의 `onSeatFreed(offeringId, seatKind)` 를 부른다. S4-4 가 아직 없으면 호출을 건너뛰는 빈 함수로 둔다
4. 고칠 수 있는 회차: 시작 전·진행 중. 끝났으면 409 `SESSION_ENDED`, 휴강·폐강이면 409 `SESSION_CANCELLED`
5. **정산에 들어가지 않는다**(O-07 현장 수납은 플랫폼 밖). 이 경로는 `orders`·`payments`·`settlement_entries` 를 만들지도 읽지도 않는다(S3-5.4 수용 ④ — 정산 행 수 불변이 테스트)
6. **기록**: 값이 바뀌었을 때만 감사 행 1건(`action='session.onsite_headcount_changed'`, `target_table='class_sessions'`, `target_id=sessionId`, `before={"male":0,"female":1}`, `after={"male":1,"female":2}`, 누가·언제는 감사 칸). 같은 값을 다시 보내면 200 이고 행을 안 쓴다. 대표 W6·I22 아래의 「변경 기록」은 `audit_logs` 를 `target_table='class_sessions' AND target_id=…` 로 읽는다
7. **앱의 남은 자리**: 같은 판매 단위의 앞으로 올 회차 중 **현장 인원이 가장 큰 값**을 그 성별의 점유로 보고 `remaining` 에서 뺀다(주문 생성·수업 상세가 이 값을 읽는다 — 03 의 주문 생성과 02 의 `pools[].remaining` 에 S3-5.4 가 더하는 것, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 정규 과정은 한 번 결제가 모든 회차를 차지하므로 가장 큰 현장 값만큼 자리를 비워 두어야 어느 회차도 정원을 넘지 않는다

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 담당이 아닌 강사 · `roster_manage` 가 꺼짐 |
| 404 `NOT_FOUND` | 회차 없음 |
| 409 `ONSITE_EXCEEDS_CAPACITY` · `SESSION_ENDED` · `SESSION_CANCELLED` | 위 규칙 |
| 422 `VALIDATION_FAILED` | 음수·정수 아님·정원 방식과 안 맞는 칸 |

## 7. 오늘 인원 (S3-5.5 · FR-064 일부 · I1 · I7 · O6 · O40)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/instructor/headcount?date=YYYY-MM-DD&academyId=` | 강사 본인 | 내 회차의 하루 인원표(홈 · 하루 전체 보기) | 읽기 | FR-092e · FR-106 | I1 · I7 |
| `GET /api/academies/{academyId}/headcount?date=YYYY-MM-DD` | `owner` | 우리 학원의 하루 인원표(대표 홈 · 현장 등록 목록) | 읽기 | FR-079b · FR-106 | O6 · O40 |

`date` 는 KST 달력 날짜, 기본 오늘. 두 경로의 줄 모양이 같다. 강사 경로의 `academyId` 는 학원 필터(I7 「전체 · 라틴하우스 강남 · 라틴스텝 서초」) — 없으면 소속 학원 전부.

- **구현 위치(추천안·사후 확인 2026-11-24)**: 강사 경로는 S3-5.9(앱 강사 명단 화면)가 만들었다(`admin-web/lib/server/services/instructor-headcount.ts`) — S3-5.5 는 순수 함수만 만들었고 로드맵에 이 경로를 맡은 Task 가 없어, I1·I7 을 그리는 화면 Task 에서 강사 경로 하나만 붙였다. 대표 경로는 대표 앱 화면 Task(S3-5.9c) 몫으로 남겼다
- **대표 경로 구현(추천안·사후 확인 2026-11-24, S3-5.9c)**: `admin-web/lib/server/services/owner-headcount.ts` — 강사 경로와 같은 `readHeadcount` 를 「강사를 가리지 않음 + 이 학원만」 범위로 부른다(그래서 같은 회차는 I7 과 O6 이 같은 숫자). 대표만(`consoleRoute` owner · 앱 Bearer 허용), 쿼리는 `date` 하나(모르는 키 422), 읽기 전에 이 학원의 기한 지난 결제 대기를 닫는다(주문 목록 §2 와 같은 정리). 단일 정원·개인 레슨 줄 규칙은 위 「칸 보충」과 같다. O40 은 응답에 따로 `maxOnsite` 칸을 두지 않고 앱이 `onsite + remaining` 으로 상한을 계산한다(계약 §6 의 식과 같고, 마지막 판정은 PUT 의 409)
- **칸 보충(추천안·사후 확인 2026-11-24)**: 수업 줄 `absence` 는 그 수업에 있는 자리 종류만 키를 둔다(남녀 정원 `{male, female}`, 단일 정원 `{any}`). 단일 정원 수업의 인원은 성별을 몰라 `summary.present.total` 에만 더한다. 회차는 회차 담당(비었으면 수업 담당)이 나이고 지금 active 소속 학원의 공개 수업만 · 개인 레슨 줄 `roomName` 은 시간(slot)의 홀 · 같은 시각이면 개인 레슨 줄이 먼저 · 모르는 쿼리 키는 422 · 읽기 전에 내 수업의 기한 지난 결제 대기를 닫는다(강사 집계 §9 와 같은 정리)

**오늘 인원 = 확정 − 결석 예정 + 현장**(S3-5.5 `computePresent(confirmed, absencePlanned, onsite)` 순수 함수 하나가 모든 곳의 원본). `확정` 은 결제 완료 기준(§1-2), `결석 예정` 은 살아 있는 `attendance_marks` 행 수(회원이 알린 것 + 강사·대표가 표시한 것, 취소·이의 인정된 것은 제외), `현장` 은 §6 의 값.

200
```json
{ "date": "2026-11-11",
  "summary": { "classCount": 2, "privateLessonCount": 1, "present": { "male": 9, "female": 12, "total": 21 }, "absencePlanned": 1 },
  "items": [
    { "kind": "private_lesson", "bookingId": "…", "startsAt": "2026-11-11T09:00:00Z", "endsAt": "2026-11-11T09:50:00Z",
      "title": "개인 레슨 · 1:1", "academy": { "id": "…", "name": "라틴하우스 강남" }, "roomName": "연습실",
      "student": { "nickname": "김서연", "gender": "female", "awaitingPayment": false },
      "present": { "male": 0, "female": 1 }, "absencePlanned": 0 },
    { "kind": "class", "classId": "…", "sessionId": "…", "startsAt": "2026-11-11T11:30:00Z", "endsAt": "2026-11-11T12:30:00Z",
      "title": "쌈바(입문)", "academy": { "id": "…", "name": "라틴하우스 강남" }, "roomName": "A홀", "instructor": { "displayName": "이준호" },
      "seatMode": "gender_split",
      "seats": [ { "seatKind": "male",   "capacity": 10, "confirmed": 6, "absencePlanned": 1, "onsite": 0, "present": 5, "remaining": 4 },
                 { "seatKind": "female", "capacity": 10, "confirmed": 7, "absencePlanned": 0, "onsite": 1, "present": 8, "remaining": 2 } ],
      "absence": { "male": 1, "female": 0 } } ] }
```
- `items` 는 시작 시각 오름차순. 휴강·폐강된 회차는 빼고 `summary` 에도 세지 않는다. `summary.present` 의 남·여는 줄들의 `present` 합이다(I7 요약줄 「수업 2 · 개인 레슨 1 · 참석 21 (남 9 · 여 12) · 결석 예정 1」)
- 개인 레슨 줄은 `private_lesson_bookings.status='booked'` 인 그날 회차를 11 §10-3 의 수강권에서 읽는다 — **결제 대기여도 닉네임을 보인다**(`awaitingPayment: true` 로 구별, 2026-11-19). 수강생이 멤버십이 끝난 경우의 이름 가림은 11 §10-3 의 `nameVisible` 규칙을 따른다
- 대표 경로의 `seats` 에는 O40 이 쓰는 칸(`capacity` · `confirmed` · `onsite` · `remaining`)이 이미 있다 — 현장 등록 목록(O40 「오늘 11/13 (금) 회차」)이 이 응답을 그대로 그리고 `저장` 이 §6 을 부른다
- **같은 계산을 10 의 대시보드 `sessions` 타일(오늘·내일)이 쓴다** — 그 타일이 `available: true` 로 바뀌는 것은 S3-5.6 이 이 함수를 불러서다
- **역할 불균형 판정 함수**(FR-107, S3-5.5): `evaluateGenderImbalance({ male, female }, threshold = 3)` → `{ imbalanced, shortKind: 'male'|'female'|null, gap }`. `male`·`female` 은 **결제 확정 인원**(`confirmed`, 결석 예정·현장 제외)이고 `threshold` 는 설정 상수 `GENDER_GAP_THRESHOLD = 3`(Q38 임시 확정). 차이가 3 이상이면 `imbalanced`, 적은 쪽이 `shortKind`. 단일 정원 회차는 판정하지 않는다
- **알림 작업**: 수업 전날 18:00(KST)에 다음 날 회차를 훑어 불균형이면 담당 강사와 대표에게 직원 알림(`notifications.kind='gender_imbalance'`, `dedupe_key='imbalance:<sessionId>'`)을 1번만 만든다 — 경로 `POST /api/internal/jobs/gender-imbalance-check`(내부 토큰). **이 작업은 S3-5.10(역할 불균형 알림 작업) 이 맡는다**(2026-11-20 로드맵에 더했다 — 열린 점 ③). 알림 본문에는 부족한 성별·차이·회차 시각만 있고 모집 수단 화면(I22B)은 별도
  - **구현 규칙(S3-5.10, 추천안·사후 확인 2026-11-24)**: ① 열쇠는 받는 직원마다 `imbalance:<sessionId>:<staffAccountId>` — `uq_notifications_dedupe` 가 (kind, dedupe_key) 유니크라 `imbalance:<sessionId>` 하나로는 강사·대표 두 건을 쓸 수 없다(대타 확정 `substitute:<id>:confirmed:<recipient>` 와 같은 방식). 담당 강사 = 대표면 1건 ② 받는 사람 = 회차 담당 강사(없으면 수업 담당) + 그 학원 active 대표 ③ 대상 = 공개(`published`)·성별 정원(`gender_split`) 수업의 예정(`scheduled`) 회차 중 KST 내일 시작, 인원은 `seat_pools.confirmed_count` ④ KST 18:00 앞에 불리면 아무것도 하지 않는다(cron 을 매시간 걸어도 안전) ⑤ 본문 `{ asOf? }`(strict, dev 경로일 때만 시험 시계) · 응답 200 `{ imbalancedSessions, notified }` · payload `{ sessionId, classId, classTitle, startsAt, shortKind, gap }` · `category='operations'`

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 강사 경로에 다른 강사의 학원 id · 대표 경로에 다른 학원 |
| 422 `VALIDATION_FAILED` | `date` 형식 오류 |

## 8. 오늘 결석 목록 (S3-5.9b · I26 읽기)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/classes/{classId}/sessions/{sessionId}/absences` | `owner` · `roster_manage` · 담당 강사 | 그 회차에 이미 표시된 결석(회원이 알린 것 + 강사·대표가 대신 표시한 것) | 읽기 | FR-092e · FR-104a | I26 · W6 |

200
```json
{ "sessionId": "…", "seatCount": 19, "absenceCount": { "male": 1, "female": 1, "total": 2 },
  "items": [ { "markId": "…", "memberId": "…", "nickname": "최하은", "gender": "female", "monthsEnrolled": 3,
               "markedByKind": "member", "markedAt": "2026-11-10T12:05:00Z", "disputeStatus": "none" },
             { "markId": "…", "memberId": "…", "nickname": "정우진", "gender": "male", "monthsEnrolled": 2,
               "markedByKind": "instructor", "markedAt": "2026-11-11T08:40:00Z", "disputeStatus": "none" } ] }
```
- `absenceCount` 는 §7 의 `absencePlanned` 와 **늘 같은 값**이다(I26 「홈 표의 결석 숫자와 늘 같아요」) — 같은 쿼리를 쓴다. `seatCount` = 확정 수강생 수(「자리 19명」)
- 결석 **표시·취소(끄기)·이의 처리**는 이 파일의 일이 아니다 — S3-4.3a(강사·대표 결석 표시) · S3-4.3c(이의)가 정한다(열린 점 ①). 이 응답의 `disputeStatus` 값은 데이터 §7-8 의 `none` · `requested` · `accepted` · `rejected`
- 출석률·출석 횟수는 없다(D7). 결석은 레벨에만 쓴다는 안내 문구는 앱 몫
- **구현 위치·칸 보충(추천안·사후 확인 2026-11-24, S3-5.9b)**: `GET` 은 표시 경로와 같은 파일(`staff-absence-marks.ts` 의 `list`)에 두고 권한도 같은 판정을 쓴다. 예시에 없던 칸을 더했다 — 머리 줄 재료 `classId`·`academyId`·`academyName`·`title`·`roomName`·`startsAt`·`endsAt`·`sessionStatus`, 표시 구간 `lockedAt`·`window`(`before_start`·`open`·`locked` — 앱이 48시간 식을 따로 갖지 않게), 부른 사람 자격 `viewerRole`(`owner`·`instructor`), 줄마다 `disputeReason`(이의 사유, 이의가 있을 때만)·`canResolveDispute`(표시한 본인·대표만 true), 이의 결과 `acceptedDisputes[]`(받아들여 취소된 행 — `markId`·`memberId`·`nickname`·`gender`·`disputeReason`·`resolvedAt`). `absenceCount` 는 단일 정원 회차를 위해 `any` 를 더해 `{male,female,any,total}`. 유지된 이의는 `items` 에 `disputeStatus:'rejected'` 로 남는다. 다른 후보: 이의 결과를 회원 알림에서만 보이기 — I26 goal(「이의 결과를 본다」)을 못 채워 고르지 않았다

## 9. 강사 대시보드 집계 (S3-5.6 · FR-064 · 강사 쪽)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/instructor/dashboard?from=&to=&academyId=` | 강사 본인(자기 수업만) | 요일별·학원별 신청 인원, 역할별 남은 자리, 대기자 수, 취소 인원, 관심 등록 수 | 읽기 | FR-064 | I1 |

`from`·`to` 는 KST 달력 날짜(기본 이번 주 월~일). 대표 대시보드 타일은 10 §1 이 정한다 — 이 경로는 **강사 쪽 집계 하나**다.

200
```json
{ "from": "2026-11-09", "to": "2026-11-15",
  "items": [ { "offeringId": "…", "classTitle": "쌈바(입문)", "academy": { "id": "…", "name": "라틴하우스 강남" },
               "weekdays": ["mon", "wed"], "sessionCount": 2,
               "applicants": 13, "remaining": { "male": 4, "female": 2, "any": null },
               "cancelled": 1,
               "waitlist": { "available": false, "availableFrom": "S4-4", "count": null } } ],
  "totalsByWeekday": [ { "weekday": "mon", "applicants": 13 }, { "weekday": "wed", "applicants": 13 } ],
  "interest": { "available": false, "availableFrom": "베타 뒤(D22 · FR-023)", "count": null } }
```
- 한 줄 = 그 강사가 맡은 판매 단위 하나. `applicants` = `seat_pools.confirmed_count` 합(결제 대기 제외) · `remaining` = §4 와 같은 식 · `cancelled` = 기간 안에 취소된 예약 수(`reservations.cancelled_at` 이 기간 안) · `weekdays` 는 `class_offerings.schedule_rule` 에서 읽는다
- `totalsByWeekday` 는 줄의 `applicants` 를 그 줄의 요일마다 더한 것이다(월·수에 하는 수업은 양쪽에 센다)
- 대기자 수는 S4-4(대기 신청) 전에는 `available: false` 이고 숫자를 0 으로 내리지 않는다(10 의 뼈대 원칙). **관심 등록 수는 FR-023(관심 강사·학원)이 베타 뒤라 계속 `available: false`**
- 자기 수업만 센다(`classes.instructor_account_id` 또는 회차 담당). 학원 전체 집계는 대표의 10 타일이다

## 수용 시나리오 (S3-5 수용 ①~⑤ ↔ 시험)

1. **Given** 위임 강사(`roster_manage`)가 있다 **When** `GET …/orders` **Then** 403 `FORBIDDEN`, 같은 강사가 `GET …/members` 는 200(결제 칸·문의 칸 없음) (수용 ①)
2. **Given** 결제 완료 2명 + 결제 대기 1명인 단체 수업 회차 **When** 명단 조회 **Then** `members` 2명(닉네임·`phoneMasked`)·`awaitingPayment` 가 숫자 1이고 대기자의 이름이 응답 어디에도 없다(수용 ③)
3. **Given** 결제 대기 상태의 1:1 개인 레슨 **When** `GET /api/instructor/headcount` **Then** 줄에 닉네임이 있고 `awaitingPayment: true` (수용 ③ 예외)
4. **Given** 대표가 사유를 적는다 **When** `POST …/contact-reveal` **Then** 200 전체 번호 + `audit_logs` 에 `member.contact_revealed` 1건(사유·열람자 포함), 사유를 비우면 422 이고 행 0건(수용 ②, SC-025)
5. **Given** 정원 남 10 · 앱 결제 남 6 **When** `PUT …/onsite-headcount {male:5}` **Then** 409 `ONSITE_EXCEEDS_CAPACITY`(`maxOnsite.male = 4`), `{male:4}` 는 200, 같은 값을 또 보내면 감사 행이 늘지 않는다
6. **Given** 현장 인원을 고쳤다 **When** 그 전후 `settlement_entries` 행 수 **Then** 같다(수용 ④)
7. **Given** 확정 남 6 · 결석 예정 남 1 · 현장 남 2 **When** `computePresent` **Then** 7, 응답 `present` 가 같고 I26 의 결석 수와 같다(수용 ⑤)
8. **Given** 확정 남 8 · 여 5 **When** `evaluateGenderImbalance` **Then** `imbalanced: true, shortKind: 'female', gap: 3`, 남 8 · 여 6 은 `false`

## Phase 6(테스트) 목록

| 층 | 무엇을 | 시험 |
|---|---|---|
| 단위 | `maskPhone` 형식 · `ageBandOf` 경계(생일·KST 날짜) · `computePresent` 조합 · `evaluateGenderImbalance` 경계(2·3) · 현장 상한 식 | S3-5.2 · S3-5.5 |
| DB | 위임 강사 403(주문) · 다른 학원 주문 0건 · 결제 대기 이름 없음 · 감사 1건 = 열람 1건 · 현장 수정 뒤 감사 행·정산 행 불변 · 앱 결제와 동시에 현장 `+` 를 눌러도 정원 초과 0건 | S3-5.1 · S3-5.2 · S3-5.3 · S3-5.4 |
| E2E(Playwright) | W6 화면 흐름(현장 `− n +` → 저장 → 남은 자리 변화) · 연락처 전체 보기 사유 입력 | S3-5.7 |
| 계약 린터 | `api_contract_lint.py` 로 이 파일의 경로가 구현과 1대1 | 각 Task verify |

## 열린 점

근거가 없는 칸·규칙은 모두 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)이다.

| # | 무엇 | 결정 |
|---|---|---|
| ① | `04-me-calendar-notifications.md` 에 S3-4.3~S3-4.6 의 경로(결석 예정 토글 · 강사·대표 결석 표시 · 48시간 확정 · 이의 · 결제 내역)가 **아직 없다.** 로드맵은 그 Task 들의 계약 칸에 04 를 적어 두었다 | **해소(2026-11-20)**: `04-me-calendar-notifications.md` §5~§9 가 경로를 정의했다. 이 파일은 읽기(§8)만 정의한다 |
| ② | 연락처 **전체 열람을 누가 하나** — Q20 은 가림까지만, FR-187 은 「열람 시 사유·열람자」라고만 한다. 로드맵 S3-5.3 은 대표만 말한다 | 대표만(추천). 강사에게 열 때는 같은 기록 규칙을 쓰고 §1-1 표의 칸만 바꾼다 |
| ③ | FR-107(역할 불균형 경보)의 **알림 작업**(전날 18:00 판정·직원 알림)을 맡은 Task 가 없다. S3-5.5 는 판정 함수만 만든다 | **해소(2026-11-20)**: 로드맵 S3-5.10(deps S3-5.5 · S1-4.2 · S0-4.4)이 맡는다. 알림 kind `gender_imbalance` 는 데이터 §15-4 ⑤ |
| ④ | 닉네임 칸이 데이터 모델에 **없다**(`members` 에 `name` 만 있고, 가입 계약 01 에 입력도 없다) — 12·14·15 계약이 이미 `nickname` 을 쓴다 | **해소(2026-11-20)**: 데이터 §2-2 `members.nickname` 이 정식 칸이 됐고 `01-member-onboarding.md` §3 이 가입 요청에서 받는다(보드 M3 칸 보정은 01 열린 점 ①) |
| ⑤ | 회차 단위(`enrollment_unit='session'`) 신청은 `reservations` 에 어느 회차인지 칸이 없다 | 회차 단위 판매 단위는 **회차가 하나뿐인 판매 단위**로 본다(추천). 명단은 그 판매 단위의 확정 예약 전부 |
| ⑥ | I7 보드 요약줄이 「참석 21 (남 10 · 여 11)」인데 줄 합계는 남 9 · 여 12 다(spec 은 2026-11-20 에 남 9 · 여 12 로 고침) | 보드를 고쳐야 한다(이 파일은 줄 합계를 따른다) |
| ⑦ | O6(대표 앱 홈)의 「신규 회원 N명」은 10 §1 타일에 없다 | S3-5.6 이 10 의 응답에 `newMembers`(이번 달 이 학원에서 첫 결제 완료한 회원 수)를 더한다 — 10 의 「더하는 것」으로 README §0 모음표에 올렸다 |
| ⑧ | 보강 이동 인원(S4-3 `substitute_count`)을 오늘 인원에 더할지 — spec 식은 「확정 − 결석 예정 + 현장」뿐 | M4 가 들어올 때 `+ substitute_count` 를 더하는 것을 추천(그 전에는 0) |
