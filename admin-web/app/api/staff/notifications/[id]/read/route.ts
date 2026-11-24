// S1-4.6(직원 알림함 API) — `POST /api/staff/notifications/{id}/read — 읽음(남의 알림은 404)`(계약 10 §2).
// 처리 내용(직원 본인 확인·받는 사람 판정·커서)은 lib/server/services/staff-notifications.ts 에 있고,
// 이 파일은 앱의 db·로그인 인스턴스·시계를 이어 줄 뿐이다.
import { getDeps } from "@/lib/server/deps";
import { createReadStaffNotificationRoute } from "@/lib/server/services/staff-notifications";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createReadStaffNotificationRoute({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});
