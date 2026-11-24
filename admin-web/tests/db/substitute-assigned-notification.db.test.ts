// S2-3.7(대체 강사 배정 알림) — 소속 해제 때 대표가 대체 강사를 배정하면, 같은 트랜잭션 안에서
// 그 강사에게 배정 알림(substitute_assigned)이 1건 쌓이고 그 회차가 그 강사의 일정(캘린더)에 들어가는지 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §9-2(release 한 트랜잭션) · §12(알림 표 substitute_assigned) · §13(일정은 회차의 담당 강사 칸에서 읽는다)
//   수용: S2-3 ⑥ 대표가 배정한 대체 강사에게 배정 알림이 가고 그 강사 캘린더에 회차가 들어간다
//   verify 의 이름은 tests/db/s2-3-7.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 판(픽스처): 강사 junho 가 학원 A 에서 맡은 수업 X(화요일 2회: 12/1 · 12/8, 20:30–21:30 KST). 회원 hana 결제 확정.
//   mina = 같은 장르·그 시간 비어 있음 · busy = 같은 장르지만 12/8 저녁에 개인 일정(12/8 대체로 고르면 409).
//
// 왜 캘린더 「행」을 확인하지 않나: 강사 캘린더는 따로 쓰는 표가 없고 회차의 담당 강사 칸(class_sessions.instructor_account_id)에서 읽는다
//   (계약 §9-2 「일정은 회차의 담당 강사에서 읽으므로 따로 쓰지 않는다」). 그래서 강사 일정 읽기(readScheduledSessions — 겹침 판정과 같은 읽기)에
//   그 회차가 나오는지로 확인한다.
//
// 확인하는 것:
//   ① 거부되면 알림도 없다 — 12/1 은 mina(가능), 12/8 은 busy(일정 겹침)로 고르면 409 SUBSTITUTE_UNAVAILABLE.
//      12/1 의 배정 알림을 이미 쓴 뒤 실패해도 한 트랜잭션이라 substitute_assigned 0행, mina 일정도 그대로 비어 있다
//   ② 해제 — 12/1 대체(mina) · 12/8 휴강. mina 에게 substitute_assigned 정확히 1행(operations · pending · 회차 열쇠 · 문구),
//      junho 는 0행. mina 의 일정에 12/1 회차가 들어가고 junho 의 일정에서는 빠진다. 같은 요청을 다시 보내도 행이 늘지 않는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createReleaseAffiliationRoute, releasedAffiliationSchema } from "@/lib/server/services/academy-affiliation-release";
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { readScheduledSessions } from "@/lib/server/services/class-schedule-conflicts";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "substitute-assigned-notification-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");
// 강사 일정을 읽을 기간 — 12월 한 달(「…Z」 글자)
const DECEMBER = { from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z" };

describe.skipIf(!dbAvailable())("대체 강사 배정 알림과 그 강사의 일정(계약 11 §9-2 · §12, S2-3.7)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let affiliationId = "";
  let classX = "";
  let sessionIds: string[] = []; // 시간순: 12/1 · 12/8
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key}`, displayUsername: key },
      { method: "admin" },
    );
    // 관리자 웹(대표 경로)은 2단계 인증을 켠 세션만 받는다
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
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

  async function affiliate(instructor: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id::text AS id`,
      [academyId, staffIds[instructor]],
    );
    return (rows[0] as { id: string }).id;
  }

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens[who]}`,
    "content-type": "application/json",
    ...extra,
  });

  /** 대표가 junho 담당 정규 수업을 올리고 공개까지(승인이 필요하면 승인) */
  async function published(title: string, weekday: string, periodFrom: string, periodTo: string, startTime: string, endTime: string): Promise<string> {
    const reg = createClassRegistrationRoutes(deps());
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: headers("owner", { "Idempotency-Key": randomUUID() }),
        body: JSON.stringify({
          academyId,
          instructorAccountId: staffIds["junho"],
          classKind: "regular",
          title,
          genre: "dance_sport",
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: 300000,
          schedule: { kind: "recurring", weekdays: [weekday], startTime, endTime, periodFrom, periodTo },
          capacity: { mode: "gender_split", male: 6, female: 6 },
          refundDeadlineOn: null,
          introText: null,
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers: headers("owner"), body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const { rows } = await q("SELECT status FROM classes WHERE id = $1", [classId]);
    if ((rows[0] as { status: string }).status !== "published") {
      const res = await createClassApprovalRoutes(deps()).approve(
        new Request(`${BASE}/api/academies/${academyId}/classes/${classId}/approve`, { method: "POST", headers: headers("owner"), body: "{}" }),
        { params: Promise.resolve({ academyId, classId }) },
      );
      expect(res.status).toBe(200);
    }
    return classId;
  }

  /** 회원을 그 수업의 판매 단위에 넣는다 — 결제 확정(confirmed) 또는 결제 대기(held) */
  async function reserve(member: string, classId: string, stage: "confirmed" | "held"): Promise<void> {
    if (memberIds[member] === undefined) {
      memberIds[member] = (await insertMember(handle.pool)).memberId;
      await q("UPDATE members SET name = $2 WHERE id = $1", [memberIds[member], member]);
    }
    const { rows } = await q(
      `SELECT o.id::text AS offering_id, p.id::text AS pool_id, c.refund_notice_version_id::text AS notice_id
       FROM class_offerings o JOIN seat_pools p ON p.offering_id = o.id AND p.seat_kind = 'female' JOIN classes c ON c.id = o.class_id
       WHERE o.class_id = $1`,
      [classId],
    );
    const { offering_id, pool_id, notice_id } = rows[0] as { offering_id: string; pool_id: string; notice_id: string };
    const orderId = randomUUID();
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown,
                           refund_notice_version_id, intermediary_notice_version, member_terms_version, merchant_terms_version,
                           platform_fee_rate_bp, cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 300000, 300000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, CASE WHEN $4 = 'paid' THEN now() END, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberIds[member], offering_id, stage === "confirmed" ? "paid" : "pending", notice_id, `idem-${orderId}`],
    );
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'female', $4, $5, now())`,
      [orderId, offering_id, pool_id, memberIds[member], stage],
    );
  }

  const release = async (body: unknown, key: string = randomUUID()) => {
    const res = await createReleaseAffiliationRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/release`, {
        method: "POST",
        headers: headers("owner", { "Idempotency-Key": key }),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** 그 강사의 12월 「예정」 회차(캘린더에 보이는 회차) — 시작 시각 목록 */
  const scheduleOf = async (who: string) =>
    (await readScheduledSessions(handle.db, { instructorAccountId: staffIds[who] ?? null, roomId: null, ...DECEMBER })).map((r) => [
      r.starts_at,
      r.title,
    ]);

  /** 배정 알림 행(받는 강사 id 순) */
  const assignedRows = async () =>
    (
      await q(
        `SELECT recipient_staff_account_id::text AS recipient, recipient_member_id, category, dedupe_key, delivery_status, academy_id::text AS academy, payload
         FROM notifications WHERE kind = 'substitute_assigned' ORDER BY recipient_staff_account_id`,
      )
    ).rows as {
      recipient: string;
      recipient_member_id: string | null;
      category: string;
      dedupe_key: string;
      delivery_status: string;
      academy: string;
      payload: Record<string, unknown>;
    }[];

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport"); // 해제할 강사
    await makeStaff("mina", ["instructor"], "dance_sport"); // 대체 강사(그 시간 비어 있음)
    await makeStaff("busy", ["instructor"], "dance_sport"); // 같은 장르지만 12/8 저녁에 개인 일정

    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라온댄스', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyId],
    );
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES (uuidv7(), $1, 'regular', 1, '정규 공지', $2, $3)",
      [
        academyId,
        JSON.stringify({ cancellableUntil: "수강 시작 전", tiers: [{ point: "before_start", percent: 100 }], nonRefundableCases: "없음", processingBusinessDays: 3, ownerContact: "02-000-0000" }),
        staffIds["owner"],
      ],
    );
    affiliationId = await affiliate("junho");
    for (const other of ["mina", "busy"]) await affiliate(other);
    // busy 는 12/8(화) 20:00–22:00 KST 에 개인 일정 — 수업 X 둘째 회차(20:30–21:30)와 겹친다
    await q(
      `INSERT INTO instructor_personal_events (id, staff_account_id, title, starts_at, ends_at)
       VALUES (uuidv7(), $1, '개인 연습', '2026-12-08T11:00:00Z', '2026-12-08T13:00:00Z')`,
      [staffIds["busy"]],
    );

    classX = await published("차차차 입문", "tue", "2026-12-01", "2026-12-09", "20:30", "21:30");
    sessionIds = (
      await q(
        `SELECT s.id::text AS id FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
         WHERE o.class_id = $1 ORDER BY s.starts_at`,
        [classX],
      )
    ).rows.map((r: { id: string }) => r.id);
    expect(sessionIds).toHaveLength(2);
    await reserve("hana", classX, "confirmed");
  });

  afterAll(async () => {
    if (handle !== undefined) await closeTestDb(handle);
  });

  test("① 거부되면 배정 알림도 없다 — 12/1 알림을 쓴 뒤 12/8 대체가 409 여도 한 트랜잭션이라 0행 · mina 일정 그대로", async () => {
    // 처음에는 두 회차 모두 junho 의 일정이고 mina 의 일정은 비어 있다
    expect(await scheduleOf("junho")).toEqual([
      ["2026-12-01T11:30:00Z", "차차차 입문"],
      ["2026-12-08T11:30:00Z", "차차차 입문"],
    ]);
    expect(await scheduleOf("mina")).toEqual([]);

    const res = await release({
      sessionDecisions: [
        { sessionId: sessionIds[0], action: "substitute", substituteAccountId: staffIds["mina"] },
        { sessionId: sessionIds[1], action: "substitute", substituteAccountId: staffIds["busy"] },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "SUBSTITUTE_UNAVAILABLE", sessionId: sessionIds[1] });

    expect(await assignedRows()).toEqual([]);
    expect(await scheduleOf("mina")).toEqual([]);
    expect(await scheduleOf("junho")).toHaveLength(2);
    expect((await q("SELECT status FROM instructor_affiliations WHERE id = $1", [affiliationId])).rows[0].status).toBe("active");
  });

  test("② 해제 — mina 에게 배정 알림 1행 + mina 일정에 12/1 회차 · junho 일정에서는 빠짐 · 다시 보내도 그대로", async () => {
    const key = randomUUID();
    const body = {
      sessionDecisions: [
        { sessionId: sessionIds[0], action: "substitute", substituteAccountId: staffIds["mina"] },
        { sessionId: sessionIds[1], action: "cancel_session" },
      ],
    };
    const res = await release(body, key);
    expect(res.status).toBe(200);
    const out = releasedAffiliationSchema.parse(res.json);
    expect(out.sessions).toEqual({ substituted: 1, cancelled: 1, closed: 0 });

    // 배정 알림 — 대체 강사 mina 에게 정확히 1행(수용 ⑥). 직원 알림이라 회원 칸은 비고 칩은 「운영」, 발송 전(pending)
    const rows = await assignedRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const batchId = row.payload["batchId"] as string;
    expect(row).toMatchObject({
      recipient: staffIds["mina"],
      recipient_member_id: null,
      category: "operations",
      dedupe_key: `release:${batchId}:${sessionIds[0]}:assigned`,
      delivery_status: "pending",
      academy: academyId,
    });
    expect(row.payload).toMatchObject({
      affiliationId,
      academyId,
      sessionId: sessionIds[0],
      classId: classX,
      classTitle: "차차차 입문",
      startsAt: "2026-12-01T11:30:00Z",
      endsAt: "2026-12-01T12:30:00Z",
      releasedInstructorName: "junho",
      title: "대체 강사 배정 · 라온댄스",
      body: "12/1 (화) 차차차 입문은 junho 강사 대신 mina 강사가 진행해요. 내 일정에 들어갔어요.",
    });
    // 같은 해제 묶음(batch_id)의 변경 기록과 이어진다
    expect((await q("SELECT count(*)::int AS n FROM session_changes WHERE batch_id = $1 AND session_id = $2", [batchId, sessionIds[0]])).rows[0].n).toBe(1);

    // 캘린더 — 12/1 회차가 mina 의 일정에 들어가고 junho 의 일정에서는 빠진다. 휴강한 12/8 은 누구의 예정 일정에도 없다
    expect(await scheduleOf("mina")).toEqual([["2026-12-01T11:30:00Z", "차차차 입문"]]);
    expect(await scheduleOf("junho")).toEqual([]);

    // 같은 요청을 다시 보내면 처음 본문 그대로, 배정 알림 행도 늘지 않는다
    const again = await release(body, key);
    expect(again).toEqual({ status: 200, json: out });
    expect(await assignedRows()).toHaveLength(1);
  });
});
