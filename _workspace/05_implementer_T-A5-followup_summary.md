# 05 구현 요약 — T-A5-2·3 후속(mobile 진입·세션·테마 정리)

## 바꾼·만든·지운 파일

| 구분 | 경로 | 내용 |
|---|---|---|
| 새로 만듦 | `mobile/app/index.tsx` | 진입 화면(`/`). 토큰이 없으면 `/login`, 있으면 `fetchMe` → `nextOnboardingRoute`(가입 흐름 다음 화면) 결과로 이동. 403 `SIGNUP_INCOMPLETE` 는 `/identity`(`login.tsx` 와 같은 규칙). 그 밖의 오류는 `/login`. 기다리는 동안 `LoadingView`, 이동은 expo-router 58 `<Redirect href>`(설치본 `build/link/Redirect.d.ts` 로 시그니처 확인). 언마운트 시 `AbortController` 로 요청을 끊는다 |
| 고침 | `mobile/index.ts` | 주석만 수정. 진입 화면 설명을 넣고, App.tsx 는 T-A5-3(홈·상세·결제 대기·캘린더 화면)이 옮기면서 지웠다고 고쳤다. 코드(`import 'expo-router/entry'`)는 그대로 |
| 고침 | `mobile/lib/api.ts` | 토큰을 실어 보낸 요청이 401 이면 `clearSessionToken()`(lib/session.ts) 호출 후 같은 `ApiError` 를 던진다. 삭제가 실패해도 `ApiError` 가 바뀌지 않게 try/catch 로 감쌌다. 머리 주석에 4번 항목 추가 |
| 새로 만듦 | `mobile/lib/theme.ts` | 두 테마를 합친 공용 토큰. 내보내는 이름: `colors` · `genreColors` · `space` · `radius` · `font` · `MIN_TOUCH` |
| 지움 | `mobile/lib/onboarding/theme.ts`, `mobile/lib/catalog/theme.ts` | |
| import·이름 교체 | `app/base-genre.tsx`, `app/preferences.tsx`, `lib/onboarding/components.tsx` | `COLORS`→`colors`, `GENRE_COLORS`→`genreColors`, `SPACING`→`space`, `RADIUS`→`radius`, `COLORS.accent`→`colors.brown`, `COLORS.accentSoft`→`colors.brownSoft`. components.tsx 머리 주석의 `theme.ts` 경로도 `lib/theme.ts` 로 고침 |
| import 경로만 교체 | `app/(tabs)/calendar.tsx`, `app/(tabs)/home.tsx`, `app/checkout/[orderId].tsx`, `app/offering/[id].tsx`, `app/reservation/[id]/cancel.tsx`, `lib/catalog/ui.tsx`, `lib/catalog/tab-bar.tsx` | 이름은 원래 소문자라 경로만 바꿈 |

## 401 처리 판단

- **`auth: false` 요청(로그인)의 401 에서는 토큰을 지우지 않는다.** 로그인 실패 401 은 계정 문제라 저장된 토큰과 상관없다. `login.tsx` 의 `toLoginError`(401 → 문구 교체)는 그대로 동작한다.
- **중복**: `lib/onboarding/errors.ts` 의 `toErrorOutcome` 이 `UNAUTHENTICATED` 일 때 `clearSessionToken()` 을 한 번 더 부른다. 이제 api.ts 가 먼저 지우므로 두 번째 삭제는 없는 키를 지우는 셈이다. 결과가 같아 손대지 않았다(과제 지시대로). 정리하려면 errors.ts 의 그 한 줄을 빼면 된다.
- `lib/catalog` 에는 401 때 토큰을 지우는 코드가 없다(`ErrorView` 가 `/login` 버튼만 보여 준다). 이제 api.ts 가 지우므로 그 버튼으로 로그인 화면에 가면 깨끗한 상태다.

## 테마 값 선택 근거

기준 보드: `docs/prototype/penpot/frames/sec-tokens.png`. 아이보리 `#F4F1EC`·갈색 `#A8620A` 은 확정값이라 그대로 뒀다.

| 토큰 | onboarding 값 | catalog 값 | 고른 값 | 근거 |
|---|---|---|---|---|
| 갈색 강조 | `COLORS.accent` `#A8620A` | `colors.brown` `#A8620A` | `colors.brown` `#A8620A` | 값이 같아 이름만 통일. 사용 횟수가 많은 쪽(brown 10 / accent 9) |
| 갈색 옅은 바탕 | `accentSoft` `#F3E6D3` | `brownSoft` `#F6EBDD` | `#F6EBDD` | 보드에 없음. 이름을 brown 계열로 맞추면서 catalog 값을 따랐다 |
| 테두리 | `line` `#E2DDD5` | `line` `#E4DED6` | `#E4DED6` | 보드에 없음. 사용 횟수가 많은 catalog 값(7 / 4) |
| 오류 | `danger` `#B42318` | `danger` `#B4232B` | `#B4232B` | 보드 팔레트에 있는 값(댄스스포츠 `#B4232B`)과 같은 쪽 |
| 오류 옅은 바탕 | `dangerSoft` `#FDECEA` | `dangerSoft` `#FBE7E6` | `#FBE7E6` | 보드에 없음. danger 를 catalog 로 맞췄으니 짝도 같은 쪽 |
| 막힌 버튼 | `disabled` `#D9D3CA` | `disabled` `#E6E1DA` | `#E6E1DA` | 보드 「마감」 버튼 바탕이 밝은 회베이지라 catalog 값에 가깝다 |

장르 색 4종은 원래 onboarding 에만 있었고 보드 값과 같아 그대로 옮겼다(`genreColors`).

### 화면에서 색이 바뀌는 곳 (모두 가입·취향 화면 쪽, 홈·상세 화면은 변화 없음)

- `lib/onboarding/components.tsx` 를 쓰는 로그인·본인확인·가입·취향·기준 장르 5화면
  - 테두리(카드·푸터 윗선·칩·입력칸): `#E2DDD5` → `#E4DED6` (거의 차이 없음)
  - 선택된 칩 바탕: `#F3E6D3` → `#F6EBDD` (조금 옅어짐)
  - 오류 문구 글자: `#B42318` → `#B4232B`
  - 오류 상자 바탕: `#FDECEA` → `#FBE7E6`
  - 막힌 주 버튼 바탕: `#D9D3CA` → `#E6E1DA` (더 밝아짐)
- `app/base-genre.tsx`·`app/preferences.tsx` 에서 위 토큰을 직접 쓰는 자리(테두리·갈색 강조 등)도 같은 규칙으로 바뀐다. 갈색 강조 자체는 값이 같아 변화 없음.

## 발견한 이슈 / 미해결

1. **막힌 주 버튼의 글자 대비** — onboarding `primaryDisabled` 는 바탕만 `disabled` 로 바꾸고 글자는 흰색(`colors.surface`) 그대로다. 바탕이 `#E6E1DA` 로 밝아져 흰 글자가 더 안 보인다(원래도 약했다). 보드 「마감」 버튼처럼 막힌 상태 글자를 `colors.disabledInk` 로 바꾸는 게 맞아 보이지만, 과제 범위(4개) 밖이라 고치지 않았다. 다음 Task 나 Phase 8(코드 리뷰)에서 판단 필요.
2. **errors.ts 의 토큰 삭제 중복** — 위 「401 처리 판단」 참고. 동작은 같다.
3. 진입 화면은 실제 기기·에뮬레이터에서 띄워 보지 않았다(타입 검사만). `mobile/.env` 는 열지 않았다.

## 검증 원문

```
$ cd /home/user/kdance/mobile && ./node_modules/.bin/tsc --noEmit; echo TSC_EXIT=$?
TSC_EXIT=0
$ grep -rn "onboarding/theme\|catalog/theme" app lib | wc -l
0
```
