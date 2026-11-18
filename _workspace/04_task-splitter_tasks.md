# Phase 4(Task 분리) — US1(수업 찾아 결제) 1회차 + 취소·환불 7테이블 Prisma 8 이관

- 작성 2026-11-06 · 입력: `03_impl-planner_plan.md`(§4·§5·§7·§9) · `03_data-model.md` · `03_contracts/` · `03_research.md` · `01_req-analyst_requirements.md` · `02_code-searcher_structure.md`
- 코드·spec·plan 문서는 고치지 않았다. 슬라이스 경계는 plan §5 의 10개를 그대로 따랐고, 바꾸고 싶은 점은 맨 끝 「제안」 절에만 적었다
- 경로 표기: 앞에 `mobile/` 이 없으면 **`admin-web/` 기준 상대 경로**다. DB 테스트 파일은 `*.db.test.ts`(plan D11 — vitest `db` 프로젝트)

---

## 요약 — Phase 5(구현) 전에 사용자가 알아야 할 것

1. **첫 구현 전에 할 일은 하나다: Windows 에서 Docker Desktop 켜기**(T0(DB 기동·새 DB 2개·기준선 재측정)). DB 가 있어야 T-M1-1(R2 스파이크)부터 시작하는 주 경로가 열린다. DB 없이도 T-M3-1(값 상수·금액·시각 도우미)·T-A5-1(mobile 라우터·API 클라이언트)은 지금 시작할 수 있다
2. **승인이 필요한 Task 는 T-M9-1(backend 삭제·DB 이름 회수) 하나**다. Phase 5(구현)의 자동 진행에서 빠지며, 착수할 때 U5(`backend/` 삭제 시점)를 다시 묻는다
3. **가장 큰 위험은 R2(Prisma 8 트랜잭션·행 잠금 미검증)**. T-M1-1 이 실패하면 `prisma/db.ts` 아래만 대체 경로(raw `FOR UPDATE` → advisory lock → BYO `pg.Pool` 직접 트랜잭션)로 바뀌고 나머지 Task 구조는 그대로다
4. 두 번째 위험은 **병렬 에이전트가 같은 테스트 DB(`kdance_next_test`)를 동시에 TRUNCATE 하는 것**이다. DB 테스트는 `flock` 으로 한 번에 하나만 돌린다(「실행 규칙」)
5. 새 패키지(admin-web `pg`·`kysely`·`vitest`, mobile `expo-router` 등)는 사전 릴리스(Prisma 8 RC·Expo 58 preview·RN 0.88 RC) 위에 얹힌다. `ERESOLVE` 가 나면 `--legacy-peer-deps` 를 쓰지 않고 `overrides` 로 한 항목만 덮는다

---

## 실행 규칙 (모든 Task 공통)

| 규칙 | 내용 |
|---|---|
| 패키지 설치 | core-rules 「버전 정책」 「올리기 전에」 5단계(상위 고정 패키지 확인 → `peerDependencies` → 메이저 재편 → 깨진 검증선과 순서 분리 → 설치 뒤 실제 실행)를 완료 판정에 포함한다. **`--legacy-peer-deps` 금지.** 버전 값은 「11. 기술 스택 고정표」·`03_research.md` §1 에서 읽고 추정하지 않는다 |
| DB 테스트 직렬화 | 병렬 그룹 안이라도 DB 테스트 실행은 `flock /tmp/kdance-next-test.lock npm run test:db -- <파일>` 로 감싼다. 코드 작성은 병렬, DB 테스트 실행만 직렬 |
| 픽스처 소유 | `tests/setup/*`(globalSetup·TRUNCATE 헬퍼)는 S0-M1(기반·스파이크)만 쓴다. 이후 Task 는 자기 픽스처를 `tests/fixtures/<영역>.ts` 새 파일로 만들고 남의 픽스처 파일은 **읽기만** 한다 |
| `package.json` 소유 | admin-web 은 T-M1-1(R2 스파이크)만 고친다(의존성·scripts 전부). mobile 은 T-A5-1(라우터·API 클라이언트)과 T-A5-4(웹 실행 시도)만 고치며, 둘은 순서가 정해져 있다 |
| 주석 | 새 TS 소스 주석은 한국어, 공유 계약 번호(§4.1~§4.10)를 그대로 인용한다(plan §3) |
| 리뷰 | 모든 Task 의 산출물은 Phase 8(코드 리뷰)에서 `ecc:typescript-reviewer` 를 거친다. 아래 「ECC」 열은 구현 중에 쓰는 것만 적었다 |

---

## ① 사용자 선행 작업

| ID | 하는 일 | 누가 | 완료 판정 |
|---|---|---|---|
| **T0(DB 기동·새 DB 2개·기준선 재측정)** | ① Windows 에서 Docker Desktop 실행 — **에이전트가 할 수 없다**(꺼져 있으면 WSL 의 `docker` 가 「could not be found in this WSL 2 distro」를 낸다) ② 켜진 뒤 오케스트레이터가 `docker compose -f infra/docker-compose.yml up -d` → `docker exec kdance-db psql -U kdance -d kdance -c '\dt'`(`alembic_version` 유무 확인) → `CREATE DATABASE kdance_next OWNER kdance` · `CREATE DATABASE kdance_next_test OWNER kdance` → `cd backend && uv run pytest -q` | ① 사용자 ② 오케스트레이터 | `kdance-db`·`kdance-redis` healthy · `psql -l` 에 새 DB 2개 · backend **186 passed**(이 값이 AC-11(회귀)의 이관 중 기준선. 다르면 그 값을 새 기준으로 기록) |

참조: `03_research.md` §4(선행 조건) · plan §1. T0 에 의존하는 Task 는 아래 표의 「DB」 열이 ●다.

---

## ② S0-M1(기반·스파이크) — 선행 차단

완료선(plan §5): 스파이크 결과 표가 남고 대체 경로 선택이 기록됨 · `npm run build` 성공 · `npm test` 통과. SCH 대응: SCH-21(FastAPI→Next.js 전환) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-M1-1(R2 스파이크)** — 첫 Task | 스파이크를 돌릴 최소 바닥을 깔고 S-1~S-6 을 실측한다. `pg`·`kysely`·`vitest@~4.1.12` 선언(R-14 `--dry-run` 먼저, 실패 시 4.1.11 고정), scripts 6종(`test`·`test:unit`·`test:db`·`db:emit`·`db:migrate`·`db:seed`), R-04(`prisma orm init` 을 **임시 복사본**에서), 스파이크용 골격 계약(자리 묶음 1개 + 부분 유니크 1개), BYO 풀 `db.ts`, vitest 2프로젝트·globalSetup(DB 접속 실패 시 `db` 프로젝트 skip)·TRUNCATE 헬퍼. `prisma skills sync` 경고(R-P6(사전 릴리스 묶음))도 확인 | research §3 R-01·R-02·R-03·R-04·R-07·R-08·R-09·R-14 · plan D3·D11·D17 · data-model §4-4 | `package.json` · `package-lock.json` · `prisma.config.ts` · `prisma/contract.prisma`(골격) · `prisma/db.ts` · `vitest.config.mts` · `tests/setup/global-setup.ts` · `tests/setup/db.ts` · `tests/spike/r2-prisma8.db.test.ts` · `.env.example` | `flock … npm run test:db -- tests/spike/r2-prisma8.db.test.ts` → S-1~S-6 **6개 모두 실행(skip 0)**. 스파이크는 판정용이라 「실패」도 결과다 — 각 S 의 통과·실패와 근거(시각 측정값, 영향 행 수)를 Task 보고에 표로 남긴다 · `npm install` 이 `ERESOLVE` 없이 끝남 |
| **T-M1-2(스파이크 판정·대체 경로 확정)** | T-M1-1 결과로 D3 의 경로를 하나 고른다(통과 → Prisma `db.transaction` + raw 레인 / R-01 실패 → `withPgTransaction` / R-02 실패 → `pg_advisory_xact_lock`). `db.ts` 에 고른 경로와 `withPgTransaction` 을 확정하고, 결과 표를 research 에 반영한다(AC-14(R2 스파이크)) | research §3 「실패하면」 열 · plan D3·R2 행 | `prisma/db.ts` · `_workspace/03_research.md`(결과 표 절 추가) · `tests/spike/r2-prisma8.db.test.ts`(판정 단언으로 고정) | 위 스파이크 명령 → 6 passed(고른 경로 기준으로 단언을 고친 뒤) · research 에 「선택: ○○ 경로, 근거: S-n」 1줄 |
| **T-M1-3(헬스 경로·빌드 검증선)** | `/api/health` 를 만들고 옛 `test_health.py` 1개를 이식한다. 헬스 경로가 `db.ts`(contract.json import·polyfill)를 import 하게 해서 R-13 을 `next build` 로 확인한다. 막히면 `instrumentation.ts` 로 polyfill 주입 | contracts `README.md` §1(헬스) · research R-13 | `app/api/health/route.ts` · `tests/unit/health.test.ts` · (필요 시) `instrumentation.ts` | `npm run build` 성공 · `npm run test:unit -- tests/unit/health.test.ts` → 1 passed |
| **T-M1-4(Better Auth 스모크)** | Better Auth 1.7.5 + Kysely 어댑터 + 같은 BYO 풀 + `auth` 스키마 + `bearer` 플러그인으로 sign-in → 토큰 → 보호 호출을 실측한다(research S-7). 실패 시 `public` 스키마 + `auth_` 접두어 대체 | research R-10 · plan D10 · contracts `01-member-onboarding.md` §1 · `docs/agent/ai-coding-agent.html`(2026-09-24 스모크 기록) | `lib/server/auth.ts` · `app/api/auth/[...all]/route.ts` · `tests/spike/r10-better-auth.db.test.ts` | `flock … npm run test:db -- tests/spike/r10-better-auth.db.test.ts` → passed · 보고에 「`auth` 스키마 사용 가능 여부 · bearer 응답 헤더 이름」 2줄 |
| **T-M1-5(M1 기록 마감)** | M1 실측값을 문서에 남긴다: CLAUDE.md 「Build, Test & Verify」 에 admin-web `npm test` 행·기대 결과, 기술 스택 문서 「11-2. 알려진 위험」 에 R2·R-10·R-13 결과와 vitest 선언, research 에 R-10·R-13 결과 | plan §4-3 | `CLAUDE.md` · `docs/planning/kdancex4_service_definition_and_tech_stack.md` · `_workspace/03_research.md` | `npm test` 전체 통과(DB 기동 상태) · 세 문서의 추가 줄이 실제 실행 결과 수치와 일치 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-M1-1 | T0 | — | ● | `ecc:prisma-patterns` · `ecc:postgres-patterns` · `ecc:docs-lookup`(context7) | 메인(판정이 섞임) |
| T-M1-2 | T-M1-1 | — | ● | `ecc:prisma-patterns` · `ecc:database-reviewer` | 메인 |
| T-M1-3 | T-M1-2 | [P] | — | `ecc:nextjs-turbopack` · `ecc:build-fix` | Sonnet |
| T-M1-4 | T-M1-2 | [P] | ● | `ecc:security-review` · `ecc:docs-lookup`(Better Auth) | Sonnet |
| T-M1-5 | T-M1-3 · T-M1-4 | — | ● | — | Haiku |

---

## ③ S0-M2(데이터 계약) — 선행 차단

완료선: `prisma db migrate` 가 두 DB 에 적용 · `prisma db verify` 통과 · 제약 테스트 통과. SCH 대응: SCH-21(FastAPI→Next.js 전환)·SCH-26(수업·회차 등록) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-M2-1(전체 데이터 계약·초기 마이그레이션)** | 스파이크 골격을 data-model 전체(20테이블 + `auth` external)로 바꾼다. 제약 이름은 `name:` 에 옛 이름 접두어, `map:` 금지(D1). `contract emit` → `migration plan --name initial` → 두 DB 에 `db migrate` → `db verify`. R-05(uuid 기본값 위치)·R-06(updated_at 자동 갱신)·R-12(`auth` 스키마 verify) 결과를 보고 | data-model §0·§1·§2·§3 · plan D1·D2·D5·D13 · research R-05·R-06·R-12 | `prisma/contract.prisma` · `prisma/contract.json` · `prisma/contract.d.ts`(생성물) · `migrations/app/<시각>_initial/`(생성물) | `npm run db:migrate`(개발·테스트 DB 각각) 성공 · `npx prisma db verify` 통과 · `npm run build` 성공 |
| **T-M2-2(값 집합 계약 일치 테스트)** | T-M3-1 이 만든 `constants.ts` 의 §4.1 값 집합이 계약 PSL enum 과 **문자 단위로** 같은지 대조하는 테스트를 쓰고, 다르면 `constants.ts` 를 고친다(§4.2(값 소유 모듈)) | data-model §3 끝(§4.2) | `tests/unit/constants-contract.test.ts` · `lib/domain/constants.ts`(불일치 시만) | `npm run test:unit -- tests/unit/constants-contract.test.ts` → passed(§4.1 표의 칸 수만큼 사례) |
| **T-M2-3(DB 제약 테스트)** | CHECK·유니크·부분 유니크가 실제로 막는지 DB 에서 확인한다. 최소: `ck_seat_pools_not_over`(`held+confirmed<=capacity`) · `uq_refunds_reservation_id_active` · `uq_reservations_member_offering_active` · `uq_payments_order_live` · `ck_orders_total_formula` · `uq_members_identity_ci_hash` · `uq_webhook_events_webhook_id` · 상태 CHECK(§4.1) | data-model §2-1·§2-2 | `tests/db/constraints.db.test.ts` | `flock … npm run test:db -- tests/db/constraints.db.test.ts` → passed(위 8종 이상, 각각 위반 INSERT 가 거부됨) |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-M2-1 | T-M1-2 | — | ● | `ecc:prisma-patterns` · `ecc:database-migrations` · `ecc:database-reviewer` | Sonnet |
| T-M2-2 | T-M2-1 · T-M3-1 | [P] | — | `ecc:tdd-workflow` | Haiku |
| T-M2-3 | T-M2-1 | [P] | ● | `ecc:postgres-patterns` · `ecc:tdd-workflow` | Sonnet |

---

## ④ S0-M3(순수 로직 이식) — DB 불필요, 지금 시작 가능

완료선: `npm run test:unit` 통과 · 이관 대응표의 해당 행 채움. SCH 대응: SCH-21 일부, 옛 SCH-03(환불액 산정)·SCH-04(어댑터 3종: PG/알림/슬롯락) 이식.

> **T-M1-1(R2 스파이크) 전의 검증 방법.** vitest 설정·scripts 는 T-M1-1 이 만든다. 그 전에는 이미 전이 설치된 vitest 4.1.11 로 파일 단위 실행한다: `cd admin-web && npx vitest run <파일>`. T-M1-1 이 `npm install` 하는 동안에는 돌리지 않는다. 슬라이스 완료 판정(`npm run test:unit`)은 T-M1-1 뒤에 한다

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-M3-1(값 상수·금액·시각 도우미)** | §4.1 값 집합을 `as const` 로 소유하는 `constants.ts`, BigInt 올림 나눗셈 `ceilMulDiv`·가격 내역 `computePriceBreakdown`(정가→혜택 할인→쿠폰→예매 수수료→최종, 0 줄도 포함), `Clock` 타입과 KST 하루 중 시각·날짜 판정 도우미(`time.ts`, polyfill import 포함) | data-model §3 · contracts `README.md` §3(§4.6) · `06-ports.md` §4.3 · plan D4 | `lib/domain/constants.ts` · `lib/domain/money.ts` · `lib/domain/time.ts` · `tests/unit/money.test.ts` · `tests/unit/time.test.ts` | `npx vitest run tests/unit/money.test.ts tests/unit/time.test.ts` → passed · 안전 정수 초과 입력이 예외 · KST 자정 경계 사례 포함 |
| **T-M3-2(환불액 산정 이식)** | 옛 `refund_policy.py` 의 `calculate_refund` 와 테스트 50개를 1:1 로 옮긴다(경계·올림·티어 해석·입력 오류). §4.4 JSONB 형태 그대로 | `06-ports.md` §4.3·§4.4 · structure A-4(`test_refund_policy.py` 50) | `lib/domain/refund-policy.ts` · `tests/unit/refund-policy.test.ts` | `npx vitest run tests/unit/refund-policy.test.ts` → **50 passed 이상**(옛 사례마다 1개) |
| **T-M3-3(결제 기한 산정)** | `computeDueAt` — 가상계좌 = 발급 뒤 24시간과 첫 회차 1시간 전 중 이른 쪽, 카드 = 15분. 설정값은 환경 변수 3종에서 | `06-ports.md` §4.3 · `03-checkout-payment.md` §4 · plan D4 · R8(기한 계산 시간대) | `lib/domain/payment-deadline.ts` · `tests/unit/payment-deadline.test.ts` | `npx vitest run tests/unit/payment-deadline.test.ts` → passed(두 기한이 같은 순간·1초 차이 경계 포함) |
| **T-M3-4(PG 포트·가짜 PG·웹훅 검증기 이식)** | `PaymentGatewayPort` 4메서드, `FakePaymentGateway`(포트원 V2 응답 모양, 메모리 원장 `globalThis`, 옛 `parse_portone_cancel_response` 파서·멱등 이식), HMAC-SHA256 `WebhookVerifier`(Standard Webhooks 모양). 옛 `test_adapters.py` 의 PG 사례 이식 | `06-ports.md` §4.10 · plan D9 · research R-11 | `lib/server/ports/payment-gateway.ts` · `lib/server/ports/webhook-verifier.ts` · `lib/server/fakes/fake-payment-gateway.ts` · `lib/server/fakes/hmac-webhook-verifier.ts` · `tests/unit/adapters-pg.test.ts` | `npx vitest run tests/unit/adapters-pg.test.ts` → passed · 틀린 서명·오래된 timestamp 거부 사례 포함 |
| **T-M3-5(본인확인·알림 포트와 가짜 구현)** | `IdentityVerificationPort` + `FakeIdentityVerification`(HMAC 서명 토큰, CI = HMAC(pepper, personKey)) · `NotificationSenderPort` + `FakeNotificationSender`(호출 기록). 옛 알림 사례 이식, 슬롯 락 사례는 폐기(D8) | `06-ports.md` §4.10 · plan D7·D8·D10 | `lib/server/ports/identity.ts` · `lib/server/ports/notification-sender.ts` · `lib/server/fakes/fake-identity.ts` · `lib/server/fakes/fake-notification-sender.ts` · `tests/unit/adapters-identity-notification.test.ts` | `npx vitest run tests/unit/adapters-identity-notification.test.ts` → passed · 만료 토큰 `expired`, 위조 토큰 `invalid` |
| **T-M3-6(주입 지점·이관 대응표 M3분)** | 구상 구현을 고르는 유일한 곳 `deps.ts`(서비스는 deps 객체를 인자로 받는다 — 옛 `lru_cache` 싱글턴 대체). 이관 대응표를 만들고 `test_refund_policy.py` 50 · `test_adapters.py` 33 행을 채운다(1행 = 옛 테스트 1개 → TS 테스트 이름 또는 폐기 사유 1줄) | `06-ports.md` 머리말 · plan R-P1(이관 회귀 누락) | `lib/server/deps.ts` · `tests/unit/deps.test.ts` · `tests/migrated/migration-map.md`(신규) | `npm run test:unit` 전체 passed(T-M1-1 뒤) · 대응표 83행, 빈 칸 0 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-M3-1 | 없음 | [P] | — | `ecc:tdd-workflow` | Sonnet |
| T-M3-2 | T-M3-1 | [P] | — | `ecc:tdd-workflow` | Sonnet |
| T-M3-3 | T-M3-1 | [P] | — | `ecc:tdd-workflow` | Haiku |
| T-M3-4 | T-M3-1 | [P] | — | `ecc:tdd-workflow` · `ecc:security-review`(서명 비교) | Sonnet |
| T-M3-5 | T-M3-1 | [P] | — | `ecc:tdd-workflow` · `ecc:security-review` | Sonnet |
| T-M3-6 | T-M3-2~T-M3-5(이식 4종) · T-M1-1(러너) | — | — | `ecc:backend-patterns` | Sonnet |

---

## ⑤ S0-M4(취소 API 이관) — US1-A 와 병행

완료선: 옛 9개 시나리오 통과 · backend 186 passed 그대로 · build 성공. SCH 대응: SCH-21 일부, 옛 SCH-05(취소 오케스트레이션) 이식.

**T-M4-1 은 S0-M4 소속이지만 US1-A1(가입·취향)의 선행 조건이기도 하다**(`requireMember`·오류 형식을 둘 다 쓴다).

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-M4-1(공통 HTTP 계층)** | §4.8 오류 응답(`{detail, code}`, 검증 실패만 `fields`), zod 파싱 도우미, `requireMember`(세션 → `members.auth_user_id`, 401 `UNAUTHENTICATED`·403 `SIGNUP_INCOMPLETE`), `Idempotency-Key` 파싱(8~200자). 회원+세션 테스트 픽스처 | contracts `README.md` §2·§4·§5 · plan D14 | `lib/server/http.ts` · `tests/unit/http.test.ts` · `tests/fixtures/session.ts` · `tests/db/require-member.db.test.ts` | `npm run test:unit -- tests/unit/http.test.ts` passed · `flock … npm run test:db -- tests/db/require-member.db.test.ts` passed(401·403·통과 3사례 이상) · 500 응답에 스택·SQL 없음 |
| **T-M4-2(취소 서비스·경로 이관)** | 옛 11단계를 `05-cancellation-migrated.md` 표대로 옮긴다: 1단계 잠금은 T-M1-2 가 고른 경로, Refund INSERT 는 `ON CONFLICT DO NOTHING RETURNING`, 정원 −1 은 `seat_pools.confirmed_count`, calendar_entries 삭제, 알림은 트랜잭션 안 기록 + 커밋 뒤 발송, 슬롯 락 해제 삭제. `held` 예약은 409 `USE_ORDER_CANCEL`. 옛 DB 시나리오 9개 이식(동시 취소 2건 → 환불 1회 포함) — AC-13(이관 취소) | `05-cancellation-migrated.md` 전체 · data-model §4-1(`paid→refunded`)·§4-4 · plan D6·D7·D8 | `lib/server/services/cancellation.ts` · `lib/server/schemas/cancellation.ts` · `app/api/reservations/[id]/cancel/route.ts` · `app/api/reservations/[id]/cancellation-preview/route.ts` · `tests/fixtures/migrated.ts` · `tests/migrated/cancel-api.db.test.ts` | `flock … npm run test:db -- tests/migrated/cancel-api.db.test.ts` → **9 passed** |
| **T-M4-3(서비스·스키마 단위 테스트 이식)** | 옛 `test_cancellation_service.py` 36개 · `test_schemas.py` 39개를 의도 단위로 옮긴다. Python 구조 검사(소스 문자열·`lru_cache`·FastAPI 의존성)는 TS 식 의도(서비스가 포트만 import 하는가 등)로 다시 쓰거나 폐기 사유를 남긴다. 비율표 PUT 스키마 사례는 폐기(D12) | structure A-4 · E-1 ⑯ · plan D12 | `tests/migrated/cancellation-service.test.ts` · `tests/migrated/schemas.test.ts` | `npm run test:unit -- tests/migrated/` → passed · 옮기지 않은 사례 수를 보고에 적음(T-M4-5 가 대응표에 옮긴다) |
| **T-M4-4(admin-web 클라이언트·비율표 화면 정리)** | `api-client.ts` 기본 주소를 같은 출처 `/api` 로, `code` 읽기, 비율표 함수 2개 삭제. 비율표 화면·컴포넌트 삭제, 메뉴에서 제거, 대시보드 헬스 주소 변경(U4) | plan §4-1 마지막 3행 · D12 | `lib/api-client.ts` · `app/refund-policy/page.tsx`(삭제) · `components/RefundPolicySettings.tsx`(삭제) · `components/AdminNav.tsx` · `app/page.tsx` | `npm run build` 성공 · `grep -r refund-policy app components lib` 결과 0줄 |
| **T-M4-5(이관 대응표 M4분·이관 회귀 확인)** | 대응표에 `test_cancel_api.py` 9 · `test_cancellation_service.py` 36 · `test_schemas.py` 39 · `test_admin_refund_policy.py` 18(전부 폐기, U4) · `test_health.py` 1(T-M1-3) 행을 채운다. 186행 완성 | plan R-P1 · D12 · AC-11 | `tests/migrated/migration-map.md` | 대응표 **186행, 빈 칸 0** · `cd backend && uv run pytest -q` → T0 기준선 그대로 · `cd admin-web && flock … npm test` 전체 passed |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-M4-1 | T-M1-4 · T-M2-1 · T-M3-1 | [P] | ● | `ecc:api-design` · `ecc:error-handling` · `ecc:security-review` | Sonnet |
| T-M4-2 | T-M4-1 · T-M2-3 · T-M3-6 | [P] | ● | `ecc:postgres-patterns` · `ecc:tdd-workflow` · `ecc:security-reviewer` | Sonnet |
| T-M4-3 | T-M4-2 | [P] | — | `ecc:tdd-workflow` | Sonnet |
| T-M4-4 | T-M1-3 | [P] | — | `ecc:nextjs-turbopack` · `ecc:refactor-clean` | Haiku |
| T-M4-5 | T-M4-3 · T-M4-4 · T-M3-6 | — | ● | — | Haiku |

---

## ⑥ US1-A1(가입·취향)

완료선: AC-9(가입 정보) 통과(세 번째 항목은 T-A2-2 에서). SCH 대응: SCH-24(인증·역할) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-A1-1(가짜 본인확인·가입·내 정보)** | dev 전용 가짜 본인확인 경로(`KDANCE_DEV_ROUTES`), 가입 완료(이름·성별·생년·연락처는 본인확인 값, 가입 고지 확인 시각, 1인 1계정 409 `IDENTITY_ALREADY_USED`), `GET /api/me`. 필요하면 `auth.ts` 의 회원 연결 보강 | `01-member-onboarding.md` §1~§4 · data-model §2-2 `members` · FR-002(가입 정보 수집·고지)·FR-003(본인확인 계정 식별) | `lib/server/services/members.ts` · `app/api/dev/identity/fake-verify/route.ts` · `app/api/members/route.ts` · `app/api/me/route.ts` · `lib/server/auth.ts`(필요 시) · `tests/fixtures/members.ts` · `tests/us1/signup.db.test.ts` | `flock … npm run test:db -- tests/us1/signup.db.test.ts` → AC-9 앞 두 항목(`나이·성별·연락처 없이는 가입이 끝나지 않는다` · `같은 본인확인 식별값으로 두 번째 계정을 만들 수 없다`) passed |
| **T-A1-2(취향·기준 장르)** | `PUT /api/me/profile`(관심 장르 필수·복수, 지역 선택·복수, 가능 시간대 from<to) · `PUT /api/me/base-genre`(기준 장르 1개) | `01-member-onboarding.md` §5·§6 · FR-022(사용자 프로필)·FR-022a(첫 화면 장르 선택·유지) · plan D16 | `lib/server/services/members.ts` · `app/api/me/profile/route.ts` · `app/api/me/base-genre/route.ts` · `tests/us1/preferences.db.test.ts` | `flock … npm run test:db -- tests/us1/preferences.db.test.ts` → passed(관심 장르 0개 422, from≥to 422, 기준 장르 저장 후 `GET /api/me` 반영) |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-A1-1 | T-M4-1 · T-M3-6 · T-M2-3 | [P] | ● | `ecc:api-design` · `ecc:security-review` · `ecc:tdd-workflow` | Sonnet |
| T-A1-2 | T-A1-1 | [P](T-M4-3 과) | ● | `ecc:api-design` · `ecc:tdd-workflow` | Sonnet |

---

## ⑦ US1-A2(시드·검색·상세)

완료선: AC-1(조건 검색) · AC-7(성별 자리 기본값, 결제 부분 제외) 통과 · `npm run db:seed` 후 홈에 시드 수업 1건. SCH 대응: SCH-26(수업·회차 등록)·SCH-27(검색·필터) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-A2-1(시드 스크립트)** | 학원 1(강남구·대표 1·공지 판본 1), 정규 살사/바차타 1건, 기간 8회차(화·목 19:30~21:00 KST, 다음 주 화요일 시작), 남 6·여 6, 확정 남 4·여 4 — 가짜 회원 8명의 `paid` 주문·`confirmed` 예약을 실제로 만들어 카운터와 행 수를 맞춘다. 시험 회원(성인 남, 기준 장르 미선택). 끝에 `db.close()` | data-model §5 · Q4(시드 수업 종류) 결정 | `scripts/seed.ts` · `tests/us1/seed.db.test.ts` | `flock … npm run test:db -- tests/us1/seed.db.test.ts` passed(confirmed_count 합 8 = confirmed 예약 행 8) · 개발 DB 에 `npm run db:seed` 두 번 실행해도 오류 없음(재실행 정책은 Task 가 정해 보고) |
| **T-A2-2(홈 목록·상세·기본 자리)** | 홈 거르기(기준 장르 + 관심 지역 + 가능 시간대, KST), 기준 장르 없으면 409 `BASE_GENRE_REQUIRED`, 정원·신청 인원(`confirmed_count`)·잔여 표시, 상세의 자리 묶음별 마감 여부, 본인확인 성별 기본 자리(`seat-default.ts`), 단일 정원은 자리 질문 없음 | `02-catalog.md` §1·§2 · data-model §4-4 끝(표시 규칙) · plan D16 · FR-090(정원·신청 인원 표시)·FR-092(성별 정원)·FR-092c(성별 구분 없는 단일 정원) | `lib/domain/seat-default.ts` · `lib/server/services/catalog.ts` · `app/api/home/offerings/route.ts` · `app/api/offerings/[id]/route.ts` · `tests/unit/seat-default.test.ts` · `tests/fixtures/catalog.ts` · `tests/us1/search.db.test.ts` · `tests/us1/seat-default.db.test.ts` | `flock … npm run test:db -- tests/us1/search.db.test.ts tests/us1/seat-default.db.test.ts` → AC-1 3항목 · AC-7 의 `본인확인 성별이 남이면 남 자리가 기본이다`·`단일 정원 수업은 성별 자리를 묻지 않는다` · AC-9 셋째 항목(`기준 장르 1개를 고르기 전에는 홈 데이터를 주지 않는다`) passed · 시드 후 `GET /api/home/offerings` 1건 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-A2-1 | T-M2-3 | [P] | ● | `ecc:prisma-patterns` | Haiku |
| T-A2-2 | T-A1-2 · T-A2-1 | [P](T-M4-5 와) | ● | `ecc:postgres-patterns` · `ecc:api-design` · `ecc:tdd-workflow` | Sonnet |

---

## ⑧ US1-A3(결제 시작·만료·셀프 취소)

완료선: AC-4(입금 기한 만료, 마지막 항목 제외) · AC-5(입금 전 셀프 취소) · AC-6(정원 정합성, ①③) · AC-8(결제 화면 필수 표시) 통과. SCH 대응: SCH-28(예약·정원·대기)·SCH-29(PG 결제) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-A3-1(주문 생성 = 결제 시작)** | `POST /api/orders`: 멱등(`uq_orders_member_idempotency`, 다시 오면 200 같은 주문) · 공지 판본·중개자 고지·가격 내역 없으면 409 `NOTICE_MISSING` · 금액·공지 판본 고정 · 자리 잡기 조건부 UPDATE(영향 0행 → 409 `SEAT_SOLD_OUT`) · payments `ready` + `computeDueAt` · 가짜 PG 발급(트랜잭션 안 — R-P3(트랜잭션 안 PG 호출) 허용) · order_events. `GET /api/orders/{id}` | `03-checkout-payment.md` §1·§2·§3·§4 · data-model §4-1 첫 행·§4-4 · FR-282(결제 화면 필수 표시)·FR-283(결제액 계산 순서)·FR-284(주문 시점 값 고정) | `lib/server/services/checkout.ts` · `app/api/orders/route.ts` · `app/api/orders/[orderId]/route.ts` · `tests/fixtures/checkout.ts` · `tests/us1/checkout.db.test.ts` · `tests/us1/capacity-race.db.test.ts` | `flock … npm run test:db -- tests/us1/checkout.db.test.ts tests/us1/capacity-race.db.test.ts` → AC-8 3항목 · AC-6 ①(`마지막 자리에 동시 결제 시작 20건 → held 1건`)·③(`정원이 찬 자리는 결제 시작이 거부된다`) · AC-7 나머지 2항목(반대 자리로 바꿔 결제, 여 마감 시 남으로 바꿔 결제) passed |
| **T-A3-2(만료 정리·셀프 취소·내부 경로)** | `expiry.ts`(기한 지난 `pending` → `expired`, held −1 — 조건부 UPDATE), 읽기·쓰기 전 정리를 `catalog.ts`·`checkout.ts` 앞에 연결(D15), `POST /api/internal/orders/expire`(`X-Internal-Token` 상수 시간 비교), `POST /api/orders/{id}/cancel`(FR-286(입금 전 셀프 취소), 이미 `cancelled` 면 200 재생, `paid` 면 409 `ORDER_NOT_CANCELLABLE`), 가짜 PG `cancelPayment` | `03-checkout-payment.md` §2·§5 · data-model §4-1 3·4행 · plan D6·D15 · R-P4(만료가 읽기에 기댐) | `lib/server/services/expiry.ts` · `lib/server/services/catalog.ts` · `lib/server/services/checkout.ts` · `app/api/orders/[orderId]/cancel/route.ts` · `app/api/internal/orders/expire/route.ts` · `tests/us1/expiry.db.test.ts` · `tests/us1/self-cancel.db.test.ts` | `flock … npm run test:db -- tests/us1/expiry.db.test.ts tests/us1/self-cancel.db.test.ts` → AC-4 앞 4항목(시계 주입) · AC-5 2항목 passed · 내부 경로에 토큰 없으면 401 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-A3-1 | T-A2-2 · T-M3-3 · T-M3-4 | — | ● | `ecc:postgres-patterns` · `ecc:tdd-workflow` · `ecc:security-reviewer` | Sonnet |
| T-A3-2 | T-A3-1 | — | ● | `ecc:postgres-patterns` · `ecc:tdd-workflow` | Sonnet |

---

## ⑨ US1-A4(웹훅 확정 일괄 처리)

완료선: AC-2(결제 확정 일괄 처리) · AC-3(웹훅 신뢰성) · AC-10(끝까지 한 바퀴) 통과. SCH 대응: SCH-29(PG 결제)·SCH-31(정산 원장)·SCH-38(알림) 일부.

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-A4-1(웹훅 수신·확정 일괄 처리)** | `POST /api/payments/webhook`: 서명 검증(401 `INVALID_SIGNATURE`) → `webhook-id` 원장 `ON CONFLICT DO NOTHING`(중복 200) → 본문을 믿지 않고 `getPayment` 재조회 → 요청·PG 응답·저장 금액 세 값 대조 → `pending→paid` 조건부 갱신 한 트랜잭션에서 payments·reservations `confirmed`·held −1/confirmed +1·calendar_entries(회차 수)·notifications 2건·settlement_entries `hold`·order_events. 커밋 뒤 발송 포트. 「완료」 복귀만으로는 확정 안 됨 | `03-checkout-payment.md` §6 · data-model §4-1 2행 · contracts `README.md` §5 · FR-287(웹훅 확정)·FR-115(결제 금액 대조)·FR-116(결제 통지 중복 반영 방지)·FR-289(확정 후 일괄 처리) | `lib/server/services/payment-confirmation.ts` · `app/api/payments/webhook/route.ts` · `tests/fixtures/payment.ts` · `tests/us1/confirm.db.test.ts` · `tests/us1/webhook.db.test.ts` | `flock … npm run test:db -- tests/us1/confirm.db.test.ts tests/us1/webhook.db.test.ts` → AC-2 5항목(강제 오류 시 전부 이전 값 포함) · AC-3 원래 4항목(중복 뒤 신청 인원 9 그대로) passed |
| **T-A4-2(금액 불일치·닫힌 주문 입금 처리)** | FR-290(금액 불일치 입금) → `payment_exceptions` `amount_mismatch` · FR-292(만료 뒤 늦은 입금) → `expired`·`cancelled` 주문은 끝 상태 유지, `pg_reported_amount` 기록, `payment_exceptions` `deposit_on_closed_order`(`refund_due`, 전액) 1건, 알림 `payment_refund_due` 2건, order_events 사유 1행, 웹훅 200. 같은 통지 재전송에도 1건 | `03-checkout-payment.md` §6 · data-model §4-1 5·6행 · plan Q8 행·U3 · §7 AC-3·AC-4·AC-6 갱신 | `lib/server/services/payment-confirmation.ts` · `tests/us1/late-deposit.db.test.ts` | `flock … npm run test:db -- tests/us1/late-deposit.db.test.ts` → AC-3 추가 3항목 · AC-4 마지막 항목(`payment_webhook_events.result='deposit_on_closed_order'`, 예외 1행, 주문 `expired` 그대로) · AC-6 ②(`만료된 주문에 늦은 입금이 와도 그 자리를 새로 잡은 회원의 주문이 확정된다`) passed |
| **T-A4-3(가짜 PG 시험 경로·캘린더·알림 조회)** | dev 전용 가짜 PG 조작 경로(입금 시뮬레이션 → 서명된 웹훅 발송), `GET /api/me/calendar?from&to`(KST 날짜), `GET /api/me/notifications?limit&cursor` | `03-checkout-payment.md` §7 · `04-me-calendar-notifications.md` §1~§3 | `app/api/dev/fake-pg/**/route.ts` · `lib/server/services/me-feed.ts` · `app/api/me/calendar/route.ts` · `app/api/me/notifications/route.ts` · `tests/us1/me-feed.db.test.ts` | `flock … npm run test:db -- tests/us1/me-feed.db.test.ts` passed · `KDANCE_DEV_ROUTES=false` 에서 dev 경로 404 |
| **T-A4-4(끝까지 한 바퀴)** | API 수준 한 바퀴 테스트: 가입 → 취향 → 기준 장르 → 홈 검색 → 결제 시작 → (dev 경로로) 입금 → 웹훅 → 확정 → 캘린더 조회. 이어서 전체 검증선을 돈다 | AC-10 · plan §7 전체 행 | `tests/us1/e2e-api.db.test.ts` | `flock … npm run test:db -- tests/us1/e2e-api.db.test.ts` passed · `npm test` 전체 passed · `npm run build` 성공 · `cd backend && uv run pytest -q` T0 기준선 그대로(AC-11 이관 중 정의) |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-A4-1 | T-A3-2 · T-M3-4 · T-M3-5 | — | ● | `ecc:postgres-patterns` · `ecc:security-reviewer` · `ecc:tdd-workflow` | 메인 또는 Sonnet(원자성 판단이 핵심) |
| T-A4-2 | T-A4-1 | [P] | ● | `ecc:tdd-workflow` · `ecc:security-review` | Sonnet |
| T-A4-3 | T-A4-1 | [P] | ● | `ecc:api-design` · `ecc:security-review`(dev 경로 차단) | Sonnet |
| T-A4-4 | T-A4-2 · T-A4-3 | — | ● | `ecc:e2e-testing` · `ecc:verification-loop` | Sonnet |

---

## ⑩ US1-A5(mobile 화면)

완료선: `npx tsc --noEmit` exit 0 · (가능하면) Expo web 에서 가입→결제 대기 Playwright 스냅샷, 안 되면 「화면 미검증」 기록. 화면 짜임은 보드 01-1·01-3·01-4, 장르 테마 색은 미적용(R7(보드와 화면 차이)).

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-A5-1(라우터·API 클라이언트·세션)** | `npx expo install expo-router react-native-screens react-native-safe-area-context expo-secure-store expo-linking expo-constants`(Expo 핀 버전, research §1), 진입점을 expo-router 로, §4.8 을 해석하는 fetch 래퍼(`detail`·`code`), bearer 토큰 보관(`expo-secure-store`), API 주소 환경 변수 | plan D18 · contracts `README.md` §2·§4 · research §1 핀 | `mobile/package.json` · `mobile/package-lock.json` · `mobile/index.ts` · `mobile/app/_layout.tsx` · `mobile/lib/api.ts` · `mobile/lib/session.ts` · `mobile/.env.example` | `cd mobile && npx tsc --noEmit` exit 0 · `npx expo install --check` 불일치 0 |
| **T-A5-2(가입·취향 화면 5종)** | `login` · `identity`(가짜 본인확인) · `signup` · `preferences` · `base-genre` | `01-member-onboarding.md` 흐름 · 보드 01-1 | `mobile/app/login.tsx` · `mobile/app/identity.tsx` · `mobile/app/signup.tsx` · `mobile/app/preferences.tsx` · `mobile/app/base-genre.tsx` | `cd mobile && npx tsc --noEmit` exit 0 |
| **T-A5-3(홈·상세·결제 대기·캘린더 화면 + 취소 화면 이전)** | 탭 레이아웃, `(tabs)/home` · `offering/[id]`(기본 자리·마감 표시) · `checkout/[orderId]`(가격 내역 순서·공지·가상계좌 안내·기한) · `(tabs)/calendar`. 기존 취소 화면을 라우터 아래로 옮기고 `/api/...`·세션으로 | `02-catalog.md` · `03-checkout-payment.md` §1~§3 · `04-me-calendar-notifications.md` · `05-cancellation-migrated.md` 경로 · 보드 01-3·01-4 | `mobile/app/(tabs)/_layout.tsx` · `mobile/app/(tabs)/home.tsx` · `mobile/app/(tabs)/calendar.tsx` · `mobile/app/offering/[id].tsx` · `mobile/app/checkout/[orderId].tsx` · `mobile/app/reservation/[id]/cancel.tsx` · `mobile/App.tsx` | `cd mobile && npx tsc --noEmit` exit 0 |
| **T-A5-4(웹 실행 시도·화면 확인)** | R-15: `npx expo install react-native-web react-dom` 후 `npx expo start --web`, Next.js 서버(포트 3000)와 붙여 가입 → 결제 대기까지 Playwright 스냅샷. 안 뜨면 되돌리고 「화면 미검증」 과 원인을 적는다 | research R-15 · R5(mobile 동작 검증 수단 부재) | `mobile/package.json` · `mobile/package-lock.json` | `npx tsc --noEmit` exit 0 · 스냅샷 파일 경로 또는 「화면 미검증: 원인」 1줄 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-A5-1 | 없음(계약은 이미 있음) | [P] | — | `ecc:react-native-patterns` | Sonnet |
| T-A5-2 | T-A5-1 | [P] | — | `ecc:react-native-patterns` · `ecc:frontend-patterns` | Sonnet |
| T-A5-3 | T-A5-1 | [P] | — | `ecc:react-native-patterns` · `ecc:frontend-patterns` | Sonnet |
| T-A5-4 | T-A5-2 · T-A5-3 · T-A4-4 | — | ● | `ecc:e2e-runner` · `mcp__playwright__*` | Sonnet |

---

## ⑪ S0-M9(backend 삭제) — **사용자 승인 필요, Phase 5 자동 진행 제외**

| ID(이름) | 하는 일 | 참조 | 쓰는 파일 | 완료 판정 |
|---|---|---|---|---|
| **T-M9-1(backend 삭제·DB 이름 회수)** | 착수 직전 U5(`backend/` 삭제 시점)를 사용자에게 묻는다. 승인 뒤: 이관 대응표 186행 최종 확인 → `backend/` 삭제 → 옛 `kdance`·`kdance_test` 삭제 → `ALTER DATABASE kdance_next RENAME TO kdance`(테스트 DB 도) → 환경 변수 예시 갱신 → CLAUDE.md 검증선에서 backend 행 제거 | plan D13·U5 · §7 AC-11 | `backend/`(삭제) · `.env.example` · `CLAUDE.md` · `tests/migrated/migration-map.md`(확인만) | AC-11 삭제 뒤 정의: `cd admin-web && npm test` 전체 passed + 대응표 100%(빈 칸 0) · `npm run build` 성공 |

| ID | 의존 | [P] | DB | ECC | 권장 모델 |
|---|---|---|---|---|---|
| T-M9-1 | 위 모든 Task + **사용자 승인** | — | ● | `ecc:refactor-clean` | 메인(파괴적 작업) |

---

## 의존 그래프

한 줄 순서: `T0 → M1-1 → M1-2 → M2 → M4-1 → A1 → A2 → A3 → A4(AC-10) → A5-4 → (승인) M9`. M3 과 A5 화면 골격은 지금 시작해 주 경로 옆에서 끝내고, M4-2~M4-5 는 A1~A4 와 병행한다.

| 그룹 | 동시에 부를 Task | 열리는 조건 | 겹치는 파일 확인 |
|---|---|---|---|
| **그룹 1** | T-M3-1 · T-A5-1 · (T0 끝났으면) T-M1-1 | 지금 | admin-web `lib/domain/` ↔ `package.json`·`prisma/`·`tests/setup/` ↔ `mobile/` — 겹침 없음. T-M3-1 의 vitest 실행은 T-M1-1 설치가 끝난 뒤 |
| **그룹 2** | T-M3-2 · T-M3-3 · T-M3-4 · T-M3-5 · T-A5-2 · T-A5-3 · T-M1-2 | T-M3-1 · T-A5-1 · T-M1-1 | M3 4종은 각자 새 파일, A5 2종은 화면 파일이 갈림, M1-2 는 `prisma/db.ts`·research 만 |
| **그룹 3** | T-M1-3 · T-M1-4 · T-M2-1 · T-M3-6 | T-M1-2 · T-M3-2~5 | health·auth·contract·deps 로 갈림. M2-1 은 `contract.prisma` 소유권을 M1-1 에서 넘겨받는다 |
| **그룹 4** | T-M1-5 · T-M2-2 · T-M2-3 · T-M4-1 · T-M4-4 | T-M1-3 · T-M1-4 · T-M2-1 · T-M3-1 | 문서 ↔ constants ↔ 제약 테스트 ↔ `http.ts` ↔ admin 화면 |
| **그룹 5** | T-A2-1 · T-M4-2 · T-A1-1 | T-M2-3 · T-M4-1 · T-M3-6 | `scripts/seed.ts` ↔ 취소 서비스 ↔ 회원 서비스 |
| **그룹 6** | T-M4-3 · T-A1-2 | T-M4-2 · T-A1-1 | 이관 단위 테스트 ↔ 취향 경로(`members.ts` 는 A1-2 만) |
| **그룹 7** | T-M4-5 · T-A2-2 | T-M4-3 · T-M4-4 · T-A1-2 · T-A2-1 | 대응표 ↔ catalog |
| 순차 | T-A3-1 → T-A3-2 → T-A4-1 | 앞 Task | `checkout.ts`·`catalog.ts` 를 A3-2 가 다시 고치므로 순차 |
| **그룹 8** | T-A4-2 · T-A4-3 | T-A4-1 | `payment-confirmation.ts` ↔ dev·me 경로 |
| 순차 | T-A4-4 → T-A5-4 → (승인) T-M9-1 | 앞 Task | — |

---

## MVP-first — 가장 일찍 「끝까지 한 바퀴」가 도는 경로

**최소 경로(T0 + 22개)**: T0 → T-M1-1 → T-M1-2 → T-M1-4 · T-M2-1 → T-M2-3 → T-M3-1 → T-M3-3 · T-M3-4 · T-M3-5 → T-M3-6(T-M3-2 동반) → T-M4-1 → T-A1-1 → T-A1-2 → T-A2-1 → T-A2-2 → T-A3-1 → T-A3-2 → T-A4-1 → T-A4-2 · T-A4-3 → T-A4-4. 빠진 것은 T-M1-3·T-M1-5·T-M2-2·T-M4-2~T-M4-5·T-A5-* 뿐이다.

이 경로만 끝내면 다음이 실제로 돈다: 시험 회원이 가짜 본인확인으로 가입하고, 취향과 기준 장르를 넣고, 홈에서 시드 정규 수업(8/12)을 보고, 남 자리로 결제를 시작해 가상계좌를 받고, dev 경로로 입금하면 웹훅이 확정해 신청 인원이 9/12 가 되고 캘린더에 8회차가 생긴다. 화면이 아니라 API 수준이다 — 앱 화면은 T-A5-* 가 붙인다.

**판단 1 — S0-M4(취소 API 이관)는 그 경로 앞에 없어도 된다. 단 T-M4-1(공통 HTTP 계층)만은 앞에 둔다.**
- AC-10(끝까지 한 바퀴)의 흐름에는 취소가 없다. 취소 서비스(T-M4-2)가 쓰는 테이블은 T-M2-1 계약이 이미 만들었으므로 R4(확정 예약이 취소·환불 코드와 안 맞음)는 계약 단계에서 풀린다. 이관 코드가 늦어도 US1 확정 예약의 모양은 바뀌지 않는다
- backend 는 T-M9-1 전까지 그대로 살아 있고 186 passed 가 회귀 기준으로 남는다. 이관을 미뤄도 잃는 검증이 없다
- 반면 `requireMember`·오류 형식(T-M4-1)은 A1~A4 모든 경로가 쓴다. 이것만 S0-M4 에서 앞으로 당긴다
- 이관 취소의 1단계 잠금 방식은 T-M1-1·T-M1-2 스파이크가 먼저 정하므로 M4 를 늦춰도 R2 판단이 늦어지지 않는다

**판단 2 — US1-A 를 먼저 완성하되, M4-2~M4-5 는 버리지 않고 병행한다.** 파일이 완전히 갈려(그룹 5~7) 병렬 비용이 거의 없다. 자원이 모자라면 A 사슬을 우선하고 M4 는 그 뒤에 몰아서 한다.

**권장 순서(하나)**: `T0 ∥ [T-M3-1 · T-A5-1] → T-M1-1 → T-M1-2 → [T-M2-1 · T-M1-4 · T-M3 나머지] → T-M2-3 → T-M4-1 → T-A1 → T-A2 → T-A3 → T-A4 (AC-10 도달) — 그 사이 빈 자리에 T-M4-2~5 · T-A5-2·3 · T-M1-3·5 · T-M4-4 를 끼운다 → T-A5-4 → (승인) T-M9-1`

plan §5 의 의존 열과의 대조: A1 ← M2·M3 ✓, A2 ← A1 ✓, A3 ← A2 ✓, A4 ← A3 ✓, M4 ← M2·M3·A1 세션(픽스처로 대신) ✓, M3 ← 없음 ✓, A5 ← 계약 ✓. 어긋나는 곳은 없다.

---

## AC 대응표

| AC | 검증 Task | 테스트 파일 | 비고 |
|---|---|---|---|
| AC-1(조건 검색) | T-A2-2 | `tests/us1/search.db.test.ts` | |
| AC-2(결제 확정 일괄 처리) | T-A4-1 | `tests/us1/confirm.db.test.ts` | 강제 오류 롤백은 T-M1-2 가 고른 트랜잭션 경로 위에서 |
| AC-3(웹훅 신뢰성) | T-A4-1(원래 4항목) · T-A4-2(늦은 입금 3항목) | `webhook.db.test.ts` · `late-deposit.db.test.ts` | 서명 검증기 단위는 T-M3-4 |
| AC-4(입금 기한 만료) | T-M3-3(기한 계산 단위) · T-A3-2(앞 4항목) · T-A4-2(마지막 항목) | `payment-deadline.test.ts` · `expiry.db.test.ts` · `late-deposit.db.test.ts` | |
| AC-5(입금 전 셀프 취소) | T-A3-2 | `tests/us1/self-cancel.db.test.ts` | |
| AC-6(정원 정합성) | T-M1-1(S-3 선행 실측) · T-M2-3(CHECK) · T-A3-1(①③) · T-A4-2(②) | `capacity-race.db.test.ts` · `late-deposit.db.test.ts` | |
| AC-7(성별 자리 기본값) | T-A2-2(기본값·단일 정원) · T-A3-1(바꿔 결제·마감 시 전환) | `seat-default.db.test.ts` · `checkout.db.test.ts` | 「대기 가능」 표시는 2회차 |
| AC-8(결제 화면 필수 표시) | T-M3-1(가격 내역 순서 단위) · T-A3-1 | `money.test.ts` · `checkout.db.test.ts` | 정규라 예매 수수료 줄 없음 |
| AC-9(가입 정보) | T-A1-1(앞 2항목) · T-A2-2(셋째 항목) | `signup.db.test.ts` · `search.db.test.ts` | 셋째 항목은 API 로 막는다(409 `BASE_GENRE_REQUIRED`) |
| AC-10(끝까지 한 바퀴) | T-A4-4 | `tests/us1/e2e-api.db.test.ts` | 화면 E2E 는 T-A5-4(R-15) |
| AC-11(회귀) | 이관 중: T0(기준선) · T-M4-5 · T-A4-4 / 삭제 뒤: T-M9-1 | backend pytest · admin-web `npm test` · `migration-map.md` | |
| AC-12(빌드) | admin-web: T-M1-3 · T-M2-1 · T-M4-4 · T-A4-4 / mobile: T-A5-1~T-A5-4 | — | |
| AC-13(이관 취소) | T-M4-2 | `tests/migrated/cancel-api.db.test.ts` | 9 passed |
| AC-14(R2 스파이크) | T-M1-1 · T-M1-2 | `tests/spike/r2-prisma8.db.test.ts` | 결과 표는 `03_research.md` |

빠진 AC 없음(AC-1~AC-14 전부 1개 이상의 Task 에 연결).

---

## 분해 불가 항목

없음. plan §4 의 모든 파일이 아래 Task 중 하나에 들어갔다. 단 plan 에 경로가 없던 파일 4개는 이 문서가 정했다: `tests/migrated/migration-map.md`(이관 대응표) · `lib/server/schemas/cancellation.ts` · `lib/server/services/me-feed.ts` · `tests/fixtures/*.ts`. 아래 제안 P4·P5 참조.

---

## 제안 (plan 과 다르게 하고 싶은 점 — 본문은 plan 을 따랐다)

| # | 제안 | 이유 | 채택하지 않으면 |
|---|---|---|---|
| P1 | vitest 설치·설정·scripts 를 T-M1-1(R2 스파이크)에서 떼어 DB 가 필요 없는 **공통 기반 Task** 로 앞에 둔다 | 지금은 S0-M3(순수 로직 이식)이 「DB 없이 지금 시작」인데도 러너 설정이 DB 의존 Task 안에 있어, 슬라이스 완료 판정(`npm run test:unit`)이 Docker 기동을 기다린다. 본문은 `npx vitest run <파일>` 임시 검증으로 돌려 놓았다 | Docker 가 늦게 켜지면 M3 이 코드는 끝나도 「완료」를 못 찍는다 |
| P2 | `lib/domain/constants.ts` 를 S0-M2(데이터 계약)에서 S0-M3 으로 옮긴다(본문은 이미 T-M3-1 에 넣었다) | M3 의 결제 수단·상태 타입이 값 집합을 import 하는데, M3 은 M2 보다 먼저 돈다. 계약과의 문자 단위 대조 테스트는 M2(T-M2-2)에 남겼다 | M3 이 값을 문자열로 흩어 쓰고 나중에 갈아 끼우게 된다 |
| P3 | research S-7(Better Auth)은 스파이크 파일과 분리해 T-M1-4 의 `tests/spike/r10-better-auth.db.test.ts` 로 둔다 | R2 판정과 인증 실측은 실패 시 대체 경로가 서로 무관하다. 한 파일이면 T-M1-2 판정과 T-M1-4 가 같은 파일을 놓고 겹친다 | AC-14(R2 스파이크) 파일에 인증 사례가 섞인다 |
| P4 | 이관 대응표 위치를 `admin-web/tests/migrated/migration-map.md`(git 추적)로 정한다 | plan 은 산출물이라고만 했다. `_workspace/` 에 두면 T-M9-1(backend 삭제) 뒤 근거가 저장소 밖에 남는다 | — |
| P5 | 픽스처는 Task 마다 `tests/fixtures/<영역>.ts` 로 나눠 쓰고, A4 끝난 뒤 중복을 한 번 정리한다(Phase 8(코드 리뷰) 지적 대상) | 병렬 Task 가 공용 픽스처 파일을 동시에 고치지 않게 하려면 지금은 중복을 감수해야 한다 | 병렬 그룹 5~7 이 픽스처 파일에서 충돌한다 |
| P6 | R-P2(계약 크기)의 「마이그레이션 2개로 나누기」는 **하지 않는다** | 새 DB 라 옮길 데이터가 없고, 두 판으로 나누면 이관 7테이블이 US1 테이블(`members`·`seat_pools`)을 FK 로 참조해 앞 판이 단독으로 서지 않는다. 검토 부담은 T-M2-3 제약 테스트로 덜었다 | — |
| P7 | 병렬 그룹의 DB 테스트 직렬화(`flock`)를 하네스 SKILL 의 Phase 5(구현) 규칙에 올린다 | 같은 `kdance_next_test` 를 두 에이전트가 동시에 TRUNCATE 하면 서로의 테스트를 거짓 실패시킨다. 이번 회차만의 문제가 아니다 | Phase 6(테스트)에서 원인 모를 간헐 실패가 난다 |

---

## 2026-11-10 필수 기능 점검에서 나온 후속

출처: `_workspace/role-essentials/integration.md`(반영 지침)와 근거 보고서 `member.md`·`instructor.md`·`owner.md`. 2026-11-07 결정(구현 보류, 보드가 다 된 뒤 플랜을 대표 → 강사 → 회원 순으로 다시 짠다)에 따라 **새 Task 번호를 만들지 않았다.** 아래는 목록 항목이고, 본 Task 체계는 플랜을 다시 짤 때 정한다. 추천안은 모두 사용자 확인 대기다. US1 1회차에 직접 걸리는 M-03·M-04 와 D-04(주문 테이블)는 이미 플랜 문서에 반영했다(`03_impl-planner_plan.md` §10).

### 후속 1. 승인된 임시 상태와 빠진 작업 카드

| 지침 | 내용 | 근거 |
|---|---|---|
| D-05(환불 비율표 코드 정렬) | 환불 비율표 코드를 spec(비율표 폐기, 정규·일반 수업 환불 요청은 문의로 — FR-098b(환불 요청 경로))에 맞추는 일. 대상 `admin-web/lib/domain/refund-policy.ts`, `mobile/app/reservation/[id]/cancel.tsx`(회원이 예상 환불액을 보고 직접 취소 확정). **2026-11-06 사용자가 승인한 임시 상태**(U4)라 코드는 건드리지 않았고, 이 일을 Task 로 만들 자리가 아직 없다. 이벤트형 취소는 FR-099c(이벤트형 취소 규정) 표로 계산해 보여 주는 것이 맞아 따로 남긴다 | member.md ⑱ · owner.md ⑦ · plan D12·U4 |
| D-06(관리자 웹 2단계 인증 대표 확대·계좌 변경 보호) | FR-303(관리자 2단계 인증)을 대표까지 넓힌 2026-11-09 결정, 강사 계좌 변경 시 재확인(FR-139(강사 계좌 변경 재확인))이 로드맵과 작업 카드에 없다 | integration.md D-06 |

### 후속 2. 2026-11-10 결정

| 결정 | 내용 |
|---|---|
| 관리자 웹은 로그인 하나·콘솔 하나 | 메뉴는 권한으로 나눈다. FR-300(역할별 로그인 분기)이 적은 역할별 분기는 이 결정으로 바뀐다(spec 쪽 반영은 다른 에이전트 몫) |
| 결석 예정은 참석/결석 토글 하나 | FR-092e(결석 예정 미리 알리기). 당일 결석 기록 방식은 Q-B(출결 방식)가 정해져야 닫힌다 |
| 결제수단을 상품 종류로 나눈다(2026-11-10) | 이벤트·원데이·파티·공연·대회는 간편 계좌이체(기본)·가상계좌만, 정규·단기 과정·개인 레슨은 카드가 기본이고 카드·간편결제·간편 계좌이체·가상계좌 모두 선택 가능. 이전: 단건 기본은 가상계좌, 모든 결제에서 카드 허용. FR-111(상품별 기본 결제수단)·FR-111a(카드 허용 범위)·FR-280(결제수단 결정). 이벤트형 카드 거절은 여신전문금융업법 법률 검토 대상 |
| 후속: 상품 종류별 허용 결제수단 판정 | `admin-web/lib/domain/constants.ts` 의 `PAYMENT_METHODS` 가 `virtual_account`·`card` 2종뿐이다. 간편 계좌이체·간편결제를 더하고, 상품 종류별 허용 수단을 판정하는 함수와 주문 생성 거부(이벤트형 카드·간편결제), 카드 승인 통지 전액 취소가 필요하다. 이벤트형은 전부 계좌 결제라 환불 계좌 입력이 항상 필요하다(FR-295(수단별 환불 실행)) |

### 후속 3. 플랜을 대표 → 강사 → 회원 순으로 다시 짤 때 반영할 지침

각 지침의 문장 초안과 붙일 FR 은 `integration.md` 1절. 여기는 ID 와 한 줄 요약만 둔다. US1 1회차에 넣지 않은 이유는 `03_impl-planner_plan.md` §10-2.

**대표·결제 기반** (먼저 짠다)

| 지침 | 한 줄 |
|---|---|
| M-05(0원 신청) | 최종 결제액 0원이면 PG 호출 없이 즉시 확정. 무료 수업(I-04)·쿠폰과 함께 |
| M-13(입금 기한 임박 알림) | 가상계좌 기한 1시간 전 알림(추천값). 알림 발송(SCH-38)과 함께 |
| O-14(PG 대사) | 매일 PG 내역과 결제 원장을 맞추고 웹훅 유실을 보정. 실 PG 선정 뒤 |
| O-15(금액 끝수) | 원 미만은 올림(`money.ts`와 같게), 기준 금액 한 문장. Q-O-1 과 함께 |
| O-01(주문·결제 목록) | 대표가 주문을 기간·수업·상태·수단으로 조회 |
| O-02(카드 이의제기) | 통지 시 지급 보류, 소명, 결과에 따라 환불·상계 |
| O-03(정산 지급 실패) | 반송 시 지급 보류·재등록 후 다음 지급에 포함 |
| O-04(판매자 정보) | 통신판매업 신고번호 포함, 공개 항목 한 곳에 목록 |
| O-05(결제자가 있는 수업의 변경) | 가격은 이후 결제부터, 정원은 결제 인원 밑으로 못 줄임, 시간·장소·강사 변경 시 알림 |
| O-06(이상 입금) | 다른 금액 입금은 전액 반환 대상. 반환 주체는 Q-A 와 함께 |
| O-07(현장 수납) | 현장 돈은 플랫폼 정산 대상 아님, 인원 수정 기록 |
| O-08(PG 장애) | 결제 시작 차단, 입금 대기 기한을 장애 시간만큼 연장 |
| O-09(정규 과정 환불 처리 기한) | 요청 뒤 3영업일(추천값) 안에 대표 응답, 넘기면 재알림 |
| O-10(정산 이의 제기) | 14일(추천값) 안에 접수, 다음 정산에서 조정 |
| O-11(회원 명단 보호) | 내보내기는 연락처 가림, 기록 남김, 위임 해제 즉시 차단 |
| O-12(대표 대시보드 지표) | 오늘 신청·환불 대기·승인 대기·마감 임박·이번 달 매출 |
| O-13(감사 기록 범위) | 위임 변경·입점 심사·지급 보류·로그인 실패 추가 |
| O-16(거래 기록 보존) | 계약·결제 5년, 분쟁 3년, 접속 3개월 |
| O-17(사업자 상태 재확인) | 입점 때와 주기적 휴폐업 확인(무료 방법 확인 필요) |
| I-05(정산 계좌 등록) | 예금주와 본인확인 이름 일치(대표 계좌 포함) |

**강사**

| 지침 | 한 줄 |
|---|---|
| I-01(소속 신청) | 거절 사유·재신청, 초대 링크 7일·1회용(추천값) |
| I-02(소속 해제) | 대표가 먼저 시작 가능, 해제 뒤에도 지난 정산 열람 |
| I-03(강사 탈퇴) | 진행 수업·미정산 처리 뒤 삭제 |
| I-04(무료 수업 등록) | 0원 등록 허용, 정산에는 0원 행 |
| I-06(지급 보류 사유 안내) | 자기 몫이 걸린 보류의 사유·금액을 강사에게도 |
| I-07(이벤트형 지급과 정산 3단계 연결) | 즉시 지급 금액이 FR-128(정산 3단계)의 어느 단계인지 한 문장 |
| I-08(신청·취소 알림) | 정규 수업은 알림함·홈 표에만, 이벤트·개인 레슨은 알림 |
| I-09(강사의 시스템 문의) | 계정·앱 오류는 운영자에게 |
| I-10(대타 요청 흐름) | 요청 → 수락 → 대표 확인 → 공지, 정산은 실제 수업한 강사 |
| O-03(정산 지급 실패) | 강사 지급도 같은 규칙 |

**회원** (마지막에 짠다)

| 지침 | 한 줄 |
|---|---|
| M-01(가입 동의 항목) | 필수·선택 동의 구분, 광고성 철회 기록 |
| M-02(약관 재동의) | 불리한 변경은 재동의 전 신규 결제 차단 |
| M-06(환불 요청 상태) | 접수·처리 중·완료·거절을 같은 값으로, 철회 가능 |
| M-07(환불 계좌) | 가상계좌·이체 결제분 환불 계좌 입력, 예금주 확인 |
| M-08(환불 알림) | 금액·수단·반영 시점·계산 근거 |
| M-09(회차 옮기기 설정) | 수업별 허용·마감, 같은 가격 회차만 |
| M-10(멤버십 자동 갱신 사전 고지) | 7일 전(추천값) 갱신일·금액·해지 방법 |
| M-11(멤버십 결제 실패) | 3일간 하루 1번 재시도, 끝까지 실패하면 종료 |
| M-12(멤버십 결제 수단 변경) | 다음 결제부터 새 수단, 알림 |
| M-14(알림 설정 화면) | 수업 전 시점·광고성·대기·쿠폰 켜고 끄기, 거래 알림은 끌 수 없음 |
| M-15(신고) | 학원·강사·수업·회원 신고, 접수·결과 알림 |
| M-16(탈퇴) | 진행 예약·환불 확인, 입금 대기 자동 취소 |
| M-17(개인정보 열람·정정·처리정지) | 10일 안 결과(추천값, 법정 기한 확인 필요) |
| M-18(계정 복구) | 본인확인 CI 로 기존 계정 연결 |
| M-19(점검·강제 업데이트) | 점검 중 결제 차단, 옛 버전 업데이트 요구 |

**지원하지 않거나 후보로만 두는 것**: X-01(예약 양도 불가), X-02(홀딩·연장은 Q-C 와 함께), X-03(.ics 내보내기), X-04(수강 확인서), X-05(비강사 직원 계정 등), X-06(강사 편의 기능) — 이유는 integration.md 2절.

**어긋남 정리(문서 쪽)**: D-01(소셜 로그인 3사 표기), D-02(운영 알림 7종 vs 10종), D-03(개인 레슨 정산 문구 — Q-A 가 정해질 때까지 「확인 대기」) 는 spec·정의서·약관을 고치는 일이라 플랜 문서에서는 목록으로만 둔다.

### 후속 4. 플랜 전에 정해야 할 것 (결정 질문)

`integration.md` 4절 Q-A~Q-K. **구현 순서를 막는 것**부터.

| 질문 | 무엇을 막나 |
|---|---|
| **Q-A(돈이 흐르는 길)** — 강사에게 돈을 보내는 주체. FR-133(강사 전용 계좌)은 강사 전용 계좌 지급, FR-282d(정산 분배로 학원 직접 지급)·FR-135a(개인 레슨 정산)는 학원이 받고 강사 몫을 정산. 학원 → 강사 단계가 어느 문서에도 없다 | 원천징수 의무자(3.3%)·지급명세, 지급 실패(O-03), 이상 입금 반환(O-06), 개인 레슨 수수료율. **대표 정산 플랜의 첫 질문** |
| **Q-B(출결 방식)** — 당일 결석을 무엇으로 기록하나(2026-11-06 미정). FR-104(출석 기록)·FR-167·FR-135b 와 수용 시나리오는 아직 출석 기록을 전제 | 출석 70% 레벨업(FR-169a(출석률 반영 레벨)), 노쇼 판정(FR-135c·FR-167), 강사 명단 출석 열. **강사 플랜의 첫 질문** |
| Q-C(휴강 환불·보강) — 보강 크레딧의 뜻, 환불 금액 결정 주체 | FR-059·FR-065·회원 선택 화면, X-02 |
| Q-D(미성년자 결제) — 법정대리인 동의 방법, 본인확인 건당 과금과 무료 원칙의 충돌, 법률 검토 | FR-009(미성년자 결제 차단). 외부에 열기 전 |
| Q-E(세금 서류) — 세금계산서·현금영수증 발행 주체, 원천징수와 주민번호 미수집(FR-002·FR-003)의 충돌. 세무 확인 | FR-135d·FR-138(영수증·현금영수증) |
| Q-F(정산 명세 내보내기) | FR-134·보드 O4 |
| Q-G(강사 명단에 보이는 것) | 강사 명단 화면 |
| Q-H(문의 응답 기한 값) | FR-231·대표 문의함 |
| Q-I(개인 레슨 환불 공지) | FR-099b·개인 레슨 미정 항목 |
| Q-J(강사 가입 본인확인 시점) | FR-011·FR-133 |
| Q-K(폐업·입점 해지 때 남은 수강분과 미정산) | FR-256(해지 후 결제건 처리) |
| Q-O-1(수수료 기준 금액·끝수) — 이 점검 중 추가 | 요구사항 문서 §7-3. 정산 원장(SCH-31) |

