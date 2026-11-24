// S3-5.2(명단 API) — 회차 명단. 그 회차의 결제 완료 수강생(닉네임·연령대·가린 연락처)과 결제 대기 인원 수를 내린다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-1(권한 「§4 회차 명단」 줄) · §1-2(회원을 보여 주는 규칙) · §4(회차 명단)
//   데이터: data-model §15 읽기 지도 S3-5 FR-005·FR-187 행 — reservations(confirmed) + orders(paid·partially_refunded) + members +
//           attendance_marks + seat_pools
//   요구: FR-005(역할별 데이터 범위) · FR-019a(닉네임만) · FR-168(연령대) · FR-187(연락처 마스킹) · FR-106(현장 등록 반영) · Q20(강사 명단 표시 범위)
//   보드: W6(예약·명단) · W23(위임 강사의 예약·명단) · I23(강사 앱 회원 관리 탭)
//
// 흐름 한눈에 — 회차 찾기 → 누가 부르나 → 기한 지난 결제 대기 정리 → 자리 표 · 결제 대기 수 · 결제 완료 명단:
//   ① 수업 id 와 회차 id 가 이어져 있지 않거나 없으면 404.
//   ② 그 학원 대표 · 위임 강사(roster_manage) · 그 회차의 담당 강사만 본다(결석 표시 경로와 같은 판정). 그 밖은 403.
//      강사는 지금도 그 학원 active 소속이어야 한다 — 소속이 끝난 강사가 회원 명단을 계속 보지 못하게.
//   ③ 기한이 지난 결제 대기를 먼저 닫는다(주문 목록과 같은 「읽기 전 정리」). 그래야 「결제 대기 1명」이 이미 만료된 사람을 세지 않는다.
//   ④ 결제 대기는 **숫자만** 센다(awaitingPayment). 이름·연락처·결제 수단을 읽지도 않는다(Q20 · 수용 ③).
//      결제 완료(예약 confirmed + 주문 paid·partially_refunded)만 members 에 이름이 나온다.
//   ⑤ 결석 예정이 맨 위(2026-10-05 결정), 그 안은 닉네임 순.
//
// 아직 없는 값:
//   - 현장 등록 인원(onsite)은 S3-5.4(현장 등록 인원)의 session_seat_counters 에서 읽는다(행이 없으면 0).
//   - 오늘 인원(present)은 S3-5.5(오늘 인원 계산)의 computePresent(「확정 − 결석 예정 + 현장」) 하나로 계산한다 —
//     홈·명단·결석 목록의 숫자가 늘 같게 하려고 식을 이 파일에 따로 두지 않는다.
import { z } from "zod";

import { GENDERS, SEAT_KINDS, SEAT_MODES, CLASS_KINDS, type ClassKind, type Gender, type SeatKind, type SeatMode } from "../../domain/constants";
import { computePresent } from "../../domain/headcount";
import { AGE_BANDS, ageBandOf, maskPhone } from "../../domain/member-privacy";
import { systemClock, toKstDate, type Clock } from "../../domain/time";
import type { GuardDeps, StaffAccountContext } from "../guards";
import { HttpError, withRoute } from "../http";
import type { PaymentGatewayPort } from "../ports/payment-gateway";
import { createClassAccess } from "./class-registration";
import { expireDuePayments } from "./order-expiry";

export type SessionRosterDeps = GuardDeps & { clock?: Clock; paymentGateway: PaymentGatewayPort };

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  notFound: "회차를 찾을 수 없어요",
  forbidden: "이 회차의 명단을 볼 권한이 없어요",
} as const;

// ---- 순수 계산(DB 없이 시험한다) -----------------------------------------------------------------

/**
 * 수강 개월 수(I23 「3개월째」) — 이 학원에서 처음 결제 완료한 달부터 이 회차의 달까지 센다(둘 다 KST 달력).
 * 9월에 처음 결제하고 11월 회차를 보면 9·10·11 → 3. 같은 달이면 1. 회차가 첫 결제보다 앞서는 이상한 값도 1 로 둔다.
 */
export function countEnrolledMonths(firstPaidAt: Temporal.Instant, sessionStartsAt: Temporal.Instant): number {
  const first = toKstDate(firstPaidAt);
  const session = toKstDate(sessionStartsAt);
  const months = (session.year - first.year) * 12 + (session.month - first.month) + 1;
  return Math.max(1, months);
}

// ---- 응답 스키마(계약 §4) — strict: 모르는 키(본명·전체 연락처·결제 수단)가 섞이면 parse 가 실패한다 ---------------

const isoInstant = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

export const rosterSeatSchema = z.strictObject({
  seatKind: z.enum(SEAT_KINDS),
  capacity: count,
  appConfirmed: count,
  absencePlanned: count,
  onsite: count,
  present: count,
  remaining: count,
  maxOnsite: count,
});

export const sessionRosterSchema = z.strictObject({
  classId: z.uuid(),
  sessionId: z.uuid(),
  // 이 회차가 속한 판매 단위 — 강사 앱 회원 관리 탭(I23)이 레벨 경로(계약 14 §6-1 `…/offerings/{offeringId}/member-levels`)를 부를 때 쓴다(S6-3.6)
  offeringId: z.uuid(),
  academyId: z.uuid(),
  title: z.string(),
  classKind: z.enum(CLASS_KINDS),
  seatMode: z.enum(SEAT_MODES),
  startsAt: isoInstant,
  endsAt: isoInstant,
  roomName: z.string().nullable(),
  sessionStatus: z.enum(["scheduled", "cancelled", "closed"]),
  seats: z.array(rosterSeatSchema),
  // 결제 대기 — 자리 종류별 **숫자만**. 이름·연락처·결제 수단 칸이 없다(Q20)
  awaitingPayment: z.strictObject({ male: count.optional(), female: count.optional(), any: count.optional() }),
  members: z.array(
    z.strictObject({
      memberId: z.uuid(),
      nickname: z.string(),
      gender: z.enum(GENDERS),
      ageBand: z.enum(AGE_BANDS),
      phoneMasked: z.string(),
      monthsEnrolled: z.number().int().positive(),
      absence: z.strictObject({ markedByKind: z.enum(["member", "instructor", "owner"]), markedAt: isoInstant }).nullable(),
    }),
  ),
});
export type SessionRoster = z.infer<typeof sessionRosterSchema>;

// ---- 읽기 도우미 ------------------------------------------------------------------------------

type Params = { params: Promise<{ classId: string; sessionId: string }> };

type SessionRow = {
  session_id: string;
  class_id: string;
  academy_id: string;
  offering_id: string;
  title: string;
  class_kind: string;
  seat_mode: string;
  status: string;
  starts_at: string;
  ends_at: string;
  room_name: string;
  /** 담당 강사 — 회차에 따로 정했으면 그 강사, 아니면 수업의 담당 강사(빈 글자 = 없음) */
  instructor_id: string;
};

export function createSessionRosterRoute(deps: SessionRosterDeps) {
  // 직원 세션 읽기(관리자 웹 쿠키면 2단계 인증까지)는 수업·결석 경로들과 같은 함수를 쓴다
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  // 시계는 부를 때 꺼낸다 — 앱 쪽 deps 의 clock 은 getter 라 import 시점에 읽으면 포트가 미리 만들어진다
  const clock: Clock = () => (deps.clock ?? systemClock)();

  /** ① 수업·회차가 이어져 있는지 함께 읽는다. 홀 이름은 회차의 홀, 없으면 수업의 기본 홀 */
  async function readSession(classId: string, sessionId: string): Promise<SessionRow | undefined> {
    const [row] = await db.query(
      db.raw.sql`SELECT s.id::text AS session_id, c.id::text AS class_id, c.academy_id::text AS academy_id, o.id::text AS offering_id,
                        c.title, c.class_kind::text AS class_kind, c.seat_mode::text AS seat_mode, s.status::text AS status,
                        to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS starts_at,
                        to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS ends_at,
                        COALESCE(rs.name, rc.name, '') AS room_name,
                        COALESCE(s.instructor_account_id::text, c.instructor_account_id::text, '') AS instructor_id
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 LEFT JOIN rooms rs ON rs.id = s.room_id
                 LEFT JOIN rooms rc ON rc.id = c.room_id
                 WHERE s.id = ${sessionId}::uuid AND c.id = ${classId}::uuid`
        .returnsRow({
          session_id: "pg/text@1",
          class_id: "pg/text@1",
          academy_id: "pg/text@1",
          offering_id: "pg/text@1",
          title: "pg/text@1",
          class_kind: "pg/text@1",
          seat_mode: "pg/text@1",
          status: "pg/text@1",
          starts_at: "pg/text@1",
          ends_at: "pg/text@1",
          room_name: "pg/text@1",
          instructor_id: "pg/text@1",
        })
        .build(),
    );
    return row;
  }

  /** ② 계약 §1-1 「§4 회차 명단」 줄 — 대표 ○ · 위임 강사(roster_manage) ○ · 담당 강사 ○ · 그 밖 403 */
  async function assertRosterReader(staff: StaffAccountContext, row: SessionRow): Promise<void> {
    if (staff.actor.ownedAcademyIds.includes(row.academy_id)) return;
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    // actor.delegations 는 active 소속에 매인 위임만 담는다 — 위임을 끄면 다음 요청부터 403(O-11)
    const delegated = (staff.actor.delegations[row.academy_id] ?? []).includes("roster_manage");
    const assigned = row.instructor_id !== "" && row.instructor_id === staff.staffAccountId;
    if (!delegated && !assigned) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    // 담당 강사도 지금 그 학원 active 소속이어야 한다
    const [affiliation] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${row.academy_id}::uuid AND instructor_account_id = ${staff.staffAccountId}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (affiliation === undefined) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
  }

  return withRoute<Params>(async (request, context) => {
    const staff = await readStaff(request);
    const ids = z.object({ classId: z.uuid(), sessionId: z.uuid() }).safeParse(await context.params);
    if (!ids.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const row = await readSession(ids.data.classId, ids.data.sessionId);
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    await assertRosterReader(staff, row);

    // ③ 읽기 전 정리 — 이 판매 단위의 기한 지난 결제 대기를 닫는다(자리 held_count 도 함께 돌려놓는다)
    await expireDuePayments({ db, clock, paymentGateway: deps.paymentGateway }, { offeringId: row.offering_id });

    // 자리 표 — 정원·잡힌 자리·확정 자리. 남·여·단일 순서로
    const pools = await db.query(
      db.raw.sql`SELECT seat_kind::text AS seat_kind, capacity::int4 AS capacity, held_count::int4 AS held, confirmed_count::int4 AS confirmed
                 FROM seat_pools WHERE offering_id = ${row.offering_id}::uuid
                 ORDER BY array_position(ARRAY['male', 'female', 'any'], seat_kind::text)`
        .returnsRow({ seat_kind: "pg/text@1", capacity: "pg/int4@1", held: "pg/int4@1", confirmed: "pg/int4@1" })
        .build(),
    );

    // 자리 종류별 결석 예정(결제 완료 수강생의 살아 있는 결석 행) · 결제 대기 인원(숫자만 — 이름 칸을 SELECT 하지 않는다)
    const absenceByKind = await db.query(
      db.raw.sql`SELECT r.seat_kind::text AS seat_kind, count(*)::int4 AS n
                 FROM attendance_marks a
                 JOIN reservations r ON r.id = a.reservation_id
                 JOIN orders o ON o.id = r.order_id
                 WHERE a.session_id = ${row.session_id}::uuid AND a.cancelled_at IS NULL
                   AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')
                 GROUP BY r.seat_kind`
        .returnsRow({ seat_kind: "pg/text@1", n: "pg/int4@1" })
        .build(),
    );
    const awaitingByKind = await db.query(
      db.raw.sql`SELECT r.seat_kind::text AS seat_kind, count(*)::int4 AS n
                 FROM reservations r JOIN orders o ON o.id = r.order_id
                 WHERE r.offering_id = ${row.offering_id}::uuid AND r.status = 'held' AND o.status = 'pending'
                 GROUP BY r.seat_kind`
        .returnsRow({ seat_kind: "pg/text@1", n: "pg/int4@1" })
        .build(),
    );
    // 이 회차의 현장 등록 인원(S3-5.4) — 숫자만 있는 표다. 한 번도 고치지 않았으면 행이 없어 0
    const onsiteByKind = await db.query(
      db.raw.sql`SELECT seat_kind::text AS seat_kind, onsite_count::int4 AS n
                 FROM session_seat_counters WHERE session_id = ${row.session_id}::uuid`
        .returnsRow({ seat_kind: "pg/text@1", n: "pg/int4@1" })
        .build(),
    );
    const countOf = (rows: readonly { seat_kind: string; n: number }[], kind: string) => rows.find((r) => r.seat_kind === kind)?.n ?? 0;

    // ④ 결제 완료 명단 — 전체 번호(phone)는 여기서 읽어 바로 아래에서 가린다. 첫 결제 시각은 이 학원 전체 주문에서(수강 개월 수)
    const members = await db.query(
      db.raw.sql`SELECT m.id::text AS id, m.nickname, m.gender::text AS gender, to_char(m.birth_date, 'YYYY-MM-DD') AS birth_date, m.phone,
                        COALESCE(a.marked_by_kind::text, '') AS marked_by_kind,
                        COALESCE(to_char(a.marked_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS marked_at,
                        COALESCE((SELECT to_char(min(COALESCE(p.paid_at, o2.paid_at)) AT TIME ZONE 'UTC', ${ISO_S_SQL})
                                  FROM orders o2
                                  JOIN class_offerings co2 ON co2.id = o2.offering_id
                                  JOIN classes c2 ON c2.id = co2.class_id
                                  LEFT JOIN payments p ON p.order_id = o2.id AND p.paid_at IS NOT NULL
                                  WHERE o2.member_id = m.id AND c2.academy_id = ${row.academy_id}::uuid
                                    AND o2.status IN ('paid', 'partially_refunded', 'refunded')), '') AS first_paid_at
                 FROM reservations r
                 JOIN orders o ON o.id = r.order_id
                 JOIN members m ON m.id = r.member_id
                 LEFT JOIN attendance_marks a ON a.reservation_id = r.id AND a.session_id = ${row.session_id}::uuid AND a.cancelled_at IS NULL
                 WHERE r.offering_id = ${row.offering_id}::uuid AND r.status = 'confirmed' AND o.status IN ('paid', 'partially_refunded')
                 ORDER BY (a.id IS NULL), m.nickname COLLATE "C", m.id`
        .returnsRow({
          id: "pg/text@1",
          nickname: "pg/text@1",
          gender: "pg/text@1",
          birth_date: "pg/text@1",
          phone: "pg/text@1",
          marked_by_kind: "pg/text@1",
          marked_at: "pg/text@1",
          first_paid_at: "pg/text@1",
        })
        .build(),
    );

    const startsAt = Temporal.Instant.from(row.starts_at);
    const today = toKstDate(clock());
    const awaitingPayment: SessionRoster["awaitingPayment"] = {};
    const seats = pools.map((pool) => {
      const kind = pool.seat_kind as SeatKind;
      awaitingPayment[kind] = countOf(awaitingByKind, kind);
      const absencePlanned = countOf(absenceByKind, kind);
      // 현장 등록 인원(S3-5.4 의 session_seat_counters)
      const onsite = countOf(onsiteByKind, kind);
      // 현장으로 더 받을 수 있는 상한 = 정원 − 잡힌 자리 − 확정 자리(계약 §6 규칙 1 의 식. 보강·동반자 자리는 M4·M6 에서 더 뺀다)
      const maxOnsite = Math.max(0, pool.capacity - pool.held - pool.confirmed);
      return {
        seatKind: kind,
        capacity: pool.capacity,
        appConfirmed: pool.confirmed,
        absencePlanned,
        onsite,
        present: computePresent(pool.confirmed, absencePlanned, onsite),
        remaining: Math.max(0, pool.capacity - pool.held - pool.confirmed - onsite),
        maxOnsite,
      };
    });

    const body: SessionRoster = {
      classId: row.class_id,
      sessionId: row.session_id,
      offeringId: row.offering_id,
      academyId: row.academy_id,
      title: row.title,
      classKind: row.class_kind as ClassKind,
      seatMode: row.seat_mode as SeatMode,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      roomName: row.room_name === "" ? null : row.room_name,
      sessionStatus: row.status as SessionRoster["sessionStatus"],
      seats,
      awaitingPayment,
      members: members.map((m) => ({
        memberId: m.id,
        nickname: m.nickname,
        gender: m.gender as Gender,
        ageBand: ageBandOf(Temporal.PlainDate.from(m.birth_date), today),
        // 가운데 네 자리를 가린 번호만 응답에 싣는다 — 원래 번호는 이 줄 밖으로 나가지 않는다(FR-187 · FR-299)
        phoneMasked: maskPhone(m.phone),
        // 결제 완료 명단이라 첫 결제 시각이 늘 있다. 혹시 없으면(데이터가 깨진 경우) 이 회차 달을 첫 달로 본다
        monthsEnrolled: countEnrolledMonths(m.first_paid_at === "" ? startsAt : Temporal.Instant.from(m.first_paid_at), startsAt),
        absence:
          m.marked_by_kind === ""
            ? null
            : { markedByKind: m.marked_by_kind as "member" | "instructor" | "owner", markedAt: m.marked_at },
      })),
    };
    // 계약 스키마로 한 번 더 검사한다 — 대기자 이름이나 전체 번호 같은 칸이 섞여 나가면 여기서 막힌다
    return Response.json(sessionRosterSchema.parse(body), { headers: NO_STORE });
  });
}
