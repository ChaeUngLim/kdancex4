// S1-1.27(사업자 상태 점검 작업) — 학원 사업자등록번호를 국세청 상태조회로 확인해 business_status_checks 에 쌓는다.
//   정의: _workspace/03_data-model.md §7-3b · 포트: lib/server/ports/business-status.ts(S1-1.26)
//   경로: POST /api/internal/jobs/business-status/check(매일 03:10 KST, 계약 13-settlement.md 「시간 작업」 표)
//
// 왜 이런 작업이 있나: 결제 시작·정산 지급은 요청마다 국세청을 부르지 않는다. 바깥 API 가 느리거나 죽으면
// 회원 결제까지 멈추기 때문이다. 대신 이 작업이 하루 한 번(+ 정산 지급 직전) 조회해 기록을 남기고,
// 휴·폐업이면 같은 트랜잭션에서 academy_restrictions 에 제한을 연다(S1-1.28). 요청 경로는 그 제한만 읽는다.
//
// 규칙 넷:
//   1. 학원마다 확인 기록 1행을 남긴다. 조회에 실패해도(error) 1행을 남긴다 — 「언제 무엇을 물었고 무엇이 왔나」가 근거다
//   2. **error 는 조치하지 않는다.** 학원의 「마지막 확인 결과」(academies.business_status)도 건드리지 않는다.
//      조회 실패를 폐업으로 오판하지 않으려는 것이고, 다음 점검에서 다시 본다
//   3. 매일 점검(daily)은 같은 KST 날짜에 이미 결과를 받은 학원을 건너뛴다(멱등 — cron 이 두 번 불러도 기록이 늘지 않는다).
//      error 였던 학원은 건너뛰지 않고 다시 본다
//   4. 정산 직전 점검(pre_payout)은 지급할 학원 목록을 받아 그 학원만, 같은 날 매일 점검이 있었어도 새로 조회한다
//      — 지급 직전의 상태가 필요하기 때문이다. 정산 지급 작업(S5-3)이 이 함수를 직접 부른다
import { z } from "zod";

import { BUSINESS_CHECK_EXPLANATION_DAYS, businessCaseReasonText } from "../../domain/business-check-case";
import { BUSINESS_CHECK_STATUSES, type BusinessCheckStatus } from "../../domain/constants";
import { formatKstDate, type Clock } from "../../domain/time";
import type { Db } from "../../../prisma/db";
import {
  BUSINESS_STATUS_MAX_BATCH,
  type BusinessStatusPort,
  type BusinessStatusResult,
} from "../ports/business-status";

/** 이 작업이 남기는 조회 계기. 입점 심사(onboarding)는 심사 API 쪽이 따로 남긴다 */
export const BUSINESS_CHECK_JOB_TRIGGERS = ["daily", "pre_payout", "manual"] as const;
export type BusinessCheckJobTrigger = (typeof BUSINESS_CHECK_JOB_TRIGGERS)[number];

export interface BusinessStatusCheckDeps {
  readonly db: Db;
  readonly businessStatus: BusinessStatusPort;
  readonly clock: Clock;
}

export interface BusinessStatusCheckInput {
  readonly trigger: BusinessCheckJobTrigger;
  /** 점검할 학원. daily 는 생략하면 해지되지 않은 모든 학원, pre_payout·manual 은 반드시 준다 */
  readonly academyIds?: readonly string[];
}

/** 경로 응답과 테스트가 읽는 결과 */
export interface BusinessStatusCheckResult {
  readonly trigger: BusinessCheckJobTrigger;
  /** 이번에 국세청에 물어본 학원 수 */
  readonly processed: number;
  /** 쌓은 확인 기록 수(= processed, 실패한 조회도 1행) */
  readonly recorded: number;
  /** 오늘 이미 결과가 있어 건너뛴 학원 수(daily 만) */
  readonly skipped: number;
  readonly byStatus: Readonly<Record<BusinessCheckStatus, number>>;
}

/** 포트가 약속과 달리 예외를 던졌을 때 기록에 남기는 코드 */
const UNEXPECTED_ERROR = "UNEXPECTED_ERROR";

const academyIdsSchema = z.array(z.uuid()).max(10_000);

interface TargetAcademy {
  readonly id: string;
  readonly businessNo: string;
}

/**
 * 점검 한 회차를 돈다. 실패는 예외로 던지지 않고 error 기록으로 남긴다 — 시간 작업은 기록을 남기고 끝나야
 * 다음 회차가 다시 돈다. 예외는 호출하는 쪽 잘못(학원 목록 없는 pre_payout, 모양 틀린 id)에만 던진다.
 */
export async function runBusinessStatusCheck(
  deps: BusinessStatusCheckDeps,
  input: BusinessStatusCheckInput,
): Promise<BusinessStatusCheckResult> {
  if (input.trigger !== "daily" && input.academyIds === undefined) {
    throw new RangeError(`${input.trigger} 점검은 학원 목록이 있어야 한다.`);
  }
  const academyIds = input.academyIds === undefined ? null : academyIdsSchema.parse(input.academyIds);
  const now = deps.clock();

  // ① 대상 고르기 — 해지된 학원은 빼고, daily 는 오늘 이미 결과를 받은 학원도 뺀다
  const candidates = await selectAcademies(deps.db, academyIds);
  const done = input.trigger === "daily" ? await academiesCheckedToday(deps.db, formatKstDate(now)) : new Set<string>();
  const targets = candidates.filter((a) => !done.has(a.id));

  // ② 100개씩 나눠 묻고, 학원마다 기록을 남긴다
  const counts: Record<BusinessCheckStatus, number> = Object.fromEntries(
    BUSINESS_CHECK_STATUSES.map((s) => [s, 0]),
  ) as Record<BusinessCheckStatus, number>;
  for (let start = 0; start < targets.length; start += BUSINESS_STATUS_MAX_BATCH) {
    const batch = targets.slice(start, start + BUSINESS_STATUS_MAX_BATCH);
    const results = await lookup(deps.businessStatus, batch);
    for (const [index, academy] of batch.entries()) {
      const result = results[index] ?? unexpectedError(academy.businessNo);
      await recordCheck(deps.db, academy, result, input.trigger, now);
      counts[result.status] += 1;
    }
  }

  return {
    trigger: input.trigger,
    processed: targets.length,
    recorded: targets.length,
    skipped: candidates.length - targets.length,
    byStatus: counts,
  };
}

/** 포트가 예외를 던지거나 개수가 어긋나면 그 묶음 전체를 조회 실패로 본다(폐업으로 보지 않는다) */
async function lookup(port: BusinessStatusPort, batch: readonly TargetAcademy[]): Promise<readonly BusinessStatusResult[]> {
  try {
    const results = await port.checkStatuses(batch.map((a) => a.businessNo));
    if (results.length !== batch.length) return batch.map((a) => unexpectedError(a.businessNo));
    return results;
  } catch {
    return batch.map((a) => unexpectedError(a.businessNo));
  }
}

function unexpectedError(businessNo: string): BusinessStatusResult {
  return {
    businessNo,
    status: "error",
    closedOn: null,
    taxType: null,
    errorCode: null,
    rawResponse: { error_code: UNEXPECTED_ERROR },
  };
}

async function selectAcademies(db: Db, academyIds: readonly string[] | null): Promise<TargetAcademy[]> {
  // 목록이 없으면(daily 전체) 빈 배열 대신 표식 'all' 을 넘긴다 — raw 레인은 배열·null 을 값으로 못 넘겨서
  // id 목록을 JSON 글로 보내고 SQL 이 풀어 쓴다
  const filter = academyIds === null ? "all" : JSON.stringify(academyIds);
  const rows = await db.query(
    db.raw.sql`SELECT id, business_registration_number FROM academies
               WHERE status <> 'terminated'
                 AND (${filter} = 'all'
                      OR id IN (SELECT value::uuid FROM json_array_elements_text(NULLIF(${filter}, 'all')::json)))
               ORDER BY id`
      .returnsRow({ id: "pg/uuid@1", business_registration_number: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({ id: r.id, businessNo: r.business_registration_number }));
}

/** 오늘(KST) 매일 점검으로 error 가 아닌 결과를 이미 받은 학원 */
async function academiesCheckedToday(db: Db, kstDate: string): Promise<Set<string>> {
  const rows = await db.query(
    db.raw.sql`SELECT DISTINCT academy_id FROM business_status_checks
               WHERE trigger = 'daily' AND status <> 'error'
                 AND (checked_at AT TIME ZONE 'Asia/Seoul')::date = ${kstDate}::date`
      .returnsRow({ academy_id: "pg/uuid@1" })
      .build(),
  );
  return new Set(rows.map((r) => r.academy_id));
}

/**
 * 학원 하나의 결과를 한 트랜잭션으로 남긴다 — 확인 기록 1행 + (error 가 아니면) 학원의 마지막 확인 결과.
 * error 면 학원 칸은 그대로 둔다. 휴·폐업이면 같은 트랜잭션에서 제한을 열고 대표에게 알린다(S1-1.28, ④).
 *
 * 감사 기록(audit_logs): business_status_checks 와 academies 는 둘 다 데이터 모델에서 「감사 ○」다(§7-3b·§7-3).
 * 그래서 바꾼 테이블마다 같은 트랜잭션에서 감사 1행을 쓴다. 수행자는 사람이 아니라 시간 작업이라 actor_kind='system'.
 *   - 확인 기록 1행을 쌓았다 → 'business_status.checked'(after = 결과·계기)
 *   - 학원의 마지막 확인 결과를 바꿨다 → 'academy.business_status_updated'(before·after = 바뀌기 전후 값)
 * 기록이 실패하면 감사도 같이 되돌아가고, 감사 쓰기가 실패하면 기록도 남지 않는다(한 트랜잭션).
 */
async function recordCheck(
  db: Db,
  academy: TargetAcademy,
  result: BusinessStatusResult,
  trigger: BusinessCheckJobTrigger,
  at: Temporal.Instant,
): Promise<void> {
  const checkedAt = at.toString();
  await db.transaction(async (tx) => {
    // ① 확인 기록 — raw 레인은 null 을 값으로 넘기지 못한다. 빈 문자열로 보내고 NULLIF 로 NULL 로 바꾼다.
    //    새 행 id(uuidv7)는 RETURNING 으로 받아 감사 기록의 target_id 에 같은 값을 쓴다
    const [inserted] = await tx.query(
      tx.raw.sql`INSERT INTO business_status_checks
                   (id, academy_id, checked_at, trigger, business_no, status, closed_on, tax_type, raw_response)
                 VALUES (uuidv7(), ${academy.id}::uuid, ${checkedAt}::timestamptz, ${trigger}, ${academy.businessNo},
                         ${result.status}, NULLIF(${result.closedOn ?? ""}, '')::date, NULLIF(${result.taxType ?? ""}, ''),
                         ${JSON.stringify(result.rawResponse)}::json)
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (inserted === undefined) throw new Error("확인 기록을 쓰지 못했다.");
    const checkAfter = JSON.stringify({ status: result.status, trigger, business_no: academy.businessNo });
    await writeAudit(tx, {
      action: "business_status.checked",
      targetTable: "business_status_checks",
      targetId: inserted.id,
      academyId: academy.id,
      before: null,
      after: checkAfter,
    });

    // ② error 는 조치하지 않는다 — 학원 칸도 감사 2번째 행도 없다
    if (result.status === "error") return;

    // ③ 학원의 마지막 확인 결과를 바꾼다. 바뀌기 전 값을 같이 남기려고 먼저 잠그고 읽는다
    const [previous] = await tx.query(
      tx.raw.sql`SELECT business_status, business_status_checked_at::text AS checked_at
                 FROM academies WHERE id = ${academy.id}::uuid FOR UPDATE`
        .returnsRow({ business_status: "pg/text@1", checked_at: "pg/text@1" })
        .build(),
    );
    await tx.execute(
      tx.raw.sql`UPDATE academies
                 SET business_status = ${result.status}, business_status_checked_at = ${checkedAt}::timestamptz,
                     updated_at = now()
                 WHERE id = ${academy.id}::uuid`
        .affectedCount()
        .build(),
    );
    await writeAudit(tx, {
      action: "academy.business_status_updated",
      targetTable: "academies",
      targetId: academy.id,
      academyId: academy.id,
      before: JSON.stringify({
        business_status: previous?.business_status ?? null,
        business_status_checked_at: previous?.checked_at ?? null,
      }),
      after: JSON.stringify({ business_status: result.status, business_status_checked_at: checkedAt }),
    });

    // ④ 휴·폐업이면 제한을 연다(S1-1.28). 확인 기록·학원 칸과 같은 트랜잭션이라, 제한만 열리고 기록이 빠지는 일이 없다
    if (result.status === "suspended" || result.status === "closed") {
      await openClosureRestrictions(tx, {
        academyId: academy.id,
        checkId: inserted.id,
        businessStatus: result.status,
        closedOn: result.closedOn,
        detectedAt: checkedAt,
      });
    }
  });
}

/** 휴·폐업을 감지하면 여는 제한 두 가지 — 새 결제 막음 · 지급 보류(data-model §7-3b, FR-250·FR-252) */
export const CLOSURE_RESTRICTION_KINDS = ["new_sales_blocked", "payout_hold"] as const;

/**
 * S1-1.28(휴·폐업 감지 시 학원 제한 열기) — 학원 제한 2행을 열고, 새로 연 것이 있으면 대표에게 알림 1건을 쓴다.
 *
 * 왜 이렇게 하나:
 *   - 「처음 나오면」만 연다. 같은 종류의 열린 제한은 학원당 하나(uq_restrictions_open)라 ON CONFLICT 로 건너뛴다.
 *     매일 점검이 같은 폐업을 다시 봐도 제한·알림이 겹쳐 쌓이지 않는다. 닫힌 제한(ended_at 있음)은 인덱스 밖이라 새로 열린다
 *   - 이미 결제한 주문·예약·결제는 건드리지 않는다. 막히는 것은 새 결제(결제 시작 코드가 new_sales_blocked 를 읽는다)와
 *     정산 지급(지급 코드가 payout_hold 를 읽는다)뿐이다
 *   - 운영자 확인 작업: S7-2.6 으로 restriction_cases 가 생겨, S1-1.29 부터는 같은 트랜잭션에서 사업자 점검 절차 1건
 *     (source=business_status, 소명 기한 감지+7일)을 열고 연 제한 행에 source_case_id 로 잇는다. 그 절차가 P11 의 「건」이다
 *   - academy_restrictions 를 바꾸는 쓰기라 연 행마다 감사 1행(academy_restriction.opened — 닫을 때의 .released 와 짝)
 */
async function openClosureRestrictions(
  tx: Tx,
  input: {
    readonly academyId: string;
    readonly checkId: string;
    readonly businessStatus: "suspended" | "closed";
    readonly closedOn: string | null;
    readonly detectedAt: string;
  },
): Promise<void> {
  const reason = input.businessStatus === "closed" ? "business_closed" : "business_suspended";

  // ① 제한 2행 — 이미 열려 있는 종류는 부분 유니크 인덱스에 걸려 조용히 건너뛴다
  const opened = await tx.query(
    tx.raw.sql`INSERT INTO academy_restrictions (id, academy_id, kind, reason, source_check_id, started_at)
               SELECT uuidv7(), ${input.academyId}::uuid, k.kind, ${reason}, ${input.checkId}::uuid,
                      ${input.detectedAt}::timestamptz
               FROM (VALUES ('new_sales_blocked'), ('payout_hold')) AS k(kind)
               ON CONFLICT (academy_id, kind) WHERE ended_at IS NULL DO NOTHING
               RETURNING id, kind`
      .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1" })
      .build(),
  );
  if (opened.length === 0) return; // 둘 다 이미 열려 있었다 — 새로 알릴 것이 없다

  // ①-b 이용 제한 절차 1건(S1-1.29, 계약 13 §10-3) — 운영자 P11 화면의 「건」이다(caseId).
  //   사유 통지 단계(notice_sent)로 열고 소명 기한은 감지 + 7일. 기한이 지나도 자동으로 게시를 막지 않는다 —
  //   운영자가 suspend-listing 을 눌러야 listing_suspended 가 열린다(2026-11-21 사용자 결정).
  //   같은 학원에 사업자 점검으로 열린 절차가 이미 있으면(uq_restriction_open_academy) 그 절차에 잇는다.
  const caseId = await openBusinessCase(tx, input);
  await tx.execute(
    tx.raw.sql`UPDATE academy_restrictions SET source_case_id = ${caseId}::uuid
               WHERE academy_id = ${input.academyId}::uuid AND source_check_id = ${input.checkId}::uuid
                 AND source_case_id IS NULL`
      .affectedCount()
      .build(),
  );

  // ② 연 행마다 감사 1행
  for (const row of opened) {
    await writeAudit(tx, {
      action: "academy_restriction.opened",
      targetTable: "academy_restrictions",
      targetId: row.id,
      academyId: input.academyId,
      before: null,
      after: JSON.stringify({ kind: row.kind, reason, source_check_id: input.checkId }),
    });
  }

  // ③ 대표 알림 1건(직원 알림함 「운영」 칩). active 대표가 없는 학원은 받을 사람이 없어 알림 없이 제한만 남는다.
  //    dedupe_key 를 확인 기록 id 로 지어, 같은 감지를 다시 처리해도 알림이 두 번 들어가지 않는다
  const actions = CLOSURE_RESTRICTION_KINDS.filter((kind) => opened.some((row) => row.kind === kind));
  const payload = JSON.stringify({
    source: "business_status",
    caseId,
    checkId: input.checkId,
    businessStatus: input.businessStatus,
    closedOn: input.closedOn,
    actions,
    detectedAt: input.detectedAt,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, 'operations', 'restriction_notice',
                      'business_status_check:' || ${input.checkId} || ':restricted', ${payload}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${input.academyId}::uuid AND o.status = 'active'
               ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
      .affectedCount()
      .build(),
  );
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 사업자 점검이 여는 이용 제한 절차(source='business_status') — 열린 절차가 있으면 그 id, 없으면 새로 연다.
 * 자동 점검이 연 것이라 opened_by_account_id 는 비우고 감사는 system 으로 남긴다.
 */
async function openBusinessCase(
  tx: Tx,
  input: { readonly academyId: string; readonly checkId: string; readonly businessStatus: "suspended" | "closed"; readonly detectedAt: string },
): Promise<string> {
  const reasonCode = input.businessStatus === "closed" ? "business_closed" : "business_suspended";
  const reasonText = businessCaseReasonText(input.businessStatus);
  const [created] = await tx.query(
    tx.raw.sql`INSERT INTO restriction_cases (id, subject_kind, subject_academy_id, source, source_check_id, reason_code, reason_text,
                                              planned_measure, state, notice_sent_at, explanation_due_at, updated_at)
               VALUES (uuidv7(), 'academy', ${input.academyId}::uuid, 'business_status', ${input.checkId}::uuid, ${reasonCode},
                       ${reasonText}, 'listing_limit', 'notice_sent', ${input.detectedAt}::timestamptz,
                       ${input.detectedAt}::timestamptz + make_interval(days => ${BUSINESS_CHECK_EXPLANATION_DAYS}::int),
                       ${input.detectedAt}::timestamptz)
               ON CONFLICT DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (created !== undefined) {
    await writeAudit(tx, {
      action: "restriction.opened",
      targetTable: "restriction_cases",
      targetId: created.id,
      academyId: input.academyId,
      before: null,
      after: JSON.stringify({ state: "notice_sent", source: "business_status", reasonCode, reasonText, plannedMeasure: "listing_limit" }),
    });
    return created.id;
  }
  const [existing] = await tx.query(
    tx.raw.sql`SELECT id FROM restriction_cases
               WHERE subject_academy_id = ${input.academyId}::uuid AND source = 'business_status'
                 AND state IN ('notice_sent', 'explained', 'measure_applied')`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (existing === undefined) throw new Error("사업자 점검 절차를 열지도 찾지도 못했다");
  return existing.id;
}

/** 시스템(시간 작업)이 남기는 감사 1행. before 가 없으면 NULL 로 둔다(raw 레인은 null 을 못 넘겨 NULLIF 로 바꾼다) */
async function writeAudit(
  tx: Tx,
  entry: {
    readonly action: string;
    readonly targetTable: string;
    readonly targetId: string;
    readonly academyId: string;
    readonly before: string | null;
    readonly after: string;
  },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, academy_id, action, target_table, target_id, before, after)
               VALUES (uuidv7(), 'system', ${entry.academyId}::uuid, ${entry.action}, ${entry.targetTable},
                       ${entry.targetId}::uuid, NULLIF(${entry.before ?? ""}, '')::jsonb, ${entry.after}::jsonb)`
      .affectedCount()
      .build(),
  );
}
