// S1-2.6(소속 신청·철회·내 소속 목록 API) — `POST /api/instructor/affiliations`(소속 신청) · `GET /api/instructor/affiliations`(학원별 상태 카드, I27B).
// 계약 08 §2. 처리 내용은 lib/server/services/instructor-affiliations.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import {
  createApplyAffiliationRoute,
  createListMyAffiliationsRoute,
  type InstructorAffiliationDeps,
} from "@/lib/server/services/instructor-affiliations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 시계는 getter 로 넘긴다 — 처음 쓰는 요청에서 읽는다
const deps: InstructorAffiliationDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

export const POST = createApplyAffiliationRoute(deps);
export const GET = createListMyAffiliationsRoute(deps);
