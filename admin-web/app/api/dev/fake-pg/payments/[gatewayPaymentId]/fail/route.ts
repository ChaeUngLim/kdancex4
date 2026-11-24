// S3-3.15b(결제 화면용 서버 조각) — `POST /api/dev/fake-pg/payments/{gatewayPaymentId}/fail`(계약 03 §7·§8 M-03).
// 가짜 PG 원장에 승인 실패를 적고, `Transaction.Failed` 웹훅을 만들어 §6 처리기에 직접 넘긴다. 처리 내용은
// lib/server/services/dev-fake-pg.ts 의 fail. 본문은 받지 않는다(경로의 결제 번호만 zod 로 검사한다).
// `KDANCE_DEV_ROUTES=true` 가 아니면 withDevRoute 가 처리기를 부르지 않고 404 를 준다(운영 배포 값은 false).
import { devFakePgRouteDeps } from "@/lib/server/dev-fake-pg-route-deps";
import { withDevRoute } from "@/lib/server/dev-routes";
import { createDevFakePgHandlers } from "@/lib/server/services/dev-fake-pg";

export const dynamic = "force-dynamic";

export const POST = withDevRoute(createDevFakePgHandlers(devFakePgRouteDeps).fail);
