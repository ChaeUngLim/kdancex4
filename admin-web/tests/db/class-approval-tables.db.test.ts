// S2-2.1(수업 승인 기록 테이블) — 수업 승인 상태(classes.status)와 승인 기록(class_approvals)이
// data-model §8-2·§8-4·§8-7 그대로 실제 PostgreSQL 에 있는지, 그리고 값 집합 밖의 상태·행동을 DB 가 직접 거부하는지 확인한다.
//
// 「초안·승인 대기·게시·반려」가 DB 에 어떻게 담기나:
//   초안 = classes.status 'draft' · 승인 대기 = 'pending_approval' · 게시 = 'published'
//   반려 = 상태가 아니라 기록이다. 대표가 수정을 요청하면 수업은 draft 로 돌아가고(§8-8),
//          class_approvals 에 action 'revision_requested' + 사유 한 줄, classes.last_revision_reason 에 마지막 사유가 남는다.
//   (상태 전이 자체 — 조건부 갱신 한 문장 — 는 S2-2.7(대표 승인·반려·게시) 몫이라 여기서는 행을 직접 써서 칸과 제약만 본다.)
//
// 확인하는 것:
//   ① 칸 목록 — classes 의 승인 칸 · class_approvals 칸이 설계와 정확히 같다
//   ② 상태 값 집합 — 네 값은 들어가고, 그 밖(rejected·approved·빈 문자열 등)은 classes_status_check 가 거부한다. 새 행 기본값은 draft
//   ③ 행동 값 집합 — 여덟 값은 들어가고, 그 밖은 class_approvals_action_check 가 거부한다
//   ④ ck_classes_approved — 승인 시각 없이 published·cancelled 로 둘 수 없다
//   ⑤ 반려 사유 — revision_requested 에만 사유(1~200자), 다른 행동에는 사유 없음 · classes.last_revision_reason 도 1~200자
//   ⑥ uq_class_approvals_submit — 같은 수업 같은 제출 번호의 「제출」은 하나뿐(승인·반려는 같은 번호로 여러 줄 가능) · 제출 번호 1 이상
//   ⑦ 외래 키 — 없는 수업·없는 직원을 가리키는 기록은 거부
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CLASS_APPROVAL_ACTIONS, CLASS_STATUSES } from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

// data-model §8-2 classes 에서 이 Task 가 더한 승인 칸 · §8-4 class_approvals 칸. 설계 원본과 DB 를 잇는 짝이다.
const APPROVAL_COLUMNS_ON_CLASSES = [
  "status",
  "submitted_at",
  "approved_at",
  "approved_by_account_id",
  "last_revision_reason",
  "last_revision_at",
  "approval_reminded_at",
];
const CLASS_APPROVALS_COLUMNS = ["id", "class_id", "action", "actor_account_id", "reason", "revision_no", "created_at"];

describe.skipIf(!dbAvailable())("수업 승인 상태·승인 기록(classes.status · class_approvals)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 학원·직원 id — 끝나고 이것만 지운다.
  const academyId = randomUUID();
  const instructorId = randomUUID();
  const ownerId = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름(뒤에 해시가 붙는다)이 담긴다.
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 수업 한 줄을 넣는다. status 를 안 주면 DB 기본값(draft)을 쓴다.
  async function insertClass(fields: { status?: string; approvedAt?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    const hasStatus = fields.status !== undefined;
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at${hasStatus ? ", status, approved_at" : ""})
       VALUES ($1, $2, '승인 시험 수업', '시험 강사', 'salsa_bachata', 'regular', 'gender_split', now()${hasStatus ? ", $3, $4" : ""})`,
      hasStatus ? [id, academyId, fields.status, fields.approvedAt ?? null] : [id, academyId],
    );
    return id;
  }

  // 승인 기록 한 줄을 넣는다.
  const insertApproval = (fields: {
    classId: string;
    action: string;
    actor?: string;
    reason?: string | null;
    revisionNo?: number;
  }) =>
    q(
      `INSERT INTO class_approvals (id, class_id, action, actor_account_id, reason, revision_no)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        fields.classId,
        fields.action,
        fields.actor ?? instructorId,
        fields.reason ?? null,
        fields.revisionNo ?? 1,
      ],
    );

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 4 });
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '승인 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    for (const id of [instructorId, ownerId]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 직원', now())", [
        id,
        `class-approval-test-${id}`,
      ]);
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 승인 기록 → 수업 → 직원·학원.
    await q("DELETE FROM class_approvals WHERE class_id IN (SELECT id FROM classes WHERE academy_id = $1)", [academyId]);
    await q("DELETE FROM classes WHERE academy_id = $1", [academyId]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[instructorId, ownerId]]);
    await q("DELETE FROM academies WHERE id = $1", [academyId]);
    await closeTestDb(handle);
  });

  test("① 칸 목록 — classes 의 승인 칸과 class_approvals 칸이 설계와 같다", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('classes', 'class_approvals')`,
    );
    const columnsOf = (table: string) => rows.filter((r) => r.table_name === table).map((r) => r.column_name as string);
    expect(columnsOf("classes")).toEqual(expect.arrayContaining(APPROVAL_COLUMNS_ON_CLASSES));
    expect([...columnsOf("class_approvals")].sort()).toEqual([...CLASS_APPROVALS_COLUMNS].sort());

    // status 는 비울 수 없고 기본값이 draft 다. 나머지 승인 칸은 아직 일어나지 않은 일이라 비워 둘 수 있다.
    const status = rows.find((r) => r.table_name === "classes" && r.column_name === "status");
    expect(status?.is_nullable).toBe("NO");
    expect(String(status?.column_default)).toContain("'draft'");
    for (const name of APPROVAL_COLUMNS_ON_CLASSES.filter((c) => c !== "status")) {
      expect(rows.find((r) => r.table_name === "classes" && r.column_name === name)?.is_nullable, name).toBe("YES");
    }
    // 승인 기록은 사유만 비울 수 있다(반려에만 있다).
    for (const name of CLASS_APPROVALS_COLUMNS) {
      const nullable = rows.find((r) => r.table_name === "class_approvals" && r.column_name === name)?.is_nullable;
      expect(nullable, name).toBe(name === "reason" ? "YES" : "NO");
    }

    // 승인 대기 목록 색인과 기록 조회 색인이 있다.
    const { rows: indexes } = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('classes', 'class_approvals')`,
    );
    const def = (prefix: string) => indexes.find((i) => (i.indexname as string).startsWith(prefix))?.indexdef as string | undefined;
    expect(def("ix_classes_academy_status")).toContain("(academy_id, status)");
    expect(def("ix_class_approvals_class")).toContain("(class_id, created_at)");
    expect(def("uq_class_approvals_submit")).toMatch(/UNIQUE INDEX .*\(class_id, revision_no\) WHERE/);
  });

  test("② 상태 값 집합 — 네 값만 들어가고 그 밖은 거부한다, 새 수업은 draft 로 시작한다", async () => {
    // 기본값: status 를 안 주면 임시 저장(초안)이다.
    const fresh = await insertClass();
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [fresh]);
    expect(rows[0].status).toBe("draft");

    // 설계의 네 값(초안·승인 중·공개·폐강)은 모두 들어간다. 공개·폐강은 승인 시각이 있어야 한다(④).
    expect([...CLASS_STATUSES]).toEqual(["draft", "pending_approval", "published", "cancelled"]);
    for (const status of CLASS_STATUSES) {
      const needsApproval = status === "published" || status === "cancelled";
      await expect(insertClass({ status, approvedAt: needsApproval ? "2026-11-21T00:00:00Z" : null })).resolves.toBeTypeOf("string");
    }

    // 값 집합 밖: 「반려」를 상태로 두려는 시도(rejected)·승인 기록 값을 상태로 쓰는 실수(approved)·옛 이름·빈 값·대소문자.
    for (const outside of ["rejected", "approved", "revision_requested", "closed", "pending", "DRAFT", ""]) {
      await expectViolation(insertClass({ status: outside, approvedAt: "2026-11-21T00:00:00Z" }), "classes_status_check");
    }
    // 이미 있는 행을 값 집합 밖으로 바꾸는 것도 막힌다.
    await expectViolation(q("UPDATE classes SET status = 'rejected' WHERE id = $1", [fresh]), "classes_status_check");
    // NULL 도 안 된다.
    await expect(q("UPDATE classes SET status = NULL WHERE id = $1", [fresh])).rejects.toThrow(/null value/);
  });

  test("③ 행동 값 집합 — 여덟 값은 기록되고 그 밖은 거부한다", async () => {
    const classId = await insertClass({ status: "pending_approval" });
    expect([...CLASS_APPROVAL_ACTIONS]).toEqual([
      "submitted",
      "withdrawn",
      "approved",
      "revision_requested",
      "auto_published",
      "edit_approved",
      "edit_rejected",
      "closed",
    ]);
    // 제출 둘(submitted·auto_published)은 같은 번호로 겹치면 안 되니(⑥) 번호를 하나씩 올려 가며 넣는다.
    let revisionNo = 1;
    for (const action of CLASS_APPROVAL_ACTIONS) {
      await insertApproval({
        classId,
        action,
        actor: action === "submitted" || action === "withdrawn" ? instructorId : ownerId,
        reason: action === "revision_requested" ? "포스터 해상도가 낮아요" : null,
        revisionNo: revisionNo++,
      });
    }
    const { rows } = await q("SELECT action FROM class_approvals WHERE class_id = $1 ORDER BY revision_no", [classId]);
    expect(rows.map((r) => r.action)).toEqual([...CLASS_APPROVAL_ACTIONS]);

    // 값 집합 밖: 상태 이름(published·draft)·「반려」의 다른 말(rejected)·빈 값.
    for (const outside of ["rejected", "published", "draft", "pending_approval", "Approved", ""]) {
      await expectViolation(insertApproval({ classId, action: outside, actor: ownerId, revisionNo: 99 }), "class_approvals_action_check");
    }
  });

  test("④ ck_classes_approved — 승인 시각 없이 공개·폐강으로 둘 수 없다", async () => {
    await expectViolation(insertClass({ status: "published", approvedAt: null }), "ck_classes_approved");
    await expectViolation(insertClass({ status: "cancelled", approvedAt: null }), "ck_classes_approved");

    // 승인 중 → 공개 전이도 승인 시각·승인자를 같이 써야 통과한다(S2-2.7 의 조건부 갱신 모양).
    const classId = await insertClass({ status: "pending_approval" });
    await expectViolation(q("UPDATE classes SET status = 'published' WHERE id = $1", [classId]), "ck_classes_approved");
    const { rowCount } = await q(
      `UPDATE classes SET status = 'published', approved_at = now(), approved_by_account_id = $2
       WHERE id = $1 AND status = 'pending_approval'`,
      [classId, ownerId],
    );
    expect(rowCount).toBe(1);
  });

  test("⑤ 반려 사유 — revision_requested 에만 1~200자 사유, classes.last_revision_reason 도 1~200자", async () => {
    const classId = await insertClass({ status: "pending_approval" });
    // 반려인데 사유가 없거나 빈 문자열·201자면 거부한다.
    await expectViolation(insertApproval({ classId, action: "revision_requested", actor: ownerId, reason: null }), "ck_class_approvals_reason");
    await expectViolation(insertApproval({ classId, action: "revision_requested", actor: ownerId, reason: "" }), "ck_class_approvals_reason");
    await expectViolation(
      insertApproval({ classId, action: "revision_requested", actor: ownerId, reason: "가".repeat(201) }),
      "ck_class_approvals_reason",
    );
    // 다른 행동에 사유를 붙이면 거부한다(사유는 반려 기록에만 있다).
    await expectViolation(insertApproval({ classId, action: "approved", actor: ownerId, reason: "좋아요" }), "ck_class_approvals_reason");
    // 200자 사유는 들어간다.
    await insertApproval({ classId, action: "revision_requested", actor: ownerId, reason: "가".repeat(200) });

    // 수업 행의 마지막 반려 사유도 같은 길이 규칙이다.
    await expectViolation(q("UPDATE classes SET last_revision_reason = '' WHERE id = $1", [classId]), "ck_classes_revision");
    await expectViolation(
      q("UPDATE classes SET last_revision_reason = $2 WHERE id = $1", [classId, "가".repeat(201)]),
      "ck_classes_revision",
    );
    // 반려 = draft 로 되돌리고 사유·시각을 남긴다(§8-8). 상태 칸에는 draft 가 들어간다.
    const { rowCount } = await q(
      `UPDATE classes SET status = 'draft', last_revision_reason = '포스터 해상도가 낮아요', last_revision_at = now()
       WHERE id = $1 AND status = 'pending_approval'`,
      [classId],
    );
    expect(rowCount).toBe(1);
  });

  test("⑥ uq_class_approvals_submit — 같은 제출 번호의 「제출」은 하나뿐, 제출 번호는 1 이상", async () => {
    const classId = await insertClass({ status: "pending_approval" });
    await insertApproval({ classId, action: "submitted", revisionNo: 1 });
    // 두 번 누름·동시 요청: 같은 번호의 제출이 또 들어오면 거부한다. 대표 본인 바로 공개(auto_published)도 같은 묶음이다.
    await expectViolation(insertApproval({ classId, action: "submitted", revisionNo: 1 }), "uq_class_approvals_submit");
    await expectViolation(insertApproval({ classId, action: "auto_published", actor: ownerId, revisionNo: 1 }), "uq_class_approvals_submit");
    // 같은 번호의 반려·재제출 흐름: 반려(1) → 다시 제출(2) → 승인(2). 승인·반려는 번호가 겹쳐도 된다.
    await insertApproval({ classId, action: "revision_requested", actor: ownerId, reason: "시간을 고쳐 주세요", revisionNo: 1 });
    await insertApproval({ classId, action: "submitted", revisionNo: 2 });
    await insertApproval({ classId, action: "approved", actor: ownerId, revisionNo: 2 });
    await insertApproval({ classId, action: "edit_approved", actor: ownerId, revisionNo: 2 });
    const { rows } = await q("SELECT action, revision_no FROM class_approvals WHERE class_id = $1 ORDER BY created_at, revision_no", [classId]);
    expect(rows).toHaveLength(5);

    // 제출 번호는 1부터다.
    await expectViolation(insertApproval({ classId, action: "approved", actor: ownerId, revisionNo: 0 }), "ck_class_approvals_revision_no");
  });

  test("⑦ 외래 키 — 없는 수업·없는 직원을 가리키는 기록, 없는 직원을 승인자로 두는 수업은 거부한다", async () => {
    const classId = await insertClass({ status: "pending_approval" });
    await expectViolation(insertApproval({ classId: randomUUID(), action: "submitted" }), "class_approvals_class_id_fkey");
    await expectViolation(insertApproval({ classId, action: "submitted", actor: randomUUID() }), "class_approvals_actor_account_id_fkey");
    await expectViolation(
      q("UPDATE classes SET approved_by_account_id = $2 WHERE id = $1", [classId, randomUUID()]),
      "classes_approved_by_account_id_fkey",
    );
  });
});
