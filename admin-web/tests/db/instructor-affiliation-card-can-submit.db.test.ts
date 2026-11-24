// 2026-11-23 사용자 결정 — 소속 카드(`GET /api/instructor/affiliations`)에 `canSubmitClass` 를 더한다(계약 08 §2).
//   왜 필요한가: 강사 앱 「수업 만들기」(I2)가 수업을 올릴 수 있는 학원을 staff/me 에서 찾고 있었는데, staff/me 는 계약상
//   관리자 웹 위임(roster_manage·class_manage)만 담는다(README §6-1). 그래서 대표가 앱 「수업 등록」(class_submit)을 켜도
//   강사가 수업을 만들 수 없었다. 학원 검색(§3-1)에도 같은 값이 있지만 이름 검색·최대 50개라 「내 소속 학원」을 빠짐없이 주지 못한다.
//   확인하는 것: 소속됨 + class_submit 일 때만 true · 웹 위임만으로는 false · 대기·해제는 false · 응답이 계약 스키마(strict)를 지킴.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { affiliationCardListSchema, createListMyAffiliationsRoute } from "@/lib/server/services/instructor-affiliations";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 비밀값 검사가 진짜 키로 오인하지 않게 한다
const SECRET = "affiliation-card-can-submit-test-".repeat(3);
const BASE = "http://localhost:3000";
const NOW = Temporal.Instant.from("2026-11-21T03:00:00Z");

describe.skipIf(!dbAvailable())("소속 카드의 앱 수업 등록 권한(계약 08 §2 canSubmitClass)", () => {
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

  /** 카드 목록을 읽고 계약 스키마(strict)로 검사한 뒤 「학원 이름 → 수업 등록 권한」으로 돌려준다 */
  async function canSubmitByAcademy(who: string): Promise<Record<string, boolean>> {
    const res = await createListMyAffiliationsRoute(deps())(
      new Request(`${BASE}/api/instructor/affiliations`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
      undefined,
    );
    expect(res.status).toBe(200);
    const body = affiliationCardListSchema.parse(await res.json());
    return Object.fromEntries(body.items.map((c) => [c.academyName, c.canSubmitClass]));
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("owner", ["owner"]);
    for (const k of ["A", "B", "C", "D"]) await makeAcademy(k);
    await makeStaff("iu", ["instructor"]);
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  async function delegate(affiliationId: string, permission: string) {
    await q("INSERT INTO instructor_delegations (affiliation_id, permission, granted_by_account_id) VALUES ($1, $2, $3)", [
      affiliationId,
      permission,
      staffIds["owner"],
    ]);
  }

  test("소속됨 + 앱 수업 등록(class_submit) 위임이 있을 때만 true — 웹 위임(class_manage)만으로는 false · 대기 중은 false", async () => {
    // A: 소속됨 + class_submit → true
    await delegate(await insertAffiliation("A", "iu", "active", "2026-11-01T00:00:00Z", 0), "class_submit");
    // B: 소속됨 + 웹 위임만(class_manage) → false(앱 권한과 웹 권한은 따로다, 계약 08 열린 점 ①)
    await delegate(await insertAffiliation("B", "iu", "active", "2026-11-02T00:00:00Z", 1), "class_manage");
    // C: 소속됨 + 위임 없음 → false
    await insertAffiliation("C", "iu", "active", "2026-11-03T00:00:00Z", 2);
    // D: 승인 대기 → false
    await insertAffiliation("D", "iu", "pending", "2026-11-04T00:00:00Z", null);

    expect(await canSubmitByAcademy("iu")).toEqual({ "학원 A": true, "학원 B": false, "학원 C": false, "학원 D": false });
  });

  test("해제된 소속은 옛 class_submit 위임이 남아 있어도 false", async () => {
    await q("UPDATE instructor_affiliations SET status = 'released', released_at = now() WHERE academy_id = $1", [academyIds["A"]]);
    expect((await canSubmitByAcademy("iu"))["학원 A"]).toBe(false);
  });
});
