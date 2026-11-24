// S2-2.3(수업 등록 API) — `POST /api/classes/{classId}/submit`(승인 요청, 계약 11 §4-4, 보드 I2D · I2E).
// 임시 저장을 승인 대기로 넘기고 판매 단위·회차·자리 묶음을 한 트랜잭션에서 만든다. 0원 수업도 같은 길이다(수용 ⑤).
// 처리 내용은 lib/server/services/class-registration.ts 에 있다.
import { createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassRegistrationRoutes({ db, getSession: readStaffSession }).submit;
