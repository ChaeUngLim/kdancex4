// S1-2.8(소속 목록 조회 API) — `GET /api/academies/{academyId}/affiliations?status=pending|active`(계약 08 §3).
// 대표가 학원의 소속 신청(대기)과 소속 강사(소속 중)를 본다. 연락처는 가린 값만 내린다(FR-187).
// 처리 내용은 lib/server/services/academy-affiliation-list.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createListAcademyAffiliationsRoute } from "@/lib/server/services/academy-affiliation-list";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createListAcademyAffiliationsRoute({ db, getSession: readStaffSession });
