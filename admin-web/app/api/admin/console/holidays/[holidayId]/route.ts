// S7-4.8a(공휴일 운영자 입력 API(P9)) — `PATCH`·`DELETE /api/admin/console/holidays/{holidayId}`(계약 13 §10-1).
// 운영자 줄만 고치거나 지운다. 자동 수집 줄은 409 HOLIDAY_NOT_EDITABLE(Q35).
// 처리 내용과 zod 본문 검사(updateHolidayRequestSchema)는 lib/server/services/admin-holidays.ts 에 있다.
import { getDeps } from "@/lib/server/deps";
import { createAdminHolidaysRoutes } from "@/lib/server/services/admin-holidays";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = createAdminHolidaysRoutes({
  db,
  getSession: readStaffSession,
  get clock() {
    return getDeps().clock;
  },
});

export const PATCH = routes.update;
export const DELETE = routes.remove;
