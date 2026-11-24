// S7-2.5(신고 접수·처리) — `POST /api/admin/reports/{reportId}/resolve`(처리 결과 기록·신고자 알림, 계약 15 §2-7).
// 본문은 resolveReportSchema(zod)로 검사한다. 신고받은 상대에게는 알림을 쓰지 않는다. 처리 내용은 lib/server/services/reports.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createReportRoutes } from "@/lib/server/services/reports";

export const dynamic = "force-dynamic";

export const POST = createReportRoutes(memberProfileAppDeps).resolve;
