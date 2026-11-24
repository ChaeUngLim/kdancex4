// S2-1.10(앱 계정 찾기·소속 신청·학원 색 화면) — 소속 카드(`GET /api/instructor/affiliations`)의 `calendarColorIndex` 를
// 진짜 세션 + PostgreSQL 로 확인한다. 계약 08 §2(2026-11-21 사용자 결정: 학원 색은 소속 카드로 읽는다, 별도 API 없음).
//   왜 필요한가: I9E(학원 색) 화면이 처음 열릴 때 지금 고른 색을 그리려면, 서버가 카드마다 색 번호를 실어 줘야 한다.
//   확인하는 것: 색이 있으면 그 번호(0·8·11), 없으면 null · 카드는 학원마다 최근 행이라 옛 행의 색이 새 행에 새지 않음
//   · 다른 강사의 색이 섞이지 않음 · 색 저장(PUT …/color) 뒤 다시 읽으면 바뀐 번호 · 응답이 계약 스키마(strict)를 지킴.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createSetAffiliationColorRoute } from "@/lib/server/services/instructor-academies";
import { affiliationCardListSchema, createListMyAffiliationsRoute } from "@/lib/server/services/instructor-affiliations";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-card-color-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("소속 카드의 학원 색 번호(계약 08 §2 calendarColorIndex)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const deps = () => ({
    db: handle.db,
    getSession: (h: Headers) => auth.api.getSession({ headers: h }),
    clock: fixedClock(NOW),
  });

  async function makeStaff(key: string, roles: string[]) {
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
      key,
    ]);
    for (const role of roles) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  async function makeAcademy(key: string) {
    academyIds[key] = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, updated_at, ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, $2, '서울', '마포구', 'active', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyIds[key], `학원 ${key}`],
    );
    await q("INSERT INTO academy_owners (id, academy_id, staff_account_id) VALUES (uuidv7(), $1, $2)", [academyIds[key], staffIds["owner"]]);
  }

  /** 소속 행 하나를 DB 로 바로 만든다(승인·거절 경로는 다른 Task). 색 번호는 그대로 넣는다 */
  async function insertAffiliation(academy: string, instructor: string, status: string, requestedAt: string, color: number | null) {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, requested_at, decided_at, released_at, calendar_color_index, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz,
               CASE WHEN $3 IN ('active','released') THEN $4::timestamptz END,
               CASE WHEN $3 = 'released' THEN $4::timestamptz END, $5, now())
       RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, requestedAt, color],
    );
    return (rows[0] as { id: string }).id;
  }

  /** 카드 목록을 읽고 계약 스키마(strict)로 검사한 뒤 「학원 이름 → 색 번호」로 돌려준다 */
  async function colorsByAcademy(who: string): Promise<Record<string, number | null>> {
    const res = await createListMyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = affiliationCardListSchema.parse(await res.json());
    return Object.fromEntries(body.items.map((c) => [c.academyName, c.calendarColorIndex]));
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    for (const k of ["A", "B", "C", "D", "E"]) await makeAcademy(k);
    await makeStaff("iu", ["instructor"]);
    await makeStaff("other", ["instructor"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("색이 있으면 번호(경계 0·11 포함), 없으면 null — 대기 중 카드도 칸은 있고 값은 null", async () => {
    await insertAffiliation("A", "iu", "active", "2026-11-01T00:00:00Z", 8);
    await insertAffiliation("B", "iu", "active", "2026-11-02T00:00:00Z", 0);
    await insertAffiliation("C", "iu", "active", "2026-11-03T00:00:00Z", 11);
    await insertAffiliation("D", "iu", "pending", "2026-11-04T00:00:00Z", null);

    expect(await colorsByAcademy("iu")).toEqual({ "학원 A": 8, "학원 B": 0, "학원 C": 11, "학원 D": null });
  });

  test("카드는 학원마다 최근 행 — 해제된 옛 행의 색(5)이 다시 신청한 새 대기 행에 새지 않는다", async () => {
    await insertAffiliation("E", "iu", "released", "2026-10-01T00:00:00Z", 5);
    expect((await colorsByAcademy("iu"))["학원 E"]).toBe(5);

    await insertAffiliation("E", "iu", "pending", "2026-11-10T00:00:00Z", null);
    expect((await colorsByAcademy("iu"))["학원 E"]).toBeNull();
  });

  test("다른 강사의 색은 섞이지 않는다 — 같은 학원 A 에 다른 강사가 3번을 골라도 내 카드는 8", async () => {
    await insertAffiliation("A", "other", "active", "2026-11-05T00:00:00Z", 3);
    expect((await colorsByAcademy("iu"))["학원 A"]).toBe(8);
    expect(await colorsByAcademy("other")).toEqual({ "학원 A": 3 });
  });

  test("색 저장(PUT …/color) 뒤 다시 읽으면 카드의 번호가 바뀐다 — I9E 가 다시 열려도 고른 색이 그대로 보인다", async () => {
    const { rows } = await q("SELECT id FROM instructor_affiliations WHERE academy_id = $1 AND instructor_account_id = $2", [
      academyIds["A"],
      staffIds["iu"],
    ]);
    const affiliationId = (rows[0] as { id: string }).id;
    const res = await createSetAffiliationColorRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations/${affiliationId}/color`, {
        method: "PUT",
        headers: { authorization: `Bearer ${tokens["iu"]}`, "content-type": "application/json" },
        body: JSON.stringify({ colorIndex: 2 }),
      }),
      { params: Promise.resolve({ id: affiliationId }) },
    );
    expect(res.status).toBe(200);
    expect((await colorsByAcademy("iu"))["학원 A"]).toBe(2);
  });
});
