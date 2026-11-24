// S1-1.23(입점 약관 판본 발행 API) — `POST /api/admin/terms-versions`(계약 07 §5, FR-259).
// 운영자가 새 약관 판본을 내면 시행일 30일 규칙을 검사하고, active 학원마다 대표에게 개별 통지를 쓴다.
// 처리 내용은 lib/server/services/terms-version-publish.ts 에 있고(zod 검사 publishTermsVersionRequestSchema 포함),
// 이 파일은 앱의 db·로그인 세션·시계(getDeps)를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createPublishTermsVersionRoute } from "@/lib/server/services/terms-version-publish";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 운영자·다른 판본이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createPublishTermsVersionRoute({
  db,
  getSession: readStaffSession,
  // getter 로 넘긴다 — deps 는 처음 쓰는 요청에서 만든다(deps.ts 의 지연 생성)
  get clock() {
    return getDeps().clock;
  },
});
