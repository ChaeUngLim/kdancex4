// S1-2.5(초대 링크 수락 API — 승인 대기) — `POST /api/instructor/invites/{token}/accept`(계약 08 §2).
// 강사가 대표에게 받은 초대 링크를 열면 그 학원에 「승인 대기」 소속 신청이 생긴다. 바로 소속하지 않는다(결정 3).
// 처리 내용은 lib/server/services/instructor-invite-accept.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createAcceptInviteRoute, type InviteAcceptDeps } from "@/lib/server/services/instructor-invite-accept";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사·다른 토큰이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 시계는 getter 로 넘긴다 — 처음 쓰는 요청에서 읽는다
const deps: InviteAcceptDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

export const POST = createAcceptInviteRoute(deps);
