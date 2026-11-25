# 08 보안 리뷰 — 앱 로그인 2단계 생략 (2026-11-25)

검토 범위: `admin-web/lib/server/staff-app-sign-in.ts`(신규) · `staff-auth.ts` · `staff-auth-instance.ts` · `rate-limit.ts` · `guards.ts` · `console-route.ts` · `proxy.ts` · `tests/db/staff-app-sign-in.db.test.ts` · `mobile/lib/instructor/staff-api.ts` · 계약 README §6-1·§6-2·§6-4 · 설치본 `better-auth` 1.7.5(`plugins/two-factor/index.mjs`·`totp/index.mjs`·`db/internal-adapter.mjs`·`db/schema.mjs`) · `better-call` 라우터.
방법: 코드 읽기로 흐름을 따라갔다. **아래 CRITICAL 공격 순서는 설치본 소스로 단계마다 확인했지만 실제로 돌려 보지는 않았다**(코드 수정 금지 지시라 재현 테스트 파일을 만들지 않음).
전제: 「비밀번호만 알면 앱에서 회원 정보를 본다」는 사용자가 받아들인 정책이라 지적하지 않는다. 의도보다 더 열린 곳만 본다.

## 최종 판정: CHANGES_NEEDED

---

## CRITICAL

### C1. 앱 토큰으로 인증 앱을 지우고 다시 등록하면 관리자 웹 콘솔이 열린다 (비밀번호만으로 2단계 우회)
의도는 「2단계는 관리자 웹 콘솔에만 남는다」인데, 앱 경로 세션이 Better Auth 의 2단계 관리 경로를 그대로 쓸 수 있어 비밀번호만으로 콘솔까지 간다.

공격 순서(비밀번호를 아는 사람, 인증 앱을 켠 대표 계정):
1. `POST /api/auth/sign-in/staff-app` → 토큰(세션 `secondFactorVerified=false`)
2. `POST /api/auth/two-factor/disable` `{password}` + `Authorization: Bearer <토큰>`
   - `sensitiveSessionMiddleware` 는 세션 존재만 본다(설치본 `api/routes/session.mjs:304`). 비밀번호는 공격자가 안다.
   - `twoFactorEnabled=false`, `twoFactor` 행 삭제, 새 세션 발급(`index.mjs:217-232`). `STAFF_DISABLED_AUTH_PATHS` 에 이 경로는 없다.
3. `POST /api/auth/two-factor/enable` `{password}` + Bearer(새 토큰) → 기존 행이 없으니 공격자용 `totpURI` 를 돌려준다(`index.mjs:125-175`).
4. `POST /api/auth/two-factor/verify-totp` `{code}` + Bearer → 세션이 있는 「등록」 흐름이라 잠금·시도 제한 없이 확인하고 `twoFactorEnabled=true` 로 바꾼 뒤 `createSession` 을 부른다(`totp/index.mjs:205-210`).
5. 그 `createSession` 은 경로가 `/two-factor/verify-totp` 라 `staff-auth.ts` 세션 훅의 일반 분기로 가고, 계정 값이 이제 true 라 **`secondFactorVerified=true`** 로 적힌다. 세션 쿠키도 응답에 실린다(`setSessionCookie`, bearer 플러그인이면 `set-auth-token` 도).
6. 그 토큰(Bearer 또는 쿠키)으로 `consoleRoute` 웹 전용 경로를 부르면 `isSecondFactorVerified` 가 참 → **콘솔 열림**. 진짜 대표의 인증 앱은 무효가 되고(행 교체), 2단계 통제가 공격자에게 넘어간다.

변경 전에는 막혀 있던 길이다. 인증 앱을 켠 계정은 `/sign-in/username` 에서 세션이 곧바로 지워져(after 훅) 2~4단계를 부를 세션 자체를 얻을 수 없었다. 새 엔드포인트가 이 계정들에게 「2단계 전 세션」을 처음으로 준다.

테스트 ③ 은 「발급 직후 토큰」만 콘솔에 넣어 본다. 2단계 관리 경로를 거친 뒤의 토큰은 검사하지 않는다.

고치는 방향(구현은 구현자 몫):
- 앱 경로 세션을 이름표로 구분한다. 예: 세션 추가 칸 `issuedVia: "app"`(`input: false`). 경로 비교가 아니라 엔드포인트가 직접 적는다(L1 참고).
- `staffAuthBeforeHook` 에서 그 이름표가 붙은 세션이 `/two-factor/enable`·`/two-factor/disable`·`/two-factor/verify-totp`·`/two-factor/get-totp-uri`(설치본에 있으면) 같은 2단계 관리 경로를 부르면 403 으로 거절한다. 등록 전 웹 세션의 정상 등록 흐름(W1b2)은 이름표가 없으니 그대로 둔다.
- 회귀 테스트: 앱 토큰 → disable → enable → verify-totp 순서가 실패하는지, 진행 중에 `twoFactorEnabled` 가 바뀌지 않는지 확인한다.

## HIGH

### H1. 앱 토큰으로 비밀번호 바꾸기·세션 끊기·계정 정보 고치기가 된다 (인증 앱 켠 계정 탈취)
`/change-password`(`revokeOtherSessions: true` 가능)·`/revoke-sessions`·`/revoke-other-sessions`·`/update-user`(`/change-email`·`/delete-user` 는 설정에 따라)가 Bearer 세션만 있으면 열린다. 비밀번호를 아는 공격자가 앱 토큰으로 비밀번호를 바꾸고 다른 세션을 모두 끊으면, 진짜 대표는 인증 앱이 있어도 로그인하지 못한다(1단계에서 막힌다).
변경 전에는 인증 앱 켠 계정에 6자리 없이 세션이 생기지 않아 이 길도 없었다. 「앱에서 회원 정보 보기」를 받아들인 결정이 「계정 소유권을 넘겨받기」까지 받아들인 것은 아니다. C1 과 같은 이름표로 이 경로들도 앱 세션에서 막는다. 앱 화면에 비밀번호 바꾸기가 필요하면 그때 따로 연다.

## MEDIUM

### M1. IP 칸이 x-forwarded-for 첫 값을 그대로 믿는다
`clientIp()` 가 `x-forwarded-for` 첫 값(없으면 `x-real-ip`)을 쓴다. 앞단 프록시가 이 헤더를 덮어쓰지 않으면 요청마다 값을 바꿔 IP 칸 제한(15분 5회)을 피한다. 여러 아이디에 흔한 비밀번호 하나씩 넣는 대입(password spraying)이 아이디당 4회까지 IP 제한 없이 간다. 아이디 칸 제한은 그대로라 한 계정 집중 대입은 막힌다. Better Auth 기본 제한(10초 3회)도 같은 헤더(`getIP`)를 읽으므로 같이 풀린다.
배포 앞단이 정해지면 그 헤더 하나(예: 프록시가 덮어쓰는 마지막 hop)만 믿게 하거나 `advanced.ipAddress.ipAddressHeaders` 와 맞춘다. owner-signup.ts 의 같은 규칙도 같은 문제를 가진다(기존 문제).

### M2. 아이디 칸 잠금으로 남의 앱 로그인을 막을 수 있다 (가용성)
`account:<username>` 칸은 아이디만 알면 누구나 채운다. 15분마다 5회 틀리면 그 대표의 앱 로그인이 계속 429 가 된다. 맞는 비밀번호도 막는 설계라 피할 길이 없다. 계약 §6-4 가 정한 규칙 그대로라 버그는 아니지만, 앱 로그인은 비밀번호가 유일한 관문이라 영향이 크다. 운영 전에 「잠김 알림」이나 「성공 이력이 있는 기기·IP 예외」 같은 완화책을 정할지 사용자 결정이 필요하다.

## LOW

### L1. 세션 훅의 앱 분기가 「경로가 다르면 열리는 쪽」이다 (지금은 우회 불가, 깨지기 쉬움)
- 우회 여부: `better-call` 라우터는 끝 슬래시를 404 로 거절하고(`router.mjs:44`), 경로 매칭은 대소문자를 구분하며(대문자는 404), 쿼리는 `pathname` 에 들어가지 않는다. basePath 를 떼고 남은 값이 `ctx.path` 이고, 엔드포인트를 서버에서 직접 부르면 `endpoint.path` 가 들어간다. **지금 구조에서 `/sign-in/staff-app` 엔드포인트가 다른 `ctx.path` 로 실행되는 길은 찾지 못했다.**
- 그래도 분기가 어긋나면(경로 이름 변경, 엔드포인트 문맥이 없는 호출, 라이브러리 내부 변경) 일반 분기로 떨어진다. 그러면 인증 앱 켠 계정에 `true` 가 찍혀 콘솔이 곧바로 열린다. 엔드포인트가 세션을 만들 때 직접 이름표를 넘기고, 훅은 그 이름표를 우선하는 「막는 쪽」 구조가 낫다(C1 의 이름표와 같이 쓰면 된다).

### L2. 회원 계정 응답 시간 차
`findCredentialAccount` 가 없거나 비밀번호 칸이 비면 해시를 돌리지 않고 곧바로 401 이다. 없는 아이디는 해시 한 번만큼 늦다. 회원이 `username` 을 갖고 비밀번호 계정이 없다면 응답 시간으로 「있는 아이디」를 가늠할 수 있다. 회원에게 username 이 없으면 해당 없다. 확인하지 못했다. 고치기는 쉽다(그 분기에서도 `password.hash` 한 번).

### L3. 테스트 ③ 쿠키 부분이 다른 이유로 통과한다
`cookie: <이름>=<토큰>` 을 서명 없이 넣는다. Better Auth 세션 쿠키는 서명값이라 세션을 못 읽고 401 `UNAUTHENTICATED` 가 난다. 테스트는 상태 401 만 본다. 코드로 따라가면 서명된 쿠키여도 같은 세션이라 `SECOND_FACTOR_REQUIRED` 로 막힌다. 판정은 맞지만 테스트가 그것을 증명하지는 못한다. `code` 까지 확인하고 서명 쿠키(`setSignedCookie` 값)를 쓰도록 바꾸기를 권한다.

### L4. 앱 토큰으로 `/list-sessions` 가 웹 세션의 IP·브라우저 정보를 보여 준다
앱 접근을 받아들인 범위의 정보 노출이라 낮게 둔다. H1 을 막을 때 같이 정리하면 된다.

---

## 중점 항목별 판정

| # | 항목 | 판정 |
|---|---|---|
| 1 | 앱 세션 → 관리자 웹 콘솔 | 발급 직후 토큰은 Bearer·쿠키 모두 막힌다(쿠키 미설정 확인, `secondFactorVerified=false`, `/update-session` 은 `input:false` 라 400 `FIELD_NOT_ALLOWED`, 세션 갱신은 create 훅을 다시 타지 않아 값이 그대로다). **단 2단계 관리 경로를 거치면 열린다 → C1** |
| 2 | 경로 문자열 비교 우회 | 대소문자·끝 슬래시·쿼리·basePath 로는 우회하지 못한다. 실패하면 열리는 쪽 구조 → L1 |
| 3 | 계정 열거·회원·탈퇴·정지 | 없는 아이디와 틀린 비밀번호는 같은 401 본문이고, 해시로 시간을 맞춘다. 직원 여부(403)는 비밀번호가 맞은 뒤에만 보인다. 403 에서는 세션을 만들지 않는다(세션 생성보다 앞에서 던진다). 회원 계정 시간 차 가능성 → L2 |
| 4 | 무차별 대입 | Redis 실패 시 막는 쪽(429)이 맞다(`rate-limit.ts run()`). 시도 전 확인과 실패 기록 모두 오류를 그대로 던진다. 키는 소문자 아이디와 IP, Redis 에는 해시로 들어간다. IP 헤더 신뢰 → M1, 잠금 악용 → M2 |
| 5 | CSRF·Origin | 쿠키를 읽지도 심지도 않는다(`setNewSession` 을 부르지 않아 after 훅 쿠키도 없다). CORS 는 개발 스위치일 때 `localhost:8081` 하나뿐이고 자격 증명은 허용하지 않는다 → 다른 사이트가 토큰을 읽거나 로그인 CSRF 를 하는 길이 없다. 문제 없음 |
| 6 | 기존 `/sign-in/username`·2단계 플러그인 | 바뀌지 않았다. after 훅 matcher 는 세 경로 정확 일치 그대로이고, 일반 세션 훅 분기와 막아 둔 경로 목록도 그대로다. 기존 웹 로그인에 Redis 제한이 없다는 점은 구현자가 이미 적었다(기존 문제, 이번 범위 밖) |

`mobile/lib/instructor/staff-api.ts`: 새 경로로 바꾸고 2단계 분기를 지운 것뿐이다. 보안상 문제는 찾지 못했다.
