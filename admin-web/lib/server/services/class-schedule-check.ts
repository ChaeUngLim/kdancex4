// S2-2.8c(수업 일정 겹침 미리보기 API) — `POST /api/classes/schedule-check`(계약 11 §4-1, 보드 I2C · I2).
//   강사가 수업 등록 화면에서 요일·시각을 고를 때마다 부른다. 회차 수와 「이미 있는 일정 · 겹침 · 가까운 빈 시간」을 미리 돌려준다.
//   요구: FR-054 ①②(겹침 세 번 막기 — 입력 중 미리보기 · 저장 전 확인) · FR-057(반복 일정)
//
// **쓰지 않는다.** 회차·판매 단위·기록·감사 어느 것도 만들지 않는다. 마지막 판정은 승인 요청(submit)의 잠금 + DB EXCLUDE 다(S2-2.4).
//
// 다시 쓰는 것(새로 만들지 않는다 — 미리보기와 저장 판정이 어긋나지 않게):
//   회차 계산      planSessions(S2-2.2 반복 일정 생성의 buildRecurringSessions 를 감싼 것)
//   겹침 계산      readScheduledSessions · computeScheduleConflicts(S2-2.4 강사·강의실 충돌 거부 — 저장 때 409 를 내는 그 함수)
//   누가 부르나    createClassAccess 의 readStaff · requireClassWriter(S2-2.3 수업 등록 API 의 class_writer 판정)
//   본문 검사      classScheduleSchema · timeIssues(S2-2.3 임시 저장과 같은 일정 칸 규칙)
//
// 응답의 세 목록(계약 §4-1):
//   existing      고른 요일에 이미 있는 이 강사의 일정 — 수업(다른 학원이면 「다른 학원 일정」) + 개인 일정(제목까지, 본인에게만)
//   conflicts     입력한 시간과 겹치는 이 강사의 수업(무엇과 몇 분). 개인 일정은 넣지 않는다(열린 점 ②)
//   roomConflicts 그 홀의 같은 시간 수업(강사가 누구든)
//   suggestions   겹친 요일의 가까운 빈 시간 칩(추천안, lib/domain/schedule-preview.ts)
// 대표가 담당 강사를 골라 부르면 이름은 모두 「강사 일정」으로만 보인다(FR-052c). 담당 강사를 안 고르면 홀만 본다.
//
// 이 판이 하지 않는 것: 개인 레슨 「레슨 모집」 시간(private_lesson_slots 는 S2-4 가 만든다 — 생기면 existing·conflicts 에 더한다)
import { z } from "zod";

import { classScheduleSchema, planSessions, timeIssues, type PlannedSession } from "../../domain/class-registration";
import { expandPersonalEvent, suggestFreeSlots, weekdayOf, summarizeExisting, type LabeledRange, type PersonalEventRepeat } from "../../domain/schedule-preview";
import { WEEKDAYS, MAX_RECURRING_SESSIONS, type Weekday } from "../../domain/recurring-schedule";
import { kstDateRangeToInstants, parseKstDate, systemClock, toKstDate, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { assertActiveRoom, createClassAccess } from "./class-registration";
import { computeScheduleConflicts, readScheduledSessions, sessionLabelFor } from "./class-schedule-conflicts";
import type { Db } from "../../../prisma/db";

const DETAIL = {
  validation: "입력값을 확인해 주세요",
  sessions: `회차가 1~${MAX_RECURRING_SESSIONS}개가 되게 요일과 기간을 정해 주세요`,
  past: "첫 회차는 지금보다 뒤여야 해요",
  period: "끝나는 날이 시작일보다 앞이에요",
  ownInstructor: "강사는 자기 일정만 볼 수 있어요",
  pickInstructor: "이 학원 소속 강사를 골라 주세요",
} as const;

/** 대표가 대신 볼 때 개인 일정도 무엇인지 밝히지 않는다(11 §4-1) */
const LABEL_INSTRUCTOR = "강사 일정";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 요청·응답 계약(11 §4-1) -----------------------------------------------------------------

/**
 * 요청 본문. 계약 예시의 네 칸(academyId · roomId · excludeClassId · schedule)에 더해, 대표가 담당 강사를 고른 경우를 위해
 * instructorAccountId 를 받는다(§4-1 「대표가 대신 올릴 때(담당 강사를 고른 경우)」 — 임시 저장 본문 §4-2 와 같은 이름).
 */
export const scheduleCheckRequestSchema = z
  .object({
    academyId: z.uuid(),
    roomId: z.uuid().nullish(),
    excludeClassId: z.uuid().nullish(),
    instructorAccountId: z.uuid().nullish(),
    schedule: classScheduleSchema,
  })
  .superRefine((value, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
    // 10분 단위 · 끝 > 시작 — 임시 저장과 같은 규칙(같은 함수)
    for (const message of timeIssues(value.schedule.startTime, value.schedule.endTime)) issue(["schedule", "endTime"], message);
    if (value.schedule.kind === "recurring" && value.schedule.periodFrom > value.schedule.periodTo) {
      issue(["schedule", "periodTo"], DETAIL.period);
    }
  });
export type ScheduleCheckRequest = z.infer<typeof scheduleCheckRequestSchema>;

const conflictOut = z.strictObject({ startsAt: z.string(), endsAt: z.string(), overlapMinutes: z.int().min(1), label: z.string() });

export const scheduleCheckResponseSchema = z.strictObject({
  sessionCount: z.int().min(1),
  firstStartsAt: z.string(),
  lastEndsAt: z.string(),
  existing: z.array(z.strictObject({ weekday: z.enum(WEEKDAYS), startTime: z.string(), endTime: z.string(), label: z.string() })),
  conflicts: z.array(conflictOut),
  roomConflicts: z.array(conflictOut),
  suggestions: z.array(z.strictObject({ weekday: z.enum(WEEKDAYS), startTime: z.string(), endTime: z.string() })),
});
export type ScheduleCheckResponse = z.infer<typeof scheduleCheckResponseSchema>;

// ---- 개인 일정 읽기 ----------------------------------------------------------------------------

const PERSONAL_ROW = {
  title: "pg/text@1",
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  repeat_rule: "pg/text@1",
  repeat_until: "pg/text@1",
} as const;

/**
 * 그 강사의 개인 일정 중 기간에 걸칠 수 있는 행만 읽는다 — 반복 일정은 한 행이라 SQL 로는 「기간 전에 시작했고 아직 안 끝났나」까지만
 * 거르고, 실제 날짜는 expandPersonalEvent 가 펼친다.
 */
async function readPersonalEvents(db: Db, instructorAccountId: string, window: { startsAt: Temporal.Instant; endsAt: Temporal.Instant }) {
  const rows = await db.query(
    db.raw.sql`SELECT title,
                      to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      repeat_rule::text AS repeat_rule, COALESCE(repeat_until::text, '') AS repeat_until
               FROM instructor_personal_events
               WHERE staff_account_id = ${instructorAccountId}::uuid
                 AND starts_at < ${window.endsAt.toString()}::timestamptz
                 AND (repeat_rule <> 'none' OR ends_at > ${window.startsAt.toString()}::timestamptz)
                 AND (repeat_until IS NULL OR repeat_until >= ${toKstDate(window.startsAt).toString()}::date)`
      .returnsRow(PERSONAL_ROW)
      .build(),
  );
  return rows.map((r) => ({
    title: r.title,
    startsAt: Temporal.Instant.from(r.starts_at),
    endsAt: Temporal.Instant.from(r.ends_at),
    repeat: repeatOf(r.repeat_rule),
    repeatUntil: r.repeat_until === "" ? null : Temporal.PlainDate.from(r.repeat_until),
  }));
}

/** DB 의 반복 값 → 정해 둔 세 값. 모르는 값은 반복하지 않는 일정으로 본다(DB enum 이 세 값만 허용한다) */
const repeatOf = (value: string): PersonalEventRepeat => (value === "weekly" || value === "daily" ? value : "none");

// ---- 경로 -----------------------------------------------------------------------------------

export type ClassScheduleCheckDeps = GuardDeps & { clock?: Clock };

export function createClassScheduleCheckRoute(deps: ClassScheduleCheckDeps) {
  const { readStaff, requireClassWriter } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const invalid = (path: string, message: string) =>
    new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path, message }] });

  return withRoute<unknown>(async (request) => {
    // 누가 부르는지 먼저 본다 — 로그인하지 않은 요청이 본문 오류(422)로 경로가 있다는 것부터 알지 않게
    const staff = await readStaff(request);
    const input = await parseBody(request);
    const writer = await requireClassWriter(request, staff, input.academyId);

    // ① 누구의 일정을 보나 — 강사는 늘 자기 자신. 대표는 담당 강사를 골랐으면 그 강사(그 학원 active 소속), 안 골랐으면 홀만 본다
    let instructorId: string | null;
    if (writer.isOwner) {
      instructorId = input.instructorAccountId ?? null;
      if (instructorId !== null) {
        const [aff] = await db.query(
          db.raw.sql`SELECT id FROM instructor_affiliations
                     WHERE academy_id = ${input.academyId}::uuid AND instructor_account_id = ${instructorId}::uuid AND status = 'active'`
            .returnsRow({ id: "pg/uuid@1" })
            .build(),
        );
        if (aff === undefined) throw invalid("instructorAccountId", DETAIL.pickInstructor);
      }
    } else {
      if (input.instructorAccountId != null && input.instructorAccountId !== writer.accountId) {
        throw invalid("instructorAccountId", DETAIL.ownInstructor);
      }
      instructorId = writer.accountId;
    }
    const roomId = input.roomId ?? null;
    if (roomId !== null) await assertActiveRoom(db, input.academyId, roomId, invalid);

    // ② 회차 계산(S2-2.2) — 회차 0개·200개 초과는 422, 첫 회차는 미래여야 한다(승인 요청과 같은 기준)
    let sessions: PlannedSession[];
    try {
      sessions = planSessions(input.schedule);
    } catch {
      throw invalid("schedule", DETAIL.sessions);
    }
    const first = sessions[0];
    const last = sessions[sessions.length - 1];
    if (first === undefined || last === undefined) throw invalid("schedule", DETAIL.sessions);
    if (Temporal.Instant.compare(first.startsAt, clock()) <= 0) throw invalid("schedule", DETAIL.past);

    // ③ 읽을 기간 = 일정이 걸친 KST 날짜 전체. 칩을 앞뒤로 옮겨 봐도 같은 날 안이라 이 기간이면 충분하다
    const window =
      input.schedule.kind === "recurring"
        ? kstDateRangeToInstants(parseKstDate(input.schedule.periodFrom), parseKstDate(input.schedule.periodTo))
        : kstDateRangeToInstants(parseKstDate(input.schedule.date), parseKstDate(input.schedule.date));
    const range = { startsAt: window.start, endsAt: window.endExclusive };
    const rows = await readScheduledSessions(db, {
      instructorAccountId: instructorId,
      roomId,
      from: range.startsAt.toString(),
      to: range.endsAt.toString(),
      exclude: input.excludeClassId == null ? null : { classId: input.excludeClassId, academyId: input.academyId },
    });

    // ④ 겹침 — 저장 때 409 를 내는 그 계산을 그대로 쓴다(S2-2.4)
    const scope = { academyId: input.academyId, instructorAccountId: instructorId, roomId, sessions, callerIsOwner: writer.isOwner };
    const { conflicts, roomConflicts } = computeScheduleConflicts(scope, rows);

    // ⑤ 이미 있는 일정 — 이 강사의 수업 회차 + 개인 일정(본인에게는 제목, 대표에게는 「강사 일정」)
    const classItems: LabeledRange[] = rows
      .filter((r) => instructorId !== null && r.instructor_id === instructorId)
      .map((r) => ({
        startsAt: Temporal.Instant.from(r.starts_at),
        endsAt: Temporal.Instant.from(r.ends_at),
        label: sessionLabelFor(r, input.academyId, writer.isOwner),
      }));
    const personal = instructorId === null ? [] : await readPersonalEvents(db, instructorId, range);
    const personalItems: LabeledRange[] = personal.flatMap((event) =>
      expandPersonalEvent(event, range).map((occurrence) => ({ ...occurrence, label: writer.isOwner ? LABEL_INSTRUCTOR : event.title })),
    );
    const weekdays: Weekday[] =
      input.schedule.kind === "recurring" ? input.schedule.weekdays : [...new Set(sessions.map((s) => weekdayOf(s.startsAt)))];
    const existing = summarizeExisting([...classItems, ...personalItems], weekdays);

    // ⑥ 가까운 빈 시간 — 겹친 회차가 있을 때만. 강사 수업 · 홀 수업 · 개인 일정 모두를 피한다
    const conflicted = sessions.filter((s) =>
      [...conflicts, ...roomConflicts].some(
        (c) =>
          Temporal.Instant.compare(s.startsAt, Temporal.Instant.from(c.endsAt)) < 0 &&
          Temporal.Instant.compare(Temporal.Instant.from(c.startsAt), s.endsAt) < 0,
      ),
    );
    const busy = [
      ...rows
        .filter((r) => (instructorId !== null && r.instructor_id === instructorId) || (roomId !== null && r.room_id === roomId))
        .map((r) => ({ startsAt: Temporal.Instant.from(r.starts_at), endsAt: Temporal.Instant.from(r.ends_at) })),
      ...personalItems,
    ];
    const suggestions = suggestFreeSlots({ sessions, conflicted, busy });

    const body = scheduleCheckResponseSchema.parse({
      sessionCount: sessions.length,
      firstStartsAt: first.startsAt.toString(),
      lastEndsAt: last.endsAt.toString(),
      existing,
      conflicts,
      roomConflicts: roomConflicts.map(({ room: _room, ...rest }) => rest),
      suggestions,
    });
    return Response.json(body, { headers: NO_STORE });
  });
}

// ---- 본문 읽기 -------------------------------------------------------------------------------

/** JSON 이 아니면 400, 칸이 틀리면 422 VALIDATION_FAILED + fields */
async function parseBody(request: Request): Promise<ScheduleCheckRequest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    throw new HttpError("BAD_REQUEST", "요청 본문이 JSON 형식이 아니에요");
  }
  const checked = scheduleCheckRequestSchema.safeParse(raw);
  if (!checked.success) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, {
      fields: checked.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  return checked.data;
}
