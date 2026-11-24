// S0-5.3(옛 취소 9시나리오 이식) — 옛 `backend/tests/test_cancel_api.py` 의 DB 통합 시나리오 9개를
// 새 Next.js 취소 경로(`POST /api/reservations/{id}/cancel`)에 그대로 옮겼다. 시나리오 하나 = 테스트 하나다.
//   계약: _workspace/03_contracts/05-cancellation-migrated.md
//   (로드맵 verify 의 파일 이름 `tests/db/s0-5-3.db.test.ts` 를 기능 이름
//    `tests/migrated/cancel-api-scenarios.db.test.ts` 로 바꿨다 — method 가 「tests/migrated/ 에 둔다」고 정했다)
//
// 옛 테스트가 여기서 지키려던 것은 두 가지다.
//   ① 트랜잭션 경계 — 환불 행·예약 상태·정원·감사 기록이 한 덩어리로 바뀌는가, PG 가 실패하면 아무것도 안 바뀌는가
//   ② 행 잠금 — 같은 예약 취소가 동시에 2건 와도 환불이 1회만 나가는가
// 그래서 각 시나리오는 응답만 보지 않고 DB 에 남은 것(환불 행·감사 기록·자리 수)까지 함께 본다.
//
// 옛 → 새에서 뜻이 바뀐 곳(테스트 이름 끝 [옛 …] 과 대응표 migration-map.md 에 적었다):
//   - 옛 `reserved_count`(회차의 예약 수) → 새 `seat_pools.confirmed_count`(자리 묶음의 확정 수)
//   - 옛 소문자 오류 코드 → 새 §4.8 대문자 코드(`CLASS_ALREADY_STARTED` 등)
//   - 옛 X-User-Id 헤더 → 새 세션(여기서는 시험용 세션 읽기)
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { FakeNotificationSender } from "../../lib/server/fakes/fake-notification-sender";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "../../lib/server/fakes/fake-payment-gateway";
import type { SessionReader } from "../../lib/server/guards";
import { cancelReservationResponseSchema } from "../../lib/server/schemas/cancellation";
import { REFUND_EVENT_TYPES, createCancelReservationRoute, type CancellationDeps } from "../../lib/server/services/cancellation";
import { systemClock } from "../../lib/domain/time";
import { insertCancellationChain, insertMember, type CancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const BASE = "http://localhost";
// 시험용 세션 읽기 — 헤더에 적힌 사용자 id 를 그대로 로그인한 사람으로 본다(가드 자체는 staff-guards 테스트가 본다)
const TEST_USER_HEADER = "x-test-auth-user";
const fakeSession: SessionReader = async (headers) => {
  const id = headers.get(TEST_USER_HEADER);
  return id === null ? null : { user: { id } };
};

// 옛 refund_account_payload() 와 같은 역할 — 가상계좌 환불에 쓰는 회원 계좌
const REFUND_ACCOUNT = { bankCode: "004", accountNumber: "12345678901234", holderName: "취소 시험 회원" } as const;
const CANCEL_BODY = { refundAccount: REFUND_ACCOUNT };
// PG 실패 시나리오에서 실패 사유가 응답과 DB 에 그대로 남는지 보려고 일부러 정한 값
const FAILURE = { code: "PG_REFUND_REJECTED", message: "PG 가 환불을 거절했어요(시험)" } as const;
const UNKNOWN_RESERVATION_ID = "0199d6c4-0000-7000-8000-000000000000";

describe.skipIf(!dbAvailable())("옛 취소 API 9시나리오(S0-5.3, 옛 test_cancel_api.py)", () => {
  let handle: TestDb;
  // 동시 시나리오 전용 — 두 요청이 서로 다른 DB 연결을 잡아 실제로 잠금에서 부딪치게 연결을 넉넉히 연다
  let wide: TestDb;
  let pgStore: ReturnType<typeof createFakePaymentGatewayStore>;

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
  });

  // 시나리오마다 가짜 PG 를 새로 만들어 호출 수를 따로 센다(옛 payment_gateway.calls 와 같다)
  function routeWith(gateway: FakePaymentGateway, db: TestDb = handle) {
    const deps: CancellationDeps = {
      db: db.db,
      getSession: fakeSession,
      clock: systemClock,
      paymentGateway: gateway,
      notificationSender: new FakeNotificationSender(),
    };
    return createCancelReservationRoute(deps);
  }

  async function cancel(route: ReturnType<typeof routeWith>, reservationId: string, authUserId: string) {
    const request = new Request(`${BASE}/api/reservations/${reservationId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", [TEST_USER_HEADER]: authUserId },
      body: JSON.stringify(CANCEL_BODY),
    });
    return route(request, { params: Promise.resolve({ id: reservationId }) });
  }

  const rows = async <T>(text: string, params: unknown[]) => (await handle.pool.query(text, params)).rows as T[];

  // 응답이 아니라 DB 가 말하는 상태. 응답만 보면 「계산은 맞았지만 커밋되지 않은」 경우를 못 잡는다.
  async function dbState(chain: CancellationChain) {
    const refunds = await rows<{ id: string; status: string; refunded_amount: number; failure_code: string | null; failure_message: string | null; holder: string | null }>(
      `SELECT id, status, refunded_amount, failure_code, failure_message, refund_account_holder_name AS holder
         FROM refunds WHERE reservation_id = $1`,
      [chain.reservationId],
    );
    const [reservation] = await rows<{ status: string; cancelled_at: Date | null }>(
      "SELECT status, cancelled_at FROM reservations WHERE id = $1",
      [chain.reservationId],
    );
    const [pool] = await rows<{ confirmed: number }>("SELECT confirmed_count AS confirmed FROM seat_pools WHERE id = $1", [chain.seatPoolId]);
    return { refunds, reservation, confirmed: pool?.confirmed };
  }

  // 감사 기록은 집합으로만 본다 — 같은 트랜잭션 안의 행은 created_at 이 같아 순서로 보면 깜빡인다(옛 주석 그대로)
  async function eventTypes(refundId: string) {
    const events = await rows<{ event_type: string }>("SELECT event_type FROM refund_events WHERE refund_id = $1", [refundId]);
    return new Set(events.map((e) => e.event_type));
  }

  // ── 정상 취소 ──

  test("정상 취소 — 200 + 전액 환불 + 자리 반납, 감사 3종, PG 1회 [옛 test_cancel_succeeds_and_restores_slot]", async () => {
    // 시작 72시간 전 — 24시간 이상 남았으면 학원 비율표와 무관하게 100%(10000bp)다
    const chain = await insertCancellationChain(handle.pool, { startsInHours: 72, amount: 50000 });
    const gateway = new FakePaymentGateway({ store: pgStore });

    const res = await cancel(routeWith(gateway), chain.reservationId, chain.authUserId);

    expect(res.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      status: "succeeded",
      replayed: false,
      slotRestored: true,
      reservationStatus: "cancelled",
      refundRateBp: 10000,
      requestedAmount: 50000,
      refundedAmount: 50000,
      failureCode: null,
    });
    const state = await dbState(chain);
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({ status: "succeeded", refunded_amount: 50000, holder: REFUND_ACCOUNT.holderName });
    expect(state.reservation?.status).toBe("cancelled");
    expect(state.reservation?.cancelled_at).not.toBeNull();
    // 자리 반납 — 확정 수가 1 줄었다(이 예약 하나가 쥐고 있던 자리)
    expect(state.confirmed).toBe(0);
    expect(await eventTypes(state.refunds[0]!.id)).toEqual(
      new Set([REFUND_EVENT_TYPES.requested, REFUND_EVENT_TYPES.gatewaySucceeded, REFUND_EVENT_TYPES.reservationCancelled]),
    );
    expect(gateway.refundCalls()).toHaveLength(1);
  });

  test("PG 가 pending 이어도 자리는 반납되고 예약은 취소 확정된다 [옛 test_cancel_with_pending_gateway_still_restores_slot]", async () => {
    // 가상계좌 환불은 회원 계좌로 따로 보내는 송금이라 바로 끝나지 않는다. 기다리는 동안 자리를 묶어 두면 아무도 못 쓴다
    const chain = await insertCancellationChain(handle.pool, { amount: 30000 });
    const gateway = new FakePaymentGateway({ store: pgStore, forcePending: true });

    const res = await cancel(routeWith(gateway), chain.reservationId, chain.authUserId);

    expect(res.status).toBe(200);
    expect(cancelReservationResponseSchema.parse(await res.json())).toMatchObject({
      status: "pending",
      refundedAmount: 0, // 아직 건너가지 않은 돈
      requestedAmount: 30000,
      slotRestored: true,
      reservationStatus: "cancelled",
    });
    expect((await dbState(chain)).confirmed).toBe(0);
  });

  // ── 거부되는 요청 — 403 / 404 / 409 ──

  test("남의 예약은 403 이고(404 로 감추지 않는다) 아무것도 쓰지 않는다 [옛 test_cancel_other_users_reservation_is_forbidden]", async () => {
    const chain = await insertCancellationChain(handle.pool);
    const intruder = await insertMember(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });

    const res = await cancel(routeWith(gateway), chain.reservationId, intruder.authUserId);

    expect(res.status).toBe(403);
    // 상태 코드만 보면 환불을 만들어 놓고 403 을 낸 경우를 못 잡는다 — 「아무것도 안 했다」까지 본다
    const state = await dbState(chain);
    expect(state.refunds).toEqual([]);
    expect(gateway.refundCalls()).toEqual([]);
    expect(state.confirmed).toBe(1);
  });

  test("없는 예약은 404 이고 PG 를 부르지 않는다 [옛 test_cancel_unknown_reservation_returns_404]", async () => {
    const someone = await insertMember(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });

    const res = await cancel(routeWith(gateway), UNKNOWN_RESERVATION_ID, someone.authUserId);

    expect(res.status).toBe(404);
    expect(gateway.refundCalls()).toEqual([]);
  });

  test("환불 기록 없이 이미 취소된 예약은 409 RESERVATION_ALREADY_CANCELLED [옛 test_cancel_already_cancelled_reservation_returns_409]", async () => {
    // 환불 기록이 있는 경우는 중복 요청이라 200 재생으로 간다(아래 멱등 시나리오). 여기는 환불 없이 취소된 예약이다
    const chain = await insertCancellationChain(handle.pool);
    await handle.pool.query(
      "UPDATE reservations SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'member_request' WHERE id = $1",
      [chain.reservationId],
    );
    await handle.pool.query("UPDATE seat_pools SET confirmed_count = 0 WHERE id = $1", [chain.seatPoolId]);
    const gateway = new FakePaymentGateway({ store: pgStore });

    const res = await cancel(routeWith(gateway), chain.reservationId, chain.authUserId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESERVATION_ALREADY_CANCELLED");
    expect(gateway.refundCalls()).toEqual([]);
    expect((await dbState(chain)).refunds).toEqual([]);
  });

  test("이미 시작한 수업은 409 CLASS_ALREADY_STARTED — 자리도 돈도 그대로 [옛 test_cancel_after_class_started_returns_409]", async () => {
    const chain = await insertCancellationChain(handle.pool, { startsInHours: -1 });
    const gateway = new FakePaymentGateway({ store: pgStore });

    const res = await cancel(routeWith(gateway), chain.reservationId, chain.authUserId);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("CLASS_ALREADY_STARTED");
    expect(gateway.refundCalls()).toEqual([]);
    expect((await dbState(chain)).confirmed).toBe(1);
  });

  // ── 멱등 — 중복 요청 ──

  test("두 번째 요청은 409 가 아니라 200 + 기존 결과 재생, 자리는 한 번만 반납 [옛 test_duplicate_cancel_request_is_replayed]", async () => {
    // Idempotency-Key 헤더를 일부러 보내지 않는다 — 헤더 없이도 서버가 같은 예약의 두 번째 취소를 알아보는지가 핵심이다
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });
    const route = routeWith(gateway);

    const first = await cancel(route, chain.reservationId, chain.authUserId);
    const second = await cancel(route, chain.reservationId, chain.authUserId);

    expect([first.status, second.status]).toEqual([200, 200]);
    const a = cancelReservationResponseSchema.parse(await first.json());
    const b = cancelReservationResponseSchema.parse(await second.json());
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.refundId).toBe(a.refundId); // 같은 환불 행으로 모인다
    expect(b.slotRestored).toBe(false); // 재생은 자리를 다시 반납하지 않았다고 말한다
    const state = await dbState(chain);
    expect(state.refunds).toHaveLength(1);
    // 진짜 단정 — 확정 수가 2 줄었다면(음수 막힘 포함) 이중 환불이 난 것이다
    expect(state.confirmed).toBe(0);
    // 재생이 PG 호출 앞에서 끊었다
    expect(gateway.refundCalls()).toHaveLength(1);
  });

  // ── PG 실패 ──

  test("PG 환불 실패 — 200 + failed, 사유는 응답과 DB 에 남고 예약·자리는 그대로 [옛 test_gateway_failure_records_reason_and_keeps_reservation]", async () => {
    // 환불이 실패했는데 자리까지 없애면 회원은 자리도 돈도 잃는다. 200 인 것도 의도다 — 요청은 처리됐고 결과가 실패다
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({
      store: pgStore,
      failOn: [chain.gatewayPaymentId],
      failureCode: FAILURE.code,
      failureMessage: FAILURE.message,
    });

    const res = await cancel(routeWith(gateway), chain.reservationId, chain.authUserId);

    expect(res.status).toBe(200);
    const body = cancelReservationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      status: "failed",
      failureCode: FAILURE.code,
      failureMessage: FAILURE.message,
      slotRestored: false,
      refundedAmount: 0,
    });
    expect(body.reservationStatus).not.toBe("cancelled");
    const state = await dbState(chain);
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0]).toMatchObject({ status: "failed", failure_code: FAILURE.code, failure_message: FAILURE.message });
    expect(await eventTypes(state.refunds[0]!.id)).toEqual(new Set([REFUND_EVENT_TYPES.requested, REFUND_EVENT_TYPES.gatewayFailed]));
    expect(state.reservation?.status).toBe("confirmed");
    expect(state.reservation?.cancelled_at).toBeNull();
    expect(state.confirmed).toBe(1);
  });

  // ── 동시 요청 ──

  test("같은 예약 취소 2건이 동시에 와도 환불은 1회 — 둘 다 200, 하나만 새로 만들고 하나만 자리 반납 [옛 test_concurrent_cancel_requests_refund_only_once]", async () => {
    // 옛 테스트는 스레드 2개 + Barrier 로 출발선을 맞췄다. 여기서는 Promise.all 로 두 요청을 동시에 띄우고,
    // 넉넉한 풀(wide)에서 서로 다른 연결을 잡게 해 행 잠금에서 실제로 부딪치게 한다.
    // 단정은 「경합이 났다」가 아니라 「어느 순서로 돌든 환불은 1건」이다 — 경합이 안 난 실행에서도 성립해야 한다.
    const chain = await insertCancellationChain(handle.pool);
    const gateway = new FakePaymentGateway({ store: pgStore });
    const route = routeWith(gateway, wide);

    const responses = await Promise.all([
      cancel(route, chain.reservationId, chain.authUserId),
      cancel(route, chain.reservationId, chain.authUserId),
    ]);
    const bodies = await Promise.all(responses.map(async (r) => cancelReservationResponseSchema.parse(await r.json())));

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(bodies[0]!.refundId).toBe(bodies[1]!.refundId);
    // 정확히 한쪽만 「내가 만들었다」고 말한다. 둘 다 false 면 환불이 없고, 둘 다 true 면 이중 환불이다
    expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
    expect(bodies.filter((b) => b.slotRestored)).toHaveLength(1);
    // 커밋된 상태를 다른 풀(handle)의 새 연결에서 확인한다
    const state = await dbState(chain);
    expect(state.refunds).toHaveLength(1);
    expect(state.confirmed).toBe(0);
    expect(state.reservation?.status).toBe("cancelled");
    expect(gateway.refundCalls()).toHaveLength(1);
  });
});
