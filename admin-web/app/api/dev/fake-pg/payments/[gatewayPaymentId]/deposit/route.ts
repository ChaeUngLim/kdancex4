// S3-3.14(가짜 PG dev 경로) — `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/deposit`(계약 03 §7).
// 가짜 PG 원장에 입금을 적고, 서명된 웹훅을 만들어 §6 처리기에 직접 넘긴다. 처리 내용은 lib/server/services/dev-fake-pg.ts
// (본문은 그 파일의 fakePgDepositRequestSchema(zod)로 검사한다).
// `KDANCE_DEV_ROUTES=true` 가 아니면 withDevRoute 가 처리기를 부르지 않고 404 를 준다(운영 배포 값은 false).
import { devFakePgRouteDeps } from "@/lib/server/dev-fake-pg-route-deps";
import { withDevRoute } from "@/lib/server/dev-routes";
import { createDevFakePgHandlers } from "@/lib/server/services/dev-fake-pg";

export const dynamic = "force-dynamic";

export const POST = withDevRoute(createDevFakePgHandlers(devFakePgRouteDeps).deposit);
