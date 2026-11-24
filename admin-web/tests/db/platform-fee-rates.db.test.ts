// S0-2.6(플랫폼 수수료율 표 칸과 시드) — platform_fee_rates 표가 실제 PostgreSQL 에서 요율을 지키는지 확인한다.
// 확인하는 것:
//   ① 시드  — 마이그레이션이 일반 500bp(면제 적용)·개인 레슨 100bp(면제 미적용) 두 행을 넣어 둔다(결정 12·13)
//   ② CHECK — rate_bp 가 0~10000 밖이면 DB 가 막는다
//   ③ 유니크 — 같은 (분류, 시작일) 행은 두 번 못 넣고, 시작일이 다르면 넣을 수 있다
// 다른 DB 테스트가 truncateAll 로 모든 표를 비우므로, 시드 행은 「마이그레이션이 가진 시드 SQL(ops.json)」을 그대로 다시 실행해 되살린다.
// 그래서 마이그레이션의 시드 문장이 틀리면 이 테스트가 잡는다. 시험 행은 끝나면 직접 지운다.
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("platform_fee_rates(수수료율 표)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  const insertRate = (category: string, bp: number, from: string) =>
    q(
      `INSERT INTO platform_fee_rates (id, fee_category, rate_bp, onboarding_exemption_applies, effective_from)
       VALUES (uuidv7(), $1, $2, false, $3)`,
      [category, bp, from],
    );

  // 마이그레이션 폴더에서 시드 연산(seed.platform_fee_rates)의 실행 SQL 을 꺼낸다.
  function seedSqlFromMigration(): string[] {
    const dir = new URL("../../migrations/app/20261120T0143_platform_fee_rates/ops.json", import.meta.url);
    const ops = JSON.parse(readFileSync(dir, "utf8")) as { id: string; execute: { sql: string }[] }[];
    const seed = ops.find((op) => op.id === "seed.platform_fee_rates");
    expect(seed, "마이그레이션에 시드 연산이 있어야 한다").toBeDefined();
    return seed!.execute.map((step) => step.sql);
  }

  beforeAll(async () => {
    handle = openTestDb();
    await q("DELETE FROM platform_fee_rates");
    for (const sql of seedSqlFromMigration()) await q(sql);
  });
  afterAll(async () => {
    // 시험 중 넣은 행(시작일이 2030 년 이후)만 지운다. 시드 행은 남긴다.
    await q("DELETE FROM platform_fee_rates WHERE effective_from >= '2030-01-01'");
    await closeTestDb(handle);
  });

  test("시드: 일반 수업·행사는 500bp 이고 입점 면제가 적용된다", async () => {
    const { rows } = await q(
      "SELECT rate_bp, onboarding_exemption_applies FROM platform_fee_rates WHERE fee_category = 'general'",
    );
    expect(rows).toEqual([{ rate_bp: 500, onboarding_exemption_applies: true }]);
  });

  test("시드: 개인 레슨은 100bp 이고 입점 면제가 적용되지 않는다", async () => {
    const { rows } = await q(
      "SELECT rate_bp, onboarding_exemption_applies FROM platform_fee_rates WHERE fee_category = 'private_lesson'",
    );
    expect(rows).toEqual([{ rate_bp: 100, onboarding_exemption_applies: false }]);
  });

  test("rate_bp 10001 은 거부한다", async () => {
    await expectViolation(insertRate("general", 10001, "2030-01-01T00:00:00Z"), "ck_platform_fee_bp");
  });

  test("rate_bp 음수는 거부한다", async () => {
    await expectViolation(insertRate("general", -1, "2030-01-02T00:00:00Z"), "ck_platform_fee_bp");
  });

  test("rate_bp 경계값 0 과 10000 은 받는다", async () => {
    await insertRate("general", 0, "2030-02-01T00:00:00Z");
    await insertRate("general", 10000, "2030-02-02T00:00:00Z");
  });

  test("같은 (분류, 시작일) 은 두 번 못 넣는다", async () => {
    await insertRate("private_lesson", 150, "2030-03-01T00:00:00Z");
    await expectViolation(insertRate("private_lesson", 200, "2030-03-01T00:00:00Z"), "uq_platform_fee");
  });

  test("분류가 다르거나 시작일이 다르면 같은 날짜 행을 더 넣을 수 있다", async () => {
    await insertRate("general", 300, "2030-03-01T00:00:00Z");
    await insertRate("private_lesson", 150, "2030-03-02T00:00:00Z");
  });

  test("정해진 분류 밖의 값은 거부한다", async () => {
    await expectViolation(insertRate("other", 100, "2030-04-01T00:00:00Z"), "platform_fee_rates_fee_category_check");
  });
});
