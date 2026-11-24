// S2-2.8(수업 포스터 올리기) — `PUT /api/classes/{classId}/poster`(계약 11 §4-6).
// 처리 내용은 lib/server/services/class-poster.ts 에 있고(zod 검사 classPosterBodySchema 포함),
// 이 파일은 앱의 db·로그인 세션을 이어 줄 뿐이다. 파일 바이트는 먼저 POST /api/files(purpose=poster)로 올린다.
import { createClassPosterRoute } from "@/lib/server/services/class-poster";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const PUT = createClassPosterRoute({ db, getSession: readStaffSession });
