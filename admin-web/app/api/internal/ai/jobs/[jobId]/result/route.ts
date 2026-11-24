// SX-2.3(검토 API) — `POST /api/internal/ai/jobs/{jobId}/result`(층 B2, 계약 16 §7-2). 에이전트가 작업 결과를 알린다.
// X-Internal-Token 필수. 본문은 jobResultBodySchema(zod safeParse)로 거르고 칸마다 값 모양을 다시 본다.
// 처리 내용은 lib/server/services/poster-extraction-jobs.ts 에 있다.
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

export const POST = (request: Request, context: Params) => routes().result(request, context);
