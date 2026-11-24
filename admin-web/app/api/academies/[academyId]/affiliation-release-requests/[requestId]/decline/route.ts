// S2-3.13(소속 해제 요청 목록·거절·취소 API) — `POST /api/academies/{academyId}/affiliation-release-requests/{requestId}/decline`(계약 11 §9).
// 대표가 강사의 해제 요청을 사유 한 줄과 함께 거절한다(O37). 소속은 그대로 active, 강사에게 release_declined 알림.
// 처리 내용은 lib/server/services/affiliation-release-request-decisions.ts.
import { getDeps } from "@/lib/server/deps";
import { createDeclineReleaseRequestRoute } from "@/lib/server/services/affiliation-release-request-decisions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createDeclineReleaseRequestRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
