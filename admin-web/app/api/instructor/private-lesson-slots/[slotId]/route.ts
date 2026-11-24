// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — `DELETE /api/instructor/private-lesson-slots/{slotId}`(계약 11 §10-2, 보드 I10C).
// 열어 둔 시간 닫기(open 만). 처리는 lib/server/services/private-lesson-slots.ts.
import { createPrivateLessonSlotRoutes } from "@/lib/server/services/private-lesson-slots";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const DELETE = createPrivateLessonSlotRoutes({ db, getSession: readStaffSession }).remove;
