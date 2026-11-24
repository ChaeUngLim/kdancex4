// S3-4.1(결석 기록 테이블) — attendance_marks 가 data-model §7-8 그대로 실제 PostgreSQL 에 있는지,
// 그리고 설계가 정한 규칙을 DB 가 직접 지키는지 확인한다.
// 이 표는 「행이 있으면 결석」이다(출석이 기본값, Q15(출결 방식)). 회원이 미리 알린 결석 예정과
// 강사·대표가 대신 표시한 결석을 한 표에 두고 marked_by_kind 로 나눈다.
// (결석을 쓰는 API·알림·이의 처리 흐름은 S3-4 의 다른 Task 몫이라 여기서는 행을 직접 써서 칸과 제약만 본다.)
//
// 확인하는 것:
//   ① 칸 목록 — 설계의 14칸이 있고, NULL 허용·기본값(dispute_status = 'none', marked_at = now())이 맞다
//   ② 값 집합 — marked_by_kind 3값 · dispute_status 4값은 들어가고 그 밖은 CHECK 가 거부한다
//   ③ uq_attendance_session — 한 예약의 한 회차에 살아 있는 결석은 하나뿐. 거둔(cancelled_at) 행이 있으면 다시 표시할 수 있다
//   ④ ck_attendance_marker — member 는 회원 칸만, instructor·owner 는 직원 칸만 채워야 한다
//   ⑤ 이의 칸 — 회원이 스스로 알린 행에는 이의를 못 걸고, 신청 시각·처리자·처리 시각이 상태와 짝이 맞는다
//   ⑥ 외래 키 — 없는 예약·회차·회원·직원을 가리키는 행은 거부
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ATTENDANCE_DISPUTE_STATUSES, ATTENDANCE_MARKED_BY_KINDS } from "../../lib/domain/constants";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// data-model §7-8 의 칸 목록. 설계 원본과 DB 를 잇는 짝이다.
const COLUMNS = [
  "id",
  "reservation_id",
  "session_id",
  "member_id",
  "marked_by_kind",
  "marked_by_member_id",
  "marked_by_staff_account_id",
  "marked_at",
  "cancelled_at",
  "dispute_status",
  "dispute_requested_at",
  "dispute_reason",
  "dispute_resolved_by_account_id",
  "dispute_resolved_at",
];
// 비어 있어도 되는 칸(설계의 NULL) — 나머지는 NOT NULL 이다.
const NULLABLE = [
  "marked_by_member_id",
  "marked_by_staff_account_id",
  "cancelled_at",
  "dispute_requested_at",
  "dispute_reason",
  "dispute_resolved_by_account_id",
  "dispute_resolved_at",
];

describe.skipIf(!dbAvailable())("결석 기록(attendance_marks)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 매 시험마다 새로 만드는 부모 행 — 예약 하나와 그 회차·회원, 직원 계정 하나
  let reservationId = "";
  let sessionId = "";
  let memberId = "";
  let staffId = "";

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름(뒤에 해시가 붙을 수 있다)이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 결석 한 줄을 넣는다. 안 준 칸은 「회원이 스스로 알린 결석 예정」 기본형으로 채운다.
  function insertMark(fields: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      reservation_id: reservationId,
      session_id: sessionId,
      member_id: memberId,
      marked_by_kind: "member",
      marked_by_member_id: memberId,
      ...fields,
    };
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    return q(`INSERT INTO attendance_marks (${cols.join(", ")}) VALUES (${placeholders}) RETURNING *`, Object.values(row));
  }

  // 강사가 대신 표시한 결석의 기본형(직원 칸만 채움)
  const byInstructor = () => ({ marked_by_kind: "instructor", marked_by_member_id: null, marked_by_staff_account_id: staffId });

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    // 예약 → 주문 → 신청 단위 → 회차 사슬은 공용 픽스처가 만든다. 회차·회원 id 는 그 예약에서 읽는다.
    ({ reservationId } = await insertReservationAndPayment(handle.pool));
    const { rows } = await q(
      `SELECT r.member_id, s.id AS session_id
         FROM reservations r JOIN class_sessions s ON s.offering_id = r.offering_id
        WHERE r.id = $1 ORDER BY s.seq LIMIT 1`,
      [reservationId],
    );
    memberId = rows[0].member_id;
    sessionId = rows[0].session_id;
    staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 강사', now())", [
      staffId,
      `attendance-test-${staffId}`,
    ]);
  });

  test("① 칸 목록·NULL 허용·기본값이 설계와 같다", async () => {
    const { rows } = await q(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'attendance_marks'`,
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([...COLUMNS].sort());
    const nullable = rows.filter((r) => r.is_nullable === "YES").map((r) => r.column_name).sort();
    expect(nullable).toEqual([...NULLABLE].sort());

    // 기본값 — 칸을 비우고 넣으면 이의 없음(none)·지금 시각이 들어간다
    const { rows: inserted } = await insertMark();
    expect(inserted[0].dispute_status).toBe("none");
    expect(inserted[0].marked_at).toBeInstanceOf(Date);
    expect(inserted[0].cancelled_at).toBeNull();
  });

  test("② marked_by_kind·dispute_status 는 설계의 값만 받는다", async () => {
    // 상수(앱 코드가 쓰는 값)와 DB 가 같은 값 집합을 갖는다
    expect([...ATTENDANCE_MARKED_BY_KINDS]).toEqual(["member", "instructor", "owner"]);
    expect([...ATTENDANCE_DISPUTE_STATUSES]).toEqual(["none", "requested", "accepted", "rejected"]);

    await insertMark(); // member
    await insertMark({ ...byInstructor(), cancelled_at: new Date() }); // instructor(앞 행과 안 겹치게 거둔 행으로)
    await insertMark({ marked_by_kind: "owner", marked_by_member_id: null, marked_by_staff_account_id: staffId, cancelled_at: new Date() });
    await expectViolation(
      insertMark({ marked_by_kind: "admin", marked_by_member_id: null, marked_by_staff_account_id: staffId, cancelled_at: new Date() }),
      "attendance_marks_marked_by_kind_check",
    );
    await expectViolation(
      insertMark({ ...byInstructor(), cancelled_at: new Date(), dispute_status: "pending", dispute_requested_at: new Date() }),
      "attendance_marks_dispute_status_check",
    );
  });

  test("③ uq_attendance_session — 같은 예약·회차의 살아 있는 결석 두 번째는 거부, 거둔 뒤에는 다시 표시할 수 있다", async () => {
    const { rows } = await insertMark();
    // 회원이 이미 알렸는데 강사가 또 표시 → 중복 거부(표시한 사람이 달라도 한 예약·한 회차에 하나)
    await expectViolation(insertMark(byInstructor()), "uq_attendance_session");
    await expectViolation(insertMark(), "uq_attendance_session");

    // 첫 표시를 거두면(cancelled_at) 같은 회차에 새로 표시할 수 있고, 거둔 행은 이력으로 남는다
    await q("UPDATE attendance_marks SET cancelled_at = now() WHERE id = $1", [rows[0].id]);
    await insertMark(byInstructor());
    const { rows: all } = await q(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE cancelled_at IS NULL)::int AS live FROM attendance_marks WHERE reservation_id = $1",
      [reservationId],
    );
    expect(all[0]).toEqual({ total: 2, live: 1 });

    // 같은 예약이라도 다른 회차면 따로 표시할 수 있다
    const otherSession = randomUUID();
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at)
       SELECT $1, offering_id, 2, now() + interval '14 days', now() + interval '14 days 2 hours' FROM reservations WHERE id = $2`,
      [otherSession, reservationId],
    );
    await insertMark({ session_id: otherSession });
  });

  test("④ ck_attendance_marker — 표시한 사람 칸이 종류와 짝이 맞아야 한다", async () => {
    // member 인데 회원 칸이 비었다
    await expectViolation(insertMark({ marked_by_member_id: null }), "ck_attendance_marker");
    // member 인데 직원 칸까지 채웠다
    await expectViolation(insertMark({ marked_by_staff_account_id: staffId }), "ck_attendance_marker");
    // instructor 인데 직원 칸이 비었다
    await expectViolation(
      insertMark({ marked_by_kind: "instructor", marked_by_member_id: null, marked_by_staff_account_id: null }),
      "ck_attendance_marker",
    );
    // owner 인데 회원 칸을 채웠다
    await expectViolation(
      insertMark({ marked_by_kind: "owner", marked_by_member_id: memberId, marked_by_staff_account_id: staffId }),
      "ck_attendance_marker",
    );
    // 맞는 짝은 들어간다
    await insertMark(byInstructor());
  });

  test("⑤ 이의 칸 — 강사·대표 표시 행에만, 신청·처리 시각이 상태와 짝", async () => {
    // 회원이 스스로 알린 결석 예정에는 이의를 걸 수 없다
    await expectViolation(
      insertMark({ dispute_status: "requested", dispute_requested_at: new Date() }),
      "ck_attendance_dispute_staff_only",
    );
    // 이의 신청인데 신청 시각이 없다 / 이의 없음인데 신청 시각이 있다
    await expectViolation(insertMark({ ...byInstructor(), dispute_status: "requested" }), "ck_attendance_dispute_requested");
    await expectViolation(insertMark({ ...byInstructor(), dispute_requested_at: new Date() }), "ck_attendance_dispute_requested");

    // 강사 표시 → 이의 신청 → 거절 처리까지 정상 흐름
    const { rows } = await insertMark({
      ...byInstructor(),
      dispute_status: "requested",
      dispute_requested_at: new Date(),
      dispute_reason: "그날 출석했어요",
    });
    const id = rows[0].id;
    // 처리하면서 처리자·처리 시각을 빼먹으면 거부
    await expectViolation(
      q("UPDATE attendance_marks SET dispute_status = 'rejected' WHERE id = $1", [id]),
      "ck_attendance_dispute_resolved",
    );
    await expectViolation(
      q("UPDATE attendance_marks SET dispute_status = 'rejected', dispute_resolved_at = now() WHERE id = $1", [id]),
      "ck_attendance_dispute_resolved",
    );
    // 아직 신청 상태인데 처리 시각을 채우면 거부
    await expectViolation(
      q("UPDATE attendance_marks SET dispute_resolved_at = now(), dispute_resolved_by_account_id = $2 WHERE id = $1", [id, staffId]),
      "ck_attendance_dispute_resolved",
    );
    await q(
      "UPDATE attendance_marks SET dispute_status = 'rejected', dispute_resolved_at = now(), dispute_resolved_by_account_id = $2 WHERE id = $1",
      [id, staffId],
    );
    // 받아들임(accepted)은 그 행을 거둔다(cancelled_at) — 거둔 뒤에는 살아 있는 결석이 없다
    // 거절된 결석은 아직 살아 있으므로 같은 회차에 또 못 쓴다
    await expectViolation(insertMark(byInstructor()), "uq_attendance_session");
    await q(
      "UPDATE attendance_marks SET dispute_status = 'accepted', cancelled_at = now() WHERE id = $1",
      [id],
    );
    const { rows: live } = await q("SELECT count(*)::int AS n FROM attendance_marks WHERE cancelled_at IS NULL");
    expect(live[0].n).toBe(0);
  });

  test("⑥ 외래 키 — 없는 예약·회차·회원·직원은 거부", async () => {
    await expectViolation(insertMark({ reservation_id: randomUUID() }), "attendance_marks_reservation_id_fkey");
    await expectViolation(insertMark({ session_id: randomUUID() }), "attendance_marks_session_id_fkey");
    await expectViolation(insertMark({ member_id: randomUUID() }), "attendance_marks_member_id_fkey");
    const ghost = randomUUID();
    await expectViolation(insertMark({ marked_by_member_id: ghost }), "attendance_marks_marked_by_member_id_fkey");
    await expectViolation(
      insertMark({ marked_by_kind: "instructor", marked_by_member_id: null, marked_by_staff_account_id: ghost }),
      "attendance_marks_marked_by_staff_account_id_fkey",
    );
    const { rows } = await insertMark({
      ...byInstructor(),
      dispute_status: "requested",
      dispute_requested_at: new Date(),
    });
    await expectViolation(
      q(
        "UPDATE attendance_marks SET dispute_status = 'rejected', dispute_resolved_at = now(), dispute_resolved_by_account_id = $2 WHERE id = $1",
        [rows[0].id, ghost],
      ),
      "attendance_marks_dispute_resolved_by_account_id_fkey",
    );
  });
});
