# Phase 2(기존 코드 구조 확인) — FastAPI → Next.js + Prisma 8 전환 코드 조사

작성: 2026-09-20 · 담당: code-searcher
입력: `_workspace/00_input/request.md` · `_workspace/01_req-analyst_requirements.md` · `docs/ai-coding-agent.html`
탐색 범위: `backend/`(읽기 전용, 수정 없음) · `admin-web/`
근거 원칙: 실제 파일을 읽고 `파일:줄`로 댄다. 읽지 않은 것은 "못 찾았다"로 적는다.

---

## 0. 결론 먼저

| 항목 | 결론 | 확신도 |
|---|---|---|
| **R2(Prisma 8 트랜잭션·행 잠금 미검증) — 트랜잭션** | **지원함.** `db.transaction(fn)` 콜백형. 커밋/롤백 자동 | High (설치본 `.d.mts` + 런타임 `.mjs` 직접 확인) |
| **R2(Prisma 8 트랜잭션·행 잠금 미검증) — 행 잠금(`FOR UPDATE`)** | **빌더 API 없음. raw SQL 로 우회 가능** — 그리고 그 raw 플랜을 트랜잭션 안에서 실행할 수 있다 | High (타입 호환성까지 확인) |
| **R2(Prisma 8 트랜잭션·행 잠금 미검증) — 중첩 트랜잭션(SAVEPOINT)** | **없다.** 설치본 전체에 `SAVEPOINT` 문자열이 없다 | High (전 패키지 grep) |
| **R2(Prisma 8 트랜잭션·행 잠금 미검증) — 격리수준·타임아웃 옵션** | **없다.** `transaction()` 이 옵션 인자를 받지 않고, 런타임은 맨 `BEGIN` 만 보낸다 | High |
| **R3(부분 유니크 인덱스 PSL 표현 미검증) — 부분 유니크 인덱스** | **지원함.** PSL `@@index([...], where: "...", unique: true, name: "...")` | High (PSL 스펙 타입 + 마이그레이션 op 타입 양쪽 확인) |
| **R3(부분 유니크 인덱스 PSL 표현 미검증) — CHECK 제약** | **지원함.** PSL `@@check(expression:, name:/map:)` + 마이그레이션 `addCheckConstraint` | High |
| **추가 발견 — 서버리스 façade** | `postgresServerless()` 는 **`transaction()` 과 `orm` 을 의도적으로 빼놓았다.** Vercel Edge 런타임을 쓰면 취소 트랜잭션이 아예 불가능 | High |

**Phase 3(구현 계획)이 가장 먼저 결정해야 할 것**: 취소 오케스트레이션의 행 잠금을 `tx.query(db.raw.sql\`... FOR UPDATE\`.returnsRow(...).build())` 로 옮기고, SAVEPOINT 가 없으므로 **멱등 INSERT 충돌 복구 경로를 재설계**한다(§2.4).

---

## 1. 1순위 (a) — `services/cancellation.py` 트랜잭션 경계 해부

파일: `/home/user/kdance/backend/app/services/cancellation.py` (1,069줄)

### 1.1 트랜잭션은 어디서 시작해 어디서 끝나는가

**시작 지점이 코드에 없다.** 세션은 FastAPI 의존성이 만들어 넘긴다:

- `/home/user/kdance/backend/app/db.py:52-58` — `get_db()` 가 요청마다 `SessionLocal()` 을 열고 `finally: db.close()` 로 닫는다.
- `/home/user/kdance/backend/app/db.py:39-47` — `sessionmaker(autoflush=False, autocommit=False, expire_on_commit=False)`.
  `autocommit=False` 이므로 SQLAlchemy 가 첫 쿼리에서 암묵적으로 트랜잭션을 연다. 즉 **트랜잭션의 실질적 시작점은 `_lock_reservation()` 의 첫 SELECT** 다.
- `/home/user/kdance/backend/app/routers/reservations.py:142-152` — 라우터가 `session` 을 주입받아 `cancel_reservation(session, ...)` 에 그대로 넘긴다.

**끝나는 지점은 세 곳이다** — 이게 중요하다. "함수 하나 = 트랜잭션 하나"라는 파일 상단 주석(`cancellation.py:600-603`)과 달리, 실제 커밋 지점은 3개다.

| # | 위치 | 상황 | 커밋 후 동작 |
|---|---|---|---|
| C1 | `cancellation.py:807` | 카드 결제 등 **미지원 결제수단**. 실패 행을 확정하고 커밋 | 커밋 후 `_notify(REFUND_FAILED)` → `UnsupportedRefundMethodError(422)` 를 던진다 |
| C2 | `cancellation.py:885` | 정상 경로(성공·대기·PG실패 전부) | 커밋 후 슬롯락 해제 + 알림 |
| C3 | (없음) | 3단계 멱등 재생 / 6단계 유니크 충돌 | **커밋하지 않고 return** — `get_db()` 의 `close()` 가 암묵 롤백 |

C1 의 존재가 전환에서 놓치기 쉽다. 라우터 주석(`reservations.py:186-187`)이 이미 짚어 두었다: "서비스가 이미 실패 사유를 DB에 커밋한 뒤 던지므로 롤백할 것이 없다." **Prisma 8 의 `db.transaction(fn)` 은 콜백이 throw 하면 무조건 롤백한다** — 이 구조를 그대로 옮기면 실패 기록이 사라진다. 트랜잭션을 먼저 정상 반환으로 닫고 그 바깥에서 422 를 던지도록 바꿔야 한다.

### 1.2 `SELECT ... FOR UPDATE` — 어디에 왜 거는가

- 거는 곳은 **한 곳뿐**: `/home/user/kdance/backend/app/services/cancellation.py:398-407`

```python
def _lock_reservation(session: Session, reservation_id: uuid.UUID) -> Reservation:
    return session.execute(
        select(Reservation).where(Reservation.id == reservation_id).with_for_update()
    ).scalar_one_or_none()
```

- 호출은 `cancellation.py:645` — `cancel_reservation()` 의 **1단계, 다른 무엇보다 먼저**.
- 이유는 `cancellation.py:401-404` 주석에 있다: 동시 취소 요청 2건 중 하나가 여기서 대기하고, 풀렸을 때는 앞선 요청이 이미 `Refund` 를 만든 뒤라 뒤 요청은 멱등 재생 경로(3단계)로 빠진다.
- `preview_cancellation()`(`cancellation.py:504`)은 잠그지 않는다 — 순수 조회다.
- 잠금 대상은 `reservations` 행 하나다. `class_schedules` 는 잠그지 않고 대신 조건부 UPDATE 로 처리한다(§1.4).

### 1.3 커밋 전 / 커밋 후

**커밋 전 (C2 기준, 1~9단계 — `cancellation.py:645-884`)**

1. 행 잠금 (`:645`)
2. 소유권 검증 → 403 (`:650-652`)
3. **멱등 재생 검사** (`:662-685`) — 상태 전이 검증보다 **앞**. 순서를 바꾸면 중복 요청이 409 로 튕겨 수용 기준이 깨진다(`:663-665` 주석)
4. 상태 전이 검증 → 409 (`:688-698`)
5. 결제 원거래 조회 + `calculate_refund()` (`:701-711`)
6. `Refund` INSERT — SAVEPOINT 로 감싼 flush (`:713-758`)
7. `refund_events` 요청 이벤트 INSERT (`:760-779`)
8. PG 환불 호출 (`:781-812`)
9. 결과 반영 — 성공이면 `reservation.status='cancelled'`, `orders.status='refunded'`, `reserved_count -= 1`, 감사 이벤트 2건 (`:815-880`)
10. `session.commit()` (`:885`)

**커밋 후 (11단계 — `cancellation.py:887-895`)**

- `_release_slot_lock()` (`:979-1007`) — Redis 슬롯락 해제. **반환값을 의도적으로 버리고 예외도 삼킨다.**
- `_notify_outcome()` (`:1038-1069`) → `_notify()` (`:1009-1036`) — 회원·학원 관리자 **2방향**. 각각 try/except 로 감싸 한쪽 실패가 다른 쪽을 막지 않는다.

순서 근거는 파일 상단 `cancellation.py:20-23` 에 명시돼 있다. 롤백될지 모르는 트랜잭션을 근거로 "취소됐습니다"를 보내면 안 되고, 캐시·푸시 장애가 확정된 환불을 되돌려서도 안 된다.

**전환 시 함의**: Prisma 8 의 `db.transaction(fn)` 은 콜백 경계가 곧 트랜잭션 경계다. 슬롯락 해제·알림은 **콜백 바깥**으로 빼야 한다. 콜백의 반환값이 그대로 통과하므로(`references/queries-postgres.md:359`) `outcome` 을 반환하고 바깥에서 부수효과를 실행하는 형태가 자연스럽다.

### 1.4 멱등성 방어는 몇 겹인가

**3겹이고 권위는 DB 하나다** (`cancellation.py:26-39` 주석).

| 겹 | 장치 | 위치 | 성격 |
|---|---|---|---|
| 1 | 부분 유니크 인덱스 `UNIQUE (reservation_id) WHERE status <> 'failed'` | `/home/user/kdance/backend/alembic/versions/0001_initial_domain.py:305-311` | **구조적 권위.** 이게 없으면 이중 환불이 가능 |
| 2 | `refunds.idempotency_key` UNIQUE | `0001_initial_domain.py:298` (`uq_refunds_idempotency_key`) | 헤더를 안 보내는 클라이언트도 막힌다 |
| 3 | `SELECT ... FOR UPDATE` | `cancellation.py:398-407` | 정상 경로에서 1·2 겹이 **안 보이게** 해 주는 층. 성능/UX 층이지 권위가 아니다 |

**보조 장치 — 결정적 멱등 키**: `build_idempotency_key()` (`cancellation.py:362-385`). 헤더가 없으면 `sha256("cancel:" + reservation_id)` 로 예약당 항상 같은 키를 만든다. 접두사 `IDEMPOTENCY_KEY_PREFIX = "cancel:"` 는 고정값이다(`cancellation.py:175`).

**충돌 복구 경로 — 여기가 전환의 진짜 난점**:

```python
# cancellation.py:732-734
with session.begin_nested():      # ← SAVEPOINT
    session.add(refund)
    session.flush()
except IntegrityError:            # :735
    ...
    winner = _find_active_refund(...) or _find_refund_by_idempotency_key(...)
    return _outcome_from_refund(winner, ..., replayed=True)   # :755-758
```

SAVEPOINT 를 쓰는 이유가 `cancellation.py:728-731` 에 명시돼 있다 — **바깥 트랜잭션 전체를 롤백하면 1단계의 `FOR UPDATE` 잠금까지 풀려서 경합이 다시 열린다.** Prisma 8 에 SAVEPOINT 가 없으므로(§2.3) 이 경로는 재설계가 필요하다.

**정원 복구는 잠금이 아니라 조건부 UPDATE** — `cancellation.py:956-977`:

```python
update(ClassSchedule).where(id == ...).where(reserved_count > 0)
    .values(reserved_count=ClassSchedule.reserved_count - 1)
```

읽고-고쳐-쓰기를 피해 한 문장으로 감소시키고, `reserved_count > 0` 조건으로 CHECK 제약 위반 대신 0행 갱신이 되게 했다. `rowcount != 1` 이면 경고만 남기고 환불은 그대로 진행한다.

### 1.5 PG 실패 / pending 처리

- **PG 실패 시 예약을 취소하지 않는다** (`cancellation.py:816-826`, 근거 주석 `:41-46`): 환불 실패인데 좌석까지 없애면 회원이 자리도 돈도 잃는다. `failed` 는 부분 유니크 인덱스 밖이라 그대로 재시도 가능.
- **`pending` 은 실패가 아니다** (`:47-53`): 가상계좌 환불은 별도 송금이라 즉시 완결되지 않는다. `pending` 에서도 좌석은 반납되고 예약은 취소 확정된다. `refunded_amount` 는 0 으로 둔다(`_apply_success`, `:914-929`).
- 실패도 **예외가 아니라 결과**다 — `CancellationOutcome.is_failed`(`:319-326`). 실패 사유를 DB 에 남긴 커밋이 예외로 날아가면 안 되기 때문.

---

## 2. 1순위 (b) — 설치된 Prisma 8 의 트랜잭션·행 잠금·raw SQL

근거는 전부 **설치본**이다. 경로 기준: `/home/user/kdance/admin-web/node_modules/@prisma/`
버전: `@prisma/orm-postgres@8.0.0-rc.11` (`orm-postgres/package.json:3`), CLI `prisma@8.0.0-rc.15` (`admin-web/package.json:41`)

> 부수 발견: 이 패키지는 `skills/prisma-8/` 디렉터리를 동봉한다(`orm-postgres/package.json:9-12`, 17,865줄). `SKILL.md` + `references/{runtime,queries-postgres,contract,migrations,...}.md` 로, **Prisma 팀이 직접 쓴 에이전트용 레퍼런스**다. 웹 문서 대신 이걸 근거로 쓸 수 있다. Phase 3(구현 계획)·Phase 5(구현)는 여기를 먼저 읽어야 한다.

### 2.1 클라이언트 생성 — `new PrismaClient()` 가 없는 것이 맞다

`orm-postgres/dist/postgres-CBDyBUe9-Dg4ZOUYS.d.mts:122-130`:

```ts
declare function postgres<TContract extends Contract<SqlStorage>>(
  options: PostgresOptionsWithContractJson<TContract>
): PostgresClient<TContract>;
// - Emitted: postgres<Contract>({ contractJson, url })
```

- import 경로는 `@prisma/orm-postgres/runtime` 의 **default export** 다 (`orm-postgres/dist/runtime.d.mts:17` — `postgres as default`).
- 바인딩은 `url` / `pg`(기존 `pg.Pool`·`Client`) / `binding` **셋 중 하나만** (`postgres-...d.mts:24-36`, 상호 배타).
- 풀 튜닝은 `poolOptions.connectionTimeoutMillis` · `idleTimeoutMillis` **둘뿐**이다 (`:102-105`). max 커넥션 수는 노출되지 않는다 — 필요하면 `pg.Pool` 을 직접 만들어 `pg:` 로 넘긴다(`skills/prisma-8/references/runtime.md:345`).

**주의 — 문서와 설치본의 import 경로가 다르다.** 동봉 스킬 문서는 `@internal/postgres/runtime` 을 쓰라고 한다(`references/runtime.md:29-30`). `@internal/postgres` 는 `prisma orm init` 이 스캐폴딩하는 **façade 패키지**이고(`references/quickstart.md:35`), **지금 `admin-web/node_modules` 에 없다**(확인함). Phase 3 은 둘 중 하나를 정해야 한다:
- (a) `prisma orm init --target postgres --authoring psl` 을 돌려 façade 를 깔고 문서대로 `@internal/postgres/runtime` 을 쓴다 — 문서와 일치, 권장
- (b) 설치본 `@prisma/orm-postgres/runtime` 을 직접 import 한다 — 지금 당장 되지만 문서 예제와 어긋난다

### 2.2 트랜잭션 — **지원함**

타입: `orm-postgres/dist/postgres-CBDyBUe9-Dg4ZOUYS.d.mts:93`

```ts
transaction<R>(fn: (tx: PostgresTransactionContext<TContract>) => PromiseLike<R>): Promise<R>;
```

`PostgresTransactionContext` 가 가진 것 (`:76-81`):

```ts
interface PostgresTransactionContext<TContract> extends TransactionContext {
  readonly sql: Db<TContract>;
  readonly orm: OrmClient<TContract>;
  readonly enums / nativeEnums;
}
```

그리고 `TransactionContext extends RuntimeQueryable extends RuntimeScope`
(`orm-family-sql/dist/prepared-statement-9QpkE6JG-B9xqBu5T.d.mts:381-384`), `RuntimeScope` 는
(`orm-family-sql/dist/types-CyxGtOOh-BJnoWm0f.d.mts:29-32`):

```ts
interface RuntimeScope {
  query<Row>(plan: SqlOrmPlan<Row>, options?): AsyncIterableResult<Row>;
  execute(plan: SqlOrmPlan, options?): Promise<SqlStatementStats>;
}
```

- 커밋/롤백: 콜백이 정상 반환하면 커밋, throw 하면 롤백 (`references/runtime.md:280`).
- 콜백 반환값은 그대로 통과한다 (`references/queries-postgres.md:359`).
- **`tx` 에 `raw` 가 없다.** `PostgresClient` 에는 `readonly raw: RawLane<TContract>` 가 있지만(`:87`) `PostgresTransactionContext` 에는 없다. 우회는 §2.5.

### 2.3 트랜잭션의 한계 — 옵션 없음, SAVEPOINT 없음

**(1) 격리수준·타임아웃·재시도 옵션이 없다.** `transaction<R>(fn)` 의 시그니처에 두 번째 인자가 아예 없다(`:93`). 런타임 구현도 맨 `BEGIN` 만 보낸다:

`orm-target-postgres/dist/runtime-Di_BFzUC.mjs:365`
```js
await this.#connection.query("BEGIN").catch(rethrowNormalizedError);
```

`SET TRANSACTION ISOLATION LEVEL` 도, `statement_timeout` 설정도 없다. 격리수준이 필요하면 트랜잭션 안에서 raw SQL 로 `SET LOCAL ...` 을 직접 실행해야 한다. **이 방식은 이 프로젝트에서 돌려본 적이 없다 — 미검증으로 남긴다.**

**(2) 중첩 트랜잭션 / SAVEPOINT 가 없다.**

```
grep -rn "SAVEPOINT" --include=*.mjs --include=*.d.mts /home/user/kdance/admin-web/node_modules/@prisma/
→ 0건
```

`BEGIN` 문자열이 나오는 곳은 3군데뿐이고(`orm-target-postgres/dist/control-BF220oqr.mjs:383`, `runtime-Di_BFzUC.mjs:287,365`) 전부 최상위 트랜잭션이다. 커서 스트리밍용 `BEGIN`(`:287`)은 `inExplicitTransaction()` 으로 중첩을 **피하도록** 짜여 있다(`:283-286`) — 즉 중첩을 지원하는 게 아니라 회피한다.

**이것이 `cancellation.py:732` 의 `session.begin_nested()` 를 그대로 옮길 수 없다는 뜻이다.** Phase 3 이 대안을 정해야 한다:

| 대안 | 방식 | 대가 |
|---|---|---|
| A. 선제 조회로 충돌을 사전 회피 | `FOR UPDATE` 로 잠근 뒤 활성 환불을 조회(3단계)하는 지금 로직에 의존. 잠금이 유효하면 INSERT 충돌은 사실상 발생하지 않는다 | 유니크 위반이 나면 트랜잭션 전체가 죽는다 — **방어가 3겹에서 2겹으로 준다** |
| B. `INSERT ... ON CONFLICT DO NOTHING RETURNING` | raw SQL 로 충돌을 예외가 아닌 0행으로 받아 트랜잭션을 살린다. 0행이면 같은 트랜잭션 안에서 승자 행을 조회 | 부분 유니크 인덱스를 `ON CONFLICT` 대상으로 지정하는 문법 확인 필요(`ON CONFLICT (reservation_id) WHERE status <> 'failed'`) |
| C. 트랜잭션 밖에서 재시도 | 충돌이 나면 전체 트랜잭션을 버리고 멱등 재생 경로로 재진입 | 재시도 루프가 늘고 PG 호출 중복 위험 |

**분석자 의견: B안.** 빌더의 `insert().onConflict(...)` 지원 여부는 확인했다 — AST 레벨에 `InsertOnConflict`, `DoNothingConflictAction`, `DoUpdateSetConflictAction` 이 존재한다(`orm-family-sql/dist/relational-core.d.mts:13` export 목록). 다만 **부분 인덱스를 conflict target 으로 지정할 수 있는지는 확인하지 못했다.** raw SQL 이면 확실하다.

**(3) 서버리스 façade 에는 트랜잭션이 아예 없다.** `orm-postgres/dist/serverless.d.mts:38-43`:

> "the returned client deliberately omits `orm`, `runtime()`, and `transaction()`."

`PostgresServerlessClient` 가 가진 것은 `sql`, `context`, `stack`, `contract`, `connect()` 뿐이다(`:10-18`). **배포 목표가 Vercel 이므로 이건 중요하다.** Next.js Route Handler 를 Node 런타임에서 돌리면 일반 `postgres()` façade 를 쓸 수 있지만, Edge 런타임(`export const runtime = 'edge'`)으로 넘어가는 순간 취소 트랜잭션이 불가능해진다. **취소·환불 경로는 Node 런타임으로 못박아야 한다.**

### 2.4 행 잠금(`FOR UPDATE`) — **빌더 API 없음**

전 패키지 검색 결과:

```
grep -rn "forUpdate|for_update|lockClause|skipLocked|nowait" --include=*.mjs --include=*.d.mts @prisma/
→ 0건

grep -rn -i "FOR UPDATE" --include=*.mjs --include=*.d.mts @prisma/
→ 2건, 둘 다 RLS 정책 문서 주석 (orm-postgres/dist/contract-builder.{mjs:217,d.mts:110})
  "Authors a `FOR UPDATE` policy (PSL `policy_update`)" — 행 잠금과 무관한 RLS `FOR UPDATE` 정책이다
```

`SelectQuery` 인터페이스(`orm-family-sql/dist/db-BhQdL6Za-DubRGJvv.d.mts:424~`)에도 잠금 메서드가 없다. 있는 것은 `where` / `orderBy` / `limit` / `offset` / `distinctOn` / `annotate` 계열뿐이다.

**결론: 행 잠금을 표현하는 1급 수단이 Prisma 8 rc.11 에 없다.**

### 2.5 raw SQL 우회 — **가능하다. 트랜잭션 안에서도 된다**

이게 R2(Prisma 8 트랜잭션·행 잠금 미검증) 의 해답이다. 세 단계로 검증했다.

**(1) raw 레인이 존재한다.** `orm-family-sql/dist/db-BhQdL6Za-DubRGJvv.d.mts:386-388`:

```ts
type RawLane<C extends TableProxyContract> = {
  readonly sql: RawTagFor<C>;   // db.raw.sql`...`
};
```

`PostgresClient.raw` 로 노출된다(`postgres-CBDyBUe9-Dg4ZOUYS.d.mts:87`).
문서 확인: "Raw SQL is spelled `db.raw.sql`, not `db.sql.raw`" (`references/queries-postgres.md:415`).

**(2) raw 빌더의 종단이 플랜을 만든다.** `orm-family-sql/dist/expression-mku9I7Ue.d.mts:203-215`:

```ts
interface RawRowQuery<Row, Refs> {
  readonly returns: Refs;
  buildAst(): RawQueryAst;
  build(): SqlQueryPlan<Row>;      // ← 플랜
}
interface RawAffectedCountQuery { build(): SqlQueryPlan<AffectedCount>; }   // :235-237
```

**(3) 그 플랜을 `tx` 가 받는다.** `orm-family-sql/dist/types-CyxGtOOh-BJnoWm0f.d.mts:21`:

```ts
type SqlOrmPlan<Row = unknown> = SqlExecutionPlan<Row> | SqlQueryPlan<Row>;
```

`RuntimeScope.query(plan: SqlOrmPlan<Row>)` 가 `SqlQueryPlan` 을 받으므로, `tx.query(rawPlan)` 은 **타입 레벨에서 호환된다.**

따라서 쓸 수 있는 형태는 이렇다 (아직 이 프로젝트에서 실행해 보지 않았다 — 타입 근거만):

```ts
const lockPlan = db.raw.sql`
  SELECT id, user_id, order_id, class_schedule_id, status, cancelled_at
  FROM reservations WHERE id = ${reservationId} FOR UPDATE
`.returnsRow({ id: 'pg/uuid@1', user_id: 'pg/uuid@1', /* ... */ }).build();

await db.transaction(async (tx) => {
  const [reservation] = await tx.query(lockPlan);   // 행 잠금이 이 트랜잭션에 걸린다
  // ... 나머지는 tx.orm / tx.sql
});
```

**열려 있는 위험 (Phase 3 이 실측해야 한다)**
1. `db.raw` 는 클라이언트 레인이지만 `.build()` 로 만든 **플랜은 순수 데이터**다. `tx.query()` 로 실행하면 그 트랜잭션의 커넥션을 쓴다 — 타입상 그렇고 문서(`references/queries-postgres.md:392` "Inside a transaction, `tx.query(plan)` / `tx.execute(plan)`")도 그렇게 말한다. **실제로 잠금이 그 트랜잭션에 걸리는지는 통합 테스트로 확인해야 한다.** 여기서 틀리면 멱등성 방어가 통째로 무너진다.
2. 각 컬럼마다 코덱 id 를 손으로 선언해야 한다(`returnsRow`). 코덱 id 표기(`pg/uuid@1` 등)는 emit 된 `contract.d.ts` 에서 읽어야 한다 — **지금 추정으로 쓴 것이고 확인하지 않았다.**
3. 캐시 미들웨어는 트랜잭션 안에서 자동 우회된다(`references/runtime.md:217`) — 이건 우리에게 유리하다.

### 2.6 그 밖에 확인한 제약

| 항목 | 상태 | 근거 |
|---|---|---|
| 배열형 배치(`$transaction([a, b])`) | **없다.** `db.transaction(async tx => ...)` 로 감싸라 | `references/queries.md:216` |
| TypedSQL(`.sql` 파일 컴파일) | 없다 | `references/queries.md:214` |
| `EXPLAIN` / 플랜 검사 | 없다. `db.raw.sql\`EXPLAIN ANALYZE ...\`` 로 우회 | `references/debug.md:129` |
| 쿼리 로거 내장 | 없다. `afterQuery` 미들웨어 직접 작성 | `references/runtime.md:346` |
| 읽기 복제본 라우팅 | 없다 | `references/runtime.md:344` |
| `db.end()` | 없다. `await db.close()` | `references/runtime.md:133` |
| `Temporal` 의존 | **Node 26.8.2+ 만 `globalThis.Temporal` 을 갖는다. Node 24 는 없다** — `Timestamptz` 컬럼 첫 읽기/쓰기에서 `RUNTIME.TEMPORAL_UNAVAILABLE` 로 죽는다 | `references/contract.md:119` |

**마지막 항목이 새 리스크다.** 이 프로젝트의 런타임은 **Node 24.21.0**(`request.md`)이고, 도메인 모델은 `TIMESTAMP WITH TIME ZONE` 투성이다(`models/class_schedule.py:57`, `models/payment.py:51`, `models/reservation.py:63`, `models/base.py:32,37`). 두 가지 선택지뿐이다:
- `import 'temporal-polyfill/full/global'` 을 첫 쿼리 전에 로드하고 `temporal-polyfill` 을 의존성에 추가
- 컬럼을 `TimestamptzString(p)` 로 작성해 Postgres 텍스트를 그대로 받는다

**Phase 3 이 반드시 결정해야 한다. 미해결 질문으로 올린다(§6 Q-new-1).**

---

## 3. 2순위 — R3(부분 유니크 인덱스 PSL 표현 미검증): 부분 유니크 인덱스의 PSL 표현

### 3.1 원본이 요구하는 것

`/home/user/kdance/backend/alembic/versions/0001_initial_domain.py:305-311`:

```python
op.create_index(
    "uq_refunds_reservation_id_active",
    "refunds",
    ["reservation_id"],
    unique=True,
    postgresql_where=sa.text("status <> 'failed'"),
)
```

### 3.2 PSL 은 이걸 표현할 수 있다 — **지원함**

**근거 1 — PSL 속성 스펙 타입** (`orm-family-sql/dist/contract-psl__attribute-specs.d.mts:20-30`):

```ts
readonly index: () => AttributeSpec<{
  fields?: string[];
  readonly expression?: string;
  readonly where?: string;       // ← 부분 인덱스 술어
  readonly unique?: boolean;     // ← 유니크
  readonly name?: string;
  readonly map?: string;
  readonly type?: string;
  readonly options?: Record<string, string>;
}, ModelAttributeCtx>;
```

**근거 2 — TS 빌더 옵션 타입** (`orm-family-sql/dist/contract-builder-De_sioHE.d.mts:255-262`):

```ts
type IndexOptionsBase<Name> = {
  readonly name?: Name;
  /** Exact physical name — adopted verbatim, no wire hash. Xor `name`. */
  readonly map?: string;
  /** Opaque SQL: partial-index predicate (WHERE body, without the keyword). */
  readonly where?: string;
  readonly unique?: boolean;
};
```

**근거 3 — 마이그레이션 연산 타입** (`orm-target-postgres/dist/op-factory-call-BAeyLFYf-BAgG1h1C.d.mts:31-41`):

```ts
interface CreateIndexExtras {
  readonly type?: string;
  readonly options?: Record<string, unknown>;
  /** Partial-index predicate (WHERE body, without the keyword). Inserted
   *  verbatim, never quoted or escaped */
  readonly where?: string;
  readonly unique?: boolean;
}
```
`createIndex({ schema, table, index, columns, extras })` 가 이 `extras` 를 받는다(`orm-target-postgres/dist/postgres-migration-BNsrwlxh-CwI5BqAu.d.mts:209-219`).

**근거 4 — 동봉 문서 예제** (`references/contract.md:120-124`):

```prisma
@@index([authorId], where: "(archived_at IS NULL)", name: "posts_author_active")
```

### 3.3 따라서 `contract.prisma` 는 이렇게 쓴다

```prisma
model Refund {
  // ...
  @@index([reservationId], where: "status <> 'failed'", unique: true, map: "uq_refunds_reservation_id_active")
}
```

**`name:` 과 `map:` 의 선택이 갈린다.**
- `name:` → 물리명이 `<name>_<8자리해시>` 가 된다(wire-named). 이름 변경이 `ALTER INDEX ... RENAME` 으로 계획된다.
- `map:` → 물리명을 **그대로** 쓴다. 다만 SQL 본문(`where:`)과 함께 쓰면 빌드 시 `PN_EXACT_NAME_BODY_COMPARISON` 경고가 난다 — drift 검출이 손으로 쓴 텍스트를 Postgres 의 reprint 와 바이트 비교하기 때문이다(`references/contract.md:126`).

**DB 가 비어 있으므로(테이블 0개) 물리명을 유지할 이유가 없다. `name:` 을 권장한다** — 경고가 없고 rename 이 1급으로 처리된다. 다만 `backend/` 쪽 코드/테스트가 인덱스 이름을 문자열로 참조하는지 확인해야 한다(현재 `cancellation.py` 는 이름이 아니라 `IntegrityError` 타입으로만 분기하므로 영향 없다 — `cancellation.py:735`).

### 3.4 CHECK 제약도 표현된다

원본에 CHECK 이 11개 있다 (`0001_initial_domain.py:94,98,129,130,132,172,176,208,266,271,275,276,277,281`).

- PSL: `@@check(expression:, name:/map:)` (`contract-psl__attribute-specs.d.mts:31-35`)
- 마이그레이션: `addCheckConstraint` / `renameCheckConstraint` / `dropCheckConstraint`, 헬퍼 `checkExpression` (`references/migrations.md:365,369`)

### 3.5 raw SQL 마이그레이션 탈출구도 있다

필요 없을 가능성이 높지만, 있다는 사실은 기록해 둔다. `references/migrations.md:369`:

> "the raw escape hatch `rawSql({ id, label, operationClass, target, precheck, execute, postcheck, ... })`"

그리고 pgvector 설치용 `installExtension` / `createExtension` 도 있다(`postgres-migration-...d.mts:233-238`, `references/migrations.md:368`). **pgvector 확장이 아직 DB 에 생성돼 있지 않으므로**(request.md) 이걸 쓰게 된다.

---

## 4. 3순위 — 계층 구조 지도

### 4.1 `backend/app/` (총 3,963줄, 테스트 제외)

```
main.py(58)
 └─ include_router → routers/reservations.py(205) · routers/admin_academies.py(146)
      ├─ deps.py(157)   → adapters/{payment_gateway,notification,slot_lock}.py
      ├─ db.py(58)      → config.py(52)
      ├─ schemas/{cancellation(225), academy(136)}.py
      └─ services/cancellation.py(1069)
           ├─ services/refund_policy.py(267) → services/fee_policy.py(66)
           ├─ models/*(407)
           └─ adapters/*(948)
```

| 파일 | 줄 | 역할 | 누가 부르나 | 무엇을 부르나 |
|---|---|---|---|---|
| **진입** |
| `main.py` | 58 | FastAPI 앱 조립. CORS(`localhost:3000` 만, 와일드카드 금지 — `:34-41`), `/health` | uvicorn | `routers.*` |
| **설정·DB** |
| `config.py` | 52 | pydantic-settings. `database_url` / `test_database_url` / `redis_url`. `@lru_cache get_settings()` (`:50-53`) | `db.py`, `alembic/env.py` | `.env` |
| `db.py` | 58 | Engine(`pool_pre_ping=True`) + `SessionLocal` + `get_db()` 제너레이터 의존성 | 라우터 `Depends(get_db)` | `config.get_settings()` |
| `deps.py` | 157 | 임시 인증 + 어댑터 3종 주입. `@lru_cache` 싱글턴 3개(§5.3) | 라우터 | `adapters.*` |
| **라우터** |
| `routers/reservations.py` | 205 | `GET /reservations/{id}/cancellation-preview`(`:100`), `POST /reservations/{id}/cancel`(`:137`). `CancellationError.status_code` 를 그대로 HTTP 로 옮긴다(`:79-81`) | mobile | `services.cancellation` |
| `routers/admin_academies.py` | 146 | `GET|PUT /admin/academies/{id}/refund-policy`(`:91,109`). PUT 은 **전체 교체**(PATCH 아님, `:119-131`) | admin-web | `models.Academy`, `schemas.academy` |
| **스키마(Pydantic)** |
| `schemas/cancellation.py` | 225 | `CancelRequest`(`extra="forbid"`, `:93`) · `CancelResponse`(`:126`) · `CancellationPreviewResponse`(`:173`) · `RefundAccountIn`(`:58`) | 라우터 | 서비스의 dataclass ↔ 변환 |
| `schemas/academy.py` | 136 | `RefundPolicyTier`(`:56`, bp 0~10000·시간 1~720) · `RefundPolicyUpdate`(`:75`, 정렬·중복 검증) · `RefundPolicyResponse`(`:127`) | 라우터 | — |
| **서비스** |
| `services/cancellation.py` | **1069** | 취소 오케스트레이션. §1 전체 | 라우터 | `refund_policy`, `models.*`, `adapters.*` |
| `services/refund_policy.py` | 267 | 환불액 산정(`calculate_refund`). 비율표 티어 해석 | `cancellation.py:706` | `fee_policy` |
| `services/fee_policy.py` | 66 | 수수료 정책 | `refund_policy` | — |
| **모델(SQLAlchemy 2)** |
| `models/base.py` | 42 | `DeclarativeBase` + `TimestampMixin`(`created_at`/`updated_at`, timezone-aware) | 전 모델 | — |
| `models/academy.py` | 48 | `academies` — `name`, `refund_policy_tiers`(JSONB) | 라우터, 서비스 | — |
| `models/class_schedule.py` | 61 | `class_schedules` — `starts_at`, `price_amount`, `capacity`, `reserved_count`. **종료 시각 컬럼 없음**(`cancellation.py:240-243` 이 이걸 근거로 판정을 하나로 묶는다) | 서비스 | — |
| `models/order.py` | 45 | `orders` — `user_id`, `status`, `total_amount` | 서비스 | — |
| `models/payment.py` | 52 | `payments` — `method`, `amount`, `paid_at`, `gateway_payment_key` | 서비스 | — |
| `models/reservation.py` | 63 | `reservations` — `order_id`, `class_schedule_id`, `user_id`, `status`, `cancelled_at` | 서비스 | — |
| `models/refund.py` | 130 | `refunds` — 멱등키·금액·상태·환불계좌·실패사유. 방어의 중심 | 서비스 | — |
| `models/refund_event.py` | 66 | `refund_events` — append-only 감사 로그(`payload` JSONB) | 서비스 | — |
| **어댑터(포트)** |
| `adapters/__init__.py` | 81 | Protocol·포트/어댑터 패턴 설명 | — | — |
| `adapters/payment_gateway.py` | 526 | `PaymentGateway` Protocol + `FakePaymentGateway` + **응답 파서(프로덕션 코드)** + `UnsupportedPaymentMethodError` | `deps.py`, 서비스 | — |
| `adapters/notification.py` | 155 | `NotificationSender` Protocol(`:78`) — `notify_member`(`:86`) / `notify_academy_admin`(`:95`) 둘로 나뉨. `NotificationEvent` StrEnum(`:51`) | `deps.py`, 서비스 | — |
| `adapters/slot_lock.py` | 186 | `SlotLock` Protocol(`:75`) + `RedisSlotLock`(`:91`) + `NullSlotLock`(`:171`). `release()` 하나뿐 | `deps.py`, 서비스 | redis |
| **마이그레이션** |
| `alembic/versions/0001_initial_domain.py` | 373 | 유일한 마이그레이션. 테이블 7개 + 인덱스 10개 + CHECK 11개 | alembic | — |
| `alembic/env.py` | 118 | alembic 설정 | alembic | `config.get_settings()` |

### 4.2 `admin-web/` 현재 구조 (825줄)

```
app/
  layout.tsx(25)          루트 레이아웃
  page.tsx(31)            대시보드 — /health 폴링
  globals.css(111)        순수 CSS (Tailwind 4 설치돼 있으나 아직 이 파일 기준)
  refund-policy/page.tsx(5)   → components/RefundPolicySettings
components/
  AdminNav.tsx(48)
  RefundPolicySettings.tsx(441)   환불 비율표 편집 화면 — 가장 큰 클라이언트 컴포넌트
lib/
  api-client.ts(164)      백엔드 호출 단일 창구
```

- `app/` 아래에 `api/` 라우트 핸들러가 **하나도 없다.** 서버 코드를 전부 새로 만든다.
- Prisma 관련 파일(`prisma.config.ts`, `src/prisma/contract.prisma`, `db.ts`, `migrations/`)도 **아직 없다** — `prisma orm init` 이 첫 작업이 된다.
- `tsconfig.json` 의 paths 는 `@/*` 하나뿐(`admin-web/tsconfig.json:28-32`). `moduleResolution: "bundler"`, `target: "ES2017"`.
- `package.json:47-51` 의 `overrides { "better-auth": { "prisma": "$prisma" } }` — 지우면 `npm install` 이 ERESOLVE 로 깨진다(request.md 제약 2).
- **`pg` 는 직접 의존성이 아니다.** `@prisma/orm-postgres` 의 전이 의존성으로 들어온다(`orm-postgres/package.json:21`). `@types/pg` 는 devDependencies 에 직접 있다(`package.json:37`).
- `eslint.config.mjs` — 건드리지 않는다(이미 깨진 검증선). 검증은 `npx next build`.

---

## 5. 4순위 — 경계면

### 5.1 mobile 이 부르는 엔드포인트 3개

출처: `/home/user/kdance/mobile/App.tsx` (범위 밖이지만 계약 확인용으로 읽음)

| # | 호출 | `App.tsx` | 헤더 |
|---|---|---|---|
| 1 | `GET /health` | `:105` | 없음 |
| 2 | `GET /reservations/{id}/cancellation-preview` | `:116-118` | `X-User-Id` |
| 3 | `POST /reservations/{id}/cancel` | `:175-183` | `X-User-Id`, `Idempotency-Key`(선택) |

베이스 URL: `process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000"` (`App.tsx:27`)

**요청·응답 형태 (필드명 전부 snake_case)**

`GET /health` →
```json
{ "status": "ok" }
```
(`backend/app/main.py:56-58`)

`GET /reservations/{reservation_id}/cancellation-preview` → `CancellationPreviewResponse`
(`backend/app/schemas/cancellation.py:192-205`)
```
reservation_id: uuid
payment_method: "virtual_account" | "card" | null
paid_amount: int
refund_amount: int
refund_rate_bp: int          # basis point, 10000 = 100%
hours_before_start: int
seconds_before_start: int
applied_tier_hours: int | null
starts_at: datetime (ISO8601)
cancellable: bool
reason_code: str | null      # CancellationError.code 와 같은 값
```
- `cancellable=false` 도 **200** 이다. 400대로 돌려주지 않는 이유는 `routers/reservations.py:111-116`.
- 예외는 404(없는 예약) / 403(타인 예약) 둘뿐.

`POST /reservations/{reservation_id}/cancel`
요청 본문(**선택** — 없어도 된다, `routers/reservations.py:158`) `CancelRequest` (`schemas/cancellation.py:93-108`, `extra="forbid"`):
```
method: "virtual_account" | "card" | null
refund_account: {
  bank_code: str(1~20)
  account_number: str(1~64)
  holder_name: str(1~100)
  holder_phone_number: str(≤20) | null
} | null
```
응답 `CancelResponse` (`schemas/cancellation.py:138-150`):
```
reservation_id: uuid
refund_id: uuid
status: "succeeded" | "pending" | "failed"
requested_amount: int
refunded_amount: int
refund_rate_bp: int
hours_before_start: int
reservation_status: str
slot_restored: bool
replayed: bool                  # 중복 요청이면 true
failure_code: str | null
failure_message: str | null
gateway_refund_id: str | null
```
**상태 코드 규칙이 특이하다 — 전환 시 그대로 지켜야 한다** (`routers/reservations.py:167-179`):
- 중복 요청 → **200** + `replayed=true` (409 아님)
- PG 환불 실패 → **200** + `status="failed"` (비-2xx 로 바꾸면 실패 사유가 클라이언트 에러 처리로 빨려 들어간다)
- 요청 자체가 성립 안 함(없는 예약 404 / 타인 403 / 이미 취소 409 / 이미 시작 409 / 카드 422) → 4xx

### 5.2 admin-web 이 부르는 엔드포인트 2개

`lib/api-client.ts:143-164` · 백엔드 `routers/admin_academies.py:91,109`

| 호출 | 경로 | 요청 | 응답 |
|---|---|---|---|
| `fetchRefundPolicy` | `GET /admin/academies/{academy_id}/refund-policy` | — | `RefundPolicyResponse` |
| `updateRefundPolicy` | `PUT /admin/academies/{academy_id}/refund-policy` | `{ "refund_policy_tiers": [...] }` | `RefundPolicyResponse` |

티어 원소 (`lib/api-client.ts:106-109`, `schemas/academy.py:68-70`):
```
{ hours_before_start: int (1~720), refund_rate_bp: int (0~10000) }
```

**응답 봉투가 느슨하다 — 전환 시 함정이다.** `extractTiers()` (`lib/api-client.ts:125-139`) 가 두 형태를 **모두** 받아들인다:
- 배열 그대로 `[...]`
- `{ refund_policy_tiers: [...] }` 로 감싼 것

주석(`api-client.ts:119-124`)이 이유를 적어 뒀다: 공유 계약이 티어 원소 형태만 고정하고 봉투는 고정하지 않았다. **새 Route Handler 는 봉투를 하나로 못박아야 한다** — 안 그러면 다음 사람이 어느 쪽이 맞는지 알 수 없다. 권장: `{ refund_policy_tiers: [...] }` (PUT 요청 본문과 대칭).

PUT 은 **전체 교체**다(`admin_academies.py:119-131`). 부분 갱신을 지원하지 않는 이유가 명시돼 있다 — 비율표는 행 하나가 아니라 표 전체가 하나의 정책이기 때문이다. 검증(정렬·중복·범위)이 항상 표 전체에 걸려야 한다.

### 5.3 R9(Pydantic 422 형태 변경) — `extractMessage()` 가 파싱하는 형태

`/home/user/kdance/admin-web/lib/api-client.ts:41-60`

```ts
function extractMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload) return payload;          // ① 평문
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string" && detail) return detail;             // ② {"detail": "..."}
  if (Array.isArray(detail)) {                                          // ③ {"detail":[{"msg":"..."}]}
    const messages = detail.map(item => item?.msg).filter(...);
    if (messages.length > 0) return messages.join(" / ");
  }
  return null;
}
```

**세 형태를 파싱한다:**

| 형태 | 누가 만드나 | 예시 |
|---|---|---|
| ② `{"detail": "문자열"}` | 앱이 직접 던지는 `HTTPException` | `routers/reservations.py:81` (`CancellationError.message`), `admin_academies.py:57`, `deps.py:81,92` |
| ③ `{"detail":[{"msg":..., "loc":..., "type":...}]}` | **Pydantic 검증 실패 시 FastAPI 가 자동 생성**하는 422 | `RefundPolicyUpdate` 검증 실패(`schemas/academy.py:90-104`), `CancelRequest` 의 `extra="forbid"` 위반 |
| ① 평문 | JSON 파싱 실패 시 fallback (`api-client.ts:33-39`) | — |

**전환 영향**: Next.js Route Handler 가 zod 로 검증하면 에러 형태가 완전히 달라진다. zod 4 의 `error.issues` 는 `[{ code, path, message }]` 로, `msg` 가 아니라 `message` 다. **`extractMessage()` 의 ③ 분기가 조용히 실패하고 화면에 에러가 안 뜬다.**

선택지는 둘이다:
- (A) Route Handler 가 `{"detail":[{"msg": issue.message, "loc": issue.path}]}` 형태로 zod 결과를 변환해 내보낸다 — `api-client.ts` 무수정
- (B) 새 에러 봉투를 정하고 `extractMessage()` 를 고친다 — 더 깨끗하지만 mobile 도 같이 봐야 한다(mobile 은 `App.tsx` 에서 직접 fetch 하므로 별도 처리)

**분석자 의견: (A)** — 전환 단계에서 검증선을 하나라도 줄이는 편이 낫다. 봉투 정리는 전환이 끝난 뒤 별도 작업으로.

### 5.4 R6(프로세스 싱글턴 서버리스 붕괴) — `deps.py` 의 `@lru_cache` 싱글턴 3개

`/home/user/kdance/backend/app/deps.py:105-126`

| 함수 | 반환 | 무엇을 들고 있나 | 서버리스에서 깨지는가 |
|---|---|---|---|
| `_payment_gateway()` (`:105`) | `FakePaymentGateway` | **인메모리 멱등 원장.** 주석(`:108-111`)이 명시: 요청마다 새로 만들면 재시도가 매번 "처음 호출"로 보인다 | **깨진다** |
| `_notification_sender()` (`:115`) | `FakeNotificationSender` | 발송 기록 리스트(`adapters/notification.py:114-116`) | 깨진다 (테스트 전용이라 영향 작음) |
| `_slot_lock()` (`:120`) | `RedisSlotLock` | **Redis 커넥션.** 지연 생성이라 Redis 가 꺼져 있어도 여기서 죽지 않는다(`:122`) | **부분적으로** — 상태는 Redis 에 있으므로 인스턴스가 늘어도 정합성은 유지된다. 커넥션 풀만 늘어난다 |

네 번째 `@lru_cache` 가 하나 더 있다: `config.get_settings()` (`config.py:50-53`). 이건 불변 설정이라 문제 없다.

**전환 판단**
- `_slot_lock` — 상태가 Redis 에 있으므로 **모듈 레벨 싱글턴으로 옮기면 그대로 된다.** Next.js 에서는 `db.ts` 와 같은 패턴(모듈 싱글턴)을 쓴다(`references/runtime.md:340`).
- `_payment_gateway` — **인메모리 원장이 서버리스에서 무의미해진다.** 다만 §1.4 에서 본 대로 멱등성의 실제 권위는 DB 제약이다. 따라서 치명적이지 않다. 문제는 **테스트**다 — Fake 원장에 의존하는 테스트가 환경에 따라 다르게 나온다. Phase 1 의 Q8 이 이걸 묻고 있다.
- `_notification_sender` — Fake 이므로 실 구현 전까지 문제 없다.

---

## 6. Phase 3(구현 계획)에 넘기는 것

### 6.1 반드시 실측으로 확인해야 하는 것 (타입만 보고 넘어가면 안 되는 것)

| # | 확인할 것 | 왜 | 어떻게 |
|---|---|---|---|
| V1 | `tx.query(db.raw.sql\`...FOR UPDATE\`.build())` 의 잠금이 **그 트랜잭션에 걸리는가** | 여기서 틀리면 멱등성 방어가 통째로 무너진다 | 동시 요청 2건 통합 테스트. 하나가 대기하는지 확인 |
| V2 | 코덱 id 실제 표기(`pg/uuid@1` 등) | `returnsRow()` 가 코덱 id 를 손으로 요구한다. 지금은 추정이다 | `prisma contract emit` 후 `contract.d.ts` 를 읽는다 |
| V3 | `ON CONFLICT` 의 conflict target 으로 **부분 인덱스**를 지정할 수 있는가 | SAVEPOINT 대체안(§2.3 B) | raw SQL 로 `ON CONFLICT (reservation_id) WHERE status <> 'failed' DO NOTHING` 실행 |
| V4 | Node 24 에서 `Timestamptz` 컬럼 읽기 | `RUNTIME.TEMPORAL_UNAVAILABLE` 로 죽을 수 있다 | 스캐폴딩 직후 첫 arc 에서 timestamptz 컬럼 1개로 왕복 |
| V5 | `@internal/postgres` façade 가 `prisma orm init` 으로 실제로 설치되는가 | 지금 `node_modules` 에 없다 | init 실행 후 확인 |

### 6.2 설계 결정이 필요한 것

| # | 결정 사항 | 선택지 | 분석자 의견 |
|---|---|---|---|
| D1 | 취소 트랜잭션의 커밋 지점 3개(§1.1 C1/C2/C3)를 어떻게 옮기나 | 콜백 안에서 throw 하면 무조건 롤백 → C1(미지원 결제수단 실패 기록) 이 사라진다 | 트랜잭션을 정상 반환으로 닫고 **바깥에서** 422 를 던진다 |
| D2 | SAVEPOINT 대체 | A(선제 조회) / B(`ON CONFLICT`) / C(재시도) — §2.3 | **B**. A 는 방어가 3겹→2겹으로 준다 |
| D3 | 에러 봉투 | (A) FastAPI 형태 유지 / (B) 새 봉투 — §5.3 | **A**. 전환 중 검증선을 늘리지 않는다 |
| D4 | 환불 비율표 응답 봉투 | 배열 / `{refund_policy_tiers:[...]}` — §5.2 | `{refund_policy_tiers:[...]}` 로 못박는다 |
| D5 | 인덱스 이름 표기 | `name:`(wire) / `map:`(exact) — §3.3 | **`name:`**. DB 가 비어 있고 경고가 없다 |
| D6 | Route Handler 런타임 | Node / Edge — §2.3(3) | **취소·환불 경로는 Node 못박기.** Edge 에는 `transaction()` 이 없다 |
| D7 | Temporal 처리 | polyfill / `TimestamptzString` — §2.6 | Phase 3 이 V4 결과를 보고 정한다 |
| D8 | `db.ts` import 경로 | `@internal/postgres/runtime` / `@prisma/orm-postgres/runtime` — §2.1 | `orm init` 을 돌린 뒤 façade 쪽으로. 문서 예제와 일치시킨다 |

### 6.3 새로 올리는 미해결 질문

**Q-new-1. Node 24 의 `Temporal` 부재를 어떻게 처리하나?**
Prisma 8 의 Postgres 타깃은 `Timestamptz` 를 `Temporal.Instant` 로 읽고 쓴다. `globalThis.Temporal` 은 Node 26.8.2 이상에만 있고 **우리는 Node 24.21.0** 이다. 이 프로젝트의 도메인 모델은 timestamptz 가 핵심이다(`starts_at` · `paid_at` · `cancelled_at` · `created_at`/`updated_at`). 근거: `references/contract.md:119`.
- A안: `temporal-polyfill` 의존성 추가 + `import 'temporal-polyfill/full/global'` 을 첫 쿼리 전에 로드
- B안: 컬럼을 `TimestamptzString(p)` 로 작성 — Postgres 텍스트를 그대로 받아 JS 에서 파싱
- C안: Node 를 26.8.2+ 로 올린다 — **버전 정책상 Vercel 지원 런타임과 Expo/RN 쪽 영향을 먼저 봐야 한다**

**Q-new-2. Vercel 배포 시 Route Handler 를 Node 런타임으로 고정하는 것에 동의하는가?**
`postgresServerless()` 는 `transaction()` 을 의도적으로 뺐다(`serverless.d.mts:38-43`). 취소·환불은 트랜잭션 없이 불가능하다. Edge 의 콜드스타트 이점을 포기하는 결정이다.

### 6.4 기존 SCH-01~07 의 처리

request.md 가 Phase 3 에 판단을 맡긴 사항이다. 조사 결과 기준으로 사실만 적는다:
- SCH-01~07 은 전부 `backend/` FastAPI 코드를 설명한다. 전환되면 설명 대상이 사라진다.
- 다만 **설계 판단은 그대로 유효하다** — 커밋 전/후 분리, 멱등성 3겹, PG 실패 시 좌석 유지, `pending` 은 실패가 아니라는 판정. 이건 프레임워크와 무관하다.
- 사라지는 것은 구현 세부(SQLAlchemy `begin_nested`, `Depends()`, Alembic op)뿐이다.
- 직전 회차 산출물은 `_workspace_20260920_183143/` 에 보관돼 있다.

---

## 7. 읽지 않은 것 / 확인하지 못한 것

정직하게 남긴다.

- `backend/app/services/refund_policy.py`(267) · `fee_policy.py`(66) — **본문을 읽지 않았다.** 트랜잭션 경계와 무관한 순수 산정 로직이라 이번 우선순위에서 뺐다. Phase 3 이 이관할 때 읽어야 한다.
- `backend/app/adapters/payment_gateway.py`(526) — Protocol 이름과 예외 타입만 확인했고 **응답 파서 본문은 읽지 않았다.** "프로덕션 코드"라고 `deps.py:141` 이 적어 둔 부분이라 이관 시 비중이 크다.
- `backend/tests/*`(2,470줄, 159개) — **전혀 읽지 않았다.** TS 재작성 범위 산정에 필요하다.
- `admin-web/components/RefundPolicySettings.tsx`(441) — 줄 수만 확인했다.
- **Prisma 8 을 실제로 실행해 보지 않았다.** 이 문서의 Prisma 관련 결론은 전부 설치본의 타입 정의·런타임 소스·동봉 문서에서 읽은 것이다. §6.1 의 V1~V5 가 실행 검증 목록이다.
- `db.raw` 로 만든 플랜이 `tx` 에서 실행될 때 잠금이 그 트랜잭션에 걸리는지 — **타입 호환성과 문서 서술까지만 확인했다.** 실행으로 확인하지 않았다.
- `mcp__postgres-kdance` 로 DB 를 조회하지 않았다 — request.md 가 이미 "테이블 0개, vector 확장 미생성"으로 실측해 두었고 이 조사에서 더 알아낼 것이 없었다.
