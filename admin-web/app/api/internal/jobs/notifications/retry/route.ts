// S7-1.6(발송 재시도 작업) — `POST /api/internal/jobs/notifications/retry`(계약 15 §1-4).
// 시간 작업 실행기(S0-4.4(시간 작업 실행기), cron)가 1분마다 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(README §1).
//
// 발송에 실패해 `retry_wait` 로 기다리던 알림 가운데 다시 보낼 때가 된 것만 보낸다. 시도는 처음 포함 3번,
// 사이 간격은 1분·5분이고 세 번째도 실패하면 `failed` 로 끝낸다(수용 ④). 알림함 행은 지우지 않는다.
// 본문 `{ "limit": n }`(선택, 1~1000, 기본 200). 응답은 200 `{ "retried": n, "failed": n }`.
import { z } from "zod";

import { getDeps } from "@/lib/server/deps";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ limit: z.int().min(1).max(1000).optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const report = await getDeps().notificationRetry.retryDue(body.limit);
  // 계약 응답은 두 칸뿐이다 — sent 는 로그·테스트용이라 내리지 않는다
  return Response.json({ retried: report.retried, failed: report.failed });
});
