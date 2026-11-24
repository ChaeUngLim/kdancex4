// S3-4.2(캘린더 조회 API) — `GET /api/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §1(캘린더 조회) · §4-1(항목에 sessionId · absence 를 더한다)
//   데이터: data-model `calendar_entries`(FR-289(확정 후 일괄 처리)에서 웹훅 확정이 회차마다 넣은 행) · §7-8 `attendance_marks`
//   보드: M11(내 캘린더 · 참석/결석 토글)
//
// 흐름 한눈에 — 회원 확인 → 날짜 범위 검사 → 내 캘린더 행만 읽기:
//   ① 회원 세션이 있어야 한다(requireMember — 없으면 401, 가입을 덜 마쳤으면 403).
//   ② from·to 는 KST 달력 날짜다. 둘 다 비우면 오늘(KST)부터 31일 뒤까지, to 만 비우면 from 부터 31일 뒤까지.
//      to 가 from 보다 앞이거나 범위가 62일을 넘으면 422 — 한 번에 너무 많은 행을 읽지 않게 막는다.
//   ③ KST 날짜 [from, to] 를 UTC 순간 구간 [시작, 끝) 으로 바꿔 `starts_at` 으로 고른다.
//      (예: KST 12/01 하루 = UTC 11/30 15:00 ~ 12/01 15:00) DB 에는 UTC 순간이 들어 있어서다.
//   ④ 행은 **내 것만** 읽는다(`calendar_entries.member_id = 나`). 남의 회차는 경로로도 쿼리로도 볼 수 없다.
//      예약이 확정(confirmed) 상태인 행만 낸다 — 취소 트랜잭션이 행을 지우지만, 혹시 남아도 보이지 않게 한 번 더 거른다.
//   ⑤ 회차마다 살아 있는 결석 표시(attendance_marks, cancelled_at IS NULL)가 있으면 absence 로 붙인다(없으면 null).
//      출석 횟수·출석률 같은 숫자는 어디에도 내지 않는다(D7).
import { z } from "zod";

import { ATTENDANCE_DISPUTE_STATUSES, ATTENDANCE_MARKED_BY_KINDS } from "../../domain/constants";
import { kstDateRangeToInstants, kstToday, parseKstDate, systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";

// ---- 정해진 값 -----------------------------------------------------------------------------

/** 기본 범위 — 시작일부터 31일 뒤까지(계약 04 §1 「기본 오늘~+31일」) */
export const CALENDAR_DEFAULT_SPAN_DAYS = 31;
/** 한 번에 읽을 수 있는 최대 범위(양 끝 포함 일수, 계약 04 §1 「최대 62일」) */
export const CALENDAR_MAX_SPAN_DAYS = 62;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const DETAIL = {
  validation: "조회 기간을 확인해 주세요",
  dateFormat: "날짜는 YYYY-MM-DD 형식이어야 해요",
  order: "끝날이 시작일보다 앞이에요",
  tooLong: `한 번에 ${CALENDAR_MAX_SPAN_DAYS}일까지만 볼 수 있어요`,
} as const;

// ---- 응답 모양(계약 04 §1 + §4-1) — 테스트가 이 스키마로 응답을 parse 한다 ----------------------

export const calendarAbsenceSchema = z.strictObject({
  markId: z.string(),
  markedByKind: z.enum(ATTENDANCE_MARKED_BY_KINDS),
  disputeStatus: z.enum(ATTENDANCE_DISPUTE_STATUSES),
  canToggle: z.boolean(),
});

export const calendarItemSchema = z.strictObject({
  entryId: z.string(),
  reservationId: z.string(),
  offeringId: z.string(),
  sessionId: z.string(),
  sessionSeq: z.number().int(),
  title: z.string(),
  academyName: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  absence: calendarAbsenceSchema.nullable(),
});

export const calendarResponseSchema = z.strictObject({ items: z.array(calendarItemSchema) });
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

// ---- 결석 토글 가능 여부 — 계산은 이 한 곳(계약 04 §4-1 「§5 의 규칙과 같은 계산 한 곳」) --------------

/**
 * 회원이 이 결석 표시를 스스로 끌 수 있는가.
 * 내가 켠 결석(marked_by_kind = member)이고 수업 시작 전일 때만 true.
 * 강사·대표가 표시한 결석은 회원이 끄지 못하고 이의 신청으로만 다툰다(계약 04 §5 ⑤ · §8).
 */
export function canMemberToggleAbsence(markedByKind: string, sessionStartsAt: Temporal.Instant, now: Temporal.Instant): boolean {
  return markedByKind === "member" && Temporal.Instant.compare(now, sessionStartsAt) < 0;
}

// ---- 날짜 범위 읽기 ---------------------------------------------------------------------------

/** 쿼리의 날짜 한 칸 — 비었으면 null, 모양이 틀리거나 없는 날(2월 30일)이면 422 */
function readDate(url: URL, name: "from" | "to"): Temporal.PlainDate | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  try {
    return parseKstDate(raw);
  } catch {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: name, message: DETAIL.dateFormat }] });
  }
}

/**
 * from·to 를 정한다. 비운 칸은 기본값으로 채우고, 순서·길이를 검사한다.
 * 길이는 양 끝을 포함한 일수다 — 12/01~12/01 은 1일, 12/01~01/31 은 62일.
 */
export function resolveCalendarRange(url: URL, today: Temporal.PlainDate): { from: Temporal.PlainDate; to: Temporal.PlainDate } {
  const from = readDate(url, "from") ?? today;
  const to = readDate(url, "to") ?? from.add({ days: CALENDAR_DEFAULT_SPAN_DAYS });
  if (Temporal.PlainDate.compare(from, to) > 0) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "to", message: DETAIL.order }] });
  }
  const spanDays = from.until(to, { largestUnit: "days" }).days + 1;
  if (spanDays > CALENDAR_MAX_SPAN_DAYS) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "to", message: DETAIL.tooLong }] });
  }
  return { from, to };
}

// ---- 경로 -----------------------------------------------------------------------------------

export type MeCalendarDeps = GuardDeps & { clock?: Clock };

export function createMeCalendarRoute(deps: MeCalendarDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  return withRoute<unknown>(async (request) => {
    // 순서: 인증(401·403) → 기간(422) — 로그인 안 한 요청이 기간 오류부터 보지 않게
    const member = await guards.requireMember(request);
    const now = clock();
    const { from, to } = resolveCalendarRange(new URL(request.url), kstToday(clock));
    const { start, endExclusive } = kstDateRangeToInstants(from, to);

    // 회차 번호(sessionSeq)는 같은 판매 단위 안에서 시작 시각 순서다 — class_sessions 에 순번 칸이 없어서 여기서 센다.
    // 결석 표시는 회차·예약마다 살아 있는 행이 최대 1개다(uq_attendance_session).
    const rows = await db.query(
      db.raw.sql`SELECT ce.id::text AS entry_id, ce.reservation_id::text AS reservation_id, s.offering_id::text AS offering_id,
                        ce.session_id::text AS session_id,
                        (SELECT count(*)::int4 FROM class_sessions s2
                          WHERE s2.offering_id = s.offering_id
                            AND (s2.starts_at, s2.id) <= (s.starts_at, s.id)) AS session_seq,
                        ce.title, a.name AS academy_name,
                        to_char(ce.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                        to_char(ce.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                        COALESCE(am.id::text, '') AS mark_id,
                        COALESCE(am.marked_by_kind::text, '') AS marked_by_kind,
                        COALESCE(am.dispute_status::text, '') AS dispute_status
                 FROM calendar_entries ce
                 JOIN reservations r ON r.id = ce.reservation_id
                 JOIN class_sessions s ON s.id = ce.session_id
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 LEFT JOIN attendance_marks am
                        ON am.reservation_id = ce.reservation_id AND am.session_id = ce.session_id AND am.cancelled_at IS NULL
                 WHERE ce.member_id = ${member.memberId}::uuid
                   AND r.status = 'confirmed'
                   AND ce.starts_at >= ${start.toString()}::timestamptz
                   AND ce.starts_at < ${endExclusive.toString()}::timestamptz
                 ORDER BY ce.starts_at, ce.id`
        .returnsRow({
          entry_id: "pg/text@1",
          reservation_id: "pg/text@1",
          offering_id: "pg/text@1",
          session_id: "pg/text@1",
          session_seq: "pg/int4@1",
          title: "pg/text@1",
          academy_name: "pg/text@1",
          starts_at: "pg/text@1",
          ends_at: "pg/text@1",
          mark_id: "pg/text@1",
          marked_by_kind: "pg/text@1",
          dispute_status: "pg/text@1",
        })
        .build(),
    );

    const body: CalendarResponse = {
      items: rows.map((row) => ({
        entryId: row.entry_id,
        reservationId: row.reservation_id,
        offeringId: row.offering_id,
        sessionId: row.session_id,
        sessionSeq: row.session_seq,
        title: row.title,
        academyName: row.academy_name,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        // 결석 행이 없으면 COALESCE 로 빈 글자가 온다 → null
        absence:
          row.mark_id === ""
            ? null
            : {
                markId: row.mark_id,
                markedByKind: row.marked_by_kind as (typeof ATTENDANCE_MARKED_BY_KINDS)[number],
                disputeStatus: row.dispute_status as (typeof ATTENDANCE_DISPUTE_STATUSES)[number],
                canToggle: canMemberToggleAbsence(row.marked_by_kind, Temporal.Instant.from(row.starts_at), now),
              },
      })),
    };
    return Response.json(body, { headers: NO_STORE });
  });
}
