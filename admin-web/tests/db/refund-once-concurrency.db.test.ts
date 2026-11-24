// S4-1.6(환불 1회 보장 동시성 테스트) — 같은 원인으로 두 번(동시에) 실행해도 돈은 한 번만 나가고,
// 같은 예약이라도 원인이 다르면 환불이 각각 되며, 한 주문의 환불 합계는 상한을 넘지 못하는지 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §1-3(환불 1회 보장) · §8 수용 ③
//   설계: _workspace/03_data-model.md §9-2(ck_orders_refunded_cap) · §9-3(uq_refunds_basis_active)
//   spec: FR-102(환불 1회 보장) · SC-007(중복 환불 0건) · SC-010(환불 초과 0건) · 2026-11-20 사용자 결정 D13·D15·D21
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-6.db.test.ts` 를 기능 이름 `refund-once-concurrency.db.test.ts` 로 바꿨다)
//
// 이 파일은 테스트만 쓴다 — 새 코드 없이, 이미 있는 두 DB 방어선에 기댄다.
//   · uq_refunds_basis_active : 원인(basis_kind, basis_id)마다 살아 있는(failed 가 아닌) 환불은 1건뿐
//   · ck_orders_refunded_cap  : 주문 환불 합계 ≤ 결제액 − 예매 수수료 + (청약철회로 돌려준 수수료)
//
// 확인하는 것:
//   ① 같은 환불 요청의 승인이 동시에 2건(같은 멱등 키) → 환불 행 1개 · PG 부분 취소 키 1개 · 합계 한 번만(수용 ③, SC-007)
//   ② 같은 요청의 승인이 동시에 2건(다른 멱등 키 — 대표가 두 기기에서 누름) → 그래도 환불 1회
//   ③ 휴강 선택·일괄 취소 줄 같은 원인으로 환불을 동시에 2번 넣으면 하나만 남고, 합계도 한 번만 오른다
//   ④ 같은 예약에 휴강 환불(closure_choice) 뒤 중도 환불(request) — 원인이 달라 둘 다 된다(D13)
//   ⑤ 원인이 달라도 남은 금액을 넘는 승인은 409 로 막히고 승인 기록까지 되돌아간다
//   ⑥ 다른 원인 두 환불이 동시에 와서 합치면 상한을 넘을 때 — 하나만 들어가고 다른 하나는 CHECK 로 거부(SC-010)
//   ⑦ 상한 = 결제액 − 예매 수수료: 넘는 UPDATE·INSERT 는 CHECK 로 거부(D15)
//   ⑧ 단 청약철회(statutory_withdrawal) 환불은 수수료까지 돌려줘 결제액까지 허용, 그 이상은 거부(D21)
// 다른 DB 테스트와 표를 함께 쓰므로 테스트마다 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { AuthSession, SessionReader } from "../../lib/server/guards";
import type { PaymentGatewayPort } from "../../lib/server/ports/payment-gateway";
import { refundDecisionResponseSchema } from "../../lib/server/schemas/refund-decisions";
import { refundRequestCreatedSchema } from "../../lib/server/schemas/refund-requests";
import { createRefundDecisionRoute } from "../../lib/server/services/refund-decisions";
import { createRefundRequestRoute } from "../../lib/server/services/refund-requests";
import { insertCancellationChain, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  if (id === null) return null;
  const session: AuthSession = { user: { id } };
  return session;
};

// 2026-11-05(목) 14:20 KST 접수 → 2026-11-06(금) 10:00 KST 승인 (S4-1.5 테스트와 같은 시각)
const RECEIVED_AT = Temporal.Instant.from("2026-11-05T05:20:00Z");
const DECIDED_AT = Temporal.Instant.from("2026-11-06T01:00:00Z");

/** 결제액 180,000원 = 수강료 178,000원 + 예매 수수료 2,000원 */
const PAID = 180000;
const BOOKING_FEE = 2000;
/** 보통 환불의 상한 = 결제액 − 예매 수수료(D15) */
const CAP = PAID - BOOKING_FEE;

const REGULAR_NOTICE = {
  cancellableUntil: "첫 수업 시작 전까지",
  tiers: [
    { point: "before_start", percent: 100 },
    { point: "before_one_third", percent: 67 },
    { point: "before_half", percent: 50 },
    { point: "after_half", percent: 0 },
  ],
  nonRefundableCases: "이미 들은 회차",
  processingBusinessDays: 5,
  ownerContact: "0212345678",
};

const APPROVE = { decision: "approve", amount: 107200, noticeItemCode: "tier:before_one_third" } as const;

/** 원인 종류별로 누가 실행했나 — 휴강 선택은 회원 선택 뒤 자동, 일괄 취소 줄은 일괄 처리, 청약철회는 자동 */
const EXECUTED_BY = { closure_choice: "system_auto", bulk_item: "system_bulk", statutory_withdrawal: "system_auto" } as const;
type DirectBasis = keyof typeof EXECUTED_BY;

describe.skipIf(!dbAvailable())("환불 1회 보장 동시성(S4-1.6)", () => {
  let handle: TestDb;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await handle.pool.query(text, params)).rows as T[];

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  const deps = (at: Temporal.Instant, paymentGateway: PaymentGatewayPort) => ({ db: handle.db, getSession: fakeSession, clock: fixedClock(at), paymentGateway });

  async function makeOwner(academyId: string): Promise<{ authUserId: string; staffId: string }> {
    const staffId = randomUUID();
    const authUserId = `auth-owner-${staffId}`;
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '김대표', 'active', now())", [staffId, authUserId]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffId]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffId]);
    return { authUserId, staffId };
  }

  /**
   * 카드로 결제한 정규 4회 예약(결제액 180,000원 중 예매 수수료 2,000원) + 진짜 요청 경로(S4-1.2)로 만든 환불 요청.
   * total_amount = 수강료 + 예매 수수료 라는 주문 CHECK(ck_orders_total_formula)에 맞춰 수강료를 178,000원으로 둔다.
   */
  async function regularRequest(): Promise<{ chain: CancellationChain; requestId: string }> {
    const chain = await insertCancellationChain(handle.pool, { method: "card", amount: PAID });
    await q("UPDATE classes SET class_kind = 'regular', title = '살사 온투 기초' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular', session_count = 4, list_price_amount = $2, booking_fee_amount = $3 WHERE id = $1", [
      chain.orderId,
      PAID - BOOKING_FEE,
      BOOKING_FEE,
    ]);
    await q("UPDATE refund_notice_versions SET content = $2::jsonb WHERE id = (SELECT refund_notice_version_id FROM orders WHERE id = $1)", [
      chain.orderId,
      JSON.stringify(REGULAR_NOTICE),
    ]);
    await q(`INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES (uuidv7(), $1, 0, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z')`, [chain.offeringId]);

    const create = createRefundRequestRoute(deps(RECEIVED_AT, new FakePaymentGateway({ store: createFakePaymentGatewayStore() })));
    const response = await create(
      new Request(`${BASE}/api/refund-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_USER_HEADER]: chain.authUserId, "Idempotency-Key": `key-${randomUUID()}` },
        body: JSON.stringify({ reservationId: chain.reservationId, reasonKind: "schedule_change", reasonText: "일정이 바뀌어 더 다닐 수 없어요" }),
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    return { chain, requestId: refundRequestCreatedSchema.parse(await response.json()).requestId };
  }

  /** 대표 승인 — 진짜 승인 경로(S4-1.4·S4-1.5). 멱등 키를 바꿔 「다른 기기에서 또 누름」도 흉내 낸다 */
  async function decide(gateway: PaymentGatewayPort, academyId: string, requestId: string, authUserId: string, idempotencyKey: string, body: unknown = APPROVE) {
    const route = createRefundDecisionRoute(deps(DECIDED_AT, gateway));
    return route(
      new Request(`${BASE}/api/academies/${academyId}/refund-requests/${requestId}/decision`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-app-token",
          "content-type": "application/json",
          [TEST_USER_HEADER]: authUserId,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, requestId }) },
    );
  }

  /** 트랜잭션 하나를 따로 연결에서 돌린다 — 두 개를 동시에 띄워 실제 경합을 만든다 */
  async function inTx(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await handle.pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
      await client.query("COMMIT");
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 요청이 아닌 원인(휴강 선택·일괄 취소 줄·청약철회)의 환불 한 건을 계약 §1-3 순서대로 넣는다 —
   * ① 주문 환불 합계를 올리고 ② 환불 행을 넣는다. 이 원인들의 서비스는 다른 Task(S4-2·S4-3 등)가 만든다.
   * 여기서는 DB 방어선만 시험하므로 같은 모양의 SQL 을 직접 보낸다. 합계 증가는 조건 없이 올려 CHECK 가 막는지 본다.
   * holdMs 를 주면 커밋 전에 잠시 쥐고 있어 다른 트랜잭션과 확실히 겹치게 한다.
   */
  async function directRefund(
    client: PoolClient,
    chain: CancellationChain,
    input: { basis: DirectBasis; basisId: string; amount: number; status?: "pending" | "succeeded"; refundBookingFee?: boolean; holdMs?: number },
  ): Promise<void> {
    const status = input.status ?? "succeeded";
    await client.query(
      `UPDATE orders SET refunded_total_amount = refunded_total_amount + $2,
                         booking_fee_refunded_amount = CASE WHEN $3 THEN booking_fee_amount ELSE booking_fee_refunded_amount END,
                         updated_at = now()
        WHERE id = $1`,
      [chain.orderId, input.amount, input.refundBookingFee ?? false],
    );
    await client.query(
      `INSERT INTO refunds (id, reservation_id, payment_id, order_id, idempotency_key, requested_amount, refunded_amount, refund_rate_bp, status, reason,
                            basis_kind, basis_id, execution_kind, executed_by, attempt_no, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, 0, $7, 'member_request', $8, $9, 'pg_cancel', $10, 1, now())`,
      [
        chain.reservationId,
        chain.paymentId,
        chain.orderId,
        `refund:${input.basis}:${input.basisId}:1:${randomUUID()}`,
        input.amount,
        status === "succeeded" ? input.amount : 0,
        status,
        input.basis,
        input.basisId,
        EXECUTED_BY[input.basis],
      ],
    );
    if (input.holdMs !== undefined) await client.query("SELECT pg_sleep($1)", [input.holdMs / 1000]);
  }

  const refundsOf = (reservationId: string) =>
    q<{ basis_kind: string; basis_id: string; status: string; requested_amount: number }>(
      "SELECT basis_kind, basis_id, status, requested_amount FROM refunds WHERE reservation_id = $1 ORDER BY created_at, id",
      [reservationId],
    );
  const orderTotals = async (orderId: string) =>
    (await q<{ refunded_total_amount: number; booking_fee_refunded_amount: number }>(
      "SELECT refunded_total_amount, booking_fee_refunded_amount FROM orders WHERE id = $1",
      [orderId],
    ))[0]!;
  /** PG 에 실제로 나간 서로 다른 취소 키 — 같은 키는 PG 가 같은 결과를 줘 돈이 두 번 나가지 않는다 */
  const distinctKeys = (gateway: FakePaymentGateway) => new Set(gateway.refundCalls().map((c) => c.idempotencyKey));

  test("① 같은 요청의 승인이 동시에 2건(같은 멱등 키) → 환불 행 1개 · PG 취소 키 1개 · 합계 한 번만", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });

    const responses = await Promise.all([
      decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-0001"),
      decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-0001"),
    ]);
    // 둘 다 200 — 먼저 잠근 쪽이 결정하고, 늦은 쪽은 같은 결정의 재생이다(계약 §1-3)
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    for (const response of responses) {
      expect(refundDecisionResponseSchema.parse(await response.json())).toMatchObject({ decidedAmount: 107200 });
    }

    expect(await refundsOf(chain.reservationId)).toEqual([{ basis_kind: "request", basis_id: requestId, status: "succeeded", requested_amount: 107200 }]);
    expect(distinctKeys(gateway)).toEqual(new Set([`refund:request:${requestId}:1`]));
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
  });

  test("② 같은 요청의 승인이 동시에 2건(다른 멱등 키 — 두 기기에서 누름) → 그래도 환불 1회", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });

    const responses = await Promise.all([
      decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-phone"),
      decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-laptop"),
    ]);
    // 같은 결정(승인·같은 금액)이라 늦은 쪽도 재생 200 이다. 409 가 나오더라도 돈이 두 번 나가지만 않으면 된다
    for (const response of responses) expect([200, 409]).toContain(response.status);
    expect(responses.some((r) => r.status === 200)).toBe(true);

    expect(await refundsOf(chain.reservationId)).toHaveLength(1);
    expect(distinctKeys(gateway).size).toBe(1);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
  });

  test.each(["closure_choice", "bulk_item"] as const)(
    "③ %s 같은 원인으로 동시에 2번 → 하나만 남고(uq_refunds_basis_active) 합계도 한 번만",
    async (basis) => {
      const { chain } = await regularRequest();
      const basisId = randomUUID(); // 휴강 선택 행·일괄 취소 줄 하나
      const results = await Promise.allSettled([
        inTx((c) => directRefund(c, chain, { basis, basisId, amount: 45000, holdMs: 200 })),
        inTx((c) => directRefund(c, chain, { basis, basisId, amount: 45000, holdMs: 200 })),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]!.reason)).toMatch(/uq_refunds_basis_active/);

      // 진 쪽 트랜잭션은 통째로 롤백 — 합계 증가도 함께 사라졌다
      expect(await refundsOf(chain.reservationId)).toEqual([{ basis_kind: basis, basis_id: basisId, status: "succeeded", requested_amount: 45000 }]);
      expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 45000 });
    },
  );

  test("③-2 같은 원인이라도 앞 환불이 failed 면 새 시도는 들어간다(부분 유니크가 failed 를 뺀다)", async () => {
    const { chain } = await regularRequest();
    const basisId = randomUUID();
    await inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId, amount: 45000, status: "pending" }));
    // 실패 처리 — 상태를 failed 로, 올렸던 합계를 되돌린다(S4-1.5 의 실패 경로와 같은 모양)
    await q("UPDATE refunds SET status = 'failed', failure_code = 'PG_GATEWAY_ERROR' WHERE basis_id = $1", [basisId]);
    await q("UPDATE orders SET refunded_total_amount = refunded_total_amount - 45000 WHERE id = $1", [chain.orderId]);

    await inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId, amount: 45000 }));
    expect((await refundsOf(chain.reservationId)).map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 45000 });
  });

  test("④ 같은 예약에 휴강 환불 뒤 중도 환불 — 원인이 달라 둘 다 된다(D13)", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    const closureChoiceId = randomUUID();
    // 휴강 1회분 45,000원을 먼저 돌려줬다
    await inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId: closureChoiceId, amount: 45000 }));

    // 그 뒤 회원이 중도 환불을 요청했고 대표가 승인한다 — 같은 예약이지만 원인이 다르다
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-0001");
    expect(response.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await response.json())).toMatchObject({ status: "completed", refund: { status: "succeeded", refundedAmount: 107200 } });

    expect(await refundsOf(chain.reservationId)).toEqual([
      { basis_kind: "closure_choice", basis_id: closureChoiceId, status: "succeeded", requested_amount: 45000 },
      { basis_kind: "request", basis_id: requestId, status: "succeeded", requested_amount: 107200 },
    ]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 152200 });
  });

  test("⑤ 원인이 달라도 남은 금액을 넘는 승인은 409 — 승인 기록·환불 행·합계 모두 그대로", async () => {
    const { chain, requestId } = await regularRequest();
    const owner = await makeOwner(chain.academyId);
    // 이미 100,000원을 휴강으로 돌려줘 남은 상한은 178,000 − 100,000 = 78,000원
    await inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId: randomUUID(), amount: 100000 }));

    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId, "decision-key-0001");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "REFUND_EXCEEDS_PAID" });

    expect(gateway.refundCalls()).toHaveLength(0);
    expect((await refundsOf(chain.reservationId)).map((r) => r.basis_kind)).toEqual(["closure_choice"]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 100000 });
    const [request] = await q<{ status: string; decision_kind: string | null }>("SELECT status, decision_kind FROM refund_requests WHERE id = $1", [requestId]);
    expect(request).toMatchObject({ decision_kind: null });
    expect(request!.status).not.toBe("completed");
  });

  test("⑥ 다른 원인 두 환불이 동시에 와서 합치면 상한을 넘을 때 — 하나만 들어가고 다른 하나는 CHECK 로 거부", async () => {
    const { chain } = await regularRequest();
    // 100,000 + 100,000 = 200,000 > 상한 178,000
    const results = await Promise.allSettled([
      inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId: randomUUID(), amount: 100000, holdMs: 200 })),
      inTx((c) => directRefund(c, chain, { basis: "bulk_item", basisId: randomUUID(), amount: 100000, holdMs: 200 })),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]!.reason)).toMatch(/ck_orders_refunded_cap/);

    expect(await refundsOf(chain.reservationId)).toHaveLength(1);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 100000 });
  });

  test("⑦ 상한 = 결제액 − 예매 수수료 — 넘는 UPDATE·INSERT 는 CHECK 로 거부(D15)", async () => {
    const { chain } = await regularRequest();

    // 딱 상한(178,000원)까지는 된다
    await q("UPDATE orders SET refunded_total_amount = $2 WHERE id = $1", [chain.orderId, CAP]);
    // 1원이라도 넘으면 거부 — 예매 수수료는 보통 환불로 돌려주지 않는다
    await expect(q("UPDATE orders SET refunded_total_amount = $2 WHERE id = $1", [chain.orderId, CAP + 1])).rejects.toThrow(/ck_orders_refunded_cap/);
    await expect(q("UPDATE orders SET refunded_total_amount = $2 WHERE id = $1", [chain.orderId, PAID])).rejects.toThrow(/ck_orders_refunded_cap/);
    // 음수 합계도 거부
    await expect(q("UPDATE orders SET refunded_total_amount = -1 WHERE id = $1", [chain.orderId])).rejects.toThrow(/ck_orders_refunded_cap/);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: CAP });

    // INSERT 도 같다 — 이 주문을 복제하면서 환불 합계만 상한 넘게 넣어 본다(고유값 칸은 새로 만든다)
    const columns = (
      await q<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name NOT IN ('id', 'idempotency_key', 'refunded_total_amount') ORDER BY ordinal_position",
      )
    ).map((c) => `"${c.column_name}"`);
    const insertCopy = (refunded: number) =>
      q(
        `INSERT INTO orders (id, idempotency_key, refunded_total_amount, ${columns.join(", ")})
         SELECT uuidv7(), 'copy-' || gen_random_uuid(), $2, ${columns.join(", ")} FROM orders WHERE id = $1`,
        [chain.orderId, refunded],
      );
    await expect(insertCopy(CAP + 1)).rejects.toThrow(/ck_orders_refunded_cap/);
    await insertCopy(CAP); // 상한 그대로면 들어간다 — 막힌 이유가 다른 제약이 아니라는 대조군
  });

  test("⑧ 청약철회(statutory_withdrawal) 환불은 예매 수수료까지 돌려줘 결제액까지 허용, 넘으면 거부(D21)", async () => {
    const { chain } = await regularRequest();

    // 청약철회는 수수료까지 전액 — booking_fee_refunded_amount 를 수수료로 채우면 상한이 결제액(180,000원)이 된다
    await inTx((c) => directRefund(c, chain, { basis: "statutory_withdrawal", basisId: randomUUID(), amount: PAID, refundBookingFee: true }));
    expect(await orderTotals(chain.orderId)).toEqual({ refunded_total_amount: PAID, booking_fee_refunded_amount: BOOKING_FEE });
    expect((await refundsOf(chain.reservationId)).map((r) => [r.basis_kind, r.requested_amount])).toEqual([["statutory_withdrawal", PAID]]);

    // 결제액을 1원이라도 넘으면 청약철회여도 거부
    await expect(
      inTx((c) => directRefund(c, chain, { basis: "closure_choice", basisId: randomUUID(), amount: 1 })),
    ).rejects.toThrow(/ck_orders_refunded_cap/);
    // 수수료 환불액은 0 이나 수수료 전액 둘 중 하나뿐 — 일부만 돌려준 척해 상한을 키울 수 없다
    await expect(q("UPDATE orders SET booking_fee_refunded_amount = 1000 WHERE id = $1", [chain.orderId])).rejects.toThrow(/ck_orders_booking_fee_refunded/);
    // 수수료를 돌려주지 않은 보통 환불로는 결제액 전액을 못 넣는다(대조군)
    const other = await regularRequest();
    await expect(
      inTx((c) => directRefund(c, other.chain, { basis: "closure_choice", basisId: randomUUID(), amount: PAID })),
    ).rejects.toThrow(/ck_orders_refunded_cap/);
    expect(await orderTotals(other.chain.orderId)).toEqual({ refunded_total_amount: 0, booking_fee_refunded_amount: 0 });
  });
});
