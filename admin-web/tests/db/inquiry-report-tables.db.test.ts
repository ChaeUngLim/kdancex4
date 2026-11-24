// S7-2.1(문의·답변·신고 테이블) — 문의(inquiries) · 문의 글(inquiry_messages) · 신고(reports) 세 표가 실제 PostgreSQL 에서
// 설계(data-model §12 「문의」·「신고·이용 제한」 · §12-9 값 집합)대로 지켜지는지 확인한다.
//   이름: 로드맵 verify 의 tests/db/s7-2-1.db.test.ts 는 Task 번호 이름이라 기능 이름(inquiry-report-tables)으로 바꿨다(증거 EVIDENCE.md 에 기록).
// 확인하는 것:
//   ① 세 표의 기본값(사람 경로·답변 대기·접수)과 추가 전용 트리거가 있다
//   ② 문의자는 회원·직원 중 정확히 하나, 학원 문의에만 학원 번호, 예약은 회원 문의만, 닫힌 문의만 닫은 시각
//   ③ 값 집합 — 문의 종류 칩 11개(강사 칩은 「출석」이 아니라 「결석」 absence, D10), 받는 곳·상태
//   ④ 같은 사람이 같은 Idempotency-Key 로 두 번 보내면 두 번째는 거부(회원·직원 따로)
//   ⑤ 문의 글 — 보낸 쪽과 번호 칸의 짝, 1~2000자, 고치기·지우기는 트리거가 거부(추가 전용)
//   ⑥ 신고 — 신고자 짝, 처리 끝이면 결과·시각 필수, 처리 전 같은 신고는 하나만(처리 뒤엔 다시 가능), 사유 값 집합
//   ⑦ FK — 없는 회원·학원·예약·문의를 가리키면 거부
//   ⑧ 대표 문의함·재알림 작업 조회가 설계한 색인을 탄다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { INQUIRY_CATEGORIES, REPORT_REASON_CODES } from "../../lib/domain/constants";
import { insertOffering, insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("문의·답변·신고 표(S7-2.1)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const member = randomUUID();
  const otherMember = randomUUID();
  const instructor = randomUUID();
  const operator = randomUUID();
  let academyId = "";
  let offeringId = "";
  let reservationId = "";
  let reservationMember = "";

  // 제약 위반이 나는지, 그 제약 이름이 맞는지 본다. 이름 뒤에는 8자리 해시가 붙으므로 「포함」으로 본다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 표 하나에 한 줄을 넣는다. 칸 이름은 이 파일이 정한 상수뿐이라 SQL 에 그대로 이어 붙여도 안전하다.
  async function insertRow(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${marks}) RETURNING *`,
      cols.map((k) => row[k]),
    );
    return result.rows[0] as Record<string, unknown>;
  }

  // 문의 한 건. 기본은 「회원이 학원에 수업 문의」, 기한은 내일.
  const insertInquiry = (overrides: Record<string, unknown> = {}) =>
    insertRow("inquiries", {
      id: randomUUID(),
      kind: "academy",
      asker_kind: "member",
      asker_member_id: member,
      academy_id: academyId,
      category: "class",
      first_response_due_at: new Date(Date.now() + 24 * 3600 * 1000),
      idempotency_key: `idem-${randomUUID()}`,
      ...overrides,
    });

  // 문의 글 한 줄. 기본은 문의자(회원)의 글.
  const insertMessage = (inquiryId: string, overrides: Record<string, unknown> = {}) =>
    insertRow("inquiry_messages", {
      id: randomUUID(),
      inquiry_id: inquiryId,
      sender_kind: "asker",
      sender_member_id: member,
      body: "다음 주 수업에 신발은 무엇을 신나요?",
      ...overrides,
    });

  // 신고 한 건. 기본은 「회원이 학원을 플랫폼 밖 결제 유도로 신고」.
  const insertReport = (overrides: Record<string, unknown> = {}) =>
    insertRow("reports", {
      id: randomUUID(),
      reporter_kind: "member",
      reporter_member_id: member,
      target_kind: "academy",
      target_id: academyId,
      reason_code: "off_platform_payment",
      idempotency_key: `idem-${randomUUID()}`,
      ...overrides,
    });

  // 색인을 쓰는지 본다. 행이 적으면 플래너가 순차 탐색을 고르므로, 이 연결에서만 순차 탐색을 끄고 계획을 읽는다.
  const planOf = async (sql: string, params: unknown[]) => {
    const client = await handle.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(`EXPLAIN ${sql}`, params);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  };

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    for (const id of [member, otherMember]) {
      await q(
        `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
         VALUES ($1, $2, '문의 시험 회원', 'female', '1995-03-01', '010-0000-0000', $3, '문의 시험', now(), now())`,
        [id, `inquiry-tables-member-${id}`, `ci-inquiry-tables-${id}`],
      );
    }
    for (const [id, name] of [
      [instructor, "문의 시험 강사"],
      [operator, "문의 시험 운영자"],
    ] as const) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, $3, now())", [
        id,
        `inquiry-tables-staff-${id}`,
        name,
      ]);
    }
    ({ academyId, offeringId } = await insertOffering(handle.pool));
    ({ reservationId } = await insertReservationAndPayment(handle.pool));
    const { rows } = await q("SELECT member_id FROM reservations WHERE id = $1", [reservationId]);
    reservationMember = rows[0].member_id as string;
  });

  afterAll(async () => {
    if (!handle) return;
    const people = [member, otherMember, reservationMember];
    const staff = [instructor, operator];
    // 문의 글은 추가 전용이라 DELETE 를 트리거가 막는다. 시험 행 정리 때만 이 연결에서 잠깐 끄고 지운 뒤 다시 켠다.
    const client = await handle.pool.connect();
    try {
      await client.query("ALTER TABLE inquiry_messages DISABLE TRIGGER USER");
      await client.query(
        `DELETE FROM inquiry_messages WHERE inquiry_id IN (
           SELECT id FROM inquiries WHERE asker_member_id = ANY($1::uuid[]) OR asker_staff_account_id = ANY($2::uuid[]))`,
        [people, staff],
      );
      await client.query("ALTER TABLE inquiry_messages ENABLE TRIGGER USER");
    } finally {
      client.release();
    }
    await q("DELETE FROM inquiries WHERE asker_member_id = ANY($1::uuid[]) OR asker_staff_account_id = ANY($2::uuid[])", [
      people,
      staff,
    ]);
    await q(
      "DELETE FROM reports WHERE reporter_member_id = ANY($1::uuid[]) OR reporter_staff_account_id = ANY($2::uuid[]) OR resolved_by_account_id = ANY($2::uuid[])",
      [people, staff],
    );
    await q("DELETE FROM members WHERE id = ANY($1::uuid[])", [[member, otherMember]]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1::uuid[])", [staff]);
    await closeTestDb(handle);
  });

  test("① 기본값은 사람 경로·답변 대기·접수이고, 문의 글 추가 전용 트리거가 있다", async () => {
    const inquiry = await insertInquiry();
    expect(inquiry.route).toBe("human");
    expect(inquiry.status).toBe("answer_waiting");
    expect(inquiry.last_message_at).toBeInstanceOf(Date);
    expect(inquiry.closed_at).toBeNull();
    expect(inquiry.overdue_reminded_at).toBeNull();

    const message = await insertMessage(inquiry.id as string);
    expect(message.created_at).toBeInstanceOf(Date);

    const report = await insertReport();
    expect(report.status).toBe("received");
    expect(report.outcome).toBeNull();
    expect(report.received_at).toBeInstanceOf(Date);

    const { rows } = await q(
      "SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.inquiry_messages'::regclass AND NOT tgisinternal",
    );
    expect(rows.map((r) => r.tgname)).toEqual(["trg_inquiry_messages_append_only"]);
    // restriction_cases 는 S7-2.6(이용 제한 절차)이, attachment_links 는 S7-2.7(문의·신고 첨부 파일)이,
    // restriction_explanations 는 S1-1.29(소명 기한 지남 → 운영자 게시 중단)가 만들어 「아직 없어야 할 표」 검사를 뺐다.
  });

  test("② 문의자·받는 곳·예약·닫힘 짝이 맞지 않으면 거부한다", async () => {
    // 회원 문의인데 직원 번호까지 찼다 / 회원 번호가 없다
    await expectViolation(insertInquiry({ asker_staff_account_id: instructor }), "ck_inquiries_asker");
    await expectViolation(insertInquiry({ asker_member_id: null }), "ck_inquiries_asker");
    // 강사 문의인데 직원 번호가 없다 / 회원 번호가 찼다
    await expectViolation(insertInquiry({ asker_kind: "instructor", asker_member_id: null }), "ck_inquiries_asker");
    await expectViolation(
      insertInquiry({ asker_kind: "instructor", asker_staff_account_id: instructor }),
      "ck_inquiries_asker",
    );
    // 강사·대표 문의는 직원 번호만 있으면 된다
    const byInstructor = await insertInquiry({
      asker_kind: "instructor",
      asker_member_id: null,
      asker_staff_account_id: instructor,
      category: "absence",
    });
    expect(byInstructor.asker_staff_account_id).toBe(instructor);

    // 학원 문의에 학원이 없다 / 플랫폼 문의에 학원이 찼다
    await expectViolation(insertInquiry({ academy_id: null }), "ck_inquiries_target");
    await expectViolation(insertInquiry({ kind: "system", category: "account" }), "ck_inquiries_target");
    const system = await insertInquiry({ kind: "system", academy_id: null, category: "app_error" });
    expect(system.academy_id).toBeNull();

    // 예약은 회원 문의만 가리킨다
    await expectViolation(
      insertInquiry({
        asker_kind: "owner",
        asker_member_id: null,
        asker_staff_account_id: instructor,
        reservation_id: reservationId,
      }),
      "ck_inquiries_reservation_member",
    );
    const aboutReservation = await insertInquiry({
      asker_member_id: reservationMember,
      reservation_id: reservationId,
      offering_id: offeringId,
      category: "refund",
    });
    expect(aboutReservation.reservation_id).toBe(reservationId);

    // 닫힌 문의만 닫은 시각이 있다
    await expectViolation(insertInquiry({ status: "closed" }), "ck_inquiries_closed");
    await expectViolation(insertInquiry({ closed_at: new Date() }), "ck_inquiries_closed");
    const closed = await insertInquiry({ status: "closed", closed_at: new Date() });
    expect(closed.status).toBe("closed");
  });

  test("③ 문의 종류 칩은 11개 값만 받고, 강사 칩은 「결석」(absence)이다", async () => {
    expect(INQUIRY_CATEGORIES).toHaveLength(11);
    for (const category of INQUIRY_CATEGORIES) {
      const row = await insertInquiry({ category });
      expect(row.category).toBe(category);
    }
    // D10: 「출석」(attendance)이 아니라 「결석」(absence)으로 통일했다 — 옛 이름은 들어가지 않는다.
    for (const bad of ["attendance", "Absence", "", "refund_request"]) {
      await expectViolation(insertInquiry({ category: bad }), "inquiries_category_check");
    }
    // 다른 CHECK 에 먼저 걸리지 않게 학원 칸을 비운다 — 그래야 값 집합 CHECK 하나만 남는다.
    await expectViolation(insertInquiry({ kind: "platform", academy_id: null }), "inquiries_kind_check");
    await expectViolation(insertInquiry({ status: "pending" }), "inquiries_status_check");
    await expectViolation(insertInquiry({ route: "ai" }), "inquiries_route_check");
    // asker_kind 가 member 가 아니면 직원 번호가 있어야 짝 CHECK 를 지난다.
    await expectViolation(
      insertInquiry({ asker_kind: "operator", asker_member_id: null, asker_staff_account_id: instructor }),
      "inquiries_asker_kind_check",
    );
  });

  test("④ 같은 사람이 같은 Idempotency-Key 로 두 번 보내면 두 번째는 거부한다", async () => {
    const key = `idem-same-${randomUUID()}`;
    await insertInquiry({ idempotency_key: key });
    await expectViolation(insertInquiry({ idempotency_key: key }), "uq_inquiries_idem_member");
    // 다른 회원이 우연히 같은 열쇠를 써도 된다
    const other = await insertInquiry({ asker_member_id: otherMember, idempotency_key: key });
    expect(other.idempotency_key).toBe(key);

    const staffInquiry = {
      asker_kind: "instructor",
      asker_member_id: null,
      asker_staff_account_id: instructor,
      category: "capacity",
      idempotency_key: key,
    };
    await insertInquiry(staffInquiry);
    await expectViolation(insertInquiry(staffInquiry), "uq_inquiries_idem_staff");
    await expectViolation(insertInquiry({ idempotency_key: "" }), "ck_inquiries_idempotency_key");
    await expectViolation(insertInquiry({ idempotency_key: "k".repeat(201) }), "value too long");
  });

  test("⑤ 문의 글은 보낸 쪽 짝·1~2000자를 지키고, 고치거나 지울 수 없다", async () => {
    const inquiry = await insertInquiry();
    const id = inquiry.id as string;

    // 보낸 쪽 짝
    await expectViolation(insertMessage(id, { sender_member_id: null }), "ck_inquiry_messages_sender");
    await expectViolation(insertMessage(id, { sender_staff_account_id: instructor }), "ck_inquiry_messages_sender");
    await expectViolation(
      insertMessage(id, { sender_kind: "academy_owner", sender_member_id: null }),
      "ck_inquiry_messages_sender",
    );
    await expectViolation(
      insertMessage(id, { sender_kind: "operator", sender_staff_account_id: operator }),
      "ck_inquiry_messages_sender",
    );
    await expectViolation(insertMessage(id, { sender_kind: "ai" }), "ck_inquiry_messages_sender");
    // 모르는 보낸 쪽은 짝 CHECK(어느 갈래에도 안 맞음)가 먼저 거부한다 — 어느 쪽이든 들어가지 않으면 된다.
    await expectViolation(insertMessage(id, { sender_kind: "bot" }), "inquiry_messages_sender");
    const owner = await insertMessage(id, {
      sender_kind: "academy_owner",
      sender_member_id: null,
      sender_staff_account_id: instructor,
      body: "재즈화나 굽 낮은 신발이면 됩니다.",
    });
    expect(owner.sender_kind).toBe("academy_owner");
    await insertMessage(id, { sender_kind: "operator", sender_member_id: null, sender_staff_account_id: operator });
    await insertMessage(id, { sender_kind: "ai", sender_member_id: null, body: "AI 답변입니다." });
    // 강사·대표가 문의자일 때는 직원 번호로 쓴다
    await insertMessage(id, { sender_member_id: null, sender_staff_account_id: instructor });

    // 길이
    await expectViolation(insertMessage(id, { body: "" }), "ck_inquiry_messages_body");
    await expectViolation(insertMessage(id, { body: "가".repeat(2001) }), "ck_inquiry_messages_body");
    const longest = await insertMessage(id, { body: "가".repeat(2000) });
    expect((longest.body as string).length).toBe(2000);

    // 추가 전용 — 고치기·지우기 모두 트리거가 거부한다
    const updateError = await q("UPDATE inquiry_messages SET body = '고친 답변' WHERE id = $1", [owner.id]).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
    expect(updateError?.code).toBe("42501");
    expect(updateError?.message).toContain("inquiry_messages 는 추가 전용입니다");
    const deleteError = await q("DELETE FROM inquiry_messages WHERE id = $1", [owner.id]).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    );
    expect(deleteError?.code).toBe("42501");
    const { rows } = await q("SELECT body FROM inquiry_messages WHERE id = $1", [owner.id]);
    expect(rows[0].body).toBe("재즈화나 굽 낮은 신발이면 됩니다.");
  });

  test("⑥ 신고는 신고자 짝·처리 결과를 지키고, 처리 전 같은 신고는 하나만 있다", async () => {
    // 신고자 짝
    await expectViolation(insertReport({ reporter_member_id: null }), "ck_reports_reporter");
    await expectViolation(insertReport({ reporter_staff_account_id: instructor }), "ck_reports_reporter");
    await expectViolation(insertReport({ reporter_kind: "owner", reporter_member_id: null }), "ck_reports_reporter");

    // 처리 끝 ↔ 결과·시각
    await expectViolation(insertReport({ status: "resolved" }), "ck_reports_resolved");
    await expectViolation(insertReport({ status: "resolved", outcome: "upheld" }), "ck_reports_resolved");
    await expectViolation(insertReport({ outcome: "dismissed" }), "ck_reports_resolved");
    await expectViolation(insertReport({ status: "in_review", resolved_at: new Date() }), "ck_reports_resolved");
    await expectViolation(
      insertReport({ status: "resolved", outcome: "accepted", resolved_at: new Date() }),
      "reports_outcome_check",
    );

    // 처리 전 같은 (신고자, 대상, 사유)는 하나만
    const target = randomUUID();
    const first = await insertReport({ target_kind: "class", target_id: target, reason_code: "info_mismatch" });
    await expectViolation(
      insertReport({ target_kind: "class", target_id: target, reason_code: "info_mismatch" }),
      "uq_reports_open_member",
    );
    // 다른 사유는 따로 받는다
    await insertReport({ target_kind: "class", target_id: target, reason_code: "harassment" });
    // 처리하고 나면 같은 신고를 다시 낼 수 있다
    await q(
      "UPDATE reports SET status = 'resolved', outcome = 'dismissed', resolved_at = now(), resolved_by_account_id = $2 WHERE id = $1",
      [first.id, operator],
    );
    const again = await insertReport({ target_kind: "class", target_id: target, reason_code: "info_mismatch" });
    expect(again.status).toBe("received");

    // 직원 신고자도 같은 규칙
    const staffReport = {
      reporter_kind: "instructor",
      reporter_member_id: null,
      reporter_staff_account_id: instructor,
      target_kind: "member",
      target_id: otherMember,
      reason_code: "harassment",
    };
    await insertReport(staffReport);
    await expectViolation(insertReport(staffReport), "uq_reports_open_staff");

    // 같은 열쇠 두 번
    const key = `idem-report-${randomUUID()}`;
    await insertReport({ idempotency_key: key, target_id: randomUUID() });
    await expectViolation(insertReport({ idempotency_key: key, target_id: randomUUID() }), "uq_reports_idem_member");

    // 사유·대상·상태 값 집합
    for (const reason of REPORT_REASON_CODES) {
      const row = await insertReport({ reason_code: reason, target_id: randomUUID() });
      expect(row.reason_code).toBe(reason);
    }
    await expectViolation(insertReport({ reason_code: "spam", target_id: randomUUID() }), "reports_reason_code_check");
    await expectViolation(insertReport({ target_kind: "review", target_id: randomUUID() }), "reports_target_kind_check");
    await expectViolation(insertReport({ status: "closed", target_id: randomUUID() }), "reports_status_check");
  });

  test("⑦ 없는 회원·직원·학원·예약·신청 단위·문의를 가리키면 거부한다", async () => {
    const ghost = randomUUID();
    await expectViolation(insertInquiry({ asker_member_id: ghost }), "inquiries_asker_member_id_fkey");
    await expectViolation(
      insertInquiry({ asker_kind: "owner", asker_member_id: null, asker_staff_account_id: ghost }),
      "inquiries_asker_staff_account_id_fkey",
    );
    await expectViolation(insertInquiry({ academy_id: ghost }), "inquiries_academy_id_fkey");
    await expectViolation(insertInquiry({ reservation_id: ghost }), "inquiries_reservation_id_fkey");
    await expectViolation(insertInquiry({ offering_id: ghost }), "inquiries_offering_id_fkey");
    await expectViolation(insertMessage(ghost), "inquiry_messages_inquiry_id_fkey");
    const inquiry = await insertInquiry();
    await expectViolation(
      insertMessage(inquiry.id as string, { sender_kind: "operator", sender_member_id: null, sender_staff_account_id: ghost }),
      "inquiry_messages_sender_staff_account_id_fkey",
    );
    await expectViolation(insertReport({ reporter_member_id: ghost }), "reports_reporter_member_id_fkey");
    await expectViolation(
      insertReport({
        status: "resolved",
        outcome: "upheld",
        resolved_at: new Date(),
        resolved_by_account_id: ghost,
        target_id: randomUUID(),
      }),
      "reports_resolved_by_account_id_fkey",
    );
    // 대상 id·환불 요청은 FK 가 없다(대상은 종류마다 표가 다르고, 환불 요청은 S7-2.4 가 잇는다).
    // 이용 제한 절차는 S7-2.6 이 FK 를 붙였다 — 없는 절차를 가리키면 거부한다.
    const loose = await insertReport({ target_id: ghost });
    expect(loose.target_id).toBe(ghost);
    await expectViolation(insertReport({ target_id: randomUUID(), restriction_case_id: ghost }), "reports_restriction_case_id_fkey");
    const withRefund = await insertInquiry({ refund_request_id: randomUUID(), category: "refund" });
    expect(withRefund.refund_request_id).not.toBeNull();
  });

  test("⑧ 대표 문의함·재알림 작업·신고 목록 조회가 설계한 색인을 탄다", async () => {
    const inbox = await planOf(
      "SELECT id FROM inquiries WHERE academy_id = $1 AND status = 'answer_waiting' ORDER BY created_at DESC LIMIT 20",
      [academyId],
    );
    expect(inbox).toContain("ix_inquiries_academy_status");

    const overdue = await planOf(
      "SELECT id FROM inquiries WHERE status = 'answer_waiting' AND overdue_reminded_at IS NULL AND first_response_due_at < $1",
      [new Date()],
    );
    expect(overdue).toContain("ix_inquiries_overdue");

    const thread = await planOf("SELECT id FROM inquiry_messages WHERE inquiry_id = $1 ORDER BY created_at", [
      randomUUID(),
    ]);
    expect(thread).toContain("ix_inquiry_messages_inquiry");

    const reports = await planOf("SELECT id FROM reports WHERE status = 'received' ORDER BY received_at LIMIT 50", []);
    expect(reports).toContain("ix_reports_status");
  });
});
