// SX-2.3(검토 API) — `POST /api/academies/{academyId}/poster-extractions`(포스터 올려 읽기 시작, 계약 16 §4-6, 보드 O2 · W30).
// 본문 zod 검증(startBodySchema)·권한·작업 접수는 lib/server/services/poster-extractions.ts 에 있다.
import { agentJobDispatcherFromEnv } from "@/lib/server/ai/agent-jobs-client";
import { createPosterExtractionRoutes } from "@/lib/server/services/poster-extractions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 에이전트 연결은 요청 때 환경 변수(AGENT_SERVER_URL · AGENT_API_TOKEN)로 고른다 — 없으면 작업은 queued 로 남는다
const routes = () => createPosterExtractionRoutes({ db, getSession: readStaffSession, dispatchJob: agentJobDispatcherFromEnv() });

export const POST = (request: Request, context: { params: Promise<{ academyId: string }> }) => routes().start(request, context);
