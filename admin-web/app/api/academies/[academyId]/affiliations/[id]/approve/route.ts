// S1-2.7(소속 승인·거절 API — 몫 비율 입력) — `POST /api/academies/{academyId}/affiliations/{id}/approve`(계약 08 §3).
// 대표가 소속 신청을 승인한다. 프리랜서·사업자 강사면 몫 비율 필수(없으면 422 SHARE_RATE_REQUIRED), 학원 직원이면 비율 없음.
// 처리 내용은 lib/server/services/academy-affiliation-decisions.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createApproveAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createApproveAffiliationRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
