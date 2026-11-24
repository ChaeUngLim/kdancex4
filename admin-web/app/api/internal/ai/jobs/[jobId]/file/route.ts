// SX-2.3(검토 API) — `GET /api/internal/ai/jobs/{jobId}/file`(층 B2, 계약 16 §1-2 · §7-2). 에이전트가 포스터 원본을 받아 간다.
// X-Internal-Token 필수, 작업이 running 인 동안만. 처리 내용은 lib/server/services/poster-extraction-jobs.ts.
import { getDeps } from "@/lib/server/deps";
import { createPosterJobRoutes } from "@/lib/server/services/poster-extraction-jobs";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () =>
  createPosterJobRoutes({
    db,
    get fileStorage() {
      return getDeps().fileStorage;
    },
  });
type Params = { params: Promise<{ jobId: string }> };

export const GET = (request: Request, context: Params) => routes().file(request, context);
