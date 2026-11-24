// S7-2.6(이용 제한 절차) — 운영자가 이용을 제한하면 「누구를 · 왜 · 어떤 조치로」 한 행과 감사 한 행으로 남기는 처리기.
//   계약: _workspace/03_contracts/15-ops.md §2-8(이용 제한 절차 — 사유 통지 → 소명 → 조치) · §2-7 resolve 의 openRestriction
//   데이터: restriction_cases(이 Task 의 마이그레이션 20261124T0905_restriction_cases) · notifications(restriction_notice, 거래)
//           · audit_logs(restriction.opened) · academy_restrictions(긴급 조치의 효과, source_case_id)
//   spec: FR-254(이용 제한 절차)
//
// 흐름 한눈에 — POST /api/admin/restrictions (한 트랜잭션)
//   1 같은 운영자·같은 Idempotency-Key 로 연 절차가 있으면 그대로 200(재생)
//   2 대상이 있는지(404) — 회원 행 / 강사 역할이 있는 직원 / 학원
//   3 같은 대상·같은 출처로 열린 절차가 있으면 409 CASE_ALREADY_OPEN(uq_restriction_open_* 가 마지막 방어선)
//   4 절차 1행: 보통은 notice_sent(사유 통지, 소명 기한 = 지금 + N일), 긴급이면 measure_applied(조치 먼저)
//   5 긴급이고 학원의 게시 제한·정산 보류면 academy_restrictions 행을 연다 — 결제·게시·지급 코드는 이 행만 읽는다
//   6 대상에게 restriction_notice 알림(사유 글 포함 — 무엇을 소명할지 알아야 한다)
//   7 감사 restriction.opened 1행(사유 글은 audit_logs.reason 칸에도 남긴다)
//
// 신고 처리(resolve)에서 절차를 열 때도 같은 함수(openRestrictionCaseInTx)를 같은 트랜잭션 안에서 부른다.
//
// 이번 Task 가 일부러 하지 않은 것(증거 EVIDENCE.md 「추천안·사후 확인」):
//   - apply·lift·목록·내 절차·소명 경로 — 계약 §2-8 의 나머지 다섯 경로. 로드맵에 따로 잡힌 Task 가 없어 오케스트레이터에 알린다
//   - 회원 이용 정지 효과(members.status='suspended') — members 표에 status 칸이 아직 없다. 긴급 정지는 절차 행에만 남는다
//   - 환불 경로는 이 표를 읽지 않는다(FR-254 — 정지돼도 기존 결제 환불 청구권은 막지 않는다). 그래서 손대지 않았다
import {
  academyRestrictionKindFor,
  initialRestrictionState,
  restrictionNoticeText,
  type RestrictionMeasure,
  type RestrictionSource,
  type RestrictionState,
  type RestrictionSubjectKind,
} from "../../domain/restriction";
import type { Clock } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey } from "../http";
import { openRestrictionSchema, restrictionOpenedSchema, type OpenRestriction, type RestrictionOpened } from "../schemas/restrictions";
import type { Runner } from "./cancellation-queries";

export type RestrictionDeps = GuardDeps & { readonly clock: Clock };

/** 이 파일이 쓰는 409 코드(계약 §2-8 오류 표) */
export const RESTRICTION_CODES = { alreadyOpen: "CASE_ALREADY_OPEN" } as const;

const DETAIL = {
  subjectNotFound: "제한할 대상을 찾을 수 없어요",
  alreadyOpen: "이 대상에게 같은 출처로 열린 이용 제한 절차가 이미 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_MS_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** 대상 칸 세 개 — 종류에 맞는 칸 하나만 채우고 나머지는 빈 글자(SQL 에서 NULLIF 로 NULL 이 된다, ck_restriction_subject) */
const subjectColumns = (kind: RestrictionSubjectKind, id: string) => ({
  memberId: kind === "member" ? id : "",
  staffId: kind === "instructor" ? id : "",
  academyId: kind === "academy" ? id : "",
});

/** 대상이 있나 — 회원 행 / active 강사 역할이 있는 직원 / 학원 */
async function subjectExists(runner: Runner, kind: RestrictionSubjectKind, id: string): Promise<boolean> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT CASE ${kind}::text
                            WHEN 'member' THEN EXISTS (SELECT 1 FROM members m WHERE m.id = ${id}::uuid)
                            WHEN 'instructor' THEN EXISTS (SELECT 1 FROM role_grants g WHERE g.staff_account_id = ${id}::uuid
                                                           AND g.role = 'instructor' AND g.status = 'active')
                            WHEN 'academy' THEN EXISTS (SELECT 1 FROM academies a WHERE a.id = ${id}::uuid)
                          END AS found`
      .returnsRow({ found: "pg/bool@1" })
      .build(),
  );
  return row?.found === true;
}

/** 절차 한 건의 응답 모양 */
async function readOpened(runner: Runner, caseId: string): Promise<RestrictionOpened> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id, state, COALESCE(to_char(explanation_due_at AT TIME ZONE 'UTC', ${ISO_MS_SQL}), '') AS due
                   FROM restriction_cases WHERE id = ${caseId}::uuid`
      .returnsRow({ id: "pg/uuid@1", state: "pg/text@1", due: "pg/text@1" })
      .build(),
  );
  if (row === undefined) throw new Error(`있어야 할 이용 제한 절차를 다시 읽지 못했다: ${caseId}`);
  return { caseId: row.id, state: row.state as RestrictionState, explanationDueAt: row.due === "" ? null : row.due };
}

/** 같은 대상·같은 출처로 열린 절차(uq_restriction_open_* 와 같은 조건) */
async function findOpenCaseId(runner: Runner, kind: RestrictionSubjectKind, id: string, source: RestrictionSource): Promise<string | null> {
  const cols = subjectColumns(kind, id);
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM restriction_cases
                   WHERE source = ${source} AND state IN ('notice_sent', 'explained', 'measure_applied')
                     AND (subject_member_id = NULLIF(${cols.memberId}, '')::uuid
                          OR subject_staff_account_id = NULLIF(${cols.staffId}, '')::uuid
                          OR subject_academy_id = NULLIF(${cols.academyId}, '')::uuid)`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/** 재생 판정 — 같은 운영자가 같은 열쇠로 연 절차 */
async function findCaseIdByKey(runner: Runner, staffAccountId: string, key: string): Promise<string | null> {
  const [row] = await runner.query(
    runner.raw.sql`SELECT id FROM restriction_cases WHERE opened_by_account_id = ${staffAccountId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row?.id ?? null;
}

/**
 * 대상에게 「이용 제한 안내」 1행(거래 알림 — 광고 동의·야간과 무관하게 간다).
 *   회원 → 회원 알림 · 강사 → 그 직원의 「운영」 칩 · 학원 → active 대표 전원의 「운영」 칩(academy_id 를 붙인다)
 * 열쇠 `restriction:<caseId>:notice:<받는 사람>` — 같은 절차를 다시 처리해도 늘지 않는다.
 */
async function notifySubject(
  runner: Runner,
  input: { caseId: string; kind: RestrictionSubjectKind; id: string; state: RestrictionState; text: { title: string; body: string } },
): Promise<void> {
  const payload = JSON.stringify({ caseId: input.caseId, state: input.state, title: input.text.title, body: input.text.body });
  if (input.kind === "member") {
    await runner.execute(
      runner.raw.sql`INSERT INTO notifications (id, recipient_member_id, kind, dedupe_key, payload)
                     VALUES (uuidv7(), ${input.id}::uuid, 'restriction_notice',
                             'restriction:' || ${input.caseId} || ':notice:' || ${input.id}, ${payload}::jsonb)
                     ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
    return;
  }
  if (input.kind === "instructor") {
    await runner.execute(
      runner.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, category, kind, dedupe_key, payload)
                     VALUES (uuidv7(), ${input.id}::uuid, 'operations', 'restriction_notice',
                             'restriction:' || ${input.caseId} || ':notice:' || ${input.id}, ${payload}::jsonb)
                     ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
    return;
  }
  // 학원 — active 대표가 없으면 받을 사람이 없어 알림 없이 절차만 남는다(사업자 점검과 같은 처리)
  await runner.execute(
    runner.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                   SELECT uuidv7(), o.staff_account_id, o.academy_id, 'operations', 'restriction_notice',
                          'restriction:' || ${input.caseId} || ':notice:' || o.staff_account_id::text, ${payload}::jsonb
                   FROM academy_owners o
                   WHERE o.academy_id = ${input.id}::uuid AND o.status = 'active'
                   ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 절차를 여는 데 필요한 것 — 운영자 직접(operator_manual)과 신고 처리(report)가 같이 쓴다 */
export interface OpenRestrictionInput {
  readonly subjectKind: RestrictionSubjectKind;
  readonly subjectId: string;
  readonly source: RestrictionSource;
  readonly sourceReportId: string | null;
  readonly reasonCode: string;
  readonly reasonText: string;
  readonly plannedMeasure: RestrictionMeasure;
  readonly urgent: boolean;
  readonly explanationDays: number;
  readonly openedByStaffAccountId: string;
  readonly idempotencyKey: string | null;
  readonly now: string;
  /** 같은 대상·같은 출처로 열린 절차가 있을 때 — 409 로 막을지(운영자 직접), 그 절차를 그대로 쓸지(신고 처리) */
  readonly onAlreadyOpen: "conflict" | "reuse";
}

export interface OpenRestrictionResult {
  readonly created: boolean;
  readonly outcome: RestrictionOpened;
}

/**
 * 이용 제한 절차 1행을 연다 — 호출하는 쪽의 트랜잭션 안에서만 부른다(절차·알림·감사가 함께 들어가거나 함께 빠진다).
 * 재생·대상 확인은 운영자 경로가 먼저 하고, 이 함수는 3~7 단계를 맡는다.
 */
export async function openRestrictionCaseInTx(tx: Runner, input: OpenRestrictionInput): Promise<OpenRestrictionResult> {
  // 3 같은 대상·같은 출처로 열린 절차 — 운영자 직접이면 409, 신고 처리면 그 절차에 신고를 잇는다
  const openId = await findOpenCaseId(tx, input.subjectKind, input.subjectId, input.source);
  if (openId !== null) {
    if (input.onAlreadyOpen === "reuse") return { created: false, outcome: await readOpened(tx, openId) };
    throw HttpError.conflict(RESTRICTION_CODES.alreadyOpen, DETAIL.alreadyOpen);
  }

  // 4 절차 1행. 긴급이면 조치(measure)와 조치 시각을 같이 채운다(ck_restriction_state_measure).
  //   소명 기한은 긴급이어도 둔다 — 조치를 먼저 했을 뿐 소명할 기회는 그대로다(FR-254)
  const state = initialRestrictionState(input.urgent);
  const cols = subjectColumns(input.subjectKind, input.subjectId);
  const [row] = await tx.query(
    tx.raw.sql`INSERT INTO restriction_cases (id, subject_kind, subject_member_id, subject_staff_account_id, subject_academy_id,
                                              source, source_report_id, reason_code, reason_text, planned_measure, measure, state,
                                              urgent, notice_sent_at, explanation_due_at, measure_applied_at,
                                              opened_by_account_id, idempotency_key, updated_at)
               VALUES (uuidv7(), ${input.subjectKind}, NULLIF(${cols.memberId}, '')::uuid, NULLIF(${cols.staffId}, '')::uuid,
                       NULLIF(${cols.academyId}, '')::uuid, ${input.source}, NULLIF(${input.sourceReportId ?? ""}, '')::uuid,
                       ${input.reasonCode}, ${input.reasonText}, ${input.plannedMeasure},
                       NULLIF(${input.urgent ? input.plannedMeasure : ""}, ''), ${state}, ${input.urgent}::boolean,
                       ${input.now}::timestamptz, ${input.now}::timestamptz + make_interval(days => ${input.explanationDays}::int),
                       CASE WHEN ${input.urgent}::boolean THEN ${input.now}::timestamptz END,
                       ${input.openedByStaffAccountId}::uuid, NULLIF(${input.idempotencyKey ?? ""}, ''), ${input.now}::timestamptz)
               ON CONFLICT DO NOTHING
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (row === undefined) {
    // 동시에 같은 열쇠·같은 대상이 들어왔다 — 먼저 들어간 쪽을 본다
    //   같은 열쇠면 재생, 같은 대상이면 운영자 직접은 409 · 신고 처리는 그 절차를 쓴다
    const byKey = input.idempotencyKey === null ? null : await findCaseIdByKey(tx, input.openedByStaffAccountId, input.idempotencyKey);
    if (byKey !== null) return { created: false, outcome: await readOpened(tx, byKey) };
    const winner = await findOpenCaseId(tx, input.subjectKind, input.subjectId, input.source);
    if (winner === null) throw new Error("이용 제한 절차 넣기가 아무 행도 만들지 않았는데 겹치는 절차도 없다");
    if (input.onAlreadyOpen === "conflict") throw HttpError.conflict(RESTRICTION_CODES.alreadyOpen, DETAIL.alreadyOpen);
    return { created: false, outcome: await readOpened(tx, winner) };
  }
  const caseId = row.id;

  // 5 긴급 조치의 효과 — 학원의 게시 제한·정산 보류만 행이 생긴다. 같은 종류가 이미 열려 있으면 그 행을 그대로 둔다
  const restrictionKind = input.urgent ? academyRestrictionKindFor(input.subjectKind, input.plannedMeasure) : null;
  if (restrictionKind !== null) {
    await tx.execute(
      tx.raw.sql`INSERT INTO academy_restrictions (id, academy_id, kind, reason, source_case_id, started_at)
                 VALUES (uuidv7(), ${input.subjectId}::uuid, ${restrictionKind}, ${input.reasonCode}, ${caseId}::uuid, ${input.now}::timestamptz)
                 ON CONFLICT (academy_id, kind) WHERE ended_at IS NULL DO NOTHING`
        .affectedCount()
        .build(),
    );
  }

  // 6 대상에게 사유 통지
  await notifySubject(tx, {
    caseId,
    kind: input.subjectKind,
    id: input.subjectId,
    state,
    text: restrictionNoticeText({ urgent: input.urgent, measure: input.plannedMeasure, reasonText: input.reasonText }),
  });

  // 7 감사 1행 — 「운영자가 이용을 제한하면 사유와 함께 기록된다」(FR-254). 사유 글은 after 와 reason 칸 둘 다에 남는다
  const after = {
    state,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    source: input.source,
    sourceReportId: input.sourceReportId,
    reasonCode: input.reasonCode,
    reasonText: input.reasonText,
    plannedMeasure: input.plannedMeasure,
    urgent: input.urgent,
    academyRestrictionKind: restrictionKind,
  };
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                       after, reason)
               VALUES (uuidv7(), 'staff', ${input.openedByStaffAccountId}::uuid, 'admin', NULLIF(${cols.academyId}, '')::uuid,
                       'restriction.opened', 'restriction_cases', ${caseId}::uuid, ${JSON.stringify(after)}::json, ${input.reasonText})`
      .affectedCount()
      .build(),
  );
  return { created: true, outcome: await readOpened(tx, caseId) };
}

/** 운영자가 직접 여는 절차(POST /api/admin/restrictions) — 재생·대상 확인 뒤 openRestrictionCaseInTx */
export async function openRestrictionCase(
  deps: RestrictionDeps,
  input: { staffAccountId: string; idempotencyKey: string; body: OpenRestriction },
): Promise<OpenRestrictionResult> {
  const now = deps.clock().toString();
  const { body } = input;
  return deps.db.transaction(async (tx) => {
    // 1 재생 — 검사보다 먼저. 같은 열쇠는 처음 결과를 돌려준다
    const replayId = await findCaseIdByKey(tx, input.staffAccountId, input.idempotencyKey);
    if (replayId !== null) return { created: false, outcome: await readOpened(tx, replayId) };

    // 2 대상이 있나
    if (!(await subjectExists(tx, body.subjectKind, body.subjectId))) throw new HttpError("NOT_FOUND", DETAIL.subjectNotFound);

    return openRestrictionCaseInTx(tx, {
      subjectKind: body.subjectKind,
      subjectId: body.subjectId,
      source: "operator_manual",
      sourceReportId: null,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      plannedMeasure: body.plannedMeasure,
      urgent: body.urgent,
      explanationDays: body.explanationDays,
      openedByStaffAccountId: input.staffAccountId,
      idempotencyKey: input.idempotencyKey,
      now,
      onAlreadyOpen: "conflict",
    });
  });
}

/** 이용 제한 경로의 처리기 — 관리자 웹(2단계 인증) 운영자만 */
export function createRestrictionRoutes(deps: RestrictionDeps) {
  const consoleRoute = createConsoleRoute(deps);

  /** `POST /api/admin/restrictions` — 처음 201, 같은 열쇠 재생 200. 순서: 인증 → 열쇠(400) → 본문(422) */
  const open = consoleRoute<unknown>({ permission: "admin" }, async (request, _context, staff) => {
    const idempotencyKey = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, openRestrictionSchema);
    const result = await openRestrictionCase(deps, { staffAccountId: staff.actor.accountId, idempotencyKey, body });
    return Response.json(restrictionOpenedSchema.parse(result.outcome), { status: result.created ? 201 : 200, headers: NO_STORE });
  });

  return { open };
}
