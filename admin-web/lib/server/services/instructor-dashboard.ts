// S3-5.6(대시보드 결제 타일·강사 집계) — `GET /api/instructor/dashboard?from=&to=&academyId=`(계약 18 §9).
//   요구: FR-064(강사 대시보드 집계) · 18 §1-1 권한 표 「§9 강사 집계」 줄(강사 본인, 자기 수업만)
//         · D22(관심 등록 수는 FR-023 이 베타 뒤라 준비 중) · 10 §1 뼈대 원칙(준비 전 숫자는 0 이 아니라 null)
//   보드: I1(강사 홈)
//
// 한 줄 = 그 강사가 맡은 판매 단위 하나. 기간(KST 달력, 기본 이번 주 월~일) 안에 내 회차가 하나라도 있는 판매 단위만 센다.
//   「내 회차」 = 회차의 담당 강사가 나(대타로 맡은 회차 포함). 회차에 담당이 비어 있으면 수업의 담당 강사로 본다
//   (계약 §9 「classes.instructor_account_id 또는 회차 담당」).
//
// 칸마다 무엇을 세나(계약 §9):
//   applicants  = 자리 묶음의 확정 인원 합(seat_pools.confirmed_count — 결제 대기는 빼고)
//   remaining   = 자리 종류별 정원 − 잡힌 자리 − 확정 자리 − 앞으로 올 회차의 현장 인원 최댓값(수업 상세·대표 타일과 같은 식)
//   cancelled   = 기간 안에 취소된 예약 수(reservations.cancelled_at 이 기간 안)
//   weekdays    = class_offerings.schedule_rule 의 요일. 반복 규칙이 없는 수업(날짜를 하나하나 고른 것)은 기간 안 회차의 KST 요일
//   totalsByWeekday = 줄마다 applicants 를 그 줄의 요일마다 더한다(월·수 수업은 월·수 양쪽에 센다)
//
// 왜 소속을 보나: 지금 active 소속인 학원의 수업만 센다. 소속이 끝난 학원의 신청 인원을 계속 보지 않게
//   (명단 경로와 같은 기준). academyId 를 주면 그 학원이 내 active 소속이어야 한다 — 아니면 403.
// 숫자만 내린다. 회원 이름·연락처는 읽지도 않는다.
import { z } from "zod";

import { WEEKDAYS, type Weekday } from "../../domain/recurring-schedule";
import { kstDateRangeToInstants, kstToday, systemClock, toKstDate, type Clock } from "../../domain/time";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import type { Db } from "../../../prisma/db";
import { expireDuePayments } from "./order-expiry";

/** 한 번에 볼 수 있는 최대 날짜 수 — 강사 일정(계약 11 §11)과 같은 62일 */
export const INSTRUCTOR_DASHBOARD_MAX_DAYS = 62;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

const DETAIL = {
  forbidden: "강사 계정으로만 집계를 볼 수 있어요",
  academyForbidden: "지금 소속된 학원만 고를 수 있어요",
  range: `날짜 범위를 확인해 주세요(YYYY-MM-DD, 최대 ${INSTRUCTOR_DASHBOARD_MAX_DAYS}일)`,
  academy: "academyId 값을 확인해 주세요",
  unknown: "알 수 없는 쿼리 이름이에요",
} as const;

// ---- 응답 계약(18 §9) — strict: 모르는 키(회원 이름 등)가 섞이면 parse 가 실패한다 ---------------------

const count = z.number().int().nonnegative();

export const instructorDashboardSchema = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  items: z.array(
    z.strictObject({
      offeringId: z.uuid(),
      classTitle: z.string(),
      academy: z.strictObject({ id: z.uuid(), name: z.string() }),
      weekdays: z.array(z.enum(WEEKDAYS)),
      sessionCount: count,
      applicants: count,
      // 그 자리 종류가 없는 수업이면 null(단일 정원이면 male·female 이 null, 남녀 정원이면 any 가 null)
      remaining: z.strictObject({ male: count.nullable(), female: count.nullable(), any: count.nullable() }),
      cancelled: count,
      waitlist: z.strictObject({ available: z.boolean(), availableFrom: z.string().nullable(), count: count.nullable() }),
    }),
  ),
  totalsByWeekday: z.array(z.strictObject({ weekday: z.enum(WEEKDAYS), applicants: count })),
  interest: z.strictObject({ available: z.boolean(), availableFrom: z.string().nullable(), count: count.nullable() }),
});
export type InstructorDashboard = z.infer<typeof instructorDashboardSchema>;
type DashboardItem = InstructorDashboard["items"][number];

/** 대기 신청(S4-4) 전에는 대기자 수를 셀 원천이 없다 — 0 이 아니라 null */
const WAITLIST_NOT_READY = { available: false, availableFrom: "S4-4", count: null } as const;
/** 관심 등록(FR-023)은 베타 뒤(D22) */
const INTEREST_NOT_READY = { available: false, availableFrom: "베타 뒤(D22 · FR-023)", count: null } as const;

// ---- 순수 계산(DB 없이 시험한다) ------------------------------------------------------------------

/** 기본 기간 — 오늘(KST)이 든 주의 월요일 ~ 일요일 */
export function defaultWeek(today: Temporal.PlainDate): { from: Temporal.PlainDate; to: Temporal.PlainDate } {
  const from = today.subtract({ days: today.dayOfWeek - 1 });
  return { from, to: from.add({ days: 6 }) };
}

/** 요일별 합 — 줄의 applicants 를 그 줄의 요일마다 더하고, 월요일부터 순서대로(한 번도 안 나온 요일은 뺀다) */
export function totalsByWeekday(items: readonly Pick<DashboardItem, "weekdays" | "applicants">[]): InstructorDashboard["totalsByWeekday"] {
  return WEEKDAYS.flatMap((weekday) => {
    const rows = items.filter((item) => item.weekdays.includes(weekday));
    return rows.length === 0 ? [] : [{ weekday, applicants: rows.reduce((sum, item) => sum + item.applicants, 0) }];
  });
}

/** 반복 규칙(schedule_rule JSON)에서 요일을 꺼낸다. 규칙이 없거나 모양이 다르면 null(→ 회차 날짜로 센다) */
export function weekdaysFromRule(ruleJson: string): Weekday[] | null {
  if (ruleJson === "") return null;
  const parsed = z.object({ weekdays: z.array(z.enum(WEEKDAYS)).min(1) }).safeParse(JSON.parse(ruleJson));
  if (!parsed.success) return null;
  return WEEKDAYS.filter((weekday) => parsed.data.weekdays.includes(weekday));
}

/** 회차 시작 시각들 → 그 KST 요일(월요일부터, 겹치지 않게) */
export function weekdaysFromStarts(starts: readonly string[]): Weekday[] {
  const days = new Set(starts.map((start) => WEEKDAYS[toKstDate(Temporal.Instant.from(start)).dayOfWeek - 1]!));
  return WEEKDAYS.filter((weekday) => days.has(weekday));
}

// ---- 쿼리 -------------------------------------------------------------------------------------

type DashboardQuery = { from: Temporal.PlainDate; to: Temporal.PlainDate; academyId: string };

const invalid = (path: string, message: string) => new HttpError("VALIDATION_FAILED", "입력값을 확인해 주세요", { fields: [{ path, message }] });

function toDate(text: string | null): Temporal.PlainDate | null {
  if (text === null || !DATE_TEXT.test(text)) return null;
  try {
    return Temporal.PlainDate.from(text, { overflow: "reject" });
  } catch {
    return null;
  }
}

/** from·to 는 둘 다 주거나 둘 다 비운다(비우면 이번 주). 틀리면 422 */
export function parseDashboardQuery(params: URLSearchParams, today: Temporal.PlainDate): DashboardQuery {
  for (const key of params.keys()) {
    if (!["from", "to", "academyId"].includes(key)) throw invalid(key, DETAIL.unknown);
  }
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  let range = defaultWeek(today);
  if (rawFrom !== null || rawTo !== null) {
    const from = toDate(rawFrom);
    const to = toDate(rawTo);
    if (from === null || to === null || Temporal.PlainDate.compare(from, to) > 0) throw invalid("from", DETAIL.range);
    if (from.until(to, { largestUnit: "days" }).days + 1 > INSTRUCTOR_DASHBOARD_MAX_DAYS) throw invalid("to", DETAIL.range);
    range = { from, to };
  }
  const academyId = params.get("academyId") ?? "";
  if (academyId !== "" && !z.uuid().safeParse(academyId).success) throw invalid("academyId", DETAIL.academy);
  return { ...range, academyId };
}

// ---- DB 읽기 -----------------------------------------------------------------------------------

/** 내 회차가 기간 안에 있는 판매 단위 + 그 집계. 지금 active 소속 학원의 공개 수업만 */
async function readMyOfferings(db: Db, me: string, query: DashboardQuery, now: Temporal.Instant) {
  const window = kstDateRangeToInstants(query.from, query.to);
  const start = window.start.toString();
  const end = window.endExclusive.toString();
  return db.query(
    db.raw.sql`WITH my_sessions AS (
                 SELECT s.offering_id, s.starts_at
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 WHERE COALESCE(s.instructor_account_id, c.instructor_account_id) = ${me}::uuid
                   AND c.status = 'published' AND s.status = 'scheduled'
                   AND s.starts_at >= ${start}::timestamptz AND s.starts_at < ${end}::timestamptz
                   AND (${query.academyId} = '' OR c.academy_id::text = ${query.academyId})
                   AND EXISTS (SELECT 1 FROM instructor_affiliations f
                               WHERE f.academy_id = c.academy_id AND f.instructor_account_id = ${me}::uuid AND f.status = 'active')
               )
               SELECT o.id::text AS offering_id, c.title, a.id::text AS academy_id, a.name AS academy_name,
                      COALESCE(o.schedule_rule::text, '') AS schedule_rule,
                      (SELECT json_agg(to_char(ms.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) ORDER BY ms.starts_at)
                       FROM my_sessions ms WHERE ms.offering_id = o.id)::text AS starts,
                      (SELECT COALESCE(sum(p.confirmed_count), 0) FROM seat_pools p WHERE p.offering_id = o.id)::text AS applicants,
                      COALESCE((SELECT json_object_agg(p.seat_kind,
                                  p.capacity - p.held_count - p.confirmed_count
                                  - COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                              JOIN class_sessions ss ON ss.id = sc.session_id
                                              WHERE ss.offering_id = o.id AND sc.seat_kind = p.seat_kind
                                                AND ss.status = 'scheduled' AND ss.ends_at > ${now.toString()}::timestamptz), 0))
                                FROM seat_pools p WHERE p.offering_id = o.id)::text, '{}') AS remaining,
                      (SELECT count(*) FROM reservations r
                       WHERE r.offering_id = o.id AND r.status = 'cancelled'
                         AND r.cancelled_at >= ${start}::timestamptz AND r.cancelled_at < ${end}::timestamptz)::text AS cancelled
               FROM class_offerings o
               JOIN classes c ON c.id = o.class_id
               JOIN academies a ON a.id = c.academy_id
               WHERE o.id IN (SELECT offering_id FROM my_sessions)
               ORDER BY (SELECT min(ms.starts_at) FROM my_sessions ms WHERE ms.offering_id = o.id), c.title, o.id`
      .returnsRow({
        offering_id: "pg/text@1",
        title: "pg/text@1",
        academy_id: "pg/text@1",
        academy_name: "pg/text@1",
        schedule_rule: "pg/text@1",
        starts: "pg/text@1",
        applicants: "pg/text@1",
        remaining: "pg/text@1",
        cancelled: "pg/text@1",
      })
      .build(),
  );
}

/** academyId 를 골랐다면 그 학원이 내 active 소속인가 */
export async function isActiveAffiliation(db: Db, me: string, academyId: string): Promise<boolean> {
  const [row] = await db.query(
    db.raw.sql`SELECT id FROM instructor_affiliations
               WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${me}::uuid AND status = 'active'`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  return row !== undefined;
}

/** 읽기 전 정리 — 내 수업 중 기한 지난 결제 대기가 있는 판매 단위만 닫는다(잡힌 자리가 남은 자리에서 풀리게) */
export async function expireMyDuePayments(deps: InstructorDashboardDeps, me: string, now: Temporal.Instant): Promise<void> {
  const { db } = deps;
  const due = await db.query(
    db.raw.sql`SELECT DISTINCT o.offering_id
               FROM orders o
               JOIN payments p ON p.order_id = o.id
               JOIN class_offerings co ON co.id = o.offering_id
               JOIN classes c ON c.id = co.class_id
               WHERE o.status = 'pending' AND p.status = 'ready' AND p.due_at <= ${now.toString()}::timestamptz
                 AND (c.instructor_account_id = ${me}::uuid
                      OR EXISTS (SELECT 1 FROM class_sessions s WHERE s.offering_id = co.id AND s.instructor_account_id = ${me}::uuid))`
      .returnsRow({ offering_id: "pg/uuid@1" })
      .build(),
  );
  const clock = deps.clock ?? systemClock;
  for (const row of due) await expireDuePayments({ db, clock, paymentGateway: deps.paymentGateway }, { offeringId: row.offering_id });
}

// ---- 경로 ----------------------------------------------------------------------------------------

export type InstructorDashboardDeps = GuardDeps & { clock?: Clock } & Pick<ServerDeps, "paymentGateway">;

export function createInstructorDashboardRoute(deps: InstructorDashboardDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock: Clock = () => (deps.clock ?? systemClock)();

  return withRoute<unknown>(async (request) => {
    // 강사 본인만 — 다른 강사 id 를 받는 칸이 아예 없다(세션의 계정으로만 읽는다)
    const staff = await guards.requireStaffAccount(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    const me = staff.staffAccountId;
    const now = clock();
    const query = parseDashboardQuery(new URL(request.url).searchParams, kstToday(clock));
    if (query.academyId !== "" && !(await isActiveAffiliation(db, me, query.academyId))) {
      throw new HttpError("FORBIDDEN", DETAIL.academyForbidden);
    }

    await expireMyDuePayments(deps, me, now);
    const rows = await readMyOfferings(db, me, query, now);

    const remainingSchema = z.record(z.string(), z.number().int());
    const items: DashboardItem[] = rows.map((row) => {
      const starts = z.array(z.string()).parse(JSON.parse(row.starts));
      const remaining = remainingSchema.parse(JSON.parse(row.remaining));
      // 남은 자리가 음수로 읽히면(현장 인원이 정원 근처일 때 식의 차이) 0 으로 둔다 — 「없다」는 null, 「다 찼다」는 0
      const seat = (kind: string) => (remaining[kind] === undefined ? null : Math.max(0, remaining[kind]!));
      return {
        offeringId: row.offering_id,
        classTitle: row.title,
        academy: { id: row.academy_id, name: row.academy_name },
        weekdays: weekdaysFromRule(row.schedule_rule) ?? weekdaysFromStarts(starts),
        sessionCount: starts.length,
        applicants: Number(row.applicants),
        remaining: { male: seat("male"), female: seat("female"), any: seat("any") },
        cancelled: Number(row.cancelled),
        waitlist: { ...WAITLIST_NOT_READY },
      };
    });

    const body: InstructorDashboard = {
      from: query.from.toString(),
      to: query.to.toString(),
      items,
      totalsByWeekday: totalsByWeekday(items),
      interest: { ...INTEREST_NOT_READY },
    };
    // 계약 스키마로 한 번 더 검사하고 내보낸다
    return Response.json(instructorDashboardSchema.parse(body), { headers: NO_STORE });
  });
}
