// S7-4.8c(사업자 점검 소명 처리 API(P11)) — `GET /api/admin/console/business-checks`(계약 13 §10-3, P11 목록·요약 카드).
// 관리자 웹 · 2단계 인증 운영자만. 읽는 쿼리는 lib/server/services/admin-business-check-views.ts, 열 때마다 조회 기록(console.viewed)을 남긴다.
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

export const GET = routes.list;
