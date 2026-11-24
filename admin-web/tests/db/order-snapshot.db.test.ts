// S3-3.2(주문 스냅샷 칸 더하기) — 주문을 만든 순간의 상품 종류·회차 수·첫 회차 시작·환불 마감일·노쇼 기준 판본이
// 주문 행에 베껴지고, 그 뒤 대표가 수업을 바꿔도 주문의 값은 그대로인지 본다. FR-284(주문 시점 값 고정).
//   설계: 플랜 _workspace/06_master-plan.md §6-1 「주문 스냅샷 칸」 · data-model §6-2·§7-6·§10-11 ④ · 계약 12 §1-4
//   verify 의 이름은 tests/db/s3-3-2.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 정규 수업 주문 — class_kind 'regular' · 회차 수 = 예정 회차만(휴강 회차 제외) · 첫 회차 시작 = 신청 단위 값 · 마감일 NULL · 노쇼 판본 = 상수
//   ② 주문 뒤 수업을 바꿔도(상품 종류 · 첫 회차 시작 · 회차 추가·휴강) 주문 스냅샷은 그대로
//   ③ 이벤트형 주문 — 마감일이 베껴지고, 대표가 마감일을 바꾸고 새 수수료 표 판본을 올려도 주문의 마감일·공지 판본(=수수료 표)은 그대로
//   ④ 개인 레슨 주문 — 회차 수 = 수강권 횟수, 상품 횟수를 바꿔도 주문은 그대로
//   ⑤ DB 도 막는다 — 회차 수 0 · 모르는 상품 종류 · 빈 스냅샷(NULL) 주문은 들어가지 않는다
//   ⑥ SQL 조각은 "$숫자" 자리표만 받는다(SQL 주입 방어)
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { NO_SHOW_POLICY } from "@/lib/domain/no-show-policy";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

interface SnapshotRow {
  class_kind: string;
  session_count: number;
  first_session_starts_at: string;
  refund_deadline_on: string | null;
  no_show_policy_version: string;
  refund_notice_version_id: string;
}

const FIRST_START = "2026-12-06T10:00:00Z"; // KST 12-06 19:00
const MOVED_START = "2026-12-13T10:00:00Z";

describe.skipIf(!dbAvailable())("주문 스냅샷 칸(S3-3.2)", () => {
  let handle: TestDb;
  const q = (text: string, values: unknown[] = []) => handle.pool.query(text, values);

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  // 학원 · 회원 · 공지 판본 한 벌. kind 는 공지 종류(regular·event·private_lesson).
  async function insertAcademy(): Promise<{ academyId: string; memberId: string }> {
    const academyId = randomUUID();
    const memberId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '스냅샷 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '스냅샷 회원', 'female', '1995-05-05', '010-1111-2222', $3, '스냅샷', now(), now())`,
      [memberId, `auth-${memberId}`, `ci-${memberId}`],
    );
    return { academyId, memberId };
  }

  async function insertNotice(academyId: string, kind: string, version: number, content: unknown): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content) VALUES ($1, $2, $3, $4, '공지', $5::jsonb)`,
      [id, academyId, kind, version, JSON.stringify(content)],
    );
    return id;
  }

  // 수업 + 신청 단위 + 회차 n 개. 가격·마감일은 이벤트형 시험에서 쓴다.
  async function insertClass(fields: {
    academyId: string;
    classKind: string;
    sessions: number;
    price?: number;
    deadline?: string | null;
    classId?: string;
  }): Promise<{ classId: string; offeringId: string }> {
    const classId = fields.classId ?? randomUUID();
    const offeringId = randomUUID();
    if (fields.classId === undefined) {
      await q(
        `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
         VALUES ($1, $2, '스냅샷 수업', '강사', 'salsa_bachata', $3, 'single', now())`,
        [classId, fields.academyId, fields.classKind],
      );
    }
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                    last_session_ends_at, status, refund_deadline_on, updated_at)
       VALUES ($1, $2, '스냅샷 기간', 'term', $3, $4::timestamptz, $4::timestamptz + interval '40 days', 'open', $5::date, now())`,
      [offeringId, classId, fields.price ?? 120000, FIRST_START, fields.deadline ?? null],
    );
    for (let seq = 1; seq <= fields.sessions; seq += 1) {
      await q(
        `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
         VALUES ($1, $2, $3, $4::timestamptz + make_interval(days => ($3 - 1) * 7), $4::timestamptz + make_interval(days => ($3 - 1) * 7, hours => 2))`,
        [randomUUID(), offeringId, seq, FIRST_START],
      );
    }
    return { classId, offeringId };
  }

  // 주문 한 건 — 결제 시작(POST /api/orders)이 쓸 것과 같은 SQL 조각으로 스냅샷 칸을 채운다. $3 이 신청 단위 id 다.
  async function insertOrder(memberId: string, offeringId: string, noticeId: string, amount = 120000): Promise<string> {
    const orderId = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, 'pending', $4, $4, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, amount, noticeId, `idem-${orderId}`],
    );
    return orderId;
  }

  async function readSnapshot(orderId: string): Promise<SnapshotRow> {
    const { rows } = await q(
      `SELECT class_kind, session_count, first_session_starts_at::text AS first_session_starts_at,
              refund_deadline_on::text AS refund_deadline_on, no_show_policy_version, refund_notice_version_id
         FROM orders WHERE id = $1`,
      [orderId],
    );
    return rows[0] as SnapshotRow;
  }

  test("① 정규 수업 주문은 상품 종류·예정 회차 수·첫 회차 시작·노쇼 판본을 베끼고 마감일은 비어 있다", async () => {
    const { academyId, memberId } = await insertAcademy();
    const noticeId = await insertNotice(academyId, "regular", 1, { tiers: [] });
    const { offeringId } = await insertClass({ academyId, classKind: "regular", sessions: 4 });
    // 주문 전에 이미 휴강된 회차는 결제한 사람이 받을 수업이 아니므로 세지 않는다
    await q(
      `UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '강사 사정' WHERE offering_id = $1 AND seq = 4`,
      [offeringId],
    );

    const orderId = await insertOrder(memberId, offeringId, noticeId);
    const snap = await readSnapshot(orderId);

    expect(snap.class_kind).toBe("regular");
    expect(snap.session_count).toBe(3);
    const same = await q(`SELECT first_session_starts_at = $2::timestamptz AS same FROM orders WHERE id = $1`, [orderId, FIRST_START]);
    expect(same.rows[0]).toEqual({ same: true });
    expect(snap.refund_deadline_on).toBeNull();
    expect(snap.no_show_policy_version).toBe(NO_SHOW_POLICY.version);
  });

  test("② 주문 뒤 수업을 바꿔도(종류·첫 회차·회차 추가·휴강) 주문 스냅샷은 그대로다", async () => {
    const { academyId, memberId } = await insertAcademy();
    const noticeId = await insertNotice(academyId, "regular", 1, { tiers: [] });
    const { classId, offeringId } = await insertClass({ academyId, classKind: "regular", sessions: 4 });
    const orderId = await insertOrder(memberId, offeringId, noticeId);
    const before = await readSnapshot(orderId);

    // 대표가 수업을 고친다 — 종류를 단기(basic)로, 첫 회차를 한 주 뒤로, 회차를 하나 더하고 하나는 휴강
    await q(`UPDATE classes SET class_kind = 'basic', updated_at = now() WHERE id = $1`, [classId]);
    await q(
      `UPDATE class_offerings SET first_session_starts_at = $2::timestamptz, last_session_ends_at = $2::timestamptz + interval '60 days', updated_at = now() WHERE id = $1`,
      [offeringId, MOVED_START],
    );
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES ($1, $2, 5, $3::timestamptz + interval '35 days', $3::timestamptz + interval '35 days 2 hours')`,
      [randomUUID(), offeringId, FIRST_START],
    );
    await q(
      `UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '휴강' WHERE offering_id = $1 AND seq = 2`,
      [offeringId],
    );

    const after = await readSnapshot(orderId);
    expect(after).toEqual(before);
    expect(after.class_kind).toBe("regular");
    expect(after.session_count).toBe(4);

    // 같은 수업에 지금 새로 주문하면 바뀐 값이 베껴진다 — 스냅샷이 「주문 순간」의 값이라는 뜻이다
    const later = await readSnapshot(await insertOrder(memberId, offeringId, noticeId));
    expect(later.class_kind).toBe("basic");
    expect(later.session_count).toBe(4); // 5회 중 1회 휴강
    expect(later.first_session_starts_at).not.toBe(before.first_session_starts_at);
  });

  test("③ 이벤트형 주문은 환불 마감일을 베끼고, 마감일·수수료 표를 바꿔도 주문 값은 그대로다", async () => {
    const { academyId, memberId } = await insertAcademy();
    const feeV1 = { feeTiers: [{ window: "d10_plus", percent: 10 }, { window: "d2_to_deadline", percent: 30 }] };
    const noticeV1 = await insertNotice(academyId, "event", 1, feeV1);
    const { offeringId } = await insertClass({ academyId, classKind: "one_day", sessions: 1, price: 30000, deadline: "2026-12-04" });
    const orderId = await insertOrder(memberId, offeringId, noticeV1, 30000);
    const before = await readSnapshot(orderId);
    expect(before.class_kind).toBe("one_day");
    expect(before.session_count).toBe(1);
    expect(before.refund_deadline_on).toBe("2026-12-04");

    // 대표가 마감일을 하루 늦추고, 수수료를 낮춘 새 판본을 올린다(FR-099c 낮추기만 됨)
    await q(`UPDATE class_offerings SET refund_deadline_on = '2026-12-05', updated_at = now() WHERE id = $1`, [offeringId]);
    await insertNotice(academyId, "event", 2, { feeTiers: [{ window: "d10_plus", percent: 0 }, { window: "d2_to_deadline", percent: 20 }] });

    const after = await readSnapshot(orderId);
    expect(after).toEqual(before);
    // 취소 수수료 표 판본 = 주문이 가리키는 공지 판본. 그 판본의 표는 처음 그대로다
    const { rows } = await q(`SELECT n.version, n.content FROM orders o JOIN refund_notice_versions n ON n.id = o.refund_notice_version_id WHERE o.id = $1`, [orderId]);
    expect(rows[0]).toEqual({ version: 1, content: feeV1 });
  });

  test("④ 개인 레슨 주문의 회차 수는 수강권 횟수이고, 상품 횟수를 바꿔도 주문은 그대로다", async () => {
    const { academyId, memberId } = await insertAcademy();
    const instructorId = randomUUID();
    await q(`INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '스냅샷 강사', now())`, [instructorId, `snap-${instructorId}`]);
    const ruleId = randomUUID();
    await q(`INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version) VALUES ($1, $2, $3, 1)`, [ruleId, academyId, instructorId]);
    const classId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at, instructor_account_id, created_by_account_id, updated_at)
       VALUES ($1, $2, '개인 레슨', '강사', 'dance_sport', 'private_lesson', 'single', 'published', now(), $3, $3, now())`,
      [classId, academyId, instructorId],
    );
    await q(
      `INSERT INTO private_lesson_products (class_id, sub_genre, lesson_minutes, price_amount, rule_version_id, session_count, idempotency_key, updated_at)
       VALUES ($1, 'latin', 50, 600000, $2, 10, $3, now())`,
      [classId, ruleId, `idem-${classId}`],
    );
    // 개인 레슨은 회차를 미리 만들지 않는다 — 신청 단위만 있고 회차는 0개
    const { offeringId } = await insertClass({ academyId, classKind: "private_lesson", sessions: 0, price: 600000, classId });
    const noticeId = await insertNotice(academyId, "private_lesson", 1, {});

    const orderId = await insertOrder(memberId, offeringId, noticeId, 600000);
    expect((await readSnapshot(orderId)).session_count).toBe(10);

    await q(`UPDATE private_lesson_products SET session_count = 20, updated_at = now() WHERE class_id = $1`, [classId]);
    const after = await readSnapshot(orderId);
    expect(after.session_count).toBe(10);
    expect(after.class_kind).toBe("private_lesson");
  });

  test("⑤ DB 가 회차 0 · 모르는 상품 종류 · 빈 스냅샷 주문을 막는다", async () => {
    const { academyId, memberId } = await insertAcademy();
    const noticeId = await insertNotice(academyId, "regular", 1, {});
    // 회차가 하나도 없는 정규 수업 — 베낀 회차 수가 0 이라 ck_orders_session_count 에 걸린다
    const empty = await insertClass({ academyId, classKind: "regular", sessions: 0 });
    await expect(insertOrder(memberId, empty.offeringId, noticeId)).rejects.toMatchObject({ constraint: expect.stringContaining("ck_orders_session_count") });

    const ok = await insertClass({ academyId, classKind: "regular", sessions: 2 });
    const orderId = await insertOrder(memberId, ok.offeringId, noticeId);
    await expect(q(`UPDATE orders SET class_kind = 'workshop' WHERE id = $1`, [orderId])).rejects.toMatchObject({ constraint: expect.stringContaining("orders_class_kind_check") });
    await expect(q(`UPDATE orders SET session_count = 0 WHERE id = $1`, [orderId])).rejects.toMatchObject({ constraint: expect.stringContaining("ck_orders_session_count") });

    // 스냅샷 칸을 빼고 넣으면(NOT NULL) 들어가지 않는다 — 베끼는 걸 잊은 주문 경로를 DB 가 잡는다
    await expect(
      q(
        `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                             intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                             cancel_fee_platform_share_bp, idempotency_key, updated_at)
         VALUES ($1, $2, $3, 'pending', 120000, 120000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 0, 5000, 'idem-missing', now())`,
        [randomUUID(), memberId, ok.offeringId, noticeId],
      ),
    ).rejects.toMatchObject({ code: "23502" });
  });

  test("⑥ SQL 조각은 $숫자 자리표만 받는다", () => {
    expect(() => orderSnapshotValuesSql("$3")).not.toThrow();
    for (const bad of ["3", "$0", "$3; DROP TABLE orders", "o.offering_id", ""]) {
      expect(() => orderSnapshotValuesSql(bad)).toThrow(/자리표/);
    }
    expect(ORDER_SNAPSHOT_COLUMNS_SQL).toBe("class_kind, session_count, first_session_starts_at, refund_deadline_on, no_show_policy_version");
  });
});
