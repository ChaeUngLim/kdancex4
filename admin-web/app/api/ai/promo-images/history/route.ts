// SX-6.5(하루 횟수·생성 요청 API) — `GET /api/ai/promo-images/history`(지난 입력 불러오기, 계약 16 §4-7).
// 본인 것만 최신순. 다음 날 같은 문장을 불러와 고쳐 쓴다. 처리는 lib/server/services/promo-image-generations.ts.
import { unavailableAgentJobDispatcher } from "@/lib/server/ai/agent-jobs-client";
import { createPromoImageRoutes } from "@/lib/server/services/promo-image-generations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createPromoImageRoutes({ db, getSession: readStaffSession, dispatchJob: unavailableAgentJobDispatcher });

export const GET = (request: Request, context: unknown) => routes().history(request, context);
