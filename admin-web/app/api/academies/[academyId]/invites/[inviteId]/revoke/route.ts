// S1-2.4(초대 링크 만들기·목록·폐기 API) — `POST /api/academies/{academyId}/invites/{inviteId}/revoke`(계약 08 §1).
// 대표가 아직 쓰지 않은 초대 링크를 폐기한다. 이미 폐기·사용·만료된 링크면 409 INVITE_NOT_ACTIVE.
// 처리 내용은 lib/server/services/academy-invites.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createRevokeInviteRoute } from "@/lib/server/services/academy-invites";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createRevokeInviteRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  // 폐기는 링크 주소를 만들지 않는다 — 형만 맞춘다
  inviteBaseUrl: "",
});
