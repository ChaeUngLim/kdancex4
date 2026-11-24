# API 계약 — 강사 초대·소속 신청 승인/거절·위임 권한·소속 해제 (S1-2(강사 소속·권한 위임·강의실))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §7-5. 관련 요구: FR-011(소속 승인 — **2026-11-19 결정 3: 초대 링크도 승인 대기**) · FR-071(소속 강사 관리) · FR-081(강사 권한 부여) · FR-081a(위임 가능한 관리 권한) · FR-082(소속 해제 처리) · FR-185(감사 기록) · Q33(강사 몫 비율 — **2026-11-19 결정 11로 확정**). 보드: W3a(강사 관리) · W3b·W3b2(소속 해제) · W23(위임 강사의 관리자 웹) · O5Q(소속 신청 휴대폰 알림) · O31·O33·O37·O38(대표 앱 강사 관리·권한) · W24(강사 몫 비율).

강의실 배정 주간표(W3c)와 다른 학원 「불가 시간」(FR-083)은 회차가 생기는 M2(S2-2) 계약으로 넘긴다 — 지금은 보여 줄 회차가 없다.

## 1. 초대 링크 — 권한 `owner`

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /api/academies/{academyId}/invites` | `{}` | 201 `{ "inviteId", "inviteUrl": "https://…/invite/<token>", "expiresAt" }` — 토큰 원문은 **이 응답에서 한 번만** 준다(저장은 해시) |
| `GET /api/academies/{academyId}/invites` | — | `{ items: [{ inviteId, createdAt, expiresAt, status: "active"\|"used"\|"expired"\|"revoked", usedBy: { displayName } \| null }] }` |
| `POST /api/academies/{academyId}/invites/{inviteId}/revoke` | — | 200. 이미 폐기·사용·만료면 409 `INVITE_NOT_ACTIVE` |

유효기간 7일·1회용은 **추천값**(FR-071 보완). 감사 `invite.created`·`invite.revoked`.

## 2. 강사 쪽 서버 경로(화면은 S2-1, 계약은 여기서 고정) — 권한 `instructor` 역할 + `surface='app'`

| 메서드·경로 | 설명 | 오류 |
|---|---|---|
| `POST /api/instructor/affiliations` | 소속 신청 `{ "academyId", "message": "주말 저녁 수업을 맡고 싶어요" }` → 201 `pending` | 409 `AFFILIATION_ALREADY_OPEN`(대기·소속 중) · 409 `ACADEMY_NOT_ACCEPTING`(학원이 `active` 아님) |
| `POST /api/instructor/invites/{token}/accept` | 초대 링크 받기 → 201 `pending`(`source: "invite"`) — **바로 소속하지 않는다**(결정 3) | 410 `INVITE_EXPIRED` · 409 `INVITE_ALREADY_USED` · 404 `NOT_FOUND`(없는 토큰) · 409 `AFFILIATION_ALREADY_OPEN` |
| `POST /api/instructor/affiliations/{id}/withdraw` | 대기 중 취소 → `withdrawn` | 409 `AFFILIATION_STATE_CONFLICT` |
| `GET /api/instructor/affiliations` | 학원별 상태 카드(I27B) — 거절이면 사유 코드·글. 카드마다 `calendarColorIndex`(0~11, 아직 색이 없으면 `null`) — I9E(학원 색)가 지금 고른 색으로 처음 상태를 그린다(2026-11-21 사용자 결정, S2-1.10). 카드마다 `canSubmitClass`(소속됨 + 앱 수업 등록 위임 `class_submit` 이면 true, 11 §3-1 학원 검색의 같은 칸과 같은 판정) — 강사 앱 수업 만들기(I2)·학원 탭(I12)·내 소속(I27B)이 이 값으로 「수업 등록 권한」을 본다. `staff/me` 는 웹 위임만 담기 때문이다(2026-11-23 사용자 결정, 실서버 시연에서 발견) | — |

두 생성 경로 모두 같은 트랜잭션에서 대표에게 알림 `affiliation_requested`(category `approval`, `dedupe_key = affiliation:<id>:requested`, payload: 강사 이름·활동 장르·한마디)를 쓴다. 휴대폰 발송(O5Q)은 커밋 뒤 `NotificationSenderPort`(S7-1 전까지 `pending`).

초대 수락은 한 문장 조건부 갱신(data-model §7-5)으로 토큰을 쓰고, 영향 0행이면 이유를 다시 읽어 410·409 를 가른다. 410 을 쓰는 이유: 만료는 「다시 시도해도 안 됨」이라 클라이언트가 재시도하지 않게.

## 3. 소속 목록·승인·거절 — 권한 `owner`

`GET /api/academies/{academyId}/affiliations?status=pending|active` (W3a · O37)
```json
{ "items": [ { "affiliationId": "…", "status": "pending", "source": "invite", "requestedAt": "…Z",
               "instructor": { "accountId": "…", "displayName": "아이유", "phoneMasked": "010-****-5678", "activityGenre": "salsa_bachata" },
               "message": "주말 저녁 수업을 맡고 싶어요", "isAcademyEmployee": false, "permissions": [] } ] }
```
연락처는 가린 값만 내린다(FR-187(연락처 마스킹)). 활동 장르는 강사 프로필(S2-1)이 생기기 전에는 `null`.

| 메서드·경로 | 요청 | 결과 |
|---|---|---|
| `POST /api/academies/{academyId}/affiliations/{id}/approve` | `{ "isAcademyEmployee": false, "shareRateBp": 6000 }` | `pending` → `active`. **프리랜서·사업자 강사면 `shareRateBp`(0~10000, 6000 = 60%) 필수** — 없으면 422 `SHARE_RATE_REQUIRED`(결정 11, 기본값 없음). `isAcademyEmployee=true` 면 `shareRateBp` 를 받지 않는다(보내면 422). 같은 트랜잭션에서 `instructor_share_rates` 첫 행(`effective_from` = 승인 시각). 이미 `active` 면 200 같은 본문. 다른 상태면 409 `AFFILIATION_STATE_CONFLICT`. 알림 `affiliation_approved`(강사, 비율 포함) · 감사 `affiliation.approved` |
| `POST /api/academies/{academyId}/affiliations/{id}/reject` | `{ "reasonCode": "genre_mismatch", "reasonText": null }` | `pending` → `rejected`. `reasonCode` 필수, `other` 면 `reasonText` 필수(**추천안**). 알림 `affiliation_rejected`(사유 포함) · 감사 |

승인은 `UPDATE … WHERE id=$1 AND academy_id=$2 AND status='pending'` 한 문장이 멱등의 근거다. 같은 강사가 두 대표 화면(웹·앱)에서 동시에 승인돼도 알림은 `dedupe_key = affiliation:<id>:approved` 로 1건이다.

## 4. 위임 권한 — 권한 `owner` (FR-081a · O38 · W3a 표)

`PUT /api/academies/{academyId}/affiliations/{id}/permissions`
```json
{ "permissions": ["roster_manage"] }
```
- 값: `roster_manage`(예약·명단 — 전체 수강생 조회 + 인원 관리) · `class_manage`(수업·포스터 등록 — 수업 등록과 취소) · `class_submit`(앱 수업 등록 권한, O31) (2026-11-20 사용자 결정 — 이전: `roster_view`·`class_manage`·`headcount_manage` 3값, O38 의 토글 2개에 맞췄다). 그 밖의 값 422 — 매출·정산·금액은 값 자체가 없다(FR-081a)
- 전체 교체(PUT). 소속이 `active` 가 아니면 409 `AFFILIATION_STATE_CONFLICT`
- 한 트랜잭션: 위임 행 교체 · 감사 `delegation.changed`(`before`·`after` = 권한 배열) · 알림 `delegation_changed`(강사에게, O38 「켜고 끄면 그 강사에게 알림이 가요」). 바뀐 게 없으면 감사·알림 없이 200
- 응답 200 `{ "affiliationId", "permissions": [...], "changedAt" }`
- **즉시 차단**: `requireStaff` 가 요청마다 이 표를 읽으므로 끈 다음 요청이 403 이다(S1-2 수용 ②). 이미 열려 있는 화면은 다음 데이터 요청에서 403 을 받고 403 화면으로 바뀐다(README §6-3)

`PUT /api/academies/{academyId}/affiliations/{id}/employment` `{ "isAcademyEmployee": true }` — 학원 직원 표시(O33 · W3a, FR-127). 정산에 영향이 있어 감사 `affiliation.employee_flag_changed`. 적용 시점(이후 결제분부터인지)은 S5-1(정산 원장) 이 정한다. 직원 표시를 **끌 때**는 `shareRateBp` 를 함께 받는다(없으면 422 `SHARE_RATE_REQUIRED`).

## 4-1. 강사 몫 비율 — 권한 `owner` (결정 11 · W24 · O33)

| 메서드·경로 | 요청 | 결과 |
|---|---|---|
| `GET /api/academies/{academyId}/affiliations/{id}/share-rates` | — | `{ "current": { "rateBp": 6000, "effectiveFrom" }, "history": [...], "overrides": [{ "classId", "classTitle", "rateBp", "effectiveFrom" }] }` |
| `PUT /api/academies/{academyId}/affiliations/{id}/share-rate` | `{ "rateBp": 5500, "baseRateEffectiveFrom": "…Z" }` | 새 행(`effective_from` = 서버 시각) — **바꾼 뒤 결제분부터**, 이미 계산한 지급액은 그대로. `baseRateEffectiveFrom` 이 최신 행과 다르면 409 `SHARE_RATE_CONFLICT`(두 화면 동시 수정 방지). 같은 값이면 200, 행·감사 없음. 감사 `share_rate.changed`(이전·새 값) · 알림 `share_rate_changed`(강사) |
| `PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId}` | `{ "rateBp": 7000 }` 또는 `{ "rateBp": null }`(예외 끄기 = 기본 비율로) | 수업별 예외, 개인 레슨 포함. 그 강사의 수업이 아니면 422. 수업이 생기는 M2 부터 쓴다. 감사·알림은 위와 같다 |

학원 직원 강사에게 비율 경로를 부르면 409 `EMPLOYEE_HAS_NO_SHARE_RATE`. 위임 강사는 비율을 볼 수도 바꿀 수도 없다(정산은 위임 대상 밖, FR-081a).

## 5. 소속 해제 — 권한 `owner`(대표 시작) · `instructor`(강사 시작, S2-1)

`POST /api/academies/{academyId}/affiliations/{id}/release` — 헤더 `Idempotency-Key`

| 조건 | 응답 |
|---|---|
| 소속 `active`, 이 강사의 이후 회차·남은 개인 레슨 0 | 200 `{ "status": "released", "releasedAt" }` · 위임 행 삭제 · 알림(강사) · 감사 `affiliation.released` |
| 이후 회차가 남음 | 409 `RELEASE_HAS_REMAINING_SESSIONS` + `{ "remainingSessions": 3 }` (S1-2 수용 ③) |
| 이미 `released` | 200 같은 본문 |

M1 에는 회차가 없어 항상 첫 줄로 간다. 회차별 대체·휴강·폐강 선택과 W3b2 의 「알림 N건 · 받는 회원 M명」 확인 창은 S2-3(대타·소속 해제)이 이 경로에 `sessionDecisions` 를 더해 완성한다 — 요청 모양을 미리 정해 두면: `{ "sessionDecisions": [ { "sessionId", "action": "substitute"\|"cancel_session"\|"close", "substituteAccountId": "…" } ], "ownerNote": "…" }`.

## 수용 시나리오

1. **Given** 대표가 만든 초대 링크 **When** 강사가 받는다 **Then** 소속은 `pending` 이고 대표 알림함에 `affiliation_requested` 1건, 대표가 비율(프리랜서·사업자)을 넣고 승인해야 `active`(결정 3·11). 비율 없이 승인하면 422 `SHARE_RATE_REQUIRED`
2. **Given** 한 번 쓴 초대 링크 **When** 다른 강사가 같은 링크를 받는다 **Then** 409 `INVITE_ALREADY_USED`, 소속 행이 생기지 않는다
3. **Given** `roster_manage` 를 받은 위임 강사가 관리자 웹 예약·명단을 쓰고 있다 **When** 대표가 권한을 끈다 **Then** 그 강사의 다음 명단 요청은 403 이고 감사 기록에 전후 권한 배열이 남는다
4. **Given** 거절된 강사 **When** 같은 학원에 다시 신청한다 **Then** 새 `pending` 행이 생기고 옛 `rejected` 행은 그대로 남는다
5. **Given** 학원 B 의 대표 **When** 학원 A 의 소속 id 로 승인을 부른다 **Then** 403 `FORBIDDEN`
6. **Given** 위임 강사(`as: "delegate"`) **When** 다른 강사의 권한을 바꾸려 `PUT …/permissions` **Then** 403 — 위임 관리는 대표 고유 권한

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | 권한 → 메뉴 계산(README §6-1 대응) · 초대 상태 판정(활성·사용·만료·폐기) |
| DB | `ck_share_rate_bp`(10001 거부) · 결제 시각 기준 유효 비율 조회(바꾸기 전후 결제 2건이 다른 비율) · `uq_affiliations_open` 중복 대기 거부 · 초대 조건부 갱신 동시 2건 → 1건 · `ck_aff_rejected` |
| 통합 | 시나리오 1~6 · 동시 승인 2건 → 알림 1건 · 권한 같은 값 PUT → 감사 0행 · 해제 뒤 위임 행 0개 |
| E2E(Playwright) | 대표가 W3a 에서 위임을 끄면 다른 브라우저의 위임 강사 W23 화면이 새로고침 뒤 403 화면 |

## 열린 점

| # | 무엇 | 결정(① 은 2026-11-19 사용자 확정, 나머지는 사용자 확인 대기) |
|---|---|---|
| ① | 앱 「수업 등록 권한」(O31)과 관리자 웹 「수업·포스터 등록」(FR-081a)이 같은 권한인가 | **확정**: 다른 권한으로 둔다(`class_submit` 별도). O38 이 토글을 따로 그렸다 |
| ② | 거절 사유 「기타」에 글을 반드시 받는가 | 받는다(강사가 이유를 알 수 있게) |
| ④ | 비율 입력 단위 — 화면은 % 정수(60%)인가, 소수점까지인가 | % 정수로 받고 저장은 bp(×100). 소수 % 가 필요하면 bp 를 그대로 연다 |
| ③ | 위임 강사도 초대 링크를 만들 수 있나 | 아니다 — 대표만(FR-081a 위임 범위 밖) |
