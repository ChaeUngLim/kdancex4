# Phase 5(구현) — T-M1-1(R2 스파이크) 결과

- 작성 2026-11-19 · 슬라이스 S0-1(R2 스파이크·러너 바닥)
- 한 줄: **S-1~S-6 여섯 개 모두 실행(skip 0), 여섯 개 모두 계획(D3)이 기대한 대로 나왔다.** 대신 스파이크까지 가는 길에 Prisma CLI 자체가 rc.24 런타임과 어긋나 `contract emit` 이 안 되는 문제가 있었고, `package.json` 의 `overrides` 두 줄로 풀었다(④ 참고 — T-M1-2(스파이크 판정)에서 메인이 확인할 것).

---

## ① 만든·고친 파일 (전부 `admin-web/`)

| 파일 | 신규/변경 | 내용 |
|---|---|---|
| `package.json` | 변경 | deps `pg ^8.22.0`·`kysely ^0.29.6` / devDeps `vitest ~4.1.12`·`@prisma/cli-engine 0.10.0`(정확 고정)·`dotenv ^17.4.2` / scripts 6종 / `overrides` 2항목 추가(④) |
| `package-lock.json` | 변경 | 위 설치 결과 |
| `prisma.config.ts` | 신규 | `definePrismaConfig({ orm: ormConfig({ contract: './prisma/contract.prisma', db, migrations: { dir: 'migrations' } }) })`, `import 'dotenv/config'` |
| `prisma/contract.prisma` | 신규(골격) | `SeatPool`(seat_pools, CHECK 4개 — `ck_seat_pools_not_over` 포함) + `Refund`(refunds, 부분 유니크 `uq_refunds_reservation_id_active ... WHERE status <> 'failed'`). 시각 칸 `DateTime(as: temporal)` |
| `prisma/contract.json` · `prisma/contract.d.ts` | 생성물 | `prisma contract emit` 결과(손으로 고치지 않음) |
| `prisma/db.ts` | 신규 | temporal polyfill 전역 주입 → `contractFromJson<Contract>` → BYO `pg.Pool` + `postgres({ contract, pg })` 모듈 싱글턴, `createDb(url)`(테스트용), `withPgTransaction`(대체 경로 **준비만**, 선택 안 함) |
| `vitest.config.mts` | 신규 | 프로젝트 `unit`(`*.db.test.ts` 제외) · `db`(`*.db.test.ts`, globalSetup, `fileParallelism: false`, testTimeout 30s). `@` 별칭 |
| `tests/setup/global-setup.ts` | 신규 | `TEST_DATABASE_URL` 접속 시도 → 실패면 `dbAvailable=false`(db 테스트 전체 skip), 성공이면 `prisma db update --db … --yes` 로 스키마 맞춤 |
| `tests/setup/db.ts` | 신규 | `dbAvailable()` · `openTestDb()` · `closeTestDb()`(db.close + pool.end) · `truncateAll(pool)`(public 전 테이블 `TRUNCATE … RESTART IDENTITY CASCADE`) · `ProvidedContext` 타입 선언 |
| `tests/spike/r2-prisma8.db.test.ts` | 신규 | S-1~S-6. 측정값을 afterAll 에서 JSON 으로 찍는다(`--silent=false` 로 볼 수 있음) |
| `.env.example` | 변경 | `DATABASE_URL`·`TEST_DATABASE_URL` 이름과 예시(비밀번호는 `<password>`) |
| `.env` | 신규·**커밋 안 됨**(루트 `.gitignore` 의 `.env`) | 로컬 실행용. compose 의 기본 개발 계정 값. 다른 PC 에서는 `.env.example` 을 복사해 만든다 |

`.env.example` 의 나머지 변수(`BETTER_AUTH_*` 등)는 그 기능 Task 가 넣는다 — 이번에는 DB 두 줄만 넣었다.

---

## ② S-1~S-6 결과

실행: `flock /tmp/kdance-next-test.lock npm run test:db -- tests/spike/r2-prisma8.db.test.ts --reporter=verbose --silent=false` (15:46, DB 기동, PostgreSQL 18.6)

| S | research ID | 판정 | 근거(측정값) |
|---|---|---|---|
| S-1 | R-01 | **통과** | tx 안에서 ORM INSERT 1건 + SQL 빌더 UPDATE(`affectedRows` 1) + raw UPDATE(`affectedRows` 1) 뒤 throw → 커밋 뒤 확인: INSERT 행 0개, 빌더가 바꾼 `seat_kind` 원래대로(`male`), raw 가 올린 `held_count` 원래대로(0). 세 레인 모두 롤백 |
| S-2 | R-02 | **통과** | tx 안 raw `SELECT … FOR UPDATE` 1행. FOR UPDATE 전후 `pg_backend_pid()`=4937·`txid_current()`=1033 로 같음 → raw 레인이 같은 연결·같은 트랜잭션. tx 밖 다른 연결(pid 4938)의 같은 행 UPDATE 는 잠근 시각 3ms 에 보내 **814ms 에 끝남**(약 812ms 대기). A 콜백 종료 805ms · A 커밋 완료 813ms → B 는 A 커밋 뒤에 끝났다. B 영향 행 1 |
| S-3 | R-03 | **통과** | 정원 1 · 각자 `db.transaction` 안의 조건부 UPDATE(`held_count + confirmed_count < capacity`) 20건 `Promise.all` → 성공 1, 0행 19, **오류 0**(CHECK 위반 없이 WHERE 에서 걸러짐), 최종 `held_count` 1. SQL 빌더는 내장 함수(`fns`)에 덧셈이 없어 `held_count + 1` 을 못 써 raw 레인으로 썼다(계획의 「실패하면」 열과 같음) |
| S-4 | R-07 | **통과** | 살아 있는 환불(`pending`)이 있는 예약에 raw `INSERT … ON CONFLICT DO NOTHING RETURNING id` → **0행, 예외 없음**, 같은 tx 에서 다음 쿼리(`SELECT 1`) 정상. `status='failed'` 행은 같은 문장으로 1행 들어감 → 인덱스가 실제로 「부분」. 최종 환불 행 2개 |
| S-5 | R-08(정보용) | **통과** | tx 첫 문장 raw `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` → `SHOW transaction_isolation` = `serializable`. 기본값은 `read committed`. **새로 확인**: rc.24 에는 `db.transaction(fn, { isolationLevel: 'Serializable' })` 옵션이 있고 이것도 `serializable` 로 나왔다 |
| S-6 | R-09 | **통과** | `DateTime(as: temporal)` 칸에 밀리초로 맞춘 `Temporal.Instant` 를 쓰고 ORM 으로 읽음 → `instanceof Temporal.Instant` true, `constructor === Temporal.Instant`(polyfill 클래스와 같음) true, `Temporal.Instant.compare` = 0. `created_at`(DB 기본값 `now()`)도 Instant |

S-7(R-10, Better Auth)은 T-M1-4 범위라 이 파일에 없다.

---

## ③ `prisma skills sync` 경고(R-P6(사전 릴리스 묶음)) 확인

- `prisma contract emit`·`db update --help` 등 **모든 ORM 명령 끝에** 아래가 찍힌다:
  `Prisma agent skills are out of date (installed @prisma/orm-postgres 8.0.0-rc.24, synced none). Run: prisma skills sync`
- `prisma skills list` 결과: `prisma-8`(orm-postgres rc.24) · `prisma-composer-core-concepts`(composer 0.32.0) · `prisma-platform-core-concepts`(prisma rc.24) 3종 × `.claude/skills`·`.cursor/skills`·`.agents/skills`·`.devin/skills` 4곳 전부 `absent`.
- **sync 는 돌리지 않았다.** `admin-web/.claude/skills/` 등 4곳에 스킬 파일을 써 넣는 명령이라 프로젝트 하네스 구성에 닿는다 — 사용자 결정 사항. 경고만 끄려면 `prisma skills sync --disable`(프로젝트 단위)가 있다. 설치본 문서는 `node_modules/@prisma/orm-postgres/skills/prisma-8/` 에서 직접 읽었다(frontmatter `library_version: 8.0.0-rc.24` — 설치본과 일치).

---

## ④ 설치·버전 실측 (package.json 변경 전후)

### 시작 상태 (브리프와 다른 점)

| 항목 | 브리프·research §1 | 실측(작업 전) |
|---|---|---|
| vitest(전이) | 4.1.11 | **5.1.1** — `prisma` rc.24 → `@prisma/composer` → `@effect/vitest@4.0.3`(peer `vitest >=5.0.0 <6.0.0`)가 끌고 옴. **plan D11 의 근거(「`@effect/vitest` peer 가 `<5`」)가 rc.24 에서 뒤집혔다** |
| `@prisma/cli-engine` | 0.4.0 | 최상위 0.7.0(composer-cli 의 것), prisma 안 0.9.0, orm-postgres 안 0.10.0 — 세 벌 |
| `@prisma/orm-toolchain` | — | 최상위 **rc.18**(prisma CLI 가 고정), orm-postgres 안 rc.24 |

### 막힌 것 — Prisma CLI 가 rc.24 계약을 못 읽음

- 레지스트리 실측: `npm view prisma@8.0.0-rc.24 dependencies` → `@prisma/orm-toolchain: 8.0.0-rc.18`, `@prisma/cli-engine: 0.9.0`. **CLI rc.24 가 툴체인 rc.18 을 싣고 나온다.**
- 그래서 `prisma contract emit` 이 **어떤 계약이든**(모델 1개짜리로도 확인) 실패:
  `✘ [CLI.UNEXPECTED] Cannot use 'in' operator to search for 'kind' in typeAlias`
- rc.24 툴체인을 직접 불러 보면(진단용 스크립트, 패키지 변경 없음) 설정은 읽히지만 이번엔
  `CONTRACT.SOURCE_LOAD_FAILED — Codec pg/int4@1 takes only values of pg/int4, and was handed an object no data type constructed.`
  → 원인: 최상위가 rc.18 이라 `@prisma/orm-framework` rc.24 가 orm-postgres·family-sql·target-postgres 아래에 **따로따로 중첩 설치**돼 같은 클래스가 여러 벌 생김.
- 참고: `npm view prisma dist-tags` 의 `latest` 는 이제 **8.0.0-rc.34**.

### 푼 방법 (prisma·orm-postgres 버전은 그대로 rc.24)

```json
"overrides": {
  "better-auth": { "prisma": "$prisma" },
  "@prisma/orm-toolchain": "8.0.0-rc.24",
  "@prisma/composer-cli": { "@prisma/cli-engine": "0.9.0" }
}
```

1. `@prisma/orm-toolchain` → rc.24: CLI 가 런타임과 같은 툴체인을 쓰고 rc.24 패키지가 최상위 한 벌로 합쳐진다. 이 한 줄로 emit 성공.
2. `@prisma/cli-engine 0.10.0` 직접 선언(R-04 답 — 아래): 툴체인 rc.24 의 peer 가 `0.10.0` 이고 rc.23→rc.24 업그레이드 노트가 「직접 의존하는 프로젝트는 0.10.0 으로」라고 적는다. 업그레이드 노트의 정확 고정 규칙대로 `-E` 로 넣었다.
3. 2를 하자 `npm install` 이 `npm warn ERESOLVE overriding peer dependency`(composer-cli 0.32.0 의 peer `@prisma/cli-engine@0.7.0` 과 충돌)를 냈다. composer-cli 가 prisma 의 0.9.0 을 쓰게 `overrides` 한 항목으로 덮었다. composer(배포·플랫폼 명령)는 우리가 쓰지 않는다.
- 결과: `npm install` 두 번 연속 **ERESOLVE 0건**, `npm ls` invalid/missing 0건. `--legacy-peer-deps` 안 씀.
- **판단이 필요한 곳**: CLI 가 공식으로 싣고 나온 툴체인(rc.18)을 rc.24 로 바꿔 끼운 것이다. 깔끔한 다른 길은 prisma·orm-postgres 를 함께 rc.34 로 올리는 것(미검증)인데, 사용자가 rc.24 고정을 정했으므로 손대지 않았다. 기술 스택 문서 「11-2. 알려진 위험」 에 적을 거리다(T-M1-5(M1 기록 마감)).

### 추가한 것과 실제 설치 버전

| 패키지 | 선언 | 설치 | 비고 |
|---|---|---|---|
| vitest | `~4.1.12` | 4.1.12 | R-14: `npm install -D vitest@~4.1.12 --dry-run` → ERESOLVE 없음. `@effect/vitest` 아래에 vitest 5.1.1 이 따로 중첩된다(두 벌). better-auth 의 선택 peer(`^2…^5`)도 만족 |
| pg | `^8.22.0` | 8.22.0 | orm-postgres 가 `pg 8.22.0` 을 정확 고정 — 한 벌 유지(레지스트리 최신 8.23.1 로 안 올림) |
| kysely | `^0.29.6` | 0.29.6 | better-auth 쪽과 한 벌(최신 0.29.9 로 안 올림) |
| @prisma/cli-engine | `0.10.0` | 0.10.0 | prisma.config.ts 가 직접 import |
| dotenv | `^17.4.2` | 17.4.2 | prisma.config.ts·vitest 설정이 직접 import(전이 설치에 기대지 않게). `prisma orm init` 도 직접 설치를 안내 |

### R-04(`prisma orm init` 을 임시 복사본에서)

scratchpad 에 `package.json`·`tsconfig.json` 만 복사해 `prisma orm init --yes --target postgres --authoring psl --skip-install` → exit 0. 생성: `src/prisma/contract.prisma`·`prisma.config.ts`·`src/prisma/db.ts`·`prisma-8.md`·`.env.example`·`.gitignore`·`.gitattributes`, `package.json` 에 `contract:emit` 스크립트, `tsconfig.json` 에 `"module": "preserve"`·`"types": ["node"]`. 안내문: 「`@prisma/orm-postgres`, `dotenv`(그리고 dev 로 `prisma` 와 **prisma 가 선언한 버전의 `@prisma/cli-engine`**) 설치」.

- **답**: `@prisma/cli-engine` 은 직접 선언해야 한다(위 0.10.0).
- **주의**: init 이 만든 `db.ts` 는 `postgres<Contract>({ contractJson, url })` — rc.18 툴체인의 옛 모양이다. 설치본 문서·타입(rc.24)은 `contractFromJson<Contract>(json)` + `postgres({ contract })` 이고 「클라이언트는 타입 인자와 `contractJson` 옵션을 받지 않는다」고 적는다. **우리 `db.ts` 는 rc.24 모양으로 손으로 썼다.** init 생성물을 그대로 옮기지 않는다.
- `tsconfig` 변경(`module: preserve` 등)은 적용하지 않았다 — Next 빌드·타입 검사가 지금 설정으로 통과한다.

### 그 밖의 발견

- `@types/pg` 어긋남: Prisma 는 자기 안에 `@types/pg 8.20.4` 를 고정, 우리는 `^8.23.1`. `postgres({ pg: pool })` 이 TS2322(8.23 의 `getTransactionStatus` 차이)로 실패 → `db.ts` 에서 `PostgresBindingOptions["pg"]` 로 타입만 변환하고 주석으로 이유를 남겼다. 런타임 pg 는 한 벌(8.22.0).
- `DateTime(as: temporal)` 의 DDL 은 정밀도 없는 `timestamptz`(=마이크로초)였다. `created_at` 이 `…34.36195Z` 로 읽혔다. data-model 의 「timestamptz(3)」 가정과 다르니 S0-2 에서 정밀도를 명시할지 정할 것.
- 설치 스크립트 미승인(allowScripts): 이번 로그에는 `esbuild@0.28.2`·`unrs-resolver@1.12.2`·`workerd@1.20261002.1` **3개**(msgpackr-extract 는 안 보임). emit·db update·vitest·build 모두 이것 때문에 막히지 않았다. 승인하지 않았다.
- `npm audit` 이 취약점 35건(critical 2)을 보고 — 이번 Task 범위 밖, 확인 안 함.

---

## ⑤ 검증 명령과 결과 (2026-11-19, DB 기동)

| 명령 (admin-web) | 결과 |
|---|---|
| `flock /tmp/kdance-next-test.lock npm run test:db -- tests/spike/r2-prisma8.db.test.ts` | **6 passed**, skip 0 (3.1s) |
| 같은 명령, `TEST_DATABASE_URL` 을 닫힌 포트로 | 6 **skipped**, 오류 0 → DB 없을 때 skip 규칙 동작 |
| `npm run test:unit` | **183 passed**(6 files) — 기준선 유지 |
| `flock … npm test` | 189 passed(7 files) = 183 + 6 |
| `./node_modules/.bin/tsc --noEmit -p .` | 출력 없음 |
| `npm run build` | 성공(라우트 `/`·`/_not-found`·`/refund-policy`). 아직 어떤 라우트도 `db.ts` 를 import 하지 않으므로 **R-13 은 미검증**(T-M1-3 몫) |
| `npm install`(2회) | exit 0, ERESOLVE 0 |
| `npm ls` | invalid/missing 0 |

---

## ⑥ T-M1-2(스파이크 판정)가 알아야 할 것 · 막힌 점

1. **S-1~S-4 가 모두 통과** → research 「실패하면」 열의 대체 경로(advisory lock · `withPgTransaction`)가 필요하다는 근거는 이번 실측에 없다. 판정은 메인 몫이라 고르지 않았다. `withPgTransaction` 은 `db.ts` 에 준비만 돼 있다.
2. **계획 전제 두 개가 rc.24 에서 바뀌었다.**
   - plan §0·D3 「설치본 문서에 격리 수준·`FOR UPDATE` API 가 없다」 → rc.24 문서에는 ORM·빌더의 `.forUpdate()`/`.forNoKeyUpdate()`(queries-postgres.md 「Transactions」)와 `db.transaction(fn, { isolationLevel, timeout })` 타입이 있다. S-5 에서 옵션 방식도 실측 통과. raw 레인 대신 이것을 쓸지는 T-M1-2 판단. 문서 Pitfall 13: FK 로 참조되는 부모 행은 `forUpdate()` 대신 `forNoKeyUpdate()` 를 권한다.
   - plan D11 「`@effect/vitest` peer `<5` 라 vitest 4」 → 지금은 `>=5 <6`. 4.1.12 는 ERESOLVE 없이 들어가지만(별도 5.1.1 이 중첩) 근거 문장은 고쳐야 한다.
3. **S-3 의 한계**: 풀 기본 최대 연결이 10이라 동시 20건 중 실제로 DB 에서 겹친 것은 최대 10건이다. 결과(1 성공·19건 0행·오류 0)는 유효하지만 「20 연결 동시」 실측은 아니다. 필요하면 `new Pool({ max: 20 })` 로 다시 잴 수 있다.
4. **S-2 측정 방식**: B 는 잠근 뒤 pid 조회를 한 번 하고 보냈다. 대기 812ms ≈ HOLD 800ms, B 완료(814ms)가 A 커밋 완료(813ms) 직후 — 막힘이 확인된다.
5. **package.json 의 `overrides` 2항목**(④)은 메인이 받아들일지 정해야 한다. 되돌리면 `prisma contract emit` 이 다시 `CLI.UNEXPECTED` 로 막힌다.
6. **globalSetup 은 지금 `prisma db update`** 로 테스트 DB 를 맞춘다(마이그레이션이 아직 없어서). S0-2 가 마이그레이션을 만들면 `prisma db migrate` 로 바꿔야 plan D11 과 맞는다. `db:migrate` 스크립트는 `prisma db migrate` 로 넣어 두었다.
7. `db:seed`(`node scripts/seed.ts`)는 이름만 있다 — `scripts/seed.ts` 는 T-A2-1(시드 스크립트)이 만든다. Node 24 의 타입 제거 실행에 기댄다(미검증).
8. 개발 DB `kdance_next` 에는 아직 아무것도 적용하지 않았다(테스트 DB `kdance_next_test` 에만 골격 2테이블 + `prisma_contract` 표식).
9. 공용 파일·다른 Task 파일은 건드리지 않았다. `_workspace/penpot-gap/` 도 건드리지 않았다.
