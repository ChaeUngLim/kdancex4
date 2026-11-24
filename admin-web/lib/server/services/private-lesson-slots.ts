// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — 강사가 상품에 「레슨 모집」 시간을 열고 닫는다(보드 I10C).
//   계약: _workspace/03_contracts/11-instructor.md §0(affiliated) · §10-2(열 시간)
//   경로: POST   /api/instructor/private-lesson-products/{classId}/slots   (헤더 Idempotency-Key 필수)
//         DELETE /api/instructor/private-lesson-slots/{slotId}
//   데이터: data-model §8-6 private_lesson_slots(ex_pl_slots_instructor · ex_pl_slots_room)
//   요구: FR-052c(학원에서 여는 개인 레슨 — 수업·다른 학원 일정과 겹치는 시간은 열 수 없다) · FR-054(강사 일정 충돌 거부)
//
// 열 시간의 핵심 규칙 세 가지:
//   ① 모양 — 시작·끝은 10분 단위, 길이는 상품의 레슨 길이(50·80분)와 같다. 지난 시각은 열 수 없다. 어긋나면 422
//   ② 겹침 — 같은 강사의 수업 회차(학원을 묻지 않는다)·다른 「레슨 모집」 시간, 그리고 홀을 고르면 그 홀의 수업·시간과
//      하나라도 겹치면 **전체 거부**(409 SCHEDULE_CONFLICT · ROOM_CONFLICT + 겹친 시각 목록). 부분 성공은 없다
//   ③ 잠금 — 수업 승인(S2-2.4)과 같은 강사·홀 트랜잭션 잠금(lockScheduleOwners) 안에서 ② 를 본다.
//      잠금을 거치지 않는 길이 생겨도 DB 의 EXCLUDE 제약 두 개가 마지막으로 막고, 그 위반도 같은 409 로 바꾼다
//
// 매주 반복(repeatWeeks, 1~26 · 기본 8 — 열린 점 ⑰ 추천값)은 보낸 시간마다 7일씩 더해 만든다. 한국은 서머타임이 없어
// UTC 로 7일을 더해도 KST 요일·시각이 그대로다. 반복으로 만든 묶음에는 repeat_group_id 하나를 붙인다.
//
// 닫힌 상품(close, S2-4.10)에는 새 시간을 열 수 없다 — 「새 구매 막기」와 같은 판정 assertPrivateLessonProductOpen 을 쓴다.
// 시간 닫기(DELETE)는 open 인 시간만 closed 로 바꾼다. 결제 대기(held)·예약됨(booked)은 회원이 잡은 시간이라 409 SLOT_NOT_OPEN.
import { z } from "zod";

import { overlapMinutes, type TimeRange } from "../../domain/instructor-schedule-overlap";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import {
  computeScheduleConflicts,
  lockScheduleOwners,
  readScheduledSessions,
  scheduleConflictError,
  type ScheduleConflict,
} from "./class-schedule-conflicts";
import { createClassAccess } from "./class-registration";
import { assertPrivateLessonProductOpen, findMyProduct, UUID_PATTERN } from "./private-lesson-products";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 매주 반복 주 수 — 기본 8 · 상한 26(계약 11 §10-2 · 열린 점 ⑰ 추천값) */
export const PRIVATE_LESSON_REPEAT_WEEKS_DEFAULT = 8;
export const PRIVATE_LESSON_REPEAT_WEEKS_MAX = 26;
/** 한 요청에 보낼 수 있는 시간 수(요일별 한 줄씩이면 넉넉하다 — **추천값**). 반복까지 곱하면 최대 14 × 26 = 364행 */
const SLOTS_PER_REQUEST_MAX = 14;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const WEEK = { days: 7 } as const;

const DETAIL = {
  forbidden: "강사 계정으로만 「레슨 모집」 시간을 열 수 있어요",
  affiliation: "소속된 학원의 개인 레슨만 다룰 수 있어요",
  productNotFound: "개인 레슨 상품을 찾을 수 없어요",
  slotNotFound: "「레슨 모집」 시간을 찾을 수 없어요",
  slotNotOpen: "회원이 잡았거나 결제 중인 시간은 닫을 수 없어요",
  validation: "입력값을 확인해 주세요",
  tenMinutes: "시작·끝 시각은 10분 단위로 골라 주세요",
  length: "레슨 길이와 같은 시간으로 열어 주세요",
  past: "이미 지난 시각은 열 수 없어요",
  selfOverlap: "보낸 시간끼리 겹쳐요",
  room: "이 학원의 홀이 아니에요",
} as const;

/** 겹친 상대의 이름 — 같은 학원의 내 개인 레슨은 「개인 레슨」, 다른 학원은 이름을 밝히지 않는다(FR-054 ①), 남의 개인 레슨은 「강사 일정」 */
const LABEL_MY_LESSON = "개인 레슨";
const LABEL_OTHER_ACADEMY = "다른 학원 일정";
const LABEL_OTHERS_LESSON = "강사 일정";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const UTC_TEXT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

// ---- 요청·응답 계약(11 §10-2) -----------------------------------------------------------------

const instantText = z.iso.datetime({ offset: true });

export const openSlotsRequestSchema = z.strictObject({
  slots: z
    .array(z.strictObject({ startsAt: instantText, endsAt: instantText }))
    .min(1)
    .max(SLOTS_PER_REQUEST_MAX),
  roomId: z.uuid().nullish(),
  repeatWeeks: z.int().min(1).max(PRIVATE_LESSON_REPEAT_WEEKS_MAX).default(PRIVATE_LESSON_REPEAT_WEEKS_DEFAULT),
});
export type OpenSlotsRequest = z.infer<typeof openSlotsRequestSchema>;

const createdSlotSchema = z.strictObject({ slotId: z.uuid(), startsAt: z.string(), endsAt: z.string(), status: z.literal("open") });
export const openSlotsResponseSchema = z.strictObject({
  created: z.array(createdSlotSchema),
  // 반복이 없으면(repeatWeeks = 1) 묶음도 없다
  repeatGroupId: z.uuid().nullable(),
});
export type OpenSlotsResponse = z.infer<typeof openSlotsResponseSchema>;

export type PrivateLessonSlotDeps = GuardDeps & { clock?: Clock };
type ProductParams = { params: Promise<{ classId: string }> };
type SlotParams = { params: Promise<{ slotId: string }> };

// ---- 순수 판정 --------------------------------------------------------------------------------

/**
 * 보낸 시간들을 매주 반복으로 펼치고 모양을 검사한다(던지지 않는다).
 * 문제가 있으면 그 칸의 경로와 문장을, 없으면 시작 시각 순으로 정렬한 후보 목록을 돌려준다.
 */
export function expandPrivateLessonSlots(
  input: { slots: readonly { startsAt: string; endsAt: string }[]; repeatWeeks: number },
  lessonMinutes: number,
  now: Temporal.Instant,
): { ok: true; candidates: TimeRange[] } | { ok: false; path: string; message: string } {
  const candidates: TimeRange[] = [];
  for (const [index, slot] of input.slots.entries()) {
    const startsAt = Temporal.Instant.from(slot.startsAt);
    const endsAt = Temporal.Instant.from(slot.endsAt);
    const path = `slots.${index}`;
    if (startsAt.epochMilliseconds % TEN_MINUTES_MS !== 0 || endsAt.epochMilliseconds % TEN_MINUTES_MS !== 0) {
      return { ok: false, path, message: DETAIL.tenMinutes };
    }
    // 길이 = 상품의 레슨 길이(50·80분). 끝이 시작보다 앞서는 경우도 여기서 걸린다
    if (endsAt.epochMilliseconds - startsAt.epochMilliseconds !== lessonMinutes * 60 * 1000) {
      return { ok: false, path, message: DETAIL.length };
    }
    if (Temporal.Instant.compare(startsAt, now) <= 0) return { ok: false, path, message: DETAIL.past };
    for (let week = 0; week < input.repeatWeeks; week += 1) {
      // Instant 에는 「일」 단위가 없어 시간으로 더한다(7일 = 168시간 — 한국은 서머타임이 없어 KST 시각이 그대로다)
      const shift = { hours: WEEK.days * 24 * week };
      candidates.push({ startsAt: startsAt.add(shift), endsAt: endsAt.add(shift) });
    }
  }
  candidates.sort((a, b) => Temporal.Instant.compare(a.startsAt, b.startsAt));
  // 보낸 시간끼리(반복 포함) 겹치면 내 요청 안의 실수다 — DB 에 가기 전에 422 로 알린다
  for (let i = 1; i < candidates.length; i += 1) {
    if (overlapMinutes(candidates[i - 1]!, candidates[i]!) > 0) return { ok: false, path: "slots", message: DETAIL.selfOverlap };
  }
  return { ok: true, candidates };
}

// ---- DB 읽기 ----------------------------------------------------------------------------------

type BusySlotRow = { starts_at: string; ends_at: string; academy_id: string; instructor_id: string; room_id: string };

/** 그 강사 또는 그 홀이 이미 점유한 「레슨 모집」 시간(open·held·booked — EXCLUDE 와 같은 기준) 중 [from, to) 에 걸친 것 */
async function readBusySlots(tx: Tx, instructorId: string, roomId: string | null, from: string, to: string): Promise<BusySlotRow[]> {
  return tx.query(
    tx.raw.sql`SELECT to_char(starts_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS ends_at,
                      academy_id, instructor_account_id::text AS instructor_id, COALESCE(room_id::text, '') AS room_id
               FROM private_lesson_slots
               WHERE status IN ('open', 'held', 'booked')
                 AND (instructor_account_id = ${instructorId}::uuid OR room_id = NULLIF(${roomId ?? ""}, '')::uuid)
                 AND tstzrange(starts_at, ends_at) && tstzrange(${from}::timestamptz, ${to}::timestamptz)
               ORDER BY starts_at`
      .returnsRow({ starts_at: "pg/text@1", ends_at: "pg/text@1", academy_id: "pg/uuid@1", instructor_id: "pg/text@1", room_id: "pg/text@1" })
      .build(),
  );
}

/** 후보들과 이미 있는 시간들의 겹침 한 줄씩(후보 기준, 시간순) */
function slotOverlaps(candidates: readonly TimeRange[], rows: readonly BusySlotRow[], label: (row: BusySlotRow) => string): ScheduleConflict[] {
  return candidates.flatMap((candidate) =>
    rows
      .map((row) => ({
        row,
        minutes: overlapMinutes(candidate, { startsAt: Temporal.Instant.from(row.starts_at), endsAt: Temporal.Instant.from(row.ends_at) }),
      }))
      .filter(({ minutes }) => minutes > 0)
      .map(({ row, minutes }) => ({ startsAt: row.starts_at, endsAt: row.ends_at, overlapMinutes: minutes, label: label(row) })),
  );
}

/**
 * 겹침 판정 — 수업 회차(S2-2.4 의 읽기·계산을 그대로 빌린다)와 「레슨 모집」 시간을 함께 본다. 있으면 409 를 던진다.
 * 강사 겹침(SCHEDULE_CONFLICT)이 먼저, 그다음 홀 겹침(ROOM_CONFLICT) — 수업 등록과 같은 순서다.
 */
async function assertSlotsFree(
  tx: Tx,
  input: { academyId: string; instructorId: string; roomId: string | null; candidates: readonly TimeRange[] },
): Promise<void> {
  const first = input.candidates[0];
  const last = input.candidates[input.candidates.length - 1];
  if (first === undefined || last === undefined) return;
  const from = first.startsAt.toString();
  const to = last.endsAt.toString();

  const sessions = await readScheduledSessions(tx, { instructorAccountId: input.instructorId, roomId: input.roomId, from, to });
  const classSide = computeScheduleConflicts(
    { academyId: input.academyId, instructorAccountId: input.instructorId, roomId: input.roomId, sessions: input.candidates, callerIsOwner: false },
    sessions,
  );
  const busy = await readBusySlots(tx, input.instructorId, input.roomId, from, to);
  const mine = busy.filter((row) => row.instructor_id === input.instructorId);
  const roomOnly = busy.filter((row) => row.instructor_id !== input.instructorId && row.room_id !== "" && row.room_id === input.roomId);

  const byTime = (a: ScheduleConflict, b: ScheduleConflict) => a.startsAt.localeCompare(b.startsAt);
  const instructorConflicts = [
    ...classSide.conflicts,
    ...slotOverlaps(input.candidates, mine, (row) => (row.academy_id === input.academyId ? LABEL_MY_LESSON : LABEL_OTHER_ACADEMY)),
  ].sort(byTime);
  if (instructorConflicts.length > 0) throw scheduleConflictError("SCHEDULE_CONFLICT", instructorConflicts, "");

  const roomName = classSide.roomConflicts[0]?.room ?? "";
  const roomConflicts = [
    ...classSide.roomConflicts.map(({ room: _room, ...rest }) => rest),
    ...slotOverlaps(input.candidates, roomOnly, () => LABEL_OTHERS_LESSON),
  ].sort(byTime);
  if (roomConflicts.length > 0) throw scheduleConflictError("ROOM_CONFLICT", roomConflicts, roomName);
}

/** EXCLUDE 위반(23P01) → 같은 409. 무엇과 겹쳤는지는 모르므로 conflicts 는 빈 배열. 아니면 null */
function toSlotConflictFromDb(error: unknown): HttpError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if (text.includes("ex_pl_slots_room")) return scheduleConflictError("ROOM_CONFLICT", [], "");
    if (text.includes("ex_pl_slots_instructor")) return scheduleConflictError("SCHEDULE_CONFLICT", [], "");
    current = e.cause;
  }
  return null;
}

/** 같은 요청의 재전송인가 — 후보 시간이 전부 이 상품의 open 시간으로 이미 있으면 그 행들을 돌려준다. 아니면 null */
async function findReplay(db: Db, classId: string, candidates: readonly TimeRange[]): Promise<OpenSlotsResponse | null> {
  const starts = candidates.map((c) => c.startsAt.toString()).join(",");
  const rows = await db.query(
    db.raw.sql`SELECT id, to_char(starts_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', ${UTC_TEXT}) AS ends_at, COALESCE(repeat_group_id::text, '') AS repeat_group_id
               FROM private_lesson_slots
               WHERE product_class_id = ${classId}::uuid AND status = 'open'
                 AND starts_at = ANY(string_to_array(${starts}, ',')::timestamptz[])
               ORDER BY starts_at`
      .returnsRow({ id: "pg/uuid@1", starts_at: "pg/text@1", ends_at: "pg/text@1", repeat_group_id: "pg/text@1" })
      .build(),
  );
  const matches = candidates.every((c) => rows.some((r) => r.starts_at === c.startsAt.toString() && r.ends_at === c.endsAt.toString()));
  if (rows.length !== candidates.length || !matches) return null;
  const group = rows[0]?.repeat_group_id ?? "";
  return {
    created: rows.map((r) => ({ slotId: r.id, startsAt: r.starts_at, endsAt: r.ends_at, status: "open" as const })),
    repeatGroupId: group === "" ? null : group,
  };
}

// ---- 경로 ----------------------------------------------------------------------------------------

export function createPrivateLessonSlotRoutes(deps: PrivateLessonSlotDeps) {
  // 「누가 부르나」는 개인 레슨 개설(S2-4.2)과 같은 판정(관리자 웹 쿠키면 2단계 인증)
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  async function requireInstructor(request: Request): Promise<string> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  }

  async function assertAffiliated(academyId: string, instructorId: string): Promise<void> {
    const [row] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
  }

  /** 홀은 그 상품을 판 학원의 것이어야 한다(다른 학원 홀에 시간을 걸지 못하게) */
  async function assertRoomOfAcademy(roomId: string, academyId: string): Promise<void> {
    const [row] = await db.query(
      db.raw.sql`SELECT r.id FROM rooms r JOIN academy_branches b ON b.id = r.branch_id
                 WHERE r.id = ${roomId}::uuid AND b.academy_id = ${academyId}::uuid`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "roomId", message: DETAIL.room }] });
  }

  /** POST — 「레슨 모집」 시간 열기. 201 + 만든 시간들(같은 요청의 재전송은 200 + 처음 것) */
  const open = withRoute<ProductParams>(async (request, context) => {
    const instructorId = await requireInstructor(request);
    readIdempotencyKey(request, { required: true });
    const { classId } = await context.params;
    if (!UUID_PATTERN.test(classId)) throw new HttpError("NOT_FOUND", DETAIL.productNotFound);
    // 남의 상품이면 404 — 있는지조차 알려 주지 않는다
    const product = await findMyProduct(db, classId, instructorId);
    if (product === null) throw new HttpError("NOT_FOUND", DETAIL.productNotFound);
    await assertAffiliated(product.academyId, instructorId);

    const input = await parseJsonBody(request, openSlotsRequestSchema);
    const roomId = input.roomId ?? null;
    if (roomId !== null) await assertRoomOfAcademy(roomId, product.academyId);
    const expanded = expandPrivateLessonSlots(input, product.lessonMinutes, clock());
    if (!expanded.ok) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: expanded.path, message: expanded.message }] });
    const { candidates } = expanded;

    // 예약 시간 표에 키 칸이 없어(data-model §8-6) 「같은 시간이 이 상품에 이미 열려 있다」가 재전송의 근거다(S2-4.7 과 같은 방식)
    const replay = await findReplay(db, classId, candidates);
    if (replay !== null) return Response.json(openSlotsResponseSchema.parse(replay), { status: 200, headers: NO_STORE });

    try {
      const body = await db.transaction(async (tx): Promise<OpenSlotsResponse> => {
        // 닫힌 상품에는 새 시간을 열지 않는다 — 「새 구매 막기」와 같은 판정(409 PRODUCT_CLOSED)
        await assertPrivateLessonProductOpen(tx, classId);
        // 같은 강사·같은 홀 잠금 → 겹침 판정 → 쓰기. 수업 승인(S2-2.4)과 같은 잠금 이름이라 두 경로가 서로를 기다린다
        await lockScheduleOwners(tx, instructorId, roomId);
        await assertSlotsFree(tx, { academyId: product.academyId, instructorId, roomId, candidates });

        const repeatGroupId = input.repeatWeeks > 1 ? crypto.randomUUID() : null;
        const created: OpenSlotsResponse["created"] = [];
        for (const candidate of candidates) {
          const [row] = await tx.query(
            tx.raw.sql`INSERT INTO private_lesson_slots (id, product_class_id, academy_id, instructor_account_id, room_id,
                                                         starts_at, ends_at, status, repeat_group_id)
                       VALUES (uuidv7(), ${classId}::uuid, ${product.academyId}::uuid, ${instructorId}::uuid,
                               NULLIF(${roomId ?? ""}, '')::uuid, ${candidate.startsAt.toString()}::timestamptz,
                               ${candidate.endsAt.toString()}::timestamptz, 'open', NULLIF(${repeatGroupId ?? ""}, '')::uuid)
                       RETURNING id`
              .returnsRow({ id: "pg/uuid@1" })
              .build(),
          );
          if (row === undefined) throw new Error("「레슨 모집」 시간을 쓰지 못했다");
          created.push({ slotId: row.id, startsAt: candidate.startsAt.toString(), endsAt: candidate.endsAt.toString(), status: "open" });
        }
        return { created, repeatGroupId };
      });
      return Response.json(openSlotsResponseSchema.parse(body), { status: 201, headers: NO_STORE });
    } catch (error) {
      // 잠금을 거치지 않은 쓰기와 부딪혀 EXCLUDE 에 걸렸다 — 트랜잭션은 이미 되돌려졌고, 같은 409 로 답한다
      const conflict = toSlotConflictFromDb(error);
      if (conflict !== null) throw conflict;
      throw error;
    }
  });

  /** DELETE — 열어 둔 시간 닫기(open → closed), 204. 이미 닫혔으면 204(재전송). held·booked 는 409 SLOT_NOT_OPEN */
  const remove = withRoute<SlotParams>(async (request, context) => {
    const instructorId = await requireInstructor(request);
    const { slotId } = await context.params;
    if (!UUID_PATTERN.test(slotId)) throw new HttpError("NOT_FOUND", DETAIL.slotNotFound);
    const [slot] = await db.query(
      db.raw.sql`SELECT academy_id FROM private_lesson_slots WHERE id = ${slotId}::uuid AND instructor_account_id = ${instructorId}::uuid`
        .returnsRow({ academy_id: "pg/uuid@1" })
        .build(),
    );
    if (slot === undefined) throw new HttpError("NOT_FOUND", DETAIL.slotNotFound);
    await assertAffiliated(slot.academy_id, instructorId);

    // 조건부 갱신 — open 일 때만 닫는다. 같은 순간 회원이 그 시간을 잡았다면(held·booked) 한 줄도 안 바뀐다
    const changed = await db.execute(
      db.raw.sql`UPDATE private_lesson_slots SET status = 'closed' WHERE id = ${slotId}::uuid AND status = 'open'`.affectedCount().build(),
    );
    if (changed.affectedRows !== 1) {
      const [now] = await db.query(
        db.raw.sql`SELECT status FROM private_lesson_slots WHERE id = ${slotId}::uuid`.returnsRow({ status: "pg/text@1" }).build(),
      );
      if (now?.status !== "closed") throw HttpError.conflict("SLOT_NOT_OPEN", DETAIL.slotNotOpen);
    }
    return new Response(null, { status: 204, headers: NO_STORE });
  });

  return { open, remove };
}
