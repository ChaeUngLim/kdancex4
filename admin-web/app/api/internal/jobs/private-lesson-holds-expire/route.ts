// S2-4.9(개인 레슨 잡아 둔 시간 만료 작업) — `POST /api/internal/jobs/private-lesson-holds-expire`(계약 11-instructor.md §12).
// 시간 작업 실행기(S0-4.4, cron)가 매 10분 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// `held_until` 이 지난 결제 대기(`held`) 시간을 다시 `open`(레슨 모집)으로 돌린다. 결제 대기 수강권 정리는
// M3 의 주문 만료와 한 묶음이라 여기서 하지 않는다(열린 점 ⑫ — 서비스 파일 머리 주석).
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "processed": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runPrivateLessonHoldsExpire } from "@/lib/server/services/private-lesson-holds-expire";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runPrivateLessonHoldsExpire({ db, clock });
  return Response.json(result);
});
