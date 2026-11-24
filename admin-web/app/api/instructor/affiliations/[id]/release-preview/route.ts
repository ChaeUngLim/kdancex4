// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — `POST /api/instructor/affiliations/{id}/release-preview`(계약 11 §3 · §9-1).
// 강사가 해제 요청 시트(I28 · I28B)에서 자기 소속의 남은 회차와 받는 회원 수를 미리 본다. 대표 쪽 미리 보기와 같은 계산을 쓴다.
import { getDeps } from "@/lib/server/deps";
import { createInstructorReleasePreviewRoute } from "@/lib/server/services/affiliation-release-preview";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createInstructorReleasePreviewRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
