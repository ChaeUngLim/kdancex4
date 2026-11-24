// S3-4.2(캘린더 조회 API) — `GET /api/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`(계약 04 §1 · §4-1, 보드 M11).
// 내 확정 예약의 회차를 KST 날짜 범위로 돌려준다. 처리 내용은 lib/server/services/me-calendar.ts 에 있다.
// 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(README §2).
import { createMeCalendarRoute } from "@/lib/server/services/me-calendar";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createMeCalendarRoute({ db, getSession: readStaffSession });
