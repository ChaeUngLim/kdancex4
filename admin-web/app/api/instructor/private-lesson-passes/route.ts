// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — `GET /api/instructor/private-lesson-passes?academyId=&status=`(계약 11 §10-3, 보드 I10).
// 수강생별 수강권 · 남은 횟수. 처리는 lib/server/services/private-lesson-bookings.ts.
import { createPrivateLessonBookingRoutes } from "@/lib/server/services/private-lesson-bookings";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createPrivateLessonBookingRoutes({ db, getSession: readStaffSession }).listPasses;
