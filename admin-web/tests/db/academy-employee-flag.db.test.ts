// S1-2.11(학원 직원 켜고 끄기 API) — 계약 08 §4 의 `PUT …/employment` 를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-11.db.test.ts 였는데, 기능 이름(academy-employee-flag)으로 바꿨다.
//   핵심(verify): 켜면 비율 행이 닫힌다 — 기본 비율 판본은 이력으로 남고 비율 경로는 409, 켜진 수업별 예외는 NULL 판본으로 닫힌다.
//   나머지: 끄면 새 기본 비율 판본(끈 뒤 결제분부터) · 옛 예외가 되살아나지 않는다 · 감사 affiliation.employee_flag_changed
//           · 같은 값 0행 · 켜기에 비율 422 · 끄기에 비율 없음 422 SHARE_RATE_REQUIRED · 대기 409 · 위임 강사 403 · 다른 학원 403/404.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import {
  createUpdateAffiliationEmploymentRoute,
  updatedEmploymentSchema,
} from "@/lib/server/services/academy-affiliation-employment";
import { createGetShareRatesRoute, findEffectiveShareRateBp, shareRatesSchema } from "@/lib/server/services/academy-share-rates";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "employee-flag-test-".repeat(3);
const BASE = "http://localhost:3000";
const APPROVED_AT = "2026-11-10T00:00:00Z";
const OVERRIDE_AT = "2026-11-15T00:00:00Z";

describe.skipIf(!dbAvailable())("학원 직원 켜고 끄기(계약 08 §4 employment)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let now = Temporal.Instant.from("2026-11-21T03:00:00Z");
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const aff: Record<string, string> = {};
  let classA = "";

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = () => ({ db: handle.db, getSession, clock: fixedClock(now) });

  async function makeStaff(key: string, roles: string[]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
    tokens[key] = (await ctx.internalAdapter.createSession(user.id)).token;
    const id = randomUUID();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, status, updated_at) VALUES ($1, $2, $3, 'active', now())", [
      id,
      user.id,
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string, owner: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `${key}댄스학원`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds[owner]]);
  }

  /** 소속 행 + (프리랜서면) 승인 때 만든 첫 비율 판본 — 승인 경로는 S1-2.7 에서 확인했다 */
  async function insertAffiliation(instructor: string, status: string, opts: { employee?: boolean; rateBp?: number } = {}) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, is_academy_employee, decided_at, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4, $5::timestamptz, now()) RETURNING id`,
      [academyIds["A"], staffIds[instructor], status, opts.employee ?? false, status === "pending" ? null : APPROVED_AT],
    );
    const id = (rows[0] as { id: string }).id;
    if (opts.rateBp !== undefined) {
      await q(
        `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
         VALUES (uuidv7(), $1, $2, $3::timestamptz, $4)`,
        [id, opts.rateBp, APPROVED_AT, staffIds["ownerA"]],
      );
    }
    return id;
  }

  async function put(who: string, academy: string, affiliationId: string, body: unknown) {
    const academyId = academyIds[academy] ?? academy;
    const request = new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/employment`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` },
      body: JSON.stringify(body),
    });
    const res = await createUpdateAffiliationEmploymentRoute(deps())(request, {
      params: Promise.resolve({ academyId, id: affiliationId }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function getRates(affiliationId: string) {
    const academyId = academyIds["A"]!;
    const request = new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/share-rates`, {
      headers: { authorization: `Bearer ${tokens["ownerA"]}` },
    });
    const res = await createGetShareRatesRoute(deps())(request, { params: Promise.resolve({ academyId, id: affiliationId }) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const rateAt = (affiliationId: string, paidAt: string) =>
    handle.db.transaction((tx) =>
      findEffectiveShareRateBp(tx, { affiliationId, classId: classA, paidAt: Temporal.Instant.from(paidAt) }),
    );

  async function isEmployee(affiliationId: string): Promise<boolean> {
    const { rows } = await q("SELECT is_academy_employee FROM instructor_affiliations WHERE id = $1", [affiliationId]);
    return (rows[0] as { is_academy_employee: boolean }).is_academy_employee;
  }

  async function baseRows(affiliationId: string) {
    const { rows } = await q("SELECT rate_bp FROM instructor_share_rates WHERE affiliation_id = $1 ORDER BY effective_from", [affiliationId]);
    return rows.map((r) => (r as { rate_bp: number }).rate_bp);
  }

  async function overrideRows(affiliationId: string) {
    const { rows } = await q(
      "SELECT rate_bp FROM instructor_share_rate_overrides WHERE affiliation_id = $1 ORDER BY effective_from",
      [affiliationId],
    );
    return rows.map((r) => (r as { rate_bp: number | null }).rate_bp);
  }

  async function audits(affiliationId: string) {
    const { rows } = await q(
      `SELECT actor_staff_account_id, target_table, before, after FROM audit_logs
       WHERE action = 'affiliation.employee_flag_changed' AND target_id = $1 ORDER BY occurred_at, id`,
      [affiliationId],
    );
    return rows as { actor_staff_account_id: string; target_table: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    for (const key of ["freelancer", "employee", "pending", "delegate", "same"]) await makeStaff(key, ["instructor"]);
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");

    classA = randomUUID();
    await q(
      `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
       VALUES ($1, $2, '살사 입문', '강사', 'salsa_bachata', 'one_day', 'single', now())`,
      [classA, academyIds["A"]],
    );

    aff["freelancer"] = await insertAffiliation("freelancer", "active", { rateBp: 6000 });
    // 「살사 입문」만 70% 예외가 켜져 있다
    await q(
      `INSERT INTO instructor_share_rate_overrides (id, affiliation_id, class_id, rate_bp, effective_from, created_by_account_id)
       VALUES (uuidv7(), $1, $2, 7000, $3::timestamptz, $4)`,
      [aff["freelancer"], classA, OVERRIDE_AT, staffIds["ownerA"]],
    );
    aff["employee"] = await insertAffiliation("employee", "active", { employee: true });
    aff["pending"] = await insertAffiliation("pending", "pending");
    aff["delegate"] = await insertAffiliation("delegate", "active", { rateBp: 5000 });
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, 'roster_manage', $2)", [
      aff["delegate"],
      staffIds["ownerA"],
    ]);
    aff["same"] = await insertAffiliation("same", "active", { rateBp: 6000 });
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("verify — 켜면 비율 행이 닫힌다: 비율 경로 409 · 켜진 수업별 예외는 NULL 판본 · 기본 판본은 이력으로 그대로 · 감사 1행", async () => {
    expect(await rateAt(aff["freelancer"]!, "2026-11-20T00:00:00Z")).toBe(7000);

    now = Temporal.Instant.from("2026-11-21T03:00:00Z");
    const on = await put("ownerA", "A", aff["freelancer"]!, { isAcademyEmployee: true });
    expect(on.status).toBe(200);
    expect(updatedEmploymentSchema.parse(on.json)).toEqual({
      affiliationId: aff["freelancer"],
      isAcademyEmployee: true,
      shareRateBp: null,
      changedAt: "2026-11-21T03:00:00Z",
    });
    expect(await isEmployee(aff["freelancer"]!)).toBe(true);

    // 비율 경로가 닫혔다
    const rates = await getRates(aff["freelancer"]!);
    expect([rates.status, rates.json["code"]]).toEqual([409, "EMPLOYEE_HAS_NO_SHARE_RATE"]);
    // 수업별 예외는 NULL 판본으로 닫혔고(지우지 않음), 기본 판본은 고치지 않았다
    expect(await overrideRows(aff["freelancer"]!)).toEqual([7000, null]);
    expect(await baseRows(aff["freelancer"]!)).toEqual([6000]);
    // 켜기 전 결제는 예외 값 그대로, 켠 뒤로는 예외가 닫혔다
    expect(await rateAt(aff["freelancer"]!, "2026-11-20T00:00:00Z")).toBe(7000);
    expect(await rateAt(aff["freelancer"]!, "2026-11-21T04:00:00Z")).toBe(6000);

    const logged = await audits(aff["freelancer"]!);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      actor_staff_account_id: staffIds["ownerA"],
      target_table: "instructor_affiliations",
      before: { isAcademyEmployee: false, shareRateBp: 6000 },
      after: { isAcademyEmployee: true, shareRateBp: null, closedOverrideClassIds: [classA] },
    });
  });

  test("끄기 — 비율을 함께 받아 새 기본 판본(끈 뒤 결제분부터) · 닫힌 예외는 되살아나지 않는다 · 감사 1행 더", async () => {
    now = Temporal.Instant.from("2026-11-21T05:00:00Z");
    const off = await put("ownerA", "A", aff["freelancer"]!, { isAcademyEmployee: false, shareRateBp: 5500 });
    expect(off.status).toBe(200);
    expect(updatedEmploymentSchema.parse(off.json)).toEqual({
      affiliationId: aff["freelancer"],
      isAcademyEmployee: false,
      shareRateBp: 5500,
      changedAt: "2026-11-21T05:00:00Z",
    });
    expect(await isEmployee(aff["freelancer"]!)).toBe(false);
    expect(await baseRows(aff["freelancer"]!)).toEqual([6000, 5500]);
    expect(await rateAt(aff["freelancer"]!, "2026-11-21T06:00:00Z")).toBe(5500);

    const rates = await getRates(aff["freelancer"]!);
    expect(rates.status).toBe(200);
    const parsed = shareRatesSchema.parse(rates.json);
    expect(parsed.current).toEqual({ rateBp: 5500, effectiveFrom: "2026-11-21T05:00:00Z" });
    expect(parsed.overrides).toEqual([]);

    const logged = await audits(aff["freelancer"]!);
    expect(logged).toHaveLength(2);
    expect(logged[1]).toMatchObject({
      before: { isAcademyEmployee: true, shareRateBp: null },
      after: { isAcademyEmployee: false, shareRateBp: 5500 },
    });
  });

  test("승인 때부터 직원이던 강사(비율 행 0개)를 끄면 첫 기본 판본이 생긴다", async () => {
    expect(await baseRows(aff["employee"]!)).toEqual([]);
    now = Temporal.Instant.from("2026-11-21T07:00:00Z");
    const off = await put("ownerA", "A", aff["employee"]!, { isAcademyEmployee: false, shareRateBp: 6000 });
    expect(off.status).toBe(200);
    expect(await baseRows(aff["employee"]!)).toEqual([6000]);
    // 다시 켜면 예외가 없어도 된다 — 닫은 수업 목록은 빈 배열
    now = Temporal.Instant.from("2026-11-21T08:00:00Z");
    expect((await put("ownerA", "A", aff["employee"]!, { isAcademyEmployee: true })).status).toBe(200);
    expect((await audits(aff["employee"]!))[1]!.after).toMatchObject({ closedOverrideClassIds: [] });
  });

  test("같은 값 PUT → 200, 행·감사 0 · changedAt 은 승인 시각", async () => {
    now = Temporal.Instant.from("2026-11-21T09:00:00Z");
    const res = await put("ownerA", "A", aff["same"]!, { isAcademyEmployee: false, shareRateBp: 9000 });
    expect(res.status).toBe(200);
    expect(updatedEmploymentSchema.parse(res.json)).toEqual({
      affiliationId: aff["same"],
      isAcademyEmployee: false,
      shareRateBp: 6000,
      changedAt: APPROVED_AT,
    });
    expect(await baseRows(aff["same"]!)).toEqual([6000]);
    expect(await audits(aff["same"]!)).toHaveLength(0);
  });

  test("본문 검사 — 끄기에 비율 없음 422 SHARE_RATE_REQUIRED · 켜기에 비율 422 · 범위 밖·모르는 칸 422", async () => {
    const noRate = await put("ownerA", "A", aff["same"]!, { isAcademyEmployee: false });
    expect([noRate.status, noRate.json["code"]]).toEqual([422, "SHARE_RATE_REQUIRED"]);
    const nullRate = await put("ownerA", "A", aff["same"]!, { isAcademyEmployee: false, shareRateBp: null });
    expect([nullRate.status, nullRate.json["code"]]).toEqual([422, "SHARE_RATE_REQUIRED"]);
    const onWithRate = await put("ownerA", "A", aff["same"]!, { isAcademyEmployee: true, shareRateBp: 6000 });
    expect([onWithRate.status, onWithRate.json["code"]]).toEqual([422, "VALIDATION_FAILED"]);
    for (const body of [{}, { isAcademyEmployee: "yes" }, { isAcademyEmployee: false, shareRateBp: 10001 }, { isAcademyEmployee: true, x: 1 }]) {
      expect((await put("ownerA", "A", aff["same"]!, body)).status).toBe(422);
    }
    expect(await isEmployee(aff["same"]!)).toBe(false);
  });

  test("상태·권한 — 대기 409 · 없는 id 404 · 위임 강사 403 · 다른 학원 대표 403/404", async () => {
    const pending = await put("ownerA", "A", aff["pending"]!, { isAcademyEmployee: true });
    expect([pending.status, pending.json["code"]]).toEqual([409, "AFFILIATION_STATE_CONFLICT"]);
    expect((await put("ownerA", "A", randomUUID(), { isAcademyEmployee: true })).status).toBe(404);
    expect((await put("ownerA", "A", "not-a-uuid", { isAcademyEmployee: true })).status).toBe(404);
    expect((await put("delegate", "A", aff["delegate"]!, { isAcademyEmployee: true })).status).toBe(403);
    expect((await put("ownerB", "A", aff["delegate"]!, { isAcademyEmployee: true })).status).toBe(403);
    expect((await put("ownerB", "B", aff["delegate"]!, { isAcademyEmployee: true })).status).toBe(404);
    expect(await isEmployee(aff["delegate"]!)).toBe(false);
    expect(await isEmployee(aff["pending"]!)).toBe(false);
  });
});
