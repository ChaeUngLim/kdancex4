// S0-2.5(시드를 테스트 픽스처로) — 표준 시드가 실제 PostgreSQL 에 제대로 들어가는지 확인한다.
// 확인하는 것: 학원 1·정규 수업 1·8회차·남 6 여 6(회원·자리 묶음 정원), 연달아 두 번 넣어도 늘지 않는 멱등성.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { insertSeedFixtures, SEED_SESSION_COUNT } from "../fixtures/seed-fixtures";
import { closeTestDb, dbAvailable, openTestDb, truncateAll, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("표준 시드 픽스처", () => {
  let handle: TestDb;
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await handle.pool.query(sql, params)).rows[0].n);

  beforeAll(() => {
    handle = openTestDb();
  });
  afterAll(async () => {
    await closeTestDb(handle);
  });
  beforeEach(async () => {
    await truncateAll(handle.pool);
  });

  test("학원 1·정규 수업 1·신청 단위 1이 들어간다", async () => {
    await insertSeedFixtures(handle.pool);
    expect(await count("SELECT count(*) n FROM academies")).toBe(1);
    expect(await count("SELECT count(*) n FROM classes WHERE class_kind = 'regular'")).toBe(1);
    expect(await count("SELECT count(*) n FROM class_offerings WHERE enrollment_unit = 'term'")).toBe(1);
  });

  test("8회차가 seq 1~8 로 들어가고 시간 순서를 지킨다", async () => {
    await insertSeedFixtures(handle.pool);
    const { rows } = await handle.pool.query("SELECT seq FROM class_sessions ORDER BY seq");
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: SEED_SESSION_COUNT }, (_, i) => i + 1));
    // 신청 단위의 기간이 첫 회차 시작 ~ 마지막 회차 끝과 같다.
    const { rows: period } = await handle.pool.query(
      `SELECT o.first_session_starts_at = (SELECT min(starts_at) FROM class_sessions) AS first_ok,
              o.last_session_ends_at = (SELECT max(ends_at) FROM class_sessions) AS last_ok
       FROM class_offerings o`,
    );
    expect(period[0]).toEqual({ first_ok: true, last_ok: true });
  });

  test("남 6·여 6 — 회원 12명과 자리 묶음 정원이 맞는다", async () => {
    await insertSeedFixtures(handle.pool);
    expect(await count("SELECT count(*) n FROM members WHERE gender = 'male'")).toBe(6);
    expect(await count("SELECT count(*) n FROM members WHERE gender = 'female'")).toBe(6);
    const { rows } = await handle.pool.query(
      "SELECT seat_kind, capacity, held_count, confirmed_count FROM seat_pools ORDER BY seat_kind",
    );
    expect(rows).toEqual([
      { seat_kind: "female", capacity: 6, held_count: 0, confirmed_count: 0 },
      { seat_kind: "male", capacity: 6, held_count: 0, confirmed_count: 0 },
    ]);
  });

  test("두 번 넣어도 행이 늘지 않는다(멱등)", async () => {
    await insertSeedFixtures(handle.pool);
    await insertSeedFixtures(handle.pool);
    expect(await count("SELECT count(*) n FROM members")).toBe(12);
    expect(await count("SELECT count(*) n FROM class_sessions")).toBe(SEED_SESSION_COUNT);
    expect(await count("SELECT count(*) n FROM seat_pools")).toBe(2);
  });
});
