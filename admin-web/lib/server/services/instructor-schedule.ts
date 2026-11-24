// S2-4.5(강사 일정 대시보드 API) — `GET /api/instructor/schedule`(계약 11 §11, 보드 I1·I5·I5W·I5D)
//   요구: FR-058(강사 일정 대시보드) · FR-053(개인 일정) · 플랜 S2-4 수용 ③ 「여러 학원 수업이 한 줄 일정으로 나온다」
//   데이터: class_sessions(담당 강사 칸) · seat_pools · private_lesson_slots/bookings/passes · instructor_personal_events
//
// 하는 일: 강사 **본인** 일정을 날짜 범위(KST 달력)로 모아 **시간순 한 목록**으로 돌려준다.
//   학원이 여럿이어도 학원별로 나누지 않는다 — 강사 몸은 하나라서 하루를 한 줄로 봐야 겹침과 빈 시간이 보인다.
//
// 읽는 기준(왜 이렇게 했나):
//   - 수업 회차는 **회차의 담당 강사**(class_sessions.instructor_account_id)로 고른다. 수업을 처음 올린 강사가 아니다.
//     그래서 대타가 확정되거나 대표가 대체 강사를 배정하면 그 회차가 새 강사 일정에 저절로 들어가고 원래 강사에게서 빠진다
//     (계약 §11 · 수용 ⑥ — 따로 캘린더 행을 만들지 않는다). 대타로 맡은 회차는 isSubstitute=true.
//   - 공개(published)·폐강(cancelled) 수업만 보인다. 임시 저장·승인 대기 수업에도 회차 행은 있지만 아직 확정된 일정이 아니다.
//   - 휴강·폐강 회차도 목록에 남기고 status 로 구별한다(강사가 「이 날은 휴강」을 달력에서 봐야 한다).
//   - 소속이 풀린(released) 학원 일정은 지난 것만 남긴다(계약 §11).
//   - 개인 레슨은 잡힌 회차(booked·done·no_show)만. 「레슨 모집」으로 열어 둔 빈 시간은 include=open 일 때만.
//   - 개인 일정의 반복은 한 행이라, 범위 안 실제 시각으로 펼친다(대타 후보 판정과 같은 expandPersonalEvent).
//
// 지금 판의 한계(숨기지 않고 적는다):
//   - 멤버십 판정(403 INSTRUCTOR_MEMBERSHIP_REQUIRED)·수강생 이름 숨김(nameVisible)은 S6-1 전이라 늘 통과·늘 보임이다.
//   - academyId 로 거르면 학원이 붙은 항목(수업·개인 레슨·열어 둔 시간)만 걸러지고, 개인 일정은 학원이 없어 그대로 나온다.
import { z } from "zod";

import { overlapMinutes, type TimeRange } from "../../domain/instructor-schedule-overlap";
import { expandPersonalEvent } from "../../domain/schedule-preview";
import { kstDateRangeToInstants, systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { Db } from "../../../prisma/db";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 한 번에 볼 수 있는 최대 날짜 수 — 계약 §11 「최대 62일(04 의 내 캘린더와 같은 한도)」. 월 보기 두 달이면 충분하다 */
export const SCHEDULE_MAX_DAYS = 62;
/** include 로 고를 수 있는 종류. open(열어 둔 「레슨 모집」 시간)은 기본에서 뺀다(계약 §11) */
export const SCHEDULE_INCLUDES = ["sessions", "private", "personal", "open"] as const;
type ScheduleInclude = (typeof SCHEDULE_INCLUDES)[number];
const DEFAULT_INCLUDE: readonly ScheduleInclude[] = ["sessions", "private", "personal"];
/** 회차를 하나 쓴 것으로 세는 예약 상태 — 「몇 회차째」 번호를 매길 때 쓴다(차감 없음 취소는 번호를 먹지 않는다) */
const COUNTED_BOOKING_STATUSES = "booked,done,no_show,cancelled_member_late";
/** 일정에 보이는 예약 상태 — 취소된 회차는 그 시간이 다시 열리거나 닫혀서 일정에서 빠진다 */
const VISIBLE_BOOKING_STATUSES = "booked,done,no_show";

const DETAIL = {
  forbidden: "강사 계정으로만 일정을 볼 수 있어요",
  range: `날짜 범위를 확인해 주세요(YYYY-MM-DD, 최대 ${SCHEDULE_MAX_DAYS}일)`,
  include: "include 값을 확인해 주세요(sessions·private·personal·open)",
  academy: "academyId 값을 확인해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

// ---- 응답 계약(11 §11) — 테스트가 이 스키마로 응답을 parse 한다 ------------------------------------

const academyRefSchema = z.strictObject({ academyId: z.string(), name: z.string(), colorIndex: z.int().nullable() });
const seatCountsSchema = z.strictObject({ male: z.int().nullable(), female: z.int().nullable(), any: z.int().nullable() });

const classSessionItemSchema = z.strictObject({
  kind: z.literal("class_session"),
  id: z.string(),
  classId: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  academy: academyRefSchema,
  room: z.string().nullable(),
  status: z.enum(["scheduled", "cancelled", "closed"]),
  isSubstitute: z.boolean(),
  // 결제 확정 인원(seat_pools.confirmed_count) — 정원과 같은 모양(남·여·한 칸). 그 칸이 없는 수업이면 null
  paid: seatCountsSchema,
  capacity: seatCountsSchema,
});
const privateLessonItemSchema = z.strictObject({
  kind: z.literal("private_lesson"),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  academy: academyRefSchema,
  student: z.strictObject({ displayName: z.string() }).nullable(),
  sessionNo: z.int().positive(),
  sessionsTotal: z.int().positive(),
  state: z.enum(["booked", "done", "no_show"]),
});
const privateLessonOpenItemSchema = z.strictObject({
  kind: z.literal("private_lesson_open"),
  id: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  academy: academyRefSchema,
});
const personalItemSchema = z.strictObject({
  kind: z.literal("personal"),
  id: z.string(),
  title: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  repeat: z.enum(["none", "weekly", "daily"]),
});

export const instructorScheduleItemSchema = z.discriminatedUnion("kind", [
  classSessionItemSchema,
  privateLessonItemSchema,
  privateLessonOpenItemSchema,
  personalItemSchema,
]);
export type InstructorScheduleEntry = z.infer<typeof instructorScheduleItemSchema>;

const itemRefSchema = z.strictObject({ kind: z.string(), id: z.string() });
export const instructorScheduleSchema = z.strictObject({
  from: z.string(),
  to: z.string(),
  items: z.array(instructorScheduleItemSchema),
  overlaps: z.array(z.strictObject({ a: itemRefSchema, b: itemRefSchema, minutes: z.int().positive() })),
});
export type InstructorSchedule = z.infer<typeof instructorScheduleSchema>;

// ---- 조회 조건 ---------------------------------------------------------------------------------

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

type ScheduleQuery = {
  from: Temporal.PlainDate;
  to: Temporal.PlainDate;
  academyId: string;
  include: ReadonlySet<ScheduleInclude>;
};

/** 날짜 글자 → PlainDate. 모양이 틀리거나 없는 날짜(2월 30일)면 null */
function toDate(text: string | null): Temporal.PlainDate | null {
  if (text === null || !DATE_TEXT.test(text)) return null;
  try {
    return Temporal.PlainDate.from(text, { overflow: "reject" });
  } catch {
    return null;
  }
}

const invalid = (path: string, message: string) => new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path, message }] });

/** 쿼리 글자 → 조회 조건. 틀리면 422 VALIDATION_FAILED */
export function parseScheduleQuery(params: URLSearchParams): ScheduleQuery {
  const from = toDate(params.get("from"));
  const to = toDate(params.get("to"));
  if (from === null || to === null || Temporal.PlainDate.compare(from, to) > 0) throw invalid("from", DETAIL.range);
  // 양 끝 포함 날짜 수 — 10-12 ~ 10-18 은 7일
  const days = from.until(to, { largestUnit: "days" }).days + 1;
  if (days > SCHEDULE_MAX_DAYS) throw invalid("to", DETAIL.range);

  const academyId = params.get("academyId") ?? "";
  if (academyId !== "" && !z.uuid().safeParse(academyId).success) throw invalid("academyId", DETAIL.academy);

  const rawInclude = params.get("include");
  const include = rawInclude === null || rawInclude === "" ? [...DEFAULT_INCLUDE] : rawInclude.split(",").map((s) => s.trim());
  const known = new Set<string>(SCHEDULE_INCLUDES);
  if (include.length === 0 || include.some((value) => !known.has(value))) throw invalid("include", DETAIL.include);

  return { from, to, academyId, include: new Set(include as ScheduleInclude[]) };
}

// ---- DB 읽기 -----------------------------------------------------------------------------------

// 시각은 모두 to_char(… AT TIME ZONE 'UTC') 로 「…Z」 글자를 만들어 읽는다(다른 조회 경로와 같은 모양)
type Window = { start: Temporal.Instant; endExclusive: Temporal.Instant };

/** 학원 표시(이름·색) + 그 학원과의 소속 상태. 소속 행이 여러 번 생겼으면(재신청) 가장 최근 것 */
type AcademyRow = { academy_id: string; academy_name: string; color_index: string; affiliation_status: string };

const toAcademy = (row: AcademyRow) => ({
  academyId: row.academy_id,
  name: row.academy_name,
  colorIndex: row.color_index === "" ? null : Number(row.color_index),
});

/** 공개·폐강 수업의 회차 중 내가 담당인 것 */
async function readClassSessions(db: Db, me: string, window: Window, academyId: string) {
  return db.query(
    db.raw.sql`SELECT s.id::text AS id, c.id::text AS class_id, c.title,
                      to_char(s.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      c.academy_id::text AS academy_id, a.name AS academy_name,
                      COALESCE(aff.calendar_color_index::text, '') AS color_index, COALESCE(aff.status, '') AS affiliation_status,
                      COALESCE(r.name, '') AS room_name, s.status,
                      CASE WHEN c.instructor_account_id IS NOT NULL AND c.instructor_account_id <> s.instructor_account_id
                           THEN 'true' ELSE 'false' END AS is_substitute,
                      COALESCE((SELECT json_object_agg(p.seat_kind, json_build_array(p.capacity, p.confirmed_count))
                                FROM seat_pools p WHERE p.offering_id = o.id)::text, '{}') AS pools
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               JOIN academies a ON a.id = c.academy_id
               LEFT JOIN rooms r ON r.id = s.room_id
               LEFT JOIN LATERAL (
                 SELECT f.calendar_color_index, f.status FROM instructor_affiliations f
                 WHERE f.academy_id = c.academy_id AND f.instructor_account_id = ${me}::uuid
                 ORDER BY f.requested_at DESC LIMIT 1
               ) aff ON TRUE
               WHERE s.instructor_account_id = ${me}::uuid
                 AND c.status IN ('published', 'cancelled')
                 AND s.starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND s.ends_at > ${window.start.toString()}::timestamptz
                 AND (${academyId} = '' OR c.academy_id::text = ${academyId})`
      .returnsRow({
        id: "pg/text@1",
        class_id: "pg/text@1",
        title: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        color_index: "pg/text@1",
        affiliation_status: "pg/text@1",
        room_name: "pg/text@1",
        status: "pg/text@1",
        is_substitute: "pg/text@1",
        pools: "pg/text@1",
      })
      .build(),
  );
}

/** 내가 연 개인 레슨에서 잡힌 회차 + 몇 회차째인지 */
async function readPrivateBookings(db: Db, me: string, window: Window, academyId: string) {
  return db.query(
    db.raw.sql`SELECT b.id::text AS id,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      sl.academy_id::text AS academy_id, a.name AS academy_name,
                      COALESCE(aff.calendar_color_index::text, '') AS color_index, COALESCE(aff.status, '') AS affiliation_status,
                      m.name AS student_name, p.sessions_total::text AS sessions_total, b.status,
                      -- 몇 회차째: 같은 수강권에서 회차를 먹은 예약 중 이 예약보다 앞서거나 같은 것의 수(시작 시각 → id 순)
                      (SELECT count(*) FROM private_lesson_bookings b2 JOIN private_lesson_slots s2 ON s2.id = b2.slot_id
                       WHERE b2.pass_id = b.pass_id
                         AND b2.status = ANY(string_to_array(${COUNTED_BOOKING_STATUSES}, ','))
                         AND (s2.starts_at, b2.id) <= (sl.starts_at, b.id))::text AS session_no
               FROM private_lesson_bookings b
               JOIN private_lesson_slots sl ON sl.id = b.slot_id
               JOIN private_lesson_passes p ON p.id = b.pass_id
               JOIN members m ON m.id = p.member_id
               JOIN academies a ON a.id = sl.academy_id
               LEFT JOIN LATERAL (
                 SELECT f.calendar_color_index, f.status FROM instructor_affiliations f
                 WHERE f.academy_id = sl.academy_id AND f.instructor_account_id = ${me}::uuid
                 ORDER BY f.requested_at DESC LIMIT 1
               ) aff ON TRUE
               WHERE sl.instructor_account_id = ${me}::uuid
                 AND b.status = ANY(string_to_array(${VISIBLE_BOOKING_STATUSES}, ','))
                 AND sl.starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND sl.ends_at > ${window.start.toString()}::timestamptz
                 AND (${academyId} = '' OR sl.academy_id::text = ${academyId})`
      .returnsRow({
        id: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        color_index: "pg/text@1",
        affiliation_status: "pg/text@1",
        student_name: "pg/text@1",
        sessions_total: "pg/text@1",
        status: "pg/text@1",
        session_no: "pg/text@1",
      })
      .build(),
  );
}

/** 열어 둔 「레슨 모집」 시간(open) — include=open 일 때만 */
async function readOpenSlots(db: Db, me: string, window: Window, academyId: string) {
  return db.query(
    db.raw.sql`SELECT sl.id::text AS id,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      sl.academy_id::text AS academy_id, a.name AS academy_name,
                      COALESCE(aff.calendar_color_index::text, '') AS color_index, COALESCE(aff.status, '') AS affiliation_status
               FROM private_lesson_slots sl
               JOIN academies a ON a.id = sl.academy_id
               LEFT JOIN LATERAL (
                 SELECT f.calendar_color_index, f.status FROM instructor_affiliations f
                 WHERE f.academy_id = sl.academy_id AND f.instructor_account_id = ${me}::uuid
                 ORDER BY f.requested_at DESC LIMIT 1
               ) aff ON TRUE
               WHERE sl.instructor_account_id = ${me}::uuid AND sl.status = 'open'
                 AND sl.starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND sl.ends_at > ${window.start.toString()}::timestamptz
                 AND (${academyId} = '' OR sl.academy_id::text = ${academyId})`
      .returnsRow({
        id: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        color_index: "pg/text@1",
        affiliation_status: "pg/text@1",
      })
      .build(),
  );
}

/** 내 개인 일정 중 범위에 걸칠 수 있는 것(반복은 아래에서 펼친다) */
async function readPersonalEvents(db: Db, me: string, window: Window) {
  return db.query(
    db.raw.sql`SELECT id::text AS id, title, repeat_rule::text AS repeat_rule, COALESCE(repeat_until::text, '') AS repeat_until,
                      to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
               FROM instructor_personal_events
               WHERE staff_account_id = ${me}::uuid
                 AND starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND (repeat_rule <> 'none' OR ends_at > ${window.start.toString()}::timestamptz)`
      .returnsRow({
        id: "pg/text@1",
        title: "pg/text@1",
        repeat_rule: "pg/text@1",
        repeat_until: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
      })
      .build(),
  );
}

// ---- 모으기 · 정렬 · 겹침 ----------------------------------------------------------------------------

/** seat_pools 를 {종류: [정원, 확정]} JSON 으로 받아 정원·결제 인원 두 묶음으로 나눈다 */
function splitPools(poolsJson: string) {
  const pools = JSON.parse(poolsJson) as Record<string, [number, number]>;
  const pick = (index: 0 | 1) => ({
    male: pools["male"]?.[index] ?? null,
    female: pools["female"]?.[index] ?? null,
    any: pools["any"]?.[index] ?? null,
  });
  return { capacity: pick(0), paid: pick(1) };
}

const KIND_ORDER: Record<InstructorScheduleEntry["kind"], number> = {
  class_session: 0,
  private_lesson: 1,
  private_lesson_open: 2,
  personal: 3,
};

/**
 * 시간순 한 목록(수용 ③). 학원을 묻지 않고 시작 시각으로만 줄 세운다 —
 * 같은 시각이면 끝 시각 → 종류(수업 → 개인 레슨 → 열어 둔 시간 → 개인 일정) → id 순으로 늘 같은 순서가 나오게 한다.
 */
export function sortScheduleItems(items: readonly InstructorScheduleEntry[]): InstructorScheduleEntry[] {
  return [...items].sort(
    (x, y) =>
      Temporal.Instant.compare(Temporal.Instant.from(x.startsAt), Temporal.Instant.from(y.startsAt)) ||
      Temporal.Instant.compare(Temporal.Instant.from(x.endsAt), Temporal.Instant.from(y.endsAt)) ||
      KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
      x.id.localeCompare(y.id),
  );
}

/**
 * 안내용 겹침(계약 §11 overlaps). 실제로 그 시간을 쓰는 항목끼리만 본다 —
 * 예정(scheduled) 수업 회차 · 잡힌 개인 레슨 · 개인 일정. 휴강 회차와 열어 둔 빈 시간은 자리를 차지하지 않는다.
 * 정렬된 목록을 받아 a 가 늘 먼저 시작하는 쪽이 되게 한다.
 */
export function findScheduleOverlaps(sorted: readonly InstructorScheduleEntry[]): InstructorSchedule["overlaps"] {
  const busy = sorted.filter(
    (item) =>
      (item.kind === "class_session" && item.status === "scheduled") ||
      (item.kind === "private_lesson" && item.state === "booked") ||
      item.kind === "personal",
  );
  const range = (item: InstructorScheduleEntry): TimeRange => ({
    startsAt: Temporal.Instant.from(item.startsAt),
    endsAt: Temporal.Instant.from(item.endsAt),
  });
  return busy.flatMap((a, i) =>
    busy
      .slice(i + 1)
      .map((b) => ({ b, minutes: overlapMinutes(range(a), range(b)) }))
      .filter(({ minutes }) => minutes > 0)
      .map(({ b, minutes }) => ({ a: { kind: a.kind, id: a.id }, b: { kind: b.kind, id: b.id }, minutes })),
  );
}

/** 소속이 풀린 학원의 일정은 지난 것만 남긴다(계약 §11) — 끝 시각이 지금보다 앞이면 지난 것 */
const keepForAffiliation = (status: string, endsAt: string, now: Temporal.Instant) =>
  status !== "released" || Temporal.Instant.compare(Temporal.Instant.from(endsAt), now) <= 0;

/** 강사 본인 일정 한 범위를 모아 응답 모양으로 만든다 */
export async function readInstructorSchedule(
  db: Db,
  me: string,
  query: ScheduleQuery,
  now: Temporal.Instant,
): Promise<InstructorSchedule> {
  const window = kstDateRangeToInstants(query.from, query.to);
  const want = (kind: ScheduleInclude) => query.include.has(kind);
  const items: InstructorScheduleEntry[] = [];

  if (want("sessions")) {
    const rows = await readClassSessions(db, me, window, query.academyId);
    for (const row of rows) {
      if (!keepForAffiliation(row.affiliation_status, row.ends_at, now)) continue;
      const { capacity, paid } = splitPools(row.pools);
      items.push({
        kind: "class_session",
        id: row.id,
        classId: row.class_id,
        title: row.title,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        academy: toAcademy(row),
        room: row.room_name === "" ? null : row.room_name,
        status: row.status as "scheduled" | "cancelled" | "closed",
        isSubstitute: row.is_substitute === "true",
        paid,
        capacity,
      });
    }
  }

  if (want("private")) {
    const rows = await readPrivateBookings(db, me, window, query.academyId);
    for (const row of rows) {
      if (!keepForAffiliation(row.affiliation_status, row.ends_at, now)) continue;
      items.push({
        kind: "private_lesson",
        id: row.id,
        title: "개인 레슨",
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        academy: toAcademy(row),
        // 수강생 이름은 결제 대기여도 보인다(§10-3). 멤버십이 끝나면 null — 판정 함수는 S6-1 이 준다(그 전에는 늘 보임)
        student: { displayName: row.student_name },
        sessionNo: Number(row.session_no),
        sessionsTotal: Number(row.sessions_total),
        state: row.status as "booked" | "done" | "no_show",
      });
    }
  }

  if (want("open")) {
    const rows = await readOpenSlots(db, me, window, query.academyId);
    for (const row of rows) {
      if (!keepForAffiliation(row.affiliation_status, row.ends_at, now)) continue;
      items.push({ kind: "private_lesson_open", id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, academy: toAcademy(row) });
    }
  }

  if (want("personal")) {
    const rows = await readPersonalEvents(db, me, window);
    const span = { startsAt: window.start, endsAt: window.endExclusive };
    for (const row of rows) {
      const repeat = row.repeat_rule === "weekly" || row.repeat_rule === "daily" ? row.repeat_rule : "none";
      // 반복 일정 한 행 → 범위 안의 실제 시각들. 같은 일정에서 나온 것은 id 가 같다(지우기는 시리즈 전체라 그걸로 충분)
      const occurrences = expandPersonalEvent(
        {
          title: row.title,
          startsAt: Temporal.Instant.from(row.starts_at),
          endsAt: Temporal.Instant.from(row.ends_at),
          repeat,
          repeatUntil: row.repeat_until === "" ? null : Temporal.PlainDate.from(row.repeat_until),
        },
        span,
      );
      for (const at of occurrences) {
        items.push({ kind: "personal", id: row.id, title: row.title, startsAt: at.startsAt.toString(), endsAt: at.endsAt.toString(), repeat });
      }
    }
  }

  const sorted = sortScheduleItems(items);
  return instructorScheduleSchema.parse({
    from: query.from.toString(),
    to: query.to.toString(),
    items: sorted,
    overlaps: findScheduleOverlaps(sorted),
  });
}

// ---- 경로 ----------------------------------------------------------------------------------------

export type InstructorScheduleDeps = GuardDeps & { clock?: Clock };

export function createInstructorScheduleRoutes(deps: InstructorScheduleDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** GET — 강사 본인 일정. 다른 강사 id 를 받는 칸이 아예 없다(본인 것만 — 세션의 계정으로만 읽는다) */
  const get = withRoute<unknown>(async (request) => {
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const query = parseScheduleQuery(new URL(request.url).searchParams);
    const body = await readInstructorSchedule(db, staff.staffAccountId, query, clock());
    return Response.json(body, { headers: NO_STORE });
  });

  return { get };
}
