// S1-2.10(강사 몫 비율 변경·수업별 예외 API) — `PUT /api/academies/{academyId}/affiliations/{id}/share-rate-overrides/{classId}`
// (계약 08 §4-1). 그 수업만 다른 비율(개인 레슨 포함), 또는 rateBp: null 로 예외를 끄고 기본 비율로 돌아간다.
// 처리 내용은 lib/server/services/academy-share-rates.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createUpdateShareRateOverrideRoute } from "@/lib/server/services/academy-share-rates";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createUpdateShareRateOverrideRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
