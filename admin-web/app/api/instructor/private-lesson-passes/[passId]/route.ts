// S2-4.7(개인 레슨 규칙·수강생·회차 API) — `GET /api/instructor/private-lesson-passes/{passId}`(계약 11 §10-3, 보드 I20).
// 처리는 lib/server/services/private-lesson-bookings.ts.
import { createPrivateLessonBookingRoutes } from "@/lib/server/services/private-lesson-bookings";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createPrivateLessonBookingRoutes({ db, getSession: readStaffSession });

export const GET = routes().getPass;
