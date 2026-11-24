// S2-3.4(대타 요청 흐름) — `POST /api/instructor/substitute-requests`(대타 요청, I14) · `GET …?role=requested|received`(I14B · I14C), 계약 11 §8-2.
// 처리는 lib/server/services/substitute-requests.ts.
import { createSubstituteRequestRoutes } from "@/lib/server/services/substitute-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createSubstituteRequestRoutes({ db, getSession: readStaffSession });

export const POST = routes().create;
export const GET = routes().listMine;
