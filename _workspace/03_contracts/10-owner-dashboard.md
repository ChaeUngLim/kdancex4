# API 계약 — 대표 대시보드(W29) · 직원 알림함 (S1-4(학원 공지·대표 대시보드 뼈대·대표 알림함))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §7-7(`notifications` 확장). 관련 요구: FR-079b(대표 대시보드 지표) · FR-080(대표 운영 알림) · FR-145(관리자 웹 알림) · FR-081a(재무 대시보드는 위임 대상 밖). 보드: W29(대시보드, O1 대체) · O21(대표 알림함) · O21B(결제·운영 알림) · O5Q(소속 신청 휴대폰 알림).

## 1. `GET /api/academies/{academyId}/dashboard?date=YYYY-MM-DD` — 권한 `owner` 만

위임 강사는 403(재무 대시보드는 위임 대상 밖, FR-081a). `date` 는 KST 달력 날짜, 기본 오늘.

**M1 의 뼈대 원칙**: 타일마다 `available` 을 둔다. 원천 테이블이 아직 없는 타일(결제·환불·정산·수업)은 `available: false` 와 `availableFrom`(슬라이스)을 주고 숫자 칸은 `null` 이다 — 0 을 내리면 「진짜 0건」과 구별되지 않는다. M1 에서 실제 숫자가 나오는 것은 `todos` 의 소속 신청·약관 변경과 학원 공지 정도다(S1-4 수용 ③ 「타일 숫자 = DB 집계」는 `available: true` 인 타일에만 건다).

응답 200
```json
{ "academyId": "…", "date": "2026-11-11",
  "todayOrders":       { "available": false, "availableFrom": "S3-3", "applications": null, "paidCount": null, "paidAmount": null, "awaitingDeposit": null },
  "refundRequests":    { "available": false, "availableFrom": "S4-1", "regular": null, "event": null, "overdue": null },
  "pendingClassApprovals": { "available": false, "availableFrom": "S2-2", "count": null, "top": null },
  "nearlyFull":        { "available": false, "availableFrom": "S3-3", "items": [] },
  "month":             { "available": false, "availableFrom": "S5-1", "revenue": null, "paymentsCount": null,
                         "settlement": { "completed": null, "scheduled": null, "hold": null } },
  "nextPayout":        { "available": false, "availableFrom": "S5-3", "date": null, "expectedNet": null, "instructorPayoutPending": null },
  "sessions":          { "available": false, "availableFrom": "S2-2", "today": [], "tomorrow": [] },
  "todos": [ { "kind": "affiliation_requested", "title": "아이유 강사 소속 신청", "dueAt": null, "link": "/staff/instructors?status=pending" },
             { "kind": "terms_change_notice", "title": "입점 약관 1.1 · 12월 10일 적용", "dueAt": "2026-12-10T00:00:00Z", "link": "/settings#terms" } ] }
```

타일의 뜻(채워질 때의 계약 — 각 슬라이스가 이 모양을 지킨다)

| 타일 | 셈 | 출처 |
|---|---|---|
| `todayOrders` | 오늘(KST) 생성 주문 수 · `paid` 전이 수와 금액 합 · `pending` 수 | `orders`·`order_events` |
| `refundRequests` | 처리 전 환불 요청을 정규·이벤트형으로, `overdue` = 답할 기한(3영업일) 지남 | S4-1 환불 요청 |
| `pendingClassApprovals` | 승인 대기 수업 수 + 가장 오래된 1건 | S2-2 수업 승인 |
| `nearlyFull` | 첫 회차 전·`open` 판매 단위 중 남은 자리 ≤ 정원의 10% 또는 ≤ 2자리(**추천값**) — 자리 종류별로 | `seat_pools` |
| `month` | 이번 달 결제액·건수, 정산 단계별 금액 | S5-1 원장 |
| `nextPayout` | 다음 정산일·학원 실지급 예상·대표 승인을 기다리는 강사 지급액 | S5-3 |
| `sessions` | 오늘·내일 회차의 시간·수업·강사·홀·성별 확정 인원/정원·결석 예정 수 | 회차·`seat_pools`·`attendance_marks` |
| `todos` | 기한이 있는 일부터 `dueAt` 오름차순, 기한 없는 일은 뒤(W29 「기한이 걸린 일부터」) | 각 원천 |

- 금액은 원 단위 정수, 인원은 결제 완료 기준(W29 각주). 회원 이름·연락처는 넣지 않는다(타일에는 숫자만, `todos.title` 의 회원 표시는 닉네임만)
- 캐시하지 않는다(베타 규모 — 규모 목표 1~10명). 느려지면 S5 에서 집계 테이블을 검토

## 2. 직원 알림함 — 권한 로그인 직원(대표·강사 공통), 웹(`surface='web'`)·앱 모두

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/staff/notifications?academyId=&category=&cursor=&limit=20` | 내 알림 최신순. `category` = `approval`·`signup_close`·`inquiry`·`settlement`·`operations`(O21 칩 「승인 · 신청·마감 · 문의 · 정산」 + O21B 「운영」), 없으면 전체 |
| `GET /api/staff/notifications/unread-count?academyId=` | `{ "total": 3, "byCategory": { "approval": 2, "operations": 1 } }` |
| `POST /api/staff/notifications/{id}/read` | 읽음. 이미 읽었으면 200 같은 본문. 남의 알림은 404(받는 사람 판정 — id 존재를 알리지 않는다) |
| `POST /api/staff/notifications/read-all` | `{ "category": "approval" \| null }` → `{ "updated": 2 }`. 「모두 읽음」(O21) |

항목 모양
```json
{ "id": "…", "kind": "affiliation_requested", "category": "approval", "academyId": "…", "createdAt": "…Z", "readAt": null,
  "payload": { "title": "아이유 강사가 소속을 신청했어요", "body": "살사·바차타 · 「주말 저녁 수업을 맡고 싶어요」",
               "actionLabel": "확인하고 승인", "link": "/staff/instructors?status=pending" } }
```
- `payload` 는 쓰는 쪽이 정한 화면 재료다. 연락처·계좌번호 전체를 넣지 않는다(FR-187·FR-299)
- 관리자 웹에서 받는 사람이 위임 강사면 그 학원 알림 가운데 위임 범위 밖(정산·환불 금액) 종류는 애초에 만들지 않는다 — 판정은 쓰는 쪽(알림 행을 만드는 서비스)이 한다
- 실시간 전달(FR-145 「실시간」)은 이 회차에 폴링(`unread-count` 30초, **추천값**)으로 한다. 푸시·웹 실시간 채널은 S7-1(알림 발송)

M1 이 만드는 직원 알림(받는 사람 · category)

| kind | 받는 사람 | category | 만드는 곳 |
|---|---|---|---|
| `affiliation_requested` | 대표 | `approval` | 08 §2 |
| `affiliation_approved` · `affiliation_rejected` · `delegation_changed` · `share_rate_changed` | 강사 | `operations` | 08 §3·§4 |
| `staff_notice_published` | 강사 | `operations` | 09 §3 |
| `merchant_application_approved` · `merchant_application_rejected` | 신청자 | `operations` | 07 §3 |
| `payout_account_changed` · `terms_change_notice` | 대표 | `operations` | 07 §4·§5 |

알림 설정(O34 — 휴대폰 알림 켜고 끄기, 끌 수 없는 묶음 Q43)은 S7-1 몫이다. 알림함 행은 설정과 상관없이 항상 쓴다(O34 「꺼도 알림함에 남음」).

## 수용 시나리오

1. **Given** 소속 신청 1건이 들어온 학원 **When** 대표가 대시보드를 연다 **Then** `todos` 에 소속 신청 1줄, 결제 타일은 `available: false` 이고 숫자 칸은 `null`
2. **Given** 위임 강사(`roster_view`) **When** `GET …/dashboard` **Then** 403 `FORBIDDEN`
3. **Given** 대표에게 읽지 않은 `approval` 2건·`operations` 1건 **When** `read-all {category: "approval"}` **Then** `updated: 2`, `unread-count.total` 이 1
4. **Given** 강사 A 의 알림 id **When** 강사 B 가 읽음 처리 **Then** 404, A 의 `read_at` 그대로
5. **Given** 같은 소속 신청의 알림 쓰기가 재시도로 두 번 돈다 **When** 대표 알림함 조회 **Then** 1건(`dedupe_key`)

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | `todos` 정렬(기한 있음 → 없음, 기한 오름차순) · 타일 `available` 판정 · 「마감 임박」 경계(남은 2자리 포함, 3자리 제외 — 정원 20 이하일 때) |
| DB | `ck_notifications_one_recipient`(둘 다 채움·둘 다 비움 거부) · `uq_notifications_dedupe` |
| 통합 | 시나리오 1~5 · 학원 B 대표가 학원 A 대시보드 403 · 알림 목록 커서 넘김에서 중복·빠짐 0 |
| E2E(Playwright) | 대표 W29 첫 화면 스크린샷 — 준비 안 된 타일이 「준비 중」으로 보이고 0 으로 보이지 않는지 |

## 열린 점

| # | 무엇 | 결정(① 은 2026-11-19 사용자 확정, 나머지는 사용자 확인 대기) |
|---|---|---|
| ① | 「정원 마감 임박」 기준 — spec·보드에 수치가 없다 | **확정**: 남은 자리가 정원의 10% 이하이거나 2자리 이하 |
| ② | 준비 안 된 타일을 화면에 어떻게 보일지 | 타일은 두고 「M3 부터 보여요」 같은 준비 중 표시(숫자 0 금지) |
| ③ | 관리자 웹 알림의 실시간성 | 30초 폴링으로 시작, 실시간 채널은 S7-1 |
