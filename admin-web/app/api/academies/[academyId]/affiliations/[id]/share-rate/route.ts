// S1-2.10(강사 몫 비율 변경·수업별 예외 API) — `PUT /api/academies/{academyId}/affiliations/{id}/share-rate`(계약 08 §4-1).
// 기본 비율의 새 판본을 쌓는다(effective_from = 서버 시각 → 바꾼 뒤 결제분부터). 화면이 본 판본과 다르면 409 SHARE_RATE_CONFLICT.
// 처리 내용은 lib/server/services/academy-share-rates.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createUpdateShareRateRoute } from "@/lib/server/services/academy-share-rates";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createUpdateShareRateRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
