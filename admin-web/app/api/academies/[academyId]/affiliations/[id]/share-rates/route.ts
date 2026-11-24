// S1-2.10(강사 몫 비율 변경·수업별 예외 API) — `GET /api/academies/{academyId}/affiliations/{id}/share-rates`(계약 08 §4-1).
// 대표가 소속 강사의 기본 비율(지금·이력)과 켜진 수업별 예외를 본다. 위임 강사는 못 본다(정산은 위임 대상 밖).
// 처리 내용은 lib/server/services/academy-share-rates.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createGetShareRatesRoute } from "@/lib/server/services/academy-share-rates";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createGetShareRatesRoute({ db, getSession: readStaffSession });
