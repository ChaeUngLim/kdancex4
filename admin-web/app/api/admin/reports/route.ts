// S7-2.5(신고 접수·처리) — `GET /api/admin/reports`(운영자 신고함, 계약 15 §2-7). 2단계 인증을 마친 관리자 웹 세션만.
// 신고자는 역할 + 닉네임만 보인다. 처리 내용은 lib/server/services/reports.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createReportRoutes } from "@/lib/server/services/reports";

export const dynamic = "force-dynamic";

export const GET = createReportRoutes(memberProfileAppDeps).adminList;
