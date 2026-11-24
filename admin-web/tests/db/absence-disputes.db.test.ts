// S3-4.3c(결석 이의 신청·처리 API) — 계약 04 §8
//   `POST /api/me/attendance-marks/{markId}/dispute`(회원 이의 신청) · `POST /api/attendance-marks/{markId}/dispute/resolve`(직원 처리)
//   verify: 회원이 켠 결석 예정에 이의 → 409 ABSENCE_NOT_DISPUTABLE · 강사 표시 → 회원 이의 → 표시한 강사가 accept → accepted + cancelled_at 채움 + 회원 알림 · skip 0
//   그리고: 이의 신청 감사 1행 + 표시한 직원 알림 1건(연락처 없음) · 다시 걸면 200 같은 본문 · 처리 뒤 다시 걸면 409 DISPUTE_ALREADY_RESOLVED ·
//           대표가 reject(note) → rejected · 결석 유지 · 처리 권한(표시한 직원 · 그 학원 대표만) · 404 · 422 · 동시 요청에도 감사·알림 1개씩
//
// 준비(주문 확정·결석 표시)는 S3-4.3a(강사·대표 결석 표시 API) 테스트와 같은 방식이다 — 진짜 주문 경로 + 가짜 PG 입금 + 서명한 웹훅 → 직원 표시 경로.
// 이름: verify 의 tests/db/s3-4-3c.db.test.ts 는 Task 번호 이름이라 기능 이름(absence-disputes)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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
  createAbsenceDisputeRoutes,
  disputeRequestedPayloadSchema,
  disputeRequestResponseSchema,
  disputeResolvedPayloadSchema,
  disputeResolveResponseSchema,
} from "@/lib/server/services/absence-disputes";
import { createStaffAbsenceMarkRoutes, staffAbsenceMarkResponseSchema } from "@/lib/server/services/staff-absence-marks";
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

describe.skipIf(!dbAvailable())("결석 이의 신청·처리 API(계약 04 §8, S3-4.3c)", () => {
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


  // ---- 이의 경로 도우미 -------------------------------------------------------------------------
  // 이의는 47시간째 표시한 결석에 50시간째(잠긴 뒤) 건다 — 이의 처리는 48시간 잠금과 무관하다(계약 §7 끝 줄)
  const AT_50H = FIRST_END.add({ hours: 50 });
  const AT_51H = FIRST_END.add({ hours: 51 });

  async function dispute(token: string | null, markId: string, body: unknown, now: Temporal.Instant = AT_50H): Promise<MarkCall> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const route = createAbsenceDisputeRoutes({ db: handle.db, getSession, clock: fixedClock(now) }).requestDispute;
    const res = await route(
      new Request(`${BASE}/api/me/attendance-marks/${markId}/dispute`, { method: "POST", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ markId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cacheControl: res.headers.get("cache-control"), body: json };
  }

  async function resolve(token: string | null, markId: string, body: unknown, now: Temporal.Instant = AT_51H): Promise<MarkCall> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    const route = createAbsenceDisputeRoutes({ db: handle.db, getSession, clock: fixedClock(now) }).resolveDispute;
    const res = await route(
      new Request(`${BASE}/api/attendance-marks/${markId}/dispute/resolve`, { method: "POST", headers, body: JSON.stringify(body) }),
      { params: Promise.resolve({ markId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cacheControl: res.headers.get("cache-control"), body: json };
  }

  const countAudit = async (action: string, markId: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2", [action, markId])).n;
  const countNotices = async (kind: string, markId: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE kind = $1 AND payload->>'markId' = $2", [kind, markId])).n;
  const markRow = (markId: string) =>
    one<{ status: string; cancelled: string | null; reason: string | null; resolver: string | null; resolved: string | null; requested: string | null }>(
      `SELECT dispute_status AS status, to_char(cancelled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cancelled, dispute_reason AS reason,
              dispute_resolved_by_account_id::text AS resolver,
              to_char(dispute_resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS resolved,
              to_char(dispute_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS requested
       FROM attendance_marks WHERE id = $1`,
      [markId],
    );

  let classId = "";
  let mine: string[] = [];

  /** 회원 who 를 확정 수강생으로 만들고 staffKey 가 1회차 결석을 표시한다 → markId */
  async function staffMarked(who: string, staffKey: string): Promise<string> {
    await confirmOrder(who, "mine");
    if (classId === "") {
      classId = await classIdOf("mine");
      mine = await sessionsOf("mine");
    }
    const res = await markAbsence(tokens[staffKey]!, { classId, sessionId: mine[0]! }, { memberId: memberIds[who] });
    expect(res.status).toBe(201);
    return staffAbsenceMarkResponseSchema.parse(res.body).markId;
  }

  test("① 강사 표시 → 회원 이의 → 표시한 강사가 accept: accepted + cancelled_at 채움 + 회원 알림(verify)", async () => {
    const markId = await staffMarked("m1", "junho");

    // 이의 신청 — 200 requested, 행·감사·직원 알림
    const asked = await dispute(memberTokens["m1"]!, markId, { reason: "  그날 수업에 갔어요  " });
    expect(asked.status).toBe(200);
    expect(asked.cacheControl).toBe("private, no-store");
    expect(disputeRequestResponseSchema.parse(asked.body)).toEqual({
      markId,
      disputeStatus: "requested",
      disputeRequestedAt: AT_50H.toString({ smallestUnit: "second" }),
    });
    expect(await markRow(markId)).toMatchObject({ status: "requested", cancelled: null, reason: "그날 수업에 갔어요", resolver: null });

    const audit = await one<{ actor_kind: string; member: string; role: string; academy: string; reason: string }>(
      `SELECT actor_kind, actor_member_id::text AS member, actor_role AS role, academy_id::text AS academy, reason
       FROM audit_logs WHERE action = 'attendance.dispute_requested' AND target_id = $1`,
      [markId],
    );
    expect(audit).toEqual({ actor_kind: "member", member: memberIds["m1"], role: "member", academy: academyId, reason: "그날 수업에 갔어요" });

    const staffNotice = (
      await q(
        `SELECT recipient_staff_account_id::text AS staff, recipient_member_id AS member, dedupe_key, delivery_status, payload
         FROM notifications WHERE kind = 'absence_dispute_requested'`,
      )
    ).rows as { staff: string; member: string | null; dedupe_key: string; delivery_status: string; payload: unknown }[];
    expect(staffNotice).toHaveLength(1);
    expect(staffNotice[0]).toMatchObject({ staff: staffIds["junho"], member: null, dedupe_key: `absence:${markId}:dispute`, delivery_status: "pending" });
    const requestedPayload = disputeRequestedPayloadSchema.parse(staffNotice[0]!.payload);
    expect(requestedPayload).toMatchObject({ markId, memberNickname: "서연", sessionId: mine[0], sessionDate: "2026-12-01", reason: "그날 수업에 갔어요" });
    expect(requestedPayload.resolvePath).toBe(`/api/attendance-marks/${markId}/dispute/resolve`);
    // 연락처는 넣지 않는다(§8-1)
    expect(JSON.stringify(requestedPayload)).not.toContain("01012345678");

    // 다시 걸면 200 같은 본문 — 감사·알림은 늘지 않는다
    const again = await dispute(memberTokens["m1"]!, markId, { reason: "다른 사유" }, AT_50H.add({ minutes: 3 }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(asked.body);
    expect((await markRow(markId)).reason).toBe("그날 수업에 갔어요");
    expect(await countAudit("attendance.dispute_requested", markId)).toBe(1);
    expect(await countNotices("absence_dispute_requested", markId)).toBe(1);

    // 표시한 강사가 받아들인다 — accepted + cancelled_at 채움
    const done = await resolve(tokens["junho"]!, markId, { decision: "accept", note: "확인했어요" });
    expect(done.status).toBe(200);
    const resolvedAt = AT_51H.toString({ smallestUnit: "second" });
    expect(disputeResolveResponseSchema.parse(done.body)).toEqual({ markId, disputeStatus: "accepted", cancelledAt: resolvedAt, disputeResolvedAt: resolvedAt });
    expect(await markRow(markId)).toMatchObject({ status: "accepted", cancelled: resolvedAt, resolver: staffIds["junho"], resolved: resolvedAt });

    const resolvedAudit = await one<{ actor: string; role: string; reason: string; after: Record<string, unknown> }>(
      `SELECT actor_staff_account_id::text AS actor, actor_role AS role, reason, after FROM audit_logs
       WHERE action = 'attendance.dispute_resolved' AND target_id = $1`,
      [markId],
    );
    expect(resolvedAudit).toMatchObject({ actor: staffIds["junho"], role: "instructor", reason: "확인했어요" });
    expect(resolvedAudit.after).toMatchObject({ disputeStatus: "accepted", decision: "accept", cancelledAt: resolvedAt });

    const memberNotice = (
      await q(
        `SELECT recipient_member_id::text AS member, dedupe_key, payload FROM notifications WHERE kind = 'absence_dispute_resolved'`,
      )
    ).rows as { member: string; dedupe_key: string; payload: unknown }[];
    expect(memberNotice).toHaveLength(1);
    expect(memberNotice[0]).toMatchObject({ member: memberIds["m1"], dedupe_key: `absence:${markId}:dispute_resolved` });
    const resolvedPayload = disputeResolvedPayloadSchema.parse(memberNotice[0]!.payload);
    expect(resolvedPayload).toMatchObject({ markId, decision: "accept", note: "확인했어요", title: "결석 표시가 취소됐어요" });
    expect(JSON.stringify(resolvedPayload)).not.toContain("직원 junho");

    // 처리 뒤 — 다시 처리하면 409 DISPUTE_NOT_PENDING, 다시 이의를 걸면 409 DISPUTE_ALREADY_RESOLVED
    const twice = await resolve(tokens["owner"]!, markId, { decision: "reject" });
    expect([twice.status, twice.code]).toEqual([409, "DISPUTE_NOT_PENDING"]);
    const reask = await dispute(memberTokens["m1"]!, markId, { reason: "또" });
    expect([reask.status, reask.code]).toEqual([409, "DISPUTE_ALREADY_RESOLVED"]);
    expect(await countAudit("attendance.dispute_resolved", markId)).toBe(1);
    expect(await countNotices("absence_dispute_resolved", markId)).toBe(1);

    // 취소된 뒤에는 같은 회차를 다시 결석으로 표시할 수 있다(부분 유니크는 살아 있는 행만 본다) — 이력은 둘 다 남는다
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE member_id = $1 AND cancelled_at IS NULL", [memberIds["m1"]])).n).toBe(0);
  });

  test("② 회원이 켠 결석 예정·이미 거둔 결석에는 이의를 못 건다 — 409 ABSENCE_NOT_DISPUTABLE(verify)", async () => {
    await confirmOrder("m2", "mine");
    const routes = createMeSessionAbsenceRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const put = await routes.put(new Request(`${BASE}/api/me/sessions/${mine[0]}/absence`, { method: "PUT", headers: { authorization: `Bearer ${memberTokens["m2"]}` } }), {
      params: Promise.resolve({ sessionId: mine[0]! }),
    });
    expect(put.status).toBe(201);
    const memberMark = absenceMarkResponseSchema.parse(await put.json());

    const res = await dispute(memberTokens["m2"]!, memberMark.markId, { reason: "그날 갔어요" });
    expect([res.status, res.code]).toEqual([409, "ABSENCE_NOT_DISPUTABLE"]);
    expect(await markRow(memberMark.markId)).toMatchObject({ status: "none", requested: null });
    expect(await countAudit("attendance.dispute_requested", memberMark.markId)).toBe(0);
    expect(await countNotices("absence_dispute_requested", memberMark.markId)).toBe(0);
    // 이의가 없는 행을 처리하려 하면 409 DISPUTE_NOT_PENDING
    const none = await resolve(tokens["owner"]!, memberMark.markId, { decision: "accept" });
    expect([none.status, none.code]).toEqual([409, "DISPUTE_NOT_PENDING"]);

    // 직원이 표시했지만 이미 거둔 행(§6-2 취소를 흉내 — cancelled_at 만 채움)
    const staffMark = await staffMarked("m3", "junho");
    await q("UPDATE attendance_marks SET cancelled_at = now() WHERE id = $1", [staffMark]);
    const cancelled = await dispute(memberTokens["m3"]!, staffMark, { reason: "그날 갔어요" });
    expect([cancelled.status, cancelled.code]).toEqual([409, "ABSENCE_NOT_DISPUTABLE"]);
  });

  test("③ 대표가 표시한 행 — 담당·위임 강사는 처리 403, 대표가 reject(note) → rejected · 결석 유지", async () => {
    const markId = await staffMarked("m4", "owner");
    expect((await dispute(memberTokens["m4"]!, markId, { reason: "출석했어요" })).status).toBe(200);

    // 담당 강사(junho)·위임 강사(deleg)라도 표시하지 않은 행은 처리하지 못한다(§8-2 · 열린 점 ②)
    const byAssigned = await resolve(tokens["junho"]!, markId, { decision: "accept" });
    expect([byAssigned.status, byAssigned.code]).toEqual([403, "FORBIDDEN"]);
    const byDelegate = await resolve(tokens["deleg"]!, markId, { decision: "accept" });
    expect([byDelegate.status, byDelegate.code]).toEqual([403, "FORBIDDEN"]);
    expect((await markRow(markId)).status).toBe("requested");

    const kept = await resolve(tokens["owner"]!, markId, { decision: "reject", note: "출석부에 없어요" });
    expect(kept.status).toBe(200);
    const resolvedAt = AT_51H.toString({ smallestUnit: "second" });
    expect(disputeResolveResponseSchema.parse(kept.body)).toEqual({ markId, disputeStatus: "rejected", cancelledAt: null, disputeResolvedAt: resolvedAt });
    expect(await markRow(markId)).toMatchObject({ status: "rejected", cancelled: null, resolver: staffIds["owner"], resolved: resolvedAt });
    const audit = await one<{ role: string }>("SELECT actor_role AS role FROM audit_logs WHERE action = 'attendance.dispute_resolved' AND target_id = $1", [markId]);
    expect(audit.role).toBe("owner");
    const notice = await one<{ payload: unknown }>("SELECT payload FROM notifications WHERE kind = 'absence_dispute_resolved' AND payload->>'markId' = $1", [markId]);
    expect(disputeResolvedPayloadSchema.parse(notice.payload)).toMatchObject({ decision: "reject", note: "출석부에 없어요", title: "결석 표시가 유지됐어요" });
    // 받는 사람은 그 결석을 표시한 대표
    const staffNotice = await one<{ staff: string }>(
      "SELECT recipient_staff_account_id::text AS staff FROM notifications WHERE kind = 'absence_dispute_requested' AND payload->>'markId' = $1",
      [markId],
    );
    expect(staffNotice.staff).toBe(staffIds["owner"]);
  });

  test("④ 권한·입력 — 남의 표시 403 · 없는 표시 404 · 사유 422 · 처리자 아님 403 · 회원 계정 403 · 로그인 없음 401 · decision 422", async () => {
    const markId = await staffMarked("m5", "junho");
    await member("other1");

    const notMine = await dispute(memberTokens["other1"]!, markId, { reason: "그날 갔어요" });
    expect([notMine.status, notMine.code]).toEqual([403, "FORBIDDEN"]);
    const ghost = await dispute(memberTokens["m5"]!, randomUUID(), { reason: "그날 갔어요" });
    expect([ghost.status, ghost.code]).toEqual([404, "NOT_FOUND"]);
    const badId = await dispute(memberTokens["m5"]!, "not-a-uuid", { reason: "그날 갔어요" });
    expect(badId.status).toBe(404);
    const anonymous = await dispute(null, markId, { reason: "그날 갔어요" });
    expect([anonymous.status, anonymous.code]).toEqual([401, "UNAUTHENTICATED"]);
    for (const body of [{ reason: "" }, { reason: "   " }, { reason: "가".repeat(201) }, {}, { reason: "갔어요", status: "accepted" }]) {
      const bad = await dispute(memberTokens["m5"]!, markId, body);
      expect([bad.status, bad.code]).toEqual([422, "VALIDATION_FAILED"]);
    }
    // 200자 정각은 받는다
    const exact = await dispute(memberTokens["m5"]!, markId, { reason: "가".repeat(200) });
    expect(exact.status).toBe(200);

    // 처리 쪽
    for (const key of ["stranger", "owner2", "deleg"]) {
      const res = await resolve(tokens[key]!, markId, { decision: "accept" });
      expect([res.status, res.code]).toEqual([403, "FORBIDDEN"]);
    }
    const asMember = await resolve(memberTokens["m5"]!, markId, { decision: "accept" });
    expect([asMember.status, asMember.code]).toEqual([403, "STAFF_ACCOUNT_REQUIRED"]);
    const noLogin = await resolve(null, markId, { decision: "accept" });
    expect([noLogin.status, noLogin.code]).toEqual([401, "UNAUTHENTICATED"]);
    const missing = await resolve(tokens["owner"]!, randomUUID(), { decision: "accept" });
    expect([missing.status, missing.code]).toEqual([404, "NOT_FOUND"]);
    for (const body of [{ decision: "maybe" }, {}, { decision: "accept", note: "가".repeat(201) }]) {
      const bad = await resolve(tokens["junho"]!, markId, body);
      expect([bad.status, bad.code]).toEqual([422, "VALIDATION_FAILED"]);
    }
    // 거절된 호출들은 아무것도 바꾸지 않았다
    expect(await markRow(markId)).toMatchObject({ status: "requested", resolver: null });
    expect(await countAudit("attendance.dispute_resolved", markId)).toBe(0);

    // 표시한 강사라도 소속이 끝나면 처리하지 못한다(결석 표시와 같은 기준) — 대표는 그대로 처리한다
    await q("UPDATE instructor_affiliations SET status = 'released', updated_at = now() WHERE academy_id = $1 AND instructor_account_id = $2", [academyId, staffIds["junho"]]);
    const ended = await resolve(tokens["junho"]!, markId, { decision: "accept" });
    await q("UPDATE instructor_affiliations SET status = 'active', updated_at = now() WHERE academy_id = $1 AND instructor_account_id = $2", [academyId, staffIds["junho"]]);
    expect([ended.status, ended.code]).toEqual([403, "FORBIDDEN"]);
  });

  test("⑤ 동시 요청 — 이의 두 번은 감사·알림 1개, 대표 accept · 강사 reject 가 겹치면 하나만 처리(200 · 409)", async () => {
    const markId = await staffMarked("m6", "junho");
    const [a, b] = await Promise.all([
      dispute(memberTokens["m6"]!, markId, { reason: "갔어요 1" }),
      dispute(memberTokens["m6"]!, markId, { reason: "갔어요 2" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(await countAudit("attendance.dispute_requested", markId)).toBe(1);
    expect(await countNotices("absence_dispute_requested", markId)).toBe(1);

    const [x, y] = await Promise.all([
      resolve(tokens["owner"]!, markId, { decision: "accept" }),
      resolve(tokens["junho"]!, markId, { decision: "reject" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.code).toBe("DISPUTE_NOT_PENDING");
    expect(await countAudit("attendance.dispute_resolved", markId)).toBe(1);
    expect(await countNotices("absence_dispute_resolved", markId)).toBe(1);
    const winner = disputeResolveResponseSchema.parse((x.status === 200 ? x : y).body);
    const row = await markRow(markId);
    expect(row.status).toBe(winner.disputeStatus);
    expect(row.cancelled).toBe(winner.cancelledAt);
  });
});
