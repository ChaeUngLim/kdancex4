// S2-3.12(공개 뒤 수업 수정 요청 API) — `POST /api/classes/{classId}/edit-requests`(계약 11 §5, 보드 I24).
// 공개된 수업 고치기 — 소개 문구·포스터는 바로 바뀌고, 금액·일정·정원·환불 마감일은 대표 재승인 요청(pending)이 된다.
// 처리 내용은 lib/server/services/class-edit-requests.ts 에 있다.
import { createClassEditRequestRoutes } from "@/lib/server/services/class-edit-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassEditRequestRoutes({ db, getSession: readStaffSession }).create;
