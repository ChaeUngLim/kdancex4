// S2-3.12(공개 뒤 수업 수정 요청 API) — `POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/reject`(계약 11 §5, 보드 O5).
// 대표가 사유와 함께 반려하면 옛 값이 그대로 남고 요청한 강사에게 사유가 간다.
// 처리 내용은 lib/server/services/class-edit-requests.ts 에 있다.
import { createClassEditRequestRoutes } from "@/lib/server/services/class-edit-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassEditRequestRoutes({ db, getSession: readStaffSession }).reject;
