// S1-2.4(초대 링크 만들기·목록·폐기 API) — `POST·GET /api/academies/{academyId}/invites`(계약 08 §1).
// 대표가 강사에게 보낼 1회용 초대 링크를 만들고(토큰 원문은 만든 응답에서 한 번만), 만든 링크들의 상태를 본다.
// 처리 내용은 lib/server/services/academy-invites.ts 에 있고, 이 파일은 앱의 db·세션·시계·앱 주소를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createCreateInviteRoute, createListInvitesRoute, type AcademyInviteDeps } from "@/lib/server/services/academy-invites";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// getter 로 넘긴다 — 시계·앱 주소는 처음 쓰는 요청에서 읽는다(빌드 때 환경 변수가 없어도 된다)
const deps: AcademyInviteDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  // 초대 링크 앞부분은 이 앱의 주소(BETTER_AUTH_URL)다 — 시작할 때 env.ts 가 있는지 검사한다
  get inviteBaseUrl() {
    const base = process.env["BETTER_AUTH_URL"];
    if (!base) throw new Error("BETTER_AUTH_URL 환경 변수가 필요하다(.env.example 참고)");
    return base;
  },
};

export const POST = createCreateInviteRoute(deps);
export const GET = createListInvitesRoute(deps);
