// S2-4.2(개인 레슨 개설 API) — 개인 레슨 상품을 열면 고른 학원이 판매자로 잡히는지 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §10-1 · 수용 시나리오 13
//   verify 의 이름은 tests/db/s2-4-2.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 소속 학원 A 로 열면 classes.academy_id = A(판매자) · 개인 레슨 · 공개 · 승인 기록 없음 · 기본 규칙 판본 1 · 감사 1행(수용 ①)
//   ② 두 학원에 소속된 강사가 B 를 고르면 판매자는 B — 고른 학원이 그대로 판매자다
//   ③ 소속 아닌 학원 · 소속 신청 대기 중인 학원 · 없는 학원 → 403 AFFILIATION_REQUIRED, 아무 행도 생기지 않는다(수용 ①)
//   ④ 같은 Idempotency-Key 두 번 = 상품 1개(200 + 처음 것) · 다른 수업에 쓴 키는 409
//   ⑤ 검증: 레슨 60분 · 세부 장르 빠짐·짝 안 맞음 · 금액 −1 · 키 없음 · 세부 장르 없는 장르(아르헨티나 탱고)는 비워서 통과
//   ⑥ 이용 제한 학원은 409 ACADEMY_RESTRICTED · 규칙 판본이 이미 있으면 최신 판본을 붙인다
//   ⑦ 로그인 없음 401 · 강사 역할이 없는 계정 403
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createPrivateLessonProductRoutes, privateLessonProductSchema } from "@/lib/server/services/private-lesson-products";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "private-lesson-open-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("개인 레슨 개설 API(계약 11 §10-1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const routes = () =>
    createPrivateLessonProductRoutes({
      db: handle.db,
      getSession: (h: Headers) => auth.api.getSession({ headers: h }),
      clock: fixedClock(NOW),
    });

  async function makeStaff(key: string, roles: string[], genre?: string) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      `강사 ${key}`,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    if (genre !== undefined) {
      await q(
        "INSERT INTO instructor_profiles (staff_account_id, activity_genre, signup_completed_at, updated_at) VALUES ($1, $2, now(), now())",
        [id, genre],
      );
    }
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, status = "active") {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', $3, now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`, status],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
  }

  /** 소속 한 줄 — 개인 레슨은 위임 권한 없이 소속만 있으면 연다(FR-052c) */
  async function affiliate(academy: string, instructor: string, status = "active") {
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', now(), CASE WHEN $3 = 'pending' THEN NULL ELSE now() END, now())`,
      [academyIds[academy], staffIds[instructor], status],
    );
  }

  async function open(who: string | null, body: unknown, key: string | null = randomUUID()) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== null) headers["authorization"] = `Bearer ${tokens[who]}`;
    if (key !== null) headers["Idempotency-Key"] = key;
    return routes().create(
      new Request(`${BASE}/api/instructor/private-lesson-products`, { method: "POST", headers, body: JSON.stringify(body) }),
      undefined,
    );
  }

  const body = (academy: string, extra: Record<string, unknown> = {}) => ({
    academyId: academyIds[academy] ?? academy,
    subGenre: "latin",
    lessonMinutes: 50,
    sessionCount: 10,
    priceAmount: 600000,
    ...extra,
  });

  const countRows = async (table: string, where = "TRUE", params: unknown[] = []) =>
    Number(((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0] as { n: number }).n);

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeStaff("tango", ["instructor"], "argentine_tango");
    await makeAcademy("A");
    await makeAcademy("B");
    await makeAcademy("C"); // junho 가 소속되지 않은 학원
    await makeAcademy("P"); // 소속 신청만 해 둔(pending) 학원
    await makeAcademy("R", "restricted");
    await affiliate("A", "junho");
    await affiliate("B", "junho");
    await affiliate("P", "junho", "pending");
    await affiliate("R", "junho");
    await affiliate("A", "tango");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("① 소속 학원 A 로 열면 판매자 = A · 개인 레슨 · 공개 · 승인 기록 없음 · 기본 규칙 판본 1 · 감사 1행(수용 ①)", async () => {
    const res = await open("junho", body("A"));
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product).toMatchObject({
      academyId: academyIds["A"],
      academyName: "학원 A",
      payoutAcademy: "학원 A",
      genre: "dance_sport",
      subGenre: "latin",
      lessonMinutes: 50,
      sessionCount: 10,
      priceAmount: 600000,
      status: "open",
      rule: { version: 1, changeDeadlineHours: 24, validityMonths: 3 },
      refundNoticeVersionId: null,
    });

    // 판매자는 classes.academy_id 다 — 주문·정산이 이 칸을 읽는다(FR-135a)
    const cls = (
      await q(
        `SELECT academy_id, class_kind, status, genre, sub_genre, instructor_account_id, created_by_account_id,
                approved_at, approved_by_account_id
         FROM classes WHERE id = $1`,
        [product.classId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(cls["academy_id"]).toBe(academyIds["A"]);
    expect(cls["class_kind"]).toBe("private_lesson");
    expect(cls["status"]).toBe("published");
    expect(cls["sub_genre"]).toBe("latin");
    expect(cls["instructor_account_id"]).toBe(staffIds["junho"]);
    expect(cls["created_by_account_id"]).toBe(staffIds["junho"]);
    expect((cls["approved_at"] as Date).toISOString()).toBe("2026-11-21T03:00:00.000Z");
    expect(cls["approved_by_account_id"]).toBeNull();
    // 대표 승인이 없다 — 승인 기록·대표 알림이 생기지 않는다
    expect(await countRows("class_approvals", "class_id = $1", [product.classId])).toBe(0);
    expect(await countRows("notifications", "recipient_staff_account_id = $1", [staffIds["owner"]])).toBe(0);

    const prod = (await q("SELECT lesson_minutes, session_count, price_amount, status, rule_version_id FROM private_lesson_products WHERE class_id = $1", [product.classId])).rows[0] as Record<string, unknown>;
    expect(prod).toMatchObject({ lesson_minutes: 50, session_count: 10, price_amount: 600000, status: "open" });
    const rule = (await q("SELECT academy_id, instructor_account_id, version FROM private_lesson_rule_versions WHERE id = $1", [prod["rule_version_id"]])).rows[0] as Record<string, unknown>;
    expect(rule).toMatchObject({ academy_id: academyIds["A"], instructor_account_id: staffIds["junho"], version: 1 });

    const audits = (await q("SELECT action, academy_id, actor_staff_account_id, actor_role FROM audit_logs WHERE target_id = $1", [product.classId])).rows;
    expect(audits).toEqual([
      { action: "private_lesson_product.opened", academy_id: academyIds["A"], actor_staff_account_id: staffIds["junho"], actor_role: "instructor" },
    ]);
  });

  test("② 두 학원 소속 강사가 B 를 고르면 판매자는 B — 고른 학원이 그대로 판매자다", async () => {
    const res = await open("junho", body("B", { lessonMinutes: 80, sessionCount: 4, priceAmount: 0 }));
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product.academyId).toBe(academyIds["B"]);
    expect(product.payoutAcademy).toBe("학원 B");
    expect(product).toMatchObject({ lessonMinutes: 80, sessionCount: 4, priceAmount: 0 });
    const row = (await q("SELECT academy_id FROM classes WHERE id = $1", [product.classId])).rows[0] as { academy_id: string };
    expect(row.academy_id).toBe(academyIds["B"]);
    // 규칙 판본은 (학원, 강사)마다 따로다 — B 에도 기본 판본 1이 하나 생긴다
    expect(await countRows("private_lesson_rule_versions", "academy_id = $1 AND instructor_account_id = $2", [academyIds["B"], staffIds["junho"]])).toBe(1);
  });

  test("③ 소속 아닌 학원 · 신청 대기 학원 · 없는 학원 → 403 AFFILIATION_REQUIRED, 아무 행도 생기지 않는다(수용 ①)", async () => {
    const before = await countRows("classes");
    for (const academy of ["C", "P", randomUUID()]) {
      const res = await open("junho", body(academy));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "AFFILIATION_REQUIRED" });
    }
    expect(await countRows("classes")).toBe(before);
    expect(await countRows("classes", "academy_id = ANY($1::uuid[])", [[academyIds["C"], academyIds["P"]]])).toBe(0);
    expect(await countRows("private_lesson_rule_versions", "academy_id = ANY($1::uuid[])", [[academyIds["C"], academyIds["P"]]])).toBe(0);
  });

  test("④ 같은 Idempotency-Key 두 번 = 상품 1개(200 + 처음 것) · 다른 수업에 쓴 키는 409", async () => {
    const key = randomUUID();
    const first = await open("junho", body("A", { priceAmount: 300000 }), key);
    expect(first.status).toBe(201);
    const firstBody = privateLessonProductSchema.parse(await first.json());
    // 본문이 달라도(학원 B · 금액 다름) 처음 것을 준다
    const again = await open("junho", body("B", { priceAmount: 999 }), key);
    expect(again.status).toBe(200);
    expect(privateLessonProductSchema.parse(await again.json())).toEqual(firstBody);
    expect(await countRows("classes", "idempotency_key = $1", [key])).toBe(1);
    expect(await countRows("audit_logs", "target_id = $1", [firstBody.classId])).toBe(1);

    // 같은 사람이 이 키를 단체 수업 임시 저장에 이미 썼다 — 엉뚱한 수업을 돌려주지 않는다
    const usedKey = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, status, instructor_account_id,
                            created_by_account_id, idempotency_key, updated_at)
       VALUES (uuidv7(), $1, '임시 저장', '강사 junho', 'dance_sport', 'regular', 'gender_split', 'draft', $2, $2, $3, now())`,
      [academyIds["A"], staffIds["junho"], usedKey],
    );
    const reused = await open("junho", body("A"), usedKey);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("⑤ 검증: 60분 · 세부 장르 빠짐·짝 안 맞음 · 금액 −1 · 키 없음 / 세부 장르 없는 장르는 비워서 통과", async () => {
    const before = await countRows("classes");
    for (const extra of [{ lessonMinutes: 60 }, { subGenre: null }, { subGenre: "salsa" }, { priceAmount: -1 }, { sessionCount: 0 }]) {
      const res = await open("junho", body("A", extra));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    const noKey = await open("junho", body("A"), null);
    expect(noKey.status).toBe(400);
    expect(await countRows("classes")).toBe(before);

    // 아르헨티나 탱고는 세부 장르가 없다 — 비우면 통과, 값을 보내면 422
    const tangoWrong = await open("tango", body("A", { subGenre: "latin" }));
    expect(tangoWrong.status).toBe(422);
    const tango = await open("tango", body("A", { subGenre: null }));
    expect(tango.status).toBe(201);
    expect(privateLessonProductSchema.parse(await tango.json())).toMatchObject({ genre: "argentine_tango", subGenre: null, academyId: academyIds["A"] });
  });

  test("⑥ 이용 제한 학원은 409 ACADEMY_RESTRICTED · 규칙 판본이 이미 있으면 최신 판본을 붙인다", async () => {
    const restricted = await open("junho", body("R"));
    expect(restricted.status).toBe(409);
    expect(await restricted.json()).toMatchObject({ code: "ACADEMY_RESTRICTED" });
    expect(await countRows("classes", "academy_id = $1", [academyIds["R"]])).toBe(0);

    // 강사가 학원 A 규칙을 판본 2(48시간 · 6개월)로 저장해 둔 상태(S2-4.7 경로 대신 행을 직접 넣는다)
    await q(
      `INSERT INTO private_lesson_rule_versions (id, academy_id, instructor_account_id, version, change_deadline_hours, validity_months)
       VALUES (uuidv7(), $1, $2, 2, 48, 6)`,
      [academyIds["A"], staffIds["junho"]],
    );
    const res = await open("junho", body("A"));
    expect(res.status).toBe(201);
    expect(privateLessonProductSchema.parse(await res.json()).rule).toEqual({ version: 2, changeDeadlineHours: 48, validityMonths: 6 });
  });

  test("⑦ 로그인 없음 401 · 강사 역할이 없는 계정(대표만) 403", async () => {
    const anonymous = await open(null, body("A"));
    expect(anonymous.status).toBe(401);
    const owner = await open("owner", body("A"));
    expect(owner.status).toBe(403);
    expect(await owner.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});
