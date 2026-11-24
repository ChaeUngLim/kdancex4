// S2-1.4(강사 쪽 해제 요청) — `POST /api/instructor/affiliations/{id}/release-requests`(계약 11 §3-3).
// 강사가 소속 해제를 요청한다(I28 · I28B). 요청 기록과 대표 알림만 만들고, 실제 해제는 대표가 한다.
// 처리 내용은 lib/server/services/instructor-release-request.ts.
import { getDeps } from "@/lib/server/deps";
import { createReleaseRequestRoute, type ReleaseRequestDeps } from "@/lib/server/services/instructor-release-request";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const deps: ReleaseRequestDeps = {
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
};

export const POST = createReleaseRequestRoute(deps);
