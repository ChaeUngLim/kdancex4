# API 계약 — M7 운영: 알림 발송·문의·신고·약관·탈퇴·권리·복구·자녀·운영자 콘솔 (S7-1 ~ S7-4)

- 작성 2026-11-20 · 공통 규칙은 `README.md`(경로 §1 · 세션 §2 · 값 형식 §4.6 · 오류 §4.8 · 멱등 §4.9 · 직원 인증 §6). 데이터는 `evidence/penpot-doc-sync-2026-11-20/datamodel_draft_M7.md`(`03_data-model.md` §12 로 붙인다). 형식 본보기: `07`~`10`
- 슬라이스: S7-1(알림 발송·알림 설정·푸시) · S7-2(문의·사람 이관·신고) · S7-3(약관·동의 판본·탈퇴·개인정보 권리·계정 복구·자녀) · S7-4(운영자 도구·플랫폼 결산 콘솔·점검·모니터링)
- 근거 FR: FR-140(수업 전 알림 시점) · FR-142(관심 대상 알림) · FR-144(알림 실패 재시도) · FR-146(광고성 알림 동의) · FR-176(사용자 문의) · FR-188(신고 처리) · FR-203(대표 선택 문의) · FR-203a(AI 이관 경로) · FR-204(운영자 역할 한정) · FR-205(환불 문의 안내) · FR-207(학원 문의 조회 제한) · FR-209(사람 응대 요청) · FR-209a(강사·대표 운영 문의) · FR-230~232(문의 창구·응대 기준·이력) · FR-254(이용 제한 절차) · FR-255(서비스 밖 거래 신고) · FR-243(약관 변경 공지) · FR-244(약관 판본 보관) · FR-245(결제 시점 정책 적용) · FR-249(약관 동의 기록) · FR-009a(보호자 계정 자녀 등록) · FR-190(데이터 삭제 요청) · FR-185(감사 기록) · FR-301~FR-319(플랫폼 정산 콘솔) · FR-316(수수료율 변경) · FR-022b(점검·강제 업데이트) · FR-198(운영자 수동 조치 감사)
- 결정 반영: **D5**(P1·P5 는 베타 보드대로, 멤버십 수입·비용·손익은 `available:false` 뼈대 — 멤버십 결제가 열리는 S6-1 뒤에 채운다) · **D10**(문의 종류 칩 「결석」) · **D4**(수수료율 학원별 예외 없음) · 자녀는 만 19세 미만(FR-009a) · 콘솔은 조회 전용(FR-301, 예외 4: 수수료율·P9 공휴일·P10 예금주 확인·P11 소명 처리)
- 참조만 하는 것: §7-7(`audit_logs`·직원 알림함 `GET /api/staff/notifications` 와 그 아래 경로, 10 §2) · 정산 원장·강사 계좌·공휴일 표는 **M5(`13-settlement.md`)·M0(S0-4.7)** 소유 — 이 파일은 콘솔이 읽는 조회(P1~P8)만 정하고, P9·P10·P11 의 쓰기 경로는 `13-settlement.md` §10 에 있다(2026-11-20 통합) · 회원 알림함 조회는 `04-me-calendar-notifications.md`
- **경로 이름**: 운영자 경로는 07 의 선례대로 `/api/admin/**`(권한 `requireStaff('admin', {surface:'web'})`) — 2단계 인증을 마친 세션만. 대표·강사 경로는 `/api/academies/{academyId}/**`·`/api/staff/**`. 회원·강사 앱 경로는 `/api/me/**`·`/api/inquiries`·`/api/reports`

## 0. 경로 한눈에

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/me/notification-settings` | 회원 알림 설정 조회 | 읽기 | FR-140·146 | C1A |
| `PUT /api/me/notification-settings` | 수업 전 시점·광고성·쿠폰·대기 알림 켜고 끄기 | 전체 교체(같은 값이면 변화 없음) | FR-140·146 | C1A |
| `POST /api/me/push-tokens` | 기기 푸시 토큰 등록·갱신 | 토큰 유니크 | FR-144 | C1A |
| `DELETE /api/me/push-tokens/{tokenId}` | 토큰 폐기(로그아웃·권한 끔) | 이미 폐기면 200 | FR-144 | C1A |
| `GET /api/staff/notification-settings` | 직원(대표·강사) 휴대폰 알림 설정 조회 | 읽기 | FR-080·146 | O34 |
| `PUT /api/staff/notification-settings` | 끌 수 있는 묶음만 켜고 끄기 | 전체 교체 | FR-080 | O34 |
| `POST /api/internal/jobs/notifications/dispatch` | 발송 대기 알림을 보낸다(밤 지연 판정 포함) | 알림 행 조건부 갱신 | FR-144·146 | — |
| `POST /api/internal/jobs/notifications/retry` | 실패한 발송 재시도, 끝까지 실패면 `failed` | 알림 행 조건부 갱신 | FR-144 | — |
| `POST /api/internal/jobs/notifications/pre-class` | 수업 전 알림 행 만들기 | `dedupe_key` | FR-140 | — |
| `POST /api/inquiries` | 문의 만들기(받는 곳 선택) | 헤더 `Idempotency-Key` | FR-176·203·209a | M22 · I16 |
| `GET /api/inquiries` | 내 문의 목록 | 읽기 | FR-232 | M22 · I16 |
| `GET /api/inquiries/{inquiryId}` | 문의 하나와 대화 | 읽기 | FR-232 | M22 · I16 |
| `POST /api/inquiries/{inquiryId}/messages` | 문의자의 추가 글 | `Idempotency-Key` | FR-176 | M22 |
| `POST /api/inquiries/{inquiryId}/human-request` | AI 답변 뒤 「사람에게 물어보기」 | 이미 사람이면 200 | FR-209·203a | M22 |
| `GET /api/academies/{academyId}/inquiries` | 대표 문의함 | 읽기 | FR-207 | O22 |
| `GET /api/academies/{academyId}/inquiries/{inquiryId}` | 대표가 문의 하나의 대화 전체를 읽는다(추천안·사후 확인 2026-11-24, S7-2.10) | 읽기 | FR-207 | O22 |
| `POST /api/academies/{academyId}/inquiries/{inquiryId}/replies` | 대표 답변 | `Idempotency-Key` | FR-203 | O22 |
| `GET /api/admin/inquiries` | 운영자 시스템 문의함 | 읽기 | FR-204 | O22 하단 · I16 |
| `POST /api/admin/inquiries/{inquiryId}/replies` | 운영자 답변 | `Idempotency-Key` | FR-204 | — |
| `POST /api/internal/jobs/inquiries/remind-overdue` | 1영업일 넘은 문의 재알림 | `overdue_reminded_at` 조건부 | FR-231 | O22 |
| `POST /api/reports` | 신고 접수 | 헤더 `Idempotency-Key` | FR-188·255 | C11A |
| `GET /api/reports` | 내 신고와 진행 단계 | 읽기 | FR-188 | C11A |
| `GET /api/admin/reports` | 운영자 신고함 | 읽기 | FR-188 | (보드 없음) |
| `POST /api/admin/reports/{reportId}/start-review` | 접수 → 확인 중 | 이미 확인 중이면 200 | FR-188 | C11A 진행 단계 |
| `POST /api/admin/reports/{reportId}/resolve` | 처리 결과 기록·신고자 알림 | 이미 처리면 200 | FR-188·254 | C11A 결과 알림 |
| `POST /api/admin/restrictions` | 이용 제한 절차 시작(사유 통지) | `Idempotency-Key` | FR-254 | P11 |
| `GET /api/admin/restrictions` | 절차 목록 | 읽기 | FR-254 | P11 |
| `POST /api/admin/restrictions/{caseId}/apply` | 소명 뒤 조치 확정 | 조건부 갱신 | FR-254 | P11 |
| `POST /api/admin/restrictions/{caseId}/lift` | 조치 해제·절차 종료 | 이미 해제면 200 | FR-254 | P11 |
| `GET /api/me/restrictions` | 내게 걸린 절차(회원·강사·대표 공통) | 읽기 | FR-254 | — |
| `POST /api/restrictions/{caseId}/explanations` | 소명 내기 | 한 건당 `Idempotency-Key` | FR-254 | P11 소명 |
| `GET /api/me/terms` | 내가 동의한 판본·적용 중인 판본 | 읽기 | FR-244·249 | C10B |
| `GET /api/me/terms/{termsVersionId}` | 판본 전문 | 읽기 | FR-244 | C10B |
| `GET /api/me/terms/pending` | 다시 동의할 판본(불리한 변경) | 읽기 | FR-243 | C10A |
| `GET /api/academies/{academyId}/termination/preview` | 입점 해지 전 확인(남은 수업·정산금) | 읽기 | FR-256 | W26 |
| `POST /api/academies/{academyId}/termination` | 입점 해지 신청 | 헤더 `Idempotency-Key` | FR-256 | W26 |
| `POST /api/internal/jobs/academy-terminations/complete` | 해지 완료 처리(마지막 수업·정산 뒤) | 학원 행 조건부 갱신 | FR-256 | — |
| `POST /api/me/terms/consents` | 판본 동의(재동의) | 판본 단위 유니크 | FR-243·249 | C10A |
| `PUT /api/me/optional-consents` | 선택 동의(광고성·위치) 켜고 끄기 | 같은 값이면 기록 안 함 | FR-146·249 | C10B · C14A |
| `POST /api/admin/member-terms-versions` | 회원 약관 판본 발행 | `kind+version` 유니크 | FR-243·244 | (보드 없음) |
| `POST /api/internal/jobs/terms/notify` | 적용일 전 개별 통지 행 만들기 | `dedupe_key` | FR-243 | C10A |
| `GET /api/me/withdrawal/preview` | 탈퇴 전 확인 목록·막힘 여부 | 읽기 | FR-190 | C11B |
| `POST /api/me/withdrawal` | 탈퇴 요청 | 헤더 `Idempotency-Key` | FR-190 | C11B |
| `GET /api/staff/withdrawal/preview` | 강사 탈퇴 전 확인 | 읽기 | I-03 | I30 |
| `POST /api/staff/withdrawal` | 강사 탈퇴 요청 | `Idempotency-Key` | I-03 | I30 |
| `POST /api/internal/jobs/withdrawals/complete` | 환불이 끝난 탈퇴를 마무리 | 조건부 갱신 | FR-190 | C11B |
| `POST /api/internal/jobs/retention/purge` | 보존 기한 지난 기록 삭제 | `purged_at` 조건부 | FR-190·O-16 | — |
| `GET /api/me/profile-data` | 내가 낸 정보·학원에 준 내역 | 읽기 | FR-190 | C21A |
| `POST /api/me/contact-change` | 연락처 바꾸기(다시 본인확인) | 본인확인 토큰 1회용 | FR-190 | C21A |
| `POST /api/me/data-requests` | 처리정지·삭제 요청 | `Idempotency-Key` | FR-190 | C21A |
| `GET /api/me/data-requests` | 내 요청과 결과 | 읽기 | FR-190 | C21A |
| `GET /api/admin/data-requests` | 운영자 요청함 | 읽기 | FR-190 | (보드 없음) |
| `POST /api/admin/data-requests/{requestId}/resolve` | 요청 처리 결과 | 이미 처리면 200 | FR-190 | — |
| `POST /api/account-recovery` | 계정 복구(같은 CI 로 새 소셜 연결) | 한 번 성공하면 200 같은 본문 | FR-003 보완 | (보드 없음) |
| `GET /api/me/children` | 내 자녀 목록 | 읽기 | FR-009a | C6A · C6B |
| `POST /api/me/children` | 자녀 등록 | 헤더 `Idempotency-Key` | FR-009a | C6A |
| `DELETE /api/me/children/{childId}` | 자녀 정보 지우기 | 이미 지웠으면 200 | FR-009a | C6A |
| `POST /api/internal/jobs/children/age-check` | 만 19세 도달 자녀 표시·보호자 알림 | `adult_flagged_at` 조건부 | FR-009a·Q29 | — |
| `GET /api/system/status` | 앱이 켜질 때 점검·버전 판정 | 읽기 | FR-022b | C20A · C20B · C32D |
| `GET /api/admin/maintenance-windows` | 점검·결제 중단 목록 | 읽기 | FR-022b | (보드 없음) |
| `POST /api/admin/maintenance-windows` | 점검 예약·결제 중단 시작 | `Idempotency-Key` | FR-022b | C20A · C33A |
| `POST /api/admin/maintenance-windows/{windowId}/end` | 끝내기(입금 기한 늘림 적용) | 이미 끝났으면 200 | FR-022b | C33A · O36B |
| `GET /api/admin/app-version-policies` | 앱 버전 정책 | 읽기 | FR-022b | C20B |
| `POST /api/admin/app-version-policies` | 최소·최신 버전 바꾸기 | 플랫폼+효력 시각 유니크 | FR-022b | C20B · C32D |
| `GET /api/admin/audit-logs` | 감사 기록 조회(수정·삭제 경로 없음) | 읽기 | FR-185·198 | (보드 없음) |
| `GET /api/admin/console/dashboard` | P1 지표 카드·추이·원장 대조 | 읽기 | FR-304·305·318 | P1 |
| ~~`GET /api/admin/console/genres`~~ | ~~P2 장르별 결산~~ — 삭제(2026-11-24, FR-306(장르별 결산) 삭제) | — | FR-306 | — |
| `GET /api/admin/console/academies` | P3 학원 목록(정렬) | 읽기 | FR-307 | P3 |
| `GET /api/admin/console/academies/{academyId}` | P3 학원 상세 | 읽기 | FR-307 | P3 |
| `GET /api/admin/console/breakdowns` | P4 상품 유형·결제수단·지역 | 읽기 | FR-308·309 | P4 |
| `GET /api/admin/console/ledger-summary` | P5 전체 결산표·합계 검산·월 마감 | 읽기 | FR-310·318·319 | P5 |
| `GET /api/admin/console/payouts` | P6 지급 현황 | 읽기 | FR-311 | P6 |
| `GET /api/admin/console/fee-evidence` | P7 수수료 근거 | 읽기 | FR-312·313·315 | P7 |
| `GET /api/admin/console/fee-rates` | P8 현재 수수료율·바꾼 기록 | 읽기 | FR-314·316 | P8 |
| `POST /api/admin/console/fee-rates/simulate` | P8 모의 계산(저장 안 함) | 읽기 성격 | FR-314 | P8 |
| `POST /api/admin/console/fee-rates` | P8 새 수수료율 저장 | 헤더 `Idempotency-Key` | FR-316 | P8 |
| `GET /api/admin/console/exports/{screen}` | 결산 화면 엑셀(xlsx) 내보내기(2026-11-24 변경 — 이전: CSV) | 읽기 | FR-317 | P1~P7 |
| P9 공휴일 · P10 예금주 확인 · P11 사업자 점검(운영자 쓰기 4예외 중 셋) | **`13-settlement.md` §10 으로 옮김**(2026-11-20 통합 — 정산 영역) | — | FR-301 예외 ②③④ | P9 · P10 · P11 |
| `POST /api/internal/jobs/ops-alerts/scan` | 운영자 경보 3종 감지 | `dedupe_key` | S7-4 수용 ⑦ | — |

(경로 총 77개: 내부 작업 10 · 운영자 `/api/admin/**` 30 · 나머지는 회원·강사·대표 앱 경로. P9~P11 의 운영자 경로 11개는 2026-11-20 통합 때 `13-settlement.md` §10 으로 옮겼다. 아래 절마다 요청·응답·오류.)

### 0-1. 이 파일이 다른 계약에 더하는 오류와 필드

| 어디 | 더하는 것 | 왜 |
|---|---|---|
| `POST /api/orders`(03) | 409 `TERMS_RECONSENT_REQUIRED`(본문에 `pendingTermsVersionIds`) | S7-3 수용 ① — 불리한 약관 적용일 뒤 재동의 전 결제 시작 거부(FR-243) |
| `POST /api/orders`(03) | 503 `MAINTENANCE_ACTIVE`(본문에 `window`) | S7-4 수용 ④ — 점검·결제 중단 중 결제 시작 거부(FR-022b) |
| 모든 `/api/**`(`/api/health`·`/api/system/status` 제외) | 헤더 `X-App-Platform`·`X-App-Version` 이 있고 최소 버전 미만이면 426 `APP_UPDATE_REQUIRED` | S7-4 수용 ⑤. 헤더가 없으면(웹) 판정하지 않는다 |
| 주문 생성(03)·주문 요청 본문 | `attendeeChildId`(NULL 이면 본인) | C6B — 자녀 수강. M3 와 조율(열린 점 ⑧) |
| `POST /api/files`(07) | `purpose` 값 `inquiry_attachment`·`report_attachment`·`restriction_explanation` 추가 | S7-2.7·FR-254 소명 첨부. 통장 사본은 07 의 정산 계좌 경로가 이미 쓴다. 회원 세션도 이 경로에 들어오고 회원은 이 셋만 올린다(그 밖 403). 직원의 첨부는 2단계를 묻지 않는다. 언제나 `private`. `uploaded_files.uploader_member_id` 를 더했다(추천안·사후 확인 2026-11-24, S7-2.7) |
| `GET /api/files/{fileId}`(07) | 첨부 목적 파일은 「붙은 자리」 규칙 하나로 판정 | 문의 첨부 = 문의자·받는 쪽(학원 문의는 그 학원 대표, 시스템 문의는 운영자 — 운영자도 학원 문의 첨부는 403, FR-204) · 신고 첨부 = 신고자·운영자(신고받은 상대 403) · 안 붙은 첨부 = 올린 사람만. 회원 세션도 들어오고 회원은 첨부만 연다. 대표 앱(Bearer)은 첨부에 2단계를 묻지 않는다(추천안·사후 확인 2026-11-24, S7-2.7) |

### 0-2. 알림 종류 세 분류(6-5 — 거래 · 서비스 · 광고성)

알림 행의 새 칸 `class`(데이터 §12-2)가 이 값을 가진다. 만드는 쪽이 정하고, 발송기는 `class` 만 보고 판정한다.

| class | 끌 수 있나 | 밤(21:00~08:00 KST) | 해당 `kind` 예 |
|---|---|---|---|
| `transactional`(거래) | 못 끈다 | 그대로 보냄 | 결제·환불·예약 변경·휴강·약관 변경·환불 요청·문의 답변·신고 접수·결과·점검 공지·소명 기한 |
| `service`(서비스) | 켜고 끈다 | 그대로 보냄 | 수업 전 알림(`pre_class_reminder`)·대기 자리·쿠폰 소멸 7일 전(FR-123a) |
| `marketing`(광고성) | 동의해야 받는다 | **08:00 뒤로 미룸**(`deliver_after`) | 관심 강사 새 수업·쿠폰 홍보·이벤트·구독 학원 소식(FR-142) |

대표·강사 앱에는 광고성 알림이 없다(O34 「대표 앱에는 광고성 알림이 없어요」). 알림함 행은 설정과 상관없이 항상 쓴다(10 §2 와 같은 원칙).

---

## 1. 알림 발송·설정 (S7-1)

### 1-1. 회원 알림 설정 — 보드 C1A

`GET /api/me/notification-settings` 200
```json
{ "preClassLead": "one_hour",
  "marketing": { "agreed": true, "agreedAt": "2026-10-15T01:20:00Z", "quietHours": { "from": "21:00", "to": "08:00" } },
  "couponExpiryNotice": true,
  "waitlistNotice": true,
  "transactional": { "alwaysOn": true },
  "pushPermission": "denied" }
```
- `preClassLead`: `day_before`·`two_hours`·`one_hour`·`thirty_min`. 칩 4개 가운데 **하나**(보드 문구 「예약한 수업이 시작하기 전에 한 번 알려요」)가 기본이며 기본값은 `one_hour`(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 열린 점 ①)
- `pushPermission`: 이 회원의 가장 최근 토큰의 `permission_state`(`granted`·`denied`·`unknown`). `denied` 면 화면이 「휴대폰 알림이 꺼져 있어요」 띠를 띄운다(수용 ②)
- 학원별 소리·무음·끔(C22A)은 학원 구독 경로가 소유한다(M3 FR-023a). 발송기는 그 값을 읽기만 한다(열린 점 ⑨)

`PUT /api/me/notification-settings`
```json
{ "preClassLead": "two_hours", "marketingAgreed": false, "couponExpiryNotice": true, "waitlistNotice": true }
```
- 200 은 위 `GET` 과 같은 본문. `marketingAgreed` 가 바뀌면 `member_consents`(S3-1 정의, 항목 `marketing`)에 동의·철회 시각을 새 줄로 쓴다(FR-249). **광고성을 끄면 쿠폰·학원 소식 알림도 함께 멈춘다**(C1A 하단 문구 — 발송기가 `class=marketing` 전체를 거른다. `couponExpiryNotice` 는 `class=service` 로 두고 광고성이 꺼져도 유지할지는 열린 점 ②)
- 본문에 `transactional` 을 `false` 로 보내면 422 `TRANSACTIONAL_NOT_DISABLEABLE` — 거래 알림은 값 자체가 없다(S7-1 수용 ①)
- S7-1.4 구현 세부(추천안·사후 확인 2026-11-24): `transactional` 은 `false` 와 GET 모양 `{ "alwaysOn": false }` 둘 다 끄기 시도로 보고 422 를 내며, 이때 다른 칸도 저장하지 않는다. `true`·`{alwaysOn:true}` 는 통과(뜻 없음). 동의 중이 아니면 `marketing.agreedAt` 은 `null`. 토큰이 없으면 `pushPermission` 은 `unknown`. 다시 켠 광고성 동의 줄은 `source='settings'`·판본 없음. `couponExpiryNotice` 는 광고성과 따로 저장한다(열린 점 ② 는 발송기 몫)

| HTTP | code | 언제 |
|---|---|---|
| 422 | `TRANSACTIONAL_NOT_DISABLEABLE` | 거래 알림을 끄려 함 |
| 422 | `VALIDATION_FAILED` | `preClassLead` 가 네 값 밖 |

### 1-2. 푸시 토큰

`POST /api/me/push-tokens` (회원) · 직원은 같은 경로를 쓰되 세션이 직원이면 `staff_account_id` 로 묶인다
```json
{ "token": "fcm-token-…", "platform": "android", "deviceId": "dev-3f2a", "permission": "granted" }
```
→ 201 `{ "tokenId": "…", "permission": "granted" }`. 같은 `token` 이 다시 오면 200 으로 `last_seen_at`·`permission` 만 갱신한다(다른 계정으로 로그인한 같은 기기면 토큰을 새 계정에 옮기고 옛 연결은 `revoked_at`). `permission: "denied"` 도 등록한다 — 이 기기에는 보내지 않고 알림함에만 쌓이게 하려는 기록이다(수용 ②).
`DELETE /api/me/push-tokens/{tokenId}` → 200 `{ "revokedAt" }`. 남의 토큰이면 404.

| HTTP | code | 언제 |
|---|---|---|
| 422 | `VALIDATION_FAILED` | `platform` 이 `android` 아님(베타는 Android 만, CLAUDE.md) |

- S7-1.1 구현 세부(추천안·사후 확인 2026-11-24): 주인은 세션 사용자에게 회원 행이 있으면 회원, 없고 active 직원 계정이 있으면 직원이다. 둘 다 없으면 403 `SIGNUP_INCOMPLETE`, 정지 직원은 403 `ACCOUNT_SUSPENDED`. 같은 주인·같은 `deviceId` 에 다른 토큰이 오면(FCM 토큰 갱신) 옛 토큰 줄을 `revoked_at` 으로 닫는다. 응답에는 토큰 값을 싣지 않는다. `DELETE` 를 다시 부르면 처음 닫은 시각으로 200. 발송기가 `DeviceNotRegistered` 를 받은 토큰은 서버가 닫는다(`revokeInvalidPushTokens`). 구현: `admin-web/lib/server/services/push-tokens.ts`

### 1-3. 직원 휴대폰 알림 설정 — 보드 O34

`GET /api/staff/notification-settings` 200
```json
{ "items": [
  { "topic": "class_approval",   "label": "수업 승인 요청", "lockable": true,  "phoneEnabled": true },
  { "topic": "event_capacity",   "label": "행사 신청 · 정원", "lockable": true, "phoneEnabled": true },
  { "topic": "inquiry",          "label": "문의", "lockable": true, "phoneEnabled": true },
  { "topic": "schedule_room",    "label": "강사 일정 · 강의실", "lockable": true, "phoneEnabled": false },
  { "topic": "platform_notice",  "label": "플랫폼 운영 공지", "lockable": true, "phoneEnabled": true },
  { "topic": "refund_request",   "label": "환불 요청 · 답할 기한", "lockable": false, "phoneEnabled": true },
  { "topic": "payment_failure",  "label": "결제 실패 · 다른 금액 입금", "lockable": false, "phoneEnabled": true },
  { "topic": "payout_approval",  "label": "강사 지급 승인 · 카드 이의제기", "lockable": false, "phoneEnabled": true } ] }
```
`PUT /api/staff/notification-settings` `{ "items": [ { "topic": "inquiry", "phoneEnabled": false } ] }` → 200 같은 모양. `lockable:false` 인 주제를 끄면 422 `TRANSACTIONAL_NOT_DISABLEABLE`(O34 「회원·강사가 손해 보는 알림이라 끌 수 없어요」). 끄는 것은 **휴대폰 푸시만**이고 알림함 행은 계속 쓴다(O34 「꺼도 알림함에는 남아요」). 강사에게 가는 정규 신청·취소 알림은 푸시 대상이 아니라 알림함과 홈 표에만 둔다(I-08, 만드는 쪽이 `push_suppressed_reason='instructor_regular_signup'` 로 쓴다).

### 1-4. 발송·재시도·수업 전 알림 — 내부 작업 (README §1 의 `X-Internal-Token`)

공통: 모두 멱등이고 실행기(S0-4)가 부른다. 응답은 처리 건수만 낸다.

`POST /api/internal/jobs/notifications/dispatch` `{ "limit": 200 }` → 200 `{ "sent": 118, "deferred": 6, "skipped": 21, "failed": 0 }`
- 대상: `delivery_status='pending'` 이고 `deliver_after <= now()` 인 행. 한 문장으로 `UPDATE … SET delivery_status='sending', attempt_count=attempt_count+1 WHERE id=ANY($1) AND delivery_status='pending'` 로 선점해 같은 작업이 겹쳐 돌아도 한 번만 보낸다
- 판정 순서: ① 받는 사람 푸시 토큰이 `granted` 가 아니면 `skipped`(`push_suppressed_reason='no_permission'`) — 알림함 행은 이미 있다 ② `class=marketing` 이고 동의가 없거나 꺼졌으면 `skipped`(`not_agreed`) ③ `class=marketing` 이고 지금이 21:00~08:00 KST 면 `deliver_after` 를 같은 날·다음 날 08:00 으로 밀고 `pending` 으로 둔다(`deferred`, 수용 ③) ④ 보낸다 → `NotificationSenderPort.deliver`(06) 성공이면 `sent`·`delivered_at`
- 시각 판정은 순수 함수 `isQuietHour(instant)`(KST, 경계: 20:59 가 아님·21:00 이 야간·07:59 가 야간·08:00 이 아님 — S7-1.3 경계)
- S7-1.5 구현 세부(추천안·사후 확인 2026-11-24): `NotificationSenderPort` 실구현은 `admin-web/lib/server/adapters/push-notification-sender.ts`(`PushNotificationSender`). 커밋 뒤 `deliver(ids)` 가 `pending` 행만 읽고, 받는 사람의 살아 있는 `granted` 토큰이 없으면 발송 시도 없이 `skipped`(수용 ②), 있으면 `pending→sent` 조건부 갱신으로 선점한 뒤 Expo 형식으로 보낸다. 한 기기라도 ok 면 `sent`, 모든 토큰이 `DeviceNotRegistered` 면 토큰을 닫고 `skipped`, 보내지 못하면 `pending` 으로 되돌린다(`retry_wait`·`failed` 는 S7-1.6) — S7-1.6 에서 `pending→sending` 선점과 실패 시 `retry_wait` 로 바뀌었다(아래 retry 줄). 광고성 행은 이 경로에서 보내지 않고 `pending` 으로 남긴다(②③ 판정은 dispatch). `push_suppressed_reason`·`delivered_at` 칸(§12-2)은 아직 없어 이번에 쓰지 않았다 — 칸을 더하는 Task 가 채운다. 발송기 선택은 설정 `PUSH_DELIVERY`(`expo`·`fake`, 비우면 개발 fake · 베타·운영 expo)

`POST /api/internal/jobs/notifications/retry` → 200 `{ "retried": 4, "failed": 1 }`
- 대상: 발송 시도가 실패해 `delivery_status='retry_wait'` 이고 `next_attempt_at <= now()` 인 행. 시도는 최대 3번(처음 포함)이고 사이 간격은 1분·5분(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 열린 점 ③). 마지막까지 실패하면 `failed` + `delivery_error_code` 를 남긴다(수용 ④). 알림함에는 계속 보인다(FR-144 「미확인 알림을 앱에서 확인」)
- S7-1.6 구현 세부(추천안·사후 확인 2026-11-24): 경로 `app/api/internal/jobs/notifications/retry/route.ts` → `deps.notificationRetry.retryDue(limit)`(포트 `lib/server/ports/notification-retry.ts`, 실구현은 S7-1.5 의 `PushNotificationSender` 가 함께 맡는다 — 선점·정리 규칙을 한 곳에). 본문은 선택 `{ "limit": 1~1000 }`(기본 200, 모르는 칸 422), 응답은 위 두 칸뿐. 처음 보내기(`deliver`)도 이제 `pending→sending`(attempt_count+1) 으로 선점하고, 실패하면 `pending` 으로 되돌리지 않고 `retry_wait` 로 둔다. 판정은 순수 함수 `decideAfterFailure`(`lib/domain/notification-retry.ts`). 횟수·간격은 `ops_settings` 표가 아직 없어 그 파일의 상수(`MAX_DELIVERY_ATTEMPTS=3`·`RETRY_DELAYS=[1분,5분]`)로 둔다. 선점한 채 10분 넘게 `sending` 인 행(발송 중 서버 멈춤)은 retry 작업이 실패 1번(`delivery_error_code='sending_timeout'`)으로 센다. 성공하면 `delivered_at` 을 쓰고 오류 코드는 지운다. 기다리는 사이 받을 기기가 없어지면 시도 없이 `skipped`. 마이그레이션 `20261124T0627_notification_delivery_retry` 가 §12-2 의 칸 중 `attempt_count`·`next_attempt_at`·`last_attempt_at`·`delivery_error_code`·`delivered_at`·`ck_notifications_attempts`·`ix_notifications_retry` 와 상태 6값만 더했다(`class`·`deliver_after`·`push_suppressed_reason`·`ix_notifications_dispatch` 는 dispatch Task 몫)

`POST /api/internal/jobs/notifications/pre-class` → 200 `{ "created": 37 }`
- 앞으로 2시간 안에 시작하는 회차(가장 이른 `day_before` 도 포함해 24시간 앞까지 훑는다)의 `confirmed` 예약마다 그 회원의 `preClassLead` 시점이 지났으면 알림 행 1개를 만든다. `kind='pre_class_reminder'`, `class='service'`, `dedupe_key = 'preclass:<sessionId>:<memberId>:<lead>'` — 작업이 다시 돌아도 1건(`uq_notifications_dedupe`). 자녀 예약은 보호자 계정이 받는다(C6A·C6B 「알림은 보호자 계정으로」)
- S7-1.7 구현 세부(추천안·사후 확인 2026-11-24): 경로 `app/api/internal/jobs/notifications/pre-class/route.ts` → `runPreClassReminders`(`lib/server/services/pre-class-reminders.ts`), 시점 표는 `lib/domain/pre-class-reminder.ts`(하루 전 1440분·2시간 120·1시간 60·30분 30, 설정 행이 없으면 1시간 전). 본문은 선택 `{ "asOf": "…Z" }`(`KDANCE_DEV_ROUTES=true` 일 때만, 모르는 칸 422). 대상은 `scheduled` 회차 · 예약 `confirmed` · 주문 `paid`·`partially_refunded` 이고 「시작 − 시점 ≤ 지금 < 시작」인 줄, 그 회차에 살아 있는 결석 표시(`attendance_marks.cancelled_at IS NULL`)가 있으면 뺀다. 알릴 시각이 지난 뒤 예약한 회원도 수업 전이면 한 번 받는다. 행은 `reservation_id` 만 채우고 `order_id` 는 비운다(여러 회차 수업이 `uq_notifications_kind_order_recipient` 에 막히지 않게). payload `{ title:'곧 수업이 시작해요', body:'<수업> · M월 D일 HH:MM 시작'(KST), classTitle, sessionId, startsAt, lead }`. 새로 만든 행은 커밋 뒤 `NotificationSenderPort.deliver` 로 바로 넘긴다(service 라 밤 지연 없음, 실패해도 행은 남고 재시도 작업 몫). 마이그레이션 `20261124T0702_pre_class_reminder_notification` 은 kind CHECK 에 `pre_class_reminder` 하나만 더했다(`class` 칸은 dispatch Task 몫이라 분류는 `notification-kinds.ts` 표의 service). 자녀→보호자 받는 사람 바꾸기는 자녀 표가 생기는 S7-3 몫

관심 대상 알림(FR-142)·쿠폰 소멸·대기·소식은 각 슬라이스가 알림 행을 쓰고(`class` 를 정해서) 이 발송기가 보낸다. 학원 소식은 **구독한 학원만**, 그리고 `class=marketing`.

### 1-5. 알림 수용 시나리오

1. **Given** 회원이 거래 알림을 끄려 한다 **When** `PUT …` 에 `transactional:false` **Then** 422 `TRANSACTIONAL_NOT_DISABLEABLE`
2. **Given** 푸시 권한을 거절한 기기 **When** 결제 확인 알림이 생긴다 **Then** 알림함에는 행이 있고 `delivery_status='skipped'`, `push_suppressed_reason='no_permission'`
3. **Given** 광고성 알림이 21:30 에 예약됐다 **When** `dispatch` 가 돈다 **Then** `deliver_after` 가 다음 날 08:00 이고 아직 `pending`, 08:00 뒤 작업이 `sent`
4. **Given** 발송이 세 번 연속 실패 **When** `retry` 가 마지막으로 돈다 **Then** `failed`, 알림함 행은 그대로
5. **Given** 같은 회차의 `pre-class` 작업이 두 번 돈다 **When** 알림을 센다 **Then** 회원당 1건

---

## 2. 문의·사람 이관·신고 (S7-2)

### 2-1. 문의 받는 곳 규칙 — FR-203 · FR-204 · FR-209a

| 묻는 사람 | 받는 곳(`kind`) | 종류(`category`, 보드 칩) | 비고 |
|---|---|---|---|
| 회원 | 학원 대표(`academy`) — 학원·수업을 검색하거나 내 예약에서 고른다(M22) | `class`(수업 문의) · `refund`(환불 요청) · `schedule`(일정 변경) · `other`(기타) | 환불·결제 분쟁·개인정보 문의는 AI 를 거치지 않고 바로 대표에게(FR-201). 환불이면 환불 요청과 잇는다 |
| 회원 | 운영자(`system`) — 「앱 이용」(M22) | `account` · `app_error` · `payment_outage` · `membership`(FR-204 예외 — 멤버십은 플랫폼 상품) · `other` | |
| 강사 | 소속 학원 대표(`academy`, I16) | `settlement_basis`(정산 금액 근거) · `capacity`(정원) · **`absence`(결석)** · `other` | **D10**: 칩 이름을 「결석」으로 통일(FR-209a 를 고침). 보드 I16 칩 줄은 「정산 금액 근거 · 정원 · 결석 · 기타」로 맞춘다 |
| 강사 | 운영자(`system`, 「앱 이용」) | `account` · `app_error` · `other` | |
| 대표 | 운영자(`system`) | `account` · `app_error` · `payment_outage` · `other` | 대표의 시스템 문의(FR-209a). 대표 앱 O22 하단 「운영자에게 문의 ›」 |

운영자는 `kind='system'` 만 본다. 학원 문의의 2차 조정자가 되지 않는다(FR-204, SC-029b).

### 2-2. 문의 만들기·조회

`POST /api/inquiries` · 헤더 `Idempotency-Key`(필수, 8~200자) — 회원 세션 또는 직원 세션
```json
{ "kind": "academy", "academyId": "…", "category": "refund",
  "reservationId": "…", "offeringId": null,
  "body": "개인 사정으로 2회차부터 못 나가요. 환불 가능할까요?",
  "relatedSettlementRef": null, "attachmentFileIds": [] }
```
→ 201
```json
{ "inquiryId": "…", "kind": "academy", "category": "refund", "status": "answer_waiting",
  "firstResponseDueAt": "2026-11-23T14:59:59Z", "refundRequestId": null,
  "waitingNotice": "1영업일 안에 답해요", "createdAt": "…Z" }
```
- `kind=academy` 면 `academyId` 필수. 받는 대표는 서버가 `academy_owners(active)` 로 찾아 직원 알림 `inquiry_received`(category `inquiry`, `class=transactional`, `dedupe_key=inquiry:<id>:received`)를 쓴다. 환불 문의(`refund`)면 알림 payload 에 `actionLabel:"환불 처리 ›"` 를 붙인다(O22 「답하기 › 환불 처리 ›」)
- 회원이 `reservationId` 를 고르면 그 예약이 이 회원 것이고 `academyId` 와 맞는지 서버가 확인한다. 직원은 `reservationId` 를 못 쓴다
- 강사는 `academyId` 가 자기 `active` 소속이어야 한다. `relatedSettlementRef` 는 I16 의 「관련 정산 · 선택」(월·수업·환불 N건 같은 정산 줄)이고 M5 의 정산 줄 id 다(열린 점 ⑥)
- `firstResponseDueAt` = 접수 시각에서 **1영업일**(Q21). 영업일은 토·일과 공휴일 표(P9)를 뺀다 — M5 의 영업일 함수를 쓴다(열린 점 ⑦). 응대 시간 밖에 접수돼도 같은 규칙으로 「언제 답하는지」를 `waitingNotice` 로 알린다(FR-231)
- 환불 요청과 잇기(S7-2.4): `category=refund` 이고 같은 예약에 S4-1 환불 요청이 있으면 `refundRequestId` 를 채운다. 환불 요청이 문의보다 나중에 생기면 S4-1 서비스가 `linkInquiryToRefundRequest(inquiryId, refundRequestId)` 를 불러 채운다 — 경로는 만들지 않는다(서비스 호출). 두 상태 값이 어긋나지 않게 대표 알림함의 「환불 요청」 칩은 환불 요청 상태를 본다(M-06)
- 첨부는 `POST /api/files` 로 먼저 올린 `fileId`(`purpose=inquiry_attachment`). 당사자와 받는 쪽만 연다(07 `GET /api/files/{fileId}` 판정에 「문의 첨부」 규칙을 더한다). 붙이기 검사: 남이 올린 파일 403 `FORBIDDEN` · 목적이 다르거나 이미 다른 곳에 붙었거나 같은 파일을 두 번 적었거나 없는 파일이면 422 `VALIDATION_FAILED`(`fields[].path = attachmentFileIds.N`). 하나라도 틀리면 문의·글도 만들지 않는다. 첫 글에 `attachment_links(owner_kind='inquiry_message')` 로 잇고 `uploaded_files.attached_at` 을 채운다(추천안·사후 확인 2026-11-24, S7-2.7)

| HTTP | code | 언제 |
|---|---|---|
| 400 | `BAD_REQUEST` | `Idempotency-Key` 없음 |
| 403 | `FORBIDDEN` | 남의 예약·소속 아닌 학원으로 문의 |
| 404 | `NOT_FOUND` | 없는 학원·예약 |
| 409 | `AFFILIATION_REQUIRED` | 강사가 소속 `active` 가 아닌 학원에 문의 |
| 422 | `VALIDATION_FAILED` | 종류가 받는 곳·역할에 안 맞음(예: 회원이 `absence`) · 본문 비었음·2,000자 초과(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) |

`GET /api/inquiries?status=&cursor=&limit=20` → `{ "items": [ { "inquiryId", "kind", "academy": { "academyId", "name" } | null, "category", "status", "lastMessagePreview", "lastMessageAt", "waiting": true } ], "nextCursor" }` — 내 문의만, 최신순(FR-232 이력 보관). `waiting` 은 `status='answer_waiting'` 이고 기한을 넘겼을 때 화면이 「답변 대기 중」을 보이는 표시다(수용 ②).

`GET /api/inquiries/{inquiryId}` → 200
```json
{ "inquiryId": "…", "kind": "academy", "category": "refund", "status": "answered",
  "academy": { "academyId": "…", "name": "라틴하우스 강남" }, "refundRequestId": "…",
  "messages": [ { "messageId": "…", "sender": "asker", "body": "…", "createdAt": "…Z", "attachments": [ { "fileId": "…", "displayName": "영수증.jpg" } ] },
                { "messageId": "…", "sender": "academy_owner", "body": "학원 규정상 …", "createdAt": "…Z", "attachments": [] } ] }
```
문의자만 열 수 있다(남의 문의 403). 응답에 `firstResponseDueAt`·`waiting` 도 싣는다 — 목록과 같은 뜻(추천안·사후 확인 2026-11-24, S7-2.2). 대화는 추가 전용이라 고치거나 지우는 경로가 없다(FR-232, 소비자 불만 기록 3년 보존 — 데이터 §12).

`POST /api/inquiries/{inquiryId}/messages` `{ "body": "추가로 …", "attachmentFileIds": [] }` · `Idempotency-Key` → 201 `{ "messageId" }`. `closed` 면 409 `INQUIRY_CLOSED`. 답이 온 뒤 문의자가 글을 더하면 `status` 가 다시 `answer_waiting` 이 되고 `firstResponseDueAt` 도 새로 센다.

### 2-3. AI 이관 — FR-209 · FR-203a (AI 는 MX 트랙, 여기는 받는 쪽만)

AI 없이도 문의가 닿는다(FR-230, T0·T3). AI 서버가 생기면 `POST /api/inquiries` 가 `route:"ai_first"` 를 받을 수 있게 하는 자리를 이 절이 비워 둔다 — 지금(M7)은 모든 문의가 `route='human'` 으로 만들어진다.

`POST /api/inquiries/{inquiryId}/human-request` `{ "aiConversationId": "conv-…" }` → 200 `{ "inquiryId", "route": "human", "status": "answer_waiting" }`. AI 가 먼저 답한 문의(`status='ai_answered'`, MX 가 만든다)를 「사람에게 물어보기」로 사람에게 넘긴다. 이미 사람이면 200 같은 본문. 대화 맥락은 `aiConversationId` 로 이어 붙이고 문의자는 같은 내용을 다시 쓰지 않는다. 학원 문의면 대표에게, 시스템 문의면 운영자에게 간다(FR-203a). 이 경로는 MX 가 만들어질 때까지 호출처가 없다 — 호출처가 없는 동안 린터 MISSING 만 안 나게 둔다.

### 2-4. 대표 문의함 — 보드 O22

`GET /api/academies/{academyId}/inquiries?filter=all|waiting|refund|human_request|answered&cursor=` — 권한 `owner`(위임 강사 불가, FR-207)
```json
{ "waitingCount": 2,
  "items": [ { "inquiryId": "…", "category": "refund", "origin": "member", "askerLabel": "살사러버",
               "context": "바차타 센슈얼 입문", "preview": "개인 사정으로 2회차부터 못 나가요…",
               "status": "answer_waiting", "createdAt": "…Z", "refundRequestId": "…", "route": "human" } ],
  "nextCursor": null }
```
- 칩 대응: 전체=`all` · 답변 대기=`waiting`(`status='answer_waiting'`) · 환불 요청=`refund` · 사람 요청=`human_request`(AI 뒤 사람에게 넘긴 것, `route='ai_handoff'`) · 답변 완료=`answered`
- 문의자는 **닉네임**만 내린다(`askerLabel`). 이름·연락처·계좌는 넣지 않는다(FR-187·FR-299). 다른 학원 id 로 부르면 403(SC-029b)
- 줄마다 `firstResponseDueAt`·`overdue`(답변 대기인데 기한을 넘김)를 더하고, 답변 대기를 기한이 가까운 순서로 맨 위에, 나머지를 최근 접수 순으로 그 아래에 둔다(spec 「대표 문의함: 기한이 가까운 순서 · 넘긴 건에 표시」). `origin` 은 `member`·`instructor`·`owner`, `context` 는 수업 이름(없으면 null)(추천안·사후 확인 2026-11-24, S7-2.2)

`GET /api/academies/{academyId}/inquiries/{inquiryId}` — 권한 `owner`(위임 강사 불가). 응답은 §2-2 의 문의자용 상세와 같은 모양(`inquiryId`·`kind`·`category`·`status`·`academy`·`refundRequestId`·`firstResponseDueAt`·`waiting`·`messages[]`). 목록 `preview` 가 40자에서 잘려 대표가 답하기 전에 글 전체를 읽는 자리다(보드 O22 「답하기 ›」). 다른 학원 id 는 가드가, 다른 학원·시스템 문의 id 는 처리기가 403 `FORBIDDEN`, 없는 문의 404(추천안·사후 확인 2026-11-24, S7-2.10 — S7-2.2 열린 점 9 를 채움)

`POST /api/academies/{academyId}/inquiries/{inquiryId}/replies` `{ "body": "학원 환불 규정상 …", "attachmentFileIds": [] }` · `Idempotency-Key` → 201 `{ "messageId", "status": "answered" }`. 답하면 문의자에게 알림 `inquiry_answered`(`class=transactional`). 이미 `closed` 면 409 `INQUIRY_CLOSED`. 이 학원의 문의가 아니면 403 `FORBIDDEN`. 환불 문의 답변은 그 학원의 환불 규정을 근거로 안내하고 환불 여부·금액은 학원이 정한다고 밝힌다(FR-205) — 화면 문구는 앱이 붙이고, API 는 본문을 그대로 받는다. 환불 금액 실행은 S4-1 경로(O48)이지 이 경로가 아니다.
- 같은 열쇠로 다시 보내면 200 같은 본문(재생 — 열쇠는 `inquiry_messages.idempotency_key`, 문의마다 유일). 첨부는 답하는 사람이 올린 `inquiry_attachment` 만 받고 검사는 §2-2 와 같다 — 문의자와 받는 쪽이 연다(S7-2.7 — 2026-11-24 변경, 이전: S7-2.7 전까지 빈 목록만). 이미 답한 문의에 다시 답해도 201(두 번째 글, 알림도 1건 더). 다른 학원 대표는 가드가, 다른 학원·시스템 문의 id 는 처리기가 403 을 낸다. `inquiry_answered` 의 받는 사람은 문의자(회원 → 회원 알림, 강사·대표 → 직원 알림함 「문의」 칩), 열쇠 `inquiry:<id>:answered:<messageId>`. 알림에는 답변 본문을 싣지 않는다(추천안·사후 확인 2026-11-24, S7-2.3)

### 2-5. 운영자 시스템 문의함

`GET /api/admin/inquiries?filter=all|waiting|answered&cursor=` — `kind='system'` 만(학원 문의는 값 자체가 안 나온다). 응답 모양은 2-4 목록과 같다(`all` 기본값 · 같은 모양은 추천안·사후 확인 2026-11-24, S7-2.2)
`POST /api/admin/inquiries/{inquiryId}/replies` — 모양은 2-4 와 같다. `kind='academy'` 문의 id 로 부르면 403 `FORBIDDEN`(SC-029b — 운영자가 학원 문의를 대신 받지 않는다).

### 2-6. 응답 기한 재알림 — 내부 작업

`POST /api/internal/jobs/inquiries/remind-overdue` → 200 `{ "reminded": 3 }`
- 대상: `status='answer_waiting'` 이고 `first_response_due_at < now()` 이고 `overdue_reminded_at IS NULL`. `UPDATE … SET overdue_reminded_at=now() WHERE … AND overdue_reminded_at IS NULL` 로 한 번만(수용 ② 의 「재알림」). 학원 문의는 대표에게 `inquiry_overdue`(category `inquiry`, `class=transactional`), 시스템 문의는 운영자에게. 회원 화면의 「답변 대기 중」은 `GET /api/inquiries` 의 `waiting` 으로 보인다. 재알림이 한 번 간 뒤에도 안 답하면 운영자가 대신 받지 않는다(FR-204) — 추가 재알림 간격은 열린 점 ④
- 받는 사람·열쇠: 학원 문의는 그 학원 `academy_owners(active)` 전원, 시스템 문의는 `role_grants(role='admin', active)` 전원. 열쇠 `inquiry:<id>:overdue:<staffId>`. `reminded` 는 이번에 표시를 붙인 문의 수(받는 사람 수가 아니다). 표시 붙이기와 알림 쓰기는 한 트랜잭션. 본문 `{ "asOf" }` 는 dev 경로가 켜졌을 때만 쓴다(다른 내부 작업과 같음). 접수 알림 `inquiry_received` 열쇠는 `inquiry:<id>:received:<staffId>`(추천안·사후 확인 2026-11-24, S7-2.3)

### 2-7. 신고 — 보드 C11A

`POST /api/reports` · 헤더 `Idempotency-Key`(필수) — 회원·강사·대표 세션(강사·대표는 회원만 신고, FR-188)
```json
{ "targetKind": "class", "targetId": "…", "reasonCode": "off_platform_payment",
  "detail": "첫 수업 뒤에 다음 달부터는 앱 말고 계좌로 직접 보내면 10% 깎아 준다고 했어요.", "attachmentFileIds": [] }
```
→ 201 `{ "reportId": "…", "status": "received", "steps": ["received","in_review","result_notified"], "receivedAt": "…Z" }`
- `targetKind`: `academy` · `instructor` · `class` · `member`. 신고자가 회원이면 `member` 대상은 못 한다(회원 → 회원 신고는 FR-188 이 허용하는지 spec 에 없다 — 열린 점 ⑩)
- `reasonCode`: `off_platform_payment`(앱 밖 결제·거래 유도) · `info_mismatch`(수업 정보가 실제와 다름) · `harassment`(욕설·괴롭힘) · `illegal_dangerous`(불법·위험한 내용) · `other`. `off_platform_payment` 는 FR-255 이고 확인되면 FR-254 절차의 사유로 쓴다
- 첨부는 `purpose=report_attachment`. 신고자와 운영자만 연다 — 신고받은 상대는 403. 붙이기 검사는 §2-2 와 같고, 같은 신고가 진행 중이라 그 신고를 200 으로 돌려줄 때는 새 첨부를 잇지 않는다(추천안·사후 확인 2026-11-24, S7-2.7)
- 상대에게는 누가 신고했는지 알리지 않는다(C11A). 같은 신고자·같은 대상·같은 사유로 아직 안 끝난 신고가 있으면 새로 만들지 않고 200 으로 그 신고를 돌려준다(`uq_reports_open`)
- 접수 즉시 신고자에게 알림 `report_received`, 운영자(모든 `admin` 계정)에게 `report_filed`(category `operations`)

`GET /api/reports` → `{ "items": [ { "reportId", "targetKind", "targetLabel", "reasonCode", "status", "outcomeLabel": null, "receivedAt", "resolvedAt": null } ] }` — 내 신고만. `outcomeLabel` 은 처리 결과 문구(`처리했어요`·`신고 내용을 확인했지만 조치할 일이 없어요` 같은 짧은 값, 사유 상세·대상 정보는 안 준다).

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` | 신고자 역할이 못 하는 대상(강사가 학원을 신고 등 — 열린 점 ⑩) |
| 404 | `NOT_FOUND` | 없는 대상 |
| 422 | `VALIDATION_FAILED` | 사유 값 밖 · `detail` 1,000자 초과(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) |

운영자 경로(권한 `admin`)
- `GET /api/admin/reports?status=received|in_review|resolved&cursor=` → 목록. 신고자는 **역할 + 닉네임**만(`reporterLabel`), 대상 정보 포함. 줄마다 `attachments: [ { fileId, displayName } ]` — 운영자가 `GET /api/files/{fileId}` 로 연다(추천안·사후 확인 2026-11-24, S7-2.7)
- `POST /api/admin/reports/{reportId}/start-review` → `received` → `in_review`. 이미 `in_review` 면 200. 신고자에게 알림 `report_in_review`. 이미 `resolved` 면 409 `REPORT_ALREADY_RESOLVED`, 응답 `{ "reportId", "status" }`(추천안·사후 확인 2026-11-24, S7-2.5)
- `POST /api/admin/reports/{reportId}/resolve` `{ "outcome": "dismissed" | "upheld", "note": "…", "openRestriction": { "measure": "warning", "reasonText": "…" } | null }` → 200 `{ "reportId", "status": "resolved", "restrictionCaseId": "…" | null }`. `upheld` 이고 `openRestriction` 이 있으면 같은 트랜잭션에서 §3 의 이용 제한 절차를 연다(`source='report'`). 신고자에게 알림 `report_resolved`. 감사 `report.resolved`. 이미 `resolved` 면 200 같은 본문, 다른 결과를 또 보내면 409 `REPORT_ALREADY_RESOLVED`. `received` 에서 바로 `resolve` 해도 되고 그때 `reviewed_at` 도 채운다 · `note` 는 선택(1,000자) · `openRestriction` 은 `upheld` 일 때만 받고 `dismissed` 와 함께 오면 422. 수업 신고는 그 수업의 학원이 대상이고, 같은 대상에 신고로 열린 절차가 이미 있으면 새로 열지 않고 그 절차 id 를 돌려준다(reports.restriction_case_id 로 잇는다) — 사유 코드는 신고 사유를 그대로 쓴다(추천안·사후 확인 2026-11-24, S7-2.6) · 강사·대표·회원 신고자는 역할로 정하고 운영자 전용 계정은 신고자가 될 수 없다(403) · 회원 본인 신고 422(추천안·사후 확인 2026-11-24, S7-2.5)

### 2-8. 이용 제한 절차 — FR-254 (사유 통지 → 소명 → 조치)

상태: `notice_sent` → `explained`(소명이 들어옴) → `measure_applied` → `lifted` · `dismissed`. 긴급(`urgent:true`)이면 조치를 먼저 하고 바로 알린다(`measure_applied` 에서 시작하고 `notice_sent_at` 이 같은 트랜잭션). 이용이 정지돼도 회원의 기존 결제 환불 청구권은 막지 않는다 — 구현은 환불 경로가 `restriction_cases` 를 읽지 않는 것으로 한다.

`POST /api/admin/restrictions` · `Idempotency-Key`
```json
{ "subjectKind": "academy", "subjectId": "…", "reasonCode": "off_platform_payment",
  "reasonText": "앱 밖 결제를 유도한 신고가 확인됐어요", "plannedMeasure": "listing_limit", "urgent": false, "explanationDays": 7 }
```
→ 201 `{ "caseId", "state": "notice_sent", "explanationDueAt": "…Z" }`. `subjectKind`: `member` · `instructor` · `academy`. `plannedMeasure`: `warning` · `feature_limit` · `listing_limit`(수업 게시 제한) · `payout_hold`(정산 보류) · `suspension`(이용 정지) · `termination`(해지). 대상에게 알림 `restriction_notice`(`class=transactional`)를 쓰고 소명 방법을 안내한다. `explanationDays` 기본 7(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), FR-250 사업자 점검의 7일과 같은 값). 감사 `restriction.opened`.
- S7-2.6 구현 메모(추천안·사후 확인 2026-11-24): `reasonCode` 는 신고 사유 5종 + `business_closed`·`business_suspended`·`terms_violation`, `reasonText` 필수(1~1,000자), `explanationDays` 1~30. 긴급이면 응답 `state: "measure_applied"` 이고 학원의 `listing_limit`·`payout_hold` 는 `academy_restrictions` 행을 바로 연다(`source_case_id`). 감사 `restriction.opened` 는 `audit_logs.reason` 칸에도 사유 글을 남긴다. 같은 운영자·같은 열쇠는 200 재생, 없는 대상(강사는 active 강사 역할이 있어야 한다) 404. 회원 `suspension` 의 `members.status` 효과는 그 칸이 아직 없어 절차 행에만 남는다
`GET /api/admin/restrictions?state=&subjectKind=&cursor=` → 목록.
`POST /api/admin/restrictions/{caseId}/apply` `{ "measure": "listing_limit", "note": "…" }` → `measure_applied`. `notice_sent`·`explained` 에서만(긴급 건 제외). 조치 효과: `listing_limit`·`payout_hold` 는 학원이면 §7-3b 의 `academy_restrictions` 행을 연다(`kind=listing_suspended`·`payout_hold`, `source_case_id`). 회원 `suspension` 은 `members.status='suspended'`. 감사 `restriction.applied`.
`POST /api/admin/restrictions/{caseId}/lift` `{ "reason": "소명 인정" }` → `lifted`. 열린 `academy_restrictions` 행에 `ended_at`. 감사 `restriction.lifted`. 이미 `lifted` 면 200.

`GET /api/me/restrictions` → 내 대상으로 열린 절차(회원·강사 본인, 대표는 자기 학원): `{ "items": [ { "caseId", "state", "reasonText", "plannedMeasure", "explanationDueAt", "canExplain": true } ] }`.
`POST /api/restrictions/{caseId}/explanations` · `Idempotency-Key` `{ "body": "폐업 신고는 장소를 옮기는 중이라 한 것이에요", "attachmentFileIds": ["…"] }` → 201 `{ "explanationId", "state": "explained" }`. 대상 본인(회원 본인·강사 본인·학원 대표)만. 기한이 지났어도 `notice_sent` 면 받는다(기한은 안내이지 차단이 아니다 — 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 이미 `lifted`·`dismissed` 면 409 `CASE_CLOSED`. 첨부 `purpose=restriction_explanation`.

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` | 남의 절차에 소명 |
| 404 | `NOT_FOUND` | 없는 절차 |
| 409 | `CASE_STATE_CONFLICT` | 순서에 안 맞는 전이(예: `lifted` 를 `apply`) |
| 409 | `CASE_CLOSED` | 끝난 절차에 소명 |
| 409 | `CASE_ALREADY_OPEN` | 같은 대상·같은 `source` 로 열린 절차가 이미 있음 |

### 2-9. 문의·신고 수용 시나리오

1. **Given** 학원 A·B 에 문의가 하나씩 **When** 학원 A 대표가 `GET …/academies/{B}/inquiries` **Then** 403, A 목록에는 B 문의가 없다(SC-029b)
2. **Given** 대표가 접수 뒤 1영업일 동안 답이 없다 **When** `remind-overdue` **Then** 대표에게 재알림 1건, 회원 목록에서 `waiting:true`, 작업을 다시 돌려도 재알림은 그대로 1건
3. **Given** 환불 문의 **When** 같은 예약에 환불 요청이 있다 **Then** `refundRequestId` 가 채워지고 대표 알림에 「환불 처리 ›」
4. **Given** 신고 접수 **When** 운영자가 `start-review` → `resolve` **Then** 신고자에게 알림 3건(접수·확인 중·결과), 상대에게는 알림 0건
5. **Given** 운영자 **When** 학원 문의 id 로 `POST /api/admin/inquiries/{id}/replies` **Then** 403

---

## 3. 약관·동의·탈퇴·권리·복구·자녀 (S7-3)

### 3-1. 약관 판본과 재동의 — FR-243 · FR-244 · FR-245 · FR-249 · 보드 C10A · C10B

입점 약관은 07 의 `POST /api/admin/terms-versions`(적용일 30일 전, FR-259)가 이미 맡는다. **회원 약관은 기간 규칙이 다르다**(약관 제3조 ② — 적용일 7일 전, 회원에게 불리하면 30일 전·앱 알림 개별 통지)라 경로를 따로 둔다.

`POST /api/admin/member-terms-versions` `{ "kind": "member_terms", "version": "1.1", "body": "…전문…", "effectiveAt": "2026-11-10T00:00:00Z", "isUnfavorable": true, "changeSummary": [ { "article": "제5조 (결제)", "text": "이벤트·원데이·파티·공연·대회는 간편 계좌이체·가상계좌로만 결제해요." } ] }` → 201 `{ "termsVersionId", "publishedAt", "notifyFrom": "…Z" }`
- `kind`: `member_terms` · `member_privacy_collection` · `academy_sharing`(학원에 개인정보 제공) · `location_info` · `marketing_consent` (데이터 §12-9). 같은 `kind` 의 이전 판본이 있을 때 `effectiveAt` 이 `isUnfavorable` 이면 지금+30일, 아니면 지금+7일보다 앞서면 422 `NOTICE_PERIOD_TOO_SHORT`. 첫 판본(이전 판본 없음)은 기간 제한 없음
- 발행은 `terms_versions` 행과 감사 `terms_version.published` 를 같은 트랜잭션에 쓴다. 이전 판본은 지우지 않는다(FR-244)
- 알림: 불리한 변경이면 앱 알림 개별 통지를 만든다 — 내부 작업이 만든다(`POST /api/internal/jobs/terms/notify`, 아래)

`POST /api/internal/jobs/terms/notify` → 200 `{ "notified": 3420 }` — 발행됐고 적용일 전이며 아직 통지하지 않은 판본에 대해 `isUnfavorable` 이면 `active` 회원 전원에게 알림 `terms_change_notice`(`class=transactional`, `dedupe_key=terms:<versionId>:<memberId>`) 1건, 불리하지 않은 변경은 공지 배너용 행만(알림함 제외, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 적용일 7일 전·30일 전이 지난 뒤에 발행됐으면 발행 직후 한 번에 쓴다.

`GET /api/me/terms` → 200
```json
{ "items": [ { "termsVersionId": "…", "kind": "member_terms", "version": "1.1", "agreedAt": "2026-11-10T00:12:00Z",
               "effectiveAt": "2026-11-10T00:00:00Z", "supersededAt": null, "current": true },
             { "termsVersionId": "…", "kind": "member_terms", "version": "1.0", "agreedAt": "2026-09-28T12:05:00Z",
               "effectiveAt": "2026-09-28T00:00:00Z", "supersededAt": "2026-11-10T00:00:00Z", "current": false } ],
  "optional": [ { "item": "marketing", "agreed": true, "changedAt": "2026-10-15T01:20:00Z" }, { "item": "location", "agreed": false, "changedAt": null } ] }
```
내가 **동의한** 판본만(이용약관 1.0 과 1.1 이 나란히, C10B). 사업자 정보(회사·판매자 학원)는 약관과 따로 S3-2(탐색·수업 상세·판매자 정보)의 판매자 정보가 준다(02 의 수업 상세 응답 · 학원 공개 정보 경로 이름은 아직 계약에 없다) — 이 파일은 정하지 않는다.
`GET /api/me/terms/{termsVersionId}` → `{ kind, version, body, publishedAt, effectiveAt }`. 내가 동의한 판본이거나 현재 적용·적용 예정인 판본만(다른 것은 404).

`GET /api/me/terms/pending` → 200
```json
{ "required": true,
  "items": [ { "termsVersionId": "…", "kind": "member_terms", "version": "1.1", "effectiveAt": "2026-11-10T00:00:00Z", "isUnfavorable": true,
               "noticedAt": "2026-10-09T00:00:00Z",
               "changeSummary": [ { "article": "제5조 (결제)", "text": "…" }, { "article": "제4조 (가입과 계정)", "text": "탈퇴하면 입금 대기 중인 주문은 자동으로 취소돼요." } ] } ] }
```
`required:true` 는 **적용일이 지났고 내가 아직 동의하지 않은 불리한 판본**이 하나라도 있을 때다. 적용일 전이거나 불리하지 않은 변경은 목록에 넣되 `required:false`.
`POST /api/me/terms/consents` `{ "termsVersionIds": ["…"] }` → 200 `{ "agreed": [ { "termsVersionId", "agreedAt" } ] }` — 같은 판본에 다시 동의하면 200 같은 본문(`uq_consents` 가 권위, 시각은 서버 시각). 판본이 아직 적용 전·존재하지 않으면 404. 동의 기록은 `member_consents` 에 `source='re_consent'` 로 쓴다.

**재동의 가드(FR-243·S7-3.2)**: `POST /api/orders`(03)는 시작 전에 `required:true` 인지 본다(순수 함수 `findBlockingTerms(memberId, now)`). 막히면 409 `TERMS_RECONSENT_REQUIRED` 에 `pendingTermsVersionIds`. 이미 결제한 주문에는 결제할 때 고정한 판본(`orders.member_terms_version`, 03 §6-2)이 그대로 적용되고 소급하지 않는다(FR-245, SC-035). 화면 「나중에 하기 · 둘러보기만 할게요」는 가드를 풀지 않는다 — 조회는 계속 되고 결제 시작만 막힌다.

`PUT /api/me/optional-consents` `{ "item": "marketing" | "location", "agreed": true }` → 200 `{ "item", "agreed", "changedAt" }`. 같은 값이면 기록 없이 200. 바꿀 때마다 `member_consents` 에 동의·철회 시각이 쌓인다(C10B 「바꾼 시각도 남아요」). `marketing` 은 1-1 의 `marketingAgreed` 와 같은 기록이다(어느 쪽으로 바꿔도 같은 줄).

### 3-2. 탈퇴 — FR-190 · 보드 C11B(회원) · I30(강사)

규칙(Q30 임시 확정): **남은 회차가 있는 예약이 있으면 탈퇴를 막고 안내한다** · 입금 대기 주문은 탈퇴 때 자동 취소 · 처리 중인 환불이 있으면 환불이 끝난 뒤 계정을 지운다 · 남은 쿠폰·멤버십 혜택은 사라진다는 확인을 받는다 · 한 번뿐인 혜택(대학생 첫 결제 50% 등)은 재가입해도 못 받는다(FR-010, 데이터 §12 의 `withdrawn_identities`).

`GET /api/me/withdrawal/preview` → 200
```json
{ "canWithdraw": false,
  "blockers": [ { "kind": "active_reservation", "reservationId": "…", "title": "쌈바(입문) · 라틴하우스 강남", "remainingSessions": 4, "nextSessionAt": "…Z", "actionHint": "취소·환불은 탈퇴 전에 요청해요" } ],
  "inProgress": [ { "kind": "refund_pending", "title": "바차타 센슈얼 입문", "amount": 45000, "note": "환불이 끝난 뒤에 계정이 지워져요" },
                  { "kind": "unpaid_order", "orderId": "…", "title": "강남 바차타 선데이", "amount": 20000, "dueAt": "…Z", "note": "탈퇴하면 자동으로 취소돼요" } ],
  "losses": [ { "kind": "coupon", "count": 1 }, { "kind": "membership", "endsAt": "2027-01-14T14:59:59Z" } ],
  "oneTimeBenefitsLost": ["university_first_payment_50"],
  "retention": { "contractPaymentYears": 5, "disputeYears": 3, "accessLogMonths": 3 } }
```
`blockers` 가 비면 `canWithdraw:true`. `blockers` 는 **남은 회차(앞으로 올 회차가 하나라도 있는 `confirmed` 예약)** 이다. 앞으로 올 회차가 없는 예약(전부 끝난 것)은 막지 않는다. 「남은 회차 예약이 있으면 탈퇴 버튼이 안내로 바뀐다」(수용 ②) — 화면이 `canWithdraw:false` 로 버튼 대신 안내를 그린다. 대표·강사로 만든 정산이 남은 계정이면 M5 의 미정산 값을 읽는다(5-3 값 — 회원 탈퇴에는 해당 없음, 강사 탈퇴 아래).
`POST /api/me/withdrawal` · `Idempotency-Key` `{ "ackCoupons": true, "ackMembership": true, "ackOneTimeBenefits": true }` → 202
```json
{ "withdrawalId": "…", "status": "awaiting_refunds", "autoCancelledOrderIds": ["…"], "completesAfterRefunds": true }
```
- 같은 트랜잭션: 입금 대기 주문(`pending`)을 `cancelled`(사유 `withdrawal`, 03 §4-1 의 `cancelled` 전이를 쓴다 — `reservations.cancel_reason='withdrawal'` 값 추가는 M3 와 조율, 열린 점 ⑧) · `order_events` · 열린 쿠폰·멤버십은 「해지 예약」이 아니라 즉시 소멸 표시(멤버십 환불 없음, FR-297a) · `account_withdrawals` 1행 · 감사 `member.withdrawal_requested`. 처리 중인 환불이 없으면 즉시 `completed` 로 가고 `members` 를 익명화한다(아래 작업과 같은 함수 — 이름·연락처·취향(관심 장르)·환불 계좌를 이때 한꺼번에 비운다, D18)
- `ackCoupons`·`ackMembership`·`ackOneTimeBenefits` 는 미리보기에 해당 항목이 있을 때만 `true` 여야 한다(없는 항목은 생략 가능). 빠지면 422 `ACK_REQUIRED`
- 이미 요청한 회원이 다시 부르면 200 같은 본문(`uq_withdrawals_active`). 요청 뒤 로그인은 막는다(`members.status='withdrawn_pending'`) — 단 처리 중인 환불·알림 수신은 계속

| HTTP | code | 언제 |
|---|---|---|
| 409 | `WITHDRAWAL_BLOCKED` | 남은 회차 예약이 있음(`blockers` 를 본문에 함께 준다) |
| 409 | `WITHDRAWAL_ALREADY_REQUESTED` | (멱등키가 다르고) 이미 진행 중 — 200 같은 본문을 우선하므로 실제로는 키 불일치 재요청에서만 |
| 422 | `ACK_REQUIRED` | 확인 항목을 체크하지 않음 |

`POST /api/internal/jobs/withdrawals/complete` → 200 `{ "completed": 2 }` — `awaiting_refunds` 이고 그 회원의 환불·분쟁이 모두 끝난 건을 `completed` 로 바꾸고 회원 정보를 **즉시 익명화**(이름·연락처·생년·**취향(`member_interest_genres`)·환불 계좌(`refund_accounts` 의 번호·가린 번호·예금주)**·본인확인 해시 대신 `withdrawn_identities` 에 해시와 혜택 사용 표시만 남김)한다(2026-11-20 사용자 결정 D18 — 법률 검토 대상). 주문·결제·환불 기록은 지우지 않고 `data_retention_items` 에 **5년** 기한을 걸고(`transaction_record`), 불만·분쟁 처리 기록은 **3년**(`dispute_record`)을 건다(화면에서는 사라진다, 수용 ④). 감사 `member.withdrawn`.

`POST /api/internal/jobs/retention/purge` → 200 `{ "purged": { "transaction_record": 0, "dispute_record": 4, "access_log": 1200 } }` — `retain_until < now()` 이고 `purged_at IS NULL` 인 줄을 지운다(5년·3년·3개월은 `ops_settings` 값). 지운 줄은 `purged_at` 을 남긴다(삭제 사실 기록). 같은 작업을 다시 돌려도 이미 지운 줄은 건드리지 않는다.

**강사 탈퇴(I-03, 보드 I30)** `GET /api/staff/withdrawal/preview` → `{ "canWithdraw": false, "blockers": [ { "kind": "active_class" | "private_lesson_session" | "unsettled_payout", "title", "amount"?, "note" } ], "retention": { "taxRecordYears": 5 } }`. 진행 중 수업·개인 레슨 회차·받을 정산(M5 의 지급 상태를 읽음)이 남으면 막는다(S7-3.8). `POST /api/staff/withdrawal` · `Idempotency-Key` → 202 `{ "withdrawalId", "status": "completed" }`. 막히면 409 `WITHDRAWAL_BLOCKED`. 세무 기록은 보관한다(I30). **회원 앱 계정은 따로** — 강사 탈퇴가 회원 계정을 지우지 않는다. 대표 탈퇴(입점 해지)는 이 파일 밖(FR-256, Q11 ⑥ 미정).

### 3-3. 개인정보 열람·정정·처리정지·삭제 요청 — FR-190 · 보드 C21A

`GET /api/me/profile-data` → 200
```json
{ "member": { "name": "김서연", "gender": "female", "birthYear": 1999, "phone": "010-0000-0000", "loginProvider": "kakao",
              "university": { "verified": true, "domain": "snu.ac.kr" } },
  "providedToAcademies": [ { "academyId": "…", "academyName": "라틴하우스 강남", "items": ["name","gender","phone"], "firstProvidedAt": "2026-10-01T00:00:00Z", "reason": "first_enrollment" } ],
  "editable": [ "phone" ] }
```
- 이름·성별·생년은 본인확인 결과라 **고칠 수 없다**(`editable` 에 없음). 연락처만 `POST /api/me/contact-change` 로 다시 본인확인 후 바꾼다
- 대학생 인증은 도메인만 보인다(학교 이메일 원문은 보관하지 않는다, FR-008). 연락처 전체는 본인 것이므로 내려주되(마스킹 안 함) 로그에는 가린 값만 남긴다
- `providedToAcademies`: 그 학원이 처음 받은 시점·항목(첫 신청·대기 신청·원데이 같은 사유). 출처는 예약·대기 이력이다

`POST /api/me/contact-change` `{ "identityToken": "…" }` → 200 `{ "phone": "010-1111-2222", "changedAt" }`. 토큰의 CI 가 이 회원의 `identity_ci_hash` 와 같아야 한다 — 다르면 403 `IDENTITY_MISMATCH`(다른 사람 번호로 바꾸기 방지). 토큰이 쓰였거나 만료면 422 `IDENTITY_TOKEN_INVALID`. 감사 `member.contact_changed`(가린 값만).

`POST /api/me/data-requests` · `Idempotency-Key` `{ "kind": "processing_stop" | "deletion", "note": "…" }` → 201 `{ "requestId", "status": "received", "dueAt": "…Z" }`. `dueAt` = 접수 + **10일**(추천값, 법정 기한은 법률 확인 필요 — 열린 점 ⑪). `deletion` 은 탈퇴(3-2)로 이어지는 입구이고 화면이 `GET …/withdrawal/preview` 로 넘긴다. 거래 기록은 법정 보관 기간 동안 따로 남는다. 이미 열린 같은 종류 요청이 있으면 200 으로 그 요청. 접수 알림 `data_request_received`.
`GET /api/me/data-requests` → `{ "items": [ { "requestId", "kind", "status", "dueAt", "resultNote", "resolvedAt" } ] }`.
운영자: `GET /api/admin/data-requests?status=` · `POST /api/admin/data-requests/{requestId}/resolve` `{ "status": "done" | "rejected", "resultNote": "…" }` → 200. 처리 결과를 신청자에게 알림 `data_request_resolved`(`class=transactional`). 처리정지는 `members.processing_stopped_at` 을 채우고 광고성·학원 제공 외 처리를 멈춘다(범위는 열린 점 ⑪). 이미 처리면 200 같은 본문. 감사 `data_request.resolved`(FR-198).

### 3-4. 계정 복구 — spec 계정 복구 보완(FR-003 근처) · 보드 없음

소셜 계정을 잃었거나 바꾼 회원이 **새 소셜 계정으로 로그인한 뒤** 다시 본인확인을 하면 같은 CI 의 기존 계정에 새 소셜 계정을 붙인다. 새 회원을 만들지 않으므로 한 사람 한 계정 규칙이 지켜진다.

`POST /api/account-recovery` — 세션은 있으나 `members` 가 없는(가입 미완료) 새 소셜 계정
```json
{ "identityToken": "…" }
```
→ 200 `{ "memberId": "…", "recovered": true, "previousProvider": "kakao" }`
- 서버가 `IdentityVerificationPort.verify`(06)로 `ciHash` 를 얻어 `members.identity_ci_hash` 로 기존 회원을 찾는다. 찾으면 `members.auth_user_id` 를 새 `auth.user` 로 바꾸고 옛 `auth.account` 연결을 해제한다(한 트랜잭션, 감사 `member.account_recovered` — 옛·새 provider 만 남기고 토큰은 남기지 않는다). 같은 요청을 다시 보내면 200 같은 본문
- 찾지 못하면 404 `NO_MEMBER_FOR_IDENTITY` — 화면은 일반 가입(01)으로 보낸다. 이미 `withdrawn`·`withdrawn_pending` 회원의 CI 면 409 `ACCOUNT_WITHDRAWN`(재가입은 01 가입 경로가 혜택 차단과 함께 처리). 세션이 이미 가입 완료 회원이면 409 `RECOVERY_NOT_NEEDED`. 새 소셜 계정이 이미 다른 회원에 붙어 있으면 409 `SOCIAL_ALREADY_LINKED`
- 본인확인 요청 제한(429 `RATE_LIMITED`, README §6-4)은 같은 IP·계정 15분 5회(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))

| HTTP | code | 언제 |
|---|---|---|
| 401 | `UNAUTHENTICATED` | 세션 없음 |
| 404 | `NO_MEMBER_FOR_IDENTITY` | 같은 CI 회원 없음 |
| 409 | `ACCOUNT_WITHDRAWN` · `RECOVERY_NOT_NEEDED` · `SOCIAL_ALREADY_LINKED` | 위 |
| 422 | `IDENTITY_TOKEN_INVALID` | 토큰 만료·재사용 |

### 3-5. 보호자 계정 자녀 — FR-009a · 보드 C6A · C6B

만 19세 미만은 직접 가입하지 않고 보호자(본인확인을 마친 만 19세 이상 회원) 계정의 **자녀**로 등록한다. 자녀는 로그인하지 않고 알림·환불은 보호자 계정으로 온다. 학원·강사에게는 이름과 연령대만 보인다(C6A). 보드 C6A 의 제목은 「만 14세 미만」이고 아래 문구는 「만 19세 미만」이다 — 이 계약은 **만 19세 미만**을 따른다(FR-009a, 열린 점 ⑫).

`POST /api/me/children` · `Idempotency-Key`
```json
{ "name": "김하윤", "gender": "female", "birthDate": "2017-05-12", "guardianConsent": true }
```
→ 201 `{ "childId": "…", "name": "김하윤", "gender": "female", "ageYears": 9, "ageBand": "초등", "guardianConsentAt": "…Z" }`
- `guardianConsent:true` 가 아니면 422 `GUARDIAN_CONSENT_REQUIRED`(「보호자로서 자녀의 개인정보 처리에 동의해요」 필수). 동의 시각을 서버 시각으로 남기고 동의한 약관 판본도 함께 저장한다
- `birthDate` 로 만 나이를 계산해 **만 19세 이상이면 422 `CHILD_AGE_OUT_OF_RANGE`**(직접 가입 대상). 판정 함수는 S3-1.3 의 만 나이 함수를 쓴다(경계: 생일 전날은 만 18세, 생일 당일부터 만 19세)
- 보호자는 본인확인을 마친 회원이어야 한다(`members.identity_ci_hash` 있음). 자녀 수 상한은 두지 않는다(spec 근거 없음 — 열린 점 ⑫)
- 같은 보호자·같은 이름·같은 생년월일은 `uq_children_guardian_identity` 로 막고 200 으로 그 자녀를 돌려준다
`GET /api/me/children` → `{ "items": [ { "childId", "name", "gender", "ageYears", "ageBand", "adultOn": "2036-05-12" } ] }` — `adultOn` 은 만 19세가 되는 날(보호자 화면용). 학원·강사에게 가는 응답에는 이름과 `ageBand` 만 쓴다(03 의 명단 규칙에 따라 M3 가 맞춘다).
`DELETE /api/me/children/{childId}` → 200 `{ "removedAt" }`. 그 자녀에게 진행 중 예약이 있으면 409 `CHILD_HAS_ACTIVE_RESERVATION`. 지운 자녀의 이름·생년월일은 지우고 결제·예약 기록은 보호자 기록으로 5년 보존된다(데이터 §12). 「내가 탈퇴하면 자녀 정보도 함께 지워요」(C6A) — 탈퇴 마무리 작업이 자녀를 같이 지운다.
`POST /api/internal/jobs/children/age-check` → 200 `{ "flagged": 1 }` — 만 19세가 된 자녀(`adult_flagged_at IS NULL`)를 표시하고 보호자에게 알림 `child_turned_adult`. **본인 계정으로 넘어가는 방법은 정하지 않았다** — 자녀는 본인확인으로 직접 가입해야 하고 옛 수강 기록을 어떻게 잇는지가 spec 에 없다(Q29, 열린 점 ⑫). 이 작업은 표시와 알림까지만 한다.

### 3-7. 입점 해지 — FR-256(해지 뒤 결제된 수업 끝까지 제공·정산) · 보드 W26 (2026-11-20 통합 때 추가)

근거는 FR-256 본문과 보드 W26 글자뿐이다. 근거가 없는 것의 추천값은 열린 점 ㉔~㉖ 에 올렸다(㉔~㉖ 은 2026-11-20 사용자 결정 D19 로 확정, 나머지 추천값은 D20 으로 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 대표만(`requireStaff('owner', { academyId, surface: 'web' })`, 2단계 인증 세션) — 위임 강사·앱 토큰은 403(앱은 `WEB_ONLY`).

| 메서드·경로 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|
| `GET /api/academies/{academyId}/termination/preview` | 해지 전 확인 — 남은 수업·아직 받지 않은 정산금·해지 순서 | 읽기 | FR-256 | W26 |
| `POST /api/academies/{academyId}/termination` | 입점 해지 신청 | 헤더 `Idempotency-Key` · 이미 신청이면 200 같은 본문 | FR-256 | W26 |
| `POST /api/internal/jobs/academy-terminations/complete` | 마지막 수업·마지막 정산이 끝난 학원을 `terminated` 로 | 학원 행 조건부 갱신 | FR-256 | W26 「해지 완료」 |

`GET …/termination/preview` 200
```json
{ "academyStatus": "active",
  "remainingClasses": [ { "classId": "…", "title": "바차타 센슈얼 입문", "paidCount": 12, "pendingPaymentCount": 0, "remainingSessions": 4, "lastSessionOn": "2026-11-28", "note": "11/14 휴강분은 11/21로 옮김" },
                        { "classId": "…", "title": "12월 라틴 파티", "paidCount": 32, "pendingPaymentCount": 2, "remainingSessions": 1, "lastSessionOn": "2026-12-19", "note": null } ],
  "lastSessionOn": "2026-12-19",
  "pendingApprovalClasses": [ { "classId": "…", "title": "쌈바(입문)" } ],
  "settlements": [ { "kind": "academy_period", "label": "11월분 학원 정산", "amount": 3422300, "status": "scheduled", "dueOn": "2026-12-05" },
                   { "kind": "payout_hold", "label": "지급 보류 · 카드 이의제기", "amount": 160000, "status": "held", "dueOn": null },
                   { "kind": "instructor_payout", "label": "강사 지급 · 11월분", "amount": 609210, "status": "awaiting_approval", "dueOn": "2026-12-11" },
                   { "kind": "academy_period", "label": "12월분 학원 정산", "amount": null, "status": "not_calculated", "dueOn": "2027-01-05" } ],
  "expectedFinalSettlementOn": "2027-01-05" }
```
- `remainingClasses` 는 결제한 회원(`paid` 주문)이 있거나 입금 대기 주문이 있는 수업만, 마지막 회차가 오늘 이후인 것. 화면은 4개를 넘으면 「그 밖에 수업 N개」로 묶는다(보드). `settlements` 는 13 의 정산 기간·지급 보류·지급 묶음을 읽는다(이 경로는 아무것도 쓰지 않는다). 금액은 정수 원
- `expectedFinalSettlementOn` = 마지막 회차가 속한 달의 정산일(다음 달 5일, 13 §7)

`POST …/termination` 요청 `{ "reasonText": "운영 종료", "acknowledged": true }` → 200 `{ "academyStatus": "termination_requested", "requestedAt": "…Z", "lastSessionOn": "2026-12-19", "expectedFinalSettlementOn": "2027-01-05", "closedPendingClassIds": ["…"] }`
- `acknowledged` 는 화면 체크 「남은 수업을 끝까지 열고, 회원 문의와 환불 요청에도 계속 답해야 한다는 것을 확인했어요」. `true` 가 아니면 422 `ACK_REQUIRED`. `reasonText` 1~200자(필수 — 보드 「해지 사유 · 한 줄로」), 아니면 422 `VALIDATION_FAILED`
- 한 트랜잭션: `academies.status` `active` → `termination_requested`(조건부 갱신, 이미 `termination_requested` 면 200 처음 본문) · `termination_requested_at`·`termination_requested_by_account_id`·`termination_reason_text` · 승인 대기(`pending_approval`) 수업을 공개하지 않고 닫는다(11 의 수업 상태 전이를 그대로 쓴다 — 보드 「승인 대기 중인 쌈바(입문)는 공개하지 않고 닫아요」) · 감사 `academy.termination_requested`
- 신청 즉시 **새 결제와 새 수업 게시만** 막힌다: 주문 생성(03)과 수업 게시(11)가 `academies.status IN ('restricted','termination_requested')` 를 보고 409 `ACADEMY_RESTRICTED`(본문 `reason: "termination_requested"`)를 낸다. 이미 결제된 예약·환불 요청·문의·정산·지급은 그대로 돈다(FR-256)
- `restricted` 학원도 신청할 수 있다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). `terminated` 면 409 `CASE_CLOSED`
- 환불·이의제기로 돌려줄 돈(회원 환불금)이 생기면 남은 정산금에서 **먼저 상계**하고(13 의 `offset` 줄 — 사유 `termination_refund`, FR-253), 모자라면 **운영자가 대표에게 청구**한다(2026-11-20 사용자 결정 D19). 청구 화면·경로는 만들지 않는다 — 운영자 수동. **신청은 취소할 수 없다**(취소 경로 없음, D19)

`POST /api/internal/jobs/academy-terminations/complete`(매일, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) — `termination_requested` 인 학원 중 ① 마지막 회차가 끝났고 ② 그 학원의 정산 기간이 모두 마감(`closed`)이고 지급 묶음이 모두 `completed` 이며 ③ 열린 환불 요청·계좌 환불 송금 대기가 0 이면 `terminated` + `terminated_at`. 같은 트랜잭션에서 학원 페이지를 내리고(공개 목록에서 빠짐) 구독한 회원에게 알림 `academy_terminated`(class `service`). 감사 `academy.terminated`. 조건을 못 채우면 아무것도 하지 않는다(다음 날 다시)

| HTTP | code | 언제 |
|---|---|---|
| 403 | `FORBIDDEN` · `WEB_ONLY` | 대표가 아님 · 앱 토큰 |
| 409 | `CASE_CLOSED` | 이미 `terminated` |
| 422 | `ACK_REQUIRED` · `VALIDATION_FAILED` | 확인 체크 없음 · 사유 길이 |

### 3-6. 약관·탈퇴 수용 시나리오

1. **Given** 불리한 약관 1.1 의 적용일이 지났고 회원이 동의하지 않았다 **When** `POST /api/orders` **Then** 409 `TERMS_RECONSENT_REQUIRED`. `POST /api/me/terms/consents` 뒤에는 201(수용 ①)
2. **Given** 약관 1.0 으로 결제한 주문 **When** 1.1 이 적용된다 **Then** 그 주문의 `member_terms_version` 은 `1.0` 그대로(수용·SC-035)
3. **Given** 남은 회차 예약이 있는 회원 **When** `GET …/withdrawal/preview` **Then** `canWithdraw:false`, `POST …/withdrawal` 은 409 `WITHDRAWAL_BLOCKED`(수용 ②)
4. **Given** 입금 대기 주문 1건과 남은 회차 없음 **When** 탈퇴 **Then** 주문은 `cancelled`, `order_events` 1행, 응답에 `autoCancelledOrderIds`(수용 ③)
5. **Given** 탈퇴 완료 **When** 결제 기록을 센다 **Then** `payments`·`refunds` 행은 남고 `data_retention_items` 에 5년 기한, 회원 화면 조회는 404(수용 ④)
6. **Given** 같은 CI 로 새 카카오 계정이 본인확인 **When** `POST /api/account-recovery` **Then** `members` 행 수 변화 없음, `auth_user_id` 만 바뀜(수용 ⑤)
7. **Given** 생년월일이 만 19세가 되는 날 **When** `POST /api/me/children` **Then** 당일 422 `CHILD_AGE_OUT_OF_RANGE`, 전날 201

---

## 4. 운영자 도구·플랫폼 콘솔 (S7-4)

### 4-1. 공통 — 콘솔 규칙

- 권한: 모두 `requireStaff('admin', { surface: 'web' })`. 위임 강사·대표는 403(FR-300 「주소로 직접 들어가도 서버가 막는다」). 메뉴: `GET /api/staff/me`(README §6-1)가 `admin` 역할에 `console_*` 메뉴를 준다
- **조회 전용(FR-301)**: 이 절의 `GET`·`simulate` 은 아무 것도 쓰지 않는다. 쓰는 경로는 4개 예외뿐이다 — ① 수수료율 `POST …/fee-rates` ② P9 공휴일 ③ P10 예금주 확인·반려 ④ P11 소명 처리(②~④의 경로는 `13-settlement.md` §10). 모두 감사 기록을 남긴다
- **개인정보 없음(FR-302)**: 응답에 수강생 이름·연락처·나이가 없다. 학원·강사·수업 단위로 모은 숫자만 준다. 수업·강사 이름은 학원이 정한 그대로, 사업자등록번호는 가린 값. P10 은 대표·강사(직원 계정)의 이름과 가린 계좌번호만 보인다(수강생 정보 아님). 테스트: 모든 콘솔 응답 JSON 에 `phone`·`birth`·수강생 `name` 키가 없음을 검사한다(S7-4 수용 ②)
- **조회 기록**: 모든 콘솔 `GET` 은 감사 `console.viewed`(대상 `console_screen`, 화면 이름, 필터 값)를 쓴다 — 화면 아래 「조회 기록이 남아요」(FR-302). 엑셀 내보내기는 `console.exported`. 같은 사람이 같은 화면을 1분 안에 다시 열면 한 줄로 합친다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 로그가 쏟아지는 것을 막는다 — 열린 점 ⑬)
- 기간: `period=day|week|month|quarter|year|custom`, `from`·`to`(KST 날짜 `YYYY-MM-DD`, `custom` 이면 둘 다 필수, 포함 범위). `period` 와 기준 날짜 `anchor` 가 있으면 서버가 기간을 계산한다. 응답 머리는 `{ "period": { "from","to" }, "previous": { "from","to" }, "asOf": "…Z" }` — `previous` 는 같은 길이의 직전 기간, `asOf` 는 데이터 기준 시각(FR-319)
- 증감 모양: `{ "value": 48200000, "previous": 42900000, "deltaPct": 12.4 }`. 비율 지표(환불률·쿠폰 사용률)는 `deltaPp`(%p). 직전 값이 0 이면 `deltaPct:null`
- 금액은 원 정수, 비율은 소수 한 자리 숫자(`3.4` = 3.4%) — 내부는 bp 정수로 세고 응답에서 `rateBp` 도 함께 준다(검산용)
- 집계의 원천은 **M5 정산 원장**(`settlement_entries` 확장, S5-1)과 `orders`·`payments`·`refunds`다. 이 계약은 읽는 모양만 정하고 원장 줄 이름은 M5 가 정한다(열린 점 ⑭)
- 오류: 400 `INVALID_PERIOD`(from>to·`custom` 에 날짜 없음·366일 초과) · 403 `FORBIDDEN` · 401 `SECOND_FACTOR_REQUIRED`

### 4-2. P1 대시보드 — `GET /api/admin/console/dashboard`

쿼리 `period`·`anchor`(또는 `from`·`to`)·`metric`(추이 그래프 지표, 기본 `paid_amount`). 200
```json
{ "period": { "from": "2026-11-01", "to": "2026-11-30" }, "previous": { "from": "2026-10-01", "to": "2026-10-31" }, "asOf": "2026-12-01T03:00:00Z",
  "ledgerCheck": { "status": "ok", "diffAmount": 0, "checkedAt": "2026-12-01T03:00:00Z" },
  "cards": {
    "paidAmount":      { "value": 48200000, "previous": 42900000, "deltaPct": 12.4 },
    "paymentCount":    { "value": 412, "previous": 381, "deltaPct": 8.1 },
    "avgPayment":      { "value": 116990, "previous": 112500, "deltaPct": 4.0 },
    "refundRate":      { "value": 3.4, "previous": 3.7, "deltaPp": -0.3 },
    "couponUseRate":   { "value": 18.5, "previous": 16.4, "deltaPp": 2.1 },
    "feeIncome":       { "value": 1210000, "previous": 1104000, "deltaPct": 9.6, "note": "면제 학원 제외" },
    "activeAcademies": { "value": 128, "previous": 122, "delta": 6 },
    "activeMembers":   { "value": 3420, "previous": 3251, "deltaPct": 5.2 } },
  "membership": { "available": false, "availableFrom": "S6-1", "revenue": null, "annualDiscount": null, "refundPgFee": null },
  "trend": { "metric": "paid_amount", "unit": "day", "points": [ { "date": "2026-11-01", "value": 1520000 } ], "previousAverage": 1430000 } }
```
- 카드는 **보드 P1 의 8개**(D5, FR-304 베타 범위). 멤버십 수입(3개월·연 구분)과 플랫폼 비용(연 멤버십 할인액·멤버십 환불 PG 수수료)은 `membership.available:false` + 숫자 `null` — 0 으로 내리지 않는다(10 §1 의 뼈대 원칙과 같다). S6-1 이 열리면 `available:true` 로 채운다
- `feeIncome` 은 **실제 징수**한 수수료(일반 5%·개인 레슨 1%, 입점 1년 면제 학원의 일반 수업·행사분은 0, 강사 가입일부터 1년 안의 개인 레슨분도 0 — 2026-11-23 변경 — 이전: 개인 레슨은 항상 1%. 강사 가입일 칸은 구현 Task 에서 정한다). 「면제가 없었다면 받았을 수수료」(FR-304 의 베타 면제 효과)는 보드에 없어 응답에서 뺐다(열린 점 ⑮)
- `ledgerCheck`(FR-318 — 콘솔 합계가 원장 합계와 일치하는지 매일 검사)는 M5 의 대사 결과를 읽는다. `status`: `ok` · `mismatch`(어긋난 금액과 함께 첫 화면에 경고) · `unknown`(검사가 아직 안 돎). 값: `activeAcademies` = 기간 안에 결제가 있는 입점 학원 수가 아니라 **입점 중인 학원 수**(보드 「입점 학원 128곳」 — 상태 `active`), `activeMembers` = 기간 안에 로그인한 회원 수가 아니라 **기간 안에 결제·예약·신청 같은 활동이 있는 회원 수**(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 정의가 spec 에 없다 — 열린 점 ⑮)
- `trend.metric` 은 카드 지표 이름(`paid_amount`·`payment_count`·`avg_payment`·`refund_rate`·`coupon_use_rate`·`fee_income`). `unit` 은 기간이 31일 이하면 `day`, 그보다 길면 `week`(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))

### 4-3. ~~P2 장르별~~ — 삭제(2026-11-24)

FR-306(장르별 결산)이 삭제돼 `GET /api/admin/console/genres` 는 만들지 않는다(사용자 결정 「대표가 장르별로 결산할 이유가 없어」 — 정산은 학원 단위다). 결산은 §4-4(학원별)·§4-5(상품·결제수단·지역)로 본다.

### 4-4. P3 학원별 — `GET /api/admin/console/academies` · `…/academies/{academyId}`

목록 쿼리: 기간 + `sort=paid_amount|fee|coupon_burden|refund_rate`(기본 `paid_amount`)·`order=desc|asc`·`cursor`·`limit=50`
```json
{ "items": [ { "academyId": "…", "name": "라틴하우스 강남", "paidAmount": 6420000, "feeIncome": 12000, "couponBurden": 310000, "refundRate": 3.2, "feeExempt": true } ],
  "totalCount": 128, "nextCursor": "…" }
```
상세
```json
{ "academyId": "…", "name": "라틴하우스 강남", "period": {…},
  "fee": { "exempt": true, "exemptUntil": "2027-10-02", "privateLessonRateBp": 100, "privateLessonExempt": false, "note": "개인 레슨 1%는 강사 가입일부터 1년 면제 뒤 내요(2026-11-23 변경 — 이전: 면제 없이 내요)" },
  "settlementStages": { "hold": { "amount": 0, "count": 0 }, "scheduled": { "amount": 5310000, "count": 38, "payoutDate": "2026-12-05" }, "completed": { "amount": 4960000, "count": 35, "label": "10월분" } },
  "byClass": [ { "classId": "…", "title": "바차타 센슈얼 입문", "paidAmount": 2380000 } ], "byInstructor": [ { "instructorAccountId": "…", "displayName": "이준호", "paidAmount": 3240000 } ],
  "ownerBorne": { "couponAndBenefit": { "amount": 310000, "ratioPct": 4.8 }, "cardFee": { "amount": 190000, "ratioPct": 3.0 }, "usageFee": { "amount": 12000, "note": "개인 레슨 1%, 일반 수업·행사분은 면제 중" } } }
```
정산 단계 이름(`hold`·`scheduled`·`completed`)은 FR-128 의 보류·예정·완료다(「지급 보류」와 다른 말 — I-06). 수업 수는 많아서 상위 N 과 「그 밖」으로 묶는다(`byClass`·`byInstructor` 최대 10줄 + `other`, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 학원이 없으면 404, 입점 전·거절된 신청의 학원은 목록에 없다.

### 4-5. P4 상품·결제수단·지역 — `GET /api/admin/console/breakdowns?tab=product|payment_method|region`

`tab` 이 없으면 셋 모두 준다(P4 화면이 한 번에 요약 카드를 그리기 때문). 200
```json
{ "period": {…},
  "product": { "rows": [ { "kind": "regular", "label": "정규", "paidAmount": 13600000, "count": 64, "avgPayment": 212500, "refundRate": 3.0, "feeRateBp": 500, "feeNote": "면제 제외", "feeIncome": 520000 },
                         { "kind": "private_lesson", "label": "개인 레슨", "paidAmount": 21100000, "count": 128, "avgPayment": 164844, "refundRate": 3.3, "feeRateBp": 100, "feeNote": "면제 없음", "feeIncome": 211000 } ],
               "total": { "paidAmount": 48200000, "count": 412 } },
  "paymentMethod": { "rows": [ { "method": "card", "label": "카드", "paidAmount": 37200000, "count": 301, "cost": 1040000, "costNote": "2.8%" },
                               { "method": "easy_transfer", "label": "간편 계좌이체", "paidAmount": 8100000, "count": 78, "cost": 31000, "costNote": "0.4%" },
                               { "method": "virtual_account", "label": "가상계좌", "paidAmount": 2900000, "count": 33, "cost": 9000, "costNote": "건당 약 270원" } ] },
  "region": { "top": [ { "sido": "서울", "gu": "강남구", "paidAmount": 11600000, "sharePct": 24.1 } ], "totalRegions": 18 } }
```
상품 종류 값은 `classes.class_kind`(§4.1)를 보드의 묶음으로 모은다 — `regular`→정규, 단기(M2 가 정의하는 기간 과정 구분)·`one_day`→원데이·`private_lesson`·`event`→이벤트·`party`→파티. `performance`·`competition` 은 `event` 줄에 합친다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 열린 점 ⑭). 수단 값은 `payments.method` 와 간편 계좌이체 구분(M3 S3-3 이 수단 4종을 정의 — 열린 점 ⑭). 합계 검산(수용 ①): 세 탭 모두 합 = 전체 결제액.

### 4-6. P5 전체 결산표 — `GET /api/admin/console/ledger-summary?month=2026-11`

월 단위(기본 지난달, 이번 달은 「마감 전」). 200
```json
{ "month": "2026-11", "asOf": "2026-12-01T03:00:00Z", "close": { "status": "open", "settlementDate": "2026-12-05", "closedAt": null },
  "lines": [
    { "key": "paid_total",      "label": "총 결제액", "amount": 48200000, "note": "결제 412건" },
    { "key": "refund",          "label": "환불", "amount": -1640000, "note": "환불률 3.4%" },
    { "key": "net_paid",        "label": "순결제액", "amount": 46560000, "subtotal": true },
    { "key": "owner_discount",  "label": "대표 부담 · 쿠폰·할인 차액", "amount": -1120000, "note": "대학생 혜택 포함 · 1+1 쿠폰은 금액 없음" },
    { "key": "platform_fee",    "label": "플랫폼 이용 수수료", "amount": -1210000, "note": "순결제액 기준",
      "children": [ { "key": "fee_general", "label": "일반 수업·행사 5%", "amount": -999000 }, { "key": "fee_private_lesson", "label": "개인 레슨 1%", "amount": -211000 }, { "key": "fee_exempt", "label": "입점 1년 면제분 0%", "amount": 0 } ] },
    { "key": "card_pg_fee",     "label": "카드·PG 수수료", "amount": -1080000 },
    { "key": "academy_payout",  "label": "학원 지급액", "amount": 43150000, "subtotal": true, "note": "학원 정산 3단계 중 지급 예정·보류의 합" },
    { "key": "instructor_share","label": "그중 강사 몫", "amount": 32200000, "note": "학원 수업분 12,400,000원 + 개인 레슨분 19,800,000원",
      "children": [ { "key": "instructor_class", "amount": 12400000 }, { "key": "instructor_private", "amount": 19800000 } ] } ],
  "platformProfit": { "available": false, "availableFrom": "S6-1", "lines": [] },
  "check": { "formula": "46560000 - 1120000 - 1210000 - 1080000", "expected": 43150000, "ledgerTotal": 43150000, "status": "match" } }
```
- **D5**: 학원 지급액까지의 흐름과 합계 검산만 보인다. 멤버십 수입·연 멤버십 할인·멤버십 환불 PG 수수료와 「플랫폼 손익」 줄은 `platformProfit.available:false`(FR-310 베타 범위). 환불·할인·수수료 줄의 부호는 응답에서 음수로 내린다(표는 위에서 아래로 더하면 `academy_payout` 이 나오는 순서)
- 합계 검산: `check.status` 가 `match`·`mismatch`. 검산은 4개 줄의 합이 학원 지급액과 1원도 다르지 않고 M5 의 원장 합계와도 같아야 `match`(S7-4 수용 ①, SC-010b). `mismatch` 면 어긋난 금액을 `check.diff` 로 준다
- 월 마감(FR-319): `close.status`=`open`·`closed`. 마감된 달의 숫자는 이후 환불·조정이 생겨도 바뀌지 않고 다음 달 `adjustment` 줄로 나타난다(마감 처리 자체는 M5 S5-4)
- 쿼리 `month` 가 형식이 아니면 422 `VALIDATION_FAILED`, 미래 달이면 400 `INVALID_PERIOD`

### 4-7. P6 지급 현황 — `GET /api/admin/console/payouts?month=2026-11`

```json
{ "month": "2026-11", "asOf": "…Z",
  "scheduled": { "amount": 41320000, "academyCount": 123, "payoutDate": "2026-12-05" },
  "completed": { "amount": 39870000, "academyCount": 121, "payoutDate": "2026-11-05", "month": "2026-10" },
  "hold": { "amount": 1830000, "academyCount": 5 },
  "instructorTotal": { "amount": 32200000, "classPortion": 12400000, "privateLessonPortion": 19800000 },
  "nextSettlement": { "date": "2026-12-05", "weekday": "토", "approvalDeadline": "2026-12-11", "approvalRule": "정산일 뒤 5영업일 · 주말과 공휴일은 뺀다" },
  "holdReasons": [ { "reason": "business_closed", "label": "사업자 휴·폐업 감지", "academyCount": 2, "amount": 760000, "sharePct": 42 },
                   { "reason": "holder_unverified", "label": "예금주(계좌) 확인 대기", "academyCount": 2, "amount": 650000, "sharePct": 36 },
                   { "reason": "chargeback", "label": "차지백(결제 분쟁) 진행 중", "academyCount": 1, "amount": 420000, "sharePct": 23 } ] }
```
정산일은 **매월 5일 날짜 그대로**(옮기지 않음, Q35). 승인 기한만 영업일로 센다(`approvalDeadline` 은 M5 의 영업일 함수 + P9 공휴일 표). `holdReasons.reason` 값은 M5 의 지급 보류 사유 코드를 따른다 — 이 파일은 `business_closed`·`holder_unverified`·`chargeback` 세 값을 쓰고 M5 가 더하면 그대로 늘어난다(열린 점 ⑭). 막힘 해소 화면 안내: 휴·폐업은 P11, 계좌 확인 대기는 P10 에서 푼다.

### 4-8. P7 수수료 근거 — `GET /api/admin/console/fee-evidence`

```json
{ "period": {…},
  "value": { "rows": [ { "academyId": "…", "name": "라틴하우스 강남", "newMembers": 38, "newMembersPaid": 4560000, "repurchaseRate30d": 64, "exposureToPaymentRate": 6.8 } ] },
  "burden": { "rows": [ { "academyId": "…", "name": "라틴하우스 강남", "paidAmount": 9100000, "couponBenefitDiff": 230000, "cardFee": 290000, "burdenRatePct": 5.7 } ] },
  "sizeBands": { "bands": [ { "key": "lt_1m", "label": "100만원 미만", "academyCount": 41, "feeIncome": 90000 }, { "key": "1m_5m", "label": "100~500만원", "academyCount": 62, "feeIncome": 520000 }, { "key": "gte_5m", "label": "500만원 이상", "academyCount": 25, "feeIncome": 600000 } ],
                 "total": { "academyCount": 128, "feeIncome": 1210000 }, "note": "면제 중인 학원은 수수료 수입을 0원으로 셈한다" } }
```
- 「처음 온 회원」은 그 학원 수업을 이 앱으로 **처음 결제한** 회원 수다(P7 보드 문구). 재결제율은 SC-021(30일 재결제)과 같은 정의 — 정의의 원본은 spec SC-021 이고 이 응답은 `repurchaseRate30d` 로 그 값을 쓴다. `exposureToPaymentRate`(검색·추천 노출에서 결제로 이어진 비율)는 **노출 기록이 있어야** 계산된다 — 노출 로그는 M3 검색·M6 순위판(FR-121f)이 만드는 값이라 없으면 `null`(열린 점 ⑯)
- 학원 목록은 `cursor`·`limit` 로 끊는다(`nextCursor`). 구간 경계는 월 결제액 **기준 달**(기간의 마지막 달)의 값이고 경계 값은 하한 포함·상한 미포함(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))
- 수수료율을 학원마다 달리 매기는 근거가 아니라 **분류별 한 벌**을 정하는 근거다(FR-312, D4)

### 4-9. P8 수수료율·모의 계산 — FR-314 · FR-316

`GET /api/admin/console/fee-rates` 200
```json
{ "current": [ { "feeCategory": "general", "label": "일반 수업 · 행사", "rateBp": 500, "onboardingExemptionApplies": true, "effectiveFrom": "2026-09-01T00:00:00Z" },
               { "feeCategory": "private_lesson", "label": "개인 레슨", "rateBp": 100, "onboardingExemptionApplies": false, "effectiveFrom": "2026-09-01T00:00:00Z" } ],
  "scheduled": [ { "feeCategory": "general", "rateBp": 600, "effectiveFrom": "2027-01-05T00:00:00Z", "createdAt": "…Z", "noticedAcademies": 128 } ],
  "academyExceptionCount": 0,
  "history": [ { "feeCategory": "general", "fromBp": 500, "toBp": 600, "effectiveFrom": "2027-01-05T00:00:00Z", "changedAt": "…Z", "changedBy": "운영자" } ] }
```
`academyExceptionCount` 는 항상 0 이다(학원별 예외 기능이 없다, D4 — 보드 「학원마다 다르게 정하는 기능은 없어요」). `history` 는 감사 기록 `platform_fee_rate.changed` 에서 만든다(「수수료율 바꾼 기록」 버튼).

`POST /api/admin/console/fee-rates/simulate` — 저장하지 않는다(「실제 정산에는 적용되지 않아요」)
```json
{ "rates": [ { "feeCategory": "general", "rateBp": 600 }, { "feeCategory": "private_lesson", "rateBp": 150 } ], "from": "2026-11-01", "to": "2026-11-30" }
```
→ 200
```json
{ "platformIncome": { "simulated": 1470000, "current": 1210000, "delta": 260000 },
  "academyPayout": { "simulated": 42890000, "current": 43150000, "delta": -260000 },
  "perAcademy": [ { "academyId": "…", "name": "라틴하우스 강남", "delta": -12000, "exempt": true }, { "academyId": null, "name": "그 밖 124곳", "delta": -103000 } ] }
```
선택한 기간의 **실제 거래**(결제 시점 면제·분류 그대로)에 새 비율을 대어 다시 계산한다. 면제 중인 학원의 일반 수업·행사분은 새 비율이어도 0 이다(FR-124). 비율 범위 밖(0~10000 bp 밖)이면 422 `VALIDATION_FAILED`, 기간이 미래면 400 `INVALID_PERIOD`.

`POST /api/admin/console/fee-rates` · `Idempotency-Key`
```json
{ "feeCategory": "general", "rateBp": 600, "effectiveFrom": "2027-01-05" }
```
→ 201 `{ "feeRateId", "feeCategory", "rateBp", "effectiveFrom", "noticedAcademies": 128, "termsVersionId": "…" }`
- **적용 시작일은 오늘부터 30일 이후 날짜만**(FR-316 · FR-259, 2026-11-20 사용자 결정 D17 — 이전: 오늘 이후(미래) 날짜만) — 오늘·과거면 422 `EFFECTIVE_DATE_NOT_FUTURE`, 시작일이 지금+30일보다 앞서면 422 `NOTICE_PERIOD_TOO_SHORT`(07 `POST /api/admin/terms-versions` 와 같은 규칙). 화면은 30일 이전 날짜를 아예 고를 수 없게 한다. 저장하면 모든 대표에게 개별 통지한다. 보드 P8 문구는 「오늘 이후 날짜만 골라요」에서 「오늘부터 30일 이후 날짜만 골라요」로 고친다(보드 수정은 Penpot 작업이 맡는다)
- 한 트랜잭션: `platform_fee_rates` 새 행(`effective_from` = 시작일 0시 KST) · `terms_versions`(`kind='platform_fee_notice'`, 입점 약관 변경과 같은 판본 관리, 07 의 발행 경로와 같은 함수) · 입점 중인 모든 학원에 `terms_change_notices` 1행 + 알림 `fee_rate_change_notice`(대표, category `operations`, `dedupe_key=feerate:<id>:<academyId>`) · 감사 `platform_fee_rate.changed`(전·후 값). 같은 분류·같은 시작일은 409 `FEE_RATE_EXISTS`
- 지난 주문은 영향이 없다 — `orders.platform_fee_rate_bp` 가 결제 시점 값으로 고정돼 있다(03 §6-2, FR-284·FR-245, S7-4 수용 ③)
- 입점 1년 면제가 남은 학원에는 면제가 끝난 날부터 적용된다(FR-316) — 계산은 M5 가 `onboarding_exemption_applies` 와 `platform_fee_exempt_until` 로 한다

| HTTP | code | 언제 |
|---|---|---|
| 409 | `FEE_RATE_EXISTS` | 같은 분류·같은 시작일이 이미 있음 |
| 422 | `EFFECTIVE_DATE_NOT_FUTURE` · `NOTICE_PERIOD_TOO_SHORT` · `VALIDATION_FAILED` | 위 |

### 4-10. 엑셀(xlsx) 내보내기 — FR-317

`GET /api/admin/console/exports/{screen}` — `screen` = `dashboard`·`academies`·`breakdowns`·`ledger-summary`·`payouts`·`fee-evidence`. 쿼리는 해당 화면과 같다. 응답 `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`(2026-11-24 변경 — 이전: CSV `text/csv`+BOM), `Content-Disposition: attachment; filename="platform-genres-2026-11.xlsx"`. 첫 줄 다음 `# 기준 시각 …`·`# 기간 …` 주석 줄 둘을 붙인다(엑셀에서는 첫 시트 상단 두 줄)(FR-319). 화면 JSON 과 같은 함수에서 만들어 숫자가 어긋나지 않게 한다. 개인정보가 없다(S7-4 수용 ②를 엑셀에도 건다). 감사 `console.exported`. 알 수 없는 `screen` 은 404.

- **엑셀 구현 규칙**(2026-11-24 확정): 금액은 숫자 칸으로, 주문 번호는 글자 칸으로 넣는다(앞자리 0 보존). 회원 연락처는 넣지 않는다. 엑셀 파일을 만드는 라이브러리는 정하지 않았다 — 구현 Task 에서 고른다(설치 승인 필요).

### 4-11 ~ 4-13. P9 공휴일 · P10 예금주 확인 · P11 사업자 점검 — `13-settlement.md` §10 으로 옮김

2026-11-20 통합: 이 세 화면의 운영자 경로(11개)·요청·응답·오류는 `13-settlement.md` §10 한 곳에 둔다(정산 영역). 이 파일에는 대표가 소명을 내는 경로(§2-8)와 이용 제한 절차(`restriction_cases`)만 남는다. 콘솔 공통 규칙(§4-1)은 그 세 화면에도 그대로 걸린다.

### 4-14. 점검·결제 중단·앱 버전 — FR-022b · 보드 C20A · C20B · C32D · C33A · O36 · O36B

`GET /api/system/status?platform=android&appVersion=1.0.0` — 로그인 없이(앱이 켜질 때·결제 화면에 들어갈 때). 200
```json
{ "maintenance": { "active": true, "kind": "maintenance", "startsAt": "2026-11-11T17:00:00Z", "endsAt": "2026-11-11T19:00:00Z",
                   "message": "시스템 점검 중이에요", "paymentBlocked": true, "notice": null },
  "update": { "level": "required", "minVersion": "1.2.0", "latestVersion": "1.2.0", "yourVersion": "1.0.0", "remindAfterDays": null } }
```
- `maintenance.kind`: `maintenance`(예고된 시스템 점검, C20A) · `pg_outage`(PG 장애, C33A·O36). 활성이 아니면 `{ "active": false, "upcoming": { "startsAt", "endsAt" } | null }` — **하루 전** 알림 공지와 맞춰 앱이 미리 띠를 보일 수 있다
- `update.level`: `none` · `optional`(새 버전이 있지만 지금 버전도 쓸 수 있음, C32D — 「나중에」를 누르면 **7일 뒤** 다시, `remindAfterDays:7` 는 앱이 저장 · 값은 `ops_settings`) · `required`(지원 중단 — C20B, 앱 전체를 막고 스토어로 보낸다). 버전은 `major.minor.patch` 를 숫자로 비교한다(순수 함수 `compareAppVersion`, `1.10.0 > 1.9.0`). `appVersion` 이 형식이 아니면 `level:"none"`(차단하지 않는다 — 열린 점 ⑳)
- 이 경로는 가볍고 캐시 가능하다(`Cache-Control: max-age=30`, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)). 점검 중에도 응답한다

`GET /api/admin/maintenance-windows?status=` · `POST /api/admin/maintenance-windows` · 헤더 `Idempotency-Key`
```json
{ "kind": "maintenance", "startsAt": "2026-11-11T17:00:00Z", "endsAt": "2026-11-11T19:00:00Z", "message": "시스템 점검 중이에요" }
```
→ 201 `{ "windowId", "status": "scheduled", "noticeAt": "2026-11-10T17:00:00Z" }`. 시작 시각이 지금보다 앞이면 곧바로 `active`. `kind:"pg_outage"` 는 `startsAt` 을 지금으로 하고 `endsAt` 없이 연다(장애는 끝나는 시각을 모른다, `endsAt:null`) — 이때 모든 대표에게 알림 `pg_outage_started`(O36, category `operations`)와 입금 대기 주문의 대표·회원 안내를 쓴다.
- **점검 하루 전 알림**: 내부 작업이 `noticeAt`(시작 24시간 전)에 모든 활성 회원·직원에게 알림 `maintenance_notice`(`class=transactional`)를 한 번 쓴다 — `POST /api/internal/jobs/notifications/dispatch` 가 보낸다(작업 하나를 더 만들지 않고 `maintenance_windows.notice_sent_at` 조건부 갱신을 `dispatch` 앞단에서 처리, 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))
- **활성 중 결제 시작 거부**: `POST /api/orders`(03) 가 503 `MAINTENANCE_ACTIVE`(본문 `{ window: { kind, startsAt, endsAt, message } }`)를 낸다. 읽기 경로·이미 확정된 결제·웹훅은 막지 않는다(이미 한 결제·예약은 그대로, 웹훅은 계속 받는다)
`POST /api/admin/maintenance-windows/{windowId}/end` → 200 `{ "status": "ended", "extendedSeconds": 7200, "extendedOrders": 2 }`. 점검이든 PG 장애든 **멈춘 시간만큼** 입금 대기(`payments.status='ready'`) 주문의 `due_at` 을 늘린다(C20A 「점검 시간만큼」·C33A 「장애 시간만큼」: 18:00 → 20:00). 한 트랜잭션: 창 `ended` · `payments.due_at += duration` 조건부 갱신 · `order_events` 에 사유 `maintenance_extended`(상태 전이 아님, 03 §4-1 의 사유 행) · 회원·대표 알림(`payment_deadline_extended`, `pg_outage_recovered` — O36B 복구 시각·멈춘 시간·늘어난 기한). 환불 요청 처리는 이 창 동안 쌓이다가 이어서 한다(O36B). 이미 끝났으면 200 같은 본문(`extendedSeconds` 같은 값). 정해진 `endsAt` 이 있는 점검은 그 시각이 지나면 작업이 같은 처리를 한다 — `POST /api/internal/jobs/notifications/dispatch` 와 별개로 `ops-alerts/scan` 이 끝난 창을 닫는다(아래).
- 만료 정리 작업(03)은 창이 활성인 동안 `ready` 주문을 만료시키지 않는다(한 줄 조건 — 기한을 늘릴 주문이 먼저 만료되지 않게). 03 의 정리 작업에 조건을 더하는 일은 M3 와 조율한다(열린 점 ⑧)

`GET /api/admin/app-version-policies` → `{ "items": [ { "policyId", "platform": "android", "minSupportedVersion": "1.2.0", "latestVersion": "1.3.0", "effectiveFrom": "…Z", "createdAt" } ] }`. `POST /api/admin/app-version-policies` `{ "platform": "android", "minSupportedVersion": "1.2.0", "latestVersion": "1.3.0", "effectiveFrom": "2026-11-12T00:00:00Z" }` → 201. `minSupportedVersion > latestVersion` 이면 422 `VERSION_RANGE_INVALID`. 같은 플랫폼·`effectiveFrom` 이면 409 `POLICY_EXISTS`. 감사 `app_version_policy.changed`. 현재 정책 = `effective_from <= now()` 가운데 가장 늦은 행.

### 4-15. 운영자 경보 3종·오류 기록 — S7-4 수용 ⑥·⑦

서버 오류 기록(S7-4.6)은 **경로가 없다** — 요청 id·경로·역할과 함께 서버 로그로 가고 이름·연락처·계좌번호·키는 가리는 순수 함수(`redactForLog`)를 지난다(SP-9 결론, 외부 서비스 없음).

`POST /api/internal/jobs/ops-alerts/scan` → 200 `{ "created": 1, "windowsClosed": 0 }` — 1분마다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)) 아래 사건을 감지해 모든 `admin` 계정에 직원 알림(category `operations`, `class=transactional`, `dedupe_key` 로 같은 사건 한 번)을 쓴다. 기준 값은 `ops_settings`(PRD 9-4 추천값):

| 사건 | kind | 감지 | dedupe_key |
|---|---|---|---|
| 웹훅 서명 실패 | `ops_alert_webhook_signature` | `payment_webhook_events.result='rejected_signature'` 1건 | `sig:<webhookEventId>` |
| 10분 넘는 웹훅 미수신 | `ops_alert_webhook_silence` | 마지막 웹훅 수신이 10분을 넘었고 그 사이 `ready` 결제가 있다 | `silence:<마지막 수신 시각을 10분 단위로 내림>` |
| 대사 불일치 1건 | `ops_alert_reconciliation_mismatch` | M5 대사 결과의 불일치 행 | `recon:<resultId>` |
| 환불 실패 1건 | `ops_alert_refund_failed` | `refunds.status='failed'` | `refund:<refundId>` |

알림은 알림함(10 §2 `GET /api/staff/notifications`)에서 운영자가 본다 — 새 조회 경로를 만들지 않는다. 같은 작업이 끝난 `maintenance_windows`(예정 `endsAt` 경과)를 닫는다.

### 4-16. 감사 기록 조회 — FR-185 · FR-198 · S7-4.1

`GET /api/admin/audit-logs?from=&to=&action=&actorStaffAccountId=&academyId=&targetTable=&targetId=&cursor=&limit=50` 200
```json
{ "items": [ { "id": "…", "occurredAt": "…Z", "actorKind": "staff", "actorRole": "admin", "actorLabel": "운영자", "academyId": null,
               "action": "platform_fee_rate.changed", "targetTable": "platform_fee_rates", "targetId": "…",
               "before": { "rateBp": 500 }, "after": { "rateBp": 600 }, "reason": null, "requestId": "…" } ], "nextCursor": null }
```
읽기만 있다 — **수정·삭제 경로가 없다**(`POST`·`PUT`·`PATCH`·`DELETE` 가 `/api/admin/audit-logs` 에 없고 DB 트리거도 막는다, 데이터 §7-7). `before`·`after` 에 이미 가린 값만 들어 있다. 수강생 개인정보는 감사 기록에도 넣지 않는다 — 회원 대상 행의 `before`·`after` 는 가린 값. 이 조회도 `console.viewed` 를 남긴다. 필터가 하나도 없으면 최근 7일(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))만.

### 4-17. 운영자 콘솔 수용 시나리오

1. **Given** 기간 11월 **When** P4·P5 합계를 비교 **Then** 상품 탭 합 = 결제수단 탭 합 = 총 결제액 = 원장 합(원 단위, 수용 ①)
2. **Given** 콘솔 모든 `GET` 응답 **When** JSON 키를 훑는다 **Then** `phone`·`birthDate`·수강생 이름 키가 없다(수용 ②). 엑셀도 같다
3. **Given** 수수료율 일반 5% **When** `POST …/fee-rates {general, 600, 지금+10일}` **Then** 422 `NOTICE_PERIOD_TOO_SHORT`; 지금+40일이면 201, 128곳 알림, 지난 주문의 `platform_fee_rate_bp` 는 그대로(수용 ③)
4. **Given** 점검 창 활성 **When** `POST /api/orders` **Then** 503 `MAINTENANCE_ACTIVE`, 기존 예약 조회는 200. 창을 끝내면 입금 대기 주문의 `due_at` 이 멈춘 시간만큼 늘어난다(수용 ④)
5. **Given** 최소 버전 1.2.0 **When** `GET /api/system/status?appVersion=1.0.0` **Then** `update.level:"required"`; `1.10.0` 은 `none`(수용 ⑤)
6. **Given** 서명이 틀린 웹훅 1건 **When** `ops-alerts/scan` 을 두 번 **Then** 운영자 알림 1건
7. **Given** 위임 강사·대표 **When** 콘솔 `GET` **Then** 403 `FORBIDDEN`
8. **Given** P10 대기 줄 **When** `confirm {nameMatches:false}` **Then** 422, 확인 전 계좌로는 M5 지급 대상에서 빠진다
9. **Given** P9 자동 수집 줄 **When** `PATCH`·`DELETE` **Then** 409 `HOLIDAY_NOT_EDITABLE`
10. **Given** 폐업 감지 학원 **When** 대표가 소명을 내고 운영자가 `accept-explanation` **Then** `new_sales_blocked`·`payout_hold` 행에 `ended_at`, 감사 `restriction.lifted`

---

## 5. Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | `isQuietHour`(20:59·21:00·07:59·08:00) · 영업일 1일 뒤 `first_response_due_at`(금요일 접수·공휴일 낀 경우) · `compareAppVersion`(`1.10.0` > `1.9.0`) · 만 19세 경계(생일 전날·당일) · 재동의 가드 판정(`findBlockingTerms`) · 수수료 모의 계산(면제 학원의 일반 수업은 새 비율이어도 0) · `redactForLog` · 알림 `class` 분류 판정 |
| DB | `ck_notifications_class`·`ck_inquiries_target`(학원 문의는 `academy_id` 필수) · `uq_reports_open` · `uq_withdrawals_active` · `uq_children_guardian_identity` · `uq_app_version_policy` · 감사 기록 트리거(UPDATE·DELETE 거부, §7-7) · `ck_restriction_subject`(대상 칸이 종류와 짝) |
| 통합 | 시나리오 §1-5·§2-9·§3-6·§4-17 전부 · 문의 학원 격리(A 대표→B 403, 운영자→학원 문의 403) · 탈퇴 입금 대기 자동 취소 · 점검 종료 시 기한 연장 · 엑셀과 JSON 숫자 일치 · P10 확인 전 계좌 지급 제외(M5 와 합동) |
| 계약 린터 | `api_contract_lint.py --contract 15-ops.md` — 구현이 생기면 MISSING 0 · 본문을 받는 POST·PUT·PATCH 의 zod 검사 |
| E2E(Playwright) | 운영자 P1→P5 이동·합계 일치 표시 · P9 공휴일 더하기 · P10 확인 · P11 소명 처리 · 회원 C10A 재동의 후 결제 진행 |

## 열린 점

| # | 무엇 | 추천값 — 2026-11-20 사용자 결정 D20: 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」 |
|---|---|---|
| ① | 수업 전 알림 시점 `preClassLead` 가 하나만 고르는지 여러 개 고르는지 — FR-140 은 「고르도록」, 보드 C1A 는 「한 번 알려요」 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 하나만 고른다, 기본 1시간 전. 여럿이 필요하면 값을 배열로 바꾼다 |
| ② | 광고성 알림을 끄면 쿠폰 소멸 안내(FR-123a)도 멈추는지 — C1A 하단 문구는 「쿠폰·학원 소식 알림도 함께 멈춰요」이고 쿠폰 알림 줄에는 별도 토글이 있다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 문구대로 광고성 전체가 꺼지면 쿠폰·학원 소식은 안 보낸다. 쿠폰 소멸 안내는 `class=marketing` 으로 둔다(동의 없는 회원에게 쿠폰 홍보가 가지 않게) |
| ③ | 발송 재시도 횟수·간격 — FR-144 에 값이 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 3회(처음 포함), 1분·5분 간격. `ops_settings` 로 둔다 |
| ④ | 1영업일 넘긴 문의의 두 번째 재알림 — 학원이 계속 안 답할 때 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 영업일 3일마다 반복하되 운영자가 대신 답하지 않는다(FR-204). 값은 spec 에 없어 사후 확인 |
| ⑤ | Q21(1영업일) 임시 확정 — 응대 시간 밖 접수 안내 문구(FR-231) | 임시 확정 그대로. 화면 문구는 앱이 정한다 |
| ⑥ | I16 의 「관련 정산」 선택(월·수업·환불 N건 줄)이 가리키는 M5 의 정산 줄 id | M5 와 조율 — 지금은 `related_settlement_ref uuid NULL`(FK 없음) |
| ⑦ | ~~영업일 계산 함수와 공휴일 표의 소유~~ | **2026-11-20 통합으로 닫음** — 표 S0-4.7 · 함수 S0-4.8 · 수집 S0-4.10(M0), 정의는 data-model §10-13. 문의·승인 기한·P10 이 같은 함수를 쓴다 |
| ⑧ | 다른 마일스톤에 걸치는 변경 — `orders` 의 자녀 수강(`attendee_child_id`)·`cancel_reason='withdrawal'`·점검 중 만료 정리 제외·`POST /api/orders` 의 두 오류 | M3 와 조율(0-1 표). 이 파일은 요구만 적는다 |
| ⑨ | 학원별 소리·무음·끔(C22A) 설정 경로 | M3(학원 구독, FR-023a)가 소유. 발송기는 읽기만 한다 |
| ⑩ | 신고 가능한 조합 — FR-188 은 「회원이 학원·강사·수업·회원을 신고, 강사·대표도 회원을 신고」라고만 적었다. 회원 → 회원 신고가 되는지, 강사 → 학원 신고가 되는지 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 회원: 학원·강사·수업·회원 모두 / 강사·대표: 회원만. 어긋나면 403 |
| ⑪ | 개인정보 처리정지의 범위와 처리·통지 법정 기한(10일은 추천값, 법률 확인 필요) | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 처리정지 = 광고성 알림·학원 제공 외 추가 처리 중단 + 로그인 유지. 운영자 수동 처리 |
| ⑫ | 자녀 — 보드 C6A 제목 「만 14세 미만」과 문구 「만 19세 미만」이 다르다 / 보호자당 자녀 수 상한 / 만 19세가 된 뒤 본인 계정으로 넘어가는 방법(Q29) | 계약은 만 19세 미만(FR-009a, 사용자 지시). 보드 C6A 제목 수정 필요. 상한 없음임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인). 전환 방법은 정해진 게 없어 표시·알림까지만 |
| ⑬ | 콘솔 조회 기록의 granularity — FR-302 는 「무엇을 조회했는지 감사 기록」이라고만 한다. `audit_logs.target_id` 가 uuid 고정이라 화면 이름을 못 담는다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 화면별 고정 UUID(UUIDv5) 를 `target_id` 로 쓰고 화면 이름·필터는 `after` 에. 같은 사람·화면 1분 내 중복은 합친다 |
| ⑭ | P 화면이 읽는 값의 이름(원장 줄 종류·정산 단계·지급 보류 사유·수단 4종·상품 구분) | M5·M2·M3 와 조율. 이 계약의 값은 보드 문구를 따른 가칭 |
| ⑮ | P1 의 「활성 회원」·「입점 학원」 정의, 「면제가 없었다면 받았을 수수료」(FR-304)는 보드에 없다 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 활성 회원 = 기간 안에 결제·신청·예약 활동이 있는 회원. 면제 효과는 보드 P1 에 카드가 생길 때 추가 |
| ⑯ | 노출 → 결제 비율(P7)의 노출 로그 소유 | 노출 기록이 없으면 `null`. 검색·추천 노출 로그는 M3(검색)·M6(순위판 FR-121f)과 조율 |
| ⑰ | ~~수수료율 적용 시작일의 최소 간격 — 보드는 「오늘 이후」, FR-316·FR-259 는 「30일 전 통지」~~ | **→ 2026-11-20 사용자 결정 D17 로 확정** — 오늘+30일 이후 날짜만 고를 수 있고 저장하면 모든 대표에게 개별 통지. 보드 P8 문구를 고친다 |
| ⑱ | 자동 수집과 운영자 입력이 같은 날짜일 때 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 자동 값 우선, 운영자 입력은 보존 |
| ⑲ | ~~P10 의 강사 계좌 테이블·칸이 academy 계좌와 같은 모양인지~~ | **2026-11-20 통합으로 닫음** — 두 표 모두 `verification_status` 4종(data-model §10-5). 경로는 `13-settlement.md` §10-2 |
| ⑳ | `GET /api/system/status` 가 버전 형식이 이상할 때 차단하는지 | 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) 차단하지 않고 `none` — 잘못된 헤더가 사용자를 가두지 않게 한다 |
| ㉑ | 보드 라벨 어긋남 — 로드맵 Task `S7-3.9b` 는 「C11A·C11B 개인정보 권리·계정 복구」로 적혔으나 보드 C11A 는 **신고하기**, C11B 는 **탈퇴하기**, 개인정보 열람·정정은 **C21A**, 계정 복구 화면 보드는 **없다**. 문의 첨부·신고 처리 운영자 화면 보드도 없다 | 이 계약은 보드 이름을 따랐다. 로드맵 Task 문구 수정과 계정 복구·운영자 신고함 보드는 사용자 결정 |
| ㉒ | 보드 I16 칩 줄에 「결석」이 칩이 아니라 하단 별도 글자로 놓여 있다 | D10 대로 칩 「정산 금액 근거 · 정원 · 결석 · 기타」로 정리(보드 수정 필요) |
| ㉓ | 월 마감(FR-319)·원장 대사 결과(FR-318)·강사 지급 보류 사유는 M5 가 소유 | P5·P6·P1 이 읽기만 한다 |
| ㉔ | ~~입점 해지(§3-7) 신청을 대표가 취소할 수 있나 — 보드 W26 에 취소 버튼이 없다~~ | **→ 2026-11-20 사용자 결정 D19 로 확정** — 신청 취소 없음(취소 경로를 두지 않는다) |
| ㉕ | ~~해지 뒤 돌려줄 돈이 남은 정산금보다 클 때 학원에 청구하는 방법~~ | **→ 2026-11-20 사용자 결정 D19 로 확정** — 회원 환불금은 남은 정산금에서 상계(13 의 `offset`, 사유 `termination_refund`)하고 모자라면 운영자가 대표에게 청구한다. 청구 화면·경로는 만들지 않는다 |
| ㉖ | ~~회사가 해지할 때(FR-256 둘째 문장)의 운영자 경로~~ | **→ 2026-11-20 사용자 결정 D19 로 확정** — 회사 해지는 이용 제한 절차(FR-254, §2-8 `listing_limit`)로 새 결제를 막고, 결제된 건 처리 방안은 운영 절차 문서(S7-4.8)로. 대표 신청 경로와 별개다 |
