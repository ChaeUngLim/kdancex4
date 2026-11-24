// S3-4.3c(결석 이의 신청·처리 API)
//   `POST /api/me/attendance-marks/{markId}/dispute`          — 회원이 강사·대표가 표시한 결석에 이의를 건다(§8-1, 보드 M11)
//   `POST /api/attendance-marks/{markId}/dispute/resolve`     — 표시한 직원 · 그 학원 대표가 받아들이거나 유지한다(§8-2, 보드 I26)
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §8(이의 신청·처리) · §8-3(상태 전이)
//   데이터: data-model §7-8 `attendance_marks`(dispute_* 칸과 CHECK 4개) · §7-7 `audit_logs` · `notifications`(dedupe_key)
//   요구: FR-092e(결석 표시와 이의) · FR-169a(출석률 반영 레벨 — 받아들인 결석은 레벨 계산에서 빠진다)
//
// 상태 한눈에(§8-3):
//   결석(직원 표시, dispute none) ─ 회원 이의 ─▶ requested ─ accept ─▶ accepted + cancelled_at 채움(출석으로 돌아간다)
//                                                        └ reject ─▶ rejected(결석 유지)
//   한 행에 이의는 한 번이다. 처리된 행에 다시 걸면 409, 처리할 이의가 없는 행을 처리하려 하면 409.
//
// 왜 상태를 UPDATE 의 WHERE 로 거나(먼저 읽고 나중에 고치지 않나):
//   회원이 두 번 누르거나 강사·대표가 동시에 처리해도 「none → requested」·「requested → 결정」이 한 번만 일어나야
//   감사 1행 · 알림 1건이 지켜진다. 그래서 바꿀 조건(dispute_status = 'none' 등)을 UPDATE 자체에 넣고,
//   0행이면 그 사이 누가 먼저 바꾼 것으로 보고 다시 읽어 알맞은 응답(200 같은 본문 또는 409)을 고른다.
//
// 이 Task 가 하지 않는 것: 직원의 결석 표시 취소(§6-2 …/cancel — 「이의가 걸린 행을 취소하면 받아들임과 같다」는 그 경로의 일) ·
//   409 `DISPUTE_CLOSED`(레벨 판정 시점이 정해지는 S6-3 뒤에 켠다, 계약 열린 점 ⑦). 알림은 delivery_status = pending 으로 남기만 한다(발송은 S7-1).
import { z } from "zod";

import { formatKstDate, systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해진 값 -----------------------------------------------------------------------------

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 이의 사유·처리 메모의 최대 길이(계약 04 §8-1 · §8-2, 임시 확정) */
export const DISPUTE_TEXT_MAX = 200;

const DETAIL = {
  notFound: "결석 표시를 찾을 수 없어요",
  notMine: "내 결석 표시에만 이의를 신청할 수 있어요",
  notDisputable: "강사나 대표가 표시한 살아 있는 결석에만 이의를 신청할 수 있어요",
  alreadyResolved: "이미 처리된 이의예요",
  forbidden: "이 결석 표시의 이의를 처리할 권한이 없어요",
  notPending: "처리할 이의가 없어요",
} as const;

const MARKER_LABEL = { instructor: "강사", owner: "대표" } as const;

// ---- 요청·응답 모양(계약 04 §8) — 테스트가 이 스키마로 응답·알림을 parse 한다 ----------------------------

/** 이의 신청 본문 — 앞뒤 공백을 자른 뒤 1~200자 */
export const disputeRequestBodySchema = z.strictObject({ reason: z.string().trim().min(1).max(DISPUTE_TEXT_MAX) });

export const disputeRequestResponseSchema = z.strictObject({
  markId: z.string(),
  disputeStatus: z.literal("requested"),
  disputeRequestedAt: z.iso.datetime(),
});
export type DisputeRequestResponse = z.infer<typeof disputeRequestResponseSchema>;

/** 이의 처리 본문 — accept(받아들임 = 결석 취소) · reject(유지). note 는 선택, 최대 200자 */
export const disputeResolveBodySchema = z.strictObject({
  decision: z.enum(["accept", "reject"]),
  note: z.string().trim().max(DISPUTE_TEXT_MAX).optional(),
});

export const disputeResolveResponseSchema = z.strictObject({
  markId: z.string(),
  disputeStatus: z.enum(["accepted", "rejected"]),
  // 받아들이면 그 행이 취소된 시각, 유지하면 null(결석이 남는다)
  cancelledAt: z.iso.datetime().nullable(),
  disputeResolvedAt: z.iso.datetime(),
});
export type DisputeResolveResponse = z.infer<typeof disputeResolveResponseSchema>;

/** 직원 알림 absence_dispute_requested 의 payload — 닉네임·회차·사유만(연락처는 넣지 않는다, §8-1) */
export const disputeRequestedPayloadSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  markId: z.string(),
  memberNickname: z.string(),
  classId: z.string(),
  classTitle: z.string(),
  sessionId: z.string(),
  sessionDate: z.string(),
  reason: z.string(),
  // 처리 입구(§8-2)
  resolvePath: z.string(),
});

/** 회원 알림 absence_dispute_resolved 의 payload — 받아들임·유지가 같은 종류라 decision 으로 나눈다 */
export const disputeResolvedPayloadSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  markId: z.string(),
  classId: z.string(),
  classTitle: z.string(),
  sessionId: z.string(),
  sessionDate: z.string(),
  decision: z.enum(["accept", "reject"]),
  note: z.string().nullable(),
});

// ---- 읽기 도우미 ------------------------------------------------------------------------------

type MarkParams = { params: Promise<{ markId: string }> };

/** 결석 행 + 그 회차·수업·학원·회원 닉네임. 처리 판단에 필요한 것을 한 번에 읽는다 */
type MarkRow = {
  id: string;
  reservation_id: string;
  member_id: string;
  nickname: string;
  marked_by_kind: string;
  marked_by_staff_account_id: string;
  cancelled_at: string;
  dispute_status: string;
  dispute_requested_at: string;
  dispute_resolved_at: string;
  session_id: string;
  starts_at: string;
  class_id: string;
  class_title: string;
  academy_id: string;
};

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
const idSchema = z.uuid();

/**
 * markId 로 결석 행을 읽는다. 없거나 id 형식이 틀리면 undefined(→ 404).
 * 비어 있는 시각·직원 칸은 빈 글자로 돌려준다(쿼리 결과 모양을 글자 하나로 맞추려는 것).
 * 행을 FOR UPDATE 로 잡는다 — 트랜잭션 안에서는 같은 행을 동시에 바꾸려는 요청을 줄 세우고,
 * 트랜잭션 밖(db 로 바로 부를 때)에서는 문장이 끝나는 즉시 잠금이 풀려 그냥 읽기와 같다.
 */
async function readMark(q: Db | Tx, markId: string): Promise<MarkRow | undefined> {
  if (!idSchema.safeParse(markId).success) return undefined;
  const [row] = await q.query(
    q.raw.sql`SELECT a.id::text AS id, a.reservation_id::text AS reservation_id, a.member_id::text AS member_id, m.nickname,
                     a.marked_by_kind::text AS marked_by_kind, COALESCE(a.marked_by_staff_account_id::text, '') AS marked_by_staff_account_id,
                     COALESCE(to_char(a.cancelled_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS cancelled_at,
                     a.dispute_status::text AS dispute_status,
                     COALESCE(to_char(a.dispute_requested_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS dispute_requested_at,
                     COALESCE(to_char(a.dispute_resolved_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS dispute_resolved_at,
                     s.id::text AS session_id, to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS starts_at,
                     c.id::text AS class_id, c.title AS class_title, c.academy_id::text AS academy_id
              FROM attendance_marks a
              JOIN members m ON m.id = a.member_id
              JOIN class_sessions s ON s.id = a.session_id
              JOIN class_offerings o ON o.id = s.offering_id
              JOIN classes c ON c.id = o.class_id
              WHERE a.id = ${markId}::uuid
              FOR UPDATE OF a`
      .returnsRow({
        id: "pg/text@1",
        reservation_id: "pg/text@1",
        member_id: "pg/text@1",
        nickname: "pg/text@1",
        marked_by_kind: "pg/text@1",
        marked_by_staff_account_id: "pg/text@1",
        cancelled_at: "pg/text@1",
        dispute_status: "pg/text@1",
        dispute_requested_at: "pg/text@1",
        dispute_resolved_at: "pg/text@1",
        session_id: "pg/text@1",
        starts_at: "pg/text@1",
        class_id: "pg/text@1",
        class_title: "pg/text@1",
        academy_id: "pg/text@1",
      })
      .build(),
  );
  return row;
}

// ---- 경로 -----------------------------------------------------------------------------------

export type AbsenceDisputeDeps = GuardDeps & { clock?: Clock };

type ResolverRole = keyof typeof MARKER_LABEL;

export function createAbsenceDisputeRoutes(deps: AbsenceDisputeDeps) {
  const guards = createGuards(deps);
  // 직원 세션 읽기(관리자 웹 쿠키면 2단계 인증)는 결석 표시(S3-4.3a)와 같은 함수 — 기준을 한 벌로 둔다
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /**
   * 이의 신청 상태 판정(§8-1 오류 표). 처리된 이의를 먼저 본다 — 받아들인 행은 cancelled_at 도 차 있어서,
   * 순서를 바꾸면 「이미 처리됨」이 「이의 대상 아님」으로 잘못 나간다.
   * 돌려주는 값: "requested" 면 이미 걸려 있음(200 같은 본문), "open" 이면 새로 걸 수 있다.
   */
  function disputeStateOf(mark: MarkRow): "requested" | "open" {
    if (mark.dispute_status === "accepted" || mark.dispute_status === "rejected") {
      throw HttpError.conflict("DISPUTE_ALREADY_RESOLVED", DETAIL.alreadyResolved);
    }
    if (mark.dispute_status === "requested") return "requested";
    // 회원이 켠 결석 예정은 회원이 직접 끈다(§5) — 이의가 필요 없다. 이미 거둔 결석에도 걸 수 없다
    if (mark.marked_by_kind === "member" || mark.cancelled_at !== "") {
      throw HttpError.conflict("ABSENCE_NOT_DISPUTABLE", DETAIL.notDisputable);
    }
    return "open";
  }

  /** POST /api/me/attendance-marks/{markId}/dispute — 회원이 이의를 건다. 이미 걸려 있으면 200 같은 본문 */
  const requestDispute = withRoute<MarkParams>(async (request, context) => {
    const member = await guards.requireMember(request);
    const { markId } = await context.params;
    const now = clock();

    const body = await db.transaction(async (tx) => {
      const mark = await readMark(tx, markId);
      if (mark === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      // 남의 결석 표시 — 있는지 없는지보다 「내 것이 아님」을 알려 준다(계약 §8-1 403)
      if (mark.member_id !== member.memberId) throw new HttpError("FORBIDDEN", DETAIL.notMine);
      // 본문은 내 것임을 확인한 뒤에 본다
      const input = await parseJsonBody(request, disputeRequestBodySchema);

      if (disputeStateOf(mark) === "requested") {
        return { markId: mark.id, disputeStatus: "requested", disputeRequestedAt: mark.dispute_requested_at } satisfies DisputeRequestResponse;
      }

      // none → requested. 조건을 UPDATE 에 다시 걸어 두 요청이 겹쳐도 한 번만 바뀐다(행은 위에서 FOR UPDATE 로 잡혀 있다)
      const requestedAt = now.toString({ smallestUnit: "second" });
      const changed = await tx.execute(
        tx.raw.sql`UPDATE attendance_marks
                   SET dispute_status = 'requested', dispute_requested_at = ${requestedAt}::timestamptz, dispute_reason = ${input.reason}
                   WHERE id = ${mark.id}::uuid AND dispute_status = 'none' AND cancelled_at IS NULL AND marked_by_kind <> 'member'`
          .affectedCount()
          .build(),
      );
      if (changed.affectedRows !== 1) throw new HttpError("INTERNAL", "잠시 뒤 다시 시도해 주세요");

      // 감사 1행 — 회원이 · 어느 결석에 · 무슨 사유로(사유는 회원이 쓴 글이라 reason 칸에 둔다)
      const before = JSON.stringify({ disputeStatus: "none" });
      const after = JSON.stringify({ disputeStatus: "requested", disputeRequestedAt: requestedAt });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_member_id, actor_role, academy_id, action, target_table, target_id, before, after, reason)
                   VALUES (uuidv7(), 'member', ${member.memberId}::uuid, 'member', ${mark.academy_id}::uuid,
                           'attendance.dispute_requested', 'attendance_marks', ${mark.id}::uuid, ${before}::json, ${after}::json, ${input.reason})`
          .affectedCount()
          .build(),
      );

      // 직원 알림 1건 — 받는 사람은 그 결석을 표시한 직원 계정. 열쇠가 표시마다 달라 같은 이의는 한 건이다
      const sessionDate = formatKstDate(Temporal.Instant.from(mark.starts_at));
      const payload = JSON.stringify(
        disputeRequestedPayloadSchema.parse({
          title: "결석 표시에 이의가 들어왔어요",
          body: `${mark.nickname} 님이 ${mark.class_title} ${sessionDate} 수업의 결석 표시에 이의를 신청했어요`,
          markId: mark.id,
          memberNickname: mark.nickname,
          classId: mark.class_id,
          classTitle: mark.class_title,
          sessionId: mark.session_id,
          sessionDate,
          reason: input.reason,
          resolvePath: `/api/attendance-marks/${mark.id}/dispute/resolve`,
        }),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, kind, dedupe_key, reservation_id, payload)
                   VALUES (uuidv7(), ${mark.marked_by_staff_account_id}::uuid, ${mark.academy_id}::uuid, 'absence_dispute_requested',
                           ${`absence:${mark.id}:dispute`}, ${mark.reservation_id}::uuid, ${payload}::jsonb)
                   ON CONFLICT DO NOTHING`
          .affectedCount()
          .build(),
      );

      return { markId: mark.id, disputeStatus: "requested", disputeRequestedAt: requestedAt } satisfies DisputeRequestResponse;
    });
    return Response.json(body, { headers: NO_STORE });
  });

  /**
   * 처리할 수 있는 사람(§8-2 · 열린 점 ②): 그 학원 대표 · 그 결석을 표시한 직원 본인.
   * 위임 강사·담당 강사라도 자기가 표시하지 않았으면 처리할 수 없다. 대표가 표시한 행은 대표만 처리하게 된다.
   * 표시한 강사도 지금 그 학원 active 소속이어야 한다 — 결석 표시(S3-4.3a)와 같은 기준(소속이 끝난 강사는 그 학원 회원 기록을 못 바꾼다).
   * 돌려주는 값이 감사에 남길 역할이다.
   */
  async function resolverRoleOf(staff: StaffAccountContext, mark: MarkRow): Promise<ResolverRole> {
    if (staff.actor.ownedAcademyIds.includes(mark.academy_id)) return "owner";
    if (mark.marked_by_staff_account_id !== staff.staffAccountId || !staff.actor.roles.includes("instructor")) {
      throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    }
    const [affiliation] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${mark.academy_id}::uuid AND instructor_account_id = ${staff.staffAccountId}::uuid
                   AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return "instructor";
  }

  /** POST /api/attendance-marks/{markId}/dispute/resolve — 받아들이면(accept) 결석을 취소하고, 유지하면(reject) 그대로 둔다 */
  const resolveDispute = withRoute<MarkParams>(async (request, context) => {
    const staff = await readStaff(request);
    const { markId } = await context.params;
    // 권한 판단은 잠그지 않고 먼저 읽어서 한다 — 권한 없는 요청이 행 잠금을 잡지 않게
    const peek = await readMark(db, markId);
    if (peek === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const role = await resolverRoleOf(staff, peek);
    const input = await parseJsonBody(request, disputeResolveBodySchema);
    const note = input.note === undefined || input.note === "" ? null : input.note;
    const now = clock();
    const resolvedAt = now.toString({ smallestUnit: "second" });

    const body = await db.transaction(async (tx) => {
      // 잠근 뒤 다시 읽는다 — 그 사이 다른 직원이 먼저 처리했으면 아래에서 409 가 된다
      const mark = await readMark(tx, peek.id);
      if (mark === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
      if (mark.dispute_status !== "requested") throw HttpError.conflict("DISPUTE_NOT_PENDING", DETAIL.notPending);

      // 받아들이면 cancelled_at 을 채워 출석으로 돌린다(행은 지우지 않는다 — 이력이 남는다). 유지하면 결석 그대로
      const accepted = input.decision === "accept";
      const nextStatus = accepted ? "accepted" : "rejected";
      const cancelledAt = accepted ? resolvedAt : null;
      const changed = await tx.execute(
        tx.raw.sql`UPDATE attendance_marks
                   SET dispute_status = ${nextStatus}, dispute_resolved_at = ${resolvedAt}::timestamptz,
                       dispute_resolved_by_account_id = ${staff.staffAccountId}::uuid,
                       cancelled_at = COALESCE(cancelled_at, NULLIF(${cancelledAt ?? ""}, '')::timestamptz)
                   WHERE id = ${mark.id}::uuid AND dispute_status = 'requested'`
          .affectedCount()
          .build(),
      );
      if (changed.affectedRows !== 1) throw HttpError.conflict("DISPUTE_NOT_PENDING", DETAIL.notPending);

      // 감사 1행 — 처리자 · 역할 · 결정 · 전후
      const before = JSON.stringify({ disputeStatus: "requested", cancelledAt: null });
      const after = JSON.stringify({ disputeStatus: nextStatus, decision: input.decision, cancelledAt, disputeResolvedAt: resolvedAt });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after, reason)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${role}, ${mark.academy_id}::uuid,
                           'attendance.dispute_resolved', 'attendance_marks', ${mark.id}::uuid, ${before}::json, ${after}::json, NULLIF(${note ?? ""}, ''))`
          .affectedCount()
          .build(),
      );

      // 회원 알림 1건 — 받아들임·유지 모두 같은 종류. 처리한 직원의 이름은 넣지 않는다(계약 04 열린 점 ③과 같은 기조)
      const sessionDate = formatKstDate(Temporal.Instant.from(mark.starts_at));
      const resultLine = accepted ? "결석 표시가 취소됐어요" : "결석 표시가 유지됐어요";
      const payload = JSON.stringify(
        disputeResolvedPayloadSchema.parse({
          title: resultLine,
          body: `${mark.class_title} ${sessionDate} 수업의 이의를 확인했어요. ${resultLine}${note === null ? "" : ` (${note})`}`,
          markId: mark.id,
          classId: mark.class_id,
          classTitle: mark.class_title,
          sessionId: mark.session_id,
          sessionDate,
          decision: input.decision,
          note,
        }),
      );
      await tx.execute(
        tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, reservation_id, payload)
                   VALUES (uuidv7(), ${mark.member_id}::uuid, ${mark.academy_id}::uuid, 'absence_dispute_resolved',
                           ${`absence:${mark.id}:dispute_resolved`}, ${mark.reservation_id}::uuid, ${payload}::jsonb)
                   ON CONFLICT DO NOTHING`
          .affectedCount()
          .build(),
      );

      return {
        markId: mark.id,
        disputeStatus: nextStatus,
        // 이미 다른 경로로 거둔 행은 없지만(§6-2 취소는 이의가 걸린 행을 accepted 로 만든다), 있으면 그 시각을 그대로 보여 준다
        cancelledAt: accepted ? (mark.cancelled_at !== "" ? mark.cancelled_at : resolvedAt) : null,
        disputeResolvedAt: resolvedAt,
      } satisfies DisputeResolveResponse;
    });
    return Response.json(body, { headers: NO_STORE });
  });

  return { requestDispute, resolveDispute };
}

