// S6-3.8(앱 회원 레벨 카드 화면) — `GET /api/me/level-cards?detailGenre=&cursor=`(계약 14 §5, 보드 M26 · C24A).
// 내가 받은 등급 카드 모음. 처리는 lib/server/services/me-level-cards.ts.
import { createMeLevelCardsRoute } from "@/lib/server/services/me-level-cards";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMeLevelCardsRoute({ db, getSession: readStaffSession });
