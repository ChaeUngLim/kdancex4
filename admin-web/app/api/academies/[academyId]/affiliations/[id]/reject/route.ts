// S1-2.7(소속 승인·거절 API — 몫 비율 입력) — `POST /api/academies/{academyId}/affiliations/{id}/reject`(계약 08 §3).
// 대표가 소속 신청을 사유와 함께 거절한다. 「기타」면 사유 글 필수.
// 처리 내용은 lib/server/services/academy-affiliation-decisions.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createRejectAffiliationRoute } from "@/lib/server/services/academy-affiliation-decisions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createRejectAffiliationRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
