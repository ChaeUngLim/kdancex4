// S1-2.9(위임 권한 켜고 끄기 API) — `PUT /api/academies/{academyId}/affiliations/{id}/permissions`(계약 08 §4).
// 대표가 소속 강사의 위임 권한(웹 roster_manage·class_manage + 앱 class_submit)을 통째로 바꾼다. 같은 값이면 감사·알림 없이 200.
// 처리 내용은 lib/server/services/academy-affiliation-permissions.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createUpdateAffiliationPermissionsRoute } from "@/lib/server/services/academy-affiliation-permissions";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createUpdateAffiliationPermissionsRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
