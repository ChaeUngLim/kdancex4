// S2-2.7(대표 승인·반려·게시) — `POST /api/academies/{academyId}/classes/{classId}/approve`(계약 11 §4-5, 보드 O5).
// 대표가 승인 대기 수업을 공개한다. 수업 공개와 판매 단위 열기가 한 트랜잭션이라 회원 공개 목록에 바로 나온다.
// 처리 내용은 lib/server/services/class-approval.ts 에 있다.
import { createClassApprovalRoutes } from "@/lib/server/services/class-approval";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassApprovalRoutes({ db, getSession: readStaffSession }).approve;
