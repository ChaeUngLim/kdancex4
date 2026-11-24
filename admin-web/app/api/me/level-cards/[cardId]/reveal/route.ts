// S6-3.10(앱 등급 알림·카드 받기·카드 공개 연출) — `POST /api/me/level-cards/{cardId}/reveal`(계약 14 §5, 보드 M25 · M25C).
// 앱이 카드 공개 연출을 다 보여 준 뒤 「봤다」고 적는다. 이미 봤으면 200(처음 본 시각 그대로), 남의 카드 403, 없는 카드 404.
// 처리는 lib/server/services/me-level-card-reveal.ts.
import { getDeps } from "@/lib/server/deps";
import { createMeLevelCardRevealRoute } from "@/lib/server/services/me-level-card-reveal";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const route = createMeLevelCardRevealRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});

export const POST = route;
