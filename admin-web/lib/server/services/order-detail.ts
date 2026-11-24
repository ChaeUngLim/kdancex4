// S3-3.15b(결제 화면용 서버 조각) — `GET /api/orders/{orderId}`(계약 03 §2 「조회」).
//   요구: AC-3(웹훅 신뢰성 — 앱은 결제창에서 돌아오면 이 경로로 상태를 다시 읽을 뿐이다) · 계약 03 §8 M-03(실패 뒤 cancelled 를 읽는다)
//
// 한 줄로: 앱 결제 대기·완료·실패 화면이 「지금 이 주문이 어떤 상태인지」를 서버 값만으로 그리게 한다.
//   응답 모양은 결제 시작(POST /api/orders) 응답과 같다(계약 03 §2 「위와 같은 모양 + status 최신값」) —
//   같은 함수(order-create.ts 의 readOrderView)로 읽어 두 경로가 어긋나지 않게 한다.
//
// 권한(누가 볼 수 있나):
//   - 회원만(세션 없음 401 · 가입 전 403 SIGNUP_INCOMPLETE — requireMember)
//   - **본인 주문만.** 남의 주문이면 403 FORBIDDEN(계약 03 §2 「남의 주문 403」). 없는 id·모양이 틀린 id 는 404.
//     가상계좌 번호처럼 남이 보면 안 되는 값이 응답에 들어 있어서다
//
// 상태 최신값: 읽기 전에 이 주문의 판매 단위에서 기한 지난 결제 대기를 먼저 닫는다(계약 03 §5 「읽기·쓰기 전 정리」).
//   그래야 기한이 지난 주문이 앱에 계속 pending 으로 보이지 않는다(정리 주체가 없는 1회차에서도 expired 가 보인다).
import type { ServerDeps } from "../deps";
import { createGuards, type GuardDeps } from "../guards";
import { HttpError, withRoute } from "../http";
import { routeIdSchema } from "../schemas/cancellation";
import type { OrderResponse } from "../schemas/orders";
import { readOrderView } from "./order-create";
import { expireDuePayments } from "./order-expiry";

export type OrderDetailDeps = GuardDeps & Pick<ServerDeps, "clock" | "paymentGateway">;

const NOT_FOUND_DETAIL = "주문을 찾을 수 없어요";
const FORBIDDEN_DETAIL = "본인의 주문만 볼 수 있어요";
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 주문 하나를 본인 확인 뒤 계약 03 §1 응답 모양으로 읽는다 */
export async function readMyOrder(deps: OrderDetailDeps, input: { orderId: string; memberId: string }): Promise<OrderResponse> {
  const { db } = deps;
  // ① 주인 확인 — 주인과 판매 단위만 먼저 읽는다(남의 주문이면 정리·PG 조회까지 가지 않는다)
  const [owner] = await db.query(
    db.raw.sql`SELECT member_id, offering_id FROM orders WHERE id = ${input.orderId}::uuid`
      .returnsRow({ member_id: "pg/uuid@1", offering_id: "pg/uuid@1" })
      .build(),
  );
  if (owner === undefined) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
  if (owner.member_id !== input.memberId) throw new HttpError("FORBIDDEN", FORBIDDEN_DETAIL);

  // ② 기한 지난 결제 대기 정리(이 판매 단위만) — 응답의 status 가 「지금」 값이 되게
  await expireDuePayments(deps, { offeringId: owner.offering_id });

  // ③ 결제 시작 응답과 같은 모양으로 읽는다. 끝난 결제의 결제창 키는 PG 에 다시 묻지 않는다
  return readOrderView(deps, input.orderId, { checkoutOnlyWhenReady: true });
}

type OrderParams = { params: Promise<{ orderId: string }> };

/** `GET /api/orders/{orderId}` 처리기 */
export function createOrderDetailRoute(deps: OrderDetailDeps) {
  const guards = createGuards(deps);
  return withRoute<OrderParams>(async (request, context) => {
    const { memberId } = await guards.requireMember(request);
    // id 모양이 틀리면 DB 에 넘기기 전에 「없음」으로 답한다(형 변환 오류 500 을 막는다)
    const parsed = routeIdSchema.safeParse((await context.params).orderId);
    if (!parsed.success) throw new HttpError("NOT_FOUND", NOT_FOUND_DETAIL);
    const body = await readMyOrder(deps, { orderId: parsed.data, memberId });
    return Response.json(body, { status: 200, headers: NO_STORE });
  });
}
