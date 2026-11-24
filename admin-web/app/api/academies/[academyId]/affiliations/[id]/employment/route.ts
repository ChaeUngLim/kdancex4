// S1-2.11(학원 직원 켜고 끄기 API) — `PUT /api/academies/{academyId}/affiliations/{id}/employment`(계약 08 §4).
// 켜면 몫 비율 없이 학원 직원이 되고(켜진 수업별 예외는 NULL 판본으로 닫힌다), 끄면 새 기본 비율을 함께 받는다.
// 처리 내용은 lib/server/services/academy-affiliation-employment.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createUpdateAffiliationEmploymentRoute } from "@/lib/server/services/academy-affiliation-employment";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createUpdateAffiliationEmploymentRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
