// S3-4.3a(강사·대표 결석 표시 API) — `POST /api/classes/{classId}/sessions/{sessionId}/absences`(계약 04 §6-1, 보드 I26 · W6)
//   verify: 끝난 지 47시간째 담당 강사 표시 → 201 · 감사 attendance.marked 1행 · 회원 알림 absence_marked 1건 · skip 0
//   그리고: 다시 표시하면 200 같은 행(감사·알림 늘지 않음) · 대표가 표시하면 owner · 회원이 켠 결석 예정을 확정하면 200 member(감사·알림 없음) ·
//           시작 전 409 SESSION_NOT_STARTED · 48시간 정각 성공 · 49시간 409 ABSENCE_WINDOW_CLOSED(lockedAt) · 휴강 409 ·
//           권한(위임 강사 ○ · 위임 끄면 403 · 담당 아닌 강사 403 · 다른 학원 대표 403 · 회원 계정 403 · 401) ·
//           확정 수강생 아님·수업과 회차 어긋남 404 · memberId 형식 422 · 동시 표시 2건 → 행·감사·알림 1개씩
//
// 주문은 진짜 주문 생성 경로(S3-3.4) + 가짜 PG 입금 + 서명한 웹훅(S3-3.9)으로 확정한다(S3-4.3 결석 예정 토글 테스트와 같은 준비).
// 이름: verify 의 tests/db/s3-4-3a.db.test.ts 는 Task 번호 이름이라 기능 이름(staff-absence-marks)으로 바꿨다(증거 EVIDENCE.md 에 기록).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { HmacWebhookVerifier, signWebhook } from "@/lib/server/fakes/hmac-webhook-verifier";
import { orderResponseSchema } from "@/lib/server/schemas/orders";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { absenceMarkResponseSchema, createMeSessionAbsenceRoutes } from "@/lib/server/services/me-session-absence";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import {
  absenceMarkedPayloadSchema,
  createStaffAbsenceMarkRoutes,
  staffAbsenceMarkResponseSchema,
} from "@/lib/server/services/staff-absence-marks";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const WEBHOOK_SECRET = `whsec-test-${randomUUID()}`;
const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 수업은 12/01(화)부터 화·목 8회차 — 지금은 그보다 열흘 앞(KST 11/21)
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("강사·대표 결석 표시 API(계약 04 §6-1, S3-4.3a)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberTokens: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const affiliations: Record<string, string> = {};
  let academyId = "";
  let roomId = "";
  let noticeId = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = (now: Temporal.Instant = NOW) => ({
    db: handle.db,
    getSession,
    clock: fixedClock(now),
    paymentGateway: new FakePaymentGateway({ clock: fixedClock(now) }),
    deadlineConfig: DEFAULT_DEADLINE_CONFIG,
  });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    return { token: (await ctx.internalAdapter.createSession(user.id)).token, userId: user.id };
  }

  async function makeStaff(key: string, role: "owner" | "instructor") {
    const { token, userId } = await loggedInUser(key);
    tokens[key] = token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, userId, `직원 ${key}`]);
    await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (role === "instructor") {
      await q("INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, 'dance_sport', now(), now())", [id]);
    }
    staffIds[key] = id;
  }

  async function makeAcademy() {
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 A', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, academyId],
    );
    roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branch]);
    noticeId = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [noticeId, academyId, JSON.stringify(regularContent), staffIds["owner"]],
    );
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academyId, staffIds["junho"]],
    );
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'class_submit', $2)", [
      (rows[0] as { id: string }).id,
      staffIds["owner"],
    ]);
  }

  /** 학원 A 에 active 소속을 만들고 위임을 켠다(permissions 가 비면 위임 없는 소속 강사) */
  async function affiliate(key: string, permissions: string[]) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id::text AS id`,
      [academyId, staffIds[key]],
    );
    const affiliationId = (rows[0] as { id: string }).id;
    affiliations[key] = affiliationId;
    for (const permission of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        affiliationId,
        permission,
        staffIds["owner"],
      ]);
    }
  }

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24 = 8회차, 120,000원) */
  async function makeClass(key: string, o: { start: string; end: string; capacity: Capacity }) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens["owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId,
          classKind: "regular",
          title: `수업 ${key}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId,
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: o.start, endTime: o.end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: o.capacity,
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: staffIds["junho"],
        }),
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const { classId } = classRegistrationSchema.parse(await created.json());
    const submitted = await reg.submit(
      new Request(`${BASE}/api/classes/${classId}/submit`, { method: "POST", headers, body: "{}" }),
      { params: Promise.resolve({ classId }) },
    );
    expect(submitted.status).toBe(200);
    const row = await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    offerings[key] = row.id;
  }

  async function member(key: string, o: { gender?: "male" | "female"; birthDate?: string } = {}) {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, $4, '01012345678', $5, '서연', now(), 'dance_sport', now())`,
      [id, userId, o.gender ?? "male", o.birthDate ?? "1995-03-02", `ci-${randomUUID()}`],
    );
    memberTokens[key] = token;
    memberIds[key] = id;
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(who: string, body: Record<string, unknown>, o: { key?: string | null; now?: Temporal.Instant } = {}): Promise<Call> {
    const headers: Record<string, string> = { authorization: `Bearer ${memberTokens[who]}`, "content-type": "application/json" };
    const key = o.key === undefined ? randomUUID() : o.key;
    if (key !== null) headers["Idempotency-Key"] = key;
    const res = await createOrderRoute(deps(o.now))(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }
  const bodyFor = (offeringKey: string, extra: Record<string, unknown> = {}) => ({
    offeringId: offerings[offeringKey],
    seatKind: "male",
    method: "card",
    noticesAcknowledged: true,
    ...extra,
  });

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 12 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(platform-fee-rate-reader 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("junho", "instructor");
    await makeAcademy();
    // 같은 강사·같은 홀이 같은 시각에 겹치면 등록이 거부되므로(S2-2.4) 수업마다 시각을 나눈다.
    // 08:00 KST 수업은 UTC 로 전날 23:00 이라, KST 날짜로 자르지 않으면 하루씩 밀린다 — 그 경계를 일부러 만든다.
    await makeClass("mine", { start: "08:00", end: "08:50", capacity: { mode: "gender_split", male: 8, female: 2 } });
    await makeClass("other", { start: "10:00", end: "10:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
    // 이 파일 전용 직원 — 위임 강사(roster_manage) · 담당 아닌 소속 강사 · 다른 학원 대표
    await makeStaff("deleg", "instructor");
    await makeStaff("stranger", "instructor");
    await makeStaff("owner2", "owner");
    await affiliate("deleg", ["roster_manage"]);
    await affiliate("stranger", []);
    const otherAcademy = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '학원 B', '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [otherAcademy],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [otherAcademy, staffIds["owner2"]]);
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  async function startCardOrder(who: string, offeringKey: string): Promise<{ orderId: string; gatewayPaymentId: string }> {
    await member(who);
    const res = await order(who, bodyFor(offeringKey));
    expect(res.status).toBe(201);
    const { orderId } = orderResponseSchema.parse(res.body);
    const row = await one<{ gid: string }>("SELECT gateway_payment_id AS gid FROM payments WHERE order_id = $1", [orderId]);
    return { orderId, gatewayPaymentId: row.gid };
  }

  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------
  const pg = () => new FakePaymentGateway({ clock: fixedClock(NOW) });
  const WEBHOOK_AT = NOW.add({ minutes: 3 });

  /** 카드 주문을 만들고 입금 + 서명한 웹훅으로 확정한다(S3-3.9 경로 그대로) */
  async function confirmOrder(who: string, offeringKey: string): Promise<string> {
    const { orderId, gatewayPaymentId } = await startCardOrder(who, offeringKey);
    pg().deposit(gatewayPaymentId, 120000);
    const rawBody = JSON.stringify(pg().buildPaidWebhookBody(gatewayPaymentId));
    const headers = signWebhook({
      secret: WEBHOOK_SECRET,
      webhookId: `wh_${randomUUID()}`,
      timestampSeconds: Math.floor(WEBHOOK_AT.epochMilliseconds / 1000),
      rawBody,
    });
    const route = createPaymentWebhookRoute({
      db: handle.db,
      clock: fixedClock(WEBHOOK_AT),
      paymentGateway: pg(),
      webhookVerifier: new HmacWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });
    const res = await route(
      new Request(`${BASE}/api/payments/webhook`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: rawBody }),
      undefined,
    );
    expect(res.status).toBe(200);
    return orderId;
  }

  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------

  // 1회차 = 12/01(화) 08:00~08:50 KST = 2026-11-30T23:00Z ~ 23:50Z
  const FIRST_START = Temporal.Instant.from("2026-11-30T23:00:00Z");
  const FIRST_END = Temporal.Instant.from("2026-11-30T23:50:00Z");
  const AT_47H = FIRST_END.add({ hours: 47 });
  const AT_48H = FIRST_END.add({ hours: 48 });
  const AT_49H = FIRST_END.add({ hours: 49 });

  const sessionsOf = async (offeringKey: string) =>
    (await q("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at", [offerings[offeringKey]])).rows.map(
      (r) => (r as { id: string }).id,
    );
  const classIdOf = async (offeringKey: string) =>
    (await one<{ id: string }>("SELECT class_id::text AS id FROM class_offerings WHERE id = $1", [offerings[offeringKey]])).id;

  type MarkCall = { status: number; code?: string; cacheControl: string | null; body: Record<string, unknown> };
  /** 직원 결석 표시 한 번. token 이 null 이면 로그인 없이 부른다 */
  async function markAbsence(
    token: string | null,
    ids: { classId: string; sessionId: string },
    body: unknown,
    now: Temporal.Instant = AT_47H,
  ): Promise<MarkCall> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const route = createStaffAbsenceMarkRoutes({ db: handle.db, getSession, clock: fixedClock(now) }).mark;
    const res = await route(
      new Request(`${BASE}/api/classes/${ids.classId}/sessions/${ids.sessionId}/absences`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(ids) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cacheControl: res.headers.get("cache-control"), body: json };
  }

  const countAudit = async (markId: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'attendance.marked' AND target_id = $1", [markId])).n;
  const countNotices = async (memberKey: string) =>
    (
      await one<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = 'absence_marked' AND recipient_member_id = $1", [
        memberIds[memberKey],
      ])
    ).n;

  let classId = "";
  let mine: string[] = [];

  test("① 끝난 지 47시간째 담당 강사가 표시 → 201 + 감사 1행 + 회원 알림 1건, 다시 표시하면 200 같은 행(verify)", async () => {
    await confirmOrder("m1", "mine");
    classId = await classIdOf("mine");
    mine = await sessionsOf("mine");
    const ids = { classId, sessionId: mine[0]! };
    expect(Temporal.Instant.from((await one<{ s: string }>("SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS s FROM class_sessions WHERE id = $1", [mine[0]])).s).equals(FIRST_START)).toBe(true);

    const first = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m1"] });
    expect(first.status).toBe(201);
    expect(first.cacheControl).toBe("private, no-store");
    const mark = staffAbsenceMarkResponseSchema.parse(first.body);
    expect(mark).toMatchObject({
      sessionId: mine[0],
      memberId: memberIds["m1"],
      nickname: "서연",
      markedByKind: "instructor",
      disputeStatus: "none",
      markedAt: AT_47H.toString({ smallestUnit: "second" }),
      lockedAt: AT_48H.toString(),
    });

    // 행 — 표시한 사람의 종류와 직원 계정이 남고 회원 칸은 비어 있다
    const row = await one<{ kind: string; staff: string | null; by_member: string | null; member: string }>(
      `SELECT marked_by_kind AS kind, marked_by_staff_account_id::text AS staff, marked_by_member_id::text AS by_member, member_id::text AS member
       FROM attendance_marks WHERE id = $1`,
      [mark.markId],
    );
    expect(row).toEqual({ kind: "instructor", staff: staffIds["junho"], by_member: null, member: memberIds["m1"] });

    // 감사 1행 — 누가 · 어느 역할 · 어느 학원 · 무엇을
    const audits = (
      await q(
        `SELECT actor_kind, actor_staff_account_id::text AS actor, actor_role, academy_id::text AS academy, target_table, after
         FROM audit_logs WHERE action = 'attendance.marked'`,
      )
    ).rows as { actor_kind: string; actor: string; actor_role: string; academy: string; target_table: string; after: Record<string, unknown> }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_kind: "staff", actor: staffIds["junho"], actor_role: "instructor", academy: academyId, target_table: "attendance_marks" });
    expect(audits[0]!.after).toMatchObject({ memberId: memberIds["m1"], sessionId: mine[0], markedByKind: "instructor" });
    expect(await countAudit(mark.markId)).toBe(1);

    // 회원 알림 1건 — 열쇠 absence:<markId>:marked, 발송 전(pending), 본문은 역할만(직원 이름 없음)
    const notices = (
      await q(
        `SELECT recipient_member_id::text AS member, recipient_staff_account_id AS staff, academy_id::text AS academy, dedupe_key,
                delivery_status, payload
         FROM notifications WHERE kind = 'absence_marked'`,
      )
    ).rows as { member: string; staff: string | null; academy: string; dedupe_key: string; delivery_status: string; payload: unknown }[];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ member: memberIds["m1"], staff: null, academy: academyId, dedupe_key: `absence:${mark.markId}:marked`, delivery_status: "pending" });
    const payload = absenceMarkedPayloadSchema.parse(notices[0]!.payload);
    expect(payload).toMatchObject({ classTitle: "수업 mine", sessionId: mine[0], sessionDate: "2026-12-01", markedByKind: "instructor", markId: mark.markId });
    expect(payload.disputePath).toBe(`/api/me/attendance-marks/${mark.markId}/dispute`);
    expect(JSON.stringify(payload)).not.toContain("직원 junho");

    // 같은 표시를 다시 — 200 같은 행, 감사·알림은 늘지 않는다
    const again = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m1"] }, AT_47H.add({ minutes: 5 }));
    expect(again.status).toBe(200);
    expect(staffAbsenceMarkResponseSchema.parse(again.body)).toEqual(mark);
    expect(await countAudit(mark.markId)).toBe(1);
    expect(await countNotices("m1")).toBe(1);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE member_id = $1", [memberIds["m1"]])).n).toBe(1);
  });

  test("② 대표가 표시하면 owner 로 남고 감사 역할도 owner, 48시간 정각까지 받는다", async () => {
    await confirmOrder("m2", "mine");
    const res = await markAbsence(tokens["owner"]!, { classId, sessionId: mine[0]! }, { memberId: memberIds["m2"] }, AT_48H);
    expect(res.status).toBe(201);
    const mark = staffAbsenceMarkResponseSchema.parse(res.body);
    expect(mark.markedByKind).toBe("owner");
    const audit = await one<{ role: string }>("SELECT actor_role AS role FROM audit_logs WHERE target_id = $1", [mark.markId]);
    expect(audit.role).toBe("owner");
    expect(await countNotices("m2")).toBe(1);
  });

  test("③ 회원이 미리 켠 결석 예정을 확정 — 새 행 없이 200 member, 감사·알림 없음", async () => {
    await confirmOrder("m3", "mine");
    const routes = createMeSessionAbsenceRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const put = await routes.put(new Request(`${BASE}/api/me/sessions/${mine[0]}/absence`, { method: "PUT", headers: { authorization: `Bearer ${memberTokens["m3"]}` } }), {
      params: Promise.resolve({ sessionId: mine[0]! }),
    });
    expect(put.status).toBe(201);
    const memberMark = absenceMarkResponseSchema.parse(await put.json());

    const res = await markAbsence(tokens["junho"]!, { classId, sessionId: mine[0]! }, { memberId: memberIds["m3"] });
    expect(res.status).toBe(200);
    const mark = staffAbsenceMarkResponseSchema.parse(res.body);
    expect(mark).toMatchObject({ markId: memberMark.markId, markedByKind: "member" });
    expect(await countAudit(mark.markId)).toBe(0);
    expect(await countNotices("m3")).toBe(0);
  });

  test("④ 시각·상태 — 시작 전 409 SESSION_NOT_STARTED · 49시간 409 ABSENCE_WINDOW_CLOSED(lockedAt) · 휴강 409", async () => {
    await confirmOrder("m4", "mine");
    const ids = { classId, sessionId: mine[0]! };
    const before = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m4"] }, FIRST_START.subtract({ seconds: 1 }));
    expect([before.status, before.code]).toEqual([409, "SESSION_NOT_STARTED"]);
    const late = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m4"] }, AT_49H);
    expect([late.status, late.code]).toEqual([409, "ABSENCE_WINDOW_CLOSED"]);
    expect(late.body["lockedAt"]).toBe(AT_48H.toString());
    // 대표도 잠긴 뒤에는 새로 표시하지 못한다(§6-2 — 잠긴 뒤 대표는 취소만)
    const lateOwner = await markAbsence(tokens["owner"]!, ids, { memberId: memberIds["m4"] }, AT_49H);
    expect([lateOwner.status, lateOwner.code]).toEqual([409, "ABSENCE_WINDOW_CLOSED"]);

    // 휴강 회차(2회차를 휴강으로 돌린다)
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '시험' WHERE id = $1", [mine[1]]);
    const cancelled = await markAbsence(tokens["junho"]!, { classId, sessionId: mine[1]! }, { memberId: memberIds["m4"] }, Temporal.Instant.from("2026-12-03T00:00:00Z"));
    expect([cancelled.status, cancelled.code]).toEqual([409, "SESSION_NOT_SCHEDULED"]);

    // 시작한 순간부터는 받는다(보드 I26 의 오늘 회차 표시 — 계약 열린 점 ①). 거절된 호출들은 행을 남기지 않았다
    const atStart = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m4"] }, FIRST_START);
    expect(atStart.status).toBe(201);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE member_id = $1", [memberIds["m4"]])).n).toBe(1);
  });

  test("⑤ 권한 — 위임 강사 ○(instructor) · 위임을 끄면 403 · 담당 아닌 강사 403 · 다른 학원 대표 403 · 회원 계정 403 · 401", async () => {
    await confirmOrder("m5", "mine");
    const ids = { classId, sessionId: mine[0]! };
    const body = { memberId: memberIds["m5"] };

    const stranger = await markAbsence(tokens["stranger"]!, ids, body);
    expect([stranger.status, stranger.code]).toEqual([403, "FORBIDDEN"]);
    const owner2 = await markAbsence(tokens["owner2"]!, ids, body);
    expect([owner2.status, owner2.code]).toEqual([403, "FORBIDDEN"]);
    const asMember = await markAbsence(memberTokens["m5"]!, ids, body);
    expect([asMember.status, asMember.code]).toEqual([403, "STAFF_ACCOUNT_REQUIRED"]);
    const anonymous = await markAbsence(null, ids, body);
    expect([anonymous.status, anonymous.code]).toEqual([401, "UNAUTHENTICATED"]);
    // 권한 없는 호출은 아무것도 남기지 않는다
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE member_id = $1", [memberIds["m5"]])).n).toBe(0);

    // 위임을 끄면 다음 요청부터 403(먼저 끈 상태로 확인한 뒤 다시 켜서 성공을 본다)
    await q("DELETE FROM instructor_delegations WHERE affiliation_id = $1", [affiliations["deleg"]]);
    const off = await markAbsence(tokens["deleg"]!, ids, body);
    expect([off.status, off.code]).toEqual([403, "FORBIDDEN"]);
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      affiliations["deleg"],
      staffIds["owner"],
    ]);
    const on = await markAbsence(tokens["deleg"]!, ids, body);
    expect(on.status).toBe(201);
    const mark = staffAbsenceMarkResponseSchema.parse(on.body);
    expect(mark.markedByKind).toBe("instructor");
    const row = await one<{ staff: string }>("SELECT marked_by_staff_account_id::text AS staff FROM attendance_marks WHERE id = $1", [mark.markId]);
    expect(row.staff).toBe(staffIds["deleg"]);
  });

  test("⑥ 404·422 — 확정 수강생 아님(결제 전·남의 수업) · 수업과 회차 어긋남 · 잘못된 id · memberId 형식", async () => {
    const ids = { classId, sessionId: mine[0]! };
    // 결제 전(주문만 만들고 입금 없음)
    await startCardOrder("unpaid1", "mine");
    const unpaid = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["unpaid1"] });
    expect([unpaid.status, unpaid.code]).toEqual([404, "NOT_FOUND"]);
    // 다른 수업의 확정 수강생
    await confirmOrder("o1", "other");
    const otherMember = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["o1"] });
    expect([otherMember.status, otherMember.code]).toEqual([404, "NOT_FOUND"]);
    // 없는 회원 id
    const ghost = await markAbsence(tokens["junho"]!, ids, { memberId: randomUUID() });
    expect(ghost.status).toBe(404);
    // 다른 수업 id 에 이 회차를 붙이면 404
    const mismatch = await markAbsence(tokens["junho"]!, { classId: await classIdOf("other"), sessionId: mine[0]! }, { memberId: memberIds["m1"] });
    expect([mismatch.status, mismatch.code]).toEqual([404, "NOT_FOUND"]);
    const badId = await markAbsence(tokens["junho"]!, { classId, sessionId: "not-a-uuid" }, { memberId: memberIds["m1"] });
    expect(badId.status).toBe(404);
    // memberId 형식
    const invalid = await markAbsence(tokens["junho"]!, ids, { memberId: "abc" });
    expect([invalid.status, invalid.code]).toEqual([422, "VALIDATION_FAILED"]);
    const extra = await markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m1"], markedByKind: "owner" });
    expect([extra.status, extra.code]).toEqual([422, "VALIDATION_FAILED"]);
    expect(await countNotices("o1")).toBe(0);
  });

  test("⑦ 강사·대표가 동시에 표시 — 201 하나 · 200 하나, 행·감사·알림은 1개씩", async () => {
    await confirmOrder("m6", "mine");
    const ids = { classId, sessionId: mine[0]! };
    const [a, b] = await Promise.all([
      markAbsence(tokens["junho"]!, ids, { memberId: memberIds["m6"] }),
      markAbsence(tokens["owner"]!, ids, { memberId: memberIds["m6"] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const markA = staffAbsenceMarkResponseSchema.parse(a.body);
    const markB = staffAbsenceMarkResponseSchema.parse(b.body);
    expect(markA.markId).toBe(markB.markId);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE member_id = $1", [memberIds["m6"]])).n).toBe(1);
    expect(await countAudit(markA.markId)).toBe(1);
    expect(await countNotices("m6")).toBe(1);
  });
});
