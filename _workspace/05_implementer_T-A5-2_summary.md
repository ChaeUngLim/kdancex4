# Phase 5(구현) 보고 — T-A5-2(가입·취향 화면 5종)

- 슬라이스: US1-A5(mobile 화면) · 작성 2026-11-06
- 결과: 화면 5개와 공용 도우미 8개를 만들었다. 내 파일에서는 타입 오류가 0건이다. 다만 `tsc --noEmit` 전체는 **exit 2** 다. T-A5-3(홈·상세·결제 대기·캘린더 화면)의 `app/(tabs)/home.tsx` 에서 오류 1건이 나기 때문이다(아래 「검증」)

## 1. 만든 파일

| 파일 | 내용 |
|---|---|
| `mobile/app/login.tsx` | 이메일·비밀번호 로그인 → `GET /api/me` 결과로 다음 화면을 고른다 |
| `mobile/app/identity.tsx` | 가짜 본인확인 입력(이름·성별·생년월일·휴대폰·시험용 사람 키) |
| `mobile/app/signup.tsx` | FR-002(가입 정보 수집·고지): 필수 3항목과 수집 목적을 보여 주고 확인을 받은 뒤 가입한다 |
| `mobile/app/preferences.tsx` | FR-022(사용자 프로필): 관심 장르(필수, 여러 개)·활동 지역(최대 20)·활동 시간·경험 수준(FR-029(경험 수준 구간) 6구간) |
| `mobile/app/base-genre.tsx` | FR-022a(첫 화면 장르 선택·유지): 2×2 카드 4장에서 하나만 고른다. 건너뛰기 없음 |
| `mobile/lib/onboarding/types.ts` | 계약 타입(`Member`·`ProfileInput` 등)과 §4.1(상태·구분 값 집합)의 장르·경험 수준 값 |
| `mobile/lib/onboarding/labels.ts` | 장르·경험 수준·성별의 한글 이름, FR-002 수집 목적 문구 |
| `mobile/lib/onboarding/theme.ts` | 색 토큰. 아이보리 #F4F1EC + 갈색 #A8620A, 장르 색 4종은 카드에만 |
| `mobile/lib/onboarding/errors.ts` | `ApiError.code` → 화면 문구 또는 이동(401 이면 토큰 삭제 후 로그인 화면) |
| `mobile/lib/onboarding/use-request.ts` | 진행 중·오류 상태 훅. 언마운트 뒤 setState 막기, AbortError 무시 |
| `mobile/lib/onboarding/members-api.ts` | 계약 §1~§6 호출 6개(`apiFetch` 사용) |
| `mobile/lib/onboarding/flow.ts` | 다음 화면 판정(`nextOnboardingRoute`), 본인확인 결과 메모리 보관, 만료 판정 |
| `mobile/lib/onboarding/validation.ts` | 보내기 전 입력 검사(생년월일·휴대폰·시간대·지역 중복) |
| `mobile/lib/onboarding/components.tsx` | 화면 틀(SafeArea·스크롤·하단 고정 버튼)·주/보조 버튼·오류 상자·칩·입력칸 |

`_layout.tsx`·`api.ts`·`session.ts`·T-A5-3 파일·`mobile/.env` 는 열지도 고치지도 않았다. 새 패키지는 설치하지 않았다.

## 2. 화면별 API 호출과 상태 처리

| 화면 | 호출 | 성공 | 실패 처리 |
|---|---|---|---|
| login | `POST /api/auth/sign-in/email`(auth:false) → 본문 `token` 을 SecureStore 에 저장 → `GET /api/me` | `nextOnboardingRoute` 로 `/preferences`·`/base-genre`·`/home` 중 한 곳 | 401 → 「이메일 또는 비밀번호가 맞지 않아요」. `/api/me` 의 403 `SIGNUP_INCOMPLETE` → `/identity`. 네트워크 오류는 `detail` 문구 |
| identity | `POST /api/dev/identity/fake-verify` | 결과를 메모리(`flow.ts`)에 넣고 `/signup` 으로 이동 | 입력 검사를 먼저 하고, 서버 오류는 code 별 문구로 보여 준다 |
| signup | `POST /api/members` `{verificationToken, noticeAcknowledged:true}` | 메모리를 비우고 다음 화면으로 | 확인 칩을 누르기 전에는 버튼이 꺼져 있다. 409 `IDENTITY_ALREADY_USED` → 1인 1계정 문구. 422 `VALIDATION_FAILED` → `fields` 문구와 「본인확인 다시 하기」. 토큰이 없거나 10분이 지났으면 본인확인으로 돌려보내는 화면을 띄운다 |
| preferences | 열 때 `GET /api/me` 로 기존 값을 채우고(AbortController), 저장할 때 `PUT /api/me/profile` | 다음 화면으로 | 관심 장르가 0개면 막는다. 시간은 둘 다 넣거나 둘 다 비우고, 시작 < 끝. 불러오기에 실패해도 새로 입력할 수 있다 |
| base-genre | `PUT /api/me/base-genre` | `router.replace('/home')` | 고르기 전에는 버튼이 꺼져 있다 |

공통: 401 `UNAUTHENTICATED` → 토큰 삭제 후 `/login`, 403 `SIGNUP_INCOMPLETE` → `/identity`(`errors.ts`). 오류 문구는 `accessibilityLiveRegion` 으로 화면 낭독기가 읽는다.

## 3. 계약에서 모호했던 점

1. **로그인 토큰 위치** — 계약 §1 은 응답 헤더 `set-auth-token` 을 저장하라고 하는데, 헤더 이름이 미확인(R-10)이고 `apiFetch` 는 헤더를 돌려주지 않는다. 그래서 지금은 Better Auth 응답 **본문의 `token`** 을 저장한다. 이 값이 `Authorization: Bearer` 로 통하는지(서명된 값이 필요한지)는 T-M1-4(Better Auth 스모크)에서 확인해야 한다
2. **Better Auth 오류 모양** — Better Auth 의 실패 본문은 §4.8(오류 응답 형식) 모양이 아니다. 그래서 `apiFetch` 가 `UNEXPECTED_RESPONSE` 로 바꾼다. 로그인 화면은 상태 401 만 보고 문구를 정한다. Better Auth 의 실제 오류 code 로는 분기하지 못한다
3. **fake-verify 인증** — 계약 §2 에 인증 필요 여부가 없다. 로그인 뒤 화면이라 토큰을 붙여 보낸다(apiFetch 기본값). 서버가 토큰을 거부하는 경로로 만들면 `auth:false` 로 바꿔야 한다
4. **가입 뒤 다음 화면** — 계약 흐름은 「가입 → 취향 → 기준 장르」다. 다만 `POST /api/members` 가 이미 가입된 회원에게 200 을 줄 때는 `onboarding` 플래그로 남은 단계부터 이어 간다
5. **base-genre 성공 뒤 이동** — `profileDone` 이 false 여도 홈으로 보낸다. 계약상 홈은 기준 장르만 요구한다(D16(홈 장르 조건))
6. **422 의 원인 구분** — `POST /api/members` 의 422 는 고지 미확인과 토큰 만료가 같은 code 다. 화면은 둘을 나누지 못해서 `fields`/`detail` 문구를 보여 주고 「본인확인 다시 하기」 버튼을 함께 낸다

## 4. 필요 변경 (이 Task 범위 밖)

1. **`mobile/lib/api.ts`** — 응답 헤더를 읽을 수 있는 변형이 필요하다(예: `apiFetchWithHeaders` 또는 `{ data, headers }` 반환 옵션). 그래야 계약 §1 의 `set-auth-token` 헤더를 저장할 수 있다. T-M1-4 가 헤더 이름을 확정한 뒤에 바꾼다
2. **홈 주소 `/home`** — `flow.ts` 의 `HOME_ROUTE='/home'` 은 T-A5-3 이 만드는 `app/(tabs)/home.tsx` 를 가리킨다. T-A5-3 이 다른 파일명을 쓰면 이 상수 하나만 고치면 된다
3. **첫 진입 화면** — `app/index.tsx`(또는 `_layout` 의 초기 경로)가 없어서 앱을 켜도 `/login` 으로 바로 가지 않는다. 토큰이 있으면 `/api/me` → 다음 화면, 없으면 `/login` 으로 보내는 진입 화면이 필요하다. 「만들 파일」 목록 밖이라 만들지 않았다
4. **장르 카드 사진** — FR-022a 는 사진 카드와 3초 교차(살사↔바차타, 비엔나왈츠↔쌈바)를 요구한다. 지금은 mobile 에 이미지 자산이 없어서 장르 색 면과 이름·설명 글자만 넣었다. 자산을 옮기고 교차를 넣는 Task 가 따로 있어야 한다
5. **보드 M1 소셜 로그인 버튼(카카오·구글·네이버)** — 1회차는 시드 계정만 쓰므로(D10(인증)) 이메일 입력으로 대신했다
6. **보드 M3 「대학생이에요」 토글·M5 세부 장르·이동 가능 거리** — 계약 §5 가 받지 않는 칸이라 넣지 않았다(보내면 422)

## 5. 검증

```
$ cd /home/user/kdance/mobile && ./node_modules/.bin/tsc --noEmit; echo "TSC_EXIT=$?"
app/(tabs)/home.tsx(113,11): error TS2322: Type 'Element | null' is not assignable to type 'Element | ComponentType<any> | undefined'.
TSC_EXIT=2
```

- 오류는 T-A5-3 의 파일 1곳에서만 난다. 내 파일(`app/login|identity|signup|preferences|base-genre`, `lib/onboarding/*`)만 걸러 보면 0건이다(`grep` 결과 없음)
- T-A5-3 이 그 줄을 고치면 전체 exit 0 이 될 것으로 본다. 단 그 상태로는 아직 돌려 보지 않았다
- 화면 실행(Metro·기기·웹)은 하지 않았다. 서버 API 가 아직 없어 호출 흐름은 타입으로만 확인했다. 실제 확인은 T-A5-4(웹 실행 시도)에서 한다
