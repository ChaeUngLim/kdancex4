// S2-2.13(수업 목록 읽기 API) — 수업 등록 흐름의 「목록」 세 가지를 읽기만 하는 경로.
//   계약: _workspace/03_contracts/11-instructor.md §4 표 · §4 「GET /api/instructor/classes 항목」 문단 · §4-5(승인 대기 목록) · §4-6(회차 목록)
//   경로: GET /api/instructor/classes?status=&academyId=&cursor=          강사의 내 수업 목록(보드 I19 · I19B)
//         GET /api/classes/{classId}/sessions                             수업 하나의 회차 목록(보드 I6B)
//         GET /api/academies/{academyId}/class-approvals?status=&cursor=  대표의 승인 대기 목록(보드 O5 · O21)
//   요구: FR-050a(수업 등록 승인) · FR-055(회차 변경)
//
// 셋 다 DB 를 고치지 않는다. 그래서 트랜잭션·멱등키가 없고, 누가 부를 수 있는지와 「무엇이 보이면 안 되는지」가 전부다.
//
// 누가 무엇을 보나:
//   ① 내 수업 목록 — 강사 역할이 있는 직원만(대표 계정만 있으면 403). **자기가 올린 수업(created_by_account_id = 나)만** 나온다.
//      위임 강사(수업 관리 권한을 받은 강사)라도 남의 수업은 안 나온다(계약 「위임 강사는 자기가 올린 수업만」, Q45).
//   ② 회차 목록 — 올린 사람 또는 그 학원 대표. 판정은 수업 등록 경로와 같은 requireClassAccess 를 빌린다
//      (판정이 경로마다 다르면 소속이 끝난 강사가 한 경로로만 수업을 들여다보는 구멍이 생긴다).
//   ③ 승인 대기 목록 — 그 학원 대표만(위임 강사·강사·다른 학원 대표는 403). 앱은 Bearer, 관리자 웹은 쿠키 + 2단계 인증.
//
// 커서 페이지:
//   커서 = 「이 쪽에서 마지막으로 본 (정렬 시각, id)」를 base64url 로 감싼 글자(직원 알림함 staff-notifications.ts 와 같은 방식).
//   같은 시각의 행이 여럿이어도 id 로 한 줄로 세우므로 쪽을 넘길 때 겹치거나 빠지는 행이 없다.
//   내 수업 목록은 최근에 만든 순서(created_at 내림차순), 승인 대기 목록은 오래 기다린 순서(submitted_at 오름차순)다.
//
// 이 Task 가 하지 않는 것:
//   (승인 대기 목록의 「수정 요청」(kind: "edit") 줄은 S2-3.12(공개 뒤 수업 수정 요청 API)가 class_edit_requests 를 만들며 채웠다.)
//   대기 인원(waitlistCount)은 대기 신청(S4-4)이 생기기 전이라 늘 null 이다(계약 그대로).
import { z } from "zod";

import { APPROVAL_EDIT_FIELDS } from "../../domain/class-edit-request";
import { readClassPayload, type ClassPayload } from "../../domain/class-registration";
import { CLASS_STATUSES, GENRES } from "../../domain/constants";
import { WEEKDAYS } from "../../domain/recurring-schedule";
import { systemClock, type Clock } from "../../domain/time";
import { createGuards, type GuardDeps, type StaffAccountContext } from "../guards";
import { HttpError, parseWith, withRoute } from "../http";
import { createClassAccess } from "./class-registration";

export type ClassListReadDeps = GuardDeps & { clock?: Clock };

const DETAIL = {
  instructorOnly: "강사 계정만 볼 수 있어요",
  notFound: "학원을 찾을 수 없어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 한 쪽 기본 개수와 최대 개수(직원 알림함과 같은 값) */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const HOUR_MS = 3_600_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// DB 가 내주는 시각 모양(to_char … US"Z", 마이크로초까지). 커서 안 시각이 이 모양이 아니면 받지 않는다
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 커서 -----------------------------------------------------------------------------------

type Cursor = { at: string; id: string };

export function encodeClassListCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** 커서를 풀어 모양을 확인한다. 화면이 받은 값이 아니면(손으로 고친 값 등) null */
export function decodeClassListCursor(raw: string): Cursor | null {
  const [at, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (rest.length > 0 || at === undefined || id === undefined) return null;
  if (!CURSOR_TIME_PATTERN.test(at) || !UUID_PATTERN.test(id)) return null;
  return { at, id };
}

const cursorParam = z
  .string()
  .max(200)
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") return undefined;
    const decoded = decodeClassListCursor(value);
    if (decoded === null) {
      ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
      return z.NEVER;
    }
    return decoded;
  });

const limitParam = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional();

// ---- 요청 스키마 ------------------------------------------------------------------------------

/** 칩 거르기 세 가지(계약 §4). 비우면 폐강(cancelled)을 뺀 전체 */
export const INSTRUCTOR_CLASS_FILTERS = ["draft", "pending_approval", "published"] as const;

export const instructorClassesQuerySchema = z.strictObject({
  status: z.enum(INSTRUCTOR_CLASS_FILTERS).optional(),
  academyId: z.uuid().optional(),
  cursor: cursorParam,
  limit: limitParam,
});

/** 승인 대기 목록은 지금 「기다리는 것」(pending) 하나뿐이다(계약 §4-5 예시). 비우면 pending */
export const classApprovalsQuerySchema = z.strictObject({
  status: z.enum(["pending"]).optional(),
  cursor: cursorParam,
  limit: limitParam,
});

// ---- 응답 스키마(계약 11 §4) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });
const seatCell = z.strictObject({ confirmed: z.int().min(0), capacity: z.int().min(0) }).nullable();

export const instructorClassItemSchema = z.strictObject({
  classId: z.uuid(),
  title: z.string(),
  status: z.enum(CLASS_STATUSES),
  academyId: z.uuid(),
  academyName: z.string(),
  roomName: z.string().nullable(),
  weekdays: z.array(z.enum(WEEKDAYS)),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  priceAmount: z.int().nullable(),
  isFree: z.boolean(),
  seats: z.strictObject({ male: seatCell, female: seatCell, any: seatCell }),
  waitlistCount: z.null(),
  revisionReason: z.string().nullable(),
});
export type InstructorClassItem = z.infer<typeof instructorClassItemSchema>;

export const instructorClassListSchema = z.strictObject({
  items: z.array(instructorClassItemSchema),
  nextCursor: z.string().nullable(),
});

export const classSessionItemSchema = z.strictObject({
  sessionId: z.uuid(),
  seq: z.int().min(1),
  startsAt: isoInstant,
  endsAt: isoInstant,
  status: z.string(),
  room: z.strictObject({ roomId: z.uuid(), name: z.string() }).nullable(),
  instructor: z.strictObject({ accountId: z.uuid(), displayName: z.string() }).nullable(),
  isSubstitute: z.boolean(),
  confirmedMemberCount: z.int().min(0),
  // 그 회차에 열려 있는 대타 요청(open·accepted, 한 회차에 하나뿐 — uq_substitute_active). 없으면 null
  substituteRequest: z.strictObject({ requestId: z.uuid(), status: z.enum(["open", "accepted"]) }).nullable(),
});
export const classSessionListSchema = z.strictObject({ items: z.array(classSessionItemSchema) });

const newApprovalItem = z.strictObject({
  kind: z.literal("new"),
  classId: z.uuid(),
  title: z.string(),
  instructorName: z.string(),
  genre: z.enum(GENRES).nullable(),
  classKind: z.string(),
  weekdays: z.array(z.enum(WEEKDAYS)),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  priceAmount: z.int().nullable(),
  roomName: z.string().nullable(),
  submittedAt: isoInstant,
  waitingHours: z.int().min(0),
});
// 공개 뒤 수정 요청 줄 — S2-3.12(공개 뒤 수업 수정 요청 API)의 class_edit_requests 중 pending 인 것
const editApprovalItem = z.strictObject({
  kind: z.literal("edit"),
  editRequestId: z.uuid(),
  classId: z.uuid(),
  title: z.string(),
  changedFields: z.array(z.string()),
  paidCount: z.int().min(0),
  submittedAt: isoInstant,
  waitingHours: z.int().min(0),
});
export const classApprovalListSchema = z.strictObject({
  items: z.array(z.discriminatedUnion("kind", [newApprovalItem, editApprovalItem])),
  nextCursor: z.string().nullable(),
});

// ---- 공용 계산 --------------------------------------------------------------------------------

type ScheduleView = Pick<InstructorClassItem, "weekdays" | "startTime" | "endTime" | "periodFrom" | "periodTo">;

/**
 * 저장 값의 일정 → 목록 한 줄의 요일·시간·기간.
 *   요일 규칙(recurring)은 그대로, 하루짜리 행사(single)는 그날의 요일 하나 + 기간 = 그날 하루로 보인다.
 *   임시 저장이라 일정이 아직 없으면 빈 요일·null.
 */
function scheduleView(p: ClassPayload): ScheduleView {
  const s = p.schedule;
  if (s === null) return { weekdays: [], startTime: null, endTime: null, periodFrom: null, periodTo: null };
  if (s.kind === "recurring") {
    return { weekdays: s.weekdays, startTime: s.startTime, endTime: s.endTime, periodFrom: s.periodFrom, periodTo: s.periodTo };
  }
  // Temporal 의 dayOfWeek 는 월=1 … 일=7 이라 WEEKDAYS(월부터)의 칸 번호와 하나 차이 난다
  const weekday = WEEKDAYS[Temporal.PlainDate.from(s.date).dayOfWeek - 1];
  return { weekdays: weekday === undefined ? [] : [weekday], startTime: s.startTime, endTime: s.endTime, periodFrom: s.date, periodTo: s.date };
}

/** 쿼리 문자열을 객체로. 같은 이름이 두 번 오면 마지막 값을 쓴다 */
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
const emptyToNull = (value: string): string | null => (value === "" ? null : value);

// ---- ① 내 수업 목록 ---------------------------------------------------------------------------

const INSTRUCTOR_CLASS_ROW = {
  id: "pg/uuid@1",
  status: "pg/text@1",
  academy_id: "pg/uuid@1",
  academy_name: "pg/text@1",
  room_name: "pg/text@1",
  payload: "pg/text@1",
  revision_reason: "pg/text@1",
  created_at: "pg/text@1",
  has_pools: "pg/bool@1",
  male_confirmed: "pg/int4@1",
  male_capacity: "pg/int4@1",
  female_confirmed: "pg/int4@1",
  female_capacity: "pg/int4@1",
  any_confirmed: "pg/int4@1",
  any_capacity: "pg/int4@1",
} as const;

type InstructorClassRow = {
  id: string;
  status: string;
  academy_id: string;
  academy_name: string;
  room_name: string;
  payload: string;
  revision_reason: string;
  created_at: string;
  has_pools: boolean;
  male_confirmed: number;
  male_capacity: number;
  female_confirmed: number;
  female_capacity: number;
  any_confirmed: number;
  any_capacity: number;
};

/**
 * 자리 칸(남·여·한 칸).
 *   승인 요청 뒤에는 자리 묶음(seat_pools)이 있으니 실제 확정 수·정원을 읽는다(capacity 가 -1 이면 그 묶음이 없다).
 *   임시 저장에는 자리 묶음이 아직 없다 — 넣어 둔 정원 값만 보이고 확정 수는 0 이다.
 */
function seatsOf(row: InstructorClassRow, p: ClassPayload): InstructorClassItem["seats"] {
  if (row.has_pools) {
    const cell = (confirmed: number, capacity: number) => (capacity < 0 ? null : { confirmed, capacity });
    return {
      male: cell(row.male_confirmed, row.male_capacity),
      female: cell(row.female_confirmed, row.female_capacity),
      any: cell(row.any_confirmed, row.any_capacity),
    };
  }
  const c = p.capacity;
  if (c === null) return { male: null, female: null, any: null };
  if (c.mode === "gender_split") return { male: { confirmed: 0, capacity: c.male }, female: { confirmed: 0, capacity: c.female }, any: null };
  return { male: null, female: null, any: { confirmed: 0, capacity: c.any } };
}

function toInstructorItem(row: InstructorClassRow): InstructorClassItem {
  const p = readClassPayload(row.payload);
  return instructorClassItemSchema.parse({
    classId: row.id,
    title: p.title,
    status: row.status,
    academyId: row.academy_id,
    academyName: row.academy_name,
    roomName: emptyToNull(row.room_name),
    ...scheduleView(p),
    priceAmount: p.priceAmount,
    // 0원이면 무료 수업(I44). 아직 금액을 안 넣었으면 무료가 아니다(수업 등록 응답과 같은 기준)
    isFree: p.priceAmount === 0,
    seats: seatsOf(row, p),
    waitlistCount: null,
    // 반려 사유는 「고쳐서 다시 내야 하는」 임시 저장에서만 보인다 — 다시 내 승인 중·공개가 된 뒤에는 지난 사유라 숨긴다
    revisionReason: row.status === "draft" ? emptyToNull(row.revision_reason) : null,
  });
}

/** `GET /api/instructor/classes` — 내가 올린 수업 `{ items, nextCursor }` */
export function createInstructorClassListRoute(deps: ClassListReadDeps) {
  const { readStaff } = createClassAccess(deps);
  const { db } = deps;

  /** 강사 역할이 있는 직원만(대표 계정만 있는 사람은 403) */
  async function readInstructor(request: Request): Promise<StaffAccountContext> {
    const staff = await readStaff(request);
    if (!staff.actor.roles.includes("instructor")) throw new HttpError("FORBIDDEN", DETAIL.instructorOnly);
    return staff;
  }

  return withRoute<unknown>(async (request) => {
    const staff = await readInstructor(request);
    const query = parseWith(instructorClassesQuerySchema, queryOf(request));
    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
    // raw 레인은 null 을 매개변수로 받지 않는다 — 거르지 않을 때는 빈 글자를 넣고 SQL 에서 「빈 글자면 통과」로 본다.
    // 커서가 없으면 'infinity'(가장 늦은 시각보다 뒤) — 모든 행이 그 앞이다
    const status = query.status ?? "";
    const academyId = query.academyId ?? "";
    const beforeAt = query.cursor?.at ?? "infinity";
    const beforeId = query.cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";

    // 한 쪽 + 하나 더(limit + 1) 읽어 「다음 쪽이 있나」를 안다.
    // 남의 수업이 섞이지 않게 「올린 사람 = 나」를 늘 WHERE 에 건다 — 학원 id 를 바꿔 불러도 내 것만 나온다
    const picked = await db.query(
      db.raw.sql`SELECT c.id, c.status::text AS status, c.academy_id, a.name AS academy_name, COALESCE(r.name, '') AS room_name,
                        c.registration_payload::text AS payload, COALESCE(c.last_revision_reason, '') AS revision_reason,
                        to_char(c.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                        EXISTS (SELECT 1 FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id WHERE o.class_id = c.id) AS has_pools,
                        COALESCE(pools.male_confirmed, 0)::int4 AS male_confirmed, COALESCE(pools.male_capacity, -1)::int4 AS male_capacity,
                        COALESCE(pools.female_confirmed, 0)::int4 AS female_confirmed, COALESCE(pools.female_capacity, -1)::int4 AS female_capacity,
                        COALESCE(pools.any_confirmed, 0)::int4 AS any_confirmed, COALESCE(pools.any_capacity, -1)::int4 AS any_capacity
                 FROM classes c
                 JOIN academies a ON a.id = c.academy_id
                 LEFT JOIN rooms r ON r.id = c.room_id
                 LEFT JOIN LATERAL (
                   SELECT sum(p.confirmed_count) FILTER (WHERE p.seat_kind = 'male') AS male_confirmed,
                          sum(p.capacity) FILTER (WHERE p.seat_kind = 'male') AS male_capacity,
                          sum(p.confirmed_count) FILTER (WHERE p.seat_kind = 'female') AS female_confirmed,
                          sum(p.capacity) FILTER (WHERE p.seat_kind = 'female') AS female_capacity,
                          sum(p.confirmed_count) FILTER (WHERE p.seat_kind = 'any') AS any_confirmed,
                          sum(p.capacity) FILTER (WHERE p.seat_kind = 'any') AS any_capacity
                   FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id
                   WHERE o.class_id = c.id
                 ) pools ON true
                 WHERE c.created_by_account_id = ${staff.staffAccountId}::uuid
                   AND (${status} = '' AND c.status <> 'cancelled' OR c.status::text = ${status})
                   AND (${academyId} = '' OR c.academy_id = NULLIF(${academyId}, '')::uuid)
                   AND (c.created_at, c.id) < (${beforeAt}::timestamptz, ${beforeId}::uuid)
                 ORDER BY c.created_at DESC, c.id DESC
                 LIMIT ${pageSize + 1}::int`
        .returnsRow(INSTRUCTOR_CLASS_ROW)
        .build(),
    );

    const page = picked.slice(0, pageSize);
    const last = page.at(-1);
    // 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다. 없으면 마지막 쪽(null)
    const nextCursor = picked.length > pageSize && last !== undefined ? encodeClassListCursor({ at: last.created_at, id: last.id }) : null;
    return Response.json({ items: page.map(toInstructorItem), nextCursor }, { headers: NO_STORE });
  });
}

// ---- ② 회차 목록 ------------------------------------------------------------------------------

const SESSION_ROW = {
  id: "pg/uuid@1",
  seq: "pg/int4@1",
  starts_at: "pg/text@1",
  ends_at: "pg/text@1",
  status: "pg/text@1",
  room_id: "pg/text@1",
  room_name: "pg/text@1",
  instructor_id: "pg/text@1",
  instructor_name: "pg/text@1",
  is_substitute: "pg/bool@1",
  member_count: "pg/int4@1",
  request_id: "pg/text@1",
  request_status: "pg/text@1",
} as const;

type ClassParams = { params: Promise<{ classId: string }> };

/** `GET /api/classes/{classId}/sessions` — 회차 목록 `{ items }`(계약 §4-6). 회원 이름·연락처는 싣지 않는다 */
export function createClassSessionListRoute(deps: ClassListReadDeps) {
  const { readStaff, requireClassAccess, loadClass } = createClassAccess(deps);
  const { db } = deps;

  return withRoute<ClassParams>(async (request, context) => {
    const staff = await readStaff(request);
    const row = await loadClass(context);
    // 올린 사람(강사면 지금도 그 학원 class_writer) 또는 그 학원 대표. 남의 수업은 403
    await requireClassAccess(request, staff, row);

    // 임시 저장 수업은 회차가 아직 없다 — 빈 목록이 나온다(승인 요청 때 회차가 생긴다)
    // isSubstitute = 그 회차를 가르치는 강사가 수업의 담당 강사와 다르다(대표가 대타를 확인하면 회차의 강사 칸이 바뀐다, S2-3.4)
    // confirmedMemberCount = 그 회차 캘린더 항목으로 센 서로 다른 회원 수(결제 완료만 — 결제 대기·대기 신청은 캘린더에 없다)
    const rows = await db.query(
      db.raw.sql`SELECT s.id, s.seq, to_char(s.starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS starts_at,
                        to_char(s.ends_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS ends_at, s.status::text AS status,
                        COALESCE(s.room_id::text, '') AS room_id, COALESCE(rm.name, '') AS room_name,
                        COALESCE(s.instructor_account_id::text, '') AS instructor_id, COALESCE(sa.display_name, '') AS instructor_name,
                        (s.instructor_account_id IS NOT NULL AND c.instructor_account_id IS NOT NULL
                          AND s.instructor_account_id <> c.instructor_account_id) AS is_substitute,
                        (SELECT count(DISTINCT ce.member_id) FROM calendar_entries ce WHERE ce.session_id = s.id)::int4 AS member_count,
                        COALESCE(sr.id::text, '') AS request_id, COALESCE(sr.status::text, '') AS request_status
                 FROM class_sessions s
                 JOIN class_offerings o ON o.id = s.offering_id
                 JOIN classes c ON c.id = o.class_id
                 LEFT JOIN rooms rm ON rm.id = s.room_id
                 LEFT JOIN staff_accounts sa ON sa.id = s.instructor_account_id
                 LEFT JOIN substitute_requests sr ON sr.session_id = s.id AND sr.status IN ('open', 'accepted')
                 WHERE o.class_id = ${row.id}::uuid
                 ORDER BY s.starts_at, s.seq, s.id`
        .returnsRow(SESSION_ROW)
        .build(),
    );

    const items = rows.map((r) =>
      classSessionItemSchema.parse({
        sessionId: r.id,
        seq: r.seq,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
        room: r.room_id === "" ? null : { roomId: r.room_id, name: r.room_name },
        instructor: r.instructor_id === "" ? null : { accountId: r.instructor_id, displayName: r.instructor_name },
        isSubstitute: r.is_substitute,
        confirmedMemberCount: r.member_count,
        substituteRequest: r.request_id === "" ? null : { requestId: r.request_id, status: r.request_status },
      }),
    );
    return Response.json({ items }, { headers: NO_STORE });
  });
}

// ---- ③ 대표의 승인 대기 목록 -------------------------------------------------------------------

const APPROVAL_ROW = {
  kind: "pg/text@1",
  id: "pg/uuid@1",
  class_id: "pg/text@1",
  payload: "pg/text@1",
  instructor_name: "pg/text@1",
  room_name: "pg/text@1",
  submitted_at: "pg/text@1",
  changes: "pg/text@1",
  paid_count: "pg/int4@1",
} as const;

type AcademyParams = { params: Promise<{ academyId: string }> };

/** `GET /api/academies/{academyId}/class-approvals` — 승인 대기 `{ items, nextCursor }`, 오래 기다린 순서 */
export function createClassApprovalListRoute(deps: ClassListReadDeps) {
  const guards = createGuards(deps);
  const { db } = deps;
  const clock = deps.clock ?? systemClock;

  return withRoute<AcademyParams>(async (request, context) => {
    const { academyId } = await context.params;
    // 모양이 틀린 학원 id 는 그런 학원이 없다는 뜻이라 404(DB 형 변환 오류 500 을 막는다)
    if (!z.uuid().safeParse(academyId).success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    // 그 학원 대표만 — 앱(Bearer)이면 app 면, 쿠키면 관리자 웹(2단계 필수). 위임 강사·다른 학원 대표는 403
    const bearer = (request.headers.get("authorization") ?? "").toLowerCase().startsWith("bearer ");
    await guards.requireStaff("owner", { academyId, surface: bearer ? "app" : "web", headers: request.headers });

    const query = parseWith(classApprovalsQuerySchema, queryOf(request));
    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
    // 오래 기다린 순서(오름차순)라 커서가 없으면 '-infinity'(가장 이른 시각보다 앞) — 모든 행이 그 뒤다
    const afterAt = query.cursor?.at ?? "-infinity";
    const afterId = query.cursor?.id ?? "00000000-0000-0000-0000-000000000000";

    // 두 갈래를 한 줄로 세운다(오래 기다린 순서, 같은 시각이면 id 순):
    //   new  — 그 학원의 승인 대기 수업(ix_classes_academy_status 색인). 등록 취소·반려되면 draft 로 바뀌어 빠진다
    //   edit — 공개 뒤 수정 요청 중 pending(S2-3.12). 기다린 시간의 기준은 요청 시각, id 는 요청 id 다. 승인·반려·취소되면 빠진다
    const picked = await db.query(
      db.raw.sql`SELECT q.kind, q.id, q.class_id, q.payload, q.instructor_name, q.room_name, q.submitted_at, q.changes, q.paid_count FROM (
                   SELECT 'new' AS kind, c.id, c.id::text AS class_id, c.registration_payload::text AS payload,
                          COALESCE(i.display_name, '') AS instructor_name, COALESCE(r.name, '') AS room_name,
                          to_char(c.submitted_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS submitted_at, c.submitted_at AS sort_at,
                          '{}' AS changes, 0::int4 AS paid_count
                   FROM classes c
                   LEFT JOIN staff_accounts i ON i.id = c.instructor_account_id
                   LEFT JOIN rooms r ON r.id = c.room_id
                   WHERE c.academy_id = ${academyId}::uuid AND c.status = 'pending_approval' AND c.submitted_at IS NOT NULL
                   UNION ALL
                   SELECT 'edit' AS kind, e.id, c.id::text AS class_id, c.registration_payload::text AS payload, '' AS instructor_name, '' AS room_name,
                          to_char(e.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS submitted_at, e.created_at AS sort_at,
                          e.changes::text AS changes,
                          COALESCE((SELECT sum(p.confirmed_count) FROM seat_pools p JOIN class_offerings o ON o.id = p.offering_id
                                    WHERE o.class_id = c.id), 0)::int4 AS paid_count
                   FROM class_edit_requests e JOIN classes c ON c.id = e.class_id
                   WHERE c.academy_id = ${academyId}::uuid AND e.status = 'pending'
                 ) q
                 WHERE (q.sort_at, q.id) > (${afterAt}::timestamptz, ${afterId}::uuid)
                 ORDER BY q.sort_at, q.id
                 LIMIT ${pageSize + 1}::int`
        .returnsRow(APPROVAL_ROW)
        .build(),
    );

    const now = clock().epochMilliseconds;
    const page = picked.slice(0, pageSize);
    const items = page.map((row) => {
      const p = readClassPayload(row.payload);
      const submitted = Temporal.Instant.from(row.submitted_at);
      // 기다린 시간(시간 단위, 버림). 시계가 요청 시각보다 앞이면 0
      const waitingHours = Math.max(0, Math.floor((now - submitted.epochMilliseconds) / HOUR_MS));
      if (row.kind === "edit") {
        return editApprovalItem.parse({
          kind: "edit",
          editRequestId: row.id,
          classId: row.class_id,
          title: p.title,
          // jsonb 는 칸 순서를 지키지 않으므로 계약 표의 순서(금액 · 일정 · 정원 · 환불 마감일)로 다시 세운다
          changedFields: APPROVAL_EDIT_FIELDS.filter((field) => Object.hasOwn(JSON.parse(row.changes) as object, field)),
          paidCount: row.paid_count,
          submittedAt: submitted.toString(),
          waitingHours,
        });
      }
      return newApprovalItem.parse({
        kind: "new",
        classId: row.id,
        title: p.title,
        instructorName: row.instructor_name,
        genre: p.genre,
        classKind: p.classKind,
        ...scheduleView(p),
        priceAmount: p.priceAmount,
        roomName: emptyToNull(row.room_name),
        submittedAt: submitted.toString(),
        waitingHours,
      });
    });
    const last = page.at(-1);
    const nextCursor = picked.length > pageSize && last !== undefined ? encodeClassListCursor({ at: last.submitted_at, id: last.id }) : null;
    return Response.json({ items, nextCursor }, { headers: NO_STORE });
  });
}
