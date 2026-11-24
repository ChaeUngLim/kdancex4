// S2-3.4(대타 요청 흐름) — `GET /api/sessions/{sessionId}/substitute-candidates`(계약 11 §8-1, 보드 I14).
// 그 회차의 대타 후보 목록. 그 시간에 일정이 있는 강사는 available=false · busy(무슨 일정인지는 주지 않는다). 처리는 lib/server/services/substitute-requests.ts.
import { createSubstituteRequestRoutes } from "@/lib/server/services/substitute-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createSubstituteRequestRoutes({ db, getSession: readStaffSession });

export const GET = routes().candidates;
