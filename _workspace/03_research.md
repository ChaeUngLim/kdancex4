# Phase 3(구현 계획) 산출물 — 미확정 조사와 실측 계획

- 작성 2026-11-06 · 「실측」 = 이 환경에서 명령이나 설치본 문서로 확인 / 「미검증」 = 문서·추론뿐이고 돌려 보지 않음
- 실측 Task 는 S0-M1(기반·스파이크) 슬라이스의 **첫 Task** 가 한 파일(`admin-web/tests/spike/r2-prisma8.db.test.ts`)로 돌린다. 결과에 따라 plan 의 대체 경로를 고른다

---

## 1. 버전 실측값

`admin-web/node_modules/*/package.json` 을 2026-11-06 에 읽은 값. 확정표는 기술 스택 문서 「11. 기술 스택 고정표」.

| 패키지 | 선언 | 설치 | 비고 |
|---|---|---|---|
| Node.js | — | v24.22.0 | `Temporal` 전역 없음 → polyfill 필요(Prisma 8 문서: Node 26.8.2 부터 내장) |
| next | ^16.3.5 | 16.3.5 | |
| typescript | ~6.0.3 | 6.0.3 | |
| prisma(CLI) | ^8.0.0-rc.15 | 8.0.0-rc.15 | |
| @prisma/orm-postgres | ^8.0.0-rc.11 | 8.0.0-rc.11 | CLI 와 rc 번호가 다르다. CLI 가 「skills out of date — `prisma skills sync`」 경고(Phase 2) |
| @prisma/cli-engine | **선언 없음** | 0.4.0 | `prisma.config.ts` 가 `definePrismaConfig` 를 여기서 import 한다 → 직접 선언 필요 여부 확인(R-04) |
| better-auth | ^1.7.5 | 1.7.5 | `overrides` 로 prisma peer 덮음 |
| @better-auth/kysely-adapter | (전이) | 1.7.5 | |
| kysely | **선언 없음** | 0.29.6 | 인증 경로가 기대므로 직접 선언 대상 |
| pg | **선언 없음** | 8.22.0 | BYO 풀(plan D3)로 직접 쓰므로 직접 선언 대상. `@types/pg` ^8.23.1 은 선언돼 있음 |
| temporal-polyfill | ^1.0.5 | 1.0.5 | exports 에 `./full/global` 있음(실측) |
| zod | ^4.6.5 | 4.6.5 | |
| vitest | **선언 없음** | 4.1.11 | 레지스트리 `latest`=5.1.0, `V4`=4.1.12(Phase 2 실측). `@effect/vitest` peer `>=4.1.0 <5.0.0` |
| expo / react-native | ~58.0.23 / 0.88.1 | 58.0.23 / 0.88.1 | 2026-11-06 T-A5-0(Expo·RN 정식판 올림)에서 preview.6 / rc.1 → 정식판. react 19.3.0 그대로. `bundledNativeModules.json`(58.0.23) 핀: expo-router ~58.0.30 · react-native-screens ~4.30.1 · react-native-safe-area-context ~5.11.1 · expo-secure-store ~58.0.2 · expo-linking ~58.0.16 · expo-constants ~58.0.15 · expo-status-bar ~58.0.4 · react-native-web ~0.21.4 · react-dom 19.3.0 |
| mobile: T-A5-1(라우터·API 클라이언트·세션) 설치분 | expo-router ~58.0.30 · react-native-screens ~4.30.1 · react-native-safe-area-context ~5.11.1 · expo-secure-store ~58.0.2 · expo-linking ~58.0.16 · expo-constants ~58.0.15 | 58.0.30 · 4.30.1 · 5.11.1 · 58.0.2 · 58.0.16 · 58.0.15 | `mobile/node_modules/*/package.json` 실측. 전이 react-dom 은 `overrides: {"react-dom": "$react"}` 로 19.3.0(이전 19.3.1) |

새로 선언할 것(Phase 5, 설치는 core-rules 「올리기 전에」 5단계): admin-web `pg`·`kysely`·`vitest@~4.1.12`(+필요 시 `@prisma/cli-engine`), mobile 은 `npx expo install` 로 위 핀 버전. `--legacy-peer-deps` 금지.

---

## 2. 닫힌 질문 — 근거

| 질문 | 결론 | 근거 |
|---|---|---|
| Q7(PG 결정 상태) | **모순이 아니라 층이 다르다.** 「포트원(PG 중계) 채택」은 정책 문서(`docs/policy/payment-method-policy.md` 86행 부근)에서 확정, 「그 뒤의 PG사 계약」은 미정(기술 스택 표 Payment 행 「포트원 경유 PG — 미정(계약 전)」). 가짜 어댑터는 **포트원 V2 응답 모양**을 유지한다 | 두 문서 실측. SCH 문서 문구 「PG 미선정」을 「포트원 경유, PG사 계약 전」으로 고치는 일은 Phase 9.5(학습 주석 재구성·SCH 가이드 생성) 때 |
| Q8(만료 뒤 입금 처리) | **확정하지 않고 전액 돌려줄 대상으로만 기록**(`payment_exceptions`, kind `deposit_on_closed_order`). `expired` 는 끝 상태로 고정. 금액이 다르면 FR-290(금액 불일치 입금) | 2026-11-06 사용자 결정(plan U3) — spec FR-292(만료 뒤 늦은 입금)가 같은 내용으로 개정됐고 FR-298(주문 상태 6종)과의 충돌이 사라졌다 |
| Q9(캘린더의 뜻) | 앱 안 캘린더 기록 | Phase 2 E-3 |
| Q10(테스트 러너) | vitest 4.1.x | 1절 peer 실측. plan D11 |
| Q11(슬롯 잠금 수단) | DB 만(조건부 UPDATE) | plan D8 |
| Q12(알림 기록 형태) | 테이블 기록 + 조회 API | plan D7 |

---

## 3. 미확인 목록 — 실측 계획

| ID | 무엇이 미확인인가 | 왜 중요한가 | 실측 방법(S0-M1 스파이크) | 실패하면 |
|---|---|---|---|---|
| R-01 | `db.transaction` 콜백에서 throw 하면 그 안의 `tx.orm`·`tx.sql`·`tx.raw` 쓰기가 **모두** 롤백되는가 | FR-289(확정 후 일괄 처리)의 원자성 전부가 여기에 선다 | S-1: tx 안에서 ORM INSERT + SQL 빌더 UPDATE + raw UPDATE → throw → 세 쓰기 모두 없는지 | BYO `pg.Pool` 에서 직접 `BEGIN/COMMIT` 하는 `withPgTransaction` 으로 쓰기 경로를 옮긴다 |
| R-02 | tx 안 raw 레인이 **같은 연결**을 쓰고 `SELECT … FOR UPDATE` 가 실제로 잠그는가 | 이관 취소 1단계 | S-2: 연결 A tx 에서 `FOR UPDATE` 후 대기, 연결 B 의 같은 행 UPDATE 가 A 커밋 전까지 막히는지(시각 측정) | `pg_advisory_xact_lock(hashtextextended(id,0))` raw → 그것도 안 되면 `withPgTransaction` |
| R-03 | 조건부 UPDATE(`held+confirmed < capacity`) 가 동시 20건에서 정원을 넘지 않는가. SQL 빌더가 칸끼리 비교식을 표현하는가 | AC-6(정원 정합성) · SC-005(정원 초과 0건) | S-3: 남은 자리 1개에 `Promise.all` 20건 → 성공 1, `affectedRows` 확인. 빌더가 못 쓰면 raw | raw 레인으로 쓴다(의미는 같다) |
| R-04 | `prisma.config.ts` 가 import 하는 `@prisma/cli-engine` 을 직접 선언해야 하는가 · `prisma orm init --skip-install` 이 무엇을 쓰는가 | 스캐폴딩 첫 단계 | `prisma orm init --target postgres --authoring psl --skip-install` 를 **임시 복사본**에서 돌려 생성 파일 확인 | 생성 결과를 손으로 옮긴다 |
| R-05 | PSL `@default(uuid())` 가 DB 기본값인가 앱 생성인가 · UUIDv7 지원 | PK 생성 위치 | `migration plan` 결과 `migration.ts`·`ops.json` 의 DDL 확인 | 앱에서 `uuidv7` 생성(계획 기본값) |
| R-06 | `updated_at` 자동 갱신 속성 유무 | 감사 칸 정확성 | `contract.md`·PSL README 재확인 | 앱이 직접 넣는다(계획 기본값) |
| R-07 | ON CONFLICT DO NOTHING RETURNING 이 **부분 유니크 인덱스** 충돌에도 행 없이 돌아오는가 | 옛 SAVEPOINT 대체(이중 환불 방지) | S-4: `uq_refunds_reservation_id_active` 충돌 INSERT → 예외 없이 0행 | 충돌 대상 없는 `ON CONFLICT DO NOTHING` 은 모든 유니크에 적용되므로 PostgreSQL 사양상 된다 — 실측으로 확정만 |
| R-08 | tx 안에서 `SET TRANSACTION ISOLATION LEVEL …` raw 가 첫 문장으로 먹는가 | 격리 수준 선택지 | S-5: tx 첫 문장으로 실행 후 `SHOW transaction_isolation` | 쓰지 않는다 — 계획은 READ COMMITTED + 조건부 UPDATE 로 설계됐다(D3). 정보용 |
| R-09 | Prisma 가 돌려주는 `Temporal.Instant` 가 `temporal-polyfill/full/global` 의 클래스와 같은가(왕복·비교) | 기한·KST 판정 | S-6: timestamptz INSERT → 읽기 → `Temporal.Instant.compare` | 칸을 `TimestamptzString` 로 바꾸고 경계에서 변환 |
| R-10 | Better Auth 1.7.5 + Kysely 어댑터가 **`auth` 스키마**에 테이블을 두는가(`search_path`) · bearer 토큰 응답 헤더 이름 · Next 16.3 Route Handler 에서 도는가 | 인증 전체 | S-7: `auth` 스키마 풀로 sign-in → 토큰으로 보호 경로 호출. 2026-09-24 스모크(`docs/agent/ai-coding-agent.html`)는 **public 스키마 기준**이라 다시 본다 | `public` 에 두고 테이블 이름 접두어 `auth_`, 계약에 `@@control(external)` |
| R-11 | 포트원 V2 웹훅 서명이 Standard Webhooks(HMAC-SHA256, `id.timestamp.body`)와 같은가 | 실 PG 전환 때 가짜와 모양 차이 | 1회차 실측 불가(키 없음). 포트원 공식 문서 확인을 SCH-29(PG 결제) 착수 때 | 가짜만 바꾸면 된다(포트 뒤라 서비스 영향 없음) |
| R-12 | `prisma db verify` 가 계약 밖 스키마(`auth`)·`prisma_contract` 를 문제 삼는가 | 검증선 | S0-M2 끝에서 `db verify` 실행 | `auth` 를 계약에 `external` 로 선언(계획 기본값) |
| R-13 | Next 16.3 빌드가 `contract.json`(`with { type: 'json' }`) import 와 `temporal-polyfill` 전역 주입을 Route Handler 번들에 넣는가 | `npm run build` 검증선 | S0-M1 끝에 헬스 경로 하나로 `next build` | `instrumentation.ts` 에서 polyfill 주입 / JSON 을 `fs` 로 읽기 |
| R-14 | vitest 4.1.12 를 최상위 devDependency 로 넣을 때 `ERESOLVE` 없음 | 러너 | `npm install -D vitest@~4.1.12 --dry-run` | 4.1.11(이미 설치된 값)로 고정 |
| R-15 | Expo 58 preview 의 웹 실행(react-native-web 0.21)이 뜨는가 | R5(mobile 동작 검증 수단 부재) 완화 | US1-A5 에서 `npx expo start --web` + Playwright 스냅샷 | 못 뜨면 mobile 은 `tsc` + API E2E(AC-10)로 갈음하고 **「화면 미검증」** 으로 적는다 |
| R-16 | 이관 취소의 24시간·비율표 규칙이 정규 과정 환불(SCH-32(정규 과정 환불))과 같은가 | 동작 보존 이관의 의미 | spec FR-293~FR-295(대표 환불 입력·실행) 대조 결과: **다르다** — spec 은 대표가 금액을 정하고 직접 실행한다 | 이관은 동작 보존, 정렬은 SCH-32·SCH-33 — plan U4(2026-11-06 사용자 확정) |

---

### 3-1. R2 스파이크 결과와 판정 (2026-11-19, T-M1-1 실측 · T-M1-2 판정)

Prisma 런타임 `@prisma/orm-postgres`·CLI `prisma` 모두 **8.0.0-rc.24**(사용자 결정). `tests/spike/r2-prisma8.db.test.ts` — `flock … npm run test:db` 6 passed, skip 0.

| 실험 | 결과 | 측정값 |
|---|---|---|
| S-1(R-01 tx 롤백) | 통과 | 콜백 throw → ORM INSERT · 빌더 UPDATE · raw UPDATE 셋 다 없음 |
| S-2(R-02 같은 연결·FOR UPDATE) | 통과 | FOR UPDATE 앞뒤 pid·xid 같음, 다른 연결의 UPDATE 가 약 812ms 기다렸다 A 커밋 직후 끝남 |
| S-3(R-03 동시 20건) | 통과 | 성공 1 · 0행 19 · 오류 0. T-M1-2 에서 풀 연결 수를 25로 늘려 다시 잼 — 실제 열린 연결 20(20건이 DB 에서 동시에 겹침) |
| S-4(R-07 부분 유니크 충돌) | 통과 | 예외 없이 0행, 그 뒤 같은 tx 계속 사용 가능 |
| S-5(R-08 격리 수준) | 통과 | tx 첫 문장 raw 로 `serializable` 적용 확인 |
| S-6(R-09 Temporal) | 통과 | 읽은 값이 polyfill 의 `Temporal.Instant` 와 같은 클래스, compare 0 |

**판정(T-M1-2, 메인)**: D3 의 기본 경로를 그대로 쓴다 — **Prisma `db.transaction` + 필요한 곳만 raw 레인**. 대체 경로(advisory lock·`withPgTransaction`)는 쓰지 않는다. `withPgTransaction` 은 비상용으로 `prisma/db.ts` 에 남겨 두되 새 코드에서 부르지 않는다.

**계획과 달라진 실측**
- rc.24 에는 `.forUpdate()`·`.forNoKeyUpdate()` 와 `db.transaction(fn, { isolationLevel })` 이 있다 — 계획 작성 때(rc.11) 없다고 본 것. 잠금은 빌더 API 를 먼저 쓰고, 표현 못 하는 식(칸끼리 덧셈 비교 등)만 raw 로 쓴다.
- prisma CLI rc.24 가 내부 툴체인 rc.18 을 싣고 와 `contract emit` 이 늘 실패했다(`CLI.UNEXPECTED … typeAlias`). `package.json` `overrides` 로 `@prisma/orm-toolchain: 8.0.0-rc.24`, `@prisma/composer-cli > @prisma/cli-engine: 0.9.0` 을 맞춰 풀었다(사용자 결정 2026-11-19, ERESOLVE 0 · `npm ls` invalid 0). 정식판이 나오면 overrides 를 뺀다.
- `@effect/vitest` 의 peer 가 `>=5 <6` 으로 바뀌어 vitest ~4.1.12 가 충돌 없이 들어간다(5.1.1 은 따로 중첩 설치) — D11 근거 문장 고칠 것.
- 기본 pg 풀은 연결 10개다. 동시성 시험은 `openTestDb({ poolMax })` 로 연결을 늘려야 실제로 겹친다.
- R-13(계약 JSON import·polyfill 경로의 `next build`)은 db.ts 를 import 하는 경로가 아직 없어 T-M1-3 에서 확인한다.

**R-10·R-13 결과(T-M1-3·T-M1-4, 2026-11-19)** — R-13: `app/api/health/route.ts` 가 `prisma/db.ts`(계약 JSON import·temporal polyfill)를 import 한 상태로 `npm run build` 통과, `instrumentation.ts` 불필요, `next start` 후 `GET /api/health` 200. R-10(S-7): `auth` 스키마 기본안 통과(테이블 4개, `set-auth-token` 헤더, Bearer 로 `get-session` 200, 틀린 비밀번호 401), 대체안도 통과 — **기본안 채택(메인 판정)**. 미검증: `auth.user` 와 Prisma 계약 사이 FK 관계(S0-3 에서 정한다), OTP(SP-8).

**SP-8(인증 앱 TOTP) 결과(S0-3.2, 2026-11-20)** — Better Auth 1.7.5 `two-factor` 플러그인이 `auth` 스키마·같은 BYO 풀에서 돈다. 시험: `admin-web/tests/spike/two-factor.db.test.ts` 4 passed, skip 0. 문자·이메일 OTP(`otpOptions.sendOTP` 미설정)·패스키는 끈 채 TOTP 만 돌렸다.

| # | 항목 | 결과 | 실측값 |
|---|---|---|---|
| 1 | 등록(`POST /two-factor/enable`) | 통과 | 200 · `otpauth://totp/K-DanceX4:…` URI · 백업 코드 10개 · `auth."twoFactor"` 테이블이 `auth` 스키마에 생김(`public` 침범 0) · 비밀값은 암호문으로 저장 · 확인 전 `verified=false`·`user.twoFactorEnabled=false` |
| 2 | 확인(`POST /two-factor/verify-totp`) | 통과 | 틀린 코드 401 · 맞는 코드 200 → `verified=true`·`twoFactorEnabled=true`, 세션이 새로 발급돼 이어짐 |
| 3 | 세션 발급(로그인 2단계) | 통과 | 2단계가 켜진 계정의 `sign-in/email` 은 `twoFactorRedirect=true`·`twoFactorMethods=["totp"]`, 코드 전 `get-session` null · 틀린 코드 401 · 맞는 코드 200 뒤 세션 생김 |
| 4 | `trust_device` 쿠키 | 통과 | `trustDevice:true` 로 확인하면 `trust_device` 쿠키 Max-Age 2592000(30일) · 그 쿠키만 가진 같은 기기는 코드 없이 세션 · 쿠키 없는 다른 기기는 다시 코드 요구 |

**계획과 달라진 실측**
- `twoFactor` 테이블이 `getMigrations` 로 함께 만들어져(생성 목록: user·session·account·verification·twoFactor) 별도 마이그레이션 코드가 필요 없다. `user` 에 `twoFactorEnabled` 칸이 더해진다 — S0-3 의 `auth.user` ↔ Prisma 계약 FK 설계 때 이 칸을 감안한다.
- 플러그인 기본 비율 제한이 `/two-factor/*` 에 10초당 3회다(기본 비활성 환경에서는 적용되지 않았다 — 운영에서는 로그인 화면 시나리오가 이 한도에 걸리지 않는지 따로 본다).
- 코드 시험은 `@better-auth/utils/otp` 의 `createOTP(secret).totp()` 와 `better-auth/crypto` 의 `symmetricDecrypt` 로 인증 앱을 흉내 냈다. 실제 인증 앱 앱(Google Authenticator 등)과의 상호 확인은 하지 않았다(미검증).
- 계정 잠금(기본 10회 실패 15분)·백업 코드 로그인·`/two-factor/disable` 은 이번 범위 밖이라 시험하지 않았다.

## 4. 선행 조건 — 아직 확인하지 못한 환경

| 항목 | 상태 | 해야 할 일(사용자 또는 Phase 5 첫 Task) |
|---|---|---|
| Docker Desktop | **꺼져 있음** — `docker` 명령이 「could not be found in this WSL 2 distro」(Phase 2 실측) | Windows 에서 Docker Desktop 실행 → `docker compose -f infra/docker-compose.yml up -d` |
| `kdance-db` 상태 · `kdance` 의 `alembic_version` | **미확인** | `docker exec kdance-db psql -U kdance -d kdance -c '\dt'` |
| 새 DB 2개 | 없음 | `CREATE DATABASE kdance_next OWNER kdance` · `CREATE DATABASE kdance_next_test OWNER kdance` |
| backend 186 passed 기준선 | 2026-09-23 값 | DB 띄운 뒤 이관 착수 **전에** 한 번 돌려 기준선을 다시 잰다 |

DB 없이 할 수 있는 것: S0-M3(순수 로직 이식) 전부, 계약 작성·`contract emit`, mobile 화면 골격. DB 가 있어야 하는 것: S0-M1 스파이크, `db migrate`, DB 테스트 전부.

### 3-2. 특일 정보 API 실측 (2026-11-19, S0-4.9·S0-4.10·S0-4.11 입력)

근거: 활용 가이드 v1.4(한국천문연구원, 2020-06-09)와 2026-11-19 실호출 1회. 키 값은 여기 적지 않는다.

| 항목 | 값 |
|---|---|
| 주소 | `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo` (공휴일만. 국경일은 `getHoliDeInfo`, 기념일 `getAnniversaryInfo`, 24절기 `get24DivisionsInfo`, 잡절 `getSundryDayInfo`) |
| 요청 | `serviceKey`(필수) · `solYear`(필수, 4자리) · `solMonth`(선택, 2자리 — 빼면 한 해 전체) · `numOfRows`(기본 10 → **100** 으로) · `_type=json`(기본 XML) |
| 응답 | `response.header.resultCode` `"00"` 이 성공. `response.body.items.item` 은 **1건이면 객체, 여러 건이면 배열** — 어댑터가 둘 다 받는다. 항목: `locdate`(숫자 `20260301`) · `dateName` · `isHoliday`(`Y`/`N`) · `dateKind`(`01` 국경일 · `02` 기념일 · `03` 24절기 · `04` 잡절) · `seq` |
| 실측 2026 | 22건, 전부 `isHoliday=Y`·`dateKind=01`. 대체공휴일 5건(`대체공휴일(삼일절)` 등)과 임시공휴일 `전국동시지방선거`(20260603)가 들어 있다. 가이드는 「제헌절은 getRestDeInfo 에서 제공되지 않는다」고 적었지만 2026 응답에는 `제헌절 Y` 가 있다 — **가이드보다 실제 응답을 믿는다** |
| 갱신 | 한 해치 일괄 연 1회. 공휴일은 6~8월 월력요항 발표 뒤 **2년 뒤 해**까지 먼저 올라온다. **임시공휴일은 최대 1일 안에** 반영된다. 대체공휴일 추가 지정은 대통령령 시행 뒤 |
| 한도 | 초당 30건(가이드). 일일 한도는 포털 신청 화면 기준 — 하루 1회 호출이라 걸리지 않는다 |
| 키 | 저장소 밖 `~/.config/kdance/public-data.env` 의 `PUBLIC_DATA_HOLIDAY_KEY`(권한 600). 포털 「일반 인증키」를 그대로 쓰고 `URLSearchParams` 로 넣는다(한 번 더 인코딩하지 않는다) |

**설계에 주는 영향**: 플랜 §6-7 의 「임시공휴일 제공 여부 미확인」은 **제공된다(하루 안에)** 로 닫힌다. 운영자 입력 칸(P9)은 그래도 둔다 — API 반영 전 하루와, 학원 사정 휴무 같은 API 밖 날짜 때문이다. 수집 작업은 올해와 다음 해 두 해치를 받아 `locdate` 기준으로 덮어쓴다.

### 3-3. 국세청 사업자 상태조회 API 실측 (2026-11-19, S1-1.25~S1-1.29 입력)

근거: Swagger(`https://infuser.odcloud.kr/api/stages/28493/api-docs`)와 2026-11-19 실호출 1회(가짜 번호 `0000000000`). 키 값은 여기 적지 않는다.

| 항목 | 값 |
|---|---|
| 주소 | `POST https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=<키>` (상태조회) · `POST …/v1/validate` (진위확인 — 번호·대표자·개업일 일치 여부) |
| 요청 | JSON `{"b_no": ["1234567890", …]}` — 하이픈 없는 10자리, **한 번에 최대 100개** |
| 응답 | `status_code: "OK"`, `request_cnt`, `match_cnt`, `data[]`. 항목 `b_stt_cd` **`01` 계속사업자 · `02` 휴업자 · `03` 폐업자**, `end_dt`(폐업일 YYYYMMDD), `tax_type_cd`(과세 유형) |
| 없는 번호 | 200 으로 오고 `b_stt_cd` 가 빈 문자열, `tax_type` 에 「국세청에 등록되지 않은 사업자등록번호입니다.」 — **빈 코드를 「계속사업자」로 읽지 않는다**(따로 `unknown`) |
| 키 미등록 | 401 `{"code":-4,"msg":"등록되지 않은 인증키 입니다."}` — 활용신청 전에 실측했다 |
| 한도 | 하루 100만 건(포털). 매일 1회 + 정산 직전 1회, 100개씩 묶어 부른다 |
| 키 | `~/.config/kdance/public-data.env` 의 `PUBLIC_DATA_NTS_KEY`(특일 정보와 같은 계정 키, 권한 600) |

### 3-4. SP-6(시간 작업 실행기) 결정 (2026-11-20, S0-4.4 · 메인 판정)

**결정: cron → 내부 경로.** 시간이 되면 OS 의 crontab 이 `cd admin-web && npm run -s job:run -- /api/internal/<작업>` 을 실행하고, 그 명령(`admin-web/scripts/run-internal-job.ts` → `lib/server/internal-job-runner.ts`)이 `X-Internal-Token` 헤더를 실어 POST 를 **한 번** 보낸다. 작업 본문은 언제나 `withInternalRoute`(S0-4.3) 뒤의 Route Handler 에 있다. 프로세스 안 타이머(`instrumentation.ts` 의 `register()` 에서 `setInterval`)는 쓰지 않는다. D15 의 「읽기 전 정리」(회원 화면을 읽기 직전에 만료된 결제 대기를 정리)는 그대로 둔다 — cron 은 「제때 정리」, 읽기 전 정리는 「화면 정확성」으로 역할이 다르다.

| 기준 | cron → 내부 경로 | 프로세스 안 타이머 |
|---|---|---|
| 베타(노트북) 실행 | 된다 — 실측: `cron` 서비스 `active`·`enabled`, `/usr/bin/crontab` 있음(WSL, systemd `running`) | 된다 — 단 `next start` 가 떠 있는 동안만 |
| 운영(Vercel, 기술 스택 고정표 Deploy 행) | 경로가 그대로 쓰인다(바깥에서 HTTP 로 부르는 방식이라 서버리스와 맞다) | **안 된다** — 서버리스 함수에는 계속 떠 있는 프로세스가 없다 |
| 서버가 여러 개일 때 | 한 곳(crontab)에서 한 번만 부른다 | 인스턴스마다 타이머가 돌아 중복 실행된다 |
| `next dev` | 영향 없음 | 핫 리로드 때 타이머가 겹쳐 쌓일 수 있다 |
| 손으로 다시 돌리기·시험 | 같은 명령 한 줄. 테스트가 그대로 부른다 | 타이머를 기다리거나 따로 문을 만들어야 한다 |
| 추가 의존성 | 없음(OS cron + node 24 타입 제거 실행) | 없음 |
| 놓친 회차 | 노트북이 꺼져 있으면 그 회차는 건너뛴다 — 작업이 멱등이고 「기한이 지난 것 전부」를 처리하므로 다음 회차가 따라잡는다(플랜 §6-7) | 같다(프로세스가 죽으면 건너뜀) |

**근거 문서(context7, 2026-11-20 조회)**
- Next.js `instrumentation.ts` 의 `register` 는 「새 서버 인스턴스가 시작될 때 한 번」 불린다 — 인스턴스마다 돈다는 뜻이라 타이머를 두면 인스턴스 수만큼 겹친다.
- Vercel Cron Jobs: Hobby 는 **하루 1번까지**, 그 시(時) 안 아무 때(±59분)에 `GET` 으로 부른다. Pro 부터 분 단위. 새 기능 Vercel Schedules 는 `POST` 기본, Hobby 도 15분 간격까지. 둘 다 인증을 `Authorization: Bearer <CRON_SECRET>` 로 한다.

**시험** — `admin-web/tests/unit/internal-job-runner.test.ts` 9 passed. 진짜 `node:http` 서버에 `withInternalRoute` 가드를 단 내부 경로를 띄우고, ① 실행기 함수 ② cron 이 부르는 명령 그 자체(`node scripts/run-internal-job.ts`, PATH·HOME 만 있는 빈 환경)로 불러 처리기가 **정확히 1회** POST 로 도는 것을 확인했다. 틀린 토큰은 401·처리기 0회·exit 1, 내부 경로가 아니거나 빈 토큰은 요청 전에 멈춘다. 실제 crontab 등록은 하지 않았다(사용자 PC 설정을 바꾸는 일이고, 아직 `/api/internal/**` 경로가 하나도 없다 — 각 작업 슬라이스가 경로를 만들 때 crontab 줄을 함께 적는다).

**열린 점(운영 전환 때 정한다, 이 Task 에서 정하지 않음)**
- Vercel 의 예약 호출을 쓰면 헤더가 `X-Internal-Token` 이 아니라 `Authorization: Bearer` 다. 가드가 둘 다 받게 할지, 바깥 cron(다른 서버·GitHub Actions 예약 등)이 지금 명령으로 Vercel 주소를 부를지 정해야 한다.
- Hobby 의 「하루 1번 · 15분 간격」 한도로는 10분마다 도는 작업(대타 요청 만료·`held` 만료 등, 플랜 §6-7)을 못 맞춘다. 무료 구간만 쓰는 규칙(core-rules 「외부 API 는 무료 구간 안에서만」)과 함께 사용자 결정이 필요하다.

### 3-5. SP-4(푸시 경로) 조사표 (2026-11-24, S7-1.1 · 문서 조사만 끝남, 실측 미완료)

**질문**: Expo 알림 + FCM 이 갤럭시 스토어 배포 빌드에서 무료로 도는가.

**지금까지의 답(문서 근거)**: 도는 길은 있다. FCM 은 **스토어가 아니라 기기의 Google Play 서비스**에 기대므로, 갤럭시 스토어로 받은 APK 도 같은 FCM 경로를 쓴다. 다만 **개발 빌드에서 푸시 1건을 받아 보는 실측은 아직 못 했다** — 이 PC 에 Android SDK·JDK·adb·에뮬레이터가 없고, Firebase 프로젝트(`google-services.json`)와 Expo 계정이 사람 손을 거쳐야 한다.

| 항목 | 답 | 근거 | 상태 |
|---|---|---|---|
| 알림 패키지 버전 | `expo-notifications ~58.1.8` · `expo-device ~58.0.5` · `expo-dev-client ~58.0.18` | `mobile/node_modules/expo/bundledNativeModules.json`(Expo 58 핀) | 실측. **아직 `mobile/package.json` 에 넣지 않았다**(실측 빌드를 할 수 없어 넣을 이유가 없다) |
| Expo Go 로 시험 가능한가 | 안 된다. SDK 53 부터 Expo Go 의 원격 푸시가 빠졌다 → 개발 빌드(`expo-dev-client`) 필요 | docs.expo.dev `push-notifications/sending-notifications-custom`(context7, 2026-11-24) | 문서 확인 |
| Android 에서 무엇이 필요한가 | Firebase 프로젝트의 `google-services.json` → `app.json` 의 `expo.android.googleServicesFile`, Expo 서버가 보내려면 FCM V1 서비스 계정 키를 EAS 자격증명에 올린다. 키 파일은 git 에서 뺀다 | docs.expo.dev `push-notifications/fcm-credentials` | 문서 확인 |
| Expo 푸시 서비스 비용 | 무료. 프로젝트당 초당 600건, 요청당 100건, 영수증 조회 1000건 | docs.expo.dev `push-notifications/faq` · `sending-notifications` | 문서 확인 |
| Expo 를 거치지 않는 길 | `getDevicePushTokenAsync` 로 기기 토큰을 받아 FCM HTTP v1 로 직접 보낸다(Expo 계정 없이 가능) | docs.expo.dev `push-notifications/faq` | 문서 확인 |
| FCM 비용 | 무료로 알려져 있다 | 이번 조사에서 Firebase 가격 문서를 직접 읽지 않았다 | **미확인** |
| 갤럭시 스토어 배포본이 FCM 을 받는가 | 받을 것으로 본다 — FCM 은 설치 경로와 무관하게 기기의 Google Play 서비스로 받는다. 국내 판매 갤럭시는 Play 서비스가 깔려 있다 | 일반 원리. 갤럭시 스토어 설치본으로 직접 받아 본 기록은 없다 | **미확인** |
| Play 서비스 없는 기기(일부 해외 기기 등) | 푸시가 오지 않는다 → 앱 안 알림함(플랜 D7 알림 기록)만 남는다 | 일반 원리 | **미확인** |
| 개발 빌드를 만드는 길 | ① EAS Build 클라우드(무료 플랜의 월 빌드 횟수 한도 있음 — 수치는 이번에 확인 못 함) ② 로컬 `expo run:android`(Android SDK·JDK 17 설치 필요) | 이 PC 실측: `adb`·`java`·`ANDROID_HOME` 없음 | **미확인**(한도) · 실측(로컬 도구 없음) |
| 개발 빌드에서 푸시 1건 수신 | 못 했다 | 위 두 길 모두 사람 승인이 필요(계정 생성·설치) | **미확인** |
| 서버 쪽 발송 경로(Expo Push API 형식) | 만들었다 — 토큰 등록 API(`POST`·`DELETE /api/me/push-tokens`) · 발송기 `adapters/expo-push-gateway.ts`(100건씩 자르기, 429·5xx·네트워크 오류는 1초·2초 백오프로 3번까지, 400 은 바로 실패, `DeviceNotRegistered` → 토큰 닫기) · 가짜 Expo 서버 `fakes/fake-expo-push-server.ts` | `tests/unit/expo-push-gateway.test.ts` 9 passed · `tests/db/push-tokens.db.test.ts` 7 passed · 가짜 서버 발송 1건 로그 `_workspace/evidence/S7-1.1/logs/push-sent-fake.log`(2026-11-24, S7-1.1) | 실측(가짜 서버). 진짜 `exp.host` 로는 보내지 않았다 |

**범위 조정(2026-11-24, 추천안·사후 확인)**: 실기기 수신 확인은 S8-2.9(실기기 푸시 수신 확인)로 옮겼다. `expo-notifications` 는 설치 승인 대상이라 이 Task 에서 넣지 않았다(`mobile/package.json` 그대로).

**실측을 끝내려면 사람이 할 일**: ① Firebase 프로젝트를 만들고 `com.kdancex3` Android 앱을 등록해 `google-services.json` 을 받는다(무료) ② 개발 빌드 방법을 고른다 — EAS(Expo 계정 로그인) 또는 로컬(Android SDK·JDK 설치 승인) ③ 실제 갤럭시 기기를 USB 로 잇거나 Play 서비스가 든 에뮬레이터를 준비한다. 그 뒤 `expo-notifications` 를 핀 버전으로 넣고 토큰을 받아 `https://exp.host/--/api/v2/push/send` 로 1건 보내 수신 화면을 찍는다.

### 3-6. SP-7(Expo 웹으로 앱 화면 검증) 결과 (2026-11-24, M3-END.2(Expo 웹 실행 시도) · 실측)

**질문**: 앱(mobile) 화면을 Expo 웹으로 띄워 Playwright 로 몰 수 있는가(R5(mobile 동작 검증 수단 부재) · 플랜 「SP-7(Expo web)」 행).

**답: 된다.** 가입부터 결제 대기까지 Playwright MCP(Chrome for Testing 159, 390×844)로 사람처럼 눌러 끝까지 갔다. 가짜 응답 없이 진짜 서버(admin-web :3000, `KDANCE_DEV_ROUTES=true`)와 개발 DB(`kdance_next`)에 붙었다.

| 항목 | 답 | 근거 | 상태 |
|---|---|---|---|
| 웹 의존성 | `react-native-web 0.21.4` · `react-dom 19.3.0`(`overrides` 로 react 에 맞춤) — 이미 `mobile/package.json` 에 있어 `expo install` 을 다시 돌리지 않았다(새 설치 0) | `_workspace/evidence/M3-END.2/logs/npm-ls-web.log` | 실측 |
| 실행 명령 | `cd mobile && EXPO_PUBLIC_API_URL=http://localhost:3000 ./node_modules/.bin/expo start --web --port 8081` | `logs/expo-web-up.log`(`/login` 200) | 실측 |
| 서버 쪽 조건 | admin-web 이 `KDANCE_DEV_ROUTES=true` 일 때만 `http://localhost:8081` 출처에 CORS 를 연다(`admin-web/proxy.ts`, 2026-11-23) | `_workspace/evidence/app-web-live-demo-2026-11-23/` | 실측 |
| 토큰 보관 | 웹에는 SecureStore 가 없어 메모리에만 둔다 → 새로고침하면 로그아웃. 한 흐름은 새로고침 없이 이어서 몰아야 한다 | `mobile/lib/session.ts` | 실측 |
| 지나간 화면 | 로그인 → 약관 동의 → 가짜 본인확인 → 가입 정보 → 취향 → 기준 장르 → 홈 → 수업 상세 → 결제하기 → 결제 대기(승인 대기) | `shots/01~08`·`가입.png`·`결제-대기.png` | 실측 |
| 서버에 남은 결과 | 회원 행(닉네임 서연·여·기준 장르 살사/바차타) · 주문 pending 140,000원 · 결제 card ready | `logs/db-after-flow.log` | 실측 |
| 콘솔 오류 | 1건 — 가입 전 `GET /api/me` 403(SIGNUP_INCOMPLETE, 앱이 약관 동의로 보내는 정상 흐름) | 증거 EVIDENCE.md | 실측 |
| 웹에서 못 보는 것 | 네이티브 전용 기능(SecureStore·푸시·카메라)과 기기 글꼴·안전 영역. 이 부분은 실기기(S8-2) 몫 | 일반 원리 | 미검증 |
| 같이 보인 것 | 가입 화면들 머리말에 라우터 기본 제목(`signup`·`identity` 등 영어 경로 이름)이 보인다 | `shots/가입.png` | 열린 점(이 Task 범위 밖) |

**판정**: 앱 화면 검증은 Expo 웹 + Playwright 를 기본으로 쓴다(「화면 미검증」으로 남기지 않는다). 시연 계정은 `admin-web/scripts/dev-demo-app-signup.ts`(가입 전 로그인 계정 `demo-signup@example.com`)로 만든다.
