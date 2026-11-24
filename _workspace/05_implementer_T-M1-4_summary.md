# Phase 5(구현) — T-M1-4(Better Auth 스모크) 결과

작성 2026-11-19 · 슬라이스 S0-1 · 한 줄: **기본안(`auth` 스키마 + `schemaName` + 같은 BYO 풀 + bearer)과 대체안(`public` + `auth_` 접두어)이 둘 다 통과했다.** 고르는 판정은 메인.

## 만든·고친 파일 (`admin-web/`)
| 파일 | 내용 |
|---|---|
| `tests/spike/auth-smoke.db.test.ts` | 신규. 변형 2개(기본안·대체안)를 같은 흐름으로 실측: 마이그레이션 → 가입 → 로그인 → bearer 보호 호출 → 틀린 비밀번호 거부. 측정값은 afterAll 이 JSON 으로 찍는다(`--silent=false`). 시작·끝에 `auth` 스키마와 `public.auth_*` 를 지워 반복 실행 가능 |
| `.env.example` | `BETTER_AUTH_SECRET`·`BETTER_AUTH_URL` 이름만 추가(값은 자리표시) |
- `package.json`·lock·`prisma/db.ts`·`tests/setup/*` 는 건드리지 않았다. 필요한 의존성(better-auth 1.7.5·kysely·pg)은 이미 있었다.
- 임시 Route Handler(`app/api/auth/[...all]/route.ts`)는 실측 뒤 **지웠다**(공개 가입 경로가 남지 않게). `.next/dev/types` 의 낡은 생성물도 지웠다(gitignore 대상).

## S-7 결과
| 항목 | 기본안 `auth` 스키마 | 대체안 `public` + `auth_` |
|---|---|---|
| 테이블 위치 | `auth.account/session/user/verification` (4개) | `public.auth_account/auth_session/auth_user/auth_verification` |
| 설정 | `database: { db: new Kysely(PostgresDialect({ pool })), type: "postgres", schemaName: "auth" }` | `modelName` 4개(`user/session/account/verification` → `auth_*`) |
| search_path 의존 | **없음** — 풀의 `search_path` 는 `"$user", public` 그대로인데도 `auth.` 로 만들어진다. 마이그레이션이 스키마를 먼저 만든다 | 해당 없음 |
| public 침범 | 없음(`user/session/account/verification` 가 public 에 없음) | 접두어 없는 이름은 없음 |
| bearer 토큰 헤더 | 로그인 응답 `set-auth-token`(길이 77, `<토큰>.<서명>` 형태), `access-control-expose-headers: set-auth-token`. `set-cookie` 도 같이 온다 | 동일 |
| 보호 호출 | `GET /api/auth/get-session` + `Authorization: Bearer <토큰>` → 200, 사용자 이메일 일치 | 동일 |
| 거부 | 토큰 없음 → `null`, 엉터리 토큰 → `null`, 틀린 비밀번호 → 401 | 동일 |
| 같은 BYO 풀 | `createDb` 가 만든 `pg.Pool` 을 그대로 Kysely 에 넘김 — 접속 수 증가 없음 | 동일 |

### Next 16.3 Route Handler
임시 `app/api/auth/[...all]/route.ts`(`toNextJsHandler(auth)` → `GET`·`POST`)를 만들어 `next dev -p 3107`(테스트 DB)에 실제 HTTP 로 확인: 가입 200 · 로그인 200 + `set-auth-token` 헤더 · 토큰으로 get-session 200 · 토큰 없이 `null`. `next build`(16.3.5)도 이 경로를 `ƒ /api/auth/[...all]` 로 통과. 테스트 파일은 같은 `toNextJsHandler` 의 `(Request)=>Response` 를 직접 호출한다.

## 검증 명령·결과
- `flock /tmp/kdance-next-test.lock npm run test:db -- tests/spike/auth-smoke.db.test.ts` → 2 passed (약 3초, 반복 실행 확인)
- `./node_modules/.bin/tsc --noEmit` → 출력 없음
- `next build` → 성공(임시 route 포함 상태에서 확인, 지운 뒤 다시 통과)

## 주의·미해결
- 초기화 때 `Database schema mismatch / Missing tables` 오류 로그가 찍힌다 — 마이그레이션 전이라 나오는 것이고 이후 사라진다(2026-09-24 스모크와 같음).
- `schemaName` 은 1.7.5 의 `database` 옵션에 있다(`init-options.d.mts`). `search_path` 에 기대지 않으니 풀을 Prisma 와 공유해도 안전.
- **이번에 하지 않은 것**: OTP 2단계 인증(SP-8), 사용자 테이블과 Prisma 계약의 FK 관계(`auth.user` 는 계약 밖 — 예약·결제가 참조하는 방식은 계획에서 정할 것), `username` 플러그인, 운영용 `lib/auth` 모듈·Route Handler(기능 Task 몫).
- 후속 DB 테스트의 `truncateAll`(public 만)은 `auth` 스키마를 비우지 않는다. 인증 테스트를 더 쓰는 Task 는 자기 정리를 가져야 한다. 대체안을 고르면 `auth_*` 가 public 에 있어 `truncateAll` 이 같이 비우고, `prisma db update` 가 계약에 없는 테이블로 보고 지울 수 있는지는 **미검증**.
