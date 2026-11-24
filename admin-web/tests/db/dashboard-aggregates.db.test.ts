// S3-5.6(대시보드 결제 타일·강사 집계) — 대표 대시보드 결제 뒤 타일(계약 10 §1)과 강사 집계(계약 18 §9)가
// 픽스처로 넣은 합계와 같은지 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   이름: 로드맵 verify 의 tests/db/s3-5-6.db.test.ts 는 Task 번호 이름이라 기능 이름(dashboard-aggregates)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 픽스처 한눈에(시계 = 2026-11-23 14:00 KST 월요일, 학원 A):
//   수업 X 「쌈바(입문)」(강사 ins, 남녀 정원 10·10, 월·수 반복) — 회차 11-23(월) · 11-25(수) · 11-27(금, 휴강)
//     자리: 남 확정 8 → 남은 2(마감 임박) · 여 확정 5 · 잡힌 2(그중 1건은 기한 지난 결제 대기 → 읽기 전 정리로 풀림) · 현장 여 1 → 남은 3
//   수업 Y 「바차타(초급)」(강사 other, 단일 정원 20, 반복 규칙 없음) — 11-24(화, ins 대타) · 11-26(목, other)
//   주문: 오늘 신청 3건(o1·o2·o5 — o5 는 KST 자정 직후) · 오늘 결제 3건 110,000 + 50,000 + 40,000 = 200,000 ·
//         입금 대기 1건(o2) · paid→paid 기록 행은 안 센다 · KST 어제(23:50)의 o6 은 안 센다 · 학원 B 주문은 안 센다
//   신규 회원(11월): m1·m4·m6 = 3명(m7 은 10월에 처음 결제해 빠진다)
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import {
  createInstructorDashboardRoute,
  defaultWeek,
  instructorDashboardSchema,
  totalsByWeekday,
  weekdaysFromRule,
  weekdaysFromStarts,
} from "@/lib/server/services/instructor-dashboard";
import { createOwnerDashboardRoute, ownerDashboardSchema } from "@/lib/server/services/owner-dashboard";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "dashboard-aggregates-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-23T05:00:00Z"); // 2026-11-23(월) 14:00 KST

// ---- 순수 규칙(단위) ------------------------------------------------------------------------------

describe("강사 집계 순수 규칙(계약 18 §9)", () => {
  test("기본 기간은 오늘이 든 주의 월~일 — 일요일·월요일 경계", () => {
    const sunday = defaultWeek(Temporal.PlainDate.from("2026-11-29"));
    expect([sunday.from.toString(), sunday.to.toString()]).toEqual(["2026-11-23", "2026-11-29"]);
    const monday = defaultWeek(Temporal.PlainDate.from("2026-11-23"));
    expect([monday.from.toString(), monday.to.toString()]).toEqual(["2026-11-23", "2026-11-29"]);
  });
  test("요일별 합 — 월·수 수업은 양쪽에 센다, 안 나온 요일은 뺀다, 월요일부터", () => {
    expect(
      totalsByWeekday([
        { weekdays: ["wed", "mon"], applicants: 13 },
        { weekdays: ["tue"], applicants: 3 },
        { weekdays: ["mon"], applicants: 2 },
      ]),
    ).toEqual([
      { weekday: "mon", applicants: 15 },
      { weekday: "tue", applicants: 3 },
      { weekday: "wed", applicants: 13 },
    ]);
  });
  test("요일 — 반복 규칙에서 읽고, 없거나 모양이 틀리면 회차 KST 요일로", () => {
    expect(weekdaysFromRule('{"kind":"recurring","weekdays":["wed","mon"]}')).toEqual(["mon", "wed"]);
    expect(weekdaysFromRule("")).toBeNull();
    expect(weekdaysFromRule('{"kind":"dates"}')).toBeNull();
    // 2026-11-24T15:30Z 는 KST 로 11-25(수) 00:30 — UTC 날짜(화)로 읽으면 틀린다
    expect(weekdaysFromStarts(["2026-11-24T15:30:00Z", "2026-11-24T02:00:00Z"])).toEqual(["tue", "wed"]);
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("대시보드 결제 타일·강사 집계(S3-5.6)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let OWNER: ReturnType<typeof createOwnerDashboardRoute>;
  let INSTRUCTOR: ReturnType<typeof createInstructorDashboardRoute>;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const members: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function makeStaff(key: string, roles: string[], displayName = key) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `dash_${key.toLowerCase()}`, displayUsername: key },
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

  async function ownerDashboard(who: string, academyKey: string, search = "") {
    const academyId = ids[academyKey]!;
    const res = await OWNER(new Request(`${BASE}/api/academies/${academyId}/dashboard${search}`, { headers: bearer(who) }), {
      params: Promise.resolve({ academyId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, json, body: res.status === 200 ? ownerDashboardSchema.parse(json) : undefined };
  }

  async function instructorDashboard(who: string, search = "") {
    const res = await INSTRUCTOR(new Request(`${BASE}/api/instructor/dashboard${search}`, { headers: bearer(who) }), { params: Promise.resolve({}) });
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, code: json["code"] as string | undefined, cache: res.headers.get("cache-control"), json,
             body: res.status === 200 ? instructorDashboardSchema.parse(json) : undefined };
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = {
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    };
    OWNER = createOwnerDashboardRoute(deps);
    INSTRUCTOR = createInstructorDashboardRoute(deps);

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ins", ["instructor"], "이준호");
    await makeStaff("other", ["instructor"], "아이유");
    await makeAcademy("A", "ownerA", "라틴하우스 강남");
    await makeAcademy("B", "ownerB", "라틴스텝 서초");
    await affiliate("A", "ins");
    await affiliate("A", "other");
    // ins 는 학원 B 소속이 아니다 — B 에 ins 가 담당인 수업이 있어도 집계에 들어가지 않는다

    // 수업 X — 월·수 반복, 남녀 정원
    await makeClass("X", { academy: "A", instructor: "ins", title: "쌈바(입문)", seatMode: "gender_split",
      rule: { kind: "recurring", weekdays: ["mon", "wed"], startTime: "20:30", endTime: "21:30", periodFrom: "2026-11-23", sessionCount: 3 },
      firstStart: "2026-11-23T11:30:00Z", lastEnd: "2026-11-27T12:30:00Z" });
    await session("x1", "X", 1, "2026-11-23T11:30:00Z"); // 오늘 20:30 KST — 회차 담당이 비어 수업 담당(ins)으로 본다
    await session("x2", "X", 2, "2026-11-25T11:30:00Z", { instructor: "ins" });
    await session("x3", "X", 3, "2026-11-27T11:30:00Z", { cancelled: true }); // 휴강 — 세지 않는다
    // 수업 Y — 반복 규칙 없음, 단일 정원. 11-24 회차는 ins 가 대타
    await makeClass("Y", { academy: "A", instructor: "other", title: "바차타(초급)", seatMode: "single",
      firstStart: "2026-11-20T11:00:00Z", lastEnd: "2026-11-26T12:00:00Z" });
    await session("y0", "Y", 1, "2026-11-20T11:00:00Z", { instructor: "other" });
    await session("y1", "Y", 2, "2026-11-24T11:00:00Z", { instructor: "ins" });
    await session("y2", "Y", 3, "2026-11-26T11:00:00Z", { instructor: "other" });
    // 수업 D — 승인 전(초안 아님, 승인 대기) 수업은 회차가 있어도 세지 않는다
    await makeClass("D", { academy: "A", instructor: "ins", title: "승인대기수업", seatMode: "single", status: "pending_approval",
      firstStart: "2026-11-24T01:00:00Z", lastEnd: "2026-11-24T02:00:00Z" });
    await session("d1", "D", 1, "2026-11-24T01:00:00Z", { instructor: "ins" });
    // 수업 Z — 학원 B(ins 는 소속 아님)
    await makeClass("Z", { academy: "B", instructor: "ins", title: "B학원수업", seatMode: "single",
      firstStart: "2026-11-24T03:00:00Z", lastEnd: "2026-11-24T04:00:00Z" });
    await session("z1", "Z", 1, "2026-11-24T03:00:00Z", { instructor: "ins" });

    // 자리 — 픽스처 합계(주문 행과 별개로 숫자를 정한다)
    await pool("X", "male", 10, 0, 8);
    await pool("X", "female", 10, 2, 5); // 잡힌 2 = o2(기한 안) + o3(기한 지남 → 정리되면 1)
    await pool("Y", "any", 20, 0, 3);
    await pool("D", "any", 10, 0, 0);
    await pool("Z", "any", 10, 0, 1);
    // 현장 등록 — X 오늘 회차 여 1(남은 자리에서 빠진다)
    await q("INSERT INTO session_seat_counters (session_id, seat_kind, onsite_count) VALUES ($1, 'female', 1)", [ids["x1"]]);

    for (const [key, gender] of [["m1", "male"], ["m2", "female"], ["m3", "female"], ["m4", "female"], ["m5", "male"], ["m6", "male"], ["m7", "female"], ["mb", "male"]] as const) {
      await member(key, gender);
    }
    // 오늘(KST 11-23) 신청·결제
    await order("o1", { member: "m1", offering: "X", seatKind: "male", stage: "paid", amount: 110000, createdAt: "2026-11-23T01:00:00Z", paidAt: "2026-11-23T01:05:00Z" });
    // o1 에 늦게 들어온 입금 기록(paid → paid) — 전이가 아니라 결제 건수·금액에 다시 세지 않는다
    await q("INSERT INTO order_events (id, order_id, from_status, to_status, reason, created_at) VALUES (uuidv7(), $1, 'paid', 'paid', 'deposit_after_close', '2026-11-23T03:00:00Z')", [ids["o1"]]);
    await order("o2", { member: "m2", offering: "X", seatKind: "female", stage: "pending", method: "virtual_account", amount: 110000, createdAt: "2026-11-23T02:00:00Z", dueAt: "2026-11-24T00:00:00Z" });
    // o3 — 어제 신청한 가상계좌, 기한(11-23 13:00 KST)이 지났다 → 읽기 전 정리로 expired, 입금 대기에서 빠진다
    await order("o3", { member: "m3", offering: "X", seatKind: "female", stage: "pending", method: "virtual_account", amount: 110000, createdAt: "2026-11-22T02:00:00Z", dueAt: "2026-11-23T04:00:00Z" });
    // o4 — 어제 신청, 오늘 09:30 KST 결제
    await order("o4", { member: "m4", offering: "Y", seatKind: "any", stage: "paid", method: "easy_pay", amount: 50000, createdAt: "2026-11-22T10:00:00Z", paidAt: "2026-11-23T00:30:00Z" });
    // o5 — KST 자정 직후(00:10) 신청·00:20 결제 → 오늘. o6 — KST 어제 23:50 신청·23:55 결제 → 어제
    await order("o5", { member: "m1", offering: "Y", seatKind: "any", stage: "paid", amount: 40000, createdAt: "2026-11-22T15:10:00Z", paidAt: "2026-11-22T15:20:00Z" });
    await order("o6", { member: "m6", offering: "Y", seatKind: "any", stage: "paid", amount: 40000, createdAt: "2026-11-22T14:50:00Z", paidAt: "2026-11-22T14:55:00Z" });
    // 취소 — 기간 안 1건(o7, 오늘 12:00 KST) · 기간 밖 1건(o8, 10월)
    await order("o7", { member: "m5", offering: "X", seatKind: "male", stage: "cancelled", amount: 110000, createdAt: "2026-11-20T01:00:00Z", cancelledAt: "2026-11-23T03:00:00Z" });
    await order("o8", { member: "m7", offering: "Y", seatKind: "any", stage: "refunded", amount: 40000, createdAt: "2026-10-15T01:00:00Z", paidAt: "2026-10-15T01:05:00Z", cancelledAt: "2026-10-16T01:00:00Z" });
    // m7 은 11월에도 결제했지만 첫 결제가 10월이라 신규 회원이 아니다
    await order("o9", { member: "m7", offering: "X", seatKind: "female", stage: "paid", amount: 110000, createdAt: "2026-11-10T01:00:00Z", paidAt: "2026-11-10T01:05:00Z" });
    // 학원 B 의 오늘 결제 — 학원 A 타일에 섞이지 않는다
    await order("ob", { member: "mb", offering: "Z", seatKind: "any", stage: "paid", amount: 99000, createdAt: "2026-11-23T01:00:00Z", paidAt: "2026-11-23T01:01:00Z" });

    // 결석 예정 — o1(남) 오늘 회차에 살아 있는 결석 1건 · o4 내일 회차의 결석은 취소돼 세지 않는다
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id)
       VALUES (uuidv7(), $1, $2, $3, 'member', $3)`,
      [ids["o1Reservation"], ids["x1"], members["m1"]],
    );
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, cancelled_at)
       VALUES (uuidv7(), $1, $2, $3, 'member', $3, now())`,
      [ids["o4Reservation"], ids["y1"], members["m4"]],
    );
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 대표 대시보드 ------------------------------------------------------------------------

  test("오늘 신청·결제 — 신청 3 · 결제 3건 200,000원 · 입금 대기 1(기한 지난 o3 은 expired 로 정리)", async () => {
    const res = await ownerDashboard("ownerA", "A");
    expect(res.status).toBe(200);
    const body = res.body!;
    expect(body.date).toBe("2026-11-23");
    expect(body.todayOrders).toEqual({ available: true, availableFrom: null, applications: 3, paidCount: 3, paidAmount: 200000, awaitingDeposit: 1 });
    const [o3] = await q<{ status: string }>("SELECT status::text AS status FROM orders WHERE id = $1", [ids["o3"]]);
    expect(o3!.status).toBe("expired");
    // 픽스처 합계와 DB 집계가 같다 — 응답과 별도로 SQL 로 다시 센다(KST 하루 = 11-22 15:00Z ~ 11-23 15:00Z)
    const [direct] = await q<{ n: string; amount: string }>(
      `SELECT count(DISTINCT e.order_id)::text AS n, COALESCE(sum(o.total_amount), 0)::text AS amount
       FROM order_events e JOIN orders o ON o.id = e.order_id JOIN class_offerings co ON co.id = o.offering_id JOIN classes c ON c.id = co.class_id
       WHERE c.academy_id = $1 AND e.to_status = 'paid' AND e.from_status = 'pending'
         AND e.created_at >= '2026-11-22T15:00:00Z' AND e.created_at < '2026-11-23T15:00:00Z'`,
      [ids["A"]],
    );
    expect([Number(direct!.n), Number(direct!.amount)]).toEqual([body.todayOrders.paidCount, body.todayOrders.paidAmount]);
  });

  test("날짜를 바꾸면 그날 기준 — 11-22 은 신청 o3·o4·o6(3건)·결제 o6(1건 40,000원)", async () => {
    const body = (await ownerDashboard("ownerA", "A", "?date=2026-11-22")).body!;
    expect(body.todayOrders).toMatchObject({ applications: 3, paidCount: 1, paidAmount: 40000 });
  });

  test("마감 임박 — X 남(정원 10 · 남은 2)만. X 여는 잡힌 1 · 확정 5 · 현장 1 로 남은 3 이라 빠진다", async () => {
    const body = (await ownerDashboard("ownerA", "A")).body!;
    expect(body.nearlyFull).toEqual({
      available: true,
      availableFrom: null,
      items: [{ offeringId: ids["XOffering"], classId: ids["XClass"], classTitle: "쌈바(입문)", offeringLabel: "11/23~11/27 · 정규",
                seatKind: "male", capacity: 10, remaining: 2, firstSessionStartsAt: "2026-11-23T11:30:00Z" }],
    });
  });

  test("오늘·내일 수업 — 오늘 X(남 8−1+0=7 · 여 5−0+1=6) · 내일 Y(3, 취소된 결석은 안 셈). 휴강·승인 전·다른 학원 회차는 없다", async () => {
    const body = (await ownerDashboard("ownerA", "A")).body!;
    expect(body.sessions.available).toBe(true);
    expect(body.sessions.today).toEqual([
      { sessionId: ids["x1"], classId: ids["XClass"], title: "쌈바(입문)", startsAt: "2026-11-23T11:30:00Z", endsAt: "2026-11-23T12:30:00Z",
        instructor: { displayName: "이준호" }, roomName: null, absencePlanned: 1,
        seats: [ { seatKind: "male", capacity: 10, confirmed: 8, absencePlanned: 1, onsite: 0, present: 7 },
                 { seatKind: "female", capacity: 10, confirmed: 5, absencePlanned: 0, onsite: 1, present: 6 } ] },
    ]);
    expect(body.sessions.tomorrow).toEqual([
      { sessionId: ids["y1"], classId: ids["YClass"], title: "바차타(초급)", startsAt: "2026-11-24T11:00:00Z", endsAt: "2026-11-24T12:00:00Z",
        instructor: { displayName: "이준호" }, roomName: null, absencePlanned: 0,
        seats: [{ seatKind: "any", capacity: 20, confirmed: 3, absencePlanned: 0, onsite: 0, present: 3 }] },
    ]);
  });

  test("신규 회원 — 11월에 이 학원에서 처음 결제한 m1·m4·m6 = 3명(10월 첫 결제 m7 · 학원 B 회원은 빠진다), 10월은 m7 1명", async () => {
    expect((await ownerDashboard("ownerA", "A")).body!.newMembers).toEqual({ available: true, availableFrom: null, count: 3 });
    expect((await ownerDashboard("ownerA", "A", "?date=2026-10-31")).body!.newMembers.count).toBe(1);
  });

  test("학원마다 따로 — 학원 B 는 B 주문만(신청 1 · 결제 99,000원), A 대표가 B 를 부르면 403, 강사는 403", async () => {
    expect((await ownerDashboard("ownerB", "B")).body!.todayOrders).toMatchObject({ applications: 1, paidCount: 1, paidAmount: 99000, awaitingDeposit: 0 });
    expect((await ownerDashboard("ownerA", "B")).status).toBe(403);
    expect((await ownerDashboard("ins", "A")).status).toBe(403);
  });

  test("타일에는 숫자만 — 회원 닉네임·연락처가 응답 어디에도 없다", async () => {
    const text = JSON.stringify((await ownerDashboard("ownerA", "A")).json);
    expect(text).not.toContain("회원m");
    expect(text).not.toContain("010-1234-5678");
    expect(text).not.toContain("본명비공개");
  });

  // ---- 강사 집계 ---------------------------------------------------------------------------

  test("강사 집계(기본 이번 주) — X 신청 13 · 남은 남2 여3 · 취소 1, Y(대타 회차) 신청 3 · 남은 17. 요일별 월13 화3 수13", async () => {
    const res = await instructorDashboard("ins");
    expect(res.status).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const academy = { id: ids["A"], name: "라틴하우스 강남" };
    const waitlist = { available: false, availableFrom: "S4-4", count: null };
    expect(res.body).toEqual({
      from: "2026-11-23",
      to: "2026-11-29",
      items: [
        { offeringId: ids["XOffering"], classTitle: "쌈바(입문)", academy, weekdays: ["mon", "wed"], sessionCount: 2,
          applicants: 13, remaining: { male: 2, female: 3, any: null }, cancelled: 1, waitlist },
        { offeringId: ids["YOffering"], classTitle: "바차타(초급)", academy, weekdays: ["tue"], sessionCount: 1,
          applicants: 3, remaining: { male: null, female: null, any: 17 }, cancelled: 0, waitlist },
      ],
      totalsByWeekday: [ { weekday: "mon", applicants: 13 }, { weekday: "tue", applicants: 3 }, { weekday: "wed", applicants: 13 } ],
      interest: { available: false, availableFrom: "베타 뒤(D22 · FR-023)", count: null },
    });
    // 픽스처 합계와 같다 — 신청 인원은 자리 묶음 확정 합
    const [direct] = await q<{ n: string }>("SELECT sum(confirmed_count)::text AS n FROM seat_pools WHERE offering_id = $1", [ids["XOffering"]]);
    expect(Number(direct!.n)).toBe(res.body!.items[0]!.applicants);
  });

  test("자기 수업만 — other 는 Y 의 자기 회차(11-26 목)만, 기간을 바꾸면 그 기간 회차로(지난주 Y 11-20 금)", async () => {
    const other = (await instructorDashboard("other")).body!;
    expect(other.items.map((i) => [i.classTitle, i.sessionCount, i.weekdays])).toEqual([["바차타(초급)", 1, ["thu"]]]);
    const lastWeek = (await instructorDashboard("other", "?from=2026-11-16&to=2026-11-22")).body!;
    expect(lastWeek.items.map((i) => [i.classTitle, i.weekdays])).toEqual([["바차타(초급)", ["fri"]]]);
    expect((await instructorDashboard("ins", "?from=2026-11-16&to=2026-11-22")).body!.items).toEqual([]);
  });

  test("학원 고르기 — 소속 학원 A 는 같은 결과, 소속 아닌 학원 B 는 403", async () => {
    const all = (await instructorDashboard("ins")).body!;
    expect((await instructorDashboard("ins", `?academyId=${ids["A"]}`)).body!).toEqual(all);
    expect(await instructorDashboard("ins", `?academyId=${ids["B"]}`)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("권한·입력 — 대표 계정 403 · 기간 거꾸로·63일·한쪽만·모르는 쿼리 422", async () => {
    expect(await instructorDashboard("ownerA")).toMatchObject({ status: 403, code: "FORBIDDEN" });
    for (const search of ["?from=2026-11-29&to=2026-11-23", "?from=2026-11-01&to=2027-01-02", "?from=2026-11-23", "?week=1", "?academyId=x"]) {
      expect(await instructorDashboard("ins", search)).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    }
  });
});
