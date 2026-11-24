// S0-4.10(특일 정보 수집 작업) — 하루 1회 공휴일 수집이 실제 PostgreSQL 에서 규칙대로 도는지 확인한다(data-model §10-13).
// 바깥 API 대신 가짜 출처(FakeSpecialDayProvider)를 쓴다. 실 어댑터는 S0-4.11 이 같은 포트로 붙인다.
// 확인하는 것:
//   ① 가짜 응답으로 새 공휴일이 1행 들어가고, 성공 수집 기록이 1행 남는다
//   ② 실패 응답이면 holidays 는 한 글자도 안 바뀌고, 실패 기록(error_code)만 남는다
//   ③ 같은 응답으로 다시 돌려도 표가 늘지 않는다(멱등)
//   ④ 같은 날짜의 운영자 줄은 닫히고 자동 줄이 들어간다 + 감사 1행
//   ⑤ 내부 경로: 토큰 없으면 401, 맞으면 수집이 돈다
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { getDeps } from "../../lib/server/deps";
import { fakeHoliday, FakeSpecialDayProvider } from "../../lib/server/fakes/fake-special-days";
import { syncHolidays } from "../../lib/server/services/holiday-sync";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("특일 정보 수집 작업(holidays · holiday_sync_runs)", () => {
  let handle: TestDb;
  let operatorId: string;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  // 2026-11-20 정오(KST) — 기본 수집 연도는 2026·2027
  const clock = fixedClock(Temporal.Instant.from("2026-11-20T03:00:00Z"));

  const readHolidays = async () =>
    (
      await q(
        `SELECT id, date::text AS date, name, kind, source, deleted_at IS NOT NULL AS deleted, updated_at
         FROM holidays ORDER BY date, created_at`,
      )
    ).rows;
  const readRuns = async () =>
    (await q("SELECT year, status, rows_upserted, error_code, source FROM holiday_sync_runs ORDER BY ran_at, year")).rows;

  beforeAll(async () => {
    handle = openTestDb();
    const { rows } = await q(
      "INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES (uuidv7(), $1, '시험 운영자', now()) RETURNING id",
      [`auth-holiday-sync-${randomUUID()}`],
    );
    operatorId = rows[0].id as string;
  });
  beforeEach(async () => {
    await q("DELETE FROM holidays");
    await q("DELETE FROM holiday_sync_runs");
  });
  afterAll(async () => {
    await q("DELETE FROM holidays");
    await q("DELETE FROM holiday_sync_runs");
    // 감사 기록은 추가 전용(트리거가 DELETE 를 막는다) — 운영자 계정은 감사 행이 참조하므로 남겨 둔다
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 가짜 응답으로 새 공휴일 1행이 들어가고 성공 기록이 남는다", async () => {
    const provider = new FakeSpecialDayProvider().respond(2026, { holidays: [fakeHoliday("2026-12-25", "기독탄신일")] });

    const result = await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });

    expect(result.runs).toEqual([{ year: 2026, status: "success", rowsUpserted: 1, errorCode: null }]);
    const rows = await readHolidays();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-12-25", name: "기독탄신일", kind: "holiday", source: "api", deleted: false });
    expect(await readRuns()).toEqual([
      { year: 2026, status: "success", rows_upserted: 1, error_code: null, source: "kasi_special_days" },
    ]);
  });

  test("기본 연도는 올해·다음 해(KST)이고 해마다 기록 1행", async () => {
    const provider = new FakeSpecialDayProvider()
      .respond(2026, { holidays: [fakeHoliday("2026-12-25", "기독탄신일")] })
      .respond(2027, { holidays: [fakeHoliday("2027-01-01", "1월1일"), fakeHoliday("2027-02-09", "대체공휴일(설날)", "substitute_holiday")] });

    const result = await syncHolidays({ db: handle.db, specialDays: provider, clock });

    expect(provider.calls).toEqual([2026, 2027]);
    expect(result.runs.map((r) => [r.year, r.status, r.rowsUpserted])).toEqual([
      [2026, "success", 1],
      [2027, "success", 2],
    ]);
    expect((await readHolidays()).map((r) => [r.date, r.kind])).toEqual([
      ["2026-12-25", "holiday"],
      ["2027-01-01", "holiday"],
      ["2027-02-09", "substitute_holiday"],
    ]);
  });

  describe("② 실패 응답이면 표가 그대로다", () => {
    test.each(["HTTP_ERROR", "RESULT_CODE", "TIMEOUT"] as const)("%s → holidays 불변 + 실패 기록", async (code) => {
      // 앞서 들어 있던 자동 줄과 운영자 줄
      await q("INSERT INTO holidays (id, date, name, kind, source) VALUES (uuidv7(), '2026-10-03', '개천절', 'holiday', 'api')");
      await q(
        `INSERT INTO holidays (id, date, name, kind, source, created_by_account_id)
         VALUES (uuidv7(), '2026-10-05', '학원 임시 휴일', 'temporary_holiday', 'operator', $1)`,
        [operatorId],
      );
      const before = await readHolidays();
      const provider = new FakeSpecialDayProvider().respond(2026, { error: code });

      const result = await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });

      expect(result.runs).toEqual([{ year: 2026, status: "failed", rowsUpserted: 0, errorCode: code }]);
      expect(await readHolidays()).toEqual(before);
      expect(await readRuns()).toEqual([
        { year: 2026, status: "failed", rows_upserted: 0, error_code: code, source: "kasi_special_days" },
      ]);
    });

    test("받은 내용이 이상하면(다른 해 날짜) BAD_RESPONSE — 하나도 넣지 않는다", async () => {
      const before = await readHolidays();
      const provider = new FakeSpecialDayProvider().respond(2026, {
        holidays: [fakeHoliday("2026-12-25", "기독탄신일"), fakeHoliday("2027-01-01", "1월1일")],
      });

      const result = await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });

      expect(result.runs[0]).toMatchObject({ status: "failed", errorCode: "BAD_RESPONSE" });
      expect(await readHolidays()).toEqual(before);
    });

    test("한 해가 실패해도 다른 해는 들어간다", async () => {
      const provider = new FakeSpecialDayProvider()
        .respond(2026, { error: "NETWORK_ERROR" })
        .respond(2027, { holidays: [fakeHoliday("2027-01-01", "1월1일")] });

      const result = await syncHolidays({ db: handle.db, specialDays: provider, clock });

      expect(result.runs.map((r) => [r.year, r.status])).toEqual([
        [2026, "failed"],
        [2027, "success"],
      ]);
      expect((await readHolidays()).map((r) => r.date)).toEqual(["2027-01-01"]);
    });
  });

  test("③ 같은 응답으로 다시 돌리면 표가 늘지 않고 rows_upserted 0 · 이름이 바뀌면 그 줄만 고친다", async () => {
    const provider = new FakeSpecialDayProvider().respond(2026, {
      holidays: [fakeHoliday("2026-06-03", "전국동시지방선거"), fakeHoliday("2026-12-25", "기독탄신일")],
    });
    const deps = { db: handle.db, specialDays: provider, clock };
    await syncHolidays(deps, { years: [2026] });
    const first = await readHolidays();

    const again = await syncHolidays(deps, { years: [2026] });
    expect(again.runs[0]).toMatchObject({ status: "success", rowsUpserted: 0 });
    expect(await readHolidays()).toEqual(first);

    provider.respond(2026, {
      holidays: [fakeHoliday("2026-06-03", "전국동시지방선거", "temporary_holiday"), fakeHoliday("2026-12-25", "기독탄신일")],
    });
    const changed = await syncHolidays(deps, { years: [2026] });
    expect(changed.runs[0]).toMatchObject({ rowsUpserted: 1 });
    const rows = await readHolidays();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.date === "2026-06-03")).toMatchObject({ kind: "temporary_holiday", id: first[0]?.id });
  });

  test("④ 같은 날짜의 운영자 줄은 닫히고 자동 줄이 들어간다 + 감사 1행", async () => {
    const { rows: inserted } = await q(
      `INSERT INTO holidays (id, date, name, kind, source, created_by_account_id)
       VALUES (uuidv7(), '2026-06-03', '선거일(운영자 입력)', 'temporary_holiday', 'operator', $1) RETURNING id`,
      [operatorId],
    );
    const operatorRowId = inserted[0].id as string;
    const provider = new FakeSpecialDayProvider().respond(2026, { holidays: [fakeHoliday("2026-06-03", "전국동시지방선거")] });

    await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });

    const rows = await readHolidays();
    expect(rows.map((r) => [r.source, r.deleted])).toEqual([
      ["operator", true],
      ["api", false],
    ]);
    const audit = await q("SELECT actor_kind, action, before->>'source' AS was FROM audit_logs WHERE target_id = $1", [
      operatorRowId,
    ]);
    expect(audit.rows).toEqual([{ actor_kind: "system", action: "holiday.deleted", was: "operator" }]);
  });

  describe("⑤ 내부 경로 POST /api/internal/jobs/holidays/sync", () => {
    const TOKEN = "test-internal-token-holiday-sync";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/holidays/sync/route");
      return POST(new Request("http://localhost/api/internal/jobs/holidays/sync", { method: "POST", headers, body }), {});
    };

    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
    });

    test("토큰이 없으면 401 이고 수집하지 않는다", async () => {
      const response = await call({});
      expect(response.status).toBe(401);
      expect(await readRuns()).toEqual([]);
    });

    test("토큰이 맞으면 수집이 돌고 해마다 결과를 돌려준다", async () => {
      // 경로는 deps.ts 가 고른 가짜를 쓴다 — 그 가짜에 응답을 넣는다
      const provider = getDeps().specialDays as FakeSpecialDayProvider;
      provider.respond(2030, { holidays: [fakeHoliday("2030-01-01", "1월1일")] });

      const response = await call(
        { "X-Internal-Token": TOKEN, "Content-Type": "application/json" },
        JSON.stringify({ asOf: "2030-03-01T00:00:00Z" }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: { year: number; status: string; rowsUpserted: number }[] };
      expect(body.runs.map((r) => [r.year, r.status, r.rowsUpserted])).toEqual([
        [2030, "success", 1],
        [2031, "success", 0],
      ]);
      expect((await readHolidays()).map((r) => r.date)).toEqual(["2030-01-01"]);
    });
  });
});
