// S7-2.2(문의 생성과 조회 권한) — `GET /api/academies/{academyId}/inquiries`(대표 문의함 O22, 계약 15 §2-4).
// 그 학원의 active 대표만 본다. 다른 학원 id 로 부르면 403(FR-207 · SC-029b). 처리 내용은 lib/server/services/inquiries.ts.
import { memberProfileAppDeps } from "@/lib/server/member-profile-app";
import { createInquiryRoutes } from "@/lib/server/services/inquiries";

export const dynamic = "force-dynamic";

export const GET = createInquiryRoutes(memberProfileAppDeps).ownerInbox;
