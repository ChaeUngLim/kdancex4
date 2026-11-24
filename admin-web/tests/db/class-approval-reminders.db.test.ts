// S2-2.12(수업 승인 24시간 재알림 작업) — 승인 요청 뒤 24시간 안에 대표가 답하지 않으면 대표에게 같은 알림을 한 번만 더 보낸다(FR-050a).
//   계약: _workspace/03_contracts/11-instructor.md §7(알림 `class_approval_reminder`) · §12(시간 작업 class-approval-reminders)
//   verify 의 이름은 tests/db/s2-2-12.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 24시간 지난 승인 대기 수업에 대표 알림 1건 + approval_reminded_at 기록(정확히 24시간도 포함)
//   ② 두 번 불러도 알림은 1건(두 번째 processed 0)
//   ③ 23시간 된 수업은 0건 — 표시도 하지 않는다. 승인 대기가 아닌 수업(draft·published)도 0건
//   ④ 반려 뒤 다시 낸 요청(rev2)은 새 승인 요청이라 그 요청에 대해 다시 한 번(열쇠 rev2)
//   ⑤ 내부 경로: 토큰 없으면 401, 맞으면 200 `{ processed }`
// 테스트 DB 를 비우고 시작해서 processed 숫자를 그대로 단언한다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { runClassApprovalReminders } from "@/lib/server/services/class-approval-reminders";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 작업이 도는 시각 — 2026-11-22 12:00 KST
const NOW = Temporal.Instant.from("2026-11-22T03:00:00Z");
const hoursAgo = (h: number) => NOW.subtract({ hours: h }).toString();

describe.skipIf(!dbAvailable())("수업 승인 24시간 재알림(계약 11 §12, S2-2.12)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  let ownerId = "";
  let instructorId = "";
  let academyId = "";
  const run = () => runClassApprovalReminders({ db: handle.db, clock: fixedClock(NOW) });

  async function makeStaff(name: string): Promise<string> {
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      `auth-${id}`,
      name,
    ]);
    return id;
  }

  /** 수업 한 개 — 상태와 승인 요청 시각을 고른다. 제출 기록(class_approvals submitted)도 revisions 개수만큼 남긴다 */
  async function makeClass(status: string, submittedAt: string | null, options: { revisions?: number; remindedAt?: string } = {}) {
    const id = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, submitted_at,
                            approved_at, approval_reminded_at, instructor_account_id, created_by_account_id, updated_at)
       VALUES ($1, $2, '살사 입문 8주', '김강사', 'salsa_bachata', 'regular', 'gender_split', $3, $4::timestamptz,
               CASE WHEN $3 = 'published' THEN now() END, $5::timestamptz, $6, $6, now())`,
      [id, academyId, status, submittedAt, options.remindedAt ?? null, instructorId],
    );
    for (let n = 1; n <= (options.revisions ?? (submittedAt === null ? 0 : 1)); n += 1) {
      await q("INSERT INTO class_approvals (id, class_id, action, actor_account_id, revision_no) VALUES (uuidv7(), $1, 'submitted', $2, $3)", [
        id,
        instructorId,
        n,
      ]);
    }
    return id;
  }

  const reminders = async () =>
    (
      await q(
        `SELECT recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload
         FROM notifications WHERE kind = 'class_approval_reminder' ORDER BY dedupe_key`,
      )
    ).rows;
  const remindedAt = async (classId: string) =>
    (await q("SELECT approval_reminded_at FROM classes WHERE id = $1", [classId])).rows[0].approval_reminded_at as Date | null;

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
    ownerId = await makeStaff("박대표");
    instructorId = await makeStaff("김강사");
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '재알림 시험 학원', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id, status) VALUES (uuidv7(), $1, $2, 'active')", [academyId, ownerId]);
  });
  afterAll(async () => {
    await truncateAll(handle.pool);
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 24시간 지난 승인 대기 수업에 대표 알림 1건이 쌓이고 재알림 시각이 기록된다(정확히 24시간도 포함)", async () => {
    const late = await makeClass("pending_approval", hoursAgo(25));
    const exact = await makeClass("pending_approval", hoursAgo(24));

    const result = await run();

    expect(result).toEqual({ processed: 2 });
    const rows = await reminders();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual([`class:${exact}:rev1:reminder`, `class:${late}:rev1:reminder`].sort());
    const lateRow = rows.find((r) => r.dedupe_key === `class:${late}:rev1:reminder`);
    expect(lateRow).toMatchObject({
      recipient_staff_account_id: ownerId,
      academy_id: academyId,
      category: "approval",
      kind: "class_approval_reminder",
      payload: { classId: late, title: "살사 입문 8주", instructorName: "김강사", submittedAt: hoursAgo(25) },
    });
    expect((await remindedAt(late))?.toISOString()).toBe(new Date(NOW.toString()).toISOString());
    expect((await remindedAt(exact))?.toISOString()).toBe(new Date(NOW.toString()).toISOString());
  });

  test("② 두 번 불러도 알림은 1건 — 두 번째는 processed 0", async () => {
    const late = await makeClass("pending_approval", hoursAgo(30));

    expect(await run()).toEqual({ processed: 1 });
    expect(await run()).toEqual({ processed: 0 });

    const rows = await reminders();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`class:${late}:rev1:reminder`);
  });

  test("③ 23시간 된 수업은 0건이고 표시도 하지 않는다 · 승인 대기가 아닌 수업도 0건", async () => {
    const young = await makeClass("pending_approval", hoursAgo(23));
    await makeClass("draft", hoursAgo(48));
    await makeClass("published", hoursAgo(48));

    expect(await run()).toEqual({ processed: 0 });
    expect(await reminders()).toHaveLength(0);
    expect(await remindedAt(young)).toBeNull();
  });

  test("④ 반려 뒤 다시 낸 요청(rev2)은 새 승인 요청이라 한 번 더 — 열쇠는 rev2", async () => {
    // rev1 때 이미 재알림을 보냈고(48시간 전), 반려 뒤 30시간 전에 다시 냈다
    const resubmitted = await makeClass("pending_approval", hoursAgo(30), { revisions: 2, remindedAt: hoursAgo(48) });

    expect(await run()).toEqual({ processed: 1 });
    expect(await run()).toEqual({ processed: 0 });
    const rows = await reminders();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe(`class:${resubmitted}:rev2:reminder`);
  });

  describe("⑤ 내부 경로 POST /api/internal/jobs/class-approval-reminders", () => {
    const TOKEN = "test-internal-token-class-approval-reminders";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/class-approval-reminders/route");
      return POST(
        new Request("http://localhost/api/internal/jobs/class-approval-reminders", { method: "POST", headers, body }),
        undefined,
      );
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
    });

    test("토큰이 없으면 401 이고 알림이 쌓이지 않는다", async () => {
      await makeClass("pending_approval", hoursAgo(25));
      const response = await call({ "Content-Type": "application/json" });
      expect(response.status).toBe(401);
      expect(await reminders()).toHaveLength(0);
    });

    test("토큰이 맞으면 200 { processed } — 시험용 시계(asOf)로 24시간을 잰다 · 모르는 칸은 422", async () => {
      await makeClass("pending_approval", hoursAgo(25));
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ processed: 1 });
      expect(await reminders()).toHaveLength(1);

      const again = await call(headers, JSON.stringify({ asOf: NOW.toString() }));
      expect(await again.json()).toEqual({ processed: 0 });

      const wrong = await call(headers, JSON.stringify({ hours: 1 }));
      expect(wrong.status).toBe(422);
    });
  });
});
