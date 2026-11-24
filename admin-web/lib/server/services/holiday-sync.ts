// S0-4.10(특일 정보 수집 작업) — 하루 한 번 공휴일을 받아 holidays 표에 넣는다.
//   정의: _workspace/03_data-model.md §10-13(holidays · holiday_sync_runs) · 입력 조사: 03_research.md §3-2
//   경로: POST /api/internal/jobs/holidays/sync(계약 13-settlement.md 「시간 작업」 표)
//
// 왜 이런 작업이 있나: 영업일 계산(S0-4.8)은 요청마다 API 를 부르지 않고 holidays 표만 읽는다(Q35(정산일이 주말·공휴일일 때)).
// 그래서 표를 채우는 일을 따로 하루 한 번 돌린다. 올해와 다음 해 두 해치를 받는다 — 공휴일은 2년 뒤 해까지
// 미리 올라오고, 임시공휴일은 하루 안에 반영되기 때문이다(research §3-2).
//
// 규칙 셋:
//   1. 한 해치는 **한 트랜잭션**이다. 받은 목록을 다 넣거나, 하나도 안 넣는다
//   2. 받기에 실패하면(또는 받은 내용이 이상하면) holidays 는 **건드리지 않고** holiday_sync_runs 에 실패 줄만 남긴다.
//      이 실패 줄이 운영자가 보는 기록이다(P9 상단 「마지막 자동 수집 … 실패」)
//   3. 같은 날짜에 자동 값이 들어오면 자동 값이 이긴다(data-model §10-13, 임시 확정). 운영자 줄은 지우지 않고
//      deleted_at 으로 닫은 뒤 자동 줄을 넣는다 — 운영자 줄은 감사 대상이라 감사 기록 1행도 같이 쓴다
//   이미 같은 값으로 들어 있는 날은 고치지 않는다. 그래서 하루에 몇 번을 돌려도 결과가 같다(멱등).
import { z } from "zod";

import { HOLIDAY_KINDS } from "../../domain/constants";
import { kstToday, type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import {
  SpecialDayProviderError,
  type SpecialDayHoliday,
  type SpecialDayProviderPort,
} from "../ports/special-days";

/** 수집 결과 한 해치. 경로 응답과 테스트가 읽는다 */
export interface HolidaySyncYearResult {
  readonly year: number;
  readonly status: "success" | "failed";
  readonly rowsUpserted: number;
  readonly errorCode: string | null;
}

export interface HolidaySyncDeps {
  readonly db: Db;
  readonly specialDays: SpecialDayProviderPort;
  readonly clock: Clock;
}

/** 출처가 던진 오류가 SpecialDayProviderError 가 아닐 때 / 표에 넣다가 DB 가 실패했을 때 */
const UNEXPECTED_ERROR = "UNEXPECTED_ERROR";
const DB_ERROR = "DB_ERROR";

/** 운영자 줄을 자동 줄로 바꿀 때 감사 기록에 남기는 까닭 */
const REPLACED_BY_API_REASON = "자동 수집(특일 정보)이 같은 날짜를 공휴일로 받아 운영자 입력 줄을 닫았다";

// 어댑터가 준 목록을 한 번 더 검사한다. 이상한 값이 표에 들어가면 영업일 기한이 조용히 틀어지므로,
// 하나라도 틀리면 그해 전체를 실패(BAD_RESPONSE)로 보고 표를 건드리지 않는다.
const holidayItemSchema = z.object({
  date: z.iso.date(),
  name: z.string().trim().min(1),
  kind: z.enum(HOLIDAY_KINDS),
});

function validateYear(year: number, items: readonly SpecialDayHoliday[]): SpecialDayHoliday[] | null {
  const parsed = z.array(holidayItemSchema).safeParse(items);
  if (!parsed.success) return null;
  const list = parsed.data;
  // 그해 날짜만, 같은 날짜는 한 번만
  if (list.some((h) => !h.date.startsWith(`${year}-`))) return null;
  if (new Set(list.map((h) => h.date)).size !== list.length) return null;
  return list;
}

/** 기본 수집 연도 — KST 오늘의 해와 다음 해 */
export function defaultSyncYears(clock: Clock): number[] {
  const year = kstToday(clock).year;
  return [year, year + 1];
}

/**
 * 연도마다 받아서 넣는다. 한 해가 실패해도 다음 해는 계속한다(서로 다른 트랜잭션).
 * 실패는 예외로 던지지 않고 결과 줄로 돌려준다 — 시간 작업은 실패를 기록하고 끝나야 다음 날 다시 돈다.
 */
export async function syncHolidays(
  deps: HolidaySyncDeps,
  input: { readonly years?: readonly number[] } = {},
): Promise<{ runs: HolidaySyncYearResult[] }> {
  const years = input.years ?? defaultSyncYears(deps.clock);
  const runs: HolidaySyncYearResult[] = [];
  for (const year of years) {
    runs.push(await syncOneYear(deps, year));
  }
  return { runs };
}

async function syncOneYear(deps: HolidaySyncDeps, year: number): Promise<HolidaySyncYearResult> {
  // ① 받기 — 실패하면 표는 그대로 두고 실패 줄만 남긴다
  let fetched: readonly SpecialDayHoliday[];
  try {
    fetched = await deps.specialDays.fetchPublicHolidays(year);
  } catch (error) {
    const code = error instanceof SpecialDayProviderError ? error.code : UNEXPECTED_ERROR;
    return recordFailure(deps, year, code);
  }

  // ② 검사 — 모양이 틀리면 받기 실패와 똑같이 다룬다
  const holidays = validateYear(year, fetched);
  if (holidays === null) return recordFailure(deps, year, "BAD_RESPONSE");

  // ③ 넣기 — 한 트랜잭션. 중간에 DB 가 실패하면 전부 되돌리고 실패 줄을 남긴다
  try {
    const rowsUpserted = await deps.db.transaction(async (tx) => {
      let changed = 0;
      for (const holiday of holidays) {
        if (await upsertApiHoliday(tx, holiday)) changed += 1;
      }
      await insertRun(tx, { year, status: "success", rowsUpserted: changed, errorCode: null, at: deps.clock() });
      return changed;
    });
    return { year, status: "success", rowsUpserted, errorCode: null };
  } catch {
    return recordFailure(deps, year, DB_ERROR);
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Runner = Pick<Tx, "raw" | "execute" | "query">;

async function recordFailure(deps: HolidaySyncDeps, year: number, errorCode: string): Promise<HolidaySyncYearResult> {
  await insertRun(deps.db, { year, status: "failed", rowsUpserted: 0, errorCode, at: deps.clock() });
  return { year, status: "failed", rowsUpserted: 0, errorCode };
}

// raw 레인은 null 을 값으로 넘기지 못한다 — 빈 문자열로 보내고 SQL 의 NULLIF 로 NULL 로 바꾼다
async function insertRun(
  runner: Runner,
  run: { year: number; status: "success" | "failed"; rowsUpserted: number; errorCode: string | null; at: Temporal.Instant },
): Promise<void> {
  await runner.execute(
    runner.raw.sql`INSERT INTO holiday_sync_runs (id, ran_at, year, status, rows_upserted, error_code)
                   VALUES (uuidv7(), ${run.at.toString()}::timestamptz, ${run.year}, ${run.status},
                           ${run.rowsUpserted}, NULLIF(${run.errorCode ?? ""}, ''))`
      .affectedCount()
      .build(),
  );
}

/**
 * 공휴일 하루를 자동 줄로 맞춘다. 표가 바뀌었으면 true.
 *   - 그날 살아 있는 줄이 없으면 → 자동 줄을 넣는다
 *   - 자동 줄이 있으면 → 이름·종류가 다를 때만 고친다(같으면 그대로 — 멱등)
 *   - 운영자 줄이 있으면 → 그 줄을 닫고(deleted_at) 감사 1행을 쓴 뒤 자동 줄을 넣는다
 * 그날 줄을 FOR UPDATE 로 잠가, 같은 때 도는 운영자 입력(P9)과 엇갈리지 않게 한다.
 */
async function upsertApiHoliday(tx: Tx, holiday: SpecialDayHoliday): Promise<boolean> {
  const [live] = await tx.query(
    tx.raw.sql`SELECT id, source, name, kind FROM holidays
               WHERE date = ${holiday.date}::date AND deleted_at IS NULL FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", source: "pg/text@1", name: "pg/text@1", kind: "pg/text@1" })
      .build(),
  );

  if (live?.source === "api") {
    if (live.name === holiday.name && live.kind === holiday.kind) return false;
    await tx.execute(
      tx.raw.sql`UPDATE holidays SET name = ${holiday.name}, kind = ${holiday.kind}, updated_at = now()
                 WHERE id = ${live.id}`
        .affectedCount()
        .build(),
    );
    return true;
  }

  if (live?.source === "operator") {
    await tx.execute(
      tx.raw.sql`UPDATE holidays SET deleted_at = now(), updated_at = now() WHERE id = ${live.id}`.affectedCount().build(),
    );
    // 시스템이 운영자 줄을 닫았으니 감사 기록을 남긴다(수행자 = system). 전·후 값으로 무엇이 바뀌었는지 남긴다
    const before = JSON.stringify({ date: holiday.date, name: live.name, kind: live.kind, source: "operator" });
    const after = JSON.stringify({ date: holiday.date, name: holiday.name, kind: holiday.kind, source: "api" });
    await tx.execute(
      tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, action, target_table, target_id, before, after, reason)
                 VALUES (uuidv7(), 'system', 'holiday.deleted', 'holidays', ${live.id},
                         ${before}::jsonb, ${after}::jsonb, ${REPLACED_BY_API_REASON})`
        .affectedCount()
        .build(),
    );
  }

  // 살아 있는 줄이 없거나 방금 닫았다 → 자동 줄을 넣는다
  await tx.execute(
    tx.raw.sql`INSERT INTO holidays (id, date, name, kind, source)
               VALUES (uuidv7(), ${holiday.date}::date, ${holiday.name}, ${holiday.kind}, 'api')`
      .affectedCount()
      .build(),
  );
  return true;
}
