// S2-2.3(수업 등록 API) — `POST /api/classes`(임시 저장 만들기, 계약 11 §4-2, 보드 I2 · I44).
// 처리 내용은 lib/server/services/class-registration.ts 에 있다(본문 zod 검증 · class_writer 판정 · 멱등키).
import { createClassRegistrationRoutes } from "@/lib/server/services/class-registration";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassRegistrationRoutes({ db, getSession: readStaffSession }).create;
