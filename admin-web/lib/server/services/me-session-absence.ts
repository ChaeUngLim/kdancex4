// S3-4.3(결석 예정 토글 API) — `PUT · DELETE /api/me/sessions/{sessionId}/absence`
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §5(회원의 결석 예정 토글)
//   데이터: data-model §7-8 `attendance_marks`(부분 유니크 uq_attendance_session — 살아 있는 행은 예약·회차마다 1개)
//   보드: M11(내 캘린더 · 참석/결석 토글)
//
// 흐름 한눈에 — 회원 확인 → 회차·내 확정 예약 확인 → 상태·시각 확인 → 결석 행 하나만 만들거나 거둔다:
//   ① 회원 세션이 있어야 한다(requireMember — 없으면 401, 가입을 덜 마쳤으면 403).
//   ② 회차가 없으면 404, 그 회차가 속한 판매 단위에 **내 확정 예약**(예약 confirmed + 주문 paid·partially_refunded)이
//      없으면 403. 남의 회차와 결제 전 회차를 같은 403 으로 묶어, 남의 예약이 있는지 없는지 새지 않게 한다.
//   ③ 휴강·폐강한 회차면 409 SESSION_NOT_SCHEDULED, 이미 시작했으면 409 SESSION_ALREADY_STARTED.
//      시작 뒤의 결석은 강사·대표가 표시한다(§6) — 회원은 켜지도 끄지도 못한다.
//   ④ PUT 은 결석 행을 만든다(이미 살아 있는 행이 있으면 그 행을 그대로 돌려준다 — 같은 호출을 되풀이해도 결과가 같다).
//      DELETE 는 행을 지우지 않고 cancelled_at 만 채운다(기록이 남는다). 강사·대표가 표시한 행은 409 ABSENCE_MARKED_BY_STAFF.
//
// 왜 다른 테이블을 건드리지 않나(계약 §5 · FR-104a):
//   결석 예정은 강사가 오늘 인원을 미리 아는 데 쓰는 「알림」일 뿐이다. 자리를 돌려주거나 환불하는 일은 취소(FR-098)가 따로 한다.
//   그래서 이 파일은 attendance_marks 한 테이블에만 쓰고, 주문·예약·자리·정산·대기 줄은 읽기만 한다.
//   회원이 스스로 켠 결석에는 알림·감사 행도 만들지 않는다(감사는 강사·대표가 표시할 때만, §7-8).
import { z } from "zod";

import { ATTENDANCE_DISPUTE_STATUSES, ATTENDANCE_MARKED_BY_KINDS } from "../../domain/constants";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { canMemberToggleAbsence } from "./me-calendar";
import type { Tx } from "./staff-signup";

// ---- 정해진 값 -----------------------------------------------------------------------------

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  notFound: "회차를 찾을 수 없어요",
  forbidden: "결제를 마친 내 수업 회차만 결석을 알릴 수 있어요",
  notScheduled: "휴강하거나 폐강한 회차예요",
  started: "이미 시작한 회차는 결석을 바꿀 수 없어요",
  markedByStaff: "강사나 대표가 표시한 결석이라 직접 되돌릴 수 없어요. 이의 신청을 해 주세요",
} as const;

// ---- 응답 모양(계약 04 §5) — 테스트가 이 스키마로 응답을 parse 한다 ---------------------------------

export const absenceMarkResponseSchema = z.strictObject({
  markId: z.string(),
  sessionId: z.string(),
  reservationId: z.string(),
  markedByKind: z.enum(ATTENDANCE_MARKED_BY_KINDS),
  markedAt: z.iso.datetime(),
  disputeStatus: z.enum(ATTENDANCE_DISPUTE_STATUSES),
  canToggle: z.boolean(),
});
export type AbsenceMarkResponse = z.infer<typeof absenceMarkResponseSchema>;

export const absenceClearedResponseSchema = z.strictObject({
  sessionId: z.string(),
  absence: z.null(),
});

// ---- 읽기 도우미 ------------------------------------------------------------------------------

type SessionParams = { params: Promise<{ sessionId: string }> };

type TargetRow = { session_id: string; status: string; starts_at: string; reservation_id: string };
type MarkRow = { id: string; reservation_id: string; marked_by_kind: string; marked_at: string; dispute_status: string };

const idSchema = z.uuid();

/**
 * 회차와 그 회차의 내 확정 예약을 함께 읽는다(서버 순서 #1·#2).
 * 예약 행은 FOR SHARE 로 잡아, 이 트랜잭션이 끝나기 전에 취소가 끼어들어 「취소된 예약의 결석」이 생기지 않게 한다.
 * (FOR SHARE 는 읽기 잠금이라 예약 행의 값은 바꾸지 않는다 — 수용 ② 「예약 행 불변」과 어긋나지 않는다.)
 */
async function loadTarget(tx: Tx, sessionId: string, memberId: string): Promise<TargetRow> {
  if (!idSchema.safeParse(sessionId).success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  const [session] = await tx.query(
    tx.raw.sql`SELECT id::text AS id, offering_id::text AS offering_id, status::text AS status,
                      to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at
               FROM class_sessions WHERE id = ${sessionId}::uuid`
      .returnsRow({ id: "pg/text@1", offering_id: "pg/text@1", status: "pg/text@1", starts_at: "pg/text@1" })
      .build(),
  );
  if (session === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);

  const [reservation] = await tx.query(
    // 결제를 마친 주문만 — paid · partially_refunded(부분 환불 뒤에도 남은 회차는 다닌다)
    tx.raw.sql`SELECT r.id::text AS id
               FROM reservations r JOIN orders o ON o.id = r.order_id
               WHERE r.offering_id = ${session.offering_id}::uuid AND r.member_id = ${memberId}::uuid
                 AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')
               FOR SHARE OF r`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  if (reservation === undefined) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  return { session_id: session.id, status: session.status, starts_at: session.starts_at, reservation_id: reservation.id };
}

/** 서버 순서 #3·#4 — 예정 회차이고 시작 전이어야 회원이 바꿀 수 있다 */
function assertMemberCanChange(target: TargetRow, now: Temporal.Instant): void {
  if (target.status !== "scheduled") throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
  if (Temporal.Instant.compare(now, Temporal.Instant.from(target.starts_at)) >= 0) {
    throw HttpError.conflict("SESSION_ALREADY_STARTED", DETAIL.started);
  }
}

/** 이 예약·회차의 살아 있는 결석 행(cancelled_at IS NULL) — 부분 유니크 덕분에 많아야 1개 */
async function readLiveMark(tx: Tx, reservationId: string, sessionId: string): Promise<MarkRow | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id::text AS id, reservation_id::text AS reservation_id, marked_by_kind::text AS marked_by_kind,
                      to_char(marked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS marked_at,
                      dispute_status::text AS dispute_status
               FROM attendance_marks
               WHERE reservation_id = ${reservationId}::uuid AND session_id = ${sessionId}::uuid AND cancelled_at IS NULL`
      .returnsRow({ id: "pg/text@1", reservation_id: "pg/text@1", marked_by_kind: "pg/text@1", marked_at: "pg/text@1", dispute_status: "pg/text@1" })
      .build(),
  );
  return row;
}

function toResponse(mark: MarkRow, target: TargetRow, now: Temporal.Instant): AbsenceMarkResponse {
  return {
    markId: mark.id,
    sessionId: target.session_id,
    reservationId: mark.reservation_id,
    markedByKind: mark.marked_by_kind as (typeof ATTENDANCE_MARKED_BY_KINDS)[number],
    markedAt: mark.marked_at,
    disputeStatus: mark.dispute_status as (typeof ATTENDANCE_DISPUTE_STATUSES)[number],
    // 캘린더(S3-4.2)와 같은 함수 — 「끌 수 있나」 계산을 한 곳에만 둔다(계약 04 §4-1)
    canToggle: canMemberToggleAbsence(mark.marked_by_kind, Temporal.Instant.from(target.starts_at), now),
  };
}

// ---- 경로 -----------------------------------------------------------------------------------

export type MeSessionAbsenceDeps = GuardDeps & { clock?: Clock };

export function createMeSessionAbsenceRoutes(deps: MeSessionAbsenceDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** PUT — 결석 예정을 켠다. 처음 만들면 201, 이미 살아 있는 행이 있으면 200 으로 같은 행 */
  const put = withRoute<SessionParams>(async (request, context) => {
    const member = await guards.requireMember(request);
    const { sessionId } = await context.params;
    const now = clock();

    const result = await db.transaction(async (tx) => {
      const target = await loadTarget(tx, sessionId, member.memberId);
      assertMemberCanChange(target, now);

      // 먼저 SELECT 로 확인하지 않고 INSERT 를 시도한다 — 같은 회원이 두 번 눌러 동시에 와도
      // 부분 유니크(uq_attendance_session)가 하나만 남기고, 진 쪽은 DO NOTHING 으로 0행이 된다.
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_member_id, marked_at)
                   VALUES (uuidv7(), ${target.reservation_id}::uuid, ${target.session_id}::uuid, ${member.memberId}::uuid,
                           'member', ${member.memberId}::uuid, ${now.toString()}::timestamptz)
                   ON CONFLICT (reservation_id, session_id) WHERE cancelled_at IS NULL DO NOTHING
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      const mark = await readLiveMark(tx, target.reservation_id, target.session_id);
      // INSERT 가 졌는데 살아 있는 행도 없다 = 그 사이 다른 요청이 거뒀다. 드문 경합이라 다시 누르게 한다
      if (mark === undefined) throw new HttpError("INTERNAL", "잠시 뒤 다시 시도해 주세요");
      return { status: inserted === undefined ? 200 : 201, body: toResponse(mark, target, now) };
    });
    return Response.json(result.body, { status: result.status, headers: NO_STORE });
  });

  /** DELETE — 결석 예정을 거두고 참석으로 돌린다. 행은 지우지 않고 cancelled_at 만 채운다. 없으면 그대로 200 */
  const remove = withRoute<SessionParams>(async (request, context) => {
    const member = await guards.requireMember(request);
    const { sessionId } = await context.params;
    const now = clock();

    const body = await db.transaction(async (tx) => {
      const target = await loadTarget(tx, sessionId, member.memberId);
      assertMemberCanChange(target, now);
      const mark = await readLiveMark(tx, target.reservation_id, target.session_id);
      if (mark !== undefined) {
        // 강사·대표가 표시한 결석은 회원이 못 지운다 — 이의 신청(§8)으로만 다툰다
        if (mark.marked_by_kind !== "member") throw HttpError.conflict("ABSENCE_MARKED_BY_STAFF", DETAIL.markedByStaff);
        // 조건에 cancelled_at IS NULL 을 다시 건다 — 동시에 온 두 DELETE 중 하나만 시각을 채운다(나머지는 0행, 결과는 같다)
        await tx.execute(
          tx.raw.sql`UPDATE attendance_marks SET cancelled_at = ${now.toString()}::timestamptz
                     WHERE id = ${mark.id}::uuid AND cancelled_at IS NULL AND marked_by_kind = 'member'`
            .affectedCount()
            .build(),
        );
      }
      return { sessionId: target.session_id, absence: null };
    });
    return Response.json(body, { headers: NO_STORE });
  });

  return { put, remove };
}
