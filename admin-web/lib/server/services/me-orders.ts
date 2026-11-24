// S3-4.6(결제 내역·주문 상태 표시 API) — `GET /api/me/orders?status=&limit=20&cursor=`
//   계약: _workspace/03_contracts/04-me-calendar-notifications.md §9(내 결제 내역·주문 상태)
//   데이터: data-model §4.1(주문 상태 6종) · §15-4 ⑥(영수증 칸은 S8-1 이 채운다)
//   요구: FR-298(주문 상태 6종) · FR-138(결제 내역) · FR-299(카드·계좌 번호는 목록에 없다) · 보드 M16(내 예약·결제 내역)
//
// 흐름 한눈에 — 회원 확인 → 쿼리 검사 → 기한 지난 결제 대기 정리 → 내 주문만 최신순으로 한 쪽:
//   ① 회원 세션이 있어야 한다(requireMember — 없으면 401, 가입을 덜 마쳤으면 403).
//   ② status(6종 이름을 쉼표로 여러 개)·limit(1~50, 기본 20)·cursor 를 검사한다. 6종 밖의 값·모르는 칸은 422.
//   ③ 내 결제 대기 중 기한이 이미 지난 것을 먼저 닫는다(계약 03 §5 「읽기·쓰기 전 정리」, 단건 조회 order-detail 과 같은 규칙).
//      그래야 목록에는 pending 인데 단건을 열면 expired 인 어긋남이 생기지 않는다.
//   ④ 주인이 「나」(orders.member_id = 나)인 주문만 읽는다. 남의 주문·닉네임은 나올 수 없다.
//
// 상태 이름은 constants.ts 의 ORDER_STATUSES 를 그대로 내보낸다. 「결제완료」「부분 환불」 같은 화면 글자는 앱이 만든다 —
// 서버가 글자를 만들면 앱과 서버 두 곳에서 같은 표를 고쳐야 해서다(계약 §9 「서버에 칩 이름을 만들지 않는다」).
// 커서는 알림함(S1-4.6 · S3-4.5)과 같은 「이 쪽의 마지막 (만든 시각, id)」 글자를 쓴다 — 같은 시각 주문이 여러 개여도 겹치거나 빠지지 않는다.
import { z } from "zod";

import { ORDER_STATUSES, PAYMENT_METHODS, SEAT_KINDS, type OrderStatus, type PaymentMethod, type SeatKind } from "../../domain/constants";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { parseWith, withRoute } from "../http";
import { expireDuePayments } from "./order-expiry";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

export type MeOrdersDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway">;

/** 한 쪽 기본 개수와 최대 개수(계약 §9 「limit 기본 20, 최대 50」) */
export const ME_ORDERS_DEFAULT_PAGE_SIZE = 20;
export const ME_ORDERS_MAX_PAGE_SIZE = 50;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const BAD_CURSOR = "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요";
const BAD_STATUS = `주문 상태는 ${ORDER_STATUSES.join(", ")} 중에서 골라 주세요`;
// 커서용 시각은 마이크로초까지 읽어야 DB 의 값과 정확히 같아진다. 화면용 시각(결제·기한)은 초까지면 된다
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

// ---- 요청 스키마 ------------------------------------------------------------------------------

export const meOrdersQuerySchema = z.strictObject({
  // 「paid,partially_refunded」처럼 쉼표로 여러 개. 한 글자라도 6종 밖이면 422 — 모르는 이름을 조용히 버리지 않는다
  status: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return [] as OrderStatus[];
      const names = value.split(",").map((name) => name.trim());
      const known = ORDER_STATUSES as readonly string[];
      if (names.some((name) => !known.includes(name))) {
        ctx.addIssue({ code: "custom", message: BAD_STATUS });
        return z.NEVER;
      }
      return [...new Set(names)] as OrderStatus[];
    }),
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
  limit: z.coerce.number().int().min(1).max(ME_ORDERS_MAX_PAGE_SIZE).optional(),
});

// ---- 응답 스키마(계약 04 §9) — 테스트가 본문을 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

export const meOrderSchema = z.strictObject({
  orderId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  offeringId: z.uuid(),
  // 「수업 제목 · 신청 단위 이름」 — 결제창 주문명(order-create.ts 의 readOrderView)과 같은 글자
  title: z.string(),
  academyName: z.string(),
  seatKind: z.enum(SEAT_KINDS),
  method: z.enum(PAYMENT_METHODS),
  totalAmount: z.number().int().nonnegative(),
  // refunds 완료(succeeded)분 합계, 원 정수(README §3)
  refundedAmount: z.number().int().nonnegative(),
  createdAt: isoInstant,
  paidAt: isoInstant.nullable(),
  // 입금 기한 — 결제 대기(pending)일 때만 값이 있다
  dueAt: isoInstant.nullable(),
  // 영수증 링크는 실 PG(S8-1)가 채우는 칸이다. 그 전에는 모두 null · false(데이터 §15-4 ⑥)
  receipt: z.strictObject({
    academyUrl: z.string().nullable(),
    companyUrl: z.string().nullable(),
    cashReceiptIssued: z.boolean(),
  }),
});
export type MeOrder = z.infer<typeof meOrderSchema>;

export const meOrderListSchema = z.strictObject({
  items: z.array(meOrderSchema),
  nextCursor: z.string().nullable(),
});
export type MeOrderList = z.infer<typeof meOrderListSchema>;

// ---- 경로 -----------------------------------------------------------------------------------

/** `GET /api/me/orders` — 내 주문 최신순 `{items, nextCursor}` */
export function createMeOrdersRoute(deps: MeOrdersDeps) {
  const guards = createGuards(deps);
  const { db } = deps;

  return withRoute<unknown>(async (request) => {
    // 순서: 인증(401·403) → 쿼리(422) — 로그인 안 한 요청이 쿼리 오류부터 보지 않게
    const member = await guards.requireMember(request);
    const query = parseWith(meOrdersQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
    const pageSize = query.limit ?? ME_ORDERS_DEFAULT_PAGE_SIZE;

    // ③ 기한 지난 내 결제 대기를 판매 단위별로 닫는다. 대상이 없으면(대부분) 읽기 한 번으로 끝난다
    const now = deps.clock().toString();
    const dueOfferings = await db.query(
      db.raw.sql`SELECT DISTINCT o.offering_id
                 FROM orders o JOIN payments p ON p.order_id = o.id
                 WHERE o.member_id = ${member.memberId}::uuid AND o.status = 'pending'
                   AND p.status = 'ready' AND p.due_at <= ${now}::timestamptz`
        .returnsRow({ offering_id: "pg/uuid@1" })
        .build(),
    );
    for (const row of dueOfferings) await expireDuePayments(deps, { offeringId: row.offering_id });

    // 커서가 없으면 '+infinity'(가장 늦은 시각보다 뒤)와 가장 큰 id — 모든 행이 그 앞이다
    const beforeTime = query.cursor?.createdAt ?? "infinity";
    const beforeId = query.cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";
    // raw 태그는 배열을 받지 않아 쉼표 글자로 넘기고 SQL 에서 다시 쪼갠다. 빈 글자 = 상태 거르기 없음
    const statusCsv = query.status.join(",");

    // ④ 한 쪽 + 하나 더(limit + 1) 읽어 「다음 쪽이 있나」를 안다. NULL 칸은 빈 글자로 읽고 아래에서 null 로 되돌린다
    //    결제는 단건 조회와 같은 규칙으로 하나 고른다 — 살아 있는(ready·paid) 결제, 없으면 가장 최근 결제
    const picked = await db.query(
      db.raw.sql`SELECT o.id, o.status::text AS status, o.offering_id::text AS offering_id,
                        c.title || ' · ' || co.label AS title, a.name AS academy_name,
                        COALESCE(r.seat_kind::text, '') AS seat_kind, COALESCE(p.method::text, '') AS method,
                        o.total_amount::int4 AS total_amount,
                        (SELECT COALESCE(sum(rf.refunded_amount), 0)::int4
                           FROM refunds rf JOIN payments rp ON rp.id = rf.payment_id
                          WHERE rp.order_id = o.id AND rf.status = 'succeeded') AS refunded_amount,
                        to_char(o.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                        COALESCE(to_char(o.paid_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS paid_at,
                        CASE WHEN o.status = 'pending' THEN COALESCE(to_char(p.due_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') ELSE '' END AS due_at
                 FROM orders o
                 JOIN class_offerings co ON co.id = o.offering_id
                 JOIN classes c ON c.id = co.class_id
                 JOIN academies a ON a.id = c.academy_id
                 LEFT JOIN LATERAL (SELECT seat_kind FROM reservations WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) r ON true
                 LEFT JOIN LATERAL (SELECT method, due_at FROM payments WHERE order_id = o.id
                                     ORDER BY (status IN ('ready', 'paid')) DESC, created_at DESC LIMIT 1) p ON true
                 WHERE o.member_id = ${member.memberId}::uuid
                   AND (${statusCsv} = '' OR o.status::text = ANY (string_to_array(${statusCsv}, ',')))
                   AND (o.created_at, o.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                 ORDER BY o.created_at DESC, o.id DESC
                 LIMIT ${pageSize + 1}::int`
        .returnsRow({
          id: "pg/uuid@1",
          status: "pg/text@1",
          offering_id: "pg/text@1",
          title: "pg/text@1",
          academy_name: "pg/text@1",
          seat_kind: "pg/text@1",
          method: "pg/text@1",
          total_amount: "pg/int4@1",
          refunded_amount: "pg/int4@1",
          created_at: "pg/text@1",
          paid_at: "pg/text@1",
          due_at: "pg/text@1",
        })
        .build(),
    );

    const page = picked.slice(0, pageSize);
    const last = page.at(-1);
    // 넘친 하나가 있으면 이 쪽의 마지막 행이 다음 커서다. 없으면 마지막 쪽(null)
    const nextCursor =
      picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.created_at, id: last.id }) : null;

    const body: MeOrderList = {
      items: page.map((row) => ({
        orderId: row.id,
        // 상태·자리·결제수단은 DB CHECK(enum)가 지키는 값이다. 예약·결제가 없는 주문은 데이터가 깨진 것이라 아래 parse 가 500 으로 드러낸다
        status: row.status as OrderStatus,
        offeringId: row.offering_id,
        title: row.title,
        academyName: row.academy_name,
        seatKind: row.seat_kind as SeatKind,
        method: row.method as PaymentMethod,
        totalAmount: row.total_amount,
        refundedAmount: row.refunded_amount,
        createdAt: row.created_at,
        paidAt: row.paid_at === "" ? null : row.paid_at,
        dueAt: row.due_at === "" ? null : row.due_at,
        receipt: { academyUrl: null, companyUrl: null, cashReceiptIssued: false },
      })),
      nextCursor,
    };
    // 응답을 계약 스키마로 한 번 더 검사한다 — 카드번호·계좌 같은 칸이 섞여 나가거나 값이 깨졌으면 여기서 막힌다
    return Response.json(meOrderListSchema.parse(body), { headers: NO_STORE });
  });
}
