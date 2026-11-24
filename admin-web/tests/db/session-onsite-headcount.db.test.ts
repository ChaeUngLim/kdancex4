// S3-5.4(현장 등록 인원) — `PUT /api/classes/{classId}/sessions/{sessionId}/onsite-headcount`(계약 18 §6)를
// 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   이름: 로드맵 verify 의 tests/db/s3-5-4.db.test.ts 는 Task 번호 이름이라 기능 이름(session-onsite-headcount)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//   verify: 현장 인원을 고치면 감사 행(누가·언제·전후)이 남고, 주문·결제·정산 행은 그대로다(S3-5 수용 ④) · skip 0
//   그리고: 정원 남 10 · 앱 결제 남 6 에서 {male:5} → 409 ONSITE_EXCEEDS_CAPACITY(maxOnsite.male 4), {male:4} → 200,
//           같은 값을 또 보내면 감사 행이 늘지 않는다(계약 수용 시나리오 5) · 정원 방식과 안 맞는 칸 422 ·
//           권한(대표 · 위임 강사 · 담당 강사 ○, 그 밖 403) · 끝난 회차 SESSION_ENDED · 휴강 회차 SESSION_CANCELLED ·
//           현장 인원만큼 앱 결제 자리가 줄고(규칙 7) · 앱 결제와 현장 + 가 동시에 와도 정원 초과 0건 · 줄이면 대기 알림 자리를 부른다
// 수업은 시드로 넣지 않고 주문 생성 테스트와 같이 진짜 등록 경로(대표가 올려 바로 공개)로 만든다.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DEFAULT_DEADLINE_CONFIG } from "@/lib/domain/payment-deadline";
import { fixedClock } from "@/lib/domain/time";
import { createFakePaymentGatewayStore, FakePaymentGateway } from "@/lib/server/fakes/fake-payment-gateway";
import { classRegistrationSchema, createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { createOrderRoute } from "@/lib/server/services/order-create";
import {
  createSessionOnsiteHeadcountRoute,
  diffOnsite,
  maxOnsiteOf,
  onsiteHeadcountResponseSchema,
  ONSITE_HEADCOUNT_CHANGED_AUDIT_ACTION,
} from "@/lib/server/services/session-onsite-headcount";
import { createSessionRosterRoute, sessionRosterSchema } from "@/lib/server/services/session-roster";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = `test-${randomUUID()}-${randomUUID()}`;
const BASE = "http://localhost:3000";
// 지금 = 2026-11-21 12:00 KST. 수업은 12/01~12/24 화·목이라 모든 회차가 앞으로 올 회차다
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

const regularContent = {
  cancellableUntil: "수강 시작 전까지 언제든",
  tiers: [{ point: "before_start", percent: 100 }],
  nonRefundableCases: "수강 시작 뒤 단순 변심",
  processingBusinessDays: 3,
  ownerContact: "02-000-0000",
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

// ---- 순수 계산(단위) ------------------------------------------------------------------------------

describe("현장 인원 상한·바뀐 칸(순수 함수)", () => {
  test("상한 = 정원 − 잡힌 자리 − 확정 자리, 음수는 0", () => {
    expect(maxOnsiteOf({ capacity: 10, held: 0, confirmed: 6 })).toBe(4);
    expect(maxOnsiteOf({ capacity: 10, held: 1, confirmed: 6 })).toBe(3);
    expect(maxOnsiteOf({ capacity: 3, held: 2, confirmed: 2 })).toBe(0);
  });
  test("바뀐 칸만 고른다", () => {
    expect(diffOnsite(["male", "female"], { male: 0, female: 1 }, { male: 1, female: 1 })).toEqual([{ seatKind: "male", from: 0, to: 1 }]);
    expect(diffOnsite(["any"], { any: 2 }, { any: 2 })).toEqual([]);
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("현장 등록 인원(계약 18 §6, S3-5.4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const one = async <T>(text: string, params: unknown[] = []) => (await q(text, params)).rows[0] as T;

  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const classes: Record<string, { classId: string; offeringId: string; sessionIds: string[] }> = {};
  let academyId = "";
  let roomId = "";
  const freed: { offeringId: string; seatKind: string }[] = [];

  const pgStore = createFakePaymentGatewayStore();
  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const orderDeps = () => ({
    db: handle.db,
    getSession,
    clock: fixedClock(NOW),
    paymentGateway: new FakePaymentGateway({ store: pgStore, clock: fixedClock(NOW) }),
    deadlineConfig: DEFAULT_DEADLINE_CONFIG,
  });
  const onsiteRoute = (at: Temporal.Instant = NOW) =>
    createSessionOnsiteHeadcountRoute({
      db: handle.db,
      getSession,
      clock: fixedClock(at),
      onSeatFreed: async (offeringId, seatKind) => {
        freed.push({ offeringId, seatKind });
      },
    });

  async function loggedInUser(key: string): Promise<{ token: string; userId: string }> {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}-${randomUUID()}@example.com`, name: key, emailVerified: true, username: `u_${key.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${randomUUID().slice(0, 6)}`, displayUsername: key },
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

  async function affiliate(key: string, academy: string, permissions: string[], ownerKey = "owner") {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now()) RETURNING id`,
      [academy, staffIds[key]],
    );
    for (const permission of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        (rows[0] as { id: string }).id,
        permission,
        staffIds[ownerKey],
      ]);
    }
  }

  async function makeAcademy(ownerKey: string): Promise<{ academyId: string; roomId: string }> {
    const id = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [id],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [id, staffIds[ownerKey]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branch, id],
    );
    const room = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [room, branch]);
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, 'regular', 1, '정규 공지 v1', $3, $4)",
      [randomUUID(), id, JSON.stringify(regularContent), staffIds[ownerKey]],
    );
    return { academyId: id, roomId: room };
  }

  /** 대표가 올려 바로 공개되는 정규 수업(화·목 12/01~12/24, 120,000원, 담당 강사 junho) */
  async function makeClass(key: string, o: { ownerKey?: string; academy?: string; room?: string; start: string; end: string; capacity: Capacity }) {
    const reg = createClassRegistrationRoutes({ db: handle.db, getSession, clock: fixedClock(NOW) });
    const headers = { authorization: `Bearer ${tokens[o.ownerKey ?? "owner"]}`, "content-type": "application/json" };
    const created = await reg.create(
      new Request(`${BASE}/api/classes`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          academyId: o.academy ?? academyId,
          classKind: "regular",
          title: `쌈바 ${key}`,
          subGenre: "latin",
          discipline: "samba",
          targetLevel: "entry",
          targetAges: ["all"],
          roomId: o.room ?? roomId,
          priceAmount: 120000,
          schedule: { kind: "recurring", weekdays: ["tue", "thu"], startTime: o.start, endTime: o.end, periodFrom: "2026-12-01", periodTo: "2026-12-24" },
          capacity: o.capacity,
          refundDeadlineOn: null,
          introText: null,
          instructorAccountId: staffIds[o.ownerKey === "ownerB" ? "junhoB" : "junho"],
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
    const offering = await one<{ id: string }>("SELECT id::text AS id FROM class_offerings WHERE class_id = $1", [classId]);
    const { rows } = await q("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY seq", [offering.id]);
    classes[key] = { classId, offeringId: offering.id, sessionIds: (rows as { id: string }[]).map((r) => r.id) };
  }

  async function member(key: string, gender: "male" | "female"): Promise<{ token: string; id: string }> {
    const { token, userId } = await loggedInUser(key);
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, '1995-03-02', '01012345678', $4, $5, now(), 'dance_sport', now())`,
      [id, userId, gender, `ci-${randomUUID()}`, `회원${key.slice(0, 8)}`],
    );
    return { token, id };
  }

  type Call = { status: number; code?: string; body: Record<string, unknown> };
  async function order(token: string, classKey: string, seatKind: string): Promise<Call> {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "Idempotency-Key": randomUUID() };
    const body = { offeringId: classes[classKey]!.offeringId, seatKind, method: "card", noticesAcknowledged: true };
    const res = await createOrderRoute(orderDeps())(new Request(`${BASE}/api/orders`, { method: "POST", headers, body: JSON.stringify(body) }), undefined);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  async function put(who: string, classKey: string, body: unknown, o: { session?: number; at?: Temporal.Instant; classId?: string; sessionId?: string } = {}): Promise<Call> {
    const cls = classes[classKey]!;
    const classId = o.classId ?? cls.classId;
    const sessionId = o.sessionId ?? cls.sessionIds[o.session ?? 0]!;
    const res = await onsiteRoute(o.at)(
      new Request(`${BASE}/api/classes/${classId}/sessions/${sessionId}/onsite-headcount`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ classId, sessionId }) },
    );
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json };
  }

  const auditRows = async (sessionId: string) =>
    (
      await q(
        `SELECT actor_kind, actor_staff_account_id::text AS actor, actor_role, academy_id::text AS academy_id, target_table, target_id::text AS target_id,
                before, after, occurred_at
         FROM audit_logs WHERE action = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [ONSITE_HEADCOUNT_CHANGED_AUDIT_ACTION, sessionId],
      )
    ).rows as { actor_kind: string; actor: string; actor_role: string; academy_id: string; target_table: string; target_id: string; before: unknown; after: unknown; occurred_at: Date }[];

  /** 돈 쪽 표 지문 — 행 수와 내용 md5. 현장 인원을 고쳐도 한 글자도 바뀌면 안 된다(O-07 · 수용 ④) */
  const moneyFingerprint = async () =>
    one<Record<string, string>>(
      `SELECT (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM settlement_entries t) AS settlement_entries,
              (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM orders t) AS orders,
              (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM payments t) AS payments,
              (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM order_events t) AS order_events,
              (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM refunds t) AS refunds,
              (SELECT count(*) || ':' || COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM reservations t) AS reservations`,
    );

  beforeAll(async () => {
    handle = openTestDb({ poolMax: 20 });
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    // 다른 DB 테스트의 truncateAll 이 요율 시드를 비우므로 마이그레이션 시드 SQL 로 되살린다(order-create 와 같은 방식)
    const ops = JSON.parse(
      readFileSync(new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url), "utf8"),
    ) as { id: string; execute: { sql: string }[] }[];
    for (const step of ops.find((op) => op.id === "seed.platform_fee_rates")!.execute) await q(step.sql);

    await makeStaff("owner", "owner");
    await makeStaff("ownerB", "owner");
    await makeStaff("junho", "instructor");
    await makeStaff("junhoB", "instructor");
    await makeStaff("delegate", "instructor");
    await makeStaff("classOnly", "instructor");
    await makeStaff("otherInstructor", "instructor");
    ({ academyId, roomId } = await makeAcademy("owner"));
    await affiliate("junho", academyId, ["class_submit"]);
    await affiliate("delegate", academyId, ["roster_manage"]);
    await affiliate("classOnly", academyId, ["class_manage"]);
    await affiliate("otherInstructor", academyId, []);

    // main: 남녀 정원 각 10 · 결제 완료 남 6 으로 맞춘다(계약 수용 시나리오 5 의 그림)
    await makeClass("main", { start: "20:00", end: "21:00", capacity: { mode: "gender_split", male: 10, female: 10 } });
    await q("UPDATE seat_pools SET confirmed_count = 6 WHERE offering_id = $1 AND seat_kind = 'male'", [classes["main"]!.offeringId]);
    // single: 통합 정원 3 — 규칙 7(앱 남은 자리)과 동시성 시험용
    await makeClass("single", { start: "18:00", end: "19:00", capacity: { mode: "single", any: 3 } });

    // 다른 학원 B(대표 ownerB, 강사 junhoB)
    const academyB = await makeAcademy("ownerB");
    await affiliate("junhoB", academyB.academyId, ["roster_manage"], "ownerB");
  });

  afterAll(async () => {
    if (handle === undefined) return;
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("정원 남 10 · 앱 결제 남 6 에서 {male:5} → 409 ONSITE_EXCEEDS_CAPACITY(maxOnsite 남 4 · 여 10), 행 0", async () => {
    const res = await put("owner", "main", { male: 5, female: 0 });
    expect([res.status, res.code]).toEqual([409, "ONSITE_EXCEEDS_CAPACITY"]);
    expect(res.body["maxOnsite"]).toEqual({ male: 4, female: 10 });
    expect(await auditRows(classes["main"]!.sessionIds[0]!)).toHaveLength(0);
    const { rows } = await q("SELECT * FROM session_seat_counters WHERE session_id = $1", [classes["main"]!.sessionIds[0]]);
    expect(rows).toHaveLength(0);
  });

  test("수용 ④ — {male:4, female:2} 200: 감사 행 1건(누가·역할·언제·전후), 주문·결제·정산·예약 표 지문은 그대로", async () => {
    // 비교 대상이 비어 있지 않게 진짜 주문 1건 + 그 주문의 정산 보류 행 1건을 먼저 둔다
    const buyer = await member("fingerprint", "female");
    const ordered = await order(buyer.token, "main", "female");
    expect(ordered.status).toBe(201);
    await q("INSERT INTO settlement_entries (id, order_id, academy_id, kind, amount, status) VALUES (uuidv7(), $1, $2, 'payment_hold', 120000, 'hold')", [
      ordered.body["orderId"],
      academyId,
    ]);
    const before = await moneyFingerprint();
    expect(before["settlement_entries"]!.startsWith("1:")).toBe(true);

    const sessionId = classes["main"]!.sessionIds[0]!;
    const res = await put("owner", "main", { male: 4, female: 2 });
    expect(res.status).toBe(200);
    const body = onsiteHeadcountResponseSchema.parse(res.body);
    // 여: 정원 10 · 앱 확정 0 · 잡힌 자리 1(방금 주문) → 남은 자리 10 − 1 − 0 − 2 = 7, 상한 9
    expect(body.seats).toEqual([
      { seatKind: "male", capacity: 10, appConfirmed: 6, onsite: 4, remaining: 0, maxOnsite: 4 },
      { seatKind: "female", capacity: 10, appConfirmed: 0, onsite: 2, remaining: 7, maxOnsite: 9 },
    ]);
    expect(body.changed).toEqual([
      { seatKind: "male", from: 0, to: 4 },
      { seatKind: "female", from: 0, to: 2 },
    ]);

    const audits = await auditRows(sessionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: "staff",
      actor: staffIds["owner"],
      actor_role: "owner",
      academy_id: academyId,
      target_table: "class_sessions",
      target_id: sessionId,
      before: { male: 0, female: 0 },
      after: { male: 4, female: 2 },
    });
    expect(audits[0]!.occurred_at).toBeInstanceOf(Date);
    // 응답의 updatedAt 은 저장한 시각(시계 = NOW)
    expect(body.updatedAt).toBe("2026-11-21T03:00:00Z");

    // 정산에는 들어가지 않는다 — 돈 쪽 표가 한 글자도 안 바뀌었다
    expect(await moneyFingerprint()).toEqual(before);
  });

  test("같은 값을 다시 보내면 200 · changed [] · 감사 행이 늘지 않는다", async () => {
    const res = await put("owner", "main", { male: 4, female: 2 });
    expect(res.status).toBe(200);
    expect(onsiteHeadcountResponseSchema.parse(res.body).changed).toEqual([]);
    expect(await auditRows(classes["main"]!.sessionIds[0]!)).toHaveLength(1);
  });

  test("명단(§4)이 같은 현장 인원을 읽는다 — onsite 남 4 · 여 2, 다른 회차는 0", async () => {
    const roster = createSessionRosterRoute({ db: handle.db, getSession, clock: fixedClock(NOW), paymentGateway: orderDeps().paymentGateway });
    const read = async (i: number) => {
      const { classId, sessionIds } = classes["main"]!;
      const res = await roster(
        new Request(`${BASE}/api/classes/${classId}/sessions/${sessionIds[i]}/roster`, { headers: { authorization: `Bearer ${tokens["owner"]}` } }),
        { params: Promise.resolve({ classId, sessionId: sessionIds[i]! }) } as never,
      );
      return sessionRosterSchema.parse(await res.json()).seats.map((s) => [s.seatKind, s.onsite]);
    };
    expect(await read(0)).toEqual([["male", 4], ["female", 2]]);
    expect(await read(1)).toEqual([["male", 0], ["female", 0]]);
  });

  test("규칙 7 — 현장 남 4 가 남은 남 자리 4 를 다 쓰면 앱 결제 남은 409 SEAT_SOLD_OUT, 현장 −1 하면 다시 받는다(대기 알림 자리 호출)", async () => {
    const m1 = await member("rule7-a", "male");
    expect((await order(m1.token, "main", "male")).code).toBe("SEAT_SOLD_OUT");

    freed.length = 0;
    const down = await put("delegate", "main", { male: 3, female: 2 });
    expect(down.status).toBe(200);
    expect(freed).toEqual([{ offeringId: classes["main"]!.offeringId, seatKind: "male" }]);
    // 위임 강사가 고친 행은 actor_role instructor, 누가 = 위임 강사
    const audits = await auditRows(classes["main"]!.sessionIds[0]!);
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ actor: staffIds["delegate"], actor_role: "instructor", before: { male: 4, female: 2 }, after: { male: 3, female: 2 } });

    expect((await order(m1.token, "main", "male")).status).toBe(201);
    // 이제 남 자리는 확정 6 + 잡힘 1 + 현장 3 = 10. 다른 회차(2회차)에 현장 남 1 을 넣으려 해도 상한 3 → 남은 자리가 없다
    const second = await put("owner", "main", { male: 4, female: 0 }, { session: 1 });
    expect([second.status, second.body["maxOnsite"]]).toEqual([409, { male: 3, female: 9 }]);
  });

  test("정원 방식과 안 맞는 칸 · 음수 · 정수 아님 → 422 VALIDATION_FAILED, 감사 행 그대로", async () => {
    const sessionId = classes["main"]!.sessionIds[0]!;
    const n = (await auditRows(sessionId)).length;
    for (const body of [{ male: 1 }, { any: 1 }, { male: 1, female: 1, any: 0 }, { male: -1, female: 0 }, { male: 1.5, female: 0 }, { male: "1", female: 0 }]) {
      const res = await put("owner", "main", body);
      expect([res.status, res.code]).toEqual([422, "VALIDATION_FAILED"]);
    }
    const single = await put("owner", "single", { male: 1, female: 0 });
    expect([single.status, single.code]).toEqual([422, "VALIDATION_FAILED"]);
    expect(await auditRows(sessionId)).toHaveLength(n);
  });

  test("권한 — 담당 강사 ○ · 담당이 아닌 강사 · class_manage 만 있는 강사 · 다른 학원 대표 403, 없는 회차·어긋난 수업 404", async () => {
    expect((await put("junho", "main", { male: 1, female: 1 }, { session: 2 })).status).toBe(200);
    expect((await auditRows(classes["main"]!.sessionIds[2]!))[0]).toMatchObject({ actor: staffIds["junho"], actor_role: "instructor" });
    for (const who of ["otherInstructor", "classOnly", "ownerB", "junhoB"]) {
      const res = await put(who, "main", { male: 0, female: 0 }, { session: 2 });
      expect([who, res.status, res.code]).toEqual([who, 403, "FORBIDDEN"]);
    }
    expect((await put("owner", "main", { male: 0, female: 0 }, { sessionId: randomUUID() })).status).toBe(404);
    expect((await put("owner", "main", { male: 0, female: 0 }, { classId: classes["single"]!.classId })).status).toBe(404);
    expect((await put("owner", "main", { male: 0, female: 0 }, { sessionId: "not-a-uuid" })).status).toBe(404);
    // 403·404 는 행을 하나도 바꾸지 않았다 — 3회차는 담당 강사가 쓴 1행 그대로
    expect(await auditRows(classes["main"]!.sessionIds[2]!)).toHaveLength(1);
  });

  test("끝난 회차 409 SESSION_ENDED · 휴강 회차 409 SESSION_CANCELLED · 진행 중 회차는 고친다", async () => {
    const first = await one<{ starts_at: Date; ends_at: Date }>("SELECT starts_at, ends_at FROM class_sessions WHERE id = $1", [classes["main"]!.sessionIds[0]]);
    const during = Temporal.Instant.fromEpochMilliseconds(first.starts_at.getTime() + 10 * 60_000);
    const after = Temporal.Instant.fromEpochMilliseconds(first.ends_at.getTime());
    expect((await put("owner", "main", { male: 2, female: 2 }, { at: during })).status).toBe(200);
    expect((await put("owner", "main", { male: 1, female: 2 }, { at: after })).code).toBe("SESSION_ENDED");

    const cancelled = classes["main"]!.sessionIds[3]!;
    await q("UPDATE class_sessions SET status = 'cancelled', cancelled_at = now(), cancel_reason = '강사 사정' WHERE id = $1", [cancelled]);
    const res = await put("owner", "main", { male: 1, female: 0 }, { session: 3 });
    expect([res.status, res.code]).toEqual([409, "SESSION_CANCELLED"]);
    expect(await auditRows(cancelled)).toHaveLength(0);
  });

  test("동시성 — 통합 정원 3 에 앱 결제 4건과 현장 {any:2} 가 동시에 와도 잡힌 자리 + 확정 + 현장 ≤ 정원(초과 0건)", async () => {
    const buyers = await Promise.all(Array.from({ length: 4 }, (_, i) => member(`race-${i}`, "female")));
    const [onsite, ...orders] = await Promise.all([put("owner", "single", { any: 2 }), ...buyers.map((b) => order(b.token, "single", "any"))]);
    const pool = await one<{ held: number; confirmed: number; capacity: number }>(
      "SELECT held_count AS held, confirmed_count AS confirmed, capacity FROM seat_pools WHERE offering_id = $1",
      [classes["single"]!.offeringId],
    );
    const counter = await one<{ onsite: number } | undefined>(
      "SELECT onsite_count AS onsite FROM session_seat_counters WHERE session_id = $1 AND seat_kind = 'any'",
      [classes["single"]!.sessionIds[0]],
    );
    const onsiteNow = counter?.onsite ?? 0;
    // 진 쪽은 모두 정해진 409 로 끝난다(500 같은 다른 실패가 없다)
    expect([200, 409]).toContain(onsite!.status);
    for (const o of orders) expect([201, 409]).toContain(o.status);
    const won = orders.filter((o) => o.status === 201).length;
    expect(pool.held + pool.confirmed).toBe(won);
    expect(onsiteNow).toBe(onsite!.status === 200 ? 2 : 0);
    expect(pool.held + pool.confirmed + onsiteNow).toBeLessThanOrEqual(pool.capacity);
  });
});
