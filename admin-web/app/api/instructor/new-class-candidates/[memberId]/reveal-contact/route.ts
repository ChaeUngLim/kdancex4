// S6-3.5(개강 후보) — `POST /api/instructor/new-class-candidates/{memberId}/reveal-contact`(계약 14 §6-2, 보드 I15B 「보기」).
// 명단에서 받은 revealToken 이 맞고 회원이 지금도 동의 중이면 전체 번호를 주고, 볼 때마다 감사 candidate.contact_viewed 를 남긴다.
// 처리는 lib/server/services/new-class-candidates.ts.
import { getDeps } from "@/lib/server/deps";
import { createRevealCandidateContactRoute } from "@/lib/server/services/new-class-candidates";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사·다른 조건이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 포트는 꺼낼 때 만든다(getter) — import 시점에 비밀값이 필요한 포트까지 만들어지지 않게
export const POST = createRevealCandidateContactRoute({
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
