// S1-2.2(강사 몫 비율 테이블) — 강사 기본 몫 비율과 수업별 예외 두 표가 data-model §7-5(결정 11)대로
// 실제 PostgreSQL 에 있는지, 판본을 쌓는 방식으로 「바꾼 뒤 결제분부터 새 비율」이 되는지 확인한다.
// 확인하는 것:
//   ① 칸 목록     — 두 표의 칸이 §7-5 목록과 정확히 같다
//   ② ck_share_rate_bp — rate_bp 10001·음수는 거부, 경계값 0·10000 은 받는다(예외 표의 같은 CHECK 도)
//   ③ 유니크      — 같은 소속·같은 시작일 판본은 두 번 못 넣는다(예외 표는 소속·수업·시작일)
//   ④ 판본 찾기   — 비율을 바꾸기 전과 뒤의 결제 2건이 각각 다른 비율을 찾는다
//   ⑤ 수업별 예외 — 예외가 시작된 뒤 결제는 예외 값을, 그 전 결제와 다른 수업은 기본 비율을 찾는다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";

// data-model §7-5 의 칸 목록. 이 목록이 설계 원본과 DB 를 잇는 짝이다.
const DESIGNED_COLUMNS: Record<string, string[]> = {
  instructor_share_rates: ["id", "affiliation_id", "rate_bp", "effective_from", "created_by_account_id", "created_at"],
  instructor_share_rate_overrides: [
    "id",
    "affiliation_id",
    "class_id",
    "rate_bp",
    "effective_from",
    "created_by_account_id",
    "created_at",
  ],
};

// 결제 시각에 맞는 비율을 찾는 조회 — 정산(S5-1)이 쓸 규칙을 그대로 적었다.
// 수업별 예외 중 결제 시각 이전에 시작한 가장 늦은 판본이 있으면 그 값, 없으면 기본 비율의 같은 규칙 판본.
const FIND_RATE_SQL = `
  SELECT COALESCE(
    (SELECT o.rate_bp FROM instructor_share_rate_overrides o
      WHERE o.affiliation_id = $1 AND o.class_id = $2 AND o.effective_from <= $3
      ORDER BY o.effective_from DESC LIMIT 1),
    (SELECT r.rate_bp FROM instructor_share_rates r
      WHERE r.affiliation_id = $1 AND r.effective_from <= $3
      ORDER BY r.effective_from DESC LIMIT 1)
  ) AS rate_bp`;

describe.skipIf(!dbAvailable())("강사 몫 비율 표(instructor_share_rates·instructor_share_rate_overrides)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행의 id — 끝나고 이것만 지운다.
  const academyId = randomUUID();
  const ownerAccount = randomUUID();
  const instructorAccount = randomUUID();
  const affiliationId = randomUUID();
  const classA = randomUUID();
  const classB = randomUUID();

  // 제약 위반이면 PostgreSQL 오류의 constraint 칸에 제약 이름이 담긴다(이름 뒤에 해시가 붙으므로 포함 여부로 본다).
  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  const insertRate = (bp: number, from: string) =>
    q(
      `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
       VALUES (uuidv7(), $1, $2, $3, $4)`,
      [affiliationId, bp, from, ownerAccount],
    );
  const insertOverride = (classId: string, bp: number, from: string) =>
    q(
      `INSERT INTO instructor_share_rate_overrides (id, affiliation_id, class_id, rate_bp, effective_from, created_by_account_id)
       VALUES (uuidv7(), $1, $2, $3, $4, $5)`,
      [affiliationId, classId, bp, from, ownerAccount],
    );
  const findRate = async (classId: string, paidAt: string) =>
    (await q(FIND_RATE_SQL, [affiliationId, classId, paidAt])).rows[0].rate_bp as number | null;

  beforeAll(async () => {
    handle = openTestDb();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS}) VALUES ($1, '몫 비율 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
      [academyId],
    );
    for (const id of [ownerAccount, instructorAccount]) {
      await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 직원', now())", [
        id,
        `share-rate-test-${id}`,
      ]);
    }
    await q(
      `INSERT INTO instructor_affiliations (id, academy_id, instructor_account_id, status, source, updated_at)
       VALUES ($1, $2, $3, 'active', 'application', now())`,
      [affiliationId, academyId, instructorAccount],
    );
    // 수업 A 는 개인 레슨(예외를 걸 수업), 수업 B 는 정규 수업(예외 없음 → 기본 비율).
    for (const [id, kind] of [
      [classA, "private_lesson"],
      [classB, "regular"],
    ]) {
      await q(
        `INSERT INTO classes (id, academy_id, title, instructor_name, genre, class_kind, seat_mode, updated_at)
         VALUES ($1, $2, '시험 수업', '시험 강사', 'salsa_bachata', $3, 'single', now())`,
        [id, academyId, kind],
      );
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 비율 → 수업·소속 → 계정·학원.
    await q("DELETE FROM instructor_share_rate_overrides WHERE affiliation_id = $1", [affiliationId]);
    await q("DELETE FROM instructor_share_rates WHERE affiliation_id = $1", [affiliationId]);
    await q("DELETE FROM classes WHERE academy_id = $1", [academyId]);
    await q("DELETE FROM instructor_affiliations WHERE id = $1", [affiliationId]);
    await q("DELETE FROM staff_accounts WHERE id = ANY($1)", [[ownerAccount, instructorAccount]]);
    await q("DELETE FROM academies WHERE id = $1", [academyId]);
    await closeTestDb(handle);
  });

  test("① 두 표의 칸이 data-model §7-5 목록과 정확히 같다", async () => {
    const { rows } = await q(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [Object.keys(DESIGNED_COLUMNS)],
    );
    for (const [table, designed] of Object.entries(DESIGNED_COLUMNS)) {
      const actual = rows.filter((r) => r.table_name === table).map((r) => r.column_name as string);
      expect(actual.sort(), `${table} 칸 목록`).toEqual([...designed].sort());
    }
  });

  test("② ck_share_rate_bp — rate_bp 10001 은 거부한다", async () => {
    await expectViolation(insertRate(10001, "2030-01-01T00:00:00Z"), "ck_share_rate_bp");
  });

  test("② ck_share_rate_bp — rate_bp 음수는 거부한다", async () => {
    await expectViolation(insertRate(-1, "2030-01-02T00:00:00Z"), "ck_share_rate_bp");
  });

  test("② 예외 표도 rate_bp 10001 은 거부한다(ck_share_override_bp)", async () => {
    await expectViolation(insertOverride(classA, 10001, "2030-01-01T00:00:00Z"), "ck_share_override_bp");
  });

  test("② 경계값 0 과 10000 은 받는다", async () => {
    await insertRate(0, "2020-01-01T00:00:00Z");
    await insertRate(10000, "2020-01-02T00:00:00Z");
    await insertOverride(classB, 10000, "2020-01-01T00:00:00Z");
    // 다음 시험에 섞이지 않게 바로 지운다.
    await q("DELETE FROM instructor_share_rates WHERE affiliation_id = $1", [affiliationId]);
    await q("DELETE FROM instructor_share_rate_overrides WHERE affiliation_id = $1", [affiliationId]);
  });

  test("③ 같은 소속·같은 시작일 판본은 두 번 못 넣는다", async () => {
    await insertRate(6000, "2026-12-01T00:00:00Z");
    await expectViolation(insertRate(7000, "2026-12-01T00:00:00Z"), "uq_share_rates_aff_from");
    await insertOverride(classA, 8000, "2027-02-01T00:00:00Z");
    await expectViolation(insertOverride(classA, 9000, "2027-02-01T00:00:00Z"), "uq_share_overrides");
  });

  test("④ 비율을 바꾸기 전후 결제 2건이 다른 비율을 찾는다", async () => {
    // ③ 이 넣은 60%(12-01 시작)에 이어, 대표가 2027-01-01 부터 70% 로 바꾼다 — 고치지 않고 새 판본을 쌓는다.
    await insertRate(7000, "2027-01-01T00:00:00Z");
    const beforeChange = await findRate(classB, "2026-12-15T10:00:00Z");
    const afterChange = await findRate(classB, "2027-01-15T10:00:00Z");
    expect(beforeChange).toBe(6000);
    expect(afterChange).toBe(7000);
    // 옛 판본은 그대로 남아 있다(이미 계산한 지급액이 바뀌지 않는 근거).
    const { rows } = await q(
      "SELECT rate_bp FROM instructor_share_rates WHERE affiliation_id = $1 ORDER BY effective_from",
      [affiliationId],
    );
    expect(rows.map((r) => r.rate_bp)).toEqual([6000, 7000]);
  });

  test("④ 첫 판본 시작 전 결제는 비율을 찾지 못한다(기본값 없음)", async () => {
    expect(await findRate(classB, "2026-11-01T00:00:00Z")).toBeNull();
  });

  test("⑤ 수업별 예외는 시작된 뒤 결제에만, 그 수업에만 적용된다", async () => {
    // ③ 이 수업 A 에 2027-02-01 부터 80% 예외를 넣었다.
    expect(await findRate(classA, "2027-01-20T00:00:00Z")).toBe(7000); // 예외 시작 전 → 기본 비율
    expect(await findRate(classA, "2027-02-10T00:00:00Z")).toBe(8000); // 예외 시작 뒤 → 예외 값
    expect(await findRate(classB, "2027-02-10T00:00:00Z")).toBe(7000); // 다른 수업 → 기본 비율
  });

  test("없는 소속·수업을 가리키는 행은 외래 키가 막는다", async () => {
    await expectViolation(
      q(
        `INSERT INTO instructor_share_rates (id, affiliation_id, rate_bp, effective_from, created_by_account_id)
         VALUES (uuidv7(), $1, 5000, now(), $2)`,
        [randomUUID(), ownerAccount],
      ),
      "instructor_share_rates_affiliation_id_fkey",
    );
    await expectViolation(insertOverride(randomUUID(), 5000, "2028-01-01T00:00:00Z"), "instructor_share_rate_overrides_class_id_fkey");
  });
});
