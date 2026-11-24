// S2-2.13(수업 목록 읽기 API) — `GET /api/academies/{academyId}/class-approvals?status=pending&cursor=`(계약 11 §4-5, 보드 O5 · O21).
// 그 학원 대표가 승인 대기 중인 수업을 오래 기다린 순서로 읽는다. 위임 강사·다른 학원 대표는 403.
// 처리 내용은 lib/server/services/class-list-reads.ts 에 있다.
import { createClassApprovalListRoute } from "@/lib/server/services/class-list-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createClassApprovalListRoute({ db, getSession: readStaffSession });
