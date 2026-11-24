// S7-2.3(답변과 응답 기한 재알림) — `POST /api/admin/inquiries/{inquiryId}/replies`(운영자 답변, 계약 15 §2-5).
// 시스템 문의에만 답한다. 학원 문의 id 로 부르면 403 — 운영자가 학원 문의를 대신 받지 않는다(FR-204 · SC-029b).
// 처리 내용은 lib/server/services/inquiry-replies.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryReplyRoutes } from "@/lib/server/services/inquiry-replies";

export const dynamic = "force-dynamic";

export const POST = createInquiryReplyRoutes(memberProfileAppDeps).adminReply;
