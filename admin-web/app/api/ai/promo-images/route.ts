// SX-6.5(하루 횟수·생성 요청 API) — `POST /api/ai/promo-images`(홍보 이미지 만들기, 계약 16 §4-7, 보드 I32 · I41 · I42 · I43).
// 본문 zod 검증(createBodySchema)·권한·하루 횟수 차감·작업 접수는 lib/server/services/promo-image-generations.ts 에 있다.
import { agentJobDispatcherFromEnv } from "@/lib/server/ai/agent-jobs-client";
import { createPromoImageRoutes } from "@/lib/server/services/promo-image-generations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 에이전트 연결은 요청 때 환경 변수(AGENT_SERVER_URL · AGENT_API_TOKEN)로 고른다 — 없으면 곧바로 실패로 닫고 횟수를 돌려준다
const routes = () => createPromoImageRoutes({ db, getSession: readStaffSession, dispatchJob: agentJobDispatcherFromEnv() });

export const POST = (request: Request, context: unknown) => routes().create(request, context);
