// S3-4.3b(결석 표시 48시간 확정 작업) — `POST /api/internal/jobs/absence-lock`(계약 04 §7)
//   verify: 끝난 지 49시간째 새 결석 표시가 거부된다 · skip 0
//   이름: verify 의 tests/db/s3-4-3b.db.test.ts 는 Task 번호 이름이라 기능 이름(absence-lock)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 끝 + 48시간이 지난 회차만 잠금 기록(감사 attendance.session_locked 1행, 시스템 · 학원 칸 · after.markCount = 살아 있는 결석 수).
//      47시간째 · 정확히 48시간째 회차는 아직 잠그지 않는다(표시 경로가 48시간 정각까지 받으므로)
//   ② 두 번 불러도 회차당 1행 — 두 번째는 locked 0(계약 Phase 6 목록 9번) · 동시에 두 번 불러도 회차당 1행
//   ③ 잠긴 뒤(49시간째) 대표의 새 결석 표시는 409 ABSENCE_WINDOW_CLOSED — 작업이 돌기 전이어도 같다(권위는 시각 계산).
//      47시간째에는 같은 대표가 표시할 수 있다(대조)
//   ④ 내부 경로: 토큰 없으면 401(기록 0) · 맞으면 200 { locked } · 모르는 칸 422
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { ABSENCE_SESSION_LOCKED_ACTION, runAbsenceLock } from "@/lib/server/services/absence-lock";
import { createStaffAbsenceMarkRoutes } from "@/lib/server/services/staff-absence-marks";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { insertReservationAndPayment } from "../fixtures/contract-parents";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 기준 회차의 끝 시각 — 모든 「지금」은 여기서 몇 시간 뒤로 잰다
const END = Temporal.Instant.from("2026-12-01T12:00:00Z");
const AT_49H = END.add({ hours: 49 });

describe.skipIf(!dbAvailable())("결석 표시 48시간 확정 작업(계약 04 §7, S3-4.3b)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  let ownerToken = "";
  let reservationId = "";
  let memberId = "";
  let offeringId = "";
  let academyId = "";
  let classId = "";
  let nextSeq = 10;

  const run = (now: Temporal.Instant) => runAbsenceLock({ db: handle.db, clock: fixedClock(now) });

  /** 회차 한 줄 — 끝 시각을 END 기준 시간으로 고른다(음수면 더 이르게 끝남) */
  async function makeSession(endOffsetHours: number, status: "scheduled" | "cancelled" = "scheduled"): Promise<string> {
    const id = randomUUID();
    const endsAt = END.subtract({ hours: endOffsetHours }).toString();
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, status, cancelled_at, cancel_reason)
       VALUES ($1, $2, $3, $4::timestamptz - interval '90 minutes', $4::timestamptz, $5,
               CASE WHEN $5 = 'cancelled' THEN $4::timestamptz - interval '3 days' END,
               CASE WHEN $5 = 'cancelled' THEN '강사 사정' END)`,
      [id, offeringId, nextSeq++, endsAt, status],
    );
    return id;
  }

  /** 그 회차에 결석 한 줄(회원이 미리 알린 결석 예정). cancelled 면 거둔 행 */
  async function makeMark(sessionId: string, cancelled = false) {
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, cancelled_at)
       VALUES ($1, $2, $3, $4, 'member', $4, $5)`,
      [randomUUID(), reservationId, sessionId, memberId, cancelled ? new Date() : null],
    );
  }

  const lockRows = async () =>
    (
      await q(
        `SELECT target_id::text AS session_id, actor_kind::text AS actor_kind, actor_staff_account_id, actor_member_id, actor_role,
                academy_id::text AS academy_id, after
           FROM audit_logs WHERE action = $1 AND target_table = 'class_sessions' ORDER BY target_id`,
        [ABSENCE_SESSION_LOCKED_ACTION],
      )
    ).rows as {
      session_id: string;
      actor_kind: string;
      actor_staff_account_id: string | null;
      actor_member_id: string | null;
      actor_role: string | null;
      academy_id: string;
      after: { markCount: number };
    }[];

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 8 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
  });
  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  beforeEach(async () => {
    await truncateAll(handle.pool);
    nextSeq = 10;
    // 예약 → 주문(paid) → 신청 단위 → 수업 → 학원 사슬은 공용 픽스처가 만든다
    ({ reservationId } = await insertReservationAndPayment(handle.pool));
    const row = (
      await q(
        `SELECT r.member_id::text AS member_id, r.offering_id::text AS offering_id, c.id::text AS class_id, c.academy_id::text AS academy_id
           FROM reservations r JOIN class_offerings o ON o.id = r.offering_id JOIN classes c ON c.id = o.class_id
          WHERE r.id = $1`,
        [reservationId],
      )
    ).rows[0] as { member_id: string; offering_id: string; class_id: string; academy_id: string };
    ({ member_id: memberId, offering_id: offeringId, class_id: classId, academy_id: academyId } = row);
    // 픽스처가 만든 「7일 뒤」 회차는 지운다 — 이 파일의 회차는 모두 END 기준으로 만든다
    await q("DELETE FROM class_sessions WHERE offering_id = $1", [offeringId]);

    // 그 학원의 대표(Better Auth 세션 + 직원 계정 + 대표 역할 + 학원 대표)
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `owner-${randomUUID()}@example.com`, name: "owner", emailVerified: true, username: `u_owner_${randomUUID().slice(0, 8)}`, displayUsername: "owner" },
      { method: "admin" },
    );
    ownerToken = (await ctx.internalAdapter.createSession(user.id)).token;
    const staffId = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, '직원 대표', 'active', now())", [
      staffId,
      user.id,
    ]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, 'owner')", [staffId]);
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffId]);
  });

  /** 대표의 결석 표시 한 번(S3-4.3a 경로) */
  async function ownerMarks(sessionId: string, now: Temporal.Instant) {
    const getSession = (h: Headers) => auth.api.getSession({ headers: h });
    const route = createStaffAbsenceMarkRoutes({ db: handle.db, getSession, clock: fixedClock(now) }).mark;
    const res = await route(
      new Request(`${BASE}/api/classes/${classId}/sessions/${sessionId}/absences`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ memberId }),
      }),
      { params: Promise.resolve({ classId, sessionId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("① 끝 + 48시간이 지난 회차만 잠금 기록 1행(시스템 · 학원 · markCount) — 47시간째·48시간 정각은 아직", async () => {
    // 지금 = AT_49H 로 돌린다. 각 회차의 「끝난 뒤 지난 시간」 = 49 + offset
    const ended49h = await makeSession(0); // 49시간 전에 끝남
    const ended72h = await makeSession(23); // 72시간 전에 끝남
    const exactly48h = await makeSession(-1); // 정확히 48시간 전에 끝남
    const ended47h = await makeSession(-2); // 47시간 전에 끝남
    const cancelledOld = await makeSession(100, "cancelled"); // 휴강 회차도 시각이 지나면 기록(markCount 0)
    await makeMark(ended49h);
    await makeMark(ended72h, true); // 거둔 결석은 세지 않는다
    await makeMark(ended47h);

    expect(await run(AT_49H)).toEqual({ locked: 3 });

    const rows = await lockRows();
    expect(rows.map((r) => r.session_id).sort()).toEqual([ended49h, ended72h, cancelledOld].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ actor_kind: "system", actor_staff_account_id: null, actor_member_id: null, actor_role: null, academy_id: academyId });
    }
    const countOf = (id: string) => rows.find((r) => r.session_id === id)?.after;
    expect(countOf(ended49h)).toEqual({ markCount: 1 });
    expect(countOf(ended72h)).toEqual({ markCount: 0 });
    expect(countOf(cancelledOld)).toEqual({ markCount: 0 });
    expect(rows.some((r) => r.session_id === exactly48h || r.session_id === ended47h)).toBe(false);

    // 시간이 더 흐르면 나머지 둘도 잠긴다
    expect(await run(AT_49H.add({ hours: 2 }))).toEqual({ locked: 2 });
    const later = await lockRows();
    expect(later).toHaveLength(5);
    expect(later.find((r) => r.session_id === ended47h)?.after).toEqual({ markCount: 1 });
  });

  test("② 되풀이해도 회차당 1행 — 두 번째는 locked 0 · 동시에 두 번 불러도 1행", async () => {
    const a = await makeSession(0);
    const b = await makeSession(5);
    expect(await run(AT_49H)).toEqual({ locked: 2 });
    expect(await run(AT_49H)).toEqual({ locked: 0 });
    expect(await run(AT_49H.add({ hours: 24 }))).toEqual({ locked: 0 });
    expect((await lockRows()).map((r) => r.session_id).sort()).toEqual([a, b].sort());

    // 동시 실행 — 작업 잠금이 한쪽을 기다리게 해, 합이 새 회차 수와 같고 회차당 1행이다
    const c = await makeSession(1);
    const results = await Promise.all([run(AT_49H), run(AT_49H)]);
    expect(results.map((r) => r.locked).sort()).toEqual([0, 1]);
    const rows = await lockRows();
    expect(rows.filter((r) => r.session_id === c)).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  test("③ 49시간째 새 결석 표시는 409 ABSENCE_WINDOW_CLOSED(작업 전에도 · 뒤에도) — 47시간째는 201", async () => {
    // 대조: 47시간째에는 같은 대표가 표시할 수 있다
    const open = await makeSession(-2); // END + 2시간에 끝남 → AT_49H 는 이 회차의 47시간째
    const okAt47 = await ownerMarks(open, AT_49H);
    expect(okAt47.status).toBe(201);

    const closed = await makeSession(0); // END 에 끝남 → AT_49H = 49시간째
    // 작업이 돌기 전: 시각 계산만으로 거부한다
    const before = await ownerMarks(closed, AT_49H);
    expect(before.status).toBe(409);
    expect(before.body["code"]).toBe("ABSENCE_WINDOW_CLOSED");
    expect(before.body["lockedAt"]).toBe(END.add({ hours: 48 }).toString());

    // 작업이 잠근 뒤에도 거부 — 결석 행은 생기지 않는다
    expect(await run(AT_49H)).toEqual({ locked: 1 });
    const after = await ownerMarks(closed, AT_49H);
    expect(after.status).toBe(409);
    expect(after.body["code"]).toBe("ABSENCE_WINDOW_CLOSED");
    const marks = (await q("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = $1", [closed])).rows[0] as { n: number };
    expect(marks.n).toBe(0);
    // 잠금 기록은 표시 거부를 시도해도 1행 그대로
    expect((await lockRows()).filter((r) => r.session_id === closed)).toHaveLength(1);
  });

  describe("④ 내부 경로 POST /api/internal/jobs/absence-lock", () => {
    const TOKEN = "test-internal-token-absence-lock";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/absence-lock/route");
      return POST(new Request("http://localhost/api/internal/jobs/absence-lock", { method: "POST", headers, body }), undefined);
    };
    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(async () => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
      // 경로가 쓰는 공용 연결 풀을 닫는다(다른 내부 작업 테스트와 같은 정리)
      const shared = await import("../../prisma/db");
      await shared.pool.end();
    });

    test("토큰이 없으면 401 이고 기록이 생기지 않는다", async () => {
      await makeSession(0);
      const response = await call({ "Content-Type": "application/json" }, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(response.status).toBe(401);
      expect(await lockRows()).toHaveLength(0);
    });

    test("토큰이 맞으면 200 { locked } — 시험용 시계(asOf) · 다시 부르면 0 · 모르는 칸은 422", async () => {
      const session = await makeSession(0);
      await makeSession(-2); // 47시간째 — 아직
      const headers = { "X-Internal-Token": TOKEN, "Content-Type": "application/json" };

      const response = await call(headers, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ locked: 1 });
      expect((await lockRows()).map((r) => r.session_id)).toEqual([session]);

      const again = await call(headers, JSON.stringify({ asOf: AT_49H.toString() }));
      expect(await again.json()).toEqual({ locked: 0 });

      const unknown = await call(headers, JSON.stringify({ asOf: AT_49H.toString(), extra: 1 }));
      expect(unknown.status).toBe(422);
    });
  });
});
