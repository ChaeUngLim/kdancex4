// S3-3.4(주문 생성 API) — `POST /api/orders`(결제 시작). 계약: _workspace/03_contracts/03-checkout-payment.md §1·§3·§4 · §8 M-04
//   요구: FR-096(결제 대기 자리 잠금) · FR-283(결제액 계산 순서) · FR-284(주문 시점 값 고정) · FR-285(결제 기한) ·
//         FR-298b(결제 멱등성·금액 재계산) · FR-009(미성년자 결제 차단) · FR-250·FR-254(사업자 휴·폐업이면 새 결제 막음, S3-3.4a)
//
// 한 줄로: 회원이 「결제하기」를 누르면 서버가 금액을 직접 계산해 주문에 박아 두고, 자리 하나를 결제 대기(held)로 잡은 뒤
//          PG 에 결제(가상계좌 또는 결제창)를 만든다. 이 넷이 한 트랜잭션이라 하나라도 실패하면 아무것도 남지 않는다.
//
// 같은 요청이 두 번 오면(버튼 두 번 · 네트워크 재시도 · 결제창을 닫고 다시 누름) 새 주문을 만들지 않는다. 판단은 둘이다.
//   ① 같은 회원·같은 Idempotency-Key → 처음 주문을 200 으로(본문이 달라도 처음 것). 권위는 DB 유니크 uq_orders_member_idempotency
//   ② 다른 키라도 같은 판매 단위에 결제 대기(held) 예약이 있으면 → 그 주문을 200 으로(M-04 진행 중 주문 복구 · S3-3 수용 ③).
//      확정(confirmed) 예약이 있으면 409 ALREADY_RESERVED. 권위는 DB 유니크 uq_reservations_member_offering_active
//   두 유니크는 「먼저 읽어 보고 없으면 만든다」 사이에 끼어든 동시 요청까지 막는다 — 진 쪽은 유니크 위반으로 롤백되고
//   이긴 쪽의 주문을 다시 읽어 같은 답을 준다.
//
// S3-3.12(0원 주문)가 더한 것 — 9단계 자리(아래 `confirmFreeOrder`, M-05(0원 신청) · 플랜 S3-3 수용 ⑥):
//   최종 결제액이 0원이면 PG 를 부르지 않는다. 받을 돈이 없으니 기다릴 입금도 없다 — 결제 기한 검사(5단계)를 건너뛰고,
//   PG 에 보내지 않는 번호로 결제 행을 만든 뒤 같은 트랜잭션에서 웹훅과 같은 확정 함수(confirmOrder)로 바로 paid 로 바꾼다.
//
// S3-3.13(결제 시작·웹훅 요청 제한)이 더한 것 — 회원 확인 바로 뒤 `checkoutRateLimit`(플랜 S3-3 수용 ⑦ · R28):
//   한 회원이 1분에 10회(추천값)를 넘게 결제를 시작하면 429 RATE_LIMITED. IP 가 아니라 **회원**으로 센다 —
//   학원 한 곳이 공유기 하나(IP 하나)로 여럿 접속하니 IP 로 세면 수업 직전 결제가 몰릴 때 남까지 막힌다.
//
// 이 Task 가 하지 않는 것(같은 슬라이스의 다른 Task — 증거 EVIDENCE.md 에 적었다):
//   쿠폰·대기 기회·자녀 수강 등 다른 계약이 더하는 칸(README §0)
import { randomUUID } from "node:crypto";

import { computeOrderAmounts, CANCEL_FEE_PLATFORM_SHARE_BP, seatKindFitsMode, TERMS_VERSION_UNRECORDED } from "../../domain/checkout";
import { CLASS_KINDS, SEAT_MODES, type ClassKind, type PaymentMethod } from "../../domain/constants";
import { INTERMEDIARY_NOTICE } from "../../domain/intermediary-notice";
import { isPaymentMethodAllowed } from "../../domain/payment-methods";
import { computeDueAt, loadDeadlineConfig, type DeadlineConfig } from "../../domain/payment-deadline";
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, parseJsonBody, readIdempotencyKey, withRoute } from "../http";
import type { RateLimiter, RateLimitRule } from "../rate-limit";
import { ORDER_SNAPSHOT_COLUMNS_SQL, orderSnapshotValuesSql } from "../order-snapshot";
import { readAppliedPlatformFee } from "../platform-fee-rate";
import { createOrderRequestSchema, orderResponseSchema, type CreateOrderRequest, type OrderResponse } from "../schemas/orders";
import { assertMemberCanStartPayment } from "./member-payment-age-guard";
import { expireDuePayments } from "./order-expiry";
import { confirmOrder, FREE_ORDER_CONFIRMED_REASON } from "./payment-webhook";
import type { Tx } from "./staff-signup";

export type OrderCreateDeps = GuardDeps &
  Pick<ServerDeps, "clock" | "paymentGateway"> & {
    /** 결제 기한 설정(전제 18). 생략하면 요청마다 환경 변수에서 읽는다 — 테스트는 값을 직접 넘긴다 */
    readonly deadlineConfig?: DeadlineConfig;
  };

const DETAIL = {
  notFound: "수업을 찾을 수 없어요",
  closed: "신청이 마감된 수업이에요",
  deadlinePassed: "결제 기한을 맞출 수 없어 지금은 신청할 수 없어요",
  noticeMissing: "학원의 환불·취소 공지가 없어 결제를 시작할 수 없어요",
  seatKind: "이 수업에서 고를 수 없는 자리예요",
  soldOut: "남은 자리가 없어요",
  alreadyReserved: "이미 신청을 마친 수업이에요",
  salesBlocked: "지금은 이 학원의 새 신청을 받을 수 없어요",
  methodNotAllowed: "이 수업은 계좌이체(간편 계좌이체·가상계좌)로만 결제할 수 있어요",
} as const;

/** 409 ACADEMY_RESTRICTED 의 reason — 사업자 점검이 연 「새 결제 막음」(academy_restrictions.kind 와 같은 글자) */
const SALES_BLOCKED_REASON = "new_sales_blocked";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const ISO_US_SQL = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** order_events 의 첫 줄 사유 — 「결제 시작으로 주문이 생겼다」 */
const CREATED_REASON = "checkout_started";

type CreateResult = { created: boolean; body: OrderResponse };

/** 결제 시작 요청 제한 재료(S3-3.13). rule 은 보통 loadRateLimitRules().checkoutStart */
export type CheckoutRateLimit = { readonly limiter: RateLimiter; readonly rule: RateLimitRule };

/**
 * `POST /api/orders` 처리기. 순서: 회원 확인 → 요청 제한 → Idempotency-Key → 본문 → 주문 만들기(계약 03 §1)
 * 앱 경로(app/api/orders/route.ts)는 checkoutRateLimit 을 반드시 넘긴다. 생략은 제한과 상관없는 테스트용이다.
 */
export function createOrderRoute(deps: OrderCreateDeps, options: { checkoutRateLimit?: CheckoutRateLimit } = {}) {
  const guards = createGuards(deps);
  return withRoute(async (request) => {
    const { memberId } = await guards.requireMember(request);
    // 요청 제한 — 같은 키 재요청(버튼 두 번)도 한 번으로 센다. 본문·키 검사 앞이라 엉터리 요청을 쏟아 내도 같은 칸에 쌓인다.
    // 회원 확인 뒤에 두는 이유: 로그인 안 한 요청은 401 로 끝나 셀 대상(회원)이 없다
    const limit = options.checkoutRateLimit;
    if (limit !== undefined) await limit.limiter.consume(limit.rule, [`member:${memberId}`]);
    const key = readIdempotencyKey(request, { required: true });
    const input = await parseJsonBody(request, createOrderRequestSchema);
    const result = await createOrder(deps, { memberId, key, input });
    return Response.json(result.body, { status: result.created ? 201 : 200, headers: NO_STORE });
  });
}

/** 주문 만들기 본체. 새로 만들었으면 created=true(201), 이미 있던 주문을 돌려주면 false(200) */
export async function createOrder(
  deps: OrderCreateDeps,
  args: { memberId: string; key: string; input: CreateOrderRequest },
): Promise<CreateResult> {
  const { db } = deps;
  const { memberId, key, input } = args;

  // 0단계 — 만 19세 미만은 트랜잭션을 열기 전에 막는다(S3-1.3 가드). 주문·예약·결제 행이 하나도 안 생긴다
  await assertMemberCanStartPayment(db, memberId, deps.clock);

  // 2단계(계약 §1 · §5) — 이 판매 단위의 기한 지난 결제 대기를 먼저 정리한다(S3-3.7). 키 대조보다 앞에 두어
  // 기한이 지난 내 결제 대기를 「진행 중 주문」(M-04)으로 잘못 이어 주지 않고, 풀린 자리를 이번 주문이 잡을 수 있게 한다
  await expireDuePayments(deps, { offeringId: input.offeringId });

  // 1단계 — 같은 키 재요청이면 처음 주문 그대로
  const replay = await existingOrderFor(deps, memberId, key, input.offeringId);
  if (replay !== null) return replay;

  try {
    const orderId = await db.transaction((tx) => insertPendingOrder(deps, tx, { memberId, key, input }));
    return { created: true, body: await readOrderView(deps, orderId) };
  } catch (error: unknown) {
    // 동시 요청에 졌다 — 이긴 쪽 주문을 다시 읽어 같은 답으로 모은다
    if (isUniqueViolation(error, "uq_orders_member_idempotency") || isUniqueViolation(error, "uq_reservations_member_offering_active")) {
      const raced = await existingOrderFor(deps, memberId, key, input.offeringId);
      if (raced !== null) return raced;
    }
    throw error;
  }
}

/**
 * 이미 있는 주문을 찾는다 — ① 같은 키 ② 같은 판매 단위의 살아 있는 예약. 없으면 null.
 * 확정된 예약이면 새 결제를 시작할 일이 없으므로 409 ALREADY_RESERVED 를 던진다.
 */
async function existingOrderFor(deps: OrderCreateDeps, memberId: string, key: string, offeringId: string): Promise<CreateResult | null> {
  const { db } = deps;
  const [byKey] = await db.query(
    db.raw.sql`SELECT id FROM orders WHERE member_id = ${memberId}::uuid AND idempotency_key = ${key}`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (byKey !== undefined) return { created: false, body: await readOrderView(deps, byKey.id) };

  const [active] = await db.query(
    db.raw.sql`SELECT order_id, status::text AS status FROM reservations
               WHERE member_id = ${memberId}::uuid AND offering_id = ${offeringId}::uuid AND status IN ('held', 'confirmed')`
      .returnsRow({ order_id: "pg/uuid@1", status: "pg/text@1" })
      .build(),
  );
  if (active === undefined) return null;
  if (active.status === "confirmed") throw HttpError.conflict("ALREADY_RESERVED", DETAIL.alreadyReserved);
  // 결제 대기 중 — 결제창을 닫고 다시 누른 경우다. 새 주문 대신 그 결제 대기를 이어서 보여 준다(M-04)
  return { created: false, body: await readOrderView(deps, active.order_id) };
}

const OFFERING_ROW = {
  class_kind: "pg/text@1",
  seat_mode: "pg/text@1",
  offering_status: "pg/text@1",
  price_amount: "pg/int4@1",
  first_session_starts_at: "pg/text@1",
  order_name: "pg/text@1",
  refund_notice_version_id: "pg/text@1",
  merchant_terms_version: "pg/text@1",
  sales_blocked: "pg/bool@1",
} as const;

/** 3~9단계(계약 03 §1) — 한 트랜잭션. 만든 주문 id 를 돌려준다 */
async function insertPendingOrder(
  deps: OrderCreateDeps,
  tx: Tx,
  args: { memberId: string; key: string; input: CreateOrderRequest },
): Promise<string> {
  const { memberId, key, input } = args;
  const now = deps.clock();
  const at = now.toString();

  // 3단계 — 판매 단위. 홈 목록·상세와 같은 「보여도 되는」 조건(게시된 수업 · 활동 중 학원 · 노출 중지 없음)을 건다.
  // 공지 판본은 상세 화면이 보여 준 것과 같은 「수업에 붙은 판본」(classes.refund_notice_version_id)이다 — 회원이 본 정책을
  // 주문에 고정해야 하기 때문이다(FR-242(표시된 정책 우선)). 이 학원의 판본만 붙인다.
  // 입점 약관 판본은 그 학원이 동의한 가장 최근 merchant_terms 판본을 읽고, 기록이 없으면 「판본 없음」 글자를 쓴다.
  const [offering] = await tx.query(
    tx.raw.sql`SELECT c.class_kind::text AS class_kind, c.seat_mode::text AS seat_mode, o.status::text AS offering_status,
                      o.price_amount::int4 AS price_amount,
                      to_char(o.first_session_starts_at AT TIME ZONE 'UTC', ${ISO_US_SQL}) AS first_session_starts_at,
                      c.title || ' · ' || o.label AS order_name,
                      COALESCE(n.id::text, '') AS refund_notice_version_id,
                      COALESCE((SELECT tv.version FROM merchant_consents mc JOIN terms_versions tv ON tv.id = mc.terms_version_id
                                 WHERE mc.academy_id = a.id AND mc.item = 'merchant_terms' AND mc.withdrawn_at IS NULL
                                 ORDER BY mc.agreed_at DESC LIMIT 1), ${TERMS_VERSION_UNRECORDED}) AS merchant_terms_version,
                      EXISTS (SELECT 1 FROM academy_restrictions sb
                               WHERE sb.academy_id = a.id AND sb.kind = ${SALES_BLOCKED_REASON} AND sb.ended_at IS NULL) AS sales_blocked
                 FROM class_offerings o
                 JOIN classes c ON c.id = o.class_id
                 JOIN academies a ON a.id = c.academy_id
                 LEFT JOIN refund_notice_versions n ON n.id = c.refund_notice_version_id AND n.academy_id = a.id
                WHERE o.id = ${input.offeringId}::uuid
                  AND c.status = 'published'
                  AND a.status = 'active'
                  AND NOT EXISTS (SELECT 1 FROM academy_restrictions r
                                  WHERE r.academy_id = a.id AND r.kind = 'listing_suspended' AND r.ended_at IS NULL)`
      .returnsRow(OFFERING_ROW)
      .build(),
  );
  if (offering === undefined) throw new HttpError("NOT_FOUND", DETAIL.notFound);
  // 3-a단계(S3-3.4a) — 사업자 점검(S1-1.28)이 휴·폐업을 보고 「새 결제 막음」을 열어 둔 학원이면 새 주문을 받지 않는다.
  // 판정은 DB 에 열려 있는 제한 행(ended_at 이 빈 것)만 본다 — 국세청 API 는 새벽 점검 작업만 부르고, 요청 경로에서는
  // 부르지 않는다(회원 결제가 외부 API 의 느림·장애에 묶이지 않게). 자리·주문을 만들기 전이라 아무 행도 남지 않는다.
  // 이미 만든 주문·확정 예약은 건드리지 않는다(FR-250 「기존 결제분은 그대로」) — 같은 키 재요청·결제 대기 복구는
  // 위 1단계(existingOrderFor)가 트랜잭션 전에 돌려주므로 여기까지 오지 않는다.
  if (offering.sales_blocked) {
    throw HttpError.conflict("ACADEMY_RESTRICTED", DETAIL.salesBlocked, { reason: SALES_BLOCKED_REASON });
  }
  const firstSessionStartsAt = Temporal.Instant.from(offering.first_session_starts_at);
  // 닫힌 판매 단위 · 첫 회차가 이미 시작됨 → 신청 마감
  if (offering.offering_status !== "open" || Temporal.Instant.compare(now, firstSessionStartsAt) >= 0) {
    throw HttpError.conflict("CHECKOUT_CLOSED", DETAIL.closed);
  }
  const seatMode = parseFrom(SEAT_MODES, offering.seat_mode);
  if (!seatKindFitsMode(seatMode, input.seatKind)) {
    throw new HttpError("VALIDATION_FAILED", DETAIL.seatKind, { fields: [{ path: "seatKind", message: DETAIL.seatKind }] });
  }
  // 3-b단계(S3-3.6) — 상품 종류가 허용하지 않는 결제수단이면 거부한다. 이벤트형(원데이·이벤트·파티·공연·대회)은
  // 간편 계좌이체·가상계좌만 받는다(FR-280(결제수단 결정) · FR-111a(카드 허용 범위) 강제 방법 ②).
  // 왜 서버에서 또 보나: 결제 화면은 계좌 수단만 보여 주지만, 화면을 거치지 않고 API 를 직접 부르는 요청도 막아야 하기 때문이다.
  // 표는 결제 화면·결제 통지 처리와 같은 S3-3.1 판정(isPaymentMethodAllowed)을 쓴다 — 세 곳의 규칙이 갈리지 않게.
  // 자리 잡기·주문 INSERT·PG 호출 전이라 아무 행도 남지 않는다.
  const classKind = parseFrom(CLASS_KINDS, offering.class_kind) as ClassKind;
  if (!isPaymentMethodAllowed(classKind, input.method)) {
    throw HttpError.unprocessable("METHOD_NOT_ALLOWED", DETAIL.methodNotAllowed, {
      fields: [{ path: "method", message: DETAIL.methodNotAllowed }],
    });
  }

  // 4단계 — 회원이 확인할 환불·취소 공지가 있어야 결제를 시작한다(동의 여부는 본문 스키마가 이미 봤다)
  if (offering.refund_notice_version_id === "") throw new HttpError("NOTICE_MISSING", DETAIL.noticeMissing);

  // 6단계 — 금액은 서버가 판매 단위 가격으로 계산한다. 요청 본문에는 금액 칸 자체가 없다(FR-298b).
  // 기한(5단계)보다 먼저 계산한다 — 0원이면 기한을 따질 일이 없어서다(S3-3.12)
  const amounts = computeOrderAmounts(classKind, offering.price_amount);
  const isFree = amounts.total === 0;

  // 5단계 — 결제 기한(§4). 가상계좌인데 첫 회차까지 시간이 모자라 기한이 이미 지났으면 마감.
  // 0원은 기다릴 입금이 없으므로 기한을 지금 시각으로 두고 검사하지 않는다(바로 확정되니 만료 정리가 이 결제를 볼 일도 없다)
  const method: PaymentMethod = input.method;
  const dueAt = isFree
    ? now
    : computeDueAt({ method, issuedAt: now, firstSessionStartsAt, config: deps.deadlineConfig ?? loadDeadlineConfig() });
  if (!isFree && Temporal.Instant.compare(dueAt, now) <= 0) throw HttpError.conflict("CHECKOUT_CLOSED", DETAIL.deadlinePassed);

  // 주문 시각에 실제로 적용되는 판매 수수료율(S3-3.2a). 같은 트랜잭션에서 읽어 주문 칸에 고정한다
  const fee = await readAppliedPlatformFee(tx, { offeringId: input.offeringId, paidAt: now });
  if (fee === null) throw new HttpError("NOT_FOUND", DETAIL.notFound);

  // 7단계 — 자리 잡기(data-model §4-4). 0행이면 매진.
  //   먼저 자리 행을 FOR UPDATE 로 잠근다 — 현장 인원 고치기(S3-5.4)도 같은 행을 먼저 잠그므로, 둘이 동시에 와도 한 줄로 선다.
  //   잠금을 얻은 뒤의 다음 문장은 새로 찍은 스냅숏으로 읽으므로, 방금 커밋된 현장 인원까지 보고 판정한다.
  await tx.query(
    tx.raw.sql`SELECT id FROM seat_pools WHERE offering_id = ${input.offeringId}::uuid AND seat_kind = ${input.seatKind} FOR UPDATE`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  //   남은 자리 = 정원 − 잡힌 자리 − 확정 자리 − 앞으로 올 회차 중 현장 인원이 가장 큰 값(계약 18 §6 규칙 7).
  //   정규 과정은 한 번 결제로 모든 회차를 차지하므로, 가장 큰 현장 값만큼 비워 둬야 어느 회차도 정원을 넘지 않는다
  const [pool] = await tx.query(
    tx.raw.sql`UPDATE seat_pools SET held_count = held_count + 1, updated_at = ${at}::timestamptz
               WHERE offering_id = ${input.offeringId}::uuid AND seat_kind = ${input.seatKind}
                 AND held_count + confirmed_count
                     + COALESCE((SELECT max(sc.onsite_count) FROM session_seat_counters sc
                                 JOIN class_sessions s ON s.id = sc.session_id
                                 WHERE s.offering_id = seat_pools.offering_id AND sc.seat_kind = seat_pools.seat_kind
                                   AND s.status = 'scheduled' AND s.ends_at > ${at}::timestamptz), 0) < capacity
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (pool === undefined) {
    // 자리 묶음 자체가 없는 것(정원 방식과 안 맞는 자리)은 위 3단계가 이미 걸렀다 — 여기 오는 것은 정원이 다 찬 경우다
    throw HttpError.conflict("SEAT_SOLD_OUT", DETAIL.soldOut);
  }

  // 8단계 — 주문 pending(금액·공지 판본·약관 판본·수수료율·스냅샷 고정) · 예약 held · 주문 기록 1줄.
  // 스냅샷 칸(상품 종류·회차 수·첫 회차·환불 마감일·노쇼 판본)은 같은 문장 안의 서브쿼리가 판매 단위에서 베낀다(S3-3.2)
  const orderInsertText = `INSERT INTO orders (id, member_id, offering_id, status, list_price_amount, benefit_discount_amount,
                                   coupon_discount_amount, booking_fee_amount, total_amount, price_breakdown,
                                   refund_notice_version_id, intermediary_notice_version, member_terms_version,
                                   merchant_terms_version, platform_fee_rate_bp, cancel_fee_platform_share_bp,
                                   idempotency_key, updated_at, ${ORDER_SNAPSHOT_COLUMNS_SQL})
               VALUES (uuidv7(), $1::uuid, $2::uuid, 'pending', $3, $4, $5, $6, $7, $8::jsonb, $9::uuid, $10, $11, $12, $13, $14,
                       $15, $16::timestamptz, ${orderSnapshotValuesSql("$2")})
               RETURNING id`;
  const [order] = await tx.query(
    rawFromNumberedText(tx, orderInsertText, [
      memberId,
      input.offeringId,
      amounts.listPrice,
      amounts.benefitDiscount,
      amounts.couponDiscount,
      amounts.bookingFee,
      amounts.total,
      JSON.stringify(amounts.breakdown),
      offering.refund_notice_version_id,
      INTERMEDIARY_NOTICE.version,
      TERMS_VERSION_UNRECORDED,
      offering.merchant_terms_version,
      fee.rateBp,
      CANCEL_FEE_PLATFORM_SHARE_BP,
      key,
      at,
    ])
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (order === undefined) throw new Error("주문 행을 만들지 못했다");
  await tx.execute(
    tx.raw.sql`INSERT INTO reservations (id, order_id, offering_id, seat_pool_id, seat_kind, member_id, status, updated_at)
               VALUES (uuidv7(), ${order.id}::uuid, ${input.offeringId}::uuid, ${pool.id}::uuid, ${input.seatKind},
                       ${memberId}::uuid, 'held', ${at}::timestamptz)`
      .affectedCount()
      .build(),
  );
  await tx.execute(
    tx.raw.sql`INSERT INTO order_events (id, order_id, from_status, to_status, reason)
               VALUES (uuidv7(), ${order.id}::uuid, NULL, 'pending', ${CREATED_REASON})`
      .affectedCount()
      .build(),
  );

  // 9단계(0원) — PG 를 부르지 않고 바로 확정한다(S3-3.12)
  if (isFree) {
    await confirmFreeOrder(tx, { orderId: order.id, method, at });
    return order.id;
  }

  // 9단계 — PG 에 결제를 만들고 결제 행(ready)을 남긴다. 가짜 PG 는 즉시 답하는 메모리라 트랜잭션 안에 둔다(계약 03 §1 주의 · R-P3).
  // PG 가 실패하면 예외가 트랜잭션을 통째로 되돌린다 — 자리·주문·예약이 남지 않는다
  const gatewayPaymentId = gatewayPaymentIdFor();
  const issued = await deps.paymentGateway.createPayment({
    gatewayPaymentId,
    method,
    amount: amounts.total,
    dueAt,
    orderName: offering.order_name,
  });
  const va = issued.virtualAccount;
  await tx.execute(
    tx.raw.sql`INSERT INTO payments (id, order_id, method, amount, gateway_payment_id, status, due_at,
                                     virtual_account_bank_code, virtual_account_number, virtual_account_holder, updated_at)
               VALUES (uuidv7(), ${order.id}::uuid, ${method}, ${amounts.total}, ${gatewayPaymentId}, 'ready', ${dueAt.toString()}::timestamptz,
                       NULLIF(${va?.bankCode ?? ""}, ''), NULLIF(${va?.accountNumber ?? ""}, ''), NULLIF(${va?.holder ?? ""}, ''),
                       ${at}::timestamptz)`
      .affectedCount()
      .build(),
  );
  return order.id;
}

/**
 * 0원 주문 확정(S3-3.12 · M-05(0원 신청)). 주문 생성과 같은 트랜잭션 안에서 부른다.
 *
 * 왜 결제 행을 만드나: 주문 응답·환불·조회가 모두 「주문 하나에 살아 있는 결제 하나」(uq_payments_order_live)를 전제로 읽는다.
 * 0원이라고 결제 행을 빼면 그 경로마다 예외를 둬야 한다. 그래서 금액 0 짜리 결제 행을 두되, 번호는 `free_` 로 시작하게 만들어
 * PG 에 한 번도 보내지 않은 결제임이 드러나게 한다(PG 거래 번호·PG 가 말한 금액 칸은 비워 둔다).
 *
 * 확정은 웹훅과 같은 confirmOrder 로 한다 — 예약 confirmed · 자리 held −1 confirmed +1 · 캘린더 · 확정 알림 2건이 유료 확정과
 * 똑같이 남는다. 정산 보류는 confirmOrder 가 0원이면 쓰지 않는다. 확정에 실패하면(카운터 어긋남 등) 예외가 주문 생성까지 되돌린다.
 */
async function confirmFreeOrder(tx: Tx, input: { orderId: string; method: PaymentMethod; at: string }): Promise<void> {
  const { orderId, method, at } = input;
  const [payment] = await tx.query(
    tx.raw.sql`INSERT INTO payments (id, order_id, method, amount, gateway_payment_id, status, due_at, updated_at)
               VALUES (uuidv7(), ${orderId}::uuid, ${method}, 0, ${freePaymentIdFor()}, 'ready', ${at}::timestamptz, ${at}::timestamptz)
               RETURNING id`
      .returnsRow({ id: "pg/uuid@1" })
      .build(),
  );
  if (payment === undefined) throw new Error("0원 결제 행을 만들지 못했다");
  const confirmed = await confirmOrder(tx, {
    orderId,
    paymentId: payment.id,
    reportedAmount: null,
    transactionId: "",
    paidAt: at,
    at,
    reason: FREE_ORDER_CONFIRMED_REASON,
  });
  // 방금 같은 트랜잭션에서 만든 pending 주문이라 0행일 수 없다 — 0행이면 데이터가 깨진 것이라 500 으로 드러낸다
  if (!confirmed) throw new Error("방금 만든 0원 주문을 확정하지 못했다");
}

/** 0원 결제의 번호 — PG 에 보내지 않는다. `free_` 로 시작해 PG 결제 번호(`pay_`)와 구별된다 */
function freePaymentIdFor(): string {
  return `free_${randomUUID().replaceAll("-", "")}`;
}

/**
 * "$1·$2…" 자리표가 든 SQL 글자를 raw 태그 호출로 바꾼다.
 * 주문 스냅샷 SQL(order-snapshot.ts)은 테스트 픽스처와 같이 쓰려고 "$n" 자리표 글자로 만들어져 있다. raw 태그는
 * 템플릿 조각 사이에 값을 끼우는 방식이라, 글자를 자리표마다 잘라 조각 배열로 만들고 같은 번호의 값을 끼워 부른다.
 * 값은 모두 매개변수로 넘어가므로(SQL 에 이어 붙이지 않는다) 주입 위험이 없다. 번호가 값 목록 밖이면 바로 실패한다.
 */
function rawFromNumberedText(tx: Tx, text: string, params: readonly (string | number)[]) {
  const parts = text.split(/\$(\d+)/);
  const strings: string[] = [];
  const values: (string | number)[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      strings.push(parts[i] ?? "");
      continue;
    }
    const index = Number(parts[i]) - 1;
    const value = params[index];
    if (value === undefined) throw new Error(`자리표 $${index + 1} 에 넣을 값이 없다`);
    values.push(value);
  }
  const template = Object.assign([...strings], { raw: [...strings] }) as unknown as TemplateStringsArray;
  return tx.raw.sql(template, ...values);
}

/** 우리가 PG 에 넘기는 결제 번호(payments.gateway_payment_id, 64자 이하) — 추측할 수 없게 무작위로 만든다 */
function gatewayPaymentIdFor(): string {
  return `pay_${randomUUID().replaceAll("-", "")}`;
}

const VIEW_ROW = {
  order_id: "pg/uuid@1",
  status: "pg/text@1",
  price_breakdown: "pg/text@1",
  refund_notice_version_id: "pg/uuid@1",
  intermediary_notice_version: "pg/text@1",
  order_name: "pg/text@1",
  reservation_id: "pg/text@1",
  seat_kind: "pg/text@1",
  payment_id: "pg/text@1",
  method: "pg/text@1",
  payment_status: "pg/text@1",
  amount: "pg/int4@1",
  due_at: "pg/text@1",
  gateway_payment_id: "pg/text@1",
  va_bank: "pg/text@1",
  va_number: "pg/text@1",
  va_holder: "pg/text@1",
} as const;

/**
 * 주문 하나를 계약 03 §1 응답 모양으로 읽는다. 새로 만든 직후와 재요청·복구가 같은 함수를 써서 모양이 어긋나지 않는다.
 * 결제창 키는 DB 칸이 없다 — 같은 결제 번호로 PG 에 다시 물으면 같은 키가 온다(가짜 PG 는 결제 번호 기준 멱등).
 * 가상계좌는 발급 때 결제 행에 적어 둔 계좌를 그대로 쓴다(PG 를 다시 부르지 않는다).
 * 주문 조회(order-detail.ts, S3-3.15b)도 이 함수를 써서 「결제 시작 응답과 같은 모양」(계약 03 §2)을 지킨다.
 */
export async function readOrderView(
  deps: Pick<OrderCreateDeps, "db" | "paymentGateway">,
  orderId: string,
  options: { readonly checkoutOnlyWhenReady?: boolean } = {},
): Promise<OrderResponse> {
  const { db } = deps;
  const [row] = await db.query(
    db.raw.sql`SELECT o.id AS order_id, o.status::text AS status, o.price_breakdown::text AS price_breakdown,
                      o.refund_notice_version_id, o.intermediary_notice_version,
                      c.title || ' · ' || co.label AS order_name,
                      r.id::text AS reservation_id, r.seat_kind::text AS seat_kind,
                      p.id::text AS payment_id, p.method::text AS method, p.status::text AS payment_status, p.amount::int4 AS amount,
                      to_char(p.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS due_at, p.gateway_payment_id,
                      COALESCE(p.virtual_account_bank_code, '') AS va_bank, COALESCE(p.virtual_account_number, '') AS va_number,
                      COALESCE(p.virtual_account_holder, '') AS va_holder
                 FROM orders o
                 JOIN class_offerings co ON co.id = o.offering_id
                 JOIN classes c ON c.id = co.class_id
                 JOIN LATERAL (SELECT id, seat_kind FROM reservations WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1) r ON true
                 -- 살아 있는 결제(ready·paid)가 있으면 그것, 없으면(만료·취소) 가장 최근 결제
                 JOIN LATERAL (SELECT * FROM payments WHERE order_id = o.id
                                ORDER BY (status IN ('ready', 'paid')) DESC, created_at DESC LIMIT 1) p ON true
                WHERE o.id = ${orderId}::uuid`
      .returnsRow(VIEW_ROW)
      .build(),
  );
  if (row === undefined) throw new Error(`주문 응답을 만들 행이 없다: ${orderId}`);

  const method = row.method as PaymentMethod;
  // 0원 결제는 PG 에 없는 결제라 결제창 키·계좌가 없다 — PG 를 다시 부르지 않는다(S3-3.12)
  const isFree = row.amount === 0;
  let cardCheckout: { checkoutKey: string } | null = null;
  // 주문 조회(S3-3.15b, GET /api/orders/{id})는 결제창이 아직 열려 있을(ready) 때만 PG 에 키를 묻는다 — 끝난 결제(취소·만료·실패·입금)의
  // 키를 다시 묻지 않아 PG 쪽에 죽은 결제가 새로 생기지 않게 한다. 결제 시작(POST)은 처음 모양 그대로 둔다(재요청 응답이 바뀌지 않게)
  const wantsCheckout = options.checkoutOnlyWhenReady !== true || row.payment_status === "ready";
  if (method !== "virtual_account" && !isFree && wantsCheckout) {
    const issued = await deps.paymentGateway.createPayment({
      gatewayPaymentId: row.gateway_payment_id,
      method,
      amount: row.amount,
      dueAt: Temporal.Instant.from(row.due_at),
      orderName: row.order_name,
    });
    if (issued.cardCheckoutKey === undefined) throw new Error("PG 가 결제창 키를 주지 않았다");
    cardCheckout = { checkoutKey: issued.cardCheckoutKey };
  }

  return orderResponseSchema.parse({
    orderId: row.order_id,
    status: row.status,
    reservationId: row.reservation_id,
    seatKind: row.seat_kind,
    priceBreakdown: JSON.parse(row.price_breakdown) as unknown,
    payment: {
      paymentId: row.payment_id,
      method,
      status: row.payment_status,
      amount: row.amount,
      dueAt: row.due_at,
      virtualAccount: method === "virtual_account" && !isFree ? { bankCode: row.va_bank, accountNumber: row.va_number, holder: row.va_holder } : null,
      cardCheckout,
    },
    refundNoticeVersionId: row.refund_notice_version_id,
    intermediaryNoticeVersion: row.intermediary_notice_version,
  });
}

/** DB 에서 읽은 글자가 값 집합 안에 있는지 확인한다 — 없으면 데이터가 깨진 것이라 500 으로 드러낸다 */
function parseFrom<T extends string>(values: readonly T[], value: string): T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`알 수 없는 값: ${value}`);
  return value as T;
}

/** 유니크 위반(23505)이 그 제약 이름 때문인가 — 드라이버가 감싼 cause 를 따라 내려간다(session-changes.ts 와 같은 판정) */
function isUniqueViolation(error: unknown, constraintPrefix: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    const text = `${String(e.constraint ?? "")} ${String(e.message ?? "")}`;
    if (e.code === "23505" && text.includes(constraintPrefix)) return true;
    if (text.includes("duplicate key") && text.includes(constraintPrefix)) return true;
    current = e.cause;
  }
  return false;
}
