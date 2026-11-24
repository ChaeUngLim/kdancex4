// S1-2.6(소속 신청·철회·내 소속 목록 API) — `POST /api/instructor/affiliations/{id}/withdraw`(계약 08 §2).
// 승인 대기 중인 내 소속 신청을 거둔다(I27B 「신청 취소」). 처리 내용은 lib/server/services/instructor-affiliations.ts.
import { getDeps } from "@/lib/server/deps";
import { createWithdrawAffiliationRoute, type InstructorAffiliationDeps } from "@/lib/server/services/instructor-affiliations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const deps: InstructorAffiliationDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

export const POST = createWithdrawAffiliationRoute(deps);
