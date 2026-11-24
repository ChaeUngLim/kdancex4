// S3-3.4(주문 생성 API) — `POST /api/orders`(계약 03 §1, 결제 시작). 처리 내용은 lib/server/services/order-create.ts.
// 본문은 그 파일의 createOrderRequestSchema(zod)로 검사한다. 재료(db · 세션 읽기 · 시계 · PG 포트)는 셀프 취소 경로와 같아
// 그 묶음(cancellation-route-deps)을 그대로 쓴다 — 같은 가짜 PG 원장을 써야 취소가 만든 결제를 찾을 수 있다.
import { cancellationRouteDeps } from "@/lib/server/cancellation-route-deps";
import { createRateLimiter, loadRateLimitRules } from "@/lib/server/rate-limit";
import { createOrderRoute } from "@/lib/server/services/order-create";

export const dynamic = "force-dynamic";

// S3-3.13 — 한 회원의 결제 시작은 1분에 10회까지(값은 RATE_LIMIT_CHECKOUT_* 환경 변수). 규칙은 요청 때 읽는다(getter)
const limiter = createRateLimiter();

export const POST = createOrderRoute(cancellationRouteDeps, {
  checkoutRateLimit: {
    limiter,
    get rule() {
      return loadRateLimitRules().checkoutStart;
    },
  },
});
