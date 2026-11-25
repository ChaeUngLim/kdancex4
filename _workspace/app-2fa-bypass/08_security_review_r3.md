# 08 보안 최종 리뷰(r3) — R2-C1 수정분 (2026-11-25)

대상: `07_bug-fixer_fixes.md` 「2차」 · `staff-app-sign-in.ts`(앞단 훅: `ctx.getSignedCookie` + `bearerToken`, `appCallerSession`·`rejectAppCaller`) · `staff-auth.ts`(databaseHooks user·account·session) · 테스트.
방법: 설치본 better-auth 1.7.5(`api/routes/session.mjs`·`plugins/bearer/index.mjs`·`plugins/two-factor/**`·`db/with-hooks.mjs`)와 better-call(`context.mjs`·`cookies.mjs`)을 대조했다. 공격을 직접 돌려 보지는 않았다. 수정자의 RED·층별 로그(`07_red_r2.log`·`07_layer2_only.log`)가 있다는 것은 확인했고, 내용은 기록을 근거로 삼았다.

## 최종 판정: PASS

CRITICAL·HIGH 없음. 아래 LOW 2건은 권고이고, 막는 사유는 아니다.

---

## ① 토큰 해석이 Better Auth 와 어긋나는 입력이 남는가 — 남지 않는다

| 입력 | Better Auth | 앞단 훅 | 결과 |
|---|---|---|---|
| 쿠키(따옴표·퍼센트 인코딩·서명 분리) | `getSession` 이 `ctx.getSignedCookie(authCookies.sessionToken.name, secret)` 로 읽는다(`session.mjs:40`) | **같은 함수, 같은 인자** | 같다 |
| 같은 이름 쿠키 여럿 | `parseCookies` 첫 값만(`cookies.mjs:32`) | 같은 함수라 첫 값 | 같다 |
| `__Secure-` 접두사·쿠키 이름 설정값 | `authCookies.sessionToken.name`(접두사 포함 최종 이름) | 같은 값 | 같다. 접두사 없는 이름을 따로 받아 주는 대체 경로도 없다 |
| Bearer 비서명(점 없음) | bearer 플러그인이 서명해 쿠키로 바꾼다 → 토큰 = 원문 | 원문 그대로 후보 | 같다 |
| Bearer 서명(점 있음, `%` 면 한 번 디코드) | HMAC 이 맞을 때만 쿠키로 바꾸고, 이후 `getSignedCookie` 가 마지막 점에서 나눈다 | 같은 디코드 + 마지막 점 분리, 서명은 안 따지고 후보에 넣음(더 넓다) | 같거나 더 넓다 |
| Bearer 와 쿠키를 같이 보냄 | 둘 중 하나를 쓴다(bearer 가 바꿔 넣은 쿠키, 또는 원래 쿠키) | 둘 다 후보 | 어느 쪽이든 걸린다 |
| `Bearer`·`bearer` 대소문자, 앞뒤 공백 | `slice(0,7).toLowerCase()`·`trim()` | 같은 식 | 같다 |
| Authorization 머리글이 여러 개(`, ` 로 합쳐짐) | 합친 문자열 그대로 → 세션을 못 찾는다 | 같은 문자열 | 둘 다 세션 없음 |
| 서명이 틀린 쿠키 | `false` → 세션 없음 | `false` 는 걸러서 후보에서 빠짐 | 둘 다 세션 없음 |

「토큰을 못 찾으면 통과」는 앞단에 남아 있다. 이제 앞단의 해석이 Better Auth 와 같거나 더 넓기 때문에, 「우리는 못 찾는데 Better Auth 는 찾는」 입력을 찾지 못했다. 앞단 DB 조회가 실패하면 예외로 요청이 끊긴다(닫힘). 경로 우회(대소문자·끝 슬래시·인코딩)가 안 되는 것은 r2 와 같다.

## ② twoFactor 표를 앞단 훅만으로 지키는 것이 충분한가 — 지금은 충분하다(LOW 권고 1)

이미 인증 앱을 켠 계정에서 앱 세션으로 twoFactor 표에 닿는 길은 셋이다.
- `/two-factor/enable`: 이미 확인된 행이 있으면 갱신 전에 `TOTP_ALREADY_ENABLED` 로 끝난다(`index.mjs:132`). 표가 바뀌지 않는다.
- `/two-factor/disable`: 표를 지우기 전에 `user update`(twoFactorEnabled=false)를 먼저 한다 → 데이터 쪽 훅이 막는다. 층별 로그가 앞단 훅 없이도 막힘을 보였다.
- `/two-factor/get-totp-uri`: **읽기**다. 세션과 비밀번호만 있으면 인증 앱 비밀값(otpauth URI)을 돌려준다(`totp/index.mjs:90-130`). 앞단이 뚫리면 공격자가 진짜 대표의 6자리를 계속 만들어 관리자 웹 콘솔에 들어간다. 이 경로는 데이터 쪽 훅이 닿지 않고 앞단 훅만 지킨다. 테스트는 403 을 확인한다(`staff-app-sign-in.db.test.ts:254`). 앞단 해석이 ①처럼 맞춰졌으니 지금은 열리지 않는다. → **LOW-1**

아직 인증 앱을 켜지 않은 계정에서 앱 세션으로 enable → verify-totp 하는 길:
- 앞단 훅이 enable·verify-totp 를 403 으로 막는다.
- 앞단이 뚫려도 verify-totp 가 `user update`(twoFactorEnabled=true)에서 데이터 쪽 훅에 막힌다. `verifyTwoFactor` → `getSessionFromCtx` 가 `ctx.context.session` 을 채운다(`session.mjs:274`).
- 어차피 이 계정들은 비밀번호만으로 관리자 웹 `/sign-in/username` 세션을 받아 첫 등록을 할 수 있다. 이건 이번 변경 전부터 있던 구조(「첫 등록은 비밀번호로」)다. 앱 경로가 새로 여는 것은 없다. 범위 밖이고, 필요하면 별도 결정(초대 시 등록 강제 등)이다.

## ③ session delete 「자기 세션만」 판정이 우회되는가 — 우회되지 않는다

- 단건 삭제(`deleteWithHooks`)는 where 로 실제 행을 먼저 찾아 그 행을 훅에 넘긴다(`with-hooks.mjs`). `row.token` 은 요청 본문이 아니라 DB 값이다.
- 여러 건 삭제(`deleteManyWithHooks`, `revoke-sessions`·`revoke-other-sessions`)는 지울 행 하나하나마다 훅을 부른다. 내 것이 아닌 행이 하나라도 있으면 403 이다.
- 비교 대상 `caller.token` 은 Better Auth 가 이번 요청에서 실제로 쓴 세션(`ctx.context.session.session`)이다. 우리가 따로 해석한 값이 아니다.
- 앱 세션이 지울 수 있는 것은 자기 세션뿐이다(로그아웃·만료 정리). 남의 세션을 끊어 진짜 대표를 쫓아낼 수 없다.

## ④ 새 문제

- **LOW-1**: `/two-factor/get-totp-uri` 를 지키는 층이 하나뿐이다(위 ②). 관리자 웹 화면은 이 경로를 쓰지 않는다(`lib`·`app` grep 0건). `STAFF_DISABLED_AUTH_PATHS` 에 넣어 404 로 아예 없애면, 앞단 해석이 앞으로 어긋나도 비밀값이 새지 않는다. 등록 화면이 enable 응답의 `totpURI` 만 쓰는지 확인한 뒤 넣으면 된다.
- **LOW-2**: 데이터 쪽 훅은 `ctx.context.session` 이 채워진 엔드포인트에서만 앱 세션을 알아본다. 지금 설치본에서 계정 값을 바꾸는 세션 경로는 모두 세션 미들웨어나 `getSessionFromCtx` 를 거쳐 채워진다. 하지만 Better Auth 를 올릴 때는 다시 확인해야 한다. 버전을 올리면 `staff-app-sign-in.db.test.ts` 와 층별 확인(앞단 훅을 끈 실행)을 다시 돌리라고 ADR-007 에 한 줄 적어 두기를 권한다.
- 참고: 데이터 쪽 훅이 앱 세션을 막는 경로 가운데 앱이 정상적으로 쓰는 경로(get-session 갱신은 session update 라 걸리지 않음, sign-out 은 자기 세션 삭제)는 없다. 앱 기능이 깨지는 곳은 찾지 못했다.
- 지난 리뷰의 M1(IP 헤더 신뢰)·M2(잠금 악용)·L2(회원 응답 시간 차)는 그대로 남아 있다. 사용자 결정 대상이라 판정에 넣지 않았다.
