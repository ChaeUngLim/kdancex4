# API 계약 — 강사 가입·프로필 · 수업 등록·승인 · 변경·휴강·대타·공지 · 소속 해제 완성 · 개인 레슨·일정 (M2 강사: S2-1 · S2-2 · S2-3 · S2-4)

- 작성 2026-11-20 · 공통 규칙은 `README.md`(경로 §1 · 인증 §2·§6 · 값 형식 §3 · 오류 §4 · 멱등 §5). 데이터는 `03_data-model.md` §8(초안: `_workspace/evidence/penpot-doc-sync-2026-11-20/datamodel_draft_M2.md`) · 어댑터 포트는 `06-ports.md`
- 슬라이스: S2-1(강사 가입·소속 신청·프로필) · S2-2(수업 등록·대표 승인·게시) · S2-3(변경·휴강 예고·대타·강사 공지) · S2-4(개인 레슨 개설·강사 일정). 정산 계좌·정산 명세(S5-2)는 M5 담당이라 이 파일에 없다
- 근거 FR: FR-011(강사·대표 계정 승인) · FR-011a(앱 둘·서버 하나) · FR-011b(강사 활동 장르 하나) · FR-025(강사 프로필) · FR-050(강사 수업 등록) · FR-050a(수업 등록 승인) · FR-051(수업 구분) · FR-052a(회차·기간 신청 단위) · FR-052c(학원에서 여는 개인 레슨) · FR-053(강사 가능 시간·개인 일정) · FR-054(강사 일정 충돌 거부) · FR-055(휴강·보강 통지) · FR-056(시간·장소 변경 통지) · FR-057(반복 일정 생성) · FR-058(강사 일정 대시보드) · FR-060(대타 요청) · FR-063(강사 수업 공지) · FR-065(회차 휴강·폐강 선택) · FR-072(강의실 중복 배정 거부) · FR-076(게시 3종 동시 준비) · FR-081a(위임 가능한 관리 권한) · FR-082(강사 소속 해제 처리) · FR-092(성별 정원) · FR-092c(성별 구분 없는 단일 정원) · FR-099b(공지 자동 입력) · FR-099d(환불 마감일 필수 입력) · FR-135a(개인 레슨 정산)
- 보드: M1B(강사 로그인) · I31C(가입 1/2 본인확인) · I31(가입 2/2) · I31B(아이디·비밀번호 찾기) · I9·I9E(강사 마이·학원 색) · I12(학원 탭) · I27·I27B(소속 신청) · I28·I28B(소속 해제) · I40(프로필) · I19·I19B(수업 탭) · I2·I2B·I2C·I2D·I2E·I2S·I44(수업 만들기) · I33(수정 요청 받은 수업) · I24(수업 수정) · O5·O5P(대표 수업 승인) · I6B(회차 상세 수업 관리) · I34(시간·장소 변경) · I25(휴강 알리기) · I13·I13B(수강생 공지) · I14·I14B·I14C(대타) · O21B(대표 알림함 「대타」) · O39·O39B·W3b·W3b2(소속 해제 확인 창) · I10·I10B·I10C(개인 레슨 개설) · I20·I20B·I20C(개인 레슨 수강생·규칙) · I1·I5·I5W·I5D(일정) · I36(개인 일정) · W30(위임 강사의 관리자 웹 수업 등록)
- **2026-11-20 사용자 결정 반영**: D3(위임 권한 = 관리자 웹 토글 2개 `roster_manage`·`class_manage` + 앱 `class_submit`) · D10(문의 종류 칩 「결석」) · D11(스탠다드 종목 `waltz`·`slow_foxtrot`, 슬로우왈츠 없음) · D12(개인 레슨 수수료 1% 공제 줄은 대표 명세에만 — 이 파일의 어떤 응답에도 수수료 칸이 없다) · 2026-11-23(개인 레슨 수수료는 강사 가입일부터 1년 면제 뒤 1% — 판정에 강사 가입일이 필요하다. 어느 칸을 쓸지는 구현 Task 에서 정한다. 이전: 면제 없이 첫날부터 1%)
- 08(`08-owner-staff.md`)이 이미 정한 강사 쪽 경로는 **다시 정의하지 않고 참조만 한다**: `POST /api/instructor/affiliations`(소속 신청) · `POST /api/instructor/invites/{token}/accept`(초대 수락, 승인 대기로 들어감) · `POST /api/instructor/affiliations/{id}/withdraw` · `GET /api/instructor/affiliations`(학원별 상태 카드) 와 승인·거절·위임·비율(08 §3~§4-1)

## 0. 권한 표기와 면(surface)

| 표기 | 뜻 |
|---|---|
| `public` | 세션 없음. 본인확인 토큰·요청 제한(429 `RATE_LIMITED`, README §6-4)으로 지킨다 |
| `instructor` | 직원 계정 + 역할 `instructor`(`active`). 앱(Bearer)·관리자 웹(쿠키) 모두. 판정은 `requireStaff` 가 매 요청 DB 에서 읽는다(README §6-2) |
| `affiliated(academyId)` | `instructor` + 그 학원 `active` 소속. 아니면 403 `AFFILIATION_REQUIRED` |
| `class_writer(academyId)` | **대표**이거나, `affiliated` + 그 면의 위임 권한. 앱(Bearer)은 `class_submit`, 관리자 웹(쿠키)은 `class_manage`. 소속은 있는데 권한이 꺼져 있으면 403 `CLASS_PERMISSION_REQUIRED`(I2 의 「등록 권한 없음」). 위임 강사는 **자기가 올린 수업만** 읽고 고친다(Q45(위임 강사가 보는 수업 범위), `classes.created_by_account_id`) |
| `owner` | 그 학원의 활성 대표(README §6-2 #6) |

- 개인 레슨은 **소속만 있으면** 열 수 있다. 권한 토글이 없다(FR-052c, 2026-10-11)
- 쓰는 경로의 요청 시각은 서버가 정한다(본문의 시각을 믿지 않는다). 값 형식은 README §3: 시각 `…Z`, 하루 중 시각 `"HH:MM"`(KST), 날짜 `"YYYY-MM-DD"`(KST), 금액 원 정수
- 새로 만드는 경로(`POST`)는 헤더 `Idempotency-Key`(8~200자)를 받는다. 같은 키로 다시 오면 **200 + 처음 결과**(본문이 달라도 처음 것). DB 가 권위다(`uq_*_idempotency`, 데이터 §8). 경로 표의 「멱등」 칸이 `키`면 필수, `상태`면 조건부 갱신이 근거다

## 1. 강사 가입·계정 찾기 — 권한 `public` (S2-1: FR-011 · FR-011b · I31C · I31 · I31B · M1B)

흐름: 휴대폰 본인확인 토큰(가짜 어댑터는 `POST /api/dev/identity/fake-verify`, `01-member-onboarding.md` §2) → ① `identity-check`(I31C 「본인확인하고 다음」) → ② `signup`(I31 「가입하고 체험 시작」) → Better Auth 아이디 로그인(`/api/auth/sign-in/username`, POST — 모두 받기 경로라 계약 린터 대조 밖)(README §6-1)으로 로그인. 가입은 **승인 없이** 끝나고, 학원 소속만 대표가 승인한다(FR-011).

| 메서드·경로 | 역할 | 멱등 | FR · 보드 |
|---|---|---|---|
| `POST /api/instructor/signup/identity-check` | 본인확인 결과로 가입 자격을 먼저 본다(이미 강사 계정이 있나 · 만 19세 이상인가) | 읽기 | FR-011 · I31C |
| `GET /api/instructor/signup/username-available?username=` | 아이디 「중복 확인」 | 읽기 | FR-011 · I31 |
| `POST /api/instructor/signup` | 강사 계정 만들기 | 상태(CI·아이디 유니크) | FR-011 · FR-011b · I31 |
| `POST /api/instructor/account-recovery/lookup` | 본인확인한 사람의 강사 계정 찾기 | 읽기 | FR-011 · I31B |
| `POST /api/instructor/account-recovery/reset-password` | 비밀번호 새로 정하기 | 상태 | FR-011 · FR-191(로그인 세션·기기 분실) · I31B |

로그인 화면 M1B 의 「Instructor 강사 / Owner 대표」 탭은 Better Auth 아이디 로그인(`/api/auth/sign-in/username`) 뒤 `GET /api/staff/me`(README §6-1)의 `roles` 에 고른 역할이 있는지 앱이 확인하고, 없으면 로그아웃시켜 「이 계정에는 강사 권한이 없어요」를 보인다. 보호는 서버가 매 요청 역할을 확인한다(FR-011a). 로그인 요청 제한(15분 5회)은 README §6-4 를 따른다.

### 1-1. `POST /api/instructor/signup/identity-check` (I31C)

```json
{ "verificationToken": "<IdentityVerificationPort 가 푸는 토큰>" }
```
200
```json
{ "eligible": true, "nameMasked": "이*호", "phoneMasked": "010-****-5821", "ageVerified": true }
```
- 만 19세는 **본인확인 생년월일**로 판정한다(체크박스가 아니다, 2026-11-18). 기준일은 요청 시각의 KST 날짜
- 같은 CI 의 직원 계정에 `instructor` 역할이 이미 있으면 새 계정을 만들지 않는다 → 409 `INSTRUCTOR_ALREADY_REGISTERED` `{ "maskedUsername": "jun***tin", "hasInstructorRole": true }` — 앱은 「이미 가입한 강사예요」와 로그인·비밀번호 새로 정하기(I31B)로 보낸다(Q23(강사 본인확인 시점) 확정, Q41(강사 가입 규칙))
- 직원 계정(대표 등)은 있고 `instructor` 역할만 없으면 같은 코드에 `"hasInstructorRole": false`. 이 사람에게 새 계정은 만들지 않는다(`uq_staff_accounts_ci`). 역할 추가 경로는 열린 점 ⑤

| HTTP | code | 언제 |
|---|---|---|
| 422 | `VALIDATION_FAILED` | 토큰이 없거나 무효·만료(유효 10분, 01 §2 와 같음) |
| 422 | `INSTRUCTOR_UNDER_19` | 만 19세 미만 — 가입할 수 없다 |
| 409 | `INSTRUCTOR_ALREADY_REGISTERED` | 위 |
| 429 | `RATE_LIMITED` | 같은 IP 요청 제한 |

### 1-2. `GET /api/instructor/signup/username-available?username=junho_latin`

200 `{ "available": true }` · `{ "available": false, "reason": "taken" }` — `reason` = `taken` · `format`(영문 소문자·숫자 4~20자 밖). 아이디 형식과 「아이디와 같은 비밀번호 금지」는 Q41(강사 가입 규칙) 임시 확정을 따른다. 아이디 존재 여부를 알려 주는 경로라 요청 제한 대상이다(429)

### 1-3. `POST /api/instructor/signup` (I31)

```json
{ "verificationToken": "…", "username": "junho_latin", "password": "Latin!2026x", "displayName": "이준호",
  "activityGenre": "dance_sport",
  "businessRegistrationNumber": null,
  "consents": { "merchantTerms": true, "merchantPrivacyCollection": true, "marketing": false } }
```
201
```json
{ "accountId": "…", "username": "junho_latin", "displayName": "이준호", "activityGenre": "dance_sport",
  "roles": ["instructor"], "membership": null,
  "next": "sign_in" }
```
- 한 트랜잭션: `auth.user`(Better Auth `username` 플러그인) · `staff_accounts`(CI 해시·생년월일·가린 연락처·본인확인 이름) · `role_grants(instructor)` · `instructor_profiles` · `staff_consents`(필수 둘) · 감사 `instructor.signup_completed`. 세션은 만들지 않는다 — 앱이 이어서 로그인 경로를 부른다(**추천안**)
- `activityGenre` 는 넷 중 하나(`dance_sport` · `argentine_tango` · `swing` · `salsa_bachata`). 세부 장르·종목은 받지 않는다(FR-011b). 둘 이상·그 밖의 값은 422 `VALIDATION_FAILED`(수용 ①)
- 사업자등록번호는 **비워도 된다**(수용 ⑤). 번호를 보냈으면 10자리 숫자와 체크섬만 본다(국세청 조회 없음). 등록증 파일은 가입 화면에서 고르더라도 앱이 가입·로그인 뒤 `POST /api/files`(07 §1)로 올리고 §2-3 으로 붙인다 — 가입 시점에는 세션이 없어 파일 경로를 열지 않는다
- 1년 무료 체험(FR-112e(강사 멤버십·1년 체험))의 체험 시작은 S6-1(`14-membership-benefits.md` §2 의 `trial_grants`·`membership`)이 정의하고, 이 트랜잭션이 그 함수를 부른다(CI 한 사람당 한 번). S6-1 전에는 `membership: null`(열린 점 ⑪)
- 광고성 알림 동의(선택)는 판본이 없어 `instructor_profiles.marketing_opt_in_at` 에 시각만 둔다(FR-146(광고성 알림 동의), 열린 점 ⑪)

| HTTP | code | 언제 |
|---|---|---|
| 409 | `INSTRUCTOR_ALREADY_REGISTERED` | 같은 CI(`uq_staff_accounts_ci` 부분 유니크가 최종 방어선). 응답은 1-1 과 같다 |
| 409 | `USERNAME_TAKEN` | 아이디 중복 |
| 422 | `CONSENT_REQUIRED` | 필수 동의 둘 중 하나라도 false |
| 422 | `INSTRUCTOR_UNDER_19` · `VALIDATION_FAILED` | 위와 같음 · 비밀번호가 8자 미만이거나 영문·숫자·기호가 섞이지 않았거나 아이디와 같음(`fields`) |
| 422 | `BUSINESS_NUMBER_INVALID` | 번호를 보냈는데 10자리·체크섬이 틀림 |

### 1-4. `POST /api/instructor/account-recovery/lookup` · `…/reset-password` (I31B)

찾는 수단은 **휴대폰 본인확인 하나뿐**이다(가입 때 이메일·전화번호를 받지 않는다). 강사 계정은 한 사람당 하나라 찾은 계정 하나를 보인다.

lookup 요청 `{ "verificationToken": "…" }` → 200
```json
{ "nameMasked": "이*호", "phoneMasked": "010-****-5821", "username": "junho_latin", "joinedOn": "2026-05-03",
  "academyNames": ["라틴하우스 강남"], "academyCount": 2 }
```
- 같은 CI 의 강사 계정이 없으면 404 `NOT_FOUND`(본인확인은 됐는데 강사로 가입한 적이 없다). 휴대폰 번호가 바뀌어도 CI 가 같으면 찾는다

reset-password 요청 `{ "verificationToken": "…", "newPassword": "…" }` → 200 `{ "ok": true, "sessionsRevoked": 2 }`
- 비밀번호 형식은 가입과 같다(422 `VALIDATION_FAILED`). 같은 트랜잭션에서 그 계정의 **모든 세션과 같은 기기 30일 기억(`trust_device`)을 끝낸다**(I31B 「바꾸면 다른 기기의 로그인은 모두 끝나요」). 감사 `staff.password_reset`(값은 남기지 않는다 — README §6-4 와 같은 원칙)
- 본인확인 토큰은 한 번 쓰면 재사용되지 않는다(`jti` 기록 — 같은 토큰으로 두 번 바꾸기 방지)

## 2. 강사 프로필 · 사업자 정보 · 개인 일정 — 권한 `instructor` (S2-1: FR-025 · FR-053 · I9 · I40 · I36)

| 메서드·경로 | 역할 | 멱등 | FR · 보드 |
|---|---|---|---|
| `GET /api/instructor/me/profile` | 내 프로필(마이·프로필 고치기) | 읽기 | FR-025 · I9 · I40 |
| `PUT /api/instructor/me/profile` | 프로필 저장(전체 교체) — 저장하면 대표 승인 없이 회원 화면에 바로 반영 | 상태 | FR-025 · I40 |
| `PUT /api/instructor/me/business-registration` | 사업자등록번호·등록증 넣기·고치기·비우기 | 상태 | FR-011 · FR-127(강사 프리랜서) · I9 |
| `POST /api/instructor/personal-events` | 개인 일정 넣기 | 키 | FR-053 · I36 |
| `DELETE /api/instructor/personal-events/{eventId}` | 개인 일정 지우기(반복이면 시리즈 전체) | 상태 | FR-053 · I36 |

### 2-1. `GET`·`PUT /api/instructor/me/profile`

200
```json
{ "accountId": "…", "displayName": "이준호", "activityGenre": "dance_sport",
  "photo": { "fileId": "…", "url": "https://…/files/…" } ,
  "careerYears": 10, "regions": [ { "sido": "서울", "gu": "강남구" }, { "sido": "서울", "gu": "서초구" } ],
  "qualifications": [ "댄스스포츠 지도자 2급" ], "competitions": [ "2025 서울 오픈 라틴 프로 4위" ],
  "bio": "라틴 10년, 대회 심사 경력이 있어요.",
  "disciplines": [ "rumba", "samba", "waltz" ],
  "businessRegistration": { "number": "1234567890", "hasEvidence": true } ,
  "affiliations": [ { "academyId": "…", "name": "라틴하우스 강남", "status": "active" } ] }
```
PUT 요청 — 위 표시 칸 가운데 `photoFileId` · `careerYears` · `regions` · `qualifications` · `competitions` · `bio`(≤500자) 만 받는다(전체 교체)
- `activityGenre` · `displayName` 이 요청에 있고 현재 값과 다르면 422 `ACTIVITY_GENRE_IMMUTABLE`(활동 장르는 가입 때만 고른다, FR-011b 2026-10-11) — 이름은 이 판에서 바꾸지 않는다
- `disciplines`(세부 장르·종목)는 **응답에만** 있다. 강사가 연 수업에서 저절로 채운다(I40 「수업 종목은 내가 연 수업에서 저절로 보여요」)
- 사진은 `POST /api/files`(07 §1) `purpose=instructor_photo`(공개) 로 올린 `fileId` 만 받는다. 남의 파일·다른 목적의 파일은 422 `VALIDATION_FAILED`. 자격·대회는 각 20개까지(**추천값**), 활동 지역은 `member_regions` 와 같은 시·구 값
- 소개 영상과 초상권 동의는 이 판에서 받지 않는다(열린 점 ⑥)
- 오류: 422 `VALIDATION_FAILED` · 422 `ACTIVITY_GENRE_IMMUTABLE`

### 2-2. `PUT /api/instructor/me/business-registration` (사업자 정보, 선택)

```json
{ "number": "1234567890", "evidenceFileId": "…" }
```
- 둘 다 `null` 이면 지운다(직원이면 비워 둔다는 안내와 맞다, I31). `evidenceFileId` 는 `purpose=business_registration_evidence`(비공개) 로 올린 본인 파일. 번호 없이 파일만은 422(`ck_instr_profiles_brn_file`)
- 200 `{ "number": "1234567890", "hasEvidence": true }` · 오류 422 `BUSINESS_NUMBER_INVALID` · 422 `VALIDATION_FAILED`. 감사 `instructor.business_registration_changed`(번호는 끝 4자리만 남긴다)
- 정산에 영향이 있다(사업자면 계산서·정산, 아니면 3.3% 원천징수, FR-127). 적용 시점은 S5-1 이 정한다

### 2-3. 개인 일정 (FR-053 · I36 — 멤버십 기능)

`POST /api/instructor/personal-events` — 요청
```json
{ "title": "개인 연습", "startsAt": "2026-11-12T05:00:00Z", "endsAt": "2026-11-12T07:00:00Z", "repeat": "weekly" }
```
201
```json
{ "eventId": "…", "title": "개인 연습", "startsAt": "…Z", "endsAt": "…Z", "repeat": "weekly",
  "overlaps": [ { "kind": "class_session", "label": "쌈바(입문)", "overlapMinutes": 60 } ] }
```
- `repeat` = `none` · `weekly` · `daily`. 시작·끝은 10분 단위(그 밖은 422 `VALIDATION_FAILED`)
- **막지 않고 알린다**: 수업·개인 레슨과 겹치면 무엇과 몇 분 겹치는지 `overlaps` 로 돌려주고 저장은 한다(I36 「넣기 전에 알려 줘요」). 겹침 안내는 저장 **전** 확인용으로 `POST /api/classes/schedule-check`(§4-1)의 `existing` 을 쓴다
- 개인 일정은 강사에게만 보인다. 학원 시간표·대표 캘린더에는 제목 없이 「불가 시간」, 대타 후보에서는 「그 시간에 일정이 있어요」로만 나타난다(§8 · §4-1 의 규칙)
- 멤버십이 끝났으면 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED`(`14-membership-benefits.md` §2 의 `features` 판정 함수 — S6-1 전에는 항상 통과). 넣어 둔 일정은 지우지 않는다(I36B)
- `DELETE` → 204. 남의 일정은 404 `NOT_FOUND`. 반복 일정의 한 날만 지우기는 만들지 않는다(보드에 없다, 열린 점 ③)

## 3. 소속 보조 — 학원 찾기 · 학원 색 · 해제 요청 (S2-1: FR-071 · FR-082 · I27 · I12 · I9E · I28)

소속 신청·초대 수락·신청 취소·상태 카드는 **08 §2** 가 정했다. 이 절은 그 화면이 쓰는 나머지 경로다.

| 메서드·경로 | 권한 | 역할 | 멱등 | 보드 |
|---|---|---|---|---|
| `GET /api/instructor/academies?q=&limit=` | `instructor` | 학원 검색(I27 소속 신청 · I10B 개인 레슨 학원 · I2 소속 학원 고르기) | 읽기 | I27 · I10B · I2 |
| `PUT /api/instructor/affiliations/{affiliationId}/color` | `instructor`(본인 소속) | 학원 색 바꾸기 | 상태 | I12 · I9E |
| `POST /api/instructor/affiliations/{affiliationId}/release-preview` | `instructor`(본인 소속) | 해제 확인 시트의 남은 회차·받는 회원 미리 계산 | 읽기 | I28 · I28B |
| `POST /api/instructor/affiliations/{affiliationId}/release-requests` | `instructor`(본인 소속) | 소속 해제 요청 | 키 | FR-082 · I28 · I28B |
| `POST /api/instructor/affiliation-release-requests/{requestId}/withdraw` | `instructor`(본인 요청) | 해제 요청 취소 | 상태 | I28 |
| `GET /api/instructor/affiliations/{affiliationId}/rooms` | `instructor`(본인 `active` 소속 + 위임 `class_submit`) | 수업 등록 때 고를 그 학원의 홀(강의실) 목록 | 읽기 | FR-050 · I2 |

### 3-1. `GET /api/instructor/academies?q=라틴`

```json
{ "items": [ { "academyId": "…", "name": "라틴하우스 강남", "region": { "sido": "서울", "gu": "강남구" }, "genres": ["dance_sport"],
               "affiliation": { "affiliationId": "…", "status": "active" },
               "canSubmitClass": true, "canOpenPrivateLesson": true },
             { "academyId": "…", "name": "라틴 아카데미 홍대", "region": { "sido": "서울", "gu": "마포구" }, "genres": ["dance_sport","salsa_bachata"],
               "affiliation": null, "canSubmitClass": false, "canOpenPrivateLesson": false } ] }
```
- `active` 학원만 나온다(`restricted`·종료 중인 학원은 새 소속 신청·새 수업을 받지 않는다 — 08 의 409 `ACADEMY_NOT_ACCEPTING` 과 같은 판정). 이름 부분 일치·시·구로 찾는다
- `affiliation.status` = `pending`(승인 대기) · `active`(소속됨) · `rejected`(거절됨, 다시 신청 가능) · `released` · null(없음). 이미 소속이거나 대기 중이면 화면이 고를 수 없게 한다(I27)
- `canSubmitClass` = 이 요청 면의 위임 권한(앱 `class_submit`, 웹 `class_manage`). 꺼져 있으면 I2 가 「등록 권한 없음」으로 보인다. `canOpenPrivateLesson` = `active` 소속이면 true
- `genres` 는 그 학원의 공개 수업 장르를 모은 값(공개 수업이 없으면 빈 배열)

### 3-2. `PUT /api/instructor/affiliations/{id}/color`

`{ "colorIndex": 3 }` → 200 `{ "affiliationId": "…", "colorIndex": 3 }`. 값은 0~11(12색, I9E). 소속이 `active` 가 아니면 409 `AFFILIATION_STATE_CONFLICT`(08). 승인 때 강사가 아직 안 쓴 가장 작은 번호가 자동으로 들어간다(**추천안**)

### 3-3. 소속 해제 요청 (강사 시작, FR-082)

`POST …/release-preview` 와 `…/release-requests` 의 요청·응답 모양은 §9 의 대표 쪽 경로와 **같은 서비스**를 쓴다. 강사 쪽 요청:
```json
{ "sessionChoices": [ { "sessionId": "…", "action": "substitute" }, { "sessionId": "…", "action": "close" } ],
  "privateLessonChoices": [ { "passId": "…", "action": "finish_first" } ], "note": "개인 사정으로 그만둬요" }
```
- 회차 선택값: `substitute`(대체 강사) · `cancel_session`(휴강) · `close`(폐강). 개인 레슨 수강권 선택값: `finish_first`(해제 전에 마치기) · `refund` · `handover`(다른 강사에게) — 환불 금액은 학원 대표가 정한다(FR-052c)
- **요청만 만든다.** `affiliation_release_requests` 1행 + 대표 알림 `release_requested`(category `approval`, `dedupe_key = release:<requestId>:requested`, payload 강사 이름·남은 회차 수)를 같은 트랜잭션에 쓴다. 소속은 그대로 `active` 이고, 해제는 대표가 §9 의 `release` 로 끝낸다(Task S2-1.4 「요청 기록만 만든다」, 열린 점 ①). 강사가 고른 값은 대표 화면(W3b·O39)의 선택칸에 미리 채워지는 의향이다. 대체 강사는 대표가 정한다(I28 「대체 강사는 대표가 정해요」)
- 201 `{ "requestId": "…", "status": "requested", "requestedAt": "…Z", "remainingSessionCount": 3 }`
- `release-preview` 응답에는 남은 회차 목록 · 회차별 받는 회원(이름·결제/수강권 구분) · 합계가 들어간다(§9-1)

| HTTP | code | 언제 |
|---|---|---|
| 409 | `RELEASE_REQUEST_OPEN` | 이 소속에 열린 요청이 이미 있다(`uq_release_req_open`). 같은 `Idempotency-Key` 면 200 처음 것 |
| 409 | `AFFILIATION_STATE_CONFLICT` | 소속이 `active` 가 아님(08) |
| 409 | `RELEASE_HAS_REMAINING_SESSIONS` | 남은 회차·수강권 중 `sessionChoices`·`privateLessonChoices` 에 없는 것이 있다. `undecided` 에 id 목록(I28 「정하기 전엔 해제 못 해요」) |
| 422 | `VALIDATION_FAILED` | `substitute` 인데 시각이 지난 회차 등 |

`…/withdraw` → 200 `status: "withdrawn"`. 이미 `completed` 면 409 `AFFILIATION_STATE_CONFLICT`.

### 3-4. `GET /api/instructor/affiliations/{id}/rooms` (2026-11-21 사용자 결정, S2-2.9 막힘 해소)

강사가 수업 등록(I2)에서 홀을 고르는 목록이다. 이 경로가 없으면 `submit` 이 늘 422 「홀을 골라 주세요」로 끝난다.

```json
{ "items": [ { "roomId": "…", "branchName": "강남점", "name": "A홀" }, { "roomId": "…", "branchName": "강남점", "name": "B홀" } ] }
```
- 그 소속 학원 지점들의 `rooms` 중 `active` 인 것만, 지점 이름 → 홀 이름 순
- 소속이 본인 것이 아니면 404 `NOT_FOUND`(남의 소속 id 가 있는지 드러내지 않는다). `active` 가 아니면 409 `AFFILIATION_STATE_CONFLICT`(08). 위임 `class_submit` 이 꺼져 있으면 403 `FORBIDDEN`
- `Cache-Control: no-store`

## 4. 수업 등록 · 대표 승인 · 게시 (S2-2: FR-050 · FR-050a · FR-051 · FR-052a · FR-057 · FR-054 · FR-072 · FR-076 · FR-092 · FR-092c · FR-099b · FR-099d)

수업 만들기는 두 단계다(I2 → I2D·I2E). 값의 원본은 `registration_payload` 이고, **승인 요청(`submit`) 때** 회차·판매 단위·자리 묶음이 만들어진다(데이터 §8 머리). 상태: `draft` → `pending_approval` → `published`(§4-6).

| 메서드·경로 | 권한 | 역할 | 멱등 | FR · 보드 |
|---|---|---|---|---|
| `GET /api/instructor/classes?status=&academyId=&cursor=` | `instructor` | 내 수업 목록(공개·승인 중·임시 저장) | 읽기 | FR-050a · I19 · I19B |
| `POST /api/classes/schedule-check` | `class_writer` | 요일·시간 입력 중 겹침·회차 수 미리 계산(쓰지 않음) | 읽기 | FR-054 · FR-057 · I2C |
| `POST /api/classes` | `class_writer` | 임시 저장 만들기 | 키 | FR-050 · I2 · I44 |
| `GET /api/classes/{classId}` | 올린 사람 · 대표 | 수업 등록 상세(승인 화면·등록한 수업·수정 요청 받은 수업) | 읽기 | FR-050a · I2S · I33 · I24 · O5 |
| `PUT /api/classes/{classId}` | 올린 사람(`draft` 만) · 대표 | 임시 저장 고치기(전체 교체) | 상태 | FR-050 · I2D · I2E · I33 |
| `POST /api/classes/{classId}/submit` | `class_writer` | 수업 등록(승인 요청) · 고쳐서 다시 등록 | 상태 | FR-050a · FR-076 · I2D · I2E · I33 |
| `POST /api/classes/{classId}/withdraw` | 올린 사람 | 등록 취소 → 임시 저장 | 상태 | FR-050a · I2S |
| `PUT /api/classes/{classId}/poster` | 올린 사람 · 대표 | 수업 포스터 붙이기·바꾸기 | 상태 | FR-050 · FR-076 · W30 |
| `GET /api/classes/{classId}/sessions` | 올린 사람 · 대표 | 회차 목록 | 읽기 | FR-055 · I6B |
| `GET /api/academies/{academyId}/class-approvals?status=&cursor=` | `owner` | 승인 대기 목록(신규 등록 + 수정 요청) | 읽기 | FR-050a · O5 · O21 |
| `POST /api/academies/{academyId}/classes/{classId}/approve` | `owner` | 승인 → 공개 | 상태 | FR-050a · FR-076 · O5 |
| `POST /api/academies/{academyId}/classes/{classId}/request-revision` | `owner` | 수정 요청(사유) → 강사의 임시 저장 | 상태 | FR-050a · O5 |

`GET /api/instructor/classes` 항목: `{ "classId", "title", "status", "academyId", "academyName", "roomName", "weekdays", "startTime", "endTime", "periodFrom", "periodTo", "priceAmount", "isFree", "seats": { "male": { "confirmed": 9, "capacity": 10 }, "female": { "confirmed": 10, "capacity": 10 }, "any": null }, "waitlistCount": null, "revisionReason": "금액을 한 번 더 확인해 주세요" }` — `status` 칩 거르기는 `draft`(임시 저장) · `pending_approval`(승인 중) · `published`(공개), 대기 인원(`waitlistCount`)은 S4-4 가 생기기 전에는 `null`. 위임 강사는 자기가 올린 수업만 나온다. `status` 를 안 주면 전체(`cancelled` 제외).

공개된 수업을 **회원이 보는** 경로는 `02-catalog.md` 다. 그 목록은 `classes.status = 'published'` 이고 판매 단위가 `open` 인 것만 읽도록 맞춘다(열린 점 ⑫). 대표 승인 알림의 휴대폰 푸시(O5P)는 S7-1 이 `NotificationSenderPort` 로 보내고, 이 계약은 알림 **행**까지 쓴다.

### 4-1. `POST /api/classes/schedule-check` (입력 중 · 쓰지 않음)

I2C 가 요일·시각을 고를 때마다 부르고, I2 의 저장 전 확인에도 쓴다(FR-054 겹침 세 번 막기 ①②). 마지막 판정은 `submit` 의 DB 제약이다.
```json
{ "academyId": "…", "roomId": "…", "excludeClassId": null,
  "schedule": { "kind": "recurring", "weekdays": ["mon","wed"], "startTime": "20:30", "endTime": "21:30",
                "periodFrom": "2026-11-02", "periodTo": "2026-12-23" } }
```
200
```json
{ "sessionCount": 16, "firstStartsAt": "2026-11-02T11:30:00Z", "lastEndsAt": "2026-12-23T12:30:00Z",
  "existing": [ { "weekday": "mon", "startTime": "19:30", "endTime": "20:30", "label": "룸바(중급)" },
                { "weekday": "wed", "startTime": "18:00", "endTime": "19:00", "label": "다른 학원 일정" } ],
  "conflicts": [], "roomConflicts": [],
  "suggestions": [ { "weekday": "mon", "startTime": "20:30", "endTime": "21:30" } ] }
```
- `schedule.kind` = `recurring`(요일 여러 개·기간) · `single`(`date` · `startTime` · `endTime` — 이벤트형). 시각은 KST, **10분 단위만**(`20:35` 는 422 `VALIDATION_FAILED`), 끝이 시작보다 늦어야 한다. 반복 수업은 `weekdays` 1개 이상, `periodFrom ≤ periodTo`, 첫 회차는 미래, 회차 수 1~200(**추천값**)
- `existing` = 고른 요일에 이미 있는 이 강사의 일정. 수업·개인 레슨은 이름까지, **다른 학원 일정은 「다른 학원 일정」으로만**(FR-054 ①), 개인 일정은 제목까지 보인다(본인에게만)
- `conflicts` = 입력한 시간과 겹치는 것(수업·개인 레슨 시간 — 개인 일정은 여기에 넣지 않는다, 열린 점 ②) `[{ "startsAt", "endsAt", "overlapMinutes": 30, "label": "룸바(중급)" }]`. `roomConflicts` = 그 홀의 같은 시간 수업. `suggestions` = 가까운 빈 시간 2~3개(칩, FR-054 ②)
- 대표가 대신 올릴 때(담당 강사를 고른 경우) `existing`·`conflicts` 의 `label` 은 **「강사 일정」**으로만 나온다(개인 레슨은 대표도 못 본다, FR-052c)
- 이 경로는 읽기다. 회차를 만들지 않는다

### 4-2. `POST /api/classes` (임시 저장 만들기) · `PUT /api/classes/{classId}` (고치기)

`Idempotency-Key` 필수. 임시 저장은 **학원 · 수업 구분 · 수업명**만 있으면 만들 수 있다(**추천안**). 나머지 칸은 비어도 된다.
```json
{ "academyId": "…", "classKind": "regular", "title": "쌈바(입문) · 11월",
  "genre": "dance_sport", "subGenre": "latin", "discipline": "samba",
  "targetLevel": "entry", "targetAges": ["all"],
  "roomId": "…", "priceAmount": 300000,
  "schedule": { "kind": "recurring", "weekdays": ["mon","wed"], "startTime": "20:30", "endTime": "21:30",
                "periodFrom": "2026-11-02", "periodTo": "2026-12-23" },
  "capacity": { "mode": "gender_split", "male": 10, "female": 10 },
  "refundDeadlineOn": null, "introText": null, "instructorAccountId": null }
```
201 `ClassRegistration`(아래). 같은 `Idempotency-Key` 면 200 처음 것.

`ClassRegistration`
```json
{ "classId": "…", "academyId": "…", "academyName": "라틴하우스 강남", "status": "draft",
  "classKind": "regular", "title": "쌈바(입문) · 11월",
  "genre": "dance_sport", "subGenre": "latin", "discipline": "samba",
  "targetLevel": "entry", "targetAges": ["all"],
  "room": { "roomId": "…", "name": "A홀" },
  "schedule": { "kind": "recurring", "weekdays": ["mon","wed"], "startTime": "20:30", "endTime": "21:30",
                "periodFrom": "2026-11-02", "periodTo": "2026-12-23", "sessionCount": 16 },
  "capacity": { "mode": "gender_split", "male": 10, "female": 10, "any": null },
  "priceAmount": 300000, "isFree": false, "refundDeadlineOn": null,
  "refundNotice": { "versionId": "…", "kind": "regular", "version": 3, "content": { "cancellableUntil": "수강 시작 전까지 언제든", "tiers": [ … ], "nonRefundableCases": "…", "processingBusinessDays": 5, "ownerContact": "…" }, "readOnly": true },
  "instructor": { "accountId": "…", "displayName": "이준호" },
  "posterUrl": null, "introText": null,
  "revisionRequest": { "reason": "금액을 한 번 더 확인해 주세요", "at": "2026-11-09T05:20:00Z" },
  "pendingEdit": null, "paidCount": 0,
  "submittedAt": null, "approvedAt": null, "createdAt": "…Z", "updatedAt": "…Z" }
```
- **수업 구분**(FR-051) 9종은 `classKind`. `private_lesson` 은 이 경로로 못 만든다(422 `VALIDATION_FAILED`, §10 의 경로를 쓴다 — 개인 레슨은 승인 대상이 아니다). 베이직·레이디 스타일은 정규로 본다(환불 공지는 `regular` 판본)
- **장르 칸**(FR-011b·FR-050): `genre` 는 **올리는 강사의 활동 장르와 같아야** 한다(대표가 올릴 때는 담당 강사의 활동 장르). 다르면 422 `GENRE_NOT_ALLOWED`. `dance_sport` 면 `subGenre`(`latin`·`standard`)와 `discipline`(그 쪽의 종목 **하나**, D11: 스탠다드는 `waltz` · `tango` · `viennese_waltz` · `slow_foxtrot` · `quickstep`) 필수, `salsa_bachata` 면 `subGenre`(`salsa`·`bachata`)만, 나머지 두 장르는 둘 다 `null`(열린 점 ④). 짝이 안 맞으면 422 `VALIDATION_FAILED`
- 요청에 `refundNotice`·`status`·`paidCount` 같은 읽기 전용 칸이 있으면 **무시한다**(수용 ① 「강사가 공지 값을 보내도 무시된다」). 응답의 `refundNotice` 는 임시 저장 중에는 그 학원의 **최신** 판본이고, `submit` 때 판본 id 가 고정된다(`classes.refund_notice_version_id`). 본문을 수업에 복사하지 않는다(S2-2.5)
- `capacity.mode` = `gender_split`(`male`·`female` 둘 다, 합이 0 이면 등록 불가 — FR-092) · `single`(`any` 하나, FR-092c). 칸은 숫자 직접 입력과 버튼 둘 다로 정하지만 서버는 정수만 본다. 0 미만은 422
- `schedule` 이 요일 규칙이면 서버가 규칙 그대로 회차 날짜를 계산한다(KST 달력 → UTC 저장, FR-057). 이벤트형(`one_day` · `event` · `party` · `performance` · `competition`)은 `kind: "single"` 만 받는다(회차 1개, 열린 점 ⑦)
- `priceAmount` 0 은 **무료 수업**이다(I44, `isFree: true`). 같은 승인 흐름을 타고(수용 ⑤), 환불 마감일·취소 수수료·예매 수수료를 받지 않으며 이벤트형 공지 판본도 붙이지 않는다(FR-099d 「무료(0원) 행사」)
- `refundDeadlineOn`(KST 날짜): 이벤트형이고 금액이 0 보다 크면 **필수**, 정규 계열은 보내도 무시. 개최일(첫 회차의 KST 날짜) 당일이거나 그 이전이어야 한다
- `targetAges` 는 1개 이상 필수(FR-028): `all` · `gen_2030` · `gen_4050` · `gen_5060`. `all` 이 있으면 다른 값과 함께 올 수 없다. `targetLevel`(`entry`~`advanced`)은 이벤트형이 아니면 필수, 이벤트형은 생략하면 레벨 무관
- `roomId` 는 그 학원 지점의 강의실(`rooms`, `active`)이어야 한다. 다른 학원 홀이면 422
- 등록한 뒤 **학원은 바꿀 수 없다**(결제가 그 학원으로 들어간다, FR-050). `PUT` 에서 `academyId` 가 달라지면 422 `CLASS_FIELD_LOCKED`
- `PUT` 은 `draft` 일 때만이다. `pending_approval` 이면 409 `CLASS_STATE_CONFLICT`(「등록 취소」를 먼저), `published` 면 §5 의 수정 요청을 쓴다. 임시 저장 때도 겹침을 확인하고(`conflicts` 가 있으면 409 `SCHEDULE_CONFLICT`, 「겹친 채로 저장하는 버튼은 없다」), 판정의 마지막은 `submit` 이다
- 대표가 올릴 때는 `instructorAccountId`(담당 강사, 그 학원 `active` 소속)가 필수이고, 강사가 올릴 때는 자신으로 고정된다(다른 값은 422)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `AFFILIATION_REQUIRED` | 그 학원 `active` 소속이 아님 |
| 403 | `CLASS_PERMISSION_REQUIRED` | 소속은 있는데 이 면의 위임 권한이 꺼져 있음(앱 `class_submit` · 웹 `class_manage`). 끄면 **그 즉시** 새 수업을 못 올린다 — 이미 공개된 수업·결제는 그대로(FR-011a) |
| 403 | `FORBIDDEN` | 다른 학원 대표·남의 수업 |
| 404 | `NOT_FOUND` | 없는 수업 |
| 409 | `ACADEMY_RESTRICTED` | 학원이 `restricted`(README §6-2 #8) — 새 게시 거부. 임시 저장은 된다 |
| 409 | `PROMO_REVIEW_REQUIRED` | AI 가 만든 홍보 표지·소개 문구(16 §4-7 `promo-assets`)가 검토 확인 없이 승인 요청·대표 승인에 들어옴 — 수업 상태는 그대로(SX-6.7 (추천안·사후 확인 2026-11-24)) |
| 409 | `SCHEDULE_CONFLICT` | 강사 겹침(§4-3). `ROOM_CONFLICT`: 강의실 겹침(FR-072) |
| 409 | `CLASS_STATE_CONFLICT` | 상태가 맞지 않음 |
| 422 | `VALIDATION_FAILED` · `GENRE_NOT_ALLOWED` · `CLASS_FIELD_LOCKED` | 위 |
| 422 | `REFUND_DEADLINE_REQUIRED` · `REFUND_DEADLINE_AFTER_START` | `submit` 때: 이벤트형(금액 0 초과)인데 환불 마감일이 없다 · 개최일(첫 회차의 KST 날짜) 다음 날 이후다(수용 ②) |

### 4-3. 겹침 판정 · 오류 응답

`submit`(과 임시 저장)에서 겹치면 409
```json
{ "detail": "15:00 쌈바(입문)과 30분 겹쳐요", "code": "SCHEDULE_CONFLICT",
  "conflicts": [ { "startsAt": "…Z", "endsAt": "…Z", "overlapMinutes": 30, "label": "쌈바(입문)" } ],
  "suggestions": [ { "weekday": "mon", "startTime": "21:30", "endTime": "22:30" } ] }
```
- 같은 강사의 두 회차는 **학원이 달라도** 거부된다(수용 ④, SC-009(강사 중복 배정 0건)). 판정의 마지막은 DB `ex_sessions_instructor`·`ex_sessions_room` 이고, 앱은 같은 강사의 트랜잭션 잠금 안에서 먼저 확인해 안내문을 만든다(데이터 §8 머리). 학원 사이 이동 여유 시간은 두지 않는다(2026-10-11)
- 개인 레슨 「레슨 모집」 시간과의 겹침도 같은 강사 기준으로 거부한다. **대표가 올리는 경우** 응답은 `detail: "강사 일정과 겹쳐요"`, `conflicts: []` 로 **무엇과 겹치는지 밝히지 않는다**(FR-052c, 개인 레슨은 대표도 볼 수 없다). 개인 일정은 거부 사유가 아니다(열린 점 ②)

### 4-4. 승인 요청 · 취소

`POST /api/classes/{classId}/submit` — 요청 `{}`. 한 트랜잭션:
1. 마지막 검증(필수 칸 · 장르 = 활동 장르 · 환불 마감일 · 겹침) — 모자라면 422 `VALIDATION_FAILED` + `fields`
2. **게시 판정**: 학원 `restricted` → 409 `ACADEMY_RESTRICTED` · 환불·취소 공지 판본이 없으면 409 `NOTICE_MISSING`(정규 계열은 `regular`, 금액이 있는 이벤트형은 `event`. FR-246(규정 없는 학원 게시 차단))
3. `class_offerings`(`closed`) · `class_sessions` · `seat_pools` 생성, 환불 공지 판본 id 고정, 승인 기록 `submitted`(대표가 올리면 `auto_published` 이고 곧바로 공개 — 아래)
4. 대표 알림 `class_submitted`(category `approval`, `dedupe_key = class:<classId>:rev<n>:submitted`, payload: 강사 이름 · 수업명 · 요일 시간 · 기간 · 수강료 — O5P 문구 재료)

200/201 `ClassRegistration`(`status: "pending_approval"`). 이미 `pending_approval` 이면 200 같은 본문. **대표 본인이 올린 수업은 승인 없이 곧바로 `published`** 다(FR-050a). 개인 레슨은 이 경로를 쓰지 않는다.

`POST /api/classes/{classId}/withdraw`(등록 취소, 올린 사람만) → `pending_approval` → `draft`, 만든 회차·판매 단위·자리 묶음 삭제, 승인 기록 `withdrawn`. 대표의 승인 대기 목록에서 빠지고 알림 `class_submitted` 의 행동은 「이미 취소됨」으로 읽힌다. 이미 `draft` 면 200 같은 본문, 그 밖은 409 `CLASS_STATE_CONFLICT`.

### 4-5. 대표 승인 · 수정 요청

`GET /api/academies/{academyId}/class-approvals?status=pending` (O5 목록 · 대시보드의 `pendingClassApprovals` 타일 원천)
```json
{ "items": [ { "kind": "new", "classId": "…", "title": "쌈바(입문) · 11월", "instructorName": "이준호", "genre": "dance_sport",
               "classKind": "regular", "weekdays": ["mon","wed"], "startTime": "20:30", "endTime": "21:30",
               "periodFrom": "2026-11-02", "periodTo": "2026-12-23", "priceAmount": 300000, "roomName": "A홀",
               "submittedAt": "…Z", "waitingHours": 3 },
             { "kind": "edit", "editRequestId": "…", "classId": "…", "title": "쌈바(입문) · 11월", "changedFields": ["priceAmount"],
               "paidCount": 19, "submittedAt": "…Z", "waitingHours": 20 } ],
  "nextCursor": null }
```
- 위임 강사·강사는 이 경로를 못 쓴다(403 `FORBIDDEN`). 오래 기다린 순서로 보인다

`POST /api/academies/{academyId}/classes/{classId}/approve` — 요청 `{}`, `Idempotency` 는 상태가 근거
- `UPDATE classes SET status='published', approved_at=now() … WHERE id=$1 AND academy_id=$2 AND status='pending_approval'` 과 판매 단위 `closed → open` 을 **한 트랜잭션**에서(FR-076 「검색 노출·예약 슬롯·결제 상품이 함께」 — 셋 중 일부만 생긴 상태가 남지 않는다). 승인 때 게시 판정(`restricted`·공지·이벤트형 마감일)을 한 번 더 한다(공지가 그 사이 사라질 일은 없지만 마감일이 지난 경우를 막는다)
- 200 `ClassRegistration`(`status: "published"`) · 이미 `published` 면 200 같은 본문 · 영향 0 행이고 다른 상태면 409 `CLASS_STATE_CONFLICT`
- 알림: 강사에게 `class_approved`(category `operations`, 「승인됐어요」, `dedupe_key = class:<id>:rev<n>:approved`) · 감사 `class.approved`
- 승인 화면(O5)은 `GET /api/classes/{classId}` 를 읽는다(수업명·장르·구분·레벨·요일·시간·기간·학원·홀·정원·금액·강사)

`POST /api/academies/{academyId}/classes/{classId}/request-revision` — 요청 `{ "reason": "금액을 한 번 더 확인해 주세요" }`
- 사유 1~200자 필수(없으면 422 `VALIDATION_FAILED`, O5 「사유를 적어야 보낼 수 있어요」). `pending_approval` → `draft` + 회차·판매 단위 삭제 + `classes.last_revision_reason` 저장 + 승인 기록 `revision_requested` + 강사 알림 `class_revision_requested`(사유 포함, I33) — 한 트랜잭션. 대표의 승인 대기 목록에서 빠진다
- 200 `ClassRegistration`(`status: "draft"`, `revisionRequest` 채워짐). 강사는 칸을 고쳐 `PUT` 뒤 `submit` 한다(「고쳐서 다시 등록」, 홍보 이미지·소개 문구는 그대로). 대표가 칸을 고르는 기능은 없다 — 사유 문장만 간다
- 이미 `draft` 이고 같은 사유면 200 같은 본문, 다른 상태면 409 `CLASS_STATE_CONFLICT`

### 4-6. 포스터 · 회차 목록

`PUT /api/classes/{classId}/poster` — `{ "fileId": "…" }`(`POST /api/files` `purpose=poster`, 공개). 어느 상태에서나 바뀌고(「바로 바뀌는 값」, I24) 승인 흐름을 타지 않는다. 비우려면 `null`. 200 `{ "classId": "…", "posterUrl": "https://…" }`. 포스터에서 칸을 읽어 초안을 채우는 일(SX-2)은 이 경로와 별개다(열린 점 ⑭). 감사 `class.updated`

`GET /api/classes/{classId}/sessions`
```json
{ "items": [ { "sessionId": "…", "seq": 1, "startsAt": "…Z", "endsAt": "…Z", "status": "scheduled",
               "room": { "roomId": "…", "name": "A홀" },
               "instructor": { "accountId": "…", "displayName": "이준호" }, "isSubstitute": false,
               "confirmedMemberCount": 19, "substituteRequest": null } ] }
```
`confirmedMemberCount` 는 그 회차의 `calendar_entries` 로 센 서로 다른 회원 수다(결제 완료만 — 결제 대기·대기 신청은 센 적 없다). 회원 이름·연락처는 이 경로에 없다.

### 4-7. 수업 상태 전이

| 지금 | 사건 | 다음 | 부수 효과 |
|---|---|---|---|
| `draft` | `submit`(강사) | `pending_approval` | 회차·판매 단위(`closed`)·자리 묶음 생성 · 공지 판본 고정 · 대표 알림 |
| `draft` | `submit`(대표 본인) | `published` | 위와 같고 판매 단위 `open` · 승인 기록 `auto_published` |
| `pending_approval` | `withdraw`(강사) | `draft` | 만든 행 삭제 |
| `pending_approval` | `request-revision`(대표) | `draft` | 만든 행 삭제 · 사유 저장 · 강사 알림 |
| `pending_approval` | `approve`(대표) | `published` | 판매 단위 `open` · 강사 알림 |
| `published` | 모든 회차 폐강(§6-3) | `cancelled` | — |

모든 전이는 조건부 갱신 한 문장이고, 승인 기록(`class_approvals`)과 감사 행(`class.submitted` 등)을 같은 트랜잭션에 쓴다. 승인 후 24시간 동안 답이 없으면 대표에게 같은 푸시 알림을 **한 번만** 더 보낸다(FR-050a): 시간 작업 `class-approval-reminders`(§12).

## 5. 공개 뒤 수업 수정 (S2-3: FR-050a · Q38(수업 수정 제한) · O-05 · I24)

| 메서드·경로 | 권한 | 역할 | 멱등 | 보드 |
|---|---|---|---|---|
| `POST /api/classes/{classId}/edit-requests` | 올린 사람 · 대표 | 공개된 수업 고치기(승인이 필요한 값은 대표 재승인으로) | 키 | I24 |
| `POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw` | 올린 사람 | 승인 요청 취소 | 상태 | I24 |
| `POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve` | `owner` | 수정 승인 | 상태 | O5 |
| `POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject` | `owner` | 수정 반려(사유) | 상태 | O5 |

요청 `{ "changes": { "priceAmount": 320000, "capacity": { "male": 10, "female": 10 }, "schedule": { … }, "introText": "…", "posterFileId": "…" } }` — 보낸 칸만 바뀐다(`published` 수업에만).

값의 세 갈래(I24, Q38 임시 확정):

| 갈래 | 칸 | 처리 |
|---|---|---|
| **바로 바뀌는 값** | 소개 문구(`introText`) · 포스터(`posterFileId`) | 승인 없이 `classes` 에 쓰고 감사 `class.updated` |
| **대표 재승인이 필요한 값** | 금액(`priceAmount`) · 요일·시간·기간(`schedule`) · 정원(`capacity`) | `class_edit_requests` 1행(`pending`). **승인을 기다리는 동안 회원에게는 고치기 전 값이 그대로 공개된다.** 승인되면 새 값 |
| **바꿀 수 없는 값** | 소속 학원 · 장르·세부 장르·종목 · 수업 구분 | 422 `CLASS_FIELD_LOCKED` — 「다른 수업이 돼요, 새로 등록해 주세요」 |

응답
- 바로 바뀌는 값만 있으면 200 `{ "applied": "immediate", "class": ClassRegistration }`
- 재승인이 필요한 값이 있으면 201 `{ "applied": "pending_approval", "immediateApplied": ["introText"], "editRequest": { "editRequestId": "…", "status": "pending", "changes": { … }, "before": { … }, "impact": { "paidCount": 19, "notifyOnApprove": true } } }` — 두 갈래가 섞이면 바로 바뀌는 값은 지금 쓰고 나머지만 대기한다
- 수업당 열린 수정 요청은 하나다. 둘째는 409 `EDIT_REQUEST_OPEN`(같은 `Idempotency-Key` 면 200 처음 것)

규칙(O-05, 수용 ③④):
- **정원은 이미 잡힌 자리 아래로 못 줄인다.** 남·여(또는 `any`) 각 묶음의 새 정원 ≥ `held_count + confirmed_count` 여야 한다. 모자라면 422 `CAPACITY_BELOW_RESERVED` + `{ "minimum": { "male": 9, "female": 10 } }`(I24 「이미 찬 자리(남 9 · 여 10) 아래로는 못 줄여요」). 요청 때 한 번, **승인할 때 한 번 더**(그 사이 자리가 찼을 수 있다) 검사한다. DB `ck_seat_pools_not_over` 가 마지막 방어선이다
- **금액은 이후 결제부터 적용된다.** 이미 낸 주문의 금액은 그대로다(`orders.price_breakdown`·`total_amount` 가 결제 시점 값 — FR-284(주문 시점 값 고정)). 금액 변경은 결제한 회원에게 알리지 않는다
- **요일·시간·기간**을 바꾸는 요청은 지금 회차 수를 바꾸지 못한다(시작 전 회차만 `seq` 순서로 새 규칙에 맞춰 시각을 바꾸고 지난 회차는 그대로 둔다). 회차 수가 달라지면 422 `EDIT_SESSION_COUNT_CHANGED`(열린 점 ⑬). 승인하면 결제한 수강생에게 **전후 값 알림**(회원 알림 `class_changed`, 못 오면 환불을 요청할 수 있는 길 포함)과 새 겹침 검사가 같은 트랜잭션에 들어간다. 겹치면 409 `SCHEDULE_CONFLICT`
- 이벤트형의 환불 마감일은 **늦추기만** 된다(FR-099d). 결제한 회원(`confirmed_count + held_count > 0`)이 있으면 앞당기기는 409 `REFUND_DEADLINE_ADVANCE_BLOCKED`. 환불 마감일 칸은 `changes.refundDeadlineOn` 으로 받고 재승인 값에 들어간다
- 결제한 회원이 없는 `published` 수업도 같은 흐름이다(승인 중 옛 값 공개). 장르·종목·구분을 결제 전에는 풀어 줄지는 열린 점이 아니다 — 풀지 않는다(**추천안**: Q38 문장은 결제한 수강생이 있는 경우만 말하지만 공개된 수업의 정체성이 바뀌면 안 된다)

`POST …/withdraw`(올린 사람) → `pending` → `withdrawn`, 200. 이미 처리됐으면 409 `CLASS_STATE_CONFLICT`.

`POST …/approve` — `pending` → `approved`: `classes`·`class_offerings`·`seat_pools` 에 새 값을 쓰고, 승인 기록 `edit_approved` · 강사 알림 `class_edit_approved` · (시간·기간 변경이면) 결제한 회원 알림 `class_changed` · 감사 `class_edit.approved`. 한 트랜잭션. 이미 `approved` 면 200 같은 본문. 정원 검사 실패면 409 `CAPACITY_BELOW_RESERVED`.
`POST …/reject` — `{ "reason": "…" }` 필수 → `rejected`, 옛 값 그대로, 강사 알림 `class_edit_rejected`(사유), 승인 기록 `edit_rejected`.

## 6. 회차 변경 · 휴강 · 폐강 · 강사 공지 (S2-3: FR-055 · FR-056 · FR-063 · FR-065 · Q40(회차 하나의 시간·장소 변경 승인) · Q16(휴강 환불·보강))

회차 하나의 시간·장소를 바꾸는 것은 **대표 승인이 필요 없다**(Q40 임시 확정). 이후 회차 전부를 바꾸는 것은 §5 의 수정 요청이다. 두 경로 모두 강사 멤버십이 끝나도 쓴다(FR-056 · I34). 권한은 그 수업의 올린 사람·담당 강사·`owner`(위임 강사는 자기 수업만).

| 메서드·경로 | 역할 | 멱등 | 보드 |
|---|---|---|---|
| `POST /api/classes/{classId}/sessions/{sessionId}/change-preview` | 시간·장소 변경 미리 보기(겹침 · 받는 회원 수) | 읽기 | I34 |
| `POST /api/classes/{classId}/sessions/{sessionId}/change` | 이 회차의 시간·장소 바꾸고 알림 | 키 | I34 |
| `POST /api/classes/{classId}/sessions/{sessionId}/cancel-preview` | 휴강·폐강 미리 보기(받는 회원 수 · 회원 선택 기한) | 읽기 | I25 |
| `POST /api/classes/{classId}/sessions/{sessionId}/cancel` | 이 회차만 휴강 · 이후 회차 모두 폐강 | 키 | I25 |
| `GET /api/classes/{classId}/announcement-recipients` | 공지 받는 사람 수(확정 수강생, 남·여) | 읽기 | I13 · I13B |
| `POST /api/classes/{classId}/announcements` | 수강생 공지 보내기 | 키 | I13 · I13B |
| `GET /api/classes/{classId}/announcements` | 보낸 공지 목록(강사·대표) | 읽기 | I13B |
| `GET /api/me/classes/{classId}/announcements` | 회원이 보는 수업 상세의 「강사 공지」 | 읽기 | M8C |

### 6-1. 시간·장소 변경 (I34)

`…/change-preview` · `…/change` 요청 `{ "startsAt": "2026-11-16T12:00:00Z", "endsAt": "2026-11-16T13:00:00Z", "roomId": "…" }`(바꿀 값만. 시각은 10분 단위, 시작 전 회차만)

preview 200
```json
{ "before": { "startsAt": "…Z", "endsAt": "…Z", "roomName": "A홀" }, "after": { "startsAt": "…Z", "endsAt": "…Z", "roomName": "B홀" },
  "conflicts": [], "roomConflicts": [], "notifyMemberCount": 19, "notifyOwner": true,
  "memberMessage": { "title": "수업 변경 · 쌈바(입문)", "body": "11/16 (월) 시간과 장소가 바뀌었어요 · 20:30–21:30 A홀 → 21:00–22:00 B홀", "refundHint": "이 시간에 못 오면 환불을 요청할 수 있어요" } }
```
change 200 — `{ "sessionId": "…", "status": "scheduled", "changeId": "…", "notifiedMemberCount": 19 }`. 한 트랜잭션:
- 겹침 확인(강사·강의실) → 회차 시각·`room_id` 갱신 → `session_changes`(`time_place`, 전후 값) → 그 회차의 `calendar_entries` 시각 갱신 → 결제 확정 회원 전원에게 알림 `session_time_place_changed`(전후 값 · 환불 요청 길 · `dedupe_key = sessionchange:<changeId>:<memberId>`) → 대표 알림 `instructor_session_changed`(category `operations`, 대표가 올리면 만들지 않는다) → 감사 `session.time_place_changed`
- 환불 금액은 강사가 정하지 않는다. 환불 요청은 대표가 받고 금액도 대표가 정한다(I34)
- 오류: 409 `SESSION_ALREADY_STARTED`(시작 시각이 지남) · 409 `SESSION_NOT_SCHEDULED`(이미 휴강·폐강) · 409 `SCHEDULE_CONFLICT`(§4-3, 대표가 부르면 개인 레슨 정보를 밝히지 않는다) · 409 `ROOM_CONFLICT` · 422 `VALIDATION_FAILED`(바뀐 게 없음 포함)

### 6-2. 휴강·폐강 (I25)

요청 `{ "scope": "this_session", "reason": "대회 심사 일정" }` — `scope` = `this_session`(이 회차만 휴강) · `this_and_following`(이 회차부터 이후 회차 모두 폐강). 결정은 강사가 한다(FR-065, 대표·시스템이 바꾸지 않는다). `reason` 은 수강생에게 보인다(1~100자, **추천값**)

preview 200
```json
{ "scope": "this_session", "sessionCount": 1, "notifyMemberCount": 19,
  "memberChoice": { "options": ["move_to_other_session","refund_session_amount"], "deadlineAt": "2026-11-25T05:00:00Z", "defaultOnExpire": "refund_session_amount" },
  "refundHint": { "perSessionAmountBasis": "결제액 ÷ 회차 수", "example": { "paid": 300000, "sessionTotal": 16, "amount": 18750 } },
  "settlementNote": "휴강 회차는 환불을 먼저 처리하고 정산에서 빠져요" }
```
cancel 200 — `{ "changeIds": ["…"], "batchId": "…", "status": "cancelled", "notifiedMemberCount": 19, "memberChoiceDeadlineAt": "…Z" }`
- `this_session` → 회차 `cancelled`(휴강) + `session_changes`(`cancelled`) + **같은 트랜잭션에서 S4-3 의 `openClosureChoices(sessionId)` 를 부른다**(`12-refund-cancel-waitlist.md` §4 — 그 회차를 포함한 확정 예약마다 선택 행과 알림 `closure_choice_open` 이 만들어진다). 회원이 고르는 기한은 그 함수가 정한 값(알린 날부터 7일, 안 고르면 환불 — Q16 임시 확정)을 `session_changes.member_choice_deadline_at` 에 같이 남기고, 환불 금액(결제액 ÷ 회차 수, 원 미만 올림 — FR-100(환불 정수 연산))과 옮기기·환불 처리는 S4-3 몫이다. 이 계약은 회차 상태·기록·휴강 알림 행까지다
- `this_and_following` → 이 회차와 이후 `scheduled` 회차를 모두 `closed`(폐강) + 회차마다 `session_changes`(`closed`, 같은 `batch_id`). 폐강은 옮길 회차가 없어 환불 선택 기한이 없다(남은 회차 수 × 결제액 ÷ 회차 수 환불, S4-3). 폐강으로 남은 회차가 하나도 없으면 수업 `published` → `cancelled`
- 회원 알림은 **회원마다 1건**(`session_cancelled` 또는 `class_closed`, 여러 회차가 묶여도 한 건, `dedupe_key = batch:<batchId>:<memberId>`). 대표 알림 `instructor_session_changed`(「강사가 이 회차를 휴강으로 처리했어요 · 수강생 6명에게 알림이 갔어요」, O21B)
- 이벤트·원데이·파티·공연·대회의 행사 취소는 이 경로가 아니라 대표의 행사 일괄 취소(FR-099e(행사 일괄 취소), S4)다. 이벤트형 수업에 부르면 409 `USE_EVENT_CANCEL`
- 오류: 409 `SESSION_ALREADY_STARTED` · 409 `SESSION_NOT_SCHEDULED` · 422 `VALIDATION_FAILED`(사유 없음)

### 6-3. 강사 공지 (I13 · I13B)

`GET …/announcement-recipients?sessionId=` → 200 `{ "recipientCount": 11, "male": 5, "female": 6, "excluded": "결제 대기·대기 신청은 받지 않아요" }`. 받는 사람은 **그 수업의 확정 수강생**이다(`reservations.status='confirmed'`).

`POST …/announcements` 요청
```json
{ "sessionId": "…", "kind": "supplies", "title": "다음 주는 개인 매트를 챙겨 주세요",
  "body": "10/21(수) 수업은 바닥 동작이 많아요. …", "pushToo": true }
```
201 `{ "announcementId": "…", "recipientCount": 11, "createdAt": "…Z" }`
- `kind` = `general`(일반) · `supplies`(준비물) · `progress`(진도·복습). **시간·장소 변경과 휴강은 공지 종류가 아니다**(§6-1·6-2 가 따로 다룬다, FR-063). 제목 1~100자 · 내용 1~500자
- 회원마다 알림 행 `class_announcement`(`dedupe_key = announcement:<announcementId>:<memberId>`)을 같은 트랜잭션에 쓴다. 공지는 **수업 상세의 「강사 공지」에 항상 남는다**. `pushToo=false` 면 알림 행의 푸시 발송 표시만 끈다(알림함에는 남는다)
- 다른 수업의 회원에게는 알림 행이 만들어지지 않는다(S2-3.5 검증). 받는 사람이 0명이어도 공지는 남는다(`recipientCount: 0`)
- 오류: 403 `FORBIDDEN`(남의 수업) · 409 `CLASS_STATE_CONFLICT`(`published` 가 아님) · 422 `VALIDATION_FAILED`

`GET /api/classes/{classId}/announcements` 200 `{ "items": [ { "announcementId", "kind", "title", "body", "sessionId", "authorName", "recipientCount", "createdAt" } ] }`(최신순, 강사·대표). 회원용 `GET /api/me/classes/{classId}/announcements` 는 회원 세션(README §2)으로, 그 수업의 확정 예약이 있는 회원만 읽는다(`{ "items": [ { "announcementId", "kind", "title", "body", "authorName", "createdAt" } ] }`, 아니면 403 `FORBIDDEN`). `recipientCount` 는 회원 응답에 넣지 않는다.

## 7. 수업·회차 알림 — 종류와 받는 사람

알림 행은 사건과 같은 트랜잭션에서 쓰고 발송은 커밋 뒤 `NotificationSenderPort`(06 §4.10, S7-1 전까지 `pending`)가 한다. 직원 알림 조회·읽음은 `10-owner-dashboard.md` §2 의 경로를 쓴다. 회원 알림 조회는 `04-me-calendar-notifications.md` §2 다.

| kind | 받는 사람 | category | `dedupe_key` | 만드는 곳 |
|---|---|---|---|---|
| `class_submitted` | 대표 | `approval` | `class:<id>:rev<n>:submitted` | §4-4 |
| `class_approval_reminder` | 대표 | `approval` | `class:<id>:rev<n>:reminder` | §12 |
| `class_approved` · `class_revision_requested` | 강사 | `operations` | `class:<id>:rev<n>:approved` · `…:revision` | §4-5 |
| `class_edit_requested` | 대표 | `approval` | `classedit:<editId>:requested` | §5 |
| `class_edit_approved` · `class_edit_rejected` | 강사 | `operations` | `classedit:<editId>:approved` · `…:rejected` | §5 |
| `instructor_session_changed` | 대표 | `operations` | `sessionchange:<changeId>:owner` | §6 |
| `session_time_place_changed` · `session_cancelled` · `class_closed` · `class_changed` · `class_announcement` | 회원 | — | `sessionchange:<id>:<memberId>` · `batch:<id>:<memberId>` · `announcement:<id>:<memberId>` | §5 · §6 |
| `substitute_requested` | 후보 강사 | `operations` | `substitute:<id>:<candidate>:requested` | §8 |
| `substitute_accepted` | 대표 | `approval` | `substitute:<id>:accepted` | §8 |
| `substitute_confirmed` | 요청한 강사 · 대타 강사 | `operations` | `substitute:<id>:confirmed:<account>` | §8 |
| `substitute_assigned` | 대체 강사 | `operations` | `release:<releaseId>:<sessionId>:assigned` | §9 |
| `release_requested` | 대표 | `approval` | `release:<requestId>:requested` | §3-3 |
| `release_completed` · `release_declined` | 해제된 강사 · 요청한 강사 | `operations` | `release:<releaseId>:completed` · `release:<requestId>:declined` | §9 |
| `instructor_changed` | 회원 | — | `release:<releaseId>:<memberId>`(회원마다 1건) | §8 · §9 |
| `private_lesson_booked` · `private_lesson_cancelled` | 회원 | — | `plbooking:<bookingId>:<state>` | §10 |

- 대표 알림 중 「대타」(`substitute_accepted`)는 O21B 에서 `승인` 칩에 모은다. 위임 강사 알림함에는 위임 범위 밖 종류(정산·환불 금액)를 만들지 않는 규칙(10 §2)을 따른다
- 알림 본문(`payload`)에는 회원 연락처·계좌번호 전체를 넣지 않는다(FR-187(연락처 마스킹) · FR-299(결제 정보 보안))

## 8. 대타 (S2-3: FR-060 · I-10 · I14 · I14B · I14C · O21B)

흐름: 요청(I14) → 후보가 수락(I14C) → **대표 확인**(O21B 「확인하기 ›」) → 수강생 공지. 먼저 수락한 한 명이 정해지고 요청한 강사는 대표 확인 전까지 취소할 수 있다. 그 회차의 정산은 **실제로 수업한 강사** 몫이다(I-10 — `class_sessions.instructor_account_id` 가 대표 확인 때 바뀐다).

| 메서드·경로 | 권한 | 역할 | 멱등 | 보드 |
|---|---|---|---|---|
| `GET /api/sessions/{sessionId}/substitute-candidates` | 그 회차 담당 강사 · `owner` | 후보 목록(고를 수 있는가 포함) | 읽기 | I14 · W3b · O39 |
| `POST /api/instructor/substitute-requests` | 그 회차 담당 강사 | 대타 요청 | 키 | I14 |
| `GET /api/instructor/substitute-requests?role=requested\|received&status=` | `instructor` | 내가 한 요청(상태) · 받은 요청 | 읽기 | I14B · I14C |
| `POST /api/instructor/substitute-requests/{requestId}/accept` | 후보 | 수락 | 상태(먼저 온 한 명) | I14C |
| `POST /api/instructor/substitute-requests/{requestId}/decline` | 후보 | 거절 | 상태 | I14C |
| `POST /api/instructor/substitute-requests/{requestId}/cancel` | 요청한 강사 | 요청 취소(대표 확인 전) | 상태 | I14B |
| `GET /api/academies/{academyId}/substitute-requests?status=accepted` | `owner` | 대표 확인을 기다리는 대타 | 읽기 | O21B |
| `POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm` | `owner` | 대표 확인 → 수강생 공지 | 상태 | O21B |

### 8-1. 후보 목록 — `GET /api/sessions/{sessionId}/substitute-candidates`

```json
{ "sessionId": "…", "items": [ { "accountId": "…", "displayName": "김하나", "genre": "dance_sport", "available": true, "unavailableReason": null },
                               { "accountId": "…", "displayName": "박서윤", "genre": "dance_sport", "available": false, "unavailableReason": "busy" } ] }
```
- 후보 = **같은 학원 `active` 소속 · 활동 장르가 그 수업 장르와 같음 · 요청자 본인 제외**. `available=false` 면 고를 수 없고 이유는 `busy`(「그 시간에 일정이 있어요」) 하나뿐이다 — **무슨 일정인지(수업·개인 레슨·개인 일정·다른 학원)는 내려주지 않는다**(I14, FR-053, 수용 ①). 겹침 판정은 `schedule-check` 와 같은 순수 함수(S2-1.5 강사 일정 겹침)이고 개인 일정도 여기서는 `busy` 다
- 대표가 대체 강사를 배정할 때(§9)도 같은 경로를 쓴다(「그 시간이 비어 있는 같은 학원 강사만」). 시작한 회차는 409 `SESSION_ALREADY_STARTED`

### 8-2. 요청 · 수락 · 거절 · 취소 · 확인

`POST /api/instructor/substitute-requests` 요청 `{ "sessionId": "…", "candidateAccountIds": ["…","…"], "message": "이번 회차만 부탁드려요. 진도는 베이직 3번까지 나갔어요." }` → 201
```json
{ "requestId": "…", "sessionId": "…", "status": "open", "candidates": [ { "accountId": "…", "displayName": "김하나", "status": "invited" } ],
  "steps": [ "requested", "accepted", "owner_confirmed", "members_notified" ] }
```
- 후보는 1명 이상, **후보 자격을 요청 때 검사**한다. 자격 없는 후보가 하나라도 있으면 422 `SUBSTITUTE_CANDIDATE_INVALID` `{ "accountIds": […] }`. 회차당 열린 요청은 하나다(`uq_substitute_active`) — 둘째는 409 `SUBSTITUTE_REQUEST_OPEN`. 메시지는 200자까지(선택)
- 후보마다 알림 `substitute_requested`(회차·수강생 수·전할 말·정산은 내 몫). 감사 `substitute.requested`

`…/accept`(후보) — 요청 `{}`. 한 문장 `UPDATE substitute_requests SET status='accepted', accepted_candidate_account_id=$me, accepted_at=now() WHERE id=$1 AND status='open'`. 영향 1행이면 200 `{ "status": "accepted", "yourSession": {…} }` + 그 회차가 내 캘린더 후보로 보이게 하는 값 + 대표 알림 `substitute_accepted`(「김하나 강사가 대타를 수락했어요 · 확인하면 수강생 10명에게 알림이 가요」) · 다른 후보의 상태 `closed`. 영향 0행이면 다시 읽어 `confirmed`·`accepted`(다른 사람)·`cancelled` 면 409 `SUBSTITUTE_REQUEST_CLOSED`(「다른 강사가 먼저 수락했어요」). 수락 직전에 그 시간에 일정이 생겼으면 409 `SCHEDULE_CONFLICT`(수락자에게는 이유를 그대로 보인다)

`…/decline` → 그 후보의 상태만 `declined`, 200. 모든 후보가 거절해도 요청은 `open` 으로 남는다(요청한 강사가 취소하거나 시작 시각이 지나 `expired`).
`…/cancel`(요청한 강사) → `open`·`accepted` → `cancelled`. **대표가 확인한 뒤에는 409 `SUBSTITUTE_ALREADY_CONFIRMED`**(I14B 「대표가 확인하기 전까지는 취소할 수 있어요」). 이미 `cancelled` 면 200 같은 본문.

`POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm` — 요청 `{}`
- `accepted` → `confirmed`. 한 트랜잭션: **그 회차의 `instructor_account_id` 를 대타 강사로 바꾼다**(겹침은 이때 `ex_sessions_instructor` 가 한 번 더 막는다 → 409 `SUBSTITUTE_UNAVAILABLE`) · `session_changes`(`instructor_changed`) · 그 회차 확정 수강생 전원에게 알림 `instructor_changed`(「이번 회차는 김하나 강사가 진행해요」, 회원마다 1건) · 요청한 강사·대타 강사에게 `substitute_confirmed` · 감사 `session.instructor_changed`, `substitute.confirmed`
- 200 `{ "status": "confirmed", "session": { "sessionId": "…", "instructor": {…} }, "notifiedMemberCount": 10 }`. 이미 `confirmed` 면 200 같은 본문. `open`(수락 전) 이면 409 `CLASS_STATE_CONFLICT`
- 정산은 회차의 `instructor_account_id` 를 읽는 S5-1 이 「실제로 수업한 강사 몫」으로 잡는다. 이 계약은 칸을 바꾸는 데까지다

`GET /api/instructor/substitute-requests?role=requested` 항목
```json
{ "requestId": "…", "session": { "sessionId": "…", "classTitle": "쌈바(입문)", "startsAt": "…Z", "endsAt": "…Z", "roomName": "A홀", "memberCount": { "male": 4, "female": 6 } },
  "status": "accepted", "acceptedBy": { "accountId": "…", "displayName": "김하나" }, "message": "…",
  "timeline": [ { "step": "requested", "at": "…Z" }, { "step": "accepted", "at": "…Z" } ] }
```
`role=received` 는 후보 입장 — `status` 는 그 후보의 상태(`invited`·`accepted`·`declined`·`closed`)와 요청 상태를 함께 준다.

시작 시각이 지난 `open`·`accepted` 요청은 `expired` 로 바뀐다(시간 작업 `substitute-requests-expire`, §12). 대표 확인 기한은 따로 두지 않는다(**추천안**, 열린 점 ⑮).

## 9. 소속 해제 완성 (S2-3: FR-082 · O39 · O39B · W3b · W3b2 — `08` §5 를 완성한다)

`08` §5 는 M1 의 「남은 회차 0」 경로만 정했고 `sessionDecisions` 의 **모양만 예고**했다. 이 절이 그 모양을 확정한다. 시작은 대표(바로) 또는 강사(요청, §3-3)이고 절차는 같다: **남은 회차를 모두 처리해야 해제가 끝난다**.

| 메서드·경로 | 권한 | 역할 | 멱등 | 보드 |
|---|---|---|---|---|
| `POST /api/academies/{academyId}/affiliations/{affiliationId}/release-preview` | `owner` | 회차별 처리를 정했을 때의 알림·받는 회원 계산(쓰지 않음) | 읽기 | W3b · W3b2 · O39 · O39B |
| `POST /api/academies/{academyId}/affiliations/{affiliationId}/release` | `owner` | 소속 해제 실행(`08` §5 의 같은 경로 — 요청 모양 완성) | 키 | W3b2 · O39B |
| `GET /api/academies/{academyId}/affiliation-release-requests?status=requested` | `owner` | 강사가 시작한 해제 요청 | 읽기 | O21B · O37 |
| `POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline` | `owner` | 요청 거절(사유 한 줄) | 상태 | O37 |

### 9-1. `release-preview` (강사용 `POST /api/instructor/affiliations/{id}/release-preview` 도 같은 모양, 자기 소속만)

요청 `{ "sessionDecisions": [ { "sessionId": "…", "action": "substitute", "substituteAccountId": "…" }, { "sessionId": "…", "action": "cancel_session" } ], "privateLessonDecisions": [ { "passId": "…", "action": "finish_first" } ] }`(빈 배열이면 남은 것 목록만 받는다)
```json
{ "affiliationId": "…", "instructor": { "accountId": "…", "displayName": "박서윤" },
  "remaining": {
    "sessions": [ { "sessionId": "…", "classId": "…", "classTitle": "차차차 입문", "startsAt": "…Z", "endsAt": "…Z", "roomName": "A실", "memberCount": 9,
                    "decision": { "action": "substitute", "substituteAccountId": "…", "substituteName": "이준호", "substituteAvailable": true } } ],
    "privateLessonPasses": [ { "passId": "…", "memberDisplayName": "박지훈", "remainingSessions": 7, "decision": { "action": "finish_first" } } ] },
  "bundles": [ { "action": "substitute", "sessionCount": 1, "memberCount": 9,
                 "messagePreview": "「11월 18일(수) 차차차 입문은 박서윤 강사 대신 이준호 강사가 진행해요. 원하면 환불을 요청할 수 있어요.」",
                 "members": [ { "displayName": "김서연", "payKind": "paid" }, { "displayName": "이도윤", "payKind": "pass" } ] },
               { "action": "cancel_session", "sessionCount": 1, "memberCount": 7, "messagePreview": "…", "members": [ … ] } ],
  "totals": { "memberCount": 12, "notificationCount": 12 },
  "undecided": [ "…sessionId…" ], "canRelease": false }
```
- 남은 회차 = 시작 전(`starts_at > now`)이고 `scheduled` 인 이 강사 회차 전부(모든 수업). 받는 회원 수는 **회차별 확정 수강생의 서로 다른 회원 수**다 — 세 회차를 예약한 회원도 한 명으로 센다(수용 ⑤). `payKind` = `paid`(결제) · `pass`(수강권). **이름만** 내려가고 연락처는 없다(FR-187)
- `notificationCount` 는 **회원마다 1건**이라 `memberCount` 와 같다. 보드 숫자 「알림 61건 · 받는 회원 11명」·「알림 21건 · 받는 회원 12명」은 이 규칙과 맞지 않는다 — 시트 문구를 어떻게 적을지는 열린 점 ⑯
- `messagePreview` 는 시스템이 회차·원래 강사·대체 강사로 만든다(별도 공지를 쓰지 않는다). 대표가 한 줄을 덧붙일 수 있다(`ownerNote`). 회원을 빼고 보낼 수는 없다(강사·일정 변경은 예약 회원 모두가 알아야 하고 환불 요청 권리도 모두에게 있다)
- `canRelease` 는 `undecided` 가 비고 모든 `substitute` 의 대체 강사가 비어 있을 때만 true 다(해제 버튼 활성). 개인 레슨 수강권의 남은 회차는 §10 이 생긴 뒤 완성된다 — 수강권이 없으면 `privateLessonPasses` 는 빈 배열

### 9-2. `POST …/release`(헤더 `Idempotency-Key` 필수)

```json
{ "sessionDecisions": [ { "sessionId": "…", "action": "substitute", "substituteAccountId": "…" },
                        { "sessionId": "…", "action": "cancel_session" },
                        { "sessionId": "…", "action": "close" } ],
  "privateLessonDecisions": [], "ownerNote": "그동안 감사했어요" }
```
- **대체 강사는 대표가 바로 배정한다**(수락 단계 없음, 2026-11-13). 그 시간이 비어 있는 같은 학원 `active` 강사만 고를 수 있고(`§8-1`), 시스템이 겹침을 막는다. 선택 행동: `substitute` · `cancel_session`(휴강, 7일 안에 회원이 옮기기·환불 선택) · `close`(폐강)
- 한 트랜잭션: 회차마다 처리(`substitute` = 회차의 `instructor_account_id` 변경 · `cancel_session`/`close` = §6-2 와 같은 상태 변경, 모두 같은 `batch_id` 의 `session_changes`) → 회원마다 알림 1건(`instructor_changed`·`session_cancelled`·`class_closed` 가 한 건에 묶인다) → 대체 강사에게 `substitute_assigned`(그 회차가 그 강사의 일정에 들어간다 — 일정은 회차의 담당 강사에서 읽으므로 따로 쓰지 않는다, 수용 ⑥) → `instructor_affiliations` `active` → `released`(`released_at`, `release_initiated_by`) → 위임 행 삭제 → 열린 해제 요청 `completed` → 해제된 강사에게 `release_completed` → 감사 `affiliation.released`, `release_request.completed`
- 200 `{ "status": "released", "releasedAt": "…Z", "sessions": { "substituted": 1, "cancelled": 1, "closed": 1 }, "notified": { "memberCount": 12, "notificationCount": 12 } }`. 이미 `released` 면 200 같은 본문
- 해제한 뒤에도 진행 중인 정산은 수업한 만큼 받고 지난 정산 내역을 본다(FR-082 — 정산 쪽 읽기는 S5-2). 학원 시간표·공지·학원 색은 사라진다(소속이 `active` 가 아니므로 조회 조건에서 빠진다)

| HTTP | code | 언제 |
|---|---|---|
| 409 | `RELEASE_HAS_REMAINING_SESSIONS` | 남은 회차 중 결정이 없는 것이 있다 — `{ "undecided": ["…"] }`(08 §5 와 같은 코드·모양에 `undecided` 를 더한다) |
| 409 | `SUBSTITUTE_UNAVAILABLE` | 고른 대체 강사에게 그 시간에 일정이 생겼다 — `{ "sessionId": "…" }` |
| 409 | `AFFILIATION_STATE_CONFLICT` | 소속이 `active` 가 아님 |
| 422 | `VALIDATION_FAILED` | `substitute` 인데 `substituteAccountId` 없음·소속 아님 · 지난 회차 |

`GET …/affiliation-release-requests?status=requested` → `{ "items": [ { "requestId", "affiliationId", "instructor": {…}, "remainingSessionCount", "sessionChoices", "privateLessonChoices", "note", "requestedAt" } ] }`. 대표는 이 의향을 보고 `release-preview`·`release` 로 끝낸다. `…/decline` 요청 `{ "reason": "…" }`(1~200자) → `declined`, 소속은 그대로 `active`, 강사에게 알림 `release_declined`(사유 포함, category `operations`, `dedupe_key = release:<requestId>:declined`). 이미 `declined` 면 200 같은 본문, `completed` 면 409 `AFFILIATION_STATE_CONFLICT`.

## 10. 개인 레슨 (S2-4: FR-052c · FR-099b · FR-135a · I10 · I10B · I10C · I20 · I20B · I20C)

개인 레슨은 **소속만 있으면** 바로 열린다(승인 대상 아님, 권한 토글 없음). 상품은 `classes` 의 한 행(`class_kind='private_lesson'`)이고 판매자는 **개설할 때 고른 학원**이다(수용 ①). **개인 레슨 일정은 대표도 볼 수 없다** — 이 절의 경로는 모두 `affiliated`(그 강사 본인) 권한이고 `owner` 경로는 없다. 대표는 결제 건과 정산만 본다(M3·M5). 수수료 1% 는 대표 명세에만 있어(D12) 이 절의 응답에 수수료 칸이 없다. 회원의 구매(M15B)는 M3 의 확장이고 이 절은 개설과 구매 뒤를 정한다(열린 점 ⑫).

| 메서드·경로 | 역할 | 멱등 | 보드 |
|---|---|---|---|
| `GET /api/instructor/private-lesson-rules?academyId=` | 개인 레슨 취소·환불 규칙(현재 판본 · 기본값) | 읽기 | I20C |
| `POST /api/instructor/private-lesson-rules` | 규칙 저장(새 판본) | 키 | I20C |
| `POST /api/instructor/private-lesson-products` | 개인 레슨 수강권 상품 열기 | 키 | I10B |
| `GET /api/instructor/private-lesson-products?academyId=` | 내 상품 목록 | 읽기 | I10 · I10B |
| `POST /api/instructor/private-lesson-products/{classId}/close` | 상품 닫기(새 구매 막기) | 상태 | I10B |
| `POST /api/instructor/private-lesson-products/{classId}/slots` | 「레슨 모집」 시간 열기(매주 반복 가능) | 키 | I10C |
| `DELETE /api/instructor/private-lesson-slots/{slotId}` | 열어 둔 시간 닫기(`open` 만) | 상태 | I10C |
| `GET /api/instructor/private-lesson-passes?academyId=&status=` | 수강생별 수강권 · 남은 횟수 | 읽기 | I10 |
| `GET /api/instructor/private-lesson-passes/{passId}` | 수강생 상세 · 다음 회차 후보 | 읽기 | I20 |
| `POST /api/instructor/private-lesson-passes/{passId}/bookings` | 다음 회차 잡기 | 키 | I20 |
| `POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule` | 회차 시간 바꾸기 | 상태 | I20B |
| `POST /api/instructor/private-lesson-bookings/{bookingId}/cancel` | 회차 취소(강사 사정 · 회원 요청) | 상태 | I20B |

### 10-1. 규칙 · 상품 열기

`POST …/private-lesson-rules` 요청 `{ "academyId": "…", "changeDeadlineHours": 24, "validityMonths": 3 }` — 변경·취소 기한 `12 | 24 | 48`(기본 24) · 수강권 사용 기한 `2 | 3 | 6`개월(기본 3). 현재 판본과 같은 값이면 200(새 행 없음), 다르면 201 새 판본. **저장한 뒤 결제하는 수강권부터 적용**되고 이미 결제한 수강권은 결제 때 판본 그대로다(I20C). **고정 규칙**(값을 바꿀 칸이 없다): 기한이 지난 취소와 오지 않음은 1회 차감 · 강사 사정 취소는 회차 복구 · 남은 회차 환불 금액은 학원 대표가 정한다. 규칙이 한 번도 없는 (학원, 강사)면 상품을 열 때 기본값 판본 1이 만들어진다(**추천안**)
```json
{ "academyId": "…", "version": 2, "changeDeadlineHours": 24, "validityMonths": 3, "effectiveFrom": "…Z",
  "memberNotice": [ "레슨 시작 24시간 전까지 바꾸거나 취소할 수 있어요", "그 뒤에 취소하거나 오지 않으면 1회가 차감돼요", "수강권은 결제일부터 3개월 안에 써요", "남은 회차 환불은 학원에 문의해요" ] }
```
`GET` 은 같은 모양에 `current` 와 `isDefault` 를 더해 준다.

`POST …/private-lesson-products`
```json
{ "academyId": "…", "subGenre": "latin", "lessonMinutes": 50, "sessionCount": 10, "priceAmount": 600000 }
```
201
```json
{ "classId": "…", "academyId": "…", "academyName": "라틴하우스 강남", "genre": "dance_sport", "subGenre": "latin",
  "lessonMinutes": 50, "sessionCount": 10, "priceAmount": 600000, "status": "open",
  "rule": { "version": 2, "changeDeadlineHours": 24, "validityMonths": 3 },
  "refundNoticeVersionId": null, "payoutAcademy": "라틴하우스 강남" }
```
- 레슨 길이 `50 | 80`분. 횟수 기본 10(1 이상), 수강권 금액은 강사가 직접 입력(0 이상). 종목은 **회원이 구매할 때 고른다**(`subGenre` 안의 종목, FR-021 — 스탠다드면 D11 의 종목명). `genre` 는 강사의 활동 장르로 고정
- 한 트랜잭션: `classes`(`private_lesson`, `published`, `instructor_account_id` = 본인) + `private_lesson_products` + 규칙 판본 연결. 대표 승인이 없어서 `class_approvals` 행은 만들지 않는다. 학원의 `private_lesson` 환불 양식(07·09 `refund_notice_versions`)이 있으면 그 판본 id 도 함께 붙이고 없으면 `null`(S2-4.4, 열린 점 ⑨)
- 판매자·결제 받는 곳 = 고른 학원. 소속 아닌 학원이면 403 `AFFILIATION_REQUIRED`(수용 ①). 같은 `Idempotency-Key` 면 200 처음 것. 학원이 `restricted` 면 409 `ACADEMY_RESTRICTED`
- `…/close` → `open` → `closed`(새 구매·새 시간을 막는다. 이미 산 수강권은 그대로). 200 `status: "closed"`

### 10-2. 열 시간 (I10C)

`POST …/products/{classId}/slots`
```json
{ "slots": [ { "startsAt": "2026-10-16T12:00:00Z", "endsAt": "2026-10-16T12:50:00Z" } ], "roomId": "…", "repeatWeeks": 8 }
```
201 `{ "created": [ { "slotId": "…", "startsAt": "…Z", "endsAt": "…Z", "status": "open" } ], "repeatGroupId": "…" }`
- 시작·끝은 10분 단위이고 길이는 상품의 `lessonMinutes` 와 같아야 한다(다르면 422 `VALIDATION_FAILED`). `repeatWeeks` = 1(반복 없음)~26, 기본 8(**추천값**, 열린 점 ⑰)이면 매주 같은 요일·시각으로 만든다
- **수업·다른 학원 일정과 겹치는 시간은 열 수 없다**(FR-052c). 한 번에 여러 개를 만들 때 하나라도 겹치면 전체 거부(409 `SCHEDULE_CONFLICT` + 겹친 시각 목록) — 부분 성공은 없다. 같은 강사의 트랜잭션 잠금 안에서 회차·다른 시간·반복 전체를 확인하고, `ex_pl_slots_instructor` 가 마지막 방어선이다. `roomId`(그 학원 홀)를 넣으면 강의실 겹침(`ROOM_CONFLICT`)도 본다
- 회원에게는 `open` 인 시간만 「레슨 모집」으로 보이고 예약된 시간은 목록에서 사라진다(「마감」 표시 없음, FR-052c). 이 규칙은 회원 쪽 조회가 맡는다. `DELETE …/slots/{slotId}` → `open` → `closed`, 204. `held`·`booked` 면 409 `SLOT_NOT_OPEN`

### 10-3. 수강생 · 회차 (I10 · I20 · I20B)

`GET /api/instructor/private-lesson-passes?status=active` 항목
```json
{ "passId": "…", "academyId": "…", "academyName": "라틴하우스 강남", "productClassId": "…", "lessonMinutes": 50,
  "student": { "displayName": "김서연" }, "nameVisible": true,
  "discipline": "cha_cha_cha", "status": "active", "sessionsTotal": 10, "sessionsUsed": 4, "remainingSessions": 6,
  "paidAt": "…Z", "validUntil": "2027-01-05T14:59:59Z",
  "nextBooking": { "bookingId": "…", "startsAt": "…Z", "endsAt": "…Z", "sessionNo": 5, "state": "booked" },
  "awaitingPayment": null }
```
- **수강생 이름은 결제 대기여도 보인다**(2026-11-19 — 단체 수업 명단의 「결제 대기 N명」 숫자 규칙을 적용하지 않는다, 수용 ④). `pending_payment` 수강권은 `"awaitingPayment": { "until": "…Z" }` 로 같이 온다. 다만 **멤버십이 끝나면 `nameVisible: false`, `student: null`** 이고 시간·횟수만 남는다(I10 「수강생 이름은 멤버십에서 보여요」 — S6-1 이 판정 함수를 주고 그 전에는 항상 보인다)
- 연락처·결제 수단 전체는 목록에 없다

`GET …/passes/{passId}` 에는 위에 더해
```json
{ "payment": { "paidAt": "…Z", "method": "card", "amount": 600000 },
  "rule": { "version": 2, "changeDeadlineHours": 24, "validityMonths": 3 },
  "bookings": [ { "bookingId": "…", "slotId": "…", "startsAt": "…Z", "endsAt": "…Z", "status": "done", "deducted": true } ],
  "openSlots": [ { "slotId": "…", "startsAt": "…Z", "endsAt": "…Z", "roomName": "연습실" } ] }
```
(`payment` 은 주문·결제의 읽기 값이다 — 환불 처리·금액 결정은 대표 몫이다.)

`POST …/passes/{passId}/bookings` 요청 `{ "slotId": "…" }` → 201 `{ "bookingId": "…", "slotId": "…", "status": "booked", "remainingToBook": 5 }`. 그 시간이 `booked` 로 닫히고 회원에게 알림 `private_lesson_booked`(+ 회원 캘린더는 M3 와 맞춘다, 열린 점 ⑫).

| HTTP | code | 언제 |
|---|---|---|
| 409 | `SLOT_NOT_OPEN` | 그 시간이 이미 예약됐거나 닫힘(`uq_pl_booking_slot_live` 가 최종 방어선) |
| 409 | `PASS_NOT_ACTIVE` · `PASS_NO_REMAINING` | 결제 전·만료·환불된 수강권 · 잡을 회차가 없음(이미 잡은 회차 포함) |
| 422 | `SLOT_AFTER_PASS_EXPIRY` | 시간이 수강권 사용 기한 뒤 |

`POST …/bookings/{bookingId}/reschedule` 요청 `{ "slotId": "…" }`(다른 「레슨 모집」 시간으로 옮김, 회차 그대로·차감 없음) → 200. 옛 시간은 `open` 으로 돌아간다. 회원에게 알림.

`POST …/bookings/{bookingId}/cancel` 요청 `{ "by": "instructor", "reason": "대회 심사 일정이 생겼어요" }` 또는 `{ "by": "member" }`
- `by=instructor`(강사 사정) → `cancelled_instructor`, **차감 없음**(회차를 수강권에 돌려준다 — 남은 횟수 그대로), 그 시간은 `closed`. 사유는 회원에게 보인다
- `by=member`(회원 요청을 강사가 기록) → **24시간 규칙 판정**(S2-4.3, `now` 를 주입받는 순수 함수): 시작까지 남은 시간 ≥ 수강권에 고정된 `changeDeadlineHours` 면 `cancelled_member_free`(차감 없음, 시간 `open` 복귀), 아니면 `cancelled_member_late`(**1회 차감**, 시간 `closed`) — 수용 ②. 경계(정확히 기한 시각)는 **차감 없음** 쪽(**추천안**)
- 200 `{ "bookingId": "…", "status": "cancelled_member_late", "deducted": true, "sessionsUsed": 5, "remainingSessions": 5 }`. 회원 알림 `private_lesson_cancelled`. 감사 `private_lesson_booking.cancelled`. 환불은 이 경로가 아니라 대표가 받는다(「결제·환불 문의는 대표가 받아요」)
- 이미 취소된 회차면 200 같은 본문, `done` 등이면 409 `BOOKING_STATE_CONFLICT`

`booked` → `done`(마친 회차)과 오지 않음(`no_show`) 표시는 이 판에서 경로를 만들지 않는다 — 시작 시각이 지나면 자동으로 `done`(**추천안**, 시간 작업), `no_show` 를 누르는 화면은 보드에 없다(열린 점 ⑰).

## 11. 강사 일정 (S2-4: FR-058 · FR-053 · FR-054 · I1 · I5 · I5W · I5D)

`GET /api/instructor/schedule?from=2026-10-12&to=2026-10-18&academyId=&include=sessions,private,personal` — 권한 `instructor`(본인 것만). 날짜는 KST 달력, 범위는 최대 62일(`04` 의 내 캘린더와 같은 한도). **일·주·월 보기만 있다**(「1년 보기는 두지 않는다」, FR-058 spec 1242줄). 여러 학원 일정이 **한 목록에 시간순**으로 나온다(수용 ③).
```json
{ "from": "2026-10-12", "to": "2026-10-18",
  "items": [
    { "kind": "class_session", "id": "<sessionId>", "classId": "…", "title": "쌈바(입문)", "startsAt": "…Z", "endsAt": "…Z",
      "academy": { "academyId": "…", "name": "라틴하우스 강남", "colorIndex": 2 }, "room": "A홀", "status": "scheduled",
      "isSubstitute": false, "paid": { "male": 9, "female": 10 }, "capacity": { "male": 10, "female": 10, "any": null } },
    { "kind": "private_lesson", "id": "<bookingId>", "title": "개인 레슨", "startsAt": "…Z", "endsAt": "…Z",
      "academy": { "academyId": "…", "name": "라틴스텝 서초", "colorIndex": 5 },
      "student": { "displayName": "김서연" }, "sessionNo": 5, "sessionsTotal": 10, "state": "booked" },
    { "kind": "private_lesson_open", "id": "<slotId>", "startsAt": "…Z", "endsAt": "…Z", "academy": { … } },
    { "kind": "personal", "id": "<eventId>", "title": "개인 연습", "startsAt": "…Z", "endsAt": "…Z", "repeat": "weekly" } ],
  "overlaps": [ { "a": { "kind": "class_session", "id": "…" }, "b": { "kind": "personal", "id": "…" }, "minutes": 30 } ] }
```
- 포함 종류는 `include` 로 고른다(기본 `sessions,private,personal`). `private_lesson_open`(열어 둔 시간)은 `include=open` 일 때만 나온다
- **본인 회차는 회차의 담당 강사(`class_sessions.instructor_account_id`)로 읽는다.** 그래서 대타가 확정되거나 대표가 대체 강사를 배정하면 그 회차가 그 강사의 일정에 저절로 들어가고 원래 강사에게서는 빠진다(수용 ⑥ — 별도 캘린더 행이 없다). 휴강·폐강된 회차는 `status` 로 표시된다
- `paid` 는 결제한 남·여 인원(`seat_pools.confirmed_count`), 결제 대기는 세지 않는다(I5D 「인원 숫자 없음」은 화면 규칙이라 값은 항상 준다). 개인 레슨의 `student` 규칙은 §10-3 과 같다(`nameVisible` 이 false 면 `null`)
- 학원 색은 `instructor_affiliations.calendar_color_index`(§3-2). 소속이 풀린 학원의 일정은 지난 것만 남는다
- `overlaps` 는 안내용이다(수업끼리·수업과 개인 레슨의 겹침은 거부로 이미 막혀 있어 거의 개인 일정과의 겹침이다)
- 멤버십이 끝났으면 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED`(I36B 「일·주·월 스케줄 숨김」, 수업 등록·휴강·변경 알림은 그대로 동작). S6-1 전에는 항상 통과
- 대표가 보는 학원 캘린더(O23~O25 · FR-083)는 이 경로가 아니다. 거기에는 소속 강사의 다른 학원 일정이 「불가 시간」으로, 개인 레슨·개인 일정은 **나오지 않는다** — M3(S3-5)가 만든다

## 12. 시간 작업 (내부 경로 — README §1 `X-Internal-Token`, 멱등)

| 경로 | 언제 | 하는 일 |
|---|---|---|
| `POST /api/internal/jobs/class-approval-reminders` | 매시간(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) | `pending_approval` 이고 `submitted_at ≤ now − 24시간` 이며 `approval_reminded_at IS NULL` 인 수업마다 대표 알림 `class_approval_reminder` 한 번 + `approval_reminded_at` 기록(FR-050a 「24시간 안에 답이 없으면 한 번만」) |
| `POST /api/internal/jobs/substitute-requests-expire` | 매 10분(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) | 시작 시각이 지난 `open`·`accepted` 대타 요청을 `expired` 로 |
| `POST /api/internal/jobs/private-lesson-holds-expire` | 매 10분(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) | `held_until` 이 지난 슬롯을 `open` 으로, `pending_payment` 수강권을 정리(결제 대기 만료는 M3 의 주문 만료와 한 묶음 — 열린 점 ⑫) |

세 작업은 마스터 플랜 6-7 의 시간 작업 표에 행을 더해야 한다. 응답 200 `{ "processed": 3 }`.

---

## 수용 시나리오

1. **Given** 활동 장르 둘을 보낸 가입 요청 **When** `POST /api/instructor/signup` **Then** 422 `VALIDATION_FAILED`, 계정이 만들어지지 않는다 · 하나만 보내면 201 이고 `instructor_profiles.activity_genre` 가 그 값 하나(S2-1 수용 ①)
2. **Given** 같은 본인확인(CI)으로 강사 계정이 있다 **When** 두 번째 가입 시도 **Then** 409 `INSTRUCTOR_ALREADY_REGISTERED` + 가린 아이디, 강사 계정은 여전히 1개(수용 ④). 본인확인 없이 만든 강사 계정은 0개
3. **Given** 사업자등록번호를 비운 채 가입 **When** 나중에 `PUT …/business-registration` **Then** 넣을 수 있다(수용 ⑤)
4. **Given** 대표가 거절한 소속 신청 **When** 강사가 다시 신청 **Then** 새 `pending` 행이 생기고 거절 알림(사유)이 그 전에 남아 있다(수용 ② — 08 시나리오 4 와 같다)
5. **Given** 소속 `active` + 앱 `class_submit` 권한이 있는 강사 **When** 정규 수업(남 6·여 6, 8회차)을 `POST /api/classes` 뒤 `submit` **Then** 대표 알림 1건, `pending_approval`, 회원 공개 목록에는 아직 없다 · 권한을 끈 뒤 새 수업을 올리면 403 `CLASS_PERMISSION_REQUIRED`
6. **Given** 같은 강사가 학원 A 월 20:00–21:00 수업을 올렸다 **When** 학원 B 의 월 20:30–21:30 수업을 `submit` **Then** 409 `SCHEDULE_CONFLICT`(30분 겹침 안내 + 빈 시간 칩), 학원 B 에 회차가 만들어지지 않는다(수용 ④)
7. **Given** 환불 마감일 없는 이벤트형(금액 0 초과) **When** `submit` **Then** 422(`REFUND_DEADLINE_REQUIRED`). 개최일 다음 날 마감일은 422 `REFUND_DEADLINE_AFTER_START`(수용 ②). 금액 0 이벤트형은 마감일 없이도 `pending_approval` 로 간다(수용 ⑤)
8. **Given** `pending_approval` 수업 **When** 대표가 사유와 함께 `request-revision` **Then** `draft` 로 돌아가고 강사 알림에 사유가 있으며 회차·판매 단위가 지워진다 · 고쳐서 `submit` → `approve` 하면 공개 목록에 1건(수용 ③)
9. **Given** 확정 인원이 남 9·여 10 인 공개 수업 **When** 정원을 남 8 로 줄이는 수정 요청 **Then** 422 `CAPACITY_BELOW_RESERVED`(minimum 남 9) · 가격을 올려 승인받아도 이미 결제된 주문의 `total_amount` 는 그대로(S2-3 수용 ③④, 결제 회원이 생기기 전에는 픽스처로 검증하고 M3 끝에 실제 주문으로 다시 돈다)
10. **Given** 같은 시간에 다른 수업이 있는 강사 B **When** 강사 A 가 후보 목록을 연다 **Then** B 는 `available:false`·`busy`(이유 외 정보 없음). 둘이 동시에 수락하면 한 명만 `accepted` 이고 다른 쪽은 409 `SUBSTITUTE_REQUEST_CLOSED`. 대표 확인 뒤 요청 취소는 409 `SUBSTITUTE_ALREADY_CONFIRMED`(S2-3 수용 ①②)
11. **Given** 회원 한 명이 세 회차를 예약한 강사의 소속 해제 **When** 대표가 `release-preview` 후 `release` **Then** 받는 회원 수는 중복을 뺀 수와 같고 그 회원의 알림 행은 1건, 대체 강사에게는 배정 알림이 가고 그 회차가 그 강사의 `GET /api/instructor/schedule` 에 나온다(S2-3 수용 ⑤⑥)
12. **Given** 시작 25시간 전·23시간 전 개인 레슨 회차(기한 24시간) **When** 회원 요청 취소를 기록 **Then** 앞은 차감 없음, 뒤는 1회 차감(S2-4 수용 ②) · **Given** 학원 A·B 에서 수업이 있는 강사 **When** 일정 조회 **Then** 두 학원 회차가 시간순 한 목록에 있다(수용 ③) · 개인 레슨 `pending_payment` 수강권도 수강생 이름이 보이고 단체 수업 명단은 숫자만 보인다(수용 ④)
13. **Given** 개인 레슨 상품을 소속 아닌 학원에 개설 **When** `POST …/private-lesson-products` **Then** 403 `AFFILIATION_REQUIRED` · 소속 학원으로 개설하면 `classes.academy_id` 가 그 학원(수용 ①)

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | 만 19세 판정(경계 생일·KST 날짜) · 사업자번호 체크섬 · 반복 일정 회차 만들기(월·수 8주 = 16회, KST→UTC) · 강사 일정 겹침 판정(학원이 달라도 겹침, 경계 맞닿음은 겹침 아님) · 24시간 규칙 판정(경계 앞뒤·정확히 24시간) · 휴강 선택 기한(알린 시각 + 7일) · 정원 하한 판정(`held + confirmed`) · 환불 마감일 판정(개최일 당일 가능·다음 날 불가) · 받는 회원 수 중복 제거 · 개인 레슨 수강생 이름 표시 규칙(결제 대기도 이름, 멤버십 끝나면 숨김) |
| DB | `uq_staff_accounts_ci`(같은 CI 두 번째 강사 거부) · `ex_sessions_instructor`·`ex_sessions_room`(겹치는 두 회차 거부, 휴강 회차는 점유 안 함) · `uq_substitute_active`(회차당 열린 요청 하나) · 대타 수락 조건부 갱신 동시 2건 → 1건 · `uq_class_edit_open` · `ck_classes_genre_sub` · `ck_offerings_free_no_deadline` · `ex_pl_slots_instructor` · `uq_pl_booking_slot_live` · `ck_pl_pass_used` · 같은 `Idempotency-Key` 로 수업 두 번 만들기 → 1건 |
| 통합 | 시나리오 1~13 · 승인 → 공개 목록 1건(FR-076 셋이 같이 생김) · 권한 끄면 다음 요청 403 · 승인 24시간 재알림 한 번만 · 폐강으로 모든 회차가 닫히면 `cancelled` · 대표 경로에서 개인 레슨 정보가 응답에 없음 |
| E2E(Playwright) | 강사 앱 가입 I31C→I31 · 수업 만들기 I2→I2D 에서 공지가 읽기 전용 · 대표 앱 O5 승인(스크린샷) · 관리자 웹 W3b2 해제 확인 창의 「받는 회원 M명」 |

## 열린 점 (2026-11-20 사용자 결정 D20 — 추천값은 모두 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」)

| # | 무엇 | 추천 · 조율 |
|---|---|---|
| ① | **강사 시작 해제의 완료 주체.** `08` §5 표는 `release` 를 `owner`·`instructor` 둘 다로 적었지만 Task S2-1.4 는 「요청 기록만」, FR-082 는 「대표가 대체 강사를 정한 뒤 알림」이다. 또 남은 회차가 0 일 때 강사가 바로 해제할 수 있나 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 항상 요청(§3-3) → 대표가 `release`(§9). 남은 것이 0 이면 대표는 한 번 누르면 끝. `08` §5 의 `instructor` 표기를 이 파일로 바꾼다 — **M1 담당과 조율**. 거절(`declined`) 알림 종류는 아직 없다 |
| ② | 개인 일정이 수업 등록을 막나(FR-053 은 「겹치면 알리되 막지는 않는다」, FR-054 는 수업 충돌만 거부) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 막지 않고 `schedule-check`·`personal-events` 응답으로 알린다. 수업·개인 레슨끼리만 거부. 대타 후보에서는 개인 일정도 `busy` |
| ③ | FR-053 「가능 시간」 — 보드는 개인 일정(I36)만 있고 주간 가능 시간 화면이 없다. Task S2-1.6 의 「가능 시간」을 개인 일정으로 읽었다. 반복 일정의 한 날만 지우기·끝나는 날 입력도 보드에 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 개인 일정만 둔다. 반복은 시리즈 전체 삭제만 |
| ④ | 스윙·아르헨티나 탱고의 종목 값 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `sub_genre`·`discipline` 을 NULL 로 둔다(FR-021 이 정하지 않음) |
| ⑤ | 직원 계정(대표 등)은 있고 `instructor` 역할이 없는 사람이 강사도 하려 할 때 — 새 강사 계정은 못 만든다(`uq_staff_accounts_ci`). 대표 가입(Task S1-1.8)의 경로도 `07` 이 정의하지 않았고 「강사 가입 경로를 같이 쓴다」고만 적었다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 같은 계정에 역할 추가 경로(`/api/instructor/role`, 추천 — 아직 계약 아님)를 따로 두고, 대표 가입은 이 파일의 `identity-check`·`username-available` 을 공유하되 본체만 다르게 — **M1 담당과 조율** |
| ⑥ | 강사 소개 영상·초상권 동의(FR-025 · Q10(강사 소개 영상) · 보드 I40) — S2-1.6 은 사진만 말한다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이 판은 영상을 받지 않는다. 사람마다 동의 시각을 남기는 테이블과 함께 별도 Task |
| ⑦ | 이벤트형이 여러 회차일 때(FR-099d 「회차가 여럿이면 첫 회차」) · 정원 한 칸(`single`)을 쓰는 수업 종류(FR-092c 「솔로 스타일·레이디스타일 등」), 보드 I2D·I2E 에 단일 정원 화면 없음 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 이벤트형은 회차 1개로 제한(여러 날 행사는 S6-4). `lady_style` 은 단일 정원으로 강제 |
| ⑧ | 개인 레슨 수강권 유효기간 기산 — FR-052c 임시 확정은 「첫 레슨일부터」, 보드 I20·I20C 는 「결제일부터」 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 결제일부터(보드 3장이 같다). 문서를 보드에 맞춘다 |
| ⑨ | 개인 레슨 규칙의 주인 — 플랜 S2-4.4 는 「학원의 개인 레슨 양식 판본」, 보드 I20C·FR-052c 는 「강사가 학원마다 정한다」 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 둘 다 둔다 — 강사 규칙 판본(필수)과 대표의 `private_lesson` 양식(있으면 id 를 함께 붙임) |
| ⑩ | `07` §1 파일 경로: `staff_self` 가 「2단계 인증을 마친 직원」이라 2단계가 없는 강사 앱이 사진·등록증을 못 올린다. 목적 값(`instructor_photo`·`poster`·`business_registration_evidence`)도 더해야 한다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `staff_self` 의 2단계 조건을 관리자 웹 면에만 건다. 목적 값 3개 추가 — **M1 담당과 조율**(데이터 §8-2) |
| ⑪ | 1년 무료 체험 시작 함수(M6 `trial_grants`)·광고성 알림 동의 저장 위치(S7-1) · M6 가 정한 403 `INSTRUCTOR_MEMBERSHIP_REQUIRED` 의 적용 범위(캘린더·개인 일정은 잠김, 수업 등록·휴강·변경·공지는 항상 무료 — `14` §2 `alwaysFree`) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 가입 트랜잭션이 M6 의 체험 시작 함수를 부르고, 그 전에는 `membership: null`·판정 항상 통과. 동의 시각은 지금 `instructor_profiles` 에 둔다 — **M6 담당과 조율** |
| ⑫ | **M3 와 만나는 곳**: 공개 목록의 `classes.status = 'published'` 조건(기존 시드 행은 마이그레이션이 `published` 로 채운다) · 개인 레슨 구매 주문(`orders.offering_id` 가 개인 레슨을 못 가리킨다 → `orders.private_lesson_product_id` NULL 허용 + 둘 중 하나 CHECK) · `calendar_entries.booking_id` · 구매 경로 자체(M15B) · `held` 만료 | **M3 담당과 조율**. 이 파일은 구매 뒤 모양까지만 정한다 |
| ⑬ | 공개 뒤 요일·시간·기간 수정이 이미 진행 중인 회차에 닿을 때, 회차 수가 달라지는 수정 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 시작 전 회차만 새 규칙으로 바꾸고 지난 회차는 그대로, 회차 수가 달라지면 거부(회차 단위 폐강을 쓴다) |
| ⑭ | 포스터에서 칸을 읽는 흐름(SX-2 · FR-073~FR-077)과 이 계약의 등록 경로가 같은 입구를 쓰나 · 소개 문구(SX-6)의 저장 칸 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) SX-2 는 `POST /api/classes` 의 초안을 채우는 쪽으로 붙는다. `intro_text` 칸은 SX-6 와 조율 |
| ⑮ | 대타 요청의 대표 확인 기한과 미확인 처리 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 기한 없이 회차 시작 시각까지 유효, 지나면 `expired`. 시작 1시간 전 재알림은 두지 않는다 |
| ⑯ | 해제 확인 시트의 숫자 문구 — 보드는 「알림 61건 · 받는 회원 11명」(I28B)·「알림 21건 · 받는 회원 12명」(O39B)인데 「회원마다 한 번에 모아 보낸다」면 건수와 회원 수가 같아야 한다(강사 대조 번호 5) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 「받는 회원 M명 · 알림은 회원마다 1건」으로 적는다. 보드를 고친다 |
| ⑰ | 개인 레슨 「매주 반복」이 몇 주인지 · `done` 자동 전이 · `no_show` 표시 화면 · I20·I20B·I20C 를 만드는 Task | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `repeatWeeks` 기본 8·상한 26 · 시작 시각 경과 시 자동 `done` · 오지 않음은 이 판에서 뺀다. **Task 가 없다**: 마스터 플랜 S2-4.6 의 화면은 I10·I10B·I10C·I1 뿐이라 I20·I20B·I20C(수강생·회차·규칙)와 I31B(아이디·비밀번호 찾기)·I40(프로필)·I36(개인 일정)·I9E(학원 색)·I27(학원 검색)을 만드는 Task 를 더해야 한다 |
| ⑱ | 승인 대기 중 대표가 환불 공지를 새 판본으로 올렸을 때 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 승인 시점에 최신 판본으로 다시 붙인다 |
| ⑲ | `staff_accounts` 에 본인확인 이름 칸이 없다(예금주 대조·가입 시 저장) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) `identity_name_enc`·`identity_name_masked` 를 더한다 — **M1·M5 와 조율**(데이터 §8-2) |
| ㉑ | ~~M5 와 겹침: 사업자등록번호·등록증을 `instructor_profiles` 와 `instructor_settlement_profiles` 둘에 둠~~ | **2026-11-20 통합으로 닫음** — 번호·등록증은 `instructor_profiles` 한 곳(이 파일 §2-2 경로로만 넣는다). M5 의 `instructor_settlement_profiles` 는 `tax_type` 만 갖고, 13 §3-1 의 정산 유형 경로는 `taxType` 만 받는다 |
| ⑳ | `02-catalog`·`10-owner-dashboard` 의 `pendingClassApprovals` 타일·`sessions` 타일이 이 파일의 `classes.status`·`class_sessions` 를 읽는다. 대시보드 계약의 `availableFrom: "S2-2"` 가 켜지는 시점 | M1 담당(10)과 조율 |
