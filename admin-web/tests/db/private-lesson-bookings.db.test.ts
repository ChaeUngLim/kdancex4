// S2-4.7(개인 레슨 규칙·수강생·회차 API) — 규칙 6개 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §10-1(규칙) · §10-3(수강생 · 회차) · 수용 시나리오 12
//   verify 의 이름은 tests/db/s2-4-7.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것(verify 의 다섯 문장 + 그 둘레):
//   ① 규칙 새 판본은 이후 결제부터 — 저장 전에 산 수강권은 옛 판본(24시간), 저장 뒤 산 수강권은 새 판본(48시간)으로 판정된다
//   ② 회차 잡기 — 남은 횟수 · 재전송 200 · 시간 booked · 회원 알림 · 이미 잡힌 시간 409 · 기한 뒤 시간 422 · 결제 전 수강권 409 · 다 잡음 409
//   ③ 시간 바꾸기 — 같은 회차가 새 시간으로, 옛 시간은 다시 open, 차감 없음
//   ④ 강사 사정 취소는 회차를 돌려준다(차감 없음 · 남은 횟수 그대로 · 시간 closed · 사유가 회원 알림에) · 재전송 200
//   ⑤ 25시간 전 회원 요청 = 차감 없음(시간 open) · 23시간 전 = 1회 차감(시간 closed)
//   ⑥ 대표 세션 403(6개 경로 전부) · 로그인 없음 401 · 다른 강사 404 · 소속 아님 403 AFFILIATION_REQUIRED · 검증 422
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  bookSlotResponseSchema,
  cancelBookingResponseSchema,
  createPrivateLessonBookingRoutes,
  privateLessonPassDetailSchema,
  rescheduleResponseSchema,
} from "@/lib/server/services/private-lesson-bookings";
import {
  createPrivateLessonRuleRoutes,
  privateLessonRuleSchema,
  privateLessonRuleViewSchema,
} from "@/lib/server/services/private-lesson-rules";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "private-lesson-bookings-test-".repeat(3);
const BASE = "http://localhost:3000";
// 「지금」 = 2026-12-09 00:00Z(09:00 KST). 시간들은 이 시각에서 몇 시간 뒤로 정한다
const NOW = Temporal.Instant.from("2026-12-09T00:00:00Z");
const at = (hours: number) => NOW.add({ hours }).toString();

describe.skipIf(!dbAvailable())("개인 레슨 규칙·수강생·회차 API(계약 11 §10-1 · §10-3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const rules = () => createPrivateLessonRuleRoutes(deps());
  const bookings = () => createPrivateLessonBookingRoutes(deps());
  let keySeq = 0;

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [id, user.id, `직원 ${key}`]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, name: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
  }

  async function affiliate(academy: string, instructor: string) {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now())`,
      [academyIds[academy], staffIds[instructor]],
    );
  }

  /** 개인 레슨 상품(학원 A · junho) — 규칙 판본 1(24시간 · 3개월)을 붙여 연다(S2-4.2 경로가 하는 일과 같은 행) */
  async function makeProduct(): Promise<string> {
    ids["rule1"] = randomUUID();
    await q(
      "INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months) VALUES ($1, $2, $3, 1, 24, 3)",
      [ids["rule1"], academyIds["A"], staffIds["junho"]],
    );
    const classId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, created_by_account_id, approved_at, updated_at)
       VALUES ($1, $2, 'private_lesson', '개인 레슨 50분 · 10회', 'dance_sport', '강사', 'single', '{}'::json, 'published', $3, $3, now(), now())`,
      [classId, academyIds["A"], staffIds["junho"]],
    );
    await q(
      `INSERT INTO private_lesson_products (class_id, sub_genre, lesson_minutes, session_count, price_amount, rule_version_id, idempotency_key, updated_at)
       VALUES ($1, 'latin', 50, 10, 600000, $2, $3, now())`,
      [classId, ids["rule1"], `idem-${classId}`],
    );
    return classId;
  }

  /** 수강권 한 장 — 「결제」할 때의 상품 규칙 판본을 복사한다(M3 구매 경로가 할 일을 흉내 낸다) */
  async function makePass(key: string, options: { status?: string; used?: number; total?: number; validUntil?: string; ruleVersionId?: string } = {}) {
    const { memberId } = await insertMember(handle.pool);
    await q("UPDATE members SET name = $2, phone = $3 WHERE id = $1", [memberId, `회원 ${key}`, `010-${String(1000 + keySeq++).padStart(4, "0")}-0000`]);
    ids[`${key}_member`] = memberId;
    ids[key] = randomUUID();
    const status = options.status ?? "active";
    const paid = status !== "pending_payment";
    await q(
      `INSERT INTO private_lesson_passes (id, product_class_id, member_id, rule_version_id, discipline, sessions_total, sessions_used,
                                          status, paid_at, valid_until, updated_at)
       SELECT $1, p.class_id, $2, COALESCE($10::uuid, p.rule_version_id), 'cha_cha_cha', $3, $4, $5,
              CASE WHEN $6 THEN $7::timestamptz END, CASE WHEN $6 THEN $8::timestamptz END, now()
       FROM private_lesson_products p WHERE p.class_id = $9`,
      [ids[key], memberId, options.total ?? 10, options.used ?? 0, status, paid, at(-24), options.validUntil ?? at(24 * 90), ids["product"], options.ruleVersionId ?? null],
    );
  }

  async function makeSlot(key: string, startsInHours: number, status = "open") {
    ids[key] = randomUUID();
    await q(
      `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ids[key], ids["product"], academyIds["A"], staffIds["junho"], at(startsInHours), NOW.add({ hours: startsInHours, minutes: 50 }).toString(), status],
    );
  }

  function req(who: string | null, method: string, path: string, body?: unknown, key = true): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (key) headers["idempotency-key"] = `key-${randomUUID()}`;
    return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const passCtx = (passId: string) => ({ params: Promise.resolve({ passId }) });
  const bookingCtx = (bookingId: string) => ({ params: Promise.resolve({ bookingId }) });

  const getPass = (who: string | null, passId: string) =>
    bookings().getPass(req(who, "GET", `/api/instructor/private-lesson-passes/${passId}`), passCtx(passId));
  const book = (who: string | null, passId: string, slotId: string, request?: Request) =>
    bookings().book(request ?? req(who, "POST", `/api/instructor/private-lesson-passes/${passId}/bookings`, { slotId }), passCtx(passId));
  const reschedule = (who: string | null, bookingId: string, slotId: string) =>
    bookings().reschedule(req(who, "POST", `/api/instructor/private-lesson-bookings/${bookingId}/reschedule`, { slotId }, false), bookingCtx(bookingId));
  const cancel = (who: string | null, bookingId: string, body: unknown) =>
    bookings().cancel(req(who, "POST", `/api/instructor/private-lesson-bookings/${bookingId}/cancel`, body, false), bookingCtx(bookingId));
  const saveRule = (who: string | null, body: unknown, request?: Request) =>
    rules().save(request ?? req(who, "POST", "/api/instructor/private-lesson-rules", body), undefined);
  const getRule = (who: string | null, academy: string) =>
    rules().get(req(who, "GET", `/api/instructor/private-lesson-rules?academyId=${academyIds[academy]}`), undefined);

  /** 잡아서 bookingId 를 돌려준다 */
  async function bookOk(passKey: string, slotKey: string): Promise<string> {
    const res = await book("junho", ids[passKey]!, ids[slotKey]!);
    expect(res.status).toBe(201);
    return bookSlotResponseSchema.parse(await res.json()).bookingId;
  }

  const slotStatus = async (slotKey: string) => (await q("SELECT status FROM private_lesson_slots WHERE id = $1", [ids[slotKey]])).rows[0].status;
  const passUsed = async (passKey: string) => (await q("SELECT sessions_used FROM private_lesson_passes WHERE id = $1", [ids[passKey]])).rows[0].sessions_used;
  const notifications = async (bookingId: string, kind: string) =>
    (await q("SELECT recipient_member_id, kind, payload, dedupe_key FROM notifications WHERE kind = $1 AND payload->>'bookingId' = $2 ORDER BY created_at", [kind, bookingId])).rows;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"]);
    await makeStaff("mina", ["instructor"]);
    await makeAcademy("A", "라틴하우스 강남");
    await makeAcademy("B", "라틴스텝 서초"); // junho 가 소속되지 않은 학원
    await affiliate("A", "junho");
    await affiliate("A", "mina");
    ids["product"] = await makeProduct();
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 규칙 새 판본은 이후 결제부터 — 저장 전에 산 수강권은 24시간, 저장 뒤 산 수강권은 48시간으로 판정된다", async () => {
    // 저장 전 결제한 수강권(판본 1 = 24시간)
    await makePass("before");

    // 지금 규칙 읽기 — 판본 1(상품을 열 때 생긴 기본값 판본)
    const g1 = privateLessonRuleViewSchema.parse(await (await getRule("junho", "A")).json());
    expect(g1).toMatchObject({ version: 1, changeDeadlineHours: 24, validityMonths: 3, isDefault: false, current: { version: 1 } });
    expect(g1.memberNotice[0]).toBe("레슨 시작 24시간 전까지 바꾸거나 취소할 수 있어요");

    // 같은 값 저장 → 200, 새 행 없음
    const same = await saveRule("junho", { academyId: academyIds["A"], changeDeadlineHours: 24, validityMonths: 3 });
    expect(same.status).toBe(200);
    expect(privateLessonRuleSchema.parse(await same.json()).version).toBe(1);

    // 48시간 · 6개월로 저장 → 201 판본 2, 감사 1행, 판매 중 상품이 판본 2 를 가리킨다
    const saved = await saveRule("junho", { academyId: academyIds["A"], changeDeadlineHours: 48, validityMonths: 6 });
    expect(saved.status).toBe(201);
    const v2 = privateLessonRuleSchema.parse(await saved.json());
    expect(v2).toMatchObject({ version: 2, changeDeadlineHours: 48, validityMonths: 6 });
    expect(v2.memberNotice).toEqual([
      "레슨 시작 48시간 전까지 바꾸거나 취소할 수 있어요",
      "그 뒤에 취소하거나 오지 않으면 1회가 차감돼요",
      "수강권은 결제일부터 6개월 안에 써요",
      "남은 회차 환불은 학원에 문의해요",
    ]);
    const rows = (await q("SELECT version FROM private_lesson_rule_versions WHERE academy_id = $1 ORDER BY version", [academyIds["A"]])).rows;
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'private_lesson_rule.published'")).rows[0].n).toBe(1);
    expect((await q("SELECT r.version FROM private_lesson_products p JOIN private_lesson_rule_versions r ON r.id = p.rule_version_id WHERE p.class_id = $1", [ids["product"]])).rows[0].version).toBe(2);

    // 이미 산 수강권은 판본 1 그대로 · 저장 뒤 산 수강권은 판본 2
    await makePass("after");
    const before = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["before"]!)).json());
    const after = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["after"]!)).json());
    expect(before.rule).toEqual({ version: 1, changeDeadlineHours: 24, validityMonths: 3 });
    expect(after.rule).toEqual({ version: 2, changeDeadlineHours: 48, validityMonths: 6 });

    // 30시간 뒤 회차를 회원 요청으로 취소: 옛 수강권(24시간)은 차감 없음, 새 수강권(48시간)은 1회 차감
    await makeSlot("r_before", 30);
    await makeSlot("r_after", 31);
    const bBefore = await bookOk("before", "r_before");
    const bAfter = await bookOk("after", "r_after");
    const c1 = cancelBookingResponseSchema.parse(await (await cancel("junho", bBefore, { by: "member" })).json());
    const c2 = cancelBookingResponseSchema.parse(await (await cancel("junho", bAfter, { by: "member" })).json());
    expect(c1).toMatchObject({ status: "cancelled_member_free", deducted: false, sessionsUsed: 0, remainingSessions: 10 });
    expect(c2).toMatchObject({ status: "cancelled_member_late", deducted: true, sessionsUsed: 1, remainingSessions: 9 });

    // 소속 없는 학원의 규칙 → 403 AFFILIATION_REQUIRED, 허용 밖 값 → 422
    const noAff = await saveRule("junho", { academyId: academyIds["B"], changeDeadlineHours: 24, validityMonths: 3 });
    expect(noAff.status).toBe(403);
    expect((await noAff.json()).code).toBe("AFFILIATION_REQUIRED");
    expect((await getRule("junho", "B")).status).toBe(403);
    expect((await saveRule("junho", { academyId: academyIds["A"], changeDeadlineHours: 36, validityMonths: 3 })).status).toBe(422);
    expect((await saveRule("junho", { academyId: academyIds["A"], changeDeadlineHours: 24, validityMonths: 4 })).status).toBe(422);
    // 키 없음 → 400
    expect((await saveRule("junho", null, req("junho", "POST", "/api/instructor/private-lesson-rules", { academyId: academyIds["A"], changeDeadlineHours: 24, validityMonths: 3 }, false))).status).toBe(400);
  });

  test("① 규칙을 한 번도 저장하지 않은 학원은 기본값(24시간 · 3개월, isDefault)을 보여 준다", async () => {
    await affiliate("B", "mina");
    const body = privateLessonRuleViewSchema.parse(await (await getRule("mina", "B")).json());
    expect(body).toMatchObject({ version: null, effectiveFrom: null, changeDeadlineHours: 24, validityMonths: 3, current: null, isDefault: true });
    // 처음 저장은 기본값과 같은 값이어도 판본 1 을 만든다(201)
    const first = await saveRule("mina", { academyId: academyIds["B"], changeDeadlineHours: 24, validityMonths: 3 });
    expect(first.status).toBe(201);
    expect(privateLessonRuleSchema.parse(await first.json()).version).toBe(1);
  });

  test("② 회차 잡기 — 남은 횟수 · 재전송 200 · 회원 알림 · 이미 잡힌 시간 409 · 기한 뒤 422 · 결제 전 409 · 다 잡음 409", async () => {
    await makePass("p2");
    await makeSlot("s2a", 72);
    await makeSlot("s2b", 96);

    // 상세: 다음 회차 후보에 두 시간이 있고, 다음 회차는 아직 없다
    const detail0 = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["p2"]!)).json());
    expect(detail0.openSlots.map((s) => s.slotId)).toEqual(expect.arrayContaining([ids["s2a"], ids["s2b"]]));
    expect(detail0).toMatchObject({ student: { displayName: "회원 p2" }, nameVisible: true, remainingSessions: 10, nextBooking: null, awaitingPayment: null });
    expect(detail0.payment).toMatchObject({ amount: 600000, method: null });

    const request = req("junho", "POST", `/api/instructor/private-lesson-passes/${ids["p2"]}/bookings`, { slotId: ids["s2a"] });
    const res = await book("junho", ids["p2"]!, ids["s2a"]!, request.clone());
    expect(res.status).toBe(201);
    const first = bookSlotResponseSchema.parse(await res.json());
    expect(first).toMatchObject({ slotId: ids["s2a"], status: "booked", remainingToBook: 9 });
    expect(await slotStatus("s2a")).toBe("booked");

    // 같은 요청 재전송 → 200 같은 회차, 행·알림 그대로
    const again = await book("junho", ids["p2"]!, ids["s2a"]!, request.clone());
    expect(again.status).toBe(200);
    expect(bookSlotResponseSchema.parse(await again.json()).bookingId).toBe(first.bookingId);
    expect((await q("SELECT count(*)::int AS n FROM private_lesson_bookings WHERE pass_id = $1", [ids["p2"]])).rows[0].n).toBe(1);
    const notes = await notifications(first.bookingId, "private_lesson_booked");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipient_member_id: ids["p2_member"], payload: { change: "booked", slotId: ids["s2a"] } });

    // 상세에 다음 회차(1회차째)
    const detail1 = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["p2"]!)).json());
    expect(detail1.nextBooking).toMatchObject({ bookingId: first.bookingId, sessionNo: 1, state: "booked" });
    expect(detail1.openSlots.map((s) => s.slotId)).not.toContain(ids["s2a"]);

    // 다른 수강권이 같은 시간 → 409 SLOT_NOT_OPEN
    await makePass("p2other");
    const taken = await book("junho", ids["p2other"]!, ids["s2a"]!);
    expect(taken.status).toBe(409);
    expect((await taken.json()).code).toBe("SLOT_NOT_OPEN");

    // 사용 기한(48시간 뒤) 이후 시간 → 422 SLOT_AFTER_PASS_EXPIRY
    await makePass("p2short", { validUntil: at(48) });
    const late = await book("junho", ids["p2short"]!, ids["s2b"]!);
    expect(late.status).toBe(422);
    expect((await late.json()).code).toBe("SLOT_AFTER_PASS_EXPIRY");

    // 결제 대기 수강권 → 409 PASS_NOT_ACTIVE (상세에는 결제 대기 표시 + 이름이 보인다)
    await makePass("p2pending", { status: "pending_payment" });
    const pending = await book("junho", ids["p2pending"]!, ids["s2b"]!);
    expect(pending.status).toBe(409);
    expect((await pending.json()).code).toBe("PASS_NOT_ACTIVE");
    const pendingDetail = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["p2pending"]!)).json());
    expect(pendingDetail).toMatchObject({ status: "pending_payment", awaitingPayment: { until: null }, student: { displayName: "회원 p2pending" }, payment: null });

    // 2회권 중 1회 썼고 1회 잡힘 → 더 잡을 회차 없음 409 PASS_NO_REMAINING
    await makePass("p2full", { total: 2, used: 1 });
    await makeSlot("s2c", 120);
    await bookOk("p2full", "s2c");
    const full = await book("junho", ids["p2full"]!, ids["s2b"]!);
    expect(full.status).toBe(409);
    expect((await full.json()).code).toBe("PASS_NO_REMAINING");

    // 다른 상품 시간이 아닌 id · 키 없음
    expect((await book("junho", ids["p2"]!, randomUUID())).status).toBe(422);
    expect((await book("junho", ids["p2"]!, ids["s2b"]!, req("junho", "POST", "/x", { slotId: ids["s2b"] }, false))).status).toBe(400);
  });

  test("③ 시간 바꾸기 — 같은 회차가 새 시간으로 옮겨 가고 옛 시간은 다시 open, 차감 없음", async () => {
    await makePass("p3");
    await makeSlot("s3old", 50);
    await makeSlot("s3new", 74);
    const bookingId = await bookOk("p3", "s3old");

    const res = await reschedule("junho", bookingId, ids["s3new"]!);
    expect(res.status).toBe(200);
    expect(rescheduleResponseSchema.parse(await res.json())).toMatchObject({ bookingId, slotId: ids["s3new"], status: "booked" });
    expect(await slotStatus("s3old")).toBe("open");
    expect(await slotStatus("s3new")).toBe("booked");
    expect(await passUsed("p3")).toBe(0);
    const notes = await notifications(bookingId, "private_lesson_booked");
    expect(notes.map((n) => n.payload.change)).toEqual(["booked", "rescheduled"]);

    // 재전송(같은 새 시간) → 200, 알림 늘지 않음
    expect((await reschedule("junho", bookingId, ids["s3new"]!)).status).toBe(200);
    expect(await notifications(bookingId, "private_lesson_booked")).toHaveLength(2);
    // 이미 잡힌 시간으로는 못 옮긴다
    await makePass("p3b");
    await makeSlot("s3busy", 98);
    await bookOk("p3b", "s3busy");
    const busy = await reschedule("junho", bookingId, ids["s3busy"]!);
    expect(busy.status).toBe(409);
    expect((await busy.json()).code).toBe("SLOT_NOT_OPEN");
  });

  test("④ 강사 사정 취소는 회차를 돌려준다 — 차감 없음 · 남은 횟수 그대로 · 시간 closed · 사유가 회원 알림에", async () => {
    await makePass("p4", { used: 3 });
    await makeSlot("s4", 5); // 5시간 뒤 — 회원 요청이었다면 늦은 취소지만 강사 사정이라 돌려준다
    const bookingId = await bookOk("p4", "s4");

    const res = await cancel("junho", bookingId, { by: "instructor", reason: "대회 심사 일정이 생겼어요" });
    expect(res.status).toBe(200);
    const body = cancelBookingResponseSchema.parse(await res.json());
    expect(body).toEqual({ bookingId, status: "cancelled_instructor", deducted: false, sessionsUsed: 3, remainingSessions: 7 });
    expect(await passUsed("p4")).toBe(3);
    expect(await slotStatus("s4")).toBe("closed");
    const row = (await q("SELECT status, deducted, cancel_reason, cancelled_at FROM private_lesson_bookings WHERE id = $1", [bookingId])).rows[0];
    expect(row).toMatchObject({ status: "cancelled_instructor", deducted: false, cancel_reason: "대회 심사 일정이 생겼어요" });
    expect(row.cancelled_at).not.toBeNull();
    const notes = await notifications(bookingId, "private_lesson_cancelled");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipient_member_id: ids["p4_member"], payload: { by: "instructor", reason: "대회 심사 일정이 생겼어요", deducted: false } });
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'private_lesson_booking.cancelled' AND target_id = $1", [bookingId])).rows[0].n).toBe(1);

    // 재전송 → 200 같은 본문, 다시 차감·알림하지 않는다
    const again = await cancel("junho", bookingId, { by: "member" });
    expect(again.status).toBe(200);
    expect(cancelBookingResponseSchema.parse(await again.json())).toEqual(body);
    expect(await notifications(bookingId, "private_lesson_cancelled")).toHaveLength(1);
    // 사유 없는 강사 사정 취소 → 422
    await makeSlot("s4b", 100);
    const b2 = await bookOk("p4", "s4b");
    expect((await cancel("junho", b2, { by: "instructor" })).status).toBe(422);
    expect((await cancel("junho", b2, { by: "someone" })).status).toBe(422);
    // 끝난 회차 → 409 BOOKING_STATE_CONFLICT
    await q("UPDATE private_lesson_bookings SET status = 'done', deducted = true WHERE id = $1", [b2]);
    const done = await cancel("junho", b2, { by: "member" });
    expect(done.status).toBe(409);
    expect((await done.json()).code).toBe("BOOKING_STATE_CONFLICT");
  });

  test("⑤ 25시간 전 회원 요청 취소는 차감 없음(시간 open), 23시간 전은 1회 차감(시간 closed) — 수용 ②", async () => {
    // ① 에서 상품 규칙이 48시간(판본 2)으로 바뀌었으므로, 24시간 판본 1 로 결제했던 수강권을 쓴다
    await makePass("p5", { used: 2, ruleVersionId: ids["rule1"]! });
    await makeSlot("s25", 25);
    await makeSlot("s23", 23);
    const b25 = await bookOk("p5", "s25");
    const b23 = await bookOk("p5", "s23");

    const free = cancelBookingResponseSchema.parse(await (await cancel("junho", b25, { by: "member" })).json());
    expect(free).toEqual({ bookingId: b25, status: "cancelled_member_free", deducted: false, sessionsUsed: 2, remainingSessions: 8 });
    expect(await slotStatus("s25")).toBe("open");

    const late = cancelBookingResponseSchema.parse(await (await cancel("junho", b23, { by: "member" })).json());
    expect(late).toEqual({ bookingId: b23, status: "cancelled_member_late", deducted: true, sessionsUsed: 3, remainingSessions: 7 });
    expect(await slotStatus("s23")).toBe("closed");
    expect(await passUsed("p5")).toBe(3);

    // 상세의 회차 목록에 두 취소가 차감 여부와 함께 남는다
    const detail = privateLessonPassDetailSchema.parse(await (await getPass("junho", ids["p5"]!)).json());
    expect(detail.bookings.map((b) => [b.bookingId, b.status, b.deducted])).toEqual([
      [b23, "cancelled_member_late", true],
      [b25, "cancelled_member_free", false],
    ]);
    // 차감 없이 열린 시간은 다시 다음 회차 후보가 된다
    expect(detail.openSlots.map((s) => s.slotId)).toContain(ids["s25"]);
  });

  test("⑥ 대표 세션은 6개 경로 모두 403 · 로그인 없음 401 · 다른 강사 404", async () => {
    await makePass("p6");
    await makeSlot("s6a", 80);
    await makeSlot("s6b", 104);
    const bookingId = await bookOk("p6", "s6a");
    const ruleBody = { academyId: academyIds["A"], changeDeadlineHours: 12, validityMonths: 2 };

    // 대표(그 학원의 대표여도) — 강사 역할이 없어 403 FORBIDDEN
    const ownerResults = [
      await getRule("owner", "A"),
      await saveRule("owner", ruleBody),
      await getPass("owner", ids["p6"]!),
      await book("owner", ids["p6"]!, ids["s6b"]!),
      await reschedule("owner", bookingId, ids["s6b"]!),
      await cancel("owner", bookingId, { by: "member" }),
    ];
    for (const res of ownerResults) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    }
    // 로그인 없음 401
    expect((await getPass(null, ids["p6"]!)).status).toBe(401);
    expect((await cancel(null, bookingId, { by: "member" })).status).toBe(401);
    // 같은 학원 다른 강사 mina — 남의 수강권·회차는 없는 것과 같다(404)
    expect((await getPass("mina", ids["p6"]!)).status).toBe(404);
    expect((await book("mina", ids["p6"]!, ids["s6b"]!)).status).toBe(404);
    expect((await reschedule("mina", bookingId, ids["s6b"]!)).status).toBe(404);
    expect((await cancel("mina", bookingId, { by: "member" })).status).toBe(404);
    expect((await getPass("junho", "not-a-uuid")).status).toBe(404);

    // 아무것도 바뀌지 않았다
    expect(await slotStatus("s6a")).toBe("booked");
    expect(await slotStatus("s6b")).toBe("open");
    expect((await q("SELECT max(version)::int AS v FROM private_lesson_rule_versions WHERE academy_id = $1", [academyIds["A"]])).rows[0].v).toBe(2);
  });
});
