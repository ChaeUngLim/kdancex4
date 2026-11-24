// S1-1.17(등록 형태 변경 재심사) — `POST /api/academies/{academyId}/registration-change`(계약 07 §4).
// 대표가 등록 형태 변경을 신청한다. 정식 값은 운영자 재심사(S7-4) 뒤에 바뀌고, 그동안은 이전 형태 + 엄격 기준이다.
// 처리 내용은 lib/server/services/academy-registration-change.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createRegistrationChangeRoute } from "@/lib/server/services/academy-registration-change";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const POST = createRegistrationChangeRoute({ db, getSession: readStaffSession });
