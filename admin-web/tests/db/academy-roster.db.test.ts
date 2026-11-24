// S3-5.2(명단 API) — 회원 목록·상세(`GET /api/academies/{academyId}/members` · `…/members/{memberId}`, 계약 18 §3)와
// 회차 명단(`GET /api/classes/{classId}/sessions/{sessionId}/roster`, 계약 18 §4)을 진짜 Better Auth 세션 + 진짜 PostgreSQL 로 확인한다.
//   이름: 로드맵 verify 의 tests/db/s3-5-2.db.test.ts 는 Task 번호 이름이라 기능 이름(academy-roster)으로 바꿨다(증거 EVIDENCE.md 에 기록).
//   verify: 결제 완료 2명 + 결제 대기 1명인 단체 회차 → members 에 결제 완료만(닉네임·가린 연락처), awaitingPayment 는 숫자,
//           대기자의 이름·연락처·id 가 응답 어디에도 없다(수용 ③) · skip 0
//   그리고: 위임 강사는 회원 목록 200 이고 문의 칸이 없다(수용 ①) · 결석 예정이 맨 위 · 수강 개월 수 · 기한 지난 대기는 세지 않는다 ·
//           권한(담당 강사 ○ · 다른 강사 403 · 소속이 끝난 담당 강사 403 · class_manage 만 있는 강사 403 · 다른 학원 대표 403) ·
//           이 학원 회원의 정의(환불한 회원 포함 · 결제 대기만 있는 회원 제외) · 검색 · 커서 · 상세의 가린 번호·결석 예정 이력
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { systemClock } from "@/lib/domain/time";
import { FakePaymentGateway, createFakePaymentGatewayStore } from "@/lib/server/fakes/fake-payment-gateway";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "@/lib/server/order-snapshot";
import {
  academyMemberDetailSchema,
  academyMemberListSchema,
  createAcademyMemberDetailRoute,
  createAcademyMembersRoute,
  decodeMemberCursor,
  encodeMemberCursor,
} from "@/lib/server/services/academy-members";
import { countEnrolledMonths, createSessionRosterRoute, sessionRosterSchema } from "@/lib/server/services/session-roster";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertCancellationChain } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "academy-roster-test-".repeat(3);
const BASE = "http://localhost:3000";
// 회차는 11/11(수) 20:30 KST — 김서연은 9월에 처음 결제해 「3개월째」다
const SESSION_STARTS = "2026-11-11T11:30:00Z";
const SESSION_ENDS = "2026-11-11T12:30:00Z";

// ---- 순수 계산(단위) ------------------------------------------------------------------------------

describe("수강 개월 수(I23 「3개월째」)", () => {
  const at = (iso: string) => Temporal.Instant.from(iso);
  test("9월 첫 결제 → 11월 회차는 3", () => {
    expect(countEnrolledMonths(at("2026-09-15T03:00:00Z"), at(SESSION_STARTS))).toBe(3);
  });
  test("같은 달이면 1, 해가 바뀌어도 이어서 센다", () => {
    expect(countEnrolledMonths(at("2026-11-01T00:00:00Z"), at(SESSION_STARTS))).toBe(1);
    expect(countEnrolledMonths(at("2025-12-10T00:00:00Z"), at("2026-02-01T00:00:00Z"))).toBe(3);
  });
  test("KST 달 기준 — UTC 10/31 16:00 은 한국 11/01 이라 11월이 첫 달", () => {
    expect(countEnrolledMonths(at("2026-10-31T16:00:00Z"), at(SESSION_STARTS))).toBe(1);
  });
});

describe("회원 목록 커서", () => {
  test("닉네임·id 가 그대로 돌아온다, 깨진 값은 null", () => {
    const id = randomUUID();
    expect(decodeMemberCursor(encodeMemberCursor({ nickname: "김서연", id }))).toEqual({ nickname: "김서연", id });
    expect(decodeMemberCursor("not-a-cursor")).toBeNull();
  });
});

// ---- 경로(통합) -----------------------------------------------------------------------------------

describe.skipIf(!dbAvailable())("명단 API — 회원 목록·상세 · 회차 명단(계약 18 §3·§4, S3-5.2)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let MEMBERS: ReturnType<typeof createAcademyMembersRoute>;
  let MEMBER: ReturnType<typeof createAcademyMemberDetailRoute>;
  let ROSTER: ReturnType<typeof createSessionRosterRoute>;
  const q = async <T>(text: string, params: unknown[] = []) => (await handle.pool.query(text, params)).rows as T[];
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const orderIds: Record<string, string> = {};
  const affiliationIds: Record<string, string> = {};

  let academyId = "";
  let classId = "";
  let offeringId = "";
  let sessionId = "";
  let otherAcademyId = "";
  let otherSessionId = "";
  const pools: Record<"male" | "female", string> = { male: "", female: "" };

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `ros_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, key]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
    return id;
  }

  async function affiliate(key: string, permissions: string[]) {
    const instructorId = await makeStaff(key, ["instructor"]);
    const [row] = await q<{ id: string }>(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now()) RETURNING id`,
      [academyId, instructorId],
    );
    affiliationIds[key] = row!.id;
    for (const permission of permissions) {
      await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
        row!.id,
        permission,
        staffIds["owner"],
      ]);
    }
  }

  async function addMember(key: string, m: { nickname: string; gender: "male" | "female"; birth: string; phone: string; genres?: string[] }) {
    const id = randomUUID();
    await q(
      `INSERT INTO members (id, auth_user_id, name, gender, birth_date, phone, identity_ci_hash, nickname, signup_notice_ack_at, updated_at)
       VALUES ($1, $2, '본명비공개', $3, $4, $5, $6, $7, now(), now())`,
      [id, `auth-${id}`, m.gender, m.birth, m.phone, `ci-${id}`, m.nickname],
    );
    for (const genre of m.genres ?? []) await q("INSERT INTO member_interest_genres (member_id, genre) VALUES ($1, $2)", [id, genre]);
    memberIds[key] = id;
    return id;
  }

  /**
   * 회원 한 명의 주문·예약·결제. 자리 숫자(held·confirmed)도 함께 맞춘다(실제 결제 경로가 하는 일과 같은 결과).
   *   paid = 확정 예약 + 결제 완료 · pending = 잡힌 예약 + 입금 대기 · refunded = 취소된 예약 + 환불 완료
   */
  async function addOrder(
    key: string,
    o: { stage: "paid" | "pending" | "refunded"; seat: "male" | "female"; paidAt?: string; dueInMinutes?: number },
  ) {
    const orderId = randomUUID();
    const memberId = memberIds[key]!;
    const [notice] = await q<{ id: string }>("SELECT id FROM refund_notice_versions WHERE academy_id = $1", [academyId]);
    const paidAt = o.stage === "pending" ? null : (o.paidAt ?? "2026-11-01T03:00:00Z");
    await q(
      `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, total_amount, price_breakdown, refund_notice_version_id,
                           intermediary_notice_version, member_terms_version, merchant_terms_version, platform_fee_rate_bp,
                           cancel_fee_platform_share_bp, idempotency_key, paid_at, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
       VALUES ($1, $2, $3, $4, 160000, 160000, '{}'::jsonb, $5, 'v1', 'v1', 'v1', 0, 5000, $6, $7::timestamptz, now(), ${orderSnapshotValuesSql("$3")})`,
      [orderId, memberId, offeringId, o.stage, notice!.id, `idem-${orderId}`, paidAt],
    );
    const reservationStatus = o.stage === "paid" ? "confirmed" : o.stage === "pending" ? "held" : "cancelled";
    await q(
      `INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, cancelled_at, cancel_reason, updated_at)
       VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'cancelled' THEN now() END,
               CASE WHEN $6 = 'cancelled' THEN 'member_request' END, now())`,
      [orderId, offeringId, pools[o.seat], o.seat, memberId, reservationStatus],
    );
    if (o.stage !== "refunded") {
      await q("UPDATE seat_pools SET held_count = held_count + $2, confirmed_count = confirmed_count + $3 WHERE id = $1", [
        pools[o.seat],
        o.stage === "pending" ? 1 : 0,
        o.stage === "paid" ? 1 : 0,
      ]);
    }
    await q(
      `INSERT INTO payments (id, order_id, method, amount, paid_at, gateway_payment_id, status, due_at, updated_at)
       VALUES ($1, $2, $3, 160000, $4::timestamptz, $5, $6, now() + make_interval(mins => $7), now())`,
      [
        randomUUID(),
        orderId,
        o.stage === "pending" ? "virtual_account" : "card",
        paidAt,
        `gw-${orderId}`,
        o.stage === "pending" ? "ready" : "paid",
        o.dueInMinutes ?? 24 * 60,
      ],
    );
    orderIds[key] = orderId;
    return orderId;
  }

  function headersFor(who: string | undefined, mode: "app" | "web"): Record<string, string> {
    if (who === undefined) return {};
    return mode === "web" ? { cookie: staffSessionCookie(tokens[who]!, SECRET) } : { authorization: `Bearer ${tokens[who]}` };
  }
  async function call(handler: (r: Request, c: never) => Promise<Response>, url: string, params: object, who: string | undefined, mode: "app" | "web") {
    const res = await handler(new Request(`${BASE}${url}`, { headers: headersFor(who, mode) }), { params: Promise.resolve(params) } as never);
    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    return { status: res.status, text, json, code: json["code"] as string | undefined, cache: res.headers.get("cache-control") };
  }
  const getMembers = (who: string | undefined, id: string, search = "", mode: "app" | "web" = "web") =>
    call(MEMBERS as never, `/api/academies/${id}/members${search}`, { academyId: id }, who, mode);
  const getMember = (who: string, id: string, memberId: string, mode: "app" | "web" = "web") =>
    call(MEMBER as never, `/api/academies/${id}/members/${memberId}`, { academyId: id, memberId }, who, mode);
  const getRoster = (who: string | undefined, cls: string, ses: string, mode: "app" | "web" = "web") =>
    call(ROSTER as never, `/api/classes/${cls}/sessions/${ses}/roster`, { classId: cls, sessionId: ses }, who, mode);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    const deps = {
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: systemClock,
      paymentGateway: new FakePaymentGateway({ store: createFakePaymentGatewayStore() }),
    };
    MEMBERS = createAcademyMembersRoute(deps);
    MEMBER = createAcademyMemberDetailRoute(deps);
    ROSTER = createSessionRosterRoute(deps);

    await makeStaff("owner", ["owner"]);
    await makeStaff("ownerB", ["owner"]);

    // 학원 A — 쌈바(입문) 정규, 남·여 정원 각 10, A홀, 담당 강사 junho
    academyId = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '라틴하우스 강남', '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyId, staffIds["owner"]]);
    await q("INSERT INTO refund_notice_versions (id, academy_id, version, body) VALUES (uuidv7(), $1, 1, '공지')", [academyId]);
    const branchId = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '주소 1', '서울', '강남구', now())",
      [branchId, academyId],
    );
    const roomId = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, 'A홀', 'active', now())", [roomId, branchId]);

    await affiliate("junho", []);
    await affiliate("delegate", ["roster_manage"]);
    await affiliate("classOnly", ["class_manage"]);
    await affiliate("otherInstructor", []);

    classId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, approved_at, instructor_account_id, room_id, updated_at)
       VALUES ($1, $2, '쌈바(입문)', '이준호', 'dance_sport', 'regular', 'gender_split', 'published', now(), $3, $4, now())`,
      [classId, academyId, staffIds["junho"], roomId],
    );
    offeringId = randomUUID();
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '11월 기간', 'term', 160000, $3, $4, 'open', now())`,
      [offeringId, classId, SESSION_STARTS, SESSION_ENDS],
    );
    sessionId = randomUUID();
    await q("INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at) VALUES ($1, $2, 1, $3, $4)", [
      sessionId,
      offeringId,
      SESSION_STARTS,
      SESSION_ENDS,
    ]);
    for (const kind of ["male", "female"] as const) {
      pools[kind] = randomUUID();
      await q("INSERT INTO seat_pools (id, offering_id, seat_kind, capacity, updated_at) VALUES ($1, $2, $3, 10, now())", [pools[kind], offeringId, kind]);
    }

    // 결제 완료 — 여 2(김서연·최하은) · 남 1(정우진). 김서연은 9월에 처음 결제(수강 개월 수 3)
    await addMember("seoyeon", { nickname: "김서연", gender: "female", birth: "1998-03-01", phone: "010-2222-5678", genres: ["salsa_bachata", "argentine_tango"] });
    await addMember("haeun", { nickname: "최하은", gender: "female", birth: "1990-06-01", phone: "01012341234" });
    await addMember("woojin", { nickname: "정우진", gender: "male", birth: "1985-01-15", phone: "01077776666" });
    await addOrder("seoyeon", { stage: "paid", seat: "female", paidAt: "2026-09-15T03:00:00Z" });
    await addOrder("haeun", { stage: "paid", seat: "female" });
    await addOrder("woojin", { stage: "paid", seat: "male" });
    // 결제 대기 — 남 1(박민준대기, 기한 남음) · 남 1(정만료, 기한 지남 → 읽기 전에 만료돼 세지 않는다)
    await addMember("waiting", { nickname: "박민준대기", gender: "male", birth: "1995-02-02", phone: "01099998888" });
    await addMember("expiring", { nickname: "정만료", gender: "male", birth: "1995-02-02", phone: "01011110000" });
    await addOrder("waiting", { stage: "pending", seat: "male" });
    await addOrder("expiring", { stage: "pending", seat: "male", dueInMinutes: -5 });
    // 환불을 마친 회원 — 이 학원 회원 목록에는 남지만(이력) 회차 명단에는 없다
    await addMember("refunded", { nickname: "이환불", gender: "male", birth: "1980-07-07", phone: "01033332222" });
    await addOrder("refunded", { stage: "refunded", seat: "male" });

    // 최하은은 이 회차 결석 예정을 알렸다(회원이 켠 행)
    await q(
      `INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, marked_at)
       SELECT uuidv7(), r.id, $1, r.member_id, 'member', r.member_id, '2026-11-10T12:05:00Z' FROM reservations r WHERE r.order_id = $2`,
      [sessionId, orderIds["haeun"]],
    );

    // 학원 B — 다른 대표의 주문 사슬(회원 한 명). 학원 A 목록에 나오면 안 된다
    const chainB = await insertCancellationChain(handle.pool, { amount: 50000, stage: "paid", method: "card" });
    otherAcademyId = chainB.academyId;
    otherSessionId = chainB.sessionId;
    memberIds["otherAcademy"] = chainB.memberId;
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [otherAcademyId, staffIds["ownerB"]]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  // ---- 회차 명단(§4) -----------------------------------------------------------------------------

  test("① 결제 완료만 이름이 나오고 결제 대기는 숫자뿐 — 대기자의 닉네임·연락처·id 가 응답 어디에도 없다(수용 ③)", async () => {
    const res = await getRoster("owner", classId, sessionId);
    expect(res.status, res.text).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = sessionRosterSchema.parse(res.json);

    expect(body.members.map((m) => m.nickname).sort()).toEqual(["김서연", "정우진", "최하은"].sort());
    // 결제 대기는 남 1명 — 기한 지난 정만료는 읽기 전에 만료돼 세지 않는다
    expect(body.awaitingPayment).toEqual({ male: 1, female: 0 });
    for (const secret of ["박민준대기", "01099998888", "9888", memberIds["waiting"]!, "정만료", memberIds["expiring"]!, "이환불"]) {
      expect(res.text).not.toContain(secret);
    }
    // 본명·전체 번호·생년월일도 없다
    for (const secret of ["본명비공개", "010-2222-5678", "2222", "01012341234", "1998-03-01"]) expect(res.text).not.toContain(secret);
    const [expired] = await q<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderIds["expiring"]]);
    expect(expired?.status).toBe("expired");
  });

  test("② 줄 모양 — 가린 번호·연령대·수강 개월 수, 결석 예정이 맨 위 그다음 닉네임 순", async () => {
    const body = sessionRosterSchema.parse((await getRoster("owner", classId, sessionId)).json);
    expect(body.members.map((m) => m.nickname)).toEqual(["최하은", "김서연", "정우진"]);
    expect(body.members[0]).toMatchObject({
      nickname: "최하은",
      gender: "female",
      ageBand: "30s",
      phoneMasked: "010-****-1234",
      absence: { markedByKind: "member", markedAt: "2026-11-10T12:05:00Z" },
    });
    expect(body.members[1]).toMatchObject({ nickname: "김서연", ageBand: "20s", phoneMasked: "010-****-5678", monthsEnrolled: 3, absence: null });
    expect(body.members[2]).toMatchObject({ nickname: "정우진", ageBand: "40s", phoneMasked: "010-****-6666", monthsEnrolled: 1 });
    expect(body).toMatchObject({
      classId,
      sessionId,
      academyId,
      title: "쌈바(입문)",
      classKind: "regular",
      seatMode: "gender_split",
      startsAt: SESSION_STARTS,
      endsAt: SESSION_ENDS,
      roomName: "A홀",
      sessionStatus: "scheduled",
    });
  });

  test("③ 자리 표 — 확정·결석 예정·현장(아직 0)·오늘 인원·남은 자리·현장 상한", async () => {
    const body = sessionRosterSchema.parse((await getRoster("owner", classId, sessionId)).json);
    expect(body.seats).toEqual([
      // 남: 확정 1 · 잡힌 자리 1(박민준대기) → 남은 8
      { seatKind: "male", capacity: 10, appConfirmed: 1, absencePlanned: 0, onsite: 0, present: 1, remaining: 8, maxOnsite: 8 },
      // 여: 확정 2 · 결석 예정 1 → 오늘 인원 1
      { seatKind: "female", capacity: 10, appConfirmed: 2, absencePlanned: 1, onsite: 0, present: 1, remaining: 8, maxOnsite: 8 },
    ]);
  });

  test("④ 권한 — 위임 강사·담당 강사(웹·앱) 200 · 다른 강사·class_manage 만 있는 강사·다른 학원 대표 403 · 로그인 없음 401", async () => {
    expect((await getRoster("delegate", classId, sessionId)).status).toBe(200);
    expect((await getRoster("junho", classId, sessionId, "app")).status).toBe(200);
    expect((await getRoster("junho", classId, sessionId, "web")).status).toBe(200);
    expect(await getRoster("otherInstructor", classId, sessionId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getRoster("classOnly", classId, sessionId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getRoster("ownerB", classId, sessionId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect((await getRoster(undefined, classId, sessionId)).status).toBe(401);
  });

  test("⑤ 수업과 회차가 짝이 아니거나 없으면 404", async () => {
    expect(await getRoster("owner", classId, otherSessionId)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await getRoster("owner", classId, randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await getRoster("owner", "not-a-uuid", sessionId)).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  // ---- 회원 목록·상세(§3) ------------------------------------------------------------------------

  test("⑥ 이 학원 회원 = 결제 이력이 있는 회원(환불한 회원 포함, 결제 대기만 있는 회원·다른 학원 회원 제외)", async () => {
    const res = await getMembers("owner", academyId);
    expect(res.status, res.text).toBe(200);
    expect(res.cache).toBe("private, no-store");
    const body = academyMemberListSchema.parse(res.json);
    expect(body.total).toBe(4);
    // 닉네임 바이트 순(김 < 이 < 정 < 최)
    expect(body.items.map((m) => m.nickname)).toEqual(["김서연", "이환불", "정우진", "최하은"]);
    expect(res.text).not.toContain("박민준대기");
    expect(res.text).not.toContain(memberIds["otherAcademy"]!);
    // 목록에는 연락처 칸 자체가 없다
    expect(res.text).not.toContain("phone");
    expect(body.items[0]).toEqual({
      memberId: memberIds["seoyeon"],
      nickname: "김서연",
      gender: "female",
      ageBand: "20s",
      interestGenres: ["argentine_tango", "salsa_bachata"],
      completedTerms: 1,
      openInquiries: null,
    });
    // 환불을 마친 주문은 과정 수에 세지 않는다
    expect(body.items[1]).toMatchObject({ nickname: "이환불", completedTerms: 0 });
  });

  test("⑦ 위임 강사는 회원 목록·상세 200 이고 문의 칸이 키째 없다(수용 ①) · 위임 없는 강사·class_manage 만 있는 강사는 403", async () => {
    const list = await getMembers("delegate", academyId);
    expect(list.status, list.text).toBe(200);
    const body = academyMemberListSchema.parse(list.json);
    expect(body.items.every((m) => !("openInquiries" in m))).toBe(true);
    const detail = await getMember("delegate", academyId, memberIds["seoyeon"]!);
    expect(detail.status).toBe(200);
    expect("inquiries" in academyMemberDetailSchema.parse(detail.json)).toBe(false);

    expect(await getMembers("junho", academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getMembers("classOnly", academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getMembers("ownerB", academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  test("⑧ sessionId 를 주면 그 회차 상태가 붙는다 — 결제·환불·결석 예정 · 다른 학원 회차는 404", async () => {
    const body = academyMemberListSchema.parse((await getMembers("owner", academyId, `?sessionId=${sessionId}`)).json);
    const byNick = Object.fromEntries(body.items.map((m) => [m.nickname, m.thisSession]));
    expect(byNick).toEqual({
      김서연: { state: "paid", absencePlanned: false },
      최하은: { state: "paid", absencePlanned: true },
      정우진: { state: "paid", absencePlanned: false },
      이환불: { state: "refunded", absencePlanned: false },
    });
    expect(await getMembers("owner", academyId, `?sessionId=${otherSessionId}`)).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  test("⑨ 검색(닉네임 · 숫자 4자리는 연락처 뒷자리) · 커서로 겹침 없는 다음 쪽 · 모르는 쿼리 422", async () => {
    const nick = academyMemberListSchema.parse((await getMembers("owner", academyId, `?q=${encodeURIComponent("하은")}`)).json);
    expect(nick.items.map((m) => m.nickname)).toEqual(["최하은"]);
    expect(nick.total).toBe(1);
    const last4 = academyMemberListSchema.parse((await getMembers("owner", academyId, "?q=5678")).json);
    expect(last4.items.map((m) => m.nickname)).toEqual(["김서연"]);

    const first = academyMemberListSchema.parse((await getMembers("owner", academyId, "?limit=3")).json);
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = academyMemberListSchema.parse((await getMembers("owner", academyId, `?limit=3&cursor=${first.nextCursor}`)).json);
    expect(second.items.map((m) => m.nickname)).toEqual(["최하은"]);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(4);

    expect(await getMembers("owner", academyId, "?limit=101")).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await getMembers("owner", academyId, "?cursor=broken")).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
    expect(await getMembers("owner", academyId, "?unknown=1")).toMatchObject({ status: 422, code: "VALIDATION_FAILED" });
  });

  test("⑩ 상세 — 가린 번호·수강 이력·결석 예정 이력, 전체 번호·본명은 없다", async () => {
    const res = await getMember("owner", academyId, memberIds["haeun"]!);
    expect(res.status, res.text).toBe(200);
    const body = academyMemberDetailSchema.parse(res.json);
    expect(body).toMatchObject({ nickname: "최하은", ageBand: "30s", phoneMasked: "010-****-1234", inquiries: null });
    expect(body.enrollments).toEqual([
      { offeringId, classTitle: "쌈바(입문)", label: "11월 기간", paidAt: "2026-11-01T03:00:00Z", status: "paid", sessionCount: 1 },
    ]);
    expect(body.absenceHistory).toEqual([
      { sessionId, startsAt: SESSION_STARTS, markedByKind: "member", markedAt: "2026-11-10T12:05:00Z", disputeStatus: "none" },
    ]);
    expect(res.text).not.toContain("01012341234");
    expect(res.text).not.toContain("본명비공개");
    expect(res.text).not.toContain("1990-06-01");
  });

  test("⑪ 상세 — 결제 대기만 있는 회원·다른 학원 회원 403 · 없는 회원 404 · 다른 학원 대표 403", async () => {
    expect(await getMember("owner", academyId, memberIds["waiting"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getMember("owner", academyId, memberIds["otherAcademy"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getMember("owner", academyId, randomUUID())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await getMember("ownerB", academyId, memberIds["seoyeon"]!)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  // 마지막에 둔다 — 소속·위임을 바꿔 다른 시험의 상태를 바꾸기 때문이다
  test("⑫ 소속이 끝난 담당 강사·위임을 끈 강사는 다음 요청부터 403", async () => {
    await q("UPDATE instructor_affiliations SET status = 'released', released_at = now() WHERE id = $1", [affiliationIds["junho"]]);
    expect(await getRoster("junho", classId, sessionId, "app")).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await q("DELETE FROM instructor_delegations WHERE affiliation_id = $1", [affiliationIds["delegate"]]);
    expect(await getRoster("delegate", classId, sessionId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await getMembers("delegate", academyId)).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});
