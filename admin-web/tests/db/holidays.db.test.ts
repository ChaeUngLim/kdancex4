// S0-4.7(공휴일 표 칸) — holidays 표가 실제 PostgreSQL 에서 규칙을 지키는지 확인한다(data-model §10-13).
// 영업일 계산(S0-4.8)이 이 표 하나만 읽으므로, 같은 날짜가 두 줄이거나 엉뚱한 종류가 들어가면 기한이 조용히 틀어진다.
// 확인하는 것:
//   ① 같은 날짜 중복 거부 — 살아 있는 줄끼리는 한 날짜에 한 줄. 지운 운영자 줄이 있으면 같은 날짜를 다시 넣을 수 있다
//   ② 종류·출처 값 집합 밖 거부 — CHECK 가 막는다
//   ③ 출처 짝 — 운영자 줄은 넣은 계정이 꼭 있고, 자동 줄은 계정이 없으며 지울 수 없다
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("holidays(공휴일 표)", () => {
  let handle: TestDb;
  let operatorId: string;
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

  // 자동 수집 줄 하나를 넣는다(넣은 계정 없음).
  const insertApi = (date: string, kind = "holiday", name = "시험 공휴일") =>
    q(
      `INSERT INTO holidays (id, date, name, kind, source) VALUES (uuidv7(), $1, $2, $3, 'api')`,
      [date, name, kind],
    );

  // 운영자 입력 줄 하나를 넣는다. 지운 줄을 만들 때는 deletedAt 을 준다.
  const insertOperator = (date: string, deletedAt: string | null = null) =>
    q(
      `INSERT INTO holidays (id, date, name, kind, source, created_by_account_id, deleted_at)
       VALUES (uuidv7(), $1, '임시 공휴일', 'temporary_holiday', 'operator', $2, $3)`,
      [date, operatorId, deletedAt],
    );

  beforeAll(async () => {
    handle = openTestDb();
    // 다른 DB 테스트가 표를 비우므로 이 파일이 쓸 운영자 계정을 직접 만든다.
    operatorId = randomUUID();
    await q(
      "INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '시험 운영자', now())",
      [operatorId, `auth-${operatorId}`],
    );
  });
  beforeEach(async () => {
    await q("DELETE FROM holidays");
  });
  afterAll(async () => {
    await q("DELETE FROM holidays");
    await q("DELETE FROM staff_accounts WHERE id = $1", [operatorId]);
    await closeTestDb(handle);
  });

  test("세 종류(공휴일·대체·임시)와 두 출처를 받는다", async () => {
    await insertApi("2030-01-01", "holiday", "신정");
    await insertApi("2030-01-02", "substitute_holiday", "대체 공휴일");
    await insertOperator("2030-01-03");
    const { rows } = await q("SELECT date::text AS date, kind, source FROM holidays ORDER BY date");
    expect(rows).toEqual([
      { date: "2030-01-01", kind: "holiday", source: "api" },
      { date: "2030-01-02", kind: "substitute_holiday", source: "api" },
      { date: "2030-01-03", kind: "temporary_holiday", source: "operator" },
    ]);
  });

  describe("같은 날짜 중복 거부", () => {
    test("자동 줄이 있는 날짜에 자동 줄을 또 넣으면 거부한다", async () => {
      await insertApi("2030-03-01");
      await expectViolation(insertApi("2030-03-01"), "uq_holidays_date");
    });

    test("자동 줄이 있는 날짜에 운영자 줄을 넣어도 거부한다(출처가 달라도 한 날짜 한 줄)", async () => {
      await insertApi("2030-03-01");
      await expectViolation(insertOperator("2030-03-01"), "uq_holidays_date");
    });

    test("지운 운영자 줄이 있는 날짜에는 새 줄을 넣을 수 있다(자동 값이 이기는 경로)", async () => {
      await insertOperator("2030-05-05", "2030-04-01T00:00:00Z");
      await insertApi("2030-05-05", "holiday", "어린이날");
      const { rows } = await q(
        "SELECT source, deleted_at IS NULL AS live FROM holidays WHERE date = '2030-05-05' ORDER BY source",
      );
      expect(rows).toEqual([
        { source: "api", live: true },
        { source: "operator", live: false },
      ]);
    });
  });

  describe("값 집합 밖 거부", () => {
    test("종류가 holiday·substitute_holiday·temporary_holiday 밖이면 거부한다", async () => {
      await expectViolation(insertApi("2030-06-01", "substitute"), "holidays_kind_check");
    });

    test("출처가 api·operator 밖이면 거부한다", async () => {
      await expectViolation(
        q(`INSERT INTO holidays (id, date, name, kind, source) VALUES (uuidv7(), '2030-06-02', 'x', 'holiday', 'manual')`),
        "holidays_source_check",
      );
    });
  });

  describe("출처 짝", () => {
    test("운영자 줄에 넣은 계정이 없으면 거부한다", async () => {
      await expectViolation(
        q(
          `INSERT INTO holidays (id, date, name, kind, source) VALUES (uuidv7(), '2030-07-01', 'x', 'temporary_holiday', 'operator')`,
        ),
        "ck_holidays_operator",
      );
    });

    test("자동 줄에 계정이 붙어 있으면 거부한다", async () => {
      await expectViolation(
        q(
          `INSERT INTO holidays (id, date, name, kind, source, created_by_account_id) VALUES (uuidv7(), '2030-07-02', 'x', 'holiday', 'api', $1)`,
          [operatorId],
        ),
        "ck_holidays_operator",
      );
    });

    test("자동 줄은 지울(deleted_at 을 채울) 수 없다", async () => {
      await insertApi("2030-08-15", "holiday", "광복절");
      await expectViolation(
        q("UPDATE holidays SET deleted_at = now() WHERE date = '2030-08-15'"),
        "ck_holidays_api_not_deleted",
      );
    });
  });
});
