// S2-4.1(개인 레슨 상품·수강권 테이블) — 개인 레슨 표 다섯 개가 data-model §8-6·§8-7 그대로 실제 PostgreSQL 에 있는지,
// 그리고 설계가 정한 규칙을 DB 가 직접 지키는지 확인한다.
//   - private_lesson_rule_versions(강사×학원 취소·환불 규칙 판본)
//   - private_lesson_products(상품 = classes 행의 짝)
//   - private_lesson_slots(레슨 모집 시간)
//   - private_lesson_passes(회원의 수강권)
//   - private_lesson_bookings(수강권에서 잡은 회차)
// 수강권은 주문(orders)에 묶지 않고 회차권 표로 따로 둔다 — 마스터 플랜 S2-4 열린 점의 추천안(data-model §8-6).
// (개설 API·24시간 판정·회차 잡기 흐름은 S2-4.2·S2-4.3·S2-4.7 몫이라 여기서는 행을 직접 써서 칸과 제약만 본다.)
//
// 확인하는 것:
//   ① 칸 목록 — 다섯 표의 칸이 설계와 같고, NULL 허용·기본값(24·3·10·open·pending_payment·booked·0·false)이 맞다
//   ② 값 집합 — 상품 2 · 시간 4 · 수강권 5 · 회차 6 · 잡은 사람 2 값은 들어가고 그 밖은 CHECK 가 거부한다
//   ③ 규칙 판본 — 기한 12·24·48 시간, 유효기간 2·3·6 개월만, 판본 번호는 1 이상·강사×학원 안에서 하나
//   ④ 상품 — 50·80분만, 횟수 1 이상, 가격 0 이상, classes 한 행에 상품 하나(PK = class_id)
//   ⑤ 레슨 모집 시간 — 끝 > 시작, 결제 대기에만 기한, 같은 강사·같은 강의실의 살아 있는 시간은 겹치지 못한다(EXCLUDE)
//   ⑥ 수강권 — 차감 수는 0~전체, 쓰는 중이면 결제 시각·유효기간 필수, 주문 하나 = 수강권 하나
//   ⑦ 잡은 회차 — 한 시간에 살아 있는 레슨 하나, 취소에만 취소 시각, 차감 여부가 상태와 짝
//   ⑧ 외래 키 — 없는 수업·학원·강사·회원·주문·규칙·시간·수강권을 가리키는 행은 거부
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  PRIVATE_LESSON_BOOKED_BY,
  PRIVATE_LESSON_BOOKING_STATUSES,
  PRIVATE_LESSON_PASS_STATUSES,
  PRIVATE_LESSON_PRODUCT_STATUSES,
  PRIVATE_LESSON_SLOT_STATUSES,
} from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// data-model §8-6 의 칸 목록. 설계 원본과 DB 를 잇는 짝이다.
const COLUMNS: Record<string, string[]> = {
  private_lesson_rule_versions: [
    "id",
    "academy_id",
    "instructor_account_id",
    "version",
    "change_deadline_hours",
    "validity_months",
    "created_at",
  ],
  private_lesson_products: [
    "class_id",
    "sub_genre",
    "lesson_minutes",
    "session_count",
    "price_amount",
    "status",
    "rule_version_id",
    "refund_notice_version_id",
    "idempotency_key",
    "created_at",
    "updated_at",
  ],
  private_lesson_slots: [
    "id",
    "product_class_id",
    "academy_id",
    "instructor_account_id",
    "room_id",
    "starts_at",
    "ends_at",
    "status",
    "held_until",
    "repeat_group_id",
    "created_at",
  ],
  private_lesson_passes: [
    "id",
    "product_class_id",
    "member_id",
    "order_id",
    "rule_version_id",
    "discipline",
    "status",
    "sessions_total",
    "sessions_used",
    "paid_at",
    "valid_until",
    "created_at",
    "updated_at",
  ],
  private_lesson_bookings: [
    "id",
    "pass_id",
    "slot_id",
    "status",
    "booked_by",
    "deducted",
    "cancel_reason",
    "cancelled_at",
    "created_at",
    "updated_at",
  ],
};
// 비어 있어도 되는 칸(설계의 NULL) — 나머지는 NOT NULL 이다.
const NULLABLE: Record<string, string[]> = {
  private_lesson_rule_versions: [],
  private_lesson_products: ["sub_genre", "refund_notice_version_id"],
  private_lesson_slots: ["room_id", "held_until", "repeat_group_id"],
  private_lesson_passes: ["order_id", "discipline", "paid_at", "valid_until"],
  private_lesson_bookings: ["cancel_reason", "cancelled_at"],
};

describe.skipIf(!dbAvailable())("개인 레슨 상품·수강권(private_lesson_* 다섯 표)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 부모 행 id — 끝나고 이것만 지운다.
  const academyId = randomUUID();
  const branchId = randomUUID();
  const roomA = randomUUID();
  const roomB = randomUUID();
  const instructorA = randomUUID();
  const instructorB = randomUUID();
  const staffIds = [instructorA, instructorB];
  const memberId = randomUUID();
  const regularClassId = randomUUID(); // 주문이 매달릴 일반 수업(orders.offering_id 가 필수라서)
  const offeringId = randomUUID();
  const noticeId = randomUUID();
  const classIds: string[] = [regularClassId]; // 개인 레슨 상품 행이 짝지을 classes 행들
  let ruleId = "";
  let productId = ""; // 기본 상품(class_id)
  let dayOffset = 1; // 시험마다 다른 날을 써서 겹침 규칙이 서로 엉키지 않게 한다

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름(뒤에 해시가 붙을 수 있다)이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 규칙 판본 한 줄. 기한·유효기간을 안 주면 DB 기본값(24·3)을 쓴다.
  async function insertRule(fields: { version: number; hours?: number; months?: number; instructor?: string; academy?: string }) {
    const id = randomUUID();
    const cols = ["id", "academy_id", "instructor_account_id", "version"];
    const vals: unknown[] = [id, fields.academy ?? academyId, fields.instructor ?? instructorA, fields.version];
    if (fields.hours !== undefined) {
      cols.push("change_deadline_hours");
      vals.push(fields.hours);
    }
    if (fields.months !== undefined) {
      cols.push("validity_months");
      vals.push(fields.months);
    }
    await q(
      `INSERT INTO private_lesson_rule_versions (${cols.join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
      vals,
    );
    return id;
  }

  // classes 행(class_kind = 'private_lesson', 공개) 하나를 만든다 — 개인 레슨은 승인 없이 바로 공개다(FR-050a).
  async function insertPrivateClass(): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at,
                            instructor_account_id, created_by_account_id, updated_at)
       VALUES ($1, $2, '개인 레슨', '시험 강사', 'dance_sport', 'private_lesson', 'single', 'published', now(), $3, $3, now())`,
      [id, academyId, instructorA],
    );
    classIds.push(id);
    return id;
  }

  // 상품 한 줄. classId 를 안 주면 새 classes 행을 만든다. 횟수·상태를 안 주면 DB 기본값(10·open)을 쓴다.
  async function insertProduct(fields: {
    classId?: string;
    minutes?: number;
    count?: number;
    price?: number;
    status?: string;
    rule?: string;
    notice?: string | null;
  } = {}): Promise<string> {
    const classId = fields.classId ?? (await insertPrivateClass());
    const cols = ["class_id", "sub_genre", "lesson_minutes", "price_amount", "rule_version_id", "refund_notice_version_id", "idempotency_key", "updated_at"];
    const vals: unknown[] = [classId, "latin", fields.minutes ?? 50, fields.price ?? 600000, fields.rule ?? ruleId, fields.notice ?? null, `idem-${classId}`, new Date()];
    if (fields.count !== undefined) {
      cols.push("session_count");
      vals.push(fields.count);
    }
    if (fields.status !== undefined) {
      cols.push("status");
      vals.push(fields.status);
    }
    await q(
      `INSERT INTO private_lesson_products (${cols.join(", ")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
      vals,
    );
    return classId;
  }

  // 레슨 모집 시간 한 줄. 시작은 「오늘 + day 일 + startHour 시」, 길이는 minutes 분.
  async function insertSlot(fields: {
    day: number;
    startHour?: number;
    minutes?: number;
    status?: string;
    heldUntil?: boolean;
    instructor?: string;
    room?: string | null;
    product?: string;
    academy?: string;
  }): Promise<string> {
    const id = randomUUID();
    const hasStatus = fields.status !== undefined;
    await q(
      `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, room_id, starts_at, ends_at,
                                         held_until${hasStatus ? ", status" : ""})
       VALUES ($1, $2, $3, $4, $5,
               date_trunc('day', now()) + make_interval(days => $6::int, hours => $7::int),
               date_trunc('day', now()) + make_interval(days => $6::int, hours => $7::int, mins => $8::int),
               CASE WHEN $9::boolean THEN now() + interval '1 hour' END${hasStatus ? ", $10" : ""})`,
      [
        id,
        fields.product ?? productId,
        fields.academy ?? academyId,
        fields.instructor ?? instructorA,
        fields.room === undefined ? null : fields.room,
        fields.day,
        fields.startHour ?? 20,
        fields.minutes ?? 50,
        fields.heldUntil ?? false,
        ...(hasStatus ? [fields.status] : []),
      ],
    );
    return id;
  }

  // 수강권 한 줄. paid 면 결제 시각·유효기간(결제일 + 3개월)을 채운다. 상태를 안 주면 DB 기본값(pending_payment).
  async function insertPass(fields: {
    status?: string;
    paid?: boolean;
    total?: number;
    used?: number;
    order?: string | null;
    member?: string;
    product?: string;
    rule?: string;
  } = {}): Promise<string> {
    const id = randomUUID();
    const hasStatus = fields.status !== undefined;
    const hasUsed = fields.used !== undefined;
    const extraCols = [...(hasStatus ? ["status"] : []), ...(hasUsed ? ["sessions_used"] : [])];
    const extraVals = [...(hasStatus ? [fields.status] : []), ...(hasUsed ? [fields.used] : [])];
    await q(
      `INSERT INTO private_lesson_passes (id, product_class_id, member_id, order_id, rule_version_id, discipline, sessions_total,
                                          paid_at, valid_until, updated_at${extraCols.map((c) => `, ${c}`).join("")})
       VALUES ($1, $2, $3, $4, $5, 'rumba', $6,
               CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN now() + interval '3 months' END, now()
               ${extraVals.map((_, i) => `, $${8 + i}`).join("")})`,
      [
        id,
        fields.product ?? productId,
        fields.member ?? memberId,
        fields.order ?? null,
        fields.rule ?? ruleId,
        fields.total ?? 10,
        fields.paid ?? false,
        ...extraVals,
      ],
    );
    return id;
  }

  // 잡은 회차 한 줄. 상태·차감을 안 주면 DB 기본값(booked·false).
  async function insertBooking(fields: {
    pass: string;
    slot: string;
    status?: string;
    deducted?: boolean;
    cancelledAt?: boolean;
    bookedBy?: string;
  }): Promise<string> {
    const id = randomUUID();
    const extraCols = [...(fields.status !== undefined ? ["status"] : []), ...(fields.deducted !== undefined ? ["deducted"] : [])];
    const extraVals = [...(fields.status !== undefined ? [fields.status] : []), ...(fields.deducted !== undefined ? [fields.deducted] : [])];
    await q(
      `INSERT INTO private_lesson_bookings (id, pass_id, slot_id, booked_by, cancelled_at, updated_at${extraCols.map((c) => `, ${c}`).join("")})
       VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN now() END, now()${extraVals.map((_, i) => `, $${6 + i}`).join("")})`,
      [id, fields.pass, fields.slot, fields.bookedBy ?? "instructor", fields.cancelledAt ?? false, ...extraVals],
    );
    return id;
  }

  // 주문 한 줄(수강권의 order_id 가 가리킬 대상). 금액 식(ck_orders_total_formula)을 지키는 값이다.
  async function insertOrder(): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version,
                           merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, 'paid', 600000, 600000, '{}'::jsonb, $4, 'v1', 'v1', 'v1', 100, 5000, $5, now(), ${orderSnapshotValuesSql("$3")})`,
      [id, memberId, offeringId, noticeId, `idem-${id}`],
    );
    return id;
  }

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '개인 레슨 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 마포구 1', '서울', '마포구', now())",
      [branchId, academyId],
    );
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $3, 'A홀', 'active', now()), ($2, $3, 'B홀', 'active', now())", [
      roomA,
      roomB,
      branchId,
    ]);
    for (const id of staffIds) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 강사', now())", [
        id,
        `private-lesson-test-${id}`,
      ]);
    }
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '시험 회원', 'female', '1990-01-01', '010-0000-0000', $3, '시험 닉네임', now(), now())`,
      [memberId, `auth-${memberId}`, `ci-${memberId}`],
    );
    await q("INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body) VALUES ($1, $2, 'private_lesson', 1, '개인 레슨 공지')", [
      noticeId,
      academyId,
    ]);
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, '주문용 수업', '시험 강사', 'salsa_bachata', 'regular', 'single', now())`,
      [regularClassId, academyId],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at,
                                    last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '정규', 'term', 100000, now() + interval '1 day', now() + interval '60 days', 'open', now())`,
      [offeringId, regularClassId],
    );
    // 주문 스냅샷의 회차 수(ck_orders_session_count ≥ 1, S3-3.2)를 채우려면 예정 회차가 하나는 있어야 한다
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       VALUES ($1, $2, 1, now() + interval '1 day', now() + interval '1 day 2 hours')`,
      [randomUUID(), offeringId],
    );
    ruleId = await insertRule({ version: 1 });
    productId = await insertProduct({ notice: noticeId });
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 회차 → 수강권 → 시간 → 상품 → 규칙 → 주문 → 수업 → 나머지 부모.
    await q("DELETE FROM private_lesson_bookings WHERE pass_id IN (SELECT id FROM private_lesson_passes WHERE member_id = $1)", [memberId]);
    await q("DELETE FROM private_lesson_passes WHERE member_id = $1", [memberId]);
    await q("DELETE FROM private_lesson_slots WHERE academy_id = $1", [academyId]);
    await q("DELETE FROM private_lesson_products WHERE class_id = ANY($1)", [classIds]);
    await q("DELETE FROM private_lesson_rule_versions WHERE academy_id = $1", [academyId]);
    await q("DELETE FROM orders WHERE member_id = $1", [memberId]);
    await q("DELETE FROM class_sessions WHERE offering_id = $1", [offeringId]);
    await q("DELETE FROM class_offerings WHERE id = $1", [offeringId]);
    await q("DELETE FROM classes WHERE id = ANY($1)", [classIds]);
    await q("DELETE FROM refund_notice_versions WHERE id = $1", [noticeId]);
    await q("DELETE FROM members WHERE id = $1", [memberId]);
    await q("DELETE FROM rooms WHERE branch_id = $1", [branchId]);
    await q("DELETE FROM academy_branches WHERE id = $1", [branchId]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [staffIds]);
    await q("DELETE FROM academies WHERE id = $1", [academyId]);
    await closeTestDb(handle);
  });

  test("① 칸 목록 — 다섯 표의 칸·NULL 허용·기본값이 설계와 같다", async () => {
    const tables = Object.keys(COLUMNS);
    const { rows } = await q(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [tables],
    );
    for (const table of tables) {
      const names = rows.filter((r) => r.table_name === table).map((r) => r.column_name as string);
      expect(names.sort(), `${table} 의 칸`).toEqual([...COLUMNS[table]].sort());
      for (const r of rows.filter((x) => x.table_name === table)) {
        const expected = NULLABLE[table].includes(r.column_name) ? "YES" : "NO";
        expect(r.is_nullable, `${table}.${r.column_name} 의 NULL 허용`).toBe(expected);
      }
    }
    const def = (table: string, name: string) =>
      rows.find((r) => r.table_name === table && r.column_name === name)?.column_default as string | undefined;
    expect(def("private_lesson_rule_versions", "change_deadline_hours")).toBe("24");
    expect(def("private_lesson_rule_versions", "validity_months")).toBe("3");
    expect(def("private_lesson_products", "session_count")).toBe("10");
    expect(def("private_lesson_products", "status")).toContain("'open'");
    expect(def("private_lesson_slots", "status")).toContain("'open'");
    expect(def("private_lesson_passes", "status")).toContain("'pending_payment'");
    expect(def("private_lesson_passes", "sessions_used")).toBe("0");
    expect(def("private_lesson_bookings", "status")).toContain("'booked'");
    expect(def("private_lesson_bookings", "deducted")).toBe("false");

    // 상품의 기본 키는 classes.id 그대로다(상품 = classes 행의 짝).
    const { rows: pk } = await q(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'private_lesson_products'::regclass AND i.indisprimary`,
    );
    expect(pk.map((r) => r.attname)).toEqual(["class_id"]);

    // 설계가 이름 붙인 색인·EXCLUDE 제약이 있다(색인 이름 뒤에는 해시가 붙는다).
    const { rows: indexes } = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [tables],
    );
    const idx = (prefix: string) => indexes.find((i) => (i.indexname as string).startsWith(prefix))?.indexdef as string | undefined;
    expect(idx("uq_pl_rule")).toMatch(/UNIQUE INDEX .*\(academy_id, instructor_account_id, version\)/);
    expect(idx("ix_pl_slots_product_time")).toMatch(/\(product_class_id, starts_at\) WHERE \(status = 'open'/);
    expect(idx("uq_pl_pass_order")).toMatch(/UNIQUE INDEX .*\(order_id\) WHERE \(order_id IS NOT NULL\)/);
    expect(idx("ix_pl_pass_member")).toContain("(member_id, status)");
    expect(idx("ix_pl_pass_product")).toContain("(product_class_id, status)");
    expect(idx("uq_pl_booking_slot_live")).toMatch(/UNIQUE INDEX .*\(slot_id\) WHERE \(status = 'booked'/);
    expect(idx("ix_pl_booking_pass")).toContain("(pass_id, status)");
    const { rows: excludes } = await q(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'private_lesson_slots'::regclass AND contype = 'x' ORDER BY conname`,
    );
    expect(excludes.map((r) => r.conname)).toEqual(["ex_pl_slots_instructor", "ex_pl_slots_room"]);
    expect(excludes[0].def).toContain("instructor_account_id WITH =");
    expect(excludes[1].def).toContain("room_id IS NOT NULL");
  });

  test("② 값 집합 — 정해진 값만 들어가고 그 밖은 CHECK 가 거부한다", async () => {
    // 상품 상태 2값
    for (const status of PRIVATE_LESSON_PRODUCT_STATUSES) await insertProduct({ status });
    for (const bad of ["paused", "draft", "OPEN", ""]) {
      await expectViolation(insertProduct({ status: bad }), "private_lesson_products_status_check");
    }

    // 시간 상태 4값 — 결제 대기(held)만 기한을 채운다. 겹치지 않게 시각을 나눈다.
    const day = dayOffset++;
    for (const [i, status] of PRIVATE_LESSON_SLOT_STATUSES.entries()) {
      await insertSlot({ day, startHour: 8 + i * 2, status, heldUntil: status === "held" });
    }
    for (const bad of ["reserved", "cancelled", "OPEN", ""]) {
      await expectViolation(insertSlot({ day, startHour: 18, status: bad }), "private_lesson_slots_status_check");
    }

    // 수강권 상태 5값 — 결제 전(pending_payment)·환불만 결제 칸 없이도 되고, 나머지는 결제 칸을 채운다.
    for (const status of PRIVATE_LESSON_PASS_STATUSES) {
      await insertPass({ status, paid: status !== "pending_payment" });
    }
    for (const bad of ["paid", "cancelled", "ACTIVE", ""]) {
      await expectViolation(insertPass({ status: bad, paid: true }), "private_lesson_passes_status_check");
    }

    // 회차 상태 6값 — 차감·취소 시각을 상태에 맞게 채운다. 한 시간에 살아 있는 회차는 하나라 시간을 따로 쓴다.
    const pass = await insertPass({ status: "active", paid: true });
    const deductedOf: Record<string, boolean> = {
      booked: false,
      done: true,
      cancelled_instructor: false,
      cancelled_member_free: false,
      cancelled_member_late: true,
      no_show: true,
    };
    const bookingDay = dayOffset++;
    for (const [i, status] of PRIVATE_LESSON_BOOKING_STATUSES.entries()) {
      const slot = await insertSlot({ day: bookingDay, startHour: 8 + i * 2 });
      await insertBooking({ pass, slot, status, deducted: deductedOf[status], cancelledAt: status.startsWith("cancelled_") });
    }
    const spare = await insertSlot({ day: bookingDay, startHour: 21 });
    for (const bad of ["cancelled", "pending", "BOOKED", ""]) {
      await expectViolation(insertBooking({ pass, slot: spare, status: bad }), "private_lesson_bookings_status_check");
    }

    // 잡은 사람 2값
    for (const [i, bookedBy] of PRIVATE_LESSON_BOOKED_BY.entries()) {
      const slot = await insertSlot({ day: bookingDay, startHour: 22 + i });
      await insertBooking({ pass, slot, bookedBy, status: "cancelled_instructor", cancelledAt: true });
    }
    for (const bad of ["owner", "admin", "MEMBER", ""]) {
      await expectViolation(insertBooking({ pass, slot: spare, bookedBy: bad }), "private_lesson_bookings_booked_by_check");
    }
  });

  test("③ 규칙 판본 — 기한 12·24·48, 유효기간 2·3·6, 판본 번호는 1 이상이고 강사×학원 안에서 하나", async () => {
    // 기본값(24시간·3개월)으로 들어간다
    const { rows } = await q("SELECT change_deadline_hours, validity_months FROM private_lesson_rule_versions WHERE id = $1", [ruleId]);
    expect(rows[0]).toEqual({ change_deadline_hours: 24, validity_months: 3 });

    let version = 2;
    for (const hours of [12, 24, 48]) await insertRule({ version: version++, hours });
    for (const months of [2, 3, 6]) await insertRule({ version: version++, months });
    for (const hours of [0, 6, 36, 72]) await expectViolation(insertRule({ version: version++, hours }), "ck_pl_rule_deadline");
    for (const months of [0, 1, 4, 12]) await expectViolation(insertRule({ version: version++, months }), "ck_pl_rule_validity");
    await expectViolation(insertRule({ version: 0 }), "ck_pl_rule_version");

    // 같은 강사·같은 학원·같은 판본 번호는 하나뿐, 다른 강사는 같은 번호를 쓴다
    await expectViolation(insertRule({ version: 1 }), "uq_pl_rule");
    await insertRule({ version: 1, instructor: instructorB });
  });

  test("④ 상품 — 50·80분만, 횟수 1 이상, 가격 0 이상, classes 한 행에 상품 하나", async () => {
    for (const minutes of [50, 80]) await insertProduct({ minutes });
    for (const minutes of [0, 30, 60, 90]) await expectViolation(insertProduct({ minutes }), "ck_pl_product_minutes");
    await insertProduct({ count: 1 });
    await insertProduct({ count: 50 });
    await expectViolation(insertProduct({ count: 0 }), "ck_pl_product_count");
    await insertProduct({ price: 0 });
    await expectViolation(insertProduct({ price: -1 }), "ck_pl_product_price");

    // 횟수를 안 주면 10회 · 상태는 open
    const { rows } = await q("SELECT session_count, status, refund_notice_version_id FROM private_lesson_products WHERE class_id = $1", [productId]);
    expect(rows[0]).toEqual({ session_count: 10, status: "open", refund_notice_version_id: noticeId });

    // 같은 classes 행에 상품을 두 번 만들 수 없다(PK = class_id)
    await expectViolation(insertProduct({ classId: productId }), "private_lesson_products_pkey");
  });

  test("⑤ 레슨 모집 시간 — 끝 > 시작, 결제 대기에만 기한, 같은 강사·같은 강의실의 살아 있는 시간은 겹치지 않는다", async () => {
    const day = dayOffset++;
    await expectViolation(insertSlot({ day, minutes: 0 }), "ck_pl_slot_time");
    await expectViolation(insertSlot({ day, startHour: 9, status: "held", heldUntil: false }), "ck_pl_slot_held");
    await expectViolation(insertSlot({ day, startHour: 9, status: "open", heldUntil: true }), "ck_pl_slot_held");

    // 강사 A 20:00–20:50 이 있으면, 같은 강사의 20:30 시작은 거부(학원·상품이 달라도 한 사람 기준)
    await insertSlot({ day, startHour: 20, minutes: 50 });
    const otherProduct = await insertProduct();
    await expectViolation(
      q(
        `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at)
         VALUES (uuidv7(), $1, $2, $3, date_trunc('day', now()) + make_interval(days => $4::int, hours => 20, mins => 30),
                 date_trunc('day', now()) + make_interval(days => $4::int, hours => 21, mins => 20))`,
        [otherProduct, academyId, instructorA, day],
      ),
      "ex_pl_slots_instructor",
    );
    // 끝나는 시각(20:50)에 시작하는 시간은 겹침이 아니다([시작, 끝) 경계)
    await q(
      `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at)
       VALUES (uuidv7(), $1, $2, $3, date_trunc('day', now()) + make_interval(days => $4::int, hours => 20, mins => 50),
               date_trunc('day', now()) + make_interval(days => $4::int, hours => 21, mins => 40))`,
      [productId, academyId, instructorA, day],
    );
    // 다른 강사는 같은 시각에 시간을 낸다
    await insertSlot({ day, startHour: 20, instructor: instructorB });

    // 닫힌(closed) 시간은 겹침에서 빠진다 — 닫은 자리에 새 시간을 다시 낼 수 있다
    await insertSlot({ day, startHour: 10, status: "closed" });
    await insertSlot({ day, startHour: 10 });
    // 결제 대기(held)·예약됨(booked)도 살아 있는 시간이라 겹치면 거부
    await insertSlot({ day, startHour: 12, status: "held", heldUntil: true });
    await expectViolation(insertSlot({ day, startHour: 12 }), "ex_pl_slots_instructor");
    await insertSlot({ day, startHour: 14, status: "booked" });
    await expectViolation(insertSlot({ day, startHour: 14 }), "ex_pl_slots_instructor");

    // 같은 강의실은 강사가 달라도 겹치면 거부, 다른 강의실이면 통과
    await insertSlot({ day, startHour: 16, room: roomA });
    await expectViolation(insertSlot({ day, startHour: 16, room: roomA, instructor: instructorB }), "ex_pl_slots_room");
    await insertSlot({ day, startHour: 16, room: roomB, instructor: instructorB });
  });

  test("⑥ 수강권 — 차감 수는 0~전체, 쓰는 중이면 결제 칸 필수, 주문 하나 = 수강권 하나", async () => {
    // 결제 전 수강권은 결제 시각·유효기간 없이 들어간다(기본 상태 pending_payment, 차감 0)
    const pending = await insertPass();
    const { rows } = await q("SELECT status, sessions_used, paid_at, valid_until FROM private_lesson_passes WHERE id = $1", [pending]);
    expect(rows[0]).toEqual({ status: "pending_payment", sessions_used: 0, paid_at: null, valid_until: null });

    // 쓰는 중·다 쓴·기한 지난 수강권은 결제 칸이 꼭 있어야 한다
    for (const status of ["active", "completed", "expired"]) {
      await expectViolation(insertPass({ status, paid: false }), "ck_pl_pass_active");
    }

    // 차감 수 0~전체
    await insertPass({ status: "active", paid: true, total: 10, used: 10 });
    await expectViolation(insertPass({ status: "active", paid: true, total: 10, used: 11 }), "ck_pl_pass_used");
    await expectViolation(insertPass({ status: "active", paid: true, total: 10, used: -1 }), "ck_pl_pass_used");
    await expectViolation(insertPass({ total: 0 }), "ck_pl_pass_total");

    // 주문 하나 = 수강권 하나. 주문 없는 수강권(order_id NULL)은 몇 개든 된다.
    const orderId = await insertOrder();
    await insertPass({ status: "active", paid: true, order: orderId });
    await expectViolation(insertPass({ status: "active", paid: true, order: orderId }), "uq_pl_pass_order");
    await insertPass();
    await insertPass();
  });

  test("⑦ 잡은 회차 — 한 시간에 살아 있는 레슨 하나, 취소에만 취소 시각, 차감 여부는 상태와 짝", async () => {
    const day = dayOffset++;
    const pass = await insertPass({ status: "active", paid: true });
    const slot = await insertSlot({ day, startHour: 9 });

    // 기본값: booked · 차감 없음
    const first = await insertBooking({ pass, slot });
    const { rows } = await q("SELECT status, deducted FROM private_lesson_bookings WHERE id = $1", [first]);
    expect(rows[0]).toEqual({ status: "booked", deducted: false });
    // 같은 시간에 살아 있는 회차가 또 들어오면 거부
    await expectViolation(insertBooking({ pass, slot }), "uq_pl_booking_slot_live");
    // 회원이 기한 전에 취소하면(차감 없음) 같은 시간을 다시 잡을 수 있다 — 취소된 회차는 남는다
    await q("UPDATE private_lesson_bookings SET status = 'cancelled_member_free', cancelled_at = now() WHERE id = $1", [first]);
    await insertBooking({ pass, slot });

    // 취소 상태에만 취소 시각
    const s2 = await insertSlot({ day, startHour: 11 });
    await expectViolation(insertBooking({ pass, slot: s2, status: "cancelled_instructor", cancelledAt: false }), "ck_pl_booking_cancel");
    await expectViolation(insertBooking({ pass, slot: s2, status: "booked", cancelledAt: true }), "ck_pl_booking_cancel");
    await expectViolation(insertBooking({ pass, slot: s2, status: "done", deducted: true, cancelledAt: true }), "ck_pl_booking_cancel");

    // 돌려주는 상태는 차감하면 안 되고, 차감하는 상태는 차감해야 한다
    for (const status of ["cancelled_instructor", "cancelled_member_free"]) {
      await expectViolation(insertBooking({ pass, slot: s2, status, deducted: true, cancelledAt: true }), "ck_pl_booking_deduct");
    }
    await expectViolation(insertBooking({ pass, slot: s2, status: "cancelled_member_late", deducted: false, cancelledAt: true }), "ck_pl_booking_deduct");
    for (const status of ["done", "no_show"]) {
      await expectViolation(insertBooking({ pass, slot: s2, status, deducted: false }), "ck_pl_booking_deduct");
    }
  });

  test("⑧ 외래 키 — 없는 수업·학원·강사·회원·주문·규칙·시간·수강권을 가리키는 행은 거부한다", async () => {
    const missing = randomUUID();
    const day = dayOffset++;
    await expectViolation(insertRule({ version: 99, academy: missing }), "private_lesson_rule_versions_academy_id_fkey");
    await expectViolation(insertRule({ version: 99, instructor: missing }), "private_lesson_rule_versions_instructor_account_id_fkey");
    await expectViolation(insertProduct({ classId: missing }), "private_lesson_products_class_id_fkey");
    await expectViolation(insertProduct({ rule: missing }), "private_lesson_products_rule_version_id_fkey");
    await expectViolation(insertProduct({ notice: missing }), "private_lesson_products_refund_notice_version_id_fkey");
    await expectViolation(insertSlot({ day, product: missing }), "private_lesson_slots_product_class_id_fkey");
    await expectViolation(insertSlot({ day, academy: missing }), "private_lesson_slots_academy_id_fkey");
    await expectViolation(insertSlot({ day, instructor: missing }), "private_lesson_slots_instructor_account_id_fkey");
    await expectViolation(insertSlot({ day, room: missing }), "private_lesson_slots_room_id_fkey");
    await expectViolation(insertPass({ product: missing }), "private_lesson_passes_product_class_id_fkey");
    await expectViolation(insertPass({ member: missing }), "private_lesson_passes_member_id_fkey");
    await expectViolation(insertPass({ order: missing }), "private_lesson_passes_order_id_fkey");
    await expectViolation(insertPass({ rule: missing }), "private_lesson_passes_rule_version_id_fkey");
    const pass = await insertPass();
    const slot = await insertSlot({ day, startHour: 9 });
    await expectViolation(insertBooking({ pass: missing, slot }), "private_lesson_bookings_pass_id_fkey");
    await expectViolation(insertBooking({ pass, slot: missing }), "private_lesson_bookings_slot_id_fkey");
  });
});
