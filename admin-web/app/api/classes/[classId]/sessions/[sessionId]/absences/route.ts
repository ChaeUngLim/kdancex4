// S3-4.3a(강사·대표 결석 표시 API) — `POST /api/classes/{classId}/sessions/{sessionId}/absences`(계약 04 §6-1, 보드 I26 · W6).
// 대표 · 위임 강사(roster_manage) · 담당 강사가 수업 시작 뒤 ~ 끝난 뒤 48시간 안에 결석을 표시한다.
// 결석 행 + 감사 1행 + 회원 알림 1건을 한 트랜잭션에 쓴다. 처리 내용은 lib/server/services/staff-absence-marks.ts.
// S3-5.9b(앱 강사 결석 표시 화면) — 같은 주소의 `GET` 은 오늘 결석 목록(계약 18 §8, 보드 I26). 권한은 표시와 같다.
import { createStaffAbsenceMarkRoutes } from "@/lib/server/services/staff-absence-marks";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

const routes = createStaffAbsenceMarkRoutes({ db, getSession: readStaffSession });

export const GET = routes.list;
export const POST = routes.mark;
