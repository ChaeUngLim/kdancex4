// S7-2.3(답변과 응답 기한 재알림) — `POST /api/academies/{academyId}/inquiries/{inquiryId}/replies`(대표 답변, 계약 15 §2-4).
// 그 학원의 active 대표만 답한다. 다른 학원 문의·시스템 문의는 403, 닫힌 문의는 409 INQUIRY_CLOSED.
// 답하면 문의자에게 inquiry_answered 알림이 간다. 처리 내용은 lib/server/services/inquiry-replies.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryReplyRoutes } from "@/lib/server/services/inquiry-replies";

export const dynamic = "force-dynamic";

export const POST = createInquiryReplyRoutes(memberProfileAppDeps).ownerReply;
