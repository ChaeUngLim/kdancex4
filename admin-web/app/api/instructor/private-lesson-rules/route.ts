// S2-4.7(개인 레슨 규칙·수강생·회차 API) — `GET`·`POST /api/instructor/private-lesson-rules`(계약 11 §10-1, 보드 I20C).
// 처리는 lib/server/services/private-lesson-rules.ts(본문 zod 검증 · 소속 판정 · 새 판본 쌓기).
import { createPrivateLessonRuleRoutes } from "@/lib/server/services/private-lesson-rules";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

const routes = () => createPrivateLessonRuleRoutes({ db, getSession: readStaffSession });

export const GET = routes().get;
export const POST = routes().save;
