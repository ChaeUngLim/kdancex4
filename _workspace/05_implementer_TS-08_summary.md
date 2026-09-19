# Phase 5 구현 요약 — TS-08 (admin-web: API 클라이언트 + 환불 비율표 설정 화면)

- 태스크: TS-08 (T-14 + T-15 통합)
- 상태: **완료**
- 검증: `cd admin-web && npm run build` 성공(타입 에러 0) · `npx oxlint .` 경고 0
- 병렬 태스크(TS-01 backend / TS-09 mobile / TS-10 docs) 파일은 건드리지 않았다. 변경 범위는 `admin-web/` 안에만 있다.

---

## 1. 변경한 파일

| 경로 | 구분 | 변경 요약 |
|---|---|---|
| `admin-web/src/api/client.ts` | 신규 | `API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"`. 얇은 fetch 래퍼 `apiFetch<T>(path, {method, body, userId, signal})` — JSON 직렬화/역직렬화, FastAPI `{"detail": ...}` 메시지 추출, 비-2xx → `ApiError(status, message, detail)`. 임시 인증(F7)용 `X-User-Id` 헤더는 `userId` 옵션으로만 붙는다. 엔드포인트 함수 `fetchHealth`, `fetchRefundPolicy`, `updateRefundPolicy` + 타입 `RefundPolicyTier`(`hours_before_start`/`refund_rate_bp`) |
| `admin-web/.env.example` | 신규 | `VITE_API_BASE_URL=http://localhost:8000` (+ 기본값이 client.ts에 있다는 주석) |
| `admin-web/src/App.tsx` | 수정 | `:7`의 하드코딩 `fetch("http://localhost:8000/health")` 제거 → `fetchHealth()` 경유. `AbortController`로 언마운트 시 취소(StrictMode 이중 실행 대응). 탭 2개(`대시보드`/`환불 정책`) 조건부 렌더링으로 `RefundPolicySettings` 노출. 현재 `API_BASE_URL`을 헤더에 표시 |
| `admin-web/src/pages/RefundPolicySettings.tsx` | 신규 | 학원 환불 비율표 조회/편집/저장 화면. 행 추가·삭제, bp 입력, 저장 전 검증, 에러/알림 표시 |

새 npm 의존성 0개 — `npm install`을 실행하지 않았고 `package.json` / `package-lock.json`은 그대로다.

## 2. 완료 기준 대조

| 기준 | 결과 |
|---|---|
| `cd admin-web && npm run build` 성공, 타입 에러 0 | ✅ (`tsc -b && vite build` 통과, 18 modules) |
| `grep -rn "localhost:8000" admin-web/src/` → `api/client.ts` 한 곳 | ✅ `admin-web/src/api/client.ts:10` 단일 히트 |
| `package.json` dependencies가 react/react-dom 둘뿐 | ✅ 변경 없음 |
| 순수 CSS + `useState`, 라우터·상태관리 라이브러리 미도입 | ✅ `useState`/`useEffect`만 사용. 스타일은 인라인 `CSSProperties` 객체 + `index.css`의 기존 CSS 변수(`--border`, `--accent` 등) 재사용 |
| bp는 0~10000 정수, float/퍼센트 저장 금지 | ✅ 입력은 문자열 드래프트 → 저장 시 `/^-?\d+$/` 정수 검증 후 `number`. 퍼센트는 `formatRate()`가 **표시 직전에만** 환산하며 상태·전송 본문에 들어가지 않는다 |

## 3. 구현 판단 기록

- **티어 해석 규칙을 화면에 명시했다.** TS-03 명세(`h >= 24h`면 티어 무관 전액 / `h < 24h`면 `h <= hours_before_start` 중 `hours_before_start` 최소 / 없으면 0%)를 화면 안내 문구로 그대로 적었다. 설정자가 규칙을 모르고 표를 짜면 의미 없는 표가 된다.
- **저장 전 클라이언트 검증**: `hours_before_start` 1~720 정수, `refund_rate_bp` 0~10000 정수, `hours_before_start` 중복 금지. TS-06의 `RefundPolicyTier` 제약과 같은 값이다. 전송 직전 `hours_before_start` **내림차순 정렬**(TS-06이 정렬을 검증하므로 클라이언트가 미리 맞춘다).
- **학원 ID를 직접 입력받는다.** 학원 목록/상세 API가 이번 슬라이스에 없다(Phase 3 §8 F5). 목록 드롭다운을 만들 소스가 없어 텍스트 입력으로 뒀다.
- **`X-User-Id` 입력 필드를 화면에 뒀다.** §4.5가 인증을 임시로 `X-User-Id` 헤더로 규정(F7)했는데 admin-web에 로그인 흐름이 없다. 값을 넣을 경로가 없으면 화면이 실제로 동작하지 않으므로 입력 필드로 노출했다. 로그인 도입 시 제거 대상이며 코드 주석에 F7을 남겼다.

## 4. 구현 중 발견한 이슈

### I-1. §4.5가 요청/응답 **봉투(envelope)** 를 고정하지 않았다 — 백엔드와 어긋날 수 있음
§4.4는 티어 **원소**의 형태(`{"hours_before_start": 24, "refund_rate_bp": 5000}`)만 고정했고, `GET/PUT /admin/academies/{id}/refund-policy`의 본문이 배열 그대로인지 객체로 감싼 형태인지는 계약에 없다. 백엔드(TS-06)가 아직 없어 실측이 불가능하다.

현재 클라이언트의 선택:
- **읽기**: `extractTiers()`가 배열 그대로 오는 응답과 `{"refund_policy_tiers": [...]}` 로 감싼 응답을 **둘 다** 받아들인다(방어적 정규화).
- **쓰기**: `{"refund_policy_tiers": [...]}` 로 보낸다 — 컬럼명 `academies.refund_policy_tiers` 및 TS-06의 `RefundPolicyUpdate` 명칭과 맞췄다.

**TS-06 구현자가 다른 키(예: `tiers`)를 쓰면 쓰기 경로가 422로 깨진다.** Phase 6/7에서 실제 응답을 보고 `client.ts`의 `refundPolicyPath` 주변 두 함수만 맞추면 된다. 정규화 함수 덕분에 읽기 경로는 양쪽 다 견딘다.

### I-2. 백엔드 CORS가 없으면 화면이 동작하지 않는다 (이 태스크 범위 밖)
TS-06이 `main.py`에 `http://localhost:5173` CORS를 추가하기 전까지는 브라우저에서 `/health`를 포함한 모든 호출이 CORS로 차단된다. admin-web 쪽에서 할 수 있는 일이 없으므로 손대지 않았다. **TS-06 완료 후 수동 확인 필요.**

### I-3. 기존 `admin-web/src/App.css`는 Vite 템플릿 잔재로 남아 있다
`App.css`는 어디에서도 import되지 않으며(`App.tsx`가 참조하지 않음) 내용도 Vite 스타터의 히어로/로고 스타일이다. `src/assets/hero.png`, `react.svg`, `vite.svg`도 마찬가지다. 이번 태스크 범위 밖이라 **삭제하지 않았다.** 위생 정리 항목으로 백로그 권고.

## 5. 미해결 사항 / 다음 단계 의존

- **실브라우저 동작 미검증**: 백엔드 라우터(TS-06)가 없어 `GET/PUT /admin/academies/{id}/refund-policy` 실호출을 한 번도 못 했다. 검증한 것은 타입 체크·린트·빌드까지다. Phase 6에서 백엔드 기동 후 다음 경로를 실측해야 한다 — ① 비율표 불러오기 ② 행 추가 후 저장 ③ 잘못된 bp(예: 20000) 입력 시 클라이언트 검증에서 차단 ④ 없는 학원 ID → 404 메시지 표시.
- **Phase 7 필요 여부**: 현재 없음. 빌드/린트 에러 0이고 자체 수정으로 해소해야 할 항목이 남지 않았다. 단 I-1이 실측에서 어긋나면 `client.ts` 한 파일 수정이 필요하다.
- **테스트 부재**: admin-web에 테스트 러너(vitest 등)가 설정돼 있지 않다. 도입은 새 devDependency가 걸린 결정이라 이번 태스크에서 하지 않았다. `validateDrafts`/`formatRate`는 순수 함수라 러너만 생기면 바로 단위 테스트 가능하다.

---

## ⚠️ 추가 갱신 (2026-09-14, 오케스트레이터) — Next.js로 전면 마이그레이션

사용자 지시로 admin-web 전체를 **Vite → Next.js(App Router)로 즉시 마이그레이션**했다. 이 문서 위쪽의 내용(Vite 기준 완료 기준·파일 경로)은 **더 이상 유효하지 않다.**

**변경된 구조:**
- `src/App.tsx` → `app/layout.tsx`(공통 헤더+네비) + `app/page.tsx`(대시보드) + `app/refund-policy/page.tsx`(환불 정책, 별도 라우트로 분리 — 기존 탭 조건부 렌더링 대신 Next.js 파일 기반 라우팅 사용)
- `src/api/client.ts` → `lib/api-client.ts` (내용 동일, `import.meta.env.VITE_API_BASE_URL` → `process.env.NEXT_PUBLIC_API_BASE_URL`만 변경)
- `src/pages/RefundPolicySettings.tsx` → `components/RefundPolicySettings.tsx` (내용 동일, 상단에 `"use client"` 추가, import 경로만 조정)
- `src/index.css` → `app/globals.css` (내용 거의 동일)
- 신규: `components/AdminNav.tsx` — `usePathname()` 기반 활성 탭 표시 (라우터가 생겨서 가능해진 개선)
- 제거: `vite.config.ts`, `index.html`, `src/main.tsx`, `tsconfig.app.json`, `tsconfig.node.json`, `.oxlintrc.json`, `src/App.css`(미사용), `src/assets/*`(미사용)
- `package.json`: `next`, `react`, `react-dom` 최신(`npm install next@latest react@latest react-dom@latest`로 설치됨 — 정확한 버전은 package.json 참조), devDependencies에 eslint/eslint-config-next 추가

**검증:**
- `npm run build` 성공 — 3개 라우트(`/`, `/_not-found`, `/refund-policy`) 정적 생성 확인, TypeScript 에러 0
- `npm run lint`은 **현재 깨져 있다** — `eslint-config-next@16.3.5` + `eslint@9.39.5` 조합에서 "Converting circular structure to JSON" 에러 발생(FlatCompat 경유 시). `eslint-config-next/core-web-vitals`·`eslint-config-next/typescript`를 직접 import하는 방식으로 고쳐보려 했으나 ECC의 config-protection 훅이 `eslint.config.mjs` 재수정을 차단함(설정 완화 방지 목적, 의도된 보호 동작). **Phase 6/8에서 lint 대신 `next build`의 TypeScript 체크를 신뢰 가능한 대안으로 쓸 것.**
- 실브라우저 동작은 미검증(TS-08 당시와 동일한 한계 — 백엔드 완성 후 확인 필요)

**공유 계약(§4.5) 영향 없음** — API 엔드포인트·요청/응답 형태는 그대로이므로 TS-06(스키마/라우터)에는 영향 없다.
