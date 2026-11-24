// S1-3.3(공지 조회 API) — `GET /api/academies/{academyId}/refund-notices/{kind}/versions/{version}`(계약 09 §1).
// 한 판본 — 주문이 가리키는 옛 판본도 연다(O-16(판본 보존) · FR-284(주문 시점 값 고정)). 대표와 위임 강사(읽기만).
// 처리 내용은 lib/server/services/refund-notice-read.ts 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createRefundNoticeReadRoutes } from "@/lib/server/services/refund-notice-read";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createRefundNoticeReadRoutes({ db, getSession: readStaffSession }).getVersion;
