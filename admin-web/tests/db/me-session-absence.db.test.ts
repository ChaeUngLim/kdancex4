// S3-4.3(결석 예정 토글 API) — `PUT · DELETE /api/me/sessions/{sessionId}/absence`(계약 04 §5, 보드 M11)
//   verify: 바꾼 회차만 결석 예정, 되돌리기 가능(수용 ①) · 토글 전후 정산·예약·자리 행 불변(②) · skip 0
//   그리고: 다시 PUT 은 200 같은 행 · 되돌린 뒤 다시 켜면 새 행 · 시작 뒤 409 · 휴강 회차 409 ·
//           강사 표시는 회원이 못 지움(409) · 남의·결제 전 회차 403 · 없는 회차 404 · 401·403 · 알림·감사 행 없음
//
// 주문은 진짜 주문 생성 경로(S3-3.4) + 가짜 PG 입금 + 서명한 웹훅(S3-3.9)으로 확정한다(S3-4.2 캘린더 테스트와 같은 준비).
// 이름: verify 의 tests/db/s3-4-3.db.test.ts 는 Task 번호 이름이라 기능 이름(me-session-absence)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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
import { calendarResponseSchema, createMeCalendarRoute, type CalendarResponse } from "@/lib/server/services/me-calendar";
import { absenceClearedResponseSchema, absenceMarkResponseSchema, createMeSessionAbsenceRoutes } from "@/lib/server/services/me-session-absence";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
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

describe.skipIf(!dbAvailable())("결석 예정 토글 API(계약 04 §5, S3-4.3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const offerings: Record<string, string> = {};
  const memberTokens: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
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
    await makeClass("mine", { start: "08:00", end: "08:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
    await makeClass("other", { start: "10:00", end: "10:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
    await makeClass("unpaid", { start: "12:00", end: "12:50", capacity: { mode: "gender_split", male: 2, female: 2 } });
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

  type CalendarCall = { status: number; cacheControl: string | null; body: Record<string, unknown> };
  /** 캘린더 조회 한 번. token 을 null 로 주면 로그인 없이 부른다 */
  async function calendar(token: string | null, query = "", now: Temporal.Instant = NOW): Promise<CalendarCall> {
    const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
    const route = createMeCalendarRoute({ db: handle.db, getSession, clock: fixedClock(now) });
    const res = await route(new Request(`${BASE}/api/me/calendar${query}`, { headers }), undefined);
    return { status: res.status, cacheControl: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  }
  async function calendarOk(who: string, query = "", now: Temporal.Instant = NOW): Promise<CalendarResponse> {
    const res = await calendar(memberTokens[who]!, query, now);
    expect(res.status).toBe(200);
    // 사람마다 다른 응답이라 중간 캐시에 남기지 않는다
    expect(res.cacheControl).toBe("private, no-store");
    // 계약 모양 그대로인지 — 모르는 칸이 하나라도 있으면 strictObject 가 실패한다
    return calendarResponseSchema.parse(res.body);
  }


  // ---- 이 파일 전용 도우미 ---------------------------------------------------------------

  type ToggleCall = { status: number; cacheControl: string | null; body: Record<string, unknown> };
  /** 결석 토글 한 번. token 을 null 로 주면 로그인 없이 부른다 */
  async function toggle(method: "PUT" | "DELETE", token: string | null, sessionId: string, now: Temporal.Instant = NOW): Promise<ToggleCall> {
    const headers: Record<string, string> = token === null ? {} : { authorization: `Bearer ${token}` };
    const routes = createMeSessionAbsenceRoutes({ db: handle.db, getSession, clock: fixedClock(now) });
    const handler = method === "PUT" ? routes.put : routes.remove;
    const res = await handler(new Request(`${BASE}/api/me/sessions/${sessionId}/absence`, { method, headers }), {
      params: Promise.resolve({ sessionId }),
    });
    return { status: res.status, cacheControl: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
  }

  /**
   * 「다른 테이블을 건드리지 않는다」(수용 ②)를 재는 지문 — 테이블마다 모든 행을 JSON 글자로 바꿔 정렬해 이어 붙인 md5.
   * 한 칸(updated_at 하나)이라도 바뀌면 값이 달라진다. 대기 줄 테이블은 아직 없다(S3-5 이후) — 생기면 여기에 더한다.
   */
  const UNTOUCHED_TABLES = [
    "orders", "order_events", "payments", "reservations", "seat_pools", "calendar_entries",
    "settlement_entries", "refunds", "refund_events", "notifications", "audit_logs", "class_sessions",
  ] as const;
  async function fingerprint(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const table of UNTOUCHED_TABLES) {
      const row = await one<{ n: number; h: string | null }>(
        `SELECT count(*)::int AS n, md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)) AS h FROM ${table} t`,
      );
      out[table] = `${row.n}:${row.h ?? "empty"}`;
    }
    return out;
  }

  const sessionsOf = async (offeringKey: string) =>
    (await q("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at", [offerings[offeringKey]])).rows.map(
      (r) => (r as { id: string }).id,
    );

  let mine: string[] = [];

  test("① 켜면 그 회차만 결석 예정 — 다시 켜면 200 같은 행, 되돌리면 null, 다시 켜면 새 행(수용 ①)", async () => {
    await confirmOrder("m1", "mine");
    mine = await sessionsOf("mine");
    const token = memberTokens["m1"]!;
    const target = mine[2]!; // 3회차(12/08)

    const first = await toggle("PUT", token, target);
    expect(first.status).toBe(201);
    expect(first.cacheControl).toBe("private, no-store");
    const mark = absenceMarkResponseSchema.parse(first.body);
    const reservation = await one<{ id: string }>("SELECT id::text AS id FROM reservations WHERE member_id = $1", [memberIds["m1"]]);
    expect(mark).toMatchObject({ sessionId: target, reservationId: reservation.id, markedByKind: "member", disputeStatus: "none", canToggle: true });
    expect(mark.markedAt).toBe(NOW.toString({ smallestUnit: "second" }));

    // 캘린더에서도 그 회차 하나만 결석 예정이다
    const cal = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31");
    expect(cal.items.map((i) => (i.absence === null ? null : i.absence.markId))).toEqual([null, null, mark.markId, null, null, null, null, null]);

    // 같은 호출을 되풀이하면 200 + 같은 행(멱등) — 행이 늘지 않는다
    const again = await toggle("PUT", token, target);
    expect(again.status).toBe(200);
    expect(absenceMarkResponseSchema.parse(again.body)).toEqual(mark);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = $1", [target])).n).toBe(1);

    // 되돌리기 — 200 { sessionId, absence: null }, 행은 지우지 않고 cancelled_at 만 채운다
    const cleared = await toggle("DELETE", token, target);
    expect(cleared.status).toBe(200);
    expect(absenceClearedResponseSchema.parse(cleared.body)).toEqual({ sessionId: target, absence: null });
    const kept = await one<{ cancelled: string | null }>("SELECT cancelled_at::text AS cancelled FROM attendance_marks WHERE id = $1", [mark.markId]);
    expect(kept.cancelled).not.toBeNull();
    expect((await calendarOk("m1", "?from=2026-12-01&to=2026-12-31")).items.every((i) => i.absence === null)).toBe(true);

    // 이미 없을 때 DELETE 도 200 같은 본문
    const clearedAgain = await toggle("DELETE", token, target);
    expect(clearedAgain.status).toBe(200);
    expect(clearedAgain.body).toEqual({ sessionId: target, absence: null });

    // 다시 켜면 새 행이 생긴다(부분 유니크는 살아 있는 행만 막는다) — 거둔 행은 그대로 남아 2행
    const reopened = await toggle("PUT", token, target);
    expect(reopened.status).toBe(201);
    expect(absenceMarkResponseSchema.parse(reopened.body).markId).not.toBe(mark.markId);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = $1", [target])).n).toBe(2);
    await toggle("DELETE", token, target);
  });

  test("② 토글 전후 주문·결제·예약·자리·정산·환불·캘린더·알림·감사 행이 그대로다(수용 ②)", async () => {
    const token = memberTokens["m1"]!;
    const before = await fingerprint();
    // 자리 수가 실제로 차 있는 상태에서 재야 「반납하지 않는다」가 의미 있다
    const seats = await one<{ confirmed: number }>(
      "SELECT sum(confirmed_count)::int AS confirmed FROM seat_pools WHERE offering_id = $1",
      [offerings["mine"]],
    );
    expect(seats.confirmed).toBe(1);

    expect((await toggle("PUT", token, mine[3]!)).status).toBe(201);
    expect((await toggle("PUT", token, mine[4]!)).status).toBe(201);
    expect(await fingerprint()).toEqual(before);
    expect((await toggle("DELETE", token, mine[3]!)).status).toBe(200);
    expect(await fingerprint()).toEqual(before);
    // 회원이 켠 결석 예정에는 알림·감사 행이 없다(계약 §5) — 위 지문의 notifications·audit_logs 로 이미 확인했고, 행 수로 한 번 더
    const counts = await one<{ n: number; a: number }>(
      "SELECT (SELECT count(*)::int FROM notifications) AS n, (SELECT count(*)::int FROM audit_logs WHERE action LIKE 'attendance.%') AS a",
    );
    expect(counts.a).toBe(0);
    expect(before["notifications"]!.startsWith(`${counts.n}:`)).toBe(true);
    await toggle("DELETE", token, mine[4]!);
  });

  test("③ 시작한 회차는 켜지도 끄지도 못한다 — 409 SESSION_ALREADY_STARTED", async () => {
    const token = memberTokens["m1"]!;
    // 미리 켜 둔 결석(시작 전)
    expect((await toggle("PUT", token, mine[0]!)).status).toBe(201);
    // 1회차 12/01 08:00 KST = UTC 11/30 23:00 — 그 순간부터 시작으로 본다
    const startedAt = Temporal.Instant.from("2026-11-30T23:00:00Z");
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await toggle(method, token, mine[0]!, startedAt);
      expect(res.status, method).toBe(409);
      expect(res.body["code"]).toBe("SESSION_ALREADY_STARTED");
    }
    // 1초 전에는 된다 — 경계 확인
    const justBefore = await toggle("DELETE", token, mine[0]!, startedAt.subtract({ seconds: 1 }));
    expect(justBefore.status).toBe(200);
  });

  test("④ 휴강한 회차는 409 SESSION_NOT_SCHEDULED", async () => {
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '강사 사정' WHERE id = $1", [mine[7]]);
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await toggle(method, memberTokens["m1"]!, mine[7]!);
      expect(res.status, method).toBe(409);
      expect(res.body["code"]).toBe("SESSION_NOT_SCHEDULED");
    }
  });

  test("⑤ 강사가 표시한 결석은 회원이 못 지운다 — DELETE 409 ABSENCE_MARKED_BY_STAFF, PUT 은 그 행을 200 으로(canToggle false)", async () => {
    const reservation = await one<{ id: string }>("SELECT id::text AS id FROM reservations WHERE member_id = $1", [memberIds["m1"]]);
    const staffMark = randomUUID();
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_staff_account_id)
       VALUES ($1, $2, $3, $4, 'instructor', $5)`,
      [staffMark, reservation.id, mine[5], memberIds["m1"], staffIds["junho"]],
    );
    const removed = await toggle("DELETE", memberTokens["m1"]!, mine[5]!);
    expect(removed.status).toBe(409);
    expect(removed.body["code"]).toBe("ABSENCE_MARKED_BY_STAFF");
    const still = await one<{ cancelled: string | null }>("SELECT cancelled_at::text AS cancelled FROM attendance_marks WHERE id = $1", [staffMark]);
    expect(still.cancelled).toBeNull();

    const put = await toggle("PUT", memberTokens["m1"]!, mine[5]!);
    expect(put.status).toBe(200);
    expect(absenceMarkResponseSchema.parse(put.body)).toMatchObject({ markId: staffMark, markedByKind: "instructor", canToggle: false });
    // 응답에 강사 이름은 없다(역할만, 열린 점 ③)
    expect(JSON.stringify(put.body)).not.toContain("직원 junho");
  });

  test("⑥ 남의 회차·결제 전 회차는 403 FORBIDDEN, 없는 회차·잘못된 id 는 404 — 다른 사람 행은 그대로", async () => {
    await confirmOrder("m2", "other");
    await startCardOrder("m3", "unpaid");
    const others = await sessionsOf("other");
    const unpaid = await sessionsOf("unpaid");

    // m1 이 m2 의 회차를, m3 가 입금 전 회차를
    for (const [who, sessionId] of [["m1", others[0]!], ["m3", unpaid[0]!]] as const) {
      for (const method of ["PUT", "DELETE"] as const) {
        const res = await toggle(method, memberTokens[who]!, sessionId);
        expect(res.status, `${who} ${method}`).toBe(403);
        expect(res.body["code"]).toBe("FORBIDDEN");
      }
    }
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = ANY($1::uuid[])", [[...others, ...unpaid]])).n).toBe(0);

    // m2 가 켠 결석은 m1 의 호출로 바뀌지 않는다
    expect((await toggle("PUT", memberTokens["m2"]!, others[1]!)).status).toBe(201);
    expect((await toggle("DELETE", memberTokens["m1"]!, others[1]!)).status).toBe(403);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = $1 AND cancelled_at IS NULL", [others[1]])).n).toBe(1);

    for (const sessionId of [randomUUID(), "not-a-uuid"]) {
      const res = await toggle("PUT", memberTokens["m1"]!, sessionId);
      expect(res.status, sessionId).toBe(404);
      expect(res.body["code"]).toBe("NOT_FOUND");
    }

    // 취소된 예약도 확정이 아니므로 403(결석 예정은 다니는 회차에만)
    await q("UPDATE reservations SET status = 'cancelled', cancel_reason = 'member_request', updated_at = now() WHERE member_id = $1", [memberIds["m2"]]);
    expect((await toggle("PUT", memberTokens["m2"]!, others[2]!)).status).toBe(403);
  });

  test("⑦ 로그인 안 하면 401, 회원 가입을 덜 마쳤으면 403 SIGNUP_INCOMPLETE — 회차 검사보다 먼저", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const anonymous = await toggle(method, null, "not-a-uuid");
      expect(anonymous.status).toBe(401);
      expect(anonymous.body["code"]).toBe("UNAUTHENTICATED");
    }
    const { token } = await loggedInUser("nomember");
    const incomplete = await toggle("PUT", token, "not-a-uuid");
    expect(incomplete.status).toBe(403);
    expect(incomplete.body["code"]).toBe("SIGNUP_INCOMPLETE");
  });

  test("⑧ 같은 회차에 두 번 동시에 켜도 살아 있는 행은 하나 — 하나는 201, 하나는 200 같은 행", async () => {
    const results = await Promise.all([toggle("PUT", memberTokens["m1"]!, mine[6]!), toggle("PUT", memberTokens["m1"]!, mine[6]!)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const ids = results.map((r) => absenceMarkResponseSchema.parse(r.body).markId);
    expect(ids[0]).toBe(ids[1]);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM attendance_marks WHERE session_id = $1", [mine[6]])).n).toBe(1);
  });
});
