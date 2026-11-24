// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — `GET /api/instructor/offerings/{offeringId}/member-levels?detailGenre=`(계약 14 §6-1, 보드 I23).
// 결제 완료 수강생의 지금 레벨과 이 강사의 평가 레벨(myEvaluation)을 돌려준다. 강사 멤버십이 아니면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED.
// 처리는 lib/server/services/instructor-level-evaluations.ts.
import { getDeps } from "@/lib/server/deps";
import { createInstructorMemberLevelsRoute } from "@/lib/server/services/instructor-level-evaluations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사·다른 수업이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 포트는 꺼낼 때 만든다(getter) — import 시점에 비밀값이 필요한 포트까지 만들어지지 않게
export const GET = createInstructorMemberLevelsRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get instructorMembership() {
    return getDeps().instructorMembership;
  },
});
