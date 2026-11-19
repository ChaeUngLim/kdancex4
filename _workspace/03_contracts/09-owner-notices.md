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
- **적용 시점**: 새 판본은 이후 주문부터다. 이미 결제한 주문은 `orders.refund_notice_version_id` 의 판본을 따른다(FR-284). 「환불 마감일이 지난 행사에는 못 바꾼다」(S1-3 수용 ③)는 공지 판본이 아니라 상품별 마감일·수수료 사본의 규칙이라 행사 상품 계약(S2-2·S6-4)에서 검사한다
- **게시 차단(FR-246)**: 수업 게시 경로가 쓸 판정 함수 `hasPublishedRefundNotice(academyId, kind)` 를 이 슬라이스가 만든다. 정규 판본이 없으면 정규 수업 게시는 409 `NOTICE_MISSING`(README §4 의 기존 코드)

## 2. 노쇼 기준 — W8B

`GET /api/no-show-policy` — 권한: 로그인 직원(대표·강사). 저장 경로는 없다(Q15(출결 방식) 임시 확정: 기준 하나 고정).
```json
{ "version": "2026-11-10", "rule": "빠진 회차는 수업을 들은 것으로 보고 정산하며 환불·보강하지 않는다",
  "memberNoticeText": "연락 없이 빠진 회차는 수업을 들은 것으로 처리돼요. 그 회차는 환불하거나 보강하지 않아요.",
  "points": ["결석 알림은 불이익에 쓰지 않는다", "노쇼 기록·대기 순번 불이익 없음", "휴강은 옮기기·환불 규칙", "분쟁은 결제·환불 기록이 근거"] }
```
값은 코드 상수다. 주문 생성(S3-3)이 `version` 을 `orders.no_show_policy_version` 에 고정한다. 결정 7(강사·대표의 결석 대신 표시)은 레벨에만 쓰므로 이 문구는 바뀌지 않는다.

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
- 위임 강사는 학원 공지를 쓸 수 없다(위임 3종 밖)

강사 쪽(앱, `instructor` 역할 — 화면은 S2-1)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/instructor/staff-notices?academyId=&category=&cursor=` | **지금 `active` 소속인 학원**의 공지만, 최신순(I39). 해제된 학원 공지는 옛 것도 안 보인다 |
| `POST /api/instructor/staff-notices/{noticeId}/read` | 읽음. 받는 사람이 아니면 404 |

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
