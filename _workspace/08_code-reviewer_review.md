# Phase 8(코드 리뷰) — S0-1(R2 스파이크·러너 바닥) · 2026-11-19

## 판정: PASS

CRITICAL 0 · HIGH 0 · MEDIUM 4 · LOW 6. 막는 결함은 없다. 다만 M-1·M-2 는 **S0-2(데이터 계약 1판)에서 첫 핸들러 DB 테스트를 쓰기 전에** 고쳐야 한다. 지금은 문제가 드러나지 않지만 그때부터는 실제로 터진다.

- 대상: `admin-web` 미커밋 변경. 신규 12개 파일, 수정 3개(`package.json`·`package-lock.json`·`.env.example`)
- 리뷰 관점: TypeScript(타입·async), DB(풀·트랜잭션·정리), 보안(비밀값·Better Auth·공개 가입 경로)
- 직접 확인한 것: `npm ls @prisma/cli-engine @types/pg`, `prisma db update --help`, `@prisma/orm-postgres/dist/runtime.mjs`(풀은 첫 쿼리 때 연결), `app/api` 아래에는 `health` 하나뿐(임시 `app/api/auth` 삭제 확인), `.env` 는 gitignore 대상
- 테스트 결과는 `06_test-runner_results.md`(192 passed, DB 없으면 8 skipped)를 그대로 인정했다. 다시 돌리지 않았다

## 「특히 볼 것」 4가지에 대한 답

| # | 질문 | 답 |
|---|---|---|
| 1 | `prisma/db.ts` 싱글턴 풀이 앱·테스트에서 섞이나 | **섞인다(M-1).** 테스트가 `createDb` 를 import 하는 순간 `DATABASE_URL`(개발 DB) 풀이 모듈 싱글턴으로 생긴다. 지금은 아무도 쿼리하지 않아 무해하다. `poolMax` 옵션은 문제없다. `as unknown as` 변환은 L-1, `withPgTransaction` 은 L-2 |
| 2 | 테스트 간 오염·skip·회귀 유지 | `fileParallelism:false` + `beforeEach truncateAll` 로 파일 간·테스트 간 오염은 없다. skip 은 `describe.skipIf(!dbAvailable())` 로 확실하다(실측 8 skipped). 남은 문제는 테스트 DB 가드 부재(M-2)와 계약 교체 때 `db update` 가 거부하는 것(M-3) |
| 3 | overrides 3개·정확 고정 | 셋 다 필요한 범위만 덮는다(L-4 참고). Prisma 두 패키지와 `@prisma/cli-engine` 은 정확 고정이 맞다. 나머지 새 의존성은 `^`/`~` 다(L-5) |
| 4 | health 의 side-effect import 가 DB 를 여나 | **열지 않는다.** `new Pool()` 과 `postgres({ pg: pool })` 둘 다 첫 쿼리 전까지 연결하지 않는다(`runtime.mjs:18` "the pool is created on the first query or connect()"). 개발 서버 HMR 때 풀 객체가 쌓이는 문제는 M-4 |

---

## MEDIUM

### M-1. 테스트 프로세스 안에서 앱 싱글턴 `db` 가 개발 DB 를 가리킨다 — CONFIRMED(현재는 잠복)
- **위치**: `admin-web/prisma/db.ts:44-46`, `admin-web/vitest.config.mts:6`, `admin-web/tests/setup/db.ts:6`
- **문제**: `vitest.config.mts` 가 `dotenv/config` 로 `.env` 를 읽는다. 그래서 테스트 워커의 `DATABASE_URL` 은 `kdance_next`(개발 DB)다. `tests/setup/db.ts` 가 `prisma/db` 를 import 하면 모듈 싱글턴 `shared = createDb(process.env.DATABASE_URL)` 도 함께 만들어진다. 지금 스파이크는 `openTestDb()` 핸들만 쓰니 문제가 없다. 그런데 S0-2 이후 Route Handler 와 서비스는 `import { db } from "@/prisma/db"` 를 쓴다.
- **재현 시나리오**: S0-2 에서 `POST /api/...` 핸들러를 db 프로젝트 테스트로 부른다 → 핸들러가 싱글턴 `db` 로 **개발 DB** 에 쓴다 → 테스트가 `openTestDb()`(테스트 DB)로 결과를 읽으면 아무것도 없다. 또는 개발 DB 에 테스트 쓰레기 데이터가 쌓인다. `truncateAll` 은 테스트 DB 만 비운다.
- **제안**: db 프로젝트에 `setupFiles` 를 하나 두고, 그 안에서 `prisma/db` 를 import 하기 **전에** `process.env.DATABASE_URL = inject("testDatabaseUrl")` 로 덮어쓴다. 아니면 `vitest.config.mts` 의 db 프로젝트 `test.env` 에 `DATABASE_URL: process.env.TEST_DATABASE_URL` 을 넣는다. 그러면 테스트 안에서는 싱글턴과 `openTestDb()` 가 같은 DB 를 본다.

### M-2. 테스트 DB 주소에 안전장치가 없다 — 잘못 넣으면 개발 데이터가 지워진다 — PLAUSIBLE(설정 실수가 있어야 일어남)
- **위치**: `admin-web/tests/setup/global-setup.ts:34-48`, `admin-web/tests/setup/db.ts:40-47`, `admin-web/tests/spike/auth-smoke.db.test.ts:79-84`
- **문제**: 테스트는 `TEST_DATABASE_URL` 이 가리키는 DB 에 `prisma db update`, `TRUNCATE public.* CASCADE`, `DROP SCHEMA auth CASCADE` 를 그대로 실행한다. DB 이름이 정말 테스트용인지는 확인하지 않는다.
- **재현 시나리오**: 개발자가 `.env` 를 손보다 `TEST_DATABASE_URL` 을 `.../kdance_next` 로 적는다. `npm test` 를 돌리면 개발 DB 의 public 테이블이 전부 비고 Better Auth 계정(`auth` 스키마)까지 지워진다. 옛 backend conftest 도 `kdance_test` 라는 이름에 기대고 있었다.
- **제안**: `global-setup.ts` 에서 접속 전에 `new URL(url).pathname` 이 `_test` 로 끝나는지 검사한다. 아니면 `throw` 한다(skip 이 아니라 실패로). 한 줄짜리 가드로 사고 하나를 통째로 막는다.

### M-3. 계약이 바뀌면 `globalSetup` 의 `db update` 가 거부되어 DB 테스트 전체가 멈춘다 — CONFIRMED(동작 확인은 help 문구 기준)
- **위치**: `admin-web/tests/setup/global-setup.ts:42-48`
- **문제**: `prisma db update --help` 에 따르면 데이터를 잃는 작업은 `--delete`/`--rename` 답이 있어야 하고, "Where nobody can answer, it refuses"다. `--yes` 로는 넘어가지 않는다(주석 내용과 일치). S0-2 가 골격 계약(`SeatPool`·`Refund`)을 20테이블 계약으로 바꾸면 `seat_pools`·`refunds` 의 칸 삭제나 이름 변경이 생긴다. 그러면 기존 테스트 DB 에서 `execFileSync` 가 0이 아닌 종료 코드로 끝나고, db 프로젝트가 globalSetup 단계에서 통째로 실패한다. `stdio: "pipe"` 라 거부 사유는 오류 객체의 `stderr` 에만 남아 원인이 잘 안 보인다.
- **제안**: 테스트 DB 는 버려도 되는 DB 다. `db update` 전에 `DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS prisma_contract CASCADE`(M-2 가드를 통과한 뒤에만)로 비우거나, 실패하면 한 번 비우고 다시 시도한다. 실패 시 `error.stderr` 를 메시지에 붙여 다시 던진다. S0-2 가 이 단계를 `db migrate` 로 바꿀 때 함께 처리해도 된다.

### M-4. 개발 서버 HMR 때마다 `pg.Pool` 이 새로 생긴다 — PLAUSIBLE
- **위치**: `admin-web/prisma/db.ts:42-46`
- **문제**: 주석은 "요청마다 새 풀을 만들면 접속 폭주"를 막으려고 모듈 싱글턴을 쓴다고 한다. 하지만 `next dev` 는 파일이 바뀌면 모듈을 다시 평가한다. 이전 풀은 닫히지 않고 연결(최대 10개)을 쥔 채 남는다. 같은 저장소의 `lib/server/fakes/fake-payment-gateway.ts:5,61` 은 바로 이 이유로 `globalThis` 에 원장을 붙여 두었으니 패턴도 서로 맞지 않는다.
- **재현 시나리오**: `npm run dev` → `/api/...` 를 한 번 호출해 풀을 연다 → `prisma/db.ts` 나 그 import 체인을 몇 번 저장한다 → `SELECT count(*) FROM pg_stat_activity WHERE datname='kdance_next'` 가 저장한 횟수만큼 늘어난다. 결국 Postgres 의 `max_connections` 에 걸린다.
- **제안**: `process.env.NODE_ENV !== "production"` 일 때 `globalThis.__kdanceDb ??= createDb(...)` 로 캐시한다. 지금은 health 가 쿼리를 하지 않아 연결이 실제로 열리지 않으므로, S0-2 첫 DB 핸들러 전에 고치면 된다.

---

## LOW

### L-1. `pool as unknown as PrismaPgBinding` — 타입 검사를 통째로 끈다
- **위치**: `admin-web/prisma/db.ts:31-38`
- **근거**: `npm ls` 결과 `@types/pg@8.23.1`(우리)과 `@types/pg@8.20.4`(`@prisma/orm-postgres` 안)가 함께 있다. 실행되는 `pg` 는 한 벌이라 지금은 안전하다. 그런데 `unknown` 을 거치면 나중에 `Pool` 이 아닌 값을 넘겨도 컴파일러가 잡지 못한다.
- **제안**: 둘 중 하나. ① 우리 `@types/pg` 를 Prisma 와 같은 `8.20.4` 로 맞추고 변환을 없앤다. ② `pool satisfies Pick<Pool, "connect" | "query" | "end">` 로 최소 모양을 확인한 뒤에 변환한다. 주석에 "Prisma 가 @types/pg 를 올리면 이 변환을 지운다"는 종료 조건도 적어 둔다.

### L-2. `withPgTransaction` — ROLLBACK 이 실패한 연결을 풀에 그대로 돌려준다
- **위치**: `admin-web/prisma/db.ts:66-72`
- **문제**: ROLLBACK 이 실패하면(연결 끊김 등) 그 클라이언트는 상태를 알 수 없다. 그런데도 `client.release()` 로 풀에 돌아가 다음 요청이 받아 쓴다.
- **제안**: 롤백이 실패했으면 `client.release(rollbackError)`(또는 `release(true)`)로 연결을 버린다. 비상용이라 지금 부르는 곳은 없다.

### L-3. `db:seed` 스크립트가 없는 파일을 가리킨다
- **위치**: `admin-web/package.json` scripts `"db:seed": "node scripts/seed.ts"` — `admin-web/scripts/` 디렉터리가 없다
- **재현**: `npm run db:seed` → `Cannot find module .../scripts/seed.ts`
- **제안**: 시드 파일을 만드는 Task 에서 스크립트도 함께 추가하거나, 그 Task 번호를 주석·요약에 적어 둔다.

### L-4. overrides 3개 — 범위는 맞다. 다만 rc 번호가 세 곳에 흩어져 있다
- **위치**: `admin-web/package.json` `dependencies.@prisma/orm-postgres`, `devDependencies.prisma`, `overrides.@prisma/orm-toolchain`
- **평가**: `better-auth→prisma` 는 원래 있던 것이다. `@prisma/orm-toolchain` 은 패키지 하나만 덮는다(전역 키지만 대상이 하나다). `@prisma/composer-cli→@prisma/cli-engine` 은 범위를 composer-cli 아래로 좁혔다. `--legacy-peer-deps` 는 쓰지 않았다. 규칙을 지켰다. `npm ls` 로 보면 `@prisma/cli-engine` 이 0.10.0(우리·toolchain)과 0.9.0(prisma CLI·composer)으로 두 벌이지만 의도한 상태다.
- **위험**: Prisma 를 rc.25 로 올리면서 `overrides.@prisma/orm-toolchain` 을 빼먹으면 CLI 와 런타임 툴체인이 조용히 어긋난다. 그러면 `contract emit` 이 다시 `CLI.UNEXPECTED` 로 깨진다.
- **제안**: `docs/planning/tech/tech-stack.md` 「11-2. 알려진 위험」에 "Prisma rc 를 올릴 때 세 곳을 같이 바꾸고, 정식판이 나오면 override 두 개를 지울 수 있는지 다시 본다"를 한 줄 적는다.

### L-5. 새 의존성 일부가 범위 지정이다
- **위치**: `admin-web/package.json` — `kysely ^0.29.6`, `pg ^8.22.0`, `dotenv ^17.4.2`, `vitest ~4.1.12`
- **평가**: 정확 고정 규칙은 Prisma(rc)에만 걸려 있고, 저장소의 기존 관례(`^`)와도 맞는다. 위반은 아니다. 다만 `kysely` 는 0.x 라 `^0.29.6` 이면 0.29 안에서만 움직인다. Better Auth 가 Kysely 메이저 변화에 민감하다는 점만 기억해 둔다.

### L-6. 스파이크 파일을 회귀 테스트로 남기는 문제
- **위치**: `admin-web/tests/spike/r2-prisma8.db.test.ts:4-6,31`, `admin-web/tests/spike/auth-smoke.db.test.ts:6,76`
- **평가**: 단언(롤백·잠금·조건부 UPDATE 단일 성공·부분 유니크 0행·Temporal 왕복)은 Prisma rc 를 올릴 때 꼭 다시 확인해야 할 성질이라, 회귀 테스트로 남겨 둘 가치가 있다. 다만 세 가지를 정리한다.
  1. 머리 주석이 "판정용이다 — 실패해도 그 자체가 결과"라고 되어 있다. 회귀로 남기면 실패는 곧 회귀이니 문구를 바꾼다.
  2. `afterAll` 의 `console.info` 측정값 덤프는 매번 출력을 어지럽힌다. 환경 변수(예: `SPIKE_REPORT=1`)가 있을 때만 찍는다.
  3. `auth-smoke` 의 대체안(public + `auth_` 접두어)은 기본안이 채택(`03_research.md` §3-1)됐으니 더는 회귀 대상이 아니다. 지우거나 `test.skip` 으로 남긴다. 실제 auth 설정이 생기면 그 설정을 쓰는 테스트로 바꾼다.
- 덧붙여 S-2(`r2-prisma8.db.test.ts:149-158`)에서 `txA` 가 reject 되면 `other` promise 를 await 하지 못해 unhandled rejection 경고가 날 수 있다. `Promise.allSettled([txA, other])` 로 묶으면 깔끔하다.

---

## 보안 확인 결과(문제 없음)
- `app/api` 아래에는 `health/route.ts` 하나뿐이다. 임시 `app/api/auth` 는 남아 있지 않아 공개 가입 경로가 없다.
- `.env.example` 에는 이름과 자리표시(`<password>`, `<32자 이상 무작위 문자열>`)만 있다. `.env` 는 gitignore 대상이다(`git check-ignore` 확인).
- `auth-smoke.db.test.ts:19` 의 `TEST_SECRET` 은 테스트 전용 고정값이고 앱 코드에서는 쓰지 않는다.
- `truncateAll` 은 `quote_ident` 로 테이블 이름을 감싸고, 입력은 카탈로그(`pg_tables`)에서만 온다. 주입 위험이 없다.
- 참고(이번 범위 밖): 실제 Better Auth 설정을 만들 때 `emailAndPassword` 의 공개 가입 여부(`disableSignUp`), `trustedOrigins`, `BETTER_AUTH_SECRET` 미설정 시 기동 실패 처리를 그 Task 에서 다시 본다.

## 코드 스타일
- 한국어 주석이 핵심 지점(풀 소유권, 폴리필 이유, 롤백 처리, skip 규칙)에 달려 있다. useEffect 는 해당 없음(UI 변경 없음).
