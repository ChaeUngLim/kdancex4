# API 계약 — 홈 목록·수업 상세 (US1-A2(시드·검색·상세))

공통 규칙은 `README.md`. 관련 요구: FR-030(수업 검색) · FR-033(시간대 필터) · FR-090(정원·신청 인원 표시) · FR-092(성별 정원) · FR-092c(성별 구분 없는 단일 정원) · FR-091a(정원 마감 시 결제·쿠폰 차단).

## 1. `GET /api/home/offerings` — 홈 목록(거르기)

Q1(홈 목록: 거르기 vs 정렬) = **거르기**(사용자 결정 2026-11-06). 질의 조건은 쿼리 문자열이 아니라 **내 프로필**에서 온다.

| 조건 | 출처 | 비어 있으면 |
|---|---|---|
| 장르 | `members.base_genre`(FR-022a(첫 화면 장르 선택·유지)) | 409 `BASE_GENRE_REQUIRED` |
| 지역 | `member_regions` — 학원 `(region_sido, region_gu)` 가 목록 중 하나와 같음 | 조건 빠짐 |
| 시간대 | `available_from~to` — 판매 단위의 **모든 회차**가 KST 하루 시각으로 [from, to] 안에 들어감 | 조건 빠짐 |
| 날짜 | 쿼리 `?from=YYYY-MM-DD&to=YYYY-MM-DD`(선택, KST) — 첫 회차 날짜가 범위 안 | 오늘(KST) 이후 전부 |
| 판매 상태 | `class_offerings.status='open'` 이고 첫 회차 시작이 지금 이후 | — |

정렬: `?sort=` — `recommended`(기본, 추천순) · `deadline`(마감 임박 — 첫 회차 시작이 가까운 순) · `seats`(잔여석 임박 — 남은 자리가 적은 순). 같은 값이면 첫 회차 시작 시각 오름차순 → id. 모르는 값은 422 `VALIDATION_FAILED`. 추천순은 이번 회차에 장르·지역·시간대 일치만 점수로 보고 인기 점수는 0 이다(2026-11-23 사용자 결정 — FR-036a(검색 결과 정렬 5종) 중 검색순·인기순과 조회 수 표는 S6-2 에서 함께, 세는 규칙(하루 1회 vs 1시간 1회)도 그때 정한다). 거르기(Q1)는 정렬과 상관없이 그대로다. 페이지: `?limit=`(기본 20, 최대 50) `&cursor=`(커서는 정렬 값마다 따로).

목록을 읽기 전에 **기한 지난 주문을 정리**한다(`03-checkout-payment.md` §5) — 잔여 숫자가 늦게 풀리지 않게.

응답 200
```json
{ "items": [ {
  "offeringId": "…", "classId": "…", "title": "살사 정규 입문", "genre": "salsa_bachata", "classKind": "regular",
  "academy": { "id": "…", "name": "…", "regionSido": "서울", "regionGu": "강남구" },
  "label": "12월 기간", "enrollmentUnit": "term", "sessionCount": 8,
  "firstSessionStartsAt": "…Z", "lastSessionEndsAt": "…Z",
  "priceAmount": 120000,
  "capacity": { "total": 12, "enrolled": 8,
    "pools": [ {"seatKind":"male","capacity":6,"enrolled":4,"remaining":2},
               {"seatKind":"female","capacity":6,"enrolled":4,"remaining":2} ] }
} ], "nextCursor": null }
```
- `enrolled` = `confirmed_count`, `remaining` = `capacity − held − confirmed`(data-model §4-4)
- 정원이 다 찬 수업도 목록에 남긴다(마감 표시는 앱이 `remaining` 으로)

## 2. `GET /api/offerings/{offeringId}` — 상세

인증 필요(기본 자리 계산에 성별이 필요).

```json
{ "offeringId": "…", "title": "…", "academy": {…}, "instructorName": "…", "instructorId": "…", "label": "12월 기간",
  "sessions": [ {"seq":1,"startsAt":"…Z","endsAt":"…Z"}, … ],
  "priceAmount": 120000, "seatMode": "gender_split",
  "capacity": { …목록과 같음… },
  "seatSelection": { "defaultSeatKind": "male",
    "options": [ {"seatKind":"male","available":true}, {"seatKind":"female","available":false,"reason":"SOLD_OUT"} ] },
  "seller": { "businessName": "…", "representativeName": "…", "businessRegistrationNumber": "1234567890",
              "mailOrderReportNumber": null, "businessAddress": "…", "phone": "…" },
  "refundNotice": { "versionId": "…", "body": "…" },
  "intermediaryNotice": { "version": "2026-11-06", "body": "K-DanceX4 는 통신판매중개자이며 수업의 판매 당사자가 아닙니다" },
  "classKind": "regular",
  "priceBreakdownPreview": [ …README §3 순서… ],
  "myReservation": null }
```

- `instructorId` — 담당 강사 계정 id(담당이 정해지지 않은 옛 수업은 `null`). 앱이 강사 프로필(M15, 계약 16 §4-8)로 넘어갈 때 쓴다(SX-5.7, 추천안·사후 확인 2026-11-24)

기본 자리 규칙(AC-7(성별 자리 기본값)):

| seatMode | 회원 성별 | defaultSeatKind |
|---|---|---|
| `gender_split` | male / female | 같은 성별 자리. **마감이어도 기본 선택은 바꾸지 않는다**(시나리오 6 — 앱이 「마감」 표시 + 결제 버튼 끔, 「대기 가능」 문구는 2회차) |
| `single` | 상관없음 | `any`, `options` 는 1개 |

`available=false` 인 자리로는 주문을 만들 수 없다(409 `SEAT_SOLD_OUT`, FR-091a). 반대 자리가 남아 있으면 앱이 바꿔서 주문한다.

`refundNotice` 가 없으면(학원이 공지를 안 씀) 상세는 200 으로 주되 `refundNotice: null` — 주문 생성이 409 `NOTICE_MISSING` 으로 막는다(FR-282(결제 화면 필수 표시)).

판매자 정보·결제 전 정책(S3-2.4(판매자 정보·결제 전 정책), 2026-11-23 — 임시 확정, 사후 확인):
- `seller` 는 대표 학원 설정(07 열린 점 ⑬ ⓐ 의 `seller`)과 **같은 6항목 목록**이다(`admin-web/lib/domain/seller-info.ts`, 플랜 S1-1 수용 ⑤). 법정 표시 칸이라 전부 공개(data-model §15-1). 학원 행을 그때그때 읽으므로 대표가 고치면 바로 보인다. 통신판매업 신고번호가 없으면 `null`
- `refundNotice` 는 학원의 최신 판본이 아니라 **승인 때 수업에 고정된 판본**(`classes.refund_notice_version_id`)이다. 그 판본이 이 학원 것이 아니거나 없으면 `null`
- (S3-3.15b(결제 화면용 서버 조각), 2026-11-23) `classKind` 는 홈 목록(§1)과 같은 수업 구분 값이다 — 앱이 결제수단 목록(이벤트형은 계좌이체만, FR-280)을 고를 때 쓴다. `priceBreakdownPreview` 는 주문 생성(03 §3)과 **같은 계산 함수**(`computeOrderAmounts`)의 결과라 결제 시작 응답의 `priceBreakdown` 과 같다. 유료 이벤트형이면 `booking_fee` 2,000원 줄이 있고(FR-282a), 정규·0원이면 그 줄이 없다
- `intermediaryNotice` 문구는 spec 「법·규정 표시 점검」 표의 고정 문구, 판본은 03 §1 의 `intermediaryNoticeVersion` 과 같은 `2026-11-06`(`admin-web/lib/domain/intermediary-notice.ts`). 문구를 바꾸면 판본도 바꾼다
