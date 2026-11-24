// T-M1-1(R2 스파이크) — R2(Prisma 8 트랜잭션·행 잠금 미검증)를 실측한다.
// 실측 항목은 research §3 의 S-1~S-6(R-01·R-02·R-03·R-07·R-08·R-09).
//
// 스파이크 판정(T-M1-2)은 끝났다. 이제 이 파일은 「회귀 테스트」다 — 단언은 plan D3 가
// 확정한 동작이고, 어느 S 가 실패해도 그것은 Prisma 8·DB 동작이 바뀌었다는 회귀다.
// 측정값(시각·영향 행 수·오류 원문)은 평소에는 찍지 않는다.
// 판정을 다시 해야 할 때만 `SPIKE_REPORT=1` 로 돌리면 맨 끝 afterAll 이 표로 찍는다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 측정 덤프는 환경 변수가 있을 때만 찍는다(평소 테스트 출력을 깨끗하게 둔다).
const SPIKE_REPORT = process.env.SPIKE_REPORT === "1";
const results: Record<string, Record<string, unknown>> = {};
const record = (id: string, data: Record<string, unknown>) => {
  results[id] = { ...(results[id] ?? {}), ...data };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

describe.skipIf(!dbAvailable())("R2 스파이크 — Prisma 8 트랜잭션·잠금", () => {
  let handle: TestDb;
  // 자리 묶음이 매달릴 신청 단위(전체 데이터 계약부터 seat_pools.offering_id 가 필수다)
  let offeringId: string;

  beforeAll(() => {
    handle = openTestDb();
  });

  afterAll(async () => {
    await closeTestDb(handle);
    // 보고서에 옮길 측정값 표 — SPIKE_REPORT=1 일 때만
    if (SPIKE_REPORT) process.stdout.write("\n[R2 스파이크 측정값]\n" + JSON.stringify(results, null, 2) + "\n"); // afterAll 안의 console 은 vitest 가 버려서 stdout 에 직접 쓴다
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    offeringId = (await insertOffering(handle.pool)).offeringId;
  });

  // 자리 묶음 1행을 ORM 으로 만든다(공유 계약 §4.7(자리 묶음 카운터)).
  async function createPool(capacity: number, held = 0, confirmed = 0) {
    const id = randomUUID();
    await handle.db.orm.public.SeatPool.create({
      id,
      offering_id: offeringId,
      seat_kind: "male",
      capacity,
      held_count: held,
      confirmed_count: confirmed,
      updated_at: Temporal.Now.instant(),
    });
    return id;
  }

  async function readPool(id: string) {
    const { rows } = await handle.pool.query<{ held_count: number; confirmed_count: number; seat_kind: string }>(
      "SELECT held_count, confirmed_count, seat_kind FROM seat_pools WHERE id = $1",
      [id],
    );
    return rows[0];
  }

  // ── S-1(R-01): 콜백에서 throw 하면 ORM·SQL 빌더·raw 쓰기가 모두 롤백되는가 ──
  test("S-1 트랜잭션 콜백 throw → ORM INSERT + 빌더 UPDATE + raw UPDATE 모두 롤백", async () => {
    const existing = await createPool(10);
    const insertedInTx = randomUUID();

    const thrown = await handle.db
      .transaction(async (tx) => {
        // ① ORM 레인 INSERT
        await tx.orm.public.SeatPool.create({
          id: insertedInTx,
          offering_id: offeringId,
          seat_kind: "female",
          capacity: 5,
          updated_at: Temporal.Now.instant(),
        });
        // ② SQL 빌더 레인 UPDATE
        const builderResult = await tx.execute(
          tx.sql.public.seat_pools
            .update({ seat_kind: "any" })
            .where((f, fns) => fns.eq(f.id, existing))
            .build(),
        );
        // ③ raw 레인 UPDATE
        const rawResult = await tx.execute(
          tx.raw.sql`UPDATE seat_pools SET held_count = held_count + 3 WHERE id = ${existing}`.affectedCount().build(),
        );
        record("S-1", {
          builderAffectedRows: builderResult.affectedRows,
          rawAffectedRows: rawResult.affectedRows,
        });
        throw new Error("의도한 실패 — 롤백 확인용");
      })
      .then(() => null)
      .catch((e: unknown) => e);

    const after = await readPool(existing);
    const insertedCount = (
      await handle.pool.query("SELECT count(*)::int AS n FROM seat_pools WHERE id = $1", [insertedInTx])
    ).rows[0].n as number;
    record("S-1", {
      thrown: errorText(thrown),
      ormInsertSurvived: insertedCount,
      builderUpdateSurvived: after?.seat_kind !== "male",
      rawUpdateSurvived: after?.held_count !== 0,
    });

    expect(errorText(thrown)).toContain("의도한 실패");
    expect(insertedCount).toBe(0);
    expect(after).toEqual({ held_count: 0, confirmed_count: 0, seat_kind: "male" });
  });

  // ── S-2(R-02): tx 안 raw 레인이 같은 연결을 쓰고 FOR UPDATE 가 실제로 잠그는가 ──
  test("S-2 tx 안 raw FOR UPDATE 가 다른 연결의 UPDATE 를 커밋 전까지 막는다", async () => {
    const id = await createPool(10);
    const HOLD_MS = 800;
    const t0 = performance.now();
    let lockedAt = 0;
    let txCallbackEndAt = 0;
    let txResolvedAt = 0;
    let otherDoneAt = 0;
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const connInfo = (tx: Parameters<Parameters<TestDb["db"]["transaction"]>[0]>[0]) =>
      tx.query(
        tx.raw.sql`SELECT pg_backend_pid() AS pid, txid_current()::text AS xid`
          .returnsRow({ pid: "pg/int4@1", xid: "pg/text@1" })
          .build(),
      );

    const txA = handle.db.transaction(async (tx) => {
      const [before] = await connInfo(tx);
      const lockedRows = await tx.query(
        tx.raw.sql`SELECT id FROM seat_pools WHERE id = ${id} FOR UPDATE`.returnsRow({ id: "pg/uuid@1" }).build(),
      );
      lockedAt = performance.now() - t0;
      const [afterLock] = await connInfo(tx);
      record("S-2", { lockedRows: lockedRows.length, before, afterLock });
      signalLocked();
      await sleep(HOLD_MS);
      txCallbackEndAt = performance.now() - t0;
    });

    // 연결 B: tx 밖(풀의 다른 연결)에서 같은 행을 UPDATE — A 가 커밋할 때까지 기다려야 한다.
    await locked;
    const [otherPidRow] = await handle.db.query(
      handle.db.raw.sql`SELECT pg_backend_pid() AS pid`.returnsRow({ pid: "pg/int4@1" }).build(),
    );
    const other = handle.db
      .execute(handle.db.raw.sql`UPDATE seat_pools SET held_count = held_count + 1 WHERE id = ${id}`.affectedCount().build())
      .then((r) => {
        otherDoneAt = performance.now() - t0;
        return r.affectedRows;
      });

    await txA;
    txResolvedAt = performance.now() - t0;
    const otherAffected = await other;

    const before = results["S-2"]?.["before"] as { pid: number; xid: string } | undefined;
    const afterLock = results["S-2"]?.["afterLock"] as { pid: number; xid: string } | undefined;
    record("S-2", {
      otherPid: otherPidRow?.pid,
      lockedAtMs: Math.round(lockedAt),
      txCallbackEndAtMs: Math.round(txCallbackEndAt),
      txResolvedAtMs: Math.round(txResolvedAt),
      otherDoneAtMs: Math.round(otherDoneAt),
      otherWaitedMs: Math.round(otherDoneAt - lockedAt),
      otherAffected,
    });

    // 같은 연결·같은 트랜잭션인가
    expect(before?.pid).toBe(afterLock?.pid);
    expect(before?.xid).toBe(afterLock?.xid);
    // B 는 A 의 콜백이 끝난(=커밋 직전) 뒤에야 끝나야 한다
    expect(otherDoneAt).toBeGreaterThanOrEqual(txCallbackEndAt);
    expect(otherAffected).toBe(1);
  });

  // ── S-3(R-03): 남은 자리 1개에 조건부 UPDATE 20건이 동시에 오면 1건만 성공하는가 ──
  test("S-3 남은 자리 1개 · 조건부 UPDATE 동시 20건 → 성공 1, 나머지 0행(오류 없음)", async () => {
    const id = await createPool(1);
    const CONCURRENCY = 20;
    // T-M1-2 보강: 기본 풀(연결 10개)로는 20건 중 최대 10건만 DB 에서 겹친다.
    // 연결을 동시 건수보다 많이 연 풀을 따로 써서 20건이 실제로 한꺼번에 부딪치게 한다.
    const wide = openTestDb({ poolMax: CONCURRENCY + 5 });

    // data-model §4-4 「자리 잡기」 한 문장. 빌더의 기본 함수(fns)에 덧셈이 없어 raw 레인으로 쓴다.
    const attempts = Array.from({ length: CONCURRENCY }, () =>
      wide.db.transaction(async (tx) => {
        const r = await tx.execute(
          tx.raw.sql`UPDATE seat_pools SET held_count = held_count + 1
                     WHERE id = ${id} AND held_count + confirmed_count < capacity`
            .affectedCount()
            .build(),
        );
        return r.affectedRows;
      }),
    );
    // allSettled: 한 건이 예외를 던져도 나머지 결과를 모두 모아 「오류 없음」을 단언한다.
    const settled = await Promise.allSettled(attempts);
    const outcomes = settled.map((o) =>
      o.status === "fulfilled"
        ? { affected: o.value, error: null as string | null }
        : { affected: -1, error: errorText(o.reason) },
    );
    const connectionsUsed = wide.pool.totalCount; // 실제로 열린 연결 수 — 20 이상이면 20건이 동시에 겹쳤다
    await closeTestDb(wide);
    const after = await readPool(id);

    const succeeded = outcomes.filter((o) => o.affected === 1).length;
    const zeroRows = outcomes.filter((o) => o.affected === 0).length;
    const errors = outcomes.filter((o) => o.error !== null).map((o) => o.error);
    record("S-3", { concurrency: CONCURRENCY, connectionsUsed, succeeded, zeroRows, errors, finalHeld: after?.held_count });

    expect(succeeded).toBe(1);
    expect(zeroRows).toBe(CONCURRENCY - 1);
    expect(errors).toEqual([]);
    expect(after?.held_count).toBe(1);
  });

  // ── S-4(R-07): 부분 유니크 충돌 INSERT 가 예외 없이 0행으로 돌아오는가 ──
  test("S-4 ON CONFLICT DO NOTHING RETURNING — 부분 유니크 충돌은 0행, tx 는 계속 쓸 수 있다", async () => {
    const { reservationId, paymentId } = await insertReservationAndPayment(handle.pool);
    await handle.db.orm.public.Refund.create({
      id: randomUUID(),
      reservation_id: reservationId,
      payment_id: paymentId,
      idempotency_key: `idem-${randomUUID()}`,
      requested_amount: 10_000,
      refund_rate_bp: 10_000,
      status: "pending",
      reason: "member_request",
      updated_at: Temporal.Now.instant(),
    });

    const outcome = await handle.db
      .transaction(async (tx) => {
        const conflictRows = await tx.query(
          tx.raw.sql`INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount,
                                          refund_rate_bp, status, reason, updated_at)
                     VALUES (${randomUUID()}, ${reservationId}, ${paymentId}, ${`idem-${randomUUID()}`}, 10000,
                             10000, 'pending', 'member_request', now())
                     ON CONFLICT DO NOTHING RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        // 충돌 뒤에도 같은 tx 가 살아 있는지(오류였다면 tx 가 aborted 상태가 된다)
        const [alive] = await tx.query(tx.raw.sql`SELECT 1 AS ok`.returnsRow({ ok: "pg/int4@1" }).build());
        // 실패(failed) 상태는 부분 유니크 밖이라 들어가야 한다 — 인덱스가 정말 「부분」인지 확인
        const failedRows = await tx.query(
          tx.raw.sql`INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount,
                                          refund_rate_bp, status, reason, updated_at)
                     VALUES (${randomUUID()}, ${reservationId}, ${paymentId}, ${`idem-${randomUUID()}`}, 10000,
                             10000, 'failed', 'member_request', now())
                     ON CONFLICT DO NOTHING RETURNING id`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        return { conflictRows: conflictRows.length, alive: alive?.ok, failedRows: failedRows.length, error: null };
      })
      .catch((e: unknown) => ({ conflictRows: -1, alive: -1, failedRows: -1, error: errorText(e) }));

    const total = (await handle.pool.query("SELECT count(*)::int AS n FROM refunds")).rows[0].n as number;
    record("S-4", { ...outcome, totalRefundRows: total });

    expect(outcome.error).toBeNull();
    expect(outcome.conflictRows).toBe(0);
    expect(outcome.alive).toBe(1);
    expect(outcome.failedRows).toBe(1);
    expect(total).toBe(2);
  });

  // ── S-5(R-08): tx 첫 문장으로 SET TRANSACTION ISOLATION LEVEL 이 먹는가 (정보용) ──
  test("S-5 tx 첫 문장 raw SET TRANSACTION ISOLATION LEVEL → SHOW transaction_isolation", async () => {
    const rawWay = await handle.db
      .transaction(async (tx) => {
        await tx.execute(tx.raw.sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`.affectedCount().build());
        const [row] = await tx.query(
          tx.raw.sql`SHOW transaction_isolation`.returnsRow({ transaction_isolation: "pg/text@1" }).build(),
        );
        return { level: row?.transaction_isolation, error: null as string | null };
      })
      .catch((e: unknown) => ({ level: null, error: errorText(e) }));

    // 참고: rc.24 타입에는 db.transaction(fn, { isolationLevel }) 옵션이 있다(research 작성 당시 미확인).
    const optionWay = await handle.db
      .transaction(
        async (tx) => {
          const [row] = await tx.query(
            tx.raw.sql`SHOW transaction_isolation`.returnsRow({ transaction_isolation: "pg/text@1" }).build(),
          );
          return { level: row?.transaction_isolation, error: null as string | null };
        },
        { isolationLevel: "Serializable" },
      )
      .catch((e: unknown) => ({ level: null, error: errorText(e) }));

    const [defaultRow] = await handle.db.transaction((tx) =>
      tx.query(tx.raw.sql`SHOW transaction_isolation`.returnsRow({ transaction_isolation: "pg/text@1" }).build()),
    );
    record("S-5", { rawWay, optionWay, defaultLevel: defaultRow?.transaction_isolation });

    expect(rawWay.error).toBeNull();
    expect(rawWay.level).toBe("serializable");
  });

  // ── S-6(R-09): Prisma 가 돌려주는 Temporal.Instant 가 polyfill 클래스와 같은가 ──
  test("S-6 timestamptz 왕복 — Temporal.Instant 로 읽히고 compare 가 0", async () => {
    // timestamptz(3) 이라 밀리초까지만 저장된다 → 쓰는 값도 밀리초로 맞춘다.
    const written = Temporal.Now.instant().round({ smallestUnit: "millisecond", roundingMode: "floor" });
    const id = randomUUID();
    await handle.db.orm.public.SeatPool.create({
      id,
      offering_id: offeringId,
      seat_kind: "any",
      capacity: 3,
      updated_at: written,
    });
    const row = await handle.db.orm.public.SeatPool.where({ id }).first();

    const readBack = row?.updated_at;
    const createdAt = row?.created_at;
    const isInstant = readBack instanceof Temporal.Instant;
    const sameClass = readBack?.constructor === Temporal.Instant;
    const cmp = readBack ? Temporal.Instant.compare(readBack, written) : null;
    record("S-6", {
      written: written.toString(),
      readBack: String(readBack),
      createdAt: String(createdAt),
      isInstant,
      sameClass,
      createdAtIsInstant: createdAt instanceof Temporal.Instant,
      compare: cmp,
    });

    expect(isInstant).toBe(true);
    expect(cmp).toBe(0);
    expect(createdAt instanceof Temporal.Instant).toBe(true);
  });
});
