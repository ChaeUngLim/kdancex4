// S2-2.8a(강사 소속 학원 홀 목록 API) — `GET /api/instructor/affiliations/{affiliationId}/rooms`(계약 11 §3-4).
// 강사가 수업 등록(I2)에서 고를 그 소속 학원의 홀(강의실) 목록을 돌려준다.
// 처리 내용은 lib/server/services/instructor-affiliation-rooms.ts.
import { createListAffiliationRoomsRoute } from "@/lib/server/services/instructor-affiliation-rooms";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createListAffiliationRoomsRoute({ db, getSession: readStaffSession });
