// S1-1.20(학원 앱 페이지 API) — `PUT /api/academies/{academyId}/app-page`(계약 07 §4 · 열린 점 ⑮).
// 대표가 학원 앱 페이지 화면(W22)에서 한 줄 소개·소개 글·사진(최대 10장, 배열 순서 = 보이는 순서)을 통째로 저장한다.
// 처리 내용은 lib/server/services/academy-app-page.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createAcademyAppPageRoute } from "@/lib/server/services/academy-app-page";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const PUT = createAcademyAppPageRoute({ db, getSession: readStaffSession });
