// S1-2.9(위임 권한 켜고 끄기 API) — 계약 08 §4 의 `PUT /api/academies/{academyId}/affiliations/{id}/permissions` 를
// 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s1-2-9.db.test.ts 였는데, 기능 이름(affiliation-delegation-permissions)으로 바꿨다.
//   핵심(verify): 시나리오 3(대표가 roster_manage 를 끄면 그 강사의 다음 명단 요청이 403, 감사에 전후 배열)
//                 · 시나리오 6(위임 강사가 다른 강사의 권한을 바꾸면 403) · 같은 값 PUT → 감사 0행.
//   나머지: 앱 class_submit 은 웹 메뉴를 열지 않는다 · 모르는 값 422 · active 아닌 소속 409 · 다른 학원 403/404
//           · 강사 알림 delegation_changed · 2단계 전 401 · 로그인 없음 401.
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "@/lib/domain/time";
import { createGuards } from "@/lib/server/guards";
import { HttpError } from "@/lib/server/http";
import {
  createUpdateAffiliationPermissionsRoute,
  updatedDelegationsSchema,
} from "@/lib/server/services/academy-affiliation-permissions";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";
import { staffSessionCookie } from "../setup/staff-cookie";

// 테스트용 가짜 서명값(비밀 아님). 글자를 반복해 만들어 비밀값 검사(gitleaks)가 진짜 키로 오인하지 않게 한다
const SECRET = "delegation-permissions-test-".repeat(3);
const BASE = "http://localhost:3000";
const APPROVED_AT = "2026-11-10T00:00:00Z";

describe.skipIf(!dbAvailable())("위임 권한 켜고 끄기(계약 08 §4)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  // 테스트마다 시각을 바꿔 쓴다 — changedAt·감사 시각을 구별하려는 것이다
  let now = Temporal.Instant.from("2026-11-21T03:00:00Z");
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};
  const academyIds: Record<string, string> = {};
  const aff: Record<string, string> = {};

  const getSession = (h: Headers) => auth.api.getSession({ headers: h });
  const deps = () => ({ db: handle.db, getSession, clock: fixedClock(now) });

  async function makeStaff(key: string, roles: string[], opts: { twoFactor?: boolean } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: `staff_${key.toLowerCase()}`, displayUsername: key },
      { method: "admin" },
    );
    if (opts.twoFactor ?? true) await ctx.internalAdapter.updateUser(user.id, { twoFactorEnabled: true });
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

  /** 소속 행 하나(승인 경로는 S1-2.7 에서 확인했다) */
  async function insertAffiliation(academy: string, instructor: string, status: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO instructor_affiliations
         (id, academy_id, instructor_account_id, status, source, decided_at, reject_reason_code, updated_at)
       VALUES (uuidv7(), $1, $2, $3, 'application', $4::timestamptz, $5, now()) RETURNING id`,
      [academyIds[academy], staffIds[instructor], status, status === "pending" ? null : APPROVED_AT, status === "rejected" ? "other" : null],
    );
    return (rows[0] as { id: string }).id;
  }

  /**
   * mode "app" 은 대표 앱처럼 Bearer 토큰으로, "web" 은 관리자 웹처럼 서명 쿠키로 보낸다.
   * 왜 둘로 나누나: 이 경로는 대표 앱도 부르는 appToo 경로라(spec 11-13) Bearer 로 오면 2단계를 묻지 않는다.
   * 「2단계 전이면 401」은 관리자 웹 규칙이라 쿠키로 보내야 확인된다(M3-FIX.1).
   */
  async function put(who: string | undefined, academy: string, affiliationId: string, body: unknown, mode: "app" | "web" = "app") {
    const academyId = academyIds[academy] ?? academy;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined && mode === "web") headers["cookie"] = staffSessionCookie(tokens[who]!, SECRET);
    else if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    const res = await createUpdateAffiliationPermissionsRoute(deps())(
      new Request(`${BASE}/api/academies/${academyId}/affiliations/${affiliationId}/permissions`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ academyId, id: affiliationId }) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** 가드로 「그 강사의 다음 요청」을 흉내 낸다 — 명단 경로(S3)는 아직 없어서 같은 가드를 직접 부른다 */
  async function staffRequest(who: string, permission: "roster_manage" | "class_manage", academy: string): Promise<number> {
    const guards = createGuards({ db: handle.db, getSession });
    try {
      await guards.requireStaff(permission, {
        academyId: academyIds[academy],
        surface: "web",
        headers: new Headers({ authorization: `Bearer ${tokens[who]}` }),
      });
      return 200;
    } catch (error) {
      if (error instanceof HttpError) return error.status;
      throw error;
    }
  }

  async function delegationRows(affiliationId: string) {
    const { rows } = await q("SELECT permission FROM instructor_delegations WHERE affiliation_id = $1 ORDER BY permission", [affiliationId]);
    return rows.map((r) => (r as { permission: string }).permission);
  }

  async function audits(affiliationId: string) {
    const { rows } = await q(
      `SELECT actor_staff_account_id, academy_id, before, after FROM audit_logs
       WHERE action = 'delegation.changed' AND target_id = $1 ORDER BY occurred_at, id`,
      [affiliationId],
    );
    return rows as { actor_staff_account_id: string; academy_id: string; before: unknown; after: unknown }[];
  }

  async function notifications(instructor: string) {
    const { rows } = await q(
      `SELECT category, payload FROM notifications WHERE kind = 'delegation_changed' AND recipient_staff_account_id = $1
       ORDER BY created_at, id`,
      [staffIds[instructor]],
    );
    return rows as { category: string; payload: Record<string, unknown> }[];
  }

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();

    await makeStaff("ownerA", ["owner"]);
    await makeStaff("ownerB", ["owner"]);
    await makeStaff("ownerNo2fa", ["owner"], { twoFactor: false });
    await makeAcademy("A", "ownerA");
    await makeAcademy("B", "ownerB");
    await makeAcademy("C", "ownerNo2fa");
    for (const key of ["delegate", "other", "submitter", "pending", "released", "sameValue", "noAuth"]) {
      await makeStaff(key, ["instructor"]);
    }

    aff["delegate"] = await insertAffiliation("A", "delegate", "active");
    aff["other"] = await insertAffiliation("A", "other", "active");
    aff["submitter"] = await insertAffiliation("A", "submitter", "active");
    aff["pending"] = await insertAffiliation("A", "pending", "pending");
    aff["released"] = await insertAffiliation("A", "released", "released");
    aff["sameValue"] = await insertAffiliation("A", "sameValue", "active");
    aff["noAuth"] = await insertAffiliation("C", "noAuth", "active");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("시나리오 3 — 켠 roster_manage 로 명단 요청이 통과하고, 대표가 끄면 다음 요청이 403 · 감사에 전후 배열", async () => {
    now = Temporal.Instant.from("2026-11-21T03:00:00Z");
    expect(await staffRequest("delegate", "roster_manage", "A")).toBe(403);

    const on = await put("ownerA", "A", aff["delegate"]!, { permissions: ["roster_manage"] });
    expect(on.status).toBe(200);
    expect(updatedDelegationsSchema.parse(on.json)).toEqual({
      affiliationId: aff["delegate"],
      permissions: ["roster_manage"],
      changedAt: "2026-11-21T03:00:00Z",
    });
    expect(await delegationRows(aff["delegate"]!)).toEqual(["roster_manage"]);
    expect(await staffRequest("delegate", "roster_manage", "A")).toBe(200);

    // 대표가 끈다 — 세션은 그대로인데 다음 요청이 곧바로 403
    now = Temporal.Instant.from("2026-11-21T03:05:00Z");
    const off = await put("ownerA", "A", aff["delegate"]!, { permissions: [] });
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ affiliationId: aff["delegate"], permissions: [], changedAt: "2026-11-21T03:05:00Z" });
    expect(await delegationRows(aff["delegate"]!)).toEqual([]);
    expect(await staffRequest("delegate", "roster_manage", "A")).toBe(403);

    // 감사 2행 — 전후 권한 배열이 이어진다(대표가 한 일)
    const rows = await audits(aff["delegate"]!);
    expect(rows.map((r) => [r.before, r.after])).toEqual([
      [{ permissions: [] }, { permissions: ["roster_manage"] }],
      [{ permissions: ["roster_manage"] }, { permissions: [] }],
    ]);
    expect(rows.every((r) => r.actor_staff_account_id === staffIds["ownerA"] && r.academy_id === academyIds["A"])).toBe(true);

    // 강사 알림 2건(category operations) — 켜짐·꺼짐 문구
    const sent = await notifications("delegate");
    expect(sent.map((n) => [n.category, n.payload["body"], n.payload["after"]])).toEqual([
      ["operations", "켜짐: 예약·명단", ["roster_manage"]],
      ["operations", "꺼짐: 예약·명단", []],
    ]);
  });

  test("시나리오 6 — 위임 강사(roster_manage·class_manage 보유)가 다른 강사의 권한을 바꾸면 403, 아무것도 바뀌지 않는다", async () => {
    await put("ownerA", "A", aff["delegate"]!, { permissions: ["roster_manage", "class_manage"] });
    const auditBefore = (await audits(aff["other"]!)).length;

    const res = await put("delegate", "A", aff["other"]!, { permissions: ["roster_manage"] });
    expect(res.status).toBe(403);
    expect(res.json["code"]).toBe("FORBIDDEN");
    expect(await delegationRows(aff["other"]!)).toEqual([]);
    expect((await audits(aff["other"]!)).length).toBe(auditBefore);
    // 자기 자신의 권한도 못 바꾼다 — 위임 관리는 대표 고유 권한
    expect((await put("delegate", "A", aff["delegate"]!, { permissions: [] })).status).toBe(403);
    expect(await delegationRows(aff["delegate"]!)).toEqual(["class_manage", "roster_manage"]);
  });

  test("같은 값 PUT → 200, 감사 0행·알림 0건 · 순서·중복이 달라도 같은 집합이면 같은 값이다", async () => {
    now = Temporal.Instant.from("2026-11-21T04:00:00Z");
    const first = await put("ownerA", "A", aff["sameValue"]!, { permissions: ["class_manage", "roster_manage"] });
    expect(first.json["permissions"]).toEqual(["roster_manage", "class_manage"]);
    const auditCount = (await audits(aff["sameValue"]!)).length;
    const notiCount = (await notifications("sameValue")).length;
    expect([auditCount, notiCount]).toEqual([1, 1]);

    now = Temporal.Instant.from("2026-11-21T05:00:00Z");
    const again = await put("ownerA", "A", aff["sameValue"]!, { permissions: ["roster_manage", "class_manage", "roster_manage"] });
    expect(again.status).toBe(200);
    // 바뀐 게 없으니 changedAt 은 앞 변경 시각 그대로
    expect(again.json).toEqual({
      affiliationId: aff["sameValue"],
      permissions: ["roster_manage", "class_manage"],
      changedAt: "2026-11-21T04:00:00Z",
    });
    expect((await audits(aff["sameValue"]!)).length).toBe(auditCount);
    expect((await notifications("sameValue")).length).toBe(notiCount);

    // 한 번도 바꾼 적 없는 소속에 빈 배열 → 감사 0행, changedAt 은 승인 시각
    const untouched = await put("ownerA", "A", aff["other"]!, { permissions: [] });
    expect(untouched.json).toEqual({ affiliationId: aff["other"], permissions: [], changedAt: APPROVED_AT });
    expect((await audits(aff["other"]!)).length).toBe(0);
  });

  test("앱 class_submit 은 웹 권한과 따로 있다 — 켜도 웹 class_manage·roster_manage 요청은 403", async () => {
    now = Temporal.Instant.from("2026-11-21T06:00:00Z");
    const res = await put("ownerA", "A", aff["submitter"]!, { permissions: ["class_submit"] });
    expect(res.status).toBe(200);
    expect(res.json["permissions"]).toEqual(["class_submit"]);
    expect(await delegationRows(aff["submitter"]!)).toEqual(["class_submit"]);
    expect(await staffRequest("submitter", "class_manage", "A")).toBe(403);
    expect(await staffRequest("submitter", "roster_manage", "A")).toBe(403);

    // 웹 class_manage 를 함께 켜면 그때 웹 요청이 통과한다 — 두 권한은 각자 켜고 끈다
    await put("ownerA", "A", aff["submitter"]!, { permissions: ["class_submit", "class_manage"] });
    expect(await staffRequest("submitter", "class_manage", "A")).toBe(200);
    const [, second] = await audits(aff["submitter"]!);
    expect([second?.before, second?.after]).toEqual([{ permissions: ["class_submit"] }, { permissions: ["class_manage", "class_submit"] }]);
  });

  test("모르는 값·옛 값·모르는 칸은 422 VALIDATION_FAILED, 행은 그대로", async () => {
    for (const body of [
      { permissions: ["sales_view"] },
      { permissions: ["roster_view"] },
      { permissions: ["headcount_manage"] },
      { permissions: "roster_manage" },
      {},
      { permissions: [], extra: true },
    ]) {
      const res = await put("ownerA", "A", aff["other"]!, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json["code"]).toBe("VALIDATION_FAILED");
    }
    expect(await delegationRows(aff["other"]!)).toEqual([]);
  });

  test("active 아닌 소속(대기·해제)은 409 AFFILIATION_STATE_CONFLICT · 없는 id·모양 틀린 id 404", async () => {
    for (const key of ["pending", "released"]) {
      const res = await put("ownerA", "A", aff[key]!, { permissions: ["roster_manage"] });
      expect(res.status).toBe(409);
      expect(res.json["code"]).toBe("AFFILIATION_STATE_CONFLICT");
      expect(await delegationRows(aff[key]!)).toEqual([]);
    }
    expect((await put("ownerA", "A", randomUUID(), { permissions: [] })).status).toBe(404);
    expect((await put("ownerA", "A", "not-a-uuid", { permissions: [] })).status).toBe(404);
  });

  test("다른 학원 대표 — 학원 A 경로는 403 FORBIDDEN, 자기 학원 경로에 A 의 소속 id 를 넣으면 404", async () => {
    const forbidden = await put("ownerB", "A", aff["other"]!, { permissions: ["roster_manage"] });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json["code"]).toBe("FORBIDDEN");
    expect((await put("ownerB", "B", aff["other"]!, { permissions: ["roster_manage"] })).status).toBe(404);
    expect(await delegationRows(aff["other"]!)).toEqual([]);
  });

  test("관리자 웹: 2단계 전 대표 401 SECOND_FACTOR_REQUIRED · 로그인 없음 401 · 강사 403", async () => {
    // 관리자 웹(쿠키)으로 오면 2단계를 꼭 묻는다 — 401 이고 위임 행은 그대로 비어 있다
    const no2fa = await put("ownerNo2fa", "C", aff["noAuth"]!, { permissions: ["roster_manage"] }, "web");
    expect(no2fa.status).toBe(401);
    expect(no2fa.json["code"]).toBe("SECOND_FACTOR_REQUIRED");
    expect(await delegationRows(aff["noAuth"]!)).toEqual([]);
    expect((await put(undefined, "A", aff["other"]!, { permissions: [] })).status).toBe(401);
    expect((await put(undefined, "A", aff["other"]!, { permissions: [] }, "web")).status).toBe(401);
    expect((await put("other", "A", aff["other"]!, { permissions: ["roster_manage"] })).status).toBe(403);
    expect((await put("other", "A", aff["other"]!, { permissions: ["roster_manage"] }, "web")).status).toBe(403);
  });

  test("대표 앱(Bearer): 2단계를 켜지 않은 대표도 200 이 정상이다(appToo — 대표 앱에는 2단계가 없다)", async () => {
    // 2단계 정책(대표 앱에 2단계 없음)은 열린 질문이라 바꾸지 않고, 지금 규칙을 그대로 확인만 한다
    const app = await put("ownerNo2fa", "C", aff["noAuth"]!, { permissions: ["roster_manage"] }, "app");
    expect(app.status).toBe(200);
    expect(await delegationRows(aff["noAuth"]!)).toEqual(["roster_manage"]);
  });
});
