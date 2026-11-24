// S3-4.3c(결석 이의 신청·처리 API) — `POST /api/attendance-marks/{markId}/dispute/resolve`(계약 04 §8-2, 보드 I26).
// 그 결석을 표시한 직원 본인 · 그 학원 대표가 이의를 받아들이거나(결석 취소) 유지한다. 감사 1행 + 회원 알림 1건을 같이 쓴다.
// 처리 내용은 lib/server/services/absence-disputes.ts.
import { createAbsenceDisputeRoutes } from "@/lib/server/services/absence-disputes";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createAbsenceDisputeRoutes({ db, getSession: readStaffSession }).resolveDispute;
