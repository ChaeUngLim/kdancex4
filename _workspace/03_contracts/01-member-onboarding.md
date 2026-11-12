# API 계약 — 로그인·가입·취향 (US1-A1(가입·취향))

공통 규칙은 `README.md`. 관련 요구: FR-002(가입 정보 수집·고지) · FR-003(본인확인 계정 식별) · FR-022(사용자 프로필) · FR-022a(첫 화면 장르 선택·유지).

## 흐름

```
시드 계정 로그인(Better Auth) → 가짜 본인확인 토큰 받기(dev) → POST /api/members(가입 완료)
→ PUT /api/me/profile(취향) → PUT /api/me/base-genre(기준 장르) → 홈
```

## 1. 로그인 — Better Auth 기본 경로

| 경로 | 비고 |
|---|---|
| `POST /api/auth/sign-in/email` | Better Auth 이메일·비밀번호. 1회차 계정은 **시드가 만든 것만** 쓴다(가입 경로 `sign-up/email` 은 `KDANCE_DEV_ROUTES=true` 일 때만 연다) |
| `POST /api/auth/sign-out` | |

응답 모양은 Better Auth 1.7.5 그대로다(우리가 정하지 않는다). 모바일은 응답 헤더 `set-auth-token`(bearer 플러그인)을 저장한다 — 헤더 이름은 **미확인**, research R-10.

## 2. `POST /api/dev/identity/fake-verify` — 가짜 본인확인(dev 전용)

실제 본인확인 기관이 생기면 이 경로는 사라지고 기관 콜백이 같은 토큰을 만든다.

요청
```json
{ "name": "김회원", "gender": "male", "birthDate": "1995-03-02", "phone": "01012345678", "personKey": "seed-member-1" }
```
응답 200: `{ "verificationToken": "<불투명 문자열>", "expiresAt": "…Z" }`
- `personKey` 가 같으면 같은 CI 를 낸다(1인 1계정 시험용). 토큰 유효 10분
- 토큰에는 서명된 본인확인 결과가 들어 있고 서버가 `IdentityVerificationPort.verify` 로 푼다(`06-ports.md`)

## 3. `POST /api/members` — 가입 완료

인증: 세션 필요(가입 미완료여도 됨).

요청
```json
{ "verificationToken": "…", "noticeAcknowledged": true }
```

| 결과 | 응답 |
|---|---|
| 성공 | 201 `Member`(아래) |
| 이미 이 세션으로 가입 끝 | 200 같은 `Member` |
| `noticeAcknowledged` 가 true 아님 | 422 `VALIDATION_FAILED`(FR-002 고지 확인) |
| 토큰 무효·만료 | 422 `VALIDATION_FAILED` |
| 같은 CI 가 다른 계정에 있음 | 409 `IDENTITY_ALREADY_USED`(FR-003) |

나이·성별·연락처는 본인확인 결과에서 가져온다 — 앱이 따로 보내지 않는다. 셋 중 하나라도 비면 가입하지 않는다(AC-9(가입 정보)).

`Member`
```json
{ "id": "…", "name": "김회원", "gender": "male", "birthDate": "1995-03-02", "phoneMasked": "010-****-5678",
  "profile": { "interestGenres": [], "regions": [], "availableFrom": null, "availableTo": null, "experienceLevel": null },
  "baseGenre": null, "onboarding": { "profileDone": false, "baseGenreDone": false } }
```

## 4. `GET /api/me`

200 `Member`. 401 · 403 `SIGNUP_INCOMPLETE` 는 공통 규칙.

## 5. `PUT /api/me/profile` — 취향(FR-022)

```json
{ "interestGenres": ["salsa_bachata"], "regions": [{"sido":"서울","gu":"강남구"}],
  "availableFrom": "18:00", "availableTo": "22:00", "experienceLevel": "beginner" }
```

| 칸 | 규칙 |
|---|---|
| interestGenres | 필수, 1개 이상, §4.1 genre, 중복 제거 |
| regions | 선택(빈 배열 허용), 최대 20개 |
| availableFrom/To | 선택. 둘 다 주거나 둘 다 null. from < to |
| experienceLevel | 선택, §4.1 |

전체 교체(PUT). 200 `Member`. 함께 듣고 싶은 연령대·세부 장르는 1회차 범위 밖이라 받지 않는다(모르는 칸은 422).

## 6. `PUT /api/me/base-genre` — 기준 장르(FR-022a)

`{ "baseGenre": "salsa_bachata" }` → 200 `Member`. 정확히 1개. 바꾸기도 같은 경로.

기준 장르가 없으면 홈 목록이 409 `BASE_GENRE_REQUIRED` 를 낸다(`02-catalog.md`) — AC-9 의 「고르기 전에는 홈 데이터를 주지 않는다」를 **API 에서** 막는다(화면만 막으면 우회된다).
