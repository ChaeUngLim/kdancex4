// S3-5.1(대표 주문 목록 API) — 대표가 자기 학원의 주문·결제를 걸러 보고, 한 주문의 결제·환불 이력을 펼친다.
//   계약: _workspace/03_contracts/18-after-payment-views.md §1-1(권한) · §2(대표 주문 목록 — 목록 2-1 · 이력 펼침 2-2)
//   데이터: data-model §15 읽기 지도 S3-5 FR-079a 행 — orders → class_offerings → classes(academy_id) · payments · order_events · refunds
//   요구: FR-079a(대표 주문·결제 목록) · FR-298(주문 상태 6종) · FR-299(카드·계좌 번호는 내리지 않는다) · FR-019a(닉네임만)
//   보드: W10(관리자 웹 주문·결제) · O45(대표 앱 주문·결제 찾기)
//
// 흐름 한눈에 — 대표 확인 → 쿼리 검사 → 기한 지난 결제 대기 정리 → 이 학원 주문만 최신순으로 한 쪽:
//   ① 그 학원의 대표만 통과한다(consoleRoute permission "owner"). 위임 강사(roster_manage)는 이 경로 전체가 403 이다 —
//      위임 권한은 명단·수업까지이고 돈 이야기(결제 금액·수단)는 대표만 본다(계약 §1-1 「§2 주문 목록 · 위임 강사 -」).
//      관리자 웹(W10)과 대표 앱(O45)이 같은 경로를 부르므로 appToo 를 켠다 — 앱 Bearer 는 2단계를 묻지 않고, 웹 쿠키는 묻는다.
//   ② from·to(KST 달력, 주문 생성일)·classId·status(6종 쉼표)·method·q·limit·cursor 를 검사한다. 틀리면 422.
//   ③ 이 학원의 결제 대기 중 기한이 지난 것을 먼저 닫는다(회원 결제 내역 me-orders 와 같은 「읽기 전 정리」).
//      그래야 대표 목록은 「입금 대기」인데 회원 앱에서는 「만료」인 어긋남이 생기지 않는다.
//   ④ 주문에는 academy_id 칸이 없어 orders.offering_id → class_offerings → classes.academy_id 로 학원을 찾는다.
//      이 조건 하나가 「다른 학원 주문 0건」을 지킨다.
//
// 내리지 않는 것: 회원 본명·생년월일·전체 연락처(닉네임만, FR-019a) · 카드번호·가상계좌 번호·환불 계좌(FR-299) · PG 결제 id.
// 환불 요청(refund_requests)은 M4 의 환불 슬라이스가 만드는 표라 아직 없다 — 그때까지 refundRequest 는 늘 null 이다.
import { z } from "zod";

import { CLASS_KINDS, ORDER_STATUSES, PAYMENT_METHODS, type ClassKind, type OrderStatus, type PaymentMethod } from "../../domain/constants";
import { kstDateRangeToInstants, kstToday, parseKstDate } from "../../domain/time";
import { createConsoleRoute } from "../console-route";
import type { ServerDeps } from "../deps";
import type { GuardDeps } from "../guards";
import { HttpError, parseWith } from "../http";
import { expireDuePayments } from "./order-expiry";
import { decodeNotificationCursor, encodeNotificationCursor } from "./staff-notifications";

export type OwnerOrdersDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway">;

/** 한 쪽 기본·최대 개수(계약 §2-1 「limit 기본 20, 최대 50」) */
export const OWNER_ORDERS_DEFAULT_PAGE_SIZE = 20;
export const OWNER_ORDERS_MAX_PAGE_SIZE = 50;
/** 한 번에 볼 수 있는 기간의 최대 일수(계약 §2 오류표 「기간 366일 초과」 — 추천값). 1년치 표를 넘는 조회를 막는다 */
export const OWNER_ORDERS_MAX_RANGE_DAYS = 366;
/** 검색어 최대 길이 — 닉네임(12자)·수업명이 들어가면 충분하다 */
const Q_MAX = 50;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
// 커서용 시각은 마이크로초까지(DB 값과 정확히 같아야 겹침·빠짐이 없다), 화면용 시각은 초까지
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const ISO_S_SQL = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

const DETAIL = {
  academyNotFound: "학원을 찾을 수 없어요",
  orderNotFound: "주문을 찾을 수 없어요",
  badStatus: `주문 상태는 ${ORDER_STATUSES.join(", ")} 중에서 골라 주세요`,
  badCursor: "목록 위치(cursor)가 올바르지 않아요. 처음부터 다시 불러 주세요",
  badDate: "날짜는 YYYY-MM-DD 로 적어 주세요",
  badRange: "끝 날짜가 시작 날짜보다 앞이에요",
  tooLong: `한 번에 ${OWNER_ORDERS_MAX_RANGE_DAYS}일까지만 볼 수 있어요`,
} as const;

/** 수업 구분 한글 이름 — kindLabel(「정규 12/01~12/29 · 5회」)의 앞부분. 앱의 강사 등록 화면(class-api.ts)과 같은 글자 */
export const CLASS_KIND_NAMES: Readonly<Record<ClassKind, string>> = {
  regular: "정규",
  private_lesson: "개인 레슨",
  basic: "베이직",
  lady_style: "레이디 스타일",
  one_day: "원데이",
  event: "이벤트",
  party: "파티",
  performance: "공연",
  competition: "대회",
};

/** 결제 수단 한글 이름 — 이력 펼침의 「결제 완료 · 신용카드」 글자. 회원 앱 결제 내역(orders-view.ts)과 맞췄다 */
const METHOD_NAMES: Readonly<Record<PaymentMethod, string>> = {
  card: "신용카드",
  easy_pay: "간편결제",
  easy_transfer: "간편 계좌이체",
  virtual_account: "계좌이체",
};

// ---- 요청 스키마(계약 §2-1 쿼리) ---------------------------------------------------------------

const kstDate = z
  .string()
  .max(10)
  .transform((value, ctx) => {
    try {
      return parseKstDate(value);
    } catch {
      ctx.addIssue({ code: "custom", message: DETAIL.badDate });
      return z.NEVER;
    }
  });

export const ownerOrdersQuerySchema = z.strictObject({
  from: kstDate.optional(),
  to: kstDate.optional(),
  classId: z.uuid().optional(),
  // 「partially_refunded,refunded」처럼 쉼표로 여러 개(앱 O45 의 「환불」 칩). 6종 밖의 이름이 하나라도 있으면 422
  status: z
    .string()
    .max(200)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return [] as OrderStatus[];
      const names = value.split(",").map((name) => name.trim());
      if (names.some((name) => !(ORDER_STATUSES as readonly string[]).includes(name))) {
        ctx.addIssue({ code: "custom", message: DETAIL.badStatus });
        return z.NEVER;
      }
      return [...new Set(names)] as OrderStatus[];
    }),
  method: z.enum(PAYMENT_METHODS).optional(),
  q: z.string().trim().max(Q_MAX).optional(),
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
  limit: z.coerce.number().int().min(1).max(OWNER_ORDERS_MAX_PAGE_SIZE).optional(),
});

// ---- 응답 스키마(계약 §2-1 · §2-2) — 테스트가 이 스키마로 parse 한다(strict: 모르는 키가 섞이면 실패) ----

const isoInstant = z.iso.datetime({ offset: true });

export const ownerOrderSchema = z.strictObject({
  orderId: z.uuid(),
  createdAt: isoInstant,
  // 회원은 닉네임만 — 본명·연락처 칸이 아예 없다(FR-019a)
  member: z.strictObject({ memberId: z.uuid(), nickname: z.string() }),
  class: z.strictObject({
    classId: z.uuid(),
    offeringId: z.uuid(),
    title: z.string(),
    kindLabel: z.string(),
    classKind: z.enum(CLASS_KINDS),
  }),
  // orders.total_amount — 회원이 낸 금액(예매 수수료 포함), 원 정수
  amount: z.number().int().nonnegative(),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(ORDER_STATUSES),
  paidAt: isoInstant.nullable(),
  // 입금 기한 — 결제 대기 + 가상계좌일 때만(O45 「11/14까지」)
  dueAt: isoInstant.nullable(),
  // 처리 전 환불 요청 한 건. 환불 요청 표(M4)가 생기기 전에는 늘 null
  refundRequest: z
    .strictObject({ requestId: z.uuid(), status: z.enum(["received", "in_progress"]), kind: z.string() })
    .nullable(),
});
export type OwnerOrder = z.infer<typeof ownerOrderSchema>;

export const ownerOrderListSchema = z.strictObject({
  items: z.array(ownerOrderSchema),
  nextCursor: z.string().nullable(),
});
export type OwnerOrderList = z.infer<typeof ownerOrderListSchema>;

export const ORDER_TIMELINE_KINDS = [
  "order_created",
  "paid",
  "expired",
  "cancelled",
  "refund_requested",
  "refund_completed",
  "refund_rejected",
] as const;
export type OrderTimelineKind = (typeof ORDER_TIMELINE_KINDS)[number];

export const orderTimelineItemSchema = z.strictObject({
  at: isoInstant,
  kind: z.enum(ORDER_TIMELINE_KINDS),
  label: z.string(),
  detail: z.string().nullable(),
  amount: z.number().int().nonnegative().nullable(),
});
export type OrderTimelineItem = z.infer<typeof orderTimelineItemSchema>;

export const ownerOrderDetailSchema = z.strictObject({
  orderId: z.uuid(),
  status: z.enum(ORDER_STATUSES),
  amount: z.number().int().nonnegative(),
  // 완료(succeeded)된 환불의 합계
  refundedAmount: z.number().int().nonnegative(),
  timeline: z.array(orderTimelineItemSchema),
});
export type OwnerOrderDetail = z.infer<typeof ownerOrderDetailSchema>;

// ---- 순수 규칙(DB 없이 시험한다) ---------------------------------------------------------------

/**
 * 검색어 해석 — 닉네임·수업명 부분 일치, 숫자 4자리만이면 연락처 뒷 4자리도 본다(계약 §2-1 `q`).
 * LIKE 의 특수 글자(% _ \)는 그대로 찾도록 막는다 — 「%」 한 글자로 모든 주문이 걸리지 않게.
 */
export function interpretOrderSearch(raw: string | undefined): { like: string; phoneLast4: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { like: "", phoneLast4: "" };
  return { like: text.replace(/[\\%_]/g, (ch) => `\\${ch}`), phoneLast4: /^\d{4}$/.test(text) ? text : "" };
}

/** 이력 줄을 최신이 먼저 오게 늘어놓는다. 같은 시각이면 나중 단계(결제 → 신청 순으로 거꾸로)가 위다 */
export function sortTimeline(items: readonly OrderTimelineItem[]): OrderTimelineItem[] {
  const stage = (kind: OrderTimelineKind) => ORDER_TIMELINE_KINDS.indexOf(kind);
  return [...items].sort((a, b) => {
    const byTime = Temporal.Instant.compare(Temporal.Instant.from(b.at), Temporal.Instant.from(a.at));
    return byTime !== 0 ? byTime : stage(b.kind) - stage(a.kind);
  });
}

// ---- 공통: 경로 id ------------------------------------------------------------------------------

type AcademyParams = { params: Promise<{ academyId: string }> };
type OrderParams = { params: Promise<{ academyId: string; orderId: string }> };

/** 모양이 틀린 id 는 DB 에 넘기지 않고 404 로 답한다(형 변환 오류 500 을 막는다) */
function uuidOr404(value: string, detail: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError("NOT_FOUND", detail);
  return parsed.data;
}

/** ③ 이 학원의 기한 지난 결제 대기를 판매 단위별로 닫는다. 대상이 없으면(대부분) 읽기 한 번으로 끝난다 */
export async function expireAcademyDuePayments(deps: Pick<OwnerOrdersDeps, "db" | "clock" | "paymentGateway">, academyId: string, orderId?: string): Promise<void> {
  const { db } = deps;
  const now = deps.clock().toString();
  // raw 태그는 null 을 받지 않아 「주문 하나로 좁히지 않음」을 빈 글자로 나타낸다
  const onlyOrder = orderId ?? "";
  const due = await db.query(
    db.raw.sql`SELECT DISTINCT o.offering_id
               FROM orders o
               JOIN payments p ON p.order_id = o.id
               JOIN class_offerings co ON co.id = o.offering_id
               JOIN classes c ON c.id = co.class_id
               WHERE c.academy_id = ${academyId}::uuid AND o.status = 'pending'
                 AND p.status = 'ready' AND p.due_at <= ${now}::timestamptz
                 AND (${onlyOrder} = '' OR o.id::text = ${onlyOrder})`
      .returnsRow({ offering_id: "pg/uuid@1" })
      .build(),
  );
  for (const row of due) await expireDuePayments(deps, { offeringId: row.offering_id });
}

// ---- 목록 ---------------------------------------------------------------------------------------

/** `GET /api/academies/{academyId}/orders` — 이 학원 주문 최신순 `{items, nextCursor}` (대표만) */
export function createOwnerOrdersRoute(deps: OwnerOrdersDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<AcademyParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (request, context) => {
      const academyId = uuidOr404((await context.params).academyId, DETAIL.academyNotFound);
      const query = parseWith(ownerOrdersQuerySchema, Object.fromEntries(new URL(request.url).searchParams));
      const pageSize = query.limit ?? OWNER_ORDERS_DEFAULT_PAGE_SIZE;

      // 기간 기본값 = 이번 달 1일 ~ 오늘(KST). 한쪽만 주면 다른 쪽은 기본값을 쓴다
      const today = kstToday(deps.clock);
      const from = query.from ?? today.with({ day: 1 });
      const to = query.to ?? today;
      if (Temporal.PlainDate.compare(from, to) > 0) {
        throw new HttpError("VALIDATION_FAILED", DETAIL.badRange, { fields: [{ path: "from", message: DETAIL.badRange }] });
      }
      if (from.until(to).days + 1 > OWNER_ORDERS_MAX_RANGE_DAYS) {
        throw new HttpError("VALIDATION_FAILED", DETAIL.tooLong, { fields: [{ path: "to", message: DETAIL.tooLong }] });
      }
      const { start, endExclusive } = kstDateRangeToInstants(from, to);

      await expireAcademyDuePayments(deps, academyId);

      // 커서가 없으면 '+infinity' 와 가장 큰 id — 모든 행이 그 앞이다(회원 결제 내역과 같은 방식)
      const beforeTime = query.cursor?.createdAt ?? "infinity";
      const beforeId = query.cursor?.id ?? "ffffffff-ffff-ffff-ffff-ffffffffffff";
      // raw 태그는 배열·null 을 받지 않는다 — 쉼표 글자·빈 글자로 넘기고 SQL 에서 「빈 글자 = 거르지 않음」으로 읽는다
      const statusCsv = query.status.join(",");
      const classId = query.classId ?? "";
      const method = query.method ?? "";
      const search = interpretOrderSearch(query.q);

      // ④ 한 쪽 + 하나 더 읽어 다음 쪽이 있는지 안다. 결제는 회원 결제 내역과 같은 규칙으로 하나 고른다 —
      //    살아 있는(ready·paid) 결제, 없으면 가장 최근 결제. 가상계좌 번호·PG id 칸은 SELECT 에 넣지도 않는다(FR-299)
      const picked = await db.query(
        db.raw.sql`SELECT o.id, to_char(o.created_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS created_at,
                          m.id AS member_id, m.nickname,
                          c.id AS class_id, co.id AS offering_id, c.title, c.class_kind::text AS class_kind, co.label AS offering_label,
                          o.total_amount::int4 AS amount, COALESCE(p.method::text, '') AS method, o.status::text AS status,
                          COALESCE(to_char(o.paid_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') AS paid_at,
                          CASE WHEN o.status = 'pending' AND p.method = 'virtual_account'
                               THEN COALESCE(to_char(p.due_at AT TIME ZONE 'UTC', ${ISO_S_SQL}), '') ELSE '' END AS due_at
                   FROM orders o
                   JOIN class_offerings co ON co.id = o.offering_id
                   JOIN classes c ON c.id = co.class_id
                   JOIN members m ON m.id = o.member_id
                   LEFT JOIN LATERAL (SELECT method, due_at FROM payments WHERE order_id = o.id
                                       ORDER BY (status IN ('ready', 'paid')) DESC, created_at DESC LIMIT 1) p ON true
                   WHERE c.academy_id = ${academyId}::uuid
                     AND o.created_at >= ${start.toString()}::timestamptz AND o.created_at < ${endExclusive.toString()}::timestamptz
                     AND (${classId} = '' OR c.id::text = ${classId})
                     AND (${statusCsv} = '' OR o.status::text = ANY (string_to_array(${statusCsv}, ',')))
                     AND (${method} = '' OR p.method::text = ${method})
                     AND (${search.like} = ''
                          OR m.nickname ILIKE '%' || ${search.like} || '%'
                          OR c.title ILIKE '%' || ${search.like} || '%'
                          OR (${search.phoneLast4} <> '' AND right(regexp_replace(m.phone, '[^0-9]', '', 'g'), 4) = ${search.phoneLast4}))
                     AND (o.created_at, o.id) < (${beforeTime}::timestamptz, ${beforeId}::uuid)
                   ORDER BY o.created_at DESC, o.id DESC
                   LIMIT ${pageSize + 1}::int`
          .returnsRow({
            id: "pg/uuid@1",
            created_at: "pg/text@1",
            member_id: "pg/uuid@1",
            nickname: "pg/text@1",
            class_id: "pg/uuid@1",
            offering_id: "pg/uuid@1",
            title: "pg/text@1",
            class_kind: "pg/text@1",
            offering_label: "pg/text@1",
            amount: "pg/int4@1",
            method: "pg/text@1",
            status: "pg/text@1",
            paid_at: "pg/text@1",
            due_at: "pg/text@1",
          })
          .build(),
      );

      const page = picked.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        picked.length > pageSize && last !== undefined ? encodeNotificationCursor({ createdAt: last.created_at, id: last.id }) : null;

      const body: OwnerOrderList = {
        items: page.map((row) => {
          const classKind = row.class_kind as ClassKind;
          return {
            orderId: row.id,
            createdAt: row.created_at,
            member: { memberId: row.member_id, nickname: row.nickname },
            class: {
              classId: row.class_id,
              offeringId: row.offering_id,
              title: row.title,
              // 「정규 12/01~12/29 · 5회」 — 수업 구분 + 신청 단위 이름(O45 줄의 둘째 줄)
              kindLabel: `${CLASS_KIND_NAMES[classKind] ?? classKind} ${row.offering_label}`,
              classKind,
            },
            amount: row.amount,
            // 상태·수단은 DB CHECK 가 지키는 값이다. 결제 행이 없는 주문은 데이터가 깨진 것이라 아래 parse 가 500 으로 드러낸다
            method: row.method as PaymentMethod,
            status: row.status as OrderStatus,
            paidAt: row.paid_at === "" ? null : row.paid_at,
            dueAt: row.due_at === "" ? null : row.due_at,
            refundRequest: null,
          };
        }),
        nextCursor,
      };
      // 계약 스키마로 한 번 더 검사한다 — 연락처·계좌 같은 칸이 섞여 나가면 여기서 막힌다
      return Response.json(ownerOrderListSchema.parse(body), { headers: NO_STORE });
    },
  );
}

// ---- 이력 펼침 ----------------------------------------------------------------------------------

/** 주문 취소 사유(order_events.reason) → 이력 줄의 보조 글자 */
function cancelDetail(reason: string): string | null {
  if (reason === "self_cancel_unpaid") return "회원이 입금 전에 취소";
  if (reason === "결제 실패") return "결제 실패";
  return null;
}

/** `GET /api/academies/{academyId}/orders/{orderId}` — 한 주문의 결제·환불 이력(최신이 먼저, 대표만) */
export function createOwnerOrderDetailRoute(deps: OwnerOrdersDeps) {
  const consoleRoute = createConsoleRoute(deps);
  const { db } = deps;

  return consoleRoute<OrderParams>(
    { permission: "owner", academyId: async (ctx) => (await ctx.params).academyId, appToo: true },
    async (_request, context) => {
      const params = await context.params;
      const academyId = uuidOr404(params.academyId, DETAIL.academyNotFound);
      const orderId = uuidOr404(params.orderId, DETAIL.orderNotFound);

      await expireAcademyDuePayments(deps, academyId, orderId);

      // 주문이 이 학원 것인지 함께 본다 — 다른 학원 주문은 「없음」(404)으로 답한다(계약 §2 오류표 「다른 학원 소속(상세)」)
      const [order] = await db.query(
        db.raw.sql`SELECT o.id, o.status::text AS status, o.total_amount::int4 AS amount,
                          to_char(o.created_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS created_at
                   FROM orders o
                   JOIN class_offerings co ON co.id = o.offering_id
                   JOIN classes c ON c.id = co.class_id
                   WHERE o.id = ${orderId}::uuid AND c.academy_id = ${academyId}::uuid`
          .returnsRow({ id: "pg/uuid@1", status: "pg/text@1", amount: "pg/int4@1", created_at: "pg/text@1" })
          .build(),
      );
      if (order === undefined) throw new HttpError("NOT_FOUND", DETAIL.orderNotFound);

      // 결제 완료 시각(결제 행마다) — 카드번호·계좌번호 칸은 읽지 않는다
      const paidRows = await db.query(
        db.raw.sql`SELECT p.method::text AS method, p.amount::int4 AS amount,
                          to_char(p.paid_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS paid_at
                   FROM payments p WHERE p.order_id = ${orderId}::uuid AND p.paid_at IS NOT NULL`
          .returnsRow({ method: "pg/text@1", amount: "pg/int4@1", paid_at: "pg/text@1" })
          .build(),
      );
      // 만료·취소는 주문 상태 기록(order_events)에서. 환불 완료는 refunds 에서 읽으므로 refunded 전이는 여기서 빼서 겹치지 않게 한다
      const closeRows = await db.query(
        db.raw.sql`SELECT e.to_status::text AS to_status, e.reason,
                          to_char(e.created_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS at
                   FROM order_events e WHERE e.order_id = ${orderId}::uuid AND e.to_status IN ('expired', 'cancelled')`
          .returnsRow({ to_status: "pg/text@1", reason: "pg/text@1", at: "pg/text@1" })
          .build(),
      );
      // 완료된 환불만 「환불 완료」 줄이 된다. 환불 계좌 칸은 읽지 않는다(FR-299)
      const refundRows = await db.query(
        db.raw.sql`SELECT rf.refunded_amount::int4 AS amount, to_char(rf.updated_at AT TIME ZONE 'UTC', ${ISO_S_SQL}) AS at
                   FROM refunds rf JOIN payments p ON p.id = rf.payment_id
                   WHERE p.order_id = ${orderId}::uuid AND rf.status = 'succeeded'`
          .returnsRow({ amount: "pg/int4@1", at: "pg/text@1" })
          .build(),
      );

      const timeline: OrderTimelineItem[] = [
        { at: order.created_at, kind: "order_created", label: "수업 신청 · 결제 시작", detail: null, amount: null },
        ...paidRows.map((row): OrderTimelineItem => ({
          at: row.paid_at,
          kind: "paid",
          label: `결제 완료 · ${METHOD_NAMES[row.method as PaymentMethod] ?? row.method}`,
          detail: null,
          amount: row.amount,
        })),
        ...closeRows.map((row): OrderTimelineItem =>
          row.to_status === "expired"
            ? { at: row.at, kind: "expired", label: "입금 기한 지남", detail: null, amount: null }
            : { at: row.at, kind: "cancelled", label: "주문 취소", detail: cancelDetail(row.reason), amount: null },
        ),
        ...refundRows.map((row): OrderTimelineItem => ({
          at: row.at,
          kind: "refund_completed",
          label: "환불 완료",
          detail: null,
          amount: row.amount,
        })),
      ];

      const body: OwnerOrderDetail = {
        orderId: order.id,
        status: order.status as OrderStatus,
        amount: order.amount,
        refundedAmount: refundRows.reduce((sum, row) => sum + row.amount, 0),
        timeline: sortTimeline(timeline),
      };
      return Response.json(ownerOrderDetailSchema.parse(body), { headers: NO_STORE });
    },
  );
}
