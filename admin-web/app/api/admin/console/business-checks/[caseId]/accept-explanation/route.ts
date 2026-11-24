// S1-1.29(소명 기한 지남 → 운영자 게시 중단) — `POST /api/admin/console/business-checks/{caseId}/accept-explanation`(계약 13 §10-3, P11).
// 관리자 웹 · 2단계 인증 운영자만. 처리 내용과 본문 검사(businessCheckActionSchema)는 lib/server/services/admin-business-checks.ts.
import { getDeps } from "@/lib/server/deps";
import { createAdminBusinessCheckRoutes } from "@/lib/server/services/admin-business-checks";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = createAdminBusinessCheckRoutes({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});

export const POST = routes.accept;
