// S2-1.9(학원 검색·학원 색 API) — `GET /api/instructor/academies?q=&limit=`(계약 11 §3-1).
// 강사가 이름·지역으로 학원을 찾는다(I27 소속 신청 · I10B · I2). 결과마다 나와의 소속 상태가 붙는다.
// 처리 내용은 lib/server/services/instructor-academies.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createSearchAcademiesRoute } from "@/lib/server/services/instructor-academies";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 강사다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createSearchAcademiesRoute({ db, getSession: readStaffSession });
