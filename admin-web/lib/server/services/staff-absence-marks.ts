// S3-4.3a(강사·대표 결석 표시 API) — `POST /api/classes/{classId}/sessions/{sessionId}/absences`
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §6-1(표시) · 권한은 18-after-payment-views.md §1-1 「§8 오늘 결석」 줄
//   데이터: data-model §7-8 `attendance_marks` · §7-7 `audit_logs` · `notifications`(dedupe_key)
//   요구: FR-092e(결석 표시 — 수업 뒤 48시간 안, 확정 2026-11-19) · FR-104(출석 기록) · 보드 I26(오늘 결석 알린 수강생) · W6(명단의 결석 표시)
//
// 흐름 한눈에 — 직원 확인 → 회차·권한 확인 → 시각 확인 → 수강생 확인 → 결석 행 + 감사 1행 + 회원 알림 1건(한 트랜잭션):
//   ① 직원 세션(관리자 웹 쿠키면 2단계 인증까지). 수업·회차 id 가 서로 이어져 있지 않거나 없으면 404.
//   ② 누가 표시할 수 있나 — 그 학원 대표 · 위임 강사(roster_manage) · 그 회차의 담당 강사. 그 밖은 403.
//      강사는 지금도 그 학원 active 소속이어야 한다(소속이 끝난 강사가 회원 기록을 바꾸지 못하게).
//   ③ 회차가 예정 상태(휴강·폐강 아님)이고, 시작 뒤 ~ 끝난 뒤 48시간 안이어야 한다.
//      시작 전은 409 SESSION_NOT_STARTED(그 전에는 회원이 직접 결석 예정을 알린다 — §5),
//      48시간이 지나면 409 ABSENCE_WINDOW_CLOSED(잠긴 기록은 대표가 사유를 적어 취소만 한다 — §6-2).
//   ④ memberId 가 그 회차의 확정 수강생(예약 confirmed + 주문 paid·partially_refunded)이어야 한다. 아니면 404.
//   ⑤ 결석 행을 만든다. 표시한 사람의 종류(instructor · owner)와 직원 계정을 같이 남긴다.
//      새로 만들었을 때만 감사 attendance.marked 1행 + 회원 알림 absence_marked 1건을 쓴다.
//      이미 살아 있는 결석 행(회원이 미리 알린 결석 예정 포함)이 있으면 새로 만들지 않고 그 행을 200 으로 돌려준다 —
//      바뀐 게 없으니 감사·알림도 새로 쓰지 않는다(계약 §6-1 끝 문단).
//
// 왜 「표시한 사람의 종류」를 따로 남기나:
//   회원 화면은 누가 표시했는지를 역할(강사·대표)까지 보여 주고(FR-092e), 회원이 켠 행과 직원이 표시한 행은
//   되돌리기·이의 규칙이 다르다(§5 #5 · §8). 그래서 종류 칸이 그 행의 성격을 정한다.
//   대표이면서 담당 강사인 사람이 부르면 대표로 기록한다(계약 §6-1 「대표 경로로 부르면 owner」 — 이 경로는 하나라 대표가 이긴다).
//
// S3-5.9b(앱 강사 결석 표시 화면 I26)가 같은 파일에 더한 것 — 표시와 같은 권한·같은 회차 읽기를 써야 해서 한곳에 둔다:
//   · `GET  …/absences`                — 오늘 결석 목록(계약 18 §8). 살아 있는 결석 행 + 이의로 취소된 행(이의 결과) + 머리 줄 재료
//   · `POST …/absences/{markId}/cancel` — 결석 표시 취소(계약 04 §6-2). 로드맵에 이 경로를 맡은 Task 가 없어 I26 의
//     「표시 취소」(보드 토글 끄기)를 그리는 이 Task 가 붙였다(추천안·사후 확인 2026-11-24)
//
// 이 파일이 하지 않는 것: 48시간 잠금 작업(S3-4.3b(결석 표시 48시간 확정 작업)) · 이의 신청·처리(S3-4.3c(결석 이의 신청·처리 API)).
//   알림 행은 delivery_status = pending 으로 남기만 한다(발송은 S7-1).
import { z } from "zod";

import { ATTENDANCE_DISPUTE_STATUSES, ATTENDANCE_MARKED_BY_KINDS, GENDERS, type Gender } from "../../domain/constants";
import { formatKstDate, systemClock, type Clock } from "../../domain/time";
import type { GuardDeps, StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, withRoute } from "../http";
import { disputeResolvedPayloadSchema } from "./absence-disputes";
import { createClassAccess } from "./class-registration";
import { countEnrolledMonths } from "./session-roster";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해진 값 -----------------------------------------------------------------------------

/** 결석 표시를 받는 시간 — 회차가 끝난 뒤 48시간(FR-092e, 2026-11-19 확정). 지나면 그 회차의 표시가 잠긴다 */
export const ABSENCE_LOCK_HOURS = 48;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  notFound: "회차를 찾을 수 없어요",
  memberNotFound: "이 회차의 확정 수강생이 아니에요",
  forbidden: "이 회차의 결석을 표시할 권한이 없어요",
  notScheduled: "휴강하거나 폐강한 회차예요",
  notStarted: "수업이 시작한 뒤에 결석을 표시할 수 있어요",
  windowClosed: "수업이 끝나고 48시간이 지나 결석 표시가 잠겼어요",
  retry: "잠시 뒤 다시 시도해 주세요",
  markNotFound: "이 회차의 결석 표시를 찾을 수 없어요",
  cancelNotStarted: "수업이 시작하기 전에는 회원이 직접 결석 예정을 바꿔요",
  lockedOwnerOnly: "잠긴 결석 표시는 대표만 사유를 적고 취소할 수 있어요",
  reasonRequired: "잠긴 결석 표시를 취소하려면 사유를 적어 주세요",
} as const;

/** 취소 사유의 최대 길이(계약 04 §6-2 — 1~200자) */
export const ABSENCE_CANCEL_REASON_MAX = 200;

/** 회원 알림 문구 — 표시한 사람은 역할만 쓴다(직원 이름은 넣지 않는다, 계약 04 열린 점 ③) */
const MARKER_LABEL = { instructor: "강사", owner: "대표" } as const;

// ---- 요청·응답 모양(계약 04 §6-1) — 테스트가 이 스키마로 응답을 parse 한다 ----------------------------

export const staffAbsenceMarkBodySchema = z.strictObject({ memberId: z.uuid() });

export const staffAbsenceMarkResponseSchema = z.strictObject({
  markId: z.string(),
  sessionId: z.string(),
  memberId: z.string(),
  nickname: z.string(),
  markedByKind: z.enum(ATTENDANCE_MARKED_BY_KINDS),
  markedAt: z.iso.datetime(),
  lockedAt: z.iso.datetime(),
  disputeStatus: z.enum(ATTENDANCE_DISPUTE_STATUSES),
});
export type StaffAbsenceMarkResponse = z.infer<typeof staffAbsenceMarkResponseSchema>;

/** 회원 알림 absence_marked 의 payload(화면 문구 재료) — 테스트가 모양을 고정한다 */
export const absenceMarkedPayloadSchema = z.strictObject({
  title: z.string(),
  body: z.string(),
  classId: z.string(),
  classTitle: z.string(),
  sessionId: z.string(),
  sessionDate: z.string(),
  sessionStartsAt: z.iso.datetime(),
  markId: z.string(),
  markedByKind: z.enum(["instructor", "owner"]),
  // 이의 신청 입구(계약 04 §8 — 경로 자체는 S3-4.3c 가 만든다)
  disputePath: z.string(),
});

// ---- 오늘 결석 목록(계약 18 §8, S3-5.9b) — 앱 I26 이 이 응답 하나로 화면을 그린다 -----------------------------

/**
 * 지금 이 회차에서 결석을 표시·취소할 수 있는 구간 — 서버가 시각으로 판정해 내린다(앱이 48시간 식을 따로 갖지 않게).
 *   before_start: 시작 전(회원이 직접 결석 예정을 바꾸는 때 — §5) · open: 시작 뒤 ~ 끝 + 48시간 · locked: 그 뒤(대표만 사유를 적고 취소)
 */
export const ABSENCE_WINDOWS = ["before_start", "open", "locked"] as const;
export type AbsenceWindow = (typeof ABSENCE_WINDOWS)[number];

const count = z.number().int().nonnegative();

export const sessionAbsenceListSchema = z.strictObject({
  sessionId: z.string(),
  // 머리 줄 재료(보드 I26 「쌈바(입문) · 라틴하우스 강남 A홀 · 11/11 (수) 20:30–21:30」) — 계약 예시에 없던 칸(추천안·사후 확인 2026-11-24)
  classId: z.string(),
  academyId: z.string(),
  academyName: z.string(),
  title: z.string(),
  roomName: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  sessionStatus: z.enum(["scheduled", "cancelled", "closed"]),
  lockedAt: z.iso.datetime(),
  window: z.enum(ABSENCE_WINDOWS),
  // 부른 사람이 이 회차에서 무슨 자격인가 — 잠긴 뒤 취소(대표만)와 이의 처리(표시한 본인·대표) 단추를 가르는 데 쓴다
  viewerRole: z.enum(["owner", "instructor"]),
  seatCount: count,
  // 자리 종류별 결석 수 — 계약 18 §7 의 absencePlanned 와 같은 쿼리(홈 표 숫자와 늘 같다). any 는 단일 정원 회차
  absenceCount: z.strictObject({ male: count, female: count, any: count, total: count }),
  items: z.array(
    z.strictObject({
      markId: z.string(),
      memberId: z.string(),
      nickname: z.string(),
      gender: z.enum(GENDERS),
      monthsEnrolled: z.number().int().positive(),
      markedByKind: z.enum(ATTENDANCE_MARKED_BY_KINDS),
      markedAt: z.iso.datetime(),
      disputeStatus: z.enum(ATTENDANCE_DISPUTE_STATUSES),
      // 회원이 쓴 이의 사유 — 이의가 걸린 행에만(처리하는 사람이 읽고 정한다). 연락처는 없다
      disputeReason: z.string().nullable(),
      // 부른 사람이 이 행의 이의를 처리할 수 있나(이의가 걸려 있고, 표시한 본인이거나 대표)
      canResolveDispute: z.boolean(),
    }),
  ),
  // 이의를 받아들여 취소된 결석 — 「이의 결과」를 보는 자리(목록 items 에서는 빠졌으니 따로 내린다)
  acceptedDisputes: z.array(
    z.strictObject({
      markId: z.string(),
      memberId: z.string(),
      nickname: z.string(),
      gender: z.enum(GENDERS),
      disputeReason: z.string().nullable(),
      resolvedAt: z.iso.datetime(),
    }),
  ),
});
export type SessionAbsenceList = z.infer<typeof sessionAbsenceListSchema>;

// ---- 결석 표시 취소(계약 04 §6-2) ------------------------------------------------------------------

/** 본문 — 사유는 48시간 안에는 선택, 잠긴 뒤에는 필수. 빈 본문({})도 받는다 */
export const absenceCancelBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(ABSENCE_CANCEL_REASON_MAX).optional(),
});

export const absenceCancelResponseSchema = z.strictObject({
  markId: z.string(),
  cancelledAt: z.iso.datetime(),
  disputeStatus: z.enum(ATTENDANCE_DISPUTE_STATUSES),
});
export type AbsenceCancelResponse = z.infer<typeof absenceCancelResponseSchema>;

/**
 * 잠기는 시각 = 회차 끝 + 48시간. 서버가 읽을 때마다 이 식으로 계산한다(따로 칸을 두지 않는다 — 계약 04 §6-1 · 열린 점 ⑥).
 * S3-4.3b(결석 표시 48시간 확정 작업)도 같은 식을 써야 둘의 「잠김」 판정이 어긋나지 않는다.
 */
export function absenceLockedAt(endsAt: Temporal.Instant): Temporal.Instant {
  return endsAt.add({ hours: ABSENCE_LOCK_HOURS });
}

// ---- 읽기 도우미 ------------------------------------------------------------------------------

type Params = { params: Promise<{ classId: string; sessionId: string }> };
type MarkParams = { params: Promise<{ classId: string; sessionId: string; markId: string }> };

type SessionRow = {
  session_id: string;
  class_id: string;
  academy_id: string;
  class_title: string;
  offering_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  /** 담당 강사 — 회차에 따로 정했으면 그 강사, 아니면 수업의 담당 강사(빈 글자 = 없음) */
  instructor_id: string;
};

type MarkRow = { id: string; marked_by_kind: string; marked_at: string; dispute_status: string };

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

/** 서버 순서 #1 — 수업·회차가 이어져 있는지 함께 읽는다. 둘 중 하나라도 어긋나면 undefined(→ 404) */
async function readSession(db: Db, classId: string, sessionId: string): Promise<SessionRow | undefined> {
  const [row] = await db.query(
    db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.academy_id::text AS academy_id, c.title AS class_title,
                      o.id::text AS offering_id, s.status::text AS status,
                      to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS ends_at,
                      COALESCE(s.instructor_account_id::text, c.instructor_account_id::text, '') AS instructor_id
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               WHERE s.id = ${sessionId}::uuid AND c.id = ${classId}::uuid`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        academy_id: "pg/text@1",
        class_title: "pg/text@1",
        offering_id: "pg/text@1",
        status: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        instructor_id: "pg/text@1",
      })
      .build(),
  );
  return row;
}

/**
 * 서버 순서 #5 — memberId 가 그 회차의 확정 수강생인가. 예약 행은 FOR SHARE 로 잡아,
 * 이 트랜잭션 도중 취소가 끼어들어 「취소된 예약의 결석」이 생기지 않게 한다(S3-4.3 과 같은 조건).
 */
async function readConfirmedReservation(
  tx: Tx,
  offeringId: string,
  memberId: string,
): Promise<{ reservation_id: string; nickname: string } | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT r.id::text AS reservation_id, m.nickname
               FROM reservations r
               JOIN orders o ON o.id = r.order_id
               JOIN members m ON m.id = r.member_id
               WHERE r.offering_id = ${offeringId}::uuid AND r.member_id = ${memberId}::uuid
                 AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')
               FOR SHARE OF r`
      .returnsRow({ reservation_id: "pg/text@1", nickname: "pg/text@1" })
      .build(),
  );
  return row;
}

/** 이 예약·회차의 살아 있는 결석 행 — 부분 유니크(uq_attendance_session) 덕분에 많아야 1개 */
async function readLiveMark(tx: Tx, reservationId: string, sessionId: string): Promise<MarkRow | undefined> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id::text AS id, marked_by_kind::text AS marked_by_kind,
                      to_char(marked_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS marked_at, dispute_status::text AS dispute_status
               FROM attendance_marks
               WHERE reservation_id = ${reservationId}::uuid AND session_id = ${sessionId}::uuid AND cancelled_at IS NULL`
      .returnsRow({ id: "pg/text@1", marked_by_kind: "pg/text@1", marked_at: "pg/text@1", dispute_status: "pg/text@1" })
      .build(),
  );
  return row;
}

// ---- 경로 -----------------------------------------------------------------------------------

export type StaffAbsenceMarkDeps = GuardDeps & { clock?: Clock };

type MarkerKind = keyof typeof MARKER_LABEL;

export function createStaffAbsenceMarkRoutes(deps: StaffAbsenceMarkDeps) {
  // 직원 세션 읽기(관리자 웹이면 2단계 인증)는 수업 경로들과 같은 함수를 쓴다 — 기준이 두 벌이면 언젠가 어긋난다
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /**
   * 서버 순서 #1 의 권한 — 계약 18 §1-1 「§8 오늘 결석」 줄: 대표 ○ · 위임 강사(roster_manage) ○ · 담당 강사 ○ · 그 밖 -.
   * 돌려주는 값이 곧 행에 남길 「표시한 사람의 종류」다.
   */
  async function markerKindOf(staff: StaffAccountContext, row: SessionRow): Promise<MarkerKind> {
    // 대표가 먼저다 — 대표이면서 담당 강사여도 owner 로 남긴다
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return "owner";
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    // actor.delegations 는 active 소속에 매인 위임만 담는다(guards.loadStaffActor) — 위임을 끄면 다음 요청부터 403
    const delegated = (staff.actor.delegations[row.academy_id] ?? []).includes("roster_manage");
    const assigned = row.instructor_id !== "" && row.instructor_id === staff.staffAccountId;
    if (!delegated && !assigned) throw new HttpError("FORBIDDEN", DETAIL.forbidden);

    // 담당 강사도 지금 그 학원 active 소속이어야 한다(소속이 끝난 강사는 그 학원 회원 기록을 못 바꾼다)
    const [affiliation] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${row.academy_id}::uuid AND instructor_account_id = ${staff.staffAccountId}::uuid
                   AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return "instructor";
  }

  /** 서버 순서 #2~#4 — 예정 회차이고, 시작 뒤 ~ 끝 + 48시간 안이어야 표시한다 */
  function assertMarkable(row: SessionRow, now: Temporal.Instant): void {
    if (row.status !== "scheduled") throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
    if (Temporal.Instant.compare(now, Temporal.Instant.from(row.starts_at)) < 0) {
      throw HttpError.conflict("SESSION_NOT_STARTED", DETAIL.notStarted);
    }
    // 경계: 정확히 48시간째까지는 받는다(now <= ends_at + 48h, 계약 §6-1 #4)
    const lockedAt = absenceLockedAt(Temporal.Instant.from(row.ends_at));
    if (Temporal.Instant.compare(now, lockedAt) > 0) {
      throw HttpError.conflict("ABSENCE_WINDOW_CLOSED", DETAIL.windowClosed, { lockedAt: lockedAt.toString() });
    }
  }

  /** POST — 결석을 표시한다. 새로 만들면 201, 이미 살아 있는 결석 행이 있으면 200 으로 그 행 */
  const mark = withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readSession(db, ids.data.classId, ids.data.sessionId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const markerKind = await markerKindOf(staff, row);
    // 본문은 권한을 확인한 뒤에 본다 — 권한 없는 사람에게 입력 규칙부터 알려 주지 않는다
    const body = await parseJsonBody(request, staffAbsenceMarkBodySchema);
    const now = clock();
    assertMarkable(row, now);
    const lockedAt = absenceLockedAt(Temporal.Instant.from(row.ends_at)).toString();

    const result = await db.transaction(async (tx) => {
      const reservation = await readConfirmedReservation(tx, row.offering_id, body.memberId);
      if (reservation === undefined) throw new HttpError("NOT_FOUND", DETAIL.memberNotFound);

      // 먼저 SELECT 로 확인하지 않고 INSERT 를 시도한다 — 두 직원이 동시에 눌러도 부분 유니크가 한 행만 남기고,
      // 진 쪽은 DO NOTHING 으로 0행이 되어 감사·알림을 쓰지 않는다(한 번 표시 = 감사 1행 · 알림 1건).
      const [inserted] = await tx.query(
        tx.raw.sql`INSERT INTO attendance_marks (id, reservation_id, session_id, member_id, marked_by_kind, marked_by_staff_account_id, marked_at)
                   VALUES (uuidv7(), ${reservation.reservation_id}::uuid, ${row.session_id}::uuid, ${body.memberId}::uuid,
                           ${markerKind}, ${staff.staffAccountId}::uuid, ${now.toString()}::timestamptz)
                   ON CONFLICT (reservation_id, session_id) WHERE cancelled_at IS NULL DO NOTHING
                   RETURNING id::text AS id`
          .returnsRow({ id: "pg/text@1" })
          .build(),
      );
      const live = await readLiveMark(tx, reservation.reservation_id, row.session_id);
      // INSERT 가 졌는데 살아 있는 행도 없다 = 그 사이 회원이 결석 예정을 거뒀다. 드문 경합이라 다시 누르게 한다
      if (live === undefined) throw new HttpError("INTERNAL", DETAIL.retry);

      if (inserted !== undefined) {
        // 감사 1행 — 누가(직원 계정) · 어느 역할로 · 언제 · 전후(없음 → 결석)
        const after = JSON.stringify({
          memberId: body.memberId,
          reservationId: reservation.reservation_id,
          sessionId: row.session_id,
          markedByKind: markerKind,
          markedAt: live.marked_at,
        });
        await tx.execute(
          tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
                     VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${markerKind}, ${row.academy_id}::uuid,
                             'attendance.marked', 'attendance_marks', ${live.id}::uuid, ${after}::json)`
            .affectedCount()
            .build(),
        );

        // 회원 알림 1건 — 열쇠(absence:<markId>:marked)가 표시마다 달라, 같은 표시가 다시 처리돼도 한 건이다
        const sessionDate = formatKstDate(Temporal.Instant.from(row.starts_at));
        const payload = JSON.stringify(
          absenceMarkedPayloadSchema.parse({
            title: "결석으로 표시됐어요",
            body: `${row.class_title} ${sessionDate} 수업이 ${MARKER_LABEL[markerKind]}에 의해 결석으로 표시됐어요. 사실과 다르면 이의를 신청해 주세요`,
            classId: row.class_id,
            classTitle: row.class_title,
            sessionId: row.session_id,
            sessionDate,
            sessionStartsAt: row.starts_at,
            markId: live.id,
            markedByKind: markerKind,
            disputePath: `/api/me/attendance-marks/${live.id}/dispute`,
          }),
        );
        await tx.execute(
          tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, reservation_id, payload)
                     VALUES (uuidv7(), ${body.memberId}::uuid, ${row.academy_id}::uuid, 'absence_marked',
                             ${`absence:${live.id}:marked`}, ${reservation.reservation_id}::uuid, ${payload}::jsonb)
                     ON CONFLICT DO NOTHING`
            .affectedCount()
            .build(),
        );
      }

      const response: StaffAbsenceMarkResponse = {
        markId: live.id,
        sessionId: row.session_id,
        memberId: body.memberId,
        nickname: reservation.nickname,
        // 회원이 미리 알린 행을 「확정」한 호출이면 member 그대로다 — 확정은 따로 상태가 없다(계약 열린 점 ④)
        markedByKind: live.marked_by_kind as StaffAbsenceMarkResponse["markedByKind"],
        markedAt: live.marked_at,
        lockedAt,
        disputeStatus: live.dispute_status as StaffAbsenceMarkResponse["disputeStatus"],
      };
      return { status: inserted === undefined ? 200 : 201, body: response };
    });
    return Response.json(result.body, { status: result.status, headers: NO_STORE });
  });

  /** 지금 시각이 표시 구간의 어디인가(시작 전 · 열림 · 잠김) — 표시(#3·#4)와 같은 경계를 쓴다 */
  function windowOf(row: SessionRow, now: Temporal.Instant): AbsenceWindow {
    if (Temporal.Instant.compare(now, Temporal.Instant.from(row.starts_at)) < 0) return "before_start";
    const lockedAt = absenceLockedAt(Temporal.Instant.from(row.ends_at));
    return Temporal.Instant.compare(now, lockedAt) > 0 ? "locked" : "open";
  }

  /**
   * GET — 오늘 결석 목록(계약 18 §8, 보드 I26).
   * 권한은 표시와 같다(대표 · 위임 강사 · 담당 강사). 읽기만 하므로 회차 상태·시각과 상관없이 보인다.
   *   items            = 살아 있는 결석 행(회원이 알린 것 + 강사·대표가 표시한 것). 유지된 이의(rejected)도 여기서 결과가 보인다
   *   acceptedDisputes = 이의를 받아들여 취소된 행 — 목록에서는 빠졌지만 「이의 결과」를 보여 줘야 해서 따로 내린다
   *   absenceCount     = 명단·홈 표와 같은 조건(예약 confirmed + 주문 paid·partially_refunded)으로 센 살아 있는 결석
   */
  const list = withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readSession(db, ids.data.classId, ids.data.sessionId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const viewerRole = await markerKindOf(staff, row);
    const now = clock();

    // 머리 줄 — 학원 이름과 홀(회차의 홀, 없으면 수업의 기본 홀)
    const [head] = await db.query(
      db.raw.sql`SELECT a.name AS academy_name, COALESCE(rs.name, rc.name, '') AS room_name
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 LEFT JOIN rooms rs ON rs.id = s.room_id
                 LEFT JOIN rooms rc ON rc.id = c.room_id
                 WHERE s.id = ${row.session_id}::uuid`
        .returnsRow({ academy_name: "pg/text@1", room_name: "pg/text@1" })
        .build(),
    );

    // 확정 수강생 수(「자리 19명」) — 홈 표(계약 18 §7)의 confirmed 와 같은 원천
    const [seat] = await db.query(
      db.raw.sql`SELECT COALESCE(sum(confirmed_count), 0)::int4 AS n FROM seat_pools WHERE offering_id = ${row.offering_id}::uuid`
        .returnsRow({ n: "pg/int4@1" })
        .build(),
    );

    // 결석 행 전부(살아 있는 것 + 이의로 취소된 것). 결제 완료 수강생의 행만 — 명단·홈 표와 같은 조건
    const marks = await db.query(
      db.raw.sql`SELECT a.id::text AS mark_id, m.id::text AS member_id, m.nickname, m.gender::text AS gender,
                        r.seat_kind::text AS seat_kind, a.marked_by_kind::text AS marked_by_kind,
                        COALESCE(a.marked_by_staff_account_id::text, '') AS marked_by_staff,
                        to_char(a.marked_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS marked_at,
                        (a.cancelled_at IS NOT NULL) AS cancelled,
                        a.dispute_status::text AS dispute_status, COALESCE(a.dispute_reason, '') AS dispute_reason,
                        COALESCE(to_char(a.dispute_resolved_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS resolved_at,
                        COALESCE((SELECT to_char(min(COALESCE(p.paid_at, o2.paid_at)) AT TIME ZONE 'UTC', ${ISO_UTC})
                                  FROM orders o2
                                  JOIN class_offerings co2 ON co2.id = o2.offering_id
                                  JOIN classes c2 ON c2.id = co2.class_id
                                  LEFT JOIN payments p ON p.order_id = o2.id AND p.paid_at IS NOT NULL
                                  WHERE o2.member_id = m.id AND c2.academy_id = ${row.academy_id}::uuid
                                    AND o2.status IN ('paid', 'partially_refunded', 'refunded')), '') AS first_paid_at
                 FROM attendance_marks a
                 JOIN reservations r ON r.id = a.reservation_id
                 JOIN orders o ON o.id = r.order_id
                 JOIN members m ON m.id = a.member_id
                 WHERE a.session_id = ${row.session_id}::uuid
                   AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')
                   AND (a.cancelled_at IS NULL OR a.dispute_status = 'accepted')
                 ORDER BY a.marked_at, a.id`
        .returnsRow({
          mark_id: "pg/text@1",
          member_id: "pg/text@1",
          nickname: "pg/text@1",
          gender: "pg/text@1",
          seat_kind: "pg/text@1",
          marked_by_kind: "pg/text@1",
          marked_by_staff: "pg/text@1",
          marked_at: "pg/text@1",
          cancelled: "pg/bool@1",
          dispute_status: "pg/text@1",
          dispute_reason: "pg/text@1",
          resolved_at: "pg/text@1",
          first_paid_at: "pg/text@1",
        })
        .build(),
    );

    const live = marks.filter((m) => !m.cancelled);
    const accepted = marks.filter((m) => m.cancelled);
    const kindCount = (kind: string) => live.filter((m) => m.seat_kind === kind).length;
    const startsAt = Temporal.Instant.from(row.starts_at);
    const reasonOf = (text: string) => (text === "" ? null : text);

    const body: SessionAbsenceList = {
      sessionId: row.session_id,
      classId: row.class_id,
      academyId: row.academy_id,
      academyName: head?.academy_name ?? "",
      title: row.class_title,
      roomName: head === undefined || head.room_name === "" ? null : head.room_name,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      sessionStatus: row.status as SessionAbsenceList["sessionStatus"],
      lockedAt: absenceLockedAt(Temporal.Instant.from(row.ends_at)).toString(),
      window: windowOf(row, now),
      viewerRole,
      seatCount: seat?.n ?? 0,
      absenceCount: { male: kindCount("male"), female: kindCount("female"), any: kindCount("any"), total: live.length },
      items: live.map((m) => ({
        markId: m.mark_id,
        memberId: m.member_id,
        nickname: m.nickname,
        gender: m.gender as Gender,
        monthsEnrolled: countEnrolledMonths(m.first_paid_at === "" ? startsAt : Temporal.Instant.from(m.first_paid_at), startsAt),
        markedByKind: m.marked_by_kind as SessionAbsenceList["items"][number]["markedByKind"],
        markedAt: m.marked_at,
        disputeStatus: m.dispute_status as SessionAbsenceList["items"][number]["disputeStatus"],
        disputeReason: m.dispute_status === "none" ? null : reasonOf(m.dispute_reason),
        // 이의 처리 자격(S3-4.3c 와 같은 기준) — 대표이거나 그 결석을 표시한 직원 본인
        canResolveDispute: m.dispute_status === "requested" && (viewerRole === "owner" || m.marked_by_staff === staff.staffAccountId),
      })),
      acceptedDisputes: accepted.map((m) => ({
        markId: m.mark_id,
        memberId: m.member_id,
        nickname: m.nickname,
        gender: m.gender as Gender,
        disputeReason: reasonOf(m.dispute_reason),
        resolvedAt: m.resolved_at === "" ? m.marked_at : m.resolved_at,
      })),
    };
    // 계약 스키마로 한 번 더 검사한다 — 연락처 같은 칸이 섞여 나가면 여기서 막힌다
    return Response.json(sessionAbsenceListSchema.parse(body), { headers: NO_STORE });
  });

  /**
   * POST …/absences/{markId}/cancel — 결석 표시를 취소한다(출석으로 돌아간다, 계약 04 §6-2).
   *   48시간 안: 표시할 수 있는 사람(대표 · 위임 강사 · 담당 강사)이 취소한다. 사유는 선택.
   *   잠긴 뒤: 대표만, 사유 필수(FR-104 「수업 종료 후 수정하려면 사유가 남아야 한다」).
   *   시작 전: 회원이 직접 결석 예정을 바꾸는 때라 409 SESSION_NOT_STARTED.
   *   행은 지우지 않고 cancelled_at 만 채운다 + 감사 attendance.cancelled 1행.
   *   이의가 걸린 행(requested)을 취소하면 이의를 받아들인 것과 같다 — accepted + 회원 알림 absence_dispute_resolved 1건.
   *   이미 취소된 행이면 바뀐 게 없으니 200 같은 본문(감사·알림 없음).
   */
  const cancel = withRoute<MarkParams>(async (request, context) => {
    const staff = await readStaff(request);
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid(), markId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.markNotFound);
    const row = await readSession(db, ids.data.classId, ids.data.sessionId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const role = await markerKindOf(staff, row);
    const body = await parseJsonBody(request, absenceCancelBodySchema);
    const reason = body.reason ?? null;
    const now = clock();

    if (row.status !== "scheduled") throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
    const window = windowOf(row, now);
    if (window === "before_start") throw HttpError.conflict("SESSION_NOT_STARTED", DETAIL.cancelNotStarted);
    // 잠긴 뒤에는 대표만, 사유를 남겨야 한다 — 권한을 먼저 보고(403) 그다음 사유(422)
    if (window === "locked" && role !== "owner") throw new HttpError("FORBIDDEN", DETAIL.lockedOwnerOnly);
    if (window === "locked" && reason === null) throw HttpError.unprocessable("ABSENCE_REASON_REQUIRED", DETAIL.reasonRequired);

    const cancelledAtText = now.toString({ smallestUnit: "second" });
    const result = await db.transaction(async (tx) => {
      // 행을 잠그고 읽는다 — 이의 처리·다른 직원의 취소와 겹쳐도 한 번만 바뀐다
      const [mark] = await tx.query(
        tx.raw.sql`SELECT a.id::text AS id, a.member_id::text AS member_id, a.reservation_id::text AS reservation_id,
                          a.marked_by_kind::text AS marked_by_kind, a.dispute_status::text AS dispute_status,
                          COALESCE(to_char(a.cancelled_at AT TIME ZONE 'UTC', ${ISO_UTC}), '') AS cancelled_at
                   FROM attendance_marks a
                   WHERE a.id = ${ids.data.markId}::uuid AND a.session_id = ${row.session_id}::uuid
                   FOR UPDATE OF a`
          .returnsRow({
            id: "pg/text@1",
            member_id: "pg/text@1",
            reservation_id: "pg/text@1",
            marked_by_kind: "pg/text@1",
            dispute_status: "pg/text@1",
            cancelled_at: "pg/text@1",
          })
          .build(),
      );
      if (mark === undefined) throw new HttpError("NOT_FOUND", DETAIL.markNotFound);
      // 이미 취소된 행 — 같은 본문을 돌려준다(멱등)
      if (mark.cancelled_at !== "") {
        return { markId: mark.id, cancelledAt: mark.cancelled_at, disputeStatus: mark.dispute_status } as AbsenceCancelResponse;
      }

      // 이의가 걸려 있으면 받아들임과 같다(§6-2) — 처리 시각·처리자도 함께 채운다
      const acceptsDispute = mark.dispute_status === "requested";
      const nextDispute = acceptsDispute ? "accepted" : mark.dispute_status;
      await tx.execute(
        tx.raw.sql`UPDATE attendance_marks
                   SET cancelled_at = ${cancelledAtText}::timestamptz,
                       dispute_status = ${nextDispute},
                       dispute_resolved_at = CASE WHEN ${acceptsDispute} THEN ${cancelledAtText}::timestamptz ELSE dispute_resolved_at END,
                       dispute_resolved_by_account_id = CASE WHEN ${acceptsDispute} THEN ${staff.staffAccountId}::uuid ELSE dispute_resolved_by_account_id END
                   WHERE id = ${mark.id}::uuid AND cancelled_at IS NULL`
          .affectedCount()
          .build(),
      );

      // 감사 1행 — 누가 · 어느 역할 · 언제 · 전후 · 사유(잠긴 뒤 취소는 사유가 반드시 있다)
      const before = JSON.stringify({ cancelledAt: null, disputeStatus: mark.dispute_status, markedByKind: mark.marked_by_kind });
      const after = JSON.stringify({ cancelledAt: cancelledAtText, disputeStatus: nextDispute, window });
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after, reason)
                   VALUES (uuidv7(), 'staff', ${staff.staffAccountId}::uuid, ${role}, ${row.academy_id}::uuid,
                           'attendance.cancelled', 'attendance_marks', ${mark.id}::uuid, ${before}::json, ${after}::json, NULLIF(${reason ?? ""}, ''))`
          .affectedCount()
          .build(),
      );

      // 이의를 받아들인 셈이면 회원에게 결과를 알린다 — 이의 처리(S3-4.3c)와 같은 종류·같은 열쇠라 두 경로가 겹쳐도 한 건이다
      if (acceptsDispute) {
        const sessionDate = formatKstDate(Temporal.Instant.from(row.starts_at));
        const payload = JSON.stringify(
          disputeResolvedPayloadSchema.parse({
            title: "결석 표시가 취소됐어요",
            body: `${row.class_title} ${sessionDate} 수업의 이의를 확인했어요. 결석 표시가 취소됐어요${reason === null ? "" : ` (${reason})`}`,
            markId: mark.id,
            classId: row.class_id,
            classTitle: row.class_title,
            sessionId: row.session_id,
            sessionDate,
            decision: "accept",
            note: reason,
          }),
        );
        await tx.execute(
          tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, reservation_id, payload)
                     VALUES (uuidv7(), ${mark.member_id}::uuid, ${row.academy_id}::uuid, 'absence_dispute_resolved',
                             ${`absence:${mark.id}:dispute_resolved`}, ${mark.reservation_id}::uuid, ${payload}::jsonb)
                     ON CONFLICT DO NOTHING`
            .affectedCount()
            .build(),
        );
      }
      return { markId: mark.id, cancelledAt: cancelledAtText, disputeStatus: nextDispute } as AbsenceCancelResponse;
    });
    return Response.json(absenceCancelResponseSchema.parse(result), { headers: NO_STORE });
  });

  return { mark, list, cancel };
}
