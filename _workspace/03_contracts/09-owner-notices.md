# API 계약 — 환불·취소 공지 판본 · 노쇼 기준 · 학원 공지 (S1-3(환불·취소 공지·노쇼 기준) · S1-4(학원 공지))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §7-6. 관련 요구: FR-086(등록 형태별 정규 과정 템플릿) · FR-087(증빙 없으면 엄격 기준) · FR-099(환불 규정 등록·표시) · FR-099a(공지 양식) · FR-099c(이벤트형 취소 수수료) · FR-246(규정 없는 학원 게시 차단) · FR-135c(노쇼 정산 기준) · FR-284(주문 시점 값 고정) · FR-063a(소속 강사 공지) · FR-078(공지 직접 작성). 보드: W4a(정규) · W4b(이벤트형) · W8B(빠진 회차 안내) · W5(학원 공지) · O28(대표 앱 공지 쓰기) · I39(강사 학원 공지).

## 1. 환불·취소 공지 — 권한 `owner`(조회는 위임 강사도 — 플랜 6-3 「강사 조회」)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/academies/{academyId}/refund-notices` | 종류별 현재 판본 + 정규 템플릿 최소값 |
| `GET /api/academies/{academyId}/refund-notices/{kind}/versions` | 판본 목록(최신순) — `kind` = `regular`·`event`·`private_lesson` |
| `GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}` | 한 판본(주문이 가리키는 옛 판본도 열린다, O-16(판본 보존)) |
| `POST /api/academies/{academyId}/refund-notices/{kind}/versions` | 새 판본 저장(「저장하고 적용」) |

`GET …/refund-notices` 200
```json
{ "registrationType": "academy", "registrationVerified": true,
  "regular": { "version": 3, "createdAt": "…Z", "content": { … },
               "template": { "code": "hakwon_act", "templateVersion": "2026-11-13",
                             "minimums": [ {"point":"before_start","percent":100}, {"point":"before_one_third","percent":67},
                                           {"point":"before_half","percent":50}, {"point":"after_half","percent":0} ] } },
  "event": { "version": 1, "content": { … }, "maxFeePercents": {"d10_plus":10,"d9_d7":10,"d6_d3":20,"d2_to_deadline":30} },
  "privateLesson": null }
```
- 템플릿은 등록 형태로 고른다(FR-086). `registrationVerified=false` 면 등록 형태와 상관없이 가장 엄격한 학원법 템플릿(FR-087)
- 템플릿 값은 초안(학원법 반환 기준 미검증, Q11 ①)이다 — 코드 상수 판본이 바뀌면 다음 저장부터 새 최소값을 쓴다
- **판본이 아직 없으면**(S1-3.3 구현): `regular`·`event` 객체는 그대로 있고 `version`·`createdAt`·`content` 만 함께 `null` 이다 — 첫 저장 화면도 템플릿 최소값과 이벤트형 상한을 보여야 해서다. `privateLesson` 은 판본이 없으면 객체째 `null`
- 신고 체육시설(확인됨)은 spec FR-086 표에 % 값이 없어 `template: null` 이다(Q11 ① 검토 뒤 채운다). 확인 전·미등록은 엄격 기준이라 학원법 템플릿
- 조회 권한(S1-3.3 구현): 대표 + 그 학원 관리자 웹 위임(`roster_manage`·`class_manage` 중 하나 이상)이 켜진 소속 강사, 2단계 인증 세션. 위임 강사는 `POST` 불가. 열린 점 ② 가 「관리자 웹 위임 메뉴에는 넣지 않는다」로 정해지면 위임 강사 조회를 뺀다

`GET …/{kind}/versions` 200 — `{ "kind": "regular", "items": [ { "version": 3, "createdAt": "…Z", "templateCode": "hakwon_act", "templateVersion": "2026-11-13" }, … ] }`(최신순, 판본이 없으면 `items: []`)

`GET …/{kind}/versions/{version}` 200 — `{ "kind", "version", "createdAt", "content": { … }, "body": "<그때 화면용 본문>", "templateCode", "templateVersion" }`. 없는 판본·없는 종류 이름은 404 `NOT_FOUND`

새 판본 요청(정규)
```json
{ "baseVersion": 3,
  "content": { "cancellableUntil": "수강 시작 전까지 언제든",
               "tiers": [ {"point":"before_start","percent":100}, {"point":"before_one_third","percent":67},
                          {"point":"before_half","percent":67}, {"point":"after_half","percent":0} ],
               "nonRefundableCases": "이미 들은 회차와 기간이 끝난 수강권", "processingBusinessDays": 5, "ownerContact": "0200000000" } }
```
이벤트형은 `content: { feeTiers: [{window, percent}×4], nonRefundableCases, processingBusinessDays, ownerContact }`.

| 검사(저장 거부) | 응답 |
|---|---|
| `baseVersion` 이 현재 최신이 아니다(첫 판본은 `null`) | 409 `NOTICE_VERSION_CONFLICT` — 두 화면 동시 저장 방지, 판본이 건너뛰지 않게 |
| 정규: 어느 시점이든 `percent` < 템플릿 최소 | 422 `REFUND_BELOW_TEMPLATE` + `fields`(S1-3 수용 ①) |
| 이벤트형: `percent` > 구간 상한(10·10·20·30) | 422 `CANCEL_FEE_ABOVE_MAX`(결정 4 — 6~3일 전 상한 20%) |
| 이벤트형: `processingBusinessDays` > 3 | 422 `PROCESSING_DAYS_TOO_LONG`(FR-099a) |
| 0~100 정수 밖, 구간 빠짐·중복 | 422 `VALIDATION_FAILED` |
| `kind=private_lesson` | 422 `NOTICE_KIND_NOT_READY` — 내용 모양은 S2-4(개인 레슨)가 정한다 |

성공 201 `{ "kind", "version": 4, "createdAt", "body": "<서버가 만든 화면용 본문>" }`. 한 트랜잭션: 판본 INSERT(옛 판본은 그대로, S1-3 수용 ②) · 감사 `refund_notice.published`(before = 옛 `content`).

- 같은 내용 재저장도 새 판본이다(멱등 대신 `baseVersion` 충돌로 중복 저장을 막는다)
- **정규 저장 구현(S1-3.4)**: 권한 `owner` 만(위임 강사 403), 2단계 인증 세션. 새 판본 번호는 `baseVersion + 1` 이고 같은 번호 동시 INSERT 는 `uq_refund_notice_academy_kind_version` 이 막아 늦은 쪽이 409 다. `REFUND_BELOW_TEMPLATE` 의 `fields` 는 `[{ "path": "content.tiers.<i>.percent", "message": "50% 이상이어야 해요" }]`. `ownerContact` 는 0 으로 시작하는 숫자 9~11자리, 정규 `processingBusinessDays` 는 1~365(열린 점 ① 의 30영업일 경고는 화면 몫). 템플릿이 `null` 인 신고 체육시설(확인됨)은 하한 검사 없이 저장하고 `template_code` 를 비운다(Q11 ① 값이 정해지면 다시 본다). `kind=event` 는 S1-3.5(이벤트형 저장)가 붙기 전까지 422 `NOTICE_KIND_NOT_READY` 였다(아래 줄)
- **이벤트형 저장 구현(S1-3.5)**: 권한·2단계 인증·`baseVersion` 충돌은 정규와 같고, 판본 번호는 종류별로 따로 센다. 상한은 `lib/domain/refund-templates.ts` 의 `EVENT_CANCEL_FEE_MAX_PERCENTS` 한 곳(조회 응답 `maxFeePercents` 와 같은 값)에서 읽고, 같은 값은 통과·넘으면 422 `CANCEL_FEE_ABOVE_MAX` + `fields`(`[{ "path": "content.feeTiers.<i>.percent", "message": "20% 이하여야 해요" }]`). `processingBusinessDays` 는 모양 검사 1~365 뒤 3 을 넘으면 422 `PROCESSING_DAYS_TOO_LONG`(`fields` 경로 `content.processingBusinessDays`). 구간 빠짐·중복, 정규 칸(`cancellableUntil`) 섞임은 422 `VALIDATION_FAILED`. 이벤트형은 등록 형태별 템플릿이 없어 `template_code`·`template_version` 을 비운다. 화면용 본문 1번(취소 가능 시점)은 고정 문구 「상품마다 정한 환불 마감일까지(마감일 다음 날부터 취소·환불 불가)」 — 마감일 값은 상품마다 정한다(아래 「적용 시점」)
- **개인 레슨 양식 틀(S1-3.7)**: HTTP 경로는 계속 422 `NOTICE_KIND_NOT_READY` 다. 저장 자리만 서비스 함수 `savePrivateLessonNoticeVersion(db, academyId, staffAccountId, { baseVersion, content, body })`(`lib/server/services/refund-notice-publish.ts`)로 만들었다 — 판본 번호(종류별)·`baseVersion` 409·감사 `refund_notice.published` 는 정규·이벤트형과 같은 트랜잭션 함수를 쓰고, `content` 는 비어 있지 않은 JSON 객체인지만 본다(칸 모양·화면용 본문 규칙·누가 쓰는지는 S2-4 가 정해 이 함수 앞에 검사를 붙인다). 템플릿 칸은 비운다
- **적용 시점**: 새 판본은 이후 주문부터다. 이미 결제한 주문은 `orders.refund_notice_version_id` 의 판본을 따른다(FR-284). 「환불 마감일이 지난 행사에는 못 바꾼다」(S1-3 수용 ③)는 공지 판본이 아니라 상품별 마감일·수수료 사본의 규칙이라 행사 상품 계약(S2-2·S6-4)에서 검사한다
- **게시 차단(FR-246)**: 수업 게시 경로가 쓸 판정 함수 `hasPublishedRefundNotice(academyId, kind)` 를 이 슬라이스가 만든다. 정규 판본이 없으면 정규 수업 게시는 409 `NOTICE_MISSING`(README §4 의 기존 코드)
- **게시 차단 구현(S1-3.6)**: `lib/server/services/refund-notice-gate.ts` 의 `hasPublishedRefundNotice(db, academyId, kind)` 는 그 학원·그 종류 판본이 하나라도 있으면 true(종류마다 따로 센다, UUID 아님·모르는 종류는 false). 게시 경로는 `assertRefundNoticeForPublish(db, academyId, kind)` 를 부르면 공지가 없을 때 409 `NOTICE_MISSING` 이 난다. 실제 게시 경로(M2)는 아직 없다

## 2. 노쇼 기준 — W8B

`GET /api/no-show-policy` — 권한: 로그인 직원(대표·강사). 저장 경로는 없다(Q15(출결 방식) 임시 확정: 기준 하나 고정).
```json
{ "version": "2026-11-10", "rule": "빠진 회차는 수업을 들은 것으로 보고 정산하며 환불·보강하지 않는다",
  "memberNoticeText": "연락 없이 빠진 회차는 수업을 들은 것으로 처리돼요. 그 회차는 환불하거나 보강하지 않아요.",
  "points": ["결석 알림은 불이익에 쓰지 않는다", "노쇼 기록·대기 순번 불이익 없음", "휴강은 옮기기·환불 규칙", "분쟁은 결제·환불 기록이 근거"] }
```
값은 코드 상수다. 주문 생성(S3-3)이 `version` 을 `orders.no_show_policy_version` 에 고정한다. 결정 7(강사·대표의 결석 대신 표시)은 레벨에만 쓰므로 이 문구는 바뀌지 않는다.
- **구현(S1-3.8)**: 상수 `NO_SHOW_POLICY`(`admin-web/lib/domain/no-show-policy.ts`), 응답 스키마 `noShowPolicyResponseSchema`(`lib/server/services/no-show-policy.ts`, strict). 권한 검사는 직원 본인 경로(알림함과 같은 staff_self) — 세션 401 `UNAUTHENTICATED` → 직원 계정 403 `STAFF_ACCOUNT_REQUIRED`·`ACCOUNT_SUSPENDED` → 2단계 인증 전 401 `SECOND_FACTOR_REQUIRED`. 역할·학원은 묻지 않는다(기준이 한 벌이라). 앱에서 인증 앱 없는 강사가 부를 수 있게 할지는 앱 화면 Task 가 정한다

## 3. 학원 공지(소속 강사 전용) — 쓰기 권한 `owner`, 웹·앱 모두(FR-063a)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/academies/{academyId}/staff-notices?status=published&cursor=` | 지난 공지(W5) — `{ items: [{ noticeId, category, title, publishedAt, recipientCount, readCount }], nextCursor }` |
| `POST /api/academies/{academyId}/staff-notices` | 초안 만들기 `{ "category": "class_cancelled", "title": "11/21 (토) 살사 온원 입문 휴강", "body": "…" }` → 201 |
| `PATCH /api/academies/{academyId}/staff-notices/{noticeId}` | 초안만 고친다. 올린 공지는 409 `NOTICE_ALREADY_PUBLISHED` |
| `POST /api/academies/{academyId}/staff-notices/{noticeId}/publish` | 올리기. 이미 올렸으면 200 같은 본문(상태 조건부 갱신이 멱등 근거) |

- 「바로 올리기」는 `POST` 에 `"publish": true` 를 넣어 한 요청으로도 된다(O28)
- 올리기 트랜잭션: 조건부 갱신 `draft → published` · 그 순간 `active` 소속 강사를 받는 사람으로 고정 · 강사마다 알림 `staff_notice_published`(category `operations`, `dedupe_key = staff_notice:<id>`) · `recipient_count`. 소속 강사가 0명이면 409 `NO_RECIPIENTS`
- 이미지·포스터에서 글자를 뽑아 채우지 않는다(FR-078). 본문은 글만 받는다
- 위임 강사는 학원 공지를 쓸 수 없다(위임 2종 밖)
- **쓰기 셋 구현(S1-4.3)**: `lib/server/services/academy-staff-notices.ts`. 권한 `owner` + 관리자 웹 2단계(위임 강사 403 — 대표 앱 bearer 경로는 앱 공지 쓰기 화면 Task 가 정한다). 요청 `category`(4종) · `title`(앞뒤 공백 지우고 1~100자) · `body`(1~5,000자, 추천값) · `publish?`, 모르는 칸은 422. `PATCH` 는 바꿀 칸만(하나도 없으면 422). 세 경로 응답은 같은 모양 `{ noticeId, academyId, category, title, body, status, publishedAt, recipientCount, createdAt, updatedAt }`(초안이면 `publishedAt`·`recipientCount` 가 `null`) — `POST` 201, `PATCH`·`publish` 200. 없는 공지·다른 학원 공지 404. 올리기는 공지 행을 잠근 뒤 처리해 동시에 두 번 눌러도 받는 사람·알림이 한 벌이다. `publish: true` 인데 받는 사람이 0명이면 409 `NO_RECIPIENTS` 이고 초안도 남지 않는다. **`dedupe_key` 는 `staff_notice:<공지id>:<강사id>`** — 위 줄의 `staff_notice:<id>` 로는 `uq_notifications_dedupe (kind, dedupe_key)` 에 걸려 두 번째 강사부터 알림이 빠진다(data-model 행사 알림과 같은 이유로 받는 사람 id 를 붙였다). 알림 `payload` 는 `{ noticeId, academyId, academyName, category, title: "<학원> 새 공지", body: <공지 제목>, actionLabel, link: "/instructor/staff-notices" }`

강사 쪽(앱, `instructor` 역할 — 화면은 S2-1)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/instructor/staff-notices?academyId=&category=&cursor=` | **지금 `active` 소속인 학원**의 공지만, 최신순(I39). 해제된 학원 공지는 옛 것도 안 보인다 |
| `POST /api/instructor/staff-notices/{noticeId}/read` | 읽음. 받는 사람이 아니면 404 |

- **읽기 셋 구현(S1-4.4)**: `lib/server/services/staff-notice-reads.ts`.
  - 대표 「지난 공지」 `GET /api/academies/{academyId}/staff-notices` — 권한은 쓰기와 같다(owner + 관리자 웹 2단계, 위임 강사 403). `status` 는 `published` 만 받는다(생략하면 `published`, 다른 값은 422 — 초안 목록은 이 계약에 없다). `readCount` 는 받는 사람 행 중 `read_at` 이 찬 수(해제된 강사가 전에 읽은 것도 센다)
  - 강사 두 경로 — instructor 역할 + 강사 앱(2단계를 묻지 않는다, 소속 신청 경로와 같다). 보이는 공지 = **그 공지의 받는 사람**(올린 순간 active 소속) **이면서 지금도 그 학원에 `active` 소속**. 그래서 올린 뒤 소속된 강사는 그 옛 공지를 못 보고, 해제된 강사는 받아 둔 옛 공지도 못 본다. 읽음도 같은 두 조건이라 어긋나면 404(있는지 알리지 않는다)
  - 강사 목록 한 장 `{ noticeId, academyId, academyName, category, title, body, publishedAt, readAt }`(본문까지 — 목록에서 바로 펼친다). 읽음 응답 `{ noticeId, readAt }` — 처음 읽은 시각을 지켜 두 번째도 같은 값(멱등)
  - 두 목록 모두 `{ items, nextCursor }`, 최신순 `(published_at, id)` 커서(직원 알림함과 같은 모양). `limit`(1~100, 기본 20)을 함께 받는다(추천값 — 알림함과 같다). 고친 커서·모르는 쿼리 칸은 422
  - 읽음은 학원 공지 받는 사람 행만 고친다. 같은 공지로 생긴 알림(`staff_notice_published`)의 읽음은 알림함 경로가 따로 맡는다

회원 경로에는 이 공지를 내리는 API 가 없다 — 회원 앱 학원 소식(FR-023a 구독)과 테이블도 다르다.

## 수용 시나리오

1. **Given** 등록 형태 `academy` 학원 **When** 대표가 「1/2 지나기 전」을 50% → 40% 로 저장 **Then** 422 `REFUND_BELOW_TEMPLATE`, 판본 수 그대로. 67% 로 올리면 201 새 판본
2. **Given** 정규 판본 3 이 있고 주문 A 가 판본 3 으로 결제됐다 **When** 판본 4 저장 **Then** 주문 A 의 공지 조회는 판본 3 을, 새 주문은 판본 4 를 가리킨다
3. **Given** 이벤트형 공지 **When** 「6일 전 ~ 3일 전」을 25% 로 저장 **Then** 422 `CANCEL_FEE_ABOVE_MAX`. 15% 는 201(낮추기만 된다)
4. **Given** 두 대표 화면이 같은 `baseVersion: 3` 으로 동시에 저장 **When** 둘 다 보낸다 **Then** 하나는 201(판본 4), 다른 하나는 409 `NOTICE_VERSION_CONFLICT`
5. **Given** 소속 강사 3명 중 1명이 해제됐다 **When** 대표가 공지를 올린다 **Then** 받는 사람 2명, 해제된 강사의 학원 공지 목록은 비어 있다
6. **Given** 정규 공지 판본이 없는 학원 **When** `hasPublishedRefundNotice(academyId, 'regular')` **Then** false — 게시 경로가 409 `NOTICE_MISSING`

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | 템플릿 고르기(등록 형태 × 확인 여부) · 분수 → % 올림(2/3 → 67, 1/2 → 50) · 이벤트형 상한 경계(20 통과, 21 거부) · 화면용 본문 만들기(FR-099a 항목 순서) |
| DB | `uq_refund_notice_academy_kind_version` · `ck_staff_notice_published` |
| 통합 | 시나리오 1~6 · 위임 강사의 공지 쓰기 403 · 올리기 두 번 → 알림 강사당 1건 |

## 열린 점

| # | 무엇 | 결정(③ 은 2026-11-19 사용자 확정, 나머지는 사용자 확인 대기) |
|---|---|---|
| ① | 정규 공지 「환불 처리 기간」 상한 — 이벤트형만 3영업일 상한이 있다 | 상한 없이 받되 30영업일 넘으면 경고만(값은 추천) |
| ② | 위임 강사가 환불 공지를 볼 수 있나 — 플랜 6-3 은 강사 「조회」, 위임 강사 칸은 「-」 | 앱 강사(소속)는 조회, 관리자 웹 위임 메뉴에는 넣지 않는다 |
| ③ | 학원 공지를 올린 뒤 고치기·지우기 | **확정**: 제목 100자, 올린 뒤 고치기·지우기 없음(판본으로 새로 올림, 데이터 §7-12 ⑧) |
