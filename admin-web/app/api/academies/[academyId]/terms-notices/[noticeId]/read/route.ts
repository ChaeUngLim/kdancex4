// S1-1.24(동의 기록·약관 전문·통지 읽음 API) — `POST /api/academies/{academyId}/terms-notices/{noticeId}/read`(계약 07 §5, FR-259).
// 대표가 약관 변경 안내를 읽었다고 표시한다. 두 번 불러도 처음 읽은 시각 그대로 같은 본문을 돌려준다.
// 처리 내용(경로 id zod 검사 recordIdParamSchema 포함)은 lib/server/services/terms-consent-records.ts 에 있다.
import { getDeps } from "@/lib/server/deps";
import { createReadTermsNoticeRoute } from "@/lib/server/services/terms-consent-records";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createReadTermsNoticeRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
