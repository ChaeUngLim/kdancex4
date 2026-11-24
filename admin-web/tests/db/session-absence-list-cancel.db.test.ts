// S3-5.9b(앱 강사 결석 표시 화면 I26) — 이 Task 가 더한 서버 경로 두 개
//   `GET  /api/classes/{classId}/sessions/{sessionId}/absences`                 오늘 결석 목록(계약 18 §8)
//   `POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel` 결석 표시 취소(계약 04 §6-2)
//   확인하는 것: 목록 순서·칸(회원이 알린 것 + 직원이 표시한 것 · 개월 수 · 연락처 없음) · absenceCount 가 명단(계약 18 §4)의 결석 예정과 같다 ·
//               이의 처리 자격(표시한 본인·대표만) · 이의 결과(유지 = items 에 rejected · 받아들임 = acceptedDisputes) ·
//               취소 → 감사 attendance.cancelled 1행 · 다시 취소해도 200 같은 본문 · 이의 걸린 행 취소 = 받아들임 + 회원 알림 1건 ·
//               잠긴 뒤 강사 403 · 대표 사유 없음 422 · 대표 사유 있음 200 · 시작 전 409 · 권한 없는 강사 403 · 다른 회차의 표시 404
// 준비(학원·수업·주문 확정)는 staff-absence-marks.db.test.ts 와 같은 진짜 경로를 쓴다.
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
import { createMeSessionAbsenceRoutes } from "@/lib/server/services/me-session-absence";
import { createOrderRoute } from "@/lib/server/services/order-create";
import { createPaymentWebhookRoute } from "@/lib/server/services/payment-webhook";
import {
  absenceCancelResponseSchema,
  createStaffAbsenceMarkRoutes,
  sessionAbsenceListSchema,
  staffAbsenceMarkResponseSchema,
} from "@/lib/server/services/staff-absence-marks";
import { createAbsenceDisputeRoutes } from "@/lib/server/services/absence-disputes";
import { createSessionRosterRoute, sessionRosterSchema } from "@/lib/server/services/session-roster";
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


/** 시연 이름은 보드 I26 예시(최하은 · 정우진)를 따른다. 전화번호는 응답에 새지 않는지 보려고 서로 다르게 둔다 */
const PEOPLE: Record<string, { nickname: string; gender: "male" | "female"; phone?: string }> = {
  haeun: { nickname: "최하은", gender: "female", phone: "01077770001" },
  woojin: { nickname: "정우진", gender: "male", phone: "01077770002" },
  seojun: { nickname: "김서준", gender: "male", phone: "01077770003" },
  sua: { nickname: "이수아", gender: "female", phone: "01077770004" },
  other1: { nickname: "다른반", gender: "male", phone: "01077770005" },
};

type Capacity = { mode: "gender_split"; male: number; female: number } | { mode: "single"; any: number };

describe.skipIf(!dbAvailable())("오늘 결석 목록·결석 표시 취소(계약 18 §8 · 04 §6-2, S3-5.9b)", () => {
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
    const who = PEOPLE[key] ?? { nickname: "서연", gender: "male" as const };
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, base_genre, updated_at)
       VALUES ($1, $2, '김회원', $3, $4, $5, $6, $7, now(), 'dance_sport', now())`,
      [id, userId, o.gender ?? who.gender, o.birthDate ?? "1995-03-02", who.phone ?? "01012345678", `ci-${randomUUID()}`, who.nickname],
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
    const res = await order(who, bodyFor(offeringKey, { seatKind: PEOPLE[who]?.gender ?? "male" }));
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
  const BEFORE = FIRST_START.subtract({ hours: 2 });
  const DURING = FIRST_START.add({ minutes: 20 });
  const AT_1H = FIRST_END.add({ hours: 1 });
  const AT_2H = FIRST_END.add({ hours: 2 });
  const AT_49H = FIRST_END.add({ hours: 49 });

  type ApiCall = { status: number; code?: string; body: Record<string, unknown>; text: string };
  const ask = async (res: Response): Promise<ApiCall> => {
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, body: json, text };
  };
  const auth_ = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const routes = (now: Temporal.Instant) => createStaffAbsenceMarkRoutes({ db: handle.db, getSession, clock: fixedClock(now) });

  async function listAbsences(token: string, ids: { classId: string; sessionId: string }, now: Temporal.Instant = AT_1H): Promise<ApiCall> {
    return ask(
      await routes(now).list(new Request(`${BASE}/api/classes/${ids.classId}/sessions/${ids.sessionId}/absences`, { headers: auth_(token) }), {
        params: Promise.resolve(ids),
      }),
    );
  }
  async function markAbsence(token: string, ids: { classId: string; sessionId: string }, memberId: string, now: Temporal.Instant = AT_1H) {
    return ask(
      await routes(now).mark(
        new Request(`${BASE}/api/classes/${ids.classId}/sessions/${ids.sessionId}/absences`, { method: "POST", headers: auth_(token), body: JSON.stringify({ memberId }) }),
        { params: Promise.resolve(ids) },
      ),
    );
  }
  async function cancelMark(token: string, ids: { classId: string; sessionId: string }, markId: string, body: unknown, now: Temporal.Instant = AT_2H) {
    return ask(
      await routes(now).cancel(
        new Request(`${BASE}/api/classes/${ids.classId}/sessions/${ids.sessionId}/absences/${markId}/cancel`, {
          method: "POST",
          headers: auth_(token),
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ ...ids, markId }) },
      ),
    );
  }
  async function dispute(memberKey: string, markId: string, reason: string) {
    const route = createAbsenceDisputeRoutes({ db: handle.db, getSession, clock: fixedClock(AT_1H.add({ minutes: 10 })) }).requestDispute;
    return ask(
      await route(new Request(`${BASE}/api/me/attendance-marks/${markId}/dispute`, { method: "POST", headers: auth_(memberTokens[memberKey]!), body: JSON.stringify({ reason }) }), {
        params: Promise.resolve({ markId }),
      }),
    );
  }
  async function resolve(token: string, markId: string, decision: "accept" | "reject") {
    const route = createAbsenceDisputeRoutes({ db: handle.db, getSession, clock: fixedClock(AT_1H.add({ minutes: 20 })) }).resolveDispute;
    return ask(
      await route(new Request(`${BASE}/api/attendance-marks/${markId}/dispute/resolve`, { method: "POST", headers: auth_(token), body: JSON.stringify({ decision }) }), {
        params: Promise.resolve({ markId }),
      }),
    );
  }
  const countAudit = async (action: string, markId: string) =>
    (await one<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE action = $1 AND target_id = $2", [action, markId])).n;

  let ids = { classId: "", sessionId: "" };
  const markIds: Record<string, string> = {};

  beforeAll(async () => {
    for (const who of ["haeun", "woojin", "seojun", "sua"]) await confirmOrder(who, "mine");
    const classId = (await one<{ id: string }>("SELECT class_id::text AS id FROM class_offerings WHERE id = $1", [offerings["mine"]])).id;
    const sessionId = (await one<{ id: string }>("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at LIMIT 1", [offerings["mine"]])).id;
    ids = { classId, sessionId };

    // 최하은 — 수업 전에 회원이 직접 결석 예정을 알린다(§5)
    const me = createMeSessionAbsenceRoutes({ db: handle.db, getSession, clock: fixedClock(BEFORE) });
    const put = await me.put(new Request(`${BASE}/api/me/sessions/${sessionId}/absence`, { method: "PUT", headers: { authorization: `Bearer ${memberTokens["haeun"]}` } }), {
      params: Promise.resolve({ sessionId }),
    });
    expect(put.status).toBe(201);
    // 정우진 · 김서준 — 수업 중에 담당 강사가 표시한다
    for (const who of ["woojin", "seojun"]) {
      const res = await markAbsence(tokens["junho"]!, ids, memberIds[who]!, DURING);
      expect(res.status).toBe(201);
      markIds[who] = staffAbsenceMarkResponseSchema.parse(res.body).markId;
    }
  });

  test("① 목록 — 알린 순서대로 두 종류가 같이 나오고, 결석 수는 명단(계약 18 §4)의 결석 예정과 같다 · 연락처 없음", async () => {
    const res = await listAbsences(tokens["junho"]!, ids);
    expect(res.status).toBe(200);
    const list = sessionAbsenceListSchema.parse(res.body);
    expect(list.items.map((i) => [i.nickname, i.gender, i.markedByKind])).toEqual([
      ["최하은", "female", "member"],
      ["정우진", "male", "instructor"],
      ["김서준", "male", "instructor"],
    ]);
    expect(list).toMatchObject({
      title: "수업 mine",
      academyName: "학원 A",
      roomName: "A홀",
      window: "open",
      viewerRole: "instructor",
      seatCount: 4,
      absenceCount: { male: 2, female: 1, any: 0, total: 3 },
      acceptedDisputes: [],
    });
    expect(list.items.every((i) => i.monthsEnrolled === 2 && i.disputeStatus === "none" && i.disputeReason === null && !i.canResolveDispute)).toBe(true);
    // 개월 수 — 첫 결제 11/21(KST) → 회차 12/01 이라 11·12월 = 2
    // 회원 전화번호(전체·뒷자리)가 응답 어디에도 없다
    for (const p of Object.values(PEOPLE)) expect(res.text.includes(p.phone!)).toBe(false);

    // 명단 경로의 자리별 결석 예정 합과 같다 — 홈 표·명단·I26 숫자가 늘 같다
    const roster = createSessionRosterRoute({ db: handle.db, getSession, clock: fixedClock(AT_1H), paymentGateway: pg() });
    const r = await roster(new Request(`${BASE}/api/classes/${ids.classId}/sessions/${ids.sessionId}/roster`, { headers: auth_(tokens["owner"]!) }), {
      params: Promise.resolve(ids),
    });
    const parsed = sessionRosterSchema.parse(await r.json());
    expect(parsed.seats.map((s) => [s.seatKind, s.absencePlanned])).toEqual([
      ["male", list.absenceCount.male],
      ["female", list.absenceCount.female],
    ]);
  });

  test("② 이의가 걸리면 사유가 보이고, 처리 단추 자격은 표시한 본인과 대표만", async () => {
    expect((await dispute("woojin", markIds["woojin"]!, "그날 수업에 갔어요")).status).toBe(200);
    const byMarker = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids)).body);
    expect(byMarker.items.find((i) => i.nickname === "정우진")).toMatchObject({ disputeStatus: "requested", disputeReason: "그날 수업에 갔어요", canResolveDispute: true });
    const byOwner = sessionAbsenceListSchema.parse((await listAbsences(tokens["owner"]!, ids)).body);
    expect(byOwner.viewerRole).toBe("owner");
    expect(byOwner.items.find((i) => i.nickname === "정우진")?.canResolveDispute).toBe(true);
    const byDelegate = sessionAbsenceListSchema.parse((await listAbsences(tokens["deleg"]!, ids)).body);
    expect(byDelegate.items.find((i) => i.nickname === "정우진")?.canResolveDispute).toBe(false);
  });

  test("③ 이의 결과 — 유지하면 items 에 rejected, 받아들이면 items 에서 빠지고 acceptedDisputes 로 간다", async () => {
    expect((await dispute("seojun", markIds["seojun"]!, "늦게 들어갔어요")).status).toBe(200);
    expect((await resolve(tokens["junho"]!, markIds["seojun"]!, "reject")).status).toBe(200);
    expect((await resolve(tokens["junho"]!, markIds["woojin"]!, "accept")).status).toBe(200);
    const list = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids)).body);
    expect(list.items.map((i) => [i.nickname, i.disputeStatus])).toEqual([
      ["최하은", "none"],
      ["김서준", "rejected"],
    ]);
    expect(list.items[1]).toMatchObject({ disputeReason: "늦게 들어갔어요", canResolveDispute: false });
    expect(list.acceptedDisputes).toEqual([
      expect.objectContaining({ markId: markIds["woojin"], nickname: "정우진", gender: "male", disputeReason: "그날 수업에 갔어요" }),
    ]);
    expect(list.absenceCount).toEqual({ male: 1, female: 1, any: 0, total: 2 });
  });

  test("④ 취소 — 담당 강사가 48시간 안에 끄면 200 + 감사 1행, 다시 꺼도 200 같은 본문(감사 그대로), 목록에서 빠진다", async () => {
    const haeun = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids)).body).items.find((i) => i.nickname === "최하은")!;
    const first = await cancelMark(tokens["junho"]!, ids, haeun.markId, {});
    expect(first.status).toBe(200);
    expect(absenceCancelResponseSchema.parse(first.body)).toEqual({
      markId: haeun.markId,
      cancelledAt: AT_2H.toString({ smallestUnit: "second" }),
      disputeStatus: "none",
    });
    expect(await countAudit("attendance.cancelled", haeun.markId)).toBe(1);
    const again = await cancelMark(tokens["junho"]!, ids, haeun.markId, { reason: "다시 눌렀어요" }, AT_2H.add({ minutes: 5 }));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await countAudit("attendance.cancelled", haeun.markId)).toBe(1);
    const list = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids)).body);
    expect(list.items.map((i) => i.nickname)).toEqual(["김서준"]);
    // 회원이 알린 결석 예정은 이의가 없으니 받아들임 목록에도 가지 않는다
    expect(list.acceptedDisputes.map((i) => i.nickname)).toEqual(["정우진"]);
  });

  test("⑤ 이의가 걸린 행을 취소하면 받아들인 것과 같다 — accepted + 회원 알림 1건", async () => {
    const res = await markAbsence(tokens["owner"]!, ids, memberIds["sua"]!);
    expect(res.status).toBe(201);
    const markId = staffAbsenceMarkResponseSchema.parse(res.body).markId;
    expect((await dispute("sua", markId, "출석했어요")).status).toBe(200);
    const cancelled = await cancelMark(tokens["owner"]!, ids, markId, { reason: "확인했어요" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body["disputeStatus"]).toBe("accepted");
    const notice = await one<{ n: number; decision: string }>(
      "SELECT count(*)::int AS n, max(payload->>'decision') AS decision FROM notifications WHERE kind = 'absence_dispute_resolved' AND recipient_member_id = $1",
      [memberIds["sua"]],
    );
    expect(notice).toEqual({ n: 1, decision: "accept" });
    const row = await one<{ by: string; resolved: boolean }>(
      "SELECT dispute_resolved_by_account_id::text AS by, dispute_resolved_at IS NOT NULL AS resolved FROM attendance_marks WHERE id = $1",
      [markId],
    );
    expect(row).toEqual({ by: staffIds["owner"], resolved: true });
    const list = sessionAbsenceListSchema.parse((await listAbsences(tokens["owner"]!, ids)).body);
    expect(list.acceptedDisputes.map((i) => i.nickname)).toEqual(["정우진", "이수아"]);
  });

  test("⑥ 잠긴 뒤(49시간) — 강사 403 · 대표 사유 없음 422 · 대표 사유 있음 200(감사에 사유) · 목록은 locked", async () => {
    const seojun = markIds["seojun"]!;
    const list = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids, AT_49H)).body);
    expect(list.window).toBe("locked");
    expect((await cancelMark(tokens["junho"]!, ids, seojun, { reason: "실수" }, AT_49H)).status).toBe(403);
    const noReason = await cancelMark(tokens["owner"]!, ids, seojun, {}, AT_49H);
    expect([noReason.status, noReason.code]).toEqual([422, "ABSENCE_REASON_REQUIRED"]);
    expect((await cancelMark(tokens["owner"]!, ids, seojun, { reason: "CCTV 확인 — 출석" }, AT_49H)).status).toBe(200);
    const audit = await one<{ reason: string; role: string }>(
      "SELECT reason, actor_role AS role FROM audit_logs WHERE action = 'attendance.cancelled' AND target_id = $1",
      [seojun],
    );
    expect(audit).toEqual({ reason: "CCTV 확인 — 출석", role: "owner" });
  });

  test("⑦ 시작 전 취소 409 · 권한 없는 강사 403(목록·취소) · 다른 회차의 표시 404 · 시작 전 목록은 before_start", async () => {
    const before = sessionAbsenceListSchema.parse((await listAbsences(tokens["junho"]!, ids, BEFORE)).body);
    expect(before.window).toBe("before_start");
    const early = await cancelMark(tokens["junho"]!, ids, markIds["woojin"]!, {}, BEFORE);
    expect([early.status, early.code]).toEqual([409, "SESSION_NOT_STARTED"]);
    expect((await listAbsences(tokens["stranger"]!, ids)).status).toBe(403);
    expect((await listAbsences(tokens["owner2"]!, ids)).status).toBe(403);
    expect((await cancelMark(tokens["stranger"]!, ids, markIds["woojin"]!, {})).status).toBe(403);
    const second = (await one<{ id: string }>("SELECT id::text AS id FROM class_sessions WHERE offering_id = $1 ORDER BY starts_at OFFSET 1 LIMIT 1", [offerings["mine"]])).id;
    const other = await cancelMark(tokens["owner"]!, { classId: ids.classId, sessionId: second }, markIds["woojin"]!, {}, AT_2H.add({ hours: 72 }));
    expect(other.status).toBe(404);
    expect((await cancelMark(tokens["owner"]!, ids, "not-a-uuid", {})).status).toBe(404);
  });
});
