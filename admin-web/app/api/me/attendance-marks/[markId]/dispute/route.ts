// S3-4.3c(결석 이의 신청·처리 API) — `POST /api/me/attendance-marks/{markId}/dispute`(계약 04 §8-1, 보드 M11).
// 회원이 강사·대표가 표시한 내 결석에 이의를 건다. 상태 바꾸기 + 감사 1행 + 표시한 직원 알림 1건을 한 트랜잭션에 쓴다.
// 처리 내용은 lib/server/services/absence-disputes.ts. 회원·직원이 Better Auth 하나를 같이 쓰므로 세션 읽기는 같은 함수다(README §2).
import { createAbsenceDisputeRoutes } from "@/lib/server/services/absence-disputes";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 사람마다 다른 응답이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createAbsenceDisputeRoutes({ db, getSession: readStaffSession }).requestDispute;
