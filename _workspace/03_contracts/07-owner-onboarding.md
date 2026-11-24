# API 계약 — 입점 신청·심사·학원 정보·정산 계좌·파일·약관 동의 (S1-1(입점 신청·심사·학원 정보·정산 계좌))

공통 규칙은 `README.md`(직원 인증은 §6). 데이터는 `03_data-model.md` §7-3·§7-4. 관련 요구: FR-070(학원 정보 등록) · FR-085(등록 형태·증빙) · FR-087(증빙 없으면 엄격 기준) · FR-125b(카드 수수료 입점 동의) · FR-139(정산 계좌 변경 재확인) · FR-240(판매자 정보) · FR-249(동의 기록) · FR-250(입점 심사·게시 제한) · FR-251(입점 조건 동의) · FR-259(약관 변경 30일 전 개별 통지). 보드: W1a · W2a(입점 신청) · W2b(입점·설정) · W22(학원 앱 페이지·강의실) · O35(약관·동의 기록).

## 흐름

```
직원 계정 로그인 + 2단계 인증 → 파일 올리기 → 신청서 초안 저장 → 약관 판본 받기 → 제출
→ (운영자) 심사 시작 → 승인(학원·지점·계좌·대표 연결 생성) 또는 거절(사유)
→ (대표) 입점·설정 · 학원 앱 페이지 · 강의실 · 정산 계좌 변경 · 동의 기록 · 약관 변경 통지 읽기
```

신청자 권한 `staff_self` = 2단계 인증을 마친 `active` 직원 계정(역할 무관). 신청자의 계정 만들기는 §0 대표 가입 경로로 한다(2026-11-20 D24 — 이전: 「강사 가입 경로(S2-1)를 같이 쓴다」. 강사 가입이 아직 없고 역할·동의 항목이 달라 경로를 나누되, 서비스 코드는 강사 가입이 함께 쓴다) — 휴대폰 본인확인 필수, 입점 신청 전에 2단계 인증(인증 앱) 등록(7-12 ① 확정, 사용자 2026-11-19).

## 0. 대표 가입 — 권한 `public` (S1-1.8 · FR-011(강사·대표 계정 승인) · FR-249(약관 동의 기록))

2026-11-20 D24(추천안, 사후 확인) 로 새로 적은 절이다. 요청·응답 모양은 `11-instructor.md` §1-1·§1-2 를 따른다.

흐름: 휴대폰 본인확인 토큰(가짜 어댑터 — `01-member-onboarding.md` §2) → ① `identity-check` → ② `username-available`(중복 확인) → ③ `signup` → Better Auth 아이디 로그인(`/api/auth/sign-in/username`) → 인증 앱 등록(`/api/auth/two-factor/enable` → `verify-totp`, S0-3.8 흐름 그대로) → 입점 신청(§2). **가입만으로는 `owner` 역할이 생기지 않는다** — 입점 승인 때 운영자가 준다(§3, `role_grants` 부여 경로). 인증 앱을 등록하지 않은 세션의 입점 신청 경로는 401 `SECOND_FACTOR_REQUIRED`(README §6-2 #3, 검사는 S1-1.10 이 입점 신청 경로와 함께 한다).

| 메서드·경로 | 역할 | 멱등 |
|---|---|---|
| `POST /api/owner/signup/identity-check` | 본인확인 결과로 가입 자격을 먼저 본다(같은 사람의 직원 계정이 있나 · 만 19세 이상인가) | 읽기 |
| `GET /api/owner/signup/username-available?username=` | 아이디 중복 확인 | 읽기 |
| `POST /api/owner/signup` | 대표(입점 신청자) 직원 계정 만들기 | 상태(CI·아이디 유니크) |

`identity-check` 요청 `{ "verificationToken": "…" }` → 200 `{ "eligible": true, "nameMasked": "김*표", "phoneMasked": "010-****-5821", "ageVerified": true }`

`username-available` → 200 `{ "available": true }` · `{ "available": false, "reason": "taken" }` — `reason` = `taken` · `format`(영문 소문자·숫자 4~20자 밖, Q41(강사 가입 규칙)과 같은 규칙)

`signup` 요청
```json
{ "verificationToken": "…", "username": "latinhouse01", "password": "Latin!2026x", "displayName": "김대표",
  "consents": { "merchantPrivacyCollection": true } }
```
201 `{ "accountId": "…", "username": "latinhouse01", "displayName": "김대표", "roles": [], "next": "sign_in" }`

- 한 트랜잭션: `auth.user`(Better Auth `username` 칸) · `auth.account`(비밀번호) · `staff_accounts`(CI 해시 · 생년월일 · 가린 연락처) · 감사 `owner.signup_completed`. 역할 행(`role_grants`)은 만들지 않는다. 세션도 만들지 않는다 — 앱이 이어서 로그인 경로를 부른다
- 개인정보 수집·이용 동의(필수 하나 — 열린 점 ② 확정)는 그때 시행 중인 `merchant_privacy_collection` 판본(§2 「현재 판본」 규칙과 같음)으로 기록한다. `staff_consents`(데이터 모델 §8-2)가 아직 없어(S2-1.1(강사 테이블)) **감사 행 `after.consents` 에 판본 id·서버 시각을 남긴다**(추가 전용·수정 불가 — 열린 점 ⑤). 판본이 발행돼 있지 않으면 500(운영자가 먼저 발행한다)
- 만 19세는 본인확인 생년월일로, 기준일은 요청 시각의 KST 날짜(강사와 같음 — 대표 연령 기준은 열린 점 ⑤)
- 비밀번호: 8자 이상 · 영문·숫자·기호를 모두 섞음 · 아이디와 같으면 안 됨(Q41). `displayName` 은 앞뒤 공백을 뺀 1~30자(**추천값**)
- 요청 제한: 세 경로 모두 같은 IP 기준(README §6-4). `identity-check`·`signup` 은 본인확인 규칙(`RATE_LIMIT_IDENTITY_*`), `username-available` 은 15분 30회(**추천값**)

| HTTP | code | 언제 |
|---|---|---|
| 422 | `VALIDATION_FAILED` | 토큰이 없거나 무효·만료(유효 10분) · 아이디·비밀번호·이름 형식(`fields`) |
| 422 | `OWNER_UNDER_19` | 만 19세 미만 |
| 422 | `CONSENT_REQUIRED` | `merchantPrivacyCollection` 이 true 가 아님 |
| 409 | `STAFF_ACCOUNT_EXISTS` | 같은 CI 의 직원 계정이 이미 있다(`uq_staff_accounts_ci` 가 최종 방어선). 본문에 `maskedUsername`(예: `"lat***e01"`). 새 계정은 만들지 않는다 — 강사 계정이 있는 사람은 그 계정으로 로그인해 입점을 신청한다(`staff_self` 는 역할 무관) |
| 409 | `USERNAME_TAKEN` | 아이디 중복 |
| 429 | `RATE_LIMITED` | 위 요청 제한 |

## 1. 파일

| 메서드·경로 | 권한 | 요청 | 응답 |
|---|---|---|---|
| `POST /api/files` | `staff_self` | `multipart/form-data`: `purpose`(`merchant_evidence`·`academy_photo`), `file` | 201 `{ "fileId", "displayName", "mimeType", "sizeBytes", "visibility" }` |
| `GET /api/files/{fileId}` | 올린 사람 · 그 파일이 붙은 학원의 대표 · `admin` | — | 200 파일 바이트(`Content-Disposition: attachment`) · 공개 사진은 공개 경로로 따로 내린다 |

- 서버가 첫 바이트로 형식을 다시 확인한다(확장자·`Content-Type` 을 믿지 않는다). 사진은 긴 변 2,000px 로 줄여 저장(6-8 **추천값**)
- 오류: 422 `FILE_TYPE_NOT_ALLOWED`(JPEG·PNG·WebP·PDF 밖) · 422 `FILE_TOO_LARGE`(10MB 초과) · 403 `FORBIDDEN`(남의 비공개 파일, S1-1 수용 ⑥)
- 붙이지 않은 파일은 24시간 뒤 정리 작업이 지운다(6-7)

시간 작업(README §1 「내부 경로」 — `X-Internal-Token`, 멱등. 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다) — 2026-11-20 S1-1.35(주인 없는 올린 파일 정리 작업) 구현 때 추가

| 메서드·경로 | 언제 | 하는 일 | 응답 |
|---|---|---|---|
| `POST /api/internal/jobs/files/purge-unattached` | 매일(플랜 6-7) | `attached_at IS NULL` 이고 `created_at ≤ now − 24시간` 이며 신청 증빙·통장 사본이 가리키지 않는 `uploaded_files` 행을 지우고, 그다음 저장소 바이트를 지운다(행 먼저 — 지우는 사이 붙인 파일이 바이트 없이 남지 않게) | 200 `{ "cutoff": "…Z", "deleted": 3, "storageFailed": 0 }` |

## 2. 입점 신청(대표 쪽) — W2a

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/merchant-applications/me` | 열린 신청 또는 마지막 신청. 없으면 404 |
| `PUT /api/merchant-applications/me/draft` | 1·2단계 저장(전체 교체). 초안이 없으면 만든다. `submitted` 이후면 409 `APPLICATION_NOT_EDITABLE` |
| `GET /api/terms/merchant-onboarding` | 3단계에 보일 항목별 **현재 판본** |
| `POST /api/merchant-applications/me/submit` | 제출. 헤더 `Idempotency-Key` |
| `POST /api/merchant-applications/me/withdraw` | `draft`·`submitted` 만 → `withdrawn` |

초안 요청(모든 칸 선택 — 제출 때 검사)
```json
{ "academyName": "라틴하우스 강남", "branchName": "강남점", "businessName": "라틴하우스", "representativeName": "김대표",
  "businessRegistrationNumber": "1234567890", "mailOrderReportNumber": null, "businessAddress": "서울 강남구 테헤란로 000, 3층",
  "region": { "sido": "서울", "gu": "강남구" }, "phone": "0200000000", "registrationType": "sports_facility", "industryCode": "921902",
  "documents": [ { "docKind": "business_registration", "fileId": "…" }, { "docKind": "sports_facility_report", "fileId": "…" } ],
  "payoutAccount": { "bankCode": "088", "accountNumber": "110000000521", "holderName": "라틴하우스" } }
```
응답 200 `Application`(계좌번호는 `"accountMasked": "110-***-***521"` 로만 돌려준다).

`GET /api/terms/merchant-onboarding` 200
```json
{ "items": [ { "item": "merchant_terms", "termsVersionId": "…", "version": "1.0", "required": true, "label": "입점 약관" },
             { "item": "platform_fee_notice", "required": true }, { "item": "card_fee_notice", "required": false, "gates": "card_payment" },
             { "item": "content_license", "required": true }, { "item": "one_plus_one_notice", "required": true, "label": "1+1 할인권 안내 확인" } ] }
```
`platform_fee_notice` 판본 본문은 상품 분류별 요율(일반 5% · 개인 레슨 1%, 결정 12 — `platform_fee_rates`)과 입점 1년 면제(일반 수업·행사에만, 개인 레슨 1% 는 입점 면제 대신 강사 가입일부터 1년 면제 뒤 적용 — 결정 13, 2026-11-23 변경 — 이전: 바로 적용)를 적는다. W2a(입점 신청) 에 「개인 레슨 1%는 강사 가입일부터 1년 면제 뒤 적용」 안내 줄이 들어갔다(2026-11-23 보드 문구 고침 — 이전: 「개인 레슨은 처음부터 1%」)(2026-11-20 보드 대조 — 이전: 「W2a 의 「플랫폼 수수료 5%」 한 줄은 아직 개인 레슨 1% 를 모른다(다른 작업이 고친다)」). `required` 는 보드 W2a 기준이다(카드 수수료는 「동의하지 않으면 카드 결제가 닫혀요」). 개인정보 수집·이용 동의는 입점 동의가 아니라 대표 가입 때 받는다 — 열린 점 ② 확정(사용자 2026-11-19).

제출 요청 `{ "consents": [ { "termsVersionId": "…", "agreed": true }, … ] }`

| 순서(한 트랜잭션) | 실패 |
|---|---|
| 1 같은 키 재요청이면 처음 응답 그대로 200 | — |
| 2 신청이 `draft` | 409 `APPLICATION_NOT_EDITABLE` |
| 3 판매자 정보 6항목(상호·대표자명·주소·전화·사업자등록번호 + 신고 대상이면 통신판매업 신고번호) 존재, 사업자등록번호 10자리 | 422 `VALIDATION_FAILED`(`fields`) |
| 4 증빙: 사업자등록증 + 등록 형태별 1종(미등록은 사업자등록증만) | 422 `EVIDENCE_MISSING` |
| 5 `termsVersionId` 가 각 항목의 **현재 판본**, 필수 항목 전부 `agreed=true` | 409 `TERMS_VERSION_OUTDATED` · 422 `REQUIRED_CONSENT_MISSING`(S1-1 수용 ①) |
| 6 `merchant_consents` 를 항목마다 1행(`agreed_at` = 서버 시각) · 파일 `attached_at` · 상태 `submitted` · 감사 `merchant_application.submitted` | — |

응답 200 `Application`(`status: "submitted"`). 운영자에게 가는 알림은 S7-4(운영자 도구) 몫이라 이 회차에는 만들지 않는다.

## 3. 심사(운영자) — 권한 `admin`

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/admin/merchant-applications?status=submitted&cursor=` | 목록 `{items, nextCursor}` — 계좌는 가린 값 |
| `GET /api/admin/merchant-applications/{id}` | 상세 + 증빙 파일 id |
| `POST /api/admin/merchant-applications/{id}/start-review` | `submitted` → `in_review`. 이미 `in_review` 면 200 같은 본문 |
| `POST /api/admin/merchant-applications/{id}/approve` | `in_review` → `approved`. `Idempotency-Key` 필수 |
| `POST /api/admin/merchant-applications/{id}/reject` | `{ "reasonCode": "info_mismatch", "reasonText": "사업자등록증 상호와 신청 상호가 달라요" }` |

승인 트랜잭션: 조건부 갱신(`WHERE status='in_review'`, 0행이면 409 `APPLICATION_STATE_CONFLICT`) → `academies`(판매자 정보 사본, `registration_verified_at=now()`, `platform_fee_exempt_until` = 승인일 + 1년(면제를 받는 분류는 `platform_fee_rates.onboarding_exemption_applies` 가 정한다 — 개인 레슨 제외, 결정 13), `card_payment_enabled` = 카드 수수료 동의 여부) → `academy_branches` 1행 → `academy_payout_accounts` 1행(`holder_verify_method='operator_manual'`, R15(무료 조회 수단 미정)) → `academy_owners` → `role_grants(owner)`(이미 있으면 그대로) → `merchant_consents.academy_id` 채움 → 알림 `merchant_application_approved` → 감사. 응답 200 `{ "applicationId", "status": "approved", "academyId" }`.

거절: 사유 코드 필수(FR-250 4종, 값은 data-model §7-9), 알림 `merchant_application_rejected`(사유 포함), 감사. 거절된 신청자는 새 초안을 만들 수 있다.

## 4. 입점·설정(대표) — 권한 `owner`, W2b · W22

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/academies/{academyId}/settings` | 학원 정보·지점·등록 형태(승인 시각·업종코드)·정산 계좌(가린 값)·입점 조건 요약·면제 종료일·대기 중인 약관 변경. 응답 모양은 열린 점 ⑬(2026-11-20 S1-1.18) |
| `PATCH /api/academies/{academyId}/profile` | 지점 주소·운영시간·연락처·시설·주차·접근성(FR-070). 판매자 정보(상호·대표자명·주소·전화·통신판매업 번호)를 바꾸면 감사 `academy.seller_info_changed`. 등록 형태는 이 경로로 못 바꾼다(422) — 열린 점 ③. 요청·응답 모양은 열린 점 ⑭(2026-11-20 S1-1.19) |
| `POST /api/academies/{academyId}/registration-change` | 등록 형태 변경 신청(FR-085 · 열린 점 ③·⑫, 2026-11-20 S1-1.17 추가). 요청 `{ "registrationType": "sports_facility", "evidenceFileId": "…" }`(미등록이면 `null`). 정식 `registrationType` 은 운영자 재심사(S7-4) 전까지 **이전 값 그대로**, `registration_verified_at` 을 비워 그동안 FR-087 엄격 기준. 응답 200 `{ academyId, registrationType, registrationVerified, strictRefundStandard, pendingChange: { registrationType, evidenceFileId, requestedAt } \| null }`. 같은 신청 다시 → 200 같은 본문 · 다른 신청이 걸려 있으면 409 `REGISTRATION_CHANGE_PENDING` · 지금과 같은 형태 422 `VALIDATION_FAILED` · 서류 빠짐 422 `EVIDENCE_MISSING` · 감사 `academy.registration_change_requested` |
| `PUT /api/academies/{academyId}/app-page` | `{ "tagline", "intro", "photoFileIds": ["…"] }` 최대 10장, 순서 = 배열 순서. 11장 이상 422. 요청·응답 모양은 열린 점 ⑮(2026-11-20 S1-1.20) |
| `GET` · `POST /api/academies/{academyId}/rooms` | 강의실 목록 · 추가 `{ "branchId", "name": "A홀", "sizeSqm": 60, "baseCapacity": 24, "facilities": "마루 · 전신 거울 · 음향" }`. 이름 중복 409 `ROOM_NAME_TAKEN`. 요청·응답 모양은 열린 점 ⑱(2026-11-21 S1-2.13) |
| `POST /api/academies/{academyId}/rooms/{roomId}/archive` | 수업이 잡힌 강의실은 409 `ROOM_IN_USE`(W22 「지울 수 없어요」 — 회차가 생기는 M2 부터 실제로 걸린다). 응답·두 번 보관은 열린 점 ⑱(2026-11-21 S1-2.13) |

### 정산 계좌 변경 — `PUT /api/academies/{academyId}/payout-account` (FR-139)

요청·응답의 정하지 않았던 것은 열린 점 ⑯(2026-11-21 S1-1.21).

헤더 `Idempotency-Key`. 요청 `{ "bankCode": "088", "accountNumber": "110000000999", "holderName": "라틴하우스", "totpCode": "482107" }`

- 관리자 웹 전용(`surface='web'`). 앱 토큰으로 부르면 403 `FORBIDDEN`(앱에는 계좌 변경 입구가 없다)
- `totpCode` 를 이 요청에서 다시 확인한다(세션의 2단계 인증과 별개). 없으면 401 `SECOND_FACTOR_REQUIRED`, 틀리면 422 `TOTP_INVALID`(요청 제한 대상)
- 한 트랜잭션: 옛 행 `replaced` · 새 행 `active`(`holder_verified_at` NULL — 운영자 확인 전) · 알림 `payout_account_changed`(대표에게, 가린 번호) · 감사 `payout_account.changed`(전후 모두 가린 값)
- 응답 200 `{ "bankCode", "accountMasked", "holderName", "holderVerified": false, "changedAt" }`
- 예금주 확인은 통장 사본(또는 계좌 개설 확인서) 파일을 올리면 운영자가 이름을 대조하는 수동 확인이다(`holder_verify_method='manual_document'`, 증빙 `holder_proof_file_id`, 확인한 운영자 `holder_verified_by_account_id`·시각 `holder_verified_at`. R15 확정 2026-11-19). 유료 예금주 조회 API 는 쓰지 않는다. 확인 전 계좌로는 지급하지 않는다 — 지급 차단 자체는 S5-3(지급 승인) 몫이고 여기서는 칸만 둔다
- 입점 신청 제출·심사 때 사업자등록번호는 공공데이터포털 「국세청 사업자등록정보 진위확인 및 상태조회」 API(영구 무료, 하루 100만 건·1회 100건)로 진위·휴업·폐업을 조회한다. 정기 점검도 같은 API 를 쓴다(주기는 S1-1 의 값 미정 항목)

## 5. 약관·동의 기록 — O35 · W2b

| 메서드·경로 | 권한 | 응답 |
|---|---|---|
| `GET /api/academies/{academyId}/consents` | `owner` | `{ items: [{ item, version, termsVersionId, agreedAt, current: true }], pendingChanges: [{ noticeId, item, version, effectiveAt, notifiedAt, readAt }] }`. 요청·응답의 정하지 않았던 것은 열린 점 ⑰(2026-11-21 S1-1.24) |
| `GET /api/terms/versions/{termsVersionId}` | 로그인 직원 | `{ kind, version, body, publishedAt, effectiveAt }` — 동의한 판본 전문. 요청·응답의 정하지 않았던 것은 열린 점 ⑰(2026-11-21 S1-1.24) |
| `POST /api/academies/{academyId}/terms-notices/{noticeId}/read` | `owner` | 200. 이미 읽었으면 같은 본문. 요청·응답의 정하지 않았던 것은 열린 점 ⑰(2026-11-21 S1-1.24) |
| `POST /api/admin/terms-versions` | `admin` | `{ kind, version, body, effectiveAt }` → 201. 같은 kind 의 이전 판본이 있으면 `effectiveAt ≥ 지금 + 30일` 이 아니면 422 `NOTICE_PERIOD_TOO_SHORT`(FR-259 — 불리 여부를 가리지 않고 모두). 같은 트랜잭션에서 `active` 학원 전부에 `terms_change_notices` + 알림 `terms_change_notice`(category `operations`) · 감사 `terms_version.published` |

재동의 흐름(적용일 뒤 동의하지 않은 학원 처리)은 S7-3(재동의) 몫이다.

## 수용 시나리오

1. **Given** 필수 항목 중 콘텐츠 이용 허락만 `agreed=false` **When** 제출 **Then** 422 `REQUIRED_CONSENT_MISSING`, 신청은 `draft` 그대로, 동의 행 0개
2. **Given** 미등록(자유업) 신청에 사업자등록증이 없다 **When** 제출 **Then** 422 `EVIDENCE_MISSING`. 사업자등록증을 붙이면 등록 형태별 증빙 없이 제출된다
3. **Given** `in_review` 신청 **When** 운영자가 같은 `Idempotency-Key` 로 승인을 두 번 보낸다 **Then** 학원·대표 연결·계좌가 1개씩만 생기고 두 응답의 `academyId` 가 같다
4. **Given** 승인 전 신청 **When** 신청자가 `GET /api/academies/{academyId}/settings`(아무 학원 id) **Then** 403(대표 연결이 없다) — 승인 전에는 학원 자체가 없다
5. **Given** 대표 A 가 올린 증빙 파일 **When** 다른 학원 대표 B 가 `GET /api/files/{fileId}` **Then** 403. 운영자는 200
6. **Given** 대표가 관리자 웹에서 2단계 인증을 마쳤다 **When** `totpCode` 없이 계좌 변경 **Then** 401 `SECOND_FACTOR_REQUIRED`. 맞는 코드로 다시 보내면 활성 계좌가 1개만 남고 감사 기록에 끝 4자리만 남는다

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | 등록 형태별 필수 증빙 판정 · 사업자등록번호 형식 · 필수 동의 판정(`required`·`gates`) · 계좌 가리기 |
| DB(`requires_db`) | `uq_merchant_app_open` 두 번째 열린 신청 거부 · `uq_payout_accounts_active` · `ck_files_evidence_private` · `ck_files_size` |
| 통합(Route Handler) | 시나리오 1~6 · 파일 형식 위장(PDF 확장자의 실행 파일) 거부 · 승인 동시 2건 → 1건 성공 1건 409 · `NOTICE_PERIOD_TOO_SHORT` 경계(29일 23시간 거부, 30일 통과) |
| 보안(`ecc:security-reviewer`) | 파일 경로 조작 · 비공개 파일 직접 주소 · 응답·로그에 계좌 전체 번호 0건 |

## 열린 점

| # | 무엇 | 결정(① ② ③ 은 2026-11-19 사용자 확정, ④ 는 사용자 확인 대기) |
|---|---|---|
| ① | 입점 신청자의 계정 만들기와 본인확인 | **확정**: 대표 가입도 강사처럼 휴대폰 본인확인 필수 + 입점 신청 전에 2단계 인증(인증 앱) 등록 — 계좌번호를 받는 화면이라서 |
| ② | 필수 동의 항목 수 — 플랜 S1-1 은 「5항목」, W2a 는 필수 4 + 카드 수수료(카드 결제 조건), O35 는 개인정보 수집·이용을 더 보인다 | **확정**: 입점 필수 동의는 W2a 5개(플랫폼 수수료 · 결제·카드 수수료 대표 부담 · 1+1 할인권 안내 확인 · 콘텐츠 이용 허락 · 입점 약관). 개인정보 수집·이용 동의는 대표 가입 때 받는다 |
| ③ | 입점 뒤 등록 형태 변경 | **확정**: 운영자 재심사(그동안 FR-087 엄격 기준). 대표의 신청 경로 `POST …/registration-change` 는 §4 에 둔다(2026-11-20 S1-1.17 — 이전: 「별도 경로는 운영자 도구(S7-4)와 함께」). 운영자의 받아들이기·돌려보내기 경로는 운영자 도구(S7-4)와 함께 |
| ④ | 예금주 확인 전 계좌의 지급 허용 | **확정(2026-11-19)**: 통장 사본 수동 확인 전에는 지급하지 않는다. 송금 반송은 FR-133a(정산 송금 반송)대로 지급 보류 |
| ⑤ | 대표 가입(§0)의 남은 것 — ⓐ 가입 동의 기록 자리(`staff_consents` 가 생기면 감사 행에서 옮길지) ⓑ 대표도 만 19세 이상인가 ⓒ 본인확인 이름 칸(`identity_name_*`, 데이터 모델 §8 열린 점 ⑩)과 연락처 암호화(`phone_enc`, 키 미정 — 지금은 가린 값만 저장) | 임시 확정(2026-11-20 S1-1.8 — 추천안으로 진행, 사후 확인): ⓐ 감사 행 ⓑ 강사·회원과 같은 만 19세 ⓒ 칸이 생길 때 채운다 |
| ⑥ | 초안 저장·조회(§2, S1-1.10)의 정하지 않았던 것 — ⓐ `Application` 응답 모양 ⓑ 승인된 신청자의 새 초안 ⓒ 계좌번호 암호화 키 ⓓ 「전체 교체」에서 계좌를 다시 보내지 않으면 | 임시 확정(2026-11-20 S1-1.10 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `{ applicationId, status, academyName, branchName, businessName, representativeName, businessRegistrationNumber, mailOrderReportNumber, businessAddress, region{sido,gu}, phone, registrationType, industryCode, documents[{docKind,fileId}], payoutAccount{bankCode, accountMasked, holderName}, rejectReasonCode, rejectReasonText, academyId, submittedAt, decidedAt, createdAt, updatedAt }` — 빈 칸은 `null` ⓑ 409 `APPLICATION_NOT_EDITABLE`(두 번째 학원 입점은 계약에 없다). 거절·철회 뒤에는 새 초안 ⓒ AES-256-GCM, 새 필수 비밀값 `FIELD_ENCRYPTION_KEY`(32바이트 base64, S0-6 목록) — 베타·운영 값은 배포 때 사람이 넣는다 ⓓ 계좌 칸도 비운다(원문은 응답에 없으므로 화면이 1·2단계 저장 때 계좌를 늘 함께 보내야 한다 — W2a 구현 때 확인). 증빙은 내가 올린 `merchant_evidence` 파일만, 아니면 422 `VALIDATION_FAILED`(`documents.N.fileId`) |
| ⑦ | 제출(§2, S1-1.11)의 정하지 않았던 것 — ⓐ 멱등 키를 어디에 남기나(`merchant_applications` 에 키 칸이 없다) ⓑ 3단계가 판매자 정보 말고 무엇을 더 보나 ⓒ FR-087 「증빙 없는 학원」 표시를 어디에 두나 ⓓ 신청이 아예 없을 때 | 임시 확정(2026-11-20 S1-1.11 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ 테이블을 늘리지 않고 감사 행 `merchant_application.submitted` 의 `after` 에 키 지문(`sha256("merchant-submit:" + 직원 id + ":" + 키)`, 원문은 남기지 않음)과 처음 응답(`response`, 계좌는 가린 값)을 넣는다. 같은 사람·같은 키면 그 응답을 그대로 200. 다른 키로 다시 내면 409 `APPLICATION_NOT_EDITABLE` ⓑ 승인 트랜잭션이 NOT NULL 로 깨지지 않도록 학원 이름·지점 이름·지역(시도·구)·등록 형태·정산 계좌(은행·번호·예금주)도 필수(`fields` 경로 `region.sido`·`payoutAccount.accountNumber` 등). 통신판매업 신고번호는 「신고 대상」 여부를 받지 않아 비어도 통과 ⓒ 미등록(`unregistered`) = 등록 형태 증빙이 없는 학원 → 감사 `after.strictRefundStandard: true`. 응답 모양(⑥ ⓐ)은 바꾸지 않았다 — 환불 공지 템플릿(09)은 승인 뒤 학원 값으로 판정한다 ⓓ 404 `NOT_FOUND`. 422 `EVIDENCE_MISSING`·`REQUIRED_CONSENT_MISSING` 의 `detail` 에 빠진 서류·항목 이름을 적는다(별도 칸 없음) |
| ⑧ | 철회(§2, S1-1.12)의 정하지 않았던 것 — ⓐ 철회할 수 없는 상태의 응답 ⓑ 이미 철회한 신청을 다시 철회 ⓒ 본문 ⓓ 기록 | 임시 확정(2026-11-20 S1-1.12 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `in_review`(심사 중)·`approved`·`rejected` 는 409 `APPLICATION_NOT_EDITABLE`(새 코드를 만들지 않음, `detail` 로 「심사 중」·「심사가 끝난」 구분). 신청이 없으면 404 `NOT_FOUND` ⓑ 마지막 신청이 `withdrawn` 이면 200 같은 본문(README 「이미 `cancelled` 면 200 같은 본문」과 같은 방식, `Idempotency-Key` 없음) ⓒ 본문 없음 또는 `{}` 만 — 다른 칸은 422 `VALIDATION_FAILED` ⓓ 감사 `merchant_application.withdrawn`(`before.status` = `draft`·`submitted`). 응답 200 `Application`(`status: "withdrawn"`). 붙인 증빙 파일의 `attached_at` 은 그대로 둔다 |
| ⑨ | 운영자 심사 목록·상세(§3, S1-1.13)의 정하지 않았던 것 — ⓐ 응답 모양 ⓑ 무엇이 보이나 ⓒ 순서·커서·쪽 크기 ⓓ 틀린 쿼리·id | 임시 확정(2026-11-20 S1-1.13 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ 항목·상세 모두 ⑥ ⓐ `Application`(계좌는 `accountMasked` 만) + `applicant{staffAccountId, displayName}`. 증빙 파일 id 는 `documents[].fileId`(파일 바이트는 `GET /api/files/{fileId}` — 운영자 200) ⓑ 한 번이라도 제출된 신청만(`submitted_at IS NOT NULL`) — 쓰는 중인 초안·제출 안 한 철회는 목록에 없고 상세는 404 `NOT_FOUND`. `status` 는 `submitted`·`in_review`·`approved`·`rejected`·`withdrawn` 중 하나, 비우면 전부 ⓒ 제출 시각 이른 순(같으면 id), `nextCursor` = (제출 시각, id) 를 base64url 로 감싼 글자, 쿼리 `limit` 1~100(기본 20) ⓓ 틀린 커서·`status=draft`·모르는 쿼리 칸·범위 밖 `limit` 은 422 `VALIDATION_FAILED`. 모양이 틀린 id 는 404. 권한은 `requireStaff("admin", web)` — 대표·신청자 본인도 403(있는 id 여도), 2단계 전 401. 열람 감사 행은 남기지 않는다(계약에 없음) |
| ⑩ | 심사 시작·승인(§3, S1-1.14)의 정하지 않았던 것 — ⓐ 심사 시작 응답·본문 ⓑ 승인 멱등 키를 어디에 남기나 ⓒ 승인 때 예금주 확인 칸(§3 본문은 `holder_verify_method='operator_manual'`, data-model §7-3·R15 는 `manual_document`(통장 사본) 만) ⓓ 계좌 행의 `created_by_account_id` ⓔ 면제 종료일 계산 ⓕ 첫 지점·알림 모양 | 임시 확정(2026-11-20 S1-1.14 — D20 에 따라 추천안으로 진행, 사후 확인. ⓒ 는 두 문서가 어긋나 사람 확인 권장): ⓐ 응답 200 = ⑨ ⓐ 운영자 `Application`(+`applicant`). 본문은 없음 또는 `{}` 만(다른 칸 422). 초안·없는 id·모양 틀린 id 404, `submitted`·`in_review` 밖(승인·거절·철회)은 409 `APPLICATION_STATE_CONFLICT`. `reviewed_by_account_id`·`review_started_at` 을 채우고 감사 `merchant_application.review_started`. 이미 `in_review` 면 아무것도 바꾸지 않는다 ⓑ 제출(⑦ ⓐ)과 같이 감사 행 `merchant_application.approved` 의 `after` 에 키 지문 `sha256("merchant-approve:" + 신청 id + ":" + 키)` 와 처음 응답. 신청 행을 `FOR UPDATE` 로 잠근 뒤 재생을 찾고, 그다음 조건부 갱신 — 같은 키 동시 2건은 둘 다 200 같은 `academyId`, 다른 키 동시 2건은 1건 200 · 1건 409. 순서: 권한 → 키(없으면 400) → 본문 → id ⓒ 승인 때는 확인하지 않은 채로 둔다(`holder_verified_at`·`holder_verify_method` NULL) — 승인 서류에 통장 사본이 없고, 확인 전 계좌로는 지급하지 않는다(④). 확인은 S1-1.22(예금주 확인 상태) 몫 ⓓ 계좌를 입력한 신청자 ⓔ 승인일(KST 날짜) + 1년, 그날까지 면제(분류별 적용은 `platform_fee_rates`) ⓕ 지점 = 신청서 지점 이름·사업장 주소·지역·전화. 알림은 신청자 직원 알림함 1건(category `approval`, `dedupe_key` `merchant_application:<id>:approved`, payload `{applicationId, academyId}`). 계좌번호는 신청서 칸에서 풀어 `academy_payout_accounts.account_enc` 칸 이름으로 다시 암호화한다. 대표 역할은 `role_grants` 부여 함수(이미 있으면 그대로)를 같은 트랜잭션에서 부른다 |
| ⑪ | 반려(§3, S1-1.15)의 정하지 않았던 것 — ⓐ 본문 규칙 ⓑ 반려할 수 있는 상태 ⓒ 두 번 보내면(계약에 `Idempotency-Key` 없음) ⓓ 응답 ⓔ 알림·감사 모양 ⓕ 신청자가 사유를 받는 자리 | 임시 확정(2026-11-20 S1-1.15 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `{ reasonCode, reasonText }` 둘 다 필수. `reasonCode` 는 data-model §7-9 4종(`info_mismatch`·`registration_missing`·`prior_termination`·`trust_violation`), `reasonText` 는 앞뒤 공백을 지운 1~500자. 다른 칸·빈 글·4종 밖은 422 `VALIDATION_FAILED`, JSON 아님·빈 본문은 400. 순서: 권한 → 본문 → id ⓑ `in_review` 만(승인과 같음 — 먼저 심사를 시작한다). `submitted`·`withdrawn`·`approved` 는 409 `APPLICATION_STATE_CONFLICT`, 초안·없는 id·모양 틀린 id 404. 신청 행을 `FOR UPDATE` 로 잠그고 조건부 갱신(`WHERE status='in_review'`) — 반려와 승인이 동시에 오면 하나만 200, 다른 하나 409 ⓒ 이미 `rejected` 이고 사유 코드·글이 같으면 아무것도 바꾸지 않고 200 같은 본문(알림·감사 더 없음). 사유가 다르면 409(처음 사유를 덮어쓰지 않음) ⓓ 200 = ⑨ ⓐ 운영자 `Application`(+`applicant`, `status: "rejected"`, `rejectReasonCode`·`rejectReasonText`·`decidedAt`). `reviewed_by_account_id` = 반려한 운영자 ⓔ 알림: 신청자 직원 알림함 1건(category `approval`, `academy_id` 없음, `dedupe_key` `merchant_application:<id>:rejected`, payload `{applicationId, reasonCode, reasonText}`). 감사 `merchant_application.rejected`(`before.status` `in_review`, `after` `{status, reasonCode, reasonText}`) ⓕ 신청자는 `GET /api/merchant-applications/me` 의 `rejectReasonCode`·`rejectReasonText` 와 알림으로 받는다. 다음 `PUT …/me/draft` 가 새 행(새 `applicationId`)을 연다 — 옛 신청에 붙은 증빙 파일은 다시 쓸 수 없어(`uq_app_docs_file`) 새로 올린다 |
| ⑫ | 등록 형태 변경 신청(§4, S1-1.17)의 정하지 않았던 것 — ⓐ 신청을 어디에 적나 ⓑ 그동안 무엇이 적용되나 ⓒ 증빙 ⓓ 두 번 보내면·다른 신청이 걸려 있으면 ⓔ 운영자가 돌려보낼 때 되돌릴 값 | 임시 확정(2026-11-20 S1-1.17 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ 새 표 없이 `academies` 에 칸 셋 — `pending_registration_type`·`pending_registration_evidence_file_id → uploaded_files`·`registration_change_requested_at`(`ck_academies_registration_change`: 형태와 시각은 함께 차거나 함께 빈다, 신청 없이 서류만 둘 수 없다). 한 학원에 걸린 신청은 하나 ⓑ `registration_type` 은 이전 값 그대로(FR-088 표시·설정 조회는 이전 형태), `registration_verified_at` 은 비운다 → 엄격 기준(spec 「재심사가 끝나기 전에는 엄격 기준」, data-model §7-12 ⑥). 조회 기준 함수 `readAcademyRegistration` 를 설정 조회(S1-1.18)가 같이 쓴다 ⓒ 새 형태를 증명하는 서류 1장(내가 올린 `merchant_evidence`, 아직 어디에도 붙지 않은 파일 — 아니면 422 `VALIDATION_FAILED` `evidenceFileId`). 사업자등록증은 입점 때 냈으므로 다시 받지 않는다. 미등록이면 서류 없음(붙이면 422) ⓓ `Idempotency-Key` 없이 학원 행 `FOR UPDATE` — 같은 형태·같은 파일이면 200 같은 본문(감사 더 없음), 다르면 409 `REGISTRATION_CHANGE_PENDING`(처음 신청을 덮어쓰지 않음) ⓔ 감사 `before` 에 이전 형태와 확인 여부를 남긴다 — 돌려보낼 때 확인 시각을 되살릴지는 S7-4 가 정한다. 권한은 `owner` + 관리자 웹 2단계(운영자는 403) |
| ⑬ | 학원 설정 조회(§4, S1-1.18)의 정하지 않았던 것 — ⓐ 응답 모양 ⓑ 「입점 조건 요약」에 무엇을 담나 ⓒ 계좌가 없을 때 ⓓ 없는 학원 id | 임시 확정(2026-11-20 S1-1.18 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `{ academyId, name, status, approvedAt, seller{businessName, representativeName, businessRegistrationNumber, mailOrderReportNumber, businessAddress, phone}, branches[{branchId, name, address, region{sido,gu}, phone, openingHours, facilities, parking, accessibility}](만든 순서), registration{registrationType, registrationVerified, strictRefundStandard, pendingChange, verifiedAt, industryCode}(§4 등록 형태 변경 응답과 같은 기준 함수 `readAcademyRegistration` — 재심사 전에는 이전 형태), payoutAccount{bankCode, accountMasked, holderName, holderVerified}, onboardingTerms{platformFeeExemptUntil(KST 날짜), cardPaymentEnabled, agreedItems}, pendingTermsChanges }` — 빈 칸은 `null`. `Cache-Control: private, no-store` ⓑ 면제 종료일 · 카드 결제 여부 · 항목마다 지금 유효한 동의(§5 `GET …/consents` 의 `items` 와 같은 모양). `pendingTermsChanges` 는 §5 `pendingChanges` 와 같다(시행 전인 통지만) ⓒ 활성 계좌가 없으면 `payoutAccount: null`, 지점이 없으면 빈 목록 ⓓ 공통 가드 순서(README §6-2 ⑤ 학원 존재 → ⑥ 대표)대로 없는 id 는 404, 있는 남의 학원 id 는 403 — 수용 ④ 의 「아무 학원 id → 403」은 「있는 학원 id」로 확인했다(없는 id 의 404 는 가드 공통 규칙이라 이 경로만 바꾸지 않았다. 사람 확인 권장). 권한은 `owner` + 관리자 웹 2단계(운영자 403) |
| ⑭ | 학원 정보·판매자 정보 수정(§4, S1-1.19)의 정하지 않았던 것 — ⓐ 요청 모양 ⓑ 못 바꾸는 칸 ⓒ 감사를 언제 남기나 ⓓ 남의 지점 id ⓔ 응답 | 임시 확정(2026-11-20 S1-1.19 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `{ seller?: { businessName?, representativeName?, businessAddress?, phone?, mailOrderReportNumber? }, branches?: [{ branchId, address?, region?{sido,gu}, phone?, openingHours?, facilities?, parking?, accessibility? }] }` — 보낸 칸만 바뀐다(PATCH). 앞뒤 공백은 지운다. 전화는 하이픈을 걷어 숫자 8~12자리(입점 신청과 같음). 상호·대표자명·사업장 주소·판매자 전화·지점 주소·지역은 비울 수 없고(FR-250 판매자 정보를 다 채워야 결제가 열린다), 통신판매업 번호·지점 전화·운영시간·시설·주차·접근성은 `null`·빈 글자로 지운다. 같은 지점 두 번·지점 50곳 넘게는 422 ⓑ strict 스키마라 모르는 칸은 모두 422 `VALIDATION_FAILED` — 등록 형태(열린 점 ③, `registration-change` 로) · 사업자등록번호(입점 심사 대상이라 대표가 못 바꾼다) · 학원·지점 이름(이 경로 범위 밖) ⓒ 판매자 칸 가운데 **지금 값과 실제로 다른 칸이 있을 때만** 감사 1행 `academy.seller_info_changed`(`before`·`after` 에 바뀐 칸만, 카멜 표기). 같은 값 재전송은 감사 0. 지점 정보는 감사하지 않는다(data-model §7-3 은 판매자 칸만 감사 ○) ⓓ 이 학원 지점이 아니거나 없는 지점은 422 `fields` `branches.N.branchId`(남의 지점이 있는지 알려 주지 않는다). 한 트랜잭션이라 같은 요청의 판매자 변경·감사도 되돌아간다. 학원 행 `FOR UPDATE` 로 같은 학원 수정이 한 줄로 선다 ⓔ 200 = 설정 조회(⑬ ⓐ)와 같은 본문(같은 읽기 함수), `Cache-Control: private, no-store`. 빈 본문 `{}` 도 200(바뀐 것 없음). 권한은 `owner` + 관리자 웹 2단계(운영자 403), 없는 학원 id 404(⑬ ⓓ 와 같은 가드 순서) |
| ⑮ | 학원 앱 페이지(§4, S1-1.20(학원 앱 페이지 API))의 정하지 않았던 것 — ⓐ 요청 모양 ⓑ 쓸 수 있는 사진 ⓒ 목록에서 빠진 사진 ⓓ 응답 ⓔ 감사 ⓕ 대표 앱(O30) | 임시 확정(2026-11-20 S1-1.20 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ PUT = 전체 교체라 `tagline`·`intro`·`photoFileIds` 셋 다 필수(strict, 모르는 칸 422). 글은 앞뒤 공백을 지우고 빈 글자면 `null`. 길이 상한(**추천값**) 한 줄 소개 60자 · 소개 글 2,000자. `photoFileIds` 는 uuid 0~10개, 11개 이상 422 `VALIDATION_FAILED`(`photoFileIds`), 같은 id 두 번 422. 배열 순서대로 `academy_photos.position` 0 부터 ⓑ `purpose='academy_photo'` 이면서 이 학원에 이미 걸린 사진이거나, 내가 올렸고 아직 어디에도 안 붙은 파일. 그 밖(남의 파일·다른 학원 사진·증빙·없는 파일)은 똑같이 422 `fields` `photoFileIds.N`(있는지 알려 주지 않는다). 새로 붙은 파일은 `attached_at` 을 찍는다 ⓒ 자리 행을 지우고 `attached_at` 을 비운다 → 24시간 정리 작업(S1-1.35)이 지운다. 정리 작업·파일 내려받기(S1-1.7)도 `academy_photos` 를 「붙은 자리」로 본다 ⓓ 200 `{ academyId, tagline, intro, photoFileIds }`(저장된 순서), `Cache-Control: private, no-store` ⓔ 감사 없음(data-model §7-3 은 판매자 칸만 감사 ○) ⓕ 권한은 `owner` + 관리자 웹 2단계(운영자 403). 대표 앱(O30 사진·소개)은 앱 토큰 경로가 생길 때 같은 처리기를 `surface='app'` 으로 붙인다. 학원 행 `FOR UPDATE` 로 같은 학원 저장이 한 줄로 선다. 테이블 `academy_photos` 는 이 Task 의 마이그레이션 `20261120T1455_academy_photos` 가 만들었다 |
| ⑯ | 정산 계좌 변경(§4, S1-1.21(정산 계좌 변경 API))의 정하지 않았던 것 — ⓐ 멱등 키를 어디에 남기나 ⓑ 검사 순서 ⓒ 코드 확인 방법·요청 제한 ⓓ 「앱 토큰이면 403」 ⓔ 알림 모양 ⓕ 감사 모양 | 임시 확정(2026-11-21 S1-1.21 — D20 에 따라 추천안으로 진행, 사후 확인. ⓓ 는 사람 확인 권장): ⓐ 헤더 필수(없으면 400). 승인(⑩ ⓑ)과 같이 감사 행 `payout_account.changed` 의 `after` 에 키 지문 `sha256("payout-account-change:" + 학원 id + ":" + 직원 id + ":" + 키)` 와 처음 응답. 학원 행 `FOR UPDATE` 뒤 재생을 찾는다 — 같은 키면 본문이 달라도 처음 응답 200(README §4.9 주문 규칙) ⓑ 권한(세션 → 2단계 세션 → 대표) → 키 400 → 본문 422(`bankCode` 숫자 3자리 · `accountNumber` 하이픈·공백을 걷어 숫자 10~16자리 · `holderName` 1~50자, 모르는 칸 422) → `totpCode` 없음·빈 글자 401 `SECOND_FACTOR_REQUIRED` → 틀림 422 `TOTP_INVALID` → 트랜잭션 ⓒ Better Auth 2단계 플러그인과 같은 방법(저장된 비밀값을 풀어 6자리·30초·앞뒤 한 칸)으로 견준다(`lib/server/staff-totp.ts`). 틀린 횟수는 로그인 실패와 같은 칸(`authFailure`, 계정 단위, 기본 15분 5회)에 세고 넘으면 429 `RATE_LIMITED` ⓓ 지금은 세션만으로 웹과 앱을 가를 수 없다(관리자 웹 테스트도 Bearer 로 부른다). 앱 토큰 세션은 2단계 표시가 없어 콘솔 가드에서 401 `SECOND_FACTOR_REQUIRED` 로 막힌다 — 403 `FORBIDDEN` 으로 따로 가르는 것은 앱 토큰 경로가 생길 때 정한다 ⓔ 학원의 지금 대표(`academy_owners` active)에게 1건, category `settlement`, `dedupe_key` `payout_account:<새 계좌 id>:changed`, payload `{academyId, payoutAccountId, bankCode, accountMasked, holderName}` — 바꾼 사람이 대표 자신이어도 보낸다(남이 세션을 쓴 경우를 알아차리게) ⓕ `actor_role` `owner`, `target_table` `academy_payout_accounts`, `target_id` 새 계좌 id. `before` `{payoutAccount: {payoutAccountId, bankCode, accountMasked, holderName} \| null}`(옛 계좌), `after` `{payoutAccount: {…, holderVerified: false}, idempotencyKeySha256, response}` — 계좌는 가린 값(`110-***-***999`)만. 새 계좌는 `holder_verified_at`·`holder_verify_method` NULL(확인은 S1-1.22(예금주 확인 상태)) |
| ⑰ | 동의 기록·약관 전문·통지 읽음(§5, S1-1.24(동의 기록·약관 전문·통지 읽음 API))의 정하지 않았던 것 — ⓐ 어느 화면 기준(surface)인가 ⓑ `items` 에 무엇을 담나(`current`) ⓒ `pendingChanges` 범위·순서 ⓓ 읽음 응답 본문과 틀린 id ⓔ 대표 가입 때의 개인정보 수집·이용 동의 | 임시 확정(2026-11-21 S1-1.24 — D20 에 따라 추천안으로 진행, 사후 확인. ⓐ 는 사람 확인 권장): ⓐ 세 경로 모두 관리자 웹 기준 — 2단계 인증을 마친 세션만 받는다. 대표 경로 둘은 `owner` 콘솔 가드(운영자 403, 없는 학원 404, 남의 학원 403), 판본 전문은 로그인한 active 직원이면 역할 무관(S1-1.9 의 staff_self 와 같음, 세션 없음·2단계 전 401). 대표 앱(O35)이 앱 토큰으로 2단계 없이 부르게 할지는 앱 화면 Task 가 정한다 ⓑ 항목(kind)마다 철회하지 않은 가장 최근 동의 하나만 담는다 → `current` 는 늘 `true`. 철회한 항목은 목록에 없다 ⓒ 이 학원에 온 통지 가운데 시행일이 지금보다 뒤인 것만, 시행일 이른 순(같으면 통지 id). 시행일이 지난 변경은 S7-3(재동의) 몫이라 뺀다 ⓓ 읽음 200 본문 = `pendingChanges` 한 줄과 같은 모양 `{ noticeId, item, version, effectiveAt, notifiedAt, readAt }`. `read_at IS NULL` 일 때만 채워 두 번째 호출도 처음 읽은 시각 그대로 같은 본문. 이 학원의 통지가 아닌 id·없는 id·모양 틀린 id 는 404 `NOT_FOUND`(판본 전문의 없는·모양 틀린 id 도 404) ⓔ 대표 가입 동의는 `staff_consents`(S2-1.1) 가 생기기 전까지 감사 행에만 있어(열린 점 ⑤ ⓐ) 동의 기록에 나오지 않는다 |
| ⑱ | 강의실 목록·추가·보관(§4, S1-2.13(강의실 목록·추가·보관 API))의 정하지 않았던 것 — ⓐ 강의실 한 줄 모양 ⓑ 목록 범위·순서 ⓒ 추가 요청 검사 ⓓ 남의 지점 id ⓔ 이름 중복 기준 ⓕ 보관 응답·두 번 보관 ⓖ `ROOM_IN_USE` | 임시 확정(2026-11-21 S1-2.13 — D20 에 따라 추천안으로 진행, 사후 확인): ⓐ `{ roomId, branchId, branchName, name, sizeSqm, baseCapacity, facilities, status, createdAt }` — 빈 칸은 `null`, `status` 는 `active`·`archived`. 목록 `{ items }`·추가 201·보관 200 모두 이 모양, `Cache-Control: private, no-store` ⓑ 이 학원 모든 지점의 `active` 강의실만(보관한 것은 빠진다), 지점 만든 순서 → 강의실 만든 순서. 쪽 나누기 없음 ⓒ strict — `branchId`(uuid) · `name` 앞뒤 공백을 지우고 1~40자 · `sizeSqm` 1~10000 정수 · `baseCapacity` 1~1000 정수 · `facilities` 200자(빈 글자는 `null`). 셋은 빼거나 `null` 가능, 모르는 칸 422 `VALIDATION_FAILED` ⓓ 이 학원 지점이 아니거나 없는 지점은 422 `fields` `branchId`(⑭ ⓓ 와 같음) ⓔ 같은 지점의 `active` 강의실과 이름이 같으면 409(다른 지점·보관한 강의실 이름은 허용, `uq_rooms_branch_name` 과 같은 기준). 지점 행 `FOR UPDATE` 뒤 검사해 동시 추가도 409 ⓕ 보관 200 = 보관한 강의실 한 줄(`status: "archived"`). 이미 보관했으면 바꾸지 않고 같은 본문 200. 남의 학원·없는·모양 틀린 강의실 id 404. 행은 지우지 않는다. 감사는 남기지 않는다(data-model §7-3 `rooms` 는 감사 대상이 아님) ⓖ 강의실을 가리키는 표(`class_sessions`·개인 레슨 슬롯)가 M2 에 생기므로 M1 에서는 보관이 늘 된다 — 검사는 S2-2 가 이 경로에 넣는다. 권한은 `owner` + 관리자 웹 2단계(운영자·위임 강사 403, 남의 학원 403) |
