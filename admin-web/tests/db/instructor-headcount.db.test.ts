// S3-5.9(앱 강사 명단 화면) — `GET /api/instructor/headcount`(계약 18 §7 강사 경로)를 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   I1(강사 홈)·I7(수업 인원 한눈에)이 그리는 하루 인원표: 오늘 인원 = 확정 − 결석 예정 + 현장(computePresent).
//   S3-5.9c(대표 앱 현장 등록·주문 화면) — 같은 픽스처로 대표 경로 `GET /api/academies/{academyId}/headcount`(O6·O40)도 본다.
//     두 경로가 같은 readHeadcount 를 쓰므로 같은 회차는 같은 숫자여야 한다.
//
// 픽스처 한눈에(시계 = 2026-11-24 10:00 KST 화요일):
//   학원 A(라틴하우스 강남, ins active 소속) · 학원 B(라틴스텝 서초, ins 소속 아님)
//   수업 X 「쌈바(입문)」 남녀 정원 10·10, 강사 ins — 회차 11-24 20:30 KST(회차 담당 비어 수업 담당 ins) · 11-24 22:00 휴강 · 11-26 20:30
//     자리: 남 확정 2(m1·m2) · 여 확정 1(m3) · 남 잡힘 1(결제 대기 m4 — 이름이 나오면 안 된다)
//     결석: m1(남) 오늘 회차 결석 예정 · m3(여) 결석은 취소돼 세지 않는다 · 현장 여 1
//     → 남 2−1+0 = 1 · 여 1−0+1 = 2 · 남은 자리 남 10−1−2−0 = 7 · 여 10−0−1−1 = 8
//   수업 Y 「바차타(초급)」 단일 정원 — 오늘 21:10, 회차 담당 other(ins 가 아니다) → ins 표에 없다
//   수업 Z 「B학원수업」 학원 B, 강사 ins, 오늘 19:00 → 소속이 아니라 빠진다
//   개인 레슨: 학원 A, 오늘 18:00 KST, 수강생 m5(여, 닉네임 「김서연」, 본명 「본명비공개」) — 수강권이 결제 대기(pending_payment)
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import {
  createInstructorHeadcountRoute,
  instructorHeadcountSchema,
  parseHeadcountQuery,
  summarizeHeadcount,
} from "@/lib/server/services/instructor-headcount";
import { createOwnerHeadcountRoute, ownerHeadcountSchema } from "@/lib/server/services/owner-headcount";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "instructor-headcount-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-24T01:00:00Z"); // 2026-11-24(화) 10:00 KST

// ---- 순수 규칙(단위) ------------------------------------------------------------------------------

describe("하루 인원표 순수 규칙(계약 18 §7)", () => {
  const today = Temporal.PlainDate.from("2026-11-24");
  test("date 를 비우면 오늘, 모양·없는 날짜·모르는 키는 422", () => {
    expect(parseHeadcountQuery(new URLSearchParams(""), today).date.toString()).toBe("2026-11-24");
    expect(parseHeadcountQuery(new URLSearchParams("date=2026-11-25"), today).date.toString()).toBe("2026-11-25");
    for (const bad of ["date=2026-2-30", "date=2026-02-30", "date=오늘", "academyId=abc", "from=2026-11-24"]) {
      expect(() => parseHeadcountQuery(new URLSearchParams(bad), today)).toThrow();
    }
  });
  test("요약 — 남·여는 줄의 present 합, 단일 정원은 total 에만, 결석 예정 합", () => {
    const s = summarizeHeadcount([
      { kind: "private_lesson", bookingId: randomUUID(), startsAt: "2026-11-24T09:00:00Z", endsAt: "2026-11-24T09:50:00Z", title: "개인 레슨 · 1:1",
        academy: { id: randomUUID(), name: "A" }, roomName: null, student: { nickname: "김서연", gender: "female", awaitingPayment: false },
        present: { male: 0, female: 1 }, absencePlanned: 0 },
      { kind: "class", classId: randomUUID(), sessionId: randomUUID(), startsAt: "2026-11-24T11:30:00Z", endsAt: "2026-11-24T12:30:00Z", title: "쌈바(입문)",
        academy: { id: randomUUID(), name: "A" }, roomName: "A홀", instructor: null, seatMode: "gender_split",
        seats: [ { seatKind: "male", capacity: 10, confirmed: 6, absencePlanned: 1, onsite: 0, present: 5, remaining: 4 },
                 { seatKind: "female", capacity: 10, confirmed: 7, absencePlanned: 0, onsite: 1, present: 8, remaining: 2 } ],
        absence: { male: 1, female: 0 } },
      { kind: "class", classId: randomUUID(), sessionId: randomUUID(), startsAt: "2026-11-24T12:10:00Z", endsAt: "2026-11-24T13:10:00Z", title: "왈츠",
        academy: { id: randomUUID(), name: "B" }, roomName: null, instructor: null, seatMode: "single",
        seats: [{ seatKind: "any", capacity: 20, confirmed: 4, absencePlanned: 0, onsite: 0, present: 4, remaining: 16 }], absence: { any: 0 } },
    ]);
    expect(s).toEqual({ classCount: 2, privateLessonCount: 1, present: { male: 5, female: 9, total: 18 }, absencePlanned: 1 });
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("강사 하루 인원표(S3-5.9 · 계약 18 §7)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let ROUTE: ReturnType<typeof createInstructorHeadcountRoute>;
  let OWNER_ROUTE: ReturnType<typeof createOwnerHeadcountRoute>;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const members: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function makeStaff(key: string, roles: string[], displayName = key) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `hc_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, displayName]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, ownerKey: string, name: string) {
    const id = randomUUID();
    await q(
      `INSERT INTO academies (id, name, refund_policy_tiers, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '[]'::jsonb, '서울', '강남구', now(), ${ACADEMY_SELLER_VALUES})`,
      [id, name],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [id, staffIds[ownerKey]]);
    await q("INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES (uuidv7(), $1, 1, '공지')", [id]);
    ids[key] = id;
  }

  async function affiliate(academyKey: string, staffKey: string) {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now())`,
      [ids[academyKey], staffIds[staffKey]],
    );
  }

  /** 수업 + 판매 단위 1개. 회차는 session() 으로 따로 넣는다 */
  async function makeClass(
    key: string,
    o: { academy: string; instructor: string; title: string; seatMode: "gender_split" | "single"; status?: string; rule?: object; firstStart: string; lastEnd: string },
  ) {
    const classId = randomUUID();
    const offeringId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at, instructor_account_id, updated_at)
       VALUES ($1, $2, $3, '강사', 'salsa_bachata', 'regular', $4, $5, now(), $6, now())`,
      [classId, ids[o.academy], o.title, o.seatMode, o.status ?? "published", staffIds[o.instructor]],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, schedule_rule, updated_at)
       VALUES ($1, $2, '11/23~11/27 · 정규', 'term', 110000, $3, $4, 'open', $5::json, now())`,
      [offeringId, classId, o.firstStart, o.lastEnd, o.rule === undefined ? null : JSON.stringify(o.rule)],
    );
    ids[`${key}Class`] = classId;
    ids[`${key}Offering`] = offeringId;
  }

  async function session(key: string, offeringKey: string, seq: number, startsAt: string, o: { instructor?: string; cancelled?: boolean } = {}) {
    const id = randomUUID();
    const ends = Temporal.Instant.from(startsAt).add({ hours: 1 }).toString();
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, instructor_account_id, status, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ids[`${offeringKey}Offering`], seq, startsAt, ends, o.instructor === undefined ? null : staffIds[o.instructor],
       o.cancelled === true ? "cancelled" : "scheduled", o.cancelled === true ? NOW.toString() : null],
    );
    ids[key] = id;
  }

  async function pool(offeringKey: string, seatKind: string, capacity: number, held: number, confirmed: number) {
    const id = randomUUID();
    await q(
      `INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, held_count, confirmed_count, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, ids[`${offeringKey}Offering`], seatKind, capacity, held, confirmed],
    );
    ids[`${offeringKey}:${seatKind}`] = id;
  }

  async function member(key: string, gender: "male" | "female") {
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '본명비공개', $3, '1994-03-03', '010-1234-5678', $4, $5, now(), now())`,
      [id, `auth-${id}`, gender, `ci-${id}`, `회원${key}`],
    );
    members[key] = id;
  }

  /**
   * 주문 한 건 — 주문 + 예약 + 결제(+ 결제 완료면 pending→paid 기록 행). 자리 숫자는 pool() 에서 따로 정한다(픽스처 합계를 한눈에 보려고).
   * stage: paid(확정) · pending(입금 대기, dueAt) · cancelled(예약 취소, cancelledAt) · refunded(환불, 예약 취소)
   */
  async function order(
    key: string,
    o: {
      member: string;
      offering: string;
      seatKind: string;
      stage: "paid" | "pending" | "cancelled" | "refunded";
      method?: string;
      amount: number;
      createdAt: string;
      paidAt?: string;
      dueAt?: string;
      cancelledAt?: string;
    },
  ) {
    const orderId = randomUUID();
    const offeringId = ids[`${o.offering}Offering`];
    const [notice] = await q<{ id: string }>(
      "SELECT n.id FROM refund_notice_versions n JOIN classes c ON c.academy_id = n.academy_id JOIN class_offerings co ON co.class_id = c.id WHERE co.id = $1",
      [offeringId],
    );
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                           intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                           cancel_fee_platform_share_bp, idempotency_key, paid_at, created_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, $5, $5, '{}'::jsonb, $6, 'v1', 'v1', 'v1', 0, 5000, $7, $8, $9, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, members[o.member], offeringId, o.stage, o.amount, notice!.id, `idem-${orderId}`, o.paidAt ?? null, o.createdAt],
    );
    const reservationStatus = o.stage === "paid" ? "confirmed" : o.stage === "pending" ? "held" : "cancelled";
    const reservationId = randomUUID();
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, cancelled_at, cancel_reason, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [reservationId, orderId, offeringId, ids[`${o.offering}:${o.seatKind}`], o.seatKind, members[o.member], reservationStatus,
       reservationStatus === "cancelled" ? (o.cancelledAt ?? o.createdAt) : null, reservationStatus === "cancelled" ? "member_request" : null],
    );
    const paymentStatus = o.stage === "pending" ? "ready" : o.stage === "cancelled" ? "cancelled" : "paid";
    await q(
      `INSERT INTO payments (id, order_id, method, amount, paid_at, gateway_payment_id, status, due_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7, now())`,
      [orderId, o.method ?? "card", o.amount, paymentStatus === "paid" ? o.paidAt : null, `gw-${orderId}`, paymentStatus, o.dueAt ?? o.createdAt],
    );
    if (o.paidAt !== undefined) {
      await q("INSERT INTO order_events (id, order_id, from_status, to_status, reason, created_at) VALUES (uuidv7(), $1, 'pending', 'paid', 'deposit_confirmed', $2)", [
        orderId,
        o.paidAt,
      ]);
    }
    ids[key] = orderId;
    ids[`${key}Reservation`] = reservationId;
  }

  const bearer = (who: string) => ({ authorization: `Bearer ${tokens[who]}` });

  async function headcount(who: string, search = "") {
    const res = await ROUTE(new Request(`${BASE}/api/instructor/headcount${search}`, { headers: bearer(who) }), { params: Promise.resolve({}) });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cache: res.headers.get("cache-control"), json,
             body: res.status === 200 ? instructorHeadcountSchema.parse(json) : undefined };
  }

  async function ownerHeadcount(who: string, academyKey: string, search = "") {
    const academyId = ids[academyKey] ?? academyKey;
    const res = await OWNER_ROUTE(new Request(`${BASE}/api/academies/${academyId}/headcount${search}`, { headers: bearer(who) }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cache: res.headers.get("cache-control"), json,
             body: res.status === 200 ? ownerHeadcountSchema.parse(json) : undefined };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    ROUTE = createInstructorHeadcountRoute({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    });
    OWNER_ROUTE = createOwnerHeadcountRoute({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    });

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ins", ["instructor"], "이준호");
    await makeStaff("other", ["instructor"], "아이유");
    await makeAcademy("A", "ownerA", "라틴하우스 강남");
    await makeAcademy("B", "ownerB", "라틴스텝 서초");
    await affiliate("A", "ins");
    await affiliate("A", "other");

    await makeClass("X", { academy: "A", instructor: "ins", title: "쌈바(입문)", seatMode: "gender_split",
      firstStart: "2026-11-24T11:30:00Z", lastEnd: "2026-11-26T12:30:00Z" });
    await session("x1", "X", 1, "2026-11-24T11:30:00Z"); // 오늘 20:30 KST — 회차 담당이 비어 수업 담당(ins)
    await session("x2", "X", 2, "2026-11-24T13:00:00Z", { instructor: "ins", cancelled: true }); // 오늘 22:00 휴강 — 빠진다
    await session("x3", "X", 3, "2026-11-26T11:30:00Z", { instructor: "ins" }); // 모레 — date 를 바꾸면 나온다
    await makeClass("Y", { academy: "A", instructor: "ins", title: "바차타(초급)", seatMode: "single",
      firstStart: "2026-11-24T12:10:00Z", lastEnd: "2026-11-24T13:10:00Z" });
    await session("y1", "Y", 1, "2026-11-24T12:10:00Z", { instructor: "other" }); // 회차 담당이 other — ins 표에 없다
    await makeClass("Z", { academy: "B", instructor: "ins", title: "B학원수업", seatMode: "single",
      firstStart: "2026-11-24T10:00:00Z", lastEnd: "2026-11-24T11:00:00Z" });
    await session("z1", "Z", 1, "2026-11-24T10:00:00Z", { instructor: "ins" }); // 소속 아닌 학원 — 빠진다

    await pool("X", "male", 10, 1, 2);
    await pool("X", "female", 10, 0, 1);
    await pool("Y", "any", 20, 0, 3);
    await pool("Z", "any", 10, 0, 1);
    await q("INSERT INTO session_seat_counters (session_id, seat_kind, onsite_count) VALUES ($1, 'female', 1)", [ids["x1"]]);

    for (const [key, gender] of [["m1", "male"], ["m2", "male"], ["m3", "female"], ["m4", "male"], ["m5", "female"]] as const) {
      await member(key, gender);
    }
    await order("o1", { member: "m1", offering: "X", seatKind: "male", stage: "paid", amount: 110000, createdAt: "2026-11-20T01:00:00Z", paidAt: "2026-11-20T01:05:00Z" });
    await order("o2", { member: "m2", offering: "X", seatKind: "male", stage: "paid", amount: 110000, createdAt: "2026-11-20T02:00:00Z", paidAt: "2026-11-20T02:05:00Z" });
    await order("o3", { member: "m3", offering: "X", seatKind: "female", stage: "paid", amount: 110000, createdAt: "2026-11-20T03:00:00Z", paidAt: "2026-11-20T03:05:00Z" });
    // 결제 대기(기한 안) — 숫자로만 잡혀 남은 자리에서 빠지고, 이름은 어디에도 나오지 않는다
    await order("o4", { member: "m4", offering: "X", seatKind: "male", stage: "pending", method: "virtual_account", amount: 110000, createdAt: "2026-11-24T00:00:00Z", dueAt: "2026-11-25T00:00:00Z" });

    // 결석 — m1 살아 있는 결석 1 · m3 은 취소된 결석(세지 않는다)
    await q(`INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id)
             VALUES (uuidv7(), $1, $2, $3, 'member', $3)`, [ids["o1Reservation"], ids["x1"], members["m1"]]);
    await q(`INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, cancelled_at)
             VALUES (uuidv7(), $1, $2, $3, 'member', $3, now())`, [ids["o3Reservation"], ids["x1"], members["m3"]]);

    // 개인 레슨 — 학원 A, 오늘 18:00 KST, 수강권 결제 대기
    await q("UPDATE members SET nickname = '김서연' WHERE id = $1", [members["m5"]]);
    const ruleId = randomUUID();
    await q("INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months) VALUES ($1, $2, $3, 1, 24, 3)",
      [ruleId, ids["A"], staffIds["ins"]]);
    const productClass = randomUUID();
    await q(`INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status, instructor_account_id, approved_at, updated_at)
             VALUES ($1, $2, 'private_lesson', '개인 레슨', 'dance_sport', '강사', 'single', '{}'::json, 'published', $3, now(), now())`,
      [productClass, ids["A"], staffIds["ins"]]);
    await q(`INSERT INTO private_lesson_products (class_id, lesson_minutes, session_count, price_amount, rule_version_id, idempotency_key, updated_at)
             VALUES ($1, 50, 10, 600000, $2, $3, now())`, [productClass, ruleId, `idem-${productClass}`]);
    const passId = randomUUID();
    await q(`INSERT INTO private_lesson_passes (id, product_class_id, member_id, rule_version_id, discipline, sessions_total, sessions_used, status, updated_at)
             VALUES ($1, $2, $3, $4, 'rumba', 10, 0, 'pending_payment', now())`, [passId, productClass, members["m5"], ruleId]);
    const slotId = randomUUID();
    await q(`INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at, status)
             VALUES ($1, $2, $3, $4, '2026-11-24T09:00:00Z', '2026-11-24T09:50:00Z', 'booked')`, [slotId, productClass, ids["A"], staffIds["ins"]]);
    ids["booking"] = randomUUID();
    await q("INSERT INTO private_lesson_bookings (id, pass_id, slot_id, booked_by, status, updated_at) VALUES ($1, $2, $3, 'instructor', 'booked', now())",
      [ids["booking"], passId, slotId]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("오늘(기본) — 개인 레슨 18:00 + 쌈바 20:30 두 줄, 오늘 인원 = 확정 − 결석 예정 + 현장", async () => {
    const res = await headcount("ins");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const academy = { id: ids["A"], name: "라틴하우스 강남" };
    expect(res.body).toEqual({
      date: "2026-11-24",
      summary: { classCount: 1, privateLessonCount: 1, present: { male: 1, female: 3, total: 4 }, absencePlanned: 1 },
      items: [
        { kind: "private_lesson", bookingId: ids["booking"], startsAt: "2026-11-24T09:00:00Z", endsAt: "2026-11-24T09:50:00Z",
          title: "개인 레슨 · 1:1", academy, roomName: null, student: { nickname: "김서연", gender: "female", awaitingPayment: true },
          present: { male: 0, female: 1 }, absencePlanned: 0 },
        { kind: "class", classId: ids["XClass"], sessionId: ids["x1"], startsAt: "2026-11-24T11:30:00Z", endsAt: "2026-11-24T12:30:00Z",
          title: "쌈바(입문)", academy, roomName: null, instructor: { displayName: "이준호" }, seatMode: "gender_split",
          seats: [ { seatKind: "male", capacity: 10, confirmed: 2, absencePlanned: 1, onsite: 0, present: 1, remaining: 7 },
                   { seatKind: "female", capacity: 10, confirmed: 1, absencePlanned: 0, onsite: 1, present: 2, remaining: 8 } ],
          absence: { male: 1, female: 0 } },
      ],
    });
  });

  test("이름은 닉네임만 — 본명·연락처·결제 대기 회원 닉네임이 응답에 없다(1:1 결제 대기 수강생 닉네임만 있다)", async () => {
    const text = JSON.stringify((await headcount("ins")).json);
    expect(text).not.toContain("본명비공개");
    expect(text).not.toContain("010-1234-5678");
    expect(text).not.toContain("회원m4");
    expect(text).toContain("김서연");
  });

  test("다른 날짜 — 11-26 은 쌈바 3회차 한 줄(결석·현장 없음)", async () => {
    const body = (await headcount("ins", "?date=2026-11-26")).body!;
    expect(body.items.map((i) => (i.kind === "class" ? i.sessionId : i.bookingId))).toEqual([ids["x3"]]);
    expect(body.summary).toEqual({ classCount: 1, privateLessonCount: 0, present: { male: 2, female: 1, total: 3 }, absencePlanned: 0 });
  });

  test("학원 고르기 — A 는 같은 두 줄, 소속이 아닌 B 는 403", async () => {
    expect((await headcount("ins", `?academyId=${ids["A"]}`)).body!.items).toHaveLength(2);
    const b = await headcount("ins", `?academyId=${ids["B"]}`);
    expect([b.status, b.code]).toEqual([403, "FORBIDDEN"]);
  });

  test("회차 담당 기준 — other 는 바차타 한 줄만(쌈바·개인 레슨은 ins 몫)", async () => {
    const body = (await headcount("other")).body!;
    expect(body.items.map((i) => i.title)).toEqual(["바차타(초급)"]);
    expect(body.summary.present).toEqual({ male: 0, female: 0, total: 3 });
  });

  test("권한·입력 — 대표 403, date 모양 오류 422, 모르는 키 422", async () => {
    expect((await headcount("ownerA")).status).toBe(403);
    expect((await headcount("ins", "?date=2026-13-01")).status).toBe(422);
    expect((await headcount("ins", "?from=2026-11-24")).status).toBe(422);
  });

  // ---- 대표 경로(S3-5.9c · O6 · O40) --------------------------------------------------------------

  test("대표 A 오늘 — 강사를 가리지 않고 학원 A 의 세 줄(개인 레슨 18:00 · 쌈바 20:30 · 바차타 21:10), 휴강·학원 B 는 없다", async () => {
    const res = await ownerHeadcount("ownerA", "A");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = res.body!;
    expect(body.items.map((i) => i.title)).toEqual(["개인 레슨 · 1:1", "쌈바(입문)", "바차타(초급)"]);
    // 남녀 1·3 은 쌈바·개인 레슨, 단일 정원 바차타 3명은 total 에만
    expect(body.summary).toEqual({ classCount: 2, privateLessonCount: 1, present: { male: 1, female: 3, total: 7 }, absencePlanned: 1 });
    const samba = body.items.find((i) => i.kind === "class" && i.sessionId === ids["x1"]);
    // 강사 경로와 같은 회차는 같은 숫자 — O40 이 쓰는 정원·확정·현장·남은 자리 칸
    const insSamba = (await headcount("ins")).body!.items.find((i) => i.kind === "class" && i.sessionId === ids["x1"]);
    expect(samba).toEqual(insSamba);
    const bachata = body.items.find((i) => i.kind === "class" && i.sessionId === ids["y1"]);
    expect(bachata).toMatchObject({ instructor: { displayName: "아이유" }, seatMode: "single",
      seats: [{ seatKind: "any", capacity: 20, confirmed: 3, absencePlanned: 0, onsite: 0, present: 3, remaining: 17 }], absence: { any: 0 } });
  });

  test("대표 경로도 닉네임만 — 본명·연락처·결제 대기 회원 닉네임이 없다", async () => {
    const text = JSON.stringify((await ownerHeadcount("ownerA", "A")).json);
    expect(text).not.toContain("본명비공개");
    expect(text).not.toContain("010-1234-5678");
    expect(text).not.toContain("회원m4");
  });

  test("대표 B 는 자기 학원 한 줄(B학원수업) — 학원 A 강사 소속과 상관없다", async () => {
    const body = (await ownerHeadcount("ownerB", "B")).body!;
    expect(body.items.map((i) => i.title)).toEqual(["B학원수업"]);
  });

  test("대표 경로 다른 날짜 — 11-26 은 쌈바 3회차 한 줄", async () => {
    const body = (await ownerHeadcount("ownerA", "A", "?date=2026-11-26")).body!;
    expect(body.items.map((i) => (i.kind === "class" ? i.sessionId : i.bookingId))).toEqual([ids["x3"]]);
  });

  test("대표 경로 권한·입력 — 남의 학원 403 · 강사 403 · date 오류 422 · academyId 쿼리는 모르는 키 422 · 없는 id 모양 404", async () => {
    const other = await ownerHeadcount("ownerA", "B");
    expect([other.status, other.code]).toEqual([403, "FORBIDDEN"]);
    expect((await ownerHeadcount("ins", "A")).status).toBe(403);
    expect((await ownerHeadcount("ownerA", "A", "?date=2026-02-30")).status).toBe(422);
    expect((await ownerHeadcount("ownerA", "A", `?academyId=${ids["A"]}`)).status).toBe(422);
    expect([403, 404]).toContain((await ownerHeadcount("ownerA", "not-a-uuid")).status);
  });
});
