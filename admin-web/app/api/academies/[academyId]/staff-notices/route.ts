// S1-4.3(학원 공지 초안·수정·올리기 API) — `POST /api/academies/{academyId}/staff-notices`(계약 09 §3).
// 대표가 소속 강사에게 보낼 학원 공지 초안을 만든다. 본문에 "publish": true 를 넣으면 바로 올린다(O28).
// S1-4.4(소속 강사 공지 조회·읽음 API) — `GET` 같은 경로: 대표가 보는 지난 공지(W5) + 받은·읽은 사람 수.
// 처리 내용은 lib/server/services/academy-staff-notices.ts(쓰기)·staff-notice-reads.ts(읽기)에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createCreateStaffNoticeRoute } from "@/lib/server/services/academy-staff-notices";
import { createListAcademyStaffNoticesRoute } from "@/lib/server/services/staff-notice-reads";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createCreateStaffNoticeRoute({ db, getSession: readStaffSession });
export const GET = createListAcademyStaffNoticesRoute({ db, getSession: readStaffSession });
