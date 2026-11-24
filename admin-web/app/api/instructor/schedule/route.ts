// S2-4.5(강사 일정 대시보드 API) — `GET /api/instructor/schedule`(계약 11 §11, 보드 I1·I5·I5W·I5D).
// 강사 본인 일정(여러 학원 수업·개인 레슨·개인 일정)을 시간순 한 목록으로 준다. 처리는 lib/server/services/instructor-schedule.ts.
import { createInstructorScheduleRoutes } from "@/lib/server/services/instructor-schedule";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createInstructorScheduleRoutes({ db, getSession: readStaffSession }).get;
