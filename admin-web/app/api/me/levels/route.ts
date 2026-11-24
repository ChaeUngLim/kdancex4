// S6-3.4(강사 레벨 조절과 평가 레벨 숨김) — `GET /api/me/levels`(계약 14 §5, 보드 M25 · M26 · C24A).
// 세부 장르별 내 레벨 · 안 본 카드 · 열린 승급 안내. 강사 평가 레벨은 이 응답에 없다(S6-3 수용 ③).
// 처리는 lib/server/services/me-levels.ts.
import { createMeLevelsRoute } from "@/lib/server/services/me-levels";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMeLevelsRoute({ db, getSession: readStaffSession });
