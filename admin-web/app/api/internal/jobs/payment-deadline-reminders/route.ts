// S3-4.4(입금 기한 임박 알림 작업) — `POST /api/internal/jobs/payment-deadline-reminders`(계약 04 §10).
// 시간 작업 실행기(S0-4.4(시간 작업 실행기), cron)가 10분마다 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(README §1).
//
// 입금 기한 1시간 전(발급~기한이 더 짧으면 그 절반이 지난 때)에 아직 입금하지 않은 가상계좌 주문의 회원에게 알림 행을 1건 만든다.
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙). 응답은 200 `{ "notified": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runPaymentDeadlineReminders } from "@/lib/server/services/payment-deadline-reminders";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runPaymentDeadlineReminders({ db, clock });
  return Response.json(result);
});
