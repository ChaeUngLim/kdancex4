// S2-3.2(시간·장소 변경과 휴강 알림) — 강사가 회차의 시간·장소를 바꾸거나 휴강·폐강을 알리면
// 변경 기록(session_changes)과 알림 행(notifications)이 한 트랜잭션에 생긴다. 발송은 하지 않는다(delivery_status = pending).
//   계약: _workspace/03_contracts/11-instructor.md §6-1 · §6-2 · §7
//   verify 의 이름은 tests/db/s2-3-2.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 시간·장소 변경 1건 → 변경 기록 1행(전후 값) + 결제 확정 회원마다 알림 1행 + 대표 알림 1행 + 캘린더 시각 갱신 + 감사.
//      결제 대기(held) 회원은 받지 않는다. 같은 키로 다시 보내면 같은 본문, 행이 늘지 않는다. 미리 보기 숫자·문구가 실제와 같다
//   ② 휴강(this_session) 1건 → 회차 cancelled + 변경 기록 1행(회원 선택 기한) + 회원 알림 session_cancelled + 대표 알림
//   ③ 폐강(this_and_following) → 남은 회차마다 변경 기록(같은 batch_id) + 회원 알림은 회원마다 1건. 모든 회차가 닫히면 수업 cancelled
//   ④ 거부 — 겹침 409 · 10분 단위 아님 422 · 바뀐 게 없음 422 · 휴강한 회차 409 · 남의 수업 403 · 행사형 409 USE_EVENT_CANCEL.
//      거부되면 변경 기록·알림이 한 줄도 생기지 않는다. 대표가 직접 바꾸면 대표 알림은 없다. 담당 강사(올린 사람 아님)도 바꿀 수 있다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closureChoiceDeadline } from "@/lib/domain/session-change";
import { fixedClock } from "@/lib/domain/time";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import {
  createSessionChangeRoutes,
  sessionCancelPreviewSchema,
  sessionCancelResultSchema,
  sessionChangePreviewSchema,
  sessionChangeResultSchema,
} from "@/lib/server/services/session-changes";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "session-change-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("회차 시간·장소 변경과 휴강 알림(계약 11 §6, S2-3.2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const reg = () => createClassRegistrationRoutes(deps());
  const appr = () => createClassApprovalRoutes(deps());
  const sc = () => createSessionChangeRoutes(deps());

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      `직원 ${key}`,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q(
        "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
        [id, genre],
      );
    }
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    roomIds[`${key}-B`] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomIds[key], branch]);
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'B홀', 'active', now())", [roomIds[`${key}-B`], branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지', $2, $3)",
      [
        academyIds[key],
        JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "없음", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
        staffIds[owner],
      ],
    );
  }

  async function affiliate(academy: string, instructor: string, owner: string, delegate = true) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    if (!delegate) return;
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds[owner],
    ]);
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });

  // 같은 강사가 여러 수업을 올리므로 겹치지 않게 시작 시각을 달리한다(S2-2.4 겹침 거부)
  const regularBody = (academy: string, startTime: string, endTime: string, instructor?: string) => ({
    academyId: academyIds[academy],
    ...(instructor === undefined ? {} : { instructorAccountId: staffIds[instructor] }),
    classKind: "regular",
    title: "쌈바(입문)",
    genre: "dance_sport",
    subGenre: "latin",
    discipline: "samba",
    targetLevel: "entry",
    targetAges: ["all"],
    roomId: roomIds[academy],
    priceAmount: 300000,
    schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime, endTime, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
    capacity: { mode: "gender_split", male: 6, female: 6 },
    refundDeadlineOn: null,
    introText: null,
  });

  /** 수업을 만들고 공개까지. 강사가 올리면 대표가 승인한다. classId 를 돌려준다 */
  async function published(who: string, startTime: string, endTime: string, instructor?: string): Promise<string> {
    const created = await reg().create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: headers(who, { "Idempotency-Key": randomUUID() }),
        body: JSON.stringify(regularBody("A", startTime, endTime, instructor)),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg().submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers(who), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [classId]);
    if ((rows[0] as { status: string }).status !== "published") {
      const academyId = academyIds["A"]!;
      const res = await appr().approve(
        new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers("owner"), body: "{}" }),
        { params: Promise.resolve({ academyId, classId }) },
      );
      expect(res.status).toBe(200);
    }
    return classId;
  }

  const sessionsOf = async (classId: string) =>
    (
      await q(
        `SELECT s.id::text AS id, s.offering_id::text AS offering_id, s.status, s.cancel_reason,
                s.cancelled_at IS NOT NULL AS has_cancelled_at, s.room_id::text AS room_id,
                to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
         FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id WHERE o.class_id = $1 ORDER BY s.starts_at`,
        [classId],
      )
    ).rows as { id: string; offering_id: string; status: string; cancel_reason: string | null; has_cancelled_at: boolean; room_id: string; starts_at: string; ends_at: string }[];

  /** 결제 확정(confirmed) 또는 결제 대기(held) 회원 한 명을 그 수업의 판매 단위에 넣는다. 확정이면 회차마다 캘린더 행도 */
  async function addMember(classId: string, stage: "confirmed" | "held"): Promise<string> {
    const { memberId } = await insertMember(handle.pool);
    const { rows } = await q(
      `SELECT o.id::text AS offering_id, p.id::text AS pool_id, c.refund_notice_version_id::text AS notice_id
       FROM class_offerings o JOIN seat_pools p ON p.offering_id = o.id AND p.seat_kind = 'female' JOIN classes c ON c.id = o.class_id
       WHERE o.class_id = $1`,
      [classId],
    );
    const { offering_id, pool_id, notice_id } = rows[0] as { offering_id: string; pool_id: string; notice_id: string };
    const orderId = randomUUID();
    const reservationId = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 300000, 300000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offering_id, stage === "confirmed" ? "paid" : "pending", notice_id, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES ($1, $2, $3, $4, 'female', $5, $6, now())`,
      [reservationId, orderId, offering_id, pool_id, memberId, stage],
    );
    if (stage === "confirmed") {
      await q(
        `INSERT INTO calendar_entries (id, member_id, reservation_id, session_id, starts_at, ends_at, title)
         SELECT uuidv7(), $1, $2, s.id, s.starts_at, s.ends_at, '쌈바(입문)' FROM class_sessions s WHERE s.offering_id = $3`,
        [memberId, reservationId, offering_id],
      );
    }
    return memberId;
  }

  const ctx = (classId: string, sessionId: string) => ({ params: Promise.resolve({ classId, sessionId }) });
  const post = (who: string, path: string, body: unknown, key?: string) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: headers(who, key === undefined ? {} : { "Idempotency-Key": key }),
      body: JSON.stringify(body),
    });
  const change = (who: string, classId: string, sessionId: string, body: unknown, key: string = randomUUID()) =>
    sc().change(post(who, `/api/classes/${classId}/sessions/${sessionId}/change`, body, key), ctx(classId, sessionId));
  const changePreview = (who: string, classId: string, sessionId: string, body: unknown) =>
    sc().changePreview(post(who, `/api/classes/${classId}/sessions/${sessionId}/change-preview`, body), ctx(classId, sessionId));
  const cancel = (who: string, classId: string, sessionId: string, body: unknown, key: string = randomUUID()) =>
    sc().cancel(post(who, `/api/classes/${classId}/sessions/${sessionId}/cancel`, body, key), ctx(classId, sessionId));
  const cancelPreview = (who: string, classId: string, sessionId: string, body: unknown) =>
    sc().cancelPreview(post(who, `/api/classes/${classId}/sessions/${sessionId}/cancel-preview`, body), ctx(classId, sessionId));

  const changesOf = async (classId: string) =>
    (
      await q(
        `SELECT id::text AS id, session_id::text AS session_id, kind, batch_id::text AS batch_id, before, after, reason,
                changed_by_account_id::text AS changed_by, notified_member_count,
                to_char(member_choice_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS deadline
         FROM session_changes WHERE class_id = $1 ORDER BY created_at, id`,
        [classId],
      )
    ).rows as {
      id: string;
      session_id: string;
      kind: string;
      batch_id: string | null;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string | null;
      changed_by: string;
      notified_member_count: number;
      deadline: string | null;
    }[];
  const notificationsOf = async (classId: string) =>
    (
      await q(
        `SELECT kind, recipient_member_id::text AS member, recipient_staff_account_id::text AS staff, category, dedupe_key,
                delivery_status, payload
         FROM notifications
         WHERE payload->>'classId' = $1
           AND kind IN ('session_time_place_changed', 'session_cancelled', 'class_closed', 'instructor_session_changed')
         ORDER BY created_at, id`,
        [classId],
      )
    ).rows as { kind: string; member: string | null; staff: string | null; category: string | null; dedupe_key: string; delivery_status: string; payload: Record<string, unknown> }[];
  const auditsOf = async (sessionIds: string[]) =>
    (await q("SELECT action, actor_role FROM audit_logs WHERE target_id = ANY($1::uuid[]) ORDER BY occurred_at, id", [sessionIds])).rows;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("mina", ["instructor"], "dance_sport");
    await makeStaff("sora", ["instructor"], "dance_sport");
    await makeAcademy("A", "owner");
    await affiliate("A", "junho", "owner");
    await affiliate("A", "mina", "owner");
    // sora 는 위임이 없다 — 대표가 대신 올려 준 수업의 담당 강사로만 쓴다
    await affiliate("A", "sora", "owner", false);
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 시간·장소 변경 1건 → 변경 기록 1행 + 확정 회원 알림 + 대표 알림 + 캘린더 갱신, 같은 키는 같은 본문", async () => {
    const classId = await published("junho", "20:30", "21:30");
    const [first] = await sessionsOf(classId);
    const m1 = await addMember(classId, "confirmed");
    const m2 = await addMember(classId, "confirmed");
    await addMember(classId, "held"); // 결제 대기 — 알림을 받지 않는다

    // 12/1(화) 20:30–21:30 KST A홀 → 21:00–22:00 B홀
    const body = { startsAt: "2026-12-01T12:00:00Z", endsAt: "2026-12-01T13:00:00Z", roomId: roomIds["A-B"] };
    const preview = sessionChangePreviewSchema.parse(await (await changePreview("junho", classId, first!.id, body)).json());
    expect(preview.notifyMemberCount).toBe(2);
    expect(preview.notifyOwner).toBe(true);
    expect(preview.conflicts).toEqual([]);
    expect(preview.memberMessage.body).toBe("12/1 (화) 시간과 장소가 바뀌었어요 · 20:30–21:30 A홀 → 21:00–22:00 B홀");
    expect(await changesOf(classId)).toEqual([]); // 미리 보기는 아무것도 쓰지 않는다

    const key = randomUUID();
    const res = await change("junho", classId, first!.id, body, key);
    expect(res.status).toBe(200);
    const out = sessionChangeResultSchema.parse(await res.json());
    expect(out).toMatchObject({ sessionId: first!.id, status: "scheduled", notifiedMemberCount: 2 });

    // 회차가 바뀌었다(상태는 그대로 scheduled)
    const after = (await sessionsOf(classId))[0]!;
    expect(after).toMatchObject({ status: "scheduled", room_id: roomIds["A-B"], starts_at: "2026-12-01T12:00:00Z", ends_at: "2026-12-01T13:00:00Z" });

    // 변경 기록 1행 — 전후 값
    const changes = await changesOf(classId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: out.changeId,
      session_id: first!.id,
      kind: "time_place",
      batch_id: null,
      changed_by: staffIds["junho"],
      notified_member_count: 2,
      deadline: null,
      before: { startsAt: "2026-12-01T11:30:00Z", endsAt: "2026-12-01T12:30:00Z", roomName: "A홀", roomId: roomIds["A"] },
      after: { startsAt: "2026-12-01T12:00:00Z", endsAt: "2026-12-01T13:00:00Z", roomName: "B홀", roomId: roomIds["A-B"] },
    });

    // 알림 행 — 확정 회원 2명 + 대표 1명, 모두 발송 전(pending)
    const notes = await notificationsOf(classId);
    const memberNotes = notes.filter((n) => n.kind === "session_time_place_changed");
    expect(memberNotes.map((n) => n.member).sort()).toEqual([m1, m2].sort());
    expect(memberNotes.map((n) => n.dedupe_key).sort()).toEqual([`sessionchange:${out.changeId}:${m1}`, `sessionchange:${out.changeId}:${m2}`].sort());
    expect(memberNotes.every((n) => n.category === null && n.delivery_status === "pending")).toBe(true);
    expect(memberNotes[0]!.payload).toMatchObject({ changeId: out.changeId, body: preview.memberMessage.body, refundHint: "이 시간에 못 오면 환불을 요청할 수 있어요" });
    const ownerNotes = notes.filter((n) => n.kind === "instructor_session_changed");
    expect(ownerNotes).toHaveLength(1);
    expect(ownerNotes[0]).toMatchObject({ staff: staffIds["owner"], category: "operations", dedupe_key: `sessionchange:${out.changeId}:owner`, delivery_status: "pending" });

    // 회원 캘린더 사본도 옮겨졌다
    const cal = (await q("SELECT DISTINCT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS s FROM calendar_entries WHERE session_id = $1", [first!.id])).rows;
    expect(cal).toEqual([{ s: "2026-12-01T12:00:00Z" }]);
    expect(await auditsOf([first!.id])).toEqual([{ action: "session.time_place_changed", actor_role: "instructor" }]);

    // 같은 키로 다시 → 같은 본문, 기록·알림이 늘지 않는다
    const again = await change("junho", classId, first!.id, { roomId: roomIds["A"] }, key);
    expect(again.status).toBe(200);
    expect(sessionChangeResultSchema.parse(await again.json())).toEqual(out);
    expect(await changesOf(classId)).toHaveLength(1);
    expect(await notificationsOf(classId)).toHaveLength(3);
  });

  test("② 휴강(this_session) 1건 → 회차 cancelled + 변경 기록 1행(선택 기한) + 회원 알림 session_cancelled + 대표 알림", async () => {
    const classId = await published("junho", "18:00", "19:00");
    const sessions = await sessionsOf(classId);
    const target = sessions[2]!;
    const m1 = await addMember(classId, "confirmed");
    await addMember(classId, "held");

    const preview = sessionCancelPreviewSchema.parse(await (await cancelPreview("junho", classId, target.id, { scope: "this_session" })).json());
    const deadline = closureChoiceDeadline(NOW).toString();
    expect(preview).toMatchObject({
      scope: "this_session",
      sessionCount: 1,
      notifyMemberCount: 1,
      memberChoice: { options: ["move_to_other_session", "refund_session_amount"], deadlineAt: deadline, defaultOnExpire: "refund_session_amount" },
      refundHint: { example: { paid: 300000, sessionTotal: 8, amount: 37500 } },
    });

    const key = randomUUID();
    const res = await cancel("junho", classId, target.id, { scope: "this_session", reason: "대회 심사 일정" }, key);
    expect(res.status).toBe(200);
    const out = sessionCancelResultSchema.parse(await res.json());
    expect(out).toMatchObject({ status: "cancelled", notifiedMemberCount: 1, memberChoiceDeadlineAt: deadline });
    expect(out.changeIds).toHaveLength(1);

    const after = await sessionsOf(classId);
    expect(after.filter((s) => s.status !== "scheduled").map((s) => s.id)).toEqual([target.id]);
    expect(after[2]).toMatchObject({ status: "cancelled", cancel_reason: "대회 심사 일정", has_cancelled_at: true });

    const changes = await changesOf(classId);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: out.changeIds[0],
      kind: "cancelled",
      batch_id: out.batchId,
      reason: "대회 심사 일정",
      notified_member_count: 1,
      deadline,
    });

    const notes = await notificationsOf(classId);
    expect(notes.filter((n) => n.kind === "session_cancelled")).toEqual([
      expect.objectContaining({ member: m1, dedupe_key: `batch:${out.batchId}:${m1}`, delivery_status: "pending", category: null }),
    ]);
    expect(notes.filter((n) => n.kind === "instructor_session_changed")).toEqual([
      expect.objectContaining({ staff: staffIds["owner"], category: "operations", dedupe_key: `sessionchange:${out.changeIds[0]}:owner` }),
    ]);
    expect(await auditsOf([target.id])).toEqual([{ action: "session.cancelled", actor_role: "instructor" }]);

    // 같은 키 → 같은 본문 / 새 키로 다시 휴강 → 409 SESSION_NOT_SCHEDULED, 기록 그대로
    const again = await cancel("junho", classId, target.id, { scope: "this_session", reason: "대회 심사 일정" }, key);
    expect(sessionCancelResultSchema.parse(await again.json())).toEqual(out);
    const twice = await cancel("junho", classId, target.id, { scope: "this_session", reason: "다시" });
    expect(twice.status).toBe(409);
    expect((await twice.json()).code).toBe("SESSION_NOT_SCHEDULED");
    // 휴강한 회차의 시간 변경도 409
    const moved = await change("junho", classId, target.id, { roomId: roomIds["A-B"] });
    expect((await moved.json()).code).toBe("SESSION_NOT_SCHEDULED");
    expect(await changesOf(classId)).toHaveLength(1);
  });

  test("③ 폐강(this_and_following) → 남은 회차마다 기록(같은 batch) + 회원 알림은 회원마다 1건, 모두 닫히면 수업 cancelled", async () => {
    const classId = await published("junho", "16:00", "17:00");
    const sessions = await sessionsOf(classId);
    const m1 = await addMember(classId, "confirmed");
    const m2 = await addMember(classId, "confirmed");

    // 6번째 회차부터 → 6·7·8 세 회차 폐강
    const from = sessions[5]!;
    const preview = sessionCancelPreviewSchema.parse(await (await cancelPreview("junho", classId, from.id, { scope: "this_and_following" })).json());
    expect(preview).toMatchObject({ sessionCount: 3, notifyMemberCount: 2, memberChoice: null });

    const out = sessionCancelResultSchema.parse(
      await (await cancel("junho", classId, from.id, { scope: "this_and_following", reason: "강사 사정" })).json(),
    );
    expect(out).toMatchObject({ status: "closed", notifiedMemberCount: 2, memberChoiceDeadlineAt: null });
    expect(out.changeIds).toHaveLength(3);
    const after = await sessionsOf(classId);
    expect(after.map((s) => s.status)).toEqual(["scheduled", "scheduled", "scheduled", "scheduled", "scheduled", "closed", "closed", "closed"]);

    const changes = await changesOf(classId);
    expect(changes.map((c) => c.kind)).toEqual(["closed", "closed", "closed"]);
    expect(new Set(changes.map((c) => c.batch_id))).toEqual(new Set([out.batchId]));
    expect(changes.every((c) => c.deadline === null)).toBe(true);
    const closedNotes = (await notificationsOf(classId)).filter((n) => n.kind === "class_closed");
    expect(closedNotes.map((n) => n.member).sort()).toEqual([m1, m2].sort()); // 세 회차가 묶여도 회원마다 1건
    expect((await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0]).toEqual({ status: "published" });

    // 첫 회차부터 폐강 → 남은 예정 회차 0 → 수업 cancelled + 승인 기록 closed
    const rest = sessionCancelResultSchema.parse(
      await (await cancel("junho", classId, sessions[0]!.id, { scope: "this_and_following", reason: "강사 사정" })).json(),
    );
    expect(rest.changeIds).toHaveLength(5);
    expect((await q("SELECT status FROM classes WHERE id = $1", [classId])).rows[0]).toEqual({ status: "cancelled" });
    expect((await q("SELECT count(*)::int AS n FROM class_approvals WHERE class_id = $1 AND action = 'closed'", [classId])).rows[0]).toEqual({ n: 1 });
    expect((await notificationsOf(classId)).filter((n) => n.kind === "class_closed")).toHaveLength(4);
  });

  test("④ 거부되면 기록·알림이 없다 · 대표가 바꾸면 대표 알림 없음 · 위임 없는 담당 강사도 자기 회차는 바꾼다", async () => {
    const classId = await published("junho", "14:00", "15:00");
    const sessions = await sessionsOf(classId);
    await addMember(classId, "confirmed");
    const s0 = sessions[0]!;
    const code = async (res: Response) => ({ status: res.status, code: ((await res.json()) as { code: string }).code });

    // 같은 수업의 다음 회차(12/3 14:00 KST = 05:00Z)와 겹치는 시각 → 409 SCHEDULE_CONFLICT
    expect(await code(await change("junho", classId, s0.id, { startsAt: "2026-12-03T05:00:00Z", endsAt: "2026-12-03T06:00:00Z" }))).toEqual({
      status: 409,
      code: "SCHEDULE_CONFLICT",
    });
    // 10분 단위 아님 · 바뀐 게 없음 · 시작·끝 한쪽만 → 422
    expect((await change("junho", classId, s0.id, { startsAt: "2026-12-01T05:05:00Z", endsAt: "2026-12-01T06:05:00Z" })).status).toBe(422);
    expect((await change("junho", classId, s0.id, { roomId: roomIds["A"] })).status).toBe(422);
    expect((await change("junho", classId, s0.id, { startsAt: "2026-12-01T06:00:00Z" })).status).toBe(422);
    // 남의 수업 → 403 · 사유 없는 휴강 → 422 · 키 없음 → 400
    expect(await code(await change("mina", classId, s0.id, { roomId: roomIds["A-B"] }))).toEqual({ status: 403, code: "FORBIDDEN" });
    expect((await cancel("junho", classId, s0.id, { scope: "this_session", reason: " " })).status).toBe(422);
    const noKey = await sc().change(post("junho", `/api/classes/${classId}/sessions/${s0.id}/change`, { roomId: roomIds["A-B"] }), ctx(classId, s0.id));
    expect(noKey.status).toBe(400);
    expect(await changesOf(classId)).toEqual([]);
    expect(await notificationsOf(classId)).toEqual([]);

    // 대표가 직접 바꾸면 대표 알림은 만들지 않는다(회원 알림만)
    const byOwner = sessionChangeResultSchema.parse(await (await change("owner", classId, s0.id, { roomId: roomIds["A-B"] })).json());
    const notes = await notificationsOf(classId);
    expect(notes.map((n) => n.kind)).toEqual(["session_time_place_changed"]);
    expect((await changesOf(classId))[0]).toMatchObject({ id: byOwner.changeId, changed_by: staffIds["owner"] });

    // 대표가 sora 를 담당 강사로 올린 수업 — sora 는 위임이 없어도 자기 회차를 휴강할 수 있다
    const soraClass = await published("owner", "12:00", "13:00", "sora");
    const soraSession = (await sessionsOf(soraClass))[1]!;
    const res = await cancel("sora", soraClass, soraSession.id, { scope: "this_session", reason: "부상" });
    expect(res.status).toBe(200);
    expect((await notificationsOf(soraClass)).map((n) => n.kind)).toEqual(["instructor_session_changed"]); // 확정 회원 0명

    // 행사형(원데이)은 이 길이 아니다 → 409 USE_EVENT_CANCEL
    await q("UPDATE classes SET class_kind = 'one_day' WHERE id = $1", [soraClass]);
    expect(await code(await cancel("sora", soraClass, (await sessionsOf(soraClass))[2]!.id, { scope: "this_session", reason: "부상" }))).toEqual({
      status: 409,
      code: "USE_EVENT_CANCEL",
    });
  });
});
