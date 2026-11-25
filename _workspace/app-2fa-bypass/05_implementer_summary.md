# 05 구현 요약 — 앱 로그인 2단계 생략 (2026-11-25, 사용자 결정 「앱은 2단계 없이 통과」)

## 고른 방법과 이유
Better Auth **플러그인 엔드포인트** `POST /api/auth/sign-in/staff-app` (`[...all]` 라우트로 들어온다, 새 route 파일 없음).

- two-factor 플러그인(설치본 1.7.5)의 after 훅 matcher 는 `/sign-in/email`·`/sign-in/username`·`/sign-in/phone-number` 세 경로와 **정확히 일치**할 때만 돈다 → 새 경로는 2단계 가로채기를 받지 않는다. 플러그인 옵션으로 경로별로 끄는 설정은 설치본에 없다(trustDevice 쿠키만 있음).
- 브리프 추천안(Next.js 라우트 + internalAdapter.createSession)을 쓰지 않은 이유: 세션 create 훅(staff-auth.ts)이 계정의 `twoFactorEnabled` 를 보고 `secondFactorVerified=true` 를 찍는다. Next 라우트에서는 훅이 받는 엔드포인트 문맥이 없어 「어느 경로에서 만든 세션인지」 가릴 수 없고, 그대로면 **앱 토큰이 관리자 웹 콘솔을 연다**. 플러그인 엔드포인트는 `tryGetCurrentAuthEndpointContext()` 로 훅에 `ctx.path` 가 넘어와, 훅이 `ctx.path === STAFF_APP_SIGN_IN_PATH` 면 false 로 적는다. (이 한 줄을 끄면 테스트 ①·③ 이 실패하는 것을 확인했다.)
- 비밀번호 확인·없는 아이디의 해시 지연·오류 본문은 username 플러그인과 같은 함수·같은 `APIError.from(UNAUTHORIZED, INVALID_USERNAME_OR_PASSWORD)`.
- 요청 제한: ① 경로가 `/sign-in` 으로 시작해 Better Auth 기본 제한(IP·경로 10초 3회, 운영만)을 기존과 같이 받고, 플러그인 `rateLimit` 에도 같은 값을 명시 ② **추가로** 계약 §6-4 `authFailure`(아이디 또는 IP 15분 5회, Redis, 꺼지면 막음)를 이 경로에 건다.

## 바꾼 파일
- `admin-web/lib/server/staff-app-sign-in.ts` (신규) — 플러그인. 직원 active 만 세션, 회원·탈퇴 403 STAFF_ACCOUNT_REQUIRED, 정지 403 ACCOUNT_SUSPENDED(본문 `{code, detail, message}`), 쿠키 안 심음, 429 는 §6-4 모양 + Retry-After
- `admin-web/lib/server/staff-auth.ts` — 플러그인 등록, `appSignInLimit` 옵션, 세션 훅에 앱 경로 분기, `STAFF_APP_SIGN_IN_PATH` 재수출
- `admin-web/lib/server/staff-auth-instance.ts` — 실서버 인스턴스에 Redis 제한기(authFailure) 연결
- `admin-web/tests/db/staff-app-sign-in.db.test.ts` (신규) — ①~⑦ 9개
- `mobile/lib/instructor/staff-api.ts` — 새 경로 사용, twoFactorRedirect·TWO_FACTOR_REQUIRED 분기 삭제
- `specs/001-ai-dance-class-platform/spec.md` — FR-303 불릿 + 변경 이력 1행
- `_workspace/03_contracts/README.md` — §6-1 표 행 수정 + 「앱 로그인」 계약 표 신설, §6-2 ③ 한 문장
- `CLAUDE-decisions.md` — ADR-007

권한 행렬(`tests/db/permission-matrix.db.test.ts`)은 바꾸지 않았다 — route 파일이 늘지 않아 ROUTE_FILE_COVERAGE 대상이 아니다(`[...all]` 은 이미 public 으로 있음). 행렬 테스트 통과 확인.

## 테스트 결과
- `npm run test:db -- staff-app-sign-in · staff-sign-in · second-factor-gate · permission-matrix`: 4 files, 302 passed
- `npm run test:unit`: 127 files, 1768 passed
- admin-web `tsc --noEmit`: exit 0 · mobile `npx tsc --noEmit`: exit 0
- 전체 `npm run test:db`(DB·Redis 기동): 194 files, 1697 passed

## 발견한 것 · 남은 위험
1. **기존 `/sign-in/username` 에는 계약 §6-4 의 Redis 실패 제한(15분 5회)·`staff.login_failed` 감사 기록이 연결돼 있지 않다** — Better Auth 기본 제한(운영에서만)뿐이다. 계약 README §6-1 「429 는 우리 모양으로 낸다 — before 훅에서 건다」도 실제 코드에 없다. 새 앱 경로에는 Redis 제한을 걸었지만 감사 기록(`staff.login_failed`)은 넣지 않았다(기존과 같은 수준). 웹 로그인 쪽 보강은 별도 Task 필요.
2. 비밀번호만 알면 대표 앱에서 회원 정보를 볼 수 있다(사용자 안내·수용함). 고시 제6조 ② 해당 여부는 공개 운영 전 확인.
3. **개발 서버(:3000)는 재시작해야 새 경로가 잡힌다** — `staff-auth-instance.ts` 가 인스턴스를 `globalThis` 에 붙잡아 두어 HMR 로 다시 만들지 않는다. 지시대로 서버를 끄지 않았으므로 지금 :3000 에서는 새 경로가 404 일 수 있다.
4. 화면(모바일 로그인) 스크린샷 검증은 하지 않았다 — 위 3번 때문에 실서버 경로가 아직 안 잡힌다. 재시작 뒤 Expo 웹(:8081)에서 인증 앱 켠 대표 계정으로 로그인 확인 필요.
5. 회원도 auth.user 에 있다(members.auth_user_id). 회원이 이 경로로 오면 비밀번호가 맞을 때만 403 STAFF_ACCOUNT_REQUIRED — 「이 아이디가 직원이 아니다」는 비밀번호를 아는 사람에게만 보인다.
