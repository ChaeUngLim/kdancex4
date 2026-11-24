// S2-3.2(시간·장소 변경과 휴강 알림) — `POST /api/classes/{classId}/sessions/{sessionId}/cancel-preview`(계약 11 §6).
// 휴강·폐강 미리 보기(받는 회원 수·회원 선택 기한), 보드 I25. 처리 내용은 lib/server/services/session-changes.ts 에 있다.
import { createSessionChangeRoutes } from "@/lib/server/services/session-changes";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

export const dynamic = "force-dynamic";

export const POST = createSessionChangeRoutes({ db, getSession: readStaffSession }).cancelPreview;
