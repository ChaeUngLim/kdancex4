// S1-1.35(주인 없는 올린 파일 정리 작업) — `POST /api/internal/jobs/files/purge-unattached`(계약 07 §1 「시간 작업」).
// 시간 작업 실행기(S0-4.4, cron)가 매일 한 번 부른다. 헤더 `X-Internal-Token` 이 맞을 때만 열린다(S0-4.3).
// 무엇을 어떤 순서로 지우는지는 lib/server/services/unattached-file-cleanup.ts 에 있고, 이 파일은 앱의 db·저장소·시계를 이어 줄 뿐이다.
// 본문 `{ "asOf": "…Z" }` 는 `KDANCE_DEV_ROUTES=true` 일 때만 쓴다(시험용 시계 — 내부 작업 공통 규칙, 계약 14 머리말).
import { z } from "zod";

import { fixedClock } from "@/lib/domain/time";
import { getDeps } from "@/lib/server/deps";
import { devRoutesEnabled } from "@/lib/server/dev-routes";
import { parseJsonBody } from "@/lib/server/http";
import { withInternalRoute } from "@/lib/server/internal-routes";
import { runUnattachedFileCleanup } from "@/lib/server/services/unattached-file-cleanup";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// strict — 모르는 칸(기준 시간을 바꾸려는 칸 등)이 오면 422 로 막는다. 24시간 기준은 바깥에서 못 바꾼다
const bodySchema = z.strictObject({ asOf: z.iso.datetime().optional() });

export const POST = withInternalRoute(async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  const deps = getDeps();
  // 시험용 시계는 dev 경로가 켜진 환경에서만 받는다 — 운영에서 「지금」을 바깥이 정하게 두지 않는다
  const clock = body.asOf && devRoutesEnabled() ? fixedClock(Temporal.Instant.from(body.asOf)) : deps.clock;
  const result = await runUnattachedFileCleanup({ db, fileStorage: deps.fileStorage, clock });
  return Response.json(result);
});
