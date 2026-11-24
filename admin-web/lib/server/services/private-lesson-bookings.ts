// S2-4.7(개인 레슨 규칙·수강생·회차 API) — 강사가 수강생 수강권을 보고(I20) 다음 회차를 잡고, 바꾸고, 취소한다(I20B).
//   계약: _workspace/03_contracts/11-instructor.md §0(affiliated) · §10-3(수강생 · 회차) · 수용 시나리오 12
//   경로: GET  /api/instructor/private-lesson-passes/{passId}
//         POST /api/instructor/private-lesson-passes/{passId}/bookings          (헤더 Idempotency-Key 필수)
//         POST /api/instructor/private-lesson-bookings/{bookingId}/reschedule
//         POST /api/instructor/private-lesson-bookings/{bookingId}/cancel
//   데이터: data-model §8-6 private_lesson_slots · _passes · _bookings
//
// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — 수강생별 수강권 목록을 더했다(보드 I10):
//   GET  /api/instructor/private-lesson-passes?academyId=&status=
//   항목 모양은 상세(I20)의 앞부분과 같다(privateLessonPassItemSchema) — 상세는 거기에 결제·규칙·회차·열린 시간을 더한다.
//   남은 횟수·다음 회차 셈을 두 벌 두지 않으려고 목록과 상세가 같은 함수(toPassItem)로 칸을 채운다.
//
// 누가 부를 수 있나: 그 수강권을 판 **상품을 연 강사 본인** + 그 학원 active 소속(11 §0 affiliated).
//   남의 수강권이면 404(있는지조차 알려 주지 않는다). 대표 계정은 자기 학원이어도 403 — 개인 레슨 경로에는 대표 몫이 없다(FR-052c).
//
// 회차 취소의 핵심: 차감 여부는 S2-4.3 의 순수 함수 decidePrivateLessonCancel 이 정한다. 이 파일은 그 판정을 DB 에 옮길 뿐이다.
//   기한(시간)은 **수강권에 고정된 규칙 판본**에서 읽는다 — 강사가 나중에 규칙을 바꿔도 이미 결제한 수강권은 결제 때 규칙을 따른다.
//
// 세 쓰기 경로 모두 한 트랜잭션에서 수강권 행을 먼저 잠근다(FOR UPDATE). 같은 수강권에 회차 잡기·취소가 겹쳐도
// 「남은 횟수」 셈이 엇갈리지 않게 하려는 것이다. 시간(slot) 쪽은 조건부 갱신(status = 'open' 일 때만)과
// uq_pl_booking_slot_live(한 시간에 살아 있는 레슨 하나)가 겹침을 막는다.
import { z } from "zod";

import { decidePrivateLessonCancel } from "../../domain/private-lesson-cancel";
import { systemClock, type Clock } from "../../domain/time";
import type { GuardDeps } from "../guards";
import { PRIVATE_LESSON_PASS_STATUSES } from "../../domain/constants";
import { HttpError, parseJsonBody, parseWith, readIdempotencyKey, withRoute } from "../http";
import { createClassAccess } from "./class-registration";
import type { Tx } from "./staff-signup";
import type { Db } from "../../../prisma/db";

// ---- 정해 둔 값 ------------------------------------------------------------------------------

/** 감사 action 값(data-model §8-7 audit_logs.action(M2)) */
export const PRIVATE_LESSON_BOOKING_CANCELLED_AUDIT_ACTION = "private_lesson_booking.cancelled";
/** 회차를 먹은(번호를 매기는) 예약 상태 — 강사 일정(S2-4.5)의 sessionNo 와 같은 기준 */
const COUNTED_BOOKING_STATUSES = "booked,done,no_show,cancelled_member_late";
/** 강사 사정 취소 사유의 길이 상한(회원에게 그대로 보이는 한 줄 — **추천값**) */
const CANCEL_REASON_MAX = 200;

const DETAIL = {
  forbidden: "강사 계정으로만 개인 레슨 회차를 다룰 수 있어요",
  affiliation: "소속된 학원의 개인 레슨만 다룰 수 있어요",
  passNotFound: "수강권을 찾을 수 없어요",
  bookingNotFound: "회차를 찾을 수 없어요",
  slotNotFound: "이 수강권 상품의 「레슨 모집」 시간이 아니에요",
  slotNotOpen: "그 시간은 이미 예약됐거나 닫혔어요",
  passNotActive: "결제를 마친 사용 중인 수강권에서만 회차를 잡을 수 있어요",
  passNoRemaining: "이 수강권에는 더 잡을 회차가 없어요",
  afterExpiry: "수강권 사용 기한이 지난 시간이에요",
  bookingState: "이미 지나갔거나 끝난 회차는 바꾸거나 취소할 수 없어요",
  validation: "입력값을 확인해 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
// UUID 모양(버전 무관). 모양이 틀린 id 를 DB 에 넘기면 형 변환 오류(500)가 나므로 미리 「없음」(404)으로 답한다
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- 요청·응답 계약(11 §10-3) -----------------------------------------------------------------

export const bookSlotRequestSchema = z.strictObject({ slotId: z.uuid() });

/** 취소 요청 — 강사 사정(사유 필수, 회원에게 보인다) 또는 회원 요청(강사가 기록) */
export const cancelBookingRequestSchema = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("instructor"), reason: z.string().trim().min(1).max(CANCEL_REASON_MAX) }),
  z.strictObject({ by: z.literal("member"), reason: z.string().trim().min(1).max(CANCEL_REASON_MAX).optional() }),
]);

const BOOKING_STATUSES = ["booked", "done", "cancelled_instructor", "cancelled_member_free", "cancelled_member_late", "no_show"] as const;

/** I10 목록 한 줄 = I20 상세의 앞부분(11 §10-3 「GET …/private-lesson-passes?status=active 항목」) */
const passItemShape = {
  passId: z.uuid(),
  academyId: z.uuid(),
  academyName: z.string(),
  productClassId: z.uuid(),
  lessonMinutes: z.int(),
  student: z.strictObject({ displayName: z.string() }).nullable(),
  nameVisible: z.boolean(),
  discipline: z.string().nullable(),
  status: z.enum(["pending_payment", "active", "completed", "expired", "refunded"]),
  sessionsTotal: z.int(),
  sessionsUsed: z.int(),
  remainingSessions: z.int(),
  paidAt: z.string().nullable(),
  validUntil: z.string().nullable(),
  nextBooking: z
    .strictObject({ bookingId: z.uuid(), startsAt: z.string(), endsAt: z.string(), sessionNo: z.int(), state: z.literal("booked") })
    .nullable(),
  awaitingPayment: z.strictObject({ until: z.string().nullable() }).nullable(),
};
export const privateLessonPassItemSchema = z.strictObject(passItemShape);
export type PrivateLessonPassItem = z.infer<typeof privateLessonPassItemSchema>;
export const privateLessonPassListSchema = z.strictObject({ items: z.array(privateLessonPassItemSchema) });

/** 목록 거르기 — 학원(고르면 그 학원 소속이어야 한다) · 수강권 상태(I10 「사용 중」 탭이면 active) */
const passListQuerySchema = z.strictObject({
  academyId: z.uuid().optional(),
  status: z.enum(PRIVATE_LESSON_PASS_STATUSES).optional(),
});

export const privateLessonPassDetailSchema = z.strictObject({
  ...passItemShape,
  // 결제 읽기 값. 주문 ↔ 개인 레슨 연결은 M3 가 붙인다(열린 점 ⑫) — 그 전에는 결제 수단을 알 수 없어 method 가 null 이다
  payment: z.strictObject({ paidAt: z.string(), method: z.string().nullable(), amount: z.int() }).nullable(),
  rule: z.strictObject({ version: z.int(), changeDeadlineHours: z.int(), validityMonths: z.int() }),
  bookings: z.array(
    z.strictObject({
      bookingId: z.uuid(),
      slotId: z.uuid(),
      startsAt: z.string(),
      endsAt: z.string(),
      status: z.enum(BOOKING_STATUSES),
      deducted: z.boolean(),
    }),
  ),
  openSlots: z.array(
    z.strictObject({ slotId: z.uuid(), startsAt: z.string(), endsAt: z.string(), roomName: z.string().nullable() }),
  ),
});
export type PrivateLessonPassDetail = z.infer<typeof privateLessonPassDetailSchema>;

export const bookSlotResponseSchema = z.strictObject({
  bookingId: z.uuid(),
  slotId: z.uuid(),
  status: z.literal("booked"),
  remainingToBook: z.int(),
});

export const rescheduleResponseSchema = z.strictObject({
  bookingId: z.uuid(),
  slotId: z.uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.literal("booked"),
});

export const cancelBookingResponseSchema = z.strictObject({
  bookingId: z.uuid(),
  status: z.enum(["cancelled_instructor", "cancelled_member_free", "cancelled_member_late"]),
  deducted: z.boolean(),
  sessionsUsed: z.int(),
  remainingSessions: z.int(),
});

export type PrivateLessonBookingDeps = GuardDeps & { clock?: Clock };
type PassParams = { params: Promise<{ passId: string }> };
type BookingParams = { params: Promise<{ bookingId: string }> };

// ---- DB 읽기 ----------------------------------------------------------------------------------

/** 수강권 하나의 판정용 사실. 상품을 연 강사가 me 가 아니면 null(남의 수강권은 없는 것과 같다) */
async function loadPass(db: Db | Tx, passId: string, me: string, lock: boolean) {
  const query = lock
    ? db.raw.sql`SELECT p.id, p.product_class_id, p.status, p.sessions_total, p.sessions_used, p.member_id,
                        COALESCE(to_char(p.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS valid_until,
                        c.academy_id, r.change_deadline_hours
                 FROM private_lesson_passes p
                 JOIN classes c ON c.id = p.product_class_id
                 JOIN private_lesson_rule_versions r ON r.id = p.rule_version_id
                 WHERE p.id = ${passId}::uuid AND c.instructor_account_id = ${me}::uuid
                 FOR UPDATE OF p`
    : db.raw.sql`SELECT p.id, p.product_class_id, p.status, p.sessions_total, p.sessions_used, p.member_id,
                        COALESCE(to_char(p.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS valid_until,
                        c.academy_id, r.change_deadline_hours
                 FROM private_lesson_passes p
                 JOIN classes c ON c.id = p.product_class_id
                 JOIN private_lesson_rule_versions r ON r.id = p.rule_version_id
                 WHERE p.id = ${passId}::uuid AND c.instructor_account_id = ${me}::uuid`;
  const [row] = await db.query(
    query
      .returnsRow({
        id: "pg/uuid@1",
        product_class_id: "pg/uuid@1",
        status: "pg/text@1",
        sessions_total: "pg/int4@1",
        sessions_used: "pg/int4@1",
        member_id: "pg/uuid@1",
        valid_until: "pg/text@1",
        academy_id: "pg/uuid@1",
        change_deadline_hours: "pg/int4@1",
      })
      .build(),
  );
  return row ?? null;
}

/** 회차 하나 → 그 수강권 id(상품을 연 강사가 me 일 때만) */
async function findBookingPassId(db: Db, bookingId: string, me: string): Promise<string | null> {
  const [row] = await db.query(
    db.raw.sql`SELECT b.pass_id FROM private_lesson_bookings b
               JOIN private_lesson_passes p ON p.id = b.pass_id
               JOIN classes c ON c.id = p.product_class_id
               WHERE b.id = ${bookingId}::uuid AND c.instructor_account_id = ${me}::uuid`
      .returnsRow({ pass_id: "pg/uuid@1" })
      .build(),
  );
  return row?.pass_id ?? null;
}

/** 회차 하나와 그 시간. 수강권을 잠근 뒤 부르므로 같은 트랜잭션 안의 최신 값이다 */
async function loadBooking(tx: Tx, bookingId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT b.id, b.status, b.deducted, b.slot_id,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
               FROM private_lesson_bookings b JOIN private_lesson_slots sl ON sl.id = b.slot_id
               WHERE b.id = ${bookingId}::uuid
               FOR UPDATE OF b`
      .returnsRow({
        id: "pg/uuid@1",
        status: "pg/text@1",
        deducted: "pg/bool@1",
        slot_id: "pg/uuid@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
      })
      .build(),
  );
  return row ?? null;
}

/**
 * 새로 잡거나 옮겨 갈 시간을 잠그고 읽는다. 같은 상품의 시간이 아니면 null.
 * 잠근 뒤 상태를 보므로, 동시에 다른 수강권이 같은 시간을 잡으면 뒤에 온 쪽은 booked 를 보고 SLOT_NOT_OPEN 이 된다
 */
async function lockSlot(tx: Tx, slotId: string, productClassId: string) {
  const [row] = await tx.query(
    tx.raw.sql`SELECT id, status,
                      to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
               FROM private_lesson_slots
               WHERE id = ${slotId}::uuid AND product_class_id = ${productClassId}::uuid
               FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1", status: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1" })
      .build(),
  );
  return row ?? null;
}

/**
 * 시간을 잡을 수 있나 — 열려 있고(open), 아직 시작 전이고, 수강권 사용 기한 안에서 끝난다.
 * 지난 시간은 「이미 닫힌 시간」과 같은 409 로 답한다(회원에게도 더는 보이지 않는 시간이라서).
 */
function assertBookable(slot: { status: string; starts_at: string; ends_at: string }, validUntil: string, now: Temporal.Instant): void {
  if (slot.status !== "open") throw HttpError.conflict("SLOT_NOT_OPEN", DETAIL.slotNotOpen);
  if (Temporal.Instant.compare(Temporal.Instant.from(slot.starts_at), now) <= 0) {
    throw HttpError.conflict("SLOT_NOT_OPEN", DETAIL.slotNotOpen);
  }
  if (validUntil !== "" && Temporal.Instant.compare(Temporal.Instant.from(slot.ends_at), Temporal.Instant.from(validUntil)) > 0) {
    throw HttpError.unprocessable("SLOT_AFTER_PASS_EXPIRY", DETAIL.afterExpiry);
  }
}

/** 지금 「booked」로 살아 있는 회차 수 — 남은 횟수에서 이것까지 빼야 「더 잡을 수 있는 수」다 */
async function countLiveBookings(tx: Tx, passId: string): Promise<number> {
  const [row] = await tx.query(
    tx.raw.sql`SELECT count(*)::int AS n FROM private_lesson_bookings WHERE pass_id = ${passId}::uuid AND status = 'booked'`
      .returnsRow({ n: "pg/int4@1" })
      .build(),
  );
  return row?.n ?? 0;
}

/**
 * 수강권 회원에게 알림 1행(발송은 S7-1 몫이라 pending 으로 쌓기만 한다). 열쇠가 같으면 두 번 쓰지 않는다 —
 * 같은 요청이 다시 와도 회원이 알림을 두 번 받지 않게 하려는 것이다(uq_notifications_dedupe).
 */
async function notifyMember(
  tx: Tx,
  input: { memberId: string; academyId: string; kind: "private_lesson_booked" | "private_lesson_cancelled"; dedupeKey: string; payload: Record<string, unknown> },
): Promise<void> {
  await tx.execute(
    tx.raw.sql`INSERT INTO notifications (id, recipient_member_id, academy_id, kind, dedupe_key, payload)
               VALUES (uuidv7(), ${input.memberId}::uuid, ${input.academyId}::uuid, ${input.kind}, ${input.dedupeKey},
                       ${JSON.stringify(input.payload)}::jsonb)
               ON CONFLICT DO NOTHING`
      .affectedCount()
      .build(),
  );
}

/** I20 수강생 상세 — 목록 칸 + 결제 · 규칙 · 회차 · 다음 회차 후보(열린 시간) */
async function readPassDetail(db: Db, passId: string, now: Temporal.Instant): Promise<PrivateLessonPassDetail> {
  const [p] = await db.query(
    db.raw.sql`SELECT p.id, c.academy_id, a.name AS academy_name, p.product_class_id, pr.lesson_minutes, pr.price_amount,
                      m.name AS student_name, COALESCE(p.discipline, '') AS discipline, p.status,
                      p.sessions_total, p.sessions_used,
                      COALESCE(to_char(p.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS paid_at,
                      COALESCE(to_char(p.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS valid_until,
                      r.version, r.change_deadline_hours, r.validity_months
               FROM private_lesson_passes p
               JOIN private_lesson_products pr ON pr.class_id = p.product_class_id
               JOIN classes c ON c.id = p.product_class_id
               JOIN academies a ON a.id = c.academy_id
               JOIN members m ON m.id = p.member_id
               JOIN private_lesson_rule_versions r ON r.id = p.rule_version_id
               WHERE p.id = ${passId}::uuid`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        product_class_id: "pg/uuid@1",
        lesson_minutes: "pg/int4@1",
        price_amount: "pg/int4@1",
        student_name: "pg/text@1",
        discipline: "pg/text@1",
        status: "pg/text@1",
        sessions_total: "pg/int4@1",
        sessions_used: "pg/int4@1",
        paid_at: "pg/text@1",
        valid_until: "pg/text@1",
        version: "pg/int4@1",
        change_deadline_hours: "pg/int4@1",
        validity_months: "pg/int4@1",
      })
      .build(),
  );
  if (p === undefined) throw new HttpError("NOT_FOUND", DETAIL.passNotFound);

  // 이 수강권의 회차 전부(시작 시각 순). session_no 는 회차를 먹은 예약 중 몇째인지(강사 일정과 같은 셈)
  const bookings = await db.query(
    db.raw.sql`SELECT b.id, b.slot_id, b.status, b.deducted,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      (SELECT count(*) FROM private_lesson_bookings b2 JOIN private_lesson_slots s2 ON s2.id = b2.slot_id
                       WHERE b2.pass_id = b.pass_id
                         AND b2.status = ANY(string_to_array(${COUNTED_BOOKING_STATUSES}, ','))
                         AND (s2.starts_at, b2.id) <= (sl.starts_at, b.id))::int AS session_no
               FROM private_lesson_bookings b JOIN private_lesson_slots sl ON sl.id = b.slot_id
               WHERE b.pass_id = ${passId}::uuid
               ORDER BY sl.starts_at, b.id`
      .returnsRow({
        id: "pg/uuid@1",
        slot_id: "pg/uuid@1",
        status: "pg/text@1",
        deducted: "pg/bool@1",
        starts_at: "pg/text@1",
        ends_at: "pg/text@1",
        session_no: "pg/int4@1",
      })
      .build(),
  );

  // 다음 회차 후보 = 같은 상품의 열린 시간 중 아직 시작 전이고, 사용 기한이 있으면 그 안에서 끝나는 것
  const openSlots = await db.query(
    db.raw.sql`SELECT sl.id, COALESCE(rm.name, '') AS room_name,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at
               FROM private_lesson_slots sl LEFT JOIN rooms rm ON rm.id = sl.room_id
               WHERE sl.product_class_id = ${p.product_class_id}::uuid AND sl.status = 'open'
                 AND sl.starts_at > ${now.toString()}::timestamptz
                 AND (${p.valid_until} = '' OR sl.ends_at <= NULLIF(${p.valid_until}, '')::timestamptz)
               ORDER BY sl.starts_at`
      .returnsRow({ id: "pg/uuid@1", room_name: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1" })
      .build(),
  );

  return privateLessonPassDetailSchema.parse({
    ...toPassItem(p, bookings, now),
    payment: p.paid_at === "" ? null : { paidAt: p.paid_at, method: null, amount: p.price_amount },
    rule: { version: p.version, changeDeadlineHours: p.change_deadline_hours, validityMonths: p.validity_months },
    bookings: bookings.map((b) => ({
      bookingId: b.id,
      slotId: b.slot_id,
      startsAt: b.starts_at,
      endsAt: b.ends_at,
      status: b.status,
      deducted: b.deducted,
    })),
    openSlots: openSlots.map((s) => ({ slotId: s.id, startsAt: s.starts_at, endsAt: s.ends_at, roomName: s.room_name === "" ? null : s.room_name })),
  });
}

type PassRowForItem = {
  id: string;
  academy_id: string;
  academy_name: string;
  product_class_id: string;
  lesson_minutes: number;
  student_name: string;
  discipline: string;
  status: string;
  sessions_total: number;
  sessions_used: number;
  paid_at: string;
  valid_until: string;
};
type BookingRowForItem = { id: string; status: string; starts_at: string; ends_at: string; session_no: number };

/**
 * 수강권 한 장의 목록 칸(I10)을 채운다 — 목록과 상세(I20)가 같이 쓴다.
 * 다음 회차 = 아직 끝나지 않은 booked 회차 중 가장 이른 것(bookings 는 시작 시각 순으로 받는다).
 */
function toPassItem(p: PassRowForItem, bookings: readonly BookingRowForItem[], now: Temporal.Instant): PrivateLessonPassItem {
  const next = bookings.find((b) => b.status === "booked" && Temporal.Instant.compare(Temporal.Instant.from(b.ends_at), now) > 0);
  return {
    passId: p.id,
    academyId: p.academy_id,
    academyName: p.academy_name,
    productClassId: p.product_class_id,
    lessonMinutes: p.lesson_minutes,
    // 수강생 이름은 결제 대기여도 보인다(수용 ④). 멤버십 끝 → 숨김은 S6-1 이 판정 함수를 줄 때 붙는다(그 전에는 늘 보임)
    student: { displayName: p.student_name },
    nameVisible: true,
    discipline: p.discipline === "" ? null : p.discipline,
    status: p.status as PrivateLessonPassItem["status"],
    sessionsTotal: p.sessions_total,
    sessionsUsed: p.sessions_used,
    remainingSessions: p.sessions_total - p.sessions_used,
    paidAt: p.paid_at === "" ? null : p.paid_at,
    validUntil: p.valid_until === "" ? null : p.valid_until,
    nextBooking:
      next === undefined
        ? null
        : { bookingId: next.id, startsAt: next.starts_at, endsAt: next.ends_at, sessionNo: next.session_no, state: "booked" },
    // 결제 대기의 마감 시각은 M3 의 주문 만료가 정한다(열린 점 ⑫) — 그 전에는 「결제 대기」라는 사실만 준다
    awaitingPayment: p.status === "pending_payment" ? { until: null } : null,
  };
}

/**
 * I10 수강생 목록 — 내가 연 상품의 수강권 중 **지금 active 로 소속된 학원** 것만(11 §0 affiliated).
 * 연락처·결제 수단은 목록에 없다(계약 §10-3). 정렬: 결제 대기·사용 중을 위로, 그 안에서는 최근에 산 것부터.
 * 다음 회차는 살아 있는(booked) 회차만 한 번에 읽어 수강권별로 나눈다(수강권마다 따로 읽지 않는다).
 */
async function readPassList(
  db: Db,
  me: string,
  filter: { academyId: string | null; status: string | null },
  now: Temporal.Instant,
): Promise<PrivateLessonPassItem[]> {
  const passes = await db.query(
    db.raw.sql`SELECT p.id, c.academy_id, a.name AS academy_name, p.product_class_id, pr.lesson_minutes,
                      m.name AS student_name, COALESCE(p.discipline, '') AS discipline, p.status,
                      p.sessions_total, p.sessions_used,
                      COALESCE(to_char(p.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS paid_at,
                      COALESCE(to_char(p.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '') AS valid_until
               FROM private_lesson_passes p
               JOIN private_lesson_products pr ON pr.class_id = p.product_class_id
               JOIN classes c ON c.id = p.product_class_id
               JOIN academies a ON a.id = c.academy_id
               JOIN members m ON m.id = p.member_id
               WHERE c.instructor_account_id = ${me}::uuid
                 AND (${filter.academyId ?? ""} = '' OR c.academy_id = NULLIF(${filter.academyId ?? ""}, '')::uuid)
                 AND (${filter.status ?? ""} = '' OR p.status = ${filter.status ?? ""})
                 AND EXISTS (SELECT 1 FROM instructor_affiliations f
                             WHERE f.academy_id = c.academy_id AND f.instructor_account_id = ${me}::uuid AND f.status = 'active')
               ORDER BY (p.status IN ('pending_payment', 'active')) DESC, p.created_at DESC, p.id`
      .returnsRow({
        id: "pg/uuid@1",
        academy_id: "pg/uuid@1",
        academy_name: "pg/text@1",
        product_class_id: "pg/uuid@1",
        lesson_minutes: "pg/int4@1",
        student_name: "pg/text@1",
        discipline: "pg/text@1",
        status: "pg/text@1",
        sessions_total: "pg/int4@1",
        sessions_used: "pg/int4@1",
        paid_at: "pg/text@1",
        valid_until: "pg/text@1",
      })
      .build(),
  );
  if (passes.length === 0) return [];

  // 살아 있는 회차 + 회차 번호(상세와 같은 셈 — 회차를 먹은 예약 중 몇째인지)
  const passIds = passes.map((p) => p.id).join(",");
  const live = await db.query(
    db.raw.sql`SELECT b.id, b.pass_id, b.status,
                      to_char(sl.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
                      to_char(sl.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
                      (SELECT count(*) FROM private_lesson_bookings b2 JOIN private_lesson_slots s2 ON s2.id = b2.slot_id
                       WHERE b2.pass_id = b.pass_id
                         AND b2.status = ANY(string_to_array(${COUNTED_BOOKING_STATUSES}, ','))
                         AND (s2.starts_at, b2.id) <= (sl.starts_at, b.id))::int AS session_no
               FROM private_lesson_bookings b JOIN private_lesson_slots sl ON sl.id = b.slot_id
               WHERE b.pass_id = ANY(string_to_array(${passIds}, ',')::uuid[]) AND b.status = 'booked'
               ORDER BY sl.starts_at, b.id`
      .returnsRow({ id: "pg/uuid@1", pass_id: "pg/uuid@1", status: "pg/text@1", starts_at: "pg/text@1", ends_at: "pg/text@1", session_no: "pg/int4@1" })
      .build(),
  );
  return passes.map((p) =>
    privateLessonPassItemSchema.parse(toPassItem(p, live.filter((b) => b.pass_id === p.id), now)),
  );
}

// ---- 경로 ----------------------------------------------------------------------------------------

export function createPrivateLessonBookingRoutes(deps: PrivateLessonBookingDeps) {
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  /** 강사 역할 확인 → 내 계정 id. 대표만 있는 계정은 여기서 403 */
  async function requireInstructor(request: Request): Promise<string> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.forbidden);
    return staff.staffAccountId;
  }

  /** 그 학원에 지금 active 로 소속돼 있나(11 §0 affiliated). 아니면 403 AFFILIATION_REQUIRED */
  async function assertAffiliated(academyId: string, me: string): Promise<void> {
    const [row] = await db.query(
      db.raw.sql`SELECT id FROM instructor_affiliations
                 WHERE academy_id = ${academyId}::uuid AND instructor_account_id = ${me}::uuid AND status = 'active'`
        .returnsRow({ id: "pg/uuid@1" })
        .build(),
    );
    if (row === undefined) throw HttpError.forbidden("AFFILIATION_REQUIRED", DETAIL.affiliation);
  }

  /** 수강권 id → (내 것인지 · 소속인지) 확인. 순서: 모양(404) → 내 수강권(404) → 소속(403) */
  async function requireMyPass(passId: string, me: string) {
    if (!UUID_PATTERN.test(passId)) throw new HttpError("NOT_FOUND", DETAIL.passNotFound);
    const pass = await loadPass(db, passId, me, false);
    if (pass === null) throw new HttpError("NOT_FOUND", DETAIL.passNotFound);
    await assertAffiliated(pass.academy_id, me);
    return pass;
  }

  /** 회차 id → 그 수강권(내 것 · 소속). 남의 회차면 404 */
  async function requireMyBooking(bookingId: string, me: string) {
    if (!UUID_PATTERN.test(bookingId)) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);
    const passId = await findBookingPassId(db, bookingId, me);
    if (passId === null) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);
    return requireMyPass(passId, me);
  }

  /** GET — 수강생별 수강권 목록(I10). 학원을 고르면 그 학원 소속이어야 한다(아니면 403) */
  const listPasses = withRoute<unknown>(async (request) => {
    const me = await requireInstructor(request);
    const query = parseWith(passListQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    if (query.academyId !== undefined) await assertAffiliated(query.academyId, me);
    const items = await readPassList(db, me, { academyId: query.academyId ?? null, status: query.status ?? null }, clock());
    return Response.json(privateLessonPassListSchema.parse({ items }), { headers: NO_STORE });
  });

  /** GET — 수강생 상세(I20) */
  const getPass = withRoute<PassParams>(async (request, context) => {
    const me = await requireInstructor(request);
    const pass = await requireMyPass((await context.params).passId, me);
    return Response.json(await readPassDetail(db, pass.id, clock()), { headers: NO_STORE });
  });

  /**
   * POST — 다음 회차 잡기. 201 + 남은 「잡을 수 있는 수」.
   * 같은 시간이 이미 이 수강권의 booked 회차면 200 + 그 회차(같은 요청의 재전송). 예약 표에 키 칸이 없어(data-model §8-6)
   * 「(수강권, 시간)이 이미 잡혀 있다」가 멱등의 근거다 — Idempotency-Key 는 계약대로 필수로 받기만 한다.
   */
  const book = withRoute<PassParams>(async (request, context) => {
    const me = await requireInstructor(request);
    readIdempotencyKey(request, { required: true });
    const { passId } = await context.params;
    await requireMyPass(passId, me);
    const input = await parseJsonBody(request, bookSlotRequestSchema);
    const now = clock();

    const result = await db.transaction(async (tx) => {
      const pass = await loadPass(tx, passId, me, true);
      if (pass === null) throw new HttpError("NOT_FOUND", DETAIL.passNotFound);

      // 재전송: 같은 시간에 이 수강권의 살아 있는 회차가 이미 있다
      const [existing] = await tx.query(
        tx.raw.sql`SELECT id FROM private_lesson_bookings WHERE pass_id = ${passId}::uuid AND slot_id = ${input.slotId}::uuid AND status = 'booked'`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      const live = await countLiveBookings(tx, passId);
      const remainingToBook = pass.sessions_total - pass.sessions_used - live;
      if (existing !== undefined) return { status: 200, body: { bookingId: existing.id, slotId: input.slotId, status: "booked" as const, remainingToBook } };

      // 결제 전·만료·환불·다 쓴 수강권 → PASS_NOT_ACTIVE. 남은 횟수를 이미 다 잡았으면 PASS_NO_REMAINING
      if (pass.status !== "active") throw HttpError.conflict("PASS_NOT_ACTIVE", DETAIL.passNotActive);
      if (remainingToBook <= 0) throw HttpError.conflict("PASS_NO_REMAINING", DETAIL.passNoRemaining);

      const slot = await lockSlot(tx, input.slotId, pass.product_class_id);
      if (slot === null) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "slotId", message: DETAIL.slotNotFound }] });
      assertBookable(slot, pass.valid_until, now);

      // 시간을 닫고(booked) 회차를 만든다. 조건부 갱신이라 잠금을 피해 들어온 경쟁이 있어도 한쪽만 이긴다
      const changed = await tx.execute(
        tx.raw.sql`UPDATE private_lesson_slots SET status = 'booked' WHERE id = ${slot.id}::uuid AND status = 'open'`.affectedCount().build(),
      );
      if (changed.affectedRows !== 1) throw HttpError.conflict("SLOT_NOT_OPEN", DETAIL.slotNotOpen);
      const [created] = await tx.query(
        tx.raw.sql`INSERT INTO private_lesson_bookings (id, pass_id, slot_id, status, booked_by, deducted, updated_at)
                   VALUES (uuidv7(), ${passId}::uuid, ${slot.id}::uuid, 'booked', 'instructor', false, now())
                   RETURNING id`
          .returnsRow({ id: "pg/uuid@1" })
          .build(),
      );
      if (created === undefined) throw new Error("개인 레슨 회차를 쓰지 못했다");

      await notifyMember(tx, {
        memberId: pass.member_id,
        academyId: pass.academy_id,
        kind: "private_lesson_booked",
        dedupeKey: `private_lesson_booking:${created.id}:booked`,
        payload: { change: "booked", passId, bookingId: created.id, slotId: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at },
      });
      return { status: 201, body: { bookingId: created.id, slotId: slot.id, status: "booked" as const, remainingToBook: remainingToBook - 1 } };
    });
    return Response.json(bookSlotResponseSchema.parse(result.body), { status: result.status, headers: NO_STORE });
  });

  /**
   * POST — 회차 시간 바꾸기(I20B). 같은 회차(행)가 다른 「레슨 모집」 시간으로 옮겨 가고 차감은 없다. 옛 시간은 다시 open.
   * 이미 그 시간으로 옮겨 있으면 200 같은 본문(재전송). 취소됐거나 끝난 회차는 409 BOOKING_STATE_CONFLICT.
   */
  const reschedule = withRoute<BookingParams>(async (request, context) => {
    const me = await requireInstructor(request);
    const { bookingId } = await context.params;
    const passRow = await requireMyBooking(bookingId, me);
    const input = await parseJsonBody(request, bookSlotRequestSchema);
    const now = clock();

    const body = await db.transaction(async (tx) => {
      const pass = await loadPass(tx, passRow.id, me, true);
      if (pass === null) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);
      const booking = await loadBooking(tx, bookingId);
      if (booking === null) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);
      if (booking.status !== "booked") throw HttpError.conflict("BOOKING_STATE_CONFLICT", DETAIL.bookingState);
      if (booking.slot_id === input.slotId) {
        return { bookingId, slotId: booking.slot_id, startsAt: booking.starts_at, endsAt: booking.ends_at, status: "booked" as const };
      }
      // 이미 시작한 회차는 옮기지 않는다(지난 레슨의 시간을 바꾸면 기록이 어긋난다)
      if (Temporal.Instant.compare(Temporal.Instant.from(booking.starts_at), now) <= 0) {
        throw HttpError.conflict("BOOKING_STATE_CONFLICT", DETAIL.bookingState);
      }

      const slot = await lockSlot(tx, input.slotId, pass.product_class_id);
      if (slot === null) throw new HttpError("VALIDATION_FAILED", DETAIL.validation, { fields: [{ path: "slotId", message: DETAIL.slotNotFound }] });
      assertBookable(slot, pass.valid_until, now);

      // 새 시간 닫기 → 옛 시간 열기 → 회차가 새 시간을 가리키게. 순서를 지켜야 uq_pl_booking_slot_live 가 늘 맞는다
      const taken = await tx.execute(
        tx.raw.sql`UPDATE private_lesson_slots SET status = 'booked' WHERE id = ${slot.id}::uuid AND status = 'open'`.affectedCount().build(),
      );
      if (taken.affectedRows !== 1) throw HttpError.conflict("SLOT_NOT_OPEN", DETAIL.slotNotOpen);
      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_slots SET status = 'open' WHERE id = ${booking.slot_id}::uuid AND status = 'booked'`.affectedCount().build(),
      );
      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_bookings SET slot_id = ${slot.id}::uuid, updated_at = now() WHERE id = ${bookingId}::uuid`
          .affectedCount()
          .build(),
      );
      await notifyMember(tx, {
        memberId: pass.member_id,
        academyId: pass.academy_id,
        kind: "private_lesson_booked",
        dedupeKey: `private_lesson_booking:${bookingId}:rescheduled:${slot.id}`,
        payload: {
          change: "rescheduled",
          passId: pass.id,
          bookingId,
          slotId: slot.id,
          startsAt: slot.starts_at,
          endsAt: slot.ends_at,
          previous: { startsAt: booking.starts_at, endsAt: booking.ends_at },
        },
      });
      return { bookingId, slotId: slot.id, startsAt: slot.starts_at, endsAt: slot.ends_at, status: "booked" as const };
    });
    return Response.json(rescheduleResponseSchema.parse(body), { headers: NO_STORE });
  });

  /**
   * POST — 회차 취소(I20B). 강사 사정이면 회차를 돌려주고, 회원 요청이면 24시간 규칙(S2-4.3)으로 차감을 정한다.
   * 이미 취소된 회차면 200 같은 본문(재전송 — 다시 차감하지 않는다). done·no_show 는 409 BOOKING_STATE_CONFLICT.
   */
  const cancel = withRoute<BookingParams>(async (request, context) => {
    const me = await requireInstructor(request);
    const { bookingId } = await context.params;
    const passRow = await requireMyBooking(bookingId, me);
    const input = await parseJsonBody(request, cancelBookingRequestSchema);
    const now = clock();
    const nowText = now.toString();

    const body = await db.transaction(async (tx) => {
      const pass = await loadPass(tx, passRow.id, me, true);
      if (pass === null) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);
      const booking = await loadBooking(tx, bookingId);
      if (booking === null) throw new HttpError("NOT_FOUND", DETAIL.bookingNotFound);

      const remaining = { sessionsUsed: pass.sessions_used, remainingSessions: pass.sessions_total - pass.sessions_used };
      if (booking.status.startsWith("cancelled_")) {
        return { bookingId, status: booking.status, deducted: booking.deducted, ...remaining };
      }
      if (booking.status !== "booked") throw HttpError.conflict("BOOKING_STATE_CONFLICT", DETAIL.bookingState);

      // 판정 — 기한은 이 수강권이 결제될 때 고정된 규칙 판본의 값(강사가 나중에 바꾼 규칙이 아니다)
      const verdict = decidePrivateLessonCancel({
        by: input.by,
        slotStartsAt: Temporal.Instant.from(booking.starts_at),
        changeDeadlineHours: pass.change_deadline_hours,
        now,
      });
      const reason = input.reason ?? null;

      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_bookings
                   SET status = ${verdict.status}, deducted = ${verdict.deducted}, cancel_reason = NULLIF(${reason ?? ""}, ''),
                       cancelled_at = ${nowText}::timestamptz, updated_at = now()
                   WHERE id = ${bookingId}::uuid AND status = 'booked'`
          .affectedCount()
          .build(),
      );
      // 그 시간: 기한 전 회원 취소면 다시 「레슨 모집」(open), 강사 사정·늦은 취소면 닫는다(closed)
      await tx.execute(
        tx.raw.sql`UPDATE private_lesson_slots SET status = ${verdict.slotStatus} WHERE id = ${booking.slot_id}::uuid AND status = 'booked'`
          .affectedCount()
          .build(),
      );
      // 차감이면 수강권에서 1회. 다 썼으면 수강권을 completed 로 닫는다(남은 횟수 0)
      const sessionsUsed = pass.sessions_used + (verdict.deducted ? 1 : 0);
      if (verdict.deducted) {
        await tx.execute(
          tx.raw.sql`UPDATE private_lesson_passes
                     SET sessions_used = ${sessionsUsed},
                         status = CASE WHEN ${sessionsUsed} >= sessions_total THEN 'completed' ELSE status END,
                         updated_at = now()
                     WHERE id = ${pass.id}::uuid`
            .affectedCount()
            .build(),
        );
      }

      await notifyMember(tx, {
        memberId: pass.member_id,
        academyId: pass.academy_id,
        kind: "private_lesson_cancelled",
        dedupeKey: `private_lesson_booking:${bookingId}:cancelled`,
        // 강사 사정 사유는 회원에게 보인다(계약 §10-3)
        payload: { by: input.by, passId: pass.id, bookingId, status: verdict.status, deducted: verdict.deducted, reason, startsAt: booking.starts_at, endsAt: booking.ends_at },
      });
      const before = { status: "booked", deducted: false, sessionsUsed: pass.sessions_used };
      const after = { status: verdict.status, deducted: verdict.deducted, sessionsUsed, by: input.by, reason, changeDeadlineHours: pass.change_deadline_hours };
      await tx.execute(
        tx.raw.sql`INSERT INTO audit_logs (id, actor_kind, actor_staff_account_id, actor_role, academy_id, action, target_table, target_id,
                                           before, after, occurred_at)
                   VALUES (uuidv7(), 'staff', ${me}::uuid, 'instructor', ${pass.academy_id}::uuid,
                           ${PRIVATE_LESSON_BOOKING_CANCELLED_AUDIT_ACTION}, 'private_lesson_bookings', ${bookingId}::uuid,
                           ${JSON.stringify(before)}::json, ${JSON.stringify(after)}::json, ${nowText}::timestamptz)`
          .affectedCount()
          .build(),
      );
      return { bookingId, status: verdict.status, deducted: verdict.deducted, sessionsUsed, remainingSessions: pass.sessions_total - sessionsUsed };
    });
    return Response.json(cancelBookingResponseSchema.parse(body), { headers: NO_STORE });
  });

  return { listPasses, getPass, book, reschedule, cancel };
}
