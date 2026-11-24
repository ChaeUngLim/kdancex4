// S2-4.4(개인 레슨 공지 자동 입력) — 개인 레슨 상품을 열면 학원의 개인 레슨 환불 양식 판본 id 가 붙는지 진짜 세션 + PostgreSQL 로 확인한다.
//   계약: _workspace/03_contracts/11-instructor.md §10-1 「학원의 private_lesson 환불 양식이 있으면 그 판본 id 도 함께 붙이고 없으면 null」 · 열린 점 ⑨
//   방식: 정규 수업 공지(S2-2.5)와 같다 — 최신 판본 id 만 적고 본문은 복사하지 않는다. 강사는 이 값을 정할 수 없다.
//   verify 의 이름은 tests/db/s2-4-4.db.test.ts(Task 번호)였는데, 기능 이름으로 바꿨다(증거 EVIDENCE.md 에 기록).
//
// 확인하는 것:
//   ① 개인 레슨 양식 v1·v2 와 정규 공지가 있는 학원 → 상품에 개인 레슨 v2(최신) id. 정규 공지 id 는 붙지 않는다
//   ② 대표가 v3 을 올려도 이미 연 상품은 v2 그대로, 새로 연 상품은 v3 · 같은 키로 다시 오면 처음 상품(v2)
//   ③ 개인 레슨 양식이 없는 학원(정규 공지만 있음) → 201 · refundNoticeVersionId null(막지 않는다, 열린 점 ⑨)
//   ④ 다른 학원의 양식은 붙지 않는다 — 판매자 학원의 양식만 본다
//   ⑤ 강사가 본문에 refundNoticeVersionId 를 넣으면 422, 아무 행도 생기지 않는다
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createPrivateLessonProductRoutes, privateLessonProductSchema } from "@/lib/server/services/private-lesson-products";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님)
const SECRET = "private-lesson-notice-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T05:00:00Z");

describe.skipIf(!dbAvailable())("개인 레슨 공지 자동 입력(계약 11 §10-1 · S2-4.4)", () => {
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

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '강남구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, 'active', 'application', now(), now(), now())`,
      [academyIds[key], staffIds["junho"]],
    );
  }

  /** 대표가 공지 판본을 올린 것과 같은 행(판본은 쌓기만 한다) */
  async function publishNotice(academy: string, kind: "regular" | "private_lesson", version: number): Promise<string> {
    const id = randomUUID();
    await q(
      "INSERT INTO refund_notice_versions (id, academy_id, notice_kind, version, body, content, created_by_account_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, academyIds[academy], kind, version, `${kind} v${version} 본문`, JSON.stringify({ processingBusinessDays: 5 }), staffIds["owner"]],
    );
    return id;
  }

  async function open(academy: string, extra: Record<string, unknown> = {}, key: string = randomUUID()) {
    const body = { academyId: academyIds[academy], subGenre: "latin", lessonMinutes: 50, sessionCount: 10, priceAmount: 600000, ...extra };
    return routes().create(
      new Request(`${BASE}/api/instructor/private-lesson-products`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokens["junho"]}`, "Idempotency-Key": key },
        body: JSON.stringify(body),
      }),
      undefined,
    );
  }

  /** 상품 행에 실제로 적힌 공지 판본 id — 응답만 믿지 않고 DB 를 본다 */
  const storedNoticeId = async (classId: string) =>
    ((await q("SELECT refund_notice_version_id FROM private_lesson_products WHERE class_id = $1", [classId])).rows[0] as {
      refund_notice_version_id: string | null;
    }).refund_notice_version_id;

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    await makeStaff("junho", ["instructor"], "dance_sport");
    await makeAcademy("A"); // 개인 레슨 양식 v1·v2 + 정규 공지
    await makeAcademy("B"); // 정규 공지만 있음
    await makeAcademy("C"); // 양식 없음 — 다른 학원(A)의 양식이 새어 들어오지 않는지 본다
    ids["A-pl-1"] = await publishNotice("A", "private_lesson", 1);
    ids["A-pl-2"] = await publishNotice("A", "private_lesson", 2);
    ids["A-regular-5"] = await publishNotice("A", "regular", 5);
    ids["B-regular-1"] = await publishNotice("B", "regular", 1);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  let firstClassId = "";
  const firstKey = randomUUID();

  test("① 개인 레슨 양식 v1·v2 와 정규 공지가 있는 학원 → 상품에 개인 레슨 v2(최신) id, 정규 공지는 붙지 않는다", async () => {
    const res = await open("A", {}, firstKey);
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product.refundNoticeVersionId).toBe(ids["A-pl-2"]);
    expect(product.refundNoticeVersionId).not.toBe(ids["A-regular-5"]);
    expect(await storedNoticeId(product.classId)).toBe(ids["A-pl-2"]);
    // 정규 수업 칸(classes.refund_notice_version_id)은 개인 레슨 행에서 비어 있다(data-model §8-6 「개인 레슨 행은 NULL」)
    const cls = (await q("SELECT refund_notice_version_id FROM classes WHERE id = $1", [product.classId])).rows[0] as Record<string, unknown>;
    expect(cls["refund_notice_version_id"]).toBeNull();
    // 감사 기록에도 어느 판본을 붙였는지 남는다
    const audit = (await q("SELECT after FROM audit_logs WHERE target_id = $1", [product.classId])).rows[0] as { after: Record<string, unknown> };
    expect(audit.after["refundNoticeVersionId"]).toBe(ids["A-pl-2"]);
    firstClassId = product.classId;
  });

  test("② 대표가 v3 을 올려도 이미 연 상품은 v2 그대로, 새 상품은 v3 · 같은 키 재요청은 처음 상품(v2)", async () => {
    ids["A-pl-3"] = await publishNotice("A", "private_lesson", 3);
    expect(await storedNoticeId(firstClassId)).toBe(ids["A-pl-2"]);

    const replay = await open("A", {}, firstKey);
    expect(replay.status).toBe(200);
    const replayed = privateLessonProductSchema.parse(await replay.json());
    expect(replayed.classId).toBe(firstClassId);
    expect(replayed.refundNoticeVersionId).toBe(ids["A-pl-2"]);

    const res = await open("A", { lessonMinutes: 80 });
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product.refundNoticeVersionId).toBe(ids["A-pl-3"]);
    expect(await storedNoticeId(product.classId)).toBe(ids["A-pl-3"]);
  });

  test("③ 개인 레슨 양식이 없는 학원(정규 공지만) → 201 · refundNoticeVersionId null, 정규 공지로 대신하지 않는다", async () => {
    const res = await open("B");
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product.refundNoticeVersionId).toBeNull();
    expect(await storedNoticeId(product.classId)).toBeNull();
  });

  test("④ 다른 학원(A)의 양식은 붙지 않는다 — 판매자 학원 C 의 양식만 본다", async () => {
    const res = await open("C");
    expect(res.status).toBe(201);
    const product = privateLessonProductSchema.parse(await res.json());
    expect(product.academyId).toBe(academyIds["C"]);
    expect(product.refundNoticeVersionId).toBeNull();
  });

  test("⑤ 강사가 본문에 refundNoticeVersionId 를 넣으면 422 VALIDATION_FAILED, 아무 행도 생기지 않는다", async () => {
    const before = Number(((await q("SELECT count(*)::int AS n FROM private_lesson_products")).rows[0] as { n: number }).n);
    const res = await open("B", { refundNoticeVersionId: ids["A-pl-3"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    const after = Number(((await q("SELECT count(*)::int AS n FROM private_lesson_products")).rows[0] as { n: number }).n);
    expect(after).toBe(before);
  });
});
