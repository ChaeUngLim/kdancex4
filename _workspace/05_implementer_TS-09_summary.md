# Phase 5 — TS-09 구현 요약 (mobile 취소 확인 + 환불계좌 입력 화면)

- 작성일: 2026-09-14 / 담당: kdance-implementer (TS-09)
- 입력: `_workspace/04_task-splitter_tasks.md` §TS-09, §4.5 / `_workspace/03_impl-planner_plan.md` §5
- 상태: **완료.** 완료 기준 4개 전부 충족. 단 §4.5 계약의 빈틈 1건이 Phase 7/8 조정 대상으로 남는다.

---

## 1. 변경 파일

| 파일 | 구분 | 변경 요약 |
|---|---|---|
| `mobile/App.tsx` | 수정 (11줄 → 493줄) | 단일 파일 3단계 상태 전환 화면. `home`(예약 ID 입력) → `confirm`(**예상 환불액 사전 고지** + 환불계좌 입력 + 동의 체크) → `result`(환불 결과). 기존 `/health` 표시는 유지하되 하드코딩 URL을 `API_BASE_URL` 상수로 교체 |
| `mobile/.env.example` | 신규 | `EXPO_PUBLIC_API_URL=http://localhost:8000` + 비밀값 금지 주석 |

`mobile/package.json` · `package-lock.json` **무변경** — 신규 의존성 0개.

### 구현 상세

**사전 고지 경로 (수용 기준의 핵심).** `confirm` 단계 진입 즉시 `GET /reservations/{id}/cancellation-preview`를 호출하고, 응답이 오기 전까지 "취소 확정" 버튼이 비활성이다. 활성 조건은 `preview !== null && !previewLoading && !submitting && agreed && (가상계좌면 계좌 3필드 입력완료)`. 즉 **예상 환불액을 화면에 띄우지 않고 확정에 도달하는 경로가 구조적으로 없다.** 동의 체크박스도 `preview === null`이면 눌리지 않는다.

**환불계좌 폼.** `preview.payment_method === "virtual_account"`일 때만 은행코드/계좌번호/예금주 3필드를 렌더링하고, 셋 다 채워져야 확정이 열린다. 카드 결제면 폼 자체가 뜨지 않고 `refund_account: null`로 전송된다(백엔드는 TS-04 결정대로 `UnsupportedPaymentMethodError`를 던질 것이므로 실패가 눈에 보인다).

**신규 의존성 회피 수단.** 체크박스는 `Pressable` + `View` 조합으로 직접 그렸고(`@expo/checkbox` 류 미도입), 화면 전환은 `useState<Step>`만 쓴다. `SafeAreaView`는 RN 0.86에서 deprecated 경로라 쓰지 않고 `ScrollView` contentContainer의 `paddingTop`으로 처리했다.

**인증/멱등성.** §4.5대로 `X-User-Id` 헤더를 보낸다(상수 `DEMO_USER_ID`, F7 주석 명시). `Idempotency-Key`는 **보내지 않는다** — 없으면 서버가 결정적으로 생성한다는 §4.5/D5 규약에 의존하는 편이 클라이언트 재시도에서 안전하다. 주석으로 명시함.

**금액 표시.** `refund_rate_bp`는 표시용으로만 `/100`해서 퍼센트로 찍고(`formatRate`), 금액은 서버가 준 정수를 그대로 쓴다. mobile에서 환불액을 재계산하지 않는다.

**F3 명시.** 파일 최상단 docblock에 "데모 수준 화면, 네비게이션 도입 후 재작성" 및 그 이유(예약 목록·로그인·결제 생성 경로 부재 → 예약 ID 수기 입력)를 적어 두었다.

---

## 2. 완료 기준 검증

| 기준 | 결과 | 확인 방법 |
|---|---|---|
| `cd mobile && npx tsc --noEmit` 통과 | **통과** (exit 0, 출력 없음) | 실행함 |
| 새 npm 의존성 0개 | **충족** | `git status --porcelain mobile/` → `M App.tsx` + `?? .env.example` 둘뿐. package.json/lock 무변경 |
| 확정 전 예상 환불액 표시 경로 존재 | **충족** | `canSubmit`이 `preview !== null`을 포함. preview 블록이 확정 버튼보다 위에 렌더 |
| 데모 수준임을 주석에 명시 (F3) | **충족** | `App.tsx` 1~15행 docblock |

범위 밖 3건(`expo-notifications` 설치 / `app.json` `android.package` / `mobile/.env` 정리)은 **손대지 않았다.** mobile 외 디렉터리도 건드리지 않았다.

---

## 3. 구현 중 발견한 이슈

### I-1. §4.5 API 계약이 **경로만** 고정하고 응답 본문을 고정하지 않는다 — TS-06과 어긋날 수 있다 (중요)

§4.5 표는 메서드·경로·소유/소비 태스크만 정한다. 실제 필드명은 TS-06(`backend/app/schemas/cancellation.py`)이 소유하는데 **TS-06은 아직 구현되지 않았다**(W4). mobile은 TS-06보다 먼저 만들어야 하므로 아래를 **선행 가정**으로 두고 `App.tsx` 주석에 그 사실을 적었다.

```
CancellationPreview: reservation_id, paid_amount, refund_amount,
                     refund_rate_bp, hours_before_start, payment_method
CancelResponse:      refund_id, status, refunded_amount, refund_rate_bp, failure_message?
CancelRequest(body): { refund_account: {bank_code, account_number, holder_name} | null }
```

`status`/`refund_rate_bp` 값 집합은 §4.1·§4.4를 그대로 따랐으므로 안전하다. 나머지 필드명은 **추측이다.** Phase 7/8에서 TS-06 실제 스키마와 대조해 한쪽을 맞춰야 한다.

### I-2. `CancellationPreview`에 `payment_method`가 없으면 환불계좌 폼을 띄울 근거가 사라진다 (TS-06에 대한 요구)

"가상계좌일 때만 환불계좌를 수집한다"는 Q2 결정을 클라이언트가 지키려면, 확정 요청을 보내기 **전에** 결제수단을 알아야 한다. 현재 계획 문서 어디에도 preview 응답에 `payment_method`가 포함된다는 서술이 없다. 없으면 mobile은 (a) 항상 계좌를 받거나 (b) 422를 맞고 나서야 폼을 띄우는 두 가지 나쁜 선택만 남는다.

**TS-06에 대한 요청:** `CancellationPreview`에 `payment_method`와 `paid_amount`를 포함할 것. 없이 구현되면 Phase 7 수정 대상이다.

### I-3. `preview.hours_before_start`의 타입이 계약상 불명확하다

§4.3의 `RefundCalculation`은 `hours_before_start: ...`로 타입이 비어 있다. 소수 시간(float)인지 정수인지, timedelta 직렬화인지 모른다. mobile은 `number`로 받아 `Math.floor`로 표시만 한다 — 정수든 소수든 표시는 깨지지 않지만, 문자열로 직렬화되면 `NaN`이 뜬다. TS-03/TS-06 확정 후 Phase 8에서 확인 필요.

---

## 4. 미해결 사항 / 후속

| 항목 | 처리 |
|---|---|
| I-1·I-2·I-3 (API 계약 정합) | **Phase 7 필요** — 원인이 TS-06 미구현이라 TS-09 범위에서 해소 불가. TS-06 완료 후 실제 스키마와 대조할 것 |
| 실기기/에뮬레이터 실행 검증 | **미수행.** `npx tsc --noEmit`만 돌렸다. Expo Go 실행은 백엔드(TS-06) + Docker(TS-00)가 모두 필요해 이번에 불가. "화면이 실제로 뜬다"를 통과했다고 기록하지 말 것 |
| `localhost:8000` 하드코딩 | `App.tsx`의 `API_BASE_URL` fallback 1곳에만 남아 있다(TS-08의 admin-web 기준과 동일한 형태). 실기기에서는 `localhost`가 기기 자신을 가리키므로 `.env`에 LAN IP를 넣어야 동작한다 — 데모 한계로 주석 없이 남겨 두었다면 후속 문서화 대상 |
| `mobile/.env` 위생 (F8) | **범위 밖, 손대지 않음.** 다만 확인은 했다 — 루트 `.gitignore:7`의 `.env`가 `mobile/.env`를 덮고 있고 git에 추적되지 않는다(`git check-ignore` / `ls-files` 확인). 즉 **키 유출 위험은 현재 없다.** 내용 정리는 여전히 별건 권고 |
| `mobile/.gitignore`는 `.env*.local`만 무시 | 루트 `.gitignore`가 커버하므로 문제 없음. 수정하지 않았다 |

---

## 5. Phase 6(테스트)용 대상

- `mobile/App.tsx` — mobile에 테스트 러너가 없다(`package.json`에 jest/`jest-expo` 미설치). 테스트를 추가하려면 **신규 devDependency가 필요**하고 이는 "새 npm 의존성 0개" 기준과 충돌한다. Phase 6은 `npx tsc --noEmit`을 검증 수단으로 쓰는 것이 현재 구성에서 가능한 최대치다.
