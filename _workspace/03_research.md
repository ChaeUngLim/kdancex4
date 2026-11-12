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

## 4. 선행 조건 — 아직 확인하지 못한 환경

| 항목 | 상태 | 해야 할 일(사용자 또는 Phase 5 첫 Task) |
|---|---|---|
| Docker Desktop | **꺼져 있음** — `docker` 명령이 「could not be found in this WSL 2 distro」(Phase 2 실측) | Windows 에서 Docker Desktop 실행 → `docker compose -f infra/docker-compose.yml up -d` |
| `kdance-db` 상태 · `kdance` 의 `alembic_version` | **미확인** | `docker exec kdance-db psql -U kdance -d kdance -c '\dt'` |
| 새 DB 2개 | 없음 | `CREATE DATABASE kdance_next OWNER kdance` · `CREATE DATABASE kdance_next_test OWNER kdance` |
| backend 186 passed 기준선 | 2026-09-23 값 | DB 띄운 뒤 이관 착수 **전에** 한 번 돌려 기준선을 다시 잰다 |

DB 없이 할 수 있는 것: S0-M3(순수 로직 이식) 전부, 계약 작성·`contract emit`, mobile 화면 골격. DB 가 있어야 하는 것: S0-M1 스파이크, `db migrate`, DB 테스트 전부.
