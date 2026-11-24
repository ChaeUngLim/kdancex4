// S1-1.27(사업자 상태 점검 작업) — 매일 1회 + 정산 직전 점검이 실제 PostgreSQL 에서 규칙대로 도는지 확인한다(data-model §7-3b).
// 바깥 API 대신 가짜 조회(FakeBusinessStatusProvider)를 쓴다. 실 어댑터는 S1-1.30 이 같은 포트로 붙인다.
// 확인하는 것:
//   ① 폐업 응답이면 확인 기록 1행이 쌓이고, 학원의 「마지막 확인 결과」가 closed 로 바뀐다
//      — 두 테이블 모두 「감사 ○」라 같은 트랜잭션에서 감사 기록이 테이블마다 1행씩 남는다(수행자 system)
//   ② 오류 응답이면 확인 기록 1행(status error)만 남고 조치는 0 — 학원 칸 그대로 · 제한 0행
//      — 감사는 확인 기록 1행분만 있고 학원 감사 행은 없다
//   ③ 호출 전체가 실패해도(failAll) 학원마다 error 기록 1행씩, 학원 칸은 하나도 안 바뀐다
//   ④ 같은 날 매일 점검을 다시 돌리면 이미 결과를 받은 학원은 건너뛴다(멱등) — error 였던 학원만 다시 본다
//   ⑤ 정산 직전 점검(pre_payout)은 고른 학원만, 같은 날 매일 점검이 있어도 새로 조회한다
//   ⑥ 해지된 학원(terminated)은 매일 점검 대상이 아니다 · 100개가 넘으면 나눠 부른다
//   ⑦ 내부 경로: 토큰 없으면 401, 맞으면 매일 점검이 돈다
// 다른 DB 테스트가 남긴 학원이 있을 수 있어, 단언은 이 파일이 만든 학원에만 한다.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { fixedClock } from "../../lib/domain/time";
import { getDeps } from "../../lib/server/deps";
import { FakeBusinessStatusProvider } from "../../lib/server/fakes/fake-business-status";
import { runBusinessStatusCheck } from "../../lib/server/services/business-status-check";
import { ACADEMY_SELLER_COLUMNS } from "../fixtures/academy-seller";
import { closeTestDb, dbAvailable, openTestDb, type TestDb } from "../setup/db";

describe.skipIf(!dbAvailable())("사업자 상태 점검 작업(business_status_checks)", () => {
  let handle: TestDb;
  const q = (text: string, params: unknown[] = []) => handle.pool.query(text, params);
  // 2026-11-21 03:10 KST(= 11-20 18:10Z) — 매일 점검이 도는 시각
  const clock = fixedClock(Temporal.Instant.from("2026-11-20T18:10:00Z"));
  // 이 파일이 만든 학원 id — 끝나고 이것만 지운다
  const created: string[] = [];

  /** 학원 한 곳을 만든다. 사업자등록번호와 상태를 고를 수 있다 */
  const insertAcademy = async (businessNo: string, options: { status?: string; businessStatus?: string } = {}) => {
    const id = randomUUID();
    await q(
      `INSERT INTO academies (id, name, region_sido, region_gu, status, business_status, business_status_checked_at, updated_at,
                              ${ACADEMY_SELLER_COLUMNS})
       VALUES ($1, '점검 시험 학원', '서울', '마포구', $2, $3, $4, now(),
               'academy', '테스트 상호', '테스트 대표', $5, '서울 마포구 테스트로 1', '02-000-0000', now())`,
      [
        id,
        options.status ?? "active",
        options.businessStatus ?? null,
        options.businessStatus ? "2026-11-19T18:10:00Z" : null,
        businessNo,
      ],
    );
    created.push(id);
    return id;
  };

  const readChecks = async (academyId: string) =>
    (
      await q(
        `SELECT trigger, business_no, status, closed_on::text AS closed_on, tax_type, raw_response, checked_at
         FROM business_status_checks WHERE academy_id = $1 ORDER BY checked_at, id`,
        [academyId],
      )
    ).rows;
  const readAcademy = async (academyId: string) =>
    (await q("SELECT business_status, business_status_checked_at FROM academies WHERE id = $1", [academyId])).rows[0];
  // 감사 기록은 지울 수 없어(추가 전용 트리거) 학원 id 로 걸러 읽는다 — 학원 id 는 테스트마다 새로 만든다
  const readAudits = async (academyId: string) =>
    (
      await q(
        `SELECT actor_kind, actor_staff_account_id, actor_member_id, action, target_table, target_id, before, after
         FROM audit_logs WHERE academy_id = $1 ORDER BY occurred_at, id`,
        [academyId],
      )
    ).rows;
  const readCheckIds = async (academyId: string) =>
    (await q("SELECT id FROM business_status_checks WHERE academy_id = $1 ORDER BY checked_at, id", [academyId])).rows.map(
      (r) => r.id as string,
    );
  const countRestrictions = async (academyId: string) =>
    Number((await q("SELECT count(*) AS n FROM academy_restrictions WHERE academy_id = $1", [academyId])).rows[0].n);

  const cleanup = async () => {
    if (created.length === 0) return;
    await q("DELETE FROM academy_restrictions WHERE academy_id = ANY($1::uuid[])", [created]);
    // S1-1.29 부터 점검이 이용 제한 절차도 연다 — 제한 행(source_case_id) 다음, 확인 기록(source_check_id) 앞에 지운다
    await q("DELETE FROM restriction_cases WHERE subject_academy_id = ANY($1::uuid[])", [created]);
    await q("DELETE FROM business_status_checks WHERE academy_id = ANY($1::uuid[])", [created]);
    await q("DELETE FROM academies WHERE id = ANY($1::uuid[])", [created]);
    created.length = 0;
  };

  beforeAll(() => {
    handle = openTestDb();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeTestDb(handle);
    const shared = await import("../../prisma/db");
    await shared.pool.end();
  });

  test("① 폐업 응답이면 확인 기록 1행이 쌓이고 학원의 마지막 확인 결과가 closed 가 된다", async () => {
    const academy = await insertAcademy("2208100001", { businessStatus: "active" });
    const provider = new FakeBusinessStatusProvider().respond("2208100001", { status: "closed", closedOn: "2026-11-10" });

    const result = await runBusinessStatusCheck(
      { db: handle.db, businessStatus: provider, clock },
      { trigger: "daily", academyIds: [academy] },
    );

    expect(result).toMatchObject({ trigger: "daily", processed: 1, recorded: 1, skipped: 0 });
    expect(result.byStatus.closed).toBe(1);
    const checks = await readChecks(academy);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      trigger: "daily",
      business_no: "2208100001",
      status: "closed",
      closed_on: "2026-11-10",
      tax_type: "부가가치세 일반과세자",
    });
    // 원문은 국세청 응답 모양 그대로 보관한다
    expect(checks[0].raw_response).toMatchObject({ b_no: "2208100001", b_stt_cd: "03", end_dt: "20261110" });
    expect(new Date(checks[0].checked_at as string).toISOString()).toBe("2026-11-20T18:10:00.000Z");
    const row = await readAcademy(academy);
    expect(row.business_status).toBe("closed");
    expect(new Date(row.business_status_checked_at as string).toISOString()).toBe("2026-11-20T18:10:00.000Z");

    // 감사: 확인 기록 1행 + 학원 칸 변경 1행. 수행자는 시스템이라 직원·회원 id 가 비어 있다.
    // 폐업이라 S1-1.28 이 같은 트랜잭션에서 제한 2행을 열어 감사가 2행 더 붙고, S1-1.29 부터는 이용 제한 절차 1건의
    // restriction.opened 도 붙는다(그 내용은 business-closure-restrictions·business-check-listing-suspension 이 본다)
    const [checkId] = await readCheckIds(academy);
    const audits = await readAudits(academy);
    expect(audits).toHaveLength(5);
    // 같은 트랜잭션 안의 세 행이라 순서는 보지 않는다
    expect(audits.slice(2).map((a) => a.action).sort()).toEqual(["academy_restriction.opened", "academy_restriction.opened", "restriction.opened"]);
    expect(audits[0]).toMatchObject({
      actor_kind: "system",
      actor_staff_account_id: null,
      actor_member_id: null,
      action: "business_status.checked",
      target_table: "business_status_checks",
      target_id: checkId,
      before: null,
      after: { status: "closed", trigger: "daily", business_no: "2208100001" },
    });
    expect(audits[1]).toMatchObject({
      actor_kind: "system",
      action: "academy.business_status_updated",
      target_table: "academies",
      target_id: academy,
      before: { business_status: "active" },
      after: { business_status: "closed", business_status_checked_at: "2026-11-20T18:10:00Z" },
    });
    expect(audits[1].before.business_status_checked_at).not.toBeNull();
  });

  test("② 오류 응답이면 기록 1행(error)만 남고 조치는 0 — 학원 칸 그대로 · 제한 0행", async () => {
    const academy = await insertAcademy("2208100002", { businessStatus: "active" });
    const before = await readAcademy(academy);
    const provider = new FakeBusinessStatusProvider().respond("2208100002", { status: "error", errorCode: "TIMEOUT" });

    const result = await runBusinessStatusCheck(
      { db: handle.db, businessStatus: provider, clock },
      { trigger: "daily", academyIds: [academy] },
    );

    expect(result).toMatchObject({ processed: 1, recorded: 1 });
    expect(result.byStatus.error).toBe(1);
    const checks = await readChecks(academy);
    expect(checks.map((c) => [c.status, c.closed_on, c.tax_type])).toEqual([["error", null, null]]);
    expect(checks[0].raw_response).toMatchObject({ error_code: "TIMEOUT" });
    // 조회 실패를 폐업으로 보지 않는다 — 마지막 확인 결과(active)와 그 시각이 그대로다
    expect(await readAcademy(academy)).toEqual(before);
    expect(await countRestrictions(academy)).toBe(0);
    // 감사: 확인 기록 1행분만 있다. 학원 칸을 안 바꿨으니 academies 감사 행은 없다
    const [checkId] = await readCheckIds(academy);
    expect(await readAudits(academy)).toEqual([
      {
        actor_kind: "system",
        actor_staff_account_id: null,
        actor_member_id: null,
        action: "business_status.checked",
        target_table: "business_status_checks",
        target_id: checkId,
        before: null,
        after: { status: "error", trigger: "daily", business_no: "2208100002" },
      },
    ]);
  });

  test("③ 호출 전체가 실패해도 학원마다 error 1행씩 · 학원 칸은 하나도 안 바뀐다", async () => {
    const a = await insertAcademy("2208100003", { businessStatus: "active" });
    const b = await insertAcademy("2208100004", { businessStatus: "suspended" });
    const beforeA = await readAcademy(a);
    const beforeB = await readAcademy(b);
    const provider = new FakeBusinessStatusProvider().failAll("HTTP_ERROR");

    const result = await runBusinessStatusCheck(
      { db: handle.db, businessStatus: provider, clock },
      { trigger: "daily", academyIds: [a, b] },
    );

    expect(result).toMatchObject({ processed: 2, recorded: 2 });
    expect(result.byStatus.error).toBe(2);
    expect((await readChecks(a)).map((c) => c.status)).toEqual(["error"]);
    expect((await readChecks(b)).map((c) => c.status)).toEqual(["error"]);
    expect(await readAcademy(a)).toEqual(beforeA);
    expect(await readAcademy(b)).toEqual(beforeB);
    expect((await countRestrictions(a)) + (await countRestrictions(b))).toBe(0);
  });

  test("포트가 예외를 던져도 조회 실패(error)로 기록하고 작업은 끝난다", async () => {
    const academy = await insertAcademy("2208100005", { businessStatus: "active" });
    const before = await readAcademy(academy);
    const throwing = {
      checkStatuses: async () => {
        throw new Error("예상 못 한 오류");
      },
    };

    const result = await runBusinessStatusCheck(
      { db: handle.db, businessStatus: throwing, clock },
      { trigger: "daily", academyIds: [academy] },
    );

    expect(result.byStatus.error).toBe(1);
    const checks = await readChecks(academy);
    expect(checks.map((c) => c.status)).toEqual(["error"]);
    expect(checks[0].raw_response).toMatchObject({ error_code: "UNEXPECTED_ERROR" });
    expect(await readAcademy(academy)).toEqual(before);
  });

  test("④ 같은 날 매일 점검을 다시 돌리면 결과를 받은 학원은 건너뛰고 error 였던 학원만 다시 본다", async () => {
    const ok = await insertAcademy("2208100006");
    const failed = await insertAcademy("2208100007");
    const provider = new FakeBusinessStatusProvider()
      .respond("2208100006", "active")
      .respond("2208100007", { status: "error", errorCode: "NETWORK_ERROR" });
    const deps = { db: handle.db, businessStatus: provider, clock };

    await runBusinessStatusCheck(deps, { trigger: "daily", academyIds: [ok, failed] });
    // 두 번째 회차 — 같은 KST 날짜(03:40). error 였던 학원은 이번에 계속 사업자로 나온다
    provider.respond("2208100007", "active");
    const again = await runBusinessStatusCheck(
      { ...deps, clock: fixedClock(Temporal.Instant.from("2026-11-20T18:40:00Z")) },
      { trigger: "daily", academyIds: [ok, failed] },
    );

    expect(again).toMatchObject({ processed: 1, recorded: 1, skipped: 1 });
    expect(provider.calls.map((batch) => [...batch].sort())).toEqual([["2208100006", "2208100007"], ["2208100007"]]);
    expect((await readChecks(ok)).map((c) => c.status)).toEqual(["active"]);
    expect((await readChecks(failed)).map((c) => c.status)).toEqual(["error", "active"]);
    expect((await readAcademy(failed)).business_status).toBe("active");

    // 다음 날(KST)이면 다시 조회한다
    const nextDay = await runBusinessStatusCheck(
      { ...deps, clock: fixedClock(Temporal.Instant.from("2026-11-21T18:10:00Z")) },
      { trigger: "daily", academyIds: [ok, failed] },
    );
    expect(nextDay).toMatchObject({ processed: 2, skipped: 0 });
  });

  test("⑤ 정산 직전 점검은 고른 학원만, 같은 날 매일 점검이 있어도 새로 조회한다", async () => {
    const payee = await insertAcademy("2208100008");
    const other = await insertAcademy("2208100009");
    const provider = new FakeBusinessStatusProvider().respond("2208100008", "active").respond("2208100009", "active");
    const deps = { db: handle.db, businessStatus: provider, clock };
    await runBusinessStatusCheck(deps, { trigger: "daily", academyIds: [payee, other] });

    provider.respond("2208100008", "suspended");
    const result = await runBusinessStatusCheck(
      { ...deps, clock: fixedClock(Temporal.Instant.from("2026-11-20T19:00:00Z")) },
      { trigger: "pre_payout", academyIds: [payee] },
    );

    expect(result).toMatchObject({ trigger: "pre_payout", processed: 1, recorded: 1, skipped: 0 });
    expect((await readChecks(payee)).map((c) => [c.trigger, c.status])).toEqual([
      ["daily", "active"],
      ["pre_payout", "suspended"],
    ]);
    expect((await readChecks(other)).map((c) => c.trigger)).toEqual(["daily"]);
    expect((await readAcademy(payee)).business_status).toBe("suspended");
  });

  test("정산 직전 점검에 학원 목록이 없으면 거부한다", async () => {
    const provider = new FakeBusinessStatusProvider();
    await expect(
      runBusinessStatusCheck({ db: handle.db, businessStatus: provider, clock }, { trigger: "pre_payout" }),
    ).rejects.toThrow(RangeError);
    expect(provider.calls).toEqual([]);
  });

  test("⑥ 해지된 학원은 대상이 아니고, 100개가 넘으면 100개씩 나눠 부른다", async () => {
    const terminated = await insertAcademy("2208100010", { status: "terminated" });
    const many: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      many.push(await insertAcademy(`33${String(i).padStart(8, "0")}`));
    }
    const provider = new FakeBusinessStatusProvider();

    const result = await runBusinessStatusCheck(
      { db: handle.db, businessStatus: provider, clock },
      { trigger: "daily", academyIds: [terminated, ...many] },
    );

    expect(result).toMatchObject({ processed: 101, recorded: 101 });
    expect(provider.calls.map((batch) => batch.length)).toEqual([100, 1]);
    expect(provider.calls.flat()).not.toContain("2208100010");
    expect(await readChecks(terminated)).toEqual([]);
    // 골라 두지 않은 번호는 가짜가 미등록(not_found)으로 돌려준다 — 미등록도 확인 결과라 학원 칸에 남긴다
    expect(result.byStatus.not_found).toBe(101);
    expect((await readAcademy(many[0] as string)).business_status).toBe("not_found");
  });

  describe("⑦ 내부 경로 POST /api/internal/jobs/business-status/check", () => {
    const TOKEN = "test-internal-token-business-status";
    const call = async (headers: Record<string, string>, body = "{}") => {
      const { POST } = await import("../../app/api/internal/jobs/business-status/check/route");
      return POST(
        new Request("http://localhost/api/internal/jobs/business-status/check", { method: "POST", headers, body }),
        {},
      );
    };

    beforeAll(() => {
      process.env["INTERNAL_API_TOKEN"] = TOKEN;
      process.env["KDANCE_DEV_ROUTES"] = "true";
    });
    afterAll(() => {
      delete process.env["INTERNAL_API_TOKEN"];
      delete process.env["KDANCE_DEV_ROUTES"];
    });

    test("토큰이 없으면 401 이고 점검하지 않는다", async () => {
      const academy = await insertAcademy("2208100011");
      const response = await call({});
      expect(response.status).toBe(401);
      expect(await readChecks(academy)).toEqual([]);
    });

    test("토큰이 맞으면 매일 점검이 돌아 학원마다 기록이 쌓인다", async () => {
      const closed = await insertAcademy("2208100012", { businessStatus: "active" });
      const failed = await insertAcademy("2208100013", { businessStatus: "active" });
      // 경로는 deps.ts 가 고른 가짜를 쓴다 — 그 가짜에 응답을 넣는다
      const provider = getDeps().businessStatus as FakeBusinessStatusProvider;
      provider.respond("2208100012", "closed").respond("2208100013", { status: "error" });

      const response = await call(
        { "X-Internal-Token": TOKEN, "Content-Type": "application/json" },
        JSON.stringify({ asOf: "2026-11-20T18:10:00Z" }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { trigger: string; processed: number; recorded: number };
      expect(body.trigger).toBe("daily");
      expect(body.recorded).toBeGreaterThanOrEqual(2);
      expect((await readChecks(closed)).map((c) => [c.trigger, c.status])).toEqual([["daily", "closed"]]);
      expect((await readChecks(failed)).map((c) => [c.trigger, c.status])).toEqual([["daily", "error"]]);
      expect((await readAcademy(closed)).business_status).toBe("closed");
      expect((await readAcademy(failed)).business_status).toBe("active");
      // 폐업은 제한 2행이 열리고(S1-1.28), 조회 실패는 조치하지 않는다
      expect(await countRestrictions(closed)).toBe(2);
      expect(await countRestrictions(failed)).toBe(0);
    });

    test("본문에 정산 직전 같은 다른 계기를 넣으면 422 — 경로는 매일 점검만 한다", async () => {
      const response = await call(
        { "X-Internal-Token": TOKEN, "Content-Type": "application/json" },
        JSON.stringify({ trigger: "pre_payout" }),
      );
      expect(response.status).toBe(422);
    });
  });
});
