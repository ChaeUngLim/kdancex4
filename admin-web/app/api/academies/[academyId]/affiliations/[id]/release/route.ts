// S1-2.12(소속 해제 API — 남은 회차 0) — `POST /api/academies/{academyId}/affiliations/{id}/release`(계약 08 §5).
// 대표가 소속 강사를 해제한다. 남은 회차는 고른 대로 대체·휴강·폐강하고(S2-3.6), 정하지 않은 회차가 있으면 409.
// 처리 내용은 lib/server/services/academy-affiliation-release.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createReleaseAffiliationRoute } from "@/lib/server/services/academy-affiliation-release";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createReleaseAffiliationRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
