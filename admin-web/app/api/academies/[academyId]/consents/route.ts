// S1-1.24(동의 기록·약관 전문·통지 읽음 API) — `GET /api/academies/{academyId}/consents`(계약 07 §5, FR-249).
// 대표가 우리 학원이 동의한 항목과 알림받은 약관 변경을 본다(O35 · W2b).
// 처리 내용은 lib/server/services/terms-consent-records.ts 에 있고, 이 파일은 앱의 db·세션·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createAcademyConsentsRoute } from "@/lib/server/services/terms-consent-records";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 시각이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createAcademyConsentsRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — deps 는 처음 쓰는 요청에서 만든다(deps.ts 의 지연 생성)
  get clock() {
    return getDeps().clock;
  },
});
