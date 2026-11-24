// S0-5.1(취소 서비스·경로 이관) — 옛 취소 11단계가 Next.js 라우트에서 같은 동작으로 도는지 본다.
//   계약: _workspace/03_contracts/05-cancellation-migrated.md · 03-checkout-payment.md §2
//   (로드맵 verify 의 파일 이름 `tests/db/s0-5-1.db.test.ts` 를 기능 이름 `cancel-routes.db.test.ts` 로 바꿨다)
//
// 핵심은 수용 ①: 같은 예약 취소 2건이 동시에 와도 환불은 1회다. 이관 취소의 원인은 「회원 요청 취소」 하나라
// 이 시험이 곧 「같은 원인 2건」 시험이다(2026-11-20 사용자 결정 D13).
// 옛 9시나리오 전체 이식은 S0-5.3(옛 취소 9시나리오 이식)이 맡는다. 여기서는 경로·단계가 이어졌는지를 본다.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { SessionReader } from "../../lib/server/guards";
import {
  cancelOrderResponseSchema,
  cancelReservationResponseSchema,
  cancellationPreviewResponseSchema,
} from "../../lib/server/schemas/cancellation";
import { createCancelReservationRoute, type CancellationDeps } from "../../lib/server/services/cancellation";
import { createCancellationPreviewRoute } from "../../lib/server/services/cancellation-preview";
import { createCancelOrderRoute } from "../../lib/server/services/order-cancel";
import { systemClock } from "../../lib/domain/time";
import { insertCancellationChain, insertMember, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
// 시험용 세션 읽기 — 가드 자체는 staff-guards.db.test.ts 가 시험한다. 여기서는 헤더의 사용자 id 를 그대로 세션으로 본다
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  return id === null ? null : { user: { id } };
};

describe.skipIf(!dbAvailable())("취소 경로 이관(S0-5.1)", () => {
  let handle: TestDb;
  // 동시 2건이 실제로 DB 에서 부딪치도록 연결을 넉넉히 연 풀
  let wide: TestDb;
  let pgStore: ReturnType<typeof createFakePaymentGatewayStore>;
  let sender: FakeNotificationSender;

  beforeAll(() => {
    handle = openTestDb();
    wide = openTestDb({ poolMax: 8 });
  });
  afterAll(async () => {
    await closeTestDb(wide);
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    pgStore = createFakePaymentGatewayStore();
    sender = new FakeNotificationSender();
  });

  function deps(overrides: { gateway?: FakePaymentGateway; db?: TestDb } = {}): CancellationDeps {
    return {
      db: (overrides.db ?? handle).db,
      getSession: fakeSession,
      clock: systemClock,
      paymentGateway: overrides.gateway ?? new FakePaymentGateway({ store: pgStore }),
      notificationSender: sender,
    };
  }

  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  function post(path: string, authUserId: string | null, body?: unknown, headers: Record<string, string> = {}) {
    return new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(authUserId === null ? {} : { [TEST_USER_HEADER]: authUserId }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const account = { refundAccount: { bankCode: "004", accountNumber: "12345678901234", holderName: "취소 시험 회원" } };
  const q = async <T>(text: string, params: unknown[]) => (await handle.pool.query(text, params)).rows as T[];

  async function counts(chain: CancellationChain) {
    const [row] = await q<Record<string, number | string>>(
      `SELECT (SELECT count(*)::int FROM refunds WHERE reservation_id = $1) AS refunds,
              (SELECT count(*)::int FROM refund_events e JOIN refunds r ON r.id = e.refund_id WHERE r.reservation_id = $1) AS events,
              (SELECT confirmed_count FROM seat_pools WHERE id = $2) AS confirmed,
              (SELECT held_count FROM seat_pools WHERE id = $2) AS held,
              (SELECT status FROM reservations WHERE id = $1) AS reservation,
              (SELECT status FROM orders WHERE id = $3) AS "order",
              (SELECT count(*)::int FROM calendar_entries WHERE reservation_id = $1) AS calendar,
              (SELECT count(*)::int FROM notifications WHERE reservation_id = $1) AS notifications`,
      [chain.reservationId, chain.seatPoolId, chain.orderId],
    );
    return row;
  }

  // ── 수용 ① ──
  test("같은 예약 취소 2건 동시 → 환불 1회(같은 원인), 둘 다 200, 하나는 재생", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });
    const route = createCancelReservationRoute(deps({ gateway, db: wide }));

    const responses = await Promise.all([
      route(post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account), ctx(chain.reservationId)),
      route(post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account), ctx(chain.reservationId)),
    ]);
    const bodies = await Promise.all(responses.map(async (r) => cancelReservationResponseSchema.parse(await r.json())));

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies.map((b) => b.replayed).sort()).toEqual([false, true]);
    // 두 응답이 같은 환불 행을 가리킨다
    expect(new Set(bodies.map((b) => b.refundId)).size).toBe(1);
    // PG 환불 호출도 1번, DB 환불 행도 1개, 자리는 정확히 1개만 돌아왔다
    expect(gateway.refundCalls()).toHaveLength(1);
    const after = await counts(chain);
    expect(after).toMatchObject({ refunds: 1, confirmed: 0, reservation: "cancelled", order: "refunded" });
  });

  test("성공 경로 — 예약 cancelled · 주문 refunded · 자리 −1 · 캘린더 삭제 · 감사 3행 · 알림 기록 뒤 발송", async () => {
    const chain = await insertCancellationChain(handle.pool, { startsInHours: 72, amount: 50000 });
    const res = await createCancelReservationRoute(deps())(
      post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account),
      ctx(chain.reservationId),
    );
    expect(res.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      status: "succeeded",
      requestedAmount: 50000,
      refundedAmount: 50000,
      refundRateBp: 10000,
      reservationStatus: "cancelled",
      slotRestored: true,
      replayed: false,
      failureCode: null,
    });
    expect(await counts(chain)).toMatchObject({
      refunds: 1,
      events: 3,
      confirmed: 0,
      reservation: "cancelled",
      order: "refunded",
      calendar: 0,
      notifications: 1,
    });
    const [reservation] = await q<{ cancel_reason: string }>("SELECT cancel_reason FROM reservations WHERE id = $1", [chain.reservationId]);
    expect(reservation?.cancel_reason).toBe("member_request");
    const orderEvents = await q<{ from_status: string; to_status: string }>(
      "SELECT from_status, to_status FROM order_events WHERE order_id = $1",
      [chain.orderId],
    );
    expect(orderEvents).toEqual([{ from_status: "paid", to_status: "refunded" }]);
    // 발송은 커밋 뒤 1번, 기록한 알림 id 그대로
    const [notification] = await q<{ id: string; kind: string }>("SELECT id, kind FROM notifications WHERE reservation_id = $1", [
      chain.reservationId,
    ]);
    expect(notification?.kind).toBe("reservation_cancelled");
    expect(sender.deliveredIds()).toEqual([notification?.id]);
  });

  test("다시 부르면 200 재생 — 환불·PG 호출은 그대로 1회", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });
    const route = createCancelReservationRoute(deps({ gateway }));
    const first = cancelReservationResponseSchema.parse(
      await (await route(post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account), ctx(chain.reservationId))).json(),
    );
    const again = await route(post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account), ctx(chain.reservationId));
    expect(again.status).toBe(200);
    const second = cancelReservationResponseSchema.parse(await again.json());
    expect(second).toMatchObject({ refundId: first.refundId, replayed: true, reservationStatus: "cancelled", slotRestored: false });
    expect(gateway.refundCalls()).toHaveLength(1);
    expect((await counts(chain)).refunds).toBe(1);
  });

  test("가상계좌 환불이 pending 이어도 자리는 돌아오고 refund_pending 알림이 더해진다", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore, forcePending: true });
    const res = await createCancelReservationRoute(deps({ gateway }))(
      post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account),
      ctx(chain.reservationId),
    );
    const body = cancelReservationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "pending", refundedAmount: 0, slotRestored: true, reservationStatus: "cancelled" });
    expect(await counts(chain)).toMatchObject({ confirmed: 0, notifications: 2 });
  });

  test("PG 실패 → 200 + failed, 예약·자리는 그대로", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore, failOn: [chain.gatewayPaymentId] });
    const res = await createCancelReservationRoute(deps({ gateway }))(
      post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, account),
      ctx(chain.reservationId),
    );
    expect(res.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await res.json());
    expect(body.status).toBe("failed");
    expect(body.failureCode).not.toBeNull();
    expect(body.reservationStatus).toBe("confirmed");
    expect(await counts(chain)).toMatchObject({ confirmed: 1, reservation: "confirmed", order: "paid", calendar: 1 });
  });

  test("카드 결제 → 미지원으로 failed(계약 05 「카드 → 미지원 → failed」)", async () => {
    const chain = await insertCancellationChain(handle.pool, { method: "card" });
    const res = await createCancelReservationRoute(deps())(
      post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId),
      ctx(chain.reservationId),
    );
    expect(res.status).toBe(200);
    expect(cancelReservationResponseSchema.parse(await res.json())).toMatchObject({
      status: "failed",
      failureCode: "UNSUPPORTED_PAYMENT_METHOD",
      reservationStatus: "confirmed",
    });
  });

  test("거부 — 남의 예약 403 · 없는 예약 404 · 모양 틀린 id 404 · 세션 없음 401 · 시작 뒤 409 · 입금 전 409 USE_ORDER_CANCEL", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const other = await insertMember(handle.pool);
    const started = await insertCancellationChain(handle.pool, { startsInHours: -1 });
    const held = await insertCancellationChain(handle.pool, { stage: "pending" });
    const route = createCancelReservationRoute(deps());
    const call = async (id: string, who: string | null) => {
      const res = await route(post(`/api/reservations/${id}/cancel`, who), ctx(id));
      return { status: res.status, code: ((await res.json()) as { code?: string }).code };
    };
    expect(await call(chain.reservationId, other.authUserId)).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(await call("0199d6c4-0000-7000-8000-000000000000", chain.authUserId)).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(await call("not-a-uuid", chain.authUserId)).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(await call(chain.reservationId, null)).toEqual({ status: 401, code: "UNAUTHENTICATED" });
    expect(await call(started.reservationId, started.authUserId)).toEqual({ status: 409, code: "CLASS_ALREADY_STARTED" });
    expect(await call(held.reservationId, held.authUserId)).toEqual({ status: 409, code: "USE_ORDER_CANCEL" });
    // 거부된 요청은 아무것도 쓰지 않았다
    expect((await counts(chain)).refunds).toBe(0);
  });

  test("가상계좌라고 말하고 계좌를 안 보내면 422 · JSON 이 아니면 400", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const route = createCancelReservationRoute(deps());
    const missing = await route(post(`/api/reservations/${chain.reservationId}/cancel`, chain.authUserId, { method: "virtual_account" }), ctx(chain.reservationId));
    expect(missing.status).toBe(422);
    const broken = new Request(`${BASE}/api/reservations/${chain.reservationId}/cancel`, {
      method: "POST",
      headers: { [TEST_USER_HEADER]: chain.authUserId },
      body: "{oops",
    });
    expect((await route(broken, ctx(chain.reservationId))).status).toBe(400);
  });

  test("미리보기 — 쓰지 않고 금액·결제수단·취소 가능 여부를 돌려준다", async () => {
    const chain = await insertCancellationChain(handle.pool, { startsInHours: 10, amount: 40000, tiers: [{ hours_before_start: 12, refund_rate_bp: 5000 }] });
    const res = await createCancellationPreviewRoute(deps())(
      new Request(`${BASE}/api/reservations/${chain.reservationId}/cancellation-preview`, { headers: { [TEST_USER_HEADER]: chain.authUserId } }),
      ctx(chain.reservationId),
    );
    expect(res.status).toBe(200);
    expect(cancellationPreviewResponseSchema.parse(await res.json())).toMatchObject({
      paymentMethod: "virtual_account",
      paidAmount: 40000,
      refundAmount: 20000,
      refundRateBp: 5000,
      appliedTierHours: 12,
      cancellable: true,
      reasonCode: null,
    });
    expect(await counts(chain)).toMatchObject({ refunds: 0, confirmed: 1, reservation: "confirmed" });
  });

  test("주문 셀프 취소 — 입금 전 주문 cancelled · held −1 · 결제 cancelled, 다시 불러도 200 같은 본문, 입금 뒤는 409", async () => {
    const pending = await insertCancellationChain(handle.pool, { stage: "pending" });
    const gateway = new FakePaymentGateway({ store: pgStore });
    const route = createCancelOrderRoute(deps({ gateway }));
    const orderCtx = (orderId: string) => ({ params: Promise.resolve({ orderId }) });

    const first = await route(post(`/api/orders/${pending.orderId}/cancel`, pending.authUserId), orderCtx(pending.orderId));
    expect(first.status).toBe(200);
    expect(cancelOrderResponseSchema.parse(await first.json())).toEqual({ orderId: pending.orderId, status: "cancelled" });
    expect(await counts(pending)).toMatchObject({ held: 0, reservation: "cancelled", order: "cancelled", refunds: 0 });
    const [payment] = await q<{ status: string }>("SELECT status FROM payments WHERE id = $1", [pending.paymentId]);
    expect(payment?.status).toBe("cancelled");

    const again = await route(post(`/api/orders/${pending.orderId}/cancel`, pending.authUserId), orderCtx(pending.orderId));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ orderId: pending.orderId, status: "cancelled" });
    expect((await counts(pending)).held).toBe(0);

    const paid = await insertCancellationChain(handle.pool);
    const refused = await route(post(`/api/orders/${paid.orderId}/cancel`, paid.authUserId), orderCtx(paid.orderId));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ORDER_NOT_CANCELLABLE");
    const stranger = await route(post(`/api/orders/${paid.orderId}/cancel`, pending.authUserId), orderCtx(paid.orderId));
    expect(stranger.status).toBe(403);
  });
});
