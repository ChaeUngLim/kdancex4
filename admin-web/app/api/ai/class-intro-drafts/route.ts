// SX-6.6(소개 문구 초안) — `POST /api/ai/class-intro-drafts`(계약 16 §4-7, 보드 I32D).
// 본문 zod 검증(introDraftRequestSchema — 강조할 점 60자)·권한·facts·틀 채우기는 lib/server/services/class-intro-drafts.ts 에 있다.
import { agentIntroClientFromEnv } from "@/lib/server/ai/agent-intro-client";
import { createRateLimiter, loadRateLimitRules } from "@/lib/server/rate-limit";
import { createClassIntroDraftRoute } from "@/lib/server/services/class-intro-drafts";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 계정당 1분 10회(값은 RATE_LIMIT_INTRO_DRAFT_* 환경 변수). 규칙은 요청 때 읽는다(getter)
const limiter = createRateLimiter();

// 에이전트 연결은 요청 때 환경 변수(AGENT_SERVER_URL · AGENT_API_TOKEN)로 고른다 — 없으면 503 AI_UNAVAILABLE(손으로 쓰기)
const route = () =>
  createClassIntroDraftRoute({
    db,
    getSession: readStaffSession,
    writeIntro: agentIntroClientFromEnv(),
    rateLimit: {
      limiter,
      get rule() {
        return loadRateLimitRules().classIntroDraft;
      },
    },
  });

export const POST = (request: Request, context: unknown) => route()(request, context);
