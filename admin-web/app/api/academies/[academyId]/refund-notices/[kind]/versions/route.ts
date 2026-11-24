// S1-3.3(공지 조회 API) — `GET /api/academies/{academyId}/refund-notices/{kind}/versions`(계약 09 §1).
// 그 종류의 판본 목록(최신순). 대표와 위임 강사(읽기만).
// S1-3.4(정규 과정 공지 저장 API) — 같은 경로의 `POST` 는 새 판본 저장(대표만, baseVersion 이 최신이 아니면 409).
// 처리 내용은 lib/server/services/refund-notice-read.ts(GET)·refund-notice-publish.ts(POST) 에 있고, 이 파일은 앱의 db·세션을 이어 줄 뿐이다.
import { createRefundNoticePublishRoute } from "@/lib/server/services/refund-notice-publish";
import { createRefundNoticeReadRoutes } from "@/lib/server/services/refund-notice-read";
import { readStaffSession } from "@/lib/server/staff-auth-instance";
import { db } from "@/prisma/db";

// 요청마다 다른 학원·다른 세션이다 — 빌드 때 굳히지 않는다.
export const dynamic = "force-dynamic";

export const GET = createRefundNoticeReadRoutes({ db, getSession: readStaffSession }).listVersions;
export const POST = createRefundNoticePublishRoute({ db, getSession: readStaffSession });
