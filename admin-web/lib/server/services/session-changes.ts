// S2-3.2(시간·장소 변경과 휴강 알림) — 강사(또는 대표)가 회차 하나의 시간·장소를 바꾸거나, 휴강·폐강을 알린다.
//   계약: _workspace/03_contracts/11-instructor.md §6-1(시간·장소 변경, I34) · §6-2(휴강·폐강, I25) · §7(알림 종류)
//   경로: POST /api/classes/{classId}/sessions/{sessionId}/change-preview · …/change · …/cancel-preview · …/cancel
//   데이터: data-model §8-2(class_sessions.cancelled_at·cancel_reason) · §8-5(session_changes) · §8-7(알림 종류)
//   요구: FR-055(휴강·보강 통지) · FR-056(시간·장소 변경 통지) · FR-065(회차 휴강·폐강 선택) · Q40(회차 하나 변경은 대표 승인 없음)
//
// 흐름 한눈에 — 변경 하나가 한 트랜잭션 안에서 「회차 → 변경 기록 → 알림 행 → 감사」를 함께 쓴다:
//   change  : 겹침 확인 → 회차 시각·홀 갱신 → session_changes(time_place, 전후 값) → 회원 캘린더 시각 갱신
//             → 결제 확정 회원마다 알림 session_time_place_changed → 대표 알림 instructor_session_changed → 감사
//   cancel  : this_session       → 회차 cancelled(휴강) + session_changes(cancelled, 회원 선택 기한)
//             this_and_following → 이 회차부터 남은 예정 회차 모두 closed(폐강) + 회차마다 session_changes(closed, 같은 batch_id)
//                                  남은 예정 회차가 0 이면 수업 published → cancelled
//             → 회원마다 알림 1건(session_cancelled · class_closed) → 대표 알림 → 감사
//   알림 행은 delivery_status = pending 으로 남기만 한다. 실제 발송(푸시)은 커밋 뒤 NotificationSenderPort(S7-1)의 일이다.
//
// 이 Task 가 하지 않는 것(뒤 Task 몫):
//   휴강 회차의 회원 선택 행(closure_choices)과 알림 closure_choice_open 은 S4-3(휴강 선택 열기)의 openClosureChoices 가 만든다.
//   여기서는 그 기한(알린 날 + 7일의 KST 23:59)을 같은 순수 함수로 계산해 session_changes 에 사본으로 남긴다.
//   환불 금액 계산·옮기기는 S4-3, 공개 뒤 이후 회차 전부를 바꾸는 수정 요청은 §5(수정 요청 Task)다.
//
// 누가 부를 수 있나(계약 11 §6 머리) — 그 수업의 올린 사람 · 담당 강사(수업 또는 이 회차) · 그 학원 대표.
//   강사는 지금도 그 학원 active 소속이어야 한다(소속이 끝난 강사가 회원에게 알림을 보내지 못하게, 403 AFFILIATION_REQUIRED).
//   수업 등록 위임(class_submit)은 묻지 않는다 — 대표가 대신 올려 준 수업의 담당 강사도 자기 회차는 바꿀 수 있어야 한다.
//   강사 멤버십이 끝나도 쓴다(FR-056 · I34 — 멤버십 판정 없음).
import { z } from "zod";

import { isEventClassKind } from "../../domain/class-registration";
import type { ClassKind } from "../../domain/constants";
import {
  CANCEL_REASON_MAX,
  CLOSURE_CHOICE_DEFAULT,
  CLOSURE_CHOICE_OPTIONS,
  classClosedMessage,
  closureChoiceDeadline,
  isOnTimeStep,
  perSessionAmount,
  sessionCancelledMessage,
  timePlaceMessage,
  type SessionSlot,
} from "../../domain/session-change";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps, StaffAccountContext } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import { currentRevisionNo } from "./class-approval";
import { assertActiveRoom, createClassAccess } from "./class-registration";
import {
  assertNoScheduleConflict,
  computeScheduleConflicts,
  lockScheduleOwners,
  readScheduledSessions,
  toScheduleConflictFromDb,
} from "./class-schedule-conflicts";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 사람이 읽는 문장 --------------------------------------------------------------------------

const DETAIL = {
  notFound: "회차를 찾을 수 없어요",
  forbidden: "이 수업의 회차를 바꿀 권한이 없어요",
  affiliation: "이 학원 소속 강사만 회차를 바꿀 수 있어요",
  started: "이미 시작한 회차는 바꿀 수 없어요",
  notScheduled: "이미 휴강·폐강한 회차예요",
  eventCancel: "행사·원데이 수업의 취소는 대표의 행사 일괄 취소로 해요",
  validation: "입력값을 확인해 주세요",
  keyReused: "같은 Idempotency-Key 로 다른 요청을 보냈어요",
  settlementNote: "휴강 회차는 환불을 먼저 처리하고 정산에서 빠져요",
  refundBasis: "결제액 ÷ 회차 수",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const invalid = (path: string, message: string): HttpError =>
  new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });

// ---- 요청 본문 --------------------------------------------------------------------------------

/** 시간·장소 변경(계약 11 §6-1) — 바꿀 값만 보낸다. 시각은 시작·끝을 함께 보낸다 */
export const sessionChangeBodySchema = z
  .strictObject({
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().optional(),
    roomId: z.uuid().optional(),
  })
  .refine((b) => (b.startsAt === undefined) === (b.endsAt === undefined), {
    path: ["endsAt"],
    message: "시작·끝 시각을 함께 보내 주세요",
  })
  .refine((b) => b.startsAt !== undefined || b.roomId !== undefined, { path: ["startsAt"], message: "바꿀 값을 보내 주세요" });
export type SessionChangeBody = z.infer<typeof sessionChangeBodySchema>;

export const CANCEL_SCOPES = ["this_session", "this_and_following"] as const;
type CancelScope = (typeof CANCEL_SCOPES)[number];

const reasonSchema = z.string().trim().min(1, "휴강 사유를 적어 주세요").max(CANCEL_REASON_MAX, `사유는 ${CANCEL_REASON_MAX}자까지예요`);

/** 휴강·폐강(계약 11 §6-2) — 사유는 수강생에게 그대로 보인다 */
export const sessionCancelBodySchema = z.strictObject({ scope: z.enum(CANCEL_SCOPES), reason: reasonSchema });
/** 미리 보기는 사유 없이도 부를 수 있다(받는 회원 수·기한만 본다) */
export const sessionCancelPreviewBodySchema = z.strictObject({ scope: z.enum(CANCEL_SCOPES), reason: reasonSchema.optional() });

// ---- 응답 모양(계약 11 §6-1 · §6-2) — 테스트가 이 스키마로 응답을 parse 한다 -------------------------

const slotOut = z.strictObject({ startsAt: z.string(), endsAt: z.string(), roomName: z.string() });
const conflictOut = z.strictObject({ startsAt: z.string(), endsAt: z.string(), overlapMinutes: z.number(), label: z.string() });

export const sessionChangePreviewSchema = z.strictObject({
  before: slotOut,
  after: slotOut,
  conflicts: z.array(conflictOut),
  roomConflicts: z.array(conflictOut),
  notifyMemberCount: z.number().int(),
  notifyOwner: z.boolean(),
  memberMessage: z.strictObject({ title: z.string(), body: z.string(), refundHint: z.string() }),
});
export const sessionChangeResultSchema = z.strictObject({
  sessionId: z.string(),
  status: z.literal("scheduled"),
  changeId: z.string(),
  notifiedMemberCount: z.number().int(),
});
export const sessionCancelPreviewSchema = z.strictObject({
  scope: z.enum(CANCEL_SCOPES),
  sessionCount: z.number().int(),
  notifyMemberCount: z.number().int(),
  memberChoice: z
    .strictObject({ options: z.array(z.enum(CLOSURE_CHOICE_OPTIONS)), deadlineAt: z.string(), defaultOnExpire: z.literal(CLOSURE_CHOICE_DEFAULT) })
    .nullable(),
  refundHint: z.strictObject({
    perSessionAmountBasis: z.string(),
    example: z.strictObject({ paid: z.number().int(), sessionTotal: z.number().int(), amount: z.number().int() }).nullable(),
  }),
  settlementNote: z.string(),
});
export const sessionCancelResultSchema = z.strictObject({
  changeIds: z.array(z.string()),
  batchId: z.string(),
  status: z.enum(["cancelled", "closed"]),
  notifiedMemberCount: z.number().int(),
  memberChoiceDeadlineAt: z.string().nullable(),
});
type ChangeResult = z.infer<typeof sessionChangeResultSchema>;
type CancelResult = z.infer<typeof sessionCancelResultSchema>;

// ---- 회차 읽기 --------------------------------------------------------------------------------

const SESSION_ROW = {
  session_id: "pg/text@1",
  class_id: "pg/text@1",
  academy_id: "pg/text@1",
  class_title: "pg/text@1",
  class_kind: "pg/text@1",
  class_status: "pg/text@1",
  created_by: "pg/text@1",
  class_instructor_id: "pg/text@1",
  session_instructor_id: "pg/text@1",
  offering_id: "pg/text@1",
  status: "pg/text@1",
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  room_id: "pg/text@1",
  room_name: "pg/text@1",
  price_amount: "pg/int4@1",
  offering_session_count: "pg/int4@1",
} as const;

/** 회차 한 줄과 그 수업·판매 단위의 값. 빈 칸은 빈 글자, 시각은 「…Z」 글자 */
type SessionRow = {
  session_id: string;
  class_id: string;
  academy_id: string;
  class_title: string;
  class_kind: string;
  class_status: string;
  created_by: string;
  class_instructor_id: string;
  session_instructor_id: string;
  offering_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  room_id: string;
  room_name: string;
  price_amount: number;
  offering_session_count: number;
};

/** 회차를 읽는다. 트랜잭션 안에서는 forUpdate 로 그 회차 행을 잠근다(휴강과 변경이 동시에 와도 하나씩) */
async function readSession(db: Db | Tx, classId: string, sessionId: string, forUpdate: boolean): Promise<SessionRow | undefined> {
  const query = forUpdate
    ? db.raw.sql`SELECT s.id::text AS session_id FROM class_sessions s WHERE s.id = ${sessionId}::uuid FOR UPDATE`
        .returnsRow({ session_id: "pg/text@1" })
        .build()
    : null;
  if (query !== null) await db.query(query);
  const [row] = await db.query(
    db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.academy_id::text AS academy_id, c.title AS class_title,
                      c.class_kind, c.status AS class_status, COALESCE(c.created_by_account_id::text, '') AS created_by,
                      COALESCE(c.instructor_account_id::text, '') AS class_instructor_id,
                      COALESCE(s.instructor_account_id::text, '') AS session_instructor_id,
                      o.id::text AS offering_id, s.status,
                      to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      COALESCE(s.room_id::text, '') AS room_id, COALESCE(r.name, '') AS room_name,
                      o.price_amount::int4 AS price_amount,
                      (SELECT count(*) FROM class_sessions x WHERE x.offering_id = o.id)::int4 AS offering_session_count
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               LEFT JOIN rooms r ON r.id = s.room_id
               WHERE s.id = ${sessionId}::uuid AND c.id = ${classId}::uuid`
      .returnsRow(SESSION_ROW)
      .build(),
  );
  return row;
}

async function roomNameOf(db: Db | Tx, roomId: string): Promise<string> {
  if (roomId === "") return "";
  const [row] = await db.query(
    db.raw.sql`SELECT name FROM rooms WHERE id = ${roomId}::uuid`.returnsRow({ name: "pg/text@1" }).build(),
  );
  return row?.name ?? "";
}

/**
 * 알림을 받을 회원 수 — 그 회차들이 속한 판매 단위의 「결제 확정」 예약 회원(중복 제거).
 * 결제 대기(held)·취소 회원은 받지 않는다(계약 11 §6-1 「결제 확정 회원 전원」).
 */
async function countMembers(db: Db | Tx, sessionIds: readonly string[]): Promise<number> {
  const [row] = await db.query(
    db.raw.sql`SELECT count(DISTINCT r.member_id)::int4 AS n
               FROM reservations r
               WHERE r.status = 'confirmed'
                 AND r.offering_id IN (SELECT s.offering_id FROM class_sessions s
                                       WHERE s.id::text = ANY(string_to_array(${sessionIds.join(",")}, ',')))`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );
  return row?.n ?? 0;
}

// ---- 누가 부르나 -------------------------------------------------------------------------------

export type Caller = { accountId: string; isOwner: boolean };

export type SessionChangeDeps = GuardDeps & { clock?: Clock };

type Params = { params: Promise<{ classId: string; sessionId: string }> };

export function createSessionChangeRoutes(deps: SessionChangeDeps) {
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** 대표면 통과. 강사면 올린 사람·담당 강사(수업 또는 이 회차)이고 지금 active 소속이어야 한다 */
  async function requireCaller(staff: StaffAccountContext, row: SessionRow): Promise<Caller> {
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return { accountId: staff.staffAccountId, isOwner: true };
    const me = staff.staffAccountId;
    const mine = [row.created_by, row.class_instructor_id, row.session_instructor_id].includes(me);
    if (!mine) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const [aff] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${row.academy_id}::uuid AND instructor_account_id = ${me}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (aff === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
    return { accountId: me, isOwner: false };
  }

  /** 경로 id 둘을 읽고 회차·부르는 사람을 확인한다. 순서: 인증 → 회차 있음(404) → 권한(403) */
  async function load(request: Request, context: Params): Promise<{ row: SessionRow; caller: Caller }> {
    const staff = await readStaff(request);
    const params = await context.params;
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid() }).safeParse(params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readSession(db, ids.data.classId, ids.data.sessionId, false);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return { row, caller: await requireCaller(staff, row) };
  }

  /** 시작 전 · 예정 상태인 회차만 바꾼다(계약 11 §6-1 · §6-2 오류 표) */
  function assertChangeable(row: SessionRow, now: Temporal.Instant): void {
    if (row.status !== "scheduled") throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
    if (Temporal.Instant.compare(Temporal.Instant.from(row.starts_at), now) <= 0) {
      throw HttpError.conflict("SESSION_ALREADY_STARTED", DETAIL.started);
    }
  }

  // ---- §6-1 시간·장소 변경 -----------------------------------------------------------------

  type ChangePlan = { before: SessionSlot; after: SessionSlot; afterRoomId: string };

  /** 요청을 「바뀐 뒤 값」으로 만들고 검사한다(미리 보기와 저장이 같은 함수를 쓴다 — 둘의 판정이 어긋나지 않게) */
  async function planChange(row: SessionRow, body: SessionChangeBody, now: Temporal.Instant): Promise<ChangePlan> {
    assertChangeable(row, now);
    const before: SessionSlot = {
      startsAt: Temporal.Instant.from(row.starts_at),
      endsAt: Temporal.Instant.from(row.ends_at),
      roomName: row.room_name,
    };
    const startsAt = body.startsAt === undefined ? before.startsAt : Temporal.Instant.from(body.startsAt);
    const endsAt = body.endsAt === undefined ? before.endsAt : Temporal.Instant.from(body.endsAt);
    if (!isOnTimeStep(startsAt) || !isOnTimeStep(endsAt)) throw invalid("startsAt", "시각은 10분 단위로 골라 주세요");
    if (Temporal.Instant.compare(endsAt, startsAt) <= 0) throw invalid("endsAt", "끝 시각은 시작 시각보다 늦어야 해요");
    if (Temporal.Instant.compare(startsAt, now) <= 0) throw invalid("startsAt", "지금 이후 시각으로 골라 주세요");

    const afterRoomId = body.roomId ?? row.room_id;
    if (body.roomId !== undefined) await assertActiveRoom(db, row.academy_id, body.roomId, invalid);
    const after: SessionSlot = { startsAt, endsAt, roomName: afterRoomId === row.room_id ? row.room_name : await roomNameOf(db, afterRoomId) };

    // 바뀐 게 없으면 회원에게 알릴 것도 없다 — 422(계약 11 §6-1 「바뀐 게 없음 포함」)
    const same = startsAt.equals(before.startsAt) && endsAt.equals(before.endsAt) && afterRoomId === row.room_id;
    if (same) throw invalid("startsAt", "바뀐 값이 없어요");
    return { before, after, afterRoomId };
  }

  /** 겹침 판정 입력 — 이 회차 자신은 빼고, 같은 수업의 다른 회차와 겹치는지는 그대로 본다 */
  function conflictInput(row: SessionRow, plan: ChangePlan, caller: Caller) {
    return {
      academyId: row.academy_id,
      instructorAccountId: row.session_instructor_id === "" ? null : row.session_instructor_id,
      roomId: plan.afterRoomId === "" ? null : plan.afterRoomId,
      sessions: [{ startsAt: plan.after.startsAt, endsAt: plan.after.endsAt }],
      callerIsOwner: caller.isOwner,
      excludeSessionId: row.session_id,
    };
  }

  const changePreview = withRoute<Params>(async (request, context) => {
    const { row, caller } = await load(request, context);
    const body = await parseJsonBody(request, sessionChangeBodySchema);
    const plan = await planChange(row, body, clock());
    const input = conflictInput(row, plan, caller);
    const rows = await readScheduledSessions(db, {
      instructorAccountId: input.instructorAccountId,
      roomId: input.roomId,
      from: plan.after.startsAt.toString(),
      to: plan.after.endsAt.toString(),
      excludeSessionId: row.session_id,
    });
    const { conflicts, roomConflicts } = computeScheduleConflicts(input, rows);
    const out = {
      before: slotJson(plan.before),
      after: slotJson(plan.after),
      conflicts,
      roomConflicts: roomConflicts.map(({ room: _room, ...rest }) => rest),
      notifyMemberCount: await countMembers(db, [row.session_id]),
      notifyOwner: !caller.isOwner,
      memberMessage: timePlaceMessage(row.class_title, plan.before, plan.after),
    };
    return Response.json(out, { headers: NO_STORE });
  });

  const change = withRoute<Params>(async (request, context) => {
    const { row, caller } = await load(request, context);
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, sessionChangeBodySchema);

    // 같은 키로 다시 왔으면 아무것도 쓰지 않고 처음 결과(README §5 — 본문이 달라도 처음 것)
    const replay = await findChangeReplay(db, caller.accountId, key);
    if (replay !== null) return Response.json(toChangeReplay(replay), { headers: NO_STORE });

    const now = clock();
    const plan = await planChange(row, body, now);
    const nowIso = now.toString();

    const result = await db
      .transaction(async (tx): Promise<ChangeResult> => {
        // 같은 강사·같은 홀 잠금(수업 등록과 같은 순서: 강사 → 홀) — 동시에 두 회차를 같은 시각으로 옮기지 못하게
        const input = conflictInput(row, plan, caller);
        if (input.instructorAccountId !== null) await lockScheduleOwners(tx, input.instructorAccountId, input.roomId);
        // 잠근 뒤 다시 읽는다 — 그 사이 휴강됐거나 시작했으면 409
        const fresh = await readSession(tx, row.class_id, row.session_id, true);
        if (fresh === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        assertChangeable(fresh, now);
        if (input.instructorAccountId !== null) {
          await assertNoScheduleConflict(tx, { ...input, instructorAccountId: input.instructorAccountId });
        } else {
          // 담당 강사가 없는 옛 회차(시드·픽스처) — 홀 겹침만 본다
          await lockRoomOnly(tx, input.roomId);
          await assertNoRoomConflict(tx, input);
        }

        // ① 회차 시각·홀 — 조건부 갱신(예정일 때만)
        const moved = await tx.execute(
          tx.raw.sql`UPDATE class_sessions
                     SET starts_at = ${plan.after.startsAt.toString()}::timestamptz, ends_at = ${plan.after.endsAt.toString()}::timestamptz,
                         room_id = NULLIF(${plan.afterRoomId}, '')::uuid
                     WHERE id = ${row.session_id}::uuid AND status = 'scheduled'`
            .affectedCount()
            .build(),
        );
        if (moved.affectedRows === 0) throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);

        // ② 변경 기록 — 전후 값(회원 알림 문구가 이 둘을 읽는다)
        const memberCount = await countMembers(tx, [row.session_id]);
        const beforeJson = JSON.stringify({ ...slotJson(plan.before), roomId: row.room_id === "" ? null : row.room_id });
        const afterJson = JSON.stringify({ ...slotJson(plan.after), roomId: plan.afterRoomId === "" ? null : plan.afterRoomId });
        const [changeRow] = await tx.query(
          tx.raw.sql`INSERT INTO session_changes (id, class_id, session_id, kind, before, after, changed_by_account_id,
                                                  notified_member_count, idempotency_key, created_at)
                     VALUES (uuidv7(), ${row.class_id}::uuid, ${row.session_id}::uuid, 'time_place', ${beforeJson}::jsonb, ${afterJson}::jsonb,
                             ${caller.accountId}::uuid, ${memberCount}, ${key}, ${nowIso}::timestamptz)
                     RETURNING id::text AS id`
            .returnsRow({ id: "pg/text@1" })
            .build(),
        );
        if (changeRow === undefined) throw new Error("변경 기록을 쓰지 못했다");
        const changeId = changeRow.id;

        // ③ 회원 캘린더의 그 회차 시각도 같이 옮긴다(캘린더는 회차 시각의 사본이다)
        await tx.execute(
          tx.raw.sql`UPDATE calendar_entries SET starts_at = ${plan.after.startsAt.toString()}::timestamptz,
                                                 ends_at = ${plan.after.endsAt.toString()}::timestamptz
                     WHERE session_id = ${row.session_id}::uuid`
            .affectedCount()
            .build(),
        );

        // ④ 결제 확정 회원마다 알림 1건 — 열쇠가 회원마다 달라 같은 변경을 다시 처리해도 한 건이다
        const message = timePlaceMessage(row.class_title, plan.before, plan.after);
        const memberPayload = JSON.stringify({
          classId: row.class_id,
          sessionId: row.session_id,
          changeId,
          ...message,
          before: slotJson(plan.before),
          after: slotJson(plan.after),
        });
        await insertMemberNotifications(tx, {
          kind: "session_time_place_changed",
          academyId: row.academy_id,
          sessionIds: [row.session_id],
          dedupePrefix: `sessionchange:${changeId}:`,
          payload: memberPayload,
        });

        // ⑤ 대표 알림 — 강사가 바꿨을 때만(대표가 직접 바꾸면 만들지 않는다)
        if (!caller.isOwner) {
          await insertOwnerNotification(tx, row.academy_id, `sessionchange:${changeId}:owner`, {
            classId: row.class_id,
            sessionId: row.session_id,
            changeId,
            kind: "time_place",
            title: `시간·장소 변경 · ${row.class_title}`,
            body: `${message.body} · 수강생 ${memberCount}명에게 알림이 갔어요`,
          });
        }

        // ⑥ 감사
        await insertAudit(tx, caller, row.academy_id, "session.time_place_changed", row.session_id, beforeJson, afterJson, null);
        return { sessionId: row.session_id, status: "scheduled", changeId, notifiedMemberCount: memberCount };
      })
      .catch(async (error: unknown) => {
        // 잠금을 거치지 않은 길과 부딪혀 DB EXCLUDE 가 막았으면 같은 409
        const overlap = toScheduleConflictFromDb(error);
        if (overlap !== null) throw overlap;
        // 같은 키 두 요청이 동시에 왔다 — 먼저 들어간 쪽 결과로 수렴한다(uq_session_changes_idem)
        if (isUniqueViolation(error, "uq_session_changes_idem")) {
          const raced = await findChangeReplay(db, caller.accountId, key);
          if (raced !== null) return toChangeReplay(raced);
        }
        throw error;
      });
    return Response.json(result, { headers: NO_STORE });
  });

  // ---- §6-2 휴강·폐강 -----------------------------------------------------------------------

  /** 닫을 회차 목록 — 이 회차만, 또는 이 회차부터 같은 수업의 남은 예정 회차 모두(시간순) */
  async function targetSessions(dbx: Db | Tx, row: SessionRow, scope: CancelScope): Promise<{ id: string; starts_at: string; ends_at: string; room_name: string }[]> {
    if (scope === "this_session") return [{ id: row.session_id, starts_at: row.starts_at, ends_at: row.ends_at, room_name: row.room_name }];
    return dbx.query(
      dbx.raw.sql`SELECT s.id::text AS id,
                         to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                         to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                         COALESCE(r.name, '') AS room_name
                  FROM class_sessions s
                  JOIN class_offerings o ON o.id = s.offering_id
                  LEFT JOIN rooms r ON r.id = s.room_id
                  WHERE o.class_id = ${row.class_id}::uuid AND s.status = 'scheduled'
                    AND s.starts_at >= ${row.starts_at}::timestamptz
                  ORDER BY s.starts_at, s.id`
        .returnsRow({ id: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1", room_name: "pg/text@1" })
        .build(),
    );
  }

  /** 행사형(원데이·이벤트·파티·공연·대회)은 이 길이 아니라 대표의 행사 일괄 취소다(409 USE_EVENT_CANCEL) */
  function assertCancellable(row: SessionRow, now: Temporal.Instant): void {
    if (isEventClassKind(row.class_kind as ClassKind)) throw HttpError.conflict("USE_EVENT_CANCEL", DETAIL.eventCancel);
    assertChangeable(row, now);
  }

  const cancelPreview = withRoute<Params>(async (request, context) => {
    const { row } = await load(request, context);
    const body = await parseJsonBody(request, sessionCancelPreviewBodySchema);
    const now = clock();
    assertCancellable(row, now);
    const targets = await targetSessions(db, row, body.scope);
    const amount = perSessionAmount(row.price_amount, row.offering_session_count);
    const out = {
      scope: body.scope,
      sessionCount: targets.length,
      notifyMemberCount: await countMembers(db, targets.map((t) => t.id)),
      // 휴강만 회원이 옮기기·환불을 고른다. 폐강은 옮길 회차가 없어 고를 것이 없다(계약 11 §6-2)
      memberChoice:
        body.scope === "this_session"
          ? { options: [...CLOSURE_CHOICE_OPTIONS], deadlineAt: closureChoiceDeadline(now).toString(), defaultOnExpire: CLOSURE_CHOICE_DEFAULT }
          : null,
      refundHint: {
        perSessionAmountBasis: DETAIL.refundBasis,
        example:
          amount === null || row.price_amount <= 0
            ? null
            : { paid: row.price_amount, sessionTotal: row.offering_session_count, amount },
      },
      settlementNote: DETAIL.settlementNote,
    };
    return Response.json(out, { headers: NO_STORE });
  });

  const cancel = withRoute<Params>(async (request, context) => {
    const { row, caller } = await load(request, context);
    const key = readIdempotencyKey(request, { required: true });
    const body = await parseJsonBody(request, sessionCancelBodySchema);

    const replay = await findCancelReplay(db, caller.accountId, key);
    if (replay !== null) return Response.json(replay, { headers: NO_STORE });

    const now = clock();
    assertCancellable(row, now);
    const nowIso = now.toString();
    const kind = body.scope === "this_session" ? "cancelled" : "closed";
    // 휴강만 회원 선택 기한이 있다(ck_session_changes_deadline). 폐강은 NULL
    const deadline = kind === "cancelled" ? closureChoiceDeadline(now) : null;

    const result = await db
      .transaction(async (tx): Promise<CancelResult> => {
        // 요청한 회차를 잠그고 다시 본다 — 그 사이 변경·휴강이 끼었으면 409
        const fresh = await readSession(tx, row.class_id, row.session_id, true);
        if (fresh === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
        assertCancellable(fresh, now);

        const targets = await targetSessions(tx, fresh, body.scope);
        const targetIds = targets.map((t) => t.id);
        const memberCount = await countMembers(tx, targetIds);
        const [batch] = await tx.query(tx.raw.sql`SELECT uuidv7()::text AS id`.returnsRow({ id: "pg/text@1" }).build());
        if (batch === undefined) throw new Error("묶음 id 를 만들지 못했다");
        const batchId = batch.id;

        // ① 회차마다: 조건부 갱신(예정일 때만) → 변경 기록 → 감사. 키는 요청한 회차의 행에만 둔다
        const changeIds: string[] = [];
        for (const target of targets) {
          const closed = await tx.execute(
            tx.raw.sql`UPDATE class_sessions SET status = ${kind}, cancelled_at = ${nowIso}::timestamptz, cancel_reason = ${body.reason}
                       WHERE id = ${target.id}::uuid AND status = 'scheduled'`
              .affectedCount()
              .build(),
          );
          if (closed.affectedRows === 0) throw HttpError.conflict("SESSION_NOT_SCHEDULED", DETAIL.notScheduled);
          const beforeJson = JSON.stringify({ status: "scheduled", startsAt: target.starts_at, endsAt: target.ends_at });
          const afterJson = JSON.stringify({ status: kind, reason: body.reason });
          const [changeRow] = await tx.query(
            tx.raw.sql`INSERT INTO session_changes (id, class_id, session_id, kind, batch_id, before, after, reason, changed_by_account_id,
                                                    notified_member_count, member_choice_deadline_at, idempotency_key, created_at)
                       VALUES (uuidv7(), ${row.class_id}::uuid, ${target.id}::uuid, ${kind}, ${batchId}::uuid, ${beforeJson}::jsonb,
                               ${afterJson}::jsonb, ${body.reason}, ${caller.accountId}::uuid, ${memberCount},
                               NULLIF(${deadline?.toString() ?? ""}, '')::timestamptz,
                               NULLIF(${target.id === row.session_id ? key : ""}, ''), ${nowIso}::timestamptz)
                       RETURNING id::text AS id`
              .returnsRow({ id: "pg/text@1" })
              .build(),
          );
          if (changeRow === undefined) throw new Error("변경 기록을 쓰지 못했다");
          changeIds.push(changeRow.id);
          await insertAudit(tx, caller, row.academy_id, `session.${kind}`, target.id, beforeJson, afterJson, body.reason);
        }

        // ② 폐강으로 남은 예정 회차가 하나도 없으면 수업도 닫는다(published → cancelled, 승인 기록 closed)
        if (kind === "closed") await closeClassIfEmpty(tx, caller, row);

        // ③ 회원마다 알림 1건 — 여러 회차가 묶여도 한 건(열쇠 batch:<batchId>:<memberId>)
        const firstTarget = targets[0];
        if (firstTarget === undefined) throw new Error("닫을 회차가 없다");
        const firstSlot: SessionSlot = {
          startsAt: Temporal.Instant.from(firstTarget.starts_at),
          endsAt: Temporal.Instant.from(firstTarget.ends_at),
          roomName: firstTarget.room_name,
        };
        const message =
          deadline === null
            ? classClosedMessage(row.class_title, firstSlot, targets.length, body.reason)
            : sessionCancelledMessage(row.class_title, firstSlot, body.reason, deadline);
        const memberPayload = JSON.stringify({
          classId: row.class_id,
          batchId,
          sessionIds: targetIds,
          changeIds,
          reason: body.reason,
          memberChoiceDeadlineAt: deadline?.toString() ?? null,
          ...message,
        });
        await insertMemberNotifications(tx, {
          kind: kind === "cancelled" ? "session_cancelled" : "class_closed",
          academyId: row.academy_id,
          sessionIds: targetIds,
          dedupePrefix: `batch:${batchId}:`,
          payload: memberPayload,
        });

        // ④ 대표 알림(O21B) — 강사가 처리했을 때만
        const firstChangeId = changeIds[0] ?? batchId;
        if (!caller.isOwner) {
          const what = kind === "cancelled" ? "이 회차를 휴강으로" : `남은 ${targets.length}회를 폐강으로`;
          await insertOwnerNotification(tx, row.academy_id, `sessionchange:${firstChangeId}:owner`, {
            classId: row.class_id,
            sessionId: row.session_id,
            batchId,
            changeIds,
            kind,
            title: `${kind === "cancelled" ? "휴강" : "폐강"} · ${row.class_title}`,
            body: `강사가 ${what} 처리했어요 · 수강생 ${memberCount}명에게 알림이 갔어요`,
          });
        }

        return {
          changeIds,
          batchId,
          status: kind,
          notifiedMemberCount: memberCount,
          memberChoiceDeadlineAt: deadline?.toString() ?? null,
        };
      })
      .catch(async (error: unknown) => {
        if (isUniqueViolation(error, "uq_session_changes_idem")) {
          const raced = await findCancelReplay(db, caller.accountId, key);
          if (raced !== null) return raced;
        }
        throw error;
      });
    return Response.json(result, { headers: NO_STORE });
  });

  return { changePreview, change, cancelPreview, cancel };
}

// ---- 쓰기 도우미 ------------------------------------------------------------------------------

/** 담당 강사가 없는 회차의 홀 잠금(수업 등록의 lockScheduleOwners 와 같은 열쇠 모양 room:<id>) */
async function lockRoomOnly(tx: Tx, roomId: string | null): Promise<void> {
  if (roomId === null) return;
  await tx.query(
    tx.raw.sql`SELECT pg_advisory_xact_lock(hashtext(${`room:${roomId}`}))::text AS locked`.returnsRow({ locked: "pg/text@1" }).build(),
  );
}

/** 담당 강사가 없는 회차의 홀 겹침 판정 — 겹치면 409 ROOM_CONFLICT */
async function assertNoRoomConflict(
  tx: Tx,
  input: { academyId: string; roomId: string | null; sessions: { startsAt: Temporal.Instant; endsAt: Temporal.Instant }[]; callerIsOwner: boolean; excludeSessionId: string },
): Promise<void> {
  const slot = input.sessions[0];
  if (input.roomId === null || slot === undefined) return;
  const rows = await readScheduledSessions(tx, {
    instructorAccountId: null,
    roomId: input.roomId,
    from: slot.startsAt.toString(),
    to: slot.endsAt.toString(),
    excludeSessionId: input.excludeSessionId,
  });
  const { roomConflicts } = computeScheduleConflicts({ ...input, instructorAccountId: null }, rows);
  if (roomConflicts.length > 0) {
    throw HttpError.conflict("ROOM_CONFLICT", "같은 홀의 다른 수업과 겹쳐요", {
      conflicts: roomConflicts.map(({ room: _room, ...rest }) => rest),
      suggestions: [],
    });
  }
}

const slotJson = (slot: SessionSlot) => ({ startsAt: slot.startsAt.toString(), endsAt: slot.endsAt.toString(), roomName: slot.roomName });

/**
 * 결제 확정 회원마다 알림 1행. 받는 사람을 고르는 조건은 countMembers 와 같다(셈과 실제 행 수가 어긋나지 않게).
 * 카테고리는 비운다(회원 알림). 발송 상태는 기본값 pending — 보내는 일은 S7-1 몫이다.
 */
async function insertMemberNotifications(
  tx: Tx,
  input: { kind: string; academyId: string; sessionIds: readonly string[]; dedupePrefix: string; payload: string },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
               SELECT uuidv7(), m.member_id, ${input.academyId}::uuid, ${input.kind}, ${input.dedupePrefix} || m.member_id::text, ${input.payload}::jsonb
               FROM (SELECT DISTINCT r.member_id FROM reservations r
                     WHERE r.status = 'confirmed'
                       AND r.offering_id IN (SELECT s.offering_id FROM class_sessions s
                                             WHERE s.id::text = ANY(string_to_array(${input.sessionIds.join(",")}, ',')))) m
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** 그 학원 active 대표에게 instructor_session_changed(운영 칩) 1행 */
async function insertOwnerNotification(tx: Tx, academyId: string, dedupeKey: string, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_staff_account_id, academy_id, category, kind, dedupe_key, payload)
               SELECT uuidv7(), o.staff_account_id, o.academy_id, 'operations', 'instructor_session_changed', ${dedupeKey},
                      ${JSON.stringify(payload)}::jsonb
               FROM academy_owners o
               WHERE o.academy_id = ${academyId}::uuid AND o.status = 'active'
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

async function insertAudit(
  tx: Tx,
  caller: Caller,
  academyId: string,
  action: string,
  sessionId: string,
  beforeJson: string,
  afterJson: string,
  reason: string | null,
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, before, after, reason)
               VALUES (uuidv7(), 'staff', ${caller.accountId}::uuid, ${caller.isOwner ? "owner" : "instructor"}, ${academyId}::uuid,
                       ${action}, 'class_sessions', ${sessionId}::uuid, ${beforeJson}::json, ${afterJson}::json, NULLIF(${reason ?? ""}, ''))`
      .affectedCount()
      .build(),
  );
}

/**
 * 폐강 뒤 그 수업에 예정 회차가 0 이면 published → cancelled + 승인 기록 closed + 감사 class.closed.
 * S2-3.6(소속 해제의 남은 회차 처리)도 폐강한 회차의 수업마다 이 함수를 부른다 — 수업을 닫는 규칙이 한 곳에 있게.
 */
export async function closeClassIfEmpty(tx: Tx, caller: Caller, row: Pick<SessionRow, "class_id" | "academy_id">): Promise<void> {
  const closed = await tx.execute(
    tx.raw.sql`UPDATE classes SET status = 'cancelled', updated_at = now()
               WHERE id = ${row.class_id}::uuid AND status = 'published'
                 AND NOT EXISTS (SELECT 1 FROM class_sessions s JOIN class_offerings o ON o.id = s.offering_id
                                 WHERE o.class_id = ${row.class_id}::uuid AND s.status = 'scheduled')`
      .affectedCount()
      .build(),
  );
  if (closed.affectedRows === 0) return;
  const revisionNo = await currentRevisionNo(tx, row.class_id);
  await tx.execute(
    tx.raw.sql`INSERT INTO class_approvals (id, class_id, action, actor_account_id, revision_no)
               VALUES (uuidv7(), ${row.class_id}::uuid, 'closed', ${caller.accountId}::uuid, ${revisionNo})`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id, after)
               VALUES (uuidv7(), 'staff', ${caller.accountId}::uuid, ${caller.isOwner ? "owner" : "instructor"}, ${row.academy_id}::uuid,
                       'class.closed', 'classes', ${row.class_id}::uuid, ${JSON.stringify({ status: "cancelled" })}::json)`
      .affectedCount()
      .build(),
  );
}

// ---- 같은 키 다시 보내기 ------------------------------------------------------------------------

type ReplayRow = { id: string; session_id: string; kind: string; batch_id: string; notified_member_count: number; deadline: string };

async function findByKey(db: Db | Tx, accountId: string, key: string): Promise<ReplayRow | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT id::text AS id, session_id::text AS session_id, kind, COALESCE(batch_id::text, '') AS batch_id,
                      notified_member_count::int4 AS notified_member_count,
                      COALESCE(to_char(member_choice_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS deadline
               FROM session_changes WHERE changed_by_account_id = ${accountId}::uuid AND idempotency_key = ${key}`
      .returnsRow({
        id: "pg/text@1",
        session_id: "pg/text@1",
        kind: "pg/text@1",
        batch_id: "pg/text@1",
        notified_member_count: "pg/int4@1",
        deadline: "pg/text@1",
      })
      .build(),
  );
  return row ?? null;
}

/** 시간·장소 변경의 처음 결과. 같은 키로 휴강을 보냈던 것이면 409(같은 키를 다른 일에 쓰지 않는다) */
async function findChangeReplay(db: Db | Tx, accountId: string, key: string): Promise<ReplayRow | null> {
  const row = await findByKey(db, accountId, key);
  if (row === null) return null;
  if (row.kind !== "time_place") throw HttpError.conflict("IDEMPOTENCY_KEY_REUSED", DETAIL.keyReused);
  return row;
}

const toChangeReplay = (row: ReplayRow): ChangeResult => ({
  sessionId: row.session_id,
  status: "scheduled",
  changeId: row.id,
  notifiedMemberCount: row.notified_member_count,
});

/** 휴강·폐강의 처음 결과 — 같은 묶음의 변경 기록을 시간순으로 다시 모은다 */
async function findCancelReplay(db: Db | Tx, accountId: string, key: string): Promise<CancelResult | null> {
  const row = await findByKey(db, accountId, key);
  if (row === null) return null;
  if (row.kind !== "cancelled" && row.kind !== "closed") throw HttpError.conflict("IDEMPOTENCY_KEY_REUSED", DETAIL.keyReused);
  const ids = await db.query(
    db.raw.sql`SELECT id::text AS id FROM session_changes WHERE batch_id = ${row.batch_id}::uuid ORDER BY created_at, id`
      .returnsRow({ id: "pg/text@1" })
      .build(),
  );
  return {
    changeIds: ids.map((r) => r.id),
    batchId: row.batch_id,
    status: row.kind,
    notifiedMemberCount: row.notified_member_count,
    memberChoiceDeadlineAt: row.deadline === "" ? null : row.deadline,
  };
}

/** 유니크 위반(23505)이 그 제약 이름 때문인가 — 드라이버가 감싼 cause 를 따라 내려간다 */
function isUniqueViolation(error: unknown, constraintPrefix: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if (e.code === "23505" && text.includes(constraintPrefix)) return true;
    if (text.includes("duplicate key") && text.includes(constraintPrefix)) return true;
    current = e.cause;
  }
  return false;
}
