# API 계약 — 로그인·가입·취향 (US1-A1(가입·취향))

공통 규칙은 `README.md`. 관련 요구: FR-002(가입 정보 수집·고지) · FR-003(본인확인 계정 식별) · FR-022(사용자 프로필) · FR-022a(첫 화면 장르 선택·유지) · FR-019a(회원 닉네임 표시).

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
{ "verificationToken": "…", "noticeAcknowledged": true, "nickname": "서연",
  "consents": { "memberTerms": true, "memberPrivacyCollection": true, "academySharing": true, "age19Plus": true,
                "marketing": false, "location": false } }
```

`consents`(보드 C14A · M-01(동의 항목), 2026-11-23 S3-1.2 에서 더함): 여섯 칸 모두 boolean 필수. 앞 넷이 필수 동의, `marketing`·`location` 이 선택 동의다. 동의한 항목마다 `member_consents` 에 `source='signup'` 한 줄(동의 시각 = 서버 시각, 회원 약관 판본이 생기기 전(S7-3.1)이라 `terms_version_id` 는 NULL). 본문에 `name`·`gender`·`birthDate`·`phone` 같은 모르는 칸이 있으면 422 `VALIDATION_FAILED` — 그 넷은 본인확인 값으로만 채운다.

| 결과 | 응답 |
|---|---|
| 성공 | 201 `Member`(아래) |
| 이미 이 세션으로 가입 끝 | 200 같은 `Member` |
| `noticeAcknowledged` 가 true 아님 | 422 `VALIDATION_FAILED`(FR-002 고지 확인) |
| 필수 동의 넷 중 하나라도 false | 422 `CONSENT_REQUIRED`(`fields: [{"path":"consents.memberTerms", …}]`) — S3-1 수용 ① |
| 본인확인 결과에 이름·성별·생년·연락처 중 빈 값 | 422 `VALIDATION_FAILED`(`fields: verificationToken`) — AC-9(가입 정보) |
| `nickname` 이 없거나 규칙(아래) 위반 | 422 `VALIDATION_FAILED`(`fields: [{"path":"nickname", …}]`) |
| `nickname` 에 금칙어가 들어 있음 | 422 `NICKNAME_NOT_ALLOWED` |
| 토큰 무효·만료 | 422 `VALIDATION_FAILED` |
| 같은 CI 가 다른 계정에 있음 | 409 `IDENTITY_ALREADY_USED`(FR-003) |

**닉네임**(FR-019a · 데이터 §2-2 `members.nickname`): 강사·대표·다른 회원에게 보이는 이름은 닉네임뿐이다(본명은 내리지 않는다). 가입 때 한 번 받는다 — 본명을 써도 된다. 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인):

| 규칙 | 값 |
|---|---|
| 필수 | 예 — 비워 두면 본명으로 채우지 않는다(본명이 그대로 노출되는 것을 막는다). 422 `VALIDATION_FAILED` |
| 길이 | 앞뒤 공백을 자른 뒤 **2~12자**(글자 수 기준, 한글·영문·숫자·공백·`_`·`.` 만). 가운데 연속 공백은 한 칸으로 줄인다 |
| 중복 | **허용한다**(데이터 §15-4 ① — UNIQUE 없음). 같은 학원 명단에서 헷갈리는 것은 강사가 학원 안에서 풀 일이다 |
| 금칙어 | 서버 상수 `NICKNAME_BLOCKED_WORDS`(욕설·「운영자」·「관리자」·「kdance」 같은 사칭 단어) 부분 일치 → 422 `NICKNAME_NOT_ALLOWED`. 목록 내용은 구현 때 정한다 |
| 바꾸기 | **이 경로에서는 없다.** 한 번 정하면 못 바꾸고 멤버십 회원만 1년에 한 번 바꾼다(FR-019a). 바꾸는 경로는 S6-1(멤버십) 쪽이 정한다 — 칸 `nickname_changed_at` 만 예약돼 있다 |

나이·성별·연락처는 본인확인 결과에서 가져온다 — 앱이 따로 보내지 않는다. 셋 중 하나라도 비면 가입하지 않는다(AC-9(가입 정보)).

`Member`
```json
{ "id": "…", "name": "김회원", "nickname": "서연", "gender": "male", "birthDate": "1995-03-02", "phoneMasked": "010-****-5678",
  "profile": { "interestGenres": [], "regions": [], "availableFrom": null, "availableTo": null, "experienceLevel": null },
  "baseGenre": null, "baseSubGenre": null, "onboarding": { "profileDone": false, "baseGenreDone": false } }
```
- `baseSubGenre` — 기준 장르 안의 세부 장르(FR-022a, 2026-11-25 추가). `latin`·`standard`(댄스스포츠) · `salsa`·`bachata`(살사/바차타) · `null`(=「전체」). 기존 회원은 `null`

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

`{ "baseGenre": "salsa_bachata", "baseSubGenre": "bachata" }` → 200 `Member`. 정확히 1개. 바꾸기도 같은 경로(홈의 「장르 바꾸기」도 이 경로).

| 칸 | 규칙 |
|---|---|
| `baseGenre` | 필수. 장르 4종 중 하나(배열·빈 값·null 은 422) |
| `baseSubGenre` | 선택(2026-11-25 추가). 빼거나 `null` 이면 「전체」로 저장한다. `dance_sport` → `latin`·`standard`, `salsa_bachata` → `salsa`·`bachata` 만. 탱고·스윙은 세부 장르가 없어 `null` 만 받는다 |
| 짝 안 맞음 | 422 `VALIDATION_FAILED`, `fields: [{ path: "baseSubGenre" }]` — 예: `argentine_tango` + `latin`. 저장값은 그대로. DB 도 CHECK `ck_members_base_sub_genre` 로 한 번 더 막는다 |
| 덮어쓰기 | 저장할 때마다 두 칸을 함께 덮어쓴다 — 탱고로 바꾸면 예전 세부 장르가 남지 않고 `null` 이 된다 |

기준 장르가 없으면 홈 목록이 409 `BASE_GENRE_REQUIRED` 를 낸다(`02-catalog.md`) — AC-9 의 「고르기 전에는 홈 데이터를 주지 않는다」를 **API 에서** 막는다(화면만 막으면 우회된다).

## 열린 점 (2026-11-20 닉네임 입력 보강)

근거가 없는 값은 임시 확정(2026-11-20 — 추천안으로 진행, 사후 확인)이다.

| # | 무엇 | 결정 |
|---|---|---|
| ① | 보드 M3(가입 정보)에 **닉네임 입력칸이 없다**(글자: 성별·연락처·대학생·학교 이메일뿐). spec FR-019a 는 닉네임이 가입 때 정해진다고만 한다 | 보드 M3 에 「닉네임」 칸을 더하고(추천: 성별 위, 설명 「강사·대표·다른 회원에게는 닉네임만 보여요. 본명을 써도 돼요」, 한 줄 입력) spec FR-002 의 M3 화면 문단에 한 문장을 더한다. 이 파일은 칸이 있다고 보고 `nickname` 을 필수로 받는다. **반영(2026-11-23, S3-1.8(앱 가입·동의·취향 화면 보정))**: 보드 M3 성별 위에 칸을 더했고 spec FR-002 의 M3 화면 문단에 문장을 넣었다 |
| ② | 길이 2~12자·허용 문자·금칙어는 spec·보드 어디에도 값이 없다 | 위 표의 값(추천). 바꾸려면 상수 `NICKNAME_MIN`·`NICKNAME_MAX`·`NICKNAME_BLOCKED_WORDS` 한 곳만 고친다 |
| ③ | 탈퇴 때 닉네임 처리(D18 — 이름·연락처·취향·계좌 즉시 익명화) | 닉네임도 익명화 대상으로 본다(추천, 15 의 탈퇴 경로와 조율) |
| ④ | 가입 요청에 동의 칸이 없었다 — S3-1 수용 ①(필수 4항목 중 하나라도 빠지면 가입이 끝나지 않는다)을 API 에서 막을 자리가 없었다 | `consents` 여섯 칸(boolean)과 422 `CONSENT_REQUIRED` 를 더했다(강사 가입 11 §1-3 의 `consents` 와 같은 방식). 임시 확정(2026-11-23 — S3-1.2 구현 때 추천안으로 진행, 사후 확인) |
| ⑤ | 금칙어 목록 내용 | `admin-web/lib/domain/member-nickname.ts` 의 `NICKNAME_BLOCKED_WORDS` — 사칭(운영자·관리자·운영팀·고객센터·kdance·k-dance·admin)과 흔한 욕설. 영문 대소문자와 공백·`_`·`.` 끼운 우회는 잡고, 자모 풀어쓰기 우회는 잡지 않는다(신고·운영 몫). 임시 확정(2026-11-23, 사후 확인) |
