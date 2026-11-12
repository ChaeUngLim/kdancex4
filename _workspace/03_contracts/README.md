# Phase 3(구현 계획) 산출물 — API 계약 공통 규칙

- 작성 2026-11-06 · 이 폴더는 공유 계약 §4.5(API 계약)다. 파일 목록:

| 파일 | 다루는 것 | 슬라이스 |
|---|---|---|
| `README.md` | 공통 — 경로·인증·형식(§4.6)·오류(§4.8)·멱등(§4.9) | 전부 |
| `01-member-onboarding.md` | 로그인·가짜 본인확인·가입·취향·기준 장르 | US1-A1(가입·취향) |
| `02-catalog.md` | 홈 목록(거르기)·수업 상세·기본 자리 | US1-A2(시드·검색·상세) |
| `03-checkout-payment.md` | 주문 생성·조회·셀프 취소·웹훅·만료·가짜 PG 시험 경로 | US1-A3·A4 |
| `04-me-calendar-notifications.md` | 내 캘린더·알림 조회 | US1-A4 |
| `05-cancellation-migrated.md` | 이관하는 취소 미리보기·취소 | S0-M4(취소 API 이관) |
| `06-ports.md` | 어댑터 포트·산정 함수 시그니처(§4.3·§4.10) | S0-M3 이후 전부 |

---

## 1. 경로·런타임

| 항목 | 규칙 |
|---|---|
| 접두어 | 모든 제품 API 는 `/api/...`(Next.js Route Handler, `admin-web/app/api/**/route.ts`). FastAPI 의 무접두 경로는 이관하면서 `/api` 를 붙인다 |
| 런타임 | Node.js 런타임 고정(Prisma 8 · `pg` 사용). Edge 런타임 금지 |
| 시험 전용 경로 | `/api/dev/**` 는 `KDANCE_DEV_ROUTES=true` 일 때만 응답하고, 아니면 404. 운영 배포 값은 `false` |
| 내부 경로 | `/api/internal/**` 는 헤더 `X-Internal-Token` 이 환경 변수 `INTERNAL_API_TOKEN` 과 같을 때만(상수 시간 비교) |
| 헬스 | `GET /api/health` → `200 {"status":"ok"}` |

## 2. 인증

| 항목 | 규칙 |
|---|---|
| 신원 | Better Auth 세션. 웹은 쿠키, 모바일은 `Authorization: Bearer <token>`(Better Auth `bearer` 플러그인). 위치: `/api/auth/[...all]` |
| 회원 확인 | 보호 경로는 `requireMember(request)` 가 세션 → `members.auth_user_id` 로 회원을 찾는다. 세션 없음 401 `UNAUTHENTICATED`, 세션은 있는데 가입 미완료 403 `SIGNUP_INCOMPLETE` |
| 옛 `X-User-Id` | **폐기.** 이관 경로도 세션으로 바꾼다 |
| 대표 경로 | 1회차에는 없다(대표 알림은 기록만) |

## 3. 공유 계약 §4.6 — 값 형식

| 값 | JSON 형식 | 예 |
|---|---|---|
| id | UUID 문자열 | `"0193…"` |
| 시각 | ISO 8601 UTC, `Z` 끝(`Temporal.Instant.toString()`) | `"2026-11-10T10:30:00Z"` |
| 화면용 현지 시각 | 서버가 함께 내려주지 않는다. 앱이 `Asia/Seoul` 로 바꿔 보여 준다 | — |
| 하루 중 시각(가능 시간대) | `"HH:MM"` 24시간, KST 기준 | `"18:00"` |
| 날짜 | `"YYYY-MM-DD"`(KST 달력) | `"2026-11-10"` |
| 금액 | 원 단위 정수(`number`). 소수 금지 | `120000` |
| 가격 내역 | 순서가 고정된 배열. `kind` 는 `list_price` → `benefit_discount` → `coupon_discount` → `booking_fee` → `final` 순(FR-283(결제액 계산 순서)). 할인 줄은 0 이어도 내려준다(FR-117(체크아웃 가격 내역)). `booking_fee` 는 해당 상품일 때만 | `[{"kind":"list_price","label":"정가","amount":120000}, …]` |
| 장르·구분 값 | §4.1 영문 값. 한글 이름은 앱이 붙인다 | `"salsa_bachata"` |

## 4. 공유 계약 §4.8 — 오류 응답

FastAPI 의 `{"detail": …}` 모양을 **유지하고** 기계용 `code` 를 더한다. `admin-web/lib/api-client.ts` 와 `mobile` 이 `detail` 을 읽고 있어서 클라이언트 수정이 최소가 된다.

```json
{ "detail": "사람이 읽는 한국어 문장", "code": "SEAT_SOLD_OUT" }
```

검증 실패만 `fields` 가 붙는다: `{ "detail": "입력값을 확인해 주세요", "code": "VALIDATION_FAILED", "fields": [{"path": "seatKind", "message": "…"}] }`

| HTTP | code | 언제 |
|---|---|---|
| 400 | `BAD_REQUEST` | 본문이 JSON 이 아님, 필수 헤더 없음(`Idempotency-Key`) |
| 401 | `UNAUTHENTICATED` | 세션 없음 |
| 401 | `INVALID_SIGNATURE` | 웹훅 서명 불일치(`/api/payments/webhook` 만) |
| 403 | `SIGNUP_INCOMPLETE` · `FORBIDDEN` | 가입 미완료 · 남의 자원(옛 규칙대로 404 로 숨기지 않는다) |
| 404 | `NOT_FOUND` | 자원 없음 |
| 409 | `BASE_GENRE_REQUIRED` · `SEAT_SOLD_OUT` · `ALREADY_RESERVED` · `CHECKOUT_CLOSED` · `NOTICE_MISSING` · `ORDER_NOT_CANCELLABLE` · `IDENTITY_ALREADY_USED` · `USE_ORDER_CANCEL` · `RESERVATION_ALREADY_CANCELLED` · `CLASS_ALREADY_STARTED` | 상태 충돌. 각 파일에 정의 |
| 422 | `VALIDATION_FAILED` | zod 검증 실패 |
| 500 | `INTERNAL` | 예상 못 한 오류. `detail` 에 내부 정보를 담지 않는다 |

- 응답 본문에 스택·SQL·연락처·환불계좌를 넣지 않는다(FR-299(결제 정보 보안))
- 성공 응답은 감싸지 않은 자원 JSON 이다(FastAPI 때와 같음). 목록은 `{ "items": [...] }`

## 5. 공유 계약 §4.9 — 멱등 규칙

| 대상 | 키 | 처음 | 다시 오면 |
|---|---|---|---|
| `POST /api/orders` | 헤더 `Idempotency-Key`(필수, 8~200자) + 회원 | 201 + 주문 | **200 + 같은 주문**(본문이 달라도 처음 것을 돌려준다). DB `uq_orders_member_idempotency` 가 권위 |
| `POST /api/orders/{id}/cancel` | 주문 상태 | 200 `cancelled` | 이미 `cancelled` 면 200 같은 본문. 다른 상태면 409 |
| `POST /api/payments/webhook` | 헤더 `webhook-id` | 처리 결과 200 | `uq_webhook_events_webhook_id` 충돌 → 200(아무것도 바꾸지 않음) |
| 결제 확정 자체 | 주문 상태 조건부 갱신 `pending→paid` | 1행 | 0행이면 이미 처리 — 아무것도 바꾸지 않는다 |
| `POST /api/reservations/{id}/cancel`(이관) | 헤더 `Idempotency-Key`(선택), 없으면 `sha256("cancel:" + reservationId)` | 옛 규칙 그대로 | 옛 규칙 그대로(200 재생) |

삽입 경합은 `INSERT … ON CONFLICT DO NOTHING RETURNING id` 로 받는다. 돌아온 행이 없으면 이긴 행을 다시 읽어 그 결과로 수렴한다 — 옛 SAVEPOINT 방식(`begin_nested`)의 대체다(plan D3).
