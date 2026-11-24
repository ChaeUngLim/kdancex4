// S7-2.2(문의 생성과 조회 권한) — `GET /api/admin/inquiries`(운영자 시스템 문의함, 계약 15 §2-5).
// 시스템 문의(kind='system')만 나온다 — 학원 문의는 조회 조건에서 빠진다(FR-204). 2단계 인증을 마친 관리자 웹 세션만.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";

export const dynamic = "force-dynamic";

export const GET = createInquiryRoutes(memberProfileAppDeps).adminInbox;
