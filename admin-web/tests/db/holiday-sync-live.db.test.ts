// S0-4.11(특일 정보 실 어댑터) — 실제 API 한 해치가 holidays 표에 들어가는지 확인한다(로드맵 목표 「실제 API 로 한 해치를 받아 표에 들어간다」).
// 인증키가 없거나 테스트 DB 가 없으면 건너뛴다. 규칙 시험은 가짜로 holiday-sync.db.test.ts 가 이미 한다 — 여기서는 실호출 1회만.
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { KasiSpecialDayProvider } from "../../lib/server/adapters/kasi-special-days";
import { syncHolidays } from "../../lib/server/services/holiday-sync";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { findPublicDataHolidayKey } from "../setup/public-data-key";

const liveKey = findPublicDataHolidayKey();

describe.skipIf(!dbAvailable() || liveKey === undefined)("실 어댑터 → holidays 표(2026 한 해치)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  const clock = fixedClock(Temporal.Instant.from("2026-11-20T03:00:00Z"));

  beforeAll(async () => {
    handle = openTestDb();
    await q("DELETE FROM holidays");
    await q("DELETE FROM holiday_sync_runs");
  });
  afterAll(async () => {
    await q("DELETE FROM holidays");
    await q("DELETE FROM holiday_sync_runs");
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("실호출 결과가 그대로 표에 들어가고 성공 기록이 남는다", { timeout: 30_000 }, async () => {
    const provider = new KasiSpecialDayProvider({ serviceKey: liveKey });
    const result = await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });

    const { rows } = await q("SELECT date::text AS date, name, kind, source FROM holidays ORDER BY date");
    console.info(`[S0-4.11 실호출→표] 2026 holidays ${rows.length}행 · run=${JSON.stringify(result.runs)}`);
    expect(result.runs).toEqual([{ year: 2026, status: "success", rowsUpserted: rows.length, errorCode: null }]);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(rows.every((r) => r.source === "api")).toBe(true);
    expect(rows.map((r) => r.date)).toEqual(expect.arrayContaining(["2026-01-01", "2026-12-25"]));

    // 다시 돌려도 바뀌는 줄이 없다(멱등)
    const again = await syncHolidays({ db: handle.db, specialDays: provider, clock }, { years: [2026] });
    expect(again.runs[0]).toMatchObject({ status: "success", rowsUpserted: 0 });
  });
});
