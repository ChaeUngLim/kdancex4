// S2-3.2(시간·장소 변경과 휴강 알림) — `POST /api/classes/{classId}/sessions/{sessionId}/cancel`(계약 11 §6).
// 이 회차만 휴강 또는 이후 회차 모두 폐강하고 변경 기록·알림 행을 한 트랜잭션에 쓴다, 보드 I25. 처리 내용은 lib/server/services/session-changes.ts 에 있다.
import { createSessionChangeRoutes } from "@/lib/server/services/session-changes";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createSessionChangeRoutes({ db, getSession: readStaffSession }).cancel;
