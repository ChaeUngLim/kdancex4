// S2-4.10(개인 레슨 상품·모집 시간·수강권 목록 API) — `POST /api/instructor/private-lesson-products/{classId}/close`(계약 11 §10-1, 보드 I10B).
// 상품을 닫아 새 구매·새 시간을 막는다. 처리는 lib/server/services/private-lesson-products.ts.
import { createPrivateLessonProductRoutes } from "@/lib/server/services/private-lesson-products";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createPrivateLessonProductRoutes({ db, getSession: readStaffSession }).close;
