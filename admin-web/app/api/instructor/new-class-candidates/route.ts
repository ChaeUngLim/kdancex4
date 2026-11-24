// S6-3.5(개강 후보) — `GET /api/instructor/new-class-candidates?…`(계약 14 §6-2, 보드 I15).
// 후보 수(남·여)와 선정 근거별 인원만 돌려준다. 개인을 가리키는 값은 없다. 강사 멤버십이 아니면 403 INSTRUCTOR_MEMBERSHIP_REQUIRED.
// 처리는 lib/server/services/new-class-candidates.ts.
import { getDeps } from "@/lib/server/deps";
import { createNewClassCandidatesRoute } from "@/lib/server/services/new-class-candidates";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사·다른 조건이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 포트는 꺼낼 때 만든다(getter) — import 시점에 비밀값이 필요한 포트까지 만들어지지 않게
export const GET = createNewClassCandidatesRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get instructorMembership() {
    return getDeps().instructorMembership;
  },
  // 「보기」 토큰 서명 원본 — 새 환경 변수 없이 로그인 비밀값에서 용도 키를 뽑는다(lib/server/candidate-reveal-token.ts)
  get revealRootSecret() {
    return process.env["BETTER_AUTH_SECRET"]?.trim() ?? "";
  },
});
