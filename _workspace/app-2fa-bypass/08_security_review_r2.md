# 08 보안 재리뷰(r2) — C1·H1·L1·L3 수정분 (2026-11-25)

대상: `07_bug-fixer_fixes.md` 의 수정. `staff-app-sign-in.ts`(이름표·허용 목록 before 훅) · `staff-auth.ts`(세션 훅) · `guards.ts`(`isSecondFactorVerified`) · 테스트.
방법: 코드와 설치본 Better Auth 1.7.5 · better-call 소스를 대조했다. 쿠키 해석 차이(R2-C1)는 설치본 `parseCookies` 와 우리 추출 로직을 같은 입력에 넣어 돌려 확인했다(스크래치 스크립트, 저장소 밖). 전체 공격 순서는 돌려 보지 않았다.

## 최종 판정: CHANGES_NEEDED

방향(이름표 + 허용 목록 + 세션 상속 + 가드 이중 확인)은 맞다. 다만 허용 목록 훅이 세션 토큰을 Better Auth 와 **다르게** 읽어서, 따옴표로 감싼 쿠키 하나로 훅을 건너뛸 수 있다. 그러면 C1·H1 이 다시 열린다.

---

## CRITICAL

### R2-C1. 따옴표로 감싼 세션 쿠키로 허용 목록 훅을 건너뛴다 → 인증 앱 교체·비밀번호 변경 → 관리자 웹 콘솔
- 우리 추출(`presentedSessionTokens`): 쿠키 값을 `decodeURIComponent` 한 뒤 `split(".")[0]` 한다. 따옴표를 떼지 않는다.
- Better Auth(better-call `parseCookies`, `cookies.mjs:33`): 값이 `"` 로 시작하면 **앞뒤 따옴표를 떼고** 디코드한다. 서명 분리는 `lastIndexOf(".")` 로 한다.
- 실측(같은 입력): `better-auth.session_token="TOKEN.<서명>"` → 우리 `['"TOKEN']`(DB 에 없음 → `carriesAppSession` false → 통과) / Better Auth `TOKEN`(서명 확인 뒤 정상 세션).

공격에 필요한 것은 서명된 쿠키 값 `TOKEN.<서명>` 이다. 앱 로그인 응답은 날 토큰만 주지만 얻을 길이 있다. 허용 목록에 있는 `GET /api/auth/get-session` 을 Bearer 로 부르면, 세션이 `updateAge`(기본 1일)를 넘은 경우 갱신하면서 `setSessionCookie` 를 부른다(`api/routes/session.mjs:211`). 응답의 `set-cookie` 와 bearer 플러그인의 `set-auth-token` 에 서명된 값이 그대로 실린다. 하루 지난 앱 토큰이면 누구나 얻는다.

그다음 순서는 이렇다.
1. `Cookie: <세션쿠키이름>="TOKEN.<서명>"`(Origin 은 curl 로 baseURL 을 넣으면 된다)를 싣고 `/two-factor/disable {password}` → 훅 통과 → 인증 앱 삭제
2. 같은 방식으로 `/two-factor/enable` → `/two-factor/verify-totp` → 공격자 인증 앱으로 교체
   - 이때 새 세션은 세션 훅 ③(요청 세션 상속) 때문에 `appSession=true` 로 남고, 가드 이중 확인이 있어 **이 세션으로는 콘솔이 안 열린다** — 이중 방어는 제대로 돈다.
3. 그런데 계정의 인증 앱이 이미 공격자 것이다. 공격자는 관리자 웹에서 `/sign-in/username` + 자기 6자리로 정상 로그인해 2단계를 마친 웹 세션을 받는다 → **콘솔 열림**. 진짜 대표의 인증 앱은 무효가 된다.
4. 같은 우회로 `/change-password`·`/revoke-sessions` 도 부를 수 있다(H1 재발).

고치는 방향:
- 훅이 Better Auth 와 **같은 함수**로 토큰을 읽게 한다. 쿠키는 better-call `parseCookies`(설치본에서 export 됨) 결과에서 세션 쿠키를 꺼내 `lastIndexOf(".")` 로 나눈다. Bearer 는 bearer 플러그인과 같은 규칙(`slice(0,7)` 소문자 비교, `.`·`%` 처리)을 쓴다. 또는 훅 안에서 `ctx.getSignedCookie(name, secret)` 를 쓴다.
- 해석을 맞추는 것만으로는 다음 차이에 또 열릴 수 있다. **데이터 쪽 길목에서도 한 번 더 막기**를 권한다. 예: `databaseHooks.user.update.before`·`account.update.before`(비밀번호)·`twoFactor` 행 변경 앞에서 「지금 요청 세션(ctx.context.session)이 앱 세션이면 거절」. 세션 훅 ③ 이 이미 `ctx.context.session` 을 읽으니 같은 방식이다. 이렇게 하면 경로·쿠키 해석과 상관없이 계정·2단계 값이 앱 세션으로는 바뀌지 않는다.
- 회귀 테스트: 따옴표 쿠키, 쿠키와 Bearer 동시, 퍼센트 인코딩 쿠키로 `/two-factor/disable` 이 403 인지 확인한다.

---

## 요청 항목별

| # | 질문 | 판정 |
|---|---|---|
| ① 허용 목록 훅 우회 | 쿠키+Bearer 동시 | 막힌다. 둘 다 모아서 하나라도 앱 세션이면 403 |
| | 조회 실패 | DB 오류는 예외가 그대로 나가 요청이 실패한다(닫힘). 토큰을 못 찾으면 「앱 세션 아님」으로 **연다**. 그래서 Better Auth 와 해석이 어긋나는 형식이 곧 우회다 → R2-C1(따옴표). 퍼센트 인코딩은 우리가 한 번 디코드하고 Better Auth 도 한 번 디코드해 같다. 이중 인코딩은 둘 다 실제 토큰에 닿지 않는다. 같은 이름 쿠키가 여럿이면 Better Auth 는 첫 값만 쓰고 우리는 전부 보니 안전한 쪽이다. Bearer 해석은 bearer 플러그인과 같다 |
| | 대소문자·끝 슬래시·인코딩 경로 | 우회 안 된다. 라우터가 끝 슬래시를 404 로 거절하고(`router.mjs:44`), 대소문자가 다르거나 `%2F` 가 섞이면 경로를 찾지 못해 404 다. 훅 matcher 는 실제로 매칭된 경로 문자열(허용 5개 정확 일치)이라, 허용 목록에 없는 실제 경로는 전부 검사를 받는다 |
| ② 웹 1단계 세션으로 같은 공격 | 2단계를 켠 계정 | 안 된다. `/sign-in/username` after 훅이 세션을 지운다. 기억 쿠키 경로는 이미 6자리를 거친 기기뿐이다 |
| | 2단계를 아직 안 켠 계정 | 비밀번호만으로 웹 세션 → 공격자 인증 앱 등록이 된다. 이번 변경 전부터 있던 「첫 등록은 비밀번호로」 구조라 이번 범위 밖이다(참고) |
| ③ 정상 웹 등록 흐름 | | 잘못 걸리지 않는다. 웹 세션의 `appSession` 은 기본값 false 이고, `createSession(…, activeSession)` 도 `overrideAll` 이 없어 기본값이 다시 덮어 false 로 남는다. 경로도 앱 로그인이 아니고, 요청 세션도 앱 세션이 아니므로 세션 훅 일반 분기 → verify-totp 뒤 true. 테스트에 회귀 항목이 있다 |
| 가드 이중 확인 | | 맞다. `appSession !== true` 가 더해져 앱 세션은 어떤 길로 만들어져도 `web` 판정을 통과하지 못한다. `/update-session` 으로 `appSession` 을 false 로 바꾸는 길도 없다 — `input:false` 칸이라 `FIELD_NOT_ALLOWED`. 다만 이 경로 자체가 허용 목록 밖이라 먼저 403 이다 |
| L1 | | 해결. 엔드포인트가 `overrideAll=true` 로 이름표를 직접 넘기고, 세션 훅은 셋 중 하나만 맞아도 앱 세션으로 본다(막는 쪽) |
| L3 | | 해결. 서명된 쿠키 + `code` 확인 |

## ④ 새로 생긴 것

- **R2-C1**(위).
- LOW: 허용 목록 훅이 세션 토큰이 실린 모든 `/api/auth/**` 요청(허용 5개 제외)마다 DB 를 한 번 더 읽는다. 색인이 걸린 `token` 조회라 부담은 작다. 성능 문제는 아니고 기록만 한다.
- LOW: 허용 목록의 `/sign-out` 은 앱 세션이 자기 세션을 지우는 일만 한다. 남의 세션에는 영향이 없다. 문제없다.
- 지난 리뷰의 M1(IP 헤더 신뢰)·M2(잠금 악용)·L2(회원 응답 시간 차)는 그대로 남아 있다. 사용자 결정 대상이라 이번 판정에 넣지 않았다.
