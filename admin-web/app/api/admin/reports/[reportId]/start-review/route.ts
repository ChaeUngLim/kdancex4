// S7-2.5(신고 접수·처리) — `POST /api/admin/reports/{reportId}/start-review`(접수 → 확인 중, 계약 15 §2-7).
// 본문이 없는 경로다. 신고자에게 「확인하고 있어요」 알림(report_in_review)을 쓴다. 처리 내용은 lib/server/services/reports.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createReportRoutes } from "@/lib/server/services/reports";

export const dynamic = "force-dynamic";

export const POST = createReportRoutes(memberProfileAppDeps).startReview;
