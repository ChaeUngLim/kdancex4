# Phase 5 — TS-06 구현 산출물: Pydantic 스키마 + 라우터 + main.py 배선

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-06)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-06 · §4.4 · §4.5, `_workspace/03_impl-planner_plan.md` 24·26·27번 항목
- 선행: TS-01~TS-05 완료물 위에 쌓음
- 상태: **완료.** `cd backend && uv run pytest` → **159 passed** (기존 120 유지 + 신규 39). DB 불필요.

---

## 1. 변경한 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `backend/app/schemas/__init__.py` | 신규 | 패키지 docstring만. 하위 모듈을 import하지 않는다(모델과 달리 `Base.metadata` 같은 등록 이유가 없다) |
| `backend/app/schemas/cancellation.py` | 신규 | `RefundAccountIn`(+`to_domain()`), `CancelRequest`(model_validator), `CancelResponse`(+`from_outcome`), `CancellationPreviewResponse`(+`from_preview`) |
| `backend/app/schemas/academy.py` | 신규 | `RefundPolicyTier`(StrictInt, 1~720 / 0~10000), `RefundPolicyUpdate`(내림차순·중복·개수 검증 + `to_jsonb()`), `RefundPolicyResponse` |
| `backend/app/routers/__init__.py` | 신규 | 패키지 docstring만 |
| `backend/app/routers/reservations.py` | 신규 | `POST /reservations/{id}/cancel`, `GET /reservations/{id}/cancellation-preview`. 예외→HTTP 매핑(`exc.status_code` 그대로 + `ValueError`→422) |
| `backend/app/routers/admin_academies.py` | 신규 | `GET·PUT /admin/academies/{id}/refund-policy` |
| `backend/app/main.py` | 수정 | `include_router` 2줄 + CORS(5173·3000). **기존 `GET /health` 데코레이터는 손대지 않음** |
| `backend/app/services/cancellation.py` | **수정(2줄 + 주석)** | `CancellationPreview` dataclass에 `payment_method: str | None` 추가, `preview_cancellation()`이 채운다 — 아래 §3-4 참조 |
| `backend/tests/test_schemas.py` | 신규 | DB 없이 도는 검증 39건(스키마 경계 + 라우터 배선 + 예외 매핑 + CORS) |

TS-07 소유 파일(`conftest.py`, `test_cancel_api.py`, `test_admin_refund_policy.py`)은 만들지 않았다. admin-web/mobile은 손대지 않았다.

## 2. 완료 기준 대조

| 기준 | 결과 |
|---|---|
| `uv run pytest tests/test_health.py` 통과(회귀 없음) | ✅ 통과. `test_schemas.py`에도 `/health` 회귀 테스트를 하나 더 뒀다 |
| 신규 경로 4개 + `/health` 출력 | ✅ 단, **지정된 명령이 이 FastAPI 버전에서 동작하지 않는다** — 아래 §4 I-1 |
| `refund_account` 누락 시 422 스키마 단위 테스트 (DB 불필요) | ✅ `test_virtual_account_without_refund_account_is_rejected`(스키마) + `test_cancel_endpoint_returns_422_without_refund_account`(API 경계, DB 미접속 상태에서 통과) |
| `uv run pytest` 전체 초록 | ✅ 159 passed (120 → 159). error 0, skip 0 |

검증한 것은 여기까지다. **실제 DB를 붙인 동작은 검증하지 못했다** — `localhost:5433` 연결 거부(WSL에 docker CLI 없음). TS-06은 원래 "Docker 불필요" 태스크이고 실동작은 TS-12의 몫이다.

## 3. 오케스트레이터가 지시한 요구사항 4건 — 반영 위치

### 3-1. `calculate_refund`의 `ValueError` → 422 (TS-03 경고)

`routers/reservations.py`의 `_invalid_policy_error()`. **preview와 cancel 양쪽** 모두에 걸었다. 원본 메시지는 `logger.warning`에만 남기고 응답에는 "환불액을 계산할 수 없습니다. 학원의 환불 비율표 설정이 올바른지 확인해 주세요."만 보낸다 — 내부 값(`refund_rate_bp=99999` 같은)이 회원 화면에 나가지 않게. 테스트: `test_broken_refund_policy_becomes_422_not_500`.

### 3-2. `preview_cancellation()`을 그대로 사용 (TS-05)

`GET /cancellation-preview`는 이 함수 하나만 부른다. 조회 로직을 새로 쓰지 않았다. `cancellable=False`도 **200으로** 돌려준다 — 4xx로 바꾸면 클라이언트가 사유를 파싱하는 대신 "조회 실패"만 띄우게 된다.

### 3-3. `UnsupportedRefundMethodError` → HTTP 매핑만 (TS-05)

예외 타입별 `if/elif` 사다리를 만들지 않았다. `CancellationError`가 `status_code`를 값으로 들고 다니므로 `_http_error()` 한 줄이 전부다(422 포함). 취소 사유가 늘어도 라우터는 안 바뀐다. 테스트: `test_domain_errors_keep_their_status_code`(404/403/409/422 파라미터화).

### 3-4. mobile이 요구한 `payment_method` + `paid_amount` (TS-09 I-2)

`CancellationPreviewResponse`에 둘 다 포함했다. **단 `paid_amount`만 서비스에 이미 있었고 `payment_method`는 없었다.**

`app/services/cancellation.py`의 `CancellationPreview` dataclass에 `payment_method: str | None` 필드를 추가하고 `preview_cancellation()`이 `payment.method`로 채우게 했다(정확히 2줄 + 주석). 대안은 라우터가 `Payment`를 직접 조회하는 것이었는데, 그러면 `_find_paid_payment()`의 "가장 최근 입금 건" 규칙이 라우터에 복제되고 두 경로가 갈라질 수 있다. 필드 추가는 기본값 없는 위치 삽입이지만 생성 지점이 2곳(서비스 본문 + 신규 테스트)뿐이고 둘 다 키워드 인자라 안전하다. TS-05의 기존 테스트 36건은 `CancellationPreview`를 전혀 구성하지 않는다(`grep` 확인).

**결제 원거래가 없으면 `payment_method`는 `null`이다.** 이때 `cancellable=false`, `reason_code="paid_payment_not_found"`가 같이 나간다.

### 3-5. admin-web의 `{"refund_policy_tiers": [...]}` 형태 (TS-08)

`RefundPolicyUpdate.refund_policy_tiers`로 그대로 받는다. 응답은 `{"academy_id": ..., "refund_policy_tiers": [...]}` — TS-08의 `extractTiers()`가 "배열 그대로 / 키로 감싼 형태" 둘 다 받아들이므로 읽기도 맞는다. **admin-web은 수정할 필요가 없다** (TS-08 I-1 해소).

정렬 방향도 admin-web에 맞췄다 — `RefundPolicySettings.tsx`가 저장 직전 `hours_before_start` **내림차순**으로 정렬해 보내고, `RefundPolicyUpdate`도 내림차순만 통과시킨다.

## 4. 구현 중 발견한 이슈

### I-1. 완료 기준의 검증 명령이 이 FastAPI 버전에서 깨진다 (계획 ↔ 실제 불일치)

지정된 `uv run python -c "from app.main import app; print([r.path for r in app.routes])"`는 **AttributeError로 죽는다.** FastAPI 0.141.1은 `include_router`로 붙인 라우터를 `_IncludedRouter` 래퍼로 `app.routes`에 넣고, 이 객체에는 `.path`가 없다. 계획 작성 시점의 구버전 동작을 전제한 명령이다.

**대체 명령(동작 확인함):**

```bash
cd backend && uv run python -c "from app.main import app; print(sorted(app.openapi()['paths']))"
# ['/admin/academies/{academy_id}/refund-policy', '/health',
#  '/reservations/{reservation_id}/cancel', '/reservations/{reservation_id}/cancellation-preview']
```

같은 이유로 `test_all_routes_are_mounted`도 `app.routes`가 아니라 OpenAPI 스키마를 본다. Phase 9 검증자는 위 명령을 쓸 것.

### I-2. admin 경로에 인증도 권한 검사도 없다 (F7 확장 — **배포 차단 사유**)

`GET·PUT /admin/academies/{id}/refund-policy`는 **학원 ID만 알면 누구나 환불 비율표를 바꿀 수 있다.** 0%로 바꿔 두면 이후 모든 취소가 무환불이 되므로 영향은 설정 변경이 아니라 금전 피해다.

`X-User-Id`를 요구하지 **않기로** 했다. 이번 슬라이스에 "이 사람이 이 학원의 관리자인가"를 판정할 모델이 없어서(Phase 3 §2.7), 헤더를 요구해도 아무 UUID나 넣으면 통과한다 — 있는 척하는 검사는 다음 사람이 "인증이 걸려 있다"고 오해하게 만든다. 대신 `admin_academies.py` 모듈 docstring 최상단에 경고와 **붙일 자리**(`dependencies=[Depends(require_academy_admin)]`)를 명시했다.

TS-08의 admin-web은 `userId`를 선택값으로 보내므로 지금 구성 그대로 동작한다.

### I-3. mobile이 `preview.cancellable` / `reason_code`를 보지 않는다 (TS-09 후속)

`mobile/App.tsx`의 `CancellationPreview` 타입에 두 필드가 없고 `canSubmit`도 확인하지 않는다. 이미 시작한 수업에서도 확정 버튼이 열리고, 눌러야 409를 받는다. **서버는 올바르게 막는다**(금전 사고는 아니다). 다만 preview API를 만든 이유 절반이 "미리 버튼을 막기"였으므로 Phase 8에서 mobile 쪽 3줄 수정 권고. TS-06 범위 밖이라 손대지 않았다.

### I-4. `cancel` 경로의 `ValueError` 포괄 catch는 메시지가 약간 넓다

`cancel_reservation()`을 감싼 `except ValueError`는 비율표 오류 외의 `ValueError`(예: DB에 들어간 알 수 없는 `refunds.status` 값을 `RefundStatus()`로 변환할 때)도 같은 422로 접는다. 두 경우 모두 "데이터가 계약을 어겼다"는 같은 부류라 422 자체는 맞지만, 응답 문구는 비율표를 가리킨다. 원인은 항상 `logger.warning`에 남으므로 운영상 추적은 된다. 더 좁히려면 서비스가 전용 예외를 던져야 하는데 그건 TS-05 파일의 실질적 변경이라 하지 않았다.

### I-5. `RefundPolicyResponse` 생성 실패를 500이 아니라 422로 바꿨다

이 API가 생기기 전에 들어갔거나 SQL로 직접 넣은 값이 스키마를 어길 수 있다. `GET`이 500을 내면 관리자는 "화면이 고장났다"만 보고 고칠 방법을 못 찾는다. 422 + "다시 저장하면 복구됩니다"로 바꿨다 — `PUT`은 조회 결과에 의존하지 않으므로 실제로 복구된다.

## 5. 계획에서 벗어난 판단 (근거 포함)

| 항목 | 계획 | 실제 | 이유 |
|---|---|---|---|
| preview 응답 클래스명 | `CancellationPreview` | `CancellationPreviewResponse` | 서비스 dataclass와 이름이 겹친다. **JSON 필드명은 계약 그대로**라 클라이언트 영향 0 |
| `CancelRequest.method` | 명시 없음 | **선택값** | 필수로 하면 mobile(`{refund_account}`만 전송)이 즉시 깨진다. 결제수단의 권위는 `payments.method`이고 클라이언트 값은 참고 정보다 |
| CORS 출처 | `http://localhost:5173` | 5173 **+ 3000** | admin-web이 Next.js로 옮겨졌다(TS-08 추가 갱신). 와일드카드는 쓰지 않았다 — `X-User-Id` 하나로 신원을 주장하는 상태(F7)에서 `*`는 임시 인증의 구멍을 브라우저로 그대로 연다 |
| 취소 사유(`reason`) 입력 | 언급 없음 | **받지 않음** | 값 집합이 `member_request` 하나뿐(Q5). 받아도 신뢰할 수 없는 입력이 하나 느는 것뿐이다 |
| PG 실패 시 응답 코드 | 명시 없음 | **200 + `status="failed"`** | 비-2xx면 실패 사유가 담긴 본문이 클라이언트 에러 처리로 빨려 들어가 회원에게 이유를 못 보여준다. mobile(TS-09)도 `result.status === "failed"` 분기를 전제로 만들어졌다 |
| 에러 본문 형태 | 명시 없음 | `{"detail": "<문장>"}` (문자열) | TS-08의 `extractMessage()`가 문자열 detail과 pydantic의 `[{msg}]`만 해석한다. `{"code":..,"message":..}` dict로 주면 admin-web이 메시지를 못 뽑아 "HTTP 404"만 표시한다. **기계용 `code`는 응답에 싣지 못했다** — 필요해지면 헤더나 봉투 도입을 별건으로 결정할 것 |

## 6. 미해결 / Phase 6·7 인계

- **실DB 통합 미검증**: `localhost:5433` 연결 거부(이 환경에 docker CLI 없음). 취소 정상 경로·403·409·멱등 재생은 **코드상으로만** 맞춰져 있다. TS-07이 작성하고 TS-12가 실행한다.
- **Phase 7 필요 여부: 없음.** 빌드/문법 오류 0, 전체 테스트 초록. 자체 수정으로 해소해야 할 항목이 남지 않았다.
- **Phase 6 테스트 대상**: 위 §1의 변경 파일 8개. 특히 `routers/reservations.py`의 예외 매핑과 `schemas/academy.py`의 JSONB 문지기 역할이 DB 없이 검증 가능한 지점이다.
- **후속 권고 3건**: I-2(admin 인증 — 배포 전 필수), I-3(mobile이 `cancellable` 무시), I-4(에러 문구 정밀화). 셋 다 이번 태스크 범위 밖이라 코드에는 주석만 남겼다.
