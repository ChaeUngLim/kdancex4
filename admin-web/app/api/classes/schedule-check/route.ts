// S2-2.8c(수업 일정 겹침 미리보기 API) — `POST /api/classes/schedule-check`(계약 11 §4-1, 보드 I2C · I2).
// 요일·시각을 고르는 동안 회차 수 · 이미 있는 일정 · 겹침 · 가까운 빈 시간을 미리 계산한다. **아무것도 쓰지 않는다.**
// 처리 내용은 lib/server/services/class-schedule-check.ts 에 있다(본문 zod 검증 · class_writer 판정).
import { createClassScheduleCheckRoute } from "@/lib/server/services/class-schedule-check";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createClassScheduleCheckRoute({ db, getSession: readStaffSession });
