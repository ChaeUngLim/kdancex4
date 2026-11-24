// SX-6.5(하루 횟수·생성 요청 API) — `GET /api/ai/promo-images/{generationId}`(만들기 상태와 결과, 계약 16 §4-7).
// 실패로 끝났으면 refunded: true 와 늘어난 remaining 을 준다. 처리는 lib/server/services/promo-image-generations.ts.
import { unavailableAgentJobDispatcher } from "@/lib/server/ai/agent-jobs-client";
import { createPromoImageRoutes } from "@/lib/server/services/promo-image-generations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 읽기 경로라 에이전트에게 맡길 일이 없다
const routes = () => createPromoImageRoutes({ db, getSession: readStaffSession, dispatchJob: unavailableAgentJobDispatcher });

export const GET = (request: Request, context: { params: Promise<{ generationId: string }> }) => routes().read(request, context);
