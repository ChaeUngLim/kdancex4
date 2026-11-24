// S1-1.4(사업자 상태 확인·학원 제한 테이블) — 국세청 조회 기록과 학원 제한 두 표가 실제 PostgreSQL 에서
// 설계(data-model §7-3b)대로 지켜지는지 확인한다.
// 확인하는 것:
//   ① business_status_checks — 상태(status)·조회 계기(trigger) 값은 정해진 것만, 학원 없는 기록은 거부
//   ② business_status_checks — 학원별 최근 조회가 ix_bsc_academy_checked 색인으로 찾아진다
//   ③ academy_restrictions — 제한 종류(kind) 값은 정해진 3개만, 끝난 시각은 시작보다 앞설 수 없다
//   ④ academy_restrictions — 같은 종류의 열린 제한은 학원당 하나(uq_restrictions_open), 닫으면 다시 열 수 있다
//   ⑤ academy_restrictions — 「지금 열린 제한」 조회가 uq_restrictions_open 부분 색인으로 찾아진다
// 다른 DB 테스트가 truncateAll 로 표를 비우므로, 이 파일은 자기가 만든 행만 끝나고 지운다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ACADEMY_RESTRICTION_KINDS,
  BUSINESS_CHECK_STATUSES,
  BUSINESS_CHECK_TRIGGERS,
} from "../../lib/domain/constants";
import { ACADEMY_SELLER_COLUMNS, ACADEMY_SELLER_VALUES } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("사업자 상태 확인 기록·학원 제한 표", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);

  // 이 파일이 만든 행 id — 끝나고 이것만 지운다.
  const academy = randomUUID();
  const otherAcademy = randomUUID();
  const operator = randomUUID();

  async function expectViolation(run: Promise<unknown>, constraint: string) {
    const error = await run.then(
      () => null,
      (e: unknown) => e as { constraint?: string; message?: string },
    );
    expect(error, `${constraint} 위반이 나야 하는데 입력이 통과했다`).not.toBeNull();
    expect(error?.constraint ?? error?.message).toContain(constraint);
  }

  // 조회 기록 한 줄. 기본은 매일 점검에서 「계속 사업 중」.
  const insertCheck = async (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      academy_id: academy,
      checked_at: new Date(),
      trigger: "daily",
      business_no: "1234567890",
      status: "active",
      raw_response: JSON.stringify({ b_stt_cd: "01" }),
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO business_status_checks (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => row[k]),
    );
    return result.rows[0].id as string;
  };

  // 제한 한 줄. 기본은 「새 결제 막음」을 지금 연다.
  const insertRestriction = async (overrides: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      academy_id: academy,
      kind: "new_sales_blocked",
      reason: "국세청 조회 결과 휴업",
      ...overrides,
    };
    const cols = Object.keys(row);
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const result = await q(
      `INSERT INTO academy_restrictions (${cols.join(", ")}) VALUES (${marks}) RETURNING id`,
      cols.map((k) => row[k]),
    );
    return result.rows[0].id as string;
  };

  // 색인을 쓰는지 본다. 행이 적으면 플래너가 순차 탐색을 고르므로, 이 연결에서만 순차 탐색을 끄고 계획을 읽는다.
  // 색인이 없으면 seqscan 을 꺼도 순차 탐색 계획이 나오므로 「색인이 있고 이 조회에 맞는다」를 가릴 수 있다.
  const planOf = async (sql: string, params: unknown[]) => {
    const client = await handle.pool.connect();
    try {
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query(`EXPLAIN ${sql}`, params);
      return rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("RESET enable_seqscan");
      client.release();
    }
  };

  beforeAll(async () => {
    handle = openTestDb();
    await q("INSERT INTO staff_accounts (id, auth_user_id, display_name, updated_at) VALUES ($1, $2, '제한 시험 운영자', now())", [
      operator,
      `restriction-tables-${operator}`,
    ]);
    for (const id of [academy, otherAcademy]) {
      await q(
        `INSERT INTO academies (id, name, region_sido, region_gu, updated_at, ${ACADEMY_SELLER_COLUMNS})
         VALUES ($1, '제한 시험 학원', '서울', '마포구', now(), ${ACADEMY_SELLER_VALUES})`,
        [id],
      );
    }
  });

  afterAll(async () => {
    // 외래 키가 Restrict 라 자식부터 지운다: 제한 → 조회 기록 → 학원·계정.
    await q("DELETE FROM academy_restrictions WHERE academy_id = ANY($1)", [[academy, otherAcademy]]);
    await q("DELETE FROM business_status_checks WHERE academy_id = ANY($1)", [[academy, otherAcademy]]);
    await q("DELETE FROM academies WHERE id = ANY($1)", [[academy, otherAcademy]]);
    await q("DELETE FROM staff_accounts WHERE id = $1", [operator]);
    await closeTestDb(handle);
  });

  test("① 조회 기록 — 상태·계기 값 집합 밖은 거부, 집합 안 값은 전부 통과, 학원 없는 기록 거부", async () => {
    // 정해진 값은 전부 들어간다(closed 는 폐업일과 함께).
    for (const status of BUSINESS_CHECK_STATUSES) {
      await insertCheck({ status, closed_on: status === "closed" ? "2026-11-01" : null });
    }
    for (const trigger of BUSINESS_CHECK_TRIGGERS) {
      await insertCheck({ trigger });
    }
    // 집합 밖 상태 — 국세청 코드를 그대로 넣거나(01) 철자가 다르면 DB 가 막는다.
    await expectViolation(insertCheck({ status: "01" }), "business_status_checks_status_check");
    await expectViolation(insertCheck({ status: "inactive" }), "business_status_checks_status_check");
    // 집합 밖 계기.
    await expectViolation(insertCheck({ trigger: "weekly" }), "business_status_checks_trigger_check");
    // 없는 학원의 기록은 외래 키가 막는다.
    await expectViolation(insertCheck({ academy_id: randomUUID() }), "business_status_checks_academy_id_fkey");
    // 원문은 비울 수 없다.
    await expectViolation(insertCheck({ raw_response: null }), "raw_response");
  });

  test("② 학원별 최근 조회 — 가장 늦은 checked_at 이 나오고, ix_bsc_academy_checked 색인으로 찾는다", async () => {
    const base = Date.now();
    await insertCheck({ academy_id: otherAcademy, checked_at: new Date(base - 2 * 3600_000), status: "active" });
    const latest = await insertCheck({ academy_id: otherAcademy, checked_at: new Date(base - 3600_000), status: "suspended" });
    // 다른 학원의 더 늦은 기록은 섞이지 않는다.
    await insertCheck({ academy_id: academy, checked_at: new Date(base) });

    const sql = "SELECT id, status FROM business_status_checks WHERE academy_id = $1 ORDER BY checked_at DESC LIMIT 1";
    const { rows } = await q(sql, [otherAcademy]);
    expect(rows).toEqual([{ id: latest, status: "suspended" }]);

    // 오름차순 색인을 거꾸로 읽어 정렬 없이 첫 행을 꺼낸다(Index Scan Backward).
    const plan = await planOf(sql, [otherAcademy]);
    expect(plan).toContain("ix_bsc_academy_checked");
    expect(plan).not.toContain("Sort");
  });

  test("③ 제한 — 종류 값 집합 밖 거부, 3종은 통과, 끝난 시각이 시작보다 앞서면 거부, 조회 기록 FK", async () => {
    const check = await insertCheck({ status: "closed", closed_on: "2026-11-10" });
    for (const kind of ACADEMY_RESTRICTION_KINDS) {
      await insertRestriction({ academy_id: otherAcademy, kind, source_check_id: check });
    }
    await expectViolation(insertRestriction({ kind: "refund_blocked" }), "academy_restrictions_kind_check");
    // 끝난 시각 < 시작 시각 은 거부.
    await expectViolation(
      insertRestriction({ kind: "payout_hold", started_at: new Date("2026-11-10T00:00:00Z"), ended_at: new Date("2026-11-09T00:00:00Z") }),
      "ck_restrictions_ended_after_started",
    );
    // 없는 조회 기록을 근거로 댈 수 없다.
    await expectViolation(insertRestriction({ kind: "payout_hold", source_check_id: randomUUID() }), "academy_restrictions_source_check_id_fkey");
    // 없는 운영자가 풀 수 없다.
    await expectViolation(
      // 시작·끝 시각을 직접 준다 — JS 시각이 DB now() 보다 조금 앞서면 FK 보다 CHECK 가 먼저 걸린다(1차 실행에서 실측).
      insertRestriction({
        kind: "payout_hold",
        started_at: new Date("2026-11-10T00:00:00Z"),
        ended_at: new Date("2026-11-11T00:00:00Z"),
        ended_by_account_id: randomUUID(),
      }),
      "academy_restrictions_ended_by_account_id_fkey",
    );
    // started_at 은 비우면 서버 시각이 들어간다.
    const { rows } = await q("SELECT started_at, ended_at FROM academy_restrictions WHERE academy_id = $1 AND kind = 'new_sales_blocked'", [otherAcademy]);
    expect(rows[0].started_at).toBeInstanceOf(Date);
    expect(rows[0].ended_at).toBeNull();
  });

  test("④ 같은 종류의 열린 제한은 학원당 하나 — 겹치면 거부, 닫은 뒤에는 다시 연다, 다른 종류·다른 학원은 별개", async () => {
    const first = await insertRestriction({ kind: "payout_hold" });
    // 매일 점검이 같은 휴업을 다시 봐도 두 번째 열린 「지급 보류」는 막힌다.
    await expectViolation(insertRestriction({ kind: "payout_hold" }), "uq_restrictions_open");
    // 다른 종류는 함께 열 수 있다(휴업이면 새 결제 막음 + 지급 보류 두 행).
    await insertRestriction({ kind: "listing_suspended" });
    // 운영자가 닫으면(ended_at 채움) 같은 종류를 다시 열 수 있다 — 닫힌 행은 이력으로 남는다.
    await q("UPDATE academy_restrictions SET ended_at = now(), ended_by_account_id = $2 WHERE id = $1", [first, operator]);
    await insertRestriction({ kind: "payout_hold" });
    const { rows } = await q(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE ended_at IS NULL)::int AS open FROM academy_restrictions WHERE academy_id = $1 AND kind = 'payout_hold'",
      [academy],
    );
    expect(rows[0]).toEqual({ total: 2, open: 1 });
  });

  test("⑤ 열린 제한 조회 — 결제·지급 코드의 「열린 행 있나」 조회가 uq_restrictions_open 부분 색인을 탄다", async () => {
    const sql =
      "SELECT EXISTS (SELECT 1 FROM academy_restrictions WHERE academy_id = $1 AND kind = 'new_sales_blocked' AND ended_at IS NULL) AS blocked";
    // academy 에는 ④에서 연 new_sales_blocked 가 없고(③은 otherAcademy), otherAcademy 에는 있다.
    expect((await q(sql, [academy])).rows[0].blocked).toBe(false);
    expect((await q(sql, [otherAcademy])).rows[0].blocked).toBe(true);
    const plan = await planOf(sql, [otherAcademy]);
    expect(plan).toContain("uq_restrictions_open");

    // 학원의 열린 제한 전체(종류 무관) 조회도 같은 색인의 앞 칸(academy_id)으로 찾는다.
    const allOpen = "SELECT kind FROM academy_restrictions WHERE academy_id = $1 AND ended_at IS NULL";
    const kinds = (await q(allOpen, [otherAcademy])).rows.map((r: { kind: string }) => r.kind).sort();
    expect(kinds).toEqual([...ACADEMY_RESTRICTION_KINDS].sort());
    expect(await planOf(allOpen, [otherAcademy])).toContain("uq_restrictions_open");
  });
});
