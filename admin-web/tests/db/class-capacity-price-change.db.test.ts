// S2-3.3(정원·가격 변경 규칙) — 공개된 수업의 정원은 이미 잡힌 자리 밑으로 못 줄이고, 금액을 바꿔도 이미 만든 주문 금액은 그대로다.
//   계약: _workspace/03_contracts/11-instructor.md §5 「규칙(O-05, 수용 ③④)」 · §13 Given/When/Then 9
//   verify 의 이름은 tests/db/s2-3-3.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//   결제 회원이 생기기 전(M3 전)이라 자리 숫자와 주문은 픽스처로 직접 넣는다 — M3 끝에 실제 주문으로 다시 돈다(계약 §13-9).
//
// 확인하는 것:
//   ① 확정 남 9 · 여 10 수업의 남 정원을 8로 줄이면 거부 — 요청 때 422, 승인 때 409, 둘 다 CAPACITY_BELOW_RESERVED + minimum{남 9, 여 10}.
//      거부되면 정원도 금액도 그대로다. 결제 대기(held)도 잡힌 자리로 센다. 9로 줄이는 것은 된다
//   ② 금액을 300,000 → 320,000 으로 바꿔도 이미 만든 주문(결제 완료·결제 대기)의 금액·내역은 한 글자도 안 바뀐다. 판매 단위만 새 금액
//   ③ DB 마지막 방어선 — 앱을 거치지 않고 정원을 하한 밑으로 UPDATE 하면 ck_seat_pools_not_over 가 막는다
//   ④ 모양 오류는 422 VALIDATION_FAILED — 성별 정원 수업에 단일(any) 칸 · 0명 · 무료↔유료 전환 · 빈 변경. 아무것도 쓰지 않는다
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { HttpError } from "@/lib/server/http";
import {
  applyCapacityPriceChange,
  checkCapacityPriceChange,
  type CapacityPriceChanges,
} from "@/lib/server/services/class-capacity-price";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

const PRICE = 300000;

describe.skipIf(!dbAvailable())("정원·가격 변경 규칙(계약 11 §5, S2-3.3)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  /** 공개 수업 하나 — 판매 단위 1개 + 자리 묶음(성별 두 칸 또는 단일 한 칸)을 지정한 숫자로 만든다 */
  async function insertClass(
    pools: { kind: "male" | "female" | "any"; capacity: number; held: number; confirmed: number }[],
    price = PRICE,
  ): Promise<{ classId: string; offeringId: string; academyId: string }> {
    const academyId = randomUUID();
    const classId = randomUUID();
    const offeringId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '정원 시험 학원', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    const seatMode = pools.some((p) => p.kind === "any") ? "single" : "gender_split";
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at, updated_at)
       VALUES ($1, $2, '쌈바(입문)', '강사', 'dance_sport', 'regular', $3, 'published', now(), now())`,
      [classId, academyId, seatMode],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                    last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '12월', 'term', $3, now() + interval '10 days', now() + interval '40 days', 'open', now())`,
      [offeringId, classId, price],
    );
    // 주문 스냅샷의 회차 수(ck_orders_session_count ≥ 1, S3-3.2)를 채우려면 예정 회차가 하나는 있어야 한다
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       VALUES (uuidv7(), $1, 1, now() + interval '10 days', now() + interval '10 days 2 hours')`,
      [offeringId],
    );
    for (const p of pools) {
      await q(
        `INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, held_count, confirmed_count, updated_at)
         VALUES (uuidv7(), $1, $2, $3, $4, $5, now())`,
        [offeringId, p.kind, p.capacity, p.held, p.confirmed],
      );
    }
    return { classId, offeringId, academyId };
  }

  /** 픽스처 주문 하나 — 결제 시점 금액과 내역을 굳혀 둔다(FR-284) */
  async function insertOrder(academyId: string, offeringId: string, status: "paid" | "pending", amount: number, fee = 0) {
    const { memberId } = await insertMember(handle.pool);
    const noticeId = randomUUID();
    await q("INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES ($1, $2, $3, '공지')", [
      noticeId,
      academyId,
      Math.floor(Math.random() * 1_000_000) + 1,
    ]);
    const orderId = randomUUID();
    const breakdown = JSON.stringify({ listPrice: amount, bookingFee: fee, total: amount + fee });
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, booking_fee_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, $5::int, $6::int, $5::int + $6::int, $7::jsonb, $8, 'v1', 'v1', 'v1', 0, 5000, $9,
               CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, status, amount, fee, breakdown, noticeId, `idem-${orderId}`],
    );
    return orderId;
  }

  async function readPools(offeringId: string) {
    const { rows } = await q(
      "SELECT seat_kind, capacity, held_count, confirmed_count FROM seat_pools WHERE offering_id = $1 ORDER BY seat_kind",
      [offeringId],
    );
    return rows as { seat_kind: string; capacity: number; held_count: number; confirmed_count: number }[];
  }

  async function readPrice(offeringId: string): Promise<number> {
    const { rows } = await q("SELECT price_amount FROM class_offerings WHERE id = $1", [offeringId]);
    return (rows[0] as { price_amount: number }).price_amount;
  }

  /** 승인 때 쓰기 — 실제 승인 경로처럼 트랜잭션 하나 안에서 부른다 */
  const approve = (classId: string, changes: CapacityPriceChanges) =>
    handle.db.transaction(async (tx) => applyCapacityPriceChange(tx, classId, changes));

  /** HttpError 를 잡아 상태·코드·본문 덧붙임을 꺼낸다 */
  async function caught(run: () => Promise<unknown>): Promise<{ status: number; code: string; extra: Record<string, unknown> }> {
    try {
      await run();
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status, code: error.code, extra: { ...error.extra } };
      throw error;
    }
    throw new Error("거부되어야 하는데 통과했다");
  }

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });

  test("① 확정 남 9 · 여 10 수업의 남 정원을 8로 줄이면 거부된다(요청 422 · 승인 409), 9 는 된다", async () => {
    const { classId, offeringId } = await insertClass([
      { kind: "male", capacity: 10, held: 0, confirmed: 9 },
      { kind: "female", capacity: 10, held: 0, confirmed: 10 },
    ]);
    const before = await readPools(offeringId);

    // 요청 때 — 잠그지 않고 판정만, 422
    const atRequest = await caught(() => checkCapacityPriceChange(handle.db, classId, { capacity: { male: 8, female: 10 } }));
    expect(atRequest).toEqual({ status: 422, code: "CAPACITY_BELOW_RESERVED", extra: { minimum: { male: 9, female: 10 } } });

    // 승인 때 — 한 번 더 판정, 409. 금액을 같이 바꾸려 했어도 아무것도 쓰지 않는다(한 트랜잭션)
    const atApprove = await caught(() => approve(classId, { capacity: { male: 8 }, priceAmount: 320000 }));
    expect(atApprove).toEqual({ status: 409, code: "CAPACITY_BELOW_RESERVED", extra: { minimum: { male: 9, female: 10 } } });
    expect(await readPools(offeringId)).toEqual(before);
    expect(await readPrice(offeringId)).toBe(PRICE);

    // 하한 그대로(남 9)는 통과하고 정원이 바뀐다
    const snapshot = await checkCapacityPriceChange(handle.db, classId, { capacity: { male: 9 } });
    expect(snapshot).toEqual({ priceAmount: PRICE, capacity: { male: 10, female: 10 } });
    const done = await approve(classId, { capacity: { male: 9 } });
    expect(done.after.capacity).toEqual({ male: 9, female: 10 });
    expect((await readPools(offeringId)).map((p) => [p.seat_kind, p.capacity])).toEqual([
      ["female", 10],
      ["male", 9],
    ]);

    // 늘리기는 언제든 된다
    await approve(classId, { capacity: { male: 12, female: 12 } });
    expect((await readPools(offeringId)).map((p) => p.capacity)).toEqual([12, 12]);
  });

  test("① 결제 대기(held)도 잡힌 자리다 — 단일 정원 held 1 + confirmed 8 이면 8 로 못 줄인다", async () => {
    const { classId, offeringId } = await insertClass([{ kind: "any", capacity: 12, held: 1, confirmed: 8 }]);
    const r = await caught(() => approve(classId, { capacity: { any: 8 } }));
    expect(r).toEqual({ status: 409, code: "CAPACITY_BELOW_RESERVED", extra: { minimum: { any: 9 } } });
    expect((await readPools(offeringId))[0]?.capacity).toBe(12);
    await approve(classId, { capacity: { any: 9 } });
    expect((await readPools(offeringId))[0]?.capacity).toBe(9);
  });

  test("② 금액을 바꿔도 이미 만든 주문(결제 완료·결제 대기)의 금액·내역은 그대로, 판매 단위만 새 금액", async () => {
    const { classId, offeringId, academyId } = await insertClass([
      { kind: "male", capacity: 10, held: 1, confirmed: 1 },
      { kind: "female", capacity: 10, held: 0, confirmed: 0 },
    ]);
    const paidOrder = await insertOrder(academyId, offeringId, "paid", PRICE, 2000);
    const pendingOrder = await insertOrder(academyId, offeringId, "pending", PRICE);
    const ordersBefore = await q(
      `SELECT id, status, list_price_amount, booking_fee_amount, total_amount, price_breakdown::text AS breakdown, updated_at
       FROM orders ORDER BY id`,
    );

    const result = await approve(classId, { priceAmount: 320000 });
    expect(result).toEqual({
      before: { priceAmount: PRICE, capacity: { male: 10, female: 10 } },
      after: { priceAmount: 320000, capacity: { male: 10, female: 10 } },
    });
    expect(await readPrice(offeringId)).toBe(320000);

    // 주문 행은 칸 하나, 갱신 시각까지 그대로다(수정 경로가 orders 를 쓰지 않는다)
    const ordersAfter = await q(
      `SELECT id, status, list_price_amount, booking_fee_amount, total_amount, price_breakdown::text AS breakdown, updated_at
       FROM orders ORDER BY id`,
    );
    expect(ordersAfter.rows).toEqual(ordersBefore.rows);
    const totals = await q("SELECT id, total_amount FROM orders WHERE id = ANY($1::uuid[]) ORDER BY id", [[paidOrder, pendingOrder]]);
    expect(totals.rows.map((r) => (r as { total_amount: number }).total_amount).sort()).toEqual([302000, PRICE].sort());

    // 금액을 내려도 마찬가지
    await approve(classId, { priceAmount: 250000 });
    expect(await readPrice(offeringId)).toBe(250000);
    expect((await q(`SELECT id, status, list_price_amount, booking_fee_amount, total_amount, price_breakdown::text AS breakdown, updated_at FROM orders ORDER BY id`)).rows).toEqual(
      ordersBefore.rows,
    );
  });

  test("③ DB 마지막 방어선 — 앱을 거치지 않은 정원 UPDATE 도 ck_seat_pools_not_over 가 막는다", async () => {
    const { offeringId } = await insertClass([{ kind: "male", capacity: 10, held: 0, confirmed: 9 }]);
    await expect(q("UPDATE seat_pools SET capacity = 8 WHERE offering_id = $1", [offeringId])).rejects.toMatchObject({
      // 마이그레이션 도구가 제약 이름 끝에 해시를 붙인다(ck_seat_pools_not_over_xxxxxxxx)
      constraint: expect.stringMatching(/^ck_seat_pools_not_over/),
    });
    expect((await readPools(offeringId))[0]?.capacity).toBe(10);
  });

  test("④ 모양 오류는 422 VALIDATION_FAILED, 아무것도 쓰지 않는다", async () => {
    const { classId, offeringId } = await insertClass([
      { kind: "male", capacity: 10, held: 0, confirmed: 2 },
      { kind: "female", capacity: 10, held: 0, confirmed: 0 },
    ]);
    const cases: [CapacityPriceChanges, string][] = [
      [{ capacity: { any: 20 } }, "capacity.any"], // 성별 정원 수업에 단일 칸
      [{ capacity: { female: 0 } }, "capacity.female"], // 0명 묶음
      [{ capacity: { male: 2.5 } }, "capacity.male"],
      [{ priceAmount: 0 }, "priceAmount"], // 유료 → 무료
      [{ priceAmount: -1 }, "priceAmount"],
      [{}, "changes"],
    ];
    for (const [changes, path] of cases) {
      const r = await caught(() => approve(classId, changes));
      expect(r.status).toBe(422);
      expect(r.code).toBe("VALIDATION_FAILED");
      expect((r.extra.fields as { path: string }[]).map((f) => f.path)).toContain(path);
    }
    // 무료 수업을 유료로 바꾸는 것도 거부
    const free = await insertClass([{ kind: "any", capacity: 10, held: 0, confirmed: 0 }], 0);
    const r = await caught(() => checkCapacityPriceChange(handle.db, free.classId, { priceAmount: 10000 }));
    expect(r.code).toBe("VALIDATION_FAILED");

    expect((await readPools(offeringId)).map((p) => p.capacity)).toEqual([10, 10]);
    expect(await readPrice(offeringId)).toBe(PRICE);
    // 없는 수업은 404
    expect((await caught(() => checkCapacityPriceChange(handle.db, randomUUID(), { priceAmount: 1000 }))).status).toBe(404);
  });
});
