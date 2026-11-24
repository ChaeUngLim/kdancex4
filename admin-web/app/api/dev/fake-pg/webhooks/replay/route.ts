// S3-3.14(가짜 PG dev 경로) — `POST /api/dev/fake-pg/webhooks/replay`(계약 03 §7). 같은 웹훅을 같은 id·같은 원문으로 다시 보낸다(중복 시험).
// 처리 내용은 lib/server/services/dev-fake-pg.ts(본문은 fakePgReplayRequestSchema(zod)로 검사한다).
// `KDANCE_DEV_ROUTES=true` 가 아니면 withDevRoute 가 처리기를 부르지 않고 404 를 준다(운영 배포 값은 false).
import { devFakePgRouteDeps } from "@/lib/server/dev-fake-pg-route-deps";
import { withDevRoute } from "@/lib/server/dev-routes";
import { createDevFakePgHandlers } from "@/lib/server/services/dev-fake-pg";

export const dynamic = "force-dynamic";

export const POST = withDevRoute(createDevFakePgHandlers(devFakePgRouteDeps).replay);
