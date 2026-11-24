// S1-4.4(소속 강사 공지 조회·읽음 API) — `POST /api/instructor/staff-notices/{noticeId}/read`(계약 09 §3 강사 쪽).
// 강사가 학원 공지를 읽음으로 표시한다. 받는 사람이 아니거나 그 학원에서 해제됐으면 404. 두 번 눌러도 처음 시각 그대로.
// 처리 내용은 lib/server/services/staff-notice-reads.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createReadInstructorStaffNoticeRoute } from "@/lib/server/services/staff-notice-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createReadInstructorStaffNoticeRoute({ db, getSession: readStaffSession });
