// S3-4.5(알림함 조회와 결제 확인 알림) — `GET /api/me/notifications?limit=20&cursor=`
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §2(알림 조회) · §3(확정 때 생기는 알림)
//   데이터: data-model §7-7 `notifications`(회원 칸 recipient_member_id, 색인 ix_notifications_recipient_created)
//   요구: FR-114(결제 확인 앱 알림) · 플랜 S3-4 「열린 점: 실제 발송은 S7-1 — 여기서는 앱 알림함에 보이는 데까지」
//
// 흐름 한눈에 — 회원 확인 → 쿼리 검사 → 내 알림만 최신순으로 한 쪽:
//   ① 회원 세션이 있어야 한다(requireMember — 없으면 401, 가입을 덜 마쳤으면 403).
//   ② limit(1~100, 기본 20)·cursor 를 검사한다. 모르는 쿼리 칸이나 손으로 고친 커서는 422.
//   ③ 받는 사람이 「나」(recipient_member_id = 나)인 행만 읽는다. 남의 알림·직원 알림함 행은 나올 수 없다.
//   ④ **읽기만 한다.** delivery_status 는 웹훅이 넣은 pending 그대로다 — 발송은 SCH-38(알림)이 이 행을 읽어 한다.
//      읽음 처리 API 도 1회차 범위 밖이라 read_at 을 고치지 않는다(계약 §2).
//
// 커서는 직원 알림함(S1-4.6)과 같은 모양을 쓴다 — 「이 쪽의 마지막 (만든 시각, id)」를 감싼 글자라
// 같은 시각에 여러 알림이 있어도 쪽을 넘길 때 겹치거나 빠지지 않는다.
import { z } from "zod";

import { NOTIFICATION_KINDS, type NotificationKind } from "../../domain/constants";
import { createGuards, type GuardDeps } from "../guards";
import { parseWith, withRoute } from "../http";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

export type MeNotificationsDeps = GuardDeps;

/** 한 쪽 기본 개수(계약 `limit=20`)와 최대 개수 — 직원 알림함과 같다 */
export const ME_NOTIFICATIONS_DEFAULT_PAGE_SIZE = 20;
export const ME_NOTIFICATIONS_MAX_PAGE_SIZE = 100;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const BAD_CURSOR = "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요";
// SQL 에서 시각을 글자로 읽는 형식. 마이크로초까지 읽어야 커서가 DB 의 값과 정확히 같아진다
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

// ---- 요청 스키마 ------------------------------------------------------------------------------

export const meNotificationsQuerySchema = z.strictObject({
  cursor: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return undefined;
      const decoded = decodeNotificationCursor(value);
      if (decoded === null) {
        ctx.addIssue({ code: "custom", message: BAD_CURSOR });
        return z.NEVER;
      }
      return decoded;
    }),
  limit: z.coerce.number().int().min(1).max(ME_NOTIFICATIONS_MAX_PAGE_SIZE).optional(),
});

// ---- 응답 스키마(계약 04 §2) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

export const meNotificationSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  createdAt: isoInstant,
  readAt: isoInstant.nullable(),
  // 주문 알림(결제 확인·입금 기한 임박)은 주문 id 가 있고, 결석 표시처럼 주문이 없는 알림은 null
  orderId: z.uuid().nullable(),
  // 화면 문구 재료. 모양은 그 알림을 쓰는 쪽이 정한다(결제 확인 = 웹훅 확정, 계약 §3). 계좌번호 등은 들어가지 않는다
  payload: z.record(z.string(), z.unknown()),
});
export type MeNotification = z.infer<typeof meNotificationSchema>;

export const meNotificationListSchema = z.strictObject({
  items: z.array(meNotificationSchema),
  nextCursor: z.string().nullable(),
});
export type MeNotificationList = z.infer<typeof meNotificationListSchema>;

// ---- 경로 -----------------------------------------------------------------------------------

/** `GET /api/me/notifications` — 내 알림 최신순 `{items, nextCursor}` */
export function createMeNotificationsRoute(deps: MeNotificationsDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    // 순서: 인증(401·403) → 쿼리(422) — 로그인 안 한 요청이 쿼리 오류부터 보지 않게
    const member = await guards.requireMember(request);
    const query = parseWith(meNotificationsQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const pageSize = query.limit ?? ME_NOTIFICATIONS_DEFAULT_PAGE_SIZE;

    // 커서가 없으면 '+infinity'(가장 늦은 시각보다 뒤)와 가장 큰 id — 모든 행이 그 앞이다
    const beforeTime = query.cursor?.createdAt ?? "infinity";
    const beforeId = query.cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";

    // 한 쪽 + 하나 더(limit + 1) 읽어 「다음 쪽이 있나」를 안다. NULL 칸은 빈 글자로 읽고 아래에서 null 로 되돌린다
    const picked = await db.query(
      db.raw.sql`SELECT n.id, n.kind,
                        to_char(n.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                        COALESCE(to_char(n.read_at AT TIME ZONE 'UTC', ${ISO_US_SQL}), '') AS read_at,
                        COALESCE(n.order_id::text, '') AS order_id,
                        n.payload::text AS payload
                 FROM notifications n
                 WHERE n.recipient_member_id = ${member.memberId}::uuid
                   AND (n.created_at, n.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                 ORDER BY n.created_at DESC, n.id DESC
                 LIMIT ${pageSize + 1}::int`
        .returnsRow({
          id: "pg/uuid@1",
          kind: "pg/text@1",
          created_at: "pg/text@1",
          read_at: "pg/text@1",
          order_id: "pg/text@1",
          payload: "pg/text@1",
        })
        .build(),
    );

    const page = picked.slice(0, pageSize);
    const last = page.at(-1);
    // 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다. 없으면 마지막 쪽(null)
    const nextCursor =
      picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.created_at, id: last.id }) : null;

    const body: MeNotificationList = {
      items: page.map((row) => ({
        id: row.id,
        // kind 는 DB CHECK(enum)가 지키는 값이라 그대로 좁힌다
        kind: row.kind as NotificationKind,
        createdAt: row.created_at,
        readAt: row.read_at === "" ? null : row.read_at,
        orderId: row.order_id === "" ? null : row.order_id,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      })),
      nextCursor,
    };
    return Response.json(body, { headers: NO_STORE });
  });
}
