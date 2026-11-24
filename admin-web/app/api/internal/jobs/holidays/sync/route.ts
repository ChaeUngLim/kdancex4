// S0-4.10(특일 정보 수집 작업) — `POST /api/internal/jobs/holidays/sync`(계약 13-settlement.md 「시간 작업」 표).
// 시간 작업 실행기(S0-4.4, cron)가 하루 한 번 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙, 계약 14 머리말).
// 그 밖에는 무시하고 실제 시계로 「올해·다음 해」를 정한다. 응답은 해마다의 결과 줄이다.
// 받기에 실패한 해가 있어도 200 이다 — 실패는 holiday_sync_runs 에 기록됐고, 작업 자체는 할 일을 끝냈기 때문이다.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { syncHolidays } from "@/lib/server/services/holiday-sync";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 날짜를 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await syncHolidays({ db, specialDays: deps.specialDays, clock });
  return Response.json(result);
});
