// S0-5.1(취소 서비스·경로 이관) 테스트의 부모 행 픽스처 — 학원 → 수업 → 신청 단위 → 회차 → 자리 묶음 → 회원·주문·예약·결제.
// 취소 경로는 이 사슬 전부를 읽거나 고치므로(정원·캘린더·알림·주문 상태) 한 번에 만든다.
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "./academy-seller";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "../../lib/server/order-snapshot";

export interface CancellationChain {
  academyId: string;
  offeringId: string;
  sessionId: string;
  seatPoolId: string;
  memberId: string;
  authUserId: string;
  orderId: string;
  reservationId: string;
  paymentId: string;
  gatewayPaymentId: string;
}

export interface ChainOptions {
  /** 첫 회차가 지금부터 몇 시간 뒤인가(음수면 이미 시작) */
  startsInHours?: number;
  /** 주문·예약·결제 상태 묶음: paid(확정 예약) 또는 pending(입금 전 held 예약) */
  stage?: "paid" | "pending";
  method?: "virtual_account" | "card";
  amount?: number;
  /** academies.refund_policy_tiers — §4.4 */
  tiers?: readonly { hours_before_start: number; refund_rate_bp: number }[];
  /** 같은 학원·회원을 다시 쓸 때 */
  memberId?: string;
}

/** 회원 한 명(Better Auth 사용자 id 는 시험용 문자열) */
export async function insertMember(pool: Pool): Promise<{ memberId: string; authUserId: string }> {
  const memberId = randomUUID();
  const authUserId = `auth-${memberId}`;
  await pool.query(
    `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
     VALUES ($1, $2, '취소 시험 회원', 'female', '1995-05-05', '010-1111-2222', $3, '시험 닉네임', now(), now())`,
    [memberId, authUserId, `ci-${memberId}`],
  );
  return { memberId, authUserId };
}

export async function insertCancellationChain(pool: Pool, options: ChainOptions = {}): Promise<CancellationChain> {
  const startsInHours = options.startsInHours ?? 72;
  const stage = options.stage ?? "paid";
  const method = options.method ?? "virtual_account";
  const amount = options.amount ?? 120000;
  const academyId = randomUUID();
  const classId = randomUUID();
  const offeringId = randomUUID();
  const sessionId = randomUUID();
  const seatPoolId = randomUUID();
  const noticeId = randomUUID();
  const orderId = randomUUID();
  const reservationId = randomUUID();
  const paymentId = randomUUID();
  const gatewayPaymentId = `gw-${paymentId}`;

  await pool.query(
    `INSERT INTO academies (id, name, refund_policy_tiers, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
     VALUES ($1, '취소 시험 학원', $2::jsonb, '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
    [academyId, JSON.stringify(options.tiers ?? [])],
  );
  await pool.query(
    `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
     VALUES ($1, $2, '살사 입문', '강사', 'salsa_bachata', 'one_day', 'single', now())`,
    [classId, academyId],
  );
  await pool.query(
    `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                  last_session_ends_at, status, updated_at)
     VALUES ($1, $2, '원데이', 'session', $3, now() + make_interval(hours => $4), now() + make_interval(hours => $4 + 2), 'open', now())`,
    [offeringId, classId, amount, startsInHours],
  );
  await pool.query(
    `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
     VALUES ($1, $2, 1, now() + make_interval(hours => $3), now() + make_interval(hours => $3 + 2))`,
    [sessionId, offeringId, startsInHours],
  );
  // 이 예약 하나가 이미 자리 하나를 쥐고 있다(확정이면 confirmed, 입금 전이면 held)
  await pool.query(
    `INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, held_count, confirmed_count, updated_at)
     VALUES ($1, $2, 'any', 10, $3, $4, now())`,
    [seatPoolId, offeringId, stage === "pending" ? 1 : 0, stage === "paid" ? 1 : 0],
  );
  const member = options.memberId === undefined ? await insertMember(pool) : { memberId: options.memberId, authUserId: `auth-${options.memberId}` };
  await pool.query(`INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES ($1, $2, 1, '공지')`, [noticeId, academyId]);
  await pool.query(
    `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                         refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                         platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
     VALUES ($1, $2, $3, $4, $5, $5, '{}'::jsonb, $6, 'v1', 'v1', 'v1', 0, 5000, $7,
             CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
    [orderId, member.memberId, offeringId, stage, amount, noticeId, `idem-${orderId}`],
  );
  await pool.query(
    `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
     VALUES ($1, $2, $3, $4, 'any', $5, $6, now())`,
    [reservationId, orderId, offeringId, seatPoolId, member.memberId, stage === "paid" ? "confirmed" : "held"],
  );
  await pool.query(
    `INSERT INTO payments (id, order_id, method, amount, paid_at, gateway_payment_id, status, due_at, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'paid' THEN now() END, $6, $7, now() + interval '1 day', now())`,
    [paymentId, orderId, method, amount, stage, gatewayPaymentId, stage === "paid" ? "paid" : "ready"],
  );
  if (stage === "paid") {
    await pool.query(
      `INSERT INTO calendar_entries (id, member_id, reservation_id, session_id, starts_at, ends_at, title)
       SELECT $1, $2, $3, id, starts_at, ends_at, '살사 입문' FROM class_sessions WHERE id = $4`,
      [randomUUID(), member.memberId, reservationId, sessionId],
    );
  }
  return { academyId, offeringId, sessionId, seatPoolId, ...member, orderId, reservationId, paymentId, gatewayPaymentId };
}
