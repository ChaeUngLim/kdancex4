// S3-4.5(알림함 조회와 결제 확인 알림) — `GET /api/me/notifications?limit=20&cursor=`(계약 04 §2).
// 내 알림을 최신순으로 한 쪽씩 돌려준다. 처리 내용은 lib/server/services/me-notifications.ts 에 있다.
// 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(README §2).
import { createMeNotificationsRoute } from "@/lib/server/services/me-notifications";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMeNotificationsRoute({ db, getSession: readStaffSession });
