// S7-4.8c(사업자 점검 소명 처리 API(P11)) — `GET /api/admin/console/business-checks/{caseId}`(계약 13 §10-3, P11 건 상세).
// 관리자 웹 · 2단계 인증 운영자만. 국세청 원문·등록번호 원문은 내리지 않는다. 쿼리는 lib/server/services/admin-business-check-views.ts.
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

export const GET = routes.detail;
