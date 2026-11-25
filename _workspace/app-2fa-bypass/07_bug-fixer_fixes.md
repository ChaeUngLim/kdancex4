# 07 오류 수정 — 보안 리뷰(08) C1·H1·L1·L3 반영 (2026-11-25)

## RED 먼저 확인
고치기 전에 C1 재현 테스트가 실패했다: 앱 토큰 → `/two-factor/disable` → `/two-factor/enable` → `/two-factor/verify-totp` 를 밟은 뒤
웹 전용 콘솔 경로가 **200**(기대 401) — 리뷰의 공격이 실제로 된다는 뜻이다. 로그: `_workspace/app-2fa-bypass/07_red_c1.log`(22행 `expected 200 to be 401`).
같은 실행에서 H1(경로 403)·서명 쿠키 403·회귀(appSession 칸 없음)도 실패했다(4 failed / 9 passed).

## 고친 것
| 지적 | 고친 방법 |
|---|---|
| C1·H1 | 앱 세션에 이름표 칸 `appSession`(boolean, `input:false`, 기본 false)을 더하고 앱 로그인 엔드포인트가 `createSession(..., { appSession: true }, overrideAll=true)` 로 직접 적는다. 플러그인 before 훅이 **허용 목록**(`/get-session`·`/sign-out`·`/ok`·`/error`·`/sign-in/staff-app`) 밖 경로에서 요청이 앱 세션을 들고 왔으면(Bearer 머리글·세션 쿠키 둘 다 확인, DB 조회) 403 `{code:"APP_SESSION_FORBIDDEN", detail, message}`. 막는 목록이 아니라 허용 목록이라 설치본 1.7.5 의 경로 40개(change-email·delete-user·list-sessions·revoke-session·unlink-account·two-factor/* 등)와 앞으로 생길 경로가 모두 막힌다. `set-password` 는 설치본에서 HTTP 경로가 아니다(서버 함수만) |
| L1 | 세션 훅을 이름표 우선의 막는 쪽으로: ① 넘겨받은 이름표 ② 요청 경로가 앱 로그인 ③ 요청을 보낸 세션이 앱 세션 — 하나라도 맞으면 `appSession=true`·`secondFactorVerified=false` 로 못 박는다(③ 때문에 앱 세션이 어떤 길로든 만든 새 세션도 앱 세션). 가드 `isSecondFactorVerified` 도 `appSession !== true` 를 한 번 더 본다 |
| L3 | 테스트 ③ 의 쿠키를 `serializeSignedCookie` 로 만든 **서명된 세션 쿠키**로 바꾸고 `code: SECOND_FACTOR_REQUIRED` 까지 확인 |
| M1·M2·L2·L4 | 지시대로 고치지 않음(M1·M2 는 사용자 결정 필요). L4(list-sessions)는 H1 허용 목록으로 함께 막혔다 |

설계 메모: bearer 플러그인이 머리글을 쿠키로 바꾼 결과는 다음 before 훅에 넘어가지 않는다(설치본 `api/dispatch.mjs` runBeforeHooks — 원래 context 를 넘김). 그래서 훅에서 Better Auth 세션 읽기 함수를 못 쓰고 토큰으로 `auth.session` 을 직접 읽는다. 서명은 따지지 않는다 — 막기만 하는 판정이라 남의 토큰을 들고 와도 「막힘」으로 끝난다.

## 바꾼 파일
- `admin-web/lib/server/staff-app-sign-in.ts` — 이름표·허용 목록·before 훅·세션 생성에 이름표
- `admin-web/lib/server/staff-auth.ts` — 세션 추가 칸 `appSession`, 세션 훅 막는 쪽 분기, `APP_SESSION_FIELD` 재수출
- `admin-web/lib/server/guards.ts` — `AuthSession.session.appSession`, `isSecondFactorVerified` 에 ③ 조건
- `admin-web/tests/db/staff-app-sign-in.db.test.ts` — C1 전체 흐름, H1 24개 경로(POST 21 + GET 3) 403, 서명 쿠키 403, 웹 정상 등록 회귀, ③ 서명 쿠키
- `mobile/lib/instructor/staff-api.ts` — 머리 주석 경로만(지난번 남은 옛 경로 표기)
- `CLAUDE-decisions.md` ADR-007 · `_workspace/03_contracts/README.md` §6-1 앱 로그인 표에 「앱 세션 제한」 한 줄

## 개발 DB · 서버
- 개발 DB `kdance_next` 의 `auth.session` 에 `appSession` 칸을 Better Auth `getMigrations` 로 더했다(기존 dev-demo-owner.ts 와 같은 방식, 추가할 것은 이 칸 하나뿐임을 출력으로 확인). 데이터는 지우지 않았다. 임시 스크립트는 지웠다
- `:3000` 을 지정 명령으로 재시작했다. 실서버 확인: `brad` 로 `/api/auth/sign-in/staff-app` 200 + 토큰 → 같은 토큰으로 `/two-factor/disable` 403 APP_SESSION_FORBIDDEN, `/api/staff/me` 200, `/sign-out` 200

## 검증
- `staff-app-sign-in.db.test.ts`: 13 passed (RED 4 failed → GREEN)
- `npm run test:unit`: 127 files, 1768 passed
- admin-web `tsc --noEmit` exit 0 · mobile `npx tsc --noEmit` exit 0
- 전체 `npm run test:db`(DB·Redis 기동): 194 files, 1701 passed (지난번 1697 + 새 테스트 4)

---

# 2차 — 재리뷰(08 r2) R2-C1 반영 (2026-11-25)

## RED 먼저 확인
고치기 전 새 테스트 3개 실패(3 failed / 13 passed), 로그 `_workspace/app-2fa-bypass/07_red_r2.log`:
- 따옴표 쿠키(`name="TOKEN.서명"`)로 `/two-factor/disable` **200** — 허용 목록 훅을 건너뛰고 인증 앱이 꺼졌다(리뷰 지적 그대로 재현). 같은 테스트의 `/change-password`·`/revoke-sessions` 는 disable 이 옛 세션을 지운 탓에 401 이었다(우회가 안 된 게 아니라 토큰이 이미 바뀐 것)
- `/get-session` 갱신 응답의 서명 쿠키를 따옴표로 감싸 `/two-factor/disable` → **200**(서명 값을 실제로 얻을 수 있다는 전제도 테스트에서 확인)

## 고친 것
1. **토큰 해석을 Better Auth 와 같게** — 손으로 짠 쿠키 파서(`presentedSessionTokens`)를 지웠다. 쿠키는 Better Auth 가 세션을 읽을 때 쓰는 그 함수 `ctx.getSignedCookie(세션쿠키, secret)`(설치본 `api/routes/session.mjs:40`)로 읽는다 — 따옴표·퍼센트 인코딩·서명 분리가 저절로 같다. Bearer 는 bearer 플러그인 규칙(`slice(0,7)` 소문자 비교, 점 있으면 서명 값·`%` 면 한 번 디코드, 마지막 점에서 분리)을 따르되 서명은 따지지 않고 후보에 넣는다(막기만 하는 판정이라 넓게). 둘 중 Better Auth 가 무엇을 쓰든 후보에 들어 있다.
2. **깊이 방어(데이터 쪽 길목)** — `databaseHooks` before 는 ctx 를 받는다(설치본 `db/with-hooks.mjs`: `tryGetCurrentAuthEndpointContext()` 를 넘김). 그 `ctx.context.session` 이 Better Auth 가 그 요청에서 **실제로 쓴 세션**이라, 앱 세션이면 403 으로 끊는다:
   - `user` update·delete(2단계 켜기·끄기, 이름·이메일, 탈퇴) · `account` create·update·delete(비밀번호 바꾸기·설정, 연결·해제) · `session` delete(남의 세션 끊기 — 자기 세션 지우기=로그아웃만 허용)
   - **못 거는 곳**: `twoFactor` 표(인증 앱 비밀값). 플러그인이 훅을 거치지 않는 `ctx.context.adapter` 로 바로 쓴다. 다만 1.7.5 에서 이미 켜진 계정에 enable 을 부르면 `TOTP_ALREADY_ENABLED` 400 이라 비밀값이 바뀌지 않았고(아래 실측), 끄기는 user update 가 먼저라 막힌다. 이 표는 앞단 훅만 지킨다
3. **판정 원칙** — 「토큰을 못 찾으면 통과」는 앞단 훅에 남아 있지만, 이제 앞단이 Better Auth 와 같은 함수로 읽으므로 「우리는 못 찾고 Better Auth 는 찾는」 경우가 없다. 그리고 바뀌는 순간의 판정(2번)은 우리 해석이 아니라 Better Auth 가 고른 세션을 그대로 쓴다. 앞단 훅에서 Better Auth 세션 읽기 함수(`getSessionFromCtx`)를 직접 부르는 구조는 쓰지 않았다 — bearer 변환 결과가 다음 훅에 안 넘어오고(dispatch 실측), 부르면 공유 문맥의 `ctx.context.session` 을 미리 채우고 갱신 쿠키를 붙이는 부작용이 있다.

**층별 확인(앞단 훅을 잠시 끄고 돌림, 로그 `_workspace/app-2fa-bypass/07_layer2_only.log`, 되돌림 확인)**: 데이터 쪽 길목만으로도 `/two-factor/disable`·`/change-password`·`/revoke-other-sessions`·`/revoke-sessions`(500 으로 끊김, 삭제 없음)가 막혔다. 읽기만 하는 `/list-sessions`·`/list-accounts` 와 2단계 켜기 시도(`TOTP_ALREADY_ENABLED`)는 앞단 훅이 막는다.

## 테스트(추가 3개, 계정 `owner_q` 따로)
- 따옴표 쿠키로 `/two-factor/disable`·`/change-password`·`/revoke-sessions` 403, 계정 값(2단계 켜짐·비밀값·비밀번호 해시) 그대로
- 퍼센트 인코딩 쿠키 · 따옴표 쿠키+엉터리 Bearer · 엉터리 쿠키+앱 Bearer · 따옴표 쿠키+서명 Bearer 모두 403
- `/get-session` 갱신으로 받은 서명 쿠키를 따옴표로 감싸도 403
- 정상 웹 2단계 등록 회귀·C1·H1·서명 쿠키 테스트 유지

## 바꾼 파일(2차)
- `admin-web/lib/server/staff-app-sign-in.ts` — 파서 삭제, `ctx.getSignedCookie`·`bearerToken`, `appCallerSession`·`rejectAppCaller`
- `admin-web/lib/server/staff-auth.ts` — databaseHooks user·account·session(delete)
- `admin-web/tests/db/staff-app-sign-in.db.test.ts` — R2-C1 테스트 3개
- `CLAUDE-decisions.md` ADR-007 · `_workspace/03_contracts/README.md` §6-1 「앱 세션 제한」 행에 한 줄씩

## 서버·검증(2차)
- `:3000` 지정 명령으로 재시작. 실서버: `brad` 앱 토큰으로 `/change-password` 403 APP_SESSION_FORBIDDEN, `/api/staff/me` 200, `/sign-out` 200
- `staff-app-sign-in.db.test.ts` 16 passed (RED 3 failed → GREEN)
- `npm run test:unit` 127 files, 1768 passed · admin-web `tsc` exit 0 · mobile `tsc` exit 0
- 전체 `npm run test:db`(DB·Redis 기동): 194 files, 1704 passed
- 남은 것: M1·M2·L2 는 사용자 결정 대상이라 그대로
