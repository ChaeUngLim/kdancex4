# API 계약 — 입점 신청·심사·학원 정보·정산 계좌·파일·약관 동의 (S1-1(입점 신청·심사·학원 정보·정산 계좌))

공통 규칙은 `README.md`(직원 인증은 §6). 데이터는 `03_data-model.md` §7-3·§7-4. 관련 요구: FR-070(학원 정보 등록) · FR-085(등록 형태·증빙) · FR-087(증빙 없으면 엄격 기준) · FR-125b(카드 수수료 입점 동의) · FR-139(정산 계좌 변경 재확인) · FR-240(판매자 정보) · FR-249(동의 기록) · FR-250(입점 심사·게시 제한) · FR-251(입점 조건 동의) · FR-259(약관 변경 30일 전 개별 통지). 보드: W1a · W2a(입점 신청) · W2b(입점·설정) · W22(학원 앱 페이지·강의실) · O35(약관·동의 기록).

## 흐름

```
직원 계정 로그인 + 2단계 인증 → 파일 올리기 → 신청서 초안 저장 → 약관 판본 받기 → 제출
→ (운영자) 심사 시작 → 승인(학원·지점·계좌·대표 연결 생성) 또는 거절(사유)
→ (대표) 입점·설정 · 학원 앱 페이지 · 강의실 · 정산 계좌 변경 · 동의 기록 · 약관 변경 통지 읽기
```

신청자 권한 `staff_self` = 2단계 인증을 마친 `active` 직원 계정(역할 무관). 신청자의 계정 만들기는 강사 가입 경로(S2-1)를 같이 쓴다 — 휴대폰 본인확인 필수, 입점 신청 전에 2단계 인증(인증 앱) 등록(7-12 ① 확정, 사용자 2026-11-19).

## 1. 파일

| 메서드·경로 | 권한 | 요청 | 응답 |
|---|---|---|---|
| `POST /api/files` | `staff_self` | `multipart/form-data`: `purpose`(`merchant_evidence`·`academy_photo`), `file` | 201 `{ "fileId", "displayName", "mimeType", "sizeBytes", "visibility" }` |
| `GET /api/files/{fileId}` | 올린 사람 · 그 파일이 붙은 학원의 대표 · `admin` | — | 200 파일 바이트(`Content-Disposition: attachment`) · 공개 사진은 공개 경로로 따로 내린다 |

- 서버가 첫 바이트로 형식을 다시 확인한다(확장자·`Content-Type` 을 믿지 않는다). 사진은 긴 변 2,000px 로 줄여 저장(6-8 **추천값**)
- 오류: 422 `FILE_TYPE_NOT_ALLOWED`(JPEG·PNG·WebP·PDF 밖) · 422 `FILE_TOO_LARGE`(10MB 초과) · 403 `FORBIDDEN`(남의 비공개 파일, S1-1 수용 ⑥)
- 붙이지 않은 파일은 24시간 뒤 정리 작업이 지운다(6-7)

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
`platform_fee_notice` 판본 본문은 상품 분류별 요율(일반 5% · 개인 레슨 1%, 결정 12 — `platform_fee_rates`)과 입점 1년 면제(일반 수업·행사에만, 개인 레슨 1% 는 바로 적용 — 결정 13)를 적는다. W2a 의 「플랫폼 수수료 5%」 한 줄은 아직 개인 레슨 1% 를 모른다(다른 작업이 고친다). `required` 는 보드 W2a 기준이다(카드 수수료는 「동의하지 않으면 카드 결제가 닫혀요」). 개인정보 수집·이용 동의는 입점 동의가 아니라 대표 가입 때 받는다 — 열린 점 ② 확정(사용자 2026-11-19).

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
| `GET /api/academies/{academyId}/settings` | 학원 정보·지점·등록 형태(승인 시각·업종코드)·정산 계좌(가린 값)·입점 조건 요약·면제 종료일·대기 중인 약관 변경 |
| `PATCH /api/academies/{academyId}/profile` | 지점 주소·운영시간·연락처·시설·주차·접근성(FR-070). 판매자 정보(상호·대표자명·주소·전화·통신판매업 번호)를 바꾸면 감사 `academy.seller_info_changed`. 등록 형태는 이 경로로 못 바꾼다(422) — 열린 점 ③ |
| `PUT /api/academies/{academyId}/app-page` | `{ "tagline", "intro", "photoFileIds": ["…"] }` 최대 10장, 순서 = 배열 순서. 11장 이상 422 |
| `GET` · `POST /api/academies/{academyId}/rooms` | 강의실 목록 · 추가 `{ "branchId", "name": "A홀", "sizeSqm": 60, "baseCapacity": 24, "facilities": "마루 · 전신 거울 · 음향" }`. 이름 중복 409 `ROOM_NAME_TAKEN` |
| `POST /api/academies/{academyId}/rooms/{roomId}/archive` | 수업이 잡힌 강의실은 409 `ROOM_IN_USE`(W22 「지울 수 없어요」 — 회차가 생기는 M2 부터 실제로 걸린다) |

### 정산 계좌 변경 — `PUT /api/academies/{academyId}/payout-account` (FR-139)

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
| `GET /api/academies/{academyId}/consents` | `owner` | `{ items: [{ item, version, termsVersionId, agreedAt, current: true }], pendingChanges: [{ noticeId, item, version, effectiveAt, notifiedAt, readAt }] }` |
| `GET /api/terms/versions/{termsVersionId}` | 로그인 직원 | `{ kind, version, body, publishedAt, effectiveAt }` — 동의한 판본 전문 |
| `POST /api/academies/{academyId}/terms-notices/{noticeId}/read` | `owner` | 200. 이미 읽었으면 같은 본문 |
| `POST /api/admin/terms-versions` | `admin` | `{ kind, version, body, effectiveAt }` → 201. 같은 kind 의 이전 판본이 있으면 `effectiveAt ≥ 지금 + 30일` 이 아니면 422 `NOTICE_PERIOD_TOO_SHORT`(FR-259 — 불리 여부를 가리지 않고 모두). 같은 트랜잭션에서 `active` 학원 전부에 `terms_change_notices` + 알림 `terms_change_notice`(category `operations`) · 감사 `terms_version.published` |

재동의 흐름(적용일 뒤 동의하지 않은 학원 처리)은 S7-3(재동의) 몫이다.

## 수용 시나리오

1. **Given** 필수 항목 중 콘텐츠 이용 허락만 `agreed=false` **When** 제출 **Then** 422 `REQUIRED_CONSENT_MISSING`, 신청은 `draft` 그대로, 동의 행 0개
2. **Given** 미등록(자유업) 신청에 사업자등록증이 없다 **When** 제출 **Then** 422 `EVIDENCE_MISSING`. 사업자등록증을 붙이면 등록 형태별 증빙 없이 제출된다
3. **Given** `in_review` 신청 **When** 운영자가 같은 `Idempotency-Key` 로 승인을 두 번 보낸다 **Then** 학원·대표 연결·계좌가 1개씩만 생기고 두 응답의 `academyId` 가 같다
4. **Given** 승인 전 신청 **When** 신청자가 `GET /api/academies/{임의 id}/settings` **Then** 403(대표 연결이 없다) — 승인 전에는 학원 자체가 없다
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
| ③ | 입점 뒤 등록 형태 변경 | **확정**: 운영자 재심사(그동안 FR-087 엄격 기준). 별도 경로는 운영자 도구(S7-4)와 함께 |
| ④ | 예금주 확인 전 계좌의 지급 허용 | **확정(2026-11-19)**: 통장 사본 수동 확인 전에는 지급하지 않는다. 송금 반송은 FR-133a(정산 송금 반송)대로 지급 보류 |
