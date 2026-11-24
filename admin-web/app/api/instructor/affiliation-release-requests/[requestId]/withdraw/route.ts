// S2-3.13(소속 해제 요청 목록·거절·취소 API) — `POST /api/instructor/affiliation-release-requests/{requestId}/withdraw`(계약 11 §3-3).
// 강사가 자기 해제 요청을 거둔다(I28). 처리 내용은 lib/server/services/affiliation-release-request-decisions.ts.
import { getDeps } from "@/lib/server/deps";
import { createWithdrawReleaseRequestRoute } from "@/lib/server/services/affiliation-release-request-decisions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createWithdrawReleaseRequestRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
