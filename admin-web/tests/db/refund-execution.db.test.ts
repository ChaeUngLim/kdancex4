// S4-1.5(수단별 환불 실행) — 대표가 승인하면 카드 결제분은 포트를 거쳐 PG 부분 취소로 실행되고,
// 계좌 결제분은 포트를 부르지 않고 송금 대기로 남는지 실제 PostgreSQL 에서 본다.
//   계약: _workspace/03_contracts/12-refund-cancel-waitlist.md §1-3(환불 1회 보장) · §2-3(승인 트랜잭션) · §8 수용 ②
//   (로드맵 verify 의 파일 이름 `tests/db/s4-1-5.db.test.ts` 를 기능 이름 `refund-execution.db.test.ts` 로 바꿨다)
//
// 확인하는 것:
//   ① 카드 승인 → 부분 취소 호출 1회(금액·키 refund:request:{id}:1) · 환불 행 succeeded(원인·실행 칸) · 주문 환불 합계 · 요청 completed
//   ② 같은 승인을 다시 보내도 PG 호출은 그대로 1회, 환불 행 1개, 합계도 한 번만 올라 있다(FR-102)
//   ③ 계좌(가상계좌) 승인 → PG 호출 0회 · 환불 행 pending(owner_bank_transfer) · 송금 기한 = 승인 + 5영업일 · 요청은 처리 중(수용 ②)
//   ④ 간편결제도 카드처럼 부분 취소 · PG 가 거절하면 failed 로 남고 합계를 되돌리며 요청은 처리 중으로 남는다(FR-103)
//   ⑤ PG 원장의 취소 가능 금액을 넘으면 PG 가 거절한다(부분 취소의 상한은 PG 도 지킨다)
//   ⑥ PG 결과를 못 받으면 pending 으로 남고, 같은 승인을 다시 보내면 같은 키로 다시 불러 succeeded 로 수렴한다
//   ⑦ 0원 승인은 돈이 움직이지 않는다 — 환불 행 0 · PG 호출 0 · 요청 completed
//   ⑧ DB 마지막 방어선 — 같은 원인의 살아 있는 환불 2건 거부(uq_refunds_basis_active) · 합계가 결제액을 넘으면 거부(ck_orders_refunded_cap)
// 다른 DB 테스트와 표를 함께 쓰므로 테스트마다 truncateAll 로 비운다(DB 테스트는 flock 으로 하나씩 돈다).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import {
  CANCEL_AMOUNT_EXCEEDS_CODE,
  FakePaymentGateway,
  createFakePaymentGatewayStore,
  type FakePaymentGatewayStore,
} from "../../lib/server/fakes/fake-payment-gateway";
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

// 2026-11-05(목) 14:20 KST 접수 → 2026-11-06(금) 10:00 KST 승인
const RECEIVED_AT = Temporal.Instant.from("2026-11-05T05:20:00Z");
const DECIDED_AT = Temporal.Instant.from("2026-11-06T01:00:00Z");
// 승인(금) + 5영업일 = 11-09(월)·10·11·12·13(금) → 11-13(금) 10:00 KST (공휴일 없음)
const TRANSFER_DUE_AT = "2026-11-13T01:00:00.000Z";

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

/** 결과를 못 받는 PG — 네트워크가 끊긴 것처럼 PaymentGatewayError 가 아닌 예외를 던진다 */
function unreachableGateway(): PaymentGatewayPort {
  return {
    createPayment: () => Promise.reject(new Error("unused")),
    getPayment: () => Promise.reject(new Error("unused")),
    cancelPayment: () => Promise.reject(new Error("unused")),
    refund: () => Promise.reject(new Error("socket hang up")),
  };
}

describe.skipIf(!dbAvailable())("수단별 환불 실행(S4-1.5)", () => {
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
   * 정규 4회 180,000원 예약 + 환불 요청. 카드·간편결제는 진짜 요청 경로(S4-1.2)로, 계좌 결제분은 저장한 환불 계좌를 건 요청 행을 넣는다
   * (계좌 저장 API 는 S4-1.2a 가 따로 시험한다 — 여기서는 실행만 본다).
   */
  async function regularRequest(method: "card" | "easy_pay" | "virtual_account"): Promise<{ chain: CancellationChain; requestId: string; accountId: string | null }> {
    const chain = await insertCancellationChain(handle.pool, { method: method === "virtual_account" ? "virtual_account" : "card", amount: 180000 });
    if (method === "easy_pay") await q("UPDATE payments SET method = 'easy_pay' WHERE id = $1", [chain.paymentId]);
    await q("UPDATE classes SET class_kind = 'regular', title = '살사 온투 기초' WHERE id = (SELECT class_id FROM class_offerings WHERE id = $1)", [chain.offeringId]);
    await q("UPDATE orders SET class_kind = 'regular', session_count = 4 WHERE id = $1", [chain.orderId]);
    await q("UPDATE refund_notice_versions SET content = $2::jsonb WHERE id = (SELECT refund_notice_version_id FROM orders WHERE id = $1)", [
      chain.orderId,
      JSON.stringify(REGULAR_NOTICE),
    ]);
    await q(`INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES (uuidv7(), $1, 0, '2026-11-01T10:00:00Z', '2026-11-01T12:00:00Z')`, [chain.offeringId]);

    if (method === "virtual_account") {
      const accountId = randomUUID();
      await q(
        `INSERT INTO refund_accounts (id, order_id, member_id, bank_code, account_number_enc, account_masked, holder_name, holder_matches_identity)
         VALUES ($1, $2, $3, 'KOOKMIN', '\\x00'::bytea, '국민은행 ****-**-7890', '취소 시험 회원', true)`,
        [accountId, chain.orderId, chain.memberId],
      );
      const requestId = randomUUID();
      await q(
        `INSERT INTO refund_requests (id, order_id, reservation_id, academy_id, member_id, kind, reason_kind, notice_version_id, refund_account_id,
                                      received_at, answer_due_at, idempotency_key)
         SELECT $1, o.id, $2, $3, o.member_id, 'regular', 'personal', o.refund_notice_version_id, $6, $4::timestamptz,
                $4::timestamptz + interval '5 days', 'direct-key-0001'
           FROM orders o WHERE o.id = $5`,
        [requestId, chain.reservationId, chain.academyId, RECEIVED_AT.toString(), chain.orderId, accountId],
      );
      return { chain, requestId, accountId };
    }
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
    return { chain, requestId: refundRequestCreatedSchema.parse(await response.json()).requestId, accountId: null };
  }

  async function decide(gateway: PaymentGatewayPort, academyId: string, requestId: string, authUserId: string, body: unknown = APPROVE) {
    const route = createRefundDecisionRoute(deps(DECIDED_AT, gateway));
    return route(
      new Request(`${BASE}/api/academies/${academyId}/refund-requests/${requestId}/decision`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-app-token",
          "content-type": "application/json",
          [TEST_USER_HEADER]: authUserId,
          "Idempotency-Key": "decision-key-0001",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, requestId }) },
    );
  }

  const refundRows = (requestId: string) =>
    q<Record<string, unknown>>(
      `SELECT status, requested_amount, refunded_amount, refund_rate_bp, basis_kind, basis_id, execution_kind, executed_by,
              executed_by_staff_account_id, refund_request_id, order_id, refund_account_id, attempt_no, idempotency_key,
              failure_code, to_char(transfer_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS transfer_due_at
         FROM refunds WHERE refund_request_id = $1 ORDER BY attempt_no`,
      [requestId],
    );
  const orderTotals = async (orderId: string) =>
    (await q<{ refunded_total_amount: number; status: string }>("SELECT refunded_total_amount, status FROM orders WHERE id = $1", [orderId]))[0]!;
  const requestStatus = async (requestId: string) =>
    (await q<{ status: string; completed: boolean }>("SELECT status, completed_at IS NOT NULL AS completed FROM refund_requests WHERE id = $1", [requestId]))[0]!;
  const events = async (requestId: string) =>
    (await q<{ event_type: string }>(
      "SELECT e.event_type FROM refund_events e JOIN refunds r ON r.id = e.refund_id WHERE r.refund_request_id = $1 ORDER BY e.created_at, e.id",
      [requestId],
    )).map((e) => e.event_type);

  test("① 카드 승인 → PG 부분 취소 호출 1회 · 환불 행 succeeded · 주문 환불 합계 107,200원 · 요청 completed", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });

    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId);
    expect(response.status).toBe(200);
    const body = refundDecisionResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      requestId,
      status: "completed",
      decisionKind: "approved",
      decidedAmount: 107200,
      refund: { executionKind: "pg_cancel", status: "succeeded", refundedAmount: 107200 },
    });

    // 포트를 정확히 한 번, 원거래·금액·멱등 키를 맞춰 불렀다(수용 ②)
    expect(gateway.refundCalls()).toEqual([
      expect.objectContaining({ paymentKey: chain.gatewayPaymentId, method: "card", amount: 107200, idempotencyKey: `refund:request:${requestId}:1` }),
    ]);
    const rows = await refundRows(requestId);
    expect(rows).toEqual([
      {
        status: "succeeded",
        requested_amount: 107200,
        refunded_amount: 107200,
        refund_rate_bp: 5956, // 107,200 ÷ 180,000 = 59.555…% → 올림
        basis_kind: "request",
        basis_id: requestId,
        execution_kind: "pg_cancel",
        executed_by: "owner",
        executed_by_staff_account_id: owner.staffId,
        refund_request_id: requestId,
        order_id: chain.orderId,
        refund_account_id: null,
        attempt_no: 1,
        idempotency_key: `refund:request:${requestId}:1`,
        failure_code: null,
        transfer_due_at: null,
      },
    ]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
    expect(await requestStatus(requestId)).toEqual({ status: "completed", completed: true });
    expect(await events(requestId)).toEqual(["refund_requested", "gateway_succeeded"]);
    // 회원의 예약은 아직 그대로다 — 예약 취소·주문 상태 전이는 S4-1.7
    const [reservation] = await q("SELECT status FROM reservations WHERE id = $1", [chain.reservationId]);
    expect(reservation).toEqual({ status: "confirmed" });
  });

  test("② 같은 승인을 다시 보내도 PG 호출 1회 · 환불 행 1개 · 합계 한 번만", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });

    const first = refundDecisionResponseSchema.parse(await (await decide(gateway, chain.academyId, requestId, owner.authUserId)).json());
    const again = await decide(gateway, chain.academyId, requestId, owner.authUserId);
    expect(again.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await again.json())).toEqual(first);
    expect(gateway.refundCalls()).toHaveLength(1);
    expect(await refundRows(requestId)).toHaveLength(1);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
  });

  test("③ 계좌 결제분 승인 → PG 호출 0회 · 환불 행 pending(owner_bank_transfer) · 송금 기한 승인 + 5영업일 · 요청 처리 중", async () => {
    const { chain, requestId, accountId } = await regularRequest("virtual_account");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });

    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId);
    expect(response.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await response.json())).toMatchObject({
      status: "in_progress",
      refund: { executionKind: "owner_bank_transfer", status: "pending", refundedAmount: 0 },
    });
    expect(gateway.refundCalls()).toHaveLength(0);
    expect(await refundRows(requestId)).toEqual([
      expect.objectContaining({
        status: "pending",
        requested_amount: 107200,
        refunded_amount: 0,
        execution_kind: "owner_bank_transfer",
        refund_account_id: accountId,
        transfer_due_at: TRANSFER_DUE_AT,
        idempotency_key: `refund:request:${requestId}:1`,
      }),
    ]);
    // 송금 전이라도 돌려주기로 잡아 둔 금액이라 합계에는 들어간다(다른 원인이 결제액을 넘겨 잡지 못하게)
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
    // 「송금 완료」 전에는 요청이 completed 가 아니다(수용 ②)
    expect(await requestStatus(requestId)).toEqual({ status: "in_progress", completed: false });
    expect(await events(requestId)).toEqual(["refund_requested"]);
  });

  test("④ 간편결제도 부분 취소 · PG 가 거절하면 failed · 합계 되돌림 · 요청은 처리 중으로 남는다", async () => {
    const ok = await regularRequest("easy_pay");
    const okOwner = await makeOwner(ok.chain.academyId);
    const okGateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    const okBody = refundDecisionResponseSchema.parse(await (await decide(okGateway, ok.chain.academyId, ok.requestId, okOwner.authUserId)).json());
    expect(okBody.refund).toMatchObject({ executionKind: "pg_cancel", status: "succeeded" });
    expect(okGateway.refundCalls()).toEqual([expect.objectContaining({ method: "easy_pay", amount: 107200 })]);

    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT), failOn: [chain.gatewayPaymentId] });
    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId);
    expect(response.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await response.json())).toMatchObject({
      status: "in_progress",
      refund: { executionKind: "pg_cancel", status: "failed", refundedAmount: 0 },
    });
    expect(gateway.refundCalls()).toHaveLength(1);
    expect(await refundRows(requestId)).toEqual([expect.objectContaining({ status: "failed", refunded_amount: 0, failure_code: "PG_PROVIDER_ERROR" })]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 0 });
    expect(await requestStatus(requestId)).toEqual({ status: "in_progress", completed: false });
    expect(await events(requestId)).toEqual(["refund_requested", "gateway_failed"]);
  });

  test("⑤ PG 원장의 취소 가능 금액을 넘으면 PG 가 거절한다", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const store: FakePaymentGatewayStore = createFakePaymentGatewayStore();
    const gateway = new FakePaymentGateway({ store, clock: fixedClock(DECIDED_AT) });
    // PG 원장에는 이 결제가 100,000원만 승인돼 있다 — 107,200원 부분 취소는 남은 취소 가능 금액을 넘는다
    await gateway.createPayment({ gatewayPaymentId: chain.gatewayPaymentId, method: "card", amount: 100000, dueAt: DECIDED_AT.add({ hours: 1 }), orderName: "살사 온투 기초" });
    gateway.deposit(chain.gatewayPaymentId, 100000);

    const body = refundDecisionResponseSchema.parse(await (await decide(gateway, chain.academyId, requestId, owner.authUserId)).json());
    expect(body.refund).toMatchObject({ status: "failed" });
    expect(await refundRows(requestId)).toEqual([expect.objectContaining({ status: "failed", failure_code: CANCEL_AMOUNT_EXCEEDS_CODE })]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 0 });
  });

  test("⑥ PG 결과를 못 받으면 pending 으로 남고, 다시 보내면 같은 키로 불러 succeeded 로 수렴한다", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);

    const lost = await decide(unreachableGateway(), chain.academyId, requestId, owner.authUserId);
    expect(lost.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await lost.json())).toMatchObject({ status: "in_progress", refund: { status: "pending" } });
    expect(await refundRows(requestId)).toEqual([expect.objectContaining({ status: "pending", attempt_no: 1 })]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });

    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    const retried = refundDecisionResponseSchema.parse(await (await decide(gateway, chain.academyId, requestId, owner.authUserId)).json());
    expect(retried).toMatchObject({ status: "completed", refund: { status: "succeeded", refundedAmount: 107200 } });
    // 새 시도 행이 아니라 같은 행·같은 키로 끝냈다
    expect(gateway.refundCalls()).toEqual([expect.objectContaining({ idempotencyKey: `refund:request:${requestId}:1` })]);
    expect(await refundRows(requestId)).toEqual([expect.objectContaining({ status: "succeeded", attempt_no: 1 })]);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 107200 });
  });

  test("⑦ 0원 승인 — 환불 행 0 · PG 호출 0 · 요청 completed", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    const response = await decide(gateway, chain.academyId, requestId, owner.authUserId, { decision: "approve", amount: 0, noticeItemCode: "no_refund_case" });
    expect(response.status).toBe(200);
    expect(refundDecisionResponseSchema.parse(await response.json())).toMatchObject({ status: "completed", decidedAmount: 0, refund: null });
    expect(gateway.refundCalls()).toHaveLength(0);
    expect(await refundRows(requestId)).toHaveLength(0);
    expect(await orderTotals(chain.orderId)).toMatchObject({ refunded_total_amount: 0 });
  });

  test("⑧ DB 마지막 방어선 — 같은 원인 살아 있는 환불 2건 거부 · 합계가 결제액을 넘으면 거부", async () => {
    const { chain, requestId } = await regularRequest("card");
    const owner = await makeOwner(chain.academyId);
    const gateway = new FakePaymentGateway({ store: createFakePaymentGatewayStore(), clock: fixedClock(DECIDED_AT) });
    expect((await decide(gateway, chain.academyId, requestId, owner.authUserId)).status).toBe(200);

    // 같은 원인(이 요청)으로 살아 있는 환불을 하나 더 넣으려 하면 원인당 1건 유니크에 걸린다(FR-102 · D13)
    await expect(
      q(
        `INSERT INTO refunds (id, reservation_id, payment_id, order_id, idempotency_key, requested_amount, refund_rate_bp, status, reason,
                              basis_kind, basis_id, execution_kind, executed_by, executed_by_staff_account_id, attempt_no, updated_at)
         VALUES (uuidv7(), $1, $2, $3, 'refund:request:dup:2', 1000, 56, 'pending', 'member_request', 'request', $4, 'pg_cancel', 'owner', $5, 2, now())`,
        [chain.reservationId, chain.paymentId, chain.orderId, requestId, owner.staffId],
      ),
    ).rejects.toThrow(/uq_refunds_basis_active/);
    // 주문 환불 합계가 결제액(180,000원)을 넘으면 CHECK 가 막는다(SC-010)
    await expect(q("UPDATE orders SET refunded_total_amount = 180001 WHERE id = $1", [chain.orderId])).rejects.toThrow(/ck_orders_refunded_cap/);
    // 원인 칸이 반만 찬 행은 넣을 수 없다
    await expect(
      q(
        `INSERT INTO refunds (id, reservation_id, payment_id, order_id, idempotency_key, requested_amount, refund_rate_bp, status, reason, basis_kind, basis_id, updated_at)
         VALUES (uuidv7(), $1, $2, $3, 'refund:request:half:1', 1000, 56, 'pending', 'member_request', 'request', $4, now())`,
        [chain.reservationId, chain.paymentId, chain.orderId, randomUUID()],
      ),
    ).rejects.toThrow(/ck_refunds_basis_complete/);
  });
});
