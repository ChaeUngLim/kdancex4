// S3-4.3(결석 예정 토글 API) — `PUT · DELETE /api/me/sessions/{sessionId}/absence`(계약 04 §5, 보드 M11).
// 회원이 확정된 회차를 결석 예정으로 알리거나(PUT) 참석으로 되돌린다(DELETE). 처리 내용은 lib/server/services/me-session-absence.ts.
// 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(README §2).
import { createMeSessionAbsenceRoutes } from "@/lib/server/services/me-session-absence";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const routes = createMeSessionAbsenceRoutes({ db, getSession: readStaffSession });

export const PUT = routes.put;
export const DELETE = routes.remove;
