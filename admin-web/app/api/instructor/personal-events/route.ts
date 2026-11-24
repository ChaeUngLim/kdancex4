// S2-1.6(프로필·가능 시간·프로필 사진 API) — `POST /api/instructor/personal-events`(계약 11 §2-3, 보드 I36).
// 처리 내용은 lib/server/services/instructor-personal-events.ts 에 있다.
import { createInstructorPersonalEventRoutes } from "@/lib/server/services/instructor-personal-events";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createInstructorPersonalEventRoutes({ db, getSession: readStaffSession }).create;
