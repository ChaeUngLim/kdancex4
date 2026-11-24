// S2-3.12(공개 뒤 수업 수정 요청 API) — 공개된 수업을 고친다. 값마다 「바로 바뀜 / 대표 재승인 / 못 바꿈」 세 갈래로 나눠 처리한다.
//   계약: _workspace/03_contracts/11-instructor.md §5(공개 뒤 수업 수정) · §7(알림 종류) · 열린 점 ⑬
//   경로: POST /api/classes/{classId}/edit-requests                                         (올린 사람 · 대표)
//         POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw                (요청한 사람)
//         POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve       (그 학원 대표)
//         POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject        (그 학원 대표, 사유 필수)
//   데이터: data-model §8-5 class_edit_requests · §8-7(상태 값) · §8-8(상태 전이)
//   요구: FR-050a(수업 등록 승인) · Q38(수업 수정 제한) · O-05(정원·가격 변경 규칙) · FR-099d(환불 마감일은 늦추기만) · FR-284(주문 시점 값 고정)
//
// 흐름 한눈에:
//   요청 ─▶ 소개 문구·포스터는 지금 classes 에 쓴다(감사 class.updated)
//        └▶ 금액·일정·정원·환불 마감일이 있으면 class_edit_requests 1행(pending) + 대표 알림 class_edit_requested
//           — 승인 전까지 classes·class_offerings·seat_pools 는 그대로라 회원에게는 고치기 전 값이 보인다
//   pending ─approve─▶ approved : 새 값을 판매 단위·자리 묶음·회차·저장 값에 쓰고, 강사 알림 + (일정이 바뀌면) 결제 회원 알림 class_changed
//           ─reject──▶ rejected : 사유만 남기고 옛 값 그대로, 강사 알림(사유)
//           ─withdraw▶ withdrawn: 요청한 사람이 취소
//   상태 전이는 모두 「pending 일 때만」 조건으로 걸러서, 승인과 취소가 동시에 와도 한쪽만 통과한다.
//
// 정원·금액 규칙은 S2-3.3(정원·가격 변경 규칙)의 class-capacity-price.ts 를 그대로 쓴다(요청 때 422, 승인 때 다시 잠그고 409).
// 두 번 검사하는 이유: 요청과 승인 사이에 결제가 들어와 자리가 찼을 수 있다(계약 11 §5).
import { z } from "zod";

import {
  changedFieldsOf,
  editChangesSchema,
  judgeRefundDeadlineChange,
  lockedFieldsIn,
  mergeApprovedPayload,
  planScheduleMove,
  splitEditChanges,
  storedApprovalChangesSchema,
  type ApprovalChanges,
  type ExistingSession,
  type ImmediateChanges,
  type SessionMove,
} from "../../domain/class-edit-request";
import { offeringLabel, readClassPayload, type ClassPayload } from "../../domain/class-registration";
import { CLASS_EDIT_REQUEST_STATUSES } from "../../domain/constants";
import { checkRefundDeadline } from "../../domain/refund-deadline";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseWith, readIdempotencyKey, withRoute } from "../http";
import { currentRevisionNo } from "./class-approval";
import { applyCapacityPriceChange, checkCapacityPriceChange } from "./class-capacity-price";
import { assertUsablePoster } from "./class-poster";
import { classRegistrationSchema, createClassAccess, findClass, respondWith, type ClassRow, type Writer } from "./class-registration";
import { assertNoScheduleConflict, lockScheduleOwners, toScheduleConflictFromDb } from "./class-schedule-conflicts";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

const DETAIL = {
  notFound: "수업을 찾을 수 없어요",
  editNotFound: "수정 요청을 찾을 수 없어요",
  forbidden: "이 수정 요청을 다룰 권한이 없어요",
  locked: "다른 수업이 돼요, 새로 등록해 주세요",
  notPublished: "공개된 수업만 이렇게 고칠 수 있어요",
  state: "이미 처리된 수정 요청이에요",
  open: "이 수업에는 이미 승인을 기다리는 수정 요청이 있어요",
  validation: "입력값을 확인해 주세요",
  empty: "바꿀 값을 넣어 주세요",
  deadlineAdvance: "결제한 회원이 있어 환불 마감일을 앞당길 수 없어요. 늦추기만 할 수 있어요",
  deadlineNotNeeded: "이 수업에는 환불 마감일이 없어요",
  reason: "사유를 적어야 보낼 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 응답 계약(11 §5) -----------------------------------------------------------------------------

export const classEditRequestSchema = z.strictObject({
  editRequestId: z.uuid(),
  classId: z.uuid(),
  status: z.enum(CLASS_EDIT_REQUEST_STATUSES),
  changes: z.record(z.string(), z.unknown()),
  before: z.record(z.string(), z.unknown()),
  rejectReason: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  // 대표 화면(O5)의 「결제한 회원 N명 · 승인하면 알림이 가요」 재료
  impact: z.strictObject({ paidCount: z.int().min(0), notifyOnApprove: z.boolean() }),
});
export type ClassEditRequestView = z.infer<typeof classEditRequestSchema>;

/** 요청 응답 — 바로 바뀌는 값만이면 200 immediate, 재승인 값이 있으면 201 pending_approval(계약 11 §5 「응답」) */
export const classEditCreateResponseSchema = z.discriminatedUnion("applied", [
  z.strictObject({ applied: z.literal("immediate"), class: classRegistrationSchema }),
  z.strictObject({ applied: z.literal("pending_approval"), immediateApplied: z.array(z.string()), editRequest: classEditRequestSchema }),
]);
/** 취소·승인·반려 응답 — 요청 한 건과 그 뒤의 수업(승인이면 새 값, 아니면 옛 값) */
export const classEditDecisionResponseSchema = z.strictObject({ editRequest: classEditRequestSchema, class: classRegistrationSchema });

const editBodySchema = z.strictObject({ changes: z.record(z.string(), z.unknown()) });
const rejectBodySchema = z.strictObject({
  reason: z.string(DETAIL.reason).trim().min(1, DETAIL.reason).max(200, "사유는 200자까지 적을 수 있어요"),
});
const emptyBodySchema = z.strictObject({});
const idSchema = z.uuid();

// ---- 행 읽기 ---------------------------------------------------------------------------------

const EDIT_ROW = {
  id: "pg/uuid@1",
  class_id: "pg/uuid@1",
  academy_id: "pg/uuid@1",
  requested_by: "pg/uuid@1",
  status: "pg/text@1",
  changes: "pg/text@1",
  before: "pg/text@1",
  reject_reason: "pg/text@1",
  created_at: "pg/text@1",
  decided_at: "pg/text@1",
} as const;
type EditRow = {
  id: string;
  class_id: string;
  academy_id: string;
  requested_by: string;
  status: string;
  changes: string;
  before: string;
  reject_reason: string;
  created_at: string;
  decided_at: string;
};

const ISO_US = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** 수정 요청 한 건(수업의 학원과 함께). forUpdate 면 그 행을 잠근다 — 승인·반려·취소가 동시에 오면 줄을 세운다 */
async function findEdit(db: Db | Tx, editId: string, forUpdate = false): Promise<EditRow | null> {
  const base = db.raw.sql`SELECT e.id, e.class_id, c.academy_id, e.requested_by_account_id AS requested_by, e.status,
                                 e.changes::text AS changes, e.before::text AS before, COALESCE(e.reject_reason, '') AS reject_reason,
                                 to_char(e.created_at AT TIME ZONE 'UTC', ${ISO_US}) AS created_at,
                                 COALESCE(to_char(e.decided_at AT TIME ZONE 'UTC', ${ISO_US}), '') AS decided_at
                          FROM class_edit_requests e JOIN classes c ON c.id = e.class_id
                          WHERE e.id = ${editId}::uuid`;
  const query = forUpdate
    ? db.raw.sql`SELECT e.id, e.class_id, c.academy_id, e.requested_by_account_id AS requested_by, e.status,
                        e.changes::text AS changes, e.before::text AS before, COALESCE(e.reject_reason, '') AS reject_reason,
                        to_char(e.created_at AT TIME ZONE 'UTC', ${ISO_US}) AS created_at,
                        COALESCE(to_char(e.decided_at AT TIME ZONE 'UTC', ${ISO_US}), '') AS decided_at
                 FROM class_edit_requests e JOIN classes c ON c.id = e.class_id
                 WHERE e.id = ${editId}::uuid
                 FOR UPDATE OF e`
    : base;
  const [row] = await db.query(query.returnsRow(EDIT_ROW).build());
  return row ?? null;
}

/** 요청 한 건 → 응답 모양. paidCount 는 지금 확정 인원(결제한 회원) */
function toView(row: EditRow, paidCount: number): ClassEditRequestView {
  const changes = JSON.parse(row.changes) as Record<string, unknown>;
  return classEditRequestSchema.parse({
    editRequestId: row.id,
    classId: row.class_id,
    status: row.status,
    changes,
    before: JSON.parse(row.before) as Record<string, unknown>,
    rejectReason: row.reject_reason === "" ? null : row.reject_reason,
    requestedAt: Temporal.Instant.from(row.created_at).toString(),
    decidedAt: row.decided_at === "" ? null : Temporal.Instant.from(row.decided_at).toString(),
    // 금액·정원 변경은 결제한 회원에게 알리지 않는다(계약 11 §5) — 요일·시간·기간이 바뀔 때만 알림이 간다
    impact: { paidCount, notifyOnApprove: changes["schedule"] !== undefined && paidCount > 0 },
  });
}

/** 이 수업의 회차 전부(seq 순) — 일정 변경이 어느 회차를 옮기는지 계산하는 재료 */
async function readSessions(db: Db | Tx, classId: string): Promise<ExistingSession[]> {
  const rows = await db.query(
    db.raw.sql`SELECT s.id, s.seq, s.status,
                      to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_US}) AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_US}) AS ends_at
               FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
               WHERE o.class_id = ${classId}::uuid
               ORDER BY s.seq`
      .returnsRow({ id: "pg/uuid@1", seq: "pg/int4@1", status: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1" })
      .build(),
  );
  return rows.map((r) => ({
    sessionId: r.id,
    seq: r.seq,
    status: r.status,
    startsAt: Temporal.Instant.from(r.starts_at),
    endsAt: Temporal.Instant.from(r.ends_at),
  }));
}

/** 판매 단위의 환불 마감일과 잡힌 자리 수(결제 대기 + 확정) — 마감일 앞당기기 판정 재료 */
async function readDeadlineState(db: Db | Tx, classId: string): Promise<{ deadlineOn: string | null; reserved: number }> {
  const [row] = await db.query(
    db.raw.sql`SELECT COALESCE(to_char(min(o.refund_deadline_on), 'YYYY-MM-DD'), '') AS deadline_on,
                      COALESCE((SELECT sum(p.held_count + p.confirmed_count) FROM seat_pools p JOIN class_offerings o2 ON o2.id = p.offering_id
                                WHERE o2.class_id = ${classId}::uuid), 0)::int4 AS reserved
               FROM class_offerings o WHERE o.class_id = ${classId}::uuid`
      .returnsRow({ deadline_on: "pg/text@1", reserved: "pg/int4@1" })
      .build(),
  );
  return { deadlineOn: row === undefined || row.deadline_on === "" ? null : row.deadline_on, reserved: row?.reserved ?? 0 };
}

// ---- 판정 묶음(요청 때 · 승인 때 같은 규칙) --------------------------------------------------------

const invalid = (problems: { path: string; message: string }[]) => new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: problems });

/**
 * 환불 마감일 판정 — ① 이 수업에 마감일이 있어야 하는가(유료 이벤트형만) ② 결제한 회원이 있으면 앞당기기 금지(409)
 * ③ 개최일(첫 회차의 KST 날짜) 당일까지만(S2-2.6 판정 그대로, 422).
 */
function assertRefundDeadline(
  payload: ClassPayload,
  nextDeadline: string,
  state: { deadlineOn: string | null; reserved: number },
  firstStartsAt: Temporal.Instant,
  priceAmount: number,
): void {
  const verdict = checkRefundDeadline({ classKind: payload.classKind, priceAmount, refundDeadlineOn: nextDeadline, firstSessionStartsAt: firstStartsAt });
  if (verdict.ok && verdict.deadlineOn === null) {
    throw invalid([{ path: "changes.refundDeadlineOn", message: DETAIL.deadlineNotNeeded }]);
  }
  if (!judgeRefundDeadlineChange(state.deadlineOn, nextDeadline, state.reserved).ok) {
    throw HttpError.conflict("REFUND_DEADLINE_ADVANCE_BLOCKED", DETAIL.deadlineAdvance);
  }
  if (!verdict.ok) {
    throw HttpError.unprocessable(verdict.code, verdict.message, { fields: [{ path: "changes.refundDeadlineOn", message: verdict.message }] });
  }
}

/** 일정 변경 판정 — 회차 수가 같아야 하고, 옮길 회차는 미래로만(열린 점 ⑬). 통과하면 옮길 목록 */
function judgeSchedule(payload: ClassPayload, approval: ApprovalChanges, sessions: readonly ExistingSession[], now: Temporal.Instant) {
  if (approval.schedule === undefined) return null;
  const verdict = planScheduleMove({ schedule: approval.schedule, classKind: payload.classKind, existing: sessions, now });
  if (!verdict.ok) {
    if (verdict.code === "EDIT_SESSION_COUNT_CHANGED") {
      throw HttpError.unprocessable("EDIT_SESSION_COUNT_CHANGED", verdict.problems[0]?.message ?? DETAIL.validation, { fields: verdict.problems });
    }
    throw invalid(verdict.problems);
  }
  return verdict;
}

/** 첫 회차 시작(일정 변경이 있으면 바뀐 뒤 값) — 환불 마감일 판정의 개최일 */
function firstStartOf(sessions: readonly { startsAt: Temporal.Instant }[]): Temporal.Instant | null {
  return sessions.reduce<Temporal.Instant | null>((min, s) => (min === null || Temporal.Instant.compare(s.startsAt, min) < 0 ? s.startsAt : min), null);
}

// ---- 경로 ----------------------------------------------------------------------------------

type ClassParams = { params: Promise<{ classId: string }> };
type EditParams = { params: Promise<{ classId: string; editRequestId: string }> };
type AcademyEditParams = { params: Promise<{ academyId: string; editRequestId: string }> };

export type ClassEditRequestDeps = GuardDeps & { clock?: Clock };

export function createClassEditRequestRoutes(deps: ClassEditRequestDeps) {
  const { readStaff, requireClassAccess, loadClass } = createClassAccess(deps);
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** 본문을 읽는다. 비어 있으면 emptyAs. JSON 이 아니면 400 */
  async function readBody(request: Request, emptyAs: unknown): Promise<unknown> {
    const text = await request.text();
    if (text.trim() === "") return emptyAs;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
  }

  /** 요청 한 건 + 그 수업의 응답 한 벌 */
  async function decisionBody(editId: string): Promise<Response> {
    const edit = await findEdit(db, editId);
    const row = edit === null ? null : await findClass(db, edit.class_id);
    if (edit === null || row === null) throw new Error("수정 요청을 다시 읽지 못했다");
    return Response.json(
      classEditDecisionResponseSchema.parse({ editRequest: toView(edit, row.paid_count), class: await respondWith(db, row) }),
      { headers: NO_STORE },
    );
  }

  // ---- ① POST /api/classes/{classId}/edit-requests — 공개된 수업 고치기 ------------------------------

  const create = withRoute<ClassParams>(async (request, context) => {
    const staff = await readStaff(request);
    const key = readIdempotencyKey(request, { required: true });
    const row = await loadClass(context);
    const writer = await requireClassAccess(request, staff, row);

    // 같은 사람 · 같은 키의 재승인 요청이 이미 있으면 처음 결과(본문이 달라도 처음 것, 계약 11 §0)
    const replay = await findReplay(writer.accountId, key);
    if (replay !== null) return replay;

    // 본문 — 잠긴 칸(학원·장르·세부 장르·종목·수업 구분)이 있으면 422 CLASS_FIELD_LOCKED, 모르는 칸은 422 VALIDATION_FAILED
    const { changes: raw } = parseWith(editBodySchema, await readBody(request, {}));
    const locked = lockedFieldsIn(raw);
    if (locked.length > 0) {
      throw HttpError.unprocessable("CLASS_FIELD_LOCKED", DETAIL.locked, {
        fields: locked.map((field) => ({ path: `changes.${field}`, message: DETAIL.locked })),
      });
    }
    const changes = parseWith(editChangesSchema, raw);
    const { immediate, approval } = splitEditChanges(changes);
    if (changedFieldsOf(immediate).length === 0 && changedFieldsOf(approval).length === 0) {
      throw invalid([{ path: "changes", message: DETAIL.empty }]);
    }
    // 공개된 수업에만 — 임시 저장·승인 대기 수업은 PUT·등록 취소 흐름을 쓴다(계약 11 §4)
    if (row.status !== "published") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notPublished);

    const payload = readClassPayload(row.payload);
    const hasApproval = changedFieldsOf(approval).length > 0;
    const before = hasApproval ? await judgeApprovalAtRequest(row, payload, approval, writer) : {};

    // 한 트랜잭션: 바로 바뀌는 값 쓰기 · 요청 행 · 대표 알림 · 감사
    let editId: string | null = null;
    try {
      editId = await db.transaction(async (tx) => {
        if (immediate.posterFileId != null) await assertUsablePoster(tx, writer.accountId, row.id, immediate.posterFileId);
        await applyImmediate(tx, row, payload, immediate, writer, key);
        if (!hasApproval) return null;
        return insertEditRequest(tx, row, payload, approval, before, writer, key);
      });
    } catch (error) {
      // 같은 수업에 열린 요청이 이미 있다(uq_class_edit_open) — 앞의 판정을 빠져나간 동시 요청도 여기서 막힌다
      if (violates(error, "uq_class_edit_open")) throw HttpError.conflict("EDIT_REQUEST_OPEN", DETAIL.open);
      // 같은 키로 동시에 두 번 — 먼저 들어간 것을 돌려준다
      if (violates(error, "uq_class_edit_idem")) {
        const again = await findReplay(writer.accountId, key);
        if (again !== null) return again;
      }
      throw error;
    }

    const after = await findClass(db, row.id);
    if (after === null) throw new Error("고친 수업을 다시 읽지 못했다");
    if (editId === null) {
      return Response.json(classEditCreateResponseSchema.parse({ applied: "immediate", class: await respondWith(db, after) }), {
        headers: NO_STORE,
      });
    }
    const edit = await findEdit(db, editId);
    if (edit === null) throw new Error("만든 수정 요청을 다시 읽지 못했다");
    return Response.json(
      classEditCreateResponseSchema.parse({
        applied: "pending_approval",
        immediateApplied: changedFieldsOf(immediate),
        editRequest: toView(edit, after.paid_count),
      }),
      { status: 201, headers: NO_STORE },
    );
  });

  /** 같은 사람 · 같은 키의 요청이 있으면 처음 응답(201 → 200). 바로 바뀐 칸은 그때 남긴 감사 기록에서 읽는다 */
  async function findReplay(accountId: string, key: string): Promise<Response | null> {
    const [hit] = await db.query(
      db.raw.sql`SELECT e.id,
                        COALESCE((SELECT a.after->>'fields' FROM audit_logs a
                                  WHERE a.action = 'class.updated' AND a.target_id = e.class_id AND a.after->>'idempotencyKey' = ${key}
                                    AND a.actor_staff_account_id = ${accountId}::uuid LIMIT 1), '[]') AS fields
                 FROM class_edit_requests e
                 WHERE e.requested_by_account_id = ${accountId}::uuid AND e.idempotency_key = ${key}`
        .returnsRow({ id: "pg/uuid@1", fields: "pg/text@1" })
        .build(),
    );
    if (hit === undefined) return null;
    const edit = await findEdit(db, hit.id);
    const row = edit === null ? null : await findClass(db, edit.class_id);
    if (edit === null || row === null) return null;
    return Response.json(
      classEditCreateResponseSchema.parse({
        applied: "pending_approval",
        immediateApplied: z.array(z.string()).parse(JSON.parse(hit.fields)),
        editRequest: toView(edit, row.paid_count),
      }),
      { status: 200, headers: NO_STORE },
    );
  }

  /**
   * 요청 때의 재승인 값 판정(잠그지 않는다 — 승인 때 잠그고 다시 본다). 통과하면 「전」 값을 돌려준다.
   *   열린 요청 있음 409 → 정원·금액(S2-3.3, 422) → 일정(회차 수 422 · 겹침 409) → 환불 마감일(앞당기기 409 · 개최일 뒤 422)
   */
  async function judgeApprovalAtRequest(row: ClassRow, payload: ClassPayload, approval: ApprovalChanges, writer: Writer) {
    const [open] = await db.query(
      db.raw.sql`SELECT id FROM class_edit_requests WHERE class_id = ${row.id}::uuid AND status = 'pending'`.returnsRow({ id: "pg/uuid@1" }).build(),
    );
    if (open !== undefined) throw HttpError.conflict("EDIT_REQUEST_OPEN", DETAIL.open);

    const before: Record<string, unknown> = {};
    if (approval.capacity !== undefined || approval.priceAmount !== undefined) {
      const snapshot = await checkCapacityPriceChange(db, row.id, { capacity: approval.capacity, priceAmount: approval.priceAmount }, "request");
      if (approval.priceAmount !== undefined) before["priceAmount"] = snapshot.priceAmount;
      if (approval.capacity !== undefined) before["capacity"] = snapshot.capacity;
    }

    const sessions = await readSessions(db, row.id);
    const move = judgeSchedule(payload, approval, sessions, clock());
    if (move !== null) {
      before["schedule"] = payload.schedule;
      // 새 시각이 다른 수업·다른 학원 일정과 겹치면 지금 알려 준다(승인 때 잠금 안에서 한 번 더 본다)
      await assertNoScheduleConflict(db, {
        academyId: row.academy_id,
        instructorAccountId: row.instructor_id,
        roomId: payload.roomId,
        sessions: move.moves.map((m) => m.after),
        callerIsOwner: writer.isOwner,
        excludeClass: { classId: row.id, academyId: row.academy_id },
      });
    }

    if (approval.refundDeadlineOn !== undefined) {
      const state = await readDeadlineState(db, row.id);
      const first = firstStartOf(move?.finalSessions ?? sessions);
      if (first === null) throw new Error("회차가 없는 공개 수업이다");
      assertRefundDeadline(payload, approval.refundDeadlineOn, state, first, approval.priceAmount ?? payload.priceAmount ?? 0);
      before["refundDeadlineOn"] = state.deadlineOn;
    }
    return before;
  }

  // ---- ② POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw — 요청 취소 ---------------

  const withdraw = withRoute<EditParams>(async (request, context) => {
    const staff = await readStaff(request);
    const { classId, editRequestId } = await context.params;
    if (!idSchema.safeParse(classId).success || !idSchema.safeParse(editRequestId).success) throw new HttpError("NOT_FOUND", DETAIL.editNotFound);
    parseWith(emptyBodySchema, await readBody(request, {}));
    const edit = await findEdit(db, editRequestId);
    if (edit === null || edit.class_id !== classId) throw new HttpError("NOT_FOUND", DETAIL.editNotFound);
    // 요청한 사람만 취소한다(계약 11 §5 「올린 사람」)
    if (edit.requested_by !== staff.staffAccountId) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    if (edit.status === "withdrawn") return decisionBody(edit.id);
    if (edit.status !== "pending") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    // 조건부 갱신 한 문장 — 그 사이 대표가 승인·반려했으면 0행 = 409
    const moved = await db.execute(
      db.raw.sql`UPDATE class_edit_requests SET status = 'withdrawn' WHERE id = ${edit.id}::uuid AND status = 'pending'`.affectedCount().build(),
    );
    if (moved.affectedRows === 0) {
      const after = await findEdit(db, edit.id);
      if (after?.status !== "withdrawn") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    }
    return decisionBody(edit.id);
  });

  // ---- 대표 경로 공통 ---------------------------------------------------------------------------

  /** 그 학원 대표만(위임 강사·강사·다른 학원 대표 403). 경로의 학원과 요청 수업의 학원이 다르면 404 */
  async function requireOwnerEdit(request: Request, context: AcademyEditParams) {
    const { academyId, editRequestId } = await context.params;
    if (!idSchema.safeParse(academyId).success || !idSchema.safeParse(editRequestId).success) throw new HttpError("NOT_FOUND", DETAIL.editNotFound);
    const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
    const owner = await guards.requireStaff("owner", { academyId, surface: bearer ? "app" : "web", headers: request.headers });
    const edit = await findEdit(db, editRequestId);
    if (edit === null || edit.academy_id !== academyId) throw new HttpError("NOT_FOUND", DETAIL.editNotFound);
    return { owner, edit };
  }

  /** 트랜잭션 안에서 「이미 같은 결과」를 알리는 표시 — 밖에서 200 같은 본문으로 바꾼다 */
  const ALREADY = Symbol("already");

  // ---- ③ POST …/class-edit-requests/{id}/approve — 승인: 새 값을 쓴다 -------------------------------

  const approve = withRoute<AcademyEditParams>(async (request, context) => {
    const { owner, edit } = await requireOwnerEdit(request, context);
    parseWith(emptyBodySchema, await readBody(request, {}));
    if (edit.status === "approved") return decisionBody(edit.id);
    if (edit.status !== "pending") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    const now = clock();
    try {
      await db.transaction(async (tx) => {
        // 요청 행을 잠그고 상태를 다시 본다 — 취소·반려·다른 승인과 줄을 세운다
        const locked = await findEdit(tx, edit.id, true);
        if (locked === null) throw new HttpError("NOT_FOUND", DETAIL.editNotFound);
        if (locked.status === "approved") throw ALREADY;
        if (locked.status !== "pending") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
        const row = await findClass(tx, locked.class_id);
        if (row === null || row.status !== "published") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.notPublished);

        const approval = storedApprovalChangesSchema.parse(JSON.parse(locked.changes));
        const payload = readClassPayload(row.payload);
        await applyApproval(tx, row, payload, approval, locked.id, now);

        await tx.execute(
          tx.raw.sql`UPDATE class_edit_requests SET status = 'approved', decided_by_account_id = ${owner.staffAccountId}::uuid,
                            decided_at = ${now.toString()}::timestamptz
                     WHERE id = ${locked.id}::uuid AND status = 'pending'`
            .affectedCount()
            .build(),
        );
        await insertApprovalRecord(tx, row.id, "edit_approved", owner.staffAccountId);
        await notifyRequester(tx, row, locked, owner.staffAccountId, "class_edit_approved", {
          classId: row.id,
          editRequestId: locked.id,
          title: payload.title,
          changedFields: changedFieldsOf(approval),
        });
        await insertAudit(tx, owner.staffAccountId, "owner", row, "class_edit.approved", "class_edit_requests", locked.id, {
          changes: approval,
          before: JSON.parse(locked.before) as unknown,
        });
      });
    } catch (error) {
      if (error === ALREADY) return decisionBody(edit.id);
      const overlap = toScheduleConflictFromDb(error);
      if (overlap !== null) throw overlap;
      throw error;
    }
    return decisionBody(edit.id);
  });

  /**
   * 승인된 값을 실제로 쓴다(호출한 쪽의 트랜잭션 안).
   *   ① 정원·금액 — S2-3.3 의 applyCapacityPriceChange(자리 묶음을 잠그고 다시 판정, 하한 미달 409). 주문은 건드리지 않는다
   *   ② 일정 — 강사·홀 잠금 → 회차 수·미래 판정 → 겹침 판정 → 시작 전 회차만 옮김 + 회원 캘린더 + 판매 단위 기간 + 결제 회원 알림
   *   ③ 환불 마감일 — 앞당기기·개최일 판정을 다시 하고 판매 단위에 쓴다
   *   ④ 수업 저장 값(registration_payload)에 합친다 — 상세 화면이 새 값을 보인다
   */
  async function applyApproval(tx: Tx, row: ClassRow, payload: ClassPayload, approval: ApprovalChanges, editId: string, now: Temporal.Instant) {
    if (approval.capacity !== undefined || approval.priceAmount !== undefined) {
      await applyCapacityPriceChange(tx, row.id, { capacity: approval.capacity, priceAmount: approval.priceAmount });
    }

    let finalSessions: { startsAt: Temporal.Instant; endsAt: Temporal.Instant }[] | null = null;
    if (approval.schedule !== undefined) {
      if (row.instructor_id === "") throw new Error("담당 강사가 없는 공개 수업이다");
      await lockScheduleOwners(tx, row.instructor_id, payload.roomId);
      const move = judgeSchedule(payload, approval, await readSessions(tx, row.id), now);
      if (move === null) throw new Error("일정 변경 판정이 비었다");
      await assertNoScheduleConflict(tx, {
        academyId: row.academy_id,
        instructorAccountId: row.instructor_id,
        roomId: payload.roomId,
        sessions: move.moves.map((m) => m.after),
        callerIsOwner: true,
        excludeClass: { classId: row.id, academyId: row.academy_id },
      });
      await moveSessions(tx, row, move.moves, move.finalSessions, approval);
      await notifyPaidMembers(tx, row, payload, approval, editId);
      finalSessions = move.finalSessions;
    }

    if (approval.refundDeadlineOn !== undefined) {
      const state = await readDeadlineState(tx, row.id);
      const first = firstStartOf(finalSessions ?? (await readSessions(tx, row.id)));
      if (first === null) throw new Error("회차가 없는 공개 수업이다");
      assertRefundDeadline(payload, approval.refundDeadlineOn, state, first, approval.priceAmount ?? payload.priceAmount ?? 0);
      await tx.execute(
        tx.raw.sql`UPDATE class_offerings SET refund_deadline_on = ${approval.refundDeadlineOn}::date, updated_at = now()
                   WHERE class_id = ${row.id}::uuid`
          .affectedCount()
          .build(),
      );
    }

    const merged = mergeApprovedPayload(payload, approval);
    await tx.execute(
      tx.raw.sql`UPDATE classes SET registration_payload = ${JSON.stringify(merged)}::json, updated_at = now() WHERE id = ${row.id}::uuid`
        .affectedCount()
        .build(),
    );
  }

  // ---- ④ POST …/class-edit-requests/{id}/reject — 반려: 옛 값 그대로 + 사유 ------------------------------

  const reject = withRoute<AcademyEditParams>(async (request, context) => {
    const { owner, edit } = await requireOwnerEdit(request, context);
    const { reason } = parseWith(rejectBodySchema, await readBody(request, {}));
    // 같은 사유로 이미 반려됐으면 같은 본문(두 번 눌러도 알림이 두 번 가지 않는다). 그 밖에 끝난 요청은 409
    if (edit.status === "rejected" && edit.reject_reason === reason) return decisionBody(edit.id);
    if (edit.status !== "pending") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    const now = clock();
    const lost = HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    try {
      await db.transaction(async (tx) => {
        // 조건부 갱신 한 문장 — 승인·취소가 먼저였으면 0행
        const moved = await tx.execute(
          tx.raw.sql`UPDATE class_edit_requests SET status = 'rejected', reject_reason = ${reason},
                            decided_by_account_id = ${owner.staffAccountId}::uuid, decided_at = ${now.toString()}::timestamptz
                     WHERE id = ${edit.id}::uuid AND status = 'pending'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw lost;
        const row = await findClass(tx, edit.class_id);
        if (row === null) throw new Error("반려할 수업을 읽지 못했다");
        // 승인 기록의 사유 칸은 대표의 「수정 요청(revision_requested)」에만 쓰는 칸이다(ck_class_approvals_reason) —
        // 반려 사유는 class_edit_requests.reject_reason 과 강사 알림에 남긴다
        await insertApprovalRecord(tx, row.id, "edit_rejected", owner.staffAccountId);
        await notifyRequester(tx, row, edit, owner.staffAccountId, "class_edit_rejected", {
          classId: row.id,
          editRequestId: edit.id,
          title: readClassPayload(row.payload).title,
          reason,
        });
        await insertAudit(tx, owner.staffAccountId, "owner", row, "class_edit.rejected", "class_edit_requests", edit.id, { reason });
      });
    } catch (error) {
      if (error !== lost) throw error;
      const after = await findEdit(db, edit.id);
      if (after?.status === "rejected" && after.reject_reason === reason) return decisionBody(edit.id);
      throw error;
    }
    return decisionBody(edit.id);
  });

  return { create, withdraw, approve, reject };
}

// ---- 같은 트랜잭션에 쓰는 것들 ----------------------------------------------------------------

/** DB 오류가 그 제약(이름 앞부분) 위반인가 — 드라이버가 오류를 몇 겹 감싸도 cause 를 따라 내려가며 본다 */
function violates(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { constraint?: unknown; message?: unknown; cause?: unknown };
    if (`${String(e.constraint ?? "")} ${String(e.message ?? "")}`.includes(constraint)) return true;
    current = e.cause;
  }
  return false;
}

/** ① 바로 바뀌는 값 — 소개 문구(칸 + 저장 값)와 포스터를 지금 쓰고 감사 class.updated. 보낸 칸이 없으면 아무것도 안 한다 */
async function applyImmediate(tx: Tx, row: ClassRow, payload: ClassPayload, immediate: ImmediateChanges, writer: Writer, key: string) {
  const fields = changedFieldsOf(immediate);
  if (fields.length === 0) return;
  if (immediate.introText !== undefined) {
    const next: ClassPayload = { ...payload, introText: immediate.introText };
    await tx.execute(
      tx.raw.sql`UPDATE classes SET intro_text = NULLIF(${immediate.introText ?? ""}, ''), registration_payload = ${JSON.stringify(next)}::json,
                        updated_at = now()
                 WHERE id = ${row.id}::uuid`
        .affectedCount()
        .build(),
    );
  }
  if (immediate.posterFileId !== undefined) {
    await tx.execute(
      tx.raw.sql`UPDATE classes SET poster_file_id = NULLIF(${immediate.posterFileId ?? ""}, '')::uuid, updated_at = now() WHERE id = ${row.id}::uuid`
        .affectedCount()
        .build(),
    );
  }
  // 멱등키를 감사에 같이 남긴다 — 같은 키로 다시 오면 「그때 바로 바뀐 칸」을 여기서 읽어 처음 응답을 그대로 만든다
  await insertAudit(tx, writer.accountId, writer.isOwner ? "owner" : "instructor", row, "class.updated", "classes", row.id, {
    fields,
    idempotencyKey: key,
  });
}

/** ② 재승인 값 — 요청 행(pending) + 대표 알림(대표가 직접 낸 요청이면 보내지 않는다) + 감사 class_edit.requested */
async function insertEditRequest(
  tx: Tx,
  row: ClassRow,
  payload: ClassPayload,
  approval: ApprovalChanges,
  before: Record<string, unknown>,
  writer: Writer,
  key: string,
): Promise<string> {
  const [inserted] = await tx.query(
    tx.raw.sql`INSERT INTO class_edit_requests (id, class_id, requested_by_account_id, status, changes, before, idempotency_key)
               VALUES (uuidv7(), ${row.id}::uuid, ${writer.accountId}::uuid, 'pending', ${JSON.stringify(approval)}::jsonb,
                       ${JSON.stringify(before)}::jsonb, ${key})
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (inserted === undefined) throw new Error("수정 요청 INSERT 가 행을 돌려주지 않았다");
  if (!writer.isOwner) {
    const notice = JSON.stringify({
      classId: row.id,
      editRequestId: inserted.id,
      title: payload.title,
      instructorName: row.instructor_name,
      changedFields: changedFieldsOf(approval),
      paidCount: row.paid_count,
    });
    await tx.execute(
      tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
                 SELECT uuidv7(), o.staff_account_id, o.academy_id, 'approval', 'class_edit_requested', ${`classedit:${inserted.id}:requested`},
                        ${notice}::jsonb
                 FROM academy_owners o WHERE o.academy_id = ${row.academy_id}::uuid AND o.status = 'active'
                 ON CONFLICT DO NOTHING`
        .affectedCount()
        .build(),
    );
  }
  await insertAudit(tx, writer.accountId, writer.isOwner ? "owner" : "instructor", row, "class_edit.requested", "class_edit_requests", inserted.id, {
    changes: approval,
    before,
  });
  return inserted.id;
}

/**
 * 일정 승인 — 시작 전 회차만 새 시각으로 옮긴다(지난 회차는 그대로, 열린 점 ⑬). 회원 캘린더도 같은 시각으로 맞추고,
 * 판매 단위의 첫·끝 시각·이름·반복 규칙을 바뀐 회차로 다시 쓴다.
 */
async function moveSessions(
  tx: Tx,
  row: ClassRow,
  moves: readonly SessionMove[],
  finalSessions: readonly { startsAt: Temporal.Instant; endsAt: Temporal.Instant }[],
  approval: ApprovalChanges,
) {
  for (const move of moves) {
    await tx.execute(
      tx.raw.sql`UPDATE class_sessions SET starts_at = ${move.after.startsAt.toString()}::timestamptz, ends_at = ${move.after.endsAt.toString()}::timestamptz
                 WHERE id = ${move.sessionId}::uuid`
        .affectedCount()
        .build(),
    );
    await tx.execute(
      tx.raw.sql`UPDATE calendar_entries SET starts_at = ${move.after.startsAt.toString()}::timestamptz, ends_at = ${move.after.endsAt.toString()}::timestamptz
                 WHERE session_id = ${move.sessionId}::uuid`
        .affectedCount()
        .build(),
    );
  }
  const ordered = [...finalSessions].sort((a, b) => Temporal.Instant.compare(a.startsAt, b.startsAt));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return;
  const label = offeringLabel(ordered.map((s, index) => ({ seq: index + 1, startsAt: s.startsAt, endsAt: s.endsAt })));
  const rule = approval.schedule?.kind === "recurring" ? JSON.stringify(approval.schedule) : "";
  await tx.execute(
    tx.raw.sql`UPDATE class_offerings SET first_session_starts_at = ${first.startsAt.toString()}::timestamptz,
                      last_session_ends_at = ${last.endsAt.toString()}::timestamptz, label = ${label},
                      schedule_rule = NULLIF(${rule}, '')::json, updated_at = now()
               WHERE class_id = ${row.id}::uuid`
      .affectedCount()
      .build(),
  );
}

/**
 * 결제한 수강생(확정 예약)에게 전후 값 알림 class_changed — 회원마다 1건(classedit:<요청 id>:<회원 id>).
 * 「못 오면 환불을 요청할 수 있다」는 길을 payload 에 함께 싣는다(계약 11 §5). 결제 대기·대기 신청은 받지 않는다.
 */
async function notifyPaidMembers(tx: Tx, row: ClassRow, payload: ClassPayload, approval: ApprovalChanges, editId: string) {
  const body = JSON.stringify({
    classId: row.id,
    editRequestId: editId,
    title: payload.title,
    before: { schedule: payload.schedule },
    after: { schedule: approval.schedule },
    refundRequestAvailable: true,
  });
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
               SELECT uuidv7(), m.member_id, ${row.academy_id}::uuid, 'class_changed', ${`classedit:${editId}:`} || m.member_id::text, ${body}::jsonb
               FROM (SELECT DISTINCT r.member_id FROM reservations r JOIN class_offerings o ON o.id = r.offering_id
                     WHERE o.class_id = ${row.id}::uuid AND r.status = 'confirmed') m
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 승인 기록 한 줄(추가 전용) — 몇 번째 제출의 수업인지 같은 번호를 쓴다 */
async function insertApprovalRecord(tx: Tx, classId: string, action: "edit_approved" | "edit_rejected", actorId: string) {
  const revisionNo = await currentRevisionNo(tx, classId);
  await tx.execute(
    tx.raw.sql`INSERT INTO class_approvals (id, class_id, action, actor_account_id, revision_no)
               VALUES (uuidv7(), ${classId}::uuid, ${action}, ${actorId}::uuid, ${revisionNo})`
      .affectedCount()
      .build(),
  );
}

/**
 * 요청한 사람에게 결과 알림(operations 칩). 대표가 자기 요청을 스스로 처리했으면 알릴 사람이 없어 보내지 않는다.
 * 열쇠는 classedit:<요청 id>:approved · …:rejected(계약 11 §7) — 같은 결과는 한 번만
 */
async function notifyRequester(
  tx: Tx,
  row: ClassRow,
  edit: EditRow,
  deciderId: string,
  kind: "class_edit_approved" | "class_edit_rejected",
  payload: Record<string, unknown>,
) {
  if (edit.requested_by === deciderId) return;
  const suffix = kind === "class_edit_approved" ? "approved" : "rejected";
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${edit.requested_by}::uuid, ${row.academy_id}::uuid, 'operations', ${kind}, ${`classedit:${edit.id}:${suffix}`},
                       ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 감사 1행 — 수정 요청은 감사 대상(data-model §8-5) */
async function insertAudit(
  tx: Tx,
  actorId: string,
  role: "owner" | "instructor",
  row: ClassRow,
  action: string,
  targetTable: string,
  targetId: string,
  after: Record<string, unknown>,
) {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
               VALUES (uuidv7(), 'staff', ${actorId}::uuid, ${role}, ${row.academy_id}::uuid, ${action}, ${targetTable}, ${targetId}::uuid,
                       ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}
