// S3-4.3b(결석 표시 48시간 확정 작업) — `POST /api/internal/jobs/absence-lock`(계약 04 §7).
// 시간 작업 실행기(S0-4.4(시간 작업 실행기), cron)가 매시간 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(README §1).
//
// 끝난 지 48시간이 지난 회차마다 감사 `attendance.session_locked` 1행을 남긴다(회차당 한 번). 새 결석 표시를 막는 것은
// 이 작업이 아니라 표시 경로의 시각 계산이다(§7 첫 줄). 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다
// (시험용 시계 — 내부 작업 공통 규칙). 응답은 200 `{ "locked": n }`.
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runAbsenceLock } from "@/lib/server/services/absence-lock";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸이 오면 422 로 막는다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runAbsenceLock({ db, clock });
  return Response.json(result);
});
