# Phase 3(구현 계획) — US1(수업 찾아 결제) 1회차 + 취소·환불 7테이블 Prisma 8 이관

- 작성 2026-11-06 · 입력: `01_req-analyst_requirements.md`(맨 끝 「사용자 결정」 포함) · `02_code-searcher_structure.md`(F절 열린 사항 14개)
- 짝 문서: `03_data-model.md`(엔티티·제약·상태 전이) · `03_contracts/`(API 계약 7파일) · `03_research.md`(미확인 실측 계획·버전 실측값)
- 코드는 고치지 않았다. 실행한 것은 읽기 전용 명령뿐이다(`node -p` 로 설치 버전 읽기, `prisma orm init --help`)

---

## 0. 요약

| 항목 | 결론 |
|---|---|
| 무엇을 | admin-web(Next.js 16.3 + Prisma 8 RC)에 ① 기존 취소·환불 7테이블과 취소 API 를 **동작 보존**으로 옮기고 ② US1-A(가입 → 취향 → 홈 목록 → 결제 시작 → 웹훅 확정 → 캘린더)를 새로 짓는다. mobile 은 회원 화면 8종 + 기존 취소 화면 주소 변경 |
| 핵심 설계 3가지 | **(1) 자리 묶음 카운터** — `class_schedules` 를 `classes`·`class_offerings`(신청 단위)·`class_sessions`(회차)·`seat_pools`(남·여·구분없음 정원)로 쪼갠다 **(2) 잠금은 조건부 UPDATE 한 문장** — `FOR UPDATE`·Redis 에 기대지 않는다. 정원 권위는 DB 하나 **(3) 이관 기간엔 DB 를 나눈다** — Prisma 는 `kdance_next(_test)`, backend 는 기존 `kdance(_test)` 그대로 → backend 186 passed 를 끝까지 회귀 기준으로 쓸 수 있다 |
| 이번 계획이 못 박지 못한 것 | R2(Prisma 8 트랜잭션·행 잠금 미검증) — 설치본 문서에 격리 수준·`FOR UPDATE`·SAVEPOINT API 가 없다. **S0-M1(기반·스파이크)의 첫 Task 가 실측**하고, 실패하면 BYO `pg.Pool` 직접 트랜잭션으로 내려가는 대체 경로를 미리 정해 뒀다(D3) |
| 하위 슬라이스 | 이관 4개(S0-M1~M4) + US1-A 5개(A1~A5) + 삭제 1개(S0-M9, 사용자 승인 뒤). §5 |
| 사용자 확인 | 2026-11-06 U1~U4 답 반영(§8-1). 남은 것은 U5(`backend/` 삭제 시점) 1건 — S0-M9(backend 삭제) 착수 때 묻는다 |

---

## 1. 전제와 선행 조건

| 항목 | 상태 | 영향 |
|---|---|---|
| Docker Desktop | **꺼져 있음**(Phase 2 실측) — DB 기동 상태·`alembic_version` 유무 **미확인** | DB 가 있어야 하는 슬라이스(S0-M1·M2·M4, A1~A4 의 DB 테스트)는 시작 전 사용자가 켜야 한다. 순수 로직(S0-M3)·계약 작성·mobile 골격은 DB 없이 간다 |
| 새 DB | `kdance_next`·`kdance_next_test` 생성 필요(`research.md` §4) | S0-M1 착수 조건 |
| backend 기준선 | 2026-09-23 「186 passed」 | DB 띄운 뒤 이관 전에 다시 잰다 |
| 버전 | 값은 「11. 기술 스택 고정표」·`research.md` §1. Prisma 8 RC · Expo 58 preview · RN 0.88 RC | 깨지면 「11-2. 알려진 위험」에 남긴다 |

---

## 2. 결정표 — Phase 2 열린 사항 14개 + Q7·Q8·Q9·Q12

| # | 주제 | 결정 | 근거 | 버린 대안 |
|---|---|---|---|---|
| D1 | 7테이블 들이는 방식 | **새 계약을 손으로 쓴다.** 남는 제약은 옛 이름을 `name:` **접두어**로(실제 이름 = 옛 이름 + `_<해시>`). `contract infer` 는 쓰지 않는다 | 새 DB(D13)라 이어받을 데이터가 없다. 구조도 크게 바뀐다(`class_schedules` 해체, 상태 확장, FK 추가). 설치본 `contract.md`: `map:` 은 바이트 비교라 새로 쓴 식에 가짜 drift 를 내고 매 emit 경고 | `contract infer` + `map:` 유지 — 들인 직후 대부분을 고쳐 써야 해서 이점이 없다 |
| D2 | 정원 모델 | `classes` → `class_offerings`(신청·결제 단위, FR-052a(회차·기간 신청 단위)) → `class_sessions`(회차) + `seat_pools`(seat_kind `male`·`female`·`any`, capacity·held_count·confirmed_count, CHECK `held+confirmed <= capacity`). 예약은 `seat_pool_id`·`seat_kind` 를 가진다. 원데이 = 회차 1개짜리 판매 단위 | FR-092(성별 정원)·FR-092c(성별 구분 없는 단일 정원)·정규 기간 신청(Q4(시드 수업 종류) 결정)을 한 모델로. held 와 confirmed 를 나눠야 시나리오 2 의 8/12→9/12 가 **확정 때** 바뀐다. 성별 정원의 정원 복구 대상(충돌 ⑧)도 풀린다 | `class_schedules` 에 `capacity_male`·`capacity_female` 칸 추가 — 단일 정원·구분없음이 NULL 조합으로 갈려 CHECK 가 복잡해지고 정규 기간을 못 담는다 |
| D3 | 잠금·SAVEPOINT·격리 | **READ COMMITTED + 조건부 UPDATE 한 문장**(data-model §4-4)으로 자리·주문 전이를 지킨다. 삽입 경합은 `INSERT … ON CONFLICT DO NOTHING RETURNING` 후 이긴 행으로 수렴(옛 SAVEPOINT 대체). `FOR UPDATE` 는 이관 취소 1단계에만 raw 레인으로. **미확인은 미확인으로 두고 S0-M1 첫 Task 가 실측**(research R-01~R-03·R-07). 대체 순서: raw `FOR UPDATE` → `pg_advisory_xact_lock` → BYO `pg.Pool` 위 `withPgTransaction`(Prisma 런타임은 `pg:` 로 같은 풀을 받는다 — `runtime.md`) | 조건부 UPDATE 는 PostgreSQL 이 잠금 대기 뒤 WHERE 를 다시 평가해 READ COMMITTED 에서도 안전하다. Prisma 8 에 격리 수준 API 가 없으니 그것에 기대지 않는 설계가 맞다 | SERIALIZABLE + 재시도 — 지정 API 가 없다 / 행 잠금 후 읽고 쓰기 — R2 가 풀리기 전엔 근거가 없다 |
| D4 | 금액·시각 | 금액: `lib/domain/money.ts` 의 `ceilMulDiv` 가 **BigInt** 로 올림 나눗셈, 입력·결과 안전 정수 검사(§4.6). 시각: 저장·비교는 `Temporal.Instant`(Node 24 라 `temporal-polyfill/full/global` 을 첫 쿼리 전 주입), 하루 중 시각·날짜 판정만 `ZonedDateTime('Asia/Seoul')`. 시계는 `Clock` 주입 | JS 에는 정수 바닥 나눗셈이 없다(Phase 2 A-5). 결제 기한은 순간 계산이라 시간대가 안 끼고, 시간대가 필요한 곳은 시간대 필터·날짜 필터뿐이다 | `Math.ceil(a*b/d)` — 부동소수 경로 / `Date` — Prisma 8 timestamptz 가 받지 않는다 |
| D5 | 상태값 확장 | orders 6종(FR-298(주문 상태 6종)) · payments 에 `status`(ready·paid·expired·cancelled)·`due_at`·가상계좌 칸 · reservations 에 `expired`·`cancel_reason`. 전부 text+CHECK(§4.1) + `order_events` 감사 기록 | spec FR-298 이 6종과 감사 기록을 요구. 「결제 완료 = `paid_at` 있음」 판정은 상태 칸으로 대체 | PG 네이티브 ENUM — 옛 결정(§4.1)과 Prisma 8 enum 방식 둘 다 text+CHECK |
| D6 | FR-286(입금 전 셀프 취소) 분리 | **분리한다.** `POST /api/orders/{id}/cancel`(주문 단위, 환불 행 없음, held −1). 예약 취소 API 는 `held` 예약에 409 `USE_ORDER_CANCEL` | 돈이 오가지 않아 환불이 아니다(FR-286 본문). 옛 취소도 결제 원거래 없으면 409 였으니 동작 보존과 맞는다 | 기존 취소 API 에 분기 추가 — 11단계 순서·멱등 재생 규칙이 환불 전제라 꼬인다 |
| D7 | 알림 위치 | **기록은 트랜잭션 안(`notifications` 행), 발송은 커밋 뒤(포트).** 이관 취소의 알림도 같은 방식으로 바꾼다. Q12(알림 기록 형태) → 기록 + `GET /api/me/notifications`, 화면·푸시 없음 | FR-289(확정 후 일괄 처리)는 「알림까지 한 번에」를 요구하고, 실제 발송은 외부라 트랜잭션에 넣을 수 없다. 둘을 나누면 둘 다 선다(Phase 2 충돌 ⑫) | 커밋 뒤 기록 — 일부만 처리된 상태가 남는다 |
| D8 | Q11(슬롯 잠금 수단) | **DB 만.** Redis 슬롯 락(`slot_lock.py`)은 이관하지 않는다. Redis 컨테이너는 다른 용도(포스터 작업 큐 후보)로 남긴다 | 옛 코드도 「정원 권위는 DB」라 적었고 acquire 가 없어 release 만 있는 반쪽이다. 볼륨 없는 Redis 에 권위를 두면 재시작 때 사라진다. 실패 지점이 하나 준다 | Redis `SET NX PX` acquire 신설 — DB 카운터와 두 권위가 생겨 어긋남 처리가 필요해진다 |
| D9 | 가짜 PG 원장·포트 모양 | 포트 4메서드(`createPayment`·`getPayment`·`cancelPayment`·`refund`) + `WebhookVerifier`(`06-ports.md`). 가짜 원장은 **메모리**(`globalThis`), 권위 있는 기록은 DB(payments·refunds·`payment_webhook_events`). 웹훅은 「본문을 믿지 않고 `getPayment` 로 다시 묻는다」 모양(포트원 V2 흉내). Q7(PG 결정 상태) → **포트원 경유는 확정, PG사 계약은 전** — 모순 아님(research §2) | 멱등의 권위가 DB 유니크라 가짜 원장이 사라져도 이중 반영이 없다. 가짜를 DB 에 넣으면 제품 계약에 시험용 테이블이 섞인다 | 가짜 원장 DB 테이블 — 계약 오염 / 웹훅 본문 금액 신뢰 — FR-115(결제 금액 대조)의 「PG 응답 금액」이 의미를 잃는다 |
| D10 | 인증 | **Better Auth 1.7.5 + Kysely 어댑터**, 같은 BYO `pg.Pool`, 테이블은 `auth` 스키마, 계약에는 `@@control(external)` 로 선언만. 모바일은 `bearer` 플러그인. 제품 회원은 `members.auth_user_id` 로 잇는다. 1회차 로그인 = 시드 계정 이메일·비밀번호, 본인확인 = 가짜 포트(Q2(가입·로그인 방식) 결정) | 내장 prisma 어댑터는 Prisma 5~7 API(Phase 2 B-6). Kysely 경로는 2026-09-24 스모크 통과 기록이 있다(`docs/agent/ai-coding-agent.html`) — 단 `auth` 스키마 조건은 다시 잰다(R-10) | 자체 세션 테이블 — 버릴 코드를 짓는다 / `X-User-Id` 유지 — 위조 가능, 이관 취지와 반대 |
| D11 | Q10(테스트 러너)·DB 격리 | **vitest `~4.1.12`**(최상위 devDependency). 프로젝트 2개: `unit`(DB 없음, 병렬) · `db`(파일명 `*.db.test.ts`, `fileParallelism: false`). DB 테스트는 `kdance_next_test` 에 globalSetup 이 `prisma db migrate` 로 스키마 적용, **테스트마다 `TRUNCATE … RESTART IDENTITY CASCADE` + 픽스처**. DB 접속 실패면 `db` 프로젝트 전체 skip(옛 conftest 와 같은 규칙) | `@effect/vitest`(prisma CLI 전이 의존) peer 가 `<5`. 핸들러가 스스로 트랜잭션을 열어 「바깥 트랜잭션 + SAVEPOINT 롤백」 격리를 쓸 수 없고 SAVEPOINT API 도 미확인이다. Next 설치본 문서가 Vitest 를 안내한다 | vitest 5.x — peer 충돌 위험(미검증) / jest — Next 설치본 안내 밖, ESM·TS 설정 부담 |
| D12 | 폐기된 환불 비율표 GET/PUT·화면 | **이관하지 않는다.** `academies.refund_policy_tiers` 칸과 §4.4 형태는 남긴다(이관 취소의 환불 계산이 읽는다). 값은 시드가 넣는다. 테스트 18개는 「폐기」로 대응표에 남긴다 — **U4 사용자 확정(2026-11-06)** | 2026-09-25 폐기 결정(spec Q11(환불 방식 변경의 뒤처리) ②). 인증 없는 관리 API 를 새 스택으로 옮길 이유가 없다 | 그대로 이관 — 곧 지울 코드를 인증까지 붙여 옮긴다 |
| D13 | `kdance_test` 공유·AC-11(회귀)·`backend/` 삭제 | **공유하지 않는다** — Prisma 는 `kdance_next`·`kdance_next_test`. AC-11 은 이관 중 「backend 186 passed **그리고** admin-web 전체 통과」, 삭제 뒤 「admin-web 전체 통과 + 이관 대응표의 모든 Python 테스트가 TS 테스트 또는 폐기 사유에 연결」. `backend/` 삭제는 US1-A 완료 뒤 **S0-M9 단독 슬라이스, 사용자 승인 뒤**. 그때 옛 DB 를 지우고 `ALTER DATABASE … RENAME` 으로 원래 이름을 되찾는다 | backend 테스트는 `create_all` 로, Prisma 는 마커(`prisma_contract.marker`) 기준으로 스키마를 만든다 — 한 DB 에 두면 서로 깬다(Phase 2 D절). 나누면 R3(두 접근 계층이 한 DB 에 공존)이 사라진다 | 같은 DB 공유 — 186 기준선이 이관 첫날 깨진다 / backend 를 먼저 삭제 — 회귀 기준을 잃는다 |
| D14 | 오류 형식 | **`{"detail": string, "code": string}` 로 FastAPI 호환 유지**, 검증 실패만 `fields` 추가(§4.8). 성공 응답은 감싸지 않는다. 경로 접두어 `/api` | `lib/api-client.ts`·`mobile/App.tsx` 가 `detail` 을 읽는다. `code` 를 더하면 앱이 문구 대신 코드로 분기할 수 있다 | 공통 봉투 `{success,data,error}` — 사용자 전역 규칙 권장 모양이지만 두 클라이언트를 다 고쳐야 하고 이득이 적다(의도적 이탈로 기록) |
| Q7 | PG 결정 상태 | D9 참조 — 닫음 | | |
| Q8 | 만료된 가상계좌 입금 통지 | **확정하지 않는다.** `expired`(그리고 셀프 취소된 `cancelled`) 주문은 끝 상태로 두고, 입금액 전액을 `payment_exceptions`(kind `deposit_on_closed_order`, status `refund_due`)에 기록 + 회원·대표 알림 `payment_refund_due` 2건. 웹훅 응답은 200(PG 재전송 중단). `refunds` 에는 넣지 않는다(확정 예약 환불 원장이라 `reservation_id` 가 필수). 금액이 다르면 FR-290(금액 불일치 입금) | U3 사용자 결정(2026-11-06) + 개정된 spec FR-292(만료 뒤 늦은 입금) · FR-298(주문 상태 6종) | 자리가 남으면 `expired→paid` 예외 확정 — 사용자가 끝 상태 고정을 택해 버림. `refunds` 에 기록 — 예약 없는 돈이라 원장 의미가 깨짐 |
| Q9 | 캘린더 | 앱 안 기록(`calendar_entries`, 회차별 1행) — 닫음 | Phase 2 E-3 | 확정 예약에서 매번 계산 — FR-289 가 「등록」을 일괄 처리 항목으로 둬 기록이 맞고, 2회차 일정 겹침 경고(US1-B)가 이 행을 읽는다 |
| Q12 | 알림 기록 | D7 — 닫음 | | |

추가 결정(범위 안 세부)

| # | 결정 | 이유 |
|---|---|---|
| D15 | 만료 처리 = **읽기·쓰기 전 정리**(홈·상세·주문 생성) + 내부 배치 경로 `POST /api/internal/orders/expire`. 스케줄러는 만들지 않는다 | 인프라에 스케줄러가 없다. 정리를 읽기 앞에 두면 「기한 지나면 다시 신청 가능」(시나리오 3)이 사용자 눈에는 정확히 맞는다 |
| D16 | 홈 목록 장르 조건 = **기준 장르(FR-022a)**, 지역·시간대 = 프로필(FR-022) | FR-022 가 관심 장르는 「추천용으로만」이라 적었고 FR-022a 가 메인 장르 기준을 정한다. **U2 사용자 확정(2026-11-06)** — spec FR-022(사용자 프로필)도 「1회차 홈은 관심 지역·가능 시간대로 거르고, 장르 조건은 FR-022a 의 기준 장르 1개」로 개정됨 |
| D17 | 경로·파일 배치: Prisma 는 `admin-web/prisma.config.ts` + `admin-web/prisma/`(계약·`db.ts`) + `admin-web/migrations/app/`. 도메인 순수 로직 `admin-web/lib/domain/`, 서버 서비스·포트·주입 `admin-web/lib/server/`, 라우트 `admin-web/app/api/**/route.ts` | 기존 관례가 루트 `lib/`·`app/` 이다. Prisma 문서의 `src/prisma/` 는 예시라 `contract:` 경로로 바꿀 수 있다. `src/` 를 새로 들이면 루트 `app/` 과 섞인다 |
| D18 | mobile: `expo-router` 등은 `npx expo install` 로 Expo 핀 버전. API 호출은 `mobile/lib/api.ts` 하나. 토큰은 `expo-secure-store`. 웹 실행(react-native-web)은 US1-A5 에서 시도, 안 되면 「화면 미검증」 | Expo 가 RN 생태계 버전을 고정한다(버전 정책 「올리기 전에」 1번) |

---

## 3. 공유 계약 §N 번호 체계

옛 Phase 4 문서의 §4 번호를 **그대로 잇는다** — backend 소스 주석이 §4.1·§4.2·§4.4 를 인용한다(`backend/app/models/refund.py` 등 18곳 실측). 이관 뒤 TS 소스 주석도 같은 번호를 쓴다.

| 번호 | 이름 | 이번 회차의 원본 |
|---|---|---|
| §4.1 | 상태·구분 값 집합(text + CHECK) | `03_data-model.md` §3 — 확장됨 |
| §4.2 | 값 소유 모듈(옛: Python enum 소유권) | `03_data-model.md` §3 끝 — `lib/domain/constants.ts` |
| §4.3 | 산정 함수 시그니처 | `03_contracts/06-ports.md` |
| §4.4 | 환불 비율표 JSONB 형태 | `03_contracts/06-ports.md` — 변경 없음 |
| §4.5 | API 계약 | `03_contracts/` 전체 |
| §4.6 | 값 형식(금액·시각·가격 내역 줄) | `03_contracts/README.md` §3 — 신규 |
| §4.7 | 자리 묶음 카운터 증감 규칙 | `03_data-model.md` §4-4 — 신규 |
| §4.8 | 오류 응답 형식 | `03_contracts/README.md` §4 — 신규 |
| §4.9 | 멱등 규칙 | `03_contracts/README.md` §5 — 신규 |
| §4.10 | 어댑터 포트 | `03_contracts/06-ports.md` — 신규(옛 SCH-04(어댑터 3종: PG/알림/슬롯락) 후속) |

번호는 바꾸지 않고 더하기만 한다. 지운 항목이 생기면 번호를 비워 둔다.

---

## 4. 계층별 변경 파일 목록

### 4-1. admin-web (주 작업 영역)

| 경로 | 신규/변경 | 내용 | 슬라이스 |
|---|---|---|---|
| `package.json` | 변경 | devDeps `vitest ~4.1.12`, deps `pg`·`kysely`(이미 전이 설치된 버전), 필요 시 `@prisma/cli-engine`. scripts `test`·`test:unit`·`test:db`·`db:emit`·`db:migrate`·`db:seed` | M1 |
| `prisma.config.ts` | 신규 | `definePrismaConfig({ orm: ormConfig({ contract: './prisma/contract.prisma', db, migrations: { dir: 'migrations' } }) })` | M1 |
| `prisma/contract.prisma` | 신규 | data-model 전체(20테이블 + `auth` external) | M1(골격) → M2(전체) |
| `prisma/contract.json`·`contract.d.ts` | 생성물 | `prisma contract emit` 결과. 손으로 고치지 않는다 | M2 |
| `prisma/db.ts` | 신규 | BYO `pg.Pool` 1개 → Prisma `postgres({ contractJson, pg: pool })` 모듈 싱글턴 + `withPgTransaction`(대체 경로 준비) + temporal polyfill import | M1 |
| `migrations/app/<시각>_initial/` | 생성물 | `prisma migration plan --name initial` | M2 |
| `vitest.config.mts`·`tests/setup/*` | 신규 | 프로젝트 2개, globalSetup(마이그레이션·DB 접속 확인), TRUNCATE 헬퍼, 픽스처 빌더 | M1 |
| `tests/spike/r2-prisma8.db.test.ts` | 신규 | research S-1~S-7 | M1 **첫 Task** |
| `lib/domain/constants.ts` | 신규 | §4.1 값 집합 `as const` + 계약 일치 테스트 | M2 |
| `lib/domain/money.ts`·`refund-policy.ts`·`payment-deadline.ts`·`time.ts`·`seat-default.ts` | 신규 | 순수 함수(§4.3) | M3·A2·A3 |
| `lib/server/ports/*.ts`·`lib/server/fakes/*.ts`·`lib/server/deps.ts` | 신규 | 포트·가짜 구현·주입(§4.10). 옛 `payment_gateway.py` 파서·Fake 이식 | M3 |
| `lib/server/http.ts` | 신규 | 오류 응답(§4.8)·zod 검증·`requireMember`·멱등 헤더 파싱 | M4 |
| `lib/server/auth.ts`·`app/api/auth/[...all]/route.ts` | 신규 | Better Auth(Kysely, `auth` 스키마, bearer) | M1(스모크)·A1 |
| `lib/server/services/cancellation.ts`·`app/api/reservations/[id]/(cancel|cancellation-preview)/route.ts` | 신규 | 이관 취소(`05-cancellation-migrated.md`) | M4 |
| `lib/server/services/members.ts`·`app/api/members/route.ts`·`app/api/me/(route|profile|base-genre)/route.ts`·`app/api/dev/identity/fake-verify/route.ts` | 신규 | 가입·취향 | A1 |
| `scripts/seed.ts` | 신규 | data-model §5. `db:seed` 로 실행, 끝에 `db.close()` | A2 |
| `lib/server/services/catalog.ts`·`app/api/home/offerings/route.ts`·`app/api/offerings/[id]/route.ts` | 신규 | 홈 거르기·상세·기본 자리 | A2 |
| `lib/server/services/checkout.ts`·`expiry.ts`·`app/api/orders/**`·`app/api/internal/orders/expire/route.ts` | 신규 | 주문 생성·조회·셀프 취소·만료 | A3 |
| `lib/server/services/payment-confirmation.ts`·`app/api/payments/webhook/route.ts`·`app/api/dev/fake-pg/**`·`app/api/me/(calendar|notifications)/route.ts` | 신규 | 웹훅·확정 일괄 처리·캘린더·알림 | A4 |
| `app/api/health/route.ts` | 신규 | `/api/health` | M1 |
| `lib/api-client.ts` | 변경 | 기본 주소를 같은 출처(`/api`)로, `code` 읽기, 비율표 함수 2개 삭제 | M4 |
| `app/refund-policy/page.tsx`·`components/RefundPolicySettings.tsx`·`components/AdminNav.tsx`·`app/page.tsx` | 삭제·변경 | 비율표 화면 제거(U4 확정), 대시보드 헬스 주소 변경 | M4 |
| `.env.example` | 변경 | `DATABASE_URL`·`TEST_DATABASE_URL`·`BETTER_AUTH_SECRET`·`BETTER_AUTH_URL`·`PG_WEBHOOK_SECRET`·`FAKE_IDENTITY_SECRET`·`IDENTITY_CI_PEPPER`·`INTERNAL_API_TOKEN`·`KDANCE_DEV_ROUTES`·결제 기한 3종. 값은 예시만 | M1 |
| `tests/us1/*.test.ts`·`tests/migrated/*.test.ts` | 신규 | §7 의 AC 와 이관 대응표 | 각 슬라이스 |

### 4-2. mobile

| 경로 | 신규/변경 | 내용 | 슬라이스 |
|---|---|---|---|
| `package.json` | 변경 | `npx expo install expo-router react-native-screens react-native-safe-area-context expo-secure-store expo-linking expo-constants`(+시도: `react-native-web react-dom`) | A5 |
| `app/_layout.tsx` 외 화면 8종: `login` · `identity` · `signup` · `preferences` · `base-genre` · `(tabs)/home` · `offering/[id]` · `checkout/[orderId]`(결제 대기·가상계좌 안내) · `(tabs)/calendar` | 신규 | 보드 01-1·01-3·01-4 의 짜임, 장르 테마 색은 미적용(R7(보드와 화면 차이)) | A5 |
| `lib/api.ts`·`lib/session.ts` | 신규 | fetch 래퍼(§4.8 해석), bearer 토큰 | A5 |
| `App.tsx`·`index.ts` | 변경 | 취소 화면을 라우터 아래로 옮기고 경로 `/api/...`·세션으로 | A5 |
| `.env.example` | 변경 | `EXPO_PUBLIC_API_URL` 을 Next.js 주소(포트 3000)로 | A5 |

### 4-3. backend · 기타

| 경로 | 내용 | 시점 |
|---|---|---|
| `backend/` 전체 | **손대지 않는다.** 회귀 기준(186 passed) | S0-M9 에서 삭제(승인 뒤) |
| `infra/docker-compose.yml` | 변경 없음. 새 DB 2개는 `CREATE DATABASE` 로 | — |
| `CLAUDE.md` 「Build, Test & Verify」 | admin-web `npm test` 행·기대 결과 추가 | M1 완료 때 |
| `docs/planning/kdancex4_service_definition_and_tech_stack.md` 「11-2」 | R2 실측 결과·vitest 선언 기록 | M1 완료 때 |

DB 마이그레이션: **필요.** Alembic 은 쓰지 않는다(backend 쪽 변경 없음). Prisma `migration plan` + `db migrate` 로 새 DB 에 초기 마이그레이션 1건. 되돌리기는 새 DB 를 지우는 것으로 충분하다(기존 데이터에 손대지 않으므로 되돌리기 어려움 없음).

---

## 5. 하위 슬라이스 제안 — 경계와 완료선만 (Task 분해는 Phase 4)

| 슬라이스 | 경계(들어가는 것) | 완료선(이것만 끝나도 검증 가능) | 의존 |
|---|---|---|---|
| **S0-M1(기반·스파이크)** | Prisma 초기화(1테이블 골격), BYO 풀 `db.ts`, polyfill, vitest 2프로젝트, **R2 스파이크(research S-1~S-7) — 첫 Task**, Better Auth 스모크, `/api/health` | 스파이크 파일 결과가 표로 남고 대체 경로 선택이 기록됨 · `npm run build` 성공 · `npm test` 통과 | Docker 기동 · 새 DB 2개 |
| **S0-M2(데이터 계약)** | data-model 전체 계약 · 초기 마이그레이션 · §4.1 상수 · 제약 테스트(CHECK·유니크·부분 유니크·`held+confirmed<=capacity`) | `prisma db migrate` 가 두 DB 에 적용 · `prisma db verify` 통과 · 제약 테스트 통과 | M1(대체 경로 결정 반영) |
| **S0-M3(순수 로직 이식)** | money·refund-policy(옛 50개 이식)·payment-deadline·포트·가짜 PG(파서·멱등 원장 이식)·가짜 본인확인·웹훅 검증기·알림 포트 | `npm run test:unit` 통과 · 이관 대응표의 해당 행 채움 | 없음(**DB 불필요 — 지금 시작 가능**) |
| **S0-M4(취소 API 이관)** | `lib/server/http.ts`·`requireMember`·이관 취소·미리보기·옛 DB 시나리오 9개 이식(동시 취소 포함) · admin-web 클라이언트·비율표 화면 정리 | 9개 시나리오 통과 · backend 186 passed 그대로 · build 성공 | M2 · M3 · A1 의 세션(테스트에서는 세션 픽스처로 대신 가능) |
| **US1-A1(가입·취향)** | Better Auth 경로·가짜 본인확인·가입·프로필·기준 장르 | AC-9(가입 정보) 통과 | M2 · M3 |
| **US1-A2(시드·검색·상세)** | 시드 스크립트 · 홈 거르기 · 상세 · 기본 자리 | AC-1(조건 검색) · AC-7(성별 자리 기본값) 통과 · `npm run db:seed` 후 홈에 시드 수업 1건 | A1 |
| **US1-A3(결제 시작·만료·셀프 취소)** | 주문 생성(가격·공지 고정·자리 잡기·가짜 PG 발급) · 만료 정리·내부 경로 · 셀프 취소 | AC-4(입금 기한 만료) · AC-5(입금 전 셀프 취소) · AC-6(정원 정합성) · AC-8(결제 화면 필수 표시) 통과 | A2 |
| **US1-A4(웹훅 확정 일괄 처리)** | 웹훅·서명·세 금액 대조·멱등·확정 트랜잭션(예약·카운터·캘린더·알림 2·정산 hold)·FR-290(금액 불일치 입금)/FR-292(만료 뒤 늦은 입금)의 환불 대상 기록·dev 입금 경로·캘린더·알림 조회 | AC-2(결제 확정 일괄 처리) · AC-3(웹훅 신뢰성) · AC-10(끝까지 한 바퀴) 통과 | A3 |
| **US1-A5(mobile 화면)** | 라우터·API 클라이언트·화면 8종·취소 화면 이전 · 웹 실행 시도 | `npx tsc --noEmit` exit 0 · (가능하면) Expo web 에서 가입→결제 대기 Playwright 스냅샷, 안 되면 「화면 미검증」 기록 | A1~A4 계약(구현 완료는 아님 — 계약만 있으면 병행 가능) |
| **S0-M9(backend 삭제)** | `backend/` 삭제 · 옛 DB 삭제·이름 회수 · 이관 대응표 최종 확인 · CLAUDE.md 검증선 갱신 | AC-11(회귀) 새 정의(삭제 뒤) 통과 | 전부 + **사용자 승인**(파괴적 작업) |

병렬 여지: M3 은 M1 과 동시에 시작할 수 있다(DB 불필요). A5 는 A1 계약이 정해진 뒤 화면 골격부터 병행. M4 와 A2~A4 는 M2 뒤에 서로 독립.

---

## 6. 위험 요소

Phase 1 의 R1~R10 중 이 계획으로 바뀐 것과 새로 생긴 것만 적는다.

| ID | 내용 | 영향 | 대응 |
|---|---|---|---|
| R2(Prisma 8 트랜잭션·행 잠금 미검증) | 그대로 열려 있다 | 정원 초과·이중 확정 | D3 의 대체 3단계. S0-M1 첫 Task. 스파이크가 실패해도 계획 구조는 바뀌지 않는다 — `db.ts` 아래만 바뀐다 |
| R3(두 접근 계층이 한 DB 에 공존) | **해소** — DB 분리(D13) | — | S0-M9 까지 유지 |
| R4(확정 예약이 취소·환불 코드와 안 맞음) | **해소** — 같은 계약 안으로 이관(Q3(전환 범위) 결정) | — | 확정 예약이 S0-M4 취소 API 에 바로 붙는다 |
| R5(mobile 동작 검증 수단 부재) | 부분 완화 시도 | 화면 미검증 완료 판정 | R-15 실측, 실패 시 「화면 미검증」 명시 |
| R-P1(이관 회귀 누락) | Python 테스트 186개 중 약 절반이 Python 구조 검사(소스 문자열·`lru_cache`) | 의도가 빠진 채 「이관 완료」 | **이관 대응표**(Python 테스트 1개 → TS 테스트 또는 폐기 사유 1줄)를 S0-M3·M4 산출물로. S0-M9 착수 조건 |
| R-P2(계약 크기) | 첫 계약에 20테이블 | 초기 마이그레이션이 크고 검토가 어렵다 | 제약 테스트를 M2 완료선에 넣었다. 원하면 Phase 4 가 「이관 7테이블 판」·「US1 판」 2개 마이그레이션으로 나눌 수 있다 |
| R-P3(트랜잭션 안 PG 호출) | 주문 생성·이관 취소가 트랜잭션 안에서 PG 를 부른다 | 실 PG 에서는 긴 잠금 | 1회차는 가짜라 허용. SCH-29(PG 결제)에서 2단계 커밋으로 바꾼다고 계약에 적었다 |
| R-P4(만료가 읽기에 기댐) | 아무도 읽지 않으면 기한 지난 자리가 DB 에 `held` 로 남는다 | 대표 화면 숫자(아직 없음)가 늦게 바뀜 | 사용자 화면은 모두 정리 뒤에 읽는다. 스케줄러는 배포 단계에서 내부 경로를 부르게 |
| R-P5(취소 뒤 정산 hold 행) | 이관 취소가 `settlement_entries` 를 되돌리지 않는다 | 정산 금액 과다 | SCH-31(정산 원장) 범위. 1회차 정산은 계산·지급을 하지 않으므로 금전 영향 없음 |
| R-P6(사전 릴리스 묶음) | Prisma 8 rc.11 런타임 + rc.15 CLI(번호 다름), Better Auth 의 prisma peer override | 설치·생성물 깨짐 | 버전은 `package.json` 고정, `prisma skills sync` 경고는 M1 에서 확인. R10(사전 릴리스 의존) 대응과 같음 |
| R6(미성년자 결제 차단 누락) | 그대로 | — | 1회차는 S0 내부 시험 전용. 시드 회원은 성인 |

---

## 7. 수용 기준 갱신 (Phase 1 §5 대비)

| AC | 바뀐 점 | 이유 |
|---|---|---|
| 전체 | 러너 = vitest. 명령 `cd admin-web && npm run test:db -- tests/us1/<파일>`(DB) · `npm run test:unit`. 시드·픽스처의 「수업 1건」 = **정규 기간 1개(8회차, 남 6·여 6, 확정 8)** | D11 · Q4(시드 수업 종류) 결정 |
| AC-3(웹훅 신뢰성) | 항목 추가: `만료된 주문에 입금 통지가 오면 확정하지 않고 돌려줄 대상 1건과 알림 2건만 남긴다`(주문·결제·예약 상태, 자리 카운터, 캘린더, 정산이 모두 그대로인지 확인) · `같은 늦은 입금 통지가 두 번 와도 돌려줄 대상은 1건이다` · `셀프 취소된 주문에 입금 통지가 와도 같다` | U3 사용자 결정 · FR-292(만료 뒤 늦은 입금) 개정 · FR-116(결제 통지 중복 반영 방지) |
| AC-4(입금 기한 만료) | 마지막 항목 「만료된 주문에 늦게 온 입금 통지는 확정하지 않는다」를 **유지**하고 기대 결과를 구체화: 웹훅 200, `payment_webhook_events.result='deposit_on_closed_order'`, `payment_exceptions` 1행(`deposit_on_closed_order`, `refund_due`, 입금액 전액), 주문 `expired` 그대로, 자리 다른 회원 결제 가능 상태 그대로 | U3 사용자 결정 |
| AC-6(정원 정합성) | 「결제 대기 둘 중 먼저 입금 건만 확정」 → 결제 대기(held)가 정원을 잡으므로 같은 자리에 대기가 둘 생기지 않는다. FR-097(먼저 입금 건 확정)은 ① 「마지막 자리에 동시 결제 시작 20건 → held 1건」 ② 「만료된 주문에 늦은 입금이 와도 그 자리를 새로 잡은 회원의 주문이 확정된다」로 검증 | D2 · U3 |
| AC-8(결제 화면 필수 표시) | 예매 수수료 줄 없음(정규). 「공지 없으면 거부」 = 409 `NOTICE_MISSING` | FR-282a 는 원데이·이벤트형만 |
| AC-11(회귀) | 이관 중: backend 186 passed **+** admin-web 전체 통과. 삭제 뒤: admin-web 전체 + 이관 대응표 100% | D13 |
| 추가 AC-13(이관 취소) | `tests/migrated/cancel-api.db.test.ts` — 옛 9시나리오 | S0-M4 |
| 추가 AC-14(R2 스파이크) | `tests/spike/r2-prisma8.db.test.ts` — 결과 표가 research 에 반영 | S0-M1 |

---

## 8. 사용자 결정과 남은 확인

### 8-1. 결정 완료 (2026-11-06 사용자 답)

| ID | 결정 | 반영한 곳 |
|---|---|---|
| U1 | Q5(정산 보류 적립 포함 여부)·Q6(첫 수업 데이터 출처) **확정** — 정산 `hold` 1줄 적립(최소형 테이블), 수업은 시드 스크립트 | data-model §1 18행·§5 |
| U2 | spec FR-022(사용자 프로필) **개정됨** — 1회차 홈은 관심 지역·가능 시간대로 거르고, 장르 조건은 FR-022a(첫 화면 장르 선택·유지)의 기준 장르 1개(D16 과 같음) | D16 · `03_contracts/02-catalog.md` §1 |
| U3 | **`expired` 는 끝 상태로 고정**(권장안과 반대). 만료(또는 셀프 취소)된 주문에 입금 통지가 오면 확정하지 않고 `payment_exceptions` 에 돌려줄 대상(`deposit_on_closed_order`, `refund_due`)으로만 기록. spec FR-292(만료 뒤 늦은 입금)도 같은 내용으로 개정됨 | Q8 행 · §7 AC-3·AC-4·AC-6 · data-model §3·§4 · `03_contracts/03-checkout-payment.md` §6 |
| U4 | **권장안대로** — 비율표 GET/PUT·화면은 이관하지 않고(DB 테스트 18개 폐기), 취소 API 는 지금 동작 그대로 이관. spec FR-293~FR-295(대표가 환불 금액 입력·실행)와의 정렬은 SCH-32(정규 과정 환불)·SCH-33(이벤트형 취소) | D12 · `03_contracts/05-cancellation-migrated.md` |

### 8-2. 사용자 확인 필요

| ID | 확인할 것 | 권장안 | 이유 |
|---|---|---|---|
| U5 | `backend/` 삭제 시점 | **US1-A 다섯 슬라이스가 끝나고 이관 대응표가 100% 일 때, 별도 슬라이스 S0-M9(backend 삭제)로 그때 다시 승인** | 삭제는 되돌리기 어렵다. 그 전까지 186 passed 가 가장 싼 회귀 검사다. Phase 4(Task 분리)·Phase 5(구현)를 막지 않는다 |

---

## 9. Phase 4(Task 분리)로 넘기는 것

- §5 슬라이스 표를 수직 슬라이스 단위로 쓰고, 각 슬라이스 안에서 Task 를 나눈다. **S0-M1 의 첫 Task 는 R2 스파이크**로 고정
- Task 마다 참조할 문서 절: 데이터는 `03_data-model.md` 의 해당 테이블 행, API 는 `03_contracts/` 의 해당 파일, 미확인 처리는 `03_research.md` 의 R 번호
- 이관 대응표(R-P1)는 S0-M3·M4 의 산출물로 Task 에 넣는다
- SCH 대응: 이 계획은 SCH-21(FastAPI→Next.js 전환)·SCH-24(인증·역할)·SCH-26(수업·회차 등록)·SCH-27(검색·필터)·SCH-28(예약·정원·대기)·SCH-29(PG 결제)·SCH-31(정산 원장)·SCH-38(알림)의 **일부**를 세로로 자른다(Phase 1 §9). 새 SCH 번호를 만들지는 오케스트레이터가 정한다

---

## 10. 2026-11-10 필수 기능 점검 보완 (추천안, 사용자 확인 대기)

출처: `_workspace/role-essentials/integration.md` 와 근거 보고서 `member.md`·`instructor.md`·`owner.md`. 2026-11-07 결정(구현 보류, 보드가 다 된 뒤 플랜을 대표 → 강사 → 회원 순으로 다시 짠다)에 따라 **플랜을 다시 짜지 않았다.** 아래는 이 US1 1회차 플랜에서 틀린 곳을 고치고(10-1), 1회차에 직접 걸리는 보완을 덧붙이고(10-2), 나머지를 후속으로 보낸 기록이다(10-3). 새 Task 번호는 만들지 않았다.

### 10-1. 고친 것 (D-04(주문 테이블))

| 무엇 | 어디 | 내용 |
|---|---|---|
| 주문 시점 스냅샷 칸 추가 | `03_data-model.md` §2-1 `orders` 행 · §6-2 | `booking_fee_amount` · `platform_fee_rate_bp` · `cancel_fee_platform_share_bp` · `member_terms_version` · `merchant_terms_version`. 근거 FR-284(주문 시점 값 고정)·FR-245(결제 시점 정책 적용)·FR-125e(취소 수수료 5:5·판매 수수료 5%) |
| 금액 검사식 수정 | `03_data-model.md` §6-1 | 예매 수수료를 더하고 0원 하한을 둔다. 전후 식과 손계산 표는 그 절 |
| 계약 맞춤 | `03_contracts/03-checkout-payment.md` §1 8번 · §3 · §6 5번 | 같은 INSERT 에 고정 칸을 넣고, 웹훅 금액 대조의 `total_amount` 가 예매 수수료를 포함한다고 적었다 |

### 10-2. US1 범위 판단 — 6개 후보

범위 기준은 요구사항 문서 §1-3·§1-4(1회차: 정규 수업, 가상계좌·카드, 앱 내 알림은 기록만, 실 PG·쿠폰·할인 없음). (2026-11-10 변경 — 이전: 가상계좌가 단건 기본. 정규 수업의 기본 결제수단은 이제 카드이고, 이벤트형은 간편 계좌이체·가상계좌만 받는다. 1회차 시드가 정규 수업 120,000원뿐이라 1회차 흐름은 그대로이고, 「이벤트형 주문의 카드·간편결제 거부, 카드 승인 통지 전액 취소」는 이벤트형이 들어오는 후속 회차 일이다.)

| 지침 | 판단 | 근거 한 줄 |
|---|---|---|
| M-03(결제 실패 시 자리 해제·주문 종료) | **1회차에 넣는다(추천안)** | FR-111a(카드 허용 범위)로 카드가 1회차에 있고, 승인 실패 때 `held` 가 풀리지 않으면 자리가 기한까지 잠긴다. 상태를 늘리지 않고 값 하나(`payment_failed`)만 더한다. 계약 03 §8 · data-model §6-3 |
| M-04(진행 중 주문 복구) | **1회차에 넣는다(추천안)** | `uq_reservations_member_offering_active` 때문에 결제창을 닫고 돌아오면 `ALREADY_RESERVED` 로 막혀 기한까지 같은 수업을 못 산다. 지금 설계의 빈틈이다. 계약 03 §8 |
| M-05(0원 신청) | 후속으로 보낸다 | 1회차 가격은 120,000원 시드뿐이고 할인·쿠폰이 항상 0 이다. 0원은 무료 수업(I-04)·쿠폰이 들어올 때 생긴다 |
| M-13(입금 기한 임박 알림) | 후속으로 보낸다 | 실제 알림 발송은 SCH-38(알림) 몫이고 1회차는 기록 테이블만 둔다(FR-114(결제 확인 앱 알림)) |
| O-14(PG 대사·웹훅 유실 보정) | 후속으로 보낸다 | 1회차는 가짜 PG 라 맞춰 볼 외부 거래 내역이 없다. 실 PG 선정(SCH-29(PG 결제)) 뒤 |
| O-15(금액 끝수 올림) | 후속으로 보낸다(규칙 한 줄만 기록) | 1회차에는 비율 계산이 없다(정산 `hold` 는 결제액 그대로). 올림 규칙은 소스 `money.ts` 에 이미 있고, 수수료 기준 금액은 사용자 결정이 필요해 Q-O-1(수수료 기준 금액·끝수)로 올렸다 |

M-03·M-04 는 **Task 로 만들지 않았다.** 구현은 US1-A3(결제 시작·만료·셀프 취소)·US1-A4(웹훅 확정 일괄 처리) 슬라이스의 계약 보완이고, Task 에 어떻게 넣을지는 플랜을 다시 짤 때 정한다.

### 10-3. 후속

나머지 지침 목록, 환불 비율표 코드 정렬(D-05), 관리자 웹 2단계 인증 확대(D-06), 2026-11-10 결정, 플랜 전에 정해야 할 결정 질문은 `04_task-splitter_tasks.md` 맨 끝 「2026-11-10 필수 기능 점검에서 나온 후속」에 모았다.

