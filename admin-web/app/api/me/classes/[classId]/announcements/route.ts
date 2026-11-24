// S2-3.5(강사 수업 공지) — `GET /api/me/classes/{classId}/announcements`(계약 11 §6-3, 보드 M8C).
// 회원이 보는 수업 상세의 「강사 공지」. 그 수업의 확정 예약이 있는 회원만 읽는다(아니면 403).
// 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(README §2). 처리 내용은 lib/server/services/class-announcements.ts.
import { createClassAnnouncementRoutes } from "@/lib/server/services/class-announcements";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createClassAnnouncementRoutes({ db, getSession: readStaffSession }).listForMember;
