// S2-3.4(대타 요청 흐름) — `GET /api/academies/{academyId}/substitute-requests?status=accepted`(대표 확인을 기다리는 대타, 계약 11 §8, 보드 O21B).
// 처리는 lib/server/services/substitute-requests.ts.
import { createSubstituteRequestRoutes } from "@/lib/server/services/substitute-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createSubstituteRequestRoutes({ db, getSession: readStaffSession });

export const GET = routes().listAcademy;
