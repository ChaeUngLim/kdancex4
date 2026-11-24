# API 계약 — 내 캘린더·알림 (US1-A4(웹훅 확정 일괄 처리))

공통 규칙은 `README.md`. Q9(캘린더의 뜻) = **앱 안 캘린더 기록**(Phase 2 가 spec 에서 기기 캘린더 연동 근거 0건 확인). Q12(알림 기록 형태) = **테이블 기록 + 조회 API, 화면과 푸시 발송은 범위 밖**(plan D7).

## 1. `GET /api/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`

KST 달력 날짜 범위(최대 62일, 기본 오늘~+31일). 확정 예약의 회차만 나온다(FR-289(확정 후 일괄 처리)가 넣은 `calendar_entries`).

```json
{ "items": [ { "entryId": "…", "reservationId": "…", "offeringId": "…", "sessionSeq": 1,
               "title": "살사 정규 입문", "academyName": "…", "startsAt": "…Z", "endsAt": "…Z" } ] }
```
정렬: `startsAt` 오름차순. 취소된 예약의 행은 취소 트랜잭션이 지운다(이관 취소 API, `05-cancellation-migrated.md`).

## 2. `GET /api/me/notifications?limit=20&cursor=`

```json
{ "items": [ { "id": "…", "kind": "payment_confirmed_member", "createdAt": "…Z", "readAt": null,
               "orderId": "…", "payload": { "title": "결제가 확인됐어요", "offeringTitle": "…", "amount": 120000 } } ],
  "nextCursor": null }
```
- `payload` 는 화면 문구 재료다. 금액 외 결제 정보(계좌번호 등)는 넣지 않는다
- 읽음 처리 API 는 1회차 범위 밖

## 3. 확정 때 생기는 알림 2건(FR-114(결제 확인 앱 알림))

| kind | 받는 사람 | payload |
|---|---|---|
| `payment_confirmed_member` | 주문 회원 | 수업 제목·금액·첫 회차 시각 |
| `payment_confirmed_owner` | `academies.owner_member_id`(없으면 만들지 않고 order_events 에 사유 기록) | 수업 제목·금액·자리 종류. 회원 연락처는 넣지 않는다 |

유니크 `(kind, order_id, recipient)` 라 웹훅이 다시 처리돼도 1건씩이다. `delivery_status` 는 `pending` 으로 남는다 — 발송은 SCH-38(알림)이 이 행을 읽어 한다.

---

# 2026-11-20 더하는 절 — 결석 쓰기 경로·결제 내역 (S3-4.3 · S3-4.3a · S3-4.3b · S3-4.3c · S3-4.6)

위 §1~§3 은 고치지 않았다. 아래는 로드맵 S3-4.3(결석 예정 토글 API) · S3-4.3a(강사·대표 결석 표시 API) · S3-4.3b(결석 표시 48시간 확정 작업) · S3-4.3c(결석 이의 신청·처리 API) · S3-4.6(결제 내역·주문 상태 표시 API)이 계약 칸에 04 를 적어 둔 경로다.

**근거 FR**: FR-092e(결석 예정 미리 알리기 + 결석 표시) · FR-104(출석 기록) · FR-104a(사전 불참 표시) · FR-169a(출석률 반영 레벨) · FR-135b(출석은 분쟁 근거) · FR-298(주문 상태 6종) · FR-138(영수증·현금영수증) · FR-019a(닉네임 표시) · D7(출석률·횟수 숫자를 화면에 띄우지 않는다) · D20(근거가 없는 값은 모두 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」)
**보드**: M11(캘린더 · 참석/결석 토글) · M16(내 예약·결제 내역) · I26(오늘 결석 알린 수강생) · W6(예약·명단의 결석 표시)
**데이터**: §7-8 `attendance_marks`(칸·제약은 거기가 원본) · `audit_logs`(§7-7) · `notifications`(§2-2 + 직원 확장, `dedupe_key`)

## 4. 이미 다른 파일에 있어 다시 쓰지 않는 것

| 무엇 | 어디 |
|---|---|
| 오늘 결석 **읽기**(`GET /api/classes/{classId}/sessions/{sessionId}/absences`) · 오늘 인원 계산 `computePresent` · 명단의 결석 칸 | `18-after-payment-views.md` §4 · §7 · §8 |
| 회차 시각·휴강 상태 | `11-instructor.md` (회차 `class_sessions.starts_at`·`ends_at`·`status`) |
| 오류 모양·권한 판정(`requireMember`·`requireStaff`) | `README.md` §2 · §4 · §6 |

### 4-1. 기존 경로에 더하는 칸 (README §0 모음표에 올렸다)

`GET /api/me/calendar` 의 `items[]` 에 두 칸을 더한다 — M11 이 회차마다 `참석 | 결석` 토글과 「결석 예정」 표시를 그리려면 회차 id 와 결석 상태가 필요하다.

```json
{ "entryId": "…", "reservationId": "…", "offeringId": "…", "sessionId": "…", "sessionSeq": 1,
  "title": "살사 정규 입문", "academyName": "…", "startsAt": "…Z", "endsAt": "…Z",
  "absence": { "markId": "…", "markedByKind": "member", "disputeStatus": "none", "canToggle": true } }
```
- `absence` 는 살아 있는 결석 행이 없으면 `null`. `canToggle` 은 **내가 켠 결석이고 수업 시작 전**일 때만 `true`(§5 의 규칙과 같은 계산 한 곳)
- 결석 표시가 직원이 한 것이면 `markedByKind` 는 `instructor` · `owner`, 화면은 역할까지 보인다(FR-092e 「표시한 사람의 이름은 회원에게도 역할까지 보인다」 — 이름은 아니라 역할만 내린다, 열린 점 ③)
- 숫자(출석 횟수·출석률)는 어디에도 없다(D7)

## 5. 회원의 결석 예정 토글 (S3-4.3 · FR-092e · FR-104a · M11)

| 메서드·경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `PUT /api/me/sessions/{sessionId}/absence` | `requireMember` | 내가 확정된 회차를 **결석 예정**으로 알린다 | 상태(이미 있으면 200 같은 행) | FR-092e · FR-104a | M11 |
| `DELETE /api/me/sessions/{sessionId}/absence` | `requireMember` | 결석 예정을 **참석으로 되돌린다** | 상태(이미 없으면 200) | FR-092e | M11 |

요청 본문은 없다. 헤더 `Idempotency-Key` 는 받지 않는다(상태를 맞추는 경로라 같은 호출을 되풀이해도 결과가 같다).

`PUT` 200(처음 만들면 201, 이미 있으면 200 같은 본문)
```json
{ "markId": "…", "sessionId": "…", "reservationId": "…", "markedByKind": "member",
  "markedAt": "2026-11-12T03:10:00Z", "disputeStatus": "none", "canToggle": true }
```
`DELETE` 200: `{ "sessionId": "…", "absence": null }`

서버 순서(한 트랜잭션)

| # | 단계 | 실패 시 |
|---|---|---|
| 1 | 회차가 있다 | 404 `NOT_FOUND` |
| 2 | 그 회차의 예약이 **내 확정 예약**(`reservations.status='confirmed'` + 주문 `paid`·`partially_refunded`)이다 | 403 `FORBIDDEN`(남의 회차 · 결제 전 포함) |
| 3 | 회차 `status='scheduled'`(휴강·폐강이 아니다) | 409 `SESSION_NOT_SCHEDULED` |
| 4 | 시작 시각 전이다 — 시작 뒤에는 회원이 켜지도 끄지도 못한다(그 뒤는 강사·대표 표시 §6) | 409 `SESSION_ALREADY_STARTED` |
| 5 | (`DELETE` 만) 지울 행이 **내가 켠 것**(`marked_by_kind='member'`)이다 | 409 `ABSENCE_MARKED_BY_STAFF`(강사·대표가 표시한 것은 이의 신청 §8 로만) |
| 6 | `PUT` 은 `attendance_marks` 행을 `(reservation_id, session_id)` 로 만든다(`ON CONFLICT` 로 살아 있는 행이 있으면 그 행을 돌려준다). `DELETE` 는 행을 지우지 않고 `cancelled_at = now()` 를 채운다 | — |

- **다른 테이블은 건드리지 않는다**: `orders`·`payments`·`reservations`·`seat_pools`·정산 행·대기 순번은 호출 전후 같다(수용 ②). 자리를 반납하지 않는다 — 반납은 취소(FR-098)를 거친다(FR-104a)
- 회원 본인이 켠 결석 예정에는 알림을 보내지 않고 감사 행도 쓰지 않는다(§7-8 「감사 ○」는 강사·대표가 표시·이의 처리할 때만). 이 값은 강사의 인원 파악용 권고이고, 레벨(FR-169a)은 이 행도 결석으로 센다
- 되돌린 행(`cancelled_at` 채움)은 남는다. 다시 켜면 새 행이 생긴다(부분 유니크 `uq_attendance_session` 이 살아 있는 행만 막는다)

| 오류 | 언제 |
|---|---|
| 401 `UNAUTHENTICATED` · 403 `SIGNUP_INCOMPLETE` | README §4 |
| 403 `FORBIDDEN` | 내 확정 예약이 없는 회차 |
| 404 `NOT_FOUND` | 회차 없음 |
| 409 `SESSION_NOT_SCHEDULED` · `SESSION_ALREADY_STARTED` · `ABSENCE_MARKED_BY_STAFF` | 위 표 |

## 6. 강사·대표의 결석 표시·취소 (S3-4.3a · FR-092e · FR-104 · W6 · I26)

| 메서드·경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `POST /api/classes/{classId}/sessions/{sessionId}/absences` | `owner` · `roster_manage` · 담당 강사 | 결석한 수강생을 표시한다(회원이 미리 알린 결석 예정을 **확정**하는 것도 같은 호출) | 상태(같은 회원이 이미 결석이면 200 같은 행) | FR-092e · FR-104 | I26 · W6 |
| `POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel` | 같음. 단 잠긴 뒤에는 `owner` 만 | 결석 표시를 취소한다(출석으로 돌아간다) | 상태 | FR-092e · FR-104 | I26 · W6 |

권한 판정은 `18-after-payment-views.md` §1-1 의 「§8 오늘 결석」 줄과 같다(대표 ○ · 위임 강사 `roster_manage` ○ · 담당 강사 ○ · 그 밖의 강사 -). 위임을 끄면 다음 요청부터 403.

### 6-1. 표시

요청: `{ "memberId": "…" }`

201(이미 결석이면 200 같은 본문)
```json
{ "markId": "…", "sessionId": "…", "memberId": "…", "nickname": "정우진", "markedByKind": "instructor",
  "markedAt": "2026-11-11T08:40:00Z", "lockedAt": "2026-11-13T12:00:00Z", "disputeStatus": "none" }
```
- `markedByKind` 는 부른 사람의 역할(`instructor` · `owner`). 한 호출자가 대표이면서 담당 강사여도 **대표 경로로 부르면 `owner`**
- `lockedAt` = 그 회차 `ends_at + 48시간`(FR-092e, 2026-11-19 확정). 판정은 서버가 읽을 때마다 이 식으로 한다(§7)
- 회원이 이미 결석 예정을 켜 두었으면 **새 행을 만들지 않고** 그 행(`markedByKind: "member"`)을 그대로 돌려준다 — 「확정」은 따로 상태가 없다. 시작 뒤에는 회원이 그 행을 못 지우므로(§5 #4) 그 순간 사실상 확정이다(열린 점 ④)
- 그 회차의 **확정 수강생**(결제 완료 + 예약 `confirmed`)만 표시할 수 있다. 결제 대기 수강생은 표시할 수 없다

서버 순서(한 트랜잭션)

| # | 단계 | 실패 시 |
|---|---|---|
| 1 | 학원·수업·회차 id 가 서로 이어져 있고 호출자가 권한을 갖는다 | 403 `FORBIDDEN` · 404 `NOT_FOUND` |
| 2 | 회차 `status='scheduled'` | 409 `SESSION_NOT_SCHEDULED` |
| 3 | 시작 시각 이후다(회원이 미리 알리는 구간은 §5) — 보드 I26 이 오늘 회차에서 바로 표시하는 화면이라 spec 의 「끝난 뒤」보다 넓혔다(열린 점 ①) | 409 `SESSION_NOT_STARTED` |
| 4 | `now <= ends_at + 48h` | 409 `ABSENCE_WINDOW_CLOSED`(본문 `lockedAt`) |
| 5 | `memberId` 가 그 회차의 확정 수강생이다 | 404 `NOT_FOUND` |
| 6 | 행을 만든다(`marked_by_kind`·`marked_by_staff_account_id`) + **감사 `attendance.marked` 1행**(누가·어느 역할·언제·전후) + **회원 알림 1건** `absence_marked`(수업 이름·회차 날짜·표시한 사람의 **역할** + 이의 신청 입구, `dedupe_key = absence:<markId>:marked`) | — |

회원이 켠 결석 예정을 확정하는 호출(이미 행이 있음)에는 알림·감사를 새로 만들지 않는다(바뀐 게 없다).

### 6-2. 취소

요청: `{ "reason": "잘못 눌렀어요" }` — 48시간 안에는 선택, **잠긴 뒤에는 필수**(1~200자).

200: `{ "markId": "…", "cancelledAt": "…Z", "disputeStatus": "none" }`

- 48시간 안: 표시한 직원 본인·담당 강사·위임 강사·대표가 취소할 수 있다. 행에 `cancelled_at` 을 채운다(지우지 않는다) + 감사 `attendance.cancelled`
- **잠긴 뒤(48시간 경과)**: **대표만** 사유를 적고 취소한다(FR-104 「수업 종료 후 수정하려면 사유가 남아야 한다」 · spec FR-092e 「고치려면 사유를 남겨 대표만 바꾼다」). 다른 직원은 403 `FORBIDDEN`, 사유가 비면 422 `ABSENCE_REASON_REQUIRED`. 새 표시는 잠긴 뒤에 대표도 못 한다(§6-1 #4)
- 이의가 걸려 있는 행(`disputeStatus='requested'`)을 취소하면 §8 의 「받아들임」과 같다: `dispute_status='accepted'` + 회원 알림 `absence_dispute_resolved`
- 이미 취소된 행이면 200 같은 본문
- 회원 알림은 취소 때는 보내지 않는다(이의 처리에서만 보낸다 — 열린 점 ⑤)
- **구현(추천안·사후 확인 2026-11-24, S3-5.9b)**: 로드맵에 이 경로를 맡은 Task 가 없어 I26 의 「표시 취소」(스위치 끄기)를 그리는 S3-5.9b 가 붙였다(`staff-absence-marks.ts` 의 `cancel`). 판정 순서: 권한(§6-1 과 같은 사람) → 본문 → 휴강 409 → **시작 전 409 `SESSION_NOT_STARTED`**(그때는 회원이 §5 로 직접 바꾼다) → 잠긴 뒤 대표 아님 403 → 잠긴 뒤 사유 없음 422. 표시가 그 회차 것이 아니면 404. 이의가 걸린 행을 취소하면 `dispute_resolved_at`·`dispute_resolved_by_account_id` 도 채우고 §8 과 같은 알림 열쇠(`absence:<markId>:dispute_resolved`)를 쓴다. 「표시한 직원 본인」은 §6-1 권한(대표·위임·담당)에 이미 들어 있어 따로 열지 않았다

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 권한 없음 · 다른 학원 · 잠긴 뒤 대표 아님 |
| 404 `NOT_FOUND` | 회차·표시 없음 · 그 회차의 확정 수강생이 아님 |
| 409 `SESSION_NOT_SCHEDULED` · `SESSION_NOT_STARTED` · `ABSENCE_WINDOW_CLOSED` | 위 표 |
| 422 `VALIDATION_FAILED` · `ABSENCE_REASON_REQUIRED` | `memberId` 형식 · 잠긴 뒤 취소 사유 없음 |

## 7. 결석 표시 48시간 확정 작업 (S3-4.3b · 내부 경로)

| 경로 | 호출자 | 역할 | 멱등 | 근거 |
|---|---|---|---|---|
| `POST /api/internal/jobs/absence-lock` | 시간 작업 실행기(S0-4.4) · 헤더 `X-Internal-Token`(README §1) | `ends_at + 48h` 가 지난 회차를 **확정(잠금)** 처리한다 | 예(같은 회차는 한 번만) | FR-092e · 플랜 6-7 |

- 잠금의 **권위는 시각 계산**이다 — §6 은 이 작업이 돌았는지와 상관없이 `now > ends_at + 48h` 이면 새 표시를 거부한다(49시간째 거부, 수용). 작업이 늦어져도 규칙이 새지 않는다
- 작업이 하는 일: 잠길 시각이 지났고 아직 잠금 기록이 없는 회차마다 감사 `attendance.session_locked` 1행(`target_table='class_sessions'`, `after = { "markCount": n }`)을 쓴다. 호출을 되풀이해도 회차당 1행이다(감사 `target_id` + `action` 으로 이미 있는지 확인). 칸을 새로 만들지 않는다(열린 점 ⑥)
- 실행 주기: 매시간(추천값). 응답 `{ "locked": 3 }`
- 이의가 걸려 있는 행은 잠겨도 §8 로 처리된다 — 이의 처리는 잠금과 별개다

| 오류 | 언제 |
|---|---|
| 401 `UNAUTHENTICATED` | 내부 토큰 없음·불일치(README §1) |

## 8. 결석 이의 신청·처리 (S3-4.3c · FR-092e · FR-169a · M11 · I26)

| 메서드·경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `POST /api/me/attendance-marks/{markId}/dispute` | `requireMember`(내 표시만) | 강사·대표가 표시한 결석에 **이의**를 건다 | 상태(이미 `requested` 이면 200 같은 본문) | FR-092e | M11 |
| `POST /api/attendance-marks/{markId}/dispute/resolve` | 그 표시를 한 직원 · 그 학원 대표 | 이의를 **받아들이거나**(결석 취소) **유지한다** | 상태 | FR-092e · FR-169a | I26 |

### 8-1. 이의 신청

요청: `{ "reason": "그날 수업에 갔어요" }` — 앞뒤 공백을 자른 뒤 1~200자(임시 확정).

200: `{ "markId": "…", "disputeStatus": "requested", "disputeRequestedAt": "…Z" }`

- 이의는 **강사·대표가 표시한 행**(`marked_by_kind IN ('instructor','owner')`)에만 걸 수 있다. 회원이 켠 행은 §5 로 직접 끄므로 이의가 필요 없다
- 한 행에 이의는 한 번이다(`none` → `requested`). 처리된 행(`accepted`·`rejected`)에 다시 걸면 409
- 일어나는 일(한 트랜잭션): `dispute_status='requested'` · `dispute_requested_at` · `dispute_reason` + 감사 `attendance.dispute_requested` + **직원 알림 1건** `absence_dispute_requested`(받는 사람 = 표시한 직원 계정, `dedupe_key = absence:<markId>:dispute`, 본문은 닉네임·회차·회원이 쓴 사유. 연락처는 넣지 않는다)

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 내 표시가 아니다 |
| 404 `NOT_FOUND` | 표시 없음 |
| 409 `ABSENCE_NOT_DISPUTABLE` | 회원이 켠 행 · 이미 취소된 행 |
| 409 `DISPUTE_ALREADY_RESOLVED` | 이미 `accepted`·`rejected` |
| 422 `VALIDATION_FAILED` | 사유 없음·200자 초과 |

### 8-2. 이의 처리

요청: `{ "decision": "accept", "note": "확인했어요" }` — `decision` 은 `accept`(받아들임) · `reject`(유지). `note` 는 선택(최대 200자).

200
```json
{ "markId": "…", "disputeStatus": "accepted", "cancelledAt": "2026-11-12T09:00:00Z", "disputeResolvedAt": "2026-11-12T09:00:00Z" }
```
- `accept`: `dispute_status='accepted'` + 그 행 `cancelled_at` 을 채운다(출석으로 돌아간다 — 레벨 판정의 결석에서 빠진다) → 회원 알림 `absence_dispute_resolved`(「결석 표시가 취소됐어요」)
- `reject`: `dispute_status='rejected'`, 행은 유지 → 같은 알림 kind 로 결과를 알린다(「결석 표시가 유지됐어요」 + 있으면 `note`)
- 감사 `attendance.dispute_resolved`(처리자·역할·결정·전후). `dispute_resolved_by_account_id`·`dispute_resolved_at` 을 채운다
- 처리할 수 있는 사람: **표시한 직원 본인**과 **그 학원 대표**(추천 — 데이터 §7-8 의 「처리자가 강사인가 대표인가」가 열려 있었다, 열린 점 ②). 위임 강사·담당 강사가 표시하지 않았다면 처리할 수 없다
- 처리 기한은 잠금(§7)과 무관하다. 레벨 판정(S6-3)이 그 기간을 계산하기 **전에** 처리돼야 한다(spec) — 판정이 돌아간 기간의 행은 409 `DISPUTE_CLOSED`(S6-3 이 정한 뒤 켠다, 열린 점 ⑦)

| 오류 | 언제 |
|---|---|
| 403 `FORBIDDEN` | 표시한 직원도 그 학원 대표도 아니다 |
| 404 `NOT_FOUND` | 표시 없음 |
| 409 `DISPUTE_NOT_PENDING` | 이의가 걸려 있지 않거나(`none`) 이미 처리됨 |
| 409 `DISPUTE_CLOSED` | 레벨 판정이 끝난 기간(S6-3 이후) |
| 422 `VALIDATION_FAILED` | `decision` 값 오류 · `note` 초과 |

### 8-3. 상태 전이 (`attendance_marks`)

```
(없음) ─ 회원 PUT / 직원 POST ─▶ 결석(cancelled_at NULL, dispute none)
결석 ─ 회원 DELETE(시작 전, 회원 행만) ─▶ 취소(cancelled_at 채움)
결석 ─ 직원 cancel(48시간 안 / 잠긴 뒤는 대표만) ─▶ 취소
결석(직원 표시) ─ 회원 이의 ─▶ dispute requested
requested ─ accept ─▶ accepted + 취소(cancelled_at)
requested ─ reject ─▶ rejected (결석 유지)
requested ─ 직원 cancel ─▶ accepted + 취소
```
취소된 행은 지우지 않는다. 감사 기록은 추가 전용이다.

## 9. 내 결제 내역·주문 상태 (S3-4.6 · FR-298 · FR-138 · M16)

| 경로 | 권한 | 역할 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| `GET /api/me/orders` | `requireMember` | **내** 주문 목록 — 상태 6종 그대로, 영수증 링크 | 읽기 | FR-298 · FR-138 | M16 |

단건은 `03-checkout-payment.md` §2 의 `GET /api/orders/{orderId}`(본인 주문)를 그대로 쓴다 — 다시 정의하지 않는다. 대표가 보는 주문 목록은 `18-after-payment-views.md` §2 로 따로다(회원 경로에는 닉네임·다른 사람 정보가 없다).

쿼리: `status`(`pending` · `paid` · `expired` · `cancelled` · `partially_refunded` · `refunded` 중 쉼표로 여러 개 — 6종 이름 그대로, 서버에 칩 이름을 만들지 않는다) · `limit`(기본 20, 최대 50) · `cursor`(`createdAt DESC, id DESC`).

200
```json
{ "items": [
    { "orderId": "…", "status": "partially_refunded", "offeringId": "…", "title": "스윙 원데이 · 9/27 (일)", "academyName": "스윙팩토리 홍대",
      "seatKind": "male", "method": "card", "totalAmount": 30000, "refundedAmount": 15000,
      "createdAt": "…Z", "paidAt": "…Z", "dueAt": null,
      "receipt": { "academyUrl": null, "companyUrl": null, "cashReceiptIssued": false } } ],
  "nextCursor": null }
```
- `status` 는 `constants.ts` 의 주문 상태 6종 값 그대로다(데이터 §4.1). 화면 글자(결제완료·입금 대기·부분 환불…)는 앱이 만든다
- `refundedAmount` 는 `refunds` 완료분 합계(원 정수, README §3). `dueAt` 은 `pending` 일 때만 값이 있다(입금 기한)
- `receipt` 는 실 PG(S8-1)가 채우는 칸이다. 그 전에는 모두 `null`·`false`(데이터 §15-4 ⑥)
- 카드번호·가상계좌 번호·환불 계좌는 목록에 없다(FR-299). 가상계좌 안내가 필요하면 단건 조회로 본다
- 대기 줄 항목(M16 「대기 1번」)은 주문이 아니므로 이 응답에 없다 — `12-refund-cancel-waitlist.md` 의 대기 경로가 정한다

| 오류 | 언제 |
|---|---|
| 401 `UNAUTHENTICATED` · 403 `SIGNUP_INCOMPLETE` | README §4 |
| 422 `VALIDATION_FAILED` | `status` 에 6종 밖의 값 · `limit` 범위 |

## 수용 시나리오 (S3-4.3 ~ S3-4.3c · S3-4.6 ↔ 시험)

1. **Given** 확정 수강생 **When** `PUT …/absence` 후 `DELETE` **Then** 그 회차만 `absence` 가 생기고 되돌리면 `null`, `orders`·`reservations`·`seat_pools`·정산 행은 전후 같다(수용 ①②)
2. **Given** 시작한 회차 **When** 회원이 `PUT`/`DELETE` **Then** 409 `SESSION_ALREADY_STARTED`
3. **Given** 강사가 표시한 결석 **When** 회원이 `DELETE` **Then** 409 `ABSENCE_MARKED_BY_STAFF`
4. **Given** 끝난 지 47시간 **When** 담당 강사가 `POST …/absences` **Then** 201 + 감사 1행 + 회원 알림 1건(수용)
5. **Given** 끝난 지 49시간 **When** 강사·대표가 새로 표시 **Then** 409 `ABSENCE_WINDOW_CLOSED`. 대표가 잠긴 뒤 사유로 취소는 200, 사유 없으면 422, 강사는 403
6. **Given** 회원이 켠 행 **When** 회원이 이의 **Then** 409 `ABSENCE_NOT_DISPUTABLE`(수용)
7. **Given** 강사 표시 행 **When** 회원 이의 → 표시한 강사가 `accept` **Then** `accepted` + `cancelled_at` 채움 + 회원 알림
8. **Given** 부분 환불 픽스처 주문 **When** `GET /api/me/orders` **Then** `status: "partially_refunded"`(수용 ④), 남의 주문은 없다
9. **Given** `POST /api/internal/jobs/absence-lock` 두 번 **Then** 회차당 감사 1행

## 열린 점

근거가 없는 칸·규칙은 모두 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)이다.

| # | 무엇 | 결정 |
|---|---|---|
| ① | spec FR-092e 는 강사·대표가 **수업이 끝난 뒤** 표시한다고 하고, 보드 I26 은 오늘 회차에서 바로 표시 버튼을 둔다 | 시작 시각부터 `ends_at + 48h` 까지 허용(추천). 「끝난 뒤만」으로 좁히려면 §6-1 #3 의 기준을 `ends_at` 으로 바꾼다 |
| ② | 이의 처리자 — 데이터 §7-8 이 값 이름과 처리자(강사인가 대표인가)를 추천안으로 남겼다 | 표시한 직원 본인 + 그 학원 대표(추천). 대표가 표시한 행은 대표만 처리 |
| ③ | spec 은 「표시한 사람의 이름은 회원에게도 역할까지 보인다」 | 응답·알림에는 **역할**(강사·대표)만 내리고 직원 이름은 내리지 않는다(추천 — 직원 개인정보 최소화). 이름까지 보이려면 `markedByName` 칸을 더한다 |
| ④ | 「회원이 미리 알린 결석 예정을 확정」의 모양 | 별도 상태 없이 같은 행으로 둔다(추천). 시작 뒤 회원이 못 지우므로 확정과 같다. 「확정했다」는 기록이 필요하면 감사에 `attendance.confirmed` 를 더한다 |
| ⑤ | 직원이 결석 표시를 취소할 때 회원에게 알릴지 | 알리지 않는다(추천 — 회원에게 불리한 일이 없어진 것이라 이의 처리에서만 알린다) |
| ⑥ | 48시간 잠금을 칸으로 둘지 | 칸 없이 시각 계산 + 작업이 감사 1행(추천). `finalized_at` 칸이 필요해지면 데이터 §7-8 에 더한다 |
| ⑦ | 이의 마감 시점 — spec 은 「레벨 판정 전에 처리」 | 판정이 도는 시점(S6-3)이 정해지면 `DISPUTE_CLOSED` 를 켠다. 그 전에는 마감이 없다(추천). 레벨 판정은 처리 중(`requested`)인 행이 있으면 그 기간 계산을 미루는 것을 S6-3 과 조율 |
| ⑧ | 새 값: `notifications.kind` `absence_marked` · `absence_dispute_requested` · `absence_dispute_resolved` · `audit_logs.action` `attendance.marked` · `.cancelled` · `.dispute_requested` · `.dispute_resolved` · `.session_locked` | 데이터 §15-4 ⑦ 에 더했다 |
| ⑨ | 회원 알림함의 **읽음 처리**(M21 「모두 읽음」)와 종류 칩 거르기는 §2 가 「범위 밖」으로 둔 채다 | 이 절에서도 정의하지 않는다. M21 을 그리는 S3-4.7 이 필요하면 S3-4.5 에 더한다(직원 알림함의 읽음 경로는 `10-owner-dashboard.md`) |

---

# 2026-11-23 더하는 절 — 입금 기한 임박 알림 (S3-4.4)

위 절들은 고치지 않았다. 로드맵 S3-4.4(입금 기한 임박 알림 작업)가 쓰는 내부 경로 하나와 알림 종류 하나다.

**근거 FR**: FR-114a(입금 기한 임박 알림) · 플랜 S3-4 수용 ③(「입금 기한 1시간 전(추천값) 알림 기록이 한 번만 생긴다」) · 플랜 기본값 표 「입금 기한 임박 알림 | 기한 1시간 전(추천값)」
**데이터**: `notifications`(§2-2, 새 kind `payment_deadline_soon` — 데이터 §15-4 ⑧) · `payments`(`method`·`status`·`created_at`·`due_at`) · `orders.status`

## 10. 입금 기한 임박 알림 작업 (S3-4.4 · 내부 경로)

| 경로 | 호출자 | 역할 | 멱등 | 근거 |
|---|---|---|---|---|
| `POST /api/internal/jobs/payment-deadline-reminders` | 시간 작업 실행기(S0-4.4) · 헤더 `X-Internal-Token`(README §1) | 아직 입금하지 않은 가상계좌 주문의 회원에게 「입금 기한이 곧 끝나요」 알림 행 1건 | 예(주문·회원마다 1건) | FR-114a |

- **대상**: 주문 `pending` · 결제 `ready` · 수단 `virtual_account` · 아직 기한 전(`due_at > 지금`). 카드·간편결제는 결제창 기한(15분)이라 빠진다. 기한이 지난 주문은 만료 정리(03 §5)의 몫이라 보내지 않는다
- **알릴 시각** `send_at`: 발급(`payments.created_at`)부터 기한까지가 60분 이상이면 `due_at − 60분`, 더 짧으면 `created_at + (due_at − created_at) ÷ 2`(FR-114a 「그 절반이 지난 시점」). `send_at ≤ 지금` 이면 보낸다
- **한 번만**: 주문 알림이라 기존 유니크 `uq_notifications_kind_order_recipient (kind, order_id, recipient_member_id)` 에 `ON CONFLICT DO NOTHING`. 되풀이·동시 호출 모두 1건. `dedupe_key` 는 쓰지 않는다
- **행**: `recipient_member_id = orders.member_id` · `academy_id`(수업의 학원) · `order_id` · `delivery_status = pending`(발송은 SCH-38(알림)) · `payload = { "title": "입금 기한이 곧 끝나요", "offeringTitle": "…", "amount": 120000, "dueAt": "…Z" }`
- **계좌는 본문에 넣지 않는다**(§2 「금액 외 결제 정보는 넣지 않는다」). 알림을 누르면 앱이 `GET /api/orders/{orderId}`(03 §2)의 `virtualAccount` 로 은행·계좌·예금주를 보여 준다. 남은 시간은 화면이 `dueAt` 에서 계산한다
- 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 읽는다(시험용 시계, 모르는 칸 422). 실행 주기: 10분마다(추천값). 응답 200 `{ "notified": 2 }`

| 오류 | 언제 |
|---|---|
| 401 `UNAUTHENTICATED` | 내부 토큰 없음·불일치(README §1) |
| 422 `VALIDATION_FAILED` | 본문에 모르는 칸·잘못된 `asOf` |

### 10-1. 수용 시나리오 ↔ 시험(`admin-web/tests/db/payment-deadline-reminders.db.test.ts`)

1. **Given** 24시간 기한 가상계좌 주문 **When** 기한 60분 1초 전 작업 **Then** 0건, 60분 전 1건, 그 뒤 다시·동시에 불러도 1건(수용 ③)
2. **Given** 발급~기한 40분 **When** 기한 21분 전 **Then** 0건, 20분 전 1건
3. **Given** 카드 · 입금 완료 · 셀프 취소 주문 **Then** 0건. 기한 순간·지난 뒤 처음 도는 작업도 0건
4. **Given** 토큰 없음 **Then** 401 · 기록 0. 토큰 맞음 **Then** 200 `{notified:1}` → 다시 `{notified:0}`

### 10-2. 열린 점

| # | 무엇 | 결정 |
|---|---|---|
| ① | 알림에 입금 계좌를 직접 넣을지 — FR-114a 는 「입금 계좌」를 보내라 하고 §2 는 계좌번호를 본문에 넣지 말라 한다 | 본문에는 넣지 않고 `orderId` 로 주문 조회에서 보여 준다(임시 확정(2026-11-23 — 추천안으로 진행, 사후 확인)). 푸시 문구에 계좌가 필요해지면 SCH-38(알림) 발송 단계가 주문에서 읽어 채운다 |
| ② | 점검·장애로 기한이 늘어난 뒤(15 §점검 끝내기) 다시 알릴지 | 다시 알리지 않는다 — 주문당 1건(임시 확정, 같은 날). 늘어난 기한은 `payment_deadline_extended` 알림이 알린다 |
| ③ | 결제창 수단(카드·간편결제)도 알릴지 | 알리지 않는다 — 기한 15분이라 알림보다 결제창이 먼저 닫힌다(임시 확정, 같은 날) |
