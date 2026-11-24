// S2-2.12(수업 승인 24시간 재알림 작업) — `POST /api/internal/jobs/class-approval-reminders`(계약 11-instructor.md §12).
// 시간 작업 실행기(S0-4.4, cron)가 매시간 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
//
// 승인 요청 뒤 24시간 답이 없는 수업마다 대표에게 `class_approval_reminder` 알림을 한 번만 쓴다(FR-050a).
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙, 계약 14 머리말).
// 응답은 200 `{ "processed": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runClassApprovalReminders } from "@/lib/server/services/class-approval-reminders";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 시각을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runClassApprovalReminders({ db, clock });
  return Response.json(result);
});
