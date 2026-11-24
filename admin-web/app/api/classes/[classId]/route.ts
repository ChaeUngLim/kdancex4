// S2-2.3(수업 등록 API) — `GET /api/classes/{classId}`(수업 등록 상세) · `PUT /api/classes/{classId}`(임시 저장 고치기, 전체 교체).
// 계약 11 §4-2. 처리 내용은 lib/server/services/class-registration.ts 에 있다.
import { createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = createClassRegistrationRoutes({ db, getSession: readStaffSession });

export const GET = routes.read;
export const PUT = routes.update;
