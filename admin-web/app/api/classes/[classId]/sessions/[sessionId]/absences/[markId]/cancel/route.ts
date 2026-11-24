// S3-5.9b(앱 강사 결석 표시 화면 I26) — `POST /api/classes/{classId}/sessions/{sessionId}/absences/{markId}/cancel`(계약 04 §6-2).
// 결석 표시를 취소한다(출석으로 돌아간다). 48시간 안에는 표시할 수 있는 사람이, 잠긴 뒤에는 대표만 사유를 적고 취소한다.
// 이의가 걸린 행을 취소하면 이의를 받아들인 것과 같다. 처리 내용은 lib/server/services/staff-absence-marks.ts 의 cancel.
import { createStaffAbsenceMarkRoutes } from "@/lib/server/services/staff-absence-marks";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createStaffAbsenceMarkRoutes({ db, getSession: readStaffSession }).cancel;
