// S2-3.11(대타 요청 만료 작업) — `POST /api/internal/jobs/substitute-requests-expire`(계약 11-instructor.md §12).
// 시간 작업 실행기(S0-4.4, cron)가 매 10분 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 회차 시작 시각이 지난 `open`·`accepted` 대타 요청을 `expired` 로 닫는다(열린 점 ⑮ 추천안). 대표가 이미 확인한
// `confirmed` 는 그대로다. 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "processed": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runSubstituteRequestsExpire } from "@/lib/server/services/substitute-requests-expire";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runSubstituteRequestsExpire({ db, clock });
  return Response.json(result);
});
