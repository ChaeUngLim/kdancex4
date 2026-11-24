// S2-1.9(학원 검색·학원 색 API) — `PUT /api/instructor/affiliations/{affiliationId}/color`(계약 11 §3-2).
// 내 소속 학원의 색 번호(0~11, 12색)를 바꾼다(I9E · I12). 색은 강사 본인 화면에만 쓰인다.
// 처리 내용은 lib/server/services/instructor-academies.ts.
import { createSetAffiliationColorRoute } from "@/lib/server/services/instructor-academies";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const PUT = createSetAffiliationColorRoute({ db, getSession: readStaffSession });
