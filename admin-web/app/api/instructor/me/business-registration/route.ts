// S2-1.2b(사업자등록번호·등록증 선택 입력 API) — `PUT /api/instructor/me/business-registration`(계약 11 §2-2, 보드 I9).
// 처리 내용은 lib/server/services/instructor-business-registration.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import {
  createPutBusinessRegistrationRoute,
  type InstructorBusinessRegistrationDeps,
} from "@/lib/server/services/instructor-business-registration";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 시계는 getter 로 넘긴다 — 처음 쓰는 요청에서 읽는다
const deps: InstructorBusinessRegistrationDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

export const PUT = createPutBusinessRegistrationRoute(deps);
