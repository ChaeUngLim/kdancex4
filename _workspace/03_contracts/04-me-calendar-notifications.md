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
