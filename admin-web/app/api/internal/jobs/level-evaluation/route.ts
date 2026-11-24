// S6-3.3(레벨 계산 작업) — `POST /api/internal/jobs/level-evaluation`(계약 14 §3 · §5-1).
// 시간 작업 실행기(S0-4.4(시간 작업 실행기), cron)가 하루 한 번(추천값) 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(README §1).
//
// 기간 종료 + 48시간이 지난 정규 수업의 수강생마다 완주·출석을 판정해, 채우면 세부 장르 레벨 +1 · 카드 1장 · 알림 level_up.
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "processed": n, "promoted": n, "failed": n }`. 두 번 불러도 같은 결과다(멱등).
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runLevelEvaluation } from "@/lib/server/services/level-evaluation-job";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runLevelEvaluation({ db, clock, notificationSender: deps.notificationSender });
  return Response.json(result);
});
