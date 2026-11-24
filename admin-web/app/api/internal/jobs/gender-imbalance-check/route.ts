// S3-5.10(역할 불균형 알림 작업) — `POST /api/internal/jobs/gender-imbalance-check`(계약 18-after-payment-views.md §7 「알림 작업」).
// 시간 작업 실행기(S0-4.4, cron)가 매일 18:00(KST)에 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 내일 회차 중 남·여 결제 인원 차이가 3명 이상인 회차마다 담당 강사와 대표에게 `gender_imbalance` 알림을 한 번만 쓴다(FR-107).
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙).
// 응답은 200 `{ "imbalancedSessions": n, "notified": m }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runGenderImbalanceCheck } from "@/lib/server/services/gender-imbalance-check";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 시각을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runGenderImbalanceCheck({ db, clock });
  return Response.json(result);
});
