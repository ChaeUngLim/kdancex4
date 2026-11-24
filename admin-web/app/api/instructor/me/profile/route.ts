// S2-1.6(프로필·가능 시간·프로필 사진 API) — `GET`·`PUT /api/instructor/me/profile`(계약 11 §2-1, 보드 I9 · I40).
// 처리 내용은 lib/server/services/instructor-profile.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createInstructorProfileRoutes, type InstructorProfileDeps } from "@/lib/server/services/instructor-profile";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 시계는 getter 로 넘긴다 — 처음 쓰는 요청에서 읽는다
const deps: InstructorProfileDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

const routes = createInstructorProfileRoutes(deps);
export const GET = routes.get;
export const PUT = routes.put;
