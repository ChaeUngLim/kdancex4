// S3-4.2(캘린더 조회 API) — `GET /api/me/calendar`(계약 04 §1 · §4-1, 보드 M11)
//   verify: 정규 8회차 확정 뒤 8건 · skip 0
//   그리고: KST 날짜로 자른다(08:00 KST 회차 = UTC 전날 23:00 이 그 KST 날짜에 들어간다) · 기본 범위 오늘~+31일 ·
//           내 것만(남의 확정 회차·결제 전 주문은 안 보인다) · 기간 오류 422(형식·순서·62일 초과) · 401·403 ·
//           결석 표시가 있으면 absence(내가 켠 것만 시작 전 canToggle true, 거둔 표시는 null)
//
// 주문은 진짜 주문 생성 경로(S3-3.4)로 만들고, 가짜 PG 입금 + 서명한 웹훅(S3-3.9)으로 확정해 캘린더 행을 만든다 —
// 캘린더 행을 손으로 넣지 않아야 「확정이 넣은 행을 그대로 읽는다」가 검증된다.
// 이름: verify 의 tests/db/s3-4-2.db.test.ts 는 Task 번호 이름이라 기능 이름(me-calendar)으로 바꿨다(증거 EVIDENCE.md 에 기록).
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

describe.skipIf(!dbAvailable())("캘린더 조회 API(계약 04 §1 · §4-1, S3-4.2)", () => {
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

  // 화·목 12/01~12/24 의 KST 날짜(8회차)
  const DECEMBER_DATES = ["2026-12-01", "2026-12-03", "2026-12-08", "2026-12-10", "2026-12-15", "2026-12-17", "2026-12-22", "2026-12-24"];
  /** UTC 순간 → KST 날짜 글자 */
  const kstDate = (iso: string) => Temporal.Instant.from(iso).toZonedDateTimeISO("Asia/Seoul").toPlainDate().toString();

  let mineOrderId = "";

  test("① 정규 8회차를 확정하면 12월 범위에 8건 — 회차 순서·KST 날짜·수업 제목·학원 이름이 맞고 결석은 없다", async () => {
    mineOrderId = await confirmOrder("m1", "mine");
    const body = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31");
    expect(body.items).toHaveLength(8);

    const reservation = await one<{ id: string }>("SELECT id::text AS id FROM reservations WHERE order_id = $1", [mineOrderId]);
    // 시작 시각 오름차순, 회차 번호 1~8
    expect(body.items.map((i) => i.sessionSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.items.map((i) => kstDate(i.startsAt))).toEqual(DECEMBER_DATES);
    for (const item of body.items) {
      expect(item).toMatchObject({ reservationId: reservation.id, offeringId: offerings["mine"], title: "수업 mine", academyName: "학원 A", absence: null });
      // 08:00 KST = UTC 전날 23:00 — 응답은 UTC(Z) 순간이다
      expect(item.startsAt.endsWith("T23:00:00Z")).toBe(true);
      expect(item.endsAt.endsWith("T23:50:00Z")).toBe(true);
    }
    // 회차 id 는 캘린더 행의 회차와 같다(M11 결석 토글이 이 id 로 부른다)
    const sessions = await q("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at", [offerings["mine"]]);
    expect(body.items.map((i) => i.sessionId)).toEqual(sessions.rows.map((r) => (r as { id: string }).id));
    const entries = await q("SELECT id::text AS id FROM calendar_entries WHERE reservation_id = $1 ORDER BY starts_at", [reservation.id]);
    expect(body.items.map((i) => i.entryId)).toEqual(entries.rows.map((r) => (r as { id: string }).id));
  });

  test("② KST 날짜로 자른다 — 12/03 하루만 고르면 12/03 08:00 KST(UTC 12/02 23:00) 회차 1건", async () => {
    const day = await calendarOk("m1", "?from=2026-12-03&to=2026-12-03");
    expect(day.items).toHaveLength(1);
    expect(day.items[0]).toMatchObject({ sessionSeq: 2, startsAt: "2026-12-02T23:00:00Z" });
    // UTC 날짜인 12/02 로 고르면 나오지 않는다(KST 로는 12/02 에 회차가 없다)
    expect((await calendarOk("m1", "?from=2026-12-02&to=2026-12-02")).items).toHaveLength(0);
  });

  test("③ 기본 범위는 오늘(KST)~+31일 — 11/21 기준 12/22 까지 7건, from 만 주면 그날부터 31일", async () => {
    const byDefault = await calendarOk("m1");
    expect(byDefault.items.map((i) => kstDate(i.startsAt))).toEqual(DECEMBER_DATES.slice(0, 7));
    const fromOnly = await calendarOk("m1", "?from=2026-12-10");
    expect(fromOnly.items.map((i) => kstDate(i.startsAt))).toEqual(DECEMBER_DATES.slice(3));
    // 「오늘」은 KST 다 — UTC 로는 아직 11/30 인 12/01 00:30 KST 에 부르면 12/01 회차부터 나온다
    const atKstMidnight = await calendarOk("m1", "", Temporal.Instant.from("2026-11-30T15:30:00Z"));
    expect(atKstMidnight.items).toHaveLength(8);
  });

  test("④ 내 것만 — 다른 회원의 확정 회차는 안 보이고, 결제 전(대기) 주문의 회차도 안 보인다", async () => {
    await confirmOrder("m2", "other");
    const mine = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31");
    expect(mine.items).toHaveLength(8);
    expect(new Set(mine.items.map((i) => i.offeringId))).toEqual(new Set([offerings["mine"]]));
    const theirs = await calendarOk("m2", "?from=2026-12-01&to=2026-12-31");
    expect(theirs.items).toHaveLength(8);
    expect(new Set(theirs.items.map((i) => i.offeringId))).toEqual(new Set([offerings["other"]]));

    // 결제 대기(입금 전) — 캘린더 행이 없다
    await startCardOrder("m3", "unpaid");
    expect((await calendarOk("m3", "?from=2026-12-01&to=2026-12-31")).items).toEqual([]);
    // 행이 남아 있어도 예약이 확정이 아니면 내지 않는다(취소 트랜잭션이 지우지 못한 경우의 안전망)
    await q("UPDATE reservations SET status = 'cancelled', cancel_reason = 'member_request', updated_at = now() WHERE member_id = $1", [memberIds["m2"]]);
    expect((await calendarOk("m2", "?from=2026-12-01&to=2026-12-31")).items).toEqual([]);
  });

  test("⑤ 기간 오류는 422 VALIDATION_FAILED — 형식·없는 날·순서·62일 초과. 62일은 된다", async () => {
    const token = memberTokens["m1"]!;
    for (const [query, path] of [
      ["?from=2026/12/01", "from"],
      ["?from=2026-02-30", "from"],
      ["?to=tomorrow", "to"],
      ["?from=2026-12-10&to=2026-12-01", "to"],
      ["?from=2026-12-01&to=2027-02-01", "to"], // 63일
    ] as const) {
      const res = await calendar(token, query);
      expect(res.status, query).toBe(422);
      expect(res.body["code"]).toBe("VALIDATION_FAILED");
      expect((res.body["fields"] as { path: string }[])[0]!.path).toBe(path);
    }
    // 12/01~01/31 = 양 끝 포함 62일
    expect((await calendarOk("m1", "?from=2026-12-01&to=2027-01-31")).items).toHaveLength(8);
  });

  test("⑥ 로그인 안 하면 401, 회원 가입을 덜 마쳤으면 403 — 기간이 틀려도 인증이 먼저다", async () => {
    const anonymous = await calendar(null, "?from=bad");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body["code"]).toBe("UNAUTHENTICATED");
    const { token } = await loggedInUser("nomember");
    const incomplete = await calendar(token, "?from=bad");
    expect(incomplete.status).toBe(403);
    expect(incomplete.body["code"]).toBe("SIGNUP_INCOMPLETE");
  });

  test("⑦ 결석 표시가 있으면 absence — 내가 켠 것은 시작 전에만 canToggle, 강사 표시는 역할만, 거둔 표시는 null", async () => {
    const before = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31");
    const [first, second, third] = before.items;
    const reservationId = first!.reservationId;
    const mineMark = randomUUID();
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id)
       VALUES ($1, $2, $3, $4, 'member', $4)`,
      [mineMark, reservationId, first!.sessionId, memberIds["m1"]],
    );
    const staffMark = randomUUID();
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_staff_account_id)
       VALUES ($1, $2, $3, $4, 'instructor', $5)`,
      [staffMark, reservationId, second!.sessionId, memberIds["m1"], staffIds["junho"]],
    );
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, cancelled_at)
       VALUES (uuidv7(), $1, $2, $3, 'member', $3, now())`,
      [reservationId, third!.sessionId, memberIds["m1"]],
    );

    const after = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31");
    expect(after.items[0]!.absence).toEqual({ markId: mineMark, markedByKind: "member", disputeStatus: "none", canToggle: true });
    expect(after.items[1]!.absence).toEqual({ markId: staffMark, markedByKind: "instructor", disputeStatus: "none", canToggle: false });
    expect(after.items[2]!.absence).toBeNull();
    expect(after.items.slice(3).every((i) => i.absence === null)).toBe(true);
    // 표시한 사람의 이름·출석 횟수 같은 칸은 없다(strictObject parse 가 이미 막았다) — 응답 글자에도 강사 이름이 없다
    expect(JSON.stringify(after)).not.toContain("직원 junho");

    // 첫 회차가 시작한 뒤(12/01 08:10 KST)에는 내가 켠 결석도 canToggle false
    const started = await calendarOk("m1", "?from=2026-12-01&to=2026-12-31", Temporal.Instant.from("2026-11-30T23:10:00Z"));
    expect(started.items[0]!.absence).toMatchObject({ markId: mineMark, canToggle: false });
  });
});
