// S6-3.9(강사 승급 제안 받기·거절 API) — `POST /api/me/level-offers/{offerId}/accept`(계약 14 §5, 보드 M25B).
// 「이 레벨로 승급하기」 — 레벨이 오르고 카드 한 장이 발급된다(이미 더 높으면 제안만 닫는다).
// 남의 제안이면 403 FORBIDDEN, 이미 답했거나 닫힌 제안이면 409 OFFER_NOT_PENDING. 처리는 lib/server/services/me-level-offers.ts.
import { getDeps } from "@/lib/server/deps";
import { createMeLevelOfferRoutes } from "@/lib/server/services/me-level-offers";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

// 포트는 꺼낼 때 만든다(getter) — import 시점에 비밀값이 필요한 포트까지 만들어지지 않게
const routes = createMeLevelOfferRoutes({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
  get notificationSender() {
    return getDeps().notificationSender;
  },
});

export const POST = routes.accept;
