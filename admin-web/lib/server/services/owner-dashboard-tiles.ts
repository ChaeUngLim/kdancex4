// S3-5.6(대시보드 결제 타일·강사 집계) — 대표 대시보드(계약 10 §1)의 결제 뒤 타일 네 개를 DB 에서 센다.
//   요구: FR-079b(대표 대시보드 지표) · 계약 18 §0(타일 숫자를 채우는 같은 계산 함수) · 18 §7(sessions 타일 = 오늘 인원 함수)
//         · 18 열린 점 ⑦(newMembers — 대표 앱 홈 O6 의 「신규 회원」)
//   보드: W29(대시보드) · O6(대표 앱 홈)
//
// 무엇을 세나(계약 10 §1 「타일의 뜻」 표 그대로):
//   todayOrders  — date(KST) 하루에 만들어진 주문 수 · 그날 paid 로 바뀐 주문 수와 금액 합 · 지금 입금을 기다리는 가상계좌 주문 수
//   nearlyFull   — 첫 회차 전·open 판매 단위의 자리 종류마다, 남은 자리가 정원의 10% 이하이거나 2자리 이하(2026-11-19 확정)
//   sessions     — date 와 그 다음 날 회차의 시간·수업·강사·홀·자리별 확정/결석 예정/현장/오늘 인원
//   newMembers   — date 가 든 달(KST)에 이 학원에서 처음 결제를 마친 회원 수
//
// 왜 이렇게 했나:
//   - 숫자 하나하나를 화면이 아니라 이 파일의 SQL 이 센다 — 웹(W29)과 앱(O6)이 같은 응답을 그려 숫자가 갈라지지 않는다.
//   - 「오늘 인원」은 S3-5.5 의 computePresent 하나로 계산한다. 명단(W6)·강사 홈(I1)과 같은 식이라 숫자가 늘 같다.
//   - 남은 자리는 명단·수업 상세와 같은 식(정원 − 잡힌 자리 − 확정 자리 − 앞으로 올 회차의 현장 인원 최댓값, 계약 18 §6 규칙 7)이다.
//   - 회원 이름·연락처는 하나도 읽지 않는다(타일에는 숫자만 — 계약 10 §1).
import { z } from "zod";

import { SEAT_KINDS, type SeatKind } from "../../domain/constants";
import { computePresent } from "../../domain/headcount";
import { isNearlyFull } from "../../domain/owner-dashboard";
import { kstDateRangeToInstants } from "../../domain/time";
import type { Db } from "../../../prisma/db";

const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

// ---- 응답 조각 스키마(계약 10 §1 의 항목 모양 — owner-dashboard.ts 의 전체 스키마가 가져다 쓴다) ----------------

const count = z.number().int().nonnegative();

/** 마감 임박 한 줄 — 판매 단위 하나의 자리 종류 하나 */
export const nearlyFullItemSchema = z.strictObject({
  offeringId: z.uuid(),
  classId: z.uuid(),
  classTitle: z.string(),
  offeringLabel: z.string(),
  seatKind: z.enum(SEAT_KINDS),
  capacity: count,
  remaining: count,
  firstSessionStartsAt: z.iso.datetime({ offset: true }),
});
export type NearlyFullItem = z.infer<typeof nearlyFullItemSchema>;

/** 오늘·내일 회차 한 줄 — 계약 18 §7 의 수업 줄과 같은 칸 이름(capacity·confirmed·absencePlanned·onsite·present) */
export const dashboardSessionItemSchema = z.strictObject({
  sessionId: z.uuid(),
  classId: z.uuid(),
  title: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  instructor: z.strictObject({ displayName: z.string() }).nullable(),
  roomName: z.string().nullable(),
  seats: z.array(
    z.strictObject({ seatKind: z.enum(SEAT_KINDS), capacity: count, confirmed: count, absencePlanned: count, onsite: count, present: count }),
  ),
  absencePlanned: count,
});
export type DashboardSessionItem = z.infer<typeof dashboardSessionItemSchema>;

export type TodayOrdersCounts = { applications: number; paidCount: number; paidAmount: number; awaitingDeposit: number };

// ---- todayOrders --------------------------------------------------------------------------------

/**
 * 「오늘 신청 · 결제」 타일.
 *   applications    = 그날(KST) 만들어진 이 학원 주문 수(상태 무관 — 나중에 만료·취소돼도 「신청이 들어왔다」는 사실은 남는다)
 *   paidCount·paidAmount = 그날 order_events 에서 다른 상태 → paid 로 바뀐 주문 수와 그 주문들의 결제 금액(total_amount) 합
 *   awaitingDeposit = 지금 결제 대기(pending)인 주문 중 가상계좌로 입금 기한이 아직 안 지난 것(「입금 대기」 — 날짜와 무관한 지금 값)
 */
export async function readTodayOrders(db: Db, academyId: string, date: Temporal.PlainDate, now: Temporal.Instant): Promise<TodayOrdersCounts> {
  const day = kstDateRangeToInstants(date, date);
  const start = day.start.toString();
  const end = day.endExclusive.toString();
  const [row] = await db.query(
    db.raw.sql`WITH academy_orders AS (
                 SELECT o.id, o.status::text AS status, o.total_amount, o.created_at
                 FROM orders o
                 JOIN class_offerings co ON co.id = o.offering_id
                 JOIN classes c ON c.id = co.class_id
                 WHERE c.academy_id = ${academyId}::uuid
               ),
               paid_today AS (
                 -- 한 주문이 paid 로 바뀌는 일은 한 번뿐이다. paid → paid 같은 기록 행(입금 늦게 옴 등)은 전이가 아니라 뺀다
                 SELECT DISTINCT e.order_id FROM order_events e JOIN academy_orders ao ON ao.id = e.order_id
                 WHERE e.to_status = 'paid' AND e.from_status IS DISTINCT FROM 'paid'
                   AND e.created_at >= ${start}::timestamptz AND e.created_at < ${end}::timestamptz
               )
               SELECT
                 (SELECT count(*) FROM academy_orders WHERE created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz)::text AS applications,
                 (SELECT count(*) FROM paid_today)::text AS paid_count,
                 (SELECT COALESCE(sum(ao.total_amount), 0) FROM academy_orders ao JOIN paid_today pt ON pt.order_id = ao.id)::text AS paid_amount,
                 (SELECT count(DISTINCT ao.id) FROM academy_orders ao JOIN payments p ON p.order_id = ao.id
                  WHERE ao.status = 'pending' AND p.status = 'ready' AND p.method = 'virtual_account'
                    AND p.due_at > ${now.toString()}::timestamptz)::text AS awaiting`
      .returnsRow({ applications: "pg/text@1", paid_count: "pg/text@1", paid_amount: "pg/text@1", awaiting: "pg/text@1" })
      .build(),
  );
  return {
    applications: Number(row?.applications ?? 0),
    paidCount: Number(row?.paid_count ?? 0),
    paidAmount: Number(row?.paid_amount ?? 0),
    awaitingDeposit: Number(row?.awaiting ?? 0),
  };
}

// ---- nearlyFull ---------------------------------------------------------------------------------

/**
 * 「정원 마감 임박」 — 아직 첫 회차가 시작 전이고 판매 중(open)인 공개 수업의 자리 묶음을 읽어, isNearlyFull 로 거른다.
 * 남은 자리가 적은 것부터, 같으면 첫 회차가 이른 것부터.
 */
export async function readNearlyFull(db: Db, academyId: string, now: Temporal.Instant): Promise<NearlyFullItem[]> {
  const at = now.toString();
  const rows = await db.query(
    db.raw.sql`SELECT o.id::text AS offering_id, c.id::text AS class_id, c.title, o.label, p.seat_kind::text AS seat_kind,
                      p.capacity::int4 AS capacity,
                      -- 남은 자리 = 정원 − 잡힌 자리 − 확정 자리 − 앞으로 올 회차의 현장 인원 최댓값(계약 18 §6 규칙 7, 수업 상세와 같은 식)
                      (p.capacity - p.held_count - p.confirmed_count
                        - COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                    JOIN class_sessions ss ON ss.id = sc.session_id
                                    WHERE ss.offering_id = o.id AND sc.seat_kind = p.seat_kind
                                      AND ss.status = 'scheduled' AND ss.ends_at > ${at}::timestamptz), 0))::int4 AS remaining,
                      to_char(o.first_session_starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS first_starts_at
               FROM class_offerings o
               JOIN classes c ON c.id = o.class_id
               JOIN seat_pools p ON p.offering_id = o.id
               WHERE c.academy_id = ${academyId}::uuid AND c.status = 'published' AND o.status = 'open'
                 AND o.first_session_starts_at > ${at}::timestamptz
               ORDER BY o.first_session_starts_at, o.id, array_position(ARRAY['male', 'female', 'any'], p.seat_kind::text)`
      .returnsRow({
        offering_id: "pg/text@1",
        class_id: "pg/text@1",
        title: "pg/text@1",
        label: "pg/text@1",
        seat_kind: "pg/text@1",
        capacity: "pg/int4@1",
        remaining: "pg/int4@1",
        first_starts_at: "pg/text@1",
      })
      .build(),
  );
  const items = rows
    .map((row) => ({ ...row, remaining: Math.max(0, row.remaining) }))
    .filter((row) => isNearlyFull(row.capacity, row.remaining))
    .map((row) => ({
      offeringId: row.offering_id,
      classId: row.class_id,
      classTitle: row.title,
      offeringLabel: row.label,
      seatKind: row.seat_kind as SeatKind,
      capacity: row.capacity,
      remaining: row.remaining,
      firstSessionStartsAt: row.first_starts_at,
    }));
  // 정렬은 새 배열로(원본을 고치지 않는다). sort 는 안정 정렬이라 같은 남은 자리끼리는 SQL 의 첫 회차 순서가 남는다
  return [...items].sort((a, b) => a.remaining - b.remaining);
}

// ---- sessions -----------------------------------------------------------------------------------

/**
 * 「오늘 · 내일 수업」 — date 와 다음 날(KST) 회차. 휴강·폐강 회차는 빼고(계약 18 §7), 공개 수업만.
 * 자리 칸은 오늘 인원 = 확정 − 결석 예정 + 현장(computePresent). 결석 예정은 결제 완료 수강생의 살아 있는 결석 행만 센다
 * (명단 session-roster.ts 와 같은 조건 — 홈·명단·결석 목록의 숫자가 같아야 한다).
 */
export async function readDashboardSessions(
  db: Db,
  academyId: string,
  date: Temporal.PlainDate,
): Promise<{ today: DashboardSessionItem[]; tomorrow: DashboardSessionItem[] }> {
  const tomorrow = date.add({ days: 1 });
  const window = kstDateRangeToInstants(date, tomorrow);
  const rows = await db.query(
    db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.title,
                      to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                      to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                      to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS kst_date,
                      COALESCE(st.display_name, '') AS instructor_name,
                      COALESCE(rs.name, rc.name, '') AS room_name,
                      COALESCE((
                        SELECT json_agg(json_build_array(p.seat_kind, p.capacity, p.confirmed_count,
                                 (SELECT count(*) FROM attendance_marks a
                                  JOIN reservations r ON r.id = a.reservation_id
                                  JOIN orders od ON od.id = r.order_id
                                  WHERE a.session_id = s.id AND a.cancelled_at IS NULL AND r.seat_kind = p.seat_kind
                                    AND r.status = 'confirmed' AND od.status IN ('paid', 'partially_refunded')),
                                 COALESCE((SELECT sc.onsite_count FROM session_seat_counters sc
                                           WHERE sc.session_id = s.id AND sc.seat_kind = p.seat_kind), 0))
                               ORDER BY array_position(ARRAY['male', 'female', 'any'], p.seat_kind::text))
                        FROM seat_pools p WHERE p.offering_id = o.id)::text, '[]') AS seats
               FROM class_sessions s
               JOIN class_offerings o ON o.id = s.offering_id
               JOIN classes c ON c.id = o.class_id
               LEFT JOIN staff_accounts st ON st.id = COALESCE(s.instructor_account_id, c.instructor_account_id)
               LEFT JOIN rooms rs ON rs.id = s.room_id
               LEFT JOIN rooms rc ON rc.id = c.room_id
               WHERE c.academy_id = ${academyId}::uuid AND c.status = 'published' AND s.status = 'scheduled'
                 AND s.starts_at >= ${window.start.toString()}::timestamptz AND s.starts_at < ${window.endExclusive.toString()}::timestamptz
               ORDER BY s.starts_at, s.id`
      .returnsRow({
        session_id: "pg/text@1",
        class_id: "pg/text@1",
        title: "pg/text@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        kst_date: "pg/text@1",
        instructor_name: "pg/text@1",
        room_name: "pg/text@1",
        seats: "pg/text@1",
      })
      .build(),
  );

  // seats 칸은 [자리 종류, 정원, 확정, 결석 예정, 현장] 의 배열 목록(JSON 글자)이다 — 모양을 검사한 뒤 쓴다
  const seatTuple = z.tuple([z.enum(SEAT_KINDS), count, count, count, count]);
  const toItem = (row: (typeof rows)[number]): DashboardSessionItem => {
    const seats = z
      .array(seatTuple)
      .parse(JSON.parse(row.seats))
      .map(([seatKind, capacity, confirmed, absencePlanned, onsite]) => ({
        seatKind,
        capacity,
        confirmed,
        absencePlanned,
        onsite,
        present: computePresent(confirmed, absencePlanned, onsite),
      }));
    return {
      sessionId: row.session_id,
      classId: row.class_id,
      title: row.title,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      instructor: row.instructor_name === "" ? null : { displayName: row.instructor_name },
      roomName: row.room_name === "" ? null : row.room_name,
      seats,
      absencePlanned: seats.reduce((sum, seat) => sum + seat.absencePlanned, 0),
    };
  };
  const todayText = date.toString();
  return {
    today: rows.filter((row) => row.kst_date === todayText).map(toItem),
    tomorrow: rows.filter((row) => row.kst_date !== todayText).map(toItem),
  };
}

// ---- newMembers ---------------------------------------------------------------------------------

/**
 * 「신규 회원」 — date 가 든 달(KST 1일 0시 ~ 다음 달 1일 0시)에 이 학원에서 **첫** 결제를 마친 회원 수.
 * 첫 결제 시각은 이 학원 주문 중 결제를 마친 적이 있는 것(paid·partially_refunded·refunded)의 paid_at 최솟값이다
 * (명단의 「수강 개월 수」와 같은 기준 — 나중에 환불돼도 「처음 결제한 달」은 바뀌지 않는다).
 */
export async function readNewMembers(db: Db, academyId: string, date: Temporal.PlainDate): Promise<number> {
  const first = date.with({ day: 1 });
  const month = kstDateRangeToInstants(first, first.add({ months: 1 }).subtract({ days: 1 }));
  const [row] = await db.query(
    db.raw.sql`SELECT count(*)::text AS n FROM (
                 SELECT o.member_id, min(o.paid_at) AS first_paid_at
                 FROM orders o
                 JOIN class_offerings co ON co.id = o.offering_id
                 JOIN classes c ON c.id = co.class_id
                 WHERE c.academy_id = ${academyId}::uuid AND o.paid_at IS NOT NULL
                   AND o.status IN ('paid', 'partially_refunded', 'refunded')
                 GROUP BY o.member_id
               ) firsts
               WHERE first_paid_at >= ${month.start.toString()}::timestamptz AND first_paid_at < ${month.endExclusive.toString()}::timestamptz`
      .returnsRow({ n: "pg/text@1" })
      .build(),
  );
  return Number(row?.n ?? 0);
}
