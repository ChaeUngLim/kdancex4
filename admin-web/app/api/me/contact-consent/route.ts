// S6-3.5(개강 후보) — `GET · PUT /api/me/contact-consent`(계약 14 §5, FR-165).
// 회원이 「새 반 안내에 연락처 제공」 동의를 보고 바꾼다. 처리 내용은 lib/server/services/me-contact-consent.ts.
import { createMeContactConsentRoutes } from "@/lib/server/services/me-contact-consent";
import { getDeps } from "@/lib/server/deps";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const routes = createMeContactConsentRoutes({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});

export const GET = routes.get;
export const PUT = routes.put;
