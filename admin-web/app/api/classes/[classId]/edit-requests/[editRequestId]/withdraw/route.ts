// S2-3.12(공개 뒤 수업 수정 요청 API) — `POST /api/classes/{classId}/edit-requests/{editRequestId}/withdraw`(계약 11 §5, 보드 I24).
// 요청한 사람이 승인을 기다리는 수정 요청을 취소한다. 이미 승인·반려된 요청은 409.
// 처리 내용은 lib/server/services/class-edit-requests.ts 에 있다.
import { createClassEditRequestRoutes } from "@/lib/server/services/class-edit-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassEditRequestRoutes({ db, getSession: readStaffSession }).withdraw;
