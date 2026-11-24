// S2-3.12(공개 뒤 수업 수정 요청 API) — `POST /api/academies/{academyId}/class-edit-requests/{editRequestId}/approve`(계약 11 §5, 보드 O5).
// 대표가 수정 요청을 승인하면 그때 새 값이 판매 단위·자리 묶음·회차에 쓰인다(정원 하한은 이때 한 번 더 본다).
// 처리 내용은 lib/server/services/class-edit-requests.ts 에 있다.
import { createClassEditRequestRoutes } from "@/lib/server/services/class-edit-requests";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassEditRequestRoutes({ db, getSession: readStaffSession }).approve;
