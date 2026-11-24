// S1-4.6(직원 알림함 API) — 직원(대표·강사·운영자) 본인의 알림함 경로 넷.
//   계약: _workspace/03_contracts/10-owner-dashboard.md §2(직원 알림함) · 수용 시나리오 3~5
//   데이터: data-model §7-7 `notifications` 확장(recipient_staff_account_id · academy_id · category · dedupe_key,
//           색인 ix_notifications_staff_created (recipient_staff_account_id, created_at))
//   요구: FR-080(대표 운영 알림) · FR-145(관리자 웹 알림) · 보드 O21(대표 알림함) · O21B(결제·운영 알림)
//
//   GET  /api/staff/notifications?academyId=&category=&cursor=&limit=20   내 알림 최신순(커서로 다음 쪽)
//   GET  /api/staff/notifications/unread-count?academyId=                 안 읽은 수(전체 + 칩별)
//   POST /api/staff/notifications/{id}/read                               읽음(멱등)
//   POST /api/staff/notifications/read-all  { category }                  모두 읽음 → { updated }
//
// 누가 부르나(staff_self): 역할을 묻지 않는다. 받는 사람이 「나」인 행만 읽고 고치므로 권한 판정이 곧 받는 사람 판정이다.
//   ① 세션 401 → active 직원 계정 403 → 2단계 인증 401(SECOND_FACTOR_REQUIRED). 입점 신청 초안(07 §2)과 같은 staff_self 다.
//   계약은 「웹·앱 모두」라고 적었지만, 지금 직원 경로는 모두 관리자 웹 기준(2단계 필수)이다. 인증 앱이 없는 강사가
//   앱에서 bearer 로 부르게 할지는 앱 알림함 화면 Task 에서 정한다(증거 EVIDENCE.md 의 열린 점).
//
// 남의 알림은 404 — 읽음 처리할 때 「그 id 가 있는지」를 알리지 않는다(계약 §2, 수용 시나리오 4).
//   그래서 id 와 받는 사람을 늘 같은 WHERE 에 함께 건다. 남의 행은 고쳐지지도, 읽히지도 않는다.
import { z } from "zod";

import { NOTIFICATION_CATEGORIES, NOTIFICATION_KINDS, type NotificationCategory, type NotificationKind } from "../../domain/constants";
import type { Clock } from "../../domain/time";
import { consoleSurface } from "../console-route";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, parseWith, withRoute } from "../http";

export type StaffNotificationDeps = GuardDeps & { readonly clock: Clock };

const DETAIL = {
  secondFactor: "인증 앱 코드로 2단계 인증을 마쳐 주세요",
  notFound: "알림을 찾을 수 없어요",
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
} as const;

/** 한 쪽 기본 개수(계약 `limit=20`)와 최대 개수 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// DB 가 내주는 시각 모양(to_char … US"Z", 마이크로초까지) — 커서 안의 시각이 이 모양이 아니면 받지 않는다
const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
// SQL 에서 시각을 글자로 읽는 to_char 형식. 마이크로초까지 읽어야 커서가 DB 의 값과 정확히 같아진다
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 커서 -----------------------------------------------------------------------------------
// 커서 = 「이 쪽에서 마지막으로 본 (만든 시각, id)」를 base64url 로 감싼 글자.
// 최신순이라 다음 쪽은 그보다 「앞선」 행이다: (created_at, id) < (커서 시각, 커서 id).
// 같은 시각에 여러 행이 있어도 id 로 한 줄로 세우므로, 쪽을 넘길 때 겹치거나 빠지는 행이 없다.

type Cursor = { createdAt: string; id: string };

export function encodeNotificationCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, "utf8").toString("base64url");
}

/** 커서를 풀어 모양을 확인한다. 화면이 받은 값이 아니면(손으로 고친 값 등) null */
export function decodeNotificationCursor(raw: string): Cursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [createdAt, id, ...rest] = text.split("|");
  if (rest.length > 0 || createdAt === undefined || id === undefined) return null;
  if (!CURSOR_TIME_PATTERN.test(createdAt) || !UUID_PATTERN.test(id)) return null;
  return { createdAt, id };
}

// ---- 요청 스키마 ------------------------------------------------------------------------------

export const listQuerySchema = z.strictObject({
  // 비우면 내가 받은 모든 학원의 알림
  academyId: z.uuid().optional(),
  // 비우면 칩 전체
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const decoded = decodeNotificationCursor(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: DETAIL.badCursor });
        return z.NEVER;
      }
      return decoded;
    }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

export const unreadCountQuerySchema = z.strictObject({
  academyId: z.uuid().optional(),
});

/** 「모두 읽음」 본문 — category 가 null 이거나 없으면 칩 전체 */
export const readAllBodySchema = z.strictObject({
  category: z.enum(NOTIFICATION_CATEGORIES).nullable().optional(),
});

// ---- 응답 스키마(계약 10 §2) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

/** 알림 한 줄. 읽음 처리 응답도 같은 모양이다 */
export const staffNotificationSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  // 회원 알림과 표를 같이 써서 칸은 NULL 허용이다. 직원 알림을 쓰는 쪽은 늘 채운다
  category: z.enum(NOTIFICATION_CATEGORIES).nullable(),
  academyId: z.uuid().nullable(),
  createdAt: isoInstant,
  readAt: isoInstant.nullable(),
  // 쓰는 쪽이 정한 화면 재료(title·body·actionLabel·link 등). 모양은 쓰는 쪽 계약이 정한다
  payload: z.record(z.string(), z.unknown()),
});
export type StaffNotification = z.infer<typeof staffNotificationSchema>;

export const staffNotificationListSchema = z.strictObject({
  items: z.array(staffNotificationSchema),
  nextCursor: z.string().nullable(),
});

export const unreadCountResponseSchema = z.strictObject({
  total: z.number().int().min(0),
  // 안 읽은 알림이 있는 칩만 담는다(계약 예: { approval: 2, operations: 1 })
  byCategory: z.partialRecord(z.enum(NOTIFICATION_CATEGORIES), z.number().int().min(1)),
});
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

export const readAllResponseSchema = z.strictObject({ updated: z.number().int().min(0) });

// ---- DB 읽기 --------------------------------------------------------------------------------

type NotificationRow = {
  id: string;
  kind: string;
  category: string;
  academy_id: string;
  created_at: string;
  read_at: string;
  payload: string;
};

// raw 레인은 행 타입을 칸마다 정해 받는다. NULL 은 SQL 에서 빈 글자로 바꿔 읽고 toItem 에서 null 로 되돌린다
const NOTIFICATION_ROW = {
  id: "pg/uuid@1",
  kind: "pg/text@1",
  category: "pg/text@1",
  academy_id: "pg/text@1",
  created_at: "pg/text@1",
  read_at: "pg/text@1",
  payload: "pg/text@1",
} as const;

const emptyToNull = (value: string): string | null => (value === "" ? null : value);

/** DB 행 → 응답 한 줄. kind·category 는 DB CHECK(enum)가 지키는 값이라 그대로 좁힌다 */
function toItem(row: NotificationRow): StaffNotification {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    category: emptyToNull(row.category) as NotificationCategory | null,
    academyId: emptyToNull(row.academy_id),
    createdAt: row.created_at,
    readAt: emptyToNull(row.read_at),
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

// ---- 라우트 처리기 ---------------------------------------------------------------------------

/**
 * 네 경로가 함께 쓰는 ① staff_self 확인 — 세션·active 직원 계정, 그다음 2단계 인증.
 * 2단계는 관리자 웹(쿠키)에서만 묻는다 — 강사·대표 앱(Bearer)은 2단계를 묻지 않는 설계다(계약 11 열린 점 ⑩, README §6-1).
 * 전에는 앱에서도 물어 대표 앱 알림함(O21)이 실서버에서 늘 401 이었다(2026-11-23 실서버 시연에서 발견).
 */
function createStaffSelf(deps: GuardDeps) {
  const guards = createGuards(deps);
  return async (request: Request) => {
    const staff = await guards.requireStaffAccount(request);
    const web = consoleSurface(request, true) === "web";
    if (web && !staff.secondFactorVerified) throw new HttpError("SECOND_FACTOR_REQUIRED", DETAIL.secondFactor);
    return staff;
  };
}

/** 쿼리 문자열을 객체로. 같은 이름이 두 번 오면 마지막 값을 쓴다 */
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/** `GET /api/staff/notifications` — 내 알림 최신순 `{items, nextCursor}` */
export function createListStaffNotificationsRoute(deps: StaffNotificationDeps) {
  const staffSelf = createStaffSelf(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    const query = parseWith(listQuerySchema, queryOf(request));
    const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;

    // raw 레인은 null 을 매개변수로 받지 않는다 — 거르지 않을 때는 빈 글자를 넣고 SQL 에서 「빈 글자면 통과」로 본다.
    // 커서가 없으면 '+infinity'(가장 늦은 시각보다 뒤) — 모든 행이 그 앞이다
    const academyId = query.academyId ?? "";
    const category = query.category ?? "";
    const beforeTime = query.cursor?.createdAt ?? "infinity";
    const beforeId = query.cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";

    // 한 쪽 + 하나 더(limit + 1) 읽어 「다음 쪽이 있나」를 안다
    const picked = await db.query(
      db.raw.sql`SELECT n.id, n.kind, COALESCE(n.category, '') AS category, COALESCE(n.academy_id::text, '') AS academy_id,
                        to_char(n.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                        COALESCE(to_char(n.read_at AT TIME ZONE 'UTC', ${ISO_US_SQL}), '') AS read_at,
                        n.payload::text AS payload
                 FROM notifications n
                 WHERE n.recipient_staff_account_id = ${staff.staffAccountId}::uuid
                   AND (${academyId} = '' OR n.academy_id = NULLIF(${academyId}, '')::uuid)
                   AND (${category} = '' OR n.category = ${category})
                   AND (n.created_at, n.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                 ORDER BY n.created_at DESC, n.id DESC
                 LIMIT ${pageSize + 1}::int`
        .returnsRow(NOTIFICATION_ROW)
        .build(),
    );

    const page = picked.slice(0, pageSize);
    const last = page.at(-1);
    // 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다. 없으면 마지막 쪽(null)
    const nextCursor =
      picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.created_at, id: last.id }) : null;

    return Response.json({ items: page.map(toItem), nextCursor });
  });
}

/** `GET /api/staff/notifications/unread-count` — `{ total, byCategory }`. 화면이 30초마다 부른다(계약 §2 추천값) */
export function createStaffUnreadCountRoute(deps: StaffNotificationDeps) {
  const staffSelf = createStaffSelf(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    const query = parseWith(unreadCountQuerySchema, queryOf(request));
    const academyId = query.academyId ?? "";

    // 칩별로 센다. 칩이 비어 있는 알림(category NULL)은 전체 수에만 들어간다
    const rows = await db.query(
      db.raw.sql`SELECT COALESCE(n.category, '') AS category, count(*)::int AS n
                 FROM notifications n
                 WHERE n.recipient_staff_account_id = ${staff.staffAccountId}::uuid
                   AND n.read_at IS NULL
                   AND (${academyId} = '' OR n.academy_id = NULLIF(${academyId}, '')::uuid)
                 GROUP BY 1`
        .returnsRow({ category: "pg/text@1", n: "pg/int4@1" })
        .build(),
    );

    const body: UnreadCountResponse = {
      total: rows.reduce((sum, row) => sum + row.n, 0),
      byCategory: Object.fromEntries(rows.filter((row) => row.category !== "").map((row) => [row.category, row.n])),
    };
    return Response.json(body);
  });
}

type NotificationParams = { params: Promise<{ id: string }> };

/**
 * `POST /api/staff/notifications/{id}/read` — 읽음 표시. 본문은 받지 않는다.
 * 멱등: 아직 안 읽은 내 알림만 read_at 을 채우고(WHERE read_at IS NULL), 이미 읽었으면 처음 읽은 시각을 그대로 돌려준다.
 *   그래서 두 번 눌러도 응답 본문이 같다(계약 §2 「이미 읽었으면 200 같은 본문」).
 * 남의 알림·없는 알림·모양이 틀린 id 는 모두 같은 404 다 — 남의 알림이 「있는지」를 알려 주지 않는다.
 */
export function createReadStaffNotificationRoute(deps: StaffNotificationDeps) {
  const staffSelf = createStaffSelf(deps);
  const { db } = deps;

  return withRoute<NotificationParams>(async (request, context) => {
    const staff = await staffSelf(request);
    const parsed = z.uuid().safeParse((await context.params).id);
    if (!parsed.success) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    const id = parsed.data;
    const now = deps.clock().toString();

    // id 와 받는 사람을 같은 WHERE 에 건다 — 남의 행은 여기서 바뀌지 않는다(수용 시나리오 4 「A 의 read_at 그대로」)
    await db.execute(
      db.raw.sql`UPDATE notifications SET read_at = ${now}::timestamptz
                 WHERE id = ${id}::uuid AND recipient_staff_account_id = ${staff.staffAccountId}::uuid AND read_at IS NULL`
        .affectedCount()
        .build(),
    );

    // 고친 뒤 다시 읽어 돌려준다 — 처음이든 두 번째든 같은 행을 읽으니 본문이 같다
    const [row] = await db.query(
      db.raw.sql`SELECT n.id, n.kind, COALESCE(n.category, '') AS category, COALESCE(n.academy_id::text, '') AS academy_id,
                        to_char(n.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                        COALESCE(to_char(n.read_at AT TIME ZONE 'UTC', ${ISO_US_SQL}), '') AS read_at,
                        n.payload::text AS payload
                 FROM notifications n
                 WHERE n.id = ${id}::uuid AND n.recipient_staff_account_id = ${staff.staffAccountId}::uuid`
        .returnsRow(NOTIFICATION_ROW)
        .build(),
    );
    if (row === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
    return Response.json(toItem(row));
  });
}

/** `POST /api/staff/notifications/read-all` `{ category }` — 「모두 읽음」(O21). 바뀐 행 수를 돌려준다 */
export function createReadAllStaffNotificationsRoute(deps: StaffNotificationDeps) {
  const staffSelf = createStaffSelf(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    const staff = await staffSelf(request);
    const body = await parseJsonBody(request, readAllBodySchema);
    const category = body.category ?? "";
    const now = deps.clock().toString();

    // 내 안 읽은 알림만 고친다. 이미 읽은 알림은 처음 읽은 시각을 그대로 둔다(세지도 않는다)
    const [result] = await db.query(
      db.raw.sql`WITH changed AS (
                   UPDATE notifications SET read_at = ${now}::timestamptz
                   WHERE recipient_staff_account_id = ${staff.staffAccountId}::uuid
                     AND read_at IS NULL
                     AND (${category} = '' OR category = ${category})
                   RETURNING 1
                 )
                 SELECT count(*)::int AS updated FROM changed`
        .returnsRow({ updated: "pg/int4@1" })
        .build(),
    );
    return Response.json({ updated: result?.updated ?? 0 });
  });
}
