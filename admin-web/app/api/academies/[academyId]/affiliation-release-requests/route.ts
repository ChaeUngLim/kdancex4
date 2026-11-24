// S2-3.13(소속 해제 요청 목록·거절·취소 API) — `GET /api/academies/{academyId}/affiliation-release-requests?status=requested`(계약 11 §9).
// 대표가 강사가 시작한 소속 해제 요청을 본다(O21B · O37). 처리 내용은 lib/server/services/affiliation-release-request-decisions.ts.
import { getDeps } from "@/lib/server/deps";
import { createListReleaseRequestsRoute } from "@/lib/server/services/affiliation-release-request-decisions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createListReleaseRequestsRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
