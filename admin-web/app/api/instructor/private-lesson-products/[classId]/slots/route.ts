// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — `POST /api/instructor/private-lesson-products/{classId}/slots`(계약 11 §10-2, 보드 I10C).
// 「레슨 모집」 시간 열기(매주 반복). 본문 zod 검증·겹침 판정은 lib/server/services/private-lesson-slots.ts.
import { createPrivateLessonSlotRoutes } from "@/lib/server/services/private-lesson-slots";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createPrivateLessonSlotRoutes({ db, getSession: readStaffSession }).open;
