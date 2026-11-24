// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — P11 사업자 점검 건을 운영자가 처리하는 곳.
//   계약: _workspace/03_contracts/13-settlement.md §10-3(P11 사업자 점검) · 15-ops.md §2-8(이용 제한 절차 — apply·lift 와 같은 감사)
//   데이터: restriction_cases(source='business_status') · restriction_explanations(소명 글) · academy_restrictions · notifications · audit_logs
//   spec: FR-250(입점 심사·게시 제한) · FR-254(이용 제한 절차 — 「7일 안에 소명이 없으면 게시를 중단」)
//
// 큰 그림:
//   사업자 점검(business-status-check.ts)이 휴·폐업을 보면 「새 결제 막음」「지급 보류」 두 제한과 절차 1건을 연다.
//   소명 기한(감지 + 7일)이 지나도 이 코드는 스스로 게시를 막지 않는다 — 운영자가 P11 에서 「기한 지남」을 보고
//   「게시 중단」을 눌러야 세 번째 제한(listing_suspended)이 열린다(2026-11-21 사용자 결정, 계약 13 §10-3).
//   반대로 대표의 소명을 받아들이면 그 절차가 연 제한을 모두 닫는다.
//
// 경로 두 개(둘 다 관리자 웹 · 2단계 인증 · admin 만):
//   POST /api/admin/console/business-checks/{caseId}/suspend-listing     → 200 { state: "measure_applied" }
//   POST /api/admin/console/business-checks/{caseId}/accept-explanation  → 200 { state: "lifted" } · 소명 없음 409 NO_EXPLANATION
// 목록·상세(GET 두 개)는 S7-4.8c(사업자 점검 소명 처리 API(P11))가 이 처리기 묶음(list·detail)에 더했다. 읽는 쿼리는
// admin-business-check-views.ts 에 있다. 이 파일의 listBusinessCheckCases 는 S1-1.29 가 먼저 만든 「기한 지남」 판정 읽기 함수다.
import { z } from "zod";

import { explanationDue, type ExplanationDue } from "../../domain/business-check-case";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody } from "../http";
import {
  businessCheckActionSchema,
  explanationAcceptedSchema,
  listingSuspendedSchema,
} from "../schemas/admin-business-checks";
import {
  businessCheckDetailResponseSchema,
  businessCheckListResponseSchema,
} from "../schemas/admin-business-checks";
import { viewBusinessCheckDetail, viewBusinessCheckList } from "./admin-business-check-views";
import type { Runner } from "./cancellation-queries";

export type AdminBusinessCheckDeps = GuardDeps & { readonly clock: Clock };

/** 이 파일이 쓰는 409 코드(계약 13 §10-3 · 15-ops §2-8 오류 표) */
export const BUSINESS_CHECK_CODES = { noExplanation: "NO_EXPLANATION", stateConflict: "CASE_STATE_CONFLICT" } as const;

const DETAIL = {
  notFound: "사업자 점검 건을 찾을 수 없어요",
  noExplanation: "대표가 낸 소명이 아직 없어요",
  closed: "이미 끝난 건이에요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

type CaseRow = { id: string; academyId: string; state: string };

/** 경로의 caseId — uuid 가 아니면 없는 건과 같다(404) */
function parseCaseId(raw: string): string {
  const checked = z.uuid().safeParse(raw);
  if (!checked.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return checked.data;
}

/** 사업자 점검이 연 절차를 잠그고 읽는다 — 다른 출처(신고·운영자 직접)의 절차는 이 화면 몫이 아니라 404 */
async function lockBusinessCase(tx: Runner, caseId: string): Promise<CaseRow> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id, subject_academy_id AS academy_id, state FROM restriction_cases
               WHERE id = ${caseId}::uuid AND source = 'business_status' FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", academy_id: "pg/uuid@1", state: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  return { id: row.id, academyId: row.academy_id, state: row.state };
}

/** 운영자 감사 1행 — 메모는 reason 칸에도 남긴다(누가 · 왜 눌렀나) */
async function writeStaffAudit(
  tx: Runner,
  entry: { staffId: string; academyId: string; action: string; table: string; targetId: string; before: object | null; after: object; note: string },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                       before, after, reason)
               VALUES (uuidv7(), 'staff', ${entry.staffId}::uuid, 'admin', ${entry.academyId}::uuid, ${entry.action}, ${entry.table},
                       ${entry.targetId}::uuid, NULLIF(${entry.before === null ? "" : JSON.stringify(entry.before)}, '')::json,
                       ${JSON.stringify(entry.after)}::json, NULLIF(${entry.note}, ''))`
      .affectedCount()
      .build(),
  );
}

/** 그 학원 active 대표 전원에게 알림 1건씩(「운영」 칩, 거래 알림). 열쇠에 받는 사람을 넣어 다시 눌러도 늘지 않는다 */
async function notifyOwners(tx: Runner, input: { caseId: string; academyId: string; kind: string; title: string; body: string }): Promise<void> {
  const payload = JSON.stringify({ caseId: input.caseId, source: "business_status", title: input.title, body: input.body });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, 'operations', ${input.kind},
                      'restriction:' || ${input.caseId} || ':' || ${input.kind} || ':' || o.staff_account_id::text, ${payload}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${input.academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/**
 * 게시 중단 — 운영자가 P11 에서 누른다(소명 기한 전에도 긴급으로 누를 수 있다, 계약 13 §10-3).
 * 한 트랜잭션: 절차 measure_applied(조치 listing_limit) · academy_restrictions listing_suspended 1행 · 감사 2행 · 대표 알림.
 * 이미 조치된 건이면 아무것도 쓰지 않고 같은 본문(200). 풀렸거나 기각된 건은 409 CASE_STATE_CONFLICT.
 */
export async function suspendListing(
  deps: AdminBusinessCheckDeps,
  input: { caseId: string; staffAccountId: string; note: string },
): Promise<{ state: "measure_applied" }> {
  const now = deps.clock().toString();
  return deps.db.transaction(async (tx) => {
    const row = await lockBusinessCase(tx, input.caseId);
    if (row.state === "measure_applied") return { state: "measure_applied" as const }; // 이미 중단 — 다시 눌러도 같다
    if (row.state !== "notice_sent" && row.state !== "explained") {
      throw HttpError.conflict(BUSINESS_CHECK_CODES.stateConflict, DETAIL.closed);
    }

    // ① 절차를 조치 단계로 — 어떤 조치를 언제 했는지(ck_restriction_state_measure)
    await tx.execute(
      tx.raw.sql`UPDATE restriction_cases
                 SET state = 'measure_applied', measure = 'listing_limit', measure_applied_at = ${now}::timestamptz,
                     updated_at = ${now}::timestamptz
                 WHERE id = ${row.id}::uuid`
        .affectedCount()
        .build(),
    );

    // ② 세 번째 제한 — 게시 코드는 이 행만 읽는다. 다른 절차가 이미 같은 종류를 열어 두었으면 그 행을 그대로 쓴다
    const [opened] = await tx.query(
      tx.raw.sql`INSERT INTO academy_restrictions (id, academy_id, kind, reason, source_case_id, started_at)
                 SELECT uuidv7(), ${row.academyId}::uuid, 'listing_suspended', c.reason_code, c.id, ${now}::timestamptz
                 FROM restriction_cases c WHERE c.id = ${row.id}::uuid
                 ON CONFLICT (academy_id, kind) WHERE ended_at IS NULL DO NOTHING
                 RETURNING id`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );

    // ③ 감사 — 절차 전이(restriction.applied, 15-ops §2-8 apply 와 같은 이름) + 연 제한 행(academy_restriction.opened)
    await writeStaffAudit(tx, {
      staffId: input.staffAccountId,
      academyId: row.academyId,
      action: "restriction.applied",
      table: "restriction_cases",
      targetId: row.id,
      before: { state: row.state },
      after: { state: "measure_applied", measure: "listing_limit", academyRestrictionKind: "listing_suspended" },
      note: input.note,
    });
    if (opened !== undefined) {
      await writeStaffAudit(tx, {
        staffId: input.staffAccountId,
        academyId: row.academyId,
        action: "academy_restriction.opened",
        table: "academy_restrictions",
        targetId: opened.id,
        before: null,
        after: { kind: "listing_suspended", source_case_id: row.id },
        note: input.note,
      });
    }

    // ④ 대표 알림 listing_suspended — 이미 결제한 수업은 그대로 진행된다는 것도 같이 알린다
    await notifyOwners(tx, {
      caseId: row.id,
      academyId: row.academyId,
      kind: "listing_suspended",
      title: "학원 수업 게시가 중단됐어요",
      body: "사업자 상태 소명이 확인되지 않아 새 수업이 앱에 보이지 않아요. 이미 결제한 수업은 그대로 진행돼요",
    });
    return { state: "measure_applied" as const };
  });
}

/**
 * 소명을 받아들이고 풀기. 한 트랜잭션: 절차 lifted · 이 절차가 연 제한(그리고 절차 없이 점검이 연 옛 제한)에 ended_at ·
 * 감사 restriction.lifted + 닫은 행마다 academy_restriction.released · 대표 알림 business_restriction_lifted.
 * 이미 lifted 면 200 같은 본문, 기각된 건 409 CASE_STATE_CONFLICT, 소명이 한 건도 없으면 409 NO_EXPLANATION.
 */
export async function acceptExplanation(
  deps: AdminBusinessCheckDeps,
  input: { caseId: string; staffAccountId: string; note: string },
): Promise<{ state: "lifted" }> {
  const now = deps.clock().toString();
  return deps.db.transaction(async (tx) => {
    const row = await lockBusinessCase(tx, input.caseId);
    if (row.state === "lifted") return { state: "lifted" as const }; // 이미 풀림 — 다시 눌러도 같다
    if (row.state === "dismissed") throw HttpError.conflict(BUSINESS_CHECK_CODES.stateConflict, DETAIL.closed);

    // ① 받아들일 소명이 있어야 한다 — 소명 없이 푸는 것은 「받아들이기」가 아니다(계약 13 §10-3)
    const [count] = await tx.query(
      tx.raw.sql`SELECT count(*)::int AS n FROM restriction_explanations WHERE case_id = ${row.id}::uuid`
        .returnsRow({ n: "pg/int4@1" })
        .build(),
    );
    if ((count?.n ?? 0) === 0) throw HttpError.conflict(BUSINESS_CHECK_CODES.noExplanation, DETAIL.noExplanation);

    // ② 절차를 닫는다
    await tx.execute(
      tx.raw.sql`UPDATE restriction_cases
                 SET state = 'lifted', lifted_at = ${now}::timestamptz, closed_by_account_id = ${input.staffAccountId}::uuid,
                     updated_at = ${now}::timestamptz
                 WHERE id = ${row.id}::uuid`
        .affectedCount()
        .build(),
    );

    // ③ 제한을 닫는다 — 이 절차가 연 행(새 결제 막음·지급 보류, 게시 중단을 눌렀으면 그것까지) +
    //    절차가 생기기 전(S1-1.28) 점검이 연 옛 행(source_case_id 없이 source_check_id 만 있는 것)
    const closed = await tx.query(
      tx.raw.sql`UPDATE academy_restrictions
                 SET ended_at = ${now}::timestamptz, ended_by_account_id = ${input.staffAccountId}::uuid
                 WHERE academy_id = ${row.academyId}::uuid AND ended_at IS NULL
                   AND (source_case_id = ${row.id}::uuid OR (source_case_id IS NULL AND source_check_id IS NOT NULL))
                 RETURNING id, kind`
        .returnsRow({ id: "pg/uuid@1", kind: "pg/text@1" })
        .build(),
    );

    // ④ 감사
    await writeStaffAudit(tx, {
      staffId: input.staffAccountId,
      academyId: row.academyId,
      action: "restriction.lifted",
      table: "restriction_cases",
      targetId: row.id,
      before: { state: row.state },
      after: { state: "lifted", closedKinds: closed.map((r) => r.kind) },
      note: input.note,
    });
    for (const r of closed) {
      await writeStaffAudit(tx, {
        staffId: input.staffAccountId,
        academyId: row.academyId,
        action: "academy_restriction.released",
        table: "academy_restrictions",
        targetId: r.id,
        before: { kind: r.kind, ended_at: null },
        after: { kind: r.kind, ended_at: now },
        note: input.note,
      });
    }

    // ⑤ 대표 알림
    await notifyOwners(tx, {
      caseId: row.id,
      academyId: row.academyId,
      kind: "business_restriction_lifted",
      title: "학원 이용 제한이 풀렸어요",
      body: "소명이 확인돼 새 결제와 정산 지급이 다시 열렸어요",
    });
    return { state: "lifted" as const };
  });
}

/** P11 목록 한 줄 — 「기한 지남」 판정이 붙는다(계약 13 §10-3 목록의 일부 칸) */
export interface BusinessCheckCaseItem extends ExplanationDue {
  readonly caseId: string;
  readonly academyId: string;
  readonly academyName: string;
  readonly state: string;
  readonly actions: readonly string[];
  readonly explanationDueAt: string | null;
  readonly explanationCount: number;
}

/**
 * 사업자 점검 건 목록(열린 것 + 끝난 것, 소명 기한 순). 기한이 지났는지는 지금 시각으로 계산만 한다 —
 * 이 함수는 아무것도 바꾸지 않는다(기한이 지나도 제한은 두 개 그대로, 게시 중단은 운영자 몫).
 */
export async function listBusinessCheckCases(runner: Runner, now: Temporal.Instant): Promise<BusinessCheckCaseItem[]> {
  const rows = await runner.query(
    runner.raw.sql`SELECT c.id, c.subject_academy_id AS academy_id, a.name AS academy_name, c.state,
                          COALESCE(to_char(c.explanation_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS due,
                          COALESCE((SELECT string_agg(r.kind, ',' ORDER BY r.kind) FROM academy_restrictions r
                                    WHERE r.academy_id = c.subject_academy_id AND r.ended_at IS NULL), '') AS actions,
                          (SELECT count(*)::int FROM restriction_explanations e WHERE e.case_id = c.id) AS explanations
                   FROM restriction_cases c JOIN academies a ON a.id = c.subject_academy_id
                   WHERE c.source = 'business_status'
                   ORDER BY c.explanation_due_at NULLS LAST, c.id`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        state: "pg/text@1",
        due: "pg/text@1",
        actions: "pg/text@1",
        explanations: "pg/int4@1",
      })
      .build(),
  );
  return rows.map((r) => {
    const dueAt = r.due === "" ? null : Temporal.Instant.from(r.due);
    // 끝난 건(lifted·dismissed)은 기한을 따질 일이 없다 — 「기한 지남」을 붙이지 않는다
    const open = r.state === "notice_sent" || r.state === "explained";
    const due = open ? explanationDue(dueAt, now) : { dueInDays: null, overdue: false, dueLabel: null };
    return {
      caseId: r.id,
      academyId: r.academy_id,
      academyName: r.academy_name,
      state: r.state,
      actions: r.actions === "" ? [] : r.actions.split(","),
      explanationDueAt: r.due === "" ? null : r.due,
      explanationCount: r.explanations,
      ...due,
    };
  });
}

type CaseParams = { params: Promise<{ caseId: string }> };

/** P11 운영자 경로의 처리기 — 관리자 웹(2단계 인증) 운영자만 */
export function createAdminBusinessCheckRoutes(deps: AdminBusinessCheckDeps) {
  const consoleRoute = createConsoleRoute(deps);

  /** `POST …/{caseId}/suspend-listing` — 순서: 인증 → 본문(422) → 건(404) → 상태(409) */
  const suspend = consoleRoute<CaseParams>({ permission: "admin" }, async (request, context, staff) => {
    const body = await parseJsonBody(request, businessCheckActionSchema);
    const caseId = parseCaseId((await context.params).caseId);
    const result = await suspendListing(deps, { caseId, staffAccountId: staff.actor.accountId, note: body.note });
    return Response.json(listingSuspendedSchema.parse(result), { status: 200, headers: NO_STORE });
  });

  /** `POST …/{caseId}/accept-explanation` — 순서: 인증 → 본문(422) → 건(404) → 상태·소명(409) */
  const accept = consoleRoute<CaseParams>({ permission: "admin" }, async (request, context, staff) => {
    const body = await parseJsonBody(request, businessCheckActionSchema);
    const caseId = parseCaseId((await context.params).caseId);
    const result = await acceptExplanation(deps, { caseId, staffAccountId: staff.actor.accountId, note: body.note });
    return Response.json(explanationAcceptedSchema.parse(result), { status: 200, headers: NO_STORE });
  });

  /** `GET /api/admin/console/business-checks` — 목록 + 요약 카드 + 조회 기록(S7-4.8c(사업자 점검 소명 처리 API(P11))) */
  const list = consoleRoute<unknown>({ permission: "admin" }, async (_request, _context, staff) => {
    const body = await viewBusinessCheckList(deps, staff.actor.accountId);
    return Response.json(businessCheckListResponseSchema.parse(body), { status: 200, headers: NO_STORE });
  });

  /** `GET …/{caseId}` — 건 상세(최신 점검 · 소명 · 열린 제한) + 조회 기록. 순서: 인증 → 건(404) */
  const detail = consoleRoute<CaseParams>({ permission: "admin" }, async (_request, context, staff) => {
    const caseId = parseCaseId((await context.params).caseId);
    const body = await viewBusinessCheckDetail(deps, staff.actor.accountId, caseId);
    return Response.json(businessCheckDetailResponseSchema.parse(body), { status: 200, headers: NO_STORE });
  });

  return { suspend, accept, list, detail };
}
