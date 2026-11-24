// 전체 데이터 계약(S0-2.1) 이후 스파이크 테스트가 쓰는 「부모 행」 최소 픽스처.
//
// 왜 필요한가: 골격 계약 때는 seat_pools·refunds 가 아무 데도 걸려 있지 않아 한 줄로 넣을 수 있었다.
// 전체 계약에서는 자리 묶음이 신청 단위(class_offerings)에, 환불이 예약·결제에 FK 로 걸린다.
// 그래서 테스트가 필요한 만큼의 부모 행만 raw SQL 로 만들어 준다(전체 시드는 S0-2.5(시드를 테스트 픽스처로)가 맡는다).
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "./academy-seller";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "../../lib/server/order-snapshot";

/** 학원 → 수업 → 신청 단위(offering) 한 줄 사슬을 만들고 offering id 를 돌려준다. */
export async function insertOffering(pool: Pool): Promise<{ academyId: string; offeringId: string }> {
  const academyId = randomUUID();
  const classId = randomUUID();
  const offeringId = randomUUID();
  await pool.query(
    `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
     VALUES ($1, '테스트 학원', '서울', '강남구', now(), ${ACADEMY_SELLER_VALUES})`,
    [academyId],
  );
  await pool.query(
    `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
     VALUES ($1, $2, '테스트 수업', '테스트 강사', 'salsa_bachata', 'regular', 'gender_split', now())`,
    [classId, academyId],
  );
  await pool.query(
    `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount,
                                  first_session_starts_at, last_session_ends_at, status, updated_at)
     VALUES ($1, $2, '테스트 기간', 'term', 120000,
             now() + interval '7 days', now() + interval '35 days', 'open', now())`,
    [offeringId, classId],
  );
  return { academyId, offeringId };
}

/** 환불이 매달릴 예약·결제까지(회원·주문·자리 묶음 포함) 한 사슬을 만든다. */
export async function insertReservationAndPayment(
  pool: Pool,
): Promise<{ reservationId: string; paymentId: string }> {
  const { academyId, offeringId } = await insertOffering(pool);
  const memberId = randomUUID();
  const noticeId = randomUUID();
  const orderId = randomUUID();
  const seatPoolId = randomUUID();
  const reservationId = randomUUID();
  const paymentId = randomUUID();
  await pool.query(
    `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname,
                          signup_notice_ack_at, updated_at)
     VALUES ($1, $2, '테스트 회원', 'male', '1990-01-01', '010-0000-0000', $3, '시험 닉네임', now(), now())`,
    [memberId, `auth-${memberId}`, `ci-${memberId}`],
  );
  await pool.query(`INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES ($1, $2, 1, '공지')`, [
    noticeId,
    academyId,
  ]);
  await pool.query(
    `INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at) VALUES ($1, $2, 'male', 6, now())`,
    [seatPoolId, offeringId],
  );
  // 주문 스냅샷의 회차 수(ck_orders_session_count ≥ 1, S3-3.2)를 채우려면 신청 단위에 예정 회차가 하나는 있어야 한다.
  await pool.query(
    `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
     VALUES ($1, $2, 1, now() + interval '7 days', now() + interval '7 days 2 hours')`,
    [randomUUID(), offeringId],
  );
  // 금액 식(ck_orders_total_formula)을 지키는 값: 120000 - 0 - 0 + 0 = 120000
  await pool.query(
    `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                         refund_notice_version_id, intermediary_notice_version, member_terms_version,
                         merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                         idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
     VALUES ($1, $2, $3, 'paid', 120000, 120000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 0, 5000, $5, now(), ${orderSnapshotValuesSql("$3")})`,
    [orderId, memberId, offeringId, noticeId, `idem-${orderId}`],
  );
  await pool.query(
    `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
     VALUES ($1, $2, $3, $4, 'male', $5, 'confirmed', now())`,
    [reservationId, orderId, offeringId, seatPoolId, memberId],
  );
  await pool.query(
    `INSERT INTO payments (id, order_id, method, amount, gateway_payment_id, status, due_at, updated_at)
     VALUES ($1, $2, 'card', 120000, $3, 'paid', now(), now())`,
    [paymentId, orderId, `gw-${paymentId}`],
  );
  return { reservationId, paymentId };
}
