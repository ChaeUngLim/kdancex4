# API 계약 — 정산 원장·강사 정산 계좌와 명세·대표 승인 일괄 지급·대사와 월 마감 (M5(정산·지급·대사): S5-1(정산 원장과 3단계 전이) · S5-2(강사 정산 계좌·본인확인·명세) · S5-3(대표 승인 일괄 지급 — 베타 수동) · S5-4(대사·월 마감))

공통 규칙은 `README.md`(직원 인증 §6). 데이터는 `03_data-model.md` §10(`settlement_entries` 확장 · 정산 기간 · 지급 보류 · 지급 묶음·항목 · 강사 계좌 · 이의 · 대사) — 같은 폴더의 §7-3(정산 계좌)·§7-3b(사업자 상태 확인 기록)·§7-5(강사 몫 비율)·§7-8b(플랫폼 수수료율)는 다시 정의하지 않고 읽기만 한다. 작성 2026-11-20.

관련 요구: FR-124(플랫폼 수수료 5%·1년 면제) · FR-125(학원 월 정산) · FR-125a(카드 수수료 공제 표시) · FR-125c(환불 PG 수수료 대표 부담) · FR-125d(PG 결제 수수료 대표 부담) · FR-125e(취소 수수료 5:5·판매 수수료 5%) · FR-126(강사별 매출) · FR-127(강사 프리랜서) · FR-128(정산 3단계) · FR-129(정산 시각 전이) · FR-130(정산 단계별 금액) · FR-131(취소 예외 경로) · FR-132(정산 조정) · FR-133(강사 전용 계좌) · FR-133a(정산 지급 실패) · FR-133b(강사 정산 지급 흐름) · FR-134(플랫폼 내 정산 조회) · FR-135(정산 조회 범위) · FR-135a(개인 레슨 정산 (개설한 학원에서)) · FR-135c(노쇼 정산 기준) · FR-135d(원천징수 표기) · FR-135e(강사 정산 내역) · FR-135f(정산 이의 제기) · FR-139(강사 계좌 변경 재확인) · FR-252(정산 보류) · FR-252a(차지백 지급 보류) · FR-253(정산 상계) · FR-282e(이벤트형 환불 마감 뒤 즉시 지급) · FR-318(원장 대사) · FR-319(기준 시각·월 마감) · FR-319a(정산 원장 불변·마감·대사 중단) · SC-010a(조기 정산 지급 0건) · SC-010b(정산 합계 일치) · SC-010c(타 강사 정산 조회 0건) · Q14(돈이 흐르는 길) · Q19(정산 명세 내보내기) · Q23(강사 본인확인 시점) · Q33(강사 몫 비율) · Q35(정산일이 주말·공휴일일 때).

보드: 강사 앱 I17(정산) · I17B(정산 수업별 내역) · I17C(정산 기간별 명세) · I17D(정산 이의 제기) · I18(정산 계좌 등록 1/2 본인확인 재확인) · I18B(정산 계좌 등록 2/2 계좌 입력·예금주 확인) · I9(강사 마이) · I30(강사 탈퇴) — 대표 앱 O26(강사 지급 요약) · O29(이번 달 매출 요약) · O46(강사 정산 이의 답하기) · O47(지급 보류·차지백) · O49(강사 지급 승인, 정식 운영부터) — 관리자 웹 O4(정산·원장) · W7b(강사별 매출) · W11(강사 지급 승인) · W12(지급 보류·지급 실패·카드 이의제기) · W13(정산 명세) · W14(정산 이의 제기) · W28(강사 이의 확인) · W24(강사 몫 비율) · W8B(빠진 회차 정산 안내) — 운영자 P9(공휴일 관리) · P10(예금주 확인) · P11(사업자 상태 점검).

2026-11-20 사용자 결정을 따른다: D4(학원별 수수료 예외 없음 — 일반 5% · 개인 레슨 1%) · D12(개인 레슨 1% 공제 줄은 대표 명세에만, 강사 명세에는 없음). 플랫폼은 돈을 보관하지 않는다 — 베타는 대표가 은행 대량이체를 하고 「지급 완료」를 누르는 기록일 뿐이다(Q14).

## 흐름

```
결제 확정(M3) ─ 원장 줄 생성: sale(보류) + 수수료 줄 ─────────────────────────────┐
수업 시작 시각 → 정산 완료 예정 · 기간 종료 시각 → 정산 완료  (시간 작업, 출석을 보지 않는다)  │
환불(M4) ─ 보류·예정 단계면 refund 줄로 차감 · 완료 뒤면 다음 기간 adjustment 줄            │
정산일(매월 5일, 옮기지 않음) 00:00 KST 마감 시각 → 기간(settlement_periods) 확정            │
  → 학원 명세(W13) 확정 + 강사별 지급 묶음(payout_batches) 계산                              │
  → 대표 확인·승인(관리자 웹, 2단계 인증) → 지급 대상 파일 내려받기 → 은행 대량이체(앱 밖)      │
  → 「지급 완료」 표시 → 강사에게 알림 · 반송이 오면 그 항목만 지급 보류 → 다음 묶음            │
매일 대사(원장 ↔ 결제·환불 ↔ PG 거래 내역) · 이의 14일 뒤 월 마감 ◀──────────────────────────┘
```

「보류」(정산 단계, 수업 시작 전)와 「지급 보류」(돈이 멈춤)는 다른 이름이다. 이 계약의 값 이름은 단계 `hold`, 멈춤 `payout_hold` 로 갈라 쓴다(I-06).

## 권한 약어

| 약어 | 뜻 | 판정 |
|---|---|---|
| `instructor_self` | 강사 본인 | 세션의 `staff_accounts` 에 `role_grants(instructor, active)`. 앱·웹 모두. 남의 자원이면 403 `FORBIDDEN`(404 로 숨기지 않는다 — README §4) |
| `owner` | 그 학원 대표 | `requireStaff('owner', {academyId})`. 위임 강사는 403 — 매출·정산은 위임 대상 밖(FR-081a(위임 가능한 관리 권한)) |
| `owner_web` | `owner` + 관리자 웹 | `surface='web'` 이고 2단계 인증을 마친 세션. 앱 토큰이면 403 `WEB_ONLY` |
| `admin` | 운영자 | `role_grants(admin, active)` + 웹 2단계 인증 |
| `internal` | 시간 작업 | 헤더 `X-Internal-Token`(README §1) |

## 경로 한눈에 보기

| 메서드·경로 | 역할 | 권한 | 멱등 | 근거 FR | 보드 |
|---|---|---|---|---|---|
| **강사 — 정산 조회 (S5-2)** | | | | | |
| `GET /api/staff/settlements/overview` | 가장 가까운 정산·쌓이는 금액·지급 보류 | `instructor_self` | 읽기 | FR-135e(강사 정산 내역) · FR-130(정산 단계별 금액) | I17 |
| `GET /api/staff/settlements/items/{payoutItemId}` | 정산 한 건의 수업별 내역 | `instructor_self`(본인 항목만) | 읽기 | FR-135a · FR-135d | I17B |
| `GET /api/staff/settlements/statement` | 기간·학원을 고른 명세 | `instructor_self` | 읽기 | FR-135e · Q19 | I17C |
| `GET /api/staff/settlements/statement.xlsx` | 같은 명세 엑셀(xlsx) | `instructor_self` | 읽기(내려받기 기록 남김) | FR-134 · Q19 | I17C |
| `POST /api/staff/settlements/disputes` | 정산 이의(받지 못했어요 포함) | `instructor_self` | `Idempotency-Key` | FR-135f(정산 이의 제기) · FR-133b ⑤ | I17D |
| `GET /api/staff/settlements/disputes` | 내가 낸 이의와 답 | `instructor_self` | 읽기 | FR-135f | I17D · 「내 문의」 |
| **강사 — 정산 유형·계좌 (S5-2)** | | | | | |
| `GET` · `PUT /api/staff/settlement-profile` | 정산 유형(프리랜서·사업자) | `instructor_self` | PUT 은 전체 교체 | FR-127 | (보드 없음 — 열린 점 ③) |
| `GET /api/staff/payout-account` | 내 정산 계좌와 확인 상태 | `instructor_self` | 읽기 | FR-133 | I9 · I18 |
| `POST /api/staff/payout-account/identity-recheck` | 1단계: 본인확인 재확인 | `instructor_self` | 토큰 1회용 | FR-133 · Q23 | I18 |
| `PUT /api/staff/payout-account` | 2·3단계: 계좌 입력 + 통장 사본 → 확인 요청 | `instructor_self` | `Idempotency-Key` | FR-133 · FR-139 | I18B |
| **대표 — 정산 조회 (S5-1·S5-2)** | | | | | |
| `GET /api/academies/{academyId}/settlement/summary` | 이번 달 매출·정산 3단계·강사별·행사별 | `owner`(앱·웹) | 읽기 | FR-126(강사별 매출) · FR-130 | W7b · O29 |
| `GET /api/academies/{academyId}/settlement/ledger` | 원장 줄 목록 | `owner`(앱·웹) | 읽기 | FR-125e · FR-319a | O4 |
| `GET /api/academies/{academyId}/settlement/statements/{periodMonth}` | 월 정산 명세 | `owner`(앱·웹) | 읽기 | FR-125(학원 월 정산) · FR-125a · FR-125d | W13 |
| `GET /api/academies/{academyId}/settlement/statements.xlsx` | 명세 엑셀(xlsx)(기간) | `owner_web` | 읽기(기록 남김) | FR-134 · Q19 | W13 |
| `GET /api/academies/{academyId}/settlement/instructor-statements.xlsx` | 소속 강사 정산 엑셀(xlsx) | `owner_web` | 읽기(기록 남김) | FR-135(정산 조회 범위) | W7b |
| **대표 — 지급 (S5-3)** | | | | | |
| `GET /api/academies/{academyId}/payout-batches` | 지급 묶음 목록 | `owner`(앱·웹) | 읽기 | FR-133b | W11 · O26 |
| `GET /api/academies/{academyId}/payout-batches/{batchId}` | 묶음 상세(강사별 지급액) | `owner`(앱·웹) | 읽기 | FR-133b ② | W11 · O26 · O49 |
| `POST /api/academies/{academyId}/payout-batches/{batchId}/approve` | 확인·승인(강사 빼기 가능) | `owner_web`(정식 운영부터 앱도) | 묶음 상태 조건부 갱신 | FR-133b ③ | W11 · O49 |
| `GET /api/academies/{academyId}/payout-batches/{batchId}/transfer-file.xlsx` | 지급 대상 파일(승인 뒤만, 엑셀(xlsx) — 2026-11-24 변경, 이전: CSV) | `owner_web` | 읽기(기록 남김) | FR-133b ④ | W11 |
| `POST /api/academies/{academyId}/payout-batches/{batchId}/complete` | 지급 완료 표시 | `owner_web` | 묶음 단위 멱등 | FR-133b ④⑤ | W11 |
| `POST /api/academies/{academyId}/payout-batches/{batchId}/items/{itemId}/return` | 송금 반송 입력 | `owner_web` | 항목 상태 조건부 갱신 | FR-133a(정산 지급 실패) | W12 |
| `POST /api/academies/{academyId}/payout-batches/{batchId}/snooze` | 「내일 오전에 다시 알려 주기」 | `owner`(앱·웹) | 같은 날 재호출은 같은 본문 | FR-133b 승인 지연 재알림 | O26 |
| `GET /api/academies/{academyId}/payout-holds` | 멈춘 돈 목록 | `owner`(앱·웹) | 읽기 | FR-252(정산 보류) · FR-252a | W12 · O47 |
| `POST /api/academies/{academyId}/payout-holds/{holdId}/chargeback-response` | 카드 이의제기 소명 자료 내기 | `owner_web` | 사건 상태 조건부 갱신 | FR-252a(차지백 지급 보류) | W12 |
| **이의 (S5-3)** | | | | | |
| `POST /api/academies/{academyId}/settlement/disputes` | 대표가 플랫폼에 내는 이의 | `owner_web` | `Idempotency-Key` | FR-135f | W14 |
| `GET /api/academies/{academyId}/settlement/disputes` | 내가 낸 이의 + 소속 강사가 낸 이의 | `owner`(앱·웹) | 읽기 | FR-135f | W14 · O46 |
| `GET /api/academies/{academyId}/settlement/disputes/{disputeId}` | 강사 이의 상세 | `owner`(앱·웹) | 읽기 | FR-135f | W28 · O46 |
| `POST /api/academies/{academyId}/settlement/disputes/{disputeId}/answer` | 강사 이의에 답하기 | `owner`(앱·웹) | 이의 상태 조건부 갱신 | FR-135f · FR-132(정산 조정) | W28 · O46 |
| `GET /api/admin/settlement-disputes` · `POST /api/admin/settlement-disputes/{disputeId}/answer` | 대표 이의에 운영자가 답하기 | `admin` | 이의 상태 조건부 갱신 | FR-135f | (보드 없음 — 열린 점 ⑦) |
| **운영자 (P9·P10·P11 — 2026-11-20 통합, 15 에서 옮김)** | | | | | |
| `GET /api/admin/console/holidays` | P9 연도별 공휴일 | `admin` | 읽기 | FR-301 예외 | P9 |
| `POST /api/admin/console/holidays` | P9 공휴일 더하기 | `admin` | 날짜 유니크 | FR-301 예외 | P9 |
| `PATCH /api/admin/console/holidays/{holidayId}` | P9 운영자 입력 줄 고치기 | `admin` | 같은 값이면 변화 없음 | FR-301 예외 | P9 |
| `DELETE /api/admin/console/holidays/{holidayId}` | P9 운영자 입력 줄 지우기 | `admin` | 이미 지웠으면 200 | FR-301 예외 | P9 |
| `GET /api/admin/console/payout-verifications` | P10 예금주 확인 대기 목록 | `admin` | 읽기 | FR-133 보완 | P10 |
| `POST /api/admin/console/payout-verifications/{id}/confirm` | P10 확인 | `admin` | 이미 확인이면 200 | FR-133 보완 | P10 |
| `POST /api/admin/console/payout-verifications/{id}/reject` | P10 반려 | `admin` | 이미 반려면 200 | FR-133 보완 | P10 |
| `GET /api/admin/console/business-checks` | P11 요약 카드·감지 목록 | `admin` | 읽기 | FR-250·254 | P11 |
| `GET /api/admin/console/business-checks/{caseId}` | P11 건 상세(국세청 결과·소명) | `admin` | 읽기 | FR-250·254 | P11 |
| `POST /api/admin/console/business-checks/{caseId}/accept-explanation` | P11 소명 받아들이고 풀기 | `admin` | 이미 풀렸으면 200 | FR-254 | P11 |
| `POST /api/admin/console/business-checks/{caseId}/suspend-listing` | P11 게시 중단 | `admin` | 이미 중단이면 200 | FR-254 | P11 |
| **시간 작업 (internal)** | | | | | |
| `POST /api/internal/jobs/settlement/advance-stages` | 보류 → 예정 → 완료 전이 | `internal` | 조건부 갱신 | FR-129(정산 시각 전이) · FR-282e | — |
| `POST /api/internal/jobs/settlement/calculate-payouts` | 정산일 기간 확정·명세·지급 묶음 계산 | `internal` | `(academy, period)` 유니크 | FR-133b ② · FR-319a | — |
| `POST /api/internal/jobs/settlement/remind-unapproved` | 5영업일 미승인 재알림 | `internal` | 묶음별 알림 `dedupe_key` | FR-133b 승인 지연 재알림 | — |
| `POST /api/internal/jobs/reconciliation/run` | 매일 대사 + 웹훅 유실 보정 | `internal` | 어긋남 `finding_key` | FR-318(원장 대사) · FR-115(결제 금액 대조) | — |
| `POST /api/internal/jobs/settlement/close-periods` | 월 마감 | `internal` | 기간 상태 조건부 갱신 | FR-319(기준 시각·월 마감) | — |
| `POST /api/internal/jobs/holidays/sync` | 특일 정보 하루 1회 수집(올해·다음 해) → `holidays` 자동 줄 · `holiday_sync_runs` 연도별 1행. 실패한 해는 표를 그대로 두고 실패 줄만(S0-4.10) | `internal` | 같은 날짜·같은 값이면 변화 없음 · 해마다 한 트랜잭션 | Q35(정산일이 주말·공휴일일 때) | P9 |
| `POST /api/internal/jobs/business-status/check` | 사업자 상태 매일 점검(03:10 KST) → 해지되지 않은 학원마다 `business_status_checks` 1행(`trigger='daily'`) · error 가 아니면 `academies.business_status` 갱신. **error 는 조치 0**(학원 칸·제한 그대로). 본문은 `asOf`(dev)만 받고 다른 칸은 422. 정산 직전 점검(`pre_payout`)은 정산 지급 작업이 같은 서비스 함수를 학원 목록과 함께 직접 부른다(S1-1.27). 응답 `{ trigger, processed, recorded, skipped, byStatus }` | `internal` | 같은 KST 날짜에 error 아닌 daily 결과가 있는 학원은 건너뜀 · 학원마다 한 트랜잭션 | FR-250(입점 심사·게시 제한) · FR-252(정산 보류) | P11 |
| **시험 전용 (dev)** | | | | | |
| `POST /api/dev/fake-pg/webhooks/drop` · `POST /api/dev/fake-pg/chargebacks` · `POST /api/dev/settlement/skew-ledger` | 웹훅 1건 버리기 · 카드 이의제기 통지 · 원장 줄 일부러 어긋내기 | `/api/dev/**` 규칙 | — | S5-4 수용 ①② · FR-252a | — |

날짜 `month`·`periodMonth` 는 `YYYY-MM`(KST 달력, 「N월분」 = N월에 수업 기간이 끝난 몫, 정산일은 다음 달 5일). 금액은 모두 원 단위 정수(README §3), 시각은 `Z` 끝 UTC, 날짜는 KST 달력 `YYYY-MM-DD`. 은행 코드는 금융결제원 3자리(국민 `004` · 신한 `088`).

## 1. 정산 원장 읽기 — S5-1 · 대표(W7b · O29 · O4 · W13)

### 1-1. `GET /api/academies/{academyId}/settlement/summary?month=2026-11`

`month` 기본 이번 달(결제한 달, KST). 매출은 그 달에 결제된 `sale` 줄(`paid_at` 기준)이고, 단계 금액은 그 줄들의 **지금 단계**다(W7b 「이번 달 매출」). 정산 명세(§1-3)는 「수업 기간이 끝난 달」 기준이라 두 화면의 달은 다르다. 개인 레슨은 수업 내용 없이 금액만(W7b 각주).

```json
{ "academyId": "…", "month": "2026-11", "dataAsOf": "2026-11-20T01:00:00Z",
  "revenue": 3780000, "paymentsCount": 54, "classCount": 6,
  "stages": { "hold": 630000, "scheduled": 2100000, "completed": 1050000 },
  "byInstructor": [
    { "instructorAccountId": "…", "name": "이준호", "classCount": 3, "paymentsCount": 28, "revenue": 1960000,
      "stages": { "hold": 420000, "scheduled": 980000, "completed": 560000 },
      "classes": [ { "classId": "…", "title": "바차타 센슈얼 입문", "paymentsCount": 12, "revenue": 840000 } ],
      "privateLesson": { "paymentsCount": 2, "revenue": 330000 } } ],
  "events": [ { "offeringId": "…", "title": "12월 라틴 파티", "applicants": 34, "paid": 1120000, "payoutOn": "2026-12-12", "stage": "hold" } ],
  "nextSettleOn": "2026-12-05" }
```

- `revenue = Σ sale 줄 + Σ 그 달 대상 refund 줄`(환불을 뺀 순매출). `stages` 세 값의 합 = `revenue`(SC-010b(정산 합계 일치)의 한 달 조각)
- `events` 는 수업 매출과 따로 센다(O29). `payoutOn` = 환불 마감일 다음 날(FR-282e(이벤트형 환불 마감 뒤 즉시 지급)), `stage` 는 `hold`(마감 전) 또는 `completed`
- `10-owner-dashboard.md` 의 `month`·`nextPayout` 타일은 이 응답의 `stages`·`nextSettleOn` 과 §4-1 의 묶음 목록으로 채운다(`availableFrom` S5-1·S5-3)
- 위임 강사 403 · 다른 학원 대표 403 `FORBIDDEN`

### 1-2. `GET /api/academies/{academyId}/settlement/ledger?month=2026-10&kind=&cursor=&limit=50`

O4 의 원장 표. 줄은 최신순, `{ items, nextCursor, reconciled }`.

```json
{ "items": [ { "entryId": "…", "occurredOn": "2026-10-12", "kind": "refund", "label": "살사 온투 기초 · 대표 직접 입력", "paymentMethod": "virtual_account", "amount": -120000, "periodMonth": "2026-10" } ],
  "nextCursor": null,
  "reconciled": { "ok": true, "runDate": "2026-11-20", "dataAsOf": "2026-11-20T00:10:00Z" } }
```
- `kind` 는 data-model §10-9 값 집합(예: `sale` · `refund` · `card_fee`). 줄에 회원 이름·연락처는 넣지 않는다 — 주문 번호(`orderNo`)와 수업명만(FR-187(연락처 마스킹))
- `reconciled.ok` = 이 학원에 열린 어긋남(`reconciliation_findings.status='open'`)이 없음. O4 「합계가 결제 원장과 일치해요 ✓」 의 근거

### 1-3. `GET /api/academies/{academyId}/settlement/statements/{periodMonth}` — W13

정산 기간이 아직 `open` 이면 지금까지의 **미리보기**(`"preview": true`), `calculated`·`closed` 면 확정 값. 줄 순서는 FR-125(학원 월 정산) 대로 고정.

```json
{ "periodMonth": "2026-11", "settleOn": "2026-12-05", "cutoffAt": "2026-12-04T15:00:00Z", "preview": false, "status": "calculated",
  "lines": [
    { "code": "sale",        "label": "총 결제액",        "amount": 3780000, "detail": { "classCount": 6, "paymentsCount": 54 } },
    { "code": "platform_fee","label": "플랫폼 수수료",    "amount": 0, "detail": { "rateBp": 500, "exemptUntil": "2027-10-02", "privateLessonFee": 0 } },
    { "code": "card_fee",    "label": "카드 결제 수수료",  "amount": -100800, "detail": { "paymentsCount": 48, "base": 3360000 } },
    { "code": "pg_fee",      "label": "PG 결제 수수료",   "amount": -4200, "detail": { "paymentsCount": 6, "base": 420000 } },
    { "code": "refund",      "label": "환불 조정",        "amount": -90000, "detail": { "count": 1 } },
    { "code": "refund_pg_fee","label": "환불 PG 수수료",  "amount": -2700 },
    { "code": "booking_fee_reimbursement","label": "예매 수수료 보전(청약철회)",  "amount": 0, "detail": { "count": 0 } },
    { "code": "payout_hold", "label": "지급 보류",        "amount": -160000, "detail": { "chargeback": 1, "refundPending": 1 } },
    { "code": "offset",      "label": "상계",            "amount": 0 } ],
  "netAmount": 3422300, "couponUses": 4, "newMembers": 14,
  "instructorPayout": { "completedRevenue": 1050000, "instructorShare": 630000, "netAfterWithholding": 609210, "batchId": "…" },
  "dispute": { "deadlineOn": "2026-12-19", "canFile": true } }
```
- `netAmount = Σ lines.amount`(원장 합계와 1원도 다르지 않아야 한다 — 어긋나면 `calculate-payouts` 가 그 학원을 `statement_sum_mismatch` 로 막는다, FR-319a(정산 원장 불변·마감·대사 중단))
- 확정 뒤 환불 조정(`adjustment`, 사유 `refund_after_completion`)은 `refund` 줄에 합쳐 보이고, 그 밖의 조정(이의 수용·수동·대사 보정)은 `adjustment` 줄로 따로 나온다(예시는 0 이라 줄이 빠져 있다)
- 개인 레슨분의 1% 공제는 `platform_fee` 줄의 `detail.privateLessonFee` 로 따로 보인다(D12 — 대표 명세에만, 강사 명세에는 없음). 강사 가입일부터 1년 안의 개인 레슨은 이 공제가 0 이다(2026-11-23 변경 — 이전: 항상 1%). 면제 판정에 강사 가입일이 필요하다: `instructor_profiles.signup_completed_at`(강사 가입을 마친 시각, KST 날짜 + 1년 그날까지 면제)을 쓴다 — S3-3.17(개인 레슨 수수료 강사 가입 1년 면제)(추천안·사후 확인 2026-11-24). 주문의 `platform_fee_rate_bp` 에 0 이 고정되므로 정산은 그 값을 그대로 쓴다
- 예매 수수료(1명 2,000원)는 플랫폼 몫이라 줄에 넣지 않는다(W13 각주, FR-282b(예매 수수료 결제 수수료 안분)). **예외 하나**: 법정 청약철회 환불의 계좌분은 대표가 예매 수수료까지 전액 송금하므로 송금 완료 때 `booking_fee_reimbursement` 줄(+2,000원, 예매 수수료 보전)이 생겨 다음 정산 `netAmount` 에 더해진다. 카드분은 PG 전액 환불로 플랫폼 몫이 줄 뿐 줄이 없다(2026-11-20 사용자 결정 D23)
- 이벤트형 행사 몫은 환불 마감일 뒤 따로 정산하고 이 명세의 같은 달에 `sale` 로 들어간다(마감일 다음 날에 완료가 되므로, FR-282e)

### 1-4. 엑셀(xlsx) — `GET …/settlement/statements.xlsx?from=2026-09&to=2026-11` · `GET …/settlement/instructor-statements.xlsx?from=&to=&instructorAccountId=`

`owner_web`. 범위는 최대 12개월(**추천값**), 넘으면 422 `VALIDATION_FAILED`. 응답 `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 파일 이름 `settlement_<academy>_<from>_<to>.xlsx`(2026-11-24 변경 — 이전: CSV, UTF-8 BOM).
- 명세 엑셀 열(W13): `일자 · 주문 번호 · 수업 · 결제 수단 · 결제액 · 수수료 · 환불 · 보류 · 상계 · 실지급액`. 회원 이름·연락처·계좌는 넣지 않는다(Q19(정산 명세 내보내기), FR-187)
- 강사 정산 엑셀 는 §2-3 의 열과 같고, `instructorAccountId` 가 없으면 소속 전원(S5-2 수용 ④). 대표가 아닌 사람이 부르면 403
- **엑셀 구현 규칙**(2026-11-24 확정): 금액은 숫자 칸, 주문 번호는 글자 칸(앞자리 0 보존), 회원 연락처는 넣지 않는다. 강사 지급 대상 목록(베타 대량이체용)도 엑셀이다. 라이브러리는 정하지 않았다 — 구현 Task 에서 고른다(설치 승인 필요).
- 내려받을 때마다 감사 `settlement.exported`(엑셀 내려받기 기록 — 2026-11-24 이름 변경, 이전: settlement.csv_exported, 추천안·사후 확인)(누가·언제·범위, FR-193(개인정보 접근 기록·유출 대응))

## 2. 강사 정산 조회·이의 — S5-2 · S5-3(I17 ~ I17D)

### 2-1. `GET /api/staff/settlements/overview?academyId=` — I17

`academyId` 를 주면 그 학원만. 강사는 학원마다 대표가 따로 승인하므로 학원 한 줄씩 나온다.

```json
{ "settlements": [
    { "payoutItemId": "…", "academyId": "…", "academyName": "라틴하우스 강남", "settleOn": "2026-11-05", "periodMonth": "2026-10",
      "netAmount": 967000, "status": "calculated", "step": 1, "calculatedOn": "2026-11-05", "remindOn": "2026-11-12" },
    { "payoutItemId": "…", "academyId": "…", "academyName": "라틴스텝 서초", "settleOn": "2026-11-05", "periodMonth": "2026-10",
      "netAmount": 273000, "status": "paid", "step": 3, "paidOn": "2026-11-06" } ],
  "headline": { "settleOn": "2026-11-05", "netAmount": 1240000, "step": 1, "academyCount": 2 },
  "accumulating": { "nextSettleOn": "2026-12-05", "total": 2166000, "stages": { "hold": 420000, "scheduled": 1386000, "completed": 360000 } },
  "payoutHolds": [ { "kind": "refund_pending", "amount": 58500, "message": "쌈바(입문) 환불 요청 1건이 처리되지 않았어요. 대표가 처리하면 다음 정산에 들어가요." } ] }
```
- `step`: 1 = 계산 완료(대표 승인 대기) · 2 = 대표 승인 · 3 = 지급 완료. 항목 상태와의 대응은 data-model §10-8
- `accumulating` 은 이 강사의 `sale` 줄 단계별 합에 결제 시각의 몫 비율을 곱한 **강사 몫 기준** 값이다(원천징수 전, 열린 점 ⑯). `payoutHolds` 는 단계 합계에 넣지 않는다(I17 「위 금액과 별도」)
- `remindOn` = `approval_due_on`(정산일 + 5영업일). 학원 직원 소속의 정산은 나오지 않는다(강사 몫 없음, FR-127)
- 단계 금액을 내보낼 때 원천징수 3.3% 는 프리랜서에게만 `withholdingAmount` 를 붙인다(§2-2)

### 2-2. `GET /api/staff/settlements/items/{payoutItemId}` — I17B

남의 항목이면 403 `FORBIDDEN`(SC-010c(타 강사 정산 조회 0건)). 개인 레슨 1% 공제 줄은 **없다**(D12).

```json
{ "payoutItemId": "…", "academyName": "라틴하우스 강남", "settleOn": "2026-11-05", "status": "calculated", "settlementType": "freelancer",
  "classLines": [ { "lineKind": "academy_class", "title": "쌈바(입문) · 10월 과정", "paidCount": 6, "classAmount": 1740000, "shareRateBp": 6000, "shareAmount": 1044000 },
                  { "lineKind": "academy_class", "title": "룸바 원데이 · 무료", "paidCount": 8, "classAmount": 0, "shareRateBp": null, "shareAmount": 0 },
                  { "lineKind": "private_lesson", "title": "라틴 10회 수강권 · 5회 진행", "paidCount": 2, "classAmount": 550000, "shareRateBp": 6000, "shareAmount": 330000 } ],
  "adjustments": [ { "lineKind": "refund_adjustment", "label": "9월 쌈바(입문) 정산 뒤 환불 1건", "amount": -26000 } ],
  "grossAmount": 1348000, "withholding": { "applies": true, "rateBp": 330, "amount": -44484, "payer": "academy" },
  "netAmount": 1303516,
  "formula": "1,044,000 + 0 + 330,000 − 26,000 − 44,484",
  "dispute": { "deadlineOn": "2026-11-19", "canFile": true } }
```
- 무료 수업은 0원 줄로 남긴다(I17B). 신청 인원은 예약 수로 센다 — 원장에 줄이 없는 무료 신청의 0원 줄 출처는 열린 점 ⑧
- `withholding` 은 프리랜서에게만 `applies: true`(FR-135d(원천징수 표기)). 사업자 강사는 계산서(`applies: false, note: "invoice"`), 학원 직원은 정산 자체가 없다. 플랫폼은 금액만 표시하고 신고·납부는 학원이 한다(Q18)
- 보드 I17B 예시의 원천징수 33,000 은 3.3% 계산과 맞지 않는 예시값이다 — 계약은 세전 지급액 × 3.3%(열린 점 ⑤)

### 2-3. `GET /api/staff/settlements/statement?from=2026-08&to=2026-10&academyId=` · `…/statement.xlsx` — I17C

`from`·`to` 는 `YYYY-MM`(수업 기간이 끝난 달 기준), 최대 12개월. 본인 정산만(Q19).

```json
{ "from": "2026-08", "to": "2026-10", "settlements": [
    { "settleOn": "2026-11-05", "summary": "강남 대표 승인 대기 · 서초 지급 완료", "netAmount": 1240000 },
    { "settleOn": "2026-10-05", "summary": "학원 2곳 · 지급 완료", "netAmount": 1358000 } ],
  "totals": { "classCount": 38, "privateLessonCount": 14, "academyCount": 2, "completedAmount": 3880000, "adjustmentAmount": -44000, "withholdingAmount": -126000, "netAmount": 3710000 } }
```
엑셀 열(I17C): `정산일 · 학원 · 수업 · 구분 · 회차 · 완료분 · 조정 · 원천징수 · 실지급액 · 상태`. 수강생 연락처는 넣지 않는다. 감사 `settlement.exported`.

### 2-4. 이의 — `POST /api/staff/settlements/disputes` (I17D)

헤더 `Idempotency-Key`. 요청
```json
{ "payoutItemId": "…", "payoutItemLineId": "…", "reasonCode": "refund_deduction", "claimedAmount": null,
  "body": "9월 환불 1건이 9월 정산에서 이미 빠진 것 같아요.", "fileIds": [] }
```
- `reasonCode`: `amount_differs`(금액이 달라요) · `missing_class`(빠진 수업이 있어요) · `refund_deduction`(환불 차감) · `other`(기타) · `not_received`(받지 못했어요 — FR-133b ⑤, 항목이 `paid` 일 때만)
- 기한: 정산일 + 14일(**추천값**, FR-135f(정산 이의 제기)). 넘으면 409 `DISPUTE_WINDOW_CLOSED`. 같은 줄에 처리 전 이의가 있으면 409 `DISPUTE_ALREADY_FILED`
- 받는 사람은 그 학원 대표다(운영자가 아니다). 알림 `settlement_dispute_filed`(대표) · 감사 `settlement_dispute.filed`
- 응답 201 `{ "disputeId", "status": "received", "deadlineOn": "2026-11-19", "handlerKind": "owner", "steps": ["received","owner_review","next_period_adjustment"] }`
- `GET /api/staff/settlements/disputes` → `{ items: [{ disputeId, status, reasonCode, academyName, settleOn, claimedAmount, adjustmentAmount, answerText, answeredAt }] }`. 답은 알림 `settlement_dispute_answered` 와 「내 문의」에 남는다

## 3. 강사 정산 유형·계좌 — S5-2 (I18 · I18B · I9)

### 3-1. 정산 유형 — `GET` · `PUT /api/staff/settlement-profile` (FR-127)

세 유형 가운데 **학원 직원**은 강사 개인 값이 아니라 학원마다 대표가 켜는 표시(`instructor_affiliations.is_academy_employee`, 08 §4)다. 이 경로는 나머지 둘 — 프리랜서 · 사업자 — 만 다룬다.

`PUT` 요청 `{ "taxType": "business" }`(`freelancer`·`business`). **사업자등록번호·등록증은 이 경로가 받지 않는다** — `instructor_profiles` 한 곳에 두고 `11-instructor.md` §2-2 `PUT /api/instructor/me/business-registration` 으로만 넣는다(2026-11-20 통합). `business` 인데 `instructor_profiles.business_registration_number` 가 비어 있으면 422 `VALIDATION_FAILED`(`fields: ["businessRegistrationNumber"]` — 앱은 사업자 정보 입력으로 보낸다). 응답 200 `{ "taxType", "businessRegistrationMasked": "123-**-***90" | null }`(번호는 `instructor_profiles` 에서 읽어 가린다). 감사 `instructor_settlement_profile.changed`. 사업자번호의 국세청 진위 조회는 하지 않는다(열린 점 ③).

### 3-2. `GET /api/staff/payout-account` — I9 · I18

```json
{ "account": { "accountId": "…", "bankCode": "004", "accountMasked": "****-3390", "holderName": "이준호",
               "verificationStatus": "verified", "verifiedAt": "2026-10-02T03:10:00Z", "rejectReason": null, "payable": true },
  "payDayLabel": "매월 5일 지급",
  "needsAccount": false, "heldAmount": 0 }
```
- 계좌가 없으면 `account: null`, `needsAccount: true`, `heldAmount` = 계좌 미등록으로 쌓인 지급 보류 합계(I18 「등록하지 않으면 정산금은 지급 보류로 쌓여요」)
- `verificationStatus`: `pending`(운영자 대기) · `verified` · `rejected`. `payable` = 활성 + `verified`
- 응답에 계좌번호 전체는 없다(FR-299(결제 정보 보안)). 학원 직원만 소속된 강사는 `needsAccount: false`(계좌 불필요)

### 3-3. 1단계 `POST /api/staff/payout-account/identity-recheck` — I18

가입 때 본인확인과 **같은 사람인지**만 본다(Q23(강사 본인확인 시점) — 2026-11-18). 주민등록번호는 받지 않는다. 앱이 본인확인 창에서 받은 토큰을 보낸다(`IdentityVerificationPort.verify`, 06-ports).

요청 `{ "verificationToken": "…" }` → 200 `{ "recheckId": "…", "verifiedName": "이준호", "expiresAt": "2026-11-20T01:30:00Z" }`

| HTTP | code | 언제 |
|---|---|---|
| 422 | `IDENTITY_TOKEN_INVALID` | 토큰이 틀렸거나 만료(`reason: invalid · expired`) |
| 409 | `IDENTITY_MISMATCH` | 본인확인 CI 가 가입 때 CI(`staff_accounts.identity_ci_hash`)와 다르다 — 로그인된 휴대폰을 다른 사람이 쓰는 경우. 시도는 `result='mismatch'` 로 남긴다 |
| 429 | `RATE_LIMITED` | 15분에 5회 넘는 실패(README §6-4) |

재확인은 30분(**추천값**) 유효하고 한 번 쓰면 끝난다.

### 3-4. 2·3단계 `PUT /api/staff/payout-account` — I18B

헤더 `Idempotency-Key`. 요청
```json
{ "recheckId": "…", "bankCode": "004", "accountNumber": "00000000000000", "holderName": "이준호", "holderProofFileId": "…" }
```
`holderProofFileId` 는 `POST /api/files`(07 §1)에 `purpose=holder_proof` 로 올린 통장 사본이다(공개하지 않는 파일, 올린 사람과 운영자만 연다 — 07 의 파일 규칙 확장).

| # | 검사(한 트랜잭션) | 실패 |
|---|---|---|
| 1 | 같은 키 재요청이면 처음 응답 그대로 200 | — |
| 2 | `recheckId` 가 내 것·`matched`·미사용·미만료 | 422 `RECHECK_REQUIRED` |
| 3 | `holderName` = 재확인의 `verifiedName`(공백 제거 비교) — 다른 사람·법인 명의 금지 | 422 `ACCOUNT_HOLDER_MISMATCH` |
| 4 | 은행 코드 목록 안, 계좌번호 숫자 8~16자리(**추천값**) | 422 `VALIDATION_FAILED` |
| 5 | 통장 사본 파일이 내 것·미첨부 | 422 `HOLDER_PROOF_REQUIRED` |
| 6 | 옛 활성 계좌 `replaced` + 새 계좌 `active`(`verification_status='pending'`) + 재확인 `used_at` + 파일 `attached_at` | — |
| 7 | 알림 `payout_account_changed`(강사 본인, 가린 번호) · 감사 `instructor_payout_account.changed`(전후 모두 가린 값) · 운영자 확인 대기열(P10)에 올라감 | — |

응답 200 `{ "accountId", "accountMasked": "****-3390", "verificationStatus": "pending", "expectedReviewBy": "2026-11-23" }` — `expectedReviewBy` 는 영업일 1일 뒤(P10 「처리 기한 1영업일」, S0-4.8 계산 함수).
- 계좌를 바꾸면 **지급은 새 계좌가 확인될 때까지 멈춘다**(M1 대표 계좌 규칙과 같다, 07 §4). 진행 중인 정산은 확인 뒤 첫 지급부터 새 계좌로 나간다(FR-133). 멈춘 금액은 지급 보류(`account_unverified`)로 쌓여 확인 뒤 다음 묶음에 합쳐진다
- 앱에서 바꾼다(I18·I18B). 웹에서만 바꾸는 안은 Q34(강사 정산 계좌 변경 경로)가 바뀌면 같은 계약으로 `surface` 만 조인다(열린 점 ②)

## 4. 대표 승인 일괄 지급 — S5-3 (W11 · O26 · O49 · W12 · O47)

### 4-1. `GET /api/academies/{academyId}/payout-batches/{batchId}` — W11 · O26

묶음은 정산일 계산(§7-2) 때 만들어진다. 이 학원 소속 강사 **전원**이 `rows` 에 나온다 — 지급이 없는 강사도 이유와 함께(W11 「이번 달 지급 없음」 · 「학원 직원」).

```json
{ "batchId": "…", "academyId": "…", "periodMonth": "2026-11", "settleOn": "2026-12-05", "approvalDueOn": "2026-12-11",
  "status": "calculated", "mode": "manual", "steps": ["check", "approve", "bank_transfer", "mark_paid"], "currentStep": 1,
  "rows": [
    { "itemId": "…", "instructorAccountId": "…", "name": "이준호", "settlementType": "freelancer",
      "completedRevenue": 560000, "shareRatesBp": [6000], "grossShare": 336000, "withholding": -11088, "netAmount": 324912,
      "account": { "bankCode": "004", "accountMasked": "****-1234", "payable": true }, "status": "calculated", "selectable": true },
    { "itemId": null, "name": "박서윤", "settlementType": "freelancer", "netAmount": 0, "status": "none",
      "note": { "code": "HOLD_TRANSFER_RETURNED", "amount": 126000, "message": "10월 반송분 126,000원은 계좌를 다시 등록하면 지급해요" } },
    { "itemId": null, "name": "최한결", "settlementType": "academy_employee", "netAmount": 0, "status": "none",
      "note": { "code": "ACADEMY_EMPLOYEE", "message": "학원 직원 · 강사 몫 없음 (학원 매출로 처리해요)" } } ],
  "totals": { "itemCount": 1, "grossShare": 336000, "withholding": -11088, "netAmount": 324912 },
  "approval": { "canApprove": true, "blockedBy": null, "webOnlyInBeta": true },
  "transferFile": { "available": false },
  "reminder": { "count": 0, "lastRemindedAt": null, "snoozedUntil": null } }
```
- `mode`: `manual`(베타: 파일을 받아 은행 대량이체) · `pg_payout`(정식 운영: 같은 승인이 PG 지급대행, S8-1). `PayoutPort` 가 정한다(§9)
- `rows[].status`: `calculated` · `approved` · `paid` · `returned` · `held` · `none`(항목 없음). `held` 에는 `heldReason`(`account_unverified` · `academy_restricted` · `owner_excluded`)
- `approval.blockedBy`: 열린 대사 어긋남이 있으면 `reconciliation_mismatch`, 열린 학원 제한(`payout_hold`)이 있으면 `academy_restricted`, 아니면 null. 막힌 학원만 막힌다(FR-319a)
- 강사 몫 비율이 빈칸인 강사는 항목을 만들지 않고 `note.code: SHARE_RATE_MISSING` 으로 표시하며 대표·강사에게 알림 `share_rate_missing`(W24 안전망)

### 4-2. `POST …/payout-batches/{batchId}/approve` — W11 「승인하고 지급 대상 내려받기」

`owner_web`(2단계 인증 세션). 앱 토큰은 403 `WEB_ONLY`(베타 — O26·O49). 정식 운영에서 `PAYOUT_APPROVE_IN_APP=true` 로 켜면 앱도 받는다. 헤더 `Idempotency-Key`.

```json
{ "includeItemIds": ["…"], "excluded": [ { "itemId": "…", "reasonText": "계약 확인이 끝나지 않았어요" } ], "expectedNetTotal": 324912, "expectedItemCount": 1 }
```
| # | 검사(한 트랜잭션) | 실패 |
|---|---|---|
| 1 | 묶음이 `calculated` — `UPDATE … SET status='approved' WHERE id=$1 AND status='calculated'`(0행이면 이미 처리됨) | 이미 `approved` 면 200 같은 본문 · 다른 상태 409 `PAYOUT_STATE_CONFLICT` |
| 2 | 학원에 열린 대사 어긋남·`statement_sum_mismatch` 없음 | 409 `RECONCILIATION_MISMATCH`(FR-319a) |
| 3 | `includeItemIds` ∪ `excluded` = `selectable` 항목 전부, 서로 겹치지 않음 | 422 `ITEM_SELECTION_INCOMPLETE` |
| 4 | 빠진 항목마다 사유 | 422 `EXCLUDE_REASON_REQUIRED` |
| 5 | 승인 대상 `netAmount` 합·개수가 `expectedNet*` 과 같다(화면에서 본 금액이 그대로인지) | 409 `PAYOUT_TOTAL_CHANGED` |
| 6 | 항목 `calculated` → `approved`, 빠진 항목은 `held`(`owner_excluded`) + 지급 보류 행 + 알림 `payout_held`(강사, 사유·금액) | — |
| 7 | 감사 `payout_batch.approved`(누가·언제·대상 수·합계, FR-133b ③) | — |

응답 200 `{ "batchId", "status": "approved", "approvedAt", "approvedItemCount": 1, "approvedNetTotal": 324912, "excludedItemCount": 0, "transferFileUrl": "/api/academies/…/transfer-file.xlsx" }`.
- 플랫폼이 대표 대신 승인하지 않는다(FR-133b 승인 지연 재알림). 승인 확인 팝업(금액·강사·되돌릴 수 없음)은 화면 몫이고, 서버는 6·`expectedNet*` 로 화면과 같은 금액인지만 본다

### 4-3. `GET …/transfer-file.xlsx` — 지급 대상 파일

`owner_web`. 엑셀(xlsx) 파일(2026-11-24 변경 — 이전: CSV): 응답 `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, 금액은 숫자 칸, 계좌번호는 글자 칸(앞자리 0 보존). 라이브러리는 구현 Task 에서 고른다(설치 승인 필요). 묶음이 `approved` 이상일 때만 — 승인 전 내려받기는 409 `PAYOUT_NOT_APPROVED`(S5-3 수용 ①). 열 `이름 · 은행 · 계좌번호 · 금액`(FR-133b ④), 승인된 항목만, 금액은 `netAmount`(원천징수를 뺀 실지급액). **은행 이체에 필요해 계좌번호 전체가 들어가는 유일한 응답**이다 — 내려받을 때마다 감사 `payout.transfer_file_downloaded`(누가·언제·행 수·합계, 계좌번호는 남기지 않는다, FR-193)를 쓰고 로그에 본문을 남기지 않는다. 다시 내려받는 것은 허용하되 매번 기록한다(열린 점 ⑨).

### 4-4. `POST …/complete` — 지급 완료 표시

`owner_web`. 헤더 `Idempotency-Key`(없으면 `sha256("complete:" + batchId)`). 한 트랜잭션: 묶음 `approved` → `completed` 조건부 갱신 → 승인된 항목 전부 `approved` → `paid`(`paid_at`) → 알림 `payout_paid`(강사마다, 지급일·금액) → 감사 `payout_batch.completed`.
- 같은 묶음에 두 번 불러도 항목·알림은 한 번(S5-3 수용 ②): 2번째는 묶음이 이미 `completed` 라 200 + 같은 본문
- `approved` 가 아니면 409 `PAYOUT_STATE_CONFLICT`. 파일을 한 번도 내려받지 않았어도 막지 않는다(대표가 다른 경로로 보냈을 수 있다 — 기록일 뿐이다, 열린 점 ⑨)
- 응답 200 `{ "batchId", "status": "completed", "completedAt", "paidItemCount": 1, "paidNetTotal": 324912 }`

### 4-5. `POST …/items/{itemId}/return` — 송금 반송 (FR-133a(정산 지급 실패))

요청 `{ "reasonText": "예금주가 달라요", "returnedOn": "2026-12-06" }`. 항목 `paid` → `returned` 조건부 갱신 한 문장(0행이면 이미 반송됨 → 200 같은 본문, `approved` 등이면 409 `PAYOUT_STATE_CONFLICT`). 같은 트랜잭션에 지급 보류 행(`transfer_returned`, 강사 몫, 그 항목 금액만) · 알림 `payout_held`(강사, 사유·금액) · 감사 `payout_item.returned`. 계좌를 다시 등록하고 확인되면 다음 묶음에 `hold_release` 줄로 합쳐진다(S5-3 수용 ③). 응답 200 `{ "itemId", "status": "returned", "holdId", "amount": 126000 }`.

### 4-6. `POST …/snooze` · 재알림 — O26

`{ "until": null }` — 다음 KST 09:00 까지 오늘 알림을 미룬다. 응답 200 `{ "snoozedUntil": "2026-12-05T..Z" }`. 재알림 자체는 `remind-unapproved`(§7-3)가 `snoozed_until` 을 지키며 보낸다.

## 5. 지급 보류·차지백 — S5-1 · S5-3 (W12 · O47)

### 5-1. `GET /api/academies/{academyId}/payout-holds?status=open`

```json
{ "items": [
    { "holdId": "…", "kind": "chargeback", "party": "academy", "amount": 90000, "label": "정우진 · 바차타 센슈얼 입문 · 카드 결제 11/2", "statusLabel": "소명 필요",
      "chargeback": { "cardReason": "수업을 받지 못했어요", "responseDueAt": "2026-12-14T14:59:59Z", "status": "open", "instructorShare": { "amount": 54000, "instructorName": "이준호" } } },
    { "holdId": "…", "kind": "transfer_returned", "party": "instructor", "amount": 126000, "label": "박서윤 강사 · 10월분 · 11/6 반송 · 예금주가 달라요", "statusLabel": "계좌 다시 등록 대기" },
    { "holdId": "…", "kind": "refund_pending", "party": "academy", "amount": 70000, "label": "최하은 · 살사 온투 기초 · 환불 요청 11/9", "statusLabel": "환불 처리 대기" } ],
  "totals": { "count": 3, "amount": 286000, "academyParty": 160000, "instructorParty": 126000 } }
```
- `kind`: `chargeback` · `refund_pending` · `transfer_returned` · `account_unverified` · `academy_restricted` · `owner_excluded` · `regulatory`. 보드 W12 는 앞 셋만 그렸다 — 나머지는 같은 표에 사유 칩만 달리 보인다
- 단계 `보류`(수업 시작 전)와 다른 말임을 화면 머리에 적는다(W12)
- 응답에 회원 이름이 나오는 줄은 카드 이의제기·환불 요청뿐이고 닉네임·이름 이니셜만(**추천값**). 연락처는 없다(FR-187)
- 앱(O47)은 같은 응답을 쓰고 소명 자료 올리기는 웹에서만 한다

### 5-2. `POST …/payout-holds/{holdId}/chargeback-response` — 소명하기 (W12)

`owner_web`. `multipart` 가 아니라 먼저 `POST /api/files` 로 올린 `fileIds` 를 받는다. 요청 `{ "note": "수업 안내와 출석 연락 기록이에요", "fileIds": ["…"] }`. 결제·환불 기록과 결제 때 환불·취소 공지(판본)는 서버가 **자동 첨부**한다.
- `chargeback_cases.status='open'` 이고 `response_due_at` 전일 때만: `open` → `responded` 조건부 갱신. 기한이 지났으면 409 `CHARGEBACK_RESPONSE_CLOSED`(기한 안에 올리지 않으면 이의제기가 받아들여진다 — O47) · 이미 응답했으면 200 같은 본문
- 결과(카드사 결정)는 PG 통지로 들어온다: 학원 쪽이면 지급 보류 해제 + 다음 정산에 포함, 회원 쪽이면 환불로 처리(M4 환불 경로)하고 이미 지급한 몫은 `offset` 줄로 다음 정산에서 뺀다(FR-253(정산 상계)). 입점 해지(15 §3-7) 뒤 회원 환불금도 같은 `offset` 줄(사유 `termination_refund`)로 남은 정산금에서 먼저 빼고, 모자라면 운영자가 대표에게 수동 청구한다(2026-11-20 사용자 결정 D19)
- 카드 이의제기 통지 자체는 새 경로가 아니라 **웹훅 처리기**(`POST /api/payments/webhook`, 03)가 `chargeback.opened` 를 받아 `openChargeback()` 서비스를 부른다. 한 트랜잭션: 사건 행 + `payout_hold`(학원 몫) 원장 줄 + 지급 보류 행 + 알림 `chargeback_opened`(대표, 강사 몫이 걸리면 그 강사에게도) · 감사. 같은 PG 사건 번호는 한 번(`uq_chargeback_pg_case`)

## 6. 이의 처리 — S5-3 (W28 · O46 · W14)

### 6-1. 대표가 플랫폼에 내는 이의 `POST /api/academies/{academyId}/settlement/disputes` (W14)

헤더 `Idempotency-Key`. 요청 `{ "periodMonth": "2026-11", "lineCode": "card_fee", "reasonText": "카드사 매출 자료로는 카드 수수료가 2.5%라 84,000원이에요.", "claimedAmount": -84000, "fileIds": ["…"] }`. `lineCode` 는 §1-3 명세 줄 코드. 기한 = 정산일 + 14일(`dispute.deadlineOn`), 넘으면 409 `DISPUTE_WINDOW_CLOSED`. 응답 201 `{ "disputeId", "status": "received", "handlerKind": "admin" }`. 알림 `settlement_dispute_filed`(운영자 알림함) · 감사.

### 6-2. 강사 이의 확인 `GET …/settlement/disputes/{disputeId}` (W28 · O46)

대표(`owner`)만, 그 학원 소속 강사의 이의만(다른 학원이면 403).
```json
{ "disputeId": "…", "filerKind": "instructor", "instructorName": "박서윤", "status": "received", "filedAt": "2026-11-10T01:00:00Z", "deadlineOn": "2026-11-19",
  "settleOn": "2026-11-05", "periodMonth": "2026-10", "reasonCode": "amount_differs", "line": { "label": "10월 개인 레슨 · 10회 수강권 1건", "systemAmount": 126000 },
  "claimedAmount": 147000, "differenceAmount": 21000, "body": "학원과 정한 몫으로 계산하면 147,000원이에요.", "files": [],
  "evidence": [ { "kind": "share_rate_change", "label": "강사 몫 변경 기록 — 10/20 (화) 대표가 바꿈" },
                { "kind": "order_paid_at", "label": "이 레슨 결제 — 10/2 (금) · 바꾸기 전에 결제돼 바꾸기 전 값으로 계산됐어요" } ] }
```
근거는 결제·정산 기록과 강사 몫 변경 기록(`instructor_share_rates`)이다. **출석 기록은 쓰지 않는다**(W28).

### 6-3. `POST …/settlement/disputes/{disputeId}/answer`

요청 `{ "decision": "accepted", "adjustmentAmount": 21000, "answerText": null }` 또는 `{ "decision": "rejected", "answerText": "10월 결제분은 몫을 바꾸기 전에 결제돼 …" }`.
- `accepted` 는 `adjustmentAmount`(≠ 0) 필수 → 422 `ADJUSTMENT_AMOUNT_REQUIRED`. `rejected` 는 `answerText` 필수 → 422 `VALIDATION_FAILED`
- `received` → `accepted`·`rejected` 조건부 갱신(0행이면 같은 결정이면 200 같은 본문, 다른 결정이면 409 `DISPUTE_ALREADY_ANSWERED`)
- 받아들이면 **다음 정산에 조정 행 1개**(S5-3 수용 ⑤): 강사 이의는 그 강사의 다음 지급 묶음에 `dispute_adjustment` 줄 1개(계산 때 만든다), 대표 이의는 원장에 `adjustment`(사유 `dispute_accepted`) 줄 1개를 같은 트랜잭션에서 쓴다. 이미 지난 정산은 고치지 않는다(FR-132(정산 조정))
- 알림 `settlement_dispute_answered`(낸 사람) · 감사 `settlement_dispute.answered`. 응답 200 `{ "disputeId", "status", "adjustmentApplyOn": "2026-12-05" }`
- 운영자가 대표 이의에 답하는 `POST /api/admin/settlement-disputes/{id}/answer` 는 같은 요청·응답이다

## 7. 시간 작업 — `X-Internal-Token` (README §1)

모든 작업은 멱등이다. 요청 본문 `{ "now": "…Z" }` 는 **dev 설정에서만** 받는다(시험용 시계 주입, `Clock` 포트 대신).

### 7-1. `POST /api/internal/jobs/settlement/advance-stages` — S5-1.3 · S5-1.5

단계 전이는 **시각으로만** 판정한다(출석 기록을 보지 않는다, FR-129(정산 시각 전이)). 조건부 갱신 두 문장:
`… SET stage='scheduled' WHERE kind='sale' AND stage='hold' AND scheduled_at <= now` · `… SET stage='completed' WHERE kind='sale' AND stage IN ('hold','scheduled') AND accrues_at <= now`.
- 정규·단기·개인 레슨: 첫 회차 시작 시각이 `scheduled_at`, 마지막 회차 끝 시각이 `accrues_at`(= 정산 완료 시각)
- 이벤트형(원데이·파티·공연·대회): `scheduled` 를 거치지 않고 환불 마감일 다음 날 00:00 KST 에 `completed`(FR-282e). 마감 뒤에 결제한 건은 결제 시각에 바로 완료. 이는 SC-010a(조기 정산 지급 0건)의 명시된 예외다(열린 점 ①)
- 응답 200 `{ "scheduled": 12, "completed": 4 }`. 같은 시각에 두 번 불러도 두 번째는 0·0

### 7-2. `POST /api/internal/jobs/settlement/calculate-payouts` — S5-3.2 · S5-2.3a

정산일(매월 5일, 주말·공휴일이어도 옮기지 않는다 — Q35(정산일이 주말·공휴일일 때)) KST 00:10 에 돈다. 학원마다 한 트랜잭션:

| # | 단계 | 비고 |
|---|---|---|
| 1 | 정산 직전 사업자 상태 점검(`trigger='pre_payout'`)은 §7-3b 의 점검 작업(S1-1.27)을 먼저 부른다. 이 계산은 그 결과로 열린 `academy_restrictions` 행(`payout_hold`)만 읽고 국세청 API 를 직접 부르지 않는다(S5-3.2a) | 휴·폐업이면 그 학원 항목은 묶음에서 빠진다 |
| 2 | 기간 확정: `accrues_at < cutoff_at`(= 정산일 00:00 KST, 전날 23:59:59 까지 기록, FR-319a) 이고 `period_id IS NULL` 인 원장 줄에 `period_id` 를 붙인다 | 놓친 날이 있어도 다음 실행이 따라잡는다 |
| 3 | 명세 합계 검증: `Σ 줄 = 원장 합계`, 강사 몫 합 = 명세의 강사 몫 | 어긋나면 `statement_sum_mismatch` 어긋남을 열고 묶음을 만들지 않는다 |
| 4 | 지급 보류 대상 가르기: 열린 환불 요청 주문 → 학원 몫 `refund_pending`, 학원 제한 → 항목 `held`(`academy_restricted`) + 대표 알림 | S5-3.2a |
| 5 | 강사별 항목: 결제 시각에 유효한 몫 비율(수업별 예외 우선, Q33) × 완료 금액, 환불 뒤 조정·이의 조정·풀린 지급 보류를 줄로 더하고 프리랜서면 3.3% 를 표시한다 | 순수 함수 `computePayoutItem` |
| 6 | 계좌가 없거나 확인 전이면 항목 `held`(`account_unverified`), 비율이 빈칸이면 항목 없음 + 알림 `share_rate_missing` | FR-133b ① |
| 7 | 묶음 `calculated`(`approval_due_on` = 정산일 + 5영업일) · 알림 `payout_ready`(대표 — 「N월분 강사 지급액이 나왔어요」) | 09:00 에 맞춘 발송은 S7-1 의 몫 |

응답 200 `{ "settleOn": "2026-12-05", "academies": 14, "batches": 9, "items": 21, "skipped": [{ "academyId": "…", "reason": "statement_sum_mismatch" }] }`. `(academy_id, period_id)` 유니크가 두 번 실행을 막는다. 학원 직원 소속의 강사 몫은 항목이 아니라 학원 매출로 남는다.

### 7-3. 나머지 작업

| 경로 | 하는 일 | 응답 |
|---|---|---|
| `…/settlement/remind-unapproved` | `approval_due_on` 이 지났고 `calculated` 인 묶음 → 대표·그 항목의 강사에게 알림 `payout_approval_reminder`. 그 뒤 5영업일마다 대표에게만 한 번 더(`reminder_count` · `last_reminded_at`). `snoozed_until` 안이면 건너뜀. `dedupe_key = payout_batch:<id>:reminder:<n>` | `{ "reminded": 3 }` |
| `…/reconciliation/run` | §8 | `{ "runId", "status": "mismatch", "findings": 2, "recovered": 1 }` |
| `…/settlement/close-periods` | `calculated` 이고 묶음이 모두 `completed`(또는 항목 없음)이며 정산일 + 14일(이의 기한)이 지난 기간을 `closed` 로. 마감 합계 `closing_totals` 를 남긴다 | `{ "closed": 5 }` |

## 8. 대사와 월 마감 — S5-4

매일 새벽(**추천값** 03:30 KST) 한 번. 세 비교:

1. **원장 ↔ 결제·환불** — 학원별로 `Σ sale(+ in-stage refund) + 조정` 이 `paid` 주문의 (결제액 − 예매 수수료) − `refunds(succeeded)` 합(법정 청약철회 계좌분은 환불에 포함된 예매 수수료를 `booking_fee_reimbursement` 로 더한 값)과 같은가(SC-010b(정산 합계 일치)). 다르면 `ledger_sum_mismatch`
2. **PG 거래 ↔ 결제** — `PaymentGatewayPort.listTransactions` 의 어제까지 거래가 모두 `payments` 에 있는가. PG 에는 있는데 우리에게 없거나 `ready` 로 남은 거래는 **웹훅 유실**이다 → 같은 확정 경로(03 §6 의 `confirmPaymentFromGateway`)로 보내 확정하고 어긋남을 `recovered`(`resolution='recovered_from_pg'`)로 닫으며 감사 `reconciliation.webhook_recovered`(S5-4 수용 ①). 금액이 다르면 `pg_amount_mismatch`(FR-115(결제 금액 대조)·FR-290 경로)
3. **명세 합계** — 이미 확정된 기간의 `closing_totals` 와 다시 계산한 값이 같은가(`period_closed_drift`, S5-4 수용 ③)

어긋남은 `reconciliation_findings` 에 열리고(`finding_key` 로 같은 것이 한 번만) 운영자 알림 `reconciliation_mismatch`(S7-4 의 경보 3종 가운데 하나) · 해당 학원의 승인을 막는다(§4-2). 풀리면 `resolved`, 다음 지급에 포함된다. 운영자는 시스템 오류만 고치고 금액을 정하지 않는다(FR-319a).

응답 예 `POST /api/internal/jobs/reconciliation/run` 200
```json
{ "runId": "…", "runDate": "2026-11-21", "status": "mismatch", "dataAsOf": "2026-11-21T18:30:00Z", "pgTransactionsChecked": 412,
  "findings": [ { "findingKey": "ledger_sum_mismatch:<academyId>:2026-11", "kind": "ledger_sum_mismatch", "academyId": "…", "expectedAmount": 3780000, "actualAmount": 3770000, "diffAmount": -10000, "status": "open" } ],
  "recovered": [ { "findingKey": "pg_missing_in_ledger:pay_8f2", "kind": "pg_missing_in_ledger", "resolution": "recovered_from_pg", "orderId": "…" } ] }
```

**월 마감**(`close-periods`)은 기간을 잠그고 `closing_totals` 를 쓴다. 마감 뒤 새로 생긴 환불·조정 줄은 `accrues_at` 이 다음 정산 마감 시각 이후라 다음 기간으로 들어간다 — 마감한 달의 숫자는 바뀌지 않는다(FR-319(기준 시각·월 마감)). 모든 금액 응답에 `dataAsOf`(기준 시각)를 같이 낸다.

## 9. 포트 — 06-ports.md 에 더하는 제안

```ts
// PaymentGatewayPort 에 더한다 — 대사용 거래 내역 조회 (S5-4.1, 가짜 PG 는 메모리 원장을 돌려준다)
listTransactions(req: { from: Temporal.Instant; to: Temporal.Instant; cursor?: string }): Promise<{
  items: readonly { gatewayPaymentId: string; transactionId: string; status: 'paid' | 'cancelled'; amount: number; paidAt: Temporal.Instant;
                    method: 'virtual_account' | 'card'; feeAmount?: number }[];
  nextCursor?: string }>;

// 지급 — 베타는 파일만 만들고, 정식 운영은 PG 지급대행(S8-1). 서비스는 이 포트만 안다
interface PayoutPort {
  readonly mode: 'manual' | 'pg_payout';
  submit(batch: { batchId: string; items: readonly { itemId: string; bankCode: string; accountNumber: string; holderName: string; amount: number }[] }):
    Promise<{ kind: 'file_ready' } | { kind: 'submitted'; gatewayPayoutId: string }>;
}
```
가짜·실 구현은 같은 계약 테스트를 통과한다(06-ports 규칙). `PayoutPort.submit` 의 `accountNumber` 는 복호화된 전체 번호라 서비스 밖으로 새지 않게 파일·지급대행 호출에서만 쓴다.

**산정 함수(순수, DB·IO 없음)** — `admin-web/lib/domain/`:
```ts
computeSaleFees(i: { classAmount: number; feeCategory: 'general' | 'private_lesson'; platformFeeRateBp: number; method: 'card' | 'account'; pgFeeRateBp: number }): { platformFee: number; pgFee: number } // 모두 ≥0, 부호는 원장에 쓸 때
computeRefundEffects(i: { classKind: 'regular' | 'event'; refundAmount: number; netAfterRefund: number; priorPlatformFee: number; platformFeeRateBp: number; cancelFeePlatformShareBp: number; pgFeeRateBp: number }): { platformFeeRefund: number; cancelFeePlatformShare: number; refundPgFee: number }
nextStage(row: { stage: 'hold' | 'scheduled' | 'completed'; scheduledAt: Instant | null; accruesAt: Instant }, now: Instant): 'hold' | 'scheduled' | 'completed'
computePayoutItem(i: { saleLines: readonly SaleLine[]; adjustments: readonly Adjustment[]; releasedHolds: readonly Hold[]; settlementType: 'freelancer' | 'business' }): { lines: PayoutLine[]; gross: number; withholding: number; net: number }
```
수수료 계열 나눗셈은 `ceilMulDiv`(올림, 06-ports §4.6)를 쓰고 강사 몫·원천징수는 원 미만 버림(`floorMulDiv` 을 `money.ts` 에 더한다 — 열린 점 ④, 2026-11-20 사용자 결정 D16 으로 확정: 플랫폼 수수료 올림 · 강사 몫·원천징수 3.3% 버림, **세무 확인 필요**).

## 10. 운영자 화면 — P9 · P10 · P11

2026-11-20 통합: 이 세 화면의 운영자 경로는 **이 파일 한 곳**에 둔다(정산 영역 — 공휴일은 승인 기한, 예금주 확인은 지급 가능 판정, 사업자 점검은 지급 보류에 걸린다). 구현 Task 는 M7 의 S7-4.8a(공휴일 운영자 입력 API(P9))·S7-4.8b(예금주 확인 처리 API(P10))·S7-4.8c(사업자 점검 소명 처리 API(P11))이고 화면은 S7-4.9e~g 다. 경로 모양은 `15-ops.md` 초안(§4-11~4-13, `/api/admin/console/**`)을 따랐다 — 콘솔 메뉴의 다른 화면(P1~P8)과 같은 접두어라서다. 옛 13 초안의 `/api/admin/holidays`·`/api/admin/payout-account-reviews/**`·`/api/admin/business-status`·`/api/admin/academy-restrictions/{restrictionId}/release` 는 버렸다. 콘솔 공통 규칙(조회 기록·개인정보 없음·2단계 인증)은 `15-ops.md` §4-1.

### 10-1. P9 공휴일 — FR-301 예외 ② · Q35(정산일이 주말·공휴일일 때)

`GET /api/admin/console/holidays?year=2027` 200
```json
{ "year": 2027, "lastSync": { "ranAt": "2026-11-20T18:00:00Z", "status": "success", "source": "공공데이터포털 특일 정보" },
  "items": [ { "holidayId": "…", "date": "2027-02-09", "weekday": "화", "name": "설날 대체", "kind": "substitute_holiday", "source": "api", "editable": false },
             { "holidayId": "…", "date": "2027-05-06", "name": "임시 휴일(예시)", "kind": "temporary_holiday", "source": "operator", "editable": true } ] }
```
- `kind`: `holiday`(공휴일) · `substitute_holiday`(대체공휴일) · `temporary_holiday`(임시공휴일). `source`: `api`(특일 정보 자동) · `operator`(운영자 입력). **자동 수집 줄은 고치거나 지울 수 없다**(`editable:false`, Q35) — 수정·삭제 경로가 그 줄에는 409 `HOLIDAY_NOT_EDITABLE`
- `POST /api/admin/console/holidays` `{ "date": "2027-05-06", "name": "임시 휴일(예시)", "kind": "temporary_holiday" }` → 201 `{ "holidayId" }`. 같은 날짜가 이미 있으면 409 `HOLIDAY_DATE_EXISTS`. 감사 `holiday.created`
- `PATCH /api/admin/console/holidays/{holidayId}` `{ "name"?, "kind"? }`(날짜는 못 바꾼다 — 지우고 새로 더한다). `DELETE …` → 200 `{ "deletedAt" }`. 감사 `holiday.updated`·`holiday.deleted`(전·후 값). 영업일 계산이 이 표를 쓰므로 바꾸면 이후 계산부터 바뀐다(이미 만든 기한은 안 바뀐다 — `first_response_due_at`·승인 기한은 만들 때 고정)
- 구현 세부(S7-4.8a — 추천안·사후 확인 2026-11-24): `PATCH` 응답은 200 + 고친 뒤 목록 한 줄(`holidayId`·`date`·`weekday`·`name`·`kind`·`source`·`editable`), 같은 값이면 행·감사 그대로. 지운 줄 `PATCH`·없는 id·uuid 모양이 아닌 id 는 404 `NOT_FOUND`. 다시 `DELETE` 는 처음 지운 시각으로 200(감사 추가 없음). `GET` 의 `year` 는 2000~2100(없으면 KST 올해), 수집 기록이 없으면 `lastSync: null`. `name` 은 1~40자. 조회 기록 `console.viewed`(대상 `console_screen`, target_id = UUIDv5(URL 이름공간, `"console:holidays"`))은 같은 운영자 1분 안 재조회면 쓰지 않는다
- 표(`holidays`)는 S0-4.7, 하루 1회 자동 수집(공공데이터포털 특일 정보)은 S0-4.10, 영업일 계산 함수는 S0-4.8 이 만든다(정의는 data-model §10-13 한 곳). P9 상단 띠(`lastSync`)는 `holiday_sync_runs` 를 읽는다. 같은 날짜가 자동·운영자 입력 둘 다 있으면 자동 값을 우선하고 운영자 입력은 `source='operator'` 로 남긴다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인), 15 열린 점 ⑱ — 통합 사람 결정 목록)

### 10-2. P10 예금주 확인 — FR-301 예외 ③ · R15(무료 확인 수단 부재)

대상은 정산 계좌를 올린 **대표(학원 계좌, 07 `academy_payout_accounts`)와 강사(§3-4 의 `instructor_payout_accounts`)** 다. 두 표는 같은 확인 칸(`verification_status` 4종 — `awaiting_proof`·`pending`·`verified`·`rejected`, data-model §10-5)을 쓴다. 이 절은 둘을 하나의 대기 목록으로 합쳐 읽는 모양과 확인·반려만 정한다.

`GET /api/admin/console/payout-verifications?status=pending|verified|rejected&cursor=` 200
```json
{ "pendingCount": 4,
  "items": [ { "verificationId": "…", "subjectKind": "instructor", "displayName": "이준호", "academyName": null,
               "verifiedIdentityName": "이준호", "bankName": "신한", "accountMasked": "110-***-**4821",
               "proofFile": { "fileId": "…", "displayName": "passbook_이준호.jpg" },
               "submittedAt": "2026-11-19T07:20:00Z", "overOneBusinessDay": true, "status": "pending" } ] }
```
- `verificationId` 는 계좌 줄 id 다 — `subjectKind` 가 `academy` 면 `academy_payout_accounts.id`, `instructor` 면 `instructor_payout_accounts.id`. 서버는 두 표에서 찾는다(UUIDv7 이라 겹치지 않는다). 목록의 `submittedAt` 은 `proof_uploaded_at`. `overOneBusinessDay` = 올린 뒤 **1영업일**(P9 공휴일 표 기준)을 넘겼는지(P10 「1영업일 넘음」 칩). 정렬은 오래된 순
- 통장 사본은 `GET /api/files/{fileId}`(07, `admin` 허용)로 연다. 계좌번호 전체는 응답에 없다(가린 값만, FR-299)
- `POST …/{id}/confirm` `{ "nameMatches": true }` → 200 `{ "status": "verified", "verifiedAt" }`. **`nameMatches:true` 일 때만** 받는다(운영자가 사본 이름 = 본인확인 이름을 대조했다는 확인 체크, 화면 「두 이름이 같아요」) — 아니면 422 `NAME_MISMATCH_CONFIRM`. 같은 트랜잭션: `holder_verified_at`·`holder_verify_method='manual_document'`·`holder_verified_by_account_id` · 감사 `payout_account.holder_verified`(가린 값) · 신청자에게 알림 `payout_account_verified`. 확인 전 계좌로는 지급하지 않는다 — 지급 코드(`isPayableAccount`, S1-1.22)가 `verification_status <> 'verified'` 면 지급 대상에서 빼고 지급 보류(`account_unverified`, §5-1)로 둔다. 이미 확인이면 200 같은 본문
- `POST …/{id}/reject` `{ "reasonCode": "name_mismatch" | "file_unreadable" | "other", "reasonText": "사본 예금주가 다릅니다" }` → 200 `{ "status": "rejected" }`. `other` 면 `reasonText` 필수. 줄에 `reject_reason_code`·`reject_reason_text` 를 쓴다. 신청자에게 알림 `payout_account_rejected`(사유 포함). 같은 계좌를 다시 올리면 새 대기 줄(옛 줄은 `rejected` 로 남는다)
- 확인한 줄을 되돌리는 경로는 없다. 잘못 확인했으면 계좌를 바꾸게 해(새 줄) 다시 확인한다(임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인))

| HTTP | code | 언제 |
|---|---|---|
| 404 | `NOT_FOUND` | 없는 줄 |
| 409 | `VERIFICATION_STATE_CONFLICT` | 이미 반려된 줄을 확인 / 확인된 줄을 반려 |
| 422 | `NAME_MISMATCH_CONFIRM` · `VALIDATION_FAILED` | 위 |

### 10-3. P11 사업자 점검 — FR-301 예외 ④ · FR-250(입점 심사·게시 제한) · FR-254(이용 제한 절차)

자동 점검(매일 03:10 KST + 정산 직전)은 S1-1 의 작업이 `business_status_checks`·`academy_restrictions`(§7-3b)를 만든다. 이 절은 **운영자가 읽고 소명을 처리하는 모양**과, 점검이 휴·폐업을 감지하면 **이용 제한 절차(`15-ops.md` §2-8 의 `restriction_cases`)를 같이 여는 것**을 정한다 — 소명 기한은 휴·폐업 감지 + 7일. 소명 **제출** 경로는 `15-ops.md` §2-8 하나뿐이다(07~10 에는 소명 경로가 없다 — 2026-11-20 통합 때 확인).

`GET /api/admin/console/business-checks` 200
```json
{ "lastRunAt": "2026-11-20T18:10:00Z", "trigger": "daily",
  "summary": { "total": 128, "active": 125, "suspended": 1, "closed": 1, "error": 1 },
  "items": [ { "caseId": "…", "academyId": "…", "academyName": "모던스텝 합정", "ownerName": "정수아", "businessNoMasked": "123-45-*****",
               "status": "closed", "detectedAt": "2026-11-19T18:10:00Z", "actions": ["new_sales_blocked","payout_hold"],
               "explanationDueAt": "2026-11-26T18:10:00Z", "dueInDays": 5, "state": "explained" },
             { "caseId": null, "academyId": "…", "academyName": "비트스튜디오 건대", "ownerName": "강민서", "businessNoMasked": "308-12-*****",
               "status": "error", "detectedAt": "…Z", "actions": [], "explanationDueAt": null, "dueInDays": null, "state": null, "note": "다음 점검에서 다시 확인 · 조치 없음" } ] }
```
- `summary` 는 마지막 점검에서 학원별 최신 상태를 센 값(`계속`=`active`). `error`(조회 실패)는 조치하지 않고 `caseId:null` 로 목록에만 나온다(조회 실패를 폐업으로 오판하지 않으려고, §7-3b)
- `actions` 는 열린 `academy_restrictions` 의 `kind`(`new_sales_blocked`·`payout_hold`·`listing_suspended`). 이미 결제한 수업은 그대로 진행되고 막히는 것은 새 결제와 지급뿐이다(화면 안내문)

`GET /api/admin/console/business-checks/{caseId}` 200
```json
{ "caseId": "…", "academyName": "모던스텝 합정", "ownerName": "정수아", "businessNoMasked": "123-45-*****",
  "latestCheck": { "checkedAt": "…Z", "status": "closed", "closedOn": "2026-11-10", "previousStatus": "active" },
  "explanations": [ { "explanationId": "…", "submittedAt": "…Z", "body": "폐업 신고는 장소를 옮기는 중이라 한 것이고, 신규 사업자 등록증을 첨부해요.", "attachments": [ { "fileId": "…", "displayName": "사업자등록증_신규.pdf" } ] } ],
  "actions": ["new_sales_blocked","payout_hold"], "explanationDueAt": "…Z", "state": "explained" }
```
국세청 응답 원문(`raw_response`)은 내리지 않고 필요한 필드(상태·폐업일)만 낸다. 등록번호는 가린 값만.

- `POST …/{caseId}/accept-explanation` `{ "note": "신규 사업자등록증 확인" }` → 200 `{ "state": "lifted" }`. 한 트랜잭션: `restriction_cases` `lifted` · 열린 `academy_restrictions`(`new_sales_blocked`·`payout_hold`) 에 `ended_at`·`ended_by_account_id` · 감사 `restriction.lifted` · 대표 알림 `business_restriction_lifted`. 새 사업자번호로 바뀐 경우의 정보 갱신은 대표가 07 의 판매자 정보 수정 경로로 한다(이 경로는 제한만 푼다). 소명이 한 건도 없으면 409 `NO_EXPLANATION`
- `POST …/{caseId}/suspend-listing` `{ "note": "소명 기한 지남" }` → 200 `{ "state": "measure_applied" }`. `academy_restrictions` 에 `listing_suspended` 행을 연다(FR-254 「7일 안에 소명이 없으면 게시를 중단」 — **자동으로 하지 않고 운영자가 누른다**, 보드 P11 「기한이 지나도 소명이 없으면 게시 중단을 안내해요」 + 버튼). 기한 전에도 누를 수 있다(긴급). 대표 알림 `listing_suspended`
- 대표의 소명 제출은 `15-ops.md` §2-8 의 소명 경로(대표 세션, 그 학원 `owner` 만). `state` 가 `notice_sent` → `explained`
- S1-1.29 구현 메모(추천안·사후 확인 2026-11-24): ① 점검이 휴·폐업을 처음 보면 같은 트랜잭션에서 `restriction_cases`(`source=business_status`, `notice_sent`, `planned_measure=listing_limit`, 소명 기한 = 감지 + 7일, 감사 `restriction.opened` system)를 열고 연 제한 행에 `source_case_id` 를 붙인다 — 이 절차가 P11 의 `caseId` 다. ② 「기한 지남」은 목록에서 계산만 한다(소명 기한 시각이 지났고 `notice_sent`·`explained` 이면 `dueLabel: "기한 지남"`, 남은 날은 한국 날짜끼리). ③ 두 버튼 본문 `note` 는 빼도 된다(0~1,000자, 감사 `reason`). ④ `accept-explanation` 은 그 절차가 연 제한을 **모두** 닫는다 — 게시 중단을 이미 눌렀으면 `listing_suspended` 까지(소명을 받아들였는데 게시만 막혀 있는 상태를 만들지 않으려고). 절차 없이 S1-1.28 이 연 옛 제한 행(`source_check_id` 만 있음)도 같이 닫는다. ⑤ `suspend-listing` 감사는 `restriction.applied` + `academy_restriction.opened`, `accept-explanation` 은 `restriction.lifted` + 닫은 행마다 `academy_restriction.released`. ⑥ 다른 출처(신고·운영자 직접) 절차의 `caseId` 는 404. ⑦ GET 목록·상세 두 경로는 S7-4.8c·S7-4.9g 몫이고, 「기한 지남」 계산은 `listBusinessCheckCases`(lib/server/services/admin-business-checks.ts)에 먼저 두었다
- S7-4.8c 구현 메모(추천안·사후 확인 2026-11-24) — GET 목록·상세: ① 두 응답에 화면이 바로 쓰는 `dueLabel`(「D-5」·「D-day」·「기한 지남」)·`overdue` 를 더했고, 목록 줄에는 `explanationCount`, 상세에는 `academyId` 를 더했다. 조치했거나 끝난 건은 기한 칸이 `null`/`false` 다. ② `summary` 에 `notFound`(미등록) 칸을 더했다 — 학원별 최신 점검 한 줄씩 센다. ③ 목록은 사업자 점검 절차 중 열린 것 + 최근 30일 안에 끝난 것, 그리고 최신 점검이 조회 실패이면서 열린 건이 없는 학원의 `caseId:null` 줄. 순서는 열린 건(기한 순) → 조회 실패 → 끝난 건. ④ `ownerName` 은 그 학원 active 대표의 직원 계정 이름(없으면 null), `businessNoMasked` 는 학원 칸을 `123-45-*****` 로 가린 값. ⑤ `latestCheck.previousStatus` 는 최신 점검 앞의, 조회 실패가 아닌 가장 최근 결과(없으면 null). ⑥ 조회 기록은 목록 `console_screen`=`business_checks`(filters `{}`), 상세 `business_check_detail`(filters `{caseId}`) — 같은 운영자가 1분 안에 같은 화면·같은 필터를 다시 열면 한 줄로 합친다. 없는 건·다른 출처 404 는 기록하지 않는다. 구현: `lib/server/services/admin-business-check-views.ts`
- 이 두 경로는 `15-ops.md` §2-8 의 `apply`·`lift` 를 사업자 점검 화면용으로 묶은 것이다(같은 서비스 함수 + 같은 감사). 이미 `lifted`·`measure_applied` 면 200 같은 본문, 다른 전이는 409 `CASE_STATE_CONFLICT`

## 수용 시나리오

1. **Given** 일반 수업 5만 원이 결제됐다(입점 1년 면제 중) **When** 수업이 끝나기 전 `GET …/summary` **Then** `stages.hold` 또는 `scheduled` 에만 잡히고 `completed` 는 0 — 수업 시작 전 지급 항목 0건(SC-010a)
2. **Given** 단계 `hold` 인 결제 10만 원에 부분 환불 3만 원 **When** `advance-stages` 가 완료로 넘긴다 **Then** `completed` 7만 원, 환불은 `refund` 줄 1개, `Σ stages + 환불분 ± 조정 = 10만 원`
3. **Given** 이미 `completed` 로 지급까지 끝난 결제 **When** 환불 3만 원이 생긴다 **Then** 확정분은 그대로이고 다음 기간에 음수 `adjustment` 줄 1개, 강사 명세에는 `refund_adjustment` 줄이 같은 비율로 보인다
4. **Given** 강사 A·B 가 같은 학원 소속 **When** A 가 B 의 `payoutItemId` 로 `GET …/items/{id}` 또는 엑셀 **Then** 403 `FORBIDDEN`, 감사에 내려받기 기록 없음(SC-010c)
5. **Given** 휴대폰 재확인 없이 **When** `PUT /api/staff/payout-account` **Then** 422 `RECHECK_REQUIRED`, 계좌 행 0개. 가입 때와 다른 사람의 토큰이면 409 `IDENTITY_MISMATCH`
6. **Given** 계산된 묶음 **When** 승인 전에 `transfer-file.xlsx` **Then** 409 `PAYOUT_NOT_APPROVED`. 승인 뒤에는 200 이고 감사 기록 1건
7. **Given** 승인된 묶음 **When** `complete` 를 같은 키로 두 번 **Then** `paid` 항목은 한 번만 생기고 두 응답의 `completedAt` 이 같다. 알림은 강사마다 1건
8. **Given** 지급 완료된 항목 **When** 반송 1건을 `return` 에 넣는다 **Then** 그 항목 금액만 지급 보류 행이 되고 강사에게 사유·금액 알림이 가며, 계좌 재확인 뒤 다음 묶음에 `hold_release` 줄로 합쳐진다(지급 합 + 지급 보류 합 = 묶음 합)
9. **Given** 정산일 12/5(토) **When** 12/11(금)까지 승인이 없다 **Then** `remind-unapproved` 가 대표·강사에게 알림 1건씩, 같은 날 두 번 불러도 더 늘지 않는다
10. **Given** 강사 이의가 받아들여졌다 **When** 다음 정산 계산 **Then** 그 강사 항목에 `dispute_adjustment` 줄이 정확히 1개
11. **Given** `/api/dev/fake-pg/webhooks/drop` 으로 웹훅 1건을 버렸다 **When** 다음 `reconciliation/run` **Then** PG 조회로 결제가 확정되고 `recovered_from_pg` 어긋남 1건이 남는다
12. **Given** `/api/dev/settlement/skew-ledger` 로 원장 한 줄을 어긋내 둔다 **When** 대사 **Then** 열린 어긋남 1건과 차액이 나오고 그 학원의 `approve` 는 409 `RECONCILIATION_MISMATCH`, 다른 학원은 정상
13. **Given** 마감된 달 **When** 다시 계산한다 **Then** `closing_totals` 와 같고, 마감 뒤 들어온 환불은 다음 기간 조정 줄로만 보인다
14. **Given** 통장 사본 확인 전 강사 계좌 **When** 정산일 계산 **Then** 항목은 `held`(`account_unverified`)이고 승인 대상에 없다. 운영자가 확인하면 다음 묶음에 합쳐진다
15. **Given** 학원 직원으로 표시된 강사 **When** 정산일 계산 **Then** 항목이 없고 `rows` 에 「학원 직원 · 강사 몫 없음」, 그 몫은 학원 매출로 남는다

## Phase 6(테스트) 목록

| 종류 | 테스트 |
|---|---|
| 단위 | `computeSaleFees`(면제 기간 일반 0 · 개인 레슨은 강사 가입일부터 1년 0·그 뒤 1%(2026-11-23 변경 — 이전: 항상 1%) · 끝수 올림) · `computeRefundEffects`(이벤트형 5:5 예시 4행: 50,000 원 · 20%·30% 공제 · 전액) · `nextStage` · `computePayoutItem`(3.3% 버림 · 학원 직원 제외 · 음수 이월) · 영업일 승인 기한(12/5 토 → 12/11 금) · 계좌 가리기 |
| 속성 | S5-1.7: 무작위 결제·부분 환불·조정 시퀀스에서 `Σ 단계 + 환불분 ± 조정 = 결제 총액`, 단계 금액 음수 0 · S5-3.8: 무작위 승인·완료·반송에서 지급 합 + 지급 보류 합 = 묶음 합 |
| DB(`requires_db`) | `ck_settlement_amount_sign` · 확정(`completed`) 줄 UPDATE·DELETE 거부 트리거 · `uq_payout_batches_period` · `uq_payout_items_batch_instructor` · `uq_payout_account_active` · `uq_recon_open_key` · 부분 유니크 `uq_settlement_refund_source` |
| 통합(Route Handler) | 수용 시나리오 1~15 · 위임 강사 403 · 앱 토큰 승인 403 `WEB_ONLY` · 같은 `Idempotency-Key` 재생 · 승인 동시 2건 → 1건 성공 1건 200 재생 |
| 보안(`ecc:security-reviewer`) | 응답·로그에 계좌 전체 번호 0건(전송 파일 제외) · 타 강사 엑셀 직접 주소 · 엑셀에 회원 이름·연락처 0건 · 통장 사본 파일 직접 주소 |
| E2E(Playwright) | W11 승인 → 내려받기 → 지급 완료 → I17 `step=3` (M5-END.3(M5 완료 기준 시나리오)) · W13 명세 합계 스크린샷 |

## 열린 점

| # | 무엇 | 추천값 — 2026-11-20 사용자 결정 D20: 「임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)」 |
|---|---|---|
| ① | 이벤트형 「환불 마감 다음 날 완료」는 SC-010a(수업 기간이 끝나지 않은 건의 정산 완료 지급 0건)와 글자로 충돌한다 | spec 의 FR-282e 가 예외를 명시했으므로 SC-010a 의 시험은 이벤트형을 뺀다고 spec 에 한 줄 정리(M5 완료 기준 시나리오 입력) |
| ② | Q34(강사 정산 계좌 변경 경로) 임시 확정은 앱 | 보드 I18·I18B 가 앱이라 앱 경로로 둠. 웹 전용으로 바뀌면 `surface` 만 조인다 |
| ③ | 사업자 강사의 사업자등록번호 입력 화면 보드가 없다 · 진위 조회 여부 | 경로만 정의, 국세청 조회는 하지 않음임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인). 화면은 I9 마이 아래 별도 보드 필요 |
| ④ | ~~끝수 처리: 플랫폼 수수료는 올림(FR-124 임시 확정), PG·카드 수수료·환불 PG 수수료·강사 몫·원천징수 3.3% 는 spec 에 없음~~ | **→ 2026-11-20 사용자 결정 D16 으로 확정** — 플랫폼 수수료는 올림(`ceilMulDiv`), 강사 몫·원천징수 3.3% 는 원 미만 버림(`floorMulDiv` 추가, 강사 몫 합이 학원 몫을 넘지 않게). **세무 확인 필요**(법률·세무 검토 표시). PG·카드·환불 PG 수수료는 수수료 계열이라 올림으로 둔다(D20 임시 확정) |
| ⑤ | 보드 예시값의 어긋남: ① W13 명세의 「총 결제액 3,780,000」이 단계와 상관없이 그 달 전부(W7b 와 같은 숫자)인데 지급은 완료분만 쓴다 ② I17B 원천징수 33,000 이 3.3% 계산과 안 맞는다 ③ W13 이 카드 수수료(결제 전액 기준)와 환불 PG 수수료를 둘 다 공제해 환불분 수수료를 이중으로 셀 수 있다 | 계약은 「완료분만 기간에 들어간다」·「세전 지급액 × 3.3%」·「환불 PG 수수료 = PG 가 환불 때 돌려주지 않은 수수료만」으로 둔다. 보드 문구·예시 정정과 SP-2(PG 지급대행) 결과 확인 |
| ⑥ | 대타 회차의 강사 몫(I-10 — 실제 수업한 강사)을 원장에 어떻게 나눌지. 지금 원장은 주문마다 담당 강사 1명 | M5 는 `instructor_account_id`(결제 시점 담당 강사)로만 계산하고, 대타 몫 이동은 `adjustment` 줄로 하는 안을 S2-3(대타·해제)과 조율 |
| ⑦ | 대표의 이의(W14)를 운영자가 처리하는 화면 보드가 없다 · S5-3.7 Task 는 강사 → 대표 쪽만 말한다 | 경로만 둠. 운영자 콘솔 화면은 M7(S7-4)과 조율 |
| ⑧ | 무료 수업의 0원 줄(I17B)은 원장에 줄이 없다(결제가 없다) | 명세 조회가 예약 수로 0원 줄을 만든다 — 원장에는 쓰지 않는다 |
| ⑨ | 지급 대상 파일 내려받기: 승인 뒤 몇 번까지, 그리고 내려받기 전에도 「지급 완료」를 허용할지. 내려받을 때 TOTP 코드를 다시 물을지 | 횟수 제한 없이 매번 기록 · 완료는 허용 · TOTP 재확인은 하지 않고 세션 2단계 인증만(FR-133b ④) — 안전을 더 원하면 재확인 추가 |
| ⑩ | ~~P9·P10·P11 의 운영자 경로가 M7 의 S7-4.8a~c 와 겹친다~~ | **2026-11-20 통합으로 닫음** — 경로는 이 파일 §10 한 곳, 공휴일 표·수집 기록 정의는 data-model §10-13, `academy_payout_accounts` 확인 칸은 §10-5(M7 초안의 `holder_status` 는 버림), 소명 글은 `restriction_explanations`(§12, `15-ops.md` §2-8) |
| ⑪ | 한 정산 기간에 강사 지급이 음수가 될 때(환불 조정이 몫보다 큼) | 항목을 0 원으로 두고 음수분은 다음 묶음의 `carry_forward` 줄로 이월임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) |
| ⑫ | 월 마감 시점: spec 은 「정산이 끝난 달」만 말한다 | 정산일 + 14일(이의 기한) 뒤 + 묶음이 모두 `completed` 일 때임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인) |
| ⑬ | 정산일 알림 「09:00」은 알림 행의 예약 발송이 필요하다 | 행은 계산 때 쓰고 발송 시각은 S7-1(알림 발송)이 맞춘다 |
| ⑭ | 카드·PG 결제 수수료율의 출처(PG 계약 · 보드 예시 카드 3% · 가상계좌 1%) | PG 응답의 `feeAmount` 가 있으면 그것, 없으면 설정값(bp)을 줄에 적는다. 실제 값은 SP-2 |
| ⑮ | 쿠폰·대학생 할인 차액 줄(`coupon_burden`) 정의는 M6(S6-2)가 하고 이 계약은 값 이름만 비워 둔다. 지금 sale 줄은 회원이 실제로 낸 금액(예매 수수료 제외) | M6 와 조율 |
| ⑯ | I17 「다음 정산까지 쌓이는 금액」이 수업료 기준인지 강사 몫 기준인지 보드에 없다 | 강사 몫 기준(결제 시각 비율 적용, 원천징수 전)으로 둔다. 비율이 빈칸인 수업은 합계에서 빼고 안내 |
