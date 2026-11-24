// S2-2.7(대표 승인·반려·게시) — `POST /api/academies/{academyId}/classes/{classId}/request-revision`(계약 11 §4-5, 보드 O5).
// 대표가 사유와 함께 수정 요청(반려)하면 수업이 강사의 임시 저장으로 돌아가고, 강사는 고쳐서 다시 낼 수 있다(수용 ③).
// 처리 내용은 lib/server/services/class-approval.ts 에 있다.
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassApprovalRoutes({ db, getSession: readStaffSession }).requestRevision;
