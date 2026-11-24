// S2-2.13(수업 목록 읽기 API) — `GET /api/instructor/classes?status=&academyId=&cursor=`(계약 11 §4, 보드 I19 · I19B).
// 강사가 자기가 올린 수업을 임시 저장·승인 중·공개 칩으로 거르고 커서로 넘겨 본다. 남이 올린 수업은 나오지 않는다.
// 처리 내용은 lib/server/services/class-list-reads.ts 에 있다.
import { createInstructorClassListRoute } from "@/lib/server/services/class-list-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const GET = createInstructorClassListRoute({ db, getSession: readStaffSession });
