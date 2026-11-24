// S1-4.3(학원 공지 초안·수정·올리기 API) — `PATCH /api/academies/{academyId}/staff-notices/{noticeId}`(계약 09 §3).
// 초안만 고친다. 이미 올린 공지는 409 NOTICE_ALREADY_PUBLISHED(올린 뒤 고치기 없음, 열린 점 ③).
// 처리 내용은 lib/server/services/academy-staff-notices.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createUpdateStaffNoticeRoute } from "@/lib/server/services/academy-staff-notices";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PATCH = createUpdateStaffNoticeRoute({ db, getSession: readStaffSession });
