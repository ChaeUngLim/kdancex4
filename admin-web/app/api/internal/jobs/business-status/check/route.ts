// S1-1.27(사업자 상태 점검 작업) — `POST /api/internal/jobs/business-status/check`(계약 13-settlement.md 「시간 작업」 표).
// 시간 작업 실행기(S0-4.4, cron)가 매일 03:10 KST 에 한 번 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 이 경로는 **매일 점검(daily)만** 한다. 정산 직전 점검(pre_payout)은 정산 지급 작업(S5-3)이 같은 서비스 함수를
// 지급할 학원 목록과 함께 직접 부른다 — 바깥에서 계기를 골라 넣게 두지 않으려고 본문에 trigger 칸을 받지 않는다.
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙, 계약 14 머리말).
// 조회에 실패한 학원이 있어도 200 이다 — 실패는 error 기록으로 남았고, 작업 자체는 할 일을 끝냈기 때문이다.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runBusinessStatusCheck } from "@/lib/server/services/business-status-check";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸(trigger 등)이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 날짜를 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runBusinessStatusCheck({ db, businessStatus: deps.businessStatus, clock }, { trigger: "daily" });
  return Response.json(result);
});
