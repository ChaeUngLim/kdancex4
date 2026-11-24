// S3-3.7(만료 정리·셀프 취소·내부 경로) — `POST /api/internal/orders/expire`(계약 03-checkout-payment.md §5).
// 기한 지난 결제 대기 주문을 전부 `expired` 로 닫고 자리를 푼다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
// 나중에 시간 작업 실행기(cron)가 부른다 — 1회차엔 부르는 주체가 없고, 읽기·쓰기 전 정리(홈·상세·주문 생성)가 주력이다.
//
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "expired": n }`. 같은 시각에 두 번 불러도 두 번째는 0 이다(조건부 UPDATE).
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { expireDuePayments } from "@/lib/server/services/order-expiry";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await expireDuePayments({ db, clock, paymentGateway: deps.paymentGateway });
  return Response.json(result);
});
