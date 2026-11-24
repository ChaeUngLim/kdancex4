// S3-5.9(앱 강사 명단 화면) — `GET /api/instructor/headcount?date=YYYY-MM-DD&academyId=`(계약 18 §7 강사 경로).
//   요구: FR-092e(결석 예정 미리 알리기) · FR-106(현장 등록 반영) · FR-064(강사 대시보드 집계) 일부 · Q20(1:1 개인 레슨은 결제 대기여도 이름)
//   보드: I1(강사 홈 「오늘 수업 인원」) · I7(수업 인원 한눈에)
//
// 왜 이 Task 가 만드나: 계약 18 §7 제목에는 S3-5.5 가 붙어 있지만 S3-5.5 는 순수 함수만 만들었고(증거 S3-5.5 「범위 밖」),
//   로드맵에 이 경로를 맡은 Task 가 없었다. I1·I7 화면이 이 응답을 그려야 해서 화면 Task 인 여기서 강사 경로 하나만 만든다.
//   대표 경로 `GET /api/academies/{academyId}/headcount`(O6·O40)는 대표 앱 화면 Task(S3-5.9c) 몫으로 남긴다.
//
// 하루 인원표 한눈에:
//   ① 강사 본인만(세션 계정). 학원을 고르면(academyId) 그 학원이 지금 내 active 소속이어야 한다 — 아니면 403.
//   ② 읽기 전에 내 수업의 기한 지난 결제 대기를 닫는다(강사 집계와 같은 정리) — 「확정」 숫자가 만료된 사람을 세지 않게.
//   ③ 수업 줄 = 그날(KST) 내 회차(회차 담당, 비었으면 수업 담당). 공개 수업 · 예정(scheduled) 회차만 —
//      휴강·폐강 회차는 빼고 요약에도 세지 않는다(계약 §7). 지금 active 소속 학원의 회차만.
//   ④ 자리마다 오늘 인원 = 확정 − 결석 예정 + 현장(computePresent 하나 — 명단·대표 타일과 같은 식).
//      결석 예정은 결제 완료 수강생의 살아 있는 결석 행만 센다(명단 session-roster.ts 와 같은 조건).
//   ⑤ 개인 레슨 줄 = 그날 잡힌(booked) 1:1 회차. 결제 대기 수강권이어도 닉네임을 보인다(Q20 2026-11-19) — awaitingPayment 로 구별.
//   ⑥ 응답에는 닉네임·성별만. 본명·연락처·결제 수단은 읽지도 않는다.
import { z } from "zod";

import { GENDERS, SEAT_KINDS, SEAT_MODES, type Gender, type SeatKind, type SeatMode } from "../../domain/constants";
import { computePresent } from "../../domain/headcount";
import { kstDateRangeToInstants, kstToday, systemClock, type Clock } from "../../domain/time";
import { createGuards } from "../guards";
import { HttpError, withRoute } from "../http";
import type { Db } from "../../../prisma/db";
import { expireMyDuePayments, isActiveAffiliation, type InstructorDashboardDeps } from "./instructor-dashboard";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

const DETAIL = {
  forbidden: "강사 계정으로만 오늘 인원을 볼 수 있어요",
  academyForbidden: "지금 소속된 학원만 고를 수 있어요",
  date: "date 값을 확인해 주세요(YYYY-MM-DD)",
  academy: "academyId 값을 확인해 주세요",
  unknown: "알 수 없는 쿼리 이름이에요",
} as const;

// ---- 응답 계약(18 §7) — strict: 모르는 키(본명·연락처)가 섞이면 parse 가 실패한다 ---------------------

const count = z.number().int().nonnegative();
const isoInstant = z.iso.datetime({ offset: true });
const academyRef = z.strictObject({ id: z.uuid(), name: z.string() });
const genderCounts = z.strictObject({ male: count, female: count });

const classItemSchema = z.strictObject({
  kind: z.literal("class"),
  classId: z.uuid(),
  sessionId: z.uuid(),
  startsAt: isoInstant,
  endsAt: isoInstant,
  title: z.string(),
  academy: academyRef,
  roomName: z.string().nullable(),
  instructor: z.strictObject({ displayName: z.string() }).nullable(),
  seatMode: z.enum(SEAT_MODES),
  seats: z.array(
    z.strictObject({
      seatKind: z.enum(SEAT_KINDS),
      capacity: count,
      confirmed: count,
      absencePlanned: count,
      onsite: count,
      present: count,
      remaining: count,
    }),
  ),
  // 자리 종류별 결석 예정 수 — 그 수업에 있는 자리 종류만 키가 있다(남녀 정원이면 male·female, 단일이면 any)
  absence: z.strictObject({ male: count.optional(), female: count.optional(), any: count.optional() }),
});

const privateLessonItemSchema = z.strictObject({
  kind: z.literal("private_lesson"),
  bookingId: z.uuid(),
  startsAt: isoInstant,
  endsAt: isoInstant,
  title: z.string(),
  academy: academyRef,
  roomName: z.string().nullable(),
  student: z.strictObject({ nickname: z.string(), gender: z.enum(GENDERS), awaitingPayment: z.boolean() }),
  present: genderCounts,
  absencePlanned: count,
});

export const instructorHeadcountSchema = z.strictObject({
  date: z.iso.date(),
  summary: z.strictObject({
    classCount: count,
    privateLessonCount: count,
    present: z.strictObject({ male: count, female: count, total: count }),
    absencePlanned: count,
  }),
  items: z.array(z.discriminatedUnion("kind", [privateLessonItemSchema, classItemSchema])),
});
export type InstructorHeadcount = z.infer<typeof instructorHeadcountSchema>;
type HeadcountItem = InstructorHeadcount["items"][number];

// ---- 순수 계산(DB 없이 시험한다) ------------------------------------------------------------------

/**
 * 요약줄(I7 「수업 2 · 개인 레슨 1 · 참석 21 (남 9 · 여 12) · 결석 예정 1」).
 * 남·여는 줄들의 present 합이다(계약 §7). 단일 정원 수업의 인원은 성별을 몰라 total 에만 더한다.
 */
export function summarizeHeadcount(items: readonly HeadcountItem[]): InstructorHeadcount["summary"] {
  let male = 0;
  let female = 0;
  let other = 0;
  let absencePlanned = 0;
  for (const item of items) {
    if (item.kind === "private_lesson") {
      male += item.present.male;
      female += item.present.female;
      absencePlanned += item.absencePlanned;
      continue;
    }
    for (const seat of item.seats) {
      if (seat.seatKind === "male") male += seat.present;
      else if (seat.seatKind === "female") female += seat.present;
      else other += seat.present;
      absencePlanned += seat.absencePlanned;
    }
  }
  return {
    classCount: items.filter((item) => item.kind === "class").length,
    privateLessonCount: items.filter((item) => item.kind === "private_lesson").length,
    present: { male, female, total: male + female + other },
    absencePlanned,
  };
}

// ---- 쿼리 -------------------------------------------------------------------------------------

type HeadcountQuery = { date: Temporal.PlainDate; academyId: string };

/**
 * 누구의 하루 인원표인가 — 강사 경로와 대표 경로(S3-5.9c)가 같은 SQL 을 나눠 쓴다.
 *   instructorId: 그 강사의 회차만(빈 글자 = 강사를 가리지 않음 — 대표가 학원 전체를 볼 때)
 *   academyId: 그 학원만(빈 글자 = 강사의 active 소속 학원 전부)
 * raw 태그는 null 을 받지 않아 「거르지 않음」을 빈 글자로 나타낸다(주문 목록과 같은 방식).
 */
export type HeadcountScope = { instructorId: string; academyId: string };

const invalid = (path: string, message: string) => new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path, message }] });

/** date 는 비우면 오늘(KST). 모양이 틀리거나 없는 날짜(2월 30일)면 422 */
export function parseHeadcountQuery(
  params: URLSearchParams,
  today: Temporal.PlainDate,
  allowedKeys: readonly string[] = ["date", "academyId"],
): HeadcountQuery {
  // 대표 경로는 학원이 주소에 있어 date 하나만 받는다(allowedKeys = ["date"]) — 모르는 키는 422
  for (const key of params.keys()) {
    if (!allowedKeys.includes(key)) throw invalid(key, DETAIL.unknown);
  }
  const rawDate = params.get("date");
  let date = today;
  if (rawDate !== null) {
    if (!DATE_TEXT.test(rawDate)) throw invalid("date", DETAIL.date);
    try {
      date = Temporal.PlainDate.from(rawDate, { overflow: "reject" });
    } catch {
      throw invalid("date", DETAIL.date);
    }
  }
  const academyId = params.get("academyId") ?? "";
  if (academyId !== "" && !z.uuid().safeParse(academyId).success) throw invalid("academyId", DETAIL.academy);
  return { date, academyId };
}

// ---- DB 읽기 -----------------------------------------------------------------------------------

/** ③ 그날 범위 안 수업 회차 + 자리별 [종류, 정원, 잡힌, 확정, 결석 예정, 현장] */
async function readClassRows(db: Db, scope: HeadcountScope, date: Temporal.PlainDate) {
  const window = kstDateRangeToInstants(date, date);
  const me = scope.instructorId;
  return db.query(
    db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.title, c.seat_mode::text AS seat_mode,
                      to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                      c.academy_id::text AS academy_id, a.name AS academy_name,
                      COALESCE(st.display_name, '') AS instructor_name,
                      COALESCE(rs.name, rc.name, '') AS room_name,
                      COALESCE((
                        SELECT json_agg(json_build_array(p.seat_kind, p.capacity, p.held_count, p.confirmed_count,
                                 (SELECT count(*) FROM attendance_marks am
                                  JOIN reservations r ON r.id = am.reservation_id
                                  JOIN orders od ON od.id = r.order_id
                                  WHERE am.session_id = s.id AND am.cancelled_at IS NULL AND r.seat_kind = p.seat_kind
                                    AND r.status = 'confirmed' AND od.status IN ('paid', 'partially_refunded')),
                                 COALESCE((SELECT sc.onsite_count FROM session_seat_counters sc
                                           WHERE sc.session_id = s.id AND sc.seat_kind = p.seat_kind), 0))
                               ORDER BY array_position(ARRAY['male', 'female', 'any'], p.seat_kind::text))
                        FROM seat_pools p WHERE p.offering_id = o.id)::text, '[]') AS seats
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               JOIN academies a ON a.id = c.academy_id
               LEFT JOIN staff_accounts st ON st.id = COALESCE(s.instructor_account_id, c.instructor_account_id)
               LEFT JOIN rooms rs ON rs.id = s.room_id
               LEFT JOIN rooms rc ON rc.id = c.room_id
               WHERE (${me} = '' OR COALESCE(s.instructor_account_id, c.instructor_account_id)::text = ${me})
                 AND c.status = 'published' AND s.status = 'scheduled'
                 AND s.starts_at >= ${window.start.toString()}::timestamptz AND s.starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND (${me} = '' OR EXISTS (SELECT 1 FROM instructor_affiliations f
                             WHERE f.academy_id = c.academy_id AND f.instructor_account_id::text = ${me} AND f.status = 'active'))
                 AND (${scope.academyId} = '' OR c.academy_id::text = ${scope.academyId})
               ORDER BY s.starts_at, s.id`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        title: "pg/text@1",
        seat_mode: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        instructor_name: "pg/text@1",
        room_name: "pg/text@1",
        seats: "pg/text@1",
      })
      .build(),
  );
}

/** ⑤ 그날 잡힌 1:1 개인 레슨 회차 — 닉네임·성별·수강권 결제 대기 여부만 읽는다 */
async function readPrivateLessonRows(db: Db, scope: HeadcountScope, date: Temporal.PlainDate) {
  const window = kstDateRangeToInstants(date, date);
  const me = scope.instructorId;
  return db.query(
    db.raw.sql`SELECT b.id::text AS booking_id,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                      sl.academy_id::text AS academy_id, a.name AS academy_name, COALESCE(r.name, '') AS room_name,
                      m.nickname, m.gender::text AS gender,
                      CASE WHEN p.status = 'pending_payment' THEN 'true' ELSE 'false' END AS awaiting_payment
               FROM private_lesson_bookings b
               JOIN private_lesson_slots sl ON sl.id = b.slot_id
               JOIN private_lesson_passes p ON p.id = b.pass_id
               JOIN members m ON m.id = p.member_id
               JOIN academies a ON a.id = sl.academy_id
               LEFT JOIN rooms r ON r.id = sl.room_id
               WHERE (${me} = '' OR sl.instructor_account_id::text = ${me}) AND b.status = 'booked'
                 AND sl.starts_at >= ${window.start.toString()}::timestamptz AND sl.starts_at < ${window.endExclusive.toString()}::timestamptz
                 AND (${me} = '' OR EXISTS (SELECT 1 FROM instructor_affiliations f
                             WHERE f.academy_id = sl.academy_id AND f.instructor_account_id::text = ${me} AND f.status = 'active'))
                 AND (${scope.academyId} = '' OR sl.academy_id::text = ${scope.academyId})
               ORDER BY sl.starts_at, b.id`
      .returnsRow({
        booking_id: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        room_name: "pg/text@1",
        nickname: "pg/text@1",
        gender: "pg/text@1",
        awaiting_payment: "pg/text@1",
      })
      .build(),
  );
}

/** 시작 시각 오름차순 — 같은 시각이면 개인 레슨을 먼저(보드 I7 순서), 그다음 id 로 늘 같은 순서 */
function byStart(a: HeadcountItem, b: HeadcountItem): number {
  const time = Temporal.Instant.compare(Temporal.Instant.from(a.startsAt), Temporal.Instant.from(b.startsAt));
  if (time !== 0) return time;
  if (a.kind !== b.kind) return a.kind === "private_lesson" ? -1 : 1;
  const idA = a.kind === "class" ? a.sessionId : a.bookingId;
  const idB = b.kind === "class" ? b.sessionId : b.bookingId;
  return idA.localeCompare(idB);
}

// ---- 하루 인원표 만들기(강사 경로·대표 경로 공통) -------------------------------------------------------

/**
 * scope 범위의 그날(KST) 인원표를 만든다. 권한 검사·결제 대기 정리는 부르는 경로가 먼저 한다.
 * 강사 경로(I1·I7)와 대표 경로(O6·O40)가 이 함수 하나를 써서 같은 회차면 같은 숫자가 나온다.
 */
export async function readHeadcount(db: Db, scope: HeadcountScope, date: Temporal.PlainDate): Promise<InstructorHeadcount> {
  const seatTuple = z.tuple([z.enum(SEAT_KINDS), count, count, count, count, count]);
  const classItems: HeadcountItem[] = (await readClassRows(db, scope, date)).map((row) => {
    const absence: Partial<Record<SeatKind, number>> = {};
    const seats = z
      .array(seatTuple)
      .parse(JSON.parse(row.seats))
      .map(([seatKind, capacity, held, confirmed, absencePlanned, onsite]) => {
        absence[seatKind] = absencePlanned;
        return {
          seatKind,
          capacity,
          confirmed,
          absencePlanned,
          onsite,
          // ④ 오늘 인원 — 모든 화면이 같은 숫자를 보이게 식은 computePresent 하나만 쓴다
          present: computePresent(confirmed, absencePlanned, onsite),
          // 남은 자리 = 정원 − 잡힌 − 확정 − 현장(명단 §4 와 같은 식). 음수는 0
          remaining: Math.max(0, capacity - held - confirmed - onsite),
        };
      });
    return {
      kind: "class" as const,
      classId: row.class_id,
      sessionId: row.session_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      title: row.title,
      academy: { id: row.academy_id, name: row.academy_name },
      roomName: row.room_name === "" ? null : row.room_name,
      instructor: row.instructor_name === "" ? null : { displayName: row.instructor_name },
      seatMode: row.seat_mode as SeatMode,
      seats,
      absence,
    };
  });

  const lessonItems: HeadcountItem[] = (await readPrivateLessonRows(db, scope, date)).map((row) => {
    const gender = row.gender as Gender;
    return {
      kind: "private_lesson" as const,
      bookingId: row.booking_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      title: "개인 레슨 · 1:1",
      academy: { id: row.academy_id, name: row.academy_name },
      roomName: row.room_name === "" ? null : row.room_name,
      // ⑤ 결제 대기여도 닉네임을 보인다 — awaitingPayment 로만 구별(Q20)
      student: { nickname: row.nickname, gender, awaitingPayment: row.awaiting_payment === "true" },
      // 1:1 이라 수강생 한 명이 그 성별 칸의 인원이다. 개인 레슨에는 결석 예정 원천이 없어 0
      present: { male: gender === "male" ? 1 : 0, female: gender === "female" ? 1 : 0 },
      absencePlanned: 0,
    };
  });

  const items = [...classItems, ...lessonItems].sort(byStart);
  return { date: date.toString(), summary: summarizeHeadcount(items), items };
}

// ---- 경로 ----------------------------------------------------------------------------------------

export function createInstructorHeadcountRoute(deps: InstructorDashboardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  // 시계는 부를 때 꺼낸다 — 앱 쪽 deps 의 clock 은 getter 라 import 시점에 읽으면 포트가 미리 만들어진다
  const clock: Clock = () => (deps.clock ?? systemClock)();

  return withRoute<unknown>(async (request) => {
    // ① 강사 본인만 — 다른 강사 id 를 받는 칸이 아예 없다(세션 계정으로만 읽는다)
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const me = staff.staffAccountId;
    const query = parseHeadcountQuery(new URL(request.url).searchParams, kstToday(clock));
    if (query.academyId !== "" && !(await isActiveAffiliation(db, me, query.academyId))) {
      throw new HttpError("FORBIDDEN", DETAIL.academyForbidden);
    }

    // ② 읽기 전 정리 — 기한 지난 결제 대기를 닫아 잡힌 자리를 돌려놓는다
    await expireMyDuePayments(deps, me, clock());

    const body = await readHeadcount(db, { instructorId: me, academyId: query.academyId }, query.date);
    // 계약 스키마로 한 번 더 검사하고 내보낸다 — 본명·연락처 같은 칸이 섞이면 여기서 막힌다
    return Response.json(instructorHeadcountSchema.parse(body), { headers: NO_STORE });
  });
}
