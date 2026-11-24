// S7-1.7(수업 전 알림 작업) — `POST /api/internal/jobs/notifications/pre-class`(계약 15 §1-4).
// 시간 작업 실행기(S0-4.4(시간 작업 실행기), cron)가 5분마다 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(README §1).
//
// 앞으로 24시간 안에 시작하는 회차의 확정 예약 회원에게, 그 회원이 고른 시점(하루 전·2시간 전·1시간 전·30분 전)이 되면
// 알림 행을 1건 만들고 발송기에 넘긴다. 몇 번 불러도 회차·회원·시점마다 1건이다(수용 ⑤).
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙). 응답은 200 `{ "created": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runPreClassReminders } from "@/lib/server/services/pre-class-reminders";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runPreClassReminders({ db, clock, notificationSender: deps.notificationSender });
  return Response.json(result);
});
