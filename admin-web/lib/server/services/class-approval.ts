// S2-2.7(대표 승인·반려·게시) — 대표가 승인 대기 수업을 승인(공개)하거나 사유와 함께 수정 요청(반려)한다.
//   계약: _workspace/03_contracts/11-instructor.md §4-5(대표 승인 · 수정 요청) · §4-7(상태 전이) · §7(알림 종류)
//   경로: POST /api/academies/{academyId}/classes/{classId}/approve
//         POST /api/academies/{academyId}/classes/{classId}/request-revision
//   요구: FR-050a(수업 등록 승인) · FR-076(게시 3종 동시 준비) · 플랜 S2-2 수용 ③(반려하면 사유와 함께 돌아가 다시 낼 수 있다)
//
// 흐름 한눈에:
//   pending_approval ─approve─▶ published   + 판매 단위 closed → open(회원 공개 목록에 나온다) + 강사 알림 class_approved
//   pending_approval ─request-revision─▶ draft + 회차·판매 단위·자리 묶음 삭제 + 사유 저장 + 강사 알림 class_revision_requested
//   강사는 draft 가 된 수업을 PUT 으로 고쳐 다시 submit 한다(S2-2.3 의 경로 그대로 — 제출 번호가 2, 3 … 으로 는다).
//
// 왜 「조건부 갱신 한 문장」인가:
//   상태 전이는 `UPDATE … WHERE status = 'pending_approval'` 한 문장으로 한다. 대표가 두 번 누르거나, 강사가 등록을 취소하는
//   순간과 겹쳐도 DB 가 한 쪽만 통과시킨다(영향 0행이면 다른 쪽이 먼저 바꾼 것). 읽고 → 판단하고 → 쓰는 사이의 틈이 없다.
//
// 승인 때 게시 판정을 한 번 더 하는 이유(계약 11 §4-5):
//   승인 요청 뒤 대표가 승인하기까지 시간이 있다. 그 사이 학원이 이용 제한될 수 있어서 S1-1.16(입점 승인)의 canPublish 와
//   S1-3.6(공지 있음)의 assertRefundNoticeForPublish 를 다시 부른다. 공지는 열린 점 ⑱(임시 확정)대로 승인 시점의 최신 판본으로 다시 붙인다.
import { z } from "zod";

import { readClassPayload, refundNoticeKindFor } from "../../domain/class-registration";
import { checkRefundDeadline } from "../../domain/refund-deadline";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffContext } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import { canPublish, createClassPublishGateDeps } from "./class-publish-gate";
import { assertPromoAssetsReviewed, publishPromoCoverFile } from "./class-promo-assets";
import { findClass, respondWith, type ClassRow } from "./class-registration";
import { assertRefundNoticeForPublish } from "./refund-notice-gate";
import type { Tx } from "./staff-signup";

const DETAIL = {
  notFound: "수업을 찾을 수 없어요",
  state: "지금 상태에서는 할 수 없어요",
  restricted: "학원이 이용 제한 중이라 새 수업을 게시할 수 없어요",
  reason: "사유를 적어야 보낼 수 있어요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const idSchema = z.uuid();
/** 승인 본문은 `{}`(비워 보내도 된다). 다른 칸이 있으면 422 */
const approveBodySchema = z.strictObject({});
/** 수정 요청 본문 — 사유 1~200자 필수(O5 「사유를 적어야 보낼 수 있어요」). 앞뒤 공백은 떼고 센다 */
const revisionBodySchema = z.strictObject({
  reason: z.string(DETAIL.reason).trim().min(1, DETAIL.reason).max(200, "사유는 200자까지 적을 수 있어요"),
});

type Params = { params: Promise<{ academyId: string; classId: string }> };

export type ClassApprovalDeps = GuardDeps & { clock?: Clock };

export function createClassApprovalRoutes(deps: ClassApprovalDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /**
   * 그 학원의 대표만 부른다(위임 강사·강사는 403 FORBIDDEN, 계약 11 §4-5).
   * 앱은 Bearer, 관리자 웹은 쿠키(2단계 인증 필수) — 가드가 면에 따라 판정한다.
   * 학원 id 가 UUID 모양이 아니면 그런 학원은 없으니 404 다.
   */
  async function requireOwner(request: Request, context: Params): Promise<{ owner: StaffContext; row: ClassRow }> {
    const { academyId, classId } = await context.params;
    if (!idSchema.safeParse(academyId).success || !idSchema.safeParse(classId).success) {
      throw new HttpError("NOT_FOUND", DETAIL.notFound);
    }
    const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
    const owner = await guards.requireStaff("owner", { academyId, surface: bearer ? "app" : "web", headers: request.headers });
    const row = await findClass(db, classId);
    // 다른 학원의 수업을 이 학원 경로로 부르면 없는 수업으로 본다(경로의 학원과 수업의 학원이 같아야 한다)
    if (row === null || row.academy_id !== academyId) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return { owner, row };
  }

  /** 본문을 읽는다. 비어 있으면 emptyAs 로 본다. JSON 이 아니면 400 */
  async function readBody(request: Request, emptyAs: unknown): Promise<unknown> {
    const text = await request.text();
    if (text.trim() === "") return emptyAs;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
    }
  }

  /** 상태 전이 경주에서 졌을 때 — 이긴 쪽이 원하던 상태면 같은 본문(200), 아니면 409 */
  async function settleRace(classId: string, wanted: (row: ClassRow) => boolean): Promise<Response> {
    const after = await findClass(db, classId);
    if (after === null || !wanted(after)) throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    return Response.json(await respondWith(db, after), { headers: NO_STORE });
  }

  // ---- ① POST …/approve — 승인 → 공개 -------------------------------------------------------------

  const approve = withRoute<Params>(async (request, context) => {
    const { owner, row } = await requireOwner(request, context);
    parseWith(approveBodySchema, await readBody(request, {}));

    // 이미 공개면 같은 본문(두 번 눌러도 알림이 두 번 가지 않는다). 승인 대기가 아니면 409
    if (row.status === "published") return Response.json(await respondWith(db, row), { headers: NO_STORE });
    if (row.status !== "pending_approval") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    // 게시 판정 한 번 더 — ① 입점 승인된 active 학원(S1-1.16) ② 환불 공지가 있다(S1-3.6) ③ 이벤트형 마감일(S2-2.6)
    if (!(await canPublish(createClassPublishGateDeps(db), row.academy_id))) {
      throw HttpError.conflict("ACADEMY_RESTRICTED", DETAIL.restricted);
    }
    const payload = readClassPayload(row.payload);
    const noticeKind = refundNoticeKindFor(payload.classKind, payload.priceAmount);
    if (noticeKind !== null) await assertRefundNoticeForPublish(db, row.academy_id, noticeKind);
    await assertDeadlineStillValid(row.id, payload);

    const now = clock().toString();
    const lostRace = HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    try {
      await db.transaction(async (tx) => {
        // 조건부 갱신 한 문장 — 승인 대기일 때만 공개로 넘어간다. 공지는 지금 최신 판본으로 다시 붙인다(열린 점 ⑱)
        const moved = await tx.execute(
          tx.raw.sql`UPDATE classes
                     SET status = 'published', approved_at = ${now}::timestamptz, approved_by_account_id = ${owner.staffAccountId}::uuid,
                         refund_notice_version_id = COALESCE(
                           (SELECT v.id FROM refund_notice_versions v
                            WHERE v.academy_id = ${row.academy_id}::uuid AND v.notice_kind = ${noticeKind ?? ""}
                            ORDER BY v.version DESC LIMIT 1),
                           refund_notice_version_id),
                         updated_at = now()
                     WHERE id = ${row.id}::uuid AND academy_id = ${row.academy_id}::uuid AND status = 'pending_approval'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw lostRace;

        // 홍보 자료 검토 관문(SX-6.7) — 승인 요청 뒤에 강사가 AI 표지·문구를 다시 저장해 검토 확인이 비었으면 여기서 막는다(409 + 롤백).
        // 공개되는 순간 표지로 고른 AI 이미지 파일을 public 으로 바꾼다(만들 때 private — data-model §13-6 열린 점 ⑤)
        await assertPromoAssetsReviewed(tx, row.id);
        await publishPromoCoverFile(tx, row.id);

        // 판매 단위를 연다 — 수업 공개와 같은 트랜잭션이라 「공개됐는데 살 수 없는」 중간 상태가 남지 않는다(FR-076)
        await tx.execute(
          tx.raw.sql`UPDATE class_offerings SET status = 'open', updated_at = now()
                     WHERE class_id = ${row.id}::uuid AND status = 'closed'`
            .affectedCount()
            .build(),
        );

        const revisionNo = await currentRevisionNo(tx, row.id);
        await insertApproval(tx, row.id, "approved", owner.staffAccountId, revisionNo, null);
        // 강사 알림(계약 11 §7) — 수업을 올린 사람에게. 같은 제출의 승인은 열쇠가 같아 한 번만 들어간다
        await notifyUploader(tx, row, "class_approved", `class:${row.id}:rev${revisionNo}:approved`, {
          classId: row.id,
          title: payload.title,
        });
        await insertAudit(tx, owner.staffAccountId, row, "class.approved", { status: "published", revisionNo });
      });
    } catch (error) {
      if (error !== lostRace) throw error;
      // 동시에 먼저 승인한 쪽이 있으면 같은 본문, 등록 취소·수정 요청이 먼저였으면 409
      return settleRace(row.id, (after) => after.status === "published");
    }

    const after = await findClass(db, row.id);
    if (after === null) throw new Error("승인한 수업을 다시 읽지 못했다");
    return Response.json(await respondWith(db, after), { headers: NO_STORE });
  });

  /**
   * 이벤트형 환불 마감일을 승인 때 한 번 더 본다(S2-2.6 의 판정 그대로, 계약 11 §4-5).
   * 승인 요청 때 이미 통과했으므로 보통은 그대로 지나간다 — 판매 단위의 첫 회차가 바뀌는 일이 생기면 여기서 막힌다.
   */
  async function assertDeadlineStillValid(classId: string, payload: ReturnType<typeof readClassPayload>): Promise<void> {
    const [offering] = await db.query(
      db.raw.sql`SELECT to_char(first_session_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_at
                 FROM class_offerings WHERE class_id = ${classId}::uuid ORDER BY first_session_starts_at LIMIT 1`
        .returnsRow({ first_at: "pg/text@1" })
        .build(),
    );
    if (offering === undefined || payload.priceAmount === null) return;
    const verdict = checkRefundDeadline({
      classKind: payload.classKind,
      priceAmount: payload.priceAmount,
      refundDeadlineOn: payload.refundDeadlineOn,
      firstSessionStartsAt: Temporal.Instant.from(offering.first_at),
    });
    if (!verdict.ok) {
      throw HttpError.unprocessable(verdict.code, verdict.message, { fields: [{ path: "refundDeadlineOn", message: verdict.message }] });
    }
  }

  // ---- ② POST …/request-revision — 수정 요청(반려) → 강사의 임시 저장 -----------------------------------

  const requestRevision = withRoute<Params>(async (request, context) => {
    const { owner, row } = await requireOwner(request, context);
    const { reason } = parseWith(revisionBodySchema, await readBody(request, {}));

    // 이미 같은 사유로 돌려보냈으면 같은 본문(두 번 눌러도 알림이 두 번 가지 않는다). 그 밖의 상태는 409
    if (row.status === "draft" && row.revision_reason === reason) {
      return Response.json(await respondWith(db, row), { headers: NO_STORE });
    }
    if (row.status !== "pending_approval") throw HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);

    const now = clock().toString();
    const lostRace = HttpError.conflict("CLASS_STATE_CONFLICT", DETAIL.state);
    try {
      await db.transaction(async (tx) => {
        // 조건부 갱신 한 문장 — 승인 대기일 때만 임시 저장으로 되돌린다.
        // 고정했던 공지 판본도 비운다: 임시 저장 화면은 그 학원의 최신 판본을 보여 주고, 다시 낼 때 그때 최신으로 붙는다(S2-2.5)
        const moved = await tx.execute(
          tx.raw.sql`UPDATE classes
                     SET status = 'draft', last_revision_reason = ${reason}, last_revision_at = ${now}::timestamptz,
                         refund_notice_version_id = NULL, updated_at = now()
                     WHERE id = ${row.id}::uuid AND academy_id = ${row.academy_id}::uuid AND status = 'pending_approval'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw lostRace;

        // 승인 요청 때 만든 행을 지운다 — 다시 낼 때 고친 값으로 새로 만든다(계약 11 §4-5)
        await deleteSubmittedRows(tx, row.id);

        const revisionNo = await currentRevisionNo(tx, row.id);
        await insertApproval(tx, row.id, "revision_requested", owner.staffAccountId, revisionNo, reason);
        // 강사 알림에 사유를 싣는다(I33 「수정 요청 받은 수업」이 이 문장을 그대로 보여 준다)
        await notifyUploader(tx, row, "class_revision_requested", `class:${row.id}:rev${revisionNo}:revision`, {
          classId: row.id,
          title: readClassPayload(row.payload).title,
          reason,
        });
        await insertAudit(tx, owner.staffAccountId, row, "class.revision_requested", { status: "draft", revisionNo, reason });
      });
    } catch (error) {
      if (error !== lostRace) throw error;
      return settleRace(row.id, (after) => after.status === "draft" && after.revision_reason === reason);
    }

    const after = await findClass(db, row.id);
    if (after === null) throw new Error("수정 요청한 수업을 다시 읽지 못했다");
    return Response.json(await respondWith(db, after), { headers: NO_STORE });
  });

  return { approve, requestRevision };
}

// ---- 같은 트랜잭션에 쓰는 기록들 ----------------------------------------------------------------

/**
 * 이번 제출이 몇 번째인가 — 승인·반려·등록 취소 기록과 알림 열쇠는 마지막 제출 번호를 같이 쓴다(class_approvals 주석).
 * S2-2.8b(수업 등록 취소)의 class-withdrawal.ts 도 같은 번호를 써야 해서 바깥으로 꺼냈다.
 */
export async function currentRevisionNo(tx: Tx, classId: string): Promise<number> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT COALESCE(max(revision_no), 1)::int4 AS n FROM class_approvals
               WHERE class_id = ${classId}::uuid AND action IN ('submitted', 'auto_published')`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );
  return row?.n ?? 1;
}

/**
 * 승인 요청(submit) 때 만든 판매 단위·회차·자리 묶음을 지운다. 반려(수정 요청)와 등록 취소(S2-2.8b)가 같이 쓴다 —
 * 두 길이 지우는 범위가 어긋나면 한쪽에 찌꺼기가 남으므로 한 벌로 둔다. 외래 키 때문에 자식(자리 묶음·회차)부터 지운다
 */
export async function deleteSubmittedRows(tx: Tx, classId: string): Promise<void> {
  await tx.execute(
    tx.raw.sql`DELETE FROM seat_pools WHERE offering_id IN (SELECT id FROM class_offerings WHERE class_id = ${classId}::uuid)`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`DELETE FROM class_sessions WHERE offering_id IN (SELECT id FROM class_offerings WHERE class_id = ${classId}::uuid)`
      .affectedCount()
      .build(),
  );
  await tx.execute(tx.raw.sql`DELETE FROM class_offerings WHERE class_id = ${classId}::uuid`.affectedCount().build());
}

/** 승인 기록 한 줄(추가 전용). 사유는 수정 요청에만 있다(ck_class_approvals_reason) */
async function insertApproval(
  tx: Tx,
  classId: string,
  action: "approved" | "revision_requested",
  actorId: string,
  revisionNo: number,
  reason: string | null,
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO class_approvals (id, class_id, action, actor_account_id, reason, revision_no)
               VALUES (uuidv7(), ${classId}::uuid, ${action}, ${actorId}::uuid, NULLIF(${reason ?? ""}, ''), ${revisionNo})`
      .affectedCount()
      .build(),
  );
}

/**
 * 수업을 올린 강사에게 알림 행을 쓴다(발송은 커밋 뒤 S7-1 이 한다). 승인 대기 수업은 늘 강사가 올린 것이다 —
 * 대표가 올린 수업은 승인 없이 바로 공개되므로 이 경로에 오지 않는다. 같은 열쇠는 한 번만(uq_notifications_dedupe)
 */
async function notifyUploader(
  tx: Tx,
  row: ClassRow,
  kind: "class_approved" | "class_revision_requested",
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const recipient = row.created_by !== "" ? row.created_by : row.instructor_id;
  if (recipient === "") return;
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${recipient}::uuid, ${row.academy_id}::uuid, 'operations', ${kind}, ${dedupeKey}, ${JSON.stringify(payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 감사 1행 — 수업 상태는 감사 대상(data-model §8-2) */
async function insertAudit(tx: Tx, actorId: string, row: ClassRow, action: string, after: Record<string, unknown>): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
               VALUES (uuidv7(), 'staff', ${actorId}::uuid, 'owner', ${row.academy_id}::uuid, ${action}, 'classes', ${row.id}::uuid,
                       ${JSON.stringify(after)}::json)`
      .affectedCount()
      .build(),
  );
}
