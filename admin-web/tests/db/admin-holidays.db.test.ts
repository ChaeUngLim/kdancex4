// S7-4.8a(공휴일 운영자 입력 API(P9)) — `/api/admin/console/holidays/**`(계약 13 §10-1)를 진짜 세션 + PostgreSQL 로 확인한다.
//   로드맵 verify 의 파일 이름은 tests/db/s7-4-8a.db.test.ts 였는데, 기능 이름(admin-holidays)으로 바꿨다.
//   핵심(verify): ① 운영자 입력 줄만 고치고 지운다 — 자동 수집 줄은 409 HOLIDAY_NOT_EDITABLE, 표·감사 그대로
//                 ② 더하고 지우면 영업일 계산(loadHolidayCalendar + addBusinessDays)이 바로 바뀐다
//   나머지: 같은 날짜 409 · 감사 holiday.created/updated/deleted(전·후 값) · 같은 값 PATCH 는 변화 없음
//           · 지운 줄 다시 DELETE 200(같은 시각) · 날짜 바꾸기 422 · 목록 editable·lastSync · 조회 기록 1분 합치기
//           · 운영자 아님 403 · 2단계 전 401 · 로그인 없음 401
import { randomUUID } from "node:crypto";

import { getMigrations } from "better-auth/db/migration";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { addBusinessDays } from "@/lib/domain/business-days";
import {
  createAdminHolidaysRoutes,
  createHolidayResponseSchema,
  deleteHolidayResponseSchema,
  holidayItemSchema,
  holidayListResponseSchema,
  HOLIDAYS_SCREEN_ID,
  loadHolidayCalendar,
} from "@/lib/server/services/admin-holidays";
import { createStaffAuth, type StaffAuth } from "@/lib/server/staff-auth";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

const SECRET = "admin-holidays-test-secret-0123456789-012345";
const BASE = "http://localhost:3000";
// 서버 시계 — 조회 기록 1분 합치기를 재려고 테스트가 직접 앞으로 돌린다
const START = Temporal.Instant.from("2026-12-01T01:00:00Z");

describe.skipIf(!dbAvailable())("/api/admin/console/holidays(계약 13 §10-1)", () => {
  let handle: TestDb;
  let auth: StaffAuth;
  let routes: ReturnType<typeof createAdminHolidaysRoutes>;
  let now = START;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const tokens: Record<string, string> = {};
  const staffIds: Record<string, string> = {};

  async function makeStaff(key: string, opts: { twoFactor?: boolean; roles?: string[] } = {}) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: `${key}@example.com`, name: key, emailVerified: true, username: key, displayUsername: key },
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
    for (const role of opts.roles ?? []) await q("INSERT INTO role_grants (id, staff_account_id, role) VALUES (uuidv7(), $1, $2)", [id, role]);
    staffIds[key] = id;
  }

  const headersFor = (who: string | undefined) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who !== undefined) headers["authorization"] = `Bearer ${tokens[who]}`;
    return headers;
  };
  const params = (holidayId: string) => ({ params: Promise.resolve({ holidayId }) });

  async function call(res: Promise<Response>) {
    const response = await res;
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json, code: json["code"] };
  }
  const list = (who: string | undefined, year?: number) =>
    call(routes.list(new Request(`${BASE}/api/admin/console/holidays${year === undefined ? "" : `?year=${year}`}`, { headers: headersFor(who) }), undefined));
  const create = (who: string | undefined, body: Record<string, unknown>) =>
    call(routes.create(new Request(`${BASE}/api/admin/console/holidays`, { method: "POST", headers: headersFor(who), body: JSON.stringify(body) }), undefined));
  const patch = (who: string | undefined, id: string, body: Record<string, unknown>) =>
    call(routes.update(new Request(`${BASE}/api/admin/console/holidays/${id}`, { method: "PATCH", headers: headersFor(who), body: JSON.stringify(body) }), params(id)));
  const remove = (who: string | undefined, id: string) =>
    call(routes.remove(new Request(`${BASE}/api/admin/console/holidays/${id}`, { method: "DELETE", headers: headersFor(who) }), params(id)));

  /** 자동 수집 줄 하나(특일 정보가 넣은 것처럼) — 수집 작업은 S0-4.10 몫이라 표에 바로 넣는다 */
  async function insertApi(date: string, name: string, kind = "holiday"): Promise<string> {
    const { rows } = await q(
      "INSERT INTO holidays (id, date, name, kind, source) VALUES (uuidv7(), $1, $2, $3, 'api') RETURNING id::text AS id",
      [date, name, kind],
    );
    return rows[0].id as string;
  }
  const holidayAudits = async () =>
    (await q("SELECT action, target_id::text AS target_id, before, after, actor_staff_account_id::text AS actor FROM audit_logs WHERE target_table = 'holidays' AND occurred_at >= $1 ORDER BY occurred_at, id", [base.toString()])).rows;
  const row = async (id: string) =>
    (await q("SELECT name, kind, source, deleted_at, updated_at FROM holidays WHERE id = $1", [id])).rows[0];
  /** 5/4(화) + 2영업일 — 5/5(어린이날, 자동)를 건너뛴다. 5/6 이 공휴일이 되면 결과가 5/7 → 5/10 으로 밀린다 */
  const twoBusinessDaysAfterMay4 = async () =>
    addBusinessDays(Temporal.PlainDate.from("2027-05-04"), 2, await loadHolidayCalendar(handle.db)).toString();

  let childrensDay: string;

  beforeAll(async () => {
    handle = openTestDb();
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    auth = createStaffAuth({ pool: handle.pool, secret: SECRET, baseURL: BASE });
    await (await getMigrations(auth.options)).runMigrations();
    routes = createAdminHolidaysRoutes({
      db: handle.db,
      getSession: (headers) => auth.api.getSession({ headers }),
      clock: () => now,
    });
    await makeStaff("admin", { roles: ["admin"] });
    await makeStaff("admin2", { roles: ["admin"] });
    await makeStaff("adminNo2fa", { roles: ["admin"], twoFactor: false });
    await makeStaff("owner", { roles: ["owner"] });
  });

  // audit_logs 는 지울 수 없는 표다(트리거). 그래서 테스트마다 서버 시계를 하루씩 뒤로 옮기고,
  // 감사 줄은 「이 테스트의 시작 시각 이후」만 센다 — 표를 비우지 않고도 테스트끼리 섞이지 않는다
  let testIndex = 0;
  let base = START;
  beforeEach(async () => {
    await q("DELETE FROM holidays");
    await q("DELETE FROM holiday_sync_runs");
    base = START.add({ hours: 24 * testIndex });
    testIndex += 1;
    now = base;
    childrensDay = await insertApi("2027-05-05", "어린이날");
  });

  afterAll(async () => {
    await truncateAll(handle.pool);
    await q("DROP SCHEMA IF EXISTS auth CASCADE");
    await closeTestDb(handle);
  });

  test("운영자 줄 더하기 201 → 감사 holiday.created 1행 + 영업일 계산이 바로 밀린다(5/7 → 5/10)", async () => {
    expect(await twoBusinessDaysAfterMay4()).toBe("2027-05-07");

    const res = await create("admin", { date: "2027-05-06", name: "임시 휴일(예시)", kind: "temporary_holiday" });
    expect(res.status).toBe(201);
    const { holidayId } = createHolidayResponseSchema.parse(res.json);

    expect(await row(holidayId)).toMatchObject({ name: "임시 휴일(예시)", kind: "temporary_holiday", source: "operator", deleted_at: null });
    const { rows: creator } = await q("SELECT created_by_account_id::text AS c FROM holidays WHERE id = $1", [holidayId]);
    expect(creator[0].c).toBe(staffIds["admin"]);
    expect(await holidayAudits()).toEqual([
      {
        action: "holiday.created",
        target_id: holidayId,
        before: null,
        after: { date: "2027-05-06", name: "임시 휴일(예시)", kind: "temporary_holiday", source: "operator" },
        actor: staffIds["admin"],
      },
    ]);
    expect(await twoBusinessDaysAfterMay4()).toBe("2027-05-10");
  });

  test("같은 날짜에 살아 있는 줄(자동이든 운영자든)이 있으면 409 HOLIDAY_DATE_EXISTS — 줄·감사 늘지 않음", async () => {
    expect((await create("admin", { date: "2027-05-05", name: "겹침", kind: "holiday" })).code).toBe("HOLIDAY_DATE_EXISTS");
    await create("admin", { date: "2027-05-06", name: "임시", kind: "temporary_holiday" });
    expect((await create("admin2", { date: "2027-05-06", name: "또", kind: "holiday" })).code).toBe("HOLIDAY_DATE_EXISTS");
    expect(Number((await q("SELECT count(*)::int AS n FROM holidays")).rows[0].n)).toBe(2);
    expect((await holidayAudits()).length).toBe(1);
  });

  test("자동 수집 줄은 PATCH·DELETE 모두 409 HOLIDAY_NOT_EDITABLE — 값·deleted_at·감사 그대로(Q35)", async () => {
    const before = await row(childrensDay);
    expect((await patch("admin", childrensDay, { name: "바꾼 이름" })).code).toBe("HOLIDAY_NOT_EDITABLE");
    expect((await patch("admin", childrensDay, { kind: "temporary_holiday" })).code).toBe("HOLIDAY_NOT_EDITABLE");
    const del = await remove("admin", childrensDay);
    expect(del).toMatchObject({ status: 409, code: "HOLIDAY_NOT_EDITABLE" });
    expect(await row(childrensDay)).toEqual(before);
    expect(await holidayAudits()).toEqual([]);
    expect(await twoBusinessDaysAfterMay4()).toBe("2027-05-07");
  });

  test("운영자 줄 PATCH 200 → 이름·종류가 바뀌고 감사 holiday.updated(전·후 값). 같은 값을 다시 보내면 변화 없음", async () => {
    const { holidayId } = createHolidayResponseSchema.parse(
      (await create("admin", { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday" })).json,
    );
    now = base.add({ minutes: 5 });
    const res = await patch("admin2", holidayId, { name: "임시 공휴일(정부 지정)", kind: "holiday" });
    expect(res.status).toBe(200);
    expect(holidayItemSchema.parse(res.json)).toEqual({
      holidayId,
      date: "2027-05-06",
      weekday: "목",
      name: "임시 공휴일(정부 지정)",
      kind: "holiday",
      source: "operator",
      editable: true,
    });
    const audits = await holidayAudits();
    expect(audits[1]).toEqual({
      action: "holiday.updated",
      target_id: holidayId,
      before: { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday" },
      after: { date: "2027-05-06", name: "임시 공휴일(정부 지정)", kind: "holiday" },
      actor: staffIds["admin2"],
    });

    const stamp = (await row(holidayId)).updated_at;
    now = base.add({ minutes: 10 });
    const same = await patch("admin", holidayId, { name: "임시 공휴일(정부 지정)" });
    expect(same.status).toBe(200);
    expect((await row(holidayId)).updated_at).toEqual(stamp);
    expect((await holidayAudits()).length).toBe(2);
  });

  test("PATCH 본문 검사 — 날짜 바꾸기·빈 본문·모르는 종류·빈 이름은 422, 줄 그대로", async () => {
    const { holidayId } = createHolidayResponseSchema.parse(
      (await create("admin", { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday" })).json,
    );
    for (const body of [{ date: "2027-05-07" }, {}, { kind: "substitute" }, { name: "  " }, { source: "api" }]) {
      expect((await patch("admin", holidayId, body)).code, JSON.stringify(body)).toBe("VALIDATION_FAILED");
    }
    expect(await row(holidayId)).toMatchObject({ name: "임시 휴일", kind: "temporary_holiday" });
    // POST 도 출처를 받지 않는다 — 운영자가 자동 줄처럼 꾸며 넣을 수 없다
    expect((await create("admin", { date: "2027-06-01", name: "x", kind: "holiday", source: "api" })).code).toBe("VALIDATION_FAILED");
    expect((await create("admin", { date: "2027-13-01", name: "x", kind: "holiday" })).code).toBe("VALIDATION_FAILED");
  });

  test("운영자 줄 DELETE 200 → deleted_at·감사 holiday.deleted, 영업일 계산이 되돌아온다. 다시 DELETE 는 같은 시각으로 200", async () => {
    const { holidayId } = createHolidayResponseSchema.parse(
      (await create("admin", { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday" })).json,
    );
    expect(await twoBusinessDaysAfterMay4()).toBe("2027-05-10");

    now = base.add({ hours: 1 });
    const res = await remove("admin", holidayId);
    expect(res.status).toBe(200);
    expect(deleteHolidayResponseSchema.parse(res.json)).toEqual({ deletedAt: now.toString() });
    expect(await twoBusinessDaysAfterMay4()).toBe("2027-05-07");
    const audits = await holidayAudits();
    expect(audits[1]).toEqual({
      action: "holiday.deleted",
      target_id: holidayId,
      before: { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday", deletedAt: null },
      after: { date: "2027-05-06", name: "임시 휴일", kind: "temporary_holiday", deletedAt: now.toString() },
      actor: staffIds["admin"],
    });

    const deletedAt = now.toString();
    now = base.add({ hours: 2 });
    const again = await remove("admin", holidayId);
    expect(again.status).toBe(200);
    expect(Temporal.Instant.from(String(again.json["deletedAt"])).equals(Temporal.Instant.from(deletedAt))).toBe(true);
    expect((await holidayAudits()).length).toBe(2);

    // 지운 줄은 고칠 대상이 아니다(404). 같은 날짜는 새로 더할 수 있다
    expect((await patch("admin", holidayId, { name: "되살리기" })).status).toBe(404);
    expect((await create("admin", { date: "2027-05-06", name: "다시 지정", kind: "temporary_holiday" })).status).toBe(201);
  });

  test("없는 id·uuid 모양이 아닌 id 는 404", async () => {
    expect((await patch("admin", randomUUID(), { name: "x" })).code).toBe("NOT_FOUND");
    expect((await remove("admin", "not-a-uuid")).code).toBe("NOT_FOUND");
  });

  test("GET 은 그해 살아 있는 줄만 날짜순 + editable(운영자 줄만 true) + lastSync, 조회 기록은 1분 안이면 한 줄", async () => {
    await insertApi("2027-02-09", "설날 대체", "substitute_holiday");
    await insertApi("2028-01-01", "신정");
    const { holidayId } = createHolidayResponseSchema.parse(
      (await create("admin", { date: "2027-05-06", name: "임시 휴일(예시)", kind: "temporary_holiday" })).json,
    );
    const gone = createHolidayResponseSchema.parse((await create("admin", { date: "2027-08-16", name: "지울 줄", kind: "temporary_holiday" })).json);
    await remove("admin", gone.holidayId);
    await q(
      "INSERT INTO holiday_sync_runs (id, ran_at, year, status, rows_upserted, error_code) VALUES (uuidv7(), '2026-11-20T18:00:00Z', 2027, 'success', 15, NULL), (uuidv7(), '2026-11-19T18:00:00Z', 2027, 'failed', 0, 'TIMEOUT')",
    );

    const res = await list("admin", 2027);
    expect(res.status).toBe(200);
    const body = holidayListResponseSchema.parse(res.json);
    expect(body.year).toBe(2027);
    expect(body.lastSync).toEqual({ ranAt: "2026-11-20T18:00:00.000000Z", status: "success", source: "공공데이터포털 특일 정보" });
    expect(body.items.map((i) => [i.date, i.weekday, i.source, i.editable])).toEqual([
      ["2027-02-09", "화", "api", false],
      ["2027-05-05", "수", "api", false],
      ["2027-05-06", "목", "operator", true],
    ]);
    expect(body.items[2]!.holidayId).toBe(holidayId);

    const views = async () =>
      (await q("SELECT target_id::text AS t, after FROM audit_logs WHERE action = 'console.viewed' AND target_table = 'console_screen' AND occurred_at >= $1", [base.toString()])).rows;
    now = base.add({ seconds: 59 });
    await list("admin", 2027);
    expect(await views()).toEqual([{ t: HOLIDAYS_SCREEN_ID, after: { screen: "holidays", filters: { year: 2027 } } }]);
    now = base.add({ seconds: 61 });
    await list("admin", 2027);
    await list("admin2", 2027);
    expect((await views()).length).toBe(3);

    // year 없으면 KST 올해(2026) — 표에 그해 줄이 없어 빈 목록
    expect(holidayListResponseSchema.parse((await list("admin")).json)).toMatchObject({ year: 2026, items: [] });
    expect((await list("admin", 1900)).code).toBe("VALIDATION_FAILED");
  });

  test("자동 수집 기록이 없으면 lastSync 는 null", async () => {
    expect(holidayListResponseSchema.parse((await list("admin", 2027)).json).lastSync).toBeNull();
  });

  test("권한 — 대표 403 · 운영자라도 2단계 전 401 SECOND_FACTOR_REQUIRED · 로그인 없음 401. 표는 그대로", async () => {
    const body = { date: "2027-05-06", name: "임시", kind: "temporary_holiday" };
    expect((await create("owner", body)).status).toBe(403);
    expect((await create("adminNo2fa", body)).code).toBe("SECOND_FACTOR_REQUIRED");
    expect((await create(undefined, body)).status).toBe(401);
    expect((await list("owner", 2027)).status).toBe(403);
    expect((await patch("owner", childrensDay, { name: "x" })).status).toBe(403);
    expect((await remove("adminNo2fa", childrensDay)).status).toBe(401);
    expect(Number((await q("SELECT count(*)::int AS n FROM holidays")).rows[0].n)).toBe(1);
  });
});
