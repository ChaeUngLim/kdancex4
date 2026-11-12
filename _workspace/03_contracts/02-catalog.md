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

정렬: 첫 회차 시작 시각 오름차순 1종(FR-036a(검색 결과 정렬 5종)는 2회차). 페이지: `?limit=`(기본 20, 최대 50) `&cursor=`.

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
{ "offeringId": "…", "title": "…", "academy": {…}, "instructorName": "…", "label": "12월 기간",
  "sessions": [ {"seq":1,"startsAt":"…Z","endsAt":"…Z"}, … ],
  "priceAmount": 120000, "seatMode": "gender_split",
  "capacity": { …목록과 같음… },
  "seatSelection": { "defaultSeatKind": "male",
    "options": [ {"seatKind":"male","available":true}, {"seatKind":"female","available":false,"reason":"SOLD_OUT"} ] },
  "refundNotice": { "versionId": "…", "body": "…" },
  "intermediaryNotice": { "version": "2026-11-06", "body": "회사는 통신판매중개자이며 …" },
  "priceBreakdownPreview": [ …README §3 순서… ],
  "myReservation": null }
```

기본 자리 규칙(AC-7(성별 자리 기본값)):

| seatMode | 회원 성별 | defaultSeatKind |
|---|---|---|
| `gender_split` | male / female | 같은 성별 자리. **마감이어도 기본 선택은 바꾸지 않는다**(시나리오 6 — 앱이 「마감」 표시 + 결제 버튼 끔, 「대기 가능」 문구는 2회차) |
| `single` | 상관없음 | `any`, `options` 는 1개 |

`available=false` 인 자리로는 주문을 만들 수 없다(409 `SEAT_SOLD_OUT`, FR-091a). 반대 자리가 남아 있으면 앱이 바꿔서 주문한다.

`refundNotice` 가 없으면(학원이 공지를 안 씀) 상세는 200 으로 주되 `refundNotice: null` — 주문 생성이 409 `NOTICE_MISSING` 으로 막는다(FR-282(결제 화면 필수 표시)).
