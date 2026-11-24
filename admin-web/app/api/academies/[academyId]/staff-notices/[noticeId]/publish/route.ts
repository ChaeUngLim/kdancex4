// S1-4.3(학원 공지 초안·수정·올리기 API) — `POST /api/academies/{academyId}/staff-notices/{noticeId}/publish`(계약 09 §3).
// 공지를 올린다. 그 순간 active 소속 강사를 받는 사람으로 고정하고 강사마다 알림 1건. 두 번 눌러도 같은 본문 200.
// 처리 내용은 lib/server/services/academy-staff-notices.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createPublishStaffNoticeRoute } from "@/lib/server/services/academy-staff-notices";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createPublishStaffNoticeRoute({ db, getSession: readStaffSession });
