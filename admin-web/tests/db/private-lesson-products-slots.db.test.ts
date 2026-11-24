// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — 5개 경로를 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §10-1(목록 · 닫기) · §10-2(열 시간) · §10-3(수강권 목록)
//   경로: GET  /api/instructor/private-lesson-products · POST …/products/{classId}/close · POST …/products/{classId}/slots
//         DELETE /api/instructor/private-lesson-slots/{slotId} · GET /api/instructor/private-lesson-passes
//
// 확인하는 것(verify 의 세 문장 + 그 둘레):
//   ① 닫은 상품은 새 구매가 막힌다 — 닫기 200·감사 1·재전송 200, 구매 판정 409 PRODUCT_CLOSED, 새 시간도 409, 이미 산 수강권은 그대로
//   ② open 슬롯만 닫힌다 — open → 204 closed, held·booked 409 SLOT_NOT_OPEN(상태 그대로), 이미 닫힘 204
//   ③ 남의 상품·남의 시간은 404 — 닫기 · 시간 열기 · 시간 닫기
//   ④ 시간 열기 — 매주 반복 · 재전송 200 · 모양 422 · 수업/내 시간/홀 겹침 409(전체 거부, 한 줄도 안 생김)
//   ⑤ 목록 둘 — 상품 목록(학원 거르기 · 닫은 것 포함 · 소속 끝난 학원 숨김) · 수강권 목록(상태 거르기 · 다음 회차 · 결제 대기 이름)
//   ⑥ 대표 세션 403 · 로그인 없음 401 · 소속 아닌 학원 403 AFFILIATION_REQUIRED
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { HttpError } from "@/lib/server/http";
import { createPrivateLessonBookingRoutes, privateLessonPassListSchema } from "@/lib/server/services/private-lesson-bookings";
import {
  assertPrivateLessonProductOpen,
  createPrivateLessonProductRoutes,
  privateLessonProductListSchema,
  privateLessonProductSchema,
} from "@/lib/server/services/private-lesson-products";
import { createPrivateLessonSlotRoutes, openSlotsResponseSchema } from "@/lib/server/services/private-lesson-slots";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { insertMember } from "../fixtures/cancellation";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "private-lesson-products-slots-test-".repeat(3);
const BASE = "http://localhost:3000";
// 「지금」 = 2026-12-09 00:00Z(09:00 KST). 시간들은 이 시각에서 몇 시간 뒤로 정한다
const NOW = Temporal.Instant.from("2026-12-09T00:00:00Z");
// 분은 시간과 부호가 달라도 되게 분 하나로 더한다(Temporal 은 한 기간 안에 부호를 섞지 못한다)
const at = (hours: number, minutes = 0) => NOW.add({ minutes: hours * 60 + minutes }).toString();

describe.skipIf(!dbAvailable())("개인 레슨 상품·모집 시간·수강권 목록 API(계약 11 §10-1 · §10-2 · §10-3)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const roomIds: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const deps = () => ({ db: handle.db, getSession: (h: Headers) => auth.api.getSession({ headers: h }), clock: fixedClock(NOW) });
  const products = () => createPrivateLessonProductRoutes(deps());
  const slots = () => createPrivateLessonSlotRoutes(deps());
  const passes = () => createPrivateLessonBookingRoutes(deps());
  let phoneSeq = 0;

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

  /** 학원 + 지점 + 홀 하나(「{key}홀」) */
  async function makeAcademy(key: string, name: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], name],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    const branch = randomUUID();
    await q(
      "INSERT INTO academy_branches (id, academy_id, name, address, region_sido, region_gu, updated_at) VALUES ($1, $2, '본점', '서울 강남구 1', '서울', '강남구', now())",
      [branch, academyIds[key]],
    );
    roomIds[key] = randomUUID();
    await q("INSERT INTO rooms (id, branch_id, name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [roomIds[key], branch, `${key}홀`]);
  }

  async function affiliate(academy: string, instructor: string, status = "active") {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, released_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now(), now(), CASE WHEN $3 = 'released' THEN now() END, now())`,
      [academyIds[academy], staffIds[instructor], status],
    );
  }

  /** 개인 레슨 상품(S2-4.2 경로가 만드는 것과 같은 행) — 규칙 판본이 없으면 판본 1을 만든다 */
  async function makeProduct(key: string, academy: string, instructor: string, minutes = 50) {
    const rule = await q(
      `INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months)
       VALUES (uuidv7(), $1, $2, 1, 24, 3)
       ON CONFLICT (academy_id, instructor_account_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
      [academyIds[academy], staffIds[instructor]],
    );
    ids[key] = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, created_by_account_id, approved_at, updated_at)
       VALUES ($1, $2, 'private_lesson', $3, 'dance_sport', '강사', 'single', '{}'::json, 'published', $4, $4, now(), now())`,
      [ids[key], academyIds[academy], `개인 레슨 ${minutes}분 · 10회`, staffIds[instructor]],
    );
    await q(
      `INSERT INTO private_lesson_products (class_id, sub_genre, lesson_minutes, session_count, price_amount, rule_version_id, idempotency_key, updated_at)
       VALUES ($1, 'latin', $2, 10, 600000, $3, $4, now())`,
      [ids[key], minutes, rule.rows[0].id, `idem-${key}`],
    );
  }

  async function makePass(key: string, productKey: string, status = "active") {
    const { memberId } = await insertMember(handle.pool);
    await q("UPDATE members SET name = $2, phone = $3 WHERE id = $1", [memberId, `회원 ${key}`, `010-${String(2000 + phoneSeq++).padStart(4, "0")}-0000`]);
    ids[key] = randomUUID();
    const paid = status !== "pending_payment";
    await q(
      `INSERT INTO private_lesson_passes (id, product_class_id, member_id, rule_version_id, discipline, sessions_total, sessions_used,
                                          status, paid_at, valid_until, updated_at)
       SELECT $1, p.class_id, $2, p.rule_version_id, 'cha_cha_cha', 10, 2, $3,
              CASE WHEN $4 THEN $5::timestamptz END, CASE WHEN $4 THEN $6::timestamptz END, now()
       FROM private_lesson_products p WHERE p.class_id = $7`,
      [ids[key], memberId, status, paid, at(-24), at(24 * 90), ids[productKey]],
    );
  }

  /** 시간 한 칸을 바로 넣는다(상태를 골라 — held 면 held_until 도) */
  async function makeSlot(key: string, productKey: string, academy: string, instructor: string, startsInHours: number, status = "open", room: string | null = null) {
    ids[key] = randomUUID();
    await q(
      `INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, room_id, starts_at, ends_at, status, held_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'held' THEN $6::timestamptz END)`,
      [ids[key], ids[productKey], academyIds[academy], staffIds[instructor], room === null ? null : roomIds[room], at(startsInHours), at(startsInHours, 50), status],
    );
  }

  /** 수업 1개 + 판매 단위 + 회차 하나(그 학원 홀) — 겹침 확인용 */
  async function makeClassSession(academy: string, instructor: string, title: string, startsAt: string, endsAt: string) {
    const classId = randomUUID();
    const offeringId = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, class_kind, title, genre, instructor_name, seat_mode, registration_payload, status,
                            instructor_account_id, room_id, approved_at, updated_at)
       VALUES ($1, $2, 'regular', $3, 'dance_sport', '강사', 'gender_split', '{}'::json, 'published', $4, $5, now(), now())`,
      [classId, academyIds[academy], title, staffIds[instructor], roomIds[academy]],
    );
    await q(
      `INSERT INTO class_offerings (id, class_id, label, enrollment_unit, price_amount, first_session_starts_at, last_session_ends_at, status, updated_at)
       VALUES ($1, $2, '12월', 'term', 300000, $3, $4, 'open', now())`,
      [offeringId, classId, startsAt, endsAt],
    );
    await q(
      `INSERT INTO class_sessions (id, offering_id, seq, starts_at, ends_at, room_id, instructor_account_id, status)
       VALUES (uuidv7(), $1, 1, $2, $3, $4, $5, 'scheduled')`,
      [offeringId, startsAt, endsAt, roomIds[academy], staffIds[instructor]],
    );
  }

  function req(who: string | null, method: string, path: string, body?: unknown, key: string | null = `key-${randomUUID()}`): Request {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) headers["idempotency-key"] = key;
    return new Request(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const productCtx = (classId: string) => ({ params: Promise.resolve({ classId }) });
  const slotCtx = (slotId: string) => ({ params: Promise.resolve({ slotId }) });

  const listProducts = (who: string | null, query = "") =>
    products().list(req(who, "GET", `/api/instructor/private-lesson-products${query}`, undefined, null), undefined);
  const closeProduct = (who: string | null, classId: string) =>
    products().close(req(who, "POST", `/api/instructor/private-lesson-products/${classId}/close`, undefined, null), productCtx(classId));
  const openSlots = (who: string | null, classId: string, body: unknown, key?: string) =>
    slots().open(req(who, "POST", `/api/instructor/private-lesson-products/${classId}/slots`, body, key ?? `key-${randomUUID()}`), productCtx(classId));
  const closeSlot = (who: string | null, slotId: string) =>
    slots().remove(req(who, "DELETE", `/api/instructor/private-lesson-slots/${slotId}`, undefined, null), slotCtx(slotId));
  const listPasses = (who: string | null, query = "") =>
    passes().listPasses(req(who, "GET", `/api/instructor/private-lesson-passes${query}`, undefined, null), undefined);

  const slotCount = async (classKey: string) =>
    Number((await q("SELECT count(*) AS n FROM private_lesson_slots WHERE product_class_id = $1", [ids[classKey]])).rows[0].n);
  const slotStatus = async (key: string) => (await q("SELECT status FROM private_lesson_slots WHERE id = $1", [ids[key]])).rows[0].status;
  const one = (hours: number, minutes = 50) => ({ startsAt: at(hours), endsAt: at(hours, minutes) });

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
    await makeAcademy("C", "살사클럽 홍대"); // junho 의 두 번째 소속 학원
    await makeAcademy("B", "라틴스텝 서초"); // junho 가 소속되지 않은 학원
    await makeAcademy("R", "옛 학원"); // junho 의 소속이 끝난 학원
    await affiliate("A", "junho");
    await affiliate("C", "junho");
    await affiliate("A", "mina");
    await affiliate("R", "junho", "released");
    await makeProduct("pA", "A", "junho");
    await makeProduct("pA80", "A", "junho", 80);
    await makeProduct("pC", "C", "junho");
    await makeProduct("pR", "R", "junho");
    await makeProduct("pMina", "A", "mina");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 닫은 상품은 새 구매가 막힌다 — 닫기 200·감사 1·재전송 200, 구매 판정 409 PRODUCT_CLOSED, 새 시간 409, 이미 산 수강권 그대로", async () => {
    await makeProduct("pClose", "A", "junho");
    await makePass("bought", "pClose");

    // 닫기 전에는 구매 판정을 통과한다
    await handle.db.transaction(async (tx) => assertPrivateLessonProductOpen(tx, ids["pClose"]!));

    const res = await closeProduct("junho", ids["pClose"]!);
    expect(res.status).toBe(200);
    const body = privateLessonProductSchema.parse(await res.json());
    expect(body).toMatchObject({ classId: ids["pClose"], status: "closed", academyName: "라틴하우스 강남" });
    const audit = await q("SELECT action, before, after FROM audit_logs WHERE target_id = $1 AND action = 'private_lesson_product.closed'", [ids["pClose"]]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).toEqual({ status: "closed" });

    // 재전송 — 200 같은 본문, 감사는 늘지 않는다
    const again = await closeProduct("junho", ids["pClose"]!);
    expect(again.status).toBe(200);
    expect(privateLessonProductSchema.parse(await again.json()).status).toBe("closed");
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'private_lesson_product.closed'", [ids["pClose"]])).rows[0].n).toBe(1);

    // 새 구매 막기 — 구매 경로(M3)가 부를 판정이 409 PRODUCT_CLOSED
    const purchase = handle.db.transaction(async (tx) => assertPrivateLessonProductOpen(tx, ids["pClose"]!));
    await expect(purchase).rejects.toBeInstanceOf(HttpError);
    await expect(purchase).rejects.toMatchObject({ status: 409, code: "PRODUCT_CLOSED" });

    // 새 시간도 열 수 없다(같은 판정) — 한 줄도 생기지 않는다
    const slotRes = await openSlots("junho", ids["pClose"]!, { slots: [one(48)], repeatWeeks: 1 });
    expect(slotRes.status).toBe(409);
    expect(await slotRes.json()).toMatchObject({ code: "PRODUCT_CLOSED" });
    expect(await slotCount("pClose")).toBe(0);

    // 이미 산 수강권은 그대로(상태·남은 횟수)
    const pass = await q("SELECT status, sessions_used FROM private_lesson_passes WHERE id = $1", [ids["bought"]]);
    expect(pass.rows[0]).toEqual({ status: "active", sessions_used: 2 });
  });

  test("② open 슬롯만 닫힌다 — open → 204 closed, held·booked 409 SLOT_NOT_OPEN(상태 그대로), 이미 닫힘 204", async () => {
    await makeSlot("sOpen", "pA", "A", "junho", 200);
    await makeSlot("sHeld", "pA", "A", "junho", 202, "held");
    await makeSlot("sBooked", "pA", "A", "junho", 204, "booked");

    const ok = await closeSlot("junho", ids["sOpen"]!);
    expect(ok.status).toBe(204);
    expect(await slotStatus("sOpen")).toBe("closed");
    expect((await closeSlot("junho", ids["sOpen"]!)).status).toBe(204); // 재전송

    for (const key of ["sHeld", "sBooked"]) {
      const res = await closeSlot("junho", ids[key]!);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "SLOT_NOT_OPEN" });
    }
    expect(await slotStatus("sHeld")).toBe("held");
    expect(await slotStatus("sBooked")).toBe("booked");
  });

  test("③ 남의 상품·남의 시간은 404 — 닫기 · 시간 열기 · 시간 닫기, 모양이 틀린 id 도 404", async () => {
    await makeSlot("sMina", "pMina", "A", "mina", 300);

    const close = await closeProduct("junho", ids["pMina"]!);
    expect(close.status).toBe(404);
    expect((await q("SELECT status FROM private_lesson_products WHERE class_id = $1", [ids["pMina"]])).rows[0].status).toBe("open");

    const open = await openSlots("junho", ids["pMina"]!, { slots: [one(310)], repeatWeeks: 1 });
    expect(open.status).toBe(404);

    const del = await closeSlot("junho", ids["sMina"]!);
    expect(del.status).toBe(404);
    expect(await slotStatus("sMina")).toBe("open");

    expect((await closeProduct("junho", "not-a-uuid")).status).toBe(404);
    expect((await closeSlot("junho", randomUUID())).status).toBe(404);
    // 소속이 끝난 학원의 내 상품은 403(있다는 것은 내 것이라 알지만 지금은 다룰 수 없다)
    const released = await closeProduct("junho", ids["pR"]!);
    expect(released.status).toBe(403);
    expect(await released.json()).toMatchObject({ code: "AFFILIATION_REQUIRED" });
  });

  test("④ 시간 열기 — 매주 반복 · 재전송 200 · 모양 422 · 수업/내 시간/홀 겹침 409 전체 거부", async () => {
    // 매주 3번 — 같은 요일·시각, 묶음 id 하나. 홀을 고르면 그 홀이 붙는다
    const key = `key-${randomUUID()}`;
    const body = { slots: [one(500)], roomId: roomIds["A"], repeatWeeks: 3 };
    const res = await openSlots("junho", ids["pA"]!, body, key);
    expect(res.status).toBe(201);
    const created = openSlotsResponseSchema.parse(await res.json());
    expect(created.created.map((s) => s.startsAt)).toEqual([at(500), at(500 + 168), at(500 + 336)]);
    expect(created.repeatGroupId).not.toBeNull();
    const rows = await q("SELECT room_id, repeat_group_id, status, academy_id FROM private_lesson_slots WHERE repeat_group_id = $1", [created.repeatGroupId]);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((r) => r.room_id === roomIds["A"] && r.status === "open" && r.academy_id === academyIds["A"])).toBe(true);

    // 재전송 — 200 처음 것, 새 줄 없음
    const before = await slotCount("pA");
    const replay = await openSlots("junho", ids["pA"]!, body, key);
    expect(replay.status).toBe(200);
    expect(openSlotsResponseSchema.parse(await replay.json()).created.map((s) => s.slotId)).toEqual(created.created.map((s) => s.slotId));
    expect(await slotCount("pA")).toBe(before);

    // 반복 없음(1주) — 묶음 id 없음. 기본값은 8주
    const single = openSlotsResponseSchema.parse(await (await openSlots("junho", ids["pA"]!, { slots: [one(520)], repeatWeeks: 1 })).json());
    expect(single).toMatchObject({ repeatGroupId: null });
    expect(single.created).toHaveLength(1);
    const eight = openSlotsResponseSchema.parse(await (await openSlots("junho", ids["pA80"]!, { slots: [one(540, 80)] })).json());
    expect(eight.created).toHaveLength(8);

    // 모양 — 길이가 상품과 다름 · 10분 단위 아님 · 지난 시각 · 반복 27주 · 다른 학원 홀 → 422, 키 없음 400
    for (const bad of [
      { slots: [one(560, 60)], repeatWeeks: 1 },
      { slots: [{ startsAt: at(560, 5), endsAt: at(560, 55) }], repeatWeeks: 1 },
      { slots: [one(-2)], repeatWeeks: 1 },
      { slots: [one(560)], repeatWeeks: 27 },
      { slots: [one(560)], roomId: roomIds["B"], repeatWeeks: 1 },
      { slots: [one(560), one(560, 50)].map((s, i) => (i === 1 ? { startsAt: at(560, 30), endsAt: at(561, 20) } : s)), repeatWeeks: 1 },
    ]) {
      const r = await openSlots("junho", ids["pA"]!, bad);
      expect(r.status).toBe(422);
    }
    const noKey = await slots().open(req("junho", "POST", `/api/instructor/private-lesson-products/${ids["pA"]}/slots`, { slots: [one(560)] }, null), productCtx(ids["pA"]!));
    expect(noKey.status).toBe(400);

    // 겹침 ① — 다른 학원(B, 소속 아님이어도 몸은 하나) 수업이 3주차와 30분 겹친다 → 전체 거부, 이름은 「다른 학원 일정」
    await makeClassSession("C", "junho", "살사(입문)", at(600 + 336, 20), at(600 + 336, 110));
    const countBefore = await slotCount("pA");
    const clash = await openSlots("junho", ids["pA"]!, { slots: [one(600)], repeatWeeks: 3 });
    expect(clash.status).toBe(409);
    const clashBody = await clash.json();
    expect(clashBody).toMatchObject({ code: "SCHEDULE_CONFLICT", conflicts: [{ label: "다른 학원 일정", overlapMinutes: 30 }] });
    expect(await slotCount("pA")).toBe(countBefore); // 1·2주차도 안 생겼다(부분 성공 없음)

    // 겹침 ② — 다른 학원 상품(C)에 열어 둔 내 시간과 겹친다
    await makeSlot("sC", "pC", "C", "junho", 700);
    const mine = await openSlots("junho", ids["pA"]!, { slots: [{ startsAt: at(700, 40), endsAt: at(701, 30) }], repeatWeeks: 1 });
    expect(mine.status).toBe(409);
    expect(await mine.json()).toMatchObject({ code: "SCHEDULE_CONFLICT", conflicts: [{ label: "다른 학원 일정", overlapMinutes: 10 }] });
    // 같은 학원의 내 시간과 겹치면 「개인 레슨」
    const sameAcademy = await openSlots("junho", ids["pA80"]!, { slots: [{ startsAt: at(500, 30), endsAt: at(501, 50) }], repeatWeeks: 1 });
    expect(sameAcademy.status).toBe(409);
    expect(await sameAcademy.json()).toMatchObject({ code: "SCHEDULE_CONFLICT", conflicts: [{ label: "개인 레슨" }] });

    // 겹침 ③ — 홀: 다른 강사(mina)의 수업이 A홀을 쓴다 → ROOM_CONFLICT. 홀을 안 고르면 열린다
    await makeClassSession("A", "mina", "룸바(중급)", at(800), at(801, 30));
    const room = await openSlots("junho", ids["pA"]!, { slots: [one(800)], roomId: roomIds["A"], repeatWeeks: 1 });
    expect(room.status).toBe(409);
    const roomBody = await room.json();
    expect(roomBody).toMatchObject({ code: "ROOM_CONFLICT", conflicts: [{ label: "룸바(중급)", overlapMinutes: 50 }] });
    expect(roomBody.detail).toContain("A홀은");
    // 다른 강사의 개인 레슨 시간이 그 홀에 있으면 이름을 밝히지 않는다(「강사 일정」)
    await makeSlot("sMinaRoom", "pMina", "A", "mina", 820, "open", "A");
    const roomLesson = await openSlots("junho", ids["pA"]!, { slots: [one(820)], roomId: roomIds["A"], repeatWeeks: 1 });
    expect(roomLesson.status).toBe(409);
    expect(await roomLesson.json()).toMatchObject({ code: "ROOM_CONFLICT", conflicts: [{ label: "강사 일정" }] });
    expect((await openSlots("junho", ids["pA"]!, { slots: [one(800)], repeatWeeks: 1 })).status).toBe(201);
  });

  test("⑤ 목록 — 상품(학원 거르기·닫은 것 포함·소속 끝난 학원 숨김) · 수강권(상태 거르기·다음 회차·결제 대기 이름)", async () => {
    // 상품 목록: 학원을 안 고르면 지금 소속된 A·C 의 내 상품 전부. 소속 끝난 R 과 mina 의 상품은 없다
    const all = privateLessonProductListSchema.parse(await (await listProducts("junho")).json());
    const allIds = all.items.map((p) => p.classId);
    expect(allIds).toEqual(expect.arrayContaining([ids["pA"], ids["pA80"], ids["pC"], ids["pClose"]]));
    expect(allIds).not.toContain(ids["pR"]);
    expect(allIds).not.toContain(ids["pMina"]);
    // 판매 중이 위, 닫은 상품은 아래
    expect(all.items[all.items.length - 1]).toMatchObject({ classId: ids["pClose"], status: "closed" });

    const onlyC = privateLessonProductListSchema.parse(await (await listProducts("junho", `?academyId=${academyIds["C"]}`)).json());
    expect(onlyC.items.map((p) => p.classId)).toEqual([ids["pC"]]);
    expect(onlyC.items[0]).toMatchObject({ academyName: "살사클럽 홍대", payoutAcademy: "살사클럽 홍대", lessonMinutes: 50, rule: { version: 1 } });

    // 수강권 목록: 다음 회차가 있는 수강권 · 결제 대기 수강권 · mina 수강권
    await makePass("withNext", "pA");
    await makeSlot("sNext", "pA", "A", "junho", 900, "booked");
    await q("INSERT INTO private_lesson_bookings (id, pass_id, slot_id, status, booked_by, deducted, updated_at) VALUES (uuidv7(), $1, $2, 'booked', 'instructor', false, now())", [
      ids["withNext"],
      ids["sNext"],
    ]);
    await makePass("waiting", "pC", "pending_payment");
    await makePass("minaPass", "pMina");
    await makePass("oldPass", "pR");

    const passAll = privateLessonPassListSchema.parse(await (await listPasses("junho")).json());
    const passIds = passAll.items.map((p) => p.passId);
    expect(passIds).toEqual(expect.arrayContaining([ids["withNext"], ids["waiting"], ids["bought"]]));
    expect(passIds).not.toContain(ids["minaPass"]);
    expect(passIds).not.toContain(ids["oldPass"]);

    const next = passAll.items.find((p) => p.passId === ids["withNext"]);
    expect(next).toMatchObject({
      student: { displayName: "회원 withNext" },
      nameVisible: true,
      status: "active",
      sessionsTotal: 10,
      sessionsUsed: 2,
      remainingSessions: 8,
      nextBooking: { startsAt: at(900), state: "booked", sessionNo: 1 },
      awaitingPayment: null,
    });
    const waiting = passAll.items.find((p) => p.passId === ids["waiting"]);
    expect(waiting).toMatchObject({ student: { displayName: "회원 waiting" }, status: "pending_payment", awaitingPayment: { until: null }, paidAt: null });

    const active = privateLessonPassListSchema.parse(await (await listPasses("junho", "?status=active")).json());
    expect(active.items.every((p) => p.status === "active")).toBe(true);
    expect(active.items.map((p) => p.passId)).not.toContain(ids["waiting"]);
    const inC = privateLessonPassListSchema.parse(await (await listPasses("junho", `?academyId=${academyIds["C"]}`)).json());
    expect(inC.items.map((p) => p.passId)).toEqual([ids["waiting"]]);

    // 연락처는 목록에 없다. 「010-」 글자만 찾으면 무작위 UUID(예: …-8010-25c1…)에도 걸려 가끔 실패했다(M3-FIX.1) —
    // 위에서 넣은 전화번호 모양(010-NNNN-NNNN) 전체와 phone 칸 이름으로 찾는다
    expect(JSON.stringify(passAll)).not.toMatch(/(^|[^0-9a-f])010-\d{4}-\d{4}/);
    expect(JSON.stringify(passAll)).not.toMatch(/"phone/i);
    expect((await listPasses("junho", "?status=unknown")).status).toBe(422);
  });

  test("⑥ 대표 세션 403(5개 경로) · 로그인 없음 401 · 소속 아닌 학원 403 AFFILIATION_REQUIRED", async () => {
    const owner = [
      await listProducts("owner"),
      await closeProduct("owner", ids["pA"]!),
      await openSlots("owner", ids["pA"]!, { slots: [one(1000)], repeatWeeks: 1 }),
      await closeSlot("owner", ids["sBooked"]!),
      await listPasses("owner"),
    ];
    for (const res of owner) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
    }
    const anonymous = [
      await listProducts(null),
      await closeProduct(null, ids["pA"]!),
      await openSlots(null, ids["pA"]!, { slots: [one(1000)], repeatWeeks: 1 }),
      await closeSlot(null, ids["sBooked"]!),
      await listPasses(null),
    ];
    for (const res of anonymous) expect(res.status).toBe(401);

    for (const res of [await listProducts("junho", `?academyId=${academyIds["B"]}`), await listPasses("junho", `?academyId=${academyIds["B"]}`)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "AFFILIATION_REQUIRED" });
    }
  });
});
