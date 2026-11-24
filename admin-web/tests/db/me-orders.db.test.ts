// S3-4.6(결제 내역·주문 상태 표시 API) — `GET /api/me/orders?status=&limit=&cursor=`(계약 04 §9 · 수용 시나리오 8)
//   verify: 부분 환불 픽스처 주문이 status "partially_refunded"(화면 「부분 환불」)로 나온다(수용 ④) · skip 0
//   그리고: 남의 주문은 안 보인다 · 상태 이름은 constants.ts 6종 그대로 · refundedAmount = 완료(succeeded) 환불 합계 ·
//           dueAt 은 pending 일 때만 · 기한 지난 결제 대기는 expired 로 정리돼 보인다 · 계좌·카드 번호 없음 ·
//           status 거르기 · 최신순 커서로 겹침·빠짐 없이 다음 쪽 · 쿼리 오류 422 · 401·403
//
// 주문 사슬은 취소 시험 픽스처(tests/fixtures/cancellation.ts)로 만들고, 부분 환불은 refunds 1행 + 주문 상태로 만든다.
// 이름: verify 의 tests/db/s3-4-6.db.test.ts 는 Task 번호 이름이라 기능 이름(me-orders)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ORDER_STATUSES } from "../../lib/domain/constants";
import { systemClock } from "../../lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { SessionReader } from "../../lib/server/guards";
import { createMeOrdersRoute, meOrderListSchema, type MeOrderList } from "../../lib/server/services/me-orders";
import { insertCancellationChain, insertMember, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
// 시험용 세션 읽기 — 가드 자체는 staff-guards.db.test.ts 가 시험한다. 헤더의 사용자 id 를 그대로 세션으로 본다
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  return id === null ? null : { user: { id } };
};

describe.skipIf(!dbAvailable())("내 결제 내역·주문 상태 API(계약 04 §9, S3-4.6)", () => {
  let handle: TestDb;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  const route = () =>
    createMeOrdersRoute({
      db: handle.db,
      getSession: fakeSession,
      clock: systemClock,
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    });

  async function get(query: string, authUserId: string | null): Promise<Response> {
    return route()(
      new Request(`${BASE}/api/me/orders${query}`, { headers: authUserId === null ? {} : { [TEST_USER_HEADER]: authUserId } }),
      undefined,
    );
  }
  async function list(query: string, authUserId: string): Promise<MeOrderList> {
    const res = await get(query, authUserId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    return meOrderListSchema.parse(await res.json());
  }

  /** 부분 환불 픽스처 — 30,000원 결제 중 15,000원을 돌려준 주문(refunds succeeded 1행 + 주문 partially_refunded) */
  async function partialRefund(chain: CancellationChain, refunded = 15000) {
    await q(
      `INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount, refund_rate_bp, status, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, 5000, 'succeeded', 'member_request', now())`,
      [randomUUID(), chain.reservationId, chain.paymentId, `idem-${randomUUID()}`, refunded],
    );
    await q(`UPDATE orders SET status = 'partially_refunded' WHERE id = $1`, [chain.orderId]);
  }

  test("① 부분 환불 픽스처 주문이 partially_refunded 로, 환불 합계와 함께 나온다 — 남의 주문은 없다(수용 ④)", async () => {
    const chain = await insertCancellationChain(handle.pool, { amount: 30000, method: "card" });
    await partialRefund(chain);
    // 실패한 환불은 합계에 들어가지 않는다(완료분만, README §3) — 활성 유니크(실패 제외) 덕에 같은 예약에 하나 더 넣을 수 있다
    await q(
      `INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount, refund_rate_bp, status, reason, updated_at)
       VALUES ($1, $2, $3, $4, 9000, 0, 3000, 'failed', 'member_request', now())`,
      [randomUUID(), chain.reservationId, chain.paymentId, `idem-${randomUUID()}`],
    );
    const other = await insertCancellationChain(handle.pool, { amount: 50000 });

    const body = await list("", chain.authUserId);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    const [item] = body.items;
    expect(item).toMatchObject({
      orderId: chain.orderId,
      status: "partially_refunded",
      offeringId: chain.offeringId,
      title: "살사 입문 · 원데이",
      academyName: "취소 시험 학원",
      seatKind: "any",
      method: "card",
      totalAmount: 30000,
      refundedAmount: 15000,
      dueAt: null,
      receipt: { academyUrl: null, companyUrl: null, cashReceiptIssued: false },
    });
    expect(item?.paidAt).not.toBeNull();
    // 상태 이름은 constants.ts 의 6종 값 그대로다
    expect(ORDER_STATUSES).toContain(item?.status);
    // 남의 주문 id 는 응답 어디에도 없다
    expect(JSON.stringify(body)).not.toContain(other.orderId);
  });

  test("② 결제 대기는 dueAt 이 있고, 계좌번호·PG 결제 id 는 목록에 없다", async () => {
    const pending = await insertCancellationChain(handle.pool, { stage: "pending", method: "virtual_account" });
    await q(`UPDATE payments SET virtual_account_bank_code = '004', virtual_account_number = '99988877766655', virtual_account_holder = '취소시험' WHERE id = $1`, [
      pending.paymentId,
    ]);
    const paid = await insertCancellationChain(handle.pool, { memberId: pending.memberId });

    const res = await get("", pending.authUserId);
    const text = await res.text();
    expect(text).not.toContain("99988877766655");
    expect(text).not.toContain(pending.gatewayPaymentId);
    const body = meOrderListSchema.parse(JSON.parse(text));
    const byId = new Map(body.items.map((item) => [item.orderId, item]));
    expect(byId.get(pending.orderId)).toMatchObject({ status: "pending", method: "virtual_account", paidAt: null });
    expect(byId.get(pending.orderId)?.dueAt).not.toBeNull();
    expect(byId.get(paid.orderId)).toMatchObject({ status: "paid", dueAt: null, refundedAmount: 0 });
  });

  test("③ 기한이 지난 결제 대기는 읽기 전에 정리돼 expired 로 보인다(단건 조회와 같은 규칙)", async () => {
    const pending = await insertCancellationChain(handle.pool, { stage: "pending" });
    await q(`UPDATE payments SET due_at = now() - interval '1 minute' WHERE id = $1`, [pending.paymentId]);

    const body = await list("", pending.authUserId);
    expect(body.items[0]).toMatchObject({ orderId: pending.orderId, status: "expired", dueAt: null });
    const [row] = await q<{ status: string; held: number }>(
      `SELECT o.status, sp.held_count AS held FROM orders o JOIN seat_pools sp ON sp.offering_id = o.offering_id WHERE o.id = $1`,
      [pending.orderId],
    );
    expect(row).toMatchObject({ status: "expired", held: 0 });
  });

  test("④ status 로 6종 이름을 쉼표로 여러 개 거른다", async () => {
    const a = await insertCancellationChain(handle.pool, { amount: 30000 });
    await partialRefund(a);
    const b = await insertCancellationChain(handle.pool, { memberId: a.memberId });
    const c = await insertCancellationChain(handle.pool, { memberId: a.memberId, stage: "pending" });

    const refundedOnly = await list("?status=partially_refunded", a.authUserId);
    expect(refundedOnly.items.map((i) => i.orderId)).toEqual([a.orderId]);
    const two = await list("?status=paid,pending", a.authUserId);
    expect(new Set(two.items.map((i) => i.orderId))).toEqual(new Set([b.orderId, c.orderId]));
    const none = await list("?status=refunded", a.authUserId);
    expect(none.items).toEqual([]);
  });

  test("⑤ limit 으로 쪽을 나누면 같은 시각 주문까지 겹침·빠짐 없이 최신순으로 이어진다", async () => {
    const first = await insertCancellationChain(handle.pool);
    const chains = [first];
    for (let i = 0; i < 4; i += 1) chains.push(await insertCancellationChain(handle.pool, { memberId: first.memberId }));
    // 두 주문의 만든 시각을 똑같이 맞춰 (시각, id) 커서가 동률을 가르는지 본다
    await q(`UPDATE orders SET created_at = (SELECT created_at FROM orders WHERE id = $1) WHERE id = $2`, [chains[1]?.orderId, chains[2]?.orderId]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: MeOrderList = await list(`?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`, first.authUserId);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.orderId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    const expected = await q<{ id: string }>(`SELECT id FROM orders WHERE member_id = $1 ORDER BY created_at DESC, id DESC`, [first.memberId]);
    expect(seen).toEqual(expected.map((r) => r.id));
  });

  test("⑥ 6종 밖의 status · limit 범위 · 고친 커서 · 모르는 칸은 422", async () => {
    const chain = await insertCancellationChain(handle.pool);
    for (const query of ["?status=done", "?status=paid,unknown", "?limit=0", "?limit=51", "?limit=abc", "?cursor=bad-cursor", "?page=2"]) {
      const res = await get(query, chain.authUserId);
      expect(res.status, query).toBe(422);
      expect((await res.json()) as { code: string }).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect((await get("?limit=50", chain.authUserId)).status).toBe(200);
  });

  test("⑦ 세션 없음 401 · 가입을 덜 마친 사용자 403 (쿼리보다 인증 먼저)", async () => {
    const noSession = await get("?status=done", null);
    expect(noSession.status).toBe(401);
    const incomplete = await get("?status=done", `auth-${randomUUID()}`);
    expect(incomplete.status).toBe(403);
    expect((await incomplete.json()) as { code: string }).toMatchObject({ code: "SIGNUP_INCOMPLETE" });
    // 주문이 없는 회원은 빈 목록
    const { authUserId } = await insertMember(handle.pool);
    expect((await list("", authUserId)).items).toEqual([]);
  });
});
