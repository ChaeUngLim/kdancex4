// S2-3.4(대타 요청 흐름) — `POST /api/academies/{academyId}/substitute-requests/{requestId}/confirm`(계약 11 §8-2, 보드 O21B).
// 대표 확인 → 회차의 담당 강사를 대타 강사로 바꾸고 수강생에게 알린다(한 트랜잭션). 처리는 lib/server/services/substitute-requests.ts.
import { createSubstituteRequestRoutes } from "@/lib/server/services/substitute-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createSubstituteRequestRoutes({ db, getSession: readStaffSession });

export const POST = routes().confirm;
