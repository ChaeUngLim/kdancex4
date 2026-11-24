// S2-3.6(소속 해제의 남은 회차 처리와 받는 회원 수) — `POST /api/academies/{academyId}/affiliations/{id}/release-preview`(계약 11 §9-1).
// 대표가 해제 확인 창(W3b · W3b2 · O39 · O39B)에서 회차마다 대체·휴강·폐강을 고르면 받는 회원 수(중복 제거)와 묶음 문구를 미리 계산한다.
// 처리 내용은 lib/server/services/affiliation-release-preview.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createOwnerReleasePreviewRoute } from "@/lib/server/services/affiliation-release-preview";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createOwnerReleasePreviewRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
