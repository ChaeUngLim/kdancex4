// SX-2.3(검토 API) — `GET · PATCH /api/academies/{academyId}/poster-extractions/{extractionId}`(계약 16 §4-6, 보드 O2).
// GET 은 칸별 값·신뢰도·확인필요, PATCH 는 검토 중 값 고치기(revision 낙관 잠금 · 칸 값 zod 검증 patchBodySchema).
// 처리 내용은 lib/server/services/poster-extractions.ts 에 있다.
import { agentJobDispatcherFromEnv } from "@/lib/server/ai/agent-jobs-client";
import { createPosterExtractionRoutes } from "@/lib/server/services/poster-extractions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 에이전트 연결은 요청 때 환경 변수(AGENT_SERVER_URL · AGENT_API_TOKEN)로 고른다 — 없으면 작업은 queued 로 남는다
const routes = () => createPosterExtractionRoutes({ db, getSession: readStaffSession, dispatchJob: agentJobDispatcherFromEnv() });

type Params = { params: Promise<{ academyId: string; extractionId: string }> };
export const GET = (request: Request, context: Params) => routes().read(request, context);
export const PATCH = (request: Request, context: Params) => routes().patch(request, context);
