// S2-3.5(강사 수업 공지) — `GET /api/classes/{classId}/announcement-recipients?sessionId=`(계약 11 §6-3, 보드 I13 · I13B).
// 공지를 받을 확정 수강생 수(남·여)를 돌려준다. 처리 내용은 lib/server/services/class-announcements.ts 에 있다.
import { createClassAnnouncementRoutes } from "@/lib/server/services/class-announcements";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createClassAnnouncementRoutes({ db, getSession: readStaffSession }).recipients;
