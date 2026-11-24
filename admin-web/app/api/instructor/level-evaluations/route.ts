// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — `POST /api/instructor/level-evaluations`(계약 14 §6-1, 보드 I23 「최종 적용」).
// 평가 레벨을 저장하고, 회원의 지금 레벨보다 높으면 승급 안내(level_offers + 알림 level_offer)를 보낸다. 회원 레벨은 바꾸지 않는다.
// 강사 멤버십이 아니면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED. 처리는 lib/server/services/instructor-level-evaluations.ts.
import { getDeps } from "@/lib/server/deps";
import { createInstructorLevelEvaluationsRoute } from "@/lib/server/services/instructor-level-evaluations";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

// 포트는 꺼낼 때 만든다(getter) — import 시점에 비밀값이 필요한 포트까지 만들어지지 않게
export const POST = createInstructorLevelEvaluationsRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get instructorMembership() {
    return getDeps().instructorMembership;
  },
  get notificationSender() {
    return getDeps().notificationSender;
  },
});
