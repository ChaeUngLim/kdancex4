// S0-2.4(DB 제약 테스트) — CHECK·유니크·부분 유니크가 실제 PostgreSQL 에서 막는지 확인한다.
// 앱 코드가 실수해도 DB 가 마지막으로 막아 준다는 것을 「잘못된 값을 직접 넣어 보는」 방식으로 증명한다.
// 확인하는 것:
//   ① CHECK  — 정원 초과·음수 금액·주문 금액 식·수수료율 범위·환불 금액 순서·결제수단 값 집합
//   ② 유니크 — 회원 본인확인 해시·주문 멱등키·자리 묶음·환불 멱등키가 같은 값을 두 번 못 넣는다
//   ③ 부분 유니크 — 살아 있는 결제·살아 있는 예약·살아 있는 환불은 하나뿐이고, 끝난 행은 여러 개 남을 수 있다
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 한 사슬(학원·수업·신청 단위·회원·주문·자리 묶음·예약·결제)의 id 모음. 테스트가 이 부모에 자식 행을 더 넣는다.
type Chain = {
  reservationId: string;
  paymentId: string;
  orderId: string;
  memberId: string;
  offeringId: string;
  seatPoolId: string;
};

describe.skipIf(!dbAvailable())("DB 제약(CHECK·유니크·부분 유니크)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 제약 위반이면 PostgreSQL 이 돌려주는 오류의 constraint 칸에 제약 이름이 담긴다.
  // 이름 뒤에는 8자리 해시가 붙으므로(data-model §0) 「포함하는지」로 비교한다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 부모 사슬을 만들고 그 id 들을 돌려준다.
  async function makeChain(): Promise<Chain> {
    const { reservationId, paymentId } = await insertReservationAndPayment(handle.pool);
    const { rows } = await q(
      "SELECT order_id, member_id, offering_id, seat_pool_id FROM reservations WHERE id = $1",
      [reservationId],
    );
    const r = rows[0];
    return {
      reservationId,
      paymentId,
      orderId: r.order_id,
      memberId: r.member_id,
      offeringId: r.offering_id,
      seatPoolId: r.seat_pool_id,
    };
  }

  // 회원 한 명을 더 만든다(본인확인 해시·로그인 id 는 인자로 받아 중복 시험에 쓴다).
  function insertMember(id: string, authUserId: string, ciHash: string) {
    return q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '다른 회원', 'female', '1992-02-02', '010-1111-1111', $3, '시험 닉네임', now(), now())`,
      [id, authUserId, ciHash],
    );
  }

  // 주문 하나를 넣는다. 금액 식(total = max(0, 정가-할인-쿠폰) + 예매수수료)을 지키는 값이 기본값이고, 바꿀 칸만 덮어쓴다.
  function insertOrder(chain: Chain, over: Partial<Record<string, unknown>> = {}) {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      list_price_amount: 120000,
      benefit_discount_amount: 0,
      coupon_discount_amount: 0,
      total_amount: 120000,
      booking_fee_amount: 0,
      platform_fee_rate_bp: 0,
      cancel_fee_platform_share_bp: 5000,
      idempotency_key: `idem-${randomUUID()}`,
      ...over,
    };
    return q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, benefit_discount_amount,
                           coupon_discount_amount, total_amount, booking_fee_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version,
                           merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                           idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       SELECT $1, $2, $3, 'pending', $4, $5, $6, $7, $8, '{}'::jsonb,
              o.refund_notice_version_id, 'v1', 'v1', 'v1', $9, $10, $11, now(), ${orderSnapshotValuesSql("$3")}
         FROM orders o WHERE o.id = $12`,
      [
        row.id,
        chain.memberId,
        chain.offeringId,
        row.list_price_amount,
        row.benefit_discount_amount,
        row.coupon_discount_amount,
        row.total_amount,
        row.booking_fee_amount,
        row.platform_fee_rate_bp,
        row.cancel_fee_platform_share_bp,
        row.idempotency_key,
        chain.orderId,
      ],
    );
  }

  function insertPayment(orderId: string, status: string, method = "card") {
    return q(
      `INSERT INTO payments (id, order_id, method, amount, gateway_payment_id, status, due_at, updated_at)
       VALUES ($1, $2, $3, 120000, $4, $5, now(), now())`,
      [randomUUID(), orderId, method, `gw-${randomUUID()}`, status],
    );
  }

  function insertReservation(chain: Chain, status: string, cancelReason: string | null = null) {
    return q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, cancel_reason, updated_at)
       VALUES ($1, $2, $3, $4, 'male', $5, $6, $7, now())`,
      [randomUUID(), chain.orderId, chain.offeringId, chain.seatPoolId, chain.memberId, status, cancelReason],
    );
  }

  function insertRefund(chain: Chain, over: { status?: string; requested?: number; refunded?: number; rateBp?: number; idem?: string } = {}) {
    return q(
      `INSERT INTO refunds (id, reservation_id, payment_id, idempotency_key, requested_amount, refunded_amount,
                            refund_rate_bp, status, reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'member_request', now())`,
      [
        randomUUID(),
        chain.reservationId,
        chain.paymentId,
        over.idem ?? `idem-${randomUUID()}`,
        over.requested ?? 10000,
        over.refunded ?? 0,
        over.rateBp ?? 10000,
        over.status ?? "pending",
      ],
    );
  }

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  describe("CHECK", () => {
    test("자리 묶음의 확정 인원이 정원을 넘으면 거부된다(FR-091 최후 방어선)", async () => {
      const c = await makeChain();
      // 정원 6 에 held 3 + confirmed 4 = 7
      await expectViolation(
        q("UPDATE seat_pools SET held_count = 3, confirmed_count = 4 WHERE id = $1", [c.seatPoolId]),
        "ck_seat_pools_not_over",
      );
      // 정원 안(3 + 3 = 6)이면 통과한다
      await q("UPDATE seat_pools SET held_count = 3, confirmed_count = 3 WHERE id = $1", [c.seatPoolId]);
    });

    test("자리 묶음의 정원은 0 이하이거나 인원이 음수이면 거부된다", async () => {
      const c = await makeChain();
      await expectViolation(q("UPDATE seat_pools SET capacity = 0 WHERE id = $1", [c.seatPoolId]), "ck_seat_pools_capacity_positive");
      await expectViolation(q("UPDATE seat_pools SET held_count = -1 WHERE id = $1", [c.seatPoolId]), "ck_seat_pools_held_nonneg");
    });

    test("주문 금액 식이 틀리면 거부되고, 할인이 정가를 넘으면 0원 + 예매 수수료로 맞아야 통과한다", async () => {
      const c = await makeChain();
      // 정가 120000 인데 합계가 100000 — 식 위반
      await expectViolation(insertOrder(c, { total_amount: 100000 }), "ck_orders_total_formula");
      // 할인 150000 > 정가 120000 → 0원(GREATEST) + 수수료 2000 = 2000 이어야 한다. 음수 합계(-28000+2000)는 안 된다
      await expectViolation(
        insertOrder(c, { benefit_discount_amount: 150000, total_amount: -26000, booking_fee_amount: 2000 }),
        "ck_orders",
      );
      await insertOrder(c, { benefit_discount_amount: 150000, total_amount: 2000, booking_fee_amount: 2000 });
    });

    test("주문의 금액 칸이 음수이면 거부된다", async () => {
      const c = await makeChain();
      await expectViolation(insertOrder(c, { list_price_amount: -1, total_amount: 0 }), "ck_orders_list_price_nonneg");
      await expectViolation(insertOrder(c, { booking_fee_amount: -1, total_amount: 119999 }), "ck_orders_booking_fee_nonneg");
    });

    test("주문 수수료율이 0~10000bp 를 벗어나면 거부된다", async () => {
      const c = await makeChain();
      await expectViolation(insertOrder(c, { platform_fee_rate_bp: 10001 }), "ck_orders_fee_rates");
      await expectViolation(insertOrder(c, { cancel_fee_platform_share_bp: -1 }), "ck_orders_fee_rates");
      await insertOrder(c, { platform_fee_rate_bp: 10000, cancel_fee_platform_share_bp: 0 });
    });

    test("결제수단은 4종 값 안에서만 들어간다", async () => {
      const c = await makeChain();
      await insertPayment(c.orderId, "expired", "virtual_account");
      await expectViolation(insertPayment(c.orderId, "expired", "bitcoin"), "payments_method_check");
    });

    test("환불 금액 순서와 비율 범위가 어긋나면 거부된다", async () => {
      const c = await makeChain();
      // 환불된 금액이 요청 금액보다 크다
      await expectViolation(insertRefund(c, { requested: 1000, refunded: 2000, status: "failed" }), "ck_refunds_amount_order");
      await expectViolation(insertRefund(c, { rateBp: 10001, status: "failed" }), "ck_refunds_refund_rate_bp");
    });

    test("취소 사유는 취소된 예약에만 둘 수 있다", async () => {
      const c = await makeChain();
      await expectViolation(insertReservation(c, "expired", "member_request"), "ck_reservations_cancel_reason");
    });

    test("수업 시간 순서와 신청 단위 기간 순서가 거꾸로이면 거부된다", async () => {
      const c = await makeChain();
      await expectViolation(
        q(
          `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
           VALUES ($1, $2, 1, now() + interval '2 days', now() + interval '1 day')`,
          [randomUUID(), c.offeringId],
        ),
        "ck_class_sessions_time_order",
      );
      await expectViolation(
        q("UPDATE class_offerings SET last_session_ends_at = first_session_starts_at WHERE id = $1", [c.offeringId]),
        "ck_class_offerings_period_order",
      );
    });
  });

  describe("유니크", () => {
    test("같은 본인확인 해시·같은 로그인 id 로 회원을 둘 못 만든다(FR-003)", async () => {
      const c = await makeChain();
      const { rows } = await q("SELECT auth_user_id, identity_ci_hash FROM members WHERE id = $1", [c.memberId]);
      await expectViolation(insertMember(randomUUID(), `auth-${randomUUID()}`, rows[0].identity_ci_hash), "uq_members_identity_ci_hash");
      await expectViolation(insertMember(randomUUID(), rows[0].auth_user_id, `ci-${randomUUID()}`), "uq_members_auth_user_id");
      await insertMember(randomUUID(), `auth-${randomUUID()}`, `ci-${randomUUID()}`);
    });

    test("한 회원의 같은 멱등키로 주문을 둘 못 만든다", async () => {
      const c = await makeChain();
      await insertOrder(c, { idempotency_key: "same-key" });
      await expectViolation(insertOrder(c, { idempotency_key: "same-key" }), "uq_orders_member_idempotency");
    });

    test("한 신청 단위에 같은 자리 구분의 자리 묶음을 둘 못 만든다", async () => {
      const c = await makeChain();
      await expectViolation(
        q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at) VALUES ($1, $2, 'male', 3, now())", [randomUUID(), c.offeringId]),
        "uq_seat_pools_offering_kind",
      );
      await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at) VALUES ($1, $2, 'female', 3, now())", [randomUUID(), c.offeringId]);
    });

    test("환불 멱등키와 PG 결제 id 는 중복되지 않는다", async () => {
      const c = await makeChain();
      await insertRefund(c, { status: "failed", idem: "refund-key" });
      await expectViolation(insertRefund(c, { status: "failed", idem: "refund-key" }), "uq_refunds_idempotency_key");
      const { rows } = await q("SELECT gateway_payment_id FROM payments WHERE id = $1", [c.paymentId]);
      await expectViolation(
        q(
          `INSERT INTO payments (id, order_id, method, amount, gateway_payment_id, status, due_at, updated_at)
           VALUES ($1, $2, 'card', 1, $3, 'expired', now(), now())`,
          [randomUUID(), c.orderId, rows[0].gateway_payment_id],
        ),
        "uq_payments_gateway_payment_id",
      );
    });
  });

  describe("부분 유니크", () => {
    test("주문 하나에 살아 있는(ready·paid) 결제는 하나뿐이고, 끝난 결제는 여러 개 남을 수 있다", async () => {
      const c = await makeChain(); // 이미 paid 결제 1건이 있다
      await expectViolation(insertPayment(c.orderId, "paid"), "uq_payments_order_live");
      await expectViolation(insertPayment(c.orderId, "ready"), "uq_payments_order_live");
      // 부분 인덱스 바깥(expired·cancelled)은 몇 개든 들어간다
      await insertPayment(c.orderId, "expired");
      await insertPayment(c.orderId, "cancelled");
    });

    test("한 회원이 같은 신청 단위에 살아 있는(held·confirmed) 예약을 둘 못 가진다", async () => {
      const c = await makeChain(); // 이미 confirmed 예약 1건이 있다
      await expectViolation(insertReservation(c, "held"), "uq_reservations_member_offering_active");
      await expectViolation(insertReservation(c, "confirmed"), "uq_reservations_member_offering_active");
      await insertReservation(c, "cancelled", "member_request");
      await insertReservation(c, "expired");
    });

    test("예약 하나에 살아 있는 환불(failed 가 아닌 것)은 하나뿐이다 — 이중 환불 방지", async () => {
      const c = await makeChain();
      await insertRefund(c, { status: "pending" });
      await expectViolation(insertRefund(c, { status: "pending" }), "uq_refunds_reservation_id_active");
      await expectViolation(insertRefund(c, { status: "succeeded" }), "uq_refunds_reservation_id_active");
      // 실패한 환불은 부분 인덱스 밖이라 다시 시도할 수 있다
      await insertRefund(c, { status: "failed" });
      await insertRefund(c, { status: "failed" });
    });

    test("살아 있던 예약이 취소되면 같은 회원이 다시 신청할 수 있다", async () => {
      const c = await makeChain();
      await q("UPDATE reservations SET status = 'cancelled', cancel_reason = 'member_request', cancelled_at = now() WHERE id = $1", [c.reservationId]);
      await insertReservation(c, "held");
    });
  });
});
