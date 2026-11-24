// S1-4.4(소속 강사 공지 조회·읽음 API) — `GET /api/instructor/staff-notices`(계약 09 §3 강사 쪽, 보드 I39).
// 강사가 받은 학원 공지 중 「지금 active 소속인 학원」의 것만 최신순으로 본다. 해제된 학원 공지는 옛 것도 안 보인다.
// 처리 내용은 lib/server/services/staff-notice-reads.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createListInstructorStaffNoticesRoute } from "@/lib/server/services/staff-notice-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createListInstructorStaffNoticesRoute({ db, getSession: readStaffSession });
