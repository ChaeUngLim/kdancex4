# API 계약 — 환불·취소·대기 (M4: S4-1(정규 과정 환불 요청·대표 처리 — 비율표 교체) · S4-2(이벤트형 취소·행사 일괄 취소) · S4-3(휴강·폐강·변경과 회원 선택·회차 옮기기) · S4-4(대기·자리 넘김·우선 결제·동반·단체))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §9(`evidence/penpot-doc-sync-2026-11-20/datamodel_draft_M4.md` 를 붙인 절). 작성 2026-11-20.

**근거 FR**: FR-098(대표 처리 환불 방식) · FR-098b(환불 요청 경로) · FR-293(대표 환불 입력) · FR-294(중도 환불 계산 보조) · FR-295(수단별 환불 실행) · FR-296(환불 후 쿠폰 처리) · FR-100(환불 정수 연산) · FR-101(환불 감사 기록) · FR-102(환불 1회 보장) · FR-103(환불 실패 기록) · FR-299(결제 정보 보안) · FR-099c(이벤트형 취소 규정) · FR-099d(환불 마감일 필수 입력·결제 적용) · FR-099e(행사 일괄 취소) · FR-282a(예매 수수료 2,000원) · FR-059(휴강 환불·보강 선택) · FR-065(회차 휴강·폐강 선택) · FR-141(변경·휴강 알림) · FR-109(회차 옮기기) · FR-093(대기 신청·순번) · FR-094·FR-094a(대기 1번 결제 기회·한 명씩 넘김) · FR-095(대기 무응답 승계) · FR-108(대기 마감) · FR-143(대기자 알림) · FR-052b(정규 수업 다음 기간 우선 결제) · FR-105(2인 동반 신청) · FR-178(단체 신청) · FR-097(먼저 입금 건 확정)

**2026-11-20 결정**: D1(계좌 결제분은 일괄 취소여도 W31(계좌 환불 송금) 로 대표가 송금 · 자동 실행은 카드분만, 계좌분은 대표 재알림 + 운영자 확인) · D2(O3 는 이전 안, 화면은 W27·W27B) · D6(접수 뒤 3영업일 안에 답, 승인하면 5영업일 안에 환불) · D9(대기 1번 결제 기회 30분)

**보드**: W27(환불 요청 처리 · 정규형) · W27B(환불 요청 처리 · 이벤트형 — **새로 그리는 중이라 보드 글자가 아직 없다.** 이벤트형 화면의 칸·버튼은 spec FR-098(대표 처리 환불 방식) 예외 문단과 W18 문단 기준이고, W27B 가 끝나면 대조한다) · O48(앱 환불 승인) · O48B(앱 승인 확인 팝업) · O48C(앱 계좌 환불 송금) · W31(웹 계좌 환불 송금) · W18(행사 일괄 취소) · W4a·W4b(환불·취소 공지) · O22(대표 문의함) · M16(내 예약·결제 내역) · M22(문의하기) · C9A(환불 계좌 입력) · C9B(영수증) · C15A·C15B·C15C(환불 요청 상태·상세·결과) · C15D(휴강 선택) · C4C(회차 옮기기) · W19·O43·O44(휴강 처리 현황·수업 간단 수정) · M8·C13B(대기·대기 마감) · M21(알림함) · C5A(다음 기간 우선 결제) · C4A·C4B(2인 동반·단체 신청)

## 0. 교체 관계 — `05-cancellation-migrated.md` 와의 관계

05 는 옛 FastAPI 의 「회원이 예상 환불액을 보고 직접 확정하는」 취소를 동작 그대로 옮겨 둔 임시 경로다(S0-M4). **이 파일이 S4-1 에서 그것을 교체한다**(plan U4). FR-098 이 비율표 자동 적용을 폐지했고 환불은 대표가 정한다.

| 05 의 것 | 이 파일에서 | 시점 |
|---|---|---|
| `GET /api/reservations/{id}/cancellation-preview`(비율표로 예상 환불액) | **경로 유지, 응답 교체** — §2-1. 정규는 금액 대신 공지 요약(앱이 미리 계산하지 않는다), 이벤트형은 수수료 표 계산값 | S4-1.2 → **S4-1.9(옛 코드 걷어 내기)·S4-2.1(취소 수수료 계산) 로 미룸(추천안·사후 확인 2026-11-24)** — 옛 취소 화면이 S4-1.9 전까지 이 응답을 읽고, 이벤트형 계산값은 S4-2.1 의 함수가 있어야 나온다 |
| 회원 직접 확정 취소(05 의 `cancel` 경로) | **폐기.** 정규 = `POST /api/refund-requests`, 이벤트형 = 같은 경로(서버가 상품 종류로 가른다). 호출하면 409 `USE_REFUND_REQUEST`(README §4 의 `USE_ORDER_CANCEL` 과 같은 형식) | S4-1.9(옛 코드 걷어 내기) 전까지는 05 가 동작 |
| `calculateRefund`·`refund-policy.ts`(비율표 산정) | **폐기.** 대체: `suggestRegularRefund`(정규 미리 채움, §1-4) · `calculateEventCancel`(이벤트형 수수료, §1-4). `grep -r calculateRefund admin-web/lib mobile/app` 0건이 M4 완료 조건 | S4-1.9 |
| 비율표 GET·PUT(`/admin/academies/{id}/refund-policy`) | 05 에서 이미 이관하지 않기로 했다. 변함없음 | — |
| 05 가 지키던 **불변식**: 중복 요청 재생 · 환불 1회 · 정원 복구 · PG 실패 시 예약 유지 | **유지한다**(옮긴 테스트가 남는다). 새 구조의 보장은 §1-3 | — |

## 1. 공통

### 1-1. 권한

`○` 허용 · `본인` 자기 것만 · `소속` 자기 학원만 · `-` 불가. 판정은 모두 서버(README §2·§6-2).

| 동작 | 회원 | 강사 | 위임 강사 | 대표 | 운영자 |
|---|---|---|---|---|---|
| 환불 계좌 저장 · 환불 요청 · 철회 · 이벤트형 취소 | 본인 | - | - | - | - |
| 환불 요청 알림 받기(확인만) | - | 담당 수업만 | - | 소속 | - |
| 환불 요청 목록·상세·시작·승인·거절 | - | - | - | 소속 | - |
| 계좌 환불 송금 목록·전체 열람·송금 완료·재입력 요청 | - | - | - | 소속 | - |
| 행사 일괄 취소 확정·재시도 | - | - | - | 소속 | - |
| 행사 취소 요청(사유 적기) | - | 담당 행사만 | - | - | - |
| 휴강 선택·옮기기·대기·우선 결제·동반·단체 | 본인 | - | - | - | - |
| 기한 경과 계좌 환불 조회 | - | - | - | - | 조회만 |

- 대표 경로는 `requireStaff('owner', { academyId, surface })`. 앱(`surface='app'`)·관리자 웹(`surface='web'`, 2단계 인증 후) 둘 다 같은 경로·같은 판정이다(W27 ↔ O48 「같은 규칙」). 위임 강사는 환불·정산 경로가 모두 403(FR-081a(위임 가능한 관리 권한))
- 회원 경로는 `requireMember`. 남의 예약·요청은 403 `FORBIDDEN`(README §4 — 404 로 숨기지 않는다)
- 앱에서 돈이 나가는 승인(§2-3 `decision`·§2-5 `complete`)은 **승인 버튼 → 확인 팝업**(O48B)이 클라이언트 몫이고, 서버는 같은 키로 한 번만 받는다(2026-11-18)

### 1-2. 오류 코드 추가(README §4 표에 더한다)

| HTTP | code | 언제 |
|---|---|---|
| 409 | `USE_REFUND_REQUEST` | 05 의 직접 취소 경로를 부름(폐기됨) |
| 409 | `REFUND_NOT_ALLOWED_STATE` | 예약이 `confirmed` 가 아니거나 주문이 `paid`·`partially_refunded` 가 아님 |
| 409 | `REFUND_REQUEST_OPEN` | 같은 예약에 처리 전 요청이 이미 있음(`uq_refund_requests_open`) — 본문에 `requestId` |
| 409 | `REFUND_ALREADY_DECIDED` | 이미 승인·거절·철회·완료된 요청 |
| 409 | `REFUND_REQUEST_NOT_WITHDRAWABLE` | 정규 요청이 이미 승인·거절·완료됐거나 이벤트형(철회 없음) |
| 409 | `REFUND_DEADLINE_PASSED` | 이벤트형 환불 마감일 뒤 취소 신청(FR-099d). 본문 `deadline` |
| 409 | `REFUND_EXCEEDS_PAID` | 환불 합이 환불 상한(`orders.total_amount − booking_fee_amount`, 법정 청약철회 환불이면 `total_amount` — 2026-11-20 사용자 결정 D15·D21)을 넘음 — SC-010(환불 초과 0건). 본문 `refundableAmount` |
| 409 | `EVENT_REFUND_NOT_REJECTABLE` | 이벤트형 요청을 거절하려 함(FR-293) |
| 409 | `TRANSFER_NOT_PENDING` | 송금 대기가 아닌 건에 송금 완료·재입력 요청 |
| 409 | `EVENT_ALREADY_CANCELLED` | 이미 일괄 취소가 확정된 행사 |
| 409 | `NOT_AN_EVENT_OFFERING` | 이벤트·원데이·파티·공연·대회가 아닌 상품에 일괄 취소 |
| 409 | `CLOSURE_CHOICE_CLOSED` · `CLOSURE_ALREADY_CHOSEN` | 선택 기한이 지났거나 이미 고름 |
| 409 | `MOVE_NOT_ALLOWED` · `MOVE_ALREADY_USED` · `MOVE_DEADLINE_PASSED` · `MOVE_PRICE_DIFFERS` | 학원이 옮기기를 허용하지 않음 · 주문당 1번을 이미 씀(Q26) · 옮기기 마감 뒤 · 가격이 다른 회차 |
| 409 | `WAITLIST_NOT_NEEDED` · `WAITLIST_CLOSED` · `WAITLIST_ALREADY_JOINED` | 자리가 남아 있음 · 시작 24시간 안(FR-108) · 같은 자리 종류에 이미 대기 중 |
| 409 | `OFFER_EXPIRED` | 결제 기회가 지났음 |
| 409 | `PRIORITY_SLOT_CLOSED` | 우선 결제가 마감·결제·반납됨 |
| 409 | `COMPANION_NOT_ACCEPTED` · `GROUP_SEATS_UNAVAILABLE` | 동반자가 아직 수락 전 · 한 자리라도 모자라 전원 실패(본문 `shortBy: [{seatKind, count}]`) |
| 403 | `WAITLIST_MEMBERSHIP_REQUIRED` | 대기 신청은 멤버십 회원·신규 가입 3개월 체험자만(FR-093). 판정은 멤버십(M6)이 켠다 — 그 전에는 모두 허용(열린 점 ⑦) |
| 422 | `ACCOUNT_HOLDER_MISMATCH` | 환불 계좌 예금주가 본인확인 이름과 다름 — 저장 안 됨(FR-295) |
| 422 | `REFUND_ACCOUNT_REQUIRED` | 계좌 결제분인데 환불 계좌가 없음 |
| 422 | `NOTICE_ITEM_REQUIRED` | 승인·거절에 근거 공지 항목이 없음(FR-293 「입력하지 않은 항목이 있으면 처리 완료로 넘어가지 않는다」) |
| 422 | `REFUND_BELOW_COMPUTED` | 이벤트형 승인 금액이 계산값보다 작음(올리기만 된다) |
| 422 | `NAME_CHECK_REQUIRED` | 송금 완료에 이름 대조 확인(`nameChecked: true`)이 없음 |
| 422 | `GROUP_TOO_LARGE` · `VALIDATION_FAILED` | 단체 상한(설정값 10) 초과 · 형식 오류 |

### 1-3. 환불 1회 보장 — 멱등 키와 상태 전이 (FR-102(환불 1회 보장) · SC-007(중복 환불 0건))

README §4.9 에 더하는 표. **세 겹**이다 — ① 같은 요청의 재생 ② 같은 원인의 두 번째 환불 차단 ③ 합계 상한. ②·③ 은 2026-11-20 사용자 결정 D13 으로 확정했다: **원인(`basis`)당 진행 중 1건 + 한 주문 환불 합계 ≤ 결제액(DB CHECK)** — 같은 예약에 서로 다른 원인(휴강 환불 뒤 중도 환불)의 환불은 허용한다(이전: 예약당 1건).

| 대상 | 키 | 처음 | 다시 오면 |
|---|---|---|---|
| `POST /api/refund-requests` | 헤더 `Idempotency-Key`(필수, 8~200자) + 회원 → `uq_refund_requests_idem` | 201 | **200 + 같은 요청**. 키가 달라도 같은 예약에 처리 전 요청이 있으면 409 `REFUND_REQUEST_OPEN`(`uq_refund_requests_open`) |
| 승인(§2-3 `decision`) | 요청 상태 조건부 갱신 `received`·`in_progress` → 결정 + 환불 키 `refund:request:{requestId}:{attemptNo}` → `uq_refunds_idempotency_key` · `uq_refunds_basis_active` | 200 | 이미 승인됐으면 **200 같은 본문**(상태가 아니라 `decisionKind` 를 비교). 다른 결정이면 409 `REFUND_ALREADY_DECIDED` |
| 휴강 선택(§4-1) | `closure_choices` 상태 조건부 갱신 + 키 `refund:closure_choice:{choiceId}:1` | 200 | 같은 선택이면 200 재생, 다른 선택이면 409 `CLOSURE_ALREADY_CHOSEN` |
| 행사 일괄 취소(§3-2) | 헤더 `Idempotency-Key` + `uq_event_cancellations_offering` · 줄마다 `refund:bulk_item:{itemId}:{attemptNo}` | 202 | **재실행은 0건 추가** — 같은 행사는 같은 취소를 돌려주고 새 환불을 만들지 않는다. 재시도(§3-3)는 `failed` 줄만 새 시도 번호로 |
| 송금 완료(§2-5) | 환불 행 상태 조건부 갱신 `pending → succeeded` | 200 | 이미 `succeeded` 면 200 같은 본문(두 번 눌러도 한 번만 완료, W31 「같은 건은 한 번만 완료돼요」) |
| 모든 환불의 합 | `orders.refunded_total_amount` 조건부 증가 + `ck_orders_refunded_cap`(환불 합계 ≤ 결제액 − 예매 수수료, 법정 청약철회 환불이면 ≤ 결제액 — 2026-11-20 사용자 결정 D13·D15·D21) | — | 넘으면 0행 → 409 `REFUND_EXCEEDS_PAID`, 그 처리 전체 롤백 |
| 대기 신청 · 우선 결제 반납 · 옮기기 | `uq_waitlist_member_active` · `uq_priority_source_next` · `uq_moves_order_reschedule` | 201·200 | 같은 키·같은 상태면 200 재생, 아니면 위 409 |

**PG 호출은 트랜잭션 밖에서 한 번만 한다**(README §5 와 같은 방식). 순서: ① 한 트랜잭션에서 환불 행 `pending` INSERT + 합계 증가 + 요청 전이 → 커밋 ② `PaymentGatewayPort.refund` 호출(키 = 환불의 `idempotency_key`, 포트가 같은 키는 같은 결과를 돌려준다) ③ 새 트랜잭션에서 `pending → succeeded|failed` 조건부 갱신 + 주문 상태 + `refund_events` + 알림. ②에서 프로세스가 죽어도 `pending` 행이 남아 같은 키로 다시 부르면 수렴한다. `failed` 면 합계 증가를 되돌려 뺀다(같은 트랜잭션).

### 1-4. 계산 함수(순수 함수, DB·IO 없음 — 06 의 `calculateRefund` 를 대체)

```ts
// admin-web/lib/domain/refund-suggestion.ts — FR-294(중도 환불 계산 보조). 대표 화면의 미리 채움값일 뿐 확정이 아니다
suggestRegularRefund(input: {
  paidAmount: number;               // orders.total_amount (정규는 예매 수수료 0)
  sessionsTotal: number;            // 주문 스냅샷의 회차 수
  sessionsElapsed: number;          // 요청 시각(now) 이전에 끝난 회차 수
  notice: { tiers: { point: 'before_start'|'before_one_third'|'before_half'|'after_half'; percent: number }[] };
}): { point: string; percent: number; suggestedAmount: number; perSessionAmount: number; remainingSessions: number }
// suggestedAmount = ceilMulDiv(paidAmount, percent, 100) — 원 미만 올림(FR-100). perSessionAmount = ceilMulDiv(paidAmount, 1, sessionsTotal)
// 예: 160,000원 4회 · 1회 진행 → 시점 before_one_third · 67% → 107,200원 · 회차당 40,000원 · 남은 3회 (O48)

// admin-web/lib/domain/event-cancel-fee.ts — FR-099c·FR-099d·Q24(수수료 기준 금액 = 참가비, 임시 확정). 이벤트형 취소 신청 시각 기준
calculateEventCancel(input: {
  participationAmount: number;      // 할인·쿠폰 뒤 실제로 낸 참가비(예매 수수료 제외)
  bookingFeeAmount: number;         // 2,000 — 돌려주지 않는다(FR-282a). 법정 청약철회(수업 시작 전 · 법정 철회 기간 안의 단순 취소)만 예외로 전액 돌려준다(D21, 아래 statutoryWithdrawal)
  paidAt: Temporal.Instant; now: Temporal.Instant;
  eventStartsAt: Temporal.Instant; refundDeadline: Temporal.PlainDate;     // 주문 스냅샷 값(FR-284)
  feeTiers: { window: 'd10_plus'|'d9_d7'|'d6_d3'|'d2_to_deadline'; percent: number }[];  // 주문이 가리키는 공지 판본
}): { ok: true; window: string; feeBp: number; feeAmount: number; refundAmount: number; statutoryWithdrawal: boolean; bookingFeeRefund: number }
  | { ok: false; reason: 'DEADLINE_PASSED' }
// 법정 청약철회(2026-11-20 사용자 결정 D21): 행사 시작 전이고 결제 후 법정 철회 기간(7일, FR-297a) 안의 회원 단순 취소면 statutoryWithdrawal = true → bookingFeeRefund = bookingFeeAmount(예매 수수료까지 전액), 환불 원인 basis_kind 는 'statutory_withdrawal'. 아니면 false 이고 bookingFeeRefund = 0. 이 판정 기준(결제 후 7일·시작 전)은 법률 검토 대상이다(spec FR-282a ⚠). 청약철회로 돌려주는 예매 수수료 2,000원은 플랫폼 부담이다(2026-11-20 사용자 결정 D23): 카드분은 PG 전액 환불, 계좌분은 대표가 전액 송금한 뒤 송금 완료 때 M5 가 정산 원장 보전 줄 `booking_fee_reimbursement`(13 계약)을 만든다 — 이 계약은 줄을 만들지 않고 `refunds` 의 원인·실행 종류만 남긴다
// feeAmount = floorMulDiv(participationAmount, feeBp, 10000), refundAmount = participationAmount − feeAmount (= ceilMulDiv(participationAmount, 10000 − feeBp, 10000), 회원에게 유리)
// 순서(FR-099c): 마감일(KST) 다음 날부터 DEADLINE_PASSED → 결제 당일 자정 전 취소는 feeBp 0(window same_day) → 행사까지 10일 이상 남고 결제 후 7일 이내면 0(paid_within_7d_full) → 그 밖은 표(d10_plus … d2_to_deadline)
// 예: 참가비 30,000원 · 6일 전 · 학원이 15%로 낮춘 표 → 수수료 4,500원 · 환불 25,500원 · 예매 수수료 2,000원은 별도로 안 돌려줌(법정 청약철회면 statutoryWithdrawal=true 로 2,000원까지 전액)
```

휴강 1회 금액: `ceilMulDiv(total_amount, 1, session_count)`(`closureUnitAmount`, S4-3.2). 예: 120,000원 8회 → 15,000원, 90,000원 8회 → 11,250원, 300,000원 16회 → 18,750원, 45,000원 8회 → 5,625원.

영업일 계산 `addBusinessDays(from, n)` 은 S0-4.8 이 만든다(토·일·공휴일 제외, 공휴일은 운영자가 입력). 이 파일은 그 함수를 부르기만 한다.

### 1-5. 설정값

한 곳(`lib/domain/settings.ts` 상수)에 둔다: `REFUND_ANSWER_BUSINESS_DAYS=3`(답할 기한, 추천값 O-09) · `REFUND_DUE_SOON_HOUR_KST=9`(기한 하루 전 오전 9시 예고) · `CLOSURE_CHOICE_DAYS=7` · `WAITLIST_OFFER_MINUTES=30`(D9) · `WAITLIST_JOIN_CLOSE_HOURS=24` · `WAITLIST_END_BEFORE_START_HOURS=3` · `PRIORITY_DEADLINE_DAYS_BEFORE_START=3` · `COMPANION_GROUP_MAX=10`(추천값).

---

## 2. S4-1 — 정규 과정 환불 요청 · 대표 처리 · 계좌 환불 송금

### 2-1. 회원 쪽

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/reservations/{reservationId}/cancellation-preview` | 취소 전 안내(05 경로, 응답 교체) | 읽기 | FR-098b · FR-099c · M16 · C25A |
| `POST /api/refund-accounts` | 환불 계좌 저장(본인 명의 확인) | 주문당 활성 1건 | FR-295 · FR-299 · C9A |
| `POST /api/refund-requests` | 환불 요청(정규) · 취소 신청(이벤트형) | 헤더 `Idempotency-Key` 필수 | FR-098b · FR-099c · M22 · C9A |
| `GET /api/refund-requests?status=&cursor=&limit=20` | 내 환불 요청 목록 | 읽기 | C15A |
| `GET /api/refund-requests/{requestId}` | 상태·진행 단계·결과 | 읽기 | C15B · C15C |
| `POST /api/refund-requests/{requestId}/withdraw` | 철회(정규, 처리 전만) | 상태 조건부 | M-06 · C15B |
| `POST /api/refund-requests/{requestId}/account` | 송금 실패·반송 뒤 계좌 다시 입력 | 시도 번호 | FR-295 · C9A |
| `GET /api/me/refunds?cursor=` | 환불 내역(요청·휴강·일괄 취소 전부) | 읽기 | M16 · C15C |

`GET /api/reservations/{reservationId}/cancellation-preview` 200
```json
{ "reservationId": "…", "kind": "event", "refundable": true,
  "refundDeadline": "2026-10-15", "participationAmount": 30000, "bookingFeeAmount": 2000,
  "estimate": { "window": "d6_d3", "feeBp": 1500, "feeAmount": 4500, "refundAmount": 25500, "bookingFeeNotRefunded": 2000, "statutoryWithdrawal": false },
  "paymentMethod": "virtual_account", "needsRefundAccount": true,
  "notice": { "version": 3, "processingBusinessDays": 3, "ownerContact": "02-000-0000" } }
```
정규(`kind: "regular"`)는 `estimate: null` 이고 `notice.summary`(시점별 환불 기준 문구)만 준다 — 「환불 금액은 학원 대표가 정해요, 앱이 미리 계산하지 않아요」(C15B). 마감일 뒤 이벤트형은 `refundable: false`(+ `reason: "DEADLINE_PASSED"`).

`POST /api/refund-accounts` — 요청
```json
{ "orderId": "…", "bankCode": "004", "accountNumber": "000000-00-000000", "holderName": "김서연" }
```
201
```json
{ "refundAccountId": "…", "accountMasked": "국민은행 ****-**-7890", "holderMatchesIdentity": true }
```
- 예금주 = 본인확인 이름(`members.name`, 공백 제거·유니코드 정규화 뒤 비교)이 아니면 422 `ACCOUNT_HOLDER_MISMATCH` — 행이 만들어지지 않는다. 유료 계좌 실명 조회는 쓰지 않는다(2026-11-19 결정, S4-1.2a)
- 응답·로그·감사에는 **가린 값만**(FR-299). 번호 원문은 어디에도 돌려주지 않는다. 같은 주문에 다시 저장하면 옛 계좌가 `superseded`
- 카드 결제 주문이면 422 `VALIDATION_FAILED`(카드분에는 계좌 칸이 나오지 않는다)
- S4-1.2a 구현 범위(추천안·사후 확인 2026-11-24): 가린 값은 은행 이름을 은행 표(`lib/bank-options.ts`) 그대로 써서 「KB국민은행 ****-**-7890」 · `bankCode` 는 그 표의 코드만(아니면 422 `VALIDATION_FAILED`) · 결제 완료 원거래가 없는 주문(입금 전)은 409 `REFUND_NOT_ALLOWED_STATE` · 서버 로그는 `[refund-account] saved|holder_mismatch order=… account=****7890` 한 줄(끝 4자리만) · 감사 `refund_account.saved`(가린 값만, 예금주 이름 없음) · 응답 `Cache-Control: no-store` · 예금주 비교는 NFC 정규화 + 모든 공백 제거

`POST /api/refund-requests` — 요청
```json
{ "reservationId": "…", "reasonKind": "schedule_change", "reasonText": "일정이 바뀌어 더 다닐 수 없어요",
  "desiredText": "남은 회차 환불", "refundAccountId": "…" }
```
서버 순서(**한 트랜잭션**)

| # | 단계 | 실패 시 |
|---|---|---|
| 1 | 같은 회원·같은 키 요청이 있으면 그대로 200 | — |
| 2 | 예약 소유자 확인 · 예약 `confirmed` · 주문 `paid`/`partially_refunded` | 403 · 409 `REFUND_NOT_ALLOWED_STATE` |
| 3 | 처리 전 요청이 없는지(`uq_refund_requests_open`) | 409 `REFUND_REQUEST_OPEN` |
| 4 | 계좌 결제분이면 `refundAccountId` 가 이 주문의 활성 계좌인지 | 422 `REFUND_ACCOUNT_REQUIRED` |
| 5 | 주문 스냅샷의 상품 종류로 `kind` 결정 — 정규·개인 레슨·단기는 `regular`, 이벤트·원데이·파티·공연·대회는 `event` | — |
| 6-a | `regular`: `answer_due_at = addBusinessDays(now, 3)` · `suggested_amount` 는 대표가 상세를 처음 열 때 **접수 시각 `received_at` 기준**으로 계산해 저장(늦게 열어도 같은 값) · 상태 `received` | — |
| 6-b | `event`: 마감일이 지났으면 409 `REFUND_DEADLINE_PASSED` · `calculateEventCancel` 로 수수료·환불액 고정(`suggested_amount`) · **예약 `cancelled`(`event_member_cancel`)·자리 −1·캘린더 삭제** · `answer_due_at = addBusinessDays(now, 공지의 processingBusinessDays)` | 409 |
| 7 | 알림: 대표(`refund_request_received_owner`) · 담당 강사(`refund_request_notice_instructor`, 확인만) · 회원 `refund_request_received` · 감사 `refund_request.created` · 이벤트형이면 커밋 뒤 `advanceWaitlist`(§5-3) | — |

응답 201(재생은 200)
```json
{ "requestId": "…", "kind": "regular", "status": "received", "receivedAt": "2026-11-05T05:20:00Z",
  "answerDueAt": "2026-11-10T05:20:00Z", "displayStatus": "received", "withdrawable": true,
  "progress": [ { "step": "received", "at": "2026-11-05T05:20:00Z" } ] }
```
- `displayStatus`: 저장 값이 아니라 계산값이다 — 기한이 지났는데 `received`·`in_progress` 면 `"pending_overdue"`(회원 화면 「처리 대기 중」, C15A·C15B). 내 예약 카드도 같은 값을 쓴다(M-06)
- **S4-1.2 구현 범위(추천안·사후 확인 2026-11-24)**: 정규(`kind: regular`)만 받는다. 이벤트형은 6-b(수수료 고정·예약 취소·자리 반납)가 S4-2 몫이라 그 전에는 409 `REFUND_NOT_ALLOWED_STATE`(「이벤트형 수업의 취소 신청은 아직 받을 수 없어요」)로 막는다. 7단계 알림 3종(`refund_request_received_owner`·`refund_request_notice_instructor`·`refund_request_received`)은 알림 kind 마이그레이션이 필요해 같은 묶음 kind 를 더하는 S4-1.8(환불 처리 기한 재알림 작업)로 넘기고, 감사 `refund_request.created`·`refund_request.withdrawn` 만 남긴다. 카드·간편결제 주문에 `refundAccountId` 를 보내면 422 `VALIDATION_FAILED`. 409 `REFUND_REQUEST_OPEN` 본문의 `requestId` 는 이미 처리 전인 요청 id 다
- 정규 환불 요청은 앱 문의(M22) 화면에서 「환불 요청」 종류로 들어오고 같은 경로를 쓴다. 문의함(S7-2)의 항목과 이 요청은 `refund_requests.id` 로 이어진다(열린 점 ⑧)

`GET /api/refund-requests/{requestId}` 200 — 진행·결과(C15B·C15C)
```json
{ "requestId": "…", "kind": "regular", "status": "completed", "displayStatus": "completed",
  "reservation": { "reservationId": "…", "title": "바차타 센슈얼 입문 · 10월", "academyName": "라틴하우스 강남" },
  "paidAmount": 90000, "paymentMethod": "card",
  "progress": [ { "step": "received", "at": "2026-10-08T05:00:00Z" }, { "step": "in_progress", "at": "2026-10-08T06:10:00Z" },
                { "step": "completed", "at": "2026-10-09T05:20:00Z" } ],
  "decision": { "kind": "approved", "amount": 60000, "noticeItemCode": "tier:before_one_third", "noticeItemLabel": "2항 · 총 기간 1/3 지나기 전 · 67% 반환", "memberMessage": null },
  "refund": { "method": "card", "executionKind": "pg_cancel", "status": "succeeded", "refundedAmount": 60000,
              "accountMasked": null, "note": "카드사에 따라 영업일이 걸려요", "failure": null },
  "withdrawable": false }
```
거절이면 `decision.kind: "rejected"` + `noticeItemCode`·`noticeItemLabel`(C15A 「근거 · 환불·취소 공지 2항」), `refund: null`. 환불 실패면 `refund.failure: { "code": "GATEWAY_REJECTED", "nextStep": "…" }`(C15C 「사유와 다음에 할 일」). 계좌분이 송금 대기면 `refund.status: "pending"` + `accountMasked` + 「대표가 은행에서 보내면 완료돼요」 문구용 `transferDueAt`.

`POST /api/refund-requests/{requestId}/withdraw` — 본문 없음. 200 `{ "status": "withdrawn" }`. `received`·`in_progress` 의 **정규**만 된다(처리 중 이후·이벤트형은 409 `REFUND_REQUEST_NOT_WITHDRAWABLE`). 같은 상태면 200 재생. 수용: 처리 전 철회 성공, 처리 중(승인 뒤) 철회 거부(S4-1 수용 ④). 예약은 그대로 남는다.

> 「처리 중」의 정의 — 대표가 §2-2 의 `start` 를 눌러 상태가 `in_progress` 가 되면 **철회는 계속 된다**(승인 전이므로). 승인(`decision=approved`)이 서면 이후 철회는 거부된다. 즉 철회 가능 = `decision_kind IS NULL` 인 `received`·`in_progress`(열린 점 ③).

`POST /api/refund-requests/{requestId}/account` — 요청 `{ "refundAccountId": "…" }`. 송금 실패(이름 불일치·반송)로 `reinput_requested_at` 이 찍힌 요청에만 된다(아니면 409 `REFUND_ALREADY_DECIDED`). 한 트랜잭션: 새 계좌 연결 · 새 시도 행(`attempt_no + 1`, `pending`, 새 `transfer_due_at`) · 대표에게 W31 줄 다시 올림 알림.

`GET /api/me/refunds?cursor=` — `{ items: [{ refundId, source: "request"|"closure"|"bulk_cancel", title, amount, method, status, at }], nextCursor }`. M16 「환불 내역」·C15C 목록용.

### 2-2. 환불 요청 처리 — 대표(W27 · O48 · O22)

권한 `owner`, 웹·앱 공통. 학원 범위 `{academyId}`.

| 메서드·경로 | 설명 | 근거 FR · 보드 |
|---|---|---|
| `GET /api/academies/{academyId}/refund-requests?kind=&status=&overdue=&cursor=&limit=20` | 환불 요청 목록(탭: 정규형·이벤트형·기한 지남·처리 끝) | FR-098b · W27 · O22 |
| `GET /api/academies/{academyId}/refund-requests/{requestId}` | 요청 상세(결제·계산 보조·미리 채움·근거 항목 목록) | FR-293 · FR-294 · O48 · W27 |
| `POST /api/academies/{academyId}/refund-requests/{requestId}/start` | 처리 시작(`received → in_progress`) | M-06 |
| `POST /api/academies/{academyId}/refund-requests/{requestId}/decision` | 승인(환불 실행) · 거절 | FR-293 · FR-295 · O48 · O48B · W27 · W27B |

`GET …/refund-requests` 200
```json
{ "counts": { "regular": 3, "event": 2, "overdue": 1, "done": 14 },
  "items": [ { "requestId": "…", "kind": "regular", "member": { "nickname": "살사러버" },
               "classTitle": "살사 온투 기초 · 4회", "receivedAt": "2026-11-05T05:20:00Z", "answerDueAt": "2026-11-10T05:20:00Z",
               "dueState": "overdue", "daysLeft": -1, "paidAmount": 180000, "paymentMethod": "card", "status": "received" } ],
  "nextCursor": null }
```
- `dueState`: `ok` · `due_soon`(하루 이내) · `overdue`(지남). 목록은 기한이 가까운 것부터. 연락처·계좌는 넣지 않는다. 회원 표시는 닉네임(FR-187(연락처 마스킹))
- 기한 3영업일 설명 문구(W27 「3영업일 세는 법」)는 화면 고정 문구다

`GET …/refund-requests/{requestId}` 200
```json
{ "requestId": "…", "kind": "regular", "status": "in_progress",
  "member": { "nickname": "살사러버" }, "classTitle": "살사 온투 기초 · 4회",
  "paidAmount": 180000, "paymentMethod": "card", "receivedAt": "…Z", "answerDueAt": "…Z", "dueState": "overdue",
  "reason": { "kind": "schedule_change", "text": "일정이 바뀌어 더 다닐 수 없어요", "desired": "남은 회차 환불" },
  "noticeItems": [ { "code": "tier:before_start", "label": "1항 · 수강 시작 전 · 100%", "percent": 100 },
                   { "code": "tier:before_one_third", "label": "2항 · 총 기간 1/3 지나기 전 · 67%", "percent": 67 },
                   { "code": "tier:before_half", "label": "…", "percent": 67 }, { "code": "tier:after_half", "label": "…", "percent": 0 },
                   { "code": "no_refund_case", "label": "환불이 안 되는 경우 · 이미 들은 회차", "percent": null } ],
  "assist": { "sessionsTotal": 4, "sessionsElapsed": 1, "remainingSessions": 3, "perSessionAmount": 45000,
              "appliedPoint": "before_one_third", "appliedPercent": 67, "suggestedAmount": 120600,
              "explain": "180,000원 × 67% — 학원이 공지한 환불 규정으로 미리 채웠어요" },
  "maxAmount": 180000, "refundableAmount": 180000, "notice": { "version": 3, "processingBusinessDays": 5 },
  "refundAccount": { "accountMasked": null } }
```
- 이벤트형(`kind: "event"`)은 `assist` 대신 `eventCancel`: `{ window, feeBp, feeAmount, computedAmount, bookingFeeNotRefunded, statutoryWithdrawal, canRaiseOnly: true }`(법정 청약철회면 `bookingFeeNotRefunded` 0 · `computedAmount` 에 예매 수수료가 더해진다, 2026-11-20 사용자 결정 D21) 이고 `noticeItems` 는 수수료 표 항목(`window:d9_d7` …). 거절 버튼용 필드는 없다
- 계좌 결제분은 `refundAccount.accountMasked`(가린 값)만 준다. 전체는 §2-5 `reveal-account` 로만
- `refundableAmount` = `total_amount − refunded_total_amount`(결제액까지 입력 가능 문구용, O48 「결제 금액 160,000원까지 넣을 수 있어요」)

`POST …/start` — 본문 없음, 200 `{ "status": "in_progress", "inProgressAt": "…Z" }`. 이미 `in_progress` 면 200 같은 본문. 승인·거절·철회된 요청이면 409 `REFUND_ALREADY_DECIDED`. 대표가 상세를 열어 「처리하기」를 눌렀을 때 화면이 부른다(**읽기 GET 은 상태를 바꾸지 않는다**, 열린 점 ④).

### 2-3. `POST …/refund-requests/{requestId}/decision` — 승인 · 거절

헤더 `Idempotency-Key`(필수). 요청 — 승인
```json
{ "decision": "approve", "amount": 107200, "noticeItemCode": "tier:before_one_third", "memberMessage": "이번에는 아쉽지만 다음 수업에서 또 만나요" }
```
거절
```json
{ "decision": "reject", "noticeItemCode": "tier:after_half", "memberMessage": "총 기간의 1/2 이 지난 뒤라 환불이 어려워요" }
```

| 검사 | 실패 시 |
|---|---|
| 요청이 `received`·`in_progress` 이고 `decision_kind IS NULL` | 409 `REFUND_ALREADY_DECIDED`(같은 결정의 재생은 200) |
| 승인: `0 ≤ amount ≤ 주문의 환불 가능액`(= 결제액 − 예매 수수료 − 이미 잡힌 환불 합, 법정 청약철회면 예매 수수료를 빼지 않는다 — D15·D21) | 409 `REFUND_EXCEEDS_PAID`(본문 `refundableAmount`) |
| 승인·거절 모두 `noticeItemCode` 가 이 요청의 `noticeItems` 안에 있음 | 422 `NOTICE_ITEM_REQUIRED` |
| 이벤트형: `amount ≥ suggestedAmount`(올리기만) · 거절 불가 | 422 `REFUND_BELOW_COMPUTED` · 409 `EVENT_REFUND_NOT_REJECTABLE` |
| 계좌 결제분 승인: 활성 환불 계좌가 있음 | 422 `REFUND_ACCOUNT_REQUIRED` |
| `amount` 가 정수이고 0 이상(부동소수 금지, FR-100) | 422 `VALIDATION_FAILED` |
| 서버가 결제액과 **다시 비교**한다(클라이언트가 보낸 `maxAmount` 를 믿지 않는다, S4-1.4) | 위와 같음 |

승인 트랜잭션(한 번에): 요청에 결정 기록(`decision_kind`·`decided_amount`·`notice_item_code`·`decided_by`) · `refunds` 행 INSERT(`pending`, `basis=request`, `execution_kind` = 원결제가 카드면 `pg_cancel`, 계좌(가상계좌·간편 계좌이체)면 `owner_bank_transfer`, 계좌분은 `transfer_due_at = addBusinessDays(now, 공지의 processingBusinessDays)` — 정규 기본 5영업일(D6), 이벤트형 상한 3) · 주문 합계 조건부 증가 · **정규는 예약 `cancelled`(`refund_regular`)·자리 −1·캘린더 삭제**(이벤트형은 신청 때 이미 처리) · 감사 `refund_request.approved` · `refund_events`. 커밋 뒤:
- 카드: 포트 `refund`(부분 취소) → 성공이면 §1-3 ③ 으로 `succeeded` · 요청 `completed` · 주문 `partially_refunded`/`refunded` · 알림 `refund_completed`. 실패면 `failed`(합계 되돌림, 사유 기록) · 요청은 `in_progress` 로 남고 대표에게 `refund_failed_owner` · 회원에게 `refund_failed_member`. **같은 요청을 대표가 다시 승인하면 새 시도 행**(`attempt_no + 1`)이 만들어진다(FR-103 「재시도 가능한 상태로 유지」)
- 계좌: 송금 대기(`pending`)로 W31·O48C 목록에 오른다. 포트는 부르지 않는다(플랫폼은 돈을 보내지 않는다)
- 쿠폰: 전액 환불이고 유효기간이 남았으면 쿠폰을 되살리고, 부분 환불이면 되살리지 않는다(FR-296). 대학생 혜택 회차는 전액일 때만 되돌린다. **실제 처리는 M6 의 쿠폰 엔티티가 생긴 뒤** — 이 슬라이스는 환불 `succeeded` 때 호출하는 훅(`onRefundSucceeded`)만 둔다

응답 200
```json
{ "requestId": "…", "status": "in_progress", "decisionKind": "approved", "decidedAmount": 107200,
  "refund": { "refundId": "…", "executionKind": "pg_cancel", "status": "succeeded", "refundedAmount": 107200 },
  "orderStatus": "partially_refunded" }
```
거절 200: `{ "status": "rejected", "decisionKind": "rejected", "refund": null }`(회원에게 `refund_rejected`, 근거 항목 포함).
- **S4-1.4 구현 범위(추천안·사후 확인 2026-11-24)**: 상세 GET 과 decision POST 만 만든다. 승인은 결정만 적고(`status` `in_progress`·`decision_kind` `approved`·`decided_amount`·`notice_item_code`·`decided_by`·감사 `refund_request.approved`) `refunds` 행·포트 호출·예약 취소·알림은 S4-1.5·S4-1.7 이 붙인다 — 그 전 승인 응답은 `refund: null`, `orderStatus` 는 지금 주문 상태다. 거절은 바로 `rejected` + 감사 `refund_request.rejected`. 환불 상한의 「이미 잡힌 환불 합」 = 실패 아닌 `refunds` 합 + 같은 주문의 승인됐지만 실행 전인 다른 요청 금액. 응답에 두 칸을 더했다: decision 응답 `noticeItemCode`, 상세 `decision`(이미 선 결정 · 없으면 null). 상세 `eventCancel` 의 `bookingFeeNotRefunded`·`statutoryWithdrawal` 은 S4-2.1 계산과 함께 넣는다. `Idempotency-Key` 는 필수로만 받고 저장하지 않는다(같은 결정 재생은 `decision_kind` 비교로 200). 진행 회차는 요청을 받은 시각 이전에 끝난 회차로 센다(대표가 늦게 열어도 미리 채움값이 같다). 옛 공지 판본에 시점이 다 없으면 적힌 항목 + 「환불이 안 되는 경우」만 근거로 주고 미리 채움은 null
- **S4-1.5 구현 범위(추천안·사후 확인 2026-11-24)**: 승인 트랜잭션 안에서 `refunds` 행(`pending`, `basis_kind=request`, `executed_by=owner`, 키 `refund:request:{requestId}:{attempt_no}`) INSERT + 주문 `refunded_total_amount` 조건부 증가(0행이면 409 `REFUND_EXCEEDS_PAID` 로 승인까지 롤백) + `refund_events` `refund_requested`. 커밋 뒤 카드·간편결제만 포트 `refund`(부분 취소)를 부르고, 새 트랜잭션에서 `pending → succeeded|failed` 조건부 갱신(성공이면 요청 `completed`, 실패면 합계를 되돌리고 요청은 `in_progress`). 계좌분은 `owner_bank_transfer` `pending` + `transfer_due_at`(공지 처리 기간 없으면 5영업일)에서 멈추고 포트를 부르지 않는다. 0원 승인은 환불 행 없이 요청 `completed`. PG 결과를 못 받으면(네트워크 오류) `pending` 으로 두고, 같은 결정 재생(200)이 같은 키로 다시 불러 수렴한다. 승인 응답의 `refund` 는 위 행(`refundId`·`executionKind`·`status`·`refundedAmount`)이다. **아직 하지 않는 것**: 주문 `partially_refunded`·`refunded` 전이·감사 `refund.*`·결과 알림·실패 뒤 새 시도 행(`attempt_no + 1`)은 S4-1.7, 정규 예약 취소·자리 반납도 S4-1.7 과 함께 — 그 전 `orderStatus` 는 `paid` 그대로다

### 2-4. 기한 알림·자동 실행 — 내부 작업 §6 참고

접수 뒤 3영업일이 지나면 대표 재알림 + 회원 「처리 대기 중」(운영자에게 넘기지 않는다, FR-098b). 이벤트형 카드 결제분은 공지의 처리 기간이 지나도 실행이 없으면 **시스템이 계산된 금액으로 자동 실행**(`decision_kind=auto`, `executed_by=system_deadline`)한다. **계좌분은 자동 실행하지 않는다**(D1) — §6 `refund-transfer-overdue`.

### 2-5. 계좌 환불 송금 — 대표(W31 · O48C), 웹·앱 공통

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/academies/{academyId}/refund-transfers?state=&cursor=&limit=20` | 송금 목록(요약 띠 + 줄) | 읽기 | FR-295 · W31 |
| `GET /api/academies/{academyId}/refund-transfers/{refundId}` | 한 건 상세(가린 계좌) | 읽기 | O48C · W31 |
| `POST /api/academies/{academyId}/refund-transfers/{refundId}/reveal-account` | 계좌 전체 보기(열람 기록) | 열 때마다 기록 | FR-299 |
| `POST /api/academies/{academyId}/refund-transfers/{refundId}/complete` | 「송금 완료」 | 환불 상태 조건부 | FR-295 · FR-102 |
| `POST /api/academies/{academyId}/refund-transfers/{refundId}/request-reinput` | 「이름이 달라요 · 다시 입력 요청」 | 상태 조건부 | FR-295 |

`GET …/refund-transfers?state=pending` 200 — `state` = `pending`(송금 대기) · `done`(송금 완료) · `reinput`(다시 입력 요청) · 생략하면 전체
```json
{ "summary": { "pendingCount": 4, "pendingAmount": 242200, "earliestDueAt": "2026-11-19T15:00:00Z" },
  "items": [ { "refundId": "…", "memberNickname": "sy_dance", "source": "bulk_cancel", "title": "바차타 워크숍 10/20 (행사 취소)",
               "amount": 45000, "accountMasked": "신한 ****-**-3627", "holderName": "김서연",
               "approvedAt": "2026-11-17T05:20:00Z", "dueAt": "2026-11-20T05:20:00Z", "dueState": "due_soon", "state": "pending" } ],
  "nextCursor": null }
```
- `source`: `request`(정규·이벤트형 요청) · `bulk_cancel`. 정규 줄도 `dueAt`(승인 + 5영업일)을 준다 — W31 보드의 정규 행에는 기한 칩이 없다(보드 확인, 열린 점 ⑨)
- `state` 는 저장 값이 아니라 환불 행에서 나온다: `pending` = `pending` + 계좌 있음 · `done` = `succeeded` · `reinput` = 가장 최근 시도가 `failed`(`ACCOUNT_NAME_MISMATCH`·`TRANSFER_RETURNED`)이고 새 시도가 아직 없음. 계좌를 아직 못 받은 일괄 취소 건(`awaiting_account`)은 이 목록에 없다 — 요약 띠 옆 「계좌 입력 대기 n건」으로만 센다(D14, 열린 점 ⑤)

`POST …/reveal-account` — 본문 없음. 송금 대기 건만(아니면 409 `TRANSFER_NOT_PENDING`). 200
```json
{ "refundId": "…", "bankName": "신한은행", "accountNumber": "110-482-193627", "holderName": "김서연", "amount": 45000, "revealedAt": "2026-11-18T01:00:00Z" }
```
**누를 때마다 감사 기록 1행**(`refund_account.revealed` — 누가·언제·어느 환불, FR-299 「열람은 기록으로 남는다」). 같은 건을 두 번 열면 2행. 응답에 `Cache-Control: no-store`. 원문은 이 응답에만 있고 목록·상세·로그·알림에는 없다. 「계좌 전체 가리기」는 클라이언트가 값을 버리는 것이다(서버 호출 없음).

`POST …/complete` 요청 `{ "nameChecked": true }`
- `nameChecked` 가 true 가 아니면 422 `NAME_CHECK_REQUIRED`(「은행 이체 화면의 받는 사람 이름이 예금주와 같아요」 체크, W31·O48C)
- 한 트랜잭션: 환불 `pending → succeeded` 조건부(0행이면 이미 처리 — 200 재생) · `transfer_completed_*` · 요청 `completed` · 주문 `partially_refunded`/`refunded` · `refund_events`(`transfer_completed`) · 알림 `refund_completed`(회원) · 감사 `refund.transfer_completed`. **포트를 부르지 않는다**
- 응답 200 `{ "refundId": "…", "status": "succeeded", "completedAt": "…Z" }`. 이미 완료면 같은 본문
- 앱은 승인 버튼 → 확인 팝업 뒤에 부른다

`POST …/request-reinput` 요청 `{ "reason": "name_mismatch" }`(또는 `"returned"`). 한 트랜잭션: 환불 `pending → failed`(`failure_code` = `ACCOUNT_NAME_MISMATCH`/`TRANSFER_RETURNED`) · 합계 되돌림 · `reinput_requested_at` · 알림 `refund_account_reinput`(회원, 「계좌를 다시 입력해 주세요」 → §2-1 `account`) · 감사. 반송(`returned`)은 FR-133a(정산 송금 반송)의 환불판 — 정산 지급 보류와는 다른 경로다(환불은 학원 정산이 아니라 회원에게 가는 돈).
- **S4-1.5a 구현 범위(추천안·사후 확인 2026-11-24)**: `complete`·`request-reinput` 두 경로만 만들었다(목록·상세·`reveal-account`·운영자 조회는 뒤 Task). 대상은 `execution_kind = owner_bank_transfer` + `pending` + 계좌 있음 — 아니면 409 `TRANSFER_NOT_PENDING`, 남의 학원 환불은 404. 환불 행을 `FOR UPDATE` 로 잠근 뒤 조건부 갱신한다. `request-reinput` 응답 200 은 계약에 모양이 없어 `{ refundId, status: "failed", reason, reinputRequestedAt }` 로 정했고, 같은 이유로 다시 누르면 같은 본문(알림 1건 그대로), 다른 이유면 409. 회원 알림은 `dedupe_key = refund:{refundId}:completed|reinput` 로 시도마다 1건이고 `order_id` 칸은 비운다(주문당 같은 종류 1건 유니크에 걸려 재입력 → 또 반송 때 두 번째 알림이 사라지지 않게). 감사 `refund.transfer_completed`·`refund.reinput_requested`. **아직 하지 않는 것**: 주문 `partially_refunded`·`refunded` 전이(S4-1.7 이 카드분과 함께) · 새 계좌로 다음 시도 행 만들기(§2-1 `account`)

### 2-6. 운영자 조회 — 계좌분 기한 경과(D1)

| 메서드·경로 | 설명 |
|---|---|
| `GET /api/admin/refund-transfers/overdue?cursor=` | 운영자(`admin`)가 보는 **조회 전용** 목록: 기한이 지난 계좌분 환불 `{ refundId, academyName, amount, dueAt, daysOverdue, requestKind, remindedOwnerAt }`. 연락처·계좌 없음 |

운영자는 돈을 보내거나 상태를 바꾸지 않는다(FR-301 콘솔 조회 전용). 이 조회는 「운영자 확인」 이다. 일괄 취소 계좌분 중 7일이 지나도 환불 계좌가 없는 건(`awaiting_account`, `account_overdue_flagged_at` 기록)도 같은 조회에 `kind: "awaiting_account"` 로 나타나 운영자가 회원에게 연락한다(D14, 응답 칸 이름은 가칭). 보드(P 계열)에 이 화면이 없다 — 열린 점 ⑥.

---

## 3. S4-2 — 이벤트형 취소 · 행사 일괄 취소

### 3-1. 이벤트형 개별 취소(회원이 예약 상세의 취소 버튼)

경로는 §2-1 과 같다: `GET /api/reservations/{reservationId}/cancellation-preview` · `POST /api/refund-requests`. 서버가 상품 종류로 `kind=event` 를 정하고 §2-1 6-b 단계를 탄다. 요청 본문은 같고(`reasonKind` 는 선택), 계좌 결제분은 `refundAccountId` 가 필수다(이벤트형은 계좌 결제뿐 — FR-280).

- **마감일 뒤**: 409 `REFUND_DEADLINE_PASSED`(자동 실행도 없다 — 수용 ②)
- **금액**: `calculateEventCancel` 결과가 `suggested_amount`. 참가비 × (1 − 수수료율), 예매 수수료 2,000원은 돌려주지 않는다(수용 ①). 단 법정 청약철회(`statutoryWithdrawal`)는 수수료 없이 참가비 전액에 예매 수수료 2,000원을 더해 돌려주고 환불 원인 `basis_kind='statutory_withdrawal'` 로 만든다(2026-11-20 사용자 결정 D21). 수수료 중 플랫폼 몫은 주문의 `cancel_fee_platform_share_bp` 로 M5 가 계산한다(수용 ④) — 이 슬라이스는 `refunds.cancel_fee_amount` 에 취소 잔여금을 남긴다
- 대표는 W27B 에서 금액을 **올리기만** 하고 승인한다(§2-3). 거절 불가. 대표가 공지한 처리 기간(상한 3영업일) 안에 승인하지 않으면: 카드분은 시스템이 계산값으로 자동 실행, 계좌분은 자동 실행 없이 대표·회원 재알림 + 운영자 확인(D1, §6)
- 이 경우에도 환불 계좌 송금은 §2-5 의 W31·O48C 로 간다
- 이벤트형은 카드 결제를 받지 않으므로(FR-280) 위 「카드분 자동 실행」은 실제로는 방어 경로이거나 정규·개인 레슨의 시스템 실행(휴강 자동 환불 §4)과 같은 코드를 쓴다(열린 점 ⑩)

### 3-2. 행사 일괄 취소 — 대표만 확정(W18, 웹 전용)

앱에는 이 화면이 없다(O25·O27 「행사 일괄 취소는 관리자 웹에서 해요」). 마스터 플랜 S4-2.5b(대표 앱 일괄 취소 화면)는 계약에 경로가 없는 채로 남긴다(열린 점 ⑪).

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/academies/{academyId}/events/{offeringId}/bulk-cancel-preview` | 환불 대상·합계 미리보기 | 읽기 | FR-099e · W18 |
| `POST /api/academies/{academyId}/events/{offeringId}/bulk-cancel` | 일괄 취소 확정 | `Idempotency-Key` + 행사당 1회 | FR-099e · W18 |
| `GET /api/academies/{academyId}/events/{offeringId}/bulk-cancel` | 진행·결과 | 읽기 | W18 |
| `POST /api/academies/{academyId}/events/{offeringId}/bulk-cancel/retry` | 실패한 줄만 다시 | 줄 단위 | FR-103 · W18 |
| `POST /api/instructor/events/{offeringId}/cancel-suggestions` | 강사의 취소 요청(사유 적기) | 대기 중 1건 | FR-099e |

`GET …/bulk-cancel-preview` 200
```json
{ "offeringId": "…", "title": "12월 라틴 파티", "startsAt": "2026-12-19T10:00:00Z", "refundDeadline": "2026-12-16",
  "paidOrders": 31, "participants": 32, "withCompanion": 1,
  "participationTotal": 1120000, "bookingFeeTotal": 64000, "bookingFeeNotRefunded": 64000, "refundTotal": 1120000,
  "cardOrders": 0, "accountOrders": 31, "unpaidOrders": 2,
  "afterDeadlineStillFull": true, "cancelFee": 0 }
```
- 환불 마감일(12/16)이 지났어도 **참가비 전액**이고 취소 수수료는 없다(회원이 취소한 것이 아니다). **예매 수수료(`bookingFeeTotal`)는 돌려주지 않는다** — `refundTotal` = `participationTotal`, 주문마다 환불액 = 결제액 − 예매 수수료(2026-11-20 사용자 결정 D15 — 이전: 예매 수수료도 함께 돌려준다(FR-282a 예외), `refundTotal` 1,184,000)
- `cardOrders` 는 카드로 낸 주문(이벤트형은 계좌 결제뿐이라 보통 0) · `accountOrders` 는 W31 로 가는 건 · `unpaidOrders` 는 입금 대기 → 입금 전 취소로 닫는 건

`POST …/bulk-cancel` — 요청
```json
{ "reasonKind": "owner_circumstance", "reasonText": "강사 부상으로 진행이 어려워요", "confirmed": true }
```
- `confirmed` 가 true 가 아니면 422 `VALIDATION_FAILED`(W18 확인 체크). `reasonKind` = `force_majeure`(불가항력) · `owner_circumstance`(대표 사정·학원 운영상 이유). 불가항력이 아닌데 고르면 이용 제한 대상 — 서버는 판정하지 않고 사유를 감사 기록에 남긴다(FR-254(이용 제한 절차))
- 상품이 이벤트·원데이·파티·공연·대회가 아니면 409 `NOT_AN_EVENT_OFFERING`. 이미 확정이면 같은 행사에 같은 취소를 **200 으로 돌려준다**(본문에 기존 `bulkCancelId`), 다른 키여도 새 환불은 0건(수용 「재실행 0건 추가」). 이미 시작·종료한 행사는 대상이 아니다(409 `CLASS_ALREADY_STARTED`)
- **한 트랜잭션**: `event_cancellations` INSERT · 판매 단위 `closed` · 입금 대기 주문마다 입금 전 취소(주문 `cancelled`·예약 `cancelled`(`event_bulk_cancel`)·`seat_pools.held_count −1`·결제 `cancelled`) · 결제 완료 주문마다 `event_cancellation_items` INSERT(`queued`) · 회원 전원 알림 `event_cancelled`(사유 포함, 고르게 하지 않는다) · 감사 `event_cancellation.confirmed`. 가상계좌 폐기는 커밋 뒤 포트 `cancelPayment`. 응답 **202**
```json
{ "bulkCancelId": "…", "status": "queued", "orderCount": 33, "refundTotal": 1184000 }
```
- 줄 처리는 **내부 작업**(§6 `bulk-cancel-run`)이 한다. 커밋 직후 실행기가 한 번 부르고, 실패한 줄은 §3-3 재시도로 다시 한다. **줄마다 멱등 키**를 두고 한 줄의 실패가 다른 줄을 막지 않는다
  - 카드 줄: 환불 `pending` 만들고 PG 에 「결제액 − 예매 수수료」만큼 부분 취소(D15 — 이전: 전액 취소) → `succeeded`/`failed`
  - 계좌 줄: 환불 행 `pending`(`owner_bank_transfer`) 만들고 **회원에게 계좌 입력 요청** — 취소 알림 `event_cancelled` 에서 바로 환불 계좌 입력(C9A)으로 이어진다. 계좌가 있으면 바로 W31 에 올라오고 `transfer_due_at` 이 시작, 없으면 `awaiting_account` 로 두고 **3일 뒤·6일 뒤에 다시 알리며 7일이 지나도 없으면 운영자가 회원에게 연락해 받는다**(§6 `bulk-cancel-account-reminder`). 환불받을 권리는 사라지지 않는다(2026-11-20 사용자 결정 D14 — 이전: 입력 기한·미입력 건 처리 미정, 열린 점 ⑤)
  - 각 줄: 예약 `cancelled`(`event_bulk_cancel`) · `seat_pools.confirmed_count −1` · 캘린더 삭제 · 합계 증가는 줄 단위 조건부

`GET …/bulk-cancel` 200 — 진행·결과(W18 「실패 건은 재시도 목록」)
```json
{ "bulkCancelId": "…", "status": "completed_with_failures",
  "counts": { "total": 33, "done": 28, "refundStarted": 2, "awaitingAccount": 0, "failed": 3, "unpaidClosed": 2 },
  "amounts": { "refunded": 1020000, "pending": 90000, "failed": 74000 },
  "failed": [ { "itemId": "…", "memberNickname": "tango_jh", "amount": 32000, "failureCode": "GATEWAY_REJECTED", "attemptCount": 1 } ] }
```
`status`: 모든 줄이 끝(`done`·`unpaid_closed`) → `completed`, 실패 줄이 있으면 `completed_with_failures`, 처리 중이면 `running`.

### 3-3. 재시도

`POST …/bulk-cancel/retry` — 본문 없음, 200. `failed` 줄만 새 시도 번호(`attempt_no + 1`, 새 멱등 키)로 다시 시도한다. 성공·진행 중·송금 대기 줄은 건드리지 않는다 — **재실행해도 환불이 늘지 않는다**(S4-2 수용 ③: 24건 중 3건 실패 → 재실행은 3건만). 실패 줄이 없으면 200 `{ "retried": 0 }`.

### 3-4. 강사의 취소 요청

`POST /api/instructor/events/{offeringId}/cancel-suggestions` — 요청 `{ "reasonText": "강사 부상으로 진행이 어려워요" }` → 201 `{ "suggestionId": "…", "status": "open" }`. 담당 강사(그 행사의 강사)만. 대표에게 `event_cancel_suggested_owner`(category `approval`)가 간다. 이미 열린 요청이 있으면 200 같은 본문. **강사는 확정하지 않는다** — 확정은 대표의 `bulk-cancel` 뿐이다(FR-099e). 대표가 일괄 취소를 확정하면 열린 요청은 `confirmed` 로 닫힌다.

---

## 4. S4-3 — 휴강·폐강·변경과 회원 선택 · 회차 옮기기

휴강 확정 자체(강사가 정하고 알림을 보냄)는 S2-3 의 경로다. 이 슬라이스는 그 트랜잭션이 부르는 함수 `openClosureChoices(sessionId)` 와 회원·대표 화면 경로를 만든다. FR-059(휴강 환불·보강 선택)는 **크레딧 없음**(Q16 임시 확정) — 옮기기 아니면 환불이다.

### 4-1. 회원 쪽

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/me/closure-choices?status=open&cursor=` | 내 휴강 선택 목록 | 읽기 | FR-059 · M21 |
| `GET /api/closure-choices/{choiceId}` | 선택 화면(옵션·옮길 회차·기한) | 읽기 | C15D |
| `POST /api/closure-choices/{choiceId}/choose` | 옮기기 또는 환불 고르기 | 헤더 `Idempotency-Key` + 상태 조건부 | FR-059 · FR-109 · C15D |
| `GET /api/reservations/{reservationId}/move-candidates` | 회차 옮기기 후보(이벤트형) | 읽기 | FR-109 · C4C |
| `POST /api/reservations/{reservationId}/move` | 회차 옮기기(이벤트형 예약 이동) | 헤더 `Idempotency-Key` + 주문당 1번 | FR-109 · C4C |

`GET /api/closure-choices/{choiceId}` 200
```json
{ "choiceId": "…", "status": "open", "reason": "강사 사정", "notifiedAt": "2026-11-10T03:00:00Z", "deadlineAt": "2026-11-17T14:59:00Z",
  "closedSession": { "sessionId": "…", "startsAt": "2026-11-18T11:30:00Z", "title": "쌈바(입문)" },
  "refundOption": { "unitAmount": 18750, "formula": "300,000원 ÷ 16회", "method": "card", "needsRefundAccount": false },
  "moveOption": { "available": true, "candidates": [
      { "sessionId": "…", "startsAt": "2026-11-21T05:00:00Z", "label": "보강 회차", "instructor": "이준호", "hall": "A홀", "seatsLeft": 4 },
      { "sessionId": "…", "startsAt": "2026-11-19T11:30:00Z", "label": "목요반", "instructor": "김하나", "hall": "B홀", "seatsLeft": 2 } ],
    "unavailable": [ { "sessionId": "…", "label": "월 저녁반", "reason": "SEAT_SOLD_OUT" } ] },
  "defaultIfNoChoice": "refund", "scope": "single" }
```
- 후보는 **같은 과정·같은 성별 자리가 남은 회차**(`seat_pools` + `session_seat_counters` 로 계산). 크레딧으로 쌓지 않고 이번 휴강분 1회만 옮긴다
- `defaultIfNoChoice: "refund"` — 기한(확정 + 7일, KST 23:59)까지 안 고르면 환불로 처리한다(§6 `closure-auto-refund`)
- 환불은 카드면 승인 취소, **계좌 결제분이면 환불 계좌가 필요**(`needsRefundAccount`) — 선택 때 `refundAccountId` 를 함께 보낸다. 자동 환불 때 계좌가 없으면 `awaiting_account` 로 두고 알린다(열린 점 ⑤와 같은 처리)

`POST /api/closure-choices/{choiceId}/choose` — 요청
```json
{ "choice": "move", "targetSessionId": "…" }
```
또는 `{ "choice": "refund", "refundAccountId": null }`.

| 검사·동작 | 실패 시 |
|---|---|
| 본인 선택 행 · `status = open` · `now ≤ deadline_at` | 403 · 409 `CLOSURE_ALREADY_CHOSEN` · 409 `CLOSURE_CHOICE_CLOSED` |
| `move`: 후보에 있는 회차 · 같은 성별 자리가 남음(§9-4 `session_seat_counters` 조건부 UPDATE) | 409 `SEAT_SOLD_OUT` · 422 |
| `refund`: 계좌 결제분이면 `refundAccountId` | 422 `REFUND_ACCOUNT_REQUIRED` |
| 한 트랜잭션(move) | `reservation_moves`(`closure_substitute`) INSERT · 대상 회차 카운터 +1 · 선택 `moved` · 캘린더에 대상 회차 추가(닫힌 회차 항목 삭제) · 감사 `closure_choice.chosen` |
| 한 트랜잭션(refund) | 환불 행(`basis=closure_choice`, 금액 = `unit_amount`, 합계 조건부 증가) · 선택 `refund_chosen` · 이후 §1-3 ② ③ |

**폐강**(이후 회차 전체)은 같은 휴강 확정에 묶인 선택 행이 여러 개다. 본문에 `"scope": "all"` 을 주면 같은 확정에 묶인 열린 행 모두에 한 번에 적용한다(환불 금액은 닫힌 회차 수 × 회차 금액, 옮길 회차가 없으면 `refund` 만 열린다 — 열린 점 ③).

응답 200 `{ "choiceId": "…", "status": "moved", "substituteSessionId": "…" }` 또는 `{ "status": "refund_chosen", "refund": { "refundId": "…", "amount": 18750, "status": "succeeded" } }`. 같은 선택의 재생은 200 같은 본문, 다른 선택은 409 `CLOSURE_ALREADY_CHOSEN`.

**이벤트형 회차 옮기기**(FR-109, C4C — 학원이 허용한 수업만)

`GET /api/reservations/{reservationId}/move-candidates` 200
```json
{ "allowed": true, "usedAlready": false, "moveDeadline": "2026-11-20T05:00:00Z", "currentPrice": 30000,
  "candidates": [ { "offeringId": "…", "startsAt": "2026-11-29T05:00:00Z", "price": 30000, "seatsLeft": 3, "movable": true },
                  { "offeringId": "…", "startsAt": "2026-11-28T07:00:00Z", "price": 35000, "seatsLeft": 5, "movable": false, "reason": "MOVE_PRICE_DIFFERS" } ] }
```
`POST /api/reservations/{reservationId}/move` — 요청 `{ "targetOfferingId": "…" }`. 같은 수업·**같은 가격**·같은 자리 종류가 남은 회차, 학원이 허용한 수업, 옮기기 마감 전(마감 = 환불 마감일 기준, 열린 점 ②), 주문당 1번.

| 실패 | 코드 |
|---|---|
| 학원이 옮기기를 허용하지 않은 수업 | 409 `MOVE_NOT_ALLOWED` |
| 이 주문에서 이미 한 번 옮김(`uq_moves_order_reschedule`) | 409 `MOVE_ALREADY_USED` |
| 마감 뒤 | 409 `MOVE_DEADLINE_PASSED` |
| 가격이 다름(추가 비용 없음 — 같은 가격만) | 409 `MOVE_PRICE_DIFFERS` |
| 대상 자리 없음 | 409 `SEAT_SOLD_OUT` |

한 트랜잭션: 대상 자리 조건부 잡기(`held` 를 거치지 않고 바로 `confirmed_count +1`) · 새 예약 `confirmed`(`moved_from_reservation_id`) · 옛 예약 `cancelled`(`moved`)·옛 자리 −1 · 캘린더 교체 · **주문 스냅샷의 환불 마감일·첫 회차 시작을 옮긴 회차 기준으로 덮어씀**(수용 ③, Q26) · `order_events`(`reservation_moved`) · 감사 `reservation.moved` · 커밋 뒤 옛 자리에 `advanceWaitlist`(비는 자리는 대기 1번에게, C4C 「11/22 여 자리는 대기 1번에게 알려요」). 응답 200 `{ "newReservationId": "…", "newRefundDeadline": "…" }`. 같은 요청 재생은 200.

### 4-2. 시간·장소 변경 뒤 환불 요청(S4-3.6)

변경·휴강 알림(FR-141)을 받은 회원이 환불을 요청하면 §2-1 의 `POST /api/refund-requests` 에 `reasonKind: "schedule_change"` 와 `changeRefId`(S2-3 의 변경 기록 id)를 붙여 들어간다. 별도 경로는 없다. 대표 쪽 흐름·기한·금액 입력은 정규 환불과 같다(수용 ④).

### 4-3. 대표 쪽 — 휴강 처리 현황(W19 · O43 · O44)

| 메서드·경로 | 설명 | 근거 FR · 보드 |
|---|---|---|
| `GET /api/academies/{academyId}/sessions/{sessionId}/closure-status` | 휴강한 회차의 회원별 선택 현황 | FR-059 · W19 · O44 |

200 — 읽기 전용(대표는 선택을 바꾸지 않는다, FR-065 「최종 결정은 강사」)
```json
{ "sessionId": "…", "title": "바차타 센슈얼 입문", "startsAt": "2026-11-14T10:30:00Z", "confirmedAt": "2026-11-09T03:00:00Z", "deadlineAt": "2026-11-16T14:59:00Z",
  "counts": { "enrolled": 12, "moved": 5, "refund": 4, "refundExecuted": 2, "refundWaiting": 2, "undecided": 3 },
  "items": [ { "memberNickname": "김서연", "paidAmount": 90000, "unitAmount": 11250, "choice": "moved", "targetStartsAt": "2026-11-21T05:00:00Z", "state": "done" },
             { "memberNickname": "이도현", "paidAmount": 90000, "unitAmount": 11250, "choice": "undecided", "state": "refund_after_deadline" } ],
  "formula": "회차 금액 = 결제액 ÷ 회차 수(8회), 원 미만은 올려요" }
```
환불 실행은 카드 → 시스템이 자동(휴강 환불은 대표 처리 대상이 아니다 — spec 2026-11-10 임시 확정), 계좌 → W31 목록에 올라와 대표가 송금(`source: "closure"`). 이 화면에서 실행 버튼은 없다.

---

## 5. S4-4 — 대기 · 자리 넘김 · 우선 결제 · 동반 · 단체

### 5-1. 대기(FR-093 · FR-094 · FR-094a · FR-095 · FR-108 · FR-143)

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/offerings/{offeringId}/waitlist` | 대기 현황(대기 인원·마감 시각) | 읽기 | M8 · C13B |
| `POST /api/waitlist` | 대기 신청 | 같은 자리 종류 중복은 200 재생 | FR-093 · M8 |
| `GET /api/waitlist?status=&cursor=` | 내 대기 목록 | 읽기 | M16 |
| `POST /api/waitlist/{entryId}/cancel` | 대기 취소 | 상태 조건부 | M16 |
| `GET /api/waitlist-offers/{offerId}` | 결제 기회 상세(남은 시간) | 읽기 | M21 |

`GET /api/offerings/{offeringId}/waitlist` 200
```json
{ "offeringId": "…", "joinClosesAt": "2026-11-11T12:10:00Z", "offerEndsAt": "2026-11-12T09:10:00Z", "endNoticeAt": "2026-11-12T09:10:00Z",
  "joinOpen": false, "waiting": { "male": 1, "female": 3 },
  "mine": { "entryId": "…", "seatKind": "female", "position": 2, "status": "waiting" } }
```
- `joinClosesAt` = 수업 시작 24시간 전(FR-108) · `offerEndsAt` = 수업 시작 3시간 전(결제 기회 마감, 이때 대기 종료 알림). 이미 건 대기는 마감 뒤에도 유지된다(C13B)

`POST /api/waitlist` — 요청 `{ "offeringId": "…", "seatKind": "female" }`

| 검사 | 실패 시 |
|---|---|
| 멤버십 회원·신규 3개월 체험자(판정 함수, M6 전까지 모두 허용) | 403 `WAITLIST_MEMBERSHIP_REQUIRED` |
| 판매 단위 `open` · 그 자리 종류가 마감(`held + confirmed ≥ capacity`) | 409 `WAITLIST_NOT_NEEDED`(자리가 남음 — 바로 결제하라는 뜻) |
| 수업 시작 24시간 전까지 | 409 `WAITLIST_CLOSED` |
| 이미 이 판매 단위에 대기 중(`uq_waitlist_member_active`) | 200 같은 줄(재생) |
| 이미 이 판매 단위 활성 예약이 있음 | 409 `ALREADY_RESERVED` |

201(재생은 200)
```json
{ "entryId": "…", "seatKind": "female", "position": 4, "status": "waiting", "joinedAt": "…Z" }
```
순번은 `waitlist_counters` 한 문장(`INSERT … ON CONFLICT DO UPDATE … RETURNING last_seq`)이 정하고, 화면의 「n번」은 앞사람 수를 세어 계산한다 — 앞사람이 빠지면 저절로 올라가고, 1번이 되면 알림 `waitlist_position_up`(「대기 1번이 되었습니다」, FR-094a).

`GET /api/waitlist-offers/{offerId}` 200 `{ "offerId": "…", "offeringId": "…", "seatKind": "female", "expiresAt": "…Z", "remainingSeconds": 1620, "status": "open", "checkout": { "offerId": "…" } }` — 본인 기회가 아니면 404(존재를 알리지 않는다).

### 5-2. 결제 기회로 결제하기

결제 기회를 받은 회원이 결제하는 길은 **M3 의 `POST /api/orders` 에 선택 칸 `offerId` 를 더하는 것**이다(계약 03 §1 보완 — M3 담당과 조율, 열린 점 ①). `offerId` 가 있으면 03 의 단계 7(자리 잡기)을 건너뛰고 기회가 잡아 둔 `held` 를 주문의 `held` 로 이어받는다(`seat_offers.status = consumed`, `order_id`). 만료된 기회면 409 `OFFER_EXPIRED`.

- **결제 기회의 「응답」 = 주문 생성(결제 시작)** 이다. 30분 안에 주문을 시작하지 않으면 다음 순번으로 넘어간다(FR-095). 주문 생성 뒤의 결제 기한은 일반 결제 기한(15분 확정, Q39)이 따로 흐른다 — 열린 점 ⑫
- 같은 자리에 여럿이 입금하면 먼저 입금이 확인된 건이 확정되고 나머지는 자동 취소된다(FR-097). 새 경로 없음 — M3 웹훅의 `pending → paid` 조건부 갱신이 이미 보장하고, 이 슬라이스는 시나리오 테스트(S4-4.9)로 굳힌다
- **대기 줄이 살아 있는 동안 일반 신청은 그 자리 종류가 닫힌다**: `POST /api/orders` 는 같은 (판매 단위·자리 종류)에 `waiting`/`offered` 대기가 있고 본인이 열린 기회를 갖고 있지 않으면 자리가 남아 있어도 409 `SEAT_SOLD_OUT` 을 낸다(줄 새치기 방지, 같은 조율 대상)

### 5-3. 자리 넘김 — `advanceWaitlist(offeringId, seatKind)` (서비스 함수 + 내부 작업)

자리가 풀리는 모든 사건이 같은 트랜잭션 끝에서(또는 커밋 직후) 부른다: 입금 전 주문 만료·셀프 취소(M3) · 확정 예약 취소(이벤트형 신청·정규 환불 승인·옮기기·일괄 취소는 대기자가 아니라 닫힘) · 우선 결제 반납·만료 · 결제 기회 만료. 순서(한 트랜잭션, 같은 (판매 단위·자리 종류)에 대한 직렬화는 `uq_seat_offers_open` + 조건부 UPDATE 가 맡는다):

1. 열린 기회가 있으면 아무것도 안 한다(결제 기회를 받은 사람은 **언제나 한 명**, FR-094a)
2. 남은 자리 확인: `held + confirmed < capacity` 이고 시작 3시간 전 이전
3. `waiting` 중 `seq` 가 가장 작은 한 줄을 고른다(`ix_waitlist_next`)
4. 자리 `held + 1` 조건부 UPDATE → `seat_offers` INSERT(`expires_at = min(지금 + 30분, 시작 3시간 전)`) → 줄 `offered` → 알림 `waitlist_offer`(「결제 기회가 30분 남았어요」). 0행이면 이번 호출은 끝
5. 기회 만료(§6 `waitlist-advance`): 기회 `expired` · 줄 `passed` · `held −1` · 당사자 알림 `waitlist_offer_expired` → 1번부터 다시(다음 순번)

「이번엔 쉬어 갈래요」로 풀린 자리도 대기 1번 한 명에게만 기회가 간다(FR-094a 임시 확정). 대기자가 없으면 그 자리는 일반 신청으로 열린다.

**대기 종료**: 수업 시작 3시간 전부터 새 기회를 만들지 않고, 줄이 `waiting`·`offered` 인 사람 전원에게 알림 `waitlist_ended`(「대기가 끝났어요 · 결제된 금액은 없어요」, C13B) 후 `ended`(§6 `waitlist-close`).

### 5-4. 정규 수강생의 다음 기간 우선 결제(FR-052b · C5A)

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `GET /api/priority-slots?status=held` | 내 우선 결제 자리 | 읽기 | C5A |
| `GET /api/priority-slots/{slotId}` | 우선 결제 상세(마감·자리·금액) | 읽기 | C5A |
| `POST /api/priority-slots/{slotId}/release` | 「이번엔 쉬어 갈래요」 | 상태 조건부 | FR-052b · C5A |

- 슬롯은 **다음 기간 판매 단위가 열릴 때** `openPrioritySlots(nextOfferingId)` 가 지금 기간의 `confirmed` 수강생마다 만든다(자리 `held + 1` 조건부, 자리가 없으면 만들지 않는다). 생성 호출은 S2-2(수업 게시)의 몫(열린 점 ①) — 이 슬라이스에 생성 API 는 없다
- 마감 = 다음 기간 첫 수업 D-3 의 KST 23:59(설정값). 마감 3일 전·당일 오전에 알림 `priority_slot_deadline`(§6)
- 결제는 §5-2 와 같은 방식으로 `POST /api/orders` 에 `prioritySlotId` 를 더한다(조율 대상 1건에 같이 묶는다)
- `POST …/release` — 본문 없음, 200 `{ "status": "released" }`. 슬롯 `released` · `held −1` · 커밋 뒤 `advanceWaitlist`(바로 대기 1번에게 열린다 — 수용 ④). 이미 결제·만료·반납이면 409 `PRIORITY_SLOT_CLOSED`(반납 재생은 200)
- 마감이 지난 미결제 슬롯: §6 `priority-slots-expire` 가 풀어 대기 1번에게 넘긴다. 대기자가 없으면 일반 신청으로 열린다(C5A). 마감 뒤에 결제하려면 일반 신청과 같다

### 5-5. 2인 동반 · 단체 신청(FR-105 · FR-178)

| 메서드·경로 | 설명 | 멱등 | 근거 FR · 보드 |
|---|---|---|---|
| `POST /api/companion-invites` | 동반 초대 보내기 | 같은 판매 단위·같은 사람 1건 | FR-105 · C4A |
| `GET /api/me/companion-invites?status=` | 받은·보낸 초대 | 읽기 | C4A |
| `POST /api/companion-invites/{inviteId}/accept` | 초대 수락 | 상태 조건부 | C4A |
| `POST /api/companion-invites/{inviteId}/decline` | 초대 거절 | 상태 조건부 | C4A |
| `POST /api/group-orders` | 동반·단체 주문 생성(한 사람이 결제) | 헤더 `Idempotency-Key` 필수 | FR-105 · FR-178 · C4A · C4B |

`POST /api/group-orders` — 요청
```json
{ "offeringId": "…", "kind": "pair", "method": "card",
  "participants": [ { "memberId": "…", "seatKind": "female" }, { "memberId": "…", "seatKind": "male" } ] }
```
단체: `"kind": "group", "crewName": "크루 루나"` + 참가자 목록(6명, 구성원 직접 선택 — 열린 점 ⑬). 결제수단은 03 의 규칙(이벤트형은 계좌이체만, FR-280).

| 검사 | 실패 시 |
|---|---|
| 같은 `Idempotency-Key` 주문이 있으면 200 재생(03 §5 와 같은 규칙) | — |
| `pair`: 두 사람, 상대 초대가 `accepted`(본인은 주문자) | 409 `COMPANION_NOT_ACCEPTED` |
| `group`: 2명 이상 `COMPANION_GROUP_MAX`(10) 이하 | 422 `GROUP_TOO_LARGE` |
| 모든 참가자에게 같은 판매 단위 활성 예약이 없음(`uq_reservations_member_offering_active`) | 409 `ALREADY_RESERVED` |
| **자리 전부를 한 트랜잭션에서 잡음** — 자리 종류별로 묶어 `held_count + n` 조건부 UPDATE. 하나라도 0행이면 전체 롤백 | 409 `GROUP_SEATS_UNAVAILABLE`(`shortBy`) |

성공하면 주문 1건(주문자 = 결제자, 금액 = 참가비 × 인원 + 예매 수수료 × 인원) · 예약 N건(`companion_group_id`, `share_amount` = 참가비 몫) · 결제 1건. 응답은 03 의 주문 응답 + `{ "groupId": "…", "reservations": [ { "reservationId": "…", "memberId": "…", "seatKind": "…" } ] }`. 입금이 확인되면 03 의 확정 경로가 예약 전원을 함께 `confirmed` 로 만들고 구성원마다 알림 `companion_confirmed`(「예약이 확정되면 최도윤 님에게도 알림이 가요」). 기한 안에 입금이 없으면 전원이 함께 `expired`(함께 확정되거나 함께 실패 — 수용 ③).

**한 사람만 취소**(Q25 임시): 구성원 본인은 자기 예약만 취소할 수 있고(§2-1 의 환불 요청 — 정규는 문의, 이벤트형은 취소 버튼), 환불 상한은 **그 구성원의 `share_amount`** 다(`ck_reservations_refunded_cap`). 남은 구성원의 예약·결제는 그대로 유지된다(수용 ③). 주문자가 환불 계좌를 쓴다.

---

## 6. 내부 작업 — `/api/internal/jobs/**`(README §1: `X-Internal-Token`, 모두 멱등)

실행기는 S0-4 가 정한다(SP-6). 각 작업은 한 번에 처리량 상한을 두고 남은 것은 다음 호출이 이어받는다. 응답은 `{ "processed": n }` 한 줄.

| 경로 | 언제 | 하는 일 | Task |
|---|---|---|---|
| `POST /api/internal/jobs/refund-request-reminders` | 정시마다(추천 매시) | ① 답할 기한이 **내일**이고 `due_soon_notified_at` 이 비었으면 `REFUND_DUE_SOON_HOUR_KST`(9시)에 대표 예고(`refund_request_due_soon_owner`) ② 기한이 지났고 `overdue_notified_at` 이 비었으면 대표 재알림(`refund_request_overdue_owner`) + 회원에게 `refund_request_waiting`. **운영자에게 넘기지 않는다**(FR-098b) | S4-1.8 |
| `POST /api/internal/jobs/refund-auto-execute` | 정시마다 | 이벤트형 + 카드 결제분 + 답할 기한 경과 + 미결정 → `decision_kind=auto` 로 계산값 환불 실행(§2-3 의 승인 경로와 같은 함수, 실행 주체 `system_deadline`). **계좌분은 건드리지 않는다** | S4-2.2 |
| `POST /api/internal/jobs/bulk-cancel-account-reminder` | 매일 | 일괄 취소 `awaiting_account` 줄: 확정 3일·6일 뒤 회원에게 같은 안내를 다시 보내고(`account_reminded_3d_at`·`account_reminded_6d_at`), 7일 뒤에도 계좌가 없으면 `account_overdue_flagged_at` 을 남겨 운영자 조회(§2-6)에 올린다. 환불 권리는 만료되지 않는다(2026-11-20 사용자 결정 D14) | S4-1.14 |
| `POST /api/internal/jobs/refund-transfer-overdue` | 매일 | 기한이 지난 계좌분 `pending` 환불: 대표 재알림 `refund_transfer_overdue_owner` · 회원 알림 · `operator_flagged_at` 기록(§2-6 의 운영자 조회에 나타남). 돈은 보내지 않는다(D1) | S4-1.8 · S4-2.2 |
| `POST /api/internal/jobs/bulk-cancel-run` | 확정 직후 + 5분마다 | `queued` 줄을 처리, 실패 줄은 재시도 요청이 있을 때만 | S4-2.3 |
| `POST /api/internal/jobs/closure-auto-refund` | 정시마다 | `status = open` 이고 `deadline_at` 이 지난 선택 → 환불 행(`basis=closure_choice`, 사유 `closure_auto`, 실행 주체 `system_auto`) · 상태 `auto_refund` · 알림 `closure_auto_refund`. 마감 하루 전 `closure_choice_deadline` 예고. 계좌분이면 계좌 입력 요청(§4-1) | S4-3.4 |
| `POST /api/internal/jobs/waitlist-advance` | 1분마다 | `status = open` 이고 `expires_at` 이 지난 기회 → §5-3 의 5번 | S4-4.3 |
| `POST /api/internal/jobs/waitlist-close` | 5분마다 | 수업 시작 3시간 이내가 된 판매 단위의 대기 줄 전원 종료 + 알림 | S4-4.5 |
| `POST /api/internal/jobs/priority-slots-expire` | 정시마다 | 마감이 지난 `held` 슬롯 → `expired` · `held −1` · `advanceWaitlist` · 알림. 마감 3일 전·당일 오전 예고 `priority_slot_deadline` | S4-4.6 |

---

## 7. 상태 전이 요약

README·data-model §4 의 형식을 따른다. 전이는 모두 `UPDATE … WHERE id = :id AND status = :from` 조건부, 감사 1행은 같은 트랜잭션.

| 대상 | 전이 | 상세 |
|---|---|---|
| 환불 요청 | `received` → `in_progress` → `completed` · `rejected` / 처리 전 `withdrawn`(정규만) | data-model §9-7 |
| 환불 | `pending` → `succeeded` · `failed`(재시도는 새 시도 행) | 계좌분 `pending` 은 정상. 송금 완료·재입력 요청이 전이 |
| 주문 | `paid` → `partially_refunded` → `refunded` · `paid` → `refunded` | 환불 `succeeded` 때 합계로 판정. `expired`·`cancelled` 는 끝 상태 그대로 |
| 예약 | `confirmed` → `cancelled`(`refund_regular`·`event_member_cancel`·`event_bulk_cancel`·`moved`) | 자리 −1 · 캘린더 삭제와 같은 트랜잭션 |
| 휴강 선택 | `open` → `moved` · `refund_chosen` · `auto_refund` · `void` | 기한 7일 |
| 대기 줄 | `waiting` → `offered` → `paid` · `passed` / `ended` · `cancelled` | 기회는 한 번에 한 명 |
| 우선 결제 | `held` → `consumed` · `released` · `expired` | 마감 D-3 23:59 |
| 행사 일괄 취소 | `queued` → `running` → `completed` · `completed_with_failures` | 행사당 1회 |

## 8. 수용 시나리오

1. **Given** 정규 4회 180,000원 카드 · 1회 진행 · 공지 「1/3 지나기 전 67%」 **When** 회원 요청 후 대표가 상세를 연다 **Then** `suggestedAmount` = 120,600, 계산 보조 「4회 중 1회 진행 · 남은 3회 · 회차당 45,000원」(S4-1 수용 ①). 대표가 180,001 을 보내면 409 `REFUND_EXCEEDS_PAID`
2. **Given** 카드 승인 건과 계좌 건 **When** 대표 승인 **Then** 카드는 PG 부분 취소로 `succeeded`, 계좌는 `pending`(송금 대기)이고 W31 에 오른다. 「송금 완료」 전에는 요청이 `completed` 가 아니다(수용 ②)
3. **Given** 같은 승인 요청이 동시에 2건 **When** 둘 다 도착 **Then** 환불 행 1건, 하나는 200 같은 본문 또는 409 `REFUND_ALREADY_DECIDED`, `refunded_total_amount` 는 한 번만 오른다(수용 ③ · SC-007)
4. **Given** 처리 전(`decision_kind` 없음) 정규 요청 **When** 철회 **Then** 200 `withdrawn`, 예약 그대로. 승인된 뒤 철회는 409(수용 ④)
5. **Given** 접수 4영업일째 미답 **When** `refund-request-reminders` **Then** 대표 재알림 1건, 회원 `displayStatus = pending_overdue`. 같은 작업을 다시 불러도 알림 추가 0(수용 ⑤)
6. **Given** 환불 승인 성공 **Then** 부분이면 주문 `partially_refunded`, 합계가 환불 상한(결제액 − 예매 수수료, 법정 청약철회면 결제액)과 같으면 `refunded`(수용 ⑥, 2026-11-20 사용자 결정 D15·D21)
7. **Given** 참가비 30,000원 이벤트형 · 마감일 전 · 6일 전 **When** 회원이 취소 신청 **Then** 환불 예정 = 참가비 × (1 − 수수료율), 예매 수수료 2,000원 미반환, 예약이 곧바로 `cancelled` 이고 대기 1번에게 기회가 간다(S4-2 수용 ①). 마감일 뒤면 409 `REFUND_DEADLINE_PASSED`(수용 ②)
8. **Given** 일괄 취소 33주문(카드 0 · 계좌 31 · 입금 대기 2) 중 3건이 실패 **When** 재시도 **Then** 실패한 3건만 새 시도, 성공 줄 환불 추가 0, 같은 행사에 다시 확정을 보내도 환불 추가 0(수용 ③ · SC-007)
9. **Given** 8회 120,000원 정규에서 1회 휴강 **When** 회원이 고르지 않고 7일 경과 **Then** `closure-auto-refund` 가 15,000원 환불 1건(두 번 돌려도 1건). 옮기기를 고르면 같은 성별 자리가 남은 회차에만 되고, 한 번 더 옮기면 409 `MOVE_ALREADY_USED`(S4-3 수용 ①②)
10. **Given** 자리 1개가 난다 **When** 대기 3명 **Then** 1번에게만 `seat_offers` 가 열리고 30분 안에 주문이 없으면 2번으로 넘어간다. 동시에 풀림·넘김이 와도 열린 기회는 한 명(`uq_seat_offers_open`)(S4-4 수용 ①)
11. **Given** 수업 시작 3시간 전 **When** `waitlist-close` **Then** 대기 전원 `ended` + 알림 1건씩, 이후 자리가 나도 기회 0(수용 ②)
12. **Given** 동반 신청에서 여 자리만 1개 남음 **When** 결제 시작 **Then** 409 `GROUP_SEATS_UNAVAILABLE`, 어느 자리도 잡히지 않음. 결제 뒤 한 사람만 취소해도 남은 사람 예약은 유지(수용 ③). 「쉬어 갈래요」를 누르면 그 자리가 바로 대기 1번에게 열린다(수용 ④)
13. **Given** 계좌분 환불 기한 경과 **When** `refund-transfer-overdue` **Then** 대표 재알림 + 운영자 조회에 나타나되 시스템이 돈을 보내지 않는다(D1)
14. **Given** 대표가 계좌 전체 보기를 두 번 누름 **Then** 감사 기록 2행, 목록·로그에는 가린 번호만(FR-299)

## 9. 열린 점

추천값은 2026-11-20 사용자 결정 D20 으로 **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 이다(D13·D14·D15 는 따로 확정). 데이터 쪽 열린 점은 data-model §9-9 (① ~ ⑫).

| # | 무엇 | 추천 · 조율 |
|---|---|---|
| ① | 이 계약이 **다른 마일스톤의 계약을 고치게 한다** — 03 의 `POST /api/orders` 에 선택 칸 `offerId`·`prioritySlotId` 를 더하고 대기 줄이 있을 때 일반 신청을 막는다(§5-2). 자리가 풀리는 M3 의 사건(만료·셀프 취소)에서 `advanceWaitlist` 를 부른다. 우선 결제 슬롯 생성은 S2-2(수업 게시)가 `openPrioritySlots` 를 부른다. 휴강 확정은 S2-3 이 `openClosureChoices` 를 부른다 | **M3(S3-3)·M2(S2-2·S2-3) 담당과 조율.** 03 은 이 작업에서 고치지 않았다 |
| ② | 이벤트형 옮기기 마감 시각 — spec 에 없다(C4C 「11/20 (금) 14:00까지 · 2일 전」) | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 행사 시작 2일 전, 환불 마감일보다 늦지 않게. 설정값 한 곳 |
| ③ | 철회 가능 시점 — 「처리 중」을 어디까지로 보나. 폐강(여러 회차) 선택 방식(`scope: all`, data-model ⑨) | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 승인 전까지 철회 가능. 폐강은 한 번에 적용 |
| ④ | `received → in_progress` 를 누가 일으키나 — 보드에 「처리 시작」 버튼이 없다(C15B 「처리 중 · 대표가 환불 규정을 보고 있어요」) | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 대표가 요청을 열어 「처리하기」로 들어갈 때 화면이 `start` 를 부른다(GET 은 상태를 바꾸지 않는다). 아니면 `received → completed·rejected` 직행으로 줄이고 `in_progress` 를 승인 직후로 정의할 수도 있다 |
| ⑤ | ~~일괄 취소 계좌분의 환불 계좌 입력(data-model ⑪) · 입력 기한 · 미입력 건~~ | **→ 2026-11-20 사용자 결정 D14 로 확정** — 취소 알림에서 바로 C9A 로 계좌를 받고, 3일·6일에 다시 알리고, 7일 안에 없으면 운영자가 연락해 받는다. 계좌가 들어오면 그때 W31 에 오른다. 환불받을 권리는 사라지지 않는다 |
| ⑥ | 운영자 「기한 경과 계좌 환불」 화면 — P1~P11 보드에 없음(D1) | 운영 콘솔 P 계열에 목록 화면 또는 P1 타일을 더하거나, 운영자 알림으로 대신. M7(운영)과 조율 |
| ⑦ | 대기 신청 자격 판정(멤버십·체험자) — M6 의 멤버십이 아직 없다 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** M6 전에는 모두 허용하는 함수 하나(`canJoinWaitlist(memberId)`), M6 이 판정을 채운다 |
| ⑧ | 문의함(S7-2)과 환불 요청의 연결 — 문의 항목 id 와 `refund_requests.id` | M7 조율. **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 문의 항목이 `refundRequestId` 를 가진다 |
| ⑨ | W31 보드의 정규 줄에 기한 칩이 없다. D6 의 「승인하면 5영업일」(정규)과 W31·O48C 의 「3영업일 안에 보내요」(이벤트·일괄)가 서로 다른 값이다 | 계약은 환불마다 `transfer_due_at` 을 따로 둔다(정규 5, 이벤트형 ≤ 3). 보드에 정규 기한 칩 추가 확인 |
| ⑩ | 이벤트형은 카드를 받지 않는데(FR-280) D1 은 「자동 실행은 카드분에만」이라 한다 | 코드는 환불마다 `execution_kind` 로 분기하고 이벤트형 카드 경로를 따로 막지 않는다. 카드 이벤트형이 영영 없으면 그 분기는 휴강·정규의 시스템 실행에만 쓰인다 |
| ⑪ | 마스터 플랜 S4-2.5b(대표 앱 일괄 취소 화면)는 이 계약에 경로가 없다 — 일괄 취소는 웹 전용(O25·O27) | 대조 보고서 표 5 의 결정을 따른다: S4-2.5b 삭제 또는 W18 로 교체 |
| ⑫ | 결제 기회 「응답」의 정의 — 주문 시작인가 입금 완료인가 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 주문 시작(30분). 입금 기한은 일반 결제 기한이 따로 흐른다. 가상계좌는 30분 안에 입금되기 어려우므로 대기 기회는 카드·간편결제·간편 계좌이체 위주가 된다 — 사후 확인 |
| ⑬ | 단체(크루·동호회) 구성원이 수락해야 하나 · 크루 엔티티 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 크루 엔티티 없이 `crewName` 문자열 + 구성원 직접 선택, 수락 없음(단체). 동반(2인)만 수락 필요 |
| ⑭ | 수수료 끝수 — 이벤트형 수수료는 내림, 환불은 올림(FR-100). Q24(수수료 기준 금액)가 임시 확정이라 참가비 기준 | S4-2.1 이 함수로 굳히고 값만 교체 가능하게 둔다 |
| ⑮ | 정규 미리 채움의 시점 판정 경계(회차 기준인지 기간 기준인지, 1/3 을 정확히 넘는 순간) · 학원법 반환 기준 | **임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)** 회차 수 기준(`elapsed*3 ≤ total` 이면 「1/3 지나기 전」). 법 기준은 Q11 ① 변호사 검토 뒤 값만 교체 |
| ⑯ | 쿠폰 되살리기(FR-296)는 M6 쿠폰 엔티티 이후 | 이 슬라이스는 훅 `onRefundSucceeded` 만 둔다 |
| ⑰ | 환불이 정산에 미치는 영향(FR-131·FR-253) · 환불 PG 수수료(FR-125c) | M5 가 환불 행(`cancel_fee_amount`·사유·원인)을 읽는다. 이 계약은 정산 행을 만들지 않는다(R-P5 와 같은 경계) |
