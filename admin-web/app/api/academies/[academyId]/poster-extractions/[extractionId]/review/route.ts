// SX-2.3(검토 API) — `POST …/poster-extractions/{extractionId}/review`(「검토 끝」, 계약 16 §4-6 · FR-074).
// 확인필요 칸이 남으면 409 POSTER_REVIEW_INCOMPLETE. 본문 zod 검증(reviewBodySchema)은 lib/server/services/poster-extractions.ts 에 있다.
import { agentJobDispatcherFromEnv } from "@/lib/server/ai/agent-jobs-client";
import { createPosterExtractionRoutes } from "@/lib/server/services/poster-extractions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 에이전트 연결은 요청 때 환경 변수(AGENT_SERVER_URL · AGENT_API_TOKEN)로 고른다 — 없으면 작업은 queued 로 남는다
const routes = () => createPosterExtractionRoutes({ db, getSession: readStaffSession, dispatchJob: agentJobDispatcherFromEnv() });

type Params = { params: Promise<{ academyId: string; extractionId: string }> };
export const POST = (request: Request, context: Params) => routes().review(request, context);
